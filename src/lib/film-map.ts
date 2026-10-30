/**
 * The location map, set on a film by us (13 October 2026). Handed the
 * developer's map as a reference, the video model drew its own copy of it:
 * "Goregaon slation", and times that changed between two shots of the same
 * map. A map is a claim the person approved pixel for pixel, so every scene
 * of the film that shows it is replaced with the approved map itself, frame
 * exact, over the film's own sound.
 *
 * A scene that says one nearby place shows the route to it (15 October
 * 2026, the client: "it is mentioning this particular route and it is eight
 * minutes from the station"): the whole map, then a smooth move until the
 * project and the place fill the frame together, a line drawing itself from
 * the project to the place, and the place pulsing. On a map scene that is the
 * whole scene; on a scene filmed on the place's own photo, or on the
 * building, it is the head of the scene and the scene's own picture follows.
 * Everything in it is the approved map and our own drawing: the video model
 * touches none of it.
 *
 * `scene-fix.ts` holds the cutting and splicing this shares;
 * `locality-rules.ts` the framing (`routeView()`) and the timing.
 */

import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { routePrefixSeconds, routeView } from "./locality-rules.ts";
import { scenesFromCuts } from "./scene-fix-rules.ts";
import { cutsOf, probe, splice } from "./scene-fix.ts";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/** How far the map is pushed in over a shot, and how much of the frame it fills at the start. */
export const MAP_PUSH = 1.18;
const MAP_FILL = 0.96;
/**
 * On a tall frame a wide map is at least this share of the height, its sides
 * cut evenly about the project: fitted whole, a 3:2 map filled a third of a
 * 9:16 frame and its labels could not be read on a phone.
 */
const MAP_TALL_HEIGHT = 0.5;
/** The route's colour, with a white casing so it reads on any map. */
const ROUTE_COLOUR = "#ff5a1f";

type Pt = { x: number; y: number };

/**
 * One shot of the map: the whole approved map on a darkened, softened copy
 * of itself, pushed in smoothly toward the project's pin (the middle when the
 * map shows none). Rendered at twice the size first so the push does not
 * shimmer, exactly `frames` long, mute.
 */
async function mapShot(map: Buffer, pin: Pt | null, w: number, h: number, fps: number, frames: number, out: string): Promise<void> {
  const W = w * 2;
  const H = h * 2;
  const bg = await sharp(map).resize(W, H, { fit: "cover" }).blur(40).modulate({ brightness: 0.45 }).toBuffer();
  const meta = await sharp(map).metadata();
  const mw = meta.width ?? W;
  const mh = meta.height ?? H;
  const scale = Math.max(Math.min((W * MAP_FILL) / mw, (H * MAP_FILL) / mh), W < H ? (H * MAP_TALL_HEIGHT) / mh : 0);
  const fw = Math.round(mw * scale);
  const fh = Math.min(H, Math.round(mh * scale));
  // Wider than the frame: cut about the project's pin, never past an edge.
  const cut = fw > W ? Math.round(Math.max(0, Math.min(fw - W, (pin?.x ?? 0.5) * fw - W / 2))) : 0;
  const shown = fw > W ? W : fw;
  const fg = await sharp(map).resize(fw, fh, { fit: "fill" }).extract({ left: cut, top: 0, width: shown, height: fh }).png().toBuffer();
  const left = Math.round((W - shown) / 2);
  const top = Math.round((H - fh) / 2);
  const still = `${out}.png`;
  await sharp(bg).composite([{ input: fg, left, top }]).png().toFile(still);
  // Where to push toward, in the canvas, as a fraction.
  const fx = pin ? (left + pin.x * fw - cut) / W : 0.5;
  const fy = pin ? (top + pin.y * fh) / H : 0.5;
  const n = Math.max(1, frames - 1);
  const zoom = `1+${(MAP_PUSH - 1).toFixed(4)}*(1-cos(PI*on/${n}))/2`;
  const x = `max(0,min(iw-iw/zoom,${fx.toFixed(4)}*iw-iw/zoom/2))`;
  const y = `max(0,min(ih-ih/zoom,${fy.toFixed(4)}*ih-ih/zoom/2))`;
  await exec(FFMPEG, [
    "-v", "error", "-y", "-loop", "1", "-framerate", String(fps), "-i", still, "-an", "-vf",
    `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${w}x${h}:fps=${fps},setsar=1,format=yuv420p`,
    "-frames:v", String(frames), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out,
  ]);
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : (1 - Math.cos(Math.PI * t)) / 2);
const span = (t: number, a: number, b: number) => (t - a) / (b - a);

/** The route's curve, a gentle bow from the project to the place, sampled. */
function curve(a: Pt, b: Pt): { at: (t: number) => Pt; length: number } {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Bowed to one side by a fifth of its length, so it reads as a route, not a ruler.
  const c = { x: mx - dy * 0.2, y: my + dx * 0.2 };
  const at = (t: number) => ({
    x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
    y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
  });
  let length = 0;
  let prev = a;
  for (let i = 1; i <= 32; i++) {
    const p = at(i / 32);
    length += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return { at, length };
}

/**
 * One shot of the route to a place: the whole map, a smooth move until the
 * project and the place fill the frame together, the route drawing itself
 * from the project to the place, and the place pulsing. Exactly `frames`
 * long, mute. `head` is a shot at the head of a scene filmed on something
 * else, which moves sooner.
 */
async function routeShot(map: Buffer, pin: Pt, place: Pt, w: number, h: number, fps: number, frames: number, out: string, head: boolean): Promise<void> {
  const W = w * 2;
  const H = h * 2;
  const meta = await sharp(map).metadata();
  const mw = meta.width ?? W;
  const mh = meta.height ?? H;
  // The whole map, never cut: the place may be anywhere on it.
  const scale = Math.min((W * MAP_FILL) / mw, (H * MAP_FILL) / mh);
  const fw = Math.round(mw * scale);
  const fh = Math.round(mh * scale);
  const left = Math.round((W - fw) / 2);
  const top = Math.round((H - fh) / 2);
  const bg = await sharp(map).resize(W, H, { fit: "cover" }).blur(40).modulate({ brightness: 0.45 }).toBuffer();
  const fg = await sharp(map).resize(fw, fh, { fit: "fill" }).toBuffer();
  const still = await sharp(bg).composite([{ input: fg, left, top }]).removeAlpha().raw().toBuffer();
  const P = { x: left + pin.x * fw, y: top + pin.y * fh };
  const Q = { x: left + place.x * fw, y: top + place.y * fh };
  const whole = { x: 0, y: 0, w: W, h: H };
  const rest = routeView(P, Q, { w: W, h: H });
  // When each part happens, as a share of the shot.
  const T = head ? { hold: 0.06, settle: 0.42, draw: [0.3, 0.7], pulse: 0.66 } : { hold: 0.12, settle: 0.5, draw: [0.42, 0.78], pulse: 0.74 };
  const n = Math.max(1, frames - 1);
  const thick = Math.max(4, Math.round(Math.min(w, h) * 0.011));

  const ff = spawn(FFMPEG, [
    "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-", "-an",
    "-frames:v", String(frames), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(fps), out,
  ]);
  const done = new Promise<void>((ok, fail) => {
    let err = "";
    ff.stderr.on("data", (d) => (err += String(d)));
    ff.on("error", fail);
    ff.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg ${code}: ${err.slice(0, 400)}`))));
  });
  try {
    for (let f = 0; f < frames; f++) {
      const t = f / n;
      const k = ease(span(t, T.hold, T.settle));
      // A slow drift in once it has come to rest, so the picture never stands still.
      const drift = 1 - 0.05 * ease(span(t, T.settle, 1));
      const vw = (whole.w + (rest.w - whole.w) * k) * drift;
      const vh = (whole.h + (rest.h - whole.h) * k) * drift;
      const cx = whole.x + whole.w / 2 + (rest.x + rest.w / 2 - (whole.x + whole.w / 2)) * k;
      const cy = whole.y + whole.h / 2 + (rest.y + rest.h / 2 - (whole.y + whole.h / 2)) * k;
      const vx = Math.max(0, Math.min(W - vw, cx - vw / 2));
      const vy = Math.max(0, Math.min(H - vh, cy - vh / 2));
      const box = { left: Math.round(vx), top: Math.round(vy), width: Math.max(2, Math.min(W - Math.round(vx), Math.round(vw))), height: Math.max(2, Math.min(H - Math.round(vy), Math.round(vh))) };
      const toOut = (p: Pt) => ({ x: ((p.x - box.left) / box.width) * w, y: ((p.y - box.top) / box.height) * h });
      const a = toOut(P);
      const b = toOut(Q);
      const route = curve(a, b);
      const drawn = ease(span(t, T.draw[0], T.draw[1]));
      const d = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} ` + Array.from({ length: 32 }, (_, i) => {
        const p = route.at((i + 1) / 32);
        return `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      }).join(" ");
      const len = route.length.toFixed(1);
      const off = (route.length * (1 - drawn)).toFixed(1);
      const shown = t >= T.draw[0];
      // The place pulses once the route reaches it: a ring every 0.9 s.
      const since = Math.max(0, t - T.pulse) * (n / fps);
      const phase = (since % 0.9) / 0.9;
      const pulsing = t >= T.pulse;
      const r = thick * 1.6;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
${shown ? `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="${thick * 2.2}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${len} ${len}" stroke-dashoffset="${off}" opacity="0.95"/>
<path d="${d}" fill="none" stroke="${ROUTE_COLOUR}" stroke-width="${thick}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${len} ${len}" stroke-dashoffset="${off}"/>
<circle cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="${(r * 1.1).toFixed(1)}" fill="${ROUTE_COLOUR}" stroke="#ffffff" stroke-width="${thick * 0.6}"/>` : ""}
${pulsing ? `<circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${(r * (1.2 + 2.6 * phase)).toFixed(1)}" fill="none" stroke="${ROUTE_COLOUR}" stroke-width="${(thick * 0.7).toFixed(1)}" opacity="${(0.9 * (1 - phase)).toFixed(2)}"/>
<circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${(r * 1.2).toFixed(1)}" fill="${ROUTE_COLOUR}" stroke="#ffffff" stroke-width="${thick * 0.6}"/>` : ""}
</svg>`;
      const frame = await sharp(still, { raw: { width: W, height: H, channels: 3 } })
        .extract(box)
        .resize(w, h, { fit: "fill" })
        .composite([{ input: Buffer.from(svg) }])
        .removeAlpha()
        .raw()
        .toBuffer();
      if (!ff.stdin.write(frame)) await new Promise((ok) => ff.stdin.once("drain", ok));
    }
  } finally {
    ff.stdin.end();
  }
  await done;
}

/**
 * The film with the map laid in by us, or null when there was nothing to lay
 * or it could not be done (the film stays as the model made it).
 *
 * `parts` says which: "maps" lays every scene that shows the map (the route
 * to its place when it says one, else a push toward the project), "routes"
 * lays the route at the head of every other scene that says one place, and
 * "both" does both. Routes at the head of a scene add a cut inside it, so
 * they are laid once every scene is settled. A scene is the script's shot of
 * the same place when the film cut as many times as the script has shots; by
 * the planned time otherwise.
 */
export async function layMapShots(input: {
  raw: string;
  dir: string;
  map: Buffer;
  pin: Pt | null;
  /** Which of the script's scenes show the map. */
  isMap: readonly boolean[];
  /** The script's planned scenes, in seconds. */
  planned: readonly { start: number; end: number }[];
  /** Where on the map each scene's one place is, or null. */
  routes?: readonly (Pt | null)[];
  parts?: "maps" | "routes" | "both";
  /** The file to write; `film-raw-mapped.mp4` in `dir` by default. */
  out?: string;
}): Promise<{ file: string; laid: number; routes: number } | null> {
  const parts = input.parts ?? "maps";
  const routeOf = (i: number) => (input.pin ? input.routes?.[i] ?? null : null);
  const wantMaps = parts !== "routes" && input.isMap.some(Boolean);
  const wantRoutes = parts !== "maps" && input.isMap.some((m, i) => !m && routeOf(i));
  if (!wantMaps && !wantRoutes) return null;
  const film = await probe(input.raw);
  const cut = scenesFromCuts(await cutsOf(input.raw).catch(() => []), film.seconds, film.fps);
  const total = input.planned.length ? input.planned[input.planned.length - 1].end : film.seconds;
  const stretch = film.seconds / (total || film.seconds || 1);
  const spans =
    cut.length === input.planned.length
      ? cut.map((c) => ({ startFrame: c.startFrame, endFrame: c.endFrame }))
      : input.planned.map((p) => ({ startFrame: Math.round(p.start * stretch * film.fps), endFrame: Math.round(Math.min(film.seconds, p.end * stretch) * film.fps) }));
  const swaps: { startFrame: number; endFrame: number; file: string }[] = [];
  let routes = 0;
  for (const [i, s] of spans.entries()) {
    const frames = s.endFrame - s.startFrame;
    if (frames < 2) continue;
    const place = routeOf(i);
    if (input.isMap[i]) {
      if (parts === "routes") continue;
      const file = join(input.dir, `map-shot-${i}.mp4`);
      if (place) {
        await routeShot(input.map, input.pin!, place, film.w, film.h, film.fps, frames, file, false);
        routes++;
      } else await mapShot(input.map, input.pin, film.w, film.h, film.fps, frames, file);
      swaps.push({ ...s, file });
    } else if (place && parts !== "maps") {
      const head = Math.round(routePrefixSeconds(frames / film.fps) * film.fps);
      if (head < 2) continue;
      const file = join(input.dir, `route-head-${i}.mp4`);
      await routeShot(input.map, input.pin!, place, film.w, film.h, film.fps, head, file, true);
      swaps.push({ startFrame: s.startFrame, endFrame: s.startFrame + head, file });
      routes++;
    }
  }
  if (!swaps.length) return null;
  const out = input.out ?? join(input.dir, "film-raw-mapped.mp4");
  await splice(input.raw, swaps, input.raw, out);
  return { file: out, laid: swaps.length, routes };
}

/**
 * An approved photo of a nearby place as a shot of the film: the photo
 * filling the frame (cut to the film's shape about its middle) with a quick
 * push-in, the locality guide's own move. Nothing is drawn on it.
 */
async function photoShot(photo: Buffer, w: number, h: number, fps: number, frames: number, out: string): Promise<void> {
  const still = `${out}.png`;
  await sharp(photo).resize(w * 2, h * 2, { fit: "cover", position: "centre" }).png().toFile(still);
  const n = Math.max(1, frames - 1);
  const zoom = `1+0.14*(1-cos(PI*on/${n}))/2`;
  await exec(FFMPEG, [
    "-v", "error", "-y", "-loop", "1", "-framerate", String(fps), "-i", still, "-an", "-vf",
    `zoompan=z='${zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${w}x${h}:fps=${fps},setsar=1,format=yuv420p`,
    "-frames:v", String(frames), "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out,
  ]);
}

/**
 * The film with each place it never showed laid in from that place's own
 * approved photo, over the film's own sound, at the times `placeWindow()`
 * gives. Null when there was nothing to lay.
 */
export async function layPlacePhotos(input: {
  raw: string;
  dir: string;
  places: readonly { photo: Buffer; start: number; end: number }[];
  out?: string;
}): Promise<{ file: string; laid: number } | null> {
  if (!input.places.length) return null;
  const film = await probe(input.raw);
  const swaps: { startFrame: number; endFrame: number; file: string }[] = [];
  for (const [i, p] of [...input.places].sort((a, b) => a.start - b.start).entries()) {
    const startFrame = Math.round(p.start * film.fps);
    const endFrame = Math.min(Math.round(film.seconds * film.fps), Math.round(p.end * film.fps));
    if (endFrame - startFrame < 2 || swaps.some((s) => startFrame < s.endFrame)) continue;
    const file = join(input.dir, `place-shot-${i}.mp4`);
    await photoShot(p.photo, film.w, film.h, film.fps, endFrame - startFrame, file);
    swaps.push({ startFrame, endFrame, file });
  }
  if (!swaps.length) return null;
  const out = input.out ?? join(input.dir, "film-raw-places.mp4");
  await splice(input.raw, swaps, input.raw, out);
  return { file: out, laid: swaps.length };
}
