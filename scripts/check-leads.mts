/**
 * The lead engine, end to end, with Sarvam, WhatsApp and the ad platforms
 * injected.
 *
 * Nothing rings and nothing is sent: `useSarvam()`, `useWhatsApp()` and
 * `usePlatform()` swap each driver for one that records what it was asked.
 * The suite drives the real functions against the real database, in a
 * tenant it builds and removes: a lead arriving from a website, a Meta form
 * and a Google form; the call at once inside hours and at ten outside them;
 * three unanswered dials and no fourth; a call that books a visit, the
 * WhatsApp with directions, the reminders, the no-show and its recovery;
 * the visit recorded; a booking and its welcome; an opt-out said on a call
 * and a STOP sent on WhatsApp; the minute allowance and the channel limit;
 * the board refusing a move its rules refuse; and the budget pass moving
 * money from two losing ads to a winning one without changing the total.
 *
 * Time is passed in rather than read, so the suite runs the same at 3 pm
 * and at 3 am.
 */
import postgres from "postgres";
import { randomBytes, createHmac } from "node:crypto";
import { useSarvam } from "../src/lib/sarvam.ts";
import { useWhatsApp } from "../src/lib/whatsapp.ts";
import { connectFixtureNumber, dropFixtureNumbers } from "./whatsapp-fixture.mts";
import { usePlatform } from "../src/lib/platform.ts";
import { useVaultKey, seal, connectionPurpose } from "../src/lib/vault.ts";
import { closeDb } from "../src/lib/db/index.ts";
import { addLeadAndCall, ingestWebhook, saveOrgPolicy, policyAt } from "../src/lib/calling.ts";
import { recordEvent, moveLead, listBoard, loadLead } from "../src/lib/leads.ts";
import { processEvent, onCallEnded, runLeadTasks, onVisitAction, onMoved, moveVisit, seatCheck } from "../src/lib/lead-engine.ts";
import { saveLocation, listVisits, bookVisit } from "../src/lib/visits.ts";
import { checkInByScan, passFor, passLink } from "../src/lib/checkin.ts";
import { latestNote, processNote, saveNote, useNoteReader } from "../src/lib/visit-notes.ts";
import { useTranscriber } from "../src/lib/stt.ts";
import { addLender, onLenderAnswer, useLenderMail } from "../src/lib/visit-followups.ts";
import { addDemand, loanFor, onLoanShareAnswer, saveDocuments, saveLoan, stepDemand } from "../src/lib/loans.ts";
import { readDemandForm, readLoanForm, type DemandInput, type LoanInput } from "../src/lib/loan-rules.ts";
import { addUnitType, approveUnitType } from "../src/lib/unit.ts";
import { withTenant as withTenantApp } from "../src/lib/db/index.ts";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHosts, saveCapacity, saveHostHours } from "../src/lib/slots.ts";
import { slotForCall } from "../src/lib/call-slots.ts";
import { useQualifier } from "../src/lib/qualify.ts";
import { useVobiz } from "../src/lib/vobiz.ts";
import { bridgeAccept, bridgeAnswer, proxyHangup } from "../src/lib/proxy.ts";
import { ingestWhatsApp } from "../src/lib/messaging.ts";
import { rebalanceBudgets } from "../src/lib/ad-budget.ts";
import { readReportAlerts } from "../src/lib/report-alerts.ts";
import { lastFullQuarter } from "../src/lib/report-rules.ts";
import { ist, istAt } from "../src/lib/cadence-rules.ts";
import { metaSignatureValid } from "../src/lib/capture-rules.ts";
import { buildAuthz } from "../src/lib/rbac-rules.ts";
import { lensOf, thresholdRows, spacedPhone } from "../src/lib/mask-rules.ts";
import { recordDnd, useDnd } from "../src/lib/dnd.ts";
import { DND_MESSAGE } from "../src/lib/dnd-rules.ts";

/** A template by its name, whichever version (English, Hinglish, Marathi) the buyer was sent. */
const tpl = (m: { template?: string | null }) => (m.template ?? "").replace(/_(en|mr)$/, "");

/**
 * A viewer who sees every number whole, for asserting on what the screens
 * are handed. Masking has its own suite (`check:masking`); here the number
 * is how a row is found.
 */

const seeAll = async (orgId: string) => {
  const [root] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`;
  const authz = buildAuthz([{ role: "CHECK_ALL", roleLabel: "Check", scopeNodeId: "", scopePath: root.path, scopeKind: "ORG",
    scopeName: "", permissions: new Set(["*"]) }]);
  return { lens: lensOf(authz, thresholdRows("CHECK_ALL", "phone", { before: "FULL", from: null, after: "FULL" })), scopes: [root.path] };
};

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
  // Vobiz is injected below; these only say calling through our number is set up.
  VOBIZ_AUTH_ID: "test-auth",
  VOBIZ_AUTH_TOKEN: "test-token",
})) process.env[k] ??= v;
// The job agents stay off until the suite's own section switches them on,
// so the cadence checked first is the one a tenant without them gets.
for (const k of ["SARVAM_CONFIRMER_APP_ID", "SARVAM_REENGAGER_APP_ID", "SARVAM_POSTVISIT_APP_ID"]) delete process.env[k];
useVaultKey(randomBytes(32));
// Voice notes go to a local folder, never the real bucket.
process.env.ASSETS_DIR = await mkdtemp(join(tmpdir(), "est-leads-store-"));
const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// The fakes
// ---------------------------------------------------------------------------

const dialled: { toNumber: string; attemptId: string; app?: { id: string; version: number }; variables: Record<string, string> }[] = [];
useSarvam({
  async placeOutbound(_c, req) {
    const attemptId = `att-${dialled.length + 1}`;
    dialled.push({ toNumber: req.toNumber, attemptId, app: req.app, variables: req.variables });
    return { attemptId };
  },
  async getRecording() {
    return null;
  },
});

// Nothing here is read by a live model or rung through live Vobiz: .env.local
// may hold real keys for both.
let qualifierAnswer: Record<string, unknown> | null = null;
useQualifier(async () => (qualifierAnswer ? { ok: true, value: qualifierAnswer } : { ok: false, code: "OFF", message: "Not read in this check." }));
const vobizCalls: { to: string; answerUrl: string }[] = [];
useVobiz({
  async liveCalls() {
    return [];
  },
  async transfer() {},
  async makeCall(_c, call) {
    vobizCalls.push({ to: call.to, answerUrl: call.answerUrl });
    return { uuid: `vz-${vobizCalls.length}` };
  },
});

const sent: { to: string; template: string; params: string[]; id: string; buttons?: string[] }[] = [];
useWhatsApp({
  async sendTemplate(_c, m) {
    const id = `wamid.${sent.length + 1}.${Date.now()}`;
    sent.push({ to: m.to, template: m.template, params: m.params, id, buttons: m.buttons });
    return { id };
  },
});

const budgets: { adset: string; minor: string }[] = [];
usePlatform(async (url, init) => {
  const u = new URL(url);
  if (init.method === "POST" && /\/adset_/.test(u.pathname)) {
    const body = new URLSearchParams(String(init.body ?? ""));
    budgets.push({ adset: u.pathname.split("/").pop()!, minor: body.get("daily_budget") ?? "" });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: { message: "no route", code: 404 } }), { status: 404, headers: { "content-type": "application/json" } });
});

// ---------------------------------------------------------------------------
// A tenant of its own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const [admin] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`admin@leads${tag}.example`}, ${`leads${tag}.example`}, 'Leads Admin') RETURNING id`;
const [seller] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`asha@leads${tag}.example`}, ${`leads${tag}.example`}, 'Asha Menon') RETURNING id`;
const [org] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
  VALUES ('DEVELOPER', 'Sath Group', 'Sath Group', 'AAPFU0939F', ${`leads${tag}.example`}, ${admin.id}) RETURNING id`;
const orgId = org.id;
const [root] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${orgId}, NULL, 'ORG', 'Sath Group', ${`leads_${tag}`}, ${`leads_${tag}`}::ltree) RETURNING id, path::text AS path`;
const node = async (parent: { id: string; path: string }, kind: string, name: string, slug: string) => {
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${orgId}, ${parent.id}, ${kind}, ${name}, ${slug}, ${`${parent.path}.${slug}`}::ltree) RETURNING id, path::text AS path`;
  return row;
};
const entity = await node(root, "ENTITY", "Sath Heights LLP", "sath_llp");
const region = await node(entity, "REGION", "Pune", "pune");
const project = await node(region, "PROJECT", "Sath Heights", "sath_heights");
const towerC = await node(project, "PHASE", "Tower C", "tower_c");
const towerD = await node(project, "PHASE", "Tower D", "tower_d");
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${orgId}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
// The developer's own WhatsApp number, connected for the whole organisation.
const wa = await connectFixtureNumber(sql, orgId, root.id);
const waMeta = { phone_number_id: wa.phoneNumberId, display_phone_number: "919876501234" };
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${seller.id}, ${orgId}, ${project.id}, 'PROJECT_SALES_MANAGER', 'ACTIVE')`;
const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
// Tower C is registered; Tower D has no record, so it may not be advertised.
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, promoter_name, valid_to, verified_at)
  VALUES (${towerC.id}, ${orgId}, 'VERIFIED', 'P52100012345', 'MH', 'Sath Heights LLP', ${FAR}, now())`;

// Noon IST tomorrow, and eleven at night tonight, as instants.
const day0 = ist(new Date(Date.now() + 86_400_000).toISOString()).date;
const at = (date: string, hhmm: string) => istAt(date, hhmm);
const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const NOON = at(day0, "12:00");
const LATE = at(day0, "23:00");
const later = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const secret = createHmac("sha256", process.env.AUTH_SECRET!).update("salesdesk:lead-capture").digest("hex");
void secret;

async function webLead(id: string, fields: Record<string, string>): Promise<{ leadId: string | null }> {
  const ev = await recordEvent({ orgId, source: "WEBSITE", externalId: id, payload: { lead_id: id, phase: towerC.id, ...fields } });
  const r = await processEvent(orgId, ev.id, { nowIso: fields.__now ?? NOON });
  return { leadId: r.ok ? r.leadId : null };
}
const lastCall = async (leadId: string) =>
  (await sql<{ id: string; attempt: number; agent: string; status: string }[]>`
    SELECT id, attempt, agent, status FROM calls WHERE lead_id = ${leadId} ORDER BY placed_at DESC, attempt DESC LIMIT 1`)[0];
const tasks = async (leadId: string) =>
  sql<{ purpose: string; state: string; due_at: Date; result: string | null }[]>`
    SELECT purpose, state, due_at, result FROM lead_tasks WHERE lead_id = ${leadId} ORDER BY due_at, created_at`;
const lead = async (leadId: string) =>
  (await sql<{ stage: string; facts: Record<string, string>; needs_person: string | null; exit_reason: string | null; owner_id: string | null; temperature: string | null }[]>`
    SELECT stage, facts, needs_person, exit_reason, owner_id, temperature FROM leads WHERE id = ${leadId}`)[0];
const hangUp = async (callId: string, body: Record<string, unknown>, nowIso: string) => {
  await ingestWebhook(orgId, callId, body);
  await onCallEnded(orgId, callId, { nowIso });
};

try {
  const saved = await saveOrgPolicy({
    orgId,
    userId: admin.id,
    input: { consentRequired: true, announceRecording: true, recordingLine: null, announceAi: true, handoffNumber: "+919876501234" },
  });
  check("the org's calling rules save, with the automation defaults", saved.ok && (await policyAt(orgId, null)).autoOutreach === true);
  check("a site location saves from a Maps link",
    (await saveLocation({ orgId, userId: admin.id, nodeId: project.id, link: "https://www.google.com/maps/place/x/@18.5,73.8,17z/data=!3d18.591234!4d73.738912", address: "Hinjewadi Phase 3" })).ok);

  console.log("\nA lead inside calling hours is called at once");
  const a = await webLead(`chk-a-${tag}`, { name: "Priya Sharma", phone: "90000 00201", consent: "on", utm_source: "facebook" });
  check("the website form makes a lead", !!a.leadId);
  const aId = a.leadId!;
  check("and the AI calls it straight away", dialled.length === 1 && dialled[0].toNumber === "+919000000201");
  check("the first call's task is done", (await tasks(aId)).some((t) => t.purpose === "FIRST_CALL" && t.state === "DONE"));
  check("the form's consent is on file",
    (await sql`SELECT 1 FROM lead_consents WHERE org_id = ${orgId} AND phone = '+919000000201'`).length === 1);
  const again = await recordEvent({ orgId, source: "WEBSITE", externalId: `chk-a-${tag}`, payload: {} });
  check("the same submission delivered twice is one event", again.fresh === false);
  const re = await webLead(`chk-a2-${tag}`, { name: "Priya S", phone: "9000000201", __now: later(NOON, 30) });
  check("the same buyer enquiring again is the same lead", re.leadId === aId);
  check("and is not rung twice in a day", dialled.length === 1);

  console.log("\nUnanswered: three tries a day for three days, a WhatsApp, then closed");
  let call = await lastCall(aId);
  await hangUp(call.id, { status: "no_answer" }, later(NOON, 1));
  check("a missed-call WhatsApp goes to the buyer", sent.some((m) => tpl(m) === "salesdesk_missed_call" && m.to === "+919000000201"));
  const retry = (await tasks(aId)).find((t) => t.purpose === "RETRY_CALL" && t.state === "DUE");
  check("a second try is due half an hour later", !!retry && Math.abs(retry.due_at.getTime() - Date.parse(later(NOON, 31))) < 120_000);
  const days = new Set<string>([ist(NOON).date]);
  for (let n = 2; n <= 9; n++) {
    const due = (await tasks(aId)).find((t) => t.purpose === "RETRY_CALL" && t.state === "DUE");
    if (!due) break;
    days.add(ist(due.due_at.toISOString()).date);
    await runLeadTasks({ orgId, leadId: aId, nowIso: later(due.due_at.toISOString(), 1) });
    call = await lastCall(aId);
    await hangUp(call.id, { status: n % 2 ? "no_answer" : "busy" }, later(due.due_at.toISOString(), 2));
  }
  check("only one missed-call WhatsApp, however many misses", sent.filter((m) => tpl(m) === "salesdesk_missed_call").length === 1);
  check("nine dials in all, over three days", dialled.filter((d) => d.toNumber === "+919000000201").length === 9 && days.size === 3);
  check("each later day starts after ten", [...days].slice(1).every((d) => d > ist(NOON).date));
  check("and no tenth is scheduled", !(await tasks(aId)).some((t) => t.state === "DUE" && t.purpose.endsWith("CALL")));
  const aNow = await lead(aId);
  check("the lead is closed as not reachable", aNow.stage === "lost" && aNow.exit_reason === "Not reachable");

  console.log("\nOutside hours: a WhatsApp now, the call at ten");
  const b = await webLead(`chk-b-${tag}`, { name: "Rohan Patil", phone: "9000000202", __now: LATE });
  const bId = b.leadId!;
  check("nobody is rung at eleven at night", !dialled.some((d) => d.toNumber === "+919000000202"));
  check("a Marathi name with no language on the form is written to in Marathi", sent.some((m) => m.template === "salesdesk_enquiry_received_mr" && m.to === "+919000000202"));
  check("an acknowledgement goes on WhatsApp", sent.some((m) => tpl(m) === "salesdesk_enquiry_received" && m.to === "+919000000202"));
  const first = (await tasks(bId)).find((t) => t.purpose === "FIRST_CALL")!;
  check("the call is due just after ten the next morning", ist(first.due_at.toISOString()).hour === 10 && ist(first.due_at.toISOString()).date === plusDays(day0, 1));
  await runLeadTasks({ orgId, leadId: bId, nowIso: later(first.due_at.toISOString(), 1) });
  check("and goes out then", dialled.some((d) => d.toNumber === "+919000000202"));

  console.log("\nA call that books a visit");
  const t10 = later(first.due_at.toISOString(), 5);
  const visitDate = plusDays(day0, 3);
  call = await lastCall(bId);
  await hangUp(call.id, {
    status: "connected",
    duration: 184,
    interaction_id: "int-b",
    final_agent_variables: {
      lead_disposition: "warm_lead", budget: "80 lakh", bhk_preference: "2BHK", purchase_timeline: "within_3_months",
      site_visit_status: "booked", site_visit_time: `${visitDate}T11:00:00+05:30`, call_summary: "Wants a 2 BHK, visiting on the weekend.",
    },
  }, t10);
  const bNow = await lead(bId);
  check("the lead moves to Visit scheduled", bNow.stage === "visit_scheduled", bNow.stage);
  check("with what the buyer said, in the board's words",
    bNow.facts.config === "2 BHK" && bNow.facts.budget === "Rs 60 to 90 lakh" && bNow.facts.timeline === "1 to 3 months");
  check("owned by the sales manager, not the founding admin", bNow.owner_id === seller.id && bNow.facts.owner === "Asha Menon");
  const [visit] = await sql<{ id: string; status: string; scheduled_at: Date }[]>`SELECT id, status, scheduled_at FROM site_visits WHERE lead_id = ${bId}`;
  check("a site visit is booked for 11 am IST", visit?.status === "CONFIRMED" && visit.scheduled_at.toISOString() === at(visitDate, "11:00"));
  const confirm = sent.find((m) => tpl(m) === "salesdesk_visit_confirmed" && m.to === "+919000000202");
  check("the confirmation goes on WhatsApp with one-tap directions",
    !!confirm && confirm.params.some((p) => p.includes("google.com/maps/dir/?api=1&destination=18.591234,73.738912")));
  const vt = await tasks(bId);
  check("a reminder a day before and two hours before are scheduled",
    vt.some((t) => t.purpose === "VISIT_REMINDER_DAY" && t.state === "DUE") && vt.some((t) => t.purpose === "VISIT_REMINDER_SOON" && t.state === "DUE"));
  await ingestWebhook(orgId, call.id, { status: "connected", final_agent_variables: { lead_disposition: "warm_lead", site_visit_status: "booked", site_visit_time: `${visitDate}T11:00:00+05:30` } });
  await onCallEnded(orgId, call.id, { nowIso: t10 });
  check("Sarvam delivering the result twice books one visit", (await sql`SELECT 1 FROM site_visits WHERE lead_id = ${bId}`).length === 1);
  await runLeadTasks({ orgId, leadId: bId, nowIso: at(plusDays(visitDate, -1), "11:05") });
  check("the day-before reminder goes", sent.some((m) => tpl(m) === "salesdesk_visit_tomorrow" && m.to === "+919000000202"));
  await runLeadTasks({ orgId, leadId: bId, nowIso: at(visitDate, "09:05") });
  check("the two-hour reminder goes", sent.some((m) => tpl(m) === "salesdesk_visit_today" && m.to === "+919000000202"));
  const visitsOnScreen = await listVisits(orgId, visitDate, visitDate, null, (await seeAll(orgId)).lens);
  check("the visits screen shows it", visitsOnScreen.some((v) => v.buyer === "Rohan Patil" && v.time === "11:00" && v.status === "confirmed"));

  console.log("\nNobody came: the no-show ladder");
  await runLeadTasks({ orgId, leadId: bId, nowIso: at(visitDate, "11:35") });
  check("half an hour after the slot the visit is a no-show",
    (await sql<{ status: string }[]>`SELECT status FROM site_visits WHERE id = ${visit.id}`)[0].status === "NO_SHOW");
  check("the buyer is messaged to rebook", sent.some((m) => tpl(m) === "salesdesk_visit_missed" && m.to === "+919000000202"));
  check("and an AI call to rebook is scheduled", (await tasks(bId)).some((t) => t.purpose === "RECOVERY_CALL" && t.state === "DUE"));
  const recorded = await onVisitAction({ orgId, userId: seller.id, visitId: visit.id, action: "VISITED", nowIso: at(visitDate, "12:10"),
    outcome: { interest: "Hot", objection: "Price", next: "Send the payment plan" } });
  check("they turned up late after all, and the host records the visit", recorded.ok, recorded.message);
  const bAfter = await lead(bId);
  check("the lead moves to Visit done, hot", bAfter.stage === "visit_done" && bAfter.temperature === "HOT" && bAfter.facts.objection === "Price");
  check("the host's next step is flagged for a person", (bAfter.needs_person ?? "").includes("payment plan"));
  check("a thank-you goes on WhatsApp", sent.some((m) => tpl(m) === "salesdesk_after_visit" && m.to === "+919000000202"));
  const before = dialled.length;
  await runLeadTasks({ orgId, leadId: bId, nowIso: at(visitDate, "13:40") });
  check("the recovery call is not made to someone who came", dialled.length === before);

  console.log("\nThe board: a person's move, checked again on the server");
  const today = ist(at(visitDate, "15:00")).date;
  const bad = await moveLead({ orgId, userId: seller.id, leadId: bId, to: "booked", today,
    input: { facts: { unit: "C-803", quote: "7630000", bookedOn: today, agreement: "7630000", token: "900000" } } });
  check("a token over ten per cent of the agreement is refused with the rule's words", !bad.ok && !!bad.errors?.token);
  const good = await moveLead({ orgId, userId: seller.id, leadId: bId, to: "booked", today,
    input: { facts: { unit: "C-803", quote: "7630000", bookedOn: today, agreement: "7630000", token: "500000" } } });
  check("a booking with its facts is saved", good.ok);
  if (good.ok) await onMoved({ orgId, userId: seller.id, leadId: bId, from: good.from, to: good.to, facts: good.facts, followUpOn: good.followUpOn, nowIso: at(visitDate, "15:01") });
  check("the buyer is welcomed on WhatsApp", sent.some((m) => tpl(m) === "salesdesk_booking_welcome" && m.to === "+919000000202"));
  check("and a referral ask is scheduled three days out", (await tasks(bId)).some((t) => t.purpose === "REFERRAL" && t.state === "DUE"));
  const board = await listBoard(orgId, null, new Date(at(visitDate, "15:05")));
  check("the board shows real leads in their columns",
    board.leads.some((l) => l.id === bId && l.stage === "booked") && board.leads.some((l) => l.id === aId && l.stage === "lost"));
  const detail = await loadLead(orgId, bId);
  check("the lead's history reads in order", (detail?.activity.length ?? 0) >= 4);

  console.log("\nWho an enquiry belongs to: junk, already booked, an open lead, or new");
  const eventRule = async (externalId: string) =>
    (await sql<{ rule: string | null; outcome: string | null }[]>`
      SELECT rule, outcome FROM lead_events WHERE org_id = ${orgId} AND external_id = ${externalId}`)[0];
  const junk = await webLead(`chk-j-${tag}`, { name: "Test", phone: "9000000292" });
  check("a test name makes no lead and nobody is rung", junk.leadId === null && !dialled.some((d) => d.toNumber === "+919000000292"));
  check("and the event says R0, junk", (await eventRule(`chk-j-${tag}`))?.rule === "R0" && (await eventRule(`chk-j-${tag}`))?.outcome === "JUNK");
  const bot = await webLead(`chk-hp-${tag}`, { name: "Arjun Mehta", phone: "9000000293", est_hp: "https://spam.example" });
  check("a form a bot filled makes no lead", bot.leadId === null && (await eventRule(`chk-hp-${tag}`))?.rule === "R0");
  const dialledBefore = dialled.length;
  const owner = await webLead(`chk-r1-${tag}`, { name: "Rohan Patil", phone: "9000000202", __now: at(visitDate, "16:00") });
  check("a buyer who booked here enquiring again is their booked lead, not a new one (R1)", owner.leadId === bId && (await eventRule(`chk-r1-${tag}`))?.rule === "R1");
  check("and is not called, but a person is told", dialled.length === dialledBefore && (await lead(bId)).needs_person === "Booked buyer enquired again");
  check("the same buyer's second enquiry was R3", (await eventRule(`chk-a2-${tag}`))?.rule === "R3");
  const stale = await webLead(`chk-s1-${tag}`, { name: "Farah Ali", phone: "9000000294" });
  await sql`UPDATE leads SET last_activity_at = now() - interval '100 days' WHERE id = ${stale.leadId}`;
  const fresh = await webLead(`chk-s2-${tag}`, { name: "Farah Ali", phone: "9000000294", __now: later(NOON, 45) });
  check("an open lead quiet past the lookback is closed as no activity", (await lead(stale.leadId!)).stage === "lost" && (await lead(stale.leadId!)).exit_reason === "No activity");
  check("and the new enquiry is a new lead (R4)", !!fresh.leadId && fresh.leadId !== stale.leadId && (await eventRule(`chk-s2-${tag}`))?.rule === "R4");
  const rules = await sql<{ rule: string }[]>`
    SELECT DISTINCT metadata->>'ownership' AS rule FROM audit_log
    WHERE org_id = ${orgId} AND action IN ('lead.captured', 'lead.ownership')`;
  check("every rule that fired is in the audit log", ["R0", "R1", "R3", "R4"].every((r) => rules.some((x) => x.rule === r)));
  check("and no audit row carries a phone number",
    (await sql`SELECT 1 FROM audit_log WHERE org_id = ${orgId} AND action IN ('lead.captured', 'lead.ownership') AND metadata::text ~ '9000000'`).length === 0);
  const typed = await addLeadAndCall({ orgId, userId: admin.id, name: "asdf", phone: "9000000295", phaseId: towerC.id, source: "Walk-in", language: "hi", consentWording: null, nowIso: NOON });
  check("typing a test lead by hand is refused with the reason", !typed.ok && typed.message === "A test name." && !dialled.some((d) => d.toNumber === "+919000000295"));
  const toOwner = dialled.filter((d) => d.toNumber === "+919000000202").length;
  const typedOwner = await addLeadAndCall({ orgId, userId: admin.id, name: "Rohan Patil", phone: "9000000202", phaseId: towerC.id, source: "Walk-in", language: "hi", consentWording: null, nowIso: NOON });
  check("and a booked buyer typed in is not called", !typedOwner.ok && dialled.filter((d) => d.toNumber === "+919000000202").length === toOwner);
  // These calls were never answered; left live they would fill the project's lines for every test after this one.
  await sql`UPDATE calls SET status = 'DONE', ended_at = now()
    WHERE org_id = ${orgId} AND to_number IN ('+919000000294') AND status <> 'DONE'`;

  console.log("\nStopping: said on a call, or sent on WhatsApp");
  const c = await webLead(`chk-c-${tag}`, { name: "Imran Khan", phone: "9000000203" });
  const cId = c.leadId!;
  call = await lastCall(cId);
  await hangUp(call.id, { status: "connected", final_agent_variables: { lead_disposition: "dnc", opt_out: true } }, later(NOON, 3));
  check("an opt-out on the call closes the lead", (await lead(cId)).stage === "lost" && (await lead(cId)).exit_reason === "Asked not to be contacted");
  check("and the number is suppressed", (await sql`SELECT 1 FROM call_suppressions WHERE org_id = ${orgId} AND phone = '+919000000203'`).length === 1);
  const d = await webLead(`chk-d-${tag}`, { name: "Neha Joshi", phone: "9000000204", __now: LATE });
  const dId = d.leadId!;
  const ack = sent.find((m) => m.to === "+919000000204")!;
  await ingestWhatsApp({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: ack.id, status: "read", timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
  check("a read receipt lands on the message",
    (await sql<{ status: string }[]>`SELECT status FROM messages WHERE provider_id = ${ack.id}`)[0]?.status === "READ");
  await ingestWhatsApp({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: waMeta, messages: [{ id: `in.${tag}.1`, from: "919000000204", timestamp: "1", type: "text", text: { body: "Can you call on Sunday?" } }] } }] }] });
  check("a reply lands on the lead and asks for a person", ((await lead(dId)).needs_person ?? "").startsWith("Replied on WhatsApp"));
  await ingestWhatsApp({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: waMeta, messages: [{ id: `in.${tag}.2`, from: "919000000204", timestamp: "2", type: "text", text: { body: "STOP" } }] } }] }] });
  check("STOP is an opt-out", (await sql`SELECT 1 FROM call_suppressions WHERE org_id = ${orgId} AND phone = '+919000000204' AND reason = 'WHATSAPP_STOP'`).length === 1);
  check("and the morning call is cancelled", (await tasks(dId)).some((t) => t.purpose === "FIRST_CALL" && t.state === "CANCELLED"));

  console.log("\nThe gates a paid call waits on");
  const e = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel) VALUES (${orgId}, ${towerD.id}, 'Blocked Tower Lead', '+919000000205', 'Website', 'WEBSITE') RETURNING id`;
  await sql`INSERT INTO lead_tasks (org_id, lead_id, kind, purpose, due_at, dedupe_key) VALUES (${orgId}, ${e[0].id}, 'CALL', 'FIRST_CALL', ${new Date(NOON)}, ${`${e[0].id}:FIRST_CALL`})`;
  await runLeadTasks({ orgId, leadId: e[0].id, nowIso: NOON });
  check("a tower that may not be advertised gets no call", !dialled.some((d) => d.toNumber === "+919000000205") &&
    (await tasks(e[0].id))[0].state === "SKIPPED");
  await saveOrgPolicy({ orgId, userId: admin.id, input: { ...(await policyAt(orgId, null)), minuteAllowance: 0 } });
  const f = await webLead(`chk-f-${tag}`, { name: "Kiran Rao", phone: "9000000206" });
  check("with the month's minutes used up nothing is dialled", !dialled.some((d) => d.toNumber === "+919000000206"));
  check("and a person is asked to call", ((await lead(f.leadId!)).needs_person ?? "").includes("minutes"));
  await saveOrgPolicy({ orgId, userId: admin.id, input: { ...(await policyAt(orgId, null)), minuteAllowance: 1500, channelLimit: 1 } });
  const livePlaced = new Date(Date.parse(NOON) - 60_000);
  await sql`
    INSERT INTO calls (org_id, lead_id, scope_node_id, agent, app_id, app_version, from_number, to_number, status, placed_at)
    VALUES (${orgId}, ${f.leadId!}, ${towerC.id}, 'qualifier', 'x', 1, '+912265480217', '+919000000206', 'DIALLING', ${livePlaced})`;
  const g = await webLead(`chk-g-${tag}`, { name: "Meera Iyer", phone: "9000000207" });
  const gt = (await tasks(g.leadId!)).find((t) => t.purpose === "FIRST_CALL")!;
  check("with every line busy the call waits a few minutes rather than failing",
    gt.state === "DUE" && gt.due_at.getTime() > Date.parse(NOON) && !dialled.some((d) => d.toNumber === "+919000000207"));
  await saveOrgPolicy({ orgId, userId: admin.id, input: { ...(await policyAt(orgId, null)), channelLimit: 3 } });

  console.log("\nThe DND register");
  // A day of its own, so no other lead's live calls hold a line.
  const T = at(plusDays(day0, 5), "14:17");
  const oldLead = async (name: string, phone: string) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, enquired_at)
      VALUES (${orgId}, ${towerC.id}, ${name}, ${phone}, 'Website', 'WEBSITE', ${new Date(Date.parse(T) - 10 * 86_400_000)}) RETURNING id`;
    await sql`INSERT INTO lead_consents (org_id, phone, channels, wording, source)
      VALUES (${orgId}, ${phone}, ${["call", "whatsapp"]}, 'Call and WhatsApp me about this project', 'check')`;
    return row.id;
  };
  const callTask = (leadId: string, dueAt: string, key: string) => sql`
    INSERT INTO lead_tasks (org_id, lead_id, kind, purpose, due_at, dedupe_key)
    VALUES (${orgId}, ${leadId}, 'CALL', 'CALLBACK', ${new Date(dueAt)}, ${`${leadId}:${key}`})`;
  const dialledTo = (phone: string) => dialled.filter((d) => d.toNumber === phone).length;

  const xId = await oldLead("Rahul Verma", "+919000000301");
  await callTask(xId, T, "dnd-1");
  await runLeadTasks({ orgId, leadId: xId, nowIso: T });
  check("past the enquiry's seven days, a number nobody checked is still called", dialledTo("+919000000301") === 1);
  const xCall = await lastCall(xId);
  await hangUp(xCall.id, { status: "failed", failure_reason: "CALL_REJECTED_DND" }, later(T, 1));
  const opRows = await sql<{ status: string; source: string; call_id: string | null; expires_at: Date | null }[]>`
    SELECT status, source, call_id, expires_at FROM dnd_checks WHERE org_id = ${orgId} AND phone = '+919000000301'`;
  check("a refusal naming the register is remembered, against the call, with no expiry",
    opRows.length === 1 && opRows[0].status === "DND" && opRows[0].source === "OPERATOR" && opRows[0].call_id === xCall.id && !opRows[0].expires_at);
  await ingestWebhook(orgId, xCall.id, { status: "failed", failure_reason: "CALL_REJECTED_DND" });
  check("and a redelivered webhook records it once",
    (await sql`SELECT 1 FROM dnd_checks WHERE org_id = ${orgId} AND phone = '+919000000301'`).length === 1);
  check("the lead's history says why",
    (await sql`SELECT 1 FROM lead_activity WHERE lead_id = ${xId} AND reason LIKE 'The operator refused the call%'`).length === 1);
  check("the audit row carries the status and the source, and no number",
    (await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'lead.dnd_recorded' AND target_id = ${xId}`)
      .every((r) => r.metadata.status === "DND" && r.metadata.source === "OPERATOR" && !JSON.stringify(r.metadata).includes("9000000301")));
  await callTask(xId, later(T, 10), "dnd-2");
  await runLeadTasks({ orgId, leadId: xId, nowIso: later(T, 10) });
  const xTasks = await tasks(xId);
  check("the next call is not dialled", dialledTo("+919000000301") === 1);
  check("and its task is skipped with the reason", xTasks.some((t) => t.state === "SKIPPED" && t.result === DND_MESSAGE.slice(0, 300)),
    JSON.stringify(xTasks.map((t) => [t.state, t.result])));
  check("the lead's page reads it", (await loadLead(orgId, xId))?.dnd?.status === "DND");
  await sql`INSERT INTO lead_tasks (org_id, lead_id, kind, purpose, due_at, dedupe_key)
    VALUES (${orgId}, ${xId}, 'MESSAGE', 'NURTURE', ${new Date(later(T, 12))}, ${`${xId}:dnd-nurture`})`;
  await runLeadTasks({ orgId, leadId: xId, nowIso: later(T, 12) });
  check("WhatsApp is not scrubbed: the nudge still goes", sent.some((m) => m.to === "+919000000301" && tpl(m) === "salesdesk_nurture"));
  await recordDnd({ orgId, phone: "+919000000301", status: "CONSENT_REGISTERED", source: "PERSON", leadId: xId, userId: admin.id, nowIso: later(T, 20) });
  await callTask(xId, later(T, 25), "dnd-3");
  await runLeadTasks({ orgId, leadId: xId, nowIso: later(T, 25) });
  check("consent registered with the operator lets the call through", dialledTo("+919000000301") === 2);

  const yId = (await webLead(`chk-dnd-y-${tag}`, { name: "Sunita Rao", phone: "9000000302", __now: T })).leadId!;
  await recordDnd({ orgId, phone: "+919000000302", status: "DND", source: "PERSON", leadId: yId, userId: admin.id, nowIso: later(T, 1) });
  await callTask(yId, later(T, 30), "dnd-1");
  await runLeadTasks({ orgId, leadId: yId, nowIso: later(T, 30) });
  check("inside the enquiry's seven days a number on the register is called: the call answers the enquiry",
    dialledTo("+919000000302") === 2);

  let lookups = 0;
  let answer: "DND" | "CLEAR" = "DND";
  useDnd({ async lookup() { lookups++; return answer; } });
  const zId = await oldLead("Farhan Ali", "+919000000303");
  await callTask(zId, later(T, 40), "dnd-1");
  await runLeadTasks({ orgId, leadId: zId, nowIso: later(T, 40) });
  check("with a lookup to ask, a number it names is not called", lookups === 1 && dialledTo("+919000000303") === 0);
  await callTask(zId, later(T, 50), "dnd-2");
  await runLeadTasks({ orgId, leadId: zId, nowIso: later(T, 50) });
  check("and the answer is remembered rather than asked again", lookups === 1 && dialledTo("+919000000303") === 0);
  answer = "CLEAR";
  await callTask(zId, later(T, 24 * 60 + 60), "dnd-3");
  await runLeadTasks({ orgId, leadId: zId, nowIso: later(T, 24 * 60 + 60) });
  check("a day later it is asked again, and a number that left the register is called",
    lookups === 2 && dialledTo("+919000000303") === 1);
  useDnd(null);
  // Calls placed days ahead would read as live lines to every test after this one.
  await sql`UPDATE calls SET status = 'DONE', ended_at = now()
    WHERE org_id = ${orgId} AND to_number IN ('+919000000301', '+919000000302', '+919000000303') AND status <> 'DONE'`;

  console.log("\nThe visit confirmer and the post-visit agent, each a copy of the qualifier");
  const ROLE_ENV: Record<string, string> = {
    SARVAM_CONFIRMER_APP_ID: "test-confirmer", SARVAM_CONFIRMER_APP_VERSION: "1",
    SARVAM_POSTVISIT_APP_ID: "test-postvisit", SARVAM_POSTVISIT_APP_VERSION: "1",
  };
  const savedRoles = Object.keys(ROLE_ENV).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, ROLE_ENV);
  try {
    const h = await webLead(`chk-h-${tag}`, { name: "Farah Ali", phone: "9000000209", consent: "on" });
    const hId = h.leadId!;
    const hVisitDay = plusDays(day0, 3);
    call = await lastCall(hId);
    check("the first call is still the qualifier's", call?.agent === "qualifier" && dialled.at(-1)?.app === undefined);
    await hangUp(call.id, {
      status: "connected", duration: 120,
      final_agent_variables: { lead_disposition: "warm_lead", site_visit_status: "booked", site_visit_time: `${hVisitDay}T16:00:00+05:30`, call_summary: "Coming on the weekend." },
    }, later(NOON, 3));
    const ht = await tasks(hId);
    check("with the confirmer on, a booked visit gets a confirmation call a day ahead instead of the WhatsApp reminder",
      ht.some((t) => t.purpose === "CONFIRM_CALL" && t.state === "DUE") && !ht.some((t) => t.purpose === "VISIT_REMINDER_DAY"));
    await runLeadTasks({ orgId, leadId: hId, nowIso: at(plusDays(hVisitDay, -1), "16:05") });
    call = await lastCall(hId);
    check("the day before, the visit confirmer rings, told it is confirming and when",
      call?.agent === "reminder" && dialled.at(-1)?.app?.id === "test-confirmer" && dialled.at(-1)?.variables.call_reason === "confirm"
        && /4:00 pm$/.test(dialled.at(-1)?.variables.visit_time ?? ""), JSON.stringify(dialled.at(-1)?.variables ?? {}));
    await hangUp(call.id, { status: "no_answer" }, at(plusDays(hVisitDay, -1), "16:06"));
    check("unanswered, the WhatsApp reminder goes instead", sent.some((m) => tpl(m) === "salesdesk_visit_tomorrow" && m.to === "+919000000209"));
    const morning = (await tasks(hId)).find((t) => t.purpose === "CONFIRM_CALL" && t.state === "DUE");
    check("and one more try is due the morning of the visit", !!morning && ist(morning.due_at.toISOString()).date === hVisitDay && ist(morning.due_at.toISOString()).hour === 10);
    await runLeadTasks({ orgId, leadId: hId, nowIso: at(hVisitDay, "10:40") });
    call = await lastCall(hId);
    const [oldVisit] = await sql<{ id: string }[]>`SELECT id FROM site_visits WHERE lead_id = ${hId} AND status = 'CONFIRMED'`;
    await hangUp(call.id, {
      status: "connected", duration: 50,
      final_agent_variables: { visit_status: "moved", new_visit_time: `${plusDays(hVisitDay, 1)}T12:00:00+05:30`, lead_disposition: "warm_lead" },
    }, at(hVisitDay, "10:41"));
    const hVisits = await sql<{ id: string; status: string; scheduled_at: Date }[]>`SELECT id, status, scheduled_at FROM site_visits WHERE lead_id = ${hId} ORDER BY created_at`;
    const newVisit = hVisits.find((v) => v.status === "CONFIRMED");
    check("the buyer moved it on the call: the old visit is moved and the new one booked",
      hVisits.find((v) => v.id === oldVisit?.id)?.status === "MOVED" && newVisit?.scheduled_at.toISOString() === at(plusDays(hVisitDay, 1), "12:00"),
      JSON.stringify(hVisits.map((v) => [v.status, v.scheduled_at])));
    check("the call's outcome reads Visit moved", (await sql<{ outcome: string }[]>`SELECT outcome FROM calls WHERE id = ${call.id}`)[0]?.outcome === "VISIT_MOVED");

    const madeIt = await onVisitAction({ orgId, userId: seller.id, visitId: newVisit!.id, action: "VISITED", nowIso: at(plusDays(hVisitDay, 1), "13:00"),
      outcome: { interest: "Warm", objection: "None", next: "Nothing planned" } });
    check("the visit is recorded", madeIt.ok, madeIt.message);
    const pvTask = (await tasks(hId)).find((t) => t.purpose === "POST_VISIT_CALL" && t.state === "DUE");
    check("and a call to ask how it went is due the next morning", !!pvTask && ist(pvTask.due_at.toISOString()).date === plusDays(hVisitDay, 2));
    await runLeadTasks({ orgId, leadId: hId, nowIso: at(plusDays(hVisitDay, 2), "11:10") });
    call = await lastCall(hId);
    check("the post-visit agent makes it, told when they came",
      call?.agent === "post_visit" && dialled.at(-1)?.app?.id === "test-postvisit" && /\d{4}$/.test(dialled.at(-1)?.variables.visit_date ?? ""));
    await hangUp(call.id, {
      status: "connected", duration: 90,
      final_agent_variables: { visit_interest: "hot", visit_objection: "loan", next_step: "negotiation", lead_disposition: "hot_lead" },
    }, at(plusDays(hVisitDay, 2), "11:12"));
    const hNow = await lead(hId);
    check("a buyer ready to talk price is hot, and a person is asked to call today",
      hNow.temperature === "HOT" && (hNow.needs_person ?? "").includes("talk price"), JSON.stringify([hNow.temperature, hNow.needs_person]));

    // The confirmer switched off between booking and the day before: the WhatsApp does its job.
    for (const k of Object.keys(ROLE_ENV)) delete process.env[k];
    const [iLead] = await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, stage, path_stage)
      VALUES (${orgId}, ${towerC.id}, 'Ira Sen', '+919000000210', 'Website', 'WEBSITE', 'visit_scheduled', 'visit_scheduled') RETURNING id`;
    const iAt = at(plusDays(day0, 2), "15:00");
    const [iVisit] = await sql<{ id: string }[]>`
      INSERT INTO site_visits (org_id, lead_id, scope_node_id, scheduled_at, booked_via) VALUES (${orgId}, ${iLead.id}, ${towerC.id}, ${new Date(iAt)}, 'CONSOLE') RETURNING id`;
    await sql`INSERT INTO lead_tasks (org_id, lead_id, visit_id, kind, purpose, due_at, dedupe_key, detail)
              VALUES (${orgId}, ${iLead.id}, ${iVisit.id}, 'CALL', 'CONFIRM_CALL', ${new Date(at(plusDays(day0, 1), "15:00"))}, ${`${iVisit.id}:CONFIRM_CALL:1`}, ${sql.json({ attempt: 1 })})`;
    const beforeI = dialled.length;
    await runLeadTasks({ orgId, leadId: iLead.id, nowIso: at(plusDays(day0, 1), "15:01") });
    check("with no confirmer to place it, nothing is dialled and the WhatsApp reminder goes",
      dialled.length === beforeI && sent.some((m) => tpl(m) === "salesdesk_visit_tomorrow" && m.to === "+919000000210"));
  } finally {
    for (const [k, v] of savedRoles) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }

  console.log("\nThe gallery's capacity: one seat, a full hour offered three others, a race, a move, a cancel, the gate");
  {
    const CAP_NOW = at(plusDays(day0, 6), "11:00");
    const capDay = plusDays(day0, 8);
    const noonOn = `${capDay}T12:00:00+05:30`;
    check("a project's hosts per hour save", (await saveCapacity({ orgId, userId: admin.id, projectId: project.id, weekday: "1", weekend: "1" })).ok);
    check("and hosts per hour are held to a number", !(await saveCapacity({ orgId, userId: admin.id, projectId: project.id, weekday: "two", weekend: "1" })).ok);
    const bookOnCall = async (id: string, phone: string, name: string) => {
      const l = await webLead(`chk-${id}-${tag}`, { name, phone, consent: "on", __now: CAP_NOW });
      const c = await lastCall(l.leadId!);
      await hangUp(c.id, {
        status: "connected", duration: 150,
        final_agent_variables: { lead_disposition: "warm_lead", site_visit_status: "booked", site_visit_time: noonOn, call_summary: "Coming on the day." },
      }, later(CAP_NOW, 3));
      return l.leadId!;
    };
    const visitOf = async (leadId: string) =>
      (await sql<{ id: string; status: string; slot_id: string | null; host_id: string | null; scheduled_at: Date; blocked_reason: string | null }[]>`
        SELECT id, status, slot_id, host_id, scheduled_at, blocked_reason FROM site_visits WHERE lead_id = ${leadId} AND status <> 'MOVED'
        ORDER BY created_at DESC LIMIT 1`)[0];
    const takenAt = async (day: string, hour: number) =>
      (await sql<{ taken: number }[]>`SELECT taken FROM visit_slots WHERE org_id = ${orgId} AND project_id = ${project.id} AND day = ${day} AND hour = ${hour}`)[0]?.taken ?? 0;

    const p1 = await bookOnCall("cap1", "9000000401", "Kabir Shah");
    const v1 = await visitOf(p1);
    check("the first buyer's visit takes the hour's one seat", v1?.status === "CONFIRMED" && !!v1.slot_id && (await takenAt(capDay, 12)) === 1);
    check("and is given the least-loaded host placed at the project", v1?.host_id === seller.id);
    const p2 = await bookOnCall("cap2", "9000000402", "Zoya Merchant");
    const v2 = await visitOf(p2);
    check("the second buyer asking for the same hour waits", v2?.status === "REQUESTED" && v2.slot_id === null);
    const offer = sent.find((m) => tpl(m) === "salesdesk_visit_slots" && m.to === "+919000000402");
    check("and is offered three other times in one WhatsApp, a tap each", !!offer && offer.buttons?.length === 3 && offer.buttons.every((b) => b.startsWith("slot:")));
    check("each offered time is held for them", (await sql`
      SELECT 1 FROM visit_holds WHERE org_id = ${orgId} AND lead_id = ${p2} AND released_at IS NULL AND expires_at > now()`).length === 3);
    check("and a person is asked in an hour if none is picked", (await tasks(p2)).some((t) => t.purpose === "OFFER_CHECK" && t.state === "DUE"));
    const pick = offer!.buttons![1];
    const [held] = await sql<{ starts_at: Date }[]>`SELECT starts_at FROM visit_holds WHERE id = ${pick.slice(5)}`;
    await ingestWhatsApp({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: waMeta, messages: [
      { id: `in.${tag}.slot`, from: "919000000402", timestamp: "3", type: "button", button: { text: "Book 2", payload: pick } },
    ] } }] }] });
    const v2b = await visitOf(p2);
    check("tapping one books that time and its seat", v2b?.status === "CONFIRMED" && v2b.scheduled_at.getTime() === held.starts_at.getTime() && !!v2b.slot_id);
    check("the buyer is sent the confirmation with directions", sent.some((m) => tpl(m) === "salesdesk_visit_confirmed" && m.to === "+919000000402"));
    check("the other held times are let go", (await sql`
      SELECT 1 FROM visit_holds WHERE org_id = ${orgId} AND lead_id = ${p2} AND released_at IS NULL`).length === 0);
    check("and the tap is not flagged for a person", (await lead(p2)).needs_person === null && (await lead(p2)).stage === "visit_scheduled");

    // Two bookings racing for the last seat of an hour: the ledger decides.
    const [r1, r2] = await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel)
      VALUES (${orgId}, ${towerC.id}, 'Race One', '+919000000403', 'Website', 'WEBSITE'),
             (${orgId}, ${towerC.id}, 'Race Two', '+919000000404', 'Website', 'WEBSITE') RETURNING id`;
    const raceAt = `${capDay}T15:00:00+05:30`;
    const race = await Promise.all([r1, r2].map((r) => bookVisit({ orgId, leadId: r.id, atIso: raceAt, via: "CONSOLE", ifFull: "REFUSE", nowIso: CAP_NOW })));
    check("two bookings racing for the last seat: exactly one gets it", race.filter((b) => b?.kind === "CONFIRMED").length === 1 && race.filter((b) => b?.kind === "FULL").length === 1);
    check("and the ledger shows one seat taken", (await takenAt(capDay, 15)) === 1);
    const full = race.find((b) => b?.kind === "FULL");
    check("the loser is told three free times", full?.kind === "FULL" && full.alternatives.length === 3);
    const blocked = await seatCheck({ orgId, leadId: r1.id, atIso: raceAt, nowIso: CAP_NOW });
    check("a person booking a full hour on the board is told which are free", !blocked.ok && blocked.message.startsWith("That hour is full. Free:"));
    // The agent asks the same question on the live call, before agreeing to a time.
    const [onLine] = await sql<{ id: string }[]>`
      INSERT INTO calls (org_id, lead_id, scope_node_id, agent, app_id, app_version, from_number, to_number, status, placed_at)
      VALUES (${orgId}, ${r2.id}, ${towerC.id}, 'qualifier', 'x', 1, '+912265480217', '+919000000404', 'DIALLING', ${new Date(CAP_NOW)}) RETURNING id`;
    const askFull = await slotForCall({ orgId, callId: onLine.id, said: raceAt, nowIso: CAP_NOW });
    check("asked on the call, a full hour is full, with the free times nearby", askFull?.free === false && /is fully booked\. Free times nearby: .+ or .+\.$/.test(askFull.say), askFull?.say);
    const askFree = await slotForCall({ orgId, callId: onLine.id, said: `${capDay}T17:00:00+05:30`, nowIso: CAP_NOW });
    check("and a free one is free", askFree?.free === true && askFree.say.endsWith("5:00 pm is free."), askFree?.say);
    check("a time the site does not open is not agreed to", (await slotForCall({ orgId, callId: onLine.id, said: "Sunday 8 am", nowIso: CAP_NOW }))?.free === false);
    await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE id = ${onLine.id}`;
    check("a call that has ended asks nothing", (await slotForCall({ orgId, callId: onLine.id, said: raceAt, nowIso: CAP_NOW })) === null);

    const moved = await moveVisit({ orgId, userId: admin.id, visitId: v1!.id, date: capDay, time: "16:30", nowIso: CAP_NOW });
    const v1b = await visitOf(p1);
    check("a visit moved from the visits screen goes to the new time", moved.ok && v1b?.scheduled_at.toISOString() === at(capDay, "16:30"));
    check("the old hour's seat comes back and the new one is taken", (await takenAt(capDay, 12)) === 0 && (await takenAt(capDay, 16)) === 1);
    check("the old visit points at the new one", (await sql`SELECT 1 FROM site_visits WHERE id = ${v1!.id} AND status = 'MOVED' AND moved_to = ${v1b!.id}`).length === 1);
    const movedFull = await moveVisit({ orgId, userId: admin.id, visitId: v1b!.id, date: capDay, time: "15:00", nowIso: CAP_NOW });
    check("moving into a full hour is refused, naming the free ones", !movedFull.ok && movedFull.message.startsWith("That hour is full"));
    const cancelled = await onVisitAction({ orgId, userId: admin.id, visitId: v1b!.id, action: "CANCEL", nowIso: CAP_NOW });
    check("a cancelled visit gives its seat back", cancelled.ok && (await takenAt(capDay, 16)) === 0);
    check("and the buyer is told on WhatsApp", sent.some((m) => tpl(m) === "salesdesk_visit_cancelled" && m.to === "+919000000401"));

    // The day before, the admission gate is asked again: an opt-out since booking stops the visit.
    await sql`INSERT INTO call_suppressions (org_id, phone, reason) VALUES (${orgId}, '+919000000402', 'ADDED_BY_HAND') ON CONFLICT DO NOTHING`;
    const dayBefore = new Date(held.starts_at.getTime() - 86_400_000).toISOString();
    await runLeadTasks({ orgId, leadId: p2, nowIso: dayBefore });
    const v2c = await visitOf(p2);
    check("the day-before check stops a visit the gate now refuses", v2c?.status === "BLOCKED" && v2c.blocked_reason === "The buyer asked not to be contacted.");
    check("its seat goes back", v2c?.slot_id !== null && (await sql<{ taken: number }[]>`SELECT taken FROM visit_slots WHERE id = ${v2c!.slot_id}`)[0].taken === 0);
    check("no reminder goes to a stopped visit", !sent.some((m) => tpl(m) === "salesdesk_visit_tomorrow" && m.to === "+919000000402"));
    check("and a person is told why", ((await lead(p2)).needs_person ?? "").startsWith("Visit stopped"));
    await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE org_id = ${orgId} AND to_number IN ('+919000000401', '+919000000402') AND status <> 'DONE'`;
  }

  console.log("\nHosts with their own hours: the hour's seats are the hosts on the floor, and each visit is given one");
  {
    const HH_NOW = at(plusDays(day0, 15), "11:00");
    const greens = await node(region, "PROJECT", "Sath Greens", "sath_greens");
    const towerG = await node(greens, "PHASE", "Tower G", "tower_g");
    const person = async (name: string, role: string, at_: { id: string }) => {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO users (email, email_domain, name) VALUES (${`${name.toLowerCase()}.${tag}@leads${tag}.example`}, ${`leads${tag}.example`}, ${name}) RETURNING id`;
      await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${u.id}, ${orgId}, ${at_.id}, ${role}, 'ACTIVE')`;
      return u.id;
    };
    const ravi = await person("Ravi", "SITE_TEAM", greens);
    const meera = await person("Meera", "SITE_TEAM", greens);
    const hhDay = plusDays(day0, 20);
    const dow = new Date(`${hhDay}T00:00:00Z`).getUTCDay();
    const hosts0 = await listHosts(orgId, greens.id);
    check("the people who may host are those who check buyers in at the project",
      hosts0.some((h) => h.id === ravi) && hosts0.some((h) => h.id === meera) && !hosts0.some((h) => h.id === seller.id));
    check("somebody who does not check buyers in there is not given hours",
      !(await saveHostHours({ orgId, userId: admin.id, projectId: greens.id, hostId: seller.id, week: { [dow]: { from: "10", to: "14" } } })).ok);
    check("hours that finish before they start are refused",
      !(await saveHostHours({ orgId, userId: admin.id, projectId: greens.id, hostId: ravi, week: { [dow]: { from: "15", to: "12" } } })).ok);
    check("a host's hours save, one day at a time",
      (await saveHostHours({ orgId, userId: admin.id, projectId: greens.id, hostId: ravi, week: { [dow]: { from: "10", to: "14" } } })).ok
      && (await saveHostHours({ orgId, userId: admin.id, projectId: greens.id, hostId: meera, week: { [dow]: { from: "12", to: "19" } } })).ok);
    check("and are audited, naming the host and no more", (await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'visit.host_hours_saved' AND target_id = ${greens.id}`).some((r) => r.metadata.host === meera && r.metadata.days === 1));

    const buyer = async (n: number) => {
      const [l] = await sql<{ id: string }[]>`
        INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel)
        VALUES (${orgId}, ${towerG.id}, ${`Greens ${n}`}, ${`+9190000009${String(n).padStart(2, "0")}`}, 'Website', 'WEBSITE') RETURNING id`;
      return l.id;
    };
    const book = async (n: number, hhmm: string, day = hhDay) =>
      bookVisit({ orgId, leadId: await buyer(n), atIso: at(day, hhmm), via: "CONSOLE", ifFull: "REFUSE", nowIso: HH_NOW });
    const seatsAt = async (day: string, hour: number) =>
      (await sql<{ capacity: number; taken: number }[]>`SELECT capacity, taken FROM visit_slots WHERE org_id = ${orgId} AND project_id = ${greens.id} AND day = ${day} AND hour = ${hour}`)[0];

    const b1 = await book(1, "11:00");
    check("an hour with one host on the floor takes one visit, given to that host", b1?.kind === "CONFIRMED" && b1.hostId === ravi && (await seatsAt(hhDay, 11))?.capacity === 1);
    const b2 = await book(2, "11:30");
    check("a second buyer in that hour is told it is full", b2?.kind === "FULL");
    const b3 = await book(3, "13:00");
    const b4 = await book(4, "13:30");
    const b5 = await book(5, "13:00");
    check("an hour two hosts share takes two, one visit each", b3?.kind === "CONFIRMED" && b4?.kind === "CONFIRMED"
      && new Set([b3.hostId, b4.hostId]).size === 2 && b5?.kind === "FULL" && (await seatsAt(hhDay, 13))?.capacity === 2);
    const b6 = await book(6, "16:00");
    check("late in the day only the host still on the floor hosts", b6?.kind === "CONFIRMED" && b6.hostId === meera);
    const b7 = await book(7, "12:00", plusDays(hhDay, 1));
    check("a day nobody works takes no visit", b7?.kind === "FULL");

    const race = await Promise.all([8, 9].map(async (n) => bookVisit({ orgId, leadId: await buyer(n), atIso: at(plusDays(hhDay, 7), "10:00"), via: "CONSOLE", ifFull: "REFUSE", nowIso: HH_NOW })));
    check("two bookings racing for the one host on the floor: exactly one gets them",
      race.filter((b) => b?.kind === "CONFIRMED").length === 1 && race.filter((b) => b?.kind === "FULL").length === 1
      && race.find((b) => b?.kind === "CONFIRMED")?.kind === "CONFIRMED" && (race.find((b) => b?.kind === "CONFIRMED") as { hostId: string }).hostId === ravi);

    check("a host taken off the floor leaves the hour with nobody, and the seat already taken stays",
      (await saveHostHours({ orgId, userId: admin.id, projectId: greens.id, hostId: meera, week: {} })).ok
      && (await seatsAt(hhDay, 16))?.capacity === 0 && (await seatsAt(hhDay, 16))?.taken === 1);
    const after = await listHosts(orgId, greens.id);
    check("the project page lists the host with hours first, and the other with none",
      after[0].id === ravi && after[0].hours.length === 1 && after.find((h) => h.id === meera)?.hours.length === 0);
  }

  console.log("\nChecking in: the pass, the site team's scan, far, offline, by hand, and attribution frozen");
  {
    process.env.CAPTURE_BASE_URL ??= "https://check.example";
    const CI_NOW = at(plusDays(day0, 9), "11:00");
    const ciDay = plusDays(day0, 10);
    const [ciLead, handLead] = await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, lineage)
      VALUES (${orgId}, ${towerC.id}, 'Meera Iyer', '+919000000601', 'Website', 'WEBSITE', '{"utm_source":"meta"}'),
             (${orgId}, ${towerC.id}, 'Hand Case', '+919000000602', 'Website', 'WEBSITE', '{}') RETURNING id`;
    const b = await bookVisit({ orgId, leadId: ciLead.id, atIso: at(ciDay, "11:00"), via: "CONSOLE", ifFull: "REFUSE", nowIso: CI_NOW });
    const bh = await bookVisit({ orgId, leadId: handLead.id, atIso: at(ciDay, "12:00"), via: "CONSOLE", ifFull: "REFUSE", nowIso: CI_NOW });
    check("two visits booked for the check-in cases", b?.kind === "CONFIRMED" && bh?.kind === "CONFIRMED");
    const visitId = b?.kind === "CONFIRMED" ? b.visitId : "";
    const handId = bh?.kind === "CONFIRMED" ? bh.visitId : "";

    check("the confirmation a buyer gets carries their pass",
      sent.some((m) => tpl(m) === "salesdesk_visit_confirmed" && m.params.some((p) => p.includes(`/v/${orgId}/`))));
    const link = passLink(orgId, visitId)!;
    const sig = new URL(link).searchParams.get("t")!;
    const pass = await passFor(orgId, visitId, sig);
    check("the pass page opens only with the visit's own proof", !!pass && pass.status === "CONFIRMED" && (await passFor(orgId, visitId, "0".repeat(16))) === null);
    check("and names no buyer", !!pass && !JSON.stringify(pass).includes("Meera"));

    const [rootNode] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`;
    const site = buildAuthz([{ role: "SITE", roleLabel: "Site", scopeNodeId: "", scopePath: rootNode.path, scopeKind: "ORG", scopeName: "", permissions: new Set(["visit:read", "visit:confirm"]) }]);
    const reader = buildAuthz([{ role: "READ", roleLabel: "Read", scopeNodeId: "", scopePath: rootNode.path, scopeKind: "ORG", scopeName: "", permissions: new Set(["visit:read"]) }]);
    const scan = (o: Partial<Parameters<typeof checkInByScan>[0]>) =>
      checkInByScan({ orgId, userId: seller.id, authz: site, payload: pass!.payload, scannedAt: at(ciDay, "10:55"), receivedAt: at(ciDay, "10:55"), position: null, ...o });

    const forged = await scan({ payload: pass!.payload.replace(/.{4}$/, "0000") });
    check("a pass with a proof that does not match is not a pass", !forged.ok && forged.code === "NOT_A_PASS");
    const noKey = await scan({ authz: reader });
    check("somebody without the check-in key cannot check a buyer in", !noKey.ok && noKey.code === "NOT_ALLOWED");
    const far = await scan({ position: { lat: 18.6, lng: 73.738912, accuracy: 20 } });
    check("a phone a kilometre from the site is refused", !far.ok && far.code === "FAR");
    check("and the refusal is on record, with no position in it",
      (await sql<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'visit.checkin_refused' AND target_id = ${visitId}`)
        .some((r) => r.metadata.code === "FAR" && !("lat" in r.metadata)));

    // Scanned in the basement at 10:55, sent when the signal came back at 1 pm.
    const inside = await scan({ receivedAt: at(ciDay, "13:00") });
    check("a scan kept offline counts at the time it was made", inside.ok && inside.buyer === "Meera Iyer");
    check("marked sent later and with no position", inside.ok && inside.flags.includes("SENT_LATER") && inside.flags.includes("NO_POSITION"));
    const [row] = await sql<{ status: string; arrived_at: Date; checkin_method: string; checkin_by: string; checkin_synced_at: Date | null; attribution: Record<string, unknown> | null }[]>`
      SELECT status, arrived_at, checkin_method, checkin_by, checkin_synced_at, attribution FROM site_visits WHERE id = ${visitId}`;
    check("the visit is on site from the scan's own time, by QR, by the scanner",
      row.status === "ON_SITE" && row.arrived_at.toISOString() === at(ciDay, "10:55") && row.checkin_method === "QR" && row.checkin_by === seller.id && !!row.checkin_synced_at);
    check("where the buyer came from is written at check-in",
      row.attribution?.channel === "WEBSITE" && (row.attribution?.lineage as Record<string, string>)?.utm_source === "meta");
    const twice = await scan({});
    check("a second scan of the same pass is already in", !twice.ok && twice.code === "ALREADY");
    let frozen = false;
    try {
      await sql`UPDATE site_visits SET attribution = '{"channel":"META"}' WHERE id = ${visitId}`;
    } catch (e) {
      frozen = (e as { code?: string }).code === "23514";
    }
    check("and it can never be rewritten, even by the owner's connection", frozen);
    check("the pass page now says they are in", (await passFor(orgId, visitId, sig))?.status === "ON_SITE");

    const hand = await onVisitAction({ orgId, userId: admin.id, visitId: handId, action: "CHECK_IN", nowIso: CI_NOW });
    const [handRow] = await sql<{ checkin_method: string | null; attribution: unknown }[]>`SELECT checkin_method, attribution FROM site_visits WHERE id = ${handId}`;
    check("a buyer with no pass is checked in by hand, and recorded as that", hand.ok && handRow.checkin_method === "MANUAL" && handRow.attribution !== null);
  }

  console.log("\nThe host's voice note: stored, transcribed, read into a draft, confirmed, and what the objection starts");
  {
    const VN_NOW = at(plusDays(day0, 12), "11:00");
    const [rootNode] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`;
    const host = buildAuthz([{ role: "HOST", roleLabel: "Host", scopeNodeId: "", scopePath: rootNode.path, scopeKind: "ORG", scopeName: "", permissions: new Set(["visit:read", "visit:confirm", "visit:outcome"]) }]);

    // What the tower sells, approved, and a signed home-loan rate.
    const unit = await addUnitType({ orgId, actorUserId: admin.id, nodeId: towerC.id, config: "2BHK", variant: null, carpetAreaSqft: 682, balconyAreaSqft: null, startingPrice: 7_630_000 });
    if (unit.ok) await approveUnitType({ orgId, actorUserId: admin.id, unitTypeId: unit.unitTypeId });
    const unitId = unit.ok ? unit.unitTypeId : "";
    const [bv] = await sql<{ id: string }[]>`
      INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by)
      VALUES (${orgId}, ${towerC.id}, 1, 'DRAFT', ${admin.id}) RETURNING id`;
    await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value) VALUES (${orgId}, ${bv.id}, 'price.loan_rate', '8.5')`;
    await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now() WHERE id = ${bv.id}`;

    // A buyer on site, three times over.
    const onSite = async (id: string, phone: string, name: string, hhmm: string) => {
      const l = await webLead(`chk-${id}-${tag}`, { name, phone, consent: "on", __now: at(plusDays(day0, 11), "11:00") });
      await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE org_id = ${orgId} AND lead_id = ${l.leadId} AND status <> 'DONE'`;
      const b = await bookVisit({ orgId, leadId: l.leadId!, atIso: at(plusDays(day0, 12), hhmm), via: "CONSOLE", ifFull: "OFFER", nowIso: at(plusDays(day0, 11), "12:00") });
      const visitId = b?.kind === "CONFIRMED" ? b.visitId : "";
      await onVisitAction({ orgId, userId: admin.id, visitId, action: "CHECK_IN", nowIso: VN_NOW });
      return { leadId: l.leadId!, visitId };
    };
    const priceBuyer = await onSite("vn1", "9000000701", "Neha Kulkarni", "10:30");
    const loanBuyer = await onSite("vn2", "9000000702", "Arjun Mehta", "11:30");
    const familyBuyer = await onSite("vn3", "9000000703", "Kavya Rao", "13:30");
    check("three buyers on site for the note cases", !!priceBuyer.visitId && !!loanBuyer.visitId && !!familyBuyer.visitId);

    // A real 50-second recording, and a 20-second one that claims to be 50.
    const dir = await mkdtemp(join(tmpdir(), "est-vn-"));
    const make = async (name: string, seconds: number) => {
      await execFileP(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=300:duration=${seconds}`, "-ac", "1", "-ar", "16000", join(dir, name)]);
      return readFile(join(dir, name));
    };
    const fifty = await make("fifty.wav", 50);
    const twenty = await make("twenty.wav", 20);

    const pieces: number[] = [];
    useTranscriber(async (p) => {
      pieces.push(p.bytes.byteLength);
      return pieces.length % 2 === 1
        ? { ok: true, text: "Showed them the 2 BHK on the twelfth floor, they liked the layout", language: "en-IN" }
        : { ok: true, text: "but the price is high for them. Very keen, call 9876543210 tomorrow", language: "en-IN" };
    });
    useNoteReader(async () => ({
      ok: true,
      value: {
        units: [{ id: unitId, span: "the 2 BHK" }, { id: "00000000-0000-4000-8000-000000000000", span: "a 3 BHK" }],
        objection: { value: "PRICE", span: "the price is high" },
        interest: { value: "HOT", span: "Very keen" },
        next: { value: "PAYMENT_PLAN", span: "send the payment plan" },
      },
    }));

    const short = await saveNote({ orgId, userId: seller.id, authz: host, visitId: priceBuyer.visitId, bytes: twenty, contentType: "audio/wav", durationMs: 20_000 });
    check("a note under 45 seconds is refused on the phone's own timing", !short.ok && short.message === "Keep the note between 45 and 90 seconds.");
    const noKey = await saveNote({ orgId, userId: seller.id, authz: buildAuthz([{ role: "R", roleLabel: "R", scopeNodeId: "", scopePath: rootNode.path, scopeKind: "ORG", scopeName: "", permissions: new Set(["visit:read"]) }]), visitId: priceBuyer.visitId, bytes: fifty, contentType: "audio/wav", durationMs: 50_000 });
    check("somebody who cannot record a visit cannot leave a note on it", !noKey.ok);

    const saved = await saveNote({ orgId, userId: seller.id, authz: host, visitId: priceBuyer.visitId, bytes: fifty, contentType: "audio/wav", durationMs: 50_000 });
    check("a 50-second note is kept as it was recorded", saved.ok);
    const noteId = saved.ok ? saved.noteId : "";
    const [row] = await sql<{ storage_key: string; sha256: string; bytes: number }[]>`SELECT storage_key, sha256, bytes FROM visit_notes WHERE id = ${noteId}`;
    check("the row holds the store's key, never a link, and the file's hash", row?.storage_key.startsWith(`org/${orgId}/project/`) && row.storage_key.endsWith(`/visitnote/${noteId}`) && row.bytes === fifty.byteLength
      && row.sha256 === createHash("sha256").update(fifty).digest("hex"));
    const state = await processNote(orgId, noteId, { nowIso: VN_NOW });
    check("it is cut into pieces the transcriber takes, and read into a draft", state === "DRAFTED" && pieces.length === 2);
    const view = await latestNote(orgId, priceBuyer.visitId);
    check("the draft keeps the unit the tower sells and drops the one it does not", view?.draft?.unitIds.length === 1 && view.draft.unitIds[0] === unitId && view.draft.shown[0] === "2 BHK");
    check("a field whose words the host never said is left blank", view?.draft?.objection === "Price" && view.draft.interest === "Hot" && view.draft.next === null);
    check("a number said in the note is masked on screen", !!view?.transcript && !view.transcript.includes("9876543210"));
    check("the note is counted as half an AI minute, once", (await sql<{ qty: string }[]>`
      SELECT qty::text FROM usage_events WHERE org_id = ${orgId} AND source_kind = 'visit_note' AND source_id = ${noteId}`).map((r) => Number(r.qty)).join() === "0.5");
    check("reading it again pays nothing", (await processNote(orgId, noteId, { nowIso: VN_NOW })) === "DRAFTED" && pieces.length === 2);
    let frozen = false;
    try {
      await withTenantApp(orgId, (tx) => tx`UPDATE visit_notes SET sha256 = ${"0".repeat(64)} WHERE id = ${noteId}`);
    } catch (e) {
      frozen = (e as { code?: string }).code === "42501";
    }
    check("the recording's hash can never be rewritten by the app", frozen);

    // The host confirms the draft: the visit is recorded, and price starts the EMI.
    const confirmed = await onVisitAction({
      orgId, userId: seller.id, visitId: priceBuyer.visitId, action: "VISITED",
      outcome: { interest: "Hot", objection: "Price", next: "Send the payment plan" }, noteId, unitIds: [unitId], nowIso: VN_NOW,
    });
    check("confirming records the visit and closes the note", confirmed.ok && (await sql`SELECT 1 FROM visit_notes WHERE id = ${noteId} AND state = 'CONFIRMED' AND confirmed_by = ${seller.id}`).length === 1);
    await runLeadTasks({ orgId, leadId: priceBuyer.leadId, nowIso: later(VN_NOW, 31) });
    const emiMsg = sent.find((m) => tpl(m) === "salesdesk_visit_emi" && m.to === "+919000000701");
    // A Hinglish lead reads the loan in lakh, the way it is said (`loanWords()`); ₹61,04,000 is 61.04 lakh, never rounded up.
    check("price sends the EMI on the unit they saw, on the bank's loan amount, at the signed rate",
      !!emiMsg && emiMsg.params[2] === "2 BHK" && emiMsg.params[3] === "₹61.04 lakh" && emiMsg.params[4] === "8.5%" && emiMsg.params[6] === "52,972", emiMsg?.params.join(" | "));

    // A second note on the same visit is allowed; a third never.
    await sql`UPDATE site_visits SET status = 'ON_SITE' WHERE id = ${familyBuyer.visitId}`;
    const liar = await saveNote({ orgId, userId: seller.id, authz: host, visitId: familyBuyer.visitId, bytes: twenty, contentType: "audio/wav", durationMs: 50_000 });
    const before = pieces.length;
    check("a file shorter than the phone claimed is refused by its own length, before anything is paid",
      liar.ok && (await processNote(orgId, liar.ok ? liar.noteId : "", { nowIso: VN_NOW })) === "REFUSED" && pieces.length === before);
    const second = await saveNote({ orgId, userId: seller.id, authz: host, visitId: familyBuyer.visitId, bytes: fifty, contentType: "audio/wav", durationMs: 50_000 });
    const third = await saveNote({ orgId, userId: seller.id, authz: host, visitId: familyBuyer.visitId, bytes: fifty, contentType: "audio/wav", durationMs: 50_000 });
    check("a visit holds a note and one re-record, never a third", second.ok && !third.ok);

    // Family: a revisit offered with three open times.
    await onVisitAction({ orgId, userId: seller.id, visitId: familyBuyer.visitId, action: "VISITED", outcome: { interest: "Warm", objection: "Family", next: "Revisit with family" }, nowIso: VN_NOW });
    await runLeadTasks({ orgId, leadId: familyBuyer.leadId, nowIso: later(VN_NOW, 121) });
    const revisit = sent.find((m) => tpl(m) === "salesdesk_revisit_family" && m.to === "+919000000703");
    check("family sends a revisit offer with three times to tap", !!revisit && revisit.buttons?.length === 3);

    // Loan: asked first, and the lender hears of them only after a yes.
    const mails: { to: string; subject: string; text: string }[] = [];
    useLenderMail(async (m) => {
      mails.push(m);
      return { ok: true, messageId: "m1" };
    });
    await onVisitAction({ orgId, userId: seller.id, visitId: loanBuyer.visitId, action: "VISITED", outcome: { interest: "Warm", objection: "Loan", next: "Share the loan offer" }, nowIso: VN_NOW });
    await runLeadTasks({ orgId, leadId: loanBuyer.leadId, nowIso: later(VN_NOW, 31) });
    check("with no lender set up, a person is asked to call", ((await lead(loanBuyer.leadId)).needs_person ?? "").startsWith("Buyer needs a home loan"));
    check("a lender is added by address", (await addLender({ orgId, userId: admin.id, name: "Check Bank", email: "loans@bank.example" })).ok);
    // Four on the list: the first three are asked about, in the order listed.
    for (const [name, email] of [["Second Bank", "home@second.example"], ["Third Finance", "loans@third.example"], ["Fourth Bank", "loans@fourth.example"]]) {
      await new Promise((r) => setTimeout(r, 5));
      await addLender({ orgId, userId: admin.id, name, email });
    }
    await sql`UPDATE lead_tasks SET state = 'DUE', attempts = 0 WHERE org_id = ${orgId} AND lead_id = ${loanBuyer.leadId} AND purpose = 'LENDER_ASK'`;
    await runLeadTasks({ orgId, leadId: loanBuyer.leadId, nowIso: later(VN_NOW, 40) });
    const ask = sent.find((m) => tpl(m) === "salesdesk_lender_ask" && m.to === "+919000000702");
    check("the buyer is asked, Yes and No each naming the question", !!ask && ask.buttons?.length === 2 && ask.buttons[0].endsWith(":yes") && ask.buttons[1].endsWith(":no"));
    check("one question names the first three lenders listed, and never the fourth",
      !!ask && ask.params.includes("Check Bank, Second Bank and Third Finance") && !ask.params.some((p) => p.includes("Fourth")), ask?.params.join(" | "));
    const askRows = await sql<{ ask_id: string; state: string }[]>`SELECT ask_id, state FROM lender_referrals WHERE org_id = ${orgId} AND lead_id = ${loanBuyer.leadId}`;
    check("a row for each lender asked, tied to the one question", askRows.length === 3 && new Set(askRows.map((r) => r.ask_id)).size === 1 && askRows.every((r) => r.state === "ASKED"));
    check("nothing has gone to the lender yet", mails.length === 0);
    const refId = ask?.buttons?.[0].split(":")[1] ?? "";
    check("a tap from any other number answers nothing", (await onLenderAnswer({ orgId, referralId: refId, yes: true, phone: "+919000000799" })) === "IGNORED" && mails.length === 0);
    await ingestWhatsApp({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: waMeta, messages: [
      { id: `in.${tag}.lender`, from: "919000000702", timestamp: "5", type: "button", button: { text: "Haan, share karein", payload: ask!.buttons![0] } },
    ] } }] }] });
    check("their yes sends each lender asked the name and number, in the order listed, and nothing else of the lead's",
      mails.map((m) => m.to).join() === "loans@bank.example,home@second.example,loans@third.example"
      && mails.every((m) => m.text.includes("+919000000702") && m.text.includes("Arjun Mehta")), mails.map((m) => m.to).join());
    const reveals = (await sql<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'lead.phone_unmasked' AND target_id = ${loanBuyer.leadId}`)
      .filter((r) => r.metadata.to === "lender");
    check("each number leaving is its own audited reveal, naming its lender and never the number",
      reveals.length === 3 && new Set(reveals.map((r) => r.metadata.lender_id)).size === 3 && !reveals.some((r) => JSON.stringify(r.metadata).includes("9000000702")));
    check("every lender of the question is marked sent", (await sql`
      SELECT 1 FROM lender_referrals WHERE org_id = ${orgId} AND lead_id = ${loanBuyer.leadId} AND state = 'SENT'`).length === 3);
    check("tapping yes again sends nobody twice",
      (await onLenderAnswer({ orgId, referralId: refId, yes: true, phone: "+919000000702" })) === "IGNORED" && mails.length === 3);
    check("and the tap is not flagged as a reply to read", !((await lead(loanBuyer.leadId)).needs_person ?? "").startsWith("Replied"));

    // The loan is the loan executive's to follow from here.
    const opened = await loanFor(orgId, loanBuyer.leadId);
    check("their yes opens the loan as needing one, the bank left open when three were asked about",
      opened?.stage === "INTERESTED" && opened.lenderId === null && opened.source === "LENDER_YES", JSON.stringify(opened));
    const [firstLender] = await sql<{ id: string }[]>`SELECT id FROM lenders WHERE org_id = ${orgId} AND name = 'Check Bank'`;
    const loanForm = (f: Record<string, string>) => readLoanForm(f) as LoanInput;
    const step = (f: Record<string, string>) => saveLoan({ orgId, userId: admin.id, leadId: loanBuyer.leadId, input: loanForm(f) });
    check("an application with no bank is refused", (await step({ stage: "APPLIED" })).ok === false);
    check("applied with a listed bank, then sanctioned with its amount",
      (await step({ stage: "APPLIED", lender: firstLender.id })).ok && (await step({ stage: "SANCTIONED", lender: firstLender.id, amount: "72 lakh", agreement: "96 lakh" })).ok);
    const sanctioned = await loanFor(orgId, loanBuyer.leadId);
    check("the loan reads back with the bank and the amount",
      sanctioned?.stage === "SANCTIONED" && sanctioned.bank === "Check Bank" && sanctioned.amountPaise === 720_000_000, JSON.stringify(sanctioned));
    check("a sanctioned loan cannot be marked rejected", (await step({ stage: "REJECTED", lender: firstLender.id, reason: "CREDIT" })).ok === false);
    const again = await step({ stage: "SANCTIONED", lender: firstLender.id, amount: "72,00,000", agreement: "96,00,000" });
    check("saving the same again changes nothing", again.ok && !again.changed);
    check("a bank from another organisation is never believed",
      (await saveLoan({ orgId, userId: admin.id, leadId: loanBuyer.leadId, input: { ...loanForm({ stage: "DISBURSED", lender: firstLender.id, amount: "72 lakh" }), lenderId: "00000000-0000-4000-8000-000000000000" } })).ok === false);
    // Documents, then the demands: the buyer's own Rs 24 lakh goes first.
    const docs = await saveDocuments({ orgId, userId: admin.id, leadId: loanBuyer.leadId, ticked: ["PAN", "AFS", "NOT_A_DOC"], today: "2026-10-13" });
    check("documents are saved, and a key the checklist does not know is not", docs.ok && JSON.stringify(Object.keys((await loanFor(orgId, loanBuyer.leadId))!.documents).sort()) === '["AFS","PAN"]');
    // The buyer's answer about telling a partner: only their own number, only once asked.
    const loanRow = (await loanFor(orgId, loanBuyer.leadId))!;
    check("a tap before anybody asked is ignored", (await onLoanShareAnswer({ orgId, loanId: loanRow.id, yes: true, phone: "+919000000702" })) === "IGNORED");
    await sql`UPDATE lead_loans SET partner_share = 'ASKED' WHERE id = ${loanRow.id}`;
    check("a tap from another number is ignored", (await onLoanShareAnswer({ orgId, loanId: loanRow.id, yes: true, phone: "+919000000799" })) === "IGNORED");
    check("the buyer's own tap is recorded, as WhatsApp",
      (await onLoanShareAnswer({ orgId, loanId: loanRow.id, yes: true, phone: "+919000000702" })) === "SAVED"
      && (await loanFor(orgId, loanBuyer.leadId))?.partnerShare === "YES" && (await loanFor(orgId, loanBuyer.leadId))?.partnerShareSource === "WHATSAPP");
    const demand = (milestone: string, amount: string) => addDemand({ orgId, userId: admin.id, leadId: loanBuyer.leadId, input: readDemandForm({ milestone, demandOn: "2026-10-10", amount }, "2026-10-13") as DemandInput });
    check("two demands recorded", (await demand("BOOKING", "9,60,000")).ok && (await demand("AGREEMENT", "19,20,000")).ok);
    const dRows = await sql<{ id: string; milestone: string; buyer_share_paise: string; bank_share_paise: string }[]>`
      SELECT d.id, d.milestone, d.buyer_share_paise::text, d.bank_share_paise::text FROM lead_loan_demands d JOIN lead_loans o ON o.id = d.loan_id
      WHERE o.org_id = ${orgId} AND o.lead_id = ${loanBuyer.leadId} ORDER BY d.created_at`;
    check("the buyer pays the booking, and the agreement until their own share is spent, the bank the rest",
      dRows.map((d) => `${d.milestone}:${Number(d.buyer_share_paise) / 100}:${Number(d.bank_share_paise) / 100}`).join() === "BOOKING:960000:0,AGREEMENT:1440000:480000",
      dRows.map((d) => `${d.milestone}:${d.buyer_share_paise}:${d.bank_share_paise}`).join());
    const agreementDemand = dRows[1].id;
    const stepIt = (s: Parameters<typeof stepDemand>[0]["step"]) => stepDemand({ orgId, userId: admin.id, leadId: loanBuyer.leadId, demandId: agreementDemand, step: s, today: "2026-10-13" });
    check("the bank cannot be paid more than its share", (await stepIt({ kind: "BANK_PAID", on: "2026-10-12", amountRupees: 5_00_000 })).ok === false);
    check("sent to the bank, then the bank paid, and the loan is disbursing",
      (await stepIt({ kind: "SENT", on: "2026-10-11" })).ok && (await stepIt({ kind: "BANK_PAID", on: "2026-10-12", amountRupees: 4_80_000 })).ok
      && (await loanFor(orgId, loanBuyer.leadId))?.stage === "DISBURSING");
    check("a demand the bank paid on cannot be cancelled", (await stepIt({ kind: "CANCEL" })).ok === false);
    check("the bank's payment cannot be recorded twice", (await stepIt({ kind: "BANK_PAID", on: "2026-10-13", amountRupees: 1_000 })).ok === false);
    check("fully disbursed, and then nothing more", (await step({ stage: "DISBURSED", lender: firstLender.id, amount: "72 lakh", agreement: "96 lakh" })).ok
      && (await step({ stage: "DISBURSED", lender: firstLender.id, amount: "70 lakh", agreement: "96 lakh" })).ok === false);
    const loanLines = await sql<{ reason: string }[]>`
      SELECT reason FROM lead_activity WHERE org_id = ${orgId} AND lead_id = ${loanBuyer.leadId} AND reason LIKE 'Home loan:%' ORDER BY at`;
    const wantLines = ["Home loan: the buyer said yes to a lender calling", "Home loan: Applied to the bank, Check Bank", "Home loan: Sanctioned, Check Bank, Rs 72,00,000", "Home loan: Fully disbursed, Check Bank, Rs 72,00,000"];
    check("each step is a line in the lead's history", JSON.stringify(loanLines.map((l) => l.reason)) === JSON.stringify(wantLines), loanLines.map((l) => l.reason).join(" | "));
    const loanAudit = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'lead.loan_updated' AND target_id = ${loanBuyer.leadId} ORDER BY created_at`;
    check("and each is audited with its stage, never an amount",
      loanAudit.map((r) => r.metadata.stage).join() === "APPLIED,SANCTIONED,DISBURSED" && !loanAudit.some((r) => JSON.stringify(r.metadata).includes("7200")),
      loanAudit.map((r) => r.metadata.stage).join());

    // A note before the visit: on the day, before the buyer is checked in.
    const booked = async (id: string, phone: string, name: string, dayAt: string) => {
      const l = await webLead(`chk-${id}-${tag}`, { name, phone, consent: "on", __now: at(plusDays(day0, 11), "11:00") });
      await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE org_id = ${orgId} AND lead_id = ${l.leadId} AND status <> 'DONE'`;
      const b = await bookVisit({ orgId, leadId: l.leadId!, atIso: dayAt, via: "CONSOLE", ifFull: "OFFER", nowIso: at(plusDays(day0, 11), "12:00") });
      return b?.kind === "CONFIRMED" ? b.visitId : "";
    };
    const todayVisit = await booked("vn4", "9000000704", "Ira Joshi", at(plusDays(day0, 12), "16:30"));
    const tomorrowVisit = await booked("vn5", "9000000705", "Om Patil", at(plusDays(day0, 13), "11:30"));
    const early = await saveNote({ orgId, userId: seller.id, authz: host, visitId: todayVisit, bytes: fifty, contentType: "audio/wav", durationMs: 50_000, nowIso: VN_NOW });
    check("a host may leave a note on the day of the visit, before check-in", early.ok);
    check("and it is marked as before the visit",
      (await sql`SELECT 1 FROM visit_notes WHERE id = ${early.ok ? early.noteId : null} AND before_visit`).length === 1
      && (await sql`SELECT 1 FROM visit_notes WHERE org_id = ${orgId} AND visit_id = ${priceBuyer.visitId} AND before_visit`).length === 0);
    const earlyState = early.ok ? await processNote(orgId, early.noteId, { nowIso: VN_NOW }) : "";
    const earlyView = await latestNote(orgId, todayVisit);
    check("it is read into a draft the host confirms after check-in, and says it came before", earlyState === "DRAFTED" && earlyView?.beforeVisit === true);
    const tooSoon = await saveNote({ orgId, userId: seller.id, authz: host, visitId: tomorrowVisit, bytes: fifty, contentType: "audio/wav", durationMs: 50_000, nowIso: VN_NOW });
    check("never on a visit that is not today", !tooSoon.ok && tooSoon.message === "A note before the visit is left on the day of the visit.");
    useLenderMail(null);
    useTranscriber(null);
    useNoteReader(null);
    await rm(dir, { recursive: true, force: true });
  }

  console.log("\nReading a call: nine fields with the buyer's words, the score, the route");
  {
    const Q_NOW = at(plusDays(day0, 7), "11:00");
    await sql`INSERT INTO sales_team (org_id, scope_node_id, name, phone) VALUES (${orgId}, ${root.id}, 'Asha Menon', '+919100000001') ON CONFLICT DO NOTHING`;
    const heard = (fields: Record<string, unknown>) => {
      qualifierAnswer = fields;
    };
    const talk = (lines: string[]) => lines.map((en_text, i) => ({ role: i % 2 ? "user" : "agent", en_text }));
    // A hot buyer: soon, decides alone, pays themselves, and a budget that fits.
    heard({
      budget_band: { value: "60L_90L", confidence: 0.9, span: "around 80 lakh", detail: null },
      configuration: { value: "2_BHK", confidence: 0.9, span: "2 BHK", detail: null },
      timeline: { value: "LE_30D", confidence: 0.9, span: "this month itself", detail: null },
      decision_maker_present: { value: "YES", confidence: 0.9, span: "I decide myself", detail: null },
      funding: { value: "SELF", confidence: 0.9, span: "own funds", detail: null },
      purpose: { value: "END_USE", confidence: 0.9, span: "to live in", detail: null },
      micro_market: null,
      current_residence: { value: "RENTED", confidence: 0.8, span: "we rent in Andheri", detail: "Andheri" },
      competing_projects: { value: "Hillside Towers", confidence: 0.9, span: "also seeing Hillside Towers", detail: null },
    });
    const hot = await webLead(`chk-q1-${tag}`, { name: "Dev Kapoor", phone: "9000000501", consent: "on", __now: Q_NOW });
    const hotCall = await lastCall(hot.leadId!);
    await hangUp(hotCall.id, {
      status: "connected", duration: 200,
      final_agent_variables: { lead_disposition: "warm_lead", call_summary: "Wants a 2 BHK soon." },
      interaction_transcript: talk([
        "Hello, am I speaking with Dev?", "Yes, I decide myself, and we are looking for a 2 BHK",
        "What budget do you have in mind?", "around 80 lakh, own funds",
        "When would you like to buy?", "this month itself, to live in. we rent in Andheri",
      ]),
    }, later(Q_NOW, 4));
    const [read] = await sql<{ qualification: Record<string, { value: string; span: string }> | null }[]>`SELECT qualification FROM calls WHERE id = ${hotCall.id}`;
    check("the call's reading keeps the fields the buyer said, with their words", read.qualification?.budget_band?.span === "around 80 lakh" && read.qualification?.timeline?.value === "LE_30D");
    check("a field whose words are not in the transcript is not kept", !read.qualification?.competing_projects);
    const hotLead = (await sql<{ score: number | null; route: string | null; facts: Record<string, string> }[]>`SELECT score, route, facts FROM leads WHERE id = ${hot.leadId}`)[0];
    check("the score is arithmetic, and a sure, soon buyer who decides is hot", (hotLead.score ?? 0) >= 70 && hotLead.route === "HOT");
    check("the board's facts are filled from what was read", hotLead.facts.config === "2 BHK" && hotLead.facts.timeline === "Within 30 days");
    check("the read is counted against the project's minutes", (await sql`
      SELECT 1 FROM usage_events WHERE org_id = ${orgId} AND source_kind = 'call' AND source_id = ${`${hotCall.id}:reading`}`).length === 1);
    const bridged = vobizCalls.find((c) => c.to === "+919100000001");
    check("a hot buyer the agent did not put through: a free sales person is rung at once", !!bridged && bridged.answerUrl.includes("ev=bridge"));
    const [bridge] = await sql<{ id: string; status: string }[]>`SELECT id, status FROM proxy_calls WHERE org_id = ${orgId} AND lead_id = ${hot.leadId} AND kind = 'BRIDGE'`;
    const whisper = await bridgeAnswer(orgId, bridge.id);
    check("they hear who is waiting and the key to press", whisper.includes("Dev") && whisper.includes("Press 1") && whisper.includes("<Gather"));
    check("any key but 1 takes nobody", (await bridgeAccept(orgId, bridge.id, { Digits: "2" }, Q_NOW)).includes("<Hangup"));
    const dial = await bridgeAccept(orgId, bridge.id, { Digits: "1" }, later(Q_NOW, 5));
    check("pressing 1 dials the buyer, from our number", dial.includes("<Dial") && dial.includes("+919000000501"));

    // A second hot buyer nobody takes: the sales person hangs up without a key.
    heard({ ...qualifierAnswer!, budget_band: { value: "60L_90L", confidence: 0.9, span: "80 lakh", detail: null } });
    const hot2 = await webLead(`chk-q2-${tag}`, { name: "Rhea Sen", phone: "9000000502", consent: "on", __now: later(Q_NOW, 60) });
    await hangUp((await lastCall(hot2.leadId!)).id, {
      status: "connected", duration: 150,
      final_agent_variables: { lead_disposition: "hot_lead" },
      interaction_transcript: talk(["Hi", "I decide myself, a 2 BHK, 80 lakh, own funds, this month itself, to live in"]),
    }, later(Q_NOW, 64));
    const [b2] = await sql<{ id: string }[]>`SELECT id FROM proxy_calls WHERE org_id = ${orgId} AND lead_id = ${hot2.leadId} AND kind = 'BRIDGE'`;
    check("the one free person is busy with the first bridge, so the second rings the org's hand-off number", !!b2);
    if (b2) await proxyHangup(orgId, b2.id);
    check("a hot buyer nobody took is flagged for a person to call now", !b2 || ((await lead(hot2.leadId!)).needs_person ?? "").startsWith("Hot lead, nobody took the call"));

    // A warm buyer with WhatsApp consent: three visit offers, each three open times.
    heard({
      budget_band: { value: "60L_90L", confidence: 0.9, span: "80 lakh", detail: null }, configuration: { value: "2_BHK", confidence: 0.9, span: "2 BHK", detail: null },
      timeline: { value: "91_180D", confidence: 0.9, span: "in five months", detail: null },
      decision_maker_present: null, funding: { value: "LOAN", confidence: 0.9, span: "home loan", detail: null },
      purpose: { value: "END_USE", confidence: 0.9, span: "to live in", detail: null },
      micro_market: null, current_residence: null, competing_projects: null,
    });
    const warm = await webLead(`chk-q3-${tag}`, { name: "Anil Rao", phone: "9000000503", consent: "on", __now: later(Q_NOW, 120) });
    await hangUp((await lastCall(warm.leadId!)).id, {
      status: "connected", duration: 120,
      final_agent_variables: { lead_disposition: "warm_lead" },
      interaction_transcript: talk(["Hi", "a 2 BHK, 80 lakh, in five months, with a home loan, to live in"]),
    }, later(Q_NOW, 124));
    const warmRow = (await sql<{ route: string | null; score: number | null }[]>`SELECT route, score FROM leads WHERE id = ${warm.leadId}`)[0];
    check("a buyer between the floors is warm", warmRow.route === "WARM");
    const reoffers = (await tasks(warm.leadId!)).filter((t) => t.purpose === "VISIT_REOFFER");
    check("three visit offers are due: in two hours, two days and a week", reoffers.length === 3 && !(await tasks(warm.leadId!)).some((t) => t.purpose === "REENGAGE_CALL" && t.state === "DUE"));
    await runLeadTasks({ orgId, leadId: warm.leadId!, nowIso: later(reoffers[0].due_at.toISOString(), 1) });
    const reoffer = sent.find((m) => tpl(m) === "salesdesk_visit_reoffer" && m.to === "+919000000503");
    check("the first goes with three open times to tap", !!reoffer && reoffer.buttons?.length === 3);
    const before = warmRow.score ?? 0;
    await ingestWhatsApp({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: waMeta, messages: [
      { id: `in.${tag}.warm`, from: "919000000503", timestamp: String(Math.floor(Date.now() / 1000) + 5), type: "text", text: { body: "Maybe next weekend" } },
    ] } }] }] });
    const after2 = (await sql<{ score: number | null }[]>`SELECT score FROM leads WHERE id = ${warm.leadId}`)[0].score ?? 0;
    check("a reply is engagement: the score rises, no model asked", after2 === before + 5);

    // A number outside India is the NRI desk's, and is not rung.
    const dialsBefore = dialled.length;
    const nri = await webLead(`chk-q4-${tag}`, { name: "Sam Patel", phone: "+14155550123", consent: "on", __now: later(Q_NOW, 180) });
    const nriRow = await lead(nri.leadId!);
    check("a buyer calling from outside India is not rung by the agent", dialled.length === dialsBefore);
    check("and goes to the NRI desk", ((nriRow.needs_person ?? "").startsWith("Buyer calling from outside India")) &&
      (await sql`SELECT 1 FROM leads WHERE id = ${nri.leadId} AND route = 'NRI'`).length === 1);
    check("and somebody owns it, desk or not", (await sql`SELECT 1 FROM leads WHERE id = ${nri.leadId} AND owner_id IS NOT NULL`).length === 1);
    qualifierAnswer = null;
    await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE org_id = ${orgId} AND to_number LIKE '+91900000050%' AND status <> 'DONE'`;
    await sql`UPDATE proxy_calls SET status = 'ENDED', ended_at = now() WHERE org_id = ${orgId} AND status IN ('RINGING', 'CONNECTED')`;
  }

  console.log("\nA Meta lead form, and the budget moving to the ad that works");
  const [conn] = await sql<{ id: string }[]>`
    INSERT INTO connections (org_id, provider, status, scopes) VALUES (${orgId}, 'META', 'CONNECTED', ${["ads_management"]}) RETURNING id`;
  const sealed = (await seal(orgId, connectionPurpose(conn.id), JSON.stringify({ access_token: "meta-test" })))!;
  await sql`UPDATE connections SET secret = ${sealed.secret}, key_version = ${sealed.keyVersion} WHERE id = ${conn.id}`;
  const [acct] = await sql<{ id: string }[]>`
    INSERT INTO connection_accounts (org_id, connection_id, kind, external_id, name, detail, scope_node_id, daily_cap, auto_budget)
    VALUES (${orgId}, ${conn.id}, 'META_AD_ACCOUNT', 'act_42', 'Sath ads', ${sql.json({ currency: "INR" })}, ${project.id}, 5000, true) RETURNING id`;
  const ads: string[] = [];
  for (const [i, name] of ["A", "B", "C"].entries()) {
    const key = createHmac("sha256", "k").update(`${tag}${name}`).digest("hex");
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO publish_targets (org_id, source, destination, account_id, kind, headline, caption, content_sha256, scope_node_id, phase_id,
                                   idempotency_key, state, daily_budget, steps, activated_at)
      VALUES (${orgId}, 'STUDIO', 'META_AD', ${acct.id}, 'IMAGE', ${`Ad ${name}`}, 'x', ${key}, ${towerC.id}, ${towerC.id},
              ${key}, 'ACTIVE', 1000, ${sql.json({ campaign_id: `camp_${name}_${tag}`, adset_id: `adset_${name}${i}` })}, now())
      RETURNING id`;
    ads.push(t.id);
    for (let dday = 1; dday <= 5; dday++) {
      await sql`INSERT INTO ad_stats (org_id, publish_target_id, day, spend_paise, clicks) VALUES (${orgId}, ${t.id}, ${plusDays(ist(new Date().toISOString()).date, -dday)}, 140000, 40)`;
    }
  }
  // Ad A brings qualified buyers; B and C bring nothing anybody qualified.
  for (let n = 0; n < 5; n++) {
    await sql`
      INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, publish_target_id, stage, path_stage)
      VALUES (${orgId}, ${towerC.id}, ${`Ad lead ${n}`}, ${`+9190000003${String(n).padStart(2, "0")}`}, 'Meta ad', 'WEBSITE', ${ads[0]}, 'qualified', 'qualified')`;
  }
  const metaEv = await recordEvent({
    orgId, source: "META_FORM", externalId: `lg-${tag}`,
    payload: {
      ping: { leadgenId: `9${Date.now()}`, pageId: "555", formId: "f1", adId: null, adgroupId: null, createdTime: null },
      accountId: acct.id,
      lead: { field_data: [{ name: "full_name", values: ["Sunita Desai"] }, { name: "phone_number", values: ["+919000000208"] }], campaign_id: `camp_A_${tag}`, custom_disclaimer_responses: [{ is_checked: true }] },
    },
  });
  const metaLead = await processEvent(orgId, metaEv.id, { nowIso: NOON });
  const [ml] = metaLead.ok
    ? await sql<{ channel: string; publish_target_id: string | null; scope_node_id: string }[]>`SELECT channel, publish_target_id, scope_node_id FROM leads WHERE id = ${metaLead.leadId}`
    : [];
  check("a Meta form lead is tied to the ad that bought it, and its tower", ml?.channel === "META_FORM" && ml.publish_target_id === ads[0] && ml.scope_node_id === towerC.id);
  const moved = await rebalanceBudgets(orgId, new Date());
  const [total] = await sql<{ sum: number }[]>`SELECT sum(daily_budget)::int AS sum FROM publish_targets WHERE id = ANY(${ads})`;
  const [winner] = await sql<{ daily_budget: number }[]>`SELECT daily_budget FROM publish_targets WHERE id = ${ads[0]}`;
  check("budget moves from the two losing ads to the winner", moved.shifts >= 2 && winner.daily_budget > 1000, JSON.stringify(moved));
  check("the total the developer approved is unchanged", total.sum === 3000, String(total.sum));
  check("Meta was asked to change each ad set's budget", budgets.length === moved.shifts);
  check("every move is on record with the numbers the rule read",
    (await sql`SELECT 1 FROM budget_shifts WHERE org_id = ${orgId} AND state = 'APPLIED' AND metrics ? 'groupCost'`).length === moved.shifts);
  check("and a second pass the same day moves nothing", (await rebalanceBudgets(orgId, new Date())).shifts === 0);

  console.log("\nToday from the reports: a pause worth deciding, and campaigns whose qualified leads rarely book");
  {
    check("with nothing costly and no full quarter behind it, Today says nothing from the reports",
      (await readReportAlerts(orgId)).length === 0, JSON.stringify(await readReportAlerts(orgId)));
    // Ad C costs far more than the others and has brought nobody.
    await sql`UPDATE ad_stats SET spend_paise = 400000 WHERE publish_target_id = ${ads[2]}`;
    const withPause = await readReportAlerts(orgId);
    const pause = withPause.find((a) => a.id === "ad-pause-proposed");
    check("an ad costing twice its group is proposed for a pause, for the budget key, on Published",
      !!pause && pause.title === "1 ad costs twice the others per buyer" && pause.resolvers.join() === "campaign.budget:manage" && pause.href === "/dashboard/campaigns/live?view=ads",
      JSON.stringify(withPause));
    // The last full quarter: one campaign's qualified leads book, the other's never do.
    const quarter = lastFullQuarter(ist(new Date().toISOString()).date);
    const inQuarter = `${plusDays(quarter.from, 20)}T06:00:00Z`;
    for (let n = 0; n < 60; n++) {
      const good = n < 40;
      const booked = good && n < 20;
      await sql`
        INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, stage, path_stage, created_at)
        VALUES (${orgId}, ${towerC.id}, ${`Quarter ${n}`}, ${`+9190000008${String(n).padStart(2, "0")}`}, ${good ? "Campaign Books" : "Campaign Rarely"}, 'WEBSITE',
                ${booked ? "booked" : "qualified"}, ${booked ? "booked" : "qualified"}, ${inQuarter})`;
    }
    const withQuarter = await readReportAlerts(orgId);
    const q = withQuarter.find((a) => a.id === "quarter-check");
    check("a campaign whose qualified leads rarely book is named on Today as a count, for the report key, linking to its card",
      !!q && q.title === "Qualified leads from 1 campaign rarely book" && q.resolvers.join() === "report:read"
      && q.href === "/dashboard/reports#rp-quarter" && q.why.startsWith(`Leads from ${quarter.label}.`) && !JSON.stringify(q).includes("Campaign Rarely"),
      JSON.stringify(withQuarter));
    await sql`DELETE FROM leads WHERE org_id = ${orgId} AND name LIKE 'Quarter %'`;
  }

  console.log("\nErasing a buyer takes their other numbers and the CRM's copy, and the lead is never moved again");
  {
    const { eraseBuyer } = await import("../src/lib/erasure.ts");
    const er = await webLead(`chk-erase-${tag}`, { name: "Kavya Deshmukh", phone: "9000000887", __now: LATE });
    const erId = er.leadId!;
    await sql`UPDATE lead_tasks SET state = 'CANCELLED' WHERE lead_id = ${erId} AND state = 'DUE'`;
    await sql`INSERT INTO lead_phones (org_id, lead_id, phone, kind, added_by) VALUES (${orgId}, ${erId}, '+919000000888', 'ALTERNATE', ${admin.id})`;
    const [conn] = await sql<{ id: string }[]>`
      INSERT INTO crm_connections (org_id, provider, status, connected_by) VALUES (${orgId}, 'LEADRAT', 'DISCONNECTED', ${admin.id}) RETURNING id`;
    await sql`INSERT INTO crm_links (org_id, connection_id, lead_id, external_id, base)
      VALUES (${orgId}, ${conn.id}, ${erId}, ${`erase-${tag}`}, ${sql.json({ name: "Kavya Deshmukh", phone: "+919000000887" } as never)})`;
    const [rootPath] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE id = ${root.id}`;
    const authz = buildAuthz([{ role: "ORG_ADMIN", roleLabel: "Admin", scopeNodeId: root.id, scopePath: rootPath.path, scopeKind: "ORG",
      scopeName: "", permissions: new Set(["*"]) }]);
    const erased = await eraseBuyer({ orgId, userId: admin.id, authz, leadId: erId });
    check("the buyer is erased", erased.ok, erased.message);
    check("their other numbers are taken off",
      (await sql`SELECT 1 FROM lead_phones WHERE lead_id = ${erId} AND removed_at IS NULL`).length === 0);
    check("the CRM link is closed and keeps no name or number",
      (await sql`SELECT 1 FROM crm_links WHERE lead_id = ${erId} AND removed_reason = 'ERASED' AND base = '{}'::jsonb`).length === 1);
    const moved = await moveLead({ orgId, userId: admin.id, leadId: erId, to: "contacted",
      input: { facts: { contactChannel: "AI voice call", contactedOn: day0 }, note: "Kavya Deshmukh, 9000000887" }, today: day0 });
    check("an erased lead cannot be moved, and no note lands on it",
      !moved.ok && (await sql`SELECT 1 FROM lead_activity WHERE lead_id = ${erId} AND note IS NOT NULL`).length === 0, JSON.stringify(moved));
    await sql`DELETE FROM crm_links WHERE lead_id = ${erId}`;
    await sql`DELETE FROM crm_connections WHERE id = ${conn.id}`;
    await sql`DELETE FROM lead_phones WHERE lead_id = ${erId}`;
  }

  console.log("\nIsolation");
  const [other] = await sql<{ id: string }[]>`SELECT id FROM orgs WHERE id <> ${orgId} LIMIT 1`;
  if (other) {
    const { withTenant } = await import("../src/lib/db/index.ts");
    const seen = await withTenant(other.id, (s) => s`SELECT count(*)::int AS n FROM leads WHERE org_id = ${orgId}`);
    const tasksSeen = await withTenant(other.id, (s) => s`SELECT count(*)::int AS n FROM lead_tasks WHERE org_id = ${orgId}`);
    const msgsSeen = await withTenant(other.id, (s) => s`SELECT count(*)::int AS n FROM messages WHERE org_id = ${orgId}`);
    check("another tenant sees none of these leads, tasks or messages",
      (seen[0] as { n: number }).n === 0 && (tasksSeen[0] as { n: number }).n === 0 && (msgsSeen[0] as { n: number }).n === 0);
  }
  check("Meta's signature check refuses an unsigned body", !metaSignatureValid("{}", null, "s"));
  const unguarded = await sql<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
    JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
    WHERE c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname NOT IN ('audit_log', 'orgs')`;
  check("every table carrying a tenant is under row-level security", unguarded.length === 0, unguarded.map((r) => r.relname).join(", "));
  const grants = await sql<{ table_name: string; privilege_type: string }[]>`
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'salesdesk_app' AND table_name IN ('lead_activity', 'budget_shifts', 'lead_events', 'messages', 'site_visits')`;
  const has = (t: string, p: string) => grants.some((g) => g.table_name === t && g.privilege_type === p);
  check("a lead's history and a budget move can be added and never changed or removed",
    !has("lead_activity", "UPDATE") && !has("lead_activity", "DELETE") && !has("budget_shifts", "UPDATE") && !has("budget_shifts", "DELETE"));
  check("a raw capture event, a message and a visit are never deleted by the app",
    !has("lead_events", "DELETE") && !has("messages", "DELETE") && !has("site_visits", "DELETE"));
} finally {
  useDnd(null);
  usePlatform(null);
  useVaultKey(null);
  await dropFixtureNumbers(sql, orgId);
  await sql`DELETE FROM messages WHERE org_id = ${orgId}`;
  await sql`DELETE FROM site_visits WHERE org_id = ${orgId}`;
  await sql`DELETE FROM proxy_calls WHERE org_id = ${orgId}`;
  await sql`DELETE FROM lead_loans WHERE org_id = ${orgId}`;
  await sql`DELETE FROM lender_referrals WHERE org_id = ${orgId}`;
  await sql`DELETE FROM calls WHERE org_id = ${orgId}`;
  await sql`DELETE FROM leads WHERE org_id = ${orgId}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  await sql`DELETE FROM orgs WHERE id = ${orgId}`;
  await sql`DELETE FROM users WHERE id IN (${admin.id}, ${seller.id})`;
  await sql`DELETE FROM users WHERE email_domain = ${`leads${tag}.example`}`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
