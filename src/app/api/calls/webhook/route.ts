import { after } from "next/server";
import { ingestWebhook, webhookIsGenuine } from "@/lib/calling";
import { onCallEnded } from "@/lib/lead-engine";

/**
 * Sarvam posts here when a call ends, connected or not.
 *
 * Sarvam signs nothing, so the address carries the proof: the org, the call
 * and an HMAC of both. Anything that does not verify gets the same short
 * answer as anything that does, so the route cannot be used to learn which
 * calls exist.
 *
 * The result is stored before the answer; what it decides (the lead's move,
 * the visit, the WhatsApp after the call, the retry) runs after it.
 */
// What the call's end starts (the reading of the call among it) runs after
// the answer, and a reading takes seconds: the default limit cut it off.
export const maxDuration = 60;

export async function POST(request: Request) {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("o") ?? "";
  const callId = url.searchParams.get("c") ?? "";
  const token = url.searchParams.get("t") ?? "";
  const ids = /^[0-9a-f-]{36}$/i;
  if (!ids.test(orgId) || !ids.test(callId) || !webhookIsGenuine(orgId, callId, token)) {
    return new Response("ok", { status: 200 });
  }
  const body = await request.json().catch(() => null);
  if (body && (await ingestWebhook(orgId, callId, body))) {
    after(() => onCallEnded(orgId, callId));
  }
  return new Response("ok", { status: 200 });
}
