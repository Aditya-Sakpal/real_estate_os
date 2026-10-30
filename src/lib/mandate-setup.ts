import { randomUUID } from "node:crypto";
import { audit, withNoTenant, withTenant } from "./db/index.ts";
import {
  MANDATE_METHOD_WORDS,
  mandateAuthPaise,
  mandateExpireAt,
  mandateSetupRefusal,
  readMandateMethod,
  setupDue,
  setupOutcome,
  type MandateMethod,
} from "./auto-topup-rules.ts";
import { buyerOf } from "./invoice.ts";
import { mandatePurpose, type MandateSecret } from "./auto-topup.ts";
import { MANDATE_EVENTS, paymentSignatureOk, purchasingOpen, razorpay, razorpayConfig, readPaymentEvent, type TokenState } from "./razorpay.ts";
import { seal } from "./vault.ts";

/**
 * The client sets up its own recurring mandate, on Settings, Plan and
 * usage, Auto top-up. The rules are `auto-topup-rules.ts`; the gateway is
 * `razorpay.ts`.
 *
 * Start: a customer at Razorpay and an order carrying the token request,
 * capped at the monthly limit, recorded as a `billing_mandate_setups` row
 * before Checkout opens. Finish: Checkout's handler, the webhook or the
 * billing sweep, whichever comes first, reads the payment and its token
 * back from Razorpay and, once the token is confirmed, seals it and saves
 * the mandate in the same row the operator's script writes, replacing any
 * mandate before it, in one transaction. Idempotent: a finished set-up is
 * never finished twice, and the database refuses a second mandate from one
 * set-up (0077).
 */

type Mode = "SHADOW" | "LIVE";

export type MandateCheckout = {
  key: string;
  orderId: string;
  customerId: string;
  amountPaise: number;
  method: MandateMethod;
  test: boolean;
  description: string;
  prefill: { name: string; email: string | null };
};

export type SetupState = {
  /** Why a set-up cannot start now, or null when it can. */
  refusal: string | null;
  /** A set-up waiting on the bank. */
  waiting: { method: MandateMethod } | null;
};

type SetupRow = {
  id: string;
  order_id: string;
  customer_id: string;
  method: MandateMethod;
  max_amount_paise: string;
  auth_paise: string;
  test: boolean;
  status: "CREATED" | "AUTHORISED" | "CONFIRMED" | "FAILED" | "EXPIRED";
  payment_ref: string | null;
  mandate_id: string | null;
  created_by: string | null;
  created_at: Date;
};

async function contextOf(orgId: string) {
  return withTenant(orgId, async (sql) => {
    const [[acct], buyer, [open]] = await Promise.all([
      sql<{ mode: Mode; auto_topup_ceiling_paise: string | null }[]>`
        SELECT mode, auto_topup_ceiling_paise FROM billing_accounts WHERE org_id = ${orgId}`,
      buyerOf(sql, orgId),
      sql<{ status: "CREATED" | "AUTHORISED"; method: MandateMethod }[]>`
        SELECT status, method FROM billing_mandate_setups WHERE org_id = ${orgId} AND status IN ('CREATED', 'AUTHORISED')`,
    ]);
    return {
      mode: acct?.mode ?? null,
      ceilingPaise: acct?.auto_topup_ceiling_paise ? Number(acct.auto_topup_ceiling_paise) : null,
      buyer,
      open: open ?? null,
    };
  });
}

/** Whether the screen offers "Set up automatic payment", and why not. */
export async function mandateSetupState(orgId: string): Promise<SetupState> {
  const c = await contextOf(orgId);
  return {
    refusal: mandateSetupRefusal({ mode: c.mode, open: purchasingOpen(c.mode), buyerState: c.buyer?.state ?? null, ceilingPaise: c.ceilingPaise, waiting: c.open?.status ?? null }),
    waiting: c.open?.status === "AUTHORISED" ? { method: c.open.method } : null,
  };
}

/**
 * Start a set-up: every refusal before Razorpay is asked, then the customer,
 * then the order, then the row, then Checkout's parameters.
 */
export async function startMandateSetup(opts: {
  orgId: string;
  userId: string;
  userEmail?: string | null;
  method: unknown;
  nowIso?: string;
}): Promise<{ ok: true; checkout: MandateCheckout } | { ok: false; message: string }> {
  const method = readMandateMethod(opts.method);
  if (!method) return { ok: false, message: "Choose how to pay: a card, UPI AutoPay or a bank e-mandate." };
  const cfg = razorpayConfig();
  const c = await contextOf(opts.orgId);
  const refusal = mandateSetupRefusal({ mode: c.mode, open: cfg.ok && purchasingOpen(c.mode), buyerState: c.buyer?.state ?? null, ceilingPaise: c.ceilingPaise, waiting: c.open?.status ?? null });
  if (refusal || !cfg.ok || !c.buyer || !c.ceilingPaise) return { ok: false, message: refusal ?? "Automatic payment cannot be set up here yet." };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const amountPaise = mandateAuthPaise(method);
  let customerId: string;
  let orderId: string;
  try {
    const customer = await razorpay().createCustomer(cfg.config, { name: c.buyer.name, email: opts.userEmail ?? null, notes: { org: opts.orgId } });
    customerId = customer.id;
    const order = await razorpay().createMandateOrder(cfg.config, {
      amountPaise,
      customerId,
      method,
      maxAmountPaise: c.ceilingPaise,
      expireAt: mandateExpireAt(nowIso),
      receipt: `mdt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      notes: { org: opts.orgId, mandate: "setup" },
    });
    orderId = order.id;
  } catch (e) {
    console.error("billing: Razorpay refused the mandate set-up", e);
    return { ok: false, message: "Automatic payment could not be started. Try again in a minute." };
  }
  const saved = await withTenant(opts.orgId, async (sql) => {
    // A set-up somebody opened and never finished is replaced by this one.
    await sql`
      UPDATE billing_mandate_setups SET status = 'EXPIRED', note = 'REPLACED', updated_at = now()
      WHERE org_id = ${opts.orgId} AND status = 'CREATED'`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO billing_mandate_setups (org_id, order_id, customer_id, method, max_amount_paise, auth_paise, expire_at, test, created_by)
      VALUES (${opts.orgId}, ${orderId}, ${customerId}, ${method}, ${c.ceilingPaise}, ${amountPaise},
              to_timestamp(${mandateExpireAt(nowIso)}), ${cfg.config.test}, ${opts.userId})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    return row ?? null;
  });
  if (!saved) return { ok: false, message: "Your bank has not confirmed the last one yet." };
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "billing.mandate_setup_started",
    targetType: "mandate_setup",
    targetId: saved.id,
    metadata: { method, max_paise: c.ceilingPaise, test: cfg.config.test },
  });
  return {
    ok: true,
    checkout: {
      key: cfg.config.keyId,
      orderId,
      customerId,
      amountPaise,
      method,
      test: cfg.config.test,
      description: `Automatic payment for top-ups, up to Rs ${(c.ceilingPaise / 100).toLocaleString("en-IN")} a time`,
      prefill: { name: c.buyer.name, email: opts.userEmail ?? null },
    },
  };
}

export type SetupResult = { status: "CONFIRMED" | "AUTHORISED" | "CREATED" | "FAILED" | "EXPIRED"; note?: string; mandateId?: string };

/**
 * Finish a set-up from what Razorpay says about it now. Called by Checkout's
 * handler, the webhook and the sweep; whichever sees the confirmed token
 * first saves the mandate, and the others find it saved.
 */
export async function completeSetup(orgId: string, orderId: string, paymentRef: string | null, actor: string | null): Promise<SetupResult | null> {
  const cfg = razorpayConfig();
  const [s] = await withTenant(orgId, (sql) => sql<SetupRow[]>`SELECT * FROM billing_mandate_setups WHERE org_id = ${orgId} AND order_id = ${orderId}`);
  if (!s) return null;
  if (s.status === "CONFIRMED") return { status: "CONFIRMED", mandateId: s.mandate_id ?? undefined };
  if (s.status === "FAILED" || s.status === "EXPIRED") return { status: s.status };
  if (!cfg.ok || cfg.config.test !== s.test) return { status: s.status, note: "GATEWAY" };
  const drv = razorpay();
  const authPaise = Number(s.auth_paise);

  // The payment: the one named, the one recorded, or the one Razorpay holds against the order.
  let payment = null as Awaited<ReturnType<typeof drv.fetchPayment>> | null;
  try {
    const ref = paymentRef ?? s.payment_ref;
    if (ref) payment = await drv.fetchPayment(cfg.config, ref);
    else {
      const seen = await drv.orderPayments(cfg.config, s.order_id);
      const good = seen.find((p) => p.status === "authorized" || p.status === "captured") ?? seen.find((p) => p.status === "failed");
      payment = good ? await drv.fetchPayment(cfg.config, good.id) : null;
    }
  } catch (e) {
    console.error(`billing: mandate set-up ${s.id} could not be read back`, e);
    return { status: s.status, note: "NO_ANSWER" };
  }
  let token: TokenState | null = null;
  if (payment?.tokenId && (payment.status === "authorized" || payment.status === "captured")) {
    token = await drv.fetchToken(cfg.config, payment.customerId ?? s.customer_id, payment.tokenId).then((t) => t.state).catch(() => null);
  }
  const out = setupOutcome(
    payment ? { orderId: payment.orderId, status: payment.status, amount: payment.amount, tokenId: payment.tokenId ?? null, email: payment.email ?? null, contact: payment.contact ?? null } : null,
    { orderId: s.order_id, authPaise },
    token,
  );
  if (out.kind === "not_yet") return { status: s.status };
  if (out.kind === "fail") {
    await withTenant(orgId, (sql) => sql`
      UPDATE billing_mandate_setups SET status = 'FAILED', note = ${out.note}, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${s.id} AND status IN ('CREATED', 'AUTHORISED')`);
    await audit({ orgId, actorUserId: actor, action: "billing.mandate_setup_failed", targetType: "mandate_setup", targetId: s.id, metadata: { note: out.note } });
    return { status: "FAILED", note: out.note };
  }
  if (out.kind === "wait") {
    if (s.status === "CREATED") {
      await withTenant(orgId, (sql) => sql`
        UPDATE billing_mandate_setups SET status = 'AUTHORISED', payment_ref = ${payment!.id}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${s.id} AND status = 'CREATED'`);
    }
    return { status: "AUTHORISED" };
  }

  // Confirmed: sealed first, then saved with the set-up marked, in one transaction.
  const mandateId = randomUUID();
  const secret: MandateSecret = { customerId: payment!.customerId ?? s.customer_id, token: payment!.tokenId!, email: payment!.email!, contact: payment!.contact! };
  const sealed = await seal(orgId, mandatePurpose(mandateId), JSON.stringify(secret));
  if (!sealed) return { status: s.status, note: "NO_KEY" };
  const saved = await withTenant(orgId, async (sql) => {
    const [cur] = await sql<{ status: string }[]>`SELECT status FROM billing_mandate_setups WHERE org_id = ${orgId} AND id = ${s.id} FOR UPDATE`;
    if (!cur || (cur.status !== "CREATED" && cur.status !== "AUTHORISED")) return false;
    await sql`UPDATE billing_mandates SET status = 'REVOKED', revoked_at = now() WHERE org_id = ${orgId} AND status = 'ACTIVE'`;
    await sql`
      INSERT INTO billing_mandates (id, org_id, method, label, secret, key_version, max_amount_paise, test, setup_id)
      VALUES (${mandateId}, ${orgId}, ${s.method}, ${MANDATE_METHOD_WORDS[s.method]}, ${sealed.secret}, ${sealed.keyVersion},
              ${Number(s.max_amount_paise)}, ${s.test}, ${s.id})`;
    await sql`
      UPDATE billing_mandate_setups SET status = 'CONFIRMED', payment_ref = ${payment!.id}, mandate_id = ${mandateId},
             confirmed_at = now(), updated_at = now()
      WHERE org_id = ${orgId} AND id = ${s.id}`;
    return true;
  });
  if (!saved) {
    const [again] = await withTenant(orgId, (sql) => sql<SetupRow[]>`SELECT * FROM billing_mandate_setups WHERE org_id = ${orgId} AND id = ${s.id}`);
    return { status: again?.status ?? s.status, mandateId: again?.mandate_id ?? undefined };
  }
  await audit({
    orgId,
    actorUserId: actor ?? s.created_by,
    action: "billing.mandate_saved",
    targetType: "mandate",
    targetId: mandateId,
    metadata: { method: s.method, max_paise: Number(s.max_amount_paise), test: s.test, via: "client" },
  });
  return { status: "CONFIRMED", mandateId };
}

/** Checkout's handler: the signature is Razorpay's, so the set-up is finished now if it can be. */
export async function confirmMandateSetup(opts: {
  orgId: string;
  userId: string;
  orderId: string;
  paymentId: string;
  signature: string;
}): Promise<{ ok: true; status: SetupResult["status"] } | { ok: false; message: string }> {
  const cfg = razorpayConfig();
  if (!cfg.ok) return { ok: false, message: "Automatic payment cannot be set up here yet." };
  if (!paymentSignatureOk(opts.orderId, opts.paymentId, opts.signature, cfg.config.keySecret)) {
    return { ok: false, message: "That authorisation could not be confirmed. If it went through, it will show here once Razorpay confirms it." };
  }
  const done = await completeSetup(opts.orgId, opts.orderId, opts.paymentId, opts.userId);
  if (!done) return { ok: false, message: "That authorisation is not one of this organisation's." };
  if (done.status === "FAILED") return { ok: false, message: "The authorisation did not go through. Try again, or choose another way to pay." };
  return { ok: true, status: done.status };
}

/** Stop using the saved mandate. Nothing waiting on it is charged. */
export async function stopMandate(opts: { orgId: string; userId: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await withTenant(opts.orgId, async (sql) => {
    const rows = await sql<{ id: string }[]>`
      UPDATE billing_mandates SET status = 'REVOKED', revoked_at = now() WHERE org_id = ${opts.orgId} AND status = 'ACTIVE' RETURNING id`;
    if (rows.length) {
      await sql`
        UPDATE auto_topup_charges SET status = 'CANCELLED', note = 'NO_MANDATE', updated_at = now()
        WHERE org_id = ${opts.orgId} AND status = 'NOTIFIED'`;
    }
    return rows[0] ?? null;
  });
  if (!r) return { ok: false, message: "There is no automatic payment to stop." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "billing.mandate_revoked", targetType: "mandate", targetId: r.id, metadata: { via: "client" } });
  return { ok: true };
}

/**
 * A webhook for a set-up's order. Returns null when the order is not a
 * set-up, so the top-up path can have it. Stored once per event id.
 */
export async function ingestSetupEvent(body: unknown, eventId: string | null): Promise<{ status: number; note: string } | null> {
  const ev = readPaymentEvent(body, MANDATE_EVENTS);
  if (!ev) return null;
  const orgId = await withNoTenant(async (sql) => {
    const [r] = await sql<{ org: string | null }[]>`SELECT mandate_setup_org(${ev.orderId}) AS org`;
    return r?.org ?? null;
  });
  if (!orgId) return null;
  const id = (eventId ?? "").trim().slice(0, 100) || `${ev.type}:${ev.paymentId}`;
  const fresh = await withTenant(orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO billing_events (org_id, event_id, type, payload)
      VALUES (${orgId}, ${id}, ${ev.type}, ${sql.json(body as never)})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id`;
    return row ?? null;
  });
  if (!fresh) return { status: 200, note: "duplicate" };
  const done = await completeSetup(orgId, ev.orderId, ev.paymentId, null);
  await withTenant(orgId, (sql) => sql`UPDATE billing_events SET processed_at = now() WHERE id = ${fresh.id}`);
  return { status: 200, note: `mandate ${done?.status.toLowerCase() ?? "unknown"}` };
}

/** The billing sweep's step: a set-up nobody finished is let go, one waiting on the bank is looked at again. */
export async function sweepMandateSetups(orgId: string, nowIso = new Date().toISOString()): Promise<{ checked: number; expired: number; confirmed: number }> {
  const open = await withTenant(orgId, (sql) => sql<SetupRow[]>`
    SELECT * FROM billing_mandate_setups WHERE org_id = ${orgId} AND status IN ('CREATED', 'AUTHORISED')`);
  const out = { checked: 0, expired: 0, confirmed: 0 };
  for (const s of open) {
    const due = setupDue({ status: s.status as "CREATED" | "AUTHORISED", createdAt: s.created_at.toISOString() }, nowIso);
    if (due === "check") {
      out.checked += 1;
      const r = await completeSetup(orgId, s.order_id, null, null);
      if (r?.status === "CONFIRMED") out.confirmed += 1;
      continue;
    }
    if (due === "expire") {
      // Looked at once more first: an answer that arrived late still counts.
      const r = await completeSetup(orgId, s.order_id, null, null);
      if (r?.status === "CONFIRMED") {
        out.confirmed += 1;
        continue;
      }
      const moved = await withTenant(orgId, (sql) => sql`
        UPDATE billing_mandate_setups SET status = 'EXPIRED', note = ${s.status === "CREATED" ? "NOT_FINISHED" : "BANK_NO_ANSWER"}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${s.id} AND status IN ('CREATED', 'AUTHORISED')`);
      out.expired += moved.count;
    }
  }
  return out;
}

