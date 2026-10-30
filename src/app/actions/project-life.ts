"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { requireAnyPermission, requirePermission } from "@/lib/guard";
import { flash } from "@/lib/flash";
import { isUuid } from "@/lib/capture-rules";
import { saveVisitHours } from "@/lib/slots";
import { removeLocation, saveLocation } from "@/lib/visits";
import { reactivateProject, retireProject } from "@/lib/project-life";
import { deleteNode, removeProjectFiles } from "@/lib/node-delete";
import { planRequired } from "@/lib/plan-purchase-rules";
import type { ActionResult } from "@/app/actions/leads";

/** A project of this tenant, by the id a form posted, with its path. */
async function projectPath(orgId: string, projectId: string): Promise<string | null> {
  if (!isUuid(projectId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`
      SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${projectId} AND kind = 'PROJECT'`;
    return r?.path ?? null;
  });
}

/** A project or tower of this tenant, by id, with its path. */
async function nodePath(orgId: string, nodeId: string): Promise<string | null> {
  if (!isUuid(nodeId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`
      SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId} AND kind IN ('PROJECT', 'PHASE')`;
    return r?.path ?? null;
  });
}

/** When a project's gallery takes visits, weekdays and the weekend. */
export async function saveVisitHoursAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requirePermission("visit:manage");
  const projectId = String(form.get("projectId") ?? "");
  const path = await projectPath(g.orgId, projectId);
  if (!path || !g.authz.canAt("visit:manage", path)) return { ok: false, message: "You cannot change this project's visits." };
  const r = await saveVisitHours({
    orgId: g.orgId,
    userId: g.userId,
    projectId,
    raw: {
      weekdayOpen: String(form.get("weekdayOpen") ?? ""),
      weekdayLast: String(form.get("weekdayLast") ?? ""),
      weekendOpen: String(form.get("weekendOpen") ?? ""),
      weekendLast: String(form.get("weekendLast") ?? ""),
    },
  });
  revalidatePath(`/dashboard/projects/${projectId}`);
  revalidatePath("/dashboard/visits");
  return r.ok ? { ok: true, message: "Saved." } : { ok: false, message: r.message };
}

/** Another gallery at a project or tower, with its own name and pin. */
export async function addGalleryAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const g = await requireAnyPermission(["project:create", "brand:manage"]);
  const nodeId = String(form.get("nodeId") ?? "");
  const path = await nodePath(g.orgId, nodeId);
  if (!path || !(g.authz.canAt("project:create", path) || g.authz.canAt("brand:manage", path))) {
    return { ok: false, message: "You cannot change this project's galleries." };
  }
  const label = String(form.get("label") ?? "").trim();
  if (!label) return { ok: false, message: "Name the gallery." };
  const r = await saveLocation({
    orgId: g.orgId,
    userId: g.userId,
    nodeId,
    label,
    link: String(form.get("link") ?? ""),
    address: String(form.get("address") ?? ""),
  });
  revalidatePath("/dashboard/projects", "layout");
  return r.ok ? { ok: true, message: "Saved." } : { ok: false, message: r.message };
}

/** Take a gallery off a project or tower. */
export async function removeGalleryAction(form: FormData): Promise<void> {
  const g = await requireAnyPermission(["project:create", "brand:manage"]);
  const nodeId = String(form.get("nodeId") ?? "");
  const locationId = String(form.get("locationId") ?? "");
  const back = String(form.get("back") ?? "/dashboard/projects");
  const page = back.startsWith("/dashboard/projects/") ? back : "/dashboard/projects";
  const path = await nodePath(g.orgId, nodeId);
  if (!path || !isUuid(locationId) || !(g.authz.canAt("project:create", path) || g.authz.canAt("brand:manage", path))) {
    redirect(`${page}?${flash("error", "You cannot change this project's galleries.")}`);
  }
  const r = await removeLocation({ orgId: g.orgId, userId: g.userId, nodeId, locationId });
  revalidatePath("/dashboard/projects", "layout");
  redirect(r.ok ? page : `${page}?${flash("error", r.message)}`);
}

/** Retire a sold-out project: what it runs stops, and what it holds stays readable. */
export async function retireProjectAction(form: FormData): Promise<void> {
  const g = await requirePermission("org:manage");
  const projectId = String(form.get("projectId") ?? "");
  const page = `/dashboard/projects/${isUuid(projectId) ? projectId : ""}`;
  const path = await projectPath(g.orgId, projectId);
  if (!path || !g.authz.canAt("org:manage", path)) redirect(`/dashboard/projects?${flash("error", "You cannot retire this project.")}`);
  const r = await retireProject({ orgId: g.orgId, userId: g.userId, projectId });
  revalidatePath("/dashboard", "layout");
  if (!r.ok) redirect(`${page}?${flash("error", r.message)}`);
  const left = r.report.adsNotPaused;
  redirect(
    left
      ? `${page}?${flash("error", `Retired. ${left} ${left === 1 ? "ad" : "ads"} could not be paused. Pause ${left === 1 ? "it" : "them"} on Published.`)}`
      : `${page}?${flash("notice", "Retired.")}`,
  );
}

/** Bring a retired project back. Only its status changes. */
export async function reactivateProjectAction(form: FormData): Promise<void> {
  const g = await requirePermission("org:manage");
  const projectId = String(form.get("projectId") ?? "");
  const page = `/dashboard/projects/${isUuid(projectId) ? projectId : ""}`;
  const path = await projectPath(g.orgId, projectId);
  if (!path || !g.authz.canAt("org:manage", path)) redirect(`/dashboard/projects?${flash("error", "You cannot change this project.")}`);
  const r = await reactivateProject({ orgId: g.orgId, userId: g.userId, projectId });
  revalidatePath("/dashboard", "layout");
  if (!r.ok) redirect(`${page}?${flash("error", r.message)}`);
  redirect(
    `${page}?${flash("notice", planRequired(process.env) ? "Active again. Buy a plan for it to run calls and posts." : "Active again.")}`,
  );
}

/** Delete a project made by mistake, with its towers and everything not kept. */
export async function deleteProjectAction(form: FormData): Promise<void> {
  const g = await requirePermission("org:manage");
  const projectId = String(form.get("projectId") ?? "");
  const page = `/dashboard/projects/${isUuid(projectId) ? projectId : ""}`;
  const path = await projectPath(g.orgId, projectId);
  if (!path || !g.authz.canAt("org:manage", path)) redirect(`/dashboard/projects?${flash("error", "You cannot delete this project.")}`);
  const r = await deleteNode({ orgId: g.orgId, userId: g.userId, nodeId: projectId, kind: "PROJECT" });
  if (!r.ok) redirect(`${page}?${flash("error", r.message)}`);
  after(() => removeProjectFiles(g.orgId, projectId).then(() => undefined, () => undefined));
  revalidatePath("/dashboard", "layout");
  redirect(`/dashboard/projects?${flash("saved", `${r.name} deleted.`)}`);
}

/** Delete one tower of a project, made by mistake. */
export async function deletePhaseAction(form: FormData): Promise<void> {
  const g = await requirePermission("org:manage");
  const phaseId = String(form.get("phaseId") ?? "");
  const projectId = String(form.get("projectId") ?? "");
  const page = `/dashboard/projects/${isUuid(projectId) ? projectId : ""}`;
  const path = await nodePath(g.orgId, phaseId);
  if (!path || !g.authz.canAt("org:manage", path)) redirect(`${page}?${flash("error", "You cannot delete this phase.")}`);
  const r = await deleteNode({ orgId: g.orgId, userId: g.userId, nodeId: phaseId, kind: "PHASE" });
  revalidatePath("/dashboard", "layout");
  redirect(r.ok ? `${page}?${flash("notice", `${r.name} deleted.`)}` : `${page}?${flash("error", r.message)}`);
}
