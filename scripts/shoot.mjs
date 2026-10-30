// Screenshot the REAL running console, not a reproduction.
//
//   node --env-file=.env.local scripts/shoot.mjs [outDir]
//
// Authenticated routes are behind a session, so this mints valid Auth.js
// session tokens with the app's own AUTH_SECRET and drives the live dev server.
// The pre-org screens (onboarding, join-request) need a user who has no
// membership, so a throwaway one is created and removed again in the same run.
// Dev tooling only.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";
import postgres from "postgres";
import { resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? ".impeccable/review");
const BASE = process.env.AUTH_URL ?? "http://localhost:3000";
const COOKIE = "authjs.session-token";

const CHROME = [
  process.env.CHROME_PATH ?? "", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("No Chrome or Edge found");

mkdirSync(OUT, { recursive: true });

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

const mint = (u) =>
  encode({
    token: { sub: u.id, userId: u.id, email: u.email, name: u.name },
    secret: process.env.AUTH_SECRET,
    salt: COOKIE,
    maxAge: 60 * 30,
  });

// the real signed-in user
const [member] = await sql`SELECT id, email, name FROM users ORDER BY created_at LIMIT 1`;
if (!member) throw new Error("No user in the database to sign in as");

// Two throwaways: one with nothing, so /onboarding renders; one with a
// pending request, so /join-request and the adjudication rows render. They
// have to be separate users because a pending request redirects away from
// onboarding -- which is correct behaviour, not a defect.
const TEMPS = ["shoot-fresh@example-tenant.test", "shoot-asking@example-tenant.test"];
await sql`DELETE FROM users WHERE email = ANY(${TEMPS})`;

async function throwaway(email, name) {
  const [u] = await sql`
    INSERT INTO users (email, email_domain, name)
    VALUES (${email}, 'example-tenant.test', ${name})
    RETURNING id, email, name`;
  await sql`
    INSERT INTO user_identities (user_id, provider, provider_subject, idp_tenant)
    VALUES (${u.id}, 'google', ${'shoot-' + u.id}, 'example-tenant.test')`;
  return u;
}

const fresh = await throwaway(TEMPS[0], "Priya Nair");
const asking = await throwaway(TEMPS[1], "Rohan Mehta");

// give the throwaway user a pending request into the real org, so the
// adjudication path renders at all; it is removed with the user below
const [realOrg] = await sql`
  SELECT o.id FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${member.id}
  LIMIT 1`;
if (realOrg) {
  await sql`
    INSERT INTO org_join_requests (org_id, user_id, matched_on)
    VALUES (${realOrg.id}, ${asking.id}, 'EMAIL_DOMAIN')
    ON CONFLICT DO NOTHING`;
}

const ROUTES = [
  { name: "signin", path: "/signin", as: null },
  { name: "signin-error", path: "/signin?error=PERSONAL_GOOGLE_ACCOUNT", as: null },
  { name: "onboarding", path: "/onboarding", as: fresh },
  { name: "section-stub", path: "/dashboard/settings", as: member },
  { name: "dashboard", path: "/dashboard", as: member },
  { name: "org-another", path: "/onboarding?another=1", as: member },
  { name: "team", path: "/dashboard/team", as: member },
  { name: "join-request", path: "/join-request", as: asking },
];

const VIEWS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

const problems = [];

for (const r of ROUTES) {
  for (const v of VIEWS) {
    const page = await browser.newPage();
    await page.setViewport({
      width: v.width,
      height: v.height,
      deviceScaleFactor: 1,
      isMobile: !!v.mobile,
      hasTouch: !!v.mobile,
    });
    if (r.as) {
      await page.setCookie({
        name: COOKIE,
        value: await mint(r.as),
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      });
    }

    await page.goto(`${BASE}${r.path}`, { waitUntil: "networkidle0", timeout: 60000 });
    await new Promise((res) => setTimeout(res, 700));

    const landed = new URL(page.url()).pathname;
    const want = new URL(r.path, BASE).pathname;
    if (landed !== want) problems.push(`${r.name}/${v.name}: landed on ${landed}, wanted ${want}`);

    const audit = await page.evaluate(() => {
      const de = document.documentElement;
      const bg = getComputedStyle(document.body).backgroundColor;
      const card = document.querySelector(".auth__card, .card, .setup > *");
      const cs = card ? getComputedStyle(card) : null;
      return {
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        bodyBg: bg,
        cardRadius: cs ? cs.borderRadius : null,
        cardBg: cs ? cs.backgroundColor : null,
        hasShell: !!document.querySelector(".shell"),
        hasRail: !!document.querySelector(".rail"),
        serifWord: !!document.querySelector(".em"),
        inkPill: !!document.querySelector(".btn--ink, .btn--light"),
      };
    });

    await page.screenshot({ path: `${OUT}/${r.name}-${v.name}.png`, fullPage: !v.mobile });

    // Menus are React state, so they never appear in a plain capture. Open them.
    if (r.name === "dashboard") {
      for (const [sel, label] of [[".crumb--root", "orgmenu"], [".avatar", "usermenu"]]) {
        const el = await page.$(sel);
        if (!el) continue;
        await el.click();
        await new Promise((res) => setTimeout(res, 250));
        const shown = await page.$eval("body", () => !!document.querySelector(".menu[role='menu']"));
        if (!shown) problems.push(`${label}/${v.name}: menu did not open`);
        const items = await page.$$eval(".menu[role='menu'] [role='menuitem']", (n) =>
          n.map((x) => x.textContent.trim().replace(/\s+/g, " ")));
        if (v.name === "desktop") console.log(`  ${label.padEnd(10)} ${items.length} items: ${items.join(" | ")}`);
        await page.screenshot({ path: `${OUT}/${label}-${v.name}.png`, fullPage: false });
        await page.keyboard.press("Escape");
        await new Promise((res) => setTimeout(res, 150));
      }
    }
    if (audit.scrollW > audit.clientW + 1) problems.push(`${r.name}/${v.name}: horizontal scroll`);

    if (v.name === "desktop") {
      console.log(`\n[${r.name}]  ${landed}`);
      console.log(`  body bg     ${audit.bodyBg}`);
      console.log(`  card        radius ${audit.cardRadius}  bg ${audit.cardBg}`);
      console.log(`  shell/rail  ${audit.hasShell}/${audit.hasRail}`);
      console.log(`  serif word  ${audit.serifWord}   ink pill ${audit.inkPill}`);
    }
    await page.close();
  }
}

await browser.close();

await sql`DELETE FROM org_join_requests WHERE user_id = ANY(${[fresh.id, asking.id]})`;
await sql`DELETE FROM users WHERE email = ANY(${TEMPS})`;
await sql.end();

console.log(
  problems.length ? `\nPROBLEMS:\n  ${problems.join("\n  ")}` : "\nno layout problems detected",
);
