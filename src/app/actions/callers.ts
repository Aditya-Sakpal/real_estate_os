"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { dismissWaitingCaller, fileWaitingCaller } from "@/lib/waiting-callers";
import { isUuid } from "@/lib/capture-rules";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/** File a caller nobody could place under the tower a person chose: the ordinary capture, ownership rules and all. */
export async function fileCallerAction(formData: FormData): Promise<FormResult> {
  const g = await requirePermission("lead:create", "/dashboard/leads");
  const eventId = String(formData.get("event") ?? "");
  const phaseId = String(formData.get("tower") ?? "");
  if (!isUuid(eventId)) return { ok: false, message: "This caller could not be found." };
  if (!isUuid(phaseId)) return { ok: false, message: "Choose the project they called about." };
  const r = await fileWaitingCaller({ orgId: g.orgId, userId: g.userId, authz: g.authz, eventId, phaseId });
  if (!r.ok) return r;
  revalidatePath("/dashboard/leads/callers");
  revalidatePath("/dashboard");
  if (r.leadId) redirect(`/dashboard/leads/${r.leadId}?${flash("note", "Filed under the project. Call them back from here.")}`);
  redirect(`/dashboard/leads/callers?${flash("done", "That number is one we never call, so no lead was made.")}`);
}

/** Not a buyer: the call leaves the list and makes no lead. */
export async function dismissCallerAction(formData: FormData): Promise<void> {
  const g = await requirePermission("lead:create", "/dashboard/leads");
  const eventId = String(formData.get("event") ?? "");
  const r = isUuid(eventId)
    ? await dismissWaitingCaller({ orgId: g.orgId, userId: g.userId, authz: g.authz, eventId })
    : { ok: false as const, message: "This caller could not be found." };
  revalidatePath("/dashboard/leads/callers");
  revalidatePath("/dashboard");
  redirect(`/dashboard/leads/callers?${r.ok ? flash("done", "Removed. No lead was made.") : flash("error", r.message)}`);
}
