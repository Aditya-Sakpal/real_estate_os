/**
 * The Channel Partner OS, end to end, with Sarvam, WhatsApp and the file
 * store injected.
 *
 * Two tenants of its own, built here and removed at the end: a firm
 * empanelled by both (one org, two desks), buyers registered against it and
 * refused for every reason the verdict has, a buyer who enquires later and
 * lands on the partner's claim (R2), the call the claim holds back, a visit
 * booked for the partner that carries the claim forward, a booking that
 * writes the payout on the project's ladder, the payout walked from invoice
 * to UTR, a cancelled booking handing the claim back, and the sweep
 * releasing a claim whose day has passed. Then the partner's side on
 * WhatsApp: a person on a firm's list proving their number, registering and
 * booking through the bot, the three things that ask for a fresh code, the
 * payout told unprompted, and a buyer tapping a partner's wa.me link.
 *
 * Time is passed in where the functions take it, so the suite runs the same
 * at 3 pm and at 3 am.
 */
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { useSarvam } from "../src/lib/sarvam.ts";
import { useWhatsApp } from "../src/lib/whatsapp.ts";
import { connectFixtureNumber, dropFixtureNumbers } from "./whatsapp-fixture.mts";
import { useStorage, type StorageDriver } from "../src/lib/storage.ts";
import { useVaultKey } from "../src/lib/vault.ts";
import { closeDb } from "../src/lib/db/index.ts";
import { ingestWhatsApp } from "../src/lib/messaging.ts";
import { useCodeSender } from "../src/lib/otp.ts";
import { phoneHash } from "../src/lib/otp-rules.ts";
import { usePartnerModel } from "../src/lib/partner-bot.ts";
import { notifyPayout } from "../src/lib/partner-notify.ts";
import { addAgent, removeAgent, revealRegistration, findRegistrations } from "../src/lib/partners.ts";
import { placeCall } from "../src/lib/calling.ts";
import { recordEvent } from "../src/lib/leads.ts";
import { bookPartnerVisit, onVisitAction, processEvent } from "../src/lib/lead-engine.ts";
import {
  changeGrant,
  empanelFirm,
  fileInvoice,
  loadDesk,
  moveMilestone,
  onBooked,
  onUnbooked,
  readFirm,
  recordBookingDates,
  bankPaidForLead,
  registerBuyer,
  saveSettings,
  saveTerms,
  setPassBack,
  sweepRegistrations,
} from "../src/lib/partners.ts";
import { DEFAULT_TERMS } from "../src/lib/partner-rules.ts";
import { makeLink, retireLink } from "../src/lib/partners.ts";
import { partnerPost } from "../src/lib/partner-posts.ts";
import { stampPartner } from "../src/lib/cobrand.ts";
import { realReport } from "../src/lib/lead-report.ts";
import sharp from "sharp";
import { ist, istAt } from "../src/lib/cadence-rules.ts";
import { gstinCheckDigit } from "../src/lib/gstin.ts";

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
useVaultKey(randomBytes(32));

const dialled: string[] = [];
useSarvam({
  async placeOutbound(_c, req) {
    dialled.push(req.toNumber);
    return { attemptId: `att-${process.pid}-${dialled.length}` };
  },
  async getRecording() {
    return null;
  },
});
useWhatsApp({
  async sendTemplate() {
    return { id: `wamid.${Date.now()}.${Math.random()}` };
  },
});
const stored = new Map<string, Buffer>();
const memory: StorageDriver = {
  name: "memory",
  async put(key, bytes) {
    stored.set(key, bytes);
  },
  async signedUrl(key) {
    return `memory://${key}`;
  },
  async remove(key) {
    stored.delete(key);
  },
  async copy(a, b) {
    stored.set(b, stored.get(a)!);
  },
  async read(key) {
    return stored.get(key) ?? null;
  },
};
useStorage(memory);

// ---------------------------------------------------------------------------
// Two tenants of their own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const PAN = `AAAFK${String(Date.now() % 10000).padStart(4, "0")}Z`;
const made = { users: [] as string[], orgs: [] as string[] };
async function tenant(name: string, slug: string) {
  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${`admin@${slug}${tag}.example`}, ${`${slug}${tag}.example`}, ${`${name} Admin`}) RETURNING id`;
  const [rm] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${`tanmay@${slug}${tag}.example`}, ${`${slug}${tag}.example`}, 'Tanmay Kulkarni') RETURNING id`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', ${name}, ${name}, 'AAPFU0939F', ${`${slug}${tag}.example`}, ${admin.id}) RETURNING id`;
  made.users.push(admin.id, rm.id);
  made.orgs.push(org.id);
  const [root] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, NULL, 'ORG', ${name}, ${`${slug}_${tag}`}, ${`${slug}_${tag}`}::ltree) RETURNING id, path::text AS path`;
  const node = async (parent: { id: string; path: string }, kind: string, n: string, s: string) => {
    const [row] = await sql<{ id: string; path: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${org.id}, ${parent.id}, ${kind}, ${n}, ${s}, ${`${parent.path}.${s}`}::ltree) RETURNING id, path::text AS path`;
    return row;
  };
  const entity = await node(root, "ENTITY", `${name} LLP`, "spv");
  const region = await node(entity, "REGION", "Pune", "pune");
  const project = await node(region, "PROJECT", "Sath Heights", "sath_heights");
  const towerC = await node(project, "PHASE", "Tower C", "tower_c");
  const other = await node(region, "PROJECT", "Riverside Greens", "riverside");
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${org.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
  // WhatsApp goes only from the developer's own connected number.
  await connectFixtureNumber(sql, org.id, root.id);
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${rm.id}, ${org.id}, ${region.id}, 'CP_RELATIONSHIP_MANAGER', 'ACTIVE')`;
  const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
  await sql`
    INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, promoter_name, valid_to, verified_at)
    VALUES (${towerC.id}, ${org.id}, 'VERIFIED', 'P52100012345', 'MH', ${`${name} LLP`}, ${FAR}, now())`;
  return { orgId: org.id, admin: admin.id, rm: rm.id, root, project, towerC, other };
}

const A = await tenant("Sath Group", "cpa");
const B = await tenant("Kolte Homes", "cpb");
const NOW = new Date().toISOString();
const today = ist(NOW).date;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const firmForm = (over: Record<string, string> = {}) => ({
  name: "Keystone Realty",
  legalName: "Keystone Realty LLP",
  pan: PAN,
  gstin: `27${PAN}1Z${gstinCheckDigit(`27${PAN}1Z`)}`,
  reraNo: "A51700001835",
  reraTill: days(300),
  principalName: "Sagar Kale",
  principalPhone: "98765 43210",
  ...over,
});
const audits = async (orgId: string) =>
  sql<{ action: string; target_id: string | null; metadata: Record<string, unknown> }[]>`
    SELECT action, target_id, metadata FROM audit_log WHERE org_id = ${orgId} ORDER BY created_at`;

try {
  console.log("\nEmpanelment: one firm, one org, two desks");
  const bad = readFirm({ name: "", pan: "NOTAPAN", gstin: "27ABCDE1234F1Z5" });
  check("a firm with no name and a bad PAN is refused by field", !bad.ok && !!bad.errors.name && !!bad.errors.pan);
  const read = readFirm(firmForm());
  check("a firm's details are read and normalised", read.ok && read.firm.principalPhone === "+919876543210");
  if (!read.ok) throw new Error("firm did not read");
  const e1 = await empanelFirm({ orgId: A.orgId, userId: A.rm, firm: read.firm, rmId: A.rm, projectIds: [A.project.id], validTo: days(365) });
  check("tenant A empanels the firm on Sath Heights", e1.ok, e1.ok ? "" : e1.message);
  const firmA = e1.ok ? e1.firmId : "";
  const again = await empanelFirm({ orgId: A.orgId, userId: A.rm, firm: read.firm, rmId: null, projectIds: [A.project.id], validTo: days(365) });
  check("the same PAN twice on one desk is refused", !again.ok);
  const wrongNode = await empanelFirm({ orgId: B.orgId, userId: B.rm, firm: read.firm, rmId: null, projectIds: [A.project.id], validTo: days(365) });
  check("a project id from another tenant is refused", !wrongNode.ok);
  const e2 = await empanelFirm({ orgId: B.orgId, userId: B.rm, firm: read.firm, rmId: B.rm, projectIds: [B.project.id], validTo: days(365) });
  check("tenant B empanels the same firm", e2.ok, e2.ok ? "" : e2.message);
  const cpOrgs = await sql<{ id: string; type: string; status: string; gstin: string | null }[]>`
    SELECT id, type, status, gstin FROM orgs WHERE pan = ${PAN}`;
  check("one firm is one org, whoever empanels it", cpOrgs.length === 1 && cpOrgs[0].type === "CHANNEL_PARTNER");
  check("created unverified and holding no GSTIN, so it cannot squat a signup", cpOrgs[0]?.status === "PENDING_VERIFICATION" && cpOrgs[0]?.gstin === null);
  const CP = cpOrgs[0].id;
  made.orgs.push(CP);
  const firms = await sql<{ org_id: string }[]>`SELECT org_id FROM partner_firms WHERE cp_org_id = ${CP}`;
  check("each tenant keeps its own record of the firm", firms.length === 2 && new Set(firms.map((f) => f.org_id)).size === 2);
  const [termsRow] = await sql`SELECT steps FROM commission_terms WHERE org_id = ${A.orgId} AND scope_node_id = ${A.project.id}`;
  check("the project's terms are written with the trade's ladder", JSON.stringify(termsRow.steps) === JSON.stringify(DEFAULT_TERMS.steps));

  const r2 = readFirm(firmForm({ name: "Urban Nest Realtors", legalName: "Urban Nest Realtors", pan: `AAAFU${PAN.slice(5)}`, gstin: "", reraNo: "A51800000002" }));
  if (!r2.ok) throw new Error("second firm did not read");
  const e3 = await empanelFirm({ orgId: A.orgId, userId: A.rm, firm: r2.firm, rmId: null, projectIds: [A.project.id, A.other.id], validTo: days(365) });
  check("a second firm on two projects", e3.ok);
  const firmU = e3.ok ? e3.firmId : "";
  const [cpU] = await sql<{ cp_org_id: string }[]>`SELECT cp_org_id FROM partner_firms WHERE id = ${firmU}`;
  made.orgs.push(cpU.cp_org_id);

  console.log("\nRegistration: every verdict, logged");
  const reg = (firmId: string, phone: string, over: Partial<Parameters<typeof registerBuyer>[0]> = {}) =>
    registerBuyer({ orgId: A.orgId, userId: A.rm, firmId, projectId: A.project.id, phone, via: "CONSOLE", nowIso: NOW, ...over });
  const first = await reg(firmA, "98123 45621", { buyerName: "Pooja Nair", agentName: "Sagar Kale" });
  check("a clear number is registered", first.ok && first.verdict === "REGISTERED", first.ok ? first.message : first.message);
  check("and the answer echoes the number masked", first.ok && first.message.includes("98XXXXXX21") && !first.message.includes("9812345621"));
  check("with the project's thirty days", first.ok && first.message.endsWith("30 days."));
  const mine = await reg(firmA, "+919812345621");
  check("the same firm again is told it already holds the buyer", mine.ok && mine.verdict === "ALREADY");
  const blocked = await reg(firmU, "9812345621");
  check("another firm is blocked", blocked.ok && blocked.verdict === "BLOCKED");
  check("and told the date, never the firm", blocked.ok && !blocked.message.includes("Keystone") && /until \d+ \w+ \d{4}/.test(blocked.message));
  const otherProject = await registerBuyer({ orgId: A.orgId, userId: A.rm, firmId: firmU, projectId: A.other.id, phone: "9812345621", via: "CONSOLE", nowIso: NOW });
  check("a claim at one project does not hold the buyer at another", otherProject.ok && otherProject.verdict === "REGISTERED");
  const notHere = await registerBuyer({ orgId: A.orgId, userId: A.rm, firmId: firmA, projectId: A.other.id, phone: "9800000301", via: "CONSOLE", nowIso: NOW });
  check("a firm not empanelled on a project is refused there", notHere.ok && notHere.verdict === "NO_GRANT" && notHere.message === "Not empanelled on Riverside Greens.");
  await sql`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, enquired_at)
    VALUES (${A.orgId}, ${A.towerC.id}, 'Walk In', '+919800000302', 'Website', now() - interval '3 days')`;
  const direct = await reg(firmA, "9800000302");
  check("a buyer who enquired directly first is refused", direct.ok && direct.verdict === "DIRECT_FIRST");
  const badPhone = await reg(firmA, "12345");
  check("a number that is not one is refused before any verdict", !badPhone.ok);

  const grantA = (await sql<{ id: string }[]>`SELECT id FROM grants WHERE org_id = ${A.orgId} AND grantee_org_id = ${CP}`)[0].id;
  const held = await changeGrant({ orgId: A.orgId, userId: A.rm, grantId: grantA, action: { kind: "suspend", reason: "Documents pending" } });
  check("a grant is put on hold with a reason", held.ok);
  const onHold = await reg(firmA, "9800000303");
  check("a firm on hold is refused", onHold.ok && onHold.verdict === "NO_GRANT" && onHold.message.includes("on hold"));
  check("a hold with no reason is refused", !(await changeGrant({ orgId: A.orgId, userId: A.rm, grantId: grantA, action: { kind: "suspend", reason: " " } })).ok);
  await changeGrant({ orgId: A.orgId, userId: A.rm, grantId: grantA, action: { kind: "restore" } });
  check("restored, it registers again", (await reg(firmA, "9800000303")).ok);

  await sql`UPDATE partner_firms SET rera_valid_till = ${days(-2)} WHERE id = ${firmA}`;
  const lapsedAgent = await reg(firmA, "9800000304");
  check("a lapsed MahaRERA agent registration refuses", lapsedAgent.ok && lapsedAgent.verdict === "AGENT_RERA");
  await sql`UPDATE partner_firms SET rera_valid_till = ${days(300)} WHERE id = ${firmA}`;

  await saveSettings({ orgId: A.orgId, userId: A.admin, settings: { dialPolicy: "AFTER_VISIT", dailyRegistrations: 7 } });
  const capped = await reg(firmA, "9800000305");
  check("the day's allowance, once used, refuses", capped.ok && capped.verdict === "RATE_LIMITED", capped.ok ? capped.verdict : "");
  await saveSettings({ orgId: A.orgId, userId: A.admin, settings: { dialPolicy: "AFTER_VISIT", dailyRegistrations: 50 } });

  const logged = await sql<{ verdict: string }[]>`SELECT verdict FROM client_registrations WHERE org_id = ${A.orgId}`;
  check("every attempt is a row, refusals included", new Set(logged.map((l) => l.verdict)).size >= 6, [...new Set(logged.map((l) => l.verdict))].join(","));
  const regAudits = (await audits(A.orgId)).filter((a) => a.action === "partner.registration");
  check("every verdict is audited", regAudits.length === logged.length);
  check("and no audit row carries a phone number",
    (await audits(A.orgId)).every((a) => !/9812345621|98123/.test(JSON.stringify(a))));

  console.log("\nR2: a buyer who enquires later lands on the partner's claim");
  const ev = await recordEvent({
    orgId: A.orgId,
    source: "WEBSITE",
    externalId: `cp-${tag}`,
    payload: { lead_id: `cp-${tag}`, phase: A.towerC.id, name: "Pooja Nair", phone: "9812345621", consent: "on" },
  });
  const noon = istAt(days(1), "12:00");
  const captured = await processEvent(A.orgId, ev.id, { nowIso: noon });
  check("the enquiry becomes a lead", captured.ok);
  const leadId = captured.ok ? captured.leadId : "";
  const [tagged] = await sql<{ lead_id: string | null }[]>`
    SELECT lead_id FROM client_registrations WHERE org_id = ${A.orgId} AND verdict = 'REGISTERED' AND phone = '+919812345621' AND scope_node_id = ${A.project.id}`;
  check("the partner's claim now names the lead", tagged?.lead_id === leadId);
  const [l] = await sql<{ owner_id: string | null; needs_person: string | null }[]>`SELECT owner_id, needs_person FROM leads WHERE id = ${leadId}`;
  check("the lead goes to the person who looks after the firm", l?.owner_id === A.rm);
  check("and says whose buyer it is", l?.needs_person === "Partner's buyer: Keystone Realty");
  const cap = (await audits(A.orgId)).find((a) => a.action === "lead.captured" && a.target_id === leadId);
  check("the rule that fired goes to the audit log", cap?.metadata.ownership === "R2");
  check("the AI does not call a partner's buyer before the visit", !dialled.includes("+919812345621"));
  const byHand = await placeCall({ orgId: A.orgId, userId: A.admin, leadId, nowIso: noon });
  check("and neither does a person", !byHand.ok && byHand.code === "PARTNER_BUYER");
  await saveSettings({ orgId: A.orgId, userId: A.admin, settings: { dialPolicy: "LOGGED", dailyRegistrations: 50 } });
  const allowed = await placeCall({ orgId: A.orgId, userId: A.admin, leadId, nowIso: noon });
  check("unless the tenant allows it, and then the call goes out", allowed.ok, allowed.ok ? "" : allowed.message);
  await saveSettings({ orgId: A.orgId, userId: A.admin, settings: { dialPolicy: "AFTER_VISIT", dailyRegistrations: 50 } });

  console.log("\nThe partner's visit carries the claim forward");
  const walk = await reg(firmA, "9800000306", { buyerName: "Rohan Joshi" });
  const walkId = walk.ok ? walk.id : "";
  const past = await bookPartnerVisit({ orgId: A.orgId, userId: A.rm, registrationId: walkId, phaseId: A.towerC.id, date: days(-1), time: "11:00" });
  check("a visit in the past is refused", !past.ok);
  const wrongTower = await bookPartnerVisit({ orgId: A.orgId, userId: A.rm, registrationId: walkId, phaseId: B.towerC.id, date: days(2), time: "11:00" });
  check("a tower outside the claim's project is refused", !wrongTower.ok);
  const booked = await bookPartnerVisit({ orgId: A.orgId, userId: A.rm, registrationId: walkId, phaseId: A.towerC.id, date: days(2), time: "11:00" });
  check("the relationship manager books the partner's buyer onto the site", booked.ok, booked.message);
  const [vl] = await sql<{ id: string; stage: string; source: string }[]>`SELECT id, stage, source FROM leads WHERE id = ${booked.leadId ?? null}`;
  check("a lead is made for the claim, at the tower", vl?.stage === "visit_scheduled" && vl?.source === "Channel partner");
  const [visit] = await sql<{ id: string }[]>`SELECT id FROM site_visits WHERE lead_id = ${vl.id}`;
  const [beforeVisit] = await sql<{ valid_until: Date }[]>`SELECT valid_until FROM client_registrations WHERE id = ${walkId}`;
  await sql`UPDATE site_visits SET scheduled_at = now() WHERE id = ${visit.id}`;
  const checkedIn = await onVisitAction({ orgId: A.orgId, userId: A.admin, visitId: visit.id, action: "CHECK_IN" });
  check("the site team checks the buyer in", checkedIn.ok);
  const [afterVisit] = await sql<{ valid_until: Date; extended_by_visit: string | null }[]>`
    SELECT valid_until, extended_by_visit FROM client_registrations WHERE id = ${walkId}`;
  check("the check-in carries the claim thirty days past the visit",
    afterVisit.extended_by_visit === visit.id && afterVisit.valid_until.getTime() >= Date.now() + 29.9 * 86_400_000 && afterVisit.valid_until >= beforeVisit.valid_until);

  console.log("\nA booking writes the payout on the project's ladder");
  const book = async (id: string, agreement: number, unit: string) => {
    await sql`
      UPDATE leads SET stage = 'booked', path_stage = 'booked',
        facts = ${sql.json({ unit, agreement: String(agreement), bookedOn: today, token: "100000" })}
      WHERE id = ${id}`;
    return onBooked({ orgId: A.orgId, userId: A.admin, leadId: id });
  };
  const p1 = await book(leadId, 1_25_00_000, "C-803");
  check("the first booking owes the firm", !!p1);
  const [pay1] = await sql<{ rate: string; booking_no: number; gst_registered: boolean }[]>`SELECT rate, booking_no, gst_registered FROM partner_payouts WHERE id = ${p1?.payoutId ?? null}`;
  check("at 2%, as its first booking, with GST", Number(pay1.rate) === 0.02 && pay1.booking_no === 1 && pay1.gst_registered);
  const halves = await sql<{ key: string; base: string; gst: string; tds: string; net: string }[]>`
    SELECT key, base, gst, tds, net FROM payout_milestones WHERE payout_id = ${p1!.payoutId} ORDER BY key`;
  check("two halves of Rs 1,25,000 with GST on top and TDS withheld",
    halves.map((h) => [h.key, Number(h.base), Number(h.gst), Number(h.tds), Number(h.net)]).join("|") ===
      "M1,125000,22500,2500,145000|M2,125000,22500,2500,145000");
  check("a second call writes nothing more", (await onBooked({ orgId: A.orgId, userId: A.admin, leadId }))?.payoutId === p1!.payoutId);
  const [st] = await sql<{ status: string }[]>`SELECT status FROM client_registrations WHERE lead_id = ${leadId} AND verdict = 'REGISTERED'`;
  check("the claim is marked booked", st?.status === "BOOKED");
  const again2 = await reg(firmU, "9812345621");
  check("a booked buyer is held for the booking firm", again2.ok && again2.verdict === "BLOCKED" && !again2.message.includes("until"));
  const p2 = await book(vl.id, 90_00_000, "C-1204");
  const [pay2] = await sql<{ rate: string; booking_no: number }[]>`SELECT rate, booking_no FROM partner_payouts WHERE id = ${p2?.payoutId ?? null}`;
  check("the firm's second booking on the project steps up to 2.25%", Number(pay2?.rate) === 0.0225 && pay2?.booking_no === 2);

  // The bank's first payment on the buyer's loan, and the second half.
  const [p2row] = await sql<{ lead_id: string; scope_node_id: string }[]>`SELECT lead_id, scope_node_id FROM partner_payouts WHERE id = ${p2!.payoutId}`;
  check("on the usual terms the bank's payment owes nothing", (await bankPaidForLead({ orgId: A.orgId, leadId: p2row.lead_id, on: today })) === 0);
  await sql`UPDATE commission_terms SET second_half = 'COLLECTED_OR_BANK' WHERE org_id = ${A.orgId} AND scope_node_id = ${p2row.scope_node_id} AND mandate_id IS NULL`;
  check("where the terms say so, the bank's first payment makes the second half owed",
    (await bankPaidForLead({ orgId: A.orgId, leadId: p2row.lead_id, on: today })) === 1
    && (await sql<{ c: string | null }[]>`SELECT collected_on::text AS c FROM partner_payouts WHERE id = ${p2!.payoutId}`)[0].c === today);
  check("and a second payment changes nothing", (await bankPaidForLead({ orgId: A.orgId, leadId: p2row.lead_id, on: today })) === 0);
  await sql`UPDATE commission_terms SET second_half = 'COLLECTED' WHERE org_id = ${A.orgId} AND scope_node_id = ${p2row.scope_node_id} AND mandate_id IS NULL`;

  console.log("\nThe payout, from invoice to UTR");
  const m1 = (await sql<{ id: string }[]>`SELECT id FROM payout_milestones WHERE payout_id = ${p1!.payoutId} AND key = 'M1'`)[0].id;
  const pdf = Buffer.from("%PDF-1.4 invoice");
  const early = await fileInvoice({ orgId: A.orgId, userId: A.rm, milestoneId: m1, invoiceNo: "KR/1", invoiceDate: today, amount: 147500, bytes: pdf, mediaType: "application/pdf", today });
  check("an invoice for a half not yet owed is refused", !early.ok);
  const pb = await setPassBack({ orgId: A.orgId, userId: A.admin, payoutId: p1!.payoutId, passBack: 0.005 });
  check("a pass-back corrected before any invoice works both halves out again", pb.ok);
  const [afterPb] = await sql<{ base: string }[]>`SELECT base FROM payout_milestones WHERE id = ${m1}`;
  check("1.5% of Rs 1.25 Cr, halved", Number(afterPb.base) === 93750);
  check("a pass-back over the cap is refused", !(await setPassBack({ orgId: A.orgId, userId: A.admin, payoutId: p1!.payoutId, passBack: 0.015 })).ok);
  check("a date in the future is refused",
    !(await recordBookingDates({ orgId: A.orgId, userId: A.admin, payoutId: p1!.payoutId, agreementRegisteredOn: days(3), collectedOn: null, today })).ok);
  const dated = await recordBookingDates({ orgId: A.orgId, userId: A.admin, payoutId: p1!.payoutId, agreementRegisteredOn: today, collectedOn: null, today });
  check("the agreement's registration makes the first half owed", dated.ok);
  const wrongAmount = await fileInvoice({ orgId: A.orgId, userId: A.rm, milestoneId: m1, invoiceNo: "KR/1", invoiceDate: today, amount: 147500, bytes: pdf, mediaType: "application/pdf", today });
  check("the firm's invoice is filed", wrongAmount.ok && wrongAmount.message.includes("is owed"));
  check("into the file store under the tenant's prefix", [...stored.keys()].some((k) => k.startsWith(`org/${A.orgId}/`) && k.includes("/invoice/")));
  check("a second invoice on the same half is refused",
    !(await fileInvoice({ orgId: A.orgId, userId: A.rm, milestoneId: m1, invoiceNo: "KR/2", invoiceDate: today, amount: 1, bytes: pdf, mediaType: "application/pdf", today })).ok);
  check("a script is not an invoice",
    !(await fileInvoice({ orgId: A.orgId, userId: A.rm, milestoneId: m1, invoiceNo: "KR/2", invoiceDate: today, amount: 1, bytes: pdf, mediaType: "image/svg+xml", today })).ok);
  const mismatch = await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1, move: { kind: "verify" }, today });
  check("an invoice for the wrong amount cannot be verified", !mismatch.ok && mismatch.message.includes("Rs 1,10,625"));
  check("it is rejected", (await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1, move: { kind: "reject" }, today })).ok);
  const refile = await fileInvoice({ orgId: A.orgId, userId: A.rm, milestoneId: m1, invoiceNo: "KR/1A", invoiceDate: today, amount: 110625, bytes: pdf, mediaType: "application/pdf", today });
  check("and the corrected one filed", refile.ok && refile.message === "Invoice filed.");
  check("the pass-back is fixed once a half is invoiced", !(await setPassBack({ orgId: A.orgId, userId: A.admin, payoutId: p1!.payoutId, passBack: 0 })).ok);
  check("approving before verifying is refused", !(await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1, move: { kind: "approve" }, today })).ok);
  check("verified", (await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1, move: { kind: "verify" }, today })).ok);
  check("approved", (await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1, move: { kind: "approve" }, today })).ok);
  check("a UTR that is not one is refused",
    !(await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1, move: { kind: "pay", utr: "12", paidOn: today }, today })).ok);
  check("paid, with the bank's UTR",
    (await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1, move: { kind: "pay", utr: "hdfcn 2609 2800417", paidOn: today }, today })).ok);
  check("paid twice is refused",
    !(await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1, move: { kind: "pay", utr: "HDFCN26092800418", paidOn: today }, today })).ok);
  const [paid] = await sql<{ stage: string; utr: string }[]>`SELECT stage, utr FROM payout_milestones WHERE id = ${m1}`;
  check("the milestone reads paid with the UTR as the bank prints it", paid.stage === "PAID" && paid.utr === "HDFCN26092800417");

  console.log("\nA cancelled booking hands the claim back");
  await sql`UPDATE leads SET stage = 'negotiation', path_stage = 'negotiation' WHERE id = ${vl.id}`;
  check("leaving Booked cancels the payout", await onUnbooked({ orgId: A.orgId, userId: A.admin, leadId: vl.id }));
  const [back] = await sql<{ status: string }[]>`SELECT status FROM client_registrations WHERE id = ${walkId}`;
  check("and the claim is live again", back.status === "ACTIVE");

  console.log("\nThe sweep releases a claim whose day has passed");
  const lapse = await reg(firmA, "9800000307");
  await sql`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source) VALUES (${A.orgId}, ${A.towerC.id}, 'Late Buyer', '+919800000307', 'Channel partner')`;
  const [late] = await sql<{ id: string }[]>`SELECT id FROM leads WHERE org_id = ${A.orgId} AND phone = '+919800000307'`;
  await sql`ALTER TABLE client_registrations DISABLE TRIGGER client_registrations_forward_only`;
  await sql`UPDATE client_registrations SET valid_until = now() - interval '1 minute', lead_id = ${late.id} WHERE id = ${lapse.ok ? lapse.id : null}`;
  await sql`ALTER TABLE client_registrations ENABLE TRIGGER client_registrations_forward_only`;
  const released = await sweepRegistrations(A.orgId);
  check("the lapsed claim is released", released >= 1);
  const [freed] = await sql<{ needs_person: string | null }[]>`SELECT needs_person FROM leads WHERE id = ${late.id}`;
  check("and its lead is told the buyer is direct now", !!freed.needs_person?.startsWith("Partner registration lapsed"));
  check("another firm is then told the buyer came direct", (await reg(firmU, "9800000307")).ok);

  console.log("\nA partner's link: the lead and the claim in one");
  const noAgent = await makeLink({ orgId: A.orgId, userId: A.rm, firmId: firmU, phaseId: A.towerC.id, agentName: null });
  await sql`UPDATE partner_firms SET rera_valid_till = ${days(-1)} WHERE id = ${firmU}`;
  const lapsedLink = await makeLink({ orgId: A.orgId, userId: A.rm, firmId: firmU, phaseId: A.towerC.id, agentName: null });
  check("no link for a firm whose agent registration lapsed", noAgent.ok && !lapsedLink.ok);
  await sql`UPDATE partner_firms SET rera_valid_till = ${days(300)} WHERE id = ${firmU}`;
  const link = await makeLink({ orgId: A.orgId, userId: A.rm, firmId: firmA, phaseId: A.towerC.id, agentName: "Sagar Kale" });
  check("a link is made with a code naming the project and the firm", link.ok && /^SH-KER-\d{4}$/.test(link.code), link.ok ? link.code : link.message);
  check("no link on another tenant's tower",
    !(await makeLink({ orgId: A.orgId, userId: A.rm, firmId: firmA, phaseId: B.towerC.id, agentName: null })).ok);
  const code = link.ok ? link.code : "";
  const dialsBefore = dialled.length;
  const tap = await recordEvent({
    orgId: A.orgId,
    source: "WEBSITE",
    externalId: `cp-link-${tag}`,
    payload: { lead_id: `cp-link-${tag}`, phase: A.towerC.id, name: "Kavya Iyer", phone: "9800000401", cp: code.toLowerCase() },
  });
  const tapped = await processEvent(A.orgId, tap.id, { nowIso: noon });
  check("a buyer tapping the link becomes a lead", tapped.ok);
  const tappedId = tapped.ok ? tapped.leadId : "";
  const [claim] = await sql<{ verdict: string; via: string; lead_id: string | null; ref_code: string | null }[]>`
    SELECT verdict, via, lead_id, ref_code FROM client_registrations WHERE org_id = ${A.orgId} AND phone = '+919800000401'`;
  check("and the firm's claim, made with it", claim?.verdict === "REGISTERED" && claim.via === "LINK" && claim.lead_id === tappedId && claim.ref_code === code);
  const [tl] = await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM leads WHERE id = ${tappedId}`;
  check("the lead goes to the firm's relationship manager", tl?.owner_id === A.rm);
  check("and nobody here calls the buyer before the visit", dialled.length === dialsBefore);
  const other = await makeLink({ orgId: A.orgId, userId: A.rm, firmId: firmU, phaseId: A.towerC.id, agentName: null });
  const second = await recordEvent({
    orgId: A.orgId,
    source: "WEBSITE",
    externalId: `cp-link2-${tag}`,
    payload: { lead_id: `cp-link2-${tag}`, phase: A.towerC.id, name: "Kavya Iyer", phone: "9800000401", cp: other.ok ? other.code : "" },
  });
  await processEvent(A.orgId, second.id, { nowIso: noon });
  const both = await sql<{ verdict: string; cp_org_id: string }[]>`
    SELECT verdict, cp_org_id FROM client_registrations WHERE org_id = ${A.orgId} AND phone = '+919800000401' ORDER BY created_at`;
  check("another firm's link on the same buyer is blocked, not a second claim", both.length === 2 && both[1].verdict === "BLOCKED");
  if (link.ok) await retireLink({ orgId: A.orgId, userId: A.rm, linkId: link.id });
  const retiredTap = await recordEvent({
    orgId: A.orgId,
    source: "WEBSITE",
    externalId: `cp-link3-${tag}`,
    payload: { lead_id: `cp-link3-${tag}`, phase: A.towerC.id, name: "Late Tap", phone: "9800000402", cp: code },
  });
  await processEvent(A.orgId, retiredTap.id, { nowIso: noon });
  const [none] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM client_registrations WHERE org_id = ${A.orgId} AND phone = '+919800000402'`;
  check("a retired link still lands the buyer, and claims nobody", none.n === 0);

  console.log("\nThe co-branded copy");
  const square = await sharp({ create: { width: 400, height: 400, channels: 3, background: "#3366aa" } }).jpeg().toBuffer();
  const stamped = await stampPartner(square, { firm: "Keystone Realty", agentNo: "A51700001835", code: "SH-KR-4417" });
  const m = await sharp(stamped).metadata();
  check("the partner's band is added beneath the post, never over it", m.width === 400 && (m.height ?? 0) > 400 && m.format === "jpeg");
  const [corner] = await sharp(stamped).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer().then((b) => [b[2]]);
  check("and the post's own pixels are untouched", corner > 150);
  const missing = await partnerPost({ orgId: A.orgId, userId: A.rm, linkId: other.ok ? other.id : "", postId: crypto.randomUUID(), index: 0 });
  check("no copy of a post that is not here", !missing.ok);
  const retiredCopy = await partnerPost({ orgId: A.orgId, userId: A.rm, linkId: link.ok ? link.id : "", postId: crypto.randomUUID(), index: 0 });
  check("and none through a retired link", !retiredCopy.ok && retiredCopy.message === "This link is retired.");

  console.log("\nReports cost a partner booking in commission");
  const report = await realReport(A.orgId, today);
  const cpRows = report?.rows.filter((r) => r.source === "cp") ?? [];
  check("the partner's booking is on the partner's row, at its commission",
    cpRows.reduce((t, r) => t + r.counts.commission, 0) === 187500, String(cpRows.reduce((t, r) => t + r.counts.commission, 0)));
  check("and no partner row carries media spend", cpRows.every((r) => !r.counts.spend));

  console.log("\nTerms and the desk");
  check("terms outside the rules are refused",
    !(await saveTerms({ orgId: A.orgId, userId: A.admin, projectId: A.project.id, terms: { ...DEFAULT_TERMS, registrationDays: 120 } })).ok);
  check("a project's own ladder saves",
    (await saveTerms({ orgId: A.orgId, userId: A.admin, projectId: A.project.id, terms: { ...DEFAULT_TERMS, steps: [{ from: 1, rate: 0.025 }] } })).ok);
  check("terms on another tenant's project are refused",
    !(await saveTerms({ orgId: A.orgId, userId: A.admin, projectId: B.project.id, terms: DEFAULT_TERMS })).ok);
  const desk = await loadDesk({ orgId: A.orgId, partnerScopes: [A.root.path], payoutScopes: [A.root.path] });
  check("the desk reads real rows", desk.real && desk.firms.length === 2);
  check("with each firm's ladder position", desk.firms.find((f) => f.name === "Keystone Realty")?.projects[0]?.booked === 1);
  check("and the payouts", desk.bookings.length === 2 && desk.bookings.some((b) => b.cancelled));
  const blockedRow = desk.registrations.find((r) => r.refused?.reason === "firm");
  check("the desk names who holds a blocked buyer, which the partner is never told", blockedRow?.refused?.holderFirm === "Keystone Realty");
  const payoutOnly = await loadDesk({ orgId: A.orgId, partnerScopes: [], payoutScopes: [A.root.path] });
  check("a payout approver reads no registrations", payoutOnly.registrations.length === 0 && payoutOnly.bookings.length === 2);
  const partnerOnly = await loadDesk({ orgId: A.orgId, partnerScopes: [A.root.path], payoutScopes: [] });
  check("and a relationship manager without payout:read reads no money", partnerOnly.bookings.length === 0);
  const deskB = await loadDesk({ orgId: B.orgId, partnerScopes: [B.root.path], payoutScopes: [B.root.path] });
  check("tenant B's desk holds the firm and none of A's buyers", deskB.firms.length === 1 && deskB.registrations.length === 0);

  // -------------------------------------------------------------------------
  console.log("\nThe partner's WhatsApp: proving the number once");
  type Sent = { kind: "text" | "template" | "media"; to: string; body: string; template?: string; mediaType?: string; bytes?: Buffer };
  const sent: Sent[] = [];
  let wamid = 0;
  const wa = useWhatsApp({
    async sendTemplate(_c, m) {
      sent.push({ kind: "template", to: m.to, body: m.params.join(" | "), template: m.template });
      return { id: `wamid.out.${tag}.${++wamid}` };
    },
    async sendText(_c, m) {
      sent.push({ kind: "text", to: m.to, body: m.body });
      return { id: `wamid.out.${tag}.${++wamid}` };
    },
    async sendMedia(_c, m) {
      sent.push({ kind: "media", to: m.to, body: m.caption ?? m.filename ?? "", mediaType: m.mediaType, bytes: m.bytes });
      return { id: `wamid.out.${tag}.${++wamid}` };
    },
  });
  const codes: { to: string; code: string }[] = [];
  const codeSender = useCodeSender({ async send(to, c) { codes.push({ to, code: c }); } });
  // The model is scripted: it answers by the words, and records what it was shown.
  const modelSaw: string[] = [];
  const script: [RegExp, Record<string, unknown>][] = [
    [/kya hai/, { action: "inventory", config: "3bhk", tower: "tower C" }],
    [/book sv kal 5pm/i, { action: "book_visit", buyer: "#1", when: "kal 5pm" }],
    [/book sv/i, { action: "book_visit", buyer: "#1", when: "kal 4pm" }],
    [/pura number/, { action: "unmask", buyer: "Priya" }],
    [/creative/, { action: "creative", occasion: "Diwali" }],
    [/bank/, { action: "not_here", what: "payout_account" }],
  ];
  const model = usePartnerModel(async (req) => {
    const t = (req.parts[0] as { text: string }).text;
    modelSaw.push(t);
    const hit = script.find(([re]) => re.test(t));
    const empty = { buyer: null, name: null, config: null, tower: null, project: null, when: null, occasion: null, what: null };
    return { ok: true, value: { ...empty, ...(hit ? hit[1] : { action: "unclear" }) } };
  });
  const [numA] = await sql<{ phone_number_id: string; display_phone: string }[]>`
    SELECT phone_number_id, display_phone FROM whatsapp_numbers WHERE org_id = ${A.orgId}`;
  let inbound = 0;
  const say = async (from: string, text: string, name = "Someone") => {
    const digits = from.replace(/\D/g, "");
    await ingestWhatsApp({
      object: "whatsapp_business_account",
      entry: [{
        id: "1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: numA.phone_number_id },
            contacts: [{ wa_id: digits, profile: { name } }],
            messages: [{ id: `wamid.in.${tag}.${++inbound}`, from: digits, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
          },
        }],
      }],
    });
  };
  const to = (phone: string) => sent.filter((m) => m.to === phone);
  const lastTo = (phone: string) => to(phone).at(-1)?.body ?? "";
  const RAHUL = "+919811100001";

  const agentsA = await sql<{ phone: string; status: string; is_principal: boolean }[]>`
    SELECT phone, status, is_principal FROM partner_agents WHERE org_id = ${A.orgId} AND firm_id = ${firmA}`;
  check("the firm's principal is on its WhatsApp list from empanelment", agentsA.some((a) => a.phone === "+919876543210" && a.is_principal && a.status === "WAITING"));
  check("a person is added to the firm's list", (await addAgent({ orgId: A.orgId, userId: A.rm, firmId: firmA, name: "Rahul Mehta", phone: "98111 00001" })).ok);
  check("one number speaks for one firm here",
    (await addAgent({ orgId: A.orgId, userId: A.rm, firmId: firmU, name: "Rahul Mehta", phone: "9811100001" })).message === "That number already speaks for another firm here.");
  check("a number that is not one is refused", !(await addAgent({ orgId: A.orgId, userId: A.rm, firmId: firmA, name: "X", phone: "123" })).ok);

  await say("+919811199999", "hi");
  check("somebody not on any list gets nothing from the bot", to("+919811199999").length === 0);
  await say(RAHUL, "register 9812300001 Priya Shah", "Rahul");
  check("the first message sends a code from Sales Desk's number", codes.filter((c) => c.to === RAHUL).length === 1);
  check("and the bot asks for it on the developer's number", /6 digit code/.test(lastTo(RAHUL)));
  await say(RAHUL, "hello?", "Rahul");
  check("asking again sends no second code", codes.filter((c) => c.to === RAHUL).length === 1 && /code yahan bhejiye/.test(lastTo(RAHUL)));
  const bindCode = codes.filter((c) => c.to === RAHUL).at(-1)!.code;
  await say(RAHUL, String((Number(bindCode) + 1) % 1_000_000).padStart(6, "0"), "Rahul");
  check("a wrong code is refused", /sahi nahi/.test(lastTo(RAHUL)));
  await say(RAHUL, bindCode, "Rahul");
  check("the right code binds the number", /Ho gaya, Rahul/.test(lastTo(RAHUL)));
  const [rahul] = await sql<{ id: string; status: string; user_id: string | null }[]>`
    SELECT id, status, user_id FROM partner_agents WHERE org_id = ${A.orgId} AND phone = ${RAHUL}`;
  const [ru] = await sql<{ email: string | null; phone: string | null; phone_verified_at: Date | null }[]>`
    SELECT email, phone, phone_verified_at FROM users WHERE id = ${rahul.user_id}`;
  check("a user known only by the phone they proved", rahul.status === "ACTIVE" && ru?.email === null && ru?.phone === RAHUL && !!ru?.phone_verified_at);
  const [mem] = await sql<{ role: string; status: string }[]>`SELECT role, status FROM memberships WHERE user_id = ${rahul.user_id} AND org_id = ${CP}`;
  check("with a membership in the firm's own org, and none with the developer",
    mem?.role === "CP_AGENT" && mem.status === "ACTIVE" &&
      (await sql`SELECT 1 FROM memberships WHERE user_id = ${rahul.user_id} AND org_id = ${A.orgId}`).length === 0);

  console.log("\nThe partner's WhatsApp: registering and booking");
  await say(RAHUL, "register 98123 00001 Priya Shah", "Rahul");
  check("a buyer registered on WhatsApp gets the verdict, masked", /^Registered: 98XXXXXX01, Sath Heights\. 30 din valid/.test(lastTo(RAHUL)), lastTo(RAHUL));
  const [viaBot] = await sql<{ via: string; agent_id: string | null; agent_name: string | null }[]>`
    SELECT via, agent_id, agent_name FROM client_registrations WHERE org_id = ${A.orgId} AND phone = '+919812300001' AND verdict = 'REGISTERED'`;
  check("the claim names the person who made it", viaBot?.via === "WHATSAPP" && viaBot.agent_id === rahul.id && viaBot.agent_name === "Rahul Mehta");
  await registerBuyer({ orgId: A.orgId, userId: A.rm, firmId: firmU, projectId: A.project.id, phone: "9800000501", via: "CONSOLE", nowIso: NOW });
  await say(RAHUL, "reg 9800000501", "Rahul");
  check("another firm's buyer is refused with a date and no name",
    /kisi aur partner ke paas registered hai/.test(lastTo(RAHUL)) && !/Urban Nest/.test(lastTo(RAHUL)));
  const [inRow] = await sql<{ body: string; partner_agent_id: string | null }[]>`
    SELECT body, partner_agent_id FROM messages WHERE org_id = ${A.orgId} AND direction = 'IN' AND phone = ${RAHUL} ORDER BY created_at DESC LIMIT 1`;
  check("what the partner wrote is kept with the buyer's number masked", inRow?.partner_agent_id === rahul.id && !/9800000501/.test(inRow.body));

  await say(RAHUL, "3bhk tower C mein kya hai", "Rahul");
  check("a question in Hinglish goes to the model", modelSaw.some((t) => t.includes("3bhk tower C")));
  check("stock comes only from approved configurations", /koi approved price abhi nahi hai/.test(lastTo(RAHUL)), lastTo(RAHUL));
  await say(RAHUL, "book SV kal 4pm 9812300001", "Rahul");
  check("the model never sees a phone number", modelSaw.some((t) => t.includes("#1")) && modelSaw.every((t) => !/\d{10}/.test(t.replace(/\s/g, ""))));
  check("the slot is held while the partner says yes", /Priya Shah \(98XXXXXX01\) ki site visit: Tower C, .*4:00 pm\. Confirm karne ke liye 90 second/.test(lastTo(RAHUL)), lastTo(RAHUL));
  // The hold is moved back on its own clock: the bot writes and reads it on
  // the app's clock, and the database's now() runs a couple of seconds ahead
  // of this machine's, so "now() less a second" was still in the future here.
  await sql`UPDATE partner_bot_pending SET created_at = created_at - interval '5 minutes', expires_at = expires_at - interval '5 minutes' WHERE agent_id = ${rahul.id} AND done_at IS NULL`;
  await say(RAHUL, "haan", "Rahul");
  check("a yes after 90 seconds books nothing", /confirm nahi hua/.test(lastTo(RAHUL)) &&
    (await sql`SELECT 1 FROM leads WHERE org_id = ${A.orgId} AND phone = '+919812300001'`).length === 0);
  await say(RAHUL, "book SV kal 4pm 9812300001", "Rahul");
  await say(RAHUL, "haan", "Rahul");
  check("a yes in time books the visit", /^Visit book ho gayi: Tower C/.test(lastTo(RAHUL)), lastTo(RAHUL));
  const [priya] = await sql<{ id: string; stage: string; owner_id: string | null }[]>`
    SELECT id, stage, owner_id FROM leads WHERE org_id = ${A.orgId} AND phone = '+919812300001'`;
  check("the buyer's lead is on the board, with the firm's relationship manager", priya?.stage === "visit_scheduled" && priya.owner_id === A.rm);
  await say(RAHUL, "book SV kal 5pm 9800000501", "Rahul");
  check("no visit for a buyer the firm does not hold", /aapke naam par live registered nahi hai/.test(lastTo(RAHUL)));
  await say(RAHUL, "mere buyers", "Rahul");
  check("the partner's own buyers, masked, with their days", /Priya Shah 98XXXXXX01, Sath Heights: \d+ din baaki/.test(lastTo(RAHUL)) && !/9812300001/.test(lastTo(RAHUL)));

  console.log("\nThe partner's WhatsApp: the three things that ask for a code");
  // One code a minute per number: the suite moves the last one back.
  const minuteOn = () => sql`UPDATE otp_challenges SET created_at = created_at - interval '2 minutes' WHERE phone_hash = ${phoneHash(RAHUL)}`;
  await minuteOn();
  const codesBefore = codes.length;
  await say(RAHUL, "Priya ka pura number", "Rahul");
  check("a whole number asks for a fresh code", codes.length === codesBefore + 1 && /poora number dekhne/.test(lastTo(RAHUL)));
  await say(RAHUL, codes.at(-1)!.code, "Rahul");
  check("and shows it once the code comes back", lastTo(RAHUL) === "Priya Shah: +91 98123 00001");
  const [shownRow] = await sql<{ body: string }[]>`
    SELECT body FROM messages WHERE org_id = ${A.orgId} AND direction = 'OUT' AND phone = ${RAHUL} ORDER BY created_at DESC LIMIT 1`;
  check("the stored reply does not hold the number", !/98123|9812300001/.test(shownRow.body));
  const unmaskAudit = (await audits(A.orgId)).filter((a) => a.action === "partner.number_unmasked");
  check("the reveal is audited with a hash", unmaskAudit.length === 1 && !JSON.stringify(unmaskAudit).includes("9812300001"));
  await minuteOn();
  await say(RAHUL, "export", "Rahul");
  await say(RAHUL, codes.at(-1)!.code, "Rahul");
  const csv = to(RAHUL).find((m) => m.kind === "media" && m.mediaType === "text/csv");
  check("an export goes as a file after its own code", !!csv && csv.bytes!.toString("utf8").includes("+919812300001"));

  console.log("\nThe partner's WhatsApp: payouts told unprompted");
  await sql`
    UPDATE leads SET stage = 'booked', path_stage = 'booked', facts = ${sql.json({ unit: "C-1501", agreement: "8000000", bookedOn: today, token: "100000" })}
    WHERE id = ${priya.id}`;
  const p3 = await onBooked({ orgId: A.orgId, userId: A.admin, leadId: priya.id });
  const told = to(RAHUL).at(-1);
  check("a booking tells the person who registered the buyer", told?.kind === "text" && /payout update: Booking record ho gayi/.test(told.body), told?.body);
  const [payRow] = await sql<{ category: string; purpose: string }[]>`
    SELECT category, purpose FROM messages WHERE org_id = ${A.orgId} AND phone = ${RAHUL} AND purpose = 'PARTNER_PAYOUT' ORDER BY created_at DESC LIMIT 1`;
  check("inside their window it is a free reply, and a row", payRow?.category === "SERVICE");
  await sql`UPDATE messages SET created_at = now() - interval '2 days' WHERE org_id = ${A.orgId} AND phone = ${RAHUL} AND direction = 'IN'`;
  await recordBookingDates({ orgId: A.orgId, userId: A.admin, payoutId: p3!.payoutId, agreementRegisteredOn: today, collectedOn: null, today });
  const tpl = to(RAHUL).at(-1);
  check("outside it, the approved utility template", tpl?.kind === "template" && tpl.template === "salesdesk_partner_payout" && /aapki invoice ka intezaar/.test(tpl.body), tpl?.body);
  const [m1p] = await sql<{ id: string; gross: string }[]>`SELECT id, gross FROM payout_milestones WHERE payout_id = ${p3!.payoutId} AND key = 'M1'`;
  await fileInvoice({ orgId: A.orgId, userId: A.rm, milestoneId: m1p.id, invoiceNo: "KR/9", invoiceDate: today, amount: Number(m1p.gross), bytes: pdf, mediaType: "application/pdf", today });
  const early2 = await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1p.id, move: { kind: "verify" }, today });
  check("an invoice the firm has not confirmed is not verified", !early2.ok && early2.message === "The firm hasn't confirmed this invoice on WhatsApp yet.");
  await say(RAHUL, "payout status", "Rahul");
  check("payout status names what each half waits on", /C-1501 · Priya S\. \(Sath Heights\)\nM1 Rs [\d,]+: invoice mili, "invoice confirm"/.test(lastTo(RAHUL)), lastTo(RAHUL));
  check("and shows a paid half with its UTR", /PAID .*UTR HDFCN26092800417/.test(lastTo(RAHUL)));
  await minuteOn();
  await say(RAHUL, "invoice confirm", "Rahul");
  check("confirming an invoice asks for a code", /Invoice KR\/9/.test(lastTo(RAHUL)) && /6 digit code/.test(lastTo(RAHUL)));
  await say(RAHUL, "111111" === codes.at(-1)!.code ? "222222" : "111111", "Rahul");
  check("a wrong code confirms nothing", (await sql`SELECT 1 FROM partner_invoices WHERE org_id = ${A.orgId} AND invoice_no = 'KR/9' AND attested_at IS NOT NULL`).length === 0);
  await say(RAHUL, codes.at(-1)!.code, "Rahul");
  const [att] = await sql<{ attested_by: string | null }[]>`SELECT attested_by FROM partner_invoices WHERE org_id = ${A.orgId} AND invoice_no = 'KR/9'`;
  check("the right one confirms it, as the person who holds the number", att?.attested_by === rahul.user_id && /confirm ho gayi/.test(lastTo(RAHUL)));
  check("and then it can be verified", (await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1p.id, move: { kind: "verify" }, today })).ok);

  console.log("\nThe partner's WhatsApp: what it refuses");
  await say(RAHUL, "bank account change karna hai", "Rahul");
  check("a bank account is never changed over WhatsApp", /^Bank ya payout account badalna WhatsApp par nahi hota\. Tanmay Kulkarni se baat kijiye\.$/.test(lastTo(RAHUL)), lastTo(RAHUL));
  await say(RAHUL, "Diwali creative bhejo", "Rahul");
  check("no creative is sent when there is no approved post", /koi approved creative nahi hai/.test(lastTo(RAHUL)));
  await changeGrant({ orgId: A.orgId, userId: A.rm, grantId: grantA, action: { kind: "suspend", reason: "Documents pending" } });
  await say(RAHUL, "mere buyers", "Rahul");
  check("a firm on hold is refused at the next message", /empanelment abhi live nahi hai/.test(lastTo(RAHUL)));
  await changeGrant({ orgId: A.orgId, userId: A.rm, grantId: grantA, action: { kind: "restore" } });
  const turnsBefore = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM partner_bot_turns WHERE agent_id = ${rahul.id}`)[0].n;
  await sql`
    INSERT INTO partner_bot_turns (org_id, agent_id, firm_id, action, outcome)
    SELECT ${A.orgId}, ${rahul.id}, ${firmA}, 'help', 'DONE' FROM generate_series(1, ${60 - turnsBefore > 0 ? 60 - turnsBefore : 0})`;
  const sentBefore = to(RAHUL).length;
  await say(RAHUL, "help", "Rahul");
  await say(RAHUL, "help", "Rahul");
  check("past the day's allowance it says so once, then nothing", to(RAHUL).length === sentBefore + 1 && /limit poori/.test(lastTo(RAHUL)));
  await sql`DELETE FROM partner_bot_turns WHERE agent_id = ${rahul.id} AND message_id IS NULL`;
  // The organisation's ceiling on what the model reads, whoever writes.
  await sql`
    INSERT INTO partner_bot_turns (org_id, agent_id, firm_id, action, outcome, model, usd)
    SELECT ${A.orgId}, a.id, ${firmA}, 'unclear', 'DONE', 'gpt-5-mini', 0.0007
    FROM partner_agents a, generate_series(1, 70) WHERE a.org_id = ${A.orgId} AND a.phone = '+919876543210'`;
  const sawBefore = modelSaw.length;
  await say(RAHUL, "3bhk tower C mein kya hai", "Rahul");
  check("past the organisation's ceiling the model is not asked", modelSaw.length === sawBefore && /seedhe commands/.test(lastTo(RAHUL)));
  await say(RAHUL, "payout status", "Rahul");
  check("and what the bot reads on its own still works", /C-1501/.test(lastTo(RAHUL)));
  await sql`DELETE FROM partner_bot_turns WHERE org_id = ${A.orgId} AND message_id IS NULL`;

  console.log("\nThe partner's WhatsApp: in the partner's own language");
  const langOf = async () => (await sql<{ language: string }[]>`SELECT language FROM partner_agents WHERE id = ${rahul.id}`)[0].language;
  check("a person on the list reads Hinglish until they choose", (await langOf()) === "hi");
  await say(RAHUL, "language", "Rahul");
  check("\"language\" offers the three to pick from", /1\. English\n2\. Hindi \(Hinglish\)\n3\. Marathi\nNumber bhejiye\./.test(lastTo(RAHUL)), lastTo(RAHUL));
  await say(RAHUL, "1", "Rahul");
  check("a pick is theirs, stored on their row", (await langOf()) === "en" && lastTo(RAHUL) === "Okay, I will write in English from now on.", lastTo(RAHUL));
  await say(RAHUL, "payout status", "Rahul");
  check("and every reply after it is in English", /C-1501 · Priya S\. \(Sath Heights\)\nM1 Rs [\d,]+: waiting for approval/.test(lastTo(RAHUL)) && /due after 30% is collected/.test(lastTo(RAHUL)), lastTo(RAHUL));
  await sql`UPDATE messages SET created_at = now() - interval '2 days' WHERE org_id = ${A.orgId} AND phone = ${RAHUL} AND direction = 'IN'`;
  await notifyPayout(A.orgId, p3!.payoutId, { kind: "half", key: "M1" });
  const enTpl = to(RAHUL).at(-1);
  check("a payout update outside their window is the English version of the template", enTpl?.kind === "template" && enTpl.template === "salesdesk_partner_payout_en" && /waiting for approval/.test(enTpl.body), JSON.stringify(enTpl));
  await say(RAHUL, "marathi madhe", "Rahul");
  check("a language written out is taken too", (await langOf()) === "mr" && lastTo(RAHUL) === "Theek aahe, aata pasun Marathi madhe lihu.", lastTo(RAHUL));
  await say(RAHUL, "help", "Rahul");
  check("Marathi is Roman letters, never Devanagari", /maze buyers/.test(lastTo(RAHUL)) && !/[\u0900-\u097F]/.test(lastTo(RAHUL)), lastTo(RAHUL));
  await say(RAHUL, "Priya ka pura number", "Rahul");
  check("what the model picked is answered in it too (a booked buyer is no longer a live claim)",
    lastTo(RAHUL) === 'Ha buyer sadhya tumchya navavar registered nahi. Aadhi "register 98XXXXXXXX" liha.', lastTo(RAHUL));

  await say(RAHUL, "STOP", "Rahul");
  check("STOP turns payout updates off", (await sql`SELECT 1 FROM partner_agents WHERE id = ${rahul.id} AND muted_at IS NOT NULL`).length === 1);
  const quiet = to(RAHUL).length;
  await moveMilestone({ orgId: A.orgId, userId: A.admin, milestoneId: m1p.id, move: { kind: "approve" }, today });
  check("and nothing unprompted goes after it", to(RAHUL).length === quiet);
  check("taken off the list, the bot no longer knows them", (await removeAgent({ orgId: A.orgId, userId: A.rm, agentId: rahul.id })).ok);
  await say(RAHUL, "mere buyers", "Rahul");
  check("so a message from them gets no bot reply", to(RAHUL).length === quiet);

  console.log("\nA buyer taps a partner's wa.me link");
  const liveCode = other.ok ? other.code : "";
  await say("+919800000601", `Namaste! Mujhe Sath Heights ke baare mein jaanna hai. Ref ${liveCode}`, "Meera Rao");
  const [waLead] = await sql<{ id: string; channel: string; source: string; name: string }[]>`
    SELECT id, channel, source, name FROM leads WHERE org_id = ${A.orgId} AND phone = '+919800000601'`;
  check("the buyer's message becomes a lead, named from their profile", waLead?.channel === "WHATSAPP" && waLead.name === "Meera Rao" && waLead.source === "Partner's link, WhatsApp", JSON.stringify(waLead));
  const [waClaim] = await sql<{ verdict: string; via: string; lead_id: string | null; cp_org_id: string }[]>`
    SELECT verdict, via, lead_id, cp_org_id FROM client_registrations WHERE org_id = ${A.orgId} AND phone = '+919800000601'`;
  check("and the partner's claim, in the same breath", waClaim?.verdict === "REGISTERED" && waClaim.via === "LINK" && waClaim.lead_id === waLead?.id && waClaim.cp_org_id === cpU.cp_org_id);
  const [waMsg] = await sql<{ lead_id: string | null }[]>`
    SELECT lead_id FROM messages WHERE org_id = ${A.orgId} AND phone = '+919800000601' AND direction = 'IN'`;
  check("the message lands on the lead", waMsg?.lead_id === waLead?.id);
  await say("+919800000602", `Hi, Ref ${code}`, "Late Tap");
  check("a retired link's code still makes the lead, and claims nobody",
    (await sql`SELECT 1 FROM leads WHERE org_id = ${A.orgId} AND phone = '+919800000602'`).length === 1 &&
      (await sql`SELECT 1 FROM client_registrations WHERE org_id = ${A.orgId} AND phone = '+919800000602'`).length === 0);

  console.log("\nThe desk: numbers masked, and the people on WhatsApp");
  const deskW = await loadDesk({ orgId: A.orgId, partnerScopes: [A.root.path], payoutScopes: [A.root.path], unmaskScopes: [] });
  check("the page is sent no whole buyer number", !/98123\d{5}|9800000\d{3}/.test(JSON.stringify(deskW.registrations)));
  check("and cannot reveal one without the key", deskW.registrations.every((r) => !r.canReveal));
  check("the firm's list reads who is on WhatsApp", deskW.agents.some((a) => a.firmId === firmA && a.principal && a.status === "WAITING"));
  check("a link opens WhatsApp to the developer's number", deskW.links.some((l) => l.whatsapp && l.url?.startsWith(`https://wa.me/${numA.display_phone.replace(/\D/g, "")}?text=`)));
  const regId = deskW.registrations.find((r) => r.live)!.id;
  check("a reveal is refused where the key is not held",
    !(await revealRegistration({ orgId: A.orgId, userId: A.rm, registrationId: regId, mayAt: () => false })).ok);
  const shown = await revealRegistration({ orgId: A.orgId, userId: A.rm, registrationId: regId, mayAt: () => true });
  check("and one number is shown, with a row saying so", shown.ok && /^\+91 \d{5} \d{5}$/.test(shown.phone));
  check("a whole number is found by the server, inside the viewer's reach",
    (await findRegistrations(A.orgId, "9812300001", [A.root.path])).length >= 1 && (await findRegistrations(A.orgId, "9812300001", [B.root.path])).length === 0);
  wa.restore();
  codeSender.restore();
  model.restore();
} finally {
  useStorage(null);
  useVaultKey(null);
  for (const orgId of made.orgs.slice(0, 2)) {
    await sql`DELETE FROM partner_invoices WHERE org_id = ${orgId}`;
    await sql`ALTER TABLE payout_milestones DISABLE TRIGGER payout_milestones_forward_only`;
    await sql`DELETE FROM partner_adjustment_uses WHERE org_id = ${orgId}`;
    await sql`DELETE FROM partner_adjustments WHERE org_id = ${orgId}`;
    await sql`DELETE FROM payout_milestones WHERE org_id = ${orgId}`;
    await sql`ALTER TABLE payout_milestones ENABLE TRIGGER payout_milestones_forward_only`;
    await sql`DELETE FROM partner_payouts WHERE org_id = ${orgId}`;
    await sql`DELETE FROM client_registrations WHERE org_id = ${orgId}`;
    await sql`DELETE FROM partner_links WHERE org_id = ${orgId}`;
    await sql`DELETE FROM grants WHERE org_id = ${orgId}`;
    await sql`DELETE FROM partner_bot_turns WHERE org_id = ${orgId}`;
    await sql`DELETE FROM partner_bot_pending WHERE org_id = ${orgId}`;
    await sql`UPDATE messages SET partner_agent_id = NULL WHERE org_id = ${orgId}`;
    await sql`DELETE FROM partner_agents WHERE org_id = ${orgId}`;
    await sql`DELETE FROM partner_firms WHERE org_id = ${orgId}`;
    await sql`DELETE FROM commission_terms WHERE org_id = ${orgId}`;
    await sql`DELETE FROM partner_settings WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_tasks WHERE org_id = ${orgId}`;
    await dropFixtureNumbers(sql, orgId);
    await sql`DELETE FROM messages WHERE org_id = ${orgId}`;
    await sql`DELETE FROM site_visits WHERE org_id = ${orgId}`;
    await sql`DELETE FROM calls WHERE org_id = ${orgId}`;
    await sql`DELETE FROM leads WHERE org_id = ${orgId}`;
  }
  // The people the bot made users of, by the phones this suite used.
  const botPhones = ["+919811100001", "+919876543210"];
  await sql`DELETE FROM otp_challenges WHERE phone_hash = ANY(${botPhones.map(phoneHash)})`;
  await sql`DELETE FROM audit_log WHERE org_id = ANY(${made.orgs})`;
  await sql`DELETE FROM orgs WHERE id = ANY(${made.orgs})`;
  await sql`DELETE FROM users WHERE phone = ANY(${botPhones}) AND email IS NULL`;
  await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
