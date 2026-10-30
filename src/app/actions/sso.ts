"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { listOrgRoles } from "@/lib/rbac";
import { orgRoot, targetNode } from "@/lib/scope-nodes";
import { checkGrant } from "@/lib/invite-rules";
import { readSsoInput } from "@/lib/sso-rules";
import { addDomain, removeDomain, removeSsoConfig, saveSsoConfig, setEnforce, verifyDomain } from "@/lib/sso";
import { createScimToken, mapGroup, revokeScimToken } from "@/lib/scim";

/**
 * Single sign-on and provisioning. `org:manage` at the organisation's root
 * for all of it: the identity provider decides who may sign in to the whole
 * company. Mapping a group to a role is also giving that role, so it asks
 * the same rule an invite does.
 */

export type SsoFormState = { ok: boolean; message: string; errors?: Record<string, string>; token?: string } | null;

const done = () => revalidatePath("/dashboard/settings/sso");

async function admin() {
  const g = await requirePermission("org:manage", "/dashboard/settings");
  const root = await orgRoot(g.orgId);
  if (!root || !g.authz.canAt("org:manage", root.path)) return null;
  return g;
}

const text = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function saveSsoAction(_: SsoFormState, fd: FormData): Promise<SsoFormState> {
  const g = await admin();
  if (!g) return { ok: false, message: "Only an admin of the whole organisation can change this." };
  const read = readSsoInput(
    { metadata: text(fd, "metadata"), entityId: text(fd, "entityId"), ssoUrl: text(fd, "ssoUrl"), certificate: text(fd, "certificate") },
    new Date().toISOString(),
  );
  if (!read.ok) return { ok: false, message: "Check the highlighted fields.", errors: read.errors };
  const r = await saveSsoConfig({ orgId: g.orgId, userId: g.userId, input: read.input });
  done();
  return r;
}

export async function removeSsoAction(): Promise<{ ok: boolean; message: string }> {
  const g = await admin();
  if (!g) return { ok: false, message: "Only an admin of the whole organisation can change this." };
  const r = await removeSsoConfig({ orgId: g.orgId, userId: g.userId });
  done();
  return r;
}

export async function setEnforceAction(on: boolean): Promise<{ ok: boolean; message: string }> {
  const g = await admin();
  if (!g) return { ok: false, message: "Only an admin of the whole organisation can change this." };
  const r = await setEnforce({ orgId: g.orgId, userId: g.userId, on: !!on });
  if (r.ok) done();
  return r;
}

export async function addDomainAction(_: SsoFormState, fd: FormData): Promise<SsoFormState> {
  const g = await admin();
  if (!g) return { ok: false, message: "Only an admin of the whole organisation can change this." };
  const r = await addDomain({ orgId: g.orgId, userId: g.userId, raw: text(fd, "domain") });
  if (r.ok) done();
  return r;
}

export async function verifyDomainAction(domain: string): Promise<{ ok: boolean; message: string }> {
  const g = await admin();
  if (!g) return { ok: false, message: "Only an admin of the whole organisation can change this." };
  const r = await verifyDomain({ orgId: g.orgId, userId: g.userId, domain: String(domain ?? "") });
  if (r.ok) done();
  return r;
}

export async function removeDomainAction(domain: string): Promise<{ ok: boolean; message: string }> {
  const g = await admin();
  if (!g) return { ok: false, message: "Only an admin of the whole organisation can change this." };
  const r = await removeDomain({ orgId: g.orgId, userId: g.userId, domain: String(domain ?? "") });
  if (r.ok) done();
  return r;
}

export async function createScimTokenAction(_: SsoFormState, fd: FormData): Promise<SsoFormState> {
  const g = await admin();
  if (!g) return { ok: false, message: "Only an admin of the whole organisation can change this." };
  const r = await createScimToken({ orgId: g.orgId, userId: g.userId, label: text(fd, "label") });
  if (!r.ok) return { ok: false, message: r.message, errors: { label: r.message } };
  done();
  return { ok: true, message: "Copy it now. It is not shown again.", token: r.token };
}

export async function revokeScimTokenAction(tokenId: string): Promise<{ ok: boolean; message: string }> {
  const g = await admin();
  if (!g) return { ok: false, message: "Only an admin of the whole organisation can change this." };
  const r = await revokeScimToken({ orgId: g.orgId, userId: g.userId, tokenId: String(tokenId ?? "") });
  if (r.ok) done();
  return r;
}

export async function mapGroupAction(input: { groupId: string; role: string; nodeId: string }): Promise<{ ok: boolean; message: string }> {
  const g = await admin();
  if (!g) return { ok: false, message: "Only an admin of the whole organisation can change this." };
  if (!input.role) {
    const r = await mapGroup({ orgId: g.orgId, userId: g.userId, groupId: String(input.groupId ?? ""), role: null, nodeId: null });
    if (r.ok) done();
    return r;
  }
  const [roles, target] = await Promise.all([listOrgRoles(g.orgId), targetNode(g.orgId, String(input.nodeId ?? ""))]);
  const role = roles.find((r) => r.key === input.role);
  if (!role) return { ok: false, message: "That role no longer exists." };
  if (!target) return { ok: false, message: "That is not a place in this organisation." };
  const gate = checkGrant({ inviterScopes: g.authz.scopesFor("member:invite"), inviterHeld: g.authz.heldAt(target.path), role, target });
  if (!gate.ok) return { ok: false, message: gate.message };
  const r = await mapGroup({ orgId: g.orgId, userId: g.userId, groupId: String(input.groupId ?? ""), role: role.key, nodeId: target.id });
  if (r.ok) done();
  return r;
}
