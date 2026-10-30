/**
 * Channel partners: the commission ladder, the invoice arithmetic, the
 * payout milestones, the registration clock and the registration verdict.
 *
 * Pure, so the screen, the server and `check:logic` read the same answers.
 * `partners.ts` reads and writes the tables (0037) around it.
 *
 * The money follows how the trade pays brokerage. Commission is a share of
 * the agreement value, and the share steps up with how many bookings a firm
 * has brought to that one project: 2 per cent on the first, more on the
 * next, more again from the third. A step reached pays from the next
 * booking on and never re-rates the ones before it. A firm may give part
 * of its share back to the buyer as a discount (the pass-back), and that
 * part is not paid to it. GST is charged on top when the firm is registered
 * for it, and TDS is withheld from the amount before GST, so the firm
 * receives the invoice total less the TDS. Payment comes in two halves: the
 * first once the agreement for sale is registered, the second once 30 per
 * cent of the price is collected, which is the ladder section 07 shows a
 * partner.
 *
 * A registration is a partner's claim on a buyer at one project. Every
 * attempt gets a verdict and every verdict is logged. The order the verdict
 * is decided in is the rule: the day's allowance first, so the verdict can
 * never be used to probe which numbers somebody else holds; then whether
 * the firm may register here at all; then whether anybody got there first.
 */

import { addDays } from "./lead-rules.ts";
import { maskPhone } from "./mask-rules.ts";

export const GST_RATE = 0.18;
/** Withheld on brokerage, on the amount before GST. Two per cent since October 2024. */
export const TDS_RATE = 0.02;

export const pct = (rate: number) => `${+(rate * 100).toFixed(2)}%`;

const DAY_MS = 86_400_000;

/** The IST calendar day of an instant, `YYYY-MM-DD`. */
export function istDay(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

// ---------------------------------------------------------------------------
// The commission ladder
// ---------------------------------------------------------------------------

/** From a firm's `from`th booking on this project, it earns `rate`. */
export type Step = { from: number; rate: number };

/** What the trade pays when a project names nothing else. */
export const DEFAULT_STEPS: Step[] = [
  { from: 1, rate: 0.02 },
  { from: 2, rate: 0.0225 },
  { from: 3, rate: 0.03 },
];

export const MIN_RATE = 0.005;
export const MAX_RATE = 0.05;
export const MAX_STEPS = 6;
export const PASS_BACK_DEFAULT = 0.01;
export const PASS_BACK_CEILING = 0.02;

/** A ladder is well formed or it is not stored. Null when it is fine. */
export function stepsProblem(steps: Step[]): string | null {
  if (steps.length === 0) return "Add at least one step.";
  if (steps.length > MAX_STEPS) return `At most ${MAX_STEPS} steps.`;
  if (steps[0].from !== 1) return "The first step starts at the first booking.";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!Number.isInteger(s.from) || s.from < 1 || s.from > 100) return "A step starts at a booking between 1 and 100.";
    if (!(s.rate >= MIN_RATE && s.rate <= MAX_RATE)) return `A rate is between ${pct(MIN_RATE)} and ${pct(MAX_RATE)}.`;
    if (i > 0 && s.from <= steps[i - 1].from) return "Each step starts after the one before it.";
    if (i > 0 && s.rate < steps[i - 1].rate) return "A later step never pays less than the one before it.";
  }
  return null;
}

/** Read a stored or posted ladder. Anything that is not a ladder is null. */
export function parseSteps(raw: unknown): Step[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Step[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") return null;
    const from = Number((x as Record<string, unknown>).from);
    const rate = Number((x as Record<string, unknown>).rate);
    if (!Number.isFinite(from) || !Number.isFinite(rate)) return null;
    out.push({ from, rate: Math.round(rate * 100_000) / 100_000 });
  }
  return stepsProblem(out) ? null : out;
}

/** What the `bookingNo`th booking earns. */
export function rateFor(steps: Step[], bookingNo: number): number {
  let rate = steps[0].rate;
  for (const s of steps) if (s.from <= bookingNo) rate = s.rate;
  return rate;
}

/**
 * After `booked` bookings, how many more lift the rate, and to what. Null at
 * the top of the ladder.
 */
export function nextStep(steps: Step[], booked: number): { more: number; rate: number } | null {
  const now = rateFor(steps, booked + 1);
  const up = steps.find((s) => s.from > booked + 1 && s.rate > now);
  return up ? { more: up.from - (booked + 1), rate: up.rate } : null;
}

/** One line for a ladder: `2% · 2.25% from the 2nd · 3% from the 3rd`. */
export function describeSteps(steps: Step[]): string {
  return steps.map((s, i) => (i === 0 ? pct(s.rate) : `${pct(s.rate)} from the ${ordinal(s.from)}`)).join(" · ");
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

// ---------------------------------------------------------------------------
// A project's terms
// ---------------------------------------------------------------------------

/** A registration runs this long unless the project sets its own. */
export const REGISTRATION_DAYS = 30;
export const REGISTRATION_MIN = 15;
export const REGISTRATION_MAX = 90;
/** A site visit carries a live registration at least this far past the visit. */
export const VISIT_EXTENDS = 30;

export type Terms = {
  steps: Step[];
  passBackMax: number;
  registrationDays: number;
  visitExtendsDays: number;
  /** Which bookings count toward the ladder: all of them, this quarter's or this financial year's. ALL when unset. */
  ladderPeriod?: LadderPeriod;
  /** When the second half falls due: on the share of the price collected, or on that or the bank's first payment. COLLECTED when unset. */
  secondHalf?: "COLLECTED" | "COLLECTED_OR_BANK";
};

export const DEFAULT_TERMS: Terms = {
  steps: DEFAULT_STEPS,
  passBackMax: PASS_BACK_DEFAULT,
  registrationDays: REGISTRATION_DAYS,
  visitExtendsDays: VISIT_EXTENDS,
  ladderPeriod: "ALL",
};

// ---------------------------------------------------------------------------
// The ladder's period
// ---------------------------------------------------------------------------

/**
 * Which of a firm's bookings on a project count toward its place on the
 * ladder. ALL is every live booking ever (the trade's default); QUARTER and
 * YEAR count only bookings in the current Indian financial quarter or year
 * (April to March), by the IST day the booking was made.
 */
export type LadderPeriod = "ALL" | "QUARTER" | "YEAR";

export const LADDER_PERIODS: LadderPeriod[] = ["ALL", "QUARTER", "YEAR"];

export const LADDER_PERIOD_LABEL: Record<LadderPeriod, string> = {
  ALL: "Every booking, ever",
  QUARTER: "This quarter's bookings",
  YEAR: "This financial year's bookings",
};

export const isLadderPeriod = (v: unknown): v is LadderPeriod => typeof v === "string" && (LADDER_PERIODS as string[]).includes(v);

/** The first day of the month `months` after `y-m-01`, as `YYYY-MM-DD`. */
function monthStart(y: number, m: number, months = 0): string {
  const i = y * 12 + (m - 1) + months;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`;
}

/**
 * The IST days a period covers around `today`: `from` inclusive, `to`
 * exclusive. Null for ALL, which has no window.
 */
export function ladderWindow(period: LadderPeriod | undefined, today: string): { from: string; to: string } | null {
  if (!period || period === "ALL") return null;
  const [y, m] = today.split("-").map(Number);
  if (period === "YEAR") {
    const fy = m >= 4 ? y : y - 1;
    return { from: `${fy}-04-01`, to: `${fy + 1}-04-01` };
  }
  // Financial quarters: April to June, July to September, October to December, January to March.
  const qStart = m >= 4 ? 4 + 3 * Math.floor((m - 4) / 3) : 1;
  return { from: monthStart(y, qStart), to: monthStart(y, qStart, 3) };
}

/** How many of these bookings (by their IST day) count toward the ladder today. */
export function bookingsCounted(bookedOn: string[], period: LadderPeriod | undefined, today: string): number {
  const w = ladderWindow(period, today);
  return w ? bookedOn.filter((d) => d >= w.from && d < w.to).length : bookedOn.length;
}

export function termsProblem(t: Terms): string | null {
  const steps = stepsProblem(t.steps);
  if (steps) return steps;
  if (!(t.passBackMax >= 0 && t.passBackMax <= PASS_BACK_CEILING)) return `Pass-back is between 0% and ${pct(PASS_BACK_CEILING)}.`;
  if (t.passBackMax >= t.steps[0].rate) return "Pass-back has to be less than the first step's rate.";
  if (!Number.isInteger(t.registrationDays) || t.registrationDays < REGISTRATION_MIN || t.registrationDays > REGISTRATION_MAX) {
    return `A registration runs ${REGISTRATION_MIN} to ${REGISTRATION_MAX} days.`;
  }
  if (!Number.isInteger(t.visitExtendsDays) || t.visitExtendsDays < 0 || t.visitExtendsDays > 90) {
    return "A visit extends a registration by 0 to 90 days.";
  }
  if (t.ladderPeriod !== undefined && !isLadderPeriod(t.ladderPeriod)) return "Choose which bookings count toward the ladder.";
  return null;
}

// ---------------------------------------------------------------------------
// The invoice and the payout
// ---------------------------------------------------------------------------

export type Invoice = { base: number; gst: number; gross: number; tds: number; net: number };

/**
 * One milestone's invoice. `gstRegistered` false means the firm charges no GST,
 * which is legal below the threshold and common for a one-person firm.
 */
export function invoiceFor(base: number, gstRegistered: boolean): Invoice {
  const b = Math.round(base);
  const gst = gstRegistered ? Math.round(b * GST_RATE) : 0;
  const tds = Math.round(b * TDS_RATE);
  return { base: b, gst, gross: b + gst, tds, net: b + gst - tds };
}

export type MilestoneKey = "M1" | "M2";

export const MILESTONES: { key: MilestoneKey; share: number; trigger: string }[] = [
  { key: "M1", share: 0.5, trigger: "Agreement registered" },
  { key: "M2", share: 0.5, trigger: "30% collected" },
];

/** Section 07's release point for the second half. */
export const RELEASE_AT = 0.3;

/** What the firm is paid on, after the pass-back. */
export function commissionOn(agreement: number, rate: number, passBack = 0): number {
  return Math.round(agreement * Math.max(0, rate - passBack));
}

export type NewPayout = {
  bookingNo: number;
  rate: number;
  passBack: number;
  commission: number;
  milestones: Record<MilestoneKey, Invoice>;
};

/**
 * The payout a booking writes. `booked` is how many live bookings this firm
 * already has on the project, so this one is `booked + 1` on the ladder.
 */
export function payoutFor(opts: {
  agreement: number;
  steps: Step[];
  booked: number;
  passBack: number;
  passBackMax: number;
  gstRegistered: boolean;
}): { ok: true; payout: NewPayout } | { ok: false; message: string } {
  if (!(opts.agreement > 0)) return { ok: false, message: "The booking has no agreement value." };
  const bookingNo = opts.booked + 1;
  const rate = rateFor(opts.steps, bookingNo);
  const passBack = Math.round(opts.passBack * 100_000) / 100_000;
  if (!(passBack >= 0) || passBack > opts.passBackMax) return { ok: false, message: `Pass-back is at most ${pct(opts.passBackMax)} here.` };
  if (passBack >= rate) return { ok: false, message: "Pass-back has to be less than the rate." };
  const commission = commissionOn(opts.agreement, rate, passBack);
  const half = (share: number) => invoiceFor(commission * share, opts.gstRegistered);
  return {
    ok: true,
    payout: {
      bookingNo,
      rate,
      passBack,
      commission,
      milestones: { M1: half(MILESTONES[0].share), M2: half(MILESTONES[1].share) },
    },
  };
}

export type PayState = "held" | "no_invoice" | "verify" | "approve" | "approved" | "paid" | "void";

export const PAY_STATE: Record<PayState, { label: string; tone: "ok" | "blue" | "warn" | "risk" | "quiet" }> = {
  held: { label: "Held", tone: "quiet" },
  no_invoice: { label: "Invoice awaited", tone: "warn" },
  verify: { label: "Verify invoice", tone: "blue" },
  approve: { label: "To approve", tone: "blue" },
  approved: { label: "Approved", tone: "ok" },
  paid: { label: "Paid", tone: "ok" },
  void: { label: "Cancelled", tone: "quiet" },
};

export type Stage = "none" | "invoice" | "verified" | "approved" | "paid";

/** The stored milestone stage, in the screen's words. */
export const STAGE_OF: Record<"NONE" | "INVOICED" | "VERIFIED" | "APPROVED" | "PAID", Stage> = {
  NONE: "none",
  INVOICED: "invoice",
  VERIFIED: "verified",
  APPROVED: "approved",
  PAID: "paid",
};

export type Booking = {
  id: string;
  /** The firm on the desk, when it is a real one. */
  firmId?: string;
  unit: string;
  buyer: string;
  place: string;
  firm: string;
  agent: string;
  gstRegistered: boolean;
  agreement: number;
  rate: number;
  /** Given back to the buyer, out of the rate. */
  passBack?: number;
  /** The firm's Nth booking on the project. */
  bookingNo?: number;
  bookedOn: string;
  /** When the agreement for sale was registered, or null while it is not. */
  registeredOn: string | null;
  /** Share of the price collected so far, 0 to 1, when known. */
  collected: number | null;
  /** When collection crossed 30 per cent, if it has. */
  crossedOn: string | null;
  cancelled: boolean;
  /** How far each half has moved once its trigger is met. */
  progress: Record<MilestoneKey, { stage: Stage; paidOn?: string; utr?: string; id?: string; invoice?: InvoiceFile | null; /** The last invoice the developer sent back, while no new one is filed. */ sentBack?: { no: string; reason: RejectReason | null } | null }>;
  /** The amounts as written when the booking was, which win over recomputing them. */
  frozen?: Record<MilestoneKey, Invoice>;
  /** Somebody at the firm has proved their number, so the firm confirms its own invoices. */
  firmOnWhatsApp?: boolean;
  /** Owed to the mandate firm under its mandate, not to a partner who brought the buyer. */
  mandate?: boolean;
  /** How its claim was found, when not by the buyer's own number on this project. */
  matchedBy?: MatchedBy;
  /** Rupees taken off a half against a cancelled booking, and which booking. */
  adjusted?: Partial<Record<MilestoneKey, { amount: number; against: string }[]>>;
  /** On a booking cancelled after a half was paid: what it takes back, and how much is still to come off. */
  clawback?: { amount: number; outstanding: number } | null;
};

/** What a half pays once a cancelled booking's money is taken off it. Never below zero. */
export function netAfterAdjustments(b: Booking, key: MilestoneKey, net: number): number {
  const off = (b.adjusted?.[key] ?? []).reduce((sum, a) => sum + a.amount, 0);
  return Math.max(0, net - off);
}

/** The firm's invoice on file for one milestone, and when the firm confirmed it. */
export type InvoiceFile = { id: string; no: string; date: string; amount: number; attestedOn?: string | null };

export type Rung = {
  key: MilestoneKey;
  trigger: string;
  state: PayState;
  invoice: Invoice;
  /** When the trigger was met: the day the developer started owing. */
  owedSince: string | null;
  /** Why it is held, in the partner's words. */
  why: string | null;
  paidOn?: string;
  utr?: string;
};

export function ladder(b: Booking): Rung[] {
  const commission = commissionOn(b.agreement, b.rate, b.passBack ?? 0);
  return MILESTONES.map((m) => {
    const inv = b.frozen?.[m.key] ?? invoiceFor(commission * m.share, b.gstRegistered);
    const owedSince = m.key === "M1" ? b.registeredOn : b.crossedOn;
    const p = b.progress[m.key];
    let state: PayState;
    let why: string | null = null;
    if (b.cancelled && p.stage !== "paid") {
      state = "void";
      why = "Booking cancelled";
    } else if (!owedSince && p.stage !== "paid") {
      state = "held";
      why =
        m.key === "M1"
          ? "Releases when the agreement is registered"
          : b.collected === null
            ? `Releases at ${Math.round(RELEASE_AT * 100)}% collected`
            : `Collection at ${Math.round(b.collected * 100)}%, releases at ${Math.round(RELEASE_AT * 100)}%`;
    } else {
      state =
        p.stage === "paid"
          ? "paid"
          : p.stage === "approved"
            ? "approved"
            : p.stage === "verified"
              ? "approve"
              : p.stage === "invoice"
                ? "verify"
                : "no_invoice";
    }
    return { key: m.key, trigger: m.trigger, state, invoice: inv, owedSince, why, paidOn: p.paidOn, utr: p.utr };
  });
}

/** Owed means the trigger is met and the money has not gone out. */
export const isOwed = (r: Rung) => r.owedSince !== null && r.state !== "paid" && r.state !== "void";

/** Past this many days owed, a payout is late. Partners are promised thirty. */
export const LATE_AFTER = 45;

export function daysOwed(r: Rung, today: string): number | null {
  return isOwed(r) && r.owedSince ? daysBetween(r.owedSince, today) : null;
}

/** The one line a row shows: what is next, or why nothing can happen yet. */
export function payNext(b: Booking, today: string): { text: string; tone: "due" | "plain" | "done" | "stop" } {
  const rungs = ladder(b);
  const open = rungs.find((r) => isOwed(r));
  if (b.cancelled) return { text: "Cancelled, nothing more is owed", tone: "done" };
  if (open) {
    const d = daysOwed(open, today) ?? 0;
    const wait = d === 0 ? "today" : `${d} ${d === 1 ? "day" : "days"}`;
    const what: Record<PayState, string> = {
      no_invoice: `${open.key} owed ${wait}, invoice awaited`,
      verify: `${open.key} invoice to verify, owed ${wait}`,
      approve: `${open.key} to approve, owed ${wait}`,
      approved: `${open.key} approved, to pay`,
      held: "",
      paid: "",
      void: "",
    };
    return { text: what[open.state], tone: d > LATE_AFTER ? "stop" : "due" };
  }
  const held = rungs.find((r) => r.state === "held");
  if (held) return { text: held.why ?? "Held", tone: "plain" };
  return { text: "Paid in full", tone: "done" };
}

/** A UTR as a bank prints it: letters and digits, 8 to 32. */
export function cleanUtr(raw: string): string | null {
  const u = raw.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9]{8,32}$/.test(u) ? u : null;
}

// ---------------------------------------------------------------------------
// Registrations: a partner's claim on a buyer
// ---------------------------------------------------------------------------

export type RegState = "live" | "lapsing" | "visited" | "booked" | "lapsed" | "refused";

export const REG_STATE: Record<RegState, { label: string; tone: "ok" | "blue" | "warn" | "risk" | "quiet" }> = {
  live: { label: "Live", tone: "blue" },
  lapsing: { label: "Lapsing", tone: "warn" },
  visited: { label: "Visited", tone: "ok" },
  booked: { label: "Booked", tone: "ok" },
  lapsed: { label: "Lapsed", tone: "quiet" },
  refused: { label: "Refused", tone: "risk" },
};

/** Under this many days left, a registration is lapsing. */
export const LAPSING_UNDER = 7;

export type Via = "Buyer tapped the partner's link" | "Partner on WhatsApp" | "Entered by the relationship manager" | "Partner, from its workspace";

export const VIA_OF: Record<"LINK" | "WHATSAPP" | "CONSOLE" | "WORKSPACE", Via> = {
  LINK: "Buyer tapped the partner's link",
  WHATSAPP: "Partner on WhatsApp",
  CONSOLE: "Entered by the relationship manager",
  WORKSPACE: "Partner, from its workspace",
};

export type RefuseReason = "firm" | "direct" | "no_grant" | "agent_rera" | "rate_limited";

export type Registration = {
  id: string;
  firmId?: string;
  buyer: string;
  phone: string;
  firm: string;
  agent: string;
  project: string;
  registeredOn: string;
  /** The day it lapses, when stored. Computed from the defaults otherwise. */
  validUntil?: string;
  via: Via;
  visitedOn: string | null;
  bookedOn: string | null;
  /** Refused, and why. `holderFirm` is for the desk only; a partner never sees it. */
  refused: null | { reason: RefuseReason; holderFirm?: string; heldUntil?: string };
  /** A refusal a person has to rule on, because the partner disputes it. */
  disputed?: boolean;
};

export function validUntil(r: Registration): string {
  if (r.validUntil) return r.validUntil;
  const base = addDays(r.registeredOn, REGISTRATION_DAYS);
  if (!r.visitedOn) return base;
  const extended = addDays(r.visitedOn, VISIT_EXTENDS);
  return extended > base ? extended : base;
}

export function regState(r: Registration, today: string): RegState {
  if (r.refused) return "refused";
  if (r.bookedOn) return "booked";
  const left = daysBetween(today, validUntil(r));
  if (left < 0) return "lapsed";
  if (r.visitedOn) return "visited";
  return left < LAPSING_UNDER ? "lapsing" : "live";
}

/** Days left on a registration, never below zero. */
export function daysLeft(r: Registration, today: string): number {
  return Math.max(0, daysBetween(today, validUntil(r)));
}

/** When a claim written at `atIso` lapses. */
export function claimEnds(atIso: string, days: number): string {
  return new Date(Date.parse(atIso) + days * DAY_MS).toISOString();
}

/**
 * A visit carries a live claim at least `days` past the visit. It never
 * shortens one: a claim with longer to run keeps it.
 */
export function extendedUntil(currentIso: string, visitIso: string, days: number): string {
  const candidate = claimEnds(visitIso, days);
  return Date.parse(candidate) > Date.parse(currentIso) ? candidate : currentIso;
}

/** An earlier enquiry this recent, still open, means the buyer came direct. */
export const DIRECT_LOOKBACK_DAYS = 90;

export type Verdict = "REGISTERED" | "ALREADY" | "BLOCKED" | "DIRECT_FIRST" | "NO_GRANT" | "AGENT_RERA" | "RATE_LIMITED";

export type GrantState = { status: "ACTIVE" | "SUSPENDED" | "ENDED"; validFrom: string; validTo: string };

/** A grant is live while it is ACTIVE and inside its window. Nothing else. */
export function grantLive(g: GrantState | null, nowIso: string): boolean {
  if (!g || g.status !== "ACTIVE") return false;
  const now = Date.parse(nowIso);
  return Date.parse(g.validFrom) <= now && now < Date.parse(g.validTo);
}

export type VerdictInput = {
  nowIso: string;
  firmOrgId: string;
  project: string;
  phone: string;
  /** The firm's grant at this project, if it ever had one. */
  grant: GrantState | null;
  /** The firm's MahaRERA agent registration, as this tenant has it on file. */
  agent: { reraNo: string | null; reraTill: string | null };
  attemptsToday: number;
  dailyCap: number;
  /** A claim in force on this buyer at this project, by anybody. */
  claim: { cpOrgId: string; validUntil: string } | null;
  /** When the buyer last enquired directly, if the enquiry is open and recent. */
  directSince: string | null;
  /**
   * What makes a direct buyer the developer's: the enquiry itself (ENQUIRY,
   * the default), or only a site visit recorded on it (VISIT).
   */
  directWins?: DirectWins;
  /** The direct enquiry has a site visit recorded. Read only under VISIT. */
  directVisited?: boolean;
  registrationDays: number;
};

/** The developer's rule for who owns a buyer who enquired directly and is then registered by a partner. */
export type DirectWins = "ENQUIRY" | "VISIT";

export const DIRECT_WINS_LABEL: Record<DirectWins, string> = {
  ENQUIRY: "The first enquiry wins",
  VISIT: "A direct buyer is ours once they visit",
};

/** Whether an open direct enquiry refuses a partner's registration under this rule. */
export function directBlocks(directSince: string | null, rule: DirectWins | undefined, visited: boolean | undefined): boolean {
  if (!directSince) return false;
  return rule !== "VISIT" || !!visited;
}

/**
 * A registration that went through over an open direct enquiry, which is
 * what VISIT allows before the visit: that direct lead is now the partner's.
 */
export function takesDirectLead(v: Verdict, directSince: string | null, rule: DirectWins | undefined, visited: boolean | undefined): boolean {
  return v === "REGISTERED" && !!directSince && !directBlocks(directSince, rule, visited);
}

export type VerdictResult = {
  verdict: Verdict;
  /** When the answer's date runs out: the claim, the holder's claim, or the grant. */
  validUntil: string | null;
  /** What the partner is told. Masked, and never another firm's name. */
  message: string;
};

const onDay = (iso: string) => {
  const d = istDay(iso);
  const [y, m, day] = d.split("-").map(Number);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${day} ${MON[m - 1]} ${y}`;
};

const daysTo = (fromIso: string, toIso: string) => Math.max(0, Math.ceil((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS));

/**
 * The verdict on one attempt. The order is the rule, and every branch says
 * what the partner may act on: a date, never who.
 */
export function registrationVerdict(i: VerdictInput): VerdictResult {
  const who = maskPhone(i.phone);
  if (i.attemptsToday >= i.dailyCap) {
    return { verdict: "RATE_LIMITED", validUntil: null, message: `${i.dailyCap} registrations today already. Try again tomorrow.` };
  }
  if (!grantLive(i.grant, i.nowIso)) {
    const g = i.grant;
    if (g && g.status === "SUSPENDED") {
      return { verdict: "NO_GRANT", validUntil: null, message: `Empanelment on ${i.project} is on hold. Speak to your relationship manager.` };
    }
    if (g && Date.parse(g.validFrom) > Date.parse(i.nowIso)) {
      return { verdict: "NO_GRANT", validUntil: g.validFrom, message: `Empanelment on ${i.project} starts ${onDay(g.validFrom)}.` };
    }
    if (g) {
      return { verdict: "NO_GRANT", validUntil: g.validTo, message: `Empanelment on ${i.project} ended ${onDay(g.validTo)}.` };
    }
    return { verdict: "NO_GRANT", validUntil: null, message: `Not empanelled on ${i.project}.` };
  }
  if (!i.agent.reraNo || !i.agent.reraTill) {
    return { verdict: "AGENT_RERA", validUntil: null, message: "No MahaRERA agent registration on file. Share it with your relationship manager." };
  }
  if (i.agent.reraTill < istDay(i.nowIso)) {
    return {
      verdict: "AGENT_RERA",
      validUntil: null,
      message: `MahaRERA agent registration lapsed on ${onDay(`${i.agent.reraTill}T12:00:00Z`)}. Renew it to register buyers.`,
    };
  }
  if (i.claim && Date.parse(i.claim.validUntil) > Date.parse(i.nowIso)) {
    const left = daysTo(i.nowIso, i.claim.validUntil);
    if (i.claim.cpOrgId === i.firmOrgId) {
      return {
        verdict: "ALREADY",
        validUntil: i.claim.validUntil,
        message: `${who} is already registered with you on ${i.project} until ${onDay(i.claim.validUntil)}, ${left} ${left === 1 ? "day" : "days"} left.`,
      };
    }
    return {
      verdict: "BLOCKED",
      validUntil: i.claim.validUntil,
      message: `${who} is already registered on ${i.project} until ${onDay(i.claim.validUntil)}.`,
    };
  }
  if (directBlocks(i.directSince, i.directWins, i.directVisited)) {
    return { verdict: "DIRECT_FIRST", validUntil: null, message: `${who} enquired with ${i.project} directly before this.` };
  }
  const until = claimEnds(i.nowIso, i.registrationDays);
  return {
    verdict: "REGISTERED",
    validUntil: until,
    message: `${who} registered on ${i.project} until ${onDay(until)}, ${i.registrationDays} days.`,
  };
}

/** What a verdict means on the desk, beside the partner's own message. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  REGISTERED: "Registered",
  ALREADY: "Already theirs",
  BLOCKED: "Another firm holds this buyer",
  DIRECT_FIRST: "Came direct first",
  NO_GRANT: "Not empanelled here",
  AGENT_RERA: "Agent registration missing or lapsed",
  RATE_LIMITED: "Day's registrations used up",
};

export const REFUSE_OF: Partial<Record<Verdict, RefuseReason>> = {
  BLOCKED: "firm",
  DIRECT_FIRST: "direct",
  NO_GRANT: "no_grant",
  AGENT_RERA: "agent_rera",
  RATE_LIMITED: "rate_limited",
};

// ---------------------------------------------------------------------------
// Firms: the documents that keep one empanelled
// ---------------------------------------------------------------------------

export type DocState = "ok" | "expiring" | "expired" | "missing";

/** Under this many days to expiry, a document is flagged. */
export const EXPIRING_UNDER = 30;

export function docState(validTill: string | null, today: string): DocState {
  if (!validTill) return "missing";
  const d = daysBetween(today, validTill);
  if (d < 0) return "expired";
  if (d <= EXPIRING_UNDER) return "expiring";
  return "ok";
}

/**
 * A MahaRERA agent number: A, then eleven digits. The regulator does not
 * publish the pattern; it is the shape every issued number has.
 */
export const isMahaReraAgent = (no: string) => /^A\d{11}$/.test(no.trim().toUpperCase());

/** What a person types about a firm, already normalised. */
export type FirmInput = {
  name: string;
  legalName: string;
  pan: string;
  gstin: string | null;
  reraNo: string | null;
  reraTill: string | null;
  competencyTill: string | null;
  principalName: string | null;
  /** E.164, or null. */
  principalPhone: string | null;
  area: string | null;
};

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** What is wrong with a firm's details, by field. Empty when nothing is. */
export function firmProblem(f: FirmInput): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.name || f.name.length > 120) e.name = "Enter the name the firm trades under.";
  if (!f.legalName || f.legalName.length > 160) e.legalName = "Enter the name on the firm's PAN.";
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(f.pan)) e.pan = e.pan ?? "Enter the firm's PAN, like ABCPK1234F.";
  if (f.gstin && f.gstin.slice(2, 12) !== f.pan) e.gstin = "This GSTIN carries a different PAN.";
  if (f.reraNo && !isMahaReraAgent(f.reraNo)) e.reraNo = "A MahaRERA agent number is A and eleven digits.";
  if (f.reraNo && !f.reraTill) e.reraTill = "Enter when the agent registration ends.";
  if (f.reraTill && !isDay(f.reraTill)) e.reraTill = "Use a date.";
  if (f.competencyTill && !isDay(f.competencyTill)) e.competencyTill = "Use a date.";
  if (f.principalName && f.principalName.length > 120) e.principalName = "Shorter, please.";
  if (f.principalPhone && !/^\+[1-9]\d{7,14}$/.test(f.principalPhone)) e.principalPhone = "Use 10 digits, or add the country code.";
  if (f.area && f.area.length > 80) e.area = "Shorter, please.";
  return e;
}

/** A firm with nothing registered in this many days has gone quiet. */
export const DORMANT_AFTER = 30;

export function isDormant(lastRegistration: string | null, today: string): boolean {
  return !lastRegistration || daysBetween(lastRegistration, today) > DORMANT_AFTER;
}

/** Where a firm stands on one project. */
export type FirmProject = {
  name: string;
  grantId?: string;
  status: "live" | "on_hold" | "ended" | "not_started";
  validTo: string | null;
  /** Live bookings the firm has brought to this project. */
  booked: number;
  /** What its next booking here earns. */
  rate: number;
  next: { more: number; rate: number } | null;
};

export type Firm = {
  id: string;
  name: string;
  area: string | null;
  principal: string | null;
  phone: string | null;
  rm: string | null;
  /** MahaRERA agent number, and when that registration ends. */
  rera: string | null;
  reraTill: string | null;
  /** The certificate of competency every agent has needed since 2024. */
  competencyTill: string | null;
  pan: string;
  gstin: string | null;
  /** Agents the firm has registered buyers through. */
  agents: number;
  projects: FirmProject[];
  joinedOn: string;
  bookingsYear: number;
};

/** Where a grant stands, in the desk's words. */
export function grantStatus(g: GrantState, nowIso: string): FirmProject["status"] {
  if (g.status === "SUSPENDED") return "on_hold";
  if (g.status === "ENDED") return "ended";
  if (Date.parse(g.validFrom) > Date.parse(nowIso)) return "not_started";
  return grantLive(g, nowIso) ? "live" : "ended";
}

// ---------------------------------------------------------------------------
// A partner's link: the ref code on a co-branded post
// ---------------------------------------------------------------------------

/**
 * Two or three capitals from a name: its words' initials, and where there are
 * fewer words than letters wanted, more of the first word ("Sharma Realty"
 * is SHR, "Sath Heights" SH).
 */
export function initials(name: string, len = 2): string {
  const words = name.toUpperCase().replace(/[^A-Z ]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "XX".slice(0, len).padEnd(len, "X");
  const rest = words.slice(1, len).map((w) => w[0]).join("");
  const out = `${words[0].slice(0, len - rest.length)}${rest}`;
  return out.padEnd(Math.max(2, Math.min(len, out.length)), "X");
}

/** `ST-KR-4417`: the project, the firm, and four digits. */
export function refCode(project: string, firm: string, n: number): string {
  return `${initials(project)}-${initials(firm, 3)}-${String(Math.abs(Math.trunc(n)) % 10000).padStart(4, "0")}`;
}

/** A ref code off an address or a form, or null. Case and spacing do not matter. */
export function partnerRefFrom(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z]{2,3}-[A-Z]{2,3}-\d{4}$/.test(s) ? s : null;
}

/**
 * What a co-branded post adds under the developer's own advertisement: the
 * firm, its MahaRERA agent registration (an agent's advertisement carries
 * its number) and the ref code the buyer quotes. Nothing of the post itself
 * is covered.
 */
export function partnerStrip(firm: string, agentNo: string, code: string): [string, string] {
  return [firm.trim(), `MahaRERA Agent Reg. No. ${agentNo.trim().toUpperCase()}  ·  Ref ${code}`];
}

// ---------------------------------------------------------------------------
// A booking a claim did not match by its own number and project
// ---------------------------------------------------------------------------

/**
 * A buyer registered on one project and booked on another of the same
 * developer. OFF does nothing, FLAG tells the desk, CARRY writes the payout
 * on the booked project's terms as if the claim were there, but only while
 * the firm is empanelled on the booked project; otherwise it is a flag.
 */
export type CrossProject = "OFF" | "FLAG" | "CARRY";

export const CROSS_PROJECT_LABEL: Record<CrossProject, string> = {
  OFF: "Only the project it was registered on",
  FLAG: "Flag it for the desk",
  CARRY: "Pay it on the booked project's terms",
};

export const isCrossProject = (v: unknown): v is CrossProject => v === "OFF" || v === "FLAG" || v === "CARRY";

export function crossProjectAction(rule: CrossProject, empanelledOnBooked: boolean): "NONE" | "FLAG" | "CARRY" {
  if (rule === "OFF") return "NONE";
  if (rule === "CARRY" && empanelledOnBooked) return "CARRY";
  return "FLAG";
}

/** What the booked lead says when a claim on another project is found. */
export function crossProjectNote(firm: string, project: string): string {
  return `${firm} registered this buyer on ${project}`.slice(0, 200);
}

/** How a payout found its claim. */
export type MatchedBy = "PHONE" | "OTHER_NUMBER" | "OTHER_PROJECT" | "BY_HAND";

export const MATCHED_BY_LABEL: Record<MatchedBy, string> = {
  PHONE: "The buyer's number",
  OTHER_NUMBER: "Another number on the lead",
  OTHER_PROJECT: "Registered on another project",
  BY_HAND: "Linked by hand",
};

/** A claim may be linked to a booking by hand up to this many days after it lapsed. */
export const LINK_LAPSED_DAYS = 30;

/**
 * Why a claim cannot be linked by hand to a booked lead, or null when it
 * can. The desk does this when no claim matched the booking: a buyer who
 * registered under a spouse's number, or booked before a number was fixed.
 */
export function manualLinkRefusal(i: {
  claim: { verdict: Verdict; status: string; validUntil: string | null } | null;
  leadBooked: boolean;
  hasPartnerPayout: boolean;
  reason: string;
  nowIso: string;
}): string | null {
  if (!i.leadBooked) return "Only a booked lead can be linked.";
  if (i.hasPartnerPayout) return "This booking already pays a partner.";
  const c = i.claim;
  if (!c || c.verdict !== "REGISTERED" || !c.validUntil) return "Choose a registration the firm holds.";
  if (c.status === "BOOKED" || c.status === "WITHDRAWN") return "This registration is not free to link.";
  if (Date.parse(c.validUntil) < Date.parse(i.nowIso) - LINK_LAPSED_DAYS * DAY_MS) {
    return `Only a registration live now, or lapsed in the last ${LINK_LAPSED_DAYS} days, can be linked.`;
  }
  const why = i.reason.trim();
  if (why.length < 4) return "Say why this booking is the firm's.";
  if (why.length > 200) return "Keep the reason under 200 letters.";
  return null;
}

// ---------------------------------------------------------------------------
// Clawback: a booking cancelled after a half was paid
// ---------------------------------------------------------------------------

/**
 * What a cancelled booking takes back: every rupee actually sent on it,
 * which is each paid half's net (the invoice total less TDS) less anything
 * an earlier clawback already took off that half. The whole of it, because
 * the booking that earned it no longer exists; the TDS deposited on it is
 * the developer's to claim back in its own return, not the firm's to repay.
 */
export function clawbackFor(paidHalves: { net: number; adjusted: number }[]): number {
  return paidHalves.reduce((sum, h) => sum + Math.max(0, h.net - h.adjusted), 0);
}

export type DebitUse = { debitId: string; halfId: string; amount: number };

/**
 * Debits set against owed halves, oldest debit first and oldest half first.
 * A half never goes below zero, and a debit is never used past its amount.
 * `outstanding` and `room` are positive rupees.
 */
export function applyDebits(debits: { id: string; outstanding: number }[], halves: { id: string; room: number }[]): DebitUse[] {
  const left = halves.map((h) => ({ ...h, room: Math.max(0, Math.floor(h.room)) }));
  const out: DebitUse[] = [];
  for (const d of debits) {
    let owe = Math.max(0, Math.floor(d.outstanding));
    for (const h of left) {
      if (!owe) break;
      const take = Math.min(owe, h.room);
      if (take <= 0) continue;
      out.push({ debitId: d.id, halfId: h.id, amount: take });
      h.room -= take;
      owe -= take;
    }
  }
  return out;
}

/** The line a half carries when part of it was taken against a cancelled booking. */
export function adjustedLine(amount: number, booking: string): string {
  return `Adjusted against booking ${booking}: Rs ${amount.toLocaleString("en-IN")}`;
}

// ---------------------------------------------------------------------------
// Other numbers on a lead: a co-applicant, an alternate
// ---------------------------------------------------------------------------

export type OtherNumberKind = "CO_APPLICANT" | "ALTERNATE";

export const OTHER_NUMBER_LABEL: Record<OtherNumberKind, string> = {
  CO_APPLICANT: "Co-applicant",
  ALTERNATE: "Alternate number",
};

/** More than this on one lead is a list, not a buyer. */
export const MAX_OTHER_NUMBERS = 4;

/** Why this number cannot be added to the lead, or null. `phone` is already E.164, or null when it did not read. */
export function otherNumberProblem(phone: string | null, main: string, existing: string[]): string | null {
  if (!phone) return "Use 10 digits, or add the country code.";
  if (phone === main) return "That is the lead's own number.";
  if (existing.includes(phone)) return "That number is already on this lead.";
  if (existing.length >= MAX_OTHER_NUMBERS) return `At most ${MAX_OTHER_NUMBERS} other numbers on a lead.`;
  return null;
}

// ---------------------------------------------------------------------------
// Why an invoice was sent back
// ---------------------------------------------------------------------------

/** The reasons a developer may give for sending an invoice back, in the firm's words. */
export const REJECT_REASONS = {
  AMOUNT: "The amount does not match what is owed",
  GST: "The GST on it is wrong",
  DETAILS: "The invoice number, date or names are wrong",
  FILE: "The file could not be read",
  OTHER: "The developer did not accept it. Ask them why",
} as const;
export type RejectReason = keyof typeof REJECT_REASONS;
export const isRejectReason = (v: unknown): v is RejectReason => typeof v === "string" && v in REJECT_REASONS;
