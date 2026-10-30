"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { getViewer } from "@/lib/console";
import { promoteToAdmin, transferAdmin, demoteAdmin } from "@/lib/admin";
import { listOrgRoles, roleFitsScope } from "@/lib/rbac";
import { FOUNDING_ROLE } from "@/lib/roles";
import { flash } from "@/lib/flash";

/**
 * Moving the founding role.
 *
 * Gated on `member:role` rather than `member:invite`: adding a person and
 * changing what an existing person can do are different powers, and the role
 * editor already draws that line. The rank rule on top of it, that only an
 * admin moves the admin role, is checked inside `@/lib/admin` against the
 * viewer's resolved roles rather than against anything in the form.
 */

const TEAM = "/dashboard/team";

/**
 * Back to the team page. A success carries only the membership id (the page
 * looks the person up and says it only if the team now agrees), and a refusal
 * carries a signed message, so a link can put neither a name nor a sentence
 * on the screen.
 */
function back(outcome?: { done: "promoted" | "transferred" | "demoted"; id: string } | { error: string }): never {
  if (!outcome) redirect(TEAM);
  if ("error" in outcome) redirect(`${TEAM}?${flash("error", outcome.error)}`);
  redirect(`${TEAM}?${outcome.done}=${encodeURIComponent(outcome.id)}`);
}

async function context() {
  const { userId, orgId, authz } = await requirePermission("member:role", TEAM);
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  return {
    actorUserId: userId,
    orgId,
    actorIsFounding: authz.roleKeys.includes(FOUNDING_ROLE),
    orgPrimaryDomain: viewer.state.org.primaryDomain,
  };
}

/** A role that exists in this tenant and is valid at the org root. */
async function resolveRole(orgId: string, key: string): Promise<string | null> {
  const roles = await listOrgRoles(orgId);
  const role = roles.find((r) => r.key === key);
  if (!role || role.key === FOUNDING_ROLE || !roleFitsScope(role, "ORG")) return null;
  return role.key;
}

export async function promoteAdminAction(formData: FormData): Promise<void> {
  const ctx = await context();
  const membershipId = String(formData.get("membershipId") ?? "");
  if (!membershipId) back();

  const result = await promoteToAdmin({ ...ctx, membershipId });

  revalidatePath(TEAM);
  back(result.ok ? { done: "promoted", id: membershipId } : { error: result.message });
}

export async function transferAdminAction(formData: FormData): Promise<void> {
  const ctx = await context();
  const membershipId = String(formData.get("membershipId") ?? "");
  const ownNewRole = await resolveRole(ctx.orgId, String(formData.get("ownNewRole") ?? ""));
  if (!membershipId) back();
  if (!ownNewRole) back({ error: "Pick the role you are stepping down into." });

  const result = await transferAdmin({ ...ctx, membershipId, ownNewRole });

  revalidatePath(TEAM);
  back(result.ok ? { done: "transferred", id: membershipId } : { error: result.message });
}

export async function demoteAdminAction(formData: FormData): Promise<void> {
  const ctx = await context();
  const membershipId = String(formData.get("membershipId") ?? "");
  const newRole = await resolveRole(ctx.orgId, String(formData.get("newRole") ?? ""));
  if (!membershipId) back();
  if (!newRole) back({ error: "Pick the role they move into." });

  const result = await demoteAdmin({ ...ctx, membershipId, newRole });

  revalidatePath(TEAM);
  back(result.ok ? { done: "demoted", id: membershipId } : { error: result.message });
}
