import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import { monthOf, sellerFromEnv, skuByKey, testSeller, type SkuKey, type WalletUnit } from "./billing-rules.ts";
import {
  AUTO_OFF,
  COUNTS_TOWARD_CEILING,
  MAX_CHARGE_ATTEMPTS,
  autoSkus,
  chargeFor,
  decideAuto,
  lowestLeft,
  nextForOpen,
  readAutoTopUp,
  type AutoDecision,
  type AutoSetting,
  type ChargeStatus,
  type OpenCharge,
} from "./auto-topup-rules.ts";
import { overview } from "./billing.ts";
import { settleCaptured, startTopUp, type Checkout } from "./billing-pay.ts";
import { buyerOf } from "./invoice.ts";
import { purchasingOpen, razorpay, razorpayConfig, type RazorpayConfig } from "./razorpay.ts";
import { open as openSealed } from "./vault.ts";

/**
 * Automatic top-ups: the setting, the saved mandate, and the step the
 * billing sweep runs for every organisation. The rules are
 * `auto-topup-rules.ts`; this reads and writes, through `withTenant()`.
 *
 * Nothing here charges an organisation that is not LIVE: the database
 * refuses it too (0071). The mandate is written by the operator's script
 * (`npm run billing -- mandate`), sealed per tenant, and opened only for
 * the one call that uses it.
 */

type Mode = "SHADOW" | "LIVE";

import { mandatePurpose } from "./vault-rules.ts";
export { mandatePurpose };

export type MandateSecret = { customerId: string; token: string; email: string; contact: string };

type ChargeRow = {
  id: string;
  period: string;
  seq: number;
  sku: string;
  qty: number;
  unit: WalletUnit;
  units: string;
  taxable_paise: string;
  total_paise: string;
  status: ChargeStatus;
  note: string | null;
  mandate_id: string | null;
  notified_at: Date | null;
  due_at: Date | null;
  order_id: string | null;
  payment_id: string | null;
  attempts: number;
  tried_at: Date | null;
  settled_at: Date | null;
  created_at: Date;
};

export type Charge = {
  id: string;
  sku: SkuKey;
  label: string;
  qty: number;
  units: number;
  totalPaise: number;
  status: ChargeStatus;
  note: string | null;
  dueAt: string | null;
  notifiedAt: string | null;
  createdAt: string;
};

const toCharge = (r: ChargeRow): Charge => {
  const sku = skuByKey(r.sku);
  return {
    id: r.id,
    sku: r.sku as SkuKey,
    label: `${r.qty > 1 ? `${r.qty} x ` : ""}${sku?.label ?? r.sku}`,
    qty: r.qty,
    units: Number(r.units),
    totalPaise: Number(r.total_paise),
    status: r.status,
    note: r.note,
    dueAt: r.due_at?.toISOString() ?? null,
    notifiedAt: r.notified_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
};

const OPEN: ChargeStatus[] = ["NOTIFIED", "AWAITING_APPROVAL", "CHARGING"];

type AccountRow = {
  mode: Mode;
  auto_topup_on: boolean;
  auto_topup_sku: string | null;
  auto_topup_qty: number;
  auto_topup_threshold: string | null;
  auto_topup_ceiling_paise: string | null;
};

const settingOf = (a: AccountRow | undefined): AutoSetting =>
  a
    ? {
        on: a.auto_topup_on,
        sku: (skuByKey(a.auto_topup_sku ?? "")?.key ?? null) as SkuKey | null,
        qty: a.auto_topup_qty,
        threshold: a.auto_topup_threshold === null ? null : Number(a.auto_topup_threshold),
        ceilingPaise: a.auto_topup_ceiling_paise === null ? null : Number(a.auto_topup_ceiling_paise),
      }
    : AUTO_OFF;

async function hasScaleNow(sql: TransactionSql, orgId: string): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM subscriptions
    WHERE org_id = ${orgId} AND plan = 'SCALE' AND starts_on <= current_date AND (ends_on IS NULL OR ends_on > current_date)`;
  return (r?.n ?? 0) > 0;
}

/** Whose GST state an automatic purchase is priced from: the seller's, as the invoice will be. */
function sellerState(test: boolean): string {
  const real = sellerFromEnv(process.env);
  return test || !real.ok ? testSeller(process.env).state : real.seller.state;
}

export type AutoView = {
  mode: Mode | null;
  setting: AutoSetting;
  hasScale: boolean;
  buyerState: string | null;
  sellerState: string;
  mandate: { method: string; label: string | null; maxAmountPaise: number; test: boolean } | null;
  spentThisMonthPaise: number;
  open: Charge[];
  history: Charge[];
};

/** What the auto top-up screen shows. */
export async function autoTopUpView(orgId: string, nowIso = new Date().toISOString()): Promise<AutoView> {
  const cfg = razorpayConfig();
  const test = cfg.ok && cfg.config.test;
  const { period } = monthOf(nowIso);
  return withTenant(orgId, async (sql) => {
    const [[acct], hasScale, buyer, [mandate], rows, [spent]] = await Promise.all([
      sql<AccountRow[]>`
        SELECT mode, auto_topup_on, auto_topup_sku, auto_topup_qty, auto_topup_threshold, auto_topup_ceiling_paise
        FROM billing_accounts WHERE org_id = ${orgId}`,
      hasScaleNow(sql, orgId),
      buyerOf(sql, orgId),
      sql<{ method: string; label: string | null; max_amount_paise: string; test: boolean }[]>`
        SELECT method, label, max_amount_paise, test FROM billing_mandates WHERE org_id = ${orgId} AND status = 'ACTIVE'`,
      sql<ChargeRow[]>`
        SELECT * FROM auto_topup_charges WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 30`,
      sql<{ total: string }[]>`
        SELECT coalesce(sum(total_paise), 0) AS total FROM auto_topup_charges
        WHERE org_id = ${orgId} AND period = ${period} AND status = ANY(${COUNTS_TOWARD_CEILING as string[]})`,
    ]);
    const charges = rows.map(toCharge);
    return {
      mode: acct?.mode ?? null,
      setting: settingOf(acct),
      hasScale,
      buyerState: buyer?.state ?? null,
      sellerState: sellerState(test),
      mandate: mandate ? { method: mandate.method, label: mandate.label, maxAmountPaise: Number(mandate.max_amount_paise), test: mandate.test } : null,
      spentThisMonthPaise: Number(spent?.total ?? 0),
      open: charges.filter((c) => OPEN.includes(c.status)),
      history: charges.filter((c) => !OPEN.includes(c.status)),
    };
  });
}

/**
 * Save the setting. Only an organisation that has been sold a plan has a
 * billing account to hold it. The audit row says what changed, in codes.
 */
export async function saveAutoTopUp(opts: { orgId: string; userId: string; input: Record<string, unknown> }): Promise<{ ok: true; changed: string[] } | { ok: false; message: string }> {
  const cfg = razorpayConfig();
  const test = cfg.ok && cfg.config.test;
  const out = await withTenant(opts.orgId, async (sql) => {
    const [acct] = await sql<AccountRow[]>`
      SELECT mode, auto_topup_on, auto_topup_sku, auto_topup_qty, auto_topup_threshold, auto_topup_ceiling_paise
      FROM billing_accounts WHERE org_id = ${opts.orgId} FOR UPDATE`;
    if (!acct) return { ok: false as const, message: "This organisation has no plan yet, so there is nothing to top up." };
    const buyer = await buyerOf(sql, opts.orgId);
    const read = readAutoTopUp(opts.input, { hasScale: await hasScaleNow(sql, opts.orgId), sellerState: sellerState(test), buyerState: buyer?.state ?? null });
    if (!read.ok) return { ok: false as const, message: read.problems.join(" ") };
    const v = read.value;
    const before = settingOf(acct);
    const changed = (["on", "sku", "qty", "threshold", "ceilingPaise"] as const).filter((k) => before[k] !== v[k]);
    if (!changed.length) return { ok: true as const, changed: [] as string[] };
    await sql`
      UPDATE billing_accounts
      SET auto_topup_on = ${v.on}, auto_topup_sku = ${v.sku}, auto_topup_qty = ${v.qty},
          auto_topup_threshold = ${v.threshold}, auto_topup_ceiling_paise = ${v.ceilingPaise},
          updated_by = ${opts.userId}, updated_at = now()
      WHERE org_id = ${opts.orgId}`;
    // Switched off, nothing waiting to be charged is taken.
    if (!v.on) {
      await sql`
        UPDATE auto_topup_charges SET status = 'CANCELLED', note = 'TURNED_OFF', updated_at = now()
        WHERE org_id = ${opts.orgId} AND status IN ('NOTIFIED', 'AWAITING_APPROVAL')`;
    }
    return { ok: true as const, changed: [...changed] };
  });
  if (out.ok && out.changed.length) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "billing.auto_topup_changed", targetType: "org", targetId: opts.orgId, metadata: { fields: out.changed } });
  }
  return out;
}

/** The client cancels a purchase that is announced or waiting for them. One being charged cannot be. */
export async function cancelAutoCharge(opts: { orgId: string; userId: string; chargeId: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(opts.chargeId)) return { ok: false, message: "That top-up is not one of yours." };
  const r = await withTenant(opts.orgId, (sql) => sql`
    UPDATE auto_topup_charges SET status = 'CANCELLED', note = 'BY_CLIENT', updated_at = now()
    WHERE org_id = ${opts.orgId} AND id = ${opts.chargeId} AND status IN ('NOTIFIED', 'AWAITING_APPROVAL')`);
  if (!r.count) return { ok: false, message: "That top-up is already being charged or is finished." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "billing.auto_topup_cancelled", targetType: "auto_topup", targetId: opts.chargeId, metadata: {} });
  return { ok: true };
}

/** The client pays a purchase that waits for them, through Checkout, which authenticates it. */
export async function approveAutoCharge(opts: { orgId: string; userId: string; userEmail?: string | null; chargeId: string }): Promise<{ ok: true; checkout: Checkout } | { ok: false; message: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(opts.chargeId)) return { ok: false, message: "That top-up is not one of yours." };
  const [c] = await withTenant(opts.orgId, (sql) => sql<{ sku: string; qty: number; status: string }[]>`
    SELECT sku, qty, status FROM auto_topup_charges WHERE org_id = ${opts.orgId} AND id = ${opts.chargeId}`);
  if (!c || c.status !== "AWAITING_APPROVAL") return { ok: false, message: "That top-up is no longer waiting to be paid." };
  return startTopUp({ orgId: opts.orgId, userId: opts.userId, userEmail: opts.userEmail, cart: [{ sku: c.sku, qty: c.qty }], autoChargeId: opts.chargeId });
}

// ---------------------------------------------------------------------------
// The worker's step
// ---------------------------------------------------------------------------

export type AutoRun = { decided: AutoDecision["kind"] | "open"; why?: string; status?: ChargeStatus; chargeId?: string };

type Facts = {
  mode: Mode;
  setting: AutoSetting;
  sku: ReturnType<typeof skuByKey>;
  buyerState: string | null;
  mandate: { id: string; maxAmountPaise: number; secret: Buffer } | null;
  open: ChargeRow | null;
  lastRecordedAt: string | null;
  spentPaise: number;
};

async function factsOf(orgId: string, period: string, test: boolean): Promise<Facts | null> {
  return withTenant(orgId, async (sql) => {
    const [acct] = await sql<AccountRow[]>`
      SELECT mode, auto_topup_on, auto_topup_sku, auto_topup_qty, auto_topup_threshold, auto_topup_ceiling_paise
      FROM billing_accounts WHERE org_id = ${orgId}`;
    if (!acct) return null;
    const setting = settingOf(acct);
    const [[open], [last], [spent], [m], buyer] = await Promise.all([
      sql<ChargeRow[]>`SELECT * FROM auto_topup_charges WHERE org_id = ${orgId} AND status = ANY(${OPEN as string[]})`,
      sql<{ at: Date }[]>`SELECT max(created_at) AS at FROM auto_topup_charges WHERE org_id = ${orgId} AND status = 'WOULD_CHARGE'`,
      sql<{ total: string }[]>`
        SELECT coalesce(sum(total_paise), 0) AS total FROM auto_topup_charges
        WHERE org_id = ${orgId} AND period = ${period} AND status = ANY(${COUNTS_TOWARD_CEILING as string[]})`,
      sql<{ id: string; max_amount_paise: string; secret: Buffer; test: boolean }[]>`
        SELECT id, max_amount_paise, secret, test FROM billing_mandates WHERE org_id = ${orgId} AND status = 'ACTIVE'`,
      buyerOf(sql, orgId),
    ]);
    return {
      mode: acct.mode,
      setting,
      sku: skuByKey(setting.sku ?? ""),
      buyerState: buyer?.state ?? null,
      // A test mandate is only good in the gateway's test mode, and a live one only live.
      mandate: m && m.test === test ? { id: m.id, maxAmountPaise: Number(m.max_amount_paise), secret: m.secret } : null,
      open: open ?? null,
      lastRecordedAt: last?.at ? last.at.toISOString() : null,
      spentPaise: Number(spent?.total ?? 0),
    };
  });
}

/** How much of a unit is left where it is lowest, from the same numbers Plan and usage shows. */
async function leftOf(orgId: string, unit: WalletUnit, nowIso: string): Promise<number | null> {
  const o = await overview(orgId, nowIso);
  const wallet = o.wallet.find((w) => w.unit === unit)?.left ?? 0;
  const planned = o.projects.filter((p) => p.sub);
  if (!planned.length) return lowestLeft(unit, null, wallet);
  if (unit === "MINUTE" || unit === "IMAGE" || unit === "CAROUSEL" || unit === "VIDEO") {
    const lines = o.pool ? [o.pool] : planned.map((p) => p.units);
    return lowestLeft(unit, lines.map((units) => {
      const u = units.find((x) => x.unit === unit);
      return u ? u.allowance - u.used : 0;
    }), wallet);
  }
  return lowestLeft(unit, [], wallet);
}

/**
 * One organisation's automatic top-up, once. A purchase in flight is moved
 * on (charged when due, looked for when it had no answer, cancelled when no
 * longer wanted, expired when nobody paid it); otherwise a new one is
 * decided. Idempotent: two workers at once resolve on the one-in-flight
 * index and on the (organisation, month, sequence) key.
 */
export async function runAutoTopUp(orgId: string, nowIso = new Date().toISOString()): Promise<AutoRun> {
  const cfg = razorpayConfig();
  const test = cfg.ok && cfg.config.test;
  const { period } = monthOf(nowIso);
  const f = await factsOf(orgId, period, test);
  if (!f) return { decided: "none", why: "NO_ACCOUNT" };
  const live = f.mode === "LIVE";
  const gatewayOpen = cfg.ok && purchasingOpen(f.mode);

  if (f.open) {
    const c = f.open;
    const left = f.sku ? await leftOf(orgId, f.sku.unit, nowIso) : null;
    const stillLow = left !== null && f.setting.threshold !== null && left < f.setting.threshold;
    const step = nextForOpen(
      {
        status: c.status as OpenCharge["status"],
        notifiedAt: (c.notified_at ?? c.created_at).toISOString(),
        dueAt: c.due_at?.toISOString() ?? null,
        attempts: c.attempts,
        triedAt: c.tried_at?.toISOString() ?? null,
      },
      { on: f.setting.on, live: live && gatewayOpen, mandateActive: !!f.mandate, stillLow, nowIso },
    );
    if (step.kind === "wait") return { decided: "open", why: "WAIT", status: c.status, chargeId: c.id };
    if (step.kind === "cancel" || step.kind === "expire" || step.kind === "fail") {
      const status: ChargeStatus = step.kind === "cancel" ? "CANCELLED" : step.kind === "expire" ? "EXPIRED" : "FAILED";
      const note = step.kind === "expire" ? "NOT_PAID" : step.note;
      await withTenant(orgId, (sql) => sql`
        UPDATE auto_topup_charges SET status = ${status}, note = ${note}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${c.id} AND status = ${c.status}`);
      await audit({ orgId, actorUserId: null, action: "billing.auto_topup_closed", targetType: "auto_topup", targetId: c.id, metadata: { status, note } });
      return { decided: "open", why: note, status, chargeId: c.id };
    }
    if (!cfg.ok || !f.mandate) return { decided: "open", why: "GATEWAY", status: c.status, chargeId: c.id };
    return chargeNow(orgId, c, cfg.config, f.mandate, step.kind === "look", nowIso);
  }

  if (!f.sku || !f.buyerState) {
    return { decided: "none", why: f.setting.on ? "NO_BUYER" : "OFF" };
  }
  const left = await leftOf(orgId, f.sku.unit, nowIso);
  const charge = chargeFor(f.sku, f.setting.qty, sellerState(test), f.buyerState);
  const decision = decideAuto({
    setting: f.setting,
    sku: f.sku,
    live,
    inFlight: false,
    lastRecordedAt: f.lastRecordedAt,
    left,
    spentThisMonthPaise: f.spentPaise,
    totalPaise: charge.totalPaise,
    mandate: f.mandate,
    gatewayOpen,
    nowIso,
  });
  if (decision.kind === "none") return { decided: "none", why: decision.why };

  const row = await withTenant(orgId, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`auto_topup:${orgId}`}, 0))`;
    const [busy] = await sql`SELECT 1 FROM auto_topup_charges WHERE org_id = ${orgId} AND status = ANY(${OPEN as string[]})`;
    if (busy) return null;
    if (decision.status === "WOULD_CHARGE") {
      const [recent] = await sql`
        SELECT 1 FROM auto_topup_charges WHERE org_id = ${orgId} AND status = 'WOULD_CHARGE' AND created_at > ${nowIso}::timestamptz - interval '24 hours'`;
      if (recent) return null;
    }
    const [{ seq }] = await sql<{ seq: number }[]>`
      SELECT coalesce(max(seq), 0)::int + 1 AS seq FROM auto_topup_charges WHERE org_id = ${orgId} AND period = ${period}`;
    const notified = decision.status === "WOULD_CHARGE" ? null : nowIso;
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO auto_topup_charges (org_id, period, seq, sku, qty, unit, units, taxable_paise, total_paise, left_then,
                                      status, note, mandate_id, notified_at, due_at, created_at)
      VALUES (${orgId}, ${period}, ${seq}, ${f.sku!.key}, ${f.setting.qty}, ${f.sku!.unit}, ${charge.units},
              ${charge.taxablePaise}, ${charge.totalPaise}, ${left ?? 0}, ${decision.status},
              ${"note" in decision ? decision.note : null}, ${f.mandate?.id ?? null}, ${notified},
              ${decision.status === "NOTIFIED" ? decision.dueAt : null}, ${nowIso})
      ON CONFLICT (org_id, period, seq) DO NOTHING
      RETURNING id`;
    return r ?? null;
  });
  if (!row) return { decided: "none", why: "IN_FLIGHT" };
  await audit({
    orgId,
    actorUserId: null,
    action: "billing.auto_topup_decided",
    targetType: "auto_topup",
    targetId: row.id,
    metadata: { status: decision.status, sku: f.sku.key, qty: f.setting.qty, total_paise: charge.totalPaise },
  });
  return { decided: "record", status: decision.status, chargeId: row.id };
}

/**
 * Take a notified charge, or look again at one that had no answer. The row
 * is marked tried before anything is sent, the order is recorded before
 * the payment is asked for, and a charge with an order is looked for at the
 * gateway before it is asked for again.
 */
async function chargeNow(orgId: string, c: ChargeRow, cfg: RazorpayConfig, mandate: { id: string; secret: Buffer }, looking: boolean, nowIso: string): Promise<AutoRun> {
  const claimed = await withTenant(orgId, (sql) => sql`
    UPDATE auto_topup_charges SET status = 'CHARGING', attempts = attempts + 1, tried_at = ${nowIso}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${c.id} AND status = ${c.status} AND attempts = ${c.attempts} AND attempts < ${MAX_CHARGE_ATTEMPTS}`);
  if (!claimed.count) return { decided: "open", why: "TAKEN", status: c.status, chargeId: c.id };
  const drv = razorpay();
  const total = Number(c.total_paise);
  let orderId = c.order_id;

  if (looking && orderId) {
    const seen = await drv.orderPayments(cfg, orderId).catch(() => null);
    const good = seen?.find((p) => (p.status === "captured" || p.status === "authorized") && p.amount === total);
    if (good) return settleOrWait(orgId, c.id, orderId, good.id, good.status);
  }

  try {
    if (!orderId) {
      const order = await drv.createOrder(cfg, { amountPaise: total, receipt: `auto_${c.id.replace(/-/g, "").slice(0, 20)}`, notes: { org: orgId, auto: c.id } });
      orderId = order.id;
      const sku = skuByKey(c.sku)!;
      const items = [{ sku: sku.key, qty: c.qty, unit: sku.unit, units: Number(c.units), pricePaise: Number(c.taxable_paise) }];
      await withTenant(orgId, async (sql) => {
        const [pay] = await sql<{ id: string }[]>`
          INSERT INTO payments (org_id, order_id, items, taxable_paise, tax_paise, total_paise, test)
          VALUES (${orgId}, ${order.id}, ${sql.json(items)}, ${Number(c.taxable_paise)}, ${total - Number(c.taxable_paise)}, ${total}, ${cfg.test})
          RETURNING id`;
        await sql`UPDATE auto_topup_charges SET order_id = ${order.id}, payment_id = ${pay.id}, updated_at = now() WHERE org_id = ${orgId} AND id = ${c.id}`;
      });
    }
    const raw = await openSealed(orgId, mandatePurpose(mandate.id), mandate.secret);
    const secret = raw ? (JSON.parse(raw) as MandateSecret) : null;
    if (!secret) {
      await withTenant(orgId, (sql) => sql`
        UPDATE auto_topup_charges SET status = 'FAILED', note = 'MANDATE_UNREADABLE', updated_at = now() WHERE org_id = ${orgId} AND id = ${c.id}`);
      return { decided: "open", why: "MANDATE_UNREADABLE", status: "FAILED", chargeId: c.id };
    }
    const sku = skuByKey(c.sku);
    const paid = await drv.createRecurringPayment(cfg, {
      orderId,
      amountPaise: total,
      customerId: secret.customerId,
      token: secret.token,
      email: secret.email,
      contact: secret.contact,
      description: `Automatic top-up: ${c.qty > 1 ? `${c.qty} x ` : ""}${sku?.label ?? c.sku}`,
      notes: { org: orgId, auto: c.id },
    });
    const p = await drv.fetchPayment(cfg, paid.paymentId).catch(() => null);
    if (p && p.amount === total) return settleOrWait(orgId, c.id, orderId, p.id, p.status);
    return { decided: "open", why: "SENT", status: "CHARGING", chargeId: c.id };
  } catch (e) {
    // Left CHARGING: the next pass looks for it before asking again.
    console.error(`billing: automatic top-up ${c.id} was not answered`, e);
    return { decided: "open", why: "NO_ANSWER", status: "CHARGING", chargeId: c.id };
  }
}

async function settleOrWait(orgId: string, chargeId: string, orderId: string, paymentId: string, status: string): Promise<AutoRun> {
  if (status === "captured") {
    const done = await settleCaptured(orgId, orderId, paymentId);
    return { decided: "open", why: done ? "SETTLED" : "NOT_SETTLED", status: done ? "PAID" : "CHARGING", chargeId };
  }
  if (status === "failed") {
    await withTenant(orgId, (sql) => sql`
      UPDATE auto_topup_charges SET status = 'FAILED', note = 'DECLINED', updated_at = now()
      WHERE org_id = ${orgId} AND id = ${chargeId} AND status = 'CHARGING'`);
    return { decided: "open", why: "DECLINED", status: "FAILED", chargeId };
  }
  // Authorised or created: the capture arrives by webhook, or the next pass finds it.
  return { decided: "open", why: "PENDING", status: "CHARGING", chargeId };
}

/** Open purchases, for Today. */
export async function openAutoCharges(orgId: string): Promise<Charge[]> {
  const rows = await withTenant(orgId, (sql) => sql<ChargeRow[]>`
    SELECT * FROM auto_topup_charges WHERE org_id = ${orgId} AND status = ANY(${OPEN as string[]}) ORDER BY created_at DESC`);
  return rows.map(toCharge);
}

export { autoSkus };
