"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { recordMilestone, saveValues } from "@/lib/attribution";
import { convertBlocks } from "@/lib/quotes";
import { isUuid } from "@/lib/capture-rules";
import { readValues, type Milestone } from "@/lib/attribution-rules";

/**
 * What became of a lead after it booked. Recording an agreement or a
 * registration is `lead:update` at the lead's own tower, the same key that
 * moved it to Booked.
 */

export type MilestoneResult = { ok: boolean; message: string };

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

async function leadPath(orgId: string, leadId: string): Promise<string | null> {
  if (!isUuid(leadId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    return r?.path ?? null;
  });
}

export async function recordMilestoneAction(_prev: MilestoneResult | null, form: FormData): Promise<MilestoneResult> {
  const g = await requirePermission("lead:update");
  const leadId = String(form.get("leadId") ?? "");
  const kind = String(form.get("kind") ?? "") as Milestone;
  const day = String(form.get("day") ?? "").slice(0, 10);
  const path = await leadPath(g.orgId, leadId);
  if (!path || !g.authz.canAt("lead:update", path)) return { ok: false, message: "You cannot update this lead." };
  if (kind !== "AGREEMENT" && kind !== "REGISTERED") return { ok: false, message: "That is not something to record." };
  // A booking's agreement and registration are the developer's record, as the booking is.
  if (g.via) return { ok: false, message: "The developer records the agreement and the registration." };
  const r = await recordMilestone({ orgId: g.orgId, userId: g.userId, leadId, kind, day, today: todayIst() });
  if (!r.ok) return r;
  // The agreement makes the held flat the buyer's.
  if (kind === "AGREEMENT") await convertBlocks(g.orgId, leadId);
  revalidatePath(`/dashboard/leads/${leadId}`);
  return { ok: true, message: "Saved." };
}

/** What outcomes are worth to the platforms, and how long a booking waits. */
export async function saveValuesAction(_prev: MilestoneResult | null, form: FormData): Promise<MilestoneResult> {
  const g = await requirePermission("campaign.budget:manage");
  const v = readValues({
    qualified: String(form.get("qualified") ?? ""),
    visit: String(form.get("visit") ?? ""),
    booking: String(form.get("booking") ?? ""),
    holdDays: String(form.get("holdDays") ?? ""),
  });
  if ("error" in v) return { ok: false, message: v.error };
  await saveValues({ orgId: g.orgId, userId: g.userId, values: v });
  revalidatePath("/dashboard/settings/connections");
  return { ok: true, message: "Saved. New outcomes carry these values." };
}
