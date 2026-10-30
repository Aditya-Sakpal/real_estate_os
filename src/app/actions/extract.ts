"use server";

import { after } from "next/server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { brainNode, type BrainNode } from "@/lib/brain";
import {
  beginUpload,
  decideProposal,
  documentFile,
  finishUpload,
  proposalPlace,
  queueExtraction,
  removeDocument,
  runExtraction,
  type Begun,
  type Decision,
} from "@/lib/extract";
import { cleanName } from "@/lib/extract-rules";
import { addUnitType } from "@/lib/unit";
import type { FormResult } from "@/components/KeptForm";

/**
 * The Brain's documents: uploading, reading, and a person's decision on each
 * value read. `brain:edit` at the node, asked there and not merely somewhere,
 * because an id from a form can name any tower in the organisation.
 */

const path = (nodeId: string) => `/dashboard/brain/${nodeId}/documents`;

async function editableNode(nodeId: unknown): Promise<{ orgId: string; userId: string; node: BrainNode } | null> {
  const g = await requirePermission("brain:edit");
  const node = await brainNode(g.orgId, String(nodeId ?? ""));
  if (!node || !g.authz.canAt("brain:edit", node.path)) return null;
  return { orgId: g.orgId, userId: g.userId, node };
}

/** The address the browser is on, so a local upload goes back to it. */
async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export type UploadInput = { nodeId: string; kind: string; name: string; type: string; size: number; sha256: string };

/** Before the bytes go: may they, and where to. */
export async function beginDocumentUpload(input: UploadInput): Promise<Begun> {
  const ctx = await editableNode(input.nodeId);
  if (!ctx) return { state: "refused", message: "You cannot add documents here." };
  return beginUpload({ orgId: ctx.orgId, node: ctx.node, kind: input.kind, type: input.type, size: input.size, sha256: input.sha256, origin: await origin() });
}

/** The bytes have landed: file the document and start reading it. */
export async function finishDocumentUpload(input: UploadInput): Promise<FormResult> {
  const ctx = await editableNode(input.nodeId);
  if (!ctx) return { ok: false, message: "You cannot add documents here." };
  const done = await finishUpload({
    orgId: ctx.orgId,
    userId: ctx.userId,
    node: ctx.node,
    kind: input.kind,
    name: cleanName(input.name),
    type: input.type,
    size: input.size,
    sha256: input.sha256,
  });
  if (!done.ok) return { ok: false, message: done.message };
  const run = done.extractionId;
  if (run) after(() => runExtraction(ctx.orgId, run).then(() => undefined));
  revalidatePath(path(ctx.node.id));
  return { ok: true, message: done.message };
}

/** Read a document again, after the reader or the document changed. */
export async function readAgainAction(formData: FormData): Promise<void> {
  const g = await requirePermission("brain:edit");
  const doc = await documentFile(g.orgId, String(formData.get("documentId") ?? ""));
  if (!doc || !g.authz.canAt("brain:edit", doc.path)) return;
  const queued = await queueExtraction({ orgId: g.orgId, userId: g.userId, documentId: doc.id });
  if (queued.ok && !queued.already) after(() => runExtraction(g.orgId, queued.extractionId).then(() => undefined));
  revalidatePath(path(doc.nodeId));
}

/** Remove a document nothing was taken from. */
export async function removeDocumentAction(formData: FormData): Promise<void> {
  const g = await requirePermission("brain:edit");
  const doc = await documentFile(g.orgId, String(formData.get("documentId") ?? ""));
  if (!doc || !g.authz.canAt("brain:edit", doc.path)) return;
  await removeDocument({ orgId: g.orgId, userId: g.userId, documentId: doc.id });
  revalidatePath(path(doc.nodeId));
  revalidatePath(`/dashboard/brain/${doc.nodeId}`);
}

/** Accept, correct or reject one value. */
export async function decideValueAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const g = await requirePermission("brain:edit");
  const proposalId = String(formData.get("proposalId") ?? "");
  const place = await proposalPlace(g.orgId, proposalId);
  if (!place || !g.authz.canAt("brain:edit", place.path)) return { ok: false, message: "You cannot change the Brain here." };
  const kind = String(formData.get("decision") ?? "");
  const decision: Decision | null =
    kind === "accept" ? { kind: "accept" } : kind === "reject" ? { kind: "reject" } : kind === "correct" ? { kind: "correct", value: String(formData.get("value") ?? "") } : null;
  if (!decision) return { ok: false, message: "Choose accept, correct or reject." };
  const result = await decideProposal({ orgId: g.orgId, userId: g.userId, proposalId, decision });
  if (result.ok) {
    revalidatePath(path(place.nodeId));
    revalidatePath(`/dashboard/brain/${place.nodeId}`);
  }
  return result;
}

/** A flat a price list names that the tower has not recorded, recorded unapproved. */
export async function addFlatAction(_prev: FormResult, formData: FormData): Promise<FormResult> {
  const g = await requirePermission("unit:manage");
  const node = await brainNode(g.orgId, String(formData.get("nodeId") ?? ""));
  if (!node || !g.authz.canAt("unit:manage", node.path)) return { ok: false, message: "You cannot record flats here." };
  const num = (k: string) => {
    const n = Number(String(formData.get(k) ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const added = await addUnitType({
    orgId: g.orgId,
    actorUserId: g.userId,
    nodeId: node.id,
    config: String(formData.get("config") ?? ""),
    variant: null,
    carpetAreaSqft: num("carpet"),
    balconyAreaSqft: num("balcony"),
    startingPrice: num("price"),
  });
  if (!added.ok) return { ok: false, message: added.message };
  revalidatePath(path(node.id));
  return { ok: true, message: "Recorded. It needs approving before an ad can quote it." };
}
