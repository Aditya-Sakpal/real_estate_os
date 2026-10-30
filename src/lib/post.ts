import { randomUUID } from "node:crypto";
import { activeLanguages } from "./campaign-rules.ts";
import { type JSONValue, type TransactionSql } from "postgres";
import { controlDb, withTenant, audit } from "./db/index.ts";
import { limitsLifted } from "./plan-purchase-rules.ts";
import { isNodeId } from "./scope-rules.ts";
import { resolveBrand } from "./brand.ts";
import { approvedUnits } from "./unit.ts";
import { approvedAssets } from "./asset.ts";
import { loadReadiness } from "./readiness.ts";
import { materialFor, studioGround, instructionFor, writeChecked } from "./creative.ts";
import {
  angleGap,
  cardFits,
  cardLead,
  invitesVisit,
  templateAngle,
  templateGap,
  templateNever,
  isCardAngle,
  type CardAngle,
  type CardMaterial,
} from "./card-angle-rules.ts";
import { writeCopy, COPY_MODEL, type CopyDriver, type ReadDriver } from "./generate.ts";
import {
  adFacts,
  pointsFor,
  storedLocal,
  type LocalLines,
  gateCopy,
  hasSellingPoint,
  isLuxury,
  NO_LOCATION_MESSAGE,
  NO_POINTS_MESSAGE,
  sellingPoints,
  storedGround,
  budgetFor,
  planCopy,
  type AdFacts,
  type Copy,
  type Ground,
  type Reason,
  type Segment,
  type Verdict,
  MAX_COPY_BLOCKS,
  SEGMENTS,
} from "./creative-rules.ts";
import {
  chooseVariation,
  TEMPLATES,
  creativeHash,
  decisionStands,
  emptyInputs,
  entryAt,
  generateAtFor,
  hardStopFor,
  istDate,
  lateness,
  leaseUntil,
  autoProblem,
  modeAllowed,
  AUTO_AVAILABLE,
  offerAllowed,
  pickOccasion,
  releaseFor,
  scheduleFitsNode,
  scheduleGaps,
  slotFits,
  slotsBetween,
  templateDef,
  type CreativeInputs,
  type Mode,
  type Occasion,
  type RecentChoice,
  type RefusalCode,
  type RunState,
  type Schedule,
  type Variation,
  RECENT_DEPTH,
} from "./post-rules.ts";
import {
  daysOf,
  kindUnavailable,
  placementsFor,
  slideCount,
  weekFrom,
  type PostKind,
  type WeekPlan,
} from "./compose-rules.ts";
import { designPost, loadMaterials, pixelContext, storePostFiles, type Drivers, type PixelContext } from "./compose.ts";
import { firmAgentFor } from "./firm-agent.ts";
import { auditPixel, withHashes } from "./pixel.ts";
import { pixelSummary, type PixelRecord } from "./pixel-rules.ts";
import { entitle, meterPost, postNeeds } from "./billing.ts";
import { assetUrl } from "./storage.ts";
import { assetCategories, learningFor } from "./learning.ts";
import { chooseLearnedVariation, knows, seeded, type Blended } from "./learning-rules.ts";
import { SCHEDULE_AD_DESTINATIONS, isAd, isAdGoal, pickScheduleDestinations, type AdGoal, type Destination } from "./connect-rules.ts";
import { BROADCAST_DESTINATION, broadcastCapProblem } from "./broadcast-rules.ts";
import {
  adProblem,
  busiestDay,
  datedOverflow,
  datedTooSoon,
  outletsFrom,
  outletsInUse,
  pickDated,
  pickDayStyles,
  pickStyle,
  pickStyles,
  looseStyles,
  sameStyle,
  writeIn,
  AD_DAYS_DEFAULT,
  type DatedPost,
  type Outlet,
  type PostStyle,
  type Repeat,
  type StyleOptions,
  type StyleSet,
} from "./plan-rules.ts";
import {
  currentTemplateKey,
  festivalIn,
  isDesignTemplate,
  templateCatalog,
  templateFits,
  type Festival,
} from "./template-rules.ts";
import { festivalDay, festivalOf } from "./festival-day-rules.ts";
import { resolveTemplate } from "./templates.ts";
import { FONTS } from "./font-rules.ts";
import { FILM_TEMPLATES, PRESENTER_TEMPLATE } from "./reel-choice.ts";
import { makeFilm, type FilmDrivers } from "./film.ts";
import { chooseFilmTemplate } from "./film-choice.ts";
import { meterVideo } from "./billing.ts";

/**
 * Scheduled posts: reads, writes, and the run.
 *
 * `post-rules.ts` decides; this asks the database and calls the model. The
 * order inside `executeRun()` is the whole design and it is the order
 * `doc/post-generation.md` section 4 gives: refuse on the cheap gates before
 * anything is generated or spent, resolve the signed material, choose what
 * makes this post different from the last one, write, gate, and only then
 * decide what happens to it.
 *
 * Two rules here are not negotiable and both are about spending.
 *
 * A run is identified by its COMPUTED slot, so a scheduler that fires twice
 * inserts one row. The second worker sees a row it did not create and stops.
 *
 * A run is CLAIMED with a lease before any work begins, so two workers that
 * both saw the same due run cannot both call the model for it.
 *
 * Imports are relative because the runner loads this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ScheduleRow = Schedule & {
  id: string;
  briefId: string;
  briefName: string;
  briefStatus: string;
  nodeId: string;
  nodeName: string;
  path: string;
  kind: string;
  stoppedReason: string | null;
  stoppedByName: string | null;
  createdAt: string;
  /** The next publish instant, or null past the end date. */
  nextSlot: string | null;
  runCount: number;
  awaiting: number;
  /** What goes out on each day, Sunday first. */
  dayKinds: WeekPlan;
  /** Where its approved posts are published. Empty means they are downloaded. */
  destinations: Destination[];
  repeat: Repeat;
  dated: DatedPost[];
  /** How each weekday's post goes out, Sunday first. */
  dayOutlets: Outlet[];
  /** Rupees a day for each ad, and how many days each runs. */
  adDailyBudget: number | null;
  adDays: number;
  /** What its Meta ads are for. */
  adGoal: AdGoal;
  /** Whether each approved post is also broadcast on WhatsApp, and to at most how many. */
  broadcast: boolean;
  broadcastCap: number | null;
  /** The schedule's own style for each kind. */
  styles: StyleSet;
  /** A weekday's own style, Sunday first; null takes the schedule's. */
  dayStyles: (PostStyle | null)[];
};

export type ScheduleOutcome =
  | { ok: true; scheduleId: string }
  | { ok: false; code: string; message: string };

type DbSchedule = {
  id: string;
  brief_id: string;
  brief_name: string;
  brief_status: string;
  node_id: string;
  node_name: string;
  path: string;
  kind: string;
  name: string;
  mode: Mode;
  days_of_week: number[];
  at_minute: number;
  lead_minutes: number;
  max_runs_per_day: number;
  starts_on: Date | null;
  ends_on: Date | null;
  active: boolean;
  stopped_reason: string | null;
  stopped_by_name: string | null;
  created_at: Date;
  run_count: number;
  awaiting: number;
  day_kinds: (string | null)[] | null;
  destinations: string[] | null;
  repeat: Repeat;
  dated: unknown;
  day_outlets: (string | null)[] | null;
  ad_daily_budget: number | null;
  ad_days: number;
  ad_goal: string | null;
  broadcast_cap: number | null;
  styles: unknown;
  day_styles: unknown;
};

const asDate = (d: Date | null): string | null =>
  d ? new Date(d).toISOString().slice(0, 10) : null;

function toSchedule(r: DbSchedule, now: Date): ScheduleRow {
  const base: Schedule = {
    name: r.name,
    mode: r.mode,
    daysOfWeek: r.days_of_week ?? [],
    atMinute: r.at_minute,
    leadMinutes: r.lead_minutes,
    maxRunsPerDay: r.max_runs_per_day,
    startsOn: asDate(r.starts_on),
    endsOn: asDate(r.ends_on),
    active: r.active,
    repeat: r.repeat ?? "WEEKLY",
    dated: pickDated(r.dated),
  };
  const [next] = r.active
    ? slotsBetween(base, { from: now, to: new Date(now.getTime() + 370 * 86_400_000) })
    : [];
  return {
    ...base,
    id: r.id,
    briefId: r.brief_id,
    briefName: r.brief_name,
    briefStatus: r.brief_status,
    nodeId: r.node_id,
    nodeName: r.node_name,
    path: r.path,
    kind: r.kind,
    stoppedReason: r.stopped_reason,
    stoppedByName: r.stopped_by_name,
    createdAt: r.created_at.toISOString(),
    nextSlot: next ? next.toISOString() : null,
    runCount: r.run_count,
    awaiting: r.awaiting,
    dayKinds: r.day_kinds
      ? weekFrom(r.day_kinds)
      : Array.from({ length: 7 }, (_, d) => ((r.days_of_week ?? []).includes(d) ? "IMAGE" : null)),
    destinations: pickScheduleDestinations(r.destinations ?? []),
    repeat: base.repeat!,
    dated: base.dated!,
    dayOutlets: outletsFrom(r.day_outlets ?? []),
    adDailyBudget: r.ad_daily_budget,
    adDays: r.ad_days ?? AD_DAYS_DEFAULT,
    adGoal: isAdGoal(r.ad_goal) ? r.ad_goal : "TRAFFIC",
    broadcast: (r.destinations ?? []).includes(BROADCAST_DESTINATION),
    broadcastCap: r.broadcast_cap,
    styles: looseStyles(r.styles),
    dayStyles: pickDayStyles(r.day_styles, r.day_kinds ? weekFrom(r.day_kinds) : []),
  };
}

const SCHEDULE_SELECT = (sql: TransactionSql, orgId: string) => sql`
  SELECT s.id, s.brief_id, b.name AS brief_name, b.status AS brief_status,
         s.scope_node_id AS node_id, n.name AS node_name, n.path::text AS path, n.kind,
         s.name, s.mode, s.days_of_week, s.at_minute, s.lead_minutes,
         s.max_runs_per_day, s.starts_on, s.ends_on, s.active,
         s.stopped_reason, u.name AS stopped_by_name, s.created_at, s.day_kinds, s.destinations,
         s.repeat, s.dated, s.day_outlets, s.ad_daily_budget, s.ad_days, s.ad_goal, s.broadcast_cap,
         s.styles, s.day_styles,
         (SELECT count(*)::int FROM post_runs r
           WHERE r.schedule_id = s.id)                            AS run_count,
         (SELECT count(*)::int FROM post_creatives c
            JOIN post_runs r ON r.id = c.run_id
           WHERE r.schedule_id = s.id AND c.state = 'DRAFT'
             AND c.verdict <> 'FAIL')                             AS awaiting
  FROM post_schedules s
  JOIN campaign_briefs b ON b.id = s.brief_id
  JOIN scope_nodes n     ON n.id = s.scope_node_id
  LEFT JOIN users u      ON u.id = s.stopped_by
  WHERE s.org_id = ${orgId}
`;

/** Every schedule in the tenant, newest first. */
export async function listSchedules(
  orgId: string,
  now = new Date(),
): Promise<ScheduleRow[]> {
  const rows = await withTenant(orgId, async (sql) => {
    return sql<DbSchedule[]>`${SCHEDULE_SELECT(sql, orgId)} ORDER BY s.created_at DESC`;
  });
  return rows.map((r) => toSchedule(r, now));
}

/** The schedules on one brief. */
export async function listSchedulesForBrief(
  orgId: string,
  briefId: string,
  now = new Date(),
): Promise<ScheduleRow[]> {
  if (!isNodeId(briefId)) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<DbSchedule[]>`
      ${SCHEDULE_SELECT(sql, orgId)} AND s.brief_id = ${briefId}
      ORDER BY s.created_at DESC`;
  });
  return rows.map((r) => toSchedule(r, now));
}

export async function loadSchedule(
  orgId: string,
  scheduleId: string,
  now = new Date(),
): Promise<ScheduleRow | null> {
  if (!isNodeId(scheduleId)) return null;
  const rows = await withTenant(orgId, async (sql) => {
    return sql<DbSchedule[]>`${SCHEDULE_SELECT(sql, orgId)} AND s.id = ${scheduleId} LIMIT 1`;
  });
  return rows[0] ? toSchedule(rows[0], now) : null;
}

// ---------------------------------------------------------------------------
// Writing a schedule
// ---------------------------------------------------------------------------

export type ScheduleInput = {
  name: string;
  mode: string;
  daysOfWeek: number[];
  atMinute: number;
  leadMinutes: number;
  maxRunsPerDay: number;
  startsOn: string | null;
  endsOn: string | null;
  /**
   * What goes out on each day, Sunday first. When given it decides the days
   * as well, so the two can never disagree: a day with a kind is a day the
   * schedule runs.
   */
  dayKinds?: WeekPlan;
  /**
   * Where approved posts go. Organic destinations only, filtered by the
   * catalog rather than believed: a schedule never creates an ad. Absent
   * leaves what a saved schedule already has.
   */
  destinations?: string[];
  /** Every week, or on picked dates. Absent is every week. */
  repeat?: Repeat;
  /** The picked dates, as the form posts them. */
  dated?: unknown;
  /** How each weekday's post goes out, Sunday first. */
  dayOutlets?: (string | null)[];
  /** Rupees a day for each ad this schedule makes. */
  adDailyBudget?: number | null;
  /** How many days each ad runs. */
  adDays?: number | null;
  /** What its Meta ads are for. Absent keeps what a saved schedule has. */
  adGoal?: string | null;
  /** At most how many people each post's WhatsApp broadcast reaches. */
  broadcastCap?: number | null;
  /** The schedule's own style for each kind, as the form posts it. */
  styles?: unknown;
  /** A weekday's own style, Sunday first, as the form posts it. */
  dayStyles?: unknown;
};

export type CheckedSchedule = {
  value: Schedule;
  week: WeekPlan;
  outlets: Outlet[];
  dated: DatedPost[];
  destinations: Destination[] | null;
  adDailyBudget: number | null;
  adDays: number;
  adGoal: AdGoal | null;
  /** Null leaves what a saved schedule has, as `destinations` does. */
  broadcast: boolean | null;
  broadcastCap: number | null;
  styles: StyleSet;
  dayStyles: (PostStyle | null)[];
};

/**
 * What a style may hold on this brief: its languages, every buyer, the sizes
 * it has for each kind, every design template of that kind (never the
 * narrated story or the agent on camera, which are films a worker makes
 * apart), and every typeface.
 */
export function styleOptionsFor(brief: { languages: readonly string[] | null; formats: readonly string[] | null }): StyleOptions {
  const kinds: PostKind[] = ["IMAGE", "CAROUSEL", "VIDEO"];
  const formats = brief.formats ?? [];
  const templatesOf = (k: PostKind) =>
    templateCatalog(k)
      .map((c) => c.key)
      .filter((key) => isDesignTemplate(key, k) && key !== PRESENTER_TEMPLATE.key);
  return {
    languages: activeLanguages(brief.languages),
    buyers: SEGMENTS.map((x) => x.key),
    sizes: { IMAGE: placementsFor("IMAGE", formats), CAROUSEL: placementsFor("CAROUSEL", formats), VIDEO: placementsFor("VIDEO", formats) },
    templates: Object.fromEntries(kinds.map((k) => [k, templatesOf(k)])) as Record<PostKind, string[]>,
    fonts: FONTS.map((f) => f.key),
  };
}

/** The destinations column: the publications, and the broadcast beside them. */
const storedDestinations = (c: CheckedSchedule): string[] => [
  ...(c.destinations ?? []),
  ...(c.broadcast ? [BROADCAST_DESTINATION] : []),
];

/**
 * A schedule as it may be stored, or the first thing wrong with it.
 *
 * `formats` are the brief's, because a day that makes a video on a brief
 * with no video format was saved and then quietly made an image instead,
 * which is a choice the person never made. `today` is the IST date, because
 * a schedule whose window has already closed was saved and shown Running.
 */
function validate(
  input: ScheduleInput,
  ctx: {
    formats: readonly string[];
    today: string;
    options: StyleOptions;
    now: Date;
    /** The dates already saved on this schedule, which may keep their time. */
    saved?: readonly DatedPost[];
  },
): ({ ok: true } & CheckedSchedule) | { ok: false; code: string; message: string } {
  const mode = (input.mode === "AUTO" ? "AUTO" : "REVIEW") as Mode;
  const allowed = modeAllowed(mode);
  if (!allowed.ok) return { ok: false, code: "MODE_UNAVAILABLE", message: allowed.message };
  const repeat: Repeat = input.repeat === "DATES" ? "DATES" : "WEEKLY";

  // A schedule written before week plans existed posted an image on each of
  // its days, which is what an absent plan still means.
  const week: WeekPlan = input.dayKinds
    ? weekFrom(input.dayKinds)
    : Array.from({ length: 7 }, (_, d) => (input.daysOfWeek.includes(d) ? "IMAGE" : null));
  const outlets = outletsFrom(input.dayOutlets ?? []);
  // Past dates go, as the form drops them when it opens: the runs they made
  // keep their own record, and a date gone by can never run again. More dates
  // than a schedule holds is refused rather than cut, so none is lost unseen.
  if (repeat === "DATES") {
    const over = datedOverflow(input.dated);
    if (over) return { ok: false, code: "TOO_MANY_DATES", message: over };
  }
  const picked = repeat === "DATES" ? pickDated(input.dated) : [];
  // Each style is kept to what this brief can make, and an entry whose own
  // style is the schedule's for its kind takes the schedule's, so changing
  // that one later changes it too.
  const styles = pickStyles(input.styles, ctx.options);
  const own = (kind: PostKind, raw: PostStyle | null | undefined): PostStyle | null => {
    if (!raw) return null;
    const style = pickStyle(raw, kind, ctx.options);
    return sameStyle(style, styles[kind]) ? null : style;
  };
  const dated = picked.filter((d) => d.on >= ctx.today).map((d) => ({ ...d, style: own(d.kind, d.style) }));
  const dayStyles = pickDayStyles(input.dayStyles, week).map((st, d) => (week[d] ? own(week[d]!, st) : null));
  if (picked.length && !dated.length) {
    return { ok: false, code: "DATES_PASSED", message: "Every date picked has already passed." };
  }
  // A date too close to make in time was skipped by the worker without a
  // word, so it is refused here instead, naming the earliest time that works.
  const soon = repeat === "DATES" ? datedTooSoon(dated, ctx.now, ctx.saved) : null;
  if (soon) return { ok: false, code: "TOO_SOON", message: soon };

  // Every kind the plan makes has to be one the brief has a format for.
  const kinds = repeat === "DATES" ? dated.map((d) => d.kind) : week.filter((k): k is PostKind => k !== null);
  for (const kind of new Set(kinds)) {
    const why = kindUnavailable(kind, ctx.formats);
    if (why) return { ok: false, code: "KIND_UNAVAILABLE", message: why };
  }
  const value: Schedule = {
    name: input.name.trim(),
    mode,
    daysOfWeek: repeat === "DATES" ? [] : daysOf(week),
    atMinute: input.atMinute,
    leadMinutes: input.leadMinutes,
    // A calendar's cap is its busiest date, so no picked post is refused as
    // one too many for the day.
    maxRunsPerDay: repeat === "DATES" ? busiestDay(dated) : input.maxRunsPerDay,
    startsOn: repeat === "DATES" ? null : input.startsOn,
    endsOn: repeat === "DATES" ? null : input.endsOn,
    active: true,
    repeat,
    dated,
  };
  const gaps = scheduleGaps(value, ctx.today);
  if (gaps.length) {
    return { ok: false, code: "INCOMPLETE", message: gaps[0].message };
  }

  // Ads go to the project's Meta and Google ad accounts, and only when
  // something in the plan is an ad; a destination nothing uses is dropped.
  const inUse = outletsInUse({ repeat, dayKinds: week, dayOutlets: outlets, dated });
  const wantsAd = inUse.some((o) => o !== "POST");
  const destinations = input.destinations
    ? pickScheduleDestinations(input.destinations).filter((d) => wantsAd || !isAd(d))
    : null;
  const adDays = input.adDays ?? AD_DAYS_DEFAULT;
  const ad = adProblem({
    outlets: inUse,
    hasAdAccount: destinations ? destinations.some((d) => SCHEDULE_AD_DESTINATIONS.includes(d)) : false,
    dailyBudget: input.adDailyBudget ?? null,
    days: adDays,
  });
  if (ad) return { ok: false, code: "AD_SETTINGS", message: ad };

  // A WhatsApp broadcast is not a publication: it rides beside them in the
  // same column, with its own limit a post.
  const broadcast = input.destinations ? input.destinations.includes(BROADCAST_DESTINATION) : null;
  const cap = broadcast ? broadcastCapProblem(input.broadcastCap ?? null) : null;
  if (cap) return { ok: false, code: "BROADCAST_CAP", message: cap };

  const auto = autoProblem(mode, destinations ? [...destinations, ...(broadcast ? [BROADCAST_DESTINATION] : [])] : undefined);
  if (auto) return { ok: false, code: "AUTO_NOWHERE", message: auto };

  return {
    ok: true,
    value,
    week,
    outlets,
    dated,
    destinations,
    adDailyBudget: wantsAd ? (input.adDailyBudget ?? null) : null,
    adDays,
    adGoal: isAdGoal(input.adGoal) ? input.adGoal : null,
    broadcast,
    broadcastCap: broadcast ? (input.broadcastCap ?? null) : null,
    styles,
    dayStyles,
  };
}

/**
 * A schedule on a brief.
 *
 * The node comes from the BRIEF and never from the form. A brief already
 * knows which project or tower it is for, and re-asking would create the one
 * way a schedule could point somewhere its brief does not.
 */
export async function createSchedule(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  input: ScheduleInput;
  /** The clock, which the checks pin. */
  now?: Date;
}): Promise<ScheduleOutcome> {
  if (!isNodeId(opts.briefId)) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That campaign is not in this organisation." };
  }

  const brief = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ node_id: string; kind: string; formats: string[] | null; languages: string[] | null }[]>`
      SELECT b.scope_node_id AS node_id, n.kind, b.formats, b.languages
      FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${opts.orgId} AND b.id = ${opts.briefId}`;
    return row ?? null;
  });
  if (!brief) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That campaign is not in this organisation." };
  }
  if (!scheduleFitsNode(brief.kind as "PROJECT")) {
    return {
      ok: false,
      code: "NODE_KIND",
      message: "A schedule runs against a project or a tower.",
    };
  }
  const checked = validate(opts.input, {
    formats: brief.formats ?? [],
    today: istDate(opts.now ?? new Date()),
    options: styleOptionsFor(brief),
    now: opts.now ?? new Date(),
  });
  if (!checked.ok) return checked;

  const v = checked.value;
  const id = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO post_schedules (org_id, brief_id, scope_node_id, name, mode,
                                  days_of_week, day_kinds, at_minute, lead_minutes,
                                  max_runs_per_day, starts_on, ends_on, destinations, created_by,
                                  repeat, dated, day_outlets, ad_daily_budget, ad_days, broadcast_cap,
                                  styles, day_styles, ad_goal)
      VALUES (${opts.orgId}, ${opts.briefId}, ${brief.node_id}, ${v.name}, ${v.mode},
              ${v.daysOfWeek}, ${checked.week}::text[], ${v.atMinute}, ${v.leadMinutes},
              ${v.maxRunsPerDay}, ${v.startsOn}, ${v.endsOn},
              ${storedDestinations(checked)}::text[], ${opts.actorUserId},
              ${v.repeat ?? "WEEKLY"}, ${sql.json(checked.dated as unknown as JSONValue)},
              ${checked.outlets}::text[], ${checked.adDailyBudget}, ${checked.adDays}, ${checked.broadcastCap},
              ${sql.json(checked.styles as unknown as JSONValue)}, ${sql.json(checked.dayStyles as unknown as JSONValue)},
              ${checked.adGoal ?? "TRAFFIC"})
      RETURNING id`;
    return row.id;
  });

  // The name is the developer's own words and stays out of the log; the
  // cadence is structured and is what a reviewer needs.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "post.schedule_created",
    targetType: "post_schedule",
    targetId: id,
    metadata: {
      mode: v.mode,
      repeat: v.repeat ?? "WEEKLY",
      days: v.daysOfWeek.length,
      dates: checked.dated.length,
      atMinute: v.atMinute,
      leadMinutes: v.leadMinutes,
      adDailyBudget: checked.adDailyBudget,
      adDays: checked.adDailyBudget ? checked.adDays : null,
      broadcastCap: checked.broadcastCap,
    },
  });
  return { ok: true, scheduleId: id };
}

export async function saveSchedule(opts: {
  orgId: string;
  actorUserId: string;
  scheduleId: string;
  input: ScheduleInput;
  /** The clock, which the checks pin. */
  now?: Date;
}): Promise<ScheduleOutcome> {
  if (!isNodeId(opts.scheduleId)) {
    return { ok: false, code: "UNKNOWN", message: "That schedule is not in this organisation." };
  }
  const brief = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ formats: string[] | null; languages: string[] | null; dated: unknown }[]>`
      SELECT b.formats, b.languages, s.dated FROM post_schedules s JOIN campaign_briefs b ON b.id = s.brief_id
      WHERE s.org_id = ${opts.orgId} AND s.id = ${opts.scheduleId}`;
    return row ?? null;
  });
  if (!brief) {
    return { ok: false, code: "UNKNOWN", message: "That schedule is not in this organisation." };
  }
  const checked = validate(opts.input, {
    formats: brief.formats ?? [],
    today: istDate(opts.now ?? new Date()),
    options: styleOptionsFor(brief),
    now: opts.now ?? new Date(),
    saved: pickDated(brief.dated),
  });
  if (!checked.ok) return checked;
  const v = checked.value;

  const saved = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      UPDATE post_schedules SET
        name = ${v.name}, mode = ${v.mode}, days_of_week = ${v.daysOfWeek},
        day_kinds = ${checked.week}::text[],
        at_minute = ${v.atMinute}, lead_minutes = ${v.leadMinutes},
        max_runs_per_day = ${v.maxRunsPerDay},
        starts_on = ${v.startsOn}, ends_on = ${v.endsOn},
        destinations = ${
          checked.destinations ? sql`${storedDestinations(checked)}::text[]` : sql`destinations`
        },
        repeat = ${v.repeat ?? "WEEKLY"}, dated = ${sql.json(checked.dated as unknown as JSONValue)},
        day_outlets = ${checked.outlets}::text[],
        ad_daily_budget = ${checked.adDailyBudget}, ad_days = ${checked.adDays},
        ad_goal = ${checked.adGoal ? sql`${checked.adGoal}` : sql`ad_goal`},
        broadcast_cap = ${checked.broadcast === null ? sql`broadcast_cap` : sql`${checked.broadcastCap}`},
        styles = ${sql.json(checked.styles as unknown as JSONValue)},
        day_styles = ${sql.json(checked.dayStyles as unknown as JSONValue)},
        updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.scheduleId}
      RETURNING id`;
    if (!row) return null;

    // Runs already made for the old cadence and not yet started. One whose
    // slot the new cadence still has keeps its row with the new lead time;
    // one it no longer has is dropped, because it would otherwise write a
    // post for a day or a time nobody now wants. Nothing has been written
    // for a PENDING run, so dropping it loses nothing.
    const pending = await sql<{ id: string; slot: Date }[]>`
      SELECT id, slot FROM post_runs
      WHERE org_id = ${opts.orgId} AND schedule_id = ${opts.scheduleId} AND state = 'PENDING'`;
    for (const run of pending) {
      if (slotFits(v, run.slot)) {
        await sql`
          UPDATE post_runs SET generate_at = ${generateAtFor(run.slot, v.leadMinutes)}
          WHERE org_id = ${opts.orgId} AND id = ${run.id} AND state = 'PENDING'`;
      } else {
        await sql`
          DELETE FROM post_runs
          WHERE org_id = ${opts.orgId} AND id = ${run.id} AND state = 'PENDING'`;
      }
    }
    return row;
  });
  if (!saved) {
    return { ok: false, code: "UNKNOWN", message: "That schedule is not in this organisation." };
  }

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "post.schedule_saved",
    targetType: "post_schedule",
    targetId: opts.scheduleId,
    metadata: {
      mode: v.mode,
      repeat: v.repeat ?? "WEEKLY",
      days: v.daysOfWeek.length,
      dates: checked.dated.length,
      atMinute: v.atMinute,
      leadMinutes: v.leadMinutes,
      adDailyBudget: checked.adDailyBudget,
      adDays: checked.adDailyBudget ? checked.adDays : null,
      broadcastCap: checked.broadcastCap,
    },
  });
  return { ok: true, scheduleId: opts.scheduleId };
}

/**
 * The kill switch.
 *
 * Stopping is a lower bar than starting on purpose, and the action layer
 * grants it on `campaign:publish` rather than on whatever created the
 * schedule. A control only the person who started the spend can stop is not
 * a kill switch.
 *
 * Runs already generated are left alone. Their creatives are still in the
 * queue with their reasons, and nothing publishes without a person, so
 * destroying them would only lose the record of what was written.
 */
export async function stopSchedule(opts: {
  orgId: string;
  actorUserId: string;
  scheduleId: string;
  reason: string;
}): Promise<{ ok: boolean; message?: string }> {
  if (!isNodeId(opts.scheduleId)) return { ok: false, message: "That schedule is not here." };
  const reason = opts.reason.trim().slice(0, 200) || "Stopped";

  const stopped = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      UPDATE post_schedules
      SET active = false, stopped_reason = ${reason},
          stopped_by = ${opts.actorUserId}, stopped_at = now(), updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.scheduleId} AND active
      RETURNING id`;
    if (!row) return null;
    // Anything not yet written is abandoned rather than left to fire after
    // somebody pulled the switch.
    await sql`
      UPDATE post_runs
      SET state = 'REFUSED', refusal_code = 'SCHEDULE_STOPPED', finished_at = now()
      WHERE org_id = ${opts.orgId} AND schedule_id = ${opts.scheduleId}
        AND state = 'PENDING'`;
    return row;
  });
  if (!stopped) return { ok: false, message: "That schedule was not running." };

  // The reason is a person's own words, so it stays in tenant data.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "post.schedule_stopped",
    targetType: "post_schedule",
    targetId: opts.scheduleId,
    metadata: {},
  });
  return { ok: true };
}

export async function startSchedule(opts: {
  orgId: string;
  actorUserId: string;
  scheduleId: string;
}): Promise<{ ok: boolean; message?: string }> {
  if (!isNodeId(opts.scheduleId)) return { ok: false, message: "That schedule is not here." };
  const started = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      UPDATE post_schedules
      SET active = true, stopped_reason = NULL, stopped_by = NULL,
          stopped_at = NULL, updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.scheduleId} AND NOT active
      RETURNING id`;
    return row ?? null;
  });
  if (!started) return { ok: false, message: "That schedule was already running." };

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "post.schedule_started",
    targetType: "post_schedule",
    targetId: opts.scheduleId,
    metadata: {},
  });
  return { ok: true };
}

export async function removeSchedule(opts: {
  orgId: string;
  actorUserId: string;
  scheduleId: string;
}): Promise<{ ok: boolean; message?: string }> {
  if (!isNodeId(opts.scheduleId)) return { ok: false, message: "That schedule is not here." };
  const gone = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      DELETE FROM post_schedules WHERE org_id = ${opts.orgId} AND id = ${opts.scheduleId}
      RETURNING id`;
    return row ?? null;
  });
  if (!gone) return { ok: false, message: "That schedule is not here." };
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "post.schedule_removed",
    targetType: "post_schedule",
    targetId: opts.scheduleId,
    metadata: {},
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

/**
 * Occasions in a window, with this tenant's opt-in beside each.
 *
 * The calendar is reference data and the opt-in is tenant data, so the two
 * reads are two roles' business. The occasion rows carry nobody's anything,
 * which is why a tenant may read every one of them and write none.
 */
export async function listOccasions(
  orgId: string,
  from: Date,
  to: Date,
): Promise<(Occasion & { optedIn: boolean })[]> {
  const [rows, optedIn] = await Promise.all([
    // Through `withTenant()` and not `controlDb`, although this table carries
    // no org_id and no RLS. The app role holds SELECT on it and nothing else,
    // so a tenant may read every festival and move none, and the one rule
    // about `controlDb` stays the rule: it is sign-in and org creation.
    withTenant(orgId, async (sql) =>
      sql<
        {
          id: string;
          key: string;
          name: string;
          on_date: Date;
          kind: "BUYING" | "GREETING";
          regions: string[];
          verified_at: Date | null;
        }[]
      >`
        SELECT id, key, name, on_date, kind, regions, verified_at
        FROM occasions
        WHERE on_date >= ${istDate(from)}::date AND on_date <= ${istDate(to)}::date
        ORDER BY on_date`,
    ),
    optIns(orgId),
  ]);
  const opted = new Set(optedIn);
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    onDate: new Date(r.on_date).toISOString().slice(0, 10),
    kind: r.kind,
    regions: r.regions ?? [],
    verified: r.verified_at !== null,
    optedIn: opted.has(r.key),
  }));
}

export async function optIns(orgId: string): Promise<string[]> {
  const rows = await withTenant(orgId, async (sql) => {
    return sql<{ occasion_key: string }[]>`
      SELECT occasion_key FROM occasion_opt_ins WHERE org_id = ${orgId}`;
  });
  return rows.map((r) => r.occasion_key);
}

/**
 * Which occasions this developer observes.
 *
 * The whole list every time rather than one toggle at a time: the screen is a
 * set of tick boxes and a partial write would leave the stored set disagreeing
 * with what was on screen. Keys nothing in the calendar knows are dropped,
 * the way `pickFrom()` drops a format the catalog does not carry.
 */
export async function setOptIns(opts: {
  orgId: string;
  actorUserId: string;
  keys: readonly string[];
}): Promise<{ ok: boolean }> {
  const known = await withTenant(opts.orgId, async (sql) =>
    sql<{ key: string }[]>`SELECT DISTINCT key FROM occasions`);
  const allowed = new Set(known.map((k) => k.key));
  const keys = [...new Set(opts.keys)].filter((k) => allowed.has(k));

  await withTenant(opts.orgId, async (sql) => {
    await sql`DELETE FROM occasion_opt_ins WHERE org_id = ${opts.orgId}`;
    for (const key of keys) {
      await sql`
        INSERT INTO occasion_opt_ins (org_id, occasion_key, created_by)
        VALUES (${opts.orgId}, ${key}, ${opts.actorUserId})`;
    }
  });

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "post.occasions_set",
    targetType: "org",
    targetId: opts.orgId,
    metadata: { count: keys.length },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type RunRow = {
  id: string;
  scheduleId: string;
  scheduleName: string;
  briefId: string;
  nodeName: string;
  mode: Mode;
  slot: string;
  generateAt: string;
  publishAt: string;
  state: RunState;
  attempts: number;
  refusalCode: string | null;
  refusalDetail: string | null;
  occasionName: string | null;
  written: number;
  passed: number;
  held: number;
  failed: number;
  awaiting: number;
  createdAt: string;
};

type DbRun = {
  id: string;
  schedule_id: string;
  schedule_name: string;
  brief_id: string;
  node_name: string;
  mode: Mode;
  slot: Date;
  generate_at: Date;
  publish_at: Date;
  state: RunState;
  attempts: number;
  refusal_code: string | null;
  refusal_detail: string | null;
  occasion_name: string | null;
  written: number;
  passed: number;
  held: number;
  failed: number;
  awaiting: number;
  created_at: Date;
};

const toRun = (r: DbRun): RunRow => ({
  id: r.id,
  scheduleId: r.schedule_id,
  scheduleName: r.schedule_name,
  briefId: r.brief_id,
  nodeName: r.node_name,
  mode: r.mode,
  slot: r.slot.toISOString(),
  generateAt: r.generate_at.toISOString(),
  publishAt: r.publish_at.toISOString(),
  state: r.state,
  attempts: r.attempts,
  refusalCode: r.refusal_code,
  refusalDetail: r.refusal_detail,
  occasionName: r.occasion_name,
  written: r.written,
  passed: r.passed,
  held: r.held,
  failed: r.failed,
  awaiting: r.awaiting,
  createdAt: r.created_at.toISOString(),
});

export async function listRuns(
  orgId: string,
  opts: { scheduleId?: string; briefId?: string; limit?: number } = {},
): Promise<RunRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  if (opts.scheduleId && !isNodeId(opts.scheduleId)) return [];
  if (opts.briefId && !isNodeId(opts.briefId)) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<DbRun[]>`
      SELECT r.id, r.schedule_id, s.name AS schedule_name, s.brief_id,
             n.name AS node_name, s.mode,
             r.slot, r.generate_at, r.publish_at, r.state, r.attempts,
             r.refusal_code, r.refusal_detail, o.name AS occasion_name,
             r.written, r.passed, r.held, r.failed, r.created_at,
             (SELECT count(*)::int FROM post_creatives c
               WHERE c.run_id = r.id AND c.state = 'DRAFT'
                 AND c.verdict <> 'FAIL')                  AS awaiting
      FROM post_runs r
      JOIN post_schedules s ON s.id = r.schedule_id
      JOIN scope_nodes n    ON n.id = s.scope_node_id
      LEFT JOIN occasions o ON o.id = r.occasion_id
      WHERE r.org_id = ${orgId}
        ${opts.scheduleId ? sql`AND r.schedule_id = ${opts.scheduleId}` : sql``}
        ${opts.briefId ? sql`AND s.brief_id = ${opts.briefId}` : sql``}
      ORDER BY r.slot DESC
      LIMIT ${limit}`;
  });
  return rows.map(toRun);
}

/**
 * Create the run rows for every slot whose generation is due inside the
 * horizon, and do nothing at all the second time.
 *
 * `ON CONFLICT DO NOTHING` against the unique index on (schedule_id, slot) is
 * what makes a double fire cost one statement rather than one ad. The slot is
 * computed from the cadence, so two workers arriving a second apart compute
 * the same value and the second inserts nothing.
 */
export async function materialiseRuns(opts: {
  orgId: string;
  now?: Date;
  /** How far ahead to create rows. One horizon of slack past the longest lead. */
  horizonMinutes?: number;
}): Promise<number> {
  const now = opts.now ?? new Date();
  const horizon = opts.horizonMinutes ?? 24 * 60;

  const schedules = await listSchedules(opts.orgId, now);
  let created = 0;

  for (const s of schedules) {
    if (!s.active) continue;
    // Slots whose GENERATION falls inside the horizon, which is the window
    // that matters: a slot a week out with a day's lead is not due to be
    // written today, and creating its row now would only mean a PENDING row
    // sitting there for six days.
    // A picked date closer than the lead time is still a date somebody chose:
    // its run is made now and written straight away, rather than never. A
    // week plan starts a lead time out, so a new schedule does not fire a
    // burst of runs for slots already too close to review.
    const from = new Date(
      now.getTime() + (s.repeat === "DATES" ? 0 : s.leadMinutes * 60_000) - 60_000,
    );
    const to = new Date(now.getTime() + (s.leadMinutes + horizon) * 60_000);
    const slots = slotsBetween(s, { from, to });

    for (const slot of slots) {
      const generateAt = generateAtFor(slot, s.leadMinutes);
      const inserted = await withTenant(opts.orgId, async (sql) => {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at)
          VALUES (${opts.orgId}, ${s.id}, ${slot}, ${generateAt}, ${slot})
          ON CONFLICT (schedule_id, slot) DO NOTHING
          RETURNING id`;
        return row ?? null;
      });
      if (inserted) created += 1;
    }
  }
  return created;
}

/**
 * Take a lease on a run, or fail because somebody else holds one.
 *
 * The whole decision is in the WHERE clause, so two workers racing resolve in
 * the database rather than in whichever of them read first. `claimable()`
 * states the same rule in a form `check:logic` can cover; this is the form
 * that is actually authoritative.
 */
export async function claimRun(opts: {
  orgId: string;
  runId: string;
  now?: Date;
}): Promise<{ ok: true; leaseId: string } | { ok: false; code: string }> {
  const now = opts.now ?? new Date();
  const leaseId = randomUUID();
  const until = leaseUntil(now);

  const got = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      UPDATE post_runs
      SET state = 'RUNNING', lease_id = ${leaseId}, lease_until = ${until},
          attempts = attempts + 1, started_at = coalesce(started_at, now())
      WHERE org_id = ${opts.orgId} AND id = ${opts.runId}
        AND attempts < 3
        AND (state = 'PENDING'
             OR (state = 'RUNNING' AND (lease_until IS NULL OR lease_until <= ${now})))
      RETURNING id`;
    return row ?? null;
  });
  return got ? { ok: true, leaseId } : { ok: false, code: "NOT_CLAIMABLE" };
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

export type RunOutcome =
  | { ok: true; runId: string; written: number; passed: number; held: number; failed: number }
  | { ok: false; runId: string; code: RefusalCode | "NOT_CLAIMABLE" | "RUN_UNKNOWN"; message: string };

async function refuse(
  orgId: string,
  runId: string,
  code: RefusalCode,
  detail: string,
): Promise<RunOutcome> {
  await withTenant(orgId, async (sql) => {
    await sql`
      UPDATE post_runs
      SET state = 'REFUSED', refusal_code = ${code}, refusal_detail = ${detail},
          finished_at = now(), lease_id = NULL, lease_until = NULL
      WHERE org_id = ${orgId} AND id = ${runId}`;
  });
  return { ok: false, runId, code, message: detail };
}

/**
 * One run, start to finish.
 *
 * The order is `doc/post-generation.md` section 4, and every step before the
 * model call is there to make the model call unnecessary when it would have
 * been wasted. Refusing a run on a phase whose brand kit is empty costs a
 * query; discovering it after generating twelve blocks costs twelve calls and
 * still produces nothing that could be published.
 */
export async function executeRun(opts: {
  orgId: string;
  runId: string;
  /** Whose name the generated rows carry. The runner passes the schedule's author. */
  actorUserId: string;
  now?: Date;
  /** Injected in checks, so a suite never spends money or waits on a model. */
  driver?: CopyDriver;
  /** The reader for a card in a script of its own, injected the same way. */
  reader?: ReadDriver;
  /** The image and checking models, injected the same way. */
  designers?: Partial<Drivers>;
  /** The film models, injected the same way; a suite that injects designers and not these makes no film. */
  filmDrivers?: Partial<FilmDrivers>;
  /** Skip the claim, for a caller that already holds the lease. */
  claimed?: boolean;
}): Promise<RunOutcome> {
  const now = opts.now ?? new Date();

  if (!opts.claimed) {
    const claim = await claimRun({ orgId: opts.orgId, runId: opts.runId, now });
    if (!claim.ok) {
      return {
        ok: false,
        runId: opts.runId,
        code: "NOT_CLAIMABLE",
        message: "Another worker holds this run.",
      };
    }
  }

  const head = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<
      {
        schedule_id: string;
        brief_id: string;
        node_id: string;
        node_name: string;
        path: string;
        kind: string;
        mode: Mode;
        active: boolean;
        max_runs_per_day: number;
        publish_at: Date;
        created_by: string | null;
        day_kinds: (string | null)[] | null;
        formats: string[];
        repeat: Repeat;
        dated: unknown;
        day_outlets: (string | null)[] | null;
        styles: unknown;
        day_styles: unknown;
        brief_name: string | null;
      }[]
    >`
      SELECT s.id AS schedule_id, s.brief_id, s.scope_node_id AS node_id,
             n.name AS node_name, n.path::text AS path, n.kind,
             s.mode, s.active, s.max_runs_per_day, r.publish_at, s.created_by,
             s.day_kinds, b.formats, s.repeat, s.dated, s.day_outlets,
             s.styles, s.day_styles, b.name AS brief_name
      FROM post_runs r
      JOIN post_schedules s  ON s.id = r.schedule_id
      JOIN scope_nodes n     ON n.id = s.scope_node_id
      JOIN campaign_briefs b ON b.id = s.brief_id
      WHERE r.org_id = ${opts.orgId} AND r.id = ${opts.runId}`;
    return row ?? null;
  });
  if (!head) {
    return { ok: false, runId: opts.runId, code: "RUN_UNKNOWN", message: "No such run." };
  }

  if (!head.active) {
    return refuse(opts.orgId, opts.runId, "SCHEDULE_STOPPED",
      "The schedule was stopped before this was due.");
  }

  // Our own invoice, and it is checked before the model is called rather than
  // counted afterwards. A run that already finished today counts; this one
  // does not count itself, because it is RUNNING.
  const ranToday = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM post_runs
      WHERE org_id = ${opts.orgId} AND schedule_id = ${head.schedule_id}
        AND id <> ${opts.runId}
        AND state IN ('GENERATED', 'RELEASED', 'EXPIRED')
        AND (slot AT TIME ZONE 'Asia/Kolkata')::date
            = (${now}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date`;
    return row?.n ?? 0;
  });
  if (!limitsLifted() && ranToday >= head.max_runs_per_day) {
    return refuse(opts.orgId, opts.runId, "DAILY_CAP",
      `This schedule has already run ${ranToday} time${ranToday === 1 ? "" : "s"} today.`);
  }

  // Step 0. The six gates. Registration is checked again below by the gate
  // that actually decides; this is about the rest.
  //
  // Three are required and two deliberately are not. REGISTERED and FACTS
  // because there is nothing lawful to say and nothing signed to say it
  // from. BRANDED because the MahaRERA lockup rule measures registration type
  // against the largest contact detail on the creative, and with no contact
  // detail recorded that check cannot run at all.
  //
  // PRICED is not required: a walkthrough or a location post quotes no money,
  // and `chooseVariation()` already withholds the price template when nothing
  // is approved. PICTURED is not required because the composer does not exist
  // yet, and requiring a picture for a run that produces only copy would
  // refuse work that is currently useful. It becomes required with the
  // composer, which is where the picture is actually consumed.
  const readiness = await loadReadiness(opts.orgId);
  const under = readiness.filter(
    (p) => p.path === head.path || p.path.startsWith(`${head.path}.`),
  );
  const live = under.filter((p) => !p.blocked);
  if (!live.length) {
    return refuse(opts.orgId, opts.runId, "NOT_ADVERTISABLE",
      under[0]?.why || "No tower here can be advertised today.");
  }
  const REQUIRED = new Set<string>(["facts", "brand"]);
  const short = live
    .map((p) => ({
      p,
      missing: p.gates.filter((g) => REQUIRED.has(g.key) && g.state !== "done"),
    }))
    .filter((x) => x.missing.length);
  if (short.length === live.length) {
    const gate = short[0].missing[0];
    return refuse(opts.orgId, opts.runId, "NOT_READY",
      `${short[0].p.phaseName}: ${gate.label.toLowerCase()} is not done. ${gate.detail}.`);
  }

  const brief = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<
      {
        objective: string | null;
        audience: string | null;
        cta: string | null;
        hook: string | null;
        offers: string | null;
        languages: string[];
        formats: string[];
        unit_type_ids: string[];
      }[]
    >`
      SELECT objective, audience, cta, hook, offers, languages, formats, unit_type_ids
      FROM campaign_briefs WHERE org_id = ${opts.orgId} AND id = ${head.brief_id}`;
    return row ?? null;
  });
  if (!brief) {
    return refuse(opts.orgId, opts.runId, "NO_BRIEF", "The brief behind this schedule is gone.");
  }
  // Only the languages switched on are written in.
  brief.languages = activeLanguages(brief.languages);
  if (!brief.languages?.length) {
    return refuse(opts.orgId, opts.runId, "NO_LANGUAGES",
      "The brief names no languages to write in.");
  }

  // Steps 1 and 2. The gate that decides, and the facts it decides against.
  const node = { id: head.node_id, name: head.node_name, path: head.path, kind: head.kind };
  const { ground, brainSources } = await studioGround(
    opts.orgId, node, now, brief.unit_type_ids ?? [],
  );
  if (!ground.advertisable) {
    return refuse(opts.orgId, opts.runId, "NOT_ADVERTISABLE", "This phase can't be advertised yet.");
  }
  // Every ad names the exact locality, so a run with none signed is refused
  // here, before the writer is paid.
  if (!ground.location) return refuse(opts.orgId, opts.runId, "NO_LOCATION", NO_LOCATION_MESSAGE);
  // And it is built on an approved selling point. With none, the writer
  // invents one, so nothing is written and nothing is spent.
  if (!hasSellingPoint(ground)) return refuse(opts.orgId, opts.runId, "NO_POINTS", NO_POINTS_MESSAGE);
  // A firm's own ad carries its agent registration; with none current, nothing is written.
  const agent = await firmAgentFor(opts.orgId, now.toISOString());
  if (!agent.ok) return refuse(opts.orgId, opts.runId, "NO_AGENT_RERA", agent.message);

  // Step 3. The occasion, if one is near and this developer observes it.
  const region = await stateCodeFor(opts.orgId, head.path);
  const calendar = await listOccasions(
    opts.orgId, now, new Date(now.getTime() + 30 * 86_400_000),
  );
  const occasion = pickOccasion({
    occasions: calendar,
    optedIn: calendar.filter((o) => o.optedIn).map((o) => o.key),
    region,
    // From the day the post goes out, not the day it is written: a run made
    // the evening before a festival is not about that festival, and an
    // occasion on the writing day gave the post a hard stop before it went out.
    at: head.publish_at,
  });

  // Step 4. What makes this post different from the last three.
  const inputs = await gatherInputs(opts.orgId, node.id);
  const recent = await recentChoices(opts.orgId, head.schedule_id);
  const pools = {
    // What an ad is built on; the spec sheet is never a scheduled post's lead.
    talkingPoints: sellingPoints(ground.talkingPoints, { luxury: isLuxury(ground.configurations) }),
    assetIds: inputs.assets.map((a) => a.assetId),
    hasPrice: ground.configurations.some((c) => c.startingPrice !== null),
  };
  // What has worked, ours and the market's, chooses most posts; a share still
  // rotates, as every post did before anything was learnt. Seeded by the run,
  // so a run retried after a crash makes the same choice.
  const learning = await learningFor(opts.orgId, node.id).catch(() => null);
  const pictures = learning && knows(learning.scores, "picture") ? await assetCategories(opts.orgId, pools.assetIds) : new Map<string, string>();
  const variation: Variation = learning?.scores.length
    ? (({ by: _by, ...v }) => ({ ...v, template: v.template as Variation["template"] }))(
        chooseLearnedVariation({
          templates: TEMPLATES,
          pools,
          recent,
          occasionId: occasion?.id ?? null,
          scores: learning.scores,
          pictureOf: (id) => pictures.get(id) ?? null,
          explore: learning.settings.explore,
          rand: seeded(opts.runId),
        }),
      )
    : chooseVariation({ pools, recent, occasion });

  // The slot's kind, outlet and style: from the week plan, read off the
  // slot's own IST weekday (never the day the run happened to execute,
  // because a Thursday run writing Friday's post is making Friday's post),
  // or from the date picked on the calendar. Asked before writing, because
  // the style says which languages and buyers are written for.
  const dayKinds = head.day_kinds ? weekFrom(head.day_kinds) : null;
  const { kind, outlet, style } = entryAt(
    {
      repeat: head.repeat,
      dayKinds,
      dayOutlets: outletsFrom(head.day_outlets ?? []),
      dated: pickDated(head.dated),
      styles: looseStyles(head.styles),
      dayStyles: pickDayStyles(head.day_styles, dayKinds ?? []),
    },
    head.publish_at,
  );

  // Step 5. Write, and gate what came back.
  const budget = budgetFor(brief.formats ?? []);
  const buyers = SEGMENTS.filter((x) => style.buyers.includes(x.key)).map((x) => x.key);
  // The cards are written for the kind of template the style names, when the
  // project holds what that template shows; otherwise they are general cards
  // and "Let AI choose" picks among the templates they fit.
  const material = await materialFor(opts.orgId, node.id, ground, brief.offers, now);
  // On a festival the developer observes, a post the AI was left to design
  // is a festival post: the festive template, its festival and its card.
  const festive = festivalDay({
    occasion,
    publishDate: istDate(head.publish_at),
    kind,
    styleTemplate: currentTemplateKey(style.template),
    material,
  });
  const styleKey = festive?.template ?? currentTemplateKey(style.template);
  const wantAngle: CardAngle = festive?.angle ?? (styleKey && isDesignTemplate(styleKey, kind) ? templateAngle(kind, styleKey) : "GENERAL");
  const runAngle: CardAngle = angleGap(wantAngle, material) || templateNever(kind, styleKey) ? "GENERAL" : wantAngle;
  const planned = planCopy({ languages: writeIn(style, brief.languages), segments: buyers }).map((p) => ({ ...p, angle: runAngle }));
  if (planned.length > MAX_COPY_BLOCKS) {
    return refuse(opts.orgId, opts.runId, "NO_LANGUAGES",
      "That is more blocks than the catalog allows.");
  }

  const chosenAsset = inputs.assets.find((a) => a.assetId === variation.assetId) ?? null;
  const creativeInputs: CreativeInputs = {
    brain: brainSources,
    units: inputs.units,
    asset: chosenAsset,
    brand: inputs.brand,
  };
  const hardStop = hardStopFor(occasion);
  const write = opts.driver ?? writeCopy;
  const tally = { written: 0, passed: 0, held: 0, failed: 0 };
  // What the writer last refused with, so a run that wrote nothing because
  // the model was out of credits or down says so, and is tried again.
  let refusal: { code: string; message: string } | null = null;

  for (const spec of planned) {
    // The same write-check-rewrite loop the studio uses, so a scheduled post
    // reaches the review queue already corrected for the model's own
    // mistakes, and nobody reviewing it is asked to spot what a rewrite with
    // the gate's feedback would have fixed.
    const checked = await writeChecked({
      spec,
      ground,
      budget,
      build: (feedback) =>
        runInstruction({
          spec, ground, budget, brief, variation, occasion, project: node.name, feedback,
        }),
      write,
      read: opts.reader,
      onRefused: (failure) => { refusal = failure; },
    });
    if (!checked) continue;
    const { copy, verdict, reasons } = checked;

    // Step 9, per block, and the only place the two modes differ.
    //
    // REVIEW and BLOCK both land as DRAFT: one is waiting for somebody and
    // the other is shown with its reasons so the reason can be fixed. PUBLISH
    // lands APPROVED with nobody's name on it, which is exactly what AUTO is.
    // With AUTO switched off, a schedule saved as AUTO waits like any other.
    const release = releaseFor(AUTO_AVAILABLE ? head.mode : "REVIEW", verdict);

    await storeCreative({
      orgId: opts.orgId,
      runId: opts.runId,
      spec,
      copy,
      verdict,
      reasons,
      ground,
      brainSources,
      variation,
      // A Hindi creative's own lines ride in its inputs, so the approval pins them.
      inputs: {
        ...creativeInputs,
        ...(checked.local ? { local: checked.local } : {}),
        ...(spec.angle && spec.angle !== "GENERAL" ? { angle: spec.angle } : {}),
      },
      hardStop,
      approvedByMachine: release === "PUBLISH",
    });

    tally.written += 1;
    if (verdict === "PASS") tally.passed += 1;
    else if (verdict === "HOLD") tally.held += 1;
    else tally.failed += 1;
  }

  if (!tally.written) {
    // The model did not answer: not the run's fault, and the next pass may
    // find it back. Thrown, so `runDue()` puts the run back for another
    // attempt and leaves it FAILED with the reason after the third.
    const failure = refusal as { code: string; message: string } | null;
    if (failure) throw new Error(`The copy model refused: ${failure.message}`.slice(0, 200));
    return refuse(opts.orgId, opts.runId, "NOTHING_WRITTEN",
      "The copy model returned nothing usable.");
  }

  await attachPosts({
    orgId: opts.orgId,
    runId: opts.runId,
    node,
    kind,
    // A kind the brief lost since falls back to an image, in the image style.
    styleOf: (k) => (k === kind ? (festive ? { ...style, template: festive.template } : style) : looseStyles(head.styles)[k]),
    templateContext: {
      objective: brief.objective,
      hook: brief.hook,
      offers: brief.offers,
      campaign: head.brief_name,
    },
    festival: festive?.festival ?? festivalOf(occasion) ?? festivalIn(head.brief_name),
    angle: runAngle,
    material,
    learned: learning
      ? { scores: learning.scores, explore: learning.settings.explore, seed: opts.runId }
      : null,
    formats: head.formats ?? [],
    talkingPoints: ground.talkingPoints,
    neverSay: ground.neverSay,
    facts: adFacts(ground),
    ground,
    luxury: isLuxury(ground.configurations),
    pixel: pixelContext(ground),
    designers: opts.designers,
    filmDrivers: opts.filmDrivers,
    briefId: head.brief_id,
    actorUserId: opts.actorUserId,
  }).catch(async () => {
    // A picture that would not render leaves the copy reviewable on its own.
    // The run is not failed for it: the words cleared, and a person can still
    // approve them and make the post from the studio. With no picture there
    // is no pixel PASS, so what AUTO approved waits for that person.
    await holdForPerson(opts.orgId, opts.runId).catch(() => {});
  });

  await withTenant(opts.orgId, async (sql) => {
    await sql`
      UPDATE post_runs
      SET state = 'GENERATED', outlet = ${outlet}, written = ${tally.written}, passed = ${tally.passed},
          held = ${tally.held}, failed = ${tally.failed},
          occasion_id = ${occasion?.id ?? null},
          finished_at = now(), lease_id = NULL, lease_until = NULL
      WHERE org_id = ${opts.orgId} AND id = ${opts.runId}`;
  });

  // The copy never enters the audit row. It can name a person or a
  // competitor, and `audit_log` is the table that holds no free text somebody
  // typed. Counts, the verdict split and the choices are what a reviewer
  // needs.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "post.run_generated",
    targetType: "post_run",
    targetId: opts.runId,
    metadata: {
      ...tally,
      mode: head.mode,
      model: COPY_MODEL,
      template: variation.template,
      occasion: occasion?.key ?? null,
    },
  });

  return { ok: true, runId: opts.runId, ...tally };
}

/**
 * What the writer is told, which is the Studio's instruction plus the two
 * things a schedule knows that a brief does not.
 *
 * The template, because the point of rotating them is that the copy actually
 * differs rather than the row recording that it should have. And the
 * occasion, where a GREETING one removes the offer instead of decorating it:
 * Holi is not a sales event, and a developer whose Holi post quotes a booking
 * amount has said something about themselves rather than about the building.
 */
export function runInstruction(input: {
  spec: { language: string; segment: Segment; angle?: CardAngle };
  ground: Ground;
  budget: ReturnType<typeof budgetFor>;
  brief: { objective: string | null; audience: string | null; cta: string | null; hook: string | null; offers: string | null };
  variation: Variation;
  occasion: Occasion | null;
  project: string;
  feedback?: string | null;
}): { system: string; instruction: string; local?: true; points?: string[] } {
  // A festival greeting takes no shape from the rotation: "lead with the
  // price" is the one thing a greeting may not do.
  const greeting = input.spec.angle === "GREETING";
  const template = greeting ? null : templateDef(input.variation.template);
  const base = instructionFor({
    spec: input.spec,
    ground: input.ground,
    budget: input.budget,
    brief: {
      ...input.brief,
      // The rotated talking point leads, rather than whichever one the brief
      // was written around three months ago.
      hook: input.variation.leadPoint ?? input.brief.hook,
      offers: offerAllowed(input.occasion) ? input.brief.offers : null,
    },
    project: input.project,
  });

  const extra = [
    template ? `Shape: ${template.brief}` : null,
    input.occasion
      ? input.occasion.kind === "BUYING" && !greeting
        ? `Occasion: ${input.occasion.name}, on ${input.occasion.onDate}. It may be mentioned warmly.`
        : `Occasion: ${input.occasion.name}, on ${input.occasion.onDate}. Greet only. State no price, no offer and no discount.`
      : null,
  ].filter((l): l is string => l !== null);

  return {
    system: base.system,
    // The feedback from a refused attempt goes last, after the shape and the
    // occasion, so it is the final thing the writer reads.
    instruction: [base.instruction, extra.length ? extra.join("\n") : null, input.feedback ?? null]
      .filter((part): part is string => !!part)
      .join("\n\n"),
    ...(base.local ? { local: true as const, points: base.points } : {}),
  };
}

async function storeCreative(opts: {
  orgId: string;
  runId: string;
  spec: { language: string; segment: Segment };
  copy: Copy;
  verdict: Verdict;
  reasons: Reason[];
  ground: Ground;
  brainSources: { versionId: string; path: string; version: number }[];
  variation: Variation;
  inputs: CreativeInputs;
  hardStop: Date | null;
  /** AUTO released a PASS. Approved, and by nobody, which is the whole of it. */
  approvedByMachine: boolean;
}): Promise<void> {
  const contentSha = creativeHash({
    headline: opts.copy.headline,
    body: opts.copy.body,
    cta: opts.copy.cta,
    language: opts.spec.language,
    segment: opts.spec.segment,
    inputs: opts.inputs,
  });

  await withTenant(opts.orgId, async (sql) => {
    await sql`
      INSERT INTO post_creatives (org_id, run_id, language, segment, headline, body, cta,
                                  verdict, reasons, ground, brain_sources, model,
                                  template, lead_point, asset_id, occasion_id,
                                  inputs, content_sha256, hard_stop_at,
                                  state, decided_at, decided_sha256)
      VALUES (${opts.orgId}, ${opts.runId}, ${opts.spec.language}, ${opts.spec.segment},
              ${opts.copy.headline}, ${opts.copy.body}, ${opts.copy.cta},
              ${opts.verdict}, ${sql.json(opts.reasons as unknown as JSONValue)},
              ${sql.json(opts.ground as unknown as JSONValue)},
              ${sql.json(opts.brainSources as unknown as JSONValue)},
              ${COPY_MODEL}, ${opts.variation.template}, ${opts.variation.leadPoint},
              ${opts.variation.assetId}, ${opts.variation.occasionId},
              ${sql.json(opts.inputs as unknown as JSONValue)},
              ${contentSha}, ${opts.hardStop},
              ${opts.approvedByMachine ? "APPROVED" : "DRAFT"},
              ${opts.approvedByMachine ? sql`now()` : null},
              ${opts.approvedByMachine ? contentSha : null})
      ON CONFLICT (run_id, language, segment) DO NOTHING`;
  });
}

/**
 * AUTO approved a run's words before there was a picture. A creative whose
 * picture has no pixel PASS, or that has no picture at all, goes back to
 * waiting for a person: AUTO means "publish what passed". Only the machine's
 * approval is taken back (`decided_by` is null), never a person's.
 */
async function holdForPerson(orgId: string, runId: string, creativeId?: string): Promise<void> {
  await withTenant(orgId, async (sql) => {
    await sql`
      UPDATE post_creatives SET state = 'DRAFT', decided_at = NULL, decided_sha256 = NULL
      WHERE org_id = ${orgId} AND run_id = ${runId} AND state = 'APPROVED' AND decided_by IS NULL
        ${creativeId ? sql`AND id = ${creativeId}` : sql``}`;
  });
}

/**
 * Make the day's post for every creative a person may approve, and hang it
 * on the creative so the review queue shows the post and not only its words.
 *
 * One placement per creative, the first the brief asked for in this kind:
 * the queue is where somebody decides whether this post goes out, and one
 * frame answers that. A blocked creative gets none, because nobody is going
 * to approve it and a picture of it only looks finished.
 *
 * A kind the brief has no format for falls back to an image rather than to
 * nothing, and the creative records the kind it actually became.
 */
async function attachPosts(opts: {
  orgId: string;
  runId: string;
  node: { id: string; path: string; kind: string };
  kind: PostKind;
  /** The style this slot makes each kind in. */
  styleOf?: (kind: PostKind) => PostStyle;
  /** What the template chooser reads about the campaign, beside each card. */
  templateContext?: { objective: string | null; hook: string | null; offers: string | null; campaign: string | null };
  /** The festival a festive template builds the post around: the run's occasion, else the campaign's name. */
  festival?: Festival | null;
  /** What the run's cards were written for, and what the project holds, so each post's template suits both. */
  angle?: CardAngle;
  material?: CardMaterial;
  /** What has worked here, which steers "Let AI choose" as it does in the studio. */
  learned?: { scores: readonly Blended[]; explore: number; seed: string } | null;
  formats: readonly string[];
  talkingPoints: readonly string[];
  neverSay: readonly string[];
  /** The location and price lines the cover prints. */
  facts?: AdFacts | null;
  /** What a Hindi creative's own lines are built from: the place and the approved prices. */
  ground?: Pick<Ground, "location" | "configurations" | "neverSay">;
  luxury?: boolean;
  /** What the pixel gate measures the picture's prices and registration against. */
  pixel?: PixelContext | null;
  designers?: Partial<Drivers>;
  filmDrivers?: Partial<FilmDrivers>;
  briefId?: string;
  actorUserId?: string;
}): Promise<void> {
  const kind = placementsFor(opts.kind, opts.formats).length ? opts.kind : "IMAGE";
  const waitForPerson = (id: string) => holdForPerson(opts.orgId, opts.runId, id);
  // The style's size, template, face and length, each as far as the brief
  // and the catalog still have it; anything gone is the studio's default.
  const style = opts.styleOf?.(kind) ?? null;
  const sizes = placementsFor(kind, opts.formats);
  const placement = style?.size && sizes.includes(style.size) ? style.size : sizes[0];
  if (!placement) return holdForPerson(opts.orgId, opts.runId);
  // A template drawn for another shape is the AI's choice instead.
  const styleTemplate = currentTemplateKey(style?.template);
  // A template the project cannot make (no offer, no dated site photo) is
  // the AI's choice too, among the ones it can.
  const makes = (key: string) => !opts.material || !templateGap(kind, key, opts.material);
  const picked =
    styleTemplate &&
    isDesignTemplate(styleTemplate, kind) &&
    styleTemplate !== PRESENTER_TEMPLATE.key &&
    templateFits(styleTemplate, kind, placement) &&
    makes(styleTemplate) &&
    cardFits({ angle: opts.angle ?? "GENERAL", segment: "", lead: null, invites: true }, templateAngle(kind, styleTemplate), styleTemplate)
      ? styleTemplate
      : null;
  const font = style?.font && FONTS.some((f) => f.key === style.font) ? style.font : null;
  const slides = kind === "CAROUSEL" && style?.slides ? slideCount(style.slides) : undefined;

  const materials = await loadMaterials(opts.orgId, opts.node);
  if (!materials.backgrounds.length) return holdForPerson(opts.orgId, opts.runId);
  // A video is one Seedance film since 5 October 2026 (the client: every
  // video on Seedance 2.5), never three frames brought to life.
  if (kind === "VIDEO") return attachFilms(opts, placement, styleTemplate, font, materials.agentNo ?? null);

  const creatives = await withTenant(opts.orgId, async (sql) =>
    sql<{ id: string; language: string; segment: string; headline: string; body: string; cta: string; local: unknown }[]>`
      SELECT id, language, segment, headline, body, cta, inputs -> 'local' AS local FROM post_creatives
      WHERE org_id = ${opts.orgId} AND run_id = ${opts.runId} AND verdict <> 'FAIL'
      ORDER BY language, segment`,
  );
  // Every creative of the run is this kind, picture or not: a carousel whose
  // design failed read "Image" in the queue, because only a stored post set it.
  await withTenant(opts.orgId, async (sql) => {
    await sql`UPDATE post_creatives SET kind = ${kind} WHERE org_id = ${opts.orgId} AND run_id = ${opts.runId} AND kind <> ${kind}`;
  });

  let seed = Math.floor(Date.now() / 86_400_000);
  for (const c of creatives) {
    seed += 1;
    // The run's lease, held while each post is made: a carousel takes
    // minutes, eight of them outlast the lease, and a second worker would
    // then claim the run and pay to design them again.
    await withTenant(opts.orgId, async (sql) => {
      await sql`UPDATE post_runs SET lease_until = ${leaseUntil(new Date())} WHERE org_id = ${opts.orgId} AND id = ${opts.runId} AND state = 'RUNNING'`;
    });
    // A picture is paid for, so the plan is asked first. Refused, the
    // approver is told why there is no picture and judges the words alone.
    const entitled = await entitle({ orgId: opts.orgId, nodeId: opts.node.id, needs: postNeeds(kind, slides ?? null) });
    if (!entitled.ok) {
      const review = { passed: false, attempts: 0, problems: [{ code: entitled.code, text: entitled.message }], model: "none" };
      await withTenant(opts.orgId, async (sql) => {
        await sql`
          UPDATE post_creatives SET post_review = ${sql.json(review as unknown as JSONValue)}
          WHERE org_id = ${opts.orgId} AND id = ${c.id}`;
      });
      await waitForPerson(c.id);
      continue;
    }
    // The template: the one the style names, or one chosen for this card the
    // way the studio's "Let AI choose" chooses, from what has worked first.
    const template = await resolveTemplate({
      picked,
      kind,
      context: {
        headline: c.headline,
        body: c.body,
        cta: c.cta,
        objective: opts.templateContext?.objective ?? null,
        hook: opts.templateContext?.hook ?? null,
        offers: opts.templateContext?.offers ?? null,
        campaign: opts.templateContext?.campaign ?? null,
        placement,
      },
      driver: opts.designers?.choose,
      // Only templates this card suits and the project can make.
      allow: (key) =>
        makes(key) &&
        cardFits(
          {
            angle: opts.angle ?? "GENERAL",
            segment: c.segment,
            lead: cardLead(c, { talkingPoints: opts.talkingPoints, configurations: opts.ground?.configurations ?? [] }),
            invites: invitesVisit(c.cta),
          },
          templateAngle(kind, key),
          key,
        ),
      learned: opts.learned
        ? { scores: opts.learned.scores, explore: opts.learned.explore, rand: seeded(`${opts.learned.seed}:${c.id}`) }
        : undefined,
    });
    // A creative in Hindi prints its place, prices and points in Hindi.
    const local = storedLocal(c.local);
    const facts = local && opts.ground ? adFacts(opts.ground, { language: c.language, place: local.place }) : opts.facts ?? null;
    const designed = await designPost({
      kind,
      placement,
      copy: { headline: c.headline, body: c.body, cta: c.cta },
      talkingPoints: local && opts.ground
        ? pointsFor(opts.talkingPoints, local, opts.ground, c.language, { luxury: opts.luxury })
        : opts.talkingPoints,
      neverSay: opts.neverSay,
      materials,
      seed,
      template,
      festival: opts.festival ?? null,
      slides,
      font,
      facts,
      luxury: opts.luxury,
      pixel: opts.pixel ?? null,
      drivers: opts.designers,
    });
    if (!designed.ok) {
      // Said on the creative, or the approver sees a card with no picture
      // and no reason.
      const review = { passed: false, attempts: 0, problems: [{ code: designed.code ?? "DID_NOT_PASS", text: designed.message }], model: "none" };
      await withTenant(opts.orgId, async (sql) => {
        await sql`
          UPDATE post_creatives SET post_review = ${sql.json(review as unknown as JSONValue)}
          WHERE org_id = ${opts.orgId} AND id = ${c.id}`;
      });
      await waitForPerson(c.id);
      continue;
    }
    const pixel = designed.pixel;
    // A pixel FAIL is a picture that did not pass, like any other check.
    const review =
      pixel?.verdict === "FAIL"
        ? {
            ...designed.review,
            passed: false,
            problems: [
              ...designed.review.problems,
              ...pixel.findings.filter((f) => f.verdict === "FAIL").map((f) => ({ code: `PX_${f.code}`, text: f.text })),
            ],
          }
        : designed.review;
    const meterAs = (passed: boolean, frames: number) =>
      meterPost({
        orgId: opts.orgId,
        nodeId: opts.node.id,
        postId: c.id,
        kind,
        frames,
        passed,
        attempts: designed.review.attempts,
        agentUsd: designed.review.agent?.usd,
        clips: designed.review.motion?.attempts,
        source: "creative",
      });
    if (!review.passed || !pixel) {
      await meterAs(false, designed.files.length);
      // Never a picture that failed a check: the approver is told why there
      // is none, and approves or rejects the words alone.
      await withTenant(opts.orgId, async (sql) => {
        await sql`
          UPDATE post_creatives SET post_review = ${sql.json(review as unknown as JSONValue)}
          WHERE org_id = ${opts.orgId} AND id = ${c.id}`;
      });
      await waitForPerson(c.id);
      continue;
    }
    const stored = await storePostFiles(opts.orgId, opts.node.id, c.id, designed.files);
    if (!stored) {
      await waitForPerson(c.id);
      continue;
    }
    await withTenant(opts.orgId, async (sql) => {
      await sql`
        UPDATE post_creatives
        SET kind = ${kind}, media = ${sql.json(
          // The facts ride with the files, so publishing can check the price
          // printed on the picture against the price approved that day, and
          // each file's hash, so it can tell the file that passed.
          withHashes(stored, pixel).map((m) => ({ ...m, placement, facts: designed.inputs.facts ?? facts, agentNo: materials.agentNo ?? null })) as unknown as JSONValue,
        )}, post_review = ${sql.json(review as unknown as JSONValue)}, pixel = ${sql.json(pixel as unknown as JSONValue)}
        WHERE org_id = ${opts.orgId} AND id = ${c.id}`;
    });
    await auditPixel({ orgId: opts.orgId, actorUserId: null, targetType: "post_creative", targetId: c.id, record: pixel });
    // A HOLD renders and is shown; it waits for a person in either mode.
    if (pixel.verdict !== "PASS") await waitForPerson(c.id);
    await meterAs(true, designed.files.length);
  }
}

/** Films made at once for one run: each is real money, and minutes of the machine. */
const FILMS_AT_ONCE = 2;

/**
 * A scheduled run's videos: one Seedance film per creative, from the style's
 * video template when it names one this card suits, else chosen the way the
 * studio's "Let AI choose" chooses (`chooseFilmTemplate()`). Asked of the plan
 * before each is paid for, the run's lease renewed while it is made, and the
 * film hung on its creative with its pixel verdict, exactly as a picture is.
 * A suite that injects designers and no film drivers makes no film.
 */
async function attachFilms(
  opts: Parameters<typeof attachPosts>[0],
  placement: string,
  styleTemplate: string | null,
  font: string | null,
  agentNo: string | null,
): Promise<void> {
  const creatives = await withTenant(opts.orgId, async (sql) =>
    sql<{ id: string; language: string; segment: string; headline: string; body: string; cta: string }[]>`
      SELECT id, language, segment, headline, body, cta FROM post_creatives
      WHERE org_id = ${opts.orgId} AND run_id = ${opts.runId} AND verdict <> 'FAIL'
      ORDER BY language, segment`,
  );
  const note = async (id: string, code: string, text: string) => {
    const review = { passed: false, attempts: 0, problems: [{ code, text }], model: "none" };
    await withTenant(opts.orgId, async (sql) => {
      await sql`UPDATE post_creatives SET post_review = ${sql.json(review as unknown as JSONValue)} WHERE org_id = ${opts.orgId} AND id = ${id}`;
    });
    await holdForPerson(opts.orgId, opts.runId, id);
  };
  if (!opts.briefId || (opts.designers && !opts.filmDrivers)) {
    for (const c of creatives) await note(c.id, "NO_FILM", "This video was not made here. Make it from the studio.");
    return;
  }
  // The run's lease, held while films are made: a film takes twenty minutes.
  const renew = async () => {
    await withTenant(opts.orgId, async (sql) => {
      await sql`UPDATE post_runs SET lease_until = now() + interval '15 minutes' WHERE org_id = ${opts.orgId} AND id = ${opts.runId} AND state = 'RUNNING'`;
    });
  };
  const ground = opts.ground ? { talkingPoints: opts.talkingPoints, configurations: opts.ground.configurations } : null;
  const one = async (c: (typeof creatives)[number]) => {
    const entitled = await entitle({ orgId: opts.orgId, nodeId: opts.node.id, needs: postNeeds("VIDEO", null) });
    if (!entitled.ok) return note(c.id, entitled.code, entitled.message);
    const own =
      styleTemplate && FILM_TEMPLATES[styleTemplate] && !FILM_TEMPLATES[styleTemplate].never && (!opts.material || !templateGap("VIDEO", styleTemplate, opts.material))
        ? styleTemplate
        : null;
    const template =
      own ??
      (opts.material && ground
        ? await chooseFilmTemplate({
            orgId: opts.orgId,
            node: opts.node,
            card: { ...c, angle: opts.angle ?? "GENERAL" },
            ground,
            material: opts.material,
            context: {
              objective: opts.templateContext?.objective ?? null,
              hook: opts.templateContext?.hook ?? null,
              offers: opts.templateContext?.offers ?? null,
              campaign: opts.templateContext?.campaign ?? null,
              placement,
            },
            driver: opts.designers?.choose,
          })
        : null);
    if (!template) return note(c.id, "NO_FILM", "No video could be chosen for this card.");
    await renew();
    const made = await makeFilm({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId ?? "",
      briefId: opts.briefId!,
      copyId: c.id,
      creative: true,
      placement,
      font,
      plan: { template },
      drivers: opts.filmDrivers,
      onStage: async () => renew(),
    });
    if (!made.ok || !made.handed) return note(c.id, made.ok ? "NO_FILM" : made.code, made.ok ? "The video could not be saved." : made.message);
    const { media, pixel, review } = made.handed;
    await withTenant(opts.orgId, async (sql) => {
      await sql`
        UPDATE post_creatives
        SET kind = 'VIDEO', media = ${sql.json(
          // The facts ride with the file, as a picture's do, so publishing can
          // check the price on the film against the price approved that day.
          (media as Record<string, unknown>[]).map((m) => ({ ...m, placement, facts: opts.facts ?? null, agentNo })) as unknown as JSONValue,
        )}, post_review = ${sql.json(review as unknown as JSONValue)}, pixel = ${sql.json(pixel as unknown as JSONValue)}
        WHERE org_id = ${opts.orgId} AND id = ${c.id}`;
    });
    await auditPixel({ orgId: opts.orgId, actorUserId: null, targetType: "post_creative", targetId: c.id, record: pixel });
    // A HOLD is shown and waits for a person in either mode.
    if (pixel.verdict !== "PASS") await holdForPerson(opts.orgId, opts.runId, c.id);
    await meterVideo({ orgId: opts.orgId, nodeId: opts.node.id, postId: c.id, kind: "FILM", units: 1, passed: true });
  };
  const queue = [...creatives];
  await Promise.all(
    Array.from({ length: Math.min(FILMS_AT_ONCE, queue.length) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        await one(c).catch(() => note(c!.id, "NO_FILM", "The video could not be made. Make it from the studio."));
      }
    }),
  );
}

/**
 * The state code on the registration, which is what makes a regional occasion
 * regional.
 *
 * Read off the phase's own record rather than off the city, because a project
 * in Pune registered with MahaRERA is a Maharashtra project and a city string
 * somebody typed is not an answer a festival should hang on. No record means
 * no region, and `pickOccasion()` then matches only the nationwide ones.
 *
 * An exempt phase's record carries no state code; the exemption attested on
 * its project does, so that is read next.
 */
async function stateCodeFor(orgId: string, path: string): Promise<string | null> {
  const rows = await withTenant(orgId, async (sql) => {
    return sql<{ state_code: string | null }[]>`
      SELECT state_code FROM (
        SELECT r.state_code, 0 AS rank
        FROM registration_records r
        JOIN scope_nodes n ON n.id = r.scope_node_id
        WHERE r.org_id = ${orgId} AND (n.path::text = ${path} OR n.path::text LIKE ${path + ".%"})
          AND r.state_code IS NOT NULL
        UNION ALL
        SELECT e.state_code, 1 AS rank
        FROM project_exemptions e
        JOIN scope_nodes n ON n.id = e.scope_node_id
        WHERE e.org_id = ${orgId} AND (n.path @> ${path}::ltree OR n.path <@ ${path}::ltree)
      ) s
      ORDER BY rank
      LIMIT 1`;
  });
  return rows[0]?.state_code ?? null;
}

/**
 * Every approved input this run may build from, by hash.
 *
 * This is what closes the last step of "every pixel traces to a named human
 * who approved it". The Brain sources come from the resolver, the
 * configurations and the assets come from the two reads that already withhold
 * anything unapproved, and the brand marks come from the resolved kit.
 */
async function gatherInputs(
  orgId: string,
  nodeId: string,
): Promise<{
  units: { unitTypeId: string; sha256: string }[];
  assets: { assetId: string; sha256: string }[];
  brand: { role: string; fileId: string; at: string }[];
}> {
  const [{ units }, assets, brand] = await Promise.all([
    approvedUnits(orgId, nodeId),
    approvedAssets(orgId, nodeId),
    resolveBrand(orgId, nodeId),
  ]);
  return {
    units: units.map((u) => ({ unitTypeId: u.id, sha256: u.sha256 })),
    assets: assets.map((a) => ({ assetId: a.id, sha256: a.sha256 })),
    brand: (brand?.files ?? []).map((f) => ({
      role: f.role,
      fileId: f.id,
      at: f.uploadedAt,
    })),
  };
}

/**
 * What the last few runs on this schedule chose, newest first.
 *
 * Two levels, because `DISTINCT ON` has to be ordered by the column it is
 * distinct on. The inner query takes one row per run; the outer one puts
 * those runs in the order that actually means "last few", which is by SLOT.
 *
 * Writing this as a single `DISTINCT ON (run_id) ... ORDER BY run_id` sorts
 * by a uuid, so "the last three runs" was three arbitrary runs. The rotation
 * still looked like it worked most of the time, which is the worst way for
 * this to be wrong: a feed repeats itself every so often and nothing says so.
 */
async function recentChoices(orgId: string, scheduleId: string): Promise<RecentChoice[]> {
  const rows = await withTenant(orgId, async (sql) => {
    return sql<{ template: string; lead_point: string | null; asset_id: string | null }[]>`
      SELECT x.template, x.lead_point, x.asset_id
      FROM (
        SELECT DISTINCT ON (c.run_id)
               c.run_id, c.template, c.lead_point, c.asset_id, r.slot
        FROM post_creatives c
        JOIN post_runs r ON r.id = c.run_id
        WHERE c.org_id = ${orgId} AND r.schedule_id = ${scheduleId}
        ORDER BY c.run_id, c.created_at
      ) x
      ORDER BY x.slot DESC
      LIMIT ${RECENT_DEPTH}`;
  });
  return rows.map((r) => ({
    template: r.template,
    leadPoint: r.lead_point,
    assetId: r.asset_id,
  }));
}

// ---------------------------------------------------------------------------
// The review queue
// ---------------------------------------------------------------------------

export type CreativeRow = {
  id: string;
  runId: string;
  scheduleId: string;
  scheduleName: string;
  nodeName: string;
  language: string;
  segment: Segment;
  headline: string;
  body: string;
  cta: string;
  verdict: Verdict;
  reasons: Reason[];
  template: string;
  leadPoint: string | null;
  occasionName: string | null;
  state: string;
  publishAt: string;
  hardStopAt: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  /** False where the creative changed after somebody decided on it. */
  decisionStands: boolean;
  rejectNote: string | null;
  /** How many approved inputs this traces back to. */
  inputCount: number;
  /** What the day's post became, and its files, when it was made. */
  kind: PostKind;
  media: { key: string; type: string; width: number; height: number; placement?: string }[];
  /** What the post check found, or null when no post was made. */
  postReview: { passed: boolean; problems: { code: string; text: string }[] } | null;
  /** The pixel gate's verdict on the picture, and what it found. Null when there is no picture. */
  pixel: { verdict: "PASS" | "FAIL" | "HOLD"; lines: string[] } | null;
  /** How it goes out once approved: organic, an ad, or both. */
  outlet: Outlet;
  /** For an ad, the schedule's daily budget and how many days it runs. */
  adDailyBudget: number | null;
  adDays: number;
};

type DbCreative = {
  id: string;
  run_id: string;
  schedule_id: string;
  schedule_name: string;
  node_name: string;
  language: string;
  segment: Segment;
  headline: string;
  body: string;
  cta: string;
  verdict: Verdict;
  reasons: Reason[];
  template: string;
  lead_point: string | null;
  occasion_name: string | null;
  state: string;
  publish_at: Date;
  hard_stop_at: Date | null;
  content_sha256: string;
  decided_sha256: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
  reject_note: string | null;
  inputs: CreativeInputs;
  kind: PostKind;
  media: { key: string; type: string; width: number; height: number; placement?: string }[];
  post_review: { passed: boolean; problems: { code: string; text: string }[] } | null;
  pixel: PixelRecord | null;
  outlet: Outlet;
  ad_daily_budget: number | null;
  ad_days: number;
  ground: Ground | null;
  formats: string[] | null;
};

const RANK: Record<Verdict, number> = { PASS: 0, HOLD: 1, FAIL: 2 };

/**
 * What today's gate says about stored words, on the facts they were written
 * against. Null when it would say nothing stricter than what is stored.
 *
 * The gate learned to check things after some creatives were written: one
 * saying "8 min from the station" on a tower with no such fact was stored as
 * cleared. Only ever tighter, for the reason `regateStored()` in the studio
 * gives.
 */
function stricterVerdict(r: {
  verdict: Verdict;
  headline: string;
  body: string;
  cta: string;
  language: string;
  segment: Segment;
  ground: Ground | null;
  formats: string[] | null;
  local?: LocalLines | null;
  angle?: CardAngle;
}): { verdict: Verdict; reasons: Reason[] } | null {
  if (!r.ground || r.verdict === "FAIL") return null;
  const now = gateCopy(
    { headline: r.headline, body: r.body, cta: r.cta },
    { language: r.language, segment: r.segment, ...(r.angle ? { angle: r.angle } : {}) },
    storedGround(r.ground),
    budgetFor(r.formats ?? []),
    r.local,
  );
  return RANK[now.verdict] > RANK[r.verdict] ? now : null;
}

/** The queue's rows, gated again and saved where the gate is now stricter. */
async function regateCreatives(orgId: string, rows: DbCreative[]): Promise<DbCreative[]> {
  const worse: { row: DbCreative; now: { verdict: Verdict; reasons: Reason[] } }[] = [];
  const out = rows.map((r) => {
    if (r.state !== "DRAFT") return r;
    const now = stricterVerdict({ ...r, local: storedLocal(r.inputs?.local), angle: isCardAngle(r.inputs?.angle) ? r.inputs.angle : undefined });
    if (!now) return r;
    worse.push({ row: r, now });
    return { ...r, verdict: now.verdict, reasons: now.reasons };
  });
  if (worse.length) {
    await withTenant(orgId, async (sql) => {
      for (const w of worse) {
        await sql`
          UPDATE post_creatives
          SET verdict = ${w.now.verdict}, reasons = ${sql.json(w.now.reasons as unknown as JSONValue)}
          WHERE org_id = ${orgId} AND id = ${w.row.id} AND state = 'DRAFT' AND verdict = ${w.row.verdict}`;
      }
    }).catch(() => {
      // Shown stricter either way; the next read saves it.
    });
  }
  return out;
}

const toCreative = (r: DbCreative): CreativeRow => {
  const inputs = r.inputs ?? emptyInputs();
  return {
    id: r.id,
    runId: r.run_id,
    scheduleId: r.schedule_id,
    scheduleName: r.schedule_name,
    nodeName: r.node_name,
    language: r.language,
    segment: r.segment,
    headline: r.headline,
    body: r.body,
    cta: r.cta,
    verdict: r.verdict,
    reasons: r.reasons ?? [],
    template: r.template,
    leadPoint: r.lead_point,
    occasionName: r.occasion_name,
    state: r.state,
    publishAt: r.publish_at.toISOString(),
    hardStopAt: r.hard_stop_at ? r.hard_stop_at.toISOString() : null,
    decidedByName: r.decided_by_name,
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    decisionStands: decisionStands({
      contentSha256: r.content_sha256,
      decidedSha256: r.decided_sha256,
    }),
    rejectNote: r.reject_note,
    kind: r.kind,
    media: r.media ?? [],
    postReview: r.post_review ?? null,
    pixel: r.pixel ? { verdict: r.pixel.verdict, lines: pixelSummary(r.pixel).lines } : null,
    outlet: r.outlet ?? "POST",
    adDailyBudget: r.ad_daily_budget ?? null,
    adDays: r.ad_days ?? AD_DAYS_DEFAULT,
    inputCount:
      (inputs.brain?.length ?? 0) +
      (inputs.units?.length ?? 0) +
      (inputs.brand?.length ?? 0) +
      (inputs.asset ? 1 : 0),
  };
};

const CREATIVE_SELECT = (sql: TransactionSql, orgId: string) => sql`
  SELECT c.id, c.run_id, r.schedule_id, s.name AS schedule_name, n.name AS node_name,
         c.language, c.segment, c.headline, c.body, c.cta, c.verdict, c.reasons,
         c.template, c.lead_point, o.name AS occasion_name, c.state,
         r.publish_at, c.hard_stop_at, c.content_sha256, c.decided_sha256,
         u.name AS decided_by_name, c.decided_at, c.reject_note, c.inputs,
         c.kind, c.media, c.post_review, c.pixel, r.outlet, s.ad_daily_budget, s.ad_days,
         c.ground, b.formats
  FROM post_creatives c
  JOIN post_runs r      ON r.id = c.run_id
  JOIN post_schedules s ON s.id = r.schedule_id
  JOIN campaign_briefs b ON b.id = s.brief_id
  JOIN scope_nodes n    ON n.id = s.scope_node_id
  LEFT JOIN occasions o ON o.id = c.occasion_id
  LEFT JOIN users u     ON u.id = c.decided_by
  WHERE c.org_id = ${orgId}
`;

/**
 * Everything waiting on a person, soonest publish time first.
 *
 * Blocked creatives are included rather than hidden. A refusal nobody can see
 * is a refusal nobody can fix, and the reason usually names something missing
 * from the Brain rather than something wrong with the writing. They sit after
 * the ones somebody can actually act on.
 */
export async function reviewQueue(
  orgId: string,
  opts: { limit?: number; scopes?: string[] } = {},
): Promise<CreativeRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  if (opts.scopes && !opts.scopes.length) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<DbCreative[]>`
      ${CREATIVE_SELECT(sql, orgId)} AND c.state = 'DRAFT'
      ${opts.scopes ? sql`AND n.path <@ ANY(${opts.scopes}::ltree[])` : sql``}
      ORDER BY (c.verdict = 'FAIL'), r.publish_at, c.language, c.segment
      LIMIT ${limit}`;
  });
  const gated = await regateCreatives(orgId, rows);
  // A creative the gate now refuses moves down with the other blocked ones.
  return gated
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(a.r.verdict === "FAIL") - Number(b.r.verdict === "FAIL") || a.i - b.i)
    .map(({ r }) => toCreative(r));
}

export type ApprovedRow = {
  id: string;
  nodeName: string;
  kind: PostKind;
  headline: string;
  publishAt: string;
  destinations: string[];
  outlet: Outlet;
  /** Why it has not gone out yet, when the publisher said. */
  publishNote: string | null;
};

/**
 * Approved and not handed to a publisher yet: what goes out next. Without
 * it an approved post left the queue and appeared nowhere until it went
 * live, and the queue's empty state told a person to set up a schedule.
 */
export async function approvedUpcoming(
  orgId: string,
  opts: { scopes?: string[]; now?: Date } = {},
): Promise<ApprovedRow[]> {
  if (opts.scopes && !opts.scopes.length) return [];
  const now = opts.now ?? new Date();
  const rows = await withTenant(orgId, async (sql) => sql<{
    id: string; node_name: string; kind: string; headline: string; publish_at: Date;
    destinations: string[]; outlet: string; publish_note: string | null;
  }[]>`
    SELECT c.id, n.name AS node_name, c.kind, c.headline, r.publish_at, s.destinations, r.outlet, c.publish_note
    FROM post_creatives c
    JOIN post_runs r      ON r.id = c.run_id
    JOIN post_schedules s ON s.id = r.schedule_id
    JOIN scope_nodes n    ON n.id = s.scope_node_id
    WHERE c.org_id = ${orgId} AND c.state = 'APPROVED' AND s.active
      AND r.publish_at > ${new Date(now.getTime() - 6 * 3_600_000)}
      AND NOT EXISTS (SELECT 1 FROM publish_targets t WHERE t.post_creative_id = c.id)
      ${opts.scopes ? sql`AND n.path <@ ANY(${opts.scopes}::ltree[])` : sql``}
    ORDER BY r.publish_at
    LIMIT 30`);
  return rows.map((r) => ({
    id: r.id,
    nodeName: r.node_name,
    kind: (r.kind as PostKind) ?? "IMAGE",
    headline: r.headline,
    publishAt: r.publish_at.toISOString(),
    destinations: r.destinations ?? [],
    outlet: (r.outlet === "AD" || r.outlet === "BOTH" ? r.outlet : "POST") as Outlet,
    publishNote: r.publish_note,
  }));
}

export async function listCreatives(orgId: string, runId: string): Promise<CreativeRow[]> {
  if (!isNodeId(runId)) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<DbCreative[]>`
      ${CREATIVE_SELECT(sql, orgId)} AND c.run_id = ${runId}
      ORDER BY (c.verdict = 'FAIL'), c.language, c.segment`;
  });
  return (await regateCreatives(orgId, rows)).map(toCreative);
}

export type DecisionOutcome = { ok: true } | { ok: false; code: string; message: string };

/**
 * A person says yes.
 *
 * Four refusals, and each of them is a thing that really happens. It is not
 * theirs to decide twice. A FAIL is not approvable at all, because the gate
 * refused it and an approval over the top of a refusal would make every FAIL
 * a suggestion. Its slot has passed, which expires rather than slips. And its
 * occasion has passed, which is the false-offer case: "no floor rise until
 * Diwali", approved on the 10th when Diwali was the 8th, is a claim a buyer
 * withdraws over under Section 12.
 *
 * The approval pins the content hash, which is the mechanism
 * `brain_signatures`, `asset_approvals` and `unit_type_approvals` all use.
 */
export async function approveCreative(opts: {
  orgId: string;
  actorUserId: string;
  creativeId: string;
  now?: Date;
}): Promise<DecisionOutcome> {
  const now = opts.now ?? new Date();
  if (!isNodeId(opts.creativeId)) {
    return { ok: false, code: "UNKNOWN", message: "That post is not in this organisation." };
  }

  const found = await withTenant(opts.orgId, async (sql) => {
    const [r] = await sql<
      {
        state: string;
        verdict: Verdict;
        content_sha256: string;
        hard_stop_at: Date | null;
        publish_at: Date;
        headline: string;
        body: string;
        cta: string;
        language: string;
        segment: Segment;
        ground: Ground | null;
        formats: string[] | null;
      }[]
    >`
      SELECT c.state, c.verdict, c.content_sha256, c.hard_stop_at, r.publish_at,
             c.headline, c.body, c.cta, c.language, c.segment, c.ground, b.formats
      FROM post_creatives c
      JOIN post_runs r ON r.id = c.run_id
      JOIN post_schedules s ON s.id = r.schedule_id
      JOIN campaign_briefs b ON b.id = s.brief_id
      WHERE c.org_id = ${opts.orgId} AND c.id = ${opts.creativeId}`;
    return r ?? null;
  });
  if (!found) {
    return { ok: false, code: "UNKNOWN", message: "That post is not in this organisation." };
  }
  if (found.state !== "DRAFT") {
    return { ok: false, code: "DECIDED", message: "Somebody has already decided on this one." };
  }
  // Gated again first: words that cleared under an older gate are not
  // approved on the strength of that.
  const stricter = stricterVerdict(found);
  if (stricter) {
    await withTenant(opts.orgId, async (sql) => {
      await sql`
        UPDATE post_creatives
        SET verdict = ${stricter.verdict}, reasons = ${sql.json(stricter.reasons as unknown as JSONValue)}
        WHERE org_id = ${opts.orgId} AND id = ${opts.creativeId} AND state = 'DRAFT'`;
    });
  }
  const row = stricter ? { ...found, verdict: stricter.verdict } : found;
  if (row.verdict === "FAIL") {
    return {
      ok: false,
      code: "BLOCKED",
      message: "This one was blocked by the checks. Fix what it names, and it can be written again.",
    };
  }
  const late = lateness(
    { hardStopAt: row.hard_stop_at },
    { publishAt: row.publish_at },
    now,
  );
  if (late.late) {
    return {
      ok: false,
      code: late.code ?? "LATE",
      message:
        late.code === "OCCASION_PASSED"
          ? "The occasion this was written for has passed."
          : "The time this was written for has passed.",
    };
  }

  await withTenant(opts.orgId, async (sql) => {
    await sql`
      UPDATE post_creatives
      SET state = 'APPROVED', decided_by = ${opts.actorUserId}, decided_at = now(),
          decided_sha256 = ${row.content_sha256}
      WHERE org_id = ${opts.orgId} AND id = ${opts.creativeId} AND state = 'DRAFT'`;
  });

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "post.creative_approved",
    targetType: "post_creative",
    targetId: opts.creativeId,
    metadata: { verdict: row.verdict },
  });
  return { ok: true };
}

export async function rejectCreative(opts: {
  orgId: string;
  actorUserId: string;
  creativeId: string;
  note: string;
}): Promise<DecisionOutcome> {
  if (!isNodeId(opts.creativeId)) {
    return { ok: false, code: "UNKNOWN", message: "That post is not in this organisation." };
  }
  const note = opts.note.trim().slice(0, 500) || null;

  const done = await withTenant(opts.orgId, async (sql) => {
    const [r] = await sql<{ id: string; content_sha256: string }[]>`
      UPDATE post_creatives
      SET state = 'REJECTED', decided_by = ${opts.actorUserId}, decided_at = now(),
          decided_sha256 = content_sha256, reject_note = ${note}
      WHERE org_id = ${opts.orgId} AND id = ${opts.creativeId} AND state = 'DRAFT'
      RETURNING id, content_sha256`;
    return r ?? null;
  });
  if (!done) {
    return { ok: false, code: "DECIDED", message: "Somebody has already decided on this one." };
  }

  // The note is the reviewer's own words about their own creative, so it
  // lives in tenant data and never in `audit_log`.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "post.creative_rejected",
    targetType: "post_creative",
    targetId: opts.creativeId,
    metadata: { noted: note !== null },
  });
  return { ok: true };
}

/**
 * Nothing publishes unseen, and nothing waits forever.
 *
 * A creative nobody reviewed by its publish time plus the grace window
 * expires, and it does not slip to the next slot. A slot that slipped would
 * arrive beside the next slot's own creative, so two posts would land the day
 * somebody finally opened the queue, and the one about last Tuesday would be
 * the one they had to explain.
 *
 * An approved creative past its occasion expires too, for the reason the
 * hard stop exists at all.
 */
export async function expireStale(opts: {
  orgId: string;
  now?: Date;
}): Promise<{ creatives: number; runs: number }> {
  const now = opts.now ?? new Date();
  const graceMs = 6 * 60 * 60 * 1000;
  const cutoff = new Date(now.getTime() - graceMs);

  return withTenant(opts.orgId, async (sql) => {
    const stale = await sql<{ id: string }[]>`
      UPDATE post_creatives c
      SET state = 'EXPIRED'
      FROM post_runs r
      WHERE r.id = c.run_id AND c.org_id = ${opts.orgId}
        AND c.state IN ('DRAFT', 'APPROVED')
        AND (r.publish_at <= ${cutoff}
             OR (c.hard_stop_at IS NOT NULL AND c.hard_stop_at <= ${now}))
        -- Handed to a publisher already: its publications say how it stands,
        -- and one still processing is not stale.
        AND NOT EXISTS (SELECT 1 FROM publish_targets t WHERE t.post_creative_id = c.id)
      RETURNING c.id`;

    // A run whose creatives are all decided is finished. RELEASED where at
    // least one was approved, EXPIRED where none was: the difference is
    // whether the slot produced anything, and a screen that called both
    // "done" would hide every quiet failure.
    const runs = await sql<{ id: string }[]>`
      UPDATE post_runs r
      SET state = CASE
            WHEN EXISTS (SELECT 1 FROM post_creatives c
                          WHERE c.run_id = r.id AND c.state = 'APPROVED')
            THEN 'RELEASED' ELSE 'EXPIRED' END,
          finished_at = coalesce(finished_at, now())
      WHERE r.org_id = ${opts.orgId} AND r.state = 'GENERATED'
        AND NOT EXISTS (SELECT 1 FROM post_creatives c
                         WHERE c.run_id = r.id AND c.state = 'DRAFT'
                           AND c.verdict <> 'FAIL')
      RETURNING r.id`;

    return { creatives: stale.length, runs: runs.length };
  });
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export type RunnerReport = {
  orgsScanned: number;
  created: number;
  executed: number;
  refused: number;
  failed: number;
  expiredCreatives: number;
  closedRuns: number;
  notes: string[];
};

/**
 * One pass over every tenant: create the rows that are due, do the work, tidy
 * up behind.
 *
 * Bounded on purpose. The command claims due work, does a fixed amount of it
 * and exits, so it sits behind a cron, a scheduled container task or a queue
 * consumer without caring which. What it must never become is one long
 * request: generation takes minutes, request timeouts vary by host, and a
 * timeout mid-run with no lease is how one slot becomes two ads.
 */
export async function runDue(opts: {
  now?: Date;
  /** Limit to these tenants. The checks use it so a suite never touches another. */
  orgIds?: string[];
  /** How many runs one pass will execute. */
  maxRuns?: number;
  driver?: CopyDriver;
  /**
   * Only these schedules' runs are executed. A check passes its own, so it
   * never writes, or pays to design, a post for somebody's real schedule.
   */
  scheduleIds?: string[];
  /** The image and checking models, injected by the checks. */
  designers?: Partial<Drivers>;
  /** The reader for a card in a script of its own. */
  reader?: ReadDriver;
} = {}): Promise<RunnerReport> {
  const now = opts.now ?? new Date();
  const maxRuns = opts.maxRuns ?? 25;

  const orgs = await controlDb<{ id: string }[]>`
    SELECT id FROM orgs
    WHERE status <> 'SUSPENDED'
      ${opts.orgIds ? controlDb`AND id = ANY(${opts.orgIds})` : controlDb``}
    ORDER BY created_at`;

  const report: RunnerReport = {
    orgsScanned: orgs.length,
    created: 0,
    executed: 0,
    refused: 0,
    failed: 0,
    expiredCreatives: 0,
    closedRuns: 0,
    notes: [],
  };

  let budget = maxRuns;

  for (const org of orgs) {
    report.created += await materialiseRuns({ orgId: org.id, now });

    const due = await withTenant(org.id, async (sql) => {
      return sql<{ id: string; created_by: string | null }[]>`
        SELECT r.id, s.created_by
        FROM post_runs r
        JOIN post_schedules s ON s.id = r.schedule_id
        WHERE r.org_id = ${org.id}
          ${opts.scheduleIds ? sql`AND r.schedule_id = ANY(${opts.scheduleIds})` : sql``}
          AND r.generate_at <= ${now}
          AND r.attempts < 3
          AND (r.state = 'PENDING'
               OR (r.state = 'RUNNING'
                   AND (r.lease_until IS NULL OR r.lease_until <= ${now})))
        ORDER BY r.generate_at
        LIMIT ${Math.max(budget, 0)}`;
    });

    for (const run of due) {
      if (budget <= 0) break;
      budget -= 1;
      try {
        const outcome = await executeRun({
          orgId: org.id,
          runId: run.id,
          actorUserId: run.created_by ?? "",
          now,
          driver: opts.driver,
          reader: opts.reader,
          designers: opts.designers,
        });
        if (outcome.ok) report.executed += 1;
        else if (outcome.code === "NOT_CLAIMABLE") report.notes.push("a run was already held");
        else report.refused += 1;
      } catch (e) {
        // A run that threw is left FAILED with its attempt counted, so the
        // next pass retries it and the third leaves it alone. A worker that
        // retried forever would call the model forever.
        report.failed += 1;
        await withTenant(org.id, async (sql) => {
          await sql`
            UPDATE post_runs
            SET state = 'FAILED', lease_id = NULL, lease_until = NULL,
                refusal_detail = ${String(e).slice(0, 200)}, finished_at = now()
            WHERE org_id = ${org.id} AND id = ${run.id} AND attempts >= 3`;
          await sql`
            UPDATE post_runs SET state = 'PENDING', lease_id = NULL, lease_until = NULL
            WHERE org_id = ${org.id} AND id = ${run.id} AND attempts < 3`;
        });
      }
    }

    const tidied = await expireStale({ orgId: org.id, now });
    report.expiredCreatives += tidied.creatives;
    report.closedRuns += tidied.runs;
  }

  return report;
}

/** One file of one scheduled creative's post, for the route that serves it. */
export async function creativeMedia(
  orgId: string,
  creativeId: string,
  index: number,
): Promise<{ url: string; key: string; type: string } | null> {
  if (!isNodeId(creativeId) || !Number.isInteger(index) || index < 0) return null;
  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ media: { key: string; type: string }[] }[]>`
      SELECT media FROM post_creatives WHERE org_id = ${orgId} AND id = ${creativeId}`;
    return r ?? null;
  });
  const item = row?.media?.[index];
  if (!item) return null;
  const link = await assetUrl(item.key, item.type);
  if (!link.ok) return null;
  return { url: link.url, key: item.key, type: item.type };
}
