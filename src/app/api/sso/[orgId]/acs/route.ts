import { NextResponse, type NextRequest } from "next/server";
import { finishSamlLogin } from "@/lib/sso";

/**
 * The identity provider's answer, posted by the browser. Checked in full by
 * `finishSamlLogin()`; a good one becomes a one-use ticket that the sign-in
 * page spends to open the session.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const form = await request.formData().catch(() => null);
  const SAMLResponse = String(form?.get("SAMLResponse") ?? "");
  const RelayState = String(form?.get("RelayState") ?? "");
  if (!SAMLResponse || SAMLResponse.length > 500_000) return NextResponse.redirect(new URL("/signin?error=SSO_INVALID", request.url), 303);
  const out = await finishSamlLogin(orgId, { SAMLResponse, RelayState });
  if (!out.ok) return NextResponse.redirect(new URL(`/signin?error=SSO_${out.code}`, request.url), 303);
  const next = new URL("/signin/sso", request.url);
  next.searchParams.set("t", out.ticket);
  if (out.test) next.searchParams.set("test", "1");
  return NextResponse.redirect(next, 303);
}
