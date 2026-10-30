import { after } from "next/server";
import { ingestWebhook, webhookIsGenuine } from "@/lib/calling";
import { inboundStartValid, startedCall } from "@/lib/inbound-call-rules";
import { webhookSecret } from "@/lib/calling";
import { onCallEnded } from "@/lib/lead-engine";
import { settleWaitingReceptionist } from "@/lib/waiting-callers";

/**
 * The receptionist deployment's call-end webhook. One address for every
 * number, so the call it is about is read from the agent's own variables
 * (`salesdesk_org`, `salesdesk_call`, `salesdesk_key`, handed over at the
 * start) and proved by that call's own HMAC, as an outbound result is. The
 * address carries the start token as well, so nothing else posts here.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (!inboundStartValid(webhookSecret(), url.searchParams.get("t"))) return new Response("ok", { status: 200 });
  const body = await request.json().catch(() => null);
  const call = startedCall(body);
  // An inbound call connected by definition, and Sarvam's inbound payload says so by saying nothing.
  if (body && typeof body === "object" && !("connectivity_status" in body) && !("status" in body)) {
    (body as Record<string, unknown>).status = "connected";
  }
  if (!call || !webhookIsGenuine(call.orgId, call.callId, call.token)) return new Response("ok", { status: 200 });
  // A caller the receptionist could not file at the start is filed now when
  // they named one project; otherwise they wait for a person.
  await settleWaitingReceptionist(call.orgId, call.callId, body).catch((e) => console.error("receptionist: a waiting caller could not be settled", e));
  if (await ingestWebhook(call.orgId, call.callId, body)) {
    after(() => onCallEnded(call.orgId, call.callId));
  }
  return new Response("ok", { status: 200 });
}
