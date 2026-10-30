"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { saveCaps } from "@/lib/project-caps";
import { CAP_UNITS } from "@/lib/project-cap-rules";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/** A project's own limits on the shared allowance, set by `billing:manage`. */
export async function saveProjectCapsAction(fd: FormData): Promise<FormResult> {
  const g = await requirePermission("billing:manage", "/dashboard/settings/billing");
  const projectId = String(fd.get("projectId") ?? "");
  const raw = Object.fromEntries(CAP_UNITS.map((u) => [u, String(fd.get(u) ?? "")]));
  const r = await saveCaps({ orgId: g.orgId, userId: g.userId, projectId, raw });
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/dashboard/settings/billing");
  redirect(`/dashboard/settings/billing?${flash("saved", "Limits saved.")}#p-${projectId}`);
}
