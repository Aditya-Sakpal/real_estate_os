import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import {
  DEFAULT_EXPLORE,
  DEFAULT_MARKET_WEIGHT,
  blend,
  creativeIngredients,
  marketScores,
  marketShare,
  ownScores,
  playbookLines,
  postIngredients,
  runningDays,
  valueLabel,
  type Blended,
  type Dim,
  type Ingredients,
  type MarketAd,
  type OwnAd,
  type PlaybookLine,
} from "./learning-rules.ts";
import { templateLabel, type TemplateKind } from "./template-rules.ts";

/**
 * The learning: our ads and the market's, scored and blended per project
 * and for the organisation, the playbook written from the scores, and the
 * scores read back wherever the next creative is made.
 * `learning-rules.ts` decides; this reads and writes.
 *
 * Worked out once a day by the lead worker, and again at once for a project
 * whenever somebody saves or removes a competitor's ad, so the card on the
 * brief moves when they do. It is a few queries and arithmetic: no model is
 * asked, and nothing here costs anything but the database.
 */

/** How far back our own ads are read. Older ones describe a different market. */
export const LEARN_DAYS = 180;

export type Settings = { marketWeight: number; explore: number };

async function settingsIn(sql: TransactionSql, orgId: string): Promise<Settings> {
  const [s] = await sql<{ market_weight: number; explore_share: string }[]>`
    SELECT market_weight, explore_share::text FROM learning_settings WHERE org_id = ${orgId}`;
  return s ? { marketWeight: s.market_weight, explore: Number(s.explore_share) } : { marketWeight: DEFAULT_MARKET_WEIGHT, explore: DEFAULT_EXPLORE };
}

export async function learningSettings(orgId: string): Promise<Settings> {
  return withTenant(orgId, (sql) => settingsIn(sql, orgId));
}

export async function saveLearningSettings(opts: { orgId: string; userId: string; marketWeight: number }): Promise<{ ok: boolean; message: string }> {
  const w = Math.round(opts.marketWeight);
  if (!Number.isFinite(w) || w < 0 || w > 500) return { ok: false, message: "Enter a number from 0 to 500." };
  await withTenant(opts.orgId, (sql) => sql`
    INSERT INTO learning_settings (org_id, market_weight, updated_by, updated_at)
    VALUES (${opts.orgId}, ${w}, ${opts.userId}, now())
    ON CONFLICT (org_id) DO UPDATE SET market_weight = EXCLUDED.market_weight, updated_by = EXCLUDED.updated_by, updated_at = now()`);
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "learning.weight", targetType: "org", targetId: opts.orgId, metadata: { marketWeight: w } });
  await refreshLearning(opts.orgId);
  return { ok: true, message: "Saved." };
}

type OwnRow = {
  project_path: string | null;
  spend: string;
  qualified: number;
  // From a post the studio made.
  post_kind: string | null;
  post_language: string | null;
  post_headline: string | null;
  post_template: string | null;
  post_prices: boolean | null;
  post_asset: string | null;
  // From a creative a schedule made.
  cr_kind: string | null;
  cr_language: string | null;
  cr_template: string | null;
  cr_lead: string | null;
  cr_headline: string | null;
  cr_asset: string | null;
  cr_occasion: boolean | null;
  asset_category: string | null;
};

type MarketRow = { project_path: string | null; city: string | null; tags: Ingredients; running_since: Date | string | null; seen_on: Date | string; flags: string[] };

const dayOf = (d: Date | string | null) => (d ? (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10)) : null);

function ownAd(r: OwnRow): OwnAd {
  const ingredients = r.post_kind
    ? postIngredients({
        kind: r.post_kind,
        language: r.post_language,
        headline: r.post_headline,
        templateKey: r.post_template,
        pictureCategory: r.asset_category,
        priceShown: !!r.post_prices,
      })
    : creativeIngredients({
        kind: r.cr_kind,
        language: r.cr_language,
        scheduledTemplate: r.cr_template,
        leadPoint: r.cr_lead,
        headline: r.cr_headline,
        pictureCategory: r.asset_category,
        occasion: !!r.cr_occasion,
      });
  return { ingredients, spend: Number(r.spend) / 100, qualified: r.qualified };
}

function marketAd(r: MarketRow): MarketAd {
  const { locality: _l, priceFrom: _p, ...ingredients } = (r.tags ?? {}) as Ingredients & { locality?: unknown; priceFrom?: unknown };
  return { ingredients, runningDays: runningDays(dayOf(r.running_since), dayOf(r.seen_on)!), flagged: (r.flags ?? []).length > 0 };
}

/**
 * Work out every project's scores and the organisation's, and replace what
 * was stored. Returns how many places were scored.
 */
export async function refreshLearning(orgId: string, now = new Date()): Promise<{ places: number; ownAds: number; marketAds: number }> {
  const since = new Date(now.getTime() - LEARN_DAYS * 86_400_000);
  return withTenant(orgId, async (sql) => {
    const [settings, own, saved, cities, root, projects] = await Promise.all([
      settingsIn(sql, orgId),
      sql<OwnRow[]>`
        SELECT (SELECT p.path::text FROM scope_nodes p WHERE p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> ph.path LIMIT 1) AS project_path,
               coalesce((SELECT sum(s.spend_paise) FROM ad_stats s WHERE s.publish_target_id = t.id AND s.day >= ${since.toISOString().slice(0, 10)}), 0)::text AS spend,
               (SELECT count(*)::int FROM leads l WHERE l.publish_target_id = t.id AND l.created_at >= ${since}
                  AND l.path_stage IN ('qualified', 'visit_scheduled', 'visit_done', 'negotiation', 'booked')) AS qualified,
               rp.kind AS post_kind, rp.language AS post_language, rp.headline AS post_headline,
               rp.inputs->'template'->>'key' AS post_template,
               (jsonb_array_length(coalesce(rp.inputs->'facts'->'prices', '[]'::jsonb)) > 0) AS post_prices,
               rp.inputs->'pictures'->0->>'assetId' AS post_asset,
               pc.kind AS cr_kind, pc.language AS cr_language, pc.template AS cr_template, pc.lead_point AS cr_lead,
               pc.headline AS cr_headline, pc.asset_id::text AS cr_asset, (pc.occasion_id IS NOT NULL) AS cr_occasion,
               (SELECT a.category FROM assets a WHERE a.org_id = t.org_id
                  AND a.id::text = coalesce(rp.inputs->'pictures'->0->>'assetId', pc.asset_id::text)) AS asset_category
        FROM publish_targets t
        JOIN scope_nodes ph ON ph.id = t.phase_id
        LEFT JOIN rendered_posts rp ON rp.id = t.rendered_post_id
        LEFT JOIN post_creatives pc ON pc.id = t.post_creative_id
        WHERE t.org_id = ${orgId} AND t.destination IN ('META_AD', 'GOOGLE_DISPLAY_AD', 'GOOGLE_DEMAND_GEN_AD')
          AND (rp.id IS NOT NULL OR pc.id IS NOT NULL)
          AND coalesce(t.activated_at, t.published_at, t.created_at) >= ${since}`,
      sql<MarketRow[]>`
        SELECT (SELECT p.path::text FROM scope_nodes p WHERE p.org_id = c.org_id AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project_path,
               NULL::text AS city, c.tags, c.running_since, c.seen_on, c.flags
        FROM competitor_ads c JOIN scope_nodes n ON n.id = c.scope_node_id
        WHERE c.org_id = ${orgId} AND c.read_state = 'READ'`,
      sql<{ project_path: string; city: string }[]>`
        SELECT p.path::text AS project_path, lower(r.name) AS city
        FROM scope_nodes p JOIN scope_nodes r ON r.org_id = p.org_id AND r.kind = 'REGION' AND r.path @> p.path
        WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT'`,
      sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`,
      sql<{ id: string; path: string }[]>`SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PROJECT'`,
    ]);
    const cityList = [...new Set(cities.map((c) => c.city))];
    const library = cityList.length
      ? await sql<MarketRow[]>`
          SELECT NULL::text AS project_path, lower(city) AS city, tags, running_since, seen_on, flags
          FROM market_ads WHERE lower(city) = ANY(${cityList})`
      : [];

    const ownAll = own.map((r) => ({ path: r.project_path, ad: ownAd(r) }));
    const marketAll = [...saved.map((r) => ({ path: r.project_path, city: null as string | null, ad: marketAd(r) })), ...library.map((r) => ({ path: null, city: r.city, ad: marketAd(r) }))];

    // The organisation first: every project's own score is pulled towards it.
    const orgOwn = ownScores(ownAll.map((x) => x.ad));
    const orgBlend = blend(orgOwn, marketScores(marketAll.map((x) => x.ad)), settings.marketWeight);
    const places: { id: string; scores: Blended[]; ownAds: number; marketAds: number }[] = [];
    if (root[0]) places.push({ id: root[0].id, scores: orgBlend, ownAds: ownAll.filter((x) => x.ad.spend > 0).length, marketAds: marketAll.length });
    for (const p of projects) {
      const city = cities.find((c) => c.project_path === p.path)?.city ?? null;
      const ownHere = ownAll.filter((x) => x.path === p.path).map((x) => x.ad);
      const marketHere = marketAll.filter((x) => x.path === p.path || (x.city !== null && x.city === city)).map((x) => x.ad);
      const prior = (d: Dim, v: string) => orgOwn.get(`${d}|${v}`)?.score ?? 1;
      places.push({
        id: p.id,
        scores: blend(ownScores(ownHere, prior), marketScores(marketHere), settings.marketWeight),
        ownAds: ownHere.filter((a) => a.spend > 0).length,
        marketAds: marketHere.length,
      });
    }

    await sql`DELETE FROM learning_scores WHERE org_id = ${orgId}`;
    for (const place of places) {
      for (const s of place.scores) {
        await sql`
          INSERT INTO learning_scores (org_id, scope_node_id, dim, value, own_qualified, own_spend, own_ads, own_score,
                                       market_ads, market_score, market_share, market_weight, blended, computed_at)
          VALUES (${orgId}, ${place.id}, ${s.dim}, ${s.value.slice(0, 60)}, ${s.own?.qualified ?? 0}, ${s.own?.spend ?? 0}, ${s.own?.ads ?? 0},
                  ${s.own?.score ?? 1}, ${s.market?.weight ?? 0}, ${s.market?.score ?? 1}, ${s.market?.share ?? 0}, ${s.marketWeight},
                  ${s.score}, ${now})`;
      }
      const qualified = place.scores.filter((s) => s.dim === "format").reduce((n, s) => n + (s.own?.qualified ?? 0), 0);
      await sql`
        INSERT INTO playbooks (scope_node_id, org_id, lines, own_ads, market_ads, market_weight, written_at)
        VALUES (${place.id}, ${orgId}, ${sql.json(playbookLines(place.scores, designName) as never)}, ${place.ownAds}, ${place.marketAds},
                ${marketShare(settings.marketWeight, qualified)}, ${now})
        ON CONFLICT (scope_node_id) DO UPDATE SET lines = EXCLUDED.lines, own_ads = EXCLUDED.own_ads, market_ads = EXCLUDED.market_ads,
          market_weight = EXCLUDED.market_weight, written_at = EXCLUDED.written_at`;
    }
    return { places: places.length, ownAds: ownAll.length, marketAds: marketAll.length };
  });
}

/** A design category's name, from its kind-qualified value. */
export function designName(value: string): string | null {
  const [kind, key] = value.split(":");
  if (kind === "SCHEDULED") {
    return { PRICE_REVEAL: "price reveal posts", THREE_THINGS: "three-point posts", WALKTHROUGH: "walkthrough posts", LOCATION_LED: "location posts", PROGRESS: "progress posts" }[key] ?? null;
  }
  const label = templateLabel(key, kind as TemplateKind);
  return label ? `the ${label.toLowerCase()} design` : null;
}

/** Once a day, from the worker. Skipped if it ran in the last 20 hours. */
export async function dailyLearningPass(orgId: string, now = new Date()): Promise<boolean> {
  const [last] = await withTenant(orgId, (sql) => sql<{ at: Date | null }[]>`
    SELECT max(written_at) AS at FROM playbooks WHERE org_id = ${orgId}`);
  if (last?.at && now.getTime() - last.at.getTime() < 20 * 3_600_000) return false;
  await refreshLearning(orgId, now);
  return true;
}

export type Learning = {
  /** The place the scores are for: this project, or the organisation when it has none. */
  scopeNodeId: string | null;
  place: "PROJECT" | "ORG" | null;
  scores: Blended[];
  playbook: PlaybookLine[];
  ownAds: number;
  marketAds: number;
  /** How much the market counts here overall, 0 to 1. */
  marketWeight: number;
  settings: Settings;
  writtenAt: string | null;
};

type ScoreRow = {
  dim: Dim;
  value: string;
  own_qualified: number;
  own_spend: string;
  own_ads: number;
  own_score: string;
  market_ads: string;
  market_score: string;
  market_share: string;
  market_weight: string;
  blended: string;
};

const EMPTY: Omit<Learning, "settings"> = { scopeNodeId: null, place: null, scores: [], playbook: [], ownAds: 0, marketAds: 0, marketWeight: 1, writtenAt: null };

/**
 * The scores in force for a node: its project's, or the organisation's when
 * the project has not been scored. A tower reads its project's.
 */
export async function learningFor(orgId: string, nodeId: string): Promise<Learning> {
  return withTenant(orgId, async (sql) => {
    const [settings, places] = await Promise.all([
      settingsIn(sql, orgId),
      sql<{ id: string; kind: "PROJECT" | "ORG" }[]>`
        SELECT a.id, a.kind FROM scope_nodes a
        WHERE a.org_id = ${orgId} AND a.kind IN ('PROJECT', 'ORG')
          AND a.path @> (SELECT path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId})
        ORDER BY nlevel(a.path) DESC`,
    ]);
    for (const place of places) {
      const [book] = await sql<{ lines: PlaybookLine[]; own_ads: number; market_ads: number; market_weight: string; written_at: Date }[]>`
        SELECT lines, own_ads, market_ads, market_weight::text, written_at FROM playbooks WHERE org_id = ${orgId} AND scope_node_id = ${place.id}`;
      if (!book || (book.own_ads === 0 && book.market_ads === 0 && place.kind === "PROJECT")) continue;
      const rows = await sql<ScoreRow[]>`
        SELECT dim, value, own_qualified, own_spend::text, own_ads, own_score::text, market_ads::text, market_score::text,
               market_share::text, market_weight::text, blended::text
        FROM learning_scores WHERE org_id = ${orgId} AND scope_node_id = ${place.id}`;
      return {
        scopeNodeId: place.id,
        place: place.kind,
        scores: rows.map((r) => ({
          dim: r.dim,
          value: r.value,
          own: r.own_ads ? { qualified: r.own_qualified, spend: Number(r.own_spend), ads: r.own_ads, score: Number(r.own_score) } : null,
          market: Number(r.market_ads) > 0
            ? { ads: Math.ceil(Number(r.market_ads)), weight: Number(r.market_ads), share: Number(r.market_share), score: Number(r.market_score) }
            : null,
          marketWeight: Number(r.market_weight),
          score: Number(r.blended),
        })),
        playbook: book.lines ?? [],
        ownAds: book.own_ads,
        marketAds: book.market_ads,
        marketWeight: Number(book.market_weight),
        settings,
        writtenAt: book.written_at.toISOString(),
      };
    }
    return { ...EMPTY, settings };
  });
}

/** Asset categories by id, for scoring the pictures a schedule chooses between. */
export async function assetCategories(orgId: string, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; category: string }[]>`
    SELECT id, category FROM assets WHERE org_id = ${orgId} AND id = ANY(${[...ids]})`);
  return new Map(rows.map((r) => [r.id, r.category]));
}

/** "Carousels", "location and connectivity": a value as the card shows it. */
export const showValue = (dim: Dim, value: string) => valueLabel(dim, value, designName);
