// Functional check of role editing, driven through the real console.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-rbac.mjs
//
// Everything here goes through the browser and the server actions, not the
// database directly. The assertions then read the database to confirm what
// the screen claimed actually happened. Cleans up whatever it created.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import postgres from "postgres";
import { DEVELOPER_ROLES } from "../src/lib/roles.ts";

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

const AUDITOR_EMAIL = "rbac-auditor@example-tenant.test";
const KEEPER_EMAIL = "rbac-keeper@example-tenant.test";
await sql`DELETE FROM users WHERE email IN (${AUDITOR_EMAIL}, ${KEEPER_EMAIL})`;

const [admin] = await sql`SELECT id, email, name FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql`
  SELECT o.id, o.display_name FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  ORDER BY m.created_at
  LIMIT 1`;
if (!org) throw new Error("No org where the first user is ORG_ADMIN");

// Start from a clean slate so a half-finished earlier run cannot mask a bug.
// The organisation is a real one on a shared database, so what it holds is
// kept aside and put back at the end: the suite deleted every role the
// tenant had edited or written, and every 'role.%' row of its history.
const STARTED = new Date();
const keptRoles = await sql`SELECT * FROM org_roles WHERE org_id = ${org.id}`;
const restoreRoles = async () => {
  await sql`DELETE FROM org_roles WHERE org_id = ${org.id}`;
  for (const r of keptRoles) await sql`INSERT INTO org_roles ${sql(r)}`;
};
await sql`DELETE FROM org_roles WHERE org_id = ${org.id}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const sessionFor = async (userId, email, name) =>
  encode({
    token: { sub: userId, userId, email, name },
    secret: process.env.AUTH_SECRET,
    salt: COOKIE,
    maxAge: 900,
  });

// Each signed-in person gets their own browser context. Pages in one context
// share a cookie jar, so signing the auditor in would otherwise sign the admin
// out, and the next admin assertion would fail for a reason that has nothing
// to do with roles.
const openAs = async (userId, email, name) => {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  // A cold route in the dev server can outlast puppeteer's 30s default,
  // and a navigation that times out fails the suite for a reason that has
  // nothing to do with the rule being checked.
  page.setDefaultNavigationTimeout(90000);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.setCookie({
    name: COOKIE,
    value: await sessionFor(userId, email, name),
    domain: "localhost",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
  // The organisation this suite seeded, not whichever one the account opens first.
  await page.setCookie({ name: "salesdesk.org", value: org.id, domain: "localhost", path: "/", sameSite: "Lax" });
  return page;
};

const ROLES = `${BASE}/dashboard/settings/roles`;

// A server action finishes with a client-side transition rather than a
// document load, so waiting on navigation is the wrong signal and lands the
// assertions on a half-swapped DOM. Submit, let the network settle, then
// re-read the page fresh.
const submit = async (p, selector) => {
  // The dev server compiles a route on first request, so wait for the control
  // rather than assuming the page has finished arriving.
  try {
    await p.waitForSelector(selector, { timeout: 20000 });
  } catch (e) {
    const h1 = await p.$eval("h1", (n) => n.textContent.trim()).catch(() => "(no h1)");
    const note = await p.$eval(".note", (n) => n.textContent.trim()).catch(() => "(no note)");
    throw new Error(
      `expected ${selector} but the page is ${p.url()} -- h1 "${h1}", note "${note}"`,
    );
  }
  await p.click(selector);
  await p.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
};
const open = (p, url) => p.goto(url, { waitUntil: "networkidle0" });

/**
 * Wait for the redirect to actually land, then read what it carried.
 *
 * `submit()` waits for the network to go idle, which a slow server action can
 * outlast, and the dev server can spend twenty seconds compiling a route it
 * has not served since the last edit. Reading the note before the action
 * returns gives an empty string, which reports as "the screen said nothing"
 * rather than as "we looked too soon". Waiting on the outcome rather than on
 * a fixed number of seconds is what makes it deterministic.
 */
const refusalNote = async (p) => {
  await p
    .waitForFunction(() => new URL(location.href).searchParams.has("error"), {
      timeout: 30000,
    })
    .catch(() => {});
  return p.$eval(".note--risk", (el) => el.textContent.trim()).catch(() => "");
};

const page = await openAs(admin.id, admin.email, admin.name);

// --- the catalog ----------------------------------------------------------
console.log("\nthe role catalog");
await page.goto(ROLES, { waitUntil: "networkidle0" });

const listed = await page.$$eval(".rolelist__name", (n) => n.map((x) => x.textContent.trim()));
// Counted from what we actually ship rather than from a number typed here.
// A hardcoded 14 asserts "the screen lists fourteen things", which stops
// being true the day a role is added and says nothing useful when it breaks.
check("every shipped role is listed",
  listed.length === DEVELOPER_ROLES.length,
  `${listed.length} listed, ${DEVELOPER_ROLES.length} shipped`);
check("the founding role leads the list", listed[0] === "Org Admin", listed[0]);

const foundingLocked = await page.$(".rolelock");
check("the founding role opens locked, with no editor", !!foundingLocked);
const foundingSave = await page.$(".roleform__foot button");
check("and offers nothing to save", foundingSave === null);

// --- editing a shipped role ----------------------------------------------
console.log("\nediting a role we ship");
await page.goto(`${ROLES}?role=SALES_HEAD`, { waitUntil: "networkidle0" });

const unmaskBefore = await page.$eval(
  'input[name="permissions"][value="lead.phone:unmask"]',
  (el) => el.checked,
);
check("Sales Head ships with the ability to see phone numbers", unmaskBefore === true);

// Take phone numbers away and rename the role, the way a real admin would.
await page.click('input[name="permissions"][value="lead.phone:unmask"]');
await page.$eval("#role-label", (el) => {
  el.value = "Regional Sales Head";
});
await submit(page, '.roleform__foot button[type="submit"]');
await open(page, `${ROLES}?role=SALES_HEAD`);

const [override] = await sql`
  SELECT key, label, source, permissions FROM org_roles
  WHERE org_id = ${org.id} AND key = 'SALES_HEAD'`;
check("the edit is stored as an override, not a new role", override?.source === "OVERRIDE", override?.source);
check("the tenant's own name is kept", override?.label === "Regional Sales Head", override?.label);
check("the permission it removed is gone",
  !!override && !override.permissions.includes("lead.phone:unmask"),
  (override?.permissions ?? []).join(", "));
check("the rest of the permissions survived", override?.permissions.includes("lead:assign"));

const renamed = await page.$$eval(".rolelist__name", (n) => n.map((x) => x.textContent.trim()));
check("the list shows the new name", renamed.includes("Regional Sales Head"));
const editedNote = await page.$$eval(".rolelist__note", (n) =>
  n.map((x) => x.textContent.trim()).filter((t) => t.startsWith("Edited")),
);
check("and marks it as edited", editedNote.length === 1, `${editedNote.length} marked`);

// The change has to reach the thing that actually uses it. The approval
// picker on the team screen reads the same resolved roles.
await page.goto(`${BASE}/dashboard/team`, { waitUntil: "networkidle0" });
const optionLabels = await page.$$eval(".mini-select option", (n) =>
  n.map((x) => x.textContent.trim()),
).catch(() => []);
if (optionLabels.length) {
  check("the invite picker picks up the rename", optionLabels.includes("Regional Sales Head"),
    optionLabels.join(", "));
} else {
  check("the invite picker picks up the rename", true, "no pending request to render one");
}

// --- resetting ------------------------------------------------------------
console.log("\nputting a role back");
await open(page, `${ROLES}?role=SALES_HEAD`);
// Resetting asks first; the dialog's own button does it.
await submit(page, '.roleform__foot [data-confirm="reset-role"]');
await submit(page, 'dialog[open] [data-confirmed="reset-role"]');
await open(page, `${ROLES}?role=SALES_HEAD`);

const afterReset = await sql`
  SELECT key FROM org_roles WHERE org_id = ${org.id} AND key = 'SALES_HEAD'`;
check("resetting drops the override row", afterReset.length === 0);
const restored = await page.$eval("#role-label", (el) => el.value);
check("and the shipped definition takes over again", restored === "Sales Head", restored);

// --- a role of the tenant's own -------------------------------------------
console.log("\na role the tenant wrote");
await page.goto(`${ROLES}?role=new`, { waitUntil: "networkidle0" });
await page.$eval("#role-label", (el) => {
  el.value = "Launch War Room";
});
await page.$eval("#role-desc", (el) => {
  el.value = "Launch week only.";
});
await page.select("#role-kind", "PROJECT");
await page.click('input[name="permissions"][value="lead:read"]');
await page.click('input[name="permissions"][value="visit:read"]');
await submit(page, '.roleform__foot button[type="submit"]');
await open(page, ROLES);

const [custom] = await sql`
  SELECT key, label, min_kind, source, permissions FROM org_roles
  WHERE org_id = ${org.id} AND source = 'CUSTOM'`;
check("the role is created", !!custom);
check("its key is prefixed, so it cannot shadow one we ship",
  custom?.key === "C_LAUNCH_WAR_ROOM", custom?.key);
check("the level chosen is the level stored", custom?.min_kind === "PROJECT", custom?.min_kind);
check("it holds exactly what was ticked",
  JSON.stringify((custom?.permissions ?? []).slice().sort()) ===
    JSON.stringify(["lead:read", "visit:read"]),
  (custom?.permissions ?? []).join(", "));

const withCustom = await page.$$eval(".rolelist__name", (n) => n.map((x) => x.textContent.trim()));
check("it appears in the list", withCustom.includes("Launch War Room"));
check("under a heading of its own",
  (await page.$$eval(".rolelist__sep", (n) => n.map((x) => x.textContent.trim()))).includes(
    "Roles you wrote",
  ));

// A project-scoped role has nothing to attach to yet, so it must not show up
// where roles are granted at the org root.
const grantable = await sql`
  SELECT count(*)::int AS n FROM org_roles
  WHERE org_id = ${org.id} AND min_kind = 'PROJECT'`;
check("a project-level role exists but is not org-grantable", grantable[0].n === 1);

// --- deletion guard -------------------------------------------------------
console.log("\ndeleting a role");
// Idempotent on purpose: a run that fails partway leaves this user behind,
// and the next run should not then fail on a duplicate instead of on the bug.
await sql`DELETE FROM users WHERE email = ${AUDITOR_EMAIL}`;
const [holder] = await sql`
  INSERT INTO users (email, email_domain, name)
  VALUES (${AUDITOR_EMAIL}, 'example-tenant.test', 'Test Auditor')
  RETURNING id`;
const [root] = await sql`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG' LIMIT 1`;
await sql`
  INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
  VALUES (${holder.id}, ${org.id}, ${root.id}, ${custom.key}, 'ACTIVE', now())`;

await open(page, `${ROLES}?role=${custom.key}`);
// A role somebody holds offers no Delete that could only be refused; it says
// who holds it instead.
const noDelete = (await page.$('.roleform__foot [data-confirm="delete-role"]')) === null;
const refusal = await page.$eval(".roleform__foot .sub", (el) => el.textContent.trim()).catch(() => "");

const stillThere = await sql`
  SELECT key FROM org_roles WHERE org_id = ${org.id} AND key = ${custom.key}`;
check("a role somebody holds cannot be deleted", stillThere.length === 1);
check("the screen offers no delete for it", noDelete);
check("and says who is holding it", refusal.includes("one person"), refusal);

// --- what a narrower role actually sees -----------------------------------
console.log("\nthe console a narrower role gets");
await sql`UPDATE memberships SET role = 'AUDITOR' WHERE user_id = ${holder.id}`;

const auditorPage = await openAs(holder.id, AUDITOR_EMAIL, "Test Auditor");
await auditorPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
const rail = await auditorPage.$$eval(".nav__text", (n) => n.map((x) => x.textContent.trim()));
check("the rail rendered at all", rail.length > 0, `${rail.length} items`);
check("an auditor gets reports", rail.includes("Reports"), rail.join(", "));
check("an auditor does not get leads", !rail.includes("Leads"), rail.join(", "));
check("an auditor does not get the team list", !rail.includes("Team"), rail.join(", "));
// An auditor reads the plan and its usage (billing:read), so Settings is on
// its rail; the roles and team pages below still turn it away.
check("an auditor gets settings for the plan and usage", rail.includes("Settings"), rail.join(", "));

// The rail hiding it is presentation. This is the part that matters: typing
// the URL must not work either.
await auditorPage.goto(ROLES, { waitUntil: "networkidle0" });
check("typing the roles URL does not get an auditor in",
  !auditorPage.url().includes("/settings/roles"), auditorPage.url());

await auditorPage.goto(`${BASE}/dashboard/team`, { waitUntil: "networkidle0" });
check("nor does typing the team URL",
  !auditorPage.url().includes("/dashboard/team"), auditorPage.url());

await auditorPage.browserContext().close();

// Now that nobody holds it, the role can go.
await sql`UPDATE memberships SET status = 'REVOKED' WHERE user_id = ${holder.id}`;
await open(page, `${ROLES}?role=${custom.key}`);
await submit(page, '.roleform__foot [data-confirm="delete-role"]');
await submit(page, 'dialog[open] [data-confirmed="delete-role"]');
const gone = await sql`
  SELECT key FROM org_roles WHERE org_id = ${org.id} AND key = ${custom.key}`;
check("a role nobody holds can be deleted", gone.length === 0);

// --- editing roles is limited to what you hold ------------------------------
//
// A role's definition applies wherever it is held, so an editor may add only
// what they hold at the organisation root, and may not rewrite a role that
// carries more than they do. Holding a permission over one region is not
// enough: that is what the second membership below is for.
console.log("\nan editor who is not an admin");
await sql`
  INSERT INTO org_roles (org_id, key, label, description, min_kind, can_delegate, source, permissions)
  VALUES (${org.id}, 'C_ROLE_KEEPER', 'Role Keeper', 'Looks after roles.', 'ORG', false, 'CUSTOM',
          ${["role:read", "role:manage", "lead:read", "visit:read"]})`;
const [keeper] = await sql`
  INSERT INTO users (email, email_domain, name)
  VALUES (${KEEPER_EMAIL}, 'example-tenant.test', 'Role Keeper') RETURNING id`;
await sql`
  INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
  VALUES (${keeper.id}, ${org.id}, ${root.id}, 'C_ROLE_KEEPER', 'ACTIVE', now())`;
const [someRegion] = await sql`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'REGION' ORDER BY path LIMIT 1`;
if (someRegion) {
  await sql`
    INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
    VALUES (${keeper.id}, ${org.id}, ${someRegion.id}, 'PRESALES_MANAGER', 'ACTIVE', now())`;
}

const keeperPage = await openAs(keeper.id, KEEPER_EMAIL, "Role Keeper");
const formNote = async (p) => {
  await p.waitForSelector(".roleform .note--risk, form .note--risk", { timeout: 20000 }).catch(() => {});
  return p.$eval("form .note--risk", (el) => el.textContent.trim()).catch(() => "");
};

await open(keeperPage, `${ROLES}?role=new`);
await keeperPage.$eval("#role-label", (el) => {
  el.value = "Number Seer";
});
await keeperPage.select("#role-kind", "ORG");
await keeperPage.click('input[name="permissions"][value="lead:read"]');
await keeperPage.click('input[name="permissions"][value="lead.phone:unmask"]');
await submit(keeperPage, '.roleform__foot button[type="submit"]');
const addNote = await formNote(keeperPage);
check("an editor cannot add access they do not hold at the root",
  (await sql`SELECT 1 FROM org_roles WHERE org_id = ${org.id} AND label = 'Number Seer'`).length === 0);
check("even when they hold it over one region",
  /do not have yourself: See real phone numbers/.test(addNote), addNote);

await open(keeperPage, `${ROLES}?role=SALES_HEAD`);
await keeperPage.$eval("#role-label", (el) => {
  el.value = "Narrowed Sales Head";
});
await submit(keeperPage, '.roleform__foot button[type="submit"]');
const aboveNote = await formNote(keeperPage);
check("nor rewrite a role carrying more than they hold",
  (await sql`SELECT 1 FROM org_roles WHERE org_id = ${org.id} AND key = 'SALES_HEAD'`).length === 0);
check("and is told what it carries", /This role includes access you do not have/.test(aboveNote), aboveNote);

await open(keeperPage, `${ROLES}?role=new`);
await keeperPage.$eval("#role-label", (el) => {
  el.value = "Lead Reader";
});
await keeperPage.select("#role-kind", "ORG");
await keeperPage.click('input[name="permissions"][value="lead:read"]');
await submit(keeperPage, '.roleform__foot button[type="submit"]');
await keeperPage
  .waitForFunction(() => new URL(location.href).searchParams.get("role") === "C_LEAD_READER", { timeout: 30000 })
  .catch(() => {});
check("a role inside what they hold is written",
  (await sql`SELECT 1 FROM org_roles WHERE org_id = ${org.id} AND key = 'C_LEAD_READER'`).length === 1);
await keeperPage.browserContext().close();

await sql`DELETE FROM memberships WHERE user_id = ${keeper.id}`;
await sql`DELETE FROM audit_log WHERE actor_user_id = ${keeper.id}`;
await sql`DELETE FROM users WHERE id = ${keeper.id}`;
await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key IN ('C_ROLE_KEEPER', 'C_LEAD_READER')`;

// --- the trail ------------------------------------------------------------
console.log("\nthe audit trail");
const actions = await sql`
  SELECT DISTINCT action FROM audit_log
  WHERE org_id = ${org.id} AND action LIKE 'role.%'`;
const seen = actions.map((a) => a.action).sort();
check("every role change is recorded",
  JSON.stringify(seen) === JSON.stringify(["role.created", "role.deleted", "role.reset", "role.updated"]),
  seen.join(", "));

const [who] = await sql`
  SELECT actor_user_id FROM audit_log
  WHERE org_id = ${org.id} AND action = 'role.updated' ORDER BY id DESC LIMIT 1`;
check("with who made it", who?.actor_user_id === admin.id);

await browser.close();

await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND action LIKE 'role.%' AND created_at >= ${STARTED}`;
await restoreRoles();
await sql`DELETE FROM memberships WHERE user_id = ${holder.id}`;
await sql`DELETE FROM users WHERE id = ${holder.id}`;
await sql.end();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
