import { after } from "next/server";
import { fileReader } from "@/lib/guard";
import { deskFeed } from "@/lib/call-desk";
import { lensFor } from "@/lib/mask";
import { settleCallsSoon } from "@/lib/lead-engine";

/**
 * The call desk's poll: every buyer being put through, at towers this person
 * reads leads on, with what is known about each. Never cached: it is buyers'
 * words, and a second old is a ring missed.
 */
export async function GET() {
  const reader = await fileReader();
  if (!reader || !reader.authz.can("lead:read")) return Response.json({ rings: [], onTeam: false }, { status: 403 });
  const feed = await deskFeed({ ...reader, lens: () => lensFor(reader.orgId, reader.authz) });
  // A transferred call's notes arrive by Sarvam's webhook; one still missing is asked of Sarvam.
  if (feed.rings.some((r) => r.kind === "TRANSFER" && !r.buyer.thisCall?.summary)) {
    const orgId = reader.orgId;
    after(() => settleCallsSoon(orgId));
  }
  return Response.json(feed, { headers: { "cache-control": "private, no-store" } });
}
