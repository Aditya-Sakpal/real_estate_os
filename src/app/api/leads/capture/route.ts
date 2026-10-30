import { after } from "next/server";
import { captureKeyOk } from "@/lib/capture";
import { isGooglePayload, isUuid, readGoogleLead, readWebLead, webFormProblem } from "@/lib/capture-rules";
import { recordEvent } from "@/lib/leads";
import { processEvent } from "@/lib/lead-engine";

/**
 * Where a developer's own website form, and a Google Ads lead form, post
 * their leads.
 *
 * The address carries the organisation and a key derived for it, so a form
 * cannot post into another tenant by changing one id. Google calls the same
 * key `google_key` and sends it in the body. Anything that does not prove
 * itself gets the same short answer as anything that does.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

export async function POST(request: Request) {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("o") ?? "";
  if (!isUuid(orgId)) return json({ ok: false }, 403);

  const type = request.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};
  try {
    if (type.includes("application/json")) {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) if (typeof v === "string") body[k] = v;
    }
  } catch {
    return json({ ok: false, message: "Could not read the form." }, 400);
  }

  // A form made for one tower names it in its address, so the developer's
  // web team does not have to add a hidden field.
  const phase = url.searchParams.get("phase");
  if (phase && !isUuid(phase)) return json({ ok: false, message: "The form names a tower that does not exist." }, 400);
  if (phase && !body.phase) body.phase = phase;

  const google = isGooglePayload(body);
  const key = google ? String(body.google_key ?? "") : url.searchParams.get("k") ?? String(body.k ?? "");
  if (!captureKeyOk(orgId, null, key)) return json({ ok: false }, 403);

  const now = new Date().toISOString();
  const problem = google ? null : webFormProblem(body);
  if (problem) return json({ ok: false, message: problem }, 422);
  const parsed = google ? readGoogleLead(body) : readWebLead(body, now);
  if (!parsed) return json({ ok: false, message: "A mobile number is needed." }, 422);

  const ev = await recordEvent({ orgId, source: parsed.channel, externalId: parsed.externalId, payload: body });
  if (ev.fresh) after(() => processEvent(orgId, ev.id).then(() => undefined));

  // A plain HTML form that named a thank-you page goes back to it.
  const back = typeof body.redirect === "string" ? body.redirect : null;
  if (!google && back && /^https:\/\//.test(back) && !type.includes("application/json")) {
    return Response.redirect(back, 303);
  }
  return json({ ok: true });
}
