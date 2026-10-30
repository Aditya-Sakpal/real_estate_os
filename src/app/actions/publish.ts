"use server";

import { flash } from "@/lib/flash";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAnyPermission, requirePermission } from "@/lib/guard";
import { placeCampaign } from "@/lib/ad-budget";
import { withTenant } from "@/lib/db";
import {
  activatePublication,
  briefNodePath,
  endAlwaysOn,
  loadControl,
  requestAlwaysOn,
  markTakenDown,
  pausePublication,
  postNodePath,
  publishOptions,
  requestPublish,
  retryPublication,
  type DestinationOption,
  type RequestResult,
} from "@/lib/publish";

/**
 * Publishing, and the controls on what was published.
 *
 * Three keys, each for the power it names, and each checked at the node the
 * post advertises rather than anywhere in the organisation:
 *
 *   campaign:publish         put a post out, or create a paused ad
 *   campaign.budget:manage   switch an ad's spend on
 *   stopping                 any of creative:approve, campaign:publish or
 *                            campaign.budget:manage. Stopping is the lower
 *                            bar; a kill switch only the person who started
 *                            the spend can pull is not a kill switch.
 */

export type OptionsState =
  | { ok: true; options: DestinationOption[]; website: string | null }
  | { ok: false; message: string };

/** What this post could go to. Asked when the panel opens, not for every post on the page. */
export async function publishOptionsAction(postId: string): Promise<OptionsState> {
  const { orgId, authz } = await requirePermission("campaign:publish");
  const path = await postNodePath(orgId, postId);
  if (!path || !authz.canAt("campaign:publish", path)) return { ok: false, message: "You cannot publish this post." };
  const r = await publishOptions(orgId, postId);
  return r.ok ? { ok: true, options: r.options, website: r.website } : { ok: false, message: r.message };
}

export async function publishPostAction(input: {
  postId: string;
  briefId: string;
  destinations: string[];
  dailyBudget: string;
  destinationUrl: string;
  adGoal?: string | null;
}): Promise<{ ok: boolean; message: string; results: RequestResult[] }> {
  const { userId, orgId, authz } = await requirePermission("campaign:publish");
  const path = await postNodePath(orgId, input.postId);
  if (!path || !authz.canAt("campaign:publish", path)) {
    return { ok: false, message: "You cannot publish this post.", results: [] };
  }
  const r = await requestPublish({
    orgId,
    userId,
    postId: input.postId,
    destinations: input.destinations,
    dailyBudget: input.dailyBudget,
    destinationUrl: input.destinationUrl,
    adGoal: input.adGoal ?? null,
  });
  revalidatePath(`/dashboard/campaigns/brief/${input.briefId}/studio`);
  revalidatePath("/dashboard/campaigns/live");
  if (!r.ok) return { ok: false, message: r.message, results: [] };
  const good = r.results.filter((x) => x.ok).length;
  return {
    ok: good > 0,
    message: good === r.results.length ? "Done." : good ? "Some of it went." : "Nothing went.",
    results: r.results,
  };
}

function backTo(formData: FormData, params: Record<string, string>): never {
  const raw = String(formData.get("back") ?? "");
  // Only somewhere inside the console: a form field is not a redirect target.
  const inside = raw.startsWith("/dashboard/") && !raw.startsWith("//");
  const [path, query] = inside ? raw.split("?") : ["/dashboard/campaigns/live", ""];
  // The view the person was on survives; every message is signed, so the
  // page shows only what an action here wrote.
  const q = new URLSearchParams();
  const view = new URLSearchParams(query ?? "").get("view");
  if (view && /^[a-z_-]{1,20}$/.test(view)) q.set("view", view);
  const parts = [q.toString()];
  for (const [k, v] of Object.entries(params)) {
    parts.push(k === "error" || k === "note" ? flash(k, v) : new URLSearchParams({ [k]: v }).toString());
  }
  const qs = parts.filter(Boolean).join("&");
  redirect(`${path}${qs ? `?${qs}` : ""}`);
}

const STOP_KEYS = ["creative:approve", "campaign:publish", "campaign.budget:manage"];

/** The permission, held at the node the publication advertises. */
async function guardAt(targetId: string, keys: string[]) {
  const guarded = await requireAnyPermission(keys, "/dashboard/campaigns/live");
  const row = await loadControl(guarded.orgId, targetId);
  if (!row || !keys.some((k) => guarded.authz.canAt(k, row.scope_node_path))) return null;
  return guarded;
}

export async function pausePublicationAction(formData: FormData): Promise<void> {
  const targetId = String(formData.get("targetId") ?? "");
  const g = await guardAt(targetId, STOP_KEYS);
  if (!g) backTo(formData, { error: "You cannot stop this ad." });
  const r = await pausePublication({ orgId: g!.orgId, userId: g!.userId, targetId });
  revalidatePath("/dashboard/campaigns/live");
  if (!r.ok) backTo(formData, { error: r.message });
  backTo(formData, { paused: "1" });
}

export async function activatePublicationAction(formData: FormData): Promise<void> {
  const targetId = String(formData.get("targetId") ?? "");
  const g = await guardAt(targetId, ["campaign.budget:manage"]);
  if (!g) backTo(formData, { error: "Switching spend on needs the budget permission for this project." });
  const r = await activatePublication({ orgId: g!.orgId, userId: g!.userId, targetId });
  revalidatePath("/dashboard/campaigns/live");
  if (!r.ok) backTo(formData, { error: r.message });
  backTo(formData, { activated: "1" });
}

export async function retryPublicationAction(formData: FormData): Promise<void> {
  const targetId = String(formData.get("targetId") ?? "");
  const g = await guardAt(targetId, ["campaign:publish"]);
  if (!g) backTo(formData, { error: "You cannot publish this." });
  const r = await retryPublication({ orgId: g!.orgId, userId: g!.userId, targetId });
  revalidatePath("/dashboard/campaigns/live");
  if (!r.ok) backTo(formData, { error: r.message });
  if (r.state === "FAILED") backTo(formData, { error: `Tried again, and it still did not go out. ${r.error ?? ""}`.trim() });
  backTo(formData, { retried: "1" });
}

export async function takenDownAction(formData: FormData): Promise<void> {
  const targetId = String(formData.get("targetId") ?? "");
  const g = await guardAt(targetId, STOP_KEYS);
  if (!g) backTo(formData, { error: "You cannot change this." });
  const r = await markTakenDown({ orgId: g!.orgId, userId: g!.userId, targetId });
  revalidatePath("/dashboard/campaigns/live");
  if (!r.ok) backTo(formData, { error: r.message });
  backTo(formData, { down: "1" });
}

/**
 * Start one of a brief's always-on Google campaigns. Created paused, like
 * every ad here, so starting it is the publish key at the brief's node;
 * switching its spend on is the budget key, on Published.
 */
export async function startAlwaysOnAction(formData: FormData): Promise<void> {
  const briefId = String(formData.get("briefId") ?? "");
  const back = `/dashboard/campaigns/brief/${briefId}/schedule`;
  const { orgId, userId, authz } = await requirePermission("campaign:publish", back);
  const path = await briefNodePath(orgId, briefId);
  if (!path || !authz.canAt("campaign:publish", path)) {
    redirect(`${back}?${flash("error", "You cannot publish for this campaign.")}`);
  }
  const r = await requestAlwaysOn({
    orgId,
    userId,
    briefId,
    destination: String(formData.get("destination") ?? ""),
    dailyBudget: String(formData.get("dailyBudget") ?? ""),
    destinationUrl: String(formData.get("destinationUrl") ?? ""),
  });
  revalidatePath(back);
  revalidatePath("/dashboard/campaigns/live");
  if (!r.ok) redirect(`${back}?${flash("error", r.message)}`);
  if (r.state === "FAILED") redirect(`${back}?${flash("error", r.message)}`);
  redirect(`${back}?${flash("note", r.message)}`);
}

/** End a brief's always-on campaign for good. Stopping is the lower bar. */
export async function endAlwaysOnAction(formData: FormData): Promise<void> {
  const targetId = String(formData.get("targetId") ?? "");
  const g = await guardAt(targetId, STOP_KEYS);
  if (!g) backTo(formData, { error: "You cannot stop this campaign." });
  const r = await endAlwaysOn({ orgId: g!.orgId, userId: g!.userId, targetId });
  revalidatePath("/dashboard/campaigns/live");
  if (!r.ok) backTo(formData, { error: r.message });
  backTo(formData, { note: "Ended. It no longer runs, and a new one can be started." });
}

/**
 * A campaign made in Ads Manager placed on a tower, so its spend and its
 * leads count there. The budget key, at that tower: it decides whose money
 * this was.
 */
export async function placeCampaignAction(formData: FormData): Promise<void> {
  const accountId = String(formData.get("accountId") ?? "");
  const campaignId = String(formData.get("campaignId") ?? "");
  const phaseId = String(formData.get("phaseId") ?? "");
  const g = await requirePermission("campaign.budget:manage", "/dashboard/campaigns/live");
  const ok = /^[0-9a-f-]{36}$/.test(phaseId) && /^[0-9a-f-]{36}$/.test(accountId);
  const path = ok
    ? await withTenant(g.orgId, async (sql) => {
        const [n] = await sql<{ path: string }[]>`SELECT path::text FROM scope_nodes WHERE org_id = ${g.orgId} AND id = ${phaseId} AND kind = 'PHASE'`;
        return n?.path ?? null;
      })
    : null;
  if (!path) backTo(formData, { error: "Choose a tower." });
  if (!g.authz.canAt("campaign.budget:manage", path!)) backTo(formData, { error: "Placing spend on that tower needs the budget permission there." });
  const r = await placeCampaign({ orgId: g.orgId, userId: g.userId, accountId, campaignId, phaseId });
  revalidatePath("/dashboard/campaigns/live");
  revalidatePath("/dashboard/reports");
  if (!r.ok) backTo(formData, { error: r.message });
  backTo(formData, { note: "Placed. Its spend and leads now count on that tower." });
}
