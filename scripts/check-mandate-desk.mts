/**
 * A mandate firm working a developer's projects, end to end.
 *
 * A developer and a mandate firm of their own, built here and removed at the
 * end. The firm holds a live mandate on one of two projects. Its people open
 * the developer's console through the mandate and see that project and
 * nothing else of the developer's; they run a desk of their own channel
 * partners, on their own ladder, and pay them; the developer's desk and the
 * firm's never see each other's partners. Ending the mandate ends the
 * firm's partners with it, and the developer may then take one on.
 *
 * The screens are read over HTTP from the dev server, signed in as the
 * firm's people, so what a page SENDS is what is judged.
 */
import postgres from "postgres";
import { encode } from "next-auth/jwt";
import { closeDb, withTenant } from "../src/lib/db/index.ts";
import { answerMandate, changeMandate, offerMandate, useMandateMail } from "../src/lib/mandates.ts";
import { deskOf, empanelFirm, findRegistrations, grantProjects, loadDesk, mandateFor, moveMilestone, onBooked, readFirm, recordBookingDates, registerBuyer, saveTerms } from "../src/lib/partners.ts";
import { fileInvoiceForFirm } from "../src/lib/partner-workspace.ts";
import { firmAgentFor } from "../src/lib/firm-agent.ts";
import { gstinCheckDigit } from "../src/lib/gstin.ts";
import { ist } from "../src/lib/cadence-rules.ts";
import type { Mail } from "../src/lib/mailer.ts";

const BASE = process.env.AUTH_URL ?? "http://localhost:3000";
const COOKIE = "authjs.session-token";
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "none";
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  }
};

const mails: Mail[] = [];
const mail = useMandateMail(async (m) => {
  mails.push(m);
  return { ok: true, messageId: `m-${mails.length}` };
});

// ---------------------------------------------------------------------------
// A developer, a mandate firm, and the people in each
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const n4 = String(Date.now() % 10000).padStart(4, "0");
const FIRM_PAN = `AAAFD${n4}G`;
const NET_PAN = `AAAFE${n4}H`;
const OWN_PAN = `AAAFF${n4}J`;
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
const devAdmin = await user(`admin@dev${tag}.example`, "Dev Admin");
const founder = await user(`ramesh@firm${tag}.example`, "Ramesh Kulkarni");
const rm = await user(`neha@firm${tag}.example`, `Neha ${tag}`);

const [dev] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
  VALUES ('DEVELOPER', 'Desk Developers', ${`Desk Developers ${tag}`}, 'AAPFU0939F', ${`dev${tag}.example`}, ${devAdmin.id}) RETURNING id`;
made.orgs.push(dev.id);
const node = async (org: string, parent: { id: string; path: string } | null, kind: string, name: string, slug: string) => {
  const path = parent ? `${parent.path}.${slug}` : slug;
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org}, ${parent?.id ?? null}, ${kind}, ${name}, ${slug}, ${path}::ltree) RETURNING id, path::text AS path`;
  return row;
};
const root = await node(dev.id, null, "ORG", "Desk Developers", `ddev_${tag}`);
const entity = await node(dev.id, root, "ENTITY", "Desk Developers LLP", "spv");
const region = await node(dev.id, entity, "REGION", "Pune", "pune");
const HEIGHTS = `Heights ${tag}`;
const GREENS = `Greens ${tag}`;
const heights = await node(dev.id, region, "PROJECT", HEIGHTS, "heights");
const towerC = await node(dev.id, heights, "PHASE", "Tower C", "tower_c");
const greens = await node(dev.id, region, "PROJECT", GREENS, "greens");
const towerG = await node(dev.id, greens, "PHASE", "Tower G", "tower_g");
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${devAdmin.id}, ${dev.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;

const FIRM_NAME = `Guardians ${tag}`;
const [firm] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, gstin, primary_domain, created_by, status)
  VALUES ('MANDATE_FIRM', 'Guardians Advisory LLP', ${FIRM_NAME}, ${FIRM_PAN}, ${gstinOf(FIRM_PAN)}, ${`firm${tag}.example`}, ${founder.id}, 'ACTIVE') RETURNING id`;
made.orgs.push(firm.id);
const firmRoot = await node(firm.id, null, "ORG", FIRM_NAME, `dfirm_${tag}`);
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${founder.id}, ${firm.id}, ${firmRoot.id}, 'ORG_ADMIN', 'ACTIVE')`;
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${rm.id}, ${firm.id}, ${firmRoot.id}, 'CP_RELATIONSHIP_MANAGER', 'ACTIVE')`;
await sql`INSERT INTO firm_profiles (org_id, rera_agent_no, rera_valid_till, city) VALUES (${firm.id}, 'A51700001835', ${days(400)}, 'Pune')`;

const lead = async (phaseId: string, name: string, phone: string, stage = "new") => {
  const [l] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, stage, path_stage, facts)
    VALUES (${dev.id}, ${phaseId}, ${name}, ${phone}, 'Website', ${stage}, ${stage},
            ${sql.json(stage === "booked" ? { unit: "C-1101", agreement: "10000000", bookedOn: today, token: "100000" } : {})})
    RETURNING id`;
  return l.id;
};
const HEIGHTS_BUYER = `Asha Heights ${tag}`;
const GREENS_BUYER = `Vikram Greens ${tag}`;
const heightsLead = await lead(towerC.id, HEIGHTS_BUYER, "+919811100001");
const greensLead = await lead(towerG.id, GREENS_BUYER, "+919811100002");

const session = async (u: { id: string; email: string }, orgId: string) =>
  `${COOKIE}=${await encode({ token: { sub: u.id, userId: u.id, email: u.email }, secret: process.env.AUTH_SECRET!, salt: COOKIE, maxAge: 900 })}; salesdesk.org=${orgId}`;
const get = async (cookie: string, path: string) => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(120_000) });
  return { status: res.status, location: res.headers.get("location") ?? "", body: await res.text() };
};
/** A page the person may not open: a redirect, however Next delivers it, or the not-found screen. */
const through = (body: string) => body.replace(/<!-- -->/g, "").includes(`Through ${FIRM_NAME}`);
const refused = (r: { status: number; location: string; body: string }) =>
  [302, 303, 307, 308, 404].includes(r.status) || /NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|http-equiv="refresh"/.test(r.body);

try {
  console.log("\nThe firm holds a live mandate on one of two projects");
  const offered = await offerMandate({
    orgId: dev.id,
    userId: devAdmin.id,
    input: { pan: FIRM_PAN, firmName: FIRM_NAME, contactName: "Ramesh", contactEmail: founder.email, rate: 0.03, projectIds: [heights.id], validTo: days(200) },
  });
  const mandateId = offered.ok ? offered.id : "";
  const accepted = await answerMandate({ firmOrgId: firm.id, userId: founder.id, mandateId, accept: true });
  check("offered and accepted", offered.ok && accepted.ok, offered.ok ? accepted.message : offered.message);
  const desk = { kind: "MANDATE" as const, mandateIds: [mandateId] };
  const own = { kind: "OWN" as const };
  const lastDay = (await mandateFor(dev.id, desk, [heights.id]));
  check("the mandate covers its project, and says its last day", lastDay.ok && lastDay.mandateId === mandateId && lastDay.lastDay === days(200), JSON.stringify(lastDay));
  check("and not the other project", !(await mandateFor(dev.id, desk, [greens.id])).ok);
  check("the developer's own desk works under no mandate", JSON.stringify(await mandateFor(dev.id, own, [greens.id])) === JSON.stringify({ ok: true, mandateId: null, lastDay: null }));

  console.log("\nThe firm empanels a partner of its own");
  const netForm = readFirm({ name: `Keystone ${tag}`, legalName: "Keystone Realty LLP", pan: NET_PAN, gstin: gstinOf(NET_PAN), reraNo: "A51700001836", reraTill: days(300), principalName: "Sagar Kale", principalPhone: "98765 10001" });
  if (!netForm.ok) throw new Error("net form");
  const net = await empanelFirm({ orgId: dev.id, userId: founder.id, firm: netForm.firm, rmId: rm.id, rmChoices: [founder.id, rm.id], projectIds: [heights.id], validTo: days(150), mandateId });
  check("empanelled on the mandated project", net.ok, net.ok ? "" : net.message);
  const netId = net.ok ? net.firmId : "";
  const [nf] = await sql<{ mandate_id: string | null; rm_id: string | null; cp_org_id: string }[]>`SELECT mandate_id, rm_id, cp_org_id FROM partner_firms WHERE id = ${netId}`;
  made.orgs.push(nf.cp_org_id);
  check("on the firm's desk, looked after by the firm's own person", nf.mandate_id === mandateId && nf.rm_id === rm.id);
  const [ng] = await sql<{ id: string; mandate_id: string | null }[]>`SELECT id, mandate_id FROM grants WHERE grantee_org_id = ${nf.cp_org_id} AND org_id = ${dev.id}`;
  check("its grant names the mandate", ng?.mandate_id === mandateId);
  check("a grant outside the mandated project is refused by the database",
    (await codeOf(withTenant(dev.id, (tx) => tx`
      INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_from, valid_to, mandate_id)
      VALUES (${dev.id}, ${nf.cp_org_id}, ${greens.id}, 'CHANNEL_PARTNER', now(), now() + interval '10 days', ${mandateId})`))) === "23514");
  check("and one that outlasts the mandate",
    (await codeOf(withTenant(dev.id, (tx) => tx`UPDATE grants SET valid_to = now() + interval '400 days' WHERE id = ${ng.id}`))) === "23514");
  check("a partner's desk does not move while its mandate is live",
    (await codeOf(withTenant(dev.id, (tx) => tx`UPDATE partner_firms SET mandate_id = NULL WHERE id = ${netId}`))) === "23514");

  const ownForm = readFirm({ name: `Horizon ${tag}`, legalName: "Horizon Homes LLP", pan: OWN_PAN, reraNo: "A51700001837", reraTill: days(300), principalName: "Meera Joshi", principalPhone: "98765 10002" });
  if (!ownForm.ok) throw new Error("own form");
  const ownFirm = await empanelFirm({ orgId: dev.id, userId: devAdmin.id, firm: ownForm.firm, rmId: null, projectIds: [heights.id, greens.id], validTo: days(365) });
  check("the developer empanels a partner of its own on both projects", ownFirm.ok);
  const ownId = ownFirm.ok ? ownFirm.firmId : "";
  made.orgs.push((await sql<{ cp_org_id: string }[]>`SELECT cp_org_id FROM partner_firms WHERE id = ${ownId}`)[0].cp_org_id);
  const dup = await empanelFirm({ orgId: dev.id, userId: devAdmin.id, firm: netForm.firm, rmId: null, projectIds: [heights.id], validTo: days(100) });
  check("the developer cannot empanel the firm's partner too: one payer per partner", !dup.ok && dup.message.includes("another desk"), dup.ok ? "" : dup.message);
  const dup2 = await empanelFirm({ orgId: dev.id, userId: founder.id, firm: ownForm.firm, rmId: null, projectIds: [heights.id], validTo: days(100), mandateId });
  check("nor the firm the developer's", !dup2.ok);
  check("each row says whose desk it is on",
    [(await deskOf(dev.id, "firm", netId))?.mandateId, (await deskOf(dev.id, "firm", ownId))?.mandateId, (await deskOf(dev.id, "grant", ng.id))?.mandateId].join("|") === `${mandateId}||${mandateId}`);

  console.log("\nIts own ladder, and a buyer it brings");
  const terms = await saveTerms({ orgId: dev.id, userId: founder.id, projectId: heights.id, mandateId, terms: { steps: [{ from: 1, rate: 0.01 }], passBackMax: 0, registrationDays: 30, visitExtendsDays: 30 } });
  check("the firm sets its partners' commission on the project", terms.ok, terms.message);
  const firmDesk = await loadDesk({ orgId: dev.id, partnerScopes: [heights.path], payoutScopes: [heights.path], unmaskScopes: [], desk, people: [{ id: founder.id, name: "Ramesh" }, { id: rm.id, name: "Neha" }] });
  const devDesk = await loadDesk({ orgId: dev.id, partnerScopes: [root.path], payoutScopes: [root.path], unmaskScopes: [] });
  check("the firm's desk shows its partner and only the mandated project",
    firmDesk.firms.map((f) => f.name).join() === `Keystone ${tag}` && firmDesk.projects.map((p) => p.name).join() === HEIGHTS, JSON.stringify(firmDesk.firms.map((f) => f.name)));
  check("with the firm's ladder and the mandate's last day", firmDesk.projects[0]?.terms.steps[0]?.rate === 0.01 && firmDesk.projects[0]?.until === days(200), JSON.stringify(firmDesk.projects[0]));
  check("the developer's desk shows its own partner and not the firm's", devDesk.firms.map((f) => f.name).join() === `Horizon ${tag}`, JSON.stringify(devDesk.firms.map((f) => f.name)));
  check("and keeps the developer's own ladder", devDesk.projects.find((p) => p.id === heights.id)?.terms.steps[0]?.rate === 0.02);
  check("a partner's person is named on the developer's side", (await withTenant(dev.id, (tx) => tx<{ name: string }[]>`SELECT name FROM users WHERE id = ${rm.id}`))[0]?.name === `Neha ${tag}`);

  const reg = await registerBuyer({ orgId: dev.id, userId: rm.id, firmId: netId, projectId: heights.id, phone: "98111 00009", buyerName: "Nitin", via: "CONSOLE" });
  check("the firm's partner registers a buyer", reg.ok && reg.verdict === "REGISTERED", reg.message);
  check("a number is found on the desk that holds it, and not on the other",
    (await findRegistrations(dev.id, "9811100009", [root.path], desk)).length === 1 && (await findRegistrations(dev.id, "9811100009", [root.path], own)).length === 0);
  const booked = await lead(towerC.id, "Nitin", "+919811100009", "booked");
  await onBooked({ orgId: dev.id, userId: devAdmin.id, leadId: booked });
  const pays = await sql<{ id: string; kind: string; rate: string; payer_mandate_id: string | null }[]>`
    SELECT id, kind, rate, payer_mandate_id FROM partner_payouts WHERE lead_id = ${booked} ORDER BY kind`;
  const partnerPay = pays.find((p) => p.kind === "PARTNER");
  const mandatePay = pays.find((p) => p.kind === "MANDATE");
  check("the booking pays the partner on the firm's ladder, paid by the firm", Number(partnerPay?.rate) === 0.01 && partnerPay?.payer_mandate_id === mandateId, JSON.stringify(pays));
  check("and earns the firm its own commission from the developer", Number(mandatePay?.rate) === 0.03 && mandatePay?.payer_mandate_id === null);
  const firmDesk2 = await loadDesk({ orgId: dev.id, partnerScopes: [heights.path], payoutScopes: [heights.path], unmaskScopes: [], desk, people: [] });
  const devDesk2 = await loadDesk({ orgId: dev.id, partnerScopes: [root.path], payoutScopes: [root.path], unmaskScopes: [] });
  check("the firm's payouts are what it pays its partner", firmDesk2.bookings.map((b) => b.id).join() === partnerPay?.id);
  check("the developer's are what it pays the firm", devDesk2.bookings.map((b) => b.id).join() === mandatePay?.id);
  check("each payout is on one desk", (await deskOf(dev.id, "payout", partnerPay!.id))?.mandateId === mandateId && (await deskOf(dev.id, "payout", mandatePay!.id))?.mandateId === null);
  const owedToFirm = await withTenant(firm.id, (tx) => tx<{ payout_id: string; halves: { owed: boolean }[] }[]>`SELECT payout_id, halves FROM mandate_payouts_for_firm()`);
  check("the firm reads what the developer owes it, and nothing else", owedToFirm.length === 1 && owedToFirm[0].payout_id === mandatePay?.id && owedToFirm[0].halves.every((h) => h.owed === false));

  console.log("\nThe console, as the firm's people see it");
  const asFounder = await session(founder, dev.id);
  const home = await get(asFounder, "/dashboard");
  check("Today opens, marked as working through the firm", home.status === 200 && through(home.body), `${home.status}`);
  check("and shows the mandate's terms above the queue", /Your mandate with/.test(home.body) && home.body.replace(/<!-- -->/g, "").includes("3% on every booking"));
  const projects = await get(asFounder, "/dashboard/projects");
  check("the projects list holds the mandated project and not the other", projects.body.includes(HEIGHTS) && !projects.body.includes(GREENS));
  check("the other project does not open", refused(await get(asFounder, `/dashboard/projects/${greens.id}`)));
  const leads = await get(asFounder, "/dashboard/leads");
  check("the board holds the mandated project's buyer and not the other's", leads.body.includes(HEIGHTS_BUYER) && !leads.body.includes(GREENS_BUYER));
  const partners = await get(asFounder, "/dashboard/partners");
  check("the partner desk is the firm's own", partners.body.includes(`Keystone ${tag}`) && !partners.body.includes(`Horizon ${tag}`) && partners.body.includes("Your channel"));
  check("with no tab for the developer's mandates", !partners.body.includes("?view=mandates") && !partners.body.includes(">Mandate firms<"));
  for (const path of ["/dashboard/settings", "/dashboard/settings/billing", "/dashboard/team", "/dashboard/reports"]) {
    check(`${path} is not the firm's to open`, refused(await get(asFounder, path)));
  }
  const ask = await get(asFounder, "/dashboard/ask");
  check("Ask Jimmy opens through the mandate", ask.status === 200 && ask.body.includes("Ask Jimmy") && !refused(ask), `${ask.status}`);
  const rmHome = await get(await session(rm, dev.id), "/dashboard/partners");
  check("the firm's relationship manager works the same desk", rmHome.body.includes(`Keystone ${tag}`) && !rmHome.body.includes(`Horizon ${tag}`));

  // Every screen the firm reaches: it opens, and nothing of the other project is on it.
  const broke = /Application error|Internal Server Error|Something went wrong/;
  for (const path of [
    `/dashboard/leads/${heightsLead}`,
    "/dashboard/leads/calls",
    "/dashboard/leads/availability",
    "/dashboard/visits",
    "/dashboard/visits/scan",
    `/dashboard/projects/${heights.id}`,
    `/dashboard/brain/${heights.id}`,
    `/dashboard/brain/${towerC.id}`,
    "/dashboard/library",
    "/dashboard/library/branding",
    `/dashboard/library/${heights.id}`,
    `/dashboard/library/${towerC.id}`,
    "/dashboard/campaigns",
    `/dashboard/campaigns/${heights.id}`,
    "/dashboard/campaigns/queue",
    "/dashboard/campaigns/live",
    "/dashboard/partners?view=buyers",
    "/dashboard/partners?view=payouts",
  ]) {
    const r = await get(asFounder, path);
    check(`${path.replace(/[0-9a-f-]{36}/g, ":id")} opens and holds nothing of the other project`,
      r.status === 200 && !broke.test(r.body) && !r.body.includes(GREENS) && !r.body.includes(GREENS_BUYER) && !refused(r),
      `${r.status} broke=${(r.body.match(broke) ?? [""])[0]} greens=${r.body.includes(GREENS)} buyer=${r.body.includes(GREENS_BUYER)} refused=${refused(r)} ${r.body.includes(GREENS) ? r.body.slice(Math.max(0, r.body.indexOf(GREENS) - 200), r.body.indexOf(GREENS) + 60) : ""}`);
  }
  for (const path of [`/dashboard/leads/${greensLead}`, `/dashboard/brain/${greens.id}`, `/dashboard/brain/${towerG.id}`, `/dashboard/library/${greens.id}`, `/dashboard/campaigns/${greens.id}`]) {
    check(`${path.replace(/[0-9a-f-]{36}/g, ":id")} does not open`, refused(await get(asFounder, path)));
  }

  console.log("\nThe firm's own console");
  const asFirm = await session(founder, firm.id);
  check("the old workspace sends a mandate firm to its console", refused(await get(asFirm, "/workspace")));
  const firmToday = await get(asFirm, "/dashboard");
  // It sells through a live mandate, so Today does not send it to file a developer it already works for.
  check("its Today opens, with Developers in the rail and no setup steps while it sells through a mandate",
    firmToday.status === 200 && firmToday.body.includes("/dashboard/developers") && !firmToday.body.includes("Add a developer you sell for"), `${firmToday.status}`);
  const developers = await get(asFirm, "/dashboard/developers");
  check("Developers names the developer on Sales Desk to open, with the one action",
    developers.status === 200 && developers.body.includes(`Desk Developers ${tag}`) && developers.body.includes("Open projects") && developers.body.includes("On Sales Desk"), `${developers.status}`);
  check("and what the booking earned it", developers.body.includes(HEIGHTS) && developers.body.includes("Not due yet"));

  console.log("\nThe firm sends its commission invoice to the developer");
  check("nothing to invoice while no half is owed", !developers.body.includes("data-invoice="));
  const dated = await recordBookingDates({ orgId: dev.id, userId: devAdmin.id, payoutId: mandatePay!.id, agreementRegisteredOn: today, collectedOn: null, today });
  check("the developer records the agreement, so the first half is owed", dated.ok, dated.message);
  const owedPage = (await get(asFirm, "/dashboard/developers")).body.replace(/<!-- -->/g, "");
  check("Developers offers the invoice for that half, and only that half",
    owedPage.includes(`data-invoice="${mandatePay!.id}:M1"`) && !owedPage.includes(`data-invoice="${mandatePay!.id}:M2"`) && owedPage.includes("Send your invoice"));
  const [m1] = await sql<{ gross: string }[]>`SELECT gross FROM payout_milestones WHERE payout_id = ${mandatePay!.id} AND key = 'M1'`;
  const pdf = Buffer.from("%PDF-1.4\n% commission invoice\n");
  const invoice = (over: Partial<Parameters<typeof fileInvoiceForFirm>[0]>) =>
    fileInvoiceForFirm({
      firmOrgId: firm.id, userId: founder.id, kind: "MANDATE", payoutId: mandatePay!.id, key: "M1",
      invoiceNo: `GA/26-27/${n4}`, invoiceDate: today, amount: Number(m1.gross), bytes: pdf, mediaType: "application/pdf", today, ...over,
    });
  check("a half not yet owed is refused", (await invoice({ key: "M2" })).message === "This half is not owed yet.");
  check("the partner's payout on the same booking is not the firm's to invoice", (await invoice({ payoutId: partnerPay!.id })).message === "That booking is not yours to invoice.");
  check("nor is a developer it holds no mandate from", !(await invoice({ devOrgId: firm.id })).ok);
  const sentInv = await invoice({});
  check("the firm sends its invoice for the owed half", sentInv.ok && sentInv.message.startsWith("Invoice sent to the developer"), sentInv.message);
  const [filed] = await sql<{ cp_org_id: string; uploaded_by: string; attested_by: string | null; storage_key: string; stage: string }[]>`
    SELECT i.cp_org_id, i.uploaded_by, i.attested_by, i.storage_key, m.stage FROM partner_invoices i JOIN payout_milestones m ON m.id = i.milestone_id
    WHERE i.org_id = ${dev.id} AND m.payout_id = ${mandatePay!.id}`;
  check("it lands in the developer's tenant on the desk's own rails, the firm's own confirmation with it",
    filed?.cp_org_id === firm.id && filed.uploaded_by === founder.id && filed.attested_by === founder.id && filed.stage === "INVOICED" && filed.storage_key.startsWith(`org/${dev.id}/`) && filed.storage_key.includes("/invoice/"), JSON.stringify(filed));
  const [aud] = await sql<{ metadata: { via?: string } }[]>`
    SELECT metadata FROM audit_log WHERE org_id = ${dev.id} AND action = 'partner.invoice_filed' ORDER BY created_at DESC LIMIT 1`;
  check("the developer's trail says the firm sent it", aud?.metadata?.via === "firm");
  check("a second invoice for the same half is refused", (await invoice({})).message === "Your invoice for this half is already with the developer.");
  const verified = await moveMilestone({ orgId: dev.id, userId: devAdmin.id, milestoneId: (await sql<{ id: string }[]>`SELECT id FROM payout_milestones WHERE payout_id = ${mandatePay!.id} AND key = 'M1'`)[0].id, move: { kind: "verify" }, today });
  check("the developer verifies it as it verifies any invoice", verified.ok, verified.message);
  const afterPage = (await get(asFirm, "/dashboard/developers")).body.replace(/<!-- -->/g, "");
  check("and the firm reads it as with the developer, with nothing left to send", afterPage.includes("Invoice with the developer") && !afterPage.includes("data-invoice="));

  console.log("\nThe firm's own ads carry its agent registration");
  const firmAgent = await firmAgentFor(firm.id);
  check("a firm's own ads print its current agent number, and its name as the seller", firmAgent.ok && firmAgent.agentNo === "A51700001835" && !!firmAgent.seller, JSON.stringify(firmAgent));
  const devAgent = await firmAgentFor(dev.id);
  check("a developer's print none", devAgent.ok && devAgent.agentNo === null, JSON.stringify(devAgent));
  await sql`UPDATE firm_profiles SET rera_valid_till = ${days(-1)} WHERE org_id = ${firm.id}`;
  const lapsedAgent = await firmAgentFor(firm.id);
  check("a lapsed one refuses every ad of the firm's before anything is paid", !lapsedAgent.ok && lapsedAgent.code === "NO_AGENT_RERA");
  await sql`UPDATE firm_profiles SET rera_valid_till = ${days(400)} WHERE org_id = ${firm.id}`;
  await node(firm.id, firmRoot, "ENTITY", `Riverside Homes ${tag}`, "riverside");
  const withOwn = (await get(asFirm, "/dashboard/developers")).body.replace(/<!-- -->/g, "");
  check("a developer it added sits in the same list, beside the one on Sales Desk",
    withOwn.includes(`Riverside Homes ${tag}`) && withOwn.includes('data-developer="own"') && withOwn.includes("No project yet") && withOwn.includes("2 developers"));
  check("its team is the console's own Team page", (await get(asFirm, "/dashboard/team")).body.includes(`Neha ${tag}`));
  check("its agent registration is under Settings", (await get(asFirm, "/dashboard/settings/firm")).body.includes("A51700001835"));
  const firmEntities = (await get(asFirm, "/dashboard/settings/entities")).body.replace(/<!-- -->/g, "");
  check("a developer's legal details are reached from Developers", firmEntities.includes("legal</span> details") && firmEntities.includes('href="/dashboard/developers"'));
  const firmPartners = await get(asFirm, "/dashboard/partners");
  check("its partner desk has no tab for appointing mandate firms", firmPartners.status === 200 && !firmPartners.body.includes("?view=mandates"));
  const asDev = await session(devAdmin, dev.id);
  check("a developer has no Developers section", refused(await get(asDev, "/dashboard/developers")) && !(await get(asDev, "/dashboard")).body.includes("/dashboard/developers"));

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
    await shoot(founder, firm.id, "/dashboard", "firm-today");
    await shoot(founder, firm.id, "/dashboard/developers", "firm-developers-page");
    await shoot(founder, firm.id, "/dashboard/settings/firm", "firm-settings");
    await shoot(founder, firm.id, "/dashboard/settings/entities", "firm-developers");
    await shoot(founder, firm.id, "/dashboard/developers", "firm-developers-phone", 390);
    await shoot(founder, dev.id, "/dashboard", "via-today");
    await shoot(founder, dev.id, "/dashboard/partners", "via-partners");
    await shoot(founder, dev.id, "/dashboard/partners?view=payouts", "via-payouts");
    await browser.close();
  }

  console.log("\nOne desk per project: the developer takes the firm's partner on for another project");
  const split = await empanelFirm({ orgId: dev.id, userId: devAdmin.id, firm: netForm.firm, rmId: null, projectIds: [greens.id], validTo: days(100) });
  check("a second row, on the developer's own desk", split.ok && split.firmId !== netId, split.ok ? "" : split.message);
  const splitId = split.ok ? split.firmId : "";
  const clash = await codeOf(withTenant(dev.id, (tx) => tx`
    INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_from, valid_to)
    VALUES (${dev.id}, ${nf.cp_org_id}, ${heights.id}, 'CHANNEL_PARTNER', now(), now() + interval '10 days')`));
  check("the database refuses the mandated project on the developer's desk while the firm has it", clash === "23514" || clash === "23505", String(clash));

  console.log("\nRunning the mandate longer runs its partners on with it");
  const [mv] = await sql<{ valid_to: Date }[]>`SELECT valid_to FROM mandates WHERE id = ${mandateId}`;
  // A partner empanelled to the mandate's last day, as the form caps it.
  await sql`UPDATE grants SET valid_to = ${mv.valid_to} WHERE id = ${ng.id}`;
  const longer = await changeMandate({ orgId: dev.id, userId: devAdmin.id, mandateId, change: { kind: "renew", validTo: days(260) } });
  check("run longer", longer.ok, longer.message);
  const [ngTo] = await sql<{ valid_to: Date }[]>`SELECT valid_to FROM grants WHERE id = ${ng.id}`;
  check("the partner that ran to the mandate's last day runs to the new one", ist(ngTo.valid_to.toISOString()).date === days(260), ngTo.valid_to.toISOString());

  console.log("\nEnding the mandate ends the firm's partners with it");
  const ended = await changeMandate({ orgId: dev.id, userId: devAdmin.id, mandateId, change: { kind: "end" } });
  check("ended", ended.ok, ended.message);
  check("its partner's grant ends too", (await sql<{ status: string }[]>`SELECT status FROM grants WHERE id = ${ng.id}`)[0].status === "ENDED");
  const gone = await get(asFounder, "/dashboard");
  check("the console no longer opens through it", !through(gone.body));
  const taken = await grantProjects({ orgId: dev.id, userId: devAdmin.id, firmId: splitId, projectIds: [heights.id], validTo: days(100) });
  check("the developer may now take the partner on for the mandated project too", taken.ok, taken.message);
  check("the firm's row stays on the firm's desk", (await sql<{ mandate_id: string | null }[]>`SELECT mandate_id FROM partner_firms WHERE id = ${netId}`)[0].mandate_id === mandateId);
  check("and what the firm owed it stays the firm's to pay", (await sql<{ payer_mandate_id: string | null }[]>`SELECT payer_mandate_id FROM partner_payouts WHERE id = ${partnerPay!.id}`)[0].payer_mandate_id === mandateId);
} finally {
  mail.restore();
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
  await sql`DELETE FROM mandates WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM lead_tasks WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM messages WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM calls WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM outcome_events WHERE org_id = ${dev.id}`.catch(() => {});
  await sql`DELETE FROM leads WHERE org_id = ${dev.id}`;
  await sql`DELETE FROM audit_log WHERE org_id = ANY(${made.orgs})`;
  await sql`DELETE FROM orgs WHERE id = ANY(${made.orgs})`;
  await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
