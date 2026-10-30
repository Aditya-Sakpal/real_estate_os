import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { audit, withTenant } from "./db/index.ts";
import type { Authz } from "./rbac-rules.ts";
import { assetUrl, putAsset, readAsset, removeAsset } from "./storage.ts";
import { projectOfNode } from "./storage-place.ts";
import { entitle, meterQuietly } from "./billing.ts";
import { askJson, type AskDriver } from "./generate.ts";
import { approvedUnits } from "./unit.ts";
import { redactPhones } from "./mask-rules.ts";
import { STT_PAISE_PER_SECOND, transcribe } from "./stt.ts";
import {
  LENGTH_MESSAGE,
  MAX_EXTRACT_TRIES,
  MAX_NOTES_PER_VISIT,
  NOTE_MINUTES,
  cutPlan,
  draftOutcome,
  lengthProblem,
  notePrompt,
  noteProblem,
  noteSchema,
  noteType,
  noteWhen,
  parseSilences,
  readNote,
  type NoteDraft,
  type NoteUnit,
} from "./visit-note-rules.ts";

/**
 * The host's voice note after a visit: stored as recorded, transcribed,
 * read into a draft the host confirms. The reads, writes and paid calls
 * around `visit-note-rules.ts`.
 *
 * Transcribing needs FFmpeg, which a Vercel function does not have, so a
 * note is picked up by the lead worker (`processDueNotes()`); on a machine
 * with FFmpeg the upload also starts it at once.
 */

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const exec = promisify(execFile);

export const NOTE_MODEL = process.env.NOTE_MODEL || "gpt-5-mini";
/** One read of a 90-second transcript, at September 2026 prices, rounded up. */
export const NOTE_READ_PAISE = 34;
const READ_TIMEOUT_MS = 45_000;
const LEASE_MINUTES = 10;

let injectedReader: AskDriver | null = null;

/** For the checks: the model that reads a transcript, scripted. */
export function useNoteReader(d: AskDriver | null): void {
  injectedReader = d;
}

export type SaveNote = { ok: true; noteId: string } | { ok: false; message: string };

/**
 * A recording from the host's phone. Its type, size and length are asked
 * here and its length again by the worker, from the file itself; the visit
 * has to be on site and the host has to hold `visit:outcome` at its tower.
 */
export async function saveNote(o: {
  orgId: string;
  userId: string;
  authz: Authz;
  visitId: string;
  bytes: Buffer;
  contentType: string | null;
  durationMs: number;
  /** For checks: the moment "today" is judged at. */
  nowIso?: string;
}): Promise<SaveNote> {
  const problem = noteProblem({ contentType: o.contentType, bytes: o.bytes.byteLength, durationMs: o.durationMs });
  if (problem) return { ok: false, message: problem };
  const type = noteType(o.contentType)!;
  const v = await withTenant(o.orgId, async (sql) => {
    const [r] = await sql<{ status: string; scope_node_id: string; path: string; notes: number; day: string }[]>`
      SELECT v.status, v.scope_node_id, n.path::text AS path,
             (v.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
             (SELECT count(*)::int FROM visit_notes x WHERE x.visit_id = v.id) AS notes
      FROM site_visits v JOIN scope_nodes n ON n.id = v.scope_node_id
      WHERE v.org_id = ${o.orgId} AND v.id = ${o.visitId}`;
    return r ?? null;
  });
  if (!v) return { ok: false, message: "That visit no longer exists." };
  if (!o.authz.canAt("visit:outcome", v.path)) return { ok: false, message: "You cannot record this visit." };
  const today = new Date(Date.parse(o.nowIso ?? new Date().toISOString()) + 330 * 60_000).toISOString().slice(0, 10);
  const when = noteWhen({ status: v.status, scheduledDay: v.day, today });
  if (!when.ok) return { ok: false, message: when.message };
  if (v.notes >= MAX_NOTES_PER_VISIT) return { ok: false, message: "This visit already has two notes. Record how it went by hand." };

  const id = randomUUID();
  const put = await putAsset({ orgId: o.orgId, project: await projectOfNode(o.orgId, v.scope_node_id), kind: "visitnote", id, bytes: o.bytes, contentType: type });
  if (!put.ok) return { ok: false, message: "The note could not be saved. Try again." };
  try {
    await withTenant(o.orgId, (sql) => sql`
      INSERT INTO visit_notes (id, org_id, visit_id, scope_node_id, storage_key, content_type, bytes, sha256, duration_ms, created_by, before_visit)
      VALUES (${id}, ${o.orgId}, ${o.visitId}, ${v.scope_node_id}, ${put.key}, ${type}, ${put.bytes}, ${put.sha256},
              ${Math.round(o.durationMs)}, ${o.userId}, ${when.before})`);
  } catch (e) {
    await removeAsset(put.key);
    if ((e as { code?: string }).code === "23514") return { ok: false, message: "This visit already has two notes. Record how it went by hand." };
    throw e;
  }
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "visit.note_recorded",
    targetType: "site_visit",
    targetId: o.visitId,
    metadata: { note: id, bytes: put.bytes, seconds: Math.round(o.durationMs / 1000), before_visit: when.before },
  });
  return { ok: true, noteId: id };
}

/** Whether this machine can transcribe: FFmpeg is on it, and it is not a Vercel function. */
export function canProcessHere(): boolean {
  return !process.env.VERCEL;
}

type Claimed = {
  storage_key: string;
  content_type: string;
  scope_node_id: string;
  visit_id: string;
  transcribed: boolean;
  transcript: string | null;
  measured_ms: number | null;
  created_at: Date;
};

/**
 * Transcribe a note and read it into a draft, under a lease so two workers
 * never pay twice. One transcription and two reads a note, each counted
 * before it is asked; the project's minutes are asked before either.
 * Returns the state the note ended in.
 */
export async function processNote(orgId: string, noteId: string, opts: { nowIso?: string } = {}): Promise<string> {
  const note = await withTenant(orgId, async (sql) => {
    const [r] = await sql<Claimed[]>`
      UPDATE visit_notes SET state = 'WORKING', lease_until = now() + make_interval(mins => ${LEASE_MINUTES}), updated_at = now()
      WHERE org_id = ${orgId} AND id = ${noteId}
        AND (state = 'UPLOADED' OR (state = 'WORKING' AND lease_until < now()))
      RETURNING storage_key, content_type, scope_node_id, visit_id, transcribed, transcript, measured_ms, created_at`;
    return r ?? null;
  });
  if (!note) {
    const [s] = await withTenant(orgId, (sql) => sql<{ state: string }[]>`SELECT state FROM visit_notes WHERE org_id = ${orgId} AND id = ${noteId}`);
    return s?.state ?? "GONE";
  }
  const end = async (state: "DRAFTED" | "REFUSED" | "FAILED", reason: string | null, draft?: NoteDraft) => {
    await withTenant(orgId, (sql) => sql`
      UPDATE visit_notes SET state = ${state}, reason = ${reason}, lease_until = NULL, updated_at = now()
             ${draft ? sql`, draft = ${sql.json(draft as never)}` : sql``}
      WHERE org_id = ${orgId} AND id = ${noteId}`);
    await audit({ orgId, actorUserId: null, action: state === "DRAFTED" ? "visit.note_drafted" : "visit.note_failed", targetType: "site_visit", targetId: note.visit_id, metadata: { note: noteId, state } });
    return state;
  };

  let transcript = note.transcript ?? "";
  if (!note.transcribed) {
    const bytes = await readAsset(note.storage_key).catch(() => null);
    if (!bytes) return end("FAILED", "The recording is missing.");
    const dir = await mkdtemp(join(tmpdir(), "est-note-"));
    try {
      const file = join(dir, "note");
      await writeFile(file, bytes);
      const ms = await probeMs(file);
      if (ms === null) return end("FAILED", "Could not read the recording.");
      await withTenant(orgId, (sql) => sql`UPDATE visit_notes SET measured_ms = ${ms} WHERE org_id = ${orgId} AND id = ${noteId}`);
      if (lengthProblem(ms)) return end("REFUSED", LENGTH_MESSAGE);

      // Refused before spending: a note counts half an AI minute.
      const room = await entitle({ orgId, nodeId: note.scope_node_id, needs: [{ unit: "MINUTE", qty: NOTE_MINUTES }], nowIso: opts.nowIso });
      if (!room.ok) return end("FAILED", "No AI minutes left this month. Record how it went by hand.");

      const plan = cutPlan(parseSilences(await silenceLog(file)), ms / 1000);
      const pieces = await Promise.all(plan.map(([a, b], i) => cutPiece(file, join(dir, `p${i}.wav`), a, b)));
      // Asked once, whatever comes back: a transcription is never paid for twice.
      await withTenant(orgId, (sql) => sql`UPDATE visit_notes SET transcribed = true WHERE org_id = ${orgId} AND id = ${noteId}`);
      const heard = await Promise.all(pieces.map((p) => transcribe({ bytes: p, contentType: "audio/wav" })));
      const sttPaise = Math.ceil((ms / 1000) * STT_PAISE_PER_SECOND);
      if (heard.some((h) => !h.ok)) {
        await meterQuietly({ orgId, nodeId: note.scope_node_id, kind: "CALL_MINUTE", qty: 0, costPaise: sttPaise, billable: false, source: { kind: "visit_note", id: noteId }, atIso: opts.nowIso });
        return end("FAILED", "The note could not be transcribed. Record how it went by hand.");
      }
      transcript = heard.map((h) => (h.ok ? h.text : "")).join(" ").replace(/\s+/g, " ").trim().slice(0, 20000);
      const language = heard.map((h) => (h.ok ? h.language : null)).find((l) => !!l) ?? null;
      await withTenant(orgId, (sql) => sql`
        UPDATE visit_notes SET transcript = ${transcript}, language = ${language}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${noteId}`);
      await meterQuietly({
        orgId,
        nodeId: note.scope_node_id,
        kind: "CALL_MINUTE",
        qty: NOTE_MINUTES,
        costPaise: sttPaise + NOTE_READ_PAISE,
        billable: true,
        source: { kind: "visit_note", id: noteId },
        atIso: opts.nowIso,
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (!transcript) return end("FAILED", "Nothing was heard in the note. Record how it went by hand.");

  const units = await noteUnits(orgId, note.scope_node_id);
  for (;;) {
    const tried = await withTenant(orgId, (sql) => sql`
      UPDATE visit_notes SET extract_tries = extract_tries + 1, lease_until = now() + make_interval(mins => ${LEASE_MINUTES})
      WHERE org_id = ${orgId} AND id = ${noteId} AND extract_tries < ${MAX_EXTRACT_TRIES} RETURNING id`);
    if (!tried.length) break;
    const answer = await (injectedReader ?? askJson)({
      model: NOTE_MODEL,
      system: notePrompt(units),
      parts: [{ text: transcript }],
      schema: noteSchema(units.map((u) => u.id)),
      name: "visit_note",
      timeoutMs: READ_TIMEOUT_MS,
      effort: "low",
    }).catch(() => ({ ok: false as const }));
    if (answer.ok) return end("DRAFTED", null, readNote(answer.value, { transcript, unitIds: units.map((u) => u.id) }));
  }
  return end("FAILED", "The note could not be read. Record how it went by hand.");
}

async function noteUnits(orgId: string, nodeId: string): Promise<NoteUnit[]> {
  const { units } = await approvedUnits(orgId, nodeId).catch(() => ({ units: [] }));
  return units.map((u) => ({ id: u.id, label: u.label, carpetSqft: u.carpetAreaSqft }));
}

async function probeMs(file: string): Promise<number | null> {
  try {
    const { stdout } = await exec(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    const s = Number(String(stdout).trim());
    if (Number.isFinite(s) && s > 0) return Math.round(s * 1000);
  } catch {
    /* a container without a duration header is read the long way below */
  }
  // A browser's WebM often carries no duration: decode it and read the clock.
  try {
    const { stderr } = await exec(FFMPEG, ["-hide_banner", "-i", file, "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 });
    const all = [...String(stderr).matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
    const last = all[all.length - 1];
    return last ? Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000) : null;
  } catch {
    return null;
  }
}

async function silenceLog(file: string): Promise<string> {
  try {
    const { stderr } = await exec(FFMPEG, ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 });
    return String(stderr);
  } catch {
    return "";
  }
}

async function cutPiece(file: string, out: string, from: number, to: number): Promise<Buffer> {
  await exec(FFMPEG, ["-y", "-loglevel", "error", "-ss", String(from), "-to", String(to), "-i", file, "-ac", "1", "-ar", "16000", out]);
  return readFile(out);
}

/** Notes waiting for the worker, and any whose worker died, a few at a time. */
export async function processDueNotes(orgId: string, opts: { nowIso?: string; max?: number } = {}): Promise<number> {
  const due = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    SELECT id FROM visit_notes
    WHERE org_id = ${orgId} AND (state = 'UPLOADED' OR (state = 'WORKING' AND lease_until < now()))
    ORDER BY created_at LIMIT ${opts.max ?? 5}`);
  for (const n of due) await processNote(orgId, n.id, opts);
  return due.length;
}

export type NoteView = {
  id: string;
  state: string;
  reason: string | null;
  seconds: number;
  /** Left on the day, before the buyer was checked in. */
  beforeVisit: boolean;
  /** What was heard, any phone number in it masked. */
  transcript: string | null;
  draft: { interest: string | null; objection: string | null; next: string | null; shown: string[]; unitIds: string[] } | null;
};

/** The newest note on a visit, as the host's screen shows it. */
export async function latestNote(orgId: string, visitId: string): Promise<NoteView | null> {
  const [n] = await withTenant(orgId, (sql) => sql<{ id: string; state: string; reason: string | null; duration_ms: number; transcript: string | null; draft: NoteDraft | null; scope_node_id: string; before_visit: boolean }[]>`
    SELECT id, state, reason, duration_ms, transcript, draft, scope_node_id, before_visit FROM visit_notes
    WHERE org_id = ${orgId} AND visit_id = ${visitId} ORDER BY created_at DESC LIMIT 1`);
  if (!n) return null;
  const units = n.draft ? await noteUnits(orgId, n.scope_node_id) : [];
  return {
    id: n.id,
    state: n.state,
    reason: n.reason,
    seconds: Math.round(n.duration_ms / 1000),
    beforeVisit: n.before_visit,
    transcript: n.transcript ? redactPhones(n.transcript, "MASKED") : null,
    draft: n.draft ? { ...draftOutcome(n.draft, units), unitIds: n.draft.units.map((u) => u.id) } : null,
  };
}

/** The host confirmed the draft (or corrected it): the note is done with. */
export async function confirmNote(o: { orgId: string; userId: string; visitId: string; noteId: string }): Promise<boolean> {
  const r = await withTenant(o.orgId, (sql) => sql`
    UPDATE visit_notes SET state = 'CONFIRMED', confirmed_by = ${o.userId}, confirmed_at = now(), updated_at = now()
    WHERE org_id = ${o.orgId} AND id = ${o.noteId} AND visit_id = ${o.visitId} AND state = 'DRAFTED'`);
  return r.count > 0;
}

/** A five-minute link to play a note, for somebody who may read visits at its tower. */
export async function noteLink(orgId: string, authz: Authz, noteId: string): Promise<string | null> {
  const [n] = await withTenant(orgId, (sql) => sql<{ storage_key: string; content_type: string; path: string }[]>`
    SELECT x.storage_key, x.content_type, s.path::text AS path
    FROM visit_notes x JOIN scope_nodes s ON s.id = x.scope_node_id
    WHERE x.org_id = ${orgId} AND x.id = ${noteId}`);
  if (!n || !authz.canAt("visit:read", n.path)) return null;
  const url = await assetUrl(n.storage_key, n.content_type);
  return url.ok ? url.url : null;
}

/**
 * Notes whose lead was booked or lost twelve months ago, and their files.
 * The database allows no other note to be deleted.
 */
export async function expireNotes(orgId: string): Promise<number> {
  const gone = await withTenant(orgId, (sql) => sql<{ storage_key: string }[]>`
    DELETE FROM visit_notes x
    USING site_visits v JOIN leads l ON l.id = v.lead_id
    WHERE x.org_id = ${orgId} AND v.id = x.visit_id AND l.stage IN ('booked', 'lost')
      AND l.updated_at < now() - interval '12 months'
    RETURNING x.storage_key`);
  for (const g of gone) await removeAsset(g.storage_key);
  if (gone.length) await audit({ orgId, actorUserId: null, action: "visit.notes_expired", targetType: "org", targetId: orgId, metadata: { count: gone.length } });
  return gone.length;
}
