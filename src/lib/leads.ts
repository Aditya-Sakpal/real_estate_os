import { audit, withTenant } from "./db/index.ts";
import { redactPhones } from "./mask-rules.ts";
import type { TransactionSql } from "postgres";
import { ALL_PERMISSIONS } from "./permissions.ts";
import { mergeRoles, type RoleRow } from "./rbac-rules.ts";
import { LANGUAGE_LABEL, type Language } from "./call-rules.ts";
import { isUuid, sourceLabel, type CapturedLead, type Lineage } from "./capture-rules.ts";
import {
  STAGE_FIELDS,
  applyMove,
  isPath,
  nowTimeOn,
  planMove,
  rupees,
  showDate,
  stageLabel,
  validateMove,
  type Facts,
  type LeadState,
  type MoveInput,
  type PathStage,
  type StageKey,
} from "./lead-rules.ts";
import type { StageMove } from "./cadence-rules.ts";
import { recordOutcomes } from "./attribution.ts";
import { mandateMoveRefusal } from "./mandate-rules.ts";
import { registerFromLink, tagCaptured } from "./partners.ts";
import { standingFor } from "./dnd.ts";
import { LOOKBACK_DAYS, ownershipRule, type OwnershipRule, type OwnershipVerdict } from "./ownership-rules.ts";
import type { DndRow } from "./dnd-rules.ts";
import type { Qualification, Route } from "./qualification-rules.ts";
import { visitHoursAt } from "./slots.ts";
import { closedMessage, opensAt } from "./visit-hours-rules.ts";

/**
 * Leads: capture, the board, and moving a card. The reads and writes around
 * `lead-rules.ts` and `capture-rules.ts`.
 *
 * A person's move is re-planned and re-validated here against the lead as it
 * stands in the database, because the board in the browser has no authority:
 * a stale tab could otherwise post a move the rules would refuse. The engine
 * moves leads through `applyEngineMove()`, which only ever goes forward.
 */

// ---------------------------------------------------------------------------
// Who can own a lead
// ---------------------------------------------------------------------------

export type Person = { id: string; name: string };

/**
 * The people who may own a lead at this tower: an active member holding
 * `lead:update` at the tower or above it, least loaded first. The founding
 * admin holds everything and is used only when nobody else does, because a
 * sales head should not wake up owning every lead in the company.
 */
export async function ownersFor(orgId: string, nodeId: string | null, sqlIn?: TransactionSql): Promise<Person[]> {
  const run = async (sql: TransactionSql) => {
    const all = await ownerCandidates(sql, orgId, nodeId);
    const floor = all.filter((x) => !x.admin);
    return (floor.length ? floor : all).sort((a, b) => a.open - b.open || a.person.name.localeCompare(b.person.name)).map((x) => x.person);
  };
  return sqlIn ? run(sqlIn) : withTenant(orgId, run);
}

/**
 * Everybody who may own a lead at this tower, with how many open leads each
 * already carries and whether they hold the wildcard. `ownersFor()` orders
 * them; a departure (`departures.ts`) hands out a batch from the same pool.
 */
export async function ownerCandidates(
  sql: TransactionSql,
  orgId: string,
  nodeId: string | null,
): Promise<{ person: Person; open: number; admin: boolean }[]> {
  const [roles, members] = await Promise.all([
    sql<RoleRow[]>`SELECT key, label, description, min_kind, can_delegate, source, permissions
                   FROM org_roles WHERE org_id = ${orgId}`,
    sql<{ user_id: string; name: string | null; email: string; role: string; open: number }[]>`
      SELECT m.user_id, u.name, u.email::text AS email, m.role,
             (SELECT count(*)::int FROM leads l
               WHERE l.org_id = ${orgId} AND l.owner_id = m.user_id AND l.stage NOT IN ('booked', 'lost')) AS open
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      JOIN scope_nodes s ON s.id = m.scope_node_id
      WHERE m.org_id = ${orgId} AND m.status = 'ACTIVE' AND u.erased_at IS NULL
        AND ${nodeId ? sql`s.path @> (SELECT path FROM scope_nodes WHERE id = ${nodeId} AND org_id = ${orgId})` : sql`true`}`,
  ]);
  const byKey = new Map(mergeRoles(roles).map((r) => [r.key, r]));
  const seen = new Map<string, { person: Person; open: number; admin: boolean }>();
  for (const m of members) {
    const role = byKey.get(m.role);
    if (!role) continue;
    const admin = role.permissions.includes(ALL_PERMISSIONS);
    if (!admin && !role.permissions.includes("lead:update")) continue;
    const prev = seen.get(m.user_id);
    const person = { id: m.user_id, name: m.name?.trim() || m.email.split("@")[0] };
    if (!prev || (prev.admin && !admin)) seen.set(m.user_id, { person, open: m.open, admin });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Store what arrived, once. A second delivery of the same id is a no-op. */
export async function recordEvent(opts: {
  orgId: string;
  source: CapturedLead["channel"];
  externalId: string;
  payload: unknown;
}): Promise<{ id: string; fresh: boolean }> {
  return withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO lead_events (org_id, source, external_id, payload)
      VALUES (${opts.orgId}, ${opts.source}, ${opts.externalId.slice(0, 200)}, ${sql.json(opts.payload as never)})
      ON CONFLICT (org_id, source, external_id) DO NOTHING
      RETURNING id`;
    if (row) return { id: row.id, fresh: true };
    const [old] = await sql<{ id: string }[]>`
      SELECT id FROM lead_events WHERE org_id = ${opts.orgId} AND source = ${opts.source} AND external_id = ${opts.externalId.slice(0, 200)}`;
    return { id: old.id, fresh: false };
  });
}

export type Upserted =
  | {
      ok: true;
      leadId: string;
      merged: boolean;
      created: boolean;
      /** The ownership rule that fired (`ownership-rules.ts`). */
      rule: OwnershipRule;
    }
  | { ok: false; reason: "NO_PHONE" | "NO_PLACE" | "DONE_ALREADY" | "JUNK"; message: string; rule?: "R0" };

/** The organisation's lead settings, with the defaults for any it never saved. */
export async function leadSettingsIn(sql: TransactionSql, orgId: string): Promise<{ lookbackDays: number }> {
  const [r] = await sql<{ lookback_days: number }[]>`SELECT lookback_days FROM lead_settings WHERE org_id = ${orgId}`;
  return { lookbackDays: r?.lookback_days ?? LOOKBACK_DAYS };
}

/**
 * Read what the ownership rules ask about one number at one tower, and ask
 * them. Inside the caller's transaction, so the lead it names is the lead
 * that is then written to.
 */
export async function ownershipOf(
  sql: TransactionSql,
  o: { orgId: string; phone: string; name: string; nodeId: string; projectPath: string | null; isTest: boolean; honeypot: boolean; nowIso: string },
): Promise<OwnershipVerdict> {
  const inProject = o.projectPath ? sql`n.path <@ ${o.projectPath}::ltree` : sql`l.scope_node_id = ${o.nodeId}`;
  const settings = await leadSettingsIn(sql, o.orgId);
  const [closed] = await sql<{ exit_reason: string | null; at: Date }[]>`
    SELECT exit_reason, updated_at AS at FROM leads
    WHERE org_id = ${o.orgId} AND phone = ${o.phone} AND stage = 'lost'
    ORDER BY updated_at DESC LIMIT 1`;
  const [booked] = await sql<{ id: string }[]>`
    SELECT l.id FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${o.orgId} AND l.phone = ${o.phone} AND l.stage = 'booked' AND ${inProject}
    ORDER BY l.created_at DESC LIMIT 1`;
  const [open] = await sql<{ id: string; last_activity_at: Date }[]>`
    SELECT l.id, l.last_activity_at FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${o.orgId} AND l.phone = ${o.phone} AND l.stage NOT IN ('lost', 'booked') AND ${inProject}
    ORDER BY l.created_at DESC LIMIT 1`;
  return ownershipRule({
    nowIso: o.nowIso,
    lookbackDays: settings.lookbackDays,
    isTest: o.isTest,
    honeypot: o.honeypot,
    phone: o.phone,
    name: o.name,
    closedAsJunk: closed?.exit_reason ? { reason: closed.exit_reason, at: closed.at.toISOString() } : null,
    booked: booked ? { leadId: booked.id } : null,
    open: open ? { leadId: open.id, lastActivityAt: open.last_activity_at.toISOString() } : null,
  });
}

/** An open lead nobody touched for longer than the lookback, closed so the new enquiry is its own card. */
export async function closeStaleLead(sql: TransactionSql, orgId: string, leadId: string): Promise<void> {
  const [before] = await sql<{ stage: StageKey }[]>`
    SELECT stage FROM leads WHERE org_id = ${orgId} AND id = ${leadId} AND stage NOT IN ('lost', 'booked') FOR UPDATE`;
  if (!before) return;
  await sql`
    UPDATE leads SET stage = 'lost', exit_reason = 'No activity', follow_up_on = NULL, needs_person = NULL,
           updated_at = now()
    WHERE org_id = ${orgId} AND id = ${leadId}`;
  await sql`
    INSERT INTO lead_activity (org_id, lead_id, kind, from_stage, to_stage, reason)
    VALUES (${orgId}, ${leadId}, 'STAGE', ${before.stage}, 'lost', 'No activity: the buyer enquired again as a new lead')`;
  await sql`
    UPDATE lead_tasks SET state = 'CANCELLED', result = 'Closed: the buyer enquired again as a new lead', done_at = now()
    WHERE org_id = ${orgId} AND lead_id = ${leadId} AND state = 'DUE'`;
}

/**
 * Turn a captured enquiry into a lead, or into a fresh enquiry on the lead
 * this number already is, by the ownership rules (`ownership-rules.ts`).
 *
 * Dedupe never crosses tenants and never guesses: the same number asking
 * about the same project again, while that lead is open and was active
 * inside the lookback, is the same buyer asking again, and their enquiry
 * clock restarts (R3). A number that was lost, that asked about a different
 * project, or whose open lead went quiet past the lookback, is a new lead
 * (R4). A junk submission (R0) makes no lead, and a buyer who already booked
 * here (R1) is not called: their booked lead is told they enquired again.
 */
export async function upsertCaptured(opts: {
  orgId: string;
  eventId: string;
  lead: CapturedLead;
  /** The tower, resolved by the caller from the form, the ad or the account. */
  phaseId: string | null;
  publishTargetId: string | null;
  /** For checks: the moment the enquiry is judged at. */
  nowIso?: string;
}): Promise<Upserted> {
  const { orgId, lead } = opts;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  if (!lead.phone) {
    await markEvent(orgId, opts.eventId, null, "JUNK", "No phone number a person could call.");
    return { ok: false, reason: "NO_PHONE", message: "No phone number a person could call." };
  }
  if (!opts.phaseId) {
    await markEvent(orgId, opts.eventId, null, "FAILED", "Could not tell which tower this enquiry was about.");
    return { ok: false, reason: "NO_PLACE", message: "Could not tell which tower this enquiry was about." };
  }
  const phone = lead.phone;
  const phaseId = opts.phaseId;

  const result = await withTenant(orgId, async (sql) => {
    const [done] = await sql<{ lead_id: string | null }[]>`
      SELECT lead_id FROM lead_events WHERE org_id = ${orgId} AND id = ${opts.eventId} AND processed_at IS NOT NULL`;
    if (done?.lead_id) return { kind: "already" as const };

    const [node] = await sql<{ id: string; project_path: string | null }[]>`
      SELECT n.id, (SELECT p.path::text FROM scope_nodes p WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project_path
      FROM scope_nodes n WHERE n.org_id = ${orgId} AND n.id = ${phaseId} AND n.kind = 'PHASE'`;
    if (!node) return null;

    // One capture of a number at a time, so two deliveries of one buyer in
    // the same second resolve to one lead rather than two.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capture:${orgId}:${phone}`}, 0))`;
    const verdict = await ownershipOf(sql, {
      orgId,
      phone,
      name: lead.name,
      nodeId: node.id,
      projectPath: node.project_path,
      isTest: lead.isTest,
      honeypot: !!lead.honeypot,
      nowIso,
    });
    const source = sourceLabel(lead.channel, lead.lineage);

    if (verdict.action === "JUNK") {
      await sql`
        UPDATE lead_events SET processed_at = now(), outcome = 'JUNK', rule = 'R0', error = ${verdict.reason},
                               attempts = attempts + 1
        WHERE org_id = ${orgId} AND id = ${opts.eventId}`;
      return { kind: "junk" as const, reason: verdict.reason };
    }

    if (verdict.action === "BOOKED") {
      const leadId = verdict.leadId;
      await sql`
        UPDATE leads SET needs_person = ${"Booked buyer enquired again"}, last_activity_at = now(), updated_at = now()
        WHERE org_id = ${orgId} AND id = ${leadId}`;
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
        VALUES (${orgId}, ${leadId}, 'CAPTURED', ${`Enquired again after booking: ${source}`},
                ${sql.json({ channel: lead.channel, rule: "R1", target: opts.publishTargetId } as never)})`;
      await sql`
        UPDATE lead_events SET processed_at = now(), lead_id = ${leadId}, outcome = 'MERGED', rule = 'R1', error = NULL,
                               attempts = attempts + 1
        WHERE org_id = ${orgId} AND id = ${opts.eventId}`;
      return { kind: "lead" as const, leadId, merged: true, created: false, rule: "R1" as OwnershipRule, closedStale: null };
    }

    let leadId: string;
    let merged = false;
    let rule: OwnershipRule = verdict.rule;
    if (verdict.action === "MERGE") {
      merged = true;
      leadId = verdict.leadId;
      await sql`
        UPDATE leads SET enquired_at = now(), last_activity_at = now(), updated_at = now(),
               email = coalesce(email, ${lead.email}),
               publish_target_id = coalesce(${opts.publishTargetId}, publish_target_id),
               -- A form's answers fill what is not yet known; what a call heard stays.
               qualification = ${sql.json((lead.form?.qualification ?? {}) as never)} || coalesce(qualification, '{}'::jsonb),
               form_answers = coalesce(${lead.form ? sql.json(lead.form.answers as never) : null}, form_answers)
        WHERE org_id = ${orgId} AND id = ${leadId}`;
    } else {
      if (verdict.closeStale) await closeStaleLead(sql, orgId, verdict.closeStale);
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO leads (org_id, scope_node_id, name, phone, email, source, language, channel, external_id,
                           publish_target_id, lineage, qualification, form_answers)
        VALUES (${orgId}, ${node.id}, ${lead.name}, ${phone}, ${lead.email}, ${source}, ${lead.language},
                ${lead.channel}, ${lead.externalId}, ${opts.publishTargetId}, ${sql.json(lead.lineage as never)},
                ${sql.json((lead.form?.qualification ?? {}) as never)}, ${lead.form ? sql.json(lead.form.answers as never) : null})
        ON CONFLICT (org_id, channel, external_id) WHERE external_id IS NOT NULL DO NOTHING
        RETURNING id`;
      if (!row) {
        const [again] = await sql<{ id: string }[]>`
          SELECT id FROM leads WHERE org_id = ${orgId} AND channel = ${lead.channel} AND external_id = ${lead.externalId}`;
        leadId = again.id;
        merged = true;
        rule = "R3";
      } else {
        leadId = row.id;
      }
    }
    // A buyer who tapped a partner's link: the partner's claim is decided
    // here, with the lead, so the two land together or not at all.
    if (lead.lineage.partnerRef) {
      await registerFromLink(sql, orgId, {
        code: lead.lineage.partnerRef,
        phone,
        buyerName: lead.name,
        leadId: merged ? null : leadId,
        nodeId: node.id,
      });
    }
    // Ownership rule R2: a partner holding this buyer at this project owns the lead.
    const owned = await tagCaptured(sql, orgId, leadId, phone, node.id);
    if (owned) rule = "R2";
    if (lead.consent) {
      await sql`
        INSERT INTO lead_consents (org_id, phone, channels, wording, source)
        VALUES (${orgId}, ${phone}, ${["call", "whatsapp"]}, ${lead.consent}, ${source.slice(0, 60)})`;
    }
    // Its own row, because agreeing to a call is not agreeing to this.
    if (lead.measurement) {
      await sql`
        INSERT INTO lead_consents (org_id, phone, channels, wording, source)
        VALUES (${orgId}, ${phone}, ${["ad_measurement"]}, ${lead.measurement}, ${source.slice(0, 60)})`;
    }
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
      VALUES (${orgId}, ${leadId}, 'CAPTURED', ${merged ? "Enquired again" : `New enquiry: ${source}`},
              ${sql.json({ channel: lead.channel, merged, target: opts.publishTargetId, rule } as never)})`;
    await sql`
      UPDATE lead_events SET processed_at = now(), lead_id = ${leadId}, outcome = ${merged ? "MERGED" : "CREATED"}, error = NULL,
                             rule = ${rule}, attempts = attempts + 1
      WHERE org_id = ${orgId} AND id = ${opts.eventId}`;
    return {
      kind: "lead" as const,
      leadId,
      merged,
      created: !merged,
      rule,
      closedStale: verdict.action === "NEW" ? verdict.closeStale : null,
    };
  });

  if (!result) {
    await markEvent(orgId, opts.eventId, null, "FAILED", "The tower this enquiry names does not exist here.");
    return { ok: false, reason: "NO_PLACE", message: "The tower this enquiry names does not exist here." };
  }
  if (result.kind === "already") return { ok: false, reason: "DONE_ALREADY", message: "Already handled." };
  // The rule that fired is always on record. The number never is: a junk
  // event is named by its own id.
  if (result.kind === "junk") {
    await audit({ orgId, actorUserId: null, action: "lead.ownership", targetType: "lead_event", targetId: opts.eventId, metadata: { ownership: "R0", channel: lead.channel } });
    return { ok: false, reason: "JUNK", message: result.reason, rule: "R0" };
  }
  await audit({
    orgId,
    actorUserId: null,
    action: result.created ? "lead.captured" : "lead.ownership",
    targetType: "lead",
    targetId: result.leadId,
    metadata: {
      channel: lead.channel,
      ownership: result.rule,
      ...(result.created ? { consent: !!lead.consent } : {}),
      ...(result.closedStale ? { closed_stale: result.closedStale } : {}),
    },
  });
  // A channel partner's own enquiry, registered with the developer whose
  // project it sells when the firm chose that. After the lead has landed,
  // and never a reason the capture fails.
  if (result.created) {
    try {
      const { autoRegisterCaptured } = await import("./partner-workspace.ts");
      await autoRegisterCaptured(orgId, result.leadId, nowIso);
    } catch (e) {
      console.error("leads: could not register a partner's lead with the developer", e);
    }
  }
  return { ok: true, leadId: result.leadId, merged: result.merged, created: result.created, rule: result.rule };
}

export async function markEvent(orgId: string, eventId: string, leadId: string | null, outcome: "JUNK" | "FAILED", error: string): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    UPDATE lead_events SET processed_at = CASE WHEN ${outcome} = 'JUNK' THEN now() ELSE processed_at END,
           outcome = ${outcome}, error = ${error.slice(0, 500)}, lead_id = coalesce(${leadId}, lead_id),
           attempts = attempts + 1
    WHERE org_id = ${orgId} AND id = ${eventId}`);
}

/**
 * The tower an enquiry is about. Our own tag on the landing page names the
 * publication, and the publication names the phase; a Meta form names an
 * ad whose publication we recorded. Failing both, the one tower the account
 * serves, when it serves exactly one. Never a guess between two.
 */
export async function placeFor(opts: {
  orgId: string;
  lineage: Lineage;
  phaseId: string | null;
  /** The node the account that received it serves, for a Meta form. */
  accountNodeId?: string | null;
}): Promise<{ phaseId: string | null; publishTargetId: string | null }> {
  const { orgId, lineage } = opts;
  return withTenant(orgId, async (sql) => {
    let target: { id: string; phase_id: string } | undefined;
    if (lineage.ref) {
      [target] = await sql<{ id: string; phase_id: string }[]>`
        SELECT id, phase_id FROM publish_targets
        WHERE org_id = ${orgId} AND idempotency_key LIKE ${`${lineage.ref}%`} LIMIT 1`;
    }
    if (!target && (lineage.campaignId || lineage.adId)) {
      [target] = await sql<{ id: string; phase_id: string }[]>`
        SELECT id, phase_id FROM publish_targets
        WHERE org_id = ${orgId}
          AND (steps->>'campaign_id' = ${lineage.campaignId ?? ""} OR steps->>'ad_id' = ${lineage.adId ?? ""}
               OR steps->>'campaign' LIKE ${`%/campaigns/${lineage.campaignId ?? "none"}`})
        LIMIT 1`;
    }
    // Our instant form belongs to one tower, whichever campaign carried it.
    if (!target && lineage.formId) {
      [target] = await sql<{ id: string; phase_id: string }[]>`
        SELECT id, phase_id FROM publish_targets
        WHERE org_id = ${orgId} AND steps->>'form_id' = ${lineage.formId} LIMIT 1`;
    }
    if (opts.phaseId) {
      const [n] = await sql<{ id: string }[]>`
        SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND id = ${opts.phaseId} AND kind = 'PHASE'`;
      if (n) return { phaseId: n.id, publishTargetId: target?.id ?? null };
    }
    if (target) return { phaseId: target.phase_id, publishTargetId: target.id };
    // A campaign made in Ads Manager goes where a person placed it.
    if (lineage.campaignId) {
      const [placed] = await sql<{ phase_id: string }[]>`
        SELECT phase_id FROM ad_campaign_places WHERE org_id = ${orgId} AND campaign_id = ${lineage.campaignId} LIMIT 1`;
      if (placed) return { phaseId: placed.phase_id, publishTargetId: null };
    }
    if (opts.accountNodeId) {
      const phases = await sql<{ id: string }[]>`
        SELECT p.id FROM scope_nodes p JOIN scope_nodes a ON a.id = ${opts.accountNodeId}
        WHERE p.org_id = ${orgId} AND p.kind = 'PHASE' AND p.path <@ a.path LIMIT 2`;
      if (phases.length === 1) return { phaseId: phases[0].id, publishTargetId: null };
    }
    const all = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PHASE' LIMIT 2`;
    return { phaseId: all.length === 1 ? all[0].id : null, publishTargetId: null };
  });
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export type BoardLead = LeadState & {
  id: string;
  name: string;
  temp: "HOT" | "WARM" | "COLD";
  score: number | null;
  source: string;
  config: string;
  budget: string;
  place: number;
  lang: string;
  touched: string;
  needsYou?: string;
  note?: string;
  lastMove?: { text: string; note?: string };
  automation: "ON" | "PAUSED";
};

type BoardRow = {
  id: string;
  name: string;
  stage: StageKey;
  path_stage: PathStage;
  facts: Facts;
  exit_reason: string | null;
  follow_up_on: Date | string | null;
  temperature: "HOT" | "WARM" | "COLD" | null;
  source: string;
  language: Language;
  needs_person: string | null;
  automation: "ON" | "PAUSED";
  last_activity_at: Date;
  place: string;
  last_reason: string | null;
  last_note: string | null;
  last_by_person: boolean | null;
  last_kind: string | null;
  next_purpose: string | null;
  next_at: Date | null;
};

/** `just now`, `12 min ago`, `3 h ago`, `2 d ago`. */
export function ago(at: Date, now = new Date()): string {
  const m = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const dateStr = (v: Date | string | null) => (v === null ? undefined : typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));

/**
 * Every lead the viewer may see, as the board draws them. `scopes` are the
 * ltree prefixes the viewer holds `lead:read` at; null is the whole tenant.
 */
export async function listBoard(orgId: string, scopes: string[] | null, now = new Date()): Promise<{ leads: BoardLead[]; places: string[] }> {
  const rows = await withTenant(orgId, (sql) => sql<BoardRow[]>`
    SELECT l.id, l.name, l.stage, l.path_stage, l.facts, l.exit_reason, l.follow_up_on, l.temperature,
           l.source, l.language, l.needs_person, l.automation, l.last_activity_at,
           CASE WHEN p.name IS NULL THEN n.name ELSE p.name || ' · ' || n.name END AS place,
           a.reason AS last_reason, a.note AS last_note, (a.actor_user_id IS NOT NULL) AS last_by_person, a.kind AS last_kind,
           t.purpose AS next_purpose, t.due_at AS next_at
    FROM leads l
    JOIN scope_nodes n ON n.id = l.scope_node_id
    LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
    LEFT JOIN LATERAL (
      SELECT reason, note, actor_user_id, kind FROM lead_activity
      WHERE lead_id = l.id AND kind IN ('STAGE', 'NOTE') ORDER BY at DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT purpose, due_at FROM lead_tasks
      WHERE lead_id = l.id AND state = 'DUE' ORDER BY due_at LIMIT 1
    ) t ON true
    WHERE l.org_id = ${orgId}
      AND ${scopes ? sql`n.path <@ ANY(${scopes}::ltree[])` : sql`true`}
      AND (l.stage NOT IN ('lost', 'booked') OR l.last_activity_at > ${new Date(now.getTime() - 60 * 86_400_000)})
    ORDER BY l.last_activity_at DESC
    LIMIT 800`);

  const places = [...new Set(rows.map((r) => r.place))];
  const leads: BoardLead[] = rows.map((r) => {
    const f = r.facts ?? {};
    const exit =
      r.stage === "nurture" || r.stage === "lost"
        ? { kind: r.stage, reason: r.exit_reason ?? "", followUp: dateStr(r.follow_up_on) }
        : undefined;
    return {
      id: r.id,
      name: r.name,
      stage: r.stage,
      pathStage: r.path_stage,
      facts: f,
      exit,
      temp: r.temperature ?? (f.interest === "Hot" ? "HOT" : f.interest === "Cold" ? "COLD" : "WARM"),
      score: scoreFrom(r.temperature, f),
      source: r.source,
      config: f.config ?? "Configuration not known",
      budget: f.budget ?? "budget not known",
      place: places.indexOf(r.place),
      lang: LANGUAGE_LABEL[r.language] ?? r.language,
      touched: ago(r.last_activity_at, now),
      // A buyer's reply, which can carry a number. The board is a summary for
      // everybody; the lead's own page shows it as the policy allows.
      needsYou: redactPhones(r.needs_person, "MASKED") ?? undefined,
      note: r.automation === "PAUSED" ? "A person has this lead; automation is off" : r.next_at ? nextNote(r.next_purpose, r.next_at, now) : undefined,
      lastMove: r.last_kind === "STAGE" && r.last_by_person === false && r.last_reason ? { text: r.last_reason } : r.last_note ? { text: "Note", note: r.last_note } : undefined,
      automation: r.automation,
    };
  });
  return { leads, places };
}

function scoreFrom(t: "HOT" | "WARM" | "COLD" | null, f: Facts): number | null {
  if (!t) return null;
  const base = t === "HOT" ? 70 : t === "WARM" ? 45 : 20;
  const known = (["config", "budget", "timeline"] as const).filter((k) => f[k]).length;
  return Math.min(100, base + known * 5 + (f.visitDate ? 10 : 0));
}

const NEXT_WORDS: Record<string, string> = {
  FIRST_CALL: "AI calls",
  RETRY_CALL: "AI calls again",
  CALLBACK: "AI calls back",
  REENGAGE_CALL: "AI follow-up call",
  VISIT_FOLLOWUP_CALL: "AI follow-up call after the visit",
  RECOVERY_CALL: "AI call to rebook",
  NURTURE: "Monthly WhatsApp",
  REFERRAL: "Referral ask",
  BOOKED_CHECKIN: "Monthly check-in",
  VISIT_REMINDER_DAY: "Visit reminder",
  VISIT_REMINDER_SOON: "Visit reminder",
  POST_VISIT_FOLLOWUP: "Follow-up WhatsApp",
  NO_SHOW_FOLLOWUP: "Rebook WhatsApp",
};

function nextNote(purpose: string | null, at: Date, now: Date): string | undefined {
  if (!purpose) return undefined;
  const what = NEXT_WORDS[purpose];
  if (!what) return undefined;
  const ist = new Date(at.getTime() + 330 * 60_000);
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const day = ist.toISOString().slice(0, 10);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`;
  if (at.getTime() <= now.getTime() + 60_000) return `${what} now`;
  if (day === today) return `${what} at ${time}`;
  return `${what} ${showDate(day)}, ${time}`;
}

// ---------------------------------------------------------------------------
// Moving a card
// ---------------------------------------------------------------------------

type LeadRow = {
  id: string;
  stage: StageKey;
  path_stage: PathStage;
  facts: Facts;
  exit_reason: string | null;
  follow_up_on: Date | string | null;
  scope_node_id: string;
  owner_id: string | null;
};

async function loadState(sql: TransactionSql, orgId: string, leadId: string): Promise<(LeadState & { row: LeadRow }) | null> {
  const [r] = await sql<LeadRow[]>`
    SELECT id, stage, path_stage, facts, exit_reason, follow_up_on, scope_node_id, owner_id
    FROM leads WHERE org_id = ${orgId} AND id = ${leadId} FOR UPDATE`;
  if (!r) return null;
  return {
    row: r,
    stage: r.stage,
    pathStage: r.path_stage,
    facts: r.facts ?? {},
    exit:
      r.stage === "nurture" || r.stage === "lost"
        ? { kind: r.stage, reason: r.exit_reason ?? "", followUp: dateStr(r.follow_up_on) }
        : undefined,
  };
}

export type MoveResult =
  | { ok: true; from: StageKey; to: StageKey; facts: Facts; followUpOn: string | null; scopeNodeId: string; ownerId: string | null }
  | { ok: false; message: string; errors?: Record<string, string> };

/**
 * A person moved a card. The plan is made again here against the stored
 * lead and the live team, and the same three functions the dialog ran decide
 * it; a move the rules refuse is refused with their words.
 */
export async function moveLead(opts: {
  orgId: string;
  userId: string;
  leadId: string;
  to: StageKey;
  input: MoveInput;
  today: string;
  /** The IST time, "HH:MM", for checks on a pinned day. Taken from the clock otherwise. */
  nowTime?: string;
  /**
   * A mandate firm's person, in the developer's console. A booking writes the
   * firm's own commission, so the developer records it (`mandateMoveRefusal()`);
   * asked to, the lead is flagged for the developer instead.
   */
  throughMandate?: { firm: string };
}): Promise<MoveResult> {
  const { orgId, userId, leadId, to, input, today } = opts;
  const res = await withTenant(orgId, async (sql): Promise<MoveResult> => {
    const lead = await loadState(sql, orgId, leadId);
    if (!lead) return { ok: false, message: "That lead no longer exists." };
    // An erased buyer's lead is a record of what happened, never moved again:
    // a visit could not be booked behind it, and a note would put their words back.
    const [erased] = await sql`SELECT 1 FROM leads WHERE org_id = ${orgId} AND id = ${leadId} AND erased_at IS NOT NULL`;
    if (erased) return { ok: false, message: "This buyer's data was erased at their request, so the lead cannot be moved." };
    // Moved from a tab opened before somebody (or the engine) moved it: the
    // move was planned against a lead that is no longer there.
    if (input.seen && input.seen !== lead.stage) {
      return { ok: false, message: `This lead moved to ${stageLabel(lead.stage)} since you opened it. Refresh and try again.` };
    }
    if (opts.throughMandate) {
      const [dev] = await sql<{ display_name: string }[]>`SELECT display_name FROM orgs WHERE id = ${orgId}`;
      const refused = mandateMoveRefusal(lead.stage, to, dev?.display_name ?? "The developer");
      if (refused) {
        if (to === "booked") {
          const said = [input.facts.unit, input.facts.agreement ? rupees(Number(String(input.facts.agreement).replace(/\D/g, ""))) : ""].filter(Boolean).join(" at ");
          const note = `${opts.throughMandate.firm} says this buyer booked${said ? ` ${said}` : ""}. Record the booking.`.slice(0, 300);
          await sql`UPDATE leads SET needs_person = ${note}, last_activity_at = now(), updated_at = now() WHERE org_id = ${orgId} AND id = ${leadId}`;
          await sql`
            INSERT INTO lead_activity (org_id, lead_id, kind, reason, note, actor_user_id)
            VALUES (${orgId}, ${leadId}, 'NOTE', ${"Booking reported by the mandate firm"}, ${note}, ${userId})`;
        }
        return { ok: false, message: refused };
      }
    }
    const people = await ownersFor(orgId, lead.row.scope_node_id, sql);
    const names = people.map((p) => p.name);
    const nowTime = opts.nowTime ?? nowTimeOn(today);
    const plan = planMove(lead, to, today, names, nowTime);
    if (plan.kind === "none") return { ok: false, message: "The lead is already there." };
    const errors = validateMove(plan, lead, input, today, names, nowTime);
    if (Object.keys(errors).length) return { ok: false, message: "Some details need fixing.", errors };
    // A visit asked for here starts inside the project's own opening hours.
    const asked = plan.sections.flatMap((s) => s.fields);
    if (plan.to === "visit_scheduled" && (asked.includes("visitDate") || asked.includes("visitTime"))) {
      const merged = { ...lead.facts, ...input.facts };
      const open = await visitHoursAt(sql, orgId, lead.row.scope_node_id);
      if (merged.visitDate && merged.visitTime && !opensAt(open, merged.visitDate, merged.visitTime)) {
        return { ok: false, message: "Some details need fixing.", errors: { visitTime: closedMessage(open, merged.visitDate) } };
      }
    }
    const moved = applyMove(lead, plan, input);
    const owner = people.find((p) => p.name === moved.facts.owner) ?? null;
    const followUpOn = moved.exit?.followUp ?? null;
    const temperature = moved.facts.interest === "Hot" ? "HOT" : moved.facts.interest === "Warm" ? "WARM" : moved.facts.interest === "Cold" ? "COLD" : null;
    await sql`
      UPDATE leads SET stage = ${moved.stage}, path_stage = ${moved.pathStage}, facts = ${sql.json(moved.facts as never)},
             exit_reason = ${moved.exit ? moved.exit.reason || "Other" : null},
             follow_up_on = ${followUpOn},
             owner_id = ${owner?.id ?? (moved.facts.owner ? lead.row.owner_id : null)},
             temperature = coalesce(${temperature}, temperature),
             needs_person = NULL, last_activity_at = now(), updated_at = now()
      WHERE org_id = ${orgId} AND id = ${leadId}`;
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, from_stage, to_stage, reason, note, actor_user_id, detail)
      VALUES (${orgId}, ${leadId}, 'STAGE', ${lead.stage}, ${moved.stage}, ${input.reason ?? null},
              ${input.note?.trim().slice(0, 1000) || null}, ${userId},
              ${sql.json({ kind: plan.kind, clears: plan.clears, cancelsBooking: plan.cancelsBooking } as never)})`;
    // What the move made (qualified, a visit, a booking, a cancellation), in
    // the same transaction, so the board and the log never disagree.
    await recordOutcomes(sql, {
      orgId, leadId, from: lead.stage, to: moved.stage, toPath: moved.pathStage,
      cancelsBooking: plan.cancelsBooking, facts: moved.facts, actorUserId: userId,
    });
    return { ok: true, from: lead.stage, to: moved.stage, facts: moved.facts, followUpOn, scopeNodeId: lead.row.scope_node_id, ownerId: owner?.id ?? null };
  });
  if (res.ok) {
    await audit({ orgId, actorUserId: userId, action: "lead.moved", targetType: "lead", targetId: leadId, metadata: { from: res.from, to: res.to } });
  }
  return res;
}

/**
 * The engine moved a lead. Forward only (the decision functions promise
 * that and this re-checks it), facts merged rather than replaced, and the
 * reason written as the engine's, with no person on the row.
 */
export async function applyEngineMove(opts: {
  orgId: string;
  leadId: string;
  move: StageMove;
  temperature?: "HOT" | "WARM" | "COLD" | null;
  needsPerson?: string | null;
  ownerId?: string | null;
}): Promise<{ from: StageKey; to: StageKey } | null> {
  const { orgId, leadId, move } = opts;
  return withTenant(orgId, async (sql) => {
    const lead = await loadState(sql, orgId, leadId);
    if (!lead) return null;
    // A closed lead is opened again only by a call the buyer spoke on
    // (`reopen`), and never one who asked not to be contacted.
    if (lead.stage === "lost" && (!move.reopen || lead.exit?.reason === "Asked not to be contacted")) return null;
    // Never out of Booked, never backward on the path.
    if (lead.stage === "booked" && move.to !== "booked") return null;
    const toPath = isPath(move.to);
    if (toPath && isPath(lead.stage) && pathOrder(move.to as PathStage) < pathOrder(lead.stage as PathStage)) return null;

    const facts: Facts = { ...lead.facts };
    for (const [k, v] of Object.entries(move.facts) as [keyof Facts, string][]) if (v) facts[k] = v;
    const pathStage: PathStage = toPath
      ? (move.to as PathStage)
      : move.pathStage && pathOrder(move.pathStage) > pathOrder(lead.pathStage)
        ? move.pathStage
        : lead.pathStage;
    const onPath = toPath;
    const exitReason = onPath ? null : move.exitReason ?? lead.exit?.reason ?? "Other";
    const followUp = onPath ? null : move.followUpOn ?? lead.exit?.followUp ?? null;
    const ownerId = opts.ownerId ?? lead.row.owner_id;

    await sql`
      UPDATE leads SET stage = ${move.to}, path_stage = ${pathStage}, facts = ${sql.json(facts as never)},
             exit_reason = ${exitReason}, follow_up_on = ${followUp}, owner_id = ${ownerId},
             temperature = coalesce(${opts.temperature ?? null}, temperature),
             needs_person = ${opts.needsPerson === undefined ? sql`needs_person` : opts.needsPerson},
             last_activity_at = now(), updated_at = now()
      WHERE org_id = ${orgId} AND id = ${leadId}`;
    if (move.to !== lead.stage) {
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, from_stage, to_stage, reason)
        VALUES (${orgId}, ${leadId}, 'STAGE', ${lead.stage}, ${move.to}, ${move.why.slice(0, 200)})`;
    }
    await recordOutcomes(sql, {
      orgId, leadId, from: lead.stage, to: move.to, toPath: pathStage,
      cancelsBooking: false, facts, actorUserId: null,
    });
    return { from: lead.stage, to: move.to };
  });
}

const pathOrder = (s: PathStage) => (["new", "contacted", "qualified", "visit_scheduled", "visit_done", "negotiation", "booked"] as const).indexOf(s);

/** Facts a stage past `stage` would carry, which an automatic move must not invent. */
export function factsBeyond(stage: PathStage): (keyof Facts)[] {
  const later = (["new", "contacted", "qualified", "visit_scheduled", "visit_done", "negotiation", "booked"] as PathStage[]).slice(pathOrder(stage) + 1);
  return later.flatMap((s) => STAGE_FIELDS[s]);
}

/** Pause or resume what the engine does for one lead. */
export async function setAutomation(opts: { orgId: string; userId: string; leadId: string; on: boolean }): Promise<boolean> {
  const ok = await withTenant(opts.orgId, async (sql) => {
    const r = await sql`
      UPDATE leads SET automation = ${opts.on ? "ON" : "PAUSED"}, updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.leadId}`;
    if (!r.count) return false;
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id)
      VALUES (${opts.orgId}, ${opts.leadId}, 'AUTOMATION', ${opts.on ? "Automation resumed" : "Automation paused"}, ${opts.userId})`;
    return true;
  });
  if (ok) await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: opts.on ? "lead.automation_on" : "lead.automation_off", targetType: "lead", targetId: opts.leadId });
  return ok;
}

/** Clear the "needs you" flag once a person has dealt with it. */
export async function clearNeedsPerson(opts: { orgId: string; userId: string; leadId: string }): Promise<void> {
  await withTenant(opts.orgId, async (sql) => {
    await sql`UPDATE leads SET needs_person = NULL, updated_at = now() WHERE org_id = ${opts.orgId} AND id = ${opts.leadId}`;
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id)
      VALUES (${opts.orgId}, ${opts.leadId}, 'NOTE', 'Marked as dealt with', ${opts.userId})`;
  });
}

// ---------------------------------------------------------------------------
// One lead, for its own page
// ---------------------------------------------------------------------------

export type LeadDetail = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  stage: StageKey;
  pathStage: PathStage;
  facts: Facts;
  exitReason: string | null;
  followUpOn: string | null;
  temperature: "HOT" | "WARM" | "COLD" | null;
  source: string;
  channel: string;
  lineage: Lineage;
  language: Language;
  place: string;
  phaseId: string;
  owner: string | null;
  needsPerson: string | null;
  automation: "ON" | "PAUSED";
  enquiredAt: string;
  createdAt: string;
  optedOut: boolean;
  /** When the buyer's data was erased at their request. `phone` is then empty and `name` is "Erased buyer". */
  erasedAt: string | null;
  /** What stands about the number and the DND register, or null when nothing is known. */
  dnd: DndRow | null;
  /** What the calls heard, the score it adds up to, and where that sent the lead. */
  qualification: Qualification;
  score: number | null;
  route: Route | null;
  /** What the buyer answered on our Meta form, in their words. */
  formAnswers: { question: string; answer: string }[];
  publication: { id: string; destination: string; headline: string } | null;
  activity: { at: string; kind: string; text: string; note: string | null; byPerson: boolean }[];
  tasks: { id: string; purpose: string; dueAt: string; state: string; result: string | null }[];
};

export async function loadLead(orgId: string, leadId: string): Promise<LeadDetail | null> {
  if (!isUuid(leadId)) return null;
  return withTenant(orgId, async (sql) => {
    const [l] = await sql<
      {
        id: string; name: string; phone: string; email: string | null; stage: StageKey; path_stage: PathStage; facts: Facts;
        exit_reason: string | null; follow_up_on: Date | string | null; temperature: "HOT" | "WARM" | "COLD" | null;
        source: string; channel: string; lineage: Lineage; language: Language; place: string; scope_node_id: string;
        owner: string | null; needs_person: string | null; automation: "ON" | "PAUSED"; enquired_at: Date; created_at: Date;
        opted_out: boolean; target_id: string | null; destination: string | null; headline: string | null; erased_at: Date | null;
        qualification: Qualification | null; score: number | null; route: Route | null;
        form_answers: { question: string; answer: string }[] | null;
      }[]
    >`
      SELECT l.id, l.name, l.phone, l.email, l.stage, l.path_stage, l.facts, l.exit_reason, l.follow_up_on, l.temperature,
             l.qualification, l.score, l.route, l.erased_at, l.form_answers,
             l.source, l.channel, l.lineage, l.language, l.scope_node_id, l.needs_person, l.automation, l.enquired_at, l.created_at,
             CASE WHEN p.name IS NULL THEN n.name ELSE p.name || ' · ' || n.name END AS place,
             coalesce(u.name, u.email::text) AS owner,
             EXISTS (SELECT 1 FROM call_suppressions s WHERE s.org_id = l.org_id AND s.phone = l.phone) AS opted_out,
             t.id AS target_id, t.destination, t.headline
      FROM leads l
      JOIN scope_nodes n ON n.id = l.scope_node_id
      LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
      LEFT JOIN users u ON u.id = l.owner_id
      LEFT JOIN publish_targets t ON t.id = l.publish_target_id
      WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    if (!l) return null;
    const [activity, tasks, dnd] = await Promise.all([
      sql<{ at: Date; kind: string; from_stage: string | null; to_stage: string | null; reason: string | null; note: string | null; actor: string | null }[]>`
        SELECT a.at, a.kind, a.from_stage, a.to_stage, a.reason, a.note, coalesce(u.name, u.email::text) AS actor
        FROM lead_activity a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.org_id = ${orgId} AND a.lead_id = ${leadId}
        ORDER BY a.at DESC LIMIT 200`,
      sql<{ id: string; purpose: string; due_at: Date; state: string; result: string | null }[]>`
        SELECT id, purpose, due_at, state, result FROM lead_tasks
        WHERE org_id = ${orgId} AND lead_id = ${leadId}
        ORDER BY due_at DESC LIMIT 200`,
      // An erased buyer has no number to stand on the register.
      l.phone ? standingFor(orgId, l.phone, new Date().toISOString(), sql) : Promise.resolve(null),
    ]);
    return {
      id: l.id,
      name: l.name,
      phone: l.phone ?? "",
      email: l.email,
      stage: l.stage,
      pathStage: l.path_stage,
      facts: l.facts ?? {},
      exitReason: l.exit_reason,
      followUpOn: dateStr(l.follow_up_on) ?? null,
      temperature: l.temperature,
      source: l.source,
      channel: l.channel,
      lineage: l.lineage ?? {},
      language: l.language,
      place: l.place,
      phaseId: l.scope_node_id,
      owner: l.owner,
      needsPerson: l.needs_person,
      automation: l.automation,
      enquiredAt: l.enquired_at.toISOString(),
      createdAt: l.created_at.toISOString(),
      optedOut: l.opted_out,
      erasedAt: l.erased_at?.toISOString() ?? null,
      dnd,
      qualification: l.qualification ?? {},
      score: l.score,
      route: l.route,
      formAnswers: l.form_answers ?? [],
      publication: l.target_id ? { id: l.target_id, destination: l.destination ?? "", headline: l.headline ?? "" } : null,
      activity: activity.map((a) => {
        const what =
          a.kind === "STAGE"
            ? `${stageWord(a.from_stage)} to ${stageWord(a.to_stage)}${a.reason ? `: ${a.reason}` : ""}`
            : a.reason ?? a.kind.toLowerCase();
        return {
          at: a.at.toISOString(),
          kind: a.kind,
          text: a.actor ? `${what} (${a.actor})` : what,
          note: a.note,
          byPerson: a.actor !== null,
        };
      }),
      tasks: tasks.map((t) => ({ id: t.id, purpose: t.purpose, dueAt: t.due_at.toISOString(), state: t.state, result: t.result })),
    };
  });
}

const STAGE_WORD: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  visit_scheduled: "Visit scheduled",
  visit_done: "Visit done",
  negotiation: "Negotiation",
  booked: "Booked",
  nurture: "Nurture",
  lost: "Lost",
};
const stageWord = (s: string | null) => (s ? STAGE_WORD[s] ?? s : "");

/** This buyer's other enquiries in the organisation: the same number, another project or tower. */
export type OtherEnquiry = { id: string; place: string; path: string; stage: string; lastActivity: string };

/**
 * One buyer across several projects. Each enquiry stays its own lead, under
 * its own tower's registration; this lists the others so a person sees the
 * whole buyer, and the calls carry what the buyer already said (`calling.ts`
 * reads every call to the number). The caller filters by `lead:read`.
 */
export async function otherEnquiries(orgId: string, leadId: string): Promise<OtherEnquiry[]> {
  if (!isUuid(leadId)) return [];
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; place: string; path: string; stage: string; last_activity_at: Date }[]>`
    SELECT l.id, coalesce(p.name || ' · ', '') || n.name AS place, n.path::text AS path, l.stage, l.last_activity_at
    FROM leads l
    JOIN scope_nodes n ON n.id = l.scope_node_id
    LEFT JOIN scope_nodes p ON p.id = n.parent_id AND n.kind = 'PHASE'
    WHERE l.org_id = ${orgId} AND l.erased_at IS NULL AND l.id <> ${leadId}
      AND l.phone = (SELECT phone FROM leads WHERE org_id = ${orgId} AND id = ${leadId})
    ORDER BY l.last_activity_at DESC LIMIT 20`);
  return rows.map((r) => ({ id: r.id, place: r.place, path: r.path, stage: r.stage, lastActivity: r.last_activity_at.toISOString() }));
}
