import { join } from "node:path";
import sharp from "sharp";
import jsQR from "jsqr";

// Asked of Node at run time: a production webpack build rewrites a
// createRequire it can see into (void 0), and every post then fails.
const { createRequire } = process.getBuiltinModule("node:module");

/**
 * Finding things the image model drew, so the real ones can go in their place.
 *
 * The model is asked to draw the MahaRERA QR where it looks best, and what it
 * draws never scans. OpenCV's Aruco-based detector finds the four corners of
 * a QR from its finder patterns alone, whether or not the code can be read,
 * which is exactly the question: where did it put it. The plain detector
 * missed the same code on the first real sample, so the Aruco one is used.
 *
 * Two flat-colour placeholders are found by colour instead: the logo slot
 * (pure green) and, when a QR could not be found, the QR slot on a retry
 * (pure magenta). Neither colour occurs in a photograph at that purity.
 *
 * OpenCV is a WebAssembly build, loaded once per process on first use.
 * Imports are relative because the scheduled runner loads this from source.
 *
 * It is loaded with `require`, never `await import()`. The package exports a
 * Promise, and the dev server's bundler copies its `then` onto the module
 * object, so awaiting the import calls `Promise.prototype.then` on something
 * that is not a Promise and throws. Plain Node never copies it, which is why
 * every script and check passed while every post made from the studio failed
 * with "This post could not be made".
 */

export type Quad = { x: number; y: number }[];
export type Rect = { x: number; y: number; w: number; h: number };

type CvMat = { data: Uint8Array; data32F: Float32Array; delete(): void; rows: number };
type CV = {
  Mat: (new () => CvMat) & (new (rows: number, cols: number, type: number) => CvMat);
  CV_8UC1: number;
  CV_8UC3: number;
  INPAINT_TELEA: number;
  matFromImageData(img: { data: Uint8ClampedArray; width: number; height: number }): { delete(): void };
  inpaint(src: CvMat, mask: CvMat, dst: CvMat, radius: number, method: number): void;
  QRCodeDetectorAruco: new () => { detect(img: unknown, pts: unknown): boolean; delete?(): void };
  QRCodeDetector?: new () => { detect(img: unknown, pts: unknown): boolean; delete?(): void };
};

let loading: Promise<CV> | null = null;

function opencv(): Promise<CV> {
  loading ??= (async () => {
    const load = createRequire(join(process.cwd(), "package.json"));
    let cv = load("@techstark/opencv-js") as unknown;
    if (cv instanceof Promise) cv = await cv;
    const ready = cv as CV & { onRuntimeInitialized?: () => void };
    if (!ready.Mat) {
      await new Promise<void>((resolve) => {
        ready.onRuntimeInitialized = () => resolve();
      });
    }
    return ready;
  })();
  return loading;
}

/** The corners of a QR code the image shows, readable or not, or null. */
export async function findQr(bytes: Buffer): Promise<{ quad: Quad; box: Rect } | null> {
  const cv = await opencv();
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rawData = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  const img = cv.matFromImageData({
    data: rawData,
    width: info.width,
    height: info.height,
  });
  const pts = new cv.Mat();
  const detector = new cv.QRCodeDetectorAruco();
  try {
    let ok = detector.detect(img, pts);
    let v = Array.from(pts.data32F ?? []);
    if (ok && v.length >= 8) {
      const quad: Quad = [0, 2, 4, 6].map((i) => ({ x: v[i], y: v[i + 1] }));
      const xs = quad.map((p) => p.x);
      const ys = quad.map((p) => p.y);
      const box = {
        x: Math.floor(Math.min(...xs)),
        y: Math.floor(Math.min(...ys)),
        w: Math.ceil(Math.max(...xs) - Math.min(...xs)),
        h: Math.ceil(Math.max(...ys) - Math.min(...ys)),
      };
      if (box.w >= 8 && box.h >= 8) return { quad, box };
    }

    // Secondary detector: try jsQR on the raw pixels
    const jsFound = jsQR(rawData, info.width, info.height);
    if (jsFound?.location) {
      const loc = jsFound.location;
      const quad: Quad = [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner];
      const xs = quad.map((p) => p.x);
      const ys = quad.map((p) => p.y);
      const box = {
        x: Math.floor(Math.min(...xs)),
        y: Math.floor(Math.min(...ys)),
        w: Math.ceil(Math.max(...xs) - Math.min(...xs)),
        h: Math.ceil(Math.max(...ys) - Math.min(...ys)),
      };
      if (box.w >= 8 && box.h >= 8) return { quad, box };
    }

    // Tertiary check: inspect the upper-right quarter where the QR is placed
    const subLeft = Math.round(info.width * 0.45);
    const subTop = 0;
    const subW = info.width - subLeft;
    const subH = Math.round(info.height * 0.55);
    const sub = await sharp(bytes)
      .extract({ left: subLeft, top: subTop, width: subW, height: subH })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const subData = new Uint8ClampedArray(sub.data.buffer, sub.data.byteOffset, sub.data.length);
    const subJsFound = jsQR(subData, sub.info.width, sub.info.height);
    if (subJsFound?.location) {
      const loc = subJsFound.location;
      const quad: Quad = [
        { x: loc.topLeftCorner.x + subLeft, y: loc.topLeftCorner.y + subTop },
        { x: loc.topRightCorner.x + subLeft, y: loc.topRightCorner.y + subTop },
        { x: loc.bottomRightCorner.x + subLeft, y: loc.bottomRightCorner.y + subTop },
        { x: loc.bottomLeftCorner.x + subLeft, y: loc.bottomLeftCorner.y + subTop },
      ];
      const xs = quad.map((p) => p.x);
      const ys = quad.map((p) => p.y);
      const box = {
        x: Math.floor(Math.min(...xs)),
        y: Math.floor(Math.min(...ys)),
        w: Math.ceil(Math.max(...xs) - Math.min(...xs)),
        h: Math.ceil(Math.max(...ys) - Math.min(...ys)),
      };
      if (box.w >= 8 && box.h >= 8) return { quad, box };
    }

    return null;
  } finally {
    img.delete();
    pts.delete();
    detector.delete?.();
  }
}

export type SlotColour = "green" | "magenta";

const PURE: Record<SlotColour, (r: number, g: number, b: number) => boolean> = {
  green: (r, g, b) => g > 180 && r < 110 && b < 110 && g - Math.max(r, b) > 90,
  magenta: (r, g, b) => r > 160 && b > 160 && g < 130 && Math.min(r, b) - g > 60,
};

/**
 * The flat placeholder of one colour: the longest run of rows that are
 * mostly that colour, then the longest run of columns within them. Null
 * when there is none, or when what was found is too small to be a slot.
 */
export async function findSlot(bytes: Buffer, colour: SlotColour, minSide = 24): Promise<Rect | null> {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const hit = PURE[colour];
  const rows = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (hit(data[i], data[i + 1], data[i + 2])) rows[y]++;
    }
  }
  const longest = (hits: boolean[]) => {
    let best: [number, number] | null = null;
    for (let i = 0; i < hits.length; i++) {
      if (!hits[i]) continue;
      let j = i;
      while (j + 1 < hits.length && hits[j + 1]) j++;
      if (!best || j - i > best[1] - best[0]) best = [i, j];
      i = j;
    }
    return best;
  };
  const ry = longest(rows.map((n) => n >= minSide));
  if (!ry || ry[1] - ry[0] + 1 < minSide) return null;
  const cols = new Array(width).fill(0);
  for (let y = ry[0]; y <= ry[1]; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (hit(data[i], data[i + 1], data[i + 2])) cols[x]++;
    }
  }
  const rx = longest(cols.map((n) => n >= (ry[1] - ry[0] + 1) * 0.6));
  if (!rx || rx[1] - rx[0] + 1 < minSide) return null;
  return { x: rx[0], y: ry[0], w: rx[1] - rx[0] + 1, h: ry[1] - ry[0] + 1 };
}

/**
 * A placeholder painted out: the slot, a few pixels round it, and any green
 * fringe at its edge, filled from the picture around it with OpenCV's Telea
 * inpainting and then softened, so what is set there afterwards sits on the
 * design rather than on a green block. The model is asked to leave the slot
 * on a calm part of the design, and on sky or a plain colour the fill is not
 * visible; on a busy one it reads as a soft patch under the logo.
 */
export async function eraseSlot(bytes: Buffer, slot: Rect, bleed: number): Promise<Buffer> {
  const cv = await opencv();
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  // A tight search for any thin halo or glow immediately around the slot.
  // Reach is strictly bounded so concentric ring analysis never crosses into
  // adjacent design elements (hazard stripes, pillars, typography).
  const reach = Math.min(6, Math.max(2, Math.round(bleed * 0.5)));
  const margin = Math.max(12, Math.round(Math.max(slot.w, slot.h) * 0.2)) + reach + bleed;
  const left = Math.max(0, slot.x - margin);
  const top = Math.max(0, slot.y - margin);
  const width = Math.min(W, slot.x + slot.w + margin) - left;
  const height = Math.min(H, slot.y + slot.h + margin) - top;
  if (width < 4 || height < 4) return bytes;
  const { data } = await sharp(bytes).extract({ left, top, width, height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  // The model often draws a faint panel or glow round the slot, and a fill
  // taken from that ring comes out as a pale box behind the logo. So the
  // mean colour of each one-pixel ring round the slot is read, and the hole
  // grows past the outermost step in it: the edge of whatever was drawn.
  const ringOf = (X: number, Y: number) =>
    Math.max(slot.x - X, X - (slot.x + slot.w - 1), slot.y - Y, Y - (slot.y + slot.h - 1), 0);
  const sums = Array.from({ length: reach + 3 }, () => [0, 0, 0, 0]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = ringOf(left + x, top + y);
      if (d < 1 || d > reach + 2) continue;
      const i = (y * width + x) * 3;
      sums[d][0] += data[i];
      sums[d][1] += data[i + 1];
      sums[d][2] += data[i + 2];
      sums[d][3] += 1;
    }
  }
  const ring = sums.map(([r, g, b, n]) => (n ? [r / n, g / n, b / n] : null));
  let grow = Math.min(bleed, 4);
  for (let d = reach; d >= 1; d--) {
    const [a, b] = [ring[d], ring[d + 2]];
    if (a && b && Math.max(...[0, 1, 2].map((c) => Math.abs(a[c] - b[c]))) > 8) {
      grow = Math.min(reach + 1, Math.max(bleed, d + 1));
      break;
    }
  }

  // The slot and what grew round it, then any greenish pixel a little further
  // out: the anti-aliased edge is not pure enough to have been found as the slot.
  // Foreign graphic elements (dark borders/stripes, saturated non-green colors)
  // must NEVER be included in the inpaint mask, preventing color leaks.
  const mask = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const [r, g, b] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
      const fringe = g > 100 && g - r > 30 && g - b > 30;
      const isDarkGraphic = Math.max(r, g, b) < 65;
      const isSaturatedNonGreen = r > 140 && b < 100 && r - b > 40;
      const isForeign = isDarkGraphic || isSaturatedNonGreen;
      const d = ringOf(left + x, top + y);

      if (d === 0) {
        mask[i] = 255;
      } else if (!isForeign) {
        if (d <= grow || (fringe && d <= grow + bleed * 2)) {
          mask[i] = 255;
        }
      }
    }
  }

  const src = new cv.Mat(height, width, cv.CV_8UC3);
  const m = new cv.Mat(height, width, cv.CV_8UC1);
  const dst = new cv.Mat();
  try {
    src.data.set(data);
    m.data.set(mask);
    cv.inpaint(src, m, dst, 6, cv.INPAINT_TELEA);
    // Telea marches in from the edge and leaves faint streaks across a wide
    // hole; a blur inside the hole only takes them out.
    const smooth = await sharp(Buffer.from(dst.data), { raw: { width, height, channels: 3 } })
      .blur(Math.max(1, Math.min(slot.w, slot.h) / 8))
      .raw()
      .toBuffer();
    // One channel in comes back as three after a blur; the first is the mask.
    const alpha = await sharp(mask, { raw: { width, height, channels: 1 } }).blur(1.5).extractChannel(0).raw().toBuffer();
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = smooth[i * 3];
      rgba[i * 4 + 1] = smooth[i * 3 + 1];
      rgba[i * 4 + 2] = smooth[i * 3 + 2];
      rgba[i * 4 + 3] = alpha[i];
    }
    return await sharp(bytes)
      .composite([{ input: rgba, raw: { width, height, channels: 4 }, left, top }])
      .png()
      .toBuffer();
  } finally {
    src.delete();
    m.delete();
    dst.delete();
  }
}

/**
 * Where the words are on a finished frame: lines of type, found the classic
 * way (a morphological gradient, Otsu's threshold, a horizontal close to join
 * letters into lines) and kept when they are line-shaped. It also finds the
 * odd row of windows or rail of a balcony; freezing those costs nothing,
 * because they are not meant to move either. Rows spanning the whole frame
 * are left out: those are a beam or a horizon, not a line of text.
 */
export async function textZones(bytes: Buffer): Promise<Rect[]> {
  const cv = (await opencv()) as CV & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data, info } = await sharp(bytes).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const grey = new cv.Mat(H, W, cv.CV_8UC1);
  const grad = new cv.Mat();
  const bw = new cv.Mat();
  const closed = new cv.Mat();
  const hier = new cv.Mat();
  const contours = new cv.MatVector();
  const round = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
  const line = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(5, Math.round(W / 60)), 1));
  try {
    grey.data.set(data);
    cv.morphologyEx(grey, grad, cv.MORPH_GRADIENT, round);
    cv.threshold(grad, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    cv.morphologyEx(bw, closed, cv.MORPH_CLOSE, line);
    cv.findContours(closed, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const out: Rect[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const r = cv.boundingRect(c);
      c.delete();
      const lineShaped = r.width > r.height * 1.5 && r.height >= 8 && r.height <= H * 0.08 && r.width >= 20;
      const spansFrame = r.width > W * 0.9 && r.height > H * 0.02;
      if (lineShaped && !spansFrame) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    }
    return out;
  } finally {
    [grey, grad, bw, closed, hier, round, line].forEach((m) => m.delete());
    contours.delete();
  }
}
