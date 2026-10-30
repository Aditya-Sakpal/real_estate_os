import type { TransactionSql } from "postgres";
import { withTenant } from "./db/index.ts";
import {
  GST_RATE,
  STATE_NAMES,
  amountInWords,
  draftInvoice,
  financialYear,
  invoiceNumber,
  rupees,
  sellerFromEnv,
  testSeller,
  type InvoiceLine,
  type Party,
  type Series,
} from "./billing-rules.ts";
import { creditNoteNumber, creditSeries, planCreditNote, readReason, reverseTake } from "./credit-note-rules.ts";
import { A4, pdfDocument, textWidth, wrap, type Draw } from "./pdf.ts";

/**
 * GST tax invoices: issued, stored whole, and drawn as a PDF on request.
 *
 * What a tax invoice must carry is CGST Rule 46: the supplier's name,
 * address and GSTIN; a consecutive serial number of at most sixteen
 * characters, unique for the financial year; the date; the recipient's name,
 * address and GSTIN; the SAC; a description; the taxable value; the rate
 * and amount of CGST and SGST, or of IGST; the place of supply; whether tax
 * is on reverse charge; and a signature
 * (taxinformation.cbic.gov.in, CGST Rules, chapter 6, rule 46).
 *
 * An invoice is stored as it was issued, seller and buyer included, and the
 * PDF is drawn from that row every time: a company that moves office does
 * not rewrite last year's invoices. The row is never edited; a correction is
 * a credit note.
 */

export type Invoice = {
  id: string;
  number: string;
  kind: "INVOICE" | "CREDIT_NOTE";
  purpose: "TOPUP" | "PLAN";
  test: boolean;
  issuedOn: string;
  period: string | null;
  seller: Party & { bank?: string | null };
  buyer: Party;
  placeOfSupply: string;
  lines: InvoiceLine[];
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  paymentRef: string | null;
  /** A credit note: why, and the invoice it corrects. */
  reason: string | null;
  against: { id: string; number: string; issuedOn: string } | null;
};

/**
 * Who the organisation is billed as: the name and GSTIN set under Billing
 * details, or the organisation's own. Null when the state cannot be known,
 * because the place of supply decides which tax applies.
 */
export async function buyerOf(sql: TransactionSql, orgId: string): Promise<Party | null> {
  const [r] = await sql<{ legal_name: string; gstin: string | null; bill_name: string | null; bill_gstin: string | null; bill_address: string | null; bill_state: string | null }[]>`
    SELECT o.legal_name, o.gstin, b.bill_name, b.bill_gstin, b.bill_address, b.bill_state
    FROM orgs o LEFT JOIN billing_accounts b ON b.org_id = o.id
    WHERE o.id = ${orgId}`;
  if (!r) return null;
  const gstin = r.bill_gstin ?? r.gstin;
  const state = r.bill_state ?? gstin?.slice(0, 2) ?? null;
  if (!state || !(state in STATE_NAMES)) return null;
  return { name: r.bill_name ?? r.legal_name, gstin, address: r.bill_address, state };
}

/**
 * Number and store one invoice, inside the caller's transaction. The number
 * comes from the series counter in the same transaction, so an invoice that
 * rolls back takes its number with it and the series stays unbroken.
 */
export async function issueInvoice(
  sql: TransactionSql,
  input: {
    orgId: string;
    purpose: "TOPUP" | "PLAN";
    test: boolean;
    lines: readonly Omit<InvoiceLine, "amountPaise" | "sac">[];
    seller: Party;
    bank?: string | null;
    buyer: Party;
    issuedOn: string;
    paymentId?: string | null;
    period?: string | null;
    createdBy?: string | null;
  },
): Promise<{ id: string; number: string; totalPaise: number }> {
  const series: Series = input.test ? "TST" : "EST";
  const fy = financialYear(input.issuedOn);
  const [{ seq }] = await sql<{ seq: number }[]>`SELECT next_invoice_seq(${series}, ${fy}) AS seq`;
  const number = invoiceNumber(series, fy, seq);
  const draft = draftInvoice(input.lines, input.seller, input.buyer);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO invoices (org_id, number, series, fy, seq, kind, purpose, test, issued_on, period, seller, buyer,
                          place_of_supply, lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
                          payment_id, created_by)
    VALUES (${input.orgId}, ${number}, ${series}, ${fy}, ${seq}, 'INVOICE', ${input.purpose}, ${input.test},
            ${input.issuedOn}, ${input.period ?? null},
            ${sql.json({ ...input.seller, bank: input.bank ?? null } as never)}, ${sql.json(input.buyer as never)},
            ${draft.placeOfSupply}, ${sql.json(draft.lines as never)}, ${draft.taxablePaise}, ${draft.cgstPaise},
            ${draft.sgstPaise}, ${draft.igstPaise}, ${draft.totalPaise}, ${input.paymentId ?? null}, ${input.createdBy ?? null})
    RETURNING id`;
  return { id: row.id, number, totalPaise: draft.totalPaise };
}

export type CreditNoteResult =
  | { ok: true; id: string; number: string; totalPaise: number; taken: { unit: string; qty: number }[] }
  | { ok: false; message: string };

/**
 * Issue one credit note against an issued invoice, inside the caller's
 * transaction, which is the OPERATOR's: the database refuses a credit note
 * from anybody else (0071), as it refuses free credit.
 *
 * It carries the invoice's own buyer, place of supply and tax heads, runs
 * the ECN series (TCN in test mode), and on a top-up takes back what is
 * still unused of that purchase's lots, in proportion to what it credits.
 * The seller is `BILLING_SELLER_*` as it stands, and a real credit note is
 * refused when that is not the company that issued the invoice.
 */
export async function issueCreditNote(
  sql: TransactionSql,
  input: {
    orgId: string;
    invoiceNumber: string;
    amount: number | "ALL";
    reason: string;
    issuedOn: string;
    /** On a top-up of several items, the one being credited (`MINUTE`, `VIDEO`...). */
    unit?: string | null;
    env?: Record<string, string | undefined>;
    nowIso?: string;
  },
): Promise<CreditNoteResult> {
  const env = input.env ?? process.env;
  const read = readReason(input.reason);
  if (!read.ok) return read;
  const [orig] = await sql<{ id: string; kind: string; test: boolean; purpose: "TOPUP" | "PLAN"; issued_on: string; period: string | null; seller: Party & { bank?: string | null }; buyer: Party; place_of_supply: string; taxable_paise: string; cgst_paise: string; sgst_paise: string; igst_paise: string; payment_id: string | null; number: string }[]>`
    SELECT id, kind, test, purpose, issued_on::text AS issued_on, period::text AS period, seller, buyer, place_of_supply,
           taxable_paise, cgst_paise, sgst_paise, igst_paise, payment_id, number
    FROM invoices WHERE org_id = ${input.orgId} AND number = ${input.invoiceNumber} FOR UPDATE`;
  if (!orig) return { ok: false, message: `No invoice ${input.invoiceNumber} in that organisation.` };
  if (orig.kind !== "INVOICE") return { ok: false, message: `${orig.number} is itself a credit note.` };

  let seller: Party;
  let bank: string | null = null;
  if (orig.test) {
    seller = testSeller(env);
  } else {
    const s = sellerFromEnv(env);
    if (!s.ok) return { ok: false, message: `No credit note without the seller: set ${s.missing.join(", ")}.` };
    if (s.seller.gstin !== orig.seller.gstin) return { ok: false, message: `${orig.number} was issued under GSTIN ${orig.seller.gstin ?? "none"}; a credit note comes from the same registration.` };
    seller = s.seller;
    bank = s.bank;
  }

  const [done] = await sql<{ t: string; c: string; s: string; i: string }[]>`
    SELECT coalesce(sum(taxable_paise), 0) AS t, coalesce(sum(cgst_paise), 0) AS c, coalesce(sum(sgst_paise), 0) AS s, coalesce(sum(igst_paise), 0) AS i
    FROM invoices WHERE reverses = ${orig.id}`;
  const planned = planCreditNote(
    {
      number: orig.number,
      issuedOn: orig.issued_on,
      sellerState: orig.seller.state,
      placeOfSupply: orig.place_of_supply,
      taxablePaise: Number(orig.taxable_paise),
      cgstPaise: Number(orig.cgst_paise),
      sgstPaise: Number(orig.sgst_paise),
      igstPaise: Number(orig.igst_paise),
      credited: { taxablePaise: Number(done.t), cgstPaise: Number(done.c), sgstPaise: Number(done.s), igstPaise: Number(done.i) },
    },
    input.amount,
    input.issuedOn,
  );
  if (!planned.ok) return planned;
  const p = planned.plan;
  if (input.unit) {
    if (orig.purpose !== "TOPUP" || !orig.payment_id) return { ok: false, message: "Only a top-up names an item to credit." };
    const [has] = await sql`
      SELECT 1 FROM wallet_entries WHERE org_id = ${input.orgId} AND kind = 'CREDIT' AND payment_id = ${orig.payment_id} AND unit = ${input.unit}`;
    if (!has) return { ok: false, message: `${orig.number} bought no ${input.unit.toLowerCase()} top-up.` };
  }
  const series = creditSeries(orig.test);
  const fy = financialYear(input.issuedOn);
  const [{ seq }] = await sql<{ seq: number }[]>`SELECT next_invoice_seq(${series}, ${fy}) AS seq`;
  const number = creditNoteNumber(orig.test, input.issuedOn, seq);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO invoices (org_id, number, series, fy, seq, kind, purpose, test, issued_on, period, seller, buyer,
                          place_of_supply, lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
                          reverses, reason)
    VALUES (${input.orgId}, ${number}, ${series}, ${fy}, ${seq}, 'CREDIT_NOTE', ${orig.purpose}, ${orig.test},
            ${input.issuedOn}, ${orig.period}, ${sql.json({ ...seller, bank } as never)}, ${sql.json(orig.buyer as never)},
            ${orig.place_of_supply}, ${sql.json([p.line] as never)}, ${p.taxablePaise}, ${p.cgstPaise}, ${p.sgstPaise},
            ${p.igstPaise}, ${p.totalPaise}, ${orig.id}, ${read.reason})
    RETURNING id`;

  // A top-up credited is a top-up taken back, as far as it is unused.
  const taken: { unit: string; qty: number }[] = [];
  if (orig.purpose === "TOPUP" && orig.payment_id) {
    const lots = await sql<{ id: string; unit: string; qty: string; left: string; expires_at: Date; price_paise: string | null }[]>`
      SELECT c.id, c.unit, c.qty, c.expires_at, c.price_paise,
             c.qty - coalesce((SELECT sum(d.qty) FROM wallet_entries d WHERE d.lot_id = c.id), 0) AS left
      FROM wallet_entries c
      WHERE c.org_id = ${input.orgId} AND c.kind = 'CREDIT' AND c.source = 'PURCHASE' AND c.payment_id = ${orig.payment_id}
      ORDER BY c.unit`;
    const plan = reverseTake(
      lots.map((l) => ({ id: l.id, unit: l.unit, qty: Number(l.qty), left: Number(l.left), expiresAt: l.expires_at.toISOString(), pricePaise: l.price_paise === null ? null : Number(l.price_paise) })),
      p.taxablePaise,
      // Measured against what the invoice still held, so the credit note that
      // takes the last of it takes back everything still unused.
      Number(orig.taxable_paise) - Number(done.t),
      input.nowIso ?? new Date().toISOString(),
      input.unit ?? null,
    );
    for (const t of plan) {
      await sql`
        INSERT INTO wallet_entries (org_id, kind, unit, qty, lot_id, source, credit_note_id, test)
        VALUES (${input.orgId}, 'REVERSE', ${t.unit}, ${t.qty}, ${t.lotId}, 'CREDIT_NOTE', ${row.id}, ${orig.test})`;
      taken.push({ unit: t.unit, qty: t.qty });
    }
  }
  return { ok: true, id: row.id, number, totalPaise: p.totalPaise, taken };
}

type InvoiceRow = {
  id: string;
  number: string;
  kind: "INVOICE" | "CREDIT_NOTE";
  purpose: "TOPUP" | "PLAN";
  test: boolean;
  issued_on: string;
  period: string | null;
  seller: Party & { bank?: string | null };
  buyer: Party;
  place_of_supply: string;
  lines: InvoiceLine[];
  taxable_paise: string;
  cgst_paise: string;
  sgst_paise: string;
  igst_paise: string;
  total_paise: string;
  payment_ref: string | null;
  reason: string | null;
  against_id: string | null;
  against_number: string | null;
  against_issued_on: string | null;
};

const toInvoice = (r: InvoiceRow): Invoice => ({
  id: r.id,
  number: r.number,
  kind: r.kind,
  purpose: r.purpose,
  test: r.test,
  issuedOn: r.issued_on,
  period: r.period,
  seller: r.seller,
  buyer: r.buyer,
  placeOfSupply: r.place_of_supply,
  lines: r.lines,
  taxablePaise: Number(r.taxable_paise),
  cgstPaise: Number(r.cgst_paise),
  sgstPaise: Number(r.sgst_paise),
  igstPaise: Number(r.igst_paise),
  totalPaise: Number(r.total_paise),
  paymentRef: r.payment_ref,
  reason: r.reason,
  against: r.against_id && r.against_number && r.against_issued_on ? { id: r.against_id, number: r.against_number, issuedOn: r.against_issued_on } : null,
});

const SELECT_INVOICE = `
  SELECT i.id, i.number, i.kind, i.purpose, i.test, i.issued_on::text AS issued_on, i.period::text AS period,
         i.seller, i.buyer, i.place_of_supply, i.lines, i.taxable_paise, i.cgst_paise, i.sgst_paise, i.igst_paise,
         i.total_paise, p.payment_ref, i.reason, o.id AS against_id, o.number AS against_number, o.issued_on::text AS against_issued_on
  FROM invoices i LEFT JOIN payments p ON p.id = i.payment_id LEFT JOIN invoices o ON o.id = i.reverses`;

export async function listInvoices(orgId: string): Promise<Invoice[]> {
  const rows = await withTenant(orgId, (sql) => sql<InvoiceRow[]>`
    ${sql.unsafe(SELECT_INVOICE)}
    WHERE i.org_id = ${orgId}
    ORDER BY i.issued_on DESC, i.created_at DESC
    LIMIT 200`);
  return rows.map(toInvoice);
}

export async function getInvoice(orgId: string, id: string): Promise<Invoice | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await withTenant(orgId, (sql) => sql<InvoiceRow[]>`
    ${sql.unsafe(SELECT_INVOICE)}
    WHERE i.org_id = ${orgId} AND i.id = ${id}`);
  return row ? toInvoice(row) : null;
}

const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const stateLine = (code: string) => `${STATE_NAMES[code] ?? "Unknown state"} (${code})`;

/** The invoice as a one- or two-page A4 PDF. */
export function renderInvoice(inv: Invoice): Buffer {
  const L = 48;
  const R = A4.w - 48;
  const pages: Draw[][] = [];
  let d: Draw[] = [];
  let y = A4.h - 56;
  const text = (x: number, yy: number, s: string, size = 9, o: { bold?: boolean; gray?: number; align?: "left" | "right" | "center" } = {}) =>
    d.push({ t: "text", x, y: yy, text: s, size, ...o });
  const rule = (yy: number, gray = 0.8, width = 0.5) => d.push({ t: "line", x1: L, y1: yy, x2: R, y2: yy, gray, width });

  const credit = inv.kind === "CREDIT_NOTE";
  const title = inv.test ? (credit ? "TEST CREDIT NOTE" : "TEST INVOICE") : credit ? "CREDIT NOTE" : "TAX INVOICE";
  if (inv.test) {
    d.push({ t: "rect", x: L, y: y - 6, w: R - L, h: 20, gray: 0.9 });
    text((L + R) / 2, y, credit ? "TEST MODE. Not a credit note, and no money moved." : "TEST MODE. Not a tax invoice, and no money was paid.", 9, { bold: true, align: "center" });
    y -= 30;
  }

  // The seller, left; the invoice's own particulars, right.
  const top = y;
  text(L, y, inv.seller.name, 14, { bold: true });
  y -= 16;
  for (const line of wrap(inv.seller.address ?? "", 9, 260)) {
    if (!line) continue;
    text(L, y, line, 9, { gray: 0.3 });
    y -= 12;
  }
  text(L, y, `GSTIN: ${inv.seller.gstin ?? "Not registered"}`, 9, { gray: 0.3 });
  y -= 12;
  text(L, y, `State: ${stateLine(inv.seller.state)}`, 9, { gray: 0.3 });
  const leftBottom = y;

  let ry = top;
  text(R, ry, title, 16, { bold: true, align: "right" });
  ry -= 18;
  const particulars: [string, string][] = [
    [credit ? "Credit note no." : "Invoice no.", inv.number],
    ["Date", longDate(inv.issuedOn)],
  ];
  // Rule 53(1A)(f): the serial number and date of the invoice corrected.
  if (credit && inv.against) particulars.push(["Against invoice", `${inv.against.number} of ${longDate(inv.against.issuedOn)}`]);
  particulars.push(["Place of supply", stateLine(inv.placeOfSupply)], ["Tax on reverse charge", "No"]);
  for (const [k, v] of particulars) {
    text(R, ry, `${k}: ${v}`, 9, { align: "right" });
    ry -= 12;
  }
  y = Math.min(leftBottom, ry) - 18;
  rule(y + 8);

  // The buyer.
  text(L, y - 6, "BILL TO", 8, { bold: true, gray: 0.45 });
  y -= 20;
  text(L, y, inv.buyer.name, 11, { bold: true });
  y -= 13;
  for (const line of wrap(inv.buyer.address ?? "", 9, 330)) {
    if (!line) continue;
    text(L, y, line, 9, { gray: 0.3 });
    y -= 12;
  }
  text(L, y, `GSTIN: ${inv.buyer.gstin ?? "Unregistered"}`, 9, { gray: 0.3 });
  y -= 12;
  text(L, y, `State: ${stateLine(inv.buyer.state)}`, 9, { gray: 0.3 });
  y -= 24;

  // The lines.
  const cols = { n: L + 4, desc: L + 24, sac: 322, qty: 382, rate: 462, amount: R - 4 };
  const header = () => {
    d.push({ t: "rect", x: L, y: y - 6, w: R - L, h: 20, gray: 0.94 });
    text(cols.n, y, "#", 8, { bold: true });
    text(cols.desc, y, "Description", 8, { bold: true });
    text(cols.sac, y, "SAC", 8, { bold: true });
    text(cols.qty, y, "Qty", 8, { bold: true, align: "right" });
    text(cols.rate, y, "Rate", 8, { bold: true, align: "right" });
    text(cols.amount, y, "Amount", 8, { bold: true, align: "right" });
    y -= 22;
  };
  header();
  inv.lines.forEach((l, i) => {
    const desc = wrap(l.description, 9, cols.sac - cols.desc - 12);
    if (y - desc.length * 12 < 170) {
      pages.push(d);
      d = [];
      y = A4.h - 56;
      text(L, y, `${inv.number}, continued`, 9, { gray: 0.45 });
      y -= 24;
      header();
    }
    text(cols.n, y, String(i + 1), 9);
    desc.forEach((line, k) => text(cols.desc, y - k * 12, line, 9));
    text(cols.sac, y, l.sac, 9);
    text(cols.qty, y, l.qty.toLocaleString("en-IN"), 9, { align: "right" });
    text(cols.rate, y, rupees(l.unitPaise, true), 9, { align: "right" });
    text(cols.amount, y, rupees(l.amountPaise, true), 9, { align: "right" });
    y -= desc.length * 12 + 6;
  });
  rule(y + 4);
  y -= 14;

  // The totals, right-aligned under the amount column.
  const totals: [string, number, boolean][] = [[credit ? "Taxable value credited" : "Taxable value", inv.taxablePaise, false]];
  if (inv.igstPaise > 0 || (inv.cgstPaise === 0 && inv.sgstPaise === 0 && inv.buyer.state !== inv.seller.state)) {
    totals.push([`IGST at ${GST_RATE}%`, inv.igstPaise, false]);
  } else {
    totals.push([`CGST at ${GST_RATE / 2}%`, inv.cgstPaise, false]);
    totals.push([`SGST at ${GST_RATE / 2}%`, inv.sgstPaise, false]);
  }
  totals.push([credit ? "Total credited" : "Total", inv.totalPaise, true]);
  for (const [label, amount, strong] of totals) {
    text(cols.amount - 104, y, label, strong ? 11 : 9, { bold: strong, align: "right" });
    text(cols.amount, y, rupees(amount, true), strong ? 11 : 9, { bold: strong, align: "right" });
    y -= strong ? 18 : 13;
  }
  y -= 4;
  for (const line of wrap(`Amount in words: ${amountInWords(inv.totalPaise)}`, 9, R - L)) {
    text(L, y, line, 9);
    y -= 12;
  }
  y -= 8;
  if (credit && inv.reason) {
    for (const line of wrap(`Reason: ${inv.reason}`, 9, R - L)) {
      text(L, y, line, 9, { gray: 0.3 });
      y -= 12;
    }
  } else if (inv.paymentRef) {
    text(L, y, `Paid online through Razorpay, payment ${inv.paymentRef}.`, 9, { gray: 0.3 });
    y -= 12;
  } else if (inv.purpose === "PLAN" && inv.seller.bank) {
    for (const line of wrap(`Pay by bank transfer to: ${inv.seller.bank}`, 9, R - L)) {
      text(L, y, line, 9, { gray: 0.3 });
      y -= 12;
    }
  }

  // Signed for the supplier.
  const sy = Math.min(y - 30, 110);
  text(R, sy, `For ${inv.seller.name}`, 9, { bold: true, align: "right" });
  text(R, sy - 34, "Authorised signatory", 9, { gray: 0.35, align: "right" });
  d.push({ t: "line", x1: R - Math.max(120, textWidth("Authorised signatory", 9) + 20), y1: sy - 22, x2: R, y2: sy - 22, gray: 0.6, width: 0.5 });
  text(L, 48, credit ? "This is a computer-generated credit note." : "This is a computer-generated invoice.", 8, { gray: 0.5 });
  pages.push(d);
  return pdfDocument(pages, { title: `${title} ${inv.number}`, author: inv.seller.name });
}

export async function invoicePdf(orgId: string, id: string): Promise<{ number: string; bytes: Buffer } | null> {
  const inv = await getInvoice(orgId, id);
  if (!inv) return null;
  return { number: inv.number, bytes: renderInvoice(inv) };
}
