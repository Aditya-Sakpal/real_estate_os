/**
 * Who a captured enquiry belongs to, decided before anybody is called. Pure
 * and database-free, covered by `check:logic`.
 *
 * Section 02 asks four questions of every enquiry, in order, and the first
 * one that answers wins:
 *
 *   R0  junk: a test, a number nobody owns, a form a bot filled, or a number
 *       this developer already closed as a broker or a wrong number
 *   R1  already booked: the buyer bought here, in this project
 *   R2  a channel partner holds the buyer at this project (decided by
 *       `tagCaptured()` in `partners.ts`, inside the same transaction)
 *   R3  an open lead of this developer's, active inside the lookback
 *   R4  none of those: a new lead
 *
 * The rule that fired is recorded on the capture event and in the audit
 * log, so "why was this buyer not called" has an answer. R0 and R1 are never
 * called: a junk number costs a dial and a booked buyer is somebody the
 * sales team already knows by name.
 */

export type OwnershipRule = "R0" | "R1" | "R2" | "R3" | "R4";

export const OWNERSHIP_RULES: readonly OwnershipRule[] = ["R0", "R1", "R2", "R3", "R4"];

/** What each rule means, in the words a lead's history shows. */
export const RULE_WORDS: Record<OwnershipRule, string> = {
  R0: "Junk, not contacted",
  R1: "Already booked here",
  R2: "A partner's buyer",
  R3: "Enquired again",
  R4: "New enquiry",
};

/** Days an open lead keeps a re-enquiry, unless the organisation chose otherwise. */
export const LOOKBACK_DAYS = 90;
export const LOOKBACK_MIN = 7;
export const LOOKBACK_MAX = 365;

/** The exit reasons a closed lead carries when its number was found to be junk. */
export const JUNK_EXITS = ["Duplicate or junk", "Wrong number"] as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Junk
// ---------------------------------------------------------------------------

/**
 * Numbers forms fill with when a buyer does not want to give theirs. Ten of
 * the same digit, and the two "example" numbers people type. A real Indian
 * mobile never repeats one digit ten times, so nobody real is refused.
 */
const TEST_NUMBERS = new Set(["+919876543210", "+919123456789", "+911234567890"]);

export function junkPhone(e164: string): boolean {
  if (TEST_NUMBERS.has(e164)) return true;
  const m = /^\+91(\d{10})$/.exec(e164);
  return !!m && /^(\d)\1{9}$/.test(m[1]);
}

const TEST_NAMES = /^(test|testing|test lead|dummy|sample|fake|asdf|asdfgh|qwerty|abc|abcd|xyz|na|n\/a|none|null|nil|no name|lorem ipsum)$/i;

/** A name a person types when testing a form, never one a buyer is called. */
export function junkName(name: string): boolean {
  return TEST_NAMES.test(name.trim().replace(/\s+/g, " ").replace(/[.!_-]+$/g, ""));
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type OwnershipInput = {
  nowIso: string;
  lookbackDays: number;
  /** A form's own test flag. */
  isTest: boolean;
  /** Our enquiry page's hidden field, which only a bot fills. */
  honeypot: boolean;
  phone: string;
  name: string;
  /**
   * This number's most recent closed lead in the organisation, when it was
   * closed as junk: the reason and when it last moved.
   */
  closedAsJunk: { reason: string; at: string } | null;
  /** A booked lead of this number in the same project. */
  booked: { leadId: string } | null;
  /** The newest open lead of this number in the same project, and when anything last happened on it. */
  open: { leadId: string; lastActivityAt: string } | null;
};

export type OwnershipVerdict =
  | { rule: "R0"; action: "JUNK"; reason: string }
  | { rule: "R1"; action: "BOOKED"; leadId: string }
  | { rule: "R3"; action: "MERGE"; leadId: string }
  | { rule: "R4"; action: "NEW"; closeStale: string | null };

/**
 * The rule that fires, R2 aside (a partner's claim is read against the lead
 * this returns, in the same transaction). Asked in section 02's order; the
 * first to answer wins.
 */
export function ownershipRule(i: OwnershipInput): OwnershipVerdict {
  if (i.isTest) return { rule: "R0", action: "JUNK", reason: "A test submission." };
  if (i.honeypot) return { rule: "R0", action: "JUNK", reason: "The form was filled by a bot." };
  if (junkPhone(i.phone)) return { rule: "R0", action: "JUNK", reason: "Not a number anybody owns." };
  if (junkName(i.name)) return { rule: "R0", action: "JUNK", reason: "A test name." };
  const window = clampLookback(i.lookbackDays) * DAY_MS;
  const now = Date.parse(i.nowIso);
  if (i.closedAsJunk && (JUNK_EXITS as readonly string[]).includes(i.closedAsJunk.reason) && now - Date.parse(i.closedAsJunk.at) <= window) {
    return { rule: "R0", action: "JUNK", reason: `Closed here before as "${i.closedAsJunk.reason.toLowerCase()}".` };
  }
  if (i.booked) return { rule: "R1", action: "BOOKED", leadId: i.booked.leadId };
  if (i.open) {
    if (now - Date.parse(i.open.lastActivityAt) <= window) return { rule: "R3", action: "MERGE", leadId: i.open.leadId };
    // Open, but quiet for longer than the lookback: this is a new enquiry,
    // and the old card is closed rather than left beside it.
    return { rule: "R4", action: "NEW", closeStale: i.open.leadId };
  }
  return { rule: "R4", action: "NEW", closeStale: null };
}

/** The lookback an organisation may choose: a week to a year, whole days. */
export function clampLookback(days: number): number {
  if (!Number.isFinite(days)) return LOOKBACK_DAYS;
  return Math.min(LOOKBACK_MAX, Math.max(LOOKBACK_MIN, Math.round(days)));
}

/** Why a lookback typed in Settings cannot be saved, or null. */
export function lookbackProblem(raw: string): string | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return "Enter the days as a whole number, like 90.";
  const n = Number(s);
  if (n < LOOKBACK_MIN) return `At least ${LOOKBACK_MIN} days.`;
  if (n > LOOKBACK_MAX) return `At most ${LOOKBACK_MAX} days.`;
  return null;
}
