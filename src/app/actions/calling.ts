"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { addLeadAndCall, addTeamMember, removeTeamMember, saveOrgPolicy, setOnDuty } from "@/lib/calling";
import { normalisePhone } from "@/lib/calling-rules";
import type { Language } from "@/lib/call-rules";

/**
 * Calling: the client's policy, and one call placed by hand.
 *
 * The policy is `org:manage`, because whether calls need consent is the
 * organisation's decision under its agreement, not a sales person's.
 * Placing a call is `lead:call` on top of `lead:create`, since the form adds
 * the lead it calls.
 */

export type CallingFormState = { ok: boolean; message: string } | null;

const on = (v: FormDataEntryValue | null) => v === "on" || v === "true";

export async function saveCallingSettingsAction(
  _prev: CallingFormState,
  form: FormData,
): Promise<CallingFormState> {
  const g = await requirePermission("org:manage");
  const rawHandoff = String(form.get("handoff") ?? "").trim();
  const handoff = rawHandoff ? normalisePhone(rawHandoff) : null;
  if (rawHandoff && !handoff) {
    return { ok: false, message: "Enter the hand-off number with its country code, like +91 98765 43210." };
  }
  const line = String(form.get("recordingLine") ?? "").trim().slice(0, 200);
  const res = await saveOrgPolicy({
    orgId: g.orgId,
    userId: g.userId,
    input: {
      consentRequired: on(form.get("consentRequired")),
      announceRecording: on(form.get("announceRecording")),
      recordingLine: line || null,
      announceAi: on(form.get("announceAi")),
      handoffNumber: handoff,
    },
  });
  if (!res.ok) return res;
  revalidatePath("/dashboard/settings/calling");
  return { ok: true, message: "Saved" };
}

const LANGS: Language[] = ["hi", "mr", "en"];

export async function callLeadAction(_prev: CallingFormState, form: FormData): Promise<CallingFormState> {
  const g = await requirePermission("lead:call");
  if (!g.authz.can("lead:create")) return { ok: false, message: "You can call leads but not add them." };
  const language = String(form.get("language") ?? "hi") as Language;
  const consent = on(form.get("consent"));
  const res = await addLeadAndCall({
    orgId: g.orgId,
    userId: g.userId,
    name: String(form.get("name") ?? ""),
    phone: String(form.get("phone") ?? ""),
    phaseId: String(form.get("phaseId") ?? ""),
    source: String(form.get("source") ?? "Manual"),
    language: LANGS.includes(language) ? language : "hi",
    consentWording: consent ? String(form.get("consentWording") ?? "").trim() || null : null,
  });
  revalidatePath("/dashboard/leads/calls");
  revalidatePath("/dashboard/leads");
  // Say what happened to the lead as well as to the call: a refused call
  // still leaves the lead on the board, and a second press must not look
  // like it added nothing.
  const name = String(form.get("name") ?? "").trim();
  const already = res.lead?.merged ? `${name} is already a lead on this project. ` : "";
  if (res.ok) return { ok: true, message: `${already}Calling ${res.leadName} now.` };
  if (!res.lead) return { ok: false, message: res.message };
  return {
    ok: false,
    message: `${already || `Added ${name} as a lead. `}The call was not placed: ${res.message}`,
  };
}

/**
 * The sales team a buyer is handed to. `org:manage`, the same key as the
 * hand-off number it stands in for.
 */
export async function addTeamMemberAction(_prev: CallingFormState, form: FormData): Promise<CallingFormState> {
  const g = await requirePermission("org:manage");
  const res = await addTeamMember({
    orgId: g.orgId,
    userId: g.userId,
    name: String(form.get("name") ?? ""),
    phone: String(form.get("phone") ?? ""),
  });
  if (!res.ok) return res;
  revalidatePath("/dashboard/settings/calling");
  return { ok: true, message: "Added" };
}

export async function setOnDutyAction(form: FormData): Promise<void> {
  const g = await requirePermission("org:manage");
  await setOnDuty({ orgId: g.orgId, userId: g.userId, id: String(form.get("id") ?? ""), onDuty: on(form.get("onDuty")) });
  revalidatePath("/dashboard/settings/calling");
}

export async function removeTeamMemberAction(form: FormData): Promise<void> {
  const g = await requirePermission("org:manage");
  await removeTeamMember({ orgId: g.orgId, userId: g.userId, id: String(form.get("id") ?? "") });
  revalidatePath("/dashboard/settings/calling");
}
