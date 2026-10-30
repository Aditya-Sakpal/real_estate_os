/**
 * SCIM 2.0: the rules, pure and database-free, covered by `check:logic`.
 *
 * Reading what Okta, Entra ID and OneLogin send, which is SCIM as each of
 * them reads the RFCs: Entra ID sends "Replace" with a capital, "False" as a
 * string and a remove as a filter in the path; Okta replaces the whole
 * member list. Every one of those is read here, and anything else is a 400
 * that names what was not understood rather than a change nobody asked for.
 */

export const SCIM = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  list: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
  patch: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  config: "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  resourceType: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  schema: "urn:ietf:params:scim:schemas:core:2.0:Schema",
} as const;

export type ScimError = { schemas: [string]; status: string; detail: string; scimType?: string };

export const scimError = (status: number, detail: string, scimType?: string): ScimError => ({
  schemas: [SCIM.error],
  status: String(status),
  detail,
  ...(scimType ? { scimType } : {}),
});

export type ScimUserFields = {
  userName: string;
  email: string;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  active: boolean;
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : v === "True" || v === "true" ? true : v === "False" || v === "false" ? false : null);

/** The work address among `emails`: the primary one, else the work one, else the first. */
function emailOf(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null;
  const list = emails.filter((e): e is Record<string, unknown> => !!e && typeof e === "object");
  const pick = list.find((e) => e.primary === true || e.primary === "True") ?? list.find((e) => e.type === "work") ?? list[0];
  const v = typeof pick?.value === "string" ? pick.value.trim().toLowerCase() : "";
  return EMAIL.test(v) ? v : null;
}

/** A user as POST or PUT sends it. We key people on their work address, so one is required. */
export function readScimUser(body: unknown): { ok: true; user: ScimUserFields } | { ok: false; error: ScimError } {
  if (!body || typeof body !== "object") return { ok: false, error: scimError(400, "The body is not a SCIM user.", "invalidSyntax") };
  const b = body as Record<string, unknown>;
  const userName = str(b.userName, 320);
  if (!userName) return { ok: false, error: scimError(400, "userName is required.", "invalidValue") };
  const email = emailOf(b.emails) ?? (EMAIL.test(userName.toLowerCase()) ? userName.toLowerCase() : null);
  if (!email) return { ok: false, error: scimError(400, "A work email address is required, in userName or emails.", "invalidValue") };
  const name = (b.name && typeof b.name === "object" ? b.name : {}) as Record<string, unknown>;
  const active = b.active === undefined ? true : bool(b.active);
  if (active === null) return { ok: false, error: scimError(400, "active must be true or false.", "invalidValue") };
  return {
    ok: true,
    user: { userName, email, externalId: str(b.externalId, 300), givenName: str(name.givenName, 120), familyName: str(name.familyName, 120), active },
  };
}

type Op = { op?: unknown; path?: unknown; value?: unknown };

function opsOf(body: unknown): Op[] | null {
  if (!body || typeof body !== "object") return null;
  const ops = (body as Record<string, unknown>).Operations;
  return Array.isArray(ops) ? (ops as Op[]) : null;
}

/** A PATCH to a user, applied to what we hold. */
export function patchScimUser(cur: ScimUserFields, body: unknown): { ok: true; user: ScimUserFields } | { ok: false; error: ScimError } {
  const ops = opsOf(body);
  if (!ops) return { ok: false, error: scimError(400, "Operations is required.", "invalidSyntax") };
  const u = { ...cur };
  const set = (path: string, value: unknown): string | null => {
    const p = path.toLowerCase();
    if (p === "active") {
      const b = bool(value);
      if (b === null) return "active must be true or false.";
      u.active = b;
    } else if (p === "username") {
      const s = str(value, 320);
      if (!s) return "userName cannot be empty.";
      u.userName = s;
    } else if (p === "externalid") u.externalId = str(value, 300);
    else if (p === "name.givenname") u.givenName = str(value, 120);
    else if (p === "name.familyname") u.familyName = str(value, 120);
    else if (p === "name" && value && typeof value === "object") {
      const n = value as Record<string, unknown>;
      if ("givenName" in n) u.givenName = str(n.givenName, 120);
      if ("familyName" in n) u.familyName = str(n.familyName, 120);
    } else if (p === "emails" || /^emails\[.*\]\.value$/.test(p)) {
      const e = p === "emails" ? emailOf(value) : typeof value === "string" && EMAIL.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
      if (!e) return "That is not an email address.";
      u.email = e;
    }
    // Anything else a provider sends (displayName, title, phoneNumbers, the
    // enterprise extension) is not kept here, and ignoring it is correct.
    return null;
  };
  for (const o of ops) {
    const op = String(o.op ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") return { ok: false, error: scimError(400, `Unknown op "${String(o.op)}".`, "invalidSyntax") };
    const path = typeof o.path === "string" ? o.path : null;
    if (op === "remove") {
      if (path?.toLowerCase() === "externalid") u.externalId = null;
      else if (path?.toLowerCase() === "name.givenname") u.givenName = null;
      else if (path?.toLowerCase() === "name.familyname") u.familyName = null;
      continue;
    }
    if (path) {
      const bad = set(path, o.value);
      if (bad) return { ok: false, error: scimError(400, bad, "invalidValue") };
    } else if (o.value && typeof o.value === "object") {
      for (const [k, v] of Object.entries(o.value as Record<string, unknown>)) {
        const bad = set(k, v);
        if (bad) return { ok: false, error: scimError(400, bad, "invalidValue") };
      }
    } else return { ok: false, error: scimError(400, "An operation without a path needs an object value.", "invalidSyntax") };
  }
  return { ok: true, user: u };
}

export type GroupChange = { displayName?: string; add: string[]; remove: string[]; replace?: string[] };

const memberIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).value : null)).filter((x): x is string => typeof x === "string") : [];

/** A PATCH to a group: its name, members added, removed, or the whole list replaced. */
export function patchScimGroup(body: unknown): { ok: true; change: GroupChange } | { ok: false; error: ScimError } {
  const ops = opsOf(body);
  if (!ops) return { ok: false, error: scimError(400, "Operations is required.", "invalidSyntax") };
  const c: GroupChange = { add: [], remove: [] };
  for (const o of ops) {
    const op = String(o.op ?? "").toLowerCase();
    const path = typeof o.path === "string" ? o.path : "";
    const lp = path.toLowerCase();
    const filtered = path.match(/^members\[value eq "([^"]+)"\]$/i)?.[1];
    if (op === "add" && lp === "members") c.add.push(...memberIds(o.value));
    else if (op === "remove" && filtered) c.remove.push(filtered);
    else if (op === "remove" && lp === "members") {
      const ids = memberIds(o.value);
      if (ids.length) c.remove.push(...ids);
      else c.replace = [];
    } else if (op === "replace" && lp === "members") c.replace = memberIds(o.value);
    else if (op === "replace" && lp === "displayname") {
      const n = str(o.value, 200);
      if (!n) return { ok: false, error: scimError(400, "displayName cannot be empty.", "invalidValue") };
      c.displayName = n;
    } else if ((op === "replace" || op === "add") && !path && o.value && typeof o.value === "object") {
      const v = o.value as Record<string, unknown>;
      if (typeof v.displayName === "string" && v.displayName.trim()) c.displayName = v.displayName.trim().slice(0, 200);
      if (Array.isArray(v.members)) {
        if (op === "replace") c.replace = memberIds(v.members);
        else c.add.push(...memberIds(v.members));
      }
    } else if (lp === "externalid") {
      continue;
    } else return { ok: false, error: scimError(400, `Cannot ${op} "${path || "(no path)"}" on a group.`, "invalidPath") };
  }
  return { ok: true, change: c };
}

/** `userName eq "x"` and the few other filters providers send before creating somebody. */
export function readFilter(raw: string | null): { attr: "userName" | "externalId" | "displayName" | "email"; value: string } | null | "UNSUPPORTED" {
  if (!raw?.trim()) return null;
  const m = raw.trim().match(/^([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i);
  if (!m) return "UNSUPPORTED";
  const attr = m[1].toLowerCase();
  const value = m[2].replace(/\\"/g, '"');
  if (attr === "username") return { attr: "userName", value };
  if (attr === "externalid") return { attr: "externalId", value };
  if (attr === "displayname") return { attr: "displayName", value };
  if (attr === "emails.value" || attr === "emails") return { attr: "email", value: value.toLowerCase() };
  return "UNSUPPORTED";
}

/** SCIM counts from one; a page is at most 200. */
export function readPaging(startIndex: string | null, count: string | null): { start: number; count: number } {
  const s = Number(startIndex);
  const c = Number(count);
  return { start: Number.isInteger(s) && s >= 1 ? s : 1, count: Number.isInteger(c) && c >= 0 ? Math.min(c, 200) : 100 };
}

export function userResource(
  u: ScimUserFields & { id: string; created: string; updated: string },
  base: string,
): Record<string, unknown> {
  return {
    schemas: [SCIM.user],
    id: u.id,
    ...(u.externalId ? { externalId: u.externalId } : {}),
    userName: u.userName,
    name: { ...(u.givenName ? { givenName: u.givenName } : {}), ...(u.familyName ? { familyName: u.familyName } : {}) },
    emails: [{ value: u.email, type: "work", primary: true }],
    active: u.active,
    meta: { resourceType: "User", created: u.created, lastModified: u.updated, location: `${base}/Users/${u.id}` },
  };
}

export function groupResource(
  g: { id: string; displayName: string; externalId: string | null; created: string; updated: string; members: { id: string; userName: string }[] },
  base: string,
): Record<string, unknown> {
  return {
    schemas: [SCIM.group],
    id: g.id,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    displayName: g.displayName,
    members: g.members.map((m) => ({ value: m.id, display: m.userName, $ref: `${base}/Users/${m.id}` })),
    meta: { resourceType: "Group", created: g.created, lastModified: g.updated, location: `${base}/Groups/${g.id}` },
  };
}

export const listResponse = (resources: unknown[], total: number, start: number) => ({
  schemas: [SCIM.list],
  totalResults: total,
  startIndex: start,
  itemsPerPage: resources.length,
  Resources: resources,
});

export function serviceProviderConfig(): Record<string, unknown> {
  return {
    schemas: [SCIM.config],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "The token made on Settings, Single sign-on.", primary: true }],
  };
}

export function resourceTypes(base: string): Record<string, unknown> {
  const t = (id: string, schema: string) => ({ schemas: [SCIM.resourceType], id, name: id, endpoint: `/${id}s`, schema, meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/${id}` } });
  return listResponse([t("User", SCIM.user), t("Group", SCIM.group)], 2, 1);
}

export function schemasList(): Record<string, unknown> {
  const attr = (name: string, type = "string", extra: Record<string, unknown> = {}) => ({ name, type, multiValued: false, required: false, mutability: "readWrite", returned: "default", ...extra });
  return listResponse(
    [
      {
        schemas: [SCIM.schema],
        id: SCIM.user,
        name: "User",
        attributes: [attr("userName", "string", { required: true, uniqueness: "server" }), attr("name", "complex"), attr("emails", "complex", { multiValued: true }), attr("active", "boolean"), attr("externalId")],
      },
      { schemas: [SCIM.schema], id: SCIM.group, name: "Group", attributes: [attr("displayName", "string", { required: true }), attr("members", "complex", { multiValued: true }), attr("externalId")] },
    ],
    2,
    1,
  );
}
