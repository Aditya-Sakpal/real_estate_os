import { randomUUID } from "node:crypto";
import { audit, withTenant } from "./db/index.ts";
import { messageAllowed } from "./billing.ts";
import { preparePublication } from "./publish.ts";
import { readAsset } from "./storage.ts";
import { isNodeId } from "./scope-rules.ts";
import { senderFor } from "./wa-numbers.ts";
import { tierPeople, readTier } from "./wa-rules.ts";
import { uploadMedia, whatsapp } from "./whatsapp.ts";
import { FILL_INS, PRICE_PAISE, fill, render, type Voice } from "./message-rules.ts";
import {
  CAP_BROADCASTS_7D,
  CAP_MARKETING_30D,
  EXCLUSION_WORDS,
  PROMOTIONAL_PURPOSES,
  HALTING,
  MAX_BROADCAST_RECIPIENTS,
  MEDIA_ID_DAYS,
  BROADCAST_LEASE_MS,
  BROADCAST_TEMPLATES,
  STOP_PAYLOAD,
  BROADCAST_DESTINATION,
  adLine,
  audience,
  batchSize,
  broadcastPicture,
  canApprove,
  canStop,
  estimate,
  firstRefusal,
  inBroadcastHours,
  withinCap,
  wordingFor,
  type Audience,
  type BroadcastStatus,
  type Candidate,
  type Exclusion,
  type Gate,
} from "./broadcast-rules.ts";
import type { StageKey } from "./lead-rules.ts";

/**
 * WhatsApp broadcasts: the reads and writes around `broadcast-rules.ts`.
 *
 * A broadcast is built from a post that passes every gate a publication
 * passes (`preparePublication()`), counted against the leads of one tower or
 * project, approved by somebody holding the budget key (the recipients are
 * frozen then), and sent by the lead worker in leased batches from the
 * developer's own number, each person asked every gate again when it is
 * their turn. Every message is a row before it is a request, so a refusal
 * shows on the lead with its reason and a lost answer is never sent twice.
 *
 * No phone number leaves this file for a screen, and none reaches
 * `audit_log`: a broadcast is counts.
 */

export type Refusal = { ok: false; code: string; message: string };

type Source = { kind: "STUDIO"; postId: string } | { kind: "SCHEDULE"; creativeId: string };

type PostFor = {
  source: Source;
  node: { id: string; path: string; name: string; kind: string };
  phaseId: string;
  line: string;
  media: { key: string; sha256: string };
  project: string;
};

/**
 * The post, through the publisher's own gates, and what a broadcast of it
 * would carry: its picture, one line of its cleared copy, the phase whose
 * registration it goes under, and the name buyers know the project by.
 */
async function postFor(orgId: string, source: Source, now: Date): Promise<({ ok: true } & PostFor) | Refusal> {
  const p = await preparePublication(orgId, source, now);
  if (!p.ok) return p;
  const picture = broadcastPicture({ kind: p.kind, placement: p.placement, media: p.media });
  if (!picture.ok) return { ok: false, code: "PICTURE", message: picture.reason };
  const m = p.media[picture.index];
  if (!m.sha256) return { ok: false, code: "PICTURE", message: "This post was made before its files were checked. Make it again." };
  const line = adLine({ headline: p.headline, body: p.body });
  if (!line) return { ok: false, code: "NO_LINE", message: "This post has no words to send with its picture." };
  const project = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ name: string }[]>`
      SELECT name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PROJECT' AND path @> ${p.node.path}::ltree LIMIT 1`;
    return r?.name ?? null;
  });
  return {
    ok: true,
    source,
    node: p.node,
    phaseId: p.phase.id,
    line,
    media: { key: m.key, sha256: m.sha256 },
    project: p.node.kind === "PHASE" && project ? `${project} ${p.node.name}` : p.node.name,
  };
}

// ---------------------------------------------------------------------------
// Who it reaches
// ---------------------------------------------------------------------------

/** Read at most this many leads for one broadcast; a project has fewer. */
const CANDIDATE_CEILING = 20_000;

/**
 * Every lead under `nodeId`, with what the audience rules need to know about
 * each, in one statement. Nothing here is a person's words.
 */
async function candidates(orgId: string, nodeId: string, now: Date): Promise<Candidate[]> {
  return withTenant(orgId, async (sql) => {
    const rows = await sql<
      {
        id: string;
        phone: string;
        language: string | null;
        stage: StageKey;
        channel: string;
        active_at: Date;
        opted_out: boolean;
        marketing_stopped: boolean;
        consent: boolean;
        partner_claim: boolean;
        b7: number;
        m30: number;
      }[]
    >`
      WITH target AS (SELECT path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId})
      SELECT l.id, l.phone, l.language, l.stage, l.channel, coalesce(l.last_activity_at, l.created_at) AS active_at,
        EXISTS (SELECT 1 FROM call_suppressions s WHERE s.org_id = l.org_id AND s.phone = l.phone) AS opted_out,
        coalesce((SELECT NOT o.resumed FROM message_opt_outs o
                  WHERE o.org_id = l.org_id AND o.phone = l.phone ORDER BY o.created_at DESC LIMIT 1), false) AS marketing_stopped,
        EXISTS (SELECT 1 FROM lead_consents c
                WHERE c.org_id = l.org_id AND c.phone = l.phone AND 'whatsapp' = ANY(c.channels)
                  AND c.captured_at <= ${now} AND (c.expires_at IS NULL OR c.expires_at > ${now})) AS consent,
        EXISTS (SELECT 1 FROM client_registrations r JOIN scope_nodes p ON p.id = r.scope_node_id
                WHERE r.org_id = l.org_id AND r.phone = l.phone AND r.verdict = 'REGISTERED'
                  AND r.status = 'ACTIVE' AND r.valid_until > ${now} AND p.path @> n.path) AS partner_claim,
        (SELECT count(*) FROM messages m
          WHERE m.org_id = l.org_id AND m.phone = l.phone AND m.direction = 'OUT' AND m.broadcast_id IS NOT NULL
            AND m.status NOT IN ('REFUSED', 'FAILED') AND m.created_at > ${new Date(now.getTime() - 7 * 86_400_000)})::int AS b7,
        (SELECT count(*) FROM messages m
          WHERE m.org_id = l.org_id AND m.phone = l.phone AND m.direction = 'OUT' AND m.purpose = ANY(${[...PROMOTIONAL_PURPOSES]})
            AND m.status NOT IN ('REFUSED', 'FAILED') AND m.created_at > ${new Date(now.getTime() - 30 * 86_400_000)})::int AS m30
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id, target t
      WHERE l.org_id = ${orgId} AND n.path <@ t.path AND l.erased_at IS NULL
      ORDER BY l.id
      LIMIT ${CANDIDATE_CEILING}`;
    return rows.map((r) => ({
      leadId: r.id,
      phone: r.phone,
      language: r.language,
      stage: r.stage,
      channel: r.channel,
      optedOut: r.opted_out,
      marketingStopped: r.marketing_stopped,
      consent: r.consent,
      partnerClaim: r.partner_claim,
      broadcasts7d: r.b7,
      marketing30d: r.m30,
      // The DND register does not cover WhatsApp; the ledger of what we know
      // about it is not committed yet, and nothing is read from it here.
      dnd: false,
      activeAt: r.active_at.toISOString(),
    }));
  });
}

export type Preview = {
  ok: true;
  audience: number;
  excluded: { code: Exclusion; words: string; count: number }[];
  byVoice: Partial<Record<Voice, number>>;
  costPaise: number;
  billedPaise: number;
  line: string;
  project: string;
  /** Over the ceiling, so it cannot be approved as it stands. */
  tooMany: boolean;
};

function shape(a: Audience, post: PostFor): Preview {
  const e = estimate(a.included.length);
  return {
    ok: true,
    audience: a.included.length,
    excluded: (Object.entries(a.excluded) as [Exclusion, number][])
      .filter(([, n]) => n > 0)
      .map(([code, count]) => ({ code, words: EXCLUSION_WORDS[code], count }))
      .sort((x, y) => y.count - x.count),
    byVoice: a.byVoice,
    costPaise: e.costPaise,
    billedPaise: e.billedPaise,
    line: post.line,
    project: post.project,
    tooMany: a.included.length > MAX_BROADCAST_RECIPIENTS,
  };
}

/** The node a broadcast of this post reaches: the post's own, or one under it the person chose. */
async function audienceNode(orgId: string, postNode: { id: string; path: string }, nodeId: string | null) {
  if (!nodeId || nodeId === postNode.id) return postNode;
  if (!isNodeId(nodeId)) return null;
  return withTenant(orgId, async (sql) => {
    const [n] = await sql<{ id: string; path: string }[]>`
      SELECT id, path::text AS path FROM scope_nodes
      WHERE org_id = ${orgId} AND id = ${nodeId} AND path <@ ${postNode.path}::ltree AND kind IN ('PROJECT', 'PHASE')`;
    return n ?? null;
  });
}

/** Who a broadcast of this post would reach, and who it would leave out. Nothing is written. */
export async function previewBroadcast(input: {
  orgId: string;
  source: Source;
  nodeId?: string | null;
  stages: readonly StageKey[];
  voice: Voice | null;
  now?: Date;
}): Promise<Preview | Refusal> {
  const now = input.now ?? new Date();
  const post = await postFor(input.orgId, input.source, now);
  if (!post.ok) return post;
  const node = await audienceNode(input.orgId, post.node, input.nodeId ?? null);
  if (!node) return { ok: false, code: "UNKNOWN_PLACE", message: "Choose a tower or project this post is for." };
  const a = audience(await candidates(input.orgId, node.id, now), { stages: input.stages, voice: input.voice });
  return shape(a, post);
}

// ---------------------------------------------------------------------------
// Building and approving
// ---------------------------------------------------------------------------

/**
 * A broadcast, written as a DRAFT with the counts it had when it was built.
 * Nothing goes until somebody holding the budget key approves it.
 */
export async function createBroadcast(input: {
  orgId: string;
  /** Null when a schedule sending by itself built it. */
  userId: string | null;
  source: Source;
  nodeId?: string | null;
  stages: readonly StageKey[];
  voice: Voice | null;
  now?: Date;
}): Promise<({ ok: true; broadcastId: string } & Preview) | Refusal> {
  const now = input.now ?? new Date();
  const post = await postFor(input.orgId, input.source, now);
  if (!post.ok) return post;
  const node = await audienceNode(input.orgId, post.node, input.nodeId ?? null);
  if (!node) return { ok: false, code: "UNKNOWN_PLACE", message: "Choose a tower or project this post is for." };
  const a = withinCap(
    audience(await candidates(input.orgId, node.id, now), { stages: input.stages, voice: input.voice }),
    await scheduleCap(input.orgId, input.source.kind === "SCHEDULE" ? input.source.creativeId : null),
  );
  const preview = shape(a, post);
  const id = randomUUID();
  await withTenant(input.orgId, (sql) => sql`
    INSERT INTO broadcasts (id, org_id, scope_node_id, phase_id, source, rendered_post_id, post_creative_id, media_key,
                            media_sha256, line, stages, voice, audience, excluded, by_voice, estimate_paise, created_by)
    VALUES (${id}, ${input.orgId}, ${node.id}, ${post.phaseId}, ${input.source.kind},
            ${input.source.kind === "STUDIO" ? input.source.postId : null},
            ${input.source.kind === "SCHEDULE" ? input.source.creativeId : null},
            ${post.media.key}, ${post.media.sha256}, ${post.line}, ${[...input.stages]}::text[], ${input.voice},
            ${Math.min(a.included.length, MAX_BROADCAST_RECIPIENTS)}, ${sql.json(a.excluded)}, ${sql.json(a.byVoice)},
            ${preview.billedPaise}, ${input.userId})`);
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "broadcast.created",
    targetType: "broadcast",
    targetId: id,
    metadata: { audience: a.included.length, excluded: a.excluded, source: input.source.kind },
  });
  return { ...preview, broadcastId: id };
}

type BroadcastRow = {
  id: string;
  scope_node_id: string;
  phase_id: string | null;
  source: "STUDIO" | "SCHEDULE";
  rendered_post_id: string | null;
  post_creative_id: string | null;
  media_key: string;
  media_sha256: string;
  line: string;
  stages: StageKey[];
  voice: Voice | null;
  number_id: string | null;
  status: BroadcastStatus;
  meta_media_id: string | null;
  meta_media_at: Date | null;
};

const sourceOf = (b: BroadcastRow): Source | null =>
  b.source === "STUDIO"
    ? b.rendered_post_id ? { kind: "STUDIO", postId: b.rendered_post_id } : null
    : b.post_creative_id ? { kind: "SCHEDULE", creativeId: b.post_creative_id } : null;

async function loadBroadcast(orgId: string, id: string): Promise<BroadcastRow | null> {
  if (!isNodeId(id)) return null;
  return withTenant(orgId, async (sql) => {
    const [b] = await sql<BroadcastRow[]>`
      SELECT id, scope_node_id, phase_id, source, rendered_post_id, post_creative_id, media_key, media_sha256, line,
             stages, voice, number_id, status, meta_media_id, meta_media_at
      FROM broadcasts WHERE org_id = ${orgId} AND id = ${id}`;
    return b ?? null;
  });
}

/** The most a schedule's broadcast reaches for one post, or null for a broadcast built by hand. */
async function scheduleCap(orgId: string, creativeId: string | null): Promise<number | null> {
  if (!creativeId) return null;
  const [r] = await withTenant(orgId, (sql) => sql<{ cap: number | null }[]>`
    SELECT s.broadcast_cap AS cap FROM post_creatives c
    JOIN post_runs r ON r.id = c.run_id JOIN post_schedules s ON s.id = r.schedule_id
    WHERE c.org_id = ${orgId} AND c.id = ${creativeId}`);
  return r?.cap ?? null;
}

/** Where a broadcast is, for the action to ask its keys at, and the key of the picture it sends. */
export async function broadcastPlace(
  orgId: string,
  id: string,
): Promise<{ path: string; status: BroadcastStatus; mediaKey: string } | null> {
  if (!isNodeId(id)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ path: string; status: BroadcastStatus; media_key: string }[]>`
      SELECT n.path::text AS path, b.status, b.media_key FROM broadcasts b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${orgId} AND b.id = ${id}`;
    return r ? { path: r.path, status: r.status, mediaKey: r.media_key } : null;
  });
}

/**
 * Approve a draft: every gate again, the audience counted afresh, the
 * number and the credit asked, and then the recipients frozen. Only a
 * DRAFT is approved, once: the move to APPROVED is one guarded UPDATE.
 */
export async function approveBroadcast(input: { orgId: string; userId: string | null; broadcastId: string; now?: Date }): Promise<
  ({ ok: true; audience: number; billedPaise: number }) | Refusal
> {
  const now = input.now ?? new Date();
  const b = await loadBroadcast(input.orgId, input.broadcastId);
  if (!b) return { ok: false, code: "GONE", message: "That broadcast is not in this organisation." };
  if (!canApprove(b.status)) return { ok: false, code: "NOT_DRAFT", message: "This broadcast was already approved or stopped." };
  const source = sourceOf(b);
  if (!source) return { ok: false, code: "GONE", message: "The post this broadcast was made from was removed." };
  const post = await postFor(input.orgId, source, now);
  if (!post.ok) return post;
  if (post.media.sha256 !== b.media_sha256) {
    return { ok: false, code: "CHANGED", message: "The post changed after this broadcast was built. Build it again." };
  }

  const sender = await senderFor(input.orgId, b.scope_node_id);
  if (!sender.ok) return { ok: false, code: "NOT_SWITCHED_ON", message: "No WhatsApp number is connected for this project." };
  const quality = await numberQuality(input.orgId, sender.numberId);
  if (quality === "RED") return { ok: false, code: "QUALITY", message: "Meta rates this number's quality low. Wait for it to recover before broadcasting." };

  const a = withinCap(
    audience(await candidates(input.orgId, b.scope_node_id, now), { stages: b.stages, voice: b.voice }),
    await scheduleCap(input.orgId, b.post_creative_id),
  );
  if (!a.included.length) return { ok: false, code: "EMPTY", message: "Nobody is left to send this to." };
  if (a.included.length > MAX_BROADCAST_RECIPIENTS) {
    return {
      ok: false,
      code: "TOO_MANY",
      message: `A broadcast reaches at most ${MAX_BROADCAST_RECIPIENTS.toLocaleString("en-IN")} people. Choose a tower or fewer stages.`,
    };
  }
  // A version nobody could be sent is not a version to approve for.
  const voices = Object.keys(a.byVoice) as Voice[];
  const unready = voices.filter((v) => !wordingFor(b.id, v, (name) => sender.approved(name, "en")));
  if (unready.length === voices.length) {
    return { ok: false, code: "NOT_APPROVED", message: "Meta has not approved the broadcast message on this number yet." };
  }
  const e = estimate(a.included.length);
  const credit = await messageAllowed(input.orgId, b.scope_node_id, e.costPaise);
  if (!credit.ok) return { ok: false, code: "NO_CREDIT", message: credit.message };

  const moved = await withTenant(input.orgId, async (sql) => {
    const done = await sql`
      UPDATE broadcasts SET status = 'APPROVED', approved_by = ${input.userId}, approved_at = ${now},
        number_id = ${sender.numberId}, phase_id = ${post.phaseId}, audience = ${a.included.length},
        excluded = ${sql.json(a.excluded)}, by_voice = ${sql.json(a.byVoice)}, estimate_paise = ${e.billedPaise},
        updated_at = now()
      WHERE org_id = ${input.orgId} AND id = ${b.id} AND status = 'DRAFT'`;
    if (!done.count) return false;
    const rows = a.included.map((r) => ({ org_id: input.orgId, broadcast_id: b.id, lead_id: r.leadId, voice: r.voice }));
    for (let i = 0; i < rows.length; i += 1000) {
      await sql`INSERT INTO broadcast_recipients ${sql(rows.slice(i, i + 1000), "org_id", "broadcast_id", "lead_id", "voice")}`;
    }
    return true;
  });
  if (!moved) return { ok: false, code: "NOT_DRAFT", message: "This broadcast was already approved or stopped." };
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "broadcast.approved",
    targetType: "broadcast",
    targetId: b.id,
    metadata: { audience: a.included.length, by_voice: a.byVoice, estimate_paise: e.billedPaise, unready_voices: unready },
  });
  return { ok: true, audience: a.included.length, billedPaise: e.billedPaise };
}

/** Stop a broadcast: nothing more goes, and whoever was still waiting gets nothing. */
export async function stopBroadcast(input: { orgId: string; userId: string; broadcastId: string }): Promise<{ ok: true } | Refusal> {
  const b = await loadBroadcast(input.orgId, input.broadcastId);
  if (!b) return { ok: false, code: "GONE", message: "That broadcast is not in this organisation." };
  if (!canStop(b.status)) return { ok: false, code: "OVER", message: "This broadcast has already finished." };
  const stopped = await withTenant(input.orgId, async (sql) => {
    const r = await sql`
      UPDATE broadcasts SET status = 'CANCELLED', halted_reason = 'STOPPED', halted_at = now(), stopped_by = ${input.userId},
        lease_until = NULL, lease_holder = NULL, updated_at = now()
      WHERE org_id = ${input.orgId} AND id = ${b.id} AND status IN ('DRAFT', 'APPROVED', 'SENDING')`;
    if (r.count) {
      await sql`
        UPDATE broadcast_recipients SET status = 'CANCELLED', updated_at = now()
        WHERE org_id = ${input.orgId} AND broadcast_id = ${b.id} AND status = 'WAITING'`;
    }
    return r.count > 0;
  });
  if (!stopped) return { ok: false, code: "OVER", message: "This broadcast has already finished." };
  await audit({ orgId: input.orgId, actorUserId: input.userId, action: "broadcast.stopped", targetType: "broadcast", targetId: b.id, metadata: {} });
  return { ok: true };
}

/** Whether a WhatsApp number writes to buyers at this node, so a broadcast could go from it. */
export async function numberAt(orgId: string, nodeId: string): Promise<boolean> {
  return (await senderFor(orgId, nodeId)).ok;
}

async function numberQuality(orgId: string, numberId: string): Promise<string | null> {
  const [r] = await withTenant(orgId, (sql) => sql<{ quality: string }[]>`
    SELECT quality FROM whatsapp_numbers WHERE org_id = ${orgId} AND id = ${numberId}`);
  return r?.quality ?? null;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function halt(orgId: string, id: string, reason: string, refusal: string): Promise<void> {
  await withTenant(orgId, async (sql) => {
    await sql`
      UPDATE broadcasts SET status = 'HALTED', halted_reason = ${reason}, halted_at = now(),
        lease_until = NULL, lease_holder = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${id} AND status IN ('APPROVED', 'SENDING')`;
    await sql`
      UPDATE broadcast_recipients SET status = 'CANCELLED', refusal = ${refusal}, updated_at = now()
      WHERE org_id = ${orgId} AND broadcast_id = ${id} AND status = 'WAITING'`;
  });
  await audit({ orgId, actorUserId: null, action: "broadcast.halted", targetType: "broadcast", targetId: id, metadata: { reason } });
}

const release = (orgId: string, id: string) =>
  withTenant(orgId, (sql) => sql`
    UPDATE broadcasts SET lease_until = NULL, lease_holder = NULL, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${id}`);

type RecipientRow = {
  id: string;
  lead_id: string;
  voice: Voice;
  name: string;
  phone: string;
  language: string | null;
  opted_out: boolean;
  marketing_stopped: boolean;
  consent: boolean;
  b7: number;
  m30: number;
};

export type SendReport = { scheduled: number; broadcasts: number; sent: number; refused: number; failed: number; halted: number };

/** A scheduled post's time plus this, and its broadcast is not built: the publisher's own window. */
const SCHEDULE_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * The broadcasts schedules owe: every approved creative whose schedule
 * broadcasts, whose time has come and not gone six hours past, and that has
 * no broadcast yet. Each is built and approved in one go, because the budget
 * key decided the spend on the schedule and a person or the schedule's mode
 * approved the post; approving still asks every gate, the number, the
 * credit and the schedule's limit. One that cannot be approved stays a
 * DRAFT on Published, with its reason on the creative, for a person.
 */
export async function enqueueScheduledBroadcasts(orgId: string, now = new Date()): Promise<number> {
  const due = await withTenant(orgId, (sql) => sql<{ id: string; decided_by: string | null; created_by: string | null }[]>`
    SELECT c.id, c.decided_by, s.created_by
    FROM post_creatives c
    JOIN post_runs r ON r.id = c.run_id
    JOIN post_schedules s ON s.id = r.schedule_id
    WHERE c.org_id = ${orgId} AND c.state IN ('APPROVED', 'PUBLISHED') AND s.active
      AND ${BROADCAST_DESTINATION} = ANY(s.destinations) AND s.broadcast_cap IS NOT NULL
      AND r.publish_at <= ${now} AND r.publish_at > ${new Date(now.getTime() - SCHEDULE_GRACE_MS)}
      AND NOT EXISTS (SELECT 1 FROM broadcasts b WHERE b.org_id = c.org_id AND b.post_creative_id = c.id)
    ORDER BY r.publish_at
    LIMIT 20`);

  let made = 0;
  for (const c of due) {
    const who = c.decided_by ?? c.created_by;
    const built = await createBroadcast({ orgId, userId: who, source: { kind: "SCHEDULE", creativeId: c.id }, stages: [], voice: null, now });
    const approved = built.ok ? await approveBroadcast({ orgId, userId: who, broadcastId: built.broadcastId, now }) : built;
    await withTenant(orgId, (sql) =>
      approved.ok
        ? sql`UPDATE post_creatives SET state = 'PUBLISHED', publish_note = NULL
              WHERE org_id = ${orgId} AND id = ${c.id} AND state IN ('APPROVED', 'PUBLISHED')`
        : sql`UPDATE post_creatives SET publish_note = ${`WhatsApp broadcast: ${approved.message}`.slice(0, 300)}
              WHERE org_id = ${orgId} AND id = ${c.id}`);
    if (approved.ok) made += 1;
  }
  return made;
}

/**
 * One pass: claim each broadcast due under a lease, ask the batch's gates
 * once (the registration and the post, the number), then send to as many as
 * the number's daily limit, the organisation's day and the batch allow, each
 * person asked their own gates in order. Outside 10:00 to 21:00 IST nothing
 * is sent and the broadcast waits.
 */
export async function sendDueBroadcasts(opts: { orgId: string; now?: Date; max?: number }): Promise<SendReport> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  // Built at any hour: an approved broadcast waits for ten in the morning.
  const report: SendReport = { scheduled: await enqueueScheduledBroadcasts(opts.orgId, now), broadcasts: 0, sent: 0, refused: 0, failed: 0, halted: 0 };
  if (!inBroadcastHours(nowIso)) return report;
  const holder = randomUUID();

  for (let round = 0; round < (opts.max ?? 5); round++) {
    const [claimed] = await withTenant(opts.orgId, (sql) => sql<BroadcastRow[]>`
      UPDATE broadcasts SET lease_until = ${new Date(now.getTime() + BROADCAST_LEASE_MS)}, lease_holder = ${holder},
        status = CASE WHEN status = 'APPROVED' THEN 'SENDING' ELSE status END,
        started_at = coalesce(started_at, ${now}), updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = (
        SELECT id FROM broadcasts
        WHERE org_id = ${opts.orgId} AND status IN ('APPROVED', 'SENDING')
          AND (lease_until IS NULL OR lease_until < ${now}) AND (lease_holder IS NULL OR lease_holder <> ${holder})
        ORDER BY approved_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, scope_node_id, phase_id, source, rendered_post_id, post_creative_id, media_key, media_sha256, line,
                stages, voice, number_id, status, meta_media_id, meta_media_at`);
    if (!claimed) break;
    report.broadcasts += 1;
    const r = await sendBatch(opts.orgId, claimed, now);
    report.sent += r.sent;
    report.refused += r.refused;
    report.failed += r.failed;
    report.halted += r.halted ? 1 : 0;
  }
  return report;
}

async function sendBatch(orgId: string, b: BroadcastRow, now: Date): Promise<{ sent: number; refused: number; failed: number; halted: boolean }> {
  const out = { sent: 0, refused: 0, failed: 0, halted: false };
  const nowIso = now.toISOString();

  // The batch's own gates first: the registration and the post, then the number.
  const source = sourceOf(b);
  const post = source ? await postFor(orgId, source, now) : ({ ok: false, code: "GONE", message: "" } as Refusal);
  if (!post.ok || post.media.sha256 !== b.media_sha256) {
    const gate: Gate = !post.ok && post.code === "NOT_ADVERTISABLE" ? "NOT_ADVERTISABLE" : "POST";
    await halt(orgId, b.id, HALTING[gate] ?? "POST", gate);
    out.halted = true;
    return out;
  }
  const sender = await senderFor(orgId, b.scope_node_id);
  if (!sender.ok || (b.number_id && sender.numberId !== b.number_id)) {
    await halt(orgId, b.id, "NUMBER", "NUMBER");
    out.halted = true;
    return out;
  }
  const num = await withTenant(orgId, async (sql) => {
    const [n] = await sql<{ quality: string; daily_limit: string | null }[]>`
      SELECT quality, daily_limit FROM whatsapp_numbers WHERE org_id = ${orgId} AND id = ${sender.numberId}`;
    const [reached] = await sql<{ n: number }[]>`
      SELECT count(DISTINCT phone)::int AS n FROM messages
      WHERE org_id = ${orgId} AND number_id = ${sender.numberId} AND direction = 'OUT' AND template IS NOT NULL
        AND status NOT IN ('REFUSED', 'FAILED') AND created_at > ${new Date(now.getTime() - 86_400_000)}`;
    const [today] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages
      WHERE org_id = ${orgId} AND broadcast_id IS NOT NULL AND direction = 'OUT' AND status NOT IN ('REFUSED', 'FAILED')
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (${now}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`;
    return { quality: n?.quality ?? "UNKNOWN", tier: readTier(n?.daily_limit), reached: reached?.n ?? 0, today: today?.n ?? 0 };
  });
  if (num.quality === "RED") {
    await halt(orgId, b.id, "QUALITY", "QUALITY");
    out.halted = true;
    return out;
  }
  const room = batchSize({ tierPeople: num.tier ? tierPeople(num.tier) : 250, reached24h: num.reached, orgToday: num.today });
  if (room <= 0) {
    await release(orgId, b.id);
    return out;
  }

  // The picture goes up once, on the number that sends it; its id lives 30 days.
  let mediaId = b.meta_media_id;
  if (!mediaId || !b.meta_media_at || now.getTime() - b.meta_media_at.getTime() > MEDIA_ID_DAYS * 86_400_000) {
    const bytes = await readAsset(b.media_key);
    if (!bytes) {
      await halt(orgId, b.id, "POST", "PICTURE");
      out.halted = true;
      return out;
    }
    try {
      const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const up = await uploadMedia(sender.config, { bytes, mediaType: png ? "image/png" : "image/jpeg", filename: png ? "broadcast.png" : "broadcast.jpg" });
      mediaId = up.id;
      await withTenant(orgId, (sql) => sql`
        UPDATE broadcasts SET meta_media_id = ${mediaId}, meta_media_at = ${now}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${b.id}`);
    } catch (e) {
      console.warn(`broadcast ${b.id}: picture upload failed,`, (e instanceof Error ? e.message : String(e)).slice(0, 300));
      await release(orgId, b.id);
      return out;
    }
  }

  const recipients = await withTenant(orgId, (sql) => sql<RecipientRow[]>`
    SELECT r.id, r.lead_id, r.voice, l.name, l.phone, l.language,
      EXISTS (SELECT 1 FROM call_suppressions s WHERE s.org_id = l.org_id AND s.phone = l.phone) AS opted_out,
      coalesce((SELECT NOT o.resumed FROM message_opt_outs o
                WHERE o.org_id = l.org_id AND o.phone = l.phone ORDER BY o.created_at DESC LIMIT 1), false) AS marketing_stopped,
      EXISTS (SELECT 1 FROM lead_consents c
              WHERE c.org_id = l.org_id AND c.phone = l.phone AND 'whatsapp' = ANY(c.channels)
                AND c.captured_at <= ${now} AND (c.expires_at IS NULL OR c.expires_at > ${now})) AS consent,
      (SELECT count(*) FROM messages m
        WHERE m.org_id = l.org_id AND m.phone = l.phone AND m.direction = 'OUT' AND m.broadcast_id IS NOT NULL
          AND m.status NOT IN ('REFUSED', 'FAILED') AND m.created_at > ${new Date(now.getTime() - 7 * 86_400_000)})::int AS b7,
      (SELECT count(*) FROM messages m
        WHERE m.org_id = l.org_id AND m.phone = l.phone AND m.direction = 'OUT' AND m.purpose = ANY(${[...PROMOTIONAL_PURPOSES]})
          AND m.status NOT IN ('REFUSED', 'FAILED') AND m.created_at > ${new Date(now.getTime() - 30 * 86_400_000)})::int AS m30
    FROM broadcast_recipients r JOIN leads l ON l.id = r.lead_id
    WHERE r.org_id = ${orgId} AND r.broadcast_id = ${b.id} AND r.status = 'WAITING'
    ORDER BY r.id
    LIMIT ${room}`);

  for (const r of recipients) {
    const template = wordingFor(b.id, r.voice, (name) => sender.approved(name, "en"));
    const refusal = firstRefusal({
      OPTED_OUT: r.opted_out,
      MARKETING_STOPPED: r.marketing_stopped,
      OUTSIDE_HOURS: !inBroadcastHours(nowIso),
      NO_CONSENT: !r.consent,
      CAP_7D: r.b7 >= CAP_BROADCASTS_7D,
      CAP_30D: r.m30 >= CAP_MARKETING_30D,
      NOT_APPROVED: !template,
    });
    const first = r.name.split(/\s+/)[0];
    const values = fill(template ?? BROADCAST_TEMPLATES[0], {
      first_name: first && first !== "Buyer" ? first : FILL_INS[r.voice].firstName,
      project: post.project,
      ad_line: b.line,
    });
    const body = template ? render(template, values) : b.line;
    let credit: Awaited<ReturnType<typeof messageAllowed>> | null = null;
    if (!refusal) credit = await messageAllowed(orgId, b.scope_node_id, PRICE_PAISE.MARKETING);
    const why = refusal ?? (credit && !credit.ok ? ("NO_CREDIT" as const) : null);

    // A row before a request, and the recipient pointing at it in the same
    // transaction: a recipient with a message is never sent to again.
    const messageId = await withTenant(orgId, async (sql) => {
      const [m] = await sql<{ id: string }[]>`
        INSERT INTO messages (org_id, lead_id, direction, channel, purpose, template, category, language, variables, body,
                              phone, status, error, cost_paise, number_id, broadcast_id)
        VALUES (${orgId}, ${r.lead_id}, 'OUT', 'WHATSAPP', 'BROADCAST', ${template?.name ?? null}, 'MARKETING', 'en',
                ${sql.json(values)}, ${body.slice(0, 4096)}, ${r.phone}, ${why ? "REFUSED" : "QUEUED"},
                ${why ? REFUSAL_WORDS[why] : null}, ${why ? null : PRICE_PAISE.MARKETING}, ${sender.numberId}, ${b.id})
        RETURNING id`;
      await sql`
        UPDATE broadcast_recipients SET status = ${why ? "REFUSED" : "SENT"}, refusal = ${why}, message_id = ${m.id}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${r.id} AND status = 'WAITING'`;
      return m.id;
    });
    if (why) {
      out.refused += 1;
      continue;
    }
    try {
      const { id } = await whatsapp().sendTemplate(sender.config, {
        to: r.phone,
        template: template!.name,
        language: "en",
        params: values,
        callbackData: `${orgId}:${messageId}`,
        headerImage: { id: mediaId! },
        buttons: [`${STOP_PAYLOAD}:${b.id}`],
      });
      await withTenant(orgId, (sql) => sql`
        UPDATE messages SET status = 'SENT', provider_id = ${id}, sent_at = now()
        WHERE org_id = ${orgId} AND id = ${messageId}`);
      out.sent += 1;
    } catch (e) {
      const said = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      console.warn(`broadcast ${b.id}: send failed for message ${messageId},`, said);
      // Meta not answering is not Meta refusing: the message may have gone.
      // It stays QUEUED, its receipt (which names this row) moves it on, and
      // the recipient is never sent to again.
      if (/did not answer|timeout/i.test(said)) {
        out.sent += 1;
        continue;
      }
      await withTenant(orgId, async (sql) => {
        await sql`
          UPDATE messages SET status = 'FAILED', error = 'WhatsApp did not accept this message. It was not sent.', cost_paise = NULL
          WHERE org_id = ${orgId} AND id = ${messageId}`;
        await sql`
          UPDATE broadcast_recipients SET status = 'FAILED', updated_at = now()
          WHERE org_id = ${orgId} AND id = ${r.id}`;
      });
      out.failed += 1;
    }
  }

  const [left] = await withTenant(orgId, (sql) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM broadcast_recipients WHERE org_id = ${orgId} AND broadcast_id = ${b.id} AND status = 'WAITING'`);
  await withTenant(orgId, (sql) => sql`
    UPDATE broadcasts SET
      status = CASE WHEN ${left?.n ?? 0} = 0 AND status = 'SENDING' THEN 'DONE' ELSE status END,
      finished_at = CASE WHEN ${left?.n ?? 0} = 0 THEN coalesce(finished_at, now()) ELSE finished_at END,
      lease_until = NULL, lease_holder = NULL, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${b.id}`);
  if (!left?.n) {
    await audit({
      orgId,
      actorUserId: null,
      action: "broadcast.done",
      targetType: "broadcast",
      targetId: b.id,
      metadata: { sent: out.sent, refused: out.refused, failed: out.failed },
    });
  }
  return out;
}

/** A refusal as the lead's history says it. */
export const REFUSAL_WORDS: Record<Gate, string> = {
  NOT_ADVERTISABLE: "The project cannot be advertised today, so this broadcast was not sent.",
  POST: "The post no longer clears its checks, so this broadcast was not sent.",
  OPTED_OUT: "This number asked not to be contacted.",
  MARKETING_STOPPED: "This buyer stopped promotions.",
  OUTSIDE_HOURS: "Promotional messages go out between 10 am and 9 pm.",
  NO_CONSENT: "No WhatsApp consent on file for promotional messages.",
  CAP_7D: "This buyer already had a broadcast this week.",
  CAP_30D: "This buyer already had four promotional messages this month.",
  DND: "This number is on the DND register.",
  NOT_APPROVED: "Meta hasn't approved the broadcast message in this buyer's language yet.",
  NO_CREDIT: "There is no WhatsApp credit left for this message.",
};

// ---------------------------------------------------------------------------
// Reading, for the screens
// ---------------------------------------------------------------------------

export type BroadcastView = {
  id: string;
  status: BroadcastStatus;
  nodeName: string;
  /** Where the keys are asked: approving, stopping. */
  nodePath: string;
  line: string;
  audience: number;
  estimatePaise: number;
  createdAt: string;
  approvedAt: string | null;
  haltedReason: string | null;
  counts: { waiting: number; sent: number; delivered: number; read: number; replied: number; refused: number; failed: number };
  postId: string | null;
  mediaKey: string;
};

/** The broadcasts under the viewer's reach, newest first, with what became of each. */
export async function listBroadcasts(orgId: string, scopes: readonly string[], limit = 50): Promise<BroadcastView[]> {
  if (!scopes.length) return [];
  const rows = await withTenant(orgId, (sql) => sql<
    {
      id: string;
      status: BroadcastStatus;
      node_name: string;
      node_path: string;
      line: string;
      audience: number;
      estimate_paise: number;
      created_at: Date;
      approved_at: Date | null;
      halted_reason: string | null;
      rendered_post_id: string | null;
      media_key: string;
      waiting: number;
      sent: number;
      delivered: number;
      read: number;
      replied: number;
      refused: number;
      failed: number;
    }[]
  >`
    SELECT b.id, b.status, n.name AS node_name, n.path::text AS node_path, b.line, b.audience, b.estimate_paise, b.created_at, b.approved_at,
           b.halted_reason, b.rendered_post_id, b.media_key,
           count(r.id) FILTER (WHERE r.status = 'WAITING')::int AS waiting,
           count(r.id) FILTER (WHERE r.status = 'SENT')::int AS sent,
           count(m.id) FILTER (WHERE m.status IN ('DELIVERED', 'READ'))::int AS delivered,
           count(m.id) FILTER (WHERE m.status = 'READ')::int AS read,
           count(m.id) FILTER (WHERE EXISTS (
             SELECT 1 FROM messages i WHERE i.org_id = b.org_id AND i.direction = 'IN' AND i.phone = m.phone
               AND i.created_at > m.created_at AND i.created_at < m.created_at + interval '3 days'))::int AS replied,
           count(r.id) FILTER (WHERE r.status IN ('REFUSED', 'CANCELLED'))::int AS refused,
           count(m.id) FILTER (WHERE m.status = 'FAILED')::int AS failed
    FROM broadcasts b
    JOIN scope_nodes n ON n.id = b.scope_node_id
    LEFT JOIN broadcast_recipients r ON r.broadcast_id = b.id
    LEFT JOIN messages m ON m.id = r.message_id AND m.status <> 'REFUSED'
    WHERE b.org_id = ${orgId} AND n.path <@ ANY(${[...scopes]}::ltree[])
    GROUP BY b.id, n.name, n.path
    ORDER BY b.created_at DESC
    LIMIT ${limit}`);
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    nodeName: r.node_name,
    nodePath: r.node_path,
    line: r.line,
    audience: r.audience,
    estimatePaise: r.estimate_paise,
    createdAt: r.created_at.toISOString(),
    approvedAt: r.approved_at?.toISOString() ?? null,
    haltedReason: r.halted_reason,
    counts: { waiting: r.waiting, sent: r.sent, delivered: r.delivered, read: r.read, replied: r.replied, refused: r.refused, failed: r.failed },
    postId: r.rendered_post_id,
    mediaKey: r.media_key,
  }));
}

// ---------------------------------------------------------------------------
// A buyer stopping promotions
// ---------------------------------------------------------------------------

/**
 * Record a marketing stop (a tap on "Stop promotions", WhatsApp's own
 * setting) or its lifting. Append-only; the newest row per number stands.
 * Visit reminders and the rest of what a buyer started still go.
 */
export async function recordMarketingStop(o: {
  orgId: string;
  phone: string;
  source: "BUTTON" | "META_PREFERENCE" | "PERSON";
  resumed?: boolean;
  userId?: string | null;
}): Promise<void> {
  await withTenant(o.orgId, (sql) => sql`
    INSERT INTO message_opt_outs (org_id, phone, source, resumed, created_by)
    VALUES (${o.orgId}, ${o.phone}, ${o.source}, ${o.resumed ?? false}, ${o.userId ?? null})`);
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId ?? null,
    action: o.resumed ? "message.marketing_resumed" : "message.marketing_stopped",
    targetType: "org",
    targetId: o.orgId,
    metadata: { source: o.source },
  });
}

/** Whether a number stopped promotions and has not resumed them. */
export async function marketingStopped(orgId: string, phone: string): Promise<boolean> {
  const [r] = await withTenant(orgId, (sql) => sql<{ resumed: boolean }[]>`
    SELECT resumed FROM message_opt_outs WHERE org_id = ${orgId} AND phone = ${phone}
    ORDER BY created_at DESC LIMIT 1`);
  return !!r && !r.resumed;
}

/** Promotions to a number in the last 30 days, broadcasts and the drip together. */
export async function marketingSent30d(orgId: string, phone: string, now = new Date()): Promise<number> {
  const [r] = await withTenant(orgId, (sql) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM messages
    WHERE org_id = ${orgId} AND phone = ${phone} AND direction = 'OUT' AND purpose = ANY(${[...PROMOTIONAL_PURPOSES]})
      AND status NOT IN ('REFUSED', 'FAILED') AND created_at > ${new Date(now.getTime() - 30 * 86_400_000)}`);
  return r?.n ?? 0;
}
