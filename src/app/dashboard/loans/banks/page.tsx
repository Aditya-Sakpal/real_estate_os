import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listBanks, projectsForBanks } from "@/lib/banks";
import { showBankPhone, tieUpState } from "@/lib/bank-rules";
import { removeBankAction } from "@/app/actions/loans";
import { PageHead } from "@/components/shell/PageHead";
import { ConfirmAction } from "@/components/ConfirmAction";
import { LoanTabs } from "../LoanTabs";
import { AddBank, EditableBank } from "./BankEditor";
import "../loans.css";

/**
 * The developer's bank tie-ups: each bank, who to call there, what it
 * offers buyers and until when, and the projects it approved. The lender
 * question, the calling agents and every loan file read this list.
 */

const STATE: Record<string, { text: string; tone: string }> = {
  LIVE: { text: "Active", tone: "pill--ok" },
  ENDING: { text: "Ending soon", tone: "pill--warn" },
  ENDED: { text: "Ended", tone: "pill--quiet" },
};

function money(paise: number): string {
  const r = paise / 100;
  const trim = (x: number) => x.toFixed(2).replace(/\.?0+$/, "");
  if (r >= 1_00_00_000) return `Rs ${trim(r / 1_00_00_000)} Cr`;
  if (r >= 1_00_000) return `Rs ${trim(r / 1_00_000)} lakh`;
  return `Rs ${Math.round(r).toLocaleString("en-IN")}`;
}

const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

export default async function BanksPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("loan:update") && !viewer.authz.can("loan:manage")) redirect("/dashboard");
  const orgId = viewer.state.org.id;
  const canManage = viewer.authz.canAt("loan:manage", viewer.state.rootPath);
  const [banks, projects] = await Promise.all([listBanks(orgId), projectsForBanks(orgId)]);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const live = banks.filter((b) => tieUpState(b.validUntil, today) !== "ENDED").length;

  return (
    <>
      <PageHead
        title={
          <>
            Home <span className="em">loans</span>
          </>
        }
        meta={banks.length ? `${live} active ${live === 1 ? "tie-up" : "tie-ups"}` : "No bank tie-ups yet"}
      />
      <LoanTabs current="/dashboard/loans/banks" authz={viewer.authz} />

      {canManage && (
        <div className="bk-bar">
          <AddBank projects={projects} today={today} />
        </div>
      )}

      {banks.length === 0 ? (
        <section className="card lo-none">
          <p>No banks yet.{canManage ? "" : " Ask an admin to add the banks you have tie-ups with."}</p>
        </section>
      ) : (
        <div className="bk-grid">
          {banks.map((b) => {
            const state = STATE[tieUpState(b.validUntil, today)];
            return (
              <section key={b.id} className="card lf-card bk-card" aria-labelledby={`bk-${b.id}`} data-bank={b.name}>
                <EditableBank
                  bank={{ ...b, projects: b.projects.map((p) => ({ id: p.id, apfNo: p.apfNo })) }}
                  projects={projects}
                  today={today}
                  canManage={canManage}
                  remove={
                    <ConfirmAction
                      label="Remove"
                      title={`Remove ${b.name}?`}
                      body="Buyers who already said yes stay with this bank. No new buyer is offered it."
                      confirmLabel="Remove bank"
                      action={removeBankAction}
                      fields={{ lenderId: b.id }}
                      tone="ghost"
                    />
                  }
                >
                  <div className="card__head">
                    <h2 id={`bk-${b.id}`}>{b.name}</h2>
                    <span className={`pill ${state.tone}`}>{state.text}</span>
                  </div>
                  <dl className="lf-dl">
                    <div>
                      <dt>Contact</dt>
                      <dd>
                        {b.contactName ?? "Not recorded"}
                        {b.contactPhone ? <span className="bk-sub tnum">{showBankPhone(b.contactPhone)}</span> : null}
                      </dd>
                    </div>
                    <div>
                      <dt>Buyers sent to</dt>
                      <dd className="bk-mail">{b.email}</dd>
                    </div>
                    <div>
                      <dt>Offer</dt>
                      <dd>
                        {b.rateBp ? `From ${b.rateBp / 100}% a year` : "Not recorded"}
                        {b.feeNote ? <span className="bk-sub">{b.feeNote}</span> : null}
                      </dd>
                    </div>
                    <div>
                      <dt>Valid until</dt>
                      <dd className="tnum">{b.validUntil ? day(b.validUntil) : "No end date"}</dd>
                    </div>
                  </dl>
                  <div className="bk-approved">
                    <span className="bk-approved__label">Approved projects</span>
                    {b.projects.length ? (
                      <span className="bk-approved__list">
                        {b.projects.map((p) => (
                          <span key={p.id} className="pill pill--blue">
                            {p.name}
                            {p.apfNo ? <span className="tnum"> · {p.apfNo}</span> : null}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="lo-faint">Every project</span>
                    )}
                  </div>
                  <p className="bk-stats tnum">
                    {b.loans.open} open {b.loans.open === 1 ? "loan" : "loans"} · {money(b.loans.sanctionedPaise)} sanctioned · {b.loans.rejected} rejected
                  </p>
                </EditableBank>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
