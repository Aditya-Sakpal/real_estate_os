import { randomBytes } from "node:crypto";
import { forgetExternalUser } from "@/lib/connect";
import { parseSignedRequest } from "@/lib/connect-rules";

/**
 * Meta's data deletion callback: somebody asked Meta to have their data
 * deleted from this app.
 *
 * What we hold about that person is the token they granted and their
 * app-scoped id, and both are scrubbed before this answers. Meta wants a
 * status page and a confirmation code back; the code is also in the audit
 * row, so a later question about the request can be answered.
 */
export async function POST(request: Request) {
  const body = await request.formData().catch(() => null);
  const signed = parseSignedRequest(String(body?.get("signed_request") ?? ""), process.env.META_APP_SECRET ?? "");
  if (!signed) return Response.json({ error: "invalid request" }, { status: 400 });

  const code = randomBytes(9).toString("base64url");
  await forgetExternalUser({
    provider: "META",
    externalUserId: signed.userId,
    reason: "DELETION_REQUESTED",
    reference: code,
  });
  const base = (process.env.CONNECT_BASE_URL || process.env.AUTH_URL || new URL(request.url).origin).replace(/\/+$/, "");
  return Response.json({ url: `${base}/connect/deletion?code=${code}`, confirmation_code: code });
}
