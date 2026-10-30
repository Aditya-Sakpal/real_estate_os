"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/guard";
import { flash } from "@/lib/flash";
import { saveBillingDetails } from "@/lib/billing";
import { confirmTopUp, startTopUp, type Checkout } from "@/lib/billing-pay";
import { withTenant } from "@/lib/db";
import { approveAutoCharge, cancelAutoCharge, saveAutoTopUp } from "@/lib/auto-topup";
import { payRenewal } from "@/lib/plan-renewal";
import { confirmMandateSetup, startMandateSetup, stopMandate, type MandateCheckout } from "@/lib/mandate-setup";

/**
 * Billing's writes a person can make: who invoices go to, starting a
 * top-up, confirming the payment Checkout hands back, and the automatic
 * top-up (its setting, cancelling one, paying one). Each asks
 * `billing:manage`; a plan, a mode and free credit are never written here,
 * because the application role holds no grant to write them.
 */

const PAGE = "/dashboard/settings/billing";

export async function saveBillingDetailsAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("billing:manage", PAGE);
  const input = Object.fromEntries(["name", "gstin", "address", "state", "email"].map((k) => [k, formData.get(k)]));
  const r = await saveBillingDetails({ orgId, userId, input });
  if (!r.ok) redirect(`${PAGE}?edit=details&${flash("error", r.message)}`);
  revalidatePath(PAGE);
  redirect(`${PAGE}?${flash("saved", r.changed ? "Billing details saved." : "Nothing changed.")}#details`);
}

export type StartResult = { ok: true; checkout: Checkout } | { ok: false; message: string };

/** An order at Razorpay for exactly this basket, priced again here. */
export async function startTopUpAction(cart: { sku: string; qty: number }[]): Promise<StartResult> {
  const { userId, orgId } = await requirePermission("billing:manage", PAGE);
  const lines = Array.isArray(cart) ? cart.slice(0, 20).map((l) => ({ sku: String(l?.sku ?? ""), qty: l?.qty })) : [];
  const [me] = await withTenant(orgId, (sql) => sql<{ email: string | null }[]>`SELECT email::text AS email FROM users WHERE id = ${userId}`);
  return startTopUp({ orgId, userId, userEmail: me?.email ?? null, cart: lines });
}

const AUTO = `${PAGE}/auto`;

/** The automatic top-up setting: on or off, which pack, below what, and the month's limit. */
export async function saveAutoTopUpAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("billing:manage", AUTO);
  const input = Object.fromEntries(["on", "sku", "qty", "threshold", "ceiling"].map((k) => [k, formData.get(k)]));
  const r = await saveAutoTopUp({ orgId, userId, input });
  if (!r.ok) redirect(`${AUTO}?edit=1&${flash("error", r.message)}`);
  revalidatePath(AUTO);
  redirect(`${AUTO}?${flash("saved", r.changed.length ? "Auto top-up saved." : "Nothing changed.")}`);
}

/** Cancel an automatic top-up that is announced or waiting to be paid. */
export async function cancelAutoChargeAction(formData: FormData): Promise<void> {
  const { userId, orgId } = await requirePermission("billing:manage", AUTO);
  const r = await cancelAutoCharge({ orgId, userId, chargeId: String(formData.get("charge") ?? "") });
  revalidatePath(AUTO);
  redirect(`${AUTO}?${r.ok ? flash("saved", "That top-up is cancelled.") : flash("error", r.message)}`);
}

/** Pay an automatic top-up that waits for the client, through Checkout. */
export async function approveAutoChargeAction(chargeId: string): Promise<StartResult> {
  const { userId, orgId } = await requirePermission("billing:manage", AUTO);
  const [me] = await withTenant(orgId, (sql) => sql<{ email: string | null }[]>`SELECT email::text AS email FROM users WHERE id = ${userId}`);
  return approveAutoCharge({ orgId, userId, userEmail: me?.email ?? null, chargeId: String(chargeId ?? "").slice(0, 40) });
}

/** Pay a month's plan that waits for the client, through Checkout. */
export async function payRenewalAction(renewalId: string): Promise<StartResult> {
  const { userId, orgId } = await requirePermission("billing:manage", PAGE);
  const [me] = await withTenant(orgId, (sql) => sql<{ email: string | null }[]>`SELECT email::text AS email FROM users WHERE id = ${userId}`);
  return payRenewal({ orgId, userId, userEmail: me?.email ?? null, renewalId: String(renewalId ?? "").slice(0, 40) });
}

export type MandateStart = { ok: true; checkout: MandateCheckout } | { ok: false; message: string };

/** Start setting up automatic payment: a customer and an order at Razorpay, capped at the monthly limit. */
export async function startMandateSetupAction(method: string): Promise<MandateStart> {
  const { userId, orgId } = await requirePermission("billing:manage", AUTO);
  const [me] = await withTenant(orgId, (sql) => sql<{ email: string | null }[]>`SELECT email::text AS email FROM users WHERE id = ${userId}`);
  return startMandateSetup({ orgId, userId, userEmail: me?.email ?? null, method: String(method ?? "").slice(0, 20) });
}

/** Checkout's answer for a mandate. Saved now when the token is confirmed; a bank e-mandate waits for its bank. */
export async function confirmMandateSetupAction(p: { orderId: string; paymentId: string; signature: string }): Promise<{ ok: true; next: string } | { ok: false; message: string }> {
  const { userId, orgId } = await requirePermission("billing:manage", AUTO);
  const r = await confirmMandateSetup({
    orgId,
    userId,
    orderId: String(p?.orderId ?? "").slice(0, 100),
    paymentId: String(p?.paymentId ?? "").slice(0, 100),
    signature: String(p?.signature ?? "").slice(0, 200),
  });
  if (!r.ok) return r;
  revalidatePath(AUTO);
  const said = r.status === "CONFIRMED" ? "Automatic payment is set up." : "Your bank is confirming it. It shows here once it has.";
  return { ok: true, next: `${AUTO}?${flash("saved", said)}` };
}

/** Stop using the saved automatic payment. */
export async function stopMandateAction(): Promise<void> {
  const { userId, orgId } = await requirePermission("billing:manage", AUTO);
  const r = await stopMandate({ orgId, userId });
  revalidatePath(AUTO);
  redirect(`${AUTO}?${r.ok ? flash("saved", "Automatic payment stopped. Each top-up now waits for you to pay it.") : flash("error", r.message)}`);
}

/** Checkout's answer. Settles now; the webhook that follows finds it settled. */
export async function confirmTopUpAction(p: { orderId: string; paymentId: string; signature: string }): Promise<{ ok: true; next: string } | { ok: false; message: string }> {
  const { userId, orgId } = await requirePermission("billing:manage", PAGE);
  const r = await confirmTopUp({
    orgId,
    userId,
    orderId: String(p?.orderId ?? "").slice(0, 100),
    paymentId: String(p?.paymentId ?? "").slice(0, 100),
    signature: String(p?.signature ?? "").slice(0, 200),
  });
  if (!r.ok) return r;
  revalidatePath(PAGE);
  return {
    ok: true,
    next: `${PAGE}/invoices?${flash("saved", r.purpose === "RENEWAL" ? "Your plan is paid for the month. Its invoice is below." : "Top-up added. Its invoice is below.")}`,
  };
}
