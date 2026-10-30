import { createHmac, randomUUID } from "node:crypto";
import { audit, withTenant } from "./db/index.ts";
import { open, seal } from "./vault.ts";
import { portalAccountPurpose } from "./vault-rules.ts";
import { markEvent, recordEvent } from "./leads.ts";
import { publicBase } from "./capture.ts";
import type { CapturedLead } from "./capture-rules.ts";
import type { QueueItem } from "./queue.ts";
import {
  autoMatch,
  capturedFrom,
  housingAnswer,
  housingDue,
  housingIdOk,
  housingUrl,
  housingWindow,
  isPortalKey,
  pushRecords,
  readPortalPush,
  refusedRecordId,
  MAILBOX_KEY_CHARS,
  NO_PROJECT,
  portalKey,
  portalKeyValid,
  portalLabel,
  portalMailbox,
  PORTAL_KEYS,
  readPortalEmail,
  readPortalSheet,
  refusedId,
  waitingReason,
  type PortalEmail,
  type PortalKey,
  type PortalLead,
} from "./portal-rules.ts";

/**
 * Leads from the property portals: the address they are forwarded to, the
 * key that proves it, the wordings a person matches to towers, and the
 * enquiries waiting on one. The pure half is `portal-rules.ts`.
 *
 * An email or an export row becomes a `lead_events` row with source PORTAL
 * and then goes the ordinary way (`processEvent()`): `portalEvent()` is the
 * one step that differs, because the tower comes from a person's match of
 * the portal's wording and never from a guess.
 */

function secret(): string {
  const root = process.env.AUTH_SECRET;
  if (!root) throw new Error("AUTH_SECRET is not set.");
  return createHmac("sha256", root).update("salesdesk:portal-leads").digest("hex");
}

/** The domain portal emails are received on (an SES receipt rule's), or null when none is set up. */
export function portalMailDomain(): string | null {
  const d = (process.env.PORTAL_MAIL_DOMAIN ?? "").trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

async function keyVersion(orgId: string): Promise<number> {
  const [r] = await withTenant(orgId, (sql) => sql<{ key_version: number }[]>`
    SELECT key_version FROM portal_settings WHERE org_id = ${orgId}`);
  return r?.key_version ?? 1;
}

export type PortalAddresses = {
  /** The address portal emails are forwarded to, when a mail domain is set up. */
  mailbox: string | null;
  /** Where a forwarding service posts each email as JSON. */
  endpoint: string | null;
  /** The link each portal posts its leads to, one per portal. */
  pushLinks: { portal: PortalKey; label: string; url: string }[];
  /** When the key was last changed. */
  rotatedAt: string | null;
};

export async function portalAddresses(orgId: string): Promise<PortalAddresses> {
  const [r] = await withTenant(orgId, (sql) => sql<{ key_version: number; rotated_at: Date | null }[]>`
    SELECT key_version, rotated_at FROM portal_settings WHERE org_id = ${orgId}`);
  const key = portalKey(secret(), orgId, r?.key_version ?? 1);
  const domain = portalMailDomain();
  const base = publicBase();
  return {
    mailbox: domain ? portalMailbox(orgId, key, domain) : null,
    endpoint: base ? `${base}/api/leads/portal?o=${orgId}&k=${key}` : null,
    pushLinks: base
      ? PORTAL_KEYS.map((p) => ({ portal: p, label: portalLabel(p), url: `${base}/api/leads/portal/push?o=${orgId}&k=${key}&p=${p.toLowerCase()}` }))
      : [],
    rotatedAt: r?.rotated_at?.toISOString() ?? null,
  };
}

/** Whether a key opens this organisation's portal door: the full key, or the address's part of it. */
export async function portalKeyOk(orgId: string, key: string, inMailbox = false): Promise<boolean> {
  return portalKeyValid(secret(), orgId, await keyVersion(orgId), key, inMailbox ? MAILBOX_KEY_CHARS : 32);
}

/** A new key: the old address and endpoint stop working at once. `integration:manage`. */
export async function rotatePortalKey(orgId: string, userId: string): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    INSERT INTO portal_settings (org_id, key_version, rotated_at, rotated_by)
    VALUES (${orgId}, 2, now(), ${userId})
    ON CONFLICT (org_id) DO UPDATE
      SET key_version = portal_settings.key_version + 1, rotated_at = now(), rotated_by = ${userId}`);
  await audit({ orgId, actorUserId: userId, action: "portal.key_rotated", targetType: "org", targetId: orgId, metadata: {} });
}

// ---------------------------------------------------------------------------
// At the door
// ---------------------------------------------------------------------------

export type Taken = { ok: true; eventId: string; fresh: boolean } | { ok: false; eventId: string | null; reason: string };

/**
 * One portal email, stored once. An email that is not a lead (no number, a
 * hidden one) is stored too, closed with its reason, so the card can say
 * how many arrived that could not be read; the same email twice counts once.
 */
export async function takeEmail(orgId: string, email: PortalEmail, receivedIso: string, via: "EMAIL" | "POST"): Promise<Taken> {
  const read = readPortalEmail(email, receivedIso);
  if (!read.ok) {
    const ev = await recordEvent({
      orgId,
      source: "PORTAL",
      externalId: refusedId(read.portal, email, receivedIso),
      payload: { portal: read.portal, via, refused: read.reason },
    });
    if (ev.fresh) await markEvent(orgId, ev.id, null, "JUNK", read.reason);
    return { ok: false, eventId: ev.id, reason: read.reason };
  }
  const ev = await recordEvent({ orgId, source: "PORTAL", externalId: read.lead.externalId, payload: { portal: read.lead.portal, via, lead: read.lead } });
  return { ok: true, eventId: ev.id, fresh: ev.fresh };
}

export type PushTaken = { added: number; again: number; refused: { index: number; reason: string }[]; eventIds: string[] };

/**
 * What a portal posted to its link, each lead stored once as an event. A
 * record that is not a lead is stored closed with its reason, so the card
 * counts it once however often the portal sends it again.
 */
export async function takePush(orgId: string, portal: PortalKey, body: unknown, receivedIso: string, via: "PUSH" | "PULL" = "PUSH"): Promise<PushTaken> {
  const read = readPortalPush(body, portal, receivedIso);
  const records = pushRecords(body);
  const out: PushTaken = { added: 0, again: 0, refused: read.refused, eventIds: [] };
  for (const lead of read.leads) {
    const ev = await recordEvent({ orgId, source: "PORTAL", externalId: lead.externalId, payload: { portal, via, lead } });
    if (ev.fresh) {
      out.added += 1;
      out.eventIds.push(ev.id);
    } else out.again += 1;
  }
  for (const r of read.refused) {
    const ev = await recordEvent({
      orgId,
      source: "PORTAL",
      externalId: refusedRecordId(portal, records[r.index] ?? r.index, receivedIso),
      payload: { portal, via, refused: r.reason },
    });
    if (ev.fresh) await markEvent(orgId, ev.id, null, "JUNK", r.reason);
  }
  return out;
}

export type SheetImport =
  | { ok: true; added: number; again: number; outside: number; refused: { line: number; reason: string }[]; eventIds: string[] }
  | { ok: false; message: string };

/**
 * A portal's export, uploaded from the console. Each row is an event as an
 * email would be, so a row already received by email is the same lead. A
 * row whose wording is matched to a tower outside the uploader's reach is
 * refused: uploading is adding leads, and `lead:create` is asked where they
 * would land.
 */
export async function importPortalSheet(o: {
  orgId: string;
  userId: string;
  portal: PortalKey;
  rows: readonly (readonly string[])[];
  /** Where the uploader holds `lead:create`, as ltree paths; null is everywhere. */
  scopes: string[] | null;
  todayIso?: string;
}): Promise<SheetImport> {
  const read = readPortalSheet(o.rows, o.portal, o.todayIso ?? new Date().toISOString());
  if (!read.ok) return read;
  const keys = [...new Set(read.leads.map((r) => r.lead.projectKey))];
  const placed = await withTenant(o.orgId, (sql) => sql<{ project_key: string; path: string | null }[]>`
    SELECT pp.project_key, n.path::text AS path
    FROM portal_projects pp LEFT JOIN scope_nodes n ON n.id = pp.phase_id
    WHERE pp.org_id = ${o.orgId} AND pp.project_key = ANY(${keys})`);
  const pathOf = new Map(placed.map((p) => [p.project_key, p.path]));
  const within = (path: string | null | undefined) =>
    !path || o.scopes === null || o.scopes.some((s) => path === s || path.startsWith(`${s}.`));
  const refused = [...read.refused];
  const eventIds: string[] = [];
  let added = 0;
  let again = 0;
  let outside = 0;
  for (const { line, lead } of read.leads) {
    if (!within(pathOf.get(lead.projectKey))) {
      outside += 1;
      refused.push({ line, reason: "Its project is not one you can add leads to." });
      continue;
    }
    const ev = await recordEvent({ orgId: o.orgId, source: "PORTAL", externalId: lead.externalId, payload: { portal: lead.portal, via: "SHEET", lead } });
    if (ev.fresh) {
      added += 1;
      eventIds.push(ev.id);
    } else again += 1;
  }
  refused.sort((a, b) => a.line - b.line);
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "portal.sheet_imported",
    targetType: "org",
    targetId: o.orgId,
    metadata: { portal: o.portal, added, again, refused: refused.length },
  });
  return { ok: true, added, again, outside, refused, eventIds };
}

// ---------------------------------------------------------------------------
// The step `processEvent()` takes for a portal event
// ---------------------------------------------------------------------------

/**
 * The tower for a portal's wording: the one a person matched, or the one
 * its exact name names, recorded the first time it arrives. A wording
 * nobody matched leaves the event WAITING, not failed: no attempt is used
 * up and the worker passes over it until a person matches it.
 */
export async function portalEvent(
  orgId: string,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<{ ok: true; lead: CapturedLead } | { ok: false; message: string }> {
  const lead = payload.lead as PortalLead | undefined;
  if (!lead || typeof lead.phone !== "string" || !isPortalKey(lead.portal)) {
    const why = typeof payload.refused === "string" ? payload.refused : "Nothing in it a person could contact.";
    await markEvent(orgId, eventId, null, "JUNK", why);
    return { ok: false, message: why };
  }
  const key = lead.projectKey || NO_PROJECT;
  const match = await withTenant(orgId, async (sql) => {
    let [row] = await sql<{ phase_id: string | null; not_ours: boolean }[]>`
      SELECT phase_id, not_ours FROM portal_projects WHERE org_id = ${orgId} AND project_key = ${key}`;
    if (!row) {
      const nodes = await sql<{ id: string; kind: string; name: string; path: string }[]>`
        SELECT id, kind, name, path::text AS path FROM scope_nodes
        WHERE org_id = ${orgId} AND kind IN ('PROJECT', 'PHASE')`;
      const auto = autoMatch(key, nodes);
      [row] = await sql<{ phase_id: string | null; not_ours: boolean }[]>`
        INSERT INTO portal_projects (org_id, project_key, project_text, portal, phase_id, matched_at)
        VALUES (${orgId}, ${key}, ${lead.projectText}, ${lead.portal}, ${auto}, ${auto ? sql`now()` : null})
        ON CONFLICT (org_id, project_key) DO UPDATE SET last_seen_at = now()
        RETURNING phase_id, not_ours`;
    } else {
      await sql`UPDATE portal_projects SET last_seen_at = now() WHERE org_id = ${orgId} AND project_key = ${key}`;
    }
    return row;
  });
  if (match.not_ours) {
    await markEvent(orgId, eventId, null, "JUNK", "Not one of your projects.");
    return { ok: false, message: "Not one of your projects." };
  }
  if (!match.phase_id) {
    await withTenant(orgId, (sql) => sql`
      UPDATE lead_events SET outcome = 'WAITING', error = ${waitingReason(lead.projectText)}
      WHERE org_id = ${orgId} AND id = ${eventId} AND processed_at IS NULL`);
    return { ok: false, message: waitingReason(lead.projectText) };
  }
  return { ok: true, lead: capturedFrom(lead, match.phase_id) };
}

// ---------------------------------------------------------------------------
// Matching wordings to towers
// ---------------------------------------------------------------------------

export type PortalProjectView = {
  id: string;
  key: string;
  text: string | null;
  portal: PortalKey;
  phaseId: string | null;
  notOurs: boolean;
  /** Matched by its exact name rather than by a person. */
  byName: boolean;
  waiting: number;
  lastSeen: string;
};

export async function listPortalProjects(orgId: string): Promise<PortalProjectView[]> {
  const rows = await withTenant(orgId, (sql) => sql<{
    id: string; project_key: string; project_text: string | null; portal: PortalKey; phase_id: string | null;
    not_ours: boolean; matched_by: string | null; matched_at: Date | null; waiting: number; last_seen_at: Date;
  }[]>`
    SELECT pp.id, pp.project_key, pp.project_text, pp.portal, pp.phase_id, pp.not_ours, pp.matched_by, pp.matched_at,
           pp.last_seen_at,
           (SELECT count(*) FROM lead_events e
             WHERE e.org_id = ${orgId} AND e.source = 'PORTAL' AND e.outcome = 'WAITING' AND e.processed_at IS NULL
               AND e.payload->'lead'->>'projectKey' = pp.project_key)::int AS waiting
    FROM portal_projects pp WHERE pp.org_id = ${orgId}
    ORDER BY (pp.phase_id IS NULL AND NOT pp.not_ours) DESC, pp.last_seen_at DESC
    LIMIT 200`);
  return rows.map((r) => ({
    id: r.id,
    key: r.project_key,
    text: r.project_text,
    portal: r.portal,
    phaseId: r.phase_id,
    notOurs: r.not_ours,
    byName: !!r.phase_id && !r.matched_by,
    waiting: r.waiting,
    lastSeen: r.last_seen_at.toISOString(),
  }));
}

/** The value a match's select posts: a tower's id, "none" (not ours) or "" (not matched yet). */
export const NOT_OURS = "none";

/**
 * Saves what a person matched. Only a wording whose answer changed is
 * written. Returns the events now released: waiting on a wording that has a
 * tower, for the caller to run, and closes those on one that is not ours.
 */
export async function savePortalMatches(
  orgId: string,
  userId: string,
  picks: { id: string; value: string }[],
): Promise<{ ok: true; changed: number; release: string[] } | { ok: false; message: string }> {
  const out = await withTenant(orgId, async (sql) => {
    const rows = await sql<{ id: string; project_key: string; phase_id: string | null; not_ours: boolean }[]>`
      SELECT id, project_key, phase_id, not_ours FROM portal_projects WHERE org_id = ${orgId} AND id = ANY(${picks.map((p) => p.id)})`;
    const phases = new Set(
      (await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PHASE'`).map((p) => p.id),
    );
    const placed: string[] = [];
    const closed: string[] = [];
    let changed = 0;
    for (const p of picks) {
      const row = rows.find((r) => r.id === p.id);
      if (!row) continue;
      const notOurs = p.value === NOT_OURS;
      const phaseId = !notOurs && phases.has(p.value) ? p.value : null;
      if (!notOurs && p.value && !phaseId) return { bad: true as const };
      if (row.not_ours === notOurs && row.phase_id === phaseId) continue;
      await sql`
        UPDATE portal_projects
        SET phase_id = ${phaseId}, not_ours = ${notOurs},
            matched_by = ${phaseId || notOurs ? userId : null}, matched_at = ${phaseId || notOurs ? sql`now()` : null}
        WHERE org_id = ${orgId} AND id = ${row.id}`;
      changed += 1;
      if (phaseId) placed.push(row.project_key);
      if (notOurs) closed.push(row.project_key);
    }
    const waitingOn = (keys: string[]) => sql<{ id: string }[]>`
      SELECT id FROM lead_events
      WHERE org_id = ${orgId} AND source = 'PORTAL' AND outcome = 'WAITING' AND processed_at IS NULL
        AND payload->'lead'->>'projectKey' = ANY(${keys})
      ORDER BY received_at LIMIT 500`;
    const release = placed.length ? (await waitingOn(placed)).map((e) => e.id) : [];
    const close = closed.length ? (await waitingOn(closed)).map((e) => e.id) : [];
    return { bad: false as const, changed, release, close };
  });
  if (out.bad) return { ok: false, message: "That tower is not one of yours. Choose again." };
  for (const id of out.close) await markEvent(orgId, id, null, "JUNK", "Not one of your projects.");
  if (out.changed) {
    await audit({
      orgId,
      actorUserId: userId,
      action: "portal.projects_matched",
      targetType: "org",
      targetId: orgId,
      metadata: { changed: out.changed, released: out.release.length, closed: out.close.length },
    });
  }
  return { ok: true, changed: out.changed, release: out.release };
}

// ---------------------------------------------------------------------------
// What the card and Today say
// ---------------------------------------------------------------------------

export type PortalCount = { portal: PortalKey; label: string; received: number; leads: number; waiting: number; unread: number };

export type PortalSummary = {
  /** Last 30 days, per portal that sent anything. */
  counts: PortalCount[];
  waiting: number;
  unmatched: number;
  lastAt: string | null;
};

export async function portalSummary(orgId: string): Promise<PortalSummary> {
  const [rows, [m]] = await withTenant(orgId, (sql) =>
    Promise.all([
      sql<{ portal: string | null; received: number; leads: number; waiting: number; unread: number; last_at: Date | null }[]>`
        SELECT payload->>'portal' AS portal, count(*)::int AS received,
               count(*) FILTER (WHERE outcome IN ('CREATED', 'MERGED'))::int AS leads,
               count(*) FILTER (WHERE outcome = 'WAITING' AND processed_at IS NULL)::int AS waiting,
               count(*) FILTER (WHERE outcome = 'JUNK' AND payload ? 'refused')::int AS unread,
               max(received_at) AS last_at
        FROM lead_events
        WHERE org_id = ${orgId} AND source = 'PORTAL' AND received_at > now() - interval '30 days'
        GROUP BY 1`,
      sql<{ unmatched: number }[]>`
        SELECT count(*)::int AS unmatched FROM portal_projects
        WHERE org_id = ${orgId} AND phase_id IS NULL AND NOT not_ours`,
    ]),
  );
  const counts = PORTAL_KEYS.flatMap((k) => {
    const r = rows.find((x) => (isPortalKey(x.portal) ? x.portal : "OTHER") === k);
    return r ? [{ portal: k, label: portalLabel(k), received: r.received, leads: r.leads, waiting: r.waiting, unread: r.unread }] : [];
  });
  const last = rows.map((r) => r.last_at?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  return {
    counts,
    waiting: counts.reduce((t, c) => t + c.waiting, 0),
    unmatched: m?.unmatched ?? 0,
    lastAt: last ? new Date(last).toISOString() : null,
  };
}

/** Today: portal enquiries waiting on a project match, and a Housing.com account that stopped. Never fatal. */
export async function portalQueue(orgId: string): Promise<QueueItem[]> {
  const [waiting, accounts] = await Promise.all([waitingQueue(orgId), portalAccountQueue(orgId)]);
  return [...accounts, ...waiting];
}

async function waitingQueue(orgId: string): Promise<QueueItem[]> {
  try {
    const [r] = await withTenant(orgId, (sql) => sql<{ waiting: number; wordings: number }[]>`
      SELECT count(*)::int AS waiting, count(DISTINCT payload->'lead'->>'projectKey')::int AS wordings
      FROM lead_events
      WHERE org_id = ${orgId} AND source = 'PORTAL' AND outcome = 'WAITING' AND processed_at IS NULL`);
    if (!r?.waiting) return [];
    return [
      {
        id: "portal-waiting",
        severity: "warn",
        title: `${r.waiting} portal ${r.waiting === 1 ? "lead waits" : "leads wait"} for a project`,
        why:
          r.wordings === 1
            ? "The portal named a project we have not matched to a tower. Nobody is called until it is."
            : `The portals named ${r.wordings} projects we have not matched to towers. Nobody is called until they are.`,
        action: "Match them",
        href: "/dashboard/settings/connections/portals?edit=1",
        tag: null,
        resolvers: ["integration:manage"],
      },
    ];
  } catch (e) {
    console.error("portals: Today's items could not be read", e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Housing.com: an account we ask for its leads
// ---------------------------------------------------------------------------

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher | null = null;

/** The checks' seam: answer Housing.com's lead API without the network. */
export function usePortalFetch(f: Fetcher | null): void {
  fetcher = f;
}

const ASK_TIMEOUT_MS = 20_000;

async function askHousing(url: string): Promise<{ status: number; body: unknown }> {
  const f = fetcher ?? fetch;
  try {
    const res = await Promise.race([
      f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ASK_TIMEOUT_MS) }),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), ASK_TIMEOUT_MS + 1_000)),
    ]);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

export type PortalAccountView = {
  id: string;
  portal: "HOUSING";
  accountId: string;
  status: "ACTIVE" | "BROKEN";
  lastOkAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  leadsRead: number;
};

export async function listPortalAccounts(orgId: string): Promise<PortalAccountView[]> {
  const rows = await withTenant(orgId, (sql) => sql<{
    id: string; account_id: string; status: "ACTIVE" | "BROKEN"; last_ok_at: Date | null; last_pull_at: Date | null;
    last_error: string | null; leads_read: number;
  }[]>`
    SELECT id, account_id, status, last_ok_at, last_pull_at, last_error, leads_read
    FROM portal_accounts WHERE org_id = ${orgId} AND status <> 'REMOVED' ORDER BY created_at`);
  return rows.map((r) => ({
    id: r.id,
    portal: "HOUSING",
    accountId: r.account_id,
    status: r.status,
    lastOkAt: r.last_ok_at?.toISOString() ?? null,
    lastPullAt: r.last_pull_at?.toISOString() ?? null,
    lastError: r.last_error,
    leadsRead: r.leads_read,
  }));
}

/** Why an account id and key cannot be saved as typed, or null. */
export function housingKeysProblem(accountId: string, key: string): string | null {
  if (!housingIdOk(accountId)) return "Account ID: letters, digits, dashes and underscores only, as Housing.com gave it.";
  if (!key || key.length > 200 || /\s/.test(key)) return "Secret key: paste it exactly as Housing.com gave it, with no spaces.";
  return null;
}

/**
 * A Housing.com account, saved by `integration:manage`. The key is tried on
 * an hour's window first: one Housing.com refuses is not saved. Housing.com
 * not answering saves it, and the worker asks again in ten minutes.
 */
export async function savePortalAccount(
  orgId: string,
  userId: string,
  o: { accountId: string; key: string; nowIso?: string },
): Promise<{ ok: true; checked: boolean } | { ok: false; message: string }> {
  const accountId = o.accountId.trim();
  const key = o.key.trim();
  const problem = housingKeysProblem(accountId, key);
  if (problem) return { ok: false, message: problem };
  const nowIso = o.nowIso ?? new Date().toISOString();
  const taken = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ taken: boolean }[]>`SELECT portal_account_taken('HOUSING', ${accountId}) AS taken`;
    return r.taken;
  });
  if (taken) return { ok: false, message: "That Housing.com account is connected to another company here. Ask Housing.com which account is yours." };
  const nowSec = Date.parse(nowIso) / 1000;
  const tried = await askHousing(housingUrl({ id: accountId, key, fromSec: nowSec - 3600, toSec: nowSec, nowSec }));
  const answer = tried.status ? housingAnswer(tried.status, tried.body, nowIso) : null;
  if (answer && !answer.ok && answer.broken) return { ok: false, message: answer.reason };
  const checked = !!answer?.ok;
  const saved = await withTenant(orgId, async (sql) => {
    const [live] = await sql<{ id: string }[]>`
      SELECT id FROM portal_accounts WHERE org_id = ${orgId} AND portal = 'HOUSING' AND account_id = ${accountId} AND status <> 'REMOVED'`;
    const id = live?.id ?? randomUUID();
    const sealed = await seal(orgId, portalAccountPurpose(id), key, sql);
    if (!sealed) return null;
    if (live) {
      await sql`
        UPDATE portal_accounts SET secret = ${sealed.secret}, key_version = ${sealed.keyVersion}, status = 'ACTIVE',
               last_error = NULL, last_pull_at = NULL
        WHERE org_id = ${orgId} AND id = ${id}`;
    } else {
      await sql`
        INSERT INTO portal_accounts (id, org_id, portal, account_id, secret, key_version, created_by)
        VALUES (${id}, ${orgId}, 'HOUSING', ${accountId}, ${sealed.secret}, ${sealed.keyVersion}, ${userId})`;
    }
    return id;
  });
  if (!saved) return { ok: false, message: "Saving keys is not switched on here yet." };
  await audit({ orgId, actorUserId: userId, action: "portal.account_saved", targetType: "portal_account", targetId: saved, metadata: { portal: "HOUSING", checked } });
  return { ok: true, checked };
}

/** Stops asking, and scrubs the key. */
export async function removePortalAccount(orgId: string, userId: string, id: string): Promise<boolean> {
  const n = await withTenant(orgId, (sql) => sql`
    UPDATE portal_accounts SET status = 'REMOVED', secret = NULL, key_version = NULL, lease_until = NULL
    WHERE org_id = ${orgId} AND id = ${id} AND status <> 'REMOVED'`);
  if (!n.count) return false;
  await audit({ orgId, actorUserId: userId, action: "portal.account_removed", targetType: "portal_account", targetId: id, metadata: { portal: "HOUSING" } });
  return true;
}

export type PullReport = { asked: number; leads: number; broken: number; failed: number; eventIds: string[] };

/**
 * One pass over this organisation's Housing.com accounts that are due: each
 * is claimed under a lease, asked for the window since its last, and every
 * lead it answers becomes an event. A window is marked read only when the
 * answer arrived, so a failed ask is asked again whole.
 */
export async function pullPortalAccounts(orgId: string, nowIso = new Date().toISOString()): Promise<PullReport> {
  const report: PullReport = { asked: 0, leads: 0, broken: 0, failed: 0, eventIds: [] };
  const now = new Date(nowIso);
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; account_id: string; pulled_until: Date | null; last_pull_at: Date | null }[]>`
    SELECT id, account_id, pulled_until, last_pull_at FROM portal_accounts
    WHERE org_id = ${orgId} AND status = 'ACTIVE' AND (lease_until IS NULL OR lease_until < ${now})
    ORDER BY last_pull_at NULLS FIRST LIMIT 10`);
  for (const r of rows) {
    if (!housingDue(r.last_pull_at?.toISOString() ?? null, nowIso)) continue;
    const key = await withTenant(orgId, async (sql) => {
      const [c] = await sql<{ secret: Buffer | null }[]>`
        UPDATE portal_accounts SET lease_until = ${new Date(now.getTime() + 5 * 60_000)}, last_pull_at = ${now}
        WHERE org_id = ${orgId} AND id = ${r.id} AND status = 'ACTIVE' AND (lease_until IS NULL OR lease_until < ${now})
        RETURNING secret`;
      return c ? open(orgId, portalAccountPurpose(r.id), c.secret, sql) : undefined;
    });
    if (key === undefined) continue;
    report.asked += 1;
    const done = (f: { broken?: boolean; error: string | null; until?: Date; leads?: number }) =>
      withTenant(orgId, (sql) => sql`
        UPDATE portal_accounts
        SET lease_until = NULL, last_error = ${f.error},
            status = ${f.broken ? "BROKEN" : sql`status`},
            pulled_until = ${f.until ?? sql`pulled_until`},
            last_ok_at = ${f.until ? sql`now()` : sql`last_ok_at`},
            leads_read = leads_read + ${f.leads ?? 0}
        WHERE org_id = ${orgId} AND id = ${r.id}`);
    if (!key) {
      report.failed += 1;
      await done({ error: "The saved key could not be opened. Save it again." });
      continue;
    }
    const w = housingWindow(r.pulled_until?.toISOString() ?? null, nowIso);
    const got = await askHousing(housingUrl({ id: r.account_id, key, fromSec: w.fromSec, toSec: w.toSec, nowSec: now.getTime() / 1000 }));
    if (!got.status) {
      report.failed += 1;
      await done({ error: "Housing.com did not answer." });
      continue;
    }
    const answer = housingAnswer(got.status, got.body, nowIso);
    if (!answer.ok) {
      if (answer.broken) {
        report.broken += 1;
        await done({ broken: true, error: answer.reason });
        await audit({ orgId, actorUserId: null, action: "portal.account_broken", targetType: "portal_account", targetId: r.id, metadata: { portal: "HOUSING", status: got.status } });
      } else {
        report.failed += 1;
        await done({ error: answer.reason });
      }
      continue;
    }
    const taken = await takePush(orgId, "HOUSING", got.body, nowIso, "PULL");
    report.leads += taken.added;
    report.eventIds.push(...taken.eventIds);
    await done({ error: null, until: new Date(w.toSec * 1000), leads: taken.added });
  }
  return report;
}

/** Today: a Housing.com account that stopped working. Never fatal. */
export async function portalAccountQueue(orgId: string): Promise<QueueItem[]> {
  try {
    const [r] = await withTenant(orgId, (sql) => sql<{ broken: number }[]>`
      SELECT count(*)::int AS broken FROM portal_accounts WHERE org_id = ${orgId} AND status = 'BROKEN'`);
    if (!r?.broken) return [];
    return [
      {
        id: "portal-account-broken",
        severity: "risk",
        title: "Housing.com stopped sending leads",
        why: "Housing.com no longer accepts the account ID or secret key saved here. No Housing.com leads arrive until it is saved again.",
        action: "Fix it",
        href: "/dashboard/settings/connections/portals",
        tag: null,
        resolvers: ["integration:manage"],
      },
    ];
  } catch (e) {
    console.error("portals: account items could not be read", e);
    return [];
  }
}
