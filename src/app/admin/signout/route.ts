import { NextResponse, type NextRequest } from "next/server";
import { adminBase, onAdminHost, SESSION_COOKIE } from "@/lib/operator";

export async function POST(req: NextRequest) {
  if (!(await onAdminHost())) return new NextResponse(null, { status: 404 });
  const res = NextResponse.redirect(new URL("/signin", adminBase() ?? new URL(req.url).origin), 303);
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
