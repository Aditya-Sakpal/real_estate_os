import { fileReader } from "@/lib/guard";
import { campaignPath } from "@/lib/campaign-reach";
import { publicationMedia } from "@/lib/publish";
import { serveStored } from "@/lib/media-variants";
import { readVariant } from "@/lib/media-variant-rules";

/**
 * The first file of one publication, for its thumbnail on Published.
 *
 * The pattern every other media route follows: signed in with
 * `campaign:read`, the row read through `withTenant()` so another
 * organisation's publication resolves to nothing, and a 404 for all three.
 */
export async function GET(request: Request, { params }: { params: Promise<{ targetId: string }> }) {
  const viewer = await fileReader();
  if (!viewer || !viewer.authz.can("campaign:read")) return new Response("Not found", { status: 404 });

  const { targetId } = await params;
  // Held where the campaign sits, not merely somewhere.
  const reach = await campaignPath(viewer.orgId, "target", targetId);
  if (!reach || !viewer.authz.canAt("campaign:read", reach)) return new Response("Not found", { status: 404 });
  const media = await publicationMedia(viewer.orgId, targetId);
  if (!media) return new Response("Not found", { status: 404 });

  return serveStored({ key: media.key, type: media.type, asked: readVariant(new URL(request.url).searchParams.get("v")) });
}
