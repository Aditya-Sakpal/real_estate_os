/**
 * Leads from the property portals, the server half: a portal posting to its
 * link, and a Housing.com account asked for its leads, against a fake
 * Housing.com at its real address.
 *
 * It builds two tenants of its own and removes them. Every buyer number is
 * one the ownership rules treat as junk (ten of one digit, the example
 * numbers), so nothing it stores can ever ring anybody, whatever picks the
 * events up. It never runs `processEvent()`: the step a portal event takes
 * (`portalEvent()`) is driven directly.
 */
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { useVaultKey } from "../src/lib/vault.ts";
import { closeDb, withTenant } from "../src/lib/db/index.ts";
import {
  listPortalAccounts,
  portalAddresses,
  portalEvent,
  portalQueue,
  pullPortalAccounts,
  removePortalAccount,
  savePortalAccount,
  takePush,
  usePortalFetch,
} from "../src/lib/portal-leads.ts";
import { HOUSING_LEADS_URL, housingHash } from "../src/lib/portal-rules.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

process.env.AUTH_SECRET ??= "check-portals-secret";
process.env.CAPTURE_BASE_URL = "https://app.example.test";
useVaultKey(randomBytes(32));

// ---------------------------------------------------------------------------
// A fake Housing.com: one account, one key, and the leads it holds
// ---------------------------------------------------------------------------

const HOUSING = { id: "4544", key: "secret-key-for-checks", down: false, asked: [] as URL[] };
const housingLeads = [
  { lead_name: "Junk One", lead_phone: "9999999999", lead_email: null, project_id: 1233, project_name: "Sath Heights Tower C", locality: "Goregaon", lead_date: "" },
  { lead_name: "Junk Two", lead_phone: "8888888888", lead_email: "two@example.com", project_id: 1233, project_name: "Somewhere Else", locality: "Powai", lead_date: "" },
];
usePortalFetch(async (url: string) => {
  const u = new URL(url);
  if (`${u.origin}${u.pathname}` !== HOUSING_LEADS_URL) return new Response("not here", { status: 404 });
  HOUSING.asked.push(u);
  if (HOUSING.down) return new Response("oops", { status: 503 });
  const t = u.searchParams.get("current_time") ?? "";
  if (u.searchParams.get("id") !== HOUSING.id || u.searchParams.get("hash") !== housingHash(HOUSING.key, t)) {
    return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
  }
  if (!u.searchParams.get("start_date") || !u.searchParams.get("end_date")) return new Response("{}", { status: 422 });
  const now = Math.floor(Date.now() / 1000);
  return new Response(JSON.stringify({ data: housingLeads.map((l, i) => ({ ...l, id: `HS-${i + 1}`, lead_date: String(now - 600) })) }), { status: 200 });
});

// ---------------------------------------------------------------------------
// Two tenants of their own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const made: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

async function tenant(slug: string, name: string) {
  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${`admin@${slug}${tag}.example`}, ${`${slug}${tag}.example`}, 'Portal Admin') RETURNING id`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', ${name}, ${name}, 'AAPFU0939F', ${`${slug}${tag}.example`}, ${admin.id}) RETURNING id`;
  made.orgs.push(org.id);
  made.users.push(admin.id);
  const [root] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${org.id}, NULL, 'ORG', ${name}, ${`${slug}_${tag}`}, ${`${slug}_${tag}`}::ltree) RETURNING id, path::text AS path`;
  const node = async (parent: { id: string; path: string }, kind: string, n: string, s: string) => {
    const [row] = await sql<{ id: string; path: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${org.id}, ${parent.id}, ${kind}, ${n}, ${s}, ${`${parent.path}.${s}`}::ltree) RETURNING id, path::text AS path`;
    return row;
  };
  const entity = await node(root, "ENTITY", "Sath Heights LLP", "sath_llp");
  const region = await node(entity, "REGION", "Mumbai", "mumbai");
  const project = await node(region, "PROJECT", "Sath Heights", "sath_heights");
  const towerC = await node(project, "PHASE", "Tower C", "tower_c");
  await node(project, "PHASE", "Tower D", "tower_d");
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${org.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
  return { orgId: org.id, adminId: admin.id, towerC };
}

const A = await tenant("pta", "Portal Check A");
const B = await tenant("ptb", "Portal Check B");

const events = (orgId: string) =>
  sql<{ external_id: string; outcome: string | null; payload: Record<string, unknown> }[]>`
    SELECT external_id, outcome, payload FROM lead_events WHERE org_id = ${orgId} AND source = 'PORTAL' ORDER BY received_at, external_id`;

try {
  // -------------------------------------------------------------------------
  console.log("\na portal posting to its link");
  // -------------------------------------------------------------------------
  const links = await portalAddresses(A.orgId);
  check("each portal has its own link, carrying the organisation's key",
    links.pushLinks.length === 5 && links.pushLinks.every((l) => l.url.startsWith(`https://app.example.test/api/leads/portal/push?o=${A.orgId}&k=`)) &&
      links.pushLinks[0].url.endsWith("&p=99acres"),
    JSON.stringify(links.pushLinks.map((l) => l.url)));

  const now = new Date().toISOString();
  const first = await takePush(A.orgId, "MAGICBRICKS", { name: "Junk Three", mobile: "7777777777", projectName: "Sath Heights Tower C", leadId: "MB-1" }, now);
  check("a posted lead is stored once as an event", first.added === 1 && first.again === 0, JSON.stringify(first));
  const again = await takePush(A.orgId, "MAGICBRICKS", { name: "Junk Three", mobile: "7777777777", projectName: "Sath Heights Tower C", leadId: "MB-1" }, now);
  check("the same lead posted again is the same event", again.added === 0 && again.again === 1, JSON.stringify(again));
  const mixed = await takePush(A.orgId, "99ACRES", { data: [{ name: "Junk Four", mobile: "6666666666", project: "Nowhere" }, { name: "Hidden", mobile: "98XXXXXX10" }] }, now);
  check("a batch keeps the leads it can read and says why it refused the rest",
    mixed.added === 1 && mixed.refused.length === 1 && mixed.refused[0].reason === "The portal hid the buyer's number.", JSON.stringify(mixed));
  await takePush(A.orgId, "99ACRES", { data: [{ name: "Hidden", mobile: "98XXXXXX10" }] }, now);
  const evs = await events(A.orgId);
  check("a refused record is stored closed, once however often it comes",
    evs.filter((e) => e.payload.refused).length === 1 && evs.filter((e) => e.payload.refused).every((e) => e.outcome === "JUNK"),
    JSON.stringify(evs.map((e) => [e.external_id, e.outcome])));

  const mb = evs.find((e) => e.external_id === "MAGICBRICKS:MB-1")!;
  const [mbRow] = await sql<{ id: string }[]>`SELECT id FROM lead_events WHERE org_id = ${A.orgId} AND external_id = 'MAGICBRICKS:MB-1'`;
  const placed = await portalEvent(A.orgId, mbRow.id, mb.payload);
  check("a wording that names one tower exactly is placed on it, through the capture path",
    placed.ok && placed.lead.phaseId === A.towerC.id && placed.lead.channel === "PORTAL" && placed.lead.lineage.portal === "MAGICBRICKS",
    JSON.stringify(placed));
  const nowhere = evs.find((e) => (e.payload.lead as { name?: string } | undefined)?.name === "Junk Four")!;
  const [nwRow] = await sql<{ id: string }[]>`SELECT id FROM lead_events WHERE org_id = ${A.orgId} AND external_id = ${nowhere.external_id}`;
  const waits = await portalEvent(A.orgId, nwRow.id, nowhere.payload);
  const [nwAfter] = await sql<{ outcome: string }[]>`SELECT outcome FROM lead_events WHERE id = ${nwRow.id}`;
  check("a wording nobody matched waits for a person", !waits.ok && nwAfter.outcome === "WAITING", JSON.stringify([waits, nwAfter]));

  // -------------------------------------------------------------------------
  console.log("\na Housing.com account");
  // -------------------------------------------------------------------------
  const wrong = await savePortalAccount(A.orgId, A.adminId, { accountId: HOUSING.id, key: "not-the-key" });
  check("a key Housing.com refuses is not saved", !wrong.ok && /did not accept/.test(wrong.message) && (await listPortalAccounts(A.orgId)).length === 0, JSON.stringify(wrong));
  const shaped = await savePortalAccount(A.orgId, A.adminId, { accountId: "45&id=9", key: HOUSING.key });
  check("an account id that could reshape the request is refused before asking", !shaped.ok && HOUSING.asked.every((u) => u.searchParams.get("id") !== "45&id=9"));
  const saved = await savePortalAccount(A.orgId, A.adminId, { accountId: HOUSING.id, key: HOUSING.key });
  check("the right key is checked and saved", saved.ok && saved.checked, JSON.stringify(saved));
  const [rowKey] = await sql<{ secret: Buffer; status: string }[]>`SELECT secret, status FROM portal_accounts WHERE org_id = ${A.orgId}`;
  check("the key is sealed, never stored as typed", !!rowKey.secret && !rowKey.secret.toString("latin1").includes(HOUSING.key) && rowKey.status === "ACTIVE");
  const elsewhere = await savePortalAccount(B.orgId, B.adminId, { accountId: HOUSING.id, key: HOUSING.key });
  check("an account another company connected is refused, naming nobody", !elsewhere.ok && /another company/.test(elsewhere.message) && !/Portal Check A/.test(elsewhere.message));
  const seenByB = await withTenant(B.orgId, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM portal_accounts`);
  check("another tenant cannot see the account at all", seenByB[0].n === 0);

  const t0 = new Date().toISOString();
  const pulled = await pullPortalAccounts(A.orgId, t0);
  check("a pass asks Housing.com and stores each lead it gave", pulled.asked === 1 && pulled.leads === 2, JSON.stringify(pulled));
  const pulledEvs = (await events(A.orgId)).filter((e) => e.payload.via === "PULL");
  check("its leads are events keyed on Housing.com's own ids", pulledEvs.map((e) => e.external_id).sort().join() === "HOUSING:HS-1,HOUSING:HS-2", JSON.stringify(pulledEvs.map((e) => e.external_id)));
  const soon = await pullPortalAccounts(A.orgId, new Date(Date.parse(t0) + 3 * 60_000).toISOString());
  check("it is not asked again inside ten minutes", soon.asked === 0);
  const later = await pullPortalAccounts(A.orgId, new Date(Date.parse(t0) + 11 * 60_000).toISOString());
  const lastAsk = HOUSING.asked.at(-1)!;
  check("ten minutes later it is asked from the last window less the overlap, and the same leads are not stored twice",
    later.asked === 1 && later.leads === 0 && Number(lastAsk.searchParams.get("start_date")) === Math.floor(Date.parse(t0) / 1000) - 30 * 60,
    JSON.stringify([later, lastAsk.searchParams.get("start_date")]));

  HOUSING.down = true;
  const down = await pullPortalAccounts(A.orgId, new Date(Date.parse(t0) + 22 * 60_000).toISOString());
  const [afterDown] = await sql<{ status: string; last_error: string; pulled_until: Date }[]>`SELECT status, last_error, pulled_until FROM portal_accounts WHERE org_id = ${A.orgId}`;
  check("Housing.com not answering leaves the account working and the window unread",
    down.failed === 1 && afterDown.status === "ACTIVE" && /did not answer/.test(afterDown.last_error) &&
      afterDown.pulled_until.getTime() === Math.floor((Date.parse(t0) + 11 * 60_000) / 1000) * 1000,
    JSON.stringify(afterDown));
  HOUSING.down = false;

  HOUSING.key = "rotated-at-housing";
  const broke = await pullPortalAccounts(A.orgId, new Date(Date.parse(t0) + 33 * 60_000).toISOString());
  const [brokenRow] = await sql<{ status: string }[]>`SELECT status FROM portal_accounts WHERE org_id = ${A.orgId}`;
  const today = await portalQueue(A.orgId);
  check("a key Housing.com stops accepting breaks the account, and Today says so",
    broke.broken === 1 && brokenRow.status === "BROKEN" && today.some((q) => q.id === "portal-account-broken"), JSON.stringify(today.map((q) => q.id)));
  const idle = await pullPortalAccounts(A.orgId, new Date(Date.parse(t0) + 50 * 60_000).toISOString());
  check("a broken account is not asked again", idle.asked === 0);
  const fixed = await savePortalAccount(A.orgId, A.adminId, { accountId: HOUSING.id, key: HOUSING.key });
  const [fixedRow] = await sql<{ status: string; n: number }[]>`SELECT status, (SELECT count(*)::int FROM portal_accounts WHERE org_id = ${A.orgId}) AS n FROM portal_accounts WHERE org_id = ${A.orgId}`;
  check("saving the new key mends the same account", fixed.ok && fixedRow.status === "ACTIVE" && fixedRow.n === 1, JSON.stringify(fixedRow));

  const acct = (await listPortalAccounts(A.orgId))[0];
  check("removing it scrubs the key", await removePortalAccount(A.orgId, A.adminId, acct.id));
  const [gone] = await sql<{ status: string; secret: Buffer | null }[]>`SELECT status, secret FROM portal_accounts WHERE id = ${acct.id}`;
  check("and the row stays, removed, with no key", gone.status === "REMOVED" && gone.secret === null);
  const [audits] = await sql<{ n: number; leaked: number }[]>`
    SELECT count(*) FILTER (WHERE action LIKE 'portal.account%')::int AS n,
           count(*) FILTER (WHERE metadata::text LIKE ${`%${HOUSING.key}%`} OR metadata::text LIKE '%secret-key%')::int AS leaked
    FROM audit_log WHERE org_id = ${A.orgId}`;
  check("each change is audited, and no key reaches the audit log", audits.n >= 4 && audits.leaked === 0, JSON.stringify(audits));
} catch (e) {
  check("the suite ran to the end", false, (e as Error).stack ?? String(e));
} finally {
  usePortalFetch(null);
  for (const o of made.orgs) {
    await sql`DELETE FROM portal_accounts WHERE org_id = ${o}`;
    await sql`DELETE FROM portal_projects WHERE org_id = ${o}`;
    await sql`DELETE FROM portal_settings WHERE org_id = ${o}`;
    await sql`DELETE FROM lead_events WHERE org_id = ${o}`;
    await sql`DELETE FROM tenant_keys WHERE org_id = ${o}`.catch(() => null);
    await sql`DELETE FROM audit_log WHERE org_id = ${o}`;
    await sql`DELETE FROM orgs WHERE id = ${o}`;
  }
  if (made.users.length) await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await sql.end();
  await closeDb();
  process.exitCode = fail === 0 ? 0 : 1;
}
