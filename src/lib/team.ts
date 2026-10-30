import { withTenant, audit } from "@/lib/db";
import { roleLabel } from "@/lib/nav";
import { listOrgRoles, type Authz } from "@/lib/rbac";
import { checkMemberChange, type RoleShape } from "@/lib/member-rules";
import { isNodeId } from "@/lib/scope-rules";
import { reassignDeparted } from "@/lib/departures";
import { reassignedLine, type Reassigned } from "@/lib/departure-rules";
import type { ScopeKind } from "@/lib/roles";

/**
 * Who is in this organisation, and who is asking to be.
 *
 * Members are ACTIVE only. Someone invited but not yet signed in is not a
 * member of anything yet, and listing them here would overstate the team to
 * an admin checking who can actually see a lead. Invites have their own
 * section, in `invite.ts`.
 *
 * Both reads go through withTenant(), so RLS scopes them. Requesters are
 * visible because migration 0002 extends the users policy to cover a pending
 * join request -- not because this reaches around isolation with the owner
 * connection.
 */

export type Member = {
  membershipId: string;
  userId: string;
  name: string | null;
  email: string;
  role: string;
  roleLabel: string;
  status: string;
  scopeNodeId: string;
  scopePath: string;
  scopeKind: string;
  scopeName: string;
  isYou: boolean;
  joinedAt: string | null;
};

export type JoinRequest = {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  matchedOn: string;
  requestedAt: string;
};

export type Team = {
  members: Member[];
  requests: JoinRequest[];
  adminCount: number;
  /** Whether the viewer may approve requests and add people. */
  canManage: boolean;
  /** Whether the viewer may revoke someone else's membership. */
  canRemove: boolean;
};

export async function loadTeam(
  orgId: string,
  viewerUserId: string,
  authz: Authz,
): Promise<Team> {
  // A tenant may have renamed a role or invented one, so the label on a row
  // comes from the resolved definition, never from the stored key.
  const roles = await listOrgRoles(orgId);
  const labelOf = (key: string) => roles.find((r) => r.key === key)?.label ?? roleLabel(key);

  return withTenant(orgId, async (sql) => {
    const memberRows = await sql<
      {
        membership_id: string;
        user_id: string;
        name: string | null;
        email: string;
        role: string;
        status: string;
        scope_node_id: string;
        path: string;
        kind: string;
        scope_name: string;
        accepted_at: Date | null;
        created_at: Date;
      }[]
    >`
      SELECT m.id   AS membership_id,
             m.user_id,
             u.name,
             u.email::text AS email,
             m.role,
             m.status,
             m.scope_node_id,
             s.path::text  AS path,
             s.kind,
             s.name AS scope_name,
             m.accepted_at,
             m.created_at
      FROM memberships m
      JOIN users u       ON u.id = m.user_id
      JOIN scope_nodes s ON s.id = m.scope_node_id
      WHERE m.org_id = ${orgId} AND m.status = 'ACTIVE'
      ORDER BY (m.role = 'ORG_ADMIN') DESC, u.name NULLS LAST, u.email
    `;

    const requestRows = await sql<
      {
        id: string;
        user_id: string;
        name: string | null;
        email: string;
        matched_on: string;
        created_at: Date;
      }[]
    >`
      SELECT r.id, r.user_id, u.name, u.email::text AS email,
             r.matched_on, r.created_at
      FROM org_join_requests r
      JOIN users u ON u.id = r.user_id
      WHERE r.org_id = ${orgId} AND r.status = 'PENDING'
      ORDER BY r.created_at ASC
    `;

    const members: Member[] = memberRows.map((r) => ({
      membershipId: r.membership_id,
      userId: r.user_id,
      name: r.name,
      email: r.email,
      role: r.role,
      roleLabel: labelOf(r.role),
      status: r.status,
      scopeNodeId: r.scope_node_id,
      scopePath: r.path,
      scopeKind: r.kind,
      scopeName: r.scope_name,
      isYou: r.user_id === viewerUserId,
      joinedAt: (r.accepted_at ?? r.created_at)?.toISOString() ?? null,
    }));

    return {
      members,
      requests: requestRows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        name: r.name,
        email: r.email,
        matchedOn: r.matched_on,
        requestedAt: r.created_at.toISOString(),
      })),
      adminCount: members.filter((m) => m.role === "ORG_ADMIN" && m.status === "ACTIVE").length,
      canManage: authz.can("member:invite"),
      canRemove: authz.can("member:remove"),
    };
  });
}

export type MemberOutcome = { ok: true; message: string } | { ok: false; message: string };

/**
 * Change one membership's role, or end it.
 *
 * One membership, not one person: somebody who is Sales Head for the company
 * and Site Team on Tower C holds two rows, and removing them from the tower
 * leaves the company role alone. The rules are `checkMemberChange()`; the
 * write asks for the role it read, so a change made in another tab since this
 * page loaded is refused rather than overwritten.
 */
export async function changeMember(opts: {
  orgId: string;
  actorUserId: string;
  authz: Authz;
  membershipId: string;
  change: { kind: "ROLE"; roleKey: string } | { kind: "REMOVE" };
}): Promise<MemberOutcome> {
  const { orgId, actorUserId, authz, membershipId, change } = opts;
  const removing = change.kind === "REMOVE";
  // A malformed id raises in a uuid comparison rather than matching nothing.
  if (!isNodeId(membershipId)) return { ok: false, message: "That person is no longer on the team here." };

  const [roles, row] = await Promise.all([
    listOrgRoles(orgId),
    withTenant(orgId, async (sql) => {
      const [r] = await sql<
        {
          user_id: string;
          role: string;
          name: string | null;
          email: string | null;
          path: string;
          kind: ScopeKind;
          scope_name: string;
        }[]
      >`
        SELECT m.user_id, m.role, u.name, u.email::text AS email,
               s.path::text AS path, s.kind, s.name AS scope_name
        FROM memberships m
        JOIN users u       ON u.id = m.user_id
        JOIN scope_nodes s ON s.id = m.scope_node_id
        WHERE m.id = ${membershipId} AND m.org_id = ${orgId} AND m.status = 'ACTIVE'
        LIMIT 1
      `;
      return r;
    }),
  ]);
  if (!row) return { ok: false, message: "That person is no longer on the team here." };

  const who = row.name ?? row.email ?? "That person";
  const node = { path: row.path, kind: row.kind, name: row.scope_name };
  const found = roles.find((r) => r.key === row.role);
  // A role deleted since it was given grants nothing, so it has nothing to
  // protect either: anybody who could give the new role may move them off it.
  const current: RoleShape = found ?? { key: row.role, label: roleLabel(row.role), minKind: "ORG", permissions: [] };

  const next = change.kind === "ROLE" ? roles.find((r) => r.key === change.roleKey) : undefined;
  if (change.kind === "ROLE" && !next) return { ok: false, message: "That role no longer exists." };

  const gate = checkMemberChange({
    actorScopes: authz.scopesFor(removing ? "member:remove" : "member:role"),
    actorHeld: authz.heldAt(node.path),
    isSelf: row.user_id === actorUserId,
    current,
    node,
    change: next ? { kind: "ROLE", next } : { kind: "REMOVE" },
  });
  if (!gate.ok) return { ok: false, message: gate.message };

  let written: boolean;
  let moved = null as Reassigned | null;
  try {
    written = await withTenant(orgId, async (sql) => {
      const res = next
        ? await sql`
            UPDATE memberships SET role = ${next.key}
            WHERE id = ${membershipId} AND org_id = ${orgId}
              AND status = 'ACTIVE' AND role = ${current.key}
          `
        : await sql`
            UPDATE memberships SET status = 'REVOKED', revoked_at = now()
            WHERE id = ${membershipId} AND org_id = ${orgId}
              AND status = 'ACTIVE' AND role = ${current.key}
          `;
      if (res.count === 0) return false;
      // What they can no longer open moves to somebody who can, in this same
      // transaction, so a removal the last-admin rule refuses moves nothing.
      moved = await reassignDeparted(sql, { orgId, userId: row.user_id, name: row.name ?? row.email ?? "", actorUserId });
      return true;
    });
  } catch (e) {
    // memberships_unique_live: they already hold the new role at that node.
    if ((e as { code?: string }).code === "23505" && next) {
      return { ok: false, message: `${who} is already ${next.label} there.` };
    }
    throw e;
  }
  if (!written) return { ok: false, message: `${who} was changed by someone else just now. Look again.` };

  const place = node.kind === "ORG" ? "" : ` on ${node.name}`;
  await audit({
    orgId,
    actorUserId,
    action: next ? "membership.role_changed" : "membership.revoked",
    targetType: "user",
    targetId: row.user_id,
    metadata: next
      ? { membership_id: membershipId, from: current.key, to: next.key, scope: node.path, scope_kind: node.kind }
      : { membership_id: membershipId, role: current.key, scope: node.path, scope_kind: node.kind },
  });

  return {
    ok: true,
    message: [
      next ? `${who} is now ${next.label}${place}.` : `${who} is no longer ${current.label}${place}.`,
      moved ? reassignedLine(moved) : "",
    ].filter(Boolean).join(" "),
  };
}

/** "12 September 2026" — the console is English-only, so one format throughout. */
export function onDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
}

export function matchLabel(reason: string): string {
  switch (reason) {
    case "GSTIN":
      return "matched on GSTIN";
    case "PAN":
      return "matched on PAN";
    case "IDP_TENANT":
      return "same company directory";
    default:
      return "same email domain";
  }
}
