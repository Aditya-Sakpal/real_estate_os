import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { listLoans, type LoanListRow } from "@/lib/loans";
import { LOAN_GROUPS, LOAN_STAGE_LABEL, LOAN_TONE } from "@/lib/loan-rules";
import { PageHead } from "@/components/shell/PageHead";
import { Alert, ArrowUpRight } from "@/components/icons";
import { LoanTabs } from "./LoanTabs";
import "./loans.css";

/**
 * Every buyer's home loan the viewer follows: what needs somebody first,
 * then each loan with its bank, what the bank has paid and the next thing to
 * do. A loan is worked on its own file; this is the queue.
 */

const TONE: Record<string, string> = { ok: "pill--ok", warn: "pill--warn", risk: "pill--risk", quiet: "pill--quiet", info: "pill--blue" };

function money(paise: number): string {
  const r = paise / 100;
  const trim = (x: number) => x.toFixed(2).replace(/\.?0+$/, "");
  if (r >= 1_00_00_000) return `Rs ${trim(r / 1_00_00_000)} Cr`;
  if (r >= 1_00_000) return `Rs ${trim(r / 1_00_000)} lakh`;
  return `Rs ${Math.round(r).toLocaleString("en-IN")}`;
}

export default async function LoansPage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("loan:update")) redirect(viewer.authz.can("loan:manage") ? "/dashboard/loans/banks" : "/dashboard");
  const orgId = viewer.state.org.id;
  const [{ group }, loans] = await Promise.all([searchParams, listLoans(orgId, viewer.authz.scopesFor("loan:update"))]);

  const counts = Object.fromEntries(LOAN_GROUPS.map((g) => [g.key, loans.filter((l) => (g.stages as readonly string[]).includes(l.stage)).length]));
  const chosen = LOAN_GROUPS.find((g) => g.key === group) ?? null;
  const shown = chosen ? loans.filter((l) => (chosen.stages as readonly string[]).includes(l.stage)) : loans.filter((l) => l.stage !== "NOT_NEEDED");
  const flagged = loans.filter((l) => l.flag);
  const open = loans.filter((l) => l.stage !== "DISBURSED" && l.stage !== "REJECTED" && l.stage !== "NOT_NEEDED");
  const sanctioned = loans.reduce((n, l) => n + (l.stage === "SANCTIONED" || l.stage === "DISBURSING" || l.stage === "DISBURSED" ? l.sanctionedPaise ?? 0 : 0), 0);
  const paid = loans.reduce((n, l) => n + l.bankPaidPaise, 0);

  const tabs = <LoanTabs current="/dashboard/loans" authz={viewer.authz} />;

  return (
    <>
      <PageHead
        title={
          <>
            Home <span className="em">loans</span>
          </>
        }
        meta={
          loans.length
            ? `${open.length.toLocaleString("en-IN")} open · ${money(sanctioned)} sanctioned · ${money(paid)} paid by banks`
            : "No home loans yet"
        }
      />
      {tabs}

      {flagged.length > 0 && (
        <section className="pub-needs" aria-labelledby="lo-needs-h" data-loan-needs>
          <div className="pub-needs__head">
            <h2 id="lo-needs-h">Needs you</h2>
            <span className="pub-needs__n tnum">{flagged.length}</span>
          </div>
          <ul className="pub-needs__list">
            {flagged.slice(0, 6).map((l) => (
              <li key={l.leadId} className="pub-needs__item">
                <span className="pub-needs__mark">
                  <Alert size={13} />
                </span>
                <span className="pub-needs__what">
                  <strong>{l.flag!.text}</strong>
                  <small>
                    {l.name} · {l.place}
                    {l.bank ? ` · ${l.bank}` : ""}
                  </small>
                </span>
                <Link href={`/dashboard/loans/${l.leadId}`} className="btn btn--light btn--sm">
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {loans.length === 0 ? (
        <section className="card lo-none">
          <p>No home loans yet. Record one from a buyer&apos;s page.</p>
        </section>
      ) : (
        <section className="card lo-list" aria-labelledby="lo-list-h">
          <div className="card__head">
            <h2 id="lo-list-h">{chosen ? chosen.label : "Loans"}</h2>
            <nav className="lo-filter" aria-label="Show">
              <Link href="/dashboard/loans" className={`pill ${!chosen ? "pill--blue" : "pill--quiet"}`} aria-current={!chosen ? "true" : undefined}>
                Open and done
              </Link>
              {LOAN_GROUPS.map((g) => (
                <Link
                  key={g.key}
                  href={`/dashboard/loans?group=${g.key}`}
                  className={`pill ${chosen?.key === g.key ? "pill--blue" : "pill--quiet"}`}
                  aria-current={chosen?.key === g.key ? "true" : undefined}
                >
                  {g.label} <span className="tnum">{counts[g.key]}</span>
                </Link>
              ))}
            </nav>
          </div>
          {shown.length === 0 ? (
            <p className="lo-faint">None here.</p>
          ) : (
            <div className="lo-scroll">
              <table className="lo-table">
                <thead>
                  <tr>
                    <th scope="col">Buyer</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Bank</th>
                    <th scope="col" className="lo-num">Sanctioned</th>
                    <th scope="col">Paid by bank</th>
                    <th scope="col" className="lo-num">Documents</th>
                    <th scope="col">Next</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((l) => (
                    <Row key={l.leadId} l={l} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function Row({ l }: { l: LoanListRow }) {
  const share = l.sanctionedPaise ? Math.min(100, Math.round((l.bankPaidPaise / l.sanctionedPaise) * 100)) : 0;
  return (
    <tr data-loan={l.leadId}>
      <th scope="row">
        <Link href={`/dashboard/loans/${l.leadId}`} className="lo-buyer">
          <strong>{l.name}</strong>
          <span>{l.place}</span>
        </Link>
      </th>
      <td>
        <span className={`pill ${TONE[LOAN_TONE[l.stage]]}`}>{LOAN_STAGE_LABEL[l.stage]}</span>
      </td>
      <td>{l.bank ?? <span className="lo-faint">Not chosen</span>}</td>
      <td className="lo-num tnum">{l.sanctionedPaise ? money(l.sanctionedPaise) : ""}</td>
      <td>
        {l.sanctionedPaise ? (
          <span className="lo-paid">
            <span className="lo-bar" aria-hidden="true">
              <span style={{ width: `${share}%` }} />
            </span>
            <span className="tnum">{share}%</span>
          </span>
        ) : (
          ""
        )}
      </td>
      <td className="lo-num tnum">
        {l.docs.done}/{l.docs.of}
      </td>
      <td>
        <Link href={`/dashboard/loans/${l.leadId}`} className={`lo-next${l.flag ? " lo-next--flag" : ""}`}>
          {l.flag?.text ?? l.next}
          <ArrowUpRight size={12} />
        </Link>
      </td>
    </tr>
  );
}
