import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import { planLabel, draftInvoice, isStateCode, istDate, readTerms, sellerFromEnv, termsFor, testSeller, type InvoiceLine, type PlanKey, type PlanTerms } from "./billing-rules.ts";
import { monthPaid } from "./plan-renewal.ts";
import { buyerOf, issueInvoice } from "./invoice.ts";
import { planPurchaseOpen, razorpay, razorpayConfig } from "./razorpay.ts";
import { insertProject, projectProblem, readNewProject, type Inserted, type NewProject } from "./project-insert.ts";
import { PLAN_RANK, firstPaymentLines, planRequired, planScopeFor, projectGate, readPlanKey, upgradeLines, type PlanScope, type ProjectGate } from "./plan-purchase-rules.ts";
import type { Checkout } from "./billing-pay.ts";

/**
 * Buying a plan in the console, the server half of `plan-purchase-rules.ts`.
 *
 * A developer or a mandate firm pays the first month of a plan for one
 * project in Checkout, and the project and its plan are written together
 * when the payment settles, in `settle()`'s own transaction. A channel
 * partner pays once for its whole firm. The payment row carries what was
 * bought (0083), and the database lets the app write a subscription only
 * from a paid payment for exactly that plan.
 */

type Head = {
  /** Plans this tenant has held, for the setup fee. */
  earlierPlans: number;
  hadPilot: boolean;
  /** Project plans covering today. */
  activeNow: number;
  /** A channel partner's firm-wide plan covering today. */
  firmPlan: PlanTerms | null;
  projects: number;
};

async function headOf(sql: TransactionSql, orgId: string, today: string): Promise<Head> {
  const subs = await sql<{ plan: string; status: string; scope: string; starts_on: string; ends_on: string | null; terms: unknown }[]>`
    SELECT plan, status, scope, starts_on::text AS starts_on, ends_on::text AS ends_on, terms
    FROM subscriptions WHERE org_id = ${orgId}`;
  const covers = (s: { starts_on: string; ends_on: string | null }) => s.starts_on <= today && (!s.ends_on || today < s.ends_on);
  const firm = subs.find((s) => s.scope === "ORG" && covers(s));
  // A retired project frees its slot on a channel partner's firm plan.
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM scope_nodes s
    WHERE s.org_id = ${orgId} AND s.kind = 'PROJECT'
      AND NOT EXISTS (SELECT 1 FROM project_states ps WHERE ps.org_id = s.org_id AND ps.project_id = s.id AND ps.status = 'RETIRED')`;
  return {
    earlierPlans: subs.filter((s) => s.status === "ACTIVE").length,
    hadPilot: subs.some((s) => s.status === "PILOT"),
    activeNow: subs.filter((s) => s.scope === "PROJECT" && s.status === "ACTIVE" && covers(s)).length,
    firmPlan: firm && readPlanKey(firm.plan) ? readTerms(readPlanKey(firm.plan)!, firm.terms, "ORG") : null,
    projects: n,
  };
}

export type PlanContext = {
  scope: PlanScope;
  required: boolean;
  /** A plan can be paid for here now. */
  open: boolean;
  test: boolean;
  gate: ProjectGate;
  /** The place of supply; null until billing details say it. */
  buyerState: string | null;
  sellerState: string;
  earlierPlans: number;
  hadPilot: boolean;
  activeNow: number;
  today: string;
  /** A channel partner on a firm plan it may move up from. */
  upgrade: { from: PlanKey; fromPricePaise: number; prepaid: boolean; startsToday: boolean } | null;
};

/** What the plan picker and the new-project screen need, priced as the server prices it. */
export async function planContext(orgId: string, orgType: string | null, nowIso = new Date().toISOString()): Promise<PlanContext> {
  const today = istDate(nowIso);
  const scope = planScopeFor(orgType);
  const required = planRequired(process.env);
  const got = await withTenant(orgId, async (sql) => {
    const head = await headOf(sql, orgId, today);
    const [cur] = scope === "ORG" && head.firmPlan
      ? await sql<{ plan: string; starts_on: string; payment_id: string | null; terms: unknown }[]>`
          SELECT plan, starts_on::text, payment_id, terms FROM subscriptions
          WHERE org_id = ${orgId} AND scope = 'ORG' AND starts_on <= ${today}::date AND (ends_on IS NULL OR ends_on > ${today}::date)
          ORDER BY starts_on DESC LIMIT 1`
      : [];
    return { head, buyer: await buyerOf(sql, orgId), cur: cur ?? null, monthPaid: cur ? await monthPaid(sql, orgId, today) : false };
  });
  const from = got.cur ? readPlanKey(got.cur.plan) : null;
  const cfg = razorpayConfig();
  const test = cfg.ok && cfg.config.test;
  const real = sellerFromEnv(process.env);
  return {
    scope,
    required,
    open: planPurchaseOpen(),
    test,
    gate: projectGate({ required, scope, firmPlan: got.head.firmPlan, projects: got.head.projects }),
    buyerState: got.buyer?.state ?? null,
    sellerState: test || !real.ok ? testSeller(process.env).state : real.seller.state,
    earlierPlans: got.head.earlierPlans,
    hadPilot: got.head.hadPilot,
    activeNow: got.head.activeNow,
    today,
    upgrade:
      got.cur && from && from !== "SCALE"
        ? {
            from,
            fromPricePaise: readTerms(from, got.cur.terms, "ORG").pricePaise,
            prepaid: (!!got.cur.payment_id && got.cur.starts_on >= `${today.slice(0, 7)}-01`) || got.monthPaid,
            startsToday: got.cur.starts_on >= today,
          }
        : null,
  };
}

/** Whether a project may be created through the plain form now, and why not. */
export async function gateFor(orgId: string, orgType: string | null): Promise<ProjectGate> {
  const required = planRequired(process.env);
  if (!required) return { kind: "FREE" };
  const scope = planScopeFor(orgType);
  if (scope === "PROJECT") return { kind: "BUY_WITH_PROJECT" };
  const head = await withTenant(orgId, (sql) => headOf(sql, orgId, istDate(new Date().toISOString())));
  return projectGate({ required, scope, firmPlan: head.firmPlan, projects: head.projects });
}

const CLOSED = "Plans can't be bought here yet. Write to us and we'll set yours up.";

export type PlanItem = { sku: string; qty: number; unit: "PLAN"; units: number; pricePaise: number; description: string };

/**
 * Start paying for a plan: everything is checked before Razorpay is asked,
 * so nobody pays for a project that would be refused or a plan they hold.
 */
export async function startPlanPurchase(opts: {
  orgId: string;
  userId: string;
  userEmail?: string | null;
  orgType: string | null;
  plan: unknown;
  /** A project to create on payment (developer, mandate firm). */
  newProject?: { entityId?: unknown; city?: unknown; name?: unknown } | null;
  /** An existing project with no plan today. */
  projectId?: string | null;
  nowIso?: string;
}): Promise<{ ok: true; checkout: Checkout } | { ok: false; message: string }> {
  const plan = readPlanKey(opts.plan);
  if (!plan) return { ok: false, message: "Choose a plan." };
  if (!["DEVELOPER", "MANDATE_FIRM", "CHANNEL_PARTNER"].includes(opts.orgType ?? "")) return { ok: false, message: CLOSED };
  const cfg = razorpayConfig();
  if (!cfg.ok || !planPurchaseOpen()) return { ok: false, message: CLOSED };
  const test = cfg.config.test;
  const real = sellerFromEnv(process.env);
  const seller = test ? testSeller(process.env) : real.ok ? real.seller : null;
  if (!seller) return { ok: false, message: CLOSED };

  const scope = planScopeFor(opts.orgType);
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const today = istDate(nowIso);
  let newProject: NewProject | null = null;
  if (scope === "PROJECT" && !opts.projectId) {
    const read = readNewProject(opts.newProject ?? {});
    if (!read.ok) return read;
    newProject = read.project;
  }

  const checked = await withTenant(opts.orgId, async (sql) => {
    const head = await headOf(sql, opts.orgId, today);
    let forName = "";
    let upgrade: { subId: string; from: PlanKey; fromPricePaise: number; prepaid: boolean } | null = null;
    if (scope === "ORG") {
      const [o] = await sql<{ name: string }[]>`SELECT display_name AS name FROM orgs WHERE id = ${opts.orgId}`;
      forName = o?.name ?? "Your firm";
      if (head.firmPlan) {
        // Moving up: only to a bigger plan, and not on the day the plan began.
        const [cur] = await sql<{ id: string; plan: string; starts_on: string; payment_id: string | null; terms: unknown }[]>`
          SELECT id, plan, starts_on::text, payment_id, terms FROM subscriptions
          WHERE org_id = ${opts.orgId} AND scope = 'ORG' AND starts_on <= ${today}::date AND (ends_on IS NULL OR ends_on > ${today}::date)
          ORDER BY starts_on DESC LIMIT 1`;
        const from = cur ? readPlanKey(cur.plan) : null;
        if (!cur || !from || PLAN_RANK[plan] <= PLAN_RANK[from]) return { ok: false as const, message: `Your firm is already on ${head.firmPlan.label}. Choose a bigger plan to move up.` };
        if (cur.starts_on >= today) return { ok: false as const, message: "Your plan began today. You can move to a bigger plan from tomorrow." };
        upgrade = {
          subId: cur.id,
          from,
          fromPricePaise: readTerms(from, cur.terms, "ORG").pricePaise,
          // This month of the plan was paid: bought in the console this month, or renewed.
          prepaid: (!!cur.payment_id && cur.starts_on >= `${today.slice(0, 7)}-01`) || (await monthPaid(sql, opts.orgId, today)),
        };
      }
    } else if (newProject) {
      const problem = await projectProblem(sql, opts.orgId, newProject);
      if (problem) return { ok: false as const, message: problem.message };
      forName = newProject.name;
    } else {
      const [p] = await sql<{ id: string; name: string; planned: boolean }[]>`
        SELECT n.id, n.name, EXISTS (
          SELECT 1 FROM subscriptions s WHERE s.project_id = n.id AND s.starts_on <= ${today}::date
            AND (s.ends_on IS NULL OR s.ends_on > ${today}::date)) AS planned
        FROM scope_nodes n WHERE n.org_id = ${opts.orgId} AND n.id = ${opts.projectId ?? null} AND n.kind = 'PROJECT'`;
      if (!p) return { ok: false as const, message: "That project isn't one of yours." };
      if (p.planned) return { ok: false as const, message: `${p.name} already has a plan.` };
      forName = p.name;
    }
    const buyer = await buyerOf(sql, opts.orgId);
    if (!buyer) return { ok: false as const, message: "Add the state you are billed in, under Billing details, before buying a plan." };
    return { ok: true as const, head, forName, buyer, upgrade };
  });
  if (!checked.ok) return checked;

  const lines = checked.upgrade
    ? upgradeLines({ from: checked.upgrade.from, fromPricePaise: checked.upgrade.fromPricePaise, to: plan, today, forName: checked.forName, prepaid: checked.upgrade.prepaid })
    : firstPaymentLines({
    plan,
    scope,
    today,
    forName: checked.forName,
    earlierPlans: checked.head.earlierPlans,
    hadPilot: checked.head.hadPilot,
    activeAfter: checked.head.activeNow + (scope === "PROJECT" ? 1 : 0),
  });
  const draft = draftInvoice(lines, seller, checked.buyer);

  let order;
  try {
    order = await razorpay().createOrder(cfg.config, {
      amountPaise: draft.totalPaise,
      receipt: `estp_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      notes: { org: opts.orgId, plan },
    });
  } catch (e) {
    console.error("billing: Razorpay refused the plan order", e);
    return { ok: false, message: "The payment could not be started. Try again in a minute." };
  }
  const items: PlanItem[] = lines.map((l, i) => ({
    sku: i === 0 ? `PLAN_${plan}` : "SETUP",
    qty: l.qty,
    unit: "PLAN",
    units: 0,
    pricePaise: Math.round(l.qty * l.unitPaise),
    description: l.description,
  }));
  await withTenant(opts.orgId, async (sql) => {
    await sql`SELECT billing_open_account()`;
    await sql`
      INSERT INTO payments (org_id, order_id, items, taxable_paise, tax_paise, total_paise, test, created_by,
                            purpose, plan, plan_scope, project_id, new_project, upgrade_of)
      VALUES (${opts.orgId}, ${order.id}, ${sql.json(items as never)}, ${draft.taxablePaise}, ${draft.totalPaise - draft.taxablePaise},
              ${draft.totalPaise}, ${test}, ${opts.userId}, 'PLAN', ${plan}, ${scope},
              ${scope === "PROJECT" && !newProject ? (opts.projectId ?? null) : null},
              ${newProject ? sql.json(newProject as never) : null}, ${checked.upgrade?.subId ?? null})`;
  });
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "billing.plan_started",
    targetType: "org",
    targetId: opts.orgId,
    metadata: { plan, scope, new_project: !!newProject, total_paise: draft.totalPaise, test, upgrade: checked.upgrade?.from ?? null },
  });
  return {
    ok: true,
    checkout: {
      key: cfg.config.keyId,
      orderId: order.id,
      amountPaise: draft.totalPaise,
      test,
      description: checked.upgrade
        ? `Move to the ${planLabel(plan, scope)} plan`
        : `${planLabel(plan, scope)} plan${scope === "ORG" ? " for your firm" : `, ${checked.forName}`}`,
      prefill: { name: checked.buyer.name, email: opts.userEmail ?? null },
    },
  };
}

export type PlanPaid = { projectId: string | null; inserted: Inserted | null; plan: PlanKey; scope: PlanScope; userId: string | null };

type PlanPaymentRow = {
  id: string;
  test: boolean;
  plan: PlanKey;
  plan_scope: PlanScope;
  project_id: string | null;
  new_project: NewProject | null;
  items: PlanItem[];
  created_by: string | null;
  upgrade_of: string | null;
};

/**
 * Inside `settle()`'s transaction, once the payment is PAID: write the
 * project when it was bought with one, then its plan, make the tenant LIVE
 * when the money was real, and issue the invoice.
 */
export async function settlePlanPayment(
  sql: TransactionSql,
  orgId: string,
  paymentId: string,
  nowIso: string,
  actor: string | null,
): Promise<{ invoiceId: string; paid: PlanPaid }> {
  const [p] = await sql<PlanPaymentRow[]>`
    SELECT id, test, plan, plan_scope, project_id, new_project, items, created_by, upgrade_of
    FROM payments WHERE org_id = ${orgId} AND id = ${paymentId}`;
  // Moving up: the plan it replaces ends today, before the bigger one starts.
  if (p.upgrade_of) {
    await sql`
      UPDATE subscriptions SET ends_on = (SELECT (paid_at AT TIME ZONE 'Asia/Kolkata')::date FROM payments WHERE id = ${p.id})
      WHERE org_id = ${orgId} AND id = ${p.upgrade_of} AND scope = 'ORG' AND ends_on IS NULL`;
    // A move to a smaller plan asked for before is called off by moving up.
    await sql`
      UPDATE plan_changes SET status = 'CANCELLED', note = 'UPGRADED', decided_at = now()
      WHERE org_id = ${orgId} AND status = 'PENDING'`;
  }
  let projectId = p.project_id;
  let inserted: Inserted | null = null;
  if (p.plan_scope === "PROJECT" && !projectId && p.new_project) {
    const made = await insertProject(sql, orgId, p.new_project, { renameOnClash: true });
    if (!made.ok) throw new Error(`billing: a paid plan's project could not be written (${made.code})`);
    inserted = made;
    projectId = made.id;
  }
  if (p.plan_scope === "PROJECT" && !projectId) throw new Error("billing: a paid plan names no project");
  const setup = p.items.filter((i) => i.sku === "SETUP").reduce((s, i) => s + i.pricePaise, 0);
  await sql`
    INSERT INTO subscriptions (org_id, project_id, scope, plan, status, cycle, starts_on, terms, setup_paise, payment_id, created_by)
    VALUES (${orgId}, ${p.plan_scope === "PROJECT" ? projectId : null}, ${p.plan_scope}, ${p.plan}, 'ACTIVE', 'MONTHLY',
            ${istDate(nowIso)}, ${sql.json(termsFor(p.plan, p.plan_scope === "ORG" ? "ORG" : "PROJECT") as never)}, ${setup}, ${p.id}, ${actor ?? p.created_by})`;
  if (!p.test) await sql`SELECT billing_go_live(${p.id})`;

  const buyer = await buyerOf(sql, orgId);
  if (!buyer) throw new Error("billing: a paid organisation has no billing state");
  const seller = p.test ? { seller: testSeller(process.env), bank: null } : (() => {
    const s = sellerFromEnv(process.env);
    if (!s.ok) throw new Error(`billing: seller not configured (${s.missing.join(", ")})`);
    return s;
  })();
  const lines: Omit<InvoiceLine, "amountPaise" | "sac">[] = p.items.map((i) => ({
    description: inserted && i.description.startsWith(`${p.new_project?.name}:`) ? `${inserted.name}${i.description.slice(p.new_project!.name.length)}` : i.description,
    qty: i.qty,
    unitPaise: i.qty ? Math.round(i.pricePaise / i.qty) : i.pricePaise,
  }));
  const inv = await issueInvoice(sql, {
    orgId,
    purpose: "PLAN",
    test: p.test,
    lines,
    seller: seller.seller,
    bank: seller.bank,
    buyer,
    issuedOn: istDate(nowIso),
    paymentId: p.id,
    createdBy: actor,
  });
  return { invoiceId: inv.id, paid: { projectId, inserted, plan: p.plan, scope: p.plan_scope, userId: actor ?? p.created_by } };
}

/**
 * The state a first plan is billed in, when the organisation has no GSTIN
 * to say it (a broker firm often has none). Opens the billing account and
 * fills the state only where nothing says it yet.
 */
export async function setBillingState(orgId: string, userId: string, state: string): Promise<boolean> {
  if (!isStateCode(state)) return false;
  await withTenant(orgId, async (sql) => {
    await sql`SELECT billing_open_account()`;
    await sql`
      UPDATE billing_accounts SET bill_state = ${state}, updated_by = ${userId}, updated_at = now()
      WHERE org_id = ${orgId} AND bill_state IS NULL`;
  });
  return true;
}

/** The organisation's own kind, read inside its tenant. */
export async function orgTypeOf(orgId: string): Promise<string | null> {
  const [r] = await withTenant(orgId, (sql) => sql<{ type: string }[]>`SELECT type FROM orgs WHERE id = ${orgId}`);
  return r?.type ?? null;
}
