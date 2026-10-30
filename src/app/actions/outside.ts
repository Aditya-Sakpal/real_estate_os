"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/guard";
import { getViewer } from "@/lib/console";
import {
  answerOutside,
  cancelOutsideBooking,
  makeOutsideInvoice,
  recordInvoicePaid,
  recordOutsideBooking,
  registerOutside,
  resendOutside,
  saveSetup,
} from "@/lib/outside";

/**
 * A channel partner's buyers and brokerage with developers not on
 * Sales Desk. Each action names its key: `org:manage` sets a developer up,
 * `partner:register` registers and records bookings, and making an invoice
 * or recording its payment needs that and `payout:read`.
 */

export type OutsideFormState = { ok: boolean; message: string; errors?: Record<string, string> } | null;

const text = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function partnerOnly(): Promise<string | null> {
  const viewer = await getViewer();
  return viewer && viewer.orgType === "CHANNEL_PARTNER" && !viewer.via ? null : "Only a channel partner does this.";
}

function refresh() {
  revalidatePath("/dashboard/developers");
  revalidatePath("/dashboard/developers/buyers");
  revalidatePath("/dashboard/developers/payouts");
  revalidatePath("/dashboard");
}

export async function saveSetupAction(_: OutsideFormState, fd: FormData): Promise<OutsideFormState> {
  const g = await requirePermission("org:manage", "/dashboard/developers");
  const refused = await partnerOnly();
  if (refused) return { ok: false, message: refused };
  const raw = Object.fromEntries(["regEmail", "regCc", "validityDays", "rate", "gstin", "billAddress", "stateCode"].map((k) => [k, text(fd, k)]));
  const r = await saveSetup({ orgId: g.orgId, userId: g.userId, entityId: text(fd, "entityId"), raw });
  if (r.ok) refresh();
  return r;
}

export async function registerOutsideAction(_: OutsideFormState, fd: FormData): Promise<OutsideFormState> {
  const g = await requirePermission("partner:register", "/dashboard/developers");
  const refused = await partnerOnly();
  if (refused) return { ok: false, message: refused };
  const r = await registerOutside({
    orgId: g.orgId,
    userId: g.userId,
    projectId: text(fd, "projectId"),
    name: text(fd, "name"),
    phone: text(fd, "phone"),
    leadId: text(fd, "leadId") || null,
    mayRegisterAt: (path) => g.authz.canAt("partner:register", path) || g.authz.canAt("lead:update", path),
  });
  refresh();
  return r;
}

export async function resendOutsideAction(input: { id: string }): Promise<OutsideFormState> {
  const g = await requirePermission("partner:register", "/dashboard/developers");
  const r = await resendOutside({ orgId: g.orgId, userId: g.userId, id: String(input?.id ?? "") });
  refresh();
  return r;
}

export async function answerOutsideAction(input: { id: string; answer: "CONFIRMED" | "REFUSED" | "WITHDRAWN" }): Promise<OutsideFormState> {
  const g = await requirePermission("partner:register", "/dashboard/developers");
  const r = await answerOutside({ orgId: g.orgId, userId: g.userId, id: String(input?.id ?? ""), answer: input?.answer });
  refresh();
  return r;
}

export async function recordBookingAction(_: OutsideFormState, fd: FormData): Promise<OutsideFormState> {
  const g = await requirePermission("partner:register", "/dashboard/developers");
  const refused = await partnerOnly();
  if (refused) return { ok: false, message: refused };
  const r = await recordOutsideBooking({
    orgId: g.orgId,
    userId: g.userId,
    registrationId: text(fd, "registrationId") || null,
    projectId: text(fd, "projectId") || null,
    buyerName: text(fd, "buyerName") || null,
    unit: text(fd, "unit"),
    bookedOn: text(fd, "bookedOn"),
    agreement: text(fd, "agreement"),
    rate: text(fd, "rate") || null,
  });
  refresh();
  return r;
}

export async function cancelBookingAction(input: { id: string }): Promise<OutsideFormState> {
  const g = await requirePermission("partner:register", "/dashboard/developers");
  const r = await cancelOutsideBooking({ orgId: g.orgId, userId: g.userId, id: String(input?.id ?? "") });
  refresh();
  return r;
}

export async function makeInvoiceAction(input: { bookingId: string }): Promise<OutsideFormState & { invoiceId?: string }> {
  const g = await requirePermission("payout:read", "/dashboard/developers");
  if (!g.authz.can("partner:register")) return { ok: false, message: "Your role cannot make invoices." };
  const r = await makeOutsideInvoice({ orgId: g.orgId, userId: g.userId, bookingId: String(input?.bookingId ?? "") });
  refresh();
  return r;
}

export async function recordPaidAction(_: OutsideFormState, fd: FormData): Promise<OutsideFormState> {
  const g = await requirePermission("payout:read", "/dashboard/developers");
  if (!g.authz.can("partner:register")) return { ok: false, message: "Your role cannot record payments." };
  const r = await recordInvoicePaid({
    orgId: g.orgId,
    userId: g.userId,
    invoiceId: text(fd, "invoiceId"),
    paidOn: text(fd, "paidOn"),
    amount: text(fd, "amount"),
    utr: text(fd, "utr"),
  });
  refresh();
  return r;
}
