"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { saveLoanAction, type LoanResult } from "@/app/actions/loans";
import {
  APPLICANTS,
  APPLICANT_LABEL,
  ARRANGERS,
  ARRANGER_LABEL,
  type Arranger,
  LOAN_REASONS,
  LOAN_REASON_LABEL,
  LOAN_STAGE_LABEL,
  LOAN_TONE,
  loanChoices,
  needsAmount,
  needsBank,
  type Applicant,
  type LoanStage,
} from "@/lib/loan-rules";

const TONE: Record<string, string> = { ok: "pill--ok", warn: "pill--warn", risk: "pill--risk", quiet: "pill--quiet", info: "pill--blue" };
const inr = (paise: number) => `Rs ${Math.round(paise / 100).toLocaleString("en-IN")}`;
const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const since = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

export type LoanDetailsView = {
  stage: LoanStage;
  lenderId: string | null;
  bankName: string | null;
  bank: string | null;
  amountPaise: number | null;
  reason: string | null;
  applicant: Applicant | null;
  rateBp: number | null;
  expiresOn: string | null;
  agreementPaise: number | null;
  arrangedBy: Arranger | null;
  stageAt: string;
};

/**
 * The loan itself: where it stands, the bank, what it sanctioned, at what
 * rate and until when, and the flat's agreement value the buyer's share is
 * worked out from. Opens read-only; "Update loan" opens the form, which asks
 * only what the chosen stage needs.
 */
export function LoanDetails({
  leadId,
  loan,
  lenders,
  canUpdate,
  agreementGuess,
}: {
  leadId: string;
  loan: LoanDetailsView | null;
  lenders: { id: string; name: string }[];
  canUpdate: boolean;
  /** The agreement value the lead already carries, offered when the loan has none. */
  agreementGuess: number | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(!loan && canUpdate);
  const [said, save, saving] = useActionState<LoanResult | null, FormData>(saveLoanAction, null);
  const choices = loanChoices(loan?.stage ?? null);
  const [stage, setStage] = useState<LoanStage>(choices[0] ?? "INTERESTED");
  const startLender = loan?.lenderId ?? (loan?.bankName ? "OTHER" : "");
  const [lender, setLender] = useState(startLender);

  useEffect(() => {
    if (said?.ok) {
      setEditing(false);
      router.refresh();
    }
  }, [said, router]);

  const open = () => {
    setStage(choices[0] ?? "INTERESTED");
    setLender(startLender);
    setEditing(true);
  };

  const agreementDefault = loan?.agreementPaise ? String(Math.round(loan.agreementPaise / 100)) : agreementGuess ? String(agreementGuess) : "";

  return (
    <section className="card lf-card" aria-labelledby="lf-loan-h">
      <div className="card__head">
        <h2 id="lf-loan-h">The loan</h2>
        {loan && !editing && <span className={`pill ${TONE[LOAN_TONE[loan.stage]]}`}>{LOAN_STAGE_LABEL[loan.stage]}</span>}
        {canUpdate && loan && !editing && choices.length > 0 && (
          <button type="button" className="btn btn--ink btn--sm" onClick={open}>
            Update loan
          </button>
        )}
      </div>

      {said && !said.ok && (
        <p className="note note--risk lf-note" role="alert">
          {said.message}
        </p>
      )}

      {editing ? (
        <form action={save} className="lf-form">
          <input type="hidden" name="leadId" value={leadId} />
          <div className="field">
            <label htmlFor="lf-stage">Where it stands</label>
            <select id="lf-stage" name="stage" value={stage} onChange={(e) => setStage(e.target.value as LoanStage)}>
              {choices.map((c) => (
                <option key={c} value={c}>
                  {LOAN_STAGE_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="lf-applicant">Buyer is</label>
            <select id="lf-applicant" name="applicant" defaultValue={loan?.applicant ?? ""}>
              <option value="">Not known yet</option>
              {APPLICANTS.map((a) => (
                <option key={a} value={a}>
                  {APPLICANT_LABEL[a]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="lf-arranged">Arranged by</label>
            <select id="lf-arranged" name="arrangedBy" defaultValue={loan?.arrangedBy ?? ""}>
              <option value="">Not known yet</option>
              {ARRANGERS.map((a) => (
                <option key={a} value={a}>
                  {ARRANGER_LABEL[a]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="lf-bank">Bank{needsBank(stage) ? "" : " (optional)"}</label>
            <select id="lf-bank" name="lender" value={lender} onChange={(e) => setLender(e.target.value)} required={needsBank(stage)}>
              <option value="">{needsBank(stage) ? "Choose a bank" : "Not chosen yet"}</option>
              {lenders.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
              <option value="OTHER">Another bank</option>
            </select>
          </div>
          {lender === "OTHER" && (
            <div className="field">
              <label htmlFor="lf-other">Bank name</label>
              <input id="lf-other" name="bankName" maxLength={80} defaultValue={loan?.bankName ?? ""} placeholder="e.g. Canara Bank" required />
            </div>
          )}
          <div className="field">
            <label htmlFor="lf-agreement">Agreement value</label>
            <input id="lf-agreement" name="agreement" inputMode="decimal" className="tnum" defaultValue={agreementDefault} placeholder="e.g. 96,00,000 or 96 lakh" />
          </div>
          {needsAmount(stage) && (
            <>
              <div className="field">
                <label htmlFor="lf-amount">Sanctioned</label>
                <input
                  id="lf-amount"
                  name="amount"
                  inputMode="decimal"
                  className="tnum"
                  defaultValue={loan?.amountPaise ? String(Math.round(loan.amountPaise / 100)) : ""}
                  placeholder="e.g. 72,00,000 or 72 lakh"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="lf-rate">Rate, % a year (optional)</label>
                <input id="lf-rate" name="rate" inputMode="decimal" className="tnum" defaultValue={loan?.rateBp ? String(loan.rateBp / 100) : ""} placeholder="e.g. 8.5" />
              </div>
              <div className="field">
                <label htmlFor="lf-expires">Sanction valid until (optional)</label>
                <input id="lf-expires" name="expiresOn" type="date" className="tnum" defaultValue={loan?.expiresOn ?? ""} />
              </div>
            </>
          )}
          {stage === "REJECTED" && (
            <div className="field">
              <label htmlFor="lf-reason">Why the bank said no</label>
              <select id="lf-reason" name="reason" defaultValue={loan?.reason ?? ""} required>
                <option value="" disabled>
                  Choose a reason
                </option>
                {LOAN_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {LOAN_REASON_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="lf-acts">
            {loan && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </button>
            )}
            <button type="submit" className="btn btn--ink btn--sm" disabled={saving}>
              {saving ? "Saving" : loan ? "Save loan" : "Start the loan file"}
            </button>
          </div>
        </form>
      ) : loan ? (
        <dl className="lf-dl">
          <div>
            <dt>Bank</dt>
            <dd>{loan.bank ?? "Not chosen yet"}</dd>
          </div>
          <div>
            <dt>Arranged by</dt>
            <dd>{loan.arrangedBy ? ARRANGER_LABEL[loan.arrangedBy] : "Not known yet"}</dd>
          </div>
          <div>
            <dt>Buyer is</dt>
            <dd>{loan.applicant ? APPLICANT_LABEL[loan.applicant] : "Not known yet"}</dd>
          </div>
          <div>
            <dt>Agreement value</dt>
            <dd className="tnum">{loan.agreementPaise ? inr(loan.agreementPaise) : "Not recorded"}</dd>
          </div>
          {loan.amountPaise !== null && (
            <div>
              <dt>Sanctioned</dt>
              <dd className="tnum">
                {inr(loan.amountPaise)}
                {loan.rateBp ? ` at ${loan.rateBp / 100}%` : ""}
              </dd>
            </div>
          )}
          {loan.expiresOn && (
            <div>
              <dt>Sanction valid until</dt>
              <dd className="tnum">{day(loan.expiresOn)}</dd>
            </div>
          )}
          {loan.reason && (
            <div>
              <dt>Reason</dt>
              <dd>{LOAN_REASON_LABEL[loan.reason as keyof typeof LOAN_REASON_LABEL] ?? loan.reason}</dd>
            </div>
          )}
          <div>
            <dt>{LOAN_STAGE_LABEL[loan.stage]} since</dt>
            <dd className="tnum">{since(loan.stageAt)}</dd>
          </div>
        </dl>
      ) : (
        <p className="lo-faint">No loan recorded for this buyer.</p>
      )}
    </section>
  );
}
