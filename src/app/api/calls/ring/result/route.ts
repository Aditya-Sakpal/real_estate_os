import { after } from "next/server";
import { HANGUP_XML } from "@/lib/handoff-rules";
import { callBackNow, ringResult } from "@/lib/handoff";
import { formFields, provenCall, xml } from "@/lib/hook-params";

/** Vobiz's final word on the ring. A buyer nobody took is rung straight back by the agent. */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const call = provenCall({ o: url.searchParams.get("o"), c: url.searchParams.get("c"), t: url.searchParams.get("t") });
  if (!call) return xml(HANGUP_XML);
  const answer = await ringResult(call.orgId, call.callId, await formFields(request));
  after(() => callBackNow(call.orgId).catch(() => {}));
  return xml(answer);
}
