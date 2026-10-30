import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Messages carried in an address, signed so only ours are shown.
 *
 * A redirect after an action says what happened in the query string
 * (`?error=...`), and the page printed whatever it found there: any link to
 * `/dashboard/projects?error=Call 98... to restore access` rendered a red
 * banner on our console in our voice. Each flashed value now travels with a
 * short signature (`error_s`) made with a key derived from AUTH_SECRET, and a
 * page shows the text only when the signature matches it.
 *
 * Server only. The banner itself is `components/Flash.tsx`.
 */

function key(): Buffer {
  const root = process.env.AUTH_SECRET;
  if (!root) throw new Error("AUTH_SECRET is not set.");
  return createHmac("sha256", root).update("salesdesk:flash").digest();
}

const sign = (name: string, value: string) =>
  createHmac("sha256", key()).update(`${name}\n${value}`).digest("base64url").slice(0, 22);

/**
 * `name=value&name_s=signature`, ready to join onto a path's query string.
 * `redirect(`/dashboard/projects?${flash("error", r.message)}`)`.
 */
export function flash(name: string, value: string): string {
  const v = value.slice(0, 600);
  return `${encodeURIComponent(name)}=${encodeURIComponent(v)}&${encodeURIComponent(`${name}_s`)}=${sign(name, v)}`;
}

type Query = Record<string, string | string[] | undefined>;

/** The flashed text under `name`, or null when it is absent or not ours. */
export function readFlash(q: Query, name: string): string | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const value = one(q[name]);
  const given = one(q[`${name}_s`]);
  if (!value || !given) return null;
  const want = Buffer.from(sign(name, value.slice(0, 600)));
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got) ? value : null;
}
