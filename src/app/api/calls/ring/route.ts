import { HANGUP_XML } from "@/lib/handoff-rules";
import { ringXml } from "@/lib/handoff";
import { provenCall, xml } from "@/lib/hook-params";

/**
 * Vobiz asks here for the buyer's call once it has been redirected: ring the
 * free people on the sales team, all at once.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const call = provenCall({ o: url.searchParams.get("o"), c: url.searchParams.get("c"), t: url.searchParams.get("t") });
  if (!call) return xml(HANGUP_XML);
  return xml(await ringXml(call.orgId, call.callId));
}
