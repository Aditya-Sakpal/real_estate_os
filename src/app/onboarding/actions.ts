"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  ACTIVE_ORG_COOKIE,
  createDeveloperOrg,
  findExistingOrg,
  getSignupContext,
  requestToJoin,
  SIGNUP_AS_COOKIE,
  type OrgMatch,
} from "@/lib/onboarding";
import {
  createMandateFirm,
  finishPartnerSignup,
  readFirmValues,
  startPartnerSignup,
  type ExistingOrg,
  type FirmValues,
} from "@/lib/firm-signup";

export type OnboardingState = {
  error?: string;
  /** Set when the submitted GSTIN resolved to a company already on Sales Desk. */
  existing?: OrgMatch;
  values?: { legalName: string; displayName: string; gstin: string; pan: string };
};

export async function createOrgAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  // A phone session never creates or joins a company.
  if (session.method === "phone") redirect("/dashboard");

  const legalName = String(formData.get("legalName") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim() || legalName;
  const gstin = String(formData.get("gstin") ?? "").trim();
  const pan = String(formData.get("pan") ?? "").trim();
  const another = String(formData.get("another") ?? "") === "1";
  const values = { legalName, displayName, gstin, pan };

  if (!legalName) return { error: "Registered legal name is required.", values };
  if (!pan) return { error: "PAN is required.", values };

  const ctx = await getSignupContext(session.user.id);
  if (!ctx) return { error: "Could not resolve your identity. Sign in again.", values };

  const result = await createDeveloperOrg({
    userId: session.user.id,
    legalName,
    displayName,
    gstin: gstin || null,
    pan,
    emailDomain: ctx.emailDomain,
    idpTenant: ctx.idpTenant ?? ctx.emailDomain,
    allowAdditional: another,
  });

  if (!result.ok) {
    return { error: result.error, existing: result.existing, values };
  }

  // Land in the org just created, not whichever one was active before.
  const jar = await cookies();
  jar.set(ACTIVE_ORG_COOKIE, result.orgId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  redirect("/dashboard");
}

/**
 * Raise a join request against the org this person's identity resolves to.
 *
 * Deliberately takes no org id from the form. The only org a user may ask to
 * join is the one their own verified GSTIN / IdP tenant / email domain already
 * matches -- otherwise anyone could spray join requests at every tenant on the
 * platform and harvest company names from the responses.
 */
export async function joinExistingOrgAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  // A phone session never creates or joins a company.
  if (session.method === "phone") redirect("/dashboard");

  const ctx = await getSignupContext(session.user.id);
  if (!ctx) redirect("/signin");

  const gstin = String(formData.get("gstin") ?? "").trim();
  const pan = String(formData.get("pan") ?? "").trim();

  const match = await findExistingOrg({
    gstin: gstin || null,
    pan: pan || null,
    idpTenant: ctx.idpTenant,
    emailDomain: ctx.emailDomain,
  });

  if (!match) redirect("/onboarding");

  await requestToJoin(session.user.id, match);
  redirect("/join-request");
}

// ---------------------------------------------------------------------------
// A mandate firm, and a channel partner with a code to its phone
// ---------------------------------------------------------------------------

export type FirmState = {
  error?: string;
  errors?: Record<string, string>;
  existing?: ExistingOrg;
  /** Set once a code went to the firm's phone: the form asks for it next. */
  challengeId?: string;
  claiming?: boolean;
  values?: Record<string, string>;
};

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const FIELDS = ["legalName", "displayName", "gstin", "pan", "reraNo", "reraTill", "city", "phone"] as const;
const rawOf = (fd: FormData) => Object.fromEntries(FIELDS.map((k) => [k, String(fd.get(k) ?? "").trim()])) as Record<string, string>;

async function landIn(orgId: string, to: "/dashboard" | "/workspace"): Promise<never> {
  const jar = await cookies();
  jar.set(ACTIVE_ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  jar.delete(SIGNUP_AS_COOKIE);
  redirect(to);
}

export async function createMandateFirmAction(_prev: FirmState, fd: FormData): Promise<FirmState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  // A phone session never creates or joins a company.
  if (session.method === "phone") redirect("/dashboard");
  const raw = rawOf(fd);
  const read = readFirmValues("MANDATE_FIRM", raw, todayIst());
  if (!read.ok) return { error: "Check the highlighted fields.", errors: read.errors, values: raw };
  const ctx = await getSignupContext(session.user.id);
  if (!ctx) return { error: "Could not resolve your identity. Sign in again.", values: raw };
  const made = await createMandateFirm({
    userId: session.user.id,
    values: read.values,
    emailDomain: ctx.emailDomain,
    idpTenant: ctx.idpTenant,
    allowAdditional: String(fd.get("another") ?? "") === "1",
  });
  if (!made.ok) return { error: made.error, errors: made.errors, existing: made.existing, values: raw };
  return landIn(made.orgId, "/dashboard");
}

const ipOf = async () => (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

export async function partnerStartAction(_prev: FirmState, fd: FormData): Promise<FirmState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  // A phone session never creates or joins a company.
  if (session.method === "phone") redirect("/dashboard");
  const raw = rawOf(fd);
  const read = readFirmValues("CHANNEL_PARTNER", raw, todayIst());
  if (!read.ok) return { error: "Check the highlighted fields.", errors: read.errors, values: raw };
  const ctx = await getSignupContext(session.user.id);
  if (!ctx) return { error: "Could not resolve your identity. Sign in again.", values: raw };
  const started = await startPartnerSignup({
    userId: session.user.id,
    values: read.values,
    emailDomain: ctx.emailDomain,
    idpTenant: ctx.idpTenant,
    allowAdditional: String(fd.get("another") ?? "") === "1",
    ip: await ipOf(),
  });
  if (!started.ok) return { error: started.error, errors: started.errors, existing: started.existing, values: raw };
  if (started.skipped) {
    // A development machine that skips the code: the firm is made now.
    const done = await finishPartnerSignup({
      userId: session.user.id,
      values: read.values as FirmValues,
      emailDomain: ctx.emailDomain,
      idpTenant: ctx.idpTenant,
      allowAdditional: String(fd.get("another") ?? "") === "1",
      challengeId: "",
      code: "",
    });
    if (!done.ok) return { error: done.error, errors: done.errors, existing: done.existing, values: raw };
    return landIn(done.orgId, "/dashboard");
  }
  return { challengeId: started.challengeId, claiming: started.claiming, values: raw };
}

export async function partnerFinishAction(_prev: FirmState, fd: FormData): Promise<FirmState> {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");
  // A phone session never creates or joins a company.
  if (session.method === "phone") redirect("/dashboard");
  const raw = rawOf(fd);
  const challengeId = String(fd.get("challengeId") ?? "");
  const code = String(fd.get("code") ?? "").replace(/\s/g, "");
  const read = readFirmValues("CHANNEL_PARTNER", raw, todayIst());
  if (!read.ok) return { error: "Check the highlighted fields.", errors: read.errors, values: raw };
  if (!/^\d{6}$/.test(code)) return { challengeId, values: raw, errors: { code: "Enter the 6-digit code." } };
  const ctx = await getSignupContext(session.user.id);
  if (!ctx) return { error: "Could not resolve your identity. Sign in again.", values: raw };
  const done = await finishPartnerSignup({
    userId: session.user.id,
    values: read.values as FirmValues,
    emailDomain: ctx.emailDomain,
    idpTenant: ctx.idpTenant,
    allowAdditional: String(fd.get("another") ?? "") === "1",
    challengeId,
    code,
  });
  if (!done.ok) {
    // A wrong code keeps the step; anything else goes back to the details.
    return done.errors?.code
      ? { challengeId, values: raw, errors: { code: done.errors.code } }
      : { error: done.error, errors: done.errors, existing: done.existing, values: raw };
  }
  return landIn(done.orgId, "/dashboard");
}

/** One form, two steps: the details and a code to the phone, then the code. */
export async function partnerAction(prev: FirmState, fd: FormData): Promise<FirmState> {
  return String(fd.get("step") ?? "") === "code" ? partnerFinishAction(prev, fd) : partnerStartAction(prev, fd);
}
