// Functional check of per-tenant data keys under KMS, against the real
// database, with KMS replaced by a fake that holds one key and records every
// call.
//
//   node --experimental-strip-types --no-warnings --env-file=.env.local scripts/check-vault.mts
//
// Nothing here talks to AWS. The fake wraps a data key under its own master
// key, bound to the encryption context, which is what KMS promises: a
// wrapped key only opens for the org_id it was made for. The rules it
// proves: with KMS off nothing changes, a token sealed for one tenant or one
// row opens nowhere else, an unwrapped key is kept five minutes and then
// asked for again, KMS not answering is not a broken token, a dry run writes
// nothing, re-sealing moves every row and running it twice moves none, a
// rotation retires the old key and the rows follow, and format 1 still
// opens throughout.
//
// It builds two organisations of its own and deletes only them.
import { existsSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

if (!existsSync(".env.local")) throw new Error("run with --env-file=.env.local");

// The suite's own keys, never the machine's.
delete process.env.CONNECTOR_KEY;
delete process.env.KMS_KEY_ARN;
delete process.env.KMS_DEV_KEY;
delete process.env.VERCEL;

const V = await import("../src/lib/vault.ts");
const VR = await import("../src/lib/vault-rules.ts");
const K = await import("../src/lib/kms.ts");
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
async function throws(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "no error";
  } catch (e) {
    return (e as Error).constructor.name;
  }
}

// ---------------------------------------------------------------------------
// The fake KMS
// ---------------------------------------------------------------------------

const ARN = "arn:aws:kms:ap-south-1:222222222222:key/0f0e0d0c-0b0a-4908-8706-050403020100";
const kmsMaster = randomBytes(32);
const kmsCalls: { op: string; arn: string; context: string }[] = [];
let kmsDown = false;
const ctx = (arn: string, c: { org_id: string }) => Buffer.from(`${arn}|${JSON.stringify(c)}`);
const fake: import("../src/lib/kms.ts").KmsDriver = {
  async generateDataKey(arn, context) {
    kmsCalls.push({ op: "GenerateDataKey", arn, context: JSON.stringify(context) });
    if (kmsDown) throw new K.KmsUnavailable("down");
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", kmsMaster, iv);
    c.setAAD(ctx(arn, context));
    const body = Buffer.concat([c.update(plaintext), c.final()]);
    return { plaintext, wrapped: Buffer.concat([iv, c.getAuthTag(), body]) };
  },
  async decrypt(arn, wrapped, context) {
    kmsCalls.push({ op: "Decrypt", arn, context: JSON.stringify(context) });
    if (kmsDown) throw new K.KmsUnavailable("down");
    try {
      const d = createDecipheriv("aes-256-gcm", kmsMaster, wrapped.subarray(0, 12));
      d.setAAD(ctx(arn, context));
      d.setAuthTag(wrapped.subarray(12, 28));
      return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
    } catch {
      return null;
    }
  },
};
const calls = (op: string) => kmsCalls.filter((c) => c.op === op).length;

// ---------------------------------------------------------------------------
// Two organisations of our own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
const made = { orgs: [] as string[], users: [] as string[] };
async function tenant(name: string, slug: string): Promise<string> {
  const [admin] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${`admin@${slug}${tag}.example`}, ${`${slug}${tag}.example`}, ${`${name} Admin`}) RETURNING id`;
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', ${name}, ${name}, 'AAPFU0939F', ${`${slug}${tag}.example`}, ${admin.id}) RETURNING id`;
  made.orgs.push(org.id);
  made.users.push(admin.id);
  return org.id;
}

const keyRows = (orgId: string) => sql<{ version: number; retired: boolean; wrapped_key: Buffer; kms_key_arn: string }[]>`
  SELECT version, retired_at IS NOT NULL AS retired, wrapped_key, kms_key_arn FROM tenant_keys WHERE org_id = ${orgId} ORDER BY version`;

try {
  const A = await tenant("Vault Alpha", "vaulta");
  const B = await tenant("Vault Beta", "vaultb");
  const master = randomBytes(32);
  V.useVaultKey(master);
  K.useKms(fake);

  console.log("\nWith KMS off, sealing is format 1, exactly as before");
  const off = await V.seal(A, "connection:x", "old-token");
  check("format 1, key version 1", [off?.secret[0], off?.keyVersion], [1, 1]);
  check("it opens", await V.open(A, "connection:x", off!.secret), "old-token");
  check("KMS was never asked", kmsCalls.length, 0);
  check("and no tenant key was made", (await keyRows(A)).length, 0);
  check("re-sealing refuses without KMS_KEY_ARN", await throws(() => V.resealOrg(A, { dryRun: true })), "Error");

  // Fixture rows sealed as production has them today: format 1.
  const conn = async (orgId: string, provider: string, token: string) => {
    const s = VR.sealWith(master, orgId, "pending", token);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO connections (org_id, provider, status, secret, key_version) VALUES (${orgId}, ${provider}, 'CONNECTED', ${s}, 1) RETURNING id`;
    const sealed = VR.sealWith(master, orgId, VR.connectionPurpose(r.id), token);
    await sql`UPDATE connections SET secret = ${sealed} WHERE id = ${r.id}`;
    return r.id;
  };
  const connA1 = await conn(A, "META", "meta-token-a1");
  const connA2 = await conn(A, "GOOGLE", "meta-token-a2");
  const connB1 = await conn(B, "META", "meta-token-b1");
  const [payA] = await sql<{ id: string }[]>`
    INSERT INTO payment_accounts (org_id, account_id, mode, secret, key_version) VALUES (${A}, ${"acc_" + tag.padEnd(8, "x")}, 'test', ${Buffer.from([1])}, 1) RETURNING id`;
  await sql`UPDATE payment_accounts SET secret = ${VR.sealWith(master, A, VR.paymentPurpose(payA.id), '{"a":"rzp"}')} WHERE id = ${payA.id}`;
  // A mandate: the app may only stop one, so its re-seal is the owner's write.
  const mandateId = randomUUID();
  await sql`
    INSERT INTO billing_mandates (id, org_id, method, label, secret, key_version, max_amount_paise, test)
    VALUES (${mandateId}, ${A}, 'CARD', 'Card', ${VR.sealWith(master, A, VR.mandatePurpose(mandateId), '{"token":"tok_a"}')}, 1, 1500000, true)`;
  // A row whose bytes open for nobody: reported, never re-sealed.
  const [broken] = await sql<{ id: string }[]>`
    INSERT INTO crm_connections (org_id, provider, status, secret, key_version) VALUES (${A}, 'LEADRAT', 'BROKEN', ${VR.sealWith(randomBytes(32), A, "connection:x", "lost")}, 1) RETURNING id`;
  const secretsOf = async () => (await sql<{ id: string; secret: Buffer }[]>`
    SELECT id, secret FROM connections WHERE org_id = ANY(${made.orgs}) UNION ALL SELECT id, secret FROM payment_accounts WHERE org_id = ANY(${made.orgs}) ORDER BY id`)
    .map((r) => `${r.id}:${r.secret.toString("hex")}`);

  console.log("\nWith KMS on, the tenant's data key is made on first seal");
  process.env.KMS_KEY_ARN = ARN;
  check("the vault counts as set up with KMS alone", (V.useVaultKey(null), V.vaultConfigured()), true);
  V.useVaultKey(master);
  const s1 = await V.seal(A, VR.connectionPurpose("new"), "fresh-token");
  check("format 2 under key version 1", [s1?.secret[0], s1?.secret[1], s1?.keyVersion], [2, 1, 2]);
  check("one GenerateDataKey, with the org as its context", kmsCalls.map((c) => [c.op, c.arn, c.context]),
    [["GenerateDataKey", ARN, JSON.stringify({ org_id: A })]]);
  const rowsA = await keyRows(A);
  check("one key row, active, holding only the wrapped key", rowsA.map((r) => [r.version, r.retired, r.kms_key_arn, r.wrapped_key.length]),
    [[1, false, ARN, 12 + 16 + 32]]);
  check("it opens for its own org and row", await V.open(A, VR.connectionPurpose("new"), s1!.secret), "fresh-token");
  const s2 = await V.seal(A, VR.connectionPurpose("new2"), "second");
  check("a second seal reuses the key, and KMS is not asked again", [s2?.secret[1], kmsCalls.length], [1, 1]);

  console.log("\nA token opens for its own tenant and row only");
  check("not for another row", await V.open(A, VR.connectionPurpose("other"), s1!.secret), null);
  check("not for another tenant, which has no such key", await V.open(B, VR.connectionPurpose("new"), s1!.secret), null);
  // B's first seal makes B's own key, under B's context.
  const sb = await V.seal(B, VR.connectionPurpose("new"), "beta-token");
  check("the other tenant's key is its own", [kmsCalls.at(-1)?.context, (await keyRows(B))[0].wrapped_key.equals(rowsA[0].wrapped_key)],
    [JSON.stringify({ org_id: B }), false]);
  check("and A's token still does not open as B's, at the same version", await V.open(B, VR.connectionPurpose("new"), s1!.secret), null);
  check("nor B's as A's", await V.open(A, VR.connectionPurpose("new"), sb!.secret), null);
  // A wrapped key copied into another tenant does not unwrap there.
  await sql`DELETE FROM tenant_keys WHERE org_id = ${B}`;
  await sql`INSERT INTO tenant_keys (org_id, version, wrapped_key, kms_key_arn) VALUES (${B}, 1, ${rowsA[0].wrapped_key}, ${ARN})`;
  V.clearKeyCache();
  check("A's wrapped key copied into B's row does not open for B", await V.open(B, VR.connectionPurpose("new"), sb!.secret), null);
  check("and sealing for B under it is refused", await throws(() => V.seal(B, "x", "y")), "Error");
  await sql`DELETE FROM tenant_keys WHERE org_id = ${B}`;

  console.log("\nAn unwrapped key is kept five minutes");
  let now = Date.now();
  V.useVaultClock(() => now);
  V.clearKeyCache();
  const before = calls("Decrypt");
  await V.open(A, VR.connectionPurpose("new"), s1!.secret);
  await V.open(A, VR.connectionPurpose("new2"), s2!.secret);
  await V.seal(A, "cache:1", "z");
  check("one Decrypt for three uses", calls("Decrypt") - before, 1);
  now += VR.KEY_CACHE_MS - 1000;
  await V.open(A, VR.connectionPurpose("new"), s1!.secret);
  check("still cached a second before five minutes", calls("Decrypt") - before, 1);
  now += 2000;
  await V.open(A, VR.connectionPurpose("new"), s1!.secret);
  check("asked again after", calls("Decrypt") - before, 2);

  console.log("\nKMS not answering is not a broken token");
  V.clearKeyCache();
  kmsDown = true;
  check("open throws rather than saying it does not open", await throws(() => V.open(A, VR.connectionPurpose("new"), s1!.secret)), "KmsUnavailable");
  check("and so does seal", await throws(() => V.seal(A, "x", "y")), "KmsUnavailable");
  check("format 1 still opens meanwhile, needing no KMS", await V.open(A, VR.connectionPurpose(connA1), (await sql<{ secret: Buffer }[]>`SELECT secret FROM connections WHERE id = ${connA1}`)[0].secret), "meta-token-a1");
  kmsDown = false;

  console.log("\nA dry run opens and seals again in memory, and writes nothing");
  const snapshot = await secretsOf();
  const keysBefore = [(await keyRows(A)).length, (await keyRows(B)).length];
  const generatesBefore = calls("GenerateDataKey");
  const dryA = await V.resealOrg(A, { dryRun: true });
  const dryB = await V.resealOrg(B, { dryRun: true });
  const count = (r: import("../src/lib/vault.ts").ResealCount[], table: string) => {
    const x = r.find((c) => c.table === table)!;
    return [x.rows, x.current, x.moved, x.unopened];
  };
  check("A's connections: two to move", count(dryA, "connections"), [2, 0, 2, 0]);
  check("A's CRM key opens for nobody: counted, not moved", count(dryA, "crm_connections"), [1, 0, 0, 1]);
  check("A's Razorpay token: one to move", count(dryA, "payment_accounts"), [1, 0, 1, 0]);
  check("B, with no key yet: one to move", count(dryB, "connections"), [1, 0, 1, 0]);
  check("every sealed column is counted", dryA.map((c) => c.table), VR.SEALED_COLUMNS.map((c) => c.table));
  check("no row changed", await secretsOf(), snapshot);
  check("no key was made, for B or anyone", [(await keyRows(A)).length, (await keyRows(B)).length, calls("GenerateDataKey") - generatesBefore], [...keysBefore, 0]);

  console.log("\nRe-sealing moves every row, once");
  const wetA = await V.resealOrg(A);
  check("A's connections: two moved", count(wetA, "connections"), [2, 0, 2, 0]);
  check("A's Razorpay token moved", count(wetA, "payment_accounts"), [1, 0, 1, 0]);
  check("A's auto top-up mandate moved, as the owner", count(wetA, "billing_mandates"), [1, 0, 1, 0]);
  const mand = (await sql<{ secret: Buffer }[]>`SELECT secret FROM billing_mandates WHERE id = ${mandateId}`)[0];
  check("and opens to what it held", await V.open(A, VR.mandatePurpose(mandateId), mand.secret), '{"token":"tok_a"}');
  const rowA1 = (await sql<{ secret: Buffer; key_version: number }[]>`SELECT secret, key_version FROM connections WHERE id = ${connA1}`)[0];
  check("the row is format 2, and its version column says so", [rowA1.secret[0], rowA1.secret[1], rowA1.key_version], [2, 1, 2]);
  check("and opens to what it held", await V.open(A, VR.connectionPurpose(connA1), rowA1.secret), "meta-token-a1");
  const brokenRow = (await sql<{ secret: Buffer }[]>`SELECT secret FROM crm_connections WHERE id = ${broken.id}`)[0];
  check("the row that opened for nobody is left as it was", brokenRow.secret[0], 1);
  const again = await V.resealOrg(A);
  check("running it again moves nothing", [count(again, "connections"), count(again, "crm_connections"), count(again, "payment_accounts")], [[2, 2, 0, 0], [1, 0, 0, 1], [1, 1, 0, 0]]);
  const wetB = await V.resealOrg(B);
  check("B's first key is made by its re-seal, and its row moved", [count(wetB, "connections"), (await keyRows(B)).length], [[1, 0, 1, 0], 1]);
  const rowB1 = (await sql<{ secret: Buffer }[]>`SELECT secret FROM connections WHERE id = ${connB1}`)[0];
  check("B's row opens for B and not for A", [await V.open(B, VR.connectionPurpose(connB1), rowB1.secret), await V.open(A, VR.connectionPurpose(connB1), rowB1.secret)], ["meta-token-b1", null]);
  const pay = (await sql<{ secret: Buffer }[]>`SELECT secret FROM payment_accounts WHERE id = ${payA.id}`)[0];
  check("the Razorpay token opens under its own purpose", await V.open(A, VR.paymentPurpose(payA.id), pay.secret), '{"a":"rzp"}');

  console.log("\nRotating a tenant's key");
  const rot = await V.rotateTenantKey(A);
  check("version 1 retired, version 2 made", [rot.from, rot.to], [1, 2]);
  check("the key rows say so", (await keyRows(A)).map((r) => [r.version, r.retired]), [[1, true], [2, false]]);
  check("every row that opened moved onto it", [count(rot.resealed, "connections"), count(rot.resealed, "payment_accounts")], [[2, 0, 2, 0], [1, 0, 1, 0]]);
  const rowA2 = (await sql<{ secret: Buffer }[]>`SELECT secret FROM connections WHERE id = ${connA2}`)[0];
  check("a row now names key 2", rowA2.secret[1], 2);
  V.clearKeyCache();
  check("and opens, from the database, after the cache is gone", await V.open(A, VR.connectionPurpose(connA2), rowA2.secret), "meta-token-a2");
  check("a value sealed under the retired key still opens", await V.open(A, VR.connectionPurpose("new"), s1!.secret), "fresh-token");
  const s3 = await V.seal(A, "after:rotate", "t");
  check("new seals use key 2", s3?.secret[1], 2);
  check("B's key was not touched", (await keyRows(B)).map((r) => [r.version, r.retired]), [[1, false]]);

  console.log("\nThe database holds a key still");
  const app = postgres(process.env.DATABASE_APP_URL!, { max: 1, onnotice: () => {} });
  const asA = async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    app.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${A}, true)`;
      return fn(tx);
    });
  const code = async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    try {
      await asA(fn);
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code ?? "error";
    }
  };
  check("the app role cannot change a wrapped key", await code((tx) => tx`UPDATE tenant_keys SET wrapped_key = ${randomBytes(60)} WHERE org_id = ${A}`), "42501");
  check("nor bring a retired key back", await code((tx) => tx`UPDATE tenant_keys SET retired_at = NULL WHERE org_id = ${A} AND version = 1`), "23514");
  check("nor delete one", await code((tx) => tx`DELETE FROM tenant_keys WHERE org_id = ${A}`), "42501");
  check("nor hold two active keys", await code((tx) => tx`INSERT INTO tenant_keys (org_id, version, wrapped_key, kms_key_arn) VALUES (${A}, 9, ${randomBytes(60)}, ${ARN})`), "23505");
  await app.end();

  console.log("\nEvery sealed column is on the list");
  const bytea = await sql<{ t: string }[]>`
    SELECT table_name || '.' || column_name AS t FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'bytea' AND column_name LIKE '%secret%' ORDER BY 1`;
  const listed = VR.SEALED_COLUMNS.map((c) => `${c.table}.${c.secret}`).sort();
  check("the list and the database agree", bytea.map((r) => r.t), listed);

  console.log("\nThe drivers");
  K.useKms(null);
  process.env.KMS_DEV_KEY = randomBytes(32).toString("base64");
  const dev = K.kms();
  const made1 = await dev.generateDataKey("dev:check", { org_id: A });
  check("the development key wraps and unwraps a data key", (await dev.decrypt("dev:check", made1.wrapped, { org_id: A }))?.equals(made1.plaintext), true);
  check("for its own org only", await dev.decrypt("dev:check", made1.wrapped, { org_id: B }), null);
  process.env.VERCEL = "1";
  check("on a hosted machine the development key is ignored", await throws(() => K.kms().generateDataKey("dev:check", { org_id: A })), "KmsUnavailable");
  delete process.env.VERCEL;
  delete process.env.KMS_DEV_KEY;

  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  let answer: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const aws = K.awsKmsDriver({
    credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }),
    now: () => new Date("2026-09-30T06:30:00Z"),
    fetchImpl: (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch,
  });
  const plain = randomBytes(32);
  answer = { status: 200, body: { Plaintext: plain.toString("base64"), CiphertextBlob: Buffer.from("wrapped-bytes").toString("base64"), KeyId: ARN } };
  const g = await aws.generateDataKey(ARN, { org_id: A });
  check("GenerateDataKey goes to KMS in the key's region", sent[0].url, "https://kms.ap-south-1.amazonaws.com/");
  check("as TrentService, in JSON 1.1", [sent[0].headers["x-amz-target"], sent[0].headers["content-type"]], ["TrentService.GenerateDataKey", "application/x-amz-json-1.1"]);
  check("signed for kms in ap-south-1", sent[0].headers.authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260930/ap-south-1/kms/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target,"), true);
  check("asking for AES-256 under the org's context", sent[0].body, { KeyId: ARN, KeySpec: "AES_256", EncryptionContext: { org_id: A } });
  check("and reads the key and its wrapped form back", [g.plaintext.equals(plain), g.wrapped.toString()], [true, "wrapped-bytes"]);
  answer = { status: 200, body: { Plaintext: plain.toString("base64"), KeyId: ARN } };
  const d = await aws.decrypt(ARN, Buffer.from("wrapped-bytes"), { org_id: A });
  check("Decrypt sends the blob and the context", [sent[1].headers["x-amz-target"], sent[1].body], ["TrentService.Decrypt", { KeyId: ARN, CiphertextBlob: Buffer.from("wrapped-bytes").toString("base64"), EncryptionContext: { org_id: A } }]);
  check("and returns the key", d?.equals(plain), true);
  answer = { status: 400, body: { __type: "InvalidCiphertextException", message: "" } };
  check("a ciphertext KMS will not open for this context is null", await aws.decrypt(ARN, Buffer.from("x"), { org_id: B }), null);
  answer = { status: 400, body: { __type: "AccessDeniedException", message: "not allowed" } };
  check("access denied is an outage, not a wrong key", await throws(() => aws.decrypt(ARN, Buffer.from("x"), { org_id: A })), "KmsUnavailable");
  answer = { status: 503, body: {} };
  check("KMS down is an outage", await throws(() => aws.generateDataKey(ARN, { org_id: A })), "KmsUnavailable");
  check("a key that is not KMS's is refused before any request", [await throws(() => aws.generateDataKey("dev:x", { org_id: A })), sent.length], ["KmsUnavailable", 5]);
} finally {
  V.useVaultClock(null);
  K.useKms(null);
  for (const orgId of made.orgs) {
    await sql`DELETE FROM payment_accounts WHERE org_id = ${orgId}`;
    await sql`DELETE FROM billing_mandates WHERE org_id = ${orgId}`;
    await sql`DELETE FROM connections WHERE org_id = ${orgId}`;
    await sql`DELETE FROM crm_connections WHERE org_id = ${orgId}`;
    await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  }
  await sql`DELETE FROM orgs WHERE id = ANY(${made.orgs})`;
  await sql`DELETE FROM users WHERE id = ANY(${made.users})`;
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
