import { getViewer } from "@/lib/console";
import { postPreview } from "@/lib/partner-workspace";

/**
 * A small picture of one frame of an approved post, so the partner can see
 * which post it is taking. The same checks as the download: the partner's
 * console, `partner:register`, and the post on a project the developer
 * has the firm empanelled on today.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ devOrgId: string; postId: string; index: string }> }) {
  const viewer = await getViewer();
  if (!viewer || viewer.orgType !== "CHANNEL_PARTNER" || viewer.via || !viewer.authz.can("partner:register")) {
    return new Response("Not found", { status: 404 });
  }
  const { devOrgId, postId, index } = await params;
  const bytes = await postPreview({ cpOrgId: viewer.state.org.id, devOrgId, postId, index: Number(index) });
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(bytes.byteLength),
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
