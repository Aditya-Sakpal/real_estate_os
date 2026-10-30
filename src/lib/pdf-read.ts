import { join } from "node:path";
import sharp from "sharp";
import { OCR_ENGINE, readLines } from "./ocr.ts";
import {
  betterRead,
  devanagariModels,
  extractUsd,
  segmentsFromVision,
  VISION_LONG_SIDE,
  VISION_READ_MODEL,
  VISION_READ_SCHEMA,
  VISION_READ_SYSTEM,
  readQuality,
  wantsDevanagariRead,
  hasTextLayer,
  numberSegments,
  segmentsFromItems,
  segmentsFromOcr,
  type DocType,
  type PageText,
  type RawItem,
  type Segment,
} from "./extract-rules.ts";
import { askJson, type AskDriver } from "./generate.ts";

/**
 * A document as pieces of text with boxes, read on this machine.
 *
 * A PDF's own text layer first, through pdf.js (Apache 2.0): it is exact,
 * instant and free, and most price lists, certificates and agreements are
 * made in a word processor and carry one. A page with no text on it (a scan,
 * or a brochure whose type was turned into outlines) is drawn to a picture
 * and transcribed by a vision model (`VISION_READ_MODEL`), as is a picture
 * uploaded as a document; each page's cost rides on it (`PageText.usd`).
 * Tesseract reads it only when the model could not, twice.
 *
 * A text layer is read in whatever script it is set in: a Marathi or Hindi
 * price list made in a word processor comes through in Devanagari, its
 * digits folded later by the checks that read it (`cleanItem()` keeps the
 * pieces a Devanagari layer sets with no width). A scanned page is read by
 * Tesseract in English first; a read that looks like a Devanagari page seen
 * through English eyes (`wantsDevanagariRead()`) is read again with the
 * Hindi and Marathi models, which are in node_modules like the English one,
 * and the surer of the two reads is kept (`betterRead()`). Nothing is
 * fetched at run time.
 *
 * pdf.js draws through `@napi-rs/canvas`, its own optional companion, which
 * ships prebuilt for Windows and Linux. Both are server externals.
 */

export const READER_ENGINE = `pdf.js text layer; ${VISION_READ_MODEL} for a page without one; ${OCR_ENGINE} when it could not`;

/** The vision model, or a suite's own (null: none, Tesseract reads). */
let visionInjected: AskDriver | null | undefined;
export function useVisionReader(d: AskDriver | null | undefined): void {
  visionInjected = d;
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfTask = ReturnType<PdfJs["getDocument"]>;
type PdfDoc = Awaited<PdfTask["promise"]> & { close: () => Promise<void> };

let pdfjs: Promise<PdfJs> | null = null;
const lib = () => (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

const asset = (dir: string) => `${join(process.cwd(), "node_modules", "pdfjs-dist", dir)}/`.replace(/\\/g, "/");

/**
 * Open a document. It is closed through its loading task: pdf.js 6 took
 * `destroy()` off the document itself, and a document never closed keeps
 * its worker's copy of every page in memory.
 */
async function open(bytes: Buffer): Promise<PdfDoc> {
  const p = await lib();
  const task = p.getDocument({
    // A copy: pdf.js may take ownership of the buffer it is handed.
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    standardFontDataUrl: asset("standard_fonts"),
    wasmUrl: asset("wasm"),
    iccUrl: asset("iccs"),
    cMapUrl: asset("cmaps"),
    cMapPacked: true,
    // Pictures decoded to plain pixels, which `readPictures()` can hand to sharp.
    isOffscreenCanvasSupported: false,
  });
  const doc = await task.promise.catch(async (e) => {
    await task.destroy().catch(() => {});
    throw e;
  });
  return Object.assign(doc, { close: () => task.destroy() });
}

export type Inspected =
  | { ok: true; pages: number }
  | { ok: false; code: "LOCKED" | "UNREADABLE"; message: string };

/** How many pages a file has, or why it cannot be read at all. */
export async function inspectDocument(bytes: Buffer, type: DocType): Promise<Inspected> {
  if (type !== "application/pdf") {
    const meta = await sharp(bytes).metadata().catch(() => null);
    return meta?.width && meta.height
      ? { ok: true, pages: 1 }
      : { ok: false, code: "UNREADABLE", message: "That picture could not be opened." };
  }
  try {
    const doc = await open(bytes);
    const pages = doc.numPages;
    await doc.close();
    return { ok: true, pages };
  } catch (e) {
    if ((e as { name?: string }).name === "PasswordException") {
      return { ok: false, code: "LOCKED", message: "That PDF is locked with a password. Upload one without it." };
    }
    return { ok: false, code: "UNREADABLE", message: "That PDF could not be opened." };
  }
}

/** The longest side a page is drawn at before it is read by OCR: about 225 DPI on A4. */
const OCR_LONG_SIDE = 2600;
/** Pages the vision model reads at once. */
const READ_AT_ONCE = 4;
/** And for the review screen. */
const PREVIEW_LONG_SIDE = 1600;

async function drawPage(doc: PdfDoc, n: number, longSide: number): Promise<{ png: Buffer; width: number; height: number }> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = longSide / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
  const ctx = canvas.getContext("2d");
  // A transparent page reads as black to the OCR and to a JPEG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
  const png = await canvas.encode("png");
  page.cleanup();
  return { png: Buffer.from(png), width: canvas.width, height: canvas.height };
}

/** The pieces of text pdf.js reports for one page, as boxes from the top left. */
async function textItems(doc: PdfDoc, n: number): Promise<{ items: RawItem[]; width: number; height: number }> {
  const p = await lib();
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: RawItem[] = [];
  for (const raw of content.items) {
    const it = raw as { str?: string; transform?: number[]; width?: number };
    if (!it.str || !it.transform) continue;
    const tx = p.Util.transform(viewport.transform, it.transform) as number[];
    const size = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    // Text set at an angle (a sidebar running up the page) is rare in the
    // documents that carry facts, and a box around it would be a lie.
    if (Math.abs(Math.sin(angle)) > 0.2 || size <= 0) continue;
    const width = (it.width ?? 0) * viewport.scale;
    items.push({ text: it.str, x: tx[4], y: tx[5] - size * 0.8, w: width, h: size });
  }
  page.cleanup();
  return { items, width: viewport.width, height: viewport.height };
}

export type ReadOptions = {
  /** The languages the organisation's briefs are written in, to choose the Devanagari models. */
  languages?: readonly string[];
  /** Asked before a page is sent to the paid reader; throws to refuse it. */
  beforePaid?: () => Promise<void> | void;
  /** Only the text layer: a page without one comes back empty, read by nothing. */
  textOnly?: boolean;
};

type Read = { segs: Omit<Segment, "id">[]; width: number; height: number; models: string; usd?: number };

/** A page picture read by the vision model, or null when it could not be, twice. */
async function visionRead(png: Buffer, opts: ReadOptions): Promise<Read | null> {
  const ask = visionInjected === undefined ? askJson : visionInjected;
  if (!ask) return null;
  const view = await sharp(png)
    .resize({ width: VISION_LONG_SIDE, height: VISION_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer({ resolveWithObject: true });
  let usd = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await opts.beforePaid?.();
    const answer = await ask({
      model: VISION_READ_MODEL,
      name: "page_text",
      system: VISION_READ_SYSTEM,
      effort: "minimal",
      schema: VISION_READ_SCHEMA as unknown as Record<string, unknown>,
      parts: [{ text: "The page:" }, { image: { bytes: view.data, type: "image/jpeg", detail: "high" } }],
      timeoutMs: 150_000,
    });
    if (answer.ok && answer.usage) usd += extractUsd(answer.usage.tokensIn, answer.usage.tokensOut);
    if (answer.ok) return { segs: segmentsFromVision(answer.value), width: view.info.width, height: view.info.height, models: VISION_READ_MODEL, usd: Math.round(usd * 1e6) / 1e6 };
    if (answer.code === "NO_KEY" || answer.code === "OUT_OF_CREDITS") break;
  }
  console.error("pdf-read: the vision model could not read a page; Tesseract reads it");
  return null;
}

/** A page picture's text: the vision model, else Tesseract. */
async function readPicture(png: Buffer, opts: ReadOptions): Promise<Read> {
  const seen = await visionRead(png, opts);
  if (seen) return seen;
  const read = await ocrPicture(png, opts);
  return { segs: segmentsFromOcr(read.lines.filter((l) => l.pass === 0), read.width, read.height), width: read.width, height: read.height, models: read.models };
}

async function ocrPicture(
  png: Buffer,
  opts: ReadOptions,
): Promise<{ lines: Awaited<ReturnType<typeof readLines>>; width: number; height: number; models: string }> {
  const meta = await sharp(png).metadata();
  const eng = await readLines(png, null, 1, ["0"]);
  const size = { width: meta.width ?? 1, height: meta.height ?? 1 };
  const engQ = readQuality(eng);
  if (!wantsDevanagariRead(engQ)) return { lines: eng, ...size, models: "eng" };
  const models = devanagariModels(opts.languages ?? []);
  const dev = await readLines(png, null, 1, ["0"], false, models);
  return betterRead(engQ, readQuality(dev)) === "dev" ? { lines: dev, ...size, models } : { lines: eng, ...size, models: "eng" };
}

/**
 * Read the named pages. `onPage` is told each one as it is done, so a long
 * scan can be saved as it goes and a reading cut short resumes rather than
 * starting again.
 */
export async function readPages(
  bytes: Buffer,
  type: DocType,
  pages: readonly number[],
  onPage?: (page: PageText) => Promise<void>,
  opts: ReadOptions = {},
): Promise<PageText[]> {
  const out: PageText[] = [];
  if (type !== "application/pdf") {
    // One page. Turned upright and brought to a size the OCR reads well.
    const png = await sharp(bytes)
      .rotate()
      .resize({ width: OCR_LONG_SIDE, height: OCR_LONG_SIDE, fit: "inside", withoutEnlargement: false })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    const read = await readPicture(png, opts);
    const segs = read.segs;
    const page: PageText = { n: 1, width: read.width, height: read.height, source: segs.length ? "ocr" : "empty", ocr: read.models, ...(read.usd ? { usd: read.usd } : {}), segments: numberSegments(1, segs).segments };
    await onPage?.(page);
    return [page];
  }

  const doc = await open(bytes);
  // Pages are drawn one at a time; the model reads up to `READ_AT_ONCE` of
  // them at once, and each is handed on as it is done.
  const inFlight = new Set<Promise<void>>();
  const done = async (page: PageText) => {
    out.push(page);
    await onPage?.(page);
  };
  try {
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) continue;
      const text = await textItems(doc, n);
      const segs = segmentsFromItems(text.items, text.width, text.height);
      if (hasTextLayer(segs)) {
        await done({ n, width: text.width, height: text.height, source: "text", segments: numberSegments(n, segs).segments });
        continue;
      }
      if (opts.textOnly) {
        await done({ n, width: text.width, height: text.height, source: "empty", segments: [] });
        continue;
      }
      const drawn = await drawPage(doc, n, OCR_LONG_SIDE);
      const job: Promise<void> = readPicture(drawn.png, opts).then((read) =>
        done({ n, width: read.width, height: read.height, source: read.segs.length ? "ocr" : "empty", ocr: read.models, ...(read.usd ? { usd: read.usd } : {}), segments: numberSegments(n, read.segs).segments }),
      );
      inFlight.add(job);
      void job.finally(() => inFlight.delete(job)).catch(() => {});
      if (inFlight.size >= READ_AT_ONCE) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
  } finally {
    await Promise.allSettled(inFlight);
    await doc.close();
  }
  return out.sort((a, b) => a.n - b.n);
}

/** One page as a JPEG for the review screen, or null when it cannot be drawn. */
export async function renderPreview(bytes: Buffer, type: DocType, n: number): Promise<Buffer | null> {
  try {
    if (type !== "application/pdf") {
      if (n !== 1) return null;
      return await sharp(bytes)
        .rotate()
        .resize({ width: PREVIEW_LONG_SIDE, height: PREVIEW_LONG_SIDE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 82 })
        .toBuffer();
    }
    const doc = await open(bytes);
    try {
      if (n < 1 || n > doc.numPages) return null;
      const drawn = await drawPage(doc, n, PREVIEW_LONG_SIDE);
      return await sharp(drawn.png).jpeg({ quality: 82 }).toBuffer();
    } finally {
      await doc.close();
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The pictures in a PDF
// ---------------------------------------------------------------------------

export type PdfPicture = {
  page: number;
  /** A JPEG, at most `PICTURE_LONG_SIDE` on its long side. */
  jpeg: Buffer;
  width: number;
  height: number;
  /** A picture the PDF holds, or a whole page drawn because its picture is drawn in lines. */
  source: "embedded" | "page";
};

/** The longest side a picture is kept at: a library picture, not a print master. */
const PICTURE_LONG_SIDE = 2400;
/** The size of a page drawn whole. */
const PAGE_LONG_SIDE = 2000;

type PdfImage = { width?: number; height?: number; kind?: number; data?: Uint8Array | Uint8ClampedArray };

/** One decoded picture as a JPEG, or null for one this cannot turn into pixels. */
async function imageJpeg(img: PdfImage): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
  const w = img.width ?? 0;
  const h = img.height ?? 0;
  const data = img.data;
  if (!w || !h || !data || w * h > 60_000_000) return null;
  // pdf.js's kinds: 1 is one bit a pixel, 2 is RGB, 3 is RGBA.
  let raw: Buffer;
  let channels: 1 | 3 | 4;
  if (img.kind === 3 && data.length >= w * h * 4) {
    raw = Buffer.from(data.buffer, data.byteOffset, w * h * 4);
    channels = 4;
  } else if (img.kind === 2 && data.length >= w * h * 3) {
    raw = Buffer.from(data.buffer, data.byteOffset, w * h * 3);
    channels = 3;
  } else if (img.kind === 1) {
    const rowBytes = Math.ceil(w / 8);
    if (data.length < rowBytes * h) return null;
    raw = Buffer.alloc(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) raw[y * w + x] = data[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
    }
    channels = 1;
  } else return null;
  const jpeg = await sharp(raw, { raw: { width: w, height: h, channels } })
    .flatten({ background: "#ffffff" })
    .resize({ width: PICTURE_LONG_SIDE, height: PICTURE_LONG_SIDE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: jpeg.data, width: jpeg.info.width, height: jpeg.info.height };
}

/**
 * The pictures a PDF holds, page by page, as the brochure's designer placed
 * them: renders, photographs and plans at their own resolution, not a
 * screenshot of the page with its words over them. A page whose picture is
 * drawn in lines (a vector floor plan, a map) and has little text is drawn
 * whole instead, so it is not lost. Small pictures are left to the caller.
 */
export async function readPictures(
  bytes: Buffer,
  pages: readonly number[],
  opts: { textChars?: (page: number) => number; minSide?: number; onPage?: (n: number) => Promise<void> } = {},
): Promise<PdfPicture[]> {
  const p = await lib();
  const doc = await open(bytes);
  const out: PdfPicture[] = [];
  const minSide = opts.minSide ?? 200;
  try {
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const pageArea = Math.max(1, vp.width * vp.height);
      const ops = await page.getOperatorList();
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack: number[][] = [];
      const mul = (a: number[], b: number[]) => [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
      ];
      let covered = 0;
      const names = new Set<string>();
      for (let i = 0; i < ops.fnArray.length; i += 1) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i] as unknown[];
        if (fn === p.OPS.save) stack.push(ctm);
        else if (fn === p.OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === p.OPS.transform) ctm = mul(ctm, args as number[]);
        else if (fn === p.OPS.paintImageXObject || fn === p.OPS.paintImageXObjectRepeat) {
          const name = String(args[0]);
          const placed = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / pageArea;
          if (names.has(name)) continue;
          names.add(name);
          const store = name.startsWith("g_") ? page.commonObjs : page.objs;
          const img = await new Promise<PdfImage | null>((resolve) => {
            const timer = setTimeout(() => resolve(null), 15_000);
            try {
              store.get(name, (o: unknown) => {
                clearTimeout(timer);
                resolve((o as PdfImage) ?? null);
              });
            } catch {
              clearTimeout(timer);
              resolve(null);
            }
          });
          if (!img || Math.min(img.width ?? 0, img.height ?? 0) < minSide) continue;
          const made = await imageJpeg(img).catch(() => null);
          if (!made) continue;
          covered = Math.max(covered, placed);
          out.push({ page: n, ...made, source: "embedded" });
        } else if (fn === p.OPS.paintInlineImageXObject) {
          const img = args[0] as PdfImage | undefined;
          if (!img || Math.min(img.width ?? 0, img.height ?? 0) < minSide) continue;
          const made = await imageJpeg(img).catch(() => null);
          if (made) out.push({ page: n, ...made, source: "embedded" });
        }
      }
      page.cleanup();
      // A page drawn in lines, with little text: a vector plan or a map.
      if (covered < 0.3 && (opts.textChars?.(n) ?? 0) < 1200 && ops.fnArray.length > 40) {
        const drawn = await drawPage(doc, n, PAGE_LONG_SIDE).catch(() => null);
        if (drawn) {
          const jpeg = await sharp(drawn.png).jpeg({ quality: 88 }).toBuffer();
          out.push({ page: n, jpeg, width: drawn.width, height: drawn.height, source: "page" });
        }
      }
      await opts.onPage?.(n);
    }
  } finally {
    await doc.close();
  }
  return out;
}

/** A 64-bit difference hash of a picture, in hex: near copies differ in a few bits. */
export async function pictureHash(bytes: Buffer): Promise<string> {
  const { data } = await sharp(bytes).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let hex = "";
  for (let y = 0; y < 8; y += 1) {
    let nibble = 0;
    for (let x = 0; x < 8; x += 1) {
      const bit = data[y * 9 + x] > data[y * 9 + x + 1] ? 1 : 0;
      nibble = (nibble << 1) | bit;
      if (x % 4 === 3) {
        hex += nibble.toString(16);
        nibble = 0;
      }
    }
  }
  return hex;
}
