/**
 * CRM sync, end to end, against a fake CRM at the real URLs.
 *
 * `useCrm()` swaps the network for `FakeCrm`, which answers LeadRat's and
 * LeadSquared's addresses from one in-memory store, so a lead can be changed
 * "in the CRM" and watched arriving here, and the other way round. Nothing
 * reaches connect.leadrat.com or leadsquared.com.
 *
 * It builds two tenants of its own and removes them: a lead round trip, a
 * conflict settled by who owns the field, a webhook replayed twice, an
 * answer lost after a create, an unmapped status that waits and is
 * released, a write refused for good and retried by a person, a call's
 * summary sent once, an availability sheet imported twice, and a second
 * CRM (LeadSquared) that finds its own host and has its project field
 * chosen from the list it gives.
 */
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { useVaultKey } from "../src/lib/vault.ts";
import { useCrm } from "../src/lib/crm.ts";
import { FakeCrm } from "../src/lib/crm-fake.ts";
import { closeDb, withTenant } from "../src/lib/db/index.ts";
import {
  connectCrm,
  crmHealth,
  disconnectCrm,
  leadFieldChoices,
  setLeadFields,
  liveConnection,
  adapterOf,
  loadMappings,
  pollOnce,
  processEvents,
  projectFieldChoices,
  recordHook,
  retryDead,
  runOutbox,
  saveMappings,
  saveTowerKeys,
  setProjectField,
  type MappingChoice,
} from "../src/lib/crm-sync.ts";
import { crmCapabilities, readLeadratHook, readLeadsquaredHook } from "../src/lib/crm-rules.ts";
import { importUnits, listUnits, availabilityForLead } from "../src/lib/inventory.ts";
import { bookVisit } from "../src/lib/visits.ts";
import { partnerHold } from "../src/lib/partners.ts";
import { csvRows } from "../src/lib/inventory-rules.ts";
import { feedFor, runAvailabilityFeeds, saveFeed, useFeedFetch } from "../src/lib/inventory-feed.ts";
import type { Authz } from "../src/lib/rbac-rules.ts";
import type { StageKey } from "../src/lib/lead-rules.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

process.env.CRM_WEBHOOK_BASE = "https://example.test";
process.env.AUTH_SECRET ??= "check-crm-secret";
delete process.env.CRM_FAKE;
useVaultKey(randomBytes(32));
const fake = new FakeCrm();
useCrm(fake.fetch);

// ---------------------------------------------------------------------------
// Two tenants of their own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const made: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

async function tenant(slug: string, name: string) {
  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${`admin@${slug}${tag}.example`}, ${`${slug}${tag}.example`}, 'CRM Admin') RETURNING id`;
  const [seller] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${`asha@${slug}${tag}.example`}, ${`${slug}${tag}.example`}, 'Asha Menon') RETURNING id`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', ${name}, ${name}, 'AAPFU0939F', ${`${slug}${tag}.example`}, ${admin.id}) RETURNING id`;
  made.orgs.push(org.id);
  made.users.push(admin.id, seller.id);
  const [root] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, NULL, 'ORG', ${name}, ${`${slug}_${tag}`}, ${`${slug}_${tag}`}::ltree) RETURNING id, path::text AS path`;
  const node = async (parent: { id: string; path: string }, kind: string, n: string, s: string) => {
    const [row] = await sql<{ id: string; path: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${org.id}, ${parent.id}, ${kind}, ${n}, ${s}, ${`${parent.path}.${s}`}::ltree) RETURNING id, path::text AS path`;
    return row;
  };
  const entity = await node(root, "ENTITY", "Sath Heights LLP", "sath_llp");
  const region = await node(entity, "REGION", "Mumbai", "mumbai");
  const project = await node(region, "PROJECT", "Sath Heights", "sath_heights");
  const towerC = await node(project, "PHASE", "Tower C", "tower_c");
  const towerD = await node(project, "PHASE", "Tower D", "tower_d");
  for (const [u, role] of [[admin.id, "ORG_ADMIN"], [seller.id, "SALES_HEAD"]] as const) {
    await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${u}, ${org.id}, ${root.id}, ${role}, 'ACTIVE')`;
  }
  return { orgId: org.id, adminId: admin.id, sellerId: seller.id, project, towerC, towerD };
}

const A = await tenant("crma", "CRM Check A");
const B = await tenant("crmb", "CRM Check B");
const C = await tenant("crmc", "CRM Check C");

/** A lead written the way the app writes one: as the app role, so the trigger runs. */
async function addLead(orgId: string, nodeId: string, phone: string, extra: { stage?: StageKey; facts?: Record<string, string> } = {}) {
  return withTenant(orgId, async (tx) => {
    const [l] = await tx<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, channel, stage, path_stage, facts)
      VALUES (${orgId}, ${nodeId}, 'Priya Sharma', ${phone}, 'WEBSITE', ${extra.stage ?? "new"}, ${extra.stage ?? "new"},
              ${tx.json((extra.facts ?? {}) as never)})
      RETURNING id`;
    return l.id;
  });
}

const leadRow = (orgId: string, id: string) =>
  sql<{ stage: string; facts: Record<string, string>; exit_reason: string | null; owner_id: string | null; channel: string; automation: string }[]>`
    SELECT stage, facts, exit_reason, owner_id, channel, automation FROM leads WHERE org_id = ${orgId} AND id = ${id}`.then((r) => r[0]);

const due = (orgId: string) => sql`UPDATE crm_outbox SET not_before = now() WHERE org_id = ${orgId} AND status = 'PENDING'`;

async function work(orgId: string) {
  const c = (await liveConnection(orgId))!;
  const a = (await adapterOf(orgId, c))!;
  await due(orgId);
  const out = await runOutbox(orgId, c, a, new Date());
  const inn = await processEvents(orgId, c, a);
  return { out, inn, c, a };
}

try {
  // -------------------------------------------------------------------------
  console.log("\nconnecting LeadRat");
  // -------------------------------------------------------------------------
  const wrong = await connectCrm({ orgId: A.orgId, userId: A.adminId, provider: "LEADRAT", fields: { tenant: "acme", apiKey: "not-the-key-000", secretKey: fake.secretKey } });
  check("keys LeadRat does not accept are refused at the form", !wrong.ok && /did not accept/.test(wrong.message), JSON.stringify(wrong));
  const bad = await connectCrm({ orgId: A.orgId, userId: A.adminId, provider: "LEADRAT", fields: { tenant: "not a tenant!", apiKey: "", secretKey: "" } });
  check("a malformed form is refused field by field", !bad.ok && !!bad.errors?.tenant && !!bad.errors?.apiKey);
  const [none] = await sql`SELECT count(*)::int AS n FROM crm_connections WHERE org_id = ${A.orgId}`;
  check("nothing is stored for a credential that did not work", none.n === 0);

  const good = await connectCrm({ orgId: A.orgId, userId: A.adminId, provider: "LEADRAT", fields: { tenant: "https://acme.leadrat.com/", apiKey: fake.apiKey, secretKey: fake.secretKey } });
  check("the right keys connect", good.ok, JSON.stringify(good));
  const [conn] = await sql<{ account: string; secret: Buffer; webhooks: unknown[] }[]>`SELECT account, secret, webhooks FROM crm_connections WHERE org_id = ${A.orgId}`;
  check("the tenant is read out of a pasted address", conn.account === "acme", conn.account);
  check("the credential is stored sealed, not as typed", !conn.secret.toString("utf8").includes(fake.secretKey));
  check("webhooks are registered for five lead events, a deletion among them", fake.webhooks.length === 5 && (conn.webhooks as unknown[]).length === 5, `${fake.webhooks.length}`);
  check("each webhook address carries its own proof", fake.webhooks.every((w) => w.callBackUrl.startsWith("https://example.test/api/crm/leadrat/webhook?o=") && /&t=[0-9a-f]{64}$/.test(w.callBackUrl)));
  const other = await connectCrm({ orgId: A.orgId, userId: A.adminId, provider: "LEADSQUARED", fields: { accessKey: fake.accessKey, secretKey: fake.lsqSecret } });
  check("a second CRM is refused while one is connected", !other.ok && /Disconnect it first/.test(other.message));

  let maps = await loadMappings(A.orgId, (await liveConnection(A.orgId))!.id);
  check("their statuses, projects and users arrive to be mapped",
    [maps.filter((m) => m.kind === "STAGE").length, maps.filter((m) => m.kind === "PROJECT").length, maps.filter((m) => m.kind === "USER").length].join(","),
    "11,2,1");
  const revisit = maps.find((m) => m.label === "Revisit")!;
  check("a sub-status knows its parent", revisit.parentLabel === "Site Visit Scheduled");

  // -------------------------------------------------------------------------
  console.log("\nmapping, and an unmapped status that waits");
  // -------------------------------------------------------------------------
  const id = (label: string) => maps.find((m) => m.label === label)!.id;
  const stageMap: [string, StageKey][] = [
    ["New", "new"], ["Callback", "contacted"], ["Qualified", "qualified"], ["Site Visit Scheduled", "visit_scheduled"],
    ["Site Visit Done", "visit_done"], ["Negotiation", "negotiation"], ["Booked", "booked"], ["Not Interested", "lost"],
  ];
  const choices: MappingChoice[] = [
    ...stageMap.map(([label, stage]) => ({ id: id(label), to: "stage" as const, stage })),
    { id: id("Sath Heights Tower C"), to: "node", nodeId: A.towerC.id },
    { id: id("Other Township"), to: "ignore" },
    { id: id("Priya Sales"), to: "user", userId: A.sellerId },
  ];
  const pushAs = Object.fromEntries(stageMap.map(([label, stage]) => [stage, id(label)])) as Record<StageKey, string>;
  const foreign = await saveMappings({ orgId: A.orgId, userId: A.adminId, choices: [{ id: id("Sath Heights Tower C"), to: "node", nodeId: B.towerC.id }], pushAs: {} });
  check("a tower of another tenant cannot be mapped", !foreign.ok, JSON.stringify(foreign));
  const project = await saveMappings({ orgId: A.orgId, userId: A.adminId, choices: [{ id: id("Sath Heights Tower C"), to: "node", nodeId: A.project.id }], pushAs: {} });
  const wrongKind = await saveMappings({ orgId: A.orgId, userId: A.adminId, choices: [{ id: id("New"), to: "user", userId: A.sellerId }], pushAs: {} });
  check("their project maps to one of our towers, never a project node, and a status only to a stage", !project.ok && !wrongKind.ok);
  const saved = await saveMappings({ orgId: A.orgId, userId: A.adminId, choices, pushAs });
  check("the mappings save", saved.ok, JSON.stringify(saved));
  let health = (await crmHealth(A.orgId))!;
  check("one status still waits (Dropped); the sub-status uses its parent's", health.waitingMappings.STAGE === 1, JSON.stringify(health.waitingMappings));
  check("nurture has no status of theirs to set, so writing is not ready",
    health.stagesWithoutPush.join() === "nurture" &&
      crmCapabilities({ connected: true, broken: false, towerMapped: true, stagesWithoutPush: 1 }).write.state === "todo");

  const dropped = fake.addLead({ name: "Rahul Verma", contactNo: "9812300001", statusId: fake.statusByLabel("Dropped").id, projectIds: [fake.projects[0].id] });
  let c = (await liveConnection(A.orgId))!;
  let a = (await adapterOf(A.orgId, c))!;
  const polled = await pollOnce(A.orgId, c, a, new Date());
  check("a poll stores what changed in their CRM", "events" in polled && polled.events >= 1, JSON.stringify(polled));
  let inn = await processEvents(A.orgId, c, a);
  const [waiting] = await sql<{ outcome: string; waiting_on: string }[]>`
    SELECT outcome, waiting_on FROM crm_events WHERE org_id = ${A.orgId} AND payload->>'leadId' = ${dropped.id}`;
  check("a lead on a status nobody mapped waits, and nothing is guessed", waiting?.outcome === "WAITING" && waiting.waiting_on === "STAGE" && inn.waiting === 1);
  const [noLead] = await sql`SELECT count(*)::int AS n FROM leads WHERE org_id = ${A.orgId} AND phone = '+919812300001'`;
  check("so no lead is made yet", noLead.n === 0);

  maps = await loadMappings(A.orgId, c.id);
  await saveMappings({ orgId: A.orgId, userId: A.adminId, choices: [{ id: id("Dropped"), to: "stage", stage: "nurture" }], pushAs: { nurture: id("Dropped") } });
  inn = await processEvents(A.orgId, c, a);
  const [fromCrm] = await sql<{ id: string; stage: string; exit_reason: string; channel: string; automation: string; scope_node_id: string }[]>`
    SELECT id, stage, exit_reason, channel, automation, scope_node_id FROM leads WHERE org_id = ${A.orgId} AND phone = '+919812300001'`;
  check("mapping it releases the event, and the lead arrives", !!fromCrm && fromCrm.stage === "nurture" && fromCrm.exit_reason === "Dropped", JSON.stringify(fromCrm));
  check("in the tower its project is mapped to, marked as from the CRM, with the agent off",
    fromCrm?.scope_node_id === A.towerC.id && fromCrm.channel === "CRM" && fromCrm.automation === "PAUSED");
  const [echo] = await sql`SELECT count(*)::int AS n FROM crm_outbox WHERE org_id = ${A.orgId} AND lead_id = ${fromCrm.id}`;
  check("a lead that came from the CRM is not queued straight back to it", echo.n === 0, `${echo.n}`);
  health = (await crmHealth(A.orgId))!;
  check("with every status mapped and every stage given a status, writing is ready", health.waitingMappings.STAGE === 0 && health.stagesWithoutPush.length === 0);

  const elsewhere = fake.addLead({ name: "Not Ours", contactNo: "9812300009", projectIds: [fake.projects[1].id] });
  await pollOnce(A.orgId, c, a, new Date(Date.now() + 1000));
  await processEvents(A.orgId, c, a);
  const [ignored] = await sql<{ outcome: string }[]>`SELECT outcome FROM crm_events WHERE org_id = ${A.orgId} AND payload->>'leadId' = ${elsewhere.id}`;
  check("a lead on a project marked not ours is ignored", ignored?.outcome === "IGNORED");

  // -------------------------------------------------------------------------
  console.log("\na lead round trip");
  // -------------------------------------------------------------------------
  const leadId = await addLead(A.orgId, A.towerC.id, "+919812345601", { stage: "contacted", facts: { contactChannel: "AI voice call", contactedOn: "2026-09-28", config: "2 BHK", budget: "Rs 60 to 90 lakh" } });
  const [queued] = await sql`SELECT count(*)::int AS n FROM crm_outbox WHERE org_id = ${A.orgId} AND lead_id = ${leadId} AND status = 'PENDING'`;
  check("a lead captured here is queued for the CRM in the same transaction", queued.n === 1);
  let r = await work(A.orgId);
  const there = [...fake.leads.values()].find((l) => l.contactNo === "9812345601");
  check("it is in their CRM, in the right project", !!there && there.projectIds[0] === fake.projects[0].id, JSON.stringify(there));
  check("at the status our stage is pushed as", there?.statusId === fake.statusByLabel("Callback").id);
  check("with what the call found: 2 BHK, Rs 60 to 90 lakh", there?.bhKs.join() === "2" && there.lowerBudget === 6000000 && there.upperBudget === 9000000);
  const [link] = await sql<{ external_id: string }[]>`SELECT external_id FROM crm_links WHERE org_id = ${A.orgId} AND lead_id = ${leadId}`;
  check("and linked", link?.external_id === there?.id);
  check("the write is done", r.out.done >= 1, JSON.stringify(r.out));

  fake.edit(there!.id, { statusId: fake.statusByLabel("Site Visit Scheduled").id, scheduledDate: "2026-09-30T11:00:00Z", meetingOrSiteVisit: 2, assignTo: fake.users[0].id });
  const hookBody = fake.hookBody("lead.status_update", there!);
  const hook = readLeadratHook(hookBody)!;
  const first = await recordHook({ orgId: A.orgId, connectionId: c.id, externalId: hook.eventId, kind: hook.eventType, payload: { leadId: hook.leadId, body: hookBody } });
  const again = await recordHook({ orgId: A.orgId, connectionId: c.id, externalId: hook.eventId, kind: hook.eventType, payload: { leadId: hook.leadId, body: hookBody } });
  check("a webhook replayed twice is stored once", first.fresh && !again.fresh);
  r = await work(A.orgId);
  let mine = await leadRow(A.orgId, leadId);
  check("a status a person set in their CRM moves the lead here", mine.stage === "visit_scheduled", mine.stage);
  check("with the visit's time in IST, and the owner they assigned", mine.facts.visitDate === "2026-09-30" && mine.facts.visitTime === "16:30" && mine.owner_id === A.sellerId, JSON.stringify(mine.facts));
  const [moves] = await sql`SELECT count(*)::int AS n FROM lead_activity WHERE org_id = ${A.orgId} AND lead_id = ${leadId} AND kind = 'STAGE' AND detail->>'via' = 'crm'`;
  check("and the replay is one change, not two", moves.n === 1, `${moves.n}`);
  const [echoed] = await sql`SELECT count(*)::int AS n FROM crm_outbox WHERE org_id = ${A.orgId} AND lead_id = ${leadId} AND status IN ('PENDING','RUNNING')`;
  check("the CRM's own change is not echoed back to it", echoed.n === 0, `${echoed.n}`);

  // -------------------------------------------------------------------------
  console.log("\na conflict, settled by who owns the field");
  // -------------------------------------------------------------------------
  await withTenant(A.orgId, (tx) => tx`
    UPDATE leads SET stage = 'negotiation', path_stage = 'negotiation',
           facts = facts || ${tx.json({ config: "3 BHK", unit: "C-1203", quote: "9500000", interest: "Hot", objection: "None" } as never)}
    WHERE org_id = ${A.orgId} AND id = ${leadId}`);
  fake.edit(there!.id, { statusId: fake.statusByLabel("Site Visit Done").id, bhKs: [1] });
  r = await work(A.orgId);
  mine = await leadRow(A.orgId, leadId);
  const after = fake.leads.get(there!.id)!;
  check("both moved the stage: theirs wins, because a person typed it there", mine.stage === "visit_done", mine.stage);
  check("both changed the configuration: ours wins, because a call found it out", mine.facts.config === "3 BHK" && after.bhKs.join() === "3", `${mine.facts.config} / ${after.bhKs}`);
  check("and their stage is left as they set it", after.statusId === fake.statusByLabel("Site Visit Done").id);

  // -------------------------------------------------------------------------
  console.log("\na lost answer");
  // -------------------------------------------------------------------------
  const lostLead = await addLead(A.orgId, A.towerC.id, "+919812345602");
  fake.loseAnswer("POST", /^\/api\/v1\/lead$/);
  r = await work(A.orgId);
  const [row1] = await sql<{ status: string; last_error_code: string }[]>`SELECT status, last_error_code FROM crm_outbox WHERE org_id = ${A.orgId} AND lead_id = ${lostLead}`;
  check("a create whose answer never came is retried, not given up", row1.status === "PENDING" && row1.last_error_code === "UNREACHABLE", JSON.stringify(row1));
  r = await work(A.orgId);
  const copies = [...fake.leads.values()].filter((l) => l.contactNo === "9812345602");
  check("the retry finds the record it made and creates no second one", copies.length === 1, `${copies.length}`);
  const [lostLink] = await sql`SELECT count(*)::int AS n FROM crm_links WHERE org_id = ${A.orgId} AND lead_id = ${lostLead}`;
  check("and links it", lostLink.n === 1);

  const already = fake.addLead({ name: "Priya S", contactNo: "9812345603", projectIds: [fake.projects[0].id], statusId: fake.statusByLabel("Qualified").id });
  const knownLead = await addLead(A.orgId, A.towerC.id, "+919812345603", { stage: "contacted", facts: { contactChannel: "Phone call", contactedOn: "2026-09-28" } });
  r = await work(A.orgId);
  const dupes = [...fake.leads.values()].filter((l) => l.contactNo === "9812345603");
  check("a buyer already in their CRM from a portal is matched by phone, never created twice", dupes.length === 1);
  mine = await leadRow(A.orgId, knownLead);
  check("and their status, a person's decision, wins the first match", mine.stage === "qualified" && fake.leads.get(already.id)!.statusId === fake.statusByLabel("Qualified").id, mine.stage);

  // -------------------------------------------------------------------------
  console.log("\na write refused for good, and retried by a person");
  // -------------------------------------------------------------------------
  const refusedLead = await addLead(A.orgId, A.towerC.id, "+919812345604");
  fake.refuseNext("POST", /^\/api\/v1\/lead$/, 400);
  r = await work(A.orgId);
  health = (await crmHealth(A.orgId))!;
  const deadRow = health.dead.find((d) => d.leadId === refusedLead);
  check("a refusal another attempt cannot fix is dead at once, and shown", !!deadRow && /Refused by the test/.test(deadRow.error ?? ""), JSON.stringify(health.dead));
  const retried = await retryDead({ orgId: A.orgId, userId: A.adminId, ids: [deadRow!.id] });
  r = await work(A.orgId);
  check("a person's retry sends it", retried === 1 && [...fake.leads.values()].some((l) => l.contactNo === "9812345604"));

  const dLead = await addLead(A.orgId, A.towerD.id, "+919812345605");
  r = await work(A.orgId);
  const [dRow] = await sql<{ status: string; waiting_on: string }[]>`SELECT status, waiting_on FROM crm_outbox WHERE org_id = ${A.orgId} AND lead_id = ${dLead}`;
  check("a lead in a tower nobody matched to a project waits for the mapping", dRow.status === "WAITING" && dRow.waiting_on === "PROJECT");

  // -------------------------------------------------------------------------
  console.log("\na call's summary, once");
  // -------------------------------------------------------------------------
  const [call] = await withTenant(A.orgId, (tx) => tx<{ id: string }[]>`
    INSERT INTO calls (org_id, lead_id, scope_node_id, app_id, app_version, from_number, to_number, status)
    VALUES (${A.orgId}, ${leadId}, ${A.towerC.id}, 'app', 1, '+912265480217', '+919812345601', 'PLACING') RETURNING id`);
  await withTenant(A.orgId, (tx) => tx`
    UPDATE calls SET status = 'DONE', connectivity = 'connected', duration_s = 185, ended_at = now() WHERE org_id = ${A.orgId} AND id = ${call.id}`);
  await withTenant(A.orgId, (tx) => tx`UPDATE calls SET outcome = 'interested' WHERE org_id = ${A.orgId} AND id = ${call.id}`);
  fake.loseAnswer("PUT", /^\/api\/v1\/lead\/notes\//);
  r = await work(A.orgId);
  r = await work(A.orgId);
  const notes = fake.leads.get(there!.id)!.notes;
  check("an ended call is one line on their record", (notes.match(/Sales Desk AI call/g) ?? []).length === 1, notes);
  check("the line says what the call found, never the transcript", /answered, 3 min/.test(notes) && /3 BHK/.test(notes));

  // -------------------------------------------------------------------------
  console.log("\nthe availability sheet");
  // -------------------------------------------------------------------------
  const sheet = csvRows([
    "Project availability, 28 Sep",
    "Wing,Flat No,Floor,Configuration,Carpet Area (sq ft),Facing,Status",
    "A,A-1201,12,2 BHK,682,East,Available",
    "A,A-1202,12,2 BHK,682,West,Sold",
    "A,A-1203,12,1 BHK,452,North,Hold",
    "A,A-1204,12,3 BHK,1050,South,Maybe",
  ].join("\n"));
  const imp = await importUnits({ orgId: A.orgId, userId: A.adminId, nodeId: A.towerC.id, rows: sheet });
  check("a sheet with a title row above its header imports", imp.ok && imp.added === 3 && imp.refused === 1, JSON.stringify(imp));
  const again2 = await importUnits({ orgId: A.orgId, userId: A.adminId, nodeId: A.towerC.id, rows: sheet });
  check("importing it again changes nothing", again2.ok && again2.added === 0 && again2.changed === 0 && again2.same === 3, JSON.stringify(again2));
  const moved = await importUnits({ orgId: A.orgId, userId: A.adminId, nodeId: A.towerC.id, rows: csvRows("Flat No,Wing,Status\nA-1201,A,Booked") });
  check("a status that changed is the one row changed", moved.ok && moved.changed === 1, JSON.stringify(moved));
  const cross = await importUnits({ orgId: B.orgId, userId: B.adminId, nodeId: A.towerC.id, rows: sheet });
  check("another tenant's tower cannot be imported into", !cross.ok);
  const units = await listUnits(A.orgId, A.towerC.id);
  check("the flats are read back with their statuses", units.map((u) => `${u.unitNo}:${u.status}`).join() === "A-1201:BOOKED,A-1202:BOOKED,A-1203:BLOCKED", units.map((u) => `${u.unitNo}:${u.status}`).join());
  const avail = await availabilityForLead(A.orgId, A.towerC.id, "2 BHK");
  check("a lead asking for a 2 BHK is told none are left", avail?.available === 0 && avail.total === 2, JSON.stringify(avail));

  // -------------------------------------------------------------------------
  console.log("\nthe live sheet");
  // -------------------------------------------------------------------------
  // Read with a clock in 2100 and stamped there, so the real worker never finds these sheets due.
  let feedClock = Date.parse("2100-01-01T00:00:00Z");
  const sheets = new Map<string, string>();
  useFeedFetch(async (url) => {
    const body = sheets.get(new URL(url).pathname);
    return body === undefined ? new Response("gone", { status: 404 }) : new Response(body, { status: 200, headers: { "content-type": "text/csv" } });
  });
  const readFeeds = async () => (await runAvailabilityFeeds({ orgIds: [A.orgId], now: new Date((feedClock += 3 * 60_000)) }))[0];
  const status = async (towerId: string, no: string) =>
    (await sql<{ status: string }[]>`SELECT status FROM units WHERE org_id = ${A.orgId} AND scope_node_id = ${towerId} AND unit_no = ${no}`)[0]?.status ?? null;
  await sql`INSERT INTO availability_feeds (org_id, scope_node_id, url, last_fetched_at) VALUES
    (${A.orgId}, ${A.towerC.id}, 'https://sheets.example/c.csv', '2100-01-01T00:00:00Z'),
    (${A.orgId}, ${A.project.id}, 'https://sheets.example/project.csv', '2100-01-01T00:00:00Z')`;
  sheets.set("/c.csv", "Wing,Flat No,Status\nA,A-1201,Booked\nA,A-1202,Booked\nA,A-1203,Available\nA,H-1,Available");
  sheets.set("/project.csv", "Tower,Unit,Status\nTower D,D-101,Available\nC,A-1203,Booked\nTower Z,Z-1,Available");
  let fr = await readFeeds();
  check("a tower's sheet and its project's are both read", fr.read === 2 && fr.changed === 2 && fr.failed === 0, JSON.stringify(fr));
  check("the project's sheet writes a tower that has no sheet of its own", (await status(A.towerD.id, "D-101")) === "AVAILABLE");
  check("and leaves a tower that reads its own sheet to that sheet", (await status(A.towerC.id, "A-1203")) === "AVAILABLE");
  const [projFeed] = await sql<{ last_result: { refused: number } }[]>`SELECT last_result FROM availability_feeds WHERE org_id = ${A.orgId} AND scope_node_id = ${A.project.id}`;
  check("a row naming no tower of the project is refused, and a row for a tower with its own sheet is not", projFeed.last_result.refused === 1, JSON.stringify(projFeed.last_result));
  fr = await readFeeds();
  check("an unchanged sheet writes nothing", fr.read === 2 && fr.changed === 0, JSON.stringify(fr));

  // A flat a quote holds: the sheet blocks it, then frees it again.
  const [ut] = await sql<{ id: string }[]>`INSERT INTO unit_types (org_id, scope_node_id, config) VALUES (${A.orgId}, ${A.towerC.id}, '2BHK') RETURNING id`;
  const heldLead = await addLead(A.orgId, A.towerC.id, "+919812345609");
  const hex = "a".repeat(64);
  const [hq] = await sql<{ id: string }[]>`
    INSERT INTO quotes (org_id, lead_id, scope_node_id, unit_type_id, unit_no, unit_hash, price, gst_rate, gst, duty_rate, stamp_duty, registration, all_in, token, tax_row, content_hash)
    VALUES (${A.orgId}, ${heldLead}, ${A.towerC.id}, ${ut.id}, 'H-1', ${hex}, 10000000, 5, 500000, 6, 600000, 30000, 11130000, 100000, '{}', ${hex}) RETURNING id`;
  await sql`INSERT INTO unit_blocks (org_id, scope_node_id, unit_no, quote_id, lead_id, expires_at)
    VALUES (${A.orgId}, ${A.towerC.id}, 'H-1', ${hq.id}, ${heldLead}, now() + interval '2 days')`;
  sheets.set("/c.csv", "Wing,Flat No,Status\nA,A-1201,Booked\nA,A-1202,Booked\nA,A-1203,Available\nA,H-1,Blocked");
  await readFeeds();
  check("a held flat the sheet blocks is blocked in its row", (await status(A.towerC.id, "H-1")) === "BLOCKED");
  sheets.set("/c.csv", "Wing,Flat No,Status\nA,A-1201,Booked\nA,A-1202,Booked\nA,A-1203,Available\nA,H-1,Available");
  await readFeeds();
  check("and the sheet freeing it frees the row, though our hold still shows it blocked", (await status(A.towerC.id, "H-1")) === "AVAILABLE");
  sheets.delete("/c.csv");
  fr = await readFeeds();
  const [cFeed] = await sql<{ last_error: string | null }[]>`SELECT last_error FROM availability_feeds WHERE org_id = ${A.orgId} AND scope_node_id = ${A.towerC.id}`;
  check("a sheet that no longer opens says so and changes nothing", fr.failed === 1 && cFeed.last_error === "The sheet's link no longer opens." && (await status(A.towerC.id, "H-1")) === "AVAILABLE", JSON.stringify([fr, cFeed]));
  const anywhere = { canAt: () => true } as unknown as Authz;
  const moved2 = await saveFeed({ orgId: A.orgId, userId: A.adminId, authz: anywhere, nodeId: A.project.id, url: "https://sheets.example/all.csv", fromTower: A.towerC.id });
  const nowReads = await feedFor(A.orgId, A.towerC.id);
  check("choosing the project's sheet on a tower's screen makes that tower read it", moved2.ok && nowReads?.nodeId === A.project.id, JSON.stringify(nowReads));
  useFeedFetch(null);
  await sql`DELETE FROM unit_blocks WHERE org_id = ${A.orgId}`;
  await sql`DELETE FROM quotes WHERE org_id = ${A.orgId}`;
  await sql`DELETE FROM crm_outbox WHERE org_id = ${A.orgId} AND lead_id = ${heldLead}`;
  await sql`DELETE FROM leads WHERE org_id = ${A.orgId} AND id = ${heldLead}`;
  await sql`DELETE FROM availability_feeds WHERE org_id = ${A.orgId}`;

  // -------------------------------------------------------------------------
  console.log("\nLeadSquared");
  // -------------------------------------------------------------------------
  const lsq = await connectCrm({ orgId: B.orgId, userId: B.adminId, provider: "LEADSQUARED", fields: { accessKey: fake.accessKey, secretKey: fake.lsqSecret } });
  check("LeadSquared connects", lsq.ok, JSON.stringify(lsq));
  const [lsqConn] = await sql<{ account: string }[]>`SELECT account FROM crm_connections WHERE org_id = ${B.orgId} AND status = 'CONNECTED'`;
  check("and finds its own data centre's host", lsqConn?.account === "api-in21.leadsquared.com", lsqConn?.account);
  check("its webhooks carry our header as well as our address", fake.lsqHooks.length === 4 && fake.lsqHooks.every((h) => h.headers[0]?.Key === "x-salesdesk-token"));
  let bMaps = await loadMappings(B.orgId, (await liveConnection(B.orgId))!.id);
  check("with no project field chosen, there are no projects to map yet", bMaps.filter((m) => m.kind === "PROJECT").length === 0);
  const fields = await projectFieldChoices(B.orgId);
  check("the project field is chosen from the dropdowns it lists", !!fields?.some((f) => f.schemaName === "mx_Project"), JSON.stringify(fields));
  const made1 = await setProjectField({ orgId: B.orgId, userId: B.adminId, schemaName: "mx_Invented" });
  check("a field it did not list is refused", !made1.ok);
  await setProjectField({ orgId: B.orgId, userId: B.adminId, schemaName: "mx_Project" });
  bMaps = await loadMappings(B.orgId, (await liveConnection(B.orgId))!.id);
  const bid = (label: string) => bMaps.find((m) => m.label === label)!.id;
  const bStages: [string, StageKey][] = [
    ["New", "new"], ["Callback", "contacted"], ["Qualified", "qualified"], ["Site Visit Scheduled", "visit_scheduled"],
    ["Site Visit Done", "visit_done"], ["Negotiation", "negotiation"], ["Booked", "booked"], ["Not Interested", "lost"], ["Dropped", "nurture"],
  ];
  await saveMappings({
    orgId: B.orgId,
    userId: B.adminId,
    choices: [
      ...bStages.map(([l, s]) => ({ id: bid(l), to: "stage" as const, stage: s })),
      { id: bid("Sath Heights Tower C"), to: "node" as const, nodeId: B.towerC.id },
      { id: bid("Priya Sales"), to: "user" as const, userId: B.sellerId },
    ],
    pushAs: Object.fromEntries(bStages.map(([l, s]) => [s, bid(l)])),
  });
  const bLead = await addLead(B.orgId, B.towerC.id, "+919812399901", { stage: "contacted", facts: { contactChannel: "Phone call", contactedOn: "2026-09-28" } });
  await work(B.orgId);
  const bThere = [...fake.leads.values()].find((l) => l.contactNo === "9812399901");
  check("a lead goes to LeadSquared with its project in the chosen field", !!bThere && bThere.projectIds[0] === fake.projects[0].id && bThere.statusId === fake.statusByLabel("Callback").id, JSON.stringify(bThere));
  const before = fake.lsqView(bThere!);
  fake.edit(bThere!.id, { statusId: fake.statusByLabel("Qualified").id, assignTo: fake.users[0].id });
  const lsqBody = fake.lsqHookBody(before, bThere!);
  const lh = readLeadsquaredHook(lsqBody, "lead.stage")!;
  const bc = (await liveConnection(B.orgId))!;
  const h1 = await recordHook({ orgId: B.orgId, connectionId: bc.id, externalId: lh.eventId, kind: lh.eventType, payload: { leadId: lh.leadId, body: lsqBody } });
  const h2 = await recordHook({ orgId: B.orgId, connectionId: bc.id, externalId: readLeadsquaredHook(lsqBody, "lead.stage")!.eventId, kind: lh.eventType, payload: { leadId: lh.leadId, body: lsqBody } });
  check("LeadSquared gives no delivery id; the same delivery twice is still one row", h1.fresh && !h2.fresh);
  await work(B.orgId);
  const bMine = await leadRow(B.orgId, bLead);
  check("a stage set in LeadSquared arrives here", bMine.stage === "qualified" && bMine.owner_id === B.sellerId, JSON.stringify(bMine));
  const cross2 = await recordHook({ orgId: A.orgId, connectionId: bc.id, externalId: "x", kind: "lead.update", payload: {} });
  check("a delivery naming another tenant's connection is not stored", !cross2.fresh);

  // -------------------------------------------------------------------------
  console.log("\nSell.Do, one way");
  // -------------------------------------------------------------------------
  const sdBad = await connectCrm({ orgId: C.orgId, userId: C.adminId, provider: "SELLDO", fields: { apiKey: "0000000000000000wrongkey" } });
  check("a Sell.Do key it does not accept is refused", !sdBad.ok && /did not accept/.test(sdBad.message), JSON.stringify(sdBad));
  const sd = await connectCrm({ orgId: C.orgId, userId: C.adminId, provider: "SELLDO", fields: { apiKey: fake.selldoKey } });
  check("Sell.Do connects with its API key", sd.ok, JSON.stringify(sd));
  const sdLead = await addLead(C.orgId, C.towerC.id, "+919812377701", { facts: { config: "2 BHK" } });
  await work(C.orgId);
  const [sdWait] = await sql<{ status: string; waiting_on: string }[]>`SELECT status, waiting_on FROM crm_outbox WHERE org_id = ${C.orgId} AND lead_id = ${sdLead}`;
  check("a tower with no campaign key waits for one", sdWait.status === "WAITING" && sdWait.waiting_on === "PROJECT");
  const badKey = await saveTowerKeys({ orgId: C.orgId, userId: C.adminId, keys: [{ nodeId: C.towerC.id, srd: "not-a-key" }] });
  const foreignTower = await saveTowerKeys({ orgId: C.orgId, userId: C.adminId, keys: [{ nodeId: A.towerC.id, srd: "5f1a2b3c4d5e6f7a8b9c0d1e" }] });
  check("a campaign key must look like one, and the tower must be ours", !badKey.ok && !foreignTower.ok);
  await saveTowerKeys({ orgId: C.orgId, userId: C.adminId, keys: [{ nodeId: C.towerC.id, srd: "5F1A2B3C4D5E6F7A8B9C0D1E" }] });
  fake.loseAnswer("POST", /^\/api\/leads\/create\.json$/);
  await work(C.orgId);
  await work(C.orgId);
  const sdThere = [...fake.leads.values()].filter((l) => l.contactNo === "9812377701");
  check("the lead is created in Sell.Do under the tower's campaign, once, even after a lost answer",
    sdThere.length === 1 && fake.selldoSrds.get(sdThere[0].id) === "5f1a2b3c4d5e6f7a8b9c0d1e", `${sdThere.length}`);
  const [sdLink] = await sql`SELECT count(*)::int AS n FROM crm_links WHERE org_id = ${C.orgId} AND lead_id = ${sdLead}`;
  check("and linked, so nothing is sent for it again", sdLink.n === 1);
  await withTenant(C.orgId, (tx) => tx`UPDATE leads SET stage = 'lost', exit_reason = 'Not interested' WHERE org_id = ${C.orgId} AND id = ${sdLead}`);
  const calls = fake.log.length;
  await work(C.orgId);
  check("a later change sends nothing: Sell.Do's documented API takes new leads only", fake.log.length === calls, `${fake.log.length - calls} requests`);

  // -------------------------------------------------------------------------
  console.log("\na visit booked in the CRM");
  // -------------------------------------------------------------------------
  // Pinned to the morning of 30 September 2026 IST, so every visit below is ahead.
  const NOW = new Date("2026-09-30T04:30:00Z");
  const workAt = async (orgId: string) => {
    const cc = (await liveConnection(orgId))!;
    const aa = (await adapterOf(orgId, cc))!;
    await due(orgId);
    const out = await runOutbox(orgId, cc, aa, NOW);
    const inn = await processEvents(orgId, cc, aa, 40, NOW);
    return { out, inn };
  };
  const hookFor = async (orgId: string, event: string, lead: import("../src/lib/crm-fake.ts").FakeLead) => {
    const cc = (await liveConnection(orgId))!;
    const body = fake.hookBody(event, lead);
    const h = readLeadratHook(body)!;
    return recordHook({ orgId, connectionId: cc.id, externalId: h.eventId, kind: h.eventType, payload: { leadId: h.leadId, body } });
  };
  const visitsOf = (orgId: string, leadId: string) =>
    sql<{ id: string; status: string; booked_via: string; at: string; slot_id: string | null }[]>`
      SELECT id, status, booked_via, to_char(scheduled_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI') AS at, slot_id
      FROM site_visits WHERE org_id = ${orgId} AND lead_id = ${leadId} ORDER BY created_at`;
  const leadByPhone = (orgId: string, phone: string) =>
    sql<{ id: string; stage: string; exit_reason: string | null; automation: string; needs_person: string | null; facts: Record<string, string> }[]>`
      SELECT id, stage, exit_reason, automation, needs_person, facts FROM leads WHERE org_id = ${orgId} AND phone = ${phone}`.then((r) => r[0]);

  const siteVisit = fake.statusByLabel("Site Visit Scheduled").id;
  const neha = fake.addLead({
    name: "Neha Joshi", contactNo: "9812300031", statusId: siteVisit, scheduledDate: "2026-10-12T06:30:00Z", meetingOrSiteVisit: 2,
    projectIds: [fake.projects[0].id],
  });
  await hookFor(A.orgId, "lead.created", neha);
  await workAt(A.orgId);
  const nehaLead = await leadByPhone(A.orgId, "+919812300031");
  let nv = await visitsOf(A.orgId, nehaLead.id);
  check("a visit a person typed in the CRM is booked here, through the board's own path",
    nehaLead.stage === "visit_scheduled" && nv.length === 1 && nv[0].status === "CONFIRMED" && nv[0].booked_via === "CRM" && nv[0].at === "2026-10-12T12:00",
    JSON.stringify({ stage: nehaLead.stage, nv }));
  check("and takes its seat in the gallery's ledger", !!nv[0]?.slot_id);
  const [ladder] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM lead_tasks WHERE org_id = ${A.orgId} AND lead_id = ${nehaLead.id} AND visit_id = ${nv[0]?.id ?? null}
      AND purpose IN ('VISIT_CONFIRMED', 'NO_SHOW_CHECK')`;
  check("with its confirmation and reminders scheduled", ladder.n === 2, `${ladder.n}`);
  const [cv] = await sql<{ origin: string; agreed_at: string; visit_id: string }[]>`
    SELECT origin, agreed_at, visit_id FROM crm_visits WHERE org_id = ${A.orgId} AND lead_id = ${nehaLead.id}`;
  check("remembered as the CRM's visit, on the CRM's id for it", cv?.origin === "CRM" && cv.agreed_at === "2026-10-12T12:00" && cv.visit_id === nv[0]?.id, JSON.stringify(cv));

  await hookFor(A.orgId, "lead.update", neha);
  await hookFor(A.orgId, "lead.update", neha);
  await workAt(A.orgId);
  nv = await visitsOf(A.orgId, nehaLead.id);
  check("the same visit delivered again books nothing more", nv.length === 1, `${nv.length}`);

  fake.edit(neha.id, { scheduledDate: "2026-10-13T08:30:00Z" });
  await hookFor(A.orgId, "lead.update", neha);
  await workAt(A.orgId);
  nv = await visitsOf(A.orgId, nehaLead.id);
  const [slotBack] = await sql<{ taken: number }[]>`SELECT taken FROM visit_slots WHERE id = ${nv[0].slot_id}`;
  check("a visit moved in the CRM moves ours: a new one at the new time, the old one moved and its seat given back",
    nv.map((v) => `${v.status}@${v.at}`).join() === "MOVED@2026-10-12T12:00,CONFIRMED@2026-10-13T14:00" && slotBack.taken === 0,
    `${nv.map((v) => `${v.status}@${v.at}`).join()} / ${slotBack.taken}`);

  // Both moved it: a person here, and a person in the CRM. It is the CRM's visit, so theirs stands.
  await bookVisit({ orgId: A.orgId, leadId: nehaLead.id, atIso: "2026-10-14T05:30:00.000Z", via: "CONSOLE", nowIso: NOW.toISOString() });
  await withTenant(A.orgId, (tx) => tx`
    UPDATE leads SET facts = facts || ${tx.json({ visitDate: "2026-10-14", visitTime: "11:00" } as never)} WHERE org_id = ${A.orgId} AND id = ${nehaLead.id}`);
  fake.edit(neha.id, { scheduledDate: "2026-10-15T06:30:00Z" });
  await workAt(A.orgId);
  nv = await visitsOf(A.orgId, nehaLead.id);
  const nehaThere = fake.leads.get(neha.id)!;
  check("both moved a visit a person typed in the CRM: the CRM's time stands here",
    nv.filter((v) => v.status === "CONFIRMED").map((v) => v.at).join() === "2026-10-15T12:00" && nehaThere.scheduledDate === "2026-10-15T06:30:00Z",
    `${nv.map((v) => `${v.status}@${v.at}`).join()} / ${nehaThere.scheduledDate}`);

  fake.edit(neha.id, { statusId: fake.statusByLabel("Callback").id });
  await hookFor(A.orgId, "lead.status_update", neha);
  await workAt(A.orgId);
  nv = await visitsOf(A.orgId, nehaLead.id);
  const [cvOff] = await sql<{ status: string }[]>`SELECT status FROM crm_visits WHERE org_id = ${A.orgId} AND lead_id = ${nehaLead.id}`;
  check("the CRM moving the lead back calls our visit off", nv.every((v) => v.status !== "CONFIRMED") && cvOff?.status === "CANCELLED",
    `${nv.map((v) => v.status).join()} / ${cvOff?.status}`);

  const meet = fake.addLead({ name: "Meeting Only", contactNo: "9812300032", statusId: siteVisit, scheduledDate: "2026-10-12T06:30:00Z", meetingOrSiteVisit: 1, projectIds: [fake.projects[0].id] });
  const past = fake.addLead({ name: "Past Visit", contactNo: "9812300033", statusId: siteVisit, scheduledDate: "2026-09-29T06:30:00Z", meetingOrSiteVisit: 2, projectIds: [fake.projects[0].id] });
  await hookFor(A.orgId, "lead.created", meet);
  await hookFor(A.orgId, "lead.created", past);
  await workAt(A.orgId);
  const meetLead = await leadByPhone(A.orgId, "+919812300032");
  const pastLead = await leadByPhone(A.orgId, "+919812300033");
  check("a meeting is not a site visit, and a time already gone is not booked",
    (await visitsOf(A.orgId, meetLead.id)).length === 0 && (await visitsOf(A.orgId, pastLead.id)).length === 0);

  // A visit the agent booked is ours: both moved it, and ours goes to the CRM.
  const ravi = await addLead(A.orgId, A.towerC.id, "+919812300034", { stage: "contacted", facts: { contactChannel: "AI voice call", contactedOn: "2026-09-29" } });
  await workAt(A.orgId);
  const agentVisit = await bookVisit({ orgId: A.orgId, leadId: ravi, atIso: "2026-10-16T05:30:00.000Z", via: "AI_CALL", nowIso: NOW.toISOString() });
  await withTenant(A.orgId, (tx) => tx`
    UPDATE leads SET stage = 'visit_scheduled', path_stage = 'visit_scheduled',
           facts = facts || ${tx.json({ visitDate: "2026-10-16", visitTime: "11:00" } as never)}
    WHERE org_id = ${A.orgId} AND id = ${ravi}`);
  await workAt(A.orgId);
  const raviThere = [...fake.leads.values()].find((l) => l.contactNo === "9812300034")!;
  const [raviCv] = await sql<{ origin: string; visit_id: string }[]>`SELECT origin, visit_id FROM crm_visits WHERE org_id = ${A.orgId} AND lead_id = ${ravi}`;
  check("a visit the agent booked goes to the CRM as a site visit, remembered as ours",
    raviThere.scheduledDate === "2026-10-16T05:30:00.000Z" && raviThere.meetingOrSiteVisit === 2 && raviCv?.origin === "US" && raviCv.visit_id === agentVisit?.visitId,
    `${raviThere.scheduledDate} ${raviThere.meetingOrSiteVisit} ${JSON.stringify(raviCv)}`);
  await bookVisit({ orgId: A.orgId, leadId: ravi, atIso: "2026-10-17T05:30:00.000Z", via: "AI_CALL", nowIso: NOW.toISOString() });
  await withTenant(A.orgId, (tx) => tx`
    UPDATE leads SET facts = facts || ${tx.json({ visitDate: "2026-10-17", visitTime: "11:00" } as never)} WHERE org_id = ${A.orgId} AND id = ${ravi}`);
  fake.edit(raviThere.id, { scheduledDate: "2026-10-18T06:30:00Z" });
  await workAt(A.orgId);
  const raviVisits = await visitsOf(A.orgId, ravi);
  check("both moved it: ours stands, and goes to the CRM",
    raviVisits.filter((v) => v.status === "CONFIRMED").map((v) => v.at).join() === "2026-10-17T11:00" && fake.leads.get(raviThere.id)!.scheduledDate === "2026-10-17T05:30:00.000Z",
    `${raviVisits.map((v) => `${v.status}@${v.at}`).join()} / ${fake.leads.get(raviThere.id)!.scheduledDate}`);

  // -------------------------------------------------------------------------
  console.log("\na partner's buyer arriving through the CRM");
  // -------------------------------------------------------------------------
  const [cpOrg] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, status)
    VALUES ('CHANNEL_PARTNER', ${`Keystone Realty ${tag}`}, ${`Keystone Realty ${tag}`}, 'AAKFK4821K', 'PENDING_VERIFICATION') RETURNING id`;
  made.orgs.push(cpOrg.id);
  await sql`
    INSERT INTO partner_firms (org_id, cp_org_id, name, legal_name, pan, rm_id)
    VALUES (${A.orgId}, ${cpOrg.id}, 'Keystone Realty', 'Keystone Realty LLP', 'AAKFK4821K', ${A.sellerId})`;
  const [cpGrant] = await sql<{ id: string }[]>`
    INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_from, valid_to)
    VALUES (${A.orgId}, ${cpOrg.id}, ${A.project.id}, 'CHANNEL_PARTNER', now() - interval '1 day', now() + interval '30 days') RETURNING id`;
  const [claim] = await sql<{ id: string }[]>`
    INSERT INTO client_registrations (org_id, cp_org_id, grant_id, scope_node_id, phone, via, verdict, valid_until)
    VALUES (${A.orgId}, ${cpOrg.id}, ${cpGrant.id}, ${A.project.id}, '+919812300041', 'CONSOLE', 'REGISTERED', now() + interval '20 days') RETURNING id`;
  const pooja = fake.addLead({ name: "Pooja Nair", contactNo: "9812300041", projectIds: [fake.projects[0].id] });
  await hookFor(A.orgId, "lead.created", pooja);
  await workAt(A.orgId);
  const poojaLead = await leadByPhone(A.orgId, "+919812300041");
  const [claimNow] = await sql<{ lead_id: string | null }[]>`SELECT lead_id FROM client_registrations WHERE id = ${claim.id}`;
  check("a lead the CRM brings on a number a partner registered is linked to the partner's claim",
    !!poojaLead && claimNow.lead_id === poojaLead.id && /Partner's buyer: Keystone/.test(poojaLead.needs_person ?? ""), JSON.stringify({ poojaLead, claimNow }));
  const hold = await partnerHold(A.orgId, poojaLead.id);
  check("and is held from calls until the site visit, as a captured one is", hold.held, JSON.stringify(hold));
  const [r2] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${A.orgId} AND action = 'lead.ownership' AND target_id = ${poojaLead.id} AND metadata->>'ownership' = 'R2'`;
  check("and the rule that fired is on the audit row, with no number", r2.n === 1);

  // -------------------------------------------------------------------------
  console.log("\na record deleted or merged in the CRM");
  // -------------------------------------------------------------------------
  const lostThere = [...fake.leads.values()].find((l) => l.contactNo === "9812345602")!;
  fake.remove(lostThere.id);
  await hookFor(A.orgId, "lead.deleted", lostThere);
  await workAt(A.orgId);
  const removed = await leadRow(A.orgId, lostLead);
  const [removedLink] = await sql<{ removed_at: Date | null; removed_reason: string | null }[]>`
    SELECT removed_at, removed_reason FROM crm_links WHERE org_id = ${A.orgId} AND lead_id = ${lostLead}`;
  check("a lead deleted in the CRM is closed here as Removed in CRM, with the agent off, and never deleted",
    removed?.stage === "lost" && removed.exit_reason === "Removed in CRM" && removed.automation === "PAUSED", JSON.stringify(removed));
  check("its link is kept, marked removed", !!removedLink?.removed_at && removedLink.removed_reason === "DELETED");
  await withTenant(A.orgId, (tx) => tx`UPDATE leads SET name = 'Priya Sharma Rao' WHERE org_id = ${A.orgId} AND id = ${lostLead}`);
  await workAt(A.orgId);
  check("a later change here recreates nothing there", ![...fake.leads.values()].some((l) => l.contactNo === "9812345602"));
  const [removedAudit] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${A.orgId} AND action = 'crm.lead_removed' AND target_id = ${lostLead}`;
  check("and the removal is audited", removedAudit.n === 1);

  const mergeLeadId = await addLead(A.orgId, A.towerC.id, "+919812300051", { stage: "contacted", facts: { contactChannel: "Phone call", contactedOn: "2026-09-29" } });
  await workAt(A.orgId);
  const firstRec = [...fake.leads.values()].find((l) => l.contactNo === "9812300051")!;
  const survivor = fake.addLead({ name: "Priya Sharma", contactNo: "9812300051", projectIds: [fake.projects[0].id], statusId: fake.statusByLabel("Qualified").id });
  fake.remove(firstRec.id);
  await hookFor(A.orgId, "lead.deleted", firstRec);
  await workAt(A.orgId);
  const [mergedLink] = await sql<{ external_id: string; previous_ids: string[]; removed_at: Date | null }[]>`
    SELECT external_id, previous_ids, removed_at FROM crm_links WHERE org_id = ${A.orgId} AND lead_id = ${mergeLeadId}`;
  const merged = await leadRow(A.orgId, mergeLeadId);
  check("a record merged into another in the CRM moves our link to the one that survived",
    mergedLink?.external_id === survivor.id && mergedLink.previous_ids.join() === firstRec.id && !mergedLink.removed_at, JSON.stringify(mergedLink));
  check("and the lead stays open, reading the survivor", merged.stage === "qualified", merged.stage);

  // -------------------------------------------------------------------------
  console.log("\nLeadSquared's configuration and budget fields");
  // -------------------------------------------------------------------------
  const lf = await leadFieldChoices(B.orgId);
  check("the fields offered are LeadSquared's own list, less the project field",
    !!lf?.some((f) => f.schemaName === "mx_Configuration" && f.kind === "select") && !!lf?.some((f) => f.schemaName === "mx_Budget" && f.kind === "number") && !lf?.some((f) => f.schemaName === "mx_Project"),
    JSON.stringify(lf));
  const invented = await setLeadFields({ orgId: B.orgId, userId: B.adminId, config: "mx_Invented", budget: null });
  const twice = await setLeadFields({ orgId: B.orgId, userId: B.adminId, config: "mx_Budget", budget: "mx_Budget" });
  check("a field it did not list is refused, and one field cannot hold both", !invented.ok && !twice.ok);
  const lfSaved = await setLeadFields({ orgId: B.orgId, userId: B.adminId, config: "mx_Configuration", budget: "mx_Budget" });
  check("the two fields save", lfSaved.ok, JSON.stringify(lfSaved));
  const bConfig = await addLead(B.orgId, B.towerC.id, "+919812399902", { stage: "contacted", facts: { contactChannel: "AI voice call", contactedOn: "2026-09-29", config: "2 BHK", budget: "Rs 60 to 90 lakh" } });
  await workAt(B.orgId);
  const bcThere = [...fake.leads.values()].find((l) => l.contactNo === "9812399902");
  check("configuration and budget go to LeadSquared in the chosen fields", bcThere?.bhKs.join() === "2" && bcThere.upperBudget === 7500000, JSON.stringify(bcThere));
  fake.edit(bcThere!.id, { bhKs: [3] });
  const bcBc = (await liveConnection(B.orgId))!;
  const bcBody = fake.lsqHookBody(fake.lsqView(bcThere!), bcThere!);
  const bcHook = readLeadsquaredHook(bcBody, "lead.update")!;
  await recordHook({ orgId: B.orgId, connectionId: bcBc.id, externalId: bcHook.eventId, kind: bcHook.eventType, payload: { leadId: bcHook.leadId, body: bcBody } });
  await workAt(B.orgId);
  let bcMine = await leadRow(B.orgId, bConfig);
  check("a configuration changed only in LeadSquared comes here", bcMine.facts.config === "3 BHK", bcMine.facts.config);
  await withTenant(B.orgId, (tx) => tx`UPDATE leads SET facts = facts || ${tx.json({ config: "1 BHK" } as never)} WHERE org_id = ${B.orgId} AND id = ${bConfig}`);
  fake.edit(bcThere!.id, { bhKs: [2] });
  await workAt(B.orgId);
  bcMine = await leadRow(B.orgId, bConfig);
  check("both changed it: ours wins, because a call found it out", bcMine.facts.config === "1 BHK" && fake.leads.get(bcThere!.id)!.bhKs.join() === "1",
    `${bcMine.facts.config} / ${fake.leads.get(bcThere!.id)!.bhKs}`);

  fake.remove(bcThere!.id);
  await withTenant(B.orgId, (tx) => tx`UPDATE leads SET name = 'Asha Iyer' WHERE org_id = ${B.orgId} AND id = ${bConfig}`);
  await workAt(B.orgId);
  const bRemoved = await leadRow(B.orgId, bConfig);
  check("a LeadSquared record found gone when we write to it closes ours, and nothing is made again",
    bRemoved.stage === "lost" && bRemoved.exit_reason === "Removed in CRM" && ![...fake.leads.values()].some((l) => l.contactNo === "9812399902"),
    JSON.stringify(bRemoved));

  // -------------------------------------------------------------------------
  console.log("\ndisconnecting");
  // -------------------------------------------------------------------------
  await addLead(A.orgId, A.towerC.id, "+919812345606");
  const off = await disconnectCrm({ orgId: A.orgId, userId: A.adminId });
  const [scrubbed] = await sql<{ status: string; secret: Buffer | null }[]>`SELECT status, secret FROM crm_connections WHERE org_id = ${A.orgId} ORDER BY created_at DESC LIMIT 1`;
  const [open] = await sql`SELECT count(*)::int AS n FROM crm_outbox WHERE org_id = ${A.orgId} AND status IN ('PENDING','RUNNING','WAITING')`;
  check("disconnecting scrubs the credential and takes the webhooks down", off.ok && scrubbed.status === "DISCONNECTED" && scrubbed.secret === null && fake.webhooks.length === 0);
  check("and cancels what was waiting to go out", open.n === 0, `${open.n}`);
  const afterOff = await addLead(A.orgId, A.towerC.id, "+919812345607");
  const [none2] = await sql`SELECT count(*)::int AS n FROM crm_outbox WHERE org_id = ${A.orgId} AND lead_id = ${afterOff}`;
  check("with no CRM connected, a new lead queues nothing", none2.n === 0);

  const [auditRow] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log WHERE org_id = ${A.orgId} AND action LIKE 'crm.%' AND metadata::text ~ '98123|@'`;
  check("no phone number or email reaches the audit log", auditRow.n === 0);
} catch (e) {
  check("the suite ran to the end", false, (e as Error).stack ?? String(e));
} finally {
  useCrm(null);
  useFeedFetch(null);
  for (const o of made.orgs) {
    await sql`DELETE FROM availability_feeds WHERE org_id = ${o}`;
    await sql`DELETE FROM unit_blocks WHERE org_id = ${o}`;
    await sql`DELETE FROM quotes WHERE org_id = ${o}`;
    await sql`DELETE FROM crm_visits WHERE org_id = ${o}`;
    await sql`DELETE FROM lead_tasks WHERE org_id = ${o}`;
    await sql`DELETE FROM visit_holds WHERE org_id = ${o}`;
    await sql`DELETE FROM site_visits WHERE org_id = ${o}`;
    await sql`DELETE FROM visit_slots WHERE org_id = ${o}`;
    await sql`DELETE FROM client_registrations WHERE org_id = ${o}`;
    await sql`DELETE FROM grants WHERE org_id = ${o}`;
    await sql`DELETE FROM partner_firms WHERE org_id = ${o}`;
    await sql`DELETE FROM crm_outbox WHERE org_id = ${o}`;
    await sql`DELETE FROM crm_events WHERE org_id = ${o}`;
    await sql`DELETE FROM crm_links WHERE org_id = ${o}`;
    await sql`DELETE FROM crm_mappings WHERE org_id = ${o}`;
    await sql`DELETE FROM crm_connections WHERE org_id = ${o}`;
    await sql`DELETE FROM units WHERE org_id = ${o}`;
    await sql`DELETE FROM calls WHERE org_id = ${o}`;
    await sql`DELETE FROM lead_activity WHERE org_id = ${o}`;
    await sql`DELETE FROM leads WHERE org_id = ${o}`;
    await sql`DELETE FROM audit_log WHERE org_id = ${o}`;
    await sql`DELETE FROM orgs WHERE id = ${o}`;
  }
  if (made.users.length) await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await sql.end();
  await closeDb();
  process.exitCode = fail === 0 ? 0 : 1;
}
