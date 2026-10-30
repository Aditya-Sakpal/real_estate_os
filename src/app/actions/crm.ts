"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import {
  connectCrm,
  disconnectCrm,
  retryDead,
  saveMappings,
  saveTowerKeys,
  setLeadFields,
  setProjectField,
  syncPass,
  type MappingChoice,
} from "@/lib/crm-sync";
import { crmLabel, isCrmProvider, type CrmProvider } from "@/lib/crm-rules";
import { PATH, SIDE, type StageKey } from "@/lib/lead-rules";
import { isUuid } from "@/lib/capture-rules";
import { flash } from "@/lib/flash";
import type { FormResult } from "@/components/KeptForm";

/**
 * The CRM beside us. Every action here is `integration:manage`: a CRM
 * credential reads and writes every lead the developer holds.
 */

const PAGE = "/dashboard/settings/connections/crm";
const STAGES: StageKey[] = [...PATH, ...SIDE];

function back(said?: { error?: string; done?: string }): never {
  const parts: string[] = [];
  if (said?.error) parts.push(flash("error", said.error));
  if (said?.done) parts.push(flash("done", said.done));
  redirect(parts.length ? `${PAGE}?${parts.join("&")}` : PAGE);
}

function refresh() {
  revalidatePath(PAGE);
  revalidatePath("/dashboard/settings/connections");
  revalidatePath("/dashboard");
}

export async function connectCrmAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const raw = String(formData.get("provider") ?? "").toUpperCase();
  if (!isCrmProvider(raw)) return { ok: false, message: "Choose your CRM." };
  const provider: CrmProvider = raw;
  const fields: Record<string, string> = {};
  for (const k of ["tenant", "apiKey", "secretKey", "accessKey"]) fields[k] = String(formData.get(k) ?? "");
  const r = await connectCrm({ orgId, userId, provider, fields });
  if (!r.ok) {
    const first = r.errors ? Object.values(r.errors)[0] : null;
    return { ok: false, message: first ?? r.message };
  }
  refresh();
  back({ done: [`${crmLabel(provider)} is connected.`, r.note].filter(Boolean).join(" ") });
}

export async function disconnectCrmAction(): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  await disconnectCrm({ orgId, userId });
  refresh();
  back({ done: "Disconnected. Nothing more goes to your CRM." });
}

/**
 * The matches, as one form: a select per status, project and person of
 * theirs (`m:<row id>`), and for each of our stages the status of theirs we
 * set (`push:<stage>`). Every value is read back against the tenant in
 * `saveMappings()`; nothing here is believed.
 */
export async function saveMatchesAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const choices: MappingChoice[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("m:")) continue;
    const id = key.slice(2);
    const v = String(value);
    if (!isUuid(id)) continue;
    if (v === "") choices.push({ id, to: "clear" });
    else if (v === "ignore") choices.push({ id, to: "ignore" });
    else if (v.startsWith("stage:") && STAGES.includes(v.slice(6) as StageKey)) choices.push({ id, to: "stage", stage: v.slice(6) as StageKey });
    else if (v.startsWith("node:") && isUuid(v.slice(5))) choices.push({ id, to: "node", nodeId: v.slice(5) });
    else if (v.startsWith("user:") && isUuid(v.slice(5))) choices.push({ id, to: "user", userId: v.slice(5) });
    else return { ok: false, message: "One of the matches could not be read. Refresh and try again." };
  }
  const pushAs: Partial<Record<StageKey, string | null>> = {};
  for (const s of STAGES) {
    const v = formData.get(`push:${s}`);
    if (v === null) continue;
    const id = String(v);
    pushAs[s] = id && isUuid(id) ? id : null;
  }
  // LeadSquared's configuration and budget fields ride in the same form, and are read back against its own list.
  if (formData.has("lf:config") || formData.has("lf:budget")) {
    const f = await setLeadFields({
      orgId,
      userId,
      config: String(formData.get("lf:config") ?? "") || null,
      budget: String(formData.get("lf:budget") ?? "") || null,
    });
    if (!f.ok) return { ok: false, message: f.message };
  }
  const r = await saveMappings({ orgId, userId, choices, pushAs });
  if (!r.ok) return { ok: false, message: r.message };
  refresh();
  back({ done: "Saved. Leads waiting on these matches are on their way." });
}

export async function setProjectFieldAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const schemaName = String(formData.get("field") ?? "");
  if (!schemaName) return { ok: false, message: "Choose the field that holds the project." };
  const r = await setProjectField({ orgId, userId, schemaName });
  if (!r.ok) return { ok: false, message: r.message };
  refresh();
  back({ done: "Saved. Match each project to a tower below." });
}

export async function saveTowerKeysAction(formData: FormData): Promise<FormResult> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const keys: { nodeId: string; srd: string | null }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("srd:")) continue;
    const nodeId = key.slice(4);
    if (!isUuid(nodeId)) continue;
    keys.push({ nodeId, srd: String(value).trim() || null });
  }
  const r = await saveTowerKeys({ orgId, userId, keys });
  if (!r.ok) return { ok: false, message: r.message };
  refresh();
  back({ done: "Saved. New leads in these towers go to Sell.Do." });
}

export async function retryDeadAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const id = String(formData.get("id") ?? "");
  const n = await retryDead({ orgId, userId, ids: id === "all" ? "all" : isUuid(id) ? [id] : [] });
  refresh();
  back({ done: n ? `Trying ${n === 1 ? "it" : `all ${n}`} again now.` : "Nothing was waiting to be tried again." });
}

/** One pass now, rather than at the worker's next turn. Bounded like the worker's. */
export async function syncNowAction(): Promise<void> {
  const { orgId } = await requirePermission("integration:manage");
  const r = await syncPass(orgId, new Date(), true);
  refresh();
  if (!r) back({ error: "The CRM is not connected." });
  if (r.error) back({ error: r.error });
  const sent = r.outbound.done;
  const got = r.inbound.done;
  back({ done: sent || got ? `Synced: ${got} in, ${sent} out.` : "Synced. Nothing had changed." });
}
