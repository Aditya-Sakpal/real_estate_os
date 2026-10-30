"use server";

import { acceptFiledNumber } from "@/lib/extract";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { createPhase, recordRegistration, attestExemption, lookupRegistration } from "@/lib/rera";
import type { LookupAnswer } from "@/lib/rera-lookup-rules";
import { isNodeId } from "@/lib/scope-rules";
import type { FormResult } from "@/components/KeptForm";

/**
 * Phases and their registration.
 *
 * Creating a phase is a tree write, so it needs `project:create`. Asserting
 * that a phase is registered or exempt is a compliance act, so it needs
 * `rera:manage`, which only the RERA Compliance Officer and the org admin
 * hold by default. Those are deliberately different powers: a sales head who
 * can add a tower should not be able to declare it advertisable.
 *
 * A refusal is returned to the form, so what was typed stays typed (a
 * registration's number, date and the promoter's name are a lot to type
 * twice). Success redirects, carrying the id of what changed and nothing a
 * page prints.
 */

function back(projectId: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString();
  redirect(`/dashboard/projects/${projectId}${q ? `?${q}` : ""}`);
}

/** The project id from the form, or nothing: it is put in an address. */
const projectFrom = (formData: FormData): string | null => {
  const id = String(formData.get("projectId") ?? "").trim();
  return isNodeId(id) ? id : null;
};

export async function createPhaseAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("project:create", "/dashboard");
  const projectId = projectFrom(formData);
  if (!projectId) return { ok: false, message: "Pick the project this phase belongs to." };

  const result = await createPhase({
    orgId,
    actorUserId: userId,
    projectId,
    name: String(formData.get("name") ?? ""),
  });
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(`/dashboard/projects/${projectId}`);
  revalidatePath("/dashboard/projects");
  revalidatePath("/dashboard");
  // Somebody who may record its registration lands on that form, for it.
  back(projectId, authz.can("rera:manage") ? { created: result.id, register: result.id } : { created: result.id });
}

export async function recordRegistrationAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("rera:manage", "/dashboard/projects");
  const projectId = projectFrom(formData);
  if (!projectId) return { ok: false, message: "That project does not exist." };

  const result = await recordRegistration({
    orgId,
    actorUserId: userId,
    phaseId: String(formData.get("phaseId") ?? ""),
    stateCode: String(formData.get("stateCode") ?? ""),
    registrationNo: String(formData.get("registrationNo") ?? ""),
    promoterName: String(formData.get("promoterName") ?? ""),
    validTo: String(formData.get("validTo") ?? ""),
    reason: String(formData.get("reason") ?? ""),
    registeredOn: String(formData.get("registeredOn") ?? "") || null,
    permitNo: String(formData.get("permitNo") ?? "") || null,
  });
  if (!result.ok) return { ok: false, message: result.message };
  // The number read off its certificate is now the filed one: accept it.
  await acceptFiledNumber(orgId, userId, String(formData.get("phaseId") ?? ""), String(formData.get("registrationNo") ?? "")).catch((e) => console.error("rera: accepting the read number failed", e));

  revalidatePath(`/dashboard/projects/${projectId}`);
  revalidatePath("/dashboard/projects");
  revalidatePath("/dashboard");
  back(projectId, { verified: result.id });
}

/** Read a registration back from the state's portal, to fill the form. */
export async function lookupRegistrationAction(input: { phaseId: string; stateCode: string; registrationNo: string }): Promise<LookupAnswer> {
  const { orgId } = await requirePermission("rera:manage", "/dashboard/projects");
  if (!isNodeId(input.phaseId)) return { ok: false, message: "Pick the phase first." };
  return lookupRegistration({ orgId, phaseId: input.phaseId, stateCode: String(input.stateCode ?? ""), registrationNo: String(input.registrationNo ?? "") });
}

export async function attestExemptionAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("rera:manage", "/dashboard/projects");
  const projectId = projectFrom(formData);
  if (!projectId) return { ok: false, message: "That project does not exist." };

  const result = await attestExemption({
    orgId,
    actorUserId: userId,
    projectId,
    stateCode: String(formData.get("stateCode") ?? ""),
    landAreaSqm: Number(formData.get("landAreaSqm")),
    apartmentCount: Number(formData.get("apartmentCount")),
  });
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(`/dashboard/projects/${projectId}`);
  revalidatePath("/dashboard/projects");
  revalidatePath("/dashboard");
  back(projectId, { exempt: "1" });
}
