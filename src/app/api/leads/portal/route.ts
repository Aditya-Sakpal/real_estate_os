import { after } from "next/server";
import { isUuid } from "@/lib/capture-rules";
import { portalKeyOk, portalMailDomain, takeEmail } from "@/lib/portal-leads";
import { readJsonEmail, readMailbox, readSns, snsConfirmUrlOk, type PortalEmail } from "@/lib/portal-rules";
import { processEvent } from "@/lib/lead-engine";
import { snsSignatureOk } from "@/lib/sns-verify";

/**
 * Where the property portals' lead emails arrive.
 *
 * Two doors. Amazon SES receives the email at the organisation's own
 * address (`leads-<org>-<key>@<PORTAL_MAIL_DOMAIN>`) and posts it here
 * through SNS, whose signature and topic are checked first; the key in the
 * address is the proof of the organisation, read off the recipients. Or a forwarding service posts `{ from, subject, text, html }`
 * (JSON or a form) to `?o=<org>&k=<key>`. Either way the email is stored as
 * one event, keyed so the same email twice is one lead, answered, and only
 * then worked.
 */

const MAX_BYTES = 2 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function work(orgId: string, email: PortalEmail, via: "EMAIL" | "POST") {
  const taken = await takeEmail(orgId, email, new Date().toISOString(), via);
  if (taken.ok && taken.fresh) after(() => processEvent(orgId, taken.eventId).then(() => undefined));
  return taken;
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return json({ ok: false, message: "Too large." }, 413);
  const url = new URL(request.url);
  const type = request.headers.get("content-type") ?? "";
  const sns = request.headers.get("x-amz-sns-message-type");

  // SES through SNS: the body is JSON sent as text/plain.
  if (sns) {
    let body: unknown;
    try {
      body = JSON.parse((await request.text()).slice(0, MAX_BYTES));
    } catch {
      return json({ ok: false }, 400);
    }
    // Only our topic, and only a message SNS itself signed. Anything else is
    // answered and dropped: SNS retries what is not a 2xx.
    const topic = process.env.PORTAL_SNS_TOPIC_ARN;
    const msg = (body ?? {}) as Record<string, unknown>;
    if (!topic || msg.TopicArn !== topic || !(await snsSignatureOk(msg))) return json({ ok: true });
    const inbound = readSns(body);
    if (inbound.kind === "subscribe") {
      if (snsConfirmUrlOk(inbound.subscribeUrl)) {
        await fetch(inbound.subscribeUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      }
      return json({ ok: true });
    }
    if (inbound.kind !== "email") return json({ ok: true });
    const domain = portalMailDomain();
    const done = new Set<string>();
    for (const to of inbound.to) {
      const box = readMailbox(to, domain);
      if (!box || done.has(box.orgId) || !isUuid(box.orgId)) continue;
      if (!(await portalKeyOk(box.orgId, box.key, true))) continue;
      done.add(box.orgId);
      await work(box.orgId, inbound.email, "EMAIL");
    }
    // SNS retries anything but a 2xx, and a retry changes nothing here.
    return json({ ok: true });
  }

  const orgId = url.searchParams.get("o") ?? "";
  if (!isUuid(orgId)) return json({ ok: false }, 403);
  if (!(await portalKeyOk(orgId, url.searchParams.get("k") ?? ""))) return json({ ok: false }, 403);
  let body: Record<string, unknown> = {};
  try {
    if (type.includes("application/json")) {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) if (typeof v === "string") body[k] = v;
    }
  } catch {
    return json({ ok: false, message: "Could not read the email." }, 400);
  }
  const email = readJsonEmail(body);
  if (!email) return json({ ok: false, message: "The email had no text." }, 422);
  const taken = await work(orgId, email, "POST");
  return taken.ok ? json({ ok: true }) : json({ ok: false, message: taken.reason }, 422);
}
