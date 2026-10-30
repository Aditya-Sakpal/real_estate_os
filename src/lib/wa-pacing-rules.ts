/**
 * Pacing one-to-one WhatsApp to a number's messaging limit: the pure half.
 *
 * Meta caps how many different people a business may START a conversation
 * with in a rolling 24 hours (the "messaging limit", read into
 * `whatsapp_numbers.daily_limit`). Past it Meta refuses the template, and the
 * lead engine used to read that as a failure and give up after three tries.
 * So the count is asked before Meta is: a send that would go over waits until
 * the oldest person in the window ages out, and nothing is paid for or lost.
 *
 * Since October 2025 Meta sets the limit per business portfolio rather than
 * per number. We count per number, which is exact for a developer with one
 * number and conservative-wrong only for a portfolio with several.
 *
 * Client-safe: no database, no network.
 */

export const WINDOW_MS = 24 * 3_600_000;
/** A number whose tier Meta has not told us yet is held to the starting tier. */
export const UNKNOWN_TIER_PEOPLE = 250;
/** How long a lower-priority send waits behind a higher one released at the same moment. */
export const LATER_OFFSET_MS = 10 * 60_000;
/** A wait is never shorter than this, so a worker pass does not spin on it. */
export const MIN_WAIT_MS = 60_000;
/** How many of the oldest people in the window are read to work out the wait. */
export const OLDEST_READ = 60;

/**
 * What goes first when the day's budget is short. An acknowledgement and
 * anything about a visit or a token is something the buyer is waiting on; a
 * drip, a follow-up or a check-in can wait a few hours without harm.
 */
export const FIRST_PURPOSES: readonly string[] = [
  "ACK",
  "MISSED_CALL",
  "VISIT_CONFIRMED",
  "VISIT_REMINDER_DAY",
  "VISIT_REMINDER_SOON",
  "VISIT_CANCELLED",
  "SLOT_OFFER",
  "VISIT_REOFFER",
  "SITE_LOCATION",
  "TOKEN_LINK",
  "BOOKING",
];

export type PacePriority = "FIRST" | "LATER";

export const priorityOf = (purpose: string): PacePriority => (FIRST_PURPOSES.includes(purpose) ? "FIRST" : "LATER");

/** The slice of the limit kept back for what goes first: a tenth, at least one. */
export const reserveFor = (limit: number): number => Math.max(1, Math.ceil(limit * 0.1));

export type PaceInput = {
  /** People a day; null is no limit. */
  limit: number | null;
  /** Different people this number started a conversation with in the last 24 hours. */
  reached: number;
  /** This buyer is one of them already: another message adds nobody. */
  alreadyReached: boolean;
  /** The buyer wrote in the last 24 hours, so this answers them and starts nothing. */
  inServiceWindow: boolean;
  priority: PacePriority;
  /** Epoch ms of each reached person's latest send, oldest first (up to `OLDEST_READ`). */
  oldest: number[];
  now: number;
};

export type PaceVerdict = { ok: true } | { ok: false; untilMs: number };

/**
 * Whether a business-initiated template may go now, and if not, when to ask
 * again: the moment enough of the window's oldest people age out, bounded to
 * a day. What goes later keeps a tenth of the limit free for what goes first.
 */
export function paceSend(i: PaceInput): PaceVerdict {
  if (i.limit === null || i.inServiceWindow || i.alreadyReached) return { ok: true };
  const cap = i.priority === "FIRST" ? i.limit : Math.max(0, i.limit - reserveFor(i.limit));
  if (i.reached < cap) return { ok: true };
  // Room for one more needs this many people to leave the window.
  const needFree = i.reached - cap + 1;
  const sorted = [...i.oldest].sort((a, b) => a - b);
  // Fewer read than needed: the last one read is the earliest it could be,
  // and the next try works it out again.
  const pivot = sorted[Math.min(needFree, sorted.length) - 1];
  let until = pivot === undefined ? i.now + WINDOW_MS : pivot + WINDOW_MS;
  if (i.priority === "LATER") until += LATER_OFFSET_MS;
  until = Math.min(Math.max(until, i.now + MIN_WAIT_MS), i.now + WINDOW_MS);
  return { ok: false, untilMs: until };
}

/** The words on the lead while a message waits. */
export function pacedWords(displayPhone: string | null): string {
  const n = displayPhone ? `${displayPhone} reached` : "This WhatsApp number reached";
  return `Waiting: ${n} its daily WhatsApp limit. It goes out when the limit frees up.`;
}

export const PACED_PREFIX = "Waiting: ";
/** A task result that is a pacing wait, shown beside the task on the lead. */
export const isPacedNote = (result: string | null | undefined): boolean =>
  typeof result === "string" && result.startsWith(PACED_PREFIX) && result.includes("daily WhatsApp limit");

// ---------------------------------------------------------------------------
// Meta's refusals
// ---------------------------------------------------------------------------

/**
 * Codes from the Cloud API error reference that mean "not now", not "never".
 * Another attempt later succeeds, so they are retried with backoff.
 *   4       too many calls for the app (Graph API throttling)
 *   80007   the WABA's rate limit
 *   130429  Cloud API throughput reached
 *   131048  spam rate limit: too many recent messages blocked or reported
 *   131056  too many messages to one buyer in a short time (pair rate limit)
 * 131049 ("healthy ecosystem", a per-buyer marketing cap) is deliberately
 * NOT here: Meta says not to retry it within a day, so it stays a failure.
 */
export const THROTTLE_CODES: readonly number[] = [4, 80007, 130429, 131048, 131056];

/**
 * Codes that mean the messaging limit itself was reached. Meta's reference
 * does not publish a dedicated code we could confirm for this (UNCERTAIN): a
 * tier refusal is read from the words too ("messaging limit", "business
 * initiated"), and any code later confirmed goes in this list.
 */
export const TIER_CODES: readonly number[] = [];
const TIER_WORDS = /messaging limit|business[- ]initiated (conversation|message)s? limit|tier limit/i;

/** Not on WhatsApp: the webhook's SMS fallback handles it, unchanged. */
export const NOT_ON_WHATSAPP_CODE = 131026;

export type MetaRefusal = "THROTTLED" | "TIER" | "OTHER";

/** Meta's code from a thrown send error: "WhatsApp refused: ... (130429)". */
export function metaCodeOf(err: unknown): number | null {
  if (err && typeof err === "object") {
    const c = (err as { code?: unknown; platformCode?: unknown }).platformCode ?? (err as { code?: unknown }).code;
    if (typeof c === "number" && Number.isInteger(c)) return c;
  }
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = /\((\d{1,7})\)\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

export function classifyRefusal(code: number | null, text: string): MetaRefusal {
  if (code !== null && TIER_CODES.includes(code)) return "TIER";
  if (TIER_WORDS.test(text)) return "TIER";
  if (code !== null && THROTTLE_CODES.includes(code)) return "THROTTLED";
  return "OTHER";
}

/** Backoff for a throttled send: 1, 2, 4 ... minutes, never more than half an hour. */
export const THROTTLE_MAX_WAIT_MS = 30 * 60_000;
/** A send throttled for a whole day is given up. */
export const THROTTLE_GIVE_UP_MS = WINDOW_MS;

export const THROTTLED_WORDS = "WhatsApp is busy for this number right now. Trying again shortly.";

/**
 * What to do after Meta throttled a send. `prior` is when this task's
 * earlier throttles happened. It counts against the task's attempts at most
 * once an hour (with waits capped at half an hour, in practice once), and a
 * day after the first throttle it is given up.
 */
export function throttleRetry(prior: number[], now: number): { giveUp: boolean; retryAtMs: number; counted: boolean } {
  const first = prior.length ? Math.min(...prior) : now;
  if (now - first >= THROTTLE_GIVE_UP_MS) return { giveUp: true, retryAtMs: now, counted: true };
  const wait = Math.min(60_000 * 2 ** prior.length, THROTTLE_MAX_WAIT_MS);
  const counted = !prior.some((t) => now - t < 3_600_000);
  return { giveUp: false, retryAtMs: Math.min(now + wait, first + THROTTLE_GIVE_UP_MS), counted };
}
