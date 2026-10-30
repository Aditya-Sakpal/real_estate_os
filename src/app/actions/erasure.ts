"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { eraseBuyer } from "@/lib/erasure";
import { flash } from "@/lib/flash";

/**
 * Erase a buyer's data at their request. `lead:erase` is asked again at
 * every tower the buyer enquired at, inside `eraseBuyer()`; this only says
 * which lead the page was showing and carries the answer back to it.
 */
export async function eraseBuyerAction(form: FormData): Promise<void> {
  const g = await requirePermission("lead:erase");
  const leadId = String(form.get("leadId") ?? "");
  const r = await eraseBuyer({ orgId: g.orgId, userId: g.userId, authz: g.authz, leadId });
  if (r.ok) {
    revalidatePath("/dashboard/leads");
    revalidatePath("/dashboard");
  }
  redirect(`/dashboard/leads/${encodeURIComponent(leadId)}?${flash(r.ok ? "note" : "error", r.message)}`);
}
