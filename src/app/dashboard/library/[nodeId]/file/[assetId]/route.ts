import { fileReader } from "@/lib/guard";
import { approvedAssets, assetLink, assetPlace } from "@/lib/asset";
import { resolveScopeNode } from "@/lib/scope-nodes";
import { serveStored } from "@/lib/media-variants";
import { readVariant } from "@/lib/media-variant-rules";

/**
 * Hand a viewer one asset.
 *
 * Unlike every other file route here, this does not stream bytes. The object
 * lives in a private bucket, so the answer is a redirect to a viewing link
 * (`viewUrl()`, the same for the hour). That keeps a hundred megabyte render off this server entirely
 * and still means nothing is readable without passing the checks below first.
 *
 * Three of them, and all three are needed. The viewer must be signed in, must
 * hold `asset:read`, and the row is read through `withTenant()`, so an asset
 * id belonging to another organisation resolves to nothing and no link is
 * ever signed for it. A 404 for all three, because telling a crafted request
 * apart from a mistyped one is telling it whether the id exists.
 *
 * The redirect is kept by this browser only, and only while the link inside
 * it still holds.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ nodeId: string; assetId: string }> },
) {
  const viewer = await fileReader();
  if (!viewer || !viewer.authz.can("asset:read")) {
    return new Response("Not found", { status: 404 });
  }

  // The key at the library being looked at, not merely somewhere: a reader
  // on Tower A is not a reader on Tower B, and an asset id names either. The
  // asset has to be in force there, filed on that node or above it, which
  // is how a tower's reader sees the project's site plan and nothing else.
  const { nodeId, assetId } = await params;
  const [node, place] = await Promise.all([
    resolveScopeNode(viewer.orgId, nodeId),
    assetPlace(viewer.orgId, assetId),
  ]);
  // A channel partner's linked project shows the developer's approved
  // pictures: in force here when the read through the link returns it.
  const theirs =
    node && !place ? (await approvedAssets(viewer.orgId, node.id)).find((a) => a.id === assetId && a.sourceOrgId) : undefined;
  const inForce =
    !!node && (!!theirs || (!!place && (place.path === node.path || node.path.startsWith(`${place.path}.`))));
  if (!inForce || !viewer.authz.canAt("asset:read", node.path)) {
    return new Response("Not found", { status: 404 });
  }
  const link = await assetLink(theirs?.sourceOrgId ?? viewer.orgId, assetId);
  if (!link) return new Response("Not found", { status: 404 });

  // `?v=thumb` for a tile: a small copy, made the first time it is asked for.
  return serveStored({ key: link.key, type: link.type, asked: readVariant(new URL(request.url).searchParams.get("v")) });
}
