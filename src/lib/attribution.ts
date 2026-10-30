import { randomBytes } from "node:crypto";
import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import {
  DEFAULT_VALUES,
  OUTCOME_LABEL,
  dayFor,
  lineageSnapshot,
  milestoneProblem,
  nextMilestone,
  occurredAt,
  outcomesForMove,
  planUpload,
  platformsFor,
  ulid,
  valueOf,
  type Milestone,
  type OutcomeKind,
  type OutcomeLineage,
  type Platform,
  type Reason,
  type Recorded,
  type UploadState,
  type Values,
} from "./attribution-rules.ts";
import type { Lineage } from "./capture-rules.ts";
import type { Facts, PathStage, StageKey } from "./lead-rules.ts";

/**
 * The outcome log: writing what became of a lead, and reading it back.
 * `attribution-rules.ts` decides; this reads and writes.
 *
 * An outcome is written in the same transaction as the move that caused it,
 * so a lead can never read Booked without its booking in the log, and a
 * move that rolls back leaves no outcome behind. Its uploads are decided in
 * the same breath: what can never be sent (no consent, nothing to match it
 * by) is recorded as such at once, so the lead's page can say so, and the
 * rest waits for the worker, which asks everything again before sending.
 */

type LeadFacts = {
  channel: string;
  external_id: string | null;
  lineage: Lineage | null;
  created_at: Date;
  scope_node_id: string;
  publish_target_id: string | null;
  phone: string;
};

export async function valuesFor(sql: TransactionSql, orgId: string): Promise<Values> {
  const [s] = await sql<{ value_qualified: number; value_visit: number; value_booking: number; hold_days: number }[]>`
    SELECT value_qualified, value_visit, value_booking, hold_days FROM attribution_settings WHERE org_id = ${orgId}`;
  return s ? { qualified: s.value_qualified, visit: s.value_visit, booking: s.value_booking, holdDays: s.hold_days } : DEFAULT_VALUES;
}

async function recorded(sql: TransactionSql, orgId: string, leadId: string): Promise<Recorded[]> {
  const rows = await sql<{ id: string; kind: OutcomeKind; booking_id: string | null }[]>`
    SELECT id, kind, booking_id FROM outcome_events WHERE org_id = ${orgId} AND lead_id = ${leadId} ORDER BY occurred_at, id`;
  return rows.map((r) => ({ id: r.id, kind: r.kind, bookingId: r.booking_id }));
}

/** Whether the buyer agreed to measurement and has not opted out, on this phone. */
async function measurable(sql: TransactionSql, orgId: string, phone: string): Promise<{ consented: boolean; optedOut: boolean }> {
  const [r] = await sql<{ consented: boolean; opted_out: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM lead_consents c WHERE c.org_id = ${orgId} AND c.phone = ${phone}
                     AND 'ad_measurement' = ANY(c.channels) AND (c.expires_at IS NULL OR c.expires_at > now())) AS consented,
           EXISTS (SELECT 1 FROM call_suppressions s WHERE s.org_id = ${orgId} AND s.phone = ${phone}) AS opted_out`;
  return { consented: r.consented, optedOut: r.opted_out };
}

/**
 * Write one outcome and decide its uploads. `connected` is taken as true
 * here: whether an account is chosen is the worker's question, asked when it
 * would send, because it changes more often than anything else here.
 */
async function writeOutcome(
  sql: TransactionSql,
  o: {
    orgId: string;
    leadId: string;
    lead: LeadFacts;
    kind: OutcomeKind;
    bookingId: string | null;
    at: string;
    values: Values;
    actorUserId: string | null;
    nowIso: string;
  },
): Promise<string> {
  const id = ulid(Date.now(), randomBytes(10));
  const lineage = lineageSnapshot({ channel: o.lead.channel, externalId: o.lead.external_id, lineage: o.lead.lineage });
  await sql`
    INSERT INTO outcome_events (id, org_id, lead_id, kind, occurred_at, booking_id, scope_node_id, publish_target_id, value, lineage, actor_user_id)
    VALUES (${id}, ${o.orgId}, ${o.leadId}, ${o.kind}, ${o.at}, ${o.bookingId}, ${o.lead.scope_node_id}, ${o.lead.publish_target_id},
            ${valueOf(o.kind, o.values)}, ${sql.json(lineage as never)}, ${o.actorUserId})`;
  if (o.kind === "CANCELLED") {
    // Whatever of the booking has not gone yet never will: neither platform
    // can take a conversion back.
    await sql`
      UPDATE outcome_uploads u SET state = 'NOT_SENT', reason = 'CANCELLED', lease_id = NULL, lease_until = NULL, updated_at = now()
      FROM outcome_events e
      WHERE u.org_id = ${o.orgId} AND u.event_id = e.id AND u.state IN ('WAITING', 'QUEUED')
        AND (e.id = ${o.bookingId} OR e.booking_id = ${o.bookingId})`;
    return id;
  }
  const who = await measurable(sql, o.orgId, o.lead.phone);
  for (const platform of platformsFor(lineage)) {
    const plan = planUpload({
      platform,
      kind: o.kind,
      occurredAt: o.at,
      leadCreatedAt: o.lead.created_at.toISOString(),
      lineage,
      consented: who.consented,
      optedOut: who.optedOut,
      connected: true,
      cancelled: false,
      holdDays: o.values.holdDays,
      nowIso: o.nowIso,
    });
    await sql`
      INSERT INTO outcome_uploads (org_id, event_id, platform, state, reason, not_before)
      VALUES (${o.orgId}, ${id}, ${platform}, ${plan.state}, ${plan.reason}, ${plan.notBefore})
      ON CONFLICT (event_id, platform) DO NOTHING`;
  }
  return id;
}

async function leadFacts(sql: TransactionSql, orgId: string, leadId: string): Promise<LeadFacts | null> {
  const [l] = await sql<LeadFacts[]>`
    SELECT channel, external_id, lineage, created_at, scope_node_id, publish_target_id, phone
    FROM leads WHERE org_id = ${orgId} AND id = ${leadId}`;
  return l ?? null;
}

/**
 * The outcomes a stage move made, written inside the move's own
 * transaction. Returns the kinds written, for the caller's audit row.
 */
export async function recordOutcomes(
  sql: TransactionSql,
  m: {
    orgId: string;
    leadId: string;
    from: StageKey;
    to: StageKey;
    toPath: PathStage;
    cancelsBooking: boolean;
    facts: Facts;
    actorUserId: string | null;
    nowIso?: string;
  },
): Promise<OutcomeKind[]> {
  const events = await recorded(sql, m.orgId, m.leadId);
  const planned = outcomesForMove({ from: m.from, to: m.to, toPath: m.toPath, cancelsBooking: m.cancelsBooking }, events);
  if (!planned.length) return [];
  const lead = await leadFacts(sql, m.orgId, m.leadId);
  if (!lead) return [];
  const values = await valuesFor(sql, m.orgId);
  const nowIso = m.nowIso ?? new Date().toISOString();
  for (const p of planned) {
    await writeOutcome(sql, {
      orgId: m.orgId,
      leadId: m.leadId,
      lead,
      kind: p.kind,
      bookingId: p.bookingId,
      at: occurredAt(dayFor(p.kind, m.facts), nowIso, lead.created_at.toISOString()),
      values,
      actorUserId: m.actorUserId,
      nowIso,
    });
  }
  return planned.map((p) => p.kind);
}

/** A person recorded the agreement or the registration on a booked lead. */
export async function recordMilestone(opts: {
  orgId: string;
  userId: string;
  leadId: string;
  kind: Milestone;
  day: string;
  today: string;
  nowIso?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const res = await withTenant(opts.orgId, async (sql): Promise<{ ok: true } | { ok: false; message: string }> => {
    // Locked, so two people recording the same agreement write it once.
    const [row] = await sql<{ stage: string; facts: Facts }[]>`
      SELECT stage, facts FROM leads WHERE org_id = ${opts.orgId} AND id = ${opts.leadId} FOR UPDATE`;
    if (!row) return { ok: false, message: "That lead no longer exists." };
    const events = await recorded(sql, opts.orgId, opts.leadId);
    const [agreement] = await sql<{ at: Date }[]>`
      SELECT occurred_at AS at FROM outcome_events
      WHERE org_id = ${opts.orgId} AND lead_id = ${opts.leadId} AND kind = 'AGREEMENT' ORDER BY occurred_at DESC LIMIT 1`;
    const agreementOn = agreement ? new Date(agreement.at.getTime() + 330 * 60_000).toISOString().slice(0, 10) : null;
    const problem = milestoneProblem(opts.kind, opts.day, { events, today: opts.today, bookedOn: row.facts?.bookedOn ?? null, agreementOn });
    if (problem) return { ok: false, message: problem };
    const next = nextMilestone(events)!;
    const lead = await leadFacts(sql, opts.orgId, opts.leadId);
    if (!lead) return { ok: false, message: "That lead no longer exists." };
    await writeOutcome(sql, {
      orgId: opts.orgId,
      leadId: opts.leadId,
      lead,
      kind: opts.kind,
      bookingId: next.bookingId,
      at: occurredAt(opts.day, nowIso, lead.created_at.toISOString()),
      values: await valuesFor(sql, opts.orgId),
      actorUserId: opts.userId,
      nowIso,
    });
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id)
      VALUES (${opts.orgId}, ${opts.leadId}, 'NOTE', ${`${OUTCOME_LABEL[opts.kind]} on ${opts.day}`}, ${opts.userId})`;
    return { ok: true };
  });
  if (res.ok) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "lead.milestone", targetType: "lead", targetId: opts.leadId, metadata: { kind: opts.kind } });
  }
  return res;
}

// ---------------------------------------------------------------------------
// Reading, for a lead's page
// ---------------------------------------------------------------------------

export type OutcomeView = {
  id: string;
  kind: OutcomeKind;
  at: string;
  uploads: { platform: Platform; state: UploadState; reason: Reason | null; notBefore: string; sentAt: string | null }[];
};

export type LeadOutcomes = {
  outcomes: OutcomeView[];
  next: { kind: Milestone; label: string } | null;
  /** Whether the buyer agreed to have outcomes measured. */
  measured: boolean;
  from: Platform[];
};

export async function leadOutcomes(orgId: string, leadId: string): Promise<LeadOutcomes> {
  return withTenant(orgId, async (sql) => {
    const [events, uploads, lead] = await Promise.all([
      sql<{ id: string; kind: OutcomeKind; booking_id: string | null; occurred_at: Date }[]>`
        SELECT id, kind, booking_id, occurred_at FROM outcome_events
        WHERE org_id = ${orgId} AND lead_id = ${leadId} ORDER BY occurred_at, id`,
      sql<{ event_id: string; platform: Platform; state: UploadState; reason: Reason | null; not_before: Date; sent_at: Date | null }[]>`
        SELECT u.event_id, u.platform, u.state, u.reason, u.not_before, u.sent_at
        FROM outcome_uploads u JOIN outcome_events e ON e.id = u.event_id
        WHERE u.org_id = ${orgId} AND e.lead_id = ${leadId} ORDER BY u.platform`,
      leadFacts(sql, orgId, leadId),
    ]);
    const who = lead ? await measurable(sql, orgId, lead.phone) : { consented: false, optedOut: false };
    const recordedEvents = events.map((e) => ({ id: e.id, kind: e.kind, bookingId: e.booking_id }));
    const next = nextMilestone(recordedEvents);
    const lineage: OutcomeLineage | null = lead ? lineageSnapshot({ channel: lead.channel, externalId: lead.external_id, lineage: lead.lineage }) : null;
    return {
      outcomes: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        at: e.occurred_at.toISOString(),
        uploads: uploads
          .filter((u) => u.event_id === e.id)
          .map((u) => ({ platform: u.platform, state: u.state, reason: u.reason, notBefore: u.not_before.toISOString(), sentAt: u.sent_at?.toISOString() ?? null })),
      })),
      next: next ? { kind: next.kind, label: OUTCOME_LABEL[next.kind] } : null,
      measured: who.consented && !who.optedOut,
      from: lineage ? platformsFor(lineage) : [],
    };
  });
}

// ---------------------------------------------------------------------------
// Reading, for the connections screen
// ---------------------------------------------------------------------------

export type UploadSummary = {
  platform: Platform;
  sent: number;
  waiting: number;
  notSent: number;
  failed: number;
  /** The newest refusal in the period, in the platform's words. */
  lastRefusal: string | null;
};

/** What each platform was told over the last 30 days, and what was not. */
export async function uploadSummary(orgId: string, now = new Date()): Promise<{ platforms: UploadSummary[]; values: Values }> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  return withTenant(orgId, async (sql) => {
    const [rows, refusals, values] = await Promise.all([
      sql<{ platform: Platform; state: UploadState; n: number }[]>`
        SELECT platform, state, count(*)::int AS n FROM outcome_uploads
        WHERE org_id = ${orgId} AND created_at >= ${since} GROUP BY platform, state`,
      sql<{ platform: Platform; error: string | null }[]>`
        SELECT DISTINCT ON (platform) platform, error FROM outcome_uploads
        WHERE org_id = ${orgId} AND state = 'FAILED' AND updated_at >= ${since}
        ORDER BY platform, updated_at DESC`,
      valuesFor(sql, orgId),
    ]);
    const platforms = (["META", "GOOGLE"] as Platform[]).map((platform) => {
      const n = (states: UploadState[]) => rows.filter((r) => r.platform === platform && states.includes(r.state)).reduce((a, r) => a + r.n, 0);
      return {
        platform,
        sent: n(["SENT"]),
        waiting: n(["WAITING", "QUEUED", "SENDING"]),
        notSent: n(["NOT_SENT"]),
        failed: n(["FAILED"]),
        lastRefusal: refusals.find((r) => r.platform === platform)?.error ?? null,
      };
    });
    return { platforms, values };
  });
}

/** What outcomes are worth and how long a booking waits, set by the budget key. */
export async function saveValues(opts: { orgId: string; userId: string; values: Values }): Promise<void> {
  const v = opts.values;
  await withTenant(opts.orgId, (sql) => sql`
    INSERT INTO attribution_settings (org_id, value_qualified, value_visit, value_booking, hold_days, updated_by, updated_at)
    VALUES (${opts.orgId}, ${v.qualified}, ${v.visit}, ${v.booking}, ${v.holdDays}, ${opts.userId}, now())
    ON CONFLICT (org_id) DO UPDATE SET value_qualified = EXCLUDED.value_qualified, value_visit = EXCLUDED.value_visit,
      value_booking = EXCLUDED.value_booking, hold_days = EXCLUDED.hold_days, updated_by = EXCLUDED.updated_by, updated_at = now()`);
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "attribution.values", targetType: "org", targetId: opts.orgId, metadata: { ...v } });
}
