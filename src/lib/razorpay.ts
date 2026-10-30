import { createHmac, timingSafeEqual } from "node:crypto";
import { sellerFromEnv } from "./billing-rules.ts";
import type { MandateMethod } from "./auto-topup-rules.ts";
import { plansSellable } from "./plan-purchase-rules.ts";

/**
 * Razorpay, top-ups only: a plan is invoiced for bank transfer. A top-up is
 * bought through Checkout, or, when the client has saved a recurring
 * mandate and switched automatic top-ups on, charged to that mandate
 * (`auto-topup.ts`).
 *
 * Written to the published reference as of 28 September 2026:
 * - an order is `POST /v1/orders` with Basic auth `key_id:key_secret` and
 *   `{ amount (paise), currency, receipt (up to 40), notes (up to 15) }`
 *   (razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps);
 * - Checkout hands back `razorpay_payment_id`, `razorpay_order_id` and
 *   `razorpay_signature`, the hex HMAC-SHA256 of `order_id|payment_id` under
 *   the key secret;
 * - a webhook carries `X-Razorpay-Signature`, the hex HMAC-SHA256 of the raw
 *   body under the webhook secret, and `x-razorpay-event-id`, unique per
 *   event, because the same event may arrive more than once
 *   (razorpay.com/docs/webhooks/validate-test).
 *
 * Test mode is the gateway's own dev version: `rzp_test_` keys work before
 * KYC, move no money, and are refused on a production host. The payload
 * shapes are the same in both modes.
 *
 * `RAZORPAY_BASE_URL` points the driver at a fake for the checks and is
 * never set in production. An injected driver beats it.
 */

export type RazorpayConfig = { keyId: string; keySecret: string; webhookSecret: string | null; test: boolean };

export function razorpayConfig(env: Record<string, string | undefined> = process.env): { ok: true; config: RazorpayConfig } | { ok: false; missing: string[] } {
  const keyId = env.RAZORPAY_KEY_ID?.trim() ?? "";
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim() ?? "";
  const missing = [!keyId && "RAZORPAY_KEY_ID", !keySecret && "RAZORPAY_KEY_SECRET"].filter((m): m is string => !!m);
  if (missing.length) return { ok: false, missing };
  return { ok: true, config: { keyId, keySecret, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET?.trim() || null, test: keyId.startsWith("rzp_test_") } };
}

const productionHost = (env: Record<string, string | undefined>) => env.NODE_ENV === "production" || !!env.VERCEL;

/**
 * Whether a person may buy a top-up here. Live keys only for an
 * organisation that is charged for real; test keys only off a production
 * host, where they are the dev version and give nobody anything real.
 */
export function purchasingOpen(mode: "SHADOW" | "LIVE" | null, env: Record<string, string | undefined> = process.env): boolean {
  const c = razorpayConfig(env);
  if (!c.ok || !mode) return false;
  if (c.config.test) return !productionHost(env);
  // A real payment needs a real tax invoice, and that needs our GSTIN.
  return mode === "LIVE" && sellerFromEnv(env).ok;
}

/**
 * Whether a plan may be bought here. Unlike a top-up it needs no LIVE
 * organisation, because buying the first plan is what makes one: test keys
 * off a production host, live keys only with our GSTIN to invoice under.
 */
export function planPurchaseOpen(env: Record<string, string | undefined> = process.env): boolean {
  return plansSellable(env);
}

export type RazorpayOrder = { id: string; amount: number; currency: string; status: string };
export type RazorpayPayment = {
  id: string;
  orderId: string | null;
  status: string;
  amount: number;
  /** A recurring authorisation's token, and who it belongs to. */
  tokenId?: string | null;
  customerId?: string | null;
  /** What the payer gave Checkout, which a recurring charge must carry. */
  email?: string | null;
  contact?: string | null;
  method?: string | null;
  amountRefunded?: number;
};
export type { MandateMethod };
/** A token's state at the bank: an e-mandate is confirmed a day or two after it is authorised. */
export type TokenState = "confirmed" | "pending" | "rejected";
export type RazorpayRefund = { id: string; paymentId: string; amount: number; status: string; receipt: string | null; notes: Record<string, string> };

/** What a recurring charge carries: the saved mandate, opened only for the call. */
export type RecurringCharge = {
  orderId: string;
  amountPaise: number;
  customerId: string;
  token: string;
  email: string;
  contact: string;
  description: string;
  notes: Record<string, string>;
};

export type RazorpayDriver = {
  createOrder(c: RazorpayConfig, req: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<RazorpayOrder>;
  fetchPayment(c: RazorpayConfig, paymentId: string): Promise<RazorpayPayment>;
  /**
   * A subsequent payment on a saved recurring token
   * (razorpay.com/docs/api/payments/recurring-payments: `POST
   * /payments/create/recurring`, `recurring: "1"`, against an order made
   * for it). Answers with the payment's id; whether it was captured is read
   * with `fetchPayment()` or arrives by webhook.
   */
  createRecurringPayment(c: RazorpayConfig, req: RecurringCharge): Promise<{ paymentId: string }>;
  /** The payments made against an order (`GET /orders/:id/payments`), to look before charging again. */
  orderPayments(c: RazorpayConfig, orderId: string): Promise<RazorpayPayment[]>;
  /**
   * The customer a recurring mandate belongs to (`POST /customers`, with
   * `fail_existing: "0"`, so the same person asked twice is one customer).
   */
  createCustomer(c: RazorpayConfig, req: { name: string; email: string | null; notes: Record<string, string> }): Promise<{ id: string }>;
  /**
   * The order Checkout authorises a mandate against: the customer, the
   * method, and a `token` request carrying the most one charge may take
   * and when the mandate ends (razorpay.com/docs/api/payments/recurring-payments).
   */
  createMandateOrder(
    c: RazorpayConfig,
    req: { amountPaise: number; customerId: string; method: MandateMethod; maxAmountPaise: number; expireAt: number; receipt: string; notes: Record<string, string> },
  ): Promise<RazorpayOrder>;
  /** A saved token's state (`GET /customers/:id/tokens/:token_id`, its `recurring_details.status`). */
  fetchToken(c: RazorpayConfig, customerId: string, tokenId: string): Promise<{ id: string; state: TokenState }>;
  /** Money back to whoever paid (`POST /payments/:id/refund`), part or all of it. */
  createRefund(c: RazorpayConfig, paymentId: string, req: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<RazorpayRefund>;
  /** The refunds already made on a payment (`GET /payments/:id/refunds`), to look before refunding again. */
  paymentRefunds(c: RazorpayConfig, paymentId: string): Promise<RazorpayRefund[]>;
};

type RawPayment = {
  id: string;
  order_id: string | null;
  status: string;
  amount: number;
  token_id?: string | null;
  customer_id?: string | null;
  email?: string | null;
  contact?: string | null;
  method?: string | null;
  amount_refunded?: number;
};
const toPayment = (p: RawPayment): RazorpayPayment => ({
  id: p.id,
  orderId: p.order_id,
  status: p.status,
  amount: p.amount,
  tokenId: p.token_id ?? null,
  customerId: p.customer_id ?? null,
  email: p.email ?? null,
  contact: p.contact ?? null,
  method: p.method ?? null,
  amountRefunded: p.amount_refunded ?? 0,
});
type RawRefund = { id: string; payment_id: string; amount: number; status: string; receipt?: string | null; notes?: Record<string, string> | unknown[] };
const toRefund = (r: RawRefund): RazorpayRefund => ({
  id: r.id,
  paymentId: r.payment_id,
  amount: r.amount,
  status: r.status,
  receipt: r.receipt ?? null,
  // An entity with no notes carries an empty list, not an empty object.
  notes: r.notes && !Array.isArray(r.notes) ? r.notes : {},
});

/** A token's `recurring_details.status` in three words. */
export function tokenState(status: unknown): TokenState {
  const s = String(status ?? "").toLowerCase();
  if (s === "confirmed") return "confirmed";
  if (s === "rejected" || s === "cancelled" || s === "canceled" || s === "expired") return "rejected";
  return "pending";
}

const base = () => (process.env.RAZORPAY_BASE_URL || "https://api.razorpay.com/v1").replace(/\/+$/, "");
const auth = (c: RazorpayConfig) => `Basic ${Buffer.from(`${c.keyId}:${c.keySecret}`).toString("base64")}`;

async function call<T>(c: RazorpayConfig, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method: init.method,
    headers: { authorization: auth(c), "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    // Every call to somebody else's machine is timed.
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text.slice(0, 300);
    try {
      reason = (JSON.parse(text) as { error?: { description?: string } }).error?.description ?? reason;
    } catch {
      /* not JSON */
    }
    throw new Error(`Razorpay ${res.status}: ${reason}`);
  }
  return JSON.parse(text) as T;
}

const realDriver: RazorpayDriver = {
  async createOrder(c, req) {
    const o = await call<{ id: string; amount: number; currency: string; status: string }>(c, "/orders", {
      method: "POST",
      body: { amount: req.amountPaise, currency: "INR", receipt: req.receipt.slice(0, 40), notes: req.notes },
    });
    return { id: o.id, amount: o.amount, currency: o.currency, status: o.status };
  },
  async fetchPayment(c, paymentId) {
    return toPayment(await call<RawPayment>(c, `/payments/${encodeURIComponent(paymentId)}`, { method: "GET" }));
  },
  async createCustomer(c, req) {
    const r = await call<{ id: string }>(c, "/customers", {
      method: "POST",
      body: { name: req.name.slice(0, 50), ...(req.email ? { email: req.email } : {}), fail_existing: "0", notes: req.notes },
    });
    return { id: r.id };
  },
  async createMandateOrder(c, req) {
    const token =
      req.method === "EMANDATE"
        ? { max_amount: req.maxAmountPaise, expire_at: req.expireAt }
        : { max_amount: req.maxAmountPaise, expire_at: req.expireAt, frequency: "as_presented" };
    const o = await call<{ id: string; amount: number; currency: string; status: string }>(c, "/orders", {
      method: "POST",
      body: {
        amount: req.amountPaise,
        currency: "INR",
        customer_id: req.customerId,
        method: req.method === "EMANDATE" ? "emandate" : req.method === "UPI" ? "upi" : "card",
        payment_capture: true,
        token,
        receipt: req.receipt.slice(0, 40),
        notes: req.notes,
      },
    });
    return { id: o.id, amount: o.amount, currency: o.currency, status: o.status };
  },
  async fetchToken(c, customerId, tokenId) {
    const t = await call<{ id: string; recurring_details?: { status?: string } }>(c, `/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}`, { method: "GET" });
    return { id: t.id, state: tokenState(t.recurring_details?.status) };
  },
  async createRefund(c, paymentId, req) {
    return toRefund(await call<RawRefund>(c, `/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      body: { amount: req.amountPaise, speed: "normal", receipt: req.receipt.slice(0, 40), notes: req.notes },
    }));
  },
  async paymentRefunds(c, paymentId) {
    const r = await call<{ items?: RawRefund[] }>(c, `/payments/${encodeURIComponent(paymentId)}/refunds`, { method: "GET" });
    return (r.items ?? []).map(toRefund);
  },
  async createRecurringPayment(c, req) {
    const r = await call<{ razorpay_payment_id: string }>(c, "/payments/create/recurring", {
      method: "POST",
      body: {
        email: req.email,
        contact: req.contact,
        amount: req.amountPaise,
        currency: "INR",
        order_id: req.orderId,
        customer_id: req.customerId,
        token: req.token,
        recurring: "1",
        description: req.description.slice(0, 255),
        notes: req.notes,
      },
    });
    return { paymentId: r.razorpay_payment_id };
  },
  async orderPayments(c, orderId) {
    const r = await call<{ items?: RawPayment[] }>(c, `/orders/${encodeURIComponent(orderId)}/payments`, { method: "GET" });
    return (r.items ?? []).map(toPayment);
  },
};

let injected: RazorpayDriver | null = null;

/** For the checks: every request answered by `driver` in this process. */
export function useRazorpay(driver: RazorpayDriver): { restore(): void } {
  injected = driver;
  return { restore: () => void (injected = null) };
}

export const razorpay = (): RazorpayDriver => injected ?? realDriver;

const hmac = (key: string, message: string) => createHmac("sha256", key).update(message).digest("hex");

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What Checkout hands back is Razorpay's, not somebody's form. */
export function paymentSignatureOk(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  if (!orderId || !paymentId || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return same(hmac(keySecret, `${orderId}|${paymentId}`), signature);
}

/** A webhook body is Razorpay's only if its signature is the HMAC of these exact bytes. */
export function webhookSignatureOk(rawBody: string, signature: string | null, webhookSecret: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return same(hmac(webhookSecret, rawBody), signature);
}

export type PaymentEvent = { type: string; paymentId: string; orderId: string; amount: number; status: string };

/** The events a top-up's payment is settled on. An authorised payment is not money yet. */
export const PAYMENT_EVENTS: readonly string[] = ["payment.captured", "payment.failed", "order.paid"];
/** A mandate's authorisation is read on these, the authorised one included: that is what it waits for. */
export const MANDATE_EVENTS: readonly string[] = ["payment.authorized", "payment.captured", "payment.failed", "order.paid"];

/**
 * The payment in a webhook, or null for any event this product does not act
 * on. `payment.captured`, `payment.failed` and `order.paid` all carry the
 * payment entity at `payload.payment.entity`.
 */
export function readPaymentEvent(body: unknown, types: readonly string[] = PAYMENT_EVENTS): PaymentEvent | null {
  const b = body as { event?: unknown; payload?: { payment?: { entity?: Record<string, unknown> } } } | null;
  const type = typeof b?.event === "string" ? b.event : "";
  if (!types.includes(type)) return null;
  const e = b?.payload?.payment?.entity;
  if (!e || typeof e.id !== "string" || typeof e.order_id !== "string" || typeof e.amount !== "number") return null;
  return { type, paymentId: e.id, orderId: e.order_id, amount: e.amount, status: typeof e.status === "string" ? e.status : "" };
}
