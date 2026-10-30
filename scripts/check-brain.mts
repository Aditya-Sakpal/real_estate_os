// Functional check of the Project Brain, driven through the real console.
//
//   node --experimental-strip-types --env-file=.env.local scripts/check-brain.mts
//
// The editing, signing and publishing halves go through the browser and the
// real server actions. What every consumer will see is asked of the real
// resolveBrain(), loaded straight from source, because the whole guarantee of
// the Brain is what that function refuses to return.
import { encode } from "next-auth/jwt";
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import postgres from "postgres";
import { publishBrain, resolveBrain } from "../src/lib/brain.ts";
import { groupHash, type FieldValues } from "../src/lib/brain-rules.ts";
import { phaseReadiness } from "../src/lib/readiness.ts";
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

const PRICER = "brain-pricer@example-tenant.test";
const SEEDED = [PRICER];

const wipe = async () => {
  await sql`DELETE FROM memberships m USING users u
            WHERE m.user_id = u.id AND u.email = ANY(${SEEDED})`;
  await sql`DELETE FROM users WHERE email = ANY(${SEEDED})`;
};
await wipe();

const [admin] = await sql<{ id: string; email: string; name: string | null }[]>`
  SELECT id, email::text AS email, name FROM users ORDER BY created_at LIMIT 1`;
const [org] = await sql<{ id: string }[]>`
  SELECT o.id FROM orgs o
  JOIN memberships m ON m.org_id = o.id AND m.user_id = ${admin.id} AND m.role = 'ORG_ADMIN'
  ORDER BY m.created_at
  LIMIT 1`;
if (!org) throw new Error("No org where the first user is ORG_ADMIN");

type Node = { id: string; name: string; kind: string; path: string };

/**
 * The suite builds its own project and phase, and takes nothing that was
 * already here.
 *
 * It used to grab whichever project and phase came first and then delete
 * every Brain in the organisation at both ends of the run. On a throwaway
 * database that is tidy. On the one a person is using to evaluate the
 * product, it silently destroys their work, and the first they know of it is
 * a 404 where their draft used to be. A check that cannot run without eating
 * the developer's data is a check nobody can leave in `npm run check`.
 */
const [region] = await sql<Node[]>`
  SELECT id, name, kind, path::text AS path FROM scope_nodes
  WHERE org_id = ${org.id} AND kind = 'REGION' ORDER BY path LIMIT 1`;
if (!region) throw new Error("No region to hang the Brain fixtures off");

const FIXTURE_SLUGS = ["brain_check_project", "brain_check_phase", "tower_z_check", "brain_check_exempt"];

/** Idempotent: a run that dies partway leaves the next one a clean slate. */
const dropFixtures = async () => {
  await sql`DELETE FROM scope_nodes
            WHERE org_id = ${org.id} AND slug = ANY(${FIXTURE_SLUGS})`;
};
await dropFixtures();

const [project] = await sql<Node[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${region.id}, 'PROJECT', 'Brain Check Project', 'brain_check_project',
          ${`${region.path}.brain_check_project`}::ltree)
  RETURNING id, name, kind, path::text AS path`;
const [phase] = await sql<Node[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Brain Check Phase', 'brain_check_phase',
          ${`${region.path}.brain_check_project.brain_check_phase`}::ltree)
  RETURNING id, name, kind, path::text AS path`;

// Advertisable, because publishing a phase Brain asks the RERA gate. Written
// straight in rather than through the console form: this is a fixture for
// the Brain's rules, and the registration flow has its own suite.
const CHECK_REGISTRATION = "P52100077001";
await sql`
  INSERT INTO registration_records
    (scope_node_id, org_id, status, registration_no, state_code, valid_from, valid_to, verified_at)
  VALUES (${phase.id}, ${org.id}, 'VERIFIED', ${CHECK_REGISTRATION}, 'MH',
          current_date - 30, current_date + 400, now())`;

const filing = { registration_no: CHECK_REGISTRATION };

/**
 * Anything this run wrote, gone, and nothing else.
 *
 * Scoped to the fixture nodes rather than to the organisation. Published
 * versions are immutable to the app role on purpose, so this runs as the
 * owner; the audit rows go by target id for the same reason, since
 * `action LIKE 'brain.%'` would take the developer's history with them.
 */
/** The towers made later in the run (the blocked one, the exempt one). */
const laterFixtureIds: string[] = [];
const fixtureNodeIds = () => [project.id, phase.id, ...laterFixtureIds];
const clearBrains = async () => {
  await sql`DELETE FROM brain_versions
            WHERE org_id = ${org.id} AND scope_node_id = ANY(${fixtureNodeIds()})`;
  await sql`DELETE FROM audit_log
            WHERE org_id = ${org.id} AND action LIKE 'brain.%'
              AND target_id = ANY(${fixtureNodeIds()})`;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});

const openAs = async (id: string, email: string, name: string | null) => {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  // A cold route can outlast puppeteer's 30s default; a navigation that times
  // out fails the suite for a reason unrelated to the rule being checked.
  p.setDefaultNavigationTimeout(90000);
  await p.setViewport({ width: 1440, height: 1200 });
  await p.setCookie({
    name: COOKIE,
    value: await encode({
      token: { sub: id, userId: id, email, name },
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
  await p.setCookie({ name: "salesdesk.org", value: org.id, domain: "localhost", path: "/", sameSite: "Lax" });
  return { ctx, page: p };
};

const { ctx: adminCtx, page } = await openAs(admin.id, admin.email, admin.name);

const brainUrl = (nodeId: string) => `${BASE}/dashboard/brain/${nodeId}`;
/** The read-only view, which is what arriving at the screen gives you. */
const open = (nodeId: string) => page.goto(brainUrl(nodeId), { waitUntil: "networkidle0" });
/** The editor. Nothing is editable until somebody asks for it. */
const openEditor = async (nodeId: string) => {
  await page.goto(`${brainUrl(nodeId)}?edit=1`, { waitUntil: "networkidle0" });
  // Wait for the form itself: everything below reads or fills it, and a page
  // still compiling has none of it.
  await page.waitForSelector("#braindraft", { timeout: 30000 }).catch(() => {});
};

/**
 * A refusal once it is actually there. Same reason as the other suites:
 * reading before a server action returns says "the screen said nothing" when
 * what happened is that we looked too soon.
 *
 * The editor is a kept form: a refusal comes back to the form and is said
 * inline, with no redirect and no `?error=`, so there is no address to wait
 * on. What is waited for is the note itself, with text in it. Every caller
 * acts on a page it has just opened, and a save that worked leaves an info
 * note rather than a risk one, so the risk note on screen is the one the
 * action caused, never one left over from before.
 */
const note = async (selector = ".note--risk") => {
  await page
    .waitForFunction(
      (s: string) => !!document.querySelector(s)?.textContent?.trim(),
      { timeout: 30000 },
      selector,
    )
    .catch(() => {});
  return page.$eval(selector, (el) => el.textContent!.trim()).catch(() => "");
};

/**
 * Wait for a publish to land. A publish that worked leaves the editor for the
 * live version, saying so in a signed note the page then takes out of the
 * address, so the dependable sign is `edit=1` going away. A refusal stays in
 * the editor, and the check after this reads the database either way.
 */
const leftEditor = () =>
  page
    .waitForFunction(() => new URL(location.href).searchParams.get("edit") !== "1", {
      timeout: 30000,
    })
    .catch(() => {});

/**
 * Click something, re-querying it at the moment of the click.
 *
 * `page.click` resolves the element and then clicks it, and React can
 * re-render in between: the handle detaches and the run dies with "Node is
 * detached from document", which says nothing about the Brain. Querying
 * inside the page closes that window.
 */
const clickIn = async (selector: string) => {
  await page.waitForSelector(selector, { timeout: 20000 });
  await page.evaluate((s: string) => {
    (document.querySelector(s) as HTMLElement | null)?.click();
  }, selector);
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
};

/** Type a group's fields and save. Values keyed by field, as a person types them. */
const fill = async (group: string, values: Record<string, string>) => {
  await type(group, values);
  // The editor's buttons all send the one form; the save is the one whose
  // intent says so.
  await clickIn('button[form="braindraft"][name="intent"][value="save"]');
};

/**
 * Click a group's sign button.
 *
 * A missing button is a state, not a timeout: the card may already be signed,
 * or unchanged from the live version, and both legitimately remove it. Say
 * which, because "waiting for selector failed" is a fact about puppeteer
 * rather than about the Brain.
 */
const sign = async (group: string) => {
  const sel = `[data-sign="${group}"]`;
  const button = await page.waitForSelector(sel, { timeout: 20000 }).catch(() => null);
  if (!button) {
    throw new Error(
      `no sign button for ${group}: the card reads "${await pill(group)}" at ${page.url()}`,
    );
  }
  await page.evaluate((s: string) => {
    (document.querySelector(s) as HTMLElement | null)?.click();
  }, sel);
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});
};

/** Type a group's fields WITHOUT saving, the way a person filling a form does. */
const type = async (_group: string, values: Record<string, string>) => {
  for (const [key, v] of Object.entries(values)) {
    await page.waitForSelector(`#braindraft [name="${key}"]`, { timeout: 30000 });
    await page.$eval(
      `#braindraft [name="${key}"]`,
      (el, value) => {
        (el as HTMLInputElement | HTMLTextAreaElement).value = value;
      },
      v,
    );
  }
};

/** The status pill on one group's card, in the editor. */
const pill = (group: string) =>
  page
    .$eval(
      `[data-sign="${group}"]`,
      (b) => b.closest("section")!.querySelector(".card__head .pill")!.textContent!.trim(),
    )
    .catch(async () =>
      // A signed group has no sign button, so find its card by heading.
      page.evaluate((g: string) => {
        const wanted = { PRICE: "Price and payment", RERA: "RERA facts",
          CLAIMS: "Claims and never-say" }[g];
        const card = [...document.querySelectorAll("section.card")].find(
          (c) => c.querySelector("h2")?.textContent?.trim() === wanted);
        return card?.querySelector(".card__head .pill")?.textContent?.trim() ?? "";
      }, group),
    );

// ---------------------------------------------------------------------------
console.log("\nthe screen, and opening a draft");

await open(phase.id);
check("the Brain opens for a phase", page.url().includes(phase.id), page.url());
const heading = await page.$eval("h1", (h) => h.textContent!.trim()).catch(() => "");
check("and names what it is about", heading.includes(phase.name), heading);

await clickIn("[data-edit]");
const [draft] = await sql<{ id: string; version: number; state: string }[]>`
  SELECT id, version, state FROM brain_versions
  WHERE org_id = ${org.id} AND scope_node_id = ${phase.id}`;
check("a draft is created", !!draft);
check("as version 1", draft?.version === 1, String(draft?.version));
check("and it starts as a DRAFT, not live", draft?.state === "DRAFT", draft?.state);

// The registration number is already on the record the publish gate reads,
// so a draft starts from the filing instead of asking somebody to retype it.
// A typo there prints a false number on every advertisement.
const [prefilled] = await sql<{ value: string }[]>`
  SELECT value FROM brain_fields
  WHERE brain_version_id = ${draft.id} AND field_key = 'rera.registration_no'`;
check("and it opens carrying the number the phase is registered under",
  prefilled?.value === filing.registration_no, prefilled?.value ?? "nothing");

// ---------------------------------------------------------------------------
console.log("\na draft is invisible to everything that quotes");

await openEditor(phase.id);
await fill("PRICE", { "price.base_psf": "14,500", "price.booking_amount": "2,00,000" });

const [typed] = await sql<{ value: string }[]>`
  SELECT value FROM brain_fields
  WHERE brain_version_id = ${draft.id} AND field_key = 'price.base_psf'`;
check("the typed price is stored", !!typed, "nothing written");
// Indian separators in, a number out, so the same price typed two ways does
// not read as a change that needs signing again.
check("with the separators stripped", typed?.value === "14500", typed?.value);

// THE guarantee. Everything downstream reads this function, so if a draft
// leaks here the signatures are decoration.
const beforePublish = await resolveBrain(org.id, phase.id);
check("resolveBrain returns nothing while it is only a draft",
  Object.keys(beforePublish?.values ?? {}).length === 0,
  JSON.stringify(beforePublish?.values));

// ---------------------------------------------------------------------------
console.log("\nsigning attests to what is on screen, saved or not");

// The bug this replaces: the fields lived in one form and the sign button in
// another, so typing values and clicking sign posted neither. The signature
// was taken against the last SAVED values, which on a fresh draft is nothing,
// and it looked entirely legitimate. Three groups signed, no facts recorded,
// and publishing then refused for a reason that made no sense on screen.
// The net under the screen, tested where RERA is genuinely untouched. Even
// with the form right, a group whose required fields are empty cannot be
// signed: a signature over nothing is worse than no signature, because it
// looks exactly like one.
await openEditor(phase.id);
await sign("RERA");
const emptySig = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM brain_signatures
  WHERE brain_version_id = ${draft.id} AND field_group = 'RERA'`;
check("an empty required group cannot be signed at all", emptySig[0].n === 0, `${emptySig[0].n}`);
const emptyNote = await note();
check("and says what is missing",
  /still empty|nothing to sign/i.test(emptyNote), emptyNote.slice(0, 90));

await openEditor(phase.id);
await type("RERA", {
  "rera.registration_no": CHECK_REGISTRATION,
  "rera.qr_url": "https://maharera.maharashtra.gov.in/",
  "rera.declared_completion": "2030-03-31",
});
await sign("RERA");

const typedNotSaved = await sql<{ field_key: string; value: string }[]>`
  SELECT field_key, value FROM brain_fields
  WHERE brain_version_id = ${draft.id} AND field_key LIKE 'rera.%' ORDER BY field_key`;
check("signing saves what was typed but never saved",
  typedNotSaved.find((r) => r.field_key === "rera.registration_no")?.value === CHECK_REGISTRATION,
  JSON.stringify(typedNotSaved));

await openEditor(phase.id);
check("and the signature covers those values, not an empty group",
  (await pill("RERA")).includes("Signed"), await pill("RERA"));

const reraSig = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM brain_signatures
  WHERE brain_version_id = ${draft.id} AND field_group = 'RERA'`;
check("exactly one RERA signature, not one per attempt", reraSig[0].n === 1, `${reraSig[0].n}`);


// ---------------------------------------------------------------------------
console.log("\nsigning, and what an edit does to a signature");

await openEditor(phase.id);
check("price is not signed yet", (await pill("PRICE")).includes("Needs signing"), await pill("PRICE"));
await sign("PRICE");
await openEditor(phase.id);
check("signing it says so", (await pill("PRICE")).includes("Signed"), await pill("PRICE"));

// Named, not "the first row": other groups are signed by now, and a query
// without an ORDER BY was asserting against whichever one came back.
const [sigRow] = await sql<{ signed_by: string; field_group: string }[]>`
  SELECT signed_by, field_group FROM brain_signatures
  WHERE brain_version_id = ${draft.id} AND field_group = 'PRICE'`;
check("the signature records who gave it", sigRow?.signed_by === admin.id);
check("against the group they signed", sigRow?.field_group === "PRICE", sigRow?.field_group);

// Editing after signing must not leave a signature attesting to a number
// nobody signed. This is the rule the whole hash design exists for.
await fill("PRICE", { "price.base_psf": "15500", "price.booking_amount": "200000" });
await openEditor(phase.id);
check("editing after signing marks it changed",
  (await pill("PRICE")).includes("Changed since signing"), await pill("PRICE"));

// Scoped to PRICE: the point is that editing does not DELETE the signature it
// invalidated, not how many signatures the draft happens to carry.
const sigsAfterEdit = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM brain_signatures
  WHERE brain_version_id = ${draft.id} AND field_group = 'PRICE'`;
check("the old signature is kept, not deleted", sigsAfterEdit[0].n === 1, `${sigsAfterEdit[0].n}`);

// Put it back and the original signature applies again: that person really
// did sign exactly these values.
await fill("PRICE", { "price.base_psf": "14500", "price.booking_amount": "200000" });
await openEditor(phase.id);
check("putting the values back restores the signature",
  (await pill("PRICE")).includes("Signed"), await pill("PRICE"));

// ---------------------------------------------------------------------------
console.log("\npublishing refuses what it should");

await openEditor(phase.id);
await fill("RERA", {
  "rera.registration_no": CHECK_REGISTRATION,
  "rera.qr_url": "https://maharera.maharashtra.gov.in/",
  "rera.declared_completion": "2028-12-31",
});
await sign("RERA");

// Marketing possession before the filing's completion date. The brand
// approver's promise measured against the compliance officer's filing, and
// refused at the SIGNATURE now, not only at publish: a signature on a date
// the filing does not support looked exactly like a good one until somebody
// pressed Publish.
await openEditor(phase.id);
await fill("CLAIMS", {
  "claims.possession_date": "2028-06-30",
  // Left empty on purpose: it is the field the inheritance check below needs
  // the project to be the only one that sets.
  "claims.talking_points": "",
  "claims.never_say": "guaranteed returns",
});
await sign("CLAIMS");
const possessionNote = await note();
check("a possession date before the declared completion is refused when it is signed",
  /before the completion date on the registration/i.test(possessionNote), possessionNote.slice(0, 110));
const earlyClaims = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM brain_signatures
  WHERE brain_version_id = ${draft.id} AND field_group = 'CLAIMS'`;
check("and no signature is taken for it", earlyClaims[0].n === 0, `${earlyClaims[0].n}`);
// Dates are written the way the console writes them, not as ISO.
check("the refusal gives both dates as a person reads them",
  /30 June 2028.*31 December 2028/.test(possessionNote), possessionNote.slice(0, 110));

const stillDraft = await sql<{ state: string }[]>`
  SELECT state FROM brain_versions WHERE id = ${draft.id}`;
check("and nothing goes live", stillDraft[0].state === "DRAFT", stillDraft[0].state);
check("so nothing can quote it",
  Object.keys((await resolveBrain(org.id, phase.id))?.values ?? {}).length === 0);

// Fix the date. The group changed, so it needs signing again.
await openEditor(phase.id);
await fill("CLAIMS", {
  "claims.possession_date": "2029-06-30",
  "claims.talking_points": "",
  "claims.never_say": "guaranteed returns",
});
await openEditor(phase.id);
// Somebody who may sign what is waiting is offered one press that signs it
// and publishes, and never a bare Publish that would go out unsigned.
const offer = await page.evaluate(() => ({
  bare: !!document.querySelector("[data-publish]:not([disabled])"),
  signAll: document.querySelector("[data-sign-all]")?.textContent?.trim() ?? "",
}));
check("the screen will not offer to publish an unsigned draft", offer.bare === false);
check("it offers to sign and publish in one press instead",
  /^Sign and publish version/.test(offer.signAll), offer.signAll);

// The button is presentation. The action is the gate, so an unsigned publish
// is asked of it directly.
const unsigned = await publishBrain({ orgId: org.id, actorUserId: admin.id, nodeId: phase.id });
check("and the server refuses it too",
  !unsigned.ok && /needs signing|still needs/i.test(unsigned.message),
  unsigned.ok ? "published" : unsigned.message.slice(0, 90));

// ---------------------------------------------------------------------------
console.log("\nand publishes what it should");

await openEditor(phase.id);
await sign("CLAIMS");

// A registration number nobody filed. Everything else is in order: the phase
// is advertisable, the other two groups are signed, and the number that
// would be printed on every advertisement is still somebody else's. Whoever
// signs the RERA facts is reading the form, not the record, so the signature
// itself asks the record now and refuses.
await openEditor(phase.id);
await fill("RERA", {
  "rera.registration_no": "P52100099999",
  "rera.qr_url": "https://maharera.maharashtra.gov.in/",
  "rera.declared_completion": "2028-12-31",
});
await openEditor(phase.id);
await sign("RERA");

const wrongNumberNote = await note();
check("a registration number that is not the phase's filing is refused when it is signed",
  new RegExp(`registered as ${filing.registration_no}`, "i").test(wrongNumberNote),
  wrongNumberNote.slice(0, 110));
await openEditor(phase.id);
check("so the RERA facts are left unsigned",
  (await pill("RERA")).includes("Changed since signing"), await pill("RERA"));
// The publish button is presentation; the action is the gate.
const wrongNumberPublish = await publishBrain({ orgId: org.id, actorUserId: admin.id, nodeId: phase.id });
check("and the server will not publish it either", !wrongNumberPublish.ok,
  wrongNumberPublish.ok ? "published" : wrongNumberPublish.message.slice(0, 90));
const [notLive] = await sql<{ state: string }[]>`
  SELECT state FROM brain_versions WHERE id = ${draft.id}`;
check("so the draft on an advertisable phase stays a draft",
  notLive?.state === "DRAFT", notLive?.state);

// Back to the filing. These are the values signed earlier, so the original
// signature applies again and nobody is dragged back to sign a correction.
await openEditor(phase.id);
await fill("RERA", {
  "rera.registration_no": filing.registration_no,
  "rera.qr_url": "https://maharera.maharashtra.gov.in/",
  "rera.declared_completion": "2028-12-31",
});
await openEditor(phase.id);
check("putting the filed number back restores the signature it had",
  (await pill("RERA")).includes("Signed"), await pill("RERA"));
// Publish is one of the editor form's buttons now, so it sends what is on
// screen too; nothing was changed, so the signatures still stand.
await clickIn("[data-publish]");
await leftEditor();

const [livePhase] = await sql<{ state: string; version: number; published_by: string }[]>`
  SELECT state, version, published_by FROM brain_versions WHERE id = ${draft.id}`;
check("the version goes live", livePhase?.state === "PUBLISHED", livePhase?.state);
check("recording who published it", livePhase?.published_by === admin.id);

const resolved = await resolveBrain(org.id, phase.id);
check("and now it resolves", resolved?.values["price.base_psf"] === "14500",
  JSON.stringify(resolved?.values));
check("carrying every signed group",
  resolved?.values["rera.registration_no"] === CHECK_REGISTRATION &&
    resolved?.values["claims.never_say"] === "guaranteed returns");
check("and when it was read, so a quote can pin it", !!resolved?.readAt);

const [pubAudit] = await sql<{ metadata: Record<string, unknown> }[]>`
  SELECT metadata FROM audit_log WHERE org_id = ${org.id} AND action = 'brain.published'
  ORDER BY id DESC LIMIT 1`;
check("publishing is audited", !!pubAudit);
check("naming what changed", Array.isArray(pubAudit?.metadata?.changed),
  JSON.stringify(pubAudit?.metadata));

// A published fact is immutable, in the database and not by convention.
let edited = false;
try {
  await sql.begin(async (tx) => {
    await tx`UPDATE brain_fields SET value = '99999'
             WHERE brain_version_id = ${draft.id} AND field_key = 'price.base_psf'`;
  });
  edited = true;
} catch {
  edited = false;
}
check("a published fact cannot be edited afterwards", !edited);

// ---------------------------------------------------------------------------
console.log("\nfacts inherit down the tree");

// A never-say list written once on the project, inherited by every tower.
await open(project.id);
await clickIn("[data-edit]");
await openEditor(project.id);
// No RERA card on a project: registration attaches to a PHASE, because each
// phase is a standalone registration under the explanation to Section 3.
const projectCards = await page.$$eval("section.card h2", (h) =>
  h.map((x) => x.textContent!.trim()));
check("a project is never asked for a registration",
  !projectCards.includes("RERA facts"), projectCards.join(", "));

// Signed and published in ONE press, which is what an admin holding every key
// asked for: four buttons to say one thing was the screen making them do the
// bookkeeping. The claims are typed and deliberately NOT saved first, because
// the press has to save what is on screen before it attests to anything.
await fill("PRICE", { "price.base_psf": "9000", "price.booking_amount": "100000" });
await openEditor(project.id);
await type("CLAIMS", {
  "claims.possession_date": "2031-01-31",
  "claims.talking_points": "Township of nine towers",
  "claims.never_say": "assured rental",
});
const oneLabel = await page.$eval("[data-sign-all]", (b) => b.textContent!.trim()).catch(() => "");
check("one press is offered, and says it signs and publishes",
  /^Sign and publish version/.test(oneLabel), oneLabel);
await clickIn("[data-sign-all]");
await leftEditor();
const liveNote = await page
  .waitForFunction(
    () => [...document.querySelectorAll(".note--info")].map((n) => n.textContent?.trim() ?? "")
      .find((t) => /is live\./.test(t)) ?? null,
    { timeout: 15000 },
  )
  .then((h) => h.jsonValue() as Promise<string>)
  .catch(() => "");
check("and says the version is live", /^Version \d+ is live\.$/.test(liveNote), liveNote.slice(0, 60));

const signers = await sql<{ group_key: string; signed_by: string }[]>`
  SELECT s.field_group AS group_key, s.signed_by FROM brain_signatures s
  JOIN brain_versions v ON v.id = s.brain_version_id
  WHERE v.org_id = ${org.id} AND v.scope_node_id = ${project.id}
  ORDER BY s.field_group`;
// The three-way split survives: each section is its own signature, checked
// against its own permission, and a project has no RERA section to sign.
check("each section still gets its own signature",
  signers.map((r) => r.group_key).join(","), "CLAIMS,PRICE");
check("in the name of the person who pressed it",
  signers.every((r) => r.signed_by === admin.id));

const [liveProject] = await sql<{ state: string }[]>`
  SELECT state FROM brain_versions
  WHERE org_id = ${org.id} AND scope_node_id = ${project.id}`;
check("a project-level version publishes", liveProject?.state === "PUBLISHED", liveProject?.state);

const merged = await resolveBrain(org.id, phase.id);
// The tower set its own price, so the tower's wins.
check("the deepest node wins on a fact both set",
  merged?.values["price.base_psf"] === "14500", merged?.values["price.base_psf"]);
// The tower never mentioned talking points, so the project's carry down.
check("and a fact only the project set is inherited",
  merged?.values["claims.talking_points"] === "Township of nine towers",
  merged?.values["claims.talking_points"]);
check("resolution names both versions it drew from",
  (merged?.sources.length ?? 0) === 2, `${merged?.sources.length} sources`);

// ---------------------------------------------------------------------------
console.log("\nan exempt tower: no RERA facts, and the project's facts are its own");

// An exempt tower registers nothing. It used to be asked for a registration
// number and a completion date anyway, both required, so it could never
// publish: the only way past the required rule was to invent a number, and
// an invented one is refused. Written straight in, like the registration
// above; the attestation flow has its own suite. The exemption sits on the
// fixture project and goes with it.
const [exemptPhase] = await sql<Node[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Brain Check Exempt', 'brain_check_exempt',
          ${`${project.path}.brain_check_exempt`}::ltree)
  RETURNING id, name, kind, path::text AS path`;
laterFixtureIds.push(exemptPhase.id);
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status)
  VALUES (${exemptPhase.id}, ${org.id}, 'EXEMPT')`;
await sql`
  INSERT INTO project_exemptions (scope_node_id, org_id, land_area_sqm, apartment_count,
                                  state_code, attested_by, attested_at, expires_at)
  VALUES (${project.id}, ${org.id}, 400, 6, 'MH', ${admin.id}, now(), now() + interval '90 days')`;

// Before it has a Brain of its own, the project's published facts are what
// every advertisement for it resolves to, so the facts gate is done.
const exemptGate = (await phaseReadiness(org.id, exemptPhase.id))?.gates[1];
check("readiness counts the project's published facts as the exempt tower's",
  exemptGate?.state === "done" && exemptGate?.detail === "Uses the project's facts",
  JSON.stringify(exemptGate));

await open(exemptPhase.id);
const exemptCards = await page.$$eval("section.card h2", (h) =>
  h.map((x) => x.textContent!.trim()));
check("an exempt tower's Brain has no RERA facts",
  !exemptCards.includes("RERA facts") && exemptCards.includes("Price and payment"),
  exemptCards.join(", "));
// What it inherits is shown, with where it comes from, rather than "Not set".
const shownPrice = await page.evaluate(() => {
  const f = [...document.querySelectorAll(".formfield")].find((x) =>
    x.querySelector(".formfield__label")?.textContent?.startsWith("Base price per sq ft"));
  return {
    value: f?.querySelector(".formfield__value")?.textContent?.trim() ?? "",
    from: f?.querySelector(".formfield__label .hint")?.textContent?.trim() ?? "",
  };
});
check("and shows the price it takes from the project, saying where from",
  shownPrice.value === "Rs 9,000" && shownPrice.from === `from ${project.name}`,
  JSON.stringify(shownPrice));

await clickIn("[data-edit]");
await openEditor(exemptPhase.id);
check("the editor asks it for no registration number",
  (await page.$('#braindraft [name="rera.registration_no"]')) === null);
const pricePlaceholder = await page
  .$eval('#braindraft [name="price.base_psf"]', (el) => (el as HTMLInputElement).placeholder)
  .catch(() => "");
check("an empty price box shows the inherited price, not an example",
  pricePlaceholder === `Rs 9,000, from ${project.name}`, pricePlaceholder);
const [exemptDraft] = await sql<{ id: string }[]>`
  SELECT id FROM brain_versions
  WHERE org_id = ${org.id} AND scope_node_id = ${exemptPhase.id} AND state = 'DRAFT'`;
const exemptRera = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM brain_fields
  WHERE brain_version_id = ${exemptDraft?.id ?? null} AND field_key LIKE 'rera.%'`;
check("its draft opens carrying no registration", !!exemptDraft && exemptRera[0].n === 0,
  `${exemptRera[0].n} RERA fields`);

// Nothing typed: the price is the project's, and a required field answered
// from above is answered.
const exemptLabel = await page.$eval("[data-sign-all]", (b) => b.textContent!.trim()).catch(() => "");
check("it is offered one press that signs and publishes",
  /^Sign and publish version/.test(exemptLabel), exemptLabel);
await clickIn("[data-sign-all]");
await leftEditor();
const [exemptLive] = await sql<{ state: string }[]>`
  SELECT state FROM brain_versions
  WHERE org_id = ${org.id} AND scope_node_id = ${exemptPhase.id}`;
check("an exempt tower publishes on the project's facts",
  exemptLive?.state === "PUBLISHED", exemptLive?.state ?? (await note()));
const exemptResolved = await resolveBrain(org.id, exemptPhase.id);
check("and resolves to the project's price, with no registration in it",
  exemptResolved?.values["price.base_psf"] === "9000" &&
    !Object.keys(exemptResolved?.values ?? {}).some((k) => k.startsWith("rera.")),
  JSON.stringify(exemptResolved?.values));

// ---------------------------------------------------------------------------
console.log("\nSection 3: a blocked phase publishes nothing");

// Idempotent, for the same reason the other suites' fixtures are: a run that
// dies partway should leave the next one failing on the bug, not on a path
// that is already taken.
await sql`DELETE FROM scope_nodes
          WHERE org_id = ${org.id} AND slug = 'tower_z_check'`;
const [blocked] = await sql<{ id: string }[]>`
  INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
  VALUES (${org.id}, ${project.id}, 'PHASE', 'Tower Z Check', 'tower_z_check',
          ${`${project.path}.tower_z_check`}::ltree)
  RETURNING id`;
laterFixtureIds.push(blocked.id);

await open(blocked.id);
await clickIn("[data-edit]");
await openEditor(blocked.id);
await fill("PRICE", { "price.base_psf": "14500", "price.booking_amount": "200000" });
await fill("RERA", {
  "rera.registration_no": "P52100088888",
  "rera.qr_url": "",
  "rera.declared_completion": "2028-12-31",
});
await fill("CLAIMS", {
  "claims.possession_date": "2029-06-30",
  "claims.talking_points": "x",
  "claims.never_say": "guaranteed returns",
});
await openEditor(blocked.id);
for (const g of ["PRICE", "CLAIMS"]) await sign(g);

// No filing, so no registration number it may state: the RERA facts are
// refused at the signature, before anybody gets as far as Publish.
await openEditor(blocked.id);
await sign("RERA");
const unfiledNote = await note();
check("a phase with no filing cannot have a registration number signed",
  /no registration number on file/i.test(unfiledNote), unfiledNote.slice(0, 100));
const [blockedDraft] = await sql<{ id: string }[]>`
  SELECT id FROM brain_versions
  WHERE org_id = ${org.id} AND scope_node_id = ${blocked.id} AND state = 'DRAFT'`;
const unfiledSigs = await sql<{ n: number }[]>`
  SELECT count(*)::int AS n FROM brain_signatures
  WHERE brain_version_id = ${blockedDraft.id} AND field_group = 'RERA'`;
check("and no signature is taken", unfiledSigs[0].n === 0, `${unfiledSigs[0].n}`);

// The gate is a second, separate wall. A RERA signature that got there anyway
// (written straight in, which the app role cannot do) must still publish
// nothing on a phase nobody may advertise.
const blockedValues: FieldValues = {};
for (const r of await sql<{ field_key: string; value: string | null }[]>`
  SELECT field_key, value FROM brain_fields WHERE brain_version_id = ${blockedDraft.id}`) {
  blockedValues[r.field_key] = r.value;
}
await sql`
  INSERT INTO brain_signatures (brain_version_id, org_id, field_group, group_hash, signed_by)
  VALUES (${blockedDraft.id}, ${org.id}, 'RERA', ${groupHash("RERA", blockedValues)}, ${admin.id})`;

await openEditor(blocked.id);
// If this is disabled the click below does nothing, and "it stayed a draft"
// would pass for the wrong reason. Assert the screen is actually offering it.
const offersPublish = await page.$eval(
  "[data-publish]",
  (b) => !(b as HTMLButtonElement).disabled,
).catch(() => false);
const groupPills = await page.$$eval(".card__head .pill", (ps) =>
  ps.map((x) => x.textContent!.trim()));
check("the screen offers to publish a fully signed draft", offersPublish,
  groupPills.join(" | "));
await clickIn("[data-publish]");

const blockedNote = await note();
check("a fully signed draft on an unregistered phase is still refused",
  /can't be advertised|cannot be advertised|not registered/i.test(blockedNote), blockedNote.slice(0, 100));
const [blockedState] = await sql<{ state: string }[]>`
  SELECT state FROM brain_versions
  WHERE org_id = ${org.id} AND scope_node_id = ${blocked.id}`;
check("so it stays a draft", blockedState?.state === "DRAFT", blockedState?.state);
check("and resolves to nothing at that phase",
  Object.keys((await resolveBrain(org.id, blocked.id))?.values ?? {}).length === 0 ||
    // The project above it is published, so what it inherits is the project's
    // and never the unsigned tower's.
    (await resolveBrain(org.id, blocked.id))?.values["price.base_psf"] === "9000",
  JSON.stringify((await resolveBrain(org.id, blocked.id))?.values));

// ---------------------------------------------------------------------------
console.log("\nthree signatures, three different people");

// A role that may sign the price and nothing else. Code checks a permission,
// never a role name, so the tenant's own invented role works exactly as a
// shipped one would.
await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = 'C_PRICER'`;
await sql`
  INSERT INTO org_roles (org_id, key, label, description, min_kind, can_delegate,
                         source, permissions)
  VALUES (${org.id}, 'C_PRICER', 'Pricing only', 'Signs price and nothing else.',
          'ORG', false, 'CUSTOM', ${["brain:read", "brain.price:approve", "member:read"]})`;

const [pricer] = await sql<{ id: string }[]>`
  INSERT INTO users (email, email_domain, name)
  VALUES (${PRICER}, 'example-tenant.test', 'Only Pricing')
  RETURNING id`;
const [rootNode] = await sql<{ id: string }[]>`
  SELECT id FROM scope_nodes WHERE org_id = ${org.id} AND kind = 'ORG' LIMIT 1`;
await sql`
  INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
  VALUES (${pricer.id}, ${org.id}, ${rootNode.id}, 'C_PRICER', 'ACTIVE', now())`;

// The admin signed all three groups above, so nothing is awaiting anybody.
// Edit them back to unsigned, which is the state a real approver is called
// into: somebody changed the numbers and three people have to look again.
await openEditor(blocked.id);
await fill("PRICE", { "price.base_psf": "16000", "price.booking_amount": "250000" });
await fill("CLAIMS", {
  "claims.possession_date": "2029-09-30",
  "claims.talking_points": "y",
  "claims.never_say": "guaranteed returns",
});

const { ctx: pricerCtx, page: pricerPage } = await openAs(pricer.id, PRICER, "Only Pricing");
await pricerPage.goto(brainUrl(blocked.id), { waitUntil: "networkidle0" });

check("a price approver can open the Brain",
  pricerPage.url().includes(blocked.id), pricerPage.url());

const offered = await pricerPage.$$eval("[data-sign]", (fs) =>
  fs.map((f) => f.getAttribute("data-sign")));
check("and is offered the price signature", offered.includes("PRICE"), offered.join(", "));
check("but not the RERA one", !offered.includes("RERA"), offered.join(", "));
check("nor the claims one", !offered.includes("CLAIMS"), offered.join(", "));

// The group is BOUND to the sign action, so it cannot be swapped by editing
// a form field: the permission checked on the server is the one for the group
// the button was rendered for. What is left to prove is that the mapping is
// enforced rather than decorative, so the price approver signs the price and
// nothing else moves.
const beforeSign = await sql<{ field_group: string }[]>`
  SELECT s.field_group FROM brain_signatures s
  JOIN brain_versions v ON v.id = s.brain_version_id
  WHERE v.scope_node_id = ${blocked.id} AND s.signed_by = ${pricer.id}`;
check("nothing of theirs is signed to begin with", beforeSign.length === 0);

await pricerPage.click('[data-sign="PRICE"]');
await pricerPage.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => {});

const afterSign = await sql<{ field_group: string }[]>`
  SELECT s.field_group FROM brain_signatures s
  JOIN brain_versions v ON v.id = s.brain_version_id
  WHERE v.scope_node_id = ${blocked.id} AND s.signed_by = ${pricer.id}`;
check("the price approver's signature is taken",
  afterSign.some((r) => r.field_group === "PRICE"),
  afterSign.map((r) => r.field_group).join(", "));
check("and it signed only the price",
  afterSign.every((r) => r.field_group === "PRICE"),
  afterSign.map((r) => r.field_group).join(", "));

await pricerCtx.close();

// ---------------------------------------------------------------------------
await adminCtx.close();
await browser.close();

// The fixture subtree goes, and everything hanging off it with it:
// brain_versions, brain_fields, brain_signatures and the registration record
// are all ON DELETE CASCADE from scope_nodes.
await clearBrains();
await dropFixtures();
await sql`DELETE FROM org_roles WHERE org_id = ${org.id} AND key = 'C_PRICER'`;
await wipe();
await sql.end();
// The library holds its own pools, and they keep Node alive after the last
// line. A suite that does not close them never hands back to the next one.
await closeDb();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
