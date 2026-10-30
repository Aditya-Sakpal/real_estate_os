import { withTenant } from "./db/index.ts";
import { ZERO, add, matured, portalSourceKey, type Counts } from "./report-rules.ts";
import { WEEKS, mondayOf, type Cohort, type ReportData, type Row } from "./report-sample.ts";
import { addDays } from "./lead-rules.ts";
import type { Lineage } from "./capture-rules.ts";

/**
 * The reports from real leads, in the shape the sample was built to.
 *
 * Every lead lands in the week it first enquired, under its project, its
 * source and the campaign that bought it, and counts at each stage it has
 * reached. Media spend comes from the platforms' own daily figures for each
 * ad we published, so cost per lead and cost per booking are the developer's
 * own numbers rather than a model's.
 *
 * A booking a lead week has not produced yet is not invented: the cohort's
 * eventual figure is what has landed, grossed up by how far through its
 * booking window the week is, and a week too young to say is left as landed.
 */

type LeadRow = {
  created_at: Date;
  project: string;
  market: string | null;
  tower: string;
  channel: string;
  source: string;
  lineage: Lineage;
  campaign: string | null;
  creative: string | null;
  stage: string;
  path_stage: string;
  facts: Record<string, string>;
  reached: boolean;
  visited: boolean;
  cancelled: boolean;
  /** A channel partner holds, or held, this buyer. */
  partner: boolean;
  /** What the partner is owed for this booking, in rupees, when it booked. */
  commission: string | null;
};

const ORDER = ["new", "contacted", "qualified", "visit_scheduled", "visit_done", "negotiation", "booked"];
const at = (s: string) => ORDER.indexOf(s);

/** Which of the report's sources a lead counts under. */
export function sourceKey(channel: string, lineage: Lineage, source: string): string {
  if (channel === "META_FORM") return "meta";
  if (channel === "GOOGLE_FORM") return "google";
  if (channel === "PORTAL") return portalSourceKey(lineage.portal);
  const s =(lineage.utmSource ?? "").toLowerCase();
  if (/facebook|instagram|meta|^fb$|^ig$/.test(s)) return "meta";
  if (/google|adwords/.test(s) || lineage.gclid) return "google";
  if (channel === "WEBSITE") return "website";
  const t = source.toLowerCase();
  if (/99\s?acres/.test(t)) return "99acres";
  if (/magic\s?bricks/.test(t)) return "magicbricks";
  if (/housing/.test(t)) return "housing";
  if (/walk/.test(t)) return "walkin";
  if (/refer/.test(t)) return "referral";
  if (/partner|broker|\bcp\b/.test(t)) return "cp";
  return "manual";
}

/**
 * The campaign a publication belongs to: its brief, reached through the
 * post it was made from, or through a scheduled creative's run.
 */
const briefOf = (sql: import("postgres").TransactionSql) => sql`
  LEFT JOIN rendered_posts rp ON rp.id = t.rendered_post_id
  LEFT JOIN post_creatives pc ON pc.id = t.post_creative_id
  LEFT JOIN post_runs pr ON pr.id = pc.run_id
  LEFT JOIN post_schedules ps ON ps.id = pr.schedule_id
  LEFT JOIN campaign_briefs b ON b.id = coalesce(rp.brief_id, ps.brief_id, t.brief_id)`;

/** Where a campaign made in Ads Manager is counted before a person places it. */
const NOT_PLACED = "Not placed yet";

const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

export async function realReport(orgId: string, today: string, scopes: string[] | null = null): Promise<ReportData | null> {
  const [leads, spend, elsewhere] = await withTenant(orgId, (sql) =>
    Promise.all([
      sql<LeadRow[]>`
        SELECT l.created_at, coalesce(p.name, n.name) AS project, r.name AS market, n.name AS tower,
               l.channel, l.source, l.lineage,
               coalesce(b.name, t.headline) AS campaign, t.headline AS creative, l.stage, l.path_stage, l.facts,
               EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id AND c.connectivity = 'connected') AS reached,
               EXISTS (SELECT 1 FROM site_visits v WHERE v.lead_id = l.id AND v.status = 'VISITED') AS visited,
               EXISTS (SELECT 1 FROM lead_activity a WHERE a.lead_id = l.id AND a.kind = 'STAGE'
                         AND a.from_stage = 'booked' AND a.to_stage <> 'booked') AS cancelled,
               EXISTS (SELECT 1 FROM client_registrations cr WHERE cr.org_id = l.org_id AND cr.lead_id = l.id
                         AND cr.verdict = 'REGISTERED') AS partner,
               (SELECT round(pp.agreement * (pp.rate - pp.pass_back))::text FROM partner_payouts pp
                 WHERE pp.org_id = l.org_id AND pp.lead_id = l.id AND pp.kind = 'PARTNER' AND pp.payer_mandate_id IS NULL AND pp.cancelled_at IS NULL LIMIT 1) AS commission
        FROM leads l
        JOIN scope_nodes n ON n.id = l.scope_node_id
        LEFT JOIN scope_nodes p ON p.org_id = l.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
        LEFT JOIN scope_nodes r ON r.org_id = l.org_id AND r.kind = 'REGION' AND r.path @> n.path
        LEFT JOIN publish_targets t ON t.id = l.publish_target_id
        ${briefOf(sql)}
        WHERE l.org_id = ${orgId}
          AND ${scopes ? sql`n.path <@ ANY(${scopes}::ltree[])` : sql`true`}`,
      sql<{ day: string; spend: string; project: string; market: string | null; tower: string; destination: string; campaign: string; creative: string }[]>`
        SELECT s.day::text AS day, sum(s.spend_paise)::text AS spend, coalesce(p.name, n.name) AS project,
               r.name AS market, n.name AS tower, t.destination, coalesce(b.name, t.headline) AS campaign, t.headline AS creative
        FROM ad_stats s
        JOIN publish_targets t ON t.id = s.publish_target_id
        JOIN scope_nodes n ON n.id = t.phase_id
        LEFT JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
        LEFT JOIN scope_nodes r ON r.org_id = t.org_id AND r.kind = 'REGION' AND r.path @> n.path
        ${briefOf(sql)}
        WHERE s.org_id = ${orgId} AND s.spend_paise > 0
          AND ${scopes ? sql`n.path <@ ANY(${scopes}::ltree[])` : sql`true`}
        GROUP BY s.day, p.name, n.name, r.name, t.destination, b.name, t.headline`,
      // Campaigns made in Ads Manager: real money too. Counted on the tower a
      // person placed them on, or, for somebody who sees the whole
      // organisation, under "Not placed yet" until then.
      sql<{ day: string; spend: string; project: string | null; market: string | null; tower: string | null; campaign: string }[]>`
        SELECT s.day::text AS day, sum(s.spend_paise)::text AS spend, coalesce(p.name, n.name) AS project,
               r.name AS market, n.name AS tower, max(s.campaign_name) AS campaign
        FROM ad_campaign_stats s
        LEFT JOIN ad_campaign_places cp ON cp.account_id = s.account_id AND cp.campaign_id = s.campaign_id
        LEFT JOIN scope_nodes n ON n.id = cp.phase_id
        LEFT JOIN scope_nodes p ON p.org_id = s.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
        LEFT JOIN scope_nodes r ON r.org_id = s.org_id AND r.kind = 'REGION' AND r.path @> n.path
        WHERE s.org_id = ${orgId} AND s.publish_target_id IS NULL AND s.spend_paise > 0
          AND ${scopes ? sql`n.path <@ ANY(${scopes}::ltree[])` : sql`true`}
        GROUP BY s.day, s.account_id, s.campaign_id, p.name, n.name, r.name`,
    ]),
  );
  if (!leads.length) return null;

  const thisWeek = mondayOf(today);
  const weeks = Array.from({ length: WEEKS }, (_, i) => addDays(thisWeek, -7 * (WEEKS - 1 - i)));
  const first = weeks[0];
  const rows = new Map<string, Row>();
  const put = (week: string, place: { project: string; market: string | null; tower: string }, source: string, campaign: string, creative: string, c: Partial<Counts>) => {
    if (week < first) return;
    const market = place.market ?? "Not known";
    const k = `${week}|${place.project}|${place.tower}|${source}|${campaign}|${creative}`;
    const row = rows.get(k) ?? { week, project: place.project, market, tower: place.tower, source, campaign, creative, counts: { ...ZERO } };
    row.counts = add(row.counts, { ...ZERO, ...c });
    rows.set(k, row);
  };

  const cohorts: Cohort[] = weeks.map((week) => ({ week, leads: 0, eventual: 0 }));
  for (const l of leads) {
    const week = mondayOf(istDate(l.created_at));
    // A partner's buyer is the partner's row, costed in commission, unless an
    // ad of ours bought the lead: that one stays the ad's, costed in spend,
    // and the two are never added together.
    const bought = sourceKey(l.channel, l.lineage ?? {}, l.source);
    const source = l.partner && bought !== "meta" && bought !== "google" ? "cp" : bought;
    const campaign = l.campaign ?? l.lineage?.utmCampaign ?? l.source;
    const creative = l.creative ?? l.lineage?.utmContent ?? campaign;
    const p = at(l.path_stage);
    const booked = l.stage === "booked";
    put(week, l, source, campaign, creative, {
      leads: 1,
      reached: l.reached || p >= at("contacted") ? 1 : 0,
      qualified: p >= at("qualified") ? 1 : 0,
      visited: l.visited || p >= at("visit_done") ? 1 : 0,
      booked: booked ? 1 : 0,
      agreement: booked && l.facts?.agreement ? 1 : 0,
      cancelled: l.cancelled && !booked ? 1 : 0,
      commission: source === "cp" && booked && l.commission ? Number(l.commission) : 0,
    });
    const c = cohorts.find((x) => x.week === week);
    if (c) {
      c.leads += 1;
      if (booked) c.eventual += 1;
    }
  }
  // A week's eventual bookings: what landed, over how much of it could have.
  cohorts.forEach((c, i) => {
    const m = matured(WEEKS - 1 - i);
    if (m >= 0.05) c.eventual = c.eventual / m;
  });

  for (const s of spend) {
    const source = s.destination.startsWith("GOOGLE") ? "google" : "meta";
    put(mondayOf(s.day), s, source, s.campaign, s.creative, { spend: Math.round(Number(s.spend) / 100) });
  }
  for (const s of elsewhere) {
    const place = { project: s.project ?? NOT_PLACED, market: s.market, tower: s.tower ?? NOT_PLACED };
    put(mondayOf(s.day), place, "meta", s.campaign || "Meta campaign", s.campaign || "Meta campaign", { spend: Math.round(Number(s.spend) / 100) });
  }
  return { weeks, rows: [...rows.values()], cohorts };
}
