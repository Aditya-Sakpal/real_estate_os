import { slotForCall } from "@/lib/call-slots";
import { formFields, provenCall } from "@/lib/hook-params";

/**
 * The agent's `check_visit_slot` tool: is there a free host at the time the
 * buyer just named? The org, the call and its token arrive with the time, as
 * they do for `connect_sales`. A refusal is a non-2xx, which makes the agent
 * carry on without the answer rather than go quiet.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const body = await formFields(request);
  const call = provenCall({
    o: body.o ?? url.searchParams.get("o"),
    c: body.c ?? url.searchParams.get("c"),
    t: body.t ?? url.searchParams.get("t"),
  });
  if (!call) return Response.json({ ok: false, message: "Not a call we placed." }, { status: 403 });
  const said = (body.time ?? url.searchParams.get("time") ?? "").trim();
  const reply = await slotForCall({ orgId: call.orgId, callId: call.callId, said });
  if (!reply) return Response.json({ ok: false, message: "That call is over." }, { status: 409 });
  return Response.json({ ok: true, ...reply });
}
