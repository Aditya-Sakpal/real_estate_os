/**
 * Work-account enforcement.
 *
 * The first person from a developer signs up with their COMPANY identity --
 * Google Workspace or Microsoft Entra ID -- never a personal gmail/outlook
 * address. That is enforced from claims the identity provider signs, not from
 * a domain blocklist:
 *
 *   Google    a Workspace account carries the `hd` (hosted domain) claim.
 *             Consumer @gmail.com accounts never do. Absence of `hd` is
 *             therefore proof of a personal account.
 *
 *   Entra     every organizational account carries `tid`, the directory
 *             (tenant) id. Personal Microsoft accounts all live in one
 *             well-known consumer tenant, 9188040d-...-36a304b66dad.
 *
 * The domain blocklist below is defence in depth only -- it catches a
 * misconfigured Entra app registration that still admits consumer accounts.
 * It is not the primary control and must never become it.
 */

import { isDevelopment } from "./app-env.ts";

/** The single consumer tenant every personal Microsoft account belongs to. */
const MSA_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.in",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.in",
  "msn.com",
  "yahoo.com",
  "yahoo.in",
  "yahoo.co.in",
  "ymail.com",
  "rediffmail.com",
  "rediff.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "mail.com",
  "gmx.com",
  "yandex.com",
]);

export type Provider = "google" | "microsoft-entra-id";

export type RejectionCode =
  | "EMAIL_MISSING"
  | "EMAIL_UNVERIFIED"
  | "PERSONAL_GOOGLE_ACCOUNT"
  | "PERSONAL_MICROSOFT_ACCOUNT"
  | "PUBLIC_EMAIL_DOMAIN"
  | "DOMAIN_TENANT_MISMATCH"
  | "BLOCKED_DOMAIN";

export type WorkAccount = {
  provider: Provider;
  subject: string;
  email: string;
  emailDomain: string;
  /** Google `hd`, or Entra `tid`. Proof of corporate origin; kept for routing. */
  idpTenant: string;
  name: string | null;
  picture: string | null;
};

export type VerifyResult =
  | { ok: true; account: WorkAccount }
  | { ok: false; code: RejectionCode; message: string };

/**
 * A personal Google or Microsoft account may sign in, found any kind of
 * company and hold the admin role. True under ENVIRONMENT=development (the
 * client, 11 October 2026: testing the three kinds of company needs more
 * accounts than there are company mailboxes), or with the operator's
 * AUTH_ALLOW_PERSONAL_ACCOUNTS for a design partner with no corporate IdP.
 */
export function personalAccountsAllowed(): boolean {
  return process.env.AUTH_ALLOW_PERSONAL_ACCOUNTS === "true" || isDevelopment();
}

function extraBlockedDomains(): Set<string> {
  const raw = process.env.AUTH_EXTRA_BLOCKED_DOMAINS ?? "";
  return new Set(
    raw
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Is this a consumer email provider rather than a company domain?
 *
 * Exported because onboarding needs it too: a public domain must never be
 * stored as an org's primary_domain or matched against for tenant dedupe. With
 * AUTH_ALLOW_PERSONAL_ACCOUNTS on, "gmail.com" would otherwise become one
 * org's identity and swallow every later Gmail signup into it.
 */
export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.toLowerCase());
}

function isPublicDomain(domain: string): boolean {
  return isPublicEmailDomain(domain);
}

/**
 * A Workspace primary domain may differ from the address domain when an org
 * uses secondary domains, so we accept the address domain being the hosted
 * domain or a subdomain of it -- but nothing looser.
 */
function domainMatchesTenant(emailDomain: string, hostedDomain: string): boolean {
  return emailDomain === hostedDomain || emailDomain.endsWith(`.${hostedDomain}`);
}

function sharedChecks(
  emailRaw: unknown,
): { ok: true; email: string; domain: string } | { ok: false; code: RejectionCode; message: string } {
  const email = typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) {
    return {
      ok: false,
      code: "EMAIL_MISSING",
      message: "That account did not return an email address.",
    };
  }

  const domain = domainOf(email);

  if (extraBlockedDomains().has(domain)) {
    return {
      ok: false,
      code: "BLOCKED_DOMAIN",
      message: `Sign-ups from ${domain} are not permitted.`,
    };
  }

  if (isPublicDomain(domain) && !personalAccountsAllowed()) {
    return {
      ok: false,
      code: "PUBLIC_EMAIL_DOMAIN",
      message: `${domain} is a personal email provider. Use your company account.`,
    };
  }

  return { ok: true, email, domain };
}

/** Google: presence of `hd` is what separates Workspace from consumer Gmail. */
/**
 * Pull the account out of a profile WITHOUT judging it.
 *
 * The work-account bar belongs at tenant creation, not at the door: someone an
 * admin has already vouched for may sign in with whatever mailbox they have.
 * That path still needs the same fields, so extraction and policy are separate
 * rather than the former being trapped inside the latter.
 */
export function parseAccount(
  provider: Provider,
  profile: Record<string, unknown>,
): WorkAccount | null {
  const raw =
    (typeof profile.email === "string" && profile.email) ||
    (typeof profile.preferred_username === "string" && profile.preferred_username) ||
    "";
  const email = raw.trim().toLowerCase();
  if (!email.includes("@")) return null;

  const domain = domainOf(email);
  const hd = typeof profile.hd === "string" ? profile.hd.trim().toLowerCase() : "";
  const tid = typeof profile.tid === "string" ? profile.tid.trim() : "";

  return {
    provider,
    subject: String(profile.sub ?? profile.oid ?? ""),
    email,
    emailDomain: domain,
    idpTenant: provider === "google" ? hd || domain : tid || domain,
    name: typeof profile.name === "string" ? profile.name : null,
    picture: typeof profile.picture === "string" ? profile.picture : null,
  };
}

export function verifyGoogleAccount(profile: Record<string, unknown>): VerifyResult {
  const base = sharedChecks(profile.email);
  if (!base.ok) return base;

  if (profile.email_verified === false) {
    return {
      ok: false,
      code: "EMAIL_UNVERIFIED",
      message: "Google reports this address as unverified.",
    };
  }

  const hd = typeof profile.hd === "string" ? profile.hd.trim().toLowerCase() : "";

  if (!hd) {
    if (!personalAccountsAllowed()) {
      return {
        ok: false,
        code: "PERSONAL_GOOGLE_ACCOUNT",
        message:
          "This is a personal Google account. Sign in with your Google Workspace account.",
      };
    }
  } else if (!domainMatchesTenant(base.domain, hd)) {
    return {
      ok: false,
      code: "DOMAIN_TENANT_MISMATCH",
      message: "Email domain does not belong to the signed-in Workspace domain.",
    };
  }

  return {
    ok: true,
    account: {
      provider: "google",
      subject: String(profile.sub ?? ""),
      email: base.email,
      emailDomain: base.domain,
      idpTenant: hd || base.domain,
      name: typeof profile.name === "string" ? profile.name : null,
      picture: typeof profile.picture === "string" ? profile.picture : null,
    },
  };
}

/** Entra: `tid` is the directory id. The consumer tenant is a hard reject. */
export function verifyEntraAccount(profile: Record<string, unknown>): VerifyResult {
  // Entra omits `email` unless the mail attribute is populated; the UPN in
  // preferred_username is the reliable fallback.
  const raw =
    (typeof profile.email === "string" && profile.email) ||
    (typeof profile.preferred_username === "string" && profile.preferred_username) ||
    "";

  const base = sharedChecks(raw);
  if (!base.ok) return base;

  const tid = typeof profile.tid === "string" ? profile.tid.trim().toLowerCase() : "";

  if (!tid) {
    return {
      ok: false,
      code: "PERSONAL_MICROSOFT_ACCOUNT",
      message: "That account did not return a directory id. Use your work account.",
    };
  }

  if (tid === MSA_CONSUMER_TENANT && !personalAccountsAllowed()) {
    return {
      ok: false,
      code: "PERSONAL_MICROSOFT_ACCOUNT",
      message:
        "This is a personal Microsoft account. Sign in with your organisation's Microsoft account.",
    };
  }

  return {
    ok: true,
    account: {
      provider: "microsoft-entra-id",
      subject: String(profile.oid ?? profile.sub ?? ""),
      email: base.email,
      emailDomain: base.domain,
      idpTenant: tid,
      name: typeof profile.name === "string" ? profile.name : null,
      picture: null,
    },
  };
}

export function verifyWorkAccount(
  provider: Provider,
  profile: Record<string, unknown>,
): VerifyResult {
  return provider === "google"
    ? verifyGoogleAccount(profile)
    : verifyEntraAccount(profile);
}
