import { fileReader } from "@/lib/guard";
import { readBrandFile } from "@/lib/brand";

/**
 * Serve one brand file.
 *
 * Guarded the same three ways every other file route here is: the viewer must
 * be signed in, must hold `brand:read`, and the read goes through
 * `withTenant()`, so a file id belonging to another organisation returns
 * nothing before the application gets to compare an org id. A 404 for all
 * three, because telling a crafted request apart from a mistyped one is
 * telling it whether the id exists.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const viewer = await fileReader();
  if (!viewer || !viewer.authz.can("brand:read")) {
    return new Response("Not found", { status: 404 });
  }

  const { fileId } = await params;
  const file = await readBrandFile(viewer.orgId, fileId);
  if (!file) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type": file.type,
      "content-length": String(file.bytes.byteLength),
      // Tenant data. A shared cache holding this would serve one developer's
      // logo to the next request that asked for the same URL.
      "cache-control": "private, max-age=300",
      // The bytes were uploaded by a person, so the browser must never decide
      // for itself what they are. The type can only be one of the seven in
      // LOGO_TYPES and FONT_TYPES, and SVG is deliberately absent because an
      // SVG served inline is a document that can carry script.
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
