"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { flash } from "@/lib/flash";
import { resolveScopeNode } from "@/lib/scope-nodes";
import { isNodeId } from "@/lib/scope-rules";
import { assetKey, readAsset, removeAsset, storage } from "@/lib/storage";
import type { FormResult } from "@/components/KeptForm";
import {
  addAsset,
  approveAsset,
  assetPlace,
  copyAssetsTo,
  removeAssetRow,
  renameAsset,
  replaceAsset,
} from "@/lib/asset";
import {
  canUploadAsset,
  isAssetCategory,
  isRenderFor,
  istDay,
  MAX_ASSET_BYTES,
} from "@/lib/asset-rules";

/**
 * Writing the Approved Asset Library.
 *
 * `asset:manage` adds and removes; `asset:approve` is a different key held by
 * a different person. Whoever uploads a render must not thereby be able to
 * declare it fit to advertise, which is the same split the Brain's three
 * signatures exist to enforce.
 *
 * Every action asks the key AT the node it touches, not merely somewhere:
 * a Marketing Executive on Tower A holds `asset:manage` there and nowhere
 * else, and an id from a form can name any node in the organisation.
 */

/** Back to one node's library. Only a signed message is ever shown. */
function back(nodeId: string, error?: string): never {
  const base = isNodeId(nodeId) ? `/dashboard/library/${nodeId}` : "/dashboard/library";
  redirect(error ? `${base}?${flash("error", error)}` : base);
}

const NOT_HERE = "You cannot change the library here.";

export type UploadState = { ok: boolean; message: string } | null;

/**
 * Upload a batch, without leaving the page.
 *
 * It does not redirect. A server action that revalidates and returns lets
 * Next re-render the tree in place, so the list updates and nothing blinks;
 * redirecting to the same URL with a query parameter is a full navigation,
 * and on an upload that takes seconds it reads as the page dying and coming
 * back. The result is handed to `useActionState` and shown beside the button.
 *
 * One form for the whole page, not one per category, and it takes several
 * files at once. It used to be nine forms with nine file pickers: a person
 * would fill four of them, click one Upload, and HTML would do exactly what
 * it should, which is submit that form and discard the rest. Every other
 * picker then cleared on the re-render, and it read as losing work. A page
 * with one picker on it cannot do that.
 *
 * Size is checked before any bytes are read: `arrayBuffer()` pulls a file
 * into memory, and checking afterwards means holding a 500 MB upload before
 * anything refuses it.
 */
export async function addAssetsAction(
  _previous: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const { userId, orgId, authz } = await requirePermission("asset:manage");

  const nodeId = String(formData.get("nodeId") ?? "");
  const node = await resolveScopeNode(orgId, nodeId);
  if (!node) return { ok: false, message: "That is not a place in this organisation." };
  if (!authz.canAt("asset:manage", node.path)) return { ok: false, message: NOT_HERE };

  const category = String(formData.get("category") ?? "");
  if (!isAssetCategory(category)) {
    return { ok: false, message: "Choose what kind of asset this is." };
  }

  const files = formData.getAll("media").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return { ok: false, message: "Choose at least one file to upload." };

  const capturedOn = String(formData.get("capturedOn") ?? "").trim() || null;

  // Every file is asked before any is stored, so a refusal on the fourth
  // does not leave three filed and the batch half done. It reads the size
  // the browser declared, before any bytes are pulled into memory.
  const today = istDay(new Date());
  for (const file of files) {
    const verdict = canUploadAsset({
      category,
      nodeKind: node.kind,
      mediaType: file.type,
      mediaBytes: file.size,
      capturedOn,
      today,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        message: verdict.code === "DATE_REQUIRED" || verdict.code === "DATE_INVALID" ||
          verdict.code === "DATE_FUTURE" || verdict.code === "WRONG_LEVEL"
          ? verdict.message
          : `${file.name}: ${verdict.message} Nothing was uploaded.`,
      };
    }
  }

  // One at a time through the same gate, the way `importInvites()` calls
  // `createInvite()` per row: a second write path is a second place for the
  // rules to drift, and the one that drifts is the one nobody reads.
  let added = 0;
  for (const file of files) {
    const result = await addAsset({
      orgId,
      actorUserId: userId,
      nodeId,
      category,
      // The filename is the title until somebody renames it. Naming a batch
      // during upload is a field that cannot apply to more than one file.
      title: file.name.replace(/[.][^.]+$/, "").replace(/[_-]+/g, " ").trim() || null,
      // A photograph is the exception, so the box says "these are
      // photographs" and leaving it unticked means renders. Section 08
      // requires the artist's impression line wherever provenance says
      // render, and defaulting the other way would quietly drop it. A
      // category that is a photograph by nature is never a render.
      isRender: isRenderFor(category, formData.get("photograph") !== null),
      capturedOn,
      media: {
        bytes: Buffer.from(await file.arrayBuffer()),
        type: file.type,
        name: file.name || null,
      },
    });
    // The first refusal stops the batch and says which file it was, rather
    // than uploading four and failing silently on the fifth.
    if (!result.ok) {
      revalidatePath(`/dashboard/library/${nodeId}`);
      return {
        ok: false,
        message: added
          ? `${added} uploaded, then ${file.name} was refused. ${result.message}`
          : `${file.name}: ${result.message}`,
      };
    }
    added += 1;
  }

  revalidatePath(`/dashboard/library/${nodeId}`);
  return { ok: true, message: added === 1 ? "1 file uploaded." : `${added} files uploaded.` };
}

/**
 * Rename one asset. It returns rather than redirects, so a refusal is shown
 * beside the field and the name that was typed stays in it.
 */
export async function renameAssetAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("asset:manage");

  const assetId = String(formData.get("assetId") ?? "");
  const place = await assetPlace(orgId, assetId);
  if (!place) return { ok: false, message: "That asset is no longer in the library." };
  if (!authz.canAt("asset:manage", place.path)) return { ok: false, message: NOT_HERE };

  const title = String(formData.get("title") ?? "").trim();
  if (title.length > 120) return { ok: false, message: "Keep the name under 120 characters." };

  const result = await renameAsset({ orgId, actorUserId: userId, assetId, title: title || null });
  if (!result.ok) return { ok: false, message: "That asset is no longer in the library." };

  // No redirect on success, for the reason the upload does not: the list
  // re-renders in place and the page does not blink.
  revalidatePath(`/dashboard/library/${place.nodeId}`);
  return null;
}

export async function approveAssetAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("asset:approve");

  const nodeId = String(formData.get("nodeId") ?? "");
  const assetId = String(formData.get("assetId") ?? "");
  const place = await assetPlace(orgId, assetId);
  if (!place) back(nodeId, "That asset is no longer in the library.");
  if (!authz.canAt("asset:approve", place.path)) back(nodeId, "You cannot approve assets here.");

  const result = await approveAsset({ orgId, actorUserId: userId, assetId });
  if (!result.ok) back(nodeId, result.message);

  revalidatePath(`/dashboard/library/${place.nodeId}`);
}

export async function removeAssetAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("asset:manage");

  const nodeId = String(formData.get("nodeId") ?? "");
  const assetId = String(formData.get("assetId") ?? "");
  const place = await assetPlace(orgId, assetId);
  if (!place) back(nodeId, "That asset is already gone.");
  if (!authz.canAt("asset:manage", place.path)) back(nodeId, NOT_HERE);

  const result = await removeAssetRow({ orgId, actorUserId: userId, assetId });
  if (!result.ok) back(nodeId, "That asset is already gone.");

  revalidatePath(`/dashboard/library/${place.nodeId}`);
}

export type CopyState = { ok: boolean; message: string } | null;

/**
 * Copy chosen assets to another node.
 *
 * The reason the library exists: a clubhouse render shot once should not be
 * uploaded again for the next tower. Like the upload, it returns rather than
 * redirects, so the page does not blink.
 *
 * Approvals deliberately do not travel. `copyAssetsTo()` carries the reason.
 */
export async function copyAssetsAction(
  _previous: CopyState,
  formData: FormData,
): Promise<CopyState> {
  const { userId, orgId, authz } = await requirePermission("asset:manage");

  const toNodeId = String(formData.get("toNodeId") ?? "");
  const assetIds = formData.getAll("assetIds").map(String);
  if (!assetIds.length) return { ok: false, message: "Choose at least one asset to copy." };
  if (!toNodeId) return { ok: false, message: "Choose where to copy them." };

  // The key at the TARGET. The screen offers only places this person may
  // add to, and the screen is presentation: holding `asset:manage` on Tower
  // A is not a licence to file on Tower B.
  const to = await resolveScopeNode(orgId, toNodeId);
  if (!to) return { ok: false, message: "That is not a place in this organisation." };
  if (!authz.canAt("asset:manage", to.path)) {
    return { ok: false, message: `You cannot add to the library on ${to.name}.` };
  }

  const result = await copyAssetsTo({
    orgId,
    actorUserId: userId,
    assetIds,
    toNodeId,
    mayTakeFrom: (path) => authz.canAt("asset:read", path),
  });
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(`/dashboard/library/${toNodeId}`);
  const fromNodeId = String(formData.get("nodeId") ?? "");
  if (isNodeId(fromNodeId)) revalidatePath(`/dashboard/library/${fromNodeId}`);
  return {
    ok: true,
    message:
      result.copied === 1
        ? "1 asset copied. It arrives unapproved."
        : `${result.copied} assets copied. They arrive unapproved.`,
  };
}

/** Put new bytes behind an asset, as a version rather than an overwrite. */
export async function replaceAssetAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("asset:manage");

  const nodeId = String(formData.get("nodeId") ?? "");
  const assetId = String(formData.get("assetId") ?? "");
  const place = await assetPlace(orgId, assetId);
  if (!place) back(nodeId, "That asset is no longer in the library.");
  if (!authz.canAt("asset:manage", place.path)) back(nodeId, NOT_HERE);

  const file = formData.get("media");
  if (!(file instanceof File) || file.size === 0) back(nodeId, "Choose a file to put in its place.");
  if (file.size > MAX_ASSET_BYTES) back(nodeId, "That file is over 100 MB.");

  const result = await replaceAsset({
    orgId,
    actorUserId: userId,
    assetId,
    media: {
      bytes: Buffer.from(await file.arrayBuffer()),
      type: file.type,
      name: file.name || null,
    },
  });

  if (!result.ok) back(nodeId, result.message);
  revalidatePath(`/dashboard/library/${place.nodeId}`);
}

/** One file of a batch, as the browser describes it before sending it. */
export type UploadFile = { name: string; type: string; size: number };

export type UploadPlan =
  | { state: "store"; files: { key: string; url: string }[] }
  | { state: "direct" }
  | { state: "refused"; message: string };

/**
 * Start a batch that goes straight to the file store.
 *
 * A hosted function takes a request body of about 4.5 MB, so five renders
 * sent through the action were refused before any rule saw them. Each file
 * is PUT to its own short-lived link instead, and `finishAssetUpload()`
 * files it. Every file is asked first, as the batch always was. A store
 * that takes no links (the local folder) answers "direct", and the batch
 * goes through `addAssetsAction()` as before.
 */
export async function beginAssetUpload(input: {
  nodeId: string;
  category: string;
  capturedOn: string | null;
  files: UploadFile[];
}): Promise<UploadPlan> {
  const { orgId, authz } = await requirePermission("asset:manage");
  const node = await resolveScopeNode(orgId, String(input.nodeId ?? ""));
  if (!node) return { state: "refused", message: "That is not a place in this organisation." };
  if (!authz.canAt("asset:manage", node.path)) return { state: "refused", message: NOT_HERE };
  if (!isAssetCategory(input.category)) return { state: "refused", message: "Choose what kind of asset this is." };
  const files = Array.isArray(input.files) ? input.files.slice(0, MAX_BATCH) : [];
  if (!files.length) return { state: "refused", message: "Choose at least one file to upload." };
  const today = istDay(new Date());
  for (const file of files) {
    const verdict = canUploadAsset({
      category: input.category,
      nodeKind: node.kind,
      mediaType: String(file.type ?? ""),
      mediaBytes: Number(file.size) || 0,
      capturedOn: input.capturedOn?.trim() || null,
      today,
    });
    if (!verdict.ok) {
      return {
        state: "refused",
        message: verdict.code === "DATE_REQUIRED" || verdict.code === "DATE_INVALID" ||
          verdict.code === "DATE_FUTURE" || verdict.code === "WRONG_LEVEL"
          ? verdict.message
          : `${file.name}: ${verdict.message} Nothing was uploaded.`,
      };
    }
  }
  const store = storage();
  if (!store.uploadUrl) return { state: "direct" };
  const out: { key: string; url: string }[] = [];
  for (const file of files) {
    const key = assetKey({ orgId, project: null, kind: "upload", id: randomUUID() });
    const url = key ? await store.uploadUrl(key, UPLOAD_LINK_SECONDS, file.type).catch(() => null) : null;
    if (!key || !url) return { state: "refused", message: "Uploads are not available right now. Try again in a minute." };
    out.push({ key, url });
  }
  return { state: "store", files: out };
}

/** File one uploaded file into the library, through the same `addAsset()` the form uses. */
export async function finishAssetUpload(input: {
  nodeId: string;
  category: string;
  capturedOn: string | null;
  photograph: boolean;
  key: string;
  name: string;
  type: string;
}): Promise<{ ok: boolean; message: string }> {
  const { userId, orgId, authz } = await requirePermission("asset:manage");
  const key = String(input.key ?? "");
  // Only a staging key of this organisation, never a path the browser made up.
  if (!new RegExp(`^org/${orgId}/shared/upload/[0-9a-f-]{36}$`).test(key)) {
    return { ok: false, message: "That upload is not one of yours." };
  }
  try {
    const node = await resolveScopeNode(orgId, String(input.nodeId ?? ""));
    if (!node) return { ok: false, message: "That is not a place in this organisation." };
    if (!authz.canAt("asset:manage", node.path)) return { ok: false, message: NOT_HERE };
    if (!isAssetCategory(input.category)) return { ok: false, message: "Choose what kind of asset this is." };
    const bytes = await readAsset(key).catch(() => null);
    if (!bytes) return { ok: false, message: `${input.name}: the file did not arrive. Try it again.` };
    const result = await addAsset({
      orgId,
      actorUserId: userId,
      nodeId: node.id,
      category: input.category,
      title: String(input.name ?? "").replace(/[.][^.]+$/, "").replace(/[_-]+/g, " ").trim() || null,
      isRender: isRenderFor(input.category, !!input.photograph),
      capturedOn: input.capturedOn?.trim() || null,
      media: { bytes, type: String(input.type ?? ""), name: input.name || null },
    });
    revalidatePath(`/dashboard/library/${node.id}`);
    return result.ok ? { ok: true, message: "Uploaded." } : { ok: false, message: `${input.name}: ${result.message}` };
  } finally {
    await removeAsset(key).catch(() => undefined);
  }
}

/** A batch is at most this many files: each is its own request. */
const MAX_BATCH = 50;
/** Long enough for a 100 MB render on a slow connection. */
const UPLOAD_LINK_SECONDS = 1800;
