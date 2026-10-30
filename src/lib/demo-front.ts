import { createHash, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { controlDb } from "@/lib/db";

/**
 * A public demo: a proxy in front of the console marks each request with
 * `x-demo-front`, a secret only it and this server hold (`DEMO_FRONT_KEY`, at
 * least 24 characters). A request carrying it gets one thing here: a
 * one-press sign-in as `DEMO_LOGIN_EMAIL`, a user who is a member of the demo
 * organisation and nothing else.
 */
const HEADER = "x-demo-front";

function key(): string | null {
  const k = process.env.DEMO_FRONT_KEY?.trim();
  return k && k.length >= 24 ? k : null;
}

/** Whether this request came through the demo front. */
export async function isDemoFront(): Promise<boolean> {
  const want = key();
  if (!want) return false;
  let got: string | null = null;
  try {
    got = (await headers()).get(HEADER);
  } catch {
    return false;
  }
  if (!got) return false;
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** The demo user, or null when none is set or it names nobody. */
export async function demoUser(): Promise<{ id: string; email: string; name: string | null } | null> {
  const email = process.env.DEMO_LOGIN_EMAIL?.trim().toLowerCase();
  if (!email) return null;
  const [u] = await controlDb<{ id: string; email: string; name: string | null }[]>`
    SELECT id, email, name FROM users WHERE email = ${email} AND erased_at IS NULL LIMIT 1
  `;
  return u ?? null;
}

/** The one organisation the demo user is active in. */
export async function demoOrg(userId: string): Promise<string | null> {
  const [m] = await controlDb<{ org_id: string }[]>`
    SELECT org_id FROM memberships
    WHERE user_id = ${userId} AND status = 'ACTIVE'
    ORDER BY (role = 'ORG_ADMIN') DESC, created_at
    LIMIT 1
  `;
  return m?.org_id ?? null;
}
