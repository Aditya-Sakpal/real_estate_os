import { webhookIsGenuine } from "./calling.ts";

/**
 * The org and call an address names, when its token proves them. Every
 * calling callback (Sarvam's result, the agent's hand-off request, Vobiz's
 * ring instructions and reports) carries the same three values.
 */
export function provenCall(values: { o?: string | null; c?: string | null; t?: string | null }): { orgId: string; callId: string } | null {
  const ids = /^[0-9a-f-]{36}$/i;
  const orgId = values.o ?? "";
  const callId = values.c ?? "";
  const token = values.t ?? "";
  if (!ids.test(orgId) || !ids.test(callId) || !webhookIsGenuine(orgId, callId, token)) return null;
  return { orgId, callId };
}

/** A Vobiz callback's fields, sent form-encoded, read as plain strings. */
export async function formFields(request: Request): Promise<Record<string, string>> {
  const text = await request.text().catch(() => "");
  if (text.trim().startsWith("{")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, v == null ? "" : String(v)]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" } });
