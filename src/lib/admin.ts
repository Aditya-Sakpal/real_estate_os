import { withTenant, audit } from "@/lib/db";
import { checkAddress } from "@/lib/invite-rules";
import { personalAccountsAllowed } from "@/lib/work-account";
import { FOUNDING_ROLE } from "@/lib/roles";

/**
 * Handing over the founding role.
 *
 * The first person to sign up is often the agency's account manager, not the
 * developer, so the role has to be movable. Moving it badly leaves a tenant
 * nobody can administer, and there is no self-service fix for that: recovery
 * means platform impersonation, which is deliberately time-boxed and audited
 * rather than routine.
 *
 * Three operations, and the rules they share:
 *
 *   promote   make an active member an admin as well
 *   transfer  promote them and step down in the same breath
 *   demote    take the role back off somebody
 *
 * Two invariants hold across all three. **Only an admin moves the role**,
 * which is the same rank rule that stops an invite minting an administrator.
 * And **an organisation never reaches zero admins**, which is enforced by a
 * deferred constraint trigger in 0007_last_admin.sql rather than here: a
 * check in this file protects the three paths that go through this file, and
 * the trigger protects the ones that do not.
 *
 * The work-account rule is the invite's rule, reused unchanged. An admin
 * invites, approves and eventually approves payouts, and a personal mailbox
 * cannot be disabled by an IT team when that person leaves.
 */

export type AdminOutcome =
  | { ok: true; targetName: string; targetEmail: string }
  | { ok: false; code: string; message: string };

type Target = {
  membership_id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  status: string;
};

/** Nobody but an admin moves the role, and nobody moves it onto themselves. */
function guardActor(opts: {
  actorIsFounding: boolean;
  actorUserId: string;
  target: Target | undefined;
}): AdminOutcome | null {
  if (!opts.actorIsFounding) {
    return {
      ok: false,
      code: "NOT_ADMIN",
      message: "Only an org admin can change who else is one.",
    };
  }
  if (!opts.target) {
    return { ok: false, code: "NOT_FOUND", message: "That person is not on this team." };
  }
  if (opts.target.status !== "ACTIVE") {
    return {
      ok: false,
      code: "NOT_ACTIVE",
      message:
        "They have not signed in yet. An invited person becomes an admin once they accept, not before.",
    };
  }
  return null;
}

async function loadTarget(orgId: string, membershipId: string): Promise<Target | undefined> {
  return withTenant(orgId, async (sql) => {
    const [row] = await sql<Target[]>`
      SELECT m.id AS membership_id, m.user_id, u.email::text AS email, u.name,
             m.role, m.status
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${orgId} AND m.id = ${membershipId}
      LIMIT 1
    `;
    return row;
  });
}

function describe(t: Target) {
  return { targetName: t.name ?? t.email ?? "that person", targetEmail: t.email ?? "" };
}

/** Make an active member an admin, alongside whoever already is one. */
export async function promoteToAdmin(opts: {
  orgId: string;
  actorUserId: string;
  actorIsFounding: boolean;
  orgPrimaryDomain: string | null;
  membershipId: string;
}): Promise<AdminOutcome> {
  const target = await loadTarget(opts.orgId, opts.membershipId);
  const refusal = guardActor({ ...opts, target });
  if (refusal) return refusal;
  const t = target!;

  if (t.role === FOUNDING_ROLE) {
    return { ok: false, code: "ALREADY_ADMIN", message: `${describe(t).targetName} is already an admin.` };
  }

  const gate = checkAddress({
    email: t.email ?? "",
    orgPrimaryDomain: opts.orgPrimaryDomain,
    role: { key: FOUNDING_ROLE },
    personalAdmin: personalAccountsAllowed(),
  });
  if (!gate.ok) return { ok: false, code: gate.code, message: gate.message };

  await withTenant(opts.orgId, async (sql) => {
    await sql`
      UPDATE memberships SET role = ${FOUNDING_ROLE}
      WHERE id = ${opts.membershipId} AND org_id = ${opts.orgId} AND status = 'ACTIVE'
    `;
  });

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "membership.promoted",
    targetType: "user",
    targetId: t.user_id,
    metadata: { from: t.role, to: FOUNDING_ROLE },
  });

  return { ok: true, ...describe(t) };
}

/**
 * Promote someone and step down, in one transaction.
 *
 * Written as demote-then-promote deliberately, because the deferred trigger
 * only inspects the state at commit. If it ever stops being deferred, this is
 * the order that fails loudly rather than the order that happens to pass.
 */
export async function transferAdmin(opts: {
  orgId: string;
  actorUserId: string;
  actorIsFounding: boolean;
  orgPrimaryDomain: string | null;
  membershipId: string;
  /** What the outgoing admin becomes. They stay on the team. */
  ownNewRole: string;
}): Promise<AdminOutcome> {
  const target = await loadTarget(opts.orgId, opts.membershipId);
  const refusal = guardActor({ ...opts, target });
  if (refusal) return refusal;
  const t = target!;

  if (t.user_id === opts.actorUserId) {
    return {
      ok: false,
      code: "SELF",
      message: "You cannot hand the role to yourself.",
    };
  }
  if (opts.ownNewRole === FOUNDING_ROLE) {
    return {
      ok: false,
      code: "NOT_A_STEP_DOWN",
      message: "Pick the role you are stepping down into.",
    };
  }

  const gate = checkAddress({
    email: t.email ?? "",
    orgPrimaryDomain: opts.orgPrimaryDomain,
    role: { key: FOUNDING_ROLE },
    personalAdmin: personalAccountsAllowed(),
  });
  if (!gate.ok) return { ok: false, code: gate.code, message: gate.message };

  try {
    await withTenant(opts.orgId, async (sql) => {
      await sql`
        UPDATE memberships SET role = ${opts.ownNewRole}
        WHERE org_id = ${opts.orgId} AND user_id = ${opts.actorUserId}
          AND role = ${FOUNDING_ROLE} AND status = 'ACTIVE'
      `;
      await sql`
        UPDATE memberships SET role = ${FOUNDING_ROLE}
        WHERE id = ${opts.membershipId} AND org_id = ${opts.orgId} AND status = 'ACTIVE'
      `;
    });
  } catch {
    // The trigger fires at commit, so a refusal arrives here rather than at
    // either statement. Nothing was written.
    return {
      ok: false,
      code: "WOULD_ORPHAN",
      message: "That would leave this organisation without an admin.",
    };
  }

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "membership.admin_transferred",
    targetType: "user",
    targetId: t.user_id,
    metadata: { stepped_down_to: opts.ownNewRole, from: t.role },
  });

  return { ok: true, ...describe(t) };
}

/** Take the role back off somebody. The trigger refuses the last one. */
export async function demoteAdmin(opts: {
  orgId: string;
  actorUserId: string;
  actorIsFounding: boolean;
  membershipId: string;
  newRole: string;
}): Promise<AdminOutcome> {
  const target = await loadTarget(opts.orgId, opts.membershipId);
  const refusal = guardActor({ ...opts, target });
  if (refusal) return refusal;
  const t = target!;

  if (t.role !== FOUNDING_ROLE) {
    return { ok: false, code: "NOT_ADMIN_ALREADY", message: "They are not an admin." };
  }
  if (opts.newRole === FOUNDING_ROLE) {
    return { ok: false, code: "NO_CHANGE", message: "Pick the role they move into." };
  }

  try {
    await withTenant(opts.orgId, async (sql) => {
      await sql`
        UPDATE memberships SET role = ${opts.newRole}
        WHERE id = ${opts.membershipId} AND org_id = ${opts.orgId}
          AND role = ${FOUNDING_ROLE} AND status = 'ACTIVE'
      `;
    });
  } catch {
    return {
      ok: false,
      code: "LAST_ADMIN",
      message:
        "This is the only admin. Promote somebody else first, then take the role off this account.",
    };
  }

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "membership.demoted",
    targetType: "user",
    targetId: t.user_id,
    metadata: { from: FOUNDING_ROLE, to: opts.newRole, self: t.user_id === opts.actorUserId },
  });

  return { ok: true, ...describe(t) };
}
