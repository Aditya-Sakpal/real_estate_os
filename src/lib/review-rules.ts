/**
 * One project's "Review and approve": everything waiting for a person's yes,
 * in one place, with one press per kind.
 *
 * Setting a project up meant visiting the documents of every tower, the
 * library of every tower, the flats of every tower and the facts of every
 * tower, in an order nobody had written down. Nothing here lowers a bar: a
 * press approves exactly the rows that were on screen, each through the same
 * function its own screen calls, under the same key at that row's own place.
 *
 * Pure, so `check:logic` covers it.
 */

export type ReviewKind = "VALUES" | "PICTURES" | "FLATS";

/** The ids a bulk press may act on: only those the screen showed, at most this many. */
export const MAX_BULK = 200;

/** The ids posted, kept to the ones the screen listed and to `MAX_BULK`. */
export function pickShown(posted: readonly unknown[], shown: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  for (const raw of posted) {
    const id = String(raw ?? "").trim();
    if (shown.has(id) && !seen.has(id)) seen.add(id);
    if (seen.size >= MAX_BULK) break;
  }
  return [...seen];
}

const NOUN: Record<ReviewKind, [string, string]> = {
  VALUES: ["value", "values"],
  PICTURES: ["picture", "pictures"],
  FLATS: ["flat type", "flat types"],
};
const VERB: Record<ReviewKind, string> = { VALUES: "accepted", PICTURES: "approved", FLATS: "approved" };

const count = (n: number, kind: ReviewKind) => `${n} ${NOUN[kind][n === 1 ? 0 : 1]}`;

/**
 * What a bulk press says afterwards. A refusal is named once, with how many
 * it stopped, because the first refusal's words are the useful ones.
 */
export function bulkLine(kind: ReviewKind, done: number, refused: { count: number; first: string | null }): string {
  const head = done > 0 ? `${count(done, kind)} ${VERB[kind]}.` : `Nothing ${VERB[kind]}.`;
  if (refused.count === 0) return head;
  return `${head} ${count(refused.count, kind)} left: ${refused.first ?? "not allowed here"}`;
}

/** Least sure first, so the values most worth a look lead. */
export function leastSureFirst<T extends { confidence: number; at: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.confidence - b.confidence || a.at.localeCompare(b.at));
}

export type ReviewTotals = { values: number; pictures: number; flats: number; drafts: number };

/** The one line under the title. */
export function reviewHeadline(t: ReviewTotals): string {
  const parts = [
    t.values ? `${t.values} ${t.values === 1 ? "value" : "values"} to check` : null,
    t.pictures ? `${t.pictures} ${t.pictures === 1 ? "picture" : "pictures"} to approve` : null,
    t.flats ? `${t.flats} flat ${t.flats === 1 ? "type" : "types"} to approve` : null,
    t.drafts ? `facts to sign on ${t.drafts} ${t.drafts === 1 ? "place" : "places"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing waiting for approval.";
}
