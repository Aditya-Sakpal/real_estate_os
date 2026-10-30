"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { flash } from "@/lib/flash";
import { requireAnyPermission, requirePermission } from "@/lib/guard";
import { postNodePath } from "@/lib/publish";
import {
  approveBroadcast,
  broadcastPlace,
  createBroadcast,
  previewBroadcast,
  stopBroadcast,
  type Preview,
} from "@/lib/broadcast";
import { pickStages, pickVoice, showPaise } from "@/lib/broadcast-rules";

/**
 * WhatsApp broadcasts. Three keys, each asked at the node the post
 * advertises:
 *
 *   campaign:publish         build a broadcast and see who it would reach
 *   campaign.budget:manage   approve the send, because it spends the
 *                            client's WhatsApp credit
 *   stopping                 any of creative:approve, campaign:publish or
 *                            campaign.budget:manage, the publisher's own rule
 */

export type PreviewState = ({ mayApprove: boolean } & Preview) | { ok: false; message: string };

type Filters = { nodeId?: string | null; stages?: string[]; voice?: string | null };

/** Who a broadcast of this post would reach. Counts only; no number reaches the browser. */
export async function broadcastPreviewAction(postId: string, filters: Filters): Promise<PreviewState> {
  const { orgId, authz } = await requirePermission("campaign:publish");
  const path = await postNodePath(orgId, postId);
  if (!path || !authz.canAt("campaign:publish", path)) return { ok: false, message: "You cannot broadcast this post." };
  const r = await previewBroadcast({
    orgId,
    source: { kind: "STUDIO", postId },
    nodeId: filters.nodeId ?? null,
    stages: pickStages(filters.stages ?? []),
    voice: pickVoice(filters.voice),
  });
  if (!r.ok) return { ok: false, message: r.message };
  return { ...r, mayApprove: authz.canAt("campaign.budget:manage", path) };
}

export type BroadcastResult = { ok: true; message: string; approved: boolean } | { ok: false; message: string };

/**
 * Build a broadcast, and send it when the person may also approve the
 * spend. Somebody who may only build it leaves it waiting for approval.
 */
export async function createBroadcastAction(postId: string, filters: Filters & { approve: boolean }): Promise<BroadcastResult> {
  const { userId, orgId, authz } = await requirePermission("campaign:publish");
  const path = await postNodePath(orgId, postId);
  if (!path || !authz.canAt("campaign:publish", path)) return { ok: false, message: "You cannot broadcast this post." };
  const made = await createBroadcast({
    orgId,
    userId,
    source: { kind: "STUDIO", postId },
    nodeId: filters.nodeId ?? null,
    stages: pickStages(filters.stages ?? []),
    voice: pickVoice(filters.voice),
  });
  if (!made.ok) return { ok: false, message: made.message };
  revalidatePath("/dashboard/campaigns/live");
  if (!filters.approve || !authz.canAt("campaign.budget:manage", path)) {
    return { ok: true, approved: false, message: "Saved. It goes once somebody who manages the budget approves it on Published." };
  }
  const ok = await approveBroadcast({ orgId, userId, broadcastId: made.broadcastId });
  if (!ok.ok) return { ok: false, message: `Saved, but not sent: ${ok.message}` };
  return {
    ok: true,
    approved: true,
    message: `Sending to ${ok.audience.toLocaleString("en-IN")} ${ok.audience === 1 ? "person" : "people"}, about ${showPaise(ok.billedPaise)} in messages.`,
  };
}

/** Where a form on Published goes back to, with what happened. Only inside the console. */
function backTo(formData: FormData, params: Record<string, string>): never {
  const raw = String(formData.get("back") ?? "");
  const inside = raw.startsWith("/dashboard/") && !raw.startsWith("//");
  const [path, query] = inside ? raw.split("?") : ["/dashboard/campaigns/live", ""];
  const q = new URLSearchParams();
  const view = new URLSearchParams(query ?? "").get("view");
  if (view && /^[a-z_-]{1,20}$/.test(view)) q.set("view", view);
  const parts = [q.toString()];
  for (const [k, v] of Object.entries(params)) {
    parts.push(k === "error" ? flash(k, v) : new URLSearchParams({ [k]: v }).toString());
  }
  const qs = parts.filter(Boolean).join("&");
  redirect(`${path}${qs ? `?${qs}` : ""}`);
}

/** Approve a waiting broadcast: the budget key, at its node. Its recipients are frozen then. */
export async function approveBroadcastAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("campaign.budget:manage", "/dashboard/campaigns/live");
  const id = String(formData.get("broadcastId") ?? "");
  const place = await broadcastPlace(orgId, id);
  if (!place || !authz.canAt("campaign.budget:manage", place.path)) backTo(formData, { error: "You cannot approve this broadcast." });
  const r = await approveBroadcast({ orgId, userId, broadcastId: id });
  revalidatePath("/dashboard/campaigns/live");
  if (!r.ok) backTo(formData, { error: r.message });
  backTo(formData, { broadcast: "approved" });
}

/** Stop a broadcast. Whoever may stop an ad may stop one; nobody waiting is sent anything. */
export async function stopBroadcastAction(formData: FormData): Promise<void> {
  const keys = ["creative:approve", "campaign:publish", "campaign.budget:manage"];
  const { userId, orgId, authz } = await requireAnyPermission(keys, "/dashboard/campaigns/live");
  const id = String(formData.get("broadcastId") ?? "");
  const place = await broadcastPlace(orgId, id);
  if (!place || !keys.some((k) => authz.canAt(k, place.path))) backTo(formData, { error: "You cannot stop this broadcast." });
  const r = await stopBroadcast({ orgId, userId, broadcastId: id });
  revalidatePath("/dashboard/campaigns/live");
  if (!r.ok) backTo(formData, { error: r.message });
  backTo(formData, { broadcast: "stopped" });
}
