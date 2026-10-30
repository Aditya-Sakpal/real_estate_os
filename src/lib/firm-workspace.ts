import { audit, withTenant } from "./db/index.ts";
import { isRejectReason, istDay } from "./partner-rules.ts";
import type { FirmHalf } from "./mandate-rules.ts";
import { readProfile, type ProfileInput } from "./firm-profile-rules.ts";

/**
 * A mandate firm's own workspace: what the developers owe it, and its own
 * record. Everything here is read in the firm's tenant; the one read of a
 * developer's rows is `mandate_payouts_for_firm()`, which returns only the
 * commission owed to this firm.
 */

export type FirmCommission = {
  id: string;
  developer: string;
  project: string;
  unit: string | null;
  agreement: number;
  rate: number;
  bookedOn: string;
  cancelled: boolean;
  halves: FirmHalf[];
  /** The buyer the booking is for, as the lead is named; the firm worked them through the mandate. */
  buyer: string | null;
};

export async function firmCommission(firmOrgId: string): Promise<FirmCommission[]> {
  const rows = await withTenant(firmOrgId, (sql) => sql<{
    payout_id: string; developer: string; project: string; unit: string | null; agreement: string; rate: string;
    booked_on: Date; cancelled: boolean; buyer: string | null;
    halves: {
      key: "M1" | "M2"; net: number; gross: number; stage: FirmHalf["stage"]; paid_on: string | null; owed: boolean;
      invoice_no: string | null; invoice_date: string | null; rejected: boolean | null; reject_reason: string | null;
    }[];
  }[]>`SELECT payout_id, developer, project, unit, agreement, rate, booked_on, cancelled, halves, buyer FROM mandate_payouts_for_firm()`);
  return rows.map((r) => ({
    id: r.payout_id,
    developer: r.developer,
    project: r.project,
    unit: r.unit,
    agreement: Number(r.agreement),
    rate: Number(r.rate),
    // A date column comes back as midnight UTC, so its own day is the date.
    bookedOn: r.booked_on.toISOString().slice(0, 10),
    cancelled: r.cancelled,
    buyer: r.buyer,
    halves: r.halves.map((h) => ({
      key: h.key,
      net: Number(h.net),
      gross: Number(h.gross),
      stage: h.stage,
      paidOn: h.paid_on ? String(h.paid_on).slice(0, 10) : null,
      owed: !!h.owed,
      invoiceNo: h.invoice_no,
      invoiceDate: h.invoice_date ? String(h.invoice_date).slice(0, 10) : null,
      // Only the latest invoice speaks: one sent back and replaced is no longer the story.
      rejected: !!h.rejected && h.stage === "NONE",
      rejectReason: isRejectReason(h.reject_reason) ? h.reject_reason : null,
    })),
  }));
}

/**
 * A channel partner's number was proved with a code at sign-up and is where
 * developers reach it, so it is never changed from a form: `keepPhone`.
 */
export async function saveProfile(opts: { orgId: string; userId: string; input: ProfileInput; keepPhone?: boolean; nowIso?: string }): Promise<{ ok: true; message: string } | { ok: false; message: string; errors?: Record<string, string> }> {
  const read = readProfile(opts.keepPhone ? { ...opts.input, phone: "" } : opts.input, istDay(opts.nowIso ?? new Date().toISOString()));
  if (!read.ok) return { ok: false, message: "Check the highlighted fields.", errors: read.errors };
  const v = read.values;
  await withTenant(opts.orgId, (sql) =>
    opts.keepPhone
      ? sql`
          UPDATE firm_profiles SET rera_agent_no = ${v.reraNo}, rera_valid_till = ${v.reraTill}, city = ${v.city}, updated_at = now()
          WHERE org_id = ${opts.orgId}`
      : sql`
          INSERT INTO firm_profiles (org_id, rera_agent_no, rera_valid_till, city, phone)
          VALUES (${opts.orgId}, ${v.reraNo}, ${v.reraTill}, ${v.city}, ${v.phone})
          ON CONFLICT (org_id) DO UPDATE SET rera_agent_no = EXCLUDED.rera_agent_no, rera_valid_till = EXCLUDED.rera_valid_till,
            city = EXCLUDED.city, phone = EXCLUDED.phone, updated_at = now()`);
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "firm.profile_updated", targetType: "org", targetId: opts.orgId, metadata: { has_till: !!v.reraTill, has_phone: !!v.phone } });
  return { ok: true, message: "Saved." };
}
