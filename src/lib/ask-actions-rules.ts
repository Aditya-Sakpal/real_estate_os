/**
 * Ask Jimmy's actions, the pure half: the question card, the confirm card,
 * and reading what a person typed into "Other".
 *
 * Jimmy proposes an action and a person confirms it; the server then runs the
 * same function the screen's button runs. Between the two sits the question
 * card, and what it asks is decided here and in `ask-actions.ts`, never by
 * the model: each action lists its inputs, the model fills what the request
 * already said, and code asks for the rest. A choice that is one of the
 * person's records (a lead, a campaign, a post) is offered from their data;
 * a fixed choice (a stage, a size, a time slot) from the product's own lists.
 *
 * Imports are relative because the checks load this straight from source.
 */

import { toAsciiDigits } from "./creative-rules.ts";
import { istCivil } from "./post-rules.ts";
import { maskPhone } from "./mask-rules.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** A question or confirm card this old can no longer be answered or confirmed. */
export const ACTION_TTL_MINUTES = 10;
/** Posts, carousels, videos, reels and copy runs one person may ask Jimmy for in an IST day. */
export const DAILY_MAKES = 20;
/** Options a record question offers before "Other". */
export const RECORD_OPTIONS = 4;
/** Questions one card may carry. */
export const MAX_QUESTIONS = 3;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type QuestionOption = {
  value: string;
  label: string;
  /** A second line: the tower, the stage, the size. */
  detail?: string | null;
  /** Shown but not pickable, with the reason. */
  disabled?: string | null;
};

export type Question = {
  /** The input this answers. */
  input: string;
  title: string;
  /** one: pick one. many: pick any. text: type it. */
  kind: "one" | "many" | "text";
  options: QuestionOption[];
  /** Offers a text box for something not listed. Always on for `text`. */
  other: boolean;
  placeholder?: string | null;
  /** One line of state under the title, never a rationale. */
  note?: string | null;
  /** The option picked before the person touches anything: the obvious answer, still theirs to change. */
  default?: string | null;
  /** For a `many` question: the options ticked before the person touches anything. */
  defaults?: string[] | null;
};

export type Preview = {
  title: string;
  lines: string[];
  /** The button's words: what pressing it does. */
  confirm: string;
  /** What it spends or who it reaches, in one line. */
  cost?: string | null;
};

export type ActionState = "ASKING" | "PROPOSED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED" | "EXPIRED";

export type ActionLink = { label: string; href: string };

/** A next step offered on a finished action: pressing it starts that action with these inputs. */
export type NextAction = { kind: string; label: string; inputs: Record<string, string> };

export type ActionResult = {
  message: string;
  links?: ActionLink[];
  /** A picture of what was made. */
  image?: string | null;
  next?: NextAction[];
  /** A reel is made by a worker; its progress is read from its job. */
  jobId?: string | null;
  progress?: number | null;
  stage?: string | null;
};

export type ActionView = {
  id: string;
  kind: string;
  label: string;
  /** The card's own heading: the task as the person would say it, as far as it is known. */
  heading: string;
  state: ActionState;
  questions: Question[];
  /** What has been chosen so far, for the card's recap. */
  answered: { title: string; value: string }[];
  preview: Preview | null;
  result: ActionResult | null;
  /** While RUNNING, the words for what it is doing. */
  working: string | null;
  expiresAt: string;
};

/** One answer from the card: picked values, or text typed into Other. */
export type Answer = { input: string; values: string[]; other: string | null };

export type Filled = { v: string; label: string } | { vs: string[]; labels: string[] };

export type Draft = {
  filled: Record<string, Filled>;
  /** What the request said about an input, not yet matched to anything. */
  hints: Record<string, string>;
};

export const EMPTY_DRAFT: Draft = { filled: {}, hints: {} };

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function expiresAt(updatedAt: Date): Date {
  return new Date(updatedAt.getTime() + ACTION_TTL_MINUTES * 60_000);
}

export function hasExpired(state: ActionState, updatedAt: Date, now: Date): boolean {
  return (state === "ASKING" || state === "PROPOSED") && now >= expiresAt(updatedAt);
}

/** The IST date, `YYYY-MM-DD`. */
export function istToday(now: Date): string {
  const c = istCivil(now);
  return `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
}

function shift(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `Sat 26 Sep`. */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${d} ${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)}`;
}

/**
 * A date as a person types it: today, tomorrow, kal, parso, 27 Sep, 27/09,
 * 2026-09-27. `future` reads a bare day as the next one to come (a visit),
 * `past` as the last one gone (a booking date). Null when it cannot be read.
 */
export function readDate(raw: string, today: string, mode: "future" | "past"): string | null {
  const t = toAsciiDigits(raw).trim().toLowerCase();
  if (!t) return null;
  if (/^(today|aaj)$/.test(t)) return today;
  if (/^(tomorrow|tmrw|kal)$/.test(t)) return mode === "past" ? shift(today, -1) : shift(today, 1);
  if (/^(yesterday)$/.test(t)) return shift(today, -1);
  if (/^(day after( tomorrow)?|parso|parson)$/.test(t)) return mode === "past" ? shift(today, -2) : shift(today, 2);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const year = Number(today.slice(0, 4));
  const build = (y: number, m: number, d: number) => {
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return probe.toISOString().slice(0, 10);
  };
  const settle = (m: number, d: number) => {
    let out = build(year, m, d);
    if (!out) return null;
    if (mode === "future" && out < today) return build(year + 1, m, d);
    if (mode === "past" && out > today) return build(year - 1, m, d);
    return out;
  };
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dm = /^(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?([a-z]{3,9})\.?$/.exec(t);
  if (dm) {
    const m = MONTHS.indexOf(dm[2].slice(0, 3));
    return m >= 0 ? settle(m + 1, Number(dm[1])) : null;
  }
  const md = /^([a-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  if (md) {
    const m = MONTHS.indexOf(md[1].slice(0, 3));
    return m >= 0 ? settle(m + 1, Number(md[2])) : null;
  }
  const slash = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(t);
  if (slash) {
    const d = Number(slash[1]);
    const m = Number(slash[2]);
    if (slash[3]) {
      const y = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
      return build(y, m, d);
    }
    return settle(m, d);
  }
  return null;
}

/** Suggestions for a date question. */
export function dateOptions(today: string, mode: "future" | "past"): QuestionOption[] {
  const days = mode === "future" ? [0, 1, 2] : [0, -1, -2];
  return days.map((n) => {
    const iso = shift(today, n);
    const word = n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : null;
    return { value: iso, label: word ? `${word} (${dayLabel(iso)})` : dayLabel(iso) };
  });
}

/**
 * A clock time as a person says it, snapped to one of `slots` (`HH:MM`):
 * 5 pm, 5:30, 17:00, 5 baje (read as afternoon inside site hours). Null when
 * it is not one of the slots.
 */
export function readTime(raw: string, slots: readonly string[]): string | null {
  const t = toAsciiDigits(raw).trim().toLowerCase().replace(/\s+/g, " ");
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|baje)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  // "5 baje", or a bare "5": inside site hours that is the afternoon.
  if ((m[3] === "baje" || !m[3]) && h >= 1 && h <= 7) h += 12;
  const hhmm = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  return slots.includes(hhmm) ? hhmm : null;
}

/** `16:30` as `4:30 pm`. */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** Rupees as typed: 1500, Rs 1,500, 1.5k, 80 lakh, 1.2 Cr. Null when there is no number. */
export function readRupees(raw: string): number | null {
  const t = toAsciiDigits(raw).toLowerCase().replace(/,/g, "").replace(/rs\.?|inr|₹/g, " ").trim();
  const m = /^(\d+(?:\.\d+)?)\s*(k|thousand|lakh|lakhs|lac|l|cr|crore|crores)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "";
  const scale = unit.startsWith("k") || unit === "thousand" ? 1e3 : unit.startsWith("la") || unit === "l" ? 1e5 : unit.startsWith("cr") ? 1e7 : 1;
  const v = Math.round(n * scale);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Matching what was typed to an option
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  toAsciiDigits(s)
    .toLowerCase()
    .replace(/[·_\-/,.:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The one option a piece of text names, or null when it names none or more
 * than one. Exact value or label first, then a label containing the text,
 * then text containing a label. Never a guess between two.
 */
export function matchOption(text: string, options: readonly QuestionOption[]): QuestionOption | null {
  const q = norm(text);
  if (!q) return null;
  const live = options.filter((o) => !o.disabled);
  const exact = live.filter((o) => norm(o.value) === q || norm(o.label) === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const within = live.filter((o) => norm(o.label).includes(q) || norm(`${o.label} ${o.detail ?? ""}`).includes(q));
  if (within.length === 1) return within[0];
  if (within.length > 1) return null;
  const around = live.filter((o) => norm(o.label).length >= 3 && q.includes(norm(o.label)));
  return around.length === 1 ? around[0] : null;
}

/** An answer checked against the card it answers. Null when it holds; the reason when it does not. */
export function answerProblem(q: Question, a: Answer): string | null {
  const other = (a.other ?? "").trim();
  if (q.kind === "text") return other ? null : "Type an answer.";
  if (other) return q.other ? null : "Pick one of the options.";
  if (!a.values.length) return "Pick an option.";
  if (q.kind === "one" && a.values.length > 1) return "Pick just one.";
  for (const v of a.values) {
    const o = q.options.find((x) => x.value === v);
    if (!o) return "That option is no longer offered.";
    if (o.disabled) return o.disabled;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Building questions
// ---------------------------------------------------------------------------

export function oneOf(
  input: string,
  title: string,
  options: QuestionOption[],
  opts: { other?: boolean; note?: string | null; default?: string | null } = {},
): Question {
  const preset = opts.default && options.some((o) => o.value === opts.default && !o.disabled) ? opts.default : null;
  return { input, title, kind: "one", options, other: opts.other ?? true, note: opts.note ?? null, ...(preset ? { default: preset } : {}) };
}

/**
 * Words that only say "make a call": a goal made of them and a word for
 * qualifying ("a lead qualification call", "the usual call") is the usual
 * qualifying call, never a goal. Sent as a goal, "lead qualification call"
 * went to the goal agent, which then did nothing else.
 */
const CALL_FILLER =
  /\b(?:lead|leads|buyer|qualif\w*|usual|normal|regular|standard|first|intro\w*|call|calls|calling|a|an|the|him|her|them|this|that|give|make|do|place|just|please|karo|kar|do|ek|ko|se|now|again|abhi)\b/gi;

export function isUsualCall(said: string): boolean {
  const s = said.toLowerCase();
  return /\b(qualif\w*|usual|normal|regular|standard)\b/.test(s) && !s.replace(CALL_FILLER, "").replace(/[^\p{L}\p{N}]+/gu, "").length;
}

/**
 * What the last call to this lead in the same chat was for, carried to a new
 * call that does not say: "call him again, he didn't pick up" means the same
 * call, and asking what it should do again was asking for an answer the
 * person had already given. `prior` is the chat's call cards, newest first.
 * Only a card that got as far as its goal counts. The day is handed back as a
 * hint, so a site visit day is checked again rather than trusted.
 */
export function priorCall(prior: Draft[], leadId: string): { goal: Filled; day: string | null; project: Filled | null } | null {
  for (const p of prior) {
    const lead = p.filled?.lead;
    const goal = p.filled?.goal;
    if (!lead || !("v" in lead) || lead.v !== leadId || !goal || !("v" in goal)) continue;
    const day = p.filled.day;
    const project = p.filled.project;
    return {
      goal,
      day: goal.v === "site_visit" && day && "v" in day ? day.v : null,
      project: project && "v" in project ? project : null,
    };
  }
  return null;
}

export function anyOf(input: string, title: string, options: QuestionOption[], opts: { other?: boolean; note?: string | null } = {}): Question {
  return { input, title, kind: "many", options, other: opts.other ?? false, note: opts.note ?? null };
}

export function typed(input: string, title: string, placeholder: string, opts: { note?: string | null; options?: QuestionOption[] } = {}): Question {
  return { input, title, kind: opts.options?.length ? "one" : "text", options: opts.options ?? [], other: true, placeholder, note: opts.note ?? null };
}

/** A filled single value, or null. */
export function one(d: Draft, input: string): { v: string; label: string } | null {
  const f = d.filled[input];
  return f && "v" in f ? f : null;
}

export function many(d: Draft, input: string): { vs: string[]; labels: string[] } | null {
  const f = d.filled[input];
  return f && "vs" in f ? f : null;
}

/** An answer applied to a draft. Record and choice answers carry the option's value and label. */
export function applyAnswer(d: Draft, q: Question, a: Answer): Draft {
  const other = (a.other ?? "").trim();
  const filled = { ...d.filled };
  const hints = { ...d.hints };
  if (other && q.kind !== "text") {
    // Typed into Other: matched like anything else a person typed.
    delete filled[q.input];
    hints[q.input] = other.slice(0, 300);
    return { filled, hints };
  }
  if (q.kind === "text") {
    delete filled[q.input];
    hints[q.input] = other.slice(0, 1000);
    return { filled, hints };
  }
  const picked = a.values.map((v) => q.options.find((o) => o.value === v)!).filter(Boolean);
  if (q.kind === "many") filled[q.input] = { vs: picked.map((o) => o.value), labels: picked.map((o) => o.label) };
  else filled[q.input] = { v: picked[0].value, label: picked[0].label };
  delete hints[q.input];
  return { filled, hints };
}

/** The recap under a card's title: what has been chosen, in the order it was asked. */
export function recap(d: Draft, titles: Record<string, string>): { title: string; value: string }[] {
  return Object.entries(d.filled)
    .filter(([k]) => titles[k])
    .map(([k, f]) => ({ title: titles[k], value: "v" in f ? f.label : f.labels.join(", ") }));
}

const CARD_STATE: Record<ActionState, string> = {
  ASKING: "Waiting for an answer",
  PROPOSED: "Waiting to be confirmed",
  RUNNING: "Running",
  DONE: "Done",
  FAILED: "Did not happen",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

/**
 * A card as the chat remembers it. The card's own message in the chat is a
 * line like "Here it is", which says nothing about what it was, so the next
 * question read "call him again" beside three of those and did not know who
 * "him" was. This is what the models are shown instead: what the card does,
 * for whom, and how it ended.
 */
export function cardMemory(v: ActionView): string {
  const goal = v.preview?.lines.find((l) => l.startsWith("Goal:"));
  const said = v.state === "ASKING" ? v.questions[0]?.title : v.result?.message;
  return `[Card: ${v.heading}${goal ? `. ${goal}` : ""}. ${CARD_STATE[v.state]}${said ? `: ${said}` : ""}]`;
}

/**
 * A buyer's number on a card, masked the one way every screen masks it
 * (`98XXXXXX10`). A card is a summary, so it is masked for everybody: the
 * lead's own page shows the rest to whoever may see it.
 */
export function maskedPhone(e164: string): string {
  const d = e164.replace(/[^\d]/g, "").slice(-10);
  return d.length < 10 ? "Number on file" : maskPhone(d);
}

/**
 * The things Jimmy never does, read off the request itself before a model
 * picks an action. Told "switch on the ad spend for the Diwali campaign", the
 * analyst once opened a card to publish a post instead: a prompt is guidance,
 * this is the control. Each answer names where it is done.
 */
const NEVER: { re: RegExp; line: string; link: { label: string; href: string } }[] = [
  {
    re: /\b(switch|turn|start)\w*\s+(\w+\s+){0,4}(spend|spending)\b|\b(spend|spending)\s+on\b|\b(set|change|raise|increase|lower|reduce|double|cut)\w*\s+(\w+\s+){0,5}budget\b/i,
    line: "Jimmy never switches an ad's spend on or changes a budget. Do it on the Published screen.",
    link: { label: "Published", href: "/dashboard/campaigns/live" },
  },
  {
    re: /\binvite\b|\b(change|give|make|assign|promote)\w*\s+(\w+\s+){0,4}(role|admin)\b/i,
    line: "Jimmy never invites people or changes what they can do. Do it on the Team screen.",
    link: { label: "Team", href: "/dashboard/team" },
  },
  {
    re: /\bsign\w*\s+(\w+\s+){0,4}(brain|facts?)\b|\b(record|add|change|edit)\w*\s+(\w+\s+){0,3}rera\b/i,
    line: "Jimmy never signs project facts or records a RERA registration. Do it on the project's own page.",
    link: { label: "Projects", href: "/dashboard/projects" },
  },
  {
    re: /\b(delete|erase)\b/i,
    line: "Jimmy never deletes anything. Do it on that record's own screen.",
    link: { label: "Today", href: "/dashboard" },
  },
];

export function neverThroughJimmy(said: string): { line: string; link: { label: string; href: string } } | null {
  const hit = NEVER.find((n) => n.re.test(said));
  return hit ? { line: hit.line, link: hit.link } : null;
}

/**
 * A request that starts with something Jimmy does. The router once called
 * "Call QA Test 2" off topic, eight questions into a chat about numbers, and
 * the person was told what Jimmy can answer instead of being shown the card.
 */
export function startsWithAction(said: string, strict = false): boolean {
  // Read as a data question, a verb that also starts questions ("make a list", "start date") is left to the router.
  if (strict) return /^\s*(please\s+|pls\s+|can you\s+|could you\s+|jimmy,?\s+)?(call|ring|dial|move|book|reschedule|pause|resume|approve|reject|publish|send|assign|check in)\b/i.test(said);
  return /^\s*(please\s+|pls\s+|can you\s+|could you\s+|jimmy,?\s+)?(call|ring|dial|move|book|reschedule|cancel|make|create|write|publish|pause|resume|approve|reject|stop|start|send|add|mark|check in|assign)\b/i.test(said);
}
