import { audit, withTenant } from "./db/index.ts";
import { tieUpLine, type BankInput } from "./bank-rules.ts";

/**
 * A developer's bank tie-ups: read for Home loans, Banks, written there,
 * and read for a call's facts. The lender question reads them in
 * `visit-followups.ts`; `bank-rules.ts` decides.
 */

export type Bank = {
  id: string;
  name: string;
  email: string;
  contactName: string | null;
  contactPhone: string | null;
  rateBp: number | null;
  feeNote: string | null;
  validUntil: string | null;
  projects: { id: string; name: string; apfNo: string | null }[];
  /** Loans with this bank: open ones, what it sanctioned, what it refused. */
  loans: { open: number; sanctionedPaise: number; rejected: number };
};

export async function listBanks(orgId: string): Promise<Bank[]> {
  return withTenant(orgId, async (sql) => {
    const [banks, ties, loans] = await Promise.all([
      sql<{ id: string; name: string; email: string; contact_name: string | null; contact_phone: string | null; rate_bp: number | null; fee_note: string | null; valid_until: string | null }[]>`
        SELECT id, name, email, contact_name, contact_phone, rate_bp, fee_note, valid_until::text
        FROM lenders WHERE org_id = ${orgId} AND active ORDER BY created_at, id`,
      sql<{ lender_id: string; id: string; name: string; apf_no: string | null }[]>`
        SELECT lp.lender_id, n.id, n.name, lp.apf_no FROM lender_projects lp JOIN scope_nodes n ON n.id = lp.scope_node_id
        WHERE lp.org_id = ${orgId} ORDER BY n.name`,
      sql<{ lender_id: string; open: number; sanctioned: string; rejected: number }[]>`
        SELECT o.lender_id,
               count(*) FILTER (WHERE o.stage NOT IN ('DISBURSED', 'REJECTED', 'NOT_NEEDED'))::int AS open,
               coalesce(sum(o.amount_paise) FILTER (WHERE o.stage IN ('SANCTIONED', 'DISBURSING', 'DISBURSED')), 0)::text AS sanctioned,
               count(*) FILTER (WHERE o.stage = 'REJECTED')::int AS rejected
        FROM lead_loans o JOIN leads l ON l.id = o.lead_id
        WHERE o.org_id = ${orgId} AND o.lender_id IS NOT NULL AND l.erased_at IS NULL
        GROUP BY o.lender_id`,
    ]);
    return banks.map((b) => {
      const l = loans.find((x) => x.lender_id === b.id);
      return {
        id: b.id,
        name: b.name,
        email: b.email,
        contactName: b.contact_name,
        contactPhone: b.contact_phone,
        rateBp: b.rate_bp,
        feeNote: b.fee_note,
        validUntil: b.valid_until,
        projects: ties.filter((t) => t.lender_id === b.id).map((t) => ({ id: t.id, name: t.name, apfNo: t.apf_no })),
        loans: { open: l?.open ?? 0, sanctionedPaise: Number(l?.sanctioned ?? 0), rejected: l?.rejected ?? 0 },
      };
    });
  });
}

/** The organisation's projects, for the tie-up form. */
export async function projectsForBanks(orgId: string): Promise<{ id: string; name: string }[]> {
  return withTenant(orgId, (sql) => sql<{ id: string; name: string }[]>`
    SELECT id, name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PROJECT' ORDER BY name LIMIT 300`);
}

export type SaveBankResult = { ok: true } | { ok: false; message: string };

/**
 * Adds a bank, or changes one. The address a buyer's details are sent to is
 * written once: a new address is a new bank, so no buyer who said yes to one
 * address is ever sent to another. The projects ticked replace the ones it
 * had, each keeping its approval number.
 */
export async function saveBank(o: { orgId: string; userId: string; lenderId: string | null; input: BankInput }): Promise<SaveBankResult> {
  const i = o.input;
  try {
    const res = await withTenant(o.orgId, async (sql): Promise<SaveBankResult & { id?: string }> => {
      let id = o.lenderId;
      if (id) {
        const r = await sql`
          UPDATE lenders SET name = ${i.name}, contact_name = ${i.contactName}, contact_phone = ${i.contactPhone}, rate_bp = ${i.rateBp},
                 fee_note = ${i.feeNote}, valid_until = ${i.validUntil}, updated_by = ${o.userId}, updated_at = now()
          WHERE org_id = ${o.orgId} AND id = ${id} AND active`;
        if (!r.count) return { ok: false, message: "That bank is no longer on your list." };
      } else {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO lenders (org_id, name, email, contact_name, contact_phone, rate_bp, fee_note, valid_until, created_by, updated_by)
          VALUES (${o.orgId}, ${i.name}, ${i.email}, ${i.contactName}, ${i.contactPhone}, ${i.rateBp}, ${i.feeNote}, ${i.validUntil}, ${o.userId}, ${o.userId})
          RETURNING id`;
        id = row.id;
      }
      const keep = i.projects.map((p) => p.projectId);
      await sql`DELETE FROM lender_projects WHERE org_id = ${o.orgId} AND lender_id = ${id} AND NOT (scope_node_id = ANY(${keep}::uuid[]))`;
      for (const p of i.projects) {
        await sql`
          INSERT INTO lender_projects (org_id, lender_id, scope_node_id, apf_no, created_by)
          VALUES (${o.orgId}, ${id}, ${p.projectId}, ${p.apfNo}, ${o.userId})
          ON CONFLICT (lender_id, scope_node_id) DO UPDATE SET apf_no = EXCLUDED.apf_no`;
      }
      return { ok: true, id: id! };
    });
    if (res.ok) {
      await audit({
        orgId: o.orgId,
        actorUserId: o.userId,
        action: o.lenderId ? "lender.updated" : "lender.added",
        targetType: "lender",
        targetId: res.id ?? o.lenderId,
        metadata: { domain: i.email.split("@")[1] ?? null, projects: i.projects.length },
      });
    }
    return res.ok ? { ok: true } : res;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") return { ok: false, message: "Email: that address is already a bank on your list." };
    if (code === "23514") return { ok: false, message: "Projects: one of those is not one of your projects." };
    throw e;
  }
}

/**
 * What a call about this tower may say about home-loan tie-ups: the banks
 * that approved its project, then the organisation-wide ones, each with the
 * rate it offers when recorded. Empty when none is set up, and the Brain's
 * own line is used.
 */
export async function tieUpsAt(orgId: string, nodeId: string, today: string): Promise<string[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ name: string; rate_bp: number | null; valid_until: string | null; approved: boolean; tied: boolean }[]>`
    SELECT k.name, k.rate_bp, k.valid_until::text,
           EXISTS (SELECT 1 FROM lender_projects lp JOIN scope_nodes pn ON pn.id = lp.scope_node_id
                   JOIN scope_nodes me ON me.id = ${nodeId}
                   WHERE lp.lender_id = k.id AND pn.path @> me.path) AS approved,
           EXISTS (SELECT 1 FROM lender_projects lp WHERE lp.lender_id = k.id) AS tied
    FROM lenders k WHERE k.org_id = ${orgId} AND k.active ORDER BY k.created_at`);
  return rows
    .filter((r) => r.approved || !r.tied)
    .map((r) => tieUpLine({ name: r.name, rateBp: r.rate_bp, approved: r.approved, validUntil: r.valid_until }, today))
    .filter((x): x is string => !!x);
}
