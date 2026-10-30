import { after } from "next/server";
import { withNoTenant } from "@/lib/db";
import { leadgenPings, metaSignatureValid } from "@/lib/capture-rules";
import { recordEvent } from "@/lib/leads";
import { processEvent } from "@/lib/lead-engine";
import { ingestWhatsApp } from "@/lib/messaging";
import { ingestWabaEvents } from "@/lib/wa-numbers";

/**
 * Meta's webhook for this app: lead-form submissions on a connected Page,
 * and WhatsApp delivery receipts and replies.
 *
 * Section 02's edge rule: prove it, write the raw event, answer 200, and do
 * everything else after the answer. Meta retries anything slow, and a retry
 * of a lead that is already being called is how a buyer gets two calls.
 * The event's unique key makes a retry land on the row already there.
 */

const secrets = () =>
  [process.env.META_APP_SECRET, process.env.WHATSAPP_APP_SECRET].map((s) => (s ?? "").trim()).filter(Boolean);

/** Meta's one-time check that this address is ours. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const want = (process.env.META_WEBHOOK_VERIFY_TOKEN ?? "").trim();
  if (
    want &&
    url.searchParams.get("hub.mode") === "subscribe" &&
    url.searchParams.get("hub.verify_token") === want
  ) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

export async function POST(request: Request) {
  const raw = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!secrets().some((s) => metaSignatureValid(raw, signature, s))) {
    return new Response("forbidden", { status: 403 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("ok", { status: 200 });
  }
  const object = (body as { object?: unknown })?.object;

  if (object === "whatsapp_business_account") {
    // Messages and receipts route by the developer's number; template,
    // quality and account events by their WABA. Both lookups return ids only.
    after(() => Promise.all([ingestWhatsApp(body), ingestWabaEvents(body)]).then(() => undefined));
    return new Response("ok", { status: 200 });
  }

  const queued: { orgId: string; eventId: string }[] = [];
  for (const ping of leadgenPings(body)) {
    // The webhook names a Page, not a tenant. One SECURITY DEFINER function
    // answers which tenants chose that Page, ids only.
    const owners = await withNoTenant((sql) =>
      sql<{ org_id: string; account_id: string }[]>`SELECT org_id, account_id FROM lead_page_owners(${ping.pageId})`,
    );
    for (const o of owners) {
      const ev = await recordEvent({
        orgId: o.org_id,
        source: "META_FORM",
        externalId: ping.leadgenId,
        payload: { ping, accountId: o.account_id },
      });
      if (ev.fresh) queued.push({ orgId: o.org_id, eventId: ev.id });
    }
  }
  if (queued.length) {
    after(async () => {
      for (const q of queued) await processEvent(q.orgId, q.eventId);
    });
  }
  return new Response("ok", { status: 200 });
}
