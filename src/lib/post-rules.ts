/**
 * Scheduled posts, decided without a database and without a model.
 *
 * The machine is one sentence: a schedule fires into a run, a run generates
 * creatives, each creative carries a verdict, and the mode decides what
 * happens next. This file holds every part of that a pure function can
 * answer, so `check:logic` covers it and `post.ts` is left with reads,
 * writes and the one call to a model.
 *
 * Three things here are load-bearing and easy to get quietly wrong.
 *
 * The clock. Times are Asia/Kolkata, the server is UTC, and IST is a half
 * hour off the hour. Left to `toLocaleString` or the host's own timezone this
 * drifts by thirty minutes on some machines and by a day near midnight, and
 * neither is visible until a post goes out on Sunday morning.
 *
 * The slot. A run's identity is the COMPUTED instant it was scheduled for,
 * never `now()`. That is what lets the database refuse a second fire rather
 * than the runner usually winning a race.
 *
 * The release decision. AUTO publishes what PASSED and nothing else. A HOLD
 * waits for a person in both modes, which is the whole reason HOLD exists.
 *
 * Imports are relative because the checks load this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

import { createHash } from "node:crypto";
import type { ScopeKind } from "./roles.ts";
import type { LocalLines, Verdict } from "./creative-rules.ts";
import type { PostKind } from "./compose-rules.ts";
import type { CardAngle } from "./card-angle-core.ts";
import { styleOf, type DatedPost, type Outlet, type PostStyle, type Repeat, type StyleSet } from "./plan-rules.ts";

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/** IST, fixed. No daylight saving, and a half hour off the hour. */
export const IST_OFFSET_MINUTES = 330;

export const TIMEZONE = "Asia/Kolkata";

export type IstCivil = {
  year: number;
  /** 1 to 12, the way a person writes it, not the way Date does. */
  month: number;
  day: number;
  /** Sunday 0 through Saturday 6. */
  dow: number;
  /** Minutes from IST midnight. */
  minute: number;
};

/**
 * The IST wall clock at an instant.
 *
 * Shifting the instant and then reading it in UTC is the only arithmetic here
 * that cannot be wrong on a machine set to another timezone. Reading local
 * fields would answer in the host's timezone, which on a developer's laptop
 * is IST and on a server is not, so it would pass every test it was written
 * beside.
 */
export function istCivil(at: Date): IstCivil {
  const t = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    dow: t.getUTCDay(),
    minute: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

/** The instant at which the IST wall clock reads this date and minute. */
export function istInstant(
  year: number,
  month: number,
  day: number,
  minute: number,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, 0, minute) - IST_OFFSET_MINUTES * 60_000,
  );
}

/** `14:30`, which is how a cadence is read back on screen. */
export function showMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function showDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort();
  if (sorted.length === 7) return "Every day";
  if (sorted.length === 5 && sorted.join() === "1,2,3,4,5") return "Weekdays";
  if (sorted.length === 2 && sorted.join() === "0,6") return "Weekends";
  return sorted.map((d) => DAY_NAMES[d]).join(", ");
}

/** The IST calendar date, as a `YYYY-MM-DD` string. */
export function istDate(at: Date): string {
  const c = istCivil(at);
  return `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

export type Mode = "AUTO" | "REVIEW";

export const MODES: { key: Mode; label: string; detail: string }[] = [
  {
    key: "REVIEW",
    label: "Review first",
    detail: "Every post waits for somebody to approve it before it goes out.",
  },
  {
    key: "AUTO",
    label: "Send automatically",
    detail: "Posts that clear every check go out on their own. Anything held still waits.",
  },
];

export function isMode(raw: string | null | undefined): raw is Mode {
  return MODES.some((m) => m.key === raw);
}

/**
 * AUTO is offered, behind a warning, since 27 September 2026.
 *
 * AUTO is REVIEW with the person removed. What stands between a generated
 * post and a buyer in AUTO is the copy gate, the design check
 * (`reviewDesign()` and the QR scan), the pixel gate on the finished files
 * (`pixel-rules.ts`: the QR at the sizes a buyer meets it, the number read
 * back, where the block sits, its size and contrast, the small print, the
 * prices) and the publish-time gates in `prepare()`, which refuse anything
 * without a pixel PASS. The form still warns that AI makes mistakes and asks
 * for an explicit yes. Four things hold: a HOLD waits for a person
 * (`releaseFor()`), a creative whose picture has no pixel PASS goes back to
 * waiting for one, a picture that failed its check never publishes, and only
 * somebody who could approve and publish these posts by hand may turn it on.
 *
 * Setting this false takes the choice off the form, refuses the mode, and
 * sends every post from a schedule already saved as AUTO to a person again.
 */
export const AUTO_AVAILABLE = true;

/**
 * AUTO with nowhere to publish would approve posts nobody looked at and then
 * do nothing with them, which is a control that does nothing.
 */
export function autoProblem(
  mode: Mode,
  destinations: readonly string[] | undefined,
): string | null {
  if (mode !== "AUTO") return null;
  if (!destinations?.length) return "Pick where posts go, or choose Review first.";
  return null;
}

export function modeAllowed(mode: Mode): { ok: true } | { ok: false; message: string } {
  if (mode === "AUTO" && !AUTO_AVAILABLE) {
    return {
      ok: false,
      message:
        "Sending automatically is not available yet. Every post has to be approved by somebody first.",
    };
  }
  return { ok: true };
}

/** A schedule hangs off a brief, and a brief hangs off one of these. */
export const SCHEDULE_KINDS: ScopeKind[] = ["PROJECT", "PHASE"];

export function scheduleFitsNode(kind: ScopeKind): boolean {
  return SCHEDULE_KINDS.includes(kind);
}

export type Cadence = {
  /** Sunday 0 through Saturday 6, in IST. */
  daysOfWeek: number[];
  /** Minutes from IST midnight. The PUBLISH time. */
  atMinute: number;
  /** How far ahead of publishing a run starts. */
  leadMinutes: number;
};

export const MIN_LEAD_MINUTES = 5;
export const MAX_LEAD_MINUTES = 7 * 24 * 60;

/**
 * How much lead time REVIEW wants.
 *
 * Not enforced, deliberately. A marketing head who wants to write at nine and
 * approve at eleven is making a sensible choice about their own morning, and
 * a floor here would only push them to AUTO, which is the one thing this
 * number exists to avoid. It is the default and the thing the screen suggests.
 */
export const REVIEW_LEAD_MINUTES = 24 * 60;
export const AUTO_LEAD_MINUTES = 60;

export type Schedule = {
  name: string;
  mode: Mode;
  daysOfWeek: number[];
  atMinute: number;
  leadMinutes: number;
  maxRunsPerDay: number;
  startsOn: string | null;
  endsOn: string | null;
  active: boolean;
  /** Every week, or on dates picked from a calendar. Absent is every week. */
  repeat?: Repeat;
  /** The picked dates, for a schedule that repeats on dates. */
  dated?: DatedPost[];
};

/** What the slot arithmetic reads off a schedule. */
export type SlotPlan = Pick<Schedule, "daysOfWeek" | "atMinute" | "startsOn" | "endsOn"> & {
  repeat?: Repeat;
  dated?: readonly DatedPost[];
};

export function emptySchedule(name = ""): Schedule {
  return {
    name,
    mode: "REVIEW",
    daysOfWeek: [2, 5],
    atMinute: 10 * 60,
    leadMinutes: REVIEW_LEAD_MINUTES,
    maxRunsPerDay: 1,
    startsOn: null,
    endsOn: null,
    active: true,
  };
}

export type ScheduleField = "name" | "days" | "dates" | "time" | "lead" | "window";

/**
 * What is missing or wrong, in the order the form asks for it. Each gap says
 * in a sentence what to do: "An end date after the start date is missing"
 * was one label squeezed into a template that fitted none of them.
 *
 * Every column is nullable or defaulted in the database for the reason
 * `briefGaps()` gives: a constraint that refuses a half-written schedule is a
 * constraint that keeps schedules in somebody's head. Completeness lives
 * here.
 *
 * `today` is the IST date. Given, a weekly plan whose end date has passed is
 * refused: it was saved and shown Running with nothing left to run.
 */
export function scheduleGaps(
  s: Schedule,
  today?: string,
): { key: ScheduleField; label: string; message: string }[] {
  const gaps: { key: ScheduleField; label: string; message: string }[] = [];
  if (!s.name.trim()) gaps.push({ key: "name", label: "A name", message: "Give the schedule a name." });
  if (s.repeat === "DATES") {
    if (!s.dated?.length) gaps.push({ key: "dates", label: "At least one date", message: "Pick at least one date." });
  } else if (!s.daysOfWeek.length) {
    gaps.push({ key: "days", label: "Which days", message: "Pick at least one day for a post." });
  }
  if (!Number.isInteger(s.atMinute) || s.atMinute < 0 || s.atMinute > 1439) {
    gaps.push({ key: "time", label: "What time", message: "Pick the time it goes out." });
  }
  if (
    !Number.isInteger(s.leadMinutes) ||
    s.leadMinutes < MIN_LEAD_MINUTES ||
    s.leadMinutes > MAX_LEAD_MINUTES
  ) {
    gaps.push({ key: "lead", label: "How far ahead to write it", message: "Pick how far ahead each post is written." });
  }
  if (s.repeat !== "DATES") {
    if (s.startsOn && s.endsOn && s.endsOn < s.startsOn) {
      gaps.push({ key: "window", label: "The dates", message: "The end date can't be before the start date." });
    } else if (today && s.endsOn && s.endsOn < today) {
      gaps.push({ key: "window", label: "The dates", message: "The end date has already passed." });
    }
  }
  return gaps;
}

/** The days a person ticked, kept to the ones that are days. */
export function pickDays(raw: readonly (string | number)[]): number[] {
  const out = new Set<number>();
  for (const value of raw) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return [...out].sort();
}

/** `09:30` or `9:30`, and nothing else. A bad value is no value. */
export function parseMinute(raw: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * How far ahead slots are ever computed in one pass.
 *
 * A bound rather than a preference. Without it a schedule with an end date
 * ten years out, asked for its slots by a caller that passed the wrong
 * window, walks three and a half thousand days building an array nobody
 * wanted.
 */
export const MAX_SLOTS = 400;

export type SlotWindow = { from: Date; to: Date };

/**
 * Every publish instant this schedule lands on in a window, half open on the
 * left: `from` exclusive, `to` inclusive.
 *
 * Half open because the caller's `from` is almost always the last slot it
 * already handled, and a closed interval would hand that same slot back every
 * time the runner woke up. The unique index would refuse the duplicate row,
 * so the bug would be invisible and the runner would simply do nothing
 * forever.
 */
export function slotsBetween(s: SlotPlan, window: SlotWindow): Date[] {
  if (window.to.getTime() <= window.from.getTime()) return [];
  if (s.repeat === "DATES") {
    // The picked dates are the slots. The start and end dates belong to a
    // weekly plan; a calendar already says when it begins and ends.
    return (s.dated ?? [])
      .map((d) => datedInstant(d))
      .filter((at) => at.getTime() > window.from.getTime() && at.getTime() <= window.to.getTime())
      .sort((a, b) => a.getTime() - b.getTime())
      .slice(0, MAX_SLOTS);
  }
  const days = new Set(pickDays(s.daysOfWeek));
  if (!days.size) return [];

  const out: Date[] = [];
  // Start a day early and finish a day late: a slot at 23:45 IST sits in the
  // previous UTC day, so walking UTC dates alone loses it at the edges.
  const first = istCivil(new Date(window.from.getTime() - 86_400_000));
  let cursor = Date.UTC(first.year, first.month - 1, first.day);
  const lastAt = istCivil(new Date(window.to.getTime() + 86_400_000));
  const last = Date.UTC(lastAt.year, lastAt.month - 1, lastAt.day);

  for (let guard = 0; cursor <= last && guard < MAX_SLOTS + 2; guard++) {
    const d = new Date(cursor);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    cursor += 86_400_000;

    if (!days.has(d.getUTCDay())) continue;

    const iso = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (s.startsOn && iso < s.startsOn) continue;
    if (s.endsOn && iso > s.endsOn) continue;

    const at = istInstant(y, m, day, s.atMinute);
    if (at.getTime() <= window.from.getTime()) continue;
    if (at.getTime() > window.to.getTime()) continue;
    out.push(at);
    if (out.length >= MAX_SLOTS) break;
  }
  return out;
}

/** The next publish instant strictly after `after`. Null past the end date. */
export function nextSlotAfter(s: SlotPlan, after: Date): Date | null {
  const [first] = slotsBetween(s, {
    from: after,
    to: new Date(after.getTime() + 370 * 86_400_000),
  });
  return first ?? null;
}

/**
 * Whether this schedule still lands on this exact instant: the day, the time
 * and the date window all agree. What an edited schedule asks of the runs it
 * already made.
 */
export function slotFits(s: SlotPlan, slot: Date): boolean {
  const [hit] = slotsBetween(s, { from: new Date(slot.getTime() - 1), to: slot });
  return hit?.getTime() === slot.getTime();
}

/** The instant a picked date posts at. */
export function datedInstant(d: Pick<DatedPost, "on" | "at">): Date {
  const [y, m, day] = d.on.split("-").map(Number);
  return istInstant(y, m, day, d.at);
}

/**
 * What one slot makes and how it goes out: the date's own entry on a
 * calendar, or the weekday's on a week plan. A slot the plan no longer has
 * (edited after the run was made) is an image posted organically, the
 * behaviour every schedule had before either choice existed.
 */
export function entryAt(
  plan: {
    repeat?: Repeat;
    dayKinds?: readonly (PostKind | null)[] | null;
    dayOutlets?: readonly (Outlet | null)[] | null;
    dated?: readonly DatedPost[];
    /** The schedule's own style for each kind. */
    styles?: Partial<StyleSet> | null;
    /** A weekday's own style, Sunday first. */
    dayStyles?: readonly (PostStyle | null)[] | null;
  },
  slot: Date,
): { kind: PostKind; outlet: Outlet; style: PostStyle } {
  if (plan.repeat === "DATES") {
    const hit = (plan.dated ?? []).find((d) => datedInstant(d).getTime() === slot.getTime());
    return hit
      ? { kind: hit.kind, outlet: hit.outlet, style: styleOf(hit, plan.styles) }
      : { kind: "IMAGE", outlet: "POST", style: styleOf({ kind: "IMAGE" }, plan.styles) };
  }
  const dow = istCivil(slot).dow;
  const kind = plan.dayKinds?.[dow] ?? "IMAGE";
  return {
    kind,
    outlet: plan.dayOutlets?.[dow] ?? "POST",
    style: styleOf({ kind, style: plan.dayStyles?.[dow] ?? null }, plan.styles),
  };
}

/** When a run for this slot should start writing. */
export function generateAtFor(slot: Date, leadMinutes: number): Date {
  return new Date(slot.getTime() - leadMinutes * 60_000);
}

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

/**
 * How long a worker's claim on a run lasts.
 *
 * Longer than a run takes and shorter than a person would wait. Too short and
 * a slow model call lets a second worker take live work; too long and a
 * worker killed mid-run leaves its slot frozen until somebody notices.
 */
export const LEASE_MINUTES = 15;

/** How many times a run is retried before it is left FAILED. */
export const MAX_ATTEMPTS = 3;

export type LeaseState = {
  state: string;
  leaseUntil: Date | null;
  attempts: number;
};

/**
 * Whether this run is free to be picked up.
 *
 * A run nobody holds, or one whose holder's lease has run out. The second
 * half is what stops a dead worker freezing a slot, and the attempt count is
 * what stops a run that crashes the same way three times from being retried
 * forever.
 */
export function claimable(run: LeaseState, now: Date): boolean {
  if (run.attempts >= MAX_ATTEMPTS) return false;
  if (run.state === "PENDING") return true;
  if (run.state !== "RUNNING") return false;
  return !run.leaseUntil || run.leaseUntil.getTime() <= now.getTime();
}

export function leaseUntil(now: Date): Date {
  return new Date(now.getTime() + LEASE_MINUTES * 60_000);
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

export type Release = "PUBLISH" | "REVIEW" | "BLOCK";

/**
 * What happens to one creative, given the mode and its verdict.
 *
 * The whole of the two modes is this table, and the row that matters is AUTO
 * plus HOLD. A HOLD is what a machine could not settle: a registration inside
 * thirty days of lapsing, copy in a script the word checks cannot read, a
 * configuration nobody recorded. Letting AUTO publish one would delete the
 * reason HOLD exists, and every HOLD reason would silently become a PASS.
 *
 * A FAIL is BLOCK in both modes and is still shown, because a refusal nobody
 * can see is a refusal nobody can fix, and the reason usually names something
 * missing from the Brain rather than something wrong with the writing.
 */
export function releaseFor(mode: Mode, verdict: Verdict): Release {
  if (verdict === "FAIL") return "BLOCK";
  if (verdict === "HOLD") return "REVIEW";
  return mode === "AUTO" ? "PUBLISH" : "REVIEW";
}

/**
 * Whether a creative may still go out at this instant.
 *
 * Two ways it may not, and they are different failures. Its slot has passed
 * and nobody looked, which expires it rather than slipping it: a slot that
 * slipped would arrive beside the next slot's own creative and two posts
 * would land the day somebody finally opened the queue. Or its occasion has
 * passed, which is the false-offer case: "no floor rise until Diwali",
 * published on the 10th when Diwali was the 8th, is a claim Section 12
 * unwinds a booking over and it does not care that a scheduler did it.
 */
export type Lateness = { late: boolean; code: "SLOT_PASSED" | "OCCASION_PASSED" | null };

/** How long past its publish time a creative is still worth sending. */
export const GRACE_MINUTES = 6 * 60;

export function lateness(
  creative: { hardStopAt: Date | null },
  run: { publishAt: Date },
  now: Date,
): Lateness {
  if (creative.hardStopAt && now.getTime() > creative.hardStopAt.getTime()) {
    return { late: true, code: "OCCASION_PASSED" };
  }
  if (now.getTime() > run.publishAt.getTime() + GRACE_MINUTES * 60_000) {
    return { late: true, code: "SLOT_PASSED" };
  }
  return { late: false, code: null };
}

// ---------------------------------------------------------------------------
// Occasions
// ---------------------------------------------------------------------------

export type OccasionKind = "BUYING" | "GREETING";

export type Occasion = {
  id: string;
  key: string;
  name: string;
  /** `YYYY-MM-DD`, in IST. */
  onDate: string;
  kind: OccasionKind;
  /** State codes. Empty is everywhere. */
  regions: string[];
  verified: boolean;
};

/** How near an occasion has to be before a run leans on it. */
export const OCCASION_WINDOW_DAYS = 7;

/**
 * The occasion a run should lead on, or none.
 *
 * Four filters and every one of them refuses rather than guesses.
 *
 * Opted in, because posting a festival on a developer's behalf is not a thing
 * to infer from anything. Verified, because the hard stop is computed from
 * this date and a lunar date nobody checked publishes a false offer on its
 * own. In region, because a Pune developer wishing people a happy Onam reads
 * as a template nobody configured. And near, because an occasion three months
 * out is not what this post is about.
 */
export function pickOccasion(input: {
  occasions: readonly Occasion[];
  optedIn: readonly string[];
  /** The registration's state code. Null matches only nationwide occasions. */
  region: string | null;
  at: Date;
  windowDays?: number;
}): Occasion | null {
  const opted = new Set(input.optedIn);
  const today = istDate(input.at);
  const window = input.windowDays ?? OCCASION_WINDOW_DAYS;
  const until = istDate(new Date(input.at.getTime() + window * 86_400_000));

  const near = input.occasions.filter((o) => {
    if (!o.verified) return false;
    if (!opted.has(o.key)) return false;
    if (o.onDate < today || o.onDate > until) return false;
    if (!o.regions.length) return true;
    return input.region ? o.regions.includes(input.region) : false;
  });

  // The soonest, and a buying occasion ahead of a greeting one on the same
  // day: Gudi Padwa and Ugadi fall together and only one of them can lead.
  return (
    near.sort((a, b) =>
      a.onDate === b.onDate
        ? Number(b.kind === "BUYING") - Number(a.kind === "BUYING")
        : a.onDate < b.onDate
          ? -1
          : 1,
    )[0] ?? null
  );
}

/** End of the occasion's own day in IST. The schedule's dates never set this. */
export function hardStopFor(o: Occasion | null): Date | null {
  if (!o) return null;
  const [y, m, d] = o.onDate.split("-").map(Number);
  return istInstant(y, m, d, 23 * 60 + 59);
}

/**
 * Whether an offer may ride along.
 *
 * A greeting occasion carries no offer and no price at all. Holi is not a
 * sales event, and a developer whose Holi post quotes a booking amount has
 * said something about themselves rather than about the building.
 */
export function offerAllowed(o: Occasion | null): boolean {
  return o === null || o.kind === "BUYING";
}

// ---------------------------------------------------------------------------
// Originality
// ---------------------------------------------------------------------------

export type TemplateKey =
  | "PRICE_REVEAL"
  | "THREE_THINGS"
  | "WALKTHROUGH"
  | "LOCATION_LED"
  | "PROGRESS";

export const TEMPLATES: {
  key: TemplateKey;
  label: string;
  /** What the copy is asked to do, appended to the writer's instruction. */
  brief: string;
  /** True where the template leads on a number, so it needs an approved one. */
  needsPrice: boolean;
}[] = [
  {
    key: "PRICE_REVEAL",
    label: "Price reveal",
    brief: "Lead with what a configuration starts at, and name the configuration it belongs to.",
    needsPrice: true,
  },
  {
    key: "THREE_THINGS",
    label: "Three things",
    brief: "Three short approved facts, one line each, no price.",
    needsPrice: false,
  },
  {
    key: "WALKTHROUGH",
    label: "Walkthrough",
    brief: "Describe moving through one approved space. No price, no returns.",
    needsPrice: false,
  },
  {
    key: "LOCATION_LED",
    label: "Location",
    brief: "Lead on where it is and what is near it, using only approved talking points.",
    needsPrice: false,
  },
  // OFF construction: {
  // OFF construction:   key: "PROGRESS",
  // OFF construction:   label: "Progress",
  // OFF construction:   brief: "Lead on construction progress. State no possession date other than the approved one.",
  // OFF construction:   needsPrice: false,
  // OFF construction: },
];

export function templateDef(key: string) {
  return TEMPLATES.find((t) => t.key === key);
}

export type Variation = {
  template: TemplateKey;
  /** The talking point that leads. Null where the Brain has none. */
  leadPoint: string | null;
  /** The approved asset this creative is built from. Null until composed. */
  assetId: string | null;
  occasionId: string | null;
};

export type VariationPools = {
  talkingPoints: readonly string[];
  /** Approved asset ids, in the order the library returned them. */
  assetIds: readonly string[];
  /** True where at least one configuration carries an approved price. */
  hasPrice: boolean;
};

export type RecentChoice = {
  template: string;
  leadPoint: string | null;
  assetId: string | null;
};

/**
 * How many past runs steer the next one.
 *
 * Small on purpose. Steering away from the last three keeps a feed from
 * repeating itself; steering away from the last thirty would exhaust a
 * three-point Brain and force the rotation back to the start anyway, having
 * spent the effort to pretend otherwise.
 */
export const RECENT_DEPTH = 3;

/**
 * The five choices, steered away from the last few.
 *
 * Two developers using this product must not produce the same feed, and one
 * developer must not produce the same post fifty times. That is not only
 * taste: Meta suppresses repetitive creative, so sameness costs reach before
 * anybody finds it boring.
 *
 * Least recently used rather than random. Random repeats, and a marketer
 * watching two price reveals land in a row has no way to tell a coin from a
 * bug. Rotation is answerable: the next one is the one that has not run.
 */
export function chooseVariation(input: {
  pools: VariationPools;
  recent: readonly RecentChoice[];
  occasion: Occasion | null;
}): Variation {
  const recent = input.recent.slice(0, RECENT_DEPTH);

  // A template that leads on a number needs an approved one to lead on.
  const allowed = TEMPLATES.filter((t) => !t.needsPrice || input.pools.hasPrice);
  const usable = allowed.length ? allowed : TEMPLATES;
  const template = leastRecent(
    usable.map((t) => t.key),
    recent.map((r) => r.template),
  ) as TemplateKey;

  const leadPoint = input.pools.talkingPoints.length
    ? leastRecent(
        input.pools.talkingPoints,
        recent.map((r) => r.leadPoint).filter((p): p is string => p !== null),
      )
    : null;

  const assetId = input.pools.assetIds.length
    ? leastRecent(
        input.pools.assetIds,
        recent.map((r) => r.assetId).filter((a): a is string => a !== null),
      )
    : null;

  return { template, leadPoint, assetId, occasionId: input.occasion?.id ?? null };
}

/**
 * The first option nobody has used lately, or the one used longest ago.
 *
 * `used` is newest first, so a higher index is older. An option absent from
 * it has never been used and wins outright.
 */
export function leastRecent<T>(options: readonly T[], used: readonly T[]): T {
  let best = options[0];
  let bestRank = -1;
  for (const option of options) {
    const i = used.indexOf(option);
    const rank = i === -1 ? Number.POSITIVE_INFINITY : i;
    if (rank > bestRank) {
      best = option;
      bestRank = rank;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// What a creative was built from
// ---------------------------------------------------------------------------

/**
 * Every approved input this creative traces back to.
 *
 * Section 08's rule is that every pixel of the building traces to a file a
 * named human approved. Its three approval mechanisms each pin a hash:
 * `brain_signatures`, `asset_approvals`, `unit_type_approvals`. What none of
 * them answered was the composite, which is the thing that actually reaches a
 * buyer, so the claim had a gap at its last step.
 *
 * This closes it. The creative records which approved versions it used, so
 * "this advertisement carries no material nobody approved" is a claim the row
 * itself answers rather than one the architecture merely implies.
 */
export type CreativeInputs = {
  /** Published Brain versions, deepest first, as `resolveBrain()` returns. */
  brain: { versionId: string; version: number; path: string }[];
  /** Approved configuration versions, by their approved hash. */
  units: { unitTypeId: string; sha256: string }[];
  /** The approved bytes of the asset this was built from. */
  asset: { assetId: string; sha256: string } | null;
  /**
   * The brand marks in force, by their address.
   *
   * `brand_files` holds no hash column: one mark per role per node is an
   * upsert, so the row id survives a replacement and the UPLOAD TIME is what
   * changes when the bytes do. That is already how the product addresses a
   * mark, because a replaced logo served from a five minute cache looked for
   * five minutes like an upload that never happened. So the stamp is the
   * address rather than a digest, and it moves for exactly the same reason a
   * digest would.
   */
  brand: { role: string; fileId: string; at: string }[];
  /**
   * A creative in Hindi or another script of its own: the place and points
   * it prints in that script, and how it read back in English. In the hash,
   * because the Hindi lines are on the picture a person approves.
   */
  local?: LocalLines | null;
  /**
   * What the card was written for, when it is not a general card: a
   * festival greeting is gated as a greeting when it is read again and when
   * it is published, or "leads on nothing" refuses every one.
   */
  angle?: CardAngle;
};

export function emptyInputs(): CreativeInputs {
  return { brain: [], units: [], asset: null, brand: [] };
}

/**
 * The hash a person's approval pins.
 *
 * It covers the sentences AND the inputs, so an approval can never carry over
 * onto a creative built from a different render or a superseded price. The
 * same reason `unit_type_approvals` hashes the configuration alongside the
 * numbers.
 */
export function creativeHash(input: {
  headline: string;
  body: string;
  cta: string;
  language: string;
  segment: string;
  inputs: CreativeInputs;
}): string {
  const canonical = [
    `language=${input.language}`,
    `segment=${input.segment}`,
    `headline=${input.headline.trim()}`,
    `body=${input.body.trim()}`,
    `cta=${input.cta.trim()}`,
    `brain=${input.inputs.brain.map((b) => b.versionId).sort().join(",")}`,
    `units=${input.inputs.units.map((u) => `${u.unitTypeId}:${u.sha256}`).sort().join(",")}`,
    `asset=${input.inputs.asset ? `${input.inputs.asset.assetId}:${input.inputs.asset.sha256}` : ""}`,
    `brand=${input.inputs.brand.map((b) => `${b.role}:${b.fileId}:${b.at}`).sort().join(",")}`,
    // A Hindi creative's own lines; absent on any other, so their hashes stand.
    ...(input.inputs.local
      ? [
          `place=${input.inputs.local.place ?? ""}`,
          `points=${input.inputs.local.points.map((p) => p.text.trim()).join("|")}`,
        ]
      : []),
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Whether a decision still applies to what is on the screen.
 *
 * The same rule a Brain signature follows: change what was approved and the
 * approval stops matching; put it back and it applies again, because that
 * person really did approve exactly this.
 */
export function decisionStands(creative: {
  contentSha256: string;
  decidedSha256: string | null;
}): boolean {
  return (
    creative.decidedSha256 !== null && creative.decidedSha256 === creative.contentSha256
  );
}

// ---------------------------------------------------------------------------
// What a run may refuse on
// ---------------------------------------------------------------------------

export type RefusalCode =
  | "SCHEDULE_STOPPED"
  | "NOT_READY"
  | "NOT_ADVERTISABLE"
  | "NO_BRIEF"
  | "NO_LANGUAGES"
  | "DAILY_CAP"
  | "NOTHING_WRITTEN"
  | "NO_LOCATION"
  | "NO_POINTS"
  | "NO_AGENT_RERA";

/**
 * A refusal in the product's own words, for a screen and for an email.
 *
 * A scheduled post that quietly does not happen is worse than a bad one,
 * because the campaign stops and nobody learns why for a month. So every
 * refusal has a sentence a marketing head can act on, and none of them says
 * "error".
 */
export const REFUSALS: Record<RefusalCode, string> = {
  SCHEDULE_STOPPED: "The schedule was stopped before this was due.",
  NOT_READY: "Something this post needs is still missing on the tower.",
  NOT_ADVERTISABLE: "This phase can't be advertised yet.",
  NO_BRIEF: "The brief behind this schedule is gone.",
  NO_LANGUAGES: "The brief names no languages to write in.",
  DAILY_CAP: "This schedule has already run as often as it is allowed to today.",
  NOTHING_WRITTEN: "The copy model returned nothing usable.",
  NO_LOCATION: "The project's exact location is not signed yet, and every ad names it.",
  NO_POINTS: "Add at least one approved selling point to this project's facts first.",
  NO_AGENT_RERA: "Your MahaRERA agent registration is not current, and every ad of yours carries it.",
};

export function refusalMessage(code: string | null): string | null {
  if (!code) return null;
  return REFUSALS[code as RefusalCode] ?? null;
}

// ---------------------------------------------------------------------------
// Reading a run back
// ---------------------------------------------------------------------------

export type RunState =
  | "PENDING"
  | "RUNNING"
  | "GENERATED"
  | "RELEASED"
  | "REFUSED"
  | "EXPIRED"
  | "FAILED";

/** What the row says on screen. State, never a reason and never a rule. */
export function runLabel(run: {
  state: RunState;
  written: number;
  passed: number;
  held: number;
  failed: number;
}): string {
  switch (run.state) {
    case "PENDING":
      return "Waiting to write";
    case "RUNNING":
      return "Writing";
    case "GENERATED":
      return `${run.written} written, ${run.passed} cleared`;
    case "RELEASED":
      return "Released";
    case "REFUSED":
      return "Refused";
    case "EXPIRED":
      return "Expired unreviewed";
    case "FAILED":
      return "Did not finish";
  }
}

export function runTone(state: RunState): "ok" | "warn" | "risk" | "quiet" {
  if (state === "RELEASED") return "ok";
  if (state === "FAILED" || state === "EXPIRED") return "risk";
  if (state === "REFUSED" || state === "GENERATED") return "warn";
  return "quiet";
}

/**
 * How many creatives are waiting on a person.
 *
 * The review queue's own count, and the number the rail would badge. A
 * creative that FAILED is not waiting on anybody: it is shown so the reason
 * can be fixed, and fixing it means changing the Brain rather than pressing
 * approve.
 */
export function awaitingReview(
  creatives: readonly { state: string; verdict: Verdict }[],
): number {
  return creatives.filter((c) => c.state === "DRAFT" && c.verdict !== "FAIL").length;
}
