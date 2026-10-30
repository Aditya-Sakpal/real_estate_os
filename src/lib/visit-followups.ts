import { audit, auditHash, withTenant } from "./db/index.ts";
import { resolveBrain } from "./brain.ts";
import { approvedUnits } from "./unit.ts";
import { priceFor } from "./unit-rules.ts";
import { send as sendMail, type Mail, type MailResult } from "./mailer.ts";
import { TEMPLATES, fill, render, versionOf, voiceFor } from "./message-rules.ts";
import { emiFill, emiPlan, lenderMail, lenderNames, lenderPayload, lendersToAsk } from "./visit-note-rules.ts";
import { noteLoanInterest } from "./loans.ts";
import { banksForProject } from "./bank-rules.ts";

/**
 * What a visit's objection starts: the EMI on the unit shown when price held
 * the buyer back, and an introduction to a lender, only after the buyer says
 * yes, when a loan did. The reads and writes around the pure half in
 * `visit-note-rules.ts`.
 */

// ---------------------------------------------------------------------------
// The EMI, from signed facts only
// ---------------------------------------------------------------------------

export type EmiValues =
  | { ok: true; values: { unit: string; loan: string; rate: string; emi_15: string; emi_20: string; emi_25: string } }
  | { ok: false; why: string };

/**
 * The EMI a buyer is sent: on the approved unit type the host said was
 * shown (else the one matching what the buyer asked for, else the cheapest),
 * at the approved price, on the bank's loan amount, at the signed home-loan
 * rate. Nothing typed by a person and nothing a model said reaches a number.
 * The loan is written the way the lead's version reads it (`loanWords()`).
 */
export async function emiValues(orgId: string, leadId: string, unitIds: string[] = []): Promise<EmiValues> {
  const [lead] = await withTenant(orgId, (sql) => sql<{ scope_node_id: string; facts: Record<string, string>; language: string | null }[]>`
    SELECT scope_node_id, facts, language FROM leads WHERE org_id = ${orgId} AND id = ${leadId}`);
  if (!lead) return { ok: false, why: "The lead no longer exists." };
  const [{ units, basePsf }, brain] = await Promise.all([
    approvedUnits(orgId, lead.scope_node_id).catch(() => ({ units: [], basePsf: null })),
    resolveBrain(orgId, lead.scope_node_id),
  ]);
  const rate = Number(brain?.values["price.loan_rate"] ?? NaN);
  if (!(rate > 0)) return { ok: false, why: "Send the payment plan yourself: no home-loan rate is signed for this tower" };
  const priced = units
    .map((u) => ({ u, price: priceFor(u, basePsf) }))
    .filter((x): x is { u: (typeof units)[number]; price: number } => typeof x.price === "number" && x.price > 0);
  const wanted = (lead.facts?.config ?? "").toLowerCase();
  const pick =
    priced.find((x) => unitIds.includes(x.u.id)) ??
    priced.find((x) => wanted && x.u.configLabel.toLowerCase() === wanted) ??
    [...priced].sort((a, b) => a.price - b.price)[0];
  if (!pick) return { ok: false, why: "Send the payment plan yourself: no approved price for this tower" };
  // In the words of the version the lead is sent, the one `sendMessage()` picks.
  return { ok: true, values: emiFill(emiPlan(pick.price, rate), pick.u.label, rate, voiceFor(lead.language)) };
}

// ---------------------------------------------------------------------------
// Lenders
// ---------------------------------------------------------------------------

export type Lender = { id: string; name: string; email: string };

export async function listLenders(orgId: string): Promise<Lender[]> {
  return withTenant(orgId, (sql) => sql<Lender[]>`
    SELECT id, name, email FROM lenders WHERE org_id = ${orgId} AND active ORDER BY created_at`);
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function addLender(o: { orgId: string; userId: string; name: string; email: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const name = o.name.trim().slice(0, 80);
  const email = o.email.trim().toLowerCase();
  if (!name) return { ok: false, message: "Name the lender." };
  if (!EMAIL.test(email) || email.length > 200) return { ok: false, message: "Enter the address buyers are sent to, like loans@bank.example." };
  try {
    const [row] = await withTenant(o.orgId, (sql) => sql<{ id: string }[]>`
      INSERT INTO lenders (org_id, name, email, created_by) VALUES (${o.orgId}, ${name}, ${email}, ${o.userId}) RETURNING id`);
    await audit({ orgId: o.orgId, actorUserId: o.userId, action: "lender.added", targetType: "lender", targetId: row.id, metadata: { domain: email.split("@")[1] } });
    return { ok: true };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, message: "That address is already on the list." };
    throw e;
  }
}

export async function removeLender(o: { orgId: string; userId: string; lenderId: string }): Promise<boolean> {
  const r = await withTenant(o.orgId, (sql) => sql`
    UPDATE lenders SET active = false, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${o.lenderId} AND active`);
  if (r.count) await audit({ orgId: o.orgId, actorUserId: o.userId, action: "lender.removed", targetType: "lender", targetId: o.lenderId });
  return r.count > 0;
}

/**
 * The question a buyer is asked before any lender hears of them: one
 * question naming up to three lenders, in the order Settings lists them, and
 * a row for each first, tied together by the ask, so the answer has
 * something to land on. None when there is no lender to introduce, or the
 * buyer was already asked about every one.
 */
export async function lenderAsk(orgId: string, leadId: string, visitId: string | null): Promise<{ lender: string; payloads: string[] } | { none: string }> {
  return withTenant(orgId, async (sql) => {
    // The banks for this buyer's project: those that approved it first, then
    // the organisation-wide ones; never one tied only to other projects, nor
    // one whose tie-up ended (`banksForProject()`).
    const all = await sql<{ id: string; name: string; approved_here: boolean; tied_anywhere: boolean; valid_until: string | null }[]>`
      SELECT k.id, k.name, k.valid_until::text,
             EXISTS (SELECT 1 FROM lender_projects lp JOIN scope_nodes pn ON pn.id = lp.scope_node_id
                     JOIN leads l ON l.id = ${leadId} JOIN scope_nodes ln ON ln.id = l.scope_node_id
                     WHERE lp.lender_id = k.id AND pn.path @> ln.path) AS approved_here,
             EXISTS (SELECT 1 FROM lender_projects lp WHERE lp.lender_id = k.id) AS tied_anywhere
      FROM lenders k WHERE k.org_id = ${orgId} AND k.active ORDER BY k.created_at, k.id`;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const listed = banksForProject(
      all.map((b) => ({ id: b.id, name: b.name, approvedHere: b.approved_here, tiedAnywhere: b.tied_anywhere, validUntil: b.valid_until })),
      today,
    );
    if (!listed.length) return { none: "Buyer needs a home loan. No bank is set up for this project: call them" };
    const asked = await sql<{ lender_id: string }[]>`
      SELECT lender_id FROM lender_referrals WHERE org_id = ${orgId} AND lead_id = ${leadId}`;
    const lenders = lendersToAsk(listed, asked.map((a) => a.lender_id));
    if (!lenders.length) return { none: "" };
    const [lead] = await sql<{ name: string; language: string | null }[]>`SELECT name, language FROM leads WHERE org_id = ${orgId} AND id = ${leadId}`;
    const t = versionOf(TEMPLATES.LENDER_ASK, voiceFor(lead?.language));
    const first = (lead?.name ?? "").split(/\s+/)[0];
    const names = lenderNames(lenders.map((l) => l.name));
    const wording = render(t, fill(t, { first_name: first === "Buyer" ? null : first, lender: names }));
    const [ask] = await sql<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
    const ids: string[] = [];
    for (const l of lenders) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO lender_referrals (org_id, lead_id, visit_id, lender_id, wording, ask_id)
        VALUES (${orgId}, ${leadId}, ${visitId}, ${l.id}, ${wording.slice(0, 600)}, ${ask.id})
        ON CONFLICT (org_id, lead_id, lender_id) DO NOTHING RETURNING id`;
      if (row) ids.push(row.id);
    }
    if (!ids.length) return { none: "" };
    // The buttons name the first row; the answer lands on every row of the ask.
    return { lender: names, payloads: [lenderPayload(ids[0], true), lenderPayload(ids[0], false)] };
  });
}

type Mailer = (m: Mail) => Promise<MailResult>;
let injectedMail: Mailer | null = null;

/** For the checks: where a lender's email goes instead of SES. */
export function useLenderMail(m: Mailer | null): void {
  injectedMail = m;
}

/**
 * The buyer tapped Yes or No on the question. A no ends it. A yes is the
 * consent: the lender is sent the buyer's name and number, and the reveal
 * is audited as its own event. The tap has to come from the lead's own
 * number, so a forwarded button cannot answer for somebody else.
 */
export async function onLenderAnswer(o: { orgId: string; referralId: string; yes: boolean; phone: string }): Promise<"SENT" | "NO" | "FAILED" | "IGNORED"> {
  type Ref = { id: string; state: string; lead_id: string; lender_id: string; lender: string; email: string; name: string; phone: string; facts: Record<string, string>; node: string; parent: string | null; developer: string };
  // Every lender the one question named, in the order it named them.
  const refs = await withTenant(o.orgId, (sql) => sql<Ref[]>`
    SELECT r.id, r.state, r.lead_id, r.lender_id, k.name AS lender, k.email, l.name, l.phone, l.facts,
           n.name AS node, p.name AS parent, o.display_name AS developer
    FROM lender_referrals r
    JOIN lender_referrals tapped ON tapped.org_id = r.org_id AND tapped.id = ${o.referralId}
                                AND tapped.ask_id = r.ask_id AND tapped.lead_id = r.lead_id
    JOIN lenders k ON k.id = r.lender_id
    JOIN leads l ON l.id = r.lead_id
    JOIN scope_nodes n ON n.id = l.scope_node_id
    LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
    JOIN orgs o ON o.id = r.org_id
    WHERE r.org_id = ${o.orgId}
    ORDER BY k.created_at, k.id`);
  const open = refs.filter((r) => r.phone === o.phone && (r.state === "ASKED" || r.state === "FAILED"));
  if (!open.length) return "IGNORED";
  const leadId = open[0].lead_id;
  if (!o.yes) {
    const asked = open.filter((r) => r.state === "ASKED");
    if (!asked.length) return "IGNORED";
    await withTenant(o.orgId, (sql) => sql`
      UPDATE lender_referrals SET state = 'NO', answered_at = now()
      WHERE org_id = ${o.orgId} AND id = ANY(${asked.map((r) => r.id)}) AND state = 'ASKED'`);
    for (const r of asked) {
      await audit({ orgId: o.orgId, actorUserId: null, action: "lead.lender_declined", targetType: "lead", targetId: leadId, metadata: { lender_id: r.lender_id } });
    }
    return "NO";
  }
  const moved = await withTenant(o.orgId, (sql) => sql<{ id: string }[]>`
    UPDATE lender_referrals SET state = 'YES', answered_at = coalesce(answered_at, now())
    WHERE org_id = ${o.orgId} AND id = ANY(${open.map((r) => r.id)}) AND state IN ('ASKED', 'FAILED')
    RETURNING id`);
  const mine = new Set(moved.map((m) => m.id));
  const toSend = open.filter((r) => mine.has(r.id));
  if (!toSend.length) return "IGNORED";
  // The loan is the loan executive's to follow from here; the bank is named
  // only when the buyer was asked about one.
  await noteLoanInterest({ orgId: o.orgId, leadId, source: "LENDER_YES", lenderId: toSend.length === 1 ? toSend[0].lender_id : null })
    .catch((e) => console.warn("loans: interest not recorded,", (e as Error).message));

  // Each lender in the order the question named them, each its own email
  // and its own audited reveal.
  let failed = 0;
  for (const ref of toSend) {
    const mail = lenderMail({
      lender: ref.lender,
      developer: ref.developer,
      buyer: ref.name,
      phone: ref.phone,
      project: ref.parent ? `${ref.parent} ${ref.node}` : ref.node,
      config: ref.facts?.config ?? null,
      budget: ref.facts?.budget ?? null,
    });
    const sent = await (injectedMail ?? sendMail)({ to: ref.email, ...mail }).catch(() => ({ ok: false as const, code: "SEND_FAILED" as const, detail: "" }));
    if (!sent.ok) {
      failed++;
      await withTenant(o.orgId, (sql) => sql`
        UPDATE lender_referrals SET state = 'FAILED', reason = 'The email to the lender did not go out.' WHERE org_id = ${o.orgId} AND id = ${ref.id}`);
      continue;
    }
    await withTenant(o.orgId, (sql) => sql`
      UPDATE lender_referrals SET state = 'SENT', sent_at = now(), reason = NULL WHERE org_id = ${o.orgId} AND id = ${ref.id}`);
    // The number left us: its own reveal, with who it went to.
    await audit({
      orgId: o.orgId,
      actorUserId: null,
      action: "lead.phone_unmasked",
      targetType: "lead",
      targetId: ref.lead_id,
      metadata: { to: "lender", lender_id: ref.lender_id, phone: auditHash(ref.phone) },
    });
  }
  if (failed) {
    await withTenant(o.orgId, (sql) => sql`
      UPDATE leads SET needs_person = ${failed === toSend.length
        ? "Buyer said yes to a home-loan call. The lender could not be emailed: send it yourself"
        : "Buyer said yes to a home-loan call. One lender could not be emailed: send it yourself"}, updated_at = now()
      WHERE org_id = ${o.orgId} AND id = ${leadId}`);
    return "FAILED";
  }
  return "SENT";
}
