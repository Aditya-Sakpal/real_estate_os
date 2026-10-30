/**
 * Credit notes: the pure half. No database, no Node built-ins.
 *
 * An issued tax invoice is never edited. When its value was too high (a
 * top-up refunded, a plan billed for days it did not run, a price typed
 * wrong), the supplier issues a credit note: section 34 of the CGST Act,
 * with what it must carry set by Rule 53 of the CGST Rules. The supplier's
 * name, address and GSTIN; the nature of the document; a consecutive serial
 * number of at most sixteen characters, unique for the financial year; the
 * date; the recipient's name, address and GSTIN; the serial number and date
 * of the invoice it corrects; the taxable value, the rate and the tax
 * credited; and a signature (taxinformation.cbic.gov.in, CGST Rules,
 * chapter 6, rule 53(1A)).
 *
 * `invoice.ts` numbers and stores one; `scripts/billing.mts credit-note` is
 * the only thing that asks it to. The database (0071) refuses a credit note
 * past these same limits, so this file is the explanation and the trigger
 * is the control.
 */
import { SAC, financialYear, invoiceNumber, taxFor, type InvoiceLine, type Series } from "./billing-rules.ts";

/** Credit notes run their own series: ECN for real, TCN in test mode. "ECN/26-27/00001" is fifteen characters. */
export const creditSeries = (test: boolean): Series => (test ? "TCN" : "ECN");

export function creditNoteNumber(test: boolean, issuedOn: string, seq: number): string {
  return invoiceNumber(creditSeries(test), financialYear(issuedOn), seq);
}

/**
 * The last day a credit note may be issued against an invoice: section
 * 34(2) wants it declared no later than 30 November after the end of the
 * financial year of the supply (or the annual return, if that is earlier,
 * which only the client's accountant knows).
 */
export function creditNoteDeadline(invoiceIssuedOn: string): string {
  const fy = financialYear(invoiceIssuedOn);
  const endYear = 2000 + Number(fy.slice(3, 5));
  return `${endYear}-11-30`;
}

export const REASON_MIN = 3;
export const REASON_MAX = 300;

/** The reason printed on the credit note. Plain text, one line. */
export function readReason(raw: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (reason.length < REASON_MIN) return { ok: false, message: "Say why the value is reduced (--reason)." };
  if (reason.length > REASON_MAX) return { ok: false, message: `Keep the reason under ${REASON_MAX} characters.` };
  return { ok: true, reason };
}

/** The invoice being corrected, and what credit notes have already taken off it. */
export type Original = {
  number: string;
  issuedOn: string;
  sellerState: string;
  placeOfSupply: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  credited: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number };
};

export type CreditPlan = {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  line: InvoiceLine;
};

const longDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * What one credit note credits. `amount` is the taxable value taken off,
 * in paise, or "ALL" for whatever the invoice still holds.
 *
 * The tax follows the invoice's own heads: IGST if it charged IGST, CGST
 * and SGST if it charged those, each rounded on its own. A credit note that
 * takes the last of the invoice takes the last of each head exactly, so the
 * invoice and its credit notes always net to nothing, never to a paisa.
 */
export function planCreditNote(o: Original, amount: number | "ALL", issuedOn: string): { ok: true; plan: CreditPlan } | { ok: false; message: string } {
  const left = {
    taxable: o.taxablePaise - o.credited.taxablePaise,
    cgst: o.cgstPaise - o.credited.cgstPaise,
    sgst: o.sgstPaise - o.credited.sgstPaise,
    igst: o.igstPaise - o.credited.igstPaise,
  };
  if (left.taxable <= 0) return { ok: false, message: `${o.number} has been credited in full already.` };
  const taxable = amount === "ALL" ? left.taxable : amount;
  if (!Number.isInteger(taxable) || taxable <= 0) return { ok: false, message: "The amount is a whole number of paise, more than zero." };
  if (taxable > left.taxable) return { ok: false, message: `${o.number} has ${left.taxable} paise of taxable value left to credit; ${taxable} is more.` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn) || issuedOn < o.issuedOn) return { ok: false, message: "A credit note is not dated before its invoice." };
  const deadline = creditNoteDeadline(o.issuedOn);
  if (issuedOn > deadline) return { ok: false, message: `The last day for a credit note on ${o.number} was ${longDate(deadline)}.` };

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (taxable === left.taxable) {
    cgst = left.cgst;
    sgst = left.sgst;
    igst = left.igst;
  } else if (o.igstPaise > 0 || o.cgstPaise > 0 || o.sgstPaise > 0) {
    // The same regime as the invoice, whatever the states say today.
    const inter = o.igstPaise > 0;
    const t = taxFor(taxable, "00", inter ? "01" : "00");
    cgst = Math.min(t.cgst, left.cgst);
    sgst = Math.min(t.sgst, left.sgst);
    igst = Math.min(t.igst, left.igst);
  }
  return {
    ok: true,
    plan: {
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: igst,
      totalPaise: taxable + cgst + sgst + igst,
      line: {
        description: `Reduction in the value of invoice ${o.number} dated ${longDate(o.issuedOn)}`,
        sac: SAC,
        qty: 1,
        unitPaise: taxable,
        amountPaise: taxable,
      },
    },
  };
}

/** One lot a top-up purchase left in the wallet, and what was paid for it before GST. */
export type PurchaseLot = { id: string; unit: string; qty: number; left: number; expiresAt: string; pricePaise?: number | null };

/**
 * What a credit note on a top-up takes back out of the wallet: the share of
 * each of the purchase's lots the credited value paid for, rounded up to a
 * whole unit (a paisa, for WhatsApp credit), and never more than the lot
 * still holds. Naming a unit (`only`) credits that item of the basket
 * alone, measured against what that lot cost. A lot past its date holds
 * nothing to take back. A credit note on a purchase that was all used
 * takes nothing back; it is still a credit note.
 */
export function reverseTake(
  lots: readonly PurchaseLot[],
  creditTaxablePaise: number,
  invoiceTaxablePaise: number,
  nowIso: string,
  only?: string | null,
): { lotId: string; unit: string; qty: number }[] {
  if (invoiceTaxablePaise <= 0 || creditTaxablePaise <= 0) return [];
  const now = Date.parse(nowIso);
  const out: { lotId: string; unit: string; qty: number }[] = [];
  for (const l of lots) {
    if (only && l.unit !== only) continue;
    if (l.left <= 0 || Date.parse(l.expiresAt) <= now) continue;
    const base = only && l.pricePaise ? l.pricePaise : invoiceTaxablePaise;
    const share = Math.min(1, creditTaxablePaise / base);
    const want = share >= 1 ? l.qty : Math.ceil(l.qty * share - 1e-9);
    const take = Math.min(l.left, want);
    if (take > 0) out.push({ lotId: l.id, unit: l.unit, qty: take });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The money behind a credit note, sent back
// ---------------------------------------------------------------------------

/**
 * A credit note on a top-up that was paid through Razorpay may send its
 * amount back to whoever paid (`npm run billing -- credit-note ... --refund`,
 * or `refund <credit note>` to ask again). What was asked and what came back
 * is recorded on the credit note. Never more than the payment took, counting
 * every refund against it, and never a second refund for one credit note: a
 * try whose answer was lost is looked for at Razorpay, by the credit note's
 * id in the refund's notes, before it is asked again.
 */
export const MAX_REFUND_ATTEMPTS = 5;

export type RefundStatus = "REQUESTED" | "PENDING" | "PROCESSED" | "FAILED";

export type RefundFacts = {
  creditNote: { kind: string; purpose: string; test: boolean; totalPaise: number; status: RefundStatus | null; attempts: number };
  /** The payment behind the invoice the credit note corrects, when there is one. */
  payment: { status: string; totalPaise: number; ref: string | null; test: boolean } | null;
  /** What other credit notes against the same payment have asked back, a failed one not counted. */
  othersPaise: number;
  /** The gateway's own mode, or null when no keys are set. */
  gatewayTest: boolean | null;
};

/** Why this credit note's money cannot be sent back, in the operator's words, or null when it can. */
export function refundRefusal(f: RefundFacts): string | null {
  if (f.creditNote.kind !== "CREDIT_NOTE") return "Only a credit note is refunded.";
  if (f.creditNote.status === "PROCESSED") return "Already refunded.";
  if (f.creditNote.status === "PENDING") return null;
  if (f.creditNote.purpose !== "TOPUP" || !f.payment) return "Only a top-up paid through Razorpay is refunded this way. A plan is refunded by bank transfer.";
  if (f.payment.status !== "PAID" || !f.payment.ref) return "The payment behind this credit note was never captured.";
  if (f.gatewayTest === null) return "Razorpay is not configured: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.";
  if (f.gatewayTest !== f.payment.test) return f.payment.test ? "This was paid in test mode; refund it with the test keys." : "This was paid for real; test keys cannot refund it.";
  if (f.creditNote.test !== f.payment.test) return "The credit note and its payment are in different modes.";
  if (f.creditNote.attempts >= MAX_REFUND_ATTEMPTS) return `Asked ${MAX_REFUND_ATTEMPTS} times already. Look at the payment in Razorpay's dashboard.`;
  if (f.othersPaise + f.creditNote.totalPaise > f.payment.totalPaise) return "That would refund more than the payment took.";
  return null;
}

/** What Razorpay's refund status means here. */
export function refundStatusOf(status: string): Exclude<RefundStatus, "REQUESTED"> {
  const s = status.toLowerCase();
  if (s === "processed") return "PROCESSED";
  if (s === "failed") return "FAILED";
  return "PENDING";
}

/**
 * The refund an earlier try already made for this credit note, if Razorpay
 * holds one: named by the credit note's id in its notes, or by its number as
 * the receipt. A failed one is not it.
 */
export function refundFor<T extends { status: string; receipt: string | null; notes: Record<string, string> }>(
  refunds: readonly T[],
  creditNote: { id: string; number: string },
): T | null {
  return refunds.find((r) => r.status.toLowerCase() !== "failed" && (r.notes.credit_note === creditNote.id || r.receipt === creditNote.number)) ?? null;
}
