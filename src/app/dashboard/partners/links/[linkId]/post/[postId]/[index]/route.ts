import { getViewer } from "@/lib/console";
import { linkPath } from "@/lib/partners";
import { partnerPost } from "@/lib/partner-posts";

/**
 * A partner's co-branded copy of one frame of an approved post, made on the
 * spot and handed over as a download. Signed in, `partner:register` at the
 * link's tower, and every publishing gate asked again by `partnerPost()`.
 * A refusal is a plain sentence, because this opens in a new tab.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ linkId: string; postId: string; index: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  const { linkId, postId, index } = await params;
  const path = await linkPath(viewer.state.org.id, linkId);
  if (!path || !viewer.authz.canAt("partner:register", path)) return new Response("Not found", { status: 404 });
  const made = await partnerPost({ orgId: viewer.state.org.id, userId: viewer.userId, linkId, postId, index: Number(index) });
  if (!made.ok) {
    return new Response(made.message, { status: 409, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(new Uint8Array(made.bytes), {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(made.bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${made.name}"`,
    },
  });
}
