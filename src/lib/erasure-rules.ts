import type { Qualification } from "./qualification-rules.ts";

/**
 * Erasing a buyer at their request (DPDP): the pure half of `erasure.ts`.
 *
 * Erasure scrubs and never deletes. The buyer's name, number, email and
 * every word they said or wrote go; the lead's id, its stages, the amounts
 * and the times stay, so a report still counts the booking and a partner's
 * payout still adds up. Their number is kept in one place only, the opt-out
 * lists, which is what stops anybody here ringing them again.
 */

/** What an erased lead is called on every screen. The database holds it to this. */
export const ERASED_NAME = "Erased buyer";

export type ErasureFacts = {
  /** Leads with this number at a tower the person may not erase at. */
  outsideReach: number;
  /** A call is on the line, or being placed. */
  liveCall: boolean;
  /** A token link the buyer can still pay, or a flat held for them. */
  liveToken: boolean;
  /** A site visit still to come. */
  futureVisit: boolean;
};

/**
 * Why the buyer cannot be erased right now, or null. Each one is something a
 * person can clear in a minute, and erasing over it would leave money or a
 * visit pointing at nobody:
 *
 * - a live call would write its transcript back after the erasure;
 * - a live token link or block holds a flat, and a paid token is a refund
 *   that needs to know whom to pay;
 * - a booked visit would be reminded and checked in.
 *
 * An unpaid partner payout is not a reason: it is owed to the firm, and it
 * names the lead by its id, which stays.
 */
export function erasureRefusal(f: ErasureFacts): string | null {
  if (f.outsideReach > 0) {
    return f.outsideReach === 1
      ? "This buyer also enquired at a tower you cannot erase at. Ask someone who can."
      : `This buyer also enquired at ${f.outsideReach} towers you cannot erase at. Ask someone who can.`;
  }
  if (f.liveCall) return "A call with this buyer is on the line. Erase after it ends.";
  if (f.liveToken) return "A token link or a flat block is live for this buyer. Cancel it first.";
  if (f.futureVisit) return "A site visit is booked for this buyer. Cancel it first.";
  return null;
}

/** What the calls heard, without the buyer's own words: the values and the score stay. */
export function scrubQualification(q: Qualification | null | undefined): Qualification {
  const out: Qualification = {};
  for (const [field, heard] of Object.entries(q ?? {})) {
    if (!heard) continue;
    out[field as keyof Qualification] = { value: heard.value, confidence: heard.confidence, span: "" };
  }
  return out;
}

/** How a visit went, without the note the host typed about the buyer. */
export function scrubOutcome(o: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!o) return o;
  const rest = { ...o };
  delete rest.note;
  return rest;
}

/** The confirmation's words, so a person knows exactly what pressing it does. */
export function erasureWarning(leads: number): string {
  const which = leads > 1 ? `all ${leads} of their enquiries here` : "this enquiry";
  return `Their name, number, email, call transcripts, messages and visit notes are erased from ${which}. Stages and amounts stay for reports. They will not be called or messaged again. This cannot be undone.`;
}
