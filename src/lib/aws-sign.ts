import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, for the one AWS API called without its SDK: AWS
 * End User Messaging's SMS (`sms.ts`). Written by hand, the way `zip.ts`
 * writes an archive, so one request needed no dependency. `check:logic`
 * proves it against AWS's own published example.
 */

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

const hex = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** `20260929T063000Z`, the form every signed request carries. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * The headers that make a request AWS will accept: `x-amz-date`, the
 * session token when there is one, and `authorization`. Every header given
 * is signed, so none can be changed on the way.
 */
export function signRequest(req: {
  method: string;
  host: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
}): Record<string, string> {
  const date = amzDate(req.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  headers.host = req.host;
  headers["x-amz-date"] = date;
  if (req.credentials.sessionToken) headers["x-amz-security-token"] = req.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const signed = names.join(";");
  const canonical = [
    req.method,
    req.path,
    req.query ?? "",
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signed,
    hex(req.body),
  ].join("\n");
  const scope = `${day}/${req.region}/${req.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${req.credentials.secretAccessKey}`, day), req.region), req.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");

  const out: Record<string, string> = {
    ...req.headers,
    "x-amz-date": date,
    authorization: `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
  if (req.credentials.sessionToken) out["x-amz-security-token"] = req.credentials.sessionToken;
  return out;
}
