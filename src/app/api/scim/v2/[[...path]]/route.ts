import type { NextRequest } from "next/server";
import {
  createGroup,
  createUser,
  deleteGroup,
  deleteUser,
  getGroup,
  getUser,
  listGroups,
  listUsers,
  patchGroup,
  patchUser,
  replaceGroup,
  replaceUser,
  scimAuth,
  scimBase,
} from "@/lib/scim";
import { readPaging, resourceTypes, schemasList, scimError, serviceProviderConfig } from "@/lib/scim-rules";

/**
 * SCIM 2.0 for a company's identity provider: Users, Groups and the three
 * discovery documents. Every call carries the organisation's bearer token,
 * and everything after it runs inside that organisation.
 */

type Ctx = { params: Promise<{ path?: string[] }> };

const json = (status: number, body: unknown) =>
  body === null
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/scim+json; charset=utf-8" } });

async function route(request: NextRequest, ctx: Ctx, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"): Promise<Response> {
  const [kind, id, ...rest] = (await ctx.params).path ?? [];
  if (method === "GET" && kind === "ServiceProviderConfig") return json(200, serviceProviderConfig());
  if (method === "GET" && kind === "ResourceTypes") return json(200, resourceTypes(scimBase()));
  if (method === "GET" && kind === "Schemas") return json(200, schemasList());

  const orgId = await scimAuth(request.headers.get("authorization"));
  if (!orgId) return json(401, scimError(401, "A valid bearer token is required."));
  if (rest.length || (kind !== "Users" && kind !== "Groups")) return json(404, scimError(404, "Not found."));

  const body = method === "POST" || method === "PUT" || method === "PATCH" ? await request.json().catch(() => undefined) : undefined;
  if (body === undefined && (method === "POST" || method === "PUT" || method === "PATCH")) return json(400, scimError(400, "The body is not JSON.", "invalidSyntax"));
  const q = request.nextUrl.searchParams;
  const { start, count } = readPaging(q.get("startIndex"), q.get("count"));

  const users = kind === "Users";
  const r = !id
    ? method === "GET"
      ? await (users ? listUsers : listGroups)(orgId, q.get("filter"), start, count)
      : method === "POST"
        ? await (users ? createUser : createGroup)(orgId, body)
        : { ok: false as const, status: 405, body: scimError(405, "Not allowed here.") }
    : method === "GET"
      ? await (users ? getUser : getGroup)(orgId, id)
      : method === "PUT"
        ? await (users ? replaceUser : replaceGroup)(orgId, id, body)
        : method === "PATCH"
          ? await (users ? patchUser : patchGroup)(orgId, id, body)
          : method === "DELETE"
            ? await (users ? deleteUser : deleteGroup)(orgId, id)
            : { ok: false as const, status: 405, body: scimError(405, "Not allowed here.") };
  return json(r.status, r.body);
}

export const GET = (r: NextRequest, c: Ctx) => route(r, c, "GET");
export const POST = (r: NextRequest, c: Ctx) => route(r, c, "POST");
export const PUT = (r: NextRequest, c: Ctx) => route(r, c, "PUT");
export const PATCH = (r: NextRequest, c: Ctx) => route(r, c, "PATCH");
export const DELETE = (r: NextRequest, c: Ctx) => route(r, c, "DELETE");
