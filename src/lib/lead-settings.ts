import { audit, withTenant } from "./db/index.ts";
import { leadScoring, type LeadSettings } from "./qualify.ts";
import { LOOKBACK_DAYS, lookbackProblem } from "./ownership-rules.ts";
import { WEIGHT_KEYS, readList, scoringProblem, type Weights } from "./qualification-rules.ts";

/**
 * The organisation's lead rules, as Settings shows and saves them: how long
 * an open lead may go quiet before a new enquiry is its own lead, how a call
 * is scored, the places and rival projects the reader listens for, and who
 * takes buyers calling from outside India. `org:manage`, audited per part.
 */

export type LeadRules = LeadSettings & {
  lookbackDays: number;
  /** Members who may be put on the NRI desk: active in the organisation. */
  members: { id: string; name: string }[];
};

export async function loadLeadRules(orgId: string): Promise<LeadRules> {
  const [scoring, rest] = await Promise.all([
    leadScoring(orgId),
    withTenant(orgId, async (sql) => {
      const [s] = await sql<{ lookback_days: number }[]>`SELECT lookback_days FROM lead_settings WHERE org_id = ${orgId}`;
      const members = await sql<{ id: string; name: string }[]>`
        SELECT DISTINCT u.id, coalesce(u.name, u.email::text) AS name
        FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ${orgId} AND m.status = 'ACTIVE' AND u.erased_at IS NULL
        ORDER BY 2`;
      return { lookbackDays: s?.lookback_days ?? LOOKBACK_DAYS, members };
    }),
  ]);
  return { ...scoring, ...rest };
}

export type RulesPart = "ownership" | "scoring" | "places" | "nri";

export type RulesInput = {
  lookback?: string;
  weights?: Record<string, string>;
  hot?: string;
  warm?: string;
  microMarkets?: string;
  competitors?: string;
  nriDesk?: string[];
};

/** Save one part of the rules. Every value is read and checked here, whatever the form sent. */
export async function saveLeadRules(o: { orgId: string; userId: string; part: RulesPart; input: RulesInput }): Promise<{ ok: true } | { ok: false; message: string }> {
  const { orgId, part, input } = o;
  type Write = (sql: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<unknown>;
  let write: Write;
  if (part === "ownership") {
    const problem = lookbackProblem(input.lookback ?? "");
    if (problem) return { ok: false, message: problem };
    const days = Number(input.lookback!.trim());
    write = (sql) => sql`UPDATE lead_settings SET lookback_days = ${days}, updated_by = ${o.userId}, updated_at = now() WHERE org_id = ${orgId}`;
  } else if (part === "scoring") {
    const weights = input.weights ?? {};
    const problem = scoringProblem({ weights, hot: input.hot ?? "", warm: input.warm ?? "" });
    if (problem) return { ok: false, message: problem };
    const w = Object.fromEntries(WEIGHT_KEYS.map((k) => [k, Number(weights[k].trim())])) as Weights;
    const hot = Number(input.hot!.trim());
    const warm = Number(input.warm!.trim());
    write = (sql) => sql`
      UPDATE lead_settings SET weights = ${sql.json(w as never)}, hot_floor = ${hot}, warm_floor = ${warm}, updated_by = ${o.userId}, updated_at = now()
      WHERE org_id = ${orgId}`;
  } else if (part === "places") {
    const markets = readList(input.microMarkets ?? "");
    const rivals = readList(input.competitors ?? "");
    write = (sql) => sql`
      UPDATE lead_settings SET micro_markets = ${markets}::text[], competitors = ${rivals}::text[], updated_by = ${o.userId}, updated_at = now()
      WHERE org_id = ${orgId}`;
  } else {
    const wanted = [...new Set((input.nriDesk ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 20);
    // Only people actually in the organisation, whatever the form sent.
    const ok = wanted.length
      ? await withTenant(orgId, (sql) => sql<{ user_id: string }[]>`
          SELECT DISTINCT user_id FROM memberships WHERE org_id = ${orgId} AND status = 'ACTIVE' AND user_id = ANY(${wanted}::uuid[])`)
      : [];
    if (ok.length !== wanted.length) return { ok: false, message: "Pick people from your team." };
    write = (sql) => sql`UPDATE lead_settings SET nri_desk = ${wanted}::uuid[], updated_by = ${o.userId}, updated_at = now() WHERE org_id = ${orgId}`;
  }

  await withTenant(orgId, async (sql) => {
    await sql`INSERT INTO lead_settings (org_id, updated_by) VALUES (${orgId}, ${o.userId}) ON CONFLICT (org_id) DO NOTHING`;
    await write(sql);
  });
  await audit({ orgId, actorUserId: o.userId, action: "lead.settings_saved", targetType: "org", targetId: orgId, metadata: { part } });
  return { ok: true };
}
