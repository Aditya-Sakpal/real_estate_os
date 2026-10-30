import { after } from "next/server";
import { isUuid } from "@/lib/capture-rules";
import { portalKeyOk, takePush } from "@/lib/portal-leads";
import { isPortalKey, type PortalKey } from "@/lib/portal-rules";
import { processEvent } from "@/lib/lead-engine";

/**
 * Where a property portal posts its leads straight to us: the link a
 * developer's account manager at 99acres, MagicBricks or Housing.com sets on
 * the account (`?o=<org>&k=<key>&p=<portal>`). The key is the organisation's
 * portal key, the one the forwarding address carries, so making a new
 * address on Settings stops these too.
 *
 * Portals send what they send: JSON (one lead, a list, or a list inside a
 * wrapper), a form, or the lead in the link's own query string. Each record
 * is read by its labels (`portal-rules.ts` readPortalPush), stored once as an
 * event, answered, and then worked.
 */

const MAX_BYTES = 512 * 1024;
const RUN_NOW = 10;
const OURS = new Set(["o", "k", "p"]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function proved(url: URL): Promise<{ orgId: string; portal: PortalKey } | null> {
  const orgId = url.searchParams.get("o") ?? "";
  const portal = (url.searchParams.get("p") ?? "other").toUpperCase();
  if (!isUuid(orgId) || !isPortalKey(portal)) return null;
  if (!(await portalKeyOk(orgId, url.searchParams.get("k") ?? ""))) return null;
  return { orgId, portal };
}

/** The lead carried in the link itself, as some portals send it. */
function fromQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!OURS.has(k)) out[k] = v;
  return out;
}

async function take(orgId: string, portal: PortalKey, body: unknown) {
  const r = await takePush(orgId, portal, body, new Date().toISOString());
  if (r.eventIds.length) {
    after(async () => {
      for (const id of r.eventIds.slice(0, RUN_NOW)) await processEvent(orgId, id).catch(() => null);
    });
  }
  // A portal retries anything but a 2xx, and a retry of a lead we could not
  // read reads it no better, so a refusal is still answered 200 with why.
  return json({ ok: r.added + r.again > 0, added: r.added, already: r.again, refused: r.refused });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const who = await proved(url);
  if (!who) return json({ ok: false }, 403);
  const q = fromQuery(url);
  // A portal checking the link before saving it sends nothing; that is a yes.
  if (!Object.keys(q).length) return json({ ok: true });
  return take(who.orgId, who.portal, q);
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return json({ ok: false, message: "Too large." }, 413);
  const url = new URL(request.url);
  const who = await proved(url);
  if (!who) return json({ ok: false }, 403);
  const type = request.headers.get("content-type") ?? "";
  let body: unknown = null;
  try {
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      body = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
    } else {
      const text = (await request.text()).slice(0, MAX_BYTES);
      if (type.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(text));
      else if (text.trim()) body = JSON.parse(text);
    }
  } catch {
    return json({ ok: false, message: "Could not read the lead." }, 400);
  }
  const q = fromQuery(url);
  if ((body === null || (typeof body === "object" && !Object.keys(body as object).length)) && Object.keys(q).length) body = q;
  if (body === null || typeof body !== "object") return json({ ok: false, message: "No lead in the request." }, 422);
  return take(who.orgId, who.portal, body);
}
