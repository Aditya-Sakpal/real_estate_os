import { A4, pdfDocument, wrap, type Draw } from "./pdf.ts";
import { CHARGE_LABEL, IN_AGREEMENT, QUOTE_DAYS, extraWords, tdsNote, type ChargeLine, type ExtraLine } from "./quote-rules.ts";

/**
 * An approved quote as a one-page A4 PDF, drawn from the quote's own row:
 * every number is the one the approver saw, never worked out again, and the
 * names are the ones recorded when it was drafted. Pure, covered by
 * `check:logic`; `quotes.ts` reads the row.
 *
 * A quote is a price, not an advertisement, so it carries no picture and no
 * impression line; it carries the registration number the gate said yes about.
 *
 * Relative imports: `check:logic` loads this from source.
 */

export type QuoteDoc = {
  id: string;
  developer: string;
  promoter: string | null;
  project: string | null;
  tower: string;
  unitNo: string;
  unitLabel: string;
  carpetSqft: number | null;
  registrationNo: string | null;
  buyer: string;
  price: number;
  extras: readonly ExtraLine[];
  /** Parking, club, the maintenance deposit and legal charges. Absent on a quote with none. */
  charges?: readonly ChargeLine[];
  gstRate: number;
  gst: number;
  dutyRate: number;
  stampDuty: number;
  registration: number;
  allIn: number;
  token: number;
  taxLabel: string;
  taxSource: string;
  taxReadOn: string | null;
  woman: string | null;
  approvedAt: string;
  cancelled: boolean;
};

/** `Rs 1,06,16,625`. */
export const inr = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;

const longDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" });

/** The day the quote stops holding: its approval plus the days a quote lasts. */
export const quoteValidUntil = (approvedIso: string) => new Date(Date.parse(approvedIso) + QUOTE_DAYS * 86_400_000).toISOString();

/** The short number a person reads off the page: the quote's first eight characters. */
export const quoteRef = (id: string) => `Q-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

/** The rows of the price table, in the order a buyer adds them up. */
export function quoteLines(q: QuoteDoc): { label: string; amount: number; strong?: boolean }[] {
  const inside = (q.charges ?? []).filter((c) => IN_AGREEMENT[c.kind]);
  const outside = (q.charges ?? []).filter((c) => !IN_AGREEMENT[c.kind]);
  const agreement = q.price + q.extras.reduce((n, e) => n + e.amount, 0) + inside.reduce((n, c) => n + c.amount, 0);
  return [
    { label: `Flat ${q.unitNo}, ${q.unitLabel}`, amount: q.price },
    ...q.extras.map((e) => ({ label: extraWords(e), amount: e.amount })),
    ...inside.map((c) => ({ label: CHARGE_LABEL[c.kind], amount: c.amount })),
    ...(q.extras.length || inside.length ? [{ label: "Agreement value", amount: agreement, strong: true }] : []),
    { label: `GST at ${q.gstRate}%`, amount: q.gst },
    { label: `Stamp duty at ${q.dutyRate}%`, amount: q.stampDuty },
    { label: "Registration fee", amount: q.registration },
    ...outside.map((c) => ({ label: `${CHARGE_LABEL[c.kind]}, outside GST and stamp duty`, amount: c.amount })),
    { label: "All in", amount: q.allIn, strong: true },
  ];
}

/** The agreement value: the flat and everything sold with it, before taxes. */
export const agreementOf = (q: QuoteDoc) =>
  q.price + q.extras.reduce((n, e) => n + e.amount, 0) + (q.charges ?? []).filter((c) => IN_AGREEMENT[c.kind]).reduce((n, c) => n + c.amount, 0);

export function renderQuote(q: QuoteDoc): Buffer {
  const L = 48;
  const R = A4.w - 48;
  const d: Draw[] = [];
  let y = A4.h - 56;
  const text = (x: number, yy: number, s: string, size = 9, o: { bold?: boolean; gray?: number; align?: "left" | "right" | "center" } = {}) =>
    d.push({ t: "text", x, y: yy, text: s, size, ...o });
  const rule = (yy: number, gray = 0.8, width = 0.5) => d.push({ t: "line", x1: L, y1: yy, x2: R, y2: yy, gray, width });

  if (q.cancelled) {
    d.push({ t: "rect", x: L, y: y - 6, w: R - L, h: 20, gray: 0.9 });
    text((L + R) / 2, y, "CANCELLED. This quote no longer holds.", 9, { bold: true, align: "center" });
    y -= 30;
  }

  // The developer, left; the quote's particulars, right.
  const top = y;
  text(L, y, q.developer, 14, { bold: true });
  y -= 16;
  if (q.promoter && q.promoter !== q.developer) {
    text(L, y, `Promoter: ${q.promoter}`, 9, { gray: 0.3 });
    y -= 12;
  }
  text(L, y, [q.project, q.tower].filter(Boolean).join(", "), 9, { gray: 0.3 });
  y -= 12;
  if (q.registrationNo) {
    text(L, y, `RERA registration: ${q.registrationNo}`, 9, { gray: 0.3 });
    y -= 12;
  }
  const leftBottom = y;

  let ry = top;
  text(R, ry, "QUOTE", 16, { bold: true, align: "right" });
  ry -= 18;
  for (const line of [
    `Quote no.: ${quoteRef(q.id)}`,
    `Approved: ${longDay(q.approvedAt)}`,
    `Valid until: ${longDay(quoteValidUntil(q.approvedAt))}`,
  ]) {
    text(R, ry, line, 9, { align: "right" });
    ry -= 12;
  }
  y = Math.min(leftBottom, ry) - 18;
  rule(y + 8);

  text(L, y - 6, "PREPARED FOR", 8, { bold: true, gray: 0.45 });
  y -= 20;
  text(L, y, q.buyer, 11, { bold: true });
  y -= 13;
  const carpet = q.carpetSqft ? `, ${Math.round(q.carpetSqft).toLocaleString("en-IN")} sq ft carpet` : "";
  text(L, y, `Flat ${q.unitNo}, ${q.unitLabel}${carpet}`, 9, { gray: 0.3 });
  y -= 26;

  // The price, line by line.
  d.push({ t: "rect", x: L, y: y - 6, w: R - L, h: 20, gray: 0.94 });
  text(L + 4, y, "Description", 8, { bold: true });
  text(R - 4, y, "Amount", 8, { bold: true, align: "right" });
  y -= 22;
  for (const l of quoteLines(q)) {
    if (l.strong) {
      rule(y + 10, 0.7);
      y -= 2;
    }
    text(L + 4, y, l.label, l.strong ? 11 : 9, { bold: l.strong });
    text(R - 4, y, inr(l.amount), l.strong ? 11 : 9, { bold: l.strong, align: "right" });
    y -= l.strong ? 20 : 15;
  }
  rule(y + 6);
  y -= 16;
  text(L + 4, y, "Token to block the flat", 10, { bold: true });
  text(R - 4, y, inr(q.token), 10, { bold: true, align: "right" });
  y -= 28;

  const notes = [
    `Stamp duty and the registration fee are for ${q.taxLabel}${q.taxReadOn ? `, as read on ${longDay(`${q.taxReadOn}T12:00:00Z`)}` : ""} (${q.taxSource}).`,
    ...(q.woman ? [`${q.woman}: applied.`] : []),
    ...(tdsNote(agreementOf(q)) ? [tdsNote(agreementOf(q))!] : []),
    "Stamp duty is charged on the agreement value or the government's reference value for the flat, whichever is higher.",
    "The flat is held only once the token is paid.",
  ];
  for (const note of notes) {
    for (const line of wrap(note, 8.5, R - L)) {
      text(L, y, line, 8.5, { gray: 0.35 });
      y -= 11;
    }
    y -= 3;
  }

  text(L, 48, `${quoteRef(q.id)}. This is a computer-generated quote.`, 8, { gray: 0.5 });
  return pdfDocument([d], { title: `Quote ${quoteRef(q.id)}`, author: q.developer });
}
