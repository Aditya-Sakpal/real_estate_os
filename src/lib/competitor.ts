import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { audit, withTenant } from "./db/index.ts";
import { askJson, hear, type AskDriver, type HearDriver } from "./generate.ts";
import { CAROUSEL_TEMPLATE_CATEGORIES, TEMPLATE_CATEGORIES, VIDEO_TEMPLATE_CATEGORIES } from "./template-rules.ts";
import {
  PICTURE_TYPES,
  READ_COST_USD,
  capProblem,
  fileProblem,
  frameTimes,
  readForm,
  readerInstruction,
  readerSchema,
  readingOf,
  type AdKind,
  type Platform,
  type Reading,
} from "./competitor-rules.ts";

/**
 * Competitor ads a person saved: read into our vocabulary, kept as one
 * picture and the words, and counted in the learning. `competitor-rules.ts`
 * decides; this reads, writes and asks the model.
 */

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");

/** The model that reads an ad. Small: it describes, it does not judge. */
export const READER_MODEL = process.env.COMPETITOR_READER_MODEL || "gpt-5-mini";

export type ReaderDrivers = { ask: AskDriver; hear: HearDriver };
let injected: ReaderDrivers | null = null;

/** For the checks: an injected reader beats the models. */
export function useCompetitorReader(d: ReaderDrivers | null): void {
  injected = d;
}

const drivers = (): ReaderDrivers => injected ?? { ask: askJson, hear };

/** Every design style an ad may be closest to, named with its kind. */
function designsFor(kind: AdKind): { key: string; label: string }[] {
  const list = kind === "VIDEO" ? VIDEO_TEMPLATE_CATEGORIES : kind === "CAROUSEL" ? CAROUSEL_TEMPLATE_CATEGORIES : TEMPLATE_CATEGORIES;
  return list.filter((c) => !c.story).map((c) => ({ key: c.key, label: c.label }));
}

async function videoParts(video: Buffer): Promise<{ frames: Buffer[]; audio: Buffer | null }> {
  const dir = await mkdtemp(join(tmpdir(), "salesdesk-rival-"));
  try {
    const src = join(dir, "in.mp4");
    await writeFile(src, video);
    const probed = await exec(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]).catch(() => null);
    const seconds = probed ? Number(String(probed.stdout).trim()) : NaN;
    const frames: Buffer[] = [];
    for (const [i, at] of frameTimes(Number.isFinite(seconds) ? seconds : null).entries()) {
      const out = join(dir, `f${i}.jpg`);
      await exec(FFMPEG, ["-y", "-loglevel", "error", "-ss", String(at), "-i", src, "-frames:v", "1", "-vf", "scale=720:-2", out]).catch(() => {});
      const f = await readFile(out).catch(() => null);
      if (f) frames.push(f);
    }
    const mp3 = join(dir, "a.mp3");
    await exec(FFMPEG, ["-y", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-t", "120", mp3]).catch(() => {});
    const audio = await readFile(mp3).catch(() => null);
    return { frames, audio: audio && audio.length > 1000 ? audio : null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A picture small enough to keep and to send: 1,280 pixels on the long side, JPEG. */
async function fitPicture(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}

/**
 * Read one ad. A picture is read whole; a video is read at three frames with
 * what it says. Returns the reading and the picture to keep, or why not.
 */
export async function readAd(file: { bytes: Buffer; type: string }, kind: AdKind): Promise<
  { ok: true; reading: Reading; poster: Buffer; costUsd: number } | { ok: false; message: string; poster: Buffer | null; costUsd: number }
> {
  const d = drivers();
  const designs = designsFor(kind);
  const keys = designs.map((x) => x.key);
  const isPicture = (PICTURE_TYPES as readonly string[]).includes(file.type);
  let pictures: Buffer[];
  let spoken = "";
  if (isPicture) {
    pictures = [await fitPicture(file.bytes).catch(() => file.bytes)];
  } else {
    const parts = await videoParts(file.bytes);
    pictures = parts.frames;
    if (!pictures.length) return { ok: false, message: "That video could not be opened.", poster: null, costUsd: 0 };
    if (parts.audio) {
      const heard = await d.hear({ audio: { bytes: parts.audio, type: "audio/mpeg" } });
      if (heard.ok) spoken = heard.text.slice(0, 2000);
    }
  }
  const poster = pictures[Math.min(1, pictures.length - 1)];
  const costUsd = isPicture ? READ_COST_USD.picture : READ_COST_USD.video;
  const answer = await d.ask({
    model: READER_MODEL,
    name: "competitor_ad",
    system: readerInstruction(designs),
    effort: "low",
    schema: readerSchema(keys),
    parts: [
      { text: isPicture ? "The advertisement:" : `Three frames of a video advertisement.${spoken ? ` What it says: ${spoken}` : " It says nothing that could be heard."}` },
      ...pictures.map((p) => ({ image: { bytes: p, type: "image/jpeg", detail: "high" as const } })),
    ],
  });
  if (!answer.ok) return { ok: false, message: "The ad could not be read. Try again later.", poster, costUsd };
  const reading = readingOf(answer.value, kind, keys);
  if (!reading) return { ok: false, message: "The ad could not be read. Try again later.", poster, costUsd };
  if (spoken && !reading.textSeen.includes(spoken.slice(0, 40))) {
    reading.textSeen = `${reading.textSeen}\n${spoken}`.slice(0, 4000);
  }
  return { ok: true, reading, poster, costUsd };
}

const istMonthStart = (now: Date) => {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 330 * 60_000);
};

type Node = { id: string; path: string; kind: string; project_path: string | null; project_id: string | null };

async function nodeOf(orgId: string, nodeId: string): Promise<Node | null> {
  return withTenant(orgId, async (sql) => {
    const [n] = await sql<Node[]>`
      SELECT n.id, n.path::text AS path, n.kind,
             (SELECT p.path::text FROM scope_nodes p WHERE p.org_id = n.org_id AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project_path,
             (SELECT p.id::text FROM scope_nodes p WHERE p.org_id = n.org_id AND p.kind = 'PROJECT' AND p.path @> n.path LIMIT 1) AS project_id
      FROM scope_nodes n WHERE n.org_id = ${orgId} AND n.id = ${nodeId}`;
    return n ?? null;
  });
}

/**
 * Reads of each kind this project has used this month. A read was paid for
 * whether or not the ad is still saved, so reads are counted from the audit
 * trail (`competitor.ad_added` carries the project): removing an ad and
 * saving another must not buy a read the month has already spent. The saved
 * rows still count, for reads recorded before the trail named the project.
 */
export async function readsThisMonth(orgId: string, projectPath: string, now = new Date()): Promise<{ pictures: number; videos: number }> {
  const since = istMonthStart(now);
  const [r] = await withTenant(orgId, (sql) => sql<{ pictures: number; videos: number }[]>`
    WITH saved AS (
      SELECT count(*) FILTER (WHERE c.kind <> 'VIDEO')::int AS pictures, count(*) FILTER (WHERE c.kind = 'VIDEO')::int AS videos
      FROM competitor_ads c JOIN scope_nodes n ON n.id = c.scope_node_id
      WHERE c.org_id = ${orgId} AND n.path <@ ${projectPath}::ltree AND c.created_at >= ${since}
    ), done AS (
      SELECT count(*) FILTER (WHERE a.metadata->>'kind' <> 'VIDEO')::int AS pictures, count(*) FILTER (WHERE a.metadata->>'kind' = 'VIDEO')::int AS videos
      FROM audit_log a
      WHERE a.org_id = ${orgId} AND a.action = 'competitor.ad_added' AND a.created_at >= ${since}
        AND a.metadata->>'project' = (SELECT p.id::text FROM scope_nodes p WHERE p.org_id = ${orgId} AND p.path = ${projectPath}::ltree)
    )
    SELECT greatest(saved.pictures, done.pictures) AS pictures, greatest(saved.videos, done.videos) AS videos FROM saved, done`);
  return r ?? { pictures: 0, videos: 0 };
}

export type AddResult = { ok: true; id: string; read: boolean; flagged: boolean } | { ok: false; message: string };

/**
 * A person saved a competitor's ad against one of our projects or towers.
 * Every check is asked before the model is paid: the file, the form, the
 * place, then this month's reads.
 */
export async function addCompetitorAd(opts: {
  orgId: string;
  userId: string;
  nodeId: string;
  file: { bytes: Buffer; type: string };
  carousel: boolean;
  form: { competitor: string; projectName: string; locality: string; platform: string; runningSince: string };
  today: string;
  now?: Date;
}): Promise<AddResult> {
  const bad = fileProblem({ type: opts.file.type, size: opts.file.bytes.length });
  if (bad) return { ok: false, message: bad };
  const form = readForm({ ...opts.form, today: opts.today });
  if (!form.ok) return form;
  const node = await nodeOf(opts.orgId, opts.nodeId);
  if (!node || !node.project_path) return { ok: false, message: "Choose one of your projects or towers to compare it with." };
  const isVideo = !(PICTURE_TYPES as readonly string[]).includes(opts.file.type);
  // A file that only says it is a picture is refused here, before a read is spent on it.
  if (!isVideo && !(await sharp(opts.file.bytes).metadata().then((m) => !!m.width).catch(() => false))) {
    return { ok: false, message: "That file could not be opened as a picture." };
  }
  const kind: AdKind = isVideo ? "VIDEO" : opts.carousel ? "CAROUSEL" : "IMAGE";
  const used = await readsThisMonth(opts.orgId, node.project_path, opts.now);
  const capped = capProblem(isVideo ? "video" : "picture", isVideo ? used.videos : used.pictures);
  if (capped) return { ok: false, message: capped };

  const read = await readAd(opts.file, kind);
  const poster = read.poster ? await fitPicture(read.poster).catch(() => null) : null;
  const reading = read.ok ? read.reading : null;
  const [row] = await withTenant(opts.orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO competitor_ads (org_id, scope_node_id, competitor, project_name, locality, platform, kind, running_since,
                                seen_on, poster, poster_type, text_seen, tags, flags, read_state, read_error, read_cost_usd, added_by)
    VALUES (${opts.orgId}, ${node.id}, ${form.value.competitor}, ${form.value.projectName}, ${form.value.locality ?? reading?.tags.locality ?? null},
            ${form.value.platform}, ${kind}, ${form.value.runningSince}, ${opts.today}, ${poster}, ${poster ? "image/jpeg" : null},
            ${reading?.textSeen || null}, ${sql.json((reading?.tags ?? {}) as never)}, ${reading?.flags ?? []},
            ${read.ok ? "READ" : "FAILED"}, ${read.ok ? null : read.message}, ${read.costUsd}, ${opts.userId})
    RETURNING id`);
  // What was typed about the ad is free text; the audit row holds none of it.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "competitor.ad_added",
    targetType: "competitor_ad",
    targetId: row.id,
    // The project id is what this month's reads are counted by (`readsThisMonth()`).
    metadata: { kind, platform: form.value.platform, read: read.ok, project: node.project_id },
  });
  return { ok: true, id: row.id, read: read.ok, flagged: (reading?.flags.length ?? 0) > 0 };
}

export async function removeCompetitorAd(opts: { orgId: string; userId: string; id: string; scopes: string[] | null }): Promise<boolean> {
  const r = await withTenant(opts.orgId, (sql) => sql`
    DELETE FROM competitor_ads c USING scope_nodes n
    WHERE c.org_id = ${opts.orgId} AND c.id = ${opts.id} AND n.id = c.scope_node_id
      AND ${opts.scopes ? sql`n.path <@ ANY(${opts.scopes}::ltree[])` : sql`true`}`);
  if (r.count) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "competitor.ad_removed", targetType: "competitor_ad", targetId: opts.id });
  }
  return r.count > 0;
}

export type CompetitorAdView = {
  id: string;
  source: "OURS" | "MARKET";
  competitor: string;
  projectName: string | null;
  locality: string | null;
  platform: Platform;
  kind: AdKind;
  runningSince: string | null;
  seenOn: string;
  hasPoster: boolean;
  textSeen: string | null;
  tags: Record<string, string | number | null>;
  flags: string[];
  readState: "READ" | "FAILED";
  comparedWith: string | null;
  /** Where a saved ad is filed, so a screen offers Remove only where it would work. Null for the library's. */
  path: string | null;
};

const day = (d: Date | string | null) => (d ? (typeof d === "string" ? d.slice(0, 10) : new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10)) : null);

type Row = {
  id: string;
  competitor: string;
  project_name: string | null;
  locality: string | null;
  platform: Platform;
  kind: AdKind;
  running_since: Date | string | null;
  seen_on: Date | string;
  has_poster: boolean;
  text_seen: string | null;
  tags: Record<string, string | number | null>;
  flags: string[];
  read_state?: "READ" | "FAILED";
  compared_with?: string | null;
  path?: string | null;
};

const view = (source: "OURS" | "MARKET") => (r: Row): CompetitorAdView => ({
  id: r.id,
  source,
  competitor: r.competitor,
  projectName: r.project_name,
  locality: r.locality,
  platform: r.platform,
  kind: r.kind,
  runningSince: day(r.running_since),
  seenOn: day(r.seen_on)!,
  hasPoster: r.has_poster,
  textSeen: r.text_seen,
  tags: r.tags ?? {},
  flags: r.flags ?? [],
  readState: r.read_state ?? "READ",
  comparedWith: r.compared_with ?? null,
  path: r.path ?? null,
});

/** The ads saved where the viewer can see, newest first, and the market library's for their cities. */
export async function listCompetitorAds(orgId: string, scopes: string[] | null, limit = 200): Promise<{ ours: CompetitorAdView[]; market: CompetitorAdView[] }> {
  return withTenant(orgId, async (sql) => {
    const [ours, cities] = await Promise.all([
      sql<Row[]>`
        SELECT c.id, c.competitor, c.project_name, c.locality, c.platform, c.kind, c.running_since, c.seen_on,
               c.poster IS NOT NULL AS has_poster, c.text_seen, c.tags, c.flags, c.read_state,
               coalesce(p.name || ' · ' || n.name, n.name) AS compared_with, n.path::text AS path
        FROM competitor_ads c
        JOIN scope_nodes n ON n.id = c.scope_node_id
        LEFT JOIN scope_nodes p ON p.org_id = n.org_id AND p.id = n.parent_id AND n.kind = 'PHASE'
        WHERE c.org_id = ${orgId} AND ${scopes ? sql`n.path <@ ANY(${scopes}::ltree[])` : sql`true`}
        ORDER BY c.created_at DESC LIMIT ${limit}`,
      sql<{ city: string }[]>`SELECT DISTINCT lower(name) AS city FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'REGION'`,
    ]);
    const market = cities.length
      ? await sql<Row[]>`
          SELECT id, developer AS competitor, project_name, locality, platform, kind, running_since, seen_on,
                 poster IS NOT NULL AS has_poster, text_seen, tags, flags
          FROM market_ads WHERE lower(city) = ANY(${cities.map((c) => c.city)}) OR city IS NULL
          ORDER BY seen_on DESC LIMIT ${limit}`
      : [];
    return { ours: ours.map(view("OURS")), market: market.map(view("MARKET")) };
  });
}

/** One saved picture, for its tile, if the viewer may see where it was saved. */
export async function competitorPoster(orgId: string, id: string, source: "OURS" | "MARKET", scopes: string[] | null): Promise<Buffer | null> {
  return withTenant(orgId, async (sql) => {
    if (source === "MARKET") {
      const [r] = await sql<{ poster: Buffer | null }[]>`SELECT poster FROM market_ads WHERE id = ${id}`;
      return r?.poster ?? null;
    }
    const [r] = await sql<{ poster: Buffer | null }[]>`
      SELECT c.poster FROM competitor_ads c JOIN scope_nodes n ON n.id = c.scope_node_id
      WHERE c.org_id = ${orgId} AND c.id = ${id} AND ${scopes ? sql`n.path <@ ANY(${scopes}::ltree[])` : sql`true`}`;
    return r?.poster ?? null;
  });
}
