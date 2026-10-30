import { forgetExternalUser } from "@/lib/connect";
import { parseSignedRequest } from "@/lib/connect-rules";

/**
 * Meta calls this when somebody removes the app from their Facebook account.
 *
 * Signed with the app secret, and anything that does not verify gets the same
 * answer, so this cannot be used from outside to break a tenant's publishing
 * or to learn whether an id is connected anywhere.
 */
export async function POST(request: Request) {
  const body = await request.formData().catch(() => null);
  const signed = parseSignedRequest(String(body?.get("signed_request") ?? ""), process.env.META_APP_SECRET ?? "");
  if (signed) {
    await forgetExternalUser({ provider: "META", externalUserId: signed.userId, reason: "DEAUTHORIZED" });
  }
  return new Response("ok", { status: 200 });
}
