import { fileReader } from "@/lib/guard";
import { readReferenceMedia } from "@/lib/campaign";
import { isVideoType } from "@/lib/campaign-rules";

/**
 * Serve one reference file.
 *
 * A route rather than a data URI in the page, because a brief can carry a
 * dozen references and inlining them would put hundreds of megabytes of
 * base64 into every render of the screen.
 *
 * Four things guard it, and all four are needed. The viewer must be signed
 * in; the read goes through `withTenant()`, so a reference id belonging to
 * another organisation returns nothing before the application ever gets to
 * compare an org id; the reference must be filed under the brief the address
 * names; and the viewer must hold `campaign:read` where that brief sits, not
 * merely somewhere. A 404 for all four, because telling a crafted request
 * apart from a mistyped one is telling it whether the id exists.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ briefId: string; refId: string }> },
) {
  const viewer = await fileReader();
  if (!viewer) return new Response("Not found", { status: 404 });

  const { briefId, refId } = await params;
  const media = await readReferenceMedia(viewer.orgId, briefId, refId);
  if (!media || !viewer.authz.canAt("campaign:read", media.path)) {
    return new Response("Not found", { status: 404 });
  }

  const headers: Record<string, string> = {
    "content-type": media.type,
    // Tenant data. A shared cache holding this would serve one developer's
    // reference to the next request that asked for the same URL.
    "cache-control": "private, max-age=300",
    // The bytes were uploaded by a person, so the browser must never be
    // allowed to decide for itself what they are: `nosniff` pins it to the
    // type above, and the type can only be one of the seven in MEDIA_TYPES.
    // SVG is deliberately absent from that list, because an SVG served
    // inline is a document that can carry script.
    "content-security-policy": "default-src 'none'",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
  };

  // Video needs ranges. A <video> element asks for `bytes=0-` and then seeks
  // by asking for a later window; a server that answers every one of those
  // with the whole file makes scrubbing re-download the clip, and Safari
  // will not play at all without a 206.
  const range = isVideoType(media.type) ? request.headers.get("range") : null;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const total = media.bytes.byteLength;
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      if (Number.isFinite(start) && start <= end && start < total) {
        const slice = media.bytes.subarray(start, end + 1);
        return new Response(new Uint8Array(slice), {
          status: 206,
          headers: {
            ...headers,
            "content-range": `bytes ${start}-${end}/${total}`,
            "content-length": String(slice.byteLength),
            "accept-ranges": "bytes",
          },
        });
      }
      // A range past the end of the file is a client bug, and the answer to
      // it is the length rather than the bytes.
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${total}` },
      });
    }
  }

  return new Response(new Uint8Array(media.bytes), {
    headers: {
      ...headers,
      "content-length": String(media.bytes.byteLength),
      ...(isVideoType(media.type) ? { "accept-ranges": "bytes" } : {}),
    },
  });
}
