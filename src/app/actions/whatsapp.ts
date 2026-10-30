"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { flash } from "@/lib/flash";
import {
  checkWhatsApp,
  connectWhatsApp,
  disconnectWhatsApp,
  enterPin,
  placeNumber,
  submitTemplates,
} from "@/lib/wa-numbers";
import type { SignupHint } from "@/lib/wa-rules";
import { SIGNUP_FINISHED } from "@/lib/wa-rules";

/**
 * The developer's own WhatsApp number. Every action is `integration:manage`:
 * the account holds a token that speaks for the developer's brand to every
 * buyer they have, which is the same power as connecting their Page.
 */

const PAGE = "/dashboard/settings/connections/whatsapp";

function back(said: { error?: string; done?: string }): never {
  const parts: string[] = [];
  if (said.error) parts.push(flash("error", said.error));
  if (said.done) parts.push(flash("done", said.done));
  revalidatePath("/dashboard/settings/connections");
  redirect(parts.length ? `${PAGE}?${parts.join("&")}` : PAGE);
}

const digits = (v: unknown) => (typeof v === "string" && /^[0-9]{1,40}$/.test(v) ? v : null);

/**
 * What Meta's pop-up handed the page: a code that lives thirty seconds, and
 * the ids the person picked. The ids are passed on as a hint only; what is
 * connected is what the code's token can reach.
 */
export async function finishWhatsAppSignup(input: { code: string; hint: SignupHint | null }): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const raw = input?.hint;
  const hint: SignupHint | null =
    raw && (SIGNUP_FINISHED as readonly string[]).includes(raw.event)
      ? { event: raw.event, wabaId: digits(raw.wabaId), phoneNumberId: digits(raw.phoneNumberId), businessId: digits(raw.businessId) }
      : null;
  const r = await connectWhatsApp({ orgId, userId, code: String(input?.code ?? ""), hint });
  back(r.ok ? { done: r.message } : { error: r.message });
}

export async function placeNumberAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const nodeId = String(formData.get("nodeId") ?? "");
  const r = await placeNumber({ orgId, userId, numberId: String(formData.get("numberId") ?? ""), nodeId: nodeId || null });
  back(r.ok ? { done: r.message } : { error: r.message });
}

export async function enterPinAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const r = await enterPin({ orgId, userId, numberId: String(formData.get("numberId") ?? ""), pin: String(formData.get("pin") ?? "").trim() });
  back(r.ok ? { done: r.message } : { error: r.message });
}

export async function submitTemplatesAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const r = await submitTemplates({ orgId, userId, accountId: String(formData.get("accountId") ?? "") });
  back(r.ok ? { done: r.message } : { error: r.message });
}

export async function checkWhatsAppAction(): Promise<void> {
  const { orgId } = await requirePermission("integration:manage");
  const r = await checkWhatsApp(orgId, { force: true });
  back(r.broken ? { error: "WhatsApp stopped accepting our access. Connect it again." } : { done: "Checked with Meta just now." });
}

export async function disconnectWhatsAppAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const r = await disconnectWhatsApp({ orgId, userId, accountId: String(formData.get("accountId") ?? "") });
  back(r.ok ? { done: r.message } : { error: r.message });
}
