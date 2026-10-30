import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * The pure half of the vault: the two formats a sealed value comes in, and
 * the list of every column that holds one. No database, no KMS, so
 * `check:logic` covers it.
 *
 *   format 1   [0x01][iv 12][tag 16][body]
 *              AES-256-GCM under a key derived from CONNECTOR_KEY and the org
 *              id. What every token was sealed in before KMS.
 *   format 2   [0x02][key version][iv 12][tag 16][body]
 *              AES-256-GCM under the tenant's own data key, which KMS made
 *              and only KMS can unwrap. The second byte names which of the
 *              tenant's keys (`tenant_keys.version`).
 *
 * Both authenticate `org|purpose` beside the body, so a sealed value copied
 * into another row, or another tenant, does not open.
 */

export const V1 = 1;
export const V2 = 2;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const INFO = "salesdesk/connector/v1";

export function readMasterKey(raw: string | null | undefined): Buffer | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const bytes = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  return bytes.length === 32 ? bytes : null;
}

function tenantKey(key: Buffer, orgId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.from(orgId), Buffer.from(INFO), 32));
}

const aad = (orgId: string, purpose: string) => Buffer.from(`${orgId}|${purpose}`);

function gcmSeal(key: Buffer, orgId: string, purpose: string, plaintext: string): { iv: Buffer; tag: Buffer; body: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(orgId, purpose));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), body };
}

function gcmOpen(key: Buffer, orgId: string, purpose: string, iv: Buffer, tag: Buffer, body: Buffer): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(orgId, purpose));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Seal in format 1, under an explicit master key. */
export function sealWith(key: Buffer, orgId: string, purpose: string, plaintext: string): Buffer {
  const { iv, tag, body } = gcmSeal(tenantKey(key, orgId), orgId, purpose, plaintext);
  return Buffer.concat([Buffer.from([V1]), iv, tag, body]);
}

/** Open format 1, or null if it was not sealed for this org and purpose. */
export function openWith(key: Buffer, orgId: string, purpose: string, sealed: Buffer): string | null {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== V1) return null;
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  return gcmOpen(tenantKey(key, orgId), orgId, purpose, iv, tag, sealed.subarray(1 + IV_BYTES + TAG_BYTES));
}

/** Seal in format 2, under a tenant's data key of the given version. */
export function sealV2(dataKey: Buffer, version: number, orgId: string, purpose: string, plaintext: string): Buffer {
  if (dataKey.length !== 32) throw new Error("a data key is 32 bytes");
  if (!Number.isInteger(version) || version < 1 || version > 255) throw new Error("a key version is 1 to 255");
  const { iv, tag, body } = gcmSeal(dataKey, orgId, purpose, plaintext);
  return Buffer.concat([Buffer.from([V2, version]), iv, tag, body]);
}

/** Open format 2 with the data key its second byte names, or null. */
export function openV2(dataKey: Buffer, orgId: string, purpose: string, sealed: Buffer): string | null {
  if (sealed.length < 2 + IV_BYTES + TAG_BYTES || sealed[0] !== V2 || dataKey.length !== 32) return null;
  const iv = sealed.subarray(2, 2 + IV_BYTES);
  const tag = sealed.subarray(2 + IV_BYTES, 2 + IV_BYTES + TAG_BYTES);
  return gcmOpen(dataKey, orgId, purpose, iv, tag, sealed.subarray(2 + IV_BYTES + TAG_BYTES));
}

/** What a sealed value is: its format and, for format 2, the key version. Null when it is neither. */
export function sealedFormat(sealed: Buffer | null | undefined): { format: 1 } | { format: 2; keyVersion: number } | null {
  if (!sealed) return null;
  if (sealed[0] === V1 && sealed.length >= 1 + IV_BYTES + TAG_BYTES) return { format: 1 };
  if (sealed[0] === V2 && sealed.length >= 2 + IV_BYTES + TAG_BYTES && sealed[1] >= 1) return { format: 2, keyVersion: sealed[1] };
  return null;
}

/**
 * Whether a row needs re-sealing: anything not in format 2 under the key
 * sealing now. Idempotent by construction: a row already there is left.
 */
export function needsReseal(sealed: Buffer, activeVersion: number): boolean {
  const f = sealedFormat(sealed);
  return !f || f.format === 1 || f.keyVersion !== activeVersion;
}

/**
 * The region of a KMS key, from its ARN. A development key (`dev:...`) has
 * none.
 */
export function kmsRegion(arn: string): string | null {
  const m = /^arn:aws:kms:([a-z0-9-]+):[0-9]{12}:(key|alias)\//.exec(arn);
  return m ? m[1] : null;
}

/** Whether an ARN is one `tenant_keys.kms_key_arn` would accept. */
export function validKeyArn(arn: string): boolean {
  return /^(arn:aws:kms:[a-z0-9-]+:[0-9]{12}:(key|alias)\/[A-Za-z0-9/_-]+|dev:[A-Za-z0-9:_-]+)$/.test(arn);
}

/**
 * Every column that holds a sealed value, with what it is bound to. The
 * re-seal and rotation read this list, and `check:vault` fails if a column
 * the vault seals into is missing from it. A new sealed column is added here
 * in the same change that starts writing it.
 */
export type SealedColumn = {
  table: string;
  secret: string;
  keyVersion: string;
  /** The purpose the value was sealed for, from the row's id. */
  purpose: (id: string) => string;
  label: string;
  /**
   * The app role may not rewrite this column (a mandate's trigger lets the app
   * only stop one), so the re-seal writes it on the owner's connection, still
   * named to its tenant and still conditional on the value it read.
   */
  ownerWrite?: true;
};

export const connectionPurpose = (id: string) => `connection:${id}`;
export const accountPurpose = (id: string) => `account:${id}`;
export const whatsappPurpose = (accountId: string) => `whatsapp:${accountId}`;
export const pinPurpose = (numberId: string) => `whatsapp-pin:${numberId}`;
export const paymentPurpose = (id: string) => `payment:${id}`;
export const mandatePurpose = (id: string) => `mandate:${id}`;
export const portalAccountPurpose = (id: string) => `portal-account:${id}`;
export const vobizSubPurpose = (id: string) => `vobiz-sub:${id}`;

export const SEALED_COLUMNS: readonly SealedColumn[] = [
  { table: "connections", secret: "secret", keyVersion: "key_version", purpose: connectionPurpose, label: "Meta and Google connections" },
  { table: "connection_accounts", secret: "secret", keyVersion: "key_version", purpose: accountPurpose, label: "Page tokens" },
  { table: "crm_connections", secret: "secret", keyVersion: "key_version", purpose: connectionPurpose, label: "CRM keys" },
  { table: "whatsapp_accounts", secret: "secret", keyVersion: "key_version", purpose: whatsappPurpose, label: "WhatsApp tokens" },
  { table: "whatsapp_numbers", secret: "pin_secret", keyVersion: "pin_key_version", purpose: pinPurpose, label: "WhatsApp PINs" },
  { table: "payment_accounts", secret: "secret", keyVersion: "key_version", purpose: paymentPurpose, label: "Razorpay tokens" },
  { table: "billing_mandates", secret: "secret", keyVersion: "key_version", purpose: mandatePurpose, label: "Auto top-up mandates", ownerWrite: true },
  { table: "portal_accounts", secret: "secret", keyVersion: "key_version", purpose: portalAccountPurpose, label: "Portal account keys" },
  { table: "vobiz_subaccounts", secret: "secret", keyVersion: "key_version", purpose: vobizSubPurpose, label: "Vobiz sub-account tokens" },
];

/** How long an unwrapped data key is kept in memory. */
export const KEY_CACHE_MS = 5 * 60 * 1000;
