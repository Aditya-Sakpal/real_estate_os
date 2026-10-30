import { spMetadata } from "@/lib/sso";

/** Our side of the connection as SAML metadata, for the company's identity provider to read. */
export async function GET(_: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return new Response("Not found", { status: 404 });
  return new Response(spMetadata(orgId), { headers: { "content-type": "application/samlmetadata+xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
