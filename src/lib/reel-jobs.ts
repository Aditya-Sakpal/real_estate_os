import { withTenant } from "./db/index.ts";
import { makeReel } from "./reel-worker.ts";
import { makeFilm, type FilmDrivers, type FilmPlan } from "./film.ts";
import { STORY_TEMPLATE } from "./reel-choice.ts";

/**
 * The story reel worker's side of a job: claim it under a lease, make the
 * reel with its progress on the row, and finish it DONE or FAILED. Kept out
 * of `reel.ts` so the pages, which only queue and read jobs, never pull in
 * Remotion, its bundler or a browser.
 *
 * Imports are relative because the worker runs this straight from source.
 */

/** How long a claimed job is held without a word from its worker. */
const LEASE_MS = 15 * 60_000;

/**
 * Make one job's reel, if it can be claimed. The lease is taken in the
 * WHERE clause, so two workers resolve in the database, and renewed at every
 * stage, so a slow reel is never taken from a worker that is still on it.
 */
export async function runReelJob(
  orgId: string,
  jobId: string,
  /** Injected by the checks, so a suite never pays for a reel. */
  drivers?: Parameters<typeof makeReel>[0]["drivers"],
  /** The same, for a film made in one generation (an agent on camera). */
  filmDrivers?: Partial<FilmDrivers>,
): Promise<{ ok: boolean; message: string }> {
  const claimed = await withTenant(orgId, async (sql) => {
    const [row] = await sql<{
      id: string;
      brief_id: string;
      copy_id: string;
      placement: string;
      format: "story" | "presenter";
      created_by: string | null;
      plan: { scratch?: string; script?: unknown; music?: unknown; spend?: unknown; agent?: unknown; font?: string } | null;
    }[]>`
      UPDATE reel_jobs
      SET state = 'RUNNING', lease_until = now() + ${`${LEASE_MS / 1000} seconds`}::interval,
          attempts = attempts + 1, stage = 'Starting', updated_at = now()
      WHERE org_id = ${orgId} AND id = ${jobId} AND cancelled_at IS NULL AND attempts < 3
        AND (state = 'QUEUED' OR (state = 'RUNNING' AND lease_until < now()))
      RETURNING id, brief_id, copy_id, placement, format, created_by, plan`;
    return row ?? null;
  });
  if (!claimed) return { ok: false, message: "Not claimable." };

  const recent = await withTenant(orgId, async (sql) =>
    sql<{ file: string }[]>`
      SELECT plan->'music'->>'file' AS file FROM reel_jobs
      WHERE org_id = ${orgId} AND plan->'music'->>'file' IS NOT NULL
      ORDER BY created_at DESC LIMIT 6`,
  );

  const controller = new AbortController();
  // The plan goes on the row at every stage, not only at the end: a worker
  // that dies mid-reel then leaves the folder, the script and what was spent
  // for "Try again" to pick up.
  const onStage = async (stage: string, progress: number, plan: unknown) => {
    const [row] = await withTenant(orgId, async (sql) =>
      sql<{ cancelled: boolean }[]>`
        UPDATE reel_jobs
        SET stage = ${stage}, progress = ${Math.min(99, Math.max(0, Math.round(progress)))},
            plan = ${sql.json(plan as never)},
            lease_until = now() + ${`${LEASE_MS / 1000} seconds`}::interval, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${jobId}
        RETURNING cancelled_at IS NOT NULL AS cancelled`,
    );
    if (row?.cancelled) controller.abort();
  };

  let outcome: Awaited<ReturnType<typeof makeReel>> | Awaited<ReturnType<typeof makeFilm>>;
  try {
    // An agent on camera is one film from the skill, not the director's
    // stitched shots: the client chose that on 26 September 2026.
    // Every video is one film since 5 October 2026: a story queued before
    // that is made as the narrated story's film, from scratch.
    outcome = claimed.format === "presenter" || claimed.format === "story"
      ? await makeFilm({
          orgId,
          actorUserId: claimed.created_by ?? "",
          briefId: claimed.brief_id,
          copyId: claimed.copy_id,
          placement: claimed.placement,
          font: claimed.plan?.font ?? null,
          plan: (claimed.format === "story"
            ? { template: STORY_TEMPLATE.key, ...(claimed.plan?.font ? { font: claimed.plan.font } : {}) }
            : claimed.plan ?? null) as Partial<FilmPlan> | null,
          drivers: filmDrivers,
          signal: controller.signal,
          onStage,
        })
      : await makeReel({
      orgId,
      actorUserId: claimed.created_by ?? "",
      briefId: claimed.brief_id,
      copyId: claimed.copy_id,
      placement: claimed.placement,
      format: claimed.format,
      // The face chosen when it was queued, kept on the plan through every stage.
      font: claimed.plan?.font ?? null,
      signal: controller.signal,
      onStage,
      recentTracks: recent.map((r) => r.file).filter(Boolean),
      drivers,
      // A job tried again picks up from the folder its last attempt kept.
      resume:
        claimed.plan?.scratch && claimed.plan.script
          ? {
              dir: claimed.plan.scratch,
              script: claimed.plan.script as never,
              music: claimed.plan.music as never,
              spend: claimed.plan.spend as never,
              agent: (claimed.plan.agent ?? null) as never,
            }
          : null,
    });
  } catch (e) {
    console.error("reel: the job failed", e);
    outcome = { ok: false, code: "FAILED", message: "The video could not be made. Try again." };
  }
  const stopped = controller.signal.aborted;
  // A film stopped while it was being made is still made, and paid for;
  // "Try again" collects it, so the card says so.
  const filming = stopped && !outcome.ok && !!(outcome.plan as { film?: { job?: unknown } } | undefined)?.film?.job;
  await withTenant(orgId, async (sql) => {
    await sql`
      UPDATE reel_jobs
      SET state = ${outcome.ok ? "DONE" : stopped ? "STOPPED" : "FAILED"},
          stage = ${outcome.ok ? "Done" : stopped ? "Stopped" : "Not made"},
          progress = ${outcome.ok ? 100 : 0},
          message = ${outcome.ok
            ? null
            : filming
              ? "Stopped while the video was being made. It is still being made and paid for; Try again collects it."
              : stopped
                ? "Stopped."
                : outcome.message},
          post_id = ${outcome.ok ? outcome.postId : null},
          plan = ${sql.json(("plan" in outcome && outcome.plan ? outcome.plan : null) as never)},
          lease_until = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${jobId}`;
  });
  return { ok: outcome.ok, message: outcome.ok ? "Made." : outcome.message };
}

/**
 * One pass of the reel worker over the tenants it is given: each one's due
 * jobs, one after another, a bounded number. Which tenants exist is the
 * caller's to say (`scripts/reel-run.mts`), so nothing here reads across
 * them.
 */
export async function runReels(opts: { orgIds: string[]; max?: number }): Promise<number> {
  let made = 0;
  let budget = opts.max ?? 2;
  for (const orgId of opts.orgIds) {
    const due = await withTenant(orgId, async (sql) =>
      sql<{ id: string }[]>`
        SELECT id FROM reel_jobs
        WHERE org_id = ${orgId} AND cancelled_at IS NULL AND attempts < 2
          AND (state = 'QUEUED' OR (state = 'RUNNING' AND lease_until < now()))
        ORDER BY created_at LIMIT 5`,
    );
    for (const job of due) {
      if (budget-- <= 0) return made;
      const r = await runReelJob(orgId, job.id);
      if (r.ok) made++;
    }
  }
  return made;
}
