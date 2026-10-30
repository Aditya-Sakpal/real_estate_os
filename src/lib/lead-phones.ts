import { audit, auditHash, withTenant } from "./db/index.ts";
import { normalisePhone } from "./calling-rules.ts";
import { otherNumberProblem, type OtherNumberKind } from "./partner-rules.ts";
import { isId, onBooked } from "./partners.ts";

/**
 * The other numbers on a lead: a co-applicant's, an alternate (0091).
 *
 * A partner may register the buyer under a spouse's number and the booking
 * be made in the buyer's own, so a booking looks for a partner's claim on
 * every number on the lead (`onBooked()`). The numbers are a buyer's, so
 * they are shown through the viewer's lens like the lead's own, never named
 * in the audit row, and taken off rather than deleted.
 */

export type OtherNumber = { id: string; phone: string; kind: OtherNumberKind; addedOn: string };

export async function otherNumbers(orgId: string, leadId: string): Promise<OtherNumber[]> {
  if (!isId(leadId)) return [];
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; phone: string; kind: OtherNumberKind; created_at: Date }[]>`
    SELECT id, phone, kind, created_at FROM lead_phones
    WHERE org_id = ${orgId} AND lead_id = ${leadId} AND removed_at IS NULL ORDER BY created_at`);
  return rows.map((r) => ({ id: r.id, phone: r.phone, kind: r.kind, addedOn: r.created_at.toISOString() }));
}

export async function addOtherNumber(opts: { orgId: string; userId: string; leadId: string; raw: string; kind: OtherNumberKind }): Promise<{ ok: boolean; message: string }> {
  if (!isId(opts.leadId)) return { ok: false, message: "That lead is not here." };
  if (opts.kind !== "CO_APPLICANT" && opts.kind !== "ALTERNATE") return { ok: false, message: "Choose whose number it is." };
  const phone = normalisePhone(opts.raw);
  const out = await withTenant(opts.orgId, async (sql) => {
    const [lead] = await sql<{ phone: string; stage: string }[]>`
      SELECT phone, stage FROM leads WHERE org_id = ${opts.orgId} AND id = ${opts.leadId}`;
    if (!lead) return { ok: false as const, message: "That lead is not here." };
    const existing = await sql<{ phone: string }[]>`
      SELECT phone FROM lead_phones WHERE org_id = ${opts.orgId} AND lead_id = ${opts.leadId} AND removed_at IS NULL`;
    const problem = otherNumberProblem(phone, lead.phone, existing.map((e) => e.phone));
    if (problem) return { ok: false as const, message: problem };
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO lead_phones (org_id, lead_id, phone, kind, added_by)
      VALUES (${opts.orgId}, ${opts.leadId}, ${phone}, ${opts.kind}, ${opts.userId})
      ON CONFLICT (org_id, lead_id, phone) WHERE removed_at IS NULL DO NOTHING
      RETURNING id`;
    if (!row) return { ok: false as const, message: "That number is already on this lead." };
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id, detail)
      VALUES (${opts.orgId}, ${opts.leadId}, 'NOTE', ${opts.kind === "CO_APPLICANT" ? "Co-applicant's number added" : "Alternate number added"},
              ${opts.userId}, ${sql.json({ number: row.id } as never)})`;
    return { ok: true as const, id: row.id, booked: lead.stage === "booked" };
  });
  if (!out.ok) return out;
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "lead.number_added",
    targetType: "lead",
    targetId: opts.leadId,
    metadata: { kind: opts.kind, phone: auditHash(phone) },
  });
  // A booking no partner's claim matched may match one on this number.
  if (out.booked) await onBooked({ orgId: opts.orgId, userId: opts.userId, leadId: opts.leadId });
  return { ok: true, message: "Number added." };
}

export async function removeOtherNumber(opts: { orgId: string; userId: string; leadId: string; id: string }): Promise<{ ok: boolean; message: string }> {
  if (!isId(opts.leadId) || !isId(opts.id)) return { ok: false, message: "That number is not here." };
  const n = await withTenant(opts.orgId, (sql) => sql`
    UPDATE lead_phones SET removed_at = now(), removed_by = ${opts.userId}
    WHERE org_id = ${opts.orgId} AND lead_id = ${opts.leadId} AND id = ${opts.id} AND removed_at IS NULL`);
  if (!n.count) return { ok: false, message: "That number is not here." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "lead.number_removed", targetType: "lead", targetId: opts.leadId });
  return { ok: true, message: "Number taken off." };
}
