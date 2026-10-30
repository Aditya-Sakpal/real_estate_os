import { fileReader } from "@/lib/guard";
import { documentFile } from "@/lib/extract";
import { assetUrl, readAsset } from "@/lib/storage";

/**
 * The document as it was uploaded. A redirect to a link signed for five
 * minutes, the asset library's pattern, so a sixty-megabyte brochure never
 * passes through this server; streamed from the local store on a machine
 * with no bucket. Signed in, `brain:read` at its node, read inside the
 * tenant, and a 404 for all three.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ nodeId: string; docId: string }> },
) {
  const viewer = await fileReader();
  if (!viewer) return new Response("Not found", { status: 404 });
  const { nodeId, docId } = await params;
  const doc = await documentFile(viewer.orgId, docId);
  if (!doc || doc.nodeId !== nodeId || !viewer.authz.canAt("brain:read", doc.path)) {
    return new Response("Not found", { status: 404 });
  }
  const link = await assetUrl(doc.key, doc.type);
  if (!link.ok) return new Response("Not found", { status: 404 });
  if (link.url.startsWith("file://")) {
    const bytes = await readAsset(doc.key);
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": doc.type,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=300",
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
        "content-disposition": "inline",
      },
    });
  }
  return new Response(null, { status: 302, headers: { location: link.url, "cache-control": "private, no-store" } });
}
