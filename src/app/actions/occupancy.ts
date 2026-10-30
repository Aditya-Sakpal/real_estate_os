"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { recordOccupancy } from "@/lib/occupancy";
import { isNodeId } from "@/lib/scope-rules";
import type { FormResult } from "@/components/KeptForm";

/**
 * A phase's occupancy certificate, received on a day. `rera:manage`, asked
 * again at the phase inside `recordOccupancy()`. A refusal comes back to the
 * form; success returns to the project.
 */
export async function recordOccupancyAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("rera:manage", "/dashboard/projects");
  const projectId = String(formData.get("projectId") ?? "").trim();
  if (!isNodeId(projectId)) return { ok: false, message: "That project does not exist." };
  const r = await recordOccupancy({
    orgId,
    userId,
    authz,
    phaseId: String(formData.get("phaseId") ?? ""),
    date: String(formData.get("ocReceivedOn") ?? "").slice(0, 10),
    today: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
  });
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath(`/dashboard/projects/${projectId}`);
  redirect(`/dashboard/projects/${projectId}`);
}
