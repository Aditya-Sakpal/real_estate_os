import { getViewer } from "@/lib/console";
import { invoicePdf } from "@/lib/invoice";

/**
 * One invoice as a PDF, drawn from the row it was issued as. Behind the same
 * key as the list; RLS keeps another tenant's number from resolving at all.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer || !viewer.authz.can("billing:read")) return new Response("Not found", { status: 404 });
  const { id } = await params;
  const pdf = await invoicePdf(viewer.state.org.id, id);
  if (!pdf) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${pdf.number.replace(/\//g, "-")}.pdf"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
