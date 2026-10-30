// Functional check of the invite flow, driven through the real console.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-invite.mts
//
// The admin half goes through the browser and the server actions. The
// acceptance half calls the real claimInvites(), loaded straight from source,
// because re-implementing its UPDATE in a test would only prove that two
// copies of the same statement agree with each other.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";
import { claimInvites, hasStandingAccess } from "../src/lib/invite-claim.ts";
import { closeDb } from "../src/lib/db/index.ts";

const BASE = process.env.AUTH_URL ?? "http://localhost:3000";
const COOKIE = "authjs.session-token";
const CHROME = [
  process.env.CHROME_PATH ?? "", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const INVITEE = "invite-check@example-tenant.test";
const OUTSIDER = "invite-outsider@gmail.com";
// The scoped section's own addresses, so nothing it writes below the root
// collides with the org-level invites above it.
const ON_SITE = "site-check@example-tenant.test";
const ON_BENCH = "bench-check@example-tenant.test";
const CRAFTED = "crafted-check@example-tenant.test";
const REGION_LEAD = "region-lead@example-tenant.test";
const LEAD_HIRE = "lead-hire@example-tenant.test";
const LEAD_REACH = "lead-overreach@example-tenant.test";
const LEAD_ASKER = "lead-asker@example-tenant.test";
const LEAD_CSV = "lead-csv@example-tenant.test";
// The import's own addresses, so its rows never collide with the single
// invite's and each section can be read on its own.
const BULK = [
  "bulk-one@example-tenant.test",
  "bulk-two@example-tenant.test",
  "bulk-three@example-tenant.test",
];
const BULK_ADMIN = "bulk-admin@gmail.com";
const HEIR = "heir-check@example-tenant.test";

const SCOPED = [ON_SITE, ON_BENCH, CRAFTED, REGION_LEAD, LEAD_HIRE, LEAD_REACH, LEAD_ASKER, LEAD_CSV];

const wipe = async () => {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM users
    WHERE email IN (${INVITEE}, ${OUTSIDER}, ${BULK_ADMIN}, ${HEIR})
       OR email = ANY(${BULK}) OR email = ANY(${SCOPED})`;
  for (const r of rows) {
    await sql`DELETE FROM audit_log WHERE actor_user_id = ${r.id} OR target_id = ${r.id}`;
    await sql`DELETE FROM memberships WHERE user_id = ${r.id}`;
    await sql`DELETE FROM org_join_requests WHERE user_id = ${r.id}`;
    await sql`DELETE FROM users WHERE id = ${r.id}`;
  }
};
await wipe();

const [admin] = await sql<{ id: string; email: string; name: string | null }[]>`
  SELECT id, email::text AS email, name FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql<{ id: string; display_name: string }[]>`
  SELECT o.id, o.display_name FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  ORDER BY m.created_at
  LIMIT 1`;
if (!org) throw new Error("No org where the first user is ORG_ADMIN");
// The organisation is a real one on a shared database: the cleanup below
// takes only the membership history this run wrote, not the tenant's own.
const STARTED = new Date();

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
    secret: process.env.AUTH_SECRET!,
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

const TEAM = `${BASE}/dashboard/team`;
const open = (url: string) => page.goto(url, { waitUntil: "networkidle0" });
const submit = async (selector: string) => {
  await page.waitForSelector(selector, { timeout: 20000 });
  await page.click(selector);
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
};
/**
 * A note on the screen, once it is actually there.
 *
 * `submit()` waits for the network to go idle, and a server action that talks
 * to SES can outlast that wait. Reading the note a moment too early returns an
 * empty string, which reads as "the screen said nothing" rather than as "we
 * looked too soon". Wait for it, then read it; an absent note still comes back
 * empty after the timeout, so a check that expects none still works.
 */
const noteOn = async (p: typeof page, selector = ".note--risk") => {
  await p.waitForSelector(selector, { timeout: 15000 }).catch(() => {});
  return p.$eval(selector, (el) => el.textContent!.trim()).catch(() => "");
};
const note = (selector?: string) => noteOn(page, selector);

/**
 * The query the redirect carried, once the redirect has happened.
 *
 * Importing sixty people writes them and then mails them, and a slow mailer
 * can outlast the network-idle wait in `submit()`. Reading the URL before the
 * action returns gives the pre-submit one, and its missing parameter reads as
 * "the screen reported nothing" rather than as "we looked too soon".
 */
const landed = async (key: string): Promise<URLSearchParams> => {
  await page
    .waitForFunction(
      (k: string) => new URL(location.href).searchParams.has(k),
      { timeout: 30000 },
      key,
    )
    .catch(() => {});
  return new URL(page.url()).searchParams;
};

const sendInvite = async (email: string, role?: string, nodeId?: string) => {
  await open(TEAM);
  await page.$eval("input[name=email]", (el, v) => ((el as HTMLInputElement).value = v), email);
  if (role) {
    // Injecting an option is the point: it posts a role the server never
    // offered, which is exactly what a crafted request would do.
    await page.$eval(
      "form.invite select[name=role]",
      (el, v) => {
        const sel = el as HTMLSelectElement;
        if (![...sel.options].some((o) => o.value === v)) {
          sel.add(new Option(v, v));
        }
        sel.value = v;
      },
      role,
    );
  }
  if (nodeId !== undefined) {
    // Same trick for the place. The control is a select when there is more
    // than one place and a hidden input when there is not, and a crafted
    // request would not care which: it posts the field either way.
    await page.evaluate((v: string) => {
      const form = document.querySelector("form.invite") as HTMLFormElement;
      const field = form.querySelector("[name=scopeNodeId]");
      if (field instanceof HTMLSelectElement) {
        if (![...field.options].some((o) => o.value === v)) field.add(new Option(v, v));
        field.value = v;
      } else if (field instanceof HTMLInputElement) {
        field.value = v;
      } else {
        const added = document.createElement("input");
        added.type = "hidden";
        added.name = "scopeNodeId";
        added.value = v;
        form.appendChild(added);
      }
    }, nodeId);
  }
  await submit("form.invite button[type=submit]");
};

/**
 * The picker as a person uses it: choose the role, read the places offered,
 * choose one of them. React owns both selects, so the native setter plus a
 * change event is what a click actually looks like from outside.
 */
const choose = async (roleKey: string, placeName?: string): Promise<string[]> => {
  await page.evaluate((role: string) => {
    const sel = document.querySelector(
      "form.invite select[name=role]") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype, "value")!.set!;
    setter.call(sel, role);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, roleKey);

  await new Promise((r) => setTimeout(r, 200));

  return page.evaluate((wanted: string | null) => {
    const sel = document.querySelector(
      "form.invite select[name=scopeNodeId]") as HTMLSelectElement | null;
    const offered = sel ? [...sel.options].map((o) => o.textContent!.trim()) : [];
    if (wanted && sel) {
      const opt = [...sel.options].find((o) => o.textContent!.trim() === wanted);
      if (opt) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype, "value")!.set!;
        setter.call(sel, opt.value);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return offered;
  }, placeName ?? null);
};

// --- sending -------------------------------------------------------------
console.log("\nsending an invite");
await sendInvite(INVITEE);

const [row] = await sql<
  { status: string; role: string; invited_by: string; accepted_at: Date | null; email: string }[]
>`
  SELECT m.status, m.role, m.invited_by, m.accepted_at, u.email::text AS email
  FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.org_id = ${org.id} AND u.email = ${INVITEE}`;
check("a membership is created", !!row);
check("it starts at INVITED, not ACTIVE", row?.status === "INVITED", row?.status);
check("nothing is accepted yet", row?.accepted_at === null);
check("the inviter is recorded", row?.invited_by === admin.id);

const [shell] = await sql<{ name: string | null; email_domain: string }[]>`
  SELECT name, email_domain::text AS email_domain FROM users WHERE email = ${INVITEE}`;
check("a shell user is created for an address nobody owns yet", !!shell);
check("the shell carries no name until they sign in", shell?.name === null, String(shell?.name));

const mailNote = await note();
// The invitee is an unverified address and SES is in the sandbox, so the send
// fails. The invite must still exist, and the screen must say what happened
// rather than swallowing it: an admin who is told nothing waits for an email
// that is never coming.
check("a failed send does not lose the invite", !!row);
check("and the screen says why it did not go out",
  /did not go out/i.test(mailNote), mailNote.slice(0, 90));

await open(TEAM);
const listed = await page.$$eval(".invited__mail", (n) => n.map((x) => x.textContent!.trim()));
check("the invite is listed as waiting", listed.includes(INVITEE), listed.join(", "));

const members = await page.$$eval(".person__mail", (n) => n.map((x) => x.textContent!.trim()));
check("an invited person is NOT counted as a member", !members.includes(INVITEE),
  members.join(", "));

// --- gates ---------------------------------------------------------------
console.log("\nthe gates hold against a crafted request");
// SITE_TEAM belongs to a PHASE. Posting it without moving the place off the
// root is what a crafted request looks like, and the depth rule refuses it
// however deep the tree happens to be.
await sendInvite("someone-else@example-tenant.test", "SITE_TEAM");
const tooDeep = await sql`
  SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.org_id = ${org.id} AND u.email = 'someone-else@example-tenant.test'`;
check("a role with no node to attach to is refused", tooDeep.length === 0);
const deepNote = await note();
check("and the refusal explains why", deepNote.toLowerCase().includes("phase"), deepNote.slice(0, 70));

await sendInvite(OUTSIDER, "SALES_HEAD");
const [gmail] = await sql`
  SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.org_id = ${org.id} AND u.email = ${OUTSIDER}`;
check("a personal address is allowed for an ordinary role", !!gmail, "refused");
const warn = await note(".note--address");
check("and the consequence is spelled out", warn.toLowerCase().includes("personal"), warn.slice(0, 70));

await sendInvite(admin.email!);
const already = await note();
check("inviting someone already on the team is refused",
  already.toLowerCase().includes("already on the team"), already.slice(0, 70));

// --- inviting below the root ----------------------------------------------
//
// A membership can sit at any node, and now an invite can put one there. The
// eight roles whose minKind is REGION or deeper were unreachable until this,
// so both halves are checked: the picker offering the right places, and the
// server refusing a node the picker never offered.
console.log("\ninviting below the organisation root");

type Node = { id: string; kind: string; name: string; path: string };
const tree = await sql<Node[]>`
  SELECT id, kind, name, path::text AS path FROM scope_nodes
  WHERE org_id = ${org.id} ORDER BY path`;
const nodeOf = (kind: string) => tree.find((n) => n.kind === kind);
const root = nodeOf("ORG")!;
const entity = nodeOf("ENTITY")!;
const region = nodeOf("REGION")!;
const project = nodeOf("PROJECT")!;
const phase = nodeOf("PHASE")!;

check("the tenant has a tree to invite into",
  Boolean(root && entity && region && project && phase),
  tree.map((n) => n.kind).join(" "));

const membershipAt = async (email: string) =>
  (
    await sql<{ role: string; scope_node_id: string; status: string; path: string }[]>`
      SELECT m.role, m.scope_node_id, m.status, s.path::text AS path
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      JOIN scope_nodes s ON s.id = m.scope_node_id
      WHERE m.org_id = ${org.id} AND u.email = ${email} AND m.status <> 'REVOKED'`
  );

// A PHASE role, through the picker rather than around it.
await open(TEAM);
const sitePlaces = await choose("SITE_TEAM", phase.name);
check("choosing a phase role narrows the places to phases",
  sitePlaces, [phase.name]);
check("so the region is not offered for it",
  !sitePlaces.includes(region.name), sitePlaces.join(", "));
await page.$eval("input[name=email]",
  (el, v) => ((el as HTMLInputElement).value = v), ON_SITE);
await submit("form.invite button[type=submit]");

const sited = await membershipAt(ON_SITE);
check("a phase-level role is granted", sited.length === 1, `${sited.length} rows`);
check("with the role that was picked", sited[0]?.role === "SITE_TEAM", sited[0]?.role);
check("at the phase, not the root",
  sited[0]?.scope_node_id === phase.id, sited[0]?.path);
check("and it waits like any other invite",
  sited[0]?.status === "INVITED", sited[0]?.status);

// A REGION role, the same way.
await open(TEAM);
const benchPlaces = await choose("PRESALES_MANAGER", region.name);
check("a region role offers the region and everything under it",
  benchPlaces.includes(region.name) && benchPlaces.includes(project.name), benchPlaces.join(", "));
check("but never the organisation above it",
  !benchPlaces.includes(root.name), benchPlaces.join(", "));
await page.$eval("input[name=email]",
  (el, v) => ((el as HTMLInputElement).value = v), ON_BENCH);
await submit("form.invite button[type=submit]");

const benched = await membershipAt(ON_BENCH);
check("a region-level role is granted", benched.length === 1, `${benched.length} rows`);
check("at the region", benched[0]?.scope_node_id === region.id, benched[0]?.path);
check("with the role that was picked",
  benched[0]?.role === "PRESALES_MANAGER", benched[0]?.role);

await open(TEAM);
const placed = await page.$$eval(".invited", (rows) =>
  rows.map((r) => ({
    mail: r.querySelector(".invited__mail")?.textContent?.trim() ?? "",
    pills: [...r.querySelectorAll(".invited__role .pill")].map((p) => p.textContent!.trim()),
  })));
check("the waiting list says where each one lands",
  placed.find((p) => p.mail === ON_SITE)?.pills.includes(phase.name),
  JSON.stringify(placed.find((p) => p.mail === ON_SITE)?.pills ?? []));

// --- a crafted node id ----------------------------------------------------
console.log("\na node id from the form is never believed");

// Deep enough a role, wrong kind of node. The picker did not offer this pair.
await sendInvite(CRAFTED, "SITE_TEAM", region.id);
check("a phase role posted at a region is refused",
  (await membershipAt(CRAFTED)).length === 0);
const pairNote = await note();
check("and the refusal names the level",
  /phase/i.test(pairNote), pairNote.slice(0, 80));

// A node in somebody else's tenant. It exists, and it is none of this org's
// business, so the read inside the tenant returns nothing at all.
// Idempotent for the same reason the auditor in check-rbac is: a run that
// fails partway leaves this behind, and the next one should fail on the bug
// rather than on a duplicate path.
await sql`DELETE FROM orgs WHERE primary_domain = 'rival-check.test'`;
const [rival] = await sql<{ id: string }[]>`
  INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain)
  VALUES ('DEVELOPER', 'Rival Developers Private Limited', 'Rival',
          'AAACR1111R', 'rival-check.test')
  RETURNING id`;
const [rivalNode] = await sql<{ id: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${rival.id}, NULL, 'ORG', 'Rival', 'rival_check', 'rival_check'::ltree)
  RETURNING id`;

await sendInvite(CRAFTED, "SALES_HEAD", rivalNode.id);
check("a node belonging to another tenant is refused",
  (await membershipAt(CRAFTED)).length === 0);
const foreignNote = await note();
check("and says it is not a place here",
  /not a place in this organisation/i.test(foreignNote), foreignNote.slice(0, 80));

// A uuid that names nothing, and a string that is not a uuid at all. The
// second matters: it reaches a uuid comparison, and Postgres raises on it
// rather than returning no rows.
await sendInvite(CRAFTED, "SALES_HEAD", "00000000-0000-4000-8000-000000000000");
check("a uuid naming nothing is refused", (await membershipAt(CRAFTED)).length === 0);
await sendInvite(CRAFTED, "SALES_HEAD", "' OR 1=1 --");
check("and so is something that is not a uuid",
  (await membershipAt(CRAFTED)).length === 0);
const junkNote = await note();
check("refused as a refusal, not as a crash",
  /not a place in this organisation/i.test(junkNote), junkNote.slice(0, 80));

// --- delegation within your own part of the org ---------------------------
//
// Until an invite could name a node, "you may add people inside your own
// subtree" had nothing to be tested against: every inviter held the root.
console.log("\ndelegating inside your own subtree");

// A second region, so there is somewhere for the region lead to overreach to.
await sql`DELETE FROM scope_nodes WHERE path = ${`${entity.path}.pune_check`}::ltree`;
const [pune] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${entity.id}, 'REGION', 'Pune Check', 'pune_check',
          ${`${entity.path}.pune_check`}::ltree)
  RETURNING id, path::text AS path`;

// A role this tenant invented, holding the power to add people and nothing
// else. Code checks the permission; the key is only a name.
await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = 'C_REGION_LEAD'`;
await sql`
  INSERT INTO org_roles (org_id, key, label, description, min_kind, can_delegate,
                         source, permissions)
  VALUES (${org.id}, 'C_REGION_LEAD', 'Region Lead', 'Adds people in one region.',
          'REGION', true, 'CUSTOM', ${["member:read", "member:invite"]})`;

const [lead] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name)
  VALUES (${REGION_LEAD}, 'example-tenant.test', 'Region Lead')
  RETURNING id`;
await sql`
  INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
  VALUES (${lead.id}, ${org.id}, ${region.id}, 'C_REGION_LEAD', 'ACTIVE', now())`;

const leadCtx = await browser.createBrowserContext();
const leadPage = await leadCtx.newPage();
leadPage.setDefaultNavigationTimeout(90000);
await leadPage.setViewport({ width: 1440, height: 1000 });
await leadPage.setCookie({
  name: COOKIE,
  value: await encode({
    token: { sub: lead.id, userId: lead.id, email: REGION_LEAD, name: "Region Lead" },
    secret: process.env.AUTH_SECRET!,
    salt: COOKIE,
    maxAge: 900,
  }),
  domain: "localhost",
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
});
// The organisation this suite seeded, not whichever one the account opens first.
await leadPage.setCookie({ name: "salesdesk.org", value: org.id, domain: "localhost", path: "/", sameSite: "Lax" });
await leadPage.goto(TEAM, { waitUntil: "networkidle0" });

const leadPlaces = await leadPage.$$eval(
  "form.invite select[name=scopeNodeId] option",
  (os) => os.map((o) => o.textContent!.trim()));
check("a region lead is offered their own region",
  leadPlaces.includes(region.name), leadPlaces.join(", "));
check("and nothing above it", !leadPlaces.includes(root.name), leadPlaces.join(", "));
check("and nothing beside it",
  !leadPlaces.includes("Pune Check"), leadPlaces.join(", "));

const leadSends = async (email: string, nodeId?: string, role?: string) => {
  await leadPage.goto(TEAM, { waitUntil: "networkidle0" });
  await leadPage.$eval("input[name=email]",
    (el, v) => ((el as HTMLInputElement).value = v), email);
  if (role) {
    // A crafted post: the picker never offered it, so it is added by hand.
    await leadPage.evaluate((v: string) => {
      const field = document.querySelector("form.invite select[name=role]") as HTMLSelectElement;
      if (![...field.options].some((o) => o.value === v)) field.add(new Option(v, v));
      field.value = v;
    }, role);
  }
  if (nodeId) {
    await leadPage.evaluate((v: string) => {
      const form = document.querySelector("form.invite") as HTMLFormElement;
      const field = form.querySelector("[name=scopeNodeId]");
      if (field instanceof HTMLSelectElement) {
        if (![...field.options].some((o) => o.value === v)) field.add(new Option(v, v));
        field.value = v;
      } else if (field instanceof HTMLInputElement) {
        field.value = v;
      }
    }, nodeId);
  }
  await leadPage.click("form.invite button[type=submit]");
  await leadPage.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
};

await leadSends(LEAD_HIRE, project.id);
const hired = await membershipAt(LEAD_HIRE);
check("a region lead may add somebody inside their region",
  hired.length === 1, `${hired.length} rows`);
check("at the node they chose",
  hired[0]?.scope_node_id === project.id, hired[0]?.path);
check("recorded as invited by them",
  (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE u.email = ${LEAD_HIRE} AND m.invited_by = ${lead.id}`)[0].n === 1);

// The whole point of the rule. The node is real, in the same tenant, and not
// theirs, so the read finds it and containment refuses it.
await leadSends(LEAD_REACH, pune.id);
check("but not into a region that is not theirs",
  (await membershipAt(LEAD_REACH)).length === 0);
const reachNote = await noteOn(leadPage);
check("and is told it is outside their part of the organisation",
  /own part of the organisation/i.test(reachNote), reachNote.slice(0, 90));

// Rank does not weaken with depth either: a delegate cannot mint an admin.
await leadSends(LEAD_REACH, region.id);
// Read from a page that has finished arriving: an empty list would pass the
// "not offered" checks for the wrong reason.
await leadPage.goto(TEAM, { waitUntil: "networkidle0" });
await leadPage.waitForSelector("form.invite select[name=role] option", { timeout: 20000 });
const leadRoles = await leadPage.$$eval("form.invite select[name=role] option",
  (os) => os.map((o) => o.value));
check("a delegate without the founding role is not offered it",
  !leadRoles.includes("ORG_ADMIN"), leadRoles.join(", "));

// --- the subset rule -------------------------------------------------------
//
// Rank only ever stopped an admin being minted. The lead holds member:invite
// and member:read and nothing else, so every role carrying more is theirs to
// see on the team page and not theirs to give.
console.log("\nonly what you hold, where you hold it");
check("a delegate is not offered a role carrying access they lack",
  !leadRoles.includes("PROJECT_SALES_MANAGER") && !leadRoles.includes("SALES_HEAD"), leadRoles.join(", "));
check("but is offered one they hold all of",
  leadRoles.includes("C_REGION_LEAD"), leadRoles.join(", "));

await leadSends(LEAD_REACH, project.id, "PROJECT_SALES_MANAGER");
check("a crafted post of a role they lack is refused",
  !(await membershipAt(LEAD_REACH)).some((m) => m.role === "PROJECT_SALES_MANAGER"));
const subsetNote = await noteOn(leadPage);
check("and names the access they do not have",
  /Project Sales Manager includes access you do not have.*See leads/i.test(subsetNote), subsetNote.slice(0, 120));

// A join request answered with the same role, posted by hand.
await sql`DELETE FROM users WHERE email = ${LEAD_ASKER}`;
const [asker] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name)
  VALUES (${LEAD_ASKER}, 'example-tenant.test', 'Lead Asker') RETURNING id`;
await sql`
  INSERT INTO org_join_requests (org_id, user_id, matched_on)
  VALUES (${org.id}, ${asker.id}, 'EMAIL_DOMAIN')`;
await leadPage.goto(TEAM, { waitUntil: "networkidle0" });
await leadPage.evaluate((nodeId: string) => {
  const form = [...document.querySelectorAll("form")]
    .find((f) => f.querySelector("input[name=requestId]")) as HTMLFormElement;
  const role = form.querySelector("select[name=role]") as HTMLSelectElement;
  role.add(new Option("PROJECT_SALES_MANAGER", "PROJECT_SALES_MANAGER"));
  role.value = "PROJECT_SALES_MANAGER";
  const node = form.querySelector("[name=scopeNodeId]") as HTMLSelectElement | HTMLInputElement;
  if (node instanceof HTMLSelectElement && ![...node.options].some((o) => o.value === nodeId)) {
    node.add(new Option(nodeId, nodeId));
  }
  node.value = nodeId;
  (form.querySelector("button[type=submit]") as HTMLButtonElement).click();
}, project.id);
await leadPage.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
check("approving a join request with a role they lack is refused",
  (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM memberships WHERE user_id = ${asker.id}`)[0].n === 0);
check("and the request is still waiting",
  (await sql<{ status: string }[]>`
    SELECT status FROM org_join_requests WHERE user_id = ${asker.id}`)[0]?.status === "PENDING");
const joinNote = await noteOn(leadPage);
check("with the same refusal", /includes access you do not have/i.test(joinNote), joinNote.slice(0, 90));
await sql`DELETE FROM org_join_requests WHERE user_id = ${asker.id}`;

// A list naming the same role. The preview is the same function the server
// runs, so the row is refused before anything can be sent.
await leadPage.goto(TEAM, { waitUntil: "networkidle0" });
await leadPage.evaluate(() => {
  const b = [...document.querySelectorAll("button")]
    .find((x) => /Add several at once/i.test(x.textContent ?? ""));
  b?.click();
});
await leadPage.waitForSelector("textarea.import__text", { timeout: 15000 });
await leadPage.evaluate((v: string) => {
  const ta = document.querySelector("textarea.import__text") as HTMLTextAreaElement;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  set.call(ta, v);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}, `email,role,scope\n${LEAD_CSV},Project Sales Manager,${project.path}`);
await leadPage.waitForFunction(
  () => /includes access you do not have/i.test(document.body.textContent ?? ""),
  { timeout: 15000 },
).catch(() => {});
const csvShown = await leadPage.evaluate(() => document.body.textContent ?? "");
check("a list row naming a role they lack is refused in the preview",
  /Project Sales Manager.*includes access you do not have/i.test(csvShown));
check("and there is nothing to send",
  (await leadPage.$eval(".import__go button[type=submit]", (b) => (b as HTMLButtonElement).disabled).catch(() => true)) === true);
check("so nothing was written", (await membershipAt(LEAD_CSV)).length === 0);

await leadCtx.close();

await sql`DELETE FROM memberships m USING users u
          WHERE m.user_id = u.id AND u.email = ANY(${SCOPED})`;
await sql`DELETE FROM users WHERE email = ANY(${SCOPED})`;
await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = 'C_REGION_LEAD'`;
await sql`DELETE FROM scope_nodes WHERE id = ${pune.id}`;
await sql`DELETE FROM scope_nodes WHERE id = ${rivalNode.id}`;
await sql`DELETE FROM orgs WHERE id = ${rival.id}`;

// --- re-inviting ----------------------------------------------------------
console.log("\nre-inviting changes the role, it does not add a row");
await sendInvite(INVITEE, "MARKETING_HEAD");
const again = await sql<{ role: string }[]>`
  SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.org_id = ${org.id} AND u.email = ${INVITEE} AND m.status <> 'REVOKED'`;
check("still exactly one membership", again.length === 1, `${again.length} rows`);
check("with the new role", again[0]?.role === "MARKETING_HEAD", again[0]?.role);

// --- acceptance -----------------------------------------------------------
console.log("\nacceptance, through the real sign-in path");
const [invitee] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${INVITEE}`;

check("an invited address has standing access", await hasStandingAccess(INVITEE), "refused");
check("an address with no invite does not",
  (await hasStandingAccess("nobody-at-all@example-tenant.test")) === false);

const claimed = await claimInvites(invitee.id);
check("claiming reports what it claimed", claimed === 1, String(claimed));

const [live] = await sql<{ status: string; role: string; accepted_at: Date | null }[]>`
  SELECT status, role, accepted_at FROM memberships
  WHERE org_id = ${org.id} AND user_id = ${invitee.id}`;
check("the membership is now ACTIVE", live?.status === "ACTIVE", live?.status);
check("and stamped with when", live?.accepted_at !== null);
check("the role the admin chose is the role granted", live?.role === "MARKETING_HEAD", live?.role);

const [accepted] = await sql<{ action: string }[]>`
  SELECT action FROM audit_log
  WHERE org_id = ${org.id} AND action = 'membership.accepted' ORDER BY id DESC LIMIT 1`;
check("acceptance is audited", accepted?.action === "membership.accepted");

check("claiming twice is a no-op", (await claimInvites(invitee.id)) === 0);

// The invitee now has a console of their own, with the role they were given.
const inviteeCtx = await browser.createBrowserContext();
const inviteePage = await inviteeCtx.newPage();
await inviteePage.setViewport({ width: 1440, height: 1000 });
await inviteePage.setCookie({
  name: COOKIE,
  value: await encode({
    token: { sub: invitee.id, userId: invitee.id, email: INVITEE, name: null },
    secret: process.env.AUTH_SECRET!,
    salt: COOKIE,
    maxAge: 900,
  }),
  domain: "localhost",
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
});
// The organisation this suite seeded, not whichever one the account opens first.
await inviteePage.setCookie({ name: "salesdesk.org", value: org.id, domain: "localhost", path: "/", sameSite: "Lax" });
await inviteePage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
check("the invitee lands in the console, not onboarding",
  inviteePage.url().includes("/dashboard"), inviteePage.url());
const rail = await inviteePage.$$eval(".nav__text", (n) => n.map((x) => x.textContent!.trim()));
check("with the rail their role earns",
  rail.includes("Campaigns") && !rail.includes("Site visits"), rail.join(", "));
await inviteeCtx.close();

await open(TEAM);
const nowMembers = await page.$$eval(".person__mail", (n) => n.map((x) => x.textContent!.trim()));
check("and they now appear as a member", nowMembers.includes(INVITEE), nowMembers.join(", "));

// --- withdrawing ----------------------------------------------------------
console.log("\nwithdrawing");
const before = await page.$$eval(".invited__mail", (n) => n.map((x) => x.textContent!.trim()));
check("the personal-address invite is still waiting", before.includes(OUTSIDER), before.join(", "));
// Withdrawing asks first, and the dialog's own button does it.
await submit('.invited [data-confirm="withdraw-invite"]');
await submit('dialog[open] [data-confirmed="withdraw-invite"]');
await open(TEAM);
const after = await page.$$eval(".invited__mail", (n) => n.map((x) => x.textContent!.trim()))
  .catch(() => [] as string[]);
check("withdrawing removes it from the list", !after.includes(after[0] ?? "") || after.length < before.length,
  after.join(", "));
const [revoked] = await sql<{ status: string }[]>`
  SELECT m.status FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.org_id = ${org.id} AND u.email = ${before[0]}`;
check("the row is REVOKED, not deleted", revoked?.status === "REVOKED", revoked?.status);

// --- importing a list -----------------------------------------------------
console.log("\nimporting a list of people");

const paste = async (text: string, defaultRole = "SALES_HEAD") => {
  await open(TEAM);
  // Open the card, then drive the real textarea. React owns its value, so the
  // native setter plus an input event is what a person typing looks like.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find((x) => /Add several at once/i.test(x.textContent ?? ""));
    b?.click();
  });
  await page.waitForSelector("textarea.import__text", { timeout: 15000 });
  await page.evaluate((v: string, role: string) => {
    const ta = document.querySelector("textarea.import__text") as HTMLTextAreaElement;
    const set = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(ta, v);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const sel = document.querySelector("#importDefaultRole") as HTMLSelectElement;
    if (sel) {
      const setV = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype, "value")!.set!;
      setV.call(sel, role);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, text, defaultRole);
  await new Promise((r) => setTimeout(r, 250));
};

const importList = async (text: string, defaultRole = "SALES_HEAD") => {
  await paste(text, defaultRole);
  await submit(".import__go button[type=submit]");
};

// A file that exercises every verdict at once: two good rows, one with no
// role, a duplicate, a malformed address, and an admin on a personal mailbox.
await importList([
  "email,name,role",
  `${BULK[0]},Bulk One,Sales Head`,
  `${BULK[1]},Bulk Two,`,
  `${BULK[0]},a copy,Sales Head`,
  "not-an-address,,Sales Head",
  `${BULK_ADMIN},,Org Admin`,
].join("\n"));

const imported = await sql<{ email: string; role: string; status: string }[]>`
  SELECT u.email::text AS email, m.role, m.status
  FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.org_id = ${org.id} AND u.email = ANY(${BULK})
  ORDER BY u.email`;
check("the good rows are written", imported.length === 2, `${imported.length}`);
check("with the role the file named",
  imported.find((r) => r.email === BULK[0])?.role === "SALES_HEAD",
  imported.find((r) => r.email === BULK[0])?.role);
check("and the default where it named none",
  imported.find((r) => r.email === BULK[1])?.role === "SALES_HEAD",
  imported.find((r) => r.email === BULK[1])?.role);
check("every one of them lands INVITED, not ACTIVE",
  imported.every((r) => r.status === "INVITED"));

// The refused rows are the point of the preview. None of them may be written,
// and an admin on a personal mailbox is the one that matters: it is the gate
// a bulk path would be most tempting to skip.
// The rows are judged by the dev server, and ENVIRONMENT=development there
// lifts the work-account bar (personalAccountsAllowed()), so the personal
// mailbox is written in development and refused in production. This process
// runs under scripts/checks.env, which says nothing about the server's mode.
const SERVER_DEV = (() => {
  try {
    return /^\s*ENVIRONMENT\s*=\s*"?development/m.test(readFileSync(".env.local", "utf8"));
  } catch {
    return false;
  }
})();
const WANT_WRITTEN = SERVER_DEV ? 3 : 2;
const [refusedAdmin] = await sql`
  SELECT id FROM users WHERE email = ${BULK_ADMIN}`;
if (SERVER_DEV) {
  check("an admin on a personal mailbox is written while the server runs in development", !!refusedAdmin);
} else {
  check("an admin on a personal mailbox is not written", !refusedAdmin);
}

const counts = await landed("imported");
check("the screen reports what was written", counts.get("imported") === String(WANT_WRITTEN),
  counts.get("imported") ?? "");
check("and what was refused", Number(counts.get("refused")) >= (SERVER_DEV ? 2 : 3),
  counts.get("refused") ?? "");

// One entry for the act, and one per person, tied together.
const [batch] = await sql<{ target_id: string; metadata: Record<string, unknown> }[]>`
  SELECT target_id, metadata FROM audit_log
  WHERE org_id = ${org.id} AND action = 'membership.imported'
  ORDER BY id DESC LIMIT 1`;
check("the import is audited as one act", !!batch);
check("carrying the counts", batch?.metadata?.written === WANT_WRITTEN,
  JSON.stringify(batch?.metadata));
const perPerson = await sql<{ metadata: Record<string, unknown> }[]>`
  SELECT metadata FROM audit_log
  WHERE org_id = ${org.id} AND action = 'membership.invited'
    AND metadata->>'batch_id' = ${batch?.target_id ?? ""}`;
check("and each person tied to that batch", perPerson.length === WANT_WRITTEN,
  `${perPerson.length}`);

// Running the same file again must add nobody. The rows are already invited,
// so this is the ordinary case of somebody clicking twice.
await importList([
  "email,role",
  `${BULK[0]},Sales Head`,
  `${BULK[1]},Sales Head`,
].join("\n"));
const afterTwice = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.org_id = ${org.id} AND u.email = ANY(${BULK})`;
check("importing the same list twice adds nobody", afterTwice[0]?.n === 2,
  `${afterTwice[0]?.n}`);

// A file over the batch limit is refused before anything can be clicked.
// There is deliberately no disabled-but-present button: a fatal file has no
// action, so the screen offers none. The server keeps its own limit for a
// request that never came from this screen.
const sizeBefore = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM memberships WHERE org_id = ${org.id}`;
await paste(
  ["email"].concat(
    Array.from({ length: 501 }, (_, i) => `over-${i}@example-tenant.test`),
  ).join("\n"),
);
const fatal = await note();
check("a file over the limit says so",
  /more than one batch|larger than/i.test(fatal), fatal.slice(0, 70));
check("and offers nothing to submit",
  (await page.$(".import__go button[type=submit]")) === null);
const sizeAfter = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM memberships WHERE org_id = ${org.id}`;
check("so nobody is written", sizeAfter[0]?.n === sizeBefore[0]?.n,
  `${sizeBefore[0]?.n} -> ${sizeAfter[0]?.n}`);

// --- moving the founding role ---------------------------------------------
console.log("\nhanding over the admin role");

const adminCount = async () =>
  (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM memberships
    WHERE org_id = ${org.id} AND role = 'ORG_ADMIN' AND status = 'ACTIVE'`)[0].n;

check("the tenant starts with one admin", (await adminCount()) === 1,
  `${await adminCount()}`);

// The database refuses to leave an org with none. This is the invariant the
// whole feature rests on, so it is checked against the database directly
// rather than through a screen that could simply be hiding the button.
const [onlyAdmin] = await sql<{ id: string }[]>`
  SELECT m.id FROM memberships m
  WHERE m.org_id = ${org.id} AND m.role = 'ORG_ADMIN' AND m.status = 'ACTIVE' LIMIT 1`;
//
// The constraint is DEFERRED, so the refusal arrives at COMMIT rather than at
// the statement. That has a sharp edge worth knowing: a bare autocommit
// statement reports rows affected and is then rolled back without the client
// being told, so it looks like it worked. Only an explicit transaction
// surfaces the error, which is why every write in the application goes
// through withTenant() and none of them go through a loose query.
const tryWrite = async (fn: (tx: typeof sql) => Promise<unknown>) => {
  try {
    await sql.begin(fn as never);
    return false;
  } catch {
    return true;
  }
};

check(
  "the database refuses to demote the last admin",
  await tryWrite((tx) => tx`UPDATE memberships SET role = 'SALES_HEAD' WHERE id = ${onlyAdmin.id}`),
);
check(
  "and refuses to revoke them",
  await tryWrite((tx) => tx`UPDATE memberships SET status = 'REVOKED' WHERE id = ${onlyAdmin.id}`),
);
check(
  "and refuses to delete them outright",
  await tryWrite((tx) => tx`DELETE FROM memberships WHERE id = ${onlyAdmin.id}`),
);
check("so the org still has its admin", (await adminCount()) === 1);

// Even the silent form changes nothing. The write is rolled back either way;
// the only difference is whether anybody hears about it.
await sql`UPDATE memberships SET role = 'SALES_HEAD' WHERE id = ${onlyAdmin.id}`.catch(
  () => undefined,
);
check("a loose statement cannot orphan the tenant either",
  (await adminCount()) === 1, `${await adminCount()}`);
const [stillAdmin] = await sql<{ role: string; status: string }[]>`
  SELECT role, status FROM memberships WHERE id = ${onlyAdmin.id}`;
check("and the row is untouched",
  stillAdmin?.role === "ORG_ADMIN" && stillAdmin?.status === "ACTIVE",
  `${stillAdmin?.role} ${stillAdmin?.status}`);

// A second admin, then a transfer. Seeded directly: this section is about the
// role moving, and the invite path above already covers getting somebody in.
const [heirUser] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name)
  VALUES (${HEIR}, 'example-tenant.test', 'Heir Apparent')
  RETURNING id`;
const [rootNode] = await sql<{ id: string }[]>`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG' LIMIT 1`;
const [heirM] = await sql<{ id: string }[]>`
  INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
  VALUES (${heirUser.id}, ${org.id}, ${rootNode.id}, 'SALES_HEAD', 'ACTIVE', now())
  RETURNING id`;

await open(TEAM);
const promoteBtn = await page.$$eval(".person button", (bs) =>
  bs.some((b) => /Make admin/i.test(b.textContent ?? "")));
check("the screen offers to make somebody an admin", promoteBtn);

// Demote-then-promote in one transaction: the awkward order, which only works
// because the constraint is deferred to commit.
let transferred = false;
try {
  await sql.begin(async (tx) => {
    await tx`UPDATE memberships SET role = 'SALES_HEAD' WHERE id = ${onlyAdmin.id}`;
    await tx`UPDATE memberships SET role = 'ORG_ADMIN' WHERE id = ${heirM.id}`;
  });
  transferred = true;
} catch {
  transferred = false;
}
check("a transfer passes even written in the awkward order", transferred);
check("and the org still has exactly one admin", (await adminCount()) === 1);

// Put it back, the same way round.
await sql.begin(async (tx) => {
  await tx`UPDATE memberships SET role = 'SALES_HEAD' WHERE id = ${heirM.id}`;
  await tx`UPDATE memberships SET role = 'ORG_ADMIN' WHERE id = ${onlyAdmin.id}`;
});
check("and back again", (await adminCount()) === 1);

// Now through the console, which is what an admin actually does. The trigger
// above proves the tenant cannot be orphaned; this proves the screen can
// still move the role when it is safe to.
const clickIn = async (row: string, label: string, confirm?: string) => {
  await open(TEAM);
  const found = await page.evaluate((mail: string, text: string) => {
    const rows = [...document.querySelectorAll(".person")];
    const target = rows.find((r) =>
      r.querySelector(".person__mail")?.textContent?.trim() === mail,
    );
    if (!target) return false;
    const btn = [...target.querySelectorAll("button")].find((b) =>
      new RegExp(text, "i").test(b.textContent ?? ""),
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, row, label);
  // Moving the admin role asks first; the dialog's button is what moves it.
  if (found && confirm) {
    const sel = `dialog[open] [data-confirmed="${confirm}"]`;
    await page.waitForSelector(sel, { timeout: 10000 });
    await page.click(sel);
  }
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});
  return found;
};

check("the promote control is on the right person's row",
  await clickIn(HEIR, "Make admin", "promote-admin"));
const [promoted] = await sql<{ role: string }[]>`
  SELECT role FROM memberships WHERE id = ${heirM.id}`;
check("clicking it makes them an admin", promoted?.role === "ORG_ADMIN",
  promoted?.role);
check("so the org now has two", (await adminCount()) === 2, `${await adminCount()}`);

const [promoAudit] = await sql<{ actor_user_id: string; metadata: Record<string, unknown> }[]>`
  SELECT actor_user_id, metadata FROM audit_log
  WHERE org_id = ${org.id} AND action = 'membership.promoted'
  ORDER BY id DESC LIMIT 1`;
check("the promotion is audited", !!promoAudit);
check("naming who did it", promoAudit?.actor_user_id === admin.id);
check("and what they came from", promoAudit?.metadata?.from === "SALES_HEAD",
  JSON.stringify(promoAudit?.metadata));

// With two admins the demote control appears. With one it must not, because
// the database would refuse and a button that always fails is worse than no
// button.
check("with two admins, the role can be taken back",
  await clickIn(HEIR, "Remove as admin", "demote-admin"));
const [demoted] = await sql<{ role: string }[]>`
  SELECT role FROM memberships WHERE id = ${heirM.id}`;
check("and it is", demoted?.role !== "ORG_ADMIN", demoted?.role);
check("leaving one admin", (await adminCount()) === 1, `${await adminCount()}`);

await open(TEAM);
const lastAdminHasNoDemote = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".person")];
  const adminRow = rows.find((r) =>
    /Org Admin/i.test(r.querySelector(".person__role")?.textContent ?? ""),
  );
  if (!adminRow) return false;
  return ![...adminRow.querySelectorAll("button")].some((b) =>
    /Remove as admin|Step down/i.test(b.textContent ?? ""),
  );
});
check("the last admin is offered no way to step down", lastAdminHasNoDemote);

await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND created_at >= ${STARTED}
          AND action IN ('membership.promoted', 'membership.demoted',
                         'membership.admin_transferred')`;
await sql`DELETE FROM memberships WHERE id = ${heirM.id}`;
await sql`DELETE FROM users WHERE id = ${heirUser.id}`;

await browser.close();
await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND action LIKE 'membership.%' AND created_at >= ${STARTED}`;
await sql`DELETE FROM users WHERE email = 'someone-else@example-tenant.test'`;
await sql`DELETE FROM memberships m USING users u
          WHERE m.user_id = u.id AND u.email LIKE 'over-%@example-tenant.test'`;
await sql`DELETE FROM users WHERE email LIKE 'over-%@example-tenant.test'`;
// Belt to the scoped section's own braces. It cleans up inline, but a failure
// between seeding and that point would otherwise leave a node and a role in a
// tenant every later suite reads.
await sql`DELETE FROM orgs WHERE primary_domain = 'rival-check.test'`;
await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = 'C_REGION_LEAD'`;
await sql`DELETE FROM scope_nodes WHERE org_id = ${org.id} AND slug = 'pune_check'`;
await wipe();
await sql.end();
// The library holds its own pools, and they keep Node alive after the last
// line. A suite that does not close them never hands back to the next one.
await closeDb();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
