/**
 * Ask Jimmy: reading, writing, and the two model calls.
 *
 * `ask-rules.ts` is the pure half: the data map, the planner, the SQL, the
 * number check. This file runs it. Three rules it holds:
 *
 *   1. Nothing is read outside the person's reach. Every query carries the
 *      scopes their keys hold (`scopesFor`), runs inside `withTenant`'s RLS,
 *      and runs read-only with a statement timeout. A chat is readable only by
 *      the person who asked it (`withPerson`, 0030).
 *   2. The allowance is checked before either model is called, and every
 *      model call is capped in dollars by `runAgent` (MAX_QUESTION_USD).
 *   3. One connection at a time per tool call. Computed datasets are loaded
 *      before the read-only transaction opens, never inside it, because a
 *      transaction waiting on a second connection can starve the pool, and
 *      the database allows twenty.
 *
 * Imports are relative because the checks load this straight from source.
 */

import { audit, withPerson, withTenant, withTenantReadOnly } from "./db/index.ts";
import { limitsLifted } from "./plan-purchase-rules.ts";
import { meterQuestion } from "./billing.ts";
import { isPlanKey, readTerms } from "./billing-rules.ts";
import { runAgent, type AgentTool, type ToolOutcome } from "./agent.ts";
import type { AgentBrain } from "./generate.ts";
import { argNumber, argString, argStrings, USD_TO_RS } from "./agent-rules.ts";
import { loadReadiness } from "./readiness.ts";
import { approvedUnits } from "./unit.ts";
import { priceFor } from "./unit-rules.ts";
import { resolveBrain } from "./brain.ts";
import { asList, BRAIN_FIELDS } from "./brain-rules.ts";
import { istCivil, slotsBetween } from "./post-rules.ts";
import { actionCatalog, actionsLacked, actionsOn, actionViews, chatMemory, NOT_THROUGH_JIMMY, startAction } from "./ask-actions.ts";
import { cardMemory, neverThroughJimmy, startsWithAction, type ActionView } from "./ask-actions-rules.ts";
import { filesNamed, readSetup, setupView, setupViews, startSetup } from "./setup.ts";
import { SETUP_MAX_FILES, setupMemory, type SetupView } from "./setup-rules.ts";
import { forgetChat, keepSummary, memoryStore, recall, remember, type ChatKey, type MemoryTurn } from "./ask-memory.ts";
import { transcribe } from "./stt.ts";
import { isServiceDown } from "./service-rules.ts";
import {
  bestRecords,
  FIND_PAGE_SCHEMA,
  HELP_SCHEMA,
  helpCatalog,
  helpInstructions,
  helpLinks,
  pageHref,
  pageLabel,
  siblingPages,
  quotedOutsideMap,
  screenIndex,
  screensFor,
  screensNamedIn,
  wantsLink,
  type PageRecord,
  type Screen,
} from "./ask-help.ts";
import {
  cleanTranscript,
  LISTEN_SPEAKER,
  listenLanguage,
  listenUsd,
  overListenAllowance,
  overVoiceAllowance,
  spokenAnswer,
  voiceFileName,
  voiceProblem,
  voiceType,
  voiceUsd,
} from "./ask-voice-rules.ts";
import { speak, type SpeakDriver } from "./generate.ts";
import { rupees } from "./lead-rules.ts";
import { scopeCovers, type Authz } from "./rbac-rules.ts";
import {
  accessibleTopics,
  aggregateComputed,
  aggregateSql,
  analystInstructions,
  ANSWER_SCHEMA,
  answerCheck,
  ASK_PERSON_SCHEMA,
  PROPOSE_SCHEMA,
  questionLanguage,
  catalogText,
  CHAT_DAYS,
  COMPUTE_SCHEMA,
  DAILY_QUESTIONS,
  datasetByKey,
  deniedLine,
  evaluate,
  moneyIn,
  numbersIn,
  greetingLine,
  HISTORY_EXCHANGES,
  ROUTER_HISTORY,
  SUMMARY_MAX_USD,
  SUMMARY_SCHEMA,
  cleanSummary,
  summaryInstructions,
  summaryTask,
  linksFor,
  LIST_SCHEMA,
  listComputed,
  listSql,
  MAX_ANALYST_TURNS,
  MAX_QUESTION_CHARS,
  tidyQuestion,
  MAX_QUESTION_USD,
  mergeParts,
  NO_BLOCKS,
  notBuiltLine,
  offTopicLine,
  overAllowance,
  throughMandate,
  placeLabel,
  planAggregate,
  planList,
  QUERY_SCHEMA,
  resolvePlaces,
  ROUTE_KINDS,
  ROUTE_SCHEMA,
  ROUTER_MAX_USD,
  routerInstructions,
  shapeAggregate,
  shapeList,
  showDay,
  selfFilters,
  widened,
  splitTopics,
  withoutIncidental,
  startersFor,
  strayPlaceOptions,
  taskText,
  titleFrom,
  topicByKey,
  visibleFor,
  withoutDashes,
  plainWords,
  type AskTable,
  ACTION_LINE,
  type AggregateSpec,
  type AnswerStatus,
  type AskBlocks,
  type ComputedRow,
  type Filter,
  type ListSpec,
  type Period,
  type PlaceNode,
  type Range,
  type Row,
  type RouteKind,
  type Shaped,
  type TopicKey,
} from "./ask-rules.ts";

/** Small and current. The number check makes an answer safe, not the model. */
export const ASK_MODEL = (): string => (process.env.ASK_MODEL ?? "").trim() || "gpt-5-mini";
export const ROUTER_MODEL = (): string => (process.env.ASK_ROUTER_MODEL ?? "").trim() || "gpt-5-mini";
export const SUMMARY_MODEL = (): string => (process.env.ASK_SUMMARY_MODEL ?? "").trim() || "gpt-5-mini";

export type AskOutcome = "ANSWERED" | "CLARIFY" | "UNANSWERED" | "REFUSED" | "LIMIT" | "FAILED" | "STOPPED";

export type AskMessage = {
  id: string;
  role: "PERSON" | "JIMMY";
  body: string;
  blocks: AskBlocks;
  outcome: AskOutcome | null;
  createdAt: string;
  /** The action card this message opened, as it stands now. */
  action?: ActionView | null;
  /** The project setup this message started, as it stands now. */
  setup?: SetupView | null;
};

export type AskMeta = {
  kind: RouteKind | "limit" | null;
  topics: TopicKey[];
  denied: TopicKey[];
  notBuilt: TopicKey[];
  /** Tool names and datasets, in order. Never the rows. */
  tools: string[];
  model: string | null;
  turns: number;
  usd: number;
  partial?: boolean;
};

export type Answer = { outcome: AskOutcome; body: string; blocks: AskBlocks; meta: AskMeta; actionView?: ActionView | null };

export type AskDrivers = { brain?: AgentBrain };

// ---------------------------------------------------------------------------
// Places and computed datasets
// ---------------------------------------------------------------------------

export async function loadPlaces(orgId: string): Promise<PlaceNode[]> {
  const rows = await withTenantReadOnly(orgId, (sql) => sql<
    { id: string; kind: "PROJECT" | "PHASE"; name: string; slug: string; path: string; project_id: string | null; project_name: string | null }[]
  >`
    SELECT n.id, n.kind, n.name, n.slug, n.path::text AS path, pj.id AS project_id, pj.name AS project_name
    FROM scope_nodes n
    LEFT JOIN scope_nodes pj ON pj.org_id = n.org_id AND pj.kind = 'PROJECT' AND n.path <@ pj.path
    WHERE n.org_id = ${orgId} AND n.kind IN ('PROJECT', 'PHASE')
    ORDER BY n.path`);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    slug: r.slug,
    path: r.path,
    projectId: r.project_id,
    projectName: r.kind === "PHASE" ? r.project_name : r.name,
  }));
}

/** Said back to the analyst when a widening question dropped the places it carried, so its words match the numbers. */
const droppedNote = (asked: string[], kept: string[]) => {
  const gone = asked.filter((p) => !kept.includes(p));
  return gone.length ? `\n(${gone.join(", ")} left out: the question asks for the total across every place. Say so, and do not name ${gone.join(" or ")}.)` : "";
};

const inReach = (path: string, scopeSets: readonly string[][]) => scopeSets.every((s) => s.some((p) => scopeCovers(p, path)));

/** Runs `fn` over `items`, `limit` at a time: each is a round trip, and the pool is shared. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

type LoadCtx = { orgId: string; now: Date; range: Range | null; scopeSets: string[][]; places: () => Promise<PlaceNode[]> };

/**
 * The posts a schedule will make, which exist as rows only once a run has
 * been created a day or so ahead. Past and near slots come from `post_runs`;
 * later ones are worked out from the cadence with `slotsBetween()`, the same
 * arithmetic the runner uses, so "what goes out on Friday" is answered before
 * Friday's run exists.
 */
async function loadScheduledPosts(ctx: LoadCtx): Promise<ComputedRow[]> {
  const day = 86_400_000;
  const range = ctx.range ?? { from: new Date(ctx.now.getTime() - 90 * day), to: new Date(ctx.now.getTime() + 30 * day) };
  const { schedules, runs } = await withTenantReadOnly(ctx.orgId, async (sql) => {
    const schedules = await sql<
      {
        id: string;
        name: string;
        days_of_week: number[];
        at_minute: number;
        starts_on: string | null;
        ends_on: string | null;
        active: boolean;
        day_kinds: (string | null)[] | null;
        destinations: string[];
        brief_id: string;
        brief_name: string;
        path: string;
        kind: string;
        node_name: string;
        project_name: string | null;
      }[]
    >`
      SELECT psc.id, psc.name, psc.days_of_week, psc.at_minute,
             to_char(psc.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(psc.ends_on, 'YYYY-MM-DD') AS ends_on,
             psc.active, psc.day_kinds, psc.destinations,
             b.id AS brief_id, b.name AS brief_name, n.path::text AS path, n.kind, n.name AS node_name, pj.name AS project_name
      FROM post_schedules psc
      JOIN campaign_briefs b ON b.id = psc.brief_id
      JOIN scope_nodes n ON n.id = psc.scope_node_id
      LEFT JOIN scope_nodes pj ON pj.org_id = n.org_id AND pj.kind = 'PROJECT' AND n.path <@ pj.path
      WHERE psc.org_id = ${ctx.orgId}`;
    const runs = await sql<{ schedule_id: string; slot: Date; state: string; waiting: number; approved: number }[]>`
      SELECT prn.schedule_id, prn.slot, prn.state,
             (SELECT count(*)::int FROM post_creatives c WHERE c.run_id = prn.id AND c.state = 'DRAFT' AND c.verdict <> 'FAIL') AS waiting,
             (SELECT count(*)::int FROM post_creatives c WHERE c.run_id = prn.id AND c.state IN ('APPROVED', 'PUBLISHED')) AS approved
      FROM post_runs prn
      WHERE prn.org_id = ${ctx.orgId} AND prn.slot >= ${range.from} AND prn.slot < ${range.to}`;
    return { schedules, runs };
  });

  const DEST: Record<string, string> = { FACEBOOK_PAGE: "Facebook", INSTAGRAM: "Instagram", GOOGLE_BUSINESS: "Google Business" };
  const out: ComputedRow[] = [];
  const bySchedule = new Map(schedules.map((s) => [s.id, s]));
  const row = (s: (typeof schedules)[number], slot: Date, state: string, waiting: number, approved: number): ComputedRow => {
    const dow = istCivil(slot).dow;
    return {
      _path: s.path,
      _time: slot,
      _id: s.brief_id,
      project: s.kind === "PROJECT" ? s.node_name : s.project_name,
      tower: s.kind === "PHASE" ? `${s.project_name ? `${s.project_name} · ` : ""}${s.node_name}` : null,
      place: s.kind === "PHASE" && s.project_name ? `${s.project_name} · ${s.node_name}` : s.node_name,
      campaign: s.brief_name,
      schedule: s.name,
      kind: s.day_kinds?.[dow] ?? "IMAGE",
      state,
      destinations: s.destinations.length ? s.destinations.map((d) => DEST[d] ?? d).join(", ") : "Download only",
      waiting,
      approved,
    };
  };
  const taken = new Set<string>();
  for (const r of runs) {
    const s = bySchedule.get(r.schedule_id);
    if (!s || !inReach(s.path, ctx.scopeSets)) continue;
    taken.add(`${r.schedule_id}:${new Date(r.slot).getTime()}`);
    out.push(row(s, new Date(r.slot), r.state, Number(r.waiting), Number(r.approved)));
  }
  const from = new Date(Math.max(range.from.getTime(), ctx.now.getTime()) - 1);
  const to = new Date(range.to.getTime() - 1);
  for (const s of schedules) {
    if (!s.active || !inReach(s.path, ctx.scopeSets)) continue;
    const slots = slotsBetween(
      { daysOfWeek: s.days_of_week, atMinute: s.at_minute, startsOn: s.starts_on, endsOn: s.ends_on },
      { from, to },
    );
    for (const slot of slots) {
      if (taken.has(`${s.id}:${slot.getTime()}`)) continue;
      out.push(row(s, slot, "PLANNED", 0, 0));
    }
  }
  return out;
}

async function loadTowers(ctx: LoadCtx): Promise<ComputedRow[]> {
  const phases = await loadReadiness(ctx.orgId);
  return phases
    .filter((p) => inReach(p.path, ctx.scopeSets))
    .map((p) => ({
      _path: p.path,
      _id: p.projectId,
      project: p.projectName,
      tower: `${p.projectName} · ${p.phaseName}`,
      advertisable: p.blocked ? "NO" : "YES",
      registration: p.blocked ? "BLOCKED" : p.registrationNo ? "REGISTERED" : "EXEMPT",
      registration_no: p.registrationNo ?? (p.blocked ? null : "Exempt"),
      days_left: p.daysLeft,
      steps_done: `${p.done} of ${p.total}`,
      next_step: p.next?.label ?? "Nothing left",
      why: p.blocked ? p.why : null,
      ready: p.ready,
    }));
}

async function loadPrices(ctx: LoadCtx): Promise<ComputedRow[]> {
  const phases = (await ctx.places()).filter((n) => n.kind === "PHASE" && inReach(n.path, ctx.scopeSets));
  const lists = await mapLimit(phases, 3, async (ph) => {
    const { units, basePsf } = await approvedUnits(ctx.orgId, ph.id);
    return units
      .filter((u) => u.nodeId === ph.id)
      .map((u) => ({
        _path: ph.path,
        project: ph.projectName,
        tower: placeLabel(ph),
        configuration: u.label,
        carpet: u.carpetAreaSqft,
        price: priceFor(u, basePsf),
      }));
  });
  return lists.flat();
}

/** A signed fact the way a person reads it: money grouped, a date as a day, a list on one line. */
function factValue(type: string, raw: string): string {
  if (type === "MONEY") {
    const n = Number(String(raw).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? rupees(n) : raw;
  }
  if (type === "DATE") return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? showDay(raw, new Date(0)) : raw;
  if (type === "LIST") return asList(raw).join("; ");
  return raw;
}

async function loadFacts(ctx: LoadCtx): Promise<ComputedRow[]> {
  const nodes = (await ctx.places()).filter((n) => inReach(n.path, ctx.scopeSets));
  const lists = await mapLimit(nodes, 3, async (node) => {
    const brain = await resolveBrain(ctx.orgId, node.id);
    if (!brain) return [];
    return BRAIN_FIELDS.filter((f) => f.key !== "rera.qr_url")
      .map((f) => ({ f, raw: brain.values[f.key] }))
      .filter((x): x is { f: (typeof BRAIN_FIELDS)[number]; raw: string } => typeof x.raw === "string" && x.raw.trim() !== "")
      .map(({ f, raw }) => ({
        _path: node.path,
        project: node.projectName,
        tower: node.kind === "PHASE" ? placeLabel(node) : null,
        place: placeLabel(node),
        fact: f.label,
        value: factValue(f.type, raw.trim()).slice(0, 300),
      }));
  });
  return lists.flat();
}

/**
 * A channel partner's own work with developers. Its registrations and
 * brokerage with a developer on Sales Desk are rows in that developer's
 * tenant, read through the partner's own screens' function (`partnerWork()`,
 * filtered to the partner); with a developer not on Sales Desk they are the
 * partner's own rows (`outsideWork()`). A developer's row sits on the
 * partner's root, an outside one on its project, so scope reads them as the
 * screens do. No phone number leaves here.
 */
const istMidnight = (day: string | null | undefined): Date | null => (day ? new Date(`${day.slice(0, 10)}T00:00:00+05:30`) : null);

async function rootPath(orgId: string): Promise<string | null> {
  const [r] = await withTenantReadOnly(orgId, (sql) => sql<{ path: string }[]>`
    SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`);
  return r?.path ?? null;
}

async function outsidePaths(orgId: string): Promise<Map<string, string>> {
  const rows = await withTenantReadOnly(orgId, (sql) => sql<{ name: string; entity: string; path: string }[]>`
    SELECT p.name, e.name AS entity, p.path::text AS path
    FROM scope_nodes p JOIN scope_nodes e ON e.org_id = p.org_id AND e.kind = 'ENTITY' AND p.path <@ e.path
    WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT'`);
  return new Map(rows.map((r) => [`${r.entity}|${r.name}`, r.path]));
}

const REG_STATE: Record<string, string> = { live: "REGISTERED", lapsing: "ENDING", visited: "VISITED", booked: "BOOKED", lapsed: "RAN_OUT", refused: "REFUSED" };
const OUTSIDE_REG_STATE: Record<string, string> = {
  sent: "REGISTERED",
  confirmed: "REGISTERED",
  ending: "ENDING",
  booked: "BOOKED",
  lapsed: "RAN_OUT",
  refused: "REFUSED",
  withdrawn: "WITHDRAWN",
};

async function loadMyRegistrations(ctx: LoadCtx): Promise<ComputedRow[]> {
  const [{ partnerWork }, { outsideWork }, { regState, validUntil }, { refusedWhy }, { longDay }] = await Promise.all([
    import("./partner-workspace.ts"),
    import("./outside.ts"),
    import("./partner-rules.ts"),
    import("./partner-workspace-rules.ts"),
    import("./mandate-rules.ts"),
  ]);
  const today = new Date(ctx.now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const [root, work, outside, paths] = await Promise.all([rootPath(ctx.orgId), partnerWork(ctx.orgId), outsideWork(ctx.orgId, today), outsidePaths(ctx.orgId)]);
  if (!root) return [];
  const out: ComputedRow[] = [];
  for (const b of work.buyers) {
    const state = REG_STATE[regState(b, today)] ?? null;
    out.push({
      _path: root,
      _time: istMidnight(b.registeredOn),
      buyer: b.buyer,
      developer: b.developer,
      project: b.project,
      how: "SALESDESK",
      state,
      live: state === "REGISTERED" || state === "ENDING" || state === "VISITED",
      visited: !!b.visitedOn,
      registered_on: b.registeredOn,
      runs_to: b.refused ? null : validUntil(b),
      visited_on: b.visitedOn,
      why: b.refused ? refusedWhy(b.refused.reason, b.refused.heldUntil, longDay) : null,
    });
  }
  for (const r of outside.registrations) {
    const state = OUTSIDE_REG_STATE[r.state];
    if (!state) continue; // an erased buyer is nobody's to count
    out.push({
      _path: paths.get(`${r.developer}|${r.project}`) ?? root,
      _time: istMidnight(r.sentOn),
      buyer: r.buyer,
      developer: r.developer,
      project: r.project,
      how: "EMAIL",
      state,
      live: state === "REGISTERED" || state === "ENDING",
      visited: false,
      registered_on: r.sentOn,
      runs_to: r.validUntil,
      visited_on: null,
      why: null,
    });
  }
  return out.filter((r) => inReach(r._path, ctx.scopeSets));
}

const HALF_STATE: Record<string, string> = {
  held: "NOT_DUE",
  no_invoice: "SEND_INVOICE",
  verify: "WITH_DEVELOPER",
  approve: "BEING_APPROVED",
  approved: "APPROVED",
  paid: "PAID",
  void: "CANCELLED",
};

async function loadMyBrokerage(ctx: LoadCtx): Promise<ComputedRow[]> {
  const [{ partnerWork }, { outsideWork }, { ladder, isOwed, netAfterAdjustments }] = await Promise.all([
    import("./partner-workspace.ts"),
    import("./outside.ts"),
    import("./partner-rules.ts"),
  ]);
  const today = new Date(ctx.now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const [root, work, outside, paths] = await Promise.all([rootPath(ctx.orgId), partnerWork(ctx.orgId), outsideWork(ctx.orgId, today), outsidePaths(ctx.orgId)]);
  if (!root) return [];
  const out: ComputedRow[] = [];
  for (const b of work.bookings) {
    ladder(b).forEach((r, i) => {
      const amount = netAfterAdjustments(b, r.key, r.invoice.net);
      out.push({
        _path: root,
        _time: istMidnight(b.bookedOn),
        buyer: b.buyer,
        developer: b.developer,
        project: b.place,
        unit: b.unit || null,
        half: r.key === "M1" ? "First half" : "Second half",
        state: HALF_STATE[r.state] ?? null,
        amount,
        owed_amount: isOwed(r) ? amount : 0,
        paid_amount: r.state === "paid" ? amount : 0,
        // One booking, two halves: the first carries it.
        booking: i === 0 && !b.cancelled ? 1 : 0,
        booked_on: b.bookedOn,
        paid_on: r.state === "paid" ? r.paidOn ?? null : null,
      });
    });
  }
  for (const b of outside.bookings) {
    const inv = b.invoice;
    const state = b.cancelled ? "CANCELLED" : !inv ? "SEND_INVOICE" : inv.paidOn ? "PAID" : "WITH_DEVELOPER";
    const amount = inv ? Math.round((inv.paidOn && inv.paid !== null ? inv.paid : inv.total - inv.tds) / 100) : Math.round(b.brokerage / 100);
    out.push({
      _path: paths.get(`${b.developer}|${b.project}`) ?? root,
      _time: istMidnight(b.bookedOn),
      buyer: b.buyer,
      developer: b.developer,
      project: b.project,
      unit: b.unit,
      half: "Whole",
      state,
      amount,
      owed_amount: state === "SEND_INVOICE" || state === "WITH_DEVELOPER" ? amount : 0,
      paid_amount: state === "PAID" ? amount : 0,
      booking: b.cancelled ? 0 : 1,
      booked_on: b.bookedOn,
      paid_on: inv?.paidOn ?? null,
    });
  }
  return out.filter((r) => inReach(r._path, ctx.scopeSets));
}

/** A mandate firm's own commission, as its Developers screen reads it (`firmCommission()`, `halfState()`). */
async function loadMyCommission(ctx: LoadCtx): Promise<ComputedRow[]> {
  const [{ firmCommission }, { halfState }] = await Promise.all([import("./firm-workspace.ts"), import("./mandate-rules.ts")]);
  const [root, rows] = await Promise.all([rootPath(ctx.orgId), firmCommission(ctx.orgId)]);
  if (!root) return [];
  const STATE: Record<string, string> = {
    not_due: "NOT_DUE",
    send_invoice: "SEND_INVOICE",
    with_developer: "WITH_DEVELOPER",
    approved: "APPROVED",
    paid: "PAID",
    cancelled: "CANCELLED",
  };
  const out: ComputedRow[] = [];
  for (const b of rows) {
    b.halves.forEach((h, i) => {
      const s = halfState(h, b.cancelled);
      out.push({
        _path: root,
        _time: istMidnight(b.bookedOn),
        buyer: b.buyer,
        developer: b.developer,
        project: b.project,
        unit: b.unit,
        half: h.key === "M1" ? "First half" : "Second half",
        state: STATE[s] ?? null,
        amount: h.net,
        owed_amount: s === "send_invoice" || s === "with_developer" || s === "approved" ? h.net : 0,
        paid_amount: s === "paid" ? h.net : 0,
        // One booking, two halves: the first carries it.
        booking: i === 0 && !b.cancelled ? 1 : 0,
        booked_on: b.bookedOn,
        paid_on: s === "paid" ? h.paidOn : null,
      });
    });
  }
  return out.filter((r) => inReach(r._path, ctx.scopeSets));
}

const LOADERS: Record<string, (ctx: LoadCtx) => Promise<ComputedRow[]>> = {
  my_registrations: loadMyRegistrations,
  my_brokerage: loadMyBrokerage,
  my_commission: loadMyCommission,
  scheduled_posts: loadScheduledPosts,
  towers: loadTowers,
  prices: loadPrices,
  facts: loadFacts,
};

// ---------------------------------------------------------------------------
// Reading tool arguments. The schema is strict; the reading is defensive anyway.
// ---------------------------------------------------------------------------

function argFilters(args: unknown): Filter[] {
  const raw = (args as { filters?: unknown })?.filters;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 6).map((f) => ({
    field: argString(f, "field"),
    op: argString(f, "op") || "is",
    values: argStrings(f, "values", 20),
  }));
}

function argPeriod(args: unknown): Period | null {
  const p = (args as { period?: unknown })?.period;
  if (!p || typeof p !== "object") return null;
  const preset = argString(p, "preset");
  if (!preset) return null;
  return { preset, from: argString(p, "from") || null, to: argString(p, "to") || null };
}

function argSort(args: unknown): { by: string; desc: boolean } | null {
  const s = (args as { sort?: unknown })?.sort;
  if (!s || typeof s !== "object") return null;
  const by = argString(s, "by");
  return by ? { by, desc: (s as { desc?: unknown }).desc !== false } : null;
}

const STEP_WORDS: Record<string, string> = {
  leads: "Checking leads",
  moves: "Checking lead stages",
  messages: "Checking WhatsApp messages",
  calls: "Checking AI calls",
  planned: "Checking planned calls and messages",
  visits: "Checking site visits",
  ads: "Checking ad results",
  publications: "Checking what was published",
  campaigns: "Checking campaigns",
  schedules: "Checking posting schedules",
  scheduled_posts: "Checking scheduled posts",
  creatives: "Checking posts waiting for review",
  studio_posts: "Checking studio posts",
  reels: "Checking story reels",
  towers: "Checking towers and RERA",
  prices: "Checking approved prices",
  facts: "Checking signed project facts",
  team: "Checking the team",
  partner_firms: "Checking partner firms",
  partner_registrations: "Checking partner registrations",
  partner_claims: "Checking partner claims",
  partner_bookings: "Checking partner bookings",
  partner_payouts: "Checking partner payouts",
};

/** A statement that ran out of time is the person's to narrow, not a failure. */
function isTimeout(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "57014";
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

export type AskInput = {
  orgId: string;
  orgName: string;
  /** What kind of company is asking, so Jimmy names only the screens it has. */
  orgType?: string;
  personName: string | null;
  authz: Pick<Authz, "can" | "canAt" | "scopesFor">;
  question: string;
  history: { role: "PERSON" | "JIMMY"; body: string }[];
  /** The records this chat's cards named, newest first (`chatMemory()`). */
  named?: string | null;
  /** The chat so far in a few sentences, from the working memory. */
  summary?: string | null;
  now?: Date;
  signal?: AbortSignal;
  onStep?: (text: string) => void;
  drivers?: AskDrivers;
  /** The chat and the person, which an action card needs. Without them Jimmy only answers. */
  threadId?: string | null;
  userId?: string | null;
  /** Jimmy's last message in this chat was a question back, so this one may not ask another. */
  justAsked?: boolean;
  /** A firm's person in this developer's console through a mandate (`throughMandate()`). */
  via?: { firmOrgId: string; firmName: string } | null;
};

const firstName = (name: string | null) => (name ?? "").trim().split(/\s+/)[0] || null;

/** A model that could not be asked is ours to fix, never the person's question. */
const unaskable = (code: string | undefined) => code === "UNREACHABLE" || isServiceDown(code);

function failedLine(code: string | undefined): string {
  if (code === "NO_KEY") return "Jimmy isn't set up yet, so it can't answer questions.";
  if (code === "UNREACHABLE" || code === "AI_UNAVAILABLE" || code === "AI_BUSY") return "Jimmy couldn't reach its model just now. Try again in a minute.";
  // Told "ask it a simpler way" when the service itself was out of credit, a
  // person rephrased a perfectly good question for nothing.
  if (code === "OUT_OF_CREDITS") return "Jimmy can't answer right now. Try again in a little while.";
  return "I couldn't work that out. Try asking it a simpler way.";
}

/**
 * Route, then answer. Returns what to show and what to record; writes nothing.
 * `askJimmy()` below is the caller that records it.
 */
export async function answerQuestion(input: AskInput): Promise<Answer> {
  const now = input.now ?? new Date();
  const step = (t: string) => {
    try {
      input.onStep?.(t);
    } catch {
      // A step is a courtesy to the screen; a closed stream is not our failure.
    }
  };
  // Through a mandate, what Jimmy may read leaves out the developer's own
  // business; screens and actions stay what the console itself lets them do.
  const data = { ...(input.via ? throughMandate(input.authz) : input.authz), orgType: input.orgType ?? null };
  const open = accessibleTopics(data);
  const meta: AskMeta = { kind: null, topics: [], denied: [], notBuilt: [], tools: [], model: null, turns: 0, usd: 0 };
  const done = (outcome: AskOutcome, body: string, blocks: Partial<AskBlocks> = {}): Answer => ({
    outcome,
    body,
    blocks: { ...NO_BLOCKS, ...blocks },
    meta,
  });

  // --- 1. the router ---------------------------------------------------------
  step("Reading the question");
  let routed: { kind: RouteKind; topics: string[] } | null = null;
  const route: AgentTool = {
    name: "route",
    description: "Say what kind of question this is, and for a data question every topic the answer needs.",
    parameters: ROUTE_SCHEMA,
    exclusive: true,
    async run(args): Promise<ToolOutcome> {
      const kind = argString(args, "kind");
      routed = {
        kind: (ROUTE_KINDS as readonly string[]).includes(kind) ? (kind as RouteKind) : "data",
        topics: argStrings(args, "topics", 9),
      };
      return { text: "Done.", end: { ok: true } };
    },
  };
  const r1 = await runAgent({
    model: ROUTER_MODEL(),
    effort: "low",
    instructions: routerInstructions(input.orgType),
    task: [{ text: taskText({ now, history: input.history.slice(-ROUTER_HISTORY), question: input.question, named: input.named, summary: input.summary }) }],
    tools: [route],
    maxTurns: 2,
    maxUsd: ROUTER_MAX_USD,
    maxIdle: 1,
    brain: input.drivers?.brain,
    signal: input.signal,
  });
  meta.usd += r1.usd;
  meta.turns += r1.usage.turns;
  if (r1.ended === "stopped") return done("STOPPED", "Stopped.");
  if (r1.ended === "failed" && !routed && unaskable(r1.end?.code)) {
    return done("FAILED", failedLine(r1.end?.code));
  }
  // A router that did not answer is not a refusal: the analyst gets every topic this person holds.
  const r: { kind: RouteKind; topics: string[] } = routed ?? { kind: "data", topics: [] };
  // A request for a link is a request for where to go, whatever the router thought.
  if ((r.kind === "data" || r.kind === "off_topic") && wantsLink(input.question)) r.kind = "help";
  // A request that starts by telling Jimmy to do something is never off topic.
  else if ((r.kind === "off_topic" || r.kind === "greeting") && startsWithAction(input.question)) r.kind = "action";
  else if (r.kind === "data" && startsWithAction(input.question, true)) r.kind = "action";
  meta.kind = r.kind;

  if (r.kind === "greeting") {
    return done("ANSWERED", greetingLine(firstName(input.personName), open), { followUps: startersFor(open, 3) });
  }
  if (r.kind === "off_topic") {
    return done("UNANSWERED", offTopicLine(input.orgName, open), { followUps: startersFor(open, 3) });
  }
  if (r.kind === "help") return answerHelp(input, now, meta, done, step);
  let operate: { catalog: string; never: string; screens: string; lacks: string } | null = null;
  if (r.kind === "action") {
    // Only the screens the question named: the companion topics are for answering, not for doing.
    const named = splitTopics(r.topics, data).allowed.filter((t) => r.topics.includes(t));
    const links = linksFor(named.flatMap((t) => visibleFor([t], data).map((v) => v.ds.key)), data);
    const never = neverThroughJimmy(input.question);
    if (never) return done("REFUSED", never.line, { links: [never.link] });
    if (!input.threadId || !input.userId) return done("UNANSWERED", ACTION_LINE, { links });
    if (!(await actionsOn(input.orgId))) {
      return done("REFUSED", `Jimmy is not allowed to take actions in ${input.orgName}. An admin can switch this on in Settings.`, { links });
    }
    const catalog = actionCatalog(input.authz);
    if (!catalog) return done("REFUSED", "There is nothing you have access to that Jimmy can do. Ask your admin if you need it.", { links });
    operate = {
      catalog,
      never: NOT_THROUGH_JIMMY,
      screens: screenIndex(screensFor(input.authz, input.orgType, Boolean(input.via)).open),
      lacks: actionsLacked(input.authz),
    };
  }

  // --- 2. what this person may be told about --------------------------------
  // Asked to do something, the person reads what they may read to find it;
  // what they may DO is decided per action, by its own keys.
  const split = operate
    ? { allowed: open, denied: [] as TopicKey[], notBuilt: [] as TopicKey[] }
    : r.topics.length
      ? withoutIncidental(splitTopics(r.topics, data), input.question)
      : { allowed: open, denied: [], notBuilt: [] };
  meta.topics = split.allowed;
  meta.denied = split.denied;
  meta.notBuilt = split.notBuilt;
  const notes: string[] = [];
  if (!split.allowed.length) {
    if (split.denied.length) notes.push(deniedLine(split.denied, false));
    if (split.notBuilt.length) notes.push(notBuiltLine(split.notBuilt));
    if (!notes.length) notes.push(offTopicLine(input.orgName, open));
    // A topic not built is a feature somebody asked for: the unanswered log.
    return done(split.denied.length ? "REFUSED" : "UNANSWERED", notes.join(" "), { followUps: startersFor(open, 3) });
  }
  if (split.denied.length) notes.push(deniedLine(split.denied, true));
  if (split.notBuilt.length) notes.push(notBuiltLine(split.notBuilt));

  // --- 3. the analyst ---------------------------------------------------------
  const visible = visibleFor(split.allowed, data);
  const results = new Map<string, Shaped>();
  const evidence: string[] = [input.question];
  let resultNo = 0;
  let placesCache: Promise<PlaceNode[]> | null = null;
  const places = () => (placesCache ??= loadPlaces(input.orgId));
  const computedCache = new Map<string, Promise<ComputedRow[]>>();
  const computed = (key: string, range: Range | null, scopeSets: string[][]) => {
    const k = `${key}|${range?.from.getTime() ?? ""}|${range?.to.getTime() ?? ""}|${JSON.stringify(scopeSets)}`;
    let p = computedCache.get(k);
    if (!p) {
      p = LOADERS[key]({ orgId: input.orgId, now, range, scopeSets, places });
      computedCache.set(k, p);
    }
    return p;
  };
  let answer: { status: AnswerStatus; text: string; show: string[]; followUps: string[] } | null = null;
  let proposal: { view: ActionView } | { refusal: string } | null = null;
  let clarify: { question: string; options: string[] } | null = null;
  // A style problem is sent back once; a wrong number is sent back every time.
  let styleSentBack = false;

  let citiesCache: Promise<{ name: string; path: string }[]> | null = null;
  const cities = () =>
    (citiesCache ??= withTenantReadOnly(input.orgId, (sql) => sql<{ name: string; path: string }[]>`
      SELECT name, path::text AS path FROM scope_nodes WHERE org_id = ${input.orgId} AND kind = 'REGION'`));
  const placesFor = async (names: string[], scopes: string[]) => {
    if (!names.length) return { ok: true as const, paths: null as string[] | null, labels: [] as string[] };
    const r = resolvePlaces(names, await places(), scopes, await cities());
    // The places it lists are names the answer may quote, digits and all ("Origin 206").
    if (!r.ok) evidence.push(r.message);
    return r.ok ? { ok: true as const, paths: r.paths, labels: r.labels } : r;
  };

  const query: AgentTool = {
    name: "query",
    description:
      "Numbers from the data map: one to six measures, optionally grouped by up to two dimensions, filtered, for a period and places. Measures from different datasets are totalled separately and put side by side.",
    parameters: QUERY_SCHEMA,
    async run(args): Promise<ToolOutcome> {
      let asked: string[] = [];
      const spec: AggregateSpec = {
        measures: argStrings(args, "measures", 8),
        by: argStrings(args, "by", 3),
        filters: selfFilters(argFilters(args), input.personName),
        places: widened(asked = argStrings(args, "places", 5), input.question),
        period: argPeriod(args),
        sort: argSort(args),
        limit: argNumber(args, "limit"),
      };
      const planned = planAggregate(spec, visible, now);
      if (!planned.ok) return { text: `Refused: ${planned.message}` };
      const plan = planned.plan;
      const where = await placesFor(spec.places, [...new Set(plan.parts.flatMap((p) => p.v.scopes))]);
      if (!where.ok) return { text: `Refused: ${where.message}` };
      step(STEP_WORDS[plan.parts[0].v.ds.key] ?? "Checking");
      meta.tools.push(`query:${plan.parts.map((p) => p.v.ds.key).join("+")}`);

      // Computed rows first, outside the transaction; then every SQL part in one.
      const loaded = await Promise.all(
        plan.parts.map((part) => (part.v.ds.source === "computed" ? computed(part.v.ds.key, part.range, part.scopeSets) : null)),
      );
      let rows: Row[][];
      try {
        rows = await withTenantReadOnly(input.orgId, async (tx) => {
          const out: Row[][] = [];
          for (let i = 0; i < plan.parts.length; i++) {
            const part = plan.parts[i];
            if (part.v.ds.source === "computed") {
              out.push(aggregateComputed(await loaded[i]!, part, plan, where.paths));
            } else {
              const q = aggregateSql(part, plan, input.orgId, where.paths);
              out.push((await tx.unsafe(q.text, q.params as never[])) as unknown as Row[]);
            }
          }
          return out;
        });
      } catch (e) {
        if (isTimeout(e)) return { text: "Refused: that query took too long. Ask for a shorter period or fewer groups." };
        throw e;
      }
      const shaped = shapeAggregate(`r${++resultNo}`, plan, mergeParts(plan, rows), now, where.labels);
      results.set(shaped.table.id, shaped);
      evidence.push(shaped.text);
      return { text: shaped.text + droppedNote(asked, spec.places) };
    },
  };

  const list: AgentTool = {
    name: "list",
    description: "Individual records from one dataset: its list fields, filtered, sorted, for a period and places. Up to 50 rows.",
    parameters: LIST_SCHEMA,
    async run(args): Promise<ToolOutcome> {
      let asked: string[] = [];
      const spec: ListSpec = {
        dataset: argString(args, "dataset"),
        fields: argStrings(args, "fields", 10),
        filters: selfFilters(argFilters(args), input.personName),
        places: widened(asked = argStrings(args, "places", 5), input.question),
        period: argPeriod(args),
        sort: argSort(args),
        limit: argNumber(args, "limit"),
      };
      const planned = planList(spec, visible, now);
      if (!planned.ok) return { text: `Refused: ${planned.message}` };
      const plan = planned.plan;
      const where = await placesFor(spec.places, plan.v.scopes);
      if (!where.ok) return { text: `Refused: ${where.message}` };
      step(STEP_WORDS[plan.v.ds.key] ?? "Checking");
      meta.tools.push(`list:${plan.v.ds.key}`);
      let rows: Row[];
      let total: number;
      try {
        if (plan.v.ds.source === "computed") {
          const r = listComputed(await computed(plan.v.ds.key, plan.range, plan.scopeSets), plan, where.paths);
          rows = r.rows;
          total = r.total;
        } else {
          const q = listSql(plan, input.orgId, where.paths);
          rows = (await withTenantReadOnly(input.orgId, (tx) => tx.unsafe(q.text, q.params as never[]))) as unknown as Row[];
          total = rows.length ? Number(rows[0]._total) : 0;
        }
      } catch (e) {
        if (isTimeout(e)) return { text: "Refused: that list took too long. Ask for a shorter period." };
        throw e;
      }
      const shaped = shapeList(`r${++resultNo}`, plan, rows, total, now, where.labels);
      results.set(shaped.table.id, shaped);
      evidence.push(shaped.text);
      return { text: shaped.text + droppedNote(asked, spec.places) };
    },
  };

  const compute: AgentTool = {
    name: "compute",
    description: "Arithmetic on numbers taken from the results: + - * / and brackets. Each number must appear in a result.",
    parameters: COMPUTE_SCHEMA,
    async run(args): Promise<ToolOutcome> {
      const raw = (args as { items?: unknown })?.items;
      const items = Array.isArray(raw) ? raw.slice(0, 10) : [];
      if (!items.length) return { text: "Refused: give at least one item." };
      step("Working it out");
      meta.tools.push("compute");
      const lines = items.map((it) => {
        const label = argString(it, "label").slice(0, 80) || "result";
        const expression = argString(it, "expression");
        const r = evaluate(expression, evidence);
        // Arithmetic on a rupee amount is rupees; on counts alone it is not.
        if (r.ok && moneyIn(evidence.join("\n")).some((m) => numbersIn(expression).some((n) => Math.abs(n.value - m.value) < 1e-6))) {
          evidence.push(`(${label}: Rs ${r.value})`);
        }
        return r.ok ? `${label} = ${r.value}` : `${label}: Refused: ${r.message}`;
      });
      const text = lines.join("\n");
      evidence.push(text);
      return { text: lines.every((l) => l.includes("Refused:")) ? `Refused: ${text}` : text };
    },
  };

  const finish: AgentTool = {
    name: "answer",
    exclusive: true,
    description: "The answer the person reads. Ends the job.",
    parameters: ANSWER_SCHEMA,
    async run(args): Promise<ToolOutcome> {
      const status = argString(args, "status") as AnswerStatus;
      const text = argString(args, "text");
      const show = argStrings(args, "show", 3);
      const unknown = show.filter((id) => !results.has(id));
      if (unknown.length) {
        return { text: `Refused: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a result. The results are ${[...results.keys()].join(", ") || "none yet"}.` };
      }
      if (status === "clarify" && input.justAsked) {
        return { text: "Refused: you asked a question back last time. Answer now, or say plainly what you could not find." };
      }
      if (status === "answered" || status === "clarify") {
        const tables = show.map((id) => results.get(id)?.table).filter((tb): tb is AskTable => !!tb && tb.rows.length > 0);
        const rowNames = tables.filter((tb) => tb.more === 0 && tb.columns[0] && !tb.columns[0].numeric).map((tb) => tb.rows.map((r) => r.cells[0]));
        const found = answerCheck(text, evidence, tables.length > 0, rowNames);
        const problems = found.filter((p) => !p.style || !styleSentBack);
        if (problems.length) {
          if (problems.some((p) => p.style)) styleSentBack = true;
          return { text: `Refused: ${problems.map((p) => p.message).join(" ")}` };
        }
      } else if (!text.trim()) {
        return { text: "Refused: say in one sentence what you can tell them instead." };
      }
      answer = {
        status: (["answered", "clarify", "cannot_answer", "no_access"] as const).includes(status) ? status : "answered",
        text: text.trim().slice(0, 1500),
        show,
        // A suggestion still carrying a stored value ("last_7_days") after the
        // words are put back is dropped rather than shown.
        followUps: argStrings(args, "follow_ups", 3)
          .map((f) => plainWords(f.slice(0, 120)))
          .filter((f) => !/_/.test(f)),
      };
      return { text: "Done.", end: { ok: true } };
    },
  };

  const propose: AgentTool = {
    name: "propose_action",
    exclusive: true,
    description: "Show the person a card for one action. Ends the job: the card asks for what is missing and waits for their press.",
    parameters: PROPOSE_SCHEMA,
    async run(args): Promise<ToolOutcome> {
      const kind = argString(args, "action");
      const raw = (args as { inputs?: unknown })?.inputs;
      const hints: Record<string, string> = {};
      if (Array.isArray(raw)) for (const it of raw.slice(0, 20)) hints[argString(it, "name")] = argString(it, "value");
      step("Getting it ready");
      meta.tools.push(`propose:${kind}`);
      const started = await startAction(
        { orgId: input.orgId, userId: input.userId!, authz: input.authz, now, via: input.via ?? null },
        input.threadId!,
        kind,
        hints,
        input.question,
      );
      if (!started.ok) {
        if (/^There is no action/.test(started.message)) return { text: `Refused: ${started.message} Use one from the list.` };
        proposal = { refusal: started.message };
        return { text: "Done.", end: { ok: true } };
      }
      proposal = { view: started.view };
      return { text: "Done.", end: { ok: true } };
    },
  };

  const askPerson: AgentTool = {
    name: "ask_person",
    exclusive: true,
    description: "Ask the person one short question with two to four options, when their question could be read two ways. Ends the job.",
    parameters: ASK_PERSON_SCHEMA,
    async run(args): Promise<ToolOutcome> {
      const question = withoutDashes(plainWords(argString(args, "question").slice(0, 200)));
      // "Other" is the card's own; a model adding it adds it twice.
      const options = argStrings(args, "options", 4)
        .map((o) => withoutDashes(plainWords(o.slice(0, 80))))
        .filter((o) => !/^other\b/i.test(o));
      if (!question || options.length < 2) return { text: "Refused: give one question and two to four options." };
      // A place offered has to be a real one this person can see: a chip
      // naming a tower that does not exist is a question with a wrong answer in it.
      const scopes = [...new Set(visible.flatMap((v) => v.scopes))];
      const stray = strayPlaceOptions(options, await places(), scopes);
      if (stray.length) {
        return {
          text: `Refused: ${stray.map((s) => `"${s}"`).join(", ")} ${stray.length === 1 ? "is" : "are"} not a place this person can see. Offer only real places, or answer without asking.`,
        };
      }
      clarify = { question, options };
      return { text: "Done.", end: { ok: true } };
    },
  };

  step("Looking at your data");
  const model = ASK_MODEL();
  meta.model = model;
  const r2 = await runAgent({
    model,
    effort: "low",
    instructions: analystInstructions({
      orgName: input.orgName,
      personName: input.personName,
      catalog: catalogText(visible),
      denied: split.denied,
      actions: operate,
    }),
    task: [{ text: taskText({ now, history: input.history.slice(-HISTORY_EXCHANGES * 2), question: input.question, named: input.named, summary: input.summary }) }],
    // Asked to do something, the model never writes the options: code asks, from the person's own records.
    // And one question back per exchange: after a clarifying question the
    // next answer is an answer, or a plain "I can't find that", never a
    // third round of chips.
    tools: operate
      ? [query, list, compute, propose, finish]
      : input.justAsked
        ? [query, list, compute, finish]
        : [query, list, compute, askPerson, finish],
    maxTurns: MAX_ANALYST_TURNS,
    maxUsd: Math.max(0.004, MAX_QUESTION_USD - meta.usd),
    parallel: 2,
    brain: input.drivers?.brain,
    signal: input.signal,
  });
  meta.usd = Math.round((meta.usd + r2.usd) * 10_000) / 10_000;
  meta.turns += r2.usage.turns;

  if (r2.ended === "stopped") return done("STOPPED", "Stopped.");
  const made = proposal as { view: ActionView } | { refusal: string } | null;
  if (made && "refusal" in made) return done("REFUSED", made.refusal, { notes });
  if (made && "view" in made) {
    const v = made.view;
    const body =
      v.state === "ASKING"
        ? v.questions[0]?.title ?? "I need a little more first."
        : v.state === "PROPOSED"
          ? "Here it is. Check it, then confirm."
          : v.result?.message ?? "I could not get that ready.";
    return { ...done(v.state === "FAILED" ? "UNANSWERED" : "ANSWERED", body, { notes, action: { id: v.id } }), actionView: v };
  }
  const asked = clarify as { question: string; options: string[] } | null;
  if (asked) return done("CLARIFY", asked.question, { notes, clarify: asked });
  const final = answer as { status: AnswerStatus; text: string; show: string[]; followUps: string[] } | null;
  if (!final) {
    // Out of budget or stuck, but with real results in hand: show the last
    // one rather than nothing. The table is the query's own rows, so it is as
    // true as any answer; only the sentence explaining it is missing.
    const last = [...results.values()].pop();
    if (last) {
      meta.partial = true;
      return done("ANSWERED", "I ran out of time to explain this, but here is what I found.", {
        tables: [last.table],
        links: linksFor(last.datasets, data),
        notes,
      });
    }
    return done("FAILED", failedLine(r2.end?.code), { notes });
  }

  // A list with no rows is said in the sentence; an empty table under it says nothing more.
  const shown = final.show.map((id) => results.get(id)!).filter((s) => s && s.table.rows.length > 0);
  const used = (shown.length ? shown : [...results.values()]).flatMap((s) => s.datasets);
  const blocks: Partial<AskBlocks> = {
    tables: shown.map((s) => s.table),
    links: linksFor([...new Set(used)], data),
    followUps: final.followUps.map(withoutDashes),
    notes,
  };
  if (final.status === "no_access") {
    notes.push("Part of that needs access you don't have. Ask your admin if you need it.");
    return done(shown.length ? "ANSWERED" : "REFUSED", plainWords(withoutDashes(final.text)), blocks);
  }
  const outcome: AskOutcome = final.status === "clarify" ? "CLARIFY" : final.status === "cannot_answer" ? "UNANSWERED" : "ANSWERED";
  // Asked to do what Jimmy cannot, it says which screen does: that screen is the link.
  if (operate && final.status === "cannot_answer") {
    const open = screensFor(input.authz, input.orgType, Boolean(input.via)).open;
    blocks.links = helpLinks(screensNamedIn(final.text, open), open);
  }
  return done(outcome, plainWords(withoutDashes(final.text)), blocks);
}

/**
 * The records a screen's page can open for this person: only where they hold
 * one of the screen's keys, so a page Jimmy links is a page that opens.
 */
async function pageRecords(orgId: string, authz: AskInput["authz"], screen: Screen): Promise<PageRecord[]> {
  const scopes = [...new Set(screen.anyOf.flatMap((k) => authz.scopesFor(k)))];
  const kind = screen.page?.record;
  if (!kind || (!scopes.length && screen.anyOf.length)) return [];
  const within = (path: string) => scopes.some((s) => scopeCovers(s, path));
  if (kind === "place" || kind === "project") {
    const nodes = await loadPlaces(orgId);
    return nodes
      .filter((n) => (kind === "place" || n.kind === "PROJECT") && within(n.path))
      .map((n) => ({ id: n.id, label: placeLabel(n), path: n.path }));
  }
  return withTenantReadOnly(orgId, async (sql) => {
    if (kind === "lead") {
      const rows = await sql<{ id: string; name: string | null; place: string | null; path: string }[]>`
        SELECT l.id, l.name, coalesce(pj.name || ' · ', '') || n.name AS place, n.path::text AS path
        FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
        LEFT JOIN scope_nodes pj ON pj.org_id = n.org_id AND pj.kind = 'PROJECT' AND n.path <@ pj.path AND pj.id <> n.id
        WHERE l.org_id = ${orgId} AND n.path <@ ANY(${scopes}::ltree[])
        ORDER BY l.last_activity_at DESC NULLS LAST LIMIT 5000`;
      return rows.filter((r) => r.name).map((r) => ({ id: r.id, label: `${r.name}, ${r.place}`, path: r.path }));
    }
    if (kind === "brief") {
      const rows = await sql<{ id: string; name: string | null; status: string; place: string; path: string }[]>`
        SELECT b.id, b.name, b.status, coalesce(pj.name || ' · ', '') || n.name AS place, n.path::text AS path
        FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
        LEFT JOIN scope_nodes pj ON pj.org_id = n.org_id AND pj.kind = 'PROJECT' AND n.path <@ pj.path AND pj.id <> n.id
        WHERE b.org_id = ${orgId} AND n.path <@ ANY(${scopes}::ltree[])
        ORDER BY b.created_at DESC LIMIT 500`;
      return rows.map((r) => ({
        id: r.id,
        label: `${r.name ?? "Untitled campaign"}, ${r.place}`,
        path: r.path,
        note: r.status === "READY" ? "ready" : "still a draft",
      }));
    }
    // A provider's page opens only once it has been connected.
    const rows = await sql<{ provider: string }[]>`
      SELECT DISTINCT provider FROM connections WHERE org_id = ${orgId} AND status <> 'DISCONNECTED'`;
    return rows.map((r) => ({ id: r.provider.toLowerCase(), label: r.provider === "META" ? "Meta" : "Google" }));
  });
}

/**
 * A question about using the console: answered from the screen map
 * (`ask-help.ts`), only the screens this person can open described, every
 * quoted button checked against the map, and each named screen a link.
 */
async function answerHelp(
  input: AskInput,
  now: Date,
  meta: AskMeta,
  done: (outcome: AskOutcome, body: string, blocks?: Partial<AskBlocks>) => Answer,
  step: (t: string) => void,
): Promise<Answer> {
  step("Finding it in the console");
  const split = screensFor(input.authz, input.orgType, Boolean(input.via));
  let reply: { text: string; screens: string[]; pages: string[]; followUps: string[] } | null = null;
  let sentBack = false;
  // Pages find_page found, by the id Jimmy links them with.
  const found = new Map<string, { label: string; href: string }>();
  const findPage: AgentTool = {
    name: "find_page",
    description: "Find one record's own page (a lead, a project or tower, a campaign's brief, studio or schedule, a connection) among those this person can open.",
    parameters: FIND_PAGE_SCHEMA,
    async run(args): Promise<ToolOutcome> {
      const key = argString(args, "screen");
      const said = argString(args, "said").slice(0, 200);
      const screen = split.open.find((x) => x.key === key);
      if (!screen) {
        return split.closed.some((x) => x.key === key)
          ? { text: `Refused: ${key} is not open to this person. Say they need access.` }
          : { text: `There is no screen called ${key}. Use a key from the map.` };
      }
      if (!screen.page) return { text: `${key} has no page per record. Link the screen itself in screens.` };
      const records = await pageRecords(input.orgId, input.authz, screen);
      if (!records.length) return { text: `This person can open no ${screen.title.toLowerCase()} yet. Say so, and link the screen above it.` };
      const hits = bestRecords(said, records);
      if (!hits.length) {
        const some = records.slice(0, 8).map((r) => r.label);
        return { text: `Nothing matches "${said}". What exists: ${some.join("; ")}${records.length > some.length ? "; and more" : ""}.` };
      }
      // Every page the record opens, so the one asked for can be linked whichever screen was looked up.
      const pagesOf = siblingPages(screen, split.open);
      const lines = hits.slice(0, 5).map((r) => {
        const each = pagesOf.map((s) => {
          const id = `p${found.size + 1}`;
          found.set(id, { label: pageLabel(s, r), href: pageHref(s, r.id)! });
          return `${id} ${s.title}`;
        });
        return `${r.label}${r.note ? ` (${r.note})` : ""}: ${each.join(", ")}`;
      });
      return {
        text:
          hits.length === 1
            ? `Found it. ${lines[0]}. Put the id of the page they asked for in pages.`
            : `${hits.length} match${hits.length > 5 ? ", the first five" : ""}. ${lines.join(". ")}. Link the ones they mean, or ask which.`,
      };
    },
  };
  const answerHelpTool: AgentTool = {
    name: "answer_help",
    description: "Answer how to use the console, naming the screens to open.",
    parameters: HELP_SCHEMA,
    exclusive: true,
    async run(args): Promise<ToolOutcome> {
      const text = withoutDashes(argString(args, "text").trim()).slice(0, 1200);
      if (!text) return { text: "Refused: write the answer in text." };
      const keys = argStrings(args, "screens", 5);
      const closed = keys.filter((k) => split.closed.some((s) => s.key === k));
      if (closed.length) {
        return { text: `Refused: ${closed.join(", ")} ${closed.length === 1 ? "is" : "are"} not open to this person. Say they need access, and link only screens they can open.` };
      }
      const unknown = keys.filter((k) => !split.open.some((s) => s.key === k));
      if (unknown.length) return { text: `Refused: there is no screen called ${unknown.join(", ")}. Use keys from the map.` };
      const outside = quotedOutsideMap(text, split.open);
      if (outside.length && !sentBack) {
        sentBack = true;
        return { text: `Refused: ${outside.map((q) => `"${q}"`).join(", ")} is not on any screen in the map. Quote only the words the map gives, or describe it without quotes.` };
      }
      const pages = argStrings(args, "pages", 5);
      const lost = pages.filter((id) => !found.has(id));
      if (lost.length) return { text: `Refused: ${lost.join(", ")} is not a page find_page gave. Call find_page first.` };
      reply = { text, screens: keys, pages, followUps: argStrings(args, "follow_ups", 3) };
      return { text: "Done.", end: { ok: true } };
    },
  };
  const model = ASK_MODEL();
  meta.model = model;
  const r = await runAgent({
    model,
    effort: "low",
    instructions: helpInstructions({ orgName: input.orgName, personName: input.personName, catalog: helpCatalog(split) }),
    task: [{ text: taskText({ now, history: input.history.slice(-HISTORY_EXCHANGES * 2), question: input.question, named: input.named, summary: input.summary }) }],
    tools: [findPage, answerHelpTool],
    maxTurns: 5,
    maxUsd: Math.max(0.004, MAX_QUESTION_USD - meta.usd),
    maxIdle: 2,
    brain: input.drivers?.brain,
    signal: input.signal,
  });
  meta.usd = Math.round((meta.usd + r.usd) * 10_000) / 10_000;
  meta.turns += r.usage.turns;
  if (r.ended === "stopped") return done("STOPPED", "Stopped.");
  const got = reply as { text: string; screens: string[]; pages: string[]; followUps: string[] } | null;
  if (!got) return done("FAILED", failedLine(r.end?.code));
  const keys = got.screens.length || got.pages.length ? got.screens : screensNamedIn(got.text, split.open);
  // One record's own page first: it is what they asked for.
  const pageLinks = got.pages.map((id) => found.get(id)!).filter(Boolean);
  const links = [...pageLinks, ...helpLinks(keys, split.open).filter((l) => !pageLinks.some((p) => p.href === l.href))].slice(0, 3);
  return done("ANSWERED", plainWords(got.text), { links, followUps: got.followUps.map(withoutDashes) });
}

// ---------------------------------------------------------------------------
// Chats: private to the person who asked
// ---------------------------------------------------------------------------

export type ThreadSummary = { id: string; title: string; updatedAt: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listThreads(orgId: string, userId: string): Promise<ThreadSummary[]> {
  const rows = await withPerson(orgId, userId, (sql) => sql<{ id: string; title: string; updated_at: Date }[]>`
    SELECT id, title, updated_at FROM ask_threads
    WHERE updated_at > now() - make_interval(days => ${CHAT_DAYS})
    ORDER BY updated_at DESC LIMIT 60`);
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: new Date(r.updated_at).toISOString() }));
}

type DbMessage = { id: string; role: "PERSON" | "JIMMY"; body: string; blocks: unknown; outcome: AskOutcome | null; created_at: Date };

function toMessage(r: DbMessage): AskMessage {
  const b = (r.blocks ?? {}) as Partial<AskBlocks>;
  return {
    id: r.id,
    role: r.role,
    body: r.body,
    blocks: {
      tables: Array.isArray(b.tables) ? b.tables : [],
      links: Array.isArray(b.links) ? b.links : [],
      followUps: Array.isArray(b.followUps) ? b.followUps : [],
      notes: Array.isArray(b.notes) ? b.notes : [],
      action: b.action && typeof b.action.id === "string" ? { id: b.action.id } : null,
      clarify: b.clarify && typeof b.clarify.question === "string" ? { question: b.clarify.question, options: Array.isArray(b.clarify.options) ? b.clarify.options : [] } : null,
      setup: b.setup && typeof b.setup.id === "string" ? { id: b.setup.id } : null,
      files: Array.isArray(b.files) ? b.files.filter((f) => f && typeof f.id === "string").map((f) => ({ id: f.id, name: String(f.name ?? ""), type: String(f.type ?? "") })) : [],
    },
    outcome: r.outcome,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function loadThread(
  orgId: string,
  userId: string,
  threadId: string,
): Promise<{ id: string; title: string; messages: AskMessage[] } | null> {
  if (!UUID.test(threadId)) return null;
  return withPerson(orgId, userId, async (sql) => {
    const [t] = await sql<{ id: string; title: string }[]>`SELECT id, title FROM ask_threads WHERE id = ${threadId}`;
    if (!t) return null;
    const rows = await sql<DbMessage[]>`
      SELECT id, role, body, blocks, outcome, created_at FROM ask_messages
      WHERE thread_id = ${threadId} ORDER BY created_at, role DESC LIMIT 400`;
    return { id: t.id, title: t.title, messages: rows.map(toMessage) };
  }).then(async (thread) => {
    if (!thread) return null;
    const [views, setups] = await Promise.all([actionViews(orgId, userId, threadId), setupViews(orgId, userId, threadId)]);
    for (const m of thread.messages) {
      if (m.blocks.action) m.action = views.get(m.blocks.action.id) ?? null;
      if (m.blocks.setup) m.setup = setups.get(m.blocks.setup.id) ?? null;
    }
    return thread;
  });
}

export async function deleteThread(orgId: string, userId: string, threadId: string): Promise<boolean> {
  if (!UUID.test(threadId)) return false;
  const gone = await withPerson(orgId, userId, (sql) => sql`DELETE FROM ask_threads WHERE id = ${threadId} RETURNING id`);
  if (!gone.length) return false;
  await forgetChat({ orgId, userId, threadId });
  await audit({ orgId, actorUserId: userId, action: "ask.chat_deleted", targetType: "ask_thread", targetId: threadId, metadata: {} });
  return true;
}

/** How often a running question looks for Stop. */
export const STOP_POLL_MS = 1200;

/**
 * Mark a chat's running question to stop. The question keeps running when its
 * screen goes away, so Stop is this mark rather than a dropped stream; the
 * question reads it (`watchForStop()`) and ends between two turns.
 */
export async function requestStop(orgId: string, userId: string, threadId: string): Promise<boolean> {
  if (!UUID.test(threadId)) return false;
  const rows = await withPerson(orgId, userId, (sql) => sql`
    UPDATE ask_threads SET stop_requested_at = now() WHERE id = ${threadId} RETURNING id`);
  return rows.length > 0;
}

/**
 * An abort signal for one question, raised when its chat is marked to stop or
 * is deleted mid-answer. One short read every `STOP_POLL_MS`, never two at
 * once, for the few seconds a question runs.
 */
function watchForStop(orgId: string, userId: string, threadId: string, outer?: AbortSignal) {
  const controller = new AbortController();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener("abort", () => controller.abort(), { once: true });
  let reading = false;
  const timer = setInterval(async () => {
    if (reading || controller.signal.aborted) return;
    reading = true;
    try {
      const [row] = await withPerson(orgId, userId, (sql) => sql<{ stop: Date | null }[]>`
        SELECT stop_requested_at AS stop FROM ask_threads WHERE id = ${threadId}`);
      if (!row || row.stop) controller.abort();
    } catch {
      // A missed read is the next read's job.
    } finally {
      reading = false;
    }
  }, STOP_POLL_MS);
  return { signal: controller.signal, end: () => clearInterval(timer) };
}

type UsageSql = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * Today's questions, clips and answers read aloud for one person, the month's
 * for the organisation, and its projects. `orgId` is the organisation whose
 * allowance is used: through a mandate, the firm's own, never the developer's.
 */
async function readUsage(sql: UsageSql, orgId: string, userId: string, day: string) {
  const [today] = await sql<{ n: number; voice: number; listen: number }[]>`
    SELECT coalesce(sum(questions), 0)::int AS n, coalesce(sum(voice), 0)::int AS voice, coalesce(sum(listen), 0)::int AS listen
    FROM ask_usage WHERE org_id = ${orgId} AND user_id = ${userId} AND day = ${day}`;
  const [month] = await sql<{ n: number; voice: number; listen: number }[]>`
    SELECT coalesce(sum(questions), 0)::int AS n, coalesce(sum(voice), 0)::int AS voice, coalesce(sum(listen), 0)::int AS listen
    FROM ask_usage WHERE org_id = ${orgId} AND day >= date_trunc('month', ${day}::date)::date`;
  // A retired project earns no more questions.
  const [projects] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM scope_nodes s
    WHERE s.org_id = ${orgId} AND s.kind = 'PROJECT'
      AND NOT EXISTS (SELECT 1 FROM project_states ps WHERE ps.org_id = s.org_id AND ps.project_id = s.id AND ps.status = 'RETIRED')`;
  // A channel partner's plan, which sets the month's questions for the whole business.
  const [firm] = await sql<{ plan: string; terms: unknown }[]>`
    SELECT plan, terms FROM subscriptions
    WHERE org_id = ${orgId} AND scope = 'ORG' AND starts_on <= ${day}::date AND (ends_on IS NULL OR ends_on > ${day}::date)
    ORDER BY starts_on DESC LIMIT 1`;
  const terms = firm && isPlanKey(firm.plan) ? readTerms(firm.plan, firm.terms, "ORG") : null;
  return {
    today: today.n,
    month: month.n,
    projects: projects.n,
    partner: terms ? { questions: terms.questions, projects: terms.projects } : null,
    voiceToday: today.voice,
    voiceMonth: month.voice,
    listenToday: today.listen,
    listenMonth: month.listen,
  };
}

/**
 * A spoken question, written down for the person to read and send.
 *
 * Refused before Saaras is paid: a clip that is not audio or is too long,
 * a person or organisation out of questions, or out of clips. The clip is
 * counted, and its cost added to the day, whether or not anything was heard,
 * because Saaras was asked. The audio lives only in this call: it is never
 * written to the database, the file store or a log.
 */
export async function hearQuestion(opts: {
  orgId: string;
  /** The organisation whose allowance the clip uses, when not `orgId`: a firm working through a mandate. */
  billOrgId?: string;
  userId: string;
  bytes: Buffer;
  contentType: string | null;
  seconds: number;
  /** The length the browser said, before it was held to the recorder's limit. */
  said?: number | null;
  now?: Date;
}): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const now = opts.now ?? new Date();
  const type = voiceType(opts.contentType);
  const problem = voiceProblem({ type, bytes: opts.bytes.length, seconds: opts.said ?? null });
  if (problem || !type) return { ok: false, message: problem ?? "That recording could not be read. Try again." };
  const day = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

  const bill = opts.billOrgId ?? opts.orgId;
  const usage = await withTenant(bill, (sql) => readUsage(sql, bill, opts.userId, day));
  const limit = !!limitsLifted()
    ? null
    : overAllowance({ todayByPerson: usage.today, monthByOrg: usage.month, projects: usage.projects, partner: usage.partner }) ??
      overVoiceAllowance({ todayByPerson: usage.voiceToday, monthByOrg: usage.voiceMonth, projects: usage.projects, partner: usage.partner });
  if (limit) return { ok: false, message: limit };

  const heard = await transcribe({ bytes: opts.bytes, contentType: type, mode: "translit", fileName: voiceFileName(type) });
  const usd = heard.ok ? voiceUsd(opts.seconds) : 0;
  await withTenant(bill, (sql) => sql`
    INSERT INTO ask_usage (org_id, user_id, day, questions, usd, voice)
    VALUES (${bill}, ${opts.userId}, ${day}, 0, ${usd}, 1)
    ON CONFLICT (org_id, user_id, day)
    DO UPDATE SET voice = ask_usage.voice + 1, usd = ask_usage.usd + EXCLUDED.usd`);

  if (!heard.ok) return { ok: false, message: "Your question could not be written down. Try again, or type it." };
  const text = cleanTranscript(heard.text, MAX_QUESTION_CHARS);
  if (!text) return { ok: false, message: "I didn't catch that. Try again, a little closer to the phone." };
  return { ok: true, text };
}

let speaker: SpeakDriver | null = null;

/** For the checks: a voice that never leaves the machine. */
export function useSpeaker(driver: SpeakDriver | null): void {
  speaker = driver;
}

/**
 * One of Jimmy's answers, read aloud by Sarvam's Bulbul v3.
 *
 * Only the person's own answer (`withPerson()`), only its words (never a
 * table), cut to `LISTEN_MAX_CHARS` at a full stop, in the chat's language:
 * Devanagari or Roman Hinglish, in the answer or the question it answers, is
 * read by the Hindi voice. Refused before Bulbul is paid when the answer has
 * nothing to read or the person or organisation has had its answers read
 * today or this month. The read is counted, and its letters' cost added to
 * the day, once Bulbul has been asked, whether or not it answered. The sound
 * lives in this call only: never a row, a file or a log.
 */
export async function readAnswerAloud(opts: {
  orgId: string;
  /** The organisation whose allowance the read uses, when not `orgId`: a firm working through a mandate. */
  billOrgId?: string;
  userId: string;
  messageId: string;
  now?: Date;
}): Promise<{ ok: true; bytes: Buffer; type: string } | { ok: false; message: string }> {
  const now = opts.now ?? new Date();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.messageId)) {
    return { ok: false, message: "That answer is no longer here." };
  }
  const [found] = await withPerson(opts.orgId, opts.userId, (sql) => sql<{ body: string; question: string | null }[]>`
    SELECT a.body,
           (SELECT q.body FROM ask_messages q
            WHERE q.thread_id = a.thread_id AND q.role = 'PERSON' AND q.created_at <= a.created_at
            ORDER BY q.created_at DESC LIMIT 1) AS question
    FROM ask_messages a
    WHERE a.id = ${opts.messageId} AND a.role = 'JIMMY' AND a.user_id = ${opts.userId}`);
  if (!found) return { ok: false, message: "That answer is no longer here." };
  const text = spokenAnswer(found.body);
  if (!text) return { ok: false, message: "There is nothing to read in that answer." };

  const day = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const bill = opts.billOrgId ?? opts.orgId;
  const usage = await withTenant(bill, (sql) => readUsage(sql, bill, opts.userId, day));
  const limit = !limitsLifted() ? overListenAllowance({ todayByPerson: usage.listenToday, monthByOrg: usage.listenMonth, projects: usage.projects, partner: usage.partner }) : null;
  if (limit) return { ok: false, message: limit };

  const hinglish = questionLanguage(text) !== null || (found.question ? questionLanguage(found.question) !== null : false);
  const language = listenLanguage({ text, hinglish });
  const said = await (speaker ?? speak)({ text, voice: LISTEN_SPEAKER, language }).catch(() => null);
  const usd = said?.ok ? listenUsd(text.length) : 0;
  await withTenant(bill, (sql) => sql`
    INSERT INTO ask_usage (org_id, user_id, day, questions, usd, listen)
    VALUES (${bill}, ${opts.userId}, ${day}, 0, ${usd}, 1)
    ON CONFLICT (org_id, user_id, day)
    DO UPDATE SET listen = ask_usage.listen + 1, usd = ask_usage.usd + EXCLUDED.usd`);
  if (!said?.ok) return { ok: false, message: "That answer could not be read aloud. Try again." };
  return { ok: true, bytes: said.bytes, type: said.type };
}

/** How many more questions this person may ask today, on `orgId`'s allowance (a firm's own, through a mandate). */
export async function questionsLeft(orgId: string, userId: string, now = new Date()): Promise<number> {
  if (!!limitsLifted()) return DAILY_QUESTIONS;
  const day = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const [row] = await withTenant(orgId, (sql) => sql<{ questions: number }[]>`
    SELECT questions FROM ask_usage WHERE org_id = ${orgId} AND user_id = ${userId} AND day = ${day}`);
  return Math.max(0, DAILY_QUESTIONS - (row?.questions ?? 0));
}

// ---------------------------------------------------------------------------
// Asking, and recording what happened
// ---------------------------------------------------------------------------

export type AskResult =
  | {
      ok: true;
      thread: ThreadSummary & { created: boolean };
      question: AskMessage;
      answer: AskMessage;
      left: number;
      /** Folds this exchange into the chat's summary. Run after the answer has been sent. */
      settle?: () => Promise<void>;
    }
  | { ok: false; message: string };

/**
 * Fold the newest exchange into the chat's running summary and keep it.
 * Runs after the person has their answer, so it never adds to the wait. A
 * model that fails or writes nothing leaves the old summary in place. Its
 * dollars are metered on the question's own row in `ask_usage`.
 */
async function summarize(o: {
  key: ChatKey;
  previous: string | null;
  question: string;
  answer: string;
  day: string;
  /** The organisation whose allowance the summary's dollars join, when not the chat's. */
  billOrgId?: string;
  drivers?: AskDrivers;
}): Promise<void> {
  let next: string | null = null;
  const save: AgentTool = {
    name: "save_summary",
    description: "Save the new summary of the whole chat.",
    parameters: SUMMARY_SCHEMA,
    exclusive: true,
    async run(args): Promise<ToolOutcome> {
      next = cleanSummary(argString(args, "summary"));
      return { text: "Saved.", end: { ok: true } };
    },
  };
  try {
    const r = await runAgent({
      model: SUMMARY_MODEL(),
      effort: "low",
      instructions: summaryInstructions(),
      task: [{ text: summaryTask({ previous: o.previous, question: o.question, answer: o.answer }) }],
      tools: [save],
      // Three, not two: the runtime tells an agent on its second-to-last turn
      // that it is out of budget, and on a two-turn job that note arrives with
      // the first turn and was summarised as something the person had said.
      maxTurns: 3,
      maxUsd: SUMMARY_MAX_USD,
      maxIdle: 1,
      brain: o.drivers?.brain,
    });
    if (r.usd > 0) {
      const bill = o.billOrgId ?? o.key.orgId;
      await withTenant(bill, (sql) => sql`
        INSERT INTO ask_usage (org_id, user_id, day, questions, usd)
        VALUES (${bill}, ${o.key.userId}, ${o.day}, 0, ${r.usd})
        ON CONFLICT (org_id, user_id, day) DO UPDATE SET usd = ask_usage.usd + EXCLUDED.usd`);
    }
  } catch (e) {
    console.warn("ask: the summary was not updated,", (e as Error).message);
  }
  if (next) await keepSummary(o.key, next);
}

export async function askJimmy(opts: {
  orgId: string;
  orgName: string;
  /**
   * A firm's person in this developer's console through a mandate. Jimmy
   * reads the mandated projects only and leaves out the developer's own
   * business (`throughMandate()`), and the question uses the firm's own
   * allowance and is metered to the firm, never to the developer. The chat
   * itself stays in the developer's console, where its answers came from.
   */
  via?: { firmOrgId: string; firmName: string } | null;
  orgType?: string;
  userId: string;
  personName: string | null;
  authz: Pick<Authz, "can" | "canAt" | "scopesFor">;
  question: string;
  threadId: string | null;
  /** Files attached to the question: the project is set up from them. */
  files?: readonly string[];
  now?: Date;
  signal?: AbortSignal;
  onStep?: (text: string) => void;
  onThread?: (thread: ThreadSummary & { created: boolean }) => void;
  drivers?: AskDrivers;
}): Promise<AskResult> {
  const now = opts.now ?? new Date();
  const fileIds = [...new Set((opts.files ?? []).filter((x) => UUID.test(String(x))))].slice(0, SETUP_MAX_FILES);
  const question = (tidyQuestion(opts.question) || (fileIds.length ? "Set up a project from these files" : "")).slice(0, MAX_QUESTION_CHARS);
  if (!question) return { ok: false, message: "Type a question first." };
  const attached = fileIds.length ? await filesNamed(opts.orgId, opts.userId, fileIds) : [];
  if (fileIds.length && attached.length !== fileIds.length) return { ok: false, message: "A file is no longer attached. Attach it again." };
  if (opts.threadId && !UUID.test(opts.threadId)) return { ok: false, message: "That chat could not be found." };
  const day = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

  // Expiry and the allowance, before anything is written or anybody is paid.
  const bill = opts.via?.firmOrgId ?? opts.orgId;
  const usage = await withTenant(opts.orgId, async (sql) => {
    await sql`SELECT ask_expire()`;
    return bill === opts.orgId ? readUsage(sql, bill, opts.userId, day) : null;
  }) ?? (await withTenant(bill, (sql) => readUsage(sql, bill, opts.userId, day)));
  const limit = !limitsLifted() ? overAllowance({ todayByPerson: usage.today, monthByOrg: usage.month, projects: usage.projects, partner: usage.partner }) : null;

  const thread = await withPerson(opts.orgId, opts.userId, async (sql) => {
    if (opts.threadId) {
      const [t] = await sql<{ id: string; title: string; updated_at: Date }[]>`
        SELECT id, title, updated_at FROM ask_threads WHERE id = ${opts.threadId}`;
      return t ? { id: t.id, title: t.title, updatedAt: new Date(t.updated_at).toISOString(), created: false } : null;
    }
    const [t] = await sql<{ id: string; title: string; updated_at: Date }[]>`
      INSERT INTO ask_threads (org_id, user_id, title) VALUES (${opts.orgId}, ${opts.userId}, ${titleFrom(question)})
      RETURNING id, title, updated_at`;
    return { id: t.id, title: t.title, updatedAt: new Date(t.updated_at).toISOString(), created: true };
  });
  if (!thread) return { ok: false, message: "That chat could not be found. It may have been deleted." };
  try {
    opts.onThread?.(thread);
  } catch {
    // The screen went away; the question is still worth recording.
  }

  // The working memory first: the last six exchanges and the summary, one
  // round trip. A store that is off, down or has lost this chat reads as
  // empty, and the exchanges come from Postgres instead.
  const key: ChatKey = { orgId: opts.orgId, userId: opts.userId, threadId: thread.id };
  const kept = await recall(key);
  const { history: said, asked, justAsked } = await withPerson(opts.orgId, opts.userId, async (sql) => {
    const earlier = kept?.turns.length
      ? []
      : await sql<{ role: "PERSON" | "JIMMY"; body: string; action_id: string | null }[]>`
          SELECT role, body, blocks->'action'->>'id' AS action_id FROM ask_messages WHERE thread_id = ${thread.id}
          ORDER BY created_at DESC, role LIMIT ${HISTORY_EXCHANGES * 2}`;
    // Whether Jimmy's last word here was a question back.
    const [last] = await sql<{ outcome: string | null }[]>`
      SELECT outcome FROM ask_messages WHERE thread_id = ${thread.id} AND role = 'JIMMY'
      ORDER BY created_at DESC LIMIT 1`;
    const [row] = await sql<DbMessage[]>`
      INSERT INTO ask_messages (org_id, thread_id, user_id, role, body, blocks)
      VALUES (${opts.orgId}, ${thread.id}, ${opts.userId}, 'PERSON', ${question}, ${sql.json({ ...NO_BLOCKS, files: attached } as never)})
      RETURNING id, role, body, blocks, outcome, created_at`;
    // A Stop pressed for an earlier question is not a Stop for this one.
    await sql`UPDATE ask_threads SET stop_requested_at = NULL WHERE id = ${thread.id}`;
    return {
      history: earlier.reverse().map((m): MemoryTurn => ({ role: m.role, body: m.body, actionId: m.action_id })),
      asked: toMessage(row),
      justAsked: last?.outcome === "CLARIFY",
    };
  });
  const turns = kept?.turns.length ? kept.turns : said;
  // A store that answered but had nothing (new, or it evicted the chat) is
  // given the chat back.
  if (kept && !kept.turns.length && said.length) await remember(key, said);
  // A card's own line in the chat ("Here it is") says nothing about what it
  // was; the chat remembers it as what it did, for whom, and how it ended.
  // Read fresh from Postgres, because a card moves on after its message.
  const memory = await chatMemory(opts.orgId, opts.userId, thread.id);
  const history = turns.map((m) => ({
    role: m.role,
    body: m.actionId && memory.cards.has(m.actionId) ? `${m.body} ${memory.cards.get(m.actionId)}` : m.body,
  }));

  let result: Answer;
  let setupId: string | null = null;
  if (limit) {
    result = {
      outcome: "LIMIT",
      body: limit,
      blocks: { ...NO_BLOCKS },
      meta: { kind: "limit", topics: [], denied: [], notBuilt: [], tools: [], model: null, turns: 0, usd: 0 },
    };
  } else if (fileIds.length) {
    // Files attached: the project is set up from them, in a card of its own.
    // The reading runs after the answer has gone (`settle`), and the card
    // reads how it is doing.
    opts.onStep?.("Opening your files");
    const started = await startSetup({
      orgId: opts.orgId,
      userId: opts.userId,
      threadId: thread.id,
      said: opts.question.trim() ? question : "",
      fileIds,
      authz: opts.authz,
      orgType: opts.orgType ?? "DEVELOPER",
      via: opts.via ?? null,
    });
    const meta: AskMeta = { kind: null, topics: [], denied: [], notBuilt: [], tools: ["setup"], model: null, turns: 0, usd: 0 };
    if (started.ok) {
      setupId = started.id;
      result = {
        outcome: "ANSWERED",
        body: `${started.added ? "I'm reading the new files with the others." : "I'm reading your files. It takes a minute or two, and you can leave this chat meanwhile."}${started.note ? ` ${started.note}` : ""}`,
        blocks: { ...NO_BLOCKS, setup: { id: started.id } },
        meta,
      };
    } else {
      result = { outcome: "REFUSED", body: started.message, blocks: { ...NO_BLOCKS }, meta };
    }
  } else {
    const stop = watchForStop(opts.orgId, opts.userId, thread.id, opts.signal);
    try {
      result = await answerQuestion({
        orgId: opts.orgId,
        orgName: opts.orgName,
        orgType: opts.orgType,
        personName: opts.personName,
        authz: opts.authz,
        question,
        history,
        named: memory.named,
        summary: kept?.summary ?? null,
        now,
        signal: stop.signal,
        onStep: opts.onStep,
        drivers: opts.drivers,
        threadId: thread.id,
        userId: opts.userId,
        justAsked,
        via: opts.via ?? null,
      });
    } catch (e) {
      console.error("ask: answering failed", e);
      result = {
        outcome: "FAILED",
        body: "Something went wrong while I was looking. Try again.",
        blocks: { ...NO_BLOCKS },
        meta: { kind: null, topics: [], denied: [], notBuilt: [], tools: [], model: null, turns: 0, usd: 0 },
      };
    } finally {
      stop.end();
    }
  }

  // The chat can be deleted while its question runs; the answer then has
  // nowhere to go, but what it cost is still metered below.
  const answered = await withPerson(opts.orgId, opts.userId, async (sql) => {
    const [still] = await sql`SELECT 1 FROM ask_threads WHERE id = ${thread.id}`;
    if (!still) return null;
    const [row] = await sql<DbMessage[]>`
      INSERT INTO ask_messages (org_id, thread_id, user_id, role, body, blocks, outcome, meta)
      VALUES (${opts.orgId}, ${thread.id}, ${opts.userId}, 'JIMMY', ${result.body.slice(0, 4000)},
              ${sql.json(result.blocks as never)}, ${result.outcome}, ${sql.json(result.meta as never)})
      RETURNING id, role, body, blocks, outcome, created_at`;
    await sql`UPDATE ask_threads SET updated_at = now(), stop_requested_at = NULL WHERE id = ${thread.id}`;
    return toMessage(row);
  });

  // Metering: a question that reached a model counts, whatever came back.
  if (result.outcome !== "LIMIT") {
    await withTenant(bill, (sql) => sql`
      INSERT INTO ask_usage (org_id, user_id, day, questions, usd)
      VALUES (${bill}, ${opts.userId}, ${day}, 1, ${result.meta.usd})
      ON CONFLICT (org_id, user_id, day)
      DO UPDATE SET questions = ask_usage.questions + 1, usd = ask_usage.usd + EXCLUDED.usd`);
    await meterQuestion(bill, answered?.id ?? null, result.meta.usd);
  }
  // Codes and counts only: the question and the answer can name a buyer.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "ask.answered",
    targetType: "ask_thread",
    targetId: thread.id,
    metadata: {
      outcome: result.outcome,
      kind: result.meta.kind,
      topics: result.meta.topics,
      denied: result.meta.denied,
      not_built: result.meta.notBuilt,
      tools: result.meta.tools.length,
      usd: result.meta.usd,
      rs: Math.round(result.meta.usd * USD_TO_RS * 100) / 100,
    },
  });

  const left = !!limitsLifted() ? DAILY_QUESTIONS : Math.max(0, DAILY_QUESTIONS - usage.today - (result.outcome === "LIMIT" ? 0 : 1));
  if (!answered) return { ok: false, message: "That chat was deleted." };
  if (result.actionView) answered.action = result.actionView;
  const setup = setupId ? await setupView(opts.orgId, opts.userId, setupId) : null;
  if (setup) answered.setup = setup;

  await remember(key, [
    { role: "PERSON", body: question, actionId: null },
    { role: "JIMMY", body: setup ? `${result.body} ${setupMemory(setup)}` : result.body, actionId: result.blocks.action?.id ?? null },
  ]);
  // The summary is only rewritten from one the store actually gave back: a
  // store that could not be read would otherwise have it rebuilt from this one
  // exchange. An allowance line, a stop or a failure adds nothing to it.
  const worthKeeping = !["LIMIT", "STOPPED", "FAILED"].includes(result.outcome);
  const settle =
    kept && memoryStore() && worthKeeping
      ? () =>
          summarize({
            key,
            previous: kept.summary,
            question,
            answer: result.actionView ? `${result.body} ${cardMemory(result.actionView)}` : result.body,
            day,
            billOrgId: bill,
            drivers: opts.drivers,
          })
      : undefined;
  // The files are read once the answer is on screen; the summary waits for nothing.
  const reading = setupId ? () => readSetup(opts.orgId, opts.userId, setupId!) : undefined;
  const after = reading || settle ? async () => {
    if (reading) await reading().catch((e) => console.error("ask: reading the files failed", e));
    if (settle) await settle();
  } : undefined;
  return { ok: true, thread, question: asked, answer: answered, left, settle: after };
}

/** For the empty chat: a few questions this person can actually get answers to. */
export function startersForViewer(
  authz: Pick<Authz, "can" | "scopesFor">,
  orgType?: string | null,
): { topics: TopicKey[]; starters: string[] } {
  const topics = accessibleTopics({ ...authz, orgType: orgType ?? null });
  return { topics, starters: startersFor(topics, 6) };
}

export function topicLabels(keys: readonly TopicKey[]): string[] {
  return keys.map((k) => topicByKey(k)?.inline ?? k);
}

/** A dataset's step words, for the screen. */
export function stepFor(datasetKey: string): string {
  return STEP_WORDS[datasetKey] ?? `Checking ${datasetByKey(datasetKey)?.label.toLowerCase() ?? "your data"}`;
}

