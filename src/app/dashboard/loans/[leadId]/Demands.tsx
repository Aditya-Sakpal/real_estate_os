"use client";

import { Fragment, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmAction } from "@/components/ConfirmAction";
import { addDemandAction, demandStepAction, type LoanResult } from "@/app/actions/loans";
import { MILESTONES, bankPart, milestoneLabel, readDemandAmount, splitDemand, type DemandRow, type Milestone } from "@/lib/loan-rules";

const inr = (paise: number) => `Rs ${Math.round(paise / 100).toLocaleString("en-IN")}`;
const day = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const TONE: Record<string, string> = { ok: "pill--ok", warn: "pill--warn", risk: "pill--risk", quiet: "pill--quiet" };

/**
 * Every demand the developer raised on this flat, in the construction-linked
 * plan's order. Each is split once into the buyer's share (their own money
 * goes first) and the bank's, and each part is followed until it is paid.
 */
export function Demands({
  leadId,
  demands,
  today,
  canUpdate,
  split,
  warnings,
}: {
  leadId: string;
  demands: DemandRow[];
  today: string;
  canUpdate: boolean;
  /** What a new demand's split is worked out from; null while nothing is sanctioned. */
  split: { agreementPaise: number | null; sanctionedPaise: number | null; buyerSharesSoFar: number; bankSharesSoFar: number };
  warnings: Record<string, string>;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [added, add, addingNow] = useActionState<LoanResult | null, FormData>(addDemandAction, null);
  const [stepped, step, stepping] = useActionState<LoanResult | null, FormData>(demandStepAction, null);
  const [milestone, setMilestone] = useState<Milestone>(nextMilestone(demands));
  const [amount, setAmount] = useState("");

  useEffect(() => {
    if (added?.ok) {
      setAdding(false);
      setAmount("");
      router.refresh();
    }
  }, [added, router]);
  useEffect(() => {
    if (stepped?.ok) {
      setOpen(null);
      router.refresh();
    }
  }, [stepped, router]);

  const typed = readDemandAmount(amount);
  const preview = typed ? splitDemand({ amountPaise: typed * 100, ...split }) : null;
  const error = (adding && added && !added.ok ? added.message : null) ?? (stepped && !stepped.ok ? stepped.message : null);

  return (
    <section className="card lf-card lf-demands" aria-labelledby="lf-dem-h">
      <div className="card__head">
        <h2 id="lf-dem-h">Demands</h2>
        {canUpdate && !adding && (
          <button
            type="button"
            className="btn btn--ink btn--sm"
            onClick={() => {
              setMilestone(nextMilestone(demands));
              setAdding(true);
            }}
          >
            Record a demand
          </button>
        )}
      </div>

      {error && (
        <p className="note note--risk lf-note" role="alert">
          {error}
        </p>
      )}

      {adding && (
        <form action={add} className="lf-form" style={{ marginBottom: 16 }}>
          <input type="hidden" name="leadId" value={leadId} />
          <div className="field">
            <label htmlFor="dm-stage">Stage</label>
            <select id="dm-stage" name="milestone" value={milestone} onChange={(e) => setMilestone(e.target.value as Milestone)}>
              {MILESTONES.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          {milestone === "SLAB" ? (
            <div className="field">
              <label htmlFor="dm-slab">Slab number</label>
              <input id="dm-slab" name="slabNo" inputMode="numeric" className="tnum" placeholder="e.g. 5" required />
            </div>
          ) : (
            <div />
          )}
          <div className="field">
            <label htmlFor="dm-on">Demand date</label>
            <input id="dm-on" name="demandOn" type="date" className="tnum" max={today} defaultValue={today} required />
          </div>
          <div className="field">
            <label htmlFor="dm-amt">Amount on the demand letter</label>
            <input id="dm-amt" name="amount" inputMode="decimal" className="tnum" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 4,80,000" required />
          </div>
          {preview && (
            <p className="lf-wide lo-faint">
              Buyer pays <strong className="tnum">{inr(preview.buyer)}</strong>, bank pays <strong className="tnum">{inr(preview.bank)}</strong>.
            </p>
          )}
          <div className="lf-acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdding(false)} disabled={addingNow}>
              Cancel
            </button>
            <button type="submit" className="btn btn--ink btn--sm" disabled={addingNow}>
              {addingNow ? "Saving" : "Record demand"}
            </button>
          </div>
        </form>
      )}

      {demands.length === 0 ? (
        <p className="lo-faint">No demands recorded yet.</p>
      ) : (
        <div className="lo-scroll">
          <table className="lo-table">
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col">Raised</th>
                <th scope="col" className="lo-num">Amount</th>
                <th scope="col">Buyer&apos;s share</th>
                <th scope="col">Bank&apos;s share</th>
                {canUpdate && <th scope="col" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {demands.map((d) => {
                const bank = bankPart(d, today);
                const settled = (d.buyerSharePaise === 0 || !!d.buyerPaidOn) && (d.bankSharePaise === 0 || !!d.bankPaidOn);
                return (
                  <Fragment key={d.id}>
                    <tr className={d.cancelled ? "lf-cancelled" : undefined} data-demand={d.id}>
                      <th scope="row">
                        {milestoneLabel(d.milestone, d.slabNo)}
                        {warnings[d.id] && !d.cancelled && <span className="pill pill--warn" style={{ marginLeft: 8 }}>Past MahaRERA cap</span>}
                      </th>
                      <td className="tnum">{day(d.demandOn)}</td>
                      <td className="lo-num tnum">{inr(d.amountPaise)}</td>
                      <td>
                        {d.buyerSharePaise > 0 ? (
                          <span className="lf-split">
                            <span className="tnum">{inr(d.buyerSharePaise)}</span>
                            <small>{d.buyerPaidOn ? `Paid ${day(d.buyerPaidOn)}` : "To pay"}</small>
                          </span>
                        ) : (
                          <span className="lo-faint">None</span>
                        )}
                      </td>
                      <td>
                        {bank ? (
                          <span className="lf-split">
                            <span className="tnum">{inr(d.bankPaidPaise ?? d.bankSharePaise)}</span>
                            <small>
                              <span className={`pill ${TONE[bank.tone]}`}>{bank.text}</span>
                            </small>
                          </span>
                        ) : (
                          <span className="lo-faint">None</span>
                        )}
                      </td>
                      {canUpdate && (
                        <td>
                          {!d.cancelled && !settled && (
                            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(open === d.id ? null : d.id)} aria-expanded={open === d.id}>
                              {open === d.id ? "Close" : "Update"}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                    {open === d.id && (
                      <tr>
                        <td colSpan={6}>
                          <div className="lf-parts">
                            {d.bankSharePaise > 0 && !d.bankPaidOn && !d.sentToBankOn && (
                              <StepForm leadId={leadId} demandId={d.id} step="SENT" label="Sent to the bank" today={today} min={d.demandOn} busy={stepping} action={step} />
                            )}
                            {d.bankSharePaise > 0 && !d.bankPaidOn && (
                              <StepForm
                                leadId={leadId}
                                demandId={d.id}
                                step="BANK_PAID"
                                label="Bank paid"
                                today={today}
                                min={d.demandOn}
                                busy={stepping}
                                action={step}
                                amount={String(Math.round(d.bankSharePaise / 100))}
                              />
                            )}
                            {d.buyerSharePaise > 0 && !d.buyerPaidOn && (
                              <StepForm leadId={leadId} demandId={d.id} step="BUYER_PAID" label="Buyer paid their share" today={today} min={d.demandOn} busy={stepping} action={step} />
                            )}
                            {!d.bankPaidOn && !d.buyerPaidOn && (
                              <ConfirmAction
                                label="Cancel this demand"
                                title="Cancel this demand?"
                                body={<p>{milestoneLabel(d.milestone, d.slabNo)}, {inr(d.amountPaise)}. Record it again if the letter was wrong.</p>}
                                confirmLabel="Cancel demand"
                                action={step}
                                fields={{ leadId, demandId: d.id, step: "CANCEL" }}
                                tone="ghost"
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {Object.values(warnings)[0] && <p className="note lf-cap">{Object.values(warnings).slice(-1)[0]}</p>}
    </section>
  );
}

function StepForm({
  leadId,
  demandId,
  step,
  label,
  today,
  min,
  busy,
  action,
  amount,
}: {
  leadId: string;
  demandId: string;
  step: string;
  label: string;
  today: string;
  min: string;
  busy: boolean;
  action: (f: FormData) => void;
  amount?: string;
}) {
  return (
    <form action={action} className="lf-part lf-step">
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="demandId" value={demandId} />
      <input type="hidden" name="step" value={step} />
      {amount !== undefined && <input name="amount" aria-label="Amount the bank paid" inputMode="decimal" className="tnum" defaultValue={amount} required />}
      <input name="on" type="date" aria-label="On" className="tnum" min={min} max={today} defaultValue={today} required />
      <button type="submit" className="btn btn--ink btn--sm" disabled={busy}>
        {label}
      </button>
    </form>
  );
}

/** The stage after the last one recorded: a new demand usually follows the plan. */
function nextMilestone(demands: DemandRow[]): Milestone {
  const live = demands.filter((d) => !d.cancelled);
  const last = live[live.length - 1];
  if (!last) return "BOOKING";
  if (last.milestone === "SLAB") return "SLAB";
  const i = MILESTONES.findIndex((m) => m.key === last.milestone);
  return MILESTONES[Math.min(i + 1, MILESTONES.length - 1)].key;
}
