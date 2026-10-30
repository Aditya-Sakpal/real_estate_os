"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { listOrgRoles } from "@/lib/rbac";
import { resetPolicy, revealContact, savePolicy, type Revealed } from "@/lib/mask";
import { readThreshold } from "@/lib/mask-rules";
import { flash } from "@/lib/flash";
import { withTenant } from "@/lib/db";
import { normalisePhone } from "@/lib/calling-rules";
import { headers } from "next/headers";
import { redeemStepUp, startStepUp } from "@/lib/phone-session";
import { isUuid } from "@/lib/capture-rules";

/**
 * Showing one buyer's whole number, and setting who sees what.
 *
 * A reveal answers with the number rather than by redirect, because it
 * changes one line of one screen and nothing else. `lead:read` opens the
 * door; the reveal itself checks `lead.phone:unmask` at the lead's own
 * tower, the policy, and the day's allowance.
 */
export async function revealAction(
  leadId: string,
  code?: { challengeId: string; code: string },
): Promise<Revealed> {
  const { userId, orgId, authz, method, stepUp } = await requirePermission("lead:read");
  const id = String(leadId ?? "");
  // A phone session sees a whole number only behind a fresh code for this
  // one lead, spent here. Without one, the screen is asked to get it.
  if (method === "phone" && stepUp.some((g) => g.permissions.has("lead.phone:unmask"))) {
    if (!code) return { ok: false, needsCode: true, message: "We send a code to your WhatsApp first." };
    const opened = await redeemStepUp({
      userId, orgId, authz, stepUp, permission: "lead.phone:unmask", targetId: id,
      challengeId: String(code.challengeId ?? ""), code: String(code.code ?? ""),
    });
    if (!opened.ok) return { ok: false, needsCode: true, message: opened.message };
    return revealContact({ orgId, userId, authz: opened.authz, leadId: id });
  }
  return revealContact({ orgId, userId, authz, leadId: id });
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/**
 * A code for one action on one thing, to a phone session's own number:
 * one lead's whole number, or this organisation's leads as a file.
 */
export async function sendStepUpAction(
  permission: "lead.phone:unmask" | "lead:export",
  targetId: string,
): Promise<{ ok: true; challengeId: string; message: string } | { ok: false; message: string }> {
  const { userId, orgId, method, stepUp } = await requirePermission("lead:read");
  if (method !== "phone") return { ok: false, message: "No code is needed." };
  let path: string | undefined;
  let target = String(targetId ?? "");
  if (permission === "lead.phone:unmask") {
    if (!isUuid(target)) return { ok: false, message: "That lead is not there any more." };
    const [lead] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND l.id = ${target}`);
    if (!lead) return { ok: false, message: "That lead is not there any more." };
    path = lead.path;
  } else if (permission === "lead:export") {
    target = orgId;
  } else {
    return { ok: false, message: "Your role cannot do that here." };
  }
  return startStepUp({ userId, orgId, stepUp, permission, targetId: target, path, ip: await clientIp() });
}

/**
 * The leads carrying a whole number somebody typed, inside the towers they
 * read leads on. Ids only: it tells them which of the rows they can already
 * see are that buyer, which they knew by typing the number.
 */
export async function findNumberAction(raw: string): Promise<string[]> {
  const { orgId, authz } = await requirePermission("lead:read");
  const phone = normalisePhone(String(raw ?? ""));
  const scopes = authz.scopesFor("lead:read");
  if (!phone || scopes.length === 0) return [];
  const rows = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    SELECT l.id FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${orgId} AND l.phone = ${phone} AND n.path <@ ${scopes}::ltree[]
    LIMIT 50`);
  return rows.map((r) => r.id);
}

const PAGE = "/dashboard/settings/phone-numbers";

/** One role's answer: masked, full or hidden, and from which stage it changes. */
export async function savePhonePolicyAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("org:manage");
  const role = String(formData.get("role") ?? "");
  const roles = await listOrgRoles(orgId);
  const found = roles.find((r) => r.key === role);
  if (!found) redirect(`${PAGE}?${flash("error", "That role no longer exists.")}`);

  const threshold = readThreshold({
    before: formData.get("before"),
    from: formData.get("from"),
    after: formData.get("after"),
  });
  if (!threshold) redirect(`${PAGE}?role=${encodeURIComponent(role)}&${flash("error", "Pick what this role sees.")}`);

  await savePolicy({ orgId, userId, role, threshold });
  revalidatePath(PAGE);
  redirect(`${PAGE}?${flash("saved", `Saved for ${found.label}.`)}`);
}

export async function resetPhonePolicyAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("org:manage");
  const role = String(formData.get("role") ?? "");
  const found = (await listOrgRoles(orgId)).find((r) => r.key === role);
  if (!found) redirect(PAGE);
  await resetPolicy({ orgId, userId, role });
  revalidatePath(PAGE);
  redirect(`${PAGE}?${flash("saved", `${found.label} is back to what we ship.`)}`);
}
