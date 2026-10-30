import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { audit, withNoTenant, withTenant } from "./db/index.ts";
import {
  cartLines,
  draftInvoice,
  istDate,
  readCart,
  sellerFromEnv,
  skuByKey,
  testSeller,
  topUpExpiry,
  type CartLine,
  type WalletUnit,
} from "./billing-rules.ts";
import { buyerOf, issueInvoice } from "./invoice.ts";
import { settlePlanPayment, type PlanPaid } from "./plan-purchase.ts";
import { auditProject } from "./project-insert.ts";
import { paymentSignatureOk, purchasingOpen, razorpay, razorpayConfig, readPaymentEvent, webhookSignatureOk } from "./razorpay.ts";

/**
 * Buying a top-up: an order, Razorpay's checkout, and the settlement that
 * turns a captured payment into top-ups and a tax invoice.
 *
 * The settlement is one transaction and it is idempotent: the payment moves
 * to PAID once, the top-ups are one credit per unit per payment (a unique
 * index), and the invoice is one per payment (another). So Checkout's
 * handler and the webhook may both arrive, in either order, any number of
 * times, and the client is credited once.
 */

export type Checkout = {
  key: string;
  orderId: string;
  amountPaise: number;
  test: boolean;
  description: string;
  prefill: { name: string; email: string | null };
};

type Mode = "SHADOW" | "LIVE";

export type TopUpContext = {
  mode: Mode | null;
  /** A person may buy here now: keys set, and live keys only for a live organisation. */
  open: boolean;
  /** Razorpay's test mode: no money moves. */
  test: boolean;
  hasScale: boolean;
  /** The place of supply; null until billing details say it. */
  buyerState: string | null;
  sellerState: string;
};

/** What the top-up screen needs to price a basket the way the server will. */
export async function topUpContext(orgId: string): Promise<TopUpContext> {
  const cfg = razorpayConfig();
  const found = await withTenant(orgId, async (sql) => {
    const [acct] = await sql<{ mode: Mode }[]>`SELECT mode FROM billing_accounts WHERE org_id = ${orgId}`;
    const [scale] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM subscriptions
      WHERE org_id = ${orgId} AND plan = 'SCALE' AND starts_on <= current_date AND (ends_on IS NULL OR ends_on > current_date)`;
    return { mode: acct?.mode ?? null, hasScale: (scale?.n ?? 0) > 0, buyer: await buyerOf(sql, orgId) };
  });
  const test = cfg.ok && cfg.config.test;
  const real = sellerFromEnv(process.env);
  return {
    mode: found.mode,
    open: purchasingOpen(found.mode),
    test,
    hasScale: found.hasScale,
    buyerState: found.buyer?.state ?? null,
    sellerState: test || !real.ok ? testSeller(process.env).state : real.seller.state,
  };
}

export async function startTopUp(opts: {
  orgId: string;
  userId: string;
  userEmail?: string | null;
  cart: readonly { sku: string; qty: unknown }[];
  /** An automatic top-up waiting for the client to pay it: the payment is tied to it. */
  autoChargeId?: string;
}): Promise<{ ok: true; checkout: Checkout } | { ok: false; message: string }> {
  const cfg = razorpayConfig();
  const found = await withTenant(opts.orgId, async (sql) => {
    const [acct] = await sql<{ mode: Mode }[]>`SELECT mode FROM billing_accounts WHERE org_id = ${opts.orgId}`;
    const [scale] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM subscriptions
      WHERE org_id = ${opts.orgId} AND plan = 'SCALE' AND starts_on <= current_date AND (ends_on IS NULL OR ends_on > current_date)`;
    return { mode: acct?.mode ?? null, hasScale: (scale?.n ?? 0) > 0, buyer: await buyerOf(sql, opts.orgId) };
  });
  if (!cfg.ok || !purchasingOpen(found.mode)) return { ok: false, message: "Top-ups cannot be bought here yet. Ask us to add one." };
  const cart = readCart(opts.cart, found.hasScale);
  if (!cart.ok) return cart;
  if (!found.buyer) return { ok: false, message: "Add the state you are billed in, under Billing details, before buying a top-up." };
  const test = cfg.config.test;
  const real = sellerFromEnv(process.env);
  const seller = test ? testSeller(process.env) : real.ok ? real.seller : null;
  if (!seller) return { ok: false, message: "Top-ups cannot be bought here yet. Ask us to add one." };
  const draft = draftInvoice(cartLines(cart.lines), seller, found.buyer);

  let order;
  try {
    order = await razorpay().createOrder(cfg.config, {
      amountPaise: draft.totalPaise,
      receipt: `est_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      notes: { org: opts.orgId },
    });
  } catch (e) {
    console.error("billing: Razorpay refused the order", e);
    return { ok: false, message: "The payment could not be started. Try again in a minute." };
  }
  const items = cart.lines.map((l) => {
    const sku = skuByKey(l.sku)!;
    return { sku: sku.key, qty: l.qty, unit: sku.unit, units: sku.units * l.qty, pricePaise: sku.pricePaise * l.qty };
  });
  await withTenant(opts.orgId, async (sql) => {
    const [pay] = await sql<{ id: string }[]>`
      INSERT INTO payments (org_id, order_id, items, taxable_paise, tax_paise, total_paise, test, created_by)
      VALUES (${opts.orgId}, ${order.id}, ${sql.json(items)}, ${draft.taxablePaise}, ${draft.totalPaise - draft.taxablePaise},
              ${draft.totalPaise}, ${test}, ${opts.userId})
      RETURNING id`;
    if (opts.autoChargeId) {
      await sql`
        UPDATE auto_topup_charges SET order_id = ${order.id}, payment_id = ${pay.id}, updated_at = now()
        WHERE org_id = ${opts.orgId} AND id = ${opts.autoChargeId} AND status = 'AWAITING_APPROVAL'`;
    }
  });
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "billing.topup_started",
    targetType: "org",
    targetId: opts.orgId,
    metadata: { items: cart.lines, total_paise: draft.totalPaise, test },
  });
  return {
    ok: true,
    checkout: {
      key: cfg.config.keyId,
      orderId: order.id,
      amountPaise: draft.totalPaise,
      test,
      description: cart.lines.map((l) => `${l.qty > 1 ? `${l.qty} x ` : ""}${skuByKey(l.sku)!.label}`).join(", "),
      prefill: { name: found.buyer.name, email: opts.userEmail ?? null },
    },
  };
}

type PaymentRow = { id: string; status: "CREATED" | "PAID" | "FAILED"; items: { sku: string; qty: number; unit: WalletUnit; units: number; pricePaise: number }[]; total_paise: string; test: boolean; purpose: "TOPUP" | "PLAN" | "RENEWAL" };

export type Settled = { invoiceId: string; fresh: boolean; purpose: "TOPUP" | "PLAN" | "RENEWAL"; plan: PlanPaid | null; period?: string };

/**
 * Turn a captured payment into top-ups and an invoice, once. Returns the
 * invoice, or null when the payment is not this organisation's or failed.
 */
async function settle(sql: TransactionSql, orgId: string, orderId: string, paymentRef: string, actor: string | null): Promise<Settled | null> {
  const [p] = await sql<PaymentRow[]>`
    SELECT id, status, items, total_paise, test, purpose FROM payments WHERE org_id = ${orgId} AND order_id = ${orderId} FOR UPDATE`;
  if (!p) return null;
  if (p.status === "PAID") {
    const [inv] = await sql<{ id: string }[]>`SELECT id FROM invoices WHERE org_id = ${orgId} AND payment_id = ${p.id}`;
    return inv ? { invoiceId: inv.id, fresh: false, purpose: p.purpose, plan: null } : null;
  }
  if (p.status === "FAILED") return null;
  const now = new Date().toISOString();
  await sql`UPDATE payments SET status = 'PAID', payment_ref = ${paymentRef}, paid_at = ${now} WHERE id = ${p.id}`;
  // A plan: the project it was bought with, the plan itself and its invoice.
  if (p.purpose === "PLAN") {
    const done = await settlePlanPayment(sql, orgId, p.id, now, actor);
    return { invoiceId: done.invoiceId, fresh: true, purpose: "PLAN", plan: done.paid };
  }
  // A month's plan: the month is paid and its plan invoice issued.
  if (p.purpose === "RENEWAL") {
    const { settleRenewalPayment } = await import("./plan-renewal.ts");
    const done = await settleRenewalPayment(sql, orgId, p, now, actor);
    return { invoiceId: done.invoiceId, fresh: true, purpose: "RENEWAL", plan: null, period: done.period };
  }
  // One lot per unit per payment: a basket of 1,000 and 5,000 minutes is 6,000 minutes that expire together.
  const byUnit = new Map<WalletUnit, { units: number; price: number }>();
  for (const it of p.items) {
    const was = byUnit.get(it.unit) ?? { units: 0, price: 0 };
    byUnit.set(it.unit, { units: was.units + it.units, price: was.price + it.pricePaise });
  }
  for (const [unit, v] of byUnit) {
    await sql`
      INSERT INTO wallet_entries (org_id, kind, unit, qty, expires_at, source, payment_id, price_paise, test, created_by)
      VALUES (${orgId}, 'CREDIT', ${unit}, ${v.units}, ${topUpExpiry(now)}, 'PURCHASE', ${p.id}, ${v.price}, ${p.test}, ${actor})`;
  }
  // An automatic top-up this payment was for is paid, in the same transaction.
  await sql`
    UPDATE auto_topup_charges SET status = 'PAID', settled_at = ${now}, updated_at = now()
    WHERE org_id = ${orgId} AND payment_id = ${p.id} AND status IN ('CHARGING', 'AWAITING_APPROVAL')`;
  const buyer = await buyerOf(sql, orgId);
  if (!buyer) throw new Error("billing: a paid organisation has no billing state");
  const seller = p.test ? { seller: testSeller(process.env), bank: null } : (() => {
    const s = sellerFromEnv(process.env);
    if (!s.ok) throw new Error(`billing: seller not configured (${s.missing.join(", ")})`);
    return s;
  })();
  const lines = cartLines(p.items.map((i) => ({ sku: i.sku, qty: i.qty }) as CartLine));
  const inv = await issueInvoice(sql, {
    orgId,
    purpose: "TOPUP",
    test: p.test,
    lines,
    seller: seller.seller,
    bank: seller.bank,
    buyer,
    issuedOn: istDate(now),
    paymentId: p.id,
    createdBy: actor,
  });
  return { invoiceId: inv.id, fresh: true, purpose: "TOPUP", plan: null };
}

/** The audit row a fresh settlement carries: a top-up bought, or a plan. */
async function auditSettled(orgId: string, actor: string | null, done: Settled, via: string): Promise<void> {
  if (!done.fresh) return;
  if (done.purpose === "RENEWAL") {
    await audit({ orgId, actorUserId: actor, action: "billing.renewal_paid", targetType: "invoice", targetId: done.invoiceId, metadata: { via, period: done.period ?? null } });
    return;
  }
  if (done.purpose === "PLAN" && done.plan) {
    if (done.plan.inserted) await auditProject(orgId, done.plan.userId, done.plan.inserted, { via: "plan" });
    await audit({
      orgId,
      actorUserId: actor,
      action: "billing.plan_paid",
      targetType: "invoice",
      targetId: done.invoiceId,
      metadata: { via, plan: done.plan.plan, scope: done.plan.scope, project: done.plan.projectId },
    });
    return;
  }
  await audit({ orgId, actorUserId: actor, action: "billing.topup_paid", targetType: "invoice", targetId: done.invoiceId, metadata: { via } });
}

/**
 * A payment we read back from Razorpay ourselves (an automatic top-up's
 * recurring charge), captured and for exactly the amount ordered. Settled
 * the same way as Checkout's and the webhook's, so whichever arrives first
 * credits it and the others find it done.
 */
export async function settleCaptured(orgId: string, orderId: string, paymentRef: string): Promise<Settled | null> {
  const done = await withTenant(orgId, (sql) => settle(sql, orgId, orderId, paymentRef, null));
  if (done) await auditSettled(orgId, null, done, "auto_topup");
  return done;
}

/** Checkout's handler: the signature is Razorpay's, so the payment is settled now. */
export async function confirmTopUp(opts: { orgId: string; userId: string; orderId: string; paymentId: string; signature: string }): Promise<{ ok: true; invoiceId: string; plan: PlanPaid | null; purpose: Settled["purpose"] } | { ok: false; message: string }> {
  const cfg = razorpayConfig();
  if (!cfg.ok) return { ok: false, message: "Top-ups cannot be bought here yet." };
  if (!paymentSignatureOk(opts.orderId, opts.paymentId, opts.signature, cfg.config.keySecret)) {
    return { ok: false, message: "That payment could not be confirmed. If money left your account, it will be credited once Razorpay confirms it." };
  }
  const done = await withTenant(opts.orgId, (sql) => settle(sql, opts.orgId, opts.orderId, opts.paymentId, opts.userId));
  if (!done) return { ok: false, message: "That payment is not one of this organisation's." };
  await auditSettled(opts.orgId, opts.userId, done, "checkout");
  return { ok: true, invoiceId: done.invoiceId, plan: done.fresh ? done.plan : null, purpose: done.purpose };
}

/**
 * Razorpay's webhook. Proved by its signature, stored once per event id,
 * then acted on. A payment whose amount is not the amount ordered is
 * recorded and never credited.
 */
export async function ingestRazorpay(rawBody: string, signature: string | null, eventId: string | null): Promise<{ status: number; note: string; orgId?: string; plan?: PlanPaid | null }> {
  const cfg = razorpayConfig();
  if (!cfg.ok || !cfg.config.webhookSecret) return { status: 503, note: "not configured" };
  if (!webhookSignatureOk(rawBody, signature, cfg.config.webhookSecret)) return { status: 401, note: "bad signature" };
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, note: "not json" };
  }
  // An automatic payment being set up is its own order, never a top-up.
  const { ingestSetupEvent } = await import("./mandate-setup.ts");
  const setup = await ingestSetupEvent(body, eventId);
  if (setup) return setup;
  const ev = readPaymentEvent(body);
  if (!ev) return { status: 200, note: "ignored" };
  const orgId = await withNoTenant(async (sql) => {
    const [r] = await sql<{ org: string | null }[]>`SELECT payment_org(${ev.orderId}) AS org`;
    return r?.org ?? null;
  });
  if (!orgId) return { status: 200, note: "not ours" };
  const id = (eventId ?? "").trim().slice(0, 100) || `${ev.type}:${ev.paymentId}`;
  const out = await withTenant(orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO billing_events (org_id, event_id, type, payload)
      VALUES (${orgId}, ${id}, ${ev.type}, ${sql.json(body as never)})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id`;
    if (!row) return { note: "duplicate", done: null as Settled | null };
    const [p] = await sql<{ total_paise: string; status: string }[]>`
      SELECT total_paise, status FROM payments WHERE org_id = ${orgId} AND order_id = ${ev.orderId}`;
    let note = "recorded";
    let settled: Settled | null = null;
    if (ev.type === "payment.failed") {
      if (p?.status === "CREATED") await sql`UPDATE payments SET status = 'FAILED', payment_ref = ${ev.paymentId} WHERE org_id = ${orgId} AND order_id = ${ev.orderId}`;
      await sql`
        UPDATE auto_topup_charges SET status = 'FAILED', note = 'DECLINED', updated_at = now()
        WHERE org_id = ${orgId} AND order_id = ${ev.orderId} AND status = 'CHARGING'`;
      note = "failed";
    } else if (p && Number(p.total_paise) !== ev.amount) {
      note = "amount mismatch";
      console.error(`billing: order ${ev.orderId} was paid ${ev.amount} paise against ${p.total_paise}; not credited`);
    } else {
      settled = await settle(sql, orgId, ev.orderId, ev.paymentId, null);
      note = settled ? "settled" : "not settled";
    }
    await sql`UPDATE billing_events SET processed_at = now() WHERE id = ${row.id}`;
    return { note, done: settled };
  });
  if (out.done) await auditSettled(orgId, null, out.done, "webhook");
  return { status: 200, note: out.note, orgId, plan: out.done?.fresh ? out.done.plan : null };
}
