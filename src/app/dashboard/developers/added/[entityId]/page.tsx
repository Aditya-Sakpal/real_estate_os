import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { outsideDevelopers } from "@/lib/outside";
import { showRate } from "@/lib/outside-rules";
import { STATE_NAMES } from "@/lib/billing-rules";
import { PageHead } from "@/components/shell/PageHead";
import { SetupForm } from "../../OutsideForms";
import "@/app/workspace/workspace.css";

/**
 * A developer the channel partner added itself, not on Sales Desk: where it
 * takes buyer registrations, how long one holds, the brokerage it pays, and
 * who an invoice is made out to. Opens read-only; Edit opens the form.
 */
export default async function AddedDeveloper({
  params,
  searchParams,
}: {
  params: Promise<{ entityId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (viewer.orgType !== "CHANNEL_PARTNER" || viewer.via) redirect("/dashboard/developers");
  const { entityId } = await params;
  const q = await searchParams;
  const dev = (await outsideDevelopers(viewer.state.org.id)).find((d) => d.entityId === entityId);
  if (!dev) notFound();
  const mayEdit = viewer.authz.can("org:manage");
  const editing = mayEdit && (q.edit === "1" || !dev.setup);
  const here = `/dashboard/developers/added/${dev.entityId}`;
  const s = dev.setup;
  const states = Object.entries(STATE_NAMES).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));

  const rows: [string, string][] = s
    ? [
        ["Registrations go to", s.regEmail],
        ["Copy to", s.regCc.join(", ") || "Nobody"],
        ["Days a registration holds", String(s.validityDays)],
        ["Brokerage rate", showRate(s.rateBp)],
        ["Developer's GSTIN", s.gstin ?? "Not recorded"],
        ["Billing address", s.billAddress ?? "Not recorded"],
        ["State", s.stateCode ? STATE_NAMES[s.stateCode] ?? s.stateCode : "Not recorded"],
      ]
    : [];

  return (
    <>
      <PageHead
        title={
          <>
            <span className="em">{dev.name}</span>
          </>
        }
        meta={dev.projects.length ? dev.projects.map((p) => p.name).join(", ") : "No project yet"}
        back={{ label: "Developers", href: "/dashboard/developers" }}
        action={
          mayEdit && !editing ? (
            <a href={`${here}?edit=1`} className="btn btn--ink" data-edit-setup>
              Edit
            </a>
          ) : null
        }
      />
      <section className="card fw-card" aria-label="Registrations and invoicing">
        <div className="fw-card__head">
          <h2>Registrations and invoicing</h2>
        </div>
        {editing ? (
          <SetupForm
            entityId={dev.entityId}
            doneHref={here}
            states={states}
            initial={{
              regEmail: s?.regEmail ?? "",
              regCc: s?.regCc.join(", ") ?? "",
              validityDays: String(s?.validityDays ?? 30),
              rate: s ? String(s.rateBp / 100) : "",
              gstin: s?.gstin ?? "",
              billAddress: s?.billAddress ?? "",
              stateCode: s?.stateCode ?? "",
            }}
          />
        ) : s ? (
          <dl className="fw-facts" style={{ display: "grid", gridTemplateColumns: "minmax(160px, 240px) 1fr", gap: "8px 16px", margin: 0 }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt style={{ color: "var(--ink-mute)", fontSize: 13 }}>{k}</dt>
                <dd style={{ margin: 0, fontSize: 14 }}>{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="fw-empty">Ask your admin to add where {dev.name} takes registrations.</p>
        )}
      </section>
    </>
  );
}
