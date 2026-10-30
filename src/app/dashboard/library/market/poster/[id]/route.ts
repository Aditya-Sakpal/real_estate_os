import { fileReader } from "@/lib/guard";
import { competitorPoster } from "@/lib/competitor";
import { isUuid } from "@/lib/capture-rules";

/**
 * One saved competitor ad's picture. Ours are read inside the tenant and
 * only where the viewer holds `campaign:read`; the market library's are
 * the same for everybody who may read campaigns at all. A 404 for every
 * refusal, so a guessed id learns nothing.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await fileReader();
  if (!viewer || !viewer.authz.can("campaign:read")) return new Response("Not found", { status: 404 });
  const { id } = await params;
  if (!isUuid(id)) return new Response("Not found", { status: 404 });
  const source = new URL(request.url).searchParams.get("s") === "market" ? "MARKET" : "OURS";
  const bytes = await competitorPoster(viewer.orgId, id, source, viewer.authz.scopesFor("campaign:read"));
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      // Every picture is re-encoded to JPEG when it is saved, so the type is ours.
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=3600",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
