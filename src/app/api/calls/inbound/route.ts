import { answerInbound, inboundEvent, inboundIsGenuine, inboundResult, inboundRingXml } from "@/lib/inbound-calls";
import { HANGUP_XML } from "@/lib/handoff-rules";
import { formFields } from "@/lib/hook-params";

/**
 * Vobiz, on a buyer ringing one of a developer's own numbers.
 *
 *   ?n=<number>&t=<proof>     the number's answer address, pasted into Vobiz:
 *                              who rings, and who is rung for them
 *   ?o&i&t&ev=events           the rung phones: answered, or ended with what it billed
 *   ?o&i&t&ev=result           the ring's final word: the team next, or a missed call
 *   ?o&i&t&ev=ring             a caller the AI put through before it knew the project: ring the team
 *
 * Every address carries an HMAC in its own namespace, checked before
 * anything is read, because Vobiz signs nothing.
 */
export const dynamic = "force-dynamic";

const xml = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/xml" } });

export async function POST(request: Request) {
  const url = new URL(request.url);
  const ev = url.searchParams.get("ev");
  const token = url.searchParams.get("t");
  if (!ev) {
    return xml(await answerInbound({ number: url.searchParams.get("n"), token, params: await formFields(request) }));
  }
  const orgId = url.searchParams.get("o");
  const id = url.searchParams.get("i");
  if (!inboundIsGenuine(orgId, id, token)) return ev === "result" || ev === "ring" ? xml(HANGUP_XML) : new Response("ok", { status: 200 });
  if (ev === "result") return xml(await inboundResult(orgId!, id!, await formFields(request)));
  if (ev === "ring") return xml(await inboundRingXml(orgId!, id!));
  if (ev === "events") await inboundEvent(orgId!, id!, await formFields(request));
  return new Response("ok", { status: 200 });
}
