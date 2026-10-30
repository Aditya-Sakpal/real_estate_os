import { flash } from "@/lib/flash";
import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/console";
import { checkReturn, finishConnect, redirectUri } from "@/lib/connect";
import { audit } from "@/lib/db";
import { providerFromSlug, providerSlug } from "@/lib/connect-rules";

/**
 * Where Meta or Google sends a person back.
 *
 * Checked before the code is exchanged: the person is signed in and may
 * manage connections, the state is ours and unexpired, it was started in this
 * browser (the cookie), by this person, and for the organisation they are in
 * now. A person who switched organisation in another tab mid-consent would
 * otherwise attach one tenant's Meta account to the other.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.redirect(new URL("/signin", request.url));
  const { provider: slug } = await params;
  const provider = providerFromSlug(slug);
  if (!provider) return new Response("Not found", { status: 404 });

  const list = new URL("/dashboard/settings/connections", request.url);
  const done = (url: URL) => {
    const response = NextResponse.redirect(url);
    response.cookies.delete({ name: "est_connect", path: "/api/connect" });
    response.cookies.delete({ name: "est_connect_pkce", path: "/api/connect" });
    return response;
  };
  // Signed, so the connections page shows only messages this route wrote.
  const say = (url: URL, name: string, message: string) => {
    for (const [k, v] of new URLSearchParams(flash(name, message))) url.searchParams.set(k, v);
  };
  const refuse = (message: string) => {
    say(list, "error", message);
    return done(list);
  };
  if (!viewer.authz.can("integration:manage")) return refuse("You cannot connect accounts here.");

  const q = new URL(request.url).searchParams;
  const check = checkReturn({
    state: q.get("state"),
    nonce: request.cookies.get("est_connect")?.value ?? null,
    userId: viewer.userId,
    provider,
  });
  if (!check.ok) {
    await audit({
      orgId: viewer.state.org.id,
      actorUserId: viewer.userId,
      action: "connect.refused",
      targetType: "connection",
      targetId: null,
      metadata: { provider, why: check.code },
    });
    return refuse(check.message);
  }
  if (check.orgId !== viewer.state.org.id) {
    return refuse("You switched organisation while connecting. Connect again from here.");
  }
  // The person said no, or closed the window on the provider's side.
  if (q.get("error") || !q.get("code")) return refuse("Nothing was connected.");

  const result = await finishConnect({
    orgId: viewer.state.org.id,
    userId: viewer.userId,
    provider,
    code: q.get("code")!,
    redirectUri: redirectUri(provider, new URL(request.url).origin),
    verifier: request.cookies.get("est_connect_pkce")?.value ?? null,
  });
  if (!result.ok) return refuse(result.message);

  const next = new URL(`/dashboard/settings/connections/${providerSlug(provider)}`, request.url);
  next.searchParams.set("connected", "1");
  if (result.message) say(next, "note", result.message.slice(0, 400));
  return done(next);
}
