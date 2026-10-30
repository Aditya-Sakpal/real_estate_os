"use client";

/**
 * Razorpay's Checkout, shared by the Top up basket and an automatic top-up
 * waiting to be paid. Loaded the first time somebody pays and never before.
 */

export type RazorpayResponse = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };
type RazorpayInstance = { open(): void; on(event: string, fn: (r: { error?: { description?: string } }) => void): void };
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const CHECKOUT = "https://checkout.razorpay.com/v1/checkout.js";

export function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CHECKOUT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("checkout did not load"));
    document.body.appendChild(s);
  });
}
