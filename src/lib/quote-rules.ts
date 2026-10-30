/**
 * A buyer's quote, the flat it blocks, and the token link that pays for it:
 * the state machine, the clocks, the fingerprint and the gateway's words.
 * Pure and database-free, covered by `check:logic`; `quotes.ts` and
 * `payments.ts` read, write and call.
 *
 * Section 02's rules:
 *
 * - **The engine drafts, a person approves.** Every number is computed from
 *   approved facts; a person holding `quote:approve` approves it, and only an
 *   approved quote blocks a flat or asks for money.
 * - **Together or not at all.** A quote is sent with its block and its link,
 *   or with none of them.
 * - **The money never touches us.** A token is paid into the developer's own
 *   Razorpay account through the link their own account made.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type QuoteState = "DRAFT" | "APPROVED" | "SENT" | "SUPERSEDED" | "EXPIRED" | "CANCELLED";

const MOVES: Record<QuoteState, readonly QuoteState[]> = {
  DRAFT: ["APPROVED", "SUPERSEDED", "EXPIRED"],
  APPROVED: ["SENT", "SUPERSEDED", "EXPIRED"],
  // CANCELLED: the token was paid and then given back.
  SENT: ["SUPERSEDED", "EXPIRED", "CANCELLED"],
  SUPERSEDED: [],
  EXPIRED: [],
  CANCELLED: [],
};

/** A quote moves forward only. */
export const canMoveQuote = (from: QuoteState, to: QuoteState) => MOVES[from].includes(to);

/** A draft or an approval this old is quoted again rather than sent. */
export const QUOTE_DAYS = 7;
/** A flat is held this long for the token. */
export const BLOCK_HOURS = 48;
/** Once the token is paid, this long for the agreement. */
export const PAID_BLOCK_DAYS = 7;
/** A reservation with no link after this long is void. */
export const RESERVE_MINUTES = 2;

export const blockExpiry = (fromIso: string) => new Date(Date.parse(fromIso) + BLOCK_HOURS * 3_600_000).toISOString();
export const paidExpiry = (paidIso: string) => new Date(Date.parse(paidIso) + PAID_BLOCK_DAYS * 86_400_000).toISOString();

/** Whether a block still holds its flat at `nowIso`. Expiry is read, not waited for. */
export function blockLive(b: { state: string; expiresAt: string }, nowIso: string): boolean {
  return (b.state === "PENDING_TOKEN" || b.state === "TOKEN_PAID") && Date.parse(b.expiresAt) > Date.parse(nowIso);
}

export type QuoteInputs = {
  leadId: string;
  phaseId: string;
  unitTypeId: string;
  unitNo: string;
  brainVersions: string[];
  unitHash: string;
  price: number;
  gst: number;
  stampDuty: number;
  registration: number;
  allIn: number;
  token: number;
  /** Floor rise and PLC, as approved with the quote. Absent or empty on a quote with none. */
  extras?: readonly ExtraLine[];
  /** The concession for a woman buying alone was applied. */
  woman?: boolean;
  /** Parking, club, the maintenance deposit and legal charges. Absent or empty on a quote with none. */
  charges?: readonly ChargeLine[];
};

/**
 * The fingerprint of what a quote says and what it was worked out from. An
 * approval is refused when the quote worked out again today has another.
 */
export function quoteHash(q: QuoteInputs): string {
  const canonical = JSON.stringify([
    q.leadId, q.phaseId, q.unitTypeId, q.unitNo.trim().toUpperCase(), [...q.brainVersions].sort(), q.unitHash,
    q.price, q.gst, q.stampDuty, q.registration, q.allIn, q.token,
    // Added later: a quote with neither hashes exactly as it did before.
    ...(q.extras?.length ? [q.extras.map((e) => [e.kind, e.basis, e.rate, e.amount])] : []),
    ...(q.woman ? ["WOMAN"] : []),
    // Added later again, and the same way: a quote with none hashes as before.
    ...(q.charges?.length ? [["CHARGES", ...q.charges.map((c) => [c.kind, c.amount])]] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** A flat's number as the tower writes it: trimmed, capitals, no double spaces. */
export function unitNoOf(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return /^[A-Z0-9][A-Z0-9 /-]{0,19}$/.test(s) ? s : null;
}

/** The token asked for: the signed booking amount, never more than the price. */
export function tokenProblem(token: number | null, price: number): string | null {
  if (token === null || !(token > 0)) return "No booking amount is signed for this tower.";
  if (token > price) return "The signed booking amount is more than the flat's price.";
  if (token > 1_00_00_000) return "A token over Rs 1 Cr is paid another way.";
  return null;
}

// ---------------------------------------------------------------------------
// The gateway's words
// ---------------------------------------------------------------------------

/** The reference a link carries: the quote, in Razorpay's 40 characters. */
export const linkReference = (quoteId: string) => `q${quoteId.replace(/-/g, "").toLowerCase()}`;

export function quoteFromReference(ref: string | null | undefined): string | null {
  const m = /^q([0-9a-f]{32})(?:n[2-9])?$/.exec((ref ?? "").trim());
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Razorpay proves a webhook with an HMAC of the raw body under the webhook secret. */
export function webhookValid(raw: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(signature.trim());
  return got.length === want.length && timingSafeEqual(got, want);
}

export type LinkEvent = {
  event: "PAID" | "EXPIRED" | "CANCELLED";
  accountId: string | null;
  linkId: string;
  reference: string | null;
  paymentId: string | null;
  amountPaise: number | null;
  paidAt: string | null;
};

export type RefundEvent = {
  event: "PROCESSED" | "FAILED";
  accountId: string | null;
  refundId: string;
  paymentId: string | null;
  receipt: string | null;
  amountPaise: number | null;
};

/**
 * A `refund.processed` or `refund.failed` webhook from the developer's own
 * account, read; null for any other event, or a refund entity that names no
 * refund id of Razorpay's shape.
 */
export function readRefundEvent(body: unknown): RefundEvent | null {
  const b = (body ?? {}) as { event?: string; account_id?: string; payload?: Record<string, { entity?: Record<string, unknown> }> };
  const kind = ({ "refund.processed": "PROCESSED", "refund.failed": "FAILED" } as const)[b.event as "refund.processed" | "refund.failed"];
  const r = b.payload?.refund?.entity;
  if (!kind || !r || typeof r.id !== "string" || !/^rfnd_[A-Za-z0-9]{6,30}$/.test(r.id)) return null;
  return {
    event: kind,
    accountId: typeof b.account_id === "string" ? b.account_id : null,
    refundId: r.id,
    paymentId: typeof r.payment_id === "string" ? r.payment_id : null,
    receipt: typeof r.receipt === "string" ? r.receipt : null,
    amountPaise: typeof r.amount === "number" ? r.amount : null,
  };
}

/**
 * What a refund webhook does to our row: the row names the refund, or it
 * is the one asked under that payment and receipt; the amount must be the
 * one asked. A processed refund is final, a failure moves only a refund
 * still waiting, and anything that does not match changes nothing.
 */
export function refundEventMove(
  row: { state: RefundState; providerRefundId: string | null; providerPaymentId: string | null; receipt: string; amountPaise: number },
  ev: RefundEvent,
): { to: "PROCESSED" | "FAILED"; setId: boolean } | null {
  const named = row.providerRefundId !== null && row.providerRefundId === ev.refundId;
  const asked = row.providerRefundId === null && ev.paymentId !== null && ev.paymentId === row.providerPaymentId && ev.receipt === row.receipt;
  if (!named && !asked) return null;
  if (ev.amountPaise !== null && ev.amountPaise !== row.amountPaise) return null;
  if (row.state === "PROCESSED") return null;
  if (ev.event === "PROCESSED") return { to: "PROCESSED", setId: !named };
  return row.state === "REQUESTED" ? { to: "FAILED", setId: !named } : null;
}

/** A `payment_link.*` webhook, read; null for any other event. */
export function readLinkEvent(body: unknown): LinkEvent | null {
  const b = (body ?? {}) as { event?: string; account_id?: string; payload?: Record<string, { entity?: Record<string, unknown> }> };
  const kind = { "payment_link.paid": "PAID", "payment_link.expired": "EXPIRED", "payment_link.cancelled": "CANCELLED" }[b.event ?? ""] as LinkEvent["event"] | undefined;
  const link = b.payload?.payment_link?.entity;
  if (!kind || !link || typeof link.id !== "string") return null;
  const pay = b.payload?.payment?.entity;
  const paidSecs = typeof pay?.created_at === "number" ? pay.created_at : null;
  return {
    event: kind,
    accountId: typeof b.account_id === "string" ? b.account_id : null,
    linkId: link.id,
    reference: typeof link.reference_id === "string" ? link.reference_id : null,
    paymentId: typeof pay?.id === "string" ? pay.id : null,
    amountPaise: typeof link.amount_paid === "number" ? link.amount_paid : typeof link.amount === "number" ? link.amount : null,
    paidAt: paidSecs ? new Date(paidSecs * 1000).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Connecting the developer's own account
// ---------------------------------------------------------------------------

export type PayState = { o: string; u: string; n: string; e: number };

/** The `state` Razorpay carries back, signed, bound to a person, an org and this browser. */
export function signPayState(p: PayState, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function readPayState(raw: string | null | undefined, key: Buffer, expect: { nonce: string | null | undefined; userId: string; now: Date }): PayState | null {
  const [body, mac, extra] = (raw ?? "").split(".");
  if (!body || !mac || extra !== undefined) return null;
  const want = createHmac("sha256", key).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p: PayState;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PayState;
  } catch {
    return null;
  }
  if (!p.o || !p.u || !p.n || !(p.e * 1000 > expect.now.getTime())) return null;
  if (p.n !== (expect.nonce ?? "") || p.u !== expect.userId) return null;
  return p;
}

// ---------------------------------------------------------------------------
// Floor rise and PLC: lines a person types on the draft
// ---------------------------------------------------------------------------

export type ExtraKind = "FLOOR_RISE" | "PLC";
export type ExtraBasis = "PSF" | "LUMP";
export type ExtraSpec = { kind: ExtraKind; basis: ExtraBasis; rate: number };
export type ExtraLine = ExtraSpec & { amount: number };

export const EXTRA_LABEL: Record<ExtraKind, string> = { FLOOR_RISE: "Floor rise", PLC: "Preferential location charge" };
/** A per sq ft charge above this is a typing mistake, not a charge. */
export const MAX_EXTRA_PSF = 10_000;

/** "Floor rise, Rs 150 a sq ft of carpet" or "Preferential location charge, lump sum". */
export function extraWords(e: ExtraSpec): string {
  return e.basis === "PSF"
    ? `${EXTRA_LABEL[e.kind]}, Rs ${e.rate.toLocaleString("en-IN")} a sq ft of carpet`
    : `${EXTRA_LABEL[e.kind]}, lump sum`;
}

/**
 * Read the draft form's two optional lines. A blank amount is no line; a
 * number that is not a whole number of rupees is refused, never rounded.
 */
export function readExtras(f: { floorRise?: string | null; floorRiseBasis?: string | null; plc?: string | null; plcBasis?: string | null }):
  { ok: true; specs: ExtraSpec[] } | { ok: false; why: string } {
  const specs: ExtraSpec[] = [];
  const rows = [["FLOOR_RISE", f.floorRise, f.floorRiseBasis], ["PLC", f.plc, f.plcBasis]] as const;
  for (const [kind, raw, basis] of rows) {
    const t = (raw ?? "").replace(/[,\s]/g, "").replace(/^rs\.?/i, "");
    if (!t) continue;
    if (!/^\d{1,9}$/.test(t) || Number(t) <= 0) return { ok: false, why: `${EXTRA_LABEL[kind]}: enter a whole number of rupees.` };
    if (basis !== "PSF" && basis !== "LUMP") return { ok: false, why: `${EXTRA_LABEL[kind]}: choose per sq ft or lump sum.` };
    specs.push({ kind, basis, rate: Number(t) });
  }
  return { ok: true, specs };
}

/** Work the lines out on the flat: a per sq ft rate on its carpet area, a lump sum as typed. */
export function extraLines(specs: readonly ExtraSpec[], carpetSqft: number, price: number):
  { ok: true; lines: ExtraLine[]; total: number } | { ok: false; why: string } {
  const lines: ExtraLine[] = [];
  const kinds = new Set<string>();
  for (const s of specs) {
    if (s.kind !== "FLOOR_RISE" && s.kind !== "PLC") return { ok: false, why: "Only floor rise and PLC may be added." };
    if (kinds.has(s.kind)) return { ok: false, why: `${EXTRA_LABEL[s.kind]} is entered twice.` };
    kinds.add(s.kind);
    if (s.basis !== "PSF" && s.basis !== "LUMP") return { ok: false, why: `${EXTRA_LABEL[s.kind]}: choose per sq ft or lump sum.` };
    if (!Number.isInteger(s.rate) || s.rate <= 0) return { ok: false, why: `${EXTRA_LABEL[s.kind]}: enter a whole number of rupees.` };
    if (s.basis === "PSF" && s.rate > MAX_EXTRA_PSF) {
      return { ok: false, why: `${EXTRA_LABEL[s.kind]} over Rs ${MAX_EXTRA_PSF.toLocaleString("en-IN")} a sq ft is not a rate.` };
    }
    if (s.basis === "PSF" && !(carpetSqft > 0)) return { ok: false, why: "This configuration has no approved carpet area to charge a rate on." };
    lines.push({ kind: s.kind, basis: s.basis, rate: s.rate, amount: s.basis === "PSF" ? Math.round(s.rate * carpetSqft) : s.rate });
  }
  // Floor rise first, then PLC, however they were typed.
  lines.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "FLOOR_RISE" ? -1 : 1));
  const total = lines.reduce((n, l) => n + l.amount, 0);
  if (total > price) return { ok: false, why: "Floor rise and PLC together are more than the flat's price." };
  return { ok: true, lines, total };
}

// ---------------------------------------------------------------------------
// A token paid by cheque or bank transfer
// ---------------------------------------------------------------------------

export type OfflineMode = "CHEQUE" | "TRANSFER";
export const OFFLINE_MODES: Record<OfflineMode, string> = { CHEQUE: "Cheque", TRANSFER: "Bank transfer" };
/** A token recorded longer than this after it was paid is refused. */
export const OFFLINE_BACKDATE_DAYS = 30;

/** A cheque's six digits, or a transfer's UTR (IMPS 12, NEFT 16, RTGS 22). Spaces and case do not matter. */
export function offlineReference(mode: string, raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (mode === "CHEQUE") return /^\d{6}$/.test(s) ? s : null;
  if (mode === "TRANSFER") return /^[A-Z0-9]{12,22}$/.test(s) ? s : null;
  return null;
}

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/**
 * Why a token recorded by hand is refused, or null. The amount must be the
 * quote's token to the rupee: a different amount is a different booking.
 */
export function offlineTokenProblem(o: {
  mode: string;
  reference: string | null | undefined;
  amount: number;
  token: number;
  paidOn: string;
  today: string;
  /** Already paid on this quote, in rupees, and in how many parts. */
  paid?: number;
  parts?: number;
  /** The person said this is part of the token, not all of what is left. */
  part?: boolean;
}): string | null {
  if (o.mode !== "CHEQUE" && o.mode !== "TRANSFER") return "Choose cheque or bank transfer.";
  if (!offlineReference(o.mode, o.reference)) {
    return o.mode === "CHEQUE" ? "Enter the cheque's 6-digit number." : "Enter the transfer's UTR, 12 to 22 letters and digits.";
  }
  const bad = partProblem({ amount: o.amount, token: o.token, paid: o.paid ?? 0, parts: o.parts ?? 0, whole: !o.part });
  if (bad) return bad;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.paidOn) || Number.isNaN(dayMs(o.paidOn))) return "Enter the day it was paid.";
  if (o.paidOn > o.today) return "The day it was paid cannot be after today.";
  if (dayMs(o.today) - dayMs(o.paidOn) > OFFLINE_BACKDATE_DAYS * 86_400_000) {
    return `A token paid more than ${OFFLINE_BACKDATE_DAYS} days ago is not recorded here.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cancelling a paid token, and its refund
// ---------------------------------------------------------------------------

export type RefundMode = "RAZORPAY" | "CHEQUE" | "TRANSFER";
export type RefundState = "DUE" | "REQUESTED" | "PROCESSED" | "FAILED";
/** Asked of the gateway at most this many times, then a person is told. */
export const REFUND_ATTEMPTS = 5;

/** The refund's receipt at the gateway: the quote, so a retry finds the refund it already made. */
export const refundReceipt = (quoteId: string) => `r${quoteId.replace(/-/g, "").toLowerCase()}`;

/** A refund is never larger than what was paid. Zero means nothing is given back. */
export function refundProblem(amount: number, paid: number): string | null {
  if (!Number.isInteger(amount) || amount < 0) return "Enter the refund in whole rupees.";
  if (amount > paid) return `A refund cannot be more than the Rs ${paid.toLocaleString("en-IN")} paid.`;
  return null;
}

/** The gateway's refund status, in ours. */
export function refundStateOf(status: string | null | undefined): RefundState {
  return status === "processed" ? "PROCESSED" : status === "failed" ? "FAILED" : "REQUESTED";
}

// ---------------------------------------------------------------------------
// Parking, club, the maintenance deposit and legal charges
// ---------------------------------------------------------------------------

export type ChargeKind = "PARKING" | "CLUB" | "MAINTENANCE_DEPOSIT" | "LEGAL";
export type ChargeLine = { kind: ChargeKind; amount: number };

export const CHARGE_KINDS: readonly ChargeKind[] = ["PARKING", "CLUB", "MAINTENANCE_DEPOSIT", "LEGAL"];
export const CHARGE_LABEL: Record<ChargeKind, string> = {
  PARKING: "Car parking",
  CLUB: "Club membership",
  MAINTENANCE_DEPOSIT: "Maintenance deposit",
  LEGAL: "Legal charges",
};

/**
 * Kept simple on purpose. Parking and club are sold with the flat: they are
 * in the agreement value, so GST at the flat's rate and stamp duty fall on
 * them. The maintenance deposit is held for the society and legal charges
 * pay for the paperwork: both are outside the agreement value, outside GST
 * and outside stamp duty, and only added to the all-in total.
 */
export const IN_AGREEMENT: Record<ChargeKind, boolean> = { PARKING: true, CLUB: true, MAINTENANCE_DEPOSIT: false, LEGAL: false };

/** Read the draft form's four optional amounts. A blank is no line; anything but whole rupees is refused. */
export function readCharges(f: Partial<Record<"parking" | "club" | "maintenance" | "legal", string | null>>):
  { ok: true; lines: ChargeLine[] } | { ok: false; why: string } {
  const rows: [ChargeKind, string | null | undefined][] = [
    ["PARKING", f.parking], ["CLUB", f.club], ["MAINTENANCE_DEPOSIT", f.maintenance], ["LEGAL", f.legal],
  ];
  const lines: ChargeLine[] = [];
  for (const [kind, raw] of rows) {
    const t = (raw ?? "").replace(/[,\s]/g, "").replace(/^rs\.?/i, "");
    if (!t) continue;
    if (!/^\d{1,9}$/.test(t) || Number(t) <= 0) return { ok: false, why: `${CHARGE_LABEL[kind]}: enter a whole number of rupees.` };
    lines.push({ kind, amount: Number(t) });
  }
  return { ok: true, lines };
}

/** The charges in the order a buyer reads them, split into what joins the agreement value and what does not. */
export function chargeTotals(lines: readonly ChargeLine[], price: number):
  { ok: true; lines: ChargeLine[]; inAgreement: number; outside: number } | { ok: false; why: string } {
  const seen = new Set<string>();
  for (const c of lines) {
    if (!CHARGE_KINDS.includes(c.kind)) return { ok: false, why: "Only parking, club, the maintenance deposit and legal charges may be added." };
    if (seen.has(c.kind)) return { ok: false, why: `${CHARGE_LABEL[c.kind]} is entered twice.` };
    seen.add(c.kind);
    if (!Number.isInteger(c.amount) || c.amount <= 0) return { ok: false, why: `${CHARGE_LABEL[c.kind]}: enter a whole number of rupees.` };
  }
  const sorted = [...lines].sort((a, b) => CHARGE_KINDS.indexOf(a.kind) - CHARGE_KINDS.indexOf(b.kind));
  const inAgreement = sorted.filter((c) => IN_AGREEMENT[c.kind]).reduce((n, c) => n + c.amount, 0);
  const outside = sorted.filter((c) => !IN_AGREEMENT[c.kind]).reduce((n, c) => n + c.amount, 0);
  if (inAgreement + outside > price) return { ok: false, why: "The other charges together are more than the flat's price." };
  return { ok: true, lines: sorted, inAgreement, outside };
}

// ---------------------------------------------------------------------------
// TDS under section 194-IA: information, never a deduction we compute
// ---------------------------------------------------------------------------

/** Section 194-IA applies to a property bought for this much or more. */
export const TDS_194IA_FROM = 50_00_000;

/** The line a quote and its PDF carry when the agreement value is Rs 50 lakh or more. */
export function tdsNote(agreement: number): string | null {
  return agreement >= TDS_194IA_FROM
    ? "The buyer deducts TDS of 1% under section 194-IA from each payment to the developer and deposits it with the government."
    : null;
}

// ---------------------------------------------------------------------------
// A token paid in parts
// ---------------------------------------------------------------------------

/** A token may be paid in this many parts at most, by link, cheque or transfer, mixed. */
export const MAX_TOKEN_PARTS = 3;
/** Once a part is paid, the flat is held this long for the rest. */
export const PART_HOLD_DAYS = 7;
/** Links one quote may make, paid or not: a link that expires unpaid can be sent again, within reason. */
export const MAX_TOKEN_LINKS = 9;

export const partExpiry = (paidIso: string) => new Date(Date.parse(paidIso) + PART_HOLD_DAYS * 86_400_000).toISOString();

/** The reference of a quote's nth link: the quote's own for the first, then "n2" to "n9". */
export function partReference(quoteId: string, n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_TOKEN_LINKS) throw new Error("A quote makes nine links at most");
  return n === 1 ? linkReference(quoteId) : `${linkReference(quoteId)}n${n}`;
}

/** The refund receipt for a part paid on a link: its reference with an r, so the first link's is the quote's own receipt. */
export const linkRefundReceipt = (reference: string) => `r${reference.slice(1)}`;
/** The receipt for the kth part paid by cheque or transfer. Never sent to a gateway; it keeps rows apart. */
export const offlineRefundReceipt = (quoteId: string, k: number) => `${refundReceipt(quoteId)}o${Math.max(1, Math.min(9, k))}`;

/**
 * Why a part of the token is refused, or null. `whole` asks for exactly what
 * is left. The last of three parts must pay what is left, so a token never
 * ends a part short.
 */
export function partProblem(o: { amount: number; token: number; paid: number; parts: number; whole: boolean }): string | null {
  const left = o.token - o.paid;
  const rs = (n: number) => `Rs ${n.toLocaleString("en-IN")}`;
  if (left <= 0) return "This token is already paid.";
  if (o.parts >= MAX_TOKEN_PARTS) return `This token has had its ${MAX_TOKEN_PARTS} parts. Nothing more can be paid on it.`;
  if (!Number.isInteger(o.amount) || o.amount <= 0) return "Enter the amount paid in whole rupees.";
  if (o.amount > left) {
    return o.paid > 0 ? `Only ${rs(left)} of the token is still to come.` : `The amount is more than this quote's token of ${rs(o.token)}.`;
  }
  if (o.whole && o.amount !== left) {
    return o.paid > 0 ? `The rest of the token is ${rs(left)}.` : `The amount is not this quote's token of ${rs(o.token)}.`;
  }
  if (o.parts === MAX_TOKEN_PARTS - 1 && o.amount !== left) return `A third part must pay the rest of the token, ${rs(left)}.`;
  return null;
}

/** A part already paid on a quote. */
export type TokenPart = { id: string; by: "RAZORPAY" | OfflineMode; amount: number; paymentId: string | null; reference: string };

/**
 * Split a refund across the parts paid: parts paid on a link first, in the
 * order given, because Razorpay gives those back by itself; then cheques and
 * transfers. A part is never given back more than it paid.
 */
export function allocateRefund(parts: readonly TokenPart[], refund: number): { id: string; amount: number }[] {
  const order = [...parts.filter((p) => p.by === "RAZORPAY"), ...parts.filter((p) => p.by !== "RAZORPAY")];
  const out: { id: string; amount: number }[] = [];
  let left = Math.max(0, Math.floor(refund));
  for (const p of order) {
    if (left <= 0) break;
    const take = Math.min(left, p.amount);
    if (take > 0) out.push({ id: p.id, amount: take });
    left -= take;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Is the flat still the buyer's to pay for?
// ---------------------------------------------------------------------------

/**
 * Asked before a link is sent and when a payment arrives. The flat must
 * still be in the tower's availability and not booked; BLOCKED in the sheet
 * or the CRM is fine only while our own hold for this quote is live,
 * because that block may be ours mirrored. Once a block is needed (a part is
 * paid, or the payment is arriving), it must be this quote's and live. Null
 * when all is well, else what happened, in words.
 */
export function flatGone(o: {
  unitStatus: string | null;
  block: { state: string; expiresAt: string; quoteId: string } | null;
  quoteId: string;
  nowIso: string;
  needBlock: boolean;
}): string | null {
  const ours = !!o.block && o.block.quoteId === o.quoteId && blockLive(o.block, o.nowIso);
  if (o.unitStatus === null) return "The flat is no longer in the tower's availability.";
  if (o.unitStatus === "BOOKED") return "The flat was sold.";
  if (o.unitStatus !== "AVAILABLE" && !(o.unitStatus === "BLOCKED" && ours)) return "The flat is blocked for somebody else.";
  if (o.needBlock && !ours) return "The hold on the flat ended.";
  return null;
}

/** What a person is told when the money arrived for a flat that is gone, by why it is gone. */
export function flatGoneFlag(why: string): string {
  return why === "The hold on the flat ended."
    ? "The hold on the flat ended before the token arrived. The token is being refunded."
    : "The flat was sold before the token arrived. The token is being refunded.";
}
