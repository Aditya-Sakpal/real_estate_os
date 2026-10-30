import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { fileReader } from "@/lib/guard";
import { ACTIVE_ORG_COOKIE } from "@/lib/onboarding";
import { viewUrl } from "@/lib/storage";
import { templateClip, templateThumb } from "@/lib/templates";

/** The sizes asked for: a picker tile at 1x and 2x, and the full-screen viewer. Nothing else is cut. */
const WIDTHS = new Set([320, 480, 1600]);

/** A year: the address carries the file's version, so a replaced design is a new address. */
const FOREVER = "private, max-age=31536000, immutable";

/**
 * Who may read the library, remembered for a minute per person and chosen
 * organisation. A picker asks for forty tiles at once, and each used to
 * resolve the whole console to answer one yes. The library is ours, not a
 * tenant's, so a minute's grace after a key is taken away shows nobody
 * anybody else's data.
 */
const allowed = new Map<string, { until: number; ok: Promise<boolean> }>();

async function mayRead(): Promise<boolean> {
  const session = await auth();
  if (!session?.user?.id) return false;
  const org = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value ?? "";
  const key = `${session.user.id}:${org}:${session.method ?? ""}`;
  const hit = allowed.get(key);
  if (hit && hit.until > Date.now()) return hit.ok;
  if (allowed.size > 2000) allowed.clear();
  const ok = fileReader().then((r) => Boolean(r?.authz.can("campaign:read")));
  allowed.set(key, { until: Date.now() + 60_000, ok });
  // A refusal is not remembered: signing in or being given the key works at once.
  ok.then((yes) => (yes ? undefined : allowed.delete(key)), () => allowed.delete(key));
  return ok;
}

/**
 * One page of one design from the template library, cut down for the picker
 * or the viewer. `?kind=carousel` reads the carousel library, and `?page=`
 * names a page of a carousel design; an image design is its one page.
 * `?kind=video` reads the video library: its poster still, or with `&clip=1`
 * the preview clip itself.
 *
 * The library is ours rather than any tenant's, so there is no row to read
 * through `withTenant()`; the gate is being signed in with `campaign:read`.
 * The key is matched against the catalog before any path is built from it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string; index: string }> }) {
  if (!(await mayRead().catch(() => false))) return new Response("Not found", { status: 404 });
  const { key, index } = await params;
  const query = new URL(request.url).searchParams;
  const asked = Number(query.get("w"));
  const versioned = Boolean(query.get("v"));
  const kind = query.get("kind") === "carousel" ? "CAROUSEL" : query.get("kind") === "video" ? "VIDEO" : "IMAGE";
  if (kind === "VIDEO" && query.get("clip") === "1") return clip(request, key, Number(index), versioned);
  const webp = (request.headers.get("accept") ?? "").includes("image/webp");
  const bytes = await templateThumb(
    kind,
    key,
    Number(index),
    WIDTHS.has(asked) ? asked : 480,
    Number(query.get("page") ?? 0),
    webp ? "webp" : "jpeg",
  );
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": webp ? "image/webp" : "image/jpeg",
      "content-length": String(bytes.byteLength),
      "cache-control": versioned ? FOREVER : "private, max-age=86400",
      vary: "Accept",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * A video design's preview clip, streamed from disk. Video needs ranges: a
 * <video> asks for `bytes=0-` and then seeks by asking for a later window,
 * and Safari will not play at all without a 206. Only the window asked for
 * is read; the whole clip used to be read into memory for every seek.
 */
async function clip(request: Request, key: string, index: number, versioned: boolean): Promise<Response> {
  const file = await templateClip(key, index);
  if (!file) return new Response("Not found", { status: 404 });
  // A deployment holds no clips: they are played from the file store, which answers ranges itself.
  if ("storeKey" in file) {
    const link = await viewUrl(file.storeKey, "video/mp4");
    if (!link.ok) return new Response("Not found", { status: 404 });
    return new Response(null, { status: 302, headers: { location: link.url, "cache-control": `private, max-age=${Math.max(0, link.maxAge - 60)}` } });
  }
  const total = file.size;
  const headers = {
    "content-type": "video/mp4",
    "cache-control": versioned ? FOREVER : "private, max-age=86400",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  };
  const stream = (start: number, end: number) =>
    Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream<Uint8Array>;
  const match = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get("range") ?? "").trim());
  if (match && (match[1] || match[2])) {
    // `bytes=-500` is the last 500 bytes.
    const start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (!(start <= end && start < total)) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    }
    return new Response(stream(start, end), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(stream(0, total - 1), { headers: { ...headers, "content-length": String(total) } });
}
