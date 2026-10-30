/**
 * Billing, end to end, with Sarvam and Razorpay injected.
 *
 * It builds two organisations of its own, sells a plan through the
 * operator's script, and drives the real functions against the real
 * database: the order a paid call is refused in (allowance, then top-ups,
 * then a refusal, all before the vendor is asked), metering that counts an
 * outcome once however often it is reported, a post that did not pass
 * counting for nothing, a top-up past its date never spent, a purchase
 * settled once whichever of Checkout and the webhook arrives first, a
 * GST invoice numbered and taxed the way Rule 46 asks, a credit note that
 * corrects one the way Rule 53 asks and takes the unused top-up back, and
 * an automatic top-up that records in shadow mode, announces before it
 * charges, waits for the client over Rs 15,000, stops at its monthly
 * limit and looks for a lost answer before charging again.
 *
 * Nothing rings and nothing is charged. It removes everything it made.
 */
import { createHmac, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import postgres from "postgres";
import { useSarvam } from "../src/lib/sarvam.ts";
import { useRazorpay } from "../src/lib/razorpay.ts";
import { ingestWebhook, placeCall } from "../src/lib/calling.ts";
import { callAllowance, entitle, expireLots, meter, meterPost, meterVideo, overview, billingAlerts, billingQueue } from "../src/lib/billing.ts";
import { approveAutoCharge, autoTopUpView, cancelAutoCharge, runAutoTopUp, saveAutoTopUp } from "../src/lib/auto-topup.ts";
import { confirmTopUp, ingestRazorpay, startTopUp } from "../src/lib/billing-pay.ts";
import { invoicePdf, listInvoices } from "../src/lib/invoice.ts";
import { confirmMandateSetup, mandateSetupState, startMandateSetup, stopMandate, sweepMandateSetups } from "../src/lib/mandate-setup.ts";
import { monthOf, PARTNER_PLANS } from "../src/lib/billing-rules.ts";
import { saveCaps } from "../src/lib/project-caps.ts";
import { closeDb, withTenant } from "../src/lib/db/index.ts";
import { gateFor, setBillingState, startPlanPurchase } from "../src/lib/plan-purchase.ts";
import { gateRefusal, upgradeLines } from "../src/lib/plan-purchase-rules.ts";
import { insertProject } from "../src/lib/project-insert.ts";
import { applyPlanChanges, cancelDowngrade, downgradeView, payRenewal, renewalsFor, requestDowngrade, runPlanRenewal } from "../src/lib/plan-renewal.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

for (const [k, v] of Object.entries({
  SARVAM_AGENTS_KEY: "test-key",
  SARVAM_ORG_ID: "test-org",
  SARVAM_WORKSPACE_ID: "test-ws",
  SARVAM_APP_ID: "test-app",
  SARVAM_APP_VERSION: "3",
  SARVAM_CONNECTION_ID: "test-conn",
  SARVAM_FROM_NUMBER: "+912265480217",
  CALLS_WEBHOOK_BASE: "https://example.test",
})) process.env[k] ??= v;
// Razorpay's test mode, faked in this process: nothing reaches Razorpay.
process.env.RAZORPAY_KEY_ID = "rzp_test_check";
process.env.RAZORPAY_KEY_SECRET = "check-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "check-webhook-secret";
delete process.env.BILLING_SELLER_GSTIN;
process.env.BILLING_SELLER_STATE = "27";

const asked: string[] = [];
useSarvam({
  async placeOutbound(_c, req) {
    asked.push(req.toNumber);
    return { attemptId: `bill-att-${asked.length}` };
  },
  async getRecording() {
    return null;
  },
  async listAttempts() {
    return [];
  },
  async getTranscript() {
    return [];
  },
});
const orders: { amountPaise: number }[] = [];
// The recurring charges an automatic top-up made: kept by payment id, so a
// lost answer can be looked for the way Razorpay's order payments answer.
const recurring = new Map<string, { orderId: string; amount: number; token: string }>();
let loseNextAnswer = false;
// A mandate's authorisation as Razorpay would hold it: the payment Checkout
// made against the set-up's order, its token and the bank's word on it.
const mandateOrders: { id: string; customerId: string; method: string; maxAmountPaise: number; amountPaise: number }[] = [];
const mandatePayments = new Map<string, { orderId: string; status: string; amount: number; tokenId: string; customerId: string; email: string; contact: string }>();
const tokenStates = new Map<string, "confirmed" | "pending" | "rejected">();
useRazorpay({
  async createOrder(_c, req) {
    orders.push({ amountPaise: req.amountPaise });
    return { id: `order_check_${randomUUID().slice(0, 8)}`, amount: req.amountPaise, currency: "INR", status: "created" };
  },
  async fetchPayment(_c, id) {
    const m = mandatePayments.get(id);
    if (m) return { id, orderId: m.orderId, status: m.status, amount: m.amount, tokenId: m.tokenId, customerId: m.customerId, email: m.email, contact: m.contact };
    const r = recurring.get(id);
    return { id, orderId: r?.orderId ?? null, status: "captured", amount: r?.amount ?? 0 };
  },
  async createCustomer() {
    return { id: "cust_checkmandate1" };
  },
  async createMandateOrder(_c, req) {
    const id = `order_mdt_${randomUUID().slice(0, 8)}`;
    mandateOrders.push({ id, customerId: req.customerId, method: req.method, maxAmountPaise: req.maxAmountPaise, amountPaise: req.amountPaise });
    return { id, amount: req.amountPaise, currency: "INR", status: "created" };
  },
  async fetchToken(_c, _customer, tokenId) {
    return { id: tokenId, state: tokenStates.get(tokenId) ?? "pending" };
  },
  async createRefund() {
    throw new Error("refunds are the operator's script's, answered by the fake over HTTP");
  },
  async paymentRefunds() {
    return [];
  },
  async createRecurringPayment(_c, req) {
    const id = `pay_auto_${randomUUID().slice(0, 8)}`;
    recurring.set(id, { orderId: req.orderId, amount: req.amountPaise, token: req.token });
    if (loseNextAnswer) {
      loseNextAnswer = false;
      throw new Error("Razorpay: the connection closed before an answer");
    }
    return { paymentId: id };
  },
  async orderPayments(_c, orderId) {
    return [
      ...[...recurring.entries()].filter(([, r]) => r.orderId === orderId).map(([id, r]) => ({ id, orderId, status: "captured", amount: r.amount })),
      ...[...mandatePayments.entries()].filter(([, m]) => m.orderId === orderId).map(([id, m]) => ({ id, orderId, status: m.status, amount: m.amount })),
    ];
  },
});

// The operator's script runs in a process of its own, so its refunds go to
// Razorpay's own addresses on a fake here (`RAZORPAY_BASE_URL`, the checks'
// seam): the payments it knows, the refunds it made, and an answer it can lose.
const gatewayPayments = new Map<string, number>();
const refundsMade: { id: string; payment_id: string; amount: number; status: string; receipt: string | null; notes: Record<string, string> }[] = [];
let loseNextRefund = false;
const fake = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const send = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };
  const m = /^\/v1\/payments\/([^/]+)(\/refunds?)?$/.exec(req.url ?? "");
  if (!m) return send(404, { error: { description: "not faked" } });
  const pid = decodeURIComponent(m[1]);
  const amount = gatewayPayments.get(pid);
  if (amount === undefined) return send(400, { error: { description: "The id provided does not exist" } });
  const refunded = refundsMade.filter((r) => r.payment_id === pid && r.status !== "failed").reduce((s, r) => s + r.amount, 0);
  if (!m[2]) return send(200, { id: pid, order_id: null, status: "captured", amount, amount_refunded: refunded });
  if (m[2] === "/refunds") return send(200, { items: refundsMade.filter((r) => r.payment_id === pid) });
  if (refunded + body.amount > amount) return send(400, { error: { description: "The refund amount provided is greater than amount captured" } });
  const r = { id: `rfnd_${randomUUID().replace(/-/g, "").slice(0, 14)}`, payment_id: pid, amount: body.amount, status: "processed", receipt: body.receipt ?? null, notes: body.notes ?? {} };
  refundsMade.push(r);
  if (loseNextRefund) {
    loseNextRefund = false;
    req.socket.destroy();
    return;
  }
  send(200, r);
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
process.env.RAZORPAY_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;

// The next noon in IST after now, so calls are inside calling hours; the
// month is that noon's month, so the plan covers the whole of it.
const NOON = (() => {
  const ist = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  let t = Date.parse(`${ist}T06:30:00Z`);
  if (t < Date.now()) t += 86_400_000;
  return new Date(t).toISOString();
})();
const { period } = monthOf(NOON);

const tag = Date.now().toString(36);
const [admin] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`admin@bill${tag}.example`}, ${`bill${tag}.example`}, 'Bina Billing') RETURNING id`;

async function tenant(name: string, slug: string) {
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', ${name}, ${name}, 'AAPFU0939F', ${`${slug}.example`}, ${admin.id}) RETURNING id`;
  const [root] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, NULL, 'ORG', ${name}, ${slug}, ${slug}::ltree) RETURNING id, path::text AS path`;
  const node = async (parent: { id: string; path: string }, kind: string, n: string, s: string) => {
    const [row] = await sql<{ id: string; path: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${org.id}, ${parent.id}, ${kind}, ${n}, ${s}, ${`${parent.path}.${s}`}::ltree) RETURNING id, path::text AS path`;
    return row;
  };
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${org.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
  return { orgId: org.id, root, node };
}

const A = await tenant("Billing Heights", `bill_a_${tag}`);
const B = await tenant("Other Billing", `bill_b_${tag}`);
const entity = await A.node(A.root, "ENTITY", "Billing Heights LLP", "llp");
const pune = await A.node(entity, "REGION", "Pune", "pune");
const heights = await A.node(pune, "PROJECT", "Heights", "heights");
const towerC = await A.node(heights, "PHASE", "Tower C", "tower_c");
const trees = await A.node(pune, "PROJECT", "Trees", "trees");
const treesP1 = await A.node(trees, "PHASE", "Phase 1", "phase_1");
const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
for (const p of [towerC, treesP1]) {
  await sql`
    INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, promoter_name, valid_to, verified_at)
    VALUES (${p.id}, ${A.orgId}, 'VERIFIED', ${p === towerC ? "P52100012345" : "P52100054321"}, 'MH', 'Billing Heights LLP', ${FAR}, now())`;
}
const bEntity = await B.node(B.root, "ENTITY", "Other LLP", "llp");
const bRegion = await B.node(bEntity, "REGION", "Mumbai", "mumbai");
const bProject = await B.node(bRegion, "PROJECT", "Other Towers", "other");

let phoneNo = 9_000_000_300;
const lead = async (nodeId: string) => {
  const phone = `+91${phoneNo++}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, enquired_at) VALUES (${A.orgId}, ${nodeId}, 'Buyer', ${phone}, now()) RETURNING id`;
  return row.id;
};

const billing = (...args: string[]) =>
  execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/billing.mts", ...args], { env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
// Without blocking this process, so the fake Razorpay above can answer the script.
const billingAsync = async (...args: string[]): Promise<{ out: string; err: string; ok: boolean }> => {
  try {
    const r = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/billing.mts", ...args], { env: process.env, encoding: "utf8" });
    return { out: r.stdout, err: r.stderr, ok: true };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { out: x.stdout ?? "", err: x.stderr ?? "", ok: false };
  }
};

const walletOf = async (orgId: string, unit: string) => {
  const [r] = await sql<{ left: string }[]>`
    SELECT coalesce(sum(c.qty - coalesce((SELECT sum(d.qty) FROM wallet_entries d WHERE d.lot_id = c.id), 0)), 0) AS left
    FROM wallet_entries c
    WHERE c.org_id = ${orgId} AND c.unit = ${unit} AND c.kind = 'CREDIT' AND c.expires_at > now()`;
  return Number(r.left);
};
const refusedAs = (e: unknown) => (e as { code?: string }).code;
const planOrgs: string[] = [];
const signPlan = (m: string, k: string) => createHmac("sha256", k).update(m).digest("hex");

try {
  console.log("\nNo plan sold: metered, never refused");
  const free = await entitle({ orgId: A.orgId, nodeId: towerC.id, needs: [{ unit: "VIDEO", qty: 5 }], nowIso: NOON });
  check("an organisation with no plan is not refused", free.ok && !free.billed);
  await meter({ orgId: A.orgId, nodeId: towerC.id, kind: "IMAGE_POST", qty: 1, costPaise: 1_700, billable: true, source: { kind: "post", id: `pre-${tag}` }, atIso: NOON });
  const [pre] = await sql`SELECT plan, from_allowance, qty FROM usage_events WHERE org_id = ${A.orgId} AND source_id = ${`pre-${tag}`}`;
  check("its use is still metered, against no plan", pre && pre.plan === null && Number(pre.qty) === 1);

  console.log("\nA plan is the operator's to sell");
  for (const [name, attempt] of [
    ["the app role cannot sell itself a plan", () => withTenant(A.orgId, (tx) => tx`
      INSERT INTO subscriptions (org_id, project_id, plan, status, starts_on, terms) VALUES (${A.orgId}, ${heights.id}, 'SCALE', 'ACTIVE', ${period}, '{}'::jsonb)`)],
    ["the app role cannot switch billing on or off", () => withTenant(A.orgId, (tx) => tx`
      INSERT INTO billing_accounts (org_id, mode) VALUES (${A.orgId}, 'SHADOW')`)],
    ["the app role cannot give itself credit", () => withTenant(A.orgId, (tx) => tx`
      INSERT INTO wallet_entries (org_id, kind, unit, qty, expires_at, source) VALUES (${A.orgId}, 'CREDIT', 'VIDEO', 5, now() + interval '1 year', 'GRANT')`)],
  ] as const) {
    try {
      await attempt();
      check(name, false, "it succeeded");
    } catch (e) {
      check(name, refusedAs(e) === "42501", refusedAs(e));
    }
  }
  const out = billing("plan", "--org", A.orgId, "--project", "Heights", "--plan", "LAUNCH", "--from", period);
  check("the operator's script sells Heights a Launch plan", /Launch from/.test(out), out);
  const [sub] = await sql`SELECT plan, status, terms, setup_paise FROM subscriptions WHERE project_id = ${heights.id}`;
  check("the plan's terms are frozen onto it", sub?.terms?.allowance?.MINUTE === 1500 && sub?.terms?.allowance?.VIDEO === 5);
  check("the first project carries the full setup fee", Number(sub?.setup_paise) === 49_999_00);
  const [mode] = await sql`SELECT mode FROM billing_accounts WHERE org_id = ${A.orgId}`;
  check("and the organisation is billed in shadow mode", mode?.mode === "SHADOW");
  const [{ n: audited }] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${A.orgId} AND action = 'billing.plan_set'`;
  check("the sale is audited", audited === 1);

  console.log("\nA project with no plan, in an organisation that has one");
  const none = await entitle({ orgId: A.orgId, nodeId: treesP1.id, needs: [{ unit: "IMAGE", qty: 1 }], nowIso: NOON });
  check("nothing that costs money runs for it", !none.ok && none.code === "NO_PLAN");
  const before = asked.length;
  const noPlanCall = await placeCall({ orgId: A.orgId, userId: admin.id, leadId: await lead(treesP1.id), nowIso: NOON });
  check("and no call is placed", !noPlanCall.ok && noPlanCall.code === "NO_PLAN" && asked.length === before, JSON.stringify(noPlanCall));

  console.log("\nMinutes: the allowance, then the top-ups, then a refusal, before Sarvam");
  await meter({ orgId: A.orgId, nodeId: towerC.id, kind: "CALL_MINUTE", qty: 1_500, costPaise: 0, billable: true, source: { kind: "call", id: `used-${tag}` }, atIso: NOON });
  const spent = await callAllowance({ orgId: A.orgId, nodeId: towerC.id, agent: "qualifier", nowIso: NOON });
  check("with the month's 1,500 minutes used and no top-ups, a call is refused", spent.billed && !spent.ok && spent.code === "USED_UP");
  const n0 = asked.length;
  const refused = await placeCall({ orgId: A.orgId, userId: admin.id, leadId: await lead(towerC.id), nowIso: NOON });
  check("placeCall refuses it", !refused.ok && refused.code === "ALLOWANCE", JSON.stringify(refused));
  check("and Sarvam was never asked", asked.length === n0);
  billing("grant", "--org", A.orgId, "--unit", "MINUTE", "--qty", "10");
  const placed = await placeCall({ orgId: A.orgId, userId: admin.id, leadId: await lead(towerC.id), nowIso: NOON });
  check("with a 10-minute top-up the call goes", placed.ok && asked.length === n0 + 1, JSON.stringify(placed));
  if (placed.ok) {
    const [row] = await sql`SELECT attempt_id FROM calls WHERE id = ${placed.callId}`;
    const payload = { attempt_id: row.attempt_id, status: "connected", duration: 125, final_agent_variables: { lead_disposition: "callback" } };
    await ingestWebhook(A.orgId, placed.callId, payload);
    await ingestWebhook(A.orgId, placed.callId, payload);
    const rows = await sql`SELECT qty, from_allowance, from_wallet FROM usage_events WHERE org_id = ${A.orgId} AND source_id = ${placed.callId}`;
    check("a 125-second call is 3 minutes, counted once however often it is reported", rows.length === 1 && Number(rows[0].qty) === 3, JSON.stringify(rows));
    check("and they come out of the top-up", Number(rows[0]?.from_wallet) === 3 && Number(rows[0]?.from_allowance) === 0);
    check("which now holds 7", (await walletOf(A.orgId, "MINUTE")) === 7);
  }

  console.log("\nAgents are jobs, and the plan says which");
  const reengage = await callAllowance({ orgId: A.orgId, nodeId: towerC.id, agent: "reengage", nowIso: NOON });
  check("the Re-engager is not on Launch", reengage.billed && !reengage.ok && reengage.code === "NOT_IN_PLAN");
  const n1 = asked.length;
  const notInPlan = await placeCall({ orgId: A.orgId, userId: admin.id, leadId: await lead(towerC.id), nowIso: NOON, agent: "reengage" });
  check("and its call is refused before Sarvam", !notInPlan.ok && notInPlan.code === "NOT_IN_PLAN" && asked.length === n1);
  const recovery = await callAllowance({ orgId: A.orgId, nodeId: towerC.id, agent: "recovery", nowIso: NOON });
  check("the Visit Confirmer's no-show call is", recovery.billed && recovery.ok && recovery.channels === 3);

  console.log("\nPosts: outcomes, never attempts");
  const failed = randomUUID();
  await meterPost({ orgId: A.orgId, nodeId: towerC.id, postId: failed, kind: "IMAGE", frames: 1, passed: false, attempts: 3, agentUsd: 0.02, atIso: NOON });
  const [f] = await sql`SELECT billable, qty, from_allowance, cost_paise FROM usage_events WHERE source_id = ${failed}`;
  check("a post that did not pass meters nothing billable", f && f.billable === false && Number(f.qty) === 0 && Number(f.from_allowance) === 0);
  check("and still records what its attempts cost us", Number(f?.cost_paise) === 3 * 850 + 182);
  const img = randomUUID();
  await meterPost({ orgId: A.orgId, nodeId: towerC.id, postId: img, kind: "IMAGE", frames: 1, passed: true, attempts: 1, atIso: NOON });
  await meterPost({ orgId: A.orgId, nodeId: towerC.id, postId: img, kind: "IMAGE", frames: 1, passed: true, attempts: 1, atIso: NOON });
  const imgs = await sql`SELECT from_allowance FROM usage_events WHERE source_id = ${img}`;
  check("a post that passed is one image, however often it is metered", imgs.length === 1 && Number(imgs[0].from_allowance) === 1);

  const seven = await entitle({ orgId: A.orgId, nodeId: towerC.id, needs: [{ unit: "CAROUSEL", qty: 1 }, { unit: "SLIDE", qty: 2 }], nowIso: NOON });
  check("a 7-slide carousel needs slide top-ups, and there are none", !seven.ok && seven.code === "USED_UP" && /slides/.test(seven.message));
  billing("grant", "--org", A.orgId, "--unit", "SLIDE", "--qty", "2");
  const sevenNow = await entitle({ orgId: A.orgId, nodeId: towerC.id, needs: [{ unit: "CAROUSEL", qty: 1 }, { unit: "SLIDE", qty: 2 }], nowIso: NOON });
  check("with two slides topped up it may be made", sevenNow.ok && sevenNow.billed);
  const car = randomUUID();
  await meterPost({ orgId: A.orgId, nodeId: towerC.id, postId: car, kind: "CAROUSEL", frames: 7, passed: true, attempts: 7, atIso: NOON });
  const carRows = await sql`SELECT kind, qty, from_allowance, from_wallet FROM usage_events WHERE source_id = ${car} ORDER BY kind`;
  check("it is one carousel from the allowance and two slides from the top-ups",
    carRows.length === 2 && Number(carRows[0].from_allowance) === 1 && carRows[1].kind === "EXTRA_SLIDE" && Number(carRows[1].from_wallet) === 2, JSON.stringify(carRows));

  console.log("\nVideos: one price for every kind, a new version counts two");
  const six = await entitle({ orgId: A.orgId, nodeId: towerC.id, needs: [{ unit: "VIDEO", qty: 6 }], nowIso: NOON });
  check("Launch carries five videos, so six at once are refused", !six.ok);
  const film = randomUUID();
  await meterVideo({ orgId: A.orgId, nodeId: towerC.id, postId: film, kind: "FILM", units: 1, passed: true, atIso: NOON });
  for (let i = 0; i < 2; i++) {
    await meterVideo({ orgId: A.orgId, nodeId: towerC.id, postId: randomUUID(), kind: "STORY_REEL", units: 1, passed: true, atIso: NOON });
  }
  const v2 = await entitle({ orgId: A.orgId, nodeId: towerC.id, needs: [{ unit: "VIDEO", qty: 2 }], nowIso: NOON });
  check("with two left, a film's new version (two videos) may be made", v2.ok);
  await meterVideo({ orgId: A.orgId, nodeId: towerC.id, postId: randomUUID(), kind: "FILM_VERSION", units: 2, passed: true, atIso: NOON });
  const one = await entitle({ orgId: A.orgId, nodeId: towerC.id, needs: [{ unit: "VIDEO", qty: 1 }], nowIso: NOON });
  check("after five videos the month's are gone", !one.ok && one.code === "USED_UP");
  const failedFilm = randomUUID();
  await meterVideo({ orgId: A.orgId, nodeId: towerC.id, postId: failedFilm, kind: "FILM", units: 1, passed: false, atIso: NOON });
  const [ff] = await sql`SELECT billable, cost_paise FROM usage_events WHERE source_id = ${failedFilm}`;
  check("a film that did not pass its checks is never charged, and costs us Rs 1,420", ff?.billable === false && Number(ff?.cost_paise) === 1_42_000);

  console.log("\nA top-up past its date is never spent");
  await sql`
    INSERT INTO wallet_entries (org_id, kind, unit, qty, expires_at, source)
    VALUES (${A.orgId}, 'CREDIT', 'VIDEO', 3, now() - interval '1 day', 'GRANT')`;
  const expired = await entitle({ orgId: A.orgId, nodeId: towerC.id, needs: [{ unit: "VIDEO", qty: 1 }], nowIso: NOON });
  check("three expired videos do not let a video be made", !expired.ok);
  const [lot] = await sql<{ id: string }[]>`SELECT id FROM wallet_entries WHERE org_id = ${A.orgId} AND unit = 'VIDEO' AND kind = 'CREDIT'`;
  const [ue] = await sql<{ id: string }[]>`SELECT id FROM usage_events WHERE source_id = ${film}`;
  try {
    await withTenant(A.orgId, (tx) => tx`
      INSERT INTO wallet_entries (org_id, kind, unit, qty, lot_id, source, usage_id) VALUES (${A.orgId}, 'DRAW', 'VIDEO', 1, ${lot.id}, 'USAGE', ${ue.id})`);
    check("the database refuses a draw on it", false, "the draw went in");
  } catch (e) {
    check("the database refuses a draw on it", /expired/.test(String((e as Error).message)), (e as Error).message);
  }
  const lapsed = await expireLots(A.orgId);
  const again = await expireLots(A.orgId);
  check("the sweep writes its expiry once", lapsed === 1 && again === 0);

  console.log("\nToday");
  const o = await overview(A.orgId, NOON);
  const heightsRow = o.projects.find((p) => p.id === heights.id);
  check("the overview shows Heights on Launch", heightsRow?.sub?.plan === "LAUNCH");
  const video = heightsRow?.units.find((u) => u.unit === "VIDEO");
  check("with its video used", video?.level === "out");
  const alerts = billingAlerts(o);
  check("Today says the videos are gone", alerts.some((a) => a.id === `billing-out-${heights.id}-VIDEO` && a.severity === "risk"));
  check("and that WhatsApp has no credit", alerts.some((a) => a.id === "billing-out-whatsapp"));

  console.log("\nBuying a top-up in test mode");
  const noState = await startTopUp({ orgId: A.orgId, userId: admin.id, cart: [{ sku: "VIDEO", qty: 1 }] });
  check("without a billing state it is refused before Razorpay", !noState.ok && orders.length === 0);
  await withTenant(A.orgId, (tx) => tx`UPDATE billing_accounts SET bill_state = '27', bill_address = '1 Baner Road, Pune' WHERE org_id = ${A.orgId}`);
  const bad = await startTopUp({ orgId: A.orgId, userId: admin.id, cart: [{ sku: "MIN_10000", qty: 1 }] });
  check("10,000 minutes is for Scale only", !bad.ok && /Scale/.test(bad.message));
  const start = await startTopUp({ orgId: A.orgId, userId: admin.id, cart: [{ sku: "VIDEO", qty: 1 }, { sku: "MIN_1000", qty: 1 }] });
  check("a video and 1,000 minutes cost Rs 18,288.82 with GST", start.ok && start.checkout.amountPaise === 18_288_82 && start.checkout.test, JSON.stringify(start));
  if (start.ok) {
    const orderId = start.checkout.orderId;
    const paymentId = `pay_check_${tag}`;
    const sign = (m: string, k: string) => createHmac("sha256", k).update(m).digest("hex");
    const forged = await confirmTopUp({ orgId: A.orgId, userId: admin.id, orderId, paymentId, signature: "0".repeat(64) });
    check("a forged Checkout signature credits nothing", !forged.ok && (await walletOf(A.orgId, "VIDEO")) === 0);
    const other = await confirmTopUp({ orgId: B.orgId, userId: admin.id, orderId, paymentId, signature: sign(`${orderId}|${paymentId}`, "check-secret") });
    check("another organisation cannot settle this one's order", !other.ok);
    gatewayPayments.set(paymentId, 18_288_82);
    const paid = await confirmTopUp({ orgId: A.orgId, userId: admin.id, orderId, paymentId, signature: sign(`${orderId}|${paymentId}`, "check-secret") });
    check("a genuine one settles", paid.ok);
    check("one video and 1,000 minutes land as top-ups", (await walletOf(A.orgId, "VIDEO")) === 1 && (await walletOf(A.orgId, "MINUTE")) === 1_007);

    const event = { event: "payment.captured", payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 18_288_82, status: "captured" } } } };
    const raw = JSON.stringify(event);
    const unsigned = await ingestRazorpay(raw, sign(raw, "wrong"), `evt_${tag}`);
    check("a webhook with the wrong signature is refused", unsigned.status === 401);
    const hook = await ingestRazorpay(raw, sign(raw, "check-webhook-secret"), `evt_${tag}`);
    const dupe = await ingestRazorpay(raw, sign(raw, "check-webhook-secret"), `evt_${tag}`);
    check("the webhook after Checkout settles nothing twice", hook.status === 200 && dupe.note === "duplicate", JSON.stringify([hook, dupe]));
    check("still one video and 1,000 minutes", (await walletOf(A.orgId, "VIDEO")) === 1 && (await walletOf(A.orgId, "MINUTE")) === 1_007);

    const invs = await listInvoices(A.orgId);
    check("one invoice, in the test series", invs.length === 1 && /^TST\/\d{2}-\d{2}\/\d{5}$/.test(invs[0].number), invs.map((i) => i.number).join(", "));
    const inv = invs[0];
    check("Maharashtra to Maharashtra is CGST and SGST at 9% each", inv.cgstPaise === 1_394_91 && inv.sgstPaise === 1_394_91 && inv.igstPaise === 0, JSON.stringify(inv));
    check("the SAC is 998315 on every line", inv.lines.every((l) => l.sac === "998315"));
    const pdf = await invoicePdf(A.orgId, inv.id);
    check("it draws as a PDF", !!pdf && pdf.bytes.subarray(0, 5).toString() === "%PDF-" && pdf.bytes.includes(Buffer.from(inv.number.replace(/\//g, "/"))));
    check("another organisation cannot open it", (await invoicePdf(B.orgId, inv.id)) === null);
    try {
      await withTenant(A.orgId, (tx) => tx`UPDATE invoices SET total_paise = 1 WHERE id = ${inv.id}`);
      check("an issued invoice cannot be edited", false, "it was");
    } catch (e) {
      check("an issued invoice cannot be edited", refusedAs(e) === "42501", refusedAs(e));
    }

    // A second purchase, billed to Karnataka: IGST, the next number.
    await withTenant(A.orgId, (tx) => tx`UPDATE billing_accounts SET bill_state = '29' WHERE org_id = ${A.orgId}`);
    const s2 = await startTopUp({ orgId: A.orgId, userId: admin.id, cart: [{ sku: "IMAGE", qty: 10 }] });
    if (s2.ok) {
      const pay2 = `pay_check2_${tag}`;
      const ev2 = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: pay2, order_id: s2.checkout.orderId, amount: s2.checkout.amountPaise, status: "captured" } } } });
      await ingestRazorpay(ev2, sign(ev2, "check-webhook-secret"), `evt2_${tag}`);
      const [second] = (await listInvoices(A.orgId)).filter((i) => i.id !== inv.id);
      const seq = (n: string) => Number(n.split("/")[2]);
      check("the webhook alone settles a purchase", !!second && (await walletOf(A.orgId, "IMAGE")) === 10);
      check("across states it is IGST at 18%", second?.igstPaise === 88_20 && second.cgstPaise === 0, JSON.stringify(second));
      check("and the next number in the series", !!second && seq(second.number) === seq(inv.number) + 1, `${inv.number} then ${second?.number}`);
    } else check("a second purchase starts", false, s2.message);

    const s3 = await startTopUp({ orgId: A.orgId, userId: admin.id, cart: [{ sku: "VIDEO", qty: 2 }] });
    if (s3.ok) {
      const ev3 = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_short_${tag}`, order_id: s3.checkout.orderId, amount: 100, status: "captured" } } } });
      const short = await ingestRazorpay(ev3, sign(ev3, "check-webhook-secret"), `evt3_${tag}`);
      check("a payment for less than the order credits nothing", short.note === "amount mismatch" && (await walletOf(A.orgId, "VIDEO")) === 1);
    }

    console.log("\nCredit notes: a correction is a new document, never an edit");
    try {
      await withTenant(A.orgId, (tx) => tx`
        INSERT INTO invoices (org_id, number, series, fy, seq, kind, purpose, test, issued_on, seller, buyer, place_of_supply,
                              lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, reverses, reason)
        VALUES (${A.orgId}, 'TCN/99-00/99999', 'TCN', '99-00', 99999, 'CREDIT_NOTE', 'TOPUP', true, ${inv.issuedOn},
                ${tx.json(inv.seller as never)}, ${tx.json(inv.buyer as never)}, ${inv.placeOfSupply}, '[]'::jsonb, 100, 9, 9, 0, 118, ${inv.id}, 'Smuggled')`);
      check("the application cannot issue itself a credit note", false, "it did");
    } catch (e) {
      check("the application cannot issue itself a credit note", refusedAs(e) === "42501", refusedAs(e));
    }
    const video = billing("credit-note", inv.number, "--amount", "549900", "--unit", "VIDEO", "--reason", "Video not delivered", "--on", inv.issuedOn);
    check("the operator credits the video on the first invoice", /^TCN\/\d{2}-\d{2}\/\d{5} against TST/.test(video) && /Took back 1 video/.test(video), video);
    const notes = (await listInvoices(A.orgId)).filter((i) => i.kind === "CREDIT_NOTE");
    const cn = notes[0];
    check("it runs the test credit note series and names the invoice it corrects",
      notes.length === 1 && /^TCN\//.test(cn.number) && cn.against?.number === inv.number && cn.reason === "Video not delivered", JSON.stringify(cn));
    check("with the invoice's own buyer, place of supply and CGST and SGST, each rounded on its own",
      !!cn && cn.cgstPaise === 494_91 && cn.sgstPaise === 494_91 && cn.igstPaise === 0 && cn.totalPaise === 6_488_82 && cn.placeOfSupply === inv.placeOfSupply && cn.buyer.name === inv.buyer.name, JSON.stringify(cn));
    check("and the unused video goes back out of the wallet, the minutes left alone",
      (await walletOf(A.orgId, "VIDEO")) === 0 && (await walletOf(A.orgId, "MINUTE")) === 1_007);
    const cnPdf = cn ? await invoicePdf(A.orgId, cn.id) : null;
    check("it draws as a PDF from its row, titled a credit note and naming the invoice",
      !!cnPdf && cnPdf.bytes.subarray(0, 5).toString() === "%PDF-" && cnPdf.bytes.includes(Buffer.from("TEST CREDIT NOTE")) && cnPdf.bytes.includes(Buffer.from(inv.number)));
    console.log("\nA credit note's money sent back through Razorpay");
    const refundRow = async (id: string) => {
      const [r] = await sql<{ refund_status: string | null; refund_paise: string | null; refund_ref: string | null; refund_attempts: number }[]>`
        SELECT refund_status, refund_paise, refund_ref, refund_attempts FROM invoices WHERE id = ${id}`;
      return r;
    };
    const notACredit = await billingAsync("refund", inv.number);
    check("an invoice itself is not refunded, only a credit note", !notACredit.ok && /Only a credit note/.test(notACredit.err), notACredit.err);
    loseNextRefund = true;
    const lostRefund = await billingAsync("refund", cn.number);
    const afterLost = await refundRow(cn.id);
    check("a refund whose answer is lost is left marked asked",
      !lostRefund.ok && /did not answer/.test(lostRefund.err) && afterLost.refund_status === "REQUESTED" && afterLost.refund_attempts === 1 && refundsMade.length === 1,
      JSON.stringify({ err: lostRefund.err, afterLost, made: refundsMade.length }));
    const foundRefund = await billingAsync("refund", cn.number);
    const afterFound = await refundRow(cn.id);
    check("asked again, it finds the refund Razorpay made instead of refunding twice",
      foundRefund.ok && refundsMade.length === 1 && afterFound.refund_status === "PROCESSED" && afterFound.refund_ref === refundsMade[0].id && Number(afterFound.refund_paise) === cn.totalPaise,
      JSON.stringify({ out: foundRefund.out, err: foundRefund.err, afterFound }));
    check("for exactly the credit note, against the payment it corrects, named by the credit note",
      refundsMade[0].amount === cn.totalPaise && refundsMade[0].payment_id === `pay_check_${tag}` && refundsMade[0].notes.credit_note === cn.id && refundsMade[0].receipt === cn.number);
    const again = await billingAsync("refund", cn.number);
    check("a refunded credit note is never refunded again", again.ok && /already/.test(again.out) && refundsMade.length === 1, again.out + again.err);
    const [trail] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${A.orgId} AND action = 'billing.credit_note_refunded'`;
    check("each refund asked is audited", trail.n >= 2, String(trail.n));
    try {
      await withTenant(A.orgId, (tx) => tx`UPDATE invoices SET refund_status = 'REQUESTED' WHERE id = ${cn.id}`);
      check("the application cannot write a refund", false, "it did");
    } catch (e) {
      check("the application cannot write a refund", refusedAs(e) === "42501", refusedAs(e));
    }
    try {
      await sql`UPDATE invoices SET reason = 'Edited later' WHERE id = ${cn.id}`;
      check("not even the operator edits an issued credit note while recording a refund", false, "it did");
    } catch (e) {
      check("not even the operator edits an issued credit note while recording a refund", refusedAs(e) === "42501", refusedAs(e));
    }
    try {
      await sql`UPDATE invoices SET refund_ref = 'rfnd_Other1234' WHERE id = ${cn.id}`;
      check("a processed refund keeps its reference", false, "it changed");
    } catch (e) {
      check("a processed refund keeps its reference", refusedAs(e) === "23514", refusedAs(e));
    }

    const restRun = await billingAsync("credit-note", inv.number, "--full", "--reason", "Refunded in full", "--on", inv.issuedOn, "--refund");
    const rest = restRun.out + restRun.err;
    const restCn = (await listInvoices(A.orgId)).find((i) => i.kind === "CREDIT_NOTE" && i.against?.id === inv.id && i.id !== cn.id);
    const restRefund = restCn ? await refundRow(restCn.id) : null;
    check("--refund issues the credit note and sends its money back in one run",
      restRun.ok && /refunded/.test(restRun.out) && restRefund?.refund_status === "PROCESSED" && refundsMade.length === 2 && refundsMade[1].amount === restCn?.totalPaise,
      rest);
    check("the two refunds come to the payment, to the paisa, and no more", refundsMade.reduce((s, r) => s + r.amount, 0) === 18_288_82);
    try {
      await sql`UPDATE invoices SET refund_status = NULL WHERE id = ${restCn!.id}`;
      check("a processed refund is never undone", false, "it was");
    } catch (e) {
      check("a processed refund is never undone", refusedAs(e) === "23514", refusedAs(e));
    }
    const all = (await listInvoices(A.orgId)).filter((i) => i.kind === "CREDIT_NOTE" && i.against?.id === inv.id);
    const seqOf = (n: string) => Number(n.split("/")[2]);
    check("the rest credits the remainder, so the invoice nets to nothing, to the paisa",
      all.length === 2 && all.reduce((s, i) => s + i.totalPaise, 0) === inv.totalPaise && all.reduce((s, i) => s + i.cgstPaise, 0) === inv.cgstPaise, rest);
    check("the credit notes are numbered one after the other", all.length === 2 && Math.abs(seqOf(all[0].number) - seqOf(all[1].number)) === 1);
    check("and every minute still unused of that purchase goes back too", (await walletOf(A.orgId, "MINUTE")) === 7);
    let refused = "";
    try {
      billing("credit-note", inv.number, "--amount", "100", "--reason", "Once more");
    } catch (e) {
      refused = String((e as { stderr?: string }).stderr ?? "");
    }
    check("a third is refused: the invoice has been credited in full", /credited in full/.test(refused), refused);
    try {
      await withTenant(A.orgId, (tx) => tx`UPDATE invoices SET reason = 'Edited' WHERE id = ${cn.id}`);
      check("an issued credit note cannot be edited", false, "it was");
    } catch (e) {
      check("an issued credit note cannot be edited", refusedAs(e) === "42501", refusedAs(e));
    }
    try {
      await sql`
        INSERT INTO invoices (org_id, number, series, fy, seq, kind, purpose, test, issued_on, seller, buyer, place_of_supply,
                              lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, reverses, reason)
        VALUES (${A.orgId}, 'TCN/99-00/99998', 'TCN', '99-00', 99998, 'CREDIT_NOTE', 'TOPUP', true, ${inv.issuedOn},
                ${sql.json(inv.seller as never)}, ${sql.json(inv.buyer as never)}, ${inv.placeOfSupply}, '[]'::jsonb, 100, 9, 9, 0, 118, ${inv.id}, 'Over')`;
      check("the database refuses more credit than the invoice held, even from the operator", false, "it took it");
    } catch (e) {
      check("the database refuses more credit than the invoice held, even from the operator", /more than the invoice held/.test((e as Error).message), (e as Error).message);
    }
  }

  console.log("\nAutomatic top-ups: shadow mode records, and never charges");
  const HOUR = 3_600_000;
  const at = (h: number) => new Date(Date.parse(NOON) + h * HOUR).toISOString();
  const input = (v: Record<string, string>) => ({ on: "on", sku: "VIDEO", qty: "1", threshold: "1", ceiling: "20000", ...v });
  const badSetting = await saveAutoTopUp({ orgId: A.orgId, userId: admin.id, input: { on: "on", sku: "", threshold: "", ceiling: "" } });
  check("switched on with nothing chosen is refused, naming each field", !badSetting.ok && /Buy:/.test(badSetting.message) && /Monthly limit/.test(badSetting.message));
  const saved = await saveAutoTopUp({ orgId: A.orgId, userId: admin.id, input: input({}) });
  check("a video whenever fewer than one is left, up to Rs 20,000 a month, is saved", saved.ok && saved.changed.includes("on"));
  const ordersBefore = orders.length;
  const shadow = await runAutoTopUp(A.orgId, at(0));
  check("in shadow mode it records what it would have bought", shadow.decided === "record" && shadow.status === "WOULD_CHARGE", JSON.stringify(shadow));
  const [{ n: paymentsAfter }] = await sql`SELECT count(*)::int AS n FROM payments WHERE org_id = ${A.orgId}`;
  check("and asks Razorpay for nothing", orders.length === ordersBefore && recurring.size === 0);
  const shadowAgain = await runAutoTopUp(A.orgId, at(1));
  check("once a day at most", shadowAgain.decided === "none" && shadowAgain.why === "COOLDOWN", JSON.stringify(shadowAgain));

  console.log("\nAutomatic top-ups: a LIVE organisation");
  await sql`UPDATE billing_accounts SET mode = 'LIVE' WHERE org_id = ${A.orgId}`;
  const noMandate = await runAutoTopUp(A.orgId, at(2));
  check("with no saved mandate, the top-up waits for the client to pay it", noMandate.status === "AWAITING_APPROVAL", JSON.stringify(noMandate));
  const today = await billingQueue(A.orgId);
  check("and Today says so", today.some((a) => a.id === `auto-approve-${noMandate.chargeId}` && a.severity === "risk"));
  const pay = await approveAutoCharge({ orgId: A.orgId, userId: admin.id, chargeId: noMandate.chargeId! });
  check("paying it opens Checkout for exactly that top-up", pay.ok && pay.checkout.amountPaise === 6_488_82, JSON.stringify(pay));
  if (pay.ok) {
    const evA = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_appr_${tag}`, order_id: pay.checkout.orderId, amount: pay.checkout.amountPaise, status: "captured" } } } });
    await ingestRazorpay(evA, createHmac("sha256", "check-webhook-secret").update(evA).digest("hex"), `evtA_${tag}`);
  }
  const [paidA] = await sql`SELECT status FROM auto_topup_charges WHERE id = ${noMandate.chargeId!}`;
  check("once paid it is PAID and the video is in the wallet", paidA?.status === "PAID" && (await walletOf(A.orgId, "VIDEO")) === 1, paidA?.status);
  const notLow = await runAutoTopUp(A.orgId, at(3));
  check("with a video left, nothing is bought", notLow.decided === "none" && notLow.why === "NOT_LOW", JSON.stringify(notLow));

  const mandate = billing("mandate", "--org", A.orgId, "--customer", "cust_check12345", "--token", "token_check12345", "--email", "accounts@bill.example", "--contact", "+919800000001", "--max", "15000", "--test");
  check("the operator saves the client's mandate, sealed", /mandate saved/.test(mandate), mandate);
  const [sealedRow] = await sql`SELECT secret FROM billing_mandates WHERE org_id = ${A.orgId} AND status = 'ACTIVE'`;
  check("and the token is nowhere in the row in the clear", !!sealedRow && !Buffer.from(sealedRow.secret).includes(Buffer.from("token_check12345")));
  await saveAutoTopUp({ orgId: A.orgId, userId: admin.id, input: input({ threshold: "2" }) });
  const notice = await runAutoTopUp(A.orgId, at(4));
  check("fewer than two left: the charge is announced, not taken", notice.status === "NOTIFIED" && recurring.size === 0, JSON.stringify(notice));
  const early = await runAutoTopUp(A.orgId, at(10));
  check("and it waits the day's notice", early.decided === "open" && early.why === "WAIT" && recurring.size === 0, JSON.stringify(early));
  const cancelled = await cancelAutoCharge({ orgId: A.orgId, userId: admin.id, chargeId: notice.chargeId! });
  check("the client may cancel it before then", cancelled.ok);
  const renotice = await runAutoTopUp(A.orgId, at(11));
  check("the next pass announces a new one, numbered next in the month", renotice.status === "NOTIFIED", JSON.stringify(renotice));
  const taken = await runAutoTopUp(A.orgId, at(36));
  const [paidB] = await sql`SELECT status, attempts FROM auto_topup_charges WHERE id = ${renotice.chargeId!}`;
  check("a day later it is charged to the mandate, once, and settled", taken.status === "PAID" && recurring.size === 1 && paidB?.status === "PAID" && paidB?.attempts === 1, JSON.stringify(taken));
  check("with the video in the wallet and a tax invoice", (await walletOf(A.orgId, "VIDEO")) === 2 && [...recurring.values()][0].token === "token_check12345");

  await saveAutoTopUp({ orgId: A.orgId, userId: admin.id, input: input({ threshold: "3" }) });
  const ceiling = await runAutoTopUp(A.orgId, at(37));
  check("past the month's limit nothing is bought, whatever runs out", ceiling.decided === "none" && ceiling.why === "CEILING", JSON.stringify(ceiling));
  await saveAutoTopUp({ orgId: A.orgId, userId: admin.id, input: input({ threshold: "3", ceiling: "40000" }) });
  const n3 = await runAutoTopUp(A.orgId, at(38));
  loseNextAnswer = true;
  const lost = await runAutoTopUp(A.orgId, at(63));
  check("a charge whose answer was lost is left being charged", n3.status === "NOTIFIED" && lost.status === "CHARGING" && lost.why === "NO_ANSWER", JSON.stringify([n3, lost]));
  const found = await runAutoTopUp(A.orgId, at(63.25));
  check("the next pass finds the payment at Razorpay instead of charging again", found.status === "PAID" && recurring.size === 2 && (await walletOf(A.orgId, "VIDEO")) === 3, JSON.stringify(found));

  await saveAutoTopUp({ orgId: A.orgId, userId: admin.id, input: input({ qty: "3", threshold: "5", ceiling: "90000" }) });
  const big = await runAutoTopUp(A.orgId, at(64));
  const [bigRow] = await sql`SELECT status, note, total_paise FROM auto_topup_charges WHERE id = ${big.chargeId ?? randomUUID()}`;
  check("three videos at once, over Rs 15,000, wait for the client whatever the mandate allows",
    bigRow?.status === "AWAITING_APPROVAL" && bigRow?.note === "OVER_LIMIT" && Number(bigRow?.total_paise) > 15_000_00 && recurring.size === 2, JSON.stringify(bigRow));
  await saveAutoTopUp({ orgId: A.orgId, userId: admin.id, input: { ...input({ qty: "3", threshold: "5", ceiling: "90000" }), on: "" } });
  const [offRow] = await sql`SELECT status, note FROM auto_topup_charges WHERE id = ${big.chargeId ?? randomUUID()}`;
  check("switching it off cancels what was waiting", offRow?.status === "CANCELLED" && offRow?.note === "TURNED_OFF", JSON.stringify(offRow));
  const view = await autoTopUpView(A.orgId, at(64));
  check("the screen reads the setting, the mandate and the month", !view.setting.on && view.mandate?.method === "EMANDATE" && view.history.length >= 5 && view.open.length === 0);
  const [{ n: auditRows }] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${A.orgId} AND action = 'billing.auto_topup_decided'`;
  check("every decision is audited", auditRows >= 5);
  void paymentsAfter;

  console.log("\nAutomatic payment, set up by the client");
  const signed = (m: string) => createHmac("sha256", "check-secret").update(m).digest("hex");
  const hooked = (v: unknown) => {
    const raw = JSON.stringify(v);
    return { raw, sig: createHmac("sha256", "check-webhook-secret").update(raw).digest("hex") };
  };
  const noPlan = await startMandateSetup({ orgId: B.orgId, userId: admin.id, method: "CARD" });
  check("an organisation with no plan cannot set one up, before Razorpay is asked", !noPlan.ok && /plan/.test(noPlan.message) && mandateOrders.length === 0, JSON.stringify(noPlan));
  const noMethod = await startMandateSetup({ orgId: A.orgId, userId: admin.id, method: "CHEQUE" });
  check("a way to pay the screen does not offer is refused", !noMethod.ok && mandateOrders.length === 0);
  const [{ ceiling: ceilingNow }] = await sql<{ ceiling: string }[]>`SELECT auto_topup_ceiling_paise AS ceiling FROM billing_accounts WHERE org_id = ${A.orgId}`;
  const em = await startMandateSetup({ orgId: A.orgId, userId: admin.id, userEmail: "admin@bill.example", method: "EMANDATE", nowIso: at(66) });
  check("a bank e-mandate starts: a customer and an order capped at the monthly limit, for nothing",
    em.ok && em.checkout.amountPaise === 0 && em.checkout.customerId === "cust_checkmandate1" && mandateOrders.length === 1
      && mandateOrders[0].method === "EMANDATE" && mandateOrders[0].maxAmountPaise === Number(ceilingNow) && em.checkout.test,
    JSON.stringify({ em, mandateOrders }));
  if (em.ok) {
    const [setupRow] = await sql`SELECT status, max_amount_paise, test FROM billing_mandate_setups WHERE order_id = ${em.checkout.orderId}`;
    check("and is recorded before Checkout opens", setupRow?.status === "CREATED" && Number(setupRow.max_amount_paise) === Number(ceilingNow) && setupRow.test === true);
    const pid = `pay_mdt_${tag}`;
    mandatePayments.set(pid, { orderId: em.checkout.orderId, status: "captured", amount: 0, tokenId: "token_mdtbank01", customerId: "cust_checkmandate1", email: "admin@bill.example", contact: "+919800000002" });
    const forgedM = await confirmMandateSetup({ orgId: A.orgId, userId: admin.id, orderId: em.checkout.orderId, paymentId: pid, signature: "0".repeat(64) });
    check("a forged Checkout answer saves nothing", !forgedM.ok);
    const otherM = await confirmMandateSetup({ orgId: B.orgId, userId: admin.id, orderId: em.checkout.orderId, paymentId: pid, signature: signed(`${em.checkout.orderId}|${pid}`) });
    check("another organisation cannot finish this one's set-up", !otherM.ok);
    const waiting = await confirmMandateSetup({ orgId: A.orgId, userId: admin.id, orderId: em.checkout.orderId, paymentId: pid, signature: signed(`${em.checkout.orderId}|${pid}`) });
    const [stillOperator] = await sql`SELECT method, setup_id FROM billing_mandates WHERE org_id = ${A.orgId} AND status = 'ACTIVE'`;
    check("authorised but not yet confirmed by the bank, it waits, and the saved mandate stays in use",
      waiting.ok && waiting.status === "AUTHORISED" && stillOperator?.setup_id === null, JSON.stringify({ waiting, stillOperator }));
    const state = await mandateSetupState(A.orgId);
    check("the screen says the bank is confirming it", state.waiting?.method === "EMANDATE" && !!state.refusal);
    const second = await startMandateSetup({ orgId: A.orgId, userId: admin.id, method: "CARD" });
    check("a second set-up waits for the bank's answer on the first", !second.ok && mandateOrders.length === 1, JSON.stringify(second));
    tokenStates.set("token_mdtbank01", "confirmed");
    const swept = await sweepMandateSetups(A.orgId, at(90));
    const [saved] = await sql<{ id: string; method: string; max_amount_paise: string; setup_id: string | null; secret: Buffer; test: boolean }[]>`
      SELECT id, method, max_amount_paise, setup_id, secret, test FROM billing_mandates WHERE org_id = ${A.orgId} AND status = 'ACTIVE'`;
    const [revokedOld] = await sql`SELECT count(*)::int AS n FROM billing_mandates WHERE org_id = ${A.orgId} AND status = 'REVOKED' AND setup_id IS NULL`;
    check("once the bank confirms, the sweep saves it where the operator's mandate was, and stops using that one",
      swept.confirmed === 1 && saved?.method === "EMANDATE" && !!saved.setup_id && Number(saved.max_amount_paise) === Number(ceilingNow) && saved.test && revokedOld.n >= 1,
      JSON.stringify({ swept, saved: saved && { ...saved, secret: undefined } }));
    check("sealed: the token is nowhere in the row in the clear", !!saved && !Buffer.from(saved.secret).includes(Buffer.from("token_mdtbank01")));
    const sweptAgain = await sweepMandateSetups(A.orgId, at(91));
    const [{ n: activeN }] = await sql`SELECT count(*)::int AS n FROM billing_mandates WHERE org_id = ${A.orgId} AND status = 'ACTIVE'`;
    check("asked again, nothing is saved twice", sweptAgain.checked === 0 && activeN === 1);
    const late = await ingestRazorpay(hooked({ event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: em.checkout.orderId, amount: 0, status: "captured" } } } }).raw,
      hooked({ event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: em.checkout.orderId, amount: 0, status: "captured" } } } }).sig, `evtM1_${tag}`);
    check("the webhook arriving after finds it saved", late.status === 200 && /confirmed/.test(late.note), JSON.stringify(late));

    await saveAutoTopUp({ orgId: A.orgId, userId: admin.id, input: input({ threshold: "50", ceiling: "90000" }) });
    const n4 = await runAutoTopUp(A.orgId, at(92));
    const took4 = await runAutoTopUp(A.orgId, at(117));
    check("an automatic top-up is charged to the mandate the client set up",
      n4.status === "NOTIFIED" && took4.status === "PAID" && [...recurring.values()].at(-1)?.token === "token_mdtbank01", JSON.stringify([n4, took4]));
    await saveAutoTopUp({ orgId: A.orgId, userId: admin.id, input: { ...input({ threshold: "50", ceiling: "90000" }), on: "" } });

    // A card, authorised with a rupee, confirmed at once, arriving by webhook alone.
    const card = await startMandateSetup({ orgId: A.orgId, userId: admin.id, method: "CARD", nowIso: at(118) });
    check("a card is authorised with a rupee", card.ok && card.checkout.amountPaise === 100 && mandateOrders.at(-1)?.method === "CARD", JSON.stringify(card));
    if (card.ok) {
      const cpid = `pay_mdtcard_${tag}`;
      mandatePayments.set(cpid, { orderId: card.checkout.orderId, status: "authorized", amount: 100, tokenId: "token_mdtcard01", customerId: "cust_checkmandate1", email: "admin@bill.example", contact: "+919800000002" });
      tokenStates.set("token_mdtcard01", "confirmed");
      const ev = hooked({ event: "payment.authorized", payload: { payment: { entity: { id: cpid, order_id: card.checkout.orderId, amount: 100, status: "authorized" } } } });
      const byHook = await ingestRazorpay(ev.raw, ev.sig, `evtM2_${tag}`);
      const dupeHook = await ingestRazorpay(ev.raw, ev.sig, `evtM2_${tag}`);
      const [cardRow] = await sql`SELECT method, label FROM billing_mandates WHERE org_id = ${A.orgId} AND status = 'ACTIVE'`;
      check("the webhook alone saves it, once, and it replaces the e-mandate",
        byHook.status === 200 && dupeHook.note === "duplicate" && cardRow?.method === "CARD" && cardRow?.label === "Card", JSON.stringify({ byHook, dupeHook, cardRow }));
      const [{ n: topups }] = await sql`SELECT count(*)::int AS n FROM payments WHERE order_id = ${card.checkout.orderId}`;
      check("and the rupee it took is not a top-up", topups === 0);
    }
    try {
      await withTenant(A.orgId, (tx) => tx`UPDATE billing_mandates SET status = 'ACTIVE', revoked_at = NULL WHERE org_id = ${A.orgId} AND status = 'REVOKED'`);
      check("a stopped mandate is never started again by the application", false, "it was");
    } catch (e) {
      check("a stopped mandate is never started again by the application", refusedAs(e) === "42501", refusedAs(e));
    }
    const stopped = await stopMandate({ orgId: A.orgId, userId: admin.id });
    const stoppedAgain = await stopMandate({ orgId: A.orgId, userId: admin.id });
    const [{ n: activeAfter }] = await sql`SELECT count(*)::int AS n FROM billing_mandates WHERE org_id = ${A.orgId} AND status = 'ACTIVE'`;
    check("the client stops using it, once", stopped.ok && !stoppedAgain.ok && activeAfter === 0);
    const lapsed = await startMandateSetup({ orgId: A.orgId, userId: admin.id, method: "UPI", nowIso: at(120) });
    const lapsedSweep = await sweepMandateSetups(A.orgId, new Date(Date.parse(at(120)) + 25 * HOUR).toISOString());
    const [lapsedRow] = lapsed.ok ? await sql`SELECT status, note FROM billing_mandate_setups WHERE order_id = ${lapsed.checkout.orderId}` : [];
    check("a set-up nobody finished at Checkout is let go after a day", lapsed.ok && lapsedSweep.expired === 1 && lapsedRow?.status === "EXPIRED" && lapsedRow?.note === "NOT_FINISHED", JSON.stringify({ lapsedSweep, lapsedRow }));
  }

  console.log("\nA calling number's month");
  {
    const { meterCallingNumbers } = await import("../src/lib/calling-numbers.ts");
    // Rented ten days into last month, so this month and the last are both owed.
    const lastMonth = new Date(Date.parse(`${period}T00:00:00+05:30`) - 20 * 86_400_000).toISOString();
    const NUMBER = `+9122${String(Date.now()).slice(-8)}`;
    const [cn] = await sql<{ id: string }[]>`
      INSERT INTO calling_numbers (org_id, number, scope_node_id, active, monthly_cost_paise, monthly_price_paise, rented_at)
      VALUES (${A.orgId}, ${NUMBER}, ${heights.id}, true, 60000, 99900, ${lastMonth}) RETURNING id`;
    const asked1 = await meterCallingNumbers(A.orgId, NOON);
    await meterCallingNumbers(A.orgId, NOON);
    const rows = await sql<{ source_id: string; unit: string; qty: string; from_allowance: string; over: string; cost_paise: string; plan: string | null; period: Date }[]>`
      SELECT source_id, unit, qty::text, from_allowance::text, over::text, cost_paise::text, plan, period FROM usage_events
      WHERE org_id = ${A.orgId} AND kind = 'PHONE_NUMBER' ORDER BY period`;
    const ym = period.slice(0, 7);
    const thisMonth = rows.find((r) => r.source_id === `${cn.id}:${ym}`);
    check("a number held last month and this is owed both, once each however often the sweep runs",
      asked1 === 2 && rows.length === 2 && rows.every((r) => r.unit === "NUMBER" && Number(r.qty) === 1 && Number(r.cost_paise) === 60000), JSON.stringify(rows));
    check("this month's is inside the plan's own number, never over it",
      thisMonth?.plan === "LAUNCH" && Number(thisMonth.from_allowance) === 1 && Number(thisMonth.over) === 0, JSON.stringify(thisMonth));
    await sql`UPDATE calling_numbers SET active = false, scope_node_id = NULL, released_at = ${lastMonth} WHERE id = ${cn.id}`.catch(() => {});
    const margins = billing("margins", "--month", ym);
    check("the operator's margin report still reads the month", /Launch|LAUNCH/.test(margins), margins.slice(0, 200));
    await sql`DELETE FROM usage_events WHERE org_id = ${A.orgId} AND kind = 'PHONE_NUMBER'`;
    await sql`DELETE FROM calling_numbers WHERE id = ${cn.id}`;
  }

  {
  console.log("\nA plan bought in the console: a developer's project comes with its plan");
  const [cOrg] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', 'Plan Buyer', 'Plan Buyer', 'AAPFU0939F', ${`bill_c_${tag}.example`}, ${admin.id}) RETURNING id`;
  const [pOrg] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('CHANNEL_PARTNER', 'Plan Partner', 'Plan Partner', 'AAQFS4821K', ${`bill_p_${tag}.example`}, ${admin.id}) RETURNING id`;
  planOrgs.push(cOrg.id, pOrg.id);
  const rootOf = async (orgId: string, slug: string) => {
    const [root] = await sql<{ id: string; path: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path) VALUES (${orgId}, NULL, 'ORG', ${slug}, ${slug}, ${slug}::ltree) RETURNING id, path::text AS path`;
    const [ent] = await sql<{ id: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path) VALUES (${orgId}, ${root.id}, 'ENTITY', 'Some LLP', 'llp', ${`${root.path}.llp`}::ltree) RETURNING id`;
    return ent.id;
  };
  const cEntity = await rootOf(cOrg.id, `bill_c_${tag}`);
  const pEntity = await rootOf(pOrg.id, `bill_p_${tag}`);
  check("a developer is asked for a plan with each project", (await gateFor(cOrg.id, "DEVELOPER")).kind === "BUY_WITH_PROJECT");
  check("and the plain form says so", gateRefusal(await gateFor(cOrg.id, "DEVELOPER")) === "Choose a plan for this project first.");
  const newProject = { entityId: cEntity, city: "Pune", name: "Skyline One" };
  const noState = await startPlanPurchase({ orgId: cOrg.id, userId: admin.id, orgType: "DEVELOPER", plan: "LAUNCH", newProject });
  check("without a state to bill in, nothing is ordered", !noState.ok && /state you are billed in/.test(noState.message), JSON.stringify(noState));
  await setBillingState(cOrg.id, admin.id, "27");
  const [{ n: noPlanYet }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM subscriptions WHERE org_id = ${cOrg.id}`;
  const stillFree = await entitle({ orgId: cOrg.id, nodeId: null, needs: [{ unit: "IMAGE", qty: 1 }] });
  check("an account opened for the state, with no plan on it, refuses nothing yet", noPlanYet === 0 && stillFree.ok && !stillFree.billed);
  const ordersBefore = orders.length;
  const started = await startPlanPurchase({ orgId: cOrg.id, userId: admin.id, orgType: "DEVELOPER", plan: "LAUNCH", newProject });
  check("the plan is ordered once the state is known", started.ok, started.ok ? "" : started.message);
  const [{ n: noProjectYet }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM scope_nodes WHERE org_id = ${cOrg.id} AND kind = 'PROJECT'`;
  check("and the project does not exist until it is paid for", noProjectYet === 0);
  const [planPay] = await sql<{ order_id: string; total_paise: string; purpose: string; plan: string; new_project: { name: string } }[]>`
    SELECT order_id, total_paise, purpose, plan, new_project FROM payments WHERE org_id = ${cOrg.id}`;
  check("the order is for exactly what the payment row says",
    orders.length === ordersBefore + 1 && orders.at(-1)?.amountPaise === Number(planPay.total_paise) && planPay.purpose === "PLAN" && planPay.plan === "LAUNCH" && planPay.new_project.name === "Skyline One");
  const planPayment = "pay_plan_check1";
  const forgedPlan = await confirmTopUp({ orgId: cOrg.id, userId: admin.id, orderId: planPay.order_id, paymentId: planPayment, signature: "0".repeat(64) });
  check("a forged signature buys nothing", !forgedPlan.ok);
  const paidPlan = await confirmTopUp({ orgId: cOrg.id, userId: admin.id, orderId: planPay.order_id, paymentId: planPayment, signature: signPlan(`${planPay.order_id}|${planPayment}`, "check-secret") });
  check("paying creates the project", paidPlan.ok && paidPlan.plan?.inserted?.name === "Skyline One", JSON.stringify(paidPlan));
  const [cSub] = await sql<{ plan: string; status: string; scope: string; project_id: string; payment_id: string | null; setup_paise: string }[]>`
    SELECT plan, status, scope, project_id, payment_id, setup_paise FROM subscriptions WHERE org_id = ${cOrg.id}`;
  check("and its plan, on that project, tied to the payment",
    cSub?.plan === "LAUNCH" && cSub.status === "ACTIVE" && cSub.scope === "PROJECT" && cSub.project_id === (paidPlan.ok ? paidPlan.plan?.projectId : "") && !!cSub.payment_id && Number(cSub.setup_paise) === 49_999_00);
  const [cInv] = await sql<{ purpose: string; series: string; period: string | null }[]>`SELECT purpose, series, period FROM invoices WHERE org_id = ${cOrg.id}`;
  check("with a plan invoice of its own, in test mode", cInv?.purpose === "PLAN" && cInv.series === "TST" && cInv.period === null);
  const [cMode] = await sql<{ mode: string }[]>`SELECT mode FROM billing_accounts WHERE org_id = ${cOrg.id}`;
  check("a test payment leaves the organisation in shadow mode", cMode?.mode === "SHADOW");
  const again = await confirmTopUp({ orgId: cOrg.id, userId: admin.id, orderId: planPay.order_id, paymentId: planPayment, signature: signPlan(`${planPay.order_id}|${planPayment}`, "check-secret") });
  const [{ n: subsAfter }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM subscriptions WHERE org_id = ${cOrg.id}`;
  const [{ n: projectsAfter }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM scope_nodes WHERE org_id = ${cOrg.id} AND kind = 'PROJECT'`;
  check("a second confirmation writes nothing twice", again.ok && !again.plan && subsAfter === 1 && projectsAfter === 1);
  const dupe = await startPlanPurchase({ orgId: cOrg.id, userId: admin.id, orgType: "DEVELOPER", plan: "LAUNCH", newProject });
  check("a project of the same name is refused before anything is ordered", !dupe.ok && /already has a project called/.test(dupe.message));
  const [topupPay] = await withTenant(cOrg.id, (tx) => tx<{ id: string }[]>`
    INSERT INTO payments (org_id, order_id, items, taxable_paise, tax_paise, total_paise, test)
    VALUES (${cOrg.id}, ${`order_forge_${tag}`}, '[]'::jsonb, 100, 18, 118, true) RETURNING id`);
  const spare = await withTenant(cOrg.id, (tx) => insertProject(tx, cOrg.id, { entityId: cEntity, city: "Pune", name: "Spare" }));
  try {
    await withTenant(cOrg.id, (tx) => tx`
      INSERT INTO subscriptions (org_id, project_id, plan, status, starts_on, terms, payment_id)
      VALUES (${cOrg.id}, ${spare.ok ? spare.id : cSub.project_id}, 'SCALE', 'ACTIVE', current_date + 40, '{"plan":"SCALE"}'::jsonb, ${topupPay.id})`);
    check("the app cannot write a plan from a payment that was not for it", false, "it succeeded");
  } catch (e) {
    check("the app cannot write a plan from a payment that was not for it", refusedAs(e) === "42501", refusedAs(e));
  }

  console.log("\nA channel partner's plan covers the whole firm");
  check("a partner with no plan buys one first", (await gateFor(pOrg.id, "CHANNEL_PARTNER")).kind === "NEED_FIRM_PLAN");
  const pStart = await startPlanPurchase({ orgId: pOrg.id, userId: admin.id, orgType: "CHANNEL_PARTNER", plan: "LAUNCH", newProject: { entityId: pEntity, city: "Pune", name: "Ignored" } });
  check("a partner without a state is asked for one", !pStart.ok);
  await setBillingState(pOrg.id, admin.id, "27");
  const pStarted = await startPlanPurchase({ orgId: pOrg.id, userId: admin.id, orgType: "CHANNEL_PARTNER", plan: "LAUNCH" });
  check("a firm-wide plan is ordered", pStarted.ok, pStarted.ok ? "" : pStarted.message);
  const [pPay] = await sql<{ order_id: string; plan_scope: string }[]>`SELECT order_id, plan_scope FROM payments WHERE org_id = ${pOrg.id}`;
  const pPaid = await confirmTopUp({ orgId: pOrg.id, userId: admin.id, orderId: pPay.order_id, paymentId: "pay_plan_check2", signature: signPlan(`${pPay.order_id}|pay_plan_check2`, "check-secret") });
  const [pSub] = await sql<{ scope: string; project_id: string | null }[]>`SELECT scope, project_id FROM subscriptions WHERE org_id = ${pOrg.id}`;
  check("paid, it is one plan for the firm and no project", pPay.plan_scope === "ORG" && pPaid.ok && pSub?.scope === "ORG" && pSub.project_id === null);
  const room = await gateFor(pOrg.id, "CHANNEL_PARTNER");
  check("with room for five projects", room.kind === "FIRM_PLAN" && room.left === 5, JSON.stringify(room));
  const pProject = await withTenant(pOrg.id, (tx) => insertProject(tx, pOrg.id, { entityId: pEntity, city: "Thane", name: "Partner Tower" }));
  const pUse = await entitle({ orgId: pOrg.id, nodeId: pProject.ok ? pProject.id : null, needs: [{ unit: "IMAGE", qty: 1 }] });
  check("every project draws on the firm's one allowance", pUse.ok && pUse.billed && pUse.sub.projectId === null, JSON.stringify(pUse));
  const again2 = await startPlanPurchase({ orgId: pOrg.id, userId: admin.id, orgType: "CHANNEL_PARTNER", plan: "GROWTH" });
  check("moving up on the day the plan began waits a day", !again2.ok && /from tomorrow/.test(again2.message), again2.ok ? "" : again2.message);
  const same = await startPlanPurchase({ orgId: pOrg.id, userId: admin.id, orgType: "CHANNEL_PARTNER", plan: "LAUNCH" });
  check("a second plan of the same size is refused", !same.ok && /already on Solo/.test(same.message), JSON.stringify(same));

  console.log("\nA project's own limit on the firm's allowance");
  const pTower = pProject.ok ? pProject.id : "";
  const capSaved = await saveCaps({ orgId: pOrg.id, userId: admin.id, projectId: pTower, raw: { IMAGE: "1", MINUTE: "" } });
  check("a limit is saved for one project", capSaved.ok);
  const firstImage = await entitle({ orgId: pOrg.id, nodeId: pTower, needs: [{ unit: "IMAGE", qty: 1 }] });
  check("inside its limit the project may spend", firstImage.ok);
  await sql`
    INSERT INTO usage_events (org_id, project_id, kind, unit, qty, from_allowance, billable, plan, source_kind, source_id, period)
    VALUES (${pOrg.id}, ${pTower}, 'IMAGE_POST', 'IMAGE', 1, 1, true, 'LAUNCH', 'post', ${`cap-${tag}`}, date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))::date)`;
  const overCap = await entitle({ orgId: pOrg.id, nodeId: pTower, needs: [{ unit: "IMAGE", qty: 1 }] });
  check("past its limit it is refused before anything is paid for, naming the limit", !overCap.ok && /used the 1 image post you set/.test(overCap.message), JSON.stringify(overCap));
  const minuteOk = await callAllowance({ orgId: pOrg.id, nodeId: pTower, agent: "qualifier" });
  check("a unit with no limit is the plan's alone", minuteOk.billed && minuteOk.ok);
  await saveCaps({ orgId: pOrg.id, userId: admin.id, projectId: pTower, raw: {} });
  check("emptying the limits takes them off", (await entitle({ orgId: pOrg.id, nodeId: pTower, needs: [{ unit: "IMAGE", qty: 1 }] })).ok);
  await sql`DELETE FROM usage_events WHERE org_id = ${pOrg.id} AND source_id = ${`cap-${tag}`}`;

  console.log("\nA channel partner moves its firm to a bigger plan");
  const yesterday = new Date(Date.now() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10);
  await sql`UPDATE subscriptions SET starts_on = ${yesterday} WHERE org_id = ${pOrg.id} AND scope = 'ORG'`;
  const down = await startPlanPurchase({ orgId: pOrg.id, userId: admin.id, orgType: "CHANNEL_PARTNER", plan: "LAUNCH" });
  check("never to the same or a smaller plan", !down.ok);
  const up = await startPlanPurchase({ orgId: pOrg.id, userId: admin.id, orgType: "CHANNEL_PARTNER", plan: "GROWTH" });
  check("a bigger plan is ordered", up.ok, up.ok ? "" : up.message);
  const [upPay] = await sql<{ id: string; order_id: string; taxable_paise: string; upgrade_of: string | null }[]>`
    SELECT id, order_id, taxable_paise::text, upgrade_of FROM payments WHERE org_id = ${pOrg.id} AND plan = 'GROWTH'`;
  const todayIst = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const prepaid = yesterday >= `${todayIst.slice(0, 7)}-01`;
  const expected = upgradeLines({ from: "LAUNCH", fromPricePaise: PARTNER_PLANS.LAUNCH.pricePaise, to: "GROWTH", today: todayIst, forName: "x", prepaid })[0].unitPaise;
  check("charged the bigger plan for the rest of the month, less what the smaller was paid for those days, and no setup",
    Number(upPay?.taxable_paise) === expected && !!upPay?.upgrade_of, JSON.stringify({ upPay, expected }));
  const upPaid = await confirmTopUp({ orgId: pOrg.id, userId: admin.id, orderId: upPay.order_id, paymentId: "pay_plan_up", signature: signPlan(`${upPay.order_id}|pay_plan_up`, "check-secret") });
  const subsNow = await sql<{ plan: string; starts_on: string; ends_on: string | null }[]>`
    SELECT plan, starts_on::text, ends_on::text FROM subscriptions WHERE org_id = ${pOrg.id} AND scope = 'ORG' ORDER BY starts_on`;
  check("paid, the smaller plan ends today and the bigger starts today",
    upPaid.ok && subsNow.length === 2 && subsNow[0].plan === "LAUNCH" && subsNow[0].ends_on === todayIst && subsNow[1].plan === "GROWTH" && subsNow[1].starts_on === todayIst && subsNow[1].ends_on === null,
    JSON.stringify(subsNow));
  const bigger = await gateFor(pOrg.id, "CHANNEL_PARTNER");
  check("with room for the bigger plan's projects", bigger.kind === "FIRM_PLAN" && bigger.cap === 15, JSON.stringify(bigger));
  try {
    await withTenant(pOrg.id, (tx) => tx`UPDATE subscriptions SET ends_on = ${todayIst} WHERE org_id = ${pOrg.id} AND plan = 'GROWTH'`);
    check("the app cannot end a plan without a paid move to a bigger one", false, "it succeeded");
  } catch (e) {
    check("the app cannot end a plan without a paid move to a bigger one", refusedAs(e) === "42501", refusedAs(e));
  }
  try {
    await sql`
      INSERT INTO subscriptions (org_id, project_id, plan, status, starts_on, terms)
      VALUES (${pOrg.id}, ${pProject.ok ? pProject.id : null}, 'LAUNCH', 'ACTIVE', current_date + 60, '{}'::jsonb)`;
    check("a partner never holds a project plan, even from the operator", false, "it succeeded");
  } catch (e) {
    check("a partner never holds a project plan, even from the operator", /whole firm/.test(String((e as Error).message)), String(e));
  }

  console.log("\nA plan renews by itself each month");
  {
    const ist = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000);
    const nowDay = ist(new Date().toISOString());
    const monthStart = (offset: number) => new Date(Date.UTC(nowDay.getUTCFullYear(), nowDay.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
    const nextMonth = monthStart(1);
    const at2 = (day: string) => `${day.slice(0, 8)}02T06:30:00.000Z`;

    // A channel partner in shadow mode: next month is recorded, and nothing is asked of Razorpay.
    const ordersBefore = orders.length;
    const shadowMonth = await runPlanRenewal(pOrg.id, at2(nextMonth));
    check("in shadow mode the month's plan is recorded, never charged", shadowMonth.done === "recorded" && shadowMonth.status === "WOULD_CHARGE", JSON.stringify(shadowMonth));
    const [shadowRow] = await sql`SELECT total_paise, lines FROM plan_renewals WHERE id = ${shadowMonth.renewalId ?? null}`;
    check("for the plan the firm is on, a whole month with GST", Number(shadowRow?.total_paise) === Math.round(PARTNER_PLANS.GROWTH.pricePaise * 1.18), JSON.stringify(shadowRow));
    check("and Razorpay is asked nothing", orders.length === ordersBefore);
    const again = await runPlanRenewal(pOrg.id, at2(nextMonth));
    check("once a month", again.done === "none" && again.why === "DONE", JSON.stringify(again));
    check("a shadow month is never on Today", !(await billingQueue(pOrg.id)).some((a) => a.id.startsWith("renewal-")));

    // A LIVE developer: over what its mandate may take, so it waits for the client.
    await sql`UPDATE billing_accounts SET mode = 'LIVE' WHERE org_id = ${A.orgId}`;
    const live = await runPlanRenewal(A.orgId, NOON);
    check("a LIVE month over what the mandate may take waits for the client", live.status === "AWAITING_APPROVAL", JSON.stringify(live));
    check("and Today says to pay it", (await billingQueue(A.orgId)).some((a) => a.id === `renewal-${live.renewalId}`));
    const toPay = await payRenewal({ orgId: A.orgId, userId: admin.id, renewalId: live.renewalId ?? "" });
    const [owedRow] = await sql`SELECT total_paise FROM plan_renewals WHERE id = ${live.renewalId ?? null}`;
    check("paying it opens Checkout for exactly the month", toPay.ok && toPay.checkout.amountPaise === Number(owedRow?.total_paise), JSON.stringify(toPay));
    if (toPay.ok) {
      const ev = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_ren_${tag}`, order_id: toPay.checkout.orderId, amount: toPay.checkout.amountPaise, status: "captured" } } } });
      await ingestRazorpay(ev, createHmac("sha256", "check-webhook-secret").update(ev).digest("hex"), `evtR_${tag}`);
    }
    const [paidRow] = await sql`
      SELECT r.status, i.purpose, i.period::text AS period FROM plan_renewals r LEFT JOIN invoices i ON i.id = r.invoice_id WHERE r.id = ${live.renewalId ?? null}`;
    check("once paid the month is PAID, with its plan invoice for that month", paidRow?.status === "PAID" && paidRow?.purpose === "PLAN" && paidRow?.period === monthStart(0), JSON.stringify(paidRow));

    // An announced month is taken from the automatic payment when due.
    billing("mandate", "--org", A.orgId, "--customer", "cust_renew12345", "--token", "token_renew12345", "--email", "accounts@bill.example", "--contact", "+919800000001", "--max", "100000", "--test");
    const [mandateRow] = await sql`SELECT id FROM billing_mandates WHERE org_id = ${A.orgId} AND status = 'ACTIVE' AND test`;
    check("a saved mandate is there to take a month from", !!mandateRow);
    if (mandateRow) {
      const [n] = await sql`
        INSERT INTO plan_renewals (org_id, period, lines, taxable_paise, total_paise, status, mandate_id, notified_at, due_at)
        VALUES (${A.orgId}, ${nextMonth}, ${sql.json([{ description: "Heights: Launch plan", qty: 1, unitPaise: 1_000_00 }] as never)}, 1_000_00, 1_180_00,
                'NOTIFIED', ${mandateRow.id}, now() - interval '2 days', now() - interval '1 day')
        RETURNING id`;
      const recurringBefore = recurring.size;
      const taken = await runPlanRenewal(A.orgId);
      const [takenRow] = await sql`SELECT status, invoice_id FROM plan_renewals WHERE id = ${n.id}`;
      check("an announced month is taken from the automatic payment once due, and invoiced", recurring.size === recurringBefore + 1 && takenRow?.status === "PAID" && !!takenRow?.invoice_id, JSON.stringify({ taken, takenRow }));
    }

    // A month unpaid past its grace stops the paid work, by name.
    const lastMonth = monthStart(-1);
    await sql`
      INSERT INTO plan_renewals (org_id, period, lines, taxable_paise, total_paise, status, note, notified_at)
      VALUES (${A.orgId}, ${lastMonth}, ${sql.json([{ description: "Heights: Launch plan", qty: 1, unitPaise: 1_000_00 }] as never)}, 1_000_00, 1_180_00,
              'AWAITING_APPROVAL', 'OVER_MANDATE', now())`;
    const blocked = await entitle({ orgId: A.orgId, nodeId: towerC.id, needs: [{ unit: "IMAGE", qty: 1 }] });
    check("a month unpaid past its grace stops what costs money, naming the month", !blocked.ok && blocked.code === "OVERDUE" && /not paid yet/.test(blocked.message), JSON.stringify(blocked));
    check("and Today calls it overdue", (await billingQueue(A.orgId)).some((a) => a.severity === "risk" && /overdue/.test(a.title)));
    check("the client sees what is owed", (await renewalsFor(A.orgId)).some((r) => r.period === lastMonth && r.status === "AWAITING_APPROVAL"));
    try {
      await withTenant(A.orgId, (tx) => tx`UPDATE plan_renewals SET total_paise = 1 WHERE org_id = ${A.orgId} AND period = ${lastMonth}`);
      check("what a month costs is never changed by the app", false, "it succeeded");
    } catch {
      check("what a month costs is never changed by the app", true);
    }
    try {
      await withTenant(B.orgId, (tx) => tx`INSERT INTO plan_renewals (org_id, period, lines, taxable_paise, total_paise, status) VALUES (${B.orgId}, ${nextMonth}, '[]'::jsonb, 1, 1, 'NOTIFIED')`);
      check("a month that is not LIVE is never announced", false, "it succeeded");
    } catch {
      check("a month that is not LIVE is never announced", true);
    }
    await sql`DELETE FROM plan_renewals WHERE org_id = ${A.orgId} AND period = ${lastMonth}`;
  }

  console.log("\nA channel partner moves its firm to a smaller plan");
  {
    const view = await downgradeView(pOrg.id);
    check("a firm on Team is offered Solo", view?.from === "GROWTH" && view.options.map((o) => o.key).join() === "LAUNCH", JSON.stringify(view));
    const asked = await requestDowngrade({ orgId: pOrg.id, userId: admin.id, to: "LAUNCH" });
    check("moving down is set for the first of next month", asked.ok && /-01$/.test(asked.effectiveOn), JSON.stringify(asked));
    const twice = await requestDowngrade({ orgId: pOrg.id, userId: admin.id, to: "LAUNCH" });
    check("and only once", !twice.ok);
    const up = await requestDowngrade({ orgId: pOrg.id, userId: admin.id, to: "SCALE" });
    check("never up this way", !up.ok);
    const pending = (await downgradeView(pOrg.id))?.pending;
    check("the firm sees the move it set", pending?.to === "LAUNCH");
    const stay = await cancelDowngrade({ orgId: pOrg.id, userId: admin.id, changeId: pending?.id ?? "" });
    check("and may stay on its plan", stay.ok && !(await downgradeView(pOrg.id))?.pending);
    const again = await requestDowngrade({ orgId: pOrg.id, userId: admin.id, to: "LAUNCH" });
    const effective = again.ok ? again.effectiveOn : "";
    try {
      await withTenant(pOrg.id, (tx) => tx`UPDATE plan_changes SET status = 'APPLIED', decided_at = now() WHERE org_id = ${pOrg.id} AND status = 'PENDING'`);
      check("the app never applies a plan change itself", false, "it succeeded");
    } catch (e) {
      check("the app never applies a plan change itself", refusedAs(e) === "42501", refusedAs(e));
    }
    const early = await applyPlanChanges(sql);
    check("nothing moves before the day", early.applied === 0);
    const applied = await applyPlanChanges(sql, `${effective}T02:00:00.000Z`);
    const subs = await sql<{ plan: string; starts_on: string; ends_on: string | null }[]>`
      SELECT plan, starts_on::text, ends_on::text FROM subscriptions WHERE org_id = ${pOrg.id} AND scope = 'ORG' ORDER BY starts_on`;
    const last = subs[subs.length - 1];
    check("on the day the firm is on Solo, the plan before ends that day",
      applied.applied === 1 && last?.plan === "LAUNCH" && last.starts_on === effective && last.ends_on === null && subs[subs.length - 2]?.ends_on === effective,
      JSON.stringify(subs));
  }
  }

  console.log("\nThe other tenant");
  const bSees = await overview(B.orgId, NOON);
  check("an organisation with no plan sees no plan and no top-ups", bSees.mode === null && bSees.wallet.every((w) => w.left === 0));
  void bProject;
} finally {
  fake.close();
  await sql`DELETE FROM calls WHERE org_id IN (${A.orgId}, ${B.orgId})`;
  await sql`DELETE FROM leads WHERE org_id IN (${A.orgId}, ${B.orgId})`;
  await sql`DELETE FROM audit_log WHERE org_id IN (${A.orgId}, ${B.orgId})`;
  await sql`DELETE FROM plan_renewals WHERE org_id IN (${A.orgId}, ${B.orgId})`.catch(() => {});
  await sql`DELETE FROM orgs WHERE id IN (${A.orgId}, ${B.orgId})`;
  for (const id of planOrgs) {
    await sql`DELETE FROM audit_log WHERE org_id = ${id}`;
    await sql`DELETE FROM plan_changes WHERE org_id = ${id}`.catch(() => {});
    await sql`DELETE FROM plan_renewals WHERE org_id = ${id}`.catch(() => {});
    await sql`DELETE FROM invoices WHERE org_id = ${id}`.catch(() => {});
    await sql`DELETE FROM subscriptions WHERE org_id = ${id}`.catch(() => {});
    await sql`DELETE FROM payments WHERE org_id = ${id}`.catch(() => {});
    await sql`DELETE FROM orgs WHERE id = ${id}`.catch((e) => console.warn("  could not remove a fixture org", e));
  }
  await sql`DELETE FROM users WHERE id = ${admin.id}`;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await sql.end();
  await closeDb();
  process.exitCode = fail === 0 ? 0 : 1;
}
