import { audit, withTenant } from "./db/index.ts";
import { markBroken, tokenFor } from "./connect.ts";
import { metaAccountDailyStats, metaDailyStats, metaWindowStats, setMetaBudget, type DayStat } from "./meta.ts";
import { googleDailyStats, setGoogleBudget } from "./google.ts";
import { BUDGET, adHealth, planShifts, type AdPerf, type Health, type Shift } from "./budget-rules.ts";
import type { R } from "./platform.ts";

/**
 * What each live ad spent and brought, and moving budget between them: the
 * reads and writes around `budget-rules.ts`.
 *
 * Two passes a day at most, from the worker. The first reads the platforms'
 * own daily figures into `ad_stats`. The second, only for an ad account
 * somebody holding `campaign.budget:manage` switched on, moves money from
 * the ads bringing nothing to the ones bringing buyers, keeping the total
 * the same. Every move is a `budget_shifts` row and an audit row carrying
 * the numbers the rule read, never a sentence.
 */

type Live = {
  id: string;
  destination: "META_AD" | "GOOGLE_DISPLAY_AD" | "GOOGLE_SEARCH_AD" | "GOOGLE_PMAX_AD" | "GOOGLE_DEMAND_GEN_AD";
  account_id: string;
  steps: Record<string, unknown>;
  daily_budget: number;
  state: string;
  external_id: string;
  detail: Record<string, unknown>;
  daily_cap: number | null;
  auto_budget: boolean;
  project_path: string | null;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

async function liveAds(orgId: string, since: Date): Promise<Live[]> {
  return withTenant(orgId, (sql) => sql<Live[]>`
    SELECT t.id, t.destination, t.account_id, t.steps, t.daily_budget, t.state,
           a.external_id, a.detail, a.daily_cap, a.auto_budget,
           (SELECT p.path::text FROM scope_nodes p WHERE p.org_id = t.org_id AND p.kind = 'PROJECT'
              AND p.path @> (SELECT path FROM scope_nodes WHERE id = t.phase_id) LIMIT 1) AS project_path
    FROM publish_targets t JOIN connection_accounts a ON a.id = t.account_id
    WHERE t.org_id = ${orgId} AND t.destination IN ('META_AD', 'GOOGLE_DISPLAY_AD', 'GOOGLE_SEARCH_AD', 'GOOGLE_PMAX_AD', 'GOOGLE_DEMAND_GEN_AD')
      AND (t.state = 'ACTIVE' OR (t.state = 'PAUSED' AND t.activated_at > ${since}))
      AND t.daily_budget IS NOT NULL`);
}

/** Read the last week of each live ad's figures from its platform. */
export async function syncAdStats(orgId: string, now = new Date()): Promise<{ ads: number; failed: number }> {
  const since = new Date(now.getTime() - BUDGET.windowDays * 86_400_000);
  const ads = await liveAds(orgId, since);
  let failed = 0;
  for (const ad of ads) {
    const cred = await tokenFor(orgId, ad.account_id);
    if (!cred.ok) {
      failed += 1;
      continue;
    }
    let rows: R<DayStat[]>;
    let window: { reach: number; impressions: number; frequency: number | null } | null = null;
    if (ad.destination === "META_AD") {
      const campaign = typeof ad.steps.campaign_id === "string" ? ad.steps.campaign_id : null;
      rows = campaign ? await metaDailyStats(cred.token, campaign, day(since), day(now)) : { ok: true, value: [] };
      // Frequency is reach over the window, which daily rows cannot give.
      if (campaign && rows.ok) {
        const w = await metaWindowStats(cred.token, campaign, day(since), day(now));
        if (w.ok) window = w.value;
      }
    } else {
      rows = await googleDailyStats({
        access: cred.token,
        customerId: ad.external_id,
        login: typeof ad.detail.login_customer_id === "string" ? ad.detail.login_customer_id : null,
        steps: ad.steps,
        since: day(since),
        until: day(now),
      });
    }
    if (!rows.ok) {
      if (rows.code === "TOKEN_INVALID" || rows.code === "PERMISSION") await markBroken(orgId, cred.connectionId, rows);
      failed += 1;
      continue;
    }
    await withTenant(orgId, async (sql) => {
      for (const r of rows.value) {
        await sql`
          INSERT INTO ad_stats (org_id, publish_target_id, day, spend_paise, impressions, clicks, platform_leads, fetched_at)
          VALUES (${orgId}, ${ad.id}, ${r.day}, ${r.spendPaise}, ${r.impressions}, ${r.clicks}, ${r.leads}, now())
          ON CONFLICT (publish_target_id, day) DO UPDATE SET
            spend_paise = EXCLUDED.spend_paise, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
            platform_leads = EXCLUDED.platform_leads, fetched_at = now()`;
      }
      if (window) {
        await sql`
          INSERT INTO ad_windows (publish_target_id, org_id, since, until, reach, impressions, frequency, fetched_at)
          VALUES (${ad.id}, ${orgId}, ${day(since)}, ${day(now)}, ${window.reach}, ${window.impressions}, ${window.frequency}, now())
          ON CONFLICT (publish_target_id) DO UPDATE SET since = EXCLUDED.since, until = EXCLUDED.until, reach = EXCLUDED.reach,
            impressions = EXCLUDED.impressions, frequency = EXCLUDED.frequency, fetched_at = now()`;
      }
      // Stamped even on a day with no figures, so the pass knows it looked.
      if (!rows.value.length) {
        await sql`
          INSERT INTO ad_stats (org_id, publish_target_id, day, fetched_at)
          VALUES (${orgId}, ${ad.id}, ${day(now)}, now())
          ON CONFLICT (publish_target_id, day) DO UPDATE SET fetched_at = now()`;
      }
    });
  }
  return { ads: ads.length, failed };
}

/** How often an ad account's spend is read: every pass would be the same numbers. */
export const SPEND_EVERY_MS = 30 * 60_000;
/** The first read of an account goes back this far; later ones a week, which Meta still revises. */
const SPEND_FIRST_DAYS = 90;
const SPEND_AGAIN_DAYS = 7;

/**
 * What every connected Meta ad account spent, per campaign per day, whoever
 * made the campaign. One request per account, at most every half hour. A
 * campaign of ours is written to `ad_stats` too, under its publication, so
 * the Published screen, Ask Jimmy and the learning see it the same day; the
 * rest are kept in `ad_campaign_stats` for Reports, placed on a tower by
 * `ad_campaign_places`.
 */
export async function syncAccountSpend(orgId: string, now = new Date()): Promise<{ accounts: number; rows: number; failed: number }> {
  const accounts = await withTenant(orgId, (sql) => sql<{ id: string; external_id: string; last: Date | null }[]>`
    SELECT a.id, a.external_id,
           (SELECT max(s.fetched_at) FROM ad_campaign_stats s WHERE s.account_id = a.id) AS last
    FROM connection_accounts a JOIN connections c ON c.id = a.connection_id
    WHERE a.org_id = ${orgId} AND a.kind = 'META_AD_ACCOUNT' AND a.active AND c.status = 'CONNECTED'`);
  let rows = 0;
  let failed = 0;
  let read = 0;
  for (const a of accounts) {
    if (a.last && now.getTime() - a.last.getTime() < SPEND_EVERY_MS) continue;
    const cred = await tokenFor(orgId, a.id);
    if (!cred.ok) {
      failed += 1;
      continue;
    }
    const back = a.last ? SPEND_AGAIN_DAYS : SPEND_FIRST_DAYS;
    const got = await metaAccountDailyStats(cred.token, a.external_id, day(new Date(now.getTime() - back * 86_400_000)), day(now));
    if (!got.ok) {
      if (got.code === "TOKEN_INVALID" || got.code === "PERMISSION") await markBroken(orgId, cred.connectionId, got);
      failed += 1;
      continue;
    }
    read += 1;
    await withTenant(orgId, async (sql) => {
      const ours = await sql<{ id: string; campaign: string }[]>`
        SELECT id, steps->>'campaign_id' AS campaign FROM publish_targets
        WHERE org_id = ${orgId} AND account_id = ${a.id} AND destination = 'META_AD' AND steps ? 'campaign_id'`;
      const target = new Map(ours.map((t) => [t.campaign, t.id]));
      for (const r of got.value) {
        const t = target.get(r.campaignId) ?? null;
        await sql`
          INSERT INTO ad_campaign_stats (org_id, account_id, campaign_id, campaign_name, day, spend_paise, impressions, clicks, platform_leads, publish_target_id, fetched_at)
          VALUES (${orgId}, ${a.id}, ${r.campaignId}, ${r.campaignName}, ${r.day}, ${r.spendPaise}, ${r.impressions}, ${r.clicks}, ${r.leads}, ${t}, now())
          ON CONFLICT (account_id, campaign_id, day) DO UPDATE SET
            campaign_name = EXCLUDED.campaign_name, spend_paise = EXCLUDED.spend_paise, impressions = EXCLUDED.impressions,
            clicks = EXCLUDED.clicks, platform_leads = EXCLUDED.platform_leads, publish_target_id = EXCLUDED.publish_target_id,
            fetched_at = now()`;
        if (t) {
          await sql`
            INSERT INTO ad_stats (org_id, publish_target_id, day, spend_paise, impressions, clicks, platform_leads, fetched_at)
            VALUES (${orgId}, ${t}, ${r.day}, ${r.spendPaise}, ${r.impressions}, ${r.clicks}, ${r.leads}, now())
            ON CONFLICT (publish_target_id, day) DO UPDATE SET
              spend_paise = EXCLUDED.spend_paise, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
              platform_leads = EXCLUDED.platform_leads, fetched_at = now()`;
        }
        rows += 1;
      }
      // Stamped even when the account spent nothing, so it is not asked again at once.
      if (!got.value.length) {
        await sql`
          INSERT INTO ad_campaign_stats (org_id, account_id, campaign_id, day, fetched_at)
          VALUES (${orgId}, ${a.id}, '0', ${day(now)}, now())
          ON CONFLICT (account_id, campaign_id, day) DO UPDATE SET fetched_at = now()`;
      }
    });
  }
  return { accounts: read, rows, failed };
}

type PerfRow = {
  id: string;
  spend: string;
  clicks: string;
  live_days: number;
  leads: number;
  qualified: number;
  last_shift: Date | null;
};

/** The figures the rule reads, per ad, over the window. */
async function perf(orgId: string, ids: string[], now: Date): Promise<Map<string, PerfRow>> {
  const since = new Date(now.getTime() - BUDGET.windowDays * 86_400_000);
  const rows = await withTenant(orgId, (sql) => sql<PerfRow[]>`
    SELECT t.id,
           coalesce((SELECT sum(s.spend_paise) FROM ad_stats s WHERE s.publish_target_id = t.id AND s.day >= ${day(since)}), 0)::text AS spend,
           coalesce((SELECT sum(s.clicks) FROM ad_stats s WHERE s.publish_target_id = t.id AND s.day >= ${day(since)}), 0)::text AS clicks,
           (SELECT count(*)::int FROM ad_stats s WHERE s.publish_target_id = t.id AND s.day >= ${day(since)} AND s.spend_paise > 0) AS live_days,
           (SELECT count(*)::int FROM leads l WHERE l.publish_target_id = t.id AND l.created_at >= ${since}) AS leads,
           (SELECT count(*)::int FROM leads l WHERE l.publish_target_id = t.id AND l.created_at >= ${since}
              AND l.path_stage IN ('qualified', 'visit_scheduled', 'visit_done', 'negotiation', 'booked')) AS qualified,
           (SELECT max(b.created_at) FROM budget_shifts b WHERE b.publish_target_id = t.id AND b.state = 'APPLIED') AS last_shift
    FROM publish_targets t WHERE t.org_id = ${orgId} AND t.id = ANY(${ids})`);
  return new Map(rows.map((r) => [r.id, r]));
}

async function applyBudget(orgId: string, ad: Live, rupees: number): Promise<{ ok: true } | { ok: false; message: string }> {
  const cred = await tokenFor(orgId, ad.account_id);
  if (!cred.ok) return { ok: false, message: cred.message };
  const r =
    ad.destination === "META_AD"
      ? await setMetaBudget(cred.token, ad.steps, rupees)
      : await setGoogleBudget({
          access: cred.token,
          customerId: ad.external_id,
          login: typeof ad.detail.login_customer_id === "string" ? ad.detail.login_customer_id : null,
          steps: ad.steps,
          rupees,
        });
  if (!r.ok) {
    if (r.code === "TOKEN_INVALID" || r.code === "PERMISSION") await markBroken(orgId, cred.connectionId, r);
    return { ok: false, message: r.message };
  }
  return { ok: true };
}

async function recordShift(orgId: string, ad: Live, s: Shift, to: number, error: string | null): Promise<void> {
  await withTenant(orgId, async (sql) => {
    await sql`
      INSERT INTO budget_shifts (org_id, account_id, publish_target_id, from_budget, to_budget, rule, metrics, state, error)
      VALUES (${orgId}, ${ad.account_id}, ${ad.id}, ${s.from}, ${to}, ${s.rule}, ${sql.json(s.metrics as never)},
              ${error ? "FAILED" : "APPLIED"}, ${error?.slice(0, 500) ?? null})`;
    if (!error) {
      await sql`UPDATE publish_targets SET daily_budget = ${to}, updated_at = now() WHERE org_id = ${orgId} AND id = ${ad.id}`;
    }
  });
  await audit({
    orgId,
    actorUserId: null,
    action: error ? "budget.shift_failed" : "budget.shifted",
    targetType: "publish_target",
    targetId: ad.id,
    metadata: { from: s.from, to, rule: s.rule, metric: s.metrics.metric, cost: s.metrics.cost, groupCost: s.metrics.groupCost },
  });
}

/**
 * Move budget inside each group of live ads: one ad account, one project,
 * only where that account's switch is on. The decreases go first, and the
 * increases never add more than the decreases actually freed, so a platform
 * that refuses one change cannot leave the total higher than it was.
 */
export async function rebalanceBudgets(orgId: string, now = new Date()): Promise<{ groups: number; shifts: number; failed: number }> {
  const since = new Date(now.getTime() - BUDGET.windowDays * 86_400_000);
  const ads = (await liveAds(orgId, since)).filter((a) => a.state === "ACTIVE" && a.auto_budget);
  const groups = new Map<string, Live[]>();
  for (const a of ads) {
    const k = `${a.account_id}|${a.project_path ?? a.id}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out = { groups: 0, shifts: 0, failed: 0 };
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    out.groups += 1;
    const figures = await perf(orgId, group.map((a) => a.id), now);
    const input: AdPerf[] = group.map((a) => {
      const f = figures.get(a.id);
      return {
        targetId: a.id,
        dailyBudget: a.daily_budget,
        cap: a.daily_cap,
        spendPaise: Number(f?.spend ?? 0),
        clicks: Number(f?.clicks ?? 0),
        leads: f?.leads ?? 0,
        qualified: f?.qualified ?? 0,
        liveDays: f?.live_days ?? 0,
        lastShiftAt: f?.last_shift?.toISOString() ?? null,
      };
    });
    const shifts = planShifts(input, now.toISOString());
    if (!shifts.length) continue;
    const byId = new Map(group.map((a) => [a.id, a]));
    let freed = 0;
    for (const s of shifts.filter((x) => x.rule === "SCALE_DOWN")) {
      const ad = byId.get(s.targetId)!;
      const r = await applyBudget(orgId, ad, s.to);
      await recordShift(orgId, ad, s, s.to, r.ok ? null : r.message);
      if (r.ok) {
        freed += s.from - s.to;
        out.shifts += 1;
      } else out.failed += 1;
    }
    for (const s of shifts.filter((x) => x.rule === "SCALE_UP")) {
      if (freed <= 0) break;
      const ad = byId.get(s.targetId)!;
      const add = Math.min(s.to - s.from, freed);
      const to = s.from + add;
      const r = await applyBudget(orgId, ad, to);
      await recordShift(orgId, ad, s, to, r.ok ? null : r.message);
      if (r.ok) {
        freed -= add;
        out.shifts += 1;
      } else out.failed += 1;
    }
  }
  return out;
}

/** Once a day: read the figures, then move budget. Skipped if it ran in the last 20 hours. */
export async function dailyBudgetPass(orgId: string, now = new Date()): Promise<{ ran: boolean; ads: number; shifts: number }> {
  const [last] = await withTenant(orgId, (sql) => sql<{ at: Date | null }[]>`
    SELECT ran_at AS at FROM ad_budget_passes WHERE org_id = ${orgId}`);
  if (last?.at && now.getTime() - last.at.getTime() < 20 * 3_600_000) return { ran: false, ads: 0, shifts: 0 };
  const synced = await syncAdStats(orgId, now);
  if (!synced.ads) return { ran: false, ads: 0, shifts: 0 };
  await withTenant(orgId, (sql) => sql`
    INSERT INTO ad_budget_passes (org_id, ran_at) VALUES (${orgId}, ${now})
    ON CONFLICT (org_id) DO UPDATE SET ran_at = EXCLUDED.ran_at`);
  const moved = await rebalanceBudgets(orgId, now);
  return { ran: true, ads: synced.ads, shifts: moved.shifts };
}

/** Switch automatic budget moves on or off for one ad account. */
export async function setAutoBudget(opts: { orgId: string; userId: string; accountId: string; on: boolean }): Promise<{ ok: boolean; message: string }> {
  const r = await withTenant(opts.orgId, (sql) => sql`
    UPDATE connection_accounts SET auto_budget = ${opts.on}, auto_budget_by = ${opts.userId}, auto_budget_at = now(), updated_at = now()
    WHERE org_id = ${opts.orgId} AND id = ${opts.accountId} AND kind IN ('META_AD_ACCOUNT', 'GOOGLE_ADS_CUSTOMER') AND active`);
  if (!r.count) return { ok: false, message: "That ad account is not connected." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: opts.on ? "budget.auto_on" : "budget.auto_off", targetType: "connection_account", targetId: opts.accountId });
  return { ok: true, message: opts.on ? "Budget will move to the ads that bring buyers." : "Budgets stay where they are." };
}

// ---------------------------------------------------------------------------
// Reading, for the Published screen
// ---------------------------------------------------------------------------

export type AdFigures = {
  spend: number;
  clicks: number;
  leads: number;
  qualified: number;
  visits: number;
  bookings: number;
  costPerLead: number | null;
  costPerQualified: number | null;
  shifts: { at: string; from: number; to: number; rule: string; state: string }[];
  /** Tiring, or costing far more than the ads beside it. */
  health: Health;
};

export async function adFigures(orgId: string, targetIds: string[], now = new Date()): Promise<Map<string, AdFigures>> {
  if (!targetIds.length) return new Map();
  // Spend and what it bought over the same 30 days, so cost per lead is one period's.
  const sinceAt = new Date(now.getTime() - 30 * 86_400_000);
  const since = day(sinceAt);
  const rows = await withTenant(orgId, (sql) => sql<
    { id: string; spend: string; clicks: string; leads: number; qualified: number; visits: number; bookings: number; shifts: { at: string; from: number; to: number; rule: string; state: string }[] | null }[]
  >`
    SELECT t.id,
           coalesce((SELECT sum(s.spend_paise) FROM ad_stats s WHERE s.publish_target_id = t.id AND s.day >= ${since}), 0)::text AS spend,
           coalesce((SELECT sum(s.clicks) FROM ad_stats s WHERE s.publish_target_id = t.id AND s.day >= ${since}), 0)::text AS clicks,
           (SELECT count(*)::int FROM leads l WHERE l.publish_target_id = t.id AND l.created_at >= ${sinceAt}) AS leads,
           (SELECT count(*)::int FROM leads l WHERE l.publish_target_id = t.id AND l.created_at >= ${sinceAt}
              AND l.path_stage IN ('qualified', 'visit_scheduled', 'visit_done', 'negotiation', 'booked')) AS qualified,
           (SELECT count(*)::int FROM site_visits v JOIN leads l ON l.id = v.lead_id
              WHERE l.publish_target_id = t.id AND l.created_at >= ${sinceAt} AND v.status = 'VISITED') AS visits,
           (SELECT count(*)::int FROM leads l WHERE l.publish_target_id = t.id AND l.created_at >= ${sinceAt} AND l.stage = 'booked') AS bookings,
           (SELECT json_agg(json_build_object('at', b.created_at, 'from', b.from_budget, 'to', b.to_budget, 'rule', b.rule, 'state', b.state)
                            ORDER BY b.created_at DESC)
              FROM (SELECT * FROM budget_shifts WHERE publish_target_id = t.id ORDER BY created_at DESC LIMIT 5) b) AS shifts
    FROM publish_targets t WHERE t.org_id = ${orgId} AND t.id = ANY(${targetIds})`);
  const health = await healthOf(orgId, targetIds, now);
  return new Map(
    rows.map((r) => {
      const spend = Number(r.spend) / 100;
      return [
        r.id,
        {
          spend,
          clicks: Number(r.clicks),
          leads: r.leads,
          qualified: r.qualified,
          visits: r.visits,
          bookings: r.bookings,
          costPerLead: r.leads ? Math.round(spend / r.leads) : null,
          costPerQualified: r.qualified ? Math.round(spend / r.qualified) : null,
          shifts: r.shifts ?? [],
          health: health.get(r.id) ?? { refresh: null, frequency: null, ctrDrop: null, pause: false },
        },
      ];
    }),
  );
}

/**
 * Each ad's health beside the others that share its ad account and project,
 * over the budget pass's own window, so a pause is proposed on the evidence
 * a budget move would need and never on less.
 */
async function healthOf(orgId: string, ids: string[], now: Date): Promise<Map<string, Health>> {
  const [places, days, windows] = await withTenant(orgId, (sql) =>
    Promise.all([
      sql<{ id: string; account_id: string; project_path: string | null; daily_budget: number | null; cap: number | null }[]>`
        SELECT t.id, t.account_id, t.daily_budget, a.daily_cap AS cap,
               (SELECT p.path::text FROM scope_nodes p WHERE p.org_id = t.org_id AND p.kind = 'PROJECT'
                  AND p.path @> (SELECT path FROM scope_nodes WHERE id = t.phase_id) LIMIT 1) AS project_path
        FROM publish_targets t JOIN connection_accounts a ON a.id = t.account_id
        WHERE t.org_id = ${orgId} AND t.id = ANY(${ids})`,
      sql<{ publish_target_id: string; day: string; impressions: string; clicks: string }[]>`
        SELECT publish_target_id, day::text AS day, impressions::text, clicks::text FROM ad_stats
        WHERE org_id = ${orgId} AND publish_target_id = ANY(${ids}) AND day >= ${day(new Date(now.getTime() - 120 * 86_400_000))}`,
      sql<{ publish_target_id: string; frequency: string | null }[]>`
        SELECT publish_target_id, frequency::text FROM ad_windows WHERE org_id = ${orgId} AND publish_target_id = ANY(${ids})`,
    ]),
  );
  const figures = await perf(orgId, ids, now);
  const perfOf = (id: string): AdPerf => {
    const f = figures.get(id);
    const p = places.find((x) => x.id === id);
    return {
      targetId: id,
      dailyBudget: p?.daily_budget ?? 0,
      cap: p?.cap ?? null,
      spendPaise: Number(f?.spend ?? 0),
      clicks: Number(f?.clicks ?? 0),
      leads: f?.leads ?? 0,
      qualified: f?.qualified ?? 0,
      liveDays: f?.live_days ?? 0,
      lastShiftAt: f?.last_shift?.toISOString() ?? null,
    };
  };
  const out = new Map<string, Health>();
  for (const p of places) {
    const group = places.filter((x) => x.account_id === p.account_id && (x.project_path ?? x.id) === (p.project_path ?? p.id)).map((x) => perfOf(x.id));
    const w = windows.find((x) => x.publish_target_id === p.id);
    out.set(
      p.id,
      adHealth({
        ad: perfOf(p.id),
        group,
        days: days.filter((d) => d.publish_target_id === p.id).map((d) => ({ day: d.day, impressions: Number(d.impressions), clicks: Number(d.clicks) })),
        frequency: w?.frequency === null || w?.frequency === undefined ? null : Number(w.frequency),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Campaigns made in Ads Manager
// ---------------------------------------------------------------------------

export type CampaignElsewhere = {
  accountId: string;
  accountName: string;
  campaignId: string;
  name: string;
  spend: number;
  platformLeads: number;
  leads: number;
  firstDay: string;
  lastDay: string;
  phaseId: string | null;
  phaseName: string | null;
  phasePath: string | null;
};

/**
 * Every campaign on a connected ad account that this product did not make
 * and that spent something, with where it is placed. Its leads here are
 * counted from their own lineage.
 */
export async function campaignsElsewhere(orgId: string): Promise<CampaignElsewhere[]> {
  const rows = await withTenant(orgId, (sql) => sql<
    { account_id: string; account_name: string; campaign_id: string; name: string; spend: string; platform_leads: number; leads: number; first_day: string; last_day: string; phase_id: string | null; phase_name: string | null; phase_path: string | null }[]
  >`
    SELECT s.account_id, a.name AS account_name, s.campaign_id, max(s.campaign_name) AS name,
           sum(s.spend_paise)::text AS spend, sum(s.platform_leads)::int AS platform_leads,
           (SELECT count(*)::int FROM leads l WHERE l.org_id = s.org_id AND l.lineage->>'campaignId' = s.campaign_id) AS leads,
           min(s.day)::text AS first_day, max(s.day)::text AS last_day,
           cp.phase_id, n.name AS phase_name, n.path::text AS phase_path
    FROM ad_campaign_stats s
    JOIN connection_accounts a ON a.id = s.account_id
    LEFT JOIN ad_campaign_places cp ON cp.account_id = s.account_id AND cp.campaign_id = s.campaign_id
    LEFT JOIN scope_nodes n ON n.id = cp.phase_id
    WHERE s.org_id = ${orgId} AND s.publish_target_id IS NULL AND s.campaign_id <> '0'
    GROUP BY s.org_id, s.account_id, a.name, s.campaign_id, cp.phase_id, n.name, n.path
    HAVING sum(s.spend_paise) > 0
    ORDER BY max(s.day) DESC, sum(s.spend_paise) DESC`);
  return rows.map((r) => ({
    accountId: r.account_id,
    accountName: r.account_name,
    campaignId: r.campaign_id,
    name: r.name || "Meta campaign",
    spend: Math.round(Number(r.spend) / 100),
    platformLeads: r.platform_leads,
    leads: r.leads,
    firstDay: r.first_day,
    lastDay: r.last_day,
    phaseId: r.phase_id,
    phaseName: r.phase_name,
    phasePath: r.phase_path,
  }));
}

/**
 * Place a campaign made in Ads Manager on a tower: its spend is counted
 * there, and its leads are filed there, including the ones already waiting
 * because nothing said where they belonged.
 */
export async function placeCampaign(opts: {
  orgId: string;
  userId: string;
  accountId: string;
  campaignId: string;
  phaseId: string;
}): Promise<{ ok: true; retried: number } | { ok: false; message: string }> {
  if (!/^[0-9]{1,30}$/.test(opts.campaignId)) return { ok: false, message: "That campaign is not on a connected ad account." };
  const done = await withTenant(opts.orgId, async (sql) => {
    const [known] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ad_campaign_stats
      WHERE org_id = ${opts.orgId} AND account_id = ${opts.accountId} AND campaign_id = ${opts.campaignId} AND publish_target_id IS NULL`;
    if (!known?.n) return null;
    const [phase] = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.phaseId} AND kind = 'PHASE'`;
    if (!phase) return null;
    await sql`
      INSERT INTO ad_campaign_places (org_id, account_id, campaign_id, phase_id, set_by)
      VALUES (${opts.orgId}, ${opts.accountId}, ${opts.campaignId}, ${opts.phaseId}, ${opts.userId})
      ON CONFLICT (account_id, campaign_id) DO UPDATE SET phase_id = EXCLUDED.phase_id, set_by = EXCLUDED.set_by, set_at = now()`;
    // Leads that waited for a place are worked again on the next pass.
    const retried = await sql`
      UPDATE lead_events SET attempts = 0, outcome = NULL, error = NULL
      WHERE org_id = ${opts.orgId} AND processed_at IS NULL AND outcome = 'FAILED'
        AND error LIKE 'Could not tell which tower%'`;
    return { retried: retried.count };
  });
  if (!done) return { ok: false, message: "That campaign or tower is not in this organisation." };
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "ads.campaign_placed",
    targetType: "scope_node",
    targetId: opts.phaseId,
    metadata: { campaignId: opts.campaignId, retried: done.retried },
  });
  return { ok: true, retried: done.retried };
}

/** Every tower, named with its project, for choosing where a campaign counts. */
export async function towersToPlace(orgId: string): Promise<{ id: string; label: string; path: string }[]> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; name: string; project: string | null; path: string }[]>`
    SELECT n.id, n.name, p.name AS project, n.path::text AS path
    FROM scope_nodes n
    LEFT JOIN scope_nodes p ON p.org_id = n.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
    WHERE n.org_id = ${orgId} AND n.kind = 'PHASE'
    ORDER BY p.name NULLS LAST, n.name`);
  return rows.map((r) => ({ id: r.id, label: r.project ? `${r.project} · ${r.name}` : r.name, path: r.path }));
}
