"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { rupees, taxFor, type PlanKey } from "@/lib/billing-rules";
import { biggerPlans, planCards, firstPaymentLines, upgradeLines, type PlanScope } from "@/lib/plan-purchase-rules";
import { confirmPlanAction, startPlanAction } from "@/app/actions/plans";
import { ArrowUpRight } from "@/components/icons";
import { loadCheckout, type RazorpayResponse } from "../settings/billing/checkout";

export type PlanBuyContext = {
  today: string;
  earlierPlans: number;
  hadPilot: boolean;
  activeNow: number;
  test: boolean;
  open: boolean;
  buyerState: string | null;
  sellerState: string;
  /** Moving a channel partner's firm up from the plan it is on. */
  upgrade?: { from: PlanKey; fromPricePaise: number; prepaid: boolean; startsToday: boolean } | null;
};

/**
 * Choosing and paying for a plan. For a developer or a mandate firm it is
 * the new project's form: the project's three fields, the plan, and one
 * button that pays and creates it. For a channel partner it is the firm's
 * plan, bought once. The total is priced with the rules the server prices
 * the order with, GST as it will be on the invoice.
 */
export function PlanBuy({
  scope,
  entities,
  firm,
  firmName,
  ctx,
  canPay,
  states,
}: {
  scope: PlanScope;
  entities: { id: string; name: string }[];
  firm: boolean;
  firmName: string;
  ctx: PlanBuyContext;
  canPay: boolean;
  states: [string, string][];
}) {
  const router = useRouter();
  const moveUp = scope === "ORG" && ctx.upgrade ? ctx.upgrade : null;
  const [plan, setPlan] = useState<PlanKey>(moveUp ? biggerPlans(moveUp.from)[0] : "LAUNCH");
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [entityId, setEntityId] = useState(entities[0]?.id ?? "");
  const [state, setState] = useState("");
  const [busy, setBusy] = useState<"" | "starting" | "paying" | "confirming">("");
  const [error, setError] = useState<string | null>(null);

  const buyerState = ctx.buyerState ?? (state || null);
  const lines = useMemo(
    () =>
      moveUp
        ? upgradeLines({ from: moveUp.from, fromPricePaise: moveUp.fromPricePaise, to: plan, today: ctx.today, forName: firmName, prepaid: moveUp.prepaid })
        : firstPaymentLines({
        plan,
        scope,
        today: ctx.today,
        forName: scope === "ORG" ? firmName : name.trim() || "This project",
        earlierPlans: ctx.earlierPlans,
        hadPilot: ctx.hadPilot,
        activeAfter: ctx.activeNow + (scope === "PROJECT" ? 1 : 0),
      }),
    [plan, scope, ctx, firmName, name, moveUp],
  );
  const taxable = lines.reduce((s, l) => s + Math.round(l.qty * l.unitPaise), 0);
  const tax = buyerState ? taxFor(taxable, ctx.sellerState, buyerState) : null;
  const cards = moveUp ? planCards(scope).filter((c) => biggerPlans(moveUp.from).includes(c.key)) : planCards(scope);
  const monthly = cards.find((c) => c.key === plan)!.pricePaise;

  const missing =
    scope === "PROJECT" && (!name.trim() || !city.trim() || !entityId)
      ? "Fill in the project first."
      : !buyerState
        ? "Choose the state you are billed in."
        : null;
  const blocked = moveUp?.startsToday
    ? "Your plan began today. You can move to a bigger plan from tomorrow."
    : !ctx.open
    ? "Plans can't be bought here yet. Write to us and we'll set yours up."
    : !canPay
      ? "Ask someone who manages billing to buy the plan."
      : null;

  async function pay() {
    if (busy || blocked) return;
    if (missing) {
      setError(missing);
      return;
    }
    setError(null);
    setBusy("starting");
    const started = await startPlanAction({
      plan,
      ...(scope === "PROJECT" ? { name, city, entityId } : {}),
      ...(ctx.buyerState ? {} : { state }),
    });
    if (!started.ok) {
      setBusy("");
      setError(started.message);
      return;
    }
    try {
      await loadCheckout();
    } catch {
      setBusy("");
      setError("The payment window could not open. Check your connection and try again.");
      return;
    }
    const c = started.checkout;
    const rzp = new window.Razorpay!({
      key: c.key,
      order_id: c.orderId,
      amount: c.amountPaise,
      currency: "INR",
      name: "Sales Desk",
      description: c.description,
      prefill: { name: c.prefill.name, ...(c.prefill.email ? { email: c.prefill.email } : {}) },
      theme: { color: "#17181d" },
      handler: async (r: RazorpayResponse) => {
        setBusy("confirming");
        const done = await confirmPlanAction({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature });
        if (done.ok) {
          router.push(done.next);
          return;
        }
        setBusy("");
        setError(done.message);
      },
      modal: { ondismiss: () => setBusy((b) => (b === "confirming" ? b : "")) },
    });
    rzp.on("payment.failed", (r) => {
      setBusy("");
      setError(r.error?.description ? `The payment did not go through: ${r.error.description}` : "The payment did not go through.");
    });
    setBusy("paying");
    rzp.open();
  }

  const total = tax ? tax.total : taxable;
  const verb = scope === "PROJECT" ? "create project" : moveUp ? `move to ${cards.find((c) => c.key === plan)?.label ?? "the bigger plan"}` : "start plan";
  const label =
    busy === "starting"
      ? "Starting payment"
      : busy === "paying"
        ? "Waiting for payment"
        : busy === "confirming"
          ? scope === "PROJECT"
            ? "Creating your project"
            : "Starting your plan"
          : `Pay ${rupees(total, true)} and ${verb}`;

  return (
    <div className="planbuy">
      {scope === "PROJECT" && (
        <div className="planbuy__fields">
          <div className="field">
            <label htmlFor="pb-name">Project name</label>
            <input id="pb-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Trees" maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="pb-city">City</label>
            <input id="pb-city" type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Pune" maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="pb-entity">{firm ? "Developer" : "Registers under"}</label>
            <select id="pb-entity" className="select-field" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <fieldset className="planbuy__plans">
        <legend className="planbuy__legend">{scope === "PROJECT" ? "Plan for this project" : moveUp ? "Move your firm to" : "Plan for your firm"}</legend>
        {cards.map((c) => (
          <label key={c.key} className={`plancard${plan === c.key ? " is-on" : ""}`} data-plan={c.key}>
            <input type="radio" name="plan" value={c.key} checked={plan === c.key} onChange={() => setPlan(c.key)} />
            <span className="plancard__name">{c.label}</span>
            <span className="plancard__price tnum">
              {rupees(c.pricePaise)}
              <small> a month</small>
            </span>
            <span className="plancard__rows">
              <span>{c.minutes.toLocaleString("en-IN")} AI call minutes</span>
              <span>
                {c.posts} posts · {c.carousels} carousels · {c.videos} videos
              </span>
              <span>{c.channels} calls at once</span>
              {scope === "ORG" && <span>Up to {c.projects} projects</span>}
            </span>
          </label>
        ))}
      </fieldset>

      {!ctx.buyerState && (
        <div className="field planbuy__state">
          <label htmlFor="pb-state">State you are billed in</label>
          <select id="pb-state" className="select-field" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Choose</option>
            {states.map(([code, n]) => (
              <option key={code} value={code}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="planbuy__sum" aria-live="polite">
        <ul className="planbuy__lines">
          {lines.map((l) => (
            <li key={l.description}>
              <span>{l.description}</span>
              <span className="tnum">{rupees(Math.round(l.qty * l.unitPaise))}</span>
            </li>
          ))}
          <li className="planbuy__gst">
            <span>{tax ? (tax.interState ? "IGST at 18%" : "CGST and SGST at 9% each") : "GST at 18%"}</span>
            <span className="tnum">{tax ? rupees(tax.total - taxable, true) : "Once you choose a state"}</span>
          </li>
        </ul>
        <p className="planbuy__next">
          Then {rupees(monthly)} a month plus GST{ctx.test ? " · Test mode, no money moves" : ""}
        </p>
        <button type="button" className="btn btn--ink" onClick={pay} disabled={!!busy || !!blocked} data-plan-pay>
          {label}
          <ArrowUpRight size={14} />
        </button>
        {blocked && <p className="planbuy__why">{blocked}</p>}
        {error && (
          <p className="planbuy__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
