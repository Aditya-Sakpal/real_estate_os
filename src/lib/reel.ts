import { spawn } from "node:child_process";
import { LANGUAGES } from "./campaign-rules.ts";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTenant, audit } from "./db/index.ts";
import { limitsLifted } from "./plan-purchase-rules.ts";
import { isNodeId } from "./scope-rules.ts";
import { PLACEMENT_SIZE, placementsFor } from "./compose-rules.ts";
import { MAX_LIVE_STORIES, PRESENTER_TEMPLATE, STORY_TEMPLATE } from "./reel-rules.ts";
import { materialFor, studioGround } from "./creative.ts";
import { angleLabel, cardFits, cardLead, invitesVisit, isCardAngle, templateAngle, templateGap } from "./card-angle-rules.ts";
import { NO_LOCATION_MESSAGE } from "./creative-rules.ts";
import { firmAgentFor } from "./firm-agent.ts";
import { fontFor } from "./font-rules.ts";
import { FILM_UNITS, MAX_NOTE_CHARS, noteProblems, skillFor } from "./film-rules.ts";
import { entitle } from "./billing.ts";
import { AUTO_FILM, chooseFilmTemplate } from "./film-choice.ts";
import { filmGaps } from "./film.ts";
import { adPrice, isLuxury, sellingPoints } from "./creative-rules.ts";

/**
 * Story reel jobs: queued by the studio, made by a worker, read back by the
 * screen for their progress.
 *
 * A reel takes twenty to forty minutes, so it is never made inside a
 * request. The studio writes a QUEUED row; a worker claims it under a lease
 * (`npm run reel:run`, or the pass `post:run` makes), reports each stage on
 * the row, and ends it DONE with the post it made or FAILED with a reason in
 * the client's words. Locally the studio also starts a worker for the job at
 * once, so nobody has to run one by hand while trying the product.
 *
 * Imports are relative because the worker loads this straight from source.
 */

export type ReelJobView = {
  id: string;
  copyId: string;
  placement: string;
  /** A narrated story, or a film from a template's own skill. */
  format: "story" | "presenter";
  /** The video template a film is made from, for its label; null for a story or a film queued before templates had skills. */
  template: string | null;
  state: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "STOPPED";
  stage: string;
  progress: number;
  message: string | null;
  postId: string | null;
  /** A new version of an earlier film, which counts as two videos. */
  revision: boolean;
  createdAt: string;
};


export async function enqueueReel(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  copyId: string;
  placement: string;
  /** Which film is made. A narrated story unless said; "presenter" is a film from a template's own skill. */
  format?: "story" | "presenter";
  /** The video template whose skill makes the film; Agent on camera when none is named, chosen here when "auto". */
  template?: string | null;
  /** A face from `font-rules.ts` for the captions and cards; anything else is ours. */
  font?: string | null;
}): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  // Every video is one Seedance film from its own skill since 5 October 2026
  // (the client): a narrated story included, which the director used to
  // stitch from Kling clips and a voice read line by line. Its jobs are films.
  const format = "presenter" as const;
  // "Let AI choose" names no template: the film is chosen below, once the
  // card and the project are read.
  const auto = opts.format === "presenter" && opts.template === AUTO_FILM;
  const asked = opts.format === "presenter" ? opts.template ?? PRESENTER_TEMPLATE.key : STORY_TEMPLATE.key;
  let skill = auto ? null : skillFor(asked);
  if (!auto && !skill) return { ok: false, message: "That video template is not made as a film." };
  // A format that is never made says why before anything is queued; one
  // that needs certain pictures is asked again by the worker, before paying.
  if (skill?.needs && !skill.needs.categories.length) return { ok: false, message: skill.needs.why };
  if (!isNodeId(opts.briefId) || !isNodeId(opts.copyId)) return { ok: false, message: "That card is not in this campaign." };
  const size = PLACEMENT_SIZE[opts.placement];
  if (!size) return { ok: false, message: "That is not a video size." };
  const found = await withTenant(opts.orgId, async (sql) => {
    const [brief] = await sql<{ formats: string[]; offers: string | null; objective: string | null; hook: string | null; name: string | null; node_id: string; path: string; kind: string }[]>`
      SELECT b.formats, b.offers, b.objective, b.hook, b.name, n.id AS node_id, n.path::text AS path, n.kind
      FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${opts.orgId} AND b.id = ${opts.briefId}`;
    const [card] = await sql<{ id: string; segment: string; angle: string | null; headline: string; body: string; cta: string }[]>`
      SELECT id, segment, angle, headline, body, cta FROM campaign_copy
      WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId} AND id = ${opts.copyId} AND verdict = 'PASS'
        AND language IN (SELECT unnest(cb.languages) FROM campaign_briefs cb WHERE cb.id = campaign_copy.brief_id)
        AND language = ANY(${[...LANGUAGES]}::text[])`;
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reel_jobs
      WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId} AND state IN ('QUEUED', 'RUNNING')`;
    return { brief: brief ?? null, card: card ?? null, live: n };
  });
  if (!found.brief) return { ok: false, message: "That campaign is not in this organisation." };
  if (!found.card) return { ok: false, message: "That card is no longer cleared." };
  if (!placementsFor("VIDEO", found.brief.formats ?? []).includes(opts.placement)) {
    return { ok: false, message: `${opts.placement} is not a size this brief asked for.` };
  }
  // Said now rather than half an hour from now: every ad names the exact
  // locality, and a reel queued without one would only fail in the worker.
  const { ground } = await studioGround(opts.orgId, { id: found.brief.node_id, path: found.brief.path, kind: found.brief.kind });
  if (!ground.location) return { ok: false, message: NO_LOCATION_MESSAGE };
  // The film's template and the card have to suit each other, and the project
  // has to hold what the template shows, before a job is queued.
  const material = await materialFor(opts.orgId, found.brief.node_id, ground, found.brief.offers);
  if (!skill) {
    const chosen = await chooseFilmTemplate({
        orgId: opts.orgId,
        node: { id: found.brief.node_id, path: found.brief.path, kind: found.brief.kind },
        card: found.card,
        ground,
        material,
        context: {
          objective: found.brief.objective,
          hook: found.brief.hook,
          offers: found.brief.offers,
          placement: opts.placement,
          campaign: found.brief.name,
        },
      });
    skill = chosen ? skillFor(chosen) : null;
    if (!skill) return { ok: false, message: "No video goes with this card. Use a card that sells the project." };
  }
  const key = skill.key;
  const lacks = templateGap("VIDEO", key, material);
  if (lacks) return { ok: false, message: `${lacks}.` };
  // What the skill needs (three dated site photos, not one) is asked here too,
  // as the studio's tile asks it: a stale tab queued a job the worker refused.
  if (skill.needs) {
    const gaps = await filmGaps(opts.orgId, { id: found.brief.node_id, path: found.brief.path, kind: found.brief.kind }, [key]);
    if (gaps[key]) return { ok: false, message: gaps[key] };
  }
  const angle = isCardAngle(found.card.angle) ? found.card.angle : "GENERAL";
  if (!cardFits({ angle, segment: found.card.segment, lead: cardLead(found.card, ground), invites: invitesVisit(found.card.cta) }, templateAngle("VIDEO", key), key)) {
    return { ok: false, message: `This card is written for ${angleLabel(angle).toLowerCase()} ads. Pick a card written for this video.` };
  }
  const agent = await firmAgentFor(opts.orgId);
  if (!agent.ok) return { ok: false, message: agent.message };
  if (!limitsLifted() && found.live >= MAX_LIVE_STORIES) {
    return { ok: false, message: `${MAX_LIVE_STORIES} videos are already being made for this campaign. Wait for one to finish.` };
  }
  // Every kind of video is one video against the plan, asked before the job is queued.
  const entitled = await entitle({ orgId: opts.orgId, nodeId: found.brief.node_id, needs: [{ unit: "VIDEO", qty: FILM_UNITS.first }] });
  if (!entitled.ok) return { ok: false, message: entitled.message };
  const face = fontFor(opts.font);
  // A film records what it counts as from the moment it is asked for.
  const plan = { engine: "film", template: skill.key, units: FILM_UNITS.first, ...(face ? { font: face.key } : {}) };
  const [job] = await withTenant(opts.orgId, async (sql) =>
    sql<{ id: string }[]>`
      INSERT INTO reel_jobs (org_id, brief_id, copy_id, placement, format, created_by, plan)
      VALUES (${opts.orgId}, ${opts.briefId}, ${opts.copyId}, ${opts.placement}, ${format}, ${opts.actorUserId},
              ${sql.json(plan)})
      RETURNING id`,
  );
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "creative.reel_queued",
    targetType: "campaign_brief",
    targetId: opts.briefId,
    metadata: { placement: opts.placement, format, template: skill.key },
  });
  return { ok: true, jobId: job.id };
}

/** The reels a brief has in hand or just finished, newest first. */
export async function listReels(orgId: string, briefId: string): Promise<ReelJobView[]> {
  if (!isNodeId(briefId)) return [];
  const rows = await withTenant(orgId, async (sql) =>
    sql<{
      id: string;
      copy_id: string;
      placement: string;
      format: ReelJobView["format"];
      state: ReelJobView["state"];
      stage: string;
      progress: number;
      message: string | null;
      post_id: string | null;
      revision: boolean;
      template: string | null;
      created_at: Date;
    }[]>`
      SELECT id, copy_id, placement, format, state, stage, progress, message, post_id,
             (plan -> 'revise') IS NOT NULL AND jsonb_typeof(plan -> 'revise') = 'object' AS revision, plan ->> 'template' AS template, created_at
      FROM reel_jobs
      WHERE org_id = ${orgId} AND brief_id = ${briefId}
        AND (state IN ('QUEUED', 'RUNNING') OR (updated_at > now() - interval '1 day' AND dismissed_at IS NULL))
      ORDER BY created_at DESC
      LIMIT 20`,
  );
  return rows.map((r) => ({
    id: r.id,
    copyId: r.copy_id,
    placement: r.placement,
    format: r.format,
    template: r.template,
    state: r.state,
    stage: r.stage,
    progress: r.progress,
    message: r.message,
    postId: r.post_id,
    revision: r.revision,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * A new version of a film, asked for by a person: the film is sent back in as
 * the starting point with their note, so it is processed twice and counts as
 * two videos. The product never asks for one itself.
 *
 * The note goes to the video model, so it is held to the rules any other
 * instruction is: no building changed, no never-say phrase, no number the
 * facts do not carry. Said now, so the person can reword it, rather than half
 * an hour from now.
 */
export async function reviseFilm(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  postId: string;
  note: string;
}): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  if (!isNodeId(opts.briefId) || !isNodeId(opts.postId)) return { ok: false, message: "That video is not in this campaign." };
  const note = String(opts.note ?? "").replace(/\s+/g, " ").trim();
  if (note.length > MAX_NOTE_CHARS) return { ok: false, message: `Keep the note under ${MAX_NOTE_CHARS} characters.` };
  const found = await withTenant(opts.orgId, async (sql) => {
    const [post] = await sql<{ copy_id: string; placement: string; node_id: string; path: string; kind: string; raw: string | null; font: string | null; template: string | null }[]>`
      SELECT p.copy_id, p.placement, n.id AS node_id, n.path::text AS path, n.kind,
             p.inputs -> 'film' ->> 'raw' AS raw, p.inputs ->> 'font' AS font, p.inputs -> 'film' ->> 'skill' AS template
      FROM rendered_posts p JOIN scope_nodes n ON n.id = p.scope_node_id
      WHERE p.org_id = ${opts.orgId} AND p.id = ${opts.postId} AND p.brief_id = ${opts.briefId} AND p.inputs ? 'film'`;
    const [card] = post
      ? await sql<{ headline: string; body: string; cta: string }[]>`
          SELECT headline, body, cta FROM campaign_copy
          WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId} AND id = ${post.copy_id} AND verdict = 'PASS'`
      : [];
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reel_jobs
      WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId} AND state IN ('QUEUED', 'RUNNING')`;
    return { post: post ?? null, card: card ?? null, live: n };
  });
  if (!found.post) return { ok: false, message: "That video can no longer be made again." };
  if (!found.post.raw) return { ok: false, message: "That video was made before new versions were possible. Make a new one instead." };
  if (!found.card) return { ok: false, message: "The card this video was made from is no longer cleared." };
  if (!limitsLifted() && found.live >= MAX_LIVE_STORIES) {
    return { ok: false, message: `${MAX_LIVE_STORIES} videos are already being made for this campaign. Wait for one to finish.` };
  }
  const { ground } = await studioGround(opts.orgId, { id: found.post.node_id, path: found.post.path, kind: found.post.kind });
  if (!ground.advertisable) return { ok: false, message: "This cannot be advertised today, so no video can be made." };
  const cleared = [
    found.card.headline,
    found.card.body,
    found.card.cta,
    ground.location ?? "",
    ...sellingPoints(ground.talkingPoints, { luxury: isLuxury(ground.configurations) }),
    ...ground.configurations.filter((c) => c.startingPrice !== null).map((c) => `${c.label} starting ${adPrice(c.startingPrice!)}`),
  ];
  const problems = noteProblems(note, cleared, ground.neverSay);
  if (problems.length) return { ok: false, message: problems[0] };
  // A new version counts as two videos, and both have to be there before it is asked for.
  const entitled = await entitle({ orgId: opts.orgId, nodeId: found.post.node_id, needs: [{ unit: "VIDEO", qty: FILM_UNITS.revision }] });
  if (!entitled.ok) return { ok: false, message: entitled.message };
  const plan = {
    engine: "film",
    // The same template's skill makes the new version.
    ...(found.post.template && skillFor(found.post.template) ? { template: found.post.template } : {}),
    units: FILM_UNITS.revision,
    revise: { postId: opts.postId, note },
    ...(fontFor(found.post.font) ? { font: fontFor(found.post.font)!.key } : {}),
  };
  const [job] = await withTenant(opts.orgId, async (sql) =>
    sql<{ id: string }[]>`
      INSERT INTO reel_jobs (org_id, brief_id, copy_id, placement, format, created_by, plan)
      VALUES (${opts.orgId}, ${opts.briefId}, ${found.post!.copy_id}, ${found.post!.placement}, 'presenter', ${opts.actorUserId}, ${sql.json(plan)})
      RETURNING id`,
  );
  // Codes and counts only: the note is free text somebody typed.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "creative.reel_queued",
    targetType: "rendered_post",
    targetId: opts.postId,
    metadata: { format: "presenter", revision: true, units: FILM_UNITS.revision, note: note.length > 0 },
  });
  return { ok: true, jobId: job.id };
}

/**
 * Try a failed or stopped reel again. It is queued as the same job, so the
 * worker picks up from what the last attempt kept: the script, the voice
 * and the clips already paid for are used again.
 */
export async function retryReel(orgId: string, jobId: string, actorUserId: string): Promise<boolean> {
  if (!isNodeId(jobId)) return false;
  const [row] = await withTenant(orgId, async (sql) =>
    sql<{ id: string }[]>`
      UPDATE reel_jobs
      -- A person pressing Try again is a decision, so the worker's three tries
      -- start again: counted against them, a job stopped or refused three
      -- times could never be tried again and the button silently did nothing
      -- (7 October 2026). What was paid for stays capped on the plan.
      SET state = 'QUEUED', stage = 'Waiting to start', progress = 0, message = NULL, attempts = 0,
          cancelled_at = NULL, lease_until = NULL, dismissed_at = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${jobId} AND state IN ('FAILED', 'STOPPED')
        -- A stitched story from before every video was a film is made again, never tried again.
        AND format = 'presenter'
      RETURNING id`,
  );
  if (row) {
    await audit({ orgId, actorUserId, action: "creative.reel_retried", targetType: "reel_job", targetId: jobId, metadata: {} });
  }
  return !!row;
}

/**
 * Put away a stopped, failed or finished video's card. It stays away on the
 * next load; the job and what it kept are untouched, so nothing paid for is
 * lost. A video still being made cannot be dismissed, only stopped.
 */
export async function dismissReel(orgId: string, jobId: string): Promise<boolean> {
  if (!isNodeId(jobId)) return false;
  const [row] = await withTenant(orgId, async (sql) =>
    sql<{ id: string }[]>`
      UPDATE reel_jobs SET dismissed_at = now()
      WHERE org_id = ${orgId} AND id = ${jobId} AND state IN ('FAILED', 'STOPPED', 'DONE') AND dismissed_at IS NULL
      RETURNING id`,
  );
  return !!row;
}

/** Stop a reel. One still queued never starts; one running stops at its next stage. */
export async function stopReel(orgId: string, jobId: string, actorUserId: string): Promise<boolean> {
  if (!isNodeId(jobId)) return false;
  const [row] = await withTenant(orgId, async (sql) =>
    sql<{ id: string }[]>`
      UPDATE reel_jobs
      SET cancelled_at = now(), updated_at = now(),
          state = CASE WHEN state = 'QUEUED' THEN 'STOPPED' ELSE state END,
          stage = CASE WHEN state = 'QUEUED' THEN 'Stopped' ELSE 'Stopping' END
      WHERE org_id = ${orgId} AND id = ${jobId} AND state IN ('QUEUED', 'RUNNING')
      RETURNING id`,
  );
  if (row) {
    await audit({ orgId, actorUserId, action: "creative.reel_stopped", targetType: "reel_job", targetId: jobId, metadata: {} });
  }
  return !!row;
}

/**
 * Start a worker for one job at once, detached from the request. Off in a
 * hosted deployment, where the scheduled worker picks the job up instead;
 * a function that spawned a long-lived child would be killed with it.
 */
export function startReelWorker(orgId: string, jobId: string): void {
  if (process.env.VERCEL || process.env.REEL_WORKER === "scheduled") return;
  const log = openSync(join(tmpdir(), `salesdesk-reel-${jobId}.log`), "a");
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--env-file=.env.local", "scripts/reel-run.mts", "--org", orgId, "--job", jobId],
    { cwd: process.cwd(), detached: true, stdio: ["ignore", log, log], windowsHide: true },
  );
  child.unref();
}
