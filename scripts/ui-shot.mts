// Screenshot console pages as the dev tenant's first admin.
//   node --experimental-strip-types --env-file=.env.local scripts/ui-shot.mts <outdir> <path>...
// SHOT_W sets the width (1440 by default). Run with MSYS_NO_PATHCONV=1 in Git Bash.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import postgres from "postgres";

const BASE = process.env.AUTH_URL ?? "http://localhost:3000";
const COOKIE = "authjs.session-token";
const CHROME = [
  process.env.CHROME_PATH ?? "", "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

const [out, ...paths] = process.argv.slice(2);
const width = Number(process.env.SHOT_W ?? 1440);
const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const [admin] = await sql<{ id: string; email: string; name: string }[]>`
  SELECT u.id, u.email, u.name FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.role = 'ORG_ADMIN' AND m.status = 'ACTIVE'
  JOIN orgs o ON o.id = m.org_id AND o.type = 'DEVELOPER'
  ORDER BY u.created_at LIMIT 1`;
await sql.end();

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width, height: 900 });
await page.setCookie({
  name: COOKIE,
  value: await encode({
    token: { sub: admin.id, userId: admin.id, email: admin.email, name: admin.name },
    secret: process.env.AUTH_SECRET!, salt: COOKIE, maxAge: 3600,
  }),
  domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax",
});
for (const p of paths) {
  try {
    await page.goto(`${BASE}${p}`, { waitUntil: "networkidle2", timeout: 180000 });
    await new Promise((r) => setTimeout(r, 800));
    const name = p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root";
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    console.log(`${out}/${name}.png  ${page.url()}`);
  } catch (e) {
    console.log(`FAILED ${p}: ${(e as Error).message}`);
  }
}
await browser.close();
