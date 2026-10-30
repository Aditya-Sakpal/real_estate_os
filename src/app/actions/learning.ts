"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { requirePermission } from "@/lib/guard";
import { addCompetitorAd, removeCompetitorAd } from "@/lib/competitor";
import { refreshLearning, saveLearningSettings } from "@/lib/learning";
import { isUuid } from "@/lib/capture-rules";

/**
 * Competitor ads and how much the market counts. Saving an ad is
 * `campaign:create` where it is saved, the key that makes the campaigns it
 * will steer; the weight is the same key held at the organisation, because
 * it steers every project's creative.
 */

export type LearningResult = { ok: boolean; message: string };

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

async function nodePath(orgId: string, nodeId: string): Promise<string | null> {
  if (!isUuid(nodeId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`
      SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId} AND kind IN ('PROJECT', 'PHASE')`;
    return r?.path ?? null;
  });
}

export async function addCompetitorAdAction(_prev: LearningResult | null, form: FormData): Promise<LearningResult> {
  const g = await requirePermission("campaign:create");
  const nodeId = String(form.get("nodeId") ?? "");
  const path = await nodePath(g.orgId, nodeId);
  if (!path) return { ok: false, message: "Choose one of your projects or towers to compare it with." };
  if (!g.authz.canAt("campaign:create", path)) return { ok: false, message: "You cannot add ads for that project." };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose the ad's picture or video." };
  const r = await addCompetitorAd({
    orgId: g.orgId,
    userId: g.userId,
    nodeId,
    file: { bytes: Buffer.from(await file.arrayBuffer()), type: file.type },
    carousel: form.get("carousel") === "on",
    form: {
      competitor: String(form.get("competitor") ?? ""),
      projectName: String(form.get("projectName") ?? ""),
      locality: String(form.get("locality") ?? ""),
      platform: String(form.get("platform") ?? ""),
      runningSince: String(form.get("runningSince") ?? ""),
    },
    today: todayIst(),
  });
  if (!r.ok) return r;
  // The card on the brief moves at once, not tomorrow morning.
  await refreshLearning(g.orgId).catch(() => null);
  revalidatePath("/dashboard/library/market");
  if (!r.read) return { ok: true, message: "Saved, but the ad could not be read, so it does not count yet." };
  if (r.flagged) return { ok: true, message: "Saved. It makes a claim no ad of yours may make, so it is kept out of the scores." };
  return { ok: true, message: "Saved and read." };
}

export async function removeCompetitorAdAction(form: FormData): Promise<void> {
  const g = await requirePermission("campaign:create");
  const id = String(form.get("id") ?? "");
  if (!isUuid(id)) return;
  const done = await removeCompetitorAd({ orgId: g.orgId, userId: g.userId, id, scopes: g.authz.scopesFor("campaign:create") });
  if (done) await refreshLearning(g.orgId).catch(() => null);
  revalidatePath("/dashboard/library/market");
}

export async function saveMarketWeightAction(_prev: LearningResult | null, form: FormData): Promise<LearningResult> {
  const g = await requirePermission("campaign:create");
  const [root] = await withTenant(g.orgId, (sql) => sql<{ path: string }[]>`
    SELECT path::text AS path FROM scope_nodes WHERE org_id = ${g.orgId} AND kind = 'ORG' LIMIT 1`);
  if (!root || !g.authz.canAt("campaign:create", root.path)) return { ok: false, message: "Only somebody who makes campaigns for the whole organisation can change this." };
  const n = Number(String(form.get("marketWeight") ?? "").replace(/[^\d]/g, "") || "NaN");
  const r = await saveLearningSettings({ orgId: g.orgId, userId: g.userId, marketWeight: n });
  revalidatePath("/dashboard/library/market");
  return r;
}
