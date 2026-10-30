"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_SKU_QTY, rupees, taxFor, type Sku, type SkuKey } from "@/lib/billing-rules";
import { confirmTopUpAction, startTopUpAction } from "@/app/actions/billing";
import { Minus, Plus } from "@/components/icons";
import { loadCheckout, type RazorpayResponse } from "../checkout";

/**
 * The basket. Minute packs and WhatsApp credit are chosen one at a time;
 * posts and videos are counted. The total is worked out with the same rules
 * the server prices the order with, GST shown as it will be on the invoice.
 */
export function TopUpForm({ skus, test, interState }: { skus: Sku[]; test: boolean; interState: boolean }) {
  const router = useRouter();
  const packs = skus.filter((s) => s.unit === "MINUTE" && !s.bankTransfer);
  const byBank = skus.filter((s) => s.bankTransfer);
  const counted = skus.filter((s) => s.countable);
  const credit = skus.filter((s) => s.unit === "WHATSAPP");
  const [pack, setPack] = useState<SkuKey | "">("");
  const [whatsapp, setWhatsapp] = useState<SkuKey | "">("");
  const [counts, setCounts] = useState<Partial<Record<SkuKey, number>>>({});
  const [busy, setBusy] = useState<"" | "starting" | "paying" | "confirming">("");
  const [error, setError] = useState<string | null>(null);

  const cart = useMemo(() => {
    const lines: { sku: Sku; qty: number }[] = [];
    const p = skus.find((s) => s.key === pack);
    if (p) lines.push({ sku: p, qty: 1 });
    for (const s of counted) if ((counts[s.key] ?? 0) > 0) lines.push({ sku: s, qty: counts[s.key]! });
    const w = skus.find((s) => s.key === whatsapp);
    if (w) lines.push({ sku: w, qty: 1 });
    return lines;
  }, [skus, counted, counts, pack, whatsapp]);

  const taxable = cart.reduce((s, l) => s + l.sku.pricePaise * l.qty, 0);
  const tax = taxFor(taxable, "00", interState ? "01" : "00");

  const setCount = (key: SkuKey, n: number) => setCounts((c) => ({ ...c, [key]: Math.max(0, Math.min(MAX_SKU_QTY, Math.floor(Number.isFinite(n) ? n : 0))) }));

  async function pay() {
    if (!cart.length || busy) return;
    setError(null);
    setBusy("starting");
    const started = await startTopUpAction(cart.map((l) => ({ sku: l.sku.key, qty: l.qty })));
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
        const done = await confirmTopUpAction({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature });
        if (done.ok) {
          router.push(done.next);
          return;
        }
        setBusy("");
        setError(done.message);
      },
      modal: {
        ondismiss: () => {
          setBusy((b) => (b === "confirming" ? b : ""));
        },
      },
    });
    rzp.on("payment.failed", (r) => {
      setBusy("");
      setError(r.error?.description ? `The payment did not go through: ${r.error.description}` : "The payment did not go through.");
    });
    setBusy("paying");
    rzp.open();
  }

  const label =
    busy === "starting" ? "Starting payment" : busy === "paying" ? "Waiting for payment" : busy === "confirming" ? "Adding your top-up" : `Pay ${rupees(tax.total, true)}`;

  return (
    <div className="topup">
      <div className="topup__items">
        {packs.length > 0 && (
          <fieldset className="card topup__group">
            <legend className="topup__legend">AI call minutes</legend>
            <div className="topup__choices">
              {packs.map((s) => (
                <label key={s.key} className={`topup__choice${pack === s.key ? " is-on" : ""}`} data-sku={s.key}>
                  <input type="radio" name="pack" value={s.key} checked={pack === s.key} onChange={() => setPack(s.key)} onClick={() => pack === s.key && setPack("")} />
                  <span className="topup__choice-name">{s.units.toLocaleString("en-IN")} minutes</span>
                  <span className="topup__choice-price tnum">{rupees(s.pricePaise)}</span>
                  <span className="topup__choice-each tnum">Rs {(s.pricePaise / 100 / s.units).toLocaleString("en-IN", { maximumFractionDigits: 2 })} a minute</span>
                </label>
              ))}
            </div>
            {byBank.length > 0 && (
              <p className="topup__bank">
                {byBank.map((s) => `${s.units.toLocaleString("en-IN")} minutes for ${rupees(s.pricePaise)}`).join(" and ")}: by bank transfer. Ask us and we invoice it.
              </p>
            )}
          </fieldset>
        )}

        <fieldset className="card topup__group">
          <legend className="topup__legend">Posts and videos</legend>
          <ul className="topup__rows">
            {counted.map((s) => {
              const n = counts[s.key] ?? 0;
              return (
                <li key={s.key} className={`topup__row${n > 0 ? " is-on" : ""}`} data-sku={s.key}>
                  <label htmlFor={`qty-${s.key}`} className="topup__row-name">
                    {s.label}
                    <span className="topup__row-price tnum">{rupees(s.pricePaise)} each</span>
                  </label>
                  <div className="topup__step">
                    <button type="button" className="btn btn--icon" aria-label={`One fewer ${s.label.toLowerCase()}`} disabled={n === 0} onClick={() => setCount(s.key, n - 1)}>
                      <Minus size={15} />
                    </button>
                    <input
                      id={`qty-${s.key}`}
                      className="topup__qty tnum"
                      type="text"
                      inputMode="numeric"
                      value={n}
                      onChange={(e) => setCount(s.key, Number(e.target.value.replace(/\D/g, "")))}
                      aria-label={`How many: ${s.label}`}
                    />
                    <button type="button" className="btn btn--icon" aria-label={`One more ${s.label.toLowerCase()}`} disabled={n >= MAX_SKU_QTY} onClick={() => setCount(s.key, n + 1)}>
                      <Plus size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>

        {credit.length > 0 && (
          <fieldset className="card topup__group">
            <legend className="topup__legend">WhatsApp credit</legend>
            <div className="topup__choices">
              {credit.map((s) => (
                <label key={s.key} className={`topup__choice${whatsapp === s.key ? " is-on" : ""}`} data-sku={s.key}>
                  <input type="radio" name="whatsapp" value={s.key} checked={whatsapp === s.key} onChange={() => setWhatsapp(s.key)} onClick={() => whatsapp === s.key && setWhatsapp("")} />
                  <span className="topup__choice-name">{rupees(s.units)}</span>
                  <span className="topup__choice-each">Meta&rsquo;s price plus 15%, a message at a time</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      <aside className="topup__sum" aria-live="polite" data-topup-summary>
        <div className="topup__sum-head">
          <h2>Your top-up</h2>
          {test && <span className="topup__test">Test mode</span>}
        </div>
        {cart.length === 0 ? (
          <p className="topup__sum-none">Choose what to add.</p>
        ) : (
          <ul className="topup__lines">
            {cart.map((l) => (
              <li key={l.sku.key}>
                <span>
                  {l.qty > 1 ? `${l.qty} x ` : ""}
                  {l.sku.label}
                </span>
                <span className="tnum">{rupees(l.sku.pricePaise * l.qty)}</span>
              </li>
            ))}
          </ul>
        )}
        <dl className="topup__totals">
          <div>
            <dt>Before GST</dt>
            <dd className="tnum">{rupees(taxable, true)}</dd>
          </div>
          {interState ? (
            <div>
              <dt>IGST at 18%</dt>
              <dd className="tnum">{rupees(tax.igst, true)}</dd>
            </div>
          ) : (
            <>
              <div>
                <dt>CGST at 9%</dt>
                <dd className="tnum">{rupees(tax.cgst, true)}</dd>
              </div>
              <div>
                <dt>SGST at 9%</dt>
                <dd className="tnum">{rupees(tax.sgst, true)}</dd>
              </div>
            </>
          )}
          <div className="topup__total">
            <dt>Total</dt>
            <dd className="tnum">{rupees(tax.total, true)}</dd>
          </div>
        </dl>
        {error && (
          <p className="topup__error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn btn--light topup__pay" disabled={!cart.length || !!busy} aria-disabled={!cart.length || !!busy} onClick={pay} data-pay>
          {label}
        </button>
        <p className="topup__fine">{test ? "Test mode: no money moves, and the invoice is marked as a test." : "Good for twelve months. A tax invoice follows the payment."}</p>
      </aside>
    </div>
  );
}
