/**
 * Calling hours and the IST clock, with no server imports, so a client
 * component (the broadcast panel) can read them. `calling-rules.ts` imports
 * `node:crypto` and re-exports these.
 */

/** An enquiry permits a call for this many days after it was made. */
export const ENQUIRY_DAYS = 7;

/** Calling hours, IST, inclusive of the start and exclusive of the end. */
export const CALLING_HOURS = { from: 10, to: 21 } as const;

/** The IST calendar date of an instant, as 2026-09-27. */
export function istDate(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
}

/** The IST hour of an instant, 0 to 23. */
export function istHour(iso: string): number {
  return new Date(Date.parse(iso) + 330 * 60_000).getUTCHours();
}
