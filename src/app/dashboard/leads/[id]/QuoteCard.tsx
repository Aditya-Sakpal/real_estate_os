"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { draftQuoteAction, quoteStepAction, type ActionResult } from "@/app/actions/leads";
import type { QuoteView } from "@/lib/quotes";
import { CANCEL_REASONS } from "@/lib/lead-rules";
import { ArrowUpRight, Check } from "@/components/icons";

const inr = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const day = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

const EXTRA: Record<string, string> = { FLOOR_RISE: "Floor rise", PLC: "PLC" };
const CHARGE: Record<string, string> = { PARKING: "Car parking", CLUB: "Club membership", MAINTENANCE_DEPOSIT: "Maintenance deposit", LEGAL: "Legal charges" };
const IN_AGREEMENT = new Set(["PARKING", "CLUB"]);
const MODE: Record<string, string> = { CHEQUE: "cheque", TRANSFER: "bank transfer", RAZORPAY: "Razorpay" };
const REFUND_STATE: Record<string, string> = { DUE: "Owed to the buyer", REQUESTED: "Refund in progress", PROCESSED: "Refunded", FAILED: "Refund failed" };

type Panel = null | "draft" | "offline" | "cancel" | "refund" | "part";

/**
 * A buyer's quote: the engine drafts it from approved facts, a person
 * approves it, and one press blocks the flat and sends the token link. A
 * token paid by cheque or transfer is recorded here, and a paid token is
 * cancelled here with what is given back. One action at a time, at the top.
 */
export function QuoteCard({
  leadId,
  quote,
  choices,
  today,
  canDraft,
  canApprove,
  paymentsOn,
}: {
  leadId: string;
  quote: QuoteView | null;
  choices: { units: { id: string; label: string }[]; flats: { unitNo: string; unitTypeId: string | null }[]; woman: string | null };
  today: string;
  canDraft: boolean;
  canApprove: boolean;
  paymentsOn: boolean;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [draftState, draft, drafting_] = useActionState<ActionResult | null, FormData>(draftQuoteAction, null);
  const [stepState, step, stepping] = useActionState<ActionResult | null, FormData>(quoteStepAction, null);
  const [unitTypeId, setUnitTypeId] = useState(choices.units[0]?.id ?? "");
  const [offlineMode, setOfflineMode] = useState("CHEQUE");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (draftState?.ok) {
      setPanel(null);
      router.refresh();
    }
  }, [draftState, router]);
  useEffect(() => {
    if (stepState?.ok) {
      setPanel(null);
      router.refresh();
    }
  }, [stepState, router]);

  const flats = useMemo(
    () => choices.flats.filter((f) => !f.unitTypeId || f.unitTypeId === unitTypeId),
    [choices.flats, unitTypeId],
  );
  const live = quote && ["DRAFT", "APPROVED", "SENT", "CANCELLED"].includes(quote.state) ? quote : null;
  const paid = !!live && live.state === "SENT" && live.paid >= live.token;
  const linkOut = live?.state === "SENT" && live.link?.status === "CREATED";
  // Part of the token is in and the rest is not.
  const partly = !!live && live.state === "SENT" && live.paid > 0 && live.paid < live.token;
  const left = live ? live.token - live.paid : 0;
  const inside = live ? live.charges.filter((c) => IN_AGREEMENT.has(c.kind)) : [];
  const outside = live ? live.charges.filter((c) => !IN_AGREEMENT.has(c.kind)) : [];
  const cancelled = live?.state === "CANCELLED";
  const refundOpen = cancelled && live?.refund && (live.refund.state === "DUE" || live.refund.state === "FAILED");
  const error =
    (panel === "draft" && draftState && !draftState.ok ? draftState.message : null) ?? (stepState && !stepState.ok ? stepState.message : null);

  const hidden = (s: string) => (
    <>
      <input type="hidden" name="quoteId" value={live?.id ?? ""} />
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="step" value={s} />
    </>
  );

  // The one primary action for where the quote stands.
  let action: React.ReactNode = null;
  if (!panel && live?.state === "DRAFT" && canApprove) {
    action = (
      <form action={step}>
        {hidden("approve")}
        <button type="submit" className="btn btn--ink btn--sm" disabled={stepping}>
          {stepping ? "Approving" : "Approve quote"}
          <Check size={13} />
        </button>
      </form>
    );
  } else if (!panel && live?.state === "APPROVED" && canApprove) {
    action = paymentsOn ? (
      <form action={step}>
        {hidden("send")}
        <button type="submit" className="btn btn--ink btn--sm" disabled={stepping}>
          {stepping ? "Sending" : `Block ${live.unitNo} and send token link`}
          <ArrowUpRight size={13} />
        </button>
      </form>
    ) : (
      <button type="button" className="btn btn--ink btn--sm" onClick={() => setPanel("offline")}>
        Record token paid
      </button>
    );
  } else if (!panel && partly && !linkOut && canApprove) {
    action = paymentsOn ? (
      <form action={step}>
        {hidden("send")}
        <button type="submit" className="btn btn--ink btn--sm" disabled={stepping}>
          {stepping ? "Sending" : `Send link for the rest, ${inr(left)}`}
          <ArrowUpRight size={13} />
        </button>
      </form>
    ) : (
      <button type="button" className="btn btn--ink btn--sm" onClick={() => setPanel("offline")}>
        Record the rest paid
      </button>
    );
  } else if (!panel && refundOpen && canApprove) {
    action = (
      <button type="button" className="btn btn--ink btn--sm" onClick={() => setPanel("refund")}>
        Record refund paid
      </button>
    );
  } else if (!panel && !live && canDraft) {
    action = (
      <button type="button" className="btn btn--ink btn--sm" onClick={() => setPanel("draft")} disabled={!choices.units.length}>
        Draft a quote
      </button>
    );
  }

  // Secondary: a token paid another way, a paid token cancelled, a fresh draft.
  const secondary: React.ReactNode[] = [];
  if (!panel && canApprove && ((live?.state === "APPROVED" && paymentsOn) || linkOut || (partly && paymentsOn))) {
    secondary.push(
      <button key="offline" type="button" className="btn btn--ghost btn--sm" onClick={() => setPanel("offline")}>
        Paid by cheque or transfer
      </button>,
    );
  }
  if (!panel && canApprove && paymentsOn && (live?.state === "APPROVED" || (partly && !linkOut && (live?.parts.length ?? 0) < 2))) {
    secondary.push(
      <button key="part" type="button" className="btn btn--ghost btn--sm" onClick={() => setPanel("part")}>
        Link for part of it
      </button>,
    );
  }
  if (!panel && canApprove && live?.state === "APPROVED" && !paymentsOn) {
    secondary.push(
      <span key="connect" className="pill pill--warn">
        Connect Razorpay to send token links
      </span>,
    );
  }
  if (!panel && canApprove && (paid || partly)) {
    secondary.push(
      <button key="cancel" type="button" className="btn btn--ghost btn--sm" onClick={() => setPanel("cancel")}>
        Cancel token
      </button>,
    );
  }
  if (!panel && live && (live.state === "DRAFT" || live.state === "APPROVED") && canDraft) {
    secondary.push(
      <button key="again" type="button" className="btn btn--ghost btn--sm" onClick={() => setPanel("draft")}>
        Draft again
      </button>,
    );
  }

  const pill = !live || panel ? null : cancelled ? (
    <span className="pill pill--quiet">Token cancelled</span>
  ) : paid ? (
    <span className="pill pill--ok">Token paid</span>
  ) : partly ? (
    <span className="pill pill--warn">
      {inr(live.paid)} of {inr(live.token)} paid
    </span>
  ) : live.state === "SENT" ? (
    <span className="pill pill--blue">Token link out</span>
  ) : live.state === "APPROVED" ? (
    <span className="pill pill--quiet">Approved</span>
  ) : (
    <span className="pill pill--warn">Draft, not approved</span>
  );

  return (
    <section className="card ld-card ld-quote" aria-labelledby="ld-quote-h">
      <div className="card__head">
        <h2 id="ld-quote-h" className="ld-h">
          Quote
        </h2>
        {pill}
        {secondary}
        {action}
      </div>

      {error && (
        <p className="note note--risk ld-quote__note" role="alert">
          {error}
        </p>
      )}

      {panel === "draft" ? (
        <form action={draft} className="ld-quote__form">
          <input type="hidden" name="leadId" value={leadId} />
          <div className="field">
            <label htmlFor="q-unit">Configuration</label>
            <select id="q-unit" name="unitTypeId" value={unitTypeId} onChange={(e) => setUnitTypeId(e.target.value)} required>
              {choices.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="q-flat">Flat</label>
            {flats.length ? (
              <select id="q-flat" name="unitNo" required defaultValue="">
                <option value="" disabled>
                  Pick a flat
                </option>
                {flats.map((f) => (
                  <option key={f.unitNo} value={f.unitNo}>
                    {f.unitNo}
                  </option>
                ))}
              </select>
            ) : (
              <p className="ld-empty">No flats of this configuration are available.</p>
            )}
          </div>
          <div className="field">
            <label htmlFor="q-fr">Floor rise (optional)</label>
            <div className="ld-quote__pair">
              <input id="q-fr" name="floorRise" inputMode="numeric" placeholder="e.g. 150" autoComplete="off" />
              <select name="floorRiseBasis" defaultValue="PSF" aria-label="Floor rise is charged">
                <option value="PSF">per sq ft</option>
                <option value="LUMP">lump sum</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="q-plc">PLC (optional)</label>
            <div className="ld-quote__pair">
              <input id="q-plc" name="plc" inputMode="numeric" placeholder="e.g. 2,00,000" autoComplete="off" />
              <select name="plcBasis" defaultValue="LUMP" aria-label="PLC is charged">
                <option value="LUMP">lump sum</option>
                <option value="PSF">per sq ft</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="q-park">Car parking (optional)</label>
            <input id="q-park" name="parking" inputMode="numeric" placeholder="e.g. 5,00,000" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="q-club">Club membership (optional)</label>
            <input id="q-club" name="club" inputMode="numeric" placeholder="e.g. 1,50,000" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="q-maint">Maintenance deposit (optional)</label>
            <input id="q-maint" name="maintenance" inputMode="numeric" placeholder="e.g. 1,20,000" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="q-legal">Legal charges (optional)</label>
            <input id="q-legal" name="legal" inputMode="numeric" placeholder="e.g. 25,000" autoComplete="off" />
          </div>
          {choices.woman && (
            <label className="checkset__item ld-quote__wide">
              <input type="checkbox" name="woman" />
              <span>
                <strong>Woman buying alone</strong>
                <small>{choices.woman}</small>
              </span>
            </label>
          )}
          <div className="ld-quote__acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPanel(null)} disabled={drafting_}>
              Cancel
            </button>
            <button type="submit" className="btn btn--ink btn--sm" disabled={drafting_ || !flats.length}>
              {drafting_ ? "Working it out" : "Draft quote"}
            </button>
          </div>
        </form>
      ) : panel === "offline" && live ? (
        <form action={step} className="ld-quote__form">
          {hidden("offline")}
          <div className="field">
            <label htmlFor="q-mode">Paid by</label>
            <select id="q-mode" name="mode" value={offlineMode} onChange={(e) => setOfflineMode(e.target.value)}>
              <option value="CHEQUE">Cheque</option>
              <option value="TRANSFER">Bank transfer</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="q-ref">{offlineMode === "CHEQUE" ? "Cheque number" : "UTR"}</label>
            <input
              id="q-ref"
              name="reference"
              required
              autoComplete="off"
              placeholder={offlineMode === "CHEQUE" ? "e.g. 004512" : "e.g. HDFCR52026093012345"}
            />
          </div>
          <div className="field">
            <label htmlFor="q-amt">Amount</label>
            <input id="q-amt" name="amount" inputMode="numeric" required defaultValue={(live.token - live.paid).toLocaleString("en-IN")} />
          </div>
          {live.parts.length < 2 && (
            <label className="checkset__item ld-quote__wide">
              <input type="checkbox" name="part" />
              <span>
                <strong>Part of the token</strong>
                <small>The flat stays held for the rest.</small>
              </span>
            </label>
          )}
          <div className="field">
            <label htmlFor="q-on">Paid on</label>
            <input id="q-on" name="paidOn" type="date" required max={today} defaultValue={today} />
          </div>
          <div className="ld-quote__acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPanel(null)} disabled={stepping}>
              Cancel
            </button>
            <button type="submit" className="btn btn--ink btn--sm" disabled={stepping}>
              {stepping ? "Recording" : live.paid > 0 ? "Record payment" : `Record payment and block ${live.unitNo}`}
            </button>
          </div>
        </form>
      ) : panel === "cancel" && live ? (
        <form action={step} className="ld-quote__form">
          {hidden("cancel")}
          <div className="field">
            <label htmlFor="q-why">Why is the booking cancelled?</label>
            <select id="q-why" name="reason" required defaultValue="">
              <option value="" disabled>
                Choose a reason
              </option>
              {CANCEL_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="q-refund">Refund to the buyer</label>
            <input id="q-refund" name="refund" inputMode="numeric" required defaultValue={live.paid.toLocaleString("en-IN")} />
          </div>
          <div className="ld-quote__acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPanel(null)} disabled={stepping}>
              Keep the booking
            </button>
            <button type="submit" className="btn btn--ink btn--sm" disabled={stepping}>
              {stepping ? "Cancelling" : `Cancel booking and free ${live.unitNo}`}
            </button>
          </div>
        </form>
      ) : panel === "part" && live ? (
        <form action={step} className="ld-quote__form">
          {hidden("send")}
          <div className="field ld-quote__wide">
            <label htmlFor="q-part">Amount for this link</label>
            <input id="q-part" name="amount" inputMode="numeric" required placeholder={`Up to ${inr(live.token - live.paid)}`} autoComplete="off" />
          </div>
          <div className="ld-quote__acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPanel(null)} disabled={stepping}>
              Cancel
            </button>
            <button type="submit" className="btn btn--ink btn--sm" disabled={stepping}>
              {stepping ? "Sending" : live.paid > 0 ? "Send link" : `Block ${live.unitNo} and send link`}
            </button>
          </div>
        </form>
      ) : panel === "refund" && live ? (
        <form action={step} className="ld-quote__form">
          {hidden("refunded")}
          <div className="field ld-quote__wide">
            <label htmlFor="q-rref">Cheque number or UTR of the refund</label>
            <input id="q-rref" name="reference" required autoComplete="off" placeholder="e.g. 004513" />
          </div>
          <div className="ld-quote__acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPanel(null)} disabled={stepping}>
              Cancel
            </button>
            <button type="submit" className="btn btn--ink btn--sm" disabled={stepping}>
              {stepping ? "Recording" : "Record refund paid"}
            </button>
          </div>
        </form>
      ) : live ? (
        <>
          <dl className="ld-quote__sum">
            <div>
              <dt>
                Flat {live.unitNo} · {live.unitLabel}
              </dt>
              <dd className="tnum">{inr(live.price)}</dd>
            </div>
            {live.extras.map((e) => (
              <div key={e.kind}>
                <dt>
                  {EXTRA[e.kind]}
                  {e.basis === "PSF" ? `, Rs ${e.rate.toLocaleString("en-IN")} a sq ft` : ""}
                </dt>
                <dd className="tnum">{inr(e.amount)}</dd>
              </div>
            ))}
            {inside.map((c) => (
              <div key={c.kind}>
                <dt>{CHARGE[c.kind]}</dt>
                <dd className="tnum">{inr(c.amount)}</dd>
              </div>
            ))}
            {(live.extras.length > 0 || inside.length > 0) && (
              <div>
                <dt>Agreement value</dt>
                <dd className="tnum">{inr(live.agreement)}</dd>
              </div>
            )}
            <div>
              <dt>GST {live.gstRate}%</dt>
              <dd className="tnum">{inr(live.gst)}</dd>
            </div>
            <div>
              <dt>
                Stamp duty {live.dutyRate}%{live.woman ? ", woman buying alone" : ""}
              </dt>
              <dd className="tnum">{inr(live.stampDuty)}</dd>
            </div>
            <div>
              <dt>Registration</dt>
              <dd className="tnum">{inr(live.registration)}</dd>
            </div>
            {outside.map((c) => (
              <div key={c.kind}>
                <dt>{CHARGE[c.kind]}, no GST or duty</dt>
                <dd className="tnum">{inr(c.amount)}</dd>
              </div>
            ))}
            <div className="ld-quote__total">
              <dt>All in</dt>
              <dd className="tnum">{inr(live.allIn)}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd className="tnum">{inr(live.token)}</dd>
            </div>
          </dl>
          <p className="ld-quote__foot">Duty is charged on the price or the ready reckoner value, whichever is higher.</p>
          {live.tds && <p className="ld-quote__foot">{live.tds}</p>}
          {linkOut && live.link?.url && (
            <p className="ld-quote__link">
              Held until <span className="tnum">{when(live.link.expiresAt)}</span>
              <button
                type="button"
                className="ws-link"
                onClick={() => {
                  navigator.clipboard?.writeText(live.link!.url!).then(() => setCopied(true), () => undefined);
                }}
              >
                {copied ? "Link copied" : "Copy link"}
              </button>
            </p>
          )}
          {live.parts.map((x, i) => (
            <p key={i} className="ld-quote__link">
              {inr(x.amount)} paid by {x.by === "RAZORPAY" ? "the link" : MODE[x.by]} on <span className="tnum">{day(x.on)}</span>
            </p>
          ))}
          {partly && live.heldUntil && (
            <p className="ld-quote__link">
              {inr(left)} still to come. Held until <span className="tnum">{when(live.heldUntil)}</span>
            </p>
          )}
          {cancelled && (
            <p className="ld-quote__link">
              {live.refund
                ? `${REFUND_STATE[live.refund.state]}: ${inr(live.refund.amount)} by ${MODE[live.refund.mode]}`
                : "Nothing was refunded."}
            </p>
          )}
          {live.approved && (
            <p className="ld-quote__link">
              <a className="ws-link" href={`/dashboard/leads/${leadId}/quote/${live.id}/pdf`} download>
                Download quote (PDF)
              </a>
            </p>
          )}
        </>
      ) : (
        <p className="ld-empty">
          {choices.units.length ? "No quote yet." : "No configuration here has an approved price yet."}
        </p>
      )}
    </section>
  );
}
