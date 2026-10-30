import type { TransactionSql } from "postgres";
import { withTenant } from "./db/index.ts";
import { open } from "./vault.ts";
import { senderFor, whatsappPurpose } from "./wa-numbers.ts";
import { numberFor } from "./wa-rules.ts";
import { whatsapp, type WhatsAppConfig } from "./whatsapp.ts";
import { PRICE_PAISE, SESSION_HOURS, TEMPLATES, fill, render, versionOf, type Voice } from "./message-rules.ts";
import { messageAllowed } from "./billing.ts";
import { partnerVoice, payoutUpdate, say, type HalfLine, type PayoutLine } from "./partner-bot-rules.ts";
import { rupees } from "./lead-rules.ts";
import { notifyMandatePayout } from "./mandates.ts";

/**
 * What a firm is told about its money, and the numbers it is told from.
 *
 * Section 07: every step a payout takes pushes a message to the firm,
 * unprompted. It goes to the firm's principal and to the person who
 * registered the buyer, once each has proved their number, and never to
 * somebody who wrote STOP. Inside the 24 hours after they last wrote to
 * this number it is a plain reply, which Meta does not charge for;
 * otherwise it is the approved utility template, asked of the plan first.
 *
 * Like every WhatsApp here, it is a row before it is a request, and a
 * refusal is a row with its reason. Nothing in this file ever fails the
 * payout step that started it.
 */

type Sql = TransactionSql;

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/** The token and number id of one of the developer's numbers, if it still works. */
export async function configFor(orgId: string, numberId: string): Promise<WhatsAppConfig | null> {
  const [n] = await withTenant(orgId, (sql) => sql<{ phone_number_id: string; account_id: string; secret: Buffer | null; status: string; retired: boolean }[]>`
    SELECT n.phone_number_id, n.account_id, a.secret, a.status, n.retired_at IS NOT NULL AS retired
    FROM whatsapp_numbers n JOIN whatsapp_accounts a ON a.id = n.account_id
    WHERE n.org_id = ${orgId} AND n.id = ${numberId}`);
  if (!n || n.retired || n.status !== "CONNECTED") return null;
  const token = await open(orgId, whatsappPurpose(n.account_id), n.secret);
  return token ? { token, phoneNumberId: n.phone_number_id } : null;
}

/** The developer's number that writes for a place, as a buyer would dial it. */
export async function numberAt(sql: Sql, orgId: string, path: string): Promise<{ id: string; phone: string } | null> {
  const rows = await sql<{ id: string; display_phone: string; node_path: string | null; active: boolean }[]>`
    SELECT n.id, n.display_phone, s.path::text AS node_path, n.active
    FROM whatsapp_numbers n JOIN whatsapp_accounts a ON a.id = n.account_id
    LEFT JOIN scope_nodes s ON s.id = n.scope_node_id
    WHERE n.org_id = ${orgId} AND n.retired_at IS NULL AND a.status = 'CONNECTED'`;
  const pick = numberFor(rows.map((r) => ({ ...r, nodePath: r.node_path })), path);
  return pick ? { id: pick.id, phone: pick.display_phone } : null;
}

// ---------------------------------------------------------------------------
// A firm's payouts, as the firm reads them
// ---------------------------------------------------------------------------

export type FirmPayout = PayoutLine & { id: string; projectId: string; agentId: string | null };

/** "Nitin Gupta" as "Nitin G.": a chat is forwarded, a booking is not. */
export const shortName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0] || "Buyer";
};

export async function firmPayouts(sql: Sql, orgId: string, cpOrgId: string, payoutId?: string): Promise<FirmPayout[]> {
  const pays = await sql<{
    id: string; unit: string | null; scope_node_id: string; project: string; buyer: string; cancelled: boolean;
    m1_owed: boolean; m2_owed: boolean; agent_id: string | null;
  }[]>`
    SELECT p.id, p.unit, p.scope_node_id, n.name AS project, l.name AS buyer, p.cancelled_at IS NOT NULL AS cancelled,
           p.agreement_registered_on IS NOT NULL AS m1_owed, p.collected_on IS NOT NULL AS m2_owed, r.agent_id
    FROM partner_payouts p
    JOIN scope_nodes n ON n.id = p.scope_node_id
    JOIN leads l ON l.id = p.lead_id
    LEFT JOIN client_registrations r ON r.id = p.registration_id
    WHERE p.org_id = ${orgId} AND p.cp_org_id = ${cpOrgId} ${payoutId ? sql`AND p.id = ${payoutId}` : sql``}
    ORDER BY p.cancelled_at IS NOT NULL, p.booked_on DESC, p.created_at DESC`;
  if (!pays.length) return [];
  const halves = await sql<{
    payout_id: string; key: "M1" | "M2"; base: string; stage: HalfLine["stage"]; paid_on: Date | string | null; utr: string | null;
    invoiced: boolean; attested: boolean;
  }[]>`
    SELECT m.payout_id, m.key, m.base, m.stage, m.paid_on, m.utr,
           EXISTS (SELECT 1 FROM partner_invoices i WHERE i.org_id = m.org_id AND i.milestone_id = m.id AND i.rejected_at IS NULL) AS invoiced,
           EXISTS (SELECT 1 FROM partner_invoices i WHERE i.org_id = m.org_id AND i.milestone_id = m.id AND i.rejected_at IS NULL
                   AND i.attested_at IS NOT NULL) AS attested
    FROM payout_milestones m
    WHERE m.org_id = ${orgId} AND m.payout_id = ANY(${pays.map((p) => p.id)})
    ORDER BY m.key`;
  const day = (d: Date | string | null) => (d === null ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  return pays.map((p) => ({
    id: p.id,
    projectId: p.scope_node_id,
    agentId: p.agent_id,
    unit: p.unit ?? "Unit",
    buyer: shortName(p.buyer),
    project: p.project,
    cancelled: p.cancelled,
    halves: halves
      .filter((h) => h.payout_id === p.id)
      .map((h) => ({
        key: h.key,
        base: Number(h.base),
        stage: h.stage,
        owed: h.key === "M1" ? p.m1_owed : p.m2_owed,
        invoiced: h.invoiced,
        attested: h.attested,
        paidOn: day(h.paid_on),
        utr: h.utr,
      })),
  }));
}

// ---------------------------------------------------------------------------
// Telling the firm
// ---------------------------------------------------------------------------

export type PayoutEvent =
  | { kind: "booked" }
  | { kind: "half"; key: "M1" | "M2" }
  | { kind: "cancelled" }
  /** Cancelled after a half was paid: `amount` rupees come off the firm's next payouts. */
  | { kind: "clawback"; amount: number }
  /** Approved, with `amount` rupees of a cancelled booking taken off it. */
  | { kind: "adjusted"; key: "M1" | "M2"; amount: number };

type Recipient = { id: string; name: string; phone: string; language: string };

/**
 * One message per person who should hear about this payout's step. Never
 * throws: the payout moved whether or not the firm could be told.
 */
export async function notifyPayout(orgId: string, payoutId: string, event: PayoutEvent, now = new Date()): Promise<number> {
  try {
    // A mandate firm's commission is emailed to its admins; it has nobody on the bot.
    const mandate = await notifyMandatePayout(orgId, payoutId, event);
    if (mandate !== null) return mandate;
    return await tell(orgId, payoutId, event, now);
  } catch (e) {
    console.error(`partners: could not tell the firm about payout ${payoutId}`, e);
    return 0;
  }
}

async function tell(orgId: string, payoutId: string, event: PayoutEvent, now: Date): Promise<number> {
  const found = await withTenant(orgId, async (sql) => {
    const [p] = await sql<{ cp_org_id: string }[]>`
      SELECT p.cp_org_id FROM partner_payouts p
      WHERE p.org_id = ${orgId} AND p.id = ${payoutId}
        AND EXISTS (SELECT 1 FROM partner_firms f WHERE f.org_id = p.org_id AND f.cp_org_id = p.cp_org_id)`;
    if (!p) return null;
    const [row] = await firmPayouts(sql, orgId, p.cp_org_id, payoutId);
    if (!row) return null;
    const people = await sql<Recipient[]>`
      SELECT id, name, phone, language FROM partner_agents
      -- The firm's people, whichever of its rows here (one per desk, 0092) they were added on.
      WHERE org_id = ${orgId} AND cp_org_id = ${p.cp_org_id} AND status = 'ACTIVE' AND muted_at IS NULL
        AND (is_principal OR id = ${row.agentId})`;
    return { row, people };
  });
  if (!found || !found.people.length) return 0;
  const { row, people } = found;

  const half = event.kind === "half" || event.kind === "adjusted" ? row.halves.find((h) => h.key === event.key) : row.halves.find((h) => h.key === "M1");
  if (!half) return 0;
  // Each person reads it in the language they chose on the bot.
  const updateIn = (voice: Voice) =>
    event.kind === "cancelled"
      ? say(voice, "notify_cancelled")
      : event.kind === "clawback"
        ? say(voice, "notify_clawback", { amount: rupees(event.amount) })
        : event.kind === "adjusted"
          ? say(voice, "notify_adjusted", { key: event.key, amount: rupees(event.amount) })
          : event.kind === "booked"
            ? say(voice, "notify_booked", { update: payoutUpdate(half, false, voice) })
            : payoutUpdate(half, row.cancelled, voice);
  let sent = 0;
  for (const person of people) {
    const voice = partnerVoice(person.language);
    const u = { projectId: row.projectId, project: row.project, booking: `${row.unit} (${row.buyer})`, update: updateIn(voice) };
    if (await sendUpdate(orgId, person, u, voice, now)) sent += 1;
  }
  return sent;
}

async function sendUpdate(
  orgId: string,
  person: Recipient,
  u: { projectId: string; project: string; booking: string; update: string },
  voice: Voice,
  now: Date,
): Promise<boolean> {
  // The person's own version, filed at Meta under its own name (`_en`, `_mr`).
  const t = versionOf(TEMPLATES.PARTNER_PAYOUT, voice);
  const values = fill(t, { first_name: person.name.split(/\s+/)[0], project: u.project, booking: u.booking, update: u.update });
  const body = render(t, values);

  // Inside their window on the number they last wrote to, a plain reply is free.
  const [last] = await withTenant(orgId, (sql) => sql<{ number_id: string | null; created_at: Date }[]>`
    SELECT number_id, created_at FROM messages
    WHERE org_id = ${orgId} AND phone = ${person.phone} AND direction = 'IN' AND number_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`);
  const open24 = last?.number_id && now.getTime() - last.created_at.getTime() < SESSION_HOURS * 3_600_000 - 60_000;
  const free = open24 ? await configFor(orgId, last!.number_id!) : null;

  if (free) {
    const [row] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
      INSERT INTO messages (org_id, direction, purpose, category, language, body, phone, status, number_id, partner_agent_id, scope_node_id)
      VALUES (${orgId}, 'OUT', 'PARTNER_PAYOUT', 'SERVICE', 'en', ${body}, ${person.phone}, 'QUEUED', ${last!.number_id}, ${person.id}, ${u.projectId})
      RETURNING id`);
    return deliver(orgId, row.id, () => {
      const d = whatsapp();
      if (!d.sendText) throw new Error("This WhatsApp connection cannot send a plain reply.");
      return d.sendText(free, { to: person.phone, body, callbackData: `${orgId}:${row.id}` });
    });
  }

  const sender = await senderFor(orgId, u.projectId);
  const refusal = !sender.ok
    ? sender.message
    : !sender.approved(t.name, "en")
      ? "Meta hasn't approved the partner payout message for this project's number yet, so it wasn't sent."
      : null;
  const allowed = refusal ? null : await messageAllowed(orgId, u.projectId, PRICE_PAISE[t.category]);
  const why = refusal ?? (allowed && !allowed.ok ? allowed.message : null);
  const [row] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO messages (org_id, direction, purpose, template, category, language, variables, body, phone, status, error, cost_paise,
                          number_id, partner_agent_id, scope_node_id)
    VALUES (${orgId}, 'OUT', 'PARTNER_PAYOUT', ${t.name}, ${t.category}, 'en', ${sql.json(values as never)}, ${body}, ${person.phone},
            ${why ? "REFUSED" : "QUEUED"}, ${why}, ${why ? null : PRICE_PAISE[t.category]},
            ${sender.ok ? sender.numberId : null}, ${person.id}, ${u.projectId})
    RETURNING id`);
  if (why || !sender.ok) return false;
  return deliver(orgId, row.id, () =>
    whatsapp().sendTemplate(sender.config, { to: person.phone, template: t.name, language: "en", params: values, callbackData: `${orgId}:${row.id}` }),
  );
}

/** Send, then record what WhatsApp said. */
export async function deliver(orgId: string, rowId: string, send: () => Promise<{ id: string }>): Promise<boolean> {
  try {
    const { id } = await send();
    await withTenant(orgId, (sql) => sql`
      UPDATE messages SET status = 'SENT', provider_id = ${id}, sent_at = now() WHERE org_id = ${orgId} AND id = ${rowId}`);
    return true;
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 480);
    await withTenant(orgId, (sql) => sql`
      UPDATE messages SET status = 'FAILED', error = ${message}, cost_paise = NULL WHERE org_id = ${orgId} AND id = ${rowId}`);
    return false;
  }
}
