import type { Sql } from "postgres";
import { refundFor, refundRefusal, refundStatusOf, type RefundStatus } from "./credit-note-rules.ts";
import { razorpay, razorpayConfig } from "./razorpay.ts";

/**
 * Sending a credit note's money back through Razorpay. The operator's
 * script calls it on the OWNER's connection (the app role holds no grant
 * to write a refund, and the database refuses one past what the payment
 * took, 0077). The rules are `credit-note-rules.ts`.
 *
 * The order: every refusal that costs only a query, then the payment read
 * back from Razorpay to confirm it still holds that much, then the credit
 * note marked asked before anything is sent, then a look at the refunds
 * Razorpay already holds on the payment (a lost answer is found there, by
 * the credit note's id), then the refund, then what came back, recorded.
 */

export type RefundResult =
  | { ok: true; status: Exclude<RefundStatus, "REQUESTED">; refundId: string; amountPaise: number; already: boolean; orgId: string; creditNoteId: string }
  | { ok: false; message: string; orgId?: string; creditNoteId?: string; asked?: boolean };

type Row = {
  id: string;
  org_id: string;
  number: string;
  kind: string;
  purpose: string;
  test: boolean;
  total_paise: string;
  refund_status: RefundStatus | null;
  refund_paise: string | null;
  refund_ref: string | null;
  refund_attempts: number;
  payment_id: string | null;
  pay_status: string | null;
  pay_total: string | null;
  pay_ref: string | null;
  pay_test: boolean | null;
};

export async function refundCreditNote(sql: Sql, creditNoteNumber: string, nowIso = new Date().toISOString()): Promise<RefundResult> {
  const [cn] = await sql<Row[]>`
    SELECT cn.id, cn.org_id, cn.number, cn.kind, cn.purpose, cn.test, cn.total_paise, cn.refund_status, cn.refund_paise,
           cn.refund_ref, cn.refund_attempts, i.payment_id, p.status AS pay_status, p.total_paise AS pay_total,
           p.payment_ref AS pay_ref, p.test AS pay_test
    FROM invoices cn
    LEFT JOIN invoices i ON i.id = cn.reverses
    LEFT JOIN payments p ON p.id = i.payment_id
    WHERE cn.number = ${creditNoteNumber}`;
  if (!cn) return { ok: false, message: `No credit note ${creditNoteNumber}.` };
  const who = { orgId: cn.org_id, creditNoteId: cn.id };
  const cfg = razorpayConfig();
  if (cn.refund_status === "PROCESSED") {
    return { ok: true, status: "PROCESSED", refundId: cn.refund_ref!, amountPaise: Number(cn.refund_paise), already: true, ...who };
  }
  const [{ others }] = await sql<{ others: string }[]>`
    SELECT coalesce(sum(o.refund_paise), 0) AS others
    FROM invoices o JOIN invoices oi ON oi.id = o.reverses
    WHERE oi.payment_id = ${cn.payment_id} AND o.id <> ${cn.id} AND o.refund_paise IS NOT NULL AND o.refund_status IS DISTINCT FROM 'FAILED'`;
  const amount = Number(cn.total_paise);
  const refused = refundRefusal({
    creditNote: { kind: cn.kind, purpose: cn.purpose, test: cn.test, totalPaise: amount, status: cn.refund_status, attempts: cn.refund_attempts },
    payment: cn.payment_id ? { status: cn.pay_status ?? "", totalPaise: Number(cn.pay_total ?? 0), ref: cn.pay_ref, test: !!cn.pay_test } : null,
    othersPaise: Number(others),
    gatewayTest: cfg.ok ? cfg.config.test : null,
  });
  if (refused) return { ok: false, message: refused, ...who };
  if (!cfg.ok || !cn.pay_ref) return { ok: false, message: "Razorpay is not configured.", ...who };
  const drv = razorpay();
  const note = { id: cn.id, number: cn.number };

  // A refund already asked for and still pending is only read again.
  if (cn.refund_status === "PENDING" && cn.refund_ref) {
    const found = (await drv.paymentRefunds(cfg.config, cn.pay_ref)).find((r) => r.id === cn.refund_ref);
    if (!found) return { ok: false, message: "Razorpay does not show that refund yet. Ask again later.", ...who };
    return record(sql, cn, found.id, found.status, amount, nowIso);
  }

  // The payment as Razorpay holds it now: what it took, less what it has given back.
  let held: number;
  try {
    const p = await drv.fetchPayment(cfg.config, cn.pay_ref);
    held = p.amount - (p.amountRefunded ?? 0);
  } catch (e) {
    console.error(`billing: payment ${cn.pay_ref} could not be read`, e);
    return { ok: false, message: "Razorpay did not answer. Nothing was refunded; ask again.", ...who };
  }

  // Asked before it is sent, so a try whose answer is lost is looked for next time.
  const askedBefore = cn.refund_status === "REQUESTED";
  const claimed = await sql`
    UPDATE invoices SET refund_status = 'REQUESTED', refund_paise = coalesce(refund_paise, ${amount}),
           refund_ref = CASE WHEN refund_status = 'FAILED' THEN NULL ELSE refund_ref END,
           refund_attempts = refund_attempts + 1, refund_requested_at = coalesce(refund_requested_at, ${nowIso}::timestamptz)
    WHERE id = ${cn.id} AND refund_status IS NOT DISTINCT FROM ${cn.refund_status} AND refund_attempts = ${cn.refund_attempts}`;
  if (!claimed.count) return { ok: false, message: "Somebody else is refunding this credit note now.", ...who };

  try {
    if (askedBefore || cn.refund_status === "FAILED") {
      const earlier = refundFor(await drv.paymentRefunds(cfg.config, cn.pay_ref), note);
      if (earlier) return record(sql, cn, earlier.id, earlier.status, amount, nowIso);
    }
    if (held < amount) {
      return { ok: false, message: "Razorpay holds less on that payment than the credit note; nothing was refunded.", asked: true, ...who };
    }
    const r = await drv.createRefund(cfg.config, cn.pay_ref, { amountPaise: amount, receipt: cn.number, notes: { credit_note: cn.id, org: cn.org_id } });
    return record(sql, cn, r.id, r.status, amount, nowIso);
  } catch (e) {
    console.error(`billing: the refund for ${cn.number} was not answered`, e);
    return { ok: false, message: "Razorpay did not answer. The refund is marked asked; run it again and it will look before refunding twice.", asked: true, ...who };
  }
}

async function record(sql: Sql, cn: Row, refundId: string, status: string, amount: number, nowIso: string): Promise<RefundResult> {
  const s = refundStatusOf(status);
  await sql`
    UPDATE invoices SET refund_status = ${s}, refund_ref = ${refundId},
           refund_settled_at = ${s === "PROCESSED" ? nowIso : null}::timestamptz
    WHERE id = ${cn.id} AND refund_status IN ('REQUESTED', 'PENDING')`;
  return { ok: true, status: s, refundId, amountPaise: amount, already: false, orgId: cn.org_id, creditNoteId: cn.id };
}
