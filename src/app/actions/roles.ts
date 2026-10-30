"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant, audit } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { customRoleKey, listOrgRoles, missingToGrant, rootOf, validateRoleInput, type Authz } from "@/lib/rbac";
import { DEVELOPER_ROLES, FOUNDING_ROLE, isTemplateKey } from "@/lib/roles";
import { permissionWords } from "@/lib/permissions";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/**
 * Writing roles.
 *
 * Three shapes of write, one table. Editing a shipped role writes an OVERRIDE
 * row keyed to that template, editing an invented one updates its CUSTOM row,
 * and resetting simply deletes the override so the shipped definition takes
 * over again. Nothing is ever destroyed that a membership still points at.
 */

const ROLES_PATH = "/dashboard/settings/roles";

const guard = () => requirePermission("role:manage", "/dashboard");

function back(error?: string, key?: string): never {
  const parts: string[] = [];
  if (key) parts.push(`role=${encodeURIComponent(key)}`);
  if (error) parts.push(flash("error", error));
  redirect(parts.length ? `${ROLES_PATH}?${parts.join("&")}` : ROLES_PATH);
}

const refuse = (message: string): FormResult => ({ ok: false, message });

/**
 * What the editor holds at the organisation's root. A role's definition
 * applies wherever it is held, so that is the only place a permission counts
 * for editing one.
 */
const heldAtRoot = (authz: Authz) => authz.heldAt(rootOf(authz.scopesFor("role:manage")[0] ?? ""));

/**
 * Save a role. A refusal comes back to the form rather than by redirect, so
 * a new role's name and ticks survive it and the screen stays on the role
 * being written instead of jumping to the first one in the list.
 */
export async function saveRoleAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await guard();

  const submitted = String(formData.get("key") ?? "").trim();
  if (submitted === FOUNDING_ROLE) {
    return refuse("The org admin role cannot be edited.");
  }

  const roles = await listOrgRoles(orgId);

  const parsed = validateRoleInput(
    {
      label: formData.get("label"),
      description: formData.get("description"),
      minKind: formData.get("minKind"),
      permissions: formData.getAll("permissions"),
    },
    heldAtRoot(authz),
    roles.find((r) => r.key === submitted)?.permissions ?? [],
  );
  if (!parsed.ok) return refuse(parsed.error);

  const { label, description, minKind, canDelegate, permissions } = parsed.value;

  let key = submitted;
  let creating = false;

  if (!key) {
    key = customRoleKey(label, new Set(roles.map((r) => r.key)));
    creating = true;
  } else if (!roles.some((r) => r.key === key)) {
    return refuse("That role no longer exists.");
  }

  // A shipped role keeps its key and gains an override; an invented one is
  // stored as itself. Keeping the key stable is what lets existing
  // memberships survive an edit untouched.
  const source = isTemplateKey(key) ? "OVERRIDE" : "CUSTOM";
  const wasTemplate = roles.find((r) => r.key === key)?.source === "TEMPLATE";

  await withTenant(orgId, async (sql) => {
    await sql`
      INSERT INTO org_roles (org_id, key, label, description, min_kind,
                             can_delegate, source, permissions, created_by)
      VALUES (${orgId}, ${key}, ${label}, ${description}, ${minKind},
              ${canDelegate}, ${source}, ${permissions}, ${userId})
      ON CONFLICT (org_id, key) DO UPDATE
        SET label        = EXCLUDED.label,
            description  = EXCLUDED.description,
            min_kind     = EXCLUDED.min_kind,
            can_delegate = EXCLUDED.can_delegate,
            permissions  = EXCLUDED.permissions,
            updated_at   = now()
    `;
  });

  await audit({
    orgId,
    actorUserId: userId,
    action: creating ? "role.created" : "role.updated",
    targetType: "role",
    targetId: key,
    metadata: {
      label,
      min_kind: minKind,
      can_delegate: canDelegate,
      permissions,
      first_override: wasTemplate,
    },
  });

  revalidatePath(ROLES_PATH);
  redirect(
    `${ROLES_PATH}?role=${encodeURIComponent(key)}&${flash(
      "saved",
      creating
        ? `${label} is created. Invite people into it from the team page.`
        : "Saved. People holding this role pick up the change on their next page load.",
    )}`,
  );
}

/** Drop an override so the shipped definition applies again. */
export async function resetRoleAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await guard();

  const key = String(formData.get("key") ?? "").trim();
  if (!key || !isTemplateKey(key)) back("Only a role we ship can be reset.");

  // Resetting is an edit in both directions: it drops what the override
  // added and restores what it took away, so the editor has to hold both.
  const current = (await listOrgRoles(orgId)).find((r) => r.key === key)?.permissions ?? [];
  const shipped = DEVELOPER_ROLES.find((r) => r.key === key)?.permissions ?? [];
  const missing = missingToGrant(heldAtRoot(authz), [...current, ...shipped]);
  if (missing.length) back(`This role includes access you do not have: ${permissionWords(missing)}.`, key);

  const removed = await withTenant(orgId, async (sql) => {
    const res = await sql`
      DELETE FROM org_roles
      WHERE org_id = ${orgId} AND key = ${key} AND source = 'OVERRIDE'
    `;
    return res.count > 0;
  });

  if (removed) {
    await audit({
      orgId,
      actorUserId: userId,
      action: "role.reset",
      targetType: "role",
      targetId: key,
      metadata: {},
    });
  }

  revalidatePath(ROLES_PATH);
  redirect(`${ROLES_PATH}?role=${encodeURIComponent(key)}&${flash("saved", "Reset to what we ship.")}`);
}

/** Delete an invented role. Refused while anyone still holds it. */
export async function deleteRoleAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await guard();

  const key = String(formData.get("key") ?? "").trim();
  if (!key || isTemplateKey(key)) {
    back("A role we ship cannot be deleted. Reset it instead.", key || undefined);
  }

  const roles = await listOrgRoles(orgId);
  const role = roles.find((r) => r.key === key);
  if (!role) back("That role no longer exists.");

  // Deleting a role somebody holds would leave their membership pointing at
  // nothing. Resolution treats that as no access rather than full access, so
  // it fails safe, but it fails silently, and silently losing your access is
  // not something to discover on a Monday morning.
  if (role.memberCount > 0) {
    back(
      `${role.label} is held by ${role.memberCount} ${
        role.memberCount === 1 ? "person" : "people"
      }. Move them to another role first.`,
      key,
    );
  }

  await withTenant(orgId, async (sql) => {
    await sql`
      DELETE FROM org_roles
      WHERE org_id = ${orgId} AND key = ${key} AND source = 'CUSTOM'
    `;
  });

  await audit({
    orgId,
    actorUserId: userId,
    action: "role.deleted",
    targetType: "role",
    targetId: key,
    metadata: { label: role.label },
  });

  revalidatePath(ROLES_PATH);
  redirect(`${ROLES_PATH}?${flash("saved", `${role.label} is deleted.`)}`);
}
