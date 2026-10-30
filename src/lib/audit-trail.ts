import { withTenant } from "./db/index.ts";
import { AUDIT_AREAS, areaPrefixes, auditArea, auditWords, targetWords, type AuditArea } from "./audit-rules.ts";

/**
 * The audit trail as a screen reads it: newest first, a page at a time,
 * filtered by person, area and day. Names are read for the people who did
 * things and for the places and records a row is about; a buyer's name
 * never is, because the trail's reader holds no key to buyers.
 */

export const AUDIT_PAGE = 100;

export type AuditRow = {
  id: number;
  at: string;
  who: string;
  /** Somebody who did it, or the product doing it on its own. */
  byPerson: boolean;
  area: AuditArea;
  areaLabel: string;
  text: string;
  on: string | null;
};

export type AuditPage = {
  rows: AuditRow[];
  /** The id to continue from, when there is more. */
  next: number | null;
  people: { id: string; name: string }[];
};

export async function loadAuditTrail(o: {
  orgId: string;
  who: string | null;
  area: AuditArea | null;
  from: string | null;
  to: string | null;
  before: number | null;
}): Promise<AuditPage> {
  const known = AUDIT_AREAS.filter((a) => a.key !== "other").flatMap((a) => areaPrefixes(a.key));
  const start = o.from ? new Date(`${o.from}T00:00:00+05:30`) : null;
  const end = o.to ? new Date(Date.parse(`${o.to}T00:00:00+05:30`) + 86_400_000) : null;
  return withTenant(o.orgId, async (sql) => {
    const [rows, people] = await Promise.all([
      sql<{
        id: string; action: string; target_type: string | null; created_at: Date; actor_user_id: string | null;
        actor_name: string | null; target_name: string | null;
      }[]>`
        SELECT a.id, a.action, a.target_type, a.created_at, a.actor_user_id, u.name AS actor_name,
               CASE a.target_type
                 WHEN 'scope_node' THEN (SELECT n.name FROM scope_nodes n WHERE n.org_id = ${o.orgId} AND n.id::text = a.target_id)
                 WHEN 'campaign_brief' THEN (SELECT b.name FROM campaign_briefs b WHERE b.org_id = ${o.orgId} AND b.id::text = a.target_id)
                 WHEN 'mandate' THEN (SELECT m.firm_name FROM mandates m WHERE m.org_id = ${o.orgId} AND m.id::text = a.target_id)
                 WHEN 'partner_firm' THEN (SELECT f.name FROM partner_firms f WHERE f.org_id = ${o.orgId} AND f.id::text = a.target_id)
                 WHEN 'asset' THEN (SELECT coalesce(x.title, x.category) FROM assets x WHERE x.org_id = ${o.orgId} AND x.id::text = a.target_id)
                 WHEN 'user' THEN (SELECT t.name FROM users t WHERE t.id::text = a.target_id)
                 WHEN 'membership' THEN (SELECT t.name FROM memberships mb JOIN users t ON t.id = mb.user_id
                                         WHERE mb.org_id = ${o.orgId} AND mb.id::text = a.target_id)
               END AS target_name
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.org_id = ${o.orgId}
          ${o.before ? sql`AND a.id < ${o.before}` : sql``}
          ${o.who === "system" ? sql`AND a.actor_user_id IS NULL` : o.who ? sql`AND a.actor_user_id = ${o.who}` : sql``}
          ${o.area === "other"
            ? sql`AND NOT (split_part(a.action, '.', 1) = ANY(${known}))`
            : o.area
              ? sql`AND split_part(a.action, '.', 1) = ANY(${areaPrefixes(o.area)})`
              : sql``}
          ${start ? sql`AND a.created_at >= ${start}` : sql``}
          ${end ? sql`AND a.created_at < ${end}` : sql``}
        ORDER BY a.id DESC
        LIMIT ${AUDIT_PAGE + 1}`,
      sql<{ id: string; name: string }[]>`
        SELECT DISTINCT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ${o.orgId} AND u.name IS NOT NULL
        ORDER BY u.name`,
    ]);
    const page = rows.slice(0, AUDIT_PAGE);
    const label = new Map(AUDIT_AREAS.map((a) => [a.key, a.label]));
    return {
      rows: page.map((r) => {
        const area = auditArea(r.action);
        return {
          id: Number(r.id),
          at: r.created_at.toISOString(),
          who: r.actor_user_id ? r.actor_name ?? "Someone no longer here" : "Sales Desk",
          byPerson: !!r.actor_user_id,
          area,
          areaLabel: label.get(area) ?? "Other",
          text: auditWords(r.action),
          on: r.target_name ?? targetWords(r.target_type),
        };
      }),
      next: rows.length > AUDIT_PAGE ? Number(page[page.length - 1].id) : null,
      people,
    };
  });
}
