import { audit, controlDb, withTenant } from "./db/index.ts";
import type { Authz } from "./rbac-rules.ts";
import { missingToGrant } from "./rbac-rules.ts";
import { checkGrant } from "./invite-rules.ts";
import { phoneHash } from "./otp-rules.ts";
import { PHONE_INVITE_ROLE, PHONE_INVITE_SHAPE, mayInviteByPhone, readPhoneInvite } from "./partner-team-rules.ts";

/**
 * A channel partner firm's owner adding its own people by phone, from the
 * console's Team page. The rules are `partner-team-rules.ts`.
 *
 * The person is a `users` row known by that phone, made on the control
 * connection as the partner bot makes one (the user table is global and the
 * person has no tenant yet), carrying the name the owner typed and no proof
 * of the number. The invite is an INVITED membership at the firm's root,
 * written inside the firm's own tenant. Signing in with the phone and the
 * code sent to it proves the number and claims the invite
 * (`finishPhoneSignIn()`). Removing ends the membership in this firm only.
 *
 * Relative imports: `check:otp` loads this from source.
 */

export type PhonePerson = { membershipId: string; userId: string; name: string | null; phone: string | null; status: string; invitedAt: string | null };

export type TeamOutcome = { ok: true; message: string; membershipId?: string } | { ok: false; message: string };

/** The organisation's own kind, read inside its tenant, never taken from a caller. */
async function orgTypeOf(orgId: string): Promise<string> {
  const [r] = await withTenant(orgId, (sql) => sql<{ type: string }[]>`SELECT type FROM orgs WHERE id = ${orgId}`);
  return r?.type ?? "";
}

async function rootOf(orgId: string): Promise<{ id: string; path: string; name: string } | null> {
  const [r] = await withTenant(orgId, (sql) => sql<{ id: string; path: string; name: string }[]>`
    SELECT id, path::text AS path, name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' ORDER BY created_at LIMIT 1`);
  return r ?? null;
}

/** The firm's people known only by a phone, invited or signed in, for the Team page. */
export async function listPhonePeople(orgId: string): Promise<PhonePerson[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; user_id: string; name: string | null; phone: string | null; status: string; invited_at: Date | null }[]>`
    SELECT m.id, m.user_id, u.name, u.phone, m.status, m.invited_at
    FROM memberships m JOIN users u ON u.id = m.user_id JOIN scope_nodes s ON s.id = m.scope_node_id
    WHERE m.org_id = ${orgId} AND m.status IN ('INVITED', 'ACTIVE') AND m.role = ${PHONE_INVITE_ROLE}
      AND s.kind = 'ORG' AND u.email IS NULL
    ORDER BY (m.status = 'INVITED') DESC, u.name NULLS LAST`);
  return rows.map((r) => ({ membershipId: r.id, userId: r.user_id, name: r.name, phone: r.phone, status: r.status, invitedAt: r.invited_at?.toISOString() ?? null }));
}

/**
 * Add a person to a channel partner firm by their phone. Asked in order: the
 * firm is a channel partner, the name and number read, the giving rule at
 * the firm's root, and then who the number already is.
 */
export async function invitePhonePerson(o: {
  orgId: string;
  actorUserId: string;
  authz: Pick<Authz, "scopesFor" | "heldAt">;
  name: string;
  phone: string;
}): Promise<TeamOutcome> {
  if (!mayInviteByPhone(await orgTypeOf(o.orgId))) return { ok: false, message: "Only a channel partner firm adds people by phone." };
  const read = readPhoneInvite({ name: o.name, phone: o.phone });
  if (!read.ok) return read;
  const root = await rootOf(o.orgId);
  if (!root) return { ok: false, message: "This organisation has no root to add people at." };
  const gate = checkGrant({
    inviterScopes: o.authz.scopesFor("member:invite"),
    inviterHeld: o.authz.heldAt(root.path),
    role: { ...PHONE_INVITE_SHAPE, permissions: [...PHONE_INVITE_SHAPE.permissions] },
    target: { path: root.path, kind: "ORG", name: root.name },
  });
  if (!gate.ok) return { ok: false, message: gate.message };

  // The user is global: found by the number, or made carrying only it and the name typed.
  const [known] = await controlDb<{ id: string; erased: boolean }[]>`
    SELECT id, erased_at IS NOT NULL AS erased FROM users WHERE phone = ${read.phone} LIMIT 1`;
  if (known?.erased) return { ok: false, message: "That number cannot be added." };
  let userId = known?.id ?? null;
  if (!userId) {
    const [made] = await controlDb<{ id: string }[]>`
      INSERT INTO users (phone, name) VALUES (${read.phone}, ${read.name})
      ON CONFLICT (phone) DO NOTHING RETURNING id`;
    userId = made?.id ?? (await controlDb<{ id: string }[]>`SELECT id FROM users WHERE phone = ${read.phone}`)[0]?.id ?? null;
  }
  if (!userId) return { ok: false, message: "That number could not be added. Try again." };
  if (userId === o.actorUserId) return { ok: false, message: "That is your own number." };

  const out = await withTenant(o.orgId, async (sql): Promise<TeamOutcome & { again?: boolean }> => {
    const [live] = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM memberships
      WHERE org_id = ${o.orgId} AND user_id = ${userId} AND scope_node_id = ${root.id} AND status <> 'REVOKED'
      ORDER BY (status = 'ACTIVE') DESC LIMIT 1`;
    if (live?.status === "ACTIVE") return { ok: false, message: `${read.name} is already on the team.` };
    if (live) {
      await sql`UPDATE memberships SET invited_by = ${o.actorUserId}, invited_at = now() WHERE org_id = ${o.orgId} AND id = ${live.id}`;
      return { ok: true, message: "", membershipId: live.id, again: true };
    }
    const [m] = await sql<{ id: string }[]>`
      INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, invited_by, invited_at)
      VALUES (${userId}, ${o.orgId}, ${root.id}, ${PHONE_INVITE_ROLE}, 'INVITED', ${o.actorUserId}, now())
      RETURNING id`;
    return { ok: true, message: "", membershipId: m.id };
  });
  if (!out.ok) return out;
  await audit({
    orgId: o.orgId,
    actorUserId: o.actorUserId,
    action: "member.invited_phone",
    targetType: "user",
    targetId: userId,
    metadata: { membership_id: out.membershipId, role: PHONE_INVITE_ROLE, phone: phoneHash(read.phone), again: !!out.again },
  });
  return {
    ok: true,
    membershipId: out.membershipId,
    message: `${read.name} is added. They sign in with their phone and a code on WhatsApp.`,
  };
}

/**
 * Take a person added by phone off the firm: the invite withdrawn, or the
 * membership ended. `member:remove` at the firm's root and the giving rule,
 * never oneself, and never anybody but a phone person here.
 */
export async function removePhonePerson(o: {
  orgId: string;
  actorUserId: string;
  authz: Pick<Authz, "canAt" | "heldAt">;
  membershipId: string;
}): Promise<TeamOutcome> {
  if (!mayInviteByPhone(await orgTypeOf(o.orgId))) return { ok: false, message: "Only a channel partner firm adds people by phone." };
  if (!/^[0-9a-f-]{36}$/i.test(o.membershipId)) return { ok: false, message: "That person is no longer on the team." };
  const [m] = await withTenant(o.orgId, (sql) => sql<{ user_id: string; path: string; status: string }[]>`
    SELECT m.user_id, s.path::text AS path, m.status
    FROM memberships m JOIN scope_nodes s ON s.id = m.scope_node_id JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${o.orgId} AND m.id = ${o.membershipId} AND m.role = ${PHONE_INVITE_ROLE}
      AND m.status IN ('INVITED', 'ACTIVE') AND s.kind = 'ORG' AND u.email IS NULL`);
  if (!m) return { ok: false, message: "That person is no longer on the team." };
  if (m.user_id === o.actorUserId) return { ok: false, message: "You cannot remove yourself." };
  if (!o.authz.canAt("member:remove", m.path)) return { ok: false, message: "Your role cannot remove people here." };
  if (missingToGrant(o.authz.heldAt(m.path), PHONE_INVITE_SHAPE.permissions).length) {
    return { ok: false, message: "You can only remove people whose access you hold yourself." };
  }
  const done = await withTenant(o.orgId, (sql) => sql`
    UPDATE memberships SET status = 'REVOKED', revoked_at = now()
    WHERE org_id = ${o.orgId} AND id = ${o.membershipId} AND status IN ('INVITED', 'ACTIVE')`);
  if (!done.count) return { ok: false, message: "That person was changed by someone else just now. Look again." };
  await audit({
    orgId: o.orgId,
    actorUserId: o.actorUserId,
    action: m.status === "INVITED" ? "member.invite_withdrawn" : "membership.revoked",
    targetType: "user",
    targetId: m.user_id,
    metadata: { membership_id: o.membershipId, role: PHONE_INVITE_ROLE, via: "phone" },
  });
  return { ok: true, message: m.status === "INVITED" ? "Invite withdrawn." : "Removed from the team." };
}
