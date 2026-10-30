import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlDb, withTenant } from "./db/index.ts";
import { callRecording, type CallAudio } from "./calling.ts";
import { assetExists, putAsset, readAsset, removeAsset } from "./storage.ts";
import { transcribe } from "./stt.ts";
import { NO_REPLY_HEARD, NO_REPLY_REASON, SCREENER_REASON, heardOnSilentCall } from "./calling-rules.ts";
import { OUTCOME, type Outcome } from "./call-rules.ts";
import { listRowReason } from "./call-list-rules.ts";
import { projectOfNode } from "./storage-place.ts";

/**
 * A call's recording, kept in our own bucket.
 *
 * Sarvam holds the recording when a call ends. The lead worker copies it to
 * the bucket under the call's project (`archiveDueRecordings()`), as a
 * speech-sized MP3 where FFmpeg is at hand and as Sarvam sent it otherwise,
 * and the row then names the key. From there the player and the export read
 * it, quickly and for as long as we keep it, and erasing the buyer removes it.
 * A call not yet copied is still played from Sarvam, and copied on that play.
 */

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/** How often Sarvam is asked for one recording before it is left alone. */
export const RECORDING_TRIES = 3;

export type RecordingSource =
  | { kind: "stored"; key: string; type: string; placedAt: Date }
  | { kind: "sarvam"; placedAt: Date };

/** Where one of this tenant's calls' recording is, or null for none (or an erased buyer's). */
export async function recordingSource(orgId: string, callId: string): Promise<RecordingSource | null> {
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return null;
  const [r] = await withTenant(orgId, (sql) => sql<{
    recording_key: string | null; recording_type: string | null; interaction_id: string | null; placed_at: Date;
  }[]>`
    SELECT c.recording_key, c.recording_type, c.interaction_id, c.placed_at
    FROM calls c JOIN leads l ON l.id = c.lead_id
    WHERE c.org_id = ${orgId} AND c.id = ${callId} AND l.erased_at IS NULL`);
  if (!r) return null;
  if (r.recording_key && r.recording_type) return { kind: "stored", key: r.recording_key, type: r.recording_type, placedAt: r.placed_at };
  return r.interaction_id ? { kind: "sarvam", placedAt: r.placed_at } : null;
}

/** Speech as a mono 32 kbps MP3: a tenth of the WAV, and clear on a phone line. */
async function asMp3(audio: CallAudio): Promise<CallAudio> {
  if (process.env.VERCEL || /mpeg|mp3/i.test(audio.type)) return audio;
  const dir = await mkdtemp(join(tmpdir(), "estn-rec-"));
  try {
    await writeFile(join(dir, "in"), audio.bytes);
    await exec(FFMPEG, ["-y", "-loglevel", "error", "-i", join(dir, "in"), "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "32k", join(dir, "out.mp3")], {
      timeout: 120_000,
    });
    const mp3 = await readFile(join(dir, "out.mp3"));
    return mp3.byteLength ? { bytes: new Uint8Array(mp3), type: "audio/mpeg", placedAt: audio.placedAt } : audio;
  } catch {
    return audio;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export type ArchiveResult = "stored" | "already" | "missing" | "failed";

/**
 * Copy one call's recording to the bucket. `got` is the recording when the
 * caller already has it (a play just fetched it), so Sarvam is asked once.
 */
export async function archiveRecording(orgId: string, callId: string, got?: CallAudio): Promise<ArchiveResult> {
  // One copy at a time per call in a process: a play asks the route twice
  // (where to play from, then the bytes) and both would copy it.
  const key = `${orgId}:${callId}`;
  const running = archiving.get(key);
  if (running) return running;
  const job = archiveOnce(orgId, callId, got).finally(() => archiving.delete(key));
  archiving.set(key, job);
  return job;
}

const archiving = new Map<string, Promise<ArchiveResult>>();

async function archiveOnce(orgId: string, callId: string, got?: CallAudio): Promise<ArchiveResult> {
  const [row] = await withTenant(orgId, (sql) => sql<{ recording_key: string | null; scope_node_id: string | null; erased: boolean }[]>`
    SELECT c.recording_key, c.scope_node_id, l.erased_at IS NOT NULL AS erased
    FROM calls c JOIN leads l ON l.id = c.lead_id
    WHERE c.org_id = ${orgId} AND c.id = ${callId}`);
  if (!row || row.erased) return "missing";
  if (row.recording_key) return "already";

  const audio = got ?? (await callRecording(orgId, callId).catch(() => null));
  if (!audio) return "missing";
  const kept = await asMp3(audio);
  const put = await putAsset({
    orgId,
    project: await projectOfNode(orgId, row.scope_node_id),
    kind: "recording",
    id: callId,
    bytes: Buffer.from(kept.bytes),
    contentType: kept.type,
  });
  if (!put.ok) return "failed";
  // Only onto a row still without one, and never an erased buyer's (a trigger).
  const saved = await withTenant(orgId, (sql) => sql`
    UPDATE calls SET recording_key = ${put.key}, recording_type = ${kept.type}
    WHERE org_id = ${orgId} AND id = ${callId} AND recording_key IS NULL
    RETURNING recording_key`);
  if (!saved.length || !saved[0].recording_key) {
    // Another copy (the worker, a play on another server) saved first. The
    // key is the call's own, so both wrote the same object: removing it here
    // took the other copy's file with it and left the row naming nothing.
    const [now] = await withTenant(orgId, (sql) => sql<{ recording_key: string | null }[]>`
      SELECT recording_key FROM calls WHERE org_id = ${orgId} AND id = ${callId}`);
    if (now?.recording_key !== put.key) await removeAsset(put.key);
    return saved.length ? "missing" : "already";
  }
  return "stored";
}

/**
 * The worker's pass: finished calls from the last `days` whose recording is
 * not in the bucket yet, newest first, at most `limit` a pass. Each try is
 * counted before Sarvam is asked, so a recording Sarvam no longer holds is
 * asked for `RECORDING_TRIES` times and then left.
 */
export async function archiveDueRecordings(opts: { limit?: number; days?: number } = {}): Promise<{ stored: number; missing: number; failed: number }> {
  const limit = opts.limit ?? 20;
  const days = opts.days ?? 30;
  const report = { stored: 0, missing: 0, failed: 0 };
  const orgs = await controlDb<{ id: string }[]>`SELECT id FROM orgs WHERE status <> 'SUSPENDED' ORDER BY created_at`;
  let left = limit;
  for (const org of orgs) {
    if (left <= 0) break;
    const due = await withTenant(org.id, (sql) => sql<{ id: string }[]>`
      UPDATE calls c SET recording_tries = c.recording_tries + 1
      FROM (
        SELECT c2.id FROM calls c2 JOIN leads l ON l.id = c2.lead_id
        WHERE c2.org_id = ${org.id}
          AND c2.recording_key IS NULL AND c2.interaction_id IS NOT NULL
          AND c2.recording_tries < ${RECORDING_TRIES}
          AND c2.status NOT IN ('PLACING', 'DIALLING', 'REFUSED')
          AND c2.placed_at > now() - make_interval(days => ${days})
          AND c2.placed_at < now() - interval '3 minutes'
          AND l.erased_at IS NULL
        ORDER BY c2.placed_at DESC
        LIMIT ${left}
      ) d
      WHERE c.org_id = ${org.id} AND c.id = d.id
      RETURNING c.id`).catch(() => [] as { id: string }[]);
    for (const { id } of due) {
      left -= 1;
      const r = await archiveRecording(org.id, id).catch((): ArchiveResult => "failed");
      if (r === "stored") report.stored += 1;
      else if (r === "missing") report.missing += 1;
      else if (r === "failed") report.failed += 1;
    }
  }
  return report;
}

/** A silent call's recording is heard only when it fits one Saaras request. */
const HEAR_MAX_SECONDS = 29;

/**
 * Hear the recordings of calls the agent heard nobody on, and name a call
 * screener where one answered (it often speaks over the agent's greeting,
 * which the agent does not transcribe). Saaras, about Rs 0.08 a 10 second
 * call, at most `limit` a pass, each call once: a recording with no screener
 * is marked checked. Never throws.
 */
export async function hearSilentCalls(opts: { limit?: number } = {}): Promise<{ heard: number; screened: number }> {
  const out = { heard: 0, screened: 0 };
  let left = opts.limit ?? 20;
  const orgs = await controlDb<{ id: string }[]>`SELECT id FROM orgs WHERE status <> 'SUSPENDED' ORDER BY created_at`.catch(() => []);
  for (const org of orgs) {
    if (left <= 0) break;
    const due = await withTenant(org.id, (sql) => sql<{ id: string; recording_key: string; transcript: { role: string; en: string }[] | null }[]>`
      SELECT id, recording_key, transcript FROM calls
      WHERE org_id = ${org.id} AND outcome = 'NO_REPLY' AND failure_reason = ${NO_REPLY_REASON}
        AND recording_key IS NOT NULL AND duration_s <= ${HEAR_MAX_SECONDS}
        AND placed_at > now() - interval '2 days'
      ORDER BY placed_at DESC LIMIT ${left}`).catch(() => []);
    for (const c of due) {
      left -= 1;
      const bytes = await readAsset(c.recording_key).catch(() => null);
      if (!bytes) continue;
      const heard = await transcribe({ bytes, contentType: "audio/mpeg", mode: "transcribe", fileName: "call.mp3" });
      if (!heard.ok) continue;
      out.heard += 1;
      const turns = c.transcript ?? [];
      const { screener, other } = heardOnSilentCall(heard.text, turns.filter((t) => t.role === "agent").map((t) => t.en));
      await withTenant(org.id, async (sql) => {
        if (screener) {
          out.screened += 1;
          const said = [{ role: "user", en: other, indic: null }, ...turns];
          await sql`UPDATE calls SET outcome = 'SCREENED', failure_reason = ${SCREENER_REASON}, transcript = ${sql.json(said as never)}
            WHERE org_id = ${org.id} AND id = ${c.id} AND outcome = 'NO_REPLY'`;
        } else {
          await sql`UPDATE calls SET failure_reason = ${NO_REPLY_HEARD} WHERE org_id = ${org.id} AND id = ${c.id} AND outcome = 'NO_REPLY'`;
        }
        // A call list's row says the same as the call.
        const outcome: Outcome = screener ? "SCREENED" : "NO_REPLY";
        const rows = await sql<{ id: string; state: "READY" | "UNREACHED" | "CALLED"; tries: number }[]>`
          SELECT id, state, tries FROM call_list_rows WHERE org_id = ${org.id} AND call_id = ${c.id} AND state IN ('READY', 'UNREACHED')`;
        for (const r of rows) {
          await sql`UPDATE call_list_rows SET reason = ${listRowReason({ state: r.state, tries: r.tries, outcomeLabel: OUTCOME[outcome].label })} WHERE id = ${r.id}`;
        }
      }).catch(() => undefined);
    }
  }
  return out;
}

/**
 * A row that names a file the bucket no longer holds is let go of, so the
 * recording is played from Sarvam again and copied afresh. Only that key,
 * and only when the store says it is gone.
 */
export async function forgetMissingRecording(orgId: string, callId: string, key: string): Promise<boolean> {
  if (await assetExists(key)) return false;
  const done = await withTenant(orgId, (sql) => sql`
    UPDATE calls SET recording_key = NULL, recording_type = NULL, recording_tries = 0
    WHERE org_id = ${orgId} AND id = ${callId} AND recording_key = ${key}
    RETURNING id`);
  return done.length > 0;
}
