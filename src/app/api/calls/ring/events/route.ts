import { ringEvent } from "@/lib/handoff";
import { formFields, provenCall } from "@/lib/hook-params";

/** Vobiz's real-time reports on the ringing phones: who answered, and when they hung up. */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const call = provenCall({ o: url.searchParams.get("o"), c: url.searchParams.get("c"), t: url.searchParams.get("t") });
  if (call) await ringEvent(call.orgId, call.callId, await formFields(request));
  return new Response("ok", { status: 200 });
}
