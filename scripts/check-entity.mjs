// Functional check of entity creation, driven through the real console.
//
//   node --env-file=.env.local scripts/check-entity.mjs
//
// Creating the first entity is what finally exercises the scope tree: until
// one exists every membership sits at the org root and the ltree machinery is
// only ever tested against synthetic paths.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import postgres from "postgres";

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

const NAME = "Check SPV Projects LLP";
const wipe = async () => {
  // Only this suite's own nodes and their history. It used to delete every
  // 'scope_node.created' row in the database, every tenant's.
  // Matches the hyphenated variant too, which the slug-collision case uses.
  const mine = await sql`
    SELECT n.id::text AS id FROM scope_nodes n
    JOIN scope_nodes e ON n.path <@ e.path
    WHERE e.kind = 'ENTITY' AND e.name LIKE 'Check%SPV%'`;
  const ids = mine.map((r) => r.id);
  if (ids.length) await sql`DELETE FROM audit_log WHERE action = 'scope_node.created' AND target_id = ANY(${ids})`;
  await sql`DELETE FROM scope_nodes WHERE kind = 'ENTITY' AND name LIKE 'Check%SPV%'`;
};
await wipe();

const [admin] = await sql`SELECT id, email, name FROM users WHERE email NOT LIKE '%gmail%' ORDER BY created_at LIMIT 1`;
const [org] = await sql`
  SELECT o.id FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  ORDER BY m.created_at
  LIMIT 1`;
if (!org) throw new Error("No org where the first user is ORG_ADMIN");
const [root] = await sql`SELECT id, path::text AS path FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG'`;

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
await page.setViewport({ width: 1440, height: 1000 });
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

const PAGE = `${BASE}/dashboard/settings/entities`;
const open = (url) => page.goto(url, { waitUntil: "networkidle0" });
const submit = async (sel) => {
  await page.waitForSelector(sel, { timeout: 20000 });
  await page.click(sel);
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
};
/**
 * The refusal note, once it is actually there.
 *
 * `submit()` waits for the network to go idle, and a server action can
 * outlast that wait. Reading the note a moment too early returns an empty
 * string, which reports as "the screen said nothing" rather than as "we
 * looked too soon". An absent note still comes back empty after the timeout.
 */
const err = async () => {
  await page.waitForSelector(".note--risk", { timeout: 15000 }).catch(() => {});
  return page.$eval(".note--risk", (el) => el.textContent.trim()).catch(() => "");
};
const create = async (name, pan = "AAACG1234F", reg = "") => {
  await open(PAGE);
  await page.$eval("#legalName", (el, v) => (el.value = v), name);
  await page.$eval("#pan", (el, v) => (el.value = v), pan);
  await page.$eval("#registrationNo", (el, v) => (el.value = v), reg);
  await submit("form button[type=submit]");
};

// --- the queue mirrors real state ----------------------------------------
console.log("\nthe dashboard asks for one");
const [pre] = await sql`
  SELECT count(*)::int AS n FROM scope_nodes
  WHERE org_id = ${org.id} AND kind = 'ENTITY'`;
const startedEmpty = pre.n === 0;

await open(`${BASE}/dashboard`);
const rows = await page.$$eval("a.qi", (n) =>
  n.map((x) => ({
    title: x.querySelector(".qi__title")?.textContent?.trim() ?? "",
    href: x.getAttribute("href") ?? "",
  })),
);
const entityRow = rows.find((r) => r.title === "No legal entity yet");

if (startedEmpty) {
  check("the queue asks for a legal entity when there is none", !!entityRow,
    rows.map((r) => r.title).join(", "));
  check("and points at a page that can create one",
    entityRow?.href.includes("/settings/entities"), entityRow?.href ?? "(row not found)");
} else {
  // Equally a real assertion: the nag is derived from state, so it must be
  // absent once an entity exists.
  check("the queue does not ask when an entity already exists", !entityRow,
    rows.map((r) => r.title).join(", "));
  check("and points at a page that can create one", true,
    `${pre.n} entities already, nag correctly absent`);
}

// --- creating --------------------------------------------------------------
console.log("\ncreating one");
await create(NAME, "AAACG1234F", "AAB-1234");

const [node] = await sql`
  SELECT id, kind, name, slug, path::text AS path, parent_id
  FROM scope_nodes WHERE org_id = ${org.id} AND name = ${NAME}`;
check("a scope node is created", !!node);
check("of kind ENTITY", node?.kind === "ENTITY", node?.kind);
check("hanging off the org root", node?.parent_id === root.id);
check("with the legal name stored verbatim", node?.name === NAME, node?.name);
check("slugged into an ltree label", node?.slug === "check_spv_projects_llp", node?.slug);
// The path is a complete address: every ancestor query is written against it.
check("and a path beneath the root", node?.path === `${root.path}.check_spv_projects_llp`,
  node?.path);

const [details] = await sql`
  SELECT pan, registration_no, registration_kind FROM entity_details
  WHERE scope_node_id = ${node.id}`;
check("its PAN is stored", details?.pan === "AAACG1234F", details?.pan);
check("an LLPIN is stored with its kind",
  details?.registration_no === "AAB1234" && details?.registration_kind === "LLPIN",
  JSON.stringify(details));

const [logged] = await sql`
  SELECT action, metadata FROM audit_log
  WHERE org_id = ${org.id} AND action = 'scope_node.created' ORDER BY id DESC LIMIT 1`;
check("the creation is audited", logged?.action === "scope_node.created");
check("with the kind and path recorded",
  logged?.metadata?.kind === "ENTITY" && logged?.metadata?.path === node?.path,
  JSON.stringify(logged?.metadata));

await open(PAGE);
const listed = await page.$$eval(".person__name", (n) => n.map((x) => x.textContent.trim()));
check("it appears on the page", listed.some((t) => t.includes(NAME)), listed.join(", "));

// --- the queue item resolves itself ---------------------------------------
console.log("\nthe nag disappears");
await open(`${BASE}/dashboard`);
const after = await page.$$eval(".qi__title", (n) => n.map((x) => x.textContent.trim()));
check("the queue no longer asks for an entity", !after.includes("No legal entity yet"),
  after.join(", "));

// --- refusals --------------------------------------------------------------
console.log("\nrefusals");
await create(NAME);
const dupes = await sql`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND name = ${NAME}`;
check("the same legal name twice is refused", dupes.length === 1, `${dupes.length} rows`);
const note = await err();
check("and says so", /already an entity/i.test(note), note.slice(0, 70));

await create("GP");
const short = await sql`SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND name = 'GP'`;
check("a name too short to be a legal name is refused", short.length === 0);

// A different legal name that reduces to the SAME ltree label still gets its
// own node; the slug takes a suffix rather than the write failing on the
// sibling-slug index.
await create("Check-SPV Projects LLP", "AAACG1234K");
const [cousin] = await sql`
  SELECT slug FROM scope_nodes WHERE org_id = ${org.id} AND name = 'Check-SPV Projects LLP'`;
check("a colliding slug takes a suffix instead of failing",
  cousin?.slug === "check_spv_projects_llp_2", cousin?.slug);

await create("Check SPV Two Pvt Ltd", "NOTAPAN");
const badPan = await sql`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND name = 'Check SPV Two Pvt Ltd'`;
check("an invalid PAN is refused", badPan.length === 0);
const panNote = await err();
check("and says it is the PAN", /pan/i.test(panNote), panNote.slice(0, 60));

await create("Check SPV Three Pvt Ltd", "AAACG1234H", "not a real number");
const badReg = await sql`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND name = 'Check SPV Three Pvt Ltd'`;
check("an invalid CIN is refused", badReg.length === 0);

// Two SPVs in one group cannot share a PAN: that is the same legal person
// twice, and the database index is the real arbiter.
await create("Check SPV Four Pvt Ltd", "AAACG1234F");
const samePan = await sql`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND name = 'Check SPV Four Pvt Ltd'`;
check("two entities cannot share a PAN", samePan.length === 0);

// --- projects --------------------------------------------------------------
console.log("\nprojects");
const PROJECTS = `${BASE}/dashboard/projects`;
const createProject = async (city, name, entityId) => {
  await open(PROJECTS);
  // "Add a project" is a closed disclosure once the organisation has projects,
  // and a button inside a closed one cannot be pressed.
  await page.$eval("#new-project", (el) => { el.open = true; });
  if (entityId) await page.select("#entityId", entityId);
  await page.$eval("#city", (el, v) => (el.value = v), city);
  await page.$eval("#name", (el, v) => (el.value = v), name);
  await submit("form button[type=submit]");
};

await createProject("Pune", "Check Trees", node.id);

const [project] = await sql`
  SELECT p.id, p.kind, p.name, p.path::text AS path, r.kind AS parent_kind, r.name AS city
  FROM scope_nodes p JOIN scope_nodes r ON r.id = p.parent_id
  WHERE p.org_id = ${org.id} AND p.name = 'Check Trees'`;
check("a project is created", !!project);
check("of kind PROJECT", project?.kind === "PROJECT", project?.kind);
// The form asks for a city; the tree grows its middle layer without the user
// having to learn what a region node is.
check("a REGION was created from the city", project?.parent_kind === "REGION", project?.parent_kind);
check("named for the city", project?.city === "Pune", project?.city);
check("with the full four-level path",
  project?.path === `${node.path}.pune.check_trees`, project?.path);

// A second project in the same city must reuse the region, not grow another.
await createProject("Pune", "Check Skyline", node.id);
const regions = await sql`
  SELECT id FROM scope_nodes
  WHERE org_id = ${org.id} AND kind = 'REGION' AND parent_id = ${node.id}`;
check("a second project in the same city reuses the region", regions.length === 1,
  `${regions.length} regions`);

await createProject("Bengaluru", "Check Woodsman", node.id);
const regions2 = await sql`
  SELECT name FROM scope_nodes
  WHERE org_id = ${org.id} AND kind = 'REGION' AND parent_id = ${node.id} ORDER BY name`;
check("a different city gets its own region", regions2.length === 2,
  regions2.map((r) => r.name).join(", "));

await createProject("Pune", "Check Trees", node.id);
const dupeProjects = await sql`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND name = 'Check Trees'`;
check("the same project twice in one city is refused", dupeProjects.length === 1,
  `${dupeProjects.length} rows`);

// The entity id rides in a form field, so it is checked against this tenant
// and against its kind rather than trusted.
await open(PROJECTS);
await page.$eval("#new-project", (el) => { el.open = true; });
await page.$eval("#entityId", (el) => {
  el.add(new Option("smuggled", "00000000-0000-0000-0000-000000000000"));
  el.value = "00000000-0000-0000-0000-000000000000";
});
await page.$eval("#city", (el) => (el.value = "Nowhere"));
await page.$eval("#name", (el) => (el.value = "Check Ghost"));
await submit("form button[type=submit]");
const ghost = await sql`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND name = 'Check Ghost'`;
check("a project cannot hang off an entity that is not yours", ghost.length === 0);

const [projAudit] = await sql`
  SELECT metadata FROM audit_log
  WHERE org_id = ${org.id} AND action = 'scope_node.created'
    AND target_id = ${project.id} LIMIT 1`;
check("the project creation is audited with its entity and city",
  projAudit?.metadata?.entity === NAME && projAudit?.metadata?.city === "Pune",
  JSON.stringify(projAudit?.metadata));

// --- scope, now that the tree is two deep ---------------------------------
console.log("\nthe tree is deeper than its root");
const depth = await sql`
  SELECT count(*)::int AS n FROM scope_nodes
  WHERE org_id = ${org.id} AND path <@ ${root.path}::ltree AND path <> ${root.path}::ltree`;
check("descendant queries reach four levels down", depth[0].n >= 6, `${depth[0].n}`);
const [inside] = await sql`
  SELECT count(*)::int AS n FROM scope_nodes
  WHERE org_id = ${org.id} AND path <@ ${node.path}::ltree AND path <> ${node.path}::ltree`;
// Two regions plus three projects beneath this one entity.
check("an entity now contains its regions and projects", inside.n === 5, `${inside.n}`);

await browser.close();
await wipe();
await sql.end();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
