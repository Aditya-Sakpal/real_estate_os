import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listInvoices } from "@/lib/invoice";
import { rupees } from "@/lib/billing-rules";
import { readFlash } from "@/lib/flash";
import { Flash } from "@/components/Flash";
import { PageHead } from "@/components/shell/PageHead";
import { Download, Receipt } from "@/components/icons";
import { BillingTabs } from "../BillingTabs";
import "../billing.css";

/** Every invoice and credit note issued to this organisation, newest first, each a PDF. */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("billing:read")) redirect("/dashboard/settings");
  const orgId = viewer.state.org.id;
  const [invoices, params] = await Promise.all([listInvoices(orgId), searchParams]);
  const when = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const month = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <PageHead title={<>Tax <span className="em">invoices</span></>} meta={invoices.length ? `${invoices.length} issued` : "None yet"} />
      <BillingTabs current="invoices" canManage={viewer.authz.can("billing:manage")} />
      <Flash text={readFlash(params, "saved")} name="saved" tone="info" style={{ marginBottom: 16 }} />

      {invoices.length === 0 ? (
        <section className="card empty" data-invoices-none>
          <span className="empty__mark">
            <Receipt size={18} />
          </span>
          <h2>No invoices yet</h2>
          <p className="sub">Each top-up and each month of a plan gets a GST invoice, and it appears here.</p>
        </section>
      ) : (
        <section className="card bill-invoices" data-invoices>
          <table className="bill-table">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Date</th>
                <th scope="col">For</th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} data-invoice={i.number}>
                  <td className="bill-table__no tnum">
                    {i.number}
                    {i.test && <span className="pill pill--quiet">Test</span>}
                    {i.kind === "CREDIT_NOTE" && <span className="pill pill--warn">Credit note</span>}
                  </td>
                  <td className="tnum">{when(i.issuedOn)}</td>
                  <td>
                    {i.kind === "CREDIT_NOTE"
                      ? `Against ${i.against?.number ?? "an invoice"}`
                      : i.purpose === "PLAN" && i.period
                        ? `Plan, ${month(i.period)}`
                        : "Top-up"}
                  </td>
                  <td className="num tnum">{rupees(i.kind === "CREDIT_NOTE" ? -i.totalPaise : i.totalPaise, true)}</td>
                  <td className="bill-table__dl">
                    <a href={`/dashboard/settings/billing/invoices/${i.id}/pdf`} className="btn btn--light btn--sm" download>
                      <Download size={14} />
                      PDF
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
