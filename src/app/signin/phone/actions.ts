"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { ACTIVE_ORG_COOKIE } from "@/lib/onboarding";
import { phoneHomeOrg, startPhoneSignIn } from "@/lib/phone-session";
import { SIGN_IN_REFUSED } from "@/lib/phone-session-rules";
import { readCode } from "@/lib/otp-rules";

/**
 * Signing in with a phone: ask for a code, then send it back. The first
 * answers the same for every number; the second signs in or says the code
 * was not right, and nothing in between.
 */

export type PhoneSignInState =
  | { step: "PHONE"; phone: string; error?: string }
  | { step: "CODE"; phone: string; challengeId: string; message: string; error?: string };

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

export async function phoneSignInAction(prev: PhoneSignInState, fd: FormData): Promise<PhoneSignInState> {
  const intent = String(fd.get("intent") ?? "");
  const phone = String(fd.get("phone") ?? "").trim();

  if (intent === "send" || prev.step === "PHONE") {
    const r = await startPhoneSignIn({ raw: phone, ip: await clientIp() });
    if (!r.ok) return { step: "PHONE", phone, error: r.message };
    return { step: "CODE", phone, challengeId: r.challengeId, message: r.message };
  }

  const challengeId = String(fd.get("challengeId") ?? "");
  const code = readCode(fd.get("code"));
  if (!code) return { ...prev, step: "CODE", phone, challengeId, message: prev.step === "CODE" ? prev.message : "", error: "The code is six digits." };

  try {
    await signIn("phone", { challengeId, phone, code, redirect: false });
  } catch (e) {
    if (e instanceof AuthError) {
      return { step: "CODE", phone, challengeId, message: prev.step === "CODE" ? prev.message : "", error: SIGN_IN_REFUSED };
    }
    throw e;
  }
  // Signed in: land in the firm the number belongs to, whatever else the
  // person may also be a member of.
  const org = await phoneHomeOrg(phone);
  if (org) (await cookies()).set(ACTIVE_ORG_COOKIE, org, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect("/");
}
