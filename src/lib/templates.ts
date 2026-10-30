import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { chooseTemplateModel, type ChooseDriver } from "./generate.ts";
import { knownScore, knows, pickLearned, templateValue, type Blended } from "./learning-rules.ts";
import {
  TEMPLATE_REFERENCES,
  currentTemplateKey,
  festiveTemplate,
  isDesignTemplate,
  isTemplateKey,
  pageForSlide,
  ruleTemplate,
  templateCatalog,
  templateChooserPrompt,
  templateFits,
  templateFromAnswer,
  type TemplateContext,
  type TemplateKind,
} from "./template-rules.ts";

/**
 * The template library on disk: one folder per category. An image category
 * holds its designs as files; a carousel category holds each design as a
 * folder of pages (`page-01.jpg`, `page-02.jpg`, ...) in swipe order; a video
 * category holds each design as a preview clip (`<name>.mp4`) beside its
 * still (`<name>__poster.jpg`). All are read in name order.
 *
 * The folder is shipped with the app rather than stored per tenant, because
 * it is ours and every developer sees the same one. A key is only ever used
 * after `isTemplateKey()` has matched it against its catalog, so a path is
 * never assembled from what a request supplied.
 *
 * Imports are relative because the scheduled runner loads this from source.
 */

const ROOTS: Record<TemplateKind, string> = {
  IMAGE: join(process.cwd(), "template_library", "image-ads-templates"),
  CAROUSEL: join(process.cwd(), "template_library", "carousel-ads-templates"),
  VIDEO: join(process.cwd(), "template_library", "video-ads-templates"),
};
const IMAGE = /\.(jpe?g|png|webp)$/i;
const CLIP = /\.mp4$/i;
const POSTER = /__poster\.jpg$/i;

/**
 * One page file, and a version that changes whenever the file does: its
 * size and modified time. The version rides in the picker's image address
 * and keys the thumbnail cache, so replacing a folder's designs shows the
 * new ones at once, in the browser and on the server. Both used to be keyed
 * by position alone, and a folder whose files were swapped kept showing the
 * old designs until the server restarted and the browser's day ran out.
 */
type PageFile = { path: string; version: string };

/** A category's designs for the picker: each design's page versions, in order. */
export type TemplateView = { key: string; label: string; detail: string; hot: boolean; story: boolean; designs: string[][] };

async function pageFile(path: string): Promise<PageFile | null> {
  const st = await stat(path).catch(() => null);
  return st ? { path, version: `${Math.round(st.mtimeMs).toString(36)}${st.size.toString(36)}` } : null;
}

async function imagesIn(dir: string): Promise<PageFile[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => IMAGE.test(n)).sort();
  const out: PageFile[] = [];
  for (const name of names) {
    const f = await pageFile(join(dir, name));
    if (f) out.push(f);
  }
  return out;
}

/**
 * The designs in one category, each as its pages, read fresh. An image design
 * is one page; a video design is two, its poster still and then its clip, and
 * a clip with no poster is left out, because the picker has nothing to show.
 */
async function designs(kind: TemplateKind, key: string): Promise<PageFile[][]> {
  const dir = join(ROOTS[kind], key);
  if (kind === "IMAGE") return (await imagesIn(dir)).map((f) => [f]);
  if (kind === "VIDEO") {
    // A design is its poster still, and its clip. The clips are kept out of
    // git (about 400 MB), so a deployment has the stills alone; the image
    // model is shown stills either way.
    // Where a clip is not on this machine it is played from the store
    // (`clips.json`, written by `npm run templates:clips`).
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => POSTER.test(n)).sort();
    const stored = await storedClips();
    const out: PageFile[][] = [];
    for (const name of names) {
      const poster = await pageFile(join(dir, name));
      if (!poster) continue;
      const clipName = name.replace(POSTER, ".mp4");
      const clip = await pageFile(join(dir, clipName));
      const inStore = stored[`${key}/${clipName}`];
      out.push(clip ? [poster, clip] : inStore ? [poster, { path: join(dir, clipName), version: inStore }] : [poster]);
    }
    return out;
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const out: PageFile[][] = [];
  for (const f of folders) {
    const pages = await imagesIn(join(dir, f));
    if (pages.length) out.push(pages);
  }
  return out;
}

/** Every category of one kind that has at least one design, for the picker. */
export async function listTemplates(kind: TemplateKind = "IMAGE"): Promise<TemplateView[]> {
  const catalog = templateCatalog(kind);
  const all = await Promise.all(catalog.map((c) => designs(kind, c.key)));
  return catalog.flatMap((c, i) =>
    all[i].length
      ? [{ key: c.key, label: c.label, detail: c.detail, hot: !!c.hot, story: !!c.story, designs: all[i].map((d) => d.map((p) => p.version)) }]
      : [],
  );
}

const thumbs = new Map<string, Promise<Buffer | null>>();

/** What a cut-down page is written as. WebP where the browser takes it: a third smaller at the same look. */
export type ThumbFormat = "jpeg" | "webp";

/**
 * Cut pages are also kept on disk, under the temp folder, so a restarted
 * server or a fresh function on the same machine does not cut the whole
 * library again. Keyed by the file's version, so a replaced design is a new
 * file; nothing ever has to be invalidated.
 */
const DISK = join(tmpdir(), "salesdesk-template-thumbs");

async function cut(path: string, width: number, format: ThumbFormat): Promise<Buffer | null> {
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return null;
  const img = sharp(bytes).resize(width, width, { fit: "inside", withoutEnlargement: true });
  return format === "webp"
    ? img.webp({ quality: 84, smartSubsample: true, effort: 4 }).toBuffer()
    : img.jpeg({ quality: 84, progressive: true, mozjpeg: true }).toBuffer();
}

/** One page of one design, cut down. Null for a key, design or page that is not there. */
export async function templateThumb(
  kind: TemplateKind,
  key: string,
  index: number,
  width = 480,
  page = 0,
  format: ThumbFormat = "jpeg",
): Promise<Buffer | null> {
  if (!isTemplateKey(key, kind) || !Number.isInteger(index) || index < 0 || !Number.isInteger(page) || page < 0) {
    return null;
  }
  const file = (await designs(kind, key))[index]?.[page];
  // A clip is never cut down as a picture: its still is page zero.
  if (!file || CLIP.test(file.path)) return null;
  const id = `${file.path}/${file.version}/${width}/${format}`;
  if (!thumbs.has(id)) {
    const onDisk = join(DISK, `${createHash("sha1").update(id).digest("hex")}.${format}`);
    thumbs.set(
      id,
      (async () => {
        const kept = await readFile(onDisk).catch(() => null);
        if (kept) return kept;
        const b = await cut(file.path, width, format);
        if (b) {
          // A cache that cannot be written is only slower, never wrong.
          await mkdir(DISK, { recursive: true })
            .then(() => writeFile(onDisk, b))
            .catch(() => undefined);
        }
        return b;
      })().then((b) => {
        // A read that failed is not remembered: the next post tries again
        // rather than quietly carrying three references for the life of the
        // process.
        if (!b) thumbs.delete(id);
        return b;
      }),
    );
  }
  return thumbs.get(id)!;
}

/**
 * Where one video design's preview clip is on disk, and how big, for the
 * viewer. The route streams the range asked for rather than reading the whole
 * clip for every seek. Null for one that is not there.
 */
export async function templateClip(
  key: string,
  index: number,
): Promise<{ path: string; size: number; version: string } | { storeKey: string; version: string } | null> {
  if (!isTemplateKey(key, "VIDEO") || !Number.isInteger(index) || index < 0) return null;
  const file = (await designs("VIDEO", key))[index]?.[1];
  if (!file) return null;
  const st = await stat(file.path).catch(() => null);
  if (st) return { path: file.path, size: st.size, version: file.version };
  const name = basename(file.path);
  return (await storedClips())[`${key}/${name}`] ? { storeKey: clipStoreKey(key, name), version: file.version } : null;
}

/** Where a video design's clip is kept in the file store: ours, never a tenant's. */
export function clipStoreKey(key: string, name: string): string {
  return `library/video-templates/${key}/${name}`;
}

/** `<category>/<name>.mp4` to its version, for the clips kept in the store rather than in git. */
let clipsRead: Promise<Record<string, string>> | null = null;
function storedClips(): Promise<Record<string, string>> {
  clipsRead ??= readFile(join(ROOTS.VIDEO, "clips.json"), "utf8")
    .then((t) => JSON.parse(t) as Record<string, string>)
    .catch(() => ({}));
  return clipsRead;
}

/**
 * The reference designs of one image or video category, as the image model
 * is shown them: the first `TEMPLATE_REFERENCES`, each cut down to 768
 * pixels, because four full-size designs are ten megabytes of upload for no
 * better result. A video design is shown as its poster still: the model
 * draws frames, and the motion is ours.
 */
export async function templateReferences(
  key: string,
  kind: "IMAGE" | "VIDEO" = "IMAGE",
): Promise<{ bytes: Buffer; type: string }[]> {
  if (!isTemplateKey(key, kind)) return [];
  const out: { bytes: Buffer; type: string }[] = [];
  for (let i = 0; i < TEMPLATE_REFERENCES; i++) {
    const b = await templateThumb(kind, key, i, 768);
    if (b) out.push({ bytes: b, type: "image/jpeg" });
  }
  return out;
}

/**
 * One carousel design's pages, one per slide, as the image model is shown
 * them. ONE design, not a page from each of four: a carousel made after four
 * different sets reads as four ads. `design` rotates with the version, so a
 * second version of the same card follows the next design in the category.
 */
export async function carouselReferences(
  key: string,
  design: number,
  slides: number,
): Promise<{ design: number; pages: ({ bytes: Buffer; type: string } | null)[] }> {
  if (!isTemplateKey(key, "CAROUSEL")) return { design: 0, pages: [] };
  const all = await designs("CAROUSEL", key);
  if (!all.length) return { design: 0, pages: [] };
  const d = ((design % all.length) + all.length) % all.length;
  const count = all[d].length;
  const pages: ({ bytes: Buffer; type: string } | null)[] = [];
  for (let i = 0; i < slides; i++) {
    const b = await templateThumb("CAROUSEL", key, d, 768, pageForSlide(i, slides, count));
    pages.push(b ? { bytes: b, type: "image/jpeg" } : null);
  }
  return { design: d, pages };
}

export type TemplateChoice = {
  key: string;
  by: "person" | "ai" | "rule" | "learnt";
  /** A carousel's design within the category, counted from zero. */
  design?: number;
};

/**
 * The category one post is made in: the one a person picked, or, with none
 * picked, the one a model chooses for the card. A choice the model could not
 * make, or made outside the shortlist, falls back to `ruleTemplate()`, so a
 * post never waits on this call.
 */
export async function resolveTemplate(opts: {
  picked: string | null | undefined;
  context: TemplateContext;
  kind?: TemplateKind;
  driver?: ChooseDriver;
  signal?: AbortSignal;
  /**
   * What has worked, ours and the market's. With something learnt about
   * designs, most posts take a design the scores favour from the same
   * shortlist the model would choose from; the exploration share goes to
   * the model, which is how the choice worked before anything was learnt.
   */
  learned?: { scores: readonly Blended[]; explore: number; rand: () => number };
  /**
   * The categories this card may be drawn in (its angle, and what the project
   * holds). "Let AI choose" chooses only among them; a person's own pick was
   * already asked the same before anything was paid for.
   */
  allow?: (key: string) => boolean;
}): Promise<TemplateChoice> {
  const kind = opts.kind ?? "IMAGE";
  // A pick made for another shape (a banner asked of a feed post) is not
  // followed: the post is chosen for as if nothing were picked.
  const picked = currentTemplateKey(opts.picked);
  if (picked && isDesignTemplate(picked, kind) && templateFits(picked, kind, opts.context.placement)) {
    return { key: picked, by: "person" };
  }
  const allow = opts.allow ?? (() => true);
  const festive = festiveTemplate(opts.context, kind);
  if (festive && allow(festive)) return { key: festive, by: "rule" };
  const ask = templateChooserPrompt(opts.context, kind, opts.allow);
  if (opts.learned && ask.keys.length && knows(opts.learned.scores, "template")) {
    const scores = opts.learned.scores;
    const chosen = pickLearned(ask.keys, (k) => knownScore(scores, "template", templateValue(kind, k)), {
      learnt: true,
      explore: opts.learned.explore,
      rand: opts.learned.rand,
      recent: [],
    });
    if (chosen.by === "LEARNT") return { key: chosen.pick, by: "learnt" };
  }
  const answer = await (opts.driver ?? chooseTemplateModel)(ask, { signal: opts.signal }).catch(() => null);
  const key = answer?.ok ? templateFromAnswer(answer.key, ask.keys) : null;
  if (key) return { key, by: "ai" };
  const rule = ruleTemplate(opts.context, kind);
  return { key: allow(rule) ? rule : ask.keys[0] ?? rule, by: "rule" };
}
