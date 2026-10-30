/**
 * A channel partner in its own console, end to end.
 *
 * A developer and two partner firms of their own, built here and removed at
 * the end. The developer empanels both on one of its two projects. The first
 * firm's founder signs in to its console and registers a buyer, books the
 * visit, makes its link and is owed a booking; the second firm is refused
 * the same buyer and never sees who holds them. Every screen is read over
 * HTTP from the dev server as the firm's people, so what a page SENDS is
 * what is judged: masked numbers, the firm's own rows, nothing another firm
 * holds.
 */
import postgres from "postgres";
import { encode } from "next-auth/jwt";
import { closeDb, withTenant } from "../src/lib/db/index.ts";
import { empanelFirm, moveMilestone, onBooked, recordBookingDates } from "../src/lib/partners.ts";
import { loadMaterials, registrationGap, smallPrintFor } from "../src/lib/compose.ts";
import { bookForFirm, fileInvoiceForFirm, linkForFirm, partnerWork, registerForFirm, registerLeadForFirm, registrationsForPhone } from "../src/lib/partner-workspace.ts";
import { useSarvam } from "../src/lib/sarvam.ts";
import { useWhatsApp } from "../src/lib/whatsapp.ts";
import { gstinCheckDigit } from "../src/lib/gstin.ts";
import { addDeveloperProject } from "../src/lib/linked-projects.ts";
import { termsFor } from "../src/lib/billing-rules.ts";
import { forgetLinks } from "../src/lib/linked.ts";
import { canPublish } from "../src/lib/publish-gate.ts";
import { openDraft, resolveBrain } from "../src/lib/brain.ts";
import { recordRegistration } from "../src/lib/rera.ts";
import { loadReadiness } from "../src/lib/readiness.ts";
import sharp from "sharp";
import { useStorage } from "../src/lib/storage.ts";
import { addAsset, approveAsset, approvedAssets } from "../src/lib/asset.ts";
import { addUnitType, approveUnitType, approvedUnits } from "../src/lib/unit.ts";
import { saveBrief } from "../src/lib/campaign.ts";
import { useMailer } from "../src/lib/mailer.ts";
import { answerOutside, makeOutsideInvoice, outsideInvoicePdf, outsideWork, recordInvoicePaid, recordOutsideBooking, registerOutside, saveSetup } from "../src/lib/outside.ts";
import { ist } from "../src/lib/cadence-rules.ts";

const BASE = process.env.AUTH_URL ?? "http://localhost:3000";
const COOKIE = "authjs.session-token";
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// Nothing here may reach a buyer: a visit's confirmation and any call go to fakes.
const sent: string[] = [];
useWhatsApp({
  async sendTemplate() {
    sent.push("template");
    return { id: `wamid.${Date.now()}.${Math.random()}` };
  },
});
useSarvam({
  async placeOutbound() {
    throw new Error("no call from this suite");
  },
  async getRecording() {
    return null;
  },
});

// ---------------------------------------------------------------------------
// A developer, two partner firms, and a mandate firm to be turned away
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const n4 = String(Date.now() % 10000).padStart(4, "0");
const P_PAN = `AAAFP${n4}Q`;
const Q_PAN = `AAAFQ${n4}R`;
const gstinOf = (pan: string) => `27${pan}1Z${gstinCheckDigit(`27${pan}1Z`)}`;
const made = { users: [] as string[], orgs: [] as string[] };
const NOW = new Date().toISOString();
const today = ist(NOW).date;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const user = async (email: string, name: string) => {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${email}, ${email.split("@")[1]}, ${name}) RETURNING id`;
  made.users.push(u.id);
  return { id: u.id, email };
};
const node = async (org: string, parent: { id: string; path: string } | null, kind: string, name: string, slug: string) => {
  const path = parent ? `${parent.path}.${slug}` : slug;
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org}, ${parent?.id ?? null}, ${kind}, ${name}, ${slug}, ${path}::ltree) RETURNING id, path::text AS path`;
  return row;
};
const org = async (type: string, name: string, pan: string, by: string, domain: string | null) => {
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, gstin, primary_domain, created_by, status)
    VALUES (${type}, ${`${name} LLP`}, ${name}, ${pan}, ${type === "DEVELOPER" ? null : gstinOf(pan)}, ${domain}, ${by}, 'ACTIVE') RETURNING id`;
  made.orgs.push(o.id);
  return o;
};

const devAdmin = await user(`admin@wdev${tag}.example`, "Dev Admin");
const pFounder = await user(`sagar@gmail-${tag}.example`, "Sagar Kale");
const qFounder = await user(`meera@gmail-${tag}.example`, "Meera Shah");
const outsider = await user(`nobody@else${tag}.example`, "Nobody");

const DEV = `Wadia Homes ${tag}`;
const dev = await org("DEVELOPER", DEV, "AAPFU0939F", devAdmin.id, `wdev${tag}.example`);
const root = await node(dev.id, null, "ORG", DEV, `wdev_${tag}`);
const entity = await node(dev.id, root, "ENTITY", "Wadia Homes LLP", "spv");
const region = await node(dev.id, entity, "REGION", "Pune", "pune");
const HEIGHTS = `Heights ${tag}`;
const GREENS = `Greens ${tag}`;
const heights = await node(dev.id, region, "PROJECT", HEIGHTS, "heights");
const towerC = await node(dev.id, heights, "PHASE", "Tower C", "tower_c");
const greens = await node(dev.id, region, "PROJECT", GREENS, "greens");
const towerG = await node(dev.id, greens, "PHASE", "Tower G", "tower_g");
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${devAdmin.id}, ${dev.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, promoter_name, valid_to, verified_at)
  VALUES (${towerC.id}, ${dev.id}, 'VERIFIED', 'P52100012345', 'MH', 'Wadia Homes LLP', ${days(400)}, now())`;

const P_NAME = `Skyline ${tag}`;
const Q_NAME = `Harbour ${tag}`;
const roots = new Map<string, { id: string; path: string }>();
const firmOrg = async (name: string, pan: string, founder: { id: string }) => {
  const o = await org("CHANNEL_PARTNER", name, pan, founder.id, null);
  const r = await node(o.id, null, "ORG", name, `cp_${name.toLowerCase().replace(/\W+/g, "_")}`);
  roots.set(o.id, r);
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${founder.id}, ${o.id}, ${r.id}, 'ORG_ADMIN', 'ACTIVE')`;
  await sql`INSERT INTO firm_profiles (org_id, rera_agent_no, rera_valid_till, city, phone) VALUES (${o.id}, 'A51900012873', ${days(400)}, 'Pune', '+919820045127')`;
  return o;
};
const P = await firmOrg(P_NAME, P_PAN, pFounder);
const Q = await firmOrg(Q_NAME, Q_PAN, qFounder);
const pRoot = roots.get(P.id)!;
const MANDATE = `Anchor ${tag}`;
const mandateFirm = await org("MANDATE_FIRM", MANDATE, `AAAFM${n4}S`, outsider.id, `else${tag}.example`);
const mRoot = await node(mandateFirm.id, null, "ORG", MANDATE, `mf_${tag}`);
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${outsider.id}, ${mandateFirm.id}, ${mRoot.id}, 'ORG_ADMIN', 'ACTIVE')`;

const session = async (u: { id: string; email: string }, orgId: string) =>
  `${COOKIE}=${await encode({ token: { sub: u.id, userId: u.id, email: u.email }, secret: process.env.AUTH_SECRET!, salt: COOKIE, maxAge: 900 })}; salesdesk.org=${orgId}`;
const get = async (cookie: string, path: string) => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(120_000) });
  return { status: res.status, location: res.headers.get("location") ?? "", body: (await res.text()).replace(/<!-- -->/g, "") };
};
const refused = (r: { status: number; body: string }) =>
  [302, 303, 307, 308, 404].includes(r.status) || /NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|http-equiv="refresh"/.test(r.body);
const redirectsTo = (r: { status: number; location: string; body: string }, to: string) =>
  r.location.endsWith(to) || r.body.includes(`NEXT_REDIRECT;replace;${to};`) || r.body.includes(`NEXT_REDIRECT;push;${to};`) || r.body.includes(`url=${to}"`);

const BUYER = `Rahul Deshmukh ${tag}`;
const PHONE = `+9197${n4}1101`;
const WHOLE = PHONE.slice(3);

try {
  console.log("\nThe developer empanels both firms on one of its two projects");
  const firmInput = (name: string, pan: string) => ({
    name,
    legalName: `${name} LLP`,
    pan,
    gstin: gstinOf(pan),
    reraNo: "A51900012873",
    reraTill: days(400),
    competencyTill: null,
    principalName: name.split(" ")[0],
    principalPhone: pan === P_PAN ? "+919820045127" : "+919820045128",
    area: "Pune",
  });
  const eP = await empanelFirm({ orgId: dev.id, userId: devAdmin.id, firm: firmInput(P_NAME, P_PAN), rmId: null, projectIds: [heights.id], validTo: days(200) });
  const eQ = await empanelFirm({ orgId: dev.id, userId: devAdmin.id, firm: firmInput(Q_NAME, Q_PAN), rmId: null, projectIds: [heights.id], validTo: days(20) });
  check("both are empanelled, on the partner orgs they signed up as", eP.ok && eQ.ok, eP.ok ? (eQ.ok ? "" : eQ.message) : eP.message);
  const [pf] = await sql<{ cp_org_id: string }[]>`SELECT cp_org_id FROM partner_firms WHERE org_id = ${dev.id} AND pan = ${P_PAN}`;
  check("found by its PAN, not made again", pf?.cp_org_id === P.id);

  console.log("\nThe partner's console");
  const asP = await session(pFounder, P.id);
  const asQ = await session(qFounder, Q.id);
  const home = await get(asP, "/dashboard");
  check("the partner's Today opens in the console", home.status === 200 && home.body.includes("needs"), `${home.status}`);
  check("its rail is the whole console, with Developers and without Partners",
    ["/dashboard/ask", "/dashboard/leads", "/dashboard/visits", "/dashboard/developers", "/dashboard/campaigns", "/dashboard/reports", "/dashboard/team"].every((h) => home.body.includes(h))
      && !home.body.includes('href="/dashboard/partners"'));
  check("its leads and call history open", (await get(asP, "/dashboard/leads")).status === 200 && (await get(asP, "/dashboard/leads/calls")).status === 200);
  check("the old workspace sends a partner to the console", redirectsTo(await get(asP, "/workspace"), "/dashboard") && redirectsTo(await get(asP, "/workspace/buyers"), "/dashboard/developers/buyers"));
  check("a developer has no partner's Developers", refused(await get(await session(devAdmin, dev.id), "/dashboard/developers/buyers")));
  const devs = await get(asP, "/dashboard/developers");
  check("Developers names the developer that empanelled it, with the one action", devs.status === 200 && devs.body.includes(DEV) && devs.body.includes("Register a buyer"), `${devs.status}`);
  check("the empanelment ending within the month is on Today", (await get(asQ, "/dashboard")).body.includes(`Your empanelment on ${HEIGHTS} ends`));

  console.log("\nA buyer registered from the console");
  const first = await registerForFirm({ cpOrgId: P.id, userId: pFounder.id, agentName: "Sagar Kale", devOrgId: dev.id, projectId: heights.id, phone: WHOLE, buyerName: BUYER });
  check("is registered, and says until when", first.ok && first.tone === "ok" && /registered on/.test(first.message), first.message);
  const [reg] = await sql<{ id: string; via: string; created_by: string }[]>`
    SELECT id, via, created_by FROM client_registrations WHERE org_id = ${dev.id} AND cp_org_id = ${P.id} AND verdict = 'REGISTERED'`;
  check("recorded as the partner's own, from its console", reg?.via === "WORKSPACE" && reg.created_by === pFounder.id);
  const again = await registerForFirm({ cpOrgId: P.id, userId: pFounder.id, agentName: null, devOrgId: dev.id, projectId: heights.id, phone: WHOLE, buyerName: BUYER });
  check("registering again says the buyer is already the firm's", again.ok && again.tone === "info", again.message);
  const blocked = await registerForFirm({ cpOrgId: Q.id, userId: qFounder.id, agentName: null, devOrgId: dev.id, projectId: heights.id, phone: WHOLE, buyerName: "Rahul" });
  check("another firm is refused the same buyer", !blocked.ok && blocked.tone === "risk", blocked.message);
  check("and is never told who holds them", !blocked.message.includes(P_NAME), blocked.message);
  const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM client_registrations WHERE org_id = ${dev.id}`)[0].n;
  const off = await registerForFirm({ cpOrgId: P.id, userId: pFounder.id, agentName: null, devOrgId: dev.id, projectId: greens.id, phone: "9123456780", buyerName: null });
  check("a project the firm is not empanelled on is not the firm's to try", !off.ok && off.message === "Choose a project you are empanelled on.");
  const stranger = await registerForFirm({ cpOrgId: mandateFirm.id, userId: outsider.id, agentName: null, devOrgId: dev.id, projectId: heights.id, phone: "9123456781", buyerName: null });
  check("nor a developer that does not have the firm", !stranger.ok);
  check("and neither writes a row", (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM client_registrations WHERE org_id = ${dev.id}`)[0].n === before);

  console.log("\nThe Buyers screen");
  const buyersP = await get(asP, "/dashboard/developers/buyers");
  check("lists the firm's buyer, masked", buyersP.status === 200 && buyersP.body.includes(BUYER) && buyersP.body.includes(`97XXXXXX01`), `${buyersP.status}`);
  check("and never sends the whole number", !buyersP.body.includes(WHOLE) && !buyersP.body.includes(PHONE));
  const buyersQ = await get(asQ, "/dashboard/developers/buyers?show=all");
  check("the other firm sees its refusal and not who holds the buyer", buyersQ.body.includes("Another partner holds this buyer") && !buyersQ.body.includes(P_NAME));
  check("the register form offers only projects the firm is empanelled on", (() => {
    const b = buyersP.body;
    return b.includes(HEIGHTS) && !b.includes(GREENS);
  })());
  const form = await get(asP, "/dashboard/developers/buyers?register=1");
  check("Register a buyer opens its form at the top", form.body.includes("Register buyer") && form.body.includes(`${dev.id}:${heights.id}`) && !form.body.includes(`${dev.id}:${greens.id}`));

  console.log("\nA visit for the firm's own buyer");
  const theirs = await bookForFirm({ cpOrgId: Q.id, userId: qFounder.id, devOrgId: dev.id, registrationId: reg.id, towerId: towerC.id, date: days(2), time: "16:30" });
  check("another firm cannot book the firm's buyer", !theirs.ok && theirs.message === "That buyer is not yours to book.");
  const elsewhere = await bookForFirm({ cpOrgId: P.id, userId: pFounder.id, devOrgId: dev.id, registrationId: reg.id, towerId: towerG.id, date: days(2), time: "16:30" });
  check("nor at a tower of another project", !elsewhere.ok);
  const visit = await bookForFirm({ cpOrgId: P.id, userId: pFounder.id, devOrgId: dev.id, registrationId: reg.id, towerId: towerC.id, date: days(2), time: "16:30" });
  check("the firm books its buyer's visit", visit.ok, visit.message);
  const [lead] = await sql<{ id: string; owner_id: string | null; created_by: string | null }[]>`
    SELECT l.id, l.owner_id, l.created_by FROM leads l JOIN client_registrations r ON r.lead_id = l.id WHERE r.id = ${reg.id}`;
  check("a lead is made for the claim, never owned by the partner", !!lead && lead.owner_id !== pFounder.id, JSON.stringify(lead));
  check("the booked visit shows on the buyer's row", (await get(asP, "/dashboard/developers/buyers")).body.includes("4:30 pm"));

  // The buyer's home loan, as the partner sees it: the stage, nothing else.
  await sql`
    INSERT INTO lead_loans (org_id, lead_id, stage, bank_name, amount_paise, source)
    VALUES (${dev.id}, ${lead.id}, 'SANCTIONED', 'Partnercheck Bank', 720000000, 'PERSON')`;
  check("without the developer's switch and the buyer's yes, the partner sees nothing of the loan",
    !(await get(asP, "/dashboard/developers/buyers")).body.includes("Home loan:"));
  await sql`INSERT INTO partner_settings (org_id, share_loan_stage) VALUES (${dev.id}, true)
            ON CONFLICT (org_id) DO UPDATE SET share_loan_stage = true`;
  check("the switch alone shows nothing", !(await get(asP, "/dashboard/developers/buyers")).body.includes("Home loan:"));
  await sql`UPDATE lead_loans SET partner_share = 'YES', partner_share_at = now(), partner_share_source = 'PERSON' WHERE org_id = ${dev.id} AND lead_id = ${lead.id}`;
  const loanPage = (await get(asP, "/dashboard/developers/buyers")).body;
  check("with the buyer's yes, the partner sees the stage, and never the bank or the amount",
    loanPage.includes("Home loan: sanctioned") && !loanPage.includes("Partnercheck Bank") && !loanPage.includes("72,00,000"));
  check("another firm sees nothing of it", !(await get(asQ, "/dashboard/developers/buyers?show=all")).body.includes("Home loan: sanctioned"));
  await sql`UPDATE partner_settings SET share_loan_stage = false WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM lead_loans WHERE org_id = ${dev.id} AND lead_id = ${lead.id}`;

  console.log("\nThe firm's link");
  const link = await linkForFirm({ cpOrgId: P.id, userId: pFounder.id, devOrgId: dev.id, towerId: towerC.id });
  check("is made for a tower it sells", link.ok, link.ok ? "" : link.message);
  const same = await linkForFirm({ cpOrgId: P.id, userId: pFounder.id, devOrgId: dev.id, towerId: towerC.id });
  check("and asked again is the same link", link.ok && same.ok && same.code === link.code);
  check("a tower of a project it does not sell makes none", !(await linkForFirm({ cpOrgId: P.id, userId: pFounder.id, devOrgId: dev.id, towerId: towerG.id })).ok);
  const projects = await get(asP, "/dashboard/developers");
  check("Projects shows the ladder, the empanelment and the link", link.ok && projects.body.includes(link.code) && projects.body.includes("Empanelled until") && projects.body.includes("2% on your first booking"));
  check("and nothing of the project it does not sell", !projects.body.includes(GREENS));
  check("a post the firm may not take is not found", (await fetch(`${BASE}/dashboard/developers/post/${dev.id}/${reg.id}/0`, { headers: { cookie: asP }, redirect: "manual" })).status === 404);

  console.log("\nA booking, and what the firm is owed");
  await sql`
    UPDATE leads SET stage = 'booked', path_stage = 'booked',
      facts = ${sql.json({ unit: "C-1101", agreement: "10000000", bookedOn: today, token: "100000" })}
    WHERE id = ${lead.id}`;
  const booked = await onBooked({ orgId: dev.id, userId: devAdmin.id, leadId: lead.id });
  check("the booking writes the firm's payout", !!booked);
  const dates = await recordBookingDates({ orgId: dev.id, userId: devAdmin.id, payoutId: booked!.payoutId, agreementRegisteredOn: today, collectedOn: null, today });
  check("the agreement is registered, so the first half is owed", dates.ok, dates.message);
  const payouts = await get(asP, "/dashboard/developers/payouts");
  check("Payouts names the booking and asks for the invoice", payouts.status === 200 && payouts.body.includes(BUYER) && payouts.body.includes("Send your invoice") && payouts.body.includes("Not due yet"), `${payouts.status}`);
  check("with the amount after TDS, and the gross to invoice", payouts.body.includes("Rs 1,16,000") && payouts.body.includes("Rs 1,18,000"), payouts.body.match(/Rs [\d,]+/g)?.slice(0, 8).join(" "));
  const today2 = await get(asP, "/dashboard");
  check("Today asks for it too, and names no amount", today2.body.includes(`Send your invoice for ${BUYER}`) && !today2.body.includes("Rs 1,18,000"));
  check("the other firm is owed nothing", !(await get(asQ, "/dashboard/developers/payouts")).body.includes(BUYER));

  console.log("\nThe firm sends its invoice from its own console");
  check("Payouts offers the invoice for the owed half, and only that half",
    payouts.body.includes(`data-invoice="${booked!.payoutId}:M1"`) && !payouts.body.includes(`data-invoice="${booked!.payoutId}:M2"`));
  const [m1] = await sql<{ id: string; gross: string }[]>`SELECT id, gross FROM payout_milestones WHERE payout_id = ${booked!.payoutId} AND key = 'M1'`;
  const pdf = Buffer.from("%PDF-1.4\n% brokerage invoice\n");
  const invoice = (over: Partial<Parameters<typeof fileInvoiceForFirm>[0]>) =>
    fileInvoiceForFirm({
      firmOrgId: P.id, userId: pFounder.id, kind: "PARTNER", devOrgId: dev.id, payoutId: booked!.payoutId, key: "M1",
      invoiceNo: `SK/26-27/${n4}`, invoiceDate: today, amount: Number(m1.gross), bytes: pdf, mediaType: "application/pdf", today, ...over,
    });
  check("the other firm cannot invoice the firm's booking", (await invoice({ firmOrgId: Q.id, userId: qFounder.id })).message === "That booking is not yours to invoice.");
  check("nor can a company the developer does not have", !(await invoice({ firmOrgId: mandateFirm.id, userId: outsider.id })).ok);
  check("a half not yet owed is refused", (await invoice({ key: "M2" })).message === "This half is not owed yet.");
  check("a file that is not a PDF or a picture is refused", !(await invoice({ mediaType: "text/html" })).ok);
  const sentInv = await invoice({});
  check("the firm sends its invoice for the owed half", sentInv.ok && sentInv.message.startsWith("Invoice sent to the developer"), sentInv.message);
  const [filed] = await sql<{ cp_org_id: string; uploaded_by: string; attested_by: string | null; storage_key: string; stage: string }[]>`
    SELECT i.cp_org_id, i.uploaded_by, i.attested_by, i.storage_key, m.stage FROM partner_invoices i JOIN payout_milestones m ON m.id = i.milestone_id
    WHERE i.org_id = ${dev.id} AND i.milestone_id = ${m1.id}`;
  check("it lands in the developer's tenant as the desk's filing does, confirmed by the firm that sent it",
    filed?.cp_org_id === P.id && filed.uploaded_by === pFounder.id && filed.attested_by === pFounder.id && filed.stage === "INVOICED" && filed.storage_key.startsWith(`org/${dev.id}/`) && filed.storage_key.includes("/invoice/"), JSON.stringify(filed));
  check("a second invoice for the same half is refused", (await invoice({})).message === "Your invoice for this half is already with the developer.");
  const verified = await moveMilestone({ orgId: dev.id, userId: devAdmin.id, milestoneId: m1.id, move: { kind: "verify" }, today });
  check("the developer verifies it as it verifies any invoice", verified.ok, verified.message);
  const afterPay = await get(asP, "/dashboard/developers/payouts");
  check("and the firm reads it as with the developer, with nothing left to send", afterPay.body.includes("Being approved") && !afterPay.body.includes("data-invoice="));
  check("the invoice to send is off Today", !(await get(asP, "/dashboard")).body.includes(`Send your invoice for ${BUYER}`));

  console.log("\nOne of the partner's own leads, registered with the developer");
  const ownEntity = await node(P.id, pRoot, "ENTITY", `Wadia Homes LLP ${tag}`, "wadia");
  const ownProject = await node(P.id, ownEntity, "PROJECT", `Heights ${tag}`, "heights");
  const ownTower = await node(P.id, ownProject, "PHASE", "Tower C", "tower_c");
  const OWN_BUYER = `Kavita Deshpande ${tag}`;
  const OWN_PHONE = `+9197${n4}1102`;
  const [ownLead] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, automation)
    VALUES (${P.id}, ${ownTower.id}, ${OWN_BUYER}, ${OWN_PHONE}, 'Meta ads', 'PAUSED') RETURNING id`;
  const leadPage = await get(asP, `/dashboard/leads/${ownLead.id}`);
  check("the lead's page offers the developers that empanelled the partner", leadPage.status === 200 && leadPage.body.includes("Registered with developers") && leadPage.body.includes(`${HEIGHTS} · ${DEV}`), `${leadPage.status}`);
  const ownReg = await registerLeadForFirm({ cpOrgId: P.id, userId: pFounder.id, agentName: null, leadId: ownLead.id, devOrgId: dev.id, projectId: heights.id, mayRead: () => true });
  check("registers it by its own number and name", ownReg.ok && ownReg.tone === "ok", ownReg.message);
  const held = await registrationsForPhone(P.id, OWN_PHONE);
  check("and the lead now says where it is registered", held.length === 1 && held[0].state === "registered" && held[0].project === HEIGHTS);
  const [devRow] = await sql<{ buyer_name: string | null; phone: string }[]>`
    SELECT buyer_name, phone FROM client_registrations WHERE org_id = ${dev.id} AND cp_org_id = ${P.id} AND phone = ${OWN_PHONE}`;
  check("the developer holds the claim under the lead's name", devRow?.buyer_name === OWN_BUYER);
  check("a lead the person may not read is not registered",
    !(await registerLeadForFirm({ cpOrgId: P.id, userId: pFounder.id, agentName: null, leadId: ownLead.id, devOrgId: dev.id, projectId: heights.id, mayRead: () => false })).ok);
  check("nor another company's lead",
    !(await registerLeadForFirm({ cpOrgId: Q.id, userId: qFounder.id, agentName: null, leadId: ownLead.id, devOrgId: dev.id, projectId: heights.id, mayRead: () => true })).ok);

  console.log("\nThe firm's own ads carry its agent registration");
  const ownNode = { id: ownTower.id, path: ownTower.path, kind: "PHASE" };
  const mats = await loadMaterials(P.id, ownNode);
  check("the firm's own post carries its agent number beside the project's", mats.agentNo === "A51900012873" && !mats.agentGap);
  check("in the small print every frame, reel and film sets, led by whose ad it is",
    (smallPrintFor(mats, true, null) ?? "").startsWith(`Marketed by ${mats.brandName}. Agent RERA No. A51900012873.`), smallPrintFor(mats, true, null) ?? "");
  check("and it is not refused for it", registrationGap(mats)?.code !== "NO_AGENT_RERA");
  const devMats = await loadMaterials(dev.id, { id: towerC.id, path: towerC.path, kind: "PHASE" });
  check("a developer's post carries none", devMats.agentNo === null && !(smallPrintFor(devMats, true, null) ?? "").includes("Agent RERA"));
  await sql`UPDATE firm_profiles SET rera_valid_till = ${days(-1)} WHERE org_id = ${P.id}`;
  const lapsedMats = await loadMaterials(P.id, ownNode);
  check("a lapsed agent registration refuses the firm's post before anything is paid for",
    registrationGap(lapsedMats)?.code === "NO_AGENT_RERA" && /lapsed/.test(registrationGap(lapsedMats)?.message ?? ""));
  await sql`UPDATE firm_profiles SET rera_valid_till = ${days(400)} WHERE org_id = ${P.id}`;

  console.log("\nIts people and its record");
  check("Team is the console's own", (await get(asP, "/dashboard/team")).body.includes(pFounder.email));
  const devsAgain = await get(asP, "/dashboard/developers");
  check("Developers says who is on the developer's WhatsApp for it", devsAgain.body.includes(`On ${DEV}`) && devsAgain.body.includes("98XXXXXX27"));
  check("the firm's record is its own", (await get(asP, "/dashboard/settings/firm")).body.includes("A51900012873"));

  console.log("\nA developer's project in the partner's own console");
  await sql`INSERT INTO entity_details (scope_node_id, org_id, pan, registered_address) VALUES (${entity.id}, ${dev.id}, 'AAPFU0939F', 'Baner Road, Pune')`;
  const [bv] = await sql<{ id: string }[]>`
    INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by) VALUES (${dev.id}, ${heights.id}, 1, 'DRAFT', ${devAdmin.id}) RETURNING id`;
  await sql`INSERT INTO brain_fields (brain_version_id, org_id, field_key, value) VALUES (${bv.id}, ${dev.id}, 'claims.location', ${`Baner ${tag}`})`;
  await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_by = ${devAdmin.id}, published_at = now() WHERE id = ${bv.id}`;
  check("a project the partner is not empanelled on is refused",
    !(await addDeveloperProject({ cpOrgId: P.id, userId: pFounder.id, devOrgId: dev.id, devProjectId: greens.id })).ok);
  const noPlan = await addDeveloperProject({ cpOrgId: P.id, userId: pFounder.id, devOrgId: dev.id, devProjectId: heights.id });
  check("it needs the partner's own plan, like any project of its own", !noPlan.ok && /plan/.test(noPlan.message), JSON.stringify(noPlan));
  await sql`INSERT INTO billing_accounts (org_id) VALUES (${P.id}) ON CONFLICT (org_id) DO NOTHING`;
  await sql`
    INSERT INTO subscriptions (org_id, project_id, scope, plan, status, cycle, starts_on, terms)
    VALUES (${P.id}, NULL, 'ORG', 'LAUNCH', 'ACTIVE', 'MONTHLY', ${today}, ${sql.json(termsFor("LAUNCH", "ORG") as never)})`;
  const addedP = await addDeveloperProject({ cpOrgId: P.id, userId: pFounder.id, devOrgId: dev.id, devProjectId: heights.id });
  check("the partner adds the developer's project it is empanelled on", addedP.ok && addedP.added, JSON.stringify(addedP));
  const againP = await addDeveloperProject({ cpOrgId: P.id, userId: pFounder.id, devOrgId: dev.id, devProjectId: heights.id });
  check("adding it twice opens the first", againP.ok && !againP.added && addedP.ok && againP.projectId === addedP.projectId);
  const [linkedTower] = await sql<{ id: string; name: string }[]>`
    SELECT n.id, n.name FROM linked_nodes l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${P.id} AND l.source_node_id = ${towerC.id}`;
  check("its tower is made under the developer's name and linked", linkedTower?.name === "Tower C");
  const [pEntity] = await sql<{ name: string }[]>`
    SELECT e.name FROM scope_nodes p JOIN scope_nodes r ON r.id = p.parent_id JOIN scope_nodes e ON e.id = r.parent_id
    WHERE p.id = ${addedP.ok ? addedP.projectId : null}`;
  check("filed under the promoter of record, so the registration matches", pEntity?.name === "Wadia Homes LLP");
  const gateP = await canPublish(P.id, linkedTower.id);
  check("the partner's tower may be advertised on the developer's registration", gateP.ok && gateP.registrationNo === "P52100012345", JSON.stringify(gateP));
  check("it says what the developer signed", (await resolveBrain(P.id, linkedTower.id))?.values["claims.location"] === `Baner ${tag}`);
  // The developer's own approved picture and flat, made through the app with the store in memory.
  const memStore = new Map<string, Buffer>();
  useStorage({
    name: "memory",
    async put(key, bytes) { memStore.set(key, Buffer.from(bytes)); },
    async signedUrl(key) { return `memory://${key}`; },
    async remove(key) { memStore.delete(key); },
    async copy(from, to) { const b = memStore.get(from); if (b) memStore.set(to, Buffer.from(b)); },
    async read(key) { const b = memStore.get(key); return b ? Buffer.from(b) : null; },
  });
  const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 40, g: 90, b: 160 } } })
    .composite([{ input: Buffer.from(`<svg width="640" height="480"><rect x="80" y="60" width="200" height="380" fill="#ddd"/><circle cx="480" cy="140" r="70" fill="#f5c542"/></svg>`), top: 0, left: 0 }])
    .png().toBuffer();
  const pic = await addAsset({ orgId: dev.id, actorUserId: devAdmin.id, nodeId: towerC.id, category: "EXTERIOR_RENDER", title: `Dusk ${tag}`, isRender: true, capturedOn: null, media: { bytes: png, type: "image/png", name: "dusk.png" } });
  if (pic.ok) await approveAsset({ orgId: dev.id, actorUserId: devAdmin.id, assetId: pic.assetId });
  const flat = await addUnitType({ orgId: dev.id, actorUserId: devAdmin.id, nodeId: towerC.id, config: "2BHK", variant: null, carpetAreaSqft: 682, balconyAreaSqft: null, startingPrice: 21_900_000 });
  if (flat.ok) await approveUnitType({ orgId: dev.id, actorUserId: devAdmin.id, unitTypeId: flat.unitTypeId });
  useStorage(null);
  const picsP = await approvedAssets(P.id, linkedTower.id);
  const theirPic = picsP.find((a) => pic.ok && a.id === pic.assetId);
  check("the developer's approved picture is the partner's to build from, placed on its tower", !!theirPic && theirPic.nodeId === linkedTower.id && theirPic.sourceOrgId === dev.id, JSON.stringify({ pic, n: picsP.length }));
  const flatsP = await approvedUnits(P.id, linkedTower.id);
  check("and its approved flat, priced as the developer approved it", flat.ok && flatsP.units.some((u) => u.id === flat.unitTypeId));
  await new Promise((r) => setTimeout(r, 6_000));
  const libPage = await get(asP, `/dashboard/library/${linkedTower.id}`);
  check("the partner's library shows the developer's picture and flat, approved by the developer",
    libPage.body.includes(`Dusk ${tag}`) && libPage.body.includes(`Approved by ${DEV}`) && libPage.body.includes("2 BHK"));
  const tile = pic.ok ? await fetch(`${BASE}/dashboard/library/${linkedTower.id}/file/${pic.assetId}`, { headers: { cookie: asP }, redirect: "manual" }) : null;
  check("and opens the picture for the partner", tile?.status === 302 || tile?.status === 307 || tile?.status === 200, String(tile?.status));
  const notP = pic.ok ? await fetch(`${BASE}/dashboard/library/${linkedTower.id}/file/${pic.assetId}`, { headers: { cookie: asQ }, redirect: "manual" }) : null;
  check("never for another partner", notP?.status === 404, String(notP?.status));
  const [briefP] = await sql<{ id: string }[]>`
    INSERT INTO campaign_briefs (org_id, scope_node_id, name, status) VALUES (${P.id}, ${linkedTower.id}, ${`Push ${tag}`}, 'DRAFT') RETURNING id`;
  const savedP = await saveBrief({
    orgId: P.id, actorUserId: pFounder.id, briefId: briefP.id,
    input: { name: `Push ${tag}`, objective: null, audience: null, microMarkets: null, languages: ["en"], formats: [], unitTypeIds: [flat.ok ? flat.unitTypeId : "", "00000000-0000-4000-8000-000000000000"], cta: null, hook: null, offers: null },
  });
  const [keptP] = await sql<{ unit_type_ids: string[] }[]>`SELECT unit_type_ids FROM campaign_briefs WHERE id = ${briefP.id}`;
  check("a brief on it narrows to the developer's flat, and keeps no id that is not one",
    savedP.ok && flat.ok && keptP.unit_type_ids.length === 1 && keptP.unit_type_ids[0] === flat.unitTypeId, JSON.stringify(keptP));
  const draftP = await openDraft({ orgId: P.id, actorUserId: pFounder.id, nodeId: linkedTower.id });
  check("the partner cannot write its own facts there", !draftP.ok && draftP.code === "LINKED");
  const regP = await recordRegistration({ orgId: P.id, actorUserId: pFounder.id, phaseId: linkedTower.id, stateCode: "MH", registrationNo: "P52100099999", promoterName: "Wadia Homes LLP", validTo: days(300), reason: "check" });
  check("nor a registration of its own", !regP.ok && regP.code === "LINKED");
  const readyP = (await loadReadiness(P.id)).find((r) => r.phaseId === linkedTower.id);
  check("Today counts it registered", readyP?.gates.find((g) => g.key === "registered")?.state === "done", JSON.stringify(readyP?.gates));
  await new Promise((r) => setTimeout(r, 6_000));
  const projPage = await get(asP, `/dashboard/projects/${addedP.ok ? addedP.projectId : ""}`);
  check("its page says whose it is, with the developer's registration", projPage.body.includes(`From ${DEV}`) && projPage.body.includes("P52100012345"));
  const brainPage = await get(asP, `/dashboard/brain/${linkedTower.id}`);
  check("its facts read as the developer's, with nothing to edit", brainPage.body.includes(`Baner ${tag}`) && brainPage.body.includes(`Only ${DEV} can change them`) && !brainPage.body.includes("Set it up"));
  await sql`UPDATE grants SET status = 'ENDED' WHERE org_id = ${dev.id} AND grantee_org_id = ${P.id}`;
  forgetLinks(P.id);
  const endedP = await canPublish(P.id, linkedTower.id);
  check("the day the empanelment ends, the partner's tower stops being advertisable", !endedP.ok);
  check("and says nothing about the building", (await resolveBrain(P.id, linkedTower.id))?.values["claims.location"] !== `Baner ${tag}`);
  await sql`UPDATE grants SET status = 'ACTIVE' WHERE org_id = ${dev.id} AND grantee_org_id = ${P.id}`;
  forgetLinks(P.id);

  console.log("\nA developer not on Sales Desk: registrations by email and the partner's own invoices");
  const mails: { to: string; subject: string; text: string; cc?: string[]; replyTo?: string[] }[] = [];
  useMailer(async (m) => {
    mails.push(m);
    return { ok: true, messageId: `msg-${mails.length}` };
  });
  const offEntity = await node(P.id, pRoot, "ENTITY", `Kumar Builders ${tag}`, "kumar");
  const offRegion = await node(P.id, offEntity, "REGION", "Pune", "pune");
  const offProject = await node(P.id, offRegion, "PROJECT", `Kumar Park ${tag}`, "kumar_park");
  const noSetup = await registerOutside({ orgId: P.id, userId: pFounder.id, projectId: offProject.id, name: "Asha Rao", phone: "98200 11223", mayRegisterAt: () => true });
  check("a developer with nowhere to send registrations is refused, naming what to add", !noSetup.ok && /email/.test(noSetup.message));
  const badSetup = await saveSetup({ orgId: P.id, userId: pFounder.id, entityId: offEntity.id, raw: { regEmail: "not an email", rate: "2" } });
  check("the setup names a bad address", !badSetup.ok && !!badSetup.errors?.regEmail);
  const setup = await saveSetup({ orgId: P.id, userId: pFounder.id, entityId: offEntity.id, raw: { regEmail: `cp.desk@kumar${tag}.example`, regCc: `rm@kumar${tag}.example`, validityDays: "45", rate: "2", gstin: gstinOf("AAPFU0939F"), billAddress: "Kumar House, FC Road, Pune 411004", stateCode: "27" } });
  check("the developer's setup is saved", setup.ok, JSON.stringify(setup));
  const regOut = await registerOutside({ orgId: P.id, userId: pFounder.id, projectId: offProject.id, name: "Asha Rao", phone: "98200 11223", mayRegisterAt: () => true, nowIso: NOW });
  check("registering a buyer emails the developer and says until when", regOut.ok && /Emailed to cp\.desk@/.test(regOut.message), JSON.stringify(regOut));
  const sentMail = mails.at(-1);
  check("the email names the buyer, the whole number, the project and the partner's agent registration",
    !!sentMail && sentMail.to === `cp.desk@kumar${tag}.example` && sentMail.text.includes("Asha Rao") && sentMail.text.includes("+91 98200 11223")
      && sentMail.text.includes(`Kumar Park ${tag}`) && sentMail.text.includes("A51900012873"), sentMail?.text ?? "");
  check("copied to the developer's other address and the partner's own person, who the reply goes to",
    !!sentMail?.cc?.includes(`rm@kumar${tag}.example`) && !!sentMail?.cc?.includes(pFounder.email) && sentMail?.replyTo?.[0] === pFounder.email);
  const twice = await registerOutside({ orgId: P.id, userId: pFounder.id, projectId: offProject.id, name: "Asha Rao", phone: "9820011223", mayRegisterAt: () => true, nowIso: NOW });
  check("the same number again is the same registration, and no second email", !twice.ok && mails.length === 1);
  const outNow = await outsideWork(P.id, today);
  const regRow = outNow.registrations[0];
  check("the list shows it masked, sent, for the developer's days", regRow?.phone === "98XXXXXX23" && regRow.state === "sent" && regRow.validUntil === days(45), JSON.stringify(regRow));
  if (regRow) check("the developer's yes is recorded", (await answerOutside({ orgId: P.id, userId: pFounder.id, id: regRow.id, answer: "CONFIRMED" })).ok);
  const bookedOut = regRow
    ? await recordOutsideBooking({ orgId: P.id, userId: pFounder.id, registrationId: regRow.id, unit: "B-1204", bookedOn: today, agreement: "1.25 Cr" })
    : { ok: false, message: "" };
  check("a booking from the registration, at the developer's rate", bookedOut.ok);
  const bk = (await outsideWork(P.id, today)).bookings[0];
  check("its brokerage is 2% of the agreement value", bk?.brokerage === 2_50_000_00 && bk.agreement === 1_25_00_000_00, JSON.stringify(bk));
  await sql`UPDATE billing_accounts SET bill_address = NULL, bill_state = NULL WHERE org_id = ${P.id}`;
  const noAddress = bk ? await makeOutsideInvoice({ orgId: P.id, userId: pFounder.id, bookingId: bk.id, today }) : { ok: false, message: "" };
  check("an invoice waits for the partner's own billing address", !noAddress.ok && /billing address/.test(noAddress.message));
  await sql`UPDATE billing_accounts SET bill_address = 'Office 4, Baner Road, Pune 411045', bill_state = '27' WHERE org_id = ${P.id}`;
  const inv = bk ? await makeOutsideInvoice({ orgId: P.id, userId: pFounder.id, bookingId: bk.id, today }) : { ok: false, message: "" };
  check("the partner's own invoice is numbered in its own series", inv.ok && /^Invoice BRK\/\d{2}-\d{2}\/00001 made\.$/.test(inv.message), JSON.stringify(inv));
  const [invRow] = await sql<{ number: string; cgst_paise: string; sgst_paise: string; igst_paise: string; total_paise: string; tds_paise: string; description: string }[]>`
    SELECT number, cgst_paise::text, sgst_paise::text, igst_paise::text, total_paise::text, tds_paise::text, description FROM outside_invoices WHERE org_id = ${P.id}`;
  check("GST split inside one state, TDS shown, and the buyer never named on it",
    invRow?.cgst_paise === String(22_500_00) && invRow.sgst_paise === String(22_500_00) && invRow.igst_paise === "0" && invRow.total_paise === String(2_95_000_00)
      && invRow.tds_paise === String(5_000_00) && !invRow.description.includes("Asha"), JSON.stringify(invRow));
  const invAgain = bk ? await makeOutsideInvoice({ orgId: P.id, userId: pFounder.id, bookingId: bk.id, today }) : { ok: false, message: "" };
  check("a booking is invoiced once", !invAgain.ok);
  const pdfOut = inv.ok && "invoiceId" in inv && inv.invoiceId ? await outsideInvoicePdf(P.id, inv.invoiceId) : null;
  check("the invoice is drawn as a PDF", !!pdfOut && pdfOut.pdf.subarray(0, 5).toString() === "%PDF-");
  const paidOut = inv.ok && "invoiceId" in inv && inv.invoiceId ? await recordInvoicePaid({ orgId: P.id, userId: pFounder.id, invoiceId: inv.invoiceId, paidOn: today, amount: "2,90,000", utr: "HDFC0001234567", today }) : { ok: false, message: "" };
  check("its payment is recorded with the bank's reference", paidOut.ok, JSON.stringify(paidOut));
  const paidTwice = inv.ok && "invoiceId" in inv && inv.invoiceId ? await recordInvoicePaid({ orgId: P.id, userId: pFounder.id, invoiceId: inv.invoiceId, paidOn: today, amount: "1", utr: "HDFC0001234568", today }) : { ok: true, message: "" };
  check("and once", !paidTwice.ok);
  check("another company sees none of it", (await outsideWork(Q.id, today)).registrations.length === 0);
  useMailer(null);
  const buyersPage = await get(asP, "/dashboard/developers/buyers");
  check("Registered buyers lists it masked, with the developer", buyersPage.body.includes("With developers not on Sales Desk") && buyersPage.body.includes("98XXXXXX23") && !buyersPage.body.includes("9820011223"));
  const payPage = await get(asP, "/dashboard/developers/payouts");
  check("Brokerage lists the invoice, paid", payPage.body.includes("BRK/") && payPage.body.includes("HDFC0001234567"));
  const pdfHttp = inv.ok && "invoiceId" in inv ? await fetch(`${BASE}/dashboard/developers/payouts/outside/${inv.invoiceId}`, { headers: { cookie: asP }, redirect: "manual" }) : null;
  check("and downloads it", pdfHttp?.status === 200 && pdfHttp.headers.get("content-type") === "application/pdf", String(pdfHttp?.status));
  const pdfQ = inv.ok && "invoiceId" in inv ? await fetch(`${BASE}/dashboard/developers/payouts/outside/${inv.invoiceId}`, { headers: { cookie: asQ }, redirect: "manual" }) : null;
  check("never for another company", pdfQ?.status === 404, String(pdfQ?.status));

  console.log("\nWhat the firm's session reaches");
  const nothing = await withTenant(mandateFirm.id, (sql2) => sql2<{ org_id: string }[]>`SELECT org_id FROM partner_developers_for_firm()`);
  check("a company no developer empanelled finds no developer", nothing.length === 0);
  const work = await partnerWork(Q.id);
  check("the other firm reads its own claim and none of the firm's", work.buyers.every((b) => b.refused) && work.bookings.length === 0);

  console.log("\nAsk Jimmy reads the partner's registrations and brokerage with developers");
  {
    const { answerQuestion } = await import("../src/lib/ask.ts");
    const { buildAuthz } = await import("../src/lib/rbac-rules.ts");
    const [pRoot] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${P.id} AND kind = 'ORG'`;
    const everything = buildAuthz([{ role: "ORG_ADMIN", roleLabel: "Admin", scopeNodeId: "", scopePath: pRoot.path, scopeKind: "ORG", scopeName: "", permissions: new Set(["*"]) }]);
    let script: { name: string; args: Record<string, unknown> }[][] = [];
    let n = 0;
    const brain = async (req: { tools: { name: string }[] }) => {
      const calls = req.tools.some((t) => t.name === "route")
        ? [{ name: "route", args: { kind: "data", topics: ["developers"] } }]
        : script.shift() ?? [{ name: "answer", args: { status: "cannot_answer", text: "No.", show: [], follow_ups: [] } }];
      return { ok: true as const, output: calls.map((c) => ({ type: "function_call" as const, call_id: `c${++n}`, name: c.name, arguments: JSON.stringify(c.args) })), usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 10 } };
    };
    const ask = (question: string) =>
      answerQuestion({ orgId: P.id, orgName: "Partner", orgType: "CHANNEL_PARTNER", personName: "Sagar", authz: everything, question, history: [], drivers: { brain: brain as never } });
    script = [
      [{ name: "list", args: { dataset: "my_registrations", fields: ["buyer", "developer", "project", "state"], filters: [], places: [], period: null, sort: null, limit: null } }],
      [{ name: "answer", args: { status: "answered", text: "Here are your registrations.", show: ["r1"], follow_ups: [] } }],
    ];
    const regs = await ask("Which buyers have I registered?");
    const regTable = regs.blocks.tables[0];
    const regText = JSON.stringify(regTable ?? null);
    check("a partner's Jimmy lists its registrations with a developer on Sales Desk", regs.outcome === "ANSWERED" && regText.includes(BUYER) && regText.includes("Heights"), regText.slice(0, 300));
    check("and never a phone number", !regText.includes(WHOLE));
    script = [
      [{ name: "query", args: { measures: ["brokerage_owed", "brokerage_bookings"], by: [], filters: [], places: [], period: null, sort: null, limit: null } }],
      [{ name: "answer", args: { status: "answered", text: "That is what is owed.", show: ["r1"], follow_ups: [] } }],
    ];
    const money = await ask("How much brokerage is owed to me?");
    const moneyText = JSON.stringify(money.blocks.tables[0] ?? null);
    check("and the brokerage its bookings earn", money.outcome === "ANSWERED" && /1/.test(moneyText), moneyText.slice(0, 300));
    const dev = await answerQuestion({ orgId: P.id, orgName: "Partner", orgType: "DEVELOPER", personName: "Sagar", authz: everything, question: "Which buyers have I registered?", history: [], drivers: { brain: brain as never } });
    check("a developer asking the same is never answered from a channel partner's data", dev.outcome !== "ANSWERED", dev.outcome);
  }

  // SHOTS_DIR draws the screens to PNG for a person to look at; the checks never need it.
  if (process.env.SHOTS_DIR) {
    const { default: puppeteer } = await import("puppeteer-core");
    const { existsSync } = await import("node:fs");
    const chrome = [process.env.CHROME_PATH ?? "", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((c) => existsSync(c));
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const shoot = async (u: { id: string; email: string }, orgId: string, path: string, name: string, width = 1280) => {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(120_000);
      await page.setViewport({ width, height: 900 });
      await page.setCookie(
        { name: COOKIE, value: await encode({ token: { sub: u.id, userId: u.id, email: u.email }, secret: process.env.AUTH_SECRET!, salt: COOKIE, maxAge: 900 }), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
        { name: "salesdesk.org", value: orgId, domain: "localhost", path: "/", sameSite: "Lax" },
      );
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0" });
      await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png`, fullPage: true });
      await ctx.close();
    };
    await shoot(pFounder, P.id, "/dashboard", "cp-today");
    await shoot(pFounder, P.id, "/dashboard/developers", "cp-developers");
    await shoot(pFounder, P.id, "/dashboard/developers/buyers", "cp-buyers");
    await shoot(pFounder, P.id, "/dashboard/developers/buyers?register=1", "cp-register");
    await shoot(pFounder, P.id, "/dashboard/developers/payouts", "cp-payouts");
    await shoot(pFounder, P.id, `/dashboard/leads/${ownLead.id}`, "cp-lead");
    await shoot(qFounder, Q.id, "/dashboard/developers/buyers?show=all", "cp-other-firm");
    await shoot(pFounder, P.id, "/dashboard", "cp-today-phone", 390);
    await shoot(pFounder, P.id, "/dashboard/developers/buyers", "cp-buyers-phone", 390);
    await browser.close();
  }
} finally {
  await sql`DELETE FROM partner_invoices WHERE org_id = ${dev.id}`;
  await sql`ALTER TABLE payout_milestones DISABLE TRIGGER payout_milestones_forward_only`;
  await sql`DELETE FROM payout_milestones WHERE org_id = ${dev.id}`;
  await sql`ALTER TABLE payout_milestones ENABLE TRIGGER payout_milestones_forward_only`;
  await sql`DELETE FROM partner_payouts WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM partner_links WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM visit_slots WHERE org_id = ${dev.id}`.catch(() => {});
  await sql`DELETE FROM lead_tasks WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM messages WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM lead_activity WHERE org_id = ${dev.id}`.catch(() => {});
  await sql`UPDATE client_registrations SET extended_by_visit = NULL WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM site_visits WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM client_registrations WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM grants WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM partner_agents WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM partner_firms WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM commission_terms WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM outcome_events WHERE org_id = ${dev.id}`.catch(() => {});
  await sql`DELETE FROM leads WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM leads WHERE org_id = ${P.id}`;
  await sql`DELETE FROM registration_records WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM brain_versions WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM campaign_briefs WHERE org_id = ${P.id}`;
  await sql`DELETE FROM outside_invoices WHERE org_id = ${P.id}`;
  await sql`DELETE FROM audit_log WHERE org_id = ANY(${made.orgs})`;
  await sql`DELETE FROM orgs WHERE id = ANY(${made.orgs})`;
  await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
