import { audit, auditHash, withTenant } from "./db/index.ts";
import { send } from "./mailer.ts";
import { normalisePhone } from "./calling-rules.ts";
import { istDate } from "./calling-hours.ts";
import {
  BROKERAGE_SAC,
  ENDING_SOON_DAYS,
  UNPAID_LATE_DAYS,
  brokerageOf,
  daysFrom,
  invoiceAmounts,
  invoiceDescription,
  invoiceRefusal,
  invoiceYear,
  outsideInvoiceNumber,
  outsideState,
  readRupees,
  readRate,
  readSetup,
  registrationEmail,
  registrationEnds,
  renderOutsideInvoice,
  shownPhone,
  type DeveloperSetup,
  type InvoiceParty,
  type OutsideState,
} from "./outside-rules.ts";
import type { QueueItem } from "./queue.ts";

/**
 * A channel partner's buyers and brokerage with developers not on
 * Sales Desk, read and written in its own tenant (`outside-rules.ts` holds
 * the rules). Registering a buyer emails the developer from here, in the
 * partner's name, with the partner's own people copied and replied to; a
 * booking owes the partner its brokerage; its invoice is the partner's own,
 * numbered gaplessly in its own series and drawn from the stored row.
 */

const ID = /^[0-9a-f-]{36}$/i;
type Sql = Parameters<Parameters<typeof withTenant>[1]>[0];

export type Result = { ok: true; message: string } | { ok: false; message: string; errors?: Record<string, string> };

// ---------------------------------------------------------------------------
// The developers
// ---------------------------------------------------------------------------

export type OutsideDeveloper = {
  entityId: string;
  name: string;
  projects: { id: string; name: string }[];
  setup: DeveloperSetup | null;
};

/**
 * The developers the partner added itself, each with its projects and where
 * it takes registrations. A developer whose projects were added from
 * Sales Desk is not one of them: its buyers and brokerage are the
 * developer's own desk's.
 */
export async function outsideDevelopers(orgId: string): Promise<OutsideDeveloper[]> {
  return withTenant(orgId, async (sql) => {
    const rows = await sql<{ id: string; name: string; project_id: string | null; project: string | null; linked: boolean }[]>`
      SELECT e.id, e.name, p.id AS project_id, p.name AS project,
             EXISTS (SELECT 1 FROM linked_nodes l JOIN scope_nodes ln ON ln.id = l.scope_node_id
                      WHERE l.org_id = e.org_id AND ln.path <@ e.path) AS linked
      FROM scope_nodes e
      LEFT JOIN scope_nodes p ON p.org_id = e.org_id AND p.kind = 'PROJECT' AND p.path <@ e.path
      WHERE e.org_id = ${orgId} AND e.kind = 'ENTITY'
      ORDER BY e.name, p.name`;
    const setups = await sql<{ entity_id: string; reg_email: string; reg_cc: string[]; validity_days: number; rate_bp: number; gstin: string | null; bill_address: string | null; state_code: string | null }[]>`
      SELECT entity_id, reg_email, reg_cc, validity_days, rate_bp, gstin, bill_address, state_code FROM outside_developers WHERE org_id = ${orgId}`;
    const byEntity = new Map(setups.map((s) => [s.entity_id, s]));
    const out = new Map<string, OutsideDeveloper>();
    for (const r of rows) {
      if (r.linked) continue;
      const d = out.get(r.id) ?? {
        entityId: r.id,
        name: r.name,
        projects: [],
        setup: (() => {
          const s = byEntity.get(r.id);
          return s
            ? { regEmail: s.reg_email, regCc: s.reg_cc, validityDays: s.validity_days, rateBp: s.rate_bp, gstin: s.gstin, billAddress: s.bill_address, stateCode: s.state_code }
            : null;
        })(),
      };
      if (r.project_id && r.project) d.projects.push({ id: r.project_id, name: r.project });
      out.set(r.id, d);
    }
    return [...out.values()];
  });
}

/** Where a developer takes registrations, and its billing details, saved by `org:manage`. */
export async function saveSetup(o: { orgId: string; userId: string; entityId: string; raw: Record<string, unknown> }): Promise<Result> {
  if (!ID.test(o.entityId)) return { ok: false, message: "Choose a developer." };
  const read = readSetup(o.raw);
  if (!read.ok) return { ok: false, message: "Check the highlighted fields.", errors: read.errors };
  const s = read.setup;
  const saved = await withTenant(o.orgId, async (sql) => {
    const [e] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.entityId} AND kind = 'ENTITY'`;
    if (!e) return false;
    await sql`
      INSERT INTO outside_developers (entity_id, org_id, reg_email, reg_cc, validity_days, rate_bp, gstin, bill_address, state_code, updated_by)
      VALUES (${e.id}, ${o.orgId}, ${s.regEmail}, ${s.regCc}, ${s.validityDays}, ${s.rateBp}, ${s.gstin}, ${s.billAddress}, ${s.stateCode}, ${o.userId})
      ON CONFLICT (entity_id) DO UPDATE SET reg_email = EXCLUDED.reg_email, reg_cc = EXCLUDED.reg_cc, validity_days = EXCLUDED.validity_days,
        rate_bp = EXCLUDED.rate_bp, gstin = EXCLUDED.gstin, bill_address = EXCLUDED.bill_address, state_code = EXCLUDED.state_code,
        updated_by = EXCLUDED.updated_by, updated_at = now()`;
    return true;
  });
  if (!saved) return { ok: false, message: "That developer is not here." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "partner.outside_setup", targetType: "scope_node", targetId: o.entityId, metadata: { email: auditHash(s.regEmail), cc: s.regCc.length, days: s.validityDays, rate_bp: s.rateBp } });
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
// Registering a buyer
// ---------------------------------------------------------------------------

/** A project of a developer the partner added itself, with that developer's setup. */
async function projectWithSetup(sql: Sql, orgId: string, projectId: string) {
  const [p] = await sql<{ id: string; name: string; path: string; entity_id: string; developer: string; reg_email: string | null; reg_cc: string[] | null; validity_days: number | null; rate_bp: number | null }[]>`
    SELECT p.id, p.name, p.path::text AS path, e.id AS entity_id, e.name AS developer,
           d.reg_email, d.reg_cc, d.validity_days, d.rate_bp
    FROM scope_nodes p
    JOIN scope_nodes e ON e.org_id = p.org_id AND e.kind = 'ENTITY' AND e.path @> p.path
    LEFT JOIN outside_developers d ON d.entity_id = e.id
    WHERE p.org_id = ${orgId} AND p.id = ${projectId} AND p.kind = 'PROJECT'`;
  return p ?? null;
}

/**
 * Register a buyer with a developer that is not on Sales Desk: emailed to
 * the address the developer takes registrations on, the partner's own
 * person copied and replied to, and held for the developer's days from
 * today. A number already registered for the project and still live is the
 * same registration, never a second email.
 */
export async function registerOutside(o: {
  orgId: string;
  userId: string;
  projectId: string;
  name: string;
  phone: string;
  leadId?: string | null;
  nowIso?: string;
  mayRegisterAt: (path: string) => boolean;
}): Promise<Result> {
  if (!ID.test(o.projectId)) return { ok: false, message: "Choose a project." };
  const name = o.name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) return { ok: false, message: "Enter the buyer's name." };
  const phone = normalisePhone(o.phone);
  if (!phone) return { ok: false, message: "Enter the buyer's 10-digit mobile number." };
  const today = istDate(o.nowIso ?? new Date().toISOString());

  const prepared = await withTenant(o.orgId, async (sql) => {
    const p = await projectWithSetup(sql, o.orgId, o.projectId);
    if (!p) return { ok: false as const, message: "Choose a project." };
    if (!o.mayRegisterAt(p.path)) return { ok: false as const, message: "Your role cannot register buyers on this project." };
    if (!p.reg_email || !p.validity_days) return { ok: false as const, message: `Add the email ${p.developer} takes registrations on first.` };
    const [live] = await sql<{ id: string; valid_until: string }[]>`
      SELECT id, valid_until::text FROM outside_registrations
      WHERE org_id = ${o.orgId} AND project_id = ${p.id} AND phone = ${phone} AND status IN ('SENT', 'CONFIRMED')
        AND valid_until >= ${today}::date`;
    if (live) return { ok: false as const, message: `Already registered for ${p.name}, until ${live.valid_until}.` };
    const [org] = await sql<{ display_name: string; legal_name: string; agent_no: string | null }[]>`
      SELECT o.display_name, o.legal_name, f.rera_agent_no AS agent_no FROM orgs o LEFT JOIN firm_profiles f ON f.org_id = o.id WHERE o.id = ${o.orgId}`;
    const [me] = await sql<{ name: string | null; email: string | null; phone: string | null }[]>`
      SELECT name, email::text AS email, CASE WHEN phone_verified_at IS NOT NULL THEN phone END AS phone FROM users WHERE id = ${o.userId}`;
    const [lead] = o.leadId && ID.test(o.leadId)
      ? await sql<{ id: string }[]>`SELECT id FROM leads WHERE org_id = ${o.orgId} AND id = ${o.leadId}`
      : await sql<{ id: string }[]>`
          SELECT l.id FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
          WHERE l.org_id = ${o.orgId} AND l.phone = ${phone} AND n.path <@ ${p.path}::ltree
          ORDER BY l.last_activity_at DESC LIMIT 1`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO outside_registrations (org_id, entity_id, project_id, lead_id, buyer_name, phone, valid_until, created_by)
      VALUES (${o.orgId}, ${p.entity_id}, ${p.id}, ${lead?.id ?? null}, ${name}, ${phone}, ${registrationEnds(today, p.validity_days)}, ${o.userId})
      RETURNING id`;
    return { ok: true as const, id: row.id, p, org, me: me ?? { name: null, email: null, phone: null }, leadId: lead?.id ?? null };
  }).catch((e: { code?: string }) =>
    e?.code === "23505" ? { ok: false as const, message: "Already registered for this project." } : Promise.reject(e),
  );
  if (!prepared.ok) return prepared;

  const { p, org, me } = prepared;
  const mail = registrationEmail({
    developer: p.developer,
    project: p.name,
    buyer: name,
    phone,
    partner: org.display_name,
    partnerLegal: org.legal_name,
    agentNo: org.agent_no,
    sender: me,
    sentOn: today,
  });
  const cc = [...new Set([...(p.reg_cc ?? []), ...(me.email ? [me.email] : [])])].filter((c) => c !== p.reg_email);
  const sent = await send({ to: p.reg_email!, subject: mail.subject, text: mail.text, cc, replyTo: me.email ? [me.email] : undefined });
  await withTenant(o.orgId, (sql) => sql`
    UPDATE outside_registrations SET mail_id = ${sent.ok ? sent.messageId.slice(0, 200) || "sent" : null},
           mail_error = ${sent.ok ? null : sent.detail.slice(0, 300)}
    WHERE org_id = ${o.orgId} AND id = ${prepared.id}`);
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "partner.outside_registered",
    targetType: "outside_registration",
    targetId: prepared.id,
    metadata: { phone: auditHash(phone), to: auditHash(p.reg_email), sent: sent.ok, lead: !!prepared.leadId },
  });
  if (!sent.ok) {
    return { ok: false, message: `Recorded, but the email did not go: ${sent.detail} Send it to ${p.reg_email} yourself, or try again.` };
  }
  return { ok: true, message: `Emailed to ${p.reg_email}. Registered until ${registrationEnds(today, p.validity_days!)}.` };
}

/** Send a registration's email again: one that did not go, or one the developer did not answer. */
export async function resendOutside(o: { orgId: string; userId: string; id: string; nowIso?: string }): Promise<Result> {
  if (!ID.test(o.id)) return { ok: false, message: "That registration is not here." };
  const r = await withTenant(o.orgId, async (sql) => {
    const [row] = await sql<{ project_id: string; buyer_name: string | null; phone: string | null; status: string; sent_at: Date }[]>`
      SELECT project_id, buyer_name, phone, status, sent_at FROM outside_registrations WHERE org_id = ${o.orgId} AND id = ${o.id}`;
    if (!row || !row.phone || row.status !== "SENT") return null;
    const p = await projectWithSetup(sql, o.orgId, row.project_id);
    const [org] = await sql<{ display_name: string; legal_name: string; agent_no: string | null }[]>`
      SELECT o.display_name, o.legal_name, f.rera_agent_no AS agent_no FROM orgs o LEFT JOIN firm_profiles f ON f.org_id = o.id WHERE o.id = ${o.orgId}`;
    const [me] = await sql<{ name: string | null; email: string | null; phone: string | null }[]>`
      SELECT name, email::text AS email, CASE WHEN phone_verified_at IS NOT NULL THEN phone END AS phone FROM users WHERE id = ${o.userId}`;
    return p?.reg_email ? { row, p, org, me: me ?? { name: null, email: null, phone: null } } : null;
  });
  if (!r) return { ok: false, message: "Only a registration still waiting for the developer's answer is sent again." };
  const mail = registrationEmail({
    developer: r.p.developer,
    project: r.p.name,
    buyer: r.row.buyer_name!,
    phone: r.row.phone!,
    partner: r.org.display_name,
    partnerLegal: r.org.legal_name,
    agentNo: r.org.agent_no,
    sender: r.me,
    sentOn: istDate(r.row.sent_at.toISOString()),
  });
  const cc = [...new Set([...(r.p.reg_cc ?? []), ...(r.me.email ? [r.me.email] : [])])].filter((c) => c !== r.p.reg_email);
  const sent = await send({ to: r.p.reg_email!, subject: mail.subject, text: mail.text, cc, replyTo: r.me.email ? [r.me.email] : undefined });
  await withTenant(o.orgId, (sql) => sql`
    UPDATE outside_registrations SET mail_id = ${sent.ok ? sent.messageId.slice(0, 200) || "sent" : null}, mail_error = ${sent.ok ? null : sent.detail.slice(0, 300)}
    WHERE org_id = ${o.orgId} AND id = ${o.id}`);
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "partner.outside_resent", targetType: "outside_registration", targetId: o.id, metadata: { sent: sent.ok } });
  return sent.ok ? { ok: true, message: `Emailed to ${r.p.reg_email} again.` } : { ok: false, message: `The email did not go: ${sent.detail}` };
}

/** What the developer answered, or the partner taking it back. Forward only: an answered registration is not answered again. */
export async function answerOutside(o: { orgId: string; userId: string; id: string; answer: "CONFIRMED" | "REFUSED" | "WITHDRAWN" }): Promise<Result> {
  if (!ID.test(o.id) || !["CONFIRMED", "REFUSED", "WITHDRAWN"].includes(o.answer)) return { ok: false, message: "That registration is not here." };
  const done = await withTenant(o.orgId, (sql) => sql`
    UPDATE outside_registrations SET status = ${o.answer}, answered_at = now()
    WHERE org_id = ${o.orgId} AND id = ${o.id}
      AND (status = 'SENT' OR (status = 'CONFIRMED' AND ${o.answer} = 'WITHDRAWN'))`);
  if (!done.count) return { ok: false, message: "That registration was already answered." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "partner.outside_answered", targetType: "outside_registration", targetId: o.id, metadata: { answer: o.answer } });
  return { ok: true, message: o.answer === "CONFIRMED" ? "Marked confirmed." : o.answer === "REFUSED" ? "Marked refused." : "Withdrawn." };
}

// ---------------------------------------------------------------------------
// Bookings and invoices
// ---------------------------------------------------------------------------

/**
 * A booking with a developer not on Sales Desk: from a registration, or
 * typed in with its project. The brokerage is the developer's rate on the
 * agreement value unless another is typed.
 */
export async function recordOutsideBooking(o: {
  orgId: string;
  userId: string;
  registrationId?: string | null;
  projectId?: string | null;
  buyerName?: string | null;
  unit: string;
  bookedOn: string;
  agreement: string;
  rate?: string | null;
  today?: string;
}): Promise<Result> {
  const agreement = readRupees(o.agreement);
  if (!agreement) return { ok: false, message: "Enter the agreement value, like 1,25,00,000 or 1.25 Cr." };
  const today = o.today ?? istDate(new Date().toISOString());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.bookedOn) || o.bookedOn > today) return { ok: false, message: "Enter the day it was booked, not after today." };
  const unit = o.unit.trim().slice(0, 40) || null;
  const typedRate = o.rate?.trim() ? readRate(o.rate) : null;
  if (o.rate?.trim() && typedRate === null) return { ok: false, message: "A brokerage rate between 0.01% and 10%." };

  const made = await withTenant(o.orgId, async (sql) => {
    let reg: { id: string; project_id: string; buyer_name: string | null; status: string } | null = null;
    if (o.registrationId) {
      if (!ID.test(o.registrationId)) return null;
      [reg] = await sql<{ id: string; project_id: string; buyer_name: string | null; status: string }[]>`
        SELECT id, project_id, buyer_name, status FROM outside_registrations WHERE org_id = ${o.orgId} AND id = ${o.registrationId}`;
      if (!reg || reg.status === "REFUSED" || reg.status === "WITHDRAWN") return null;
      const [had] = await sql`SELECT 1 FROM outside_bookings WHERE org_id = ${o.orgId} AND registration_id = ${reg.id} AND status = 'OWED'`;
      if (had) return "BOOKED" as const;
    }
    const projectId = reg?.project_id ?? o.projectId ?? "";
    if (!ID.test(projectId)) return null;
    const p = await projectWithSetup(sql, o.orgId, projectId);
    if (!p) return null;
    const rateBp = typedRate ?? p.rate_bp;
    if (!rateBp) return "NO_RATE" as const;
    const buyer = (reg?.buyer_name ?? o.buyerName ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO outside_bookings (org_id, registration_id, entity_id, project_id, buyer_name, unit, booked_on, agreement_paise, rate_bp, brokerage_paise, created_by)
      VALUES (${o.orgId}, ${reg?.id ?? null}, ${p.entity_id}, ${p.id}, ${buyer}, ${unit}, ${o.bookedOn}, ${agreement}, ${rateBp}, ${brokerageOf(agreement, rateBp)}, ${o.userId})
      RETURNING id`;
    return row.id;
  });
  if (made === null) return { ok: false, message: "Choose the registration or the project this booking is on." };
  if (made === "BOOKED") return { ok: false, message: "This buyer's booking is already recorded." };
  if (made === "NO_RATE") return { ok: false, message: "Enter the brokerage rate, or set the developer's rate first." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "partner.outside_booked", targetType: "outside_booking", targetId: made, metadata: { from_registration: !!o.registrationId } });
  return { ok: true, message: "Booking recorded." };
}

/** A booking that fell through, before it was invoiced. */
export async function cancelOutsideBooking(o: { orgId: string; userId: string; id: string }): Promise<Result> {
  if (!ID.test(o.id)) return { ok: false, message: "That booking is not here." };
  const done = await withTenant(o.orgId, (sql) => sql`
    UPDATE outside_bookings SET status = 'CANCELLED' WHERE org_id = ${o.orgId} AND id = ${o.id} AND status = 'OWED'
      AND NOT EXISTS (SELECT 1 FROM outside_invoices i WHERE i.org_id = ${o.orgId} AND i.booking_id = ${o.id})`);
  if (!done.count) return { ok: false, message: "An invoiced booking is not cancelled here." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "partner.outside_cancelled", targetType: "outside_booking", targetId: o.id, metadata: {} });
  return { ok: true, message: "Booking cancelled." };
}

/** Who issues the invoice: the partner's billing details, else its organisation's. */
async function sellerOf(sql: Sql, orgId: string): Promise<InvoiceParty & { agentNo: string | null }> {
  const [r] = await sql<{ legal_name: string; gstin: string | null; bill_name: string | null; bill_gstin: string | null; bill_address: string | null; bill_state: string | null; agent_no: string | null }[]>`
    SELECT o.legal_name, o.gstin, b.bill_name, b.bill_gstin, b.bill_address, b.bill_state, f.rera_agent_no AS agent_no
    FROM orgs o LEFT JOIN billing_accounts b ON b.org_id = o.id LEFT JOIN firm_profiles f ON f.org_id = o.id
    WHERE o.id = ${orgId}`;
  const gstin = r?.bill_gstin ?? r?.gstin ?? null;
  return {
    name: r?.bill_name ?? r?.legal_name ?? "",
    gstin,
    address: r?.bill_address ?? null,
    state: r?.bill_state ?? (gstin ? gstin.slice(0, 2) : null),
    agentNo: r?.agent_no ?? null,
  };
}

/**
 * The partner's own invoice for a booking's brokerage: numbered inside the
 * invoice's own transaction from its gapless counter, with who issued it and
 * to whom frozen on the row, so the PDF is drawn from what was issued.
 */
export async function makeOutsideInvoice(o: { orgId: string; userId: string; bookingId: string; today?: string }): Promise<Result & { invoiceId?: string }> {
  if (!ID.test(o.bookingId)) return { ok: false, message: "That booking is not here." };
  const today = o.today ?? istDate(new Date().toISOString());
  const out = await withTenant(o.orgId, async (sql) => {
    const [b] = await sql<{ id: string; status: string; project: string; developer: string; unit: string | null; booked_on: string; agreement_paise: string; rate_bp: number; brokerage_paise: string; gstin: string | null; bill_address: string | null; state_code: string | null; invoiced: boolean }[]>`
      SELECT b.id, b.status, p.name AS project, e.name AS developer, b.unit, b.booked_on::text, b.agreement_paise::text, b.rate_bp, b.brokerage_paise::text,
             d.gstin, d.bill_address, d.state_code,
             EXISTS (SELECT 1 FROM outside_invoices i WHERE i.org_id = b.org_id AND i.booking_id = b.id) AS invoiced
      FROM outside_bookings b
      JOIN scope_nodes p ON p.id = b.project_id
      JOIN scope_nodes e ON e.id = b.entity_id
      LEFT JOIN outside_developers d ON d.entity_id = b.entity_id
      WHERE b.org_id = ${o.orgId} AND b.id = ${o.bookingId}
      FOR UPDATE OF b`;
    if (!b) return { ok: false as const, message: "That booking is not here." };
    const seller = await sellerOf(sql, o.orgId);
    const buyer: InvoiceParty = { name: b.developer, gstin: b.gstin, address: b.bill_address, state: b.state_code ?? (b.gstin ? b.gstin.slice(0, 2) : null) };
    const refusal = invoiceRefusal({ seller, buyer, status: b.status, invoiced: b.invoiced });
    if (refusal) return { ok: false as const, message: refusal };
    const taxable = Number(b.brokerage_paise);
    const amounts = invoiceAmounts({ taxablePaise: taxable, seller, buyerState: buyer.state });
    const fy = invoiceYear(today);
    const [seq] = await sql<{ last: number }[]>`
      INSERT INTO outside_invoice_seq (org_id, fy, last) VALUES (${o.orgId}, ${fy}, 1)
      ON CONFLICT (org_id, fy) DO UPDATE SET last = outside_invoice_seq.last + 1
      RETURNING last`;
    const number = outsideInvoiceNumber(fy, seq.last);
    const [inv] = await sql<{ id: string }[]>`
      INSERT INTO outside_invoices (org_id, booking_id, number, fy, seq, issued_on, seller, buyer, place_of_supply, description, sac,
                                    taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, tds_paise, created_by)
      VALUES (${o.orgId}, ${b.id}, ${number}, ${fy}, ${seq.last}, ${today}, ${sql.json(seller as never)}, ${sql.json(buyer as never)},
              ${amounts.placeOfSupply}, ${invoiceDescription({ project: b.project, unit: b.unit, bookedOn: b.booked_on, agreementPaise: Number(b.agreement_paise), rateBp: b.rate_bp })},
              ${BROKERAGE_SAC}, ${taxable}, ${amounts.cgst}, ${amounts.sgst}, ${amounts.igst}, ${amounts.total}, ${amounts.tds}, ${o.userId})
      RETURNING id`;
    return { ok: true as const, id: inv.id, number };
  });
  if (!out.ok) return out;
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "partner.outside_invoiced", targetType: "outside_invoice", targetId: out.id, metadata: { number: out.number } });
  return { ok: true, message: `Invoice ${out.number} made.`, invoiceId: out.id };
}

/** The developer paid: the day, the amount and the bank's reference, recorded once. */
export async function recordInvoicePaid(o: { orgId: string; userId: string; invoiceId: string; paidOn: string; amount: string; utr: string; today?: string }): Promise<Result> {
  if (!ID.test(o.invoiceId)) return { ok: false, message: "That invoice is not here." };
  const today = o.today ?? istDate(new Date().toISOString());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.paidOn) || o.paidOn > today) return { ok: false, message: "Enter the day it was paid, not after today." };
  const paid = readRupees(o.amount);
  if (!paid) return { ok: false, message: "Enter the amount received." };
  const utr = o.utr.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{6,22}$/.test(utr)) return { ok: false, message: "Enter the bank's UTR or cheque number: 6 to 22 letters and digits." };
  const done = await withTenant(o.orgId, (sql) => sql`
    UPDATE outside_invoices SET paid_on = ${o.paidOn}, paid_paise = ${paid}, utr = ${utr}
    WHERE org_id = ${o.orgId} AND id = ${o.invoiceId} AND paid_on IS NULL AND ${o.paidOn}::date >= issued_on`);
  if (!done.count) return { ok: false, message: "This invoice's payment is already recorded, or the day is before the invoice." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "partner.outside_paid", targetType: "outside_invoice", targetId: o.invoiceId, metadata: { paise: paid } });
  return { ok: true, message: "Payment recorded." };
}

/** An invoice as a PDF, drawn from its stored row. */
export async function outsideInvoicePdf(orgId: string, invoiceId: string): Promise<{ pdf: Buffer; number: string } | null> {
  if (!ID.test(invoiceId)) return null;
  const [r] = await withTenant(orgId, (sql) => sql<{ number: string; issued_on: string; seller: InvoiceParty & { agentNo?: string | null }; buyer: InvoiceParty; place_of_supply: string; description: string; sac: string; taxable_paise: string; cgst_paise: string; sgst_paise: string; igst_paise: string; total_paise: string; tds_paise: string }[]>`
    SELECT number, issued_on::text, seller, buyer, place_of_supply, description, sac, taxable_paise::text, cgst_paise::text, sgst_paise::text,
           igst_paise::text, total_paise::text, tds_paise::text
    FROM outside_invoices WHERE org_id = ${orgId} AND id = ${invoiceId}`);
  if (!r) return null;
  return {
    number: r.number,
    pdf: renderOutsideInvoice({
      number: r.number,
      issuedOn: r.issued_on,
      seller: r.seller,
      buyer: r.buyer,
      placeOfSupply: r.place_of_supply,
      description: r.description,
      sac: r.sac,
      taxable: Number(r.taxable_paise),
      cgst: Number(r.cgst_paise),
      sgst: Number(r.sgst_paise),
      igst: Number(r.igst_paise),
      total: Number(r.total_paise),
      tds: Number(r.tds_paise),
    }),
  };
}

// ---------------------------------------------------------------------------
// The screens and Today
// ---------------------------------------------------------------------------

export type OutsideRegistration = {
  id: string;
  buyer: string;
  phone: string;
  project: string;
  developer: string;
  state: OutsideState;
  sentOn: string;
  validUntil: string;
  mailError: string | null;
  canAnswer: boolean;
  canBook: boolean;
};

export type OutsideBooking = {
  id: string;
  buyer: string | null;
  project: string;
  developer: string;
  unit: string | null;
  bookedOn: string;
  agreement: number;
  rateBp: number;
  brokerage: number;
  cancelled: boolean;
  invoice: { id: string; number: string; issuedOn: string; total: number; tds: number; paidOn: string | null; paid: number | null; utr: string | null } | null;
};

export async function outsideWork(orgId: string, today: string): Promise<{ registrations: OutsideRegistration[]; bookings: OutsideBooking[] }> {
  return withTenant(orgId, async (sql) => {
    const regs = await sql<{ id: string; buyer_name: string | null; phone: string | null; project: string; developer: string; status: string; sent_at: Date; valid_until: string; mail_error: string | null; booked: boolean }[]>`
      SELECT r.id, r.buyer_name, r.phone, p.name AS project, e.name AS developer, r.status, r.sent_at, r.valid_until::text, r.mail_error,
             EXISTS (SELECT 1 FROM outside_bookings b WHERE b.org_id = r.org_id AND b.registration_id = r.id AND b.status = 'OWED') AS booked
      FROM outside_registrations r JOIN scope_nodes p ON p.id = r.project_id JOIN scope_nodes e ON e.id = r.entity_id
      WHERE r.org_id = ${orgId}
      ORDER BY r.sent_at DESC LIMIT 300`;
    const books = await sql<{ id: string; buyer_name: string | null; project: string; developer: string; unit: string | null; booked_on: string; agreement_paise: string; rate_bp: number; brokerage_paise: string; status: string; inv_id: string | null; number: string | null; issued_on: string | null; total_paise: string | null; tds_paise: string | null; paid_on: string | null; paid_paise: string | null; utr: string | null }[]>`
      SELECT b.id, b.buyer_name, p.name AS project, e.name AS developer, b.unit, b.booked_on::text, b.agreement_paise::text, b.rate_bp, b.brokerage_paise::text, b.status,
             i.id AS inv_id, i.number, i.issued_on::text, i.total_paise::text, i.tds_paise::text, i.paid_on::text, i.paid_paise::text, i.utr
      FROM outside_bookings b JOIN scope_nodes p ON p.id = b.project_id JOIN scope_nodes e ON e.id = b.entity_id
      LEFT JOIN outside_invoices i ON i.org_id = b.org_id AND i.booking_id = b.id
      WHERE b.org_id = ${orgId}
      ORDER BY b.booked_on DESC LIMIT 300`;
    return {
      registrations: regs.map((r) => {
        const state = outsideState({ status: r.status, validUntil: r.valid_until, booked: r.booked, phone: r.phone }, today);
        return {
          id: r.id,
          buyer: r.buyer_name ?? "Erased",
          phone: shownPhone(r.phone),
          project: r.project,
          developer: r.developer,
          state,
          sentOn: istDate(r.sent_at.toISOString()),
          validUntil: r.valid_until,
          mailError: r.mail_error,
          canAnswer: r.status === "SENT" && r.phone !== null,
          canBook: ["sent", "confirmed", "ending"].includes(state),
        };
      }),
      bookings: books.map((b) => ({
        id: b.id,
        buyer: b.buyer_name,
        project: b.project,
        developer: b.developer,
        unit: b.unit,
        bookedOn: b.booked_on,
        agreement: Number(b.agreement_paise),
        rateBp: b.rate_bp,
        brokerage: Number(b.brokerage_paise),
        cancelled: b.status === "CANCELLED",
        invoice: b.inv_id
          ? { id: b.inv_id, number: b.number!, issuedOn: b.issued_on!, total: Number(b.total_paise), tds: Number(b.tds_paise), paidOn: b.paid_on, paid: b.paid_paise ? Number(b.paid_paise) : null, utr: b.utr }
          : null,
      })),
    };
  });
}

/** Today: registrations ending with nothing booked, emails that did not go, and invoices unpaid too long. Never fatal. */
export async function outsideQueue(orgId: string, nowIso = new Date().toISOString()): Promise<QueueItem[]> {
  try {
    const today = istDate(nowIso);
    const [c] = await withTenant(orgId, (sql) => sql<{ ending: number; unsent: number; unpaid: number; uninvoiced: number }[]>`
      SELECT
        (SELECT count(*)::int FROM outside_registrations r
          WHERE r.org_id = ${orgId} AND r.status IN ('SENT', 'CONFIRMED') AND r.phone IS NOT NULL
            AND r.valid_until BETWEEN ${today}::date AND ${today}::date + ${ENDING_SOON_DAYS}::int
            AND NOT EXISTS (SELECT 1 FROM outside_bookings b WHERE b.org_id = r.org_id AND b.registration_id = r.id AND b.status = 'OWED')) AS ending,
        (SELECT count(*)::int FROM outside_registrations r
          WHERE r.org_id = ${orgId} AND r.status = 'SENT' AND r.mail_error IS NOT NULL AND r.phone IS NOT NULL) AS unsent,
        (SELECT count(*)::int FROM outside_invoices i
          WHERE i.org_id = ${orgId} AND i.paid_on IS NULL AND i.issued_on < ${today}::date - ${UNPAID_LATE_DAYS}::int) AS unpaid,
        (SELECT count(*)::int FROM outside_bookings b
          WHERE b.org_id = ${orgId} AND b.status = 'OWED'
            AND NOT EXISTS (SELECT 1 FROM outside_invoices i WHERE i.org_id = b.org_id AND i.booking_id = b.id)) AS uninvoiced`);
    const items: QueueItem[] = [];
    if (c?.unsent) {
      items.push({ id: "outside-unsent", severity: "risk", title: `${c.unsent} ${c.unsent === 1 ? "registration was" : "registrations were"} not emailed`, why: "The developer has not received it, so the buyer is not yet yours with them.", action: "Send again", href: "/dashboard/developers/buyers", tag: null, resolvers: ["partner:register"] });
    }
    if (c?.ending) {
      items.push({ id: "outside-ending", severity: "warn", title: `${c.ending} ${c.ending === 1 ? "registration ends" : "registrations end"} within ${ENDING_SOON_DAYS} days`, why: "Nothing is booked yet. Book the visit, or register the buyer again once it runs out.", action: "See them", href: "/dashboard/developers/buyers", tag: null, resolvers: ["partner:register"] });
    }
    if (c?.uninvoiced) {
      items.push({ id: "outside-uninvoiced", severity: "warn", title: `${c.uninvoiced} ${c.uninvoiced === 1 ? "booking" : "bookings"} not invoiced`, why: "Make the brokerage invoice and send it to the developer.", action: "Make invoices", href: "/dashboard/developers/payouts", tag: null, resolvers: ["payout:read"] });
    }
    if (c?.unpaid) {
      items.push({ id: "outside-unpaid", severity: "warn", title: `${c.unpaid} ${c.unpaid === 1 ? "invoice is" : "invoices are"} unpaid after ${UNPAID_LATE_DAYS} days`, why: "Follow up with the developer, and record the payment when it comes.", action: "See them", href: "/dashboard/developers/payouts", tag: null, resolvers: ["payout:read"] });
    }
    return items;
  } catch (e) {
    console.error("outside: Today's items could not be read", e);
    return [];
  }
}

export { daysFrom };

/** A lead of the partner's own, registered with a developer not on Sales Desk: its name and number read here, never from the browser. */
export async function registerOutsideLead(o: {
  orgId: string;
  userId: string;
  leadId: string;
  projectId: string;
  mayRead: (path: string) => boolean;
  mayRegisterAt: (path: string) => boolean;
}): Promise<Result> {
  if (!ID.test(o.leadId)) return { ok: false, message: "That lead is not here." };
  const [lead] = await withTenant(o.orgId, (sql) => sql<{ name: string | null; phone: string | null; path: string }[]>`
    SELECT l.name, l.phone, n.path::text AS path FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${o.orgId} AND l.id = ${o.leadId} AND l.erased_at IS NULL`);
  if (!lead || !lead.phone || !o.mayRead(lead.path)) return { ok: false, message: "That lead is not here." };
  return registerOutside({
    orgId: o.orgId,
    userId: o.userId,
    projectId: o.projectId,
    name: lead.name ?? "",
    phone: lead.phone,
    leadId: o.leadId,
    mayRegisterAt: o.mayRegisterAt,
  });
}

/** The partner's registrations of one number with developers not on Sales Desk, in the lead page's words. */
export async function outsideForPhone(orgId: string, phone: string, today: string): Promise<{ id: string; developer: string; project: string; state: "registered" | "booked" | "ran_out" | "refused"; until: string | null }[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; developer: string; project: string; status: string; valid_until: string; booked: boolean }[]>`
    SELECT r.id, e.name AS developer, p.name AS project, r.status, r.valid_until::text,
           EXISTS (SELECT 1 FROM outside_bookings b WHERE b.org_id = r.org_id AND b.registration_id = r.id AND b.status = 'OWED') AS booked
    FROM outside_registrations r JOIN scope_nodes p ON p.id = r.project_id JOIN scope_nodes e ON e.id = r.entity_id
    WHERE r.org_id = ${orgId} AND r.phone = ${phone}
    ORDER BY r.sent_at DESC LIMIT 20`);
  return rows.map((r) => {
    const s = outsideState({ status: r.status, validUntil: r.valid_until, booked: r.booked, phone }, today);
    const state = s === "booked" ? "booked" : s === "refused" ? "refused" : s === "lapsed" || s === "withdrawn" ? "ran_out" : "registered";
    return { id: r.id, developer: r.developer, project: r.project, state, until: state === "registered" ? r.valid_until : null };
  });
}
