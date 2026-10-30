import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { findExistingOrg, getSignupContext, getUserOrgState, homeFor, SIGNUP_AS_COOKIE } from "@/lib/onboarding";
import { isPublicEmailDomain, personalAccountsAllowed } from "@/lib/work-account";
import { COMPANY_KIND, COMPANY_KINDS, kindFromParam, type CompanyKind } from "@/lib/mandate-rules";
import { joinExistingOrgAction } from "./actions";
import { signOutAction } from "@/app/actions/auth";
import { OrgForm } from "./form";
import { MandateFirmForm, PartnerForm } from "./firm-forms";
import { codesSkipped } from "@/lib/otp";
import Link from "next/link";
import { Mark } from "@/components/icons";
import "../signin/signin.css";

export default async function Onboarding({
  searchParams,
}: {
  searchParams: Promise<{ another?: string; as?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  // A phone session never creates or joins a company.
  if (session.method === "phone") redirect("/dashboard");

  // "another=1" is the deliberate path from the org switcher: someone already
  // inside a tenant who genuinely runs a second company. It skips the
  // join-instead-of-create routing below, but GSTIN and PAN still dedupe.
  const { another, as } = await searchParams;
  const additional = another === "1";

  const state = await getUserOrgState(session.user.id);
  if (state.kind === "MEMBER" && !additional) redirect(homeFor(state.orgType));
  if (state.kind === "PENDING_JOIN") redirect("/join-request");

  const ctx = await getSignupContext(session.user.id);
  if (!ctx) redirect("/signin");

  // What they said they are, on the sign-in page or here. A personal Google
  // account was let in only to found a channel partner, so that is all it
  // may found, except in development, where any kind may be founded.
  const personal = isPublicEmailDomain(ctx.emailDomain);
  const partnerOnly = personal && !personalAccountsAllowed();
  const chosen: CompanyKind =
    kindFromParam(as) ?? kindFromParam((await cookies()).get(SIGNUP_AS_COOKIE)?.value) ?? "DEVELOPER";
  const kind: CompanyKind = partnerOnly ? "CHANNEL_PARTNER" : chosen;
  const tabHref = (k: CompanyKind) => `/onboarding?as=${COMPANY_KIND[k].param}${additional ? "&another=1" : ""}`;

  // Before offering to create anything, check whether this company is already
  // here. Two people from one developer signing up in the same week is the
  // normal case, not the edge case -- and two orgs for one company means split
  // leads, duplicate billing, and CP grants pointed at the wrong tenant.
  const existing = additional
    ? null
    : await findExistingOrg({
        idpTenant: ctx.idpTenant,
        emailDomain: ctx.emailDomain,
      });

  if (existing) {
    return (
      <div className="auth">
    <main className="auth__card">
        <div className="brand" style={{ marginBottom: 22 }}>
          <span className="brand__glyph"><Mark /></span>
          <span className="brand__name">Sales Desk</span>
        </div>

        <div className="who">
          <span className="who__mail">{ctx.email}</span>
          <span className="pill pill--ok" style={{ marginLeft: "auto" }}>verified work account</span>
        </div>

        <h1>
          {existing.displayName} is <span className="em">already</span> here
        </h1>
        <p className="sub" style={{ marginBottom: 22 }}>
          Someone from your organisation set this up already. Rather than
          creating a second account, we will ask an admin to add you.
        </p>

        <div className="note note--info">
          <strong>Matched on {matchLabel(existing.matchedOn)}</strong>
          Your access and role are decided by an existing admin, so you land
          with the right permissions from the first day.
        </div>

        <form action={joinExistingOrgAction}>
          <button className="btn btn--ink" type="submit">
            Request access to {existing.displayName}
          </button>
        </form>

        <div className="foot">
          Wrong organisation?{" "}
          <form action={signOutAction} className="foot__inline">
            <button type="submit">Sign out</button>
          </form>{" "}
          and use the company account for the entity you actually work for.
        </div>
      </main>
      </div>
    );
  }

  return (
    <div className="auth">
    <main className="auth__card auth__card--wide">
      <div className="brand" style={{ marginBottom: 22 }}>
        <span className="brand__glyph"><Mark /></span>
        <span className="brand__name">Sales Desk</span>
      </div>

      <div className="who">
        <span className="who__mail">{ctx.email}</span>
        <span className={`pill pill--${personal ? "blue" : "ok"}`} style={{ marginLeft: "auto" }}>
          {personal ? "Google account" : "verified work account"}
        </span>
      </div>

      <nav className="kindtabs" aria-label="Signing up as">
        {COMPANY_KINDS.map((k) =>
          partnerOnly && k !== "CHANNEL_PARTNER" ? (
            <span key={k} aria-disabled="true" title="Needs a company account">
              {COMPANY_KIND[k].label}
            </span>
          ) : (
            <Link key={k} href={tabHref(k)} aria-current={k === kind ? "page" : undefined}>
              {COMPANY_KIND[k].label}
            </Link>
          ),
        )}
      </nav>

      <h1>
        {kind === "DEVELOPER" ? (
          <>
            Create {additional ? "another" : "your"} <span className="em">organisation</span>
          </>
        ) : kind === "MANDATE_FIRM" ? (
          <>
            Set up your <span className="em">mandate firm</span>
          </>
        ) : (
          <>
            Set up your <span className="em">firm</span>
          </>
        )}
      </h1>
      <p className="sub" style={{ marginBottom: 22 }}>
        {kind === "DEVELOPER"
          ? additional
            ? "A separate legal entity with its own GSTIN, projects, team and channel partners. Nothing is shared with your existing organisations."
            : `You are the first person here from ${ctx.emailDomain}, so this creates the organisation and makes you its admin. Everyone else joins by invitation from you.`
          : kind === "MANDATE_FIRM"
            ? "Add the developers you sell for and their projects yourself; a developer on Sales Desk can also offer you a mandate by your PAN. You become your firm's admin."
            : codesSkipped()
              ? "Developers find you by your PAN."
              : "Developers find you by your PAN. We send a code to your firm's WhatsApp number to confirm it."}
      </p>

      {kind === "DEVELOPER" && <OrgForm another={additional} />}
      {kind === "MANDATE_FIRM" && <MandateFirmForm another={additional} />}
      {kind === "CHANNEL_PARTNER" && <PartnerForm another={additional} skipCode={codesSkipped()} />}

      <div
        className="foot"
        style={
          additional
            ? { marginTop: 18, paddingTop: 0, borderTop: 0 }
            : { marginTop: 18 }
        }
      >
        {additional ? (
          <Link href="/">Back</Link>
        ) : (
          <>
            Not the account you meant to use?{" "}
            <form action={signOutAction} className="foot__inline">
              <button type="submit">Sign out</button>
            </form>
          </>
        )}
      </div>
    </main>
    </div>
  );
}

function matchLabel(reason: string): string {
  switch (reason) {
    case "GSTIN":
      return "GSTIN";
    case "PAN":
      return "PAN";
    case "IDP_TENANT":
      return "your company directory";
    default:
      return "your email domain";
  }
}
