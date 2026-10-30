import { createSign } from "node:crypto";

/**
 * Files served from Amazon CloudFront instead of the bucket in Mumbai, when it
 * is set up: a viewer is handed a CloudFront link signed for the same window
 * a bucket link would be (`viewWindow()`), and the file comes from the edge
 * nearest them. The bucket stays private; CloudFront reads it through an
 * origin access control, and refuses any request without our signature.
 *
 * Switched on by three settings and nothing else:
 *   CDN_BASE_URL      https://dxxxx.cloudfront.net (no trailing slash)
 *   CDN_KEY_PAIR_ID   the public key's id in the distribution's key group
 *   CDN_PRIVATE_KEY   its private key, PEM (newlines may be written as \n)
 * Any one missing and links come from the bucket as before.
 */

export type CdnConfig = { base: string; keyPairId: string; privateKey: string };

export function cdnConfig(env: Record<string, string | undefined> = process.env): CdnConfig | null {
  const base = env.CDN_BASE_URL?.trim().replace(/\/+$/, "");
  const keyPairId = env.CDN_KEY_PAIR_ID?.trim();
  const privateKey = env.CDN_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!base || !/^https:\/\/[a-z0-9.-]+$/i.test(base) || !keyPairId || !privateKey) return null;
  return { base, keyPairId, privateKey };
}

/** A key as a URL path: each segment encoded, the slashes kept. */
export function cdnPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** CloudFront's own base64: `+` `=` `/` become `-` `_` `~`. */
function cfBase64(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/=/g, "_").replace(/\//g, "~");
}

/**
 * A link signed with a canned policy: this one file, until `expiresAt`. The
 * same file and the same moment give the same link, so a browser keeps it.
 */
export function cdnSignedUrl(cfg: CdnConfig, key: string, expiresAt: Date): string {
  const url = `${cfg.base}/${cdnPath(key)}`;
  const expires = Math.floor(expiresAt.getTime() / 1000);
  const policy = JSON.stringify({
    Statement: [{ Resource: url, Condition: { DateLessThan: { "AWS:EpochTime": expires } } }],
  });
  const signature = cfBase64(createSign("RSA-SHA1").update(policy).sign(cfg.privateKey));
  return `${url}?Expires=${expires}&Signature=${signature}&Key-Pair-Id=${encodeURIComponent(cfg.keyPairId)}`;
}
