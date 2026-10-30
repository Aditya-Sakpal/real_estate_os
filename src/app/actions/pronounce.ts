"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { brainNode, type BrainNode } from "@/lib/brain";
import { checkWords, saveSaying } from "@/lib/pronounce";
import type { FormResult } from "@/components/KeptForm";

/**
 * How the calling agent says a project's words: checking them by ear, and a
 * person writing how one is really said. `brain:edit` at the node, asked
 * there, because an id from a form can name any tower in the organisation.
 */

const path = (nodeId: string) => `/dashboard/brain/${nodeId}/words`;

async function editableNode(nodeId: unknown): Promise<{ orgId: string; userId: string; node: BrainNode } | null> {
  const g = await requirePermission("brain:edit");
  const node = await brainNode(g.orgId, String(nodeId ?? ""));
  if (!node || (node.kind !== "PROJECT" && node.kind !== "PHASE") || !g.authz.canAt("brain:edit", node.path)) return null;
  return { orgId: g.orgId, userId: g.userId, node };
}

const words = (n: number) => `${n} ${n === 1 ? "word" : "words"}`;

/** Say every word not yet checked in the call voice, and hear each back. */
export async function checkWordsAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const ctx = await editableNode(form.get("nodeId"));
  if (!ctx) return { ok: false, message: "You cannot check this project's words." };
  const done = await checkWords({ orgId: ctx.orgId, userId: ctx.userId, nodeId: ctx.node.id });
  revalidatePath(path(ctx.node.id));
  if (!done.ok) return done;
  if (!done.checked) return { ok: true, message: "Every word is already checked." };
  const said = [`Checked ${words(done.checked)}.`];
  if (done.wrong) said.push(`${words(done.wrong)} may sound wrong.`);
  if (done.failed) said.push(`${words(done.failed)} could not be checked.`);
  if (!done.wrong && !done.failed) said.push("All sound right.");
  if (done.left) said.push(`${words(done.left)} left to check.`);
  return { ok: true, message: said.join(" ") };
}

/** How a word is really said here, or back to the usual way when empty. */
export async function saveSayingAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const ctx = await editableNode(form.get("nodeId"));
  if (!ctx) return { ok: false, message: "You cannot change how this project's words are said." };
  // "Use the usual way" sends `clear`, and an empty spelling puts the word back.
  const said = form.get("clear") ? "" : String(form.get("said") ?? "");
  const saved = await saveSaying({ orgId: ctx.orgId, userId: ctx.userId, nodeId: ctx.node.id, written: String(form.get("written") ?? ""), said });
  if (!saved.ok) return saved;
  revalidatePath(path(ctx.node.id));
  return { ok: true, message: said.trim() ? "Saved. Press play to hear it." : "Back to the usual way." };
}

/** A word the list did not find, with how it is said if the person knows. */
export async function addWordAction(_prev: FormResult, form: FormData): Promise<FormResult> {
  const ctx = await editableNode(form.get("nodeId"));
  if (!ctx) return { ok: false, message: "You cannot add words here." };
  const written = String(form.get("written") ?? "").trim();
  if (!written) return { ok: false, message: "Write the word first." };
  const saved = await saveSaying({ orgId: ctx.orgId, userId: ctx.userId, nodeId: ctx.node.id, written, said: String(form.get("said") ?? ""), keepSaid: true });
  if (!saved.ok) return saved;
  revalidatePath(path(ctx.node.id));
  return { ok: true, message: `Added ${written}. Press play to hear it.` };
}
