import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import { draftInvoice, istDate, planLines, readTerms, sellerFromEnv, testSeller, type InvoiceLine, type Party, type PlanKey } from "./billing-rules.ts";
import { PARTNER_PLANS, termsFor } from "./billing-rules.ts";
import { subsForPeriod } from "./billing.ts";
import { buyerOf } from "./invoice.ts";
import { purchasingOpen, razorpay, razorpayConfig, type RazorpayConfig } from "./razorpay.ts";
import { open as openSealed } from "./vault.ts";
import { mandatePurpose } from "./vault-rules.ts";
import { MAX_CHARGE_ATTEMPTS, readMandateMethod } from "./auto-topup-rules.ts";
import { readPlanKey } from "./plan-purchase-rules.ts";
import {
  UNPAID,
  decideRenewal,
  downgradeRefusal,
  nextForRenewal,
  nextMonthStart,
  renewalPeriod,
  smallerPlans,
  type RenewalStatus,
} from "./plan-renewal-rules.ts";
import type { Checkout } from "./billing-pay.ts";

/**
 * A plan renewing itself each month, and a channel partner moving to a
 * smaller plan. The rules are `plan-renewal-rules.ts`; this reads and
 * writes. The billing sweep runs `runPlanRenewal()` for every organisation
 * with a billing account and `applyPlanChanges()` on the owner's
 * connection. Nothing here charges an organisation that is not LIVE (0109).
 */

type Line = Omit<InvoiceLine, "amountPaise" | "sac">;

type RenewalRow = {
  id: string;
  period: string;
  lines: Line[];
  taxable_paise: string;
  total_paise: string;
  status: RenewalStatus;
  note: string | null;
  notified_at: Date | null;
  due_at: Date | null;
  order_id: string | null;
  payment_id: string | null;
  attempts: number;
  tried_at: Date | null;
  created_at: Date;
};

export type Renewal = {
  id: string;
  period: string;
  totalPaise: number;
  status: RenewalStatus;
  note: string | null;
  dueAt: string | null;
  lines: { description: string; qty: number; unitPaise: number }[];
};

const toRenewal = (r: RenewalRow): Renewal => ({
  id: r.id,
  period: r.period,
  totalPaise: Number(r.total_paise),
  status: r.status,
  note: r.note,
  dueAt: r.due_at?.toISOString() ?? null,
  lines: r.lines.map((l) => ({ description: l.description, qty: l.qty, unitPaise: l.unitPaise })),
});

const RENEWAL_COLS = `id, period::text AS period, lines, taxable_paise, total_paise, status, note, notified_at, due_at,
  order_id, payment_id, attempts, tried_at, created_at`;

/** Who sells: the real seller, or in the gateway's test mode the test one. */
function sellerFor(test: boolean): Party {
  const real = sellerFromEnv(process.env);
  return test || !real.ok ? testSeller(process.env) : real.seller;
}

/** The month's renewal and any older one still owed, newest first, for Plan and usage and Today. */
export async function renewalsFor(orgId: string, nowIso = new Date().toISOString()): Promise<Renewal[]> {
  const period = renewalPeriod(nowIso);
  const rows = await withTenant(orgId, (sql) => sql.unsafe<RenewalRow[]>(
    `SELECT ${RENEWAL_COLS} FROM plan_renewals
     WHERE org_id = $1 AND (period = $2::date OR status = ANY($3))
     ORDER BY period DESC LIMIT 6`,
    [orgId, period, UNPAID as string[]],
  ));
  return rows.map(toRenewal);
}

export type RenewalRun = { done: "none" | "recorded" | "moved"; why?: string; status?: RenewalStatus; renewalId?: string };

/**
 * One organisation's month, once. A renewal in flight is moved on; with
 * none for this month, the month's plan invoice lines are worked out and
 * recorded (shadow), announced (a mandate may take it) or set to wait for
 * the client. Idempotent: (organisation, month) is unique.
 */
export async function runPlanRenewal(orgId: string, nowIso = new Date().toISOString()): Promise<RenewalRun> {
  const cfg = razorpayConfig();
  const test = cfg.ok && cfg.config.test;
  const period = renewalPeriod(nowIso);
  const f = await withTenant(orgId, async (sql) => {
    const [acct] = await sql<{ mode: "SHADOW" | "LIVE" }[]>`SELECT mode FROM billing_accounts WHERE org_id = ${orgId}`;
    if (!acct) return null;
    const [[open], [mine], [billed], [m], buyer, subs] = await Promise.all([
      sql.unsafe<RenewalRow[]>(`SELECT ${RENEWAL_COLS} FROM plan_renewals WHERE org_id = $1 AND status = ANY($2) ORDER BY period LIMIT 1`, [orgId, UNPAID as string[]]),
      sql<{ id: string }[]>`SELECT id FROM plan_renewals WHERE org_id = ${orgId} AND period = ${period}`,
      // A month the operator invoiced by hand (a bank transfer) is not renewed here.
      sql<{ id: string }[]>`SELECT id FROM invoices WHERE org_id = ${orgId} AND purpose = 'PLAN' AND kind = 'INVOICE' AND period = ${period}`,
      sql<{ id: string; method: string; max_amount_paise: string; secret: Buffer; test: boolean }[]>`
        SELECT id, method, max_amount_paise, secret, test FROM billing_mandates WHERE org_id = ${orgId} AND status = 'ACTIVE'`,
      buyerOf(sql, orgId),
      subsForPeriod(sql, orgId, period),
    ]);
    const method = m ? readMandateMethod(m.method) : null;
    return {
      mode: acct.mode,
      open: open ?? null,
      hasThisMonth: !!mine || !!billed,
      mandate: m && method && m.test === test ? { id: m.id, method, maxAmountPaise: Number(m.max_amount_paise), secret: m.secret } : null,
      buyer,
      subs,
    };
  });
  if (!f) return { done: "none", why: "NO_ACCOUNT" };
  const live = f.mode === "LIVE";

  if (f.open) {
    const r = f.open;
    const step = nextForRenewal(
      { status: r.status as "NOTIFIED" | "AWAITING_APPROVAL" | "CHARGING", dueAt: r.due_at?.toISOString() ?? null, attempts: r.attempts, triedAt: r.tried_at?.toISOString() ?? null },
      { live, mandateActive: !!f.mandate, nowIso },
    );
    if (step.kind === "wait") return { done: "moved", why: "WAIT", status: r.status, renewalId: r.id };
    if (step.kind === "cancel" || step.kind === "to_client") {
      const status: RenewalStatus = step.kind === "cancel" ? "CANCELLED" : "AWAITING_APPROVAL";
      await withTenant(orgId, (sql) => sql`
        UPDATE plan_renewals SET status = ${status}, note = ${step.note}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${r.id} AND status = ${r.status}`);
      await audit({ orgId, actorUserId: null, action: "billing.renewal_moved", targetType: "plan_renewal", targetId: r.id, metadata: { status, note: step.note } });
      return { done: "moved", why: step.note, status, renewalId: r.id };
    }
    if (!cfg.ok || !f.mandate) return { done: "moved", why: "GATEWAY", status: r.status, renewalId: r.id };
    return chargeRenewal(orgId, r, cfg.config, f.mandate, step.kind === "look", nowIso);
  }

  if (f.hasThisMonth) return { done: "none", why: "DONE" };
  const lines = planLines(f.subs, period);
  if (!lines.length) return { done: "none", why: "NOTHING_DUE" };
  const seller = sellerFor(test);
  // Without billing details the amount is the same; the split of the tax is decided when it is paid.
  const draft = draftInvoice(lines, seller, f.buyer ?? seller);
  const decision = decideRenewal({
    live,
    gatewayOpen: cfg.ok && purchasingOpen(f.mode),
    totalPaise: draft.totalPaise,
    mandate: f.mandate,
    nowIso,
  });
  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO plan_renewals (org_id, period, lines, taxable_paise, total_paise, status, note, mandate_id, notified_at, due_at)
      VALUES (${orgId}, ${period}, ${sql.json(lines as never)}, ${draft.taxablePaise}, ${draft.totalPaise}, ${decision.status},
              ${"note" in decision ? decision.note : null}, ${f.mandate?.id ?? null},
              ${decision.status === "WOULD_CHARGE" ? null : nowIso}, ${decision.status === "NOTIFIED" ? decision.dueAt : null})
      ON CONFLICT (org_id, period) DO NOTHING
      RETURNING id`;
    return r ?? null;
  });
  if (!row) return { done: "none", why: "DONE" };
  await audit({
    orgId,
    actorUserId: null,
    action: "billing.renewal_decided",
    targetType: "plan_renewal",
    targetId: row.id,
    metadata: { period, status: decision.status, total_paise: draft.totalPaise },
  });
  return { done: "recorded", status: decision.status, renewalId: row.id };
}

/** The payment's items: the month's lines, each carrying the renewal it pays. */
const itemsFor = (renewalId: string, lines: readonly Line[]) => lines.map((l) => ({ renewal: renewalId, description: l.description, qty: l.qty, unitPaise: l.unitPaise }));

/**
 * Take an announced month from the automatic payment, or look again at one
 * with no answer: marked tried first, the order recorded before the payment
 * is asked for, and an order with a payment found before another is asked.
 */
async function chargeRenewal(orgId: string, r: RenewalRow, cfg: RazorpayConfig, mandate: { id: string; secret: Buffer }, looking: boolean, nowIso: string): Promise<RenewalRun> {
  const claimed = await withTenant(orgId, (sql) => sql`
    UPDATE plan_renewals SET status = 'CHARGING', attempts = attempts + 1, tried_at = ${nowIso}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${r.id} AND status = ${r.status} AND attempts = ${r.attempts} AND attempts < ${MAX_CHARGE_ATTEMPTS}`);
  if (!claimed.count) return { done: "moved", why: "TAKEN", status: r.status, renewalId: r.id };
  const drv = razorpay();
  const total = Number(r.total_paise);
  let orderId = r.order_id;
  if (looking && orderId) {
    const seen = await drv.orderPayments(cfg, orderId).catch(() => null);
    const good = seen?.find((p) => (p.status === "captured" || p.status === "authorized") && p.amount === total);
    if (good) return settleOrWait(orgId, r.id, orderId, good.id, good.status);
  }
  try {
    if (!orderId) {
      const order = await drv.createOrder(cfg, { amountPaise: total, receipt: `ren_${r.id.replace(/-/g, "").slice(0, 20)}`, notes: { org: orgId, renewal: r.id } });
      orderId = order.id;
      await withTenant(orgId, async (sql) => {
        const [pay] = await sql<{ id: string }[]>`
          INSERT INTO payments (org_id, order_id, items, taxable_paise, tax_paise, total_paise, test, purpose)
          VALUES (${orgId}, ${order.id}, ${sql.json(itemsFor(r.id, r.lines) as never)}, ${Number(r.taxable_paise)}, ${total - Number(r.taxable_paise)}, ${total}, ${cfg.test}, 'RENEWAL')
          RETURNING id`;
        await sql`UPDATE plan_renewals SET order_id = ${order.id}, payment_id = ${pay.id}, updated_at = now() WHERE org_id = ${orgId} AND id = ${r.id}`;
      });
    }
    const raw = await openSealed(orgId, mandatePurpose(mandate.id), mandate.secret);
    const secret = raw ? (JSON.parse(raw) as { customerId: string; token: string; email: string; contact: string }) : null;
    if (!secret) {
      await withTenant(orgId, (sql) => sql`
        UPDATE plan_renewals SET status = 'AWAITING_APPROVAL', note = 'NO_MANDATE', updated_at = now() WHERE org_id = ${orgId} AND id = ${r.id}`);
      return { done: "moved", why: "NO_MANDATE", status: "AWAITING_APPROVAL", renewalId: r.id };
    }
    const paid = await drv.createRecurringPayment(cfg, {
      orderId,
      amountPaise: total,
      customerId: secret.customerId,
      token: secret.token,
      email: secret.email,
      contact: secret.contact,
      description: `Sales Desk plan, ${r.period.slice(0, 7)}`,
      notes: { org: orgId, renewal: r.id },
    });
    const p = await drv.fetchPayment(cfg, paid.paymentId).catch(() => null);
    if (p && p.amount === total) return settleOrWait(orgId, r.id, orderId, p.id, p.status);
    return { done: "moved", why: "SENT", status: "CHARGING", renewalId: r.id };
  } catch (e) {
    console.error(`billing: renewal ${r.id} was not answered`, e);
    return { done: "moved", why: "NO_ANSWER", status: "CHARGING", renewalId: r.id };
  }
}

async function settleOrWait(orgId: string, renewalId: string, orderId: string, paymentId: string, status: string): Promise<RenewalRun> {
  if (status === "captured") {
    const { settleCaptured } = await import("./billing-pay.ts");
    const done = await settleCaptured(orgId, orderId, paymentId);
    return { done: "moved", why: done ? "SETTLED" : "NOT_SETTLED", status: done ? "PAID" : "CHARGING", renewalId };
  }
  if (status === "failed") {
    // Declined: still owed, so the client pays it.
    await withTenant(orgId, (sql) => sql`
      UPDATE plan_renewals SET status = 'AWAITING_APPROVAL', note = 'DECLINED', updated_at = now()
      WHERE org_id = ${orgId} AND id = ${renewalId} AND status = 'CHARGING'`);
    return { done: "moved", why: "DECLINED", status: "AWAITING_APPROVAL", renewalId };
  }
  return { done: "moved", why: "PENDING", status: "CHARGING", renewalId };
}

/** The client pays a month that waits for them, through Checkout. */
export async function payRenewal(opts: { orgId: string; userId: string; userEmail?: string | null; renewalId: string }): Promise<{ ok: true; checkout: Checkout } | { ok: false; message: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(opts.renewalId)) return { ok: false, message: "That month is not one of yours." };
  const cfg = razorpayConfig();
  const found = await withTenant(opts.orgId, async (sql) => {
    const [acct] = await sql<{ mode: "SHADOW" | "LIVE" }[]>`SELECT mode FROM billing_accounts WHERE org_id = ${opts.orgId}`;
    const [r] = await sql.unsafe<RenewalRow[]>(`SELECT ${RENEWAL_COLS} FROM plan_renewals WHERE org_id = $1 AND id = $2`, [opts.orgId, opts.renewalId]);
    return { mode: acct?.mode ?? null, r: r ?? null, buyer: await buyerOf(sql, opts.orgId) };
  });
  if (!found.r || found.r.status !== "AWAITING_APPROVAL") return { ok: false, message: "That month is no longer waiting to be paid." };
  if (!cfg.ok || !purchasingOpen(found.mode)) return { ok: false, message: "Plans cannot be paid here yet. Write to us and we'll take it by bank transfer." };
  if (!found.buyer) return { ok: false, message: "Add the state you are billed in, under Billing details, before paying." };
  const r = found.r;
  const total = Number(r.total_paise);
  let order;
  try {
    order = await razorpay().createOrder(cfg.config, { amountPaise: total, receipt: `ren_${randomUUID().replace(/-/g, "").slice(0, 20)}`, notes: { org: opts.orgId, renewal: r.id } });
  } catch (e) {
    console.error("billing: Razorpay refused the renewal's order", e);
    return { ok: false, message: "The payment could not be started. Try again in a minute." };
  }
  await withTenant(opts.orgId, async (sql) => {
    const [pay] = await sql<{ id: string }[]>`
      INSERT INTO payments (org_id, order_id, items, taxable_paise, tax_paise, total_paise, test, created_by, purpose)
      VALUES (${opts.orgId}, ${order.id}, ${sql.json(itemsFor(r.id, r.lines) as never)}, ${Number(r.taxable_paise)}, ${total - Number(r.taxable_paise)},
              ${total}, ${cfg.config.test}, ${opts.userId}, 'RENEWAL')
      RETURNING id`;
    await sql`
      UPDATE plan_renewals SET order_id = ${order.id}, payment_id = ${pay.id}, updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${r.id} AND status = 'AWAITING_APPROVAL'`;
  });
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "billing.renewal_started", targetType: "plan_renewal", targetId: r.id, metadata: { period: r.period, total_paise: total } });
  return {
    ok: true,
    checkout: {
      key: cfg.config.keyId,
      orderId: order.id,
      amountPaise: total,
      test: cfg.config.test,
      description: `Your plan, ${r.period.slice(0, 7)}`,
      prefill: { name: found.buyer.name, email: opts.userEmail ?? null },
    },
  };
}

/**
 * A RENEWAL payment settling, inside `settle()`'s transaction: the month is
 * paid and its plan invoice issued, once. Returns the invoice.
 */
export async function settleRenewalPayment(
  sql: TransactionSql,
  orgId: string,
  payment: { id: string; test: boolean; items: unknown },
  nowIso: string,
  actor: string | null,
): Promise<{ invoiceId: string; period: string }> {
  const items = Array.isArray(payment.items) ? (payment.items as { renewal?: string }[]) : [];
  const renewalId = items.find((i) => typeof i?.renewal === "string")?.renewal ?? null;
  const [r] = renewalId
    ? await sql<{ id: string; period: string; lines: Line[]; invoice_id: string | null }[]>`
        SELECT id, period::text AS period, lines, invoice_id FROM plan_renewals WHERE org_id = ${orgId} AND id = ${renewalId} FOR UPDATE`
    : [];
  if (!r) throw new Error("billing: a renewal payment names no renewal of this organisation");
  if (r.invoice_id) return { invoiceId: r.invoice_id, period: r.period };
  const buyer = await buyerOf(sql, orgId);
  if (!buyer) throw new Error("billing: a paid organisation has no billing state");
  const seller = payment.test ? { seller: testSeller(process.env), bank: null } : (() => {
    const s = sellerFromEnv(process.env);
    if (!s.ok) throw new Error(`billing: seller not configured (${s.missing.join(", ")})`);
    return s;
  })();
  const { issueInvoice } = await import("./invoice.ts");
  const inv = await issueInvoice(sql, {
    orgId,
    purpose: "PLAN",
    test: payment.test,
    lines: r.lines,
    seller: seller.seller,
    bank: seller.bank,
    buyer,
    issuedOn: istDate(nowIso),
    paymentId: payment.id,
    period: r.period,
    createdBy: actor,
  });
  await sql`
    UPDATE plan_renewals SET status = 'PAID', payment_id = ${payment.id}, invoice_id = ${inv.id}, settled_at = ${nowIso}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${r.id} AND status IN ('AWAITING_APPROVAL', 'CHARGING')`;
  return { invoiceId: inv.id, period: r.period };
}

/** This month of a plan was paid, in the console or by its renewal: what moving up credits. */
export async function monthPaid(sql: TransactionSql, orgId: string, today: string): Promise<boolean> {
  const [r] = await sql<{ id: string }[]>`
    SELECT id FROM plan_renewals WHERE org_id = ${orgId} AND period = ${`${today.slice(0, 7)}-01`} AND status = 'PAID'`;
  return !!r;
}

// ---------------------------------------------------------------------------
// A channel partner moving to a smaller plan
// ---------------------------------------------------------------------------

export type DowngradeView = {
  from: PlanKey;
  options: { key: PlanKey; label: string; projects: number; pricePaise: number; refusal: string | null }[];
  pending: { id: string; to: PlanKey; label: string; effectiveOn: string } | null;
  activeProjects: number;
};

type FirmNow = { subId: string; plan: PlanKey; activeProjects: number; pending: { id: string; to_plan: string; effective_on: string } | null };

async function firmNow(sql: TransactionSql, orgId: string, today: string): Promise<FirmNow | null> {
  const [[sub], [{ n }], [pending]] = await Promise.all([
    sql<{ id: string; plan: string }[]>`
      SELECT s.id, s.plan FROM subscriptions s JOIN orgs o ON o.id = s.org_id
      WHERE s.org_id = ${orgId} AND s.scope = 'ORG' AND o.type = 'CHANNEL_PARTNER'
        AND s.starts_on <= ${today}::date AND (s.ends_on IS NULL OR s.ends_on > ${today}::date)
      ORDER BY s.starts_on DESC LIMIT 1`,
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM scope_nodes s
      WHERE s.org_id = ${orgId} AND s.kind = 'PROJECT'
        AND NOT EXISTS (SELECT 1 FROM project_states ps WHERE ps.org_id = s.org_id AND ps.project_id = s.id AND ps.status = 'RETIRED')`,
    sql<{ id: string; to_plan: string; effective_on: string }[]>`
      SELECT id, to_plan, effective_on::text AS effective_on FROM plan_changes WHERE org_id = ${orgId} AND status = 'PENDING'`,
  ]);
  const plan = sub ? readPlanKey(sub.plan) : null;
  if (!sub || !plan) return null;
  return { subId: sub.id, plan, activeProjects: n, pending: pending ?? null };
}

/** What a channel partner may move down to, and a move already set. Null for anybody else. */
export async function downgradeView(orgId: string, nowIso = new Date().toISOString()): Promise<DowngradeView | null> {
  const today = istDate(nowIso);
  const f = await withTenant(orgId, (sql) => firmNow(sql, orgId, today));
  if (!f) return null;
  const pending = f.pending && readPlanKey(f.pending.to_plan)
    ? { id: f.pending.id, to: readPlanKey(f.pending.to_plan)!, label: PARTNER_PLANS[readPlanKey(f.pending.to_plan)!].label, effectiveOn: f.pending.effective_on }
    : null;
  return {
    from: f.plan,
    activeProjects: f.activeProjects,
    pending,
    options: smallerPlans(f.plan).map((key) => {
      const p = PARTNER_PLANS[key];
      return {
        key,
        label: p.label,
        projects: p.projects ?? 0,
        pricePaise: p.pricePaise,
        refusal: downgradeRefusal({ from: f.plan, to: key, toLabel: p.label, toProjects: p.projects ?? 0, activeProjects: f.activeProjects, pending: false }),
      };
    }),
  };
}

/** Ask to move the firm to a smaller plan from the first of next month. */
export async function requestDowngrade(opts: { orgId: string; userId: string; to: unknown; nowIso?: string }): Promise<{ ok: true; effectiveOn: string; label: string } | { ok: false; message: string }> {
  const to = readPlanKey(opts.to);
  if (!to) return { ok: false, message: "Choose a smaller plan." };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const today = istDate(nowIso);
  const out = await withTenant(opts.orgId, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`plan_change:${opts.orgId}`}, 0))`;
    const f = await firmNow(sql, opts.orgId, today);
    if (!f) return { ok: false as const, message: "Only a channel partner's plan for the whole firm moves down here." };
    const p = PARTNER_PLANS[to];
    const refusal = downgradeRefusal({ from: f.plan, to, toLabel: p.label, toProjects: p.projects ?? 0, activeProjects: f.activeProjects, pending: !!f.pending });
    if (refusal) return { ok: false as const, message: refusal };
    const effectiveOn = nextMonthStart(today);
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO plan_changes (org_id, subscription_id, from_plan, to_plan, effective_on, requested_by)
      VALUES (${opts.orgId}, ${f.subId}, ${f.plan}, ${to}, ${effectiveOn}, ${opts.userId})
      RETURNING id`;
    return { ok: true as const, effectiveOn, label: p.label, id: row.id, from: f.plan };
  });
  if (!out.ok) return out;
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "billing.plan_change_asked", targetType: "plan_change", targetId: out.id, metadata: { from: out.from, to, effective_on: out.effectiveOn } });
  return { ok: true, effectiveOn: out.effectiveOn, label: out.label };
}

/** Withdraw a move to a smaller plan that has not happened yet. */
export async function cancelDowngrade(opts: { orgId: string; userId: string; changeId: string; note?: "WITHDRAWN" | "UPGRADED" }): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(opts.changeId)) return { ok: false, message: "That change is not one of yours." };
  const r = await withTenant(opts.orgId, (sql) => sql`
    UPDATE plan_changes SET status = 'CANCELLED', note = ${opts.note ?? "WITHDRAWN"}, decided_at = now()
    WHERE org_id = ${opts.orgId} AND id = ${opts.changeId} AND status = 'PENDING'`);
  if (!r.count) return { ok: false, message: "That change already happened or was withdrawn." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "billing.plan_change_withdrawn", targetType: "plan_change", targetId: opts.changeId, metadata: { note: opts.note ?? "WITHDRAWN" } });
  return { ok: true };
}

/**
 * Apply every move to a smaller plan that is due, on the owner's
 * connection (the operator's sweep): the plan ends on the first of the
 * month and the smaller one starts that day, its terms frozen as sold. A
 * firm still running more projects than the smaller plan covers keeps its
 * plan, and the change says why.
 */
export async function applyPlanChanges(owner: import("postgres").Sql, nowIso = new Date().toISOString()): Promise<{ applied: number; refused: number }> {
  const today = istDate(nowIso);
  const due = await owner<{ id: string; org_id: string; subscription_id: string; to_plan: string; effective_on: string }[]>`
    SELECT id, org_id, subscription_id, to_plan, effective_on::text AS effective_on FROM plan_changes
    WHERE status = 'PENDING' AND effective_on <= ${today}::date`;
  let applied = 0;
  let refused = 0;
  for (const c of due) {
    const to = readPlanKey(c.to_plan);
    if (!to) continue;
    const result = await owner.begin(async (tx) => {
      const [sub] = await tx<{ id: string; ends_on: string | null }[]>`
        SELECT id, ends_on::text AS ends_on FROM subscriptions WHERE id = ${c.subscription_id} AND org_id = ${c.org_id} FOR UPDATE`;
      const [{ n }] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM scope_nodes s
        WHERE s.org_id = ${c.org_id} AND s.kind = 'PROJECT'
          AND NOT EXISTS (SELECT 1 FROM project_states ps WHERE ps.org_id = s.org_id AND ps.project_id = s.id AND ps.status = 'RETIRED')`;
      const terms = termsFor(to, "ORG");
      const why = !sub || (sub.ends_on && sub.ends_on <= c.effective_on) ? "PLAN_ENDED" : n > (terms.projects ?? 0) ? "TOO_MANY_PROJECTS" : null;
      if (why) {
        await tx`UPDATE plan_changes SET status = 'CANCELLED', note = ${why}, decided_at = now() WHERE id = ${c.id} AND status = 'PENDING'`;
        return "refused" as const;
      }
      await tx`UPDATE subscriptions SET ends_on = ${c.effective_on} WHERE id = ${sub!.id}`;
      await tx`
        INSERT INTO subscriptions (org_id, project_id, scope, plan, status, cycle, starts_on, ends_on, terms, extra_channels, extra_agents, extra_numbers, setup_paise)
        VALUES (${c.org_id}, NULL, 'ORG', ${to}, 'ACTIVE', 'MONTHLY', ${c.effective_on}, NULL, ${tx.json(terms as never)}, 0, ${[] as string[]}, 0, 0)`;
      await tx`UPDATE plan_changes SET status = 'APPLIED', decided_at = now() WHERE id = ${c.id}`;
      return "applied" as const;
    });
    if (result === "applied") applied++;
    else refused++;
    await owner`
      INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (${c.org_id}, NULL, ${result === "applied" ? "billing.plan_change_applied" : "billing.plan_change_refused"}, 'plan_change', ${c.id},
              ${owner.json({ to, effective_on: c.effective_on } as never)})`;
  }
  return { applied, refused };
}

export { readTerms };
