import { audit, controlDb, withTenant } from "./db/index.ts";
import { startChallenge, verifyChallenge } from "./otp.ts";
import { phoneHash, readCode } from "./otp-rules.ts";
import { normalisePhone } from "./calling-rules.ts";
import { maskPhone } from "./mask-rules.ts";
import { buildAuthz, mergeRoles, type Authz, type Grant, type RoleRow } from "./rbac-rules.ts";
import type { ScopeKind } from "./roles.ts";
import {
  SIGN_IN_FLOOR_MS,
  SIGN_IN_REFUSED,
  SIGN_IN_SENT,
  PHONE_ORG_TYPES,
  phoneAuthz,
  phoneSignInOrg,
  stepUpAction,
  stepUpCovers,
  stepUpWords,
  withStepUp,
  type PhoneCandidate,
  type PhoneMembership,
} from "./phone-session-rules.ts";

/**
 * Signing a channel partner's person in with their phone, what that session
 * may do, and the fresh code a sensitive action asks for. The rules are
 * `phone-session-rules.ts`; the code itself is `otp.ts`.
 *
 * Sign-in reads users and memberships on the control connection, as every
 * sign-in does: nobody has a tenant yet. What a signed-in phone may do is
 * read inside the firm's tenant, like any other person's roles.
 *
 * Relative imports: `check:otp` loads this from source.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every row a proved number could sign in as, one per membership. */
async function candidates(phone: string): Promise<PhoneCandidate[]> {
  const rows = await controlDb<{
    user_id: string; erased: boolean; verified: boolean; status: string; org_id: string; type: string; org_status: string;
  }[]>`
    SELECT u.id AS user_id, u.erased_at IS NOT NULL AS erased, u.phone_verified_at IS NOT NULL AS verified,
           m.status, o.id AS org_id, o.type, o.status AS org_status
    FROM users u
    JOIN memberships m ON m.user_id = u.id
    JOIN orgs o ON o.id = m.org_id
    WHERE u.phone = ${phone}
    ORDER BY (m.role = 'CP_OWNER') DESC, m.created_at`;
  return rows.map((r) => ({
    userId: r.user_id,
    erased: r.erased,
    phoneVerified: r.verified,
    membershipStatus: r.status,
    orgId: r.org_id,
    orgType: r.type,
    orgStatus: r.org_status,
  }));
}

export type PhoneStart = { ok: true; challengeId: string; message: string } | { ok: false; message: string };

/**
 * "Send me a code." The same answer, in at least the same time, whether or
 * not the number may sign in: a number nobody may sign in with gets a
 * challenge that is counted by every limit and sent to nobody. Only a limit
 * or a number that is not a number is ever refused, and those answer the
 * same for any number too.
 */
export async function startPhoneSignIn(opts: {
  raw: string;
  ip?: string | null;
  now?: Date;
  /** How long the answer takes at least. The checks pass 0. */
  floorMs?: number;
}): Promise<PhoneStart> {
  const began = Date.now();
  const floor = opts.floorMs ?? SIGN_IN_FLOOR_MS;
  const pad = async <T>(v: T): Promise<T> => {
    const left = floor - (Date.now() - began);
    if (left > 0) await sleep(left);
    return v;
  };

  const phone = normalisePhone(String(opts.raw ?? ""));
  if (!phone) return pad({ ok: false, message: "That number does not look right. Use 10 digits, or add the country code." });

  const who = phoneSignInOrg(await candidates(phone));
  const started = await startChallenge({
    purpose: "SIGN_IN",
    phone,
    // Nothing on the row says whether the number could sign in: the person
    // is looked up again once the code comes back.
    userId: null,
    orgId: null,
    ip: opts.ip ?? null,
    now: opts.now,
    deliver: who !== null,
  });
  // A limit answers the same for any number, because an unknown number's
  // challenges are counted like a real one's.
  if (!started.ok) return pad({ ok: false, message: started.message });
  return pad({ ok: true, challengeId: started.challengeId, message: SIGN_IN_SENT });
}

export type PhoneSignedIn = { ok: true; userId: string; orgId: string; name: string | null } | { ok: false; message: string };

/**
 * The code came back. The number is looked up again, because a membership
 * can end in the five minutes a code lives; a code for a number nobody may
 * sign in with was never told to anybody, so it cannot get this far.
 */
export async function finishPhoneSignIn(opts: {
  challengeId: string;
  raw: string;
  code: string;
  now?: Date;
}): Promise<PhoneSignedIn> {
  const phone = normalisePhone(String(opts.raw ?? ""));
  const code = readCode(opts.code);
  if (!phone || !code) return { ok: false, message: SIGN_IN_REFUSED };

  const v = await verifyChallenge({ challengeId: String(opts.challengeId ?? ""), phone, code, purpose: "SIGN_IN", now: opts.now });
  if (!v.ok) return { ok: false, message: v.message };

  const who = phoneSignInOrg(await candidates(phone));
  if (!who) return { ok: false, message: SIGN_IN_REFUSED };

  // The code proved the number: a firm's invite by phone is claimed now, in
  // channel partner firms only, and the number marked proved.
  const [u] = await controlDb<{ name: string | null }[]>`
    UPDATE users SET last_login_at = now(), phone_verified_at = coalesce(phone_verified_at, now())
    WHERE id = ${who.userId} RETURNING name`;
  const claimed = await controlDb<{ id: string; org_id: string }[]>`
    UPDATE memberships m SET status = 'ACTIVE', accepted_at = now()
    FROM orgs o
    WHERE m.user_id = ${who.userId} AND m.status = 'INVITED' AND o.id = m.org_id AND o.type = ANY(${[...PHONE_ORG_TYPES]})
    RETURNING m.id, m.org_id`;
  for (const c of claimed) {
    await audit({
      orgId: c.org_id,
      actorUserId: who.userId,
      action: "member.invite_claimed",
      targetType: "user",
      targetId: who.userId,
      metadata: { membership_id: c.id, method: "phone", phone: phoneHash(phone) },
    });
  }
  await audit({
    orgId: who.orgId,
    actorUserId: who.userId,
    action: "auth.signin_phone",
    targetType: "user",
    targetId: who.userId,
    metadata: { method: "phone", phone: phoneHash(phone) },
  });
  return { ok: true, userId: who.userId, orgId: who.orgId, name: u?.name ?? null };
}

// ---------------------------------------------------------------------------
// What a phone session may do
// ---------------------------------------------------------------------------

/**
 * A phone session's authz in its firm: every live membership cut to the
 * tier, with what a fresh code would open kept apart. Read in the tenant,
 * the way `resolveAuthz()` reads anybody's.
 */
export async function resolvePhoneAuthz(userId: string, orgId: string): Promise<{ authz: Authz; stepUp: Grant[] }> {
  const { roles, rows } = await withTenant(orgId, async (sql) => ({
    roles: await sql<RoleRow[]>`
      SELECT key, label, description, min_kind, can_delegate, source, permissions
      FROM org_roles WHERE org_id = ${orgId}`,
    rows: await sql<{ role: string; scope_node_id: string; path: string; kind: ScopeKind; name: string }[]>`
      SELECT m.role, m.scope_node_id, s.path::text AS path, s.kind, s.name
      FROM memberships m JOIN scope_nodes s ON s.id = m.scope_node_id
      WHERE m.user_id = ${userId} AND m.org_id = ${orgId} AND m.status = 'ACTIVE'`,
  }));
  const byKey = new Map(mergeRoles(roles).map((r) => [r.key, r]));
  const ms: PhoneMembership[] = rows.map((r) => {
    const role = byKey.get(r.role);
    return {
      role: r.role,
      roleLabel: role?.label ?? (r.role === "CP_OWNER" ? "Principal" : "Agent"),
      scopeNodeId: r.scope_node_id,
      scopePath: r.path,
      scopeKind: r.kind,
      scopeName: r.name,
      rolePermissions: role ? new Set(role.permissions) : null,
    };
  });
  return phoneAuthz(ms);
}

// ---------------------------------------------------------------------------
// A fresh code for one action
// ---------------------------------------------------------------------------

async function ownPhone(userId: string): Promise<string | null> {
  const [u] = await controlDb<{ phone: string | null }[]>`
    SELECT phone FROM users WHERE id = ${userId} AND phone_verified_at IS NOT NULL AND erased_at IS NULL`;
  return u?.phone ?? null;
}

export type StepUpStart = { ok: true; challengeId: string; message: string } | { ok: false; message: string };

/**
 * Send a code for one action on one thing to the person's own proved phone.
 * Refused, before anything is sent, when no membership would reach the key
 * there even with a code.
 */
export async function startStepUp(opts: {
  userId: string;
  orgId: string;
  stepUp: readonly Grant[];
  permission: string;
  targetId: string;
  /** Where the thing sits, when it sits somewhere (a lead's tower). */
  path?: string;
  ip?: string | null;
  now?: Date;
}): Promise<StepUpStart> {
  const action = stepUpAction(opts.permission);
  if (!action || !stepUpCovers(opts.stepUp, opts.permission, opts.path)) {
    return { ok: false, message: "Your role cannot do that here." };
  }
  const phone = await ownPhone(opts.userId);
  if (!phone) return { ok: false, message: "Your number is not confirmed. Sign in again." };
  const started = await startChallenge({
    purpose: "STEP_UP",
    phone,
    userId: opts.userId,
    orgId: opts.orgId,
    action,
    targetId: opts.targetId,
    ip: opts.ip ?? null,
    now: opts.now,
  });
  if (!started.ok) return started;
  return {
    ok: true,
    challengeId: started.challengeId,
    message: `To ${stepUpWords(opts.permission)}, enter the code sent on WhatsApp to ${maskPhone(phone)}.`,
  };
}

/**
 * The code for one action came back. Used once: the challenge is spent here,
 * so the same code opens nothing a second time. Returns the grants for that
 * one action, or null.
 */
export async function redeemStepUp(opts: {
  userId: string;
  orgId: string;
  authz: Authz;
  stepUp: readonly Grant[];
  permission: string;
  targetId: string;
  challengeId: string;
  code: string;
  now?: Date;
}): Promise<{ ok: true; authz: Authz } | { ok: false; message: string }> {
  const action = stepUpAction(opts.permission);
  const code = readCode(opts.code);
  if (!action) return { ok: false, message: "Your role cannot do that here." };
  if (!code) return { ok: false, message: "The code is six digits." };
  const phone = await ownPhone(opts.userId);
  if (!phone) return { ok: false, message: "Your number is not confirmed. Sign in again." };

  const v = await verifyChallenge({
    challengeId: String(opts.challengeId ?? ""),
    phone,
    code,
    purpose: "STEP_UP",
    userId: opts.userId,
    action,
    targetId: opts.targetId,
    now: opts.now,
  });
  if (!v.ok) return v;

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "auth.step_up",
    targetType: opts.permission === "lead:export" ? "org" : "lead",
    targetId: opts.targetId,
    metadata: { permission: opts.permission, phone: phoneHash(phone) },
  });
  const grants = withStepUp(opts.authz.grants, opts.stepUp, opts.permission);
  return { ok: true, authz: buildAuthz(grants) };
}

/** The firm a proved number signs into, for the org cookie after sign-in. */
export async function phoneHomeOrg(raw: string): Promise<string | null> {
  const phone = normalisePhone(String(raw ?? ""));
  if (!phone) return null;
  return phoneSignInOrg(await candidates(phone))?.orgId ?? null;
}
