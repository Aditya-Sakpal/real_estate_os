import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/guard";
import { finishDigilocker } from "@/lib/calling-kyc";
import { flash } from "@/lib/flash";

/** Back from DigiLocker: finish the Aadhaar check, then the screen says how it went. */
export async function GET(req: NextRequest) {
  const { userId, orgId } = await requirePermission("integration:manage");
  const state = (req.nextUrl.searchParams.get("state") ?? "").slice(0, 64);
  const r = await finishDigilocker({ orgId, userId, state });
  const to = new URL("/dashboard/settings/calling-numbers", req.nextUrl);
  to.search = `kyc=back&${flash(r.ok ? "done" : "error", r.message)}`;
  return NextResponse.redirect(to);
}
