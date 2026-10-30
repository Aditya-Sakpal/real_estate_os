import { audit, withTenant } from "./db/index.ts";
import type { Authz } from "./rbac-rules.ts";
import { canPublish } from "./publish-gate.ts";
import { resolveBrain } from "./brain.ts";
import { approvedUnits } from "./unit.ts";
import { priceFor } from "./unit-rules.ts";
import { completedOn, gstForKind, quoteNumbers, womanConcession, type QuoteNumbers } from "./tax-rules.ts";
import {
  BLOCK_HOURS,
  QUOTE_DAYS,
  RESERVE_MINUTES,
  blockExpiry,
  paidExpiry,
  quoteHash,
  readLinkEvent,
  readRefundEvent,
  refundEventMove,
  webhookValid,
  tokenProblem,
  unitNoOf,
  extraLines,
  offlineReference,
  offlineTokenProblem,
  refundProblem,
  refundStateOf,
  REFUND_ATTEMPTS,
  MAX_TOKEN_LINKS,
  allocateRefund,
  chargeTotals,
  flatGone,
  flatGoneFlag,
  linkRefundReceipt,
  offlineRefundReceipt,
  partExpiry,
  partProblem,
  partReference,
  tdsNote,
  type ChargeLine,
  type TokenPart,
  type ExtraLine,
  type ExtraSpec,
  type LinkEvent,
  type RefundEvent,
  type OfflineMode,
  type QuoteState,
  type RefundMode,
  type RefundState,
} from "./quote-rules.ts";
import { CANCEL_REASONS } from "./lead-rules.ts";
import { renderQuote, type QuoteDoc } from "./quote-pdf.ts";
import { ownerOfAccount, paymentToken, payments } from "./payments.ts";
import { applyEngineMove, moveLead } from "./leads.ts";
import { sendMessage } from "./messaging.ts";
import { indian } from "./visit-note-rules.ts";

/**
 * A buyer's quote, the flat it blocks and the token link: the reads and
 * writes around `quote-rules.ts` and `tax-rules.ts`.
 *
 * Every number is worked out here from approved facts (the unit type's
 * approved price, the signed booking amount, the state's verified tax row),
 * never typed and never written by a model. The RERA gate is asked at every
 * step: drafting, approving, sending and when the token arrives.
 */

type Worked =
  | {
      ok: true;
      phaseId: string;
      unitTypeId: string;
      unitLabel: string;
      unitNo: string;
      unitHash: string;
      brainVersions: string[];
      token: number;
      /** The flat's approved price, before floor rise and PLC. */
      price: number;
      extras: ExtraLine[];
      /** Parking, club, the maintenance deposit and legal charges, in the order a buyer reads them. */
      charges: ChargeLine[];
      woman: boolean;
      numbers: QuoteNumbers;
      inventoryReadAt: string;
      registrationNo: string | null;
      parties: Parties;
    }
  | { ok: false; message: string };

/** The names a quote's PDF prints, recorded when it is drafted. */
export type Parties = { developer: string; promoter: string | null; project: string | null; tower: string; unitLabel: string; carpetSqft: number | null };

/** What a person typed on the draft beside the flat. */
export type DraftExtras = { extras?: readonly ExtraSpec[]; charges?: readonly ChargeLine[]; woman?: boolean };

/** Today in India, "YYYY-MM-DD". */
const todayIst = (nowMs = Date.now()) => new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);

/** Work a quote out from what is approved today. Both drafting and approving ask this. */
async function workOut(orgId: string, leadId: string, unitTypeId: string, rawUnitNo: string, typed: DraftExtras = {}): Promise<Worked> {
  const unitNo = unitNoOf(rawUnitNo);
  if (!unitNo) return { ok: false, message: "Enter the flat's number as the tower writes it, like C-803." };
  const [lead] = await withTenant(orgId, (sql) => sql<{ scope_node_id: string; city: string | null; tower: string; project: string | null; promoter: string | null; developer: string; oc: string | null }[]>`
    SELECT l.scope_node_id, r.name AS city, ph.name AS tower, p.name AS project, e.name AS promoter, o.legal_name AS developer,
           rr.oc_received_on::text AS oc
    FROM leads l JOIN scope_nodes ph ON ph.id = l.scope_node_id
    JOIN orgs o ON o.id = l.org_id
    LEFT JOIN registration_records rr ON rr.scope_node_id = l.scope_node_id
    LEFT JOIN scope_nodes p ON p.id = ph.parent_id
    LEFT JOIN scope_nodes r ON r.id = p.parent_id AND r.kind = 'REGION'
    LEFT JOIN scope_nodes e ON e.id = r.parent_id AND e.kind = 'ENTITY'
    WHERE l.org_id = ${orgId} AND l.id = ${leadId}`);
  if (!lead) return { ok: false, message: "That lead no longer exists." };
  const gate = await canPublish(orgId, lead.scope_node_id);
  if (!gate.ok) return { ok: false, message: "This tower may not be advertised right now, so nothing can be quoted." };
  const [{ units, basePsf }, brain, [flat]] = await Promise.all([
    approvedUnits(orgId, lead.scope_node_id).catch(() => ({ units: [], basePsf: null })),
    resolveBrain(orgId, lead.scope_node_id),
    withTenant(orgId, (sql) => sql<{ status: string; unit_type_id: string | null }[]>`
      SELECT status, unit_type_id FROM units
      WHERE org_id = ${orgId} AND scope_node_id = ${lead.scope_node_id}
        AND upper(regexp_replace(btrim(unit_no), '[[:space:]]+', ' ', 'g')) = ${unitNo}
      ORDER BY (status = 'AVAILABLE') DESC LIMIT 1`),
  ]);
  const unit = units.find((u) => u.id === unitTypeId && u.nodeId === lead.scope_node_id) ?? units.find((u) => u.id === unitTypeId);
  if (!unit) return { ok: false, message: "That configuration has no approved price at this tower." };
  const kind = gstForKind(unit.config);
  if (!kind.ok) return { ok: false, message: kind.why };
  if (!flat) return { ok: false, message: `Flat ${unitNo} is not in this tower's availability.` };
  if (flat.status !== "AVAILABLE") return { ok: false, message: `Flat ${unitNo} is not available.` };
  const [held] = await withTenant(orgId, (sql) => sql<{ lead_id: string; expires_at: Date }[]>`
    SELECT lead_id, expires_at FROM unit_blocks
    WHERE org_id = ${orgId} AND scope_node_id = ${lead.scope_node_id} AND unit_no = ${unitNo}
      AND state IN ('PENDING_TOKEN', 'TOKEN_PAID') AND expires_at > now()`);
  if (held && held.lead_id !== leadId) return { ok: false, message: `Flat ${unitNo} is held for another buyer until ${holdWords(held.expires_at)}.` };
  if (flat.unit_type_id && flat.unit_type_id !== unit.id) return { ok: false, message: `Flat ${unitNo} is not a ${unit.label}.` };
  const price = priceFor(unit, basePsf);
  if (!price) return { ok: false, message: "That configuration has no approved price at this tower." };
  const token = Number(brain?.values["price.booking_amount"] ?? NaN);
  const bad = tokenProblem(Number.isFinite(token) ? token : null, price);
  if (bad) return { ok: false, message: bad };
  // Floor rise and PLC join the agreement value; taxes are worked out on it.
  const extras = extraLines(typed.extras ?? [], unit.carpetAreaSqft, price);
  if (!extras.ok) return { ok: false, message: extras.why };
  // Parking and club join the agreement value; the deposit and legal charges sit outside it.
  const charges = chargeTotals(typed.charges ?? [], price);
  if (!charges.ok) return { ok: false, message: charges.why };
  const woman = !!typed.woman;
  const taxed = quoteNumbers({
    price: price + extras.total + charges.inAgreement,
    carpetSqft: unit.carpetAreaSqft,
    state: gate.stateCode,
    city: lead.city,
    // No GST once the phase's occupancy certificate is in.
    completed: completedOn(lead.oc, todayIst()),
    woman,
    charges: charges.outside,
  });
  if (!taxed.ok) return { ok: false, message: taxed.why };
  return {
    ok: true,
    phaseId: lead.scope_node_id,
    unitTypeId: unit.id,
    unitLabel: unit.label,
    unitNo,
    unitHash: unit.sha256,
    brainVersions: (brain?.sources ?? []).map((s) => s.versionId),
    token: Math.round(token),
    price: Math.round(price),
    extras: extras.lines,
    charges: charges.lines,
    woman,
    numbers: taxed.numbers,
    inventoryReadAt: new Date().toISOString(),
    registrationNo: gate.registrationNo,
    parties: {
      developer: lead.developer,
      promoter: lead.promoter,
      project: lead.project,
      tower: lead.tower,
      unitLabel: unit.label,
      carpetSqft: unit.carpetAreaSqft || null,
    },
  };
}

/** "3 Oct, 4:30 pm", in India. */
const holdWords = (d: Date) =>
  d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).toLowerCase().replace(/^(\d+ )(\w)/, (_, a, b) => a + b.toUpperCase());

const hashOf = (leadId: string, w: Extract<Worked, { ok: true }>) =>
  quoteHash({
    leadId,
    phaseId: w.phaseId,
    unitTypeId: w.unitTypeId,
    unitNo: w.unitNo,
    brainVersions: w.brainVersions,
    unitHash: w.unitHash,
    price: w.price,
    gst: w.numbers.gst,
    stampDuty: w.numbers.stampDuty,
    registration: w.numbers.registration,
    allIn: w.numbers.allIn,
    token: w.token,
    extras: w.extras,
    woman: w.woman,
    charges: w.charges,
  });

async function leadPath(orgId: string, leadId: string): Promise<string | null> {
  const [r] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
    SELECT n.path::text AS path FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id WHERE l.org_id = ${orgId} AND l.id = ${leadId}`);
  return r?.path ?? null;
}

export type QuoteResult = { ok: true; quoteId: string; message: string } | { ok: false; message: string };

/** The engine drafts a quote for one flat. An earlier draft or approval for the buyer is superseded. */
export async function draftQuote(o: { orgId: string; userId: string; authz: Authz; leadId: string; unitTypeId: string; unitNo: string } & DraftExtras): Promise<QuoteResult> {
  const path = await leadPath(o.orgId, o.leadId);
  if (!path || !o.authz.canAt("quote:create", path)) return { ok: false, message: "You cannot quote this buyer." };
  const w = await workOut(o.orgId, o.leadId, o.unitTypeId, o.unitNo, { extras: o.extras, charges: o.charges, woman: o.woman });
  if (!w.ok) return w;
  const out = await withTenant(o.orgId, async (sql) => {
    const [live] = await sql<{ id: string }[]>`
      SELECT q.id FROM quotes q
      WHERE q.org_id = ${o.orgId} AND q.lead_id = ${o.leadId} AND q.state = 'SENT'
        AND (EXISTS (SELECT 1 FROM payment_links p WHERE p.quote_id = q.id AND p.status IN ('CREATING', 'CREATED', 'PAID'))
          OR EXISTS (SELECT 1 FROM token_payments t WHERE t.quote_id = q.id))`;
    if (live) return null;
    await sql`UPDATE quotes SET state = 'SUPERSEDED', updated_at = now()
              WHERE org_id = ${o.orgId} AND lead_id = ${o.leadId} AND state IN ('DRAFT', 'APPROVED')`;
    const [q] = await sql<{ id: string }[]>`
      INSERT INTO quotes (org_id, lead_id, scope_node_id, unit_type_id, unit_no, brain_versions, unit_hash, inventory_read_at,
                          price, extras, extra_lines, charges, charge_lines, woman_buyer, gst_rate, gst, duty_rate, stamp_duty, registration,
                          all_in, token, tax_row, registration_no, parties, created_by, content_hash)
      VALUES (${o.orgId}, ${o.leadId}, ${w.phaseId}, ${w.unitTypeId}, ${w.unitNo}, ${w.brainVersions}::uuid[], ${w.unitHash}, ${w.inventoryReadAt},
              ${w.price}, ${w.numbers.agreement - w.price}, ${sql.json(w.extras as never)}, ${w.numbers.charges}, ${sql.json(w.charges as never)}, ${w.woman},
              ${w.numbers.gstRate}, ${w.numbers.gst}, ${w.numbers.dutyRate}, ${w.numbers.stampDuty},
              ${w.numbers.registration}, ${w.numbers.allIn}, ${w.token}, ${sql.json(w.numbers.row as never)}, ${w.registrationNo},
              ${sql.json(w.parties as never)}, ${o.userId}, ${hashOf(o.leadId, w)})
      RETURNING id`;
    return q.id;
  });
  if (!out) return { ok: false, message: "A token is already out or paid for this buyer." };
  await audit({
    orgId: o.orgId, actorUserId: o.userId, action: "quote.drafted", targetType: "quote", targetId: out,
    metadata: { tax: w.numbers.row.key, extras: w.extras.map((e) => e.kind), charges: w.charges.map((c) => c.kind), woman: w.woman },
  });
  return { ok: true, quoteId: out, message: "Quote drafted." };
}

type QuoteRow = {
  id: string;
  lead_id: string;
  scope_node_id: string;
  unit_type_id: string;
  unit_no: string;
  state: QuoteState;
  token: number;
  content_hash: string;
  created_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  price: number;
  extras: number;
  extra_lines: ExtraLine[];
  charge_lines: ChargeLine[];
  woman_buyer: boolean;
  path: string;
};

async function quoteRow(orgId: string, quoteId: string): Promise<QuoteRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) return null;
  const [q] = await withTenant(orgId, (sql) => sql<QuoteRow[]>`
    SELECT q.id, q.lead_id, q.scope_node_id, q.unit_type_id, q.unit_no, q.state, q.token::float8 AS token, q.content_hash, q.created_at,
           q.approved_by, q.approved_at, q.price::float8 AS price, q.extras::float8 AS extras, q.extra_lines, q.charge_lines, q.woman_buyer, n.path::text AS path
    FROM quotes q JOIN scope_nodes n ON n.id = q.scope_node_id
    WHERE q.org_id = ${orgId} AND q.id = ${quoteId}`);
  return q ?? null;
}

/**
 * A person approves the engine's draft. It is worked out again first, and a
 * quote whose price, taxes or flat changed since is drafted again rather
 * than approved: the approval pins what the draft said.
 */
export async function approveQuote(o: { orgId: string; userId: string; authz: Authz; quoteId: string; nowIso?: string }): Promise<QuoteResult> {
  const now = o.nowIso ?? new Date().toISOString();
  const q = await quoteRow(o.orgId, o.quoteId);
  if (!q) return { ok: false, message: "That quote no longer exists." };
  if (!o.authz.canAt("quote:approve", q.path)) return { ok: false, message: "You cannot approve quotes here." };
  if (q.state !== "DRAFT") return { ok: false, message: "Only a draft can be approved." };
  if (Date.parse(now) - q.created_at.getTime() > QUOTE_DAYS * 86_400_000) return { ok: false, message: "This draft is too old. Draft it again." };
  // Worked out again with the lines the draft carried, so they are approved with it.
  const w = await workOut(o.orgId, q.lead_id, q.unit_type_id, q.unit_no, {
    extras: q.extra_lines.map((e) => ({ kind: e.kind, basis: e.basis, rate: e.rate })),
    charges: q.charge_lines,
    woman: q.woman_buyer,
  });
  if (!w.ok) return w;
  if (hashOf(q.lead_id, w) !== q.content_hash) return { ok: false, message: "The price, the taxes or the flat changed since this was drafted. Draft it again." };
  const r = await withTenant(o.orgId, (sql) => sql`
    UPDATE quotes SET state = 'APPROVED', approved_by = ${o.userId}, approved_at = now(), updated_at = now()
    WHERE org_id = ${o.orgId} AND id = ${q.id} AND state = 'DRAFT'`);
  if (!r.count) return { ok: false, message: "Only a draft can be approved." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "quote.approved", targetType: "quote", targetId: q.id });
  return { ok: true, quoteId: q.id, message: "Quote approved." };
}

/** The parts of the token paid so far on a quote, oldest first: links paid, cheques and transfers. */
async function tokenParts(orgId: string, quoteId: string): Promise<TokenPart[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; by: string; amount: number; payment_id: string | null; reference: string; at: Date }[]>`
    SELECT id, 'RAZORPAY' AS by, (amount_paise / 100)::float8 AS amount, provider_payment_id AS payment_id, reference, paid_at AS at
    FROM payment_links WHERE org_id = ${orgId} AND quote_id = ${quoteId} AND status = 'PAID'
    UNION ALL
    SELECT id, mode, amount::float8, NULL, reference, recorded_at FROM token_payments WHERE org_id = ${orgId} AND quote_id = ${quoteId}
    ORDER BY at`);
  return rows.map((r) => ({ id: r.id, by: r.by as TokenPart["by"], amount: r.amount, paymentId: r.payment_id, reference: r.reference }));
}

const paidOf = (parts: readonly TokenPart[]) => parts.reduce((n, p) => n + p.amount, 0);

/** The flat as the tower's availability has it now, and the quote's newest block. */
async function flatNow(orgId: string, scopeNodeId: string, unitNo: string, quoteId: string): Promise<{
  unitStatus: string | null;
  block: { id: string; state: string; expiresAt: string; quoteId: string } | null;
}> {
  const [unit, block] = await withTenant(orgId, async (sql) => [
    (await sql<{ status: string }[]>`
      SELECT status FROM units
      WHERE org_id = ${orgId} AND scope_node_id = ${scopeNodeId}
        AND upper(regexp_replace(btrim(unit_no), '[[:space:]]+', ' ', 'g')) = ${unitNo}
      ORDER BY CASE status WHEN 'AVAILABLE' THEN 0 WHEN 'BLOCKED' THEN 1 ELSE 2 END LIMIT 1`)[0],
    (await sql<{ id: string; state: string; expires_at: Date; quote_id: string }[]>`
      SELECT id, state, expires_at, quote_id FROM unit_blocks WHERE org_id = ${orgId} AND quote_id = ${quoteId}
      ORDER BY created_at DESC LIMIT 1`)[0],
  ] as const);
  return {
    unitStatus: unit?.status ?? null,
    block: block ? { id: block.id, state: block.state, expiresAt: block.expires_at.toISOString(), quoteId: block.quote_id } : null,
  };
}

/**
 * Give back what was paid on a quote, part by part: one refund row per part
 * (a Razorpay payment is refunded on its own), each never more than that
 * part paid. Razorpay parts are asked of the developer's account at once; a
 * cheque or transfer is owed until a person records it paid. Safe to run
 * twice: a part already being refunded is left as it is.
 */
async function refundParts(o: {
  orgId: string;
  quoteId: string;
  leadId: string;
  parts: readonly TokenPart[];
  amount: number;
  reason: string;
  userId: string | null;
}): Promise<{ rows: number; razorpay: number; states: (RefundState | "WAITING")[] }> {
  const take = new Map(allocateRefund(o.parts, o.amount).map((a) => [a.id, a.amount]));
  const ids = await withTenant(o.orgId, async (sql) => {
    const out: { id: string; mode: RefundMode }[] = [];
    let k = 0;
    for (const p of o.parts) {
      const offline = p.by !== "RAZORPAY";
      if (offline) k += 1;
      const amount = take.get(p.id);
      if (!amount) continue;
      // A part already given back (a row before parts existed names no part, only its payment) is left alone.
      const [done] = await sql<{ id: string }[]>`
        SELECT id FROM token_refunds WHERE org_id = ${o.orgId} AND quote_id = ${o.quoteId}
          AND (link_id = ${p.id} OR token_payment_id = ${p.id}
               OR (link_id IS NULL AND token_payment_id IS NULL
                   AND (provider_payment_id = ${p.paymentId ?? ""} OR (${offline} AND mode = ${p.by}))))
        LIMIT 1`;
      if (done) continue;
      // A link paid with no payment id cannot be refunded through Razorpay: it is owed by transfer.
      const mode: RefundMode = offline ? (p.by as RefundMode) : p.paymentId ? "RAZORPAY" : "TRANSFER";
      const [r] = await sql<{ id: string }[]>`
        INSERT INTO token_refunds (org_id, quote_id, lead_id, mode, paid_amount, amount, reason, provider_payment_id, receipt, state,
                                   requested_by, link_id, token_payment_id)
        VALUES (${o.orgId}, ${o.quoteId}, ${o.leadId}, ${mode}, ${p.amount}, ${amount}, ${o.reason.slice(0, 120)},
                ${mode === "RAZORPAY" ? p.paymentId : null},
                ${offline ? offlineRefundReceipt(o.quoteId, k) : linkRefundReceipt(p.reference)},
                ${mode === "RAZORPAY" ? "REQUESTED" : "DUE"}, ${o.userId},
                ${offline ? null : p.id}, ${offline ? p.id : null})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (r) out.push({ id: r.id, mode });
    }
    return out;
  });
  const states: (RefundState | "WAITING")[] = [];
  for (const r of ids) if (r.mode === "RAZORPAY") states.push(await issueRefund(o.orgId, r.id));
  return { rows: ids.length, razorpay: states.length, states };
}

/**
 * Block the flat and send the buyer the token link, together or not at
 * all: the block and the link are reserved in one transaction, the link is
 * made at the gateway with the quote's reference, and a second transaction
 * finishes all three or undoes the reservation.
 *
 * A token may come in parts. Without an amount the link asks for all that
 * is left; with one, for that part. Once a part is paid the flat is already
 * held for this quote, and a later link reuses that hold and ends with it.
 */
export async function sendQuote(o: {
  orgId: string;
  userId: string;
  authz: Authz;
  quoteId: string;
  /** A part of the token, in rupees. Absent: all that is left. */
  amount?: number;
  nowIso?: string;
}): Promise<QuoteResult & { url?: string }> {
  const now = o.nowIso ?? new Date().toISOString();
  const q = await quoteRow(o.orgId, o.quoteId);
  if (!q) return { ok: false, message: "That quote no longer exists." };
  if (!o.authz.canAt("quote:approve", q.path)) return { ok: false, message: "You cannot send token links here." };
  if (q.state !== "APPROVED" && q.state !== "SENT") return { ok: false, message: "Only an approved quote can be sent." };
  const parts = await tokenParts(o.orgId, q.id);
  const paid = paidOf(parts);
  if (q.state === "SENT" && paid === 0) return { ok: false, message: "A token link is already out for this quote." };
  const amount = o.amount ?? q.token - paid;
  const bad = partProblem({ amount, token: q.token, paid, parts: parts.length, whole: o.amount === undefined });
  if (bad) return { ok: false, message: bad };
  if (!(await canPublish(o.orgId, q.scope_node_id)).ok) return { ok: false, message: "This tower may not be advertised right now, so no token can be asked for." };
  // The flat must still be for sale, and once a part is paid, still held for this quote.
  const flat = await flatNow(o.orgId, q.scope_node_id, q.unit_no, q.id);
  const gone = flatGone({ unitStatus: flat.unitStatus, block: flat.block, quoteId: q.id, nowIso: now, needBlock: paid > 0 });
  if (gone) return { ok: false, message: `${gone} No link was sent.` };
  const account = await paymentToken(o.orgId);
  if (!account) return { ok: false, message: "Connect your Razorpay account in Settings first." };
  const [lead] = await withTenant(o.orgId, (sql) => sql<{ name: string; phone: string; project: string }[]>`
    SELECT l.name, l.phone, CASE WHEN p.name IS NULL THEN n.name ELSE p.name || ' ' || n.name END AS project
    FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
    WHERE l.org_id = ${o.orgId} AND l.id = ${q.lead_id}`);
  const [{ made }] = await withTenant(o.orgId, (sql) => sql<{ made: number }[]>`
    SELECT count(*)::int AS made FROM payment_links WHERE org_id = ${o.orgId} AND quote_id = ${q.id}`);
  if (made >= MAX_TOKEN_LINKS) return { ok: false, message: "This quote has made all the links it may. Record the token paid another way." };
  const reference = partReference(q.id, made + 1);
  // A later part's link ends with the hold the first part bought.
  const expires = paid > 0 && flat.block ? flat.block.expiresAt : blockExpiry(now);

  // 1. Reserve the flat and the link, or neither.
  let reserved: { blockId: string; linkId: string } | { held: string } | { out: true };
  try {
    reserved = await withTenant(o.orgId, async (sql) => {
      let blockId: string;
      if (paid > 0 && flat.block) {
        blockId = flat.block.id;
      } else {
        await sql`
          UPDATE unit_blocks SET state = 'RELEASED', released_at = now(), reason = 'Expired'
          WHERE org_id = ${o.orgId} AND scope_node_id = ${q.scope_node_id} AND unit_no = ${q.unit_no}
            AND state IN ('PENDING_TOKEN', 'TOKEN_PAID') AND expires_at <= ${new Date(now)}`;
        const [held] = await sql<{ expires_at: Date }[]>`
          SELECT expires_at FROM unit_blocks WHERE org_id = ${o.orgId} AND scope_node_id = ${q.scope_node_id} AND unit_no = ${q.unit_no}
            AND state IN ('PENDING_TOKEN', 'TOKEN_PAID')`;
        if (held) return { held: held.expires_at.toISOString() };
        const [b] = await sql<{ id: string }[]>`
          INSERT INTO unit_blocks (org_id, scope_node_id, unit_no, quote_id, lead_id, expires_at)
          VALUES (${o.orgId}, ${q.scope_node_id}, ${q.unit_no}, ${q.id}, ${q.lead_id}, ${new Date(expires)}) RETURNING id`;
        blockId = b.id;
      }
      const [out] = await sql<{ id: string }[]>`
        SELECT id FROM payment_links WHERE org_id = ${o.orgId} AND quote_id = ${q.id} AND status IN ('CREATING', 'CREATED')`;
      if (out) return { out: true as const };
      const [l] = await sql<{ id: string }[]>`
        INSERT INTO payment_links (org_id, quote_id, block_id, account_id, reference, amount_paise, expires_at)
        VALUES (${o.orgId}, ${q.id}, ${blockId}, ${account.accountRowId}, ${reference}, ${Math.round(amount * 100)}, ${new Date(expires)})
        RETURNING id`;
      return { blockId, linkId: l.id };
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") return { ok: false, message: `Flat ${q.unit_no} is held for another buyer, or a link is already out.` };
    if (code === "23514") return { ok: false, message: "That is more than the token, or more than three parts." };
    throw e;
  }
  if ("held" in reserved) return { ok: false, message: `Flat ${q.unit_no} is held for another buyer until ${holdWords(new Date(reserved.held))}.` };
  if ("out" in reserved) return { ok: false, message: "A token link is already out for this quote." };

  // 2. The gateway. A lost answer is looked for before a second link is made.
  let link: { id: string; shortUrl: string } | null = null;
  try {
    link = await payments().findLink(account.token, reference);
    link ??= await payments().createLink(account.token, {
      amountPaise: Math.round(amount * 100),
      reference,
      description: `${paid > 0 || amount < q.token ? "Part of the token" : "Token"} for flat ${q.unit_no}, ${lead?.project ?? ""}`.trim(),
      expireBy: expires,
      customer: { name: lead?.name ?? "Buyer", contact: lead?.phone ?? "" },
    });
  } catch (e) {
    console.warn("payments: link not made,", (e instanceof Error ? e.message : String(e)).slice(0, 300));
    // The answer may have been lost with the link made: look once more.
    link = await payments().findLink(account.token, reference).catch(() => null);
  }

  // 3. Finish all three, or undo the reservation. A hold a part already paid for stays.
  const { blockId, linkId } = reserved;
  if (!link) {
    await withTenant(o.orgId, async (sql) => {
      await sql`UPDATE payment_links SET status = 'VOID', updated_at = now() WHERE org_id = ${o.orgId} AND id = ${linkId}`;
      if (paid === 0) {
        await sql`UPDATE unit_blocks SET state = 'RELEASED', released_at = now(), reason = 'The token link could not be made'
                  WHERE org_id = ${o.orgId} AND id = ${blockId} AND state = 'PENDING_TOKEN'`;
      }
    });
    return { ok: false, message: paid > 0 ? "Razorpay did not make the link. Try again." : "Razorpay did not make the link. Nothing was blocked. Try again." };
  }
  await withTenant(o.orgId, async (sql) => {
    await sql`UPDATE payment_links SET status = 'CREATED', provider_id = ${link!.id}, short_url = ${link!.shortUrl}, updated_at = now()
              WHERE org_id = ${o.orgId} AND id = ${linkId}`;
    await sql`UPDATE quotes SET state = 'SENT', sent_at = now(), updated_at = now() WHERE org_id = ${o.orgId} AND id = ${q.id} AND state = 'APPROVED'`;
  });
  await audit({
    orgId: o.orgId, actorUserId: o.userId, action: "quote.sent", targetType: "quote", targetId: q.id,
    metadata: { hours: BLOCK_HOURS, part: amount < q.token - paid || paid > 0, link: made + 1 },
  });
  // The buyer gets the link on WhatsApp where the rules allow; the lead's page shows it either way.
  const sent = await sendMessage({
    orgId: o.orgId,
    leadId: q.lead_id,
    purpose: "TOKEN_LINK",
    nowIso: now,
    userId: o.userId,
    extra: { flat: q.unit_no, amount: indian(amount), link: link.shortUrl },
  }).catch(() => ({ ok: false as const }));
  const held = paid > 0 ? `Flat ${q.unit_no} stays held until ${holdWords(new Date(expires))}.` : `Flat ${q.unit_no} is held for ${BLOCK_HOURS} hours.`;
  return {
    ok: true,
    quoteId: q.id,
    message: sent.ok
      ? `${held} The buyer has the link for Rs ${amount.toLocaleString("en-IN")} on WhatsApp.`
      : `${held} WhatsApp could not send the link: copy it from the card and send it yourself.`,
    url: link.shortUrl,
  };
}

/**
 * What the gateway said about a link. A payment that completes the token
 * holds the flat seven days more and books the buyer, forward only; a part
 * holds it for the rest; an expired or cancelled link lets the flat go
 * unless a part is already paid. Safe to receive twice.
 *
 * Money that arrives for a flat that is gone (sold in the sheet or the
 * CRM, or its hold ended) books nobody: every part paid on the quote is
 * refunded and a person is told. A payment on a link we had marked expired
 * or cancelled is still recorded as paid, because the money is real, and
 * the change is audited with what the link said before.
 */
export async function onLinkEvent(orgId: string, ev: LinkEvent): Promise<"BOOKED" | "PAID" | "PART" | "REFUNDING" | "RELEASED" | "IGNORED"> {
  const [row] = await withTenant(orgId, (sql) => sql<{
    id: string; quote_id: string; block_id: string; status: string; lead_id: string; scope_node_id: string; unit_no: string;
    q_state: QuoteState; agreement: string; token: string; approved_by: string | null;
  }[]>`
    SELECT p.id, p.quote_id, p.block_id, p.status, q.lead_id, q.scope_node_id, q.unit_no, q.state AS q_state,
           (q.price + q.extras)::text AS agreement, q.token::text, q.approved_by
    FROM payment_links p JOIN quotes q ON q.id = p.quote_id
    WHERE p.org_id = ${orgId} AND (p.provider_id = ${ev.linkId} OR (${ev.reference ?? ""} <> '' AND p.reference = ${ev.reference ?? ""}))
    ORDER BY (p.provider_id = ${ev.linkId}) IS TRUE DESC, p.created_at DESC LIMIT 1`);
  if (!row) return "IGNORED";

  if (ev.event === "PAID") {
    if (row.status === "PAID") return "IGNORED";
    const paidAt = ev.paidAt ?? new Date().toISOString();
    const was = row.status;
    const marked = await withTenant(orgId, (sql) => sql`
      UPDATE payment_links SET status = 'PAID', paid_at = ${new Date(paidAt)}, provider_payment_id = ${ev.paymentId},
             provider_id = coalesce(provider_id, ${ev.linkId}), updated_at = now()
      WHERE org_id = ${orgId} AND id = ${row.id} AND status <> 'PAID'`);
    if (!marked.count) return "IGNORED";
    if (was !== "CREATED" && was !== "CREATING") {
      // Never silently: the link had ended here, and the money came anyway.
      await audit({ orgId, actorUserId: null, action: "quote.token_paid_late", targetType: "quote", targetId: row.quote_id, metadata: { was } });
    }

    // The flat must still be this buyer's: in the availability, not sold, and held for this quote.
    const flat = await flatNow(orgId, row.scope_node_id, row.unit_no, row.quote_id);
    const gone = flatGone({ unitStatus: flat.unitStatus, block: flat.block, quoteId: row.quote_id, nowIso: new Date().toISOString(), needBlock: true });
    const parts = await tokenParts(orgId, row.quote_id);
    if (gone) {
      await giveBack({ orgId, quoteId: row.quote_id, leadId: row.lead_id, parts, why: gone });
      return "REFUNDING";
    }

    const paid = paidOf(parts);
    const token = Number(row.token);
    if (paid > token) {
      // A link paid after the token was already in: that payment alone goes back.
      const extra = parts.filter((p) => p.id === row.id);
      await refundParts({ orgId, quoteId: row.quote_id, leadId: row.lead_id, parts: extra, amount: paidOf(extra), reason: "Paid after the token was already in", userId: null });
      await withTenant(orgId, (sql) => sql`
        UPDATE leads SET needs_person = 'A token link was paid after the token was already in. That payment is being refunded.', updated_at = now()
        WHERE org_id = ${orgId} AND id = ${row.lead_id}`);
      return "REFUNDING";
    }
    if (paid < token) {
      // A part: the flat stays held for the rest.
      await withTenant(orgId, (sql) => sql`
        UPDATE unit_blocks SET expires_at = greatest(expires_at, ${new Date(partExpiry(paidAt))})
        WHERE org_id = ${orgId} AND id = ${row.block_id} AND state = 'PENDING_TOKEN'`);
      await audit({ orgId, actorUserId: null, action: "quote.token_part_paid", targetType: "quote", targetId: row.quote_id, metadata: { parts: parts.length } });
      return "PART";
    }
    await withTenant(orgId, (sql) => sql`
      UPDATE unit_blocks SET state = 'TOKEN_PAID', paid_at = ${new Date(paidAt)}, expires_at = ${new Date(paidExpiry(paidAt))}
      WHERE org_id = ${orgId} AND id = ${row.block_id} AND state = 'PENDING_TOKEN'`);
    await audit({ orgId, actorUserId: null, action: "quote.token_paid", targetType: "quote", targetId: row.quote_id, metadata: { parts: parts.length } });
    return bookOnToken({
      orgId,
      leadId: row.lead_id,
      scopeNodeId: row.scope_node_id,
      agreement: row.agreement,
      token: row.token,
      paidAt,
      bookedOn: new Date(Date.parse(paidAt) + 330 * 60_000).toISOString().slice(0, 10),
      userId: row.approved_by,
      why: parts.length > 1 ? "Token paid in parts" : "Token paid on the link",
    });
  }

  if (row.status === "PAID" || row.status === "EXPIRED" || row.status === "CANCELLED" || row.status === "VOID") return "IGNORED";
  await releaseLink(orgId, row.id, row.block_id, row.quote_id, ev.event, ev.event === "EXPIRED" ? "The token link expired" : "The token link was cancelled");
  return "RELEASED";
}

/**
 * The flat is gone with money paid on it: book nobody, give back every part,
 * let the hold go, end the quote, and tell a person. Every step is safe to
 * repeat.
 */
async function giveBack(o: { orgId: string; quoteId: string; leadId: string; parts: readonly TokenPart[]; why: string }): Promise<void> {
  await withTenant(o.orgId, async (sql) => {
    await sql`UPDATE unit_blocks SET state = 'RELEASED', released_at = now(), reason = ${o.why.slice(0, 200)}
              WHERE org_id = ${o.orgId} AND quote_id = ${o.quoteId} AND state IN ('PENDING_TOKEN', 'TOKEN_PAID')`;
    await sql`UPDATE quotes SET state = 'CANCELLED', cancelled_at = now(), updated_at = now()
              WHERE org_id = ${o.orgId} AND id = ${o.quoteId} AND state = 'SENT'`;
    await sql`UPDATE leads SET needs_person = ${flatGoneFlag(o.why)}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${o.leadId}`;
  });
  const r = await refundParts({
    orgId: o.orgId, quoteId: o.quoteId, leadId: o.leadId, parts: o.parts, amount: paidOf(o.parts),
    reason: o.why === "The hold on the flat ended." ? "The hold ended before the token was paid" : "The flat was sold before the token arrived",
    userId: null,
  });
  await audit({ orgId: o.orgId, actorUserId: null, action: "quote.token_refunded_flat_gone", targetType: "quote", targetId: o.quoteId, metadata: { parts: o.parts.length, refunds: r.rows } });
}

/**
 * A link ended unpaid. With nothing paid on the quote its hold goes and the
 * quote expires; with a part paid, only the link ends, and the hold stays
 * for the rest until its own end.
 */
async function releaseLink(orgId: string, linkId: string, blockId: string, quoteId: string, status: "EXPIRED" | "CANCELLED" | "VOID", reason: string): Promise<void> {
  const partly = (await tokenParts(orgId, quoteId)).length > 0;
  await withTenant(orgId, async (sql) => {
    await sql`UPDATE payment_links SET status = ${status}, updated_at = now() WHERE org_id = ${orgId} AND id = ${linkId} AND status IN ('CREATING', 'CREATED')`;
    if (partly) return;
    await sql`UPDATE unit_blocks SET state = 'RELEASED', released_at = now(), reason = ${reason}
              WHERE org_id = ${orgId} AND id = ${blockId} AND state = 'PENDING_TOKEN'`;
    await sql`UPDATE quotes SET state = 'EXPIRED', updated_at = now() WHERE org_id = ${orgId} AND id = ${quoteId} AND state = 'SENT'`;
  });
}

/**
 * A token is in: book the buyer, the one path a paid link and a token paid
 * by hand both take. The money is in whatever the gate says now; whether
 * that books the buyer is the gate's question, and a stopped tower is a
 * person's. Forward only: `applyEngineMove` never moves a lead backward.
 */
async function bookOnToken(o: {
  orgId: string;
  leadId: string;
  scopeNodeId: string;
  agreement: string;
  token: string;
  paidAt: string;
  bookedOn: string;
  userId: string | null;
  why: string;
}): Promise<"BOOKED" | "PAID"> {
  if (!(await canPublish(o.orgId, o.scopeNodeId)).ok) {
    await withTenant(o.orgId, (sql) => sql`
      UPDATE leads SET needs_person = 'Token paid on a tower that may not be advertised now. Decide the refund or the hold', updated_at = now()
      WHERE org_id = ${o.orgId} AND id = ${o.leadId}`);
    return "PAID";
  }
  const moved = await applyEngineMove({
    orgId: o.orgId,
    leadId: o.leadId,
    move: { to: "booked", facts: { bookedOn: o.bookedOn, agreement: o.agreement, token: o.token }, why: o.why },
  });
  if (moved && o.userId) {
    const { onMoved } = await import("./lead-engine.ts");
    await onMoved({ orgId: o.orgId, userId: o.userId, leadId: o.leadId, from: moved.from, to: "booked", facts: {}, followUpOn: null, nowIso: o.paidAt });
  }
  return moved ? "BOOKED" : "PAID";
}

// ---------------------------------------------------------------------------
// A token paid by cheque or bank transfer
// ---------------------------------------------------------------------------

/**
 * Somebody holding `quote:approve` records a token, or part of one, the
 * buyer paid by cheque or transfer. A link still out is cancelled at the
 * gateway first, so the buyer cannot pay twice. The first part blocks the
 * flat; a part holds it for the rest; the part that completes the token
 * books the buyer exactly as a paid link does.
 */
export async function recordOfflineToken(o: {
  orgId: string;
  userId: string;
  authz: Authz;
  quoteId: string;
  mode: string;
  reference: string;
  amount: number;
  paidOn: string;
  today: string;
  /** The person said this is part of the token. */
  part?: boolean;
  nowIso?: string;
}): Promise<QuoteResult> {
  const now = o.nowIso ?? new Date().toISOString();
  const q = await quoteRow(o.orgId, o.quoteId);
  if (!q) return { ok: false, message: "That quote no longer exists." };
  if (!o.authz.canAt("quote:approve", q.path)) return { ok: false, message: "You cannot record tokens here." };
  if (q.state !== "APPROVED" && q.state !== "SENT") return { ok: false, message: "Only an approved quote takes a token." };
  const parts = await tokenParts(o.orgId, q.id);
  const paid = paidOf(parts);
  const bad = offlineTokenProblem({
    mode: o.mode, reference: o.reference, amount: o.amount, token: q.token, paidOn: o.paidOn, today: o.today,
    paid, parts: parts.length, part: o.part,
  });
  if (bad) return { ok: false, message: bad };
  const mode = o.mode as OfflineMode;
  const reference = offlineReference(mode, o.reference)!;
  const complete = paid + o.amount === q.token;
  const flat = await flatNow(o.orgId, q.scope_node_id, q.unit_no, q.id);
  const gone = flatGone({ unitStatus: flat.unitStatus, block: flat.block, quoteId: q.id, nowIso: now, needBlock: paid > 0 });
  if (gone) return { ok: false, message: `${gone} Nothing was recorded.` };

  // A link still out is cancelled first.
  const [link] = await withTenant(o.orgId, (sql) => sql<{ id: string; status: string; provider_id: string | null; reference: string; block_id: string }[]>`
    SELECT id, status, provider_id, reference, block_id FROM payment_links
    WHERE org_id = ${o.orgId} AND quote_id = ${q.id} AND status IN ('CREATING', 'CREATED')`);
  if (link?.status === "CREATING") return { ok: false, message: "The token link is still being made. Try again in a minute." };
  if (link) {
    const account = await paymentToken(o.orgId);
    if (!account) return { ok: false, message: "Razorpay is not connected, so the link out cannot be cancelled. Connect it first." };
    try {
      const found = link.provider_id ? { id: link.provider_id } : await payments().findLink(account.token, link.reference);
      if (found) await payments().cancelLink(account.token, found.id);
    } catch {
      return { ok: false, message: "Razorpay did not cancel the link out, so nothing was recorded. Try again." };
    }
  }

  const paidHold = new Date(paidExpiry(now));
  const partHold = new Date(partExpiry(now));
  let out: { paymentId: string } | { held: string } | { gone: true };
  try {
    out = await withTenant(o.orgId, async (sql) => {
      let blockId: string;
      if (link) {
        const cancelled = await sql`UPDATE payment_links SET status = 'CANCELLED', updated_at = now()
                                    WHERE org_id = ${o.orgId} AND id = ${link.id} AND status = 'CREATED'`;
        if (!cancelled.count) return { gone: true as const };
        blockId = link.block_id;
      } else if (paid > 0 && flat.block) {
        blockId = flat.block.id;
      } else {
        await sql`
          UPDATE unit_blocks SET state = 'RELEASED', released_at = now(), reason = 'Expired'
          WHERE org_id = ${o.orgId} AND scope_node_id = ${q.scope_node_id} AND unit_no = ${q.unit_no}
            AND state IN ('PENDING_TOKEN', 'TOKEN_PAID') AND expires_at <= ${new Date(now)}`;
        const [held] = await sql<{ expires_at: Date }[]>`
          SELECT expires_at FROM unit_blocks WHERE org_id = ${o.orgId} AND scope_node_id = ${q.scope_node_id} AND unit_no = ${q.unit_no}
            AND state IN ('PENDING_TOKEN', 'TOKEN_PAID')`;
        if (held) return { held: held.expires_at.toISOString() };
        const [b] = await sql<{ id: string }[]>`
          INSERT INTO unit_blocks (org_id, scope_node_id, unit_no, quote_id, lead_id, expires_at)
          VALUES (${o.orgId}, ${q.scope_node_id}, ${q.unit_no}, ${q.id}, ${q.lead_id}, ${partHold}) RETURNING id`;
        blockId = b.id;
        const sent = await sql`UPDATE quotes SET state = 'SENT', sent_at = now(), updated_at = now()
                               WHERE org_id = ${o.orgId} AND id = ${q.id} AND state = 'APPROVED'`;
        if (!sent.count) throw Object.assign(new Error("quote moved"), { code: "QUOTE_MOVED" });
      }
      // The whole token paid: held seven days for the agreement. A part: held for the rest.
      const [b] = complete
        ? await sql<{ id: string }[]>`
            UPDATE unit_blocks SET state = 'TOKEN_PAID', paid_at = ${new Date(now)}, expires_at = ${paidHold}
            WHERE org_id = ${o.orgId} AND id = ${blockId} AND state = 'PENDING_TOKEN' RETURNING id`
        : await sql<{ id: string }[]>`
            UPDATE unit_blocks SET expires_at = greatest(expires_at, ${partHold})
            WHERE org_id = ${o.orgId} AND id = ${blockId} AND state = 'PENDING_TOKEN' RETURNING id`;
      if (!b) return { gone: true as const };
      const [p] = await sql<{ id: string }[]>`
        INSERT INTO token_payments (org_id, quote_id, block_id, lead_id, mode, reference, amount, paid_on, recorded_by)
        VALUES (${o.orgId}, ${q.id}, ${blockId}, ${q.lead_id}, ${mode}, ${reference}, ${o.amount}, ${o.paidOn}, ${o.userId})
        RETURNING id`;
      return { paymentId: p.id };
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") return { ok: false, message: `Flat ${q.unit_no} is held for another buyer, or this payment is already recorded.` };
    if (code === "23514") return { ok: false, message: "That is more than the token, or more than three parts." };
    if (code === "QUOTE_MOVED") return { ok: false, message: "This quote changed since you opened it. Refresh and try again." };
    throw e;
  }
  if ("held" in out) return { ok: false, message: `Flat ${q.unit_no} is held for another buyer until ${holdWords(new Date(out.held))}.` };
  if ("gone" in out) return { ok: false, message: "This quote changed since you opened it. Refresh and try again." };
  // The mode, never the cheque number or the UTR.
  await audit({
    orgId: o.orgId, actorUserId: o.userId, action: complete ? "quote.token_recorded" : "quote.token_part_recorded", targetType: "quote", targetId: q.id,
    metadata: { mode, parts: parts.length + 1 },
  });
  if (!complete) {
    const left = q.token - paid - o.amount;
    return {
      ok: true,
      quoteId: q.id,
      message: `Part recorded. Rs ${left.toLocaleString("en-IN")} of the token is still to come, and flat ${q.unit_no} is held until ${holdWords(partHold)}.`,
    };
  }
  const booked = await bookOnToken({
    orgId: o.orgId,
    leadId: q.lead_id,
    scopeNodeId: q.scope_node_id,
    agreement: String(q.price + q.extras),
    token: String(q.token),
    paidAt: now,
    bookedOn: o.paidOn,
    userId: o.userId,
    why: parts.length ? "Token paid in parts" : mode === "CHEQUE" ? "Token paid by cheque" : "Token paid by bank transfer",
  });
  return {
    ok: true,
    quoteId: q.id,
    message: booked === "BOOKED"
      ? `Token recorded. Flat ${q.unit_no} is held 7 days for the agreement, and the buyer is booked.`
      : `Token recorded and flat ${q.unit_no} is held. The tower may not be advertised now, so the buyer is not booked.`,
  };
}

// ---------------------------------------------------------------------------
// Cancelling a paid token, and its refund
// ---------------------------------------------------------------------------

/**
 * The buyer's paid token, or the parts of it paid so far, is cancelled: the
 * quote is CANCELLED, the flat is let go, the lead leaves Booked through the
 * board's own move (to Lost, with the cancellation's reason), and what is
 * given back is a refund row per part. A Razorpay part is refunded through
 * the developer's own account at once; a cheque or transfer is owed until
 * somebody records paying it.
 */
export async function cancelToken(o: {
  orgId: string;
  userId: string;
  authz: Authz;
  quoteId: string;
  reason: string;
  refund: number;
  today: string;
}): Promise<QuoteResult> {
  const q = await quoteRow(o.orgId, o.quoteId);
  if (!q) return { ok: false, message: "That quote no longer exists." };
  if (!o.authz.canAt("quote:approve", q.path)) return { ok: false, message: "You cannot cancel tokens here." };
  if (q.state !== "SENT") return { ok: false, message: "Only a quote whose token was paid can be cancelled." };
  if (!(CANCEL_REASONS as readonly string[]).includes(o.reason)) return { ok: false, message: "Choose why the booking is cancelled." };
  const parts = await tokenParts(o.orgId, q.id);
  if (!parts.length) return { ok: false, message: "No token has been paid on this quote." };
  const paid = paidOf(parts);
  const bad = refundProblem(o.refund, paid);
  if (bad) return { ok: false, message: bad };
  const [block] = await withTenant(o.orgId, (sql) => sql<{ state: string }[]>`
    SELECT state FROM unit_blocks WHERE org_id = ${o.orgId} AND quote_id = ${q.id} ORDER BY created_at DESC LIMIT 1`);
  if (block?.state === "CONVERTED") return { ok: false, message: "The agreement for this flat is registered. Cancel it in your CRM first." };

  const linksOut = await withTenant(o.orgId, (sql) => sql<{ id: string; provider_id: string | null }[]>`
    SELECT id, provider_id FROM payment_links WHERE org_id = ${o.orgId} AND quote_id = ${q.id} AND status = 'CREATED'`);
  const done = await withTenant(o.orgId, async (sql) => {
    const u = await sql`
      UPDATE quotes SET state = 'CANCELLED', cancelled_at = now(), cancelled_by = ${o.userId}, updated_at = now()
      WHERE org_id = ${o.orgId} AND id = ${q.id} AND state = 'SENT'`;
    if (!u.count) return false;
    await sql`
      UPDATE unit_blocks SET state = 'RELEASED', released_at = now(), reason = 'The token was cancelled'
      WHERE org_id = ${o.orgId} AND quote_id = ${q.id} AND state IN ('PENDING_TOKEN', 'TOKEN_PAID')`;
    // A link still out for the rest ends with the quote.
    await sql`UPDATE payment_links SET status = 'CANCELLED', updated_at = now()
              WHERE org_id = ${o.orgId} AND quote_id = ${q.id} AND status = 'CREATED'`;
    return true;
  });
  if (!done) return { ok: false, message: "This token was already cancelled." };
  const modes = [...new Set(parts.map((p) => p.by))];
  await audit({
    orgId: o.orgId, actorUserId: o.userId, action: "quote.token_cancelled", targetType: "quote", targetId: q.id,
    metadata: { modes, parts: parts.length, refund: o.refund > 0, partial: o.refund > 0 && o.refund < paid },
  });

  // Out of Booked through the board's own move, so partner payouts and
  // outcomes follow as they do for any cancelled booking.
  const [lead] = await withTenant(o.orgId, (sql) => sql<{ stage: string }[]>`SELECT stage FROM leads WHERE org_id = ${o.orgId} AND id = ${q.lead_id}`);
  if (lead?.stage === "booked") {
    const moved = await moveLead({ orgId: o.orgId, userId: o.userId, leadId: q.lead_id, to: "lost", input: { facts: {}, reason: o.reason, seen: "booked" }, today: o.today });
    if (moved.ok) {
      const { onMoved } = await import("./lead-engine.ts");
      await onMoved({ orgId: o.orgId, userId: o.userId, leadId: q.lead_id, from: moved.from, to: moved.to, facts: moved.facts, followUpOn: moved.followUpOn });
    }
  }

  // The link out at the gateway is cancelled after; one that will not cancel expires with the hold.
  const account = linksOut.length ? await paymentToken(o.orgId) : null;
  for (const l of linksOut) if (account && l.provider_id) await payments().cancelLink(account.token, l.provider_id).catch(() => undefined);

  if (o.refund === 0) return { ok: true, quoteId: q.id, message: "Token cancelled. Nothing is refunded." };
  const r = await refundParts({ orgId: o.orgId, quoteId: q.id, leadId: q.lead_id, parts, amount: o.refund, reason: o.reason, userId: o.userId });
  const rs = `Rs ${o.refund.toLocaleString("en-IN")}`;
  if (!r.razorpay) return { ok: true, quoteId: q.id, message: `Token cancelled. ${rs} is owed back to the buyer.` };
  const stuck = r.states.some((s) => s === "WAITING" || s === "FAILED");
  return {
    ok: true,
    quoteId: q.id,
    message: stuck
      ? "Token cancelled. Razorpay did not take the refund yet; it is asked again shortly."
      : r.razorpay === r.rows
        ? `Token cancelled. ${rs} is being refunded through Razorpay.`
        : `Token cancelled. ${rs} is being refunded: the link payments through Razorpay, the rest owed by cheque or transfer.`,
  };
}

/**
 * Ask the developer's Razorpay account for one refund. It looks for a
 * refund under the quote's receipt first, and sends the receipt as the
 * idempotency key, so a lost answer or a second worker cannot refund twice.
 * Counted per attempt; past `REFUND_ATTEMPTS` a person is told.
 */
async function issueRefund(orgId: string, refundId: string): Promise<RefundState | "WAITING"> {
  const [r] = await withTenant(orgId, (sql) => sql<{ id: string; lead_id: string; amount: number; receipt: string; provider_payment_id: string; state: RefundState; attempts: number }[]>`
    SELECT id, lead_id, amount::float8 AS amount, receipt, provider_payment_id, state, attempts FROM token_refunds
    WHERE org_id = ${orgId} AND id = ${refundId} AND mode = 'RAZORPAY' AND state = 'REQUESTED' AND provider_refund_id IS NULL`);
  if (!r) return "WAITING";
  const account = await paymentToken(orgId);
  let got: { id: string; status: string; amountPaise: number } | null = null;
  let error: string | null = null;
  if (!account) error = "Razorpay is not connected";
  else {
    try {
      got = await payments().findRefund(account.token, r.provider_payment_id, r.receipt);
      got ??= await payments().refund(account.token, { paymentId: r.provider_payment_id, amountPaise: Math.round(r.amount * 100), receipt: r.receipt });
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      // The answer may have been lost with the refund made: look once more.
      got = await payments().findRefund(account.token, r.provider_payment_id, r.receipt).catch(() => null);
    }
  }
  if (got) {
    const state = refundStateOf(got.status);
    await withTenant(orgId, (sql) => sql`
      UPDATE token_refunds SET provider_refund_id = ${got!.id}, state = ${state}, attempts = attempts + 1, last_error = NULL,
             processed_at = ${state === "PROCESSED" ? sql`now()` : null}, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${r.id} AND provider_refund_id IS NULL`);
    return state;
  }
  const failed = r.attempts + 1 >= REFUND_ATTEMPTS;
  await withTenant(orgId, async (sql) => {
    await sql`UPDATE token_refunds SET attempts = attempts + 1, last_error = ${error}, state = ${failed ? "FAILED" : "REQUESTED"}, updated_at = now()
              WHERE org_id = ${orgId} AND id = ${r.id}`;
    if (failed) {
      await sql`UPDATE leads SET needs_person = 'Razorpay did not refund the token. Refund it another way and record it', updated_at = now()
                WHERE org_id = ${orgId} AND id = ${r.lead_id}`;
    }
  });
  return failed ? "FAILED" : "WAITING";
}

/** Refunds the gateway has not answered yet: asked again, and pending ones read back. Every worker pass. */
async function sweepRefunds(orgId: string): Promise<number> {
  const due = await withTenant(orgId, (sql) => sql<{ id: string; provider_refund_id: string | null; provider_payment_id: string; receipt: string; lead_id: string }[]>`
    SELECT id, provider_refund_id, provider_payment_id, receipt, lead_id FROM token_refunds
    WHERE org_id = ${orgId} AND mode = 'RAZORPAY' AND state = 'REQUESTED' AND created_at > now() - interval '30 days'
    ORDER BY created_at LIMIT 20`);
  let n = 0;
  for (const r of due) {
    if (!r.provider_refund_id) {
      if ((await issueRefund(orgId, r.id)) !== "WAITING") n += 1;
      continue;
    }
    const account = await paymentToken(orgId);
    const got = account ? await payments().findRefund(account.token, r.provider_payment_id, r.receipt).catch(() => null) : null;
    const state = got ? refundStateOf(got.status) : "REQUESTED";
    if (state === "REQUESTED") continue;
    await withTenant(orgId, async (sql) => {
      await sql`UPDATE token_refunds SET state = ${state}, processed_at = ${state === "PROCESSED" ? sql`now()` : null}, updated_at = now()
                WHERE org_id = ${orgId} AND id = ${r.id} AND state = 'REQUESTED'`;
      if (state === "FAILED") {
        await sql`UPDATE leads SET needs_person = 'Razorpay did not refund the token. Refund it another way and record it', updated_at = now()
                  WHERE org_id = ${orgId} AND id = ${r.lead_id}`;
      }
    });
    n += 1;
  }
  return n;
}

/**
 * Razorpay says a refund on the developer's own account was processed or
 * failed. The row it names, or the one asked under that payment and the
 * quote's receipt, moves once (`refundEventMove()`); a failure flags the
 * lead for a person, as the sweep's own failure does. Safe to receive twice.
 */
export async function onRefundEvent(orgId: string, ev: RefundEvent): Promise<"PROCESSED" | "FAILED" | "IGNORED"> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; lead_id: string; state: RefundState; provider_refund_id: string | null; provider_payment_id: string | null; receipt: string; amount: number }[]>`
    SELECT id, lead_id, state, provider_refund_id, provider_payment_id, receipt, amount::float8 AS amount FROM token_refunds
    WHERE org_id = ${orgId} AND mode = 'RAZORPAY'
      AND (provider_refund_id = ${ev.refundId} OR (provider_refund_id IS NULL AND provider_payment_id = ${ev.paymentId ?? ""}))
    LIMIT 2`);
  for (const r of rows) {
    const move = refundEventMove(
      { state: r.state, providerRefundId: r.provider_refund_id, providerPaymentId: r.provider_payment_id, receipt: r.receipt, amountPaise: Math.round(r.amount * 100) },
      ev,
    );
    if (!move) continue;
    const done = await withTenant(orgId, async (sql) => {
      const u = await sql`
        UPDATE token_refunds
        SET state = ${move.to}, updated_at = now(),
            provider_refund_id = ${move.setId ? ev.refundId : r.provider_refund_id},
            processed_at = ${move.to === "PROCESSED" ? sql`now()` : null},
            last_error = ${move.to === "FAILED" ? "Razorpay said the refund failed" : null}
        WHERE org_id = ${orgId} AND id = ${r.id} AND state = ${r.state}`;
      if (u.count && move.to === "FAILED") {
        await sql`UPDATE leads SET needs_person = 'Razorpay did not refund the token. Refund it another way and record it', updated_at = now()
                  WHERE org_id = ${orgId} AND id = ${r.lead_id}`;
      }
      return u.count > 0;
    });
    if (!done) return "IGNORED";
    await audit({ orgId, actorUserId: null, action: move.to === "PROCESSED" ? "quote.refund_processed" : "quote.refund_failed", targetType: "token_refund", targetId: r.id, metadata: { via: "webhook" } });
    return move.to;
  }
  return "IGNORED";
}

export type WebhookAnswer = { status: 200 | 400 | 403; work: (() => Promise<void>) | null };

/**
 * Razorpay telling us about a developer's own account: a token link or a
 * refund. Proved by the HMAC over the raw bytes, stored once per
 * `x-razorpay-event-id` in the tenant the account names, and answered at
 * once; `work` is what runs after the answer (the route hands it to
 * `after()`, and `sweepQuotes()` works any it did not).
 */
export async function receivePaymentWebhook(raw: string, signature: string | null, eventId: string | null): Promise<WebhookAnswer> {
  if (!webhookValid(raw, signature, process.env.RAZORPAY_PARTNER_WEBHOOK_SECRET ?? "")) return { status: 403, work: null };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, work: null };
  }
  const link = readLinkEvent(body);
  const refund = link ? null : readRefundEvent(body);
  const accountId = link?.accountId ?? refund?.accountId ?? null;
  if ((!link && !refund) || !accountId || !eventId) return { status: 200, work: null };
  const orgId = await ownerOfAccount(accountId);
  if (!orgId) return { status: 200, work: null };
  const [stored] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO payment_events (org_id, event_id, event, payload)
    VALUES (${orgId}, ${eventId.slice(0, 100)}, ${String((body as { event?: string }).event ?? "").slice(0, 60)}, ${sql.json(body as never)})
    ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`);
  if (!stored) return { status: 200, work: null };
  return {
    status: 200,
    work: async () => {
      if (link) await onLinkEvent(orgId, link);
      if (refund) await onRefundEvent(orgId, refund);
      await withTenant(orgId, (sql) => sql`UPDATE payment_events SET processed_at = now() WHERE org_id = ${orgId} AND id = ${stored.id}`);
    },
  };
}

/** Somebody paid an owed refund back by cheque or transfer, or another way after Razorpay failed. */
export async function recordRefundPaid(o: { orgId: string; userId: string; authz: Authz; quoteId: string; reference: string }): Promise<QuoteResult> {
  const q = await quoteRow(o.orgId, o.quoteId);
  if (!q) return { ok: false, message: "That quote no longer exists." };
  if (!o.authz.canAt("quote:approve", q.path)) return { ok: false, message: "You cannot record refunds here." };
  const ref = offlineReference("CHEQUE", o.reference) ?? offlineReference("TRANSFER", o.reference);
  if (!ref) return { ok: false, message: "Enter the cheque's 6-digit number or the transfer's UTR." };
  const r = await withTenant(o.orgId, (sql) => sql`
    UPDATE token_refunds SET state = 'PROCESSED', paid_reference = ${ref}, processed_at = now(), updated_at = now()
    WHERE org_id = ${o.orgId} AND quote_id = ${q.id} AND state IN ('DUE', 'FAILED')`);
  if (!r.count) return { ok: false, message: "No refund is owed on this quote." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "quote.refund_recorded", targetType: "quote", targetId: q.id });
  return { ok: true, quoteId: q.id, message: "Refund recorded as paid." };
}

// ---------------------------------------------------------------------------
// The quote as a PDF
// ---------------------------------------------------------------------------

/**
 * An approved quote's PDF, drawn from its stored row: the numbers the
 * approver saw and the names recorded at drafting. A quote drafted before
 * those names were recorded reads them from the tree. Null for a quote
 * nobody approved, or one on another lead.
 */
export async function quotePdf(orgId: string, leadId: string, quoteId: string): Promise<{ ref: string; bytes: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(quoteId)) return null;
  const [r] = await withTenant(orgId, (sql) => sql<{
    id: string; state: QuoteState; unit_no: string; price: number; extras: number; extra_lines: ExtraLine[]; charge_lines: ChargeLine[]; gst_rate: string; gst: number;
    duty_rate: string; stamp_duty: number; registration: number; all_in: number; token: number;
    tax_row: { label: string; source: string; readOn?: string; woman?: string }; approved_at: Date | null; registration_no: string | null;
    parties: Parties | null; buyer: string; config: string; variant: string | null; tower: string; project: string | null;
    developer: string;
  }[]>`
    SELECT q.id, q.state, q.unit_no, q.price::float8 AS price, q.extras::float8 AS extras, q.extra_lines, q.charge_lines, q.gst_rate::text, q.gst::float8 AS gst,
           q.duty_rate::text, q.stamp_duty::float8 AS stamp_duty, q.registration::float8 AS registration, q.all_in::float8 AS all_in,
           q.token::float8 AS token, q.tax_row, q.approved_at, q.registration_no, q.parties, l.name AS buyer,
           t.config, t.variant, n.name AS tower, p.name AS project, o.legal_name AS developer
    FROM quotes q JOIN leads l ON l.id = q.lead_id JOIN unit_types t ON t.id = q.unit_type_id
    JOIN scope_nodes n ON n.id = q.scope_node_id LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
    JOIN orgs o ON o.id = q.org_id
    WHERE q.org_id = ${orgId} AND q.id = ${quoteId} AND q.lead_id = ${leadId}`);
  if (!r || !r.approved_at) return null;
  const who = r.parties;
  const doc: QuoteDoc = {
    id: r.id,
    developer: who?.developer ?? r.developer,
    promoter: who?.promoter ?? null,
    project: who ? who.project : r.project,
    tower: who?.tower ?? r.tower,
    unitNo: r.unit_no,
    unitLabel: who?.unitLabel ?? (r.variant ? `${r.config} ${r.variant}` : r.config),
    carpetSqft: who?.carpetSqft ?? null,
    registrationNo: r.registration_no,
    buyer: r.buyer || "Buyer",
    price: r.price,
    extras: r.extra_lines,
    charges: r.charge_lines ?? [],
    gstRate: Number(r.gst_rate),
    gst: r.gst,
    dutyRate: Number(r.duty_rate),
    stampDuty: r.stamp_duty,
    registration: r.registration,
    allIn: r.all_in,
    token: r.token,
    taxLabel: r.tax_row.label,
    taxSource: r.tax_row.source,
    taxReadOn: r.tax_row.readOn ?? null,
    woman: r.tax_row.woman ?? null,
    approvedAt: r.approved_at.toISOString(),
    cancelled: r.state === "CANCELLED",
  };
  return { ref: r.id, bytes: renderQuote(doc) };
}

/**
 * The quotes' clock, every worker pass: a block whose 48 hours ran out lets
 * its flat go and its link is cancelled; a reservation the gateway never
 * answered is void; and a link on a tower that stopped being advertisable
 * is cancelled, because a token may not be asked for on it.
 */
export async function sweepQuotes(orgId: string, nowIso = new Date().toISOString()): Promise<number> {
  const now = new Date(nowIso);
  // A webhook stored but not worked (the function ended first) is worked here.
  const waiting = await withTenant(orgId, (sql) => sql<{ id: string; payload: unknown }[]>`
    SELECT id, payload FROM payment_events
    WHERE org_id = ${orgId} AND processed_at IS NULL AND received_at < now() - interval '1 minute'
    ORDER BY received_at LIMIT 50`);
  for (const e of waiting) {
    const ev = readLinkEvent(e.payload);
    if (ev) await onLinkEvent(orgId, ev);
    const refund = readRefundEvent(e.payload);
    if (refund) await onRefundEvent(orgId, refund);
    await withTenant(orgId, (sql) => sql`UPDATE payment_events SET processed_at = now() WHERE org_id = ${orgId} AND id = ${e.id}`);
  }
  // A paid hold whose seven days ran out with no agreement lets the flat go.
  const lapsed = await withTenant(orgId, (sql) => sql<{ lead_id: string; unit_no: string }[]>`
    UPDATE unit_blocks SET state = 'RELEASED', released_at = now(), reason = 'No agreement within 7 days of the token'
    WHERE org_id = ${orgId} AND state = 'TOKEN_PAID' AND expires_at <= ${now}
    RETURNING lead_id, unit_no`);
  for (const l of lapsed) {
    await withTenant(orgId, (sql) => sql`
      UPDATE leads SET needs_person = ${`The hold on ${l.unit_no} ended: no agreement 7 days after the token. Book it again or refund`.slice(0, 200)},
             updated_at = now()
      WHERE org_id = ${orgId} AND id = ${l.lead_id}`);
    await audit({ orgId, actorUserId: null, action: "quote.hold_ended", targetType: "lead", targetId: l.lead_id });
  }
  // A token paid in part whose hold ran out before the rest came: every part goes back.
  const short = await withTenant(orgId, (sql) => sql<{ id: string; lead_id: string }[]>`
    SELECT q.id, q.lead_id FROM quotes q
    CROSS JOIN LATERAL (SELECT
      coalesce((SELECT sum(p.amount_paise) / 100 FROM payment_links p WHERE p.quote_id = q.id AND p.status = 'PAID'), 0)
      + coalesce((SELECT sum(t.amount) FROM token_payments t WHERE t.quote_id = q.id), 0) AS total) paid
    WHERE q.org_id = ${orgId} AND q.state = 'SENT'
      AND paid.total > 0 AND paid.total < q.token
      AND NOT EXISTS (SELECT 1 FROM unit_blocks b WHERE b.quote_id = q.id AND b.state IN ('TOKEN_PAID', 'CONVERTED'))
      AND NOT EXISTS (SELECT 1 FROM unit_blocks b WHERE b.quote_id = q.id AND b.state = 'PENDING_TOKEN' AND b.expires_at > ${now})
    LIMIT 20`);
  for (const s of short) {
    const parts = await tokenParts(orgId, s.id);
    const out = await withTenant(orgId, (sql) => sql<{ provider_id: string | null }[]>`
      UPDATE payment_links SET status = 'CANCELLED', updated_at = now()
      WHERE org_id = ${orgId} AND quote_id = ${s.id} AND status IN ('CREATING', 'CREATED') RETURNING provider_id`);
    const account = out.length ? await paymentToken(orgId) : null;
    for (const l of out) if (account && l.provider_id) await payments().cancelLink(account.token, l.provider_id).catch(() => undefined);
    await giveBack({ orgId, quoteId: s.id, leadId: s.lead_id, parts, why: "The hold on the flat ended." });
    await withTenant(orgId, (sql) => sql`
      UPDATE leads SET needs_person = 'Only part of the token came in before the hold ended. The parts paid are being refunded.', updated_at = now()
      WHERE org_id = ${orgId} AND id = ${s.lead_id}`);
  }
  const refunded = await sweepRefunds(orgId) + short.length;

  const due = await withTenant(orgId, (sql) => sql<{ id: string; block_id: string; quote_id: string; status: string; provider_id: string | null; reference: string; expires_at: Date; created_at: Date; scope_node_id: string; lead_id: string }[]>`
    SELECT p.id, p.block_id, p.quote_id, p.status, p.provider_id, p.reference, p.expires_at, p.created_at, q.scope_node_id, q.lead_id
    FROM payment_links p JOIN quotes q ON q.id = p.quote_id
    WHERE p.org_id = ${orgId} AND p.status IN ('CREATING', 'CREATED')`);
  if (!due.length) return lapsed.length + refunded;
  const token = await paymentToken(orgId);
  let n = 0;
  for (const l of due) {
    const stale = l.status === "CREATING" && now.getTime() - l.created_at.getTime() > RESERVE_MINUTES * 60_000;
    const expired = l.expires_at.getTime() <= now.getTime();
    const stopped = l.status === "CREATED" && !(await canPublish(orgId, l.scope_node_id)).ok;
    if (!stale && !expired && !stopped) continue;
    // Whatever the gateway made under this reference is cancelled with it.
    if (token) {
      const found = l.provider_id ? { id: l.provider_id } : await payments().findLink(token.token, l.reference).catch(() => null);
      if (found) await payments().cancelLink(token.token, found.id).catch(() => undefined);
    }
    await releaseLink(orgId, l.id, l.block_id, l.quote_id, stale ? "VOID" : expired ? "EXPIRED" : "CANCELLED",
      stale ? "The token link was never made" : expired ? "The token link expired" : "The tower may not be advertised now");
    if (stopped) {
      await withTenant(orgId, (sql) => sql`
        UPDATE leads SET needs_person = 'The token link was cancelled: the tower may not be advertised now', updated_at = now()
        WHERE org_id = ${orgId} AND id = ${l.lead_id}`);
    }
    n += 1;
  }
  return n + lapsed.length + refunded;
}

/** The agreement is registered: the flat is the buyer's, and the CRM keeps it from here. */
export async function convertBlocks(orgId: string, leadId: string): Promise<number> {
  const r = await withTenant(orgId, (sql) => sql`
    UPDATE unit_blocks SET state = 'CONVERTED' WHERE org_id = ${orgId} AND lead_id = ${leadId} AND state = 'TOKEN_PAID'`);
  return r.count;
}

/** The booking was undone: whatever the buyer held is let go. */
export async function releaseBlocks(orgId: string, leadId: string, reason: string): Promise<number> {
  const r = await withTenant(orgId, (sql) => sql<{ paid: boolean }[]>`
    UPDATE unit_blocks b SET state = 'RELEASED', released_at = now(), reason = ${reason.slice(0, 200)}
    FROM unit_blocks old
    WHERE old.id = b.id AND b.org_id = ${orgId} AND b.lead_id = ${leadId} AND b.state IN ('PENDING_TOKEN', 'TOKEN_PAID')
    RETURNING old.state = 'TOKEN_PAID' AS paid`);
  // A paid token let go with the booking is money the buyer is owed: the
  // quote's "Cancel token" records what is given back.
  if (r.some((x) => x.paid)) {
    await withTenant(orgId, (sql) => sql`
      UPDATE leads SET needs_person = 'The booking was cancelled with its token paid. Cancel the token on the quote to record the refund', updated_at = now()
      WHERE org_id = ${orgId} AND id = ${leadId}`);
  }
  return r.length;
}

export type QuoteView = {
  id: string;
  state: QuoteState;
  unitNo: string;
  unitLabel: string;
  price: number;
  extras: ExtraLine[];
  /** Parking, club, the maintenance deposit and legal charges. */
  charges: ChargeLine[];
  agreement: number;
  woman: string | null;
  gstRate: number;
  gst: number;
  dutyRate: number;
  stampDuty: number;
  registration: number;
  allIn: number;
  token: number;
  /** The section 194-IA line, when the agreement value is Rs 50 lakh or more. */
  tds: string | null;
  taxSource: string;
  createdAt: string;
  approved: boolean;
  link: { status: string; url: string | null; expiresAt: string; paidAt: string | null; amount: number } | null;
  /** What has been paid towards the token, part by part, oldest first. */
  parts: { by: "RAZORPAY" | OfflineMode; amount: number; on: string }[];
  paid: number;
  /** Until when the flat is held, while it is. */
  heldUntil: string | null;
  /** Every refund on the quote, added up; the state is the one that most needs a person. */
  refund: { amount: number; mode: RefundMode; state: RefundState } | null;
};

const REFUND_RANK: Record<RefundState, number> = { FAILED: 0, DUE: 1, REQUESTED: 2, PROCESSED: 3 };

/** A lead's quotes, newest first, for its page. */
export async function listQuotes(orgId: string, leadId: string): Promise<QuoteView[]> {
  const rows = await withTenant(orgId, (sql) => sql<{
    id: string; state: QuoteState; unit_no: string; config: string; variant: string | null; price: string; extras: string; extra_lines: ExtraLine[];
    charge_lines: ChargeLine[]; woman_buyer: boolean; gst_rate: string; gst: string; duty_rate: string; stamp_duty: string; registration: string;
    all_in: string; token: string; tax_row: { label: string; source: string; woman?: string }; created_at: Date; approved_at: Date | null;
    l_status: string | null; short_url: string | null; l_expires: Date | null; paid_at: Date | null; l_amount: string | null;
    parts: { by: "RAZORPAY" | OfflineMode; amount: number; day: string }[] | null;
    refunds: { amount: number; mode: RefundMode; state: RefundState }[] | null;
    held_until: Date | null;
  }[]>`
    SELECT q.id, q.state, q.unit_no, t.config, t.variant, q.price::text, q.extras::text, q.extra_lines, q.charge_lines, q.woman_buyer,
           q.gst_rate::text, q.gst::text, q.duty_rate::text, q.stamp_duty::text, q.registration::text, q.all_in::text, q.token::text,
           q.tax_row, q.created_at, q.approved_at,
           p.status AS l_status, p.short_url, p.expires_at AS l_expires, p.paid_at, (p.amount_paise / 100)::text AS l_amount,
           (SELECT jsonb_agg(x ORDER BY x.at) FROM (
              SELECT 'RAZORPAY' AS by, (pl.amount_paise / 100)::float8 AS amount, (pl.paid_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, pl.paid_at AS at
              FROM payment_links pl WHERE pl.quote_id = q.id AND pl.status = 'PAID'
              UNION ALL
              SELECT tp.mode, tp.amount::float8, tp.paid_on::text, tp.recorded_at FROM token_payments tp WHERE tp.quote_id = q.id) x) AS parts,
           (SELECT jsonb_agg(jsonb_build_object('amount', r.amount::float8, 'mode', r.mode, 'state', r.state) ORDER BY r.created_at)
              FROM token_refunds r WHERE r.quote_id = q.id) AS refunds,
           (SELECT max(b.expires_at) FROM unit_blocks b WHERE b.quote_id = q.id AND b.state IN ('PENDING_TOKEN', 'TOKEN_PAID') AND b.expires_at > now()) AS held_until
    FROM quotes q JOIN unit_types t ON t.id = q.unit_type_id
    LEFT JOIN LATERAL (SELECT * FROM payment_links x WHERE x.quote_id = q.id ORDER BY x.created_at DESC LIMIT 1) p ON true
    WHERE q.org_id = ${orgId} AND q.lead_id = ${leadId}
    ORDER BY q.created_at DESC LIMIT 10`);
  return rows.map((r) => {
    const parts = (r.parts ?? []).map((x) => ({ by: x.by, amount: Number(x.amount), on: x.day }));
    const refunds = r.refunds ?? [];
    const agreement = Number(r.price) + Number(r.extras);
    return {
      id: r.id,
      state: r.state,
      unitNo: r.unit_no,
      unitLabel: r.variant ? `${r.config} ${r.variant}` : r.config,
      price: Number(r.price),
      extras: r.extra_lines,
      charges: r.charge_lines ?? [],
      agreement,
      woman: r.woman_buyer ? (r.tax_row.woman ?? "Concession for a woman buyer") : null,
      gstRate: Number(r.gst_rate),
      gst: Number(r.gst),
      dutyRate: Number(r.duty_rate),
      stampDuty: Number(r.stamp_duty),
      registration: Number(r.registration),
      allIn: Number(r.all_in),
      token: Number(r.token),
      tds: tdsNote(agreement),
      taxSource: `${r.tax_row.label}: ${r.tax_row.source}`,
      createdAt: r.created_at.toISOString(),
      approved: !!r.approved_at,
      link: r.l_status
        ? { status: r.l_status, url: r.short_url, expiresAt: r.l_expires!.toISOString(), paidAt: r.paid_at?.toISOString() ?? null, amount: Number(r.l_amount) }
        : null,
      parts,
      paid: parts.reduce((n, x) => n + x.amount, 0),
      heldUntil: r.held_until?.toISOString() ?? null,
      refund: refunds.length
        ? {
            amount: refunds.reduce((n, x) => n + Number(x.amount), 0),
            mode: refunds[0].mode,
            state: [...refunds].sort((a, b) => REFUND_RANK[a.state] - REFUND_RANK[b.state])[0].state,
          }
        : null,
    };
  });
}

/**
 * What may be quoted at a lead's tower: approved configurations, the flats
 * still available, and the concession a woman buying alone gets there, when
 * the verified tax row records one.
 */
export async function quoteChoices(orgId: string, leadId: string): Promise<{ units: { id: string; label: string }[]; flats: { unitNo: string; unitTypeId: string | null }[]; woman: string | null }> {
  const [lead] = await withTenant(orgId, (sql) => sql<{ scope_node_id: string; state_code: string | null; city: string | null }[]>`
    SELECT l.scope_node_id, rr.state_code, r.name AS city
    FROM leads l JOIN scope_nodes ph ON ph.id = l.scope_node_id
    LEFT JOIN scope_nodes p ON p.id = ph.parent_id
    LEFT JOIN scope_nodes r ON r.id = p.parent_id AND r.kind = 'REGION'
    LEFT JOIN registration_records rr ON rr.scope_node_id = l.scope_node_id
    WHERE l.org_id = ${orgId} AND l.id = ${leadId}`);
  if (!lead) return { units: [], flats: [], woman: null };
  const [{ units }, flats] = await Promise.all([
    approvedUnits(orgId, lead.scope_node_id).catch(() => ({ units: [] })),
    // Available, and not held for anybody else.
    withTenant(orgId, (sql) => sql<{ unit_no: string; unit_type_id: string | null }[]>`
      SELECT u.unit_no, u.unit_type_id FROM units u
      WHERE u.org_id = ${orgId} AND u.scope_node_id = ${lead.scope_node_id} AND u.status = 'AVAILABLE'
        AND NOT EXISTS (
          SELECT 1 FROM unit_blocks b
          WHERE b.org_id = u.org_id AND b.scope_node_id = u.scope_node_id
            AND b.unit_no = upper(regexp_replace(btrim(u.unit_no), '[[:space:]]+', ' ', 'g'))
            AND b.state IN ('PENDING_TOKEN', 'TOKEN_PAID') AND b.expires_at > now() AND b.lead_id <> ${leadId})
      ORDER BY u.unit_no LIMIT 400`),
  ]);
  return {
    units: units.filter((u) => gstForKind(u.config).ok).map((u) => ({ id: u.id, label: u.label })),
    flats: flats.map((f) => ({ unitNo: f.unit_no, unitTypeId: f.unit_type_id })),
    woman: womanConcession(lead.state_code, lead.city),
  };
}
