import { NextResponse, type NextRequest } from "next/server";
import { flash } from "@/lib/flash";
import { getViewer } from "@/lib/console";
import { beginPayConnect, paymentsReady } from "@/lib/payments";

/**
 * Send a person to Razorpay to connect their own account. `integration:manage`,
 * because the account is the one a buyer's token is paid into. The nonce in
 * the signed state is also a cookie on this browser, for ten minutes.
 */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.redirect(new URL("/signin", request.url));
  const back = new URL("/dashboard/settings/payments", request.url);
  if (!viewer.authz.can("integration:manage")) return NextResponse.redirect(back);
  if (!paymentsReady()) {
    for (const [k, v] of new URLSearchParams(flash("error", "Connecting Razorpay isn't set up yet."))) back.searchParams.set(k, v);
    return NextResponse.redirect(back);
  }
  const begun = beginPayConnect({
    orgId: viewer.state.org.id,
    userId: viewer.userId,
    redirectUri: `${process.env.CONNECT_BASE_URL ?? new URL(request.url).origin}/api/payments/razorpay/callback`,
  });
  const response = NextResponse.redirect(begun.url);
  response.cookies.set("est_pay", begun.nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/payments",
    maxAge: 600,
  });
  return response;
}
