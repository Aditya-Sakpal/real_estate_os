"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import {
  brainNode,
  loadBrain,
  openDraft,
  publishBrain,
  saveGroup,
  signGroup,
  type BrainNode,
} from "@/lib/brain";
import { flash } from "@/lib/flash";
import {
  approverPermission,
  BRAIN_FIELDS,
  FIELD_GROUPS,
  groupDef,
  groupsFor,
  type FieldGroup,
} from "@/lib/brain-rules";
import type { FormResult } from "@/components/KeptForm";

/**
 * Editing, signing and publishing the Project Brain.
 *
 * Every action here takes a node id from the form and reads it back inside
 * the tenant before doing anything with it, the same rule scoped invites
 * follow. Nothing trusts the request.
 *
 * The three signature actions check three DIFFERENT permissions, resolved
 * from the group being signed rather than from the form. That is the whole
 * point of the split: whoever signs the price must not thereby be able to
 * sign what may be claimed about the building.
 */

/**
 * Back to the Brain, with what happened said in a signed flash rather than
 * printed from the address as given.
 */
function back(
  nodeId: string,
  opts: { edit?: boolean; v?: number; error?: string; note?: string } = {},
): never {
  const parts: string[] = [];
  if (opts.edit) parts.push("edit=1");
  if (opts.v) parts.push(`v=${opts.v}`);
  if (opts.error) parts.push(flash("error", opts.error));
  if (opts.note) parts.push(flash("note", opts.note));
  const base = `/dashboard/brain/${nodeId}`;
  redirect(parts.length ? `${base}?${parts.join("&")}` : base);
}

/** The node, or nothing. Read inside the tenant, never believed from the form. */
async function nodeFrom(orgId: string, formData: FormData): Promise<BrainNode | null> {
  return brainNode(orgId, String(formData.get("nodeId") ?? ""));
}

/**
 * Write every group the form carries. Returns the first refusal, or null.
 *
 * Saving all three is what lets one button serve the page: a person who
 * corrected a price and a talking point in the same sitting expects both to
 * be there afterwards. An exempt phase has no RERA group, so a RERA field
 * posted anyway is never written.
 */
async function writeEveryGroup(
  formData: FormData,
  ctx: { orgId: string; userId: string; node: BrainNode },
): Promise<string | null> {
  for (const g of groupsFor(ctx.node.kind, ctx.node.exempt)) {
    const fields = BRAIN_FIELDS.filter((f) => f.group === g.key);
    if (!fields.some((f) => formData.has(f.key))) continue;

    const input: Record<string, unknown> = {};
    for (const f of fields) input[f.key] = formData.get(f.key);

    const saved = await saveGroup({
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      nodeId: ctx.node.id,
      group: g.key,
      input,
    });
    if (!saved.ok) return saved.message;
  }
  return null;
}

type Intent =
  | { kind: "save" }
  | { kind: "sign"; group: FieldGroup }
  | { kind: "signAll"; publish: boolean }
  | { kind: "publish" };

/**
 * Which button was pressed. The kept form builds its FormData with the
 * submitter, so the button's own `name="intent"` and value arrive. Absent
 * means the form was sent by pressing Enter in a field, which is a save.
 */
function readIntent(formData: FormData): Intent | null {
  const raw = String(formData.get("intent") ?? "save");
  if (raw === "save") return { kind: "save" };
  if (raw === "publish") return { kind: "publish" };
  if (raw === "signAll") return { kind: "signAll", publish: false };
  if (raw === "signAllPublish") return { kind: "signAll", publish: true };
  const m = /^sign:([A-Z]+)$/.exec(raw);
  if (m && FIELD_GROUPS.some((g) => g.key === m[1])) return { kind: "sign", group: m[1] as FieldGroup };
  return null;
}

/**
 * The editor's one form: save, sign one section, sign everything that is
 * yours, or publish.
 *
 * Whatever the press, what is on screen is written first. Publishing was its
 * own form carrying only the node, so an edit nobody had saved was dropped
 * without a word and the old values went live; now an edit to a signed
 * section is saved, the signature stops matching, and the publish is refused
 * with the section that needs signing again.
 *
 * A refusal comes back to the form rather than by redirect, so what was
 * typed stays typed. A save or a signature stays in the editor and says so;
 * a publish leaves it for the live version.
 */
export async function brainDraftAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("brain:read");

  const node = await nodeFrom(orgId, formData);
  if (!node) redirect("/dashboard/projects");
  const path = `/dashboard/brain/${node.id}`;

  if (!authz.canAt("brain:edit", node.path)) {
    return { ok: false, message: "You cannot edit these facts." };
  }
  const intent = readIntent(formData);
  if (!intent) return { ok: false, message: "That button does nothing here." };

  // The key for what was pressed, at this node, before anything is written.
  if (intent.kind === "sign") {
    if (!groupsFor(node.kind, node.exempt).some((g) => g.key === intent.group)) {
      return { ok: false, message: "That section does not belong on this Brain." };
    }
    if (!authz.canAt(approverPermission(intent.group), node.path)) {
      return { ok: false, message: `You cannot sign ${groupDef(intent.group).inline}.` };
    }
  }
  if (intent.kind === "publish" && !authz.canAt("brain:publish", node.path)) {
    return { ok: false, message: "You cannot publish these facts." };
  }

  const failure = await writeEveryGroup(formData, { orgId, userId, node });
  if (failure) {
    revalidatePath(path);
    return { ok: false, message: failure };
  }

  if (intent.kind === "save") {
    revalidatePath(path);
    return { ok: true, message: "Draft saved." };
  }

  if (intent.kind === "sign") {
    const result = await signGroup({
      orgId,
      actorUserId: userId,
      nodeId: node.id,
      group: intent.group,
      // Nothing to guard against when the values were just written here.
      expectedHash: "",
    });
    revalidatePath(path);
    return result.ok
      ? { ok: true, message: `${groupDef(intent.group).label} signed.` }
      : { ok: false, message: result.message };
  }

  if (intent.kind === "signAll") {
    const signed = await signEverythingMine({ orgId, userId, node, authz, hashes: null });
    revalidatePath(path);
    if (!signed.ok) return { ok: false, message: signed.message };
    if (intent.publish && signed.leftForOthers === 0 && authz.canAt("brain:publish", node.path)) {
      const published = await publishBrain({ orgId, actorUserId: userId, nodeId: node.id });
      revalidatePath(path);
      revalidatePath("/dashboard");
      if (!published.ok) return { ok: false, message: published.message };
      back(node.id, { note: `Version ${published.version} is live.` });
    }
    return { ok: true, message: sectionsSigned(signed.count) };
  }

  const published = await publishBrain({ orgId, actorUserId: userId, nodeId: node.id });
  revalidatePath(path);
  revalidatePath("/dashboard");
  if (!published.ok) return { ok: false, message: published.message };
  back(node.id, { note: `Version ${published.version} is live.` });
}

const sectionsSigned = (n: number) => (n === 1 ? "1 section signed." : `${n} sections signed.`);

/**
 * Sign every waiting section this person holds the key for, each as its own
 * signature under its own permission. `hashes` is what a reviewer who cannot
 * edit was shown, per section; null when the values were just written.
 */
async function signEverythingMine(opts: {
  orgId: string;
  userId: string;
  node: BrainNode;
  authz: Awaited<ReturnType<typeof requirePermission>>["authz"];
  hashes: FormData | null;
}): Promise<{ ok: true; count: number; leftForOthers: number } | { ok: false; message: string }> {
  const brain = await loadBrain(opts.orgId, opts.node.id);
  if (!brain?.draft) return { ok: false, message: "There is no draft to sign." };

  const waiting = brain.groups.filter((g) => g.required);
  const mine = waiting.filter((g) => opts.authz.canAt(approverPermission(g.group), opts.node.path));
  if (!mine.length) {
    return {
      ok: false,
      message: waiting.length ? "None of what is left is yours to sign." : "Everything is already signed.",
    };
  }

  for (const g of mine) {
    const result = await signGroup({
      orgId: opts.orgId,
      actorUserId: opts.userId,
      nodeId: opts.node.id,
      group: g.group,
      // A reviewer who cannot edit signs what they were shown, and the hash
      // of each section travels with the button so an edit made underneath
      // them is refused rather than signed blind.
      expectedHash: opts.hashes ? String(opts.hashes.get(`hash_${g.group}`) ?? "") : "",
    });
    if (!result.ok) return { ok: false, message: result.message };
  }
  return { ok: true, count: mine.length, leftForOthers: waiting.length - mine.length };
}

/**
 * Sign one group, for a reviewer who cannot edit and so signs what is stored.
 *
 * The group is BOUND to the action rather than read from a field, so it cannot
 * be swapped by editing an input: the permission checked below is the one for
 * the group the button was rendered for. The form posts no fields, only the
 * hash of what the reviewer was shown, which catches an edit made underneath
 * them meanwhile. Somebody editing signs through `brainDraftAction`, which
 * writes what is on screen first.
 */
export async function signBrainGroupAction(
  bound: FieldGroup,
  formData: FormData,
): Promise<void> {
  const group = FIELD_GROUPS.some((g) => g.key === bound) ? bound : null;

  // The permission comes from the group, so the catalog decides who may sign
  // what.
  const { userId, orgId, authz } = await requirePermission(
    group ? approverPermission(group) : "brain:publish",
  );

  const node = await nodeFrom(orgId, formData);
  if (!node) redirect("/dashboard/projects");
  if (!group) back(node.id, { error: "That is not a section of the Brain." });
  if (!groupsFor(node.kind, node.exempt).some((g) => g.key === group)) {
    back(node.id, { error: "That section does not belong on this Brain." });
  }
  if (!authz.canAt(approverPermission(group), node.path)) {
    back(node.id, { error: `You cannot sign ${groupDef(group).inline} here.` });
  }

  const result = await signGroup({
    orgId,
    actorUserId: userId,
    nodeId: node.id,
    group,
    expectedHash: String(formData.get("hash") ?? ""),
  });

  revalidatePath(`/dashboard/brain/${node.id}`);
  back(
    node.id,
    result.ok ? { note: `${groupDef(group).label} signed.` } : { error: result.message },
  );
}

export async function openDraftAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("brain:edit");

  const node = await nodeFrom(orgId, formData);
  if (!node) redirect("/dashboard/projects");
  // Holding the key somewhere is not holding it here.
  if (!authz.canAt("brain:edit", node.path)) {
    back(node.id, { error: "You cannot edit these facts." });
  }

  const result = await openDraft({ orgId, actorUserId: userId, nodeId: node.id });

  revalidatePath(`/dashboard/brain/${node.id}`);
  if (!result.ok) back(node.id, { error: result.message });
  back(node.id, { edit: true, v: result.version });
}

/**
 * Sign every section this person may sign, and publish when that finishes it,
 * for a reviewer who cannot edit. The editor's own button goes through
 * `brainDraftAction`, which saves what is on screen first.
 *
 * The three-way split is untouched. Each section is checked against its OWN
 * permission, and each gets its own signature row naming the person.
 * Somebody holding only the claims key signs the claims and nothing else; the
 * press does not widen anything. `publish` is bound to the button, and the
 * button's label says it publishes.
 */
export async function signAllAction(publish: boolean, formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("brain:read");

  const node = await nodeFrom(orgId, formData);
  if (!node) redirect("/dashboard/projects");

  const signed = await signEverythingMine({ orgId, userId, node, authz, hashes: formData });
  revalidatePath(`/dashboard/brain/${node.id}`);
  if (!signed.ok) back(node.id, { error: signed.message });

  if (publish && signed.leftForOthers === 0 && authz.canAt("brain:publish", node.path)) {
    const published = await publishBrain({ orgId, actorUserId: userId, nodeId: node.id });
    revalidatePath("/dashboard");
    if (!published.ok) back(node.id, { error: published.message });
    back(node.id, { note: `Version ${published.version} is live.` });
  }
  back(node.id, { note: sectionsSigned(signed.count) });
}
