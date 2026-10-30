/**
 * Ask Jimmy's actions: what Jimmy may do, and the one path every action takes.
 *
 * Jimmy proposes, a person confirms, and the server runs the same function
 * the screen's button runs. Three rules hold it together:
 *
 *   1. No new powers. Each action needs the permission its screen needs, held
 *      at the tower (or post, or ad) it acts on. It is offered only to people
 *      who hold the key somewhere, and checked again at the target when they
 *      confirm, against their keys as they stand at that moment.
 *   2. Code asks for what is missing. Each action's `step()` works out, from
 *      what the request said and what has been picked, the next question or
 *      the confirm card. Records are offered from the person's own reach;
 *      fixed choices from the product's lists. The model never writes an
 *      option that names a record.
 *   3. Nothing runs without a press. A card expires after ten minutes, and the
 *      move to RUNNING is one guarded UPDATE, so it runs once.
 *
 * The executors are imported when an action runs rather than at the top: a
 * post pulls in the compositor, and a question about leads should not.
 *
 * Imports are relative because the checks load this straight from source.
 */

import { LANGUAGES } from "./campaign-rules.ts";
import { audit, withPerson, withTenant, withTenantReadOnly } from "./db/index.ts";
import { limitsLifted } from "./plan-purchase-rules.ts";
import { minimalScopes, scopeCovers, type Authz } from "./rbac-rules.ts";
import {
  anyOf,
  answerProblem,
  cardMemory,
  applyAnswer,
  dateOptions,
  dayLabel,
  DAILY_MAKES,
  expiresAt,
  hasExpired,
  istToday,
  isUsualCall,
  priorCall,
  many,
  maskedPhone,
  matchOption,
  MAX_QUESTIONS,
  one,
  oneOf,
  readDate,
  readRupees,
  readTime,
  recap,
  RECORD_OPTIONS,
  timeLabel,
  typed,
  type ActionResult,
  type ActionState,
  type ActionView,
  type Answer,
  type Draft,
  type NextAction,
  type Preview,
  type Question,
  type QuestionOption,
} from "./ask-actions-rules.ts";
import {
  FIELDS,
  INTEREST,
  OBJECTIONS,
  STAGES,
  VISIT_SLOTS,
  isPath,
  istClock,
  planMove,
  stageLabel,
  validateMove,
  type Facts,
  type FieldKey,
  type LeadState,
  type MoveInput,
  type PathStage,
  type StageKey,
} from "./lead-rules.ts";
import { NEXT_STEPS } from "./visit-rules.ts";
import { POST_KINDS, kindUnavailable, placementsFor, type PostKind } from "./compose-rules.ts";
import { segmentLabel } from "./creative-rules.ts";
import { CALL_GOALS, goalProblem, goalText, normalisePhone, numberIn, phoneProblem, withoutPrice, type CallGoal } from "./calling-rules.ts";
import { goalCallsOn, projectFactsOn } from "./sarvam.ts";
import { withoutQuotes, type TopicKey } from "./ask-rules.ts";
import { bestRecords } from "./ask-help.ts";
import { guessLanguage } from "./name-language-rules.ts";

export type ActionCtx = {
  orgId: string;
  userId: string;
  authz: Pick<Authz, "can" | "canAt" | "scopesFor">;
  now: Date;
  /** The chat the card is in, so a step can read the chat's earlier cards. */
  threadId?: string;
  /** A firm's person working through a mandate: some moves are the developer's alone. */
  via?: { firmOrgId: string; firmName: string } | null;
};

type Target = { type: string; id: string; path: string };

/** What a step decides: ask, refuse (with a next step to offer), or show the confirm card. */
type Step =
  | { ask: Question[] }
  | { refuse: string; next?: NextAction[] }
  | { ready: { preview: Preview; target: Target; keys?: string[] } };

type Run =
  | { ok: true; result: ActionResult; running?: boolean; later?: () => Promise<void> }
  | { ok: false; message: string };

type ActionDef = {
  kind: string;
  label: string;
  topic: TopicKey;
  level: 1 | 2;
  /** Every one is needed, at the target. */
  keys: string[];
  /** Any one of these is enough, at the target. */
  anyKeys?: string[];
  /** For the model: what it does and which inputs it may fill from the request. */
  detail: string;
  inputs: string[];
  /** Counts against `DAILY_MAKES`. */
  makes?: boolean;
  /** Runs after the confirm press has been answered: minutes, not seconds. */
  background?: boolean;
  /** What the card says while it runs. */
  working: string;
  /** Recap titles for the inputs a person picked. */
  titles: Record<string, string>;
  /** The card's heading while it asks, from what is known so far. */
  heading?: (d: Draft) => string;
  /** Inputs the heading already names, so the recap does not say them twice. */
  headed?: string[];
  step: (ctx: ActionCtx, d: Draft) => Promise<Step>;
  run: (ctx: ActionCtx, d: Draft, target: Target) => Promise<Run>;
};

// ---------------------------------------------------------------------------
// Reading what the person may act on
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where every one of `keys` holds: a place under a scope of each. */
function reach(ctx: ActionCtx, keys: string[]): string[] {
  let acc: string[] | null = null;
  for (const k of keys) {
    const scopes = minimalScopes(ctx.authz.scopesFor(k));
    if (!scopes.length) return [];
    if (acc === null) {
      acc = scopes;
      continue;
    }
    const both: string[] = [];
    for (const a of acc) {
      for (const b of scopes) {
        if (scopeCovers(a, b)) both.push(b);
        else if (scopeCovers(b, a)) both.push(a);
      }
    }
    acc = minimalScopes(both);
    if (!acc.length) return [];
  }
  return acc ?? [];
}

const PLACE_SQL = (n: string) => `CASE WHEN ${n}.kind = 'PHASE' THEN coalesce(pj.name || ' · ', '') || ${n}.name ELSE ${n}.name END`;

const like = (hint: string) => `%${hint.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const STOP_WORDS = new Set([
  "the", "a", "an", "for", "of", "to", "on", "in", "my", "our", "called", "named", "one", "that", "this",
  "campaign", "campaigns", "brief", "post", "posts", "schedule", "ad", "ads", "lead", "tower", "project",
]);

/** The words in a hint worth matching, lower case. */
function tokens(words: string): string[] {
  return words
    .toLowerCase()
    .replace(/[·_\-/,.:'"]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/** Whether two words are one letter apart: one changed, added or dropped. */
function oneOff(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Every word of the hint appears somewhere in the record's text. A word of
 * four letters or more may be one letter off a word there, because a person
 * types "Seth Heights" for Sath Heights, and a hint that matched nothing
 * offered every campaign instead of the one named.
 */
function namedBy(text: string, words: string): boolean {
  const t = text.toLowerCase();
  const own = t.split(/[^a-z0-9ऀ-ॿ]+/).filter(Boolean);
  return tokens(words).every((w) => t.includes(w) || (w.length >= 4 && own.some((o) => o.length >= 4 && oneOff(w, o))));
}

/** Hint a record by id (a next step names it) or by words (a person said it). */
function byHint(hint: string): { id: string | null; words: string } {
  const h = hint.trim();
  return UUID.test(h) ? { id: h, words: "" } : { id: null, words: h.slice(0, 120) };
}

type Got<T> = { ok: true; value: T } | { ok: false; step: Step };

/**
 * One record chosen, from what was picked, what was said, or a question.
 * `find` returns candidates within reach: for an id, that record; for words,
 * the records they name; for nothing, the most recent few.
 */
async function pickRecord<T extends { id: string }>(
  d: Draft,
  input: string,
  title: string,
  find: (q: { id: string | null; words: string }) => Promise<T[]>,
  option: (r: T) => QuestionOption,
  noun: string,
): Promise<Got<T>> {
  const picked = one(d, input);
  if (picked) {
    const [again] = await find({ id: picked.v, words: "" });
    if (again) return { ok: true, value: again };
    delete d.filled[input];
    const recent = await find({ id: null, words: "" });
    if (!recent.length) return { ok: false, step: { refuse: `That ${noun} is no longer within your reach.` } };
    return { ok: false, step: { ask: [oneOf(input, title, recent.slice(0, RECORD_OPTIONS).map(option), { note: `That ${noun} is no longer within your reach.` })] } };
  }
  const hint = d.hints[input];
  if (hint) {
    const q = byHint(hint);
    const found = await find(q);
    if (found.length === 1) {
      const o = option(found[0]);
      d.filled[input] = { v: o.value, label: o.label };
      delete d.hints[input];
      return { ok: true, value: found[0] };
    }
    // "QA Test 1" also matches "QA Test 2", whose short words a search skips;
    // a record named exactly what was said is the one meant.
    const exact = found.filter((r) => sameName(option(r).label, q.words));
    if (found.length > 1 && exact.length === 1) {
      const o = option(exact[0]);
      d.filled[input] = { v: o.value, label: o.label };
      delete d.hints[input];
      return { ok: true, value: exact[0] };
    }
    if (found.length > 1) {
      const note = found.length > RECORD_OPTIONS ? `More than ${RECORD_OPTIONS} match "${q.words}". Type more of the name to narrow it.` : null;
      return { ok: false, step: { ask: [oneOf(input, title, found.slice(0, RECORD_OPTIONS).map(option), { note })] } };
    }
    const recent = await find({ id: null, words: "" });
    if (!recent.length) return { ok: false, step: { refuse: `There is no ${noun} you can act on here.` } };
    return {
      ok: false,
      step: { ask: [oneOf(input, title, recent.slice(0, RECORD_OPTIONS).map(option), { note: q.words ? `Nothing matches "${q.words}".` : null })] },
    };
  }
  const recent = await find({ id: null, words: "" });
  if (!recent.length) return { ok: false, step: { refuse: `There is no ${noun} you can act on here.` } };
  return { ok: false, step: { ask: [oneOf(input, title, recent.slice(0, RECORD_OPTIONS).map(option))] } };
}

/**
 * A fixed choice, from what was picked, what was said, or a question. With
 * `free`, the card offers Other and text that matches no option is kept as
 * written (a reason, a next step); without it, only the options will do.
 */
function pickChoice(d: Draft, input: string, title: string, options: QuestionOption[], opts: { note?: string | null; free?: boolean } = {}): Got<string> {
  const free = opts.free ?? false;
  const picked = one(d, input);
  if (picked && (free || options.some((o) => o.value === picked.v && !o.disabled))) return { ok: true, value: picked.v };
  if (picked) delete d.filled[input];
  const hint = d.hints[input];
  if (hint) {
    const hit = matchOption(hint, options);
    if (hit) {
      d.filled[input] = { v: hit.value, label: hit.label };
      delete d.hints[input];
      return { ok: true, value: hit.value };
    }
    const closed = matchOption(hint, options.map((o) => ({ ...o, disabled: null })));
    const why = closed ? options.find((o) => o.value === closed.value)?.disabled : null;
    if (closed && why) {
      delete d.hints[input];
      return { ok: false, step: { ask: [oneOf(input, title, options, { note: `${closed.label}: ${why.charAt(0).toLowerCase()}${why.slice(1)}.`, other: free })] } };
    }
    if (free) {
      const v = hint.slice(0, 200);
      d.filled[input] = { v, label: v };
      delete d.hints[input];
      return { ok: true, value: v };
    }
    delete d.hints[input];
    return { ok: false, step: { ask: [oneOf(input, title, options, { note: `"${hint.slice(0, 60)}" is not one of these.`, other: false })] } };
  }
  return { ok: false, step: { ask: [oneOf(input, title, options, { note: opts.note ?? null, other: free })] } };
}

function pickMany(d: Draft, input: string, title: string, options: QuestionOption[], note: string | null = null): Got<string[]> {
  const picked = many(d, input);
  if (picked) {
    const live = picked.vs.filter((v) => options.some((o) => o.value === v && !o.disabled));
    if (live.length) return { ok: true, value: live };
    delete d.filled[input];
  }
  const hint = d.hints[input];
  if (hint) {
    const parts = hint.split(/,|\band\b|&|\+/i).map((s) => s.trim()).filter(Boolean);
    const hits = parts.map((p) => matchOption(p, options)).filter((o): o is QuestionOption => !!o);
    if (hits.length && hits.length === parts.length) {
      const uniq = [...new Map(hits.map((o) => [o.value, o])).values()];
      d.filled[input] = { vs: uniq.map((o) => o.value), labels: uniq.map((o) => o.label) };
      delete d.hints[input];
      return { ok: true, value: uniq.map((o) => o.value) };
    }
  }
  return { ok: false, step: { ask: [anyOf(input, title, options, { note })] } };
}

/** Free text: what was typed, checked by `check`, which returns the value to keep or a problem. */
function pickText(
  d: Draft,
  input: string,
  title: string,
  placeholder: string,
  check: (s: string) => { value: string; label?: string } | { problem: string },
  suggestions: QuestionOption[] = [],
): Got<string> {
  const picked = one(d, input);
  if (picked) return { ok: true, value: picked.v };
  const hint = d.hints[input];
  if (hint !== undefined && hint.trim()) {
    const r = check(hint.trim());
    if ("value" in r) {
      d.filled[input] = { v: r.value, label: r.label ?? r.value };
      delete d.hints[input];
      return { ok: true, value: r.value };
    }
    delete d.hints[input];
    return { ok: false, step: { ask: [typed(input, title, placeholder, { note: r.problem, options: suggestions })] } };
  }
  return { ok: false, step: { ask: [typed(input, title, placeholder, { options: suggestions })] } };
}

// --- a call's goal -----------------------------------------------------------------

const USUAL_CALL: QuestionOption = { value: "usual", label: "The usual call", detail: "Qualify them" };
const NAMED_GOALS = new Set(["usual", ...CALL_GOALS.map((g) => g.key)]);

/** The never-say lines that reach a lead's tower, for checking a goal before it is proposed. */
async function neverSayAt(orgId: string, nodeId: string): Promise<string[]> {
  const { resolveBrain } = await import("./brain.ts");
  const brain = await resolveBrain(orgId, nodeId);
  return (brain?.values["claims.never_say"] ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * What the call is for: the usual qualifying call (null), a goal by name, or
 * the person's own words. A goal the person said is kept as they said it; one
 * they did not say is asked, with the usual call first. With goal calls not
 * switched on, a goal is refused rather than quietly dropped, and the usual
 * call is offered in its place.
 */
async function pickGoal(
  ctx: ActionCtx,
  d: Draft,
  lead: Pick<LeadRec, "name" | "stage" | "node_id">,
  usual: NextAction,
): Promise<Got<CallGoal | null>> {
  const said = d.hints.goal?.trim() ?? "";
  if (!goalCallsOn()) {
    if (said && matchOption(said, [USUAL_CALL])?.value !== "usual") {
      return {
        ok: false,
        step: {
          refuse: "Calls with a goal are not switched on yet, so the agent can only make its usual qualifying call.",
          next: [usual],
        },
      };
    }
    delete d.hints.goal;
    return { ok: true, value: null };
  }

  const visited = lead.stage === "visit_done" || lead.stage === "negotiation";
  const options: QuestionOption[] = [
    USUAL_CALL,
    ...CALL_GOALS.filter((g) => g.key !== "after_visit" || visited).map((g) => ({ value: g.key, label: g.label })),
  ];
  const title = `What should the call to ${lead.name.split(/\s+/)[0]} do?`;

  if (!one(d, "goal") && said) {
    delete d.hints.goal;
    const hit = matchOption(said, options) ?? (isUsualCall(said) ? USUAL_CALL : null);
    if (hit) d.filled.goal = { v: hit.value, label: hit.label };
    else d.filled.goal = { v: said, label: said.charAt(0).toUpperCase() + said.slice(1) };
  }
  const picked = one(d, "goal");
  if (!picked) return { ok: false, step: { ask: [oneOf("goal", title, options)] } };
  if (picked.v === "usual") return { ok: true, value: null };

  if (picked.v === "after_visit") return { ok: true, value: { key: "after_visit", text: goalText({ key: "after_visit" }) } };

  if (picked.v === "site_visit") {
    const today = istToday(ctx.now);
    const last = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    const any: QuestionOption = { value: "any", label: "Any day that suits them" };
    const day = pickText(
      d,
      "day",
      `Which day should ${lead.name.split(/\s+/)[0]} come?`,
      "A day, like 28 Sep",
      (s) => {
        if (/^any\b/i.test(s)) return { value: "any", label: any.label };
        const v = readDate(s, today, "future");
        return v && v >= today && v <= last ? { value: v, label: dayLabel(v) } : { problem: "Pick a day in the next month." };
      },
      [any, ...dateOptions(today, "future")],
    );
    if (!day.ok) return day;
    return { ok: true, value: { key: "site_visit", text: goalText({ key: "site_visit", day: day.value === "any" ? null : day.value }) } };
  }

  // The person's own words: checked here so a bad one is sent back before
  // anything is proposed, and again by `placeCall` before anything is dialled.
  if (!NAMED_GOALS.has(picked.v)) {
    const never = await neverSayAt(ctx.orgId, lead.node_id);
    const problem = goalProblem(picked.v, never);
    if (problem) {
      delete d.filled.goal;
      // A goal whose only fault is its price is offered back without it, first.
      const cut = withoutPrice(picked.v, never);
      const offered: QuestionOption[] = cut ? [{ value: cut, label: cut.charAt(0).toUpperCase() + cut.slice(1), detail: "What you asked, without the price" }, ...options] : options;
      return { ok: false, step: { ask: [oneOf("goal", title, offered, { note: problem, default: cut })] } };
    }
    return { ok: true, value: { key: "custom", text: picked.v } };
  }
  delete d.filled.goal;
  return { ok: false, step: { ask: [oneOf("goal", title, options)] } };
}

/** The goal a card holds, as the call takes it: null is the usual call. */
function goalOf(d: Draft): CallGoal | null {
  const picked = one(d, "goal")?.v ?? "usual";
  const day = one(d, "day")?.v ?? "any";
  if (picked === "usual") return null;
  if (picked === "site_visit") return { key: "site_visit", text: goalText({ key: "site_visit", day: day === "any" ? null : day }) };
  if (picked === "after_visit") return { key: "after_visit", text: goalText({ key: "after_visit" }) };
  return { key: "custom", text: picked };
}

/** Two names are one when they match ignoring case, spaces and dots. */
function sameName(a: string, b: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/[.\s]+/g, " ").trim();
  return n(a) === n(b);
}

/**
 * The tower a person's own work is on: where they last placed a call, else
 * the tower of the most recently worked lead they can reach, else the first.
 */
async function usualTower(ctx: ActionCtx, find: (q: { id: string | null; words: string }) => Promise<NodeRec[]>): Promise<NodeRec | null> {
  const rows = await withTenantReadOnly(ctx.orgId, (sql) => sql<{ id: string }[]>`
    (SELECT scope_node_id AS id FROM calls WHERE org_id = ${ctx.orgId} AND placed_by = ${ctx.userId}
      ORDER BY placed_at DESC NULLS LAST LIMIT 1)
    UNION ALL
    (SELECT scope_node_id AS id FROM leads WHERE org_id = ${ctx.orgId} ORDER BY last_activity_at DESC NULLS LAST LIMIT 1)`);
  for (const r of rows) {
    const [n] = await find({ id: r.id, words: "" });
    if (n) return n;
  }
  const [first] = await find({ id: null, words: "" });
  return first ?? null;
}

/** How a goal reads on the card. */
/**
 * The tower a call is about. Every call is about one, so the agent is handed
 * its facts: the one the person named, or asked, with the tower the buyer
 * enquired about first and already picked. Only towers the person may call
 * about are offered; with just one, it is that one.
 */
async function pickCallTower(ctx: ActionCtx, d: Draft, lead: LeadRec): Promise<Got<NodeRec>> {
  const got = await pickCallTowerAny(ctx, d, lead);
  if (!got.ok) return got;
  // The RERA gate costs a query, so it is asked before the card offers "Call
  // now": a card for a tower that may not be advertised offered the button
  // and failed only when it was pressed.
  const { canPublish } = await import("./publish-gate.ts");
  const gate = await canPublish(ctx.orgId, got.value.id);
  if (gate.ok) return got;
  delete d.filled.project;
  delete d.filled.projectWhy;
  delete d.hints.project;
  const towers = await nodeFinder(ctx, ["lead:call"], ["PHASE"])({ id: null, words: "" });
  const open: NodeRec[] = [];
  for (const n of towers) if (n.id !== got.value.id && (await canPublish(ctx.orgId, n.id)).ok) open.push(n);
  const why = `${got.value.place} cannot be advertised yet, so the AI does not call about it.`;
  if (!open.length) return { ok: false, step: { refuse: `${why} No other tower you call about can be either.` } };
  return {
    ok: false,
    step: {
      ask: [
        oneOf(
          "project",
          `Which project is the call to ${lead.name.split(/\s+/)[0]} about?`,
          open.slice(0, RECORD_OPTIONS).map((n) => ({ value: n.id, label: n.place, detail: "Tower" })),
          { note: why },
        ),
      ],
    },
  };
}

async function pickCallTowerAny(ctx: ActionCtx, d: Draft, lead: LeadRec): Promise<Got<NodeRec>> {
  const all = nodeFinder(ctx, ["lead:call"], ["PHASE"]);
  const find = async (q: { id: string | null; words: string }) => {
    const rows = await all(q);
    if (q.id || q.words) return rows;
    const [own] = await all({ id: lead.node_id, words: "" });
    return own ? [own, ...rows.filter((r) => r.id !== own.id)] : rows;
  };
  const option = (n: NodeRec): QuestionOption => ({ value: n.id, label: n.place, detail: n.id === lead.node_id ? "Enquired about" : "Tower" });
  const title = `Which project is the call to ${lead.name.split(/\s+/)[0]} about?`;
  // A lead already worked on a tower is not asked again: the tower of their
  // booked visit, else the tower of the last call to them, by anybody, in
  // any chat. Only a lead nobody has called yet is asked.
  if (!one(d, "project") && !d.hints.project) {
    const known = await withTenantReadOnly(ctx.orgId, (sql) => sql<{ id: string; why: string }[]>`
      (SELECT scope_node_id AS id, 'visit' AS why FROM site_visits
        WHERE org_id = ${ctx.orgId} AND lead_id = ${lead.id}
          AND status IN ('REQUESTED', 'CONFIRMED', 'ON_SITE') AND scheduled_at > now() - interval '4 hours'
        ORDER BY scheduled_at LIMIT 1)
      UNION ALL
      (SELECT scope_node_id AS id, 'call' AS why FROM calls
        WHERE org_id = ${ctx.orgId} AND lead_id = ${lead.id}
        ORDER BY placed_at DESC NULLS LAST LIMIT 1)`);
    for (const k of known) {
      const [n] = await all({ id: k.id, words: "" });
      if (!n) continue;
      d.filled.project = { v: n.id, label: n.place };
      d.filled.projectWhy = { v: k.why, label: k.why === "visit" ? "where the visit is booked" : "as the last call" };
      return { ok: true, value: n };
    }
  }
  if (!one(d, "project") && !d.hints.project) {
    const offered = await find({ id: null, words: "" });
    if (!offered.length) return { ok: false, step: { refuse: "There is no tower you can call about." } };
    if (offered.length === 1) {
      d.filled.project = { v: offered[0].id, label: offered[0].place };
      return { ok: true, value: offered[0] };
    }
    const shown = offered.slice(0, RECORD_OPTIONS);
    return { ok: false, step: { ask: [oneOf("project", title, shown.map(option), { default: shown[0].id === lead.node_id ? lead.node_id : null })] } };
  }
  return pickRecord(d, "project", title, find, option, "tower");
}

function goalLine(d: Draft, goal: CallGoal): string {
  if (goal.key === "custom") return `Goal: ${one(d, "goal")?.label ?? goal.text}`;
  const named = CALL_GOALS.find((g) => g.key === goal.key)?.label ?? goal.text;
  const day = one(d, "day");
  return goal.key === "site_visit" && day && day.v !== "any"
    ? `Goal: ${named}, ${day.label.replace(/^(Today|Tomorrow)\b/, (w) => w.toLowerCase())}`
    : `Goal: ${named}`;
}

// --- the records ----------------------------------------------------------------

type LeadRec = {
  id: string;
  name: string;
  stage: StageKey;
  path_stage: PathStage;
  facts: Facts;
  exit_reason: string | null;
  follow_up_on: string | null;
  needs_person: string | null;
  automation: "ON" | "PAUSED";
  phone: string;
  node_id: string;
  path: string;
  place: string;
};

function leadFinder(ctx: ActionCtx, keys: string[], filter: "needs" | null = null) {
  return async (q: { id: string | null; words: string }): Promise<LeadRec[]> => {
    const scopes = reach(ctx, keys);
    if (!scopes.length) return [];
    // A typed number finds the leads that hold it, never one by name.
    const phone = !q.id && /^\+?[\d\s-]{10,16}$/.test(q.words.trim()) ? normalisePhone(q.words) : null;
    if (phone) {
      return withTenantReadOnly(ctx.orgId, (sql) => sql<LeadRec[]>`
        SELECT l.id, l.name, l.stage, l.path_stage, l.facts, l.exit_reason, to_char(l.follow_up_on, 'YYYY-MM-DD') AS follow_up_on,
               l.needs_person, l.automation, l.phone, n.id AS node_id, n.path::text AS path,
               ${sql.unsafe(PLACE_SQL("n"))} AS place
        FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
        LEFT JOIN scope_nodes pj ON pj.org_id = n.org_id AND pj.kind = 'PROJECT' AND n.path <@ pj.path
        WHERE l.org_id = ${ctx.orgId} AND n.path <@ ANY(${scopes}::ltree[]) AND l.phone = ${phone}
          AND l.stage NOT IN ('booked', 'lost')
        ORDER BY l.last_activity_at DESC
        LIMIT 6`);
    }
    return withTenantReadOnly(ctx.orgId, (sql) => sql<LeadRec[]>`
      SELECT l.id, l.name, l.stage, l.path_stage, l.facts, l.exit_reason, to_char(l.follow_up_on, 'YYYY-MM-DD') AS follow_up_on,
             l.needs_person, l.automation, l.phone, n.id AS node_id, n.path::text AS path,
             ${sql.unsafe(PLACE_SQL("n"))} AS place
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      LEFT JOIN scope_nodes pj ON pj.org_id = n.org_id AND pj.kind = 'PROJECT' AND n.path <@ pj.path
      WHERE l.org_id = ${ctx.orgId} AND n.path <@ ANY(${scopes}::ltree[])
        AND ${q.id ? sql`l.id = ${q.id}` : tokens(q.words)[0] ? sql`l.name ILIKE ${like(tokens(q.words)[0])}` : sql`true`}
        AND ${filter === "needs" ? sql`l.needs_person IS NOT NULL AND l.stage NOT IN ('booked', 'lost')` : sql`true`}
      ORDER BY l.last_activity_at DESC
      LIMIT 50`).then((rows) => (q.words ? rows.filter((r) => namedBy(r.name, q.words)) : rows).slice(0, 6));
  };
}

const leadOption = (l: LeadRec): QuestionOption => ({ value: l.id, label: l.name, detail: `${l.place} · ${stageLabel(l.stage)}` });

type NodeRec = { id: string; kind: string; name: string; path: string; place: string };

function nodeFinder(ctx: ActionCtx, keys: string[], kinds: string[]) {
  return async (q: { id: string | null; words: string }): Promise<NodeRec[]> => {
    const scopes = reach(ctx, keys);
    if (!scopes.length) return [];
    const rows = await withTenantReadOnly(ctx.orgId, (sql) => sql<NodeRec[]>`
      SELECT n.id, n.kind, n.name, n.path::text AS path, ${sql.unsafe(PLACE_SQL("n"))} AS place
      FROM scope_nodes n
      LEFT JOIN scope_nodes pj ON pj.org_id = n.org_id AND pj.kind = 'PROJECT' AND n.path <@ pj.path
      WHERE n.org_id = ${ctx.orgId} AND n.kind = ANY(${kinds}::text[]) AND n.path <@ ANY(${scopes}::ltree[])
        AND ${q.id ? sql`n.id = ${q.id}` : sql`true`}
      ORDER BY n.path
      LIMIT 60`);
    if (!q.words) return rows.slice(0, 6);
    const w = q.words.toLowerCase().replace(/[·\-_]+/g, " ").replace(/\s+/g, " ").trim();
    const exact = rows.filter((r) => r.name.toLowerCase() === w || r.place.toLowerCase().replace(/[·\-_]+/g, " ").replace(/\s+/g, " ") === w);
    if (exact.length) return exact;
    const within = rows.filter((r) => r.place.toLowerCase().includes(w));
    if (within.length) return within;
    // "seth heights tower C" is Sath Heights · Tower C: a word a letter off
    // still counts, and the tower that carries the most of what was said wins.
    // Asked for a tower by name, the card said "Nothing matches" and offered
    // all four.
    const ids = new Set(bestRecords(q.words, rows.map((r) => ({ id: r.id, label: r.place }))).map((r) => r.id));
    return rows.filter((r) => ids.has(r.id));
  };
}

const nodeOption = (n: NodeRec): QuestionOption => ({ value: n.id, label: n.place, detail: n.kind === "PROJECT" ? "Project" : "Tower" });

type BriefRec = { id: string; name: string; status: string; formats: string[]; languages: string[]; path: string; place: string };

function briefFinder(ctx: ActionCtx, keys: string[]) {
  return async (q: { id: string | null; words: string }): Promise<BriefRec[]> => {
    const scopes = reach(ctx, keys);
    if (!scopes.length) return [];
    return withTenantReadOnly(ctx.orgId, (sql) => sql<BriefRec[]>`
      SELECT b.id, b.name, b.status, b.formats, b.languages, n.path::text AS path, ${sql.unsafe(PLACE_SQL("n"))} AS place
      FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      LEFT JOIN scope_nodes pj ON pj.org_id = n.org_id AND pj.kind = 'PROJECT' AND n.path <@ pj.path
      WHERE b.org_id = ${ctx.orgId} AND n.path <@ ANY(${scopes}::ltree[])
        AND ${q.id ? sql`b.id = ${q.id}` : sql`true`}
      ORDER BY b.updated_at DESC
      LIMIT 60`).then((rows) => (q.words ? rows.filter((r) => namedBy(`${r.name} ${r.place}`, q.words)) : rows).slice(0, 6));
  };
}

const briefOption = (b: BriefRec): QuestionOption => ({ value: b.id, label: b.name, detail: `${b.place}${b.status === "DRAFT" ? " · Draft" : ""}` });

type CopyRec = { id: string; language: string; segment: string; headline: string };

function copyFinder(ctx: ActionCtx, briefId: string) {
  return async (q: { id: string | null; words: string }): Promise<CopyRec[]> => {
    // Cards cleared under an older, looser gate are measured again before
    // Jimmy offers one to be drawn (makeOnePost does the same when it runs).
    const { regateBrief } = await import("./creative.ts");
    await regateBrief(ctx.orgId, briefId);
    return withTenantReadOnly(ctx.orgId, (sql) => sql<CopyRec[]>`
      SELECT id, language, segment, headline FROM campaign_copy
      WHERE org_id = ${ctx.orgId} AND brief_id = ${briefId} AND verdict = 'PASS'
        AND language IN (SELECT unnest(cb.languages) FROM campaign_briefs cb WHERE cb.id = campaign_copy.brief_id)
        AND language = ANY(${[...LANGUAGES]}::text[])
        AND ${q.id ? sql`id = ${q.id}` : sql`true`}
      ORDER BY generated_at DESC
      LIMIT 40`).then((rows) => (q.words ? rows.filter((r) => namedBy(`${r.headline} ${r.language} ${segmentLabel(r.segment)}`, q.words)) : rows).slice(0, 6));
  };
}

const copyOption = (c: CopyRec): QuestionOption => ({ value: c.id, label: c.headline.slice(0, 80), detail: `${c.language} · ${segmentLabel(c.segment)}` });

type PostRec = { id: string; brief_id: string; kind: string; placement: string; headline: string; brief: string; path: string };

function postFinder(ctx: ActionCtx, keys: string[]) {
  return async (q: { id: string | null; words: string }): Promise<PostRec[]> => {
    const scopes = reach(ctx, keys);
    if (!scopes.length) return [];
    return withTenantReadOnly(ctx.orgId, (sql) => sql<PostRec[]>`
      SELECT rp.id, rp.brief_id, rp.kind, rp.placement, rp.headline, b.name AS brief, n.path::text AS path
      FROM rendered_posts rp JOIN campaign_briefs b ON b.id = rp.brief_id JOIN scope_nodes n ON n.id = rp.scope_node_id
      WHERE rp.org_id = ${ctx.orgId} AND n.path <@ ANY(${scopes}::ltree[])
        AND (rp.review IS NULL OR (rp.review->>'passed')::boolean)
        AND ${q.id ? sql`rp.id = ${q.id}` : sql`true`}
      ORDER BY rp.created_at DESC
      LIMIT 60`).then((rows) => (q.words ? rows.filter((r) => namedBy(`${r.headline} ${r.brief} ${r.kind} ${r.placement}`, q.words)) : rows).slice(0, 6));
  };
}

const KIND_WORD: Record<string, string> = { IMAGE: "Image", CAROUSEL: "Carousel", VIDEO: "Video" };
const postOption = (p: PostRec): QuestionOption => ({ value: p.id, label: p.headline.slice(0, 80), detail: `${KIND_WORD[p.kind] ?? p.kind} · ${p.placement} · ${p.brief}` });

type CreativeRec = { id: string; headline: string; brief: string; publish_at: Date; path: string };

function creativeFinder(ctx: ActionCtx, keys: string[]) {
  return async (q: { id: string | null; words: string }): Promise<CreativeRec[]> => {
    const scopes = reach(ctx, keys);
    if (!scopes.length) return [];
    return withTenantReadOnly(ctx.orgId, (sql) => sql<CreativeRec[]>`
      SELECT pcr.id, pcr.headline, b.name AS brief, prn.publish_at, n.path::text AS path
      FROM post_creatives pcr JOIN post_runs prn ON prn.id = pcr.run_id JOIN post_schedules psc ON psc.id = prn.schedule_id
      JOIN campaign_briefs b ON b.id = psc.brief_id JOIN scope_nodes n ON n.id = psc.scope_node_id
      WHERE pcr.org_id = ${ctx.orgId} AND n.path <@ ANY(${scopes}::ltree[])
        AND pcr.state = 'DRAFT' AND pcr.verdict <> 'FAIL'
        AND ${q.id ? sql`pcr.id = ${q.id}` : sql`true`}
      ORDER BY prn.publish_at
      LIMIT 60`).then((rows) => (q.words ? rows.filter((r) => namedBy(`${r.headline} ${r.brief}`, q.words)) : rows).slice(0, 6));
  };
}

const moment = (at: Date) => {
  const iso = istToday(at);
  const t = new Date(at.getTime() + 330 * 60_000);
  return `${dayLabel(iso)}, ${timeLabel(`${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`)}`;
};

const creativeOption = (c: CreativeRec): QuestionOption => ({ value: c.id, label: c.headline.slice(0, 80), detail: `${c.brief} · goes out ${moment(new Date(c.publish_at))}` });

type ScheduleRec = { id: string; name: string; brief: string; active: boolean; path: string };

function scheduleFinder(ctx: ActionCtx, keys: string[], active: boolean) {
  return async (q: { id: string | null; words: string }): Promise<ScheduleRec[]> => {
    const scopes = reach(ctx, keys);
    if (!scopes.length) return [];
    return withTenantReadOnly(ctx.orgId, (sql) => sql<ScheduleRec[]>`
      SELECT psc.id, psc.name, b.name AS brief, psc.active, n.path::text AS path
      FROM post_schedules psc JOIN campaign_briefs b ON b.id = psc.brief_id JOIN scope_nodes n ON n.id = psc.scope_node_id
      WHERE psc.org_id = ${ctx.orgId} AND n.path <@ ANY(${scopes}::ltree[]) AND psc.active = ${active}
        AND ${q.id ? sql`psc.id = ${q.id}` : sql`true`}
      ORDER BY psc.updated_at DESC
      LIMIT 60`).then((rows) => (q.words ? rows.filter((r) => namedBy(`${r.name} ${r.brief}`, q.words)) : rows).slice(0, 6));
  };
}

const scheduleOption = (s: ScheduleRec): QuestionOption => ({ value: s.id, label: s.name, detail: s.brief });

const DEST: Record<string, string> = {
  FACEBOOK_PAGE: "Facebook Page",
  INSTAGRAM: "Instagram",
  META_AD: "Meta ad",
  GOOGLE_DISPLAY_AD: "Google display ad",
  GOOGLE_SEARCH_AD: "Google Search ad",
  GOOGLE_PMAX_AD: "Google Performance Max",
  GOOGLE_DEMAND_GEN_AD: "Google Demand Gen ad",
  GOOGLE_BUSINESS: "Google Business Profile",
};

type AdRec = { id: string; headline: string; destination: string; daily_budget: number | null; path: string };

function adFinder(ctx: ActionCtx, keys: string[]) {
  return async (q: { id: string | null; words: string }): Promise<AdRec[]> => {
    const scopes = minimalScopes(keys.flatMap((k) => ctx.authz.scopesFor(k)));
    if (!scopes.length) return [];
    return withTenantReadOnly(ctx.orgId, (sql) => sql<AdRec[]>`
      SELECT pt.id, pt.headline, pt.destination, pt.daily_budget, n.path::text AS path
      FROM publish_targets pt JOIN scope_nodes n ON n.id = pt.scope_node_id
      WHERE pt.org_id = ${ctx.orgId} AND n.path <@ ANY(${scopes}::ltree[]) AND pt.state = 'ACTIVE'
        AND ${q.id ? sql`pt.id = ${q.id}` : sql`true`}
      ORDER BY pt.activated_at DESC NULLS LAST
      LIMIT 60`).then((rows) => (q.words ? rows.filter((r) => namedBy(`${r.headline} ${DEST[r.destination] ?? ""}`, q.words)) : rows).slice(0, 6));
  };
}


const adOption = (a: AdRec): QuestionOption => ({
  value: a.id,
  label: a.headline.slice(0, 80),
  detail: `${DEST[a.destination] ?? a.destination}${a.daily_budget ? ` · Rs ${a.daily_budget.toLocaleString("en-IN")} a day` : ""}`,
});

type VisitRec = { id: string; status: string; scheduled_at: Date; buyer: string; place: string; path: string };

const VISIT_KEYS = ["visit:schedule", "visit:confirm", "visit:outcome"];

function visitFinder(ctx: ActionCtx) {
  return async (q: { id: string | null; words: string }): Promise<VisitRec[]> => {
    const scopes = minimalScopes(VISIT_KEYS.flatMap((k) => ctx.authz.scopesFor(k)));
    if (!scopes.length) return [];
    return withTenantReadOnly(ctx.orgId, (sql) => sql<VisitRec[]>`
      SELECT v.id, v.status, v.scheduled_at, l.name AS buyer, ${sql.unsafe(PLACE_SQL("n"))} AS place, n.path::text AS path
      FROM site_visits v JOIN leads l ON l.id = v.lead_id JOIN scope_nodes n ON n.id = v.scope_node_id
      LEFT JOIN scope_nodes pj ON pj.org_id = n.org_id AND pj.kind = 'PROJECT' AND n.path <@ pj.path
      WHERE v.org_id = ${ctx.orgId} AND n.path <@ ANY(${scopes}::ltree[])
        AND v.status IN ('CONFIRMED', 'ON_SITE', 'NO_SHOW')
        AND ${q.id ? sql`v.id = ${q.id}` : tokens(q.words)[0] ? sql`l.name ILIKE ${like(tokens(q.words)[0])}` : sql`true`}
      ORDER BY abs(extract(epoch FROM v.scheduled_at - now()))
      LIMIT 30`).then((rows) => (q.words ? rows.filter((r) => namedBy(r.buyer, q.words)) : rows).slice(0, 6));
  };
}

const VISIT_STATUS: Record<string, string> = { CONFIRMED: "Booked", ON_SITE: "On site", NO_SHOW: "No-show" };
const visitOption = (v: VisitRec): QuestionOption => ({
  value: v.id,
  label: v.buyer,
  detail: `${moment(new Date(v.scheduled_at))} · ${v.place} · ${VISIT_STATUS[v.status] ?? v.status}`,
});

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

const leadLink = (id: string) => ({ label: "Open the lead", href: `/dashboard/leads/${id}` });

/** A lead as the move rules read it. */
function leadState(l: LeadRec): LeadState {
  return {
    stage: l.stage,
    pathStage: l.path_stage,
    facts: l.facts ?? {},
    exit: l.stage === "nurture" || l.stage === "lost" ? { kind: l.stage, reason: l.exit_reason ?? "", followUp: l.follow_up_on ?? undefined } : undefined,
  };
}

/** What a field asks, about this buyer, in the words a person would use. */
function fieldTitle(key: FieldKey, who: string): string {
  const t: Record<FieldKey, string> = {
    contactChannel: `How did you first reach ${who}?`,
    contactedOn: `When did you first reach ${who}?`,
    config: `Which configuration does ${who} want?`,
    budget: `What is ${who}'s budget?`,
    timeline: `When is ${who} looking to buy?`,
    owner: `Who should own ${who}?`,
    visitDate: "Which day is the visit?",
    visitTime: "What time is the visit?",
    visitHost: "Who will host the visit?",
    interest: `How interested was ${who}?`,
    objection: `What was ${who}'s main objection?`,
    unit: "Which unit?",
    quote: "What price was quoted?",
    bookedOn: "When was it booked?",
    agreement: "What is the agreement value?",
    token: "How much token was received?",
  };
  return t[key] ?? FIELDS[key].label;
}

/** One lead-rules field as a question, from what its kind is. */
function fieldQuestion(key: FieldKey, people: readonly string[], today: string, to: PathStage, note: string | null, who = "the buyer"): Question {
  const f = FIELDS[key];
  const title = fieldTitle(key, who);
  const opts = key === "owner" || key === "visitHost" ? people : f.options ?? [];
  if (f.kind === "select" || f.kind === "chips") {
    return oneOf(key, title, opts.map((o) => ({ value: o, label: o })), { note, other: false });
  }
  if (f.kind === "time") {
    return oneOf(key, title, VISIT_SLOTS.map((s) => ({ value: s, label: timeLabel(s) })), { note, other: true });
  }
  if (f.kind === "date") {
    const mode = key === "visitDate" && to === "visit_scheduled" ? "future" : "past";
    return typed(key, title, "A date, like 28 Sep", { note, options: dateOptions(today, mode) });
  }
  if (f.kind === "money") return typed(key, title, "Rs, like 76,30,000", { note });
  return typed(key, title, f.placeholder ?? "", { note });
}

/** A typed answer to a lead-rules field, read into the value the rules expect. */
function readField(key: FieldKey, raw: string, today: string, to: PathStage): string | null {
  const f = FIELDS[key];
  if (f.kind === "date") return readDate(raw, today, key === "visitDate" && to === "visit_scheduled" ? "future" : "past");
  if (f.kind === "time") return readTime(raw, VISIT_SLOTS);
  if (f.kind === "money") {
    const n = readRupees(raw);
    return n === null ? null : String(n);
  }
  return raw.trim().slice(0, 120) || null;
}

const FACT_LABEL = (key: FieldKey, value: string) => {
  const f = FIELDS[key];
  if (f.kind === "date") return `${f.label}: ${dayLabel(value)}`;
  if (f.kind === "time") return `${f.label}: ${timeLabel(value)}`;
  if (f.kind === "money") return `${f.label}: Rs ${Number(value).toLocaleString("en-IN")}`;
  return `${f.label}: ${value}`;
};

const VISIT_WHAT: QuestionOption[] = [
  { value: "CHECK_IN", label: "The buyer has arrived", detail: "Check them in" },
  { value: "VISITED", label: "Record how the visit went" },
  { value: "NO_SHOW", label: "The buyer did not come", detail: "Mark as a no-show" },
  { value: "CANCEL", label: "Cancel the visit" },
];
const VISIT_KEY: Record<string, string> = { CHECK_IN: "visit:confirm", VISITED: "visit:outcome", NO_SHOW: "visit:outcome", CANCEL: "visit:schedule" };

const LANG_OPTIONS: QuestionOption[] = [
  { value: "hi", label: "Hindi" },
  { value: "mr", label: "Marathi" },
  { value: "en", label: "English" },
];

const STOP_REASONS: QuestionOption[] = [
  { value: "The campaign has ended", label: "The campaign has ended" },
  { value: "Waiting for new material", label: "Waiting for new material" },
  { value: "Paused for an election period", label: "Paused for an election period" },
];

const STOP_KEYS = ["creative:approve", "campaign:publish", "campaign.budget:manage"];

export const ACTIONS: ActionDef[] = [
  // --- leads and calls ------------------------------------------------------------
  {
    kind: "call_lead",
    label: "Call a lead",
    topic: "calls",
    level: 2,
    keys: ["lead:call"],
    detail:
      "Have the AI agent call one lead now about one project, for its usual qualifying call or with a goal. Inputs: lead (a name); goal, only when the person said what the call should do beyond qualifying, in their own words (for example 'ask him to come for a site visit tomorrow'), and left out for a qualifying call; day, a day they named for a site visit; project, only when they named the project or tower the call is about.",
    inputs: ["lead", "goal", "day", "project", "callAs"],
    working: "Placing the call",
    titles: { lead: "Lead", goal: "Goal", day: "Day", project: "About", callAs: "Calls them" },
    heading: (d) => (one(d, "lead") ? `Call ${one(d, "lead")!.label}` : "Call a lead"),
    headed: ["lead"],
    async step(ctx, d) {
      const l = await pickRecord(d, "lead", "Which lead should I call?", leadFinder(ctx, ["lead:call"]), leadOption, "lead");
      if (!l.ok) return l.step;
      // A call that does not say what it is for repeats the last call to this
      // lead in the chat, and the card says so.
      if (!one(d, "goal") && !d.hints.goal?.trim() && ctx.threadId && UUID.test(ctx.threadId)) {
        const rows = await withPerson(ctx.orgId, ctx.userId, (sql) => sql<{ inputs: Draft | null }[]>`
          SELECT inputs FROM ask_actions
          WHERE thread_id = ${ctx.threadId!} AND kind = 'call_lead'
          ORDER BY created_at DESC LIMIT 10`);
        const last = priorCall(rows.map((r) => r.inputs ?? { filled: {}, hints: {} }), l.value.id);
        if (last) {
          d.filled.goal = last.goal;
          if (last.day && !d.hints.day) d.hints.day = last.day;
          if (last.project && !one(d, "project") && !d.hints.project) d.filled.project = last.project;
          d.filled.again = { v: "yes", label: "Same as the last call" };
        }
      }
      // What the call does and which project it is about, asked together.
      const g = await pickGoal(ctx, d, l.value, { kind: "call_lead", label: "Make the usual call", inputs: { lead: l.value.id, goal: USUAL_CALL.label } });
      const p = await pickCallTower(ctx, d, l.value);
      if (!g.ok && "refuse" in g.step) return g.step;
      if (!p.ok && "refuse" in p.step) return p.step;
      // A number typed with a name that is not the name on its lead: which
      // name does the agent say? Asked, never guessed.
      const typedName = d.hints.callAs?.trim() ?? "";
      const nameAsk = [];
      if (typedName && !one(d, "callAs")) {
        if (sameName(typedName, l.value.name)) delete d.hints.callAs;
        else
          nameAsk.push(
            oneOf("callAs", `This number is saved as ${l.value.name}. What should the agent call them?`, [
              { value: l.value.name, label: l.value.name, detail: "The name on the lead" },
              { value: typedName, label: typedName, detail: "The name you gave" },
            ]),
          );
      }
      const asks = [...nameAsk, ...(!g.ok && "ask" in g.step ? g.step.ask : []), ...(!p.ok && "ask" in p.step ? p.step.ask : [])];
      if (asks.length) return { ask: asks.slice(0, MAX_QUESTIONS) };
      if (!g.ok || !p.ok) return { refuse: "That call cannot be set up." };
      const tower = p.value;
      // What the agent can answer, said only once the agents read the facts.
      let knows: string | null = null;
      if (projectFactsOn()) {
        const { resolveBrain } = await import("./brain.ts");
        const signed = ((await resolveBrain(ctx.orgId, tower.id))?.sources.length ?? 0) > 0;
        knows = signed
          ? `Answers questions from the signed facts of ${tower.place}`
          : `${tower.place} has no signed facts yet, so project questions go to your sales team`;
      }
      const callAs = one(d, "callAs")?.v ?? null;
      const renamed = callAs && !sameName(callAs, l.value.name) ? callAs : null;
      const lines = [
        ...(renamed ? [`Calls them ${renamed}, saved as ${l.value.name}`] : []),
        ...(one(d, "again") ? [`Same as your last call to ${l.value.name.split(/\s+/)[0]} in this chat${g.value ? "" : ": the usual qualifying call"}`] : []),
        `About: ${tower.place}${
          one(d, "projectWhy") ? ` (${one(d, "projectWhy")!.label})` : tower.id === l.value.node_id ? "" : ` (enquired about ${l.value.place})`
        }`,
        ...(knows ? [knows] : []),
        `Stage: ${stageLabel(l.value.stage)}`,
        `Phone: ${maskedPhone(l.value.phone)}`,
      ];
      return {
        ready: {
          preview: {
            title: `Call ${renamed ?? l.value.name} now`,
            lines: g.value ? [goalLine(d, g.value), ...lines] : lines,
            confirm: "Call now",
            cost: "The AI agent calls now and uses call minutes.",
          },
          target: { type: "lead", id: l.value.id, path: l.value.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { placeCall } = await import("./calling.ts");
      const goal = goalOf(d);
      // The tower is asked again within the person's reach, as it stands now.
      const towerId = one(d, "project")?.v ?? null;
      const [tower] = towerId ? await nodeFinder(ctx, ["lead:call"], ["PHASE"])({ id: towerId, words: "" }) : [];
      if (!tower) return { ok: false, message: "You can no longer call about that tower." };
      const callName = one(d, "callAs")?.v?.trim() || null;
      const r = await placeCall({ orgId: ctx.orgId, userId: ctx.userId, leadId: t.id, goal, nodeId: tower.id, callName });
      return r.ok
        ? {
            ok: true,
            result: {
              // The name the agent says, not the one the lead was saved
              // under: "Calling ADI" read as calling somebody else.
              message: `Calling ${callName ?? r.leadName} now about ${tower.place}${goal ? ", with your goal" : ""}. The call shows in the log when it ends.`,
              links: [leadLink(t.id), { label: "Open Calls", href: "/dashboard/leads/calls" }],
            },
          }
        : { ok: false, message: r.message };
    },
  },
  {
    kind: "add_lead_and_call",
    label: "Add a lead and call",
    topic: "calls",
    level: 2,
    keys: ["lead:create", "lead:call"],
    detail:
      "Add a new lead by hand and have the AI agent call them now. Use it whenever the person gives a phone number to call. Inputs: name; phone (the number exactly as typed); tower; language (Hindi, Marathi or English); goal, only when the person said what the call should do beyond qualifying, in their own words; day, a day they named for a site visit.",
    inputs: ["name", "phone", "tower", "language", "goal", "day"],
    working: "Adding the lead and placing the call",
    titles: { name: "Name", phone: "Phone", tower: "Tower", language: "Language", goal: "Goal" },
    async step(ctx, d) {
      // The name and the number are asked on one card, and a number that will
      // not do says exactly why: India is the default, so nobody is asked for
      // a country code, and a number one digit short is told so.
      const name = pickText(d, "name", "What is the buyer's name?", "Full name", (s) => (s.length <= 120 ? { value: s } : { problem: "Keep the name under 120 letters." }));
      const phone = pickText(d, "phone", "What is their mobile number?", "10 digits, like 98765 43210", (s) => {
        const e = normalisePhone(s);
        return e ? { value: e, label: maskedPhone(e) } : { problem: phoneProblem(s) ?? "That does not look like a mobile number." };
      });
      const asks = [...(!name.ok && "ask" in name.step ? name.step.ask : []), ...(!phone.ok && "ask" in phone.step ? phone.step.ask : [])];
      if (asks.length) return { ask: asks.slice(0, MAX_QUESTIONS) };
      if (!name.ok) return name.step;
      if (!phone.ok) return phone.step;
      // A call with its own goal is not about a tower the buyer asked about,
      // so the lead is filed where this person last called, unasked.
      const towers = nodeFinder(ctx, ["lead:create", "lead:call"], ["PHASE"]);
      if (!one(d, "tower") && !d.hints.tower?.trim() && (d.hints.goal?.trim() || one(d, "goal"))) {
        const usual = await usualTower(ctx, towers);
        if (usual) {
          d.filled.tower = { v: usual.id, label: usual.place };
          d.filled.towerWhy = { v: "auto", label: "filed where you last called" };
        }
      }
      const tower = await pickRecord(d, "tower", "Which tower did they ask about?", towers, nodeOption, "tower");
      if (!tower.ok) return tower.step;
      // A new number's first call is the qualifying one unless the person
      // said otherwise, so nothing is asked; a goal they said is kept.
      let goal: CallGoal | null = null;
      if (d.hints.goal?.trim() || one(d, "goal")) {
        const g = await pickGoal(ctx, d, { name: name.value, stage: "new", node_id: tower.value.id }, {
          kind: "add_lead_and_call",
          label: "Add them and make the usual call",
          inputs: { name: name.value, phone: phone.value, tower: tower.value.id },
        });
        if (!g.ok) return g.step;
        goal = g.value;
      }
      // The language is never asked: what the person said, else what the
      // name suggests, else Hindi. The agent switches if the buyer answers
      // in another.
      if (!one(d, "language") && !d.hints.language?.trim()) {
        const guessed = guessLanguage(name.value);
        const v = guessed ?? "hi";
        d.filled.language = { v, label: LANG_OPTIONS.find((o) => o.value === v)!.label };
        if (guessed) d.filled.guessed = { v: "yes", label: "From the name" };
      }
      const lang = pickChoice(d, "language", "Which language should the agent speak?", LANG_OPTIONS);
      if (!lang.ok) return lang.step;
      return {
        ready: {
          preview: {
            title: `Add ${name.value} and call now`,
            lines: [
              ...(goal ? [goalLine(d, goal)] : []),
              one(d, "towerWhy") ? `Filed under ${tower.value.place}` : tower.value.place,
              `Phone: ${maskedPhone(phone.value)}`,
              `Speaks: ${LANG_OPTIONS.find((o) => o.value === lang.value)!.label}${one(d, "guessed") ? ", from the name" : ""}`,
            ],
            confirm: "Add and call",
            cost: "The AI agent calls now and uses call minutes.",
          },
          target: { type: "node", id: tower.value.id, path: tower.value.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { addLeadAndCall } = await import("./calling.ts");
      const r = await addLeadAndCall({
        orgId: ctx.orgId,
        userId: ctx.userId,
        name: one(d, "name")!.v,
        phone: one(d, "phone")!.v,
        phaseId: t.id,
        source: "Manual",
        language: one(d, "language")!.v as "hi" | "mr" | "en",
        consentWording: null,
        goal: goalOf(d),
      });
      return r.ok
        ? {
            ok: true,
            result: {
              message: `Added ${r.leadName} and calling now${goalOf(d) ? ", with your goal" : ""}.`,
              links: [...(r.lead ? [leadLink(r.lead.id)] : []), { label: "Open Calls", href: "/dashboard/leads/calls" }],
            },
          }
        : { ok: false, message: r.message };
    },
  },
  {
    kind: "send_location",
    label: "Send the site location",
    topic: "leads",
    level: 2,
    keys: ["lead:update"],
    detail: "Send one lead the site's location on WhatsApp, with one-tap directions. Inputs: lead.",
    inputs: ["lead"],
    working: "Sending",
    titles: { lead: "Lead" },
    async step(ctx, d) {
      const l = await pickRecord(d, "lead", "Who should get the location?", leadFinder(ctx, ["lead:update"]), leadOption, "lead");
      if (!l.ok) return l.step;
      return {
        ready: {
          preview: { title: `Send ${l.value.name} the site location`, lines: [l.value.place, `Phone: ${maskedPhone(l.value.phone)}`], confirm: "Send on WhatsApp", cost: "Sends a WhatsApp message to the buyer." },
          target: { type: "lead", id: l.value.id, path: l.value.path },
        },
      };
    },
    async run(ctx, _d, t) {
      const { sendLocation } = await import("./lead-engine.ts");
      const r = await sendLocation({ orgId: ctx.orgId, userId: ctx.userId, leadId: t.id });
      return r.ok ? { ok: true, result: { message: r.message || "Sent.", links: [leadLink(t.id)] } } : { ok: false, message: r.message };
    },
  },
  {
    kind: "move_lead",
    label: "Move a lead to a stage",
    topic: "leads",
    level: 1,
    keys: ["lead:update"],
    detail:
      "Move one lead to another stage on the board (booking a visit is a move to Visit scheduled). Inputs: lead, stage (new, contacted, qualified, visit_scheduled, visit_done, negotiation, booked, nurture, lost), and any facts the request gives: config, budget, timeline, owner, visitDate, visitTime, visitHost, interest, objection, unit, quote, bookedOn, agreement, token, reason.",
    inputs: ["lead", "stage", "config", "budget", "timeline", "owner", "visitDate", "visitTime", "visitHost", "interest", "objection", "unit", "quote", "bookedOn", "agreement", "token", "reason"],
    working: "Moving the lead",
    heading: (d) => {
      const who = one(d, "lead")?.label;
      const to = one(d, "stage")?.v as StageKey | undefined;
      if (who && to === "visit_scheduled") return `Book a site visit for ${who}`;
      if (who && to) return `Move ${who} to ${stageLabel(to)}`;
      return who ? `Move ${who}` : "Move a lead";
    },
    headed: ["lead", "stage"],
    titles: {
      lead: "Lead",
      stage: "Move to",
      reason: "Why",
      followUp: "Come back on",
      ...Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.label])),
    },
    async step(ctx, d) {
      const l = await pickRecord(d, "lead", "Which lead?", leadFinder(ctx, ["lead:update"]), leadOption, "lead");
      if (!l.ok) return l.step;
      const lead = l.value;
      const stages = STAGES.map((s) => ({ value: s.key, label: s.label, disabled: s.key === lead.stage ? "It is already here" : null }));
      const to = pickChoice(d, "stage", `Move ${lead.name} to which stage?`, stages);
      if (!to.ok) return to.step;
      const target = to.value as StageKey;
      const { ownersFor } = await import("./leads.ts");
      const people = (await ownersFor(ctx.orgId, lead.node_id)).map((p) => p.name);
      const today = istToday(ctx.now);
      const state = leadState(lead);
      const nowTime = istClock(ctx.now).time;
      const plan = planMove(state, target, today, people, nowTime);
      if (plan.kind === "none") return { refuse: `${lead.name} is already in ${stageLabel(target)}.` };

      // The facts the move needs, three to a card, read from what was said first.
      const fields = plan.sections.flatMap((s) => s.fields);
      const facts: Facts = {};
      const asks: Question[] = [];
      for (const k of fields) {
        const got = one(d, k);
        if (got) {
          facts[k] = got.v;
          continue;
        }
        const hint = d.hints[k];
        if (hint) {
          const f = FIELDS[k];
          const opts = k === "owner" || k === "visitHost" ? people : f.options ?? [];
          const value = opts.length ? matchOption(hint, opts.map((o) => ({ value: o, label: o })))?.value ?? null : readField(k, hint, today, target as PathStage);
          delete d.hints[k];
          if (value) {
            d.filled[k] = { v: value, label: FACT_LABEL(k, value).split(": ").slice(1).join(": ") };
            facts[k] = value;
            continue;
          }
          asks.push(fieldQuestion(k, people, today, target as PathStage, `"${hint.slice(0, 40)}" could not be read.`, lead.name));
          continue;
        }
        asks.push(fieldQuestion(k, people, today, target as PathStage, null, lead.name));
      }
      if (plan.reason) {
        const r = pickChoice(d, "reason", plan.reason.label, plan.reason.options.map((o) => ({ value: o, label: o })));
        if (!r.ok && "ask" in r.step) asks.push(...r.step.ask);
      }
      if (plan.followUp) {
        const f = pickText(
          d,
          "followUp",
          "When should it come back?",
          "A date, like 1 Dec",
          (s) => {
            const v = readDate(s, today, "future");
            return v && v > today ? { value: v, label: dayLabel(v) } : { problem: "Pick a date after today." };
          },
          [30, 90, 180].map((n) => {
            const v = new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
            return { value: v, label: n === 30 ? "In a month" : n === 90 ? "In three months" : "In six months", detail: dayLabel(v) };
          }),
        );
        if (!f.ok && "ask" in f.step) asks.push(...f.step.ask);
      }
      if (asks.length) return { ask: asks.slice(0, MAX_QUESTIONS) };

      const input: MoveInput = { facts, reason: one(d, "reason")?.v, followUp: one(d, "followUp")?.v };
      const errors = validateMove(plan, state, input, today, people, nowTime);
      if (Object.keys(errors).length) {
        const bad = Object.keys(errors) as (FieldKey | "reason" | "followUp")[];
        for (const k of bad) delete d.filled[k];
        return {
          ask: bad
            .filter((k): k is FieldKey => k in FIELDS)
            .slice(0, MAX_QUESTIONS)
            .map((k) => fieldQuestion(k, people, today, target as PathStage, errors[k], lead.name)),
        };
      }
      const lines = [lead.place, `Now: ${stageLabel(lead.stage)}`, ...fields.map((k) => FACT_LABEL(k, facts[k]!))];
      if (input.reason) lines.push(`Why: ${input.reason}`);
      if (input.followUp) lines.push(`Comes back on ${dayLabel(input.followUp)}`);
      if (plan.cancelsBooking) lines.push("This cancels the booking.");
      if (target === "visit_scheduled") lines.push("Books the visit and sends the buyer a confirmation.");
      return {
        ready: {
          preview: {
            title: target === "visit_scheduled" ? `Book a site visit for ${lead.name}` : `Move ${lead.name} to ${stageLabel(target)}`,
            lines,
            confirm: target === "visit_scheduled" ? "Book the visit" : `Move to ${stageLabel(target)}`,
          },
          target: { type: "lead", id: lead.id, path: lead.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { moveLead } = await import("./leads.ts");
      const to = one(d, "stage")!.v as StageKey;
      const facts: Facts = {};
      for (const k of Object.keys(FIELDS) as FieldKey[]) {
        const f = one(d, k);
        if (f) facts[k] = f.v;
      }
      const res = await moveLead({
        orgId: ctx.orgId,
        userId: ctx.userId,
        leadId: t.id,
        to,
        input: { facts, reason: one(d, "reason")?.v, followUp: one(d, "followUp")?.v },
        today: istToday(ctx.now),
        nowTime: istClock(ctx.now).time,
        throughMandate: ctx.via ? { firm: ctx.via.firmName } : undefined,
      });
      if (!res.ok) return { ok: false, message: res.errors ? `${res.message} ${Object.values(res.errors).join(". ")}.` : res.message };
      return {
        ok: true,
        result: { message: `Moved to ${stageLabel(res.to)}.`, links: [leadLink(t.id)] },
        // What the new stage starts (a visit booked, a welcome) runs after the answer, as on the board.
        later: async () => {
          const { onMoved } = await import("./lead-engine.ts");
          await onMoved({ orgId: ctx.orgId, userId: ctx.userId, leadId: t.id, from: res.from, to: res.to, facts: res.facts, followUpOn: res.followUpOn });
        },
      };
    },
  },
  {
    kind: "lead_automation",
    label: "Pause or resume the AI on a lead",
    topic: "leads",
    level: 1,
    keys: ["lead:update"],
    detail: "Stop the AI calling and messaging one lead, or start it again. Inputs: lead, mode (pause or resume).",
    inputs: ["lead", "mode"],
    working: "Saving",
    titles: { lead: "Lead", mode: "Do" },
    async step(ctx, d) {
      const l = await pickRecord(d, "lead", "Which lead?", leadFinder(ctx, ["lead:update"]), leadOption, "lead");
      if (!l.ok) return l.step;
      const paused = l.value.automation === "PAUSED";
      const said = (d.hints.mode ?? "").toLowerCase();
      if (said && !one(d, "mode")) {
        if (paused && /pause|stop|off|band/.test(said)) return { refuse: `The AI is already paused for ${l.value.name}.` };
        if (!paused && /resume|start|on|chalu|restart/.test(said) && !/pause/.test(said)) return { refuse: `The AI is already on for ${l.value.name}.` };
      }
      const mode = pickChoice(
        d,
        "mode",
        `What should the AI do for ${l.value.name}?`,
        [
          { value: "PAUSE", label: "Pause it", detail: "Nothing automatic goes out", disabled: paused ? "It is already paused" : null },
          { value: "RESUME", label: "Resume it", detail: "Calls and messages on its cadence", disabled: paused ? null : "It is already on" },
        ],
      );
      if (!mode.ok) return mode.step;
      const on = mode.value === "RESUME";
      return {
        ready: {
          preview: { title: `${on ? "Resume" : "Pause"} the AI for ${l.value.name}`, lines: [l.value.place, `Stage: ${stageLabel(l.value.stage)}`], confirm: on ? "Resume" : "Pause" },
          target: { type: "lead", id: l.value.id, path: l.value.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { setAutomation } = await import("./leads.ts");
      const on = one(d, "mode")!.v === "RESUME";
      await setAutomation({ orgId: ctx.orgId, userId: ctx.userId, leadId: t.id, on });
      return { ok: true, result: { message: on ? "The AI is back on for this lead." : "Paused. Nothing automatic goes to this lead now.", links: [leadLink(t.id)] } };
    },
  },
  {
    kind: "clear_needs",
    label: "Mark a lead's follow-up done",
    topic: "leads",
    level: 1,
    keys: ["lead:update"],
    detail: "Mark done the thing a lead was waiting on a person for. Inputs: lead.",
    inputs: ["lead"],
    working: "Saving",
    titles: { lead: "Lead" },
    async step(ctx, d) {
      const l = await pickRecord(d, "lead", "Which lead's follow-up is done?", leadFinder(ctx, ["lead:update"], "needs"), leadOption, "lead waiting for a person");
      if (!l.ok) return l.step;
      return {
        ready: {
          preview: { title: `Mark ${l.value.name}'s follow-up done`, lines: [l.value.place, withoutQuotes(l.value.needs_person ?? "")].filter(Boolean), confirm: "Mark done" },
          target: { type: "lead", id: l.value.id, path: l.value.path },
        },
      };
    },
    async run(ctx, _d, t) {
      const { clearNeedsPerson } = await import("./leads.ts");
      await clearNeedsPerson({ orgId: ctx.orgId, userId: ctx.userId, leadId: t.id });
      return { ok: true, result: { message: "Done. It is off the list.", links: [leadLink(t.id)] } };
    },
  },

  // --- site visits ----------------------------------------------------------------
  {
    kind: "visit_update",
    label: "Update a site visit",
    topic: "visits",
    level: 1,
    keys: [],
    anyKeys: VISIT_KEYS,
    detail:
      "Check a buyer in, record how a visit went, mark a no-show, or cancel a visit. Inputs: visit (the buyer's name), what (check_in, visited, no_show, cancel), interest (Hot, Warm, Cold), objection, next.",
    inputs: ["visit", "what", "interest", "objection", "next"],
    working: "Saving",
    titles: { visit: "Visit", what: "Do", interest: "Interest", objection: "Objection", next: "Next" },
    async step(ctx, d) {
      const v = await pickRecord(d, "visit", "Which visit?", visitFinder(ctx), visitOption, "visit");
      if (!v.ok) return v.step;
      const allowed = VISIT_WHAT.map((o) => ({ ...o, disabled: ctx.authz.canAt(VISIT_KEY[o.value], v.value.path) ? null : "You cannot do this for this tower" }));
      const what = pickChoice(d, "what", `What happened with ${v.value.buyer}'s visit?`, allowed);
      if (!what.ok) return what.step;
      const lines = [moment(new Date(v.value.scheduled_at)), v.value.place];
      if (what.value === "VISITED") {
        const asks: Question[] = [];
        const i = pickChoice(d, "interest", "How interested were they?", INTEREST.map((x) => ({ value: x, label: x })));
        if (!i.ok && "ask" in i.step) asks.push(...i.step.ask);
        const o = pickChoice(d, "objection", "Their main objection?", OBJECTIONS.map((x) => ({ value: x, label: x })));
        if (!o.ok && "ask" in o.step) asks.push(...o.step.ask);
        const n = pickChoice(d, "next", "What happens next?", NEXT_STEPS.map((x) => ({ value: x, label: x })), { free: true });
        if (!n.ok && "ask" in n.step) asks.push(...n.step.ask);
        if (asks.length) return { ask: asks };
        lines.push(`Interest: ${one(d, "interest")!.label}`, `Objection: ${one(d, "objection")!.label}`, `Next: ${one(d, "next")!.label}`);
      }
      const label = VISIT_WHAT.find((o) => o.value === what.value)!.label;
      return {
        ready: {
          preview: {
            title: `${v.value.buyer}: ${label.toLowerCase()}`,
            lines,
            confirm: what.value === "CANCEL" ? "Cancel the visit" : what.value === "CHECK_IN" ? "Check in" : what.value === "NO_SHOW" ? "Mark no-show" : "Save",
          },
          target: { type: "visit", id: v.value.id, path: v.value.path },
          keys: [VISIT_KEY[what.value]],
        },
      };
    },
    async run(ctx, d, t) {
      const { onVisitAction } = await import("./lead-engine.ts");
      const action = one(d, "what")!.v as "CHECK_IN" | "VISITED" | "NO_SHOW" | "CANCEL";
      const outcome =
        action === "VISITED" ? { interest: one(d, "interest")!.v, objection: one(d, "objection")!.v, next: one(d, "next")!.v } : undefined;
      const r = await onVisitAction({ orgId: ctx.orgId, userId: ctx.userId, visitId: t.id, action, outcome });
      return r.ok ? { ok: true, result: { message: r.message || "Saved.", links: [{ label: "Open Site visits", href: "/dashboard/visits" }] } } : { ok: false, message: r.message };
    },
  },

  // --- campaigns --------------------------------------------------------------------
  {
    kind: "approve_post",
    label: "Approve a scheduled post",
    topic: "campaigns",
    level: 1,
    keys: ["creative:approve"],
    detail: "Approve one post a schedule made, so it goes out at its time. Inputs: post (its headline or campaign).",
    inputs: ["post"],
    working: "Approving",
    titles: { post: "Post" },
    async step(ctx, d) {
      const c = await pickRecord(d, "post", "Which post should I approve?", creativeFinder(ctx, ["creative:approve"]), creativeOption, "post waiting for review");
      if (!c.ok) return c.step;
      return {
        ready: {
          preview: { title: "Approve this post", lines: [c.value.headline, `${c.value.brief} · goes out ${moment(new Date(c.value.publish_at))}`], confirm: "Approve" },
          target: { type: "creative", id: c.value.id, path: c.value.path },
        },
      };
    },
    async run(ctx, _d, t) {
      const { approveCreative } = await import("./post.ts");
      const r = await approveCreative({ orgId: ctx.orgId, actorUserId: ctx.userId, creativeId: t.id });
      return r.ok ? { ok: true, result: { message: "Approved. It goes out at its time.", links: [{ label: "Open the review queue", href: "/dashboard/campaigns/queue" }] } } : { ok: false, message: r.message };
    },
  },
  {
    kind: "reject_post",
    label: "Reject a scheduled post",
    topic: "campaigns",
    level: 1,
    keys: ["creative:approve"],
    detail: "Reject one post a schedule made. Inputs: post, note (why, optional).",
    inputs: ["post", "note"],
    working: "Rejecting",
    titles: { post: "Post", note: "Note" },
    async step(ctx, d) {
      const c = await pickRecord(d, "post", "Which post should I reject?", creativeFinder(ctx, ["creative:approve"]), creativeOption, "post waiting for review");
      if (!c.ok) return c.step;
      const note = pickText(d, "note", "Why? A line for whoever writes the next one.", "Optional", (s) => ({ value: s.slice(0, 500) }), [
        { value: "-", label: "No note" },
      ]);
      if (!note.ok) return note.step;
      const text = note.value === "-" ? "" : note.value;
      return {
        ready: {
          preview: { title: "Reject this post", lines: [c.value.headline, c.value.brief, ...(text ? [`Note: ${text}`] : [])], confirm: "Reject" },
          target: { type: "creative", id: c.value.id, path: c.value.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { rejectCreative } = await import("./post.ts");
      const n = one(d, "note")!.v;
      const r = await rejectCreative({ orgId: ctx.orgId, actorUserId: ctx.userId, creativeId: t.id, note: n === "-" ? "" : n });
      return r.ok ? { ok: true, result: { message: "Rejected.", links: [{ label: "Open the review queue", href: "/dashboard/campaigns/queue" }] } } : { ok: false, message: r.message };
    },
  },
  {
    kind: "stop_schedule",
    label: "Stop a posting schedule",
    topic: "campaigns",
    level: 1,
    keys: ["creative:approve"],
    detail: "Stop a running posting schedule. Inputs: schedule (its name or campaign), reason.",
    inputs: ["schedule", "reason"],
    working: "Stopping",
    titles: { schedule: "Schedule", reason: "Why" },
    async step(ctx, d) {
      const s = await pickRecord(d, "schedule", "Which schedule should stop?", scheduleFinder(ctx, ["creative:approve"], true), scheduleOption, "running schedule");
      if (!s.ok) return s.step;
      const reason = pickChoice(d, "reason", "Why is it stopping?", STOP_REASONS, { free: true });
      if (!reason.ok) return reason.step;
      return {
        ready: {
          preview: { title: `Stop ${s.value.name}`, lines: [s.value.brief, `Why: ${one(d, "reason")!.label}`, "No new posts are made until it is started again."], confirm: "Stop the schedule" },
          target: { type: "schedule", id: s.value.id, path: s.value.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { stopSchedule } = await import("./post.ts");
      const r = await stopSchedule({ orgId: ctx.orgId, actorUserId: ctx.userId, scheduleId: t.id, reason: one(d, "reason")!.v });
      return r.ok ? { ok: true, result: { message: "Stopped.", links: [{ label: "Open Campaigns", href: "/dashboard/campaigns" }] } } : { ok: false, message: r.message ?? "It could not be stopped." };
    },
  },
  {
    kind: "start_schedule",
    label: "Start a posting schedule again",
    topic: "campaigns",
    level: 1,
    keys: ["creative:approve"],
    detail: "Start a stopped posting schedule again. Inputs: schedule.",
    inputs: ["schedule"],
    working: "Starting",
    titles: { schedule: "Schedule" },
    async step(ctx, d) {
      const s = await pickRecord(d, "schedule", "Which schedule should start again?", scheduleFinder(ctx, ["creative:approve"], false), scheduleOption, "stopped schedule");
      if (!s.ok) return s.step;
      return {
        ready: {
          preview: { title: `Start ${s.value.name} again`, lines: [s.value.brief], confirm: "Start it" },
          target: { type: "schedule", id: s.value.id, path: s.value.path },
        },
      };
    },
    async run(ctx, _d, t) {
      const { startSchedule } = await import("./post.ts");
      const r = await startSchedule({ orgId: ctx.orgId, actorUserId: ctx.userId, scheduleId: t.id });
      return r.ok ? { ok: true, result: { message: "Running again.", links: [{ label: "Open Campaigns", href: "/dashboard/campaigns" }] } } : { ok: false, message: r.message ?? "It could not be started." };
    },
  },
  {
    kind: "create_brief",
    label: "Start a campaign brief",
    topic: "campaigns",
    level: 1,
    keys: ["campaign:create"],
    detail: "Start a new campaign brief on a project or tower, to fill in on its screen. Inputs: place, name.",
    inputs: ["place", "name"],
    working: "Creating",
    titles: { place: "For", name: "Name" },
    async step(ctx, d) {
      const p = await pickRecord(d, "place", "Which project or tower is it for?", nodeFinder(ctx, ["campaign:create"], ["PROJECT", "PHASE"]), nodeOption, "project or tower");
      if (!p.ok) return p.step;
      const n = pickText(d, "name", "What should the campaign be called?", "Like Diwali 2026", (s) => (s.length <= 120 ? { value: s } : { problem: "Keep it under 120 letters." }));
      if (!n.ok) return n.step;
      return {
        ready: {
          preview: { title: `Start the brief ${n.value}`, lines: [p.value.place, "Opens as a draft for you to fill in."], confirm: "Create the brief" },
          target: { type: "node", id: p.value.id, path: p.value.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { createBrief } = await import("./campaign.ts");
      const r = await createBrief({ orgId: ctx.orgId, actorUserId: ctx.userId, nodeId: t.id, name: one(d, "name")!.v });
      return r.ok
        ? { ok: true, result: { message: "Created. Fill in who it is for and its sizes before making posts.", links: [{ label: "Open the brief", href: `/dashboard/campaigns/brief/${r.briefId}` }] } }
        : { ok: false, message: r.message };
    },
  },
  {
    kind: "write_copy",
    label: "Write a campaign's copy",
    topic: "campaigns",
    level: 2,
    keys: ["campaign:create"],
    detail: "Write every copy card the campaign's brief asks for, checked against the signed facts. Needed before any post. Inputs: campaign.",
    inputs: ["campaign"],
    makes: true,
    background: true,
    working: "Writing the copy. This takes about a minute.",
    titles: { campaign: "Campaign" },
    async step(ctx, d) {
      const b = await pickRecord(d, "campaign", "Which campaign's copy?", briefFinder(ctx, ["campaign:create"]), briefOption, "campaign");
      if (!b.ok) return b.step;
      if (!b.value.languages.length) return { refuse: `The brief for ${b.value.name} names no languages yet. Add them on the brief first.` };
      return {
        ready: {
          preview: { title: `Write the copy for ${b.value.name}`, lines: [b.value.place, `${b.value.languages.join(", ")}`], confirm: "Write the copy", cost: "Writes copy with AI." },
          target: { type: "brief", id: b.value.id, path: b.value.path },
        },
      };
    },
    async run(ctx, _d, t) {
      const { generateBlocks } = await import("./creative.ts");
      const r = await generateBlocks({ orgId: ctx.orgId, actorUserId: ctx.userId, briefId: t.id });
      if (!r.ok) return { ok: false, message: r.message };
      const next: NextAction[] = r.passed > 0 && ctx.authz.canAt("campaign:create", t.path) ? [{ kind: "make_post", label: "Make a post from it", inputs: { campaign: t.id } }] : [];
      return {
        ok: true,
        result: {
          message: `${r.written} card${r.written === 1 ? "" : "s"} written, ${r.passed} cleared${r.held ? `, ${r.held} on hold` : ""}${r.failed ? `, ${r.failed} blocked` : ""}.`,
          links: [{ label: "Open the studio", href: `/dashboard/campaigns/brief/${t.id}/studio` }],
          next,
        },
      };
    },
  },
  {
    kind: "make_post",
    label: "Make a post",
    topic: "campaigns",
    level: 2,
    keys: ["campaign:create"],
    detail: "Design one image, carousel or video post for a campaign from a cleared copy card. Inputs: campaign, kind (image, carousel, video), card (the copy's headline or language), size (Meta feed 1:1, Meta story 9:16, Meta reel 9:16, Google display, YouTube 16:9, Portal listing).",
    inputs: ["campaign", "kind", "card", "size"],
    makes: true,
    background: true,
    working: "Designing the post. This takes one to three minutes.",
    titles: { campaign: "Campaign", kind: "Kind", card: "Copy", size: "Size" },
    async step(ctx, d) {
      const b = await pickRecord(d, "campaign", "Which campaign is the post for?", briefFinder(ctx, ["campaign:create"]), briefOption, "campaign");
      if (!b.ok) return b.step;
      const kinds = POST_KINDS.map((k) => ({ value: k.key, label: k.label, detail: k.detail, disabled: kindUnavailable(k.key, b.value.formats ?? []) }));
      if (kinds.every((k) => k.disabled)) return { refuse: `The brief for ${b.value.name} has no sizes chosen yet. Pick them on the brief first.` };
      const kind = pickChoice(d, "kind", "What kind of post?", kinds);
      if (!kind.ok) return kind.step;
      const cards = await copyFinder(ctx, b.value.id)({ id: null, words: "" });
      if (!cards.length) {
        return {
          refuse: `${b.value.name} has no cleared copy yet. The copy is written first.`,
          next: [{ kind: "write_copy", label: "Write the copy first", inputs: { campaign: b.value.id } }],
        };
      }
      const card = await pickRecord(d, "card", "Which copy should it carry?", copyFinder(ctx, b.value.id), copyOption, "cleared copy card");
      if (!card.ok) return card.step;
      const sizes = placementsFor(kind.value as PostKind, b.value.formats ?? []).map((p) => ({ value: p, label: p }));
      const size = pickChoice(d, "size", "Which size?", sizes);
      if (!size.ok) {
        if (sizes.length === 1) d.filled.size = { v: sizes[0].value, label: sizes[0].label };
        else return size.step;
      }
      const kindLabel = POST_KINDS.find((k) => k.key === kind.value)!.label.toLowerCase();
      return {
        ready: {
          preview: {
            title: `Make ${/^[aeiou]/.test(kindLabel) ? "an" : "a"} ${kindLabel} for ${b.value.name}`,
            lines: [card.value.headline, `${one(d, "size")!.label} · ${card.value.language}`, b.value.place],
            confirm: `Make the ${kindLabel}`,
            cost: kind.value === "VIDEO" ? "Films it with AI. Takes about twenty to thirty minutes." : "Designs with AI. Takes one to three minutes.",
          },
          target: { type: "brief", id: b.value.id, path: b.value.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { makeOnePost } = await import("./compose.ts");
      const kind = one(d, "kind")!.v as PostKind;
      // Every video is a Seedance film, made by the worker: Jimmy queues it the way the studio does.
      if (kind === "VIDEO") {
        const { enqueueReel, startReelWorker } = await import("./reel.ts");
        const { AUTO_FILM } = await import("./film-choice.ts");
        const q = await enqueueReel({ orgId: ctx.orgId, actorUserId: ctx.userId, briefId: t.id, copyId: one(d, "card")!.v, placement: one(d, "size")!.v, format: "presenter", template: AUTO_FILM });
        if (!q.ok) return { ok: false, message: q.message };
        startReelWorker(ctx.orgId, q.jobId);
        return {
          ok: true,
          running: true,
          result: { message: "Started.", jobId: q.jobId, links: [{ label: "Open the studio", href: `/dashboard/campaigns/brief/${t.id}/studio` }] },
        };
      }
      const r = await makeOnePost({
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        briefId: t.id,
        kind,
        copyId: one(d, "card")!.v,
        placement: one(d, "size")!.v,
        template: null,
        slides: kind === "CAROUSEL" ? 5 : undefined,
      });
      if (!r.ok) return { ok: false, message: r.message };
      // A post the picture check held is made and shown, and is not offered for publishing.
      const next: NextAction[] = r.passed && ctx.authz.canAt("campaign:publish", t.path) ? [{ kind: "publish_post", label: "Publish it", inputs: { post: r.postId } }] : [];
      return {
        ok: true,
        result: {
          message: r.passed ? "Made, and it passed its checks." : "Made. Its picture waits for a person before it can go out.",
          image: `/dashboard/campaigns/brief/${t.id}/studio/post/${r.postId}/0`,
          links: [{ label: "Open the studio", href: `/dashboard/campaigns/brief/${t.id}/studio` }],
          next,
        },
      };
    },
  },
  {
    kind: "make_reel",
    label: "Make a story reel",
    topic: "campaigns",
    level: 2,
    keys: ["campaign:create"],
    detail: "Make a thirty-second narrated story reel for a campaign from a cleared copy card. Inputs: campaign, card, size (Meta reel 9:16, Meta story 9:16, YouTube 16:9).",
    inputs: ["campaign", "card", "size"],
    makes: true,
    working: "Making the reel. This takes twenty to forty minutes.",
    titles: { campaign: "Campaign", card: "Copy", size: "Size" },
    async step(ctx, d) {
      const b = await pickRecord(d, "campaign", "Which campaign is the reel for?", briefFinder(ctx, ["campaign:create"]), briefOption, "campaign");
      if (!b.ok) return b.step;
      const sizes = placementsFor("VIDEO", b.value.formats ?? []).map((p) => ({ value: p, label: p }));
      if (!sizes.length) return { refuse: `The brief for ${b.value.name} has no video sizes. Add a reel, story or YouTube size on the brief first.` };
      const cards = await copyFinder(ctx, b.value.id)({ id: null, words: "" });
      if (!cards.length) {
        return {
          refuse: `${b.value.name} has no cleared copy yet. The copy is written first.`,
          next: [{ kind: "write_copy", label: "Write the copy first", inputs: { campaign: b.value.id } }],
        };
      }
      const card = await pickRecord(d, "card", "Which copy should it tell?", copyFinder(ctx, b.value.id), copyOption, "cleared copy card");
      if (!card.ok) return card.step;
      const size = pickChoice(d, "size", "Which size?", sizes);
      if (!size.ok) {
        if (sizes.length === 1) d.filled.size = { v: sizes[0].value, label: sizes[0].label };
        else return size.step;
      }
      return {
        ready: {
          preview: {
            title: `Make a story reel for ${b.value.name}`,
            lines: [card.value.headline, one(d, "size")!.label, b.value.place],
            confirm: "Make the reel",
            cost: "Scripts, films and edits with AI. Takes twenty to forty minutes.",
          },
          target: { type: "brief", id: b.value.id, path: b.value.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { enqueueReel, startReelWorker } = await import("./reel.ts");
      const q = await enqueueReel({ orgId: ctx.orgId, actorUserId: ctx.userId, briefId: t.id, copyId: one(d, "card")!.v, placement: one(d, "size")!.v });
      if (!q.ok) return { ok: false, message: q.message };
      startReelWorker(ctx.orgId, q.jobId);
      return {
        ok: true,
        running: true,
        result: { message: "Started.", jobId: q.jobId, links: [{ label: "Open the studio", href: `/dashboard/campaigns/brief/${t.id}/studio` }] },
      };
    },
  },
  {
    kind: "publish_post",
    label: "Publish a post",
    topic: "campaigns",
    level: 2,
    keys: ["campaign:publish"],
    detail:
      "Put a post made in the studio on the developer's Facebook Page, Instagram or Google Business Profile, or create it as a paused Meta or Google ad. Inputs: post (its headline or campaign), destinations (Facebook, Instagram, Google Business, Meta ad, Google display ad, Google Demand Gen ad), goal (a Meta ad only: lead form, WhatsApp chats, website visits or reach), budget (rupees a day, ads only).",
    inputs: ["post", "destinations", "goal", "budget"],
    working: "Publishing",
    titles: { post: "Post", destinations: "Where", goal: "Meta ad for", budget: "Daily budget", landing: "Landing page" },
    async step(ctx, d) {
      const p = await pickRecord(d, "post", "Which post should go out?", postFinder(ctx, ["campaign:publish"]), postOption, "post");
      if (!p.ok) return p.step;
      const { publishOptions } = await import("./publish.ts");
      const opts = await publishOptions(ctx.orgId, p.value.id, ctx.now);
      if (!opts.ok) return { refuse: opts.message };
      const options = opts.options.map((o) => ({
        value: o.destination,
        label: o.label,
        detail: o.ad ? "Created paused. Nothing spends until someone switches it on." : o.accountName,
        disabled: o.ok ? (o.existing ? "Already published there" : null) : o.reason,
      }));
      if (options.every((o) => o.disabled)) return { refuse: `This post cannot go anywhere yet: ${options.map((o) => `${o.label}: ${o.disabled}`).join("; ")}` };
      const where = pickMany(d, "destinations", "Where should it go?", options);
      if (!where.ok) return where.step;
      const chosen = opts.options.filter((o) => where.value.includes(o.destination));
      const ads = chosen.filter((o) => o.ad);
      const lines = [p.value.headline, `${KIND_WORD[p.value.kind] ?? p.value.kind} · ${p.value.placement}`];
      const meta = chosen.find((o) => o.destination === "META_AD");
      if (meta?.goals?.length) {
        const goal = pickChoice(
          d,
          "goal",
          "What should the Meta ad do?",
          meta.goals.map((g) => ({ value: g.key, label: g.label, detail: g.ok ? g.detail : null, disabled: g.ok ? null : g.reason })),
        );
        if (!goal.ok) return goal.step;
        lines.push(`Meta ad for: ${meta.goals.find((g) => g.key === goal.value)?.label ?? goal.value}`);
      }
      if (ads.length) {
        const cap = Math.min(...ads.map((a) => a.dailyCap ?? 0));
        const budget = pickText(
          d,
          "budget",
          "What daily budget for the ad?",
          `Rupees a day, up to Rs ${cap.toLocaleString("en-IN")}`,
          (s) => {
            const n = readRupees(s);
            if (!n) return { problem: "Enter an amount in rupees." };
            if (n < 100) return { problem: "At least Rs 100 a day." };
            if (n > cap) return { problem: `This ad account allows up to Rs ${cap.toLocaleString("en-IN")} a day.` };
            return { value: String(n), label: `Rs ${n.toLocaleString("en-IN")} a day` };
          },
          [500, 1000, 1500].filter((n) => n <= cap).map((n) => ({ value: String(n), label: `Rs ${n.toLocaleString("en-IN")} a day` })),
        );
        if (!budget.ok) return budget.step;
        const landing = pickText(
          d,
          "landing",
          "Where should the ad send people?",
          "https://",
          (s) => {
            const u = /^https?:\/\//i.test(s) ? s : `https://${s}`;
            try {
              const parsed = new URL(u);
              return parsed.hostname.includes(".") ? { value: parsed.toString(), label: parsed.hostname } : { problem: "That is not a web address." };
            } catch {
              return { problem: "That is not a web address." };
            }
          },
          opts.website ? [{ value: opts.website, label: opts.website.replace(/^https?:\/\//, "") }] : [],
        );
        if (!landing.ok) return landing.step;
        lines.push(`Daily budget: Rs ${Number(budget.value).toLocaleString("en-IN")}, created paused`);
      }
      const labels = chosen.map((o) => o.label);
      const organic = chosen.filter((o) => !o.ad).map((o) => o.label);
      const confirm = [organic.length ? `Post to ${organic.join(" and ")}` : "", ads.length ? `create ${ads.length === 1 ? "a paused ad" : "paused ads"}` : ""]
        .filter(Boolean)
        .join(" and ");
      return {
        ready: {
          preview: { title: `Publish to ${labels.join(", ")}`, lines, confirm: confirm[0].toUpperCase() + confirm.slice(1), cost: organic.length ? "Goes out in public straight away." : null },
          target: { type: "post", id: p.value.id, path: p.value.path },
        },
      };
    },
    async run(ctx, d, t) {
      const { requestPublish } = await import("./publish.ts");
      const r = await requestPublish({
        orgId: ctx.orgId,
        userId: ctx.userId,
        postId: t.id,
        destinations: many(d, "destinations")!.vs,
        dailyBudget: one(d, "budget")?.v ?? null,
        destinationUrl: one(d, "landing")?.v ?? null,
        adGoal: one(d, "goal")?.v ?? null,
        now: ctx.now,
      });
      if (!r.ok) return { ok: false, message: r.message };
      const good = r.results.filter((x) => x.ok);
      if (!good.length) return { ok: false, message: r.results.map((x) => x.message).join(" ") || "Nothing went." };
      return {
        ok: true,
        result: { message: r.results.map((x) => `${DEST[x.destination] ?? x.destination}: ${x.message}`).join(" "), links: [{ label: "Open Published", href: "/dashboard/campaigns/live" }] },
      };
    },
  },
  {
    kind: "pause_ad",
    label: "Pause an ad",
    topic: "ads",
    level: 2,
    keys: [],
    anyKeys: STOP_KEYS,
    detail: "Pause a Meta or Google ad that is spending. Inputs: ad (its headline).",
    inputs: ["ad"],
    working: "Pausing",
    titles: { ad: "Ad" },
    async step(ctx, d) {
      const a = await pickRecord(d, "ad", "Which ad should pause?", adFinder(ctx, STOP_KEYS), adOption, "ad spending now");
      if (!a.ok) return a.step;
      return {
        ready: {
          preview: { title: "Pause this ad", lines: [a.value.headline, adOption(a.value).detail ?? ""], confirm: "Pause the ad" },
          target: { type: "ad", id: a.value.id, path: a.value.path },
        },
      };
    },
    async run(ctx, _d, t) {
      const { pausePublication } = await import("./publish.ts");
      const r = await pausePublication({ orgId: ctx.orgId, userId: ctx.userId, targetId: t.id });
      return r.ok ? { ok: true, result: { message: "Paused. It is not spending.", links: [{ label: "Open Published", href: "/dashboard/campaigns/live" }] } } : { ok: false, message: r.message };
    },
  },
];

export function actionByKind(kind: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.kind === kind);
}

/** Whether a person holds what an action needs anywhere at all. The target is checked later. */
export function mayOffer(def: ActionDef, authz: Pick<Authz, "can">): boolean {
  return def.keys.every((k) => authz.can(k)) && (!def.anyKeys || def.anyKeys.some((k) => authz.can(k)));
}

/** The actions this person may ask for, as the model reads them. */
export function actionCatalog(authz: Pick<Authz, "can">, topics: readonly TopicKey[] | null = null): string {
  const offered = ACTIONS.filter((a) => mayOffer(a, authz) && (!topics || topics.includes(a.topic) || topics.length === 0));
  if (!offered.length) return "";
  return offered.map((a) => `- ${a.kind}: ${a.detail}`).join("\n");
}

/** What Jimmy could do for somebody else but not for this person, in its own words. */
export function actionsLacked(authz: Pick<Authz, "can">): string {
  return ACTIONS.filter((a) => !mayOffer(a, authz)).map((a) => a.label.toLowerCase()).join(", ");
}

/** The things Jimmy never does, and where they are done instead. */
export const NOT_THROUGH_JIMMY =
  "Never through Jimmy, whoever asks: switching an ad's spend on or changing a budget (the Published screen), inviting or removing people and changing roles (Team, Settings), signing project facts or RERA records (Projects), and deleting anything (its own screen).";

// ---------------------------------------------------------------------------
// The organisation's switch
// ---------------------------------------------------------------------------

export async function actionsOn(orgId: string): Promise<boolean> {
  const [row] = await withTenant(orgId, (sql) => sql<{ actions_on: boolean }[]>`SELECT actions_on FROM ask_settings WHERE org_id = ${orgId}`);
  return row?.actions_on ?? true;
}

export async function setActionsOn(orgId: string, userId: string, on: boolean): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    INSERT INTO ask_settings (org_id, actions_on, updated_by) VALUES (${orgId}, ${on}, ${userId})
    ON CONFLICT (org_id) DO UPDATE SET actions_on = EXCLUDED.actions_on, updated_by = EXCLUDED.updated_by, updated_at = now()`);
  await audit({ orgId, actorUserId: userId, action: "ask.actions_switched", targetType: "org", targetId: orgId, metadata: { on } });
}

// ---------------------------------------------------------------------------
// The one path every action takes
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  thread_id: string;
  kind: string;
  state: ActionState;
  inputs: Draft;
  questions: Question[];
  preview: Preview | null;
  target: Target | null;
  result: ActionResult | null;
  updated_at: Date;
  created_at: Date;
};

function view(row: Row): ActionView {
  const def = actionByKind(row.kind);
  const d = row.inputs?.filled ? row.inputs : { filled: {}, hints: {} };
  const heading =
    row.state !== "ASKING" && row.preview?.title ? row.preview.title : def?.heading ? def.heading(d) : def?.label ?? row.kind;
  return {
    id: row.id,
    kind: row.kind,
    label: def?.label ?? row.kind,
    heading,
    state: row.state,
    questions: row.state === "ASKING" ? row.questions ?? [] : [],
    answered: recap(d, Object.fromEntries(Object.entries(def?.titles ?? {}).filter(([k]) => !def?.headed?.includes(k)))),
    preview: row.preview,
    result: row.result,
    working: row.state === "RUNNING" ? def?.working ?? "Working" : null,
    expiresAt: expiresAt(new Date(row.updated_at)).toISOString(),
  };
}

async function load(ctx: ActionCtx, id: string): Promise<Row | null> {
  if (!UUID.test(id)) return null;
  const [row] = await withPerson(ctx.orgId, ctx.userId, (sql) => sql<Row[]>`
    SELECT id, thread_id, kind, state, inputs, questions, preview, target, result, updated_at, created_at
    FROM ask_actions WHERE id = ${id}`);
  return row ?? null;
}

async function save(ctx: ActionCtx, id: string, patch: Partial<Pick<Row, "state" | "inputs" | "questions" | "preview" | "target" | "result">>, guard?: ActionState): Promise<Row | null> {
  const [row] = await withPerson(ctx.orgId, ctx.userId, (sql) => sql<Row[]>`
    UPDATE ask_actions SET
      state = coalesce(${patch.state ?? null}, state),
      inputs = ${patch.inputs ? sql.json(patch.inputs as never) : sql`inputs`},
      questions = ${patch.questions ? sql.json(patch.questions as never) : sql`questions`},
      preview = ${patch.preview !== undefined ? (patch.preview ? sql.json(patch.preview as never) : null) : sql`preview`},
      target = ${patch.target !== undefined ? (patch.target ? sql.json(patch.target as never) : null) : sql`target`},
      result = ${patch.result !== undefined ? (patch.result ? sql.json(patch.result as never) : null) : sql`result`},
      confirmed_at = CASE WHEN ${patch.state ?? null} = 'RUNNING' THEN now() ELSE confirmed_at END,
      finished_at = CASE WHEN ${patch.state ?? null} IN ('DONE', 'FAILED', 'CANCELLED', 'EXPIRED') THEN now() ELSE finished_at END,
      updated_at = now()
    WHERE id = ${id} AND ${guard ? sql`state = ${guard}` : sql`true`}
    RETURNING id, thread_id, kind, state, inputs, questions, preview, target, result, updated_at, created_at`);
  return row ?? null;
}

/** How many things this person has asked Jimmy to make today. */
async function madeToday(ctx: ActionCtx): Promise<number> {
  const kinds = ACTIONS.filter((a) => a.makes).map((a) => a.kind);
  const day = istToday(ctx.now);
  const [row] = await withPerson(ctx.orgId, ctx.userId, (sql) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ask_actions
    WHERE kind = ANY(${kinds}::text[]) AND state IN ('RUNNING', 'DONE')
      AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}::date`);
  return row?.n ?? 0;
}

const CAP_LINE = `You have asked Jimmy to make ${DAILY_MAKES} things today. Make more from the campaign's studio, or ask again tomorrow.`;

/** Run the action's step and store what it decided. */
async function advance(ctx: ActionCtx, row: Row): Promise<Row> {
  const def = actionByKind(row.kind)!;
  const d: Draft = { filled: { ...(row.inputs?.filled ?? {}) }, hints: { ...(row.inputs?.hints ?? {}) } };
  const s = await def.step({ ...ctx, threadId: row.thread_id }, d);
  if ("ask" in s) return (await save(ctx, row.id, { state: "ASKING", inputs: d, questions: s.ask.slice(0, MAX_QUESTIONS), preview: null, target: null }))!;
  if ("refuse" in s) return (await save(ctx, row.id, { state: "FAILED", inputs: d, questions: [], result: { message: s.refuse, next: s.next ?? [] } }))!;
  return (await save(ctx, row.id, { state: "PROPOSED", inputs: d, questions: [], preview: s.ready.preview, target: s.ready.target }))!;
}

export type Started = { ok: true; view: ActionView } | { ok: false; message: string };

/**
 * A phone number typed in the request names the buyer, whatever the model
 * made of "her": a lead here with that number is the one called, and a
 * number nobody here has is a new buyer to add and call. The model once
 * read "call 8652212814 and ask her" as the last lead the chat had named. A
 * name the model passed is kept only when the person typed it.
 */
/** Whether the person's own words name the language the agent should speak. */
export function namesLanguage(said: string): boolean {
  return /\b(hindi|marathi|english|hinglish)\b|हिंदी|हिन्दी|मराठी|इंग्लिश/i.test(said);
}

async function byNumber(ctx: ActionCtx, kind: string, hints: Record<string, string>, said: string): Promise<{ kind: string; hints: Record<string, string> }> {
  if (kind !== "call_lead" && kind !== "add_lead_and_call") return { kind, hints };
  const typed = numberIn(said);
  if (!typed) return { kind, hints };
  const keep = (k: string) => (hints[k]?.trim() ? { [k]: hints[k] } : {});
  const tower = hints.tower?.trim() || hints.project?.trim() || "";
  const e164 = normalisePhone(typed);
  const scopes = reach(ctx, ["lead:call"]);
  const known =
    e164 && scopes.length
      ? await withTenantReadOnly(ctx.orgId, (sql) => sql<{ id: string; name: string }[]>`
          SELECT l.id, l.name FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
          WHERE l.org_id = ${ctx.orgId} AND l.phone = ${e164} AND n.path <@ ANY(${scopes}::ltree[])
            AND l.stage NOT IN ('booked', 'lost')
          ORDER BY l.last_activity_at DESC LIMIT 6`)
      : [];
  const typedName = [hints.name, kind === "call_lead" ? hints.lead : undefined].find(
    (n) => n?.trim() && !UUID.test(n.trim()) && said.toLowerCase().includes(n.trim().toLowerCase()),
  );
  if (known.length) {
    // One open lead on the number, or the one named as typed, is the lead;
    // several are asked about, never the newest taken: three leads held
    // 9876501234, and "Call 9876501234" rang whichever moved last.
    const named = typedName ? known.filter((k) => sameName(k.name, typedName)) : [];
    const lead = named.length === 1 ? named[0].id : known.length === 1 ? known[0].id : e164!;
    const callAs: Record<string, string> = typedName && !named.length ? { callAs: typedName.trim() } : {};
    return {
      kind: "call_lead",
      hints: { lead, ...callAs, ...keep("goal"), ...keep("day"), ...(tower ? { project: tower } : {}) },
    };
  }
  return {
    kind: "add_lead_and_call",
    hints: { phone: typed, ...(typedName ? { name: typedName } : {}), ...(tower ? { tower } : {}), ...keep("language"), ...keep("goal"), ...keep("day") },
  };
}

/** Open an action in a chat, from what the request said about its inputs. */
export async function startAction(
  ctx: ActionCtx,
  threadId: string,
  asked: string,
  given: Record<string, string>,
  said = "",
): Promise<Started> {
  const { kind, hints } = await byNumber(ctx, asked, given, said);
  // The model fills a language in on its own ("Hindi" for "Sachin Sakpal");
  // only one the person named is kept, so the name's guess decides otherwise.
  if (kind === "add_lead_and_call" && hints.language && said.trim() && !namesLanguage(said)) delete hints.language;
  const def = actionByKind(kind);
  if (!def) return { ok: false, message: `There is no action called ${kind}.` };
  if (!(await actionsOn(ctx.orgId))) return { ok: false, message: "Jimmy is not allowed to take actions here. An admin can switch this on in Settings." };
  if (!mayOffer(def, ctx.authz)) return { ok: false, message: `You don't have access to ${def.label.toLowerCase()}. Ask your admin if you need it.` };
  if (def.makes && !limitsLifted() && (await madeToday(ctx)) >= DAILY_MAKES) return { ok: false, message: CAP_LINE };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(hints)) {
    const s = String(v ?? "").trim();
    if (s && (def.inputs.includes(k) || k === "landing" || k === "followUp" || k === "note" || k === "reason")) clean[k] = s.slice(0, 300);
  }
  const [row] = await withPerson(ctx.orgId, ctx.userId, (sql) => sql<Row[]>`
    INSERT INTO ask_actions (org_id, thread_id, user_id, kind, inputs)
    VALUES (${ctx.orgId}, ${threadId}, ${ctx.userId}, ${kind}, ${sql.json({ filled: {}, hints: clean } as never)})
    RETURNING id, thread_id, kind, state, inputs, questions, preview, target, result, updated_at, created_at`);
  const next = await advance(ctx, row);
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "ask.action_proposed", targetType: "ask_action", targetId: row.id, metadata: { kind, state: next.state } });
  return { ok: true, view: view(next) };
}

/** Expiry reads the real clock: `ctx.now` is the business day, which checks pin. */
async function expireIfDue(ctx: ActionCtx, row: Row): Promise<Row> {
  if (!hasExpired(row.state, new Date(row.updated_at), new Date())) return row;
  return (await save(ctx, row.id, { state: "EXPIRED", result: { message: "This expired. Ask again if you still need it." } }, row.state)) ?? row;
}

export type Acted = { ok: true; view: ActionView; later?: () => Promise<void> } | { ok: false; message: string };

/** The person answered the question card. */
export async function answerAction(ctx: ActionCtx, id: string, answers: Answer[]): Promise<Acted> {
  const found = await load(ctx, id);
  if (!found) return { ok: false, message: "That card is gone." };
  const row = await expireIfDue(ctx, found);
  if (row.state !== "ASKING") return { ok: true, view: view(row) };
  let d: Draft = { filled: { ...(row.inputs?.filled ?? {}) }, hints: { ...(row.inputs?.hints ?? {}) } };
  const questions = row.questions ?? [];
  for (const q of questions) {
    const a = answers.find((x) => x.input === q.input);
    if (!a) return { ok: false, message: `Answer "${q.title}" first.` };
    const problem = answerProblem(q, { input: a.input, values: (a.values ?? []).map(String).slice(0, 12), other: a.other ?? null });
    if (problem) return { ok: false, message: problem };
    d = applyAnswer(d, q, a);
  }
  const next = await advance(ctx, { ...row, inputs: d });
  return { ok: true, view: view(next) };
}

export async function cancelAction(ctx: ActionCtx, id: string): Promise<Acted> {
  const row = await load(ctx, id);
  if (!row) return { ok: false, message: "That card is gone." };
  if (row.state !== "ASKING" && row.state !== "PROPOSED") return { ok: true, view: view(row) };
  const next = (await save(ctx, id, { state: "CANCELLED", result: { message: "Cancelled. Nothing was done." } }, row.state)) ?? row;
  return { ok: true, view: view(next) };
}

/**
 * The person pressed the card's button. Everything is read again: the target
 * still exists and is still within reach, the keys are held there as they
 * stand now, the switch is on, the day's cap is not spent. Then one guarded
 * UPDATE moves it to RUNNING, and only the caller that won it runs it.
 * A long action hands its work back as `later`, for the route to run after
 * the answer has gone.
 */
export async function confirmAction(ctx: ActionCtx, id: string): Promise<Acted> {
  const found = await load(ctx, id);
  if (!found) return { ok: false, message: "That card is gone." };
  const row = await expireIfDue(ctx, found);
  if (row.state !== "PROPOSED") return { ok: true, view: view(row) };
  const def = actionByKind(row.kind)!;
  if (!(await actionsOn(ctx.orgId))) return { ok: false, message: "Jimmy is not allowed to take actions here any more." };

  const d: Draft = { filled: { ...(row.inputs?.filled ?? {}) }, hints: {} };
  const fresh = await def.step(ctx, d);
  if (!("ready" in fresh)) {
    // Everything was answered when the card was made; if it needs something
    // now, the lead moved, the post changed hands or a key was taken away.
    const message = "refuse" in fresh ? fresh.refuse : "Something changed since this card was made. Ask again to see what it needs now.";
    const failed = (await save(ctx, id, { state: "FAILED", result: { message } }, "PROPOSED")) ?? row;
    return { ok: true, view: view(failed) };
  }
  const t = fresh.ready.target;
  const allowed = fresh.ready.keys
    ? fresh.ready.keys.every((k) => ctx.authz.canAt(k, t.path))
    : def.keys.every((k) => ctx.authz.canAt(k, t.path)) && (!def.anyKeys || def.anyKeys.some((k) => ctx.authz.canAt(k, t.path)));
  if (!allowed) {
    const failed = (await save(ctx, id, { state: "FAILED", result: { message: "You no longer have access to do this here." } }, "PROPOSED")) ?? row;
    return { ok: true, view: view(failed) };
  }
  if (def.makes && !limitsLifted() && (await madeToday(ctx)) >= DAILY_MAKES) {
    const failed = (await save(ctx, id, { state: "FAILED", result: { message: CAP_LINE } }, "PROPOSED")) ?? row;
    return { ok: true, view: view(failed) };
  }
  const running = await save(ctx, id, { state: "RUNNING", target: t, preview: fresh.ready.preview }, "PROPOSED");
  if (!running) {
    // Somebody else's press won: this one runs nothing.
    const now = await load(ctx, id);
    return { ok: true, view: view(now ?? row) };
  }
  await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: "ask.action_confirmed", targetType: t.type, targetId: t.id, metadata: { kind: row.kind, via: "jimmy" } });

  const work = async (): Promise<{ row: Row; later?: () => Promise<void> }> => {
    let out: Run;
    try {
      out = await def.run(ctx, d, t);
    } catch (e) {
      console.error(`ask: the action ${row.kind} failed`, e);
      out = { ok: false, message: "Something went wrong while doing that. Try it from its screen." };
    }
    const state: ActionState = !out.ok ? "FAILED" : out.running ? "RUNNING" : "DONE";
    const result: ActionResult = out.ok ? out.result : { message: out.message };
    const saved = (await save(ctx, id, { state, result }, "RUNNING")) ?? running;
    await audit({ orgId: ctx.orgId, actorUserId: ctx.userId, action: out.ok ? "ask.action_done" : "ask.action_failed", targetType: t.type, targetId: t.id, metadata: { kind: row.kind, via: "jimmy" } });
    const follow = out.ok ? out.later : undefined;
    return {
      row: saved,
      later: follow
        ? async () => {
            try {
              await follow();
            } catch (e) {
              console.error(`ask: what follows ${row.kind} failed`, e);
            }
          }
        : undefined,
    };
  };

  if (def.background) {
    return {
      ok: true,
      view: view(running),
      later: async () => {
        const done = await work();
        await done.later?.();
      },
    };
  }
  const done = await work();
  return { ok: true, view: view(done.row), later: done.later };
}

/** A card's current state, for a screen polling a running action. A reel is read from its job. */
export async function actionStatus(ctx: ActionCtx, id: string): Promise<Acted> {
  const found = await load(ctx, id);
  if (!found) return { ok: false, message: "That card is gone." };
  let row = await expireIfDue(ctx, found);
  if (row.state === "RUNNING" && row.result?.jobId) {
    const [job] = await withTenant(ctx.orgId, (sql) => sql<{ state: string; stage: string; progress: number; message: string | null; post_id: string | null; brief_id: string }[]>`
      SELECT state, stage, progress, message, post_id, brief_id FROM reel_jobs WHERE org_id = ${ctx.orgId} AND id = ${row.result!.jobId!}`);
    if (job) {
      const links = row.result.links ?? [];
      if (job.state === "DONE") {
        row = (await save(ctx, id, { state: "DONE", result: { ...row.result, message: "The reel is ready.", progress: 100, stage: null, links } }, "RUNNING")) ?? row;
      } else if (job.state === "FAILED" || job.state === "STOPPED") {
        row = (await save(ctx, id, { state: "FAILED", result: { ...row.result, message: job.message ?? "The reel could not be made.", links } }, "RUNNING")) ?? row;
      } else {
        row = { ...row, result: { ...row.result, progress: job.progress, stage: job.stage } };
      }
    }
  }
  return { ok: true, view: view(row) };
}

/** Every action card in a chat, by id, for the page that draws the chat. */
/** The record inputs a card names, and what the chat calls each. */
const NAMED_RECORDS: [input: string, noun: string][] = [
  ["lead", "lead"],
  ["visit", "site visit with"],
  ["campaign", "campaign"],
  ["post", "post"],
  ["creative", "scheduled post"],
  ["schedule", "schedule"],
  ["ad", "ad"],
  ["tower", "tower"],
];

/**
 * What a chat remembers of its cards: each one as a line saying what it did
 * (`cardMemory()`), and the records the cards named, newest first, one of
 * each kind. The second is what "him", "this lead" and "the same campaign"
 * mean, and it reaches back past the last few messages, because a person who
 * called a lead, asked for a Diwali post and then said "call him again" still
 * means the lead.
 */
export async function chatMemory(
  orgId: string,
  userId: string,
  threadId: string,
): Promise<{ cards: Map<string, string>; named: string | null }> {
  const views = await actionViews(orgId, userId, threadId);
  const cards = new Map([...views].map(([id, v]) => [id, cardMemory(v)]));
  if (!UUID.test(threadId)) return { cards, named: null };
  const rows = await withPerson(orgId, userId, (sql) => sql<{ inputs: Draft | null }[]>`
    SELECT inputs FROM ask_actions WHERE thread_id = ${threadId} ORDER BY created_at DESC LIMIT 20`);
  const named: string[] = [];
  for (const [input, noun] of NAMED_RECORDS) {
    for (const r of rows) {
      const f = r.inputs?.filled?.[input];
      if (f && "v" in f && f.label) {
        named.push(`${noun} ${f.label}`);
        break;
      }
    }
  }
  return { cards, named: named.length ? named.join("; ") : null };
}

export async function actionViews(orgId: string, userId: string, threadId: string): Promise<Map<string, ActionView>> {
  const now = new Date();
  if (!UUID.test(threadId)) return new Map();
  const rows = await withPerson(orgId, userId, (sql) => sql<Row[]>`
    SELECT id, thread_id, kind, state, inputs, questions, preview, target, result, updated_at, created_at
    FROM ask_actions WHERE thread_id = ${threadId} ORDER BY created_at`);
  return new Map(
    rows.map((r) => {
      const expired = hasExpired(r.state, new Date(r.updated_at), now);
      return [r.id, view(expired ? { ...r, state: "EXPIRED", result: { message: "This expired. Ask again if you still need it." } } : r)];
    }),
  );
}
