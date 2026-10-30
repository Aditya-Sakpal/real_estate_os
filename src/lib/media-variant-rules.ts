/**
 * Lighter copies of a stored picture or video, for screens on slow internet.
 *
 * A tile does not need a 4 MB render or the first megabytes of an 11 MB
 * film; it needs a small picture. A person watching a post in the console
 * does not need 1080p at 4 Mbps; 720p at about 1 Mbps looks the same on a
 * laptop and plays on an office line or 4G. The original is never changed and
 * is what a download and every publisher take.
 *
 * Each copy lives beside its original under the original's own key plus a
 * suffix, so it belongs to the same tenant and project, and the orphan sweep
 * keeps it exactly as long as it keeps the original (`baseOfDerived()`).
 * Pure, covered by `check:logic`.
 */

export type Variant = "full" | "thumb" | "poster" | "preview";

export const DERIVED: Record<Exclude<Variant, "full">, { suffix: string; type: string }> = {
  thumb: { suffix: ".thumb.webp", type: "image/webp" },
  poster: { suffix: ".poster.jpg", type: "image/jpeg" },
  preview: { suffix: ".preview.mp4", type: "video/mp4" },
};

/** A tile is at most this wide on any screen we draw, at twice the density. */
export const THUMB_WIDTH = 640;
/** A video's still, a little larger, because it is also the player's first frame. */
export const POSTER_WIDTH = 720;
/** Where in a clip its still is taken: every film fades in from black. */
export const POSTER_AT_SECONDS = 0.6;
/** The short side of a preview: 720 on a 1080 film. */
export const PREVIEW_SHORT_SIDE = 720;
/** An original larger than this is shown as it is rather than read into memory to shrink. */
export const MAX_SHRINK_BYTES = 40 * 1024 * 1024;

/** `?v=` read off a media address. Anything else is the original. */
export function readVariant(v: string | null | undefined): Variant {
  return v === "thumb" || v === "poster" || v === "preview" ? v : "full";
}

/**
 * The copy a request really gets for a file of this type: a still of a video
 * when a small picture is asked for, the small picture of an image when a
 * still is asked for, and the image itself when a preview is.
 */
export function variantFor(asked: Variant, type: string): Variant {
  const video = type.startsWith("video/");
  if (asked === "thumb" || asked === "poster") return video ? "poster" : type.startsWith("image/") && !/svg/i.test(type) ? "thumb" : "full";
  if (asked === "preview") return video ? "preview" : "full";
  return "full";
}

export function derivedKey(key: string, variant: Exclude<Variant, "full">): string {
  return `${key}${DERIVED[variant].suffix}`;
}

/** The original a lighter copy belongs to, or null when the key is an original. */
export function baseOfDerived(key: string): string | null {
  for (const d of Object.values(DERIVED)) {
    if (key.endsWith(d.suffix) && key.length > d.suffix.length) return key.slice(0, -d.suffix.length);
  }
  return null;
}

/** How long a viewing link holds, and the window it is the same for. */
export const VIEW_WINDOW_SECONDS = 3600;

/**
 * A viewing link signed for the hour it is asked in, so every request in
 * that hour gets the same address and the browser keeps what it fetched.
 * It is signed at the start of the hour and lasts two, so it always has at
 * least an hour left; the browser is told to keep it for what is left, less
 * a minute.
 */
export function viewWindow(now: Date, windowSeconds = VIEW_WINDOW_SECONDS): {
  signingDate: Date;
  expiresIn: number;
  maxAge: number;
} {
  const start = Math.floor(now.getTime() / 1000 / windowSeconds) * windowSeconds;
  const expiresIn = windowSeconds * 2;
  const left = start + expiresIn - Math.floor(now.getTime() / 1000);
  return { signingDate: new Date(start * 1000), expiresIn, maxAge: Math.max(0, left - 60) };
}

/** FFmpeg's arguments for a video's still, from a file on disk to a JPEG. */
export function posterArgs(input: string, output: string): string[] {
  return [
    "-y", "-loglevel", "error",
    "-ss", String(POSTER_AT_SECONDS), "-i", input,
    "-frames:v", "1",
    "-vf", `scale='min(${POSTER_WIDTH},iw)':-2`,
    "-q:v", "4",
    output,
  ];
}

/**
 * FFmpeg's arguments for a video's preview: the short side 720 (never
 * enlarged), about 1 Mbps, sound kept at a lower rate, and the index at the
 * front so it starts playing before it has finished arriving.
 */
export function previewArgs(input: string, output: string): string[] {
  const s = PREVIEW_SHORT_SIDE;
  return [
    "-y", "-loglevel", "error", "-i", input,
    "-vf", `scale='if(gt(iw,ih),-2,min(${s},iw))':'if(gt(iw,ih),min(${s},ih),-2)'`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
    "-maxrate", "1200k", "-bufsize", "2400k", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart",
    output,
  ];
}
