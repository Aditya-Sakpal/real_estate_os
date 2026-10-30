import { fileReader } from "@/lib/guard";
import { callTranscript } from "@/lib/calling";
import { lensFor } from "@/lib/mask";

/**
 * One call's transcript, asked for when the call is opened in the call log.
 * Only towers this person reads leads on, and every number in it masked as
 * the list would have masked it. Never cached: it is a buyer's words.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const reader = await fileReader();
  if (!reader || !reader.authz.can("lead:read")) return Response.json({ turns: null }, { status: 404 });
  const turns = await callTranscript(
    reader.orgId,
    { lens: await lensFor(reader.orgId, reader.authz), scopes: reader.authz.scopesFor("lead:read") },
    id,
  ).catch(() => null);
  if (!turns) return Response.json({ turns: null }, { status: 404 });
  return Response.json({ turns }, { headers: { "cache-control": "private, no-store" } });
}
