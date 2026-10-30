"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmMandateSetupAction, startMandateSetupAction } from "@/app/actions/billing";
import { MANDATE_METHODS, MANDATE_METHOD_WORDS, type MandateMethod } from "@/lib/auto-topup-rules";
import { ArrowUpRight } from "@/components/icons";
import { loadCheckout, type RazorpayResponse } from "../checkout";

/**
 * Setting up automatic payment: the client picks how, and Razorpay's
 * Checkout authorises a mandate for at most the monthly limit. Nothing is
 * bought here; a card or UPI is authorised with a rupee.
 */
export function MandateSetup({ label }: { label: string }) {
  const router = useRouter();
  const [method, setMethod] = useState<MandateMethod>("EMANDATE");
  const [busy, setBusy] = useState<"" | "starting" | "paying" | "confirming">("");
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (busy) return;
    setError(null);
    setBusy("starting");
    const started = await startMandateSetupAction(method);
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
      customer_id: c.customerId,
      recurring: "1",
      amount: c.amountPaise,
      currency: "INR",
      name: "Sales Desk",
      description: c.description,
      prefill: { name: c.prefill.name, ...(c.prefill.email ? { email: c.prefill.email } : {}) },
      theme: { color: "#17181d" },
      handler: async (r: RazorpayResponse) => {
        setBusy("confirming");
        const done = await confirmMandateSetupAction({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature });
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
      setError(r.error?.description ? `It did not go through: ${r.error.description}` : "It did not go through.");
    });
    setBusy("paying");
    rzp.open();
  }

  return (
    <div className="auto-mandate" data-mandate-setup>
      <div className="field">
        <label htmlFor="mandate-method">Pay with</label>
        <select id="mandate-method" className="select-field" value={method} onChange={(e) => setMethod(e.target.value as MandateMethod)} disabled={!!busy}>
          {MANDATE_METHODS.map((m) => (
            <option key={m} value={m}>
              {MANDATE_METHOD_WORDS[m]}
            </option>
          ))}
        </select>
      </div>
      <button type="button" className="btn btn--ink btn--sm" onClick={start} disabled={!!busy} data-mandate-start>
        {busy === "starting" ? "Starting" : busy === "paying" ? "Waiting for Razorpay" : busy === "confirming" ? "Saving" : label}
        <ArrowUpRight size={13} />
      </button>
      {error && (
        <p className="auto-pay__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
