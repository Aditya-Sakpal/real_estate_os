// Functional check of each developer's own WhatsApp number, against the real
// database, with Meta replaced by a fake that answers at the same URLs.
//
//   node --experimental-strip-types --no-warnings --env-file=.env.local scripts/check-messaging.mts
//
// Nothing here talks to Meta. The fake answers Embedded Signup's code
// exchange, debug_token, the WABA, its numbers, the subscription, the
// registration, the app sync, the templates and the send, in the shapes
// Meta's reference gives, and records every call. The rules it proves are
// the ones that end a company if they break: a forged id from the browser
// connects nothing, one tenant's number never carries another tenant's
// messages, a reply lands only with the developer whose number it was sent
// to, a developer who removes us is scrubbed at once, and no message goes
// out on a template Meta has not approved for the words being sent.
//
// It builds two organisations of its own and deletes only them.
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

if (!existsSync(".env.local")) throw new Error("run with --env-file=.env.local");

process.env.META_APP_ID = "4242424242";
process.env.META_APP_SECRET = "check-messaging-app-secret";
process.env.META_WA_CONFIG_ID = "7777";
delete process.env.META_WA_SOLUTION_ID;
// The vault key is the suite's own, never the machine's.
delete process.env.CONNECTOR_KEY;

const { useVaultKey, open: openSealed } = await import("../src/lib/vault.ts");
const { usePlatform, META_GRAPH_VERSION } = await import("../src/lib/platform.ts");
const W = await import("../src/lib/wa-numbers.ts");
const { sendMessage, ingestWhatsApp } = await import("../src/lib/messaging.ts");
const { TEMPLATES, CATALOG } = await import("../src/lib/message-rules.ts");
const { SUBMITTED } = await import("../src/lib/wa-catalog.ts");
const { closeDb } = await import("../src/lib/db/index.ts");

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

console.log("\nWithout the signup configuration, nothing connects");
useVaultKey(null);
check("no vault key, not ready", W.whatsappReadyToConnect(), false);
useVaultKey(randomBytes(32));
check("with the app, the configuration and the vault, ready", W.whatsappReadyToConnect(), true);

// ---------------------------------------------------------------------------
// The fake Meta
// ---------------------------------------------------------------------------

type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown>; auth: string | null };
const calls: Call[] = [];
const V = META_GRAPH_VERSION;

type Num = {
  id: string;
  display: string;
  name: string;
  quality: string;
  platform: string;
  status: string;
  onApp: boolean;
  limit: string;
  /** A PIN somebody set before; register refuses any other. */
  existingPin?: string;
};
type Tmpl = { id: string; name: string; language: string; status: string; category: string; body: string };

const meta = {
  codes: new Map<string, string>(),
  tokens: new Map<string, { valid: boolean; wabas: string[] }>(),
  wabas: new Map<string, { name: string; currency: string; numbers: Num[]; templates: Tmpl[]; subscribed: boolean }>(),
  refuseCreate: new Set<string>(),
  seq: 5000,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, code: number, message: string) => json({ error: { message, code, type: "OAuthException" } }, status);

function wabaFor(token: string, id: string) {
  const t = meta.tokens.get(token);
  if (!t?.valid) return { error: err(401, 190, "Invalid OAuth access token.") };
  if (!t.wabas.includes(id)) return { error: err(403, 200, "Permissions error") };
  return { waba: meta.wabas.get(id)! };
}

function numberFor(token: string, phoneId: string) {
  const t = meta.tokens.get(token);
  if (!t?.valid) return { error: err(401, 190, "Invalid OAuth access token.") };
  for (const wid of t.wabas) {
    const n = meta.wabas.get(wid)?.numbers.find((x) => x.id === phoneId);
    if (n) return { n, waba: meta.wabas.get(wid)! };
  }
  return { error: err(400, 100, "Unsupported request") };
}

usePlatform(async (url, init) => {
  const u = new URL(url);
  const path = u.pathname.replace(`/${V}/`, "");
  const method = String(init.method ?? "GET");
  let body: Record<string, unknown> = {};
  if (typeof init.body === "string") body = JSON.parse(init.body);
  const auth = ((init.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /, "") || null;
  calls.push({ method, path, query: u.searchParams, body, auth });

  if (path === "oauth/access_token") {
    const t = meta.codes.get(u.searchParams.get("code") ?? "");
    if (!t || u.searchParams.get("client_secret") !== process.env.META_APP_SECRET) return err(400, 100, "This authorization code has expired.");
    return json({ access_token: t, token_type: "bearer" });
  }
  if (path === "debug_token") {
    const t = meta.tokens.get(u.searchParams.get("input_token") ?? "");
    return json({
      data: {
        is_valid: !!t?.valid,
        expires_at: 0,
        type: "SYSTEM_USER",
        granular_scopes: t
          ? [
              { scope: "whatsapp_business_management", target_ids: t.wabas },
              { scope: "whatsapp_business_messaging", target_ids: t.wabas },
            ]
          : [],
      },
    });
  }
  const token = auth ?? "";

  let m = /^(\d+)\/subscribed_apps$/.exec(path);
  if (m) {
    const r = wabaFor(token, m[1]);
    if (r.error) return r.error;
    r.waba.subscribed = method === "POST";
    return json({ success: true });
  }
  m = /^(\d+)\/phone_numbers$/.exec(path);
  if (m) {
    const r = wabaFor(token, m[1]);
    if (r.error) return r.error;
    return json({
      data: r.waba.numbers.map((n) => ({
        id: n.id,
        display_phone_number: n.display,
        verified_name: n.name,
        name_status: "APPROVED",
        quality_rating: n.quality,
        platform_type: n.platform,
        status: n.status,
        is_on_biz_app: n.onApp,
        whatsapp_business_manager_messaging_limit: n.limit,
      })),
    });
  }
  m = /^(\d+)\/message_templates$/.exec(path);
  if (m) {
    const r = wabaFor(token, m[1]);
    if (r.error) return r.error;
    if (method === "GET") {
      return json({
        data: r.waba.templates.map((t) => ({
          id: t.id,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          components: [{ type: "BODY", text: t.body }],
        })),
        paging: {},
      });
    }
    const name = String(body.name);
    if (meta.refuseCreate.has(name)) return err(400, 100, "Message template body contains variable parameters at the end.");
    if (r.waba.templates.some((t) => t.name === name && t.language === body.language)) return err(400, 100, "Content in this language already exists.");
    const text = String(((body.components as { type: string; text: string }[]) ?? []).find((c) => c.type === "BODY")?.text ?? "");
    const t = { id: String(meta.seq++), name, language: String(body.language), status: "PENDING", category: String(body.category), body: text };
    r.waba.templates.push(t);
    return json({ id: t.id, status: t.status, category: t.category });
  }
  m = /^(\d+)\/register$/.exec(path);
  if (m) {
    const r = numberFor(token, m[1]);
    if (r.error) return r.error;
    if (r.n.existingPin && r.n.existingPin !== body.pin) return err(400, 133005, "Two step verification PIN Mismatch");
    r.n.platform = "CLOUD_API";
    r.n.status = "CONNECTED";
    return json({ success: true });
  }
  m = /^(\d+)\/smb_app_data$/.exec(path);
  if (m) {
    const r = numberFor(token, m[1]);
    if (r.error) return r.error;
    return json({ success: true });
  }
  m = /^(\d+)\/messages$/.exec(path);
  if (m) {
    const r = numberFor(token, m[1]);
    if (r.error) return r.error;
    return json({ messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.${meta.seq++}` }] });
  }
  m = /^(\d+)$/.exec(path);
  if (m) {
    // A WABA, a number, or a template edit.
    const id = m[1];
    if (method === "POST") {
      for (const w of meta.wabas.values()) {
        const t = w.templates.find((x) => x.id === id);
        if (t) {
          t.body = String(((body.components as { type: string; text: string }[]) ?? []).find((c) => c.type === "BODY")?.text ?? t.body);
          t.status = "PENDING";
          return json({ success: true });
        }
      }
      return err(400, 100, "Unsupported post request");
    }
    const w = meta.wabas.get(id);
    if (w) {
      const r = wabaFor(token, id);
      if (r.error) return r.error;
      return json({ id, name: w.name, currency: w.currency, owner_business_info: { id: "31313131", name: w.name } });
    }
    const r = numberFor(token, id);
    if (r.error) return r.error;
    return json({ id, display_phone_number: r.n.display, verified_name: r.n.name, quality_rating: r.n.quality, platform_type: r.n.platform, status: r.n.status, is_on_biz_app: r.n.onApp, whatsapp_business_manager_messaging_limit: r.n.limit });
  }
  return err(404, 803, `No route for ${method} ${path}`);
});

// ---------------------------------------------------------------------------
// Two tenants of our own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const stamp = String(Date.now()).slice(-9);
const made = { orgs: [] as string[], users: [] as string[] };

async function tenant(name: string, slug: string) {
  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${`admin@${slug}${tag}.example`}, ${`${slug}${tag}.example`}, ${`${name} Admin`}) RETURNING id`;
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
  const entity = await node(root, "ENTITY", `${name} LLP`, "spv");
  const region = await node(entity, "REGION", "Pune", "pune");
  const project = await node(region, "PROJECT", `${name} Heights`, "heights");
  const tower = await node(project, "PHASE", "Tower C", "tower_c");
  await sql`INSERT INTO memberships (user_id, org_id, scope_node_id, role, status) VALUES (${admin.id}, ${org.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
  // A registered tower, so a message naming it may go.
  const far = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
  await sql`
    INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code, promoter_name, valid_to, verified_at)
    VALUES (${tower.id}, ${org.id}, 'VERIFIED', 'P52100012345', 'MH', ${`${name} LLP`}, ${far}, now())`;
  return { orgId: org.id, admin: admin.id, root, entity, project, tower };
}

const A = await tenant("Sath Group", "wa_a");
const B = await tenant("Keystone Homes", "wa_b");

const WABA_A = `1${stamp}`;
const WABA_B = `2${stamp}`;
const WABA_X = `3${stamp}`; // nobody here may reach it
const PHONE_A = `5${stamp}`;
const PHONE_B = `6${stamp}`;
const PHONE_A2 = `7${stamp}`;

const approvedBody = TEMPLATES.ACK.body;
meta.wabas.set(WABA_A, {
  name: "Sath Group",
  currency: "INR",
  subscribed: false,
  numbers: [{ id: PHONE_A, display: "+91 98765 01234", name: "Sath Group", quality: "GREEN", platform: "CLOUD_API", status: "CONNECTED", onApp: true, limit: "TIER_250" }],
  templates: [
    // Approved in WhatsApp Manager before we were connected, in exactly our words.
    { id: "4101", name: TEMPLATES.ACK.name, language: "en", status: "APPROVED", category: "UTILITY", body: approvedBody },
    // The same name, approved for words that are not ours any more.
    { id: "4102", name: TEMPLATES.AFTER_CALL.name, language: "en", status: "APPROVED", category: "UTILITY", body: "Hi {{1}}, old words about {{2}}. {{3}} Call {{4}} anytime please." },
  ],
});
meta.wabas.set(WABA_B, {
  name: "Keystone Homes",
  currency: "USD",
  subscribed: false,
  numbers: [{ id: PHONE_B, display: "+91 98200 11122", name: "Keystone Homes", quality: "RED", platform: "NOT_APPLICABLE", status: "PENDING", onApp: false, limit: "TIER_2K", existingPin: "246810" }],
  templates: [],
});
meta.wabas.set(WABA_X, { name: "Somebody Else", currency: "INR", subscribed: false, numbers: [], templates: [] });
meta.tokens.set("tok-A", { valid: true, wabas: [WABA_A] });
meta.tokens.set("tok-B", { valid: true, wabas: [WABA_B] });
meta.tokens.set("tok-B-steals-A", { valid: true, wabas: [WABA_A] });
meta.codes.set("AQcodeA-from-the-popup", "tok-A");
meta.codes.set("AQcodeB-from-the-popup", "tok-B");
meta.codes.set("AQcodeB-steals-A-account", "tok-B-steals-A");
meta.refuseCreate.add(TEMPLATES.NURTURE.name);

try {
  // -------------------------------------------------------------------------
  console.log("\nConnecting: only what the token reaches");
  const expired = await W.connectWhatsApp({ orgId: A.orgId, userId: A.admin, code: "code-that-expired-long-ago", hint: null });
  check("an expired code connects nothing, and says to try again", [expired.ok, (expired as { message: string }).message.includes("Try again")], [false, true]);

  const forged = { event: "FINISH" as const, wabaId: WABA_X, phoneNumberId: "99", businessId: null };
  const a = await W.connectWhatsApp({ orgId: A.orgId, userId: A.admin, code: "AQcodeA-from-the-popup", hint: forged });
  check("the developer's own account connects", a, { ok: true, message: "WhatsApp is connected." });
  const accountsA = await sql<{ id: string; waba_id: string; secret: Buffer; status: string; currency: string }[]>`
    SELECT id, waba_id, secret, status, currency FROM whatsapp_accounts WHERE org_id = ${A.orgId}`;
  check("the page's forged WABA was never connected; the token's was", accountsA.map((x) => x.waba_id), [WABA_A]);
  check("the token is sealed, not stored", accountsA[0].secret.includes(Buffer.from("tok-A")), false);
  check("and opens only for its own tenant and row",
    [await openSealed(A.orgId, W.whatsappPurpose(accountsA[0].id), accountsA[0].secret), await openSealed(B.orgId, W.whatsappPurpose(accountsA[0].id), accountsA[0].secret)],
    ["tok-A", null]);
  check("our app is subscribed to the account's webhooks", meta.wabas.get(WABA_A)!.subscribed, true);
  const numA = (await sql<{ id: string; active: boolean; scope_node_id: string; on_app: boolean; registered: boolean; synced_at: Date | null; daily_limit: string; display_phone: string }[]>`
    SELECT id, active, scope_node_id, on_app, registered, synced_at, daily_limit, display_phone FROM whatsapp_numbers WHERE org_id = ${A.orgId}`)[0];
  check("the first number writes for the whole organisation at once", [numA.active, numA.scope_node_id === A.root.id], [true, true]);
  check("its number is read back as E.164 and its limit as Meta's tier", [numA.display_phone, numA.daily_limit], ["+919876501234", "TIER_250"]);
  const synced = calls.filter((c) => c.path === `${PHONE_A}/smb_app_data`).map((c) => c.body.sync_type);
  check("a number kept in the app asks Meta to sync, contacts then history", synced, ["smb_app_state_sync", "history"]);
  check("and is never registered by us", calls.some((c) => c.path === `${PHONE_A}/register`), false);

  console.log("\nTemplates: approved words count, other words do not");
  const created = calls.filter((c) => c.method === "POST" && c.path === `${WABA_A}/message_templates`).map((c) => c.body.name);
  check("a template approved for our exact words is not sent again", created.includes(TEMPLATES.ACK.name), false);
  check("one of the same name with other words is edited, not created twice",
    [created.includes(TEMPLATES.AFTER_CALL.name), calls.some((c) => c.method === "POST" && c.path === "4102")], [false, true]);
  check("every other catalog template, every version, the broadcasts too, is sent for approval", created.length, SUBMITTED.length - 2);
  const rows = await sql<{ name: string; status: string; reason: string | null }[]>`
    SELECT name, status, reason FROM whatsapp_templates WHERE org_id = ${A.orgId} ORDER BY name`;
  const by = new Map(rows.map((r) => [r.name, r]));
  check("the approved one is recorded as approved, the rest as with Meta",
    [by.get(TEMPLATES.ACK.name)?.status, by.get(TEMPLATES.AFTER_CALL.name)?.status, by.get(TEMPLATES.MISSED_CALL.name)?.status], ["APPROVED", "PENDING", "PENDING"]);
  check("one Meta refused carries Meta's reason", [by.get(TEMPLATES.NURTURE.name)?.status, (by.get(TEMPLATES.NURTURE.name)?.reason ?? "").includes("variable")], ["FAILED", true]);
  const again = await W.submitTemplates({ orgId: A.orgId, userId: A.admin, accountId: accountsA[0].id });
  const createdAgain = calls.filter((c) => c.method === "POST" && c.path === `${WABA_A}/message_templates`).length - created.length;
  check("pressing again sends only what still needs it", [again.ok, createdAgain], [false, 1]);

  console.log("\nSending: the developer's number, and only approved words");
  const [lead] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, enquired_at)
    VALUES (${A.orgId}, ${A.tower.id}, 'Priya Sharma', '+919000000301', 'Website', 'WEBSITE', now()) RETURNING id`;
  const ack = await sendMessage({ orgId: A.orgId, leadId: lead.id, purpose: "ACK" });
  const sent = calls.filter((c) => c.path === `${PHONE_A}/messages`);
  check("an approved acknowledgement goes from the developer's own number", [ack.ok, sent.length, sent[0]?.auth], [true, 1, "tok-A"]);
  check("to the buyer, as the approved template", [sent[0]?.body.to, (sent[0]?.body.template as { name: string })?.name], ["919000000301", TEMPLATES.ACK.name]);
  const [ackRow] = await sql<{ number_id: string; status: string }[]>`SELECT number_id, status FROM messages WHERE org_id = ${A.orgId} AND purpose = 'ACK'`;
  check("the message names the number it went from", [ackRow.number_id === numA.id, ackRow.status], [true, "SENT"]);
  const missed = await sendMessage({ orgId: A.orgId, leadId: lead.id, purpose: "MISSED_CALL" });
  check("a template still with Meta is refused before anything is sent",
    [missed.ok, (missed as { code: string }).code, calls.filter((c) => c.path === `${PHONE_A}/messages`).length], [false, "NOT_APPROVED", 1]);
  check("and the refusal shows on the lead", (await sql`SELECT 1 FROM messages WHERE org_id = ${A.orgId} AND purpose = 'MISSED_CALL' AND status = 'REFUSED'`).length, 1);

  await W.ingestWabaEvents({
    object: "whatsapp_business_account",
    entry: [{ id: WABA_A, changes: [{ field: "message_template_status_update", value: { event: "APPROVED", message_template_id: 1, message_template_name: TEMPLATES.MISSED_CALL.name, message_template_language: "en", reason: "NONE" } }] }],
  });
  const missed2 = await sendMessage({ orgId: A.orgId, leadId: lead.id, purpose: "MISSED_CALL" });
  check("Meta's approval, by webhook, lets it go", missed2.ok, true);

  console.log("\nWhere a number writes");
  meta.wabas.get(WABA_A)!.numbers.push({ id: PHONE_A2, display: "+91 91368 00000", name: "Sath Group Tower C", quality: "GREEN", platform: "CLOUD_API", status: "CONNECTED", onApp: false, limit: "TIER_250" });
  await W.checkWhatsApp(A.orgId, { force: true });
  const second = (await sql<{ id: string; active: boolean }[]>`SELECT id, active FROM whatsapp_numbers WHERE org_id = ${A.orgId} AND phone_number_id = ${PHONE_A2}`)[0];
  check("a second number found later waits for a person to place it", second?.active, false);
  check("placing it where another already writes is refused",
    (await W.placeNumber({ orgId: A.orgId, userId: A.admin, numberId: second.id, nodeId: A.root.id })).ok, false);
  check("a place from another organisation is refused",
    (await W.placeNumber({ orgId: A.orgId, userId: A.admin, numberId: second.id, nodeId: B.project.id })).ok, false);
  check("the project is a place", (await W.placeNumber({ orgId: A.orgId, userId: A.admin, numberId: second.id, nodeId: A.project.id })).ok, true);
  const sender = await W.senderFor(A.orgId, A.tower.id);
  check("a tower under that project hears from the deeper number", sender.ok && sender.numberId, second.id);
  const rootSender = await W.senderFor(A.orgId, A.entity.id);
  check("the rest of the organisation still hears from the first", rootSender.ok && rootSender.numberId, numA.id);

  // -------------------------------------------------------------------------
  console.log("\nA new number, and a PIN only its owner knows");
  const b = await W.connectWhatsApp({ orgId: B.orgId, userId: B.admin, code: "AQcodeB-from-the-popup", hint: { event: "FINISH", wabaId: WABA_B, phoneNumberId: PHONE_B, businessId: null } });
  check("the second tenant connects its own account", b.ok, true);
  const numB = (await sql<{ id: string; registered: boolean; register_error: string | null; pin_secret: Buffer | null }[]>`
    SELECT id, registered, register_error, pin_secret FROM whatsapp_numbers WHERE org_id = ${B.orgId}`)[0];
  check("a number with a PIN set elsewhere is not registered, and asks for it", [numB.registered, numB.register_error], [false, "This number already has a two-step verification PIN. Enter it to finish."]);
  const listed = await W.listWhatsApp(B.orgId);
  check("the screen names what it needs", listed[0].numbers[0].needs?.code, "PIN");
  check("a PIN that is not six digits is refused before Meta", (await W.enterPin({ orgId: B.orgId, userId: B.admin, numberId: numB.id, pin: "12ab" })).ok, false);
  check("a wrong PIN is Meta's refusal, said plainly", (await W.enterPin({ orgId: B.orgId, userId: B.admin, numberId: numB.id, pin: "111111" })).ok, false);
  check("the owner's PIN finishes it", (await W.enterPin({ orgId: B.orgId, userId: B.admin, numberId: numB.id, pin: "246810" })).ok, true);
  const numB2 = (await sql<{ registered: boolean; pin_secret: Buffer | null }[]>`SELECT registered, pin_secret FROM whatsapp_numbers WHERE id = ${numB.id}`)[0];
  check("and the PIN is kept sealed for the next time Meta asks", [numB2.registered, !!numB2.pin_secret && !numB2.pin_secret.includes(Buffer.from("246810"))], [true, true]);
  const listedB = await W.listWhatsApp(B.orgId);
  check("billing Meta will stop, and low quality, are named in that order", listedB[0].numbers[0].needs?.code, "BILLING");

  console.log("\nOne number, one tenant");
  const steal = await W.connectWhatsApp({ orgId: B.orgId, userId: B.admin, code: "AQcodeB-steals-A-account", hint: null });
  check("an account another organisation connected is refused", [steal.ok, (steal as { code: string }).code], [false, "ELSEWHERE"]);
  check("and the first tenant's account is untouched",
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM whatsapp_accounts WHERE waba_id = ${WABA_A} AND status = 'CONNECTED'`)[0].n, 1);

  const owners = await sql<Record<string, unknown>[]>`SELECT * FROM whatsapp_number_owner(${PHONE_A})`;
  check("the webhook lookup returns ids and nothing else", Object.keys(owners[0] ?? {}).sort(), ["number_id", "org_id"]);
  check("and nothing for a number nobody connected", (await sql`SELECT * FROM whatsapp_number_owner('123')`).length, 0);

  console.log("\nWebhooks land with the developer whose number it was");
  const [leadB] = await sql<{ id: string }[]>`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, enquired_at)
    VALUES (${B.orgId}, ${B.tower.id}, 'Priya Sharma', '+919000000301', 'Website', 'WEBSITE', now()) RETURNING id`;
  const inbound = (phoneNumberId: string, id: string, text: string) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "0", changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId, display_phone_number: "919876501234" }, contacts: [{ wa_id: "919000000301", user_id: "IN.1234" }], messages: [{ id, from: "919000000301", timestamp: "1790000000", type: "text", text: { body: text } }] } }] }],
  });
  await ingestWhatsApp(inbound(PHONE_A, `in.${tag}.1`, "Sunday 11 works"));
  const landed = await sql<{ org_id: string; number_id: string | null; wa_user_id: string | null }[]>`SELECT org_id, number_id, wa_user_id FROM messages WHERE provider_id = ${`in.${tag}.1`}`;
  check("a reply to one developer's number reaches only that developer, the same buyer at another notwithstanding",
    landed.map((r) => r.org_id === A.orgId), [true]);
  check("it names the number and Meta's id for the buyer", [landed[0].number_id === numA.id, landed[0].wa_user_id], [true, "IN.1234"]);
  check("and asks a person to answer", ((await sql<{ needs_person: string | null }[]>`SELECT needs_person FROM leads WHERE id = ${lead.id}`)[0].needs_person ?? "").startsWith("Replied"), true);
  check("the other developer's lead for the same buyer is untouched",
    (await sql<{ needs_person: string | null }[]>`SELECT needs_person FROM leads WHERE id = ${leadB.id}`)[0].needs_person, null);
  await ingestWhatsApp(inbound("999999999", `in.${tag}.2`, "hello"));
  check("a message to a number nobody here connected is nobody's", (await sql`SELECT 1 FROM messages WHERE provider_id = ${`in.${tag}.2`}`).length, 0);
  await ingestWhatsApp(inbound(PHONE_B, `in.${tag}.3`, "STOP"));
  check("STOP to one developer's number opts out of that developer only",
    [
      (await sql`SELECT 1 FROM call_suppressions WHERE org_id = ${B.orgId} AND phone = '+919000000301'`).length,
      (await sql`SELECT 1 FROM call_suppressions WHERE org_id = ${A.orgId} AND phone = '+919000000301'`).length,
    ],
    [1, 0]);

  const [sentA] = await sql<{ id: string; provider_id: string }[]>`SELECT id, provider_id FROM messages WHERE org_id = ${A.orgId} AND purpose = 'ACK'`;
  await ingestWhatsApp({
    object: "whatsapp_business_account",
    entry: [{ id: WABA_A, changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_A }, statuses: [{ id: sentA.provider_id, status: "delivered", timestamp: "1790000100", biz_opaque_callback_data: `${B.orgId}:${sentA.id}` }] } }] }],
  });
  check("a receipt whose callback names another tenant is read by the number's owner",
    (await sql<{ status: string }[]>`SELECT status FROM messages WHERE id = ${sentA.id}`)[0].status, "DELIVERED");

  await W.ingestWabaEvents({
    object: "whatsapp_business_account",
    entry: [{ id: WABA_A, changes: [{ field: "smb_message_echoes", value: { metadata: { phone_number_id: PHONE_A }, message_echoes: [
      { id: `echo.${tag}.1`, to: "919000000301", timestamp: "1790000200", type: "text", text: { body: "Aapka visit Sunday 11 baje confirm hai" } },
      { id: `echo.${tag}.2`, to: "919876500000", timestamp: "1790000201", type: "text", text: { body: "Family chat" } },
    ] } }] }],
  });
  check("what the team sent from their phone lands on the lead it was written to",
    (await sql<{ purpose: string }[]>`SELECT purpose FROM messages WHERE provider_id = ${`echo.${tag}.1`}`)[0]?.purpose, "FROM_APP");
  check("and a chat with somebody who is not a lead is not kept", (await sql`SELECT 1 FROM messages WHERE provider_id = ${`echo.${tag}.2`}`).length, 0);

  console.log("\nA developer who removes us is scrubbed at once");
  await W.ingestWabaEvents({ object: "whatsapp_business_account", entry: [{ id: WABA_B, changes: [{ field: "account_update", value: { event: "PARTNER_REMOVED" } }] }] });
  const scrubbed = (await sql<{ status: string; secret: Buffer | null }[]>`SELECT status, secret FROM whatsapp_accounts WHERE org_id = ${B.orgId}`)[0];
  const retired = (await sql<{ retired_at: Date | null; active: boolean; pin_secret: Buffer | null }[]>`SELECT retired_at, active, pin_secret FROM whatsapp_numbers WHERE org_id = ${B.orgId}`)[0];
  check("the token is gone and the account is disconnected", [scrubbed.status, scrubbed.secret], ["DISCONNECTED", null]);
  check("its number is retired and its PIN gone", [!!retired.retired_at, retired.active, retired.pin_secret], [true, false, null]);
  await sql`DELETE FROM call_suppressions WHERE org_id = ${B.orgId}`;
  const afterB = await sendMessage({ orgId: B.orgId, leadId: leadB.id, purpose: "ACK" });
  check("and nothing more is sent in that developer's name", [afterB.ok, (afterB as { code: string }).code], [false, "NOT_SWITCHED_ON"]);

  console.log("\nKeeping it working");
  meta.tokens.set("tok-A", { valid: false, wabas: [WABA_A] });
  const checked = await W.checkWhatsApp(A.orgId, { force: true });
  check("a token Meta no longer honours marks the account broken", [checked.broken, (await sql<{ status: string }[]>`SELECT status FROM whatsapp_accounts WHERE org_id = ${A.orgId}`)[0].status], [1, "BROKEN"]);
  const refused = await sendMessage({ orgId: A.orgId, leadId: lead.id, purpose: "ACK" });
  check("a broken account sends nothing, and says why on the lead", [refused.ok, (refused as { message: string }).message.includes("stopped accepting")], [false, true]);
  meta.tokens.set("tok-A", { valid: true, wabas: [WABA_A] });
  const off = await W.disconnectWhatsApp({ orgId: A.orgId, userId: A.admin, accountId: accountsA[0].id });
  check("disconnecting takes our subscription off at Meta and scrubs the token",
    [off.ok, meta.wabas.get(WABA_A)!.subscribed, (await sql<{ secret: Buffer | null }[]>`SELECT secret FROM whatsapp_accounts WHERE org_id = ${A.orgId}`)[0].secret],
    [true, false, null]);

  const audits = await sql<{ action: string; target_id: string | null; metadata: unknown }[]>`
    SELECT action, target_id, metadata FROM audit_log WHERE org_id = ANY(${made.orgs}) AND action LIKE 'whatsapp.%'`;
  const text = JSON.stringify(audits);
  check("the audit trail has the connections and no phone, token or PIN in it",
    [audits.some((r) => r.action === "whatsapp.connected"), /\+91|tok-|246810|9876501234/.test(text)], [true, false]);
} finally {
  for (const orgId of made.orgs) {
    await sql`DELETE FROM messages WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_tasks WHERE org_id = ${orgId}`;
    await sql`DELETE FROM leads WHERE org_id = ${orgId}`;
    await sql`DELETE FROM call_suppressions WHERE org_id = ${orgId}`;
    await sql`DELETE FROM whatsapp_templates WHERE org_id = ${orgId}`;
    await sql`DELETE FROM whatsapp_numbers WHERE org_id = ${orgId}`;
    await sql`DELETE FROM whatsapp_accounts WHERE org_id = ${orgId}`;
    await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  }
  await sql`DELETE FROM orgs WHERE id = ANY(${made.orgs})`;
  await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
