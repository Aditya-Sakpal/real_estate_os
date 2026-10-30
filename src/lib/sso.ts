import { createHash, randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { SAML, ValidateInResponseTo, type CacheProvider } from "@node-saml/node-saml";
import { audit, auditHash, controlDb, withTenant } from "./db/index.ts";
import { claimInvites } from "./invite-claim.ts";
import { isPublicEmailDomain } from "./work-account.ts";
import {
  certValidTo,
  domainOf,
  normaliseDomain,
  personFrom,
  sameSettings,
  spValues,
  ssoAlerts,
  ssoBlocks,
  toPem,
  txtProves,
  txtRecord,
  type SsoAlert,
  type SsoInput,
} from "./sso-rules.ts";

/**
 * Single sign-on: the reads and writes around `sso-rules.ts` (0064).
 *
 * The settings are the tenant's, under RLS. Signing in is the control
 * plane's, as every sign-in is: the person has no tenant yet, so the
 * domain's organisation is found on the control connection, the assertion
 * is checked against that organisation's own settings, and the session is
 * handed over through a one-use ticket the credentials provider redeems.
 */

export const ssoBase = () => (process.env.SSO_BASE_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const isId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);

// ---------------------------------------------------------------------------
// Seams for the checks: DNS, and the clock node-saml reads
// ---------------------------------------------------------------------------

let dns: ((domain: string) => Promise<string[][]>) | null = null;

/** For checks: TXT lookups go to `driver` until `restore()`. */
export function useDns(driver: (domain: string) => Promise<string[][]>): { restore(): void } {
  dns = driver;
  return { restore: () => void (dns = null) };
}

// ---------------------------------------------------------------------------
// The settings screen
// ---------------------------------------------------------------------------

export type SsoSettings = {
  sp: ReturnType<typeof spValues>;
  config: {
    entityId: string;
    ssoUrl: string;
    certificates: { body: string; validTo: string | null }[];
    enforce: boolean;
    testedAt: string | null;
    testedBy: string | null;
    updatedAt: string;
  } | null;
  domains: { domain: string; verified: boolean; record: string }[];
  primaryDomain: string | null;
};

export async function ssoSettings(orgId: string): Promise<SsoSettings> {
  return withTenant(orgId, async (sql) => {
    const [[c], domains, [org]] = await Promise.all([
      sql<{ idp_entity_id: string; sso_url: string; certificates: string[]; enforce: boolean; tested_at: Date | null; tested_by: string | null; updated_at: Date }[]>`
        SELECT c.idp_entity_id, c.sso_url, c.certificates, c.enforce, c.tested_at, u.name AS tested_by, c.updated_at
        FROM sso_configs c LEFT JOIN users u ON u.id = c.tested_by WHERE c.org_id = ${orgId}`,
      sql<{ domain: string; verified_at: Date | null; token: string }[]>`
        SELECT domain, verified_at, token FROM sso_domains WHERE org_id = ${orgId} ORDER BY verified_at NULLS LAST, domain`,
      sql<{ primary_domain: string | null }[]>`SELECT primary_domain FROM orgs WHERE id = ${orgId}`,
    ]);
    return {
      sp: spValues(ssoBase(), orgId),
      config: c
        ? {
            entityId: c.idp_entity_id,
            ssoUrl: c.sso_url,
            certificates: c.certificates.map((b) => ({ body: b, validTo: certValidTo(b) })),
            enforce: c.enforce,
            testedAt: c.tested_at?.toISOString() ?? null,
            testedBy: c.tested_by,
            updatedAt: c.updated_at.toISOString(),
          }
        : null,
      domains: domains.map((d) => ({ domain: d.domain, verified: !!d.verified_at, record: txtRecord(d.token) })),
      primaryDomain: org?.primary_domain && !isPublicEmailDomain(org.primary_domain) ? org.primary_domain : null,
    };
  });
}

/**
 * Save the identity provider's settings. A change to any of them is a new
 * connection nobody has tried, so the last test no longer counts and
 * requiring SSO switches off until somebody signs in through it again.
 * The first save proves the organisation's own domain on the way, because
 * its founder already signed in on it with Google or Microsoft.
 */
export async function saveSsoConfig(o: { orgId: string; userId: string; input: SsoInput }): Promise<{ ok: boolean; message: string }> {
  const i = o.input;
  const out = await withTenant(o.orgId, async (sql) => {
    const [cur] = await sql<{ idp_entity_id: string; sso_url: string; certificates: string[] }[]>`
      SELECT idp_entity_id, sso_url, certificates FROM sso_configs WHERE org_id = ${o.orgId} FOR UPDATE`;
    const same = !!cur && sameSettings({ entityId: cur.idp_entity_id, ssoUrl: cur.sso_url, certificates: cur.certificates }, i);
    if (same) return "same" as const;
    await sql`
      INSERT INTO sso_configs (org_id, idp_entity_id, sso_url, certificates, updated_by)
      VALUES (${o.orgId}, ${i.entityId}, ${i.ssoUrl}, ${i.certificates}, ${o.userId})
      ON CONFLICT (org_id) DO UPDATE SET idp_entity_id = EXCLUDED.idp_entity_id, sso_url = EXCLUDED.sso_url,
        certificates = EXCLUDED.certificates, enforce = false, tested_at = NULL, tested_by = NULL,
        updated_by = EXCLUDED.updated_by, updated_at = now()`;
    const [org] = await sql<{ primary_domain: string | null }[]>`SELECT primary_domain FROM orgs WHERE id = ${o.orgId}`;
    const own = org?.primary_domain ? normaliseDomain(org.primary_domain) : null;
    if (own && !isPublicEmailDomain(own)) {
      const [taken] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sso_domains WHERE org_id = ${o.orgId} AND domain = ${own}`;
      if (!taken.n) {
        // Proved elsewhere by somebody else is refused by the unique index; that
        // company proved it by DNS, so it keeps it and this one is left out.
        await sql`SAVEPOINT own_domain`;
        try {
          await sql`INSERT INTO sso_domains (org_id, domain, token, verified_at, created_by)
                    VALUES (${o.orgId}, ${own}, ${randomBytes(16).toString("hex")}, now(), ${o.userId})`;
          await sql`RELEASE SAVEPOINT own_domain`;
        } catch {
          await sql`ROLLBACK TO SAVEPOINT own_domain`;
        }
      }
    }
    return cur ? ("changed" as const) : ("created" as const);
  });
  if (out === "same") return { ok: true, message: "Nothing changed." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: out === "created" ? "sso.configured" : "sso.changed", targetType: "org", targetId: o.orgId });
  return { ok: true, message: out === "created" ? "Saved. Test it by signing in through it." : "Saved. Test it again before requiring it." };
}

export async function removeSsoConfig(o: { orgId: string; userId: string }): Promise<{ ok: boolean; message: string }> {
  await withTenant(o.orgId, (sql) => sql`DELETE FROM sso_configs WHERE org_id = ${o.orgId}`);
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "sso.removed", targetType: "org", targetId: o.orgId });
  return { ok: true, message: "Single sign-on is off. People sign in with Google or Microsoft again." };
}

export async function setEnforce(o: { orgId: string; userId: string; on: boolean }): Promise<{ ok: boolean; message: string }> {
  const r = await withTenant(o.orgId, async (sql) => {
    const [c] = await sql<{ tested_at: Date | null }[]>`SELECT tested_at FROM sso_configs WHERE org_id = ${o.orgId} FOR UPDATE`;
    if (!c) return "Set up your identity provider first.";
    if (o.on && !c.tested_at) return "Sign in through it once before requiring it.";
    const [d] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sso_domains WHERE org_id = ${o.orgId} AND verified_at IS NOT NULL`;
    if (o.on && !d.n) return "Prove a domain first, so we know whose sign-ins to send to it.";
    await sql`UPDATE sso_configs SET enforce = ${o.on}, updated_at = now() WHERE org_id = ${o.orgId}`;
    return null;
  });
  if (r) return { ok: false, message: r };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: o.on ? "sso.required" : "sso.optional", targetType: "org", targetId: o.orgId });
  return { ok: true, message: o.on ? "Single sign-on is required. Admins can still use Google or Microsoft." : "Single sign-on is optional again." };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export async function addDomain(o: { orgId: string; userId: string; raw: string }): Promise<{ ok: boolean; message: string }> {
  const domain = normaliseDomain(o.raw);
  if (!domain) return { ok: false, message: "Enter a domain like yourcompany.com." };
  if (isPublicEmailDomain(domain)) return { ok: false, message: "That is a public mail service, not your company's domain." };
  const r = await withTenant(o.orgId, (sql) => sql`
    INSERT INTO sso_domains (org_id, domain, token, created_by)
    VALUES (${o.orgId}, ${domain}, ${randomBytes(16).toString("hex")}, ${o.userId})
    ON CONFLICT (org_id, domain) DO NOTHING RETURNING domain`);
  if (!r.length) return { ok: false, message: `${domain} is already on the list.` };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "sso.domain_added", targetType: "domain", targetId: domain });
  return { ok: true, message: `Add the TXT record to ${domain}, then press Check.` };
}

export async function verifyDomain(o: { orgId: string; userId: string; domain: string }): Promise<{ ok: boolean; message: string }> {
  const domain = normaliseDomain(o.domain);
  if (!domain) return { ok: false, message: "That domain is not on the list." };
  const [row] = await withTenant(o.orgId, (sql) => sql<{ token: string; verified_at: Date | null }[]>`
    SELECT token, verified_at FROM sso_domains WHERE org_id = ${o.orgId} AND domain = ${domain}`);
  if (!row) return { ok: false, message: "That domain is not on the list." };
  if (row.verified_at) return { ok: true, message: `${domain} is already proved.` };
  let records: string[][] = [];
  try {
    records = await (dns ?? resolveTxt)(domain);
  } catch {
    records = [];
  }
  if (!txtProves(records, row.token)) {
    return { ok: false, message: `No matching TXT record on ${domain} yet. DNS changes can take up to an hour to show.` };
  }
  try {
    await withTenant(o.orgId, (sql) => sql`UPDATE sso_domains SET verified_at = now() WHERE org_id = ${o.orgId} AND domain = ${domain}`);
  } catch (e) {
    if (e instanceof Error && e.message.includes("sso_domains_verified")) return { ok: false, message: `Another company on Sales Desk has already proved ${domain}.` };
    throw e;
  }
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "sso.domain_verified", targetType: "domain", targetId: domain });
  return { ok: true, message: `${domain} is proved.` };
}

export async function removeDomain(o: { orgId: string; userId: string; domain: string }): Promise<{ ok: boolean; message: string }> {
  const domain = normaliseDomain(o.domain);
  if (!domain) return { ok: false, message: "That domain is not on the list." };
  const r = await withTenant(o.orgId, async (sql) => {
    const [left] = await sql<{ n: number; enforce: boolean }[]>`
      SELECT (SELECT count(*)::int FROM sso_domains WHERE org_id = ${o.orgId} AND verified_at IS NOT NULL AND domain <> ${domain}) AS n,
             coalesce((SELECT enforce FROM sso_configs WHERE org_id = ${o.orgId}), false) AS enforce`;
    if (left.enforce && left.n === 0) return "It is the last proved domain while single sign-on is required. Make it optional first.";
    await sql`DELETE FROM sso_domains WHERE org_id = ${o.orgId} AND domain = ${domain}`;
    return null;
  });
  if (r) return { ok: false, message: r };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "sso.domain_removed", targetType: "domain", targetId: domain });
  return { ok: true, message: `${domain} removed.` };
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/** The organisation that signs in this address through its own provider, if any. */
export async function ssoForEmail(email: string): Promise<{ orgId: string; enforce: boolean; isAdmin: boolean } | null> {
  const domain = normaliseDomain(domainOf(email.trim().toLowerCase()));
  if (!domain) return null;
  const [r] = await controlDb<{ org_id: string; enforce: boolean; is_admin: boolean }[]>`
    SELECT c.org_id, c.enforce,
           EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                   WHERE u.email = ${email.trim().toLowerCase()} AND m.org_id = c.org_id
                     AND m.role = 'ORG_ADMIN' AND m.status = 'ACTIVE') AS is_admin
    FROM sso_domains d JOIN sso_configs c ON c.org_id = d.org_id
    JOIN orgs o ON o.id = c.org_id AND o.status = 'ACTIVE'
    WHERE d.domain = ${domain} AND d.verified_at IS NOT NULL
    LIMIT 1`;
  return r ? { orgId: r.org_id, enforce: r.enforce, isAdmin: r.is_admin } : null;
}

/** Whether Google or Microsoft must turn this address away, for its company's SSO. */
export async function ssoRequiredFor(email: string): Promise<boolean> {
  const s = await ssoForEmail(email);
  return !!s && ssoBlocks({ enforce: s.enforce, isAdmin: s.isAdmin });
}

type Config = { idp_entity_id: string; sso_url: string; certificates: string[] };

/** node-saml's request cache, kept in the tenant's own table. */
function cacheFor(orgId: string): CacheProvider {
  return {
    async saveAsync(key, value) {
      await withTenant(orgId, (sql) => sql`
        INSERT INTO saml_requests (id, org_id) VALUES (${key.slice(0, 200)}, ${orgId}) ON CONFLICT (id) DO NOTHING`);
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      const [r] = await withTenant(orgId, (sql) => sql<{ created_at: Date }[]>`
        SELECT created_at FROM saml_requests WHERE org_id = ${orgId} AND id = ${key} AND created_at > now() - interval '10 minutes'`);
      return r ? r.created_at.toISOString() : null;
    },
    async removeAsync(key) {
      if (!key) return null;
      const [r] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
        DELETE FROM saml_requests WHERE org_id = ${orgId} AND (id = ${key} OR created_at < now() - interval '1 day') RETURNING id`);
      return r ? key : null;
    },
  };
}

function samlFor(orgId: string, c: Config): SAML {
  const sp = spValues(ssoBase(), orgId);
  return new SAML({
    callbackUrl: sp.acsUrl,
    entryPoint: c.sso_url,
    issuer: sp.entityId,
    audience: sp.entityId,
    idpIssuer: c.idp_entity_id,
    idpCert: c.certificates.map(toPem),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60_000,
    cacheProvider: cacheFor(orgId),
    acceptedClockSkewMs: 2 * 60_000,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    disableRequestedAuthnContext: true,
  });
}

async function configOf(orgId: string): Promise<Config | null> {
  if (!isId(orgId)) return null;
  const [c] = await controlDb<Config[]>`
    SELECT c.idp_entity_id, c.sso_url, c.certificates FROM sso_configs c JOIN orgs o ON o.id = c.org_id AND o.status = 'ACTIVE'
    WHERE c.org_id = ${orgId}`;
  return c ?? null;
}

/** Where to send the browser to sign in: the provider, with our request. */
export async function startSamlLogin(orgId: string, o: { test?: boolean } = {}): Promise<string | null> {
  const c = await configOf(orgId);
  if (!c) return null;
  return samlFor(orgId, c).getAuthorizeUrlAsync(o.test ? "test" : "", undefined, {});
}

/** Our own side, as SAML metadata, for the IT team's provider. */
export function spMetadata(orgId: string): string {
  const sp = spValues(ssoBase(), orgId);
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${sp.entityId}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService index="1" isDefault="true" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${sp.acsUrl}"/>
  </SPSSODescriptor>
</EntityDescriptor>
`;
}

export type SamlOutcome =
  | { ok: true; ticket: string; test: boolean }
  | { ok: false; code: "NOT_SET_UP" | "INVALID" | "NO_EMAIL" | "WRONG_DOMAIN" | "REPLAYED" };

/**
 * The provider's answer. Every check node-saml makes (the signature on the
 * assertion, the audience, the issuer, the times, that it answers a request
 * we made in the last ten minutes), then ours: an address on a domain this
 * company proved, and an assertion never accepted before.
 */
export async function finishSamlLogin(orgId: string, body: Record<string, string>): Promise<SamlOutcome> {
  const c = await configOf(orgId);
  if (!c) return { ok: false, code: "NOT_SET_UP" };
  let profile: Record<string, unknown> | null = null;
  let assertionXml = "";
  try {
    const res = await samlFor(orgId, c).validatePostResponseAsync(body);
    profile = res.profile as unknown as Record<string, unknown> | null;
    assertionXml = res.profile?.getAssertionXml?.() ?? "";
  } catch (e) {
    await audit({ orgId, actorUserId: null, action: "auth.sso_refused", targetType: "org", targetId: orgId, metadata: { code: "INVALID", reason: String(e instanceof Error ? e.message : e).slice(0, 120) } });
    return { ok: false, code: "INVALID" };
  }
  const person = profile ? personFrom(profile) : null;
  if (!person) {
    await audit({ orgId, actorUserId: null, action: "auth.sso_refused", targetType: "org", targetId: orgId, metadata: { code: "NO_EMAIL" } });
    return { ok: false, code: "NO_EMAIL" };
  }
  const domain = domainOf(person.email);
  const assertionId = assertionXml.match(/<(?:\w+:)?Assertion\b[^>]*\bID="([^"]+)"/)?.[1] ?? null;
  const fail = await withTenant(orgId, async (sql) => {
    const [d] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sso_domains WHERE org_id = ${orgId} AND domain = ${domain} AND verified_at IS NOT NULL`;
    if (!d.n) return "WRONG_DOMAIN" as const;
    if (!assertionId) return "INVALID" as const;
    const seen = await sql`
      INSERT INTO saml_seen (org_id, assertion_id) VALUES (${orgId}, ${assertionId.slice(0, 200)}) ON CONFLICT DO NOTHING RETURNING assertion_id`;
    return seen.length ? null : ("REPLAYED" as const);
  });
  if (fail) {
    await audit({ orgId, actorUserId: null, action: "auth.sso_refused", targetType: "domain", targetId: domain, metadata: { code: fail, email_sha256: auditHash(person.email) } });
    return { ok: false, code: fail };
  }
  // Signing in is the control plane's: this person has no tenant context yet.
  const [user] = await controlDb<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name, last_login_at)
    VALUES (${person.email}, ${domain}, ${person.name}, now())
    ON CONFLICT (email) DO UPDATE SET name = COALESCE(users.name, EXCLUDED.name), last_login_at = now()
    RETURNING id`;
  await claimInvites(user.id);
  const ticket = randomBytes(32).toString("base64url");
  await withTenant(orgId, async (sql) => {
    await sql`UPDATE sso_configs SET tested_at = now(), tested_by = ${user.id} WHERE org_id = ${orgId}`;
    await sql`
      INSERT INTO sso_tickets (org_id, user_id, token_hash, expires_at)
      VALUES (${orgId}, ${user.id}, ${sha256(ticket)}, now() + interval '2 minutes')`;
  });
  await audit({ orgId, actorUserId: user.id, action: "auth.sso_signin", targetType: "domain", targetId: domain });
  return { ok: true, ticket, test: body.RelayState === "test" };
}

/** Which organisation a ticket was issued for, without spending it. */
export async function ticketOrg(ticket: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return null;
  const [r] = await controlDb<{ org_id: string }[]>`
    SELECT org_id FROM sso_tickets WHERE token_hash = ${sha256(ticket)} AND used_at IS NULL AND expires_at > now()`;
  return r?.org_id ?? null;
}

/** Spend a ticket: once, inside two minutes. The person it was issued for, or nothing. */
export async function redeemTicket(ticket: string): Promise<{ id: string; email: string; name: string | null } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(ticket)) return null;
  const [t] = await controlDb<{ user_id: string }[]>`
    UPDATE sso_tickets SET used_at = now()
    WHERE token_hash = ${sha256(ticket)} AND used_at IS NULL AND expires_at > now()
    RETURNING user_id`;
  if (!t) return null;
  const [u] = await controlDb<{ id: string; email: string | null; name: string | null }[]>`
    SELECT id, email, name FROM users WHERE id = ${t.user_id} AND erased_at IS NULL`;
  return u?.email ? { id: u.id, email: u.email, name: u.name } : null;
}

/** Today's items about single sign-on: a certificate near its end, groups nobody mapped. */
export async function ssoQueue(orgId: string, nowIso = new Date().toISOString()): Promise<SsoAlert[]> {
  try {
    const [row] = await withTenant(orgId, (sql) => sql<{ certificates: string[] | null; unmapped: number }[]>`
      SELECT (SELECT certificates FROM sso_configs WHERE org_id = ${orgId}) AS certificates,
             (SELECT count(*)::int FROM scim_groups WHERE org_id = ${orgId} AND role IS NULL) AS unmapped`);
    return ssoAlerts({ certsValidTo: (row?.certificates ?? []).map(certValidTo), unmappedGroups: row?.unmapped ?? 0, nowIso });
  } catch (e) {
    console.error("sso: Today's items could not be read", e);
    return [];
  }
}
