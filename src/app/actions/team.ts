"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant, audit } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { listOrgRoles } from "@/lib/rbac";
import { checkGrant } from "@/lib/invite-rules";
import { targetNode } from "@/lib/scope-nodes";
import { changeMember } from "@/lib/team";
import { FOUNDING_ROLE } from "@/lib/roles";
import { flash } from "@/lib/flash";

/**
 * Adjudicate a join request.
 *
 * Nothing here trusts the form. The org comes from the viewer's own resolved
 * state, the request must belong to that org, the node is read back inside
 * the tenant rather than believed, and the viewer must hold `member:invite`
 * at or above it. Approving a request and sending an invite are the same
 * power (both put a person in the tenant), so they share one permission and
 * the same gate.
 */
const guard = () => requirePermission("member:invite", "/dashboard/team");

export async function approveJoinAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await guard();

  const requestId = String(formData.get("requestId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!requestId || !role) redirect("/dashboard/team");

  // Only roles this tenant actually has. The founding role is never handed
  // out this way: promoting someone to admin is a deliberate, separate act.
  const roles = await listOrgRoles(orgId);
  const target = roles.find((r) => r.key === role);
  if (!target || target.key === FOUNDING_ROLE) redirect("/dashboard/team");

  // No picker means the organisation root, which is what answering a request
  // to join the company has always meant.
  const node = await targetNode(orgId, formData.get("scopeNodeId")?.toString());
  if (!node) redirect("/dashboard/team");

  const gate = checkGrant({
    inviterScopes: authz.scopesFor("member:invite"),
    inviterHeld: authz.heldAt(node.path),
    role: target,
    target: node,
  });
  if (!gate.ok) redirect(`/dashboard/team?${flash("error", gate.message)}`);

  const done = await withTenant(orgId, async (sql) => {
    const [req] = await sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM org_join_requests
      WHERE id = ${requestId} AND org_id = ${orgId} AND status = 'PENDING'
      LIMIT 1
    `;
    if (!req) return null;

    await sql`
      INSERT INTO memberships (user_id, org_id, scope_node_id, role, status,
                               invited_by, invited_at, accepted_at)
      VALUES (${req.user_id}, ${orgId}, ${node.id}, ${role}, 'ACTIVE',
              ${userId}, now(), now())
      ON CONFLICT DO NOTHING
    `;

    await sql`
      UPDATE org_join_requests
      SET status = 'APPROVED', decided_by = ${userId}, decided_at = now()
      WHERE id = ${requestId}
    `;

    return { grantedTo: req.user_id };
  });

  if (done) {
    await audit({
      orgId,
      actorUserId: userId,
      action: "membership.granted",
      targetType: "user",
      targetId: done.grantedTo,
      metadata: {
        role,
        via: "join_request",
        request_id: requestId,
        scope: node.path,
        scope_kind: node.kind,
      },
    });
  }

  revalidatePath("/dashboard/team");
  redirect("/dashboard/team");
}

export async function rejectJoinAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await guard();

  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) redirect("/dashboard/team");

  const rejected = await withTenant(orgId, async (sql) => {
    const res = await sql`
      UPDATE org_join_requests
      SET status = 'REJECTED', decided_by = ${userId}, decided_at = now()
      WHERE id = ${requestId} AND org_id = ${orgId} AND status = 'PENDING'
    `;
    return res.count > 0;
  });

  if (rejected) {
    await audit({
      orgId,
      actorUserId: userId,
      action: "join_request.rejected",
      targetType: "join_request",
      targetId: requestId,
      metadata: {},
    });
  }

  revalidatePath("/dashboard/team");
  redirect("/dashboard/team");
}

/**
 * Change somebody's role where they hold it, or take it away.
 *
 * Two keys, because adding a person, changing what they may do, and ending
 * their access are three different powers. Both refusals and successes come
 * back as a signed note at the top of the list they were pressed in.
 */
export async function changeRoleAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("member:role", "/dashboard/team");
  const outcome = await changeMember({
    orgId,
    actorUserId: userId,
    authz,
    membershipId: String(formData.get("membershipId") ?? ""),
    change: { kind: "ROLE", roleKey: String(formData.get("role") ?? "") },
  });
  settle(outcome);
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("member:remove", "/dashboard/team");
  const outcome = await changeMember({
    orgId,
    actorUserId: userId,
    authz,
    membershipId: String(formData.get("membershipId") ?? ""),
    change: { kind: "REMOVE" },
  });
  settle(outcome);
}

function settle(outcome: { ok: boolean; message: string }): never {
  revalidatePath("/dashboard/team");
  redirect(`/dashboard/team?${flash(outcome.ok ? "member" : "error", outcome.message)}#members`);
}
