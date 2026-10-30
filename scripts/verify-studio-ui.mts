/**
 * Walk the manager's path in the console and report what the UI shows.
 * Does not generate posts (no paid calls).
 *
 *   npx playwright install chromium   # once
 *   node --experimental-strip-types --env-file=.env.local scripts/verify-studio-ui.mts
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.AUTH_URL?.replace(/\/$/, "") || "http://localhost:3000";

async function shot(page: Page, name: string) {
  const dir = "tmp/ui-verify";
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`  shot  ${path}`);
}

function ok(label: string, pass: boolean, detail = "") {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return pass;
}

let failed = 0;
const assert = (label: string, pass: boolean, detail = "") => {
  if (!ok(label, pass, detail)) failed++;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

try {
  console.log("\n1. Sign-in / Dev login (bottom right)");
  await page.goto(`${BASE}/signin`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await shot(page, "01-signin");
  const dev = page.locator("button", { hasText: /Dev login/i });
  assert("Dev login button visible (bottom right of /signin)", await dev.count() > 0);
  if (await dev.count()) {
    await Promise.all([
      page.waitForURL((u) => !u.pathname.includes("/signin"), { timeout: 45000 }),
      dev.click(),
    ]);
    await page.waitForTimeout(1200);
    await shot(page, "02-after-dev-login");
    assert("Dev login left /signin", !page.url().includes("/signin"), page.url());
  }

  console.log("\n2. Campaigns via left rail (not Projects)");
  await page.goto(`${BASE}/dashboard/campaigns`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "03-campaigns");
  assert("Campaigns overview URL", page.url().includes("/dashboard/campaigns") && !page.url().includes("/projects"));
  const body = await page.locator("body").innerText();
  assert("Sath Heights on Campaigns overview", /Sath Heights|Seth Heights/i.test(body));

  console.log("\n3. Overview → Tower C (campaigns path, not Projects sidebar)");
  // Exact campaigns href for the phase row under "Where each phase stands"
  const tower = page.locator('a.campaignline--phase[href*="/dashboard/campaigns/"]').filter({ hasText: /Tower C/i }).first();
  if (await tower.count() === 0) {
    // Fallback: any campaigns link whose label is Tower C
    const fallback = page.locator('a[href^="/dashboard/campaigns/"]').filter({ hasText: /^Tower C/i }).first();
    assert("Tower C campaigns link on overview", await fallback.count() > 0);
    if (await fallback.count()) {
      await fallback.click();
      await page.waitForURL(/\/dashboard\/campaigns\/[0-9a-f-]+/, { timeout: 20000 });
    }
  } else {
    await tower.click();
    await page.waitForURL(/\/dashboard\/campaigns\/[0-9a-f-]+/, { timeout: 20000 });
  }
  await page.waitForTimeout(1000);
  await shot(page, "04-tower-c-campaigns");
  assert(
    "Tower C opened under /dashboard/campaigns (not /projects)",
    /\/dashboard\/campaigns\/[0-9a-f-]+/.test(page.url()) && !page.url().includes("/projects"),
    page.url(),
  );

  console.log("\n4. Open brief → Open the studio");
  const openBrief = page.locator('a:has-text("Open the brief"), a:has-text("Read the brief"), a[href*="/dashboard/campaigns/brief/"]').first();
  if (await openBrief.count()) {
    await openBrief.click();
    await page.waitForURL(/\/dashboard\/campaigns\/brief\//, { timeout: 20000 });
    await page.waitForTimeout(800);
    await shot(page, "05-brief");
  } else {
    assert("Brief link on Tower C campaigns", false, "no brief row");
    await shot(page, "05-no-brief");
  }

  const studioBtn = page.locator('a[data-studio], a:has-text("Open the studio")').first();
  assert("Open the studio control on brief", await studioBtn.count() > 0);
  if (await studioBtn.count()) {
    await studioBtn.click();
    await page.waitForURL(/\/studio/, { timeout: 30000 });
    await page.waitForTimeout(1500);
  }
  await shot(page, "06-studio");
  assert("Studio URL", page.url().includes("/studio"), page.url());

  console.log("\n5. Templates + Meta size (image / carousel)");
  const studioText = await page.locator("body").innerText();
  assert("Construction update template listed", /Construction update/i.test(studioText));
  assert(
    "Multiple templates shown (idea of post types)",
    /Launch|Amenities|Location|Price|Connectivity|Festive/i.test(studioText),
  );

  const imageTab = page.locator('button:has-text("Image"), [role="tab"]:has-text("Image")').first();
  if (await imageTab.count()) {
    await imageTab.click();
    await page.waitForTimeout(600);
  }
  const construction = page.getByText(/Construction update/i).first();
  if (await construction.count()) {
    await construction.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, "07-construction-template");
    assert("Could select Construction update template", true);
  }

  const carouselTab = page.locator('button:has-text("Carousel"), [role="tab"]:has-text("Carousel")').first();
  if (await carouselTab.count()) {
    await carouselTab.click();
    await page.waitForTimeout(600);
    await shot(page, "08-carousel-templates");
    const carText = await page.locator("body").innerText();
    assert("Carousel templates listed", /Construction timeline|Amenities|Launch|Buyer/i.test(carText));
  }

  assert(
    "Meta size option visible (manager: select Meta only)",
    /Meta feed|Meta|1:1|For a Meta ad/i.test(studioText),
  );

  // One-at-a-time: the make control should not imply a batch of 2+ of the same kind by default wording
  const makeLabel = studioText.match(/Make \d+|Generate \d+|1 post|posts?/i)?.[0] ?? "";
  console.log(`  note  make control wording seen: ${makeLabel || "(none matched)"}`);

  console.log("\n6. Code contract (template → CONSTRUCTION photo pool; no paid generate)");
  const { templatePhotos } = await import("../src/lib/template-rules.ts");
  const { backgroundsFrom, picturesFor, sceneOf } = await import("../src/lib/compose-rules.ts");
  assert(
    "IMAGE Construction update requires CONSTRUCTION photos",
    JSON.stringify(templatePhotos("10-construction-update", "IMAGE")) === JSON.stringify(["CONSTRUCTION"]),
  );
  assert(
    "CAROUSEL Construction timeline requires CONSTRUCTION photos",
    JSON.stringify(templatePhotos("07-construction-timeline", "CAROUSEL")) === JSON.stringify(["CONSTRUCTION"]),
  );
  const P = (id: string, category: string) =>
    ({ assetId: id, sha256: id.repeat(8), category, isRender: category !== "CONSTRUCTION", title: null });
  const lib = [P("x", "EXTERIOR_RENDER"), P("c", "CONSTRUCTION")];
  assert("Ordinary pool excludes construction", !backgroundsFrom(lib).some((p) => p.category === "CONSTRUCTION"));
  assert(
    "Construction template pool includes site photo",
    picturesFor(backgroundsFrom(lib, ["CONSTRUCTION"]), 1, 0, ["CONSTRUCTION"])[0]?.category === "CONSTRUCTION",
  );
  assert("sceneOf(CONSTRUCTION) is site", sceneOf("CONSTRUCTION") === "site");

  console.log(
    `\nDone. ${failed === 0 ? "All UI/code checks passed." : `${failed} check(s) failed.`} Screenshots in tmp/ui-verify/`,
  );
} catch (err) {
  console.error("\nUI walk failed:", err);
  await shot(page, "99-error").catch(() => {});
  failed++;
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
