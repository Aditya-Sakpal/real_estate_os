"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { approveAutoChargeAction, confirmTopUpAction, type StartResult } from "@/app/actions/billing";
import { ArrowUpRight } from "@/components/icons";
import { loadCheckout, type RazorpayResponse } from "../checkout";

/**
 * Paying something that waits for the client (an automatic top-up, a month's
 * plan): the same Checkout a basket is paid through, for exactly that.
 */
export function PayCharge({
  chargeId,
  label,
  start = approveAutoChargeAction,
  className = "btn btn--light btn--sm",
}: {
  chargeId: string;
  label: string;
  /** Starts the payment; an automatic top-up's by default. */
  start?: (id: string) => Promise<StartResult>;
  /** On a light card the button is ink; on the near-black one, light. */
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"" | "starting" | "paying" | "confirming">("");
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    if (busy) return;
    setError(null);
    setBusy("starting");
    const started = await start(chargeId);
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
      modal: { ondismiss: () => setBusy((b) => (b === "confirming" ? b : "")) },
    });
    rzp.on("payment.failed", (r) => {
      setBusy("");
      setError(r.error?.description ? `The payment did not go through: ${r.error.description}` : "The payment did not go through.");
    });
    setBusy("paying");
    rzp.open();
  }

  return (
    <div className="auto-pay">
      <button type="button" className={className} onClick={pay} disabled={!!busy} data-pay-charge={chargeId}>
        {busy === "starting" ? "Starting payment" : busy === "paying" ? "Waiting for payment" : busy === "confirming" ? "Confirming payment" : label}
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
