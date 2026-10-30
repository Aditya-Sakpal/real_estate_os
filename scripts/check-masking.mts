// Phone masking, driven through the real console.
//
//   node --experimental-strip-types --no-warnings --env-file=.env.local scripts/check-masking.mts
//
// The rule under test is that a number the policy masks never reaches the
// browser. So the assertions read what the server SENT (the raw response,
// flight data included), not what the page happens to draw.
//
// Builds its own project, tower, lead, call, visit, two roles and two people,
// and removes exactly those.
import { encode } from "next-auth/jwt";
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";

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

// A number nobody else's fixtures use, and every way it could be written.
const PHONE = "+919123456780";
const DIGITS = "9123456780";
const anyForm = new RegExp(DIGITS.split("").join("[\\s-]?"));
const hash = createHash("sha256").update(PHONE.toLowerCase()).digest("hex");

const AGENT = "mask-agent@example-tenant.test";
const MANAGER = "mask-manager@example-tenant.test";
const SLUGS = ["mask_check_project", "mask_check_tower"];
const ROLES = ["C_MASK_AGENT", "C_MASK_MANAGER"];

const [admin] = await sql<{ id: string; email: string; name: string | null }[]>`
  SELECT id, email::text AS email, name FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql<{ id: string }[]>`
  SELECT o.id FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  ORDER BY m.created_at LIMIT 1`;
if (!org) throw new Error("No org where the first user is ORG_ADMIN");
const [region] = await sql<{ id: string; path: string }[]>`
  SELECT id, path::text AS path FROM scope_nodes
  WHERE org_id = ${org.id} AND kind = 'REGION' ORDER BY path LIMIT 1`;
if (!region) throw new Error("No region to hang the fixtures off");

/** Idempotent, and scoped to what this suite writes. */
const drop = async () => {
  const people = await sql<{ id: string }[]>`SELECT id FROM users WHERE email IN (${AGENT}, ${MANAGER})`;
  const leads = await sql<{ id: string }[]>`
    SELECT l.id FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE n.org_id = ${org.id} AND n.slug = ANY(${SLUGS})`;
  const ids = leads.map((l) => l.id);
  if (ids.length) {
    await sql`DELETE FROM audit_log WHERE target_id = ANY(${ids})`;
    await sql`DELETE FROM site_visits WHERE lead_id = ANY(${ids})`;
    await sql`DELETE FROM calls WHERE lead_id = ANY(${ids})`;
    await sql`DELETE FROM lead_activity WHERE lead_id = ANY(${ids})`;
    await sql`DELETE FROM lead_tasks WHERE lead_id = ANY(${ids})`;
    await sql`DELETE FROM leads WHERE id = ANY(${ids})`;
  }
  for (const p of people) {
    await sql`DELETE FROM audit_log WHERE actor_user_id = ${p.id}`;
    await sql`DELETE FROM memberships WHERE user_id = ${p.id}`;
    await sql`DELETE FROM users WHERE id = ${p.id}`;
  }
  await sql`DELETE FROM audit_log WHERE org_id = ${org.id} AND target_id = ANY(${ROLES})`;
  await sql`DELETE FROM field_policies WHERE org_id = ${org.id} AND role = ANY(${ROLES})`;
  await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = ANY(${ROLES})`;
  await sql`DELETE FROM scope_nodes WHERE org_id = ${org.id} AND slug = ANY(${SLUGS})`;
};
await drop();

const [project] = await sql<{ id: string; path: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${region.id}, 'PROJECT', 'Mask Check', 'mask_check_project',
          ${`${region.path}.mask_check_project`}::ltree)
  RETURNING id, path::text AS path`;
const [tower] = await sql<{ id: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Mask Tower', 'mask_check_tower',
          ${`${project.path}.mask_check_tower`}::ltree)
  RETURNING id`;

// Two roles of the tenant's own: one works leads, one may also reveal.
await sql`
  INSERT INTO org_roles (org_id, key, label, description, min_kind, can_delegate, source, permissions)
  VALUES (${org.id}, 'C_MASK_AGENT', 'Mask Agent', 'Check fixture.', 'PROJECT', false, 'CUSTOM',
          ${["lead:read", "visit:read"]}),
         (${org.id}, 'C_MASK_MANAGER', 'Mask Manager', 'Check fixture.', 'PROJECT', false, 'CUSTOM',
          ${["lead:read", "visit:read", "lead.phone:unmask"]})`;
const person = async (email: string, role: string) => {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${email}, 'example-tenant.test', ${role})
    RETURNING id`;
  await sql`
    INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
    VALUES (${u.id}, ${org.id}, ${project.id}, ${role}, 'ACTIVE', now())`;
  return u.id;
};
const agentId = await person(AGENT, "C_MASK_AGENT");
const managerId = await person(MANAGER, "C_MASK_MANAGER");

const [lead] = await sql<{ id: string }[]>`
  INSERT INTO leads (org_id, scope_node_id, name, phone, email, source, channel, needs_person)
  VALUES (${org.id}, ${tower.id}, 'Mask Buyer', ${PHONE}, 'mask.buyer@gmail.com', 'Website', 'WEBSITE',
          ${`Asked us to call ${DIGITS.slice(0, 5)} ${DIGITS.slice(5)} instead`})
  RETURNING id`;
await sql`
  INSERT INTO calls (org_id, lead_id, scope_node_id, app_id, app_version, from_number, to_number, status,
                     connectivity, outcome, duration_s, transcript, final_variables, placed_at, ended_at)
  VALUES (${org.id}, ${lead.id}, ${tower.id}, 'check', 1, '+912212345678', ${PHONE}, 'DONE',
          'connected', 'CALLBACK', 60,
          ${sql.json([{ role: "user", en: `My number is ${DIGITS}`, indic: null }])},
          ${sql.json({ call_summary: `Buyer repeated ${PHONE} twice.` })},
          now() - interval '1 hour', now() - interval '59 minutes')`;
await sql`
  INSERT INTO site_visits (org_id, lead_id, scope_node_id, scheduled_at, booked_via)
  VALUES (${org.id}, ${lead.id}, ${tower.id}, now() + interval '1 day', 'CONSOLE')`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
const as = async (userId: string, email: string): Promise<Page> => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(90000);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.setCookie(
    {
      name: COOKIE,
      value: await encode({ token: { sub: userId, userId, email }, secret: process.env.AUTH_SECRET!, salt: COOKIE, maxAge: 900 }),
      domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax",
    },
    { name: "salesdesk.org", value: org.id, domain: "localhost", path: "/", sameSite: "Lax" },
  );
  return page;
};
/** Everything the server sent for a page: its HTML and its flight data. */
const sent = async (page: Page, path: string) => {
  const res = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0" });
  return (await res?.text()) ?? "";
};

const agent = await as(agentId, AGENT);
const manager = await as(managerId, MANAGER);
const adminPage = await as(admin.id, admin.email);
const LEAD = `/dashboard/leads/${lead.id}`;

// --- nothing whole leaves the server ---------------------------------------
console.log("\na masked number never reaches the browser");
for (const [label, path] of [["the lead page", LEAD], ["the call log", "/dashboard/leads/calls"], ["site visits", "/dashboard/visits"]]) {
  const body = await sent(agent, path);
  check(`${label} sends no whole number`, !anyForm.test(body), (body.match(anyForm) ?? [""])[0]);
  check(`${label} sends the masked one`, body.includes("91XXXXXX80"));
}
const leadBody = await sent(agent, LEAD);
check("nor inside the buyer's own words", !leadBody.includes(`${DIGITS.slice(0, 5)} ${DIGITS.slice(5)}`));
check("the email is masked the same way", leadBody.includes("mXXX@gmail.com") && !leadBody.includes("mask.buyer@gmail.com"));
check("somebody who may not reveal is offered nothing to press", !(await agent.$$eval("button", (bs) => bs.some((b) => b.textContent?.trim() === "Show number"))));

// --- a reveal is one number, logged as a hash --------------------------------
console.log("\nrevealing one number");
await manager.goto(`${BASE}${LEAD}`, { waitUntil: "networkidle0" });
const before = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = ${managerId} AND action = 'lead.phone_unmasked'`;
const pressed = await manager.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Show number");
  b?.click();
  return !!b;
});
check("somebody who may reveal is offered Show number", pressed);
await manager.waitForFunction(() => document.body.textContent?.includes("+91 91234 56780"), { timeout: 20000 }).catch(() => {});
check("and sees the whole number after pressing it", (await manager.evaluate(() => document.body.textContent ?? "")).includes("+91 91234 56780"));
const [logged] = await sql<{ n: number; metadata: Record<string, unknown>; target_id: string }[]>`
  SELECT (SELECT count(*)::int FROM audit_log WHERE actor_user_id = ${managerId} AND action = 'lead.phone_unmasked') AS n,
         metadata, target_id
  FROM audit_log WHERE actor_user_id = ${managerId} AND action = 'lead.phone_unmasked'
  ORDER BY id DESC LIMIT 1`;
check("the reveal is one audit row", (logged?.n ?? 0) === before[0].n + 1, `${logged?.n}`);
check("naming the lead", logged?.target_id === lead.id);
check("carrying a hash of the number, never the number",
  logged?.metadata?.phone === hash && !JSON.stringify(logged?.metadata).includes(DIGITS));

// The day's allowance: fill it, and the next press is refused.
await sql`
  INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
  SELECT ${org.id}, ${managerId}, 'lead.phone_unmasked', 'lead', ${lead.id}, '{}'::jsonb
  FROM generate_series(1, 100)`;
await manager.goto(`${BASE}${LEAD}`, { waitUntil: "networkidle0" });
await manager.evaluate(() => {
  [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Show number")?.click();
});
await manager.waitForFunction(() => /numbers today/.test(document.body.textContent ?? ""), { timeout: 20000 }).catch(() => {});
const capped = await manager.evaluate(() => document.body.textContent ?? "");
check("past the day's allowance a reveal is refused", /numbers today/.test(capped) && !capped.includes("+91 91234 56780"));

// --- the policy decides ------------------------------------------------------
console.log("\nthe policy, set on the settings screen");
await adminPage.goto(`${BASE}/dashboard/settings/phone-numbers?role=C_MASK_MANAGER#policy`, { waitUntil: "networkidle0" });
await adminPage.waitForSelector('form[data-role="C_MASK_MANAGER"] select[name=before]', { timeout: 30000 });
await adminPage.select('form[data-role="C_MASK_MANAGER"] select[name=before]', "MASKED");
await adminPage.select('form[data-role="C_MASK_MANAGER"] select[name=from]', "");
await adminPage.select('form[data-role="C_MASK_MANAGER"] select[name=before]', "FULL");
await adminPage.click('form[data-role="C_MASK_MANAGER"] button[type=submit]:not([formaction])');
await adminPage.waitForFunction(() => new URL(location.href).searchParams.has("saved") || /Saved for/.test(document.body.textContent ?? ""), { timeout: 30000 }).catch(() => {});
const stored = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM field_policies
  WHERE org_id = ${org.id} AND role = 'C_MASK_MANAGER' AND visibility = 'FULL'`;
check("a role set to the full number is stored for every stage, phone and email", stored[0].n === 14, `${stored[0].n}`);
const fullBody = await sent(manager, LEAD);
check("and that role now receives the whole number", fullBody.includes("+91 91234 56780"));
check("while the other role still does not", !anyForm.test(await sent(agent, LEAD)));

await sql`
  INSERT INTO field_policies (org_id, resource, field, role, stage, visibility)
  SELECT ${org.id}, 'lead', 'phone', 'C_MASK_AGENT', s, 'HIDDEN'
  FROM unnest(ARRAY['new','contacted','qualified','visit_scheduled','visit_done','negotiation','booked']) s`;
const hiddenBody = await sent(agent, LEAD);
check("a hidden number sends neither the number nor its mask",
  !anyForm.test(hiddenBody) && !hiddenBody.includes("91XXXXXX80"));
await sql`DELETE FROM field_policies WHERE org_id = ${org.id} AND role = 'C_MASK_AGENT'`;

// --- the export follows the same policy -------------------------------------
console.log("\nexporting");
const csv = await adminPage.evaluate(async () => (await fetch("/dashboard/leads/export")).text());
check("the export carries the fixture lead", csv.includes("Mask Buyer"));
check("with its number masked for a role that sees it masked", csv.includes("91XXXXXX80") && !anyForm.test(csv));
const [exported] = await sql<{ metadata: Record<string, unknown> }[]>`
  SELECT metadata FROM audit_log WHERE actor_user_id = ${admin.id} AND action = 'lead.exported'
  ORDER BY id DESC LIMIT 1`;
check("the export is audited with counts only",
  typeof exported?.metadata?.rows === "number" && !JSON.stringify(exported?.metadata).includes("Mask Buyer"));
const agentCsv = await agent.evaluate(async () => (await fetch("/dashboard/leads/export", { redirect: "manual" })).status);
check("somebody without the export key gets no file", agentCsv !== 200, String(agentCsv));
await sql`DELETE FROM audit_log WHERE actor_user_id = ${admin.id} AND action = 'lead.exported'
          AND created_at > now() - interval '10 minutes'`;

await browser.close();
await drop();
await sql.end();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
