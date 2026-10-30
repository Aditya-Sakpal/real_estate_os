// Functional check of join-request adjudication, driven through the real UI.
//
//   node --env-file=.env.local scripts/check-team.mjs
//
// Seeds a requester, clicks Approve in a real browser, and asserts the
// membership actually landed. Cleans up whatever it created.
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

const EMAIL = "team-check@example-tenant.test";
await sql`DELETE FROM users WHERE email = ${EMAIL}`;

const [admin] = await sql`SELECT id, email, name FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql`
  SELECT o.id, o.display_name FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  ORDER BY m.created_at
  LIMIT 1`;
if (!org) throw new Error("No org where the first user is ORG_ADMIN");

const [asker] = await sql`
  INSERT INTO users (email, email_domain, name)
  VALUES (${EMAIL}, 'example-tenant.test', 'Test Requester')
  RETURNING id`;
await sql`
  INSERT INTO org_join_requests (org_id, user_id, matched_on)
  VALUES (${org.id}, ${asker.id}, 'EMAIL_DOMAIN')`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
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
    maxAge: 600,
  }),
  domain: "localhost",
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
});
// The organisation this suite seeded, not whichever one the account opens first.
await page.setCookie({ name: "salesdesk.org", value: org.id, domain: "localhost", path: "/", sameSite: "Lax" });

await page.goto(`${BASE}/dashboard/team`, { waitUntil: "networkidle0" });

const rendered = await page.$$eval(".qi__title", (n) => n.map((x) => x.textContent.trim()));
check("requester is visible to the admin (RLS policy 0002)", rendered.includes("Test Requester"),
  rendered.join(", "));

await page.select(".mini-select", "MARKETING_HEAD");
await Promise.all([
  page.waitForNavigation({ waitUntil: "networkidle0" }),
  page.click(".inline-form button[type=submit]"),
]);

const [granted] = await sql`
  SELECT m.role, m.status, s.kind
  FROM memberships m JOIN scope_nodes s ON s.id = m.scope_node_id
  WHERE m.user_id = ${asker.id} AND m.org_id = ${org.id}`;
check("approving grants a membership", !!granted);
check("the chosen role is the one granted", granted?.role === "MARKETING_HEAD", granted?.role);
check("granted at the org root", granted?.kind === "ORG", granted?.kind);
check("membership is active", granted?.status === "ACTIVE", granted?.status);

const [req] = await sql`
  SELECT status, decided_by FROM org_join_requests WHERE user_id = ${asker.id}`;
check("request is marked approved", req?.status === "APPROVED", req?.status);
check("the decision records who made it", req?.decided_by === admin.id);

const [logged] = await sql`
  SELECT action FROM audit_log
  WHERE org_id = ${org.id} AND action = 'membership.granted'
  ORDER BY id DESC LIMIT 1`;
check("the grant is audited", logged?.action === "membership.granted");

const after = await page.$$eval(".person__name", (n) => n.map((x) => x.textContent.trim()));
check("the new member now appears in the list", after.some((t) => t.includes("Test Requester")),
  after.join(", "));

// --- changing a role, and taking it away ----------------------------------
//
// One membership at a time, through the same dialog a person uses. The admin
// holds everything, so the subset rule lets them; `check:logic` holds the
// cases where it does not.
const inRow = (name, testId) =>
  page.evaluate(
    (n, id) => {
      const row = [...document.querySelectorAll(".person")].find((r) =>
        r.querySelector(".person__name")?.textContent.includes(n));
      const b = row?.querySelector(`[data-confirm="${id}"]`);
      b?.click();
      return !!b;
    },
    name,
    testId,
  );
const landed = (key) =>
  page
    .waitForFunction((k) => new URL(location.href).searchParams.has(k), { timeout: 30000 }, key)
    .catch(() => {});

const ownRow = await page.evaluate(() => {
  const row = [...document.querySelectorAll(".person")].find((r) => r.querySelector(".pill")?.textContent === "You");
  return {
    change: !!row?.querySelector('[data-confirm="change-role"]'),
    remove: !!row?.querySelector('[data-confirm="remove-member"]'),
  };
});
check("nobody is offered a change to their own row", !ownRow.change && !ownRow.remove, JSON.stringify(ownRow));

check("a member's row offers Change role", await inRow("Test Requester", "change-role"));
await page.waitForSelector("dialog[open] select[name=role]", { timeout: 15000 });
await page.select("dialog[open] select[name=role]", "AUDITOR");
await page.click('dialog[open] [data-confirmed="change-role"]');
await landed("member");
const [moved] = await sql`
  SELECT role, status FROM memberships WHERE user_id = ${asker.id} AND org_id = ${org.id}`;
check("the role is changed in place", moved?.role === "AUDITOR" && moved?.status === "ACTIVE",
  `${moved?.role} ${moved?.status}`);
await page.waitForSelector("#members .note--info", { timeout: 20000 }).catch(() => {});
const said = await page.$eval("#members .note--info", (el) => el.textContent.trim()).catch(() => "");
check("and the screen says what it is now", /is now Auditor/.test(said), said);
const [changedLog] = await sql`
  SELECT metadata FROM audit_log
  WHERE org_id = ${org.id} AND action = 'membership.role_changed' AND target_id = ${asker.id}
  ORDER BY id DESC LIMIT 1`;
check("the change is audited with both roles",
  changedLog?.metadata?.from === "MARKETING_HEAD" && changedLog?.metadata?.to === "AUDITOR",
  JSON.stringify(changedLog?.metadata));

await page.goto(`${BASE}/dashboard/team`, { waitUntil: "networkidle0" });
check("and offers Remove", await inRow("Test Requester", "remove-member"));
await page.waitForSelector('dialog[open] [data-confirmed="remove-member"]', { timeout: 15000 });
await page.click('dialog[open] [data-confirmed="remove-member"]');
await landed("member");
const [ended] = await sql`
  SELECT status, revoked_at FROM memberships WHERE user_id = ${asker.id} AND org_id = ${org.id}`;
check("removing ends the membership, it does not delete it",
  ended?.status === "REVOKED" && !!ended?.revoked_at, ended?.status);
check("the removal is audited",
  (await sql`
    SELECT 1 FROM audit_log
    WHERE org_id = ${org.id} AND action = 'membership.revoked' AND target_id = ${asker.id}`).length === 1);
const gone = await page.$$eval(".person__name", (n) => n.map((x) => x.textContent.trim()));
check("and they leave the list", !gone.some((t) => t.includes("Test Requester")), gone.join(", "));

await browser.close();

await sql`DELETE FROM audit_log WHERE target_id = ${asker.id}`;
await sql`DELETE FROM org_join_requests WHERE user_id = ${asker.id}`;
await sql`DELETE FROM memberships WHERE user_id = ${asker.id}`;
await sql`DELETE FROM users WHERE id = ${asker.id}`;
await sql.end();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
