/**
 * Placing a real call, end to end, with Sarvam injected.
 *
 * Nothing rings: `useSarvam()` swaps the driver for one that records what it
 * was asked. The suite drives the real functions against the real database:
 * the client's policy, a lead and its consent, the gate, the RERA check, the
 * variables the agent is handed, the webhook, and an opt-out that sticks.
 *
 * It builds its own projects, towers and leads and removes only those, and
 * puts the org's calling settings back the way it found them.
 */
import postgres from "postgres";
import { complianceSummary } from "../src/lib/publish-gate.ts";
import { useSarvam } from "../src/lib/sarvam.ts";
import { useVobiz, type LiveCall } from "../src/lib/vobiz.ts";
import { handOffLongCalls, requestHandoff, ringEvent, ringResult, ringXml } from "../src/lib/handoff.ts";
import { addLeadAndCall, addTeamMember, ingestWebhook, listCalls, placeCall, policyAt, reconcileCalls, saveOrgPolicy, webhookIsGenuine } from "../src/lib/calling.ts";
import { callToken } from "../src/lib/calling-rules.ts";
import { resolveBrain } from "../src/lib/brain.ts";
import { bookVisit } from "../src/lib/visits.ts";
import { closeDb } from "../src/lib/db/index.ts";
import { buildAuthz } from "../src/lib/rbac-rules.ts";
import { lensOf, thresholdRows, spacedPhone } from "../src/lib/mask-rules.ts";
import { istDate, termsFor } from "../src/lib/billing-rules.ts";

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

// The hours are tested as production keeps them.
delete process.env.CALLS_ANY_HOUR;
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// Anything this machine has not configured is faked in this process only.
for (const [k, v] of Object.entries({
  SARVAM_AGENTS_KEY: "test-key",
  SARVAM_ORG_ID: "test-org",
  SARVAM_WORKSPACE_ID: "test-ws",
  SARVAM_APP_ID: "test-app",
  SARVAM_APP_VERSION: "3",
  SARVAM_CONNECTION_ID: "test-conn",
  SARVAM_FROM_NUMBER: "+912265480217",
  CALLS_WEBHOOK_BASE: "https://example.test",
  VOBIZ_AUTH_ID: "test-vobiz",
  VOBIZ_AUTH_TOKEN: "test-vobiz-token",
})) process.env[k] ??= v;
process.env.SARVAM_PROJECT_FACTS = "on";

const [admin] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql<{ id: string }[]>`
  SELECT o.id FROM orgs o JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  ORDER BY EXISTS (SELECT 1 FROM registration_records r WHERE r.org_id = o.id AND r.status IN ('VERIFIED', 'EXEMPT')) DESC LIMIT 1`;
if (!org) throw new Error("No org where the first user is ORG_ADMIN");

/**
 * The suite's own towers, never the tenant's: two registered towers in two
 * projects of their own (a call about another tower needs a second) and one
 * unregistered, each project sold a plan the way the operator's tool sells
 * one when the organisation has a billing account. Borrowing whichever tower
 * the gate cleared first meant a project somebody added without a plan
 * refused every call (NO_PLAN), and calls, visits and minutes landed on a
 * real project.
 */
const FIX = {
  project: "calling_check_project",
  tower: "calling_check_tower",
  otherProject: "calling_check_other_project",
  otherTower: "calling_check_other_tower",
  blocked: "calling_check_blocked",
};
const FIX_SLUGS = Object.values(FIX);
const fixtureNodeIds = async () =>
  (await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${FIX_SLUGS})`).map((r) => r.id);
const dropFixtures = async () => {
  const nodes = await fixtureNodeIds();
  if (!nodes.length) return;
  const leadIds = (await sql<{ id: string }[]>`SELECT id FROM leads WHERE org_id = ${org.id} AND scope_node_id = ANY(${nodes})`).map((r) => r.id);
  await sql`DELETE FROM site_visits WHERE org_id = ${org.id} AND (scope_node_id = ANY(${nodes}) OR lead_id = ANY(${leadIds}))`;
  await sql`DELETE FROM calls WHERE org_id = ${org.id} AND (scope_node_id = ANY(${nodes}) OR lead_id = ANY(${leadIds}))`;
  await sql`DELETE FROM inbound_calls WHERE org_id = ${org.id} AND lead_id = ANY(${leadIds})`;
  await sql`DELETE FROM messages WHERE org_id = ${org.id} AND lead_id = ANY(${leadIds})`;
  await sql`DELETE FROM leads WHERE id = ANY(${leadIds})`;
  await sql`DELETE FROM usage_events WHERE org_id = ${org.id} AND (project_id = ANY(${nodes}) OR node_id = ANY(${nodes}))`;
  await sql`DELETE FROM subscriptions WHERE org_id = ${org.id} AND project_id = ANY(${nodes})`;
  await sql`DELETE FROM scope_nodes WHERE org_id = ${org.id} AND id = ANY(${nodes})`;
};
await dropFixtures();

const [region] = await sql<{ id: string; path: string }[]>`
  SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'REGION' ORDER BY path LIMIT 1`;
if (!region) throw new Error("No region in this organisation to build the suite's projects under");
const fixtureNode = async (parentId: string, parentPath: string, kind: "PROJECT" | "PHASE", name: string, slug: string) =>
  (await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, ${parentId}, ${kind}, ${name}, ${slug}, ${`${parentPath}.${slug}`}::ltree)
    RETURNING id, path::text AS path`)[0];
const fxProject = await fixtureNode(region.id, region.path, "PROJECT", "Calling Check", FIX.project);
const fxTower = await fixtureNode(fxProject.id, fxProject.path, "PHASE", "Check Tower", FIX.tower);
const fxOtherProject = await fixtureNode(region.id, region.path, "PROJECT", "Calling Check Two", FIX.otherProject);
const fxOtherTower = await fixtureNode(fxOtherProject.id, fxOtherProject.path, "PHASE", "Other Tower", FIX.otherTower);
const fxBlocked = await fixtureNode(fxOtherProject.id, fxOtherProject.path, "PHASE", "Unregistered Tower", FIX.blocked);
for (const [tower, no] of [[fxTower, "P51800077101"], [fxOtherTower, "P51800077102"]] as const) {
  await sql`
    INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, valid_from, valid_to, verified_at)
    VALUES (${tower.id}, ${org.id}, 'VERIFIED', ${no}, 'MH', current_date - 30, current_date + 400, now())`;
}
// Signed facts the agent is handed: where it is and what it never says on
// the project, the registration on the tower.
const publishBrain = async (nodeId: string, fields: [string, string][]) => {
  const [bv] = await sql<{ id: string }[]>`
    INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by)
    VALUES (${org.id}, ${nodeId}, 1, 'DRAFT', ${admin.id}) RETURNING id`;
  for (const [k, v] of fields) {
    await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value) VALUES (${org.id}, ${bv.id}, ${k}, ${v})`;
  }
  await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now() WHERE id = ${bv.id}`;
};
await publishBrain(fxProject.id, [
  ["claims.location", "Nahur West, Mumbai"],
  ["claims.never_say", "guaranteed returns"],
  ["claims.talking_points", "Eight minutes from the station\nA podium garden"],
]);
await publishBrain(fxTower.id, [["rera.registration_no", "P51800077101"]]);
// An organisation with a billing account places no call on a project without
// a plan, so each fixture project is sold Scale, which carries every agent.
const [billed] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM billing_accounts WHERE org_id = ${org.id}`;
if (billed.n) {
  for (const p of [fxProject, fxOtherProject]) {
    await sql`
      INSERT INTO subscriptions (org_id, project_id, plan, status, cycle, starts_on, terms)
      VALUES (${org.id}, ${p.id}, 'SCALE', 'ACTIVE', 'MONTHLY', ${istDate(new Date().toISOString())}, ${sql.json(termsFor("SCALE") as never)})`;
  }
}

const summary = await complianceSummary(org.id);
const open = summary.phases.find((p) => p.phaseId === fxTower.id && p.ok);
const blocked = summary.phases.find((p) => p.phaseId === fxBlocked.id && !p.ok);

const PHONE_OK = "+919000000101";
const PHONE_OLD = "+919000000102";
const PHONE_OUT = "+919000000103";
const PHONE_GOAL = "+919000000106";
const PHONE_LOST = "+919000000107";
const PHONE_ROLE = "+919000000108";
const PHONE_ABOUT = "+919000000109";
const PHONE_OWN = "+919000000110";
const FIXTURE_PHONES = [PHONE_OK, PHONE_OLD, PHONE_OUT, "+919000000104", "+919000000105", PHONE_GOAL, PHONE_LOST, PHONE_ROLE, PHONE_ABOUT, PHONE_OWN];
const SELLERS = ["+919000000201", "+919000000202"];
const cleanup = async () => {
  // A seat a fixture's visit took is given back, or tomorrow's hour stays a seat short.
  const seated = await sql<{ slot_id: string }[]>`
    SELECT slot_id FROM site_visits WHERE org_id = ${org.id} AND slot_id IS NOT NULL AND status IN ('CONFIRMED', 'REQUESTED')
      AND lead_id IN (SELECT id FROM leads WHERE org_id = ${org.id} AND phone = ANY(${FIXTURE_PHONES}))`;
  for (const s of seated) await sql`UPDATE visit_slots SET taken = greatest(taken - 1, 0) WHERE id = ${s.slot_id}`;
  await sql`DELETE FROM site_visits WHERE org_id = ${org.id} AND lead_id IN (
              SELECT id FROM leads WHERE org_id = ${org.id} AND phone = ANY(${FIXTURE_PHONES}))`;
  await sql`DELETE FROM calls WHERE org_id = ${org.id} AND to_number = ANY(${FIXTURE_PHONES})`;
  await sql`DELETE FROM leads WHERE org_id = ${org.id} AND phone = ANY(${FIXTURE_PHONES})`;
  await sql`DELETE FROM lead_consents WHERE org_id = ${org.id} AND phone = ANY(${FIXTURE_PHONES})`;
  await sql`DELETE FROM call_suppressions WHERE org_id = ${org.id} AND phone = ANY(${FIXTURE_PHONES})`;
  await sql`DELETE FROM sales_team WHERE org_id = ${org.id} AND phone = ANY(${SELLERS})`;
};
await cleanup();

const [savedRow] = await sql`SELECT * FROM calling_settings s JOIN scope_nodes n ON n.id = s.scope_node_id
                             WHERE s.org_id = ${org.id} AND n.kind = 'ORG'`;
const before = await policyAt(org.id, null);

const dialledFrom: { from: string | null; connection: string }[] = [];
const asked: { variables: Record<string, string>; toNumber: string; webhookUrl: string; app?: { id: string; version: number } }[] = [];
// Sarvam's own log of finished calls, for a call whose webhook never came.
const sarvamLog: import("../src/lib/sarvam.ts").SarvamAttempt[] = [];
const connectionAsks: string[] = [];
const fake = useSarvam({
  async placeOutbound(c, req) {
    asked.push(req);
    dialledFrom.push({ from: c.fromNumber, connection: c.connectionId });
    return { attemptId: `att-${asked.length}` };
  },
  async getRecording() {
    return null;
  },
  async listAttempts() {
    return sarvamLog;
  },
  async getTranscript() {
    return [{ role: "assistant", content: "Hello, am I speaking to Lost?" }, { role: "user", content: "Haan, 2 BHK dekh raha hoon, agle saal tak lena hai." }];
  },
  // Our workspace's connections, as the suite's inbound number sees them.
  async getConnection(_c, id) {
    connectionAsks.push(id);
    if (id === "conn_down") throw new Error("Sarvam 503: unavailable");
    if (id === "conn_known") return { exists: true, numbers: ["+912240009931"] };
    if (id === "conn_other") return { exists: true, numbers: ["+912240000000"] };
    return { exists: false, numbers: null };
  },
});

// The next noon in IST after now, so a lead entered now is inside the window
// and the calling hours are open whenever the suite runs.
const NOON = (() => {
  const ist = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  let t = Date.parse(`${ist}T06:30:00Z`);
  if (t < Date.now()) t += 86_400_000;
  return new Date(t).toISOString();
})();
const LATE = new Date(Date.parse(NOON) + 10.5 * 3_600_000).toISOString(); // 10:30 pm IST

/**
 * The client's own Vobiz sub-account and its KYC (0121), with Vobiz
 * injected: no number before the business is verified, verifying makes the
 * sub-account once and seals its token, and a verified client's number is
 * put on its sub-account. Runs whatever numbers the organisation holds.
 */
async function clientKyc() {
  console.log("\nCalling: the client's own sub-account and KYC");
  const [had] = await sql<{ id: string }[]>`SELECT id FROM vobiz_subaccounts WHERE org_id = ${org.id}`;
  if (had) {
    console.log("  SKIP  this organisation already has a Vobiz sub-account");
    return;
  }
  const NUM = "+912240009977";
  let answer: Record<string, unknown> = { kyc_status: "pending", kyc_calls_blocked: true };
  const made: string[] = [];
  const removed: string[] = [];
  const docs: string[] = [];
  const rented: string[] = [];
  const assigned: string[] = [];
  let gstAnswer = "failed";
  let dlState = "";
  const vz = useVobiz({
    async liveCalls() { return []; },
    async transfer() {},
    async makeCall() { return { uuid: "vz-k" }; },
    async searchNumbers(_c, q) { return q.kyc ? [{ number: "+919240950001", city: "Mobile" }] : []; },
    async rentNumber(_c, n) { rented.push(n); },
    async releaseNumber() {},
    async createSubAccount(_c, s) { made.push(s.businessType); return { authId: `SA_CHECKKYC${made.length}`, authToken: "tok-check-kyc" }; },
    async deleteSubAccount(_c, sub) { removed.push(sub); },
    async subAccountKyc() { return answer; },
    async verifyDoc(_c, _sub, d) {
      docs.push(d.kind);
      return d.kind === "gst" ? { status: gstAnswer } : { status: "verified", registered_name: "CHECK PRIVATE LIMITED" };
    },
    async digilockerStart(_c, _sub, back, state) {
      dlState = state;
      return { url: `https://api.digitallocker.gov.in/public/oauth2/1/authorize?back=${encodeURIComponent(back)}`, requestId: "AR_CHECK" };
    },
    async digilockerFinish(_c, _sub, req) { return { status: req === "AR_CHECK" ? "verified" : "failed" }; },
    async assignToSub(_c, n, sub) { assigned.push(`${n}>${sub}`); },
  });
  const { useMailer } = await import("../src/lib/mailer.ts");
  useMailer(async () => ({ ok: true, messageId: "m-k" }));
  const { verifyBusiness, finishDigilocker, kycView } = await import("../src/lib/calling-kyc.ts");
  const { rentCallingNumber, searchNumbers } = await import("../src/lib/calling-numbers.ts");
  const base = { orgId: org.id, userId: admin.id, email: "KYC@Example.com", digilockerReturn: "https://app.example.com/dl" };
  try {
    const before = await rentCallingNumber({ orgId: org.id, userId: admin.id, number: NUM, city: "Mumbai", nodeId: null });
    check("no number before the business is verified, and Vobiz is not asked", !before.ok && before.code === "KYC" && rented.length === 0, before.ok ? "rented" : before.code);
    check("and no 92-series number is searched for an unverified client", !(await searchNumbers("92")).ok);

    const wrongPan = await verifyBusiness({ ...base, businessType: "private_limited", pan: "ABCPD1234E", gstin: "27ABCPD1234E1Z5" });
    check("a person's PAN for a company is refused before Vobiz is asked", !wrongPan.ok && made.length === 0 && docs.length === 0);
    const noGst = await verifyBusiness({ ...base, businessType: "private_limited", pan: "AAACB1234C" });
    check("a company needs its GSTIN or CIN", !noGst.ok && made.length === 0);
    const otherGst = await verifyBusiness({ ...base, businessType: "private_limited", pan: "AAACB1234C", gstin: "27AAACZ9999C1Z5" });
    check("a GSTIN on another PAN is refused", !otherGst.ok && made.length === 0);

    const gstFails = await verifyBusiness({ ...base, businessType: "private_limited", pan: "aaacb1234c", gstin: "27AAACB1234C1Z5" });
    check("the documents are checked on our screen, and a GSTIN Vobiz refuses is named",
      !gstFails.ok && /GSTIN/.test(gstFails.message) && docs.join() === "pan,gst" && made.length === 1, JSON.stringify(gstFails));
    const [sub] = await sql<{ secret: Buffer; email: string }[]>`SELECT secret, email FROM vobiz_subaccounts WHERE org_id = ${org.id}`;
    check("the client's sub-account is made once, its token sealed",
      !!sub && !sub.secret.toString("latin1").includes("tok-check-kyc") && sub.email === "kyc@example.com");
    const [kept] = await sql<{ t: string }[]>`SELECT row_to_json(v)::text AS t FROM vobiz_subaccounts v WHERE org_id = ${org.id}`;
    check("and no PAN or GSTIN is stored", !kept.t.includes("AAACB1234C"));

    gstAnswer = "verified";
    answer = { kyc_status: "verified", kyc_calls_blocked: false, pan_status: "verified", gst_status: "verified" };
    const passed = await verifyBusiness({ ...base, businessType: "private_limited", pan: "AAACB1234C", gstin: "27AAACB1234C1Z5" });
    check("a company whose PAN and GSTIN Vobiz verifies is verified, on the same sub-account",
      passed.ok && "verified" in passed && passed.verified && made.length === 1, JSON.stringify(passed));
    const v = await kycView(org.id, { refresh: true });
    check("the page then offers numbers", v?.status === "verified" && v.problem === null);
    const mobile = await searchNumbers("92", null, { kyc: true });
    check("and the 92 series is searched for it", mobile.ok && mobile.numbers[0]?.number === "+919240950001");
    const got = await rentCallingNumber({ orgId: org.id, userId: admin.id, number: NUM, city: "Mumbai", nodeId: null });
    check("a verified client's number is rented and put on its own sub-account",
      got.ok && rented.at(-1) === NUM && assigned.at(-1) === `${NUM}>SA_CHECKKYC1`, got.ok ? "" : got.message);
    const [row] = await sql<{ sub_auth_id: string | null }[]>`SELECT sub_auth_id FROM calling_numbers WHERE org_id = ${org.id} AND number = ${NUM} AND released_at IS NULL`;
    check("which the number's row names", row?.sub_auth_id === "SA_CHECKKYC1");

    // A proprietor: PAN here, Aadhaar on DigiLocker.
    await sql`DELETE FROM calling_numbers WHERE org_id = ${org.id} AND number = ${NUM}`;
    await sql`UPDATE vobiz_subaccounts SET kyc_status = 'pending', calls_blocked = true WHERE org_id = ${org.id}`;
    answer = { kyc_status: "pending", kyc_calls_blocked: true };
    const dl = await verifyBusiness({ ...base, businessType: "proprietorship", pan: "ABCPD1234E" });
    check("a proprietor's PAN is checked here, then DigiLocker opens for Aadhaar, coming back to us",
      dl.ok && "redirect" in dl && dl.redirect.startsWith("https://api.digitallocker.gov.in/") && decodeURIComponent(dl.redirect).includes("app.example.com/dl?state="),
      JSON.stringify(dl));
    check("changing how the business is registered makes a new sub-account and removes the old", made.length === 2 && removed.includes("SA_CHECKKYC1"));
    const forged = await finishDigilocker({ orgId: org.id, userId: admin.id, state: "0".repeat(48) });
    check("a DigiLocker return we did not start is refused", !forged.ok);
    answer = { kyc_status: "verified", kyc_calls_blocked: false, pan_status: "verified", aadhaar_status: "verified" };
    const back = await finishDigilocker({ orgId: org.id, userId: admin.id, state: dlState });
    check("the real return finishes Aadhaar and verifies the business", back.ok && (await kycView(org.id))?.status === "verified", back.message);

    await sql`UPDATE vobiz_subaccounts SET kyc_status = 'pending', calls_blocked = true,
              checks_day = (now() AT TIME ZONE 'Asia/Kolkata')::date, checks_today = 8 WHERE org_id = ${org.id}`;
    const n = docs.length;
    const capped = await verifyBusiness({ ...base, businessType: "proprietorship", pan: "ABCPD1234E" });
    check("a day's paid checks are capped, refused before Vobiz is asked", !capped.ok && docs.length === n);
  } finally {
    vz.restore();
    useMailer(null);
    await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND target_id IN (SELECT id::text FROM calling_numbers WHERE org_id = ${org.id} AND number = ${NUM})`;
    await sql`DELETE FROM calling_numbers WHERE org_id = ${org.id} AND number = ${NUM}`;
    await sql`DELETE FROM vobiz_subaccounts WHERE org_id = ${org.id} AND sub_auth_id LIKE 'SA_CHECKKYC%'`;
    await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND action IN ('calling.kyc_started', 'calling.kyc_verified') AND created_at > now() - interval '1 hour'`;
  }
}

/**
 * Each developer's own calling number (0072), with Vobiz injected: renting
 * is refused before Vobiz is asked, a rented number placed at the project
 * is the caller id Sarvam is handed, a number placed elsewhere never falls
 * back to the shared one, a LIVE tenant with none is refused, and
 * releasing gives it back.
 */
async function ownNumbers(phaseId: string) {
  console.log("\nCalling: each developer's own number");
  const [held] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM calling_numbers WHERE org_id = ${org.id} AND released_at IS NULL`;
  if (held.n > 0) {
    console.log("  SKIP  this organisation already holds calling numbers; the suite does not touch them");
    return;
  }
  const [project] = await sql<{ id: string; parent_id: string; path: string }[]>`
    SELECT p.id, p.parent_id, p.path::text AS path FROM scope_nodes t
    JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
    WHERE t.id = ${phaseId}`;
  const [sibling] = await sql<{ id: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    SELECT org_id, parent_id, 'PROJECT', 'Numbers Check Sibling', 'numbers_check_sibling', subpath(path, 0, nlevel(path) - 1) || 'numbers_check_sibling'
    FROM scope_nodes WHERE id = ${project.id}
    RETURNING id`;
  // Calls this suite left dialling hold the project's lines.
  const settleFixtureCalls = () => sql`
    UPDATE calls SET status = 'DONE', ended_at = now()
    WHERE org_id = ${org.id} AND to_number = ANY(${FIXTURE_PHONES}) AND status IN ('PLACING', 'DIALLING')`;
  const OWN = "+912240009901";
  const OTHER = "+912040009902";
  const rented: string[] = [];
  const linkedNums: string[] = [];
  const released: string[] = [];
  const assigned: string[] = [];
  let kycAnswer: Record<string, unknown> = { kyc_status: "pending", kyc_calls_blocked: true };
  const subMade: string[] = [];
  const vz = useVobiz({
    async liveCalls() { return []; },
    async transfer() {},
    async makeCall() { return { uuid: "vz-x" }; },
    async searchNumbers(_c, q) {
      return q.pattern === "9122" ? [{ number: OWN, city: "Mumbai" }] : [{ number: OTHER, city: "Pune" }];
    },
    async rentNumber(_c, n) { rented.push(n); },
    async releaseNumber(_c, n) { released.push(n); },
    async linkNumber(_c, n) { linkedNums.push(n); return { appId: "app-1" }; },
    async createSubAccount(_c, s) { subMade.push(s.businessType); return { authId: "SA_CHECKCALL1", authToken: "tok-check-calling" }; },
    async subAccountKyc() { return kycAnswer; },
    async verifyDoc() { return { status: "verified", registered_name: "CHECK PRIVATE LIMITED" }; },
    async assignToSub(_c, n, sub) { assigned.push(`${n}>${sub}`); },
  });
  // The client's own verified sub-account every number now sits on. The
  // suite borrows a real organisation, so it makes one only where none is.
  const [hadSub] = await sql<{ id: string }[]>`SELECT id FROM vobiz_subaccounts WHERE org_id = ${org.id}`;
  const sentMail: string[] = [];
  const { useMailer } = await import("../src/lib/mailer.ts");
  useMailer(async (m) => { sentMail.push(m.subject); return { ok: true, messageId: "m-1" }; });
  const { searchNumbers, rentCallingNumber, placeCallingNumber, releaseCallingNumber, callingNumberOwner } = await import("../src/lib/calling-numbers.ts");
  const ids: string[] = [];
  try {
    const found = await searchNumbers("Mumbai");
    check("a city is searched by its area code", found.ok && found.numbers[0]?.number === OWN);
    check("searching rents nothing", rented.length === 0);

    const bad = await rentCallingNumber({ orgId: org.id, userId: admin.id, number: "+15551234567", city: null, nodeId: null });
    check("a number that is not Indian is refused before Vobiz is asked", !bad.ok && rented.length === 0);
    const nowhere = await rentCallingNumber({ orgId: org.id, userId: admin.id, number: OWN, city: "Mumbai", nodeId: phaseId });
    check("a tower is not a place a number is used, and nothing is rented", !nowhere.ok && nowhere.code === "UNKNOWN_PLACE" && rented.length === 0);

    if (!hadSub) {
      const noKyc = await rentCallingNumber({ orgId: org.id, userId: admin.id, number: OWN, city: "Mumbai", nodeId: project.id });
      check("no number before the business is verified, and Vobiz is not asked", !noKyc.ok && noKyc.code === "KYC" && rented.length === 0);
      const mobile = await searchNumbers("92");
      check("and no 92-series number is searched for an unverified client", !mobile.ok);
      kycAnswer = { kyc_status: "verified", kyc_calls_blocked: false, pan_status: "verified", gst_status: "verified" };
      const { verifyBusiness } = await import("../src/lib/calling-kyc.ts");
      const v = await verifyBusiness({ orgId: org.id, userId: admin.id, businessType: "private_limited", email: "kyc@example.com",
        pan: "AAACB1234C", gstin: "27AAACB1234C1Z5", digilockerReturn: "https://app.example.com/dl" });
      check("the client's business is verified before its number", v.ok && "verified" in v && v.verified, JSON.stringify(v));
    } else {
      console.log("  SKIP  this organisation already has a Vobiz sub-account");
    }

    const got = await rentCallingNumber({ orgId: org.id, userId: admin.id, number: OWN, city: "Mumbai", nodeId: project.id });
    check("a number is rented and placed at the project", got.ok && rented.at(-1) === OWN, got.ok ? "" : got.message);
    if (got.ok && got.numberId) ids.push(got.numberId);
    if (!hadSub) {
      check("and put on the client's own sub-account", assigned.at(-1) === `${OWN}>SA_CHECKCALL1`);
      const [onSub] = await sql<{ sub_auth_id: string | null }[]>`SELECT sub_auth_id FROM calling_numbers WHERE org_id = ${org.id} AND number = ${OWN} AND released_at IS NULL`;
      check("which the number's row names", onSub?.sub_auth_id === "SA_CHECKCALL1");
    }
    const [row] = await sql<{ active: boolean; monthly_cost_paise: number; monthly_price_paise: number }[]>`
      SELECT active, monthly_cost_paise, monthly_price_paise FROM calling_numbers WHERE org_id = ${org.id} AND number = ${OWN} AND released_at IS NULL`;
    check("its month is priced as the price list says", row?.active && row.monthly_cost_paise === 600_00 && row.monthly_price_paise === 999_00);
    const [log] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE org_id = ${org.id} AND action = 'calling.number_rented' ORDER BY created_at DESC LIMIT 1`;
    check("the rental is audited with its unit and no number in the clear",
      log?.metadata?.unit === "phone_number" && !JSON.stringify(log.metadata).includes(OWN.slice(3)));
    check("the rented number is linked to the voice app that hands calls to Sarvam, in the same press", linkedNums.at(-1) === OWN);
    check("and we are emailed to finish connecting it in Sarvam", sentMail.some((s) => s.includes(OWN)));
    const owner = await callingNumberOwner(OWN);
    check("an inbound call to it names this tenant", owner?.orgId === org.id);

    const twice = await rentCallingNumber({ orgId: org.id, userId: admin.id, number: OTHER, city: "Pune", nodeId: project.id });
    check("a second number at the same place is refused before Vobiz is asked", !twice.ok && twice.code === "TWO_AT_ONE_PLACE" && rented.length === 1);

    // The connection Sarvam dials through is the tenant's own when it has one.
    await sql`UPDATE calling_numbers SET sarvam_connection_id = 'conn-own' WHERE org_id = ${org.id} AND number = ${OWN}`;
    // The calls placed above are still dialling and would hold every line.
    await settleFixtureCalls();
    const res = await addLeadAndCall({
      orgId: org.id, userId: admin.id, name: "Own Number", phone: PHONE_OWN, phaseId,
      source: "Check", language: "en", consentWording: null, nowIso: NOON,
    });
    check("the call is placed", res.ok, res.ok ? "" : res.message);
    check("Sarvam is handed the tenant's own number and connection, not the shared one",
      dialledFrom.at(-1)?.from === OWN && dialledFrom.at(-1)?.connection === "conn-own");
    if (res.ok) {
      const [c] = await sql<{ from_number: string }[]>`SELECT from_number FROM calls WHERE id = ${res.callId}`;
      check("and the call row names it, so a hand-off finds the call by it", c?.from_number === OWN);
      const liveNow = [{ uuid: "vz-own", from: OWN, to: PHONE_OWN, status: "in-progress" }];
      const moves: string[] = [];
      const hv = useVobiz({
        async liveCalls() { return liveNow; },
        async transfer(_c, uuid) { moves.push(uuid); },
        async makeCall() { return { uuid: "vz-y" }; },
      });
      await sql`INSERT INTO sales_team (org_id, scope_node_id, name, phone, on_duty)
                SELECT ${org.id}, id, 'Seller One', ${SELLERS[0]}, true FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG'
                ON CONFLICT DO NOTHING`;
      const h = await requestHandoff(org.id, res.callId);
      check("a hand-off finds the buyer's live call from the tenant's own number", h.ok && moves[0] === "vz-own", h.ok ? "" : h.message);
      const xml = await ringXml(org.id, res.callId);
      check("and rings the sales team showing that number", xml.includes(`callerId="${OWN}"`) || xml.includes(OWN.replace("+", "")), xml.slice(0, 200));
      hv.restore();
      useVobiz({
        async liveCalls() { return []; },
        async transfer() {},
        async makeCall() { return { uuid: "vz-x" }; },
        async searchNumbers() { return []; },
        async rentNumber(_c, n) { rented.push(n); },
        async releaseNumber(_c, n) { released.push(n); },
      });
    }

    // Moved to another project, it no longer calls for this one, and the
    // shared number does not step in.
    const moved = await placeCallingNumber({ orgId: org.id, userId: admin.id, numberId: ids[0] ?? "", nodeId: sibling.id });
    check("a number moves to another place", moved.ok);
    const before = asked.length;
    const [lead] = await sql<{ id: string }[]>`SELECT id FROM leads WHERE org_id = ${org.id} AND phone = ${PHONE_OWN}`;
    const off = await placeCall({ orgId: org.id, userId: admin.id, leadId: lead.id, nowIso: NOON });
    check("a tenant whose numbers are placed elsewhere is refused, never handed the shared number",
      !off.ok && off.code === "NO_NUMBER" && asked.length === before, off.ok ? "placed" : off.code);

    // Released, the tenant is back on the shared number while not LIVE.
    const gone = await releaseCallingNumber({ orgId: org.id, userId: admin.id, numberId: ids[0] ?? "" });
    check("releasing gives the number back to Vobiz", gone.ok && released.at(-1) === OWN);
    check("and it names no tenant any more", (await callingNumberOwner(OWN)) === null);
    await settleFixtureCalls();
    const back = await placeCall({ orgId: org.id, userId: admin.id, leadId: lead.id, nowIso: NOON });
    check("a tenant with none of its own, not LIVE, calls from the shared number again",
      back.ok && dialledFrom.at(-1)?.from === process.env.SARVAM_FROM_NUMBER, back.ok ? "" : back.message);

    // A LIVE tenant with none of its own is refused before Sarvam.
    const [acct] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM billing_accounts WHERE org_id = ${org.id}`;
    if (acct.n === 0) {
      await sql`INSERT INTO billing_accounts (org_id, mode) VALUES (${org.id}, 'LIVE')`;
      try {
        const n = asked.length;
        await settleFixtureCalls();
        const live = await placeCall({ orgId: org.id, userId: admin.id, leadId: lead.id, nowIso: NOON });
        check("a LIVE tenant with no number of its own is refused, never given the shared one",
          !live.ok && live.code === "NO_NUMBER" && asked.length === n, live.ok ? "placed" : live.code);
      } finally {
        await sql`DELETE FROM billing_accounts WHERE org_id = ${org.id}`;
      }
    } else {
      console.log("  SKIP  this organisation already has a billing account");
    }
  } finally {
    vz.restore();
    useMailer(null);
    await sql`DELETE FROM sales_team WHERE org_id = ${org.id} AND phone = ${SELLERS[0]}`;
    await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND target_id = ANY(${ids})`;
    await sql`DELETE FROM calling_numbers WHERE org_id = ${org.id} AND number = ANY(${[OWN, OTHER]})`;
    await sql`DELETE FROM scope_nodes WHERE id = ${sibling.id}`;
    if (!hadSub) {
      await sql`DELETE FROM vobiz_subaccounts WHERE org_id = ${org.id} AND sub_auth_id = 'SA_CHECKCALL1'`;
      await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND action IN ('calling.kyc_started', 'calling.kyc_verified') AND created_at > now() - interval '1 hour'`;
    }
  }
}

/**
 * A buyer ringing the developer's own number (0076), with Vobiz's answer
 * and callbacks driven by hand: the address proves its number, a known
 * buyer rings their owner and then the team, an unknown one is captured as
 * a PHONE lead through the ownership rules, nobody taking it is a missed
 * call on the lead, the talk is metered once as a hand-off minute, and a
 * junk number rings nobody.
 */
async function inboundCalls(phaseId: string) {
  const NIL_ID = "00000000-0000-0000-0000-000000000000";
  const TEAM_IN = ["+919000000221", "+919000000222"];
  console.log("\nCalling: a buyer calling the developer's own number");
  const [held] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM calling_numbers WHERE org_id = ${org.id} AND released_at IS NULL`;
  if (held.n > 0) {
    console.log("  SKIP  this organisation already holds calling numbers; the suite does not touch them");
    return;
  }
  const IN = await import("../src/lib/inbound-calls.ts");
  const IR = await import("../src/lib/inbound-call-rules.ts");
  const { webhookSecret } = await import("../src/lib/calling.ts");
  const { HANGUP_XML } = await import("../src/lib/handoff-rules.ts");
  const { callingNumberOwner } = await import("../src/lib/calling-numbers.ts");
  const [project] = await sql<{ id: string }[]>`
    SELECT p.id FROM scope_nodes t JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
    WHERE t.id = ${phaseId}`;
  const NUM = "+912240009931";
  const OWNER_PHONE = "+919000000210";
  const KNOWN = "+919000000111";
  const FRESH = "+919000000112";
  const JUNK = "+919999999999";
  const [cn] = await sql<{ id: string }[]>`
    INSERT INTO calling_numbers (org_id, number, scope_node_id, active, monthly_cost_paise, monthly_price_paise)
    VALUES (${org.id}, ${NUM}, ${project.id}, true, 60000, 99900) RETURNING id`;
  const [ownerUser] = await sql<{ id: string }[]>`
    INSERT INTO users (phone, phone_verified_at, name) VALUES (${OWNER_PHONE}, now(), 'Inbound Owner') RETURNING id`;
  const [root] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG' LIMIT 1`;
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${ownerUser.id}, ${org.id}, ${root.id}, 'SALES_EXECUTIVE', 'ACTIVE')`;
  for (const [i, p] of TEAM_IN.entries()) {
    await sql`INSERT INTO sales_team (org_id, scope_node_id, name, phone, on_duty) VALUES (${org.id}, ${root.id}, ${`Seller ${i + 1}`}, ${p}, true)
              ON CONFLICT DO NOTHING`;
  }
  const [known] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, language, owner_id)
    VALUES (${org.id}, ${phaseId}, 'Known Buyer', ${KNOWN}, 'Check', 'en', ${ownerUser.id}) RETURNING id`;
  const token = IR.inboundNumberToken(webhookSecret(), NUM);
  const params = (uuid: string, from: string) => ({ CallUUID: uuid, From: from.replace("+", ""), To: NUM.replace("+", "") });
  const rowOf = async (uuid: string) => (await sql<{ id: string; status: string; stage: string | null; rang: string[]; lead_id: string | null; answered_by: string | null; bill_s: number | null }[]>`
    SELECT id, status, stage, rang, lead_id, answered_by, bill_s FROM inbound_calls WHERE org_id = ${org.id} AND vobiz_call_uuid = ${uuid}`)[0];
  try {
    check("the number's inbound lookup names this tenant", (await callingNumberOwner(NUM))?.orgId === org.id);
    const forged = await IN.answerInbound({ number: NUM, token: "0".repeat(64), params: params("chk-in-0", KNOWN), nowIso: NOON });
    const otherTo = await IN.answerInbound({ number: NUM, token, params: { ...params("chk-in-0", KNOWN), To: "912240009999" }, nowIso: NOON });
    check("an address that does not prove its number, or a call to another number, is hung up on and writes nothing",
      forged === HANGUP_XML && otherTo === HANGUP_XML && !(await rowOf("chk-in-0")));
    check("the screen's address carries the number's proof", IN.inboundAddressFor(NUM)?.endsWith(`t=${token}`) === true);

    // A known buyer: their owner first, then the team.
    const x1 = await IN.answerInbound({ number: NUM, token, params: params("chk-in-1", KNOWN), nowIso: NOON });
    const r1 = await rowOf("chk-in-1");
    check("a known buyer rings their owner first, alone, from the developer's number",
      r1?.status === "RINGING" && r1.stage === "OWNER" && r1.lead_id === known.id && x1.includes(`<Number>${OWNER_PHONE}</Number>`)
        && !TEAM_IN.some((s) => x1.includes(s)) && x1.includes(`callerId="${NUM}"`), x1.slice(0, 300));
    const [act] = await sql<{ kind: string; reason: string }[]>`
      SELECT kind, reason FROM lead_activity WHERE org_id = ${org.id} AND lead_id = ${known.id} AND kind = 'CALL_IN'`;
    check("the call is on the lead's history", act?.reason === "Called our number");
    const again = await IN.answerInbound({ number: NUM, token, params: params("chk-in-1", KNOWN), nowIso: NOON });
    check("Vobiz asking again gets the same ring and no second row",
      again.includes(OWNER_PHONE) && (await sql`SELECT 1 FROM inbound_calls WHERE vobiz_call_uuid = 'chk-in-1'`).length === 1);
    const x2 = await IN.inboundResult(org.id, r1!.id, { DialStatus: "no-answer" });
    const r1b = await rowOf("chk-in-1");
    check("the owner not answering rings the free team, never the owner again",
      r1b?.stage === "TEAM" && TEAM_IN.every((s) => x2.includes(s)) && !x2.includes(OWNER_PHONE), x2.match(/<Number>[^<]*/g)?.join(" "));
    await IN.inboundEvent(org.id, r1!.id, { Event: "DialAnswer", DialBLegTo: TEAM_IN[0] });
    await IN.inboundEvent(org.id, r1!.id, { Event: "DialHangup", DialBLegTo: TEAM_IN[1], DialBLegHangupCause: "LOSE_RACE" });
    await IN.inboundEvent(org.id, r1!.id, { Event: "DialHangup", DialBLegTo: TEAM_IN[0], DialBLegBillDuration: "125" });
    await IN.inboundEvent(org.id, r1!.id, { Event: "DialHangup", DialBLegTo: TEAM_IN[0], DialBLegBillDuration: "125" });
    const r1c = await rowOf("chk-in-1");
    const metered = await sql<{ qty: string; cost_paise: string }[]>`
      SELECT qty::text, cost_paise::text FROM usage_events WHERE org_id = ${org.id} AND source_kind = 'call' AND source_id = ${`inbound:${r1!.id}`}`;
    check("who took the buyer is recorded, and the talk is metered once as a hand-off minute",
      r1c?.status === "ENDED" && r1c.answered_by === TEAM_IN[0] && r1c.bill_s === 125 && metered.length === 1
        && Number(metered[0].qty) === 0.75 && Number(metered[0].cost_paise) === 270, JSON.stringify({ r1c, metered }));
    check("an inbound call that ended is not rung again", (await IN.answerInbound({ number: NUM, token, params: params("chk-in-1", KNOWN), nowIso: NOON })) === HANGUP_XML);

    // A number nobody knows: captured as a PHONE lead, the team rung.
    const x3 = await IN.answerInbound({ number: NUM, token, params: params("chk-in-2", FRESH), nowIso: NOON });
    const r3 = await rowOf("chk-in-2");
    const [fresh] = await sql<{ id: string; channel: string; scope_node_id: string; name: string }[]>`
      SELECT id, channel, scope_node_id, name FROM leads WHERE org_id = ${org.id} AND phone = ${FRESH}`;
    const [ev] = await sql<{ source: string; rule: string | null }[]>`
      SELECT source, rule FROM lead_events WHERE org_id = ${org.id} AND external_id = 'call:chk-in-2'`;
    check("an unknown caller is captured as a PHONE lead at the number's tower, through the ownership rules",
      fresh?.channel === "PHONE" && fresh.scope_node_id === phaseId && r3?.lead_id === fresh.id && ev?.source === "PHONE" && ev.rule === "R4",
      JSON.stringify({ fresh, ev }));
    check("and the free team is rung for them", r3?.stage === "TEAM" && TEAM_IN.every((s) => x3.includes(s)), x3.match(/<Number>[^<]*/g)?.join(" "));
    const x4 = await IN.inboundResult(org.id, r3!.id, { DialStatus: "no-answer" });
    const [flag] = await sql<{ needs_person: string | null }[]>`SELECT needs_person FROM leads WHERE id = ${fresh?.id ?? NIL_ID}`;
    check("nobody taking it in hours: the call-back line, a missed call, and the lead flagged for a person",
      (await rowOf("chk-in-2"))?.status === "MISSED" && x4.includes("<Hangup/>") && (x4.includes("<Speak") || x4.includes("<Play>"))
        && flag?.needs_person === IR.MISSED_FLAG, x4.slice(0, 200));

    // Out of hours with nobody free: nothing new is played.
    await sql`UPDATE sales_team SET on_duty = false WHERE org_id = ${org.id} AND phone = ANY(${TEAM_IN})`;
    await sql`UPDATE leads SET needs_person = NULL WHERE id = ${fresh?.id ?? NIL_ID}`;
    const x5 = await IN.answerInbound({ number: NUM, token, params: params("chk-in-3", FRESH), nowIso: LATE });
    const [flag2] = await sql<{ needs_person: string | null }[]>`SELECT needs_person FROM leads WHERE id = ${fresh?.id ?? NIL_ID}`;
    check("out of hours with nobody free, nothing is played: a missed call and a person asked",
      x5 === HANGUP_XML && (await rowOf("chk-in-3"))?.status === "MISSED" && flag2?.needs_person === IR.MISSED_FLAG);
    check("and the same buyer calling again is the same lead", (await sql`SELECT 1 FROM leads WHERE org_id = ${org.id} AND phone = ${FRESH}`).length === 1);

    // A number the ownership rules call junk rings nobody and makes no lead.
    await sql`UPDATE sales_team SET on_duty = true WHERE org_id = ${org.id} AND phone = ANY(${TEAM_IN})`;
    const x6 = await IN.answerInbound({ number: NUM, token, params: params("chk-in-4", JUNK), nowIso: NOON });
    check("a junk number rings nobody and makes no lead",
      x6 === HANGUP_XML && (await rowOf("chk-in-4"))?.status === "REFUSED"
        && (await sql`SELECT 1 FROM leads WHERE org_id = ${org.id} AND phone = ${JUNK}`).length === 0);

    const [log] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE org_id = ${org.id} AND action = 'lead.call_in' ORDER BY created_at DESC LIMIT 1`;
    check("each call in is audited with no number in the clear", !!log && ![KNOWN, FRESH, JUNK].some((p) => JSON.stringify(log.metadata).includes(p.slice(3))));
    check("a forged callback changes nothing", !IN.inboundIsGenuine(org.id, r1!.id, "0".repeat(64)) && IN.inboundIsGenuine(org.id, r1!.id, IR.inboundCallToken(webhookSecret(), org.id, r1!.id)));

    // The AI receptionist: Sarvam asks at the start who is ringing.
    const ST = IR.inboundStartToken(webhookSecret());
    const startBody = (from: string, to: string, sid: string) => ({ user_information: { country_code: "91", phone_number: from.slice(3), identifier: from.slice(3), call_sid: sid }, to });
    const forgedStart = await IN.startReceptionist({ token: "0".repeat(64), body: startBody(KNOWN, NUM, "rx-0"), query: {}, nowIso: NOON });
    check("a start request that does not prove itself is told nothing", forgedStart === null);
    const nobodys = await IN.startReceptionist({ token: ST, body: startBody(KNOWN, "+912240009998", "rx-0"), query: {}, nowIso: NOON });
    check("a number no tenant holds is answered generally, with no row and nothing of any tenant's",
      nobodys?.callId === null && nobodys.variables.answer_mode === "general" && !nobodys.variables.salesdesk_org);
    const rx = await IN.startReceptionist({ token: ST, body: startBody(KNOWN, NUM, "rx-1"), query: {}, nowIso: NOON });
    const [rxRow] = rx?.callId ? await sql<{ agent: string; direction: string; status: string; from_number: string; to_number: string; lead_id: string; variables: Record<string, string> }[]>`
      SELECT agent, direction, status, from_number, to_number, lead_id, variables FROM calls WHERE id = ${rx.callId}` : [];
    check("a known buyer's call becomes an inbound row on their lead, the receptionist's, live",
      rxRow?.agent === "receptionist" && rxRow.direction === "IN" && rxRow.status === "DIALLING" && rxRow.from_number === NUM && rxRow.to_number === KNOWN && rxRow.lead_id === known.id,
      JSON.stringify(rxRow));
    check("the agent is told who is ringing and how to take the call, and carries its own key for its tools",
      rx?.variables.user_name === "Known" && rx.variables.caller_known === "yes" && ["talk", "connect"].includes(rx.variables.answer_mode)
        && rx.variables.salesdesk_call === rx.callId && rx.variables.salesdesk_key === callToken(webhookSecret(), org.id, rx.callId!), JSON.stringify(rx?.variables));
    check("the key is never stored on the row", rxRow ? !("salesdesk_key" in rxRow.variables) : false);
    const [rxAct] = await sql<{ reason: string }[]>`
      SELECT reason FROM lead_activity WHERE org_id = ${org.id} AND lead_id = ${known.id} AND kind = 'CALL_IN' ORDER BY at DESC LIMIT 1`;
    check("the call is on the lead's history as answered by the AI", rxAct?.reason === "Called our number. The AI answered");
    const endBody = { status: "connected", duration: 95, interaction_id: "rx-int-1", final_agent_variables: { ...rx!.variables, lead_disposition: "warm" }, interaction_transcript: [] };
    const linked = IR.startedCall(endBody);
    check("the call-end webhook finds the row through the agent's own variables, and proves it",
      linked?.callId === rx!.callId && webhookIsGenuine(linked!.orgId, linked!.callId, linked!.token));
    check("and lands like an outbound result", await ingestWebhook(org.id, rx!.callId!, endBody));
    const [rxDone] = await sql<{ status: string; duration_s: string }[]>`SELECT status, duration_s::text FROM calls WHERE id = ${rx!.callId}`;
    check("the inbound call is done, with its length for the minutes", rxDone?.status === "DONE" && Number(rxDone.duration_s) === 95);
    const fresh2 = "+919000000113";
    const rx2 = await IN.startReceptionist({ token: ST, body: startBody(fresh2, NUM, "rx-2"), query: {}, nowIso: NOON });
    const [lead2] = await sql<{ id: string; channel: string }[]>`SELECT id, channel FROM leads WHERE org_id = ${org.id} AND phone = ${fresh2}`;
    // A number at a project of several towers cannot file an unknown caller on one; the call is still answered.
    check("a caller nobody knows is captured as a PHONE lead, or answered from the project when no tower can be told, and the agent knows it does not know them",
      rx2?.variables.caller_known === "no" && rx2.variables.user_name === "" && (lead2 ? lead2.channel === "PHONE" && !!rx2.callId : rx2.callId === null && !!rx2.variables.call_project),
      JSON.stringify({ lead2, vars: rx2?.variables }));

    // The number's own Sarvam connection, asked of Sarvam before it is saved.
    const { linkSarvamConnection, numbersPage } = await import("../src/lib/calling-numbers.ts");
    const connOf = async () => (await sql<{ c: string | null }[]>`SELECT sarvam_connection_id AS c FROM calling_numbers WHERE id = ${cn.id}`)[0].c;
    const bad = await linkSarvamConnection({ orgId: org.id, userId: admin.id, numberId: cn.id, raw: "conn 1" });
    check("a connection id of the wrong shape is refused before Sarvam is asked", !bad.ok && connectionAsks.length === 0);
    const unknown = await linkSarvamConnection({ orgId: org.id, userId: admin.id, numberId: cn.id, raw: "conn_nobody" });
    const other = await linkSarvamConnection({ orgId: org.id, userId: admin.id, numberId: cn.id, raw: "conn_other" });
    const down = await linkSarvamConnection({ orgId: org.id, userId: admin.id, numberId: cn.id, raw: "conn_down" });
    check("one Sarvam does not know, one that does not carry the number, and no answer are all refused and nothing saved",
      !unknown.ok && !other.ok && !down.ok && (await connOf()) === null && connectionAsks.length === 3);
    const good = await linkSarvamConnection({ orgId: org.id, userId: admin.id, numberId: cn.id, raw: " conn_known " });
    check("a connection Sarvam knows and that carries the number is saved", good.ok && (await connOf()) === "conn_known");
    const page = await numbersPage(org.id);
    const shown = page.numbers.find((n) => n.id === cn.id);
    check("the screen shows the connection and the number's inbound address", shown?.connectionId === "conn_known" && shown.inbound === IN.inboundAddressFor(NUM));
    const cleared = await linkSarvamConnection({ orgId: org.id, userId: admin.id, numberId: cn.id, raw: "" });
    check("clearing it needs no Sarvam answer", cleared.ok && (await connOf()) === null && connectionAsks.length === 4);
    await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND action = 'calling.number_connection' AND target_id = ${cn.id}`;
  } finally {
    const ids = (await sql<{ id: string }[]>`SELECT id FROM inbound_calls WHERE org_id = ${org.id} AND calling_number_id = ${cn.id}`).map((r) => r.id);
    await sql`DELETE FROM usage_events WHERE org_id = ${org.id} AND source_kind = 'call' AND source_id = ANY(${ids.map((i) => `inbound:${i}`)})`;
    await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND action LIKE 'lead.call_in%' AND (target_id = ANY(${ids}) OR metadata->>'inbound_call' = ANY(${ids}))`;
    await sql`DELETE FROM inbound_calls WHERE org_id = ${org.id} AND calling_number_id = ${cn.id}`;
    const leadIds = (await sql<{ id: string }[]>`SELECT id FROM leads WHERE org_id = ${org.id} AND phone = ANY(${[KNOWN, FRESH, JUNK, "+919000000113"]})`).map((r) => r.id);
    const rxIds = (await sql<{ id: string }[]>`SELECT id FROM calls WHERE org_id = ${org.id} AND direction = 'IN' AND lead_id = ANY(${leadIds})`).map((r) => r.id);
    await sql`DELETE FROM usage_events WHERE org_id = ${org.id} AND source_kind = 'call' AND source_id = ANY(${rxIds})`;
    await sql`DELETE FROM calls WHERE id = ANY(${rxIds})`;
    await sql`DELETE FROM lead_events WHERE org_id = ${org.id} AND source = 'PHONE' AND external_id LIKE 'call:rx-%'`;
    await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND target_id = ANY(${leadIds})`;
    await sql`DELETE FROM lead_events WHERE org_id = ${org.id} AND source = 'PHONE' AND external_id LIKE 'call:chk-in-%'`;
    await sql`DELETE FROM leads WHERE id = ANY(${leadIds})`;
    await sql`DELETE FROM sales_team WHERE org_id = ${org.id} AND phone = ANY(${TEAM_IN})`;
    await sql`DELETE FROM memberships WHERE user_id = ${ownerUser.id}`;
    await sql`DELETE FROM users WHERE id = ${ownerUser.id}`;
    await sql`DELETE FROM calling_numbers WHERE id = ${cn.id}`;
  }
}

try {
  console.log("\nCalling: the client's policy");
  const saved = await saveOrgPolicy({
    orgId: org.id,
    userId: admin.id,
    input: { consentRequired: true, announceRecording: false, recordingLine: null, announceAi: true, handoffNumber: "+919876501234", minuteAllowance: 1500 },
  });
  check("the policy saves", saved.ok);
  const now = await policyAt(org.id, null);
  check("and reads back as saved", now.announceRecording === false && now.handoffNumber === "+919876501234");
  const [aud] = await sql`SELECT metadata FROM audit_log WHERE org_id = ${org.id} AND action = 'calling.settings_changed'
                          ORDER BY created_at DESC LIMIT 1`;
  check("the change is audited", !!aud);
  check("with no number in the clear", !JSON.stringify(aud?.metadata ?? {}).includes("9876501234"));
  const bad = await saveOrgPolicy({ orgId: org.id, userId: admin.id, input: { ...now, handoffNumber: "12345" } });
  check("a hand-off number without a country code is refused", !bad.ok);

  check("the suite's own tower may be advertised", !!open);
  check("and its unregistered one may not", !!blocked);
  if (open) {
    console.log(`\nCalling: placing a call about ${open.projectName} ${open.phaseName}`);
    const res = await addLeadAndCall({
      orgId: org.id, userId: admin.id, name: "Check Lead", phone: "90000 00101", phaseId: open.phaseId,
      source: "Check", language: "hi", consentWording: null, nowIso: NOON,
    });
    check("a fresh enquiry is called", res.ok, res.ok ? "" : res.message);
    const req = asked.at(-1);
    check("Sarvam is asked to ring the lead's number", req?.toNumber === PHONE_OK);
    check("the agent is told the tower", (req?.variables.property_viewed ?? "").includes(open.phaseName));
    check("the agent can ask to put the buyer through, for this call and no other",
      res.ok && req?.variables.salesdesk_call === res.callId && webhookIsGenuine(org.id, res.callId, req?.variables.salesdesk_key ?? ""));
    if (res.ok) {
      const [stored] = await sql<{ variables: Record<string, string> }[]>`SELECT variables FROM calls WHERE id = ${res.callId}`;
      check("and the key is never stored with the call", stored && !("salesdesk_key" in stored.variables));
    }
    check("the notice says AI, and no recording because it is off",
      /AI/.test(req?.variables.call_notice ?? "") && !/record/.test(req?.variables.call_notice ?? ""));
    // Nothing after this can be checked without a call; the catch below
    // reports it and the finally still cleans up.
    if (!res.ok || !req) throw new Error("no call was placed, so the rest of the call checks cannot run");
    const url = new URL(req.webhookUrl);
    check("the webhook address proves itself",
      webhookIsGenuine(url.searchParams.get("o")!, url.searchParams.get("c")!, url.searchParams.get("t")!));
    check("and a forged one does not",
      !webhookIsGenuine(url.searchParams.get("o")!, url.searchParams.get("c")!, callToken("x".repeat(64), org.id, "nope")));

    const callId = res.ok ? res.callId : "";
    const [row] = await sql`SELECT status, attempt_id FROM calls WHERE id = ${callId}`;
    check("the call is recorded as dialling", row?.status === "DIALLING" && row?.attempt_id === `att-${asked.length}`);

    const landed = await ingestWebhook(org.id, callId, {
      attempt_id: row?.attempt_id, status: "connected", duration: 142, interaction_id: "int-1",
      final_agent_variables: { lead_disposition: "handed_off", call_summary: "Wants a 2 BHK, handed to sales." },
      interaction_transcript: [{ role: "agent", en_text: "Hello" }, { role: "user", en_text: "Yes" }],
    });
    check("the webhook lands", landed);
    const calls = await listCalls(org.id, await seeAll(org.id));
    const mine = calls.find((c) => c.phone.text === spacedPhone(PHONE_OK));
    check("the log shows it handed to sales", mine?.outcome === "HANDED_OFF");
    check("with its summary", mine?.summary === "Wants a 2 BHK, handed to sales.");
    const wrong = await ingestWebhook(org.id, callId, { attempt_id: "somebody-else", status: "failed" });
    check("a payload for another attempt is ignored", !wrong);

    // An opt-out heard on a call closes the number for good.
    const out = await addLeadAndCall({
      orgId: org.id, userId: admin.id, name: "Opt Out", phone: PHONE_OUT, phaseId: open.phaseId,
      source: "Check", language: "en", consentWording: null, nowIso: NOON,
    });
    check("a second lead is called", out.ok);
    if (out.ok) {
      const [r2] = await sql`SELECT attempt_id FROM calls WHERE id = ${out.callId}`;
      await ingestWebhook(org.id, out.callId, { attempt_id: r2.attempt_id, status: "connected", duration: 12,
        final_agent_variables: { lead_disposition: "dnc" } });
    }
    const again = await addLeadAndCall({
      orgId: org.id, userId: admin.id, name: "Opt Out", phone: PHONE_OUT, phaseId: open.phaseId,
      source: "Check", language: "en", consentWording: null, nowIso: NOON,
    });
    check("and never again once they opted out", !again.ok);

    // Past the 7-day window, consent decides.
    const [oldLead] = await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, enquired_at)
      VALUES (${org.id}, ${open.phaseId}, 'Old Lead', ${PHONE_OLD}, now() - interval '30 days') RETURNING id`;
    const count = asked.length;
    const noConsent = await placeCall({ orgId: org.id, userId: admin.id, leadId: oldLead.id, nowIso: NOON });
    check("a 30-day-old enquiry with no consent is not called", !noConsent.ok);
    await sql`INSERT INTO lead_consents (org_id, phone, channels, wording, source)
              VALUES (${org.id}, ${PHONE_OLD}, ${["call"]}, 'I agree to calls.', 'Check')`;
    const withConsent = await placeCall({ orgId: org.id, userId: admin.id, leadId: oldLead.id, nowIso: NOON });
    check("with consent on file it is", withConsent.ok);
    const night = await placeCall({ orgId: org.id, userId: admin.id, leadId: oldLead.id, nowIso: LATE });
    check("nobody is called at 10:30 pm", !night.ok);
    check("and a refused call rings nothing", asked.length === count + 1);
    process.env.ENVIRONMENT = "development";
    const devNight = await placeCall({ orgId: org.id, userId: admin.id, leadId: oldLead.id, nowIso: LATE });
    if (devNight.ok) await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE id = ${devNight.callId}`;
    process.env.ENVIRONMENT = "production";
    check("in development a call goes out at night; production keeps the hours",
      devNight.ok, devNight.ok ? "" : devNight.message);

    console.log("\nCalling: a call with a goal");
    const [goalLead] = await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone) VALUES (${org.id}, ${open.phaseId}, 'Goal Lead', ${PHONE_GOAL}) RETURNING id`;
    const GOAL = "Ask him to come for a site visit tomorrow at 5 pm";
    const savedGoalApp = [process.env.SARVAM_GOAL_APP_ID, process.env.SARVAM_GOAL_APP_VERSION];
    delete process.env.SARVAM_GOAL_APP_ID;
    const n0 = asked.length;
    const off = await placeCall({ orgId: org.id, userId: admin.id, leadId: goalLead.id, nowIso: NOON, goal: { key: "custom", text: GOAL } });
    check("with no goal agent set up, a goal is refused rather than placed as a plain call",
      !off.ok && off.code === "NOT_SWITCHED_ON" && asked.length === n0, off.ok ? "" : off.message);
    process.env.SARVAM_GOAL_APP_ID = "test-goal-app";
    process.env.SARVAM_GOAL_APP_VERSION = "2";
    try {
      const priced = await placeCall({ orgId: org.id, userId: admin.id, leadId: goalLead.id, nowIso: NOON, goal: { key: "custom", text: "Tell him the 2 BHK is Rs 85 lakh" } });
      check("a goal carrying a price is refused before anything is dialled", !priced.ok && priced.code === "INVALID" && asked.length === n0);
      const g = await placeCall({ orgId: org.id, userId: admin.id, leadId: goalLead.id, nowIso: NOON, goal: { key: "custom", text: GOAL } });
      check("a goal call is placed", g.ok, g.ok ? "" : g.message);
      const req = asked.at(-1);
      check("to the goal agent, not the qualifier", req?.app?.id === "test-goal-app" && req?.app?.version === 2);
      check("carrying the goal, and today's date", req?.variables.call_goal === GOAL && /\d{4}$/.test(req?.variables.today_date ?? ""));
      if (g.ok) {
        const [row] = await sql<{ agent: string; goal: string; goal_text: string; app_id: string; attempt_id: string }[]>`
          SELECT agent, goal, goal_text, app_id, attempt_id FROM calls WHERE id = ${g.callId}`;
        check("the call records which agent and what it was asked", row?.agent === "goal" && row?.goal === "custom" && row?.goal_text === GOAL && row?.app_id === "test-goal-app");
        const [aud] = await sql<{ metadata: Record<string, unknown> }[]>`
          SELECT metadata FROM audit_log WHERE org_id = ${org.id} AND action = 'call.placed' AND target_id = ${g.callId}`;
        check("the audit row names the kind of goal and never its words",
          aud?.metadata.goal === "custom" && !JSON.stringify(aud.metadata).includes("site visit"));
        await ingestWebhook(org.id, g.callId, { attempt_id: row.attempt_id, status: "connected", duration: 64,
          final_agent_variables: { goal_status: "done", goal_note: "Coming tomorrow at 5 pm.", site_visit_status: "booked" } });
        const logged = (await listCalls(org.id, await seeAll(org.id))).find((c) => c.phone.text === spacedPhone(PHONE_GOAL));
        check("the log shows the goal and how it went",
          logged?.goal?.text === GOAL && logged?.goal?.status === "done" && logged?.goal?.note === "Coming tomorrow at 5 pm.");
      }
    } finally {
      if (savedGoalApp[0] === undefined) delete process.env.SARVAM_GOAL_APP_ID; else process.env.SARVAM_GOAL_APP_ID = savedGoalApp[0];
      if (savedGoalApp[1] === undefined) delete process.env.SARVAM_GOAL_APP_VERSION; else process.env.SARVAM_GOAL_APP_VERSION = savedGoalApp[1];
    }

    console.log("\nCalling: the tower a call is about, and what the agent may say about it");
    {
      const [aboutLead] = await sql<{ id: string }[]>`
        INSERT INTO leads (org_id, scope_node_id, name, phone) VALUES (${org.id}, ${open.phaseId}, 'About Lead', ${PHONE_ABOUT}) RETURNING id`;
      const brain = await resolveBrain(org.id, open.phaseId);
      const own = await placeCall({ orgId: org.id, userId: admin.id, leadId: aboutLead.id, nowIso: NOON });
      check("a call is placed about the tower the buyer asked about", own.ok, own.ok ? "" : own.message);
      const v = asked.at(-1)?.variables ?? {};
      check("the agent is told which tower", (v.call_project ?? "").includes(open.phaseName) && (v.property_viewed ?? "").includes(open.phaseName));
      check("and that tower's signed facts", (v.project_facts ?? "").startsWith(`Project: ${open.projectName}, ${open.phaseName}`), v.project_facts);
      const reg = brain?.values["rera.registration_no"];
      if (reg) check("with the number it is registered under", (v.project_facts ?? "").includes(`RERA registration: ${reg}`), v.project_facts);
      const where = brain?.values["claims.location"];
      if (where) check("and where it is", (v.project_facts ?? "").includes(where.split(",")[0].trim()), v.project_facts);
      const banned = (brain?.values["claims.never_say"] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (banned.length) check("and what it must never say", (v.project_facts ?? "").includes(`Never say: ${banned[0]}`), v.project_facts);
      if (own.ok) {
        const [row] = await sql<{ brain_sources: { versionId: string }[]; scope_node_id: string }[]>`
          SELECT brain_sources, scope_node_id FROM calls WHERE id = ${own.callId}`;
        check("the Brain versions the facts came from are kept on the call",
          JSON.stringify((row?.brain_sources ?? []).map((s) => s.versionId).sort()) === JSON.stringify((brain?.sources ?? []).map((s) => s.versionId).sort()));
        await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE id = ${own.callId}`;
      }

      const other = summary.phases.find((p) => p.ok && p.phaseId === fxOtherTower.id);
      if (other) {
        const about = await placeCall({ orgId: org.id, userId: admin.id, leadId: aboutLead.id, nowIso: NOON, nodeId: other.phaseId });
        check("a person may send the call about another tower", about.ok, about.ok ? "" : about.message);
        const w = asked.at(-1)?.variables ?? {};
        check("and the agent is handed that tower's facts instead",
          (w.call_project ?? "").includes(other.phaseName) && (w.project_facts ?? "").startsWith(`Project: ${other.projectName}, ${other.phaseName}`), w.project_facts);
        check("while never telling the buyer they asked about it",
          (w.property_viewed ?? "").includes(open.phaseName) && !(w.property_viewed ?? "").includes(other.phaseName));
        if (about.ok) {
          const [row] = await sql<{ scope_node_id: string }[]>`SELECT scope_node_id FROM calls WHERE id = ${about.callId}`;
          check("the call is filed at that tower, so its minutes are that project's", row?.scope_node_id === other.phaseId);
          const at = new Date(Date.parse(NOON) + 24 * 3_600_000 + 3 * 3_600_000).toISOString(); // tomorrow, 3 pm IST
          const booked = await bookVisit({ orgId: org.id, leadId: aboutLead.id, atIso: at, via: "AI_CALL", callId: about.callId, nowIso: NOON });
          const [visit] = booked && booked.kind !== "FULL"
            ? await sql<{ scope_node_id: string }[]>`SELECT scope_node_id FROM site_visits WHERE id = ${booked.visitId}`
            : [];
          check("and a visit agreed on it is booked at that tower", visit?.scope_node_id === other.phaseId, JSON.stringify(booked));
          await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE id = ${about.callId}`;
        }
      } else {
        console.log("  SKIP  only one advertisable tower, so no call about another");
      }
      if (blocked) {
        const before = asked.length;
        const shut = await placeCall({ orgId: org.id, userId: admin.id, leadId: aboutLead.id, nowIso: NOON, nodeId: blocked.phaseId });
        check("a call about a tower that may not be advertised is refused, and rings nothing",
          !shut.ok && shut.code === "NOT_ADVERTISABLE" && asked.length === before, shut.ok ? "placed" : shut.message);
      }
      process.env.SARVAM_PROJECT_FACTS = "off";
      const quiet = await placeCall({ orgId: org.id, userId: admin.id, leadId: aboutLead.id, nowIso: NOON });
      const q = asked.at(-1)?.variables ?? {};
      check("until the agents read the facts, none are sent and none are recorded",
        quiet.ok && !("project_facts" in q) && !("call_project" in q), quiet.ok ? JSON.stringify(Object.keys(q)) : quiet.message);
      if (quiet.ok) {
        const [row] = await sql<{ brain_sources: unknown[] }[]>`SELECT brain_sources FROM calls WHERE id = ${quiet.callId}`;
        check("and the call keeps no Brain versions it never told the agent", (row?.brain_sources ?? []).length === 0);
        await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE id = ${quiet.callId}`;
      }
      process.env.SARVAM_PROJECT_FACTS = "on";
      const n = asked.length;
      const vague = await placeCall({ orgId: org.id, userId: admin.id, leadId: aboutLead.id, nowIso: NOON, nodeId: fxProject.id });
      check("a call about a whole project rather than one tower is refused", !vague.ok && vague.code === "INVALID" && asked.length === n);
    }

    console.log("\nCalling: each job's own agent, a copy of the qualifier");
    const ROLE_ENV = ["SARVAM_CONFIRMER_APP_ID", "SARVAM_CONFIRMER_APP_VERSION", "SARVAM_REENGAGER_APP_ID", "SARVAM_REENGAGER_APP_VERSION", "SARVAM_POSTVISIT_APP_ID", "SARVAM_POSTVISIT_APP_VERSION"];
    const savedRoles = ROLE_ENV.map((k) => process.env[k]);
    for (const k of ROLE_ENV) delete process.env[k];
    try {
      const [roleLead] = await sql<{ id: string }[]>`
        INSERT INTO leads (org_id, scope_node_id, name, phone, facts)
        VALUES (${org.id}, ${open.phaseId}, 'Role Lead', ${PHONE_ROLE}, ${sql.json({ budget: "Rs 60 to 90 lakh", config: "2 BHK" })}) RETURNING id`;
      const visitAt = new Date(Date.parse(NOON) + 24 * 3_600_000 + 4 * 3_600_000).toISOString(); // tomorrow, 4 pm IST
      const [visit] = await sql<{ id: string }[]>`
        INSERT INTO site_visits (org_id, lead_id, scope_node_id, scheduled_at, booked_via)
        VALUES (${org.id}, ${roleLead.id}, ${open.phaseId}, ${new Date(visitAt)}, 'CONSOLE') RETURNING id`;
      const n1 = asked.length;
      const noConfirmer = await placeCall({ orgId: org.id, userId: null, leadId: roleLead.id, nowIso: NOON, agent: "reminder", visitId: visit.id });
      check("with no visit confirmer set up, a confirmation call is not placed at all",
        !noConfirmer.ok && noConfirmer.code === "NOT_SWITCHED_ON" && asked.length === n1, noConfirmer.ok ? "" : noConfirmer.message);
      // Each call here is ended by hand once it is placed, so the project's lines stay free.
      const settle = async (r: { ok: boolean; callId?: string }) => {
        if (r.ok && r.callId) await sql`UPDATE calls SET status = 'DONE', ended_at = now() WHERE id = ${r.callId} AND status <> 'DONE'`;
      };
      const oldWay = await placeCall({ orgId: org.id, userId: null, leadId: roleLead.id, nowIso: NOON, agent: "recovery" });
      await settle(oldWay);
      check("and a no-show call still runs on the qualifier, as it did before",
        oldWay.ok && asked.at(-1)?.app === undefined && !("call_reason" in (asked.at(-1)?.variables ?? {})), oldWay.ok ? "" : oldWay.message);

      process.env.SARVAM_CONFIRMER_APP_ID = "test-confirmer";
      process.env.SARVAM_CONFIRMER_APP_VERSION = "1";
      process.env.SARVAM_REENGAGER_APP_ID = "test-reengager";
      process.env.SARVAM_REENGAGER_APP_VERSION = "1";
      process.env.SARVAM_POSTVISIT_APP_ID = "test-postvisit";
      process.env.SARVAM_POSTVISIT_APP_VERSION = "1";

      const conf = await placeCall({ orgId: org.id, userId: null, leadId: roleLead.id, nowIso: NOON, agent: "reminder", visitId: visit.id });
      if (!conf.ok && (conf.code === "NOT_IN_PLAN" || conf.code === "NO_PLAN")) {
        console.log(`  SKIP  ${conf.message}`);
      } else {
        check("a confirmation call is placed", conf.ok, conf.ok ? "" : conf.message);
        const req = asked.at(-1);
        check("on the visit confirmer, told why it calls and when the visit is",
          req?.app?.id === "test-confirmer" && req?.variables.call_reason === "confirm" && /4:00 pm$/.test(req?.variables.visit_time ?? ""),
          JSON.stringify({ app: req?.app, reason: req?.variables.call_reason, at: req?.variables.visit_time }));
        check("with the qualifier's voice, hand-off and notice intact",
          !!req?.variables.call_notice && !!req?.variables.salesdesk_key && req?.variables.user_name === "Role");
        if (conf.ok) {
          const [row] = await sql<{ agent: string; app_id: string; attempt_id: string }[]>`SELECT agent, app_id, attempt_id FROM calls WHERE id = ${conf.callId}`;
          check("the call records the confirmer as its agent", row?.agent === "reminder" && row?.app_id === "test-confirmer");
          await ingestWebhook(org.id, conf.callId, { attempt_id: row.attempt_id, status: "connected", duration: 40,
            final_agent_variables: { visit_status: "moved", new_visit_time: "Saturday 11 am", lead_disposition: "warm_lead", call_summary: "Moving the visit to Saturday morning." } });
          const [after] = await sql<{ outcome: string }[]>`SELECT outcome FROM calls WHERE id = ${conf.callId}`;
          check("and its result is read as the confirmer's: the visit moved", after?.outcome === "VISIT_MOVED", after?.outcome);
        }
        const re = await placeCall({ orgId: org.id, userId: null, leadId: roleLead.id, nowIso: NOON, agent: "reengage" });
        await settle(re);
        if (!re.ok && re.code === "NOT_IN_PLAN") {
          console.log(`  SKIP  ${re.message}`);
        } else {
          check("a follow-up call is placed on the re-engager", re.ok && asked.at(-1)?.app?.id === "test-reengager", re.ok ? "" : re.message);
          const v = asked.at(-1)?.variables ?? {};
          check("told what was said last time and what the buyer already told us",
            v.last_call_summary === "Moving the visit to Saturday morning." && v.enquiry_bhk === "2 BHK" && v.enquiry_budget === "Rs 60 to 90 lakh",
            JSON.stringify(v));
        }
        const early = await placeCall({ orgId: org.id, userId: null, leadId: roleLead.id, nowIso: NOON, agent: "post_visit" });
        if (!early.ok && early.code === "NOT_IN_PLAN") {
          console.log(`  SKIP  ${early.message}`);
        } else {
          check("a post-visit call with no visit made is not placed", !early.ok && early.code === "GONE", early.ok ? "" : early.message);
          await sql`UPDATE site_visits SET status = 'VISITED', outcome = ${sql.json({ interest: "Warm", objection: "None", next: "Nothing planned" })}
                    WHERE id = ${visit.id}`;
          const pv = await placeCall({ orgId: org.id, userId: null, leadId: roleLead.id, nowIso: NOON, agent: "post_visit" });
          await settle(pv);
          check("once it is, the post-visit agent is sent, told when they visited",
            pv.ok && asked.at(-1)?.app?.id === "test-postvisit" && /\d{4}$/.test(asked.at(-1)?.variables.visit_date ?? ""), pv.ok ? "" : pv.message);
        }
      }
    } finally {
      ROLE_ENV.forEach((k, i) => (savedRoles[i] === undefined ? delete process.env[k] : (process.env[k] = savedRoles[i])));
    }

    console.log("\nCalling: a result that never arrived is read from Sarvam's log");
    const [lostLead] = await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone) VALUES (${org.id}, ${open.phaseId}, 'Lost Result', ${PHONE_LOST}) RETURNING id`;
    const lost = await placeCall({ orgId: org.id, userId: admin.id, leadId: lostLead.id, nowIso: NOON });
    if (lost.ok) {
      await sql`UPDATE calls SET placed_at = now() - interval '5 minutes' WHERE id = ${lost.callId}`;
      const [{ attempt_id: lostAttempt }] = await sql<{ attempt_id: string }[]>`SELECT attempt_id FROM calls WHERE id = ${lost.callId}`;
      const none = await reconcileCalls(org.id);
      check("a call Sarvam has not finished is left alone", !none.includes(lost.callId));
      sarvamLog.push({
        attemptId: lostAttempt, interactionId: "int-lost", connectivity: "connected", durationS: 41, failureReason: null,
        variables: { lead_disposition: "warm_lead", call_summary: "Wants a 2 BHK next year.", salesdesk_key: "not-kept" },
      });
      const found = await reconcileCalls(org.id);
      const [row] = await sql<{ status: string; outcome: string; duration_s: string; final_variables: Record<string, unknown>; transcript: unknown[] }[]>`
        SELECT status, outcome, duration_s::text, final_variables, transcript FROM calls WHERE id = ${lost.callId}`;
      check("a finished call found in Sarvam's log is settled as if its webhook had come",
        found.includes(lost.callId) && row?.status === "DONE" && row?.outcome === "QUALIFIED" && Number(row?.duration_s) === 41, JSON.stringify(row));
      check("with what was said, turn by turn", Array.isArray(row?.transcript) && row.transcript.length === 2);
      check("and without the call's key", !!row && !("salesdesk_key" in (row.final_variables ?? {})));
      check("a settled call is not asked about again", !(await reconcileCalls(org.id)).includes(lost.callId));
    }
  }

  if (open) {
    console.log("\nCalling: putting ready buyers through to whoever is free");
    for (const [i, phone] of SELLERS.entries()) {
      const r = await addTeamMember({ orgId: org.id, userId: admin.id, name: `Check Seller ${i + 1}`, phone });
      check(`seller ${i + 1} joins the team`, r.ok);
    }
    const twice = await addTeamMember({ orgId: org.id, userId: admin.id, name: "Twice", phone: SELLERS[0] });
    check("the same number twice is refused", !twice.ok);

    const live: LiveCall[] = [
      { uuid: "v-A", from: "+912265480217", to: "+919000000104", status: "in-progress" },
      { uuid: "v-B", from: "+912265480217", to: "+919000000105", status: "in-progress" },
    ];
    const moved: { uuid: string; url: string }[] = [];
    const vz = useVobiz({
      async liveCalls() { return live; },
      async transfer(_c, uuid, url) { moved.push({ uuid, url }); },
    });
    try {
      const a = await addLeadAndCall({
        orgId: org.id, userId: admin.id, name: "Team One", phone: "+919000000104", phaseId: open.phaseId,
        source: "Check", language: "en", consentWording: null, nowIso: NOON,
      });
      if (!a.ok) throw new Error(a.message);
      const asked1 = await requestHandoff(org.id, a.callId);
      check("asking to put the buyer through redirects their live call", asked1.ok && moved[0]?.uuid === "v-A");
      check("to the ring instructions for this call", (moved[0]?.url ?? "").includes(`/api/calls/ring?o=${org.id}&c=${a.callId}&t=`));
      await requestHandoff(org.id, a.callId);
      check("asking twice redirects once", moved.length === 1);
      const xmlA = await ringXml(org.id, a.callId);
      check("every free seller is rung at once", SELLERS.every((n) => xmlA.includes(`<Number>${n}</Number>`)), xmlA);
      await ringEvent(org.id, a.callId, { Event: "DialHangup", DialBLegTo: "919000000202", DialBLegHangupCause: "LOSE_RACE" });
      await ringEvent(org.id, a.callId, { Event: "DialAnswer", DialBLegTo: "919000000201" });
      const [ra] = await sql<{ handoff_state: string; handoff_to: string }[]>`SELECT handoff_state, handoff_to FROM calls WHERE id = ${a.callId}`;
      check("the seller who answered takes the buyer", ra?.handoff_state === "CONNECTED" && ra?.handoff_to === SELLERS[0]);

      const b = await addLeadAndCall({
        orgId: org.id, userId: admin.id, name: "Team Two", phone: "+919000000105", phaseId: open.phaseId,
        source: "Check", language: "en", consentWording: null, nowIso: NOON,
      });
      if (!b.ok) throw new Error(b.message);
      await requestHandoff(org.id, b.callId);
      const xmlB = await ringXml(org.id, b.callId);
      check("the next buyer does not ring the seller still talking", !xmlB.includes(SELLERS[0]) && xmlB.includes(SELLERS[1]), xmlB);
      const heard = await ringResult(org.id, b.callId, { DialStatus: "no-answer", DialBLegUUID: "" });
      check("nobody answering plays no recorded line in another voice", !heard.includes("<Play>") && !heard.includes("<Speak") && heard.includes("<Hangup/>"), heard);
      const [rb] = await sql<{ handoff_state: string; needs_person: string | null }[]>`
        SELECT c.handoff_state, l.needs_person FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.id = ${b.callId}`;
      check("and flags the lead for a person to call now", rb?.handoff_state === "NO_ANSWER" && /Call now/.test(rb?.needs_person ?? ""));
      const [back] = await sql<{ state: string; due_at: Date; detail: Record<string, unknown> }[]>`
        SELECT state, due_at, detail FROM lead_tasks WHERE dedupe_key = ${`${b.lead?.id}:CALLBACK:handoff:${b.callId}`}`;
      check("the agent rings the buyer straight back to carry on", back?.state === "DUE" && back.detail?.handoffMissed === true
        && Math.abs(back.due_at.getTime() - Date.now()) < 120_000, JSON.stringify(back));

      await ringEvent(org.id, a.callId, { Event: "DialHangup", DialBLegTo: "919000000201", DialBLegBillDuration: "120" });
      const [ended] = await sql<{ handoff_state: string; handoff_bill_s: number }[]>`SELECT handoff_state, handoff_bill_s FROM calls WHERE id = ${a.callId}`;
      check("the hang-up records the talk to be metered", ended?.handoff_state === "ENDED" && ended?.handoff_bill_s === 120);
      const [ra2] = await sql<{ attempt_id: string }[]>`SELECT attempt_id FROM calls WHERE id = ${a.callId}`;
      await ingestWebhook(org.id, a.callId, { attempt_id: ra2.attempt_id, status: "connected", duration: 60,
        final_agent_variables: { lead_disposition: "hot_lead" } });
      const [oa] = await sql<{ outcome: string }[]>`SELECT outcome FROM calls WHERE id = ${a.callId}`;
      check("a buyer Sales Desk put through is logged as handed to sales", oa?.outcome === "HANDED_OFF");

      live.length = 0;
      const before = moved.length;
      const gone = await requestHandoff(org.id, b.callId);
      check("a call that is no longer live is not redirected", !gone.ok && moved.length === before);

      const c = await addLeadAndCall({
        orgId: org.id, userId: admin.id, name: "Long Talker", phone: "+919000000106", phaseId: open.phaseId,
        source: "Check", language: "en", consentWording: null, nowIso: NOON,
      });
      if (!c.ok) throw new Error(c.message);
      live.push({ uuid: "v-C", from: "+912265480217", to: "+919000000106", status: "in-progress" });
      const t0 = new Date(Date.parse(NOON) + 60_000);
      const first = await handOffLongCalls(t0);
      const [lc] = await sql<{ live_since: Date | null; handoff_state: string | null }[]>`
        SELECT live_since, handoff_state FROM calls WHERE id = ${c.callId}`;
      check("the watcher notes when a call went live, and hands nothing over yet",
        lc?.live_since?.getTime() === t0.getTime() && lc?.handoff_state === null && first.handedOver === 0, JSON.stringify(first));
      await handOffLongCalls(new Date(t0.getTime() + 299_000));
      check("four minutes fifty nine in, it is still with the AI", !moved.some((m) => m.uuid === "v-C"));
      const late = await handOffLongCalls(new Date(t0.getTime() + 300_000));
      check("at five minutes it is put through to the team", late.handedOver === 1 && moved.some((m) => m.uuid === "v-C"), JSON.stringify(late));
      const [lr] = await sql<{ handoff_reason: string }[]>`SELECT handoff_reason FROM calls WHERE id = ${c.callId}`;
      check("and the call says the clock did it, not the agent", lr?.handoff_reason === "LONG_CALL");
      const xmlC = await ringXml(org.id, c.callId);
      check("the buyer is told they are being connected before the ring", xmlC.includes("connecting you") && xmlC.indexOf("<Speak") < xmlC.indexOf("<Dial"), xmlC);
      const again = await handOffLongCalls(new Date(t0.getTime() + 330_000));
      check("a call already handed over is not handed over again", again.handedOver === 0);
    } finally {
      vz.restore();
    }
  }

  if (open) await ownNumbers(open.phaseId);
  await clientKyc();
  if (open) await inboundCalls(open.phaseId);

  console.log("\nCalling: isolation");
  const rls = await sql<{ relname: string; relrowsecurity: boolean }[]>`
    SELECT relname, relrowsecurity FROM pg_class
    WHERE relname = ANY(${["calling_settings", "leads", "lead_consents", "call_suppressions", "calls", "sales_team", "inbound_calls"]})`;
  check("every calling table is under row-level security",
    rls.length === 7 && rls.every((r) => r.relrowsecurity), JSON.stringify(rls));
  const { withTenant } = await import("../src/lib/db/index.ts");
  const stranger = await withTenant("00000000-0000-0000-0000-000000000001", (t) =>
    t`SELECT (SELECT count(*) FROM calls) + (SELECT count(*) FROM leads) + (SELECT count(*) FROM call_suppressions) AS n`);
  check("another tenant sees no calls, leads or opt-outs", Number(stranger[0].n) === 0);
  const [grants] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.role_table_grants
    WHERE grantee = 'salesdesk_app' AND privilege_type IN ('UPDATE', 'DELETE')
      AND table_name IN ('lead_consents', 'call_suppressions')`;
  check("the app can never change or remove consent or an opt-out", grants.n === 0);

  if (blocked) {
    const res = await addLeadAndCall({
      orgId: org.id, userId: admin.id, name: "Blocked", phone: PHONE_OK, phaseId: blocked.phaseId,
      source: "Check", language: "en", consentWording: null, nowIso: NOON,
    });
    check("a phase that may not be advertised gets no call", !res.ok);
  }
} catch (e) {
  check("the suite ran to the end", false, e instanceof Error ? e.message : String(e));
} finally {
  fake.restore();
  await cleanup();
  await dropFixtures();
  if (savedRow) {
    await saveOrgPolicy({ orgId: org.id, userId: admin.id, input: before });
  } else {
    await sql`DELETE FROM calling_settings WHERE org_id = ${org.id}`;
  }
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
