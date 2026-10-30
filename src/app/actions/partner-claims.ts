"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { getViewer } from "@/lib/console";
import { deskOf, isId, linkClaimByHand, registrationPath, saveAutoRegister } from "@/lib/partners";
import { deskOwns } from "@/lib/grant-rules";
import { addOtherNumber, removeOtherNumber } from "@/lib/lead-phones";
import { linkOwnProject } from "@/lib/partner-workspace";
import { redirect } from "next/navigation";
import { addDeveloperProject } from "@/lib/linked-projects";
import { flash } from "@/lib/flash";
import type { OtherNumberKind } from "@/lib/partner-rules";

/**
 * Claims the buyer's own number and project did not match, and the
 * settings around them: another number on a lead, a registration linked to
 * a booking by hand, and a channel partner's own leads registered with the
 * developer by themselves. Each names its key and asks it at the node it
 * touches.
 */

export type ClaimFormState = { ok: boolean; message: string } | null;

const text = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function leadPath(orgId: string, leadId: string): Promise<string | null> {
  if (!isId(leadId)) return null;
  const [r] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
    SELECT n.path::text AS path FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id WHERE l.org_id = ${orgId} AND l.id = ${leadId}`);
  return r?.path ?? null;
}

export async function addOtherNumberAction(_: ClaimFormState, fd: FormData): Promise<ClaimFormState> {
  const g = await requirePermission("lead:update");
  const leadId = text(fd, "leadId");
  const path = await leadPath(g.orgId, leadId);
  if (!path || !g.authz.canAt("lead:update", path)) return { ok: false, message: "You cannot change this lead." };
  const kind: OtherNumberKind = text(fd, "kind") === "CO_APPLICANT" ? "CO_APPLICANT" : "ALTERNATE";
  const res = await addOtherNumber({ orgId: g.orgId, userId: g.userId, leadId, raw: text(fd, "phone"), kind });
  if (res.ok) revalidatePath(`/dashboard/leads/${leadId}`);
  return res;
}

export async function removeOtherNumberAction(leadId: string, id: string): Promise<ClaimFormState> {
  const g = await requirePermission("lead:update");
  const path = await leadPath(g.orgId, leadId);
  if (!path || !g.authz.canAt("lead:update", path)) return { ok: false, message: "You cannot change this lead." };
  const res = await removeOtherNumber({ orgId: g.orgId, userId: g.userId, leadId, id });
  if (res.ok) revalidatePath(`/dashboard/leads/${leadId}`);
  return res;
}

/** A registration linked by hand to a booking no claim matched. `payout:approve` at the registration's project. */
export async function linkClaimAction(_: ClaimFormState, fd: FormData): Promise<ClaimFormState> {
  const g = await requirePermission("payout:approve");
  const registrationId = text(fd, "registrationId");
  const leadId = text(fd, "leadId");
  const path = await registrationPath(g.orgId, registrationId);
  if (!path || !g.authz.canAt("payout:approve", path)) return { ok: false, message: "You cannot approve payouts on this project." };
  const desk = await deskOf(g.orgId, "registration", registrationId);
  if (!desk || !deskOwns(g.desk, desk.mandateId)) return { ok: false, message: "That registration is not on your desk." };
  const booked = await leadPath(g.orgId, leadId);
  if (!booked || !g.authz.canAt("payout:read", booked)) return { ok: false, message: "Choose a booking you can see." };
  const res = await linkClaimByHand({ orgId: g.orgId, userId: g.userId, registrationId, leadId, reason: text(fd, "reason") });
  if (res.ok) revalidatePath("/dashboard/partners");
  return res;
}

/** A channel partner's own setting. Its admin decides; a developer has no such switch. */
export async function autoRegisterAction(_: ClaimFormState, fd: FormData): Promise<ClaimFormState> {
  const g = await requirePermission("org:manage");
  const viewer = await getViewer();
  if (!viewer || viewer.orgType !== "CHANNEL_PARTNER" || viewer.via) return { ok: false, message: "Only a channel partner sets this." };
  const res = await saveAutoRegister({ orgId: g.orgId, userId: g.userId, on: text(fd, "on") === "ON" });
  if (res.ok) revalidatePath("/dashboard/developers");
  return res;
}

/** Which of the partner's own projects is a developer's project it sells. */
export async function linkOwnProjectAction(_: ClaimFormState, fd: FormData): Promise<ClaimFormState> {
  const g = await requirePermission("org:manage");
  const viewer = await getViewer();
  if (!viewer || viewer.orgType !== "CHANNEL_PARTNER" || viewer.via) return { ok: false, message: "Only a channel partner sets this." };
  const own = text(fd, "ownProjectId");
  const res = await linkOwnProject({
    cpOrgId: g.orgId,
    userId: g.userId,
    devOrgId: text(fd, "devOrgId"),
    devProjectId: text(fd, "devProjectId"),
    ownProjectId: own ? own : null,
  });
  if (res.ok) revalidatePath("/dashboard/developers");
  return { ok: res.ok, message: res.message };
}

/**
 * A channel partner adds a developer's project it is empanelled on to its
 * own console, to run its own ads and calls on it from the developer's
 * signed facts. Opens the project once it is there.
 */
export async function addDeveloperProjectAction(fd: FormData): Promise<ClaimFormState> {
  const g = await requirePermission("project:create", "/dashboard/developers");
  const viewer = await getViewer();
  if (!viewer || viewer.orgType !== "CHANNEL_PARTNER" || viewer.via) return { ok: false, message: "Only a channel partner adds a developer's project." };
  const res = await addDeveloperProject({ cpOrgId: g.orgId, userId: g.userId, devOrgId: text(fd, "devOrgId"), devProjectId: text(fd, "devProjectId") });
  if (!res.ok) return res;
  revalidatePath("/dashboard/developers");
  revalidatePath("/dashboard/projects");
  revalidatePath("/dashboard");
  redirect(`/dashboard/projects/${res.projectId}?${flash("notice", res.added ? "Added. Its facts, prices and pictures come from the developer." : "Already in your projects.")}`);
}
