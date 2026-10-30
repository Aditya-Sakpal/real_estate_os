/**
 * The developer's CRM, both ways: the connection, the mappings, what came
 * in and what has to go out.
 *
 * `crm-rules.ts` is the pure half; `crm.ts` is the seam and the adapters.
 * Five rules live here.
 *
 * 1. **Store, answer, then work.** A webhook is written to `crm_events`
 *    before anything else, unique on the CRM's own event id, so a delivery
 *    replayed twice is one row and one change. Working it means reading the
 *    lead as it is NOW from the CRM, so an event arriving late or out of
 *    order cannot move a lead back to where it was an hour ago.
 * 2. **The outbox is the only way out.** A trigger writes "this lead
 *    changed" in the same transaction as the change; `runOutbox()` claims
 *    rows under a lease and works out what to send from the lead as it is
 *    then. A create looks for the buyer by phone first, every time, so a
 *    lost answer, a retry and a buyer already in their CRM from a portal all
 *    end in one record.
 * 3. **Unmapped waits.** An event on a status or project nobody mapped, and
 *    a write needing one, are parked as WAITING with what they wait for.
 *    Saving that mapping releases them.
 * 4. **Inbound writes are marked.** They set `app.crm_inbound`, so the
 *    trigger does not queue an echo of the CRM's own change back to it.
 * 5. **No network inside a transaction.** Every CRM call happens between
 *    transactions: `withTenant()` retries a transaction on a dropped
 *    connection, and a retried transaction must never re-send a request.
 *
 * Imports are relative so the checks can load this straight from source.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { audit, controlDb, withTenant } from "./db/index.ts";
import { open, seal, vaultConfigured, connectionPurpose } from "./vault.ts";
import { adapterFor, type CrmAdapter, type R } from "./crm.ts";
import {
  MAX_OUTBOX_ATTEMPTS,
  OUTBOX_BATCH,
  OUTBOX_LEASE_MS,
  afterFailure,
  bookedFlat,
  callNote,
  crmHookToken,
  crmHookTokenValid,
  crmLabel,
  crmSlug,
  crmVisitKey,
  crmVisitPlan,
  externalUserFor,
  goneFrom,
  groupUnits,
  istMinute,
  istToIso,
  isMapped,
  localValues,
  lsqLeadFieldsFrom,
  mergeLead,
  pushStageFor,
  projectForTower,
  readCredential,
  REMOVED_REASON,
  remoteHash,
  removedMove,
  remoteValues,
  selldoSrd,
  stagesWithoutPush,
  towerFor,
  visitOwners,
  waitingCounts,
  type CatalogItem,
  type CrmError,
  type CrmProvider,
  type CrmVisitPlan,
  type LiveVisit,
  type LsqFieldChoice,
  type MapKind,
  type Mapping,
  type RemoteLead,
  type SyncField,
  type SyncValues,
} from "./crm-rules.ts";
import { PATH, SIDE, isPath, type Facts, type StageKey } from "./lead-rules.ts";
import { applyUnits, markBooked } from "./inventory.ts";
import { readConfig, readFacing, type SheetUnit } from "./inventory-rules.ts";
import { tagCaptured } from "./partners.ts";
import { setVisitStatus } from "./visits.ts";
import { bookCrmVisit, schedule } from "./lead-engine.ts";

const ALL_STAGES: StageKey[] = [...PATH, ...SIDE];

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

export type CrmConnectionRow = {
  id: string;
  provider: CrmProvider;
  status: "CONNECTED" | "BROKEN" | "DISCONNECTED";
  account: string | null;
  settings: Record<string, unknown>;
  secret: Buffer | null;
  webhooks: { event: string; id: string }[];
  poll_cursor: Record<string, unknown>;
  last_polled_at: Date | null;
  last_synced_at: Date | null;
  last_error_code: string | null;
  last_error: string | null;
  connected_at: Date;
};

export async function liveConnection(orgId: string, sql?: TransactionSql): Promise<CrmConnectionRow | null> {
  const q = (s: TransactionSql) => s<CrmConnectionRow[]>`
    SELECT id, provider, status, account, settings, secret, webhooks, poll_cursor, last_polled_at, last_synced_at,
           last_error_code, last_error, connected_at
    FROM crm_connections WHERE org_id = ${orgId} AND status <> 'DISCONNECTED' LIMIT 1`;
  const [row] = sql ? await q(sql) : await withTenant(orgId, q);
  return row ?? null;
}

/** The adapter for a live connection, its credential opened for this call only. */
export async function adapterOf(orgId: string, c: CrmConnectionRow): Promise<CrmAdapter | null> {
  const secret = await open(orgId, connectionPurpose(c.id), c.secret);
  if (!secret) return null;
  return adapterFor({ provider: c.provider, account: c.account, secret, settings: c.settings });
}

/** Where a CRM sends its webhooks for one connection. Null with no public address. */
export function hookUrl(orgId: string, c: { id: string; provider: CrmProvider }): string | null {
  const base = (process.env.CRM_WEBHOOK_BASE ?? process.env.CAPTURE_BASE_URL ?? process.env.CALLS_WEBHOOK_BASE ?? process.env.AUTH_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) return null;
  return `${base}/api/crm/${crmSlug(c.provider)}/webhook?o=${orgId}&c=${c.id}&t=${hookToken(orgId, c.id)}`;
}

function hookSecret(): string {
  const root = process.env.AUTH_SECRET;
  if (!root) throw new Error("AUTH_SECRET is not set.");
  return createHmac("sha256", root).update("salesdesk:crm-hook").digest("hex");
}

export const hookToken = (orgId: string, connectionId: string) => crmHookToken(hookSecret(), orgId, connectionId);
export const hookTokenOk = (orgId: string, connectionId: string, token: string) =>
  crmHookTokenValid(hookSecret(), orgId, connectionId, token);

export type Outcome = { ok: true; note?: string } | { ok: false; message: string; errors?: Record<string, string> };

/**
 * Connect, or replace the credential on the live connection. The credential
 * is proved against the CRM before anything is stored: a key that does not
 * work is refused at the form, not discovered at two in the morning.
 */
export async function connectCrm(input: {
  orgId: string;
  userId: string;
  provider: CrmProvider;
  fields: Record<string, string>;
}): Promise<Outcome> {
  if (!vaultConfigured()) return { ok: false, message: "Connecting a CRM is not switched on for this workspace yet." };
  const read = readCredential(input.provider, input.fields);
  if (!read.ok) return { ok: false, message: "Some details need fixing.", errors: read.errors };

  const existing = await liveConnection(input.orgId);
  if (existing && existing.provider !== input.provider) {
    return { ok: false, message: `${crmLabel(existing.provider)} is connected. Disconnect it first.` };
  }

  const settings = read.settings ?? {};
  const probe = adapterFor({ provider: input.provider, account: read.account, secret: read.secret, settings });
  const proved = await probe.verify();
  if (!proved.ok) {
    return {
      ok: false,
      message: proved.code === "AUTH"
        ? `${crmLabel(input.provider)} did not accept these keys.`
        : proved.code === "UNSUPPORTED"
          ? proved.message
          : `${crmLabel(input.provider)} did not answer. Try again in a minute.`,
    };
  }

  const account = proved.value.account ?? read.account;
  const id = existing?.id ?? randomUUID();
  const sealed = await seal(input.orgId, connectionPurpose(id), read.secret);
  if (!sealed) return { ok: false, message: "Connecting a CRM is not switched on for this workspace yet." };

  await withTenant(input.orgId, async (sql) => {
    if (existing) {
      await sql`
        UPDATE crm_connections SET status = 'CONNECTED', account = ${account}, secret = ${sealed.secret},
               key_version = ${sealed.keyVersion}, settings = settings || ${sql.json(settings as never)},
               last_error_code = NULL, last_error = NULL, connected_by = ${input.userId}, connected_at = now(), updated_at = now()
        WHERE org_id = ${input.orgId} AND id = ${id}`;
    } else {
      await sql`
        INSERT INTO crm_connections (id, org_id, provider, account, settings, secret, key_version, connected_by)
        VALUES (${id}, ${input.orgId}, ${input.provider}, ${account}, ${sql.json(settings as never)},
                ${sealed.secret}, ${sealed.keyVersion}, ${input.userId})`;
    }
  });
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: existing ? "crm.reconnected" : "crm.connected",
    targetType: "crm_connection",
    targetId: id,
    metadata: { provider: input.provider },
  });

  const conn = await liveConnection(input.orgId);
  if (!conn) return { ok: false, message: "The connection was not saved. Try again." };
  const live = await adapterOf(input.orgId, conn) ?? probe;
  const catalog = await refreshCatalog(input.orgId, conn, live);
  const hooks = await registerHooks(input.orgId, conn, live);
  const notes = [catalog.ok ? null : "Their lists could not be read yet.", hooks].filter(Boolean);
  return { ok: true, note: notes.join(" ") || undefined };
}

/** Webhooks where the CRM takes them; polling covers the rest either way. */
async function registerHooks(orgId: string, c: CrmConnectionRow, adapter: CrmAdapter): Promise<string | null> {
  const url = hookUrl(orgId, c);
  if (!url) return null;
  const r = await adapter.subscribe(url, hookToken(orgId, c.id));
  if (!r.ok) return r.code === "UNSUPPORTED" ? null : "Instant updates could not be switched on; changes arrive every few minutes instead.";
  await withTenant(orgId, (sql) => sql`
    UPDATE crm_connections SET webhooks = ${sql.json(r.value as never)}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${c.id}`);
  return null;
}

/**
 * Disconnect. The webhooks are taken down first while the credential still
 * works, then the credential is scrubbed and everything still waiting to go
 * out is cancelled. Links and mappings stay: a reconnect picks them up.
 */
export async function disconnectCrm(input: { orgId: string; userId: string }): Promise<Outcome> {
  const conn = await liveConnection(input.orgId);
  if (!conn) return { ok: true };
  const adapter = await adapterOf(input.orgId, conn);
  if (adapter && conn.webhooks.length) await adapter.unsubscribe(conn.webhooks.map((w) => w.id));
  await withTenant(input.orgId, async (sql) => {
    await sql`
      UPDATE crm_connections SET status = 'DISCONNECTED', secret = NULL, key_version = NULL, webhooks = '[]'::jsonb,
             disconnected_at = now(), updated_at = now()
      WHERE org_id = ${input.orgId} AND id = ${conn.id}`;
    await sql`
      UPDATE crm_outbox SET status = 'CANCELLED', waiting_on = NULL, waiting_for = NULL, updated_at = now()
      WHERE org_id = ${input.orgId} AND connection_id = ${conn.id} AND status IN ('PENDING', 'RUNNING', 'WAITING')`;
  });
  await audit({ orgId: input.orgId, actorUserId: input.userId, action: "crm.disconnected", targetType: "crm_connection", targetId: conn.id, metadata: { provider: conn.provider } });
  return { ok: true };
}

/**
 * Where a CRM has no projects of its own (LeadSquared), a person says which
 * of its dropdown fields holds the project. The choice is checked against
 * the fields the CRM lists, never taken from the form as typed.
 */
export async function setProjectField(input: { orgId: string; userId: string; schemaName: string }): Promise<Outcome> {
  const conn = await liveConnection(input.orgId);
  const adapter = conn ? await adapterOf(input.orgId, conn) : null;
  if (!conn || !adapter?.projectFields) return { ok: false, message: "No CRM here needs a project field." };
  const fields = await adapter.projectFields();
  if (!fields.ok) return { ok: false, message: `${crmLabel(conn.provider)} did not answer. Try again in a minute.` };
  if (!fields.value.some((f) => f.schemaName === input.schemaName)) return { ok: false, message: "Choose one of the fields listed." };
  await withTenant(input.orgId, (sql) => sql`
    UPDATE crm_connections SET settings = settings || ${sql.json({ projectField: input.schemaName } as never)}, updated_at = now()
    WHERE org_id = ${input.orgId} AND id = ${conn.id}`);
  await audit({ orgId: input.orgId, actorUserId: input.userId, action: "crm.project_field", targetType: "crm_connection", targetId: conn.id });
  const fresh = await liveConnection(input.orgId);
  if (fresh) await refreshCatalog(input.orgId, fresh);
  return { ok: true };
}

/** The fields a person may pick the project from, when the CRM needs one picked. */
export async function projectFieldChoices(orgId: string): Promise<{ schemaName: string; label: string }[] | null> {
  const conn = await liveConnection(orgId);
  const adapter = conn ? await adapterOf(orgId, conn) : null;
  if (!adapter?.projectFields) return null;
  const r = await adapter.projectFields();
  return r.ok ? r.value : [];
}

/** The fields a person may say hold configuration and budget, where the CRM keeps them in custom fields. */
export async function leadFieldChoices(orgId: string): Promise<LsqFieldChoice[] | null> {
  const conn = await liveConnection(orgId);
  const adapter = conn ? await adapterOf(orgId, conn) : null;
  if (!adapter?.leadFieldChoices) return null;
  const r = await adapter.leadFieldChoices();
  return r.ok ? r.value : [];
}

/**
 * Which of the CRM's fields hold configuration and budget. Each is checked
 * against the fields the CRM lists, and what is stored is the CRM's own
 * description of it (its kind and options), never what the form sent. An
 * empty choice stops that value syncing. The two may not be one field.
 */
export async function setLeadFields(input: { orgId: string; userId: string; config: string | null; budget: string | null }): Promise<Outcome> {
  const conn = await liveConnection(input.orgId);
  const adapter = conn ? await adapterOf(input.orgId, conn) : null;
  if (!conn || !adapter?.leadFieldChoices) return { ok: false, message: "No CRM here keeps these in fields of its own." };
  if (input.config && input.config === input.budget) return { ok: false, message: "Configuration and budget need a field each." };
  const listed = await adapter.leadFieldChoices();
  if (!listed.ok) return { ok: false, message: `${crmLabel(conn.provider)} did not answer. Try again in a minute.` };
  const pick = (name: string | null) => (name ? listed.value.find((f) => f.schemaName === name) ?? null : null);
  const config = pick(input.config);
  const budget = pick(input.budget);
  if ((input.config && !config) || (input.budget && !budget)) return { ok: false, message: "Choose one of the fields listed." };
  const leadFields = { ...(config ? { config } : {}), ...(budget ? { budget } : {}) };
  await withTenant(input.orgId, async (sql) => {
    await sql`
      UPDATE crm_connections SET settings = settings || ${sql.json({ leadFields } as never)}, updated_at = now()
      WHERE org_id = ${input.orgId} AND id = ${conn.id}`;
    // What was agreed about a field nobody could read is no agreement: the next pass compares afresh.
    await sql`
      UPDATE crm_links SET remote_hash = NULL WHERE org_id = ${input.orgId} AND connection_id = ${conn.id}`;
  });
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "crm.lead_fields",
    targetType: "crm_connection",
    targetId: conn.id,
    metadata: { config: !!config, budget: !!budget },
  });
  return { ok: true };
}

async function markBroken(orgId: string, connectionId: string, e: CrmError): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    UPDATE crm_connections SET status = 'BROKEN', last_error_code = ${e.code}, last_error = ${e.message.slice(0, 300)}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${connectionId} AND status = 'CONNECTED'`);
}

async function noteHealth(orgId: string, connectionId: string, e: CrmError | null): Promise<void> {
  if (e?.code === "AUTH") return markBroken(orgId, connectionId, e);
  await withTenant(orgId, (sql) =>
    e
      ? sql`UPDATE crm_connections SET last_error_code = ${e.code}, last_error = ${e.message.slice(0, 300)}, updated_at = now()
            WHERE org_id = ${orgId} AND id = ${connectionId}`
      : sql`UPDATE crm_connections SET last_synced_at = now(), last_error_code = NULL, last_error = NULL
            WHERE org_id = ${orgId} AND id = ${connectionId}`);
}

// ---------------------------------------------------------------------------
// Their catalog, and the mappings a person makes
// ---------------------------------------------------------------------------

type MappingRow = {
  id: string;
  kind: MapKind;
  external_id: string;
  label: string;
  parent_id: string | null;
  parent_label: string | null;
  rank: number;
  stage: StageKey | null;
  scope_node_id: string | null;
  user_id: string | null;
  ignored: boolean;
  push_as: boolean;
  last_seen_at: Date | null;
};

const toMapping = (r: MappingRow): Mapping & { id: string; lastSeenAt: Date | null } => ({
  id: r.id,
  kind: r.kind,
  externalId: r.external_id,
  label: r.label,
  parentId: r.parent_id,
  parentLabel: r.parent_label,
  rank: r.rank,
  stage: r.stage,
  nodeId: r.scope_node_id,
  userId: r.user_id,
  ignored: r.ignored,
  pushAs: r.push_as,
  lastSeenAt: r.last_seen_at,
});

export type MappingView = ReturnType<typeof toMapping>;

export async function loadMappings(orgId: string, connectionId: string, sql?: TransactionSql): Promise<MappingView[]> {
  const q = (s: TransactionSql) => s<MappingRow[]>`
    SELECT id, kind, external_id, label, parent_id, parent_label, rank, stage, scope_node_id, user_id, ignored, push_as, last_seen_at
    FROM crm_mappings WHERE org_id = ${orgId} AND connection_id = ${connectionId}
    ORDER BY kind, rank, label`;
  const rows = sql ? await q(sql) : await withTenant(orgId, q);
  return rows.map(toMapping);
}

/**
 * Read their statuses, projects and users, and add anything new as a row
 * waiting to be mapped. Nothing is ever deleted: an event may still name a
 * status they retired, and it has to resolve the way it used to.
 */
export async function refreshCatalog(orgId: string, c: CrmConnectionRow, adapter?: CrmAdapter): Promise<R<number>> {
  const a = adapter ?? await adapterOf(orgId, c);
  if (!a) return { ok: false, code: "AUTH", message: "The CRM credential could not be opened.", retryable: false };
  // Nothing to list: its towers are matched by the campaign key a person gives.
  if (!a.twoWay) return { ok: true, value: 0 };
  const items: CatalogItem[] = [];
  for (const kind of ["STAGE", "PROJECT", "USER"] as MapKind[]) {
    const r = await a.catalog(kind);
    if (!r.ok) {
      await noteHealth(orgId, c.id, r);
      return r;
    }
    items.push(...r.value);
  }
  await withTenant(orgId, async (sql) => {
    for (const kind of ["STAGE", "PROJECT", "USER"] as MapKind[]) {
      const seen = items.filter((i) => i.kind === kind).map((i) => i.externalId);
      await sql`
        UPDATE crm_mappings SET last_seen_at = NULL
        WHERE org_id = ${orgId} AND connection_id = ${c.id} AND kind = ${kind}
          AND ${seen.length ? sql`external_id <> ALL(${seen})` : sql`true`}`;
    }
    for (const i of items) {
      await sql`
        INSERT INTO crm_mappings (org_id, connection_id, kind, external_id, label, parent_id, parent_label, rank)
        VALUES (${orgId}, ${c.id}, ${i.kind}, ${i.externalId.slice(0, 200)}, ${i.label.slice(0, 200)},
                ${i.parentId}, ${i.parentLabel?.slice(0, 200) ?? null}, ${i.rank})
        ON CONFLICT (connection_id, kind, external_id) DO UPDATE
          SET label = EXCLUDED.label, parent_id = EXCLUDED.parent_id, parent_label = EXCLUDED.parent_label,
              rank = EXCLUDED.rank, last_seen_at = now()`;
    }
  });
  await noteHealth(orgId, c.id, null);
  return { ok: true, value: items.length };
}

export type MappingChoice =
  | { id: string; to: "stage"; stage: StageKey }
  | { id: string; to: "node"; nodeId: string }
  | { id: string; to: "user"; userId: string }
  | { id: string; to: "ignore" }
  | { id: string; to: "clear" };

/**
 * Save what a person said their words mean. Every target is read back inside
 * the tenant: a tower must be one of this organisation's PHASE nodes, a user
 * an active member, a stage one of our nine. Then whatever was waiting on
 * these is released.
 */
export async function saveMappings(input: {
  orgId: string;
  userId: string;
  choices: MappingChoice[];
  /** Our stage to the id of the mapping row of theirs we set for it. */
  pushAs: Partial<Record<StageKey, string | null>>;
}): Promise<Outcome> {
  const conn = await liveConnection(input.orgId);
  if (!conn) return { ok: false, message: "No CRM is connected." };
  const res = await withTenant(input.orgId, async (sql): Promise<Outcome & { released?: number }> => {
    const maps = await loadMappings(input.orgId, conn.id, sql);
    const byId = new Map(maps.map((m) => [m.id, m]));
    const nodeIds = input.choices.flatMap((c) => (c.to === "node" ? [c.nodeId] : []));
    const userIds = input.choices.flatMap((c) => (c.to === "user" ? [c.userId] : []));
    const towers = nodeIds.length
      ? new Set((await sql<{ id: string }[]>`
          SELECT id FROM scope_nodes WHERE org_id = ${input.orgId} AND kind = 'PHASE' AND id::text = ANY(${nodeIds})`).map((r) => r.id))
      : new Set<string>();
    const people = userIds.length
      ? new Set((await sql<{ user_id: string }[]>`
          SELECT DISTINCT user_id FROM memberships
          WHERE org_id = ${input.orgId} AND status = 'ACTIVE' AND user_id::text = ANY(${userIds})`).map((r) => r.user_id))
      : new Set<string>();

    const touched: string[] = [];
    for (const c of input.choices) {
      const m = byId.get(c.id);
      if (!m) return { ok: false, message: "That list changed since the page was opened. Refresh and try again." };
      const wrong =
        (c.to === "stage" && (m.kind !== "STAGE" || !ALL_STAGES.includes(c.stage))) ||
        (c.to === "node" && ((m.kind !== "PROJECT" && m.kind !== "TOWER") || !towers.has(c.nodeId))) ||
        (c.to === "user" && (m.kind !== "USER" || !people.has(c.userId)));
      if (wrong) return { ok: false, message: `"${m.label}" cannot be matched to that.` };
      await sql`
        UPDATE crm_mappings SET
          stage = ${c.to === "stage" ? c.stage : null},
          scope_node_id = ${c.to === "node" ? c.nodeId : null},
          user_id = ${c.to === "user" ? c.userId : null},
          ignored = ${c.to === "ignore"},
          push_as = CASE WHEN ${c.to === "stage"} AND stage = ${c.to === "stage" ? c.stage : null} THEN push_as ELSE false END,
          mapped_by = ${input.userId}, mapped_at = now()
        WHERE org_id = ${input.orgId} AND id = ${m.id}`;
      touched.push(m.externalId);
    }

    for (const [stage, mappingId] of Object.entries(input.pushAs) as [StageKey, string | null][]) {
      if (!ALL_STAGES.includes(stage)) continue;
      await sql`UPDATE crm_mappings SET push_as = false WHERE org_id = ${input.orgId} AND connection_id = ${conn.id} AND push_as AND stage = ${stage}`;
      if (!mappingId) continue;
      const [set] = await sql`
        UPDATE crm_mappings SET push_as = true
        WHERE org_id = ${input.orgId} AND connection_id = ${conn.id} AND id = ${mappingId} AND kind = 'STAGE' AND stage = ${stage}
        RETURNING id`;
      if (!set) return { ok: false, message: "Choose a CRM status that is matched to that stage." };
      touched.push(stage);
    }

    // Release what waited on any of these.
    const events = await sql`
      UPDATE crm_events SET outcome = NULL, waiting_on = NULL, waiting_for = NULL
      WHERE org_id = ${input.orgId} AND connection_id = ${conn.id} AND outcome = 'WAITING'`;
    const writes = await sql`
      UPDATE crm_outbox SET status = 'PENDING', waiting_on = NULL, waiting_for = NULL, not_before = now(), updated_at = now()
      WHERE org_id = ${input.orgId} AND connection_id = ${conn.id} AND status = 'WAITING'`;
    return { ok: true, released: events.count + writes.count };
  });
  if (res.ok) {
    await audit({
      orgId: input.orgId,
      actorUserId: input.userId,
      action: "crm.mapped",
      targetType: "crm_connection",
      targetId: conn.id,
      metadata: { choices: input.choices.length, released: res.released ?? 0 },
    });
  }
  return res.ok ? { ok: true } : res;
}

// ---------------------------------------------------------------------------
// Inbound: a webhook stored, then worked
// ---------------------------------------------------------------------------

/** Store a delivery once. The route answers straight after. */
export async function recordHook(input: {
  orgId: string;
  connectionId: string;
  externalId: string;
  kind: string;
  payload: unknown;
}): Promise<{ fresh: boolean }> {
  return withTenant(input.orgId, async (sql) => {
    const [conn] = await sql`SELECT id FROM crm_connections WHERE org_id = ${input.orgId} AND id = ${input.connectionId} AND status = 'CONNECTED'`;
    if (!conn) return { fresh: false };
    const rows = await sql`
      INSERT INTO crm_events (org_id, connection_id, source, external_id, kind, payload)
      VALUES (${input.orgId}, ${input.connectionId}, 'WEBHOOK', ${input.externalId.slice(0, 200)}, ${input.kind.slice(0, 60)},
              ${sql.json(input.payload as never)})
      ON CONFLICT (connection_id, source, external_id) DO NOTHING
      RETURNING id`;
    return { fresh: rows.length > 0 };
  });
}

type LeadRow = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  stage: StageKey;
  path_stage: string;
  facts: Facts;
  exit_reason: string | null;
  owner_id: string | null;
  scope_node_id: string;
  channel: string;
};

async function loadLead(sql: TransactionSql, orgId: string, leadId: string, lock = false): Promise<LeadRow | null> {
  // An erased buyer is gone as far as the CRM is concerned: nothing is sent
  // about them, and nothing it sends is written back onto them.
  const [l] = lock
    ? await sql<LeadRow[]>`
        SELECT id, name, phone, email, stage, path_stage, facts, exit_reason, owner_id, scope_node_id, channel
        FROM leads WHERE org_id = ${orgId} AND id = ${leadId} AND erased_at IS NULL FOR UPDATE`
    : await sql<LeadRow[]>`
        SELECT id, name, phone, email, stage, path_stage, facts, exit_reason, owner_id, scope_node_id, channel
        FROM leads WHERE org_id = ${orgId} AND id = ${leadId} AND erased_at IS NULL`;
  return l ?? null;
}

/**
 * Write what the CRM owns onto our lead. Marked as inbound, so the trigger
 * does not queue it straight back. A stage moved there is a person's move,
 * recorded on the lead's history as having happened in the CRM.
 */
async function applyToLocal(
  sql: TransactionSql,
  orgId: string,
  lead: LeadRow,
  changes: Partial<SyncValues>,
  provider: CrmProvider,
): Promise<void> {
  if (!Object.keys(changes).length) return;
  await sql`SELECT set_config('app.crm_inbound', 'on', true)`;
  const facts: Facts = { ...lead.facts };
  if (changes.config !== undefined) facts.config = changes.config ?? undefined;
  if (changes.budget !== undefined) facts.budget = changes.budget ?? undefined;
  if (changes.bookedOn !== undefined) facts.bookedOn = changes.bookedOn ?? undefined;
  if (changes.agreement !== undefined) facts.agreement = changes.agreement ?? undefined;
  if (changes.visitAt) {
    facts.visitDate = changes.visitAt.slice(0, 10);
    facts.visitTime = changes.visitAt.slice(11, 16);
  }
  let ownerId = lead.owner_id;
  if (changes.ownerId !== undefined) {
    ownerId = changes.ownerId;
    const [u] = ownerId ? await sql<{ name: string | null }[]>`SELECT name FROM users WHERE id = ${ownerId}` : [];
    if (u?.name) facts.owner = u.name;
  }
  for (const k of Object.keys(facts) as (keyof Facts)[]) if (facts[k] === undefined) delete facts[k];

  const stage = changes.stage ?? lead.stage;
  const onPath = isPath(stage);
  const exitReason = onPath ? null : (changes.exitReason ?? lead.exit_reason ?? "Other").slice(0, 120);
  await sql`
    UPDATE leads SET
      name = ${changes.name ?? lead.name},
      email = ${changes.email !== undefined ? changes.email : lead.email},
      stage = ${stage},
      path_stage = ${onPath ? stage : lead.path_stage},
      exit_reason = ${exitReason},
      owner_id = ${ownerId},
      facts = ${sql.json(facts as never)},
      updated_at = now()
    WHERE org_id = ${orgId} AND id = ${lead.id}`;
  const via = { via: "crm", provider };
  if (changes.stage && changes.stage !== lead.stage) {
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, from_stage, to_stage, reason, detail)
      VALUES (${orgId}, ${lead.id}, 'STAGE', ${lead.stage}, ${changes.stage}, ${`Moved in ${crmLabel(provider)}`}, ${sql.json(via as never)})`;
  }
  if (changes.ownerId !== undefined && changes.ownerId !== lead.owner_id) {
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
      VALUES (${orgId}, ${lead.id}, 'ASSIGNED', ${`Assigned in ${crmLabel(provider)}`}, ${sql.json(via as never)})`;
  }
  await sql`SELECT set_config('app.crm_inbound', 'off', true)`;
}

type EventRow = { id: string; source: string; external_id: string; kind: string; payload: unknown; attempts: number };

const EVENT_LEASE_MS = 2 * 60_000;
const MAX_EVENT_ATTEMPTS = 5;

/** The lead id an event names, whatever shape it arrived in. */
function eventLeadId(e: EventRow): string | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const direct = p.leadId ?? p.externalId ?? (p.payload as Record<string, unknown> | undefined)?.id ?? p.id;
  return typeof direct === "string" && direct ? direct : null;
}

type Finished = {
  outcome: "CREATED" | "LINKED" | "UPDATED" | "UNCHANGED" | "IGNORED" | "WAITING" | "FAILED" | "REMOVED" | "MERGED";
  leadId?: string | null;
  waitingOn?: "STAGE" | "PROJECT" | "USER";
  waitingFor?: string;
  error?: string;
  final?: boolean;
};

async function finishEvent(orgId: string, id: string, done: Finished): Promise<void> {
  const processed = done.outcome !== "WAITING" && (done.outcome !== "FAILED" || done.final);
  await withTenant(orgId, (sql) => sql`
    UPDATE crm_events SET outcome = ${done.outcome}, lead_id = coalesce(${done.leadId ?? null}, lead_id),
           waiting_on = ${done.waitingOn ?? null}, waiting_for = ${done.waitingFor?.slice(0, 200) ?? null},
           error = ${done.error?.slice(0, 500) ?? null}, claimed_until = NULL,
           processed_at = ${processed ? sql`now()` : null}
    WHERE org_id = ${orgId} AND id = ${id}`);
}

/**
 * Work the events waiting for a connection: read each lead as it is now,
 * then create, link or update ours. A record the CRM no longer has, or has
 * merged into another, closes or moves ours (`handleGone()`). Bounded per pass.
 */
export async function processEvents(
  orgId: string,
  c: CrmConnectionRow,
  adapter: CrmAdapter,
  limit = 40,
  now: Date = new Date(),
): Promise<{ done: number; waiting: number; failed: number }> {
  const out = { done: 0, waiting: 0, failed: 0 };
  const claimed = await withTenant(orgId, (sql) => sql<EventRow[]>`
    UPDATE crm_events SET claimed_until = now() + ${`${EVENT_LEASE_MS} milliseconds`}::interval, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM crm_events
      WHERE org_id = ${orgId} AND connection_id = ${c.id} AND processed_at IS NULL
        AND outcome IS DISTINCT FROM 'WAITING' AND attempts < ${MAX_EVENT_ATTEMPTS}
        AND (claimed_until IS NULL OR claimed_until < now())
      ORDER BY received_at LIMIT ${limit}
      FOR UPDATE SKIP LOCKED)
    RETURNING id, source, external_id, kind, payload, attempts`);
  if (!claimed.length) return out;
  const maps = await loadMappings(orgId, c.id);

  for (const e of claimed) {
    const leadId = eventLeadId(e);
    if (!leadId) {
      await finishEvent(orgId, e.id, { outcome: "IGNORED", error: "Names no lead." });
      out.done++;
      continue;
    }
    // A "deleted" event is not believed on its own: the record is read, and
    // only a record that is really gone closes anything here.
    const got = await adapter.getLead(leadId);
    if (!got.ok) {
      await noteHealth(orgId, c.id, got);
      await finishEvent(orgId, e.id, { outcome: "FAILED", error: got.message, final: !got.retryable || e.attempts >= MAX_EVENT_ATTEMPTS });
      out.failed++;
      continue;
    }
    const remote = got.value?.lead ?? null;
    if (!remote || remote.archived || remote.externalId !== leadId) {
      const gone = await handleGone(orgId, c, adapter, maps, leadId, remote, now);
      if (gone) {
        await finishEvent(orgId, e.id, gone);
        if (gone.outcome === "FAILED") out.failed++;
        else out.done++;
        continue;
      }
      if (!remote || remote.archived) {
        await finishEvent(orgId, e.id, { outcome: "IGNORED", error: "No longer in the CRM." });
        out.done++;
        continue;
      }
    }
    const r = await applyRemote(orgId, c, maps, remote, adapter.fields, now);
    await finishEvent(orgId, e.id, r);
    if (r.outcome === "WAITING") out.waiting++;
    else out.done++;
  }
  await noteHealth(orgId, c.id, null);
  return out;
}

type LiveVisitRow = { id: string; scheduled_at: Date; from_crm: boolean };

/**
 * The visit in force for a lead, and whether the CRM owns it: a visit a
 * person typed there stays the CRM's when somebody here moves it, until it
 * is called off.
 */
async function liveVisitOf(sql: TransactionSql, orgId: string, leadId: string): Promise<LiveVisit> {
  const [v] = await sql<LiveVisitRow[]>`
    SELECT v.id, v.scheduled_at,
           EXISTS (SELECT 1 FROM crm_visits k WHERE k.org_id = v.org_id AND k.lead_id = v.lead_id AND k.origin = 'CRM'
                     AND k.status <> 'CANCELLED') AS from_crm
    FROM site_visits v
    WHERE v.org_id = ${orgId} AND v.lead_id = ${leadId} AND v.status IN ('CONFIRMED', 'REQUESTED')
    ORDER BY v.scheduled_at DESC LIMIT 1`;
  return v ? { visitId: v.id, at: istMinute(v.scheduled_at.toISOString())!, fromCrm: v.from_crm } : null;
}

type Applied = Finished & {
  /** What to do to our visit once the lead's own transaction has committed. */
  visit?: { plan: CrmVisitPlan; live: LiveVisit };
  /** Ownership rule R2 fired on a lead the CRM created. */
  r2?: boolean;
};

/**
 * One of their leads, as it is now, onto ours: found by link, else by phone
 * inside the same project (never across projects, never across tenants),
 * else created. Then merged field by field, and the visit the CRM holds
 * booked, moved or called off through the board's own path.
 */
export async function applyRemote(
  orgId: string,
  c: CrmConnectionRow,
  maps: readonly Mapping[],
  remote: RemoteLead,
  carried: readonly SyncField[],
  now: Date = new Date(),
): Promise<Finished> {
  const r = await applyRemoteTx(orgId, c, maps, remote, carried, now);
  const { visit, r2, ...done } = r;
  if (r2 && r.leadId) {
    await audit({
      orgId,
      actorUserId: null,
      action: "lead.ownership",
      targetType: "lead",
      targetId: r.leadId,
      metadata: { ownership: "R2", channel: "CRM", provider: c.provider },
    });
  }
  if (visit && r.leadId) await applyVisitPlan(orgId, c, r.leadId, remote.externalId, visit.plan, visit.live, now);
  // Booked there, on a flat their record names: the flat is booked, so nobody here blocks or quotes it.
  const leadId = r.leadId;
  if (remote.unitNo && leadId) {
    const [lead] = await withTenant(orgId, (sql) => sql<{ stage: string; scope_node_id: string }[]>`
      SELECT stage, scope_node_id FROM leads WHERE org_id = ${orgId} AND id = ${leadId}`);
    const flat = bookedFlat(lead?.stage, remote.unitNo);
    if (lead && flat && (await markBooked(orgId, lead.scope_node_id, flat))) {
      await audit({ orgId, actorUserId: null, action: "inventory.booked_in_crm", targetType: "lead", targetId: leadId, metadata: { provider: c.provider } });
    }
  }
  return done;
}

async function applyRemoteTx(
  orgId: string,
  c: CrmConnectionRow,
  maps: readonly Mapping[],
  remote: RemoteLead,
  carried: readonly SyncField[],
  now: Date,
): Promise<Applied> {
  if (!remote.phone) return { outcome: "IGNORED", error: "No number a person could call." };
  const rv = remoteValues(remote, maps, carried);
  if (rv.stage && !rv.stage.ok && "waiting" in rv.stage) return { outcome: "WAITING", waitingOn: "STAGE", waitingFor: rv.stage.externalId };
  if (!rv.owner.ok && "waiting" in rv.owner) return { outcome: "WAITING", waitingOn: "USER", waitingFor: rv.owner.externalId };

  return withTenant(orgId, async (sql): Promise<Applied> => {
    const [link] = await sql<{ id: string; lead_id: string; base: Partial<SyncValues>; removed_at: Date | null }[]>`
      SELECT id, lead_id, base, removed_at FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id} AND external_id = ${remote.externalId}`;
    // A record the CRM once deleted stays closed here; nothing reopens it by itself.
    if (link?.removed_at) return { outcome: "IGNORED", leadId: link.lead_id, error: "Closed here when the CRM removed it." };

    let lead: LeadRow | null = link ? await loadLead(sql, orgId, link.lead_id, true) : null;
    let outcome: "CREATED" | "LINKED" | "UPDATED" | "UNCHANGED" = "UPDATED";
    let base: Partial<SyncValues> = link?.base ?? {};
    let r2 = false;

    if (!lead) {
      const tower = towerFor(maps, remote.projectIds);
      if (!tower.ok) {
        if ("waiting" in tower) return { outcome: "WAITING" as const, waitingOn: "PROJECT" as const, waitingFor: tower.externalId };
        return { outcome: "IGNORED" as const, error: "none" in tower ? "Names no project." : "Its project is not one of ours." };
      }
      const nodeId = tower.value;
      // The same buyer asking about the same project, while their lead is
      // open, is the lead we already have. The rule `upsertCaptured` follows.
      const [project] = await sql<{ path: string | null }[]>`
        SELECT (SELECT p.path::text FROM scope_nodes p WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS path
        FROM scope_nodes n WHERE n.org_id = ${orgId} AND n.id = ${nodeId}`;
      const [same] = await sql<{ id: string }[]>`
        SELECT l.id FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
        WHERE l.org_id = ${orgId} AND l.phone = ${remote.phone} AND l.stage <> 'lost'
          AND ${project?.path ? sql`n.path <@ ${project.path}::ltree` : sql`l.scope_node_id = ${nodeId}`}
          AND NOT EXISTS (SELECT 1 FROM crm_links k WHERE k.connection_id = ${c.id} AND k.lead_id = l.id)
        ORDER BY l.created_at DESC LIMIT 1
        FOR UPDATE OF l`;
      if (same) {
        lead = await loadLead(sql, orgId, same.id, true);
        outcome = "LINKED";
      } else {
        // A lead that began in their CRM is being worked there: nothing here
        // calls or messages it until a person switches the agent on.
        await sql`SELECT set_config('app.crm_inbound', 'on', true)`;
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO leads (org_id, scope_node_id, name, phone, email, source, channel, external_id, automation, enquired_at)
          VALUES (${orgId}, ${nodeId}, ${(remote.name ?? "Buyer").slice(0, 120)}, ${remote.phone}, ${remote.email},
                  ${`${crmLabel(c.provider)}${remote.source ? `: ${remote.source}` : ""}`.slice(0, 60)}, 'CRM',
                  ${`${c.provider}:${remote.externalId}`.slice(0, 200)}, 'PAUSED', now())
          ON CONFLICT (org_id, channel, external_id) WHERE external_id IS NOT NULL DO NOTHING
          RETURNING id`;
        const id = row?.id ?? (await sql<{ id: string }[]>`
          SELECT id FROM leads WHERE org_id = ${orgId} AND channel = 'CRM' AND external_id = ${`${c.provider}:${remote.externalId}`.slice(0, 200)}`)[0]?.id;
        // Ownership rule R2, as at any other door: a partner holding this
        // buyer at this project owns the lead, and the call gate holds it
        // until the site visit (`partnerHold()` asks the same claim).
        const owned = row ? await tagCaptured(sql, orgId, id, remote.phone!, nodeId) : null;
        r2 = !!owned;
        await sql`
          INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
          VALUES (${orgId}, ${id}, 'CAPTURED', ${`From ${crmLabel(c.provider)}`},
                  ${sql.json({ via: "crm", provider: c.provider, ...(owned ? { rule: "R2" } : {}) } as never)})`;
        await sql`SELECT set_config('app.crm_inbound', 'off', true)`;
        lead = await loadLead(sql, orgId, id, true);
        outcome = "CREATED";
        // Nothing agreed yet: their values are all news, ours are all blank.
        base = {};
      }
      if (!lead) return { outcome: "FAILED" as const, error: "The lead could not be written.", final: false };
      await sql`
        INSERT INTO crm_links (org_id, connection_id, lead_id, external_id, base)
        VALUES (${orgId}, ${c.id}, ${lead.id}, ${remote.externalId}, '{}'::jsonb)
        ON CONFLICT (connection_id, external_id) DO NOTHING`;
    }

    const live = await liveVisitOf(sql, orgId, lead.id);
    const m = mergeLead(base, localValues(lead), rv.values, visitOwners(live));
    const plan = crmVisitPlan({
      toLocalVisitAt: m.toLocal.visitAt,
      stageBefore: lead.stage,
      stageAfter: (m.toLocal.stage ?? lead.stage) as StageKey,
      agreedVisitAt: m.agreed.visitAt,
      live,
      nowIso: now.toISOString(),
    });
    await applyToLocal(sql, orgId, lead, m.toLocal, c.provider);
    await sql`
      UPDATE crm_links SET base = ${sql.json(m.agreed as never)}, remote_hash = ${remoteHash(remote)}, synced_at = now()
      WHERE org_id = ${orgId} AND connection_id = ${c.id} AND external_id = ${remote.externalId}`;
    // What we hold that they do not: queued like any other change of ours.
    if (Object.keys(m.toRemote).length) await queueLead(sql, orgId, c.id, lead.id);
    if (outcome === "UPDATED" && !Object.keys(m.toLocal).length) outcome = "UNCHANGED";
    return { outcome, leadId: lead.id, r2, ...(plan.kind === "none" ? {} : { visit: { plan, live } }) };
  });
}

/**
 * Do to our visit what the CRM's did: book it (or move it, which is a new
 * visit taking its seat while the old one gives its seat back), or call it
 * off. `crm_visits` remembers which of ours is the CRM's, keyed on the
 * CRM's own id for it, so a replay finds the time already booked.
 */
async function applyVisitPlan(
  orgId: string,
  c: CrmConnectionRow,
  leadId: string,
  remoteLeadId: string,
  plan: CrmVisitPlan,
  live: LiveVisit,
  now: Date,
): Promise<void> {
  const key = crmVisitKey(remoteLeadId);
  if (plan.kind === "book") {
    const atIso = istToIso(plan.at);
    if (!atIso) return;
    const booked = await bookCrmVisit({ orgId, leadId, atIso, nowIso: now.toISOString() });
    if (!booked) return;
    await withTenant(orgId, (sql) => sql`
      INSERT INTO crm_visits (org_id, connection_id, lead_id, external_id, visit_id, origin, agreed_at, status)
      VALUES (${orgId}, ${c.id}, ${leadId}, ${key}, ${booked.visitId}, 'CRM', ${plan.at}, ${live ? "MOVED" : "BOOKED"})
      ON CONFLICT (connection_id, external_id) DO UPDATE
        SET lead_id = EXCLUDED.lead_id, visit_id = EXCLUDED.visit_id, origin = 'CRM', agreed_at = EXCLUDED.agreed_at,
            status = EXCLUDED.status, updated_at = now()`);
    await audit({
      orgId,
      actorUserId: null,
      action: live ? "visit.moved" : "visit.booked",
      targetType: "site_visit",
      targetId: booked.visitId,
      metadata: { via: "CRM", provider: c.provider, ...(live ? { from: live.visitId } : {}) },
    });
    return;
  }
  if (plan.kind === "cancel" && live) {
    const done = await setVisitStatus({ orgId, visitId: live.visitId, to: "CANCELLED", from: ["CONFIRMED", "REQUESTED"] });
    if (done) {
      await withTenant(orgId, (sql) => sql`
        UPDATE crm_visits SET status = 'CANCELLED', updated_at = now()
        WHERE org_id = ${orgId} AND connection_id = ${c.id} AND visit_id = ${live.visitId}`);
    }
  }
}

/**
 * A record we linked that the CRM no longer holds as it was: deleted (or
 * archived), or merged into another record. A merge moves the link to the
 * record that survived and reads it; a deletion closes our lead as "Removed
 * in CRM", switches its agent off and keeps the link, marked, so nothing is
 * ever sent to the record again and nothing recreates it. A lead is never
 * deleted here. Null when the record was never ours to link.
 */
async function handleGone(
  orgId: string,
  c: CrmConnectionRow,
  adapter: CrmAdapter,
  maps: readonly Mapping[],
  askedId: string,
  got: RemoteLead | null,
  now: Date,
): Promise<Finished | null> {
  const state = await withTenant(orgId, async (sql) => {
    const [link] = await sql<{ id: string; lead_id: string; removed_at: Date | null }[]>`
      SELECT id, lead_id, removed_at FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id} AND external_id = ${askedId}`;
    const lead = link ? await loadLead(sql, orgId, link.lead_id) : null;
    return { link: link ?? null, lead };
  });
  if (!state.link || !state.lead) return null;
  if (state.link.removed_at) return { outcome: "IGNORED", leadId: state.link.lead_id, error: "Already closed here when the CRM removed it." };
  const lead = state.lead;

  // Another record of the same buyer in the same project is what a merge kept.
  let others: RemoteLead[] = [];
  if (!got || got.archived) {
    const found = await adapter.findByPhone(lead.phone);
    if (!found.ok) return { outcome: "FAILED", leadId: lead.id, error: found.message, final: !found.retryable };
    others = found.value;
  }
  const project = projectForTower(maps, lead.scope_node_id);
  const verdict = goneFrom({ askedId, got, others, projectId: project?.externalId ?? null });
  if (verdict.kind === "live") return null;

  if (verdict.kind === "merged") {
    const moved = await withTenant(orgId, async (sql) => {
      const [taken] = await sql`
        SELECT 1 FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id} AND external_id = ${verdict.into} AND lead_id <> ${lead.id}`;
      if (taken) return false;
      await sql`
        UPDATE crm_links SET external_id = ${verdict.into}, previous_ids = (previous_ids || ${askedId}::text)[1:20],
               removed_reason = 'MERGED', remote_hash = NULL, synced_at = now()
        WHERE org_id = ${orgId} AND id = ${state.link!.id}`;
      await sql`
        UPDATE crm_visits SET external_id = ${crmVisitKey(verdict.into)}, updated_at = now()
        WHERE org_id = ${orgId} AND connection_id = ${c.id} AND external_id = ${crmVisitKey(askedId)}
          AND NOT EXISTS (SELECT 1 FROM crm_visits x WHERE x.connection_id = ${c.id} AND x.external_id = ${crmVisitKey(verdict.into)})`;
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
        VALUES (${orgId}, ${lead.id}, 'NOTE', ${`Merged into another record in ${crmLabel(c.provider)}`},
                ${sql.json({ via: "crm", provider: c.provider } as never)})`;
      return true;
    });
    if (!moved) {
      // The record that survived is already another lead of ours: this one is the duplicate.
      await closeRemoved(orgId, c, state.link.id, lead, "MERGED", now);
      return { outcome: "REMOVED", leadId: lead.id, error: "Merged in the CRM into a record another lead here holds." };
    }
    await audit({ orgId, actorUserId: null, action: "crm.lead_merged", targetType: "lead", targetId: lead.id, metadata: { provider: c.provider } });
    // The record that survived is read now, so its values arrive with the link.
    const next = await adapter.getLead(verdict.into);
    if (next.ok && next.value && !next.value.lead.archived) await applyRemote(orgId, c, maps, next.value.lead, adapter.fields, now);
    return { outcome: "MERGED", leadId: lead.id };
  }

  await closeRemoved(orgId, c, state.link.id, lead, "DELETED", now);
  return { outcome: "REMOVED", leadId: lead.id };
}

/**
 * Close a lead whose CRM record is gone. It goes to Lost as "Removed in CRM"
 * (a booked one stays Booked and is flagged: automation never moves a lead
 * out of Booked), its agent is switched off, what was due for it is called
 * off, and anything waiting to go to the CRM for it is dropped. Marked as
 * inbound, so the change is not queued back to a record that is not there.
 */
async function closeRemoved(orgId: string, c: CrmConnectionRow, linkId: string, lead: LeadRow, why: "DELETED" | "MERGED", now: Date): Promise<void> {
  const move = removedMove(lead.stage);
  const closed = move.to !== lead.stage;
  await withTenant(orgId, async (sql) => {
    await sql`SELECT set_config('app.crm_inbound', 'on', true)`;
    await sql`
      UPDATE leads SET stage = ${move.to}, exit_reason = ${closed ? move.reason : sql`exit_reason`},
             automation = 'PAUSED', needs_person = coalesce(${move.flag}, needs_person), updated_at = now()
      WHERE org_id = ${orgId} AND id = ${lead.id}`;
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, from_stage, to_stage, reason, detail)
      VALUES (${orgId}, ${lead.id}, ${closed ? "STAGE" : "NOTE"}, ${closed ? lead.stage : null}, ${closed ? move.to : null},
              ${`${why === "MERGED" ? "Merged away" : "Removed"} in ${crmLabel(c.provider)}`},
              ${sql.json({ via: "crm", provider: c.provider, removed: why } as never)})`;
    await sql`
      UPDATE crm_links SET removed_at = now(), removed_reason = ${why}, synced_at = now()
      WHERE org_id = ${orgId} AND id = ${linkId}`;
    await sql`
      UPDATE crm_outbox SET status = 'CANCELLED', waiting_on = NULL, waiting_for = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND connection_id = ${c.id} AND lead_id = ${lead.id} AND status IN ('PENDING', 'WAITING')`;
    await sql`SELECT set_config('app.crm_inbound', 'off', true)`;
  });
  if (closed) {
    await schedule(orgId, lead.id, [], { cancelPending: true, reason: REMOVED_REASON });
    const open = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
      SELECT id FROM site_visits WHERE org_id = ${orgId} AND lead_id = ${lead.id} AND status IN ('CONFIRMED', 'REQUESTED')`);
    for (const v of open) await setVisitStatus({ orgId, visitId: v.id, to: "CANCELLED", from: ["CONFIRMED", "REQUESTED"] });
  }
  await audit({
    orgId,
    actorUserId: null,
    action: "crm.lead_removed",
    targetType: "lead",
    targetId: lead.id,
    metadata: { provider: c.provider, why, closed, at: now.toISOString().slice(0, 10) },
  });
}

async function queueLead(sql: TransactionSql, orgId: string, connectionId: string, leadId: string): Promise<void> {
  await sql`
    INSERT INTO crm_outbox (org_id, connection_id, lead_id, op, idempotency_key)
    VALUES (${orgId}, ${connectionId}, ${leadId}, 'LEAD', ${`lead:${leadId}:${randomUUID()}`})
    ON CONFLICT (connection_id, lead_id) WHERE op = 'LEAD' AND status IN ('PENDING', 'WAITING') DO NOTHING`;
}

/** Work what has arrived for one organisation, after a webhook's answer has gone. */
export async function workInbound(orgId: string): Promise<void> {
  const c = await liveConnection(orgId);
  if (!c || c.status !== "CONNECTED") return;
  const adapter = await adapterOf(orgId, c);
  if (!adapter?.twoWay) return;
  await processEvents(orgId, c, adapter);
  await runOutbox(orgId, c, adapter, new Date(), 10);
}

// ---------------------------------------------------------------------------
// Polling: the net under the webhooks
// ---------------------------------------------------------------------------

/** Every five minutes without webhooks; every half hour as a safety net with them. */
export const POLL_EVERY_MS = { hooks: 10 * 60_000, none: 2 * 60_000 };
const POLL_PAGE = 50;
const POLL_MAX_PAGES = 6;
/** A new connection reaches back this far for leads changed in their CRM. */
export const BACKFILL_DAYS = 30;

export function pollDue(c: Pick<CrmConnectionRow, "last_polled_at" | "webhooks">, now: Date): boolean {
  if (!c.last_polled_at) return true;
  const every = c.webhooks.length ? POLL_EVERY_MS.hooks : POLL_EVERY_MS.none;
  return now.getTime() - c.last_polled_at.getTime() >= every;
}

/**
 * Read their most recently changed leads, newest first, and store one event
 * for each that differs from what we last saw. It stops at a full page of
 * nothing new, at a lead older than the backfill, or after six pages.
 */
export async function pollOnce(orgId: string, c: CrmConnectionRow, adapter: CrmAdapter, now: Date, maxPages = POLL_MAX_PAGES): Promise<{ events: number } | CrmError> {
  const since = now.getTime() - BACKFILL_DAYS * 86_400_000;
  let events = 0;
  for (let page = 1; page <= Math.min(maxPages, POLL_MAX_PAGES); page++) {
    const r = await adapter.recentLeads(page, POLL_PAGE);
    if (!r.ok) return r;
    if (!r.value.leads.length) break;
    const ids = r.value.leads.map((l) => l.externalId);
    const known = await withTenant(orgId, (sql) => sql<{ external_id: string; remote_hash: string | null }[]>`
      SELECT external_id, remote_hash FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id} AND external_id = ANY(${ids})`);
    const hashOf = new Map(known.map((k) => [k.external_id, k.remote_hash]));
    let fresh = 0;
    let tooOld = false;
    for (const l of r.value.leads) {
      if (l.updatedAt && Date.parse(l.updatedAt) < since) {
        tooOld = true;
        break;
      }
      const h = remoteHash(l);
      if (hashOf.get(l.externalId) === h) continue;
      const stored = await withTenant(orgId, (sql) => sql`
        INSERT INTO crm_events (org_id, connection_id, source, external_id, kind, payload)
        VALUES (${orgId}, ${c.id}, 'POLL', ${`${l.externalId}:${h}`.slice(0, 200)}, 'lead.polled', ${sql.json({ leadId: l.externalId } as never)})
        ON CONFLICT (connection_id, source, external_id) DO NOTHING
        RETURNING id`);
      if (stored.length) {
        fresh++;
        events++;
      }
    }
    if (tooOld || !fresh || !r.value.more) break;
  }
  await withTenant(orgId, (sql) => sql`
    UPDATE crm_connections SET last_polled_at = ${now}, updated_at = now() WHERE org_id = ${orgId} AND id = ${c.id}`);
  return { events };
}

// ---------------------------------------------------------------------------
// Outbound: the outbox
// ---------------------------------------------------------------------------

type OutboxRow = {
  id: string;
  lead_id: string;
  op: "LEAD" | "NOTE";
  payload: { call_id?: string };
  attempts: number;
  steps: Record<string, unknown>;
  lease_id: string;
};

type Step =
  | { kind: "done" }
  | { kind: "wait"; on: "STAGE" | "PROJECT" | "USER"; for: string }
  | { kind: "later"; ms: number }
  | { kind: "fail"; error: CrmError };

async function claimOutbox(orgId: string, connectionId: string, limit: number): Promise<OutboxRow[]> {
  const lease = randomUUID();
  return withTenant(orgId, (sql) => sql<OutboxRow[]>`
    UPDATE crm_outbox SET status = 'RUNNING', lease_id = ${lease},
           lease_until = now() + ${`${OUTBOX_LEASE_MS} milliseconds`}::interval,
           attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM crm_outbox
      WHERE id IN (
        SELECT DISTINCT ON (lead_id) id FROM crm_outbox c
        WHERE c.org_id = ${orgId} AND c.connection_id = ${connectionId}
          AND (c.status = 'PENDING' OR (c.status = 'RUNNING' AND c.lease_until < now()))
          AND c.not_before <= now()
          AND NOT EXISTS (
            SELECT 1 FROM crm_outbox x
            WHERE x.connection_id = c.connection_id AND x.lead_id = c.lead_id AND x.id <> c.id
              AND x.status = 'RUNNING' AND x.lease_until >= now())
        ORDER BY lead_id, created_at)
      ORDER BY created_at LIMIT ${limit}
      FOR UPDATE SKIP LOCKED)
    RETURNING id, lead_id, op, payload, attempts, steps, lease_id`);
}

async function saveSteps(orgId: string, row: OutboxRow, patch: Record<string, unknown>): Promise<void> {
  Object.assign(row.steps, patch);
  await withTenant(orgId, (sql) => sql`
    UPDATE crm_outbox SET steps = steps || ${sql.json(patch as never)}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${row.id} AND lease_id = ${row.lease_id}`);
}

async function settle(orgId: string, row: OutboxRow, step: Step, now: Date): Promise<void> {
  await withTenant(orgId, (sql) => {
    const mine = sql`org_id = ${orgId} AND id = ${row.id} AND lease_id = ${row.lease_id}`;
    if (step.kind === "done") {
      return sql`UPDATE crm_outbox SET status = 'DONE', done_at = now(), lease_id = NULL, lease_until = NULL,
                 last_error_code = NULL, last_error = NULL, updated_at = now() WHERE ${mine}`;
    }
    if (step.kind === "wait") {
      return sql`UPDATE crm_outbox SET status = 'WAITING', waiting_on = ${step.on}, waiting_for = ${step.for.slice(0, 200)},
                 attempts = greatest(attempts - 1, 0), lease_id = NULL, lease_until = NULL, updated_at = now() WHERE ${mine}`;
    }
    if (step.kind === "later") {
      return sql`UPDATE crm_outbox SET status = 'PENDING', not_before = ${new Date(now.getTime() + step.ms)},
                 attempts = greatest(attempts - 1, 0), lease_id = NULL, lease_until = NULL, updated_at = now() WHERE ${mine}`;
    }
    const next = afterFailure(step.error, row.attempts, now);
    return sql`UPDATE crm_outbox SET status = ${next.status}, not_before = ${next.notBefore},
               last_error_code = ${step.error.code}, last_error = ${step.error.message.slice(0, 300)},
               lease_id = NULL, lease_until = NULL, updated_at = now() WHERE ${mine}`;
  });
}

/** Work the due writes for one connection. Bounded, and one row per lead at a time. */
export async function runOutbox(orgId: string, c: CrmConnectionRow, adapter: CrmAdapter, now: Date, limit = OUTBOX_BATCH): Promise<{ done: number; waiting: number; failed: number }> {
  const out = { done: 0, waiting: 0, failed: 0 };
  const rows = await claimOutbox(orgId, c.id, limit);
  if (!rows.length) return out;
  const maps = await loadMappings(orgId, c.id);
  for (const row of rows) {
    let step: Step;
    try {
      step = row.op === "LEAD" ? await pushLead(orgId, c, adapter, maps, row, now) : await pushNote(orgId, c, adapter, maps, row);
    } catch (e) {
      step = { kind: "fail", error: { code: "UNKNOWN", message: (e as Error).message.slice(0, 300), retryable: true } };
    }
    await settle(orgId, row, step, now);
    if (step.kind === "done") out.done++;
    else if (step.kind === "wait") out.waiting++;
    else if (step.kind === "fail") {
      out.failed++;
      await noteHealth(orgId, c.id, step.error);
      if (step.error.code === "AUTH") break;
    }
  }
  return out;
}

/**
 * Make their record match ours. Creating looks first by phone within the
 * project, so the buyer already in their CRM from a portal, and a create
 * whose answer was lost, both end in one record.
 */
async function pushLead(orgId: string, c: CrmConnectionRow, adapter: CrmAdapter, maps: readonly Mapping[], row: OutboxRow, now: Date): Promise<Step> {
  const state = await withTenant(orgId, async (sql) => {
    const lead = await loadLead(sql, orgId, row.lead_id);
    const [link] = await sql<{ external_id: string; base: Partial<SyncValues>; removed_at: Date | null }[]>`
      SELECT external_id, base, removed_at FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id} AND lead_id = ${row.lead_id}`;
    return { lead, link: link ?? null };
  });
  if (!state.lead) return { kind: "done" };
  // Their record is gone: nothing is sent to it, and nothing makes it again.
  if (state.link?.removed_at) return { kind: "done" };
  const lead = state.lead;
  const local = localValues(lead);
  const project = projectForTower(maps, lead.scope_node_id);
  if (!project || project.ignored) return { kind: "wait", on: "PROJECT", for: lead.scope_node_id };

  // A CRM that only takes new leads in: one create, and nothing after it.
  // Sell.Do answers a number it already holds with that lead's id, so a
  // create whose answer was lost is safe to send again.
  if (!adapter.twoWay) {
    if (state.link) return { kind: "done" };
    await saveSteps(orgId, row, { create_tried: new Date().toISOString() });
    const made = await adapter.createLead({
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      source: lead.channel,
      projectId: project.externalId,
      projectName: project.label,
      ownerExternalId: null,
      values: local,
    });
    if (!made.ok) return { kind: "fail", error: made };
    await withTenant(orgId, (sql) => sql`
      INSERT INTO crm_links (org_id, connection_id, lead_id, external_id, base)
      VALUES (${orgId}, ${c.id}, ${lead.id}, ${made.value}, ${sql.json(local as never)})
      ON CONFLICT DO NOTHING`);
    return { kind: "done" };
  }

  let externalId = state.link?.external_id ?? null;
  let base: Partial<SyncValues> = state.link?.base ?? {};
  let created = false;

  if (!externalId) {
    const found = await adapter.findByPhone(lead.phone);
    if (!found.ok) return { kind: "fail", error: found };
    const taken = new Set(
      found.value.length
        ? (await withTenant(orgId, (sql) => sql<{ external_id: string }[]>`
            SELECT external_id FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id}
              AND external_id = ANY(${found.value.map((r) => r.externalId)})`)).map((r) => r.external_id)
        : [],
    );
    const same = found.value.find((r) => !taken.has(r.externalId) && (!r.projectIds.length || r.projectIds.includes(project.externalId)));
    if (same) {
      externalId = same.externalId;
    } else if (found.value.some((r) => taken.has(r.externalId) && (!r.projectIds.length || r.projectIds.includes(project.externalId)))) {
      return { kind: "fail", error: { code: "INVALID", message: "Their record for this number is already matched to another lead here.", retryable: false } };
    } else {
      await saveSteps(orgId, row, { create_tried: new Date().toISOString() });
      const made = await adapter.createLead({
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        source: lead.channel,
        projectId: project.externalId,
        projectName: project.label,
        ownerExternalId: externalUserFor(maps, lead.owner_id),
        values: local,
      });
      if (!made.ok) return { kind: "fail", error: made };
      externalId = made.value;
      created = true;
      await saveSteps(orgId, row, { created: externalId });
      // What a create sets is what both sides now hold.
      base = { name: local.name, email: local.email, config: local.config, budget: local.budget };
    }
    const linked = externalId;
    await withTenant(orgId, (sql) => sql`
      INSERT INTO crm_links (org_id, connection_id, lead_id, external_id, base)
      VALUES (${orgId}, ${c.id}, ${lead.id}, ${linked}, ${sql.json(base as never)})
      ON CONFLICT DO NOTHING`);
  }

  const got = await adapter.getLead(externalId);
  if (!got.ok) return { kind: "fail", error: got };
  if (!got.value || got.value.lead.archived || got.value.lead.externalId !== externalId) {
    // Deleted or merged there since we last looked: close or move ours, and send nothing.
    const gone = await handleGone(orgId, c, adapter, maps, externalId, got.value?.lead ?? null, now);
    if (gone?.outcome === "FAILED") return { kind: "fail", error: { code: "UNREACHABLE", message: gone.error ?? "The CRM did not answer.", retryable: true } };
    if (gone) return { kind: "done" };
    if (!got.value) return { kind: "fail", error: { code: "NOT_FOUND", message: "The lead was deleted in the CRM.", retryable: false } };
  }
  const rv = remoteValues(got.value.lead, maps, adapter.fields);
  // Their status is one nobody mapped: we cannot tell whether they moved it.
  if (rv.stage && !rv.stage.ok && "waiting" in rv.stage) return { kind: "wait", on: "STAGE", for: rv.stage.externalId };
  if (!rv.owner.ok) delete rv.values.ownerId;
  // A record we just made holds their defaults (a first status, nobody
  // assigned), not a person's decision, so those count as unchanged and
  // ours go across.
  if (created || row.steps.created || row.steps.create_tried) {
    for (const [k, v] of Object.entries(rv.values) as [keyof SyncValues, string | null | undefined][]) {
      if (v !== undefined && !(k in base)) (base as Record<string, string | null>)[k] = v;
    }
  }

  const live = await withTenant(orgId, (sql) => liveVisitOf(sql, orgId, lead.id));
  const m = mergeLead(base, local, rv.values, visitOwners(live));
  const visitPlan = crmVisitPlan({
    toLocalVisitAt: m.toLocal.visitAt,
    stageBefore: lead.stage,
    stageAfter: (m.toLocal.stage ?? lead.stage) as StageKey,
    agreedVisitAt: m.agreed.visitAt,
    live,
    nowIso: now.toISOString(),
  });
  const statusId = m.toRemote.stage ? pushStageFor(maps, m.toRemote.stage) : null;
  if (m.toRemote.stage && !statusId) return { kind: "wait", on: "STAGE", for: m.toRemote.stage };
  const ownerExternalId = externalUserFor(maps, m.toRemote.ownerId ?? null);
  if ("ownerId" in m.toRemote && !ownerExternalId) {
    delete m.toRemote.ownerId;
    m.agreed.ownerId = (base.ownerId ?? null) as string | null;
  }
  delete m.toRemote.exitReason;
  // What their API cannot hold is not sent; it stays agreed, so it is not tried again.
  for (const f of Object.keys(m.toRemote) as SyncField[]) if (!adapter.fields.includes(f)) delete m.toRemote[f];

  if (Object.keys(m.toRemote).length) {
    const sent = await adapter.updateLead(externalId, got.value.raw, m.toRemote, {
      statusId,
      projectId: project.externalId,
      ownerExternalId,
    });
    if (!sent.ok) return { kind: "fail", error: sent };
  }
  const pushedVisit = "visitAt" in m.toRemote && m.toRemote.visitAt ? m.toRemote.visitAt : null;
  await withTenant(orgId, async (sql) => {
    // A visit of ours now in their CRM: remembered as ours, so a later
    // change there is weighed against a visit we own.
    if (pushedVisit) {
      const live = await liveVisitOf(sql, orgId, lead.id);
      if (live && live.at === pushedVisit) {
        await sql`
          INSERT INTO crm_visits (org_id, connection_id, lead_id, external_id, visit_id, origin, agreed_at, status)
          VALUES (${orgId}, ${c.id}, ${lead.id}, ${crmVisitKey(externalId!)}, ${live.visitId}, 'US', ${pushedVisit}, 'BOOKED')
          ON CONFLICT (connection_id, external_id) DO UPDATE
            SET lead_id = EXCLUDED.lead_id, visit_id = EXCLUDED.visit_id, agreed_at = EXCLUDED.agreed_at,
                status = CASE WHEN crm_visits.visit_id IS DISTINCT FROM EXCLUDED.visit_id THEN 'MOVED' ELSE crm_visits.status END,
                updated_at = now()`;
      }
    }
    if (Object.keys(m.toLocal).length) {
      const fresh = await loadLead(sql, orgId, lead.id, true);
      if (fresh) await applyToLocal(sql, orgId, fresh, m.toLocal, c.provider);
    }
    await sql`
      UPDATE crm_links SET base = ${sql.json(m.agreed as never)}, remote_hash = ${remoteHash(got.value!.lead)}, synced_at = now()
      WHERE org_id = ${orgId} AND connection_id = ${c.id} AND lead_id = ${lead.id}`;
  });
  if (visitPlan.kind !== "none") await applyVisitPlan(orgId, c, lead.id, externalId, visitPlan, live, now);
  return { kind: "done" };
}

/** A call's summary, once. A retry looks for the line before adding it. */
async function pushNote(orgId: string, c: CrmConnectionRow, adapter: CrmAdapter, maps: readonly Mapping[], row: OutboxRow): Promise<Step> {
  // A CRM we can only create leads in has nowhere to put a line.
  if (!adapter.twoWay) return { kind: "done" };
  const state = await withTenant(orgId, async (sql) => {
    const [link] = await sql<{ external_id: string; removed_at: Date | null }[]>`
      SELECT external_id, removed_at FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id} AND lead_id = ${row.lead_id}`;
    const [call] = row.payload.call_id
      ? await sql<{ placed_at: Date; connectivity: string | null; duration_s: string | null; outcome: string | null }[]>`
          SELECT placed_at, connectivity, duration_s, outcome FROM calls WHERE org_id = ${orgId} AND id = ${row.payload.call_id}`
      : [];
    const lead = await loadLead(sql, orgId, row.lead_id);
    const [open] = await sql`
      SELECT 1 FROM crm_outbox WHERE org_id = ${orgId} AND connection_id = ${c.id} AND lead_id = ${row.lead_id}
        AND op = 'LEAD' AND status IN ('PENDING', 'RUNNING', 'WAITING')`;
    return { link, call, lead, leadOpen: !!open };
  });
  if (!state.call || !state.lead) return { kind: "done" };
  if (state.link?.removed_at) return { kind: "done" };
  if (!state.link) {
    // Their record is made by the lead's own row; this waits its turn.
    if (!state.leadOpen) await withTenant(orgId, (sql) => queueLead(sql, orgId, c.id, row.lead_id));
    return { kind: "later", ms: 2 * 60_000 };
  }
  const line = callNote({
    placedAt: state.call.placed_at.toISOString(),
    connectivity: state.call.connectivity,
    durationS: state.call.duration_s === null ? null : Number(state.call.duration_s),
    outcome: state.call.outcome,
    facts: state.lead.facts ?? {},
  });
  const got = await adapter.getLead(state.link.external_id);
  if (!got.ok) return { kind: "fail", error: got };
  if (!got.value || got.value.lead.archived) {
    const gone = await handleGone(orgId, c, adapter, maps, state.link.external_id, got.value?.lead ?? null, new Date());
    if (gone?.outcome === "FAILED") return { kind: "fail", error: { code: "UNREACHABLE", message: gone.error ?? "The CRM did not answer.", retryable: true } };
    if (gone) return { kind: "done" };
    return { kind: "fail", error: { code: "NOT_FOUND", message: "The lead was deleted in the CRM.", retryable: false } };
  }
  const notes = (got.value.raw as { notes?: unknown } | null)?.notes;
  if (row.steps.note_tried && typeof notes === "string" && notes.includes(line)) return { kind: "done" };
  await saveSteps(orgId, row, { note_tried: new Date().toISOString() });
  const r = await adapter.addNote(state.link.external_id, got.value.raw, line);
  return r.ok ? { kind: "done" } : { kind: "fail", error: r };
}

// ---------------------------------------------------------------------------
// One pass, for the worker
// ---------------------------------------------------------------------------

export type PassReport = {
  orgId: string;
  provider: CrmProvider;
  polled: number;
  inbound: { done: number; waiting: number; failed: number };
  outbound: { done: number; waiting: number; failed: number };
  error: string | null;
};

/**
 * Poll if due, work the events, then the writes. Nothing runs on a broken
 * connection. `small` is a person's "Sync now": it polls whether due or not,
 * and does a tenth of a worker's pass, so it answers inside a request.
 */
export async function syncPass(orgId: string, now = new Date(), small = false): Promise<PassReport | null> {
  const c = await liveConnection(orgId);
  if (!c || c.status !== "CONNECTED") return null;
  const adapter = await adapterOf(orgId, c);
  const report: PassReport = {
    orgId,
    provider: c.provider,
    polled: 0,
    inbound: { done: 0, waiting: 0, failed: 0 },
    outbound: { done: 0, waiting: 0, failed: 0 },
    error: null,
  };
  if (!adapter) {
    report.error = "The credential could not be opened.";
    return report;
  }
  if ((small || pollDue(c, now)) && adapter.twoWay) {
    const p = await pollOnce(orgId, c, adapter, now, small ? 1 : POLL_MAX_PAGES);
    if ("code" in p) {
      await noteHealth(orgId, c.id, p);
      report.error = p.message;
      if (p.code === "AUTH") return report;
    } else report.polled = p.events;
  }
  if (adapter.twoWay) report.inbound = await processEvents(orgId, c, adapter, small ? 8 : 40);
  report.outbound = await runOutbox(orgId, c, adapter, now, small ? 8 : OUTBOX_BATCH);
  if (adapter.listUnits && !small) await syncCrmUnits(orgId, c, adapter);
  return report;
}

/**
 * The flats a CRM publishes, written as the CRM's: by the sheet import's
 * rules, except that the CRM wins over a sheet. A flat on a block or
 * project nobody mapped to a tower is left alone. Only an adapter with
 * `listUnits()` reaches here, and none has one yet.
 */
async function syncCrmUnits(orgId: string, c: CrmConnectionRow, adapter: CrmAdapter): Promise<void> {
  const got = await adapter.listUnits!();
  if (!got.ok || !got.value?.length) return;
  const maps = await loadMappings(orgId, c.id);
  const { byTower } = groupUnits(maps, got.value);
  for (const [towerId, units] of byTower) {
    const sheet: SheetUnit[] = units.map((u, i) => ({
      line: i + 1,
      wing: u.wing?.trim().slice(0, 40) || null,
      unitNo: u.unitNo.trim().replace(/\s+/g, " ").slice(0, 40),
      floor: u.floor,
      config: u.config ? readConfig(u.config) : null,
      carpetSqft: u.carpetSqft,
      facing: u.facing ? readFacing(u.facing) : null,
      status: u.status,
    }));
    await applyUnits(orgId, towerId, sheet, "CRM");
  }
}

/**
 * Every organisation with a live CRM, one pass each. The list of ids is the
 * one read across tenants, on the owner's connection the way the lead worker
 * lists them; every row after it is read inside its own tenant.
 */
export async function runCrmWork(opts: { orgIds?: string[]; now?: Date } = {}): Promise<PassReport[]> {
  const rows = await controlDb<{ org_id: string }[]>`
    SELECT DISTINCT org_id FROM crm_connections WHERE status = 'CONNECTED'
      ${opts.orgIds ? controlDb`AND org_id = ANY(${opts.orgIds})` : controlDb``}`;
  const out: PassReport[] = [];
  for (const r of rows) {
    try {
      const report = await syncPass(r.org_id, opts.now ?? new Date());
      if (report) out.push(report);
    } catch (e) {
      out.push({
        orgId: r.org_id,
        provider: "LEADSQUARED",
        polled: 0,
        inbound: { done: 0, waiting: 0, failed: 0 },
        outbound: { done: 0, waiting: 0, failed: 0 },
        error: (e as Error).message.slice(0, 200),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// What the screens read
// ---------------------------------------------------------------------------

export type CrmHealth = {
  connectionId: string;
  provider: CrmProvider;
  connectedByName: string | null;
  /** The field holding the project, where the CRM has no projects of its own. */
  projectField: string | null;
  /** Where the CRM keeps configuration and budget in fields of its own: the fields chosen, by their label. */
  leadFields: { config: { label: string; schemaName: string } | null; budget: { label: string; schemaName: string } | null };
  status: CrmConnectionRow["status"];
  account: string | null;
  connectedAt: Date;
  lastSyncedAt: Date | null;
  lastError: string | null;
  hooks: boolean;
  waitingMappings: Record<MapKind, number>;
  stagesWithoutPush: StageKey[];
  eventsWaiting: number;
  eventsFailed: number;
  writesQueued: number;
  writesWaiting: number;
  dead: { id: string; leadId: string; leadName: string; op: string; error: string | null; at: Date }[];
  linked: number;
};

export async function crmHealth(orgId: string): Promise<CrmHealth | null> {
  return withTenant(orgId, async (sql) => {
    const c = await liveConnection(orgId, sql);
    if (!c) return null;
    const maps = await loadMappings(orgId, c.id, sql);
    const [counts] = await sql<{ ew: number; ef: number; wq: number; ww: number; linked: number; who: string | null }[]>`
      SELECT
        (SELECT u.name FROM crm_connections k JOIN users u ON u.id = k.connected_by WHERE k.org_id = ${orgId} AND k.id = ${c.id}) AS who,
        (SELECT count(*)::int FROM crm_events WHERE org_id = ${orgId} AND connection_id = ${c.id} AND outcome = 'WAITING') AS ew,
        (SELECT count(*)::int FROM crm_events WHERE org_id = ${orgId} AND connection_id = ${c.id} AND outcome = 'FAILED' AND processed_at IS NOT NULL
           AND received_at > now() - interval '7 days') AS ef,
        (SELECT count(*)::int FROM crm_outbox WHERE org_id = ${orgId} AND connection_id = ${c.id} AND status IN ('PENDING', 'RUNNING')) AS wq,
        (SELECT count(*)::int FROM crm_outbox WHERE org_id = ${orgId} AND connection_id = ${c.id} AND status = 'WAITING') AS ww,
        (SELECT count(*)::int FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id}) AS linked`;
    const dead = await sql<{ id: string; lead_id: string; name: string; op: string; last_error: string | null; updated_at: Date }[]>`
      SELECT o.id, o.lead_id, l.name, o.op, o.last_error, o.updated_at
      FROM crm_outbox o JOIN leads l ON l.id = o.lead_id
      WHERE o.org_id = ${orgId} AND o.connection_id = ${c.id} AND o.status = 'DEAD'
      ORDER BY o.updated_at DESC LIMIT 50`;
    return {
      connectionId: c.id,
      provider: c.provider,
      connectedByName: counts.who,
      projectField: typeof c.settings.projectField === "string" ? c.settings.projectField : null,
      leadFields: (() => {
        const f = lsqLeadFieldsFrom(c.settings);
        const pick = (x?: { label: string; schemaName: string }) => (x ? { label: x.label, schemaName: x.schemaName } : null);
        return { config: pick(f.config), budget: pick(f.budget) };
      })(),
      status: c.status,
      account: c.account,
      connectedAt: c.connected_at,
      lastSyncedAt: c.last_synced_at,
      lastError: c.last_error,
      hooks: c.webhooks.length > 0,
      waitingMappings: waitingCounts(maps),
      stagesWithoutPush: stagesWithoutPush(maps, ALL_STAGES),
      eventsWaiting: counts.ew,
      eventsFailed: counts.ef,
      writesQueued: counts.wq,
      writesWaiting: counts.ww,
      dead: dead.map((d) => ({ id: d.id, leadId: d.lead_id, leadName: d.name, op: d.op, error: d.last_error, at: d.updated_at })),
      linked: counts.linked,
    };
  });
}

/** A dead write, tried again from the start of its backoff. */
export async function retryDead(input: { orgId: string; userId: string; ids: string[] | "all" }): Promise<number> {
  const n = await withTenant(input.orgId, (sql) => sql`
    UPDATE crm_outbox SET status = 'PENDING', attempts = 0, not_before = now(), last_error_code = NULL, last_error = NULL, updated_at = now()
    WHERE org_id = ${input.orgId} AND status = 'DEAD'
      AND ${input.ids === "all" ? sql`true` : sql`id::text = ANY(${input.ids})`}`);
  if (n.count) {
    await audit({ orgId: input.orgId, actorUserId: input.userId, action: "crm.retried", targetType: "crm_connection", metadata: { rows: n.count } });
  }
  return n.count;
}

/**
 * Sell.Do lists nothing we can read, so each tower is given the key of the
 * campaign its leads belong to (the SRD Sell.Do shows under the campaign's
 * input channels). The tower is read back inside the tenant; the key can
 * only be checked for shape, and the screen says so.
 */
export async function saveTowerKeys(input: { orgId: string; userId: string; keys: { nodeId: string; srd: string | null }[] }): Promise<Outcome> {
  const conn = await liveConnection(input.orgId);
  if (!conn || conn.provider !== "SELLDO") return { ok: false, message: "Sell.Do is not connected." };
  const bad = input.keys.find((k) => k.srd && !selldoSrd(k.srd));
  if (bad) return { ok: false, message: "A campaign key is 24 letters and numbers, as Sell.Do shows it." };
  const srds = input.keys.map((k) => selldoSrd(k.srd)).filter(Boolean);
  if (new Set(srds).size !== srds.length) return { ok: false, message: "Two towers cannot share one campaign key." };
  const res = await withTenant(input.orgId, async (sql): Promise<Outcome> => {
    const ids = input.keys.map((k) => k.nodeId);
    const towers = new Map((await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM scope_nodes WHERE org_id = ${input.orgId} AND kind = 'PHASE' AND id::text = ANY(${ids})`).map((t) => [t.id, t.name]));
    if (towers.size !== new Set(ids).size) return { ok: false, message: "That tower does not exist here." };
    for (const k of input.keys) {
      const srd = selldoSrd(k.srd);
      // A key replaced is kept as ignored rather than deleted: leads already sent under it stay answerable.
      await sql`
        UPDATE crm_mappings SET scope_node_id = NULL, ignored = true, mapped_by = ${input.userId}, mapped_at = now()
        WHERE org_id = ${input.orgId} AND connection_id = ${conn.id} AND kind = 'PROJECT' AND scope_node_id = ${k.nodeId}`;
      if (!srd) continue;
      await sql`
        INSERT INTO crm_mappings (org_id, connection_id, kind, external_id, label, scope_node_id, mapped_by, mapped_at)
        VALUES (${input.orgId}, ${conn.id}, 'PROJECT', ${srd}, ${`Campaign for ${towers.get(k.nodeId)}`.slice(0, 200)}, ${k.nodeId}, ${input.userId}, now())
        ON CONFLICT (connection_id, kind, external_id) DO UPDATE
          SET scope_node_id = EXCLUDED.scope_node_id, label = EXCLUDED.label, ignored = false, mapped_by = EXCLUDED.mapped_by, mapped_at = now()`;
    }
    await sql`
      UPDATE crm_outbox SET status = 'PENDING', waiting_on = NULL, waiting_for = NULL, not_before = now(), updated_at = now()
      WHERE org_id = ${input.orgId} AND connection_id = ${conn.id} AND status = 'WAITING'`;
    return { ok: true };
  });
  if (res.ok) await audit({ orgId: input.orgId, actorUserId: input.userId, action: "crm.mapped", targetType: "crm_connection", targetId: conn.id, metadata: { towers: input.keys.length } });
  return res;
}

/** Everything the mapping screen offers: our towers and our people, inside the tenant. */
export async function mappingTargets(orgId: string): Promise<{
  towers: { id: string; name: string; project: string | null }[];
  people: { id: string; name: string }[];
}> {
  return withTenant(orgId, async (sql) => {
    const towers = await sql<{ id: string; name: string; project: string | null }[]>`
      SELECT n.id, n.name,
             (SELECT p.name FROM scope_nodes p WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project
      FROM scope_nodes n WHERE n.org_id = ${orgId} AND n.kind = 'PHASE'
      ORDER BY project NULLS LAST, n.name`;
    const people = await sql<{ id: string; name: string }[]>`
      SELECT DISTINCT u.id, coalesce(u.name, u.email) AS name
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${orgId} AND m.status = 'ACTIVE' AND u.erased_at IS NULL
      ORDER BY name`;
    return { towers, people };
  });
}

/** crm.read and crm.write for one tower, for the readiness card. */
export async function towerMapped(orgId: string, nodeId: string): Promise<boolean> {
  const c = await liveConnection(orgId);
  if (!c) return false;
  const maps = await loadMappings(orgId, c.id);
  return !!projectForTower(maps, nodeId) && isMapped(projectForTower(maps, nodeId)!);
}

export { MAX_OUTBOX_ATTEMPTS };

/** Where one lead stands with the CRM, for its page. Null with no CRM connected. */
export async function crmStateForLead(orgId: string, leadId: string): Promise<{ provider: CrmProvider; state: "linked" | "queued" | "waiting" | "refused" | "removed"; note: string | null } | null> {
  return withTenant(orgId, async (sql) => {
    const [c] = await sql<{ id: string; provider: CrmProvider }[]>`
      SELECT id, provider FROM crm_connections WHERE org_id = ${orgId} AND status <> 'DISCONNECTED' LIMIT 1`;
    if (!c) return null;
    const [row] = await sql<{ linked: boolean; removed: boolean; open: string | null; error: string | null }[]>`
      SELECT EXISTS (SELECT 1 FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id} AND lead_id = ${leadId}) AS linked,
             EXISTS (SELECT 1 FROM crm_links WHERE org_id = ${orgId} AND connection_id = ${c.id} AND lead_id = ${leadId}
                       AND removed_at IS NOT NULL) AS removed,
             (SELECT status FROM crm_outbox WHERE org_id = ${orgId} AND connection_id = ${c.id} AND lead_id = ${leadId}
                AND status IN ('PENDING', 'RUNNING', 'WAITING', 'DEAD') ORDER BY created_at DESC LIMIT 1) AS open,
             (SELECT last_error FROM crm_outbox WHERE org_id = ${orgId} AND connection_id = ${c.id} AND lead_id = ${leadId}
                AND status = 'DEAD' ORDER BY updated_at DESC LIMIT 1) AS error`;
    const state = row.removed ? "removed" : row.open === "DEAD" ? "refused" : row.open === "WAITING" ? "waiting" : row.linked ? "linked" : "queued";
    return { provider: c.provider, state, note: state === "refused" ? row.error : null };
  });
}
