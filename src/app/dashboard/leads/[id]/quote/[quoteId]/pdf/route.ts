import { requireAnyPermission } from "@/lib/guard";
import { audit, withTenant } from "@/lib/db";
import { isUuid } from "@/lib/capture-rules";
import { quotePdf } from "@/lib/quotes";
import { quoteRef } from "@/lib/quote-pdf";

/**
 * An approved quote as a PDF, drawn from the row it was approved as. Asked
 * at the lead's own tower: `quote:create` or `quote:approve` there. The
 * audit row names the quote and nothing about the buyer.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; quoteId: string }> }): Promise<Response> {
  const { id, quoteId } = await params;
  const { orgId, userId, authz } = await requireAnyPermission(["quote:create", "quote:approve"]);
  if (!isUuid(id) || !isUuid(quoteId)) return new Response("Not found", { status: 404 });
  const [lead] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
    SELECT n.path::text AS path FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id WHERE l.org_id = ${orgId} AND l.id = ${id}`);
  if (!lead || !(authz.canAt("quote:create", lead.path) || authz.canAt("quote:approve", lead.path))) {
    return new Response("Not found", { status: 404 });
  }
  const pdf = await quotePdf(orgId, id, quoteId);
  if (!pdf) return new Response("Not found", { status: 404 });
  await audit({ orgId, actorUserId: userId, action: "quote.pdf_downloaded", targetType: "quote", targetId: quoteId });
  return new Response(new Uint8Array(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${quoteRef(pdf.ref)}.pdf"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
