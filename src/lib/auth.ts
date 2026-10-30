import NextAuth from "next-auth";
import { cookies } from "next/headers";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { controlDb, audit, auditHash } from "@/lib/db";
import {
  parseAccount,
  verifyWorkAccount,
  type Provider,
  type WorkAccount,
} from "@/lib/work-account";
import { claimInvites, hasStandingAccess } from "@/lib/invite-claim";
import { redeemTicket, ssoRequiredFor } from "@/lib/sso";
import { finishPhoneSignIn } from "@/lib/phone-session";
import { readMethod } from "@/lib/phone-session-rules";
import { devLoginCodeOk, devLoginUser } from "@/lib/dev-login";
import { demoUser, isDemoFront } from "@/lib/demo-front";

/**
 * A channel partner's founder may sign up with a personal Google account:
 * most broker firms have no company domain, and the firm proves its phone
 * with a code instead. Only the bars a personal Gmail fails are waived, only
 * when the person chose "Channel partner" on the sign-in page, and what they
 * can then found is a channel partner and nothing else (`onboarding`).
 */
const PARTNER_WAIVABLE = new Set(["PERSONAL_GOOGLE_ACCOUNT", "PUBLIC_EMAIL_DOMAIN"]);

async function signingUpAsPartner(): Promise<boolean> {
  try {
    return (await cookies()).get("salesdesk.signup_as")?.value === "CHANNEL_PARTNER";
  } catch {
    return false;
  }
}

/**
 * Sign-in is company-identity only: Google Workspace or Microsoft Entra ID.
 *
 * Two layers enforce that, and both matter:
 *
 *   1. At the IdP. The Entra issuer is pinned to /organizations, which refuses
 *      consumer Microsoft accounts before a token is ever minted.
 *   2. In signIn() below, against the signed claims -- Google's `hd`, Entra's
 *      `tid`. This is the layer that survives an app registration being
 *      reconfigured by someone in a hurry.
 *
 * Rejections are audited. A stream of PERSONAL_GOOGLE_ACCOUNT rejections from
 * one domain is a design partner who needs the escape hatch, not an attack.
 */

/**
 * Which providers actually have credentials.
 *
 * Without this the sign-in button still posts, and the user is bounced to
 * Google or Entra only to be told `client_id` is missing -- an error page on
 * someone else's domain, for a misconfiguration on ours. Report it here
 * instead.
 */
export function configuredProviders(): { google: boolean; microsoft: boolean } {
  return {
    google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
    microsoft: Boolean(
      process.env.AUTH_MICROSOFT_ENTRA_ID_ID &&
        process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
    ),
  };
}

async function upsertIdentity(account: WorkAccount): Promise<string> {
  return controlDb.begin(async (tx) => {
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO users (email, email_domain, name, picture, last_login_at)
      VALUES (${account.email}, ${account.emailDomain}, ${account.name},
              ${account.picture}, now())
      ON CONFLICT (email) DO UPDATE
        SET name         = COALESCE(EXCLUDED.name, users.name),
            picture      = COALESCE(EXCLUDED.picture, users.picture),
            last_login_at = now()
      RETURNING id
    `;

    await tx`
      INSERT INTO user_identities (user_id, provider, provider_subject, idp_tenant)
      VALUES (${user.id}, ${account.provider}, ${account.subject}, ${account.idpTenant})
      ON CONFLICT (provider, provider_subject) DO UPDATE
        SET idp_tenant = EXCLUDED.idp_tenant
    `;

    return user.id;
  }) as Promise<string>;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: { prompt: "select_account", access_type: "offline" },
      },
    }),
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      // /organizations refuses personal Microsoft accounts at the IdP.
      issuer:
        process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER ??
        "https://login.microsoftonline.com/organizations/v2.0",
    }),
    // A company's own identity provider. The assertion was checked at our
    // ACS address (`finishSamlLogin()`); what arrives here is the one-use,
    // two-minute ticket that check issued, and nothing else signs anybody in.
    Credentials({
      id: "sso",
      name: "Single sign-on",
      credentials: { ticket: {} },
      async authorize(c) {
        const u = await redeemTicket(String(c?.ticket ?? ""));
        return u ? { id: u.id, email: u.email, name: u.name } : null;
      },
    }),
    // A channel partner's person, by a code sent to their proved phone. The
    // session it makes is marked `phone`, and `authzFor()` holds such a
    // session to the in-session tier whatever role the person has.
    Credentials({
      id: "phone",
      name: "Phone",
      credentials: { challengeId: {}, phone: {}, code: {} },
      async authorize(c) {
        const r = await finishPhoneSignIn({
          challengeId: String(c?.challengeId ?? ""),
          raw: String(c?.phone ?? ""),
          code: String(c?.code ?? ""),
        });
        return r.ok ? { id: r.userId, name: r.name } : null;
      },
    }),
    // The development door (`dev-login.ts`): shut on a hosted site unless it
    // runs under ENVIRONMENT=development with DEV_LOGIN_CODE, and then only
    // with that code.
    Credentials({
      id: "dev",
      name: "Dev login",
      credentials: { email: {}, code: {} },
      async authorize(credentials) {
        // On a hosted site the door asks its code here too, so a post made
        // straight to this provider opens nothing the sign-in page would not.
        if (!devLoginCodeOk(credentials?.code)) return null;
        const u = await devLoginUser(typeof credentials?.email === "string" ? credentials.email : null);
        if (!u) return null;
        await audit({
          orgId: null,
          actorUserId: u.id,
          action: "auth.signin_dev",
          targetType: "domain",
          targetId: u.email.split("@")[1] ?? null,
          metadata: { email_sha256: auditHash(u.email) },
        });
        return { id: u.id, email: u.email, name: u.name };
      },
    }),
    // The demo front (`demo-front.ts`): only a request carrying its secret
    // header signs in, and only as the demo user.
    Credentials({
      id: "demo",
      name: "Demo login",
      credentials: {},
      async authorize() {
        if (!(await isDemoFront())) return null;
        const u = await demoUser();
        if (!u) return null;
        await audit({
          orgId: null,
          actorUserId: u.id,
          action: "auth.signin_demo",
          targetType: "domain",
          targetId: u.email.split("@")[1] ?? null,
          metadata: { email_sha256: auditHash(u.email) },
        });
        return { id: u.id, email: u.email, name: u.name };
      },
    }),
  ],

  session: { strategy: "jwt" },
  pages: { signIn: "/signin", error: "/signin" },

  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "sso" || account?.provider === "phone" || account?.provider === "dev" || account?.provider === "demo") return true;
      if (!account || !profile) return "/signin?error=EMAIL_MISSING";

      const provider = account.provider as Provider;
      if (provider !== "google" && provider !== "microsoft-entra-id") {
        return "/signin?error=BLOCKED_DOMAIN";
      }

      const verdict = verifyWorkAccount(provider, profile as Record<string, unknown>);
      let identity: WorkAccount | null = verdict.ok ? verdict.account : null;

      // The work-account bar belongs at TENANT CREATION, not at the door.
      // It exists to stop junk tenants, to supply the dedupe key and to be the
      // enterprise-legal signal, and none of that applies to someone an admin
      // has already vouched for. So an invited address gets in on whatever
      // mailbox it has; the same address holding no invite still cannot, and
      // still cannot found an org.
      if (!identity) {
        const parsed = parseAccount(provider, profile as Record<string, unknown>);
        if (parsed && (await hasStandingAccess(parsed.email))) {
          identity = parsed;
          await audit({
            orgId: null,
            actorUserId: null,
            action: "auth.signin_by_invite",
            targetType: "domain",
            targetId: parsed.emailDomain,
            metadata: {
              provider,
              // Which bar it would have failed, so a stream of these is
              // readable later without keeping the address.
              waived: verdict.ok ? null : verdict.code,
              email_sha256: auditHash(parsed.email),
            },
          });
        }
      }

      if (!identity && !verdict.ok && PARTNER_WAIVABLE.has(verdict.code) && provider === "google" && (await signingUpAsPartner())) {
        const parsed = parseAccount(provider, profile as Record<string, unknown>);
        if (parsed && (profile as Record<string, unknown>).email_verified !== false) {
          identity = parsed;
          await audit({
            orgId: null,
            actorUserId: null,
            action: "auth.signin_partner_founder",
            targetType: "domain",
            targetId: parsed.emailDomain,
            metadata: { provider, waived: verdict.code, email_sha256: auditHash(parsed.email) },
          });
        }
      }

      if (!identity) {
        // This person was refused and never became a user, so there is no
        // account to erase later and no way to honour a request to. The
        // domain is what an investigation actually works from; the hash is
        // enough to spot one address hammering sign-in.
        const attempted = typeof profile.email === "string" ? profile.email : null;
        const code = verdict.ok ? "EMAIL_MISSING" : verdict.code;
        await audit({
          orgId: null,
          actorUserId: null,
          action: "auth.signin_rejected",
          targetType: "domain",
          targetId: attempted?.split("@")[1]?.toLowerCase() ?? null,
          metadata: {
            provider,
            code,
            email_sha256: auditHash(attempted),
          },
        });
        return `/signin?error=${code}`;
      }

      // A company that requires its own sign-in sends its people there. Its
      // admins keep this door, so a broken identity provider is fixable.
      if (await ssoRequiredFor(identity.email)) {
        await audit({
          orgId: null,
          actorUserId: null,
          action: "auth.signin_rejected",
          targetType: "domain",
          targetId: identity.emailDomain,
          metadata: { provider, code: "SSO_REQUIRED", email_sha256: auditHash(identity.email) },
        });
        return "/signin?error=SSO_REQUIRED";
      }

      // Fills the shell row an invite may have created, ON CONFLICT (email),
      // so the invite and the real account converge on one user rather than
      // racing to create two. Then every invite waiting on this identity
      // becomes a live membership.
      const userId = await upsertIdentity(identity);
      await claimInvites(userId);
      return true;
    },

    async jwt({ token, profile, account, user }) {
      // Resolve our own user id once, at sign-in, and carry it on the token so
      // that every later request has an identity without a database round-trip.
      if ((account?.provider === "sso" || account?.provider === "phone") && user?.id) {
        token.userId = user.id;
        token.method = account.provider;
      } else if ((account?.provider === "dev" || account?.provider === "demo") && user?.id) {
        token.userId = user.id;
        token.method = "oauth";
      } else if (account && profile) {
        token.method = "oauth";
        const email =
          (typeof profile.email === "string" && profile.email) ||
          (typeof profile.preferred_username === "string" &&
            profile.preferred_username) ||
          "";
        if (email) {
          const [row] = await controlDb<{ id: string }[]>`
            SELECT id FROM users WHERE email = ${email.toLowerCase()} LIMIT 1
          `;
          if (row) token.userId = row.id;
        }
      }
      return token;
    },

    async session({ session, token }) {
      if (token.userId) {
        session.user.id = token.userId as string;
      }
      session.method = readMethod(token.method);
      return session;
    },
  },
});
