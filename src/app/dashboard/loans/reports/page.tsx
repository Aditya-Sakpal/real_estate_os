import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { loanReportData } from "@/lib/loans";
import { loanReport } from "@/lib/loan-rules";
import { PageHead } from "@/components/shell/PageHead";
import { LoanTabs } from "../LoanTabs";
import "../loans.css";

/**
 * How the loan desk stands: the loans by stage and by bank, the money the
 * developer demanded against the money in, the banks' parts waiting and for
 * how long, and why banks said no.
 */

function money(paise: number): string {
  const r = paise / 100;
  const trim = (x: number) => x.toFixed(2).replace(/\.?0+$/, "");
  if (r >= 1_00_00_000) return `Rs ${trim(r / 1_00_00_000)} Cr`;
  if (r >= 1_00_000) return `Rs ${trim(r / 1_00_000)} lakh`;
  return `Rs ${Math.round(r).toLocaleString("en-IN")}`;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export default async function LoanReportsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("loan:update")) redirect("/dashboard/loans/banks");
  const orgId = viewer.state.org.id;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const { loans, demands } = await loanReportData(orgId, viewer.authz.scopesFor("loan:update"));
  const r = loanReport(loans, demands, today);
  const maxStage = Math.max(1, ...r.stages.map((s) => s.count));

  return (
    <>
      <PageHead
        title={
          <>
            Home <span className="em">loans</span>
          </>
        }
        meta={loans.length ? `${loans.length} ${loans.length === 1 ? "loan" : "loans"}${r.lapsing ? ` · ${r.lapsing} ${r.lapsing === 1 ? "sanction lapses" : "sanctions lapse"} within a month` : ""}` : "No home loans yet"}
      />
      <LoanTabs current="/dashboard/loans/reports" authz={viewer.authz} />

      {loans.length === 0 ? (
        <section className="card lo-none">
          <p>Nothing to report yet.</p>
        </section>
      ) : (
        <>
          <div className="lf-grid">
            <section className="card lf-card" aria-labelledby="rp-stage-h">
              <div className="card__head">
                <h2 id="rp-stage-h">Loans by stage</h2>
              </div>
              <div className="rp-bars">
                {r.stages.map((s) => (
                  <div key={s.key} className="rp-bar">
                    <span className="rp-bar__label">{s.label}</span>
                    <span className="lo-bar rp-bar__track" aria-hidden="true">
                      <span style={{ width: `${(s.count / maxStage) * 100}%` }} />
                    </span>
                    <strong className="tnum">{s.count}</strong>
                    <span className="rp-bar__sub tnum">{s.sanctionedPaise ? money(s.sanctionedPaise) : ""}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="card lf-card" aria-labelledby="rp-money-h">
              <div className="card__head">
                <h2 id="rp-money-h">Money demanded and in</h2>
              </div>
              <div className="lf-money">
                <div className="lf-money__row">
                  <div className="lf-money__top">
                    <span>Buyers&apos; share</span>
                    <strong className="tnum">
                      {money(r.money.buyerPaid)} of {money(r.money.buyerShare)}
                    </strong>
                  </div>
                  <span className="lo-bar lo-bar--buyer" aria-hidden="true">
                    <span style={{ width: `${pct(r.money.buyerPaid, r.money.buyerShare)}%` }} />
                  </span>
                </div>
                <div className="lf-money__row">
                  <div className="lf-money__top">
                    <span>Banks&apos; share</span>
                    <strong className="tnum">
                      {money(r.money.bankPaid)} of {money(r.money.bankShare)}
                    </strong>
                  </div>
                  <span className="lo-bar" aria-hidden="true">
                    <span style={{ width: `${pct(r.money.bankPaid, r.money.bankShare)}%` }} />
                  </span>
                </div>
                <div className="lf-money__row">
                  <div className="lf-money__top">
                    <span>Collected</span>
                    <strong className="tnum">
                      {pct(r.money.buyerPaid + r.money.bankPaid, r.money.demanded)}% of {money(r.money.demanded)} demanded
                    </strong>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <section className="card lf-card" aria-labelledby="rp-bank-h" style={{ marginBottom: 16 }}>
            <div className="card__head">
              <h2 id="rp-bank-h">By bank</h2>
            </div>
            {r.byBank.length === 0 ? (
              <p className="lo-faint">No loan has a bank yet.</p>
            ) : (
              <div className="lo-scroll">
                <table className="lo-table">
                  <thead>
                    <tr>
                      <th scope="col">Bank</th>
                      <th scope="col" className="lo-num">Loans</th>
                      <th scope="col" className="lo-num">Open</th>
                      <th scope="col" className="lo-num">Sanctioned</th>
                      <th scope="col" className="lo-num">Paid out</th>
                      <th scope="col" className="lo-num">Rejected</th>
                      <th scope="col" className="lo-num">Days to pay a demand</th>
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {r.byBank.map((b) => (
                      <tr key={b.bank}>
                        <th scope="row">{b.bank}</th>
                        <td className="lo-num">{b.loans}</td>
                        <td className="lo-num">{b.open}</td>
                        <td className="lo-num">
                          {b.sanctioned} · {money(b.sanctionedPaise)}
                        </td>
                        <td className="lo-num">{money(b.bankPaidPaise)}</td>
                        <td className="lo-num">{b.rejected}</td>
                        <td className="lo-num">{b.daysToPay ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="lf-grid">
            <section className="card lf-card" aria-labelledby="rp-age-h">
              <div className="card__head">
                <h2 id="rp-age-h">Banks&apos; payments waiting</h2>
              </div>
              <table className="lo-table">
                <tbody className="tnum">
                  {r.ageing.map((a) => (
                    <tr key={a.label}>
                      <th scope="row">{a.label}</th>
                      <td className="lo-num">{a.count}</td>
                      <td className="lo-num">{money(a.paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card lf-card" aria-labelledby="rp-rej-h">
              <div className="card__head">
                <h2 id="rp-rej-h">Why banks said no</h2>
              </div>
              {r.rejections.length === 0 ? (
                <p className="lo-faint">No rejections.</p>
              ) : (
                <table className="lo-table">
                  <tbody className="tnum">
                    {r.rejections.map((x) => (
                      <tr key={x.reason}>
                        <th scope="row">{x.label}</th>
                        <td className="lo-num">{x.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
