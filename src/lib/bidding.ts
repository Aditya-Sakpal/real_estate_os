import { audit, withTenant } from "./db/index.ts";
import { listConnections, tokenFor } from "./connect.ts";
import { accountsFor } from "./connect-rules.ts";
import { ensureQualifiedConversion, metaConfigured } from "./meta.ts";
import { QUALIFIED_BID_DAYS, qualifiedBidding } from "./attribution-rules.ts";

/**
 * Bidding on qualified buyers, per Meta ad account. Off until somebody
 * holding `campaign.budget:manage` switches it on, and offered only once the
 * account has brought `QUALIFIED_BID_LEADS` leads over the last 30 days.
 * On, new ad sets from the account optimise for the Qualified outcome the
 * attribution sends (a custom conversion on the dataset), not for clicks.
 * Ads already made keep what they were made with.
 */

export type BiddingState = { on: boolean; leads: number; ready: boolean; needed: number };

/** Each ad account's leads over the window, and whether it bids on qualified buyers. */
export async function biddingStates(orgId: string, accountIds: string[], now = new Date()): Promise<Map<string, BiddingState>> {
  if (!accountIds.length) return new Map();
  const since = new Date(now.getTime() - QUALIFIED_BID_DAYS * 86_400_000);
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; on: boolean; leads: number }[]>`
    SELECT a.id, a.qualified_bidding AS on,
           (SELECT count(*)::int FROM leads l JOIN publish_targets t ON t.id = l.publish_target_id
             WHERE l.org_id = a.org_id AND t.account_id = a.id AND l.created_at >= ${since}) AS leads
    FROM connection_accounts a
    WHERE a.org_id = ${orgId} AND a.id = ANY(${accountIds}) AND a.kind = 'META_AD_ACCOUNT'`);
  return new Map(rows.map((r) => [r.id, { on: r.on, leads: r.leads, ...qualifiedBidding(r.leads) }]));
}

export type BiddingOutcome = { ok: true; message: string } | { ok: false; message: string };

/**
 * Switch qualified bidding on or off for one Meta ad account. On asks
 * again that the account has the leads, that a Meta dataset serves the
 * account's place (it is where the Qualified outcome goes), and makes or
 * finds the conversion on it before anything is saved. Off always works.
 */
export async function setQualifiedBidding(o: { orgId: string; userId: string; accountId: string; on: boolean; now?: Date }): Promise<BiddingOutcome> {
  const [account] = await withTenant(o.orgId, (sql) => sql<{ id: string; kind: string; external_id: string; path: string; qualified_bidding: boolean; active: boolean }[]>`
    SELECT a.id, a.kind, a.external_id, n.path::text AS path, a.qualified_bidding, a.active
    FROM connection_accounts a JOIN scope_nodes n ON n.id = a.scope_node_id
    WHERE a.org_id = ${o.orgId} AND a.id = ${o.accountId}`);
  if (!account || !account.active || account.kind !== "META_AD_ACCOUNT") return { ok: false, message: "That is not a Meta ad account here." };

  if (!o.on) {
    if (account.qualified_bidding) {
      await withTenant(o.orgId, (sql) => sql`
        UPDATE connection_accounts SET qualified_bidding = false, qualified_bidding_by = ${o.userId}, qualified_bidding_at = now(), updated_at = now()
        WHERE org_id = ${o.orgId} AND id = ${account.id}`);
      await audit({ orgId: o.orgId, actorUserId: o.userId, action: "connect.qualified_bidding", targetType: "connection_account", targetId: account.id, metadata: { on: false } });
    }
    return { ok: true, message: "New ads from this account optimise for clicks." };
  }
  if (account.qualified_bidding) return { ok: true, message: "Already on." };

  const state = (await biddingStates(o.orgId, [account.id], o.now)).get(account.id);
  if (!state?.ready) {
    return { ok: false, message: `This account needs ${state?.needed ?? 200} more leads in the last 30 days first.` };
  }
  if (!metaConfigured()) return { ok: false, message: "Meta is not switched on for Sales Desk yet." };
  const connections = await listConnections(o.orgId);
  const all = connections
    .filter((c) => c.provider === "META" && c.status === "CONNECTED")
    .flatMap((c) => c.accounts);
  const dataset = accountsFor(all, account.path).get("META_DATASET");
  if (!dataset) return { ok: false, message: "Choose a Meta dataset for this account's place first, under Change accounts." };
  const token = await tokenFor(o.orgId, account.id);
  if (!token.ok) return { ok: false, message: token.message };
  const conversion = await ensureQualifiedConversion(token.token, account.external_id, dataset.externalId);
  if (!conversion.ok) return { ok: false, message: `Meta did not make the conversion: ${conversion.message}` };
  if (!/^\d{1,30}$/.test(dataset.externalId) || !/^\d{1,30}$/.test(conversion.value)) {
    return { ok: false, message: "Meta answered with an id this cannot use. Try again later." };
  }

  await withTenant(o.orgId, (sql) => sql`
    UPDATE connection_accounts
    SET qualified_bidding = true, qualified_bidding_by = ${o.userId}, qualified_bidding_at = now(),
        qualified_dataset = ${dataset.externalId}, qualified_conversion = ${conversion.value}, updated_at = now()
    WHERE org_id = ${o.orgId} AND id = ${account.id}`);
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "connect.qualified_bidding",
    targetType: "connection_account",
    targetId: account.id,
    metadata: { on: true, leads: state.leads },
  });
  return { ok: true, message: "New ads from this account optimise for qualified buyers." };
}
