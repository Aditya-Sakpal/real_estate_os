/**
 * The developer's own Meta and Google accounts: connecting them, choosing
 * which of them this organisation publishes to, and keeping them working.
 *
 * `connect-rules.ts` is the pure half. `meta.ts` and `google.ts` speak to the
 * platforms. This file holds the rows, and it holds four rules.
 *
 * 1. **A token is sealed before it touches a row, and opened only to make a
 *    call.** `vault.ts` seals it for this organisation and this row. No
 *    function here returns a token to a caller that renders anything.
 *
 * 2. **The form is never believed.** A person picks accounts from the list
 *    the platform handed back at consent, and the pick is checked against
 *    that stored list rather than taken from the page: an account id typed
 *    into a crafted request is an account nobody here consented to.
 *
 * 3. **Reconnecting keeps what was chosen.** One live connection per provider,
 *    and a reconnect replaces its token in place, so the Pages and accounts
 *    chosen under it (and the ads published through them) stay attached.
 *
 * 4. **Disconnecting scrubs, it does not delete.** The token goes, the
 *    accounts stop being used, and the rows stay, because what was published
 *    through them has to remain answerable.
 *
 * Imports are relative so the checks can load this straight from source.
 */

import { randomBytes, randomUUID, hkdfSync } from "node:crypto";
import { withTenant, withNoTenant, audit } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import {
  ACCOUNT_KINDS,
  accountsFor,
  budgetCheck,
  DESTINATIONS,
  destinationDef,
  healthOf,
  isChoice,
  pkceChallenge,
  providerSlug,
  readState,
  scopesCover,
  signState,
  STATE_SECONDS,
  type AccountKind,
  type Choice,
  type ConnectionStatus,
  type Destination,
  type Health,
  type PlatformError,
  type Provider,
} from "./connect-rules.ts";
import { accountPurpose, connectionPurpose, open, seal, vaultConfigured } from "./vault.ts";
import { metaAuthUrl, metaConfigured, metaDiscover, metaExchange, metaInspect, metaPageToken, metaRevoke, metaSubscribeLeads } from "./meta.ts";
import {
  googleAccess,
  googleAdsConfigured,
  googleBusinessEnabled,
  googleAuthUrl,
  googleConfigured,
  googleDiscover,
  googleExchange,
  googleRevoke,
} from "./google.ts";

export type Outcome = { ok: true; message?: string } | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// Whether a provider can be connected at all
// ---------------------------------------------------------------------------

/**
 * Connecting needs the app's own credentials and the key that seals tokens.
 * Either missing, the screen says the provider is not set up rather than
 * sending a person to a consent page that fails on somebody else's domain.
 */
export function providerReady(provider: Provider): boolean {
  if (!vaultConfigured() || !process.env.AUTH_SECRET) return false;
  return provider === "META" ? metaConfigured() : googleConfigured();
}

/** Which destinations this server can publish to at all. */
export function destinationReady(destination: Destination): boolean {
  if (destination === "GOOGLE_DISPLAY_AD" || destination === "GOOGLE_SEARCH_AD" || destination === "GOOGLE_PMAX_AD" || destination === "GOOGLE_DEMAND_GEN_AD") {
    return providerReady("GOOGLE") && googleAdsConfigured();
  }
  if (destination === "GOOGLE_BUSINESS") return providerReady("GOOGLE") && googleBusinessEnabled();
  return providerReady(destinationDef(destination).provider);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type AccountView = {
  id: string;
  kind: AccountKind;
  externalId: string;
  name: string;
  detail: Record<string, string | null>;
  nodeId: string;
  nodeName: string;
  nodePath: string;
  nodeKind: string;
  dailyCap: number | null;
  /** Budget moves to the ads that bring buyers, automatically. */
  autoBudget: boolean;
  /** New ad sets optimise for qualified buyers rather than clicks. */
  qualifiedBidding: boolean;
  /** A Page Meta agreed to send lead-form submissions for. Null when not a Page or not asked yet. */
  leadForms: boolean | null;
  active: boolean;
};

export type ConnectionView = {
  id: string;
  provider: Provider;
  status: ConnectionStatus;
  health: Health;
  scopes: string[];
  tokenExpiresAt: string | null;
  connectedByName: string | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  choices: Choice[];
  accounts: AccountView[];
};

type DbConnection = {
  id: string;
  provider: Provider;
  status: ConnectionStatus;
  scopes: string[];
  token_expires_at: Date | null;
  connected_by_name: string | null;
  connected_at: Date | null;
  last_checked_at: Date | null;
  last_error_code: string | null;
  last_error: string | null;
  choices: unknown;
};

type DbAccount = {
  id: string;
  connection_id: string;
  kind: AccountKind;
  external_id: string;
  name: string;
  detail: Record<string, string | null>;
  scope_node_id: string;
  node_name: string;
  node_path: string;
  node_kind: string;
  daily_cap: number | null;
  auto_budget: boolean;
  qualified_bidding: boolean;
  active: boolean;
};

const toAccount = (a: DbAccount): AccountView => ({
  id: a.id,
  kind: a.kind,
  externalId: a.external_id,
  name: a.name,
  detail: a.detail ?? {},
  nodeId: a.scope_node_id,
  nodeName: a.node_name,
  nodePath: a.node_path,
  nodeKind: a.node_kind,
  dailyCap: a.daily_cap,
  autoBudget: a.auto_budget,
  qualifiedBidding: a.qualified_bidding,
  leadForms: a.kind === "FACEBOOK_PAGE" && typeof (a.detail as Record<string, unknown> | null)?.leads === "boolean"
    ? ((a.detail as Record<string, unknown>).leads as boolean)
    : null,
  active: a.active,
});

/** The live connection for each provider, with its accounts. Never a token. */
export async function listConnections(orgId: string, now = new Date()): Promise<ConnectionView[]> {
  const { connections, accounts } = await withTenant(orgId, async (sql) => {
    const connections = await sql<DbConnection[]>`
      SELECT c.id, c.provider, c.status, c.scopes, c.token_expires_at, u.name AS connected_by_name,
             c.connected_at, c.last_checked_at, c.last_error_code, c.last_error, c.choices
      FROM connections c LEFT JOIN users u ON u.id = c.connected_by
      WHERE c.org_id = ${orgId} AND c.status <> 'DISCONNECTED'`;
    const accounts = await sql<DbAccount[]>`
      SELECT a.id, a.connection_id, a.kind, a.external_id, a.name, a.detail, a.scope_node_id,
             n.name AS node_name, n.path::text AS node_path, n.kind AS node_kind, a.daily_cap, a.auto_budget, a.qualified_bidding, a.active
      FROM connection_accounts a JOIN scope_nodes n ON n.id = a.scope_node_id
      WHERE a.org_id = ${orgId}
      ORDER BY a.kind, n.path, a.name`;
    return { connections, accounts };
  });
  return connections.map((c) => ({
    id: c.id,
    provider: c.provider,
    status: c.status,
    health: healthOf({ status: c.status, tokenExpiresAt: c.token_expires_at, now }),
    scopes: c.scopes ?? [],
    tokenExpiresAt: c.token_expires_at?.toISOString() ?? null,
    connectedByName: c.connected_by_name,
    connectedAt: c.connected_at?.toISOString() ?? null,
    lastCheckedAt: c.last_checked_at?.toISOString() ?? null,
    lastErrorCode: c.last_error_code,
    lastError: c.last_error,
    choices: Array.isArray(c.choices) ? (c.choices as unknown[]).filter(isChoice) : [],
    accounts: accounts.filter((a) => a.connection_id === c.id).map(toAccount),
  }));
}

export async function loadConnection(orgId: string, provider: Provider, now = new Date()): Promise<ConnectionView | null> {
  return (await listConnections(orgId, now)).find((c) => c.provider === provider) ?? null;
}

/** The places an account can serve: the organisation, an entity, a project. */
export async function servablePlaces(orgId: string): Promise<{ id: string; kind: string; name: string; path: string }[]> {
  return withTenant(orgId, (sql) =>
    sql<{ id: string; kind: string; name: string; path: string }[]>`
      SELECT id, kind, name, path::text AS path FROM scope_nodes
      WHERE org_id = ${orgId} AND kind IN ('ORG', 'ENTITY', 'PROJECT')
      ORDER BY path`,
  );
}

// ---------------------------------------------------------------------------
// The OAuth round trip
// ---------------------------------------------------------------------------

/** The key the `state` is signed with, derived from the session secret. */
export function stateKey(): Buffer {
  const secret = process.env.AUTH_SECRET ?? "";
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), Buffer.from("salesdesk/connect-state"), 32));
}

/** Where a provider sends a person back to. Registered with the provider exactly as written. */
export function redirectUri(provider: Provider, origin: string): string {
  const base = (process.env.CONNECT_BASE_URL || process.env.AUTH_URL || origin).replace(/\/+$/, "");
  return `${base}/api/connect/${providerSlug(provider)}/callback`;
}

export type Begun = { url: string; nonce: string; verifier: string | null };

/**
 * Start a consent. The nonce goes in a cookie on this browser and inside the
 * signed state, and Google's PKCE verifier in a cookie beside it.
 */
export function beginConnect(input: {
  orgId: string;
  userId: string;
  provider: Provider;
  redirectUri: string;
  now?: Date;
}): Begun {
  const now = input.now ?? new Date();
  const nonce = randomBytes(18).toString("base64url");
  const state = signState(
    { p: input.provider, o: input.orgId, u: input.userId, n: nonce, e: Math.floor(now.getTime() / 1000) + STATE_SECONDS },
    stateKey(),
  );
  if (input.provider === "META") {
    return { url: metaAuthUrl({ state, redirectUri: input.redirectUri }), nonce, verifier: null };
  }
  const verifier = randomBytes(48).toString("base64url");
  return {
    url: googleAuthUrl({ state, redirectUri: input.redirectUri, challenge: pkceChallenge(verifier) }),
    nonce,
    verifier,
  };
}

const STATE_REFUSAL: Record<string, string> = {
  MALFORMED: "That sign-in did not come back complete. Connect again.",
  FORGED: "That sign-in could not be verified. Connect again.",
  EXPIRED: "That took longer than ten minutes. Connect again.",
  OTHER_BROWSER: "That sign-in was started in another browser. Connect again from here.",
  OTHER_PERSON: "That sign-in was started by somebody else. Connect again yourself.",
};

/** Check the state a provider carried back. Returns the org it was started for. */
export function checkReturn(input: {
  state: string | null;
  nonce: string | null;
  userId: string;
  provider: Provider;
  now?: Date;
}): { ok: true; orgId: string } | { ok: false; code: string; message: string } {
  const read = readState(input.state, stateKey(), {
    nonce: input.nonce,
    userId: input.userId,
    now: input.now ?? new Date(),
  });
  if (!read.ok) return { ok: false, code: read.code, message: STATE_REFUSAL[read.code] ?? STATE_REFUSAL.MALFORMED };
  if (read.payload.p !== input.provider) {
    return { ok: false, code: "OTHER_PROVIDER", message: STATE_REFUSAL.MALFORMED };
  }
  return { ok: true, orgId: read.payload.o };
}

function platformRefusal(e: PlatformError): Outcome {
  return { ok: false, code: e.code, message: e.message };
}

/**
 * The code a provider handed back, turned into a sealed token and the list of
 * accounts it reaches.
 *
 * A first consent lands PENDING: nothing is published until somebody chooses
 * where. A reconnect replaces the token on the live row and keeps its status,
 * refreshing the Pages' own tokens so they are not left holding the old one.
 */
export async function finishConnect(input: {
  orgId: string;
  userId: string;
  provider: Provider;
  code: string;
  redirectUri: string;
  verifier: string | null;
}): Promise<Outcome> {
  if (!providerReady(input.provider)) {
    return { ok: false, code: "NOT_READY", message: "Connecting is not set up on this server yet." };
  }

  let secret: string;
  let expiresAt: Date | null;
  let scopes: string[];
  let externalUserId: string | null = null;
  let choices: Choice[];
  let systemUser = false;
  // Why part of a consent reached nothing (Ads not approved, Business Profile
  // not approved), said on the screen rather than left as an empty list.
  let notes: string[] = [];

  if (input.provider === "META") {
    const grant = await metaExchange({ code: input.code, redirectUri: input.redirectUri });
    if (!grant.ok) return platformRefusal(grant);
    const found = await metaDiscover(grant.value.token);
    if (!found.ok) return platformRefusal(found);
    secret = JSON.stringify({ access_token: grant.value.token });
    expiresAt = grant.value.expiresAt;
    scopes = grant.value.scopes;
    externalUserId = grant.value.userId;
    systemUser = grant.value.systemUser;
    choices = found.value;
  } else {
    if (!input.verifier) return { ok: false, code: "MALFORMED", message: STATE_REFUSAL.MALFORMED };
    const grant = await googleExchange({ code: input.code, redirectUri: input.redirectUri, verifier: input.verifier });
    if (!grant.ok) return platformRefusal(grant);
    const found = await googleDiscover(grant.value.accessToken);
    if (!found.ok) return platformRefusal(found);
    secret = JSON.stringify({ refresh_token: grant.value.refreshToken });
    expiresAt = null;
    scopes = grant.value.scopes;
    choices = found.value.choices;
    notes = found.value.notes;
  }

  const existing = await withTenant(input.orgId, async (sql) => {
    const [row] = await sql<{ id: string; status: ConnectionStatus }[]>`
      SELECT id, status FROM connections
      WHERE org_id = ${input.orgId} AND provider = ${input.provider} AND status <> 'DISCONNECTED'`;
    return row ?? null;
  });
  const id = existing?.id ?? randomUUID();
  const sealed = await seal(input.orgId, connectionPurpose(id), secret);
  if (!sealed) return { ok: false, code: "NOT_READY", message: "Connecting is not set up on this server yet." };

  await withTenant(input.orgId, async (sql) => {
    const json = sql.json(choices as never);
    if (existing) {
      await sql`
        UPDATE connections
        SET secret = ${sealed.secret}, key_version = ${sealed.keyVersion}, token_expires_at = ${expiresAt},
            scopes = ${scopes}, external_user_id = ${externalUserId}, choices = ${json}, choices_at = now(),
            status = CASE WHEN EXISTS (SELECT 1 FROM connection_accounts a
                                        WHERE a.connection_id = connections.id AND a.active)
                          THEN 'CONNECTED' ELSE 'PENDING' END,
            connected_by = ${input.userId}, connected_at = now(), last_checked_at = now(),
            last_error_code = NULL, last_error = NULL, updated_at = now()
        WHERE org_id = ${input.orgId} AND id = ${id}`;
    } else {
      await sql`
        INSERT INTO connections (id, org_id, provider, status, secret, key_version, token_expires_at,
                                 scopes, external_user_id, choices, choices_at, connected_by,
                                 connected_at, last_checked_at)
        VALUES (${id}, ${input.orgId}, ${input.provider}, 'PENDING', ${sealed.secret}, ${sealed.keyVersion},
                ${expiresAt}, ${scopes}, ${externalUserId}, ${json}, now(), ${input.userId}, now(), now())`;
    }
  });

  // A reconnect can hand back a new token for a Page already chosen. The
  // old one may still work, but it was issued to a consent that has just
  // been replaced, so it is replaced too.
  if (existing && input.provider === "META") {
    await refreshPageTokens(input.orgId, id, JSON.parse(secret).access_token as string);
  }

  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "connect.consented",
    targetType: "connection",
    targetId: id,
    metadata: {
      provider: input.provider,
      reconnect: !!existing,
      scopes: scopes.length,
      choices: choices.length,
      system_user: systemUser,
    },
  });
  return notes.length ? { ok: true, message: notes.join(" ") } : { ok: true };
}

async function refreshPageTokens(orgId: string, connectionId: string, userToken: string): Promise<void> {
  const pages = await withTenant(orgId, (sql) =>
    sql<{ id: string; kind: AccountKind; external_id: string; detail: Record<string, string | null> }[]>`
      SELECT id, kind, external_id, detail FROM connection_accounts
      WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND active
        AND kind IN ('FACEBOOK_PAGE', 'INSTAGRAM')`,
  );
  for (const p of pages) {
    const pageId = p.kind === "FACEBOOK_PAGE" ? p.external_id : p.detail.page_id;
    if (!pageId) continue;
    const token = await metaPageToken(userToken, pageId);
    if (!token.ok) continue;
    const sealed = await seal(orgId, accountPurpose(p.id), JSON.stringify({ access_token: token.value }));
    if (!sealed) continue;
    await withTenant(orgId, (sql) => sql`
      UPDATE connection_accounts SET secret = ${sealed.secret}, key_version = ${sealed.keyVersion}, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${p.id}`);
    if (p.kind === "FACEBOOK_PAGE") await subscribeLeads(orgId, p.id, pageId, token.value);
  }
}

/**
 * Ask Meta to send this Page's lead-form submissions to us, and record
 * whether it agreed, so the connection screen can say when lead forms will
 * not arrive. Best effort: a Page that refuses still publishes.
 */
async function subscribeLeads(orgId: string, accountId: string, pageId: string, pageToken: string): Promise<void> {
  const r = await metaSubscribeLeads(pageToken, pageId);
  await withTenant(orgId, (sql) => sql`
    UPDATE connection_accounts SET detail = detail || ${sql.json({ leads: r.ok } as never)}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${accountId}`);
}

// ---------------------------------------------------------------------------
// Choosing accounts
// ---------------------------------------------------------------------------

export type Pick = { kind: string; id: string; nodeId: string };

/**
 * Which of the accounts behind a consent this organisation publishes to, and
 * where each is used.
 *
 * Every pick is matched against the list the platform handed back at consent.
 * Every place is read back inside this tenant. Two accounts of one kind at one
 * place is refused before anything is written, since "where does this post
 * go" must have one answer. Accounts not picked stop being used; their rows
 * stay.
 */
export async function chooseAccounts(input: {
  orgId: string;
  userId: string;
  provider: Provider;
  picks: Pick[];
}): Promise<Outcome> {
  const conn = await withTenant(input.orgId, async (sql) => {
    const [row] = await sql<{ id: string; secret: Buffer | null; choices: unknown }[]>`
      SELECT id, secret, choices FROM connections
      WHERE org_id = ${input.orgId} AND provider = ${input.provider} AND status <> 'DISCONNECTED'`;
    return row ?? null;
  });
  if (!conn) return { ok: false, code: "NOT_CONNECTED", message: "Connect first, then choose accounts." };
  const offered = Array.isArray(conn.choices) ? (conn.choices as unknown[]).filter(isChoice) : [];

  const places = await servablePlaces(input.orgId);
  const placeById = new Map(places.map((p) => [p.id, p]));
  const root = places.find((p) => p.kind === "ORG");

  const chosen: { choice: Choice; nodeId: string }[] = [];
  for (const pick of input.picks) {
    const choice = offered.find((c) => c.kind === pick.kind && c.id === pick.id);
    if (!choice) {
      return { ok: false, code: "NOT_OFFERED", message: "One of those accounts is not in what you connected. Connect again." };
    }
    const nodeId = pick.nodeId && isNodeId(pick.nodeId) ? pick.nodeId : root?.id ?? "";
    if (!placeById.has(nodeId)) return { ok: false, code: "UNKNOWN_PLACE", message: "Choose where each account is used." };
    chosen.push({ choice, nodeId });
  }
  const clash = new Set<string>();
  for (const c of chosen) {
    const key = `${c.choice.kind}|${c.nodeId}`;
    if (clash.has(key)) {
      const label = ACCOUNT_KINDS.find((k) => k.key === c.choice.kind)?.label ?? "account";
      const place = placeById.get(c.nodeId)?.name ?? "one place";
      return { ok: false, code: "TWO_AT_ONE_PLACE", message: `Two of the ticked ${label}s are used for ${place}. Pick one, or use the other somewhere else.` };
    }
    clash.add(key);
  }

  // A Page's own token, and an Instagram account's Page's, fetched now.
  const needsPage = chosen.filter((c) => c.choice.kind === "FACEBOOK_PAGE" || c.choice.kind === "INSTAGRAM");
  let userToken: string | null = null;
  if (needsPage.length) {
    const plain = await open(input.orgId, connectionPurpose(conn.id), conn.secret);
    userToken = plain ? ((JSON.parse(plain) as { access_token?: string }).access_token ?? null) : null;
    if (!userToken) return { ok: false, code: "TOKEN_INVALID", message: "The connection stopped working. Connect again." };
  }
  const pageTokens = new Map<string, string>();
  for (const c of needsPage) {
    const pageId = c.choice.kind === "FACEBOOK_PAGE" ? c.choice.id : c.choice.detail.page_id;
    if (!pageId || pageTokens.has(pageId)) continue;
    const t = await metaPageToken(userToken!, pageId);
    if (!t.ok) return platformRefusal(t);
    pageTokens.set(pageId, t.value);
  }

  await withTenant(input.orgId, async (sql) => {
    await sql`
      UPDATE connection_accounts SET active = false, updated_at = now()
      WHERE org_id = ${input.orgId} AND connection_id = ${conn.id}`;
    for (const c of chosen) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO connection_accounts (org_id, connection_id, kind, external_id, name, detail,
                                         scope_node_id, active, added_by)
        VALUES (${input.orgId}, ${conn.id}, ${c.choice.kind}, ${c.choice.id}, ${c.choice.name},
                ${sql.json(c.choice.detail as never)}, ${c.nodeId}, true, ${input.userId})
        ON CONFLICT (connection_id, kind, external_id) DO UPDATE
          SET name = EXCLUDED.name, detail = EXCLUDED.detail, scope_node_id = EXCLUDED.scope_node_id,
              active = true, updated_at = now()
        RETURNING id`;
      const pageId = c.choice.kind === "FACEBOOK_PAGE" ? c.choice.id : c.choice.detail.page_id;
      const token = pageId ? pageTokens.get(pageId) : undefined;
      if (token) {
        const sealed = await seal(input.orgId, accountPurpose(row.id), JSON.stringify({ access_token: token }), sql);
        if (sealed) {
          await sql`
            UPDATE connection_accounts SET secret = ${sealed.secret}, key_version = ${sealed.keyVersion}
            WHERE org_id = ${input.orgId} AND id = ${row.id}`;
        }
      }
    }
    await sql`
      UPDATE connections
      SET status = ${chosen.length ? "CONNECTED" : "PENDING"}, updated_at = now()
      WHERE org_id = ${input.orgId} AND id = ${conn.id}`;
  });

  for (const c of chosen) {
    if (c.choice.kind !== "FACEBOOK_PAGE") continue;
    const token = pageTokens.get(c.choice.id);
    const [row] = await withTenant(input.orgId, (sql) => sql<{ id: string }[]>`
      SELECT id FROM connection_accounts
      WHERE org_id = ${input.orgId} AND connection_id = ${conn.id} AND kind = 'FACEBOOK_PAGE' AND external_id = ${c.choice.id}`);
    if (token && row) await subscribeLeads(input.orgId, row.id, c.choice.id, token);
  }

  const counts: Record<string, number> = {};
  for (const c of chosen) counts[c.choice.kind] = (counts[c.choice.kind] ?? 0) + 1;
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "connect.accounts_chosen",
    targetType: "connection",
    targetId: conn.id,
    metadata: { provider: input.provider, ...counts },
  });
  return { ok: true, message: chosen.length ? "Saved." : "Nothing is chosen, so nothing publishes." };
}

/**
 * The most one ad from this account may spend in a day.
 *
 * Its own key, `campaign.budget:manage`, checked by the caller: connecting an
 * account and deciding how much of the developer's money it may move are
 * different powers.
 */
export async function setDailyCap(input: {
  orgId: string;
  userId: string;
  accountId: string;
  raw: string;
}): Promise<Outcome> {
  if (!isNodeId(input.accountId)) return { ok: false, code: "UNKNOWN", message: "That account is not here." };
  const account = await withTenant(input.orgId, async (sql) => {
    const [row] = await sql<{ kind: AccountKind; detail: Record<string, string | null> }[]>`
      SELECT kind, detail FROM connection_accounts WHERE org_id = ${input.orgId} AND id = ${input.accountId}`;
    return row ?? null;
  });
  if (!account || (account.kind !== "META_AD_ACCOUNT" && account.kind !== "GOOGLE_ADS_CUSTOMER")) {
    return { ok: false, code: "UNKNOWN", message: "That is not an ad account." };
  }
  const cleared = (input.raw ?? "").trim() === "";
  let cap: number | null = null;
  if (!cleared) {
    // Checked the way a budget is, against an unlimited ceiling.
    const check = budgetCheck({ raw: input.raw, cap: 10_000_000, currency: account.detail.currency ?? null });
    if (!check.ok) return { ok: false, code: "BAD_CAP", message: check.reason };
    cap = check.rupees;
  }
  await withTenant(input.orgId, (sql) => sql`
    UPDATE connection_accounts SET daily_cap = ${cap}, updated_at = now()
    WHERE org_id = ${input.orgId} AND id = ${input.accountId}`);
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "connect.daily_cap_set",
    targetType: "connection_account",
    targetId: input.accountId,
    metadata: { daily_cap: cap },
  });
  return { ok: true, message: cap === null ? "Limit removed. No new ads until one is set." : "Limit saved." };
}

// ---------------------------------------------------------------------------
// Disconnecting, and being disconnected
// ---------------------------------------------------------------------------

async function scrub(orgId: string, connectionId: string, code: string | null): Promise<void> {
  await withTenant(orgId, async (sql) => {
    await sql`
      UPDATE connection_accounts SET secret = NULL, key_version = NULL, active = false, updated_at = now()
      WHERE org_id = ${orgId} AND connection_id = ${connectionId}`;
    await sql`
      UPDATE connections
      SET status = 'DISCONNECTED', secret = NULL, key_version = NULL, external_user_id = NULL,
          choices = '[]'::jsonb, last_error_code = ${code}, last_error = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${connectionId}`;
  });
}

/**
 * Take the permission back at the provider, then scrub.
 *
 * The revoke is best effort: a token that already stopped working cannot be
 * revoked and does not need to be. The scrub is not.
 */
export async function disconnect(input: { orgId: string; userId: string; provider: Provider }): Promise<Outcome> {
  const conn = await withTenant(input.orgId, async (sql) => {
    const [row] = await sql<{ id: string; secret: Buffer | null }[]>`
      SELECT id, secret FROM connections
      WHERE org_id = ${input.orgId} AND provider = ${input.provider} AND status <> 'DISCONNECTED'`;
    return row ?? null;
  });
  if (!conn) return { ok: true, message: "Already disconnected." };
  const plain = await open(input.orgId, connectionPurpose(conn.id), conn.secret);
  let revoked = false;
  if (plain) {
    const t = JSON.parse(plain) as { access_token?: string; refresh_token?: string };
    const r =
      input.provider === "META" && t.access_token
        ? await metaRevoke(t.access_token)
        : t.refresh_token
          ? await googleRevoke(t.refresh_token)
          : null;
    revoked = !!r?.ok;
  }
  await scrub(input.orgId, conn.id, null);
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "connect.disconnected",
    targetType: "connection",
    targetId: conn.id,
    metadata: { provider: input.provider, revoked },
  });
  return { ok: true, message: "Disconnected." };
}

/**
 * Meta says a person removed the app, or asked for their data to be deleted.
 *
 * The only thing Meta sends is that person's app-scoped id. The lookup across
 * tenants is the one SECURITY DEFINER function in 0023, which returns org ids
 * and nothing else; the scrub itself runs inside each tenant.
 */
export async function forgetExternalUser(input: {
  provider: Provider;
  externalUserId: string;
  reason: "DEAUTHORIZED" | "DELETION_REQUESTED";
  /** The confirmation code handed back to Meta, so a later question can be matched to this row. */
  reference?: string;
}): Promise<number> {
  if (!/^\d{1,40}$/.test(input.externalUserId)) return 0;
  const rows = await withNoTenant((sql) => sql<{ org_id: string; connection_id: string }[]>`
    SELECT org_id, connection_id FROM connections_for_external_user(${input.provider}, ${input.externalUserId})`);
  for (const r of rows) {
    await scrub(r.org_id, r.connection_id, input.reason);
    await audit({
      orgId: r.org_id,
      actorUserId: null,
      action: input.reason === "DEAUTHORIZED" ? "connect.deauthorized" : "connect.deletion_requested",
      targetType: "connection",
      targetId: r.connection_id,
      metadata: { provider: input.provider, reference: input.reference ?? null },
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Keeping it working
// ---------------------------------------------------------------------------

/** Mark a connection broken, with the platform's reason, so the screen and the queue say so. */
export async function markBroken(orgId: string, connectionId: string, e: PlatformError): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    UPDATE connections
    SET status = 'BROKEN', last_error_code = ${e.code}, last_error = ${e.message.slice(0, 300)},
        last_checked_at = now(), updated_at = now()
    WHERE org_id = ${orgId} AND id = ${connectionId} AND status <> 'DISCONNECTED'`);
}

/**
 * Ask the provider whether the token still works, and record the answer.
 *
 * A dead token is BROKEN, which the screen and Today both show. A platform
 * that did not answer is not evidence of anything, so it changes nothing but
 * the note, the rule the RERA sweep follows for a portal that is down.
 */
export async function checkConnection(input: {
  orgId: string;
  provider: Provider;
  userId: string | null;
}): Promise<Outcome> {
  const conn = await withTenant(input.orgId, async (sql) => {
    const [row] = await sql<{ id: string; secret: Buffer | null; status: ConnectionStatus }[]>`
      SELECT id, secret, status FROM connections
      WHERE org_id = ${input.orgId} AND provider = ${input.provider} AND status <> 'DISCONNECTED'`;
    return row ?? null;
  });
  if (!conn) return { ok: false, code: "NOT_CONNECTED", message: "Not connected." };
  const plain = await open(input.orgId, connectionPurpose(conn.id), conn.secret);
  if (!plain) {
    await markBroken(input.orgId, conn.id, { code: "TOKEN_INVALID", retryable: false, message: "The stored token could not be opened." });
    return { ok: false, code: "TOKEN_INVALID", message: "The connection stopped working. Connect again." };
  }
  const t = JSON.parse(plain) as { access_token?: string; refresh_token?: string };

  let result: { ok: true; expiresAt: Date | null; scopes: string[] | null } | ({ ok: false } & PlatformError);
  if (input.provider === "META") {
    const r = await metaInspect(t.access_token ?? "");
    result = !r.ok
      ? r
      : r.value.valid
        ? { ok: true, expiresAt: r.value.expiresAt, scopes: r.value.scopes }
        : { ok: false, code: "TOKEN_INVALID", retryable: false, message: "Meta says this connection no longer works." };
  } else {
    const r = await googleAccess(t.refresh_token ?? "");
    result = r.ok ? { ok: true, expiresAt: null, scopes: null } : r;
  }

  if (!result.ok) {
    if (result.code === "TOKEN_INVALID" || result.code === "PERMISSION") {
      await markBroken(input.orgId, conn.id, result);
      return { ok: false, code: result.code, message: "The connection stopped working. Connect again." };
    }
    await withTenant(input.orgId, (sql) => sql`
      UPDATE connections SET last_error_code = ${result.code}, last_error = ${result.message.slice(0, 300)}, updated_at = now()
      WHERE org_id = ${input.orgId} AND id = ${conn.id}`);
    return { ok: false, code: result.code, message: result.message };
  }

  const scopes = result.scopes;
  const expiresAt = result.expiresAt;
  await withTenant(input.orgId, (sql) => sql`
    UPDATE connections
    SET last_checked_at = now(), last_error_code = NULL, last_error = NULL,
        token_expires_at = ${expiresAt},
        scopes = COALESCE(${scopes}, scopes),
        status = CASE WHEN status = 'BROKEN'
                      THEN (CASE WHEN EXISTS (SELECT 1 FROM connection_accounts a
                                               WHERE a.connection_id = connections.id AND a.active)
                                 THEN 'CONNECTED' ELSE 'PENDING' END)
                      ELSE status END,
        updated_at = now()
    WHERE org_id = ${input.orgId} AND id = ${conn.id}`);
  if (input.userId) {
    await audit({
      orgId: input.orgId,
      actorUserId: input.userId,
      action: "connect.checked",
      targetType: "connection",
      targetId: conn.id,
      metadata: { provider: input.provider },
    });
  }
  return { ok: true, message: "Working." };
}

// ---------------------------------------------------------------------------
// Where a node publishes
// ---------------------------------------------------------------------------

export type Resolved = {
  account: AccountView;
  connectionId: string;
  connectionStatus: ConnectionStatus;
  scopes: string[];
};

/**
 * The account each destination would use for a node, and why one cannot.
 * Deepest active account wins, the way the brand kit resolves.
 */
export async function destinationsFor(
  orgId: string,
  nodePath: string,
): Promise<Map<Destination, { ok: true; to: Resolved } | { ok: false; reason: string }>> {
  const connections = await listConnections(orgId);
  const accounts = connections.flatMap((c) =>
    c.accounts.map((a) => ({ ...a, nodePath: a.nodePath, connection: c })),
  );
  const nearest = accountsFor(accounts, nodePath);
  const out = new Map<Destination, { ok: true; to: Resolved } | { ok: false; reason: string }>();
  for (const d of DESTINATIONS.map((x) => x.key)) {
    const def = destinationDef(d);
    if (!destinationReady(d)) {
      out.set(d, { ok: false, reason: "Not switched on for Sales Desk yet." });
      continue;
    }
    const a = nearest.get(def.account);
    if (!a) {
      out.set(d, { ok: false, reason: `No ${ACCOUNT_KINDS.find((k) => k.key === def.account)?.label ?? "account"} is connected for this project.` });
      continue;
    }
    if (a.connection.status !== "CONNECTED") {
      out.set(d, { ok: false, reason: `${def.provider === "META" ? "Meta" : "Google"} needs reconnecting.` });
      continue;
    }
    if (!scopesCover(d, a.connection.scopes)) {
      out.set(d, { ok: false, reason: `The ${def.provider === "META" ? "Meta" : "Google"} connection was not given permission for this. Reconnect and allow everything asked for.` });
      continue;
    }
    const { connection, ...account } = a;
    out.set(d, {
      ok: true,
      to: { account, connectionId: connection.id, connectionStatus: connection.status, scopes: connection.scopes },
    });
  }
  return out;
}

/**
 * The token a publication calls with. Opened here, used by the caller for
 * one call sequence, and never stored anywhere but the sealed row.
 *
 * A Page and its Instagram account use the Page's own token; an ad account
 * uses the connection's; Google exchanges its refresh token for an hour's
 * access.
 */
export async function tokenFor(
  orgId: string,
  accountId: string,
): Promise<{ ok: true; token: string; connectionId: string } | ({ ok: false } & PlatformError)> {
  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<
      {
        kind: AccountKind;
        account_secret: Buffer | null;
        connection_id: string;
        connection_secret: Buffer | null;
        provider: Provider;
        status: ConnectionStatus;
      }[]
    >`
      SELECT a.kind, a.secret AS account_secret, c.id AS connection_id, c.secret AS connection_secret,
             c.provider, c.status
      FROM connection_accounts a JOIN connections c ON c.id = a.connection_id
      WHERE a.org_id = ${orgId} AND a.id = ${accountId}`;
    return r ?? null;
  });
  const gone = { ok: false as const, code: "TOKEN_INVALID" as const, retryable: false, message: "The connection stopped working. Reconnect it in Settings." };
  if (!row || row.status === "DISCONNECTED") return gone;
  if (row.kind === "FACEBOOK_PAGE" || row.kind === "INSTAGRAM") {
    const plain = await open(orgId, accountPurpose(accountId), row.account_secret);
    const token = plain ? (JSON.parse(plain) as { access_token?: string }).access_token : null;
    return token ? { ok: true, token, connectionId: row.connection_id } : gone;
  }
  const plain = await open(orgId, connectionPurpose(row.connection_id), row.connection_secret);
  if (!plain) return gone;
  const t = JSON.parse(plain) as { access_token?: string; refresh_token?: string };
  if (row.provider === "META") {
    return t.access_token ? { ok: true, token: t.access_token, connectionId: row.connection_id } : gone;
  }
  if (!t.refresh_token) return gone;
  const access = await googleAccess(t.refresh_token);
  return access.ok ? { ok: true, token: access.value, connectionId: row.connection_id } : access;
}
