import { createHash, randomBytes } from "node:crypto";
import type { TransactionSql } from "postgres";
import { audit, auditHash, controlDb, withNoTenant, withTenant } from "./db/index.ts";
import { isPublicEmailDomain } from "./work-account.ts";
import { domainOf } from "./sso-rules.ts";
import { reassignDeparted } from "./departures.ts";
import {
  groupResource,
  listResponse,
  patchScimGroup,
  patchScimUser,
  readFilter,
  readScimUser,
  scimError,
  userResource,
  type GroupChange,
  type ScimError,
  type ScimUserFields,
} from "./scim-rules.ts";

/**
 * SCIM 2.0 provisioning (0064): the company's identity provider adds,
 * changes and removes its people here.
 *
 * Four rules.
 *
 * 1. **A token is one organisation's.** It is found by its hash through
 *    `scim_token_org()`, the one read across tenants, and every call after
 *    that runs inside that tenant. A token cannot make an organisation.
 * 2. **A person is somebody on the company's own domain.** A public mailbox
 *    is refused, and so is a domain the company has not proved (its own
 *    primary domain counts as proved).
 * 3. **A group grants nothing until an admin says what it means**: a role at
 *    a place, mapped on Settings, Single sign-on, under the rule that you
 *    give only what you hold. Then its members hold that role there, and
 *    leaving the group takes it away.
 * 4. **Deactivating somebody ends every membership they hold here**, the
 *    ones an admin gave by hand included, because the company has said this
 *    person no longer works for it. The last admin is the exception the
 *    database keeps: that answers 409, and the person stays.
 */

type Sql = TransactionSql;
type Result<T> = { ok: true; status: number; body: T } | { ok: false; status: number; body: ScimError };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const isId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
export const scimBase = () => `${(process.env.SSO_BASE_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/scim/v2`;
const fail = (status: number, detail: string, scimType?: string) => ({ ok: false as const, status, body: scimError(status, detail, scimType) });

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** A new token, returned once and stored only as its hash. */
export async function createScimToken(o: { orgId: string; userId: string; label: string }): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  const label = o.label.trim().slice(0, 80);
  if (!label) return { ok: false, message: "Name the token after the app that will use it, like Okta." };
  const token = `est_scim_${randomBytes(32).toString("base64url")}`;
  const [row] = await withTenant(o.orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO scim_tokens (org_id, label, token_hash, created_by) VALUES (${o.orgId}, ${label}, ${sha256(token)}, ${o.userId}) RETURNING id`);
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "scim.token_created", targetType: "scim_token", targetId: row.id });
  return { ok: true, token };
}

export async function revokeScimToken(o: { orgId: string; userId: string; tokenId: string }): Promise<{ ok: boolean; message: string }> {
  if (!isId(o.tokenId)) return { ok: false, message: "That token is not here." };
  const r = await withTenant(o.orgId, (sql) => sql`
    UPDATE scim_tokens SET revoked_at = now() WHERE org_id = ${o.orgId} AND id = ${o.tokenId} AND revoked_at IS NULL RETURNING id`);
  if (!r.length) return { ok: false, message: "That token is already revoked." };
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "scim.token_revoked", targetType: "scim_token", targetId: o.tokenId });
  return { ok: true, message: "Revoked. Anything still using it is refused from now on." };
}

/** The organisation a bearer token belongs to, or nothing. */
export async function scimAuth(header: string | null): Promise<string | null> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token || token.length > 200) return null;
  const [r] = await withNoTenant((sql) => sql<{ org_id: string }[]>`SELECT org_id FROM scim_token_org(${sha256(token)})`);
  return r?.org_id ?? null;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

type UserRow = {
  id: string; user_id: string; user_name: string; email: string; external_id: string | null; given_name: string | null;
  family_name: string | null; active: boolean; created_at: Date; updated_at: Date;
};

const USER_COLS = (sql: Sql) => sql`
  s.id, s.user_id, s.user_name, s.email, s.external_id, s.given_name, s.family_name, s.active, s.created_at, s.updated_at`;

const asFields = (r: UserRow): ScimUserFields => ({
  userName: r.user_name,
  email: r.email,
  externalId: r.external_id,
  givenName: r.given_name,
  familyName: r.family_name,
  active: r.active,
});
const asUser = (r: UserRow) => userResource({ ...asFields(r), id: r.id, created: r.created_at.toISOString(), updated: r.updated_at.toISOString() }, scimBase());

/** Whether the company may provision this address: its own proved domain, never a public one. */
async function domainAllowed(sql: Sql, orgId: string, email: string): Promise<boolean> {
  const d = domainOf(email);
  if (isPublicEmailDomain(d)) return false;
  const [r] = await sql<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM sso_domains WHERE org_id = ${orgId} AND domain = ${d} AND verified_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM orgs WHERE id = ${orgId} AND lower(primary_domain) = ${d}) AS ok`;
  return !!r?.ok;
}

export async function listUsers(orgId: string, filter: string | null, start: number, count: number): Promise<Result<unknown>> {
  const f = readFilter(filter);
  if (f === "UNSUPPORTED") return fail(400, "Only userName, externalId and emails.value eq filters are supported.", "invalidFilter");
  return withTenant(orgId, async (sql) => {
    const where = !f
      ? sql``
      : f.attr === "userName"
        ? sql`AND s.user_name = ${f.value}`
        : f.attr === "externalId"
          ? sql`AND s.external_id = ${f.value}`
          : f.attr === "email"
            ? sql`AND s.email = ${f.value}`
            : sql`AND false`;
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM scim_users s WHERE s.org_id = ${orgId} ${where}`;
    const rows = await sql<UserRow[]>`
      SELECT ${USER_COLS(sql)} FROM scim_users s
      WHERE s.org_id = ${orgId} ${where} ORDER BY s.created_at, s.id OFFSET ${start - 1} LIMIT ${count}`;
    return { ok: true as const, status: 200, body: listResponse(rows.map(asUser), n, start) };
  });
}

async function readUser(sql: Sql, orgId: string, id: string): Promise<UserRow | null> {
  if (!isId(id)) return null;
  const [r] = await sql<UserRow[]>`
    SELECT ${USER_COLS(sql)} FROM scim_users s WHERE s.org_id = ${orgId} AND s.id = ${id}`;
  return r ?? null;
}

export async function getUser(orgId: string, id: string): Promise<Result<unknown>> {
  const r = await withTenant(orgId, (sql) => readUser(sql, orgId, id));
  return r ? { ok: true, status: 200, body: asUser(r) } : fail(404, "No such user.");
}

/** The global person behind an address: made as an invite makes one, on the control connection. */
async function personFor(email: string, name: string | null): Promise<string> {
  const [u] = await controlDb<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name) VALUES (${email}, ${domainOf(email)}, ${name})
    ON CONFLICT (email) DO UPDATE SET name = COALESCE(users.name, EXCLUDED.name)
    RETURNING id`;
  return u.id;
}

const fullName = (u: ScimUserFields) => [u.givenName, u.familyName].filter(Boolean).join(" ") || null;

export async function createUser(orgId: string, body: unknown): Promise<Result<unknown>> {
  const read = readScimUser(body);
  if (!read.ok) return { ok: false, status: 400, body: read.error };
  const u = read.user;
  const allowed = await withTenant(orgId, (sql) => domainAllowed(sql, orgId, u.email));
  if (!allowed) return fail(400, "That address is not on a domain your company has proved on Sales Desk.", "invalidValue");
  const userId = await personFor(u.email, fullName(u));
  const out = await withTenant(orgId, async (sql) => {
    const [dup] = await sql<{ id: string }[]>`
      SELECT id FROM scim_users WHERE org_id = ${orgId} AND (user_name = ${u.userName} OR user_id = ${userId})`;
    if (dup) return null;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO scim_users (org_id, user_id, external_id, user_name, email, given_name, family_name, active)
      VALUES (${orgId}, ${userId}, ${u.externalId}, ${u.userName}, ${u.email}, ${u.givenName}, ${u.familyName}, ${u.active})
      RETURNING id`;
    return readUser(sql, orgId, row.id);
  });
  if (!out) return fail(409, "A user with that userName already exists.", "uniqueness");
  await audit({ orgId, actorUserId: null, action: "scim.user_created", targetType: "user", targetId: userId, metadata: { email_sha256: auditHash(u.email) } });
  return { ok: true, status: 201, body: asUser(out) };
}

/**
 * Write a person's fields, then bring their memberships in line: every
 * mapped group they are in, or nothing at all when they are inactive.
 */
async function writeUser(orgId: string, id: string, next: (cur: ScimUserFields) => { ok: true; user: ScimUserFields } | { ok: false; error: ScimError }): Promise<Result<unknown>> {
  try {
    const out = await withTenant(orgId, async (sql) => {
      const cur = await readUser(sql, orgId, id);
      if (!cur) return fail(404, "No such user.");
      const n = next(asFields(cur));
      if (!n.ok) return { ok: false as const, status: 400, body: n.error };
      const u = n.user;
      if (u.email !== asFields(cur).email) return fail(400, "A person's email address cannot be changed here. Remove them and add the new address.", "mutability");
      await sql`
        UPDATE scim_users SET user_name = ${u.userName}, external_id = ${u.externalId}, given_name = ${u.givenName},
          family_name = ${u.familyName}, active = ${u.active}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${id}`;
      await syncPerson(sql, orgId, id);
      const after = await readUser(sql, orgId, id);
      return { ok: true as const, status: 200, body: asUser(after!), deactivated: cur.active && !u.active, userId: cur.user_id };
    });
    if (out.ok && "deactivated" in out && out.deactivated) {
      await audit({ orgId, actorUserId: null, action: "scim.user_deactivated", targetType: "user", targetId: out.userId });
    }
    return out.ok ? { ok: true, status: out.status, body: out.body } : out;
  } catch (e) {
    return lastAdmin(e) ?? Promise.reject(e);
  }
}

export const replaceUser = (orgId: string, id: string, body: unknown) =>
  writeUser(orgId, id, (cur) => {
    const r = readScimUser(body);
    return r.ok ? { ok: true, user: { ...r.user, email: r.user.email ?? cur.email } } : r;
  });

export const patchUser = (orgId: string, id: string, body: unknown) => writeUser(orgId, id, (cur) => patchScimUser(cur, body));

export async function deleteUser(orgId: string, id: string): Promise<Result<null>> {
  try {
    const r = await withTenant(orgId, async (sql) => {
      const cur = await readUser(sql, orgId, id);
      if (!cur) return null;
      await sql`UPDATE scim_users SET active = false WHERE org_id = ${orgId} AND id = ${id}`;
      await syncPerson(sql, orgId, id);
      await sql`DELETE FROM scim_users WHERE org_id = ${orgId} AND id = ${id}`;
      return cur.user_id;
    });
    if (!r) return fail(404, "No such user.");
    await audit({ orgId, actorUserId: null, action: "scim.user_removed", targetType: "user", targetId: r });
    return { ok: true, status: 204, body: null };
  } catch (e) {
    return lastAdmin(e) ?? Promise.reject(e);
  }
}

/** The database kept the last admin: say so as SCIM does, and change nothing. */
function lastAdmin(e: unknown): Result<never> | null {
  return e instanceof Error && e.message.includes("at least one active admin")
    ? fail(409, "This person is the organisation's last admin on Sales Desk. Make somebody else an admin first.", "mutability")
    : null;
}

/**
 * One person's memberships from their groups. Inactive: every membership in
 * this organisation ends. Active: a membership for each mapped group they
 * are in, and the ones a group gave that no group gives any more end.
 */
async function syncPerson(sql: Sql, orgId: string, scimUserId: string): Promise<void> {
  const [p] = await sql<{ user_id: string; active: boolean; name: string }[]>`
    SELECT user_id, active, coalesce(nullif(trim(concat_ws(' ', given_name, family_name)), ''), split_part(user_name::text, '@', 1)) AS name
    FROM scim_users WHERE org_id = ${orgId} AND id = ${scimUserId}`;
  if (!p) return;
  // Whatever they can no longer open moves to somebody who can, in the same transaction.
  const handOver = () => reassignDeparted(sql, { orgId, userId: p.user_id, name: p.name, actorUserId: null });
  if (!p.active) {
    await sql`UPDATE memberships SET status = 'REVOKED', revoked_at = now()
              WHERE org_id = ${orgId} AND user_id = ${p.user_id} AND status <> 'REVOKED'`;
    await handOver();
    return;
  }
  const want = await sql<{ group_id: string; role: string; scope_node_id: string }[]>`
    SELECT g.id AS group_id, g.role, g.scope_node_id FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id
    WHERE m.org_id = ${orgId} AND m.scim_user_id = ${scimUserId} AND g.role IS NOT NULL`;
  const key = (r: { role: string; scope_node_id: string }) => `${r.role}|${r.scope_node_id}`;
  const wanted = new Set(want.map(key));
  const have = await sql<{ id: string; role: string; scope_node_id: string }[]>`
    SELECT id, role, scope_node_id FROM memberships
    WHERE org_id = ${orgId} AND user_id = ${p.user_id} AND scim_group_id IS NOT NULL AND status <> 'REVOKED'`;
  const stale = have.filter((h) => !wanted.has(key(h))).map((h) => h.id);
  if (stale.length) await sql`UPDATE memberships SET status = 'REVOKED', revoked_at = now() WHERE org_id = ${orgId} AND id = ANY(${stale})`;
  for (const w of want) {
    await sql`
      INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at, scim_group_id)
      VALUES (${p.user_id}, ${orgId}, ${w.scope_node_id}, ${w.role}, 'ACTIVE', now(), ${w.group_id})
      ON CONFLICT (user_id, scope_node_id, role) WHERE status <> 'REVOKED' DO NOTHING`;
  }
  await handOver();
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

type GroupRow = { id: string; display_name: string; external_id: string | null; created_at: Date; updated_at: Date };

async function asGroup(sql: Sql, orgId: string, g: GroupRow) {
  const members = await sql<{ id: string; user_name: string }[]>`
    SELECT s.id, s.user_name FROM scim_group_members m JOIN scim_users s ON s.id = m.scim_user_id
    WHERE m.org_id = ${orgId} AND m.group_id = ${g.id} ORDER BY s.user_name`;
  return groupResource(
    { id: g.id, displayName: g.display_name, externalId: g.external_id, created: g.created_at.toISOString(), updated: g.updated_at.toISOString(), members: members.map((m) => ({ id: m.id, userName: m.user_name })) },
    scimBase(),
  );
}

export async function listGroups(orgId: string, filter: string | null, start: number, count: number): Promise<Result<unknown>> {
  const f = readFilter(filter);
  if (f === "UNSUPPORTED" || (f && f.attr !== "displayName" && f.attr !== "externalId")) return fail(400, "Only displayName and externalId eq filters are supported.", "invalidFilter");
  return withTenant(orgId, async (sql) => {
    const where = !f ? sql`` : f.attr === "displayName" ? sql`AND display_name = ${f.value}` : sql`AND external_id = ${f.value}`;
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM scim_groups WHERE org_id = ${orgId} ${where}`;
    const rows = await sql<GroupRow[]>`
      SELECT id, display_name, external_id, created_at, updated_at FROM scim_groups WHERE org_id = ${orgId} ${where}
      ORDER BY created_at, id OFFSET ${start - 1} LIMIT ${count}`;
    const out = [];
    for (const g of rows) out.push(await asGroup(sql, orgId, g));
    return { ok: true as const, status: 200, body: listResponse(out, n, start) };
  });
}

async function readGroup(sql: Sql, orgId: string, id: string): Promise<GroupRow | null> {
  if (!isId(id)) return null;
  const [g] = await sql<GroupRow[]>`SELECT id, display_name, external_id, created_at, updated_at FROM scim_groups WHERE org_id = ${orgId} AND id = ${id}`;
  return g ?? null;
}

export async function getGroup(orgId: string, id: string): Promise<Result<unknown>> {
  return withTenant(orgId, async (sql) => {
    const g = await readGroup(sql, orgId, id);
    return g ? { ok: true as const, status: 200, body: await asGroup(sql, orgId, g) } : fail(404, "No such group.");
  });
}

/** Apply a membership change, then bring every affected person's memberships in line. */
async function changeMembers(sql: Sql, orgId: string, groupId: string, c: GroupChange): Promise<string | null> {
  const ids = [...new Set([...c.add, ...c.remove, ...(c.replace ?? [])])];
  if (ids.some((i) => !isId(i))) return "A member is not a user here.";
  const known = ids.length
    ? await sql<{ id: string }[]>`SELECT id FROM scim_users WHERE org_id = ${orgId} AND id = ANY(${ids})`
    : [];
  const valid = new Set(known.map((k) => k.id));
  if ([...c.add, ...(c.replace ?? [])].some((i) => !valid.has(i))) return "A member is not a user here.";
  const before = await sql<{ scim_user_id: string }[]>`SELECT scim_user_id FROM scim_group_members WHERE org_id = ${orgId} AND group_id = ${groupId}`;
  if (c.replace) {
    await sql`DELETE FROM scim_group_members WHERE org_id = ${orgId} AND group_id = ${groupId}`;
    c = { ...c, add: [...c.add, ...c.replace] };
  }
  for (const id of c.add) {
    await sql`INSERT INTO scim_group_members (org_id, group_id, scim_user_id) VALUES (${orgId}, ${groupId}, ${id}) ON CONFLICT DO NOTHING`;
  }
  if (c.remove.length) await sql`DELETE FROM scim_group_members WHERE org_id = ${orgId} AND group_id = ${groupId} AND scim_user_id = ANY(${c.remove})`;
  if (c.displayName) await sql`UPDATE scim_groups SET display_name = ${c.displayName}, updated_at = now() WHERE org_id = ${orgId} AND id = ${groupId}`;
  else await sql`UPDATE scim_groups SET updated_at = now() WHERE org_id = ${orgId} AND id = ${groupId}`;
  for (const id of new Set([...before.map((b) => b.scim_user_id), ...c.add])) await syncPerson(sql, orgId, id);
  return null;
}

export async function createGroup(orgId: string, body: unknown): Promise<Result<unknown>> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const name = typeof b.displayName === "string" ? b.displayName.trim().slice(0, 200) : "";
  if (!name) return fail(400, "displayName is required.", "invalidValue");
  const external = typeof b.externalId === "string" ? b.externalId.slice(0, 300) : null;
  const members = Array.isArray(b.members) ? (b.members as Record<string, unknown>[]).map((m) => m?.value).filter((v): v is string => typeof v === "string") : [];
  try {
    const out = await withTenant(orgId, async (sql) => {
      const [dup] = await sql`SELECT 1 FROM scim_groups WHERE org_id = ${orgId} AND display_name = ${name}`;
      if (dup) return fail(409, "A group with that displayName already exists.", "uniqueness");
      const [g] = await sql<GroupRow[]>`
        INSERT INTO scim_groups (org_id, display_name, external_id) VALUES (${orgId}, ${name}, ${external})
        RETURNING id, display_name, external_id, created_at, updated_at`;
      const bad = await changeMembers(sql, orgId, g.id, { add: members, remove: [] });
      if (bad) throw new ScimRefusal(400, bad);
      return { ok: true as const, status: 201, body: await asGroup(sql, orgId, g) };
    });
    if (out.ok) await audit({ orgId, actorUserId: null, action: "scim.group_created", targetType: "scim_group", targetId: (out.body as { id: string }).id });
    return out;
  } catch (e) {
    if (e instanceof ScimRefusal) return fail(e.status, e.message, "invalidValue");
    return lastAdmin(e) ?? Promise.reject(e);
  }
}

class ScimRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function writeGroup(orgId: string, id: string, change: GroupChange): Promise<Result<unknown>> {
  try {
    return await withTenant(orgId, async (sql) => {
      const g = await readGroup(sql, orgId, id);
      if (!g) return fail(404, "No such group.");
      if (change.displayName && change.displayName !== g.display_name) {
        const [dup] = await sql`SELECT 1 FROM scim_groups WHERE org_id = ${orgId} AND display_name = ${change.displayName} AND id <> ${id}`;
        if (dup) return fail(409, "A group with that displayName already exists.", "uniqueness");
      }
      const bad = await changeMembers(sql, orgId, id, change);
      if (bad) throw new ScimRefusal(400, bad);
      return { ok: true as const, status: 200, body: await asGroup(sql, orgId, (await readGroup(sql, orgId, id))!) };
    });
  } catch (e) {
    if (e instanceof ScimRefusal) return fail(e.status, e.message, "invalidValue");
    return lastAdmin(e) ?? Promise.reject(e);
  }
}

export async function patchGroup(orgId: string, id: string, body: unknown): Promise<Result<unknown>> {
  const p = patchScimGroup(body);
  if (!p.ok) return { ok: false, status: 400, body: p.error };
  return writeGroup(orgId, id, p.change);
}

export async function replaceGroup(orgId: string, id: string, body: unknown): Promise<Result<unknown>> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const name = typeof b.displayName === "string" ? b.displayName.trim().slice(0, 200) : "";
  if (!name) return fail(400, "displayName is required.", "invalidValue");
  const members = Array.isArray(b.members) ? (b.members as Record<string, unknown>[]).map((m) => m?.value).filter((v): v is string => typeof v === "string") : [];
  return writeGroup(orgId, id, { displayName: name, add: [], remove: [], replace: members });
}

export async function deleteGroup(orgId: string, id: string): Promise<Result<null>> {
  try {
    const r = await withTenant(orgId, async (sql) => {
      const g = await readGroup(sql, orgId, id);
      if (!g) return false;
      await changeMembers(sql, orgId, id, { add: [], remove: [], replace: [] });
      await sql`UPDATE memberships SET status = 'REVOKED', revoked_at = now() WHERE org_id = ${orgId} AND scim_group_id = ${id} AND status <> 'REVOKED'`;
      await sql`DELETE FROM scim_groups WHERE org_id = ${orgId} AND id = ${id}`;
      return true;
    });
    if (!r) return fail(404, "No such group.");
    await audit({ orgId, actorUserId: null, action: "scim.group_removed", targetType: "scim_group", targetId: id });
    return { ok: true, status: 204, body: null };
  } catch (e) {
    return lastAdmin(e) ?? Promise.reject(e);
  }
}

// ---------------------------------------------------------------------------
// The settings screen
// ---------------------------------------------------------------------------

export type ScimOverview = {
  base: string;
  tokens: { id: string; label: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }[];
  people: number;
  active: number;
  groups: { id: string; name: string; members: number; role: string | null; nodeId: string | null; nodeName: string | null }[];
};

export async function scimOverview(orgId: string): Promise<ScimOverview> {
  return withTenant(orgId, async (sql) => {
    const [tokens, [counts], groups] = await Promise.all([
      sql<{ id: string; label: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }[]>`
        SELECT id, label, created_at, last_used_at, revoked_at FROM scim_tokens WHERE org_id = ${orgId} ORDER BY revoked_at NULLS FIRST, created_at DESC`,
      sql<{ people: number; active: number }[]>`
        SELECT count(*)::int AS people, count(*) FILTER (WHERE active)::int AS active FROM scim_users WHERE org_id = ${orgId}`,
      sql<{ id: string; display_name: string; members: number; role: string | null; scope_node_id: string | null; node_name: string | null }[]>`
        SELECT g.id, g.display_name, g.role, g.scope_node_id, n.name AS node_name,
               (SELECT count(*)::int FROM scim_group_members m WHERE m.group_id = g.id) AS members
        FROM scim_groups g LEFT JOIN scope_nodes n ON n.id = g.scope_node_id
        WHERE g.org_id = ${orgId} ORDER BY g.display_name`,
    ]);
    return {
      base: scimBase(),
      tokens: tokens.map((t) => ({ id: t.id, label: t.label, createdAt: t.created_at.toISOString(), lastUsedAt: t.last_used_at?.toISOString() ?? null, revoked: !!t.revoked_at })),
      people: counts?.people ?? 0,
      active: counts?.active ?? 0,
      groups: groups.map((g) => ({ id: g.id, name: g.display_name, members: g.members, role: g.role, nodeId: g.scope_node_id, nodeName: g.node_name })),
    };
  });
}

/**
 * Say what a group means: a role at a place, or nothing. The caller has
 * already asked the giving rule (you give only what you hold, where you
 * hold it); this writes it and brings every member in line.
 */
export async function mapGroup(o: { orgId: string; userId: string; groupId: string; role: string | null; nodeId: string | null }): Promise<{ ok: boolean; message: string }> {
  if (!isId(o.groupId)) return { ok: false, message: "That group is not here." };
  try {
    const r = await withTenant(o.orgId, async (sql) => {
      const g = await readGroup(sql, o.orgId, o.groupId);
      if (!g) return "That group is not here.";
      await sql`
        UPDATE scim_groups SET role = ${o.role}, scope_node_id = ${o.nodeId}, mapped_by = ${o.userId}, mapped_at = now(), updated_at = now()
        WHERE org_id = ${o.orgId} AND id = ${o.groupId}`;
      // A role changed under the group: what it gave before goes, what it gives now comes.
      await sql`UPDATE memberships SET status = 'REVOKED', revoked_at = now()
                WHERE org_id = ${o.orgId} AND scim_group_id = ${o.groupId} AND status <> 'REVOKED'`;
      const members = await sql<{ scim_user_id: string }[]>`SELECT scim_user_id FROM scim_group_members WHERE org_id = ${o.orgId} AND group_id = ${o.groupId}`;
      for (const m of members) await syncPerson(sql, o.orgId, m.scim_user_id);
      return null;
    });
    if (r) return { ok: false, message: r };
  } catch (e) {
    if (lastAdmin(e)) return { ok: false, message: "That would leave the organisation with no admin. Make somebody else an admin first." };
    throw e;
  }
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "scim.group_mapped", targetType: "scim_group", targetId: o.groupId, metadata: { role: o.role } });
  return { ok: true, message: o.role ? "Saved. Its members hold that role now." : "Saved. The group gives nothing now." };
}
