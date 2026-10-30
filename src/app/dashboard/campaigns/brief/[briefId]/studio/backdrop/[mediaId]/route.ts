import { fileReader } from "@/lib/guard";
import { campaignPath } from "@/lib/campaign-reach";
import { backdropLink } from "@/lib/creative";
import { serveStored } from "@/lib/media-variants";
import { readVariant } from "@/lib/media-variant-rules";

/**
 * Hand over one generated backdrop.
 *
 * A redirect to a link signed for five minutes, the way the asset route does
 * it, so a megabyte of picture never passes through this server. Guarded the
 * same three ways: the viewer must be signed in, must hold `campaign:read`,
 * and the row is read through `withTenant()`, so an id belonging to another
 * organisation resolves to nothing and no link is ever signed for it. A 404
 * for all three, because telling a crafted request apart from a mistyped one
 * is telling it whether the id exists.
 *
 * The redirect is `private, no-store`: the URL inside it outlives nothing but
 * its own signature, so it is the one thing that must never be cached.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> },
) {
  const viewer = await fileReader();
  if (!viewer || !viewer.authz.can("campaign:read")) {
    return new Response("Not found", { status: 404 });
  }

  const { mediaId } = await params;
  // Held where the campaign sits, not merely somewhere.
  const reach = await campaignPath(viewer.orgId, "backdrop", mediaId);
  if (!reach || !viewer.authz.canAt("campaign:read", reach)) return new Response("Not found", { status: 404 });
  const link = await backdropLink(viewer.orgId, mediaId);
  if (!link) return new Response("Not found", { status: 404 });

  return serveStored({ key: link.key, type: link.type, asked: readVariant(new URL(request.url).searchParams.get("v")) });
}
