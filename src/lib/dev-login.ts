import { createHash, timingSafeEqual } from "node:crypto";
import { appEnv } from "@/lib/app-env";
import { controlDb } from "@/lib/db";

/**
 * A development door: one press signs in as an address in `DEV_LOGIN_EMAIL`,
 * so a teammate can work a tenant without that person's Google account. The
 * variable lists addresses, comma separated, each optionally with the label
 * its button shows (`a@b.co=BillBay`); the sign-in page draws a button for
 * each.
 *
 * It opens each account's admin role to anybody who reaches the sign-in
 * page, so on a hosted production build (Vercel, or `NODE_ENV=production`
 * on our own server) it stays shut unless the site runs under
 * `ENVIRONMENT=development` AND `DEV_LOGIN_CODE` is set: then every press
 * asks for that code (the client, 23 October 2026, for a pitch on
 * app.salesdesk.app). Take the code out and the door shuts.
 */
type DevEntry = { email: string; label: string | null };

function hosted(): boolean {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
}

/** The code a hosted door asks for, or null when it asks none (a dev machine). */
function hostedCode(): string | null {
  const code = process.env.DEV_LOGIN_CODE?.trim();
  return code && code.length >= 6 ? code : null;
}

function entries(): DevEntry[] {
  if (hosted() && (appEnv() !== "development" || !hostedCode())) return [];
  const seen = new Set<string>();
  const out: DevEntry[] = [];
  for (const raw of (process.env.DEV_LOGIN_EMAIL ?? "").split(",")) {
    const [e, ...rest] = raw.split("=");
    const email = e.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    const label = rest.join("=").trim();
    out.push({ email, label: label || null });
  }
  return out;
}

export function devLoginEmails(): string[] {
  return entries().map((x) => x.email);
}

/** Each button: its address and what it says. */
export function devLoginButtons(): { email: string; label: string }[] {
  const all = entries();
  return all.map((x) => ({
    email: x.email,
    label: x.label ? `Dev login: ${x.label}` : all.length > 1 ? `Dev login: ${x.email.split("@")[0]}` : "Dev login",
  }));
}

/** Whether a press must carry the code. */
export function devLoginNeedsCode(): boolean {
  return hosted();
}

/** The code typed matches the hosted one; always true on a dev machine. */
export function devLoginCodeOk(typed: unknown): boolean {
  if (!hosted()) return true;
  const want = hostedCode();
  if (!want || typeof typed !== "string") return false;
  const a = createHash("sha256").update(typed.trim()).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** The first address the door opens, or null when it is shut. */
export function devLoginEmail(): string | null {
  return devLoginEmails()[0] ?? null;
}

/**
 * The user the door signs in as: the address asked for when it is on the
 * list, else the first. Null when the door is shut, the address is not on
 * the list, or it names nobody.
 */
export async function devLoginUser(asked?: string | null): Promise<{ id: string; email: string; name: string | null } | null> {
  const emails = devLoginEmails();
  const want = asked?.trim().toLowerCase() || emails[0];
  if (!want || !emails.includes(want)) return null;
  const [u] = await controlDb<{ id: string; email: string; name: string | null }[]>`
    SELECT id, email, name FROM users WHERE email = ${want} AND erased_at IS NULL LIMIT 1
  `;
  return u ?? null;
}

/**
 * The organisation it opens on: `DEV_LOGIN_ORG` when that user is active
 * there, else the one they founded, else whichever the console picks.
 */
export async function devLoginOrg(userId: string): Promise<string | null> {
  const org = process.env.DEV_LOGIN_ORG?.trim();
  const pinned = org && /^[0-9a-f-]{36}$/i.test(org) ? org : null;
  const [m] = await controlDb<{ org_id: string }[]>`
    SELECT org_id FROM memberships
    WHERE user_id = ${userId} AND status = 'ACTIVE'
    ORDER BY (org_id::text = ${pinned ?? ""}) DESC, (role = 'ORG_ADMIN') DESC, created_at
    LIMIT 1
  `;
  return m?.org_id ?? null;
}
