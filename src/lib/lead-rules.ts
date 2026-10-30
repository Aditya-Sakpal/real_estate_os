/**
 * The lead pipeline: its stages, what each stage needs to be true, and what
 * moving a lead from any stage to any other asks for.
 *
 * The rule the whole module rests on is that a stage is a set of FACTS, not a
 * label. A lead in Visit scheduled has a date, a time and a host; a lead in
 * Booked has a unit, an agreement value and a token. So a move is answered by
 * comparing facts, never by listing pairs of stages:
 *
 * 1. **Forward asks for what is missing, every stage in between included.**
 *    New to Booked is a real thing that happens (a walk-in who books on the
 *    day), and the booking still needs the visit, the quote and the agreement
 *    behind it. Skipping a stage skips the column, never the record.
 * 2. **A fact that no longer fits is asked again.** A visit dated next Saturday
 *    is fine while the lead is Visit scheduled and wrong once it is Visit done,
 *    so the date comes back to be confirmed. The same rule makes a second
 *    visit work: moving back to Visit scheduled with last week's date asks for
 *    a new one.
 * 3. **Back clears what came after, and says so first.** A lead back in
 *    Qualified has no visit; keeping the old one would let it jump forward
 *    again on a visit that was cancelled. Every backward move takes a reason,
 *    because undoing a visit or a quote is a thing somebody will ask about.
 * 4. **Leaving Booked is cancelling a booking,** wherever the lead goes. It
 *    takes a cancellation reason and the booking facts are cleared, so a
 *    reopened lead cannot carry an agreement that was withdrawn.
 * 5. **Nurture and Lost are off the path, not after it.** A lead keeps its
 *    facts when it leaves (the visit really did happen) and remembers the
 *    stage it left from, so reopening it asks only for what has changed.
 *
 * Pure, so `check:logic` walks every one of the 81 moves.
 */

import { ANY_VISIT_SLOTS } from "./visit-hours-rules.ts";

export type PathStage =
  | "new"
  | "contacted"
  | "qualified"
  | "visit_scheduled"
  | "visit_done"
  | "negotiation"
  | "booked";

export type SideStage = "nurture" | "lost";

export type StageKey = PathStage | SideStage;

export const PATH: PathStage[] = [
  "new",
  "contacted",
  "qualified",
  "visit_scheduled",
  "visit_done",
  "negotiation",
  "booked",
];

export const SIDE: SideStage[] = ["nurture", "lost"];

export type Stage = {
  key: StageKey;
  label: string;
  /** Off the main path: a drip, or out. Drawn apart from the seven. */
  side?: boolean;
  /** Sum the lead values in the column header. Only where a number exists. */
  sumsValue?: boolean;
};

export const STAGES: Stage[] = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "visit_scheduled", label: "Visit scheduled" },
  { key: "visit_done", label: "Visit done" },
  { key: "negotiation", label: "Negotiation", sumsValue: true },
  { key: "booked", label: "Booked", sumsValue: true },
  { key: "nurture", label: "Nurture", side: true },
  { key: "lost", label: "Lost", side: true },
];

export const stageLabel = (s: StageKey) => STAGES.find((x) => x.key === s)!.label;

/** Position on the path, or -1 for a side lane. */
export const pathIndex = (s: StageKey) => PATH.indexOf(s as PathStage);

export const isPath = (s: StageKey): s is PathStage => pathIndex(s) >= 0;

// --- facts ------------------------------------------------------------------

export type FieldKey =
  | "contactChannel"
  | "contactedOn"
  | "config"
  | "budget"
  | "timeline"
  | "owner"
  | "visitDate"
  | "visitTime"
  | "visitHost"
  | "interest"
  | "objection"
  | "unit"
  | "quote"
  | "bookedOn"
  | "agreement"
  | "token";

export type FieldKind = "select" | "chips" | "date" | "time" | "money" | "text";

export type Field = {
  key: FieldKey;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
  placeholder?: string;
  /** Takes the whole row rather than half of it. */
  wide?: boolean;
};

/** Every value is a string: a date as YYYY-MM-DD, money as whole rupees. */
export type Facts = Partial<Record<FieldKey, string>>;

export const CHANNELS = ["WhatsApp", "Phone call", "AI voice call", "Walk-in", "Email"] as const;
export const CONFIGS = ["1 BHK", "2 BHK", "2.5 BHK", "3 BHK", "4 BHK", "Villa", "Plot"] as const;
export const BUDGETS = [
  "Under Rs 60 lakh",
  "Rs 60 to 90 lakh",
  "Rs 90 lakh to 1.5 Cr",
  "Above Rs 1.5 Cr",
] as const;
export const TIMELINES = [
  "Within 30 days",
  "1 to 3 months",
  "3 to 6 months",
  "6 months or more",
  "Just exploring",
] as const;
export const INTEREST = ["Hot", "Warm", "Cold"] as const;
export const OBJECTIONS = [
  "None",
  "Price",
  "Loan",
  "Location",
  "Family",
  "Possession date",
  "Carpet area",
  "Layout",
  "Other",
] as const;

/** Half-hour slots across a site's working day. */
export const VISIT_SLOTS: string[] = Array.from({ length: 18 }, (_, i) => {
  const m = 10 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
});

export const FIELDS: Record<FieldKey, Field> = {
  contactChannel: { key: "contactChannel", label: "Reached by", kind: "select", options: CHANNELS },
  contactedOn: { key: "contactedOn", label: "Date", kind: "date" },
  config: { key: "config", label: "Configuration", kind: "select", options: CONFIGS },
  budget: { key: "budget", label: "Budget", kind: "select", options: BUDGETS },
  timeline: { key: "timeline", label: "Buying within", kind: "select", options: TIMELINES },
  owner: { key: "owner", label: "Assign to", kind: "select" },
  visitDate: { key: "visitDate", label: "Visit date", kind: "date" },
  visitTime: { key: "visitTime", label: "Time", kind: "time" },
  visitHost: { key: "visitHost", label: "Hosted by", kind: "select" },
  interest: { key: "interest", label: "How interested", kind: "chips", options: INTEREST, wide: true },
  objection: { key: "objection", label: "Main objection", kind: "chips", options: OBJECTIONS, wide: true },
  unit: { key: "unit", label: "Unit", kind: "text", placeholder: "C-1203" },
  quote: { key: "quote", label: "Quoted price", kind: "money" },
  bookedOn: { key: "bookedOn", label: "Booking date", kind: "date" },
  agreement: { key: "agreement", label: "Agreement value", kind: "money" },
  token: { key: "token", label: "Token received", kind: "money" },
};

/** What a lead has to carry to be in a stage, beyond what the stages before it need. */
export const STAGE_FIELDS: Record<PathStage, FieldKey[]> = {
  new: [],
  contacted: ["contactChannel", "contactedOn"],
  qualified: ["config", "budget", "timeline", "owner"],
  visit_scheduled: ["visitDate", "visitTime", "visitHost"],
  visit_done: ["interest", "objection"],
  negotiation: ["unit", "quote"],
  booked: ["bookedOn", "agreement", "token"],
};

/** The heading a stage's fields sit under in the move dialog. */
export const SECTION_TITLE: Record<PathStage, string> = {
  new: "New",
  contacted: "First contact",
  qualified: "Qualification",
  visit_scheduled: "Site visit",
  visit_done: "After the visit",
  negotiation: "Negotiation",
  booked: "Booking",
};

/** Everything a lead needs to stand in `stage`, every earlier stage included. */
export function requiredFor(stage: PathStage): FieldKey[] {
  return PATH.slice(0, pathIndex(stage) + 1).flatMap((s) => STAGE_FIELDS[s]);
}

const has = (facts: Facts, k: FieldKey) => Boolean(facts[k]?.trim());

/** Whole rupees from whatever was typed: "76,30,000", "Rs 7630000". */
export const digits = (v: string | undefined) => (v ?? "").replace(/[^\d]/g, "");

const MIN_PRICE = 1_00_000;

/**
 * Why a value will not do for a lead headed to `to`, or null.
 *
 * `facts` is the whole record as it would stand after the move, so a check
 * that compares two fields (a booking after the visit, a token inside the
 * agreement) reads the value being typed beside it rather than the old one.
 */
export function fieldError(
  key: FieldKey,
  facts: Facts,
  to: PathStage,
  today: string,
  people: readonly string[],
  /** The IST time now, "HH:MM". With it, a visit today must be later than now. */
  nowTime?: string,
): string | null {
  const field = FIELDS[key];
  const value = (facts[key] ?? "").trim();

  if (!value) {
    if (field.kind === "date") return "Pick a date";
    if (field.kind === "money") return "Enter an amount";
    if (field.kind === "text") return "Enter the unit";
    return "Choose one";
  }

  const options = key === "owner" || key === "visitHost" ? people : field.options;
  if (options && !options.includes(value)) return "Choose one";
  // Any half hour a project may open for; the project's own hours are asked
  // where the project is known (`moveLead()`, `bookVisit()`).
  if (field.kind === "time" && !ANY_VISIT_SLOTS.includes(value)) return "Choose a time";
  if (field.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Pick a date";

  switch (key) {
    case "contactedOn":
      return value > today ? "Can't be in the future" : null;

    case "visitDate":
      // Upcoming while the lead waits for it, in the past once it happened.
      if (to === "visit_scheduled") return value < today ? "Pick today or a later date" : null;
      return value > today ? "A visit that happened can't be in the future" : null;

    case "visitTime":
      // A visit booked for a time already gone is booked for nobody: the
      // engine books only what is still ahead, so the lead would read
      // "Visit scheduled" with no visit behind it.
      if (to === "visit_scheduled" && nowTime && facts.visitDate === today && value <= nowTime) {
        return "Pick a later time today";
      }
      return null;

    case "bookedOn":
      if (value > today) return "Can't be in the future";
      if (facts.visitDate && value < facts.visitDate) return "Can't be before the site visit";
      return null;

    case "quote":
    case "agreement":
      return Number(digits(value)) < MIN_PRICE ? "Enter the full amount in rupees" : null;

    case "token": {
      const token = Number(digits(value));
      const agreement = Number(digits(facts.agreement));
      if (token <= 0) return "Enter an amount";
      // Section 13: no more than ten per cent before a registered agreement.
      if (agreement && token * 10 > agreement) {
        return `More than 10% (${rupees(Math.floor(agreement / 10))}) needs a registered agreement for sale`;
      }
      return null;
    }

    default:
      return null;
  }
}

// --- reasons ------------------------------------------------------------------

export const LOST_REASONS = [
  "Budget mismatch",
  "Bought elsewhere",
  "Location did not suit",
  "Not reachable",
  "No activity",
  "Not interested",
  "Asked not to be contacted",
  "Wrong number",
  "Duplicate or junk",
  "Other",
] as const;

export const NURTURE_REASONS = [
  "Buying in 6 months or more",
  "Not ready to buy yet",
  "Could not reach",
  "No-show",
  "Stopped responding",
  "Waiting on a loan",
  "Waiting on a sale",
  "Other",
] as const;

export const CANCEL_REASONS = [
  "Loan not approved",
  "Buyer changed their mind",
  "Family decision",
  "Found a better deal",
  "Entered by mistake",
  "Other",
] as const;

/** Why a stage is being undone, keyed by the stage the lead is leaving. */
export const UNDO_REASONS: Record<Exclude<PathStage, "new" | "booked">, readonly string[]> = {
  contacted: ["Entered by mistake", "Could not actually reach them", "Other"],
  qualified: ["Entered by mistake", "Details were wrong", "Needs qualifying again", "Other"],
  visit_scheduled: ["Buyer cancelled the visit", "Will reschedule later", "Entered by mistake", "Other"],
  visit_done: ["Visit did not happen", "Needs another visit", "Entered by mistake", "Other"],
  negotiation: ["Buyer paused", "Unit no longer available", "Needs another visit", "Entered by mistake", "Other"],
};

// --- the move -----------------------------------------------------------------

/** What the board holds for a lead that moves care about. */
export type LeadState = {
  stage: StageKey;
  /** Where it stands on the path. For a side lane, where it left from. */
  pathStage: PathStage;
  facts: Facts;
  exit?: { kind: SideStage; reason: string; followUp?: string };
};

export type MoveKind = "none" | "forward" | "back" | "exit" | "switch" | "reopen";

export type MovePlan = {
  from: StageKey;
  to: StageKey;
  kind: MoveKind;
  /** The fields to ask for, grouped by the stage they belong to, in path order. */
  sections: { stage: PathStage; title: string; fields: FieldKey[] }[];
  /** Stages whose recorded facts the move removes. */
  clears: PathStage[];
  /** The booking is withdrawn. Always true leaving Booked for anywhere else. */
  cancelsBooking: boolean;
  reason: { label: string; options: readonly string[] } | null;
  /** Nurture needs a date to come back on. */
  followUp: boolean;
  /** Stages passed over on the way forward, for the dialog's one line of state. */
  skipped: number;
  needsDialog: boolean;
};

export function planMove(
  lead: LeadState,
  to: StageKey,
  today: string,
  people: readonly string[],
  nowTime?: string,
): MovePlan {
  const from = lead.stage;
  const base: MovePlan = {
    from,
    to,
    kind: "none",
    sections: [],
    clears: [],
    cancelsBooking: false,
    reason: null,
    followUp: false,
    skipped: 0,
    needsDialog: false,
  };
  if (from === to) return base;

  const cancelsBooking = from === "booked";
  const cancel = { label: "Why was the booking cancelled?", options: CANCEL_REASONS };

  // Off the path: keep the record, ask why.
  if (!isPath(to)) {
    const plan: MovePlan = {
      ...base,
      kind: isPath(from) ? "exit" : "switch",
      cancelsBooking,
      clears: cancelsBooking ? ["booked"] : [],
      reason: cancelsBooking
        ? cancel
        : to === "lost"
          ? { label: "Why was it lost?", options: LOST_REASONS }
          : { label: "Why nurture it?", options: NURTURE_REASONS },
      followUp: to === "nurture",
    };
    return { ...plan, needsDialog: true };
  }

  const target = pathIndex(to);
  const asked = requiredFor(to).filter(
    (k) => fieldError(k, lead.facts, to, today, people, nowTime) !== null,
  );

  const sections = PATH.filter((s) => pathIndex(s) <= target)
    .map((s) => ({
      stage: s,
      title: SECTION_TITLE[s],
      fields: STAGE_FIELDS[s].filter((k) => asked.includes(k)),
    }))
    .filter((s) => s.fields.length > 0);

  const clears = PATH.filter(
    (s) => pathIndex(s) > target && STAGE_FIELDS[s].some((k) => has(lead.facts, k)),
  );

  const kind: MoveKind = !isPath(from)
    ? "reopen"
    : target > pathIndex(from)
      ? "forward"
      : "back";

  let reason: MovePlan["reason"] = null;
  if (kind === "back") {
    reason = cancelsBooking
      ? cancel
      : { label: "Why is it moving back?", options: UNDO_REASONS[from as keyof typeof UNDO_REASONS] };
  }

  const plan: MovePlan = {
    ...base,
    kind,
    sections,
    clears,
    cancelsBooking,
    reason,
    skipped: kind === "forward" ? Math.max(0, target - pathIndex(from) - 1) : 0,
  };
  return {
    ...plan,
    needsDialog: sections.length > 0 || clears.length > 0 || reason !== null,
  };
}

/** The answers the dialog collects beside the facts. */
export type MoveInput = {
  facts: Facts;
  reason?: string;
  followUp?: string;
  note?: string;
  /** The stage the person saw when they moved it. A lead that has moved since is refused, not overwritten. */
  seen?: StageKey;
};

/** Field key, or "reason" / "followUp", to the message that stops the move. */
export function validateMove(
  plan: MovePlan,
  lead: LeadState,
  input: MoveInput,
  today: string,
  people: readonly string[],
  nowTime?: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (isPath(plan.to)) {
    const merged = { ...lead.facts, ...input.facts };
    for (const section of plan.sections) {
      for (const k of section.fields) {
        const e = fieldError(k, merged, plan.to, today, people, nowTime);
        if (e) errors[k] = e;
      }
    }
    // Only a new date was asked for and the recorded time is kept: today, that
    // time may already have gone. The error sits on the field on screen.
    const asked = plan.sections.flatMap((s) => s.fields);
    if (asked.includes("visitDate") && !asked.includes("visitTime") && !errors.visitDate) {
      if (fieldError("visitTime", merged, plan.to, today, people, nowTime)) {
        errors.visitDate = "That time has passed today. Pick a later day";
      }
    }
  }
  if (plan.reason && !plan.reason.options.includes(input.reason ?? "")) {
    errors.reason = "Choose a reason";
  }
  if (plan.followUp) {
    const d = input.followUp ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.followUp = "Pick a date";
    else if (d <= today) errors.followUp = "Pick a date after today";
  }
  return errors;
}

/** The lead after the move. Call only once `validateMove` has returned nothing. */
export function applyMove<T extends LeadState>(lead: T, plan: MovePlan, input: MoveInput): T {
  const to = plan.to;
  const facts: Facts = { ...lead.facts };
  const asked = plan.sections.flatMap((s) => s.fields);
  for (const k of asked) {
    const v = input.facts[k];
    if (v !== undefined) facts[k] = FIELDS[k].kind === "money" ? digits(v) : v.trim();
  }
  for (const s of plan.clears) for (const k of STAGE_FIELDS[s]) delete facts[k];

  if (isPath(to)) {
    return { ...lead, stage: to, pathStage: to, facts, exit: undefined };
  }

  const pathStage: PathStage = plan.cancelsBooking ? "negotiation" : lead.pathStage;
  return {
    ...lead,
    stage: to,
    pathStage,
    facts,
    exit: {
      kind: to,
      reason: input.reason ?? "",
      followUp: plan.followUp ? input.followUp : undefined,
    },
  };
}

/** Every fact a lead should hold at its path stage, and nothing past it. */
export function factsFit(lead: LeadState): { missing: FieldKey[]; extra: FieldKey[] } {
  const need = requiredFor(lead.pathStage);
  const missing = need.filter((k) => !has(lead.facts, k));
  const extra = (Object.keys(lead.facts) as FieldKey[]).filter(
    (k) => has(lead.facts, k) && !need.includes(k),
  );
  return { missing, extra };
}

// --- reading it back ----------------------------------------------------------

/** `Rs 76,30,000`: Indian grouping, three digits then twos. */
export function rupees(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-IN")}`;
}

/** `Rs 1.25 Cr`, `Rs 76.3 lakh`. For totals, where the last rupee is noise. */
export function rupeesShort(n: number): string {
  const trim = (x: number) => x.toFixed(2).replace(/\.?0+$/, "");
  if (n >= 1_00_00_000) return `Rs ${trim(n / 1_00_00_000)} Cr`;
  if (n >= 1_00_000) return `Rs ${trim(n / 1_00_000)} lakh`;
  return rupees(n);
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Sat 26 Sep`. Read as a civil date: no clock, no timezone. */
export function showDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAY[dow]} ${d} ${MON[m - 1]}`;
}

/** `11:30 am`. */
export function showTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** A civil date `n` days from `iso`, negative for the past. */
/** The date and the minute in India, from one clock, so the two never disagree. */
export function istClock(at: Date | number = Date.now()): { date: string; time: string } {
  const ist = new Date(new Date(at).getTime() + 330 * 60_000).toISOString();
  return { date: ist.slice(0, 10), time: ist.slice(11, 16) };
}

/**
 * The time to hold a visit against, for a check made on `today`. Only when
 * `today` really is today in India: a check run on a pinned day has no "now"
 * inside that day, and borrowing the real clock's would refuse the wrong slots.
 */
export function nowTimeOn(today: string, at: Date | number = Date.now()): string | undefined {
  const c = istClock(at);
  return c.date === today ? c.time : undefined;
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** One line naming what a stage's facts say, for the "this removes" note. */
export function describeStage(stage: PathStage, f: Facts): string {
  switch (stage) {
    case "contacted":
      return f.contactChannel ? `the first contact on ${f.contactChannel}` : "the first contact";
    case "qualified":
      return f.owner ? `the qualification and ${f.owner} as owner` : "the qualification";
    case "visit_scheduled":
      return f.visitDate
        ? `the site visit on ${showDate(f.visitDate)}${f.visitTime ? `, ${showTime(f.visitTime)}` : ""}`
        : "the site visit";
    case "visit_done":
      return "the visit feedback";
    case "negotiation":
      return f.quote
        ? `the quote of ${rupees(Number(f.quote))}${f.unit ? ` on ${f.unit}` : ""}`
        : "the quote";
    case "booked":
      return f.agreement ? `the booking of ${rupees(Number(f.agreement))}` : "the booking";
    default:
      return stage;
  }
}

/** The money a card shows: the quote while negotiating, the agreement once booked. */
export function valueOf(lead: LeadState): { label: string; amount: number } | null {
  if (lead.stage === "booked" && lead.facts.agreement) {
    return { label: "Agreement", amount: Number(lead.facts.agreement) };
  }
  if (lead.stage === "negotiation" && lead.facts.quote) {
    return { label: "Quote", amount: Number(lead.facts.quote) };
  }
  return null;
}

/** The card's next-step line, read from the facts, for a lead a person has moved. */
export function nextFor(lead: LeadState, today: string): string {
  const f = lead.facts;
  switch (lead.stage) {
    case "new":
      return "Waiting for the first reply";
    case "contacted":
      return f.contactChannel ? `Reached on ${f.contactChannel}, qualifying` : "Qualifying";
    case "qualified":
      return "Offer a visit slot";
    case "visit_scheduled":
      return f.visitDate
        ? `Visit ${f.visitDate === today ? "today" : showDate(f.visitDate)}${f.visitTime ? `, ${showTime(f.visitTime)}` : ""}`
        : "Visit to be fixed";
    case "visit_done":
      return f.objection && f.objection !== "None"
        ? `Objection: ${f.objection.toLowerCase()}`
        : "Visited, no objection";
    case "negotiation":
      return f.unit ? `Negotiating on ${f.unit}` : "Negotiating";
    case "booked":
      if (!f.token) return "Booked";
      return `Booked ${f.bookedOn === today ? "today" : f.bookedOn ? showDate(f.bookedOn) : ""}, token ${rupees(Number(f.token))}`;
    case "nurture":
      return lead.exit?.followUp ? `Follow up ${showDate(lead.exit.followUp)}` : "In the monthly drip";
    case "lost":
      return `Left at ${stageLabel(lead.pathStage)}`;
  }
}
