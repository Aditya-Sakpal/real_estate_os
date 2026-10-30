import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { loanFile } from "@/lib/loans";
import { listLenders } from "@/lib/visit-followups";
import { isUuid } from "@/lib/capture-rules";
import {
  beforeBankPays,
  capWarning,
  docChecklist,
  docProgress,
  loanFlag,
  loanSums,
  needsExtraPapers,
  LOAN_STAGE_LABEL,
} from "@/lib/loan-rules";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowLeft } from "@/components/icons";
import { LoanDetails } from "./LoanDetails";
import { Documents } from "./Documents";
import { Demands } from "./Demands";
import { PartnerShare } from "./PartnerShare";
import "../loans.css";

/**
 * One buyer's loan file: the loan, the money (the buyer's own share and the
 * bank's, demanded and paid), the documents, and each demand the developer
 * raised on the flat. Worked by the loan executive; read by anybody who may
 * see the lead.
 */

const inr = (paise: number) => `Rs ${Math.round(paise / 100).toLocaleString("en-IN")}`;

export default async function LoanFilePage({ params }: { params: Promise<{ leadId: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("lead:read")) redirect("/dashboard");
  const { leadId } = await params;
  if (!isUuid(leadId)) notFound();
  const orgId = viewer.state.org.id;
  const [file, listed] = await Promise.all([loanFile(orgId, leadId), listLenders(orgId)]);
  if (!file || file.lead.erased || !viewer.authz.canAt("lead:read", file.lead.path)) notFound();
  const canUpdate = viewer.authz.canAt("loan:update", file.lead.path);
  const { loan, demands, lead } = file;

  const lenders = listed.map((l) => ({ id: l.id, name: l.name }));
  if (loan?.lenderId && loan.bank && !lenders.some((l) => l.id === loan.lenderId)) lenders.push({ id: loan.lenderId, name: loan.bank });

  const now = new Date();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const extraPapers = needsExtraPapers({ approvedBank: file.approvedBank, hasBank: !!loan?.bank });
  const groups = docChecklist(loan?.applicant ?? null, loan?.agreementPaise ? loan.agreementPaise / 100 : null, extraPapers);
  const progress = loan ? docProgress(groups, loan.documents, loan.stage) : { done: 0, of: 0 };
  const sums = loanSums(demands, loan?.amountPaise ?? null, loan?.agreementPaise ?? null);
  const live = demands.filter((d) => !d.cancelled);
  const flag = loan ? loanFlag({ stage: loan.stage, stageAtIso: loan.stageAt, leadStage: lead.stage, expiresOn: loan.expiresOn, demands: live }, now.toISOString()) : null;
  const missing = loan && (loan.stage === "SANCTIONED" || loan.stage === "DISBURSING") ? beforeBankPays(loan.documents) : [];

  // MahaRERA's cumulative caps, demand by demand.
  const warnings: Record<string, string> = {};
  let running = 0;
  for (const d of live) {
    running += d.amountPaise;
    const w = capWarning(d.milestone, running, loan?.agreementPaise ?? null);
    if (w) warnings[d.id] = w;
  }
  const paying = loan?.stage === "SANCTIONED" || loan?.stage === "DISBURSING";

  return (
    <>
      <Link href={canUpdate ? "/dashboard/loans" : `/dashboard/leads/${lead.id}`} className="btn btn--light btn--sm" style={{ marginBottom: 12 }}>
        <ArrowLeft size={13} />
        {canUpdate ? "Home loans" : "Back to the lead"}
      </Link>
      <PageHead
        title={
          <>
            {lead.name}&apos;s <span className="em">home loan</span>
          </>
        }
        meta={`${lead.place}${loan ? ` · ${LOAN_STAGE_LABEL[loan.stage]}` : ""}`}
        action={
          <Link href={`/dashboard/leads/${lead.id}`} className="btn btn--ghost">
            Open the lead
          </Link>
        }
      />

      {flag && (
        <section className="pub-needs" aria-label="Needs you">
          <div className="pub-needs__head">
            <h2>Needs you</h2>
          </div>
          <p style={{ margin: 0 }}>{flag.text}</p>
        </section>
      )}

      <div className="lf-grid">
        <div className="lf-col">
          <LoanDetails
            leadId={lead.id}
            loan={loan}
            lenders={lenders}
            canUpdate={canUpdate}
            agreementGuess={lead.agreementRupees}
          />
          {loan && extraPapers && (
            <p className="note lf-cap" style={{ margin: 0 }}>
              {loan.bank} has not approved this project. It will check the title itself and needs the project&apos;s collection account, so
              allow more time.
            </p>
          )}
          {loan && file.partner && (
            <PartnerShare
              leadId={lead.id}
              partner={file.partner}
              switchOn={file.shareSwitch}
              share={loan.partnerShare}
              shareAt={loan.partnerShareAt}
              source={loan.partnerShareSource}
              canUpdate={canUpdate}
            />
          )}
          {loan && (loan.amountPaise || sums.demanded > 0) ? (
            <section className="card lf-card" aria-labelledby="lf-money-h">
              <div className="card__head">
                <h2 id="lf-money-h">Money</h2>
              </div>
              <div className="lf-money">
                {sums.own !== null && (
                  <div className="lf-money__row">
                    <div className="lf-money__top">
                      <span>Buyer&apos;s own share</span>
                      <strong className="tnum">
                        {inr(sums.buyerPaid)} of {inr(sums.own)}
                      </strong>
                    </div>
                    <span className="lo-bar lo-bar--buyer" aria-hidden="true">
                      <span style={{ width: `${sums.own ? Math.min(100, (sums.buyerPaid / sums.own) * 100) : 100}%` }} />
                    </span>
                  </div>
                )}
                {loan.amountPaise ? (
                  <div className="lf-money__row">
                    <div className="lf-money__top">
                      <span>Paid by the bank</span>
                      <strong className="tnum">
                        {inr(sums.bankPaid)} of {inr(loan.amountPaise)}
                      </strong>
                    </div>
                    <span className="lo-bar" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, (sums.bankPaid / loan.amountPaise) * 100)}%` }} />
                    </span>
                    <span className="lf-money__sub tnum">{inr(sums.undrawn ?? 0)} of the loan still to come.</span>
                  </div>
                ) : null}
                {sums.demanded > 0 && loan.agreementPaise ? (
                  <div className="lf-money__row">
                    <div className="lf-money__top">
                      <span>Demanded so far</span>
                      <strong className="tnum">
                        {inr(sums.demanded)} ({Math.round((sums.demanded / loan.agreementPaise) * 100)}%)
                      </strong>
                    </div>
                  </div>
                ) : null}
              </div>
              {missing.length > 0 && (
                <p className="note lf-cap">Before the bank pays it needs the {missing.join(", the ")}.</p>
              )}
            </section>
          ) : null}
        </div>
        <div className="lf-col">
          {loan && <Documents leadId={lead.id} groups={groups} received={loan.documents} progress={progress} canUpdate={canUpdate} />}
        </div>
      </div>

      {loan && (
        <Demands
          leadId={lead.id}
          demands={demands}
          today={today}
          canUpdate={canUpdate && loan.stage !== "REJECTED" && loan.stage !== "NOT_NEEDED"}
          split={{
            agreementPaise: loan.agreementPaise,
            sanctionedPaise: paying ? loan.amountPaise : null,
            buyerSharesSoFar: live.reduce((n, d) => n + d.buyerSharePaise, 0),
            bankSharesSoFar: live.reduce((n, d) => n + d.bankSharePaise, 0),
          }}
          warnings={warnings}
        />
      )}
    </>
  );
}
