/**
 * Single sign-on: the rules, pure and database-free, covered by `check:logic`.
 *
 * A developer's IT team points its identity provider at us once: our entity
 * id and our ACS address go into Okta or Entra ID, and the provider's entity
 * id, sign-in address and certificate come back here. People on the
 * company's proved domains then sign in through it, and once somebody has,
 * the company may require it.
 */

import { X509Certificate } from "node:crypto";

export type SsoInput = { entityId: string; ssoUrl: string; certificates: string[] };

/** Our side of the connection, for the IT team to paste into theirs. */
export function spValues(base: string, orgId: string): { entityId: string; acsUrl: string; metadataUrl: string; loginUrl: string } {
  const root = `${base.replace(/\/$/, "")}/api/sso/${orgId}`;
  return { entityId: `${root}/metadata`, acsUrl: `${root}/acs`, metadataUrl: `${root}/metadata`, loginUrl: `${root}/login` };
}

/** A certificate's body, whatever it was pasted as: PEM, bare base64, or with line breaks. */
export function certBody(raw: string): string {
  return raw
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
}

/** The certificates in a pasted block, one per BEGIN/END pair, or the whole block as one. */
export function splitCerts(raw: string): string[] {
  const pem = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  const bodies = (pem ?? (raw.trim() ? [raw] : [])).map(certBody).filter(Boolean);
  return [...new Set(bodies)];
}

export const toPem = (body: string) => `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join("\n") ?? body}\n-----END CERTIFICATE-----`;

/** When a certificate stops being valid, or null when it does not read as one. */
export function certValidTo(body: string): string | null {
  try {
    return new Date(new X509Certificate(toPem(body)).validTo).toISOString();
  } catch {
    return null;
  }
}

/**
 * The provider's own metadata, pasted: its entity id, its sign-in address
 * for the redirect binding, and its signing certificates. Read by pattern
 * rather than by an XML parser, because only three things are wanted from
 * it and every provider writes them the same way.
 */
export function readIdpMetadata(xml: string): Partial<SsoInput> {
  const entityId = xml.match(/<(?:\w+:)?EntityDescriptor\b[^>]*\bentityID="([^"]+)"/)?.[1];
  const services = [...xml.matchAll(/<(?:\w+:)?SingleSignOnService\b[^>]*>/g)].map((m) => m[0]);
  const redirect = services.find((s) => /HTTP-Redirect/.test(s)) ?? services[0];
  const ssoUrl = redirect?.match(/\bLocation="([^"]+)"/)?.[1];
  const signing = xml.match(/<(?:\w+:)?IDPSSODescriptor[\s\S]*?<\/(?:\w+:)?IDPSSODescriptor>/)?.[0] ?? xml;
  const keys = [...signing.matchAll(/<(?:\w+:)?KeyDescriptor\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?KeyDescriptor>/g)]
    .filter((k) => !/use="encryption"/.test(k[1]))
    .map((k) => k[2].match(/<(?:\w+:)?X509Certificate>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/)?.[1])
    .filter((c): c is string => !!c)
    .map(certBody);
  return {
    ...(entityId ? { entityId: decode(entityId) } : {}),
    ...(ssoUrl ? { ssoUrl: decode(ssoUrl) } : {}),
    ...(keys.length ? { certificates: [...new Set(keys)].slice(0, 2) } : {}),
  };
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Read the form, or say what is wrong with each field. */
export function readSsoInput(
  raw: { metadata?: string; entityId?: string; ssoUrl?: string; certificate?: string },
  nowIso: string,
): { ok: true; input: SsoInput } | { ok: false; errors: Record<string, string> } {
  const meta = raw.metadata?.trim() ? readIdpMetadata(raw.metadata) : {};
  const entityId = (raw.entityId?.trim() || meta.entityId || "").slice(0, 500);
  const ssoUrl = (raw.ssoUrl?.trim() || meta.ssoUrl || "").trim();
  const certificates = raw.certificate?.trim() ? splitCerts(raw.certificate).slice(0, 2) : meta.certificates ?? [];
  const errors: Record<string, string> = {};
  if (raw.metadata?.trim() && !meta.entityId && !meta.ssoUrl) errors.metadata = "That does not read as SAML metadata.";
  if (!entityId) errors.entityId = "Enter the identity provider's entity ID.";
  let url: URL | null = null;
  try {
    url = new URL(ssoUrl);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:") errors.ssoUrl = "Enter the sign-in URL, starting https://.";
  if (!certificates.length) errors.certificate = "Paste the signing certificate.";
  for (const c of certificates) {
    const until = certValidTo(c);
    if (!until) errors.certificate = "That does not read as a certificate.";
    else if (until <= nowIso) errors.certificate = "That certificate has expired.";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { entityId, ssoUrl: url!.toString(), certificates } };
}

/** Whether two sets of settings are the same connection. A change needs a new test. */
export const sameSettings = (a: SsoInput, b: SsoInput) =>
  a.entityId === b.entityId && a.ssoUrl === b.ssoUrl && [...a.certificates].sort().join() === [...b.certificates].sort().join();

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export function normaliseDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^@/, "").replace(/\/.*$/, "").replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) && d.length <= 253 ? d : null;
}

export const txtRecord = (token: string) => `salesdesk-verify=${token}`;

/** Whether any TXT record on the domain carries the token. Records arrive split into chunks. */
export const txtProves = (records: string[][], token: string) => records.some((chunks) => chunks.join("").trim() === txtRecord(token));

// ---------------------------------------------------------------------------
// The person an assertion names
// ---------------------------------------------------------------------------

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_CLAIMS = [
  "email",
  "mail",
  "emailAddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
];
const NAME_CLAIMS = ["displayName", "name", "http://schemas.microsoft.com/identity/claims/displayname", "urn:oid:2.16.840.1.113730.3.1.241"];
const GIVEN = ["givenName", "firstName", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname", "urn:oid:2.5.4.42"];
const FAMILY = ["surname", "sn", "lastName", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname", "urn:oid:2.5.4.4"];

const first = (p: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) {
    const v = p[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return null;
};

/** The address and name in an assertion: the NameID when it is an address, else the usual claims. */
export function personFrom(profile: Record<string, unknown>): { email: string; name: string | null } | null {
  const nameId = typeof profile.nameID === "string" ? profile.nameID.trim() : "";
  const email = (EMAIL.test(nameId) ? nameId : first(profile, EMAIL_CLAIMS) ?? "").toLowerCase();
  if (!EMAIL.test(email)) return null;
  const given = first(profile, GIVEN);
  const family = first(profile, FAMILY);
  const name = first(profile, NAME_CLAIMS) ?? ([given, family].filter(Boolean).join(" ") || null);
  return { email, name: name?.slice(0, 120) ?? null };
}

export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * Whether a Google or Microsoft sign-in is turned away for single sign-on.
 * Only on a domain the company proved and only once it required SSO; and
 * never for an admin of that company, who keeps the ordinary door so a
 * broken identity provider can be fixed from inside.
 */
export const ssoBlocks = (o: { enforce: boolean; isAdmin: boolean }) => o.enforce && !o.isAdmin;

// ---------------------------------------------------------------------------
// What Today says
// ---------------------------------------------------------------------------

export type SsoAlert = { id: string; severity: "risk" | "warn" | "info"; title: string; why: string; tag: string };

/**
 * A signing certificate close to its end breaks everybody's sign-in the day
 * it lapses, and a group from the provider that nobody mapped gives its
 * people nothing. Both are said before they bite.
 */
export function ssoAlerts(o: { certsValidTo: (string | null)[]; unmappedGroups: number; nowIso: string }): SsoAlert[] {
  const out: SsoAlert[] = [];
  const live = o.certsValidTo.filter((d): d is string => !!d).sort();
  const last = live[live.length - 1];
  if (last) {
    const days = Math.floor((Date.parse(last) - Date.parse(o.nowIso)) / 86_400_000);
    if (days <= 30) {
      out.push({
        id: "sso-cert",
        severity: days <= 7 ? "risk" : "warn",
        title: days < 0 ? "Your single sign-on certificate has expired" : "Your single sign-on certificate is about to expire",
        why: "Nobody can sign in through your provider once it lapses. Paste the new one from your provider.",
        tag: days < 0 ? "Expired" : days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"} left`,
      });
    }
  }
  if (o.unmappedGroups > 0) {
    out.push({
      id: "sso-groups",
      severity: "info",
      title: `${o.unmappedGroups} ${o.unmappedGroups === 1 ? "group" : "groups"} from your provider ${o.unmappedGroups === 1 ? "gives" : "give"} nothing yet`,
      why: "Say which role each group's people hold here, and where.",
      tag: "Groups",
    });
  }
  return out;
}
