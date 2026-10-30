"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { createEntity, updateEntity } from "@/lib/entity";
import { createProject } from "@/lib/project";
import { gateFor, orgTypeOf } from "@/lib/plan-purchase";
import { gateRefusal } from "@/lib/plan-purchase-rules";
import type { FormResult } from "@/components/KeptForm";

/**
 * Writing the scope tree.
 *
 * Only entities for now. Regions, projects and phases land here beside them,
 * which is why the file is named for the tree rather than for the one kind of
 * node it currently creates.
 *
 * A refusal is returned to the form rather than sent by redirect, so what was
 * typed stays typed; the "Registers under" choice in particular fell back to
 * the first entity on a redirect, and pressing again filed the project under
 * the wrong company. Success still redirects.
 */

const ENTITIES = "/dashboard/settings/entities";
const PROJECTS = "/dashboard/projects";

export async function createEntityAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("project:create", "/dashboard");

  const result = await createEntity({
    orgId,
    actorUserId: userId,
    legalName: String(formData.get("legalName") ?? ""),
    pan: String(formData.get("pan") ?? ""),
    registrationNo: String(formData.get("registrationNo") ?? ""),
    registeredAddress: String(formData.get("registeredAddress") ?? ""),
  });

  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(ENTITIES);
  // The dashboard queue carries a "no legal entity yet" item that this
  // resolves, so its page has to be rebuilt too or the nag outlives its cause.
  revalidatePath("/dashboard");
  redirect(`${ENTITIES}?created=${encodeURIComponent(result.path)}`);
}

export async function createProjectAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("project:create", "/dashboard");

  // In production a project comes with a plan: a developer's is bought with
  // the project, a channel partner's firm-wide plan must have room for it.
  const refused = gateRefusal(await gateFor(orgId, await orgTypeOf(orgId)));
  if (refused) return { ok: false, message: refused };

  const result = await createProject({
    orgId,
    actorUserId: userId,
    entityId: String(formData.get("entityId") ?? ""),
    city: String(formData.get("city") ?? ""),
    name: String(formData.get("name") ?? ""),
  });

  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(PROJECTS);
  // The dashboard carries both the project band and a "create your first
  // project" queue item, so it has to be rebuilt or the nag outlives its cause.
  revalidatePath("/dashboard");
  redirect(`${PROJECTS}?created=${encodeURIComponent(result.path)}`);
}

export async function updateEntityAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("project:create", "/dashboard");

  const entityId = String(formData.get("entityId") ?? "");
  const result = await updateEntity({
    orgId,
    actorUserId: userId,
    entityId,
    legalName: String(formData.get("legalName") ?? ""),
    pan: String(formData.get("pan") ?? ""),
    registrationNo: String(formData.get("registrationNo") ?? ""),
    registeredAddress: String(formData.get("registeredAddress") ?? ""),
  });

  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(ENTITIES);
  revalidatePath("/dashboard/projects");
  redirect(`${ENTITIES}?created=${encodeURIComponent(result.path)}`);
}
