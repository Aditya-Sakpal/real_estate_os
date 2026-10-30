import { after } from "next/server";
import { prepareHandoff } from "@/lib/handoff";
import { prepareWaitingHandoff } from "@/lib/inbound-calls";
import { HANDOFF_SPEAK_MS } from "@/lib/handoff-rules";
import { formFields, provenCall } from "@/lib/hook-params";

/**
 * The agent's `connect_sales` tool: put this buyer through to the sales team.
 *
 * The org, the call and its token arrive in the body (the tool sends the
 * call's own variables) or the query. A refusal is a non-2xx, which is what
 * makes the agent say its failure line and offer a call-back instead; nobody
 * free on the team is a refusal, so the buyer stays with the agent. A yes is
 * answered at once and the line moves `HANDOFF_SPEAK_MS` later, after the
 * agent has finished saying it is connecting them.
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
  // A caller the receptionist has not filed under a project has no lead yet,
  // and is put through on the inbound rail instead.
  const ready = (await prepareWaitingHandoff(call.orgId, call.callId)) ?? (await prepareHandoff(call.orgId, call.callId));
  // Nobody to take it is an answer, not an error: the agent reads what to say.
  if (!ready.ok && "noOne" in ready && ready.noOne) return Response.json({ ok: false, connected: false, message: ready.message, say: ready.message });
  if (!ready.ok) return Response.json({ ok: false, message: ready.message }, { status: 409 });
  after(async () => {
    await new Promise((r) => setTimeout(r, HANDOFF_SPEAK_MS));
    await ready.transfer();
  });
  return Response.json({ ok: true, message: "Connecting now." });
}
