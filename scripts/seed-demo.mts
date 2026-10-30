/**
 * A believable two and a half months of sales activity, in the database, for
 * testing anything that reads it (Ask Jimmy first): leads from ads, forms, the
 * website, walk-ins and channel partners, the AI calls that worked them with
 * transcripts, hand-offs to the sales team, site visits and no-shows, WhatsApp
 * both ways, opt-outs, negotiations and bookings, across four towers in two
 * cities.
 *
 *   npm run seed:demo               seed it (refuses if it is already there)
 *   npm run seed:demo -- --remove   take every demo row out again
 *
 * Nothing here can ring or message anybody. Every demo phone number is in the
 * +91 55 range, which no Indian mobile uses; every lead has automation paused;
 * and no task is left due. Every row is findable again: leads carry
 * `lineage.demo`, calls an `attempt_id` starting `demo-`, messages a
 * `provider_id` starting `demo-`, tasks a `dedupe_key` starting `demo:`, and
 * the towers and project it created are named in a `demo.seeded` audit row.
 *
 * Deterministic: the same day seeds the same people with the same story.
 */
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { audit, closeDb } from "../src/lib/db/index.ts";
import { TEMPLATES, PRICE_PAISE, type MessagePurpose } from "../src/lib/message-rules.ts";
import { addDays, requiredFor, type Facts, type PathStage } from "../src/lib/lead-rules.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const REMOVE = process.argv.includes("--remove");

// ---------------------------------------------------------------------------
// Where
// ---------------------------------------------------------------------------

const [tower] = await sql<{ id: string; org_id: string; project_id: string }[]>`
  SELECT n.id, n.org_id, n.parent_id AS project_id FROM scope_nodes n
  JOIN scope_nodes p ON p.id = n.parent_id
  WHERE n.kind = 'PHASE' AND n.name = 'Tower C' AND p.name = 'Sath Heights' LIMIT 1`;
if (!tower) throw new Error("No Sath Heights · Tower C in this database to seed around.");
const ORG = tower.org_id;
const [admin] = await sql<{ user_id: string }[]>`
  SELECT user_id FROM memberships WHERE org_id = ${ORG} AND role = 'ORG_ADMIN' AND status = 'ACTIVE' LIMIT 1`;
const [org] = await sql<{ display_name: string }[]>`SELECT display_name FROM orgs WHERE id = ${ORG}`;

async function remove(): Promise<void> {
  const demoLeads = sql`SELECT id FROM leads WHERE org_id = ${ORG} AND lineage->>'demo' = 'true'`;
  const m = await sql`DELETE FROM messages WHERE org_id = ${ORG} AND (provider_id LIKE 'demo-%' OR lead_id IN (${demoLeads}))`;
  // A moved visit points at its replacement, so it goes first.
  const moved = await sql`DELETE FROM site_visits WHERE org_id = ${ORG} AND status = 'MOVED' AND lead_id IN (${demoLeads})`;
  const rest = await sql`DELETE FROM site_visits WHERE org_id = ${ORG} AND lead_id IN (${demoLeads})`;
  const v = { count: moved.count + rest.count };
  await sql`DELETE FROM call_suppressions WHERE org_id = ${ORG} AND phone LIKE '+9155%'`;
  const c = await sql`DELETE FROM calls WHERE org_id = ${ORG} AND attempt_id LIKE 'demo-%'`;
  await sql`DELETE FROM lead_tasks WHERE org_id = ${ORG} AND dedupe_key LIKE 'demo:%'`;
  const l = await sql`DELETE FROM leads WHERE org_id = ${ORG} AND lineage->>'demo' = 'true'`;
  const [seeded] = await sql<{ metadata: { nodes?: string[] } }[]>`
    SELECT metadata FROM audit_log WHERE org_id = ${ORG} AND action = 'demo.seeded' ORDER BY created_at DESC LIMIT 1`;
  let nodes = 0;
  for (const id of [...(seeded?.metadata.nodes ?? [])].reverse()) {
    const [used] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM leads WHERE scope_node_id = ${id})
           + (SELECT count(*) FROM calls WHERE scope_node_id = ${id})
           + (SELECT count(*) FROM scope_nodes WHERE parent_id = ${id}) AS n`;
    if (Number(used.n) > 0) continue;
    await sql`DELETE FROM registration_records WHERE scope_node_id = ${id}`;
    const r = await sql`DELETE FROM scope_nodes WHERE id = ${id} AND org_id = ${ORG}`.catch(() => ({ count: 0 }));
    nodes += r.count;
  }
  await audit({ orgId: ORG, actorUserId: null, action: "demo.removed", targetType: "org", targetId: ORG, metadata: { leads: l.count, calls: c.count } });
  console.log(`Removed ${l.count} leads, ${c.count} calls, ${v.count} visits, ${m.count} messages, ${nodes} towers and projects.`);
}

if (REMOVE) {
  await remove();
  await sql.end();
  await closeDb();
  process.exit(0);
}

const [already] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM leads WHERE org_id = ${ORG} AND lineage->>'demo' = 'true'`;
if (already.n > 0) {
  console.log(`Demo data is already here (${already.n} leads). Run with --remove first to seed it again.`);
  await sql.end();
  await closeDb();
  process.exit(0);
}

// The towers: Tower C exists; the rest are written the way the console's
// createPhase() and createProject() write them (a node with its ltree path,
// and a phase's registration record starting BLOCKED), inline because those
// modules import through the "@/" alias a plain node run cannot resolve.
const before = new Set((await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${ORG}`).map((r) => r.id));
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
async function nodeUnder(parentId: string, kind: "REGION" | "PROJECT" | "PHASE", name: string): Promise<string> {
  const [have] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE parent_id = ${parentId} AND name = ${name} AND kind = ${kind}`;
  if (have) return have.id;
  const [parent] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE id = ${parentId}`;
  const [node] = await sql<{ id: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${ORG}, ${parentId}, ${kind}, ${name}, ${slug(name)}, ${`${parent.path}.${slug(name)}`}::ltree)
    RETURNING id`;
  if (kind === "PHASE") await sql`INSERT INTO registration_records (scope_node_id, org_id, status) VALUES (${node.id}, ${ORG}, 'BLOCKED')`;
  await audit({ orgId: ORG, actorUserId: admin.user_id, action: "scope_node.created", targetType: "scope_node", targetId: node.id, metadata: { kind, name, demo: true } });
  return node.id;
}
const towerA = await nodeUnder(tower.project_id, "PHASE", "Tower A");
const towerB = await nodeUnder(tower.project_id, "PHASE", "Tower B");
const [entity] = await sql<{ id: string }[]>`
  SELECT r.parent_id AS id FROM scope_nodes r WHERE r.id = (SELECT parent_id FROM scope_nodes WHERE id = ${tower.project_id})`;
const pune = await nodeUnder(entity.id, "REGION", "Pune");
const riverside = await nodeUnder(pune, "PROJECT", "Riverside Greens");
const phase1 = await nodeUnder(riverside, "PHASE", "Phase 1");
// Every node this seed ever created, including on an earlier run that reused them.
const created = (await sql<{ id: string }[]>`
  SELECT n.id FROM scope_nodes n
  WHERE n.org_id = ${ORG} AND EXISTS (
    SELECT 1 FROM audit_log a WHERE a.org_id = ${ORG} AND a.action = 'scope_node.created'
      AND a.target_id = n.id::text AND a.metadata->>'demo' = 'true')
  ORDER BY n.path`).map((r) => r.id);
void before;

type Tower = {
  id: string;
  project: string;
  tower: string;
  city: string;
  area: string;
  letter: string;
  floors: number;
  weight: number;
  prices: Record<string, [number, number]>;
};
const TOWERS: Tower[] = [
  { id: tower.id, project: "Sath Heights", tower: "Tower C", city: "Mumbai", area: "Andheri East", letter: "C", floors: 28, weight: 42,
    prices: { "1 BHK": [7_800_000, 9_200_000], "2 BHK": [11_800_000, 14_500_000], "3 BHK": [18_500_000, 22_000_000] } },
  { id: towerA, project: "Sath Heights", tower: "Tower A", city: "Mumbai", area: "Andheri East", letter: "A", floors: 24, weight: 26,
    prices: { "1 BHK": [7_500_000, 8_800_000], "2 BHK": [11_200_000, 13_600_000] } },
  { id: towerB, project: "Sath Heights", tower: "Tower B", city: "Mumbai", area: "Andheri East", letter: "B", floors: 24, weight: 10,
    prices: { "2 BHK": [11_500_000, 13_900_000], "3 BHK": [17_800_000, 21_000_000] } },
  { id: phase1, project: "Riverside Greens", tower: "Phase 1", city: "Pune", area: "Kharadi", letter: "R", floors: 18, weight: 22,
    prices: { "2 BHK": [7_200_000, 8_800_000], "3 BHK": [10_500_000, 12_500_000] } },
];

// ---------------------------------------------------------------------------
// Chance, made repeatable
// ---------------------------------------------------------------------------

let s32 = 20260926;
const rnd = () => {
  s32 |= 0;
  s32 = (s32 + 0x6d2b79f5) | 0;
  let t = Math.imul(s32 ^ (s32 >>> 15), 1 | s32);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const chance = (p: number) => rnd() < p;
function weighted<T>(items: [T, number][]): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [v, w] of items) if ((r -= w) < 0) return v;
  return items[items.length - 1][0];
}

// ---------------------------------------------------------------------------
// Time, in IST
// ---------------------------------------------------------------------------

const IST = 330 * 60_000;
const NOW = Date.now();
const TODAY = new Date(NOW + IST).toISOString().slice(0, 10);
/** An instant on an IST date at an IST time. */
const at = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);
const istDate = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const istHour = (ms: number) => new Date(ms + IST).getUTCHours();
/** The same instant, or 10:00 to 11:30 the next calling morning when it falls outside calling hours. */
function inHours(ms: number): number {
  const h = istHour(ms);
  if (h >= 10 && h < 21) return ms;
  const day = h >= 21 ? addDays(istDate(ms), 1) : istDate(ms);
  return at(day, 10, 0) + between(0, 90) * 60_000;
}
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const FIRST = [
  "Aarav", "Rohan", "Nitin", "Sameer", "Vikram", "Aditya", "Kunal", "Rahul", "Siddharth", "Amit", "Pranav", "Harsh",
  "Imran", "Farhan", "Joseph", "Anil", "Suresh", "Mahesh", "Tushar", "Ketan", "Omkar", "Gaurav", "Vivek", "Manish",
  "Priya", "Pooja", "Sneha", "Anjali", "Neha", "Kavya", "Tanvi", "Shruti", "Ritu", "Meera", "Aisha", "Sana",
  "Divya", "Swati", "Pallavi", "Rashmi", "Nandini", "Ishita", "Fatima", "Maria", "Radhika", "Aparna", "Deepa", "Komal",
];
const LAST = [
  "Sharma", "Gupta", "Patil", "Deshmukh", "Kulkarni", "Joshi", "Pawar", "Jadhav", "Shinde", "More", "Gaikwad", "Apte",
  "Mehta", "Shah", "Patel", "Desai", "Iyer", "Nair", "Menon", "Reddy", "Rao", "Pillai", "Khan", "Shaikh", "Qureshi",
  "Ansari", "D'Souza", "Fernandes", "Pereira", "Malhotra", "Kapoor", "Ahuja", "Chawla", "Verma", "Singh", "Agarwal",
  "Mishra", "Pandey", "Bapat", "Kale", "Sawant", "Naik",
];
/** People the sample screens already talk about, kept so every screen tells one story. */
const NAMED: { name: string; fate: Fate; tower: number; ageDays: number; channel?: Channel; cp?: string }[] = [
  { name: "Priya Sharma", fate: "visit_scheduled", tower: 0, ageDays: 6 },
  { name: "Nitin Gupta", fate: "booked", tower: 0, ageDays: 38 },
  { name: "Pooja Nair", fate: "negotiation", tower: 0, ageDays: 22, channel: "MANUAL", cp: "Keystone Realty" },
  { name: "Tanvi Bapat", fate: "lost_after_visit", tower: 0, ageDays: 30 },
  { name: "Suresh Yadav", fate: "lost_early", tower: 3, ageDays: 12 },
];

const SALES = ["Nikhil Rao", "Asha Menon", "Karan Mehta", "Rutuja Pawar", "Imtiaz Khan"];
/** Their phones, for the hand-offs Vobiz would have logged. In the unused +91 56 range. */
const SALES_PHONE = Object.fromEntries(SALES.map((n, i) => [n, `+9156000000${String(i + 1).padStart(2, "0")}`]));
const CP_FIRMS = ["Keystone Realty", "Prime Homes Realty", "Skyline Estates", "Urban Nest Advisors"];

let phoneSeq = 0;
const nextPhone = () => `+9155${String(10_000_000 + phoneSeq++ * 7919).slice(-8)}`;

// ---------------------------------------------------------------------------
// What happened to each lead
// ---------------------------------------------------------------------------

type Fate =
  | "new_unreached" | "contacted" | "qualified" | "visit_scheduled" | "visit_done" | "negotiation" | "booked"
  | "nurture_unreached" | "nurture_later" | "nurture_noshow" | "lost_early" | "lost_after_visit" | "lost_optout" | "lost_wrong";
type Channel = "META_FORM" | "GOOGLE_FORM" | "WEBSITE" | "MANUAL";

function fateFor(ageDays: number): Fate {
  if (ageDays < 3) return weighted<Fate>([["new_unreached", 30], ["contacted", 35], ["qualified", 22], ["visit_scheduled", 13]]);
  if (ageDays < 14) return weighted<Fate>([["new_unreached", 4], ["contacted", 18], ["qualified", 18], ["visit_scheduled", 16], ["visit_done", 10],
    ["nurture_unreached", 6], ["nurture_later", 8], ["lost_early", 10], ["lost_optout", 4], ["lost_wrong", 6]]);
  if (ageDays < 40) return weighted<Fate>([["contacted", 6], ["qualified", 8], ["visit_scheduled", 3], ["visit_done", 18], ["negotiation", 11],
    ["booked", 9], ["nurture_unreached", 8], ["nurture_later", 10], ["nurture_noshow", 5], ["lost_early", 10], ["lost_after_visit", 8], ["lost_optout", 2], ["lost_wrong", 2]]);
  return weighted<Fate>([["visit_done", 6], ["negotiation", 6], ["booked", 16], ["nurture_unreached", 12], ["nurture_later", 16],
    ["nurture_noshow", 6], ["lost_early", 18], ["lost_after_visit", 16], ["lost_optout", 2], ["lost_wrong", 2]]);
}

const SOURCES: Record<Channel, { source: string; campaigns: (t: Tower) => string[] }> = {
  META_FORM: { source: "Meta lead form", campaigns: (t) => [`${t.project} ${t.tower} · Launch offer`, `${t.project} · Weekend site visits`, `${t.project} · Festive offer`] },
  GOOGLE_FORM: { source: "Google lead form", campaigns: (t) => [`Search · ${t.area} ${Object.keys(t.prices)[0]}`, `Search · ${t.project}`] },
  WEBSITE: { source: "Website", campaigns: () => ["organic", "instagram", "google"] },
  MANUAL: { source: "Walk-in", campaigns: () => [] },
};

const budgetBand = (rupees: number) =>
  rupees < 6_000_000 ? "Under Rs 60 lakh" : rupees < 9_000_000 ? "Rs 60 to 90 lakh" : rupees <= 15_000_000 ? "Rs 90 lakh to 1.5 Cr" : "Above Rs 1.5 Cr";
const spoken = (rupees: number) =>
  rupees >= 10_000_000 ? `${(rupees / 10_000_000).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")} crore` : `${Math.round(rupees / 100_000)} lakhs`;
const TIMELINE_VAR: Record<string, string> = {
  "Within 30 days": "within_3_months", "1 to 3 months": "within_3_months", "3 to 6 months": "3_to_6_months",
  "6 months or more": "6_plus_months", "Just exploring": "not_specified",
};

// ---------------------------------------------------------------------------
// Rows, collected and then written
// ---------------------------------------------------------------------------

const LANG_NAME = { hi: "Hindi", mr: "Marathi", en: "English" } as const;
type Lang = keyof typeof LANG_NAME;
type Turn = { role: "agent" | "user"; en: string; indic: null };

const out = {
  leads: [] as Record<string, unknown>[],
  activity: [] as Record<string, unknown>[],
  tasks: [] as Record<string, unknown>[],
  calls: [] as Record<string, unknown>[],
  visits: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[],
  suppressions: [] as Record<string, unknown>[],
};

const APP = { id: process.env.SARVAM_APP_ID || "salesdesk--5ac68ad3-401d", version: Number(process.env.SARVAM_APP_VERSION || 4) };
const FROM = process.env.SARVAM_FROM_NUMBER || "+912265480217";
const MAPS = "https://maps.google.com/?q=19.1136,72.8697";
const MAPS_PUNE = "https://maps.google.com/?q=18.5515,73.9348";

function fill(purpose: MessagePurpose, values: string[]): string {
  let body = TEMPLATES[purpose].body;
  values.forEach((v, i) => (body = body.replace(`{{${i + 1}}}`, v)));
  return body;
}

function makeLead(i: number, seed?: (typeof NAMED)[number]) {
  const ageDays = seed?.ageDays ?? Math.floor(Math.pow(rnd(), 1.35) * 75);
  const t = seed ? TOWERS[seed.tower] : weighted(TOWERS.map((x) => [x, x.weight] as [Tower, number]));
  const name = seed?.name ?? `${pick(FIRST)} ${pick(LAST)}`;
  const first = name.split(" ")[0];
  const lang: Lang = t.city === "Pune" ? weighted<Lang>([["mr", 45], ["hi", 30], ["en", 25]]) : weighted<Lang>([["hi", 50], ["mr", 25], ["en", 25]]);
  const channel: Channel = seed?.channel ?? weighted<Channel>([["META_FORM", 52], ["GOOGLE_FORM", 20], ["WEBSITE", 14], ["MANUAL", 14]]);
  const fate: Fate = seed?.fate ?? fateFor(ageDays);
  const phone = nextPhone();
  const leadId = randomUUID();
  const configs = Object.keys(t.prices);
  const config = pick(configs);
  const [lo, hi] = t.prices[config];
  const price = Math.round((lo + rnd() * (hi - lo)) / 50_000) * 50_000;
  const budgetRupees = Math.round((price * (0.9 + rnd() * 0.25)) / 100_000) * 100_000;
  const timeline = weighted([["Within 30 days", 12], ["1 to 3 months", 34], ["3 to 6 months", 28], ["6 months or more", 14], ["Just exploring", 12]] as [string, number][]);
  const owner = pick(SALES);
  const cp = seed?.cp ?? (channel === "MANUAL" && chance(0.5) ? pick(CP_FIRMS) : undefined);

  // When they enquired: a working-day-ish hour, some at night.
  const enquiryDay = addDays(TODAY, -ageDays);
  let enquired = at(enquiryDay, weighted([[9, 6], [11, 10], [13, 10], [15, 8], [18, 12], [20, 10], [22, 6], [23, 3]] as [number, number][]), between(0, 59));
  if (enquired > NOW - 20 * 60_000) enquired = NOW - between(25, 180) * 60_000;

  const src = SOURCES[channel];
  const campaign = src.campaigns(t).length ? pick(src.campaigns(t)) : null;
  const lineage: Record<string, unknown> = { demo: true };
  if (channel === "META_FORM") Object.assign(lineage, { campaign, ad_set: `${t.city} · 25-45 · property`, ad: `${config} · ${t.tower}`, form: `${t.project} enquiry` });
  if (channel === "GOOGLE_FORM") Object.assign(lineage, { campaign, gclid: `demo-${leadId.slice(0, 8)}` });
  if (channel === "WEBSITE") Object.assign(lineage, { utm_source: campaign, utm_medium: campaign === "organic" ? "organic" : "cpc", landing: `/${t.project.toLowerCase().replace(/ /g, "-")}` });
  if (cp) Object.assign(lineage, { cp_firm: cp });
  const source = cp ? "Channel partner" : channel === "MANUAL" ? pick(["Walk-in", "Referral", "99acres", "MagicBricks"]) : src.source;

  const facts: Facts = {};
  let stage: string = "new";
  let pathStage: PathStage = "new";
  let exitReason: string | null = null;
  let followUpOn: string | null = null;
  let temperature: "HOT" | "WARM" | "COLD" | null = null;
  let needsPerson: string | null = null;
  let last = enquired;
  let taskN = 0;

  const property = `${t.project} ${t.tower}`;
  const notice = `calling from ${org.display_name} as an AI assistant, and this call is recorded for quality purposes`;
  const vars = { user_name: first, developer_name: org.display_name, property_viewed: property, enquiry_location: t.city,
    lead_source: source, enquiry_budget: "", enquiry_bhk: "", call_notice: notice, salesdesk_org: ORG, salesdesk_call: "" };

  const activity = (kind: string, when: number, extra: Record<string, unknown> = {}) =>
    out.activity.push({ org_id: ORG, lead_id: leadId, kind, at: iso(when), detail: {}, ...extra });
  const moveTo = (to: PathStage | "nurture" | "lost", when: number, reason: string) => {
    activity("STAGE", when, { from_stage: stage, to_stage: to, reason });
    stage = to;
    if (to !== "nurture" && to !== "lost") pathStage = to;
    last = Math.max(last, when);
  };
  const task = (kind: "CALL" | "MESSAGE", purpose: string, when: number, result: string) => {
    const id = randomUUID();
    out.tasks.push({ id, org_id: ORG, lead_id: leadId, kind, purpose, due_at: iso(when), state: "DONE", dedupe_key: `demo:${leadId}:${purpose}:${taskN++}`,
      attempts: 1, result, created_at: iso(when - 60_000), done_at: iso(when) });
    return id;
  };
  const message = (purpose: MessagePurpose, when: number, values: string[], status = "READ") => {
    if (when > NOW) return;
    const tpl = TEMPLATES[purpose];
    const taskId = task("MESSAGE", purpose, when, "Sent");
    out.messages.push({ org_id: ORG, lead_id: leadId, task_id: taskId, direction: "OUT", purpose, template: tpl.name, category: tpl.category,
      language: "en", variables: values, body: fill(purpose, values), phone, status, provider_id: `demo-${randomUUID()}`,
      cost_paise: PRICE_PAISE[tpl.category], created_at: iso(when), sent_at: iso(when + 2_000), delivered_at: iso(when + 6_000),
      read_at: status === "READ" ? iso(when + between(2, 240) * 60_000) : null });
    last = Math.max(last, when);
  };
  const reply = (when: number, body: string) => {
    if (when > NOW) return;
    out.messages.push({ org_id: ORG, lead_id: leadId, direction: "IN", body, phone, status: "RECEIVED", variables: [], provider_id: `demo-${randomUUID()}`, created_at: iso(when) });
    last = Math.max(last, when);
  };

  type CallOpts = {
    agent?: "qualifier" | "reminder" | "recovery" | "reengage";
    purpose: string;
    attempt: number;
    connectivity: "connected" | "no_answer" | "busy";
    outcome: string;
    durationS?: number;
    transcript?: Turn[];
    finalVars?: Record<string, unknown>;
    handoff?: { to: string; billS: number };
  };
  const call = (when: number, o: CallOpts) => {
    const id = randomUUID();
    const taskId = task("CALL", o.purpose, when, o.connectivity === "connected" ? "Called" : "Not answered");
    const dur = o.connectivity === "connected" ? (o.durationS ?? 120) : null;
    out.calls.push({
      id, org_id: ORG, lead_id: leadId, scope_node_id: t.id, agent: o.agent ?? "qualifier", app_id: APP.id, app_version: APP.version,
      from_number: FROM, to_number: phone, attempt_id: `demo-${id}`, status: "DONE", connectivity: o.connectivity, outcome: o.outcome,
      duration_s: dur, interaction_id: null, failure_reason: null, final_variables: o.finalVars ?? null, transcript: o.transcript ?? [],
      payload: { demo: true }, variables: { ...vars, salesdesk_call: id }, brain_sources: [], placed_by: null,
      placed_at: iso(when), ended_at: iso(when + ((dur ?? 30) + 8) * 1000), task_id: taskId, attempt: o.attempt,
      handoff_state: o.handoff ? "ENDED" : null, handoff_to: o.handoff?.to ?? null, handoff_rang: o.handoff ? [o.handoff.to] : null,
      handoff_at: o.handoff ? iso(when + (dur ?? 0) * 1000 - 5_000) : null, handoff_ended_at: o.handoff ? iso(when + ((dur ?? 0) + o.handoff.billS) * 1000) : null,
      handoff_bill_s: o.handoff?.billS ?? null,
    });
    last = Math.max(last, when);
    return id;
  };

  // --- arrival ------------------------------------------------------------
  activity("CAPTURED", enquired, { reason: source, detail: { channel, campaign } });
  let cursor = enquired;
  if (istHour(enquired) < 10 || istHour(enquired) >= 21) {
    message("ACK", enquired + 30_000, [first, org.display_name]);
    if (chance(0.3)) reply(enquired + between(5, 60) * 60_000, pick(["Please call after 6 pm", "Ok", "Call tomorrow morning", "Thanks, waiting for the call"]));
  }
  cursor = inHours(enquired + between(1, 4) * 60_000);

  const unreached = fate === "new_unreached" || fate === "nurture_unreached";
  const hot = ["negotiation", "booked"].includes(fate) || (fate === "visit_done" && chance(0.4)) || (fate === "qualified" && chance(0.35));

  // --- the first calls ----------------------------------------------------
  const tries = unreached ? Math.min(3, ageDays < 1 ? 1 : ageDays < 2 ? 2 : 3) : chance(0.3) ? 2 : 1;
  for (let n = 1; n <= tries; n++) {
    if (cursor > NOW) break;
    const lastTry = n === tries && !unreached;
    if (!lastTry) {
      call(cursor, { purpose: n === 1 ? "FIRST_CALL" : "RETRY_CALL", attempt: n, connectivity: chance(0.8) ? "no_answer" : "busy", outcome: "NO_ANSWER" });
      if (n === 1) message("MISSED_CALL", cursor + 2 * 60_000, [first, property], chance(0.6) ? "READ" : "DELIVERED");
      cursor = n === 1 ? inHours(cursor + 2 * 3_600_000) : at(addDays(istDate(cursor), 1), 18, between(0, 59));
    }
  }
  if (unreached) {
    if (fate === "nurture_unreached" && ageDays >= 5) {
      moveTo("nurture", at(addDays(enquiryDay, 3), 19, 10), "Could not reach");
      exitReason = "Could not reach";
      followUpOn = addDays(enquiryDay, 33);
      temperature = "COLD";
      needsPerson = null;
      message("NURTURE", at(addDays(enquiryDay, 30), 11, 20), [first, property], "DELIVERED");
    } else {
      needsPerson = tries >= 3 ? "Not reached after 3 calls" : null;
    }
  } else if (cursor <= NOW) {
    // --- the conversation -----------------------------------------------
    const bhk = config.replace(" ", "");
    const budgetWords = spoken(budgetRupees);
    const q: Turn[] = [
      { role: "agent", en: `Hello, am I speaking with ${first}?`, indic: null },
      { role: "user", en: pick(["Yes, speaking.", "Yes, tell me.", "Haan, bolo.", "Yes, who is this?"]), indic: null },
      { role: "agent", en: `Hello ${first} ji. I am ${notice}. We saw your interest in ${property} in ${t.city}. Are you still looking?`, indic: null },
    ];
    let disp = "warm_lead";
    let outcome = "QUALIFIED";
    let handoff: CallOpts["handoff"];
    let visitText: string | null = null;
    let durationS = between(150, 330);
    const early = fate === "lost_early" || fate === "lost_optout" || fate === "lost_wrong";
    if (fate === "lost_wrong") {
      q.push({ role: "user", en: pick(["Wrong number, I did not enquire about any flat.", "Who? There is nobody by that name here."]), indic: null },
        { role: "agent", en: "Sorry for the trouble. The number may have been entered wrongly. Have a good day.", indic: null });
      disp = "wrong_person"; outcome = "WRONG_NUMBER"; durationS = between(18, 40);
    } else if (fate === "lost_optout") {
      q.push({ role: "user", en: "I am not interested. Please do not call me again.", indic: null },
        { role: "agent", en: "Understood, sorry for disturbing you. We will not call you again.", indic: null });
      disp = "dnc"; outcome = "OPTED_OUT"; durationS = between(20, 45);
    } else if (fate === "lost_early") {
      const why = pick(["The budget is too high for me.", "I have already bought somewhere else.", "Andheri is too far from my office.", "I was just checking prices, not buying."]);
      q.push({ role: "user", en: why, indic: null },
        { role: "agent", en: "I understand. Thank you for your time, and do reach out whenever you are ready.", indic: null });
      disp = "not_interested"; outcome = "NOT_INTERESTED"; durationS = between(40, 95);
    } else {
      q.push(
        { role: "user", en: pick(["Yes, still looking.", "Yes, same requirement.", "Yes, tell me more."]), indic: null },
        { role: "agent", en: "What budget do you have in mind for the home?", indic: null },
        { role: "user", en: `Around ${budgetWords}.`, indic: null },
        { role: "agent", en: `Around ${budgetWords}, noted. Which size are you looking at?`, indic: null },
        { role: "user", en: `${config}.`, indic: null },
        { role: "agent", en: "And by when are you planning to buy?", indic: null },
        { role: "user", en: `${timeline === "Just exploring" ? "Just exploring for now." : timeline}.`, indic: null },
      );
      if (fate === "contacted") {
        q.push({ role: "user", en: "I am driving right now, call me in the evening.", indic: null },
          { role: "agent", en: "Sure, we will call you this evening. Thank you.", indic: null });
        disp = "callback_requested"; outcome = "CALLBACK"; durationS = between(60, 120);
      } else if (fate === "nurture_later") {
        q.push({ role: "user", en: "Not in the next few months, maybe next year.", indic: null },
          { role: "agent", en: "No problem, we will stay in touch. Thank you for your time.", indic: null });
        disp = "cold_lead"; outcome = "QUALIFIED";
      } else if (hot && chance(0.55)) {
        q.push({ role: "user", en: "What is the exact price? Connect me to someone.", indic: null },
          { role: "agent", en: "The sales manager has the exact price and offers. I am connecting you now.", indic: null });
        disp = "handed_off"; outcome = "HANDED_OFF";
        handoff = { to: SALES_PHONE[owner], billS: between(3, 14) * 60 };
      } else if (["visit_scheduled", "visit_done", "negotiation", "booked", "lost_after_visit", "nurture_noshow"].includes(fate) && chance(0.7)) {
        const day = pick(["Saturday", "Sunday", "tomorrow", "Wednesday"]);
        visitText = `${day} at ${pick(["11 am", "12 pm", "4 pm", "5 pm", "4:30 pm"])}`;
        q.push({ role: "agent", en: "You seem like a great fit. Would you like to see the site? Visits are open 10 am to 7 pm, every day.", indic: null },
          { role: "user", en: `Yes, ${visitText} works.`, indic: null },
          { role: "agent", en: `Booked for ${visitText}. A sales representative will confirm, and directions come on WhatsApp.`, indic: null });
        disp = hot ? "hot_lead" : "warm_lead";
      } else {
        q.push({ role: "agent", en: "Thank you. Our team will share the best options for you.", indic: null });
        disp = hot ? "hot_lead" : chance(0.6) ? "warm_lead" : "cold_lead";
      }
    }
    const finalVars = {
      lead_disposition: disp,
      budget: early ? "not_specified" : budgetWords,
      bhk_preference: early ? "not_specified" : bhk,
      location_preference: early ? "not_specified" : t.area,
      purchase_timeline: early ? "not_specified" : TIMELINE_VAR[timeline],
      site_visit_status: visitText ? "booked" : "not_offered",
      site_visit_time: visitText ?? "not_booked",
      call_summary: early
        ? `${first} ${disp === "wrong_person" ? "did not make the enquiry" : disp === "dnc" ? "asked not to be called again" : "is not interested"}. No follow-up.`
        : `${first} wants a ${config} around ${budgetWords}, buying ${timeline.toLowerCase()}. ${handoff ? "Put through to sales on the call." : visitText ? `Site visit booked for ${visitText}.` : disp === "callback_requested" ? "Asked to be called back." : "Team to share options."}`,
    };
    const callId = call(cursor, { purpose: tries > 1 ? "RETRY_CALL" : "FIRST_CALL", attempt: tries, connectivity: "connected", outcome, durationS, transcript: q, finalVars, handoff });
    const talked = cursor + durationS * 1000;
    Object.assign(facts, { contactChannel: "AI voice call", contactedOn: istDate(cursor) });
    moveTo("contacted", talked, "Reached on the call");
    if (disp !== "wrong_person" && disp !== "dnc") message("AFTER_CALL", talked + 60_000, [first, property,
      handoff ? "Our sales manager is with you on the call." : visitText ? "Directions for your visit follow." : "We will share the best options shortly.", "+91 22 4000 1234"]);

    if (disp === "dnc") {
      out.suppressions.push({ org_id: ORG, phone, reason: "SAID_ON_CALL", call_id: callId, created_at: iso(talked) });
      moveTo("lost", talked + 5_000, "Asked not to be contacted");
      exitReason = "Asked not to be contacted";
      temperature = "COLD";
    } else if (disp === "wrong_person") {
      moveTo("lost", talked + 5_000, "Wrong number");
      exitReason = "Wrong number";
    } else if (fate === "lost_early") {
      const reason = pick(["Budget mismatch", "Bought elsewhere", "Location did not suit", "Not interested"]);
      moveTo("lost", talked + 5_000, reason);
      exitReason = reason;
      temperature = "COLD";
    } else if (fate === "contacted") {
      temperature = "WARM";
      const back = inHours(at(istDate(talked), 18, between(0, 50)));
      if (back < NOW) {
        call(back, { purpose: "CALLBACK", attempt: 1, connectivity: "no_answer", outcome: "NO_ANSWER" });
        needsPerson = "Asked for a call back; not reached since";
      }
    } else {
      // Qualified.
      Object.assign(facts, { config, budget: budgetBand(budgetRupees), timeline, owner });
      moveTo("qualified", talked + 10_000, "Reached on the call");
      activity("ASSIGNED", talked + 12_000, { detail: { owner } });
      temperature = disp === "hot_lead" || disp === "handed_off" ? "HOT" : disp === "cold_lead" ? "COLD" : "WARM";
      if (handoff) needsPerson = ageDays < 2 ? "Handed to sales on the call. Follow up today" : null;
      else if (temperature === "HOT" && fate === "qualified") needsPerson = "Hot lead, promised a call from sales. Call now";

      if (fate === "nurture_later") {
        moveTo("nurture", talked + 20_000, "Buying in 6 months or more");
        exitReason = "Buying in 6 months or more";
        followUpOn = addDays(istDate(talked), 60);
        message("NURTURE", at(addDays(istDate(talked), 30), 11, 5), [first, property], "DELIVERED");
      }

      // --- the visit ----------------------------------------------------
      const visits = ["visit_scheduled", "visit_done", "negotiation", "booked", "lost_after_visit", "nurture_noshow"].includes(fate);
      if (visits) {
        const future = fate === "visit_scheduled";
        let visitDay: string;
        if (future) visitDay = seed ? TODAY : addDays(TODAY, between(1, 5));
        else visitDay = addDays(istDate(talked), between(1, 5));
        if (!future && at(visitDay, 12) > NOW - 3 * 3_600_000) visitDay = addDays(TODAY, -1);
        const slot = seed?.name === "Priya Sharma" ? [16, 30] : pick([[11, 0], [11, 30], [12, 0], [15, 0], [16, 0], [16, 30], [17, 0], [17, 30]]);
        const when = at(visitDay, slot[0], slot[1]);
        const host = pick(SALES);
        const bookedAt = visitText ? talked : talked + between(1, 30) * 3_600_000;
        Object.assign(facts, { visitDate: visitDay, visitTime: `${String(slot[0]).padStart(2, "0")}:${String(slot[1]).padStart(2, "0")}`, visitHost: host });
        moveTo("visit_scheduled", bookedAt, visitText ? "Visit booked on the call" : "Visit booked by the sales team");
        const where = t.city === "Pune" ? MAPS_PUNE : MAPS;
        const whenText = `${new Date(when + IST).toUTCString().slice(0, 11)} at ${slot[0] > 12 ? slot[0] - 12 : slot[0]}${slot[1] ? `:${slot[1]}` : ""} ${slot[0] >= 12 ? "pm" : "am"}`;
        message("VISIT_CONFIRMED", bookedAt + 90_000, [first, property, whenText, where]);
        if (when - bookedAt > 30 * 3_600_000) message("VISIT_REMINDER_DAY", when - 24 * 3_600_000 - 3_600_000, [first, property, whenText, where]);
        message("VISIT_REMINDER_SOON", when - 2 * 3_600_000, [first, property, whenText, where]);
        if (chance(0.3)) reply(bookedAt + between(3, 90) * 60_000, pick(["Ok, see you", "Thanks", "Can I bring my parents?", "Will be there"]));

        const visitId = randomUUID();
        const noShow = fate === "nurture_noshow" || (!future && chance(0.12));
        if (future) {
          out.visits.push({ id: visitId, org_id: ORG, lead_id: leadId, scope_node_id: t.id, scheduled_at: iso(when), status: "CONFIRMED",
            booked_via: visitText ? "AI_CALL" : "CONSOLE", asked_for: visitText, call_id: visitText ? callId : null, created_at: iso(bookedAt) });
          temperature = temperature ?? "WARM";
        } else if (noShow) {
          out.visits.push({ id: visitId, org_id: ORG, lead_id: leadId, scope_node_id: t.id, scheduled_at: iso(when),
            status: fate === "nurture_noshow" ? "LAPSED" : "MOVED", booked_via: visitText ? "AI_CALL" : "CONSOLE", asked_for: visitText,
            call_id: visitText ? callId : null, created_at: iso(bookedAt), moved_to: null });
          message("NO_SHOW", when + 45 * 60_000, [first, property], "DELIVERED");
          const rec = when + 150 * 60_000;
          if (rec < NOW) call(inHours(rec), { agent: "recovery", purpose: "RECOVERY_CALL", attempt: 1, connectivity: fate === "nurture_noshow" ? "no_answer" : "connected",
            outcome: fate === "nurture_noshow" ? "NO_ANSWER" : "QUALIFIED", durationS: 70,
            transcript: fate === "nurture_noshow" ? [] : [
              { role: "agent", en: `Hello ${first} ji, we missed you at ${property} today. Would you like a new time?`, indic: null },
              { role: "user", en: "Sorry, something came up. Is Sunday possible?", indic: null },
              { role: "agent", en: "Sunday at 11 am is booked for you. See you then.", indic: null },
            ],
            finalVars: fate === "nurture_noshow" ? undefined : { lead_disposition: "warm_lead", site_visit_status: "booked", site_visit_time: "Sunday at 11 am", call_summary: `${first} missed the visit and rebooked for Sunday.` } });
          if (fate === "nurture_noshow") {
            moveTo("nurture", when + 72 * 3_600_000, "No-show");
            exitReason = "No-show";
            followUpOn = addDays(visitDay, 30);
            temperature = "COLD";
          } else {
            // Rebooked and attended.
            const second = Math.min(at(addDays(visitDay, between(2, 5)), 11, 0), NOW - 4 * 3_600_000);
            const secondId = randomUUID();
            out.visits[out.visits.length - 1].moved_to = secondId;
            out.visits.push(...visitRows(secondId, second, "CONSOLE", null, null, host));
          }
        } else {
          out.visits.push(...visitRows(visitId, when, visitText ? "AI_CALL" : "CONSOLE", visitText, visitText ? callId : null, host));
        }

        function visitRows(id: string, ms: number, via: string, asked: string | null, callRef: string | null, hostName: string) {
          const interest = hot ? "Hot" : fate === "lost_after_visit" ? pick(["Warm", "Cold"]) : pick(["Warm", "Hot", "Warm"]);
          const objection = hot ? pick(["None", "Price", "Loan"]) : pick(["Price", "Location", "Possession date", "Carpet area", "Family", "Layout"]);
          const next = fate === "booked" || fate === "negotiation" ? "Share the cost sheet" : fate === "lost_after_visit" ? "Nothing planned" : pick(["Second visit with family", "Share the payment plan", "Call back in a week"]);
          Object.assign(facts, { interest, objection, visitHost: hostName });
          const done = ms + between(40, 90) * 60_000;
          moveTo("visit_done", done, "Visit recorded by the host");
          message("POST_VISIT", done + 20 * 60_000, [first, property, "+91 22 4000 1234"]);
          message("POST_VISIT_FOLLOWUP", at(addDays(istDate(done), 2), 11, 30), [first, property], chance(0.5) ? "READ" : "DELIVERED");
          temperature = interest === "Hot" ? "HOT" : interest === "Cold" ? "COLD" : "WARM";
          return [{ id, org_id: ORG, lead_id: leadId, scope_node_id: t.id, scheduled_at: iso(ms), status: "VISITED", booked_via: via,
            asked_for: asked, call_id: callRef, arrived_at: iso(ms + between(-10, 20) * 60_000), completed_at: iso(done),
            outcome: { interest, objection, next, note: `${hostName} showed the ${config} sample flat.` }, created_at: iso(ms - 2 * 86_400_000) }];
        }

        // --- after the visit ----------------------------------------------
        if (fate === "lost_after_visit") {
          const reason = pick(["Bought elsewhere", "Budget mismatch", "Location did not suit"]);
          moveTo("lost", Math.min(NOW - 3_600_000, last + between(3, 9) * 86_400_000), reason);
          exitReason = reason;
          temperature = "COLD";
        }
        if (fate === "negotiation" || fate === "booked") {
          const floor = between(3, t.floors);
          const unit = `${t.letter}-${floor}${String(between(1, 6)).padStart(2, "0")}`;
          const quote = Math.round((price + floor * 25_000) / 10_000) * 10_000;
          Object.assign(facts, { unit, quote: String(quote) });
          const negAt = Math.min(NOW - 2 * 3_600_000, last + between(1, 4) * 86_400_000);
          moveTo("negotiation", negAt, "Cost sheet shared");
          activity("NOTE", negAt + 60_000, { note: `Quoted Rs ${(quote / 100_000).toFixed(1)} lakh for ${unit}, ${config}. ${pick(["Asked for a floor rise waiver.", "Wants the parking included.", "Comparing with a Lodha project.", "Loan sanction in progress."])}` });
          temperature = "HOT";
          if (fate === "negotiation" && NOW - negAt > 4 * 86_400_000) needsPerson = "Quote shared, no decision yet. Follow up";
          if (fate === "booked") {
            const bookAt = Math.min(NOW - 3_600_000, negAt + between(2, 8) * 86_400_000);
            const agreement = Math.round(quote * (0.97 + rnd() * 0.03) / 10_000) * 10_000;
            Object.assign(facts, { bookedOn: istDate(bookAt), agreement: String(agreement), token: String(pick([100_000, 200_000, 251_000, 500_000])) });
            if (seed?.name === "Nitin Gupta") facts.unit = "C-803";
            moveTo("booked", bookAt, "Token received");
            message("BOOKING", bookAt + 3_600_000, [first, property, "+91 22 4000 1234"]);
            message("REFERRAL", at(addDays(istDate(bookAt), 3), 12, 0), [first, property], "DELIVERED");
          }
        }
      }
    }
  }

  // A few write back, and one asks to stop.
  if (stage === "nurture" && chance(0.25)) reply(last + 3_600_000, pick(["Not right now, thanks", "Will let you know", "Is there any offer this month?"]));
  if (stage === "lost" && exitReason === "Not interested" && chance(0.3)) {
    reply(last + 2 * 3_600_000, "STOP");
    out.suppressions.push({ org_id: ORG, phone, reason: "WHATSAPP_STOP", call_id: null, created_at: iso(last + 2 * 3_600_000) });
  }

  // Everything the stage requires, and nothing it does not.
  const required = requiredFor(pathStage);
  for (const k of Object.keys(facts) as (keyof Facts)[]) if (!required.includes(k)) delete facts[k];
  for (const k of required) if (!facts[k]) facts[k] = k === "owner" || k === "visitHost" ? owner : "";

  out.leads.push({
    id: leadId, org_id: ORG, scope_node_id: t.id, name, phone, source, enquired_at: iso(enquired), language: lang, created_by: null,
    created_at: iso(enquired), stage, path_stage: pathStage, facts, exit_reason: exitReason, follow_up_on: followUpOn,
    temperature, channel, external_id: `demo-${leadId}`, lineage, needs_person: needsPerson, automation: "PAUSED",
    last_activity_at: iso(Math.min(last, NOW)), updated_at: iso(Math.min(last, NOW)),
  });
}

NAMED.forEach((n, i) => makeLead(i, n));
for (let i = 0; i < 155; i++) makeLead(i + NAMED.length);

// Anything dated in the future (a reminder for tomorrow's visit) never happened.
const past = <T extends Record<string, unknown>>(rows: T[], key: string) => rows.filter((r) => !r[key] || Date.parse(String(r[key])) <= NOW);
out.calls = past(out.calls, "placed_at");
out.activity = past(out.activity, "at");
out.tasks = past(out.tasks, "due_at");

// ---------------------------------------------------------------------------
// Write it
// ---------------------------------------------------------------------------

const jsonCols: Record<string, string[]> = {
  leads: ["facts", "lineage"],
  calls: ["final_variables", "transcript", "payload", "variables", "brain_sources"],
  visits: ["outcome"],
  messages: ["variables"],
  activity: ["detail"],
};
async function insert(db: typeof sql, table: string, key: keyof typeof out, rows: Record<string, unknown>[]) {
  const json = jsonCols[key] ?? [];
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((r) => {
      const c: Record<string, unknown> = { ...r };
      for (const j of json) if (c[j] !== undefined && c[j] !== null) c[j] = sql.json(c[j] as never);
      return c;
    });
    const cols = [...new Set(chunk.flatMap((r) => Object.keys(r)))];
    const full = chunk.map((r) => Object.fromEntries(cols.map((k) => [k, r[k] ?? null])));
    await db`INSERT INTO ${db(table)} ${db(full as never, cols)}`;
  }
}

// A visit that points at a later one goes in after it.
const visitsOrdered = [...out.visits.filter((v) => !v.moved_to), ...out.visits.filter((v) => v.moved_to)];
const uniqueSupp = [...new Map(out.suppressions.map((s) => [s.phone, s])).values()];
await sql.begin(async (tx) => {
  const db = tx as unknown as typeof sql;
  await insert(db, "leads", "leads", out.leads);
  await insert(db, "lead_activity", "activity", out.activity);
  await insert(db, "lead_tasks", "tasks", out.tasks);
  await insert(db, "calls", "calls", out.calls);
  await insert(db, "site_visits", "visits", visitsOrdered);
  await insert(db, "messages", "messages", out.messages);
  await insert(db, "call_suppressions", "suppressions", uniqueSupp);
});

await audit({
  orgId: ORG,
  actorUserId: admin.user_id,
  action: "demo.seeded",
  targetType: "org",
  targetId: ORG,
  metadata: { nodes: created, leads: out.leads.length, calls: out.calls.length, visits: out.visits.length, messages: out.messages.length },
});

const byStage = out.leads.reduce<Record<string, number>>((a, l) => ((a[String(l.stage)] = (a[String(l.stage)] ?? 0) + 1), a), {});
console.log(`Seeded ${out.leads.length} leads, ${out.calls.length} calls, ${out.visits.length} visits, ${out.messages.length} messages, ${uniqueSupp.length} opt-outs.`);
console.log("By stage:", byStage);
console.log(`Towers: ${TOWERS.map((t) => `${t.project} ${t.tower}`).join(", ")}${created.length ? ` (${created.length} created)` : ""}.`);
await sql.end();
await closeDb();
