import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { importPortalSheetAction } from "@/app/actions/portals";
import { PORTAL_KEYS, portalLabel } from "@/lib/portal-rules";
import { ENQUIRY_DAYS } from "@/lib/calling-hours";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import "../availability/availability.css";

/**
 * A property portal's lead export, added to the pipeline. Each row goes the
 * way a forwarded portal email goes: the same enquiry twice is one lead, and
 * one whose project nobody has matched to a tower waits for that match.
 */
export default async function PortalImportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("lead:create")) redirect("/dashboard/leads");
  const q = await searchParams;
  const mayConnect = viewer.authz.can("integration:manage");

  return (
    <>
      <PageHead
        title={
          <>
            Portal <span className="em">leads</span>
          </>
        }
        meta="Add enquiries from a portal's export."
        back={{ label: "Leads", href: "/dashboard/leads" }}
      />

      <Flash text={readFlash(q, "done")} name="done" tone="info" />
      <Flash text={readFlash(q, "error")} name="error" />

      <KeptForm action={importPortalSheetAction} className="card av-import av-import--first">
        <div className="av-import__row">
          <div className="av-import__text">
            <label className="av-import__label" htmlFor="pt-sheet">
              Import a portal&rsquo;s lead export
            </label>
            <p className="av-import__hint">
              Excel or CSV, with each enquiry&rsquo;s date and mobile number. Enquiries older than {ENQUIRY_DAYS} days are
              skipped.
            </p>
          </div>
          <select name="portal" className="select-field" required defaultValue="" aria-label="Portal" data-portal-pick>
            <option value="" disabled>
              Which portal
            </option>
            {PORTAL_KEYS.map((k) => (
              <option key={k} value={k}>
                {k === "OTHER" ? "Another portal" : portalLabel(k)}
              </option>
            ))}
          </select>
          <input
            id="pt-sheet"
            className="av-import__pick"
            type="file"
            name="sheet"
            required
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          />
          <button type="submit" className="btn btn--ink" data-import-portal>
            Import
          </button>
        </div>
      </KeptForm>

      {mayConnect && (
        <p className="av-import__hint" style={{ marginTop: 16 }}>
          Portal emails can arrive on their own.{" "}
          <Link href="/dashboard/settings/connections/portals">Set up forwarding</Link>
        </p>
      )}
    </>
  );
}
