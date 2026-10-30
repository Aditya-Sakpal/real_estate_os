import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

/**
 * The operator console at admin.salesdesk.app: Sales Desk's own people,
 * never a client's. It has its own sign-in, apart from the product's.
 *
 *   - Only an address in OPERATOR_EMAILS may sign in. Unset, nobody can.
 *   - Sign-in is a link emailed to that address, signed with a key derived
 *     from AUTH_SECRET and good for 15 minutes. Nothing is stored.
 *   - The session is a signed, host-only cookie good for 12 hours, and the
 *     address is checked against the list again on every request, so taking
 *     somebody off the list ends their session at once.
 *   - Every page answers only on a host starting "admin.", so the same pages
 *     on app.salesdesk.app are a 404.
 */

export const SESSION_COOKIE = "est_operator";
const SESSION_HOURS = 12;
const LINK_MINUTES = 15;

type Purpose = "link" | "session";
type Claims = { e: string; p: Purpose; x: number };

function key(): Buffer {
  const root = process.env.AUTH_SECRET;
  if (!root) throw new Error("AUTH_SECRET is not set.");
  return createHmac("sha256", root).update("salesdesk operator v1").digest();
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The addresses that may sign in, lower case. */
export function operatorEmails(): string[] {
  return (process.env.OPERATOR_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

export function isOperator(email: string): boolean {
  return operatorEmails().includes(email.trim().toLowerCase());
}

function sign(claims: Claims): string {
  const body = b64(JSON.stringify(claims));
  const mac = createHmac("sha256", key()).update(body).digest();
  return `${body}.${b64(mac)}`;
}

/** The claims of a token we signed, for this purpose, not expired, of an operator still on the list. */
export function verify(token: string | undefined | null, purpose: Purpose, now = Date.now()): string | null {
  if (!token || token.length > 600) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", key()).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let c: Claims;
  try {
    c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
  } catch {
    return null;
  }
  if (c.p !== purpose || typeof c.x !== "number" || c.x < now || typeof c.e !== "string") return null;
  return isOperator(c.e) ? c.e.toLowerCase() : null;
}

export function linkToken(email: string, now = Date.now()): string {
  return sign({ e: email.toLowerCase(), p: "link", x: now + LINK_MINUTES * 60_000 });
}

export function sessionToken(email: string, now = Date.now()): { token: string; maxAge: number } {
  const maxAge = SESSION_HOURS * 3600;
  return { token: sign({ e: email.toLowerCase(), p: "session", x: now + maxAge * 1000 }), maxAge };
}

/**
 * Where a sign-in link points. Never built from the request's Host header,
 * which a caller chooses: a link to a host they own would hand them the token.
 */
export function adminBase(): string | null {
  const set = process.env.ADMIN_URL?.trim().replace(/\/+$/, "");
  if (set) return set;
  return process.env.VERCEL ? null : "http://admin.localhost:3000";
}

/** The operator console answers only on its own host. */
export async function onAdminHost(): Promise<boolean> {
  const host = ((await headers()).get("host") ?? "").toLowerCase();
  return host.startsWith("admin.");
}

/** The signed-in operator's address, or a redirect to sign-in. Off the admin host, a 404. */
export async function requireOperator(): Promise<string> {
  if (!(await onAdminHost())) notFound();
  const email = verify((await cookies()).get(SESSION_COOKIE)?.value, "session");
  if (!email) redirect("/signin");
  return email;
}
