import { linkForFirm, postTower } from "@/lib/partner-workspace";
import { getViewer } from "@/lib/console";
import { partnerPost } from "@/lib/partner-posts";

/**
 * A developer's approved post with the firm's band beneath it, made on the
 * spot and handed over as a download. Signed in to the partner's console
 * with `partner:register`, the post on a project the developer has the firm
 * empanelled on today, the firm's link for that tower made if it has none,
 * and every publishing gate asked again by `partnerPost()`. A refusal is a
 * plain sentence, because this opens in a new tab.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ devOrgId: string; postId: string; index: string }> }) {
  const viewer = await getViewer();
  if (!viewer || viewer.orgType !== "CHANNEL_PARTNER" || viewer.via || !viewer.authz.can("partner:register")) {
    return new Response("Not found", { status: 404 });
  }
  const { devOrgId, postId, index } = await params;
  const towerId = await postTower({ cpOrgId: viewer.state.org.id, devOrgId, postId });
  if (!towerId) return new Response("Not found", { status: 404 });
  const link = await linkForFirm({ cpOrgId: viewer.state.org.id, userId: viewer.userId, devOrgId, towerId });
  const plain = (text: string) => new Response(text, { status: 409, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (!link.ok) return plain(link.message);
  const made = await partnerPost({ orgId: devOrgId, userId: viewer.userId, linkId: link.id, postId, index: Number(index) });
  if (!made.ok) return plain(made.message);
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
