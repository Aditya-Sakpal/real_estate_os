import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import jsQR from "jsqr";
import { findQr } from "./qr-detect.ts";
import { OCR_ENGINE, readLines, type OcrLine } from "./ocr.ts";
import {
  finding,
  CAPTURE_BLUR,
  CAPTURE_PX_PER_MM,
  judgeFrame,
  locateImpression,
  locatePhone,
  locateRegistration,
  locateSite,
  locate,
  pixelRecord,
  PRINT_DPIS,
  QR_SCALES,
  REGION_CLOSE_LEVELS,
  type FrameExpect,
  type Glyph,
  type Measured,
  type PixelFinding,
  type PixelRecord,
  type PxBox,
  type RasterReading,
  type WordBox,
} from "./pixel-rules.ts";

/**
 * The pixel gate, run: a finished frame read the way a buyer and a
 * regulator would read it, then judged by `pixel-rules.ts`.
 *
 * The reading is three things, all on this machine and none paid for. The QR
 * is found and decoded with jsQR, then decoded again at the sizes a phone
 * shows the post and after a simulated print and photograph. The words are
 * read by OCR (`ocr.ts`) three times over: the whole frame, the upper-right
 * quarter enlarged, and the foot enlarged, because small print read at its
 * own size is noise. And what the rules need measured is measured on the
 * pixels themselves: each glyph of the registration number as a connected
 * component of ink (its height, and its shape, which is what tells an O from
 * a 0), and the contrast of a line's stroke core against the ground round it.
 *
 * The reader is a seam (`PixelReader`), injected by the suites whose image
 * model is a fake that draws no words; the rules are never replaced.
 *
 * Imports are relative because the worker loads this straight from source.
 */

const exec = promisify(execFile);

export type PixelReader = (bytes: Buffer, expect: FrameExpect) => Promise<RasterReading>;

// ---------------------------------------------------------------------------
// The QR
// ---------------------------------------------------------------------------

type Decoded = { payload: string; box: PxBox };

async function decode(img: sharp.Sharp): Promise<{ data: string; loc: { x: number; y: number }[] } | null> {
  const { data, info } = await img.flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
  if (!found?.data) return null;
  const l = found.location;
  return { data: found.data, loc: [l.topLeftCorner, l.topRightCorner, l.bottomLeftCorner, l.bottomRightCorner] };
}

const boxOf = (pts: { x: number; y: number }[], scale: number, dx: number, dy: number): PxBox => {
  const xs = pts.map((p) => p.x / scale + dx);
  const ys = pts.map((p) => p.y / scale + dy);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

/** A region of the picture, clamped to it. */
function clamp(b: PxBox, W: number, H: number) {
  const left = Math.max(0, Math.floor(b.x));
  const top = Math.max(0, Math.floor(b.y));
  return { left, top, width: Math.max(1, Math.min(W - left, Math.ceil(b.w + (b.x - left)))), height: Math.max(1, Math.min(H - top, Math.ceil(b.h + (b.y - top)))) };
}

/**
 * The QR on the frame, found and decoded: first as the whole picture, then
 * where OpenCV finds its finder patterns, then in the upper-right quarter
 * enlarged. A small code in a large frame is read far more reliably cut out.
 */
async function findCode(bytes: Buffer, W: number, H: number): Promise<Decoded | null> {
  const whole = await decode(sharp(bytes));
  if (whole) return { payload: whole.data, box: boxOf(whole.loc, 1, 0, 0) };
  const regions: PxBox[] = [];
  const seen = await findQr(bytes).catch(() => null);
  if (seen) {
    const pad = Math.max(seen.box.w, seen.box.h) * 0.3;
    regions.push({ x: seen.box.x - pad, y: seen.box.y - pad, w: seen.box.w + pad * 2, h: seen.box.h + pad * 2 });
  }
  regions.push({ x: W / 2, y: 0, w: W / 2, h: H / 2 });
  for (const r of regions) {
    const c = clamp(r, W, H);
    if (c.width < 12 || c.height < 12) continue;
    const k = Math.min(4, Math.max(1, 900 / Math.max(c.width, c.height)));
    const got = await decode(sharp(bytes).extract(c).resize(Math.round(c.width * k), Math.round(c.height * k), { kernel: "nearest" }));
    if (got) return { payload: got.data, box: boxOf(got.loc, k, c.left, c.top) };
  }
  return null;
}

/**
 * Whether a patch holds the code: handed to the decoder enlarged three ways,
 * because jsQR is stricter than the scanner in a buyer's phone and a code
 * one of them reads is a code that scans. It is the size the screen or the
 * camera shows the code at that decides, not the decoder's own quirks.
 */
async function holds(patch: Buffer, w: number, h: number, payload: string): Promise<boolean> {
  for (const kernel of ["nearest", "linear", "cubic"] as const) {
    const got = await decode(sharp(patch).resize(w * 4, h * 4, { kernel }));
    if (got?.data === payload) return true;
  }
  return false;
}

/**
 * The code decoded again as a buyer meets it: the whole frame shown smaller
 * (`QR_SCALES`, resampled the way a browser scales an image), and the code
 * printed at each of `PRINT_DPIS` and seen by a phone's camera
 * (`CAPTURE_PX_PER_MM`, softened by `CAPTURE_BLUR`).
 */
async function renditions(bytes: Buffer, W: number, H: number, code: Decoded): Promise<{ name: string; ok: boolean }[]> {
  const pad = Math.max(code.box.w, code.box.h) * 0.35;
  const around: PxBox = { x: code.box.x - pad, y: code.box.y - pad, w: code.box.w + pad * 2, h: code.box.h + pad * 2 };
  const out: { name: string; ok: boolean }[] = [];
  for (const s of QR_SCALES) {
    const name = `screen ${Math.round(s * 100)}%`;
    if (s === 1) {
      out.push({ name, ok: true });
      continue;
    }
    const w = Math.max(1, Math.round(W * s));
    const h = Math.max(1, Math.round(H * s));
    const small = await sharp(bytes).resize(w, h, { fit: "fill", kernel: "cubic" }).png().toBuffer();
    const c = clamp({ x: around.x * s, y: around.y * s, w: around.w * s, h: around.h * s }, w, h);
    const cut = await sharp(small).extract(c).png().toBuffer();
    out.push({ name, ok: await holds(cut, c.width, c.height, code.payload) });
  }
  const c = clamp(around, W, H);
  for (const dpi of PRINT_DPIS) {
    const f = (25.4 / dpi) * CAPTURE_PX_PER_MM;
    const cw = Math.max(8, Math.round(c.width * f));
    const ch = Math.max(8, Math.round(c.height * f));
    const seen = await sharp(bytes).extract(c).resize(cw, ch, { fit: "fill", kernel: "cubic" }).blur(CAPTURE_BLUR).png().toBuffer();
    out.push({ name: `print ${dpi} dpi`, ok: await holds(seen, cw, ch, code.payload) });
  }
  // A code that scans smaller scans larger: a larger rendition the decoder
  // missed while a smaller one read is the decoder's quirk, not the code's.
  const screen = out.slice(0, QR_SCALES.length);
  const print = out.slice(QR_SCALES.length);
  screen.forEach((r, i) => (r.ok ||= screen.slice(i + 1).some((x) => x.ok)));
  print.forEach((r, i) => (r.ok ||= print.slice(i + 1).some((x) => x.ok)));
  return out;
}

// ---------------------------------------------------------------------------
// Measuring a line of type
// ---------------------------------------------------------------------------

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const relLum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

type Patch = { rgb: Buffer; w: number; h: number; k: number; inner: { x0: number; y0: number; x1: number; y1: number } };

/** A line's box and a margin round it, enlarged so its strokes are several pixels wide. */
async function patch(bytes: Buffer, box: PxBox, W: number, H: number): Promise<Patch | null> {
  const mv = box.h * 0.35;
  const mh = Math.max(box.h * 0.4, 3);
  const c = clamp({ x: box.x - mh, y: box.y - mv, w: box.w + mh * 2, h: box.h + mv * 2 }, W, H);
  if (c.width < 3 || c.height < 3) return null;
  const k = Math.min(8, Math.max(1, 64 / Math.max(1, box.h)));
  const w = Math.max(1, Math.round(c.width * k));
  const h = Math.max(1, Math.round(c.height * k));
  const rgb = await sharp(bytes).extract(c).resize(w, h, { fit: "fill", kernel: "lanczos3" }).removeAlpha().raw().toBuffer();
  return {
    rgb,
    w,
    h,
    k,
    inner: {
      x0: Math.max(0, Math.round((box.x - c.left) * k)),
      y0: Math.max(0, Math.round((box.y - c.top) * k)),
      x1: Math.min(w, Math.round((box.x + box.w - c.left) * k)),
      y1: Math.min(h, Math.round((box.y + box.h - c.top) * k)),
    },
  };
}

/** Otsu's threshold over 0 to 255 values. */
function otsu(values: Uint8Array | number[]): number {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[v]++;
  const total = values.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let [sumB, wB, best, cut] = [0, 0, -1, 128];
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB || wB === total) continue;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / (total - wB);
    const between = wB * (total - wB) * (mB - mF) ** 2;
    if (between > best) [best, cut] = [between, t];
  }
  return cut;
}

/**
 * Which pixels of a patch are ink. The ground is read off the patch's edge,
 * which is the picture round the line; ink is whichever side of Otsu's split
 * lies further from it, so white type on a dark band and navy type on a pale
 * sky are both read the right way round.
 */
function inkOf(p: Patch): { ink: Uint8Array; grey: Uint8Array; ground: number } {
  const n = p.w * p.h;
  const grey = new Uint8Array(n);
  for (let i = 0; i < n; i++) grey[i] = Math.round(0.299 * p.rgb[i * 3] + 0.587 * p.rgb[i * 3 + 1] + 0.114 * p.rgb[i * 3 + 2]);
  const edge: number[] = [];
  const band = Math.max(1, Math.round(p.k));
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      if (x < band || y < band || x >= p.w - band || y >= p.h - band) edge.push(grey[y * p.w + x]);
    }
  }
  edge.sort((a, b) => a - b);
  const ground = edge[Math.floor(edge.length / 2)] ?? 128;
  const cut = otsu(grey);
  let lo = 0;
  let hi = 0;
  let nlo = 0;
  let nhi = 0;
  for (const v of grey) {
    if (v <= cut) {
      lo += v;
      nlo++;
    } else {
      hi += v;
      nhi++;
    }
  }
  const darkInk = Math.abs((nlo ? lo / nlo : 0) - ground) >= Math.abs((nhi ? hi / nhi : 255) - ground);
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = (darkInk ? grey[i] <= cut : grey[i] > cut) ? 1 : 0;
  return { ink, grey, ground };
}

/**
 * The glyphs of a line: its connected pieces of ink, left to right, less
 * the dots, commas and anything cut by the edge of the patch.
 */
function glyphsOf(p: Patch, ink: Uint8Array): { x: number; y: number; w: number; h: number }[] {
  const seen = new Uint8Array(ink.length);
  const comps: { x: number; y: number; w: number; h: number; edge: boolean }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || seen[s]) continue;
    let [x0, y0, x1, y1] = [p.w, p.h, -1, -1];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % p.w;
      const y = (i - x) / p.w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= p.w || ny >= p.h) continue;
        const j = ny * p.w + nx;
        if (ink[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    comps.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, edge: x0 === 0 || y0 === 0 || x1 === p.w - 1 || y1 === p.h - 1 });
  }
  // Inside the line's own box, not a neighbour's letter leaking in at the margin.
  const { x0, y0, x1, y1 } = p.inner;
  const inside = comps.filter((c) => !c.edge && c.x + c.w / 2 >= x0 && c.x + c.w / 2 <= x1 && c.y + c.h / 2 >= y0 && c.y + c.h / 2 <= y1);
  const tallest = Math.max(0, ...inside.map((c) => c.h));
  return inside.filter((c) => c.h >= tallest * 0.3).sort((a, b) => a.x - b.x);
}

/**
 * How tall a line's letters are, in the picture's pixels. Capitals and
 * figures are measured as they are; a lower-case word is measured by its
 * tallest letters, the ascenders, scaled to a capital's height, so a web
 * address and a registration number are compared like for like.
 */
function heightOf(glyphs: { h: number }[], k: number, caps: boolean): number | null {
  if (!glyphs.length) return null;
  const hs = glyphs.map((g) => g.h).sort((a, b) => a - b);
  const v = caps ? hs[Math.floor(hs.length / 2)] : hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.8))] * 0.94;
  return v / k;
}

/**
 * The contrast of a line against its ground: the core of its strokes (the
 * half of the ink furthest from the ground) against the ground round it (the
 * half of the rest nearest the edge's colour), in WCAG's luminance.
 */
function contrastOf(p: Patch, ink: Uint8Array, grey: Uint8Array, ground: number): number | null {
  const inkPx: number[] = [];
  const groundPx: number[] = [];
  for (let i = 0; i < ink.length; i++) (ink[i] ? inkPx : groundPx).push(i);
  if (inkPx.length < 4 || groundPx.length < 4) return null;
  const core = inkPx.sort((a, b) => Math.abs(grey[b] - ground) - Math.abs(grey[a] - ground)).slice(0, Math.ceil(inkPx.length / 2));
  const back = groundPx.sort((a, b) => Math.abs(grey[a] - ground) - Math.abs(grey[b] - ground)).slice(0, Math.ceil(groundPx.length / 2));
  const mean = (ids: number[]) => {
    const s = [0, 0, 0];
    for (const i of ids) for (let c = 0; c < 3; c++) s[c] += p.rgb[i * 3 + c];
    return s.map((v) => v / ids.length);
  };
  const [a, b] = [mean(core), mean(back)];
  const la = relLum(a[0], a[1], a[2]);
  const lb = relLum(b[0], b[1], b[2]);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

async function measure(
  bytes: Buffer,
  found: { raw: string; box: PxBox },
  W: number,
  H: number,
  caps: boolean,
): Promise<Measured & { glyphs: Glyph[] }> {
  const p = await patch(bytes, found.box, W, H);
  if (!p) return { text: found.raw, box: found.box, glyphPx: null, contrast: null, glyphs: [] };
  const { ink, grey, ground } = inkOf(p);
  const glyphs = glyphsOf(p, ink);
  return {
    text: found.raw,
    box: found.box,
    glyphPx: heightOf(glyphs, p.k, caps),
    contrast: contrastOf(p, ink, grey, ground),
    glyphs: glyphs.map((g) => ({ w: g.w / p.k, h: g.h / p.k })),
  };
}

// ---------------------------------------------------------------------------
// Reading a frame
// ---------------------------------------------------------------------------

const words = (lines: OcrLine[]): { words: WordBox[] }[] => lines.map((l) => ({ words: l.words.map((w) => ({ text: w.text, box: w.box })) }));

/**
 * One read's lines joined into rows: pieces of one line of type that the
 * reader returned as separate lines, side by side on one baseline. "Artist's"
 * and "impression" came back as two lines of a live post's small print, and
 * a phrase looked for inside one line was never found.
 */
function rowsOf(lines: OcrLine[]): { words: WordBox[] }[] {
  const out: { words: WordBox[] }[] = [];
  const sorted = [...lines].sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));
  const used = new Set<OcrLine>();
  for (const l of sorted) {
    if (used.has(l)) continue;
    const row = sorted.filter((m) => {
      if (used.has(m)) return false;
      const top = Math.max(l.box.y, m.box.y);
      const bottom = Math.min(l.box.y + l.box.h, m.box.y + m.box.h);
      return bottom - top >= Math.min(l.box.h, m.box.h) * 0.5;
    });
    row.forEach((m) => used.add(m));
    if (row.length < 2) continue;
    out.push({ words: row.sort((a, b) => a.box.x - b.box.x).flatMap((m) => m.words.map((w) => ({ text: w.text, box: w.box }))) });
  }
  return out;
}

/** Scale for a read: enough that small print is legible, capped so a big frame is not read for minutes. */
const scaleFor = (area: number, want: number, pixels: number) => Math.max(1, Math.min(want, Math.sqrt(pixels / Math.max(1, area))));

const overlaps = (a: PxBox, b: PxBox) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** The real reader: jsQR, OpenCV and Tesseract, all on this machine. */
export const readRaster: PixelReader = async (bytes, expect) => {
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;

  const code = await findCode(bytes, W, H);
  const qr = code
    ? { box: code.box, payload: code.payload, renditions: await renditions(bytes, W, H, code) }
    : { box: null, payload: null, renditions: [] };

  // The QR is blanked for reading: beside a block of text, Tesseract takes a
  // code for a picture and drops the words sitting next to it with it.
  let page = bytes;
  if (qr.box) {
    const pad = Math.max(qr.box.w, qr.box.h) * 0.1;
    const c = clamp({ x: qr.box.x - pad, y: qr.box.y - pad, w: qr.box.w + pad * 2, h: qr.box.h + pad * 2 }, W, H);
    const blank = await sharp({ create: { width: c.width, height: c.height, channels: 3, background: "#ffffff" } }).png().toBuffer();
    page = await sharp(bytes).composite([{ input: blank, left: c.left, top: c.top }]).png().toBuffer();
  }
  const quarterBox = { x: W * 0.4, y: 0, w: W * 0.6, h: H * 0.6 };
  const footBox = { x: 0, y: H * 0.78, w: W, h: H * 0.22 };
  const [quarter, foot, whole] = [
    await readLines(page, quarterBox, scaleFor(quarterBox.w * quarterBox.h, 3, 3e6)),
    await readLines(page, footBox, scaleFor(footBox.w * footBox.h, 3, 3e6)),
    // The whole frame, less enlarged, as the net under the two regions where
    // the block and the small print belong: it finds them where they do not.
    await readLines(page, null, scaleFor(W * H, 1.6, 3.5e6)),
  ];
  // The enlarged reads first: where two reads found the same thing, the
  // closer one is the better.
  const all = [...quarter, ...foot, ...whole];
  const ws = [
    ...words(all),
    ...[quarter, foot, whole].flatMap((read) => [0, 1].flatMap((pass) => rowsOf(read.filter((l) => l.pass === pass)))),
  ];
  // Light type straight on a dark picture is the reader's weak spot: small
  // white words on a film's darkened corner, plain to the eye, came back
  // with both ends cut off from a read of the whole quarter. Where the
  // number or the Authority's website was not found, the block round the QR
  // (or the quarter, with no QR) is read again, closer, and as a negative,
  // where the same words are dark type on a light ground.
  if (expect.registrationNo && (!locateRegistration(ws, expect.registrationNo).length || !locateSite(ws, expect.authority.website).length)) {
    const around = qr.box
      ? { x: qr.box.x - qr.box.w * 6, y: qr.box.y - qr.box.h, w: qr.box.w * 8, h: qr.box.h * 3.5 }
      : quarterBox;
    const k = scaleFor(around.w * around.h, 3, 3e6);
    // Only to find the block: a negative of a busy picture reads noise, and
    // noise with a figure in it is not to be judged as a price.
    for (const invert of [false, true]) {
      const again = await readLines(page, around, k, ["0", "2"], invert);
      ws.push(...words(again), ...[0, 1].flatMap((pass) => rowsOf(again.filter((l) => l.pass === pass))));
    }
  }
  // The closest reading, and of equally close ones the tightest box: a line
  // two reads merged with its neighbour measures the neighbour too.
  const best = <T extends { edits: number; box: PxBox }>(xs: T[]) =>
    [...xs].sort((a, b) => a.edits - b.edits || a.box.h - b.box.h)[0] ?? null;

  let registration: RasterReading["registration"] = null;
  if (expect.registrationNo) {
    const hits = locateRegistration(ws, expect.registrationNo);
    const top = best(hits);
    if (top) {
      // One more read, of just that line, enlarged until its capitals are
      // about forty pixels tall: the read the verdict rests on.
      const pad = top.box.h * 0.6;
      const k = Math.max(2, Math.min(8, 40 / Math.max(4, top.box.h)));
      const again = await readLines(page, { x: top.box.x - pad * 2, y: top.box.y - pad, w: top.box.w + pad * 4, h: top.box.h + pad * 2 }, k, ["0"]);
      const reads = [
        ...hits.filter((h) => overlaps(h.box, top.box)).map((h) => h.raw),
        ...locateRegistration(words(again), expect.registrationNo).map((h) => h.raw),
      ];
      const m = await measure(bytes, top, W, H, true);
      registration = { ...m, reads };
    }
  }

  const site = expect.registrationNo ? best(locateSite(ws, expect.authority.website)) : null;
  const website = site ? await measure(bytes, site, W, H, false) : null;
  const phoneAt = expect.phone ? best(locatePhone(ws, expect.phone)) : null;
  const phone = phoneAt ? await measure(bytes, phoneAt, W, H, true) : null;
  const ownSite = expect.website ? best(locateSite(ws, expect.website)) : null;
  const contactSite = ownSite ? await measure(bytes, ownSite, W, H, false) : null;
  const impressionAt = best(locateImpression(ws));
  const impression = impressionAt ? await measure(bytes, impressionAt, W, H, false) : null;
  const noteAt = best(locate(ws, "startingbaseprice", { fold: (s) => s.toLowerCase().replace(/[^a-z]/g, ""), maxEdits: 2 }));
  const smallPrint = noteAt ? [await measure(bytes, noteAt, W, H, false)] : [];

  const strip = <T extends { glyphs?: Glyph[] }>(m: T | null) => {
    if (!m) return null;
    const { glyphs: _g, ...rest } = m as T & { glyphs?: Glyph[] };
    return rest as Omit<T, "glyphs">;
  };
  return {
    w: W,
    h: H,
    qr,
    lines: all.map((l) => ({ text: l.text, box: l.box })),
    registration,
    website: strip(website) as Measured | null,
    phone: strip(phone) as Measured | null,
    contactSite: strip(contactSite) as Measured | null,
    impression: strip(impression) as Measured | null,
    smallPrint: smallPrint.map((m) => strip(m) as Measured),
  };
};

// ---------------------------------------------------------------------------
// The gate over a post's files
// ---------------------------------------------------------------------------

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * The findings on one frame. The same bytes checked against the same things
 * are read once: the design loop checks every drawing, and the drawing it
 * keeps is checked again as the post's file, which is the same JPEG.
 */
const memo = new Map<string, Promise<PixelFinding[]>>();

export async function checkFrame(
  bytes: Buffer,
  expect: FrameExpect,
  opts: { reader?: PixelReader; region?: { expected: Buffer; mask?: Buffer | null } | null } = {},
): Promise<PixelFinding[]> {
  // Only the real reader's answers are remembered: an injected one is a
  // suite's script, and may answer the same bytes differently on purpose.
  const key = opts.reader ? null : `${sha256(bytes)}:${sha256(Buffer.from(JSON.stringify(expect)))}:${opts.region ? sha256(opts.region.expected) : ""}`;
  const cached = key ? memo.get(key) : undefined;
  if (cached) return cached;
  const run = (async () => {
    try {
      const reading = await (opts.reader ?? readRaster)(bytes, expect);
      if (opts.region) reading.region = await compareRegion(bytes, opts.region.expected, opts.region.mask ?? null);
      return judgeFrame(reading, expect);
    } catch (e) {
      console.warn("pixel: a frame could not be read,", e instanceof Error ? e.message : String(e));
      return judgeFrame({ w: 0, h: 0, qr: { box: null, payload: null, renditions: [] }, lines: [], registration: null, website: null, phone: null, contactSite: null, impression: null, smallPrint: [], error: "The reader failed." }, expect);
    }
  })();
  if (key) {
    memo.set(key, run);
    if (memo.size > 64) memo.delete(memo.keys().next().value!);
  }
  return run;
}

/**
 * How far a region of a frame is from what it should be, pixel for pixel:
 * the mean difference over the compared pixels and the share within
 * `REGION_CLOSE_LEVELS` levels. `mask` marks, one byte a pixel, what to
 * compare; without one, all of it.
 */
export async function compareRegion(
  actual: Buffer,
  expected: Buffer,
  mask: Buffer | null,
): Promise<{ meanDiff: number; closeShare: number }> {
  const meta = await sharp(expected).metadata();
  const w = meta.width ?? 1;
  const h = meta.height ?? 1;
  const a = await sharp(actual).extract({ left: 0, top: 0, width: w, height: h }).removeAlpha().raw().toBuffer();
  const b = await sharp(expected).removeAlpha().raw().toBuffer();
  let sum = 0;
  let close = 0;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask && !mask[i]) continue;
    const d = Math.max(Math.abs(a[i * 3] - b[i * 3]), Math.abs(a[i * 3 + 1] - b[i * 3 + 1]), Math.abs(a[i * 3 + 2] - b[i * 3 + 2]));
    sum += d;
    if (d <= REGION_CLOSE_LEVELS) close++;
    n++;
  }
  return n ? { meanDiff: sum / n, closeShare: close / n } : { meanDiff: 0, closeShare: 1 };
}

/**
 * Frames of a video at the given seconds, as PNGs, each with the second it
 * was really read at. A moment past the last frame (a plan's timing against
 * a film that came back shorter) is read a little earlier, and one that
 * still yields no frame is left out rather than failing the whole check.
 */
export async function framesAt(video: Buffer, times: readonly number[]): Promise<{ at: number; png: Buffer }[]> {
  const dir = await mkdtemp(join(tmpdir(), "salesdesk-pixel-"));
  try {
    await writeFile(join(dir, "in.mp4"), video);
    const out: { at: number; png: Buffer }[] = [];
    for (let i = 0; i < times.length; i++) {
      for (const at of [times[i], Math.max(0, times[i] - 0.5), Math.max(0, times[i] - 1.5)]) {
        const file = join(dir, `f${i}-${Math.round(at * 100)}.png`);
        await exec(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-loglevel", "error", "-ss", String(at), "-i", join(dir, "in.mp4"), "-frames:v", "1", file], {
          maxBuffer: 16 * 1024 * 1024,
        }).catch(() => {});
        const png = await readFile(file).catch(() => null);
        if (png) {
          out.push({ at: times[i], png });
          break;
        }
      }
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export type GateFile = { bytes: Buffer; type: string };

/**
 * The gate over every file of a post: each picture read whole, each video
 * read at `times` (the first, middle and last of every shot and the end
 * card, from `sampleTimes()`), and the record kept with the post.
 */
export async function gatePost(input: {
  files: readonly GateFile[];
  /** What a frame must carry: by file, and for a video by the second it was read at. */
  expect: (file: number, at?: number) => FrameExpect;
  /** For a video: the seconds to read. */
  times?: (file: number) => readonly number[];
  /** For a picture whose approved region is known: what that region must still be. */
  region?: (file: number) => { expected: Buffer; mask?: Buffer | null } | null;
  registrationNo: string | null;
  reader?: PixelReader;
  now?: Date;
}): Promise<PixelRecord> {
  const files: { sha256: string; frames: { at?: number; findings: PixelFinding[] }[] }[] = [];
  for (let i = 0; i < input.files.length; i++) {
    const f = input.files[i];
    if (f.type.startsWith("video/")) {
      const times = input.times?.(i) ?? [];
      const stills = times.length ? await framesAt(f.bytes, times) : [];
      const frames: { at?: number; findings: PixelFinding[] }[] = [];
      for (const s of stills) {
        frames.push({ at: s.at, findings: await checkFrame(s.png, input.expect(i, s.at), { reader: input.reader }) });
      }
      // A video nothing could be read from has not passed anything.
      if (!frames.length) frames.push({ findings: [finding("NOT_CHECKED", "no frame of the video could be read")] });
      files.push({ sha256: sha256(f.bytes), frames });
    } else {
      const findings = await checkFrame(f.bytes, input.expect(i), { reader: input.reader, region: input.region?.(i) ?? null });
      files.push({ sha256: sha256(f.bytes), frames: [{ findings }] });
    }
  }
  return pixelRecord({ engine: OCR_ENGINE, now: input.now ?? new Date(), registrationNo: input.registrationNo, files });
}

/** The media list with each file's hash beside it, so a publish can tell the file that passed from any other. */
export function withHashes<T extends object>(media: readonly T[], record: PixelRecord): (T & { sha256: string })[] {
  return media.map((m, i) => ({ ...m, sha256: record.files[i]?.sha256 ?? "" }));
}

/** One audit row per check: the verdict, the codes and the raster's hashes. Never a word of the copy. */
export async function auditPixel(input: {
  orgId: string;
  actorUserId: string | null;
  targetType: string;
  targetId: string;
  record: PixelRecord;
}): Promise<void> {
  // Loaded here, so the reader and the rules load without a database.
  const { audit } = await import("./db/index.ts");
  await audit({
    orgId: input.orgId,
    actorUserId: input.actorUserId,
    action: "creative.pixel_checked",
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: {
      verdict: input.record.verdict,
      codes: [...new Set(input.record.findings.map((f) => f.code))],
      sha256: input.record.files.map((f) => f.sha256),
      frames: input.record.files.reduce((n, f) => n + f.frames, 0),
      engine: input.record.engine,
    },
  });
}
