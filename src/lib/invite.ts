import { controlDb, withTenant, audit } from "@/lib/db";
import { listOrgRoles } from "@/lib/rbac";
import { roleLabel } from "@/lib/nav";
import {
  checkAddress,
  checkGrant,
  inviteMessage,
  normaliseEmail,
  type GateResult,
} from "@/lib/invite-rules";
import { targetNode } from "@/lib/scope-nodes";
import { personalAccountsAllowed } from "@/lib/work-account";
import { FOUNDING_ROLE, type ScopeKind } from "@/lib/roles";

/**
 * Gate 3, and the write.
 *
 * An invite creates a MEMBERSHIP, not a user. If the address names nobody, a
 * shell `users` row is created carrying only the address, and the identity
 * provider fills in the rest on first sign-in: `upsertIdentity` already does
 * `ON CONFLICT (email) DO UPDATE`, so the shell and the real account converge
 * on one row rather than racing to create two.
 *
 * Accepting is an UPDATE from INVITED to ACTIVE. There is no redemption
 * route, so there is nothing to expire and nothing to leak.
 */

export type Invite = {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
  roleLabel: string;
  invitedAt: string;
  invitedByName: string | null;
  /** Where the membership will sit once they sign in. */
  scopeName: string;
  scopeKind: ScopeKind;
  scopePath: string;
  /** Whole days since the invite was sent. Staleness is shown, not enforced. */
  ageDays: number;
};

export type InviteOutcome =
  | {
      ok: true;
      email: string;
      roleLabel: string;
      scopeName: string;
      scopePath: string;
      message: string;
      warning: string | null;
      reinvited: boolean;
    }
  | { ok: false; code: string; message: string };

/** Pending invites for the current tenant, newest last. */
export async function listInvites(orgId: string): Promise<Invite[]> {
  const roles = await listOrgRoles(orgId);
  const labelOf = (k: string) => roles.find((r) => r.key === k)?.label ?? roleLabel(k);

  return withTenant(orgId, async (sql) => {
    const rows = await sql<
      {
        id: string;
        user_id: string;
        email: string;
        name: string | null;
        role: string;
        invited_at: Date | null;
        created_at: Date;
        inviter: string | null;
        scope_name: string;
        scope_kind: ScopeKind;
        scope_path: string;
      }[]
    >`
      SELECT m.id, m.user_id, u.email::text AS email, u.name, m.role,
             m.invited_at, m.created_at,
             inviter.name AS inviter,
             s.name AS scope_name, s.kind AS scope_kind, s.path::text AS scope_path
      FROM memberships m
      JOIN users u          ON u.id = m.user_id
      JOIN scope_nodes s    ON s.id = m.scope_node_id
      LEFT JOIN users inviter ON inviter.id = m.invited_by
      -- A person added by phone has no address; the Add by phone card lists them.
      WHERE m.org_id = ${orgId} AND m.status = 'INVITED' AND u.email IS NOT NULL
      ORDER BY m.created_at ASC
    `;

    const now = Date.now();
    return rows.map((r) => {
      const at = r.invited_at ?? r.created_at;
      return {
        membershipId: r.id,
        userId: r.user_id,
        email: r.email,
        name: r.name,
        role: r.role,
        roleLabel: labelOf(r.role),
        invitedAt: at.toISOString(),
        invitedByName: r.inviter,
        scopeName: r.scope_name,
        scopeKind: r.scope_kind,
        scopePath: r.scope_path,
        ageDays: Math.floor((now - at.getTime()) / 86_400_000),
      };
    });
  });
}

/**
 * Run every gate and, if they all pass, write the membership.
 *
 * `inviterScopes` are the paths where the actor holds `member:invite`, and
 * `inviterHeldAt` what they hold at any node, so the role can be measured
 * against the place it lands. Both come from the resolved viewer, never from
 * the form.
 */
export async function createInvite(opts: {
  orgId: string;
  orgName: string;
  orgPrimaryDomain: string | null;
  actorUserId: string;
  actorName: string | null;
  inviterScopes: readonly string[];
  inviterHeldAt: (path: string) => ReadonlySet<string>;
  email: string;
  roleKey: string;
  /**
   * Where the membership lands. An id from a form, never trusted: it is read
   * back inside the tenant below, and an id naming nothing here is refused.
   * Empty means the organisation root, which is what a screen with no picker
   * on it and a spreadsheet row that named no place both mean.
   */
  scopeNodeId?: string | null;
  signInUrl: string;
}): Promise<InviteOutcome> {
  const email = normaliseEmail(opts.email);

  const roles = await listOrgRoles(opts.orgId);
  const role = roles.find((r) => r.key === opts.roleKey);
  if (!role) {
    return { ok: false, code: "ROLE_UNKNOWN", message: "That role no longer exists." };
  }

  // Half of "never trust a node id from the form": this read is scoped to the
  // tenant, so an id belonging to somebody else's tree resolves to nothing.
  // The other half is containment, which checkGrant does next.
  const target = await targetNode(opts.orgId, opts.scopeNodeId);
  if (!target) {
    return {
      ok: false,
      code: "NODE_UNKNOWN",
      message: "That is not a place in this organisation.",
    };
  }

  const gate1 = checkGrant({
    inviterScopes: opts.inviterScopes,
    inviterHeld: opts.inviterHeldAt(target.path),
    role,
    target,
  });
  if (!gate1.ok) return gate1;

  const gate2 = checkAddress({
    email,
    orgPrimaryDomain: opts.orgPrimaryDomain,
    role: { key: role.key },
    personalAdmin: personalAccountsAllowed(),
  });
  if (!gate2.ok) return gate2;

  const warning = firstWarning(gate1, gate2);

  // --- Gate 3, and the write, in one transaction ---------------------------
  //
  // The control connection is correct here and only here: creating a shell
  // `users` row is a control-plane act, because that person has no tenant
  // context yet. The membership write alongside it is scoped by org_id in the
  // statement itself.
  let outcome: InviteOutcome;
  try {
    outcome = await controlDb.begin(async (tx) => {
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM users WHERE email = ${email} LIMIT 1
      `;

      const userId =
        existing?.id ??
        (
          await tx<{ id: string }[]>`
            INSERT INTO users (email, email_domain)
            VALUES (${email}, ${email.slice(email.lastIndexOf("@") + 1)})
            RETURNING id
          `
        )[0].id;

      // Keyed on the NODE, not just the person. Somebody already on the team
      // at the organisation may still be given Site Team on Tower C: that is
      // a second grant at a second place, not a duplicate. Only a second
      // invite to the SAME place is one attempt happening twice.
      const [live] = await tx<{ id: string; status: string; role: string }[]>`
        SELECT id, status, role FROM memberships
        WHERE user_id = ${userId} AND org_id = ${opts.orgId}
          AND scope_node_id = ${target.id}
          AND status <> 'REVOKED'
        ORDER BY (status = 'ACTIVE') DESC
        LIMIT 1
      `;

      if (live?.status === "ACTIVE") {
        return {
          ok: false as const,
          code: "ALREADY_MEMBER",
          message:
            target.kind === "ORG"
              ? `${email} is already on the team.`
              : `${email} is already on the team at ${target.name}.`,
        };
      }

      let reinvited = false;

      if (live?.status === "INVITED") {
        // One row per person per place, not one per attempt. Re-inviting with
        // a different role changes the role rather than leaving two invites
        // that disagree about what this person is.
        await tx`
          UPDATE memberships
          SET role = ${role.key}, invited_by = ${opts.actorUserId}, invited_at = now()
          WHERE id = ${live.id}
        `;
        reinvited = true;
      } else {
        await tx`
          INSERT INTO memberships (user_id, org_id, scope_node_id, role, status,
                                   invited_by, invited_at)
          VALUES (${userId}, ${opts.orgId}, ${target.id}, ${role.key}, 'INVITED',
                  ${opts.actorUserId}, now())
        `;
      }

      // A pending request to join is answered by the invite. The admin acted;
      // leaving the request open would ask them to act again.
      await tx`
        UPDATE org_join_requests
        SET status = 'APPROVED', decided_by = ${opts.actorUserId}, decided_at = now()
        WHERE org_id = ${opts.orgId} AND user_id = ${userId} AND status = 'PENDING'
      `;

      return {
        ok: true as const,
        email,
        roleLabel: role.label,
        scopeName: target.name,
        scopePath: target.path,
        reinvited,
        warning,
        message: inviteMessage({
          orgName: opts.orgName,
          roleLabel: role.label,
          // The root is the organisation itself, and "as Sales Head at
          // BillBay, at BillBay" reads like a mistake.
          place: target.kind === "ORG" ? null : target.name,
          inviterName: opts.actorName,
          signInUrl: opts.signInUrl,
        }),
      };
    });
  } catch {
    return {
      ok: false,
      code: "WRITE_FAILED",
      message: "Could not create that invite. Try again.",
    };
  }

  if (outcome.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "membership.invited",
      targetType: "domain",
      targetId: email.slice(email.lastIndexOf("@") + 1),
      // The path, not the node id: an audit row read two years later should
      // say where somebody was put without needing a join to find out.
      metadata: {
        role: role.key,
        reinvited: outcome.reinvited,
        scope: target.path,
        scope_kind: target.kind,
      },
    });
  }

  return outcome;
}

/** Withdraw an invite that has not been accepted. */
export async function revokeInvite(opts: {
  orgId: string;
  actorUserId: string;
  membershipId: string;
}): Promise<boolean> {
  const done = await withTenant(opts.orgId, async (sql) => {
    const res = await sql`
      UPDATE memberships
      SET status = 'REVOKED', revoked_at = now()
      WHERE id = ${opts.membershipId} AND org_id = ${opts.orgId}
        AND status = 'INVITED'
    `;
    return res.count > 0;
  });

  if (done) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "membership.invite_revoked",
      targetType: "membership",
      targetId: opts.membershipId,
      metadata: {},
    });
  }
  return done;
}

function firstWarning(...results: GateResult[]): string | null {
  for (const r of results) if (r.ok && r.warning) return r.warning;
  return null;
}

export { claimInvites, hasStandingAccess } from "@/lib/invite-claim";
export { FOUNDING_ROLE };
