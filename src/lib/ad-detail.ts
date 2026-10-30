import { withTenant } from "./db/index.ts";
import { funnelVerdict, type FunnelVerdict } from "./funnel-rules.ts";
import { approvedUnits } from "./unit.ts";
import { priceFor } from "./unit-rules.ts";
import { isNodeId } from "./scope-rules.ts";
import { listPublications, type PublicationView } from "./publish.ts";
import { adFigures, type AdFigures } from "./ad-budget.ts";
import { fillDays, totalsOf, peerStanding, type AdDay, type AdTotals, type PeerStanding } from "./ad-detail-rules.ts";
import { verdictOf, type Outcome, type Tone } from "./call-rules.ts";
import type { StageKey } from "./lead-rules.ts";

/**
 * Everything one ad's page draws, read at once: the ad, its days, who saw
 * it, the leads it brought and how each call went, and its budget moves.
 * Its leads are only those the viewer may read; a lead's number never
 * leaves the server.
 */

export type AdLead = {
  id: string;
  name: string;
  stage: StageKey;
  createdAt: string;
  temperature: "HOT" | "WARM" | "COLD" | null;
  lastCall: { label: string; tone: Tone; at: string } | null;
};

export type AdShift = { at: string; from: number; to: number; rule: "SCALE_UP" | "SCALE_DOWN"; state: "APPLIED" | "FAILED" };

export type AdDetail = {
  ad: PublicationView;
  days: AdDay[];
  totals: AdTotals;
  /** Over the platform's own window, since reach does not add up across days. */
  reach: { people: number; frequency: number | null; since: string; until: string } | null;
  hotOrWarm: number;
  qualified: number;
  visits: number;
  bookings: number;
  /** Leads the viewer cannot open are counted, never listed. */
  leads: AdLead[];
  leadsHidden: number;
  standing: PeerStanding | null;
  shifts: AdShift[];
  health: AdFigures["health"] | null;
  /** What its leads became, against what the trade expects at this price. */
  funnel: FunnelVerdict;
};

/** Today on the IST calendar. */
const istToday = (now: Date) => now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const LIVE_CALL = ["PLACING", "DIALLING"];

export async function loadAdDetail(
  orgId: string,
  id: string,
  view: { campaignScopes: readonly string[]; leadScopes: readonly string[] },
  now = new Date(),
): Promise<AdDetail | null> {
  if (!isNodeId(id)) return null;
  const [ad] = await listPublications(orgId, { ids: [id], scopes: [...view.campaignScopes] });
  if (!ad || !ad.ad) return null;
  const leadScopes = [...view.leadScopes];

  const [[stats, leadDays, win, counts, leads, peers, shifts], figures] = await Promise.all([
    withTenant(orgId, (sql) =>
      Promise.all([
        sql<{ day: string; spend: string; impressions: string; clicks: string }[]>`
          SELECT day::text AS day, spend_paise::text AS spend, impressions::text, clicks::text
          FROM ad_stats WHERE org_id = ${orgId} AND publish_target_id = ${id}`,
        sql<{ day: string; n: number }[]>`
          SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day, count(*)::int AS n
          FROM leads WHERE org_id = ${orgId} AND publish_target_id = ${id} GROUP BY 1`,
        sql<{ since: string; until: string; reach: string; frequency: string | null }[]>`
          SELECT since::text, until::text, reach::text, frequency::text
          FROM ad_windows WHERE org_id = ${orgId} AND publish_target_id = ${id}`,
        sql<{ hot_or_warm: number; reached: number; qualified: number; visits: number; bookings: number }[]>`
          SELECT count(*) FILTER (WHERE l.temperature IN ('HOT', 'WARM'))::int AS hot_or_warm,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id
                   AND c.connectivity = 'connected' AND c.outcome IS DISTINCT FROM 'NO_ANSWER'))::int AS reached,
                 count(*) FILTER (WHERE l.path_stage IN ('qualified', 'visit_scheduled', 'visit_done', 'negotiation', 'booked'))::int AS qualified,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM site_visits v WHERE v.lead_id = l.id AND v.status = 'VISITED'))::int AS visits,
                 count(*) FILTER (WHERE l.stage = 'booked')::int AS bookings
          FROM leads l WHERE l.org_id = ${orgId} AND l.publish_target_id = ${id}`,
        leadScopes.length
          ? sql<
              {
                id: string;
                name: string;
                stage: StageKey;
                created_at: Date;
                temperature: AdLead["temperature"];
                status: string | null;
                outcome: string | null;
                call_temp: AdLead["temperature"];
                placed_at: Date | null;
                visible: number;
              }[]
            >`
              SELECT l.id, l.name, l.stage, l.created_at, l.temperature, (count(*) OVER ())::int AS visible,
                     c.status, c.outcome, c.temperature AS call_temp, c.placed_at
              FROM leads l
              JOIN scope_nodes n ON n.id = l.scope_node_id
              LEFT JOIN LATERAL (
                SELECT status, outcome, temperature, placed_at FROM calls
                WHERE lead_id = l.id ORDER BY placed_at DESC LIMIT 1
              ) c ON true
              WHERE l.org_id = ${orgId} AND l.publish_target_id = ${id} AND n.path <@ ${leadScopes}::ltree[]
              ORDER BY l.created_at DESC
              LIMIT 200`
          : Promise.resolve([]),
        // The other ads on the same account this person can see, over their whole run.
        sql<{ id: string; spend: string; leads: number }[]>`
          SELECT t.id,
                 coalesce((SELECT sum(s.spend_paise) FROM ad_stats s WHERE s.publish_target_id = t.id), 0)::text AS spend,
                 (SELECT count(*)::int FROM leads l WHERE l.publish_target_id = t.id) AS leads
          FROM publish_targets t JOIN scope_nodes n ON n.id = t.scope_node_id
          WHERE t.org_id = ${orgId} AND t.id <> ${id}
            AND t.account_id = (SELECT account_id FROM publish_targets WHERE id = ${id})
            AND n.path <@ ${[...view.campaignScopes]}::ltree[]
            AND EXISTS (SELECT 1 FROM ad_stats s WHERE s.publish_target_id = t.id AND s.spend_paise > 0)`,
        sql<{ created_at: Date; from_budget: number; to_budget: number; rule: AdShift["rule"]; state: AdShift["state"] }[]>`
          SELECT created_at, from_budget, to_budget, rule, state FROM budget_shifts
          WHERE org_id = ${orgId} AND publish_target_id = ${id} ORDER BY created_at DESC LIMIT 20`,
      ]),
    ),
    adFigures(orgId, [id], now),
  ]);
  const ticket = await cheapestAt(orgId, ad.phaseId);

  const rows: AdDay[] = [
    ...stats.map((s) => ({ day: s.day, spend: Number(s.spend) / 100, impressions: Number(s.impressions), clicks: Number(s.clicks), leads: 0 })),
    ...leadDays.map((l) => ({ day: l.day, spend: 0, impressions: 0, clicks: 0, leads: l.n })),
  ];
  const started = ad.publishedAt ? istToday(new Date(ad.publishedAt)) : null;
  const days = fillDays(rows, started, istToday(now));
  // The totals are the ad's whole run, not only the days drawn.
  const totals = totalsOf(rows);
  const c = counts[0];
  const w = win[0];

  return {
    ad,
    days,
    totals,
    reach: w ? { people: Number(w.reach), frequency: w.frequency === null ? null : Number(w.frequency), since: w.since, until: w.until } : null,
    hotOrWarm: c?.hot_or_warm ?? 0,
    qualified: c?.qualified ?? 0,
    visits: c?.visits ?? 0,
    bookings: c?.bookings ?? 0,
    leads: leads.map((l) => {
      const outcome = (
        l.status === null
          ? null
          : LIVE_CALL.includes(l.status)
            ? "CALLING"
            : l.status === "REFUSED"
              ? "NOT_PLACED"
              : l.outcome ?? "FAILED"
      ) as Outcome | null;
      const v = outcome ? verdictOf({ outcome, temp: l.call_temp }) : null;
      return {
        id: l.id,
        name: l.name,
        stage: l.stage,
        createdAt: l.created_at.toISOString(),
        temperature: l.temperature,
        lastCall: v && l.placed_at ? { label: v.label, tone: v.tone, at: l.placed_at.toISOString() } : null,
      };
    }),
    leadsHidden: Math.max(0, totals.leads - (leads[0]?.visible ?? 0)),
    standing: peerStanding(totals, peers.map((p) => ({ id: p.id, spend: Number(p.spend) / 100, leads: p.leads }))),
    shifts: shifts.map((s) => ({ at: s.created_at.toISOString(), from: s.from_budget, to: s.to_budget, rule: s.rule, state: s.state })),
    health: figures.get(id)?.health ?? null,
    funnel: funnelVerdict({
      spend: totals.spend,
      leads: totals.leads,
      reached: c?.reached ?? 0,
      qualified: c?.qualified ?? 0,
      visits: c?.visits ?? 0,
      bookings: c?.bookings ?? 0,
      ticket,
    }),
  };
}

/** The cheapest approved home at the ad's tower, the price its leads are judged against. */
async function cheapestAt(orgId: string, nodeId: string): Promise<number | null> {
  const { units, basePsf } = await approvedUnits(orgId, nodeId).catch(() => ({ units: [], basePsf: null }));
  const prices = units.map((u) => priceFor(u, basePsf)).filter((p): p is number => typeof p === "number" && p > 0);
  return prices.length ? Math.min(...prices) : null;
}
