import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listWaitingCallers } from "@/lib/waiting-callers";
import { showPhone } from "@/lib/brand-rules";
import { dismissCallerAction, fileCallerAction } from "@/app/actions/callers";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import "./callers.css";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Callers to a number that covers several projects, whom nobody could file.
 * Each one is filed under the project they called about, through the same
 * capture every enquiry takes, or removed as not a buyer.
 */
export default async function WaitingCallersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("lead:create")) redirect("/dashboard/leads");
  const q = await searchParams;
  const callers = await listWaitingCallers(viewer.state.org.id, viewer.authz);

  return (
    <>
      <PageHead
        title={
          <>
            Callers to <span className="em">file</span>
          </>
        }
        meta={callers.length ? `${callers.length} waiting for a project` : "Nobody waiting"}
        back={{ label: "Leads", href: "/dashboard/leads" }}
      />

      <Flash text={readFlash(q, "done")} name="done" tone="info" />
      <Flash text={readFlash(q, "error")} name="error" />

      {callers.length === 0 ? (
        <section className="card wc-empty">
          <p>Every caller to your numbers is filed under a project.</p>
        </section>
      ) : (
        <ul className="wc-list">
          {callers.map((c) => (
            <li key={c.id} className="card wc-row" data-waiting-caller={c.id}>
              <div className="wc-who">
                <div className="wc-line">
                  <strong className="wc-caller">{c.caller}</strong>
                  <span className={`pill ${c.answered ? "pill--ok" : "pill--warn"}`}>
                    {c.via === "AI" ? "AI answered" : c.answered ? "Team answered" : "Missed"}
                  </span>
                </div>
                <p className="wc-meta">
                  Rang {showPhone(c.number) ?? c.number} · {when(c.at)}
                </p>
                {c.heard && <p className="wc-heard">{c.heard}</p>}
              </div>

              <div className="wc-acts">
                {c.towers.length ? (
                  <KeptForm action={fileCallerAction} className="wc-file">
                    <input type="hidden" name="event" value={c.id} />
                    <select name="tower" className="select-field" required defaultValue="" aria-label="Project they called about">
                      <option value="" disabled>
                        Which project
                      </option>
                      {c.towers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="btn btn--ink btn--sm" data-file-caller>
                      File as a lead
                    </button>
                  </KeptForm>
                ) : (
                  <p className="wc-meta">No project here you can add leads to.</p>
                )}
                <ConfirmAction
                  label="Not a buyer"
                  title="Remove this caller?"
                  body="No lead is made, and they leave this list."
                  confirmLabel="Remove caller"
                  action={dismissCallerAction}
                  fields={{ event: c.id }}
                  tone="ghost"
                  testId="dismiss-caller"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
