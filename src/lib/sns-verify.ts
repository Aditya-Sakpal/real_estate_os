import { createVerify } from "node:crypto";
import { snsCertUrlOk, snsDigest, snsStringToSign } from "./portal-rules.ts";

/**
 * Whether a message really came from Amazon SNS: its signature checked
 * against the certificate SNS names, fetched only from an SNS host and kept
 * for a day. The pure half (the string signed, which hosts, which digest) is
 * in `portal-rules.ts`.
 */

const certs = new Map<string, { pem: string; at: number }>();
const CERT_TTL_MS = 24 * 60 * 60 * 1000;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher | null = null;

/** The checks' seam: hand out a certificate without the network. */
export function useSnsFetch(f: Fetcher | null): void {
  fetcher = f;
  certs.clear();
}

async function cert(url: string): Promise<string | null> {
  const hit = certs.get(url);
  if (hit && Date.now() - hit.at < CERT_TTL_MS) return hit.pem;
  try {
    const res = await (fetcher ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const pem = await res.text();
    if (!pem.includes("BEGIN CERTIFICATE")) return null;
    certs.set(url, { pem, at: Date.now() });
    return pem;
  } catch {
    return null;
  }
}

export async function snsSignatureOk(m: Record<string, unknown>): Promise<boolean> {
  const digest = snsDigest(m.SignatureVersion);
  const signed = snsStringToSign(m);
  if (!digest || !signed || typeof m.Signature !== "string" || !snsCertUrlOk(m.SigningCertURL)) return false;
  const pem = await cert(m.SigningCertURL as string);
  if (!pem) return false;
  try {
    return createVerify(digest).update(signed, "utf8").verify(pem, m.Signature, "base64");
  } catch {
    return false;
  }
}
