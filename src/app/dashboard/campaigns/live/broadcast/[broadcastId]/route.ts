import { fileReader } from "@/lib/guard";
import { broadcastPlace } from "@/lib/broadcast";
import { serveStored } from "@/lib/media-variants";
import { readVariant } from "@/lib/media-variant-rules";

/**
 * The picture one broadcast sends, for its thumbnail on Published: signed
 * in, `campaign:read` at the broadcast's own node, read through
 * `withTenant()`, and a 404 for every refusal.
 */
export async function GET(request: Request, { params }: { params: Promise<{ broadcastId: string }> }) {
  const viewer = await fileReader();
  if (!viewer || !viewer.authz.can("campaign:read")) return new Response("Not found", { status: 404 });

  const { broadcastId } = await params;
  const place = await broadcastPlace(viewer.orgId, broadcastId);
  if (!place || !viewer.authz.canAt("campaign:read", place.path)) return new Response("Not found", { status: 404 });

  // A JPEG or a PNG, and the browser tells the two apart itself.
  return serveStored({ key: place.mediaKey, type: "image/jpeg", asked: readVariant(new URL(request.url).searchParams.get("v")) });
}
