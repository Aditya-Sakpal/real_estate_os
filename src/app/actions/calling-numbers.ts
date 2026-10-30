"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { verifyBusiness } from "@/lib/calling-kyc";
import { requirePermission } from "@/lib/guard";
import { flash } from "@/lib/flash";
import { linkSarvamConnection, placeCallingNumber, releaseCallingNumber, rentCallingNumber } from "@/lib/calling-numbers";

/**
 * The developer's own calling numbers. Every action is `integration:manage`
 * at the organisation: a number is the developer's line to every buyer it
 * calls, the same power as connecting its WhatsApp number.
 */

const PAGE = "/dashboard/settings/calling-numbers";

function back(said: { error?: string; done?: string }, query = ""): never {
  const parts: string[] = [];
  if (query) parts.push(query);
  if (said.error) parts.push(flash("error", said.error));
  if (said.done) parts.push(flash("done", said.done));
  revalidatePath(PAGE);
  redirect(parts.length ? `${PAGE}?${parts.join("&")}` : PAGE);
}

const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

export async function rentCallingNumberAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const picked = text(formData.get("pick"));
  const [number, city] = picked.split("|");
  const r = await rentCallingNumber({ orgId, userId, number: number ?? "", city: city ?? null, nodeId: text(formData.get("nodeId")) || null });
  if (r.ok) back({ done: r.message });
  // A refusal stays on the search, so the person can pick another.
  const q = text(formData.get("q"));
  const starts = text(formData.get("starts")).replace(/[^0-9]/g, "").slice(0, 6);
  back({ error: r.message }, q ? `get=1&q=${encodeURIComponent(q)}${starts ? `&starts=${starts}` : ""}` : "get=1");
}

export async function placeCallingNumberAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const r = await placeCallingNumber({ orgId, userId, numberId: text(formData.get("numberId")), nodeId: text(formData.get("nodeId")) || null });
  back(r.ok ? { done: r.message } : { error: r.message });
}

export async function linkSarvamConnectionAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const numberId = text(formData.get("numberId"));
  const r = await linkSarvamConnection({ orgId, userId, numberId, raw: text(formData.get("connectionId")) });
  // A refusal keeps the field open on the same number.
  if (r.ok) back({ done: r.message });
  back({ error: r.message }, /^[0-9a-f-]{36}$/i.test(numberId) ? `conn=${numberId}` : "");
}

export async function releaseCallingNumberAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const r = await releaseCallingNumber({ orgId, userId, numberId: text(formData.get("numberId")) });
  back(r.ok ? { done: r.message } : { error: r.message });
}

/**
 * Verify the business on our own screen; a person or proprietor is then
 * sent to DigiLocker for Aadhaar, which returns to `/digilocker`.
 */
export async function verifyBusinessAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("integration:manage");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const r = await verifyBusiness({
    orgId,
    userId,
    businessType: text(formData.get("businessType")),
    email: text(formData.get("email")),
    pan: text(formData.get("pan")),
    gstin: text(formData.get("gstin")),
    cin: text(formData.get("cin")),
    digilockerReturn: `${proto}://${host}${PAGE}/digilocker`,
  });
  if (!r.ok) back({ error: r.message });
  if ("redirect" in r) redirect(r.redirect);
  back({ done: r.message });
}
