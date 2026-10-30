import { randomUUID } from "node:crypto";
import { audit, controlDb, withTenant } from "./db/index.ts";
import { askJson, type AskDriver } from "./generate.ts";
import { entitle, meterQuietly } from "./billing.ts";
import { addLeadByHand, callLines, placeCall } from "./calling.ts";
import { goalProblem, GOAL_MAX, istDate } from "./calling-rules.ts";
import type { Authz } from "./rbac-rules.ts";
import { maskPhone } from "./mask-rules.ts";
import { OUTCOME, type Language, type Outcome } from "./call-rules.ts";
import {
  DRAFT_DAYS,
  LISTS_PER_DAY,
  LIST_MAX_LINES,
  LIST_READ_COST_PAISE,
  LIST_READ_MINUTES,
  LIST_STOPPERS,
  LIST_WAITERS,
  MAX_LIST_ROWS,
  READS_AT_ONCE,
  ROWS_PER_READ,
  SAMPLE_ROWS,
  afterListCall,
  listRowReason,
  listRetry,
  applyAnswers,
  gatherQuestions,
  MAX_QUESTIONS,
  openQuestions,
  readColumnQuestions,
  timingOf,
  verdictOf,
  windowWait,
  type ListQuestion,
  type PitchedTower,
  pickedTower,
  towerLine,
  checkColumns,
  checkNotes,
  mayCallEnquired,
  COLD_GOAL,
  type ListSource,
  columnsInput,
  columnProfile,
  sheetGuide,
  columnsPrompt,
  columnsSchema,
  countRows,
  listConsentWording,
  notesInput,
  notesPrompt,
  notesSchema,
  personOf,
  planRows,
  readPurpose,
  sampleIndexes,
  tableOf,
  type Column,
  type ListCounts,
  type ListRowState,
  type ListState,
  type RowNote,
  type Tower,
} from "./call-list-rules.ts";

/**
 * Call lists: the reads, writes and model calls around `call-list-rules.ts`.
 *
 * Reading a list is two kinds of request to `gpt-5-mini`: one for the
 * columns (the header and a random dozen rows, every phone hidden) and one
 * per forty people for their remarks (only the remarks, no name or number).
 * Each counts against the tower's AI minutes as a call's reading does, and
 * is refused before it is asked. Calling a list is the worker's: a few at a
 * time, each person through the capture's ownership rules and every gate
 * `placeCall()` asks.
 */

export const LIST_MODEL = process.env.CALL_LIST_MODEL || "gpt-5-mini";
const READ_TIMEOUT_MS = 90_000;

let injected: AskDriver | null = null;

/** For checks: answer every read with `driver` until `restore()`. */
export function useListReader(driver: AskDriver | null): { restore(): void } {
  injected = driver;
  return { restore: () => void (injected = null) };
}
const reader = (): AskDriver => injected ?? askJson;

/** gpt-5-mini's list price in dollars a million tokens, for the list's own record. */
const usdOf = (u?: { tokensIn: number; tokensOut: number }) => (u ? (u.tokensIn * 0.25 + u.tokensOut * 2) / 1e6 : 0);

/**
 * The towers this person may add leads to and call on, each with whether
 * it may be spoken about today (the RERA gate): a tower that may not is
 * shown and never chosen.
 */
export async function callableTowers(orgId: string, authz: Pick<Authz, "canAt" | "scopesFor">): Promise<(Tower & { path: string; ok: boolean })[]> {
  const scopes = authz.scopesFor("lead:call");
  if (!scopes.length) return [];
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; name: string; project: string | null; path: string }[]>`
    SELECT n.id, n.name, n.path::text AS path,
           (SELECT p.name FROM scope_nodes p WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project
    FROM scope_nodes n
    WHERE n.org_id = ${orgId} AND n.kind = 'PHASE' AND n.path <@ ANY(${scopes}::ltree[])
    ORDER BY project NULLS LAST, n.name`);
  const mine = rows.filter((t) => authz.canAt("lead:call", t.path) && authz.canAt("lead:create", t.path));
  if (!mine.length) return [];
  const { complianceSummary } = await import("./publish-gate.ts");
  const open = new Set((await complianceSummary(orgId)).phases.filter((p) => p.ok).map((p) => p.phaseId));
  return mine.map((t) => ({ ...t, ok: open.has(t.id) }));
}

export type ReadOutcome = { ok: true; listId: string } | { ok: false; message: string };

/**
 * Read an uploaded sheet into a list waiting to be started. Nothing is
 * called and no lead is made: the person reads the plan first.
 */
export async function readCallList(o: {
  orgId: string;
  userId: string;
  authz: Pick<Authz, "canAt" | "scopesFor">;
  /** The towers the list pitches, in the order chosen; the first is called about when nothing picks another. */
  towerIds: string[];
  /** Where the sheet's people came from, as the person says. */
  source: ListSource | null;
  fileName: string;
  rows: string[][];
  nowIso?: string;
}): Promise<ReadOutcome> {
  if (!o.source) return { ok: false, message: "Say whether these people enquired." };
  const nowIso = o.nowIso ?? new Date().toISOString();
  const callable = await callableTowers(o.orgId, o.authz);
  const towers = [...new Set(o.towerIds)].map((id) => callable.find((t) => t.id === id)).filter((t): t is (typeof callable)[number] => !!t);
  if (!towers.length || towers.length !== new Set(o.towerIds).size) return { ok: false, message: "Choose the towers these people are about." };
  const closed = towers.find((t) => !t.ok);
  if (closed) return { ok: false, message: `${closed.project ? `${closed.project} ${closed.name}` : closed.name} can't be advertised right now, so nobody can be called about it. Take it off the list.` };
  const tower = towers[0];
  const pitched = towers.length > 1 ? await pitchedTowers(o.orgId, towers) : [];

  const towerLabel = towers.map((t) => (t.project ? `${t.project} ${t.name}` : t.name)).join(", ");
  const { header, body } = tableOf(o.rows);
  if (!body.length) return { ok: false, message: "The file has no people in it." };
  if (body.length > MAX_LIST_ROWS) return { ok: false, message: `The file has ${body.length.toLocaleString("en-IN")} people. Split it into lists of ${MAX_LIST_ROWS} at most.` };

  const today = await withTenant(o.orgId, (sql) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM call_lists
    WHERE org_id = ${o.orgId} AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (${nowIso}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`);
  if ((today[0]?.n ?? 0) >= LISTS_PER_DAY) return { ok: false, message: `${LISTS_PER_DAY} lists have been read today. Try again tomorrow.` };

  let reads = 0;
  let usd = 0;
  // Every read is asked of the plan first, like a call's reading.
  const mayRead = async () => (await entitle({ orgId: o.orgId, nodeId: tower.id, needs: [{ unit: "MINUTE", qty: LIST_READ_MINUTES }], nowIso })).ok;

  // The columns: the model's reading, checked, or our own.
  let cols: Column[] | null = null;
  let purpose = "";
  let goal: string | null = null;
  let readBy: "model" | "rules" = "rules";
  let columnQuestions: { text: string; options: string[]; column: string | null }[] = [];
  const seed = `${o.orgId}:${o.fileName}:${body.length}`;
  if (await mayRead()) {
    const sample = sampleIndexes(body.length, SAMPLE_ROWS, seed).map((i) => body[i]);
    const a = await reader()({
      model: LIST_MODEL,
      system: columnsPrompt(towerLabel),
      // Every column's values, then a few whole rows to see how they go together.
      parts: [{ text: `${columnProfile(header, body)}\n\n${columnsInput(header, sample.slice(0, 5))}` }],
      schema: columnsSchema(header.length),
      name: "call_list_columns",
      timeoutMs: READ_TIMEOUT_MS,
      effort: "low",
    });
    reads += 1;
    if (a.ok) {
      usd += usdOf(a.usage);
      cols = checkColumns(a.value, header, body);
      ({ purpose, goal } = readPurpose(a.value));
      columnQuestions = readColumnQuestions(a.value, header);
      readBy = "model";
    }
  }
  cols ??= checkColumns(null, header, body);
  if (!cols) return { ok: false, message: "No column in the file holds phone numbers." };

  // Questions about the sheet come first: nobody is read until the team
  // has said what its columns mean. With none, everybody is read now.
  const questions = gatherQuestions(columnQuestions, () => randomUUID());
  const people = body.map((r) => personOf(r, cols!));
  const read = questions.length
    ? { notes: new Map<number, RowNote>(), reads: 0, usd: 0, unread: 0 }
    : await readNotes({
        people: people.filter((p) => p.context && p.phone),
        system: notesPrompt(purpose, goal, istDate(nowIso), sheetGuide(cols, []), towerLabel, pitched),
        mayRead,
      });
  reads += read.reads;
  usd += read.usd;
  const notes = read.notes;
  const unread = read.unread;

  const planned = planRows(people, notes, { towers, defaultTower: tower.id, nowIso });
  const listId = await withTenant(o.orgId, async (sql) => {
    const [l] = await sql<{ id: string }[]>`
      INSERT INTO call_lists (org_id, scope_node_id, tower_ids, created_by, file_name, columns, purpose, goal, read_by, reads, cost_usd, questions, ask_rounds, source)
      VALUES (${o.orgId}, ${tower.id}, ${towers.map((t) => t.id)}::uuid[], ${o.userId}, ${o.fileName.slice(0, 200) || "List"}, ${sql.json(cols as never)},
              ${purpose}, ${goal}, ${readBy}, ${reads}, ${usd.toFixed(4)}, ${sql.json(questions as never)}, ${questions.length ? 1 : 0}, ${o.source})
      RETURNING id`;
    for (let i = 0; i < planned.length; i += 200) {
      const chunk = planned.slice(i, i + 200).map((r) => ({
        org_id: o.orgId,
        list_id: l.id,
        line: r.line,
        scope_node_id: r.towerId,
        name: r.name || null,
        phone: r.phone,
        language: r.language,
        note: r.note,
        goal: r.goal,
        enquired: r.enquired,
        state: r.state,
        reason: r.reason,
        not_before: r.notBefore ? new Date(r.notBefore) : null,
        window_from: r.windowFrom,
        window_to: r.windowTo,
      }));
      await sql`INSERT INTO call_list_rows ${sql(chunk)}`;
    }
    return l.id;
  });
  await meterReads(o.orgId, tower.id, listId, 0, reads, nowIso);
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "call_list.read",
    targetType: "call_list",
    targetId: listId,
    metadata: { rows: planned.length, ready: planned.filter((r) => r.state === "READY").length, reads, read_by: readBy, unread, questions: questions.length, source: o.source },
  });
  return { ok: true, listId };
}

/** Each chosen tower in a line the remarks reader matches people against: its place and what it sells from. */
async function pitchedTowers(orgId: string, towers: readonly Tower[]): Promise<PitchedTower[]> {
  const [{ approvedUnits }, { priceFor }, { resolveBrain }] = await Promise.all([import("./unit.ts"), import("./unit-rules.ts"), import("./brain.ts")]);
  return Promise.all(
    towers.map(async (t) => {
      const [{ units, basePsf }, brain] = await Promise.all([approvedUnits(orgId, t.id).catch(() => ({ units: [], basePsf: null })), resolveBrain(orgId, t.id).catch(() => null)]);
      const homes = units.map((u) => ({ label: u.label, price: priceFor(u, basePsf) })).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
      return { ...t, about: towerLine({ name: t.name, project: t.project, location: brain?.values?.["claims.location"]?.trim() || null, homes }) };
    }),
  );
}

/** Each read is metered as a fraction of an AI minute, numbered from `from` so a later round never collides. */
async function meterReads(orgId: string, nodeId: string, listId: string, from: number, count: number, nowIso: string): Promise<void> {
  for (let n = from; n < from + count; n += 1) {
    await meterQuietly({
      orgId,
      nodeId,
      kind: "CALL_MINUTE",
      qty: LIST_READ_MINUTES,
      costPaise: LIST_READ_COST_PAISE,
      billable: true,
      source: { kind: "call", id: `list:${listId}:${n}` },
      atIso: nowIso,
    });
  }
}

/** People's remarks read forty at a time, a few requests at once, each asked of the plan first. */
async function readNotes(o: {
  people: readonly { line: number; context: string }[];
  system: string;
  mayRead: () => Promise<boolean>;
}): Promise<{ notes: Map<number, RowNote>; reads: number; usd: number; unread: number }> {
  const out = { notes: new Map<number, RowNote>(), reads: 0, usd: 0, unread: 0 };
  const batches: (typeof o.people)[] = [];
  for (let i = 0; i < o.people.length; i += ROWS_PER_READ) batches.push(o.people.slice(i, i + ROWS_PER_READ));
  for (let i = 0; i < batches.length; i += READS_AT_ONCE) {
    const round = batches.slice(i, i + READS_AT_ONCE);
    const answers = await Promise.all(
      round.map(async (batch) => {
        if (!(await o.mayRead())) return null;
        return reader()({
          model: LIST_MODEL,
          system: o.system,
          parts: [{ text: notesInput(batch) }],
          schema: notesSchema(),
          name: "call_list_notes",
          timeoutMs: READ_TIMEOUT_MS,
          effort: "low",
        });
      }),
    );
    answers.forEach((a, k) => {
      if (a) out.reads += 1;
      if (!a?.ok) {
        out.unread += round[k].length;
        return;
      }
      out.usd += usdOf(a.usage);
      for (const [line, n] of checkNotes(a.value, round[k].map((p) => p.line))) out.notes.set(line, n);
    });
  }
  return out;
}

/**
 * The person's answers to the sheet's questions, all at once. Then every
 * person with something in a context column is read, with the columns'
 * rules and the answers, and the system takes the most sensible reading of
 * each row; it never asks about a person.
 */
export async function answerListQuestions(o: {
  orgId: string;
  userId: string;
  authz: Pick<Authz, "canAt">;
  listId: string;
  given: Record<string, { pick?: string; other?: string; skip?: boolean }>;
  nowIso?: string;
}): Promise<Act> {
  const nowIso = o.nowIso ?? new Date().toISOString();
  const place = await listPlace(o.orgId, o.listId, o.authz);
  if (!place) return { ok: false, message: "That list is not one you can call." };
  if (place.state !== "DRAFT") return { ok: false, message: "The list has started." };
  const [l] = await withTenant(o.orgId, (sql) => sql<{ scope_node_id: string; tower_ids: string[]; columns: Column[]; purpose: string; goal: string | null; questions: ListQuestion[]; reads: number; tower: string }[]>`
    SELECT l.scope_node_id, l.tower_ids, l.columns, l.purpose, l.goal, l.questions, l.reads,
           concat_ws(' ', (SELECT p.name FROM scope_nodes p WHERE p.org_id = l.org_id AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1), n.name) AS tower
    FROM call_lists l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${o.orgId} AND l.id = ${o.listId}`);
  const applied = applyAnswers(l.questions, o.given);
  if (applied.missing) return { ok: false, message: "Answer every question, or leave it to the system." };

  const chosen = await listTowers(o.orgId, l.tower_ids.length ? l.tower_ids : [l.scope_node_id]);
  const pitched = chosen.length > 1 ? await pitchedTowers(o.orgId, chosen) : [];
  const rows = await withTenant(o.orgId, (sql) => sql<{ line: number; note: string | null }[]>`
    SELECT line, note FROM call_list_rows
    WHERE org_id = ${o.orgId} AND list_id = ${o.listId} AND note IS NOT NULL AND phone IS NOT NULL AND name IS NOT NULL
      AND (reason IS NULL OR reason NOT LIKE 'Same number as line%')`);
  const read = await readNotes({
    people: rows.map((r) => ({ line: r.line, context: r.note ?? "" })),
    system: notesPrompt(l.purpose, l.goal, istDate(nowIso), sheetGuide(l.columns, applied.questions), l.tower, pitched),
    mayRead: async () => (await entitle({ orgId: o.orgId, nodeId: l.scope_node_id, needs: [{ unit: "MINUTE", qty: LIST_READ_MINUTES }], nowIso })).ok,
  });

  await withTenant(o.orgId, async (sql) => {
    for (const [line, n] of read.notes) {
      const t = timingOf(n, nowIso);
      const v = verdictOf(n);
      await sql`
        UPDATE call_list_rows SET goal = ${n.goal}, enquired = ${n.enquired}, state = ${v.state}, reason = ${v.reason},
               language = COALESCE(${n.language}, language),
               scope_node_id = COALESCE(${pickedTower(n, chosen)}::uuid, scope_node_id),
               not_before = ${t.notBefore ? new Date(t.notBefore) : null}, window_from = ${t.windowFrom}, window_to = ${t.windowTo},
               updated_at = now()
        WHERE org_id = ${o.orgId} AND list_id = ${o.listId} AND line = ${line} AND state IN ('READY', 'SKIPPED')`;
    }
    await sql`
      UPDATE call_lists SET questions = ${sql.json(applied.questions as never)},
             reads = reads + ${read.reads}, cost_usd = cost_usd + ${read.usd.toFixed(4)}, updated_at = now()
      WHERE org_id = ${o.orgId} AND id = ${o.listId} AND state = 'DRAFT'`;
  });
  await meterReads(o.orgId, l.scope_node_id, o.listId, l.reads, read.reads, nowIso);
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "call_list.answered",
    targetType: "call_list",
    targetId: o.listId,
    metadata: { answered: applied.answered.length, left: applied.answered.filter((q) => q.skipped).length, read: read.notes.size, unread: read.unread },
  });
  const n = read.notes.size;
  return { ok: true, message: `Thanks. ${n} ${n === 1 ? "person's call is" : "people's calls are"} planned from what the sheet says. Check them, then start.` };
}

/** The towers a list pitches, in its order, with their projects' names. */
async function listTowers(orgId: string, ids: readonly string[]): Promise<Tower[]> {
  if (!ids.length) return [];
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; name: string; project: string | null }[]>`
    SELECT n.id, n.name,
           (SELECT p.name FROM scope_nodes p WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project
    FROM scope_nodes n WHERE n.org_id = ${orgId} AND n.kind = 'PHASE' AND n.id = ANY(${ids as string[]}::uuid[])`);
  return ids.map((id) => rows.find((r) => r.id === id)).filter((t): t is Tower => !!t);
}

/** Remove a list that is not calling. Its people's leads and calls stay; only the plan goes. */
export async function deleteCallList(o: { orgId: string; userId: string; authz: Pick<Authz, "canAt">; listId: string }): Promise<Act> {
  const l = await listPlace(o.orgId, o.listId, o.authz);
  if (!l) return { ok: false, message: "That list is not one you can call." };
  if (l.state === "RUNNING") return { ok: false, message: "Pause or stop the list before deleting it." };
  const r = await withTenant(o.orgId, (sql) => sql`
    DELETE FROM call_lists WHERE org_id = ${o.orgId} AND id = ${o.listId} AND state <> 'RUNNING'
      AND NOT EXISTS (SELECT 1 FROM call_list_rows r WHERE r.list_id = call_lists.id AND r.state = 'CALLING')`);
  if (!r.count) return { ok: false, message: "A call from this list is still ringing. Try again in a few minutes." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "call_list.deleted", targetType: "call_list", targetId: o.listId });
  return { ok: true, message: "List deleted. The leads it made stay on the board." };
}

export type ListView = {
  id: string;
  fileName: string;
  state: ListState;
  tower: { id: string; name: string };
  /** Every tower the list pitches, the first first. */
  towers: { id: string; label: string }[];
  columns: Column[];
  purpose: string;
  goal: string | null;
  source: ListSource;
  readBy: "model" | "rules";
  pausedReason: string | null;
  questions: ListQuestion[];
  createdAt: string;
  startedAt: string | null;
  counts: ListCounts;
  rows: {
    line: number;
    name: string | null;
    phone: string | null;
    language: Language;
    tower: string | null;
    note: string | null;
    goal: string | null;
    state: ListRowState;
    reason: string | null;
    leadId: string | null;
    /** Not rung before this, when the row asked for a time or a retry waits. */
    notBefore: string | null;
    /** The hours of the day this person is rung in, India time. */
    window: { from: string; to: string } | null;
  }[];
};

async function listTowersIn(sql: Parameters<Parameters<typeof withTenant>[1]>[0], orgId: string, ids: readonly string[]): Promise<Tower[]> {
  const rows = await sql<{ id: string; name: string; project: string | null }[]>`
    SELECT n.id, n.name,
           (SELECT p.name FROM scope_nodes p WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project
    FROM scope_nodes n WHERE n.org_id = ${orgId} AND n.kind = 'PHASE' AND n.id = ANY(${ids as string[]}::uuid[])`;
  return ids.map((id) => rows.find((r) => r.id === id)).filter((t): t is Tower => !!t);
}

/** One list as the screen shows it, only where the viewer reads leads. */
export async function getCallList(orgId: string, listId: string, scopes: readonly string[]): Promise<ListView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(listId)) return null;
  return withTenant(orgId, async (sql) => {
    const [l] = await sql<
      { id: string; file_name: string; state: ListState; scope_node_id: string; tower_ids: string[]; tower: string; columns: Column[]; purpose: string; goal: string | null; source: ListSource; read_by: "model" | "rules"; paused_reason: string | null; questions: ListQuestion[]; created_at: Date; started_at: Date | null }[]
    >`
      SELECT l.id, l.file_name, l.state, l.scope_node_id, l.tower_ids, n.name AS tower, l.columns, l.purpose, l.goal, l.source, l.read_by,
             l.paused_reason, l.questions, l.created_at, l.started_at
      FROM call_lists l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND l.id = ${listId} AND n.path <@ ANY(${scopes as string[]}::ltree[])`;
    if (!l) return null;
    const rows = await sql<
      { line: number; name: string | null; phone: string | null; language: Language; tower: string | null; note: string | null; goal: string | null; state: ListRowState; reason: string | null; lead_id: string | null; not_before: Date | null; window_from: string | null; window_to: string | null }[]
    >`
      SELECT r.line, r.name, r.phone, r.language,
             concat_ws(' · ', (SELECT p.name FROM scope_nodes p WHERE p.org_id = n.org_id AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1), n.name) AS tower, r.note, r.goal, r.state, r.reason, r.lead_id, r.not_before, r.window_from, r.window_to
      FROM call_list_rows r LEFT JOIN scope_nodes n ON n.id = r.scope_node_id
      WHERE r.org_id = ${orgId} AND r.list_id = ${listId}
      ORDER BY r.line`;
    return {
      id: l.id,
      fileName: l.file_name,
      state: l.state,
      tower: { id: l.scope_node_id, name: l.tower },
      towers: (await listTowersIn(sql, orgId, l.tower_ids.length ? l.tower_ids : [l.scope_node_id])).map((t) => ({ id: t.id, label: t.project ? `${t.project} · ${t.name}` : t.name })),
      columns: l.columns,
      purpose: l.purpose,
      goal: l.goal,
      source: l.source,
      readBy: l.read_by,
      pausedReason: l.paused_reason,
      questions: l.questions ?? [],
      createdAt: l.created_at.toISOString(),
      startedAt: l.started_at?.toISOString() ?? null,
      counts: countRows(rows),
      // Shown masked: the list is a plan, and a whole number on it is one copy too many.
      rows: rows.map((r) => ({ line: r.line, name: r.name, phone: r.phone ? maskPhone(r.phone) : null, language: r.language, tower: r.tower, note: r.note, goal: r.goal, state: r.state, reason: r.reason, leadId: r.lead_id, notBefore: r.not_before?.toISOString() ?? null, window: r.window_from && r.window_to ? { from: r.window_from, to: r.window_to } : null })),
    };
  });
}

export type ListSummary = { id: string; fileName: string; state: ListState; tower: string; createdAt: string; counts: ListCounts };

/** Recent lists, newest first. */
export async function listCallLists(orgId: string, scopes: readonly string[], limit = 20): Promise<ListSummary[]> {
  if (!scopes.length) return [];
  return withTenant(orgId, async (sql) => {
    const rows = await sql<{ id: string; file_name: string; state: ListState; tower: string; created_at: Date; states: ListRowState[] | null }[]>`
      SELECT l.id, l.file_name, l.state, l.created_at,
             CASE WHEN cardinality(l.tower_ids) > 1 THEN n.name || ' and ' || (cardinality(l.tower_ids) - 1) || ' more' ELSE n.name END AS tower,
             (SELECT array_agg(r.state) FROM call_list_rows r WHERE r.list_id = l.id) AS states
      FROM call_lists l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND n.path <@ ANY(${scopes as string[]}::ltree[])
      ORDER BY l.created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      state: r.state,
      tower: r.tower,
      createdAt: r.created_at.toISOString(),
      counts: countRows((r.states ?? []).map((state) => ({ state }))),
    }));
  });
}

type Act = { ok: true; message: string } | { ok: false; message: string };

/** The list's tower path, when this person may call there. */
async function listPlace(orgId: string, listId: string, authz: Pick<Authz, "canAt">): Promise<{ path: string; state: ListState } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(listId)) return null;
  const [l] = await withTenant(orgId, (sql) => sql<{ path: string; state: ListState }[]>`
    SELECT n.path::text AS path, l.state FROM call_lists l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${orgId} AND l.id = ${listId}`);
  if (!l || !authz.canAt("lead:call", l.path) || !authz.canAt("lead:create", l.path)) return null;
  return l;
}

/** Change the goal most calls on a list carry, before it starts. Empty means a plain first call. */
export async function saveListGoal(o: { orgId: string; userId: string; authz: Pick<Authz, "canAt">; listId: string; goal: string }): Promise<Act> {
  const l = await listPlace(o.orgId, o.listId, o.authz);
  if (!l) return { ok: false, message: "That list is not one you can call." };
  if (l.state !== "DRAFT") return { ok: false, message: "The list has started. Its calls keep the goal they started with." };
  const g = o.goal.replace(/\s+/g, " ").trim();
  if (g) {
    const why = goalProblem(g);
    if (why) return { ok: false, message: why };
  }
  await withTenant(o.orgId, (sql) => sql`
    UPDATE call_lists SET goal = ${g.slice(0, GOAL_MAX) || null}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${o.listId} AND state = 'DRAFT'`);
  return { ok: true, message: "Saved" };
}

/** Change who the list's people are, before it starts. */
export async function saveListSource(o: { orgId: string; userId: string; authz: Pick<Authz, "canAt">; listId: string; source: ListSource | null }): Promise<Act> {
  if (!o.source) return { ok: false, message: "Say whether these people enquired." };
  const l = await listPlace(o.orgId, o.listId, o.authz);
  if (!l) return { ok: false, message: "That list is not one you can call." };
  if (l.state !== "DRAFT") return { ok: false, message: "The list has started. Its calls keep what they started with." };
  await withTenant(o.orgId, (sql) => sql`
    UPDATE call_lists SET source = ${o.source}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${o.listId} AND state = 'DRAFT'`);
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "call_list.source_set", targetType: "call_list", targetId: o.listId, metadata: { source: o.source } });
  return { ok: true, message: "Saved" };
}

/**
 * Start calling. The person says everyone on it agreed to be contacted;
 * that is recorded for each number as its consent when the row is called.
 */
export async function startCallList(o: { orgId: string; userId: string; authz: Pick<Authz, "canAt">; listId: string; consent: boolean; developer: string }): Promise<Act> {
  if (!o.consent) return { ok: false, message: "Tick that everyone on the list agreed to be contacted." };
  const l = await listPlace(o.orgId, o.listId, o.authz);
  if (!l) return { ok: false, message: "That list is not one you can call." };
  const r = await withTenant(o.orgId, (sql) => sql`
    UPDATE call_lists SET state = 'RUNNING', started_by = ${o.userId}, started_at = now(), updated_at = now(),
           consent_wording = ${listConsentWording(o.developer)}, paused_reason = NULL
    WHERE org_id = ${o.orgId} AND id = ${o.listId} AND state = 'DRAFT'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(call_lists.questions) q
                      WHERE q->>'answer' IS NULL AND NOT COALESCE((q->>'skipped')::boolean, false))
      AND EXISTS (SELECT 1 FROM call_list_rows r WHERE r.list_id = call_lists.id AND r.state = 'READY')`);
  if (!r.count) {
    const [q] = await withTenant(o.orgId, (sql) => sql<{ questions: ListQuestion[] }[]>`SELECT questions FROM call_lists WHERE org_id = ${o.orgId} AND id = ${o.listId}`);
    if (l.state === "DRAFT" && openQuestions(q?.questions ?? []).length) return { ok: false, message: "Answer the questions about the list first." };
    return { ok: false, message: l.state === "DRAFT" ? "Nobody on the list can be called." : "The list has already started." };
  }
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "call_list.started", targetType: "call_list", targetId: o.listId, metadata: { consent: true } });
  return { ok: true, message: "Calling has started. A few people are rung at a time." };
}

/** Pause, carry on, or stop a list for good. */
export async function setListState(o: { orgId: string; userId: string; authz: Pick<Authz, "canAt">; listId: string; to: "PAUSED" | "RUNNING" | "CANCELLED" }): Promise<Act> {
  const l = await listPlace(o.orgId, o.listId, o.authz);
  if (!l) return { ok: false, message: "That list is not one you can call." };
  const from: ListState[] = o.to === "PAUSED" ? ["RUNNING"] : o.to === "RUNNING" ? ["PAUSED"] : ["DRAFT", "RUNNING", "PAUSED"];
  const done = await withTenant(o.orgId, async (sql) => {
    const r = await sql`
      UPDATE call_lists SET state = ${o.to}, paused_reason = NULL, updated_at = now(),
             finished_at = ${o.to === "CANCELLED" ? sql`now()` : sql`finished_at`}
      WHERE org_id = ${o.orgId} AND id = ${o.listId} AND state = ANY(${from})`;
    if (r.count && o.to === "CANCELLED") {
      await sql`
        UPDATE call_list_rows SET state = 'SKIPPED', reason = 'The list was stopped', lease_until = NULL, updated_at = now()
        WHERE org_id = ${o.orgId} AND list_id = ${o.listId} AND state = 'READY'`;
    }
    return r.count > 0;
  });
  if (!done) return { ok: false, message: "The list has moved on since. Refresh the page." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: `call_list.${o.to.toLowerCase()}`, targetType: "call_list", targetId: o.listId });
  return { ok: true, message: o.to === "PAUSED" ? "Paused. Calls already ringing finish." : o.to === "RUNNING" ? "Calling again." : "Stopped. Nobody else on it is called." };
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

type DueRow = { id: string; tower_ids: string[]; window_from: string | null; window_to: string | null; list_id: string; line: number; scope_node_id: string | null; name: string | null; phone: string | null; language: Language; goal: string | null; enquired: boolean | null; lead_id: string | null; call_id: string | null; tries: number; list_goal: string | null; list_source: ListSource; started_by: string | null; consent_wording: string | null; file_name: string; list_tower: string };

/**
 * One pass over every running list: settle the calls that ended, then ring
 * the next people, as many at once as the project has free lines. Safe to run twice at
 * once; a row is leased before it is called.
 */
export async function runCallLists(nowIso = new Date().toISOString()): Promise<{ placed: number; settled: number }> {
  // Listing tenants is the worker's control-plane act; each is worked inside its own.
  const orgs = await controlDb<{ id: string }[]>`SELECT id FROM orgs WHERE status <> 'SUSPENDED' ORDER BY created_at`;
  const total = { placed: 0, settled: 0 };
  for (const org of orgs) {
    const r = await runOrgLists(org.id, nowIso).catch((e) => {
      console.error("call lists:", e instanceof Error ? e.message : e);
      return { placed: 0, settled: 0 };
    });
    total.placed += r.placed;
    total.settled += r.settled;
  }
  return total;
}

async function runOrgLists(orgId: string, nowIso: string): Promise<{ placed: number; settled: number }> {
  const out = { placed: 0, settled: 0 };
  // Drafts nobody started are cleared out.
  await withTenant(orgId, (sql) => sql`
    DELETE FROM call_lists WHERE org_id = ${orgId} AND state = 'DRAFT' AND created_at < ${new Date(Date.parse(nowIso) - DRAFT_DAYS * 86_400_000)}`);
  const lists = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    SELECT id FROM call_lists WHERE org_id = ${orgId} AND state IN ('RUNNING', 'PAUSED')`);
  for (const l of lists) {
    out.settled += await settleListCalls(orgId, l.id, nowIso);
    out.placed += await ringNext(orgId, l.id, nowIso);
  }
  return out;
}

/** Rows whose call has ended: spoke, try again later, or no answer after every try. */
async function settleListCalls(orgId: string, listId: string, nowIso: string): Promise<number> {
  return withTenant(orgId, async (sql) => {
    const ended = await sql<{ id: string; tries: number; status: string; connectivity: string | null; outcome: string | null }[]>`
      SELECT r.id, r.tries, c.status, c.connectivity, c.outcome
      FROM call_list_rows r JOIN calls c ON c.id = r.call_id
      WHERE r.org_id = ${orgId} AND r.list_id = ${listId} AND r.state = 'CALLING' AND c.status IN ('DONE', 'REFUSED')`;
    for (const e of ended) {
      const next = afterListCall({ connectivity: e.status === "REFUSED" ? null : e.connectivity, tries: e.tries, nowIso });
      await sql`
        UPDATE call_list_rows SET state = ${next.state}, not_before = ${next.notBefore ? new Date(next.notBefore) : null},
               reason = ${listRowReason({ state: next.state, tries: e.tries, outcomeLabel: e.status === "REFUSED" ? "Not placed" : OUTCOME[e.outcome as Outcome]?.label ?? null })},
               lease_until = NULL, updated_at = now()
        WHERE id = ${e.id} AND state = 'CALLING'`;
    }
    // A list with nobody left to ring or waiting on a call is finished.
    await sql`
      UPDATE call_lists SET state = 'DONE', finished_at = now(), updated_at = now()
      WHERE org_id = ${orgId} AND id = ${listId} AND state = 'RUNNING'
        AND NOT EXISTS (SELECT 1 FROM call_list_rows r WHERE r.list_id = ${listId} AND r.state IN ('READY', 'CALLING'))`;
    return ended.length;
  });
}

/** Ring the next people on a running list, up to its free lines. */
/**
 * Ring the next people on a running list, filling every free line at once:
 * the project's lines (its plan's channels) less the calls already ringing
 * there, list or not. Each round claims that many people and places their
 * calls together; `placeCall()` still holds each to the lines under its own
 * lock, so a line taken meanwhile is a BUSY that waits for the next pass.
 */
async function ringNext(orgId: string, listId: string, nowIso: string): Promise<number> {
  const [head] = await withTenant(orgId, (sql) => sql<{ scope_node_id: string; project_path: string | null }[]>`
    SELECT l.scope_node_id,
           (SELECT p.path::text FROM scope_nodes p WHERE p.org_id = l.org_id AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project_path
    FROM call_lists l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${orgId} AND l.id = ${listId}`);
  if (!head) return 0;
  const lines = Math.min(LIST_MAX_LINES, await callLines(orgId, head.scope_node_id).catch(() => 1));
  let placed = 0;
  for (let round = 0; round < LIST_MAX_LINES * 2; round += 1) {
    const rows = await withTenant(orgId, async (sql) => {
      const [l] = await sql<{ state: ListState; live: number }[]>`
        SELECT state,
               (SELECT count(*)::int FROM calls c JOIN scope_nodes n ON n.id = c.scope_node_id
                 WHERE c.org_id = ${orgId} AND c.status IN ('PLACING', 'DIALLING')
                   AND c.placed_at > ${new Date(Date.parse(nowIso) - 30 * 60_000)}
                   AND ${head.project_path ? sql`n.path <@ ${head.project_path}::ltree` : sql`c.scope_node_id = ${head.scope_node_id}`}) AS live
        FROM call_lists WHERE org_id = ${orgId} AND id = ${listId}`;
      const free = l && l.state === "RUNNING" ? lines - l.live : 0;
      if (free <= 0) return [];
      return sql<DueRow[]>`
        UPDATE call_list_rows r SET lease_until = ${new Date(Date.parse(nowIso) + 3 * 60_000)}
        FROM call_lists l, scope_nodes n
        WHERE r.id IN (
            SELECT id FROM call_list_rows
            WHERE org_id = ${orgId} AND list_id = ${listId} AND state = 'READY'
              AND (not_before IS NULL OR not_before <= ${new Date(nowIso)})
              AND (lease_until IS NULL OR lease_until < ${new Date(nowIso)})
            ORDER BY line LIMIT ${free} FOR UPDATE SKIP LOCKED)
          AND l.id = r.list_id AND n.id = l.scope_node_id
        RETURNING r.id, l.tower_ids, r.window_from, r.window_to, r.list_id, r.line, r.scope_node_id, r.name, r.phone, r.language, r.goal, r.enquired, r.lead_id, r.call_id, r.tries,
                  l.goal AS list_goal, l.source AS list_source, l.started_by, l.consent_wording, l.file_name, n.name AS list_tower`;
    });
    if (!rows.length) return placed;
    const results = await Promise.all(rows.sort((a, b) => a.line - b.line).map((r) => ringOne(orgId, r, nowIso)));
    placed += results.filter((x) => x === "placed").length;
    if (results.includes("stop")) return placed;
  }
  return placed;
}

async function ringOne(orgId: string, r: DueRow, nowIso: string): Promise<"placed" | "next" | "stop"> {
  const finish = (state: ListRowState, reason: string | null, extra: { leadId?: string | null } = {}) =>
    withTenant(orgId, (sql) => sql`
      UPDATE call_list_rows SET state = ${state}, reason = ${reason?.slice(0, 300) ?? null}, lease_until = NULL, updated_at = now(),
             lead_id = COALESCE(${extra.leadId ?? null}, lead_id)
      WHERE id = ${r.id}`);
  const release = (leadId: string | null = null) => withTenant(orgId, (sql) => sql`
    UPDATE call_list_rows SET lease_until = NULL, lead_id = COALESCE(${leadId}, lead_id), updated_at = now() WHERE id = ${r.id}`);
  const pause = (why: string) => withTenant(orgId, (sql) => sql`
    UPDATE call_lists SET state = 'PAUSED', paused_reason = ${why.slice(0, 300)}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${r.list_id} AND state = 'RUNNING'`);

  // A person rung only in certain hours waits for them, on every try.
  const wait = windowWait(r.window_from && r.window_to ? { from: r.window_from, to: r.window_to } : null, nowIso);
  if (wait) {
    await withTenant(orgId, (sql) => sql`
      UPDATE call_list_rows SET lease_until = NULL, not_before = ${new Date(wait)}, updated_at = now() WHERE id = ${r.id}`);
    return "next";
  }
  if (!r.started_by || !r.phone || !r.name || !r.scope_node_id) {
    await finish("REFUSED", "The row lost its name, number or tower");
    return "next";
  }
  // The person becomes a lead the way any lead does: junk refused, a booked
  // buyer left alone, an open lead of the same number is the same lead.
  let leadId = r.lead_id;
  if (!leadId) {
    const added = await addLeadByHand({
      orgId,
      userId: r.started_by,
      name: r.name,
      phone: r.phone,
      phaseId: r.scope_node_id,
      source: `Call list`,
      language: r.language,
      consentWording: r.consent_wording,
      consentSource: "Call list",
      addedAs: `From call list ${r.file_name}`,
      nowIso,
    });
    if (!added.ok) {
      await finish("REFUSED", added.message, { leadId: added.lead?.id ?? null });
      return "next";
    }
    leadId = added.lead.id;
  } else {
    // A try after the first: what happened to the lead since the list last rang.
    const [s] = await withTenant(orgId, (sql) => sql<{ stage: string; erased: boolean; spoke: boolean; last: Date | null }[]>`
      SELECT l.stage, l.erased_at IS NOT NULL AS erased,
             EXISTS (SELECT 1 FROM calls c WHERE c.org_id = l.org_id AND c.lead_id = l.id AND c.connectivity = 'connected'
                       AND c.placed_at > COALESCE((SELECT placed_at FROM calls WHERE id = ${r.call_id ?? null}::uuid), 'epoch')) AS spoke,
             (SELECT max(c.placed_at) FROM calls c WHERE c.org_id = l.org_id AND c.lead_id = l.id) AS last
      FROM leads l WHERE l.org_id = ${orgId} AND l.id = ${leadId}`);
    const v = s ? listRetry({ stage: s.stage, erased: s.erased, spokeSince: s.spoke, lastCallIso: s.last?.toISOString() ?? null, nowIso }) : null;
    if (v?.state === "WAIT") {
      await withTenant(orgId, (sql) => sql`
        UPDATE call_list_rows SET lease_until = NULL, not_before = ${new Date(v.notBefore)}, updated_at = now() WHERE id = ${r.id}`);
      return "next";
    }
    if (v) {
      await finish(v.state, v.reason);
      return "next";
    }
  }
  const enquired = mayCallEnquired(r.enquired, r.list_source);
  const text = r.goal ?? r.list_goal ?? (enquired ? null : COLD_GOAL);
  const call = await placeCall({
    orgId,
    userId: r.started_by,
    leadId,
    nowIso,
    goal: text ? { key: "custom", text } : null,
    // Only a sheet that says this person enquired lets the agent say so.
    enquired,
    nodeId: r.scope_node_id,
    // The list's other towers, offered when this one does not suit.
    alsoPitch: r.tower_ids.filter((id) => id !== r.scope_node_id),
  });
  if (call.ok) {
    await withTenant(orgId, (sql) => sql`
      UPDATE call_list_rows SET state = 'CALLING', call_id = ${call.callId}, lead_id = ${leadId}, tries = tries + 1,
             reason = NULL, lease_until = NULL, updated_at = now()
      WHERE id = ${r.id}`);
    return "placed";
  }
  if ((LIST_WAITERS as readonly string[]).includes(call.code)) {
    await release(leadId);
    return "stop";
  }
  // A tower that stopped being advertisable stops only its own people when the list offers others.
  if (call.code === "NOT_ADVERTISABLE" && r.tower_ids.length > 1) {
    await finish("REFUSED", call.message, { leadId });
    return "next";
  }
  if ((LIST_STOPPERS as readonly string[]).includes(call.code)) {
    await release(leadId);
    await pause(call.message);
    return "stop";
  }
  await finish("REFUSED", call.message, { leadId });
  return "next";
}
