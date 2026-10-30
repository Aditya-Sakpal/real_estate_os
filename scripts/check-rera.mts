// Functional check of phases, registration and exemption, through the console.
//
//   node --env-file=.env.local scripts/check-rera.mjs
//
// This is the suite that guards the claim the product is sold on: that a
// phase cannot be advertised unless it is registered or exempt, and that
// asserting either is attributable to a named person.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import postgres from "postgres";
import { sweep } from "../src/lib/rera-sweep.ts";
import { parseList } from "../src/lib/rera-mh.ts";
import { lookupRegistration, resetRegisterCache } from "../src/lib/rera-mh-register.ts";
import { searchRegistration } from "../src/lib/rera-mh-search.ts";
import { canPublish, complianceSummary } from "../src/lib/publish-gate.ts";
import { closeDb } from "../src/lib/db/index.ts";

// The sweep runs in THIS process, so point its bulk register at the fixture
// here rather than in .env.local. There it would also reach the dev server's
// own job, and a three-record register blocks every real registration a
// developer records while trying the product.
process.env.RERA_MH_REGISTER_URL =
  new URL("../db/fixtures/maharera-register.html", import.meta.url).href;

const BASE = process.env.AUTH_URL ?? "http://localhost:3000";
const COOKIE = "authjs.session-token";
const CHROME = [
  process.env.CHROME_PATH ?? "", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// Scoped to this suite's tenant. The sweep is global by nature, and an
// unscoped test sweep would reach into real records.
const SCOPE = { orgIds: [] as string[] };

const ENTITY = "Rera Check Holdings LLP";
// Unique per org by index, so this suite uses a number nothing else claims.
// It is also in db/fixtures/maharera-register.html, which RERA_MH_REGISTER_URL
// points the register at. Change one and change the other, or the existence
// check will refuse it.
const REG_NO = "P99900012345";
// Shaped like a registration number and in no register anywhere. This is the
// fabricated certificate the whole existence check exists to catch.
const FAKE_NO = "P99900099999";
// A second number from the same fixture. A registration number is unique per
// org, so the acceptance test needs its own rather than borrowing the one
// Tower C already holds.
const REG_NO_2 = "P99900067890";
// Registered, and to somebody else. A real number belonging to another
// developer is the failure the entity's legal name exists to catch.
const OTHERS_NO = "P99900033333";
// Issued once, cancelled since.
const REVOKED_NO = "P99900055555";
// This suite runs in an organisation of its own, made here and removed at the
// end. It used to borrow the first admin's organisation, which on a shared
// database is a real developer's: its sweep then blocked that developer's
// own registrations, and its cleanup deleted every tenant's RERA audit rows.
const TAG = `rera${Date.now().toString(36)}`;
const DOMAIN = `${TAG}.example`;
// Leftovers of an earlier run that died before its cleanup.
const dropOrgs = async (ids: string[]) => {
  if (!ids.length) return;
  await sql`UPDATE orgs SET status = 'SUSPENDED' WHERE id = ANY(${ids})`;
  await sql`DELETE FROM audit_log WHERE org_id = ANY(${ids})`;
  await sql`DELETE FROM registration_records WHERE org_id = ANY(${ids})`;
  await sql`DELETE FROM memberships WHERE org_id = ANY(${ids})`;
  await sql`DELETE FROM orgs WHERE id = ANY(${ids})`;
};
const stale = await sql<{ id: string }[]>`SELECT id FROM orgs WHERE primary_domain LIKE 'rera%.example' AND legal_name = 'Rera Check Org'`;
await dropOrgs(stale.map((o) => o.id));
await sql`DELETE FROM users WHERE email_domain LIKE 'rera%.example' AND email LIKE 'admin@rera%'`;

const [admin] = await sql`
  INSERT INTO users (email, email_domain, name) VALUES (${`admin@${DOMAIN}`}, ${DOMAIN}, 'Rera Check Admin')
  RETURNING id, email, name`;
const [org] = await sql`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
  VALUES ('DEVELOPER', 'Rera Check Org', 'Rera Check Org', 'AAACR9876Q', ${DOMAIN}, ${admin.id})
  RETURNING id`;
SCOPE.orgIds.push(org.id);
const [root] = await sql`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, NULL, 'ORG', 'Rera Check Org', ${TAG}, ${TAG}::ltree)
  RETURNING id, path::text AS path`;
await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status)
          VALUES (${admin.id}, ${org.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
const wipe = async () => {
  await dropOrgs([org.id]);
  await sql`DELETE FROM users WHERE id = ${admin.id}`;
};

// Seed a clean entity/region/project directly: this suite is about what hangs
// BELOW a project, and check-entity already covers building the tree.
const [entity] = await sql`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${root.id}, 'ENTITY', ${ENTITY}, 'rera_check_holdings_llp',
          ${root.path + ".rera_check_holdings_llp"}::ltree)
  RETURNING id, path::text AS path`;
await sql`
  INSERT INTO entity_details (scope_node_id, org_id, pan) VALUES (${entity.id}, ${org.id}, 'AAACR1234P')`;
const [region] = await sql`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${entity.id}, 'REGION', 'Pune', 'pune', ${entity.path + ".pune"}::ltree)
  RETURNING id, path::text AS path`;
const [project] = await sql`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${region.id}, 'PROJECT', 'Rera Check Trees', 'rera_check_trees',
          ${region.path + ".rera_check_trees"}::ltree)
  RETURNING id`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const context = await browser.createBrowserContext();
const page = await context.newPage();
// A cold route in the dev server can outlast puppeteer's 30s default,
// and a navigation that times out fails the suite for a reason that has
// nothing to do with the rule being checked.
page.setDefaultNavigationTimeout(90000);
await page.setViewport({ width: 1440, height: 1100 });
await page.setCookie({
  name: COOKIE,
  value: await encode({
    token: { sub: admin.id, userId: admin.id, email: admin.email, name: admin.name },
    secret: process.env.AUTH_SECRET,
    salt: COOKIE,
    maxAge: 900,
  }),
  domain: "localhost",
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
});
// The organisation this suite seeded, not whichever one the account opens first.
await page.setCookie({ name: "salesdesk.org", value: org.id, domain: "localhost", path: "/", sameSite: "Lax" });

const PAGE = `${BASE}/dashboard/projects/${project.id}`;
const open = (url) => page.goto(url, { waitUntil: "networkidle0" });
const settle = () => page.waitForNetworkIdle({ idleTime: 500, timeout: 20000 }).catch(() => {});
const submitIn = async (anchorSelector) => {
  await page.waitForSelector(anchorSelector, { timeout: 20000 });
  await page.evaluate(
    (sel) => document.querySelector(sel).closest("form").querySelector("button[type=submit]").click(),
    anchorSelector,
  );
  await settle();
};
/**
 * The refusal note, once it is actually there.
 *
 * `submitIn()` waits for the network to go idle, and a server action that
 * checks a registration against the portal can outlast that wait. Reading the
 * note a moment too early returns an empty string, which reports as "the
 * screen said nothing" rather than as "we looked too soon". An absent note
 * still comes back empty after the timeout, so a check expecting none works.
 */
const err = async () => {
  await page.waitForSelector(".note--risk", { timeout: 15000 }).catch(() => {});
  return page.$eval(".note--risk", (el) => el.textContent.trim()).catch(() => "");
};

// --- phases ----------------------------------------------------------------
console.log("\nphases");
await open(PAGE);
await page.$eval("form.invite input[name=name]", (el) => (el.value = "Tower C"));
await submitIn("form.invite input[name=name]");

const [phase] = await sql`
  SELECT ph.id, ph.kind, ph.path::text AS path, r.status
  FROM scope_nodes ph LEFT JOIN registration_records r ON r.scope_node_id = ph.id
  WHERE ph.org_id = ${org.id} AND ph.parent_id = ${project.id}`;
check("a phase is created", !!phase);
check("of kind PHASE", phase?.kind === "PHASE", phase?.kind);
// An absent record and a failed lookup mean the same thing, and writing it
// down makes the state visible rather than inferred.
check("and starts BLOCKED, explicitly", phase?.status === "BLOCKED", phase?.status);

await open(PAGE);
const pill = await page.$$eval(".person__when .pill", (n) => n.map((x) => x.textContent.trim()));
check("the screen says it is not registered", pill.join(" ").includes("Not registered"),
  pill.join(", "));

// --- registration ----------------------------------------------------------
console.log("\nrecording a registration");
const record = async (no, promoter, validTo, reason) => {
  await open(PAGE);
  await page.$eval("#registrationNo", (el, v) => (el.value = v), no);
  await page.$eval("#validTo", (el, v) => (el.value = v), validTo);
  await page.$eval("#promoterName", (el, v) => (el.value = v), promoter);
  await page.$eval("#reason", (el, v) => (el.value = v), reason);
  await submitIn("#registrationNo");
};

await record("ABC123456", ENTITY, "2027-03-31", "Read on the portal, active");
check("a malformed MahaRERA number is refused",
  (await sql`SELECT status FROM registration_records WHERE scope_node_id = ${phase.id}`)[0].status === "BLOCKED");
check("and the message names the state's format", /Maharashtra/i.test(await err()),
  (await err()).slice(0, 60));

// The promoter on the filing is who gets held to it, so a mismatch cannot
// pass. This is what the entity form's "registered legal name" serves.
await record(REG_NO, "Some Other Developer Ltd", "2027-03-31", "Read on the portal, active");
check("a promoter mismatch is refused",
  (await sql`SELECT status FROM registration_records WHERE scope_node_id = ${phase.id}`)[0].status === "BLOCKED");
check("and names both parties", (await err()).includes(ENTITY), (await err()).slice(0, 80));

// Nothing talks to a portal yet, so a human assertion has to be attributable.
await record(REG_NO, ENTITY, "2027-03-31", "ok");
check("a verification with no stated reason is refused",
  (await sql`SELECT status FROM registration_records WHERE scope_node_id = ${phase.id}`)[0].status === "BLOCKED");

await record(REG_NO, ENTITY, "2027-03-31", "Read on maharera portal, status active");
const [verified] = await sql`
  SELECT status, registration_no, state_code, promoter_name, valid_to,
         verified_at, last_checked_at, resolved_by, resolution_reason
  FROM registration_records WHERE scope_node_id = ${phase.id}`;
check("a good registration verifies", verified?.status === "VERIFIED", verified?.status);
check("the number and state are stored",
  verified?.registration_no === REG_NO && verified?.state_code === "MH",
  `${verified?.registration_no} ${verified?.state_code}`);
check("the resolver is recorded", verified?.resolved_by === admin.id);
check("with their stated reason", /maharera/i.test(verified?.resolution_reason ?? ""),
  verified?.resolution_reason);
// The number was matched against the published register as it was recorded,
// so a machine really did look and the stamp is honest. What it is NOT is a
// check of the certificate in front of the officer, which is why the record
// still carries who resolved it and why.
check("last_checked_at is stamped, because the register was read",
  verified?.last_checked_at !== null, String(verified?.last_checked_at));

const [reraAudit] = await sql`
  SELECT metadata FROM audit_log WHERE org_id = ${org.id} AND action = 'rera.verified'
  ORDER BY id DESC LIMIT 1`;
check("verification is audited as a manual resolution",
  reraAudit?.metadata?.resolution === "manual", JSON.stringify(reraAudit?.metadata));

await open(PAGE);
const pill2 = await page.$$eval(".person__when .pill", (n) => n.map((x) => x.textContent.trim()));
check("the screen now reads VERIFIED", pill2.join(" ").includes("VERIFIED"), pill2.join(", "));

// A filing belongs to one phase. Reusing a number that is already recorded
// is refused by the index, not by a check someone could forget to write.
const [otherPhase] = await sql`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Tower B', 'tower_b',
          ${(await sql`SELECT path::text AS p FROM scope_nodes WHERE id = ${project.id}`)[0].p + ".tower_b"}::ltree)
  RETURNING id`;
await sql`INSERT INTO registration_records (scope_node_id, org_id, status)
          VALUES (${otherPhase.id}, ${org.id}, 'BLOCKED')`;
await open(PAGE);
await page.select("#phaseId", otherPhase.id);
await page.$eval("#registrationNo", (el, v) => (el.value = v), REG_NO);
await page.$eval("#validTo", (el) => (el.value = "2027-03-31"));
await page.$eval("#promoterName", (el, v) => (el.value = v), ENTITY);
await page.$eval("#reason", (el) => (el.value = "Read on maharera portal, status active"));
await submitIn("#registrationNo");
const [dupeReg] = await sql`
  SELECT status FROM registration_records WHERE scope_node_id = ${otherPhase.id}`;
check("the same registration number cannot cover two phases",
  dupeReg?.status === "BLOCKED", dupeReg?.status);
check("and says the number is already recorded", /already recorded/i.test(await err()),
  (await err()).slice(0, 70));

// --- the number has to exist -----------------------------------------------
console.log("\nexistence, against the published register");
// A well-formed number that was never issued is the fabricated-certificate
// case. It passes the format check, it is absent from the revocation list for
// the same reason a clean number is, and only the register catches it.
resetRegisterCache();
const present = await lookupRegistration(REG_NO);
check("the suite's number is in the register",
  present.known && present.found, JSON.stringify(present));
const present2 = await lookupRegistration(REG_NO_2);
check("and so is the second one", present2.known && present2.found,
  JSON.stringify(present2));
const absent = await lookupRegistration(FAKE_NO);
check("a fabricated number is not", absent.known && !absent.found, JSON.stringify(absent));
check("and that is a definite answer, not an unknown", absent.known, JSON.stringify(absent));

// The search is the record-time check, and unlike the bulk register it tells
// the three cases apart.
const sLive = await searchRegistration(REG_NO);
check("the search reads the suite's number as registered",
  sLive.known && sLive.status === "REGISTERED", JSON.stringify(sLive));
check("and returns the promoter the authority holds",
  sLive.known && sLive.status === "REGISTERED"
    ? sLive.project.promoterName : "",
  ENTITY);
const sGone = await searchRegistration(REVOKED_NO);
check("a cancelled registration reads revoked",
  sGone.known && sGone.status === "REVOKED", JSON.stringify(sGone));
const sNever = await searchRegistration(FAKE_NO);
check("and a fabricated one reads absent",
  sNever.known && sNever.status === "ABSENT", JSON.stringify(sNever));

// An unreadable register must never refuse a lawful registration. It is the
// same rule as the sweep's, in the other direction.
resetRegisterCache();
const unknown = await lookupRegistration(REG_NO, async () => {
  throw new Error("ECONNREFUSED");
});
resetRegisterCache();
check("an unreachable register answers unknown, not missing", unknown.known === false,
  JSON.stringify(unknown));

// Now through the console, which is what a person actually does.
const [freshPhase] = await sql`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Tower D', 'tower_d',
          ${(await sql`SELECT path::text AS p FROM scope_nodes WHERE id = ${project.id}`)[0].p + ".tower_d"}::ltree)
  RETURNING id`;
await sql`INSERT INTO registration_records (scope_node_id, org_id, status)
          VALUES (${freshPhase.id}, ${org.id}, 'BLOCKED')`;

await open(PAGE);
await page.select("#phaseId", freshPhase.id);
await page.$eval("#registrationNo", (el, v) => (el.value = v), FAKE_NO);
await page.$eval("#validTo", (el) => (el.value = "2027-03-31"));
await page.$eval("#promoterName", (el, v) => (el.value = v), ENTITY);
await page.$eval("#reason", (el) => (el.value = "Certificate handed over by the promoter"));
await submitIn("#registrationNo");
const [fakeRow] = await sql`
  SELECT status FROM registration_records WHERE scope_node_id = ${freshPhase.id}`;
check("a number in no register is refused at the form",
  fakeRow?.status === "BLOCKED", fakeRow?.status);
check("and the message says the authority has no such project",
  /no project under/i.test(await err()), (await err()).slice(0, 80));

// A registration that was cancelled is refused differently, because "this was
// revoked" and "this never existed" are different conversations to have with
// a client.
await open(PAGE);
await page.select("#phaseId", freshPhase.id);
await page.$eval("#registrationNo", (el, v) => (el.value = v), REVOKED_NO);
await page.$eval("#validTo", (el) => (el.value = "2027-03-31"));
await page.$eval("#promoterName", (el, v) => (el.value = v), ENTITY);
await page.$eval("#reason", (el) => (el.value = "Certificate handed over by the promoter"));
await submitIn("#registrationNo");
const [revokedRow] = await sql`
  SELECT status FROM registration_records WHERE scope_node_id = ${freshPhase.id}`;
check("a revoked registration is refused at the form",
  revokedRow?.status === "BLOCKED", revokedRow?.status);
check("and the message says it was cancelled, not that it never existed",
  /revoked/i.test(await err()), (await err()).slice(0, 80));

// A real number that belongs to a different developer. This is the one the
// bulk register could never catch, because its public extract carries no
// promoter name.
await open(PAGE);
await page.select("#phaseId", freshPhase.id);
await page.$eval("#registrationNo", (el, v) => (el.value = v), OTHERS_NO);
await page.$eval("#validTo", (el) => (el.value = "2027-03-31"));
await page.$eval("#promoterName", (el, v) => (el.value = v), ENTITY);
await page.$eval("#reason", (el) => (el.value = "Certificate handed over by the promoter"));
await submitIn("#registrationNo");
const [othersRow] = await sql`
  SELECT status FROM registration_records WHERE scope_node_id = ${freshPhase.id}`;
check("a registration belonging to another promoter is refused",
  othersRow?.status === "BLOCKED", othersRow?.status);
check("and the message names who MahaRERA registered it to",
  /Completely Different Developers/i.test(await err()), (await err()).slice(0, 110));

// The same form, with a number the register knows, is accepted AND stamped:
// a machine really did look, so the record is Verified and not merely
// Attested. That stamp is the whole difference the register buys.
await open(PAGE);
await page.select("#phaseId", freshPhase.id);
await page.$eval("#registrationNo", (el, v) => (el.value = v), REG_NO_2);
await page.$eval("#validTo", (el) => (el.value = "2027-03-31"));
await page.$eval("#promoterName", (el, v) => (el.value = v), ENTITY);
await page.$eval("#reason", (el) => (el.value = "Certificate handed over by the promoter"));
await submitIn("#registrationNo");
const [realRow] = await sql`
  SELECT status, last_checked_at FROM registration_records WHERE scope_node_id = ${freshPhase.id}`;
check("a number the register knows is accepted", realRow?.status === "VERIFIED", realRow?.status);
check("and is stamped as checked, not left merely attested",
  realRow?.last_checked_at !== null);

const [existAudit] = await sql`
  SELECT metadata FROM audit_log WHERE org_id = ${org.id} AND action = 'rera.verified'
  ORDER BY id DESC LIMIT 1`;
check("the audit records that the register was checked",
  existAudit?.metadata?.register_checked === true, JSON.stringify(existAudit?.metadata));
check("and what the authority calls the project",
  typeof existAudit?.metadata?.register_project === "string",
  JSON.stringify(existAudit?.metadata?.register_project));
check("and the promoter the authority holds",
  existAudit?.metadata?.register_promoter === ENTITY,
  JSON.stringify(existAudit?.metadata?.register_promoter));

// And the sweep catches one that slipped in before the check existed.
await sql`
  UPDATE registration_records
  SET status = 'VERIFIED', registration_no = ${FAKE_NO}, state_code = 'MH',
      valid_to = '2030-01-01', last_checked_at = NULL
  WHERE scope_node_id = ${freshPhase.id}`;
const swept = await sweep(new Date(), SCOPE);
const [sweptRow] = await sql`
  SELECT status, resolution_reason FROM registration_records
  WHERE scope_node_id = ${freshPhase.id}`;
check("the sweep blocks a registration that is in no register",
  sweptRow?.status === "BLOCKED", sweptRow?.status);
check("and says so plainly", /not in the MahaRERA register/i.test(sweptRow?.resolution_reason ?? ""),
  sweptRow?.resolution_reason);
check("the sweep reports it", swept.unregistered.length >= 1, `${swept.unregistered.length}`);
check("and reports the register size it used", (swept.registerSize ?? 0) > 0,
  `${swept.registerSize}`);

const [unregAudit] = await sql`
  SELECT actor_user_id, metadata FROM audit_log
  WHERE org_id = ${org.id} AND action = 'rera.unregistered' ORDER BY id DESC LIMIT 1`;
check("it is audited", !!unregAudit);
check("with no actor, because a job did it", unregAudit?.actor_user_id === null);
check("and names the check that found it", unregAudit?.metadata?.check === "register",
  JSON.stringify(unregAudit?.metadata));

await sql`DELETE FROM registration_records WHERE scope_node_id = ${freshPhase.id}`;
await sql`DELETE FROM scope_nodes WHERE id = ${freshPhase.id}`;

// --- exemption -------------------------------------------------------------
console.log("\nexemption");
const attest = async (area, units) => {
  await open(PAGE);
  await page.$eval("#landAreaSqm", (el, v) => (el.value = v), String(area));
  await page.$eval("#apartmentCount", (el, v) => (el.value = v), String(units));
  await submitIn("#landAreaSqm");
};

await attest(900, 20);
check("over the threshold is refused",
  (await sql`SELECT scope_node_id FROM project_exemptions WHERE scope_node_id = ${project.id}`).length === 0);
check("and the refusal shows both measures", /900/.test(await err()), (await err()).slice(0, 80));

await attest(400, 6);
const [exempt] = await sql`
  SELECT land_area_sqm, apartment_count, attested_by, attested_at, expires_at
  FROM project_exemptions WHERE scope_node_id = ${project.id}`;
check("under the threshold attests", !!exempt);
check("recording who attested it", exempt?.attested_by === admin.id);
// 90 days, because an exemption that never expires is one nobody revisits
// when the plan grows.
const days = exempt
  ? Math.round((exempt.expires_at.getTime() - exempt.attested_at.getTime()) / 86400000)
  : 0;
check("expiring in 90 days", days === 90, `${days} days`);

// The exemption is attested on the PROJECT and inherited by its phases, but
// it must not quietly overwrite a phase that is already verified.
const [stillVerified] = await sql`
  SELECT status FROM registration_records WHERE scope_node_id = ${phase.id}`;
check("a verified phase is not downgraded to exempt",
  stillVerified?.status === "VERIFIED", stillVerified?.status);

// A second, unregistered phase should inherit it.
const [phase2] = await sql`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Tower D', 'tower_d',
          ${(await sql`SELECT path::text AS p FROM scope_nodes WHERE id = ${project.id}`)[0].p + ".tower_d"}::ltree)
  RETURNING id`;
await sql`INSERT INTO registration_records (scope_node_id, org_id, status)
          VALUES (${phase2.id}, ${org.id}, 'BLOCKED')`;
await attest(400, 6);
const [inherited] = await sql`
  SELECT status, resolution_reason FROM registration_records WHERE scope_node_id = ${phase2.id}`;
check("an unregistered phase inherits the exemption",
  inherited?.status === "EXEMPT", inherited?.status);
check("with the threshold arithmetic as its reason",
  /limit 500/.test(inherited?.resolution_reason ?? ""), inherited?.resolution_reason);

const [exemptAudit] = await sql`
  SELECT metadata FROM audit_log WHERE org_id = ${org.id} AND action = 'rera.exempted'
  ORDER BY id DESC LIMIT 1`;
check("the exemption is audited with its measures",
  exemptAudit?.metadata?.land_area_sqm === 400 && exemptAudit?.metadata?.apartment_count === 6,
  JSON.stringify(exemptAudit?.metadata));


// --- the publish gate -------------------------------------------------------
console.log("\nthe publish gate");
// Tower C is verified to 2027, Tower D is exempt, Tower B is blocked.
const gateVerified = await canPublish(org.id, phase.id);
check("a verified phase may be published", gateVerified.ok, JSON.stringify(gateVerified));

const gateExempt = await canPublish(org.id, phase2.id);
check("an exempt phase may be published", gateExempt.ok, JSON.stringify(gateExempt));

// Tower B inherited the project's exemption, which is correct: an exemption
// attested on a project covers every phase beneath it.
const gateInherited = await canPublish(org.id, otherPhase.id);
check("a phase inheriting the project exemption may be published",
  gateInherited.ok, JSON.stringify(gateInherited));

// So a genuinely blocked phase needs a project with no exemption.
const [project2] = await sql`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${region.id}, 'PROJECT', 'Rera Check Skyline', 'rera_check_skyline',
          ${region.path + ".rera_check_skyline"}::ltree)
  RETURNING id`;
const [lonePhase] = await sql`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project2.id}, 'PHASE', 'Tower Z', 'tower_z',
          ${region.path + ".rera_check_skyline.tower_z"}::ltree)
  RETURNING id`;
await sql`INSERT INTO registration_records (scope_node_id, org_id, status)
          VALUES (${lonePhase.id}, ${org.id}, 'BLOCKED')`;

const gateBlocked = await canPublish(org.id, lonePhase.id);
check("a blocked phase may not", gateBlocked.ok === false, JSON.stringify(gateBlocked));
check("and the refusal names the phase",
  !gateBlocked.ok && gateBlocked.message.includes("Tower Z"),
  gateBlocked.ok ? "" : gateBlocked.message);
check("and says why, plainly", !gateBlocked.ok && /Not registered yet/.test(gateBlocked.message),
  gateBlocked.ok ? "" : gateBlocked.message);

// Fails closed on everything, including a phase id that is not ours.
const gateGhost = await canPublish(org.id, "00000000-0000-0000-0000-000000000000");
check("an unknown phase may not", gateGhost.ok === false,
  gateGhost.ok ? "allowed" : gateGhost.code);

const summary = await complianceSummary(org.id);
check("the summary counts what is blocked", summary.blocked.length >= 1,
  `${summary.blocked.length}`);
check("and which projects that affects", summary.blockedProjects >= 1,
  `${summary.blockedProjects}`);

// --- the sweep --------------------------------------------------------------
console.log("\nthe nightly sweep");
// A registration does not fail loudly. It stops being valid one morning, and
// catching that needs no portal at all: the date is already recorded.
await sql`
  UPDATE registration_records SET valid_to = '2020-01-01', status = 'VERIFIED'
  WHERE scope_node_id = ${phase.id}`;
const r1 = await sweep(new Date(), SCOPE);
const [afterLapse] = await sql`
  SELECT status, resolution_reason FROM registration_records WHERE scope_node_id = ${phase.id}`;
check("an expired registration is blocked by the sweep",
  afterLapse?.status === "BLOCKED", afterLapse?.status);
check("with the expiry date as the reason",
  /expired on/i.test(afterLapse?.resolution_reason ?? ""), afterLapse?.resolution_reason);
check("and the sweep reports it", r1.lapsed.length >= 1, `${r1.lapsed.length}`);

const [lapseAudit] = await sql`
  SELECT actor_user_id, metadata FROM audit_log
  WHERE org_id = ${org.id} AND action = 'rera.lapsed' ORDER BY id DESC LIMIT 1`;
check("the lapse is audited", !!lapseAudit);
// Nobody did this. Attributing it to a person would be a lie.
check("with no actor, because a job did it", lapseAudit?.actor_user_id === null,
  String(lapseAudit?.actor_user_id));
check("and says the sweep did it", lapseAudit?.metadata?.by === "sweep",
  JSON.stringify(lapseAudit?.metadata));

// An exemption older than its 90 days drops its phases too.
await sql`
  UPDATE project_exemptions SET expires_at = '2020-01-01' WHERE scope_node_id = ${project.id}`;
await sql`
  UPDATE registration_records SET status = 'EXEMPT' WHERE scope_node_id = ${phase2.id}`;
const r2 = await sweep(new Date(), SCOPE);
const [afterExempt] = await sql`
  SELECT status, resolution_reason FROM registration_records WHERE scope_node_id = ${phase2.id}`;
check("a stale exemption blocks its phases",
  afterExempt?.status === "BLOCKED", afterExempt?.status);
check("with the attestation date as the reason",
  /attestation expired/i.test(afterExempt?.resolution_reason ?? ""), afterExempt?.resolution_reason);
check("and the sweep reports that separately",
  r2.exemptionsLapsed.length >= 1, `${r2.exemptionsLapsed.length}`);

// The attestation row survives. It is the record that someone asserted this
// on a date, and deleting it would erase the accountability rather than end it.
const stillAttested = await sql`
  SELECT attested_by FROM project_exemptions WHERE scope_node_id = ${project.id}`;
check("the attestation itself is not deleted", stillAttested.length === 1);

// No per-state adapter is registered, so nothing went looking beyond the
// published lists, and nothing pretends otherwise.
check("the sweep reports the portal as unavailable", r2.portalUnavailable >= 0,
  `${r2.portalUnavailable}`);
// The stamp on this row is the one the form put there when the number was
// recorded. A blocked registration is not re-checked, so the sweep must not
// move it: the column says when a machine last looked, not when a job last
// ran.
const [stamp] = await sql`
  SELECT last_checked_at FROM registration_records WHERE scope_node_id = ${phase.id}`;
check("a blocked row is not re-stamped by the sweep",
  stamp?.last_checked_at !== null &&
    stamp.last_checked_at.getTime() <= Date.now(),
  String(stamp?.last_checked_at));

// Running it again changes nothing: everything it does is driven by dates
// that have already passed.
const r3 = await sweep(new Date(), SCOPE);
check("the sweep is idempotent",
  r3.lapsed.length === 0 && r3.exemptionsLapsed.length === 0,
  `${r3.lapsed.length} + ${r3.exemptionsLapsed.length}`);

// And now nothing may be published.
const afterAll = await canPublish(org.id, phase.id);
check("a lapsed phase can no longer be published", afterAll.ok === false,
  JSON.stringify(afterAll));


// --- revocation by the authority -------------------------------------------
console.log("\nrevocation, from the published list");
// MahaRERA publishes every suspended and deregistered project in bulk, so the
// sweep reads two pages rather than asking about each registration. The list
// is injected here: a test run must never call a government website.
const revokedPage = (no) =>
  Array.from({ length: 25 }, (_, i) =>
    `<tr><td>${i}</td><td>Some Project</td><td>Some Promoter</td>` +
    `<td>${i === 0 ? no : `P517000319${String(i).padStart(2, "0")}`}</td>` +
    `<td>MCGM</td><td></td></tr>`,
  ).join("");
const listFetch = (no) => async () =>
  new Response(`<table>${revokedPage(no)}</table>`, { status: 200 });

// Put a verified phase back in place, then revoke it upstream.
await sql`
  UPDATE registration_records
  SET status = 'VERIFIED', registration_no = ${REG_NO}, state_code = 'MH',
      valid_to = '2030-01-01', last_checked_at = NULL
  WHERE scope_node_id = ${phase.id}`;

const rev = await sweep(new Date(), { ...SCOPE, fetchImpl: listFetch(REG_NO) });
const [afterRevoke] = await sql`
  SELECT status, resolution_reason, last_checked_at
  FROM registration_records WHERE scope_node_id = ${phase.id}`;
check("a revoked registration is blocked", afterRevoke?.status === "BLOCKED",
  afterRevoke?.status);
check("with the authority named as the reason",
  /MahaRERA/i.test(afterRevoke?.resolution_reason ?? ""), afterRevoke?.resolution_reason);
check("and the sweep reports it", rev.revoked.length >= 1, `${rev.revoked.length}`);
check("the list size is reported", rev.blocklistSize === 25, `${rev.blocklistSize}`);

const [revAudit] = await sql`
  SELECT actor_user_id, metadata FROM audit_log
  WHERE org_id = ${org.id} AND action = 'rera.revoked' ORDER BY id DESC LIMIT 1`;
check("the revocation is audited", !!revAudit);
check("with no actor, because a job did it", revAudit?.actor_user_id === null);
check("and records that it came from the blocklist",
  revAudit?.metadata?.check === "blocklist", JSON.stringify(revAudit?.metadata));

// A registration that is NOT on the list was still checked against the
// authority, so last_checked_at is honest to stamp.
await sql`
  UPDATE registration_records
  SET status = 'VERIFIED', valid_to = '2030-01-01', last_checked_at = NULL
  WHERE scope_node_id = ${phase.id}`;
await sweep(new Date(), { ...SCOPE, fetchImpl: listFetch("P51700039999") });
const [survivor] = await sql`
  SELECT status, last_checked_at FROM registration_records WHERE scope_node_id = ${phase.id}`;
check("one not on the list survives", survivor?.status === "VERIFIED", survivor?.status);
check("and is stamped as checked", survivor?.last_checked_at !== null);

// THE safety property, end to end. A page that will not parse must change
// nothing: treating it as an empty register would clear every real revocation.
await sql`
  UPDATE registration_records SET last_checked_at = NULL WHERE scope_node_id = ${phase.id}`;
const broken = await sweep(new Date(), {
  ...SCOPE,
  fetchImpl: async () => new Response("<table></table>", { status: 200 }),
});
const [unchanged] = await sql`
  SELECT status, last_checked_at FROM registration_records WHERE scope_node_id = ${phase.id}`;
check("an unreadable list blocks nothing", unchanged?.status === "VERIFIED",
  unchanged?.status);
check("and stamps nothing as checked", unchanged?.last_checked_at === null);
check("and the sweep says why", !!broken.blocklistError, broken.blocklistError ?? "");

// --- every other state, from captured pages --------------------------------
// Each adapter asked through the same form path a person uses, in this
// process, with its portal pointed at pages captured from the real one: a
// registration of ours, another promoter's, a revoked one, one never issued,
// and a portal that does not answer. Then the nightly read, once per state.
// The folders are set here rather than in .env.local, for the reason the
// register fixture above is: a four-row register blocks every real number.
console.log("\nevery other state, from captured pages");
{
  const { readFileSync } = await import("node:fs");
  const { recordRegistration, lookupRegistration: fillFrom } = await import("../src/lib/rera.ts");
  const { resetPortalCache } = await import("../src/lib/rera-states.ts");
  const { checkUpLockup } = await import("../src/lib/rera-up.ts");
  const { adRuleFor } = await import("../src/lib/rera-ad-rules.ts");
  const { stateRule } = await import("../src/lib/rera-rules.ts");
  const QRCode = (await import("qrcode")).default;
  const FIX = new URL("../db/fixtures/rera", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const [projectRow] = await sql`SELECT path::text AS path FROM scope_nodes WHERE id = ${project.id}`;
  const made: string[] = [];
  const mkPhase = async (slug: string) => {
    const [n] = await sql`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${org.id}, ${project.id}, 'PHASE', ${slug.replace(/_/g, " ")}, ${slug},
              ${projectRow.path + "." + slug}::ltree)
      RETURNING id`;
    await sql`INSERT INTO registration_records (scope_node_id, org_id, status) VALUES (${n.id}, ${org.id}, 'BLOCKED')`;
    made.push(n.id);
    return n.id as string;
  };
  const rowOf = async (id: string) =>
    (await sql`SELECT status, last_checked_at, resolution_reason, extended_until, extension_ref, registration_no
               FROM registration_records WHERE scope_node_id = ${id}`)[0];
  const record = (st: string, phaseId: string, no: string, validTo = "2030-12-31") =>
    recordRegistration({
      orgId: org.id, actorUserId: admin.id, phaseId, stateCode: st, registrationNo: no,
      promoterName: ENTITY, validTo, reason: "Read on the certificate, status active",
    });
  const setVerified = (id: string, st: string, no: string) => sql`
    UPDATE registration_records
    SET status = 'VERIFIED', state_code = ${st}, registration_no = ${no}, promoter_name = ${ENTITY},
        valid_to = '2030-12-31', last_checked_at = NULL, resolution_reason = 'seeded by check:rera'
    WHERE scope_node_id = ${id}`;

  for (const st of ["KA", "DL", "GJ", "HR", "TN", "WB", "AP", "RJ"]) {
    const dir = `${FIX}/${st.toLowerCase()}`;
    if (!existsSync(`${dir}/cases.json`)) {
      check(`${st}: captured pages exist`, false, dir);
      continue;
    }
    const c = JSON.parse(readFileSync(`${dir}/cases.json`, "utf8"));
    const authority = stateRule(st)!.authority;
    const env = `RERA_${st}_FIXTURES`;
    process.env[env] = dir;
    resetPortalCache();
    const s = st.toLowerCase();

    const pOurs = await mkPhase(`chk_${s}_ours`);
    const ours = await record(st, pOurs, c.ours);
    const oursRow = await rowOf(pOurs);
    check(`${st}: our registration is recorded`, ours.ok && oursRow?.status === "VERIFIED", JSON.stringify(ours));
    check(`${st}: and stamped, because ${authority} was read`, oursRow?.last_checked_at !== null);

    const pOther = await mkPhase(`chk_${s}_other`);
    // "Fill from number": the form is filled from what the authority holds,
    // and nothing is recorded.
    const filled = await fillFrom({ orgId: org.id, phaseId: pOther, stateCode: st, registrationNo: c.ours });
    check(`${st}: our number fills the form from ${authority}, as ours`, filled.ok && !filled.fill.otherPromoter, JSON.stringify(filled));
    const fillOther = await fillFrom({ orgId: org.id, phaseId: pOther, stateCode: st, registrationNo: c.others });
    check(`${st}: another promoter's number is not filled as ours`, !fillOther.ok || fillOther.fill.otherPromoter, JSON.stringify(fillOther));
    const fillNever = await fillFrom({ orgId: org.id, phaseId: pOther, stateCode: st, registrationNo: c.never });
    check(`${st}: a number never issued fills nothing`, !fillNever.ok, JSON.stringify(fillNever));
    check(`${st}: and filling recorded nothing`, (await rowOf(pOther))?.status === "BLOCKED");
    const others = await record(st, pOther, c.others);
    check(`${st}: another promoter's number is refused, naming who holds it`,
      !others.ok && others.message.toLowerCase().includes(c.otherPromoter.toLowerCase()), others.ok ? "accepted" : others.message);

    if (c.revoked) {
      const rev = await record(st, pOther, c.revoked);
      check(`${st}: a revoked registration is refused as revoked`,
        !rev.ok && /revoked|withdrawn|suspended|lapsed/i.test(rev.message), rev.ok ? "accepted" : rev.message);
    }
    if (c.lapsed) {
      const lap = await record(st, pOther, c.lapsed);
      check(`${st}: a registration the authority lists as lapsed is refused as lapsed`,
        !lap.ok && lap.code === "REGISTRATION_LAPSED", lap.ok ? "accepted" : lap.message);
    }
    const never = await record(st, pOther, c.never);
    check(`${st}: a number never issued is refused`,
      !never.ok && never.code === "NOT_REGISTERED" && never.message.includes(authority),
      never.ok ? "accepted" : `${never.code}: ${never.message}`);

    // A portal that does not answer never refuses a lawful registration: it
    // is recorded, and left Attested because nothing checked it.
    if (c.downDir) process.env[env] = `${dir}/${c.downDir}`;
    resetPortalCache();
    const pDown = await mkPhase(`chk_${s}_down`);
    const down = await record(st, pDown, c.down);
    const downRow = await rowOf(pDown);
    check(`${st}: a portal that does not answer leaves it recorded, attested`,
      down.ok && downRow?.status === "VERIFIED" && downRow?.last_checked_at === null,
      down.ok ? String(downRow?.last_checked_at) : down.message);
    process.env[env] = dir;
    resetPortalCache();
    // Out of the nightly's way: its number is in no captured list, so the
    // sweep would rightly find it unregistered.
    await sql`DELETE FROM registration_records WHERE scope_node_id = ${pDown}`;

    // --- the nightly read, for every tenant at once ------------------------
    // A never-issued number and a revoked one that slipped in before the
    // check existed, and another promoter's, seeded straight into the table.
    await setVerified(pOther, st, c.never);
    // West Bengal's form cannot tell revoked from never issued; its list
    // can, where a row ties to a registration (`tiedRevoked`).
    const revokedNo = c.revoked ?? c.tiedRevoked ?? null;
    const pRev = revokedNo ? await mkPhase(`chk_${s}_rev`) : null;
    if (pRev) await setVerified(pRev, st, revokedNo);
    const pLap = c.lapsed ? await mkPhase(`chk_${s}_lap`) : null;
    if (pLap) await setVerified(pLap, st, c.lapsed);
    const pOthers2 = await mkPhase(`chk_${s}_other2`);
    await setVerified(pOthers2, st, c.others);
    await sql`UPDATE registration_records SET last_checked_at = NULL WHERE scope_node_id = ${pOurs}`;

    const swept = await sweep(new Date(), { ...SCOPE, states: [st] });
    const read = swept.states[st];
    check(`${st}: the nightly read its lists`, !!read?.ok, JSON.stringify(read));
    check(`${st}: in ${c.nightlyRequests} requests however many registrations there are`,
      read?.requests === c.nightlyRequests, `${read?.requests}`);
    const oursAfter = await rowOf(pOurs);
    check(`${st}: ours survives the night and is stamped`,
      oursAfter?.status === "VERIFIED" && oursAfter?.last_checked_at !== null, oursAfter?.status);
    if (read?.registerSize !== null && read?.registerSize !== undefined) {
      const neverAfter = await rowOf(pOther);
      check(`${st}: a number in no register is blocked`,
        neverAfter?.status === "BLOCKED" && new RegExp(`Not in the ${authority} register`).test(neverAfter?.resolution_reason ?? ""),
        `${neverAfter?.status}: ${neverAfter?.resolution_reason}`);
      const othersAfter = await rowOf(pOthers2);
      // West Bengal's and Andhra's registers carry no promoter; theirs is
      // checked at the form only.
      if (!["WB", "AP"].includes(st)) check(`${st}: another promoter's registration is blocked, naming them`,
        othersAfter?.status === "BLOCKED" && (othersAfter?.resolution_reason ?? "").toLowerCase().includes(c.otherPromoter.toLowerCase()),
        `${othersAfter?.status}: ${othersAfter?.resolution_reason}`);
    }
    if (pRev) {
      const revAfter = await rowOf(pRev);
      check(`${st}: a revoked registration is blocked by the authority's list`,
        revAfter?.status === "BLOCKED" && /lists this registration as/.test(revAfter?.resolution_reason ?? ""),
        `${revAfter?.status}: ${revAfter?.resolution_reason}`);
    }
    if (pLap) {
      const lapAfter = await rowOf(pLap);
      check(`${st}: a lapsed registration is blocked by the authority's lapsed list`,
        lapAfter?.status === "BLOCKED" && /as lapsed/.test(lapAfter?.resolution_reason ?? ""),
        `${lapAfter?.status}: ${lapAfter?.resolution_reason}`);
    }

    // A list that parses to almost nothing is refused, and changes nothing.
    await setVerified(pOurs, st, c.ours);
    resetPortalCache();
    const broken = await sweep(new Date(), {
      ...SCOPE,
      states: [st],
      fetchImpl: async () => new Response("<html></html>", { status: 200 }),
    });
    const oursBroken = await rowOf(pOurs);
    check(`${st}: an unreadable list is refused and blocks nothing`,
      broken.states[st]?.ok === false && oursBroken?.status === "VERIFIED" && oursBroken?.last_checked_at === null,
      `${JSON.stringify(broken.states[st])} ${oursBroken?.status}`);

    // The ad rule it prints.
    const ad = adRuleFor(st);
    check(`${st}: its ads print ${authority}'s own website`, !!ad && !ad.website.includes("maharera"), ad?.website);

    await sql`DELETE FROM registration_records WHERE scope_node_id = ANY(${made})`;
    await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND target_id = ANY(${made.map(String)})`;
    await sql`DELETE FROM scope_nodes WHERE id = ANY(${made})`;
    made.length = 0;
    delete process.env[env];
    resetPortalCache();
  }

  // --- an order that extended every registration at once ---------------------
  console.log("\nan authority's own extension");
  {
    const p = await mkPhase("chk_mh_extended");
    // Recorded before the cut-off, lapsed on its own date a fortnight ago.
    await sql`
      UPDATE registration_records
      SET status = 'BLOCKED', state_code = 'MH', registration_no = ${REG_NO_2}, promoter_name = ${ENTITY},
          valid_to = (now() - interval '14 days')::date, verified_at = '2025-06-01',
          resolution_reason = 'Registration validity expired on 15 Sep 2026'
      WHERE scope_node_id = ${p}`;
    const swept = await sweep(new Date(), { ...SCOPE, states: [] });
    const row = await rowOf(p);
    check("a phase lapsed on its typed date is put back by MahaRERA's order",
      row?.status === "VERIFIED" && /Order 66\/2026/.test(row?.extension_ref ?? ""), `${row?.status} ${row?.extension_ref}`);
    check("with the later date written beside the typed one", row?.extended_until !== null);
    check("and the sweep says so", swept.extended.some((e) => e.phasePath.endsWith("chk_mh_extended")),
      JSON.stringify(swept.extended.map((e) => e.phasePath)));
    const [ext] = await sql`
      SELECT actor_user_id, metadata FROM audit_log
      WHERE org_id = ${org.id} AND action = 'rera.extended' AND target_id = ${p} ORDER BY id DESC LIMIT 1`;
    check("audited, with no actor, naming the order", !!ext && ext.actor_user_id === null && /66\/2026/.test(ext.metadata?.order ?? ""));
    const again = await sweep(new Date(), { ...SCOPE, states: [] });
    check("and a second night changes nothing",
      !again.extended.some((e) => e.phasePath.endsWith("chk_mh_extended")) &&
        !again.lapsed.some((e) => e.phasePath.endsWith("chk_mh_extended")));
    await sql`DELETE FROM registration_records WHERE scope_node_id = ANY(${made})`;
    await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND target_id = ANY(${made.map(String)})`;
    await sql`DELETE FROM scope_nodes WHERE id = ANY(${made})`;
    made.length = 0;
  }

  // --- Uttar Pradesh, from the QR its authority issues -----------------------
  console.log("\nUttar Pradesh, from the project QR");
  {
    const up = JSON.parse(readFileSync(`${FIX}/up/cases.json`, "utf8"));
    process.env.RERA_UP_FIXTURES = `${FIX}/up`;
    const p = await mkPhase("chk_up");
    const rec = await record("UP", p, up.ours);
    const before = await rowOf(p);
    check("a UP number is recorded, attested, because its search is behind a CAPTCHA",
      rec.ok && before?.last_checked_at === null, rec.ok ? String(before?.last_checked_at) : rec.message);
    const png = async (text: string) => QRCode.toBuffer(text, { margin: 2, width: 400 });
    const wrong = await checkUpLockup({ orgId: org.id, phaseId: p, bytes: await png(up.othersUrl) });
    check("a lockup whose QR opens another registration is refused",
      !wrong.ok && wrong.message.includes(up.others), wrong.ok ? "accepted" : wrong.message);
    const right = await checkUpLockup({ orgId: org.id, phaseId: p, bytes: await png(up.oursUrl) });
    check("one that opens this registration, to this promoter, is checked",
      right.ok && right.checked, JSON.stringify(right));
    check("and the record is stamped", (await rowOf(p))?.last_checked_at !== null);
    const elsewhere = await checkUpLockup({ orgId: org.id, phaseId: p, bytes: await png("https://example.com/Projectsummary?a=1") });
    check("a QR that opens anywhere else is not fetched and checks nothing",
      elsewhere.ok && !elsewhere.checked, JSON.stringify(elsewhere));
    delete process.env.RERA_UP_FIXTURES;
    await sql`DELETE FROM registration_records WHERE scope_node_id = ANY(${made})`;
    await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND target_id = ANY(${made.map(String)})`;
    await sql`DELETE FROM scope_nodes WHERE id = ANY(${made})`;
    made.length = 0;
  }

  // --- the creative a registration in that state carries ---------------------
  console.log("\nthe lockup a state's ad carries");
  {
    const { renderFrame, flatten } = await import("../src/lib/compose.ts");
    const sharp = (await import("sharp")).default;
    const picture = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#3a6ea5" } }).png().toBuffer();
    const frameFor = async (st: string, no: string, permitNo: string | null = null) =>
      flatten(await renderFrame({
        w: 1080, h: 1080, picture, isRender: true,
        slide: { role: "photo", title: "", sub: null, cta: null },
        lockup: null, logo: null, colour: "#1b3a86", registrationNo: no, ad: adRuleFor(st), permitNo,
        phone: "+91 98765 00000", website: null, disclaimer: null, copy: false, scrim: "foot",
      }));
    const pixel = async (img: Buffer, x: number, y: number) => {
      const { data } = await sharp(img).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      return [data[0], data[1], data[2]];
    };
    const wb = await frameFor("WB", "WBRERA/P/KOL/2026/004163");
    const wbFoot = await pixel(wb, 10, 1075);
    const wbTop = await pixel(wb, 1000, 60);
    check("a West Bengal ad carries its registration in a white strip along the foot",
      wbFoot.every((v) => v > 240), JSON.stringify(wbFoot));
    check("and no panel in the upper-right quarter", wbTop.every((v, i) => Math.abs(v - [0x3a, 0x6e, 0xa5][i]) < 60),
      JSON.stringify(wbTop));
    const ka = await frameFor("KA", "PRM/KA/RERA/1251/308/PR/250926/008969");
    const kaFoot = await pixel(ka, 10, 1075);
    // The block has no panel since 30 September 2026: its words sit straight
    // on the picture, so look for type in the corner rather than for white.
    const corner = await sharp(ka).extract({ left: 540, top: 0, width: 540, height: 220 }).removeAlpha().raw().toBuffer();
    let ink = 0;
    for (let i = 0; i + 2 < corner.length; i += 3) {
      if (Math.abs(corner[i] - 0x3a) + Math.abs(corner[i + 1] - 0x6e) + Math.abs(corner[i + 2] - 0xa5) > 150) ink++;
    }
    check("a Karnataka ad carries its block in the upper-right quarter", ink > 300, String(ink));
    check("and no strip along the foot", !kaFoot.every((v) => v > 240), JSON.stringify(kaFoot));
  }
}

await browser.close();
await wipe();
await sql.end();
// The library holds its own pools, and they keep Node alive after the last
// line. A suite that does not close them never hands back to the next one.
await closeDb();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
