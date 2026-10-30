import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { signRequest, type AwsCredentials } from "./aws-sign.ts";
import { kmsRegion, readMasterKey } from "./vault-rules.ts";

/**
 * The seam to AWS KMS, for the two calls the vault makes: `GenerateDataKey`
 * when a tenant seals for the first time (or its key is rotated), and
 * `Decrypt` when a tenant's wrapped data key is opened. Both carry the
 * encryption context `{ org_id }`, so a wrapped key only ever opens for the
 * tenant it was made for, and the IAM policy can require it.
 *
 * Three drivers, first wins:
 *   an injected one (`useKms()`, the checks);
 *   `KMS_DEV_KEY` on a development machine: 32 bytes that wrap the data keys
 *     locally, ignored on Vercel and in production;
 *   AWS KMS itself, over HTTPS, signed by hand with `aws-sign.ts`.
 *
 * KMS is switched on by `KMS_KEY_ARN`. Without it the vault seals in
 * format 1, exactly as before, and nothing here is called for a seal.
 */

export type KmsContext = { org_id: string };

export type KmsDriver = {
  generateDataKey(keyArn: string, context: KmsContext): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  /** The data key, or null when KMS refused it (another tenant's, or tampered). Throws when KMS could not be asked. */
  decrypt(keyArn: string, wrapped: Buffer, context: KmsContext): Promise<Buffer | null>;
};

let injected: KmsDriver | null = null;

/** The checks' seam: an injected driver beats the dev key and AWS. */
export function useKms(driver: KmsDriver | null): void {
  injected = driver;
}

const hosted = () => !!process.env.VERCEL || process.env.NODE_ENV === "production";

/** The KMS key new data keys are made under, or null when KMS is off. */
export function kmsKeyArn(): string | null {
  const arn = process.env.KMS_KEY_ARN?.trim();
  return arn ? arn : null;
}

const KMS_TIMEOUT_MS = 5_000;

/** A local stand-in for KMS on a development machine. Never on a hosted one. */
export function devKmsDriver(master: Buffer): KmsDriver {
  const ctx = (arn: string, c: KmsContext) => Buffer.from(JSON.stringify({ arn, org_id: c.org_id }));
  return {
    async generateDataKey(keyArn, context) {
      const plaintext = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", master, iv);
      cipher.setAAD(ctx(keyArn, context));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { plaintext, wrapped: Buffer.concat([iv, cipher.getAuthTag(), body]) };
    },
    async decrypt(keyArn, wrapped, context) {
      if (wrapped.length !== 12 + 16 + 32) return null;
      try {
        const d = createDecipheriv("aes-256-gcm", master, wrapped.subarray(0, 12));
        d.setAAD(ctx(keyArn, context));
        d.setAuthTag(wrapped.subarray(12, 28));
        return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
      } catch {
        return null;
      }
    },
  };
}

/** Errors KMS gives for a ciphertext it will not open for this context: an answer, not an outage. */
const REFUSED = new Set(["InvalidCiphertextException", "IncorrectKeyException"]);

export class KmsUnavailable extends Error {}

/** AWS KMS over its JSON API. */
export function awsKmsDriver(opts: { credentials?: () => Promise<AwsCredentials>; fetchImpl?: typeof fetch; now?: () => Date } = {}): KmsDriver {
  let creds: (() => Promise<AwsCredentials>) | null = opts.credentials ?? null;
  const credentials = () => {
    const profile = process.env.AWS_KMS_PROFILE?.trim();
    creds ??= profile ? fromIni({ profile }) : fromNodeProviderChain();
    return creds();
  };
  const call = async (keyArn: string, target: "GenerateDataKey" | "Decrypt", payload: Record<string, unknown>) => {
    const region = kmsRegion(keyArn);
    if (!region) throw new KmsUnavailable(`not a KMS key: ${keyArn}`);
    const host = `kms.${region}.amazonaws.com`;
    const body = JSON.stringify(payload);
    const headers = signRequest({
      method: "POST",
      host,
      path: "/",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${target}` },
      body,
      region,
      service: "kms",
      credentials: await credentials(),
      now: opts.now?.() ?? new Date(),
    });
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(`https://${host}/`, { method: "POST", headers, body, signal: AbortSignal.timeout(KMS_TIMEOUT_MS) });
    } catch (e) {
      throw new KmsUnavailable(`KMS did not answer: ${(e as Error).message}`.slice(0, 200));
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, string | undefined>;
    return { ok: res.ok, json, type: (json.__type ?? "").split("#").pop() ?? "" };
  };
  return {
    async generateDataKey(keyArn, context) {
      const r = await call(keyArn, "GenerateDataKey", { KeyId: keyArn, KeySpec: "AES_256", EncryptionContext: context });
      if (!r.ok || !r.json.Plaintext || !r.json.CiphertextBlob) {
        throw new KmsUnavailable(`${r.type || "KMS"}: ${r.json.message ?? r.json.Message ?? "no data key"}`.slice(0, 200));
      }
      return { plaintext: Buffer.from(r.json.Plaintext, "base64"), wrapped: Buffer.from(r.json.CiphertextBlob, "base64") };
    },
    async decrypt(keyArn, wrapped, context) {
      const r = await call(keyArn, "Decrypt", { KeyId: keyArn, CiphertextBlob: wrapped.toString("base64"), EncryptionContext: context });
      if (r.ok && r.json.Plaintext) return Buffer.from(r.json.Plaintext, "base64");
      if (REFUSED.has(r.type)) return null;
      throw new KmsUnavailable(`${r.type || "KMS"}: ${r.json.message ?? r.json.Message ?? "no answer"}`.slice(0, 200));
    },
  };
}

let aws: KmsDriver | null = null;

/** The driver in force. */
export function kms(): KmsDriver {
  if (injected) return injected;
  const dev = hosted() ? null : readMasterKey(process.env.KMS_DEV_KEY);
  if (dev) return devKmsDriver(dev);
  return (aws ??= awsKmsDriver());
}
