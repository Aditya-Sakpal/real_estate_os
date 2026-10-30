import { bridgeAccept, bridgeAnswer, proxyAnswerXml, proxyEvent, proxyHangup, proxyIsGenuine } from "@/lib/proxy";
import { HANGUP_XML } from "@/lib/handoff-rules";
import { formFields } from "@/lib/hook-params";

/**
 * Vobiz, on a call a person makes through our number. The address carries
 * an HMAC of the org and the call, checked before anything is read, because
 * Vobiz signs nothing.
 *
 *   ev=answer   the person picked up: answer with instructions to ring the buyer
 *   ev=events   the buyer's leg: answered, or ended with what it billed
 *   ev=hangup   the person's own leg ended
 *   ev=bridge   a sales person picked up for a hot buyer: the summary and a key
 *   ev=accept   the key they pressed: 1 dials the buyer
 */
const xml = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/xml" } });

export async function POST(request: Request) {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("o");
  const id = url.searchParams.get("p");
  const ev = url.searchParams.get("ev");
  if (!proxyIsGenuine(orgId, id, url.searchParams.get("t"))) {
    return ev === "answer" || ev === "bridge" || ev === "accept" ? xml(HANGUP_XML) : new Response("ok", { status: 200 });
  }
  if (ev === "bridge") return xml(await bridgeAnswer(orgId!, id!));
  if (ev === "accept") return xml(await bridgeAccept(orgId!, id!, await formFields(request)));
  if (ev === "answer") return xml(await proxyAnswerXml(orgId!, id!));
  if (ev === "events") await proxyEvent(orgId!, id!, await formFields(request));
  if (ev === "hangup") await proxyHangup(orgId!, id!);
  return new Response("ok", { status: 200 });
}
