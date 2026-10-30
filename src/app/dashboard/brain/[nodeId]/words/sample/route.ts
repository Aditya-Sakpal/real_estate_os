import { getViewer } from "@/lib/console";
import { brainNode } from "@/lib/brain";
import { inReach } from "@/lib/grant-rules";
import { sampleOf } from "@/lib/pronounce";
import { SAYING_CAPS } from "@/lib/pronounce-rules";

// A word with no sample yet is said and heard back first: two calls to Sarvam.
export const maxDuration = 60;

/**
 * The calling agent saying one word, in its call voice. Signed in,
 * `brain:read` within reach of the node, and a 404 otherwise. A word not sampled yet is
 * checked first, which only `brain:edit` may ask for; the refusal comes back
 * as text the row shows.
 */
export async function GET(request: Request, { params }: { params: Promise<{ nodeId: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  const { nodeId } = await params;
  const orgId = viewer.state.org.id;
  const node = await brainNode(orgId, nodeId);
  if (!node || (node.kind !== "PROJECT" && node.kind !== "PHASE") || !inReach(node.path, viewer.authz.scopesFor("brain:read"))) {
    return new Response("Not found", { status: 404 });
  }
  const written = new URL(request.url).searchParams.get("w")?.trim() ?? "";
  if (!written || written.length > SAYING_CAPS.writtenMax) return new Response("Not found", { status: 404 });
  const sample = await sampleOf({ orgId, userId: viewer.userId, nodeId: node.id, written, mayCheck: viewer.authz.canAt("brain:edit", node.path) });
  if (!sample.ok) {
    return new Response(sample.message, { status: sample.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(new Uint8Array(sample.wav), {
    headers: {
      "content-type": "audio/wav",
      "content-length": String(sample.wav.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
