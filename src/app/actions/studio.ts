"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { withTenant } from "@/lib/db";
import { addBackdrop, editBlock, generateBlocks, removeBackdrop } from "@/lib/creative";
import { isSegment, type Segment } from "@/lib/creative-rules";
import { isCardAngle, type CardAngle } from "@/lib/card-angle-rules";
import { loadBrief, setBriefHook } from "@/lib/campaign";
import { makeOnePost, removePost } from "@/lib/compose";
import { isPostKind, slideCount } from "@/lib/compose-rules";
import { dismissReel, enqueueReel, retryReel, reviseFilm, startReelWorker, stopReel } from "@/lib/reel";
import { flash } from "@/lib/flash";

/**
 * Campaign Studio's writes.
 *
 * Generation is `campaign:create`, the same key that writes the brief. It is
 * deliberately not `campaign:publish`: writing a variant and putting it in
 * front of a buyer are different powers, and nothing here reaches a buyer.
 * Every verdict these produce is reached by `gateCopy()` on the server, so a
 * caller cannot ask for copy and be handed a PASS.
 */

/**
 * Back to the studio. `params` are fixed flags the page knows the words for;
 * a message travels signed through `flash()` so the page shows only ours.
 */
function back(briefId: string, params: Record<string, string> = {}, error?: string): never {
  const q = [new URLSearchParams(params).toString(), error ? flash("error", error) : ""].filter(Boolean).join("&");
  redirect(`/dashboard/campaigns/brief/${briefId}/studio${q ? `?${q}` : ""}`);
}

export type StudioState = { ok: boolean; message: string } | null;

type Authz = Awaited<ReturnType<typeof requirePermission>>["authz"];

/**
 * Whether this person may make things for this brief: the key held where the
 * brief sits, not merely somewhere. Everything that spends goes through it.
 */
async function mayMakeFor(orgId: string, authz: Authz, briefId: string): Promise<boolean> {
  const view = await loadBrief(orgId, briefId);
  return !!view && authz.canAt("campaign:create", view.node.path);
}

const NOT_YOURS = "That campaign is not one you can make posts for.";

/** A row of this kind on this brief, and a brief this person makes posts for. */
async function mayTouchOnBrief(orgId: string, authz: Authz, briefId: string, table: "rendered_posts" | "generated_media", id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(String(id ?? "")) || !/^[0-9a-f-]{36}$/i.test(String(briefId ?? ""))) return false;
  const rows = await withTenant(orgId, (sql) =>
    table === "rendered_posts"
      ? sql<{ brief_id: string | null }[]>`SELECT brief_id FROM rendered_posts WHERE org_id = ${orgId} AND id = ${id}`
      : sql<{ brief_id: string | null }[]>`SELECT brief_id FROM generated_media WHERE org_id = ${orgId} AND id = ${id}`,
  );
  return rows[0]?.brief_id === briefId && (await mayMakeFor(orgId, authz, briefId));
}

/** A video job on this brief, and a brief this person makes posts for. */
async function mayTouchJob(orgId: string, authz: Authz, briefId: string, jobId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(String(jobId ?? ""))) return false;
  const [job] = await withTenant(orgId, (sql) => sql<{ brief_id: string }[]>`
    SELECT brief_id FROM reel_jobs WHERE org_id = ${orgId} AND id = ${jobId}`);
  return !!job && job.brief_id === briefId && (await mayMakeFor(orgId, authz, briefId));
}

/**
 * Write every block the brief asks for.
 *
 * It returns rather than redirects, because a run is slow: the button has to
 * be able to say it is working, and a redirect to the same URL would blink
 * the page at the end of a minute the person spent watching it.
 */
export async function generateCopyAction(
  _previous: StudioState,
  formData: FormData,
): Promise<StudioState> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  const briefId = String(formData.get("briefId") ?? "");
  if (!(await mayMakeFor(orgId, authz, briefId))) return { ok: false, message: NOT_YOURS };

  // "English|END_USER|GENERAL" per card (the angle may be left off for a
  // general card). Absent means every card the brief asks for.
  // Unknown pairs are dropped inside `generateBlocks`, which only writes what
  // the brief still plans, so a stale tab naming a dropped language writes
  // nothing rather than something nobody asked for.
  const only = formData
    .getAll("only")
    .map(String)
    .map((k) => {
      const [language, segment, angle] = k.split("|");
      return { language, segment, angle: isCardAngle(angle) ? angle : "GENERAL" };
    })
    .filter((o): o is { language: string; segment: Segment; angle: CardAngle } => !!o.language && isSegment(o.segment));

  const result = await generateBlocks({ orgId, actorUserId: userId, briefId, only });
  revalidatePath(`/dashboard/campaigns/brief/${briefId}/studio`);

  if (!result.ok) return { ok: false, message: result.message };
  const parts = [
    `${result.written} block${result.written === 1 ? "" : "s"} written`,
    `${result.passed} cleared`,
  ];
  if (result.held) parts.push(`${result.held} on hold`);
  if (result.failed) parts.push(`${result.failed} blocked`);
  // A stop keeps what was already written, so the screen has to say that the
  // rest are the previous run's rather than let them pass for new ones.
  return {
    ok: true,
    message: result.stopped
      ? `Stopped. ${parts.join(", ")}. The others are from the last run.`
      : `${parts.join(", ")}.`,
  };
}

export type EditState = { ok: boolean; message: string; reasons?: string[] } | null;

/**
 * A card's words changed by a person. Gated like a model's, and saved only
 * when the gate rates them no worse than the card was.
 */
export async function editCopyAction(_previous: EditState, formData: FormData): Promise<EditState> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  const briefId = String(formData.get("briefId") ?? "");
  const copyId = String(formData.get("copyId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(copyId) || !(await mayMakeFor(orgId, authz, briefId))) {
    return { ok: false, message: NOT_YOURS };
  }
  const result = await editBlock({
    orgId,
    actorUserId: userId,
    briefId,
    copyId,
    seenAt: String(formData.get("seenAt") ?? ""),
    copy: {
      headline: String(formData.get("headline") ?? ""),
      body: String(formData.get("body") ?? ""),
      cta: String(formData.get("cta") ?? ""),
    },
  });
  if (!result.ok) return { ok: false, message: result.message, reasons: result.reasons?.map((r) => r.detail) };
  revalidatePath(`/dashboard/campaigns/brief/${briefId}/studio`);
  return { ok: true, message: result.verdict === "PASS" ? "Saved. Cleared." : "Saved." };
}

export async function addBackdropAction(
  _previous: StudioState,
  formData: FormData,
): Promise<StudioState> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  const briefId = String(formData.get("briefId") ?? "");
  if (!(await mayMakeFor(orgId, authz, briefId))) return { ok: false, message: NOT_YOURS };

  const result = await addBackdrop({
    orgId,
    actorUserId: userId,
    briefId,
    role: String(formData.get("role") ?? ""),
    prompt: String(formData.get("prompt") ?? ""),
  });
  revalidatePath(`/dashboard/campaigns/brief/${briefId}/studio`);

  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, message: "Backdrop added." };
}

export async function removeBackdropAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  const briefId = String(formData.get("briefId") ?? "");
  if (!(await mayTouchOnBrief(orgId, authz, briefId, "generated_media", String(formData.get("id") ?? "")))) back(briefId, {}, NOT_YOURS);

  const result = await removeBackdrop({
    orgId,
    actorUserId: userId,
    id: String(formData.get("id") ?? ""),
  });

  revalidatePath(`/dashboard/campaigns/brief/${briefId}/studio`);
  if (!result.ok) back(briefId, {}, result.message ?? "Could not remove that.");
  back(briefId, { removed: "1" });
}

/**
 * Use an approved talking point as the brief's hook, from the studio.
 *
 * Back to the studio rather than to the brief, because the next thing the
 * person does is write again, and that button is on the studio.
 */
export async function applyHookAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  const briefId = String(formData.get("briefId") ?? "");
  if (!(await mayMakeFor(orgId, authz, briefId))) back(briefId, {}, NOT_YOURS);

  const result = await setBriefHook({
    orgId,
    actorUserId: userId,
    briefId,
    hook: String(formData.get("hook") ?? ""),
  });

  revalidatePath(`/dashboard/campaigns/brief/${briefId}/studio`);
  if (!result.ok) back(briefId, {}, result.message);
  back(briefId, { hook: "1" });
}

export async function removePostAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  const briefId = String(formData.get("briefId") ?? "");
  if (!(await mayTouchOnBrief(orgId, authz, briefId, "rendered_posts", String(formData.get("postId") ?? "")))) back(briefId, {}, NOT_YOURS);
  await removePost({ orgId, actorUserId: userId, postId: String(formData.get("postId") ?? "") });
  revalidatePath(`/dashboard/campaigns/brief/${briefId}/studio`);
}

/**
 * One post, for the screen that fills its placeholders one at a time.
 *
 * Called in a loop from the page rather than as one long request, so each
 * finished post replaces its placeholder straight away and Stop can land
 * between two. The kind is checked against the catalog here; everything else
 * is `makeOnePost()`'s.
 */
export async function makeOnePostAction(input: {
  briefId: string;
  kind: string;
  copyId: string;
  placement: string;
  /** A template category key, or "auto". Images and carousels. */
  template?: string;
  /** How many slides a carousel has. Held to the allowed range. */
  slides?: number;
  /** A face from the catalog, or "auto". Anything else is ignored there. */
  font?: string;
  /** The festival a festive template is built around, by key. */
  festival?: string;
}): Promise<{ ok: boolean; passed?: boolean; message: string; code?: string }> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  if (!isPostKind(input.kind)) return { ok: false, message: "Choose an image, a carousel or a video." };
  if (!(await mayMakeFor(orgId, authz, input.briefId))) return { ok: false, message: NOT_YOURS };
  const result = await makeOnePost({
    orgId,
    actorUserId: userId,
    briefId: input.briefId,
    kind: input.kind,
    copyId: input.copyId,
    placement: input.placement,
    template: input.template ?? null,
    slides: input.kind === "CAROUSEL" ? slideCount(input.slides) : undefined,
    font: input.font ?? null,
    festival: input.festival || null,
  });
  revalidatePath(`/dashboard/campaigns/brief/${input.briefId}/studio`);
  return result.ok
    ? { ok: true, passed: result.passed, message: "Made." }
    : { ok: false, message: result.message, code: result.code };
}

/**
 * Queue one story reel. It is made by a worker, not in this request: a reel
 * takes twenty to forty minutes. Locally a worker is started for it at once.
 */
export async function makeReelAction(input: {
  briefId: string;
  copyId: string;
  placement: string;
  /** A narrated story, or a film from a video template's own skill. */
  format?: "story" | "presenter";
  /** The video template whose skill makes the film. */
  template?: string | null;
  /** A face from the catalog, or "auto". */
  font?: string;
}): Promise<{ ok: boolean; jobId?: string; message: string }> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  if (!(await mayMakeFor(orgId, authz, input.briefId))) return { ok: false, message: NOT_YOURS };
  const queued = await enqueueReel({ orgId, actorUserId: userId, ...input });
  if (!queued.ok) return { ok: false, message: queued.message };
  startReelWorker(orgId, queued.jobId);
  revalidatePath(`/dashboard/campaigns/brief/${input.briefId}/studio`);
  return { ok: true, jobId: queued.jobId, message: "Started." };
}

/** Stop a reel. Stopping is the lower bar, the way stopping a schedule is. */
export async function stopReelAction(input: { briefId: string; jobId: string }): Promise<{ ok: boolean }> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  if (!(await mayTouchJob(orgId, authz, input.briefId, input.jobId))) return { ok: false };
  const ok = await stopReel(orgId, input.jobId, userId);
  revalidatePath(`/dashboard/campaigns/brief/${input.briefId}/studio`);
  return { ok };
}

/** Put away a stopped, failed or finished video card, so it stays away. */
export async function dismissReelAction(input: { briefId: string; jobId: string }): Promise<{ ok: boolean }> {
  const { orgId, authz } = await requirePermission("campaign:create");
  if (!(await mayTouchJob(orgId, authz, input.briefId, input.jobId))) return { ok: false };
  return { ok: await dismissReel(orgId, input.jobId) };
}

/** Try a failed reel again, picking up from what its last attempt kept. */
export async function retryReelAction(input: { briefId: string; jobId: string }): Promise<{ ok: boolean }> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  if (!(await mayTouchJob(orgId, authz, input.briefId, input.jobId))) return { ok: false };
  const ok = await retryReel(orgId, input.jobId, userId);
  if (ok) startReelWorker(orgId, input.jobId);
  revalidatePath(`/dashboard/campaigns/brief/${input.briefId}/studio`);
  return { ok };
}

/**
 * A new version of a film, asked for by the person. Their film goes back in
 * as the starting point, so it is processed twice and counts as two videos.
 */
export async function reviseFilmAction(input: {
  briefId: string;
  postId: string;
  note: string;
}): Promise<{ ok: boolean; jobId?: string; message: string }> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");
  if (!(await mayMakeFor(orgId, authz, input.briefId))) return { ok: false, message: NOT_YOURS };
  const queued = await reviseFilm({ orgId, actorUserId: userId, ...input });
  if (!queued.ok) return { ok: false, message: queued.message };
  startReelWorker(orgId, queued.jobId);
  revalidatePath(`/dashboard/campaigns/brief/${input.briefId}/studio`);
  return { ok: true, jobId: queued.jobId, message: "Started." };
}
