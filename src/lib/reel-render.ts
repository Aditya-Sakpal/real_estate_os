import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { ReelProps } from "../../remotion/types.ts";

/**
 * Rendering a story reel with Remotion, in the worker's own process.
 *
 * The composition lives in `remotion/` and is bundled once per process. Its
 * media (the trimmed clips, the narrator's lines, the music, the fonts, the
 * logo and QR) sit in the job's scratch folder and reach the headless
 * browser over a local HTTP server that answers byte ranges, because a
 * <video> seeks by asking for them.
 *
 * Remotion is imported lazily: it pulls in webpack and a browser, and only
 * the worker ever renders.
 *
 * Imports are relative because the worker loads this straight from source.
 */

let bundled: Promise<string> | null = null;

function bundleOnce(): Promise<string> {
  bundled ??= (async () => {
    const { bundle } = await import("@remotion/bundler");
    return bundle({ entryPoint: join(process.cwd(), "remotion", "index.ts") });
  })();
  bundled.catch(() => {
    bundled = null;
  });
  return bundled;
}

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

/** Serve one folder over HTTP on a free local port, ranges included. */
export async function serveFolder(dir: string): Promise<{ base: string; close: () => Promise<void> }> {
  const root = normalize(dir);
  const server: Server = createServer((req, res) => {
    const path = normalize(join(root, decodeURIComponent((req.url ?? "/").split("?")[0])));
    if (!path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = {
      "content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "accept-ranges": "bytes",
      "access-control-allow-origin": "*",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length": String(size) });
    if (req.method === "HEAD") res.end();
    else createReadStream(path).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Render the reel to an MP4 at `out`. */
export async function renderReel(props: ReelProps, out: string, onProgress?: (share: number) => void): Promise<void> {
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  const serveUrl = await bundleOnce();
  // A browser already on the machine, where Remotion's own download is not
  // reachable (a locked-down network). Unset, Remotion fetches its own.
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE?.trim() || null;
  const composition = await selectComposition({ serveUrl, id: "StoryReel", inputProps: props, browserExecutable });
  const once = (concurrency: number) => renderMedia({
    composition,
    browserExecutable,
    serveUrl,
    codec: "h264",
    crf: 20,
    audioCodec: "aac",
    outputLocation: out,
    inputProps: props,
    // Each concurrent frame is a browser tab holding a decoded 1080 by 1920
    // clip; on a busy machine three ran out of memory mid-reel.
    concurrency,
    // The decoded-frame cache defaults to half the memory free at the time,
    // which on a busy machine is a few hundred megabytes: frames were evicted
    // as soon as they were decoded and a live render failed with "No frame
    // found at position". A 1080 by 1920 frame is 8 MB, so this holds 128.
    offthreadVideoCacheSizeInBytes: (Number(process.env.REEL_VIDEO_CACHE_MB) || 1024) * 1024 * 1024,
    // A frame waits on its clip's decoder; thirty seconds was not always
    // enough for a 1080 by 1920 clip on a busy machine.
    timeoutInMilliseconds: 120_000,
    onProgress: ({ progress }) => onProgress?.(progress),
  });
  // Rendering costs nothing but time, so a render that failed on memory or a
  // stalled decoder is tried once more, one frame at a time.
  try {
    await once(Number(process.env.REEL_RENDER_CONCURRENCY) || 2);
  } catch (e) {
    console.error("reel: render failed, trying once more at concurrency 1", e);
    await once(1);
  }
}
