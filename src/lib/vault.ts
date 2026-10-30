import type { TransactionSql } from "postgres";
import { kms, kmsKeyArn } from "./kms.ts";
import {
  KEY_CACHE_MS,
  SEALED_COLUMNS,
  V1,
  V2,
  needsReseal,
  openV2,
  openWith,
  readMasterKey,
  sealV2,
  sealWith,
  sealedFormat,
  validKeyArn,
  type SealedColumn,
} from "./vault-rules.ts";

/**
 * Where a connected account's token is sealed and opened.
 *
 * A token to a developer's ad account spends their money and speaks for their
 * brand, so it is stored as ciphertext and opened only at the moment a call
 * needs it. Five rules.
 *
 * **Each tenant has its own key, and KMS holds it.** With `KMS_KEY_ARN` set,
 * each organisation has a data key KMS made for it (`tenant_keys`, the
 * encryption context `{ org_id }`), stored only wrapped, and every token is
 * sealed under it in format 2. The unwrapped key is kept in memory for five
 * minutes, so a busy tenant costs KMS one call in five minutes, not one per
 * message. Without `KMS_KEY_ARN` sealing stays in format 1, a key derived
 * from `CONNECTOR_KEY` and the org id, exactly as before.
 *
 * **Each ciphertext is bound to its row.** The org and the row it belongs to
 * are authenticated alongside it, so a sealed Page token copied into another
 * row, or another tenant, fails to open rather than quietly working there.
 *
 * **Format 1 still opens** until `npm run vault:reseal` has moved every row;
 * a retired key still opens what it sealed until the same has run.
 *
 * **KMS not answering is not a broken token.** `open()` returns null only
 * for a value that does not open; when KMS cannot be asked it throws, so a
 * caller never marks a connection broken because AWS had a bad minute.
 *
 * **No key, no connecting.** Neither `CONNECTOR_KEY` nor `KMS_KEY_ARN`, and
 * nothing is sealed: the screens say connecting is not set up, rather than
 * storing a token in the clear to be helpful.
 */

export { readMasterKey, sealWith, openWith, SEALED_COLUMNS };
export { connectionPurpose, accountPurpose } from "./vault-rules.ts";

/** The format a new seal is written in when KMS is off. */
export const VAULT_VERSION = V1;

type Sql = TransactionSql;

let injected: Buffer | null = null;

/** For the checks, which must never need the real key. */
export function useVaultKey(key: Buffer | null): void {
  injected = key;
}

function master(): Buffer | null {
  return injected ?? readMasterKey(process.env.CONNECTOR_KEY);
}

export function vaultConfigured(): boolean {
  return master() !== null || kmsKeyArn() !== null;
}

// ---------------------------------------------------------------------------
// The tenant's data keys
// ---------------------------------------------------------------------------

const cache = new Map<string, { key: Buffer; until: number }>();
let clock: () => number = () => Date.now();

/** The checks' clock, to watch a cached key expire. */
export function useVaultClock(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}

export function clearKeyCache(): void {
  cache.clear();
}

const cacheId = (orgId: string, version: number) => `${orgId}:${version}`;

function cached(orgId: string, version: number): Buffer | null {
  const hit = cache.get(cacheId(orgId, version));
  if (!hit) return null;
  if (hit.until <= clock()) {
    cache.delete(cacheId(orgId, version));
    return null;
  }
  return hit.key;
}

function remember(orgId: string, version: number, key: Buffer): void {
  cache.set(cacheId(orgId, version), { key, until: clock() + KEY_CACHE_MS });
}

type KeyRow = { version: number; wrapped_key: Buffer; kms_key_arn: string };

const database = () => import("./db/index.ts");

async function tenantRead<T>(orgId: string, sql: Sql | undefined, fn: (sql: Sql) => Promise<T>): Promise<T> {
  if (sql) return fn(sql);
  const { withTenant } = await database();
  return withTenant(orgId, fn);
}

async function keyRow(orgId: string, version: number, sql?: Sql): Promise<KeyRow | null> {
  const [r] = await tenantRead(orgId, sql, (tx) => tx<KeyRow[]>`
    SELECT version, wrapped_key, kms_key_arn FROM tenant_keys WHERE org_id = ${orgId} AND version = ${version}`);
  return r ?? null;
}

async function activeRow(orgId: string, sql?: Sql): Promise<KeyRow | null> {
  const [r] = await tenantRead(orgId, sql, (tx) => tx<KeyRow[]>`
    SELECT version, wrapped_key, kms_key_arn FROM tenant_keys WHERE org_id = ${orgId} AND retired_at IS NULL`);
  return r ?? null;
}

async function unwrap(orgId: string, row: KeyRow): Promise<Buffer | null> {
  const hit = cached(orgId, row.version);
  if (hit) return hit;
  const key = await kms().decrypt(row.kms_key_arn, row.wrapped_key, { org_id: orgId });
  if (key && key.length === 32) {
    remember(orgId, row.version, key);
    return key;
  }
  return null;
}

function arnOrThrow(): string {
  const arn = kmsKeyArn();
  if (!arn) throw new Error("KMS_KEY_ARN is not set.");
  if (!validKeyArn(arn)) throw new Error("KMS_KEY_ARN is not a KMS key ARN.");
  return arn;
}

/**
 * Make the tenant's first data key. Always in a transaction of its own, so
 * the key is committed before anything is sealed under it: a caller's
 * transaction that rolled back would otherwise take the key with it and
 * leave this process holding a key nobody else can find. Two processes
 * racing both ask KMS; the second insert does nothing and reads the first.
 */
async function createFirstKey(orgId: string): Promise<KeyRow> {
  const arn = arnOrThrow();
  const made = await kms().generateDataKey(arn, { org_id: orgId });
  const { withTenant } = await database();
  const row = await withTenant(orgId, async (tx) => {
    const [ins] = await tx<KeyRow[]>`
      INSERT INTO tenant_keys (org_id, version, wrapped_key, kms_key_arn)
      SELECT ${orgId}, COALESCE(max(version), 0) + 1, ${made.wrapped}, ${arn} FROM tenant_keys WHERE org_id = ${orgId}
      HAVING count(*) FILTER (WHERE retired_at IS NULL) = 0
      ON CONFLICT DO NOTHING
      RETURNING version, wrapped_key, kms_key_arn`;
    if (ins) return { row: ins, mine: true };
    const [r] = await tx<KeyRow[]>`
      SELECT version, wrapped_key, kms_key_arn FROM tenant_keys WHERE org_id = ${orgId} AND retired_at IS NULL`;
    return { row: r, mine: false };
  });
  if (!row.row) throw new Error("The tenant key could not be made.");
  if (row.mine) remember(orgId, row.row.version, made.plaintext);
  return row.row;
}

/** The key sealing now for this tenant, made on first use. */
async function activeKey(orgId: string, sql?: Sql): Promise<{ version: number; key: Buffer }> {
  const row = (await activeRow(orgId, sql)) ?? (await createFirstKey(orgId));
  const key = await unwrap(orgId, row);
  if (!key) throw new Error("The tenant key did not open.");
  return { version: row.version, key };
}

// ---------------------------------------------------------------------------
// Sealing and opening
// ---------------------------------------------------------------------------

/**
 * Seal `plaintext` for one org and one purpose. `sql`, when the caller is
 * already inside that tenant's transaction, reads the key there instead of
 * taking a second connection.
 */
export async function seal(
  orgId: string,
  purpose: string,
  plaintext: string,
  sql?: Sql,
): Promise<{ secret: Buffer; keyVersion: number } | null> {
  if (kmsKeyArn()) {
    const k = await activeKey(orgId, sql);
    return { secret: sealV2(k.key, k.version, orgId, purpose, plaintext), keyVersion: V2 };
  }
  const key = master();
  if (!key) return null;
  return { secret: sealWith(key, orgId, purpose, plaintext), keyVersion: V1 };
}

/** Open what `seal` sealed, in either format, or null if it does not open here. */
export async function open(orgId: string, purpose: string, sealed: Buffer | null, sql?: Sql): Promise<string | null> {
  const f = sealedFormat(sealed);
  if (!f || !sealed) return null;
  if (f.format === 1) {
    const key = master();
    return key ? openWith(key, orgId, purpose, sealed) : null;
  }
  let key = cached(orgId, f.keyVersion);
  if (!key) {
    const row = await keyRow(orgId, f.keyVersion, sql);
    if (!row) return null;
    key = await unwrap(orgId, row);
  }
  return key ? openV2(key, orgId, purpose, sealed) : null;
}

// ---------------------------------------------------------------------------
// Re-sealing and rotation
// ---------------------------------------------------------------------------

export type ResealCount = {
  table: string;
  label: string;
  rows: number;
  /** Already in format 2 under the key sealing now. */
  current: number;
  /** Moved (or, in a dry run, that would be). */
  moved: number;
  /** Did not open: left as they are, and reported. */
  unopened: number;
};

async function sealedRows(orgId: string, c: SealedColumn): Promise<{ id: string; secret: Buffer }[]> {
  const { withTenant } = await database();
  return withTenant(orgId, (tx) => tx<{ id: string; secret: Buffer }[]>`
    SELECT id, ${tx(c.secret)} AS secret FROM ${tx(c.table)}
    WHERE org_id = ${orgId} AND ${tx(c.secret)} IS NOT NULL ORDER BY id`);
}

/**
 * Move every sealed value of one tenant to format 2 under its key sealing
 * now, row by row. A row already there is left, so running it twice does
 * nothing the second time. Each write is conditional on the row still
 * holding what was read, so a token changed meanwhile is not overwritten.
 * A dry run opens and seals again in memory, under a throwaway key when the
 * tenant has none yet, and writes nothing: no row, no key, no KMS key made.
 */
export async function resealOrg(orgId: string, opts: { dryRun?: boolean } = {}): Promise<ResealCount[]> {
  arnOrThrow();
  const { withTenant } = await database();
  let target: { version: number; key: Buffer };
  if (opts.dryRun) {
    const row = await activeRow(orgId);
    const key = row ? await unwrap(orgId, row) : null;
    if (row && !key) throw new Error("The tenant key did not open.");
    target = row && key ? { version: row.version, key } : { version: 1, key: (await import("node:crypto")).randomBytes(32) };
  } else {
    target = await activeKey(orgId);
  }
  const out: ResealCount[] = [];
  for (const c of SEALED_COLUMNS) {
    const count: ResealCount = { table: c.table, label: c.label, rows: 0, current: 0, moved: 0, unopened: 0 };
    for (const r of await sealedRows(orgId, c)) {
      count.rows++;
      if (!needsReseal(r.secret, target.version)) {
        count.current++;
        continue;
      }
      const purpose = c.purpose(r.id);
      const plain = await open(orgId, purpose, r.secret);
      if (plain === null) {
        count.unopened++;
        continue;
      }
      const next = sealV2(target.key, target.version, orgId, purpose, plain);
      if (openV2(target.key, orgId, purpose, next) !== plain) throw new Error("A re-sealed value did not open.");
      if (opts.dryRun) {
        count.moved++;
        continue;
      }
      const write = (tx: Sql) => tx`
        UPDATE ${tx(c.table)} SET ${tx(c.secret)} = ${next}, ${tx(c.keyVersion)} = ${V2}
        WHERE org_id = ${orgId} AND id = ${r.id} AND ${tx(c.secret)} = ${r.secret}`;
      // An operator's script: the one column the app may not rewrite is
      // written as the owner, scoped to this tenant by its WHERE.
      const res = c.ownerWrite ? await write((await database()).controlDb as unknown as Sql) : await withTenant(orgId, write);
      if (res.count === 1) count.moved++;
    }
    out.push(count);
  }
  return out;
}

/**
 * A new data key for one tenant: the one sealing now is retired, the new
 * one takes its place, and every row is moved onto it. The retired key stays
 * (it still opens anything a row changed meanwhile holds) and is never
 * brought back.
 */
export async function rotateTenantKey(orgId: string): Promise<{ from: number | null; to: number; resealed: ResealCount[] }> {
  const arn = arnOrThrow();
  const made = await kms().generateDataKey(arn, { org_id: orgId });
  const { withTenant } = await database();
  const r = await withTenant(orgId, async (tx) => {
    const rows = await tx<{ version: number; retired_at: Date | null }[]>`
      SELECT version, retired_at FROM tenant_keys WHERE org_id = ${orgId} ORDER BY version FOR UPDATE`;
    const from = rows.find((x) => !x.retired_at)?.version ?? null;
    const to = (rows.at(-1)?.version ?? 0) + 1;
    if (to > 255) throw new Error("This tenant has used every key version.");
    await tx`UPDATE tenant_keys SET retired_at = now() WHERE org_id = ${orgId} AND retired_at IS NULL`;
    await tx`INSERT INTO tenant_keys (org_id, version, wrapped_key, kms_key_arn) VALUES (${orgId}, ${to}, ${made.wrapped}, ${arn})`;
    return { from, to };
  });
  remember(orgId, r.to, made.plaintext);
  const resealed = await resealOrg(orgId);
  return { ...r, resealed };
}
