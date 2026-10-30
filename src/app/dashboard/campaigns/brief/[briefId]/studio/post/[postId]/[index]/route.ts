import { fileReader } from "@/lib/guard";
import { campaignPath } from "@/lib/campaign-reach";
import { postMedia } from "@/lib/compose";
import { readAsset } from "@/lib/storage";
import { serveStored } from "@/lib/media-variants";
import { readVariant } from "@/lib/media-variant-rules";

/**
 * Hand over one file of one made post: a frame, a slide, or a clip.
 *
 * The pattern the backdrop route uses, for the same reasons: signed in, with
 * `campaign:read`, and the row read through `withTenant()` so another
 * organisation's post resolves to nothing. A 404 for all three.
 *
 * `?download=1` asks the browser to save rather than show, which is how a
 * person takes a post to wherever they publish it until the publishers exist.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ postId: string; index: string }> },
) {
  const viewer = await fileReader();
  if (!viewer || !viewer.authz.can("campaign:read")) {
    return new Response("Not found", { status: 404 });
  }

  const { postId, index } = await params;
  // Held where the campaign sits, not merely somewhere.
  const reach = await campaignPath(viewer.orgId, "post", postId);
  if (!reach || !viewer.authz.canAt("campaign:read", reach)) return new Response("Not found", { status: 404 });
  const media = await postMedia(viewer.orgId, postId, Number(index));
  if (!media) return new Response("Not found", { status: 404 });

  const download = new URL(request.url).searchParams.get("download") === "1";
  const ext = media.type === "video/mp4" ? "mp4" : "jpg";
  const disposition = download
    ? `attachment; filename="post-${postId.slice(0, 8)}-${index}.${ext}"`
    : "inline";

  // The local driver hands back a file:// path no browser follows, and a
  // download has to carry its own disposition, so both are served here.
  if (download) {
    const bytes = await readAsset(media.key);
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": media.type,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=300",
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
        "content-disposition": disposition,
      },
    });
  }

  // `?v=thumb` for a tile, `?v=preview` for the player: lighter copies.
  return serveStored({ key: media.key, type: media.type, asked: readVariant(new URL(request.url).searchParams.get("v")) });
}
