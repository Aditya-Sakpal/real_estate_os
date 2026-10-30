import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlDb, withTenant } from "./db/index.ts";
import { assetExists, storage, viewUrl } from "./storage.ts";
import {
  DERIVED,
  MAX_SHRINK_BYTES,
  THUMB_WIDTH,
  derivedKey,
  posterArgs,
  previewArgs,
  variantFor,
  type Variant,
} from "./media-variant-rules.ts";

/**
 * Serving a stored file on a console screen, and making its lighter copies.
 *
 * The routes have checked who is asking before they call here; this only
 * decides which copy to hand over and how. A small picture of an image is
 * made on the first request (sharp runs anywhere, Vercel included). A
 * video's still and preview need FFmpeg, which the worker has and Vercel
 * does not, so the worker makes them (`warmVideos()`, from `post:run`), and
 * a machine with FFmpeg makes them on the first request too. Until one
 * exists, a preview falls back to the original and a missing still answers
 * 404, which the tile reads as "show the video itself".
 */

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/** FFmpeg is on this machine: anywhere but a Vercel function. */
export function canMakeVideoCopies(): boolean {
  return !process.env.VERCEL;
}

/** Copies known to exist, so a busy screen is not a HEAD request per tile. */
const known = new Set<string>();
/** Copies being made, so two requests for one wait on one job. */
const making = new Map<string, Promise<boolean>>();

async function exists(key: string): Promise<boolean> {
  if (known.has(key)) return true;
  const yes = await assetExists(key);
  if (yes) known.add(key);
  return yes;
}

function once(key: string, job: () => Promise<boolean>): Promise<boolean> {
  const running = making.get(key);
  if (running) return running;
  const p = job()
    .then((ok) => {
      if (ok) known.add(key);
      return ok;
    })
    .catch(() => false)
    .finally(() => making.delete(key));
  making.set(key, p);
  return p;
}

/** The small picture of an image: WebP, at most `THUMB_WIDTH` wide, never enlarged. */
export function makeThumb(key: string): Promise<boolean> {
  const out = derivedKey(key, "thumb");
  return once(out, async () => {
    const bytes = await storage().read(key);
    if (!bytes || bytes.byteLength > MAX_SHRINK_BYTES) return false;
    const sharp = (await import("sharp")).default;
    const small = await sharp(bytes, { animated: false })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    await storage().put(out, small, DERIVED.thumb.type);
    return true;
  });
}

/** A video copied to a scratch folder, FFmpeg run on it, the result stored. */
async function viaFfmpeg(key: string, out: string, type: string, args: (i: string, o: string) => string[]): Promise<boolean> {
  if (!canMakeVideoCopies()) return false;
  const bytes = await storage().read(key);
  if (!bytes) return false;
  const dir = await mkdtemp(join(tmpdir(), "estn-media-"));
  try {
    const input = join(dir, "in.mp4");
    const output = join(dir, out.endsWith(".jpg") ? "out.jpg" : "out.mp4");
    await writeFile(input, bytes);
    await exec(FFMPEG, args(input, output), { maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
    const made = await readFile(output);
    if (!made.byteLength) return false;
    await storage().put(out, made, type);
    return true;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function makePoster(key: string): Promise<boolean> {
  const out = derivedKey(key, "poster");
  return once(out, () => viaFfmpeg(key, out, DERIVED.poster.type, posterArgs));
}

export function makePreview(key: string): Promise<boolean> {
  const out = derivedKey(key, "preview");
  return once(out, () => viaFfmpeg(key, out, DERIVED.preview.type, previewArgs));
}

/** A redirect to a viewing link, kept by this browser while the link holds. */
async function handOver(key: string, type: string, status404 = "Not found"): Promise<Response> {
  const link = await viewUrl(key, type);
  if (!link.ok) return new Response(status404, { status: 404 });
  // The local driver's links are file paths no browser follows: the bytes.
  if (link.url.startsWith("file://")) {
    const bytes = await storage().read(key);
    if (!bytes) return new Response(status404, { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": type,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return new Response(null, {
    status: 302,
    headers: { location: link.url, "cache-control": `private, max-age=${link.maxAge}` },
  });
}

/**
 * The answer to a request for a stored file, after its route checked who is
 * asking: the copy asked for when it exists (or can be made now), else the
 * original, except a video's still, which answers 404 until it exists.
 */
export async function serveStored(opts: { key: string; type: string; asked: Variant }): Promise<Response> {
  const variant = variantFor(opts.asked, opts.type);
  if (variant === "full") return handOver(opts.key, opts.type);
  const out = derivedKey(opts.key, variant);
  const copyType = DERIVED[variant].type;
  if (await exists(out)) return handOver(out, copyType);

  if (variant === "thumb") {
    return (await makeThumb(opts.key)) ? handOver(out, copyType) : handOver(opts.key, opts.type);
  }
  if (variant === "poster") {
    if (canMakeVideoCopies() && (await makePoster(opts.key))) return handOver(out, copyType);
    return new Response("No still yet", { status: 404, headers: { "cache-control": "no-store" } });
  }
  // A preview takes a few seconds to make: the original now, the preview next time.
  if (canMakeVideoCopies()) void makePreview(opts.key);
  const full = await handOver(opts.key, opts.type);
  full.headers.set("cache-control", "no-store");
  return full;
}

/**
 * Make the still and the preview of recent videos that have neither, newest
 * first, at most `limit` videos a pass. For the worker, which has FFmpeg.
 * Reads each tenant inside its own tenancy, as every worker pass does.
 */
export async function warmVideos(opts: { limit?: number; days?: number } = {}): Promise<{ checked: number; made: number; failed: number }> {
  const limit = opts.limit ?? 4;
  const days = opts.days ?? 30;
  const report = { checked: 0, made: 0, failed: 0 };
  if (!canMakeVideoCopies()) return report;
  const orgs = await controlDb<{ id: string }[]>`SELECT id FROM orgs WHERE status <> 'SUSPENDED' ORDER BY created_at`;
  let done = 0;
  for (const org of orgs) {
    if (done >= limit) break;
    const keys = await withTenant(org.id, (sql) => sql<{ key: string }[]>`
      SELECT key, max(at) AS at FROM (
        SELECT m->>'key' AS key, t.at FROM (
          SELECT media, created_at AS at FROM rendered_posts
          WHERE org_id = ${org.id} AND created_at > now() - make_interval(days => ${days})
          UNION ALL
          SELECT media, created_at AS at FROM post_creatives
          WHERE org_id = ${org.id} AND created_at > now() - make_interval(days => ${days}) AND media IS NOT NULL
        ) t, jsonb_array_elements(CASE WHEN jsonb_typeof(t.media) = 'array' THEN t.media ELSE '[]'::jsonb END) m
        WHERE m->>'type' = 'video/mp4' AND m->>'key' IS NOT NULL
        UNION ALL
        -- The library's own videos, which a person plays from its tiles.
        SELECT storage_key AS key, uploaded_at AS at FROM asset_versions
        WHERE org_id = ${org.id} AND media_type LIKE 'video/%'
      ) v
      GROUP BY key
      ORDER BY at DESC
      LIMIT 200`).catch(() => [] as { key: string }[]);
    for (const { key } of keys) {
      if (done >= limit) break;
      report.checked += 1;
      const [still, preview] = await Promise.all([exists(derivedKey(key, "poster")), exists(derivedKey(key, "preview"))]);
      if (still && preview) continue;
      done += 1;
      const ok = (still || (await makePoster(key))) && (preview || (await makePreview(key)));
      if (ok) report.made += 1;
      else report.failed += 1;
    }
  }
  return report;
}
