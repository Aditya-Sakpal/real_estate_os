// Demo home loans on the dev tenant (BillBay), so the Home loans screens can
// be seen full: four tie-up banks, ten loans at every stage, their documents
// and demands, and one of each thing Today warns about. Everything goes
// through the product's own functions, as a person would have done it.
//
//   npm run seed:loan-demo              put it in
//   npm run seed:loan-demo -- --remove  take all of it out again
//
// Every demo bank's address is @demo-bank.example and every demo loan names
// one of them, which is how --remove finds what to take out.
import postgres from "postgres";
import { saveBank } from "../src/lib/banks.ts";
import { addDemand, saveDocuments, saveLoan, stepDemand } from "../src/lib/loans.ts";
import type { Applicant, Arranger, LoanInput, LoanStage, Milestone } from "../src/lib/loan-rules.ts";
import { closeDb } from "../src/lib/db/index.ts";

const DOMAIN = "demo-bank.example";
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const daysAgo = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (n: number) => daysAgo(-n);

const [org] = await sql<{ org_id: string; admin: string }[]>`
  SELECT m.org_id, m.user_id AS admin FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.role = 'ORG_ADMIN' AND m.status = 'ACTIVE'
  JOIN orgs o ON o.id = m.org_id AND o.type = 'DEVELOPER' AND o.display_name = 'BillBay'
  ORDER BY u.created_at LIMIT 1`;
if (!org) throw new Error("BillBay is not on this database");
const orgId = org.org_id;
const userId = org.admin;

async function remove() {
  const loans = await sql<{ id: string; lead_id: string }[]>`
    SELECT o.id, o.lead_id FROM lead_loans o JOIN lenders k ON k.id = o.lender_id
    WHERE o.org_id = ${orgId} AND k.email LIKE ${"%@" + DOMAIN}`;
  const leads = loans.map((l) => l.lead_id);
  if (leads.length) {
    await sql`DELETE FROM lead_loans WHERE id = ANY(${loans.map((l) => l.id)}::uuid[])`;
    await sql`
      DELETE FROM lead_activity WHERE org_id = ${orgId} AND lead_id = ANY(${leads}::uuid[])
        AND (reason LIKE 'Home loan:%' OR reason LIKE 'Demand %' OR reason LIKE 'Bank paid%' OR reason LIKE 'Buyer paid%')`;
    await sql`DELETE FROM audit_log WHERE org_id = ${orgId} AND target_id = ANY(${leads}::text[]) AND action LIKE 'lead.loan%'`;
  }
  const banks = await sql<{ id: string }[]>`SELECT id FROM lenders WHERE org_id = ${orgId} AND email LIKE ${"%@" + DOMAIN}`;
  if (banks.length) {
    const ids = banks.map((b) => b.id);
    await sql`DELETE FROM lender_projects WHERE lender_id = ANY(${ids}::uuid[])`;
    await sql`DELETE FROM audit_log WHERE org_id = ${orgId} AND target_id = ANY(${ids}::text[]) AND action LIKE 'lender.%'`;
    await sql`DELETE FROM lenders WHERE id = ANY(${ids}::uuid[])`;
  }
  console.log(`removed ${loans.length} loans and ${banks.length} banks`);
}

if (process.argv.includes("--remove")) {
  await remove();
} else {
  const [already] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM lenders WHERE org_id = ${orgId} AND email LIKE ${"%@" + DOMAIN}`;
  if (already.n) {
    console.log("The demo is already in. Run with --remove first to put it in afresh.");
  } else {
    const projects = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PROJECT' AND name IN ('Sath Heights', 'Riverside Greens')`;
    const sath = projects.find((p) => p.name === "Sath Heights")!;
    const river = projects.find((p) => p.name === "Riverside Greens");

    // The banks.
    const bank = async (name: string, mail: string, extra: Partial<Parameters<typeof saveBank>[0]["input"]>) => {
      const r = await saveBank({
        orgId,
        userId,
        lenderId: null,
        input: { name, email: `${mail}@${DOMAIN}`, contactName: null, contactPhone: null, rateBp: null, feeNote: null, validUntil: null, projects: [], ...extra },
      });
      if (!r.ok) throw new Error(`${name}: ${r.message}`);
      const [row] = await sql<{ id: string }[]>`SELECT id FROM lenders WHERE org_id = ${orgId} AND email = ${`${mail}@${DOMAIN}`} AND active`;
      return row.id;
    };
    const hdfc = await bank("HDFC Bank, Goregaon", "hdfc", {
      contactName: "Rahul Joshi", contactPhone: "+919820012345", rateBp: 835, feeNote: "Processing fee waived for our buyers",
      validUntil: "2027-03-31", projects: [{ projectId: sath.id, apfNo: "APF/HDFC/2291" }],
    });
    const sbi = await bank("State Bank of India, Malad", "sbi", {
      contactName: "Priya Kulkarni", contactPhone: "+919820067890", rateBp: 825, feeNote: "0.35% plus GST, capped at Rs 10,000",
      validUntil: daysAhead(25), projects: [{ projectId: sath.id, apfNo: "SBI/APF/88214" }, ...(river ? [{ projectId: river.id, apfNo: null }] : [])],
    });
    const axis = await bank("Axis Bank", "axis", { contactName: "Imran Shaikh", rateBp: 875, feeNote: "Rs 5,000 flat" });
    const icici = await bank("ICICI Bank, Andheri", "icici", {
      contactName: "Neha Mehta", rateBp: 860, projects: river ? [{ projectId: river.id, apfNo: "ICICI/PF/4410" }] : [],
    });

    // Buyers to put loans on: the dev tenant's own leads, by stage.
    const pick = async (stage: string, n: number, taken: string[]) =>
      (await sql<{ id: string; name: string }[]>`
        SELECT l.id, l.name FROM leads l JOIN scope_nodes t ON t.id = l.scope_node_id
        WHERE l.org_id = ${orgId} AND l.stage = ${stage} AND l.erased_at IS NULL AND l.name IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM lead_loans o WHERE o.lead_id = l.id)
          AND NOT (l.id = ANY(${taken}::uuid[]))
        ORDER BY (t.name = 'Tower C') DESC, l.updated_at DESC LIMIT ${n}`);
    const taken: string[] = [];
    const take = async (stage: string, n: number) => {
      const rows = await pick(stage, n, taken);
      taken.push(...rows.map((r) => r.id));
      return rows;
    };
    const booked = await take("booked", 5);
    const nego = await take("negotiation", 2);
    const visited = await take("visit_done", 2);
    const qualified = await take("qualified", 1);

    const loan = async (leadId: string, o: Partial<LoanInput> & { stage: LoanStage }) => {
      const r = await saveLoan({
        orgId, userId, leadId,
        input: {
          lenderId: null, bankName: null, amountRupees: null, reason: null, applicant: null, rateBp: null,
          expiresOn: null, agreementRupees: null, arrangedBy: "DEVELOPER" as Arranger, ...o,
        },
      });
      if (!r.ok) throw new Error(`loan on ${leadId}: ${r.message}`);
    };
    // Walk a loan up its stages the way a desk would, so its history reads right.
    const walk = async (leadId: string, stages: LoanStage[], o: Partial<LoanInput>) => {
      for (const s of stages) await loan(leadId, { ...o, stage: s, ...(s === "SANCTIONED" || s === "DISBURSING" || s === "DISBURSED" ? {} : { amountRupees: null, rateBp: null, expiresOn: null }) });
    };
    const docs = (leadId: string, ticked: string[]) => saveDocuments({ orgId, userId, leadId, ticked, today });
    const demand = async (leadId: string, milestone: Milestone, on: string, amountRupees: number, slabNo: number | null = null) => {
      const r = await addDemand({ orgId, userId, leadId, input: { milestone, slabNo, demandOn: on, amountRupees } });
      if (!r.ok) throw new Error(`demand on ${leadId}: ${r.message}`);
      const [d] = await sql<{ id: string }[]>`
        SELECT d.id FROM lead_loan_demands d JOIN lead_loans o ON o.id = d.loan_id
        WHERE o.lead_id = ${leadId} ORDER BY d.created_at DESC LIMIT 1`;
      return d.id;
    };
    const step = async (leadId: string, demandId: string, s: Parameters<typeof stepDemand>[0]["step"]) => {
      const r = await stepDemand({ orgId, userId, leadId, demandId, step: s, today });
      if (!r.ok) throw new Error(`step on ${leadId}: ${r.message}`);
    };
    const salaried = ["PAN", "AADHAAR", "PHOTO", "BANK_STATEMENTS", "SALARY_SLIPS", "FORM_16", "ITR", "ALLOTMENT", "COST_SHEET", "RECEIPTS"];
    const made: string[] = [];

    // 1. Disbursing, the bank late on a demand.
    if (booked[0]) {
      const id = booked[0].id;
      const base = { lenderId: hdfc, applicant: "SALARIED" as Applicant, agreementRupees: 96_00_000, amountRupees: 72_00_000, rateBp: 840, expiresOn: daysAhead(120) };
      await walk(id, ["DOCUMENTS", "APPLIED", "APPRAISAL", "SANCTIONED"], base);
      await docs(id, [...salaried, "TDS", "AFS", "INDEX_II", "STAMP_DUTY", "BUILDER_NOC", "TPA"]);
      const d1 = await demand(id, "BOOKING", daysAgo(70), 9_60_000);
      await step(id, d1, { kind: "BUYER_PAID", on: daysAgo(68) });
      const d2 = await demand(id, "AGREEMENT", daysAgo(55), 19_20_000);
      await step(id, d2, { kind: "BUYER_PAID", on: daysAgo(53) });
      await step(id, d2, { kind: "SENT", on: daysAgo(53) });
      await step(id, d2, { kind: "BANK_PAID", on: daysAgo(44), amountRupees: 4_80_000 });
      const d3 = await demand(id, "PLINTH", daysAgo(30), 14_40_000);
      await step(id, d3, { kind: "SENT", on: daysAgo(22) });
      made.push(`${booked[0].name}: disbursing, HDFC late on the plinth demand`);
    }
    // 2. Sanctioned, the sanction about to lapse, a demand not yet sent.
    if (booked[1]) {
      const id = booked[1].id;
      const base = { lenderId: sbi, applicant: "SALARIED" as Applicant, agreementRupees: 1_10_00_000, amountRupees: 82_00_000, rateBp: 825, expiresOn: daysAhead(12) };
      await walk(id, ["DOCUMENTS", "APPLIED", "SANCTIONED"], base);
      await docs(id, [...salaried, "TDS", "AFS", "INDEX_II", "STAMP_DUTY", "BUILDER_NOC"]);
      const d1 = await demand(id, "BOOKING", daysAgo(40), 11_00_000);
      await step(id, d1, { kind: "BUYER_PAID", on: daysAgo(38) });
      await demand(id, "AGREEMENT", daysAgo(6), 22_00_000);
      made.push(`${booked[1].name}: sanctioned by SBI, lapses in 12 days, tripartite agreement missing`);
    }
    // 3. Rejected on a booked buyer.
    if (booked[2]) {
      const id = booked[2].id;
      await walk(id, ["DOCUMENTS", "APPLIED"], { lenderId: axis, applicant: "SELF_EMPLOYED" as Applicant, agreementRupees: 88_00_000 });
      await loan(id, { stage: "REJECTED", lenderId: axis, applicant: "SELF_EMPLOYED", agreementRupees: 88_00_000, reason: "CREDIT" });
      await docs(id, ["PAN", "AADHAAR", "PHOTO", "BANK_STATEMENTS", "ITR", "FINANCIALS", "ALLOTMENT"]);
      made.push(`${booked[2].name}: rejected by Axis (credit score), booking at risk`);
    }
    // 4. Fully disbursed.
    if (booked[3]) {
      const id = booked[3].id;
      const base = { lenderId: hdfc, applicant: "SALARIED" as Applicant, agreementRupees: 60_00_000, amountRupees: 45_00_000, rateBp: 830, expiresOn: null };
      await walk(id, ["APPLIED", "SANCTIONED"], base);
      await docs(id, [...salaried, "TDS", "AFS", "INDEX_II", "STAMP_DUTY", "BUILDER_NOC", "TPA", "OC", "POSSESSION_LETTER"]);
      const d1 = await demand(id, "AGREEMENT", daysAgo(120), 15_00_000);
      await step(id, d1, { kind: "BUYER_PAID", on: daysAgo(118) });
      const d2 = await demand(id, "POSSESSION", daysAgo(20), 45_00_000);
      await step(id, d2, { kind: "SENT", on: daysAgo(19) });
      await step(id, d2, { kind: "BANK_PAID", on: daysAgo(12), amountRupees: 45_00_000 });
      made.push(`${booked[3].name}: fully disbursed by HDFC`);
    }
    // 5. Paying without a loan.
    if (booked[4]) {
      await loan(booked[4].id, { stage: "NOT_NEEDED", agreementRupees: 72_00_000 });
      await sql`UPDATE lead_loans SET lender_id = ${hdfc} WHERE lead_id = ${booked[4].id}`;
      made.push(`${booked[4].name}: paying from own funds`);
    }
    // 6. Stuck at the bank's legal check for two weeks.
    if (nego[0]) {
      const id = nego[0].id;
      await walk(id, ["DOCUMENTS", "APPLIED", "APPRAISAL"], { lenderId: sbi, applicant: "NRI" as Applicant, agreementRupees: 1_35_00_000 });
      await docs(id, ["PAN", "PHOTO", "PASSPORT_VISA", "WORK_PROOF", "SALARY_SLIPS", "NRE_STATEMENTS", "ALLOTMENT", "COST_SHEET"]);
      await sql`UPDATE lead_loans SET stage_at = now() - interval '14 days' WHERE lead_id = ${id}`;
      made.push(`${nego[0].name}: NRI, stuck at SBI's legal check for 14 days`);
    }
    // 7. Applied through the partner's own bank, which has not approved the project.
    if (nego[1]) {
      const id = nego[1].id;
      await walk(id, ["DOCUMENTS", "APPLIED"], { lenderId: icici, applicant: "SALARIED" as Applicant, agreementRupees: 92_00_000, arrangedBy: "PARTNER" });
      await docs(id, salaried);
      made.push(`${nego[1].name}: applied to ICICI through the channel partner, not an approved bank`);
    }
    // 8 and 9. Collecting documents; eligibility checked.
    if (visited[0]) {
      await walk(visited[0].id, ["PRE_CHECK", "DOCUMENTS"], { lenderId: hdfc, applicant: "SELF_EMPLOYED" as Applicant, agreementRupees: 78_00_000 });
      await docs(visited[0].id, ["PAN", "AADHAAR", "ITR"]);
      made.push(`${visited[0].name}: collecting documents`);
    }
    if (visited[1]) {
      await loan(visited[1].id, { stage: "PRE_CHECK", lenderId: sbi, applicant: "SALARIED", agreementRupees: 65_00_000 });
      made.push(`${visited[1].name}: eligibility checked`);
    }
    // 10. Heard on a call that they will take a loan.
    if (qualified[0]) {
      await loan(qualified[0].id, { stage: "INTERESTED", lenderId: axis });
      made.push(`${qualified[0].name}: needs a loan`);
    }

    console.log(`4 banks and ${made.length} loans on BillBay:`);
    for (const m of made) console.log(`  ${m}`);
  }
}

await sql.end();
await closeDb();
