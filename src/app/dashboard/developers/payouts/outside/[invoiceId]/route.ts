import { requirePermission } from "@/lib/guard";
import { audit } from "@/lib/db";
import { outsideInvoicePdf } from "@/lib/outside";

/**
 * A channel partner's own brokerage invoice to a developer not on
 * Sales Desk, as a PDF drawn from the row it was issued as. `payout:read`,
 * the key that sees money; the audit row names the invoice and nothing else.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ invoiceId: string }> }): Promise<Response> {
  const { invoiceId } = await params;
  const { orgId, userId } = await requirePermission("payout:read", "/dashboard/developers");
  const got = await outsideInvoicePdf(orgId, invoiceId);
  if (!got) return new Response("Not found", { status: 404 });
  await audit({ orgId, actorUserId: userId, action: "partner.outside_invoice_downloaded", targetType: "outside_invoice", targetId: invoiceId });
  return new Response(new Uint8Array(got.pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${got.number.replace(/\//g, "-")}.pdf"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
