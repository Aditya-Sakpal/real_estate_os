import { flash } from "@/lib/flash";
import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/console";
import { beginConnect, providerReady, redirectUri } from "@/lib/connect";
import { providerFromSlug } from "@/lib/connect-rules";

/**
 * Send a person to Meta or Google to consent.
 *
 * `integration:manage`, because a connection holds a token that spends the
 * developer's money and speaks for their brand. The nonce inside the signed
 * state is also set as a cookie on this browser, and Google's PKCE verifier
 * beside it, so the callback can prove it is finishing the flow this browser
 * started. Both cookies are scoped to `/api/connect` and last ten minutes.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.redirect(new URL("/signin", request.url));
  const back = new URL("/dashboard/settings/connections", request.url);
  if (!viewer.authz.can("integration:manage")) return NextResponse.redirect(back);

  const { provider: slug } = await params;
  const provider = providerFromSlug(slug);
  if (!provider) return new Response("Not found", { status: 404 });
  if (!providerReady(provider)) {
    for (const [k, v] of new URLSearchParams(flash("error", "Connecting isn't set up yet."))) back.searchParams.set(k, v);
    return NextResponse.redirect(back);
  }

  const begun = beginConnect({
    orgId: viewer.state.org.id,
    userId: viewer.userId,
    provider,
    redirectUri: redirectUri(provider, new URL(request.url).origin),
  });
  const response = NextResponse.redirect(begun.url);
  const cookie = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/connect",
    maxAge: 600,
  };
  response.cookies.set("est_connect", begun.nonce, cookie);
  if (begun.verifier) response.cookies.set("est_connect_pkce", begun.verifier, cookie);
  else response.cookies.delete({ name: "est_connect_pkce", path: "/api/connect" });
  return response;
}
