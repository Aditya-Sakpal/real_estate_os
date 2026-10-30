// The operator's billing tool.
//
// A plan is a contract, so the application role holds no grant to write one,
// nor to change an organisation's billing mode, nor to give free credit.
// This script is the one place those are written, on the owner's
// connection, and every write is audited.
//
//   npm run billing -- list
//   npm run billing -- plan --org <id> --project <id or name> --plan GROWTH
//                          [--pilot] [--annual] [--from 2026-10-01]
//                          [--channels 2] [--agents REENGAGER] [--numbers 1]
//   npm run billing -- plan --org <id> --firm --plan LAUNCH   a channel partner's plan for the whole firm
//   npm run billing -- end --org <id> --project <id or name> [--on 2026-10-31]   (or --firm)
//   npm run billing -- mode --org <id> --mode SHADOW|LIVE
//   npm run billing -- unbill --org <id>     back to no plan sold (shadow only)
//   npm run billing -- grant --org <id> --unit VIDEO --qty 2 [--months 12]
//   npm run billing -- sweep                 metering missed, lapsed top-ups,
//                                            and each organisation's automatic top-up
//   npm run billing -- credit-note EST/26-27/00001 --amount 500000 --reason "..."
//                          [--full] [--unit VIDEO] [--on 2026-10-05] [--refund]   a correction to an issued invoice,
//                                                    its money sent back through Razorpay with --refund
//   npm run billing -- refund ECN/26-27/00001   send a credit note's money back, or ask again
//   npm run billing -- mandate --org <id> --customer cust_... --token token_...
//                          --email accounts@x.com --contact +919800000000 --max 15000
//                          [--method CARD|UPI|EMANDATE] [--label "HDFC e-mandate"] [--test]
//   npm run billing -- mandate --org <id> --revoke
//   npm run billing -- margins [--month 2026-09]
//   npm run billing -- invoice --month 2026-10   plan invoices, LIVE tenants
import postgres from "postgres";
import {
  ADD_ONS,
  AGENT_JOB_LABEL,
  COST_PAISE,
  PILOT,
  PLANS,
  PLATFORM_PAISE,
  PARTNER_PLATFORM_PAISE,
  PLAN_FLOOR,
  WALLET_UNITS,
  WORST_FLOOR,
  isPlanKey,
  istDate,
  margin,
  monthOf,
  planLines,
  proratedPrice,
  readTerms,
  rupees,
  sellerFromEnv,
  setupFor,
  termsFor,
  pilotTerms,
  planLabel,
  type AgentJob,
  type PlanKey,
  type SubscriptionRow,
} from "../src/lib/billing-rules.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const [cmd] = process.argv.slice(2);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const die = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const isId = (v: string | undefined) => !!v && /^[0-9a-f-]{36}$/i.test(v);
const isDay = (v: string | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function audit(orgId: string, action: string, targetId: string, metadata: Record<string, unknown>) {
  await sql`
    INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (${orgId}, NULL, ${action}, 'org', ${targetId}, ${sql.json(metadata as never)})`;
}

/** A credit note's money back through Razorpay, audited, and said. Exits non-zero when it was not sent. */
async function refundAndSay(number: string) {
  const { refundCreditNote } = await import("../src/lib/billing-refund.ts");
  const r = await refundCreditNote(sql, number);
  if (r.orgId && r.creditNoteId && (r.ok ? !r.already : r.asked)) {
    await audit(r.orgId, "billing.credit_note_refunded", r.creditNoteId, r.ok ? { status: r.status, paise: r.amountPaise } : { status: "ASKED" });
  }
  if (!r.ok) die(`Refund for ${number}: ${r.message}`);
  if (r.ok) {
    const words = r.status === "PROCESSED" ? "refunded" : r.status === "PENDING" ? "refund asked, Razorpay is processing it" : "refund did not go through";
    console.log(`${number}: ${rupees(r.amountPaise, true)} ${words}${r.already ? " (already)" : ""}, ${r.refundId}.`);
    if (r.status === "FAILED") process.exitCode = 1;
  }
}

async function orgOf(id: string | undefined) {
  if (!isId(id)) die("--org <uuid> is required");
  const [o] = await sql<{ id: string; display_name: string }[]>`SELECT id, display_name FROM orgs WHERE id = ${id!}`;
  return o ?? die(`no organisation ${id}`);
}

async function projectOf(orgId: string, ref: string | undefined) {
  if (!ref) die("--project <id or name> is required");
  const rows = isId(ref)
    ? await sql<{ id: string; name: string }[]>`SELECT id, name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PROJECT' AND id = ${ref!}`
    : await sql<{ id: string; name: string }[]>`SELECT id, name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PROJECT' AND lower(name) = lower(${ref!})`;
  if (rows.length > 1) die(`${rows.length} projects are called "${ref}"; use the id`);
  return rows[0] ?? die(`no project "${ref}" in that organisation`);
}

type Row = {
  id: string;
  project_id: string | null;
  project: string | null;
  payment_id: string | null;
  plan: string;
  status: "PILOT" | "ACTIVE";
  cycle: "MONTHLY" | "ANNUAL";
  starts_on: string;
  ends_on: string | null;
  terms: unknown;
  extra_channels: number;
  extra_agents: string[];
  extra_numbers: number;
  setup_paise: string;
};
const toSub = (r: Row): SubscriptionRow & { projectId: string | null } => {
  const plan: PlanKey = isPlanKey(r.plan) ? r.plan : "LAUNCH";
  return {
    id: r.id,
    projectId: r.project_id,
    project: r.project ?? "All projects",
    plan,
    status: r.status,
    cycle: r.cycle,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    terms: readTerms(plan, r.terms),
    extraChannels: r.extra_channels,
    extraAgents: r.extra_agents as AgentJob[],
    extraNumbers: r.extra_numbers,
    setupPaise: Number(r.setup_paise),
    prepaid: !!r.payment_id,
  };
};
const subsOf = async (orgId: string, period: string) =>
  (
    await sql<Row[]>`
      SELECT s.id, s.project_id, n.name AS project, s.plan, s.status, s.cycle, s.starts_on::text AS starts_on,
             s.ends_on::text AS ends_on, s.terms, s.extra_channels, s.extra_agents, s.extra_numbers, s.setup_paise, s.payment_id
      FROM subscriptions s LEFT JOIN scope_nodes n ON n.id = s.project_id
      WHERE s.org_id = ${orgId} AND s.starts_on < (${period}::date + interval '1 month')
        AND (s.ends_on IS NULL OR s.ends_on > ${period}::date)
      ORDER BY n.name, s.starts_on`
  ).map(toSub);

try {
  if (cmd === "list") {
    const rows = await sql<{ org: string; name: string; mode: string; project: string | null; plan: string | null; status: string | null; starts_on: string | null; ends_on: string | null }[]>`
      SELECT o.id AS org, o.display_name AS name, b.mode, n.name AS project, s.plan, s.status,
             s.starts_on::text AS starts_on, s.ends_on::text AS ends_on
      FROM billing_accounts b JOIN orgs o ON o.id = b.org_id
      LEFT JOIN subscriptions s ON s.org_id = o.id
      LEFT JOIN scope_nodes n ON n.id = s.project_id
      ORDER BY o.display_name, n.name, s.starts_on`;
    if (!rows.length) console.log("No plan has been sold to anybody.");
    for (const r of rows) {
      console.log(`${r.name} (${r.org}) ${r.mode}${r.plan ? `  ${r.project ?? "whole firm"}: ${r.plan} ${r.status} from ${r.starts_on}${r.ends_on ? ` to ${r.ends_on}` : ""}` : ""}`);
    }
  } else if (cmd === "plan") {
    const org = await orgOf(arg("org"));
    const firm = flag("firm");
    const project = firm ? { id: null as string | null, name: "The whole firm" } : await projectOf(org.id, arg("project"));
    if (firm && flag("pilot")) die("a firm-wide plan has no pilot");
    const pilot = flag("pilot");
    const planKey = pilot ? PILOT.plan : (arg("plan") ?? "").toUpperCase();
    if (!isPlanKey(planKey)) die("--plan LAUNCH, GROWTH or SCALE is required (or --pilot)");
    const plan = planKey as PlanKey;
    const from = arg("from") ?? istDate(new Date().toISOString());
    if (!isDay(from)) die("--from is a date, YYYY-MM-DD");
    const agents = (arg("agents") ?? "").split(",").map((a) => a.trim().toUpperCase()).filter(Boolean);
    for (const a of agents) if (!(a in AGENT_JOB_LABEL)) die(`unknown agent ${a}; one of ${Object.keys(AGENT_JOB_LABEL).join(", ")}`);
    if (agents.length && plan !== "LAUNCH") die(`${ADD_ONS.EXTRA_AGENT.label} is for Launch only`);
    const channels = Number(arg("channels") ?? 0);
    const numbers = Number(arg("numbers") ?? 0);
    if (!Number.isInteger(channels) || channels < 0 || channels > 40) die("--channels is 0 to 40");
    if (!Number.isInteger(numbers) || numbers < 0 || numbers > 10) die("--numbers is 0 to 10");

    const id = await sql.begin(async (tx) => {
      await tx`INSERT INTO billing_accounts (org_id) VALUES (${org.id}) ON CONFLICT (org_id) DO NOTHING`;
      const [open] = await tx<{ id: string; starts_on: string }[]>`
        SELECT id, starts_on::text AS starts_on FROM subscriptions
        WHERE ${firm ? tx`org_id = ${org.id} AND scope = 'ORG'` : tx`project_id = ${project.id}`}
          AND starts_on <= ${from} AND (ends_on IS NULL OR ends_on > ${from})`;
      if (open) {
        if (open.starts_on === from) throw new Error(`${project.name} already has a plan starting ${from}; end it first`);
        await tx`UPDATE subscriptions SET ends_on = ${from} WHERE id = ${open.id}`;
      }
      const [{ earlier }] = await tx<{ earlier: number }[]>`
        SELECT count(*)::int AS earlier FROM subscriptions WHERE org_id = ${org.id} AND status = 'ACTIVE'`;
      const [{ ownActive, ownPilot }] = await tx<{ ownActive: number; ownPilot: number }[]>`
        SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS "ownActive", count(*) FILTER (WHERE status = 'PILOT')::int AS "ownPilot"
        FROM subscriptions WHERE ${firm ? tx`org_id = ${org.id} AND scope = 'ORG'` : tx`project_id = ${project.id}`}`;
      const setup = pilot || ownActive > 0 ? 0 : setupFor({ earlierPlans: earlier, hadPilot: ownPilot > 0, scope: firm ? "ORG" : "PROJECT" });
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO subscriptions (org_id, project_id, scope, plan, status, cycle, starts_on, ends_on, terms,
                                   extra_channels, extra_agents, extra_numbers, setup_paise)
        VALUES (${org.id}, ${project.id}, ${firm ? "ORG" : "PROJECT"}, ${plan}, ${pilot ? "PILOT" : "ACTIVE"}, ${flag("annual") ? "ANNUAL" : "MONTHLY"},
                ${from}, ${pilot ? addDays(from, PILOT.days) : null}, ${tx.json((pilot ? pilotTerms() : termsFor(plan, firm ? "ORG" : "PROJECT")) as never)},
                ${channels}, ${agents}, ${numbers}, ${setup})
        RETURNING id`;
      return row.id;
    });
    await audit(org.id, "billing.plan_set", id, { project: project.id, firm, plan, pilot, annual: flag("annual"), from, channels, numbers, agents });
    console.log(`${project.name}: ${pilot ? `${PILOT.days}-day pilot on Launch limits` : `${planLabel(plan, firm ? "ORG" : "PROJECT")}`} from ${from}.`);
  } else if (cmd === "end") {
    const org = await orgOf(arg("org"));
    const firm = flag("firm");
    const project = firm ? { id: null as string | null, name: "The whole firm" } : await projectOf(org.id, arg("project"));
    const on = arg("on") ?? istDate(new Date().toISOString());
    if (!isDay(on)) die("--on is a date, YYYY-MM-DD");
    const r = await sql`
      UPDATE subscriptions SET ends_on = ${on}
      WHERE ${firm ? sql`org_id = ${org.id} AND scope = 'ORG'` : sql`project_id = ${project.id}`}
        AND starts_on < ${on} AND (ends_on IS NULL OR ends_on > ${on})
      RETURNING id`;
    if (!r.count) die(`${project.name} has no plan running on ${on}`);
    await audit(org.id, "billing.plan_ended", r[0].id as string, { project: project.id, on });
    console.log(`${project.name}: plan ends ${on}.`);
  } else if (cmd === "mode") {
    const org = await orgOf(arg("org"));
    const mode = (arg("mode") ?? "").toUpperCase();
    if (mode !== "SHADOW" && mode !== "LIVE") die("--mode SHADOW or LIVE");
    if (mode === "LIVE" && !sellerFromEnv(process.env).ok) die("LIVE needs BILLING_SELLER_NAME, BILLING_SELLER_GSTIN and BILLING_SELLER_ADDRESS: a charge needs a tax invoice");
    await sql`
      INSERT INTO billing_accounts (org_id, mode) VALUES (${org.id}, ${mode})
      ON CONFLICT (org_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`;
    await audit(org.id, "billing.mode_set", org.id, { mode });
    console.log(`${org.display_name}: ${mode}.`);
  } else if (cmd === "unbill") {
    // Takes a shadow-mode organisation back to having no plan sold: for a
    // pilot that did not go ahead, or a dev tenant put on a plan to try it.
    // What it used stays metered; nothing that ever moved real money is
    // touched, so a LIVE organisation, or one with a real invoice or
    // payment, is refused.
    const org = await orgOf(arg("org"));
    const [acct] = await sql<{ mode: string }[]>`SELECT mode FROM billing_accounts WHERE org_id = ${org.id}`;
    if (!acct) die(`${org.display_name} has no plan to remove`);
    if (acct.mode === "LIVE") die("a LIVE organisation is not unbilled; end its plans instead");
    const [real] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM invoices WHERE org_id = ${org.id} AND NOT test)
           + (SELECT count(*) FROM payments WHERE org_id = ${org.id} AND NOT test AND status = 'PAID') AS n`;
    if (Number(real.n) > 0) die("it has a real invoice or payment; end its plans instead");
    await sql.begin(async (tx) => {
      await tx`DELETE FROM billing_events WHERE org_id = ${org.id}`;
      await tx`DELETE FROM wallet_entries WHERE org_id = ${org.id}`;
      await tx`DELETE FROM auto_topup_charges WHERE org_id = ${org.id}`;
      await tx`DELETE FROM billing_mandates WHERE org_id = ${org.id}`;
      await tx`DELETE FROM invoices WHERE org_id = ${org.id}`;
      await tx`DELETE FROM payments WHERE org_id = ${org.id}`;
      await tx`DELETE FROM subscriptions WHERE org_id = ${org.id}`;
      await tx`DELETE FROM billing_accounts WHERE org_id = ${org.id}`;
    });
    await audit(org.id, "billing.unbilled", org.id, {});
    console.log(`${org.display_name}: no plan sold; its use is still metered, and nothing is refused on account of billing.`);
  } else if (cmd === "grant") {
    const org = await orgOf(arg("org"));
    const unit = (arg("unit") ?? "").toUpperCase();
    if (!(WALLET_UNITS as readonly string[]).includes(unit)) die(`--unit one of ${WALLET_UNITS.join(", ")}`);
    const raw = Number(arg("qty"));
    // WhatsApp credit is typed in rupees and held in paise.
    const qty = unit === "WHATSAPP" ? Math.round(raw * 100) : raw;
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_00_00_000) die("--qty is a positive number");
    const months = Number(arg("months") ?? 12);
    if (!Number.isInteger(months) || months < 1 || months > 24) die("--months is 1 to 24");
    const [billed] = await sql`SELECT 1 FROM billing_accounts WHERE org_id = ${org.id}`;
    if (!billed) die("that organisation has no plan; set one first");
    const expires = new Date();
    expires.setUTCMonth(expires.getUTCMonth() + months);
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO wallet_entries (org_id, kind, unit, qty, expires_at, source)
      VALUES (${org.id}, 'CREDIT', ${unit}, ${qty}, ${expires.toISOString()}, 'GRANT')
      RETURNING id`;
    await audit(org.id, "billing.credit_granted", row.id, { unit, qty, months });
    console.log(`${org.display_name}: ${unit === "WHATSAPP" ? rupees(qty) : qty} ${unit.toLowerCase()} granted, for ${months} months.`);
  } else if (cmd === "sweep") {
    const { meterMissed, expireLots } = await import("../src/lib/billing.ts");
    const { meterCallingNumbers } = await import("../src/lib/calling-numbers.ts");
    const { closeDb } = await import("../src/lib/db/index.ts");
    const orgs = await sql<{ id: string }[]>`SELECT id FROM orgs WHERE status <> 'SUSPENDED' ORDER BY created_at`;
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { runAutoTopUp } = await import("../src/lib/auto-topup.ts");
    const { sweepMandateSetups } = await import("../src/lib/mandate-setup.ts");
    const { applyPlanChanges, runPlanRenewal } = await import("../src/lib/plan-renewal.ts");
    const billed = new Set((await sql<{ id: string }[]>`SELECT org_id AS id FROM billing_accounts`).map((r) => r.id));
    // A channel partner's move to a smaller plan, on the first of the month it was asked for.
    const changes = await applyPlanChanges(sql);
    const renewals: Record<string, number> = {};
    let metered = 0;
    let expired = 0;
    let numbers = 0;
    const auto: Record<string, number> = {};
    for (const o of orgs) {
      metered += await meterMissed(o.id, since);
      expired += await expireLots(o.id);
      numbers += await meterCallingNumbers(o.id);
      if (!billed.has(o.id)) continue;
      try {
        // A mandate the client set up whose answer never came, or whose bank confirms it late.
        const m = await sweepMandateSetups(o.id);
        if (m.confirmed) auto["mandate confirmed"] = (auto["mandate confirmed"] ?? 0) + m.confirmed;
        if (m.expired) auto["mandate set-up let go"] = (auto["mandate set-up let go"] ?? 0) + m.expired;
      } catch (e) {
        console.error(`mandate set-up for ${o.id} failed`, e);
      }
      try {
        const r = await runAutoTopUp(o.id);
        if (r.decided !== "none") {
          const k = `${r.status ?? ""} ${r.why ?? ""}`.trim();
          auto[k] = (auto[k] ?? 0) + 1;
        }
      } catch (e) {
        console.error(`automatic top-up for ${o.id} failed`, e);
      }
      try {
        // The month's plan: recorded in shadow mode, taken or waiting to be paid once LIVE.
        const r = await runPlanRenewal(o.id);
        if (r.done !== "none") {
          const k = `${r.status ?? ""} ${r.why ?? ""}`.trim();
          renewals[k] = (renewals[k] ?? 0) + 1;
        }
      } catch (e) {
        console.error(`plan renewal for ${o.id} failed`, e);
      }
    }
    await closeDb();
    const autoLine = Object.entries(auto).map(([k, n]) => `${n} ${k}`).join(", ");
    const renewLine = Object.entries(renewals).map(([k, n]) => `${n} ${k}`).join(", ");
    console.log(`${orgs.length} organisations: ${metered} outcomes metered late, ${expired} top-ups expired, ${numbers} calling-number months metered.${autoLine ? ` Automatic top-ups: ${autoLine}.` : ""}${renewLine ? ` Plan renewals: ${renewLine}.` : ""}${changes.applied || changes.refused ? ` Smaller plans: ${changes.applied} applied, ${changes.refused} kept the plan.` : ""}`);
  } else if (cmd === "credit-note") {
    // A correction to an issued invoice is a credit note, never an edit
    // (section 34 of the CGST Act, Rule 53). The amount is the taxable value
    // taken off, in paise; the tax follows the invoice's own heads.
    const number = (process.argv[3] ?? "").toUpperCase();
    if (!/^[A-Z]{3}\/\d{2}-\d{2}\/\d{5}$/.test(number)) die("credit-note <invoice number>, as EST/26-27/00001");
    const full = flag("full");
    const amount = full ? ("ALL" as const) : Number(arg("amount"));
    if (!full && (!Number.isInteger(amount) || (amount as number) <= 0)) die("--amount <paise of taxable value>, or --full");
    const on = arg("on") ?? istDate(new Date().toISOString());
    if (!isDay(on)) die("--on is a date, YYYY-MM-DD");
    const [inv] = await sql<{ org_id: string }[]>`SELECT org_id FROM invoices WHERE number = ${number}`;
    if (!inv) die(`no invoice ${number}`);
    const { issueCreditNote } = await import("../src/lib/invoice.ts");
    const unit = arg("unit")?.toUpperCase() ?? null;
    if (unit && !(WALLET_UNITS as readonly string[]).includes(unit)) die(`--unit one of ${WALLET_UNITS.join(", ")}`);
    const out = await sql.begin((tx) => issueCreditNote(tx, { orgId: inv.org_id, invoiceNumber: number, amount, reason: arg("reason") ?? "", issuedOn: on, unit }));
    if (!out.ok) die(out.message);
    if (out.ok) {
      await audit(inv.org_id, "billing.credit_note_issued", out.id, {
        number: out.number,
        against: number,
        total_paise: out.totalPaise,
        taken: out.taken,
      });
      const took = out.taken.length ? ` Took back ${out.taken.map((t) => `${t.unit === "WHATSAPP" ? rupees(t.qty) : t.qty} ${t.unit.toLowerCase()}`).join(", ")}.` : "";
      console.log(`${out.number} against ${number}: ${rupees(out.totalPaise, true)} credited.${took}`);
      // The credit note is issued whatever happens next; the refund is its own step, asked again with `refund`.
      if (flag("refund")) await refundAndSay(out.number);
    }
  } else if (cmd === "refund") {
    // Send a credit note's money back, or ask again about one sent before.
    const number = (process.argv[3] ?? "").toUpperCase();
    if (!/^[A-Z]{3}\/\d{2}-\d{2}\/\d{5}$/.test(number)) die("refund <credit note number>, as ECN/26-27/00001");
    await refundAndSay(number);
  } else if (cmd === "mandate") {
    // The client authorised a recurring mandate at Razorpay; this records
    // it, sealed, so automatic top-ups can charge it. Only the operator
    // writes one: the app role can read it and nothing more.
    const org = await orgOf(arg("org"));
    if (flag("revoke")) {
      const r = await sql`UPDATE billing_mandates SET status = 'REVOKED', revoked_at = now() WHERE org_id = ${org.id} AND status = 'ACTIVE' RETURNING id`;
      if (!r.count) die(`${org.display_name} has no saved mandate`);
      await audit(org.id, "billing.mandate_revoked", r[0].id as string, {});
      console.log(`${org.display_name}: mandate no longer used.`);
    } else {
      const customer = arg("customer") ?? "";
      const token = arg("token") ?? "";
      const email = arg("email") ?? "";
      const contact = (arg("contact") ?? "").replace(/\s+/g, "");
      if (!/^cust_[A-Za-z0-9]{6,40}$/.test(customer)) die("--customer is Razorpay's customer id, cust_...");
      if (!/^token_[A-Za-z0-9]{6,40}$/.test(token)) die("--token is Razorpay's token id, token_...");
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) die("--email is the address Razorpay holds for the customer");
      if (!/^\+?\d{10,13}$/.test(contact)) die("--contact is the phone Razorpay holds for the customer");
      const max = Math.round(Number(arg("max")) * 100);
      if (!Number.isInteger(max) || max <= 0) die("--max is the mandate's maximum in rupees");
      const method = (arg("method") ?? "EMANDATE").toUpperCase();
      if (!["CARD", "UPI", "EMANDATE"].includes(method)) die("--method CARD, UPI or EMANDATE");
      const label = arg("label")?.trim() || null;
      if (label && (label.length > 60 || /\d{6,}|@/.test(label))) die("--label is a name like \"HDFC e-mandate\", never a number or a UPI id");
      const { seal } = await import("../src/lib/vault.ts");
      const { mandatePurpose } = await import("../src/lib/auto-topup.ts");
      const [{ id }] = await sql<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
      const sealed = await seal(org.id, mandatePurpose(id), JSON.stringify({ customerId: customer, token, email, contact }));
      if (!sealed) die("CONNECTOR_KEY is not set: a mandate is never stored in the clear");
      await sql.begin(async (tx) => {
        await tx`UPDATE billing_mandates SET status = 'REVOKED', revoked_at = now() WHERE org_id = ${org.id} AND status = 'ACTIVE'`;
        await tx`
          INSERT INTO billing_mandates (id, org_id, method, label, secret, key_version, max_amount_paise, test)
          VALUES (${id}, ${org.id}, ${method}, ${label}, ${sealed!.secret}, ${sealed!.keyVersion}, ${max}, ${flag("test")})`;
      });
      await audit(org.id, "billing.mandate_saved", id, { method, max_paise: max, test: flag("test") });
      console.log(`${org.display_name}: mandate saved (${method}, up to ${rupees(max)} a charge${flag("test") ? ", test mode" : ""}).`);
    }
  } else if (cmd === "margins") {
    const month = arg("month") ?? monthOf(new Date().toISOString()).period.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) die("--month is YYYY-MM");
    const period = `${month}-01`;
    const orgs = await sql<{ id: string }[]>`SELECT org_id AS id FROM billing_accounts`;
    const by: Record<string, { projects: number; revenue: number; cost: number }> = {};
    for (const o of orgs) {
      for (const s of await subsOf(o.id, period)) {
        const key = s.status === "PILOT" ? "PILOT" : s.terms.firm ? `PARTNER_${s.plan}` : s.plan;
        const b = (by[key] ??= { projects: 0, revenue: 0, cost: 0 });
        b.projects++;
        b.revenue += s.status === "PILOT" ? PILOT.pricePaise : proratedPrice(s.terms.pricePaise, s, period);
        const [u] = await sql<{ cost: string }[]>`
          SELECT coalesce(sum(cost_paise), 0) AS cost FROM usage_events
          WHERE org_id = ${o.id} AND project_id = ${s.projectId} AND period = ${period}
            -- A number's month is counted below, with the plan's own numbers.
            AND kind <> 'PHONE_NUMBER'
            AND occurred_at >= ${s.startsOn}::date AND (${s.endsOn}::date IS NULL OR occurred_at < ${s.endsOn}::date)`;
        const fixed =
          (s.terms.channels + s.extraChannels) * COST_PAISE.CHANNEL_MONTH +
          (s.terms.numbers + s.extraNumbers) * COST_PAISE.NUMBER_MONTH +
          (s.terms.firm ? PARTNER_PLATFORM_PAISE : PLATFORM_PAISE)[s.plan];
        b.cost += Number(u.cost) + proratedPrice(fixed, s, period);
      }
    }
    const [unassigned] = await sql<{ cost: string; n: number }[]>`
      SELECT coalesce(sum(cost_paise), 0) AS cost, count(DISTINCT org_id)::int AS n FROM usage_events
      WHERE period = ${period} AND plan IS NULL`;
    console.log(`\nOur cost against each plan, ${month} (estimated from metered use; platform and support at pricing.md's figures)\n`);
    for (const [k, b] of Object.entries(by)) {
      const m = margin(b.revenue, b.cost);
      const floor = k === "PILOT" ? WORST_FLOOR : PLAN_FLOOR;
      console.log(`  ${k.padEnd(7)} ${String(b.projects).padStart(3)} projects  revenue ${rupees(b.revenue).padStart(16)}  cost ${rupees(b.cost).padStart(14)}  margin ${(m * 100).toFixed(1)}%${m < floor ? `  UNDER THE ${Math.round(floor * 100)}% FLOOR` : ""}`);
    }
    if (!Object.keys(by).length) console.log("  No plan ran that month.");
    console.log(`\n  With no plan sold: ${unassigned.n} organisations, ${rupees(Number(unassigned.cost))} of our cost.\n`);
  } else if (cmd === "invoice") {
    const month = arg("month");
    if (!month || !/^\d{4}-\d{2}$/.test(month)) die("--month YYYY-MM is required");
    const seller = sellerFromEnv(process.env);
    if (!seller.ok) die(`no tax invoice without the seller: set ${seller.missing.join(", ")}`);
    const { buyerOf, issueInvoice } = await import("../src/lib/invoice.ts");
    const period = `${month}-01`;
    const orgs = await sql<{ id: string; name: string }[]>`
      SELECT b.org_id AS id, o.display_name AS name FROM billing_accounts b JOIN orgs o ON o.id = b.org_id WHERE b.mode = 'LIVE'`;
    for (const o of orgs) {
      // A month that renews by itself is invoiced when it is paid.
      const [renewing] = await sql`SELECT 1 FROM plan_renewals WHERE org_id = ${o.id} AND period = ${period} AND status <> 'CANCELLED'`;
      if (renewing) {
        console.log(`${o.name}: renews by itself, invoiced when paid`);
        continue;
      }
      const lines = planLines(await subsOf(o.id, period), period);
      if (!lines.length) continue;
      try {
        const inv = await sql.begin(async (tx) => {
          const buyer = await buyerOf(tx, o.id);
          if (!buyer) throw new Error("no billing state on record");
          return issueInvoice(tx, {
            orgId: o.id,
            purpose: "PLAN",
            test: false,
            lines,
            seller: seller.ok ? seller.seller : (undefined as never),
            bank: seller.ok ? seller.bank : null,
            buyer,
            issuedOn: istDate(new Date().toISOString()),
            period,
          });
        });
        await audit(o.id, "billing.invoice_issued", inv.id, { number: inv.number, purpose: "PLAN", period, total_paise: inv.totalPaise });
        console.log(`${o.name}: ${inv.number}, ${rupees(inv.totalPaise, true)}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`${o.name}: not issued, ${/invoices_plan_month/.test(msg) ? "already issued for that month" : msg}`);
      }
    }
  } else {
    die("usage: npm run billing -- list | plan | end | mode | unbill | grant | sweep | margins | invoice | credit-note | refund | mandate (see the top of scripts/billing.mts)");
  }
} finally {
  await sql.end();
}
