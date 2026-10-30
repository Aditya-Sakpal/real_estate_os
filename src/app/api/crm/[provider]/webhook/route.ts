import { after } from "next/server";
import { isUuid } from "@/lib/capture-rules";
import { crmFromSlug, readLeadratHook, readLeadsquaredHook } from "@/lib/crm-rules";
import { hookTokenOk, recordHook, workInbound } from "@/lib/crm-sync";

/**
 * Where a connected CRM tells us a lead changed.
 *
 * Neither LeadRat nor LeadSquared documents a signature, so the address
 * proves itself: it carries the org, the connection and an HMAC of both,
 * checked before anything is read. Then the raw delivery is stored, unique
 * on its event, the answer goes back, and the work happens after it.
 * LeadSquared switches a webhook off after ten failures in a row, so a body
 * we cannot read is answered 200 and dropped rather than refused.
 */

type Ctx = { params: Promise<{ provider: string }> };

function proven(request: Request): { orgId: string; connectionId: string } | null {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("o") ?? "";
  const connectionId = url.searchParams.get("c") ?? "";
  const token = url.searchParams.get("t") ?? "";
  if (!isUuid(orgId) || !isUuid(connectionId)) return null;
  return hookTokenOk(orgId, connectionId, token) ? { orgId, connectionId } : null;
}

/** LeadSquared checks a new address with a HEAD, and with an empty POST. */
export async function HEAD(request: Request) {
  return new Response(null, { status: proven(request) ? 200 : 403 });
}

export async function POST(request: Request, ctx: Ctx) {
  const provider = crmFromSlug((await ctx.params).provider);
  const who = proven(request);
  if (!provider || !who) return new Response("forbidden", { status: 403 });

  const raw = await request.text();
  if (!raw.trim()) return Response.json({ Status: "Success" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ Status: "Success" });
  }

  const hook =
    provider === "LEADRAT"
      ? readLeadratHook(body)
      : provider === "LEADSQUARED"
        ? readLeadsquaredHook(body, new URL(request.url).searchParams.get("event"))
        : null;
  if (!hook) return Response.json({ Status: "Success" });

  const stored = await recordHook({
    orgId: who.orgId,
    connectionId: who.connectionId,
    externalId: hook.eventId,
    kind: hook.eventType,
    payload: { leadId: hook.leadId, body },
  });
  if (stored.fresh) after(() => workInbound(who.orgId).then(() => undefined));
  return Response.json({ Status: "Success" });
}
