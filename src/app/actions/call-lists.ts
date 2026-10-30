"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { getUserOrgState } from "@/lib/onboarding";
import { sheetRows } from "@/lib/inventory";
import { MAX_XLSX_BYTES } from "@/lib/xlsx-read";
import { answerListQuestions, deleteCallList, readCallList, runCallLists, saveListGoal, saveListSource, setListState, startCallList } from "@/lib/call-lists";
import { readListSource } from "@/lib/call-list-rules";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/**
 * Call lists: a sheet read into a plan, then started, paused or stopped.
 * `lead:call` and `lead:create` at the list's tower, asked again inside
 * every function behind these.
 */

const listPath = (id: string) => `/dashboard/leads/calls/lists/${id}`;

export async function readCallListAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("lead:call", "/dashboard/leads/calls");
  if (!authz.can("lead:create")) return { ok: false, message: "You can call leads but not add them." };
  const file = formData.get("sheet");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose the list, as Excel or CSV." };
  if (file.size > MAX_XLSX_BYTES) return { ok: false, message: "The file is over 5 MB. Split it into smaller lists." };
  const rows = sheetRows(Buffer.from(await file.arrayBuffer()));
  if (!rows.ok) return { ok: false, message: rows.message };
  const r = await readCallList({
    orgId,
    userId,
    authz,
    towerIds: formData.getAll("towerIds").map(String).filter(Boolean),
    source: readListSource(formData.get("source")),
    fileName: file.name.replace(/[\\/]/g, " ").trim() || "List",
    rows: rows.rows,
  });
  if (!r.ok) return { ok: false, message: r.message };
  redirect(listPath(r.listId));
}

export async function saveListGoalAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("lead:call", "/dashboard/leads/calls");
  const listId = String(formData.get("listId") ?? "");
  const r = await saveListGoal({ orgId, userId, authz, listId, goal: String(formData.get("goal") ?? "") });
  if (!r.ok) return r;
  revalidatePath(listPath(listId));
  return { ok: true, message: "Saved" };
}

export async function saveListSourceAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("lead:call", "/dashboard/leads/calls");
  const listId = String(formData.get("listId") ?? "");
  const r = await saveListSource({ orgId, userId, authz, listId, source: readListSource(formData.get("source")) });
  if (!r.ok) return r;
  revalidatePath(listPath(listId));
  return { ok: true, message: "Saved" };
}

export async function startCallListAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("lead:call", "/dashboard/leads/calls");
  const listId = String(formData.get("listId") ?? "");
  const state = await getUserOrgState(userId);
  const developer = state.kind === "MEMBER" ? state.orgName : "the developer";
  const r = await startCallList({ orgId, userId, authz, listId, consent: formData.get("consent") === "on", developer });
  if (!r.ok) return r;
  // The first people are rung now; the worker carries on from there.
  after(() => runCallLists().catch((e) => console.error("call lists:", e)));
  redirect(`${listPath(listId)}?${flash("done", r.message)}`);
}

export async function setListStateAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("lead:call", "/dashboard/leads/calls");
  const listId = String(formData.get("listId") ?? "");
  const to = String(formData.get("to") ?? "");
  if (to !== "PAUSED" && to !== "RUNNING" && to !== "CANCELLED") return { ok: false, message: "That is not something a list can do." };
  const r = await setListState({ orgId, userId, authz, listId, to });
  if (!r.ok) return r;
  if (to === "RUNNING") after(() => runCallLists().catch((e) => console.error("call lists:", e)));
  redirect(`${listPath(listId)}?${flash("done", r.message)}`);
}

/** Stop a list for good, from the confirmation dialog. */
export async function stopCallListAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("lead:call", "/dashboard/leads/calls");
  const listId = String(formData.get("listId") ?? "");
  const r = await setListState({ orgId, userId, authz, listId, to: "CANCELLED" });
  redirect(`${listPath(listId)}?${flash("done", r.message)}`);
}

/** The person's answers to a list's questions; the people they touch are read again. */
export async function answerListQuestionsAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId, authz } = await requirePermission("lead:call", "/dashboard/leads/calls");
  const listId = String(formData.get("listId") ?? "");
  const given: Record<string, { pick?: string; other?: string; skip?: boolean }> = {};
  for (const [k, v] of formData.entries()) {
    const m = /^q:(.+)$/.exec(k);
    if (!m || typeof v !== "string") continue;
    const g = (given[m[1]] ??= {});
    if (v === "__skip") g.skip = true;
    else if (v === "__other") g.other = String(formData.get(`other:${m[1]}`) ?? "");
    else g.pick = v;
  }
  const r = await answerListQuestions({ orgId, userId, authz, listId, given });
  if (!r.ok) return r;
  redirect(`${listPath(listId)}?${flash("done", r.message)}`);
}

/** Delete a list that is not calling, from the confirmation dialog. */
export async function deleteCallListAction(formData: FormData): Promise<void> {
  const { userId, orgId, authz } = await requirePermission("lead:call", "/dashboard/leads/calls");
  const listId = String(formData.get("listId") ?? "");
  const r = await deleteCallList({ orgId, userId, authz, listId });
  if (!r.ok) redirect(`${listPath(listId)}?${flash("error", r.message)}`);
  revalidatePath("/dashboard/leads/calls/lists");
  redirect(`/dashboard/leads/calls/lists?${flash("done", r.message)}`);
}
