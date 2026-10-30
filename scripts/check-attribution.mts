/**
 * Closed-loop attribution, end to end, with Meta and Google injected.
 *
 * The suite builds a tenant of its own, moves real leads on the real board
 * functions, and asserts what the outcome log and the upload queue say. The
 * platforms are a fake at the same URLs (`usePlatform()`), so nothing is sent
 * to Meta or Google and no test event reaches anybody's Events Manager:
 * Meta's own test events are not discarded, they reach targeting.
 *
 * Time is passed in where the code takes it, so the suite runs the same at
 * 3 pm and at 3 am.
 */
import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { closeDb } from "../src/lib/db/index.ts";
import { moveLead, applyEngineMove } from "../src/lib/leads.ts";
import { recordMilestone, leadOutcomes } from "../src/lib/attribution.ts";
import { sendOutcomes } from "../src/lib/attribution-send.ts";
import { usePlatform } from "../src/lib/platform.ts";
import { useVaultKey, seal, connectionPurpose } from "../src/lib/vault.ts";
import { canPublish } from "../src/lib/publish-gate.ts";
import { readReportAlerts } from "../src/lib/report-alerts.ts";
import { metaAdGoal, qualifiedConversionRule } from "../src/lib/attribution-rules.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// Both platforms switched on for this process, against the fake below.
for (const [k, v] of Object.entries({
  META_APP_ID: "test-app",
  META_APP_SECRET: "test-secret",
  GOOGLE_CONNECT_CLIENT_ID: "test-client",
  GOOGLE_CONNECT_CLIENT_SECRET: "test-client-secret",
  GOOGLE_DATA_MANAGER: "on",
})) process.env[k] = v;
useVaultKey(randomBytes(32));

// ---------------------------------------------------------------------------
// The platforms, faked at their own addresses
// ---------------------------------------------------------------------------
//
// Meta is modelled as deduping on event_id and Google on transaction id, the
// way each documents it. `lose` makes the next send land and its answer
// vanish, which is the case a retry has to survive.

type MetaSent = { dataset: string; eventId: string; name: string; time: number; raw: string; ph: string | null };
const metaSent: MetaSent[] = [];
const googleSent: { transactionId: string; action: string; timestamp: string; phone: string | null; gclid: string }[] = [];
const googleActions = new Map<string, string>();
let lose: "META" | "GOOGLE" | null = null;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
usePlatform(async (url, init) => {
  const u = new URL(url);
  if (u.host === "oauth2.googleapis.com") return reply({ access_token: "google-access", expires_in: 3600 });
  const metaEvents = /^\/v26\.0\/(\d+)\/events$/.exec(u.pathname);
  if (u.host === "graph.facebook.com" && metaEvents && init.method === "POST") {
    const raw = new URLSearchParams(String(init.body ?? "")).get("data") ?? "[]";
    for (const e of JSON.parse(raw.replace(/"lead_id":(\d+)/g, '"lead_id":"$1"'))) {
      metaSent.push({ dataset: metaEvents[1], eventId: e.event_id, name: e.event_name, time: e.event_time, raw, ph: e.user_data?.ph?.[0] ?? null });
    }
    if (lose === "META") {
      lose = null;
      throw new Error("socket hang up");
    }
    return reply({ events_received: 1, fbtrace_id: "fake" });
  }
  // Ads Insights: daily rows with time_increment, one window figure without.
  const insights = /^\/v26\.0\/camp_(\w+)\/insights$/.exec(u.pathname);
  if (u.host === "graph.facebook.com" && insights) {
    const tiredAd = insights[1] === "tired";
    if (!u.searchParams.has("time_increment")) {
      return reply({ data: [{ reach: "2000", impressions: "7000", frequency: tiredAd ? "3.8" : "1.5" }] });
    }
    const range = JSON.parse(u.searchParams.get("time_range") ?? "{}") as { since: string; until: string };
    const days: Record<string, string>[] = [];
    for (let t = Date.parse(`${range.since}T00:00:00Z`); t < Date.parse(`${range.until}T00:00:00Z`); t += 86_400_000) {
      days.push({ date_start: new Date(t).toISOString().slice(0, 10), spend: "2000", impressions: "1000", clicks: tiredAd ? "10" : "20" });
    }
    return reply({ data: days });
  }
  if (u.host === "googleads.googleapis.com" && u.pathname.endsWith("/googleAds:search")) {
    const name = /conversion_action\.name = '([^']+)'/.exec(JSON.parse(String(init.body)).query)?.[1] ?? "";
    const id = googleActions.get(name);
    return reply({ results: id ? [{ conversionAction: { id, name } }] : [] });
  }
  if (u.host === "googleads.googleapis.com" && u.pathname.endsWith("/conversionActions:mutate")) {
    const create = JSON.parse(String(init.body)).operations[0].create;
    const id = String(7000 + googleActions.size);
    googleActions.set(create.name, id);
    return reply({ results: [{ resourceName: `customers/1234567890/conversionActions/${id}` }] });
  }
  if (u.host === "datamanager.googleapis.com" && u.pathname === "/v1/events:ingest") {
    const b = JSON.parse(String(init.body));
    const e = b.events[0];
    googleSent.push({
      transactionId: e.transactionId,
      action: b.destinations[0].productDestinationId,
      timestamp: e.eventTimestamp,
      phone: e.userData?.userIdentifiers?.[0]?.phoneNumber ?? null,
      gclid: e.adIdentifiers.gclid,
    });
    if (lose === "GOOGLE") {
      lose = null;
      throw new Error("socket hang up");
    }
    return reply({ requestId: `req-${googleSent.length}` });
  }
  return reply({ error: { message: `no route for ${u.host}${u.pathname}` } }, 404);
});

// ---------------------------------------------------------------------------
// A tenant of its own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const [admin] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`admin@attr${tag}.example`}, ${`attr${tag}.example`}, 'Attribution Admin') RETURNING id`;
const [seller] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name) VALUES (${`neha@attr${tag}.example`}, ${`attr${tag}.example`}, 'Neha Kulkarni') RETURNING id`;
const [org] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
  VALUES ('DEVELOPER', 'Sath Group', 'Sath Group', 'AAPFU0939F', ${`attr${tag}.example`}, ${admin.id}) RETURNING id`;
const orgId = org.id;
const [root] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${orgId}, NULL, 'ORG', 'Sath Group', ${`attr_${tag}`}, ${`attr_${tag}`}::ltree) RETURNING id, path::text AS path`;
const node = async (parent: { id: string; path: string }, kind: string, name: string, slug: string) => {
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${orgId}, ${parent.id}, ${kind}, ${name}, ${slug}, ${`${parent.path}.${slug}`}::ltree) RETURNING id, path::text AS path`;
  return row;
};
const entity = await node(root, "ENTITY", "Sath Heights LLP", "sath_llp");
const region = await node(entity, "REGION", "Mumbai", "mumbai");
const project = await node(region, "PROJECT", "Sath Heights", "sath_heights");
const towerC = await node(project, "PHASE", "Tower C", "tower_c");
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${orgId}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${seller.id}, ${orgId}, ${project.id}, 'PROJECT_SALES_MANAGER', 'ACTIVE')`;

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const DAY = 86_400_000;

/** A lead as capture would have left it, with or without consent to measure. */
async function makeLead(o: { phone: string; channel: string; externalId?: string; lineage?: Record<string, string>; measured: boolean }): Promise<string> {
  const [l] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, external_id, lineage)
    VALUES (${orgId}, ${towerC.id}, 'Fixture Buyer', ${o.phone}, 'Fixture', ${o.channel}, ${o.externalId ?? null}, ${sql.json(o.lineage ?? {})})
    RETURNING id`;
  if (o.measured) {
    await sql`
      INSERT INTO lead_consents (org_id, phone, channels, wording, source)
      VALUES (${orgId}, ${o.phone}, ${["ad_measurement"]}, 'Agreed to ad measurement.', 'Fixture')`;
  }
  return l.id;
}

const events = (leadId: string) =>
  sql<{ id: string; kind: string; booking_id: string | null; value: number; lineage: Record<string, string> }[]>`
    SELECT id, kind, booking_id, value, lineage FROM outcome_events WHERE lead_id = ${leadId} ORDER BY occurred_at, id`;
const uploads = (leadId: string) =>
  sql<{ kind: string; platform: string; state: string; reason: string | null; not_before: Date }[]>`
    SELECT e.kind, u.platform, u.state, u.reason, u.not_before FROM outcome_uploads u JOIN outcome_events e ON e.id = u.event_id
    WHERE e.lead_id = ${leadId} ORDER BY e.occurred_at, e.id`;

const BOOKING = {
  contactChannel: "Phone call", contactedOn: today,
  config: "2 BHK", budget: "Rs 90 lakh to 1.5 Cr", timeline: "1 to 3 months", owner: "Neha Kulkarni",
  visitDate: today, visitTime: "11:00", visitHost: "Neha Kulkarni",
  interest: "Hot", objection: "None",
  unit: "C-1203", quote: "14500000", bookedOn: today, agreement: "14500000", token: "500000",
};

try {
  console.log("\nA move writes its outcomes, in the move's own transaction");
  const metaLead = await makeLead({ phone: "+919900001001", channel: "META_FORM", externalId: "12345678901234567", lineage: { adId: "238" }, measured: true });
  const booked = await moveLead({ orgId, userId: seller.id, leadId: metaLead, to: "booked", today, input: { facts: BOOKING } });
  check("a lead moved straight to Booked is saved", booked.ok, booked.ok ? "" : booked.message);
  const e1 = await events(metaLead);
  check("and is qualified, visited and booked in the log", e1.map((e) => e.kind).join() === "QUALIFIED,VISIT_DONE,BOOKED", e1.map((e) => e.kind).join());
  check("each outcome carries the fixed value, never the agreement", e1.map((e) => e.value).join() === "2000,10000,100000");
  check("the lineage carries the leadgen id and no phone", e1[0].lineage.leadgenId === "12345678901234567" && !("phone" in e1[0].lineage));
  const u1 = await uploads(metaLead);
  check("qualified and the visit are queued for Meta", u1.filter((u) => u.state === "QUEUED" && u.platform === "META").length === 2);
  const held = u1.find((u) => u.kind === "BOOKED");
  check("the booking waits out the 30-day hold", held?.state === "WAITING" && held.reason === "HELD" &&
    Math.abs(held.not_before.getTime() - Date.now() - 30 * DAY) < DAY);

  console.log("\nA cancellation inside the hold means the booking is never sent");
  const back = await moveLead({ orgId, userId: seller.id, leadId: metaLead, to: "negotiation", today, input: { facts: {}, reason: "Loan not approved" } });
  check("leaving Booked is saved", back.ok, back.ok ? "" : back.message);
  const e2 = await events(metaLead);
  const cancelled = e2.find((e) => e.kind === "CANCELLED");
  check("a cancellation is written, pointing at the booking", !!cancelled && cancelled.booking_id === e1[2].id);
  check("the held booking will never be sent", (await uploads(metaLead)).find((u) => u.kind === "BOOKED")?.reason === "CANCELLED");
  check("and the cancellation itself goes nowhere", !(await uploads(metaLead)).some((u) => u.kind === "CANCELLED"));

  const again = await moveLead({ orgId, userId: seller.id, leadId: metaLead, to: "booked", today, input: { facts: BOOKING } });
  check("booking again is saved", again.ok, again.ok ? "" : again.message);
  const e3 = await events(metaLead);
  check("as a second booking, and qualified is still once", e3.filter((e) => e.kind === "BOOKED").length === 2 && e3.filter((e) => e.kind === "QUALIFIED").length === 1);

  console.log("\nAgreement and registration, recorded by a person");
  const early = await recordMilestone({ orgId, userId: seller.id, leadId: metaLead, kind: "REGISTERED", day: today, today });
  check("a registration before the agreement is refused", !early.ok && early.message === "Record the agreement first.");
  const agreed = await recordMilestone({ orgId, userId: seller.id, leadId: metaLead, kind: "AGREEMENT", day: today, today });
  check("the agreement is recorded", agreed.ok);
  const twice = await recordMilestone({ orgId, userId: seller.id, leadId: metaLead, kind: "AGREEMENT", day: today, today });
  check("and only once", !twice.ok);
  const registered = await recordMilestone({ orgId, userId: seller.id, leadId: metaLead, kind: "REGISTERED", day: today, today });
  check("then the registration", registered.ok);
  const view = await leadOutcomes(orgId, metaLead);
  check("the lead's page reads every milestone and has nothing left to record", view.outcomes.length === 7 && view.next === null && view.measured);
  const liveBooking = e3.filter((e) => e.kind === "BOOKED")[1].id;
  const [ms] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outcome_events WHERE booking_id = ${liveBooking} AND kind IN ('AGREEMENT', 'REGISTERED')`;
  check("both belong to the booking that stands", ms.n === 2);
  const audits = await sql<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'lead.milestone'`;
  check("the audit row names the kind and nothing typed", audits.length === 2 && audits.every((a) => Object.keys(a.metadata).join() === "kind"));

  console.log("\nConsent, and the platform that bought the lead");
  const googleLead = await makeLead({ phone: "+919900001002", channel: "WEBSITE", lineage: { gclid: "Cj0KCQjw-fixture", utmSource: "google" }, measured: false });
  const moved = await applyEngineMove({ orgId, leadId: googleLead, move: { to: "qualified", facts: {}, why: "Qualified on the call" } as never });
  check("the engine's own move writes its outcome", moved?.to === "qualified" && (await events(googleLead)).length === 1);
  const gu = await uploads(googleLead);
  check("a Google lead goes back to Google, not Meta", gu.length === 1 && gu[0].platform === "GOOGLE");
  check("and without consent to measure it is never sent", gu[0].state === "NOT_SENT" && gu[0].reason === "NO_CONSENT");

  const walkIn = await makeLead({ phone: "+919900001003", channel: "MANUAL", measured: true });
  await applyEngineMove({ orgId, leadId: walkIn, move: { to: "qualified", facts: {}, why: "Qualified" } as never });
  check("a walk-in has outcomes and nothing to send", (await events(walkIn)).length === 1 && (await uploads(walkIn)).length === 0);

  // -------------------------------------------------------------------------
  console.log("\nNothing goes before an account is chosen");
  const T0 = Date.now();
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const unset = await sendOutcomes(orgId, { nowIso: at(0) });
  check("with no dataset chosen, Meta outcomes wait for one", unset.sent === 0 && unset.waiting > 0 && metaSent.length === 0);
  check("and say so on the lead's page", (await leadOutcomes(orgId, metaLead)).outcomes[0].uploads[0].reason === "NOT_CONNECTED");

  // One Meta connection with a dataset and one Google connection with an Ads
  // account, both serving the whole organisation.
  const connect = async (provider: string, scopes: string[], secret: Record<string, string>, kind: string, externalId: string, detail: Record<string, unknown>) => {
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO connections (org_id, provider, status, scopes) VALUES (${orgId}, ${provider}, 'CONNECTED', ${scopes}) RETURNING id`;
    const sealed = (await seal(orgId, connectionPurpose(c.id), JSON.stringify(secret)))!;
    await sql`UPDATE connections SET secret = ${sealed.secret}, key_version = ${sealed.keyVersion} WHERE id = ${c.id}`;
    await sql`
      INSERT INTO connection_accounts (org_id, connection_id, kind, external_id, name, detail, scope_node_id)
      VALUES (${orgId}, ${c.id}, ${kind}, ${externalId}, 'Fixture', ${sql.json(detail as never)}, ${root.id})`;
  };
  await connect("META", ["ads_management"], { access_token: "meta-system-user" }, "META_DATASET", "900000000000001", {});
  await connect("GOOGLE", ["https://www.googleapis.com/auth/adwords", "https://www.googleapis.com/auth/datamanager"],
    { refresh_token: "google-refresh" }, "GOOGLE_ADS_CUSTOMER", "1234567890", { currency: "INR", login_customer_id: null });
  // Setup waits an hour between looks; nobody needs to wait for the suite.
  await sql`UPDATE outcome_uploads SET not_before = now() WHERE org_id = ${orgId} AND state = 'WAITING' AND reason = 'NOT_CONNECTED'`;

  console.log("\nAn outcome survives a lost answer and is uploaded once");
  const webMeta = await makeLead({ phone: "+919900002001", channel: "WEBSITE", lineage: { fbc: "fb.1.1727500000000.IwAR2fixture01", utmSource: "facebook" }, measured: true });
  const webGoogle = await makeLead({ phone: "+919900002002", channel: "WEBSITE", lineage: { gclid: "Cj0KCQjw-fixture-2", utmSource: "google" }, measured: true });
  for (const id of [webMeta, webGoogle]) await applyEngineMove({ orgId, leadId: id, move: { to: "qualified", facts: {}, why: "Qualified" } as never });

  const blocked = await canPublish(orgId, towerC.id);
  check("Tower C may not be advertised (no registration on file)", !blocked.ok);

  lose = "META";
  const p1 = await sendOutcomes(orgId, { nowIso: at(60_000) });
  const lostId = metaSent[0]?.eventId;
  check("the first pass sends Meta its outcomes, one answer lost on the way", p1.sent >= 2 && !!lostId);
  const [lostRow] = await sql<{ state: string; tried_at: Date | null; sent_at: Date | null }[]>`
    SELECT u.state, u.tried_at, u.sent_at FROM outcome_uploads u WHERE u.event_id = ${lostId} AND u.platform = 'META'`;
  check("the lost one is on record as tried and not confirmed", lostRow.state === "QUEUED" && !!lostRow.tried_at && !lostRow.sent_at);
  const p2 = await sendOutcomes(orgId, { nowIso: at(20 * 60_000) });
  const sentLost = metaSent.filter((m) => m.eventId === lostId);
  check("the next pass sends it again with the same event id, never a new one", p2.sent === 1 && sentLost.length === 2 && new Set(sentLost.map((m) => m.raw)).size === 1);
  check("so Meta holds each outcome once", new Set(metaSent.map((m) => m.eventId)).size === (await sql`
    SELECT 1 FROM outcome_uploads WHERE org_id = ${orgId} AND platform = 'META' AND state = 'SENT'`).length);
  check("an outcome is sent although its tower may not be advertised (reporting, not advertising)",
    (await uploads(webMeta)).every((u) => u.state === "SENT"));

  const g1 = (await uploads(webGoogle))[0];
  check("Google's first outcome waits while its new conversion actions settle, all five made at once", g1.state === "WAITING" && g1.reason === "ACTION_NEW" && googleActions.size === 5);
  lose = "GOOGLE";
  await sendOutcomes(orgId, { nowIso: at(7 * 3_600_000) });
  check("then goes, and its answer is lost", googleSent.length === 1 && (await uploads(webGoogle))[0].state === "QUEUED");
  await sendOutcomes(orgId, { nowIso: at(7 * 3_600_000 + 20 * 60_000) });
  check("sent again under the same transaction id, which Google counts once",
    googleSent.length === 2 && googleSent[0].transactionId === googleSent[1].transactionId && (await uploads(webGoogle))[0].state === "SENT");
  check("into the conversion action made for it", googleSent.every((g) => g.action === googleActions.get("Sales Desk: Qualified lead")));
  check("the unconsented Google lead was never sent", (await uploads(googleLead))[0].state === "NOT_SENT" && !googleSent.some((g) => g.gclid === "Cj0KCQjw-fixture"));

  console.log("\nEach platform gets the phone hashed its own way");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const metaWebSent = metaSent.find((m) => m.raw.includes("IwAR2fixture01"));
  check("Meta: digits with the country code, no plus", metaWebSent?.ph === sha("919900002001"));
  check("Google: E.164 with the plus", googleSent[0].phone === sha("+919900002002"));
  check("a 17-digit leadgen id reaches Meta as the exact number", metaSent.some((m) => m.raw.includes('"lead_id":12345678901234567')));
  check("no phone number crosses in the clear", ![...metaSent.map((m) => m.raw), ...googleSent.map((g) => JSON.stringify(g))].some((t) => /9900002001|9900001001/.test(t)));

  console.log("\nA booking goes once it has stood 30 days, and a cancelled one never");
  await moveLead({ orgId, userId: seller.id, leadId: webGoogle, to: "booked", today, input: { facts: BOOKING } });
  await moveLead({ orgId, userId: seller.id, leadId: webMeta, to: "booked", today, input: { facts: BOOKING } });
  await sendOutcomes(orgId, { nowIso: at(8 * 3_600_000) });
  check("the booking waits while the visit goes", (await uploads(webMeta)).find((u) => u.kind === "BOOKED")?.state === "WAITING" &&
    (await uploads(webMeta)).find((u) => u.kind === "VISIT_DONE")?.state === "SENT");
  // An opt-out between the booking and the end of its hold stops it.
  await sql`INSERT INTO call_suppressions (org_id, phone, reason) VALUES (${orgId}, '+919900002001', 'ADDED_BY_HAND')`;
  const later = await sendOutcomes(orgId, { nowIso: at(31 * 86_400_000) });
  check("thirty days on, the bookings that stood go", later.sent >= 2, JSON.stringify(later));
  const heldBooking = (await events(metaLead)).filter((e) => e.kind === "BOOKED");
  const metaBooking = metaSent.find((m) => m.eventId === heldBooking[1].id);
  const [hold] = await sql<{ not_before: Date }[]>`SELECT not_before FROM outcome_uploads WHERE event_id = ${heldBooking[1].id} AND platform = 'META'`;
  check("Meta is told 'booking confirmed', dated the day the hold ended", metaBooking?.name === "BookingConfirmed" && metaBooking.time === Math.floor(hold.not_before.getTime() / 1000));
  check("the booking cancelled inside its hold was never sent", !metaSent.some((m) => m.eventId === heldBooking[0].id));
  const gBooking = googleSent.find((g) => g.action === googleActions.get("Sales Desk: Booking confirmed"));
  check("Google gets the booking at its real time", !!gBooking && gBooking.timestamp.slice(0, 10) === today);
  check("a buyer who opted out during the hold is never sent", (await uploads(webMeta)).find((u) => u.kind === "BOOKED")?.reason === "OPTED_OUT");
  const cancelledGoogle = await moveLead({ orgId, userId: seller.id, leadId: webGoogle, to: "negotiation", today, input: { facts: {}, reason: "Loan not approved" } });
  check("a cancellation after the booking was sent is recorded, and Google is told nothing (it cannot take one back)",
    cancelledGoogle.ok && (await uploads(webGoogle)).every((u) => u.kind !== "CANCELLED") && (await uploads(webGoogle)).find((u) => u.kind === "BOOKED")?.state === "SENT");

  // -------------------------------------------------------------------------
  console.log("\nTired creatives and ads worth pausing");
  const [metaConn] = await sql<{ id: string }[]>`SELECT id FROM connections WHERE org_id = ${orgId} AND provider = 'META'`;
  const [adAcct] = await sql<{ id: string }[]>`
    INSERT INTO connection_accounts (org_id, connection_id, kind, external_id, name, detail, scope_node_id, daily_cap)
    VALUES (${orgId}, ${metaConn.id}, 'META_AD_ACCOUNT', 'act_77', 'Sath ads', ${sql.json({ currency: "INR" })}, ${project.id}, 5000) RETURNING id`;
  const istDay = (msAgo: number) => new Date(Date.now() + 330 * 60_000 - msAgo).toISOString().slice(0, 10);
  const ads: string[] = [];
  for (const name of ["tired", "fine", "also_fine"]) {
    const key = createHash("sha256").update(`${tag}${name}`).digest("hex");
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO publish_targets (org_id, source, destination, account_id, kind, headline, caption, content_sha256, scope_node_id, phase_id,
                                   idempotency_key, state, daily_budget, steps, activated_at)
      VALUES (${orgId}, 'STUDIO', 'META_AD', ${adAcct.id}, 'IMAGE', ${`Ad ${name}`}, 'x', ${key}, ${towerC.id}, ${towerC.id},
              ${key}, 'ACTIVE', 1000, ${sql.json({ campaign_id: `camp_${name}`, adset_id: `adset_${name}` })}, now())
      RETURNING id`;
    ads.push(t.id);
    // Its first week, before the window the pass reads: the tired one was clicked twice as often then.
    for (let d = 8; d <= 14; d++) {
      await sql`INSERT INTO ad_stats (org_id, publish_target_id, day, spend_paise, impressions, clicks)
                VALUES (${orgId}, ${t.id}, ${istDay(d * DAY)}, 200000, 1000, 20)`;
    }
  }
  for (const [i, adId] of ads.slice(1).entries()) {
    for (let n = 0; n < 5; n++) {
      await sql`
        INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, publish_target_id, stage, path_stage)
        VALUES (${orgId}, ${towerC.id}, 'Ad buyer', ${`+91990000${i}${String(n).padStart(3, "0")}`}, 'Meta ad', 'WEBSITE', ${adId}, 'qualified', 'qualified')`;
    }
  }
  const { syncAdStats, adFigures } = await import("../src/lib/ad-budget.ts");
  const synced = await syncAdStats(orgId, new Date());
  check("the daily pass reads every live ad, and the window's frequency beside it", synced.ads === 3 && synced.failed === 0, JSON.stringify(synced));
  const windows = await sql<{ publish_target_id: string; frequency: string }[]>`SELECT publish_target_id, frequency::text FROM ad_windows WHERE org_id = ${orgId}`;
  check("frequency is kept as one reading per ad", windows.length === 3 && Number(windows.find((w) => w.publish_target_id === ads[0])?.frequency) === 3.8);
  const figs = await adFigures(orgId, ads);
  const tired = figs.get(ads[0])!.health;
  check("a creative seen 3.8 times per person is due a new one", tired.refresh === "DUE");
  check("and its fall in click rate from its first week is measured", tired.ctrDrop !== null && Math.abs(tired.ctrDrop - 0.5) < 0.01, String(tired.ctrDrop));
  check("an ad spending with no qualified buyer while the others bring them is proposed for a pause", tired.pause === true);
  check("the ads that bring buyers are left alone", figs.get(ads[1])!.health.pause === false && figs.get(ads[1])!.health.refresh === null);
  const [paused] = await sql<{ state: string }[]>`SELECT state FROM publish_targets WHERE id = ${ads[0]}`;
  check("proposing a pause pauses nothing", paused.state === "ACTIVE");
  const todayItems = await readReportAlerts(orgId);
  check("and Today carries it for the budget key, as a count, linking to the ads on Published",
    todayItems.some((a) => a.id === "ad-pause-proposed" && a.title === "1 ad costs twice the others per buyer" && a.resolvers.join() === "campaign.budget:manage"
      && a.href === "/dashboard/campaigns/live?view=ads"), JSON.stringify(todayItems));

  console.log("\nBidding on qualified buyers optimises for the event the uploader sends");
  const ruleEvent = (JSON.parse(qualifiedConversionRule()) as { and: { event: { eq: string } }[] }).and[0].event.eq;
  const qualifiedSent = metaSent.filter((m) => m.name === ruleEvent);
  check("the conversion an ad set optimises for matches the Qualified events Meta was actually sent",
    qualifiedSent.length > 0 && ruleEvent === "Qualified", `${ruleEvent} / ${metaSent.map((m) => m.name).join()}`);
  const goal = metaAdGoal({ datasetId: qualifiedSent[0]?.dataset ?? "", conversionId: "1" });
  check("and on the same dataset they were sent to", (goal.adset.promoted_object as { pixel_id: string }).pixel_id === qualifiedSent[0]?.dataset);

  console.log("\nThe record");
  const trail = await sql<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM audit_log WHERE org_id = ${orgId} AND action = 'attribution.uploaded'`;
  check("each pass that sent something leaves counts in the audit log, and nothing else",
    trail.length > 0 && trail.every((t) => Object.keys(t.metadata).sort().join() === "failed,notSent,sent,waiting"));
} finally {
  usePlatform(null);
  useVaultKey(null);
  await sql`DELETE FROM leads WHERE org_id = ${orgId}`;
  await sql`DELETE FROM lead_consents WHERE org_id = ${orgId}`;
  await sql`DELETE FROM call_suppressions WHERE org_id = ${orgId}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  await sql`DELETE FROM orgs WHERE id = ${orgId}`;
  await sql`DELETE FROM users WHERE id IN (${admin.id}, ${seller.id})`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
