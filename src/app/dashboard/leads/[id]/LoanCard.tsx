import Link from "next/link";
import { LOAN_STAGE_LABEL, LOAN_TONE, type LoanStage } from "@/lib/loan-rules";

const TONE: Record<string, string> = { ok: "pill--ok", warn: "pill--warn", risk: "pill--risk", quiet: "pill--quiet", info: "pill--blue" };
const inr = (paise: number) => `Rs ${Math.round(paise / 100).toLocaleString("en-IN")}`;

export type LoanView = {
  stage: LoanStage;
  bank: string | null;
  amountPaise: number | null;
};

/**
 * The buyer's home loan, in one line, on the lead's page. The loan is
 * worked on its own file: the documents, the bank and every demand.
 */
export function LoanCard({ leadId, loan, canUpdate }: { leadId: string; loan: LoanView | null; canUpdate: boolean }) {
  return (
    <section className="card ld-card ld-loan" aria-labelledby="ld-loan-h">
      <div className="card__head">
        <h2 id="ld-loan-h" className="ld-h">
          Home loan
        </h2>
        {loan && <span className={`pill ${TONE[LOAN_TONE[loan.stage]]}`}>{LOAN_STAGE_LABEL[loan.stage]}</span>}
        {(loan || canUpdate) && (
          <Link href={`/dashboard/loans/${leadId}`} className="btn btn--ink btn--sm">
            {loan ? "Open loan file" : "Start a loan file"}
          </Link>
        )}
      </div>
      {loan ? (
        <dl className="ld-quote__sum">
          <div>
            <dt>Bank</dt>
            <dd>{loan.bank ?? "Not chosen yet"}</dd>
          </div>
          {loan.amountPaise !== null && (
            <div>
              <dt>Sanctioned</dt>
              <dd className="tnum">{inr(loan.amountPaise)}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="ld-empty">No home loan recorded.</p>
      )}
    </section>
  );
}
