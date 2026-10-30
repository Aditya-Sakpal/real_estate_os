import { NextResponse, type NextRequest } from "next/server";
import { adminBase, onAdminHost, SESSION_COOKIE, sessionToken, verify } from "@/lib/operator";

/** The emailed link: a valid one starts a 12-hour session. */
export async function GET(req: NextRequest) {
  if (!(await onAdminHost())) return new NextResponse(null, { status: 404 });
  const base = adminBase() ?? new URL(req.url).origin;
  const email = verify(req.nextUrl.searchParams.get("t"), "link");
  if (!email) return NextResponse.redirect(new URL("/signin?e=link", base), 303);
  const { token, maxAge } = sessionToken(email);
  const res = NextResponse.redirect(new URL("/", base), 303);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: base.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  res.headers.set("cache-control", "no-store");
  return res;
}
