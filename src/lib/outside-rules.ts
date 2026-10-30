/**
 * A channel partner's buyers and brokerage with a developer that is not on
 * Sales Desk: the rules, with no database. `outside.ts` reads and writes.
 *
 * The partner files each such developer as an entity and says where it takes
 * registrations. A buyer registered from here is emailed to that address and
 * held to the days the developer allows. A booking owes the partner its
 * brokerage, and the partner's own GST invoice for it is numbered in its own
 * gapless series (`BRK/26-27/00001`) and drawn from the stored row.
 *
 * Relative imports: `check:logic` loads this from source.
 */
import { financialYear, isStateCode, STATE_NAMES, taxFor } from "./billing-rules.ts";
import { validateGstin } from "./gstin.ts";
import { looksLikeEmail } from "./invite-rules.ts";
import { maskPhone, spacedPhone } from "./mask-rules.ts";
import { A4, pdfDocument, wrap, type Draw } from "./pdf.ts";

/** TDS a developer deducts on brokerage (section 194H), on the amount before GST. */
export const BROKERAGE_TDS_BP = 200;
/** Real estate brokerage on a fee or commission basis, residential. */
export const BROKERAGE_SAC = "997221";
/** Warned on Today this many days before a registration runs out. */
export const ENDING_SOON_DAYS = 7;
/** An invoice unpaid this long is late. */
export const UNPAID_LATE_DAYS = 45;

// ---------------------------------------------------------------------------
// Where a developer takes registrations, and who an invoice is made out to
// ---------------------------------------------------------------------------

export type DeveloperSetup = {
  regEmail: string;
  regCc: string[];
  validityDays: number;
  rateBp: number;
  gstin: string | null;
  billAddress: string | null;
  stateCode: string | null;
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A rate typed as "2", "2.5%" or "1.75" read as basis points, or null. */
export function readRate(raw: unknown): number | null {
  const n = Number(text(raw).replace(/%$/, "").trim());
  if (!Number.isFinite(n) || n <= 0 || n > 10) return null;
  return Math.round(n * 100);
}

/** `2%`, `2.25%`. */
export const showRate = (bp: number) => `${+(bp / 100).toFixed(2)}%`;

/** The setup form, read and checked, every problem named in the screen's words. */
export function readSetup(raw: Record<string, unknown>): { ok: true; setup: DeveloperSetup } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const regEmail = text(raw.regEmail).toLowerCase();
  if (!looksLikeEmail(regEmail)) errors.regEmail = "Enter the email address the developer takes registrations on.";
  const regCc = text(raw.regCc)
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (regCc.length > 3) errors.regCc = "Three addresses at most.";
  else if (regCc.some((c) => !looksLikeEmail(c))) errors.regCc = "One of these is not an email address.";
  const days = Number(text(raw.validityDays) || "30");
  if (!Number.isInteger(days) || days < 7 || days > 365) errors.validityDays = "Between 7 and 365 days.";
  const rateBp = readRate(raw.rate);
  if (rateBp === null) errors.rate = "A rate between 0.01% and 10%.";
  let gstin: string | null = null;
  if (text(raw.gstin)) {
    const g = validateGstin(text(raw.gstin));
    if (g.ok) gstin = g.gstin;
    else errors.gstin = g.error;
  }
  const billAddress = text(raw.billAddress).replace(/\s+/g, " ") || null;
  if (billAddress && billAddress.length > 300) errors.billAddress = "300 characters at most.";
  let stateCode = text(raw.stateCode) || (gstin ? gstin.slice(0, 2) : "");
  if (stateCode && !isStateCode(stateCode)) errors.stateCode = "Choose the state.";
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) errors.stateCode = `The GSTIN is registered in ${STATE_NAMES[gstin.slice(0, 2)] ?? "another state"}.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    setup: { regEmail, regCc: [...new Set(regCc)], validityDays: days, rateBp: rateBp!, gstin, billAddress, stateCode: stateCode || null },
  };
}

// ---------------------------------------------------------------------------
// A registration
// ---------------------------------------------------------------------------

/** The last day a registration holds: the day it was sent plus the developer's days. */
export function registrationEnds(sentOn: string, days: number): string {
  const d = new Date(`${sentOn.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const longDay = (day: string) =>
  new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

/** The email a developer receives: the buyer, the project, and who registers them. */
export function registrationEmail(o: {
  developer: string;
  project: string;
  buyer: string;
  phone: string;
  partner: string;
  partnerLegal: string | null;
  agentNo: string | null;
  sender: { name: string | null; email: string | null; phone: string | null };
  sentOn: string;
}): { subject: string; text: string } {
  const contact = [o.sender.name, o.sender.email, o.sender.phone ? spacedPhone(o.sender.phone) : null].filter(Boolean).join(", ");
  const lines = [
    `Dear ${o.developer} team,`,
    "",
    `${o.partner} registers the following client for ${o.project}:`,
    "",
    `Client: ${o.buyer}`,
    `Mobile: ${spacedPhone(o.phone)}`,
    `Registered on: ${longDay(o.sentOn)}`,
    "",
    `Channel partner: ${o.partner}${o.partnerLegal && o.partnerLegal !== o.partner ? ` (${o.partnerLegal})` : ""}`,
    ...(o.agentNo ? [`MahaRERA agent registration: ${o.agentNo}`] : []),
    ...(contact ? [`Contact: ${contact}`] : []),
    "",
    "Please confirm the registration by replying to this email.",
    "",
    `Sent through Sales Desk for ${o.partner}.`,
  ];
  return { subject: `Client registration: ${o.buyer}, ${o.project} (${o.partner})`, text: lines.join("\n") };
}

export type OutsideState = "sent" | "confirmed" | "ending" | "lapsed" | "refused" | "withdrawn" | "booked" | "erased";

/** Where a registration stands today, in the partner's words. */
export function outsideState(r: { status: string; validUntil: string; booked: boolean; phone: string | null }, today: string): OutsideState {
  if (r.phone === null) return "erased";
  if (r.booked) return "booked";
  if (r.status === "REFUSED") return "refused";
  if (r.status === "WITHDRAWN") return "withdrawn";
  if (r.validUntil < today) return "lapsed";
  const left = Math.round((Date.parse(`${r.validUntil}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (left <= ENDING_SOON_DAYS) return "ending";
  return r.status === "CONFIRMED" ? "confirmed" : "sent";
}

export const OUTSIDE_WORDS: Record<OutsideState, { label: string; tone: "ok" | "blue" | "warn" | "risk" | "quiet" }> = {
  sent: { label: "Sent", tone: "blue" },
  confirmed: { label: "Confirmed", tone: "ok" },
  ending: { label: "Ending soon", tone: "warn" },
  lapsed: { label: "Ran out", tone: "quiet" },
  refused: { label: "Refused", tone: "risk" },
  withdrawn: { label: "Withdrawn", tone: "quiet" },
  booked: { label: "Booked", tone: "ok" },
  erased: { label: "Erased", tone: "quiet" },
};

export const shownPhone = (phone: string | null) => (phone ? maskPhone(phone) : "");

// ---------------------------------------------------------------------------
// A booking, and the invoice for it
// ---------------------------------------------------------------------------

/** The brokerage on an agreement value at a rate, to the paisa. */
export const brokerageOf = (agreementPaise: number, rateBp: number) => Math.round((agreementPaise * rateBp) / 10_000);

/** Rupees typed as "1,25,00,000", "1.25 Cr" or "76.4 lakh", in paise, or null. */
export function readRupees(raw: unknown): number | null {
  const s = text(raw).toLowerCase().replace(/rs\.?|₹|inr/g, "").replace(/,/g, "").trim();
  const m = /^(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lakh|lakhs|lac)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2]?.startsWith("c") ? 1e7 : m[2] ? 1e5 : 1);
  if (!Number.isFinite(n) || n <= 0 || n > 1e10) return null;
  return Math.round(n * 100);
}

/** `BRK/26-27/00001`: sixteen characters at most, gapless per financial year. */
export function outsideInvoiceNumber(fy: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 99_999) throw new Error(`invoice sequence out of range: ${seq}`);
  return `BRK/${fy}/${String(seq).padStart(5, "0")}`;
}

export const invoiceYear = financialYear;

export type InvoiceParty = { name: string; gstin: string | null; address: string | null; state: string | null };

/**
 * What the invoice charges. A partner registered for GST charges it at 18%,
 * split inside one state and IGST across two; one that is not registered
 * charges none. TDS is what the developer will deduct, shown, never added.
 */
export function invoiceAmounts(o: { taxablePaise: number; seller: InvoiceParty; buyerState: string | null }): {
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  tds: number;
  placeOfSupply: string;
  taxed: boolean;
} {
  const tds = Math.round((o.taxablePaise * BROKERAGE_TDS_BP) / 10_000);
  const place = o.buyerState ?? o.seller.state ?? "";
  if (!o.seller.gstin || !o.seller.state) return { cgst: 0, sgst: 0, igst: 0, total: o.taxablePaise, tds, placeOfSupply: place, taxed: false };
  const t = taxFor(o.taxablePaise, o.seller.state, place || o.seller.state);
  return { cgst: t.cgst, sgst: t.sgst, igst: t.igst, total: t.total, tds, placeOfSupply: place || o.seller.state, taxed: true };
}

/** Why an invoice cannot be made yet, or null. */
export function invoiceRefusal(o: { seller: InvoiceParty; buyer: InvoiceParty; status: string; invoiced: boolean }): string | null {
  if (o.invoiced) return "This booking already has an invoice.";
  if (o.status !== "OWED") return "This booking was cancelled.";
  if (!o.seller.address || !o.seller.state) return "Add your billing address and state in Settings, Plan and usage, then make the invoice.";
  if (!o.buyer.address || !o.buyer.state) return "Add the developer's billing address and state first.";
  return null;
}

/** The line an invoice carries, naming the booking and never the buyer. */
export function invoiceDescription(o: { project: string; unit: string | null; bookedOn: string; agreementPaise: number; rateBp: number }): string {
  return `Brokerage at ${showRate(o.rateBp)} on the booking of ${o.unit ? `unit ${o.unit}, ` : ""}${o.project}, booked ${longDay(o.bookedOn)}, agreement value ${inr(o.agreementPaise)}`.slice(0, 300);
}

/** `Rs 1,25,000.50` from paise. */
export const inr = (paise: number) => {
  const r = paise / 100;
  return `Rs ${r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
};

export type OutsideInvoiceDoc = {
  number: string;
  issuedOn: string;
  seller: InvoiceParty & { agentNo?: string | null };
  buyer: InvoiceParty;
  placeOfSupply: string;
  description: string;
  sac: string;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  tds: number;
};

/** The partner's brokerage invoice, one A4 page, drawn from the stored row. */
export function renderOutsideInvoice(v: OutsideInvoiceDoc): Buffer {
  const L = 48;
  const R = A4.w - 48;
  const d: Draw[] = [];
  let y = A4.h - 56;
  const t = (x: number, yy: number, s: string, size = 9, o: { bold?: boolean; gray?: number; align?: "left" | "right" | "center" } = {}) =>
    d.push({ t: "text", x, y: yy, text: s, size, ...o });
  const rule = (yy: number, gray = 0.8, width = 0.5) => d.push({ t: "line", x1: L, y1: yy, x2: R, y2: yy, gray, width });
  const taxed = v.cgst + v.sgst + v.igst > 0;

  // The partner, left; the invoice's particulars, right.
  const top = y;
  t(L, y, v.seller.name, 14, { bold: true });
  y -= 15;
  for (const line of [
    ...(v.seller.address ? wrap(v.seller.address, 9, 280) : []),
    v.seller.state ? `${STATE_NAMES[v.seller.state] ?? ""} (${v.seller.state})` : null,
    v.seller.gstin ? `GSTIN ${v.seller.gstin}` : null,
    v.seller.agentNo ? `MahaRERA agent registration ${v.seller.agentNo}` : null,
  ].filter((l): l is string => !!l)) {
    t(L, y, line, 9, { gray: 0.3 });
    y -= 12;
  }
  const leftBottom = y;
  let ry = top;
  t(R, ry, taxed ? "TAX INVOICE" : "INVOICE", 16, { bold: true, align: "right" });
  ry -= 18;
  for (const line of [`Invoice no.: ${v.number}`, `Date: ${longDay(v.issuedOn)}`, `Place of supply: ${STATE_NAMES[v.placeOfSupply] ?? v.placeOfSupply} (${v.placeOfSupply})`]) {
    t(R, ry, line, 9, { align: "right" });
    ry -= 12;
  }
  y = Math.min(leftBottom, ry) - 16;
  rule(y + 8);

  t(L, y - 6, "BILLED TO", 8, { bold: true, gray: 0.45 });
  y -= 20;
  t(L, y, v.buyer.name, 11, { bold: true });
  y -= 13;
  for (const line of [
    ...(v.buyer.address ? wrap(v.buyer.address, 9, R - L) : []),
    v.buyer.state ? `${STATE_NAMES[v.buyer.state] ?? ""} (${v.buyer.state})` : null,
    v.buyer.gstin ? `GSTIN ${v.buyer.gstin}` : null,
  ].filter((l): l is string => !!l)) {
    t(L, y, line, 9, { gray: 0.3 });
    y -= 12;
  }
  y -= 14;

  d.push({ t: "rect", x: L, y: y - 6, w: R - L, h: 20, gray: 0.94 });
  t(L + 4, y, "Description", 8, { bold: true });
  t(R - 110, y, "SAC", 8, { bold: true });
  t(R - 4, y, "Amount", 8, { bold: true, align: "right" });
  y -= 20;
  const desc = wrap(v.description, 9, R - L - 140);
  t(R - 110, y, v.sac, 9);
  t(R - 4, y, inr(v.taxable), 9, { align: "right" });
  for (const line of desc) {
    t(L + 4, y, line, 9);
    y -= 12;
  }
  y -= 6;
  rule(y + 6);
  y -= 10;
  const sums: [string, number, boolean?][] = [
    ["Taxable value", v.taxable],
    ...(v.cgst ? ([["CGST at 9%", v.cgst]] as [string, number][]) : []),
    ...(v.sgst ? ([["SGST at 9%", v.sgst]] as [string, number][]) : []),
    ...(v.igst ? ([["IGST at 18%", v.igst]] as [string, number][]) : []),
    ["Total", v.total, true],
  ];
  for (const [label, amount, strong] of sums) {
    t(R - 180, y, label, strong ? 11 : 9, { bold: strong });
    t(R - 4, y, inr(amount), strong ? 11 : 9, { bold: strong, align: "right" });
    y -= strong ? 20 : 14;
  }
  y -= 10;
  const notes = [
    `TDS under section 194H at ${showRate(BROKERAGE_TDS_BP)} on the taxable value: ${inr(v.tds)}. Amount payable after TDS: ${inr(v.total - v.tds)}.`,
    ...(taxed ? [] : ["Not registered under GST: no GST is charged."]),
  ];
  for (const n of notes) {
    for (const line of wrap(n, 8.5, R - L)) {
      t(L, y, line, 8.5, { gray: 0.35 });
      y -= 11;
    }
    y -= 3;
  }
  t(L, 48, `${v.number}. This is a computer-generated invoice.`, 8, { gray: 0.5 });
  return pdfDocument([d], { title: `Invoice ${v.number}`, author: v.seller.name });
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

/** Whole days from one IST day to another. */
export const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
