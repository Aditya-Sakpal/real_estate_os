import { getViewer } from "@/lib/console";
import { invoiceFile } from "@/lib/partners";
import { assetUrl, readAsset } from "@/lib/storage";

/**
 * A partner's invoice, for whoever may see the payout it is for: signed in,
 * `payout:read` at the payout's project, and the row read through
 * `withTenant()`, so another organisation's invoice resolves to nothing. A
 * 404 for every refusal.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  const { invoiceId } = await params;
  const file = await invoiceFile(viewer.state.org.id, invoiceId);
  if (!file || !viewer.authz.canAt("payout:read", file.path)) return new Response("Not found", { status: 404 });

  const signed = await assetUrl(file.key, file.type);
  // The local driver hands back a file:// path no browser follows.
  if (!signed.ok || signed.url.startsWith("file://")) {
    const bytes = await readAsset(file.key);
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": file.type,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=300",
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
        "content-disposition": "inline",
      },
    });
  }
  return new Response(null, { status: 302, headers: { location: signed.url, "cache-control": "private, no-store" } });
}
