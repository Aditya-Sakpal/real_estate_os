"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { addReference, createBrief, loadBrief, removeReference, saveBrief, setBriefStatus } from "@/lib/campaign";
import { FORMATS, LANGUAGES, MAX_MEDIA_BYTES } from "@/lib/campaign-rules";
import { resolveScopeNode } from "@/lib/scope-nodes";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/**
 * Writing campaign briefs.
 *
 * Every action reads its node or brief back inside the tenant before writing,
 * the same rule scoped invites and the Brain follow. A brief id from a form
 * is a string somebody sent us, not a brief.
 *
 * All three check `campaign:create`. There is no separate "edit" key because
 * writing a brief and rewriting it are the same act by the same person;
 * `campaign:publish` is the one that will matter, and it guards the thing
 * that spends money rather than the thing that describes it.
 */

/**
 * To a brief. `params` are fixed flags the page knows the words for; a
 * message travels signed through `flash()` so the page shows only ours.
 */
function toBrief(briefId: string, params: Record<string, string> = {}, error?: string): never {
  const q = [new URLSearchParams(params).toString(), error ? flash("error", error) : ""].filter(Boolean).join("&");
  const base = `/dashboard/campaigns/brief/${briefId}`;
  redirect(q ? `${base}?${q}` : base);
}

/** A checkbox group posts one entry per box that was ticked. */
function ticked(formData: FormData, field: string, allowed: readonly string[]): string[] {
  const raw = formData.getAll(field).map((v) => String(v));
  return allowed.filter((a) => raw.includes(a));
}

type Authz = Awaited<ReturnType<typeof requirePermission>>["authz"];

/** The brief, when this person may write briefs where it sits. */
async function writableBrief(orgId: string, authz: Authz, briefId: string) {
  const view = await loadBrief(orgId, briefId);
  return view && authz.canAt("campaign:create", view.node.path) ? view : null;
}

/**
 * Start a brief. It holds a name somebody typed, so a refusal comes back to
 * the form rather than as a redirect that would clear it.
 */
export async function createBriefAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");

  const nodeId = String(formData.get("nodeId") ?? "");
  const node = await resolveScopeNode(orgId, nodeId);
  if (!node || !authz.canAt("campaign:create", node.path)) {
    return { ok: false, message: "You cannot start a campaign here." };
  }
  const result = await createBrief({
    orgId,
    actorUserId: userId,
    nodeId,
    name: String(formData.get("name") ?? ""),
  });

  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath("/dashboard/campaigns");
  // Straight into the brief that was just created. Landing back on the list
  // would make somebody hunt for the row they just made.
  toBrief(result.briefId, { edit: "1" });
}

export async function saveBriefAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");

  const briefId = String(formData.get("briefId") ?? "");
  if (!(await writableBrief(orgId, authz, briefId))) {
    return { ok: false, message: "That brief is not one you can change." };
  }
  const result = await saveBrief({
    orgId,
    actorUserId: userId,
    briefId,
    input: {
      name: String(formData.get("name") ?? ""),
      objective: String(formData.get("objective") ?? "") || null,
      audience: String(formData.get("audience") ?? "") || null,
      microMarkets: String(formData.get("microMarkets") ?? "") || null,
      languages: ticked(formData, "languages", LANGUAGES),
      formats: ticked(formData, "formats", FORMATS),
      // Not filtered against a catalog here, because the catalog for these is
      // the tenant's own towers. `saveBrief()` asks the database which of
      // them resolve to a configuration under this brief's node and keeps
      // only those.
      unitTypeIds: formData.getAll("unitTypeIds").map(String),
      cta: String(formData.get("cta") ?? "") || null,
      hook: String(formData.get("hook") ?? "") || null,
      offers: String(formData.get("offers") ?? "") || null,
    },
  });

  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath("/dashboard/campaigns");
  toBrief(briefId, { saved: "1" });
}

/**
 * Mark a brief ready, or send it back for a rewrite.
 *
 * The status arrives bound to the button rather than as a form field, so a
 * page cannot post one state while showing the other. Next's server-action
 * encoding drops a submit button's own name and value, which is the bug the
 * Brain's sign buttons hit.
 */
export async function setBriefStatusAction(
  status: "DRAFT" | "READY",
  formData: FormData,
): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");

  const briefId = String(formData.get("briefId") ?? "");
  if (!(await writableBrief(orgId, authz, briefId))) {
    toBrief(briefId, {}, "That brief is not one you can change.");
  }
  const result = await setBriefStatus({ orgId, actorUserId: userId, briefId, status });

  if (!result.ok) toBrief(briefId, {}, result.message);

  revalidatePath("/dashboard/campaigns");
  toBrief(briefId, status === "READY" ? { ready: "1" } : { reopened: "1" });
}

/**
 * Filing a reference does not navigate.
 *
 * It used to redirect back to the brief, which is what every other action on
 * this screen does and what made this one destructive. The references sit
 * BESIDE the brief form rather than inside it, so a redirect re-rendered the
 * form from the database and threw away everything typed into it but not yet
 * saved. Somebody uploading the video that worked lost the audience, the
 * micro-markets and the hook they had just written, and the only sign of it
 * was the page going blank and coming back emptier.
 *
 * So these two return state instead. `revalidatePath()` brings the new tile
 * back on its own, React reconciles rather than remounting, and an
 * uncontrolled input keeps whatever is in it.
 *
 * The kind is bound to the action rather than posted as a field, for the
 * reason the Brain's sign buttons are: Next's server-action encoding drops a
 * submit button's own name and value, so a page with two add buttons would
 * send the same kind from both.
 */
export type ReferenceState = { ok: boolean; message: string } | null;

export async function addReferenceAction(
  kind: "WORKED" | "AVOID",
  _previous: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");

  const briefId = String(formData.get("briefId") ?? "");
  if (!(await writableBrief(orgId, authz, briefId))) {
    return { ok: false, message: "That brief is not one you can change." };
  }
  const file = formData.get("media");

  // The size is checked before the bytes are read. `file.arrayBuffer()` pulls
  // the whole upload into memory, so checking afterwards means a 200 MB file
  // has already been held before anything refuses it.
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose an image or a video to upload." };
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return {
      ok: false,
      message: "That file is over 25 MB. Trim the clip or export it smaller.",
    };
  }

  const result = await addReference({
    orgId,
    actorUserId: userId,
    briefId,
    kind,
    note: String(formData.get("note") ?? "") || null,
    media: {
      bytes: Buffer.from(await file.arrayBuffer()),
      type: file.type,
      name: file.name || null,
    },
  });

  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(`/dashboard/campaigns/brief/${briefId}`);
  return { ok: true, message: "Added." };
}

export async function removeReferenceAction(
  _previous: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { userId, orgId, authz } = await requirePermission("campaign:create");

  const briefId = String(formData.get("briefId") ?? "");
  if (!(await writableBrief(orgId, authz, briefId))) {
    return { ok: false, message: "That brief is not one you can change." };
  }
  const result = await removeReference({
    orgId,
    actorUserId: userId,
    briefId,
    referenceId: String(formData.get("referenceId") ?? ""),
  });

  if (!result.ok) return { ok: false, message: "That reference is already gone." };

  revalidatePath(`/dashboard/campaigns/brief/${briefId}`);
  return { ok: true, message: "Removed." };
}
