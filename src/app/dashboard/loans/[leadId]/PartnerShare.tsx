"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { loanShareAction, type LoanResult } from "@/app/actions/loans";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

/**
 * Whether the channel partner who brought this buyer is told how the loan
 * is going. Only the stage, only with the buyer's yes, and only where the
 * developer switched it on in Partner rules.
 */
export function PartnerShare({
  leadId,
  partner,
  switchOn,
  share,
  shareAt,
  source,
  canUpdate,
}: {
  leadId: string;
  partner: string;
  switchOn: boolean;
  share: "ASKED" | "YES" | "NO" | null;
  shareAt: string | null;
  source: "WHATSAPP" | "PERSON" | null;
  canUpdate: boolean;
}) {
  const router = useRouter();
  const [said, act, busy] = useActionState<LoanResult | null, FormData>(loanShareAction, null);
  useEffect(() => {
    if (said?.ok) router.refresh();
  }, [said, router]);

  const button = (step: string, label: string, ink = false) => (
    <form action={act}>
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="step" value={step} />
      <button type="submit" className={`btn ${ink ? "btn--ink" : "btn--ghost"} btn--sm`} disabled={busy}>
        {label}
      </button>
    </form>
  );

  const state = !switchOn
    ? { pill: "pill--quiet", text: "Not shared" }
    : share === "YES"
      ? { pill: "pill--ok", text: "Partner sees the stage" }
      : share === "NO"
        ? { pill: "pill--quiet", text: "Buyer said no" }
        : share === "ASKED"
          ? { pill: "pill--warn", text: "Asked, no answer yet" }
          : { pill: "pill--quiet", text: "Not asked" };

  return (
    <section className="card lf-card" aria-labelledby="lf-share-h">
      <div className="card__head">
        <h2 id="lf-share-h">Channel partner: {partner}</h2>
        <span className={`pill ${state.pill}`}>{state.text}</span>
      </div>
      {said && !said.ok && (
        <p className="note note--risk lf-note" role="alert">
          {said.message}
        </p>
      )}
      <p className="lo-faint" style={{ marginBottom: 12 }}>
        {!switchOn
          ? "Channel partners do not see their buyers' loans. Partner rules can change that."
          : share === "YES" || share === "NO"
            ? `${source === "WHATSAPP" ? "Answered on WhatsApp" : "Recorded"} on ${when(shareAt!)}.`
            : "They see the loan's stage only if the buyer agrees. Never the bank or the amount."}
      </p>
      {switchOn && canUpdate && (
        <div className="bk-foot">
          {(share === null || share === "ASKED") && button("ASK", share === "ASKED" ? "Ask again on WhatsApp" : "Ask the buyer on WhatsApp", true)}
          {share !== "YES" && button("YES", "Buyer agreed")}
          {share !== "NO" && button("NO", share === "YES" ? "Buyer withdrew" : "Buyer said no")}
        </div>
      )}
    </section>
  );
}
