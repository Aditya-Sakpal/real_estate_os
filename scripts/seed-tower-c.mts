// Seed a development registration through the real console form.
//
//   node --experimental-strip-types --env-file=.env.local scripts/seed-tower-c.mts
//
// Why a browser rather than a direct UPDATE: every gate, audit entry and
// stamp then sees exactly what a person recording it by hand would produce,
// and nothing here knows it was seeded. A row written straight into the table
// would skip the existence check, the promoter check and the audit trail, and
// would be the only registration in the database that never passed them.
//
// The number it records is NOT registered with MahaRERA. It resolves because
// RERA_MH_SEARCH_DIR points at db/fixtures/search, which holds a canned
// response for it. Unset that variable, as production does, and this same
// form refuses the number. Delete both once there is a real registration.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import postgres from "postgres";

const PHASE = "Tower C";
const REG_NO = "P52100012345";
const VALID_TO = "2030-03-31";

const BASE = process.env.AUTH_URL ?? "http://localhost:3000";
const COOKIE = "authjs.session-token";
const CHROME = [
  process.env.CHROME_PATH ?? "", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

if (!process.env.RERA_MH_SEARCH_DIR) {
  console.error(
    "RERA_MH_SEARCH_DIR is not set, so the form will ask the real portal and\n" +
      "refuse this number. That is correct behaviour. This script is for local\n" +
      "development only.",
  );
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

const [phase] = await sql<
  { id: string; org_id: string; entity: string; project_id: string }[]
>`
  SELECT ph.id, ph.org_id, e.name AS entity, p.id AS project_id
  FROM scope_nodes ph
  JOIN scope_nodes p  ON p.id = ph.parent_id
  JOIN scope_nodes rg ON rg.id = p.parent_id
  JOIN scope_nodes e  ON e.id = rg.parent_id
  WHERE ph.kind = 'PHASE' AND ph.name = ${PHASE}`;
if (!phase) throw new Error(`No phase named ${PHASE}`);

const [admin] = await sql<{ id: string; email: string; name: string }[]>`
  SELECT u.id, u.email, u.name FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.org_id = ${phase.org_id}
    AND m.role = 'ORG_ADMIN' AND m.status = 'ACTIVE'
  ORDER BY u.created_at LIMIT 1`;
if (!admin) throw new Error("No active ORG_ADMIN to attribute this to");

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1100 });
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

await page.goto(`${BASE}/dashboard/projects/${phase.project_id}`, {
  waitUntil: "networkidle0",
});
await page.select("#phaseId", phase.id);
await page.$eval("#registrationNo", (el, v) => ((el as HTMLInputElement).value = v), REG_NO);
await page.$eval("#validTo", (el, v) => ((el as HTMLInputElement).value = v), VALID_TO);
await page.$eval("#promoterName", (el, v) => ((el as HTMLInputElement).value = v), phase.entity);
await page.$eval(
  "#reason",
  (el) =>
    ((el as HTMLTextAreaElement).value =
      "Development seed. Not a real MahaRERA registration."),
);
await page.evaluate(() =>
  document
    .querySelector("#registrationNo")!
    .closest("form")!
    .querySelector<HTMLButtonElement>("button[type=submit]")!
    .click(),
);
await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {});

const [row] = await sql<
  { status: string; registration_no: string; last_checked_at: Date | null }[]
>`
  SELECT status, registration_no, last_checked_at
  FROM registration_records WHERE scope_node_id = ${phase.id}`;

console.log("");
console.log(`  ${PHASE} (${phase.entity})`);
console.log(`    status        ${row?.status}`);
console.log(`    number        ${row?.registration_no}`);
console.log(`    checked       ${row?.last_checked_at ? "stamped" : "not stamped"}`);
if (row?.status !== "VERIFIED") {
  const err = await page
    .$eval("[role=alert], .note--error, .error", (el) => el.textContent?.trim() ?? "")
    .catch(() => "");
  console.log(`    the form said: ${err.slice(0, 160)}`);
}
console.log("");

await browser.close();
await sql.end();
process.exitCode = row?.status === "VERIFIED" ? 0 : 1;
