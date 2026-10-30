/**
 * Mandate firms and the three kinds of company at sign-up, end to end, with
 * the invite email and the WhatsApp code injected.
 *
 * A developer tenant of its own, built here and removed at the end. It
 * offers a mandate to a firm not yet on Sales Desk (an invite), the firm
 * signs up and finds the offer waiting, accepts it from its own tenant, and
 * a booking in the project earns it commission on the partner's own two
 * halves, walked from invoice to UTR. Then renewing, ending, withdrawing and
 * declining, the sole-mandate rule in the application and in the database,
 * and a channel partner signing up: refused on a number nobody recorded,
 * then claiming the firm a developer had added, with a code.
 */
import postgres from "postgres";
import { closeDb, withTenant } from "../src/lib/db/index.ts";
import { useCodeSender } from "../src/lib/otp.ts";

// The codes are what is under test, so a development machine's skip does not apply here.
delete process.env.OTP_DEV_SKIP;
// A personal mailbox is refused here, so a development machine's escape hatch does not apply either.
delete process.env.AUTH_ALLOW_PERSONAL_ACCOUNTS;
import { phoneHash } from "../src/lib/otp-rules.ts";
import { useWhatsApp } from "../src/lib/whatsapp.ts";
import {
  answerMandate,
  askExtension,
  changeMandate,
  mandateQueue,
  findMandateFirm,
  loadMandates,
  mandateProjects,
  mandatesForFirm,
  offerMandate,
  useMandateMail,
} from "../src/lib/mandates.ts";
import { createMandateFirm, finishPartnerSignup, readFirmValues, startPartnerSignup } from "../src/lib/firm-signup.ts";
import {
  empanelFirm,
  fileInvoice,
  loadDesk,
  moveMilestone,
  onBooked,
  onUnbooked,
  readFirm,
  recordBookingDates,
  setPassBack,
} from "../src/lib/partners.ts";
import { commissionAlerts, firmAlerts, homeFor } from "../src/lib/mandate-rules.ts";
import { firmCommission } from "../src/lib/firm-workspace.ts";
import { moveLead } from "../src/lib/leads.ts";
import { gstinCheckDigit } from "../src/lib/gstin.ts";
import { useStorage, type StorageDriver } from "../src/lib/storage.ts";
import { ist } from "../src/lib/cadence-rules.ts";
import type { Mail } from "../src/lib/mailer.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

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
useWhatsApp({
  async sendTemplate() {
    return { id: `wamid.${Date.now()}.${Math.random()}` };
  },
});
const mails: Mail[] = [];
const mail = useMandateMail(async (m) => {
  mails.push(m);
  return { ok: true, messageId: `m-${mails.length}` };
});
const codes: { to: string; code: string }[] = [];
const codeSender = useCodeSender({
  async send(to, code) {
    codes.push({ to, code });
  },
});

// ---------------------------------------------------------------------------
// A developer of its own, and the people who sign up
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const n4 = String(Date.now() % 10000).padStart(4, "0");
const FIRM_PAN = `AAAFM${n4}G`;
const FIRM2_PAN = `AAAFN${n4}H`;
const CP_PAN = `AAAFP${n4}J`;
const CP2_PAN = `AAAFQ${n4}K`;
const gstinOf = (pan: string) => `27${pan}1Z${gstinCheckDigit(`27${pan}1Z`)}`;
const made = { users: [] as string[], orgs: [] as string[] };
const phones = ["+919876500001", "+919876500002", "+919876500003"];

const user = async (email: string, name: string) => {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${email}, ${email.split("@")[1]}, ${name}) RETURNING id`;
  made.users.push(u.id);
  return u.id;
};

const admin = await user(`admin@dev${tag}.example`, "Dev Admin");
const [dev] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
  VALUES ('DEVELOPER', 'Sath Developers', 'Sath Developers', 'AAPFU0939F', ${`dev${tag}.example`}, ${admin}) RETURNING id`;
made.orgs.push(dev.id);
const node = async (parent: { id: string; path: string } | null, kind: string, name: string, slug: string) => {
  const path = parent ? `${parent.path}.${slug}` : slug;
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${dev.id}, ${parent?.id ?? null}, ${kind}, ${name}, ${slug}, ${path}::ltree) RETURNING id, path::text AS path`;
  return row;
};
const root = await node(null, "ORG", "Sath Developers", `mdev_${tag}`);
const entity = await node(root, "ENTITY", "Sath Developers LLP", "spv");
const region = await node(entity, "REGION", "Pune", "pune");
const heights = await node(region, "PROJECT", "Sath Heights", "heights");
const towerC = await node(heights, "PHASE", "Tower C", "tower_c");
const greens = await node(region, "PROJECT", "Sath Greens", "greens");
const towerG = await node(greens, "PHASE", "Tower G", "tower_g");
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin}, ${dev.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;

const founder = await user(`ramesh@guardians${tag}.example`, "Ramesh Kulkarni");
const founder2 = await user(`asha@anarock${tag}.example`, "Asha Rao");
const cpFounder = await user(`sagar.kale${tag}@gmail.com`, "Sagar Kale");
const cpFounder2 = await user(`meera${tag}@gmail.com`, "Meera Joshi");

const NOW = new Date().toISOString();
const today = ist(NOW).date;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const offer = (over: Partial<Parameters<typeof offerMandate>[0]["input"]> = {}) =>
  offerMandate({
    orgId: dev.id,
    userId: admin,
    input: {
      pan: FIRM_PAN,
      firmName: "Guardians Real Estate Advisory",
      contactName: "Ramesh Kulkarni",
      contactEmail: `ramesh@guardians${tag}.example`,
      rate: 0.03,
      projectIds: [heights.id],
      validTo: days(365),
      ...over,
    },
  });
const statusOf = async (id: string) => (await sql<{ status: string }[]>`SELECT status FROM mandates WHERE id = ${id}`)[0]?.status;
const book = async (phaseId: string, phone: string, agreement: number, unit: string) => {
  const [l] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, stage, path_stage, facts)
    VALUES (${dev.id}, ${phaseId}, 'Buyer', ${phone}, 'Website', 'booked', 'booked',
            ${sql.json({ unit, agreement: String(agreement), bookedOn: today, token: "100000" })})
    RETURNING id`;
  await onBooked({ orgId: dev.id, userId: admin, leadId: l.id });
  return l.id;
};
const mandatePayouts = (leadId: string) =>
  sql<{ id: string; rate: string; cancelled_at: Date | null; cp_org_id: string; registration_id: string | null }[]>`
    SELECT id, rate, cancelled_at, cp_org_id, registration_id FROM partner_payouts WHERE lead_id = ${leadId} AND kind = 'MANDATE'`;

try {
  console.log("\nAn offer to a firm not yet here is an invite");
  const bad = await offer({ rate: 0.09, contactEmail: "nope", validTo: today });
  check("a rate over eight per cent, a bad email and a past day are refused by field",
    !bad.ok && !!bad.errors?.rate && !!bad.errors?.contactEmail && !!bad.errors?.validTo);
  check("a project from nowhere is refused", !(await offer({ projectIds: ["00000000-0000-0000-0000-000000000000"] })).ok);
  check("nobody by this PAN is on Sales Desk yet", (await findMandateFirm(dev.id, FIRM_PAN)) === null);
  const inv = await offer();
  check("the offer is saved and the invite sent", inv.ok && inv.message.startsWith("Invite sent to"), inv.message);
  const mandateId = inv.ok ? inv.id : "";
  check("it waits as an invite", (await statusOf(mandateId)) === "INVITED");
  const m0 = mails[0];
  check("the invite names the developer, the project, the rate and the sign-up link",
    !!m0 && m0.to === `ramesh@guardians${tag}.example` && m0.subject.includes("Sath Developers") && m0.subject.includes("Sath Heights") &&
      m0.text.includes("3% commission") && m0.text.includes("/signin?as=mandate"));
  const [au] = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM audit_log WHERE org_id = ${dev.id} AND action = 'mandate.invited'`;
  check("the audit row holds hashes, never the PAN or the address",
    !!au && !JSON.stringify(au.metadata).includes(FIRM_PAN) && !JSON.stringify(au.metadata).includes("@"));
  const twice = await offer({ pan: FIRM2_PAN, firmName: "Another Firm" });
  check("a second firm on the same project and days is refused: the mandate is sole", !twice.ok && twice.message.includes("already has a mandate"), twice.message);
  const held = await mandateProjects({ orgId: dev.id, scopes: [root.path] });
  check("the appoint form shows the project as held, by whom",
    held.find((p) => p.id === heights.id)?.heldBy === "Guardians Real Estate Advisory" && held.find((p) => p.id === greens.id)?.heldBy === null);

  console.log("\nThe firm signs up and finds the offer waiting");
  const personal = readFirmValues("MANDATE_FIRM", { legalName: "Guardians Advisory LLP", pan: FIRM_PAN, reraNo: "A51700001835" }, today);
  check("the sign-up form reads", personal.ok);
  if (!personal.ok) throw new Error("form");
  const gmail = await createMandateFirm({ userId: founder, values: personal.values, emailDomain: "gmail.com", idpTenant: null });
  if (gmail.ok) made.orgs.push(gmail.orgId);
  check("a mandate firm cannot sign up on a personal mailbox", !gmail.ok);
  const badForm = readFirmValues("MANDATE_FIRM", { legalName: "", pan: "NOPE", reraNo: "P123", reraTill: days(-1) }, today);
  check("a bad sign-up form names every field", !badForm.ok && ["legalName", "pan", "reraNo", "reraTill"].every((k) => k in badForm.errors));
  const vals = readFirmValues("MANDATE_FIRM", {
    legalName: "Guardians Real Estate Advisory Private Limited",
    displayName: "Guardians",
    pan: FIRM_PAN,
    gstin: gstinOf(FIRM_PAN),
    reraNo: "A51700001835",
    reraTill: days(500),
    city: "Pune",
    phone: "98220 12345",
  }, today);
  check("the phone is read to E.164", vals.ok && vals.values.phone === "+919822012345", vals.ok ? String(vals.values.phone) : JSON.stringify(vals.errors));
  if (!vals.ok) throw new Error("form");
  const created = await createMandateFirm({ userId: founder, values: vals.values, emailDomain: `guardians${tag}.example`, idpTenant: null });
  check("the firm is created, and told an offer waits", created.ok && created.note === "1 offer is waiting for you.", created.ok ? String(created.note) : created.error);
  const firmOrg = created.ok ? created.orgId : "";
  made.orgs.push(firmOrg);
  const [fo] = await sql<{ type: string; status: string }[]>`SELECT type, status FROM orgs WHERE id = ${firmOrg}`;
  check("a mandate firm org, live", fo?.type === "MANDATE_FIRM" && fo?.status === "ACTIVE");
  const [adm] = await sql<{ role: string }[]>`SELECT role FROM memberships WHERE org_id = ${firmOrg} AND user_id = ${founder}`;
  check("its founder is its admin", adm?.role === "ORG_ADMIN");
  check("and lands in the console, as a developer does", homeFor("MANDATE_FIRM") === "/dashboard" && homeFor("DEVELOPER") === "/dashboard");
  check("the invite became an offer to this firm", (await statusOf(mandateId)) === "OFFERED");
  const again = await createMandateFirm({ userId: founder2, values: vals.values, emailDomain: `other${tag}.example`, idpTenant: null });
  check("the same PAN cannot sign up a second firm", !again.ok && !!again.existing);
  const seen = await mandatesForFirm(firmOrg);
  check("the firm reads its offer: the developer, the project, the rate",
    seen.length === 1 && seen[0].developer === "Sath Developers" && seen[0].projects[0] === "Sath Heights" && seen[0].rate === 0.03 && seen[0].state === "offered");
  check("the developer now finds the firm by PAN", (await findMandateFirm(dev.id, FIRM_PAN))?.name === "Guardians");

  console.log("\nOnly the firm answers, once");
  const v2 = readFirmValues("MANDATE_FIRM", { legalName: "Anarock Advisory", pan: FIRM2_PAN, reraNo: "A51700009999" }, today);
  if (!v2.ok) throw new Error("form");
  const c2 = await createMandateFirm({ userId: founder2, values: v2.values, emailDomain: `anarock${tag}.example`, idpTenant: null });
  const firm2 = c2.ok ? c2.orgId : "";
  made.orgs.push(firm2);
  check("another firm cannot answer it", (await answerMandate({ firmOrgId: firm2, userId: founder2, mandateId, accept: true })).message === "That offer is not here.");
  check("the developer cannot answer it for the firm", (await answerMandate({ firmOrgId: dev.id, userId: admin, mandateId, accept: true })).message === "That offer is not here.");
  let refused = "";
  try {
    await withTenant(dev.id, (tx) => tx`UPDATE mandates SET status = 'LIVE' WHERE id = ${mandateId}`);
  } catch (e) {
    refused = (e as { code?: string }).code ?? "error";
  }
  check("the database refuses the developer marking it accepted", refused === "23514", refused);
  const sentBefore = mails.length;
  const yes = await answerMandate({ firmOrgId: firmOrg, userId: founder, mandateId, accept: true });
  check("the firm accepts", yes.ok && yes.message === "Accepted. The mandate is live.", yes.message);
  check("whoever offered it is emailed that it was accepted",
    mails.slice(sentBefore).some((m) => m.to === `admin@dev${tag}.example` && /accepted the mandate/.test(m.subject)), JSON.stringify(mails.slice(sentBefore).map((m) => m.subject)));
  check("and the developer's Today says so", (await mandateQueue(dev.id)).some((a) => a.id === `mandate-accepted-${mandateId}`));
  check("it is live", (await statusOf(mandateId)) === "LIVE");
  const grants = await sql<{ id: string; role: string; grantee_org_id: string; scope_node_id: string; status: string }[]>`
    SELECT g.id, g.role, g.grantee_org_id, g.scope_node_id, g.status FROM grants g JOIN mandate_projects p ON p.grant_id = g.id WHERE p.mandate_id = ${mandateId}`;
  check("the firm holds a grant on the project", grants.length === 1 && grants[0].role === "MANDATE_FIRM" && grants[0].grantee_org_id === firmOrg && grants[0].scope_node_id === heights.id);
  const [gst] = await sql<{ firm_gstin: boolean }[]>`SELECT firm_gstin FROM mandates WHERE id = ${mandateId}`;
  check("whether it charges GST is read off the firm", gst?.firm_gstin === true);
  check("a second answer is refused", (await answerMandate({ firmOrgId: firmOrg, userId: founder, mandateId, accept: false })).message.startsWith("This offer was already answered"));
  const partnerView = await withTenant(firmOrg, (tx) => tx`SELECT 1 FROM partner_grants_for_firm()`);
  check("a mandate is not listed as a partner's empanelment", partnerView.length === 0);

  console.log("\nEvery booking in the project earns it commission");
  const lead1 = await book(towerC.id, "+919800070001", 1_00_00_000, "C-1101");
  const [p1] = await mandatePayouts(lead1);
  check("a booking at a tower under the project owes the firm", !!p1 && Number(p1.rate) === 0.03 && p1.cp_org_id === firmOrg && p1.registration_id === null);
  const halves = await sql<{ key: string; base: string; gst: string; gross: string; tds: string; net: string }[]>`
    SELECT key, base, gst, gross, tds, net FROM payout_milestones WHERE payout_id = ${p1?.id ?? null} ORDER BY key`;
  check("two halves of Rs 1,50,000, GST on top, TDS off the base",
    halves.map((h) => [h.key, Number(h.base), Number(h.gst), Number(h.tds), Number(h.net)]).join("|") === "M1,150000,27000,3000,174000|M2,150000,27000,3000,174000",
    JSON.stringify(halves));
  await onBooked({ orgId: dev.id, userId: admin, leadId: lead1 });
  check("a second call writes nothing more", (await mandatePayouts(lead1)).length === 1);
  const lead2 = await book(towerG.id, "+919800070002", 90_00_000, "G-401");
  check("a booking in a project outside the mandate owes nothing", (await mandatePayouts(lead2)).length === 0);
  check("a mandate's commission has no pass-back", !(await setPassBack({ orgId: dev.id, userId: admin, payoutId: p1!.id, passBack: 0.005 })).ok);

  const desk = await loadDesk({ orgId: dev.id, partnerScopes: [root.path], payoutScopes: [root.path], unmaskScopes: [] });
  const onDesk = desk.bookings.find((b) => b.id === p1!.id);
  check("the payouts desk is real with only a mandate on it", desk.real && desk.firms.length === 0);
  check("and shows the payout under the firm's name, marked as a mandate", onDesk?.firm === "Guardians Real Estate Advisory" && onDesk?.mandate === true);
  const rows = await loadMandates({ orgId: dev.id, scopes: [root.path] });
  const row = rows.find((r) => r.id === mandateId);
  check("the mandate reads live, with one booking and nothing due yet", row?.state === "live" && row?.bookings === 1 && row?.owed === 0, JSON.stringify(row));
  check("the firm is emailed what the booking earns it", mails.some((m) => m.to === `ramesh@guardians${tag}.example` && /Your commission on C-1101/.test(m.subject)));
  check("and sees the buyer it is for", (await firmCommission(firmOrg)).find((c) => c.id === p1!.id)?.buyer === "Buyer");

  console.log("\nThrough the mandate, a booking is the developer's to record");
  const [kiran] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, stage, path_stage, facts)
    VALUES (${dev.id}, ${towerC.id}, 'Kiran', '+919800070009', 'Website', 'negotiation', 'negotiation', '{}'::jsonb) RETURNING id`;
  const tried = await moveLead({ orgId: dev.id, userId: founder, leadId: kiran.id, to: "booked", input: { facts: { unit: "C-909", agreement: "9000000" } }, today, throughMandate: { firm: "Guardians Real Estate Advisory" } });
  check("the firm's move to Booked is refused, saying the developer records it", !tried.ok && /records each booking/.test(tried.message), tried.ok ? "" : tried.message);
  const [heldRow] = await sql<{ stage: string; needs_person: string | null }[]>`SELECT stage, needs_person FROM leads WHERE id = ${kiran.id}`;
  check("the lead stays where it was, flagged for the developer with what the firm said",
    heldRow.stage === "negotiation" && /Guardians Real Estate Advisory says this buyer booked C-909 at Rs 90,00,000/.test(heldRow.needs_person ?? ""), JSON.stringify(heldRow));
  check("no commission is written", (await mandatePayouts(kiran.id)).length === 0);
  await sql`DELETE FROM lead_activity WHERE lead_id = ${kiran.id}`;
  await sql`DELETE FROM leads WHERE id = ${kiran.id}`;
  check("a viewer whose reach is another project does not see it", (await loadMandates({ orgId: dev.id, scopes: [greens.path] })).length === 0);

  console.log("\nThe firm is paid the way a partner is");
  const m1 = (await sql<{ id: string }[]>`SELECT id FROM payout_milestones WHERE payout_id = ${p1!.id} AND key = 'M1'`)[0].id;
  const dated = await recordBookingDates({ orgId: dev.id, userId: admin, payoutId: p1!.id, agreementRegisteredOn: today, collectedOn: null, today });
  check("the agreement's registration makes the first half owed", dated.ok, dated.message);
  check("once due, what is left to pay is the half that is due", (await loadMandates({ orgId: dev.id, scopes: [root.path] })).find((r) => r.id === mandateId)?.owed === 174000);
  check("and the firm is emailed that it is due", mails.some((m) => m.to === `ramesh@guardians${tag}.example` && /now due/.test(m.text)));
  const pdf = Buffer.from("%PDF-1.4 invoice");
  const gstWrong = await fileInvoice({ orgId: dev.id, userId: admin, milestoneId: m1, invoiceNo: "GRD/26/000", invoiceDate: today, amount: 177000, bytes: pdf, mediaType: "application/pdf", today });
  check("an invoice with the GST wrong is filed", gstWrong.ok, gstWrong.message);
  check("and sent back saying why", (await moveMilestone({ orgId: dev.id, userId: admin, milestoneId: m1, move: { kind: "reject", reason: "GST" }, today })).ok);
  const back = (await firmCommission(firmOrg)).find((c) => c.id === p1!.id)?.halves.find((h) => h.key === "M1");
  check("the firm reads the reason, on the invoice it sent", back?.rejected === true && back?.rejectReason === "GST" && back?.invoiceNo === "GRD/26/000", JSON.stringify(back));
  check("its Today says the invoice came back and why",
    commissionAlerts(await firmCommission(firmOrg)).some((a) => a.severity === "risk" && /sent back your invoice/.test(a.title) && /GST/.test(a.why)));
  check("and it is emailed", mails.some((m) => m.to === `ramesh@guardians${tag}.example` && /sent back/.test(m.text)));
  const filed = await fileInvoice({ orgId: dev.id, userId: admin, milestoneId: m1, invoiceNo: "GRD/26/001", invoiceDate: today, amount: 177000, bytes: pdf, mediaType: "application/pdf", today });
  check("its invoice is filed", filed.ok, filed.message);
  check("verified", (await moveMilestone({ orgId: dev.id, userId: admin, milestoneId: m1, move: { kind: "verify" }, today })).ok);
  check("approved", (await moveMilestone({ orgId: dev.id, userId: admin, milestoneId: m1, move: { kind: "approve" }, today })).ok);
  const paid = await moveMilestone({ orgId: dev.id, userId: admin, milestoneId: m1, move: { kind: "pay", utr: "HDFCN26092900417", paidOn: today }, today });
  check("and paid with its UTR", paid.ok, paid.message);
  check("what is left to pay drops by the half paid", (await loadMandates({ orgId: dev.id, scopes: [root.path] })).find((r) => r.id === mandateId)?.owed === 0);
  check("the firm is emailed it was paid, with the UTR", mails.some((m) => m.to === `ramesh@guardians${tag}.example` && /HDFCN26092900417/.test(m.text)));
  const sentBack = (await firmCommission(firmOrg)).find((c) => c.id === p1!.id)?.halves.find((h) => h.key === "M1");
  check("a corrected invoice replaces the one sent back", sentBack?.rejected === false && sentBack?.invoiceNo === "GRD/26/001", JSON.stringify(sentBack));

  console.log("\nRenewing, ending, and a cancelled booking");
  const lead3 = await book(towerC.id, "+919800070003", 80_00_000, "C-1202");
  check("a later booking earns too", (await mandatePayouts(lead3)).length === 1);
  await sql`UPDATE leads SET stage = 'negotiation' WHERE id = ${lead3}`;
  const unbooked = await onUnbooked({ orgId: dev.id, userId: admin, leadId: lead3 });
  check("leaving Booked cancels its commission, and reports no partner payout", unbooked === false && !!(await mandatePayouts(lead3))[0]?.cancelled_at);
  check("a paid half stays paid when its booking is still booked",
    (await sql<{ stage: string }[]>`SELECT stage FROM payout_milestones WHERE id = ${m1}`)[0].stage === "PAID");
  const asked = await askExtension({ firmOrgId: firmOrg, userId: founder, mandateId });
  check("the firm asks to run it longer", asked.ok, asked.message);
  check("whoever offered it is emailed", mails.some((m) => m.to === `admin@dev${tag}.example` && /asks to run the mandate/.test(m.subject)));
  check("and it is on the developer's Today", (await mandateQueue(dev.id)).some((a) => a.id === `mandate-extension-${mandateId}`));
  check("asking twice in a week is refused", !(await askExtension({ firmOrgId: firmOrg, userId: founder, mandateId })).ok);
  check("another firm cannot ask for it", !(await askExtension({ firmOrgId: firm2, userId: founder2, mandateId })).ok);
  check("running it for an earlier day is refused", !(await changeMandate({ orgId: dev.id, userId: admin, mandateId, change: { kind: "renew", validTo: days(100) } })).ok);
  const longer = await changeMandate({ orgId: dev.id, userId: admin, mandateId, change: { kind: "renew", validTo: days(700) } });
  check("it runs longer", longer.ok, longer.message);
  const [gl] = await sql<{ valid_to: Date }[]>`SELECT valid_to FROM grants WHERE id = ${grants[0].id}`;
  check("and so does the firm's grant", ist(gl.valid_to.toISOString()).date === days(700));
  check("which answers the firm's request", !(await mandateQueue(dev.id)).some((a) => a.id === `mandate-extension-${mandateId}`));
  check("the firm is emailed, and its Today says it runs longer",
    mails.some((m) => m.to === `ramesh@guardians${tag}.example` && /ran your mandate/.test(m.subject))
      && firmAlerts(await mandatesForFirm(firmOrg), new Date().toISOString()).some((a) => a.id === `firm-renewed-${mandateId}`));
  check("a live mandate is not withdrawn, it is ended", !(await changeMandate({ orgId: dev.id, userId: admin, mandateId, change: { kind: "withdraw" } })).ok);
  const ended = await changeMandate({ orgId: dev.id, userId: admin, mandateId, change: { kind: "end" } });
  check("it is ended", ended.ok && (await statusOf(mandateId)) === "ENDED");
  check("and the firm's grant with it", (await sql<{ status: string }[]>`SELECT status FROM grants WHERE id = ${grants[0].id}`)[0].status === "ENDED");
  const lead4 = await book(towerC.id, "+919800070004", 1_10_00_000, "C-1303");
  check("a booking after it ended owes the firm nothing", (await mandatePayouts(lead4)).length === 0);
  check("what it earned before stays", (await mandatePayouts(lead1))[0]?.cancelled_at === null);
  check("the firm sees it ended", (await mandatesForFirm(firmOrg)).find((m) => m.id === mandateId)?.state === "ended");
  check("on the day it was ended", !!(await mandatesForFirm(firmOrg)).find((m) => m.id === mandateId)?.endedAt);
  check("and is told by email and on Today",
    mails.some((m) => m.to === `ramesh@guardians${tag}.example` && /ended your mandate/.test(m.subject))
      && firmAlerts(await mandatesForFirm(firmOrg), new Date().toISOString()).some((a) => a.id === `firm-ended-${mandateId}`));

  console.log("\nWithdrawing, declining, and a project taken meanwhile");
  const mailedBefore = mails.length;
  const o2 = await offer({ projectIds: [greens.id] });
  check("an offer to a firm already here goes straight to it, no invite", o2.ok && o2.message.startsWith("Mandate sent to Guardians"), o2.message);
  check("and its admins are emailed that it waits",
    mails.slice(mailedBefore).length === 1 && mails[mailedBefore].to === `ramesh@guardians${tag}.example` && /offers you the mandate for Sath Greens/.test(mails[mailedBefore].subject));
  const o2id = o2.ok ? o2.id : "";
  check("it is waiting for its answer", (await statusOf(o2id)) === "OFFERED");
  check("withdrawn", (await changeMandate({ orgId: dev.id, userId: admin, mandateId: o2id, change: { kind: "withdraw" } })).ok);
  check("a withdrawn offer cannot be accepted", (await answerMandate({ firmOrgId: firmOrg, userId: founder, mandateId: o2id, accept: true })).message.startsWith("This offer was already answered"));
  check("and the firm sees it withdrawn, not waiting", (await mandatesForFirm(firmOrg)).find((m) => m.id === o2id)?.state === "withdrawn");
  check("is emailed, and its Today says so",
    mails.some((m) => /withdrew its mandate offer for Sath Greens/.test(m.subject))
      && firmAlerts(await mandatesForFirm(firmOrg), new Date().toISOString()).some((a) => a.id === `firm-withdrawn-${o2id}`));
  const o3 = await offer({ projectIds: [greens.id], rate: 0.025 });
  const o3id = o3.ok ? o3.id : "";
  check("declined", (await answerMandate({ firmOrgId: firmOrg, userId: founder, mandateId: o3id, accept: false })).message === "Declined.");
  check("and the project is free again", (await mandateProjects({ orgId: dev.id, scopes: [root.path] })).find((p) => p.id === greens.id)?.heldBy === null);
  const o4 = await offer({ pan: FIRM2_PAN, firmName: "", projectIds: [greens.id] });
  const o4id = o4.ok ? o4.id : "";
  check("offered to the second firm", o4.ok, o4.message);
  // Written past the application's own check, the way two answers at once
  // would arrive: the database decides which one holds the project.
  const [rival] = await sql<{ id: string }[]>`
    INSERT INTO mandates (org_id, firm_org_id, firm_name, firm_pan, rate, valid_from, valid_to, status, offered_by)
    VALUES (${dev.id}, ${firmOrg}, 'Guardians', ${FIRM_PAN}, 0.03, now() - interval '1 minute', now() + interval '200 days', 'OFFERED', ${admin})
    RETURNING id`;
  await sql`INSERT INTO mandate_projects (mandate_id, org_id, scope_node_id, project_name) VALUES (${rival.id}, ${dev.id}, ${greens.id}, 'Sath Greens')`;
  check("the first to accept holds the project", (await answerMandate({ firmOrgId: firm2, userId: founder2, mandateId: o4id, accept: true })).ok);
  check("the second is told another firm holds it", (await answerMandate({ firmOrgId: firmOrg, userId: founder, mandateId: rival.id, accept: true })).message.startsWith("Another firm now holds"));
  const [brief] = await sql<{ id: string }[]>`
    INSERT INTO mandates (org_id, firm_org_id, firm_name, firm_pan, rate, valid_from, valid_to, status, offered_by)
    VALUES (${dev.id}, ${firmOrg}, 'Guardians', ${FIRM_PAN}, 0.03, now() - interval '1 minute', now() + interval '1 second', 'OFFERED', ${admin})
    RETURNING id`;
  await new Promise((r) => setTimeout(r, 1200));
  check("an offer past its last day cannot be accepted", (await answerMandate({ firmOrgId: firmOrg, userId: founder, mandateId: brief.id, accept: true })).message === "This offer ran out before it was answered.");
  let shortened = "";
  try {
    await sql`UPDATE mandates SET valid_to = now() + interval '1 day' WHERE id = ${rival.id}`;
  } catch (e) {
    shortened = (e as { code?: string }).code ?? "error";
  }
  check("a mandate's last day never moves earlier", shortened === "23514", shortened);
  let moved = "";
  try {
    await sql`UPDATE mandates SET rate = 0.05 WHERE id = ${o4id}`;
  } catch (e) {
    moved = (e as { code?: string }).code ?? "error";
  }
  check("a mandate's rate never changes once offered, even for the owner", moved === "23514", moved);

  console.log("\nA channel partner signs up, and claims the firm a developer added");
  const cpForm = readFirm({ name: "Keystone Realty", legalName: "Keystone Realty LLP", pan: CP_PAN, reraNo: "A51700001836", reraTill: days(300), principalName: "Sagar Kale", principalPhone: "98765 00001" });
  if (!cpForm.ok) throw new Error("cp firm");
  const emp = await empanelFirm({ orgId: dev.id, userId: admin, firm: cpForm.firm, rmId: null, projectIds: [heights.id], validTo: days(365) });
  check("the developer empanels a partner, which makes it an unverified firm", emp.ok, emp.ok ? "" : emp.message);
  const [cpOrg] = await sql<{ id: string; status: string }[]>`SELECT id, status FROM orgs WHERE pan = ${CP_PAN}`;
  made.orgs.push(cpOrg.id);
  const needsPhone = readFirmValues("CHANNEL_PARTNER", { legalName: "Keystone Realty LLP", pan: CP_PAN, reraNo: "A51700001836" }, today);
  check("a channel partner must give its WhatsApp number", !needsPhone.ok && !!needsPhone.errors.phone);
  const wrong = readFirmValues("CHANNEL_PARTNER", { legalName: "Keystone Realty LLP", pan: CP_PAN, reraNo: "A51700001836", phone: "98765 00002" }, today);
  if (!wrong.ok) throw new Error("cp form");
  const refusedClaim = await startPartnerSignup({ userId: cpFounder, values: wrong.values, emailDomain: "gmail.com", idpTenant: null });
  check("a number the developer does not have is refused, and no code is sent", !refusedClaim.ok && !!refusedClaim.errors?.phone && codes.length === 0);
  const right = readFirmValues("CHANNEL_PARTNER", { legalName: "Keystone Realty LLP", displayName: "Keystone", pan: CP_PAN, reraNo: "A51700001836", phone: "98765 00001", city: "Pune" }, today);
  if (!right.ok) throw new Error("cp form");
  const started = await startPartnerSignup({ userId: cpFounder, values: right.values, emailDomain: "gmail.com", idpTenant: null });
  check("the number on record gets a code, and it is a claim", started.ok && started.claiming && codes.length === 1 && codes[0].to === "+919876500001");
  if (!started.ok) throw new Error("start");
  const wrongCode = await finishPartnerSignup({ userId: cpFounder, values: right.values, emailDomain: "gmail.com", idpTenant: null, challengeId: started.challengeId, code: codes[0].code === "000000" ? "111111" : "000000" });
  check("a wrong code is refused", !wrongCode.ok && !!wrongCode.errors?.code);
  const claimed = await finishPartnerSignup({ userId: cpFounder, values: right.values, emailDomain: "gmail.com", idpTenant: null, challengeId: started.challengeId, code: codes[0].code });
  check("the right code claims the firm, not a copy of it", claimed.ok && claimed.orgId === cpOrg.id, claimed.ok ? claimed.orgId : claimed.error);
  const [after] = await sql<{ status: string; display_name: string; type: string }[]>`SELECT status, display_name, type FROM orgs WHERE id = ${cpOrg.id}`;
  check("it is live now, under the name the partner gave", after.status === "ACTIVE" && after.display_name === "Keystone" && after.type === "CHANNEL_PARTNER");
  const [cpm] = await sql<{ role: string }[]>`SELECT role FROM memberships WHERE org_id = ${cpOrg.id} AND user_id = ${cpFounder} AND status = 'ACTIVE'`;
  check("its founder is its admin, on a personal Gmail", cpm?.role === "ORG_ADMIN");
  const [pu] = await sql<{ phone: string | null }[]>`SELECT phone FROM users WHERE id = ${cpFounder}`;
  check("and the proved number is theirs", pu?.phone === "+919876500001");
  const cpView = await withTenant(cpOrg.id, (tx) => tx<{ developer: string; project: string; live: boolean }[]>`SELECT developer, project, live FROM partner_grants_for_firm()`);
  check("the partner sees the developer and the project it is empanelled on", cpView.length === 1 && cpView[0].developer === "Sath Developers" && cpView[0].project === "Sath Heights" && cpView[0].live);
  check("and lands in the console, as a developer and a mandate firm do", homeFor("CHANNEL_PARTNER") === "/dashboard");
  const fresh = readFirmValues("CHANNEL_PARTNER", { legalName: "Meera Estates", pan: CP2_PAN, reraNo: "A51700001837", phone: "98765 00003" }, today);
  if (!fresh.ok) throw new Error("fresh form");
  const s2 = await startPartnerSignup({ userId: cpFounder2, values: fresh.values, emailDomain: "gmail.com", idpTenant: null });
  check("a partner nobody added gets a code too", s2.ok && !s2.claiming && codes.length === 2);
  if (!s2.ok) throw new Error("start 2");
  const c3 = await finishPartnerSignup({ userId: cpFounder2, values: fresh.values, emailDomain: "gmail.com", idpTenant: null, challengeId: s2.challengeId, code: codes[1].code });
  check("and is created as its own firm", c3.ok);
  if (c3.ok) made.orgs.push(c3.orgId);
  const [nf] = await sql<{ primary_domain: string | null; type: string }[]>`SELECT primary_domain, type FROM orgs WHERE id = ${c3.ok ? c3.orgId : null}`;
  check("with no Gmail domain recorded against it", nf?.type === "CHANNEL_PARTNER" && nf?.primary_domain === null);
  check("a partner firm is never offered as a mandate firm", (await findMandateFirm(dev.id, CP2_PAN)) === null);
} finally {
  mail.restore();
  codeSender.restore();
  useStorage(null);
  await sql`DELETE FROM partner_invoices WHERE org_id = ${dev.id}`;
  await sql`ALTER TABLE payout_milestones DISABLE TRIGGER payout_milestones_forward_only`;
  await sql`DELETE FROM partner_adjustment_uses WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM partner_adjustments WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM payout_milestones WHERE org_id = ${dev.id}`;
  await sql`ALTER TABLE payout_milestones ENABLE TRIGGER payout_milestones_forward_only`;
  await sql`DELETE FROM partner_payouts WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM mandate_projects WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM client_registrations WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM grants WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM partner_agents WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM partner_firms WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM commission_terms WHERE org_id = ${dev.id}`;
  // Grants, partner firms and terms point at their mandate (0065), so it goes last.
  await sql`DELETE FROM mandates WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM lead_tasks WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM messages WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM calls WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM outcome_events WHERE org_id = ${dev.id}`.catch(() => {});
  await sql`DELETE FROM leads WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM otp_challenges WHERE phone_hash = ANY(${phones.map(phoneHash)})`;
  await sql`DELETE FROM audit_log WHERE org_id = ANY(${made.orgs})`;
  await sql`DELETE FROM orgs WHERE id = ANY(${made.orgs})`;
  await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
