import { NextResponse, type NextRequest } from "next/server";
import { startSamlLogin } from "@/lib/sso";

/**
 * Start a sign-in at the company's own identity provider. Public: anybody
 * may be sent to their company's sign-in page, which is where the proving
 * happens. `?test=1` comes back to the settings screen instead of home.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const url = await startSamlLogin(orgId, { test: request.nextUrl.searchParams.get("test") === "1" }).catch(() => null);
  return NextResponse.redirect(url ?? new URL("/signin?error=SSO_NOT_SET_UP", request.url), 303);
}
