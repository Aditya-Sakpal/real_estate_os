import { copyFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

// Asked of Node at run time: a production webpack build rewrites a
// createRequire it can see into (void 0), and every post then fails.
const { createRequire } = process.getBuiltinModule("node:module");

/**
 * Reading the words on a finished picture, on this machine.
 *
 * Tesseract, compiled to WebAssembly (tesseract.js, Apache 2.0), with the
 * English LSTM model from `@tesseract.js-data/eng` read from node_modules. It
 * runs in a worker thread of this process, so reading a post costs CPU and
 * nothing else: no call leaves the machine and nothing is billed per post.
 * English only on purpose. What the pixel gate reads is the registration
 * number, the Authority's website, the contact line, the small print and the
 * price lines, all of which are set in Latin letters in every language the
 * product writes in; a Marathi headline is read as noise and ignored.
 *
 * The Brain's document reader may also ask for Hindi and Marathi
 * (`@tesseract.js-data/hin` and `/mar`, read from node_modules the same way)
 * for a scanned Devanagari page. That is a second worker, loaded only the
 * first time a page needs it; the pixel gate never asks for it.
 *
 * One worker per set of models, loaded on first use, and one job at a time:
 * a second worker would double the memory for a gate that is never the slow
 * part of making a post. Loaded with `require` for the reason `qr-detect.ts`
 * gives, and kept out of the bundle (`serverExternalPackages`).
 */

export type OcrBox = { x: number; y: number; w: number; h: number };
export type OcrWord = { text: string; box: OcrBox; confidence: number };
export type OcrLine = {
  text: string;
  box: OcrBox;
  words: OcrWord[];
  confidence: number;
  /** Which of the reads found it: 0 with one threshold for the picture, 1 with local thresholds. */
  pass: number;
};

type Bbox = { x0: number; y0: number; x1: number; y1: number };
type TWord = { text: string; confidence: number; bbox: Bbox };
type TLine = { text: string; confidence: number; bbox: Bbox; words: TWord[] };
type TPage = { blocks: { paragraphs: { lines: TLine[] }[] }[] | null };
type TWorker = {
  setParameters(p: Record<string, string>): Promise<unknown>;
  recognize(image: Buffer, options: Record<string, unknown>, output: Record<string, boolean>): Promise<{ data: TPage }>;
  terminate(): Promise<unknown>;
};

/** Which model, so a stored verdict says what read it. */
export const OCR_ENGINE = "tesseract.js 7, eng 4.0.0_best_int";

/** The models in node_modules. Anything else is refused, never fetched. */
export const OCR_MODELS = ["eng", "hin", "mar"] as const;
export type OcrModel = (typeof OCR_MODELS)[number];
const MODEL_VERSION = "4.0.0_best_int";

const modelFolder = (m: OcrModel) => join(process.cwd(), "node_modules", "@tesseract.js-data", m, MODEL_VERSION);

/**
 * The folder a set of models is read from. Tesseract reads every model of a
 * set from one folder and each package keeps its own, so a set of two is
 * copied once into a folder of this process's own: a local copy, never a
 * download. A single model is read where it lies.
 */
async function modelDir(models: readonly OcrModel[]): Promise<string> {
  if (models.length === 1) return modelFolder(models[0]);
  const dir = join(tmpdir(), `salesdesk-tessdata-${MODEL_VERSION}`);
  await mkdir(dir, { recursive: true });
  for (const m of models) {
    const from = join(modelFolder(m), `${m}.traineddata.gz`);
    const to = join(dir, `${m}.traineddata.gz`);
    const [a, b] = await Promise.all([stat(from), stat(to).catch(() => null)]);
    if (!b || b.size !== a.size) await copyFile(from, to);
  }
  return dir;
}

/** "hin+mar" as its models, refusing any that is not in node_modules. */
export function ocrModels(langs: string): OcrModel[] {
  const out = langs.split("+").map((s) => s.trim()).filter(Boolean);
  if (!out.length || out.some((m) => !(OCR_MODELS as readonly string[]).includes(m))) {
    throw new Error(`OCR model not installed: ${langs}`);
  }
  return out as OcrModel[];
}

const workers = new Map<string, Promise<TWorker>>();
let queue: Promise<unknown> = Promise.resolve();

function worker(langs: string): Promise<TWorker> {
  const known = workers.get(langs);
  if (known) return known;
  const loading = (async () => {
    const models = ocrModels(langs);
    const load = createRequire(join(process.cwd(), "package.json"));
    const T = load("tesseract.js") as {
      createWorker(lang: string, oem: number, options: Record<string, unknown>): Promise<TWorker>;
    };
    // A cache folder would be written to on first use; the model is read
    // from node_modules instead, and nothing is fetched.
    return T.createWorker(models.join("+"), 1, { langPath: await modelDir(models), cacheMethod: "none", gzip: true });
  })().catch((e) => {
    workers.delete(langs);
    throw e;
  });
  workers.set(langs, loading);
  return loading;
}

/** One job at a time on the one worker, in the order asked. */
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

const box = (b: Bbox, scale: number, dx: number, dy: number): OcrBox => ({
  x: b.x0 / scale + dx,
  y: b.y0 / scale + dy,
  w: (b.x1 - b.x0) / scale,
  h: (b.y1 - b.y0) / scale,
});

/**
 * The lines of text in one region of a picture, with their boxes in the
 * picture's own pixels. The region is enlarged by `scale` before reading,
 * because small print at its own size is a few pixels tall and the model
 * reads it as noise, and padded with a plain border, because a line that
 * touches the edge of what is read loses its last letters.
 *
 * Sparse-text layout (page segmentation mode 11): an advertisement is
 * islands of type over a picture, not a page of paragraphs.
 */
export async function readLines(
  bytes: Buffer,
  region: OcrBox | null,
  scale: number,
  /** Which thresholds to read with: "0" one for the picture, "2" local. Both unless said. */
  methods: readonly ("0" | "2")[] = ["0", "2"],
  /** Read it as a negative: light type on a dark ground reads as dark type on light, which the model reads best. */
  invert = false,
  /** Which models read it: "eng" unless said, "hin+mar" for a Devanagari page. */
  langs = "eng",
): Promise<OcrLine[]> {
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const r = region ?? { x: 0, y: 0, w: W, h: H };
  const left = Math.max(0, Math.floor(r.x));
  const top = Math.max(0, Math.floor(r.y));
  const width = Math.min(W - left, Math.ceil(r.w));
  const height = Math.min(H - top, Math.ceil(r.h));
  if (width < 4 || height < 4) return [];
  const pad = Math.round(16 * scale);
  const cut = sharp(bytes)
    .extract({ left, top, width, height })
    .resize(Math.round(width * scale), Math.round(height * scale), { kernel: "lanczos3" })
    .flatten({ background: "#ffffff" });
  const image = await sharp(await (invert ? cut.negate({ alpha: false }) : cut).png().toBuffer())
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: "#7f7f7f" })
    .png()
    .toBuffer();
  const w = await worker(langs);
  // Read twice: once with one Otsu threshold for the whole picture, once with
  // Sauvola's local threshold. Neither reads everything. Dark type on a white
  // panel against a blue sky was one dark block with nothing in it to Otsu;
  // Sauvola lost the first letters of white lines on a dark scrim. What
  // either read is kept, and the rules look for what they need in both.
  const pages = await serial(async () => {
    const out: TPage[] = [];
    for (const method of methods) {
      // The picture is enlarged before reading, so its resolution is stated
      // rather than guessed, and the engine's debug lines go nowhere.
      await w.setParameters({ tessedit_pageseg_mode: "11", user_defined_dpi: "300", debug_file: "/dev/null", thresholding_method: method });
      out.push((await w.recognize(image, {}, { blocks: true, text: false })).data);
    }
    return out;
  });
  const dx = left - pad / scale;
  const dy = top - pad / scale;
  const out: OcrLine[] = [];
  for (const [i, page] of pages.entries()) {
    const pass = methods[i] === "0" ? 0 : 1;
    for (const b of page.blocks ?? []) {
      for (const p of b.paragraphs) {
        for (const l of p.lines) {
          const words = l.words
            .filter((x) => x.text.trim())
            .map((x) => ({ text: x.text.trim(), box: box(x.bbox, scale, dx, dy), confidence: x.confidence }));
          if (!words.length) continue;
          out.push({ text: words.map((x) => x.text).join(" "), box: box(l.bbox, scale, dx, dy), words, confidence: l.confidence, pass });
        }
      }
    }
  }
  return out;
}

/** For a process that is finishing: the worker thread would otherwise keep it alive. */
export async function stopOcr(): Promise<void> {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(all.map(async (w) => (await w.catch(() => null))?.terminate().catch(() => {})));
}
