import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth, signIn, configuredProviders } from "@/lib/auth";
import type { RejectionCode } from "@/lib/work-account";
import { ACTIVE_ORG_COOKIE, SIGNUP_AS_COOKIE } from "@/lib/onboarding";
import { devLoginButtons, devLoginCodeOk, devLoginNeedsCode, devLoginOrg, devLoginUser } from "@/lib/dev-login";
import { COMPANY_KIND, COMPANY_KINDS, kindFromParam, type CompanyKind } from "@/lib/mandate-rules";
import { ssoForEmail } from "@/lib/sso";
import { demoOrg, demoUser, isDemoFront } from "@/lib/demo-front";
import { ArrowUpRight, Mark } from "@/components/icons";
import "./signin.css";

type SsoCode = "SSO_REQUIRED" | "SSO_NONE" | "SSO_INVALID" | "SSO_NO_EMAIL" | "SSO_WRONG_DOMAIN" | "SSO_REPLAYED" | "SSO_NOT_SET_UP" | "SSO_EXPIRED";

const MESSAGES: Record<RejectionCode | SsoCode | "Default" | "AccessDenied", { title: string; body: string }> = {
  SSO_REQUIRED: {
    title: "Your company signs you in itself",
    body: "Use your company's single sign-on below, with your work email.",
  },
  SSO_NONE: {
    title: "No single sign-on for that address",
    body: "Your company has not set up single sign-on on Sales Desk. Use Google or Microsoft.",
  },
  SSO_INVALID: {
    title: "Your company's sign-in could not be checked",
    body: "Try again. If it keeps happening, ask your IT team to check the Sales Desk app in your identity provider.",
  },
  SSO_NO_EMAIL: {
    title: "No email address came back",
    body: "Your identity provider did not send your work email. Ask your IT team to send it as the NameID.",
  },
  SSO_WRONG_DOMAIN: {
    title: "That address is not on your company's domain",
    body: "Sign in with your work account on a domain your company has proved on Sales Desk.",
  },
  SSO_REPLAYED: {
    title: "That sign-in was already used",
    body: "Start again from this page.",
  },
  SSO_NOT_SET_UP: {
    title: "Single sign-on is not set up",
    body: "Use Google or Microsoft, or ask your admin to finish setting it up.",
  },
  SSO_EXPIRED: {
    title: "That sign-in took too long",
    body: "Start again from this page.",
  },
  PERSONAL_GOOGLE_ACCOUNT: {
    title: "That is a personal Google account",
    body: "Developers and mandate firms sign in with their Google Workspace account, the one on the company domain. A channel partner may use any Google account: choose Channel partner first.",
  },
  PERSONAL_MICROSOFT_ACCOUNT: {
    title: "That is a personal Microsoft account",
    body: "Sign in with your organisation's Microsoft account, the one issued by your company, not an @outlook.com or @hotmail.com address.",
  },
  PUBLIC_EMAIL_DOMAIN: {
    title: "Personal email domains are not accepted here",
    body: "Use your company email. A channel partner may use any Google account: choose Channel partner first.",
  },
  DOMAIN_TENANT_MISMATCH: {
    title: "Domain does not match that directory",
    body: "The email address does not belong to the workspace you signed in with. Try again with your primary company account.",
  },
  EMAIL_UNVERIFIED: {
    title: "Unverified email address",
    body: "Your identity provider reports this address as unverified. Verify it and try again.",
  },
  EMAIL_MISSING: {
    title: "No email address returned",
    body: "That account did not share an email address with us, so we cannot identify you. Check the permissions on the consent screen.",
  },
  BLOCKED_DOMAIN: {
    title: "Sign-in not permitted",
    body: "This domain has been blocked for sign-up. Contact your Sales Desk account manager.",
  },
  AccessDenied: {
    title: "Sign-in was declined",
    body: "Access was denied at the identity provider. Check with your IT administrator that Sales Desk is approved for your directory.",
  },
  Default: {
    title: "Sign-in did not complete",
    body: "Something went wrong on the way back from your identity provider. Please try again.",
  },
};

/**
 * Remember what the person is signing up as, then hand over to the identity
 * provider. Without a kind it is a returning person, and any earlier choice
 * is forgotten so it cannot waive a bar it was not chosen for.
 */
async function continueWith(provider: "google" | "microsoft-entra-id", kind: CompanyKind | null) {
  "use server";
  const jar = await cookies();
  if (kind) jar.set(SIGNUP_AS_COOKIE, kind, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 60 });
  else jar.delete(SIGNUP_AS_COOKIE);
  await signIn(provider, { redirectTo: "/" });
}

/** Send a work address to its company's own sign-in page, when it has one. */
async function continueWithSso(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const sso = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? await ssoForEmail(email) : null;
  (await cookies()).delete(SIGNUP_AS_COOKIE);
  redirect(sso ? `/api/sso/${sso.orgId}/login` : "/signin?error=SSO_NONE");
}

/** The development door: sign in as one address of `DEV_LOGIN_EMAIL`. */
async function devLogin(email: string, form: FormData) {
  "use server";
  const code = form.get("code");
  if (!devLoginCodeOk(code)) {
    await new Promise((r) => setTimeout(r, 1_000));
    redirect("/signin?dev=wrong");
  }
  const user = await devLoginUser(email);
  if (!user) redirect("/signin");
  const jar = await cookies();
  jar.delete(SIGNUP_AS_COOKIE);
  const org = await devLoginOrg(user.id);
  if (org) jar.set(ACTIVE_ORG_COOKIE, org, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  await signIn("dev", { email: user.email, code: typeof code === "string" ? code : "", redirectTo: "/dashboard" });
}

/** The demo front's one door: sign in as the demo user, nothing to type. */
async function demoLogin() {
  "use server";
  if (!(await isDemoFront())) redirect("/signin");
  const user = await demoUser();
  if (!user) redirect("/signin");
  const jar = await cookies();
  jar.delete(SIGNUP_AS_COOKIE);
  const org = await demoOrg(user.id);
  if (org) jar.set(ACTIVE_ORG_COOKIE, org, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  await signIn("demo", { redirectTo: "/dashboard" });
}

const GOOGLE = (
  <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.5 6.6-16.3z" />
    <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.4 15.5 46 24 46z" />
    <path fill="#FBBC05" d="M11.8 28.3c-.4-1.3-.7-2.7-.7-4.3s.2-2.9.7-4.3v-5.7H4.5C2.9 17.2 2 20.5 2 24s.9 6.8 2.5 9.7l7.3-5.4z" />
    <path fill="#EA4335" d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.5 2 8.1 6.6 4.5 14.3l7.3 5.7c1.7-5.2 6.5-9.3 12.2-9.3z" />
  </svg>
);

const MICROSOFT = (
  <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true">
    <path fill="#F25022" d="M1 1h10v10H1z" />
    <path fill="#7FBA00" d="M12 1h10v10H12z" />
    <path fill="#00A4EF" d="M1 12h10v10H1z" />
    <path fill="#FFB900" d="M12 12h10v10H12z" />
  </svg>
);

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; as?: string; dev?: string }>;
}) {
  const session = await auth();
  if (session?.user?.id) redirect("/");

  if (await isDemoFront()) {
    return (
      <div className="auth">
        <main className="auth__card">
          <div className="brand" style={{ marginBottom: 22 }}>
            <span className="brand__glyph"><Mark /></span>
            <span className="brand__name">Sales Desk</span>
          </div>
          <h1>
            Real estate sales and <span className="em">marketing</span>, on autopilot
          </h1>
          <p className="sub" style={{ marginBottom: 20 }}>
            AI calling, site visits, campaigns and channel partners in one console. Explore a sample developer&rsquo;s account.
          </p>
          <form action={demoLogin}>
            <button type="submit" className="btn btn--ink" style={{ width: "100%", justifyContent: "center" }}>
              Open the demo <ArrowUpRight size={14} />
            </button>
          </form>
        </main>
      </div>
    );
  }

  const { error, as, dev } = await searchParams;
  const devWrong = dev === "wrong";
  const kind = kindFromParam(as);
  const notice = error ? (MESSAGES[error as RejectionCode] ?? MESSAGES.Default) : null;
  const providers = configuredProviders();
  const anyConfigured = providers.google || providers.microsoft;
  const partner = kind === "CHANNEL_PARTNER";
  const devButtons = devLoginButtons();
  const devCode = devLoginNeedsCode();

  const buttons = (
    <>
      <form action={continueWith.bind(null, "google", kind)}>
        <button className="provider" type="submit" disabled={!providers.google}>
          {GOOGLE}
          {partner ? "Continue with Google" : "Continue with Google Workspace"}
        </button>
      </form>
      <form action={continueWith.bind(null, "microsoft-entra-id", kind)}>
        <button className="provider" type="submit" disabled={!providers.microsoft}>
          {MICROSOFT}
          Continue with Microsoft
        </button>
      </form>
    </>
  );

  return (
    <div className="auth">
      <main className="auth__card">
        <div className="brand" style={{ marginBottom: 22 }}>
          <span className="brand__glyph"><Mark /></span>
          <span className="brand__name">Sales Desk</span>
        </div>

        {notice && (
          <div className="note note--risk" role="alert">
            <strong>{notice.title}</strong>
            {notice.body}
          </div>
        )}

        {!anyConfigured && (
          <div className="note note--info" role="status">
            <strong>No identity provider is configured yet</strong>
            Add your OAuth credentials to <code>.env.local</code> and restart the
            dev server. Until then both buttons are disabled.
          </div>
        )}

        {kind ? (
          <>
            <h1>
              Sign up as a <span className="em">{COMPANY_KIND[kind].label.toLowerCase()}</span>
            </h1>
            <p className="sub" style={{ marginBottom: 20 }}>
              {partner
                ? "Any Google account works. Next you will confirm your firm's WhatsApp number with a code."
                : "Use your company Google Workspace or Microsoft account. The first person from your company creates it and becomes its admin."}
            </p>
            <div className="kind-chosen">
              <span className="kind-chosen__label">{COMPANY_KIND[kind].label}</span>
              <span className="kind-chosen__line">{COMPANY_KIND[kind].line}</span>
              <Link href="/signin" className="kind-chosen__change">
                Change
              </Link>
            </div>
            {buttons}
          </>
        ) : (
          <>
            <h1>
              Welcome to <span className="em">Sales Desk</span>
            </h1>
            <p className="sub" style={{ marginBottom: 18 }}>
              New here? Tell us who you are.
            </p>
            <ul className="kinds" aria-label="Sign up as">
              {COMPANY_KINDS.map((k, i) => (
                <li key={k}>
                  <Link href={`/signin?as=${COMPANY_KIND[k].param}`} className="kinds__item">
                    <span className="kinds__no">0{i + 1}</span>
                    <span className="kinds__body">
                      <span className="kinds__label">{COMPANY_KIND[k].label}</span>
                      <span className="kinds__line">{COMPANY_KIND[k].line}</span>
                    </span>
                    <span className="kinds__go" aria-hidden>
                      <ArrowUpRight size={14} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="kinds__or">
              <span>Already on Sales Desk?</span>
            </div>
            {buttons}
            <Link href="/signin/phone" className="phone-door">
              Channel partner? Sign in with your phone
            </Link>
            <details className="sso" open={error === "SSO_REQUIRED" || undefined}>
              <summary>Use your company&rsquo;s single sign-on</summary>
              <form action={continueWithSso} className="sso__form">
                <label className="sr-only" htmlFor="sso-email">Work email</label>
                <input id="sso-email" name="email" type="email" required autoComplete="email" placeholder="you@yourcompany.com" />
                <button type="submit" className="btn btn--ink">Continue</button>
              </form>
            </details>
          </>
        )}
      </main>
      {devButtons.length > 0 && (
        <div className="dev-login">
          {devButtons.map((b) => (
            <form key={b.email} action={devLogin.bind(null, b.email)}>
              {devCode && (
                <>
                  <label className="sr-only" htmlFor={`dev-code-${b.email}`}>Code</label>
                  <input id={`dev-code-${b.email}`} name="code" type="password" required autoComplete="off" placeholder="Code" className="dev-login__code" />
                </>
              )}
              <button type="submit" className="btn btn--ink" title={b.email}>
                {b.label}
              </button>
            </form>
          ))}
          {devWrong && <p className="dev-login__wrong" role="alert">That code is not right.</p>}
        </div>
      )}
    </div>
  );
}
