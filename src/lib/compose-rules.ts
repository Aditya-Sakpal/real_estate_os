/**
 * Posts, decided without a database, a picture or a model.
 *
 * A cleared block of copy becomes a post here: an image, a carousel or a
 * video, in each size the brief asked for. This file holds everything about
 * that a pure function can answer, so `check:logic` covers it and
 * `compose.ts` is left with the pixels.
 *
 * Three rules are load-bearing, and all three come from the product flow
 * doc's Section 08 rather than from taste.
 *
 * The building traces to an approved picture. Either it is that picture,
 * resized and cropped, or it is the image model's design from it, which
 * `judgeDesign()` refuses when the building no longer matches. The logo and
 * the lockup are placed by coordinates computed here, never drawn.
 *
 * The registration lockup sits top right, and its number is set at least as
 * large as the largest contact detail on the frame. MahaRERA's order fixes
 * both, and a layout that gets them right by construction is a layout the
 * pixel gate (`pixel-rules.ts`) only has to confirm on the finished file.
 *
 * A render says so. "Artist's impression" is printed wherever the picture is
 * a render, because a render passed off as a photograph is the
 * misrepresentation Section 12 unwinds a booking over.
 *
 * Imports are relative because the checks load this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

import type { TemplateDirection } from "./template-rules.ts";
import { adRuleFor, allRegistrationLabels, type AdRule } from "./rera-ad-rules.ts";

// ---------------------------------------------------------------------------
// Kinds and placements
// ---------------------------------------------------------------------------

export type PostKind = "IMAGE" | "CAROUSEL" | "VIDEO";

export const POST_KINDS: {
  key: PostKind;
  label: string;
  /** What it is, in the client's words. One line. */
  detail: string;
  /** Which of the brief's formats this kind is made for. */
  placements: readonly string[];
}[] = [
  {
    key: "IMAGE",
    label: "Image",
    detail: "One picture with the copy on it.",
    placements: ["Meta feed 1:1", "Meta story 9:16", "Google display", "Portal listing"],
  },
  {
    key: "CAROUSEL",
    label: "Carousel",
    detail: "A cover, a slide per selling point, and a close. Three to ten slides.",
    placements: ["Meta feed 1:1"],
  },
  {
    key: "VIDEO",
    label: "Video",
    detail: "One AI film of your project, 10 to 30 seconds, made from your approved pictures.",
    placements: ["Meta reel 9:16", "Meta story 9:16", "YouTube 16:9"],
  },
];

export function isPostKind(raw: string | null | undefined): raw is PostKind {
  return POST_KINDS.some((k) => k.key === raw);
}

export function kindDef(kind: PostKind) {
  return POST_KINDS.find((k) => k.key === kind)!;
}

/** The frame each placement is rendered at, in pixels. */
export const PLACEMENT_SIZE: Record<string, { w: number; h: number }> = {
  "Meta feed 1:1": { w: 1080, h: 1080 },
  "Meta story 9:16": { w: 1080, h: 1920 },
  "Meta reel 9:16": { w: 1080, h: 1920 },
  "Google display": { w: 1200, h: 628 },
  "YouTube 16:9": { w: 1920, h: 1080 },
  "Portal listing": { w: 1200, h: 900 },
  // No longer offered (3 October 2026); kept so hoardings made before still read.
  Hoarding: { w: 3000, h: 1000 },
};

/**
 * The placements one kind produces for one brief.
 *
 * Only the ones the brief asked for. A carousel on a brief with no square
 * feed placement has nowhere to go, and making it anyway is making something
 * the campaign will never post.
 */
export function placementsFor(kind: PostKind, briefFormats: readonly string[]): string[] {
  const wanted = new Set(briefFormats);
  return kindDef(kind).placements.filter((p) => wanted.has(p) && PLACEMENT_SIZE[p]);
}

/** Why a kind cannot be made for this brief, or null when it can. */
export function kindUnavailable(kind: PostKind, briefFormats: readonly string[]): string | null {
  if (placementsFor(kind, briefFormats).length) return null;
  const names = kindDef(kind).placements.join(", ");
  return `The brief has none of the formats a ${kindDef(kind).label.toLowerCase()} is made for (${names}).`;
}

// ---------------------------------------------------------------------------
// Which pictures
// ---------------------------------------------------------------------------

export type Picture = {
  assetId: string;
  sha256: string;
  category: string;
  isRender: boolean;
  title: string | null;
};

/**
 * What may sit behind the copy.
 *
 * Floor plans, site plans and maps are approved pictures and poor
 * backgrounds: a line drawing under white type is unreadable, and a plan
 * cropped to a square loses the one thing it shows. The lockup is placed on
 * its own, never as a background. A construction photo stays out of the
 * ordinary pool (it is dated and a campaign runs for weeks) and is only
 * added when a template asks for it (`prefer`, from `templatePhotos()`).
 */
const BACKGROUND_ORDER = ["EXTERIOR_RENDER", "AMENITY", "LOBBY", "SAMPLE_FLAT"] as const;

export function backgroundsFrom(
  pictures: readonly Picture[],
  prefer: readonly string[] | null = null,
): Picture[] {
  const order = prefer?.length
    ? [...prefer, ...BACKGROUND_ORDER.filter((c) => !prefer.includes(c))]
    : [...BACKGROUND_ORDER];
  return pictures
    .filter((p) => order.includes(p.category))
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}

/**
 * The pictures one post uses, rotated so posts differ.
 *
 * The cover is an exterior whenever there is one, because the building is
 * what a buyer is looking at first, unless `prefer` names another category
 * (construction update covers open on a site photo). Later slides take the
 * rest in turn. `seed` moves the starting point, so the tenth post does not
 * open on the same render as the first.
 */
export function picturesFor(
  backgrounds: readonly Picture[],
  count: number,
  seed: number,
  prefer: readonly string[] | null = null,
): Picture[] {
  if (!backgrounds.length || count <= 0) return [];
  const preferred = prefer?.length ? backgrounds.filter((p) => prefer.includes(p.category)) : [];
  const exteriors = backgrounds.filter((p) => p.category === "EXTERIOR_RENDER");
  const others = backgrounds.filter(
    (p) => p.category !== "EXTERIOR_RENDER" && !preferred.some((q) => q.assetId === p.assetId),
  );
  const rot = <T>(xs: readonly T[], by: number): T[] =>
    xs.length ? xs.map((_, i) => xs[(i + by) % xs.length]) : [];

  // A template that asks for construction opens on a site photo. Otherwise
  // the cover rotates among exteriors (or every background when there is
  // only one exterior), so a second version is not the same picture again.
  const coverPool = preferred.length
    ? preferred
    : exteriors.length >= 2
      ? exteriors
      : [...exteriors, ...others];
  const cover = rot(coverPool, seed)[0];
  const rest = rot(
    preferred.length
      ? [
          ...preferred.filter((p) => p.assetId !== cover.assetId),
          ...others,
          ...exteriors.filter((p) => p.assetId !== cover.assetId),
        ]
      : [...others, ...exteriors.filter((p) => p.assetId !== cover.assetId)],
    seed,
  );
  const out = [cover];
  for (let i = 0; out.length < count; i++) {
    // Fewer pictures than slides repeats them, in order, rather than failing.
    out.push(rest.length ? rest[i % rest.length] : cover);
  }
  return out;
}

/** How the designer is told to keep the photograph: site, building or room. */
export function sceneOf(category: string): "exterior" | "interior" | "site" {
  if (category === "CONSTRUCTION") return "site";
  return category === "EXTERIOR_RENDER" ? "exterior" : "interior";
}

// ---------------------------------------------------------------------------
// What each frame says
// ---------------------------------------------------------------------------

export type Slide = {
  /** A "photo" slide carries no words of its own: the picture is the slide. */
  role: "cover" | "point" | "photo" | "close";
  /** The large line. Empty on a photo slide. */
  title: string;
  /** The line under it, or none. */
  sub: string | null;
  /** The call to action, shown as a pill on the cover and the close. */
  cta: string | null;
  /**
   * Where the project is and what it starts at, each on a line of its own,
   * on the cover only. Signed facts, so they are set as they are and checked
   * like the copy.
   */
  facts?: { location: string | null; prices: string[] } | null;
};

/**
 * How long a carousel may be. Three is a cover, one slide and a close; ten is
 * what a Meta carousel ad allows. A person chooses inside that range, and the
 * screen names four to six as the length that reads best: long enough to
 * swipe, short enough that the close is still seen.
 */
export const MIN_SLIDES = 3;
export const MAX_SLIDES = 10;
export const DEFAULT_SLIDES = 5;
export const BEST_SLIDES = { from: 4, to: 6 } as const;

/** A slide count from a form: whole, inside the range, the default when absent. */
export function slideCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SLIDES;
  return Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, n));
}

/**
 * The slides, from a cleared block and the approved talking points.
 *
 * The cover is the block as written. Each talking point gets a slide of its
 * own, in the words somebody signed rather than a paraphrase, which is the
 * same reason the copy gate measures against them. The close repeats the call
 * to action beside the contact details.
 *
 * With a `count`, the carousel is exactly that long. More slides than signed
 * points are PHOTO slides, a picture with the registration block and nothing
 * written on it, because a slide's words may only be words somebody cleared
 * and there is nothing else to say. Without one, a carousel is the cover, up
 * to three points and the close, which is what a video is built from.
 */
export function slidesFor(
  copy: { headline: string; body: string; cta: string },
  talkingPoints: readonly string[],
  kind: PostKind,
  count?: number,
  /** The location and the price lines, printed on the cover. */
  facts?: { location: string | null; prices: string[] } | null,
): Slide[] {
  const cover: Slide = { role: "cover", title: copy.headline, sub: copy.body, cta: copy.cta, facts: facts ?? null };
  if (kind === "IMAGE") return [cover];

  const total = count === undefined ? null : slideCount(count);
  const room = (total ?? DEFAULT_SLIDES) - 2;
  const points = talkingPoints
    .filter((t) => t.trim())
    .slice(0, room)
    .map((t): Slide => ({ role: "point", title: t.trim(), sub: null, cta: null }));
  const photos: Slide[] = total
    ? Array.from({ length: room - points.length }, () => ({ role: "photo", title: "", sub: null, cta: null }))
    : [];
  const close: Slide = { role: "close", title: copy.cta, sub: null, cta: null };
  return [cover, ...points, ...photos, close];
}

// ---------------------------------------------------------------------------
// Where everything goes
// ---------------------------------------------------------------------------

export type Box = { x: number; y: number; w: number; h: number };

export type Layout = {
  w: number;
  h: number;
  pad: number;
  titleSize: number;
  subSize: number;
  ctaSize: number;
  /** Every contact detail on the frame is set at this size or smaller. */
  contactSize: number;
  /** The registration number. Never smaller than `contactSize`. */
  regSize: number;
  /** The lockup panel, top right, as MahaRERA's order places it. */
  lockup: Box;
  /** The side of the square the lockup picture is fitted into. */
  lockupImage: number;
  /** Space inside the lockup panel. */
  lockupPad: number;
  /** The logo, top left. */
  logo: Box;
  /** Where the copy may sit, above the contact strip. */
  text: Box;
  /** The strip along the foot: contact, disclaimer, artist's impression. */
  foot: Box;
  /**
   * Where a designed frame's footer band starts. The image model designs
   * only the frame above it, and the contact line sits on a solid band of
   * our own, so a button the model sets low can never run into the phone
   * number.
   */
  bandTop: number;
};

/**
 * The layout for one frame, from its size alone.
 *
 * Everything scales with the short side, so a 9:16 story and a 16:9 YouTube
 * frame read at the same weight. A very wide frame (a hoarding, a Google
 * display banner) puts the copy on the left half rather than the full width,
 * because a line of type four thousand pixels long is not read.
 */
export function layoutFor(w: number, h: number): Layout {
  const s = Math.min(w, h);
  const wide = w / h >= 1.6;
  const pad = Math.round(s * 0.055);

  // The contact line is set small on purpose: Order 46C/2025 wants the
  // registration number AND the Authority's website at least as large as it,
  // and the registration block is set small, the way developers print it
  // (the client, 30 September 2026: "very small", beside a small QR). So the
  // contact line is fine print too, 1.5 per cent of the short side.
  const contactSize = Math.max(12, Math.round(s * 0.015));
  // The order: the registration at least as large as the largest contact
  // detail. Set a step above rather than equal, so rounding never lands it a
  // pixel below.
  const regSize = contactSize + Math.max(2, Math.round(s * 0.004));

  // The registration block as a developer prints it: a small QR in the
  // corner and, to its left, the label, the number and the Authority's
  // website, right-aligned and stacked, with no panel behind them. It was a
  // white panel with the QR on the left, and on every post and film it read
  // as a block pasted on (the client, 30 September 2026). `lockupPad` is the
  // gap between the words and the QR; `lockupImage` is the QR's smallest
  // side, which `qrSideFor()` raises for a dense code.
  const lockupPad = Math.round(s * 0.012);
  // A banner and a hoarding are short for their width, and a QR sized off
  // the short side came out too small to scan at the size a banner is shown
  // (the pixel gate's `QR_SCALES`): 68 pixels on a Google display ad. There
  // is room in their quarter for a larger one.
  const lockupImage = w / h >= 1.85 ? Math.round(s * 0.2) : Math.max(Math.round(s * 0.07), Math.ceil(33 * QR_PX_PER_MODULE));
  // The website is the widest line; three lines and a permit's fourth stack
  // to about three and a half registration sizes.
  const lockupText = Math.ceil(regSize * 0.56 * RERA_WEBSITE.length);
  const lockupW = lockupText + lockupPad + lockupImage;
  const lockupH = Math.max(lockupImage, Math.round(regSize * 3.6));
  const lockup: Box = { x: w - pad - lockupW, y: pad, w: lockupW, h: lockupH };

  const logoH = Math.round(s * 0.075);
  const logo: Box = { x: pad, y: pad, w: Math.round(logoH * 3.2), h: logoH };

  const footH = Math.round(contactSize * 3.4);
  const foot: Box = { x: pad, y: h - pad - footH, w: w - pad * 2, h: footH };

  const textTop = Math.max(lockup.y + lockup.h, logo.y + logo.h) + pad;
  const textW = wide ? Math.round((w - pad * 2) * 0.58) : w - pad * 2;
  const text: Box = { x: pad, y: textTop, w: textW, h: foot.y - pad * 0.6 - textTop };

  return {
    w,
    h,
    pad,
    titleSize: Math.round(s * (wide ? 0.07 : 0.062)),
    subSize: Math.round(s * 0.034),
    ctaSize: Math.round(s * 0.03),
    contactSize,
    regSize,
    lockup,
    lockupImage,
    lockupPad,
    logo,
    text,
    foot,
    bandTop: foot.y - Math.round(pad * 0.5),
  };
}

/**
 * Whether a layout keeps the two MahaRERA placements.
 *
 * True by construction for anything `layoutFor()` returns, and asserted by
 * `check:logic` across every placement, so a later change to the numbers
 * above cannot quietly move the lockup out of its corner or shrink the
 * number below the phone.
 */
/**
 * MahaRERA's website, the longest any authority prints. The lockup panel is
 * sized for it, so every other state's website fits the same panel; what a
 * post actually prints is its own state's (`adRuleFor()` in
 * `rera-ad-rules.ts`).
 */
export const RERA_WEBSITE = "maharera.maharashtra.gov.in";

/**
 * The advertising rule a call names, or Maharashtra's when a caller predates
 * the per-state rules and names none. `null` is kept as null: a registration
 * with no known state has nothing lawful to print.
 */
export function adOf(ad: AdRule | null | undefined): AdRule | null {
  return ad === undefined ? adRuleFor("MH") : ad;
}

/**
 * The lines of the registration block, in the order they are printed: the
 * label and number, Telangana's permit number where the state asks for it,
 * and the Authority's website.
 */
export function registrationLines(ad: AdRule, registrationNo: string, permitNo: string | null): string[] {
  const out = [`${ad.label} ${registrationNo}`];
  if (ad.permitNo && permitNo) out.push(`Permit No. ${permitNo}`);
  out.push(ad.website);
  return out;
}

/**
 * Pixels a QR module needs to scan at every size the pixel gate asks
 * (`QR_SCALES`, `PRINT_DPIS`), counted over the whole QR image with its own
 * quiet zone. Measured on 30 September 2026: a 33-module code (the one a
 * MahaRERA project's page gives) scanned at all five from 76 pixels with a
 * one-module margin and failed at 65, so a still takes a tenth more than the
 * edge. A film is encoded after the QR is laid on it, and at 85 pixels one
 * frame in seven of a real film no longer scanned at 60 per cent, so a
 * moving picture takes more again.
 */
export const QR_PX_PER_MODULE = 2.8;
export const QR_PX_PER_MODULE_MOVING = 3.1;

/**
 * How big the lockup's QR is set: small, the way developers print it, and
 * never smaller than its own modules need to scan. A code of unknown density
 * is given the room a dense one needs. At most 16 per cent of the short side.
 */
export function qrSideFor(modules: number | null, l: Layout, moving = false): number {
  const s = Math.min(l.w, l.h);
  const need = Math.ceil((modules ?? 45) * (moving ? QR_PX_PER_MODULE_MOVING : QR_PX_PER_MODULE));
  return Math.min(Math.round(s * 0.16), Math.max(l.lockupImage, need));
}

/** The QR's share of the ad's width the image model is asked to draw it at, from the same rule. */
export function qrPercentFor(modules: number | null, w: number, h: number): number {
  return Math.ceil((qrSideFor(modules, layoutFor(w, h)) / w) * 100);
}

export function keepsReraRules(l: Layout): boolean {
  const topRight = l.lockup.x + l.lockup.w >= l.w * 0.9 && l.lockup.y <= l.h * 0.1;
  return topRight && l.regSize >= l.contactSize;
}

/**
 * Whether a box lies wholly inside the upper-right quarter of the frame,
 * which is where MahaRERA's order puts the QR and the number. The quarter,
 * not the corner: inside it, the lockup may move to wherever it hides the
 * least.
 */
export function inTopRightQuadrant(b: Box, w: number, h: number): boolean {
  return b.x >= w / 2 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h / 2;
}

/**
 * The places the lockup may go, every one inside the upper-right quarter and
 * above the footer band, the corner first.
 *
 * A grid rather than one fixed corner, because a fixed corner sits on the
 * top of the tower in half the photographs a developer has. `compose.ts`
 * scores each spot on the actual picture and takes the calmest, and a
 * designed frame whose panel still covered something tries the next.
 */
export function lockupSpots(l: Layout): Box[] {
  const { w: lw, h: lh } = l.lockup;
  const right = l.w - l.pad - lw;
  const leftMost = Math.ceil(l.w / 2 + l.pad * 0.25);
  const lowest = Math.floor(Math.min(l.h / 2, l.bandTop - l.pad) - lh - l.pad * 0.25);
  const steps = (a: number, b: number) =>
    b <= a ? [a] : [...new Set([a, Math.round((a + b) / 2), b])];
  const xs = steps(Math.min(leftMost, right), right).reverse();
  const ys = steps(l.pad, Math.max(l.pad, lowest));
  const out: Box[] = [];
  for (const y of ys) for (const x of xs) out.push({ x, y, w: lw, h: lh });
  return out.filter((b) => inTopRightQuadrant(b, l.w, l.h));
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Pango markup treats these as markup, and a headline is not markup. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A font list for Pango, Latin first and Devanagari after.
 *
 * One face cannot set both, and a line that mixes them ("समुद्र की ओर घर ·
 * Sea facing") fell back to a monospace face for the Latin half when only the
 * Devanagari file was named. With both named, Pango takes each glyph from the
 * first family that has it.
 */
export function fontList(weight: "Regular" | "Bold", size: number, family?: string | null): string {
  // A chosen face first; Noto after it for anything it cannot set, which
  // for every face in the catalog includes Devanagari and the rupee sign.
  return `${family ? `${family}, ` : ""}Noto Sans, Noto Sans Devanagari ${weight === "Bold" ? "Bold " : ""}${size}`;
}

/** The lines that go along the foot, in the order they are read. */
export function footLines(input: {
  phone: string | null;
  website: string | null;
  disclaimer: string | null;
  isRender: boolean;
  /**
   * Tamil Nadu and Goa want the promoter named, with the office a buyer is
   * invited to, on the advertisement itself (`namePromoter`).
   */
  ad?: AdRule | null;
  promoter?: string | null;
  officeAddress?: string | null;
}): { contact: string | null; small: string | null } {
  const host = input.website?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null;
  const contact = [input.phone, host].filter(Boolean).join("  ·  ") || null;
  const promoter =
    input.ad?.namePromoter && input.promoter
      ? `${input.promoter}${input.officeAddress ? `, ${input.officeAddress.replace(/\s+/g, " ").trim()}` : ""}.`
      : null;
  const small =
    [promoter, input.isRender ? "Artist's impression." : null, input.disclaimer?.trim() || null]
      .filter(Boolean)
      .join(" ") || null;
  return { contact, small };
}

/**
 * Every film says it was made with AI, in its small print: Meta labels
 * generated media and India's IT Rules (20 February 2026) want synthetic
 * video marked. One thin line, first, so a long disclaimer never pushes it off.
 */
export const AI_LINE = "AI-generated video.";

export function withAiLine(small: string | null): string {
  const rest = small?.trim();
  return rest ? `${AI_LINE} ${rest}` : AI_LINE;
}

// ---------------------------------------------------------------------------
// A schedule's week
// ---------------------------------------------------------------------------

/** Seven entries, Sunday first: a kind, or null for a day off. */
export type WeekPlan = (PostKind | null)[];

export function emptyWeek(): WeekPlan {
  return [null, null, null, null, null, null, null];
}

/** The plan as a form posts it, kept to kinds the catalog knows. */
export function weekFrom(raw: readonly (string | null | undefined)[]): WeekPlan {
  return Array.from({ length: 7 }, (_, d) => {
    const v = raw[d];
    return isPostKind(v) ? v : null;
  });
}

/** The days a week plan posts on, which is what the slot arithmetic reads. */
export function daysOf(week: WeekPlan): number[] {
  return week.flatMap((k, d) => (k ? [d] : []));
}

/** What goes out on one IST weekday. */
export function kindOn(week: WeekPlan | null, dow: number): PostKind {
  return week?.[dow] ?? "IMAGE";
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon image, Wed carousel, Fri video", the way a person reads a plan back. */
export function showWeek(week: WeekPlan): string {
  const parts = week.flatMap((k, d) => (k ? [`${DAY[d]} ${kindDef(k).label.toLowerCase()}`] : []));
  return parts.length ? parts.join(", ") : "No days";
}

// ---------------------------------------------------------------------------
// What pressing "Make" makes
// ---------------------------------------------------------------------------

/** How many versions of each card and size a person may ask for at once. */
export const MAX_VERSIONS = 3;

export type PostJob = { copyId: string; placement: string; version: number };

/**
 * Every post one press makes: each card, in each size chosen, in as many
 * versions as asked. The button's count is this list's length, so the number
 * on it is the number of posts that will appear.
 *
 * Sizes are kept to the ones this kind is made for, and versions to the
 * range offered, so a stale form or an edited one asks for nothing extra.
 */
export function jobsFor(input: {
  kind: PostKind;
  copyIds: readonly string[];
  placements: readonly string[];
  briefFormats: readonly string[];
  versions: number;
}): PostJob[] {
  const allowed = new Set(placementsFor(input.kind, input.briefFormats));
  const sizes = [...new Set(input.placements)].filter((p) => allowed.has(p));
  const versions = Math.min(MAX_VERSIONS, Math.max(1, Math.floor(input.versions) || 1));
  const jobs: PostJob[] = [];
  for (const copyId of [...new Set(input.copyIds)]) {
    for (const placement of sizes) {
      for (let version = 1; version <= versions; version++) {
        jobs.push({ copyId, placement, version });
      }
    }
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Designed by the image model, checked before anybody sees it
// ---------------------------------------------------------------------------

/**
 * How many times one frame is designed before the best attempt is kept.
 *
 * The same bound the copy writer has, for the same reason: a model's mistake
 * is corrected before a person sees it, and a mistake three attempts could
 * not correct is one a person should look at rather than one to keep paying
 * for.
 */
export const MAX_DESIGN_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Video: designed frames brought to life
// ---------------------------------------------------------------------------

/**
 * A video is three frames (the cover, one signed point, the close), each
 * designed and checked like an image, then brought to life by the video
 * model for `SHOT_SECONDS`. Five seconds is the shortest it makes, and three
 * shots is a fifteen-second reel.
 */
export const VIDEO_SHOTS = 3;
export const SHOT_SECONDS = 5;

/**
 * What the video model is asked for: a cinemagraph. The camera does not
 * move, so every word, the QR and the logo stay where the frame's check
 * found them, and our own QR and logo, laid over the clip afterwards, stay
 * on top of the drawn ones. Only nature moves: sky, light, leaves, water.
 * A camera move would carry the printed text with it, and a panel pasted
 * over a moving QR shows the drawn one sliding out from underneath.
 *
 * `strict` is a retry after the frame drifted.
 */
export function motionPrompt(scene: "exterior" | "interior", strict = false): { prompt: string; negative: string } {
  const ambient =
    scene === "interior"
      ? "Only gentle natural motion in the space: soft daylight shifts slowly across the room, sheer curtains stir, " +
        "reflections shimmer faintly, plants sway a little. The room, its furniture and its fittings do not move or change."
      : "Only gentle natural motion in the scene: clouds drift slowly across the sky, tree leaves sway in a light breeze, " +
        "sunlight shifts softly. The building does not move or change in any way.";
  const prompt = [
    "A cinemagraph of this finished real-estate advertisement.",
    "The camera is locked off on a tripod and does not move, zoom, pan or tilt.",
    ambient,
    "Every word of text, the logo, the QR code and every graphic element stay perfectly still, sharp and unchanged.",
    strict ? "Nothing in the frame may change except the sky, the light and the leaves. No new objects, no new text." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const negative =
    "camera movement, zoom, pan, tilt, dolly, shake, changing text, warped letters, morphing letters, new text, " +
    "logo changes, building changes, extra floors, new buildings, people, animals, cars, watermark, flicker";
  return { prompt, negative };
}

/**
 * The problems a clip can have that its still did not: the video model
 * moved something it was told to leave. The still already passed every
 * other rule, so re-judging its layout on a video frame would only let the
 * reader's noise fail a shot the frame's check had cleared.
 */
const DRIFT = new Set(["TEXT_WRONG", "EXTRA_TEXT", "TEXT_CUT", "BUILDING_CHANGED", "QR_UNREADABLE", "NOT_CHECKED"]);

export function judgeMotion(problems: readonly DesignProblem[]): DesignProblem[] {
  return problems
    .filter((p) => DRIFT.has(p.code) && !p.soft)
    .map((p) => ({ ...p, text: p.code === "NOT_CHECKED" ? p.text : `${p.text} (after motion)` }));
}

/** The sizes the image model draws at. Every placement is cropped from one. */
export type DesignSize = "1024x1024" | "1536x1024" | "1024x1536";

/**
 * The size a model that takes any size draws a placement at: the placement's
 * own shape, in multiples of 16, between one and one and a half megapixels,
 * and inside the 1:3 to 3:1 the model allows. Drawing the real shape means
 * nothing is cropped off the design afterwards.
 */
export function designSizeExact(w: number, h: number): string {
  const area = Math.min(Math.max(w * h, 1024 * 1024), 1536 * 1024);
  const k = Math.sqrt(area / (w * h));
  let W = Math.max(16, Math.round((w * k) / 16) * 16);
  let H = Math.max(16, Math.round((h * k) / 16) * 16);
  if (W > H * 3) W = H * 3;
  if (H > W * 3) H = W * 3;
  return `${W}x${H}`;
}

/** The size the model draws a placement's frame at: the part above the footer band. */
export function designSizeForPlacement(w: number, h: number): DesignSize {
  return designSizeFor(w, layoutFor(w, h).bandTop);
}

export function designSizeFor(w: number, h: number): DesignSize {
  const a = w / h;
  if (a >= 1.2) return "1536x1024";
  if (a <= 0.83) return "1024x1536";
  return "1024x1024";
}

/**
 * How much of the drawn picture survives the crop to the placement, as a
 * fraction of each side. A 3000 by 1000 hoarding cut from a 3:2 drawing
 * keeps the full width and half the height, and the model has to be told so
 * or it sets the headline in the half that is thrown away.
 */
export function keptFraction(w: number, h: number, size: DesignSize): { x: number; y: number } {
  const [gw, gh] = size.split("x").map(Number);
  const target = w / h;
  const drawn = gw / gh;
  return target >= drawn ? { x: 1, y: drawn / target } : { x: target / drawn, y: 1 };
}

/** A box on the final frame, as percentages of the drawn picture. */
function onDrawing(box: Box, w: number, h: number, kept: { x: number; y: number }) {
  const px = (v: number) => Math.round(((1 - kept.x) / 2 + (v / w) * kept.x) * 100);
  const py = (v: number) => Math.round(((1 - kept.y) / 2 + (v / h) * kept.y) * 100);
  return { left: px(box.x), right: px(box.x + box.w), top: py(box.y), bottom: py(box.y + box.h) };
}

/**
 * Whether the model is asked to set the words itself.
 *
 * Only for text in the Latin script. An image model draws Devanagari as
 * shapes that resemble it, and a Marathi headline with a broken conjunct is
 * a headline nobody can read. For those languages the model designs the
 * frame and leaves room, and the words are set by Pango, which shapes them
 * properly.
 */
export function modelSetsText(texts: readonly (string | null)[]): boolean {
  return texts.every((t) => !t || /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u.test(t));
}

/** The words one frame carries, in the order they are read. */
export function slideTexts(slide: Slide): string[] {
  return [slide.title, slide.facts?.location ?? null, ...(slide.facts?.prices ?? []), slide.sub, slide.cta].filter(
    (t): t is string => !!t && !!t.trim(),
  );
}

/**
 * The instruction for one frame.
 *
 * The building is described as something to KEEP, in as many concrete words
 * as the model will attend to: "keep the building" alone is read as
 * permission to tidy it. The corners the lockup, the logo and the contact
 * strip are stamped into afterwards are named as empty, so the model's
 * headline is not set underneath them.
 */
export function designPrompt(input: {
  slide: Slide;
  placement: string;
  w: number;
  h: number;
  size: DesignSize;
  colour: string;
  textByModel: boolean;
  /** Problems with the previous attempt, already cleaned. Empty on the first. */
  fixes: readonly string[];
  /** Where the lockup goes this attempt. The layout's corner when omitted. */
  lockup?: Box;
  /** Reference designs attached after the layout, and the category they show. */
  references?: { count: number; label: string } | null;
  /** The art director's notes for a first attempt: the look it is after. */
  direction?: readonly string[];
  /** The typeface a person chose, in words, for the model to set the text in. */
  font?: { describe: string } | null;
  /** The template's own look, and the festival the post is built around. */
  style?: TemplateDirection | null;
}): string {
  // The model designs the frame above the footer band, so every position it
  // is given is measured on that box rather than on the whole frame.
  const L = layoutFor(input.w, input.h);
  const ch = L.bandTop;
  const kept = keptFraction(input.w, ch, input.size);
  const lockup = input.lockup ?? L.lockup;
  const wide = L.w / L.h >= 1.6;
  const top = wide ? L.logo.y + L.logo.h + L.pad * 0.5 : Math.max(lockup.y + lockup.h + L.pad * 0.5, ch * 0.5);
  const textW = wide ? lockup.x - L.pad * 2 : L.w - L.pad * 2;
  const safe = onDrawing({ x: L.pad, y: top, w: textW, h: ch - L.pad * 0.6 - top }, L.w, ch, kept);
  const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
  const refs = input.references && input.references.count > 0 ? input.references : null;

  const lines: string[] = [];
  const layoutWords =
    "the layout: the approved photograph of the property, with one plain white box in the upper right marking where " +
    "the registration panel will be placed";
  if (input.fixes.length) {
    lines.push(
      `The FIRST attached image is your previous attempt. The SECOND is ${layoutWords}.`,
      refs ? `The remaining ${refs.count} images are reference designs.` : "",
      "Redo the advertisement from the layout, fixing these problems:",
      ...input.fixes.map((f) => `- ${f}`),
      "",
    );
  } else {
    lines.push(`The FIRST attached image is ${layoutWords}.`);
    if (refs) lines.push(`The other ${refs.count} images are reference designs.`);
  }
  lines.push(
    `Design a finished, premium real-estate advertisement from the layout, for ${input.placement}.`,
    "The white box is a MARKER ONLY, showing where the registration panel will be placed on top afterwards. Do not " +
      "draw a white box, card or panel there. Continue the background (sky, photo or plain colour) through that area, " +
      "and keep text, people, the building's top and anything important out of it. The logo goes in a footer bar " +
      "added below the picture, so do not draw one.",
  );
  if (refs) {
    lines.push(
      `Follow the reference designs closely for STYLE ONLY (the ${refs.label.toLowerCase()} kind of ad): their layout and composition, type ` +
        "treatment, colour mood, graphic shapes and how the headline, details and call to action are arranged. Never copy " +
        "anything written on them, their numbers, phone numbers, websites, logos, people, rooms or buildings. The property is " +
        "only the one in the approved photograph.",
    );
  } else {
    lines.push(
      "Make it look like an ad a top agency would run: confident typography, strong hierarchy, rich but natural light, " +
        "tasteful graphic elements (bands, gradients, frames, shapes). Clean, not cluttered.",
    );
  }
  lines.push(...styleLines(input.style ?? null));
  if (input.direction?.length) lines.push("Art direction:", ...input.direction.map((d) => `- ${d}`));
  lines.push(
    `Use the brand colour ${input.colour} for the accents.`,
    "",
    "THE PROPERTY MUST NOT CHANGE. Keep the building exactly as photographed: the same outline, the same number of floors, " +
      "the same windows, balconies, materials and colours, from the same viewpoint. Do not add, remove, extend or reshape any " +
      "part of it. Do not add other buildings, towers, water, greenery or landmarks that are not in the photograph. You may " +
      "improve the sky, the light and the mood around it.",
    "",
  );
  if (input.textByModel) {
    lines.push("Set this text, spelled exactly as written, and no other words:");
    if (input.font) lines.push(`Set every word in ${input.font.describe}.`);
    lines.push(`- Headline, large and bold: ${q(input.slide.title)}`);
    if (input.slide.facts?.location) lines.push(`- The location, in spaced capitals near the headline: ${q(input.slide.facts.location)}`);
    if (input.slide.facts?.prices.length) {
      lines.push(`- The price, bold and prominent, second only to the headline: ${input.slide.facts.prices.map(q).join(" and ")}`);
    }
    if (input.slide.sub) lines.push(`- Supporting line, smaller: ${q(input.slide.sub)}`);
    if (input.slide.cta) lines.push(`- A button: ${q(input.slide.cta)}`);
    lines.push(
      refs
        ? "Place the text where the reference designs place theirs, as long as it stays out of the marked area. Fully visible, never cut off."
        : "Set the text clear of the marked area, never beside or under it: " +
            `inside ${safe.left}% to ${safe.right}% across and ${safe.top}% to ${safe.bottom}% down, fully visible, never cut off.`,
    );
  } else {
    lines.push(
      `Do not write any text at all. Leave the area from ${safe.left}% to ${safe.right}% across and ` +
        `${Math.round((safe.top + safe.bottom) / 2)}% to ${safe.bottom}% down calm and dark enough for white text to be set on it later.`,
    );
  }
  lines.push(
    "",
    "Keep a clear margin along the bottom edge: a footer bar is added below the picture.",
    "Do not draw any other text, numbers, prices, phone numbers, websites, logos, QR codes, barcodes, watermarks or registration numbers.",
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/**
 * The instruction when the image model designs the WHOLE ad: headline,
 * registration block, contact line and small print, as ChatGPT did on the
 * sample that looked right. Only three things are ours afterwards: the real
 * QR pasted over the one it draws (it never scans), the logo pasted into the
 * green slot it leaves, and the check.
 *
 * The images are named in words ("the second image"), never in digits,
 * because a digit in the instruction is what the guardrail looks for in a
 * fix. `qrMode` "magenta" is the fallback when no QR could be found in the
 * last attempt: a flat square is found by colour where a drawn QR was not.
 */
export function fullDesignPrompt(input: {
  slide: Slide;
  placement: string;
  size: string;
  colour: string;
  fixes: readonly string[];
  references: { count: number; label: string } | null;
  registrationNo: string | null;
  /**
   * The registering state's advertising rule: the label, the website, where
   * the block goes, whether it has a QR. Maharashtra's when not given.
   */
  ad?: AdRule | null;
  /** Telangana's building permit number, printed beside the registration. */
  permitNo?: string | null;
  phone: string | null;
  website: string | null;
  smallPrint: string | null;
  hasLogo: boolean;
  /** The ink colour of the brand logo, if available, so the background can be designed for high contrast. */
  logoInk?: readonly number[] | null;
  /** "none": a state that asks for no QR, with none in the library. */
  qrMode: "draw" | "magenta" | "none";
  /** The QR's side as a share of the ad's width, in per cent. */
  qrPercent: number;
  /** A previous attempt is attached last. */
  previous: boolean;
  /**
   * One slide of a carousel, or one frame of a video: which one, of how many,
   * and whether the finished first one is attached (after the references)
   * for every later one to match.
   */
  carousel?: { index: number; total: number; cover: boolean; video?: boolean } | null;
  /**
   * What the photograph shows: the building from outside, a space inside
   * the project, or a construction site. Exterior by default.
   */
  scene?: "exterior" | "interior" | "site";
  /**
   * An edit of an earlier attempt rather than a design from the photograph:
   * the attempt is the first image and the approved photograph the next, and
   * the model is told to keep everything but the listed changes (`fixes`).
   * This is what a person does at ChatGPT with a picture that is nearly
   * right, and it keeps what was right about it instead of rolling the dice
   * on a whole new layout.
   */
  edit?: boolean;
  /** The art director's notes for a first attempt: the look it is after, never a claim. */
  direction?: readonly string[];
  /**
   * The typeface a person chose, described in words, with a specimen of it
   * attached after the QR. An edit keeps the typeface it already has.
   */
  font?: { describe: string } | null;
  /** The template's own look, and the festival the post is built around. */
  style?: TemplateDirection | null;
  /** The festival's greeting, set small; only where the model sets every word. */
  greeting?: string | null;
  /**
   * A single image whose registration block (QR, number, website) we set
   * afterwards, as on a carousel: the model leaves the upper-right quarter
   * empty. Drawn by the model, it came back on a white card every time.
   */
  stampBlock?: boolean;
}): string {
  if (input.edit) return editDesignPrompt(input);
  // A brief in sections, the result named first, the look described rather
  // than listed as prohibitions: the shape OpenAI's prompting guide asks for.
  // The first version was a wall of rules, and the posts came back as big
  // type in big boxes, every element fighting for room.
  const q = (t: string) => `"${t.replace(/"/g, "'")}"`;
  const count = (n: number) => NUMBER_WORDS[n] ?? "a few";
  const deck = input.carousel ?? null;
  const role = input.slide.role;
  const scene = input.scene ?? "exterior";
  const clip = !!deck?.video;
  const noun = clip ? "frame" : "slide";
  const lines: string[] = [
    deck
      ? `Create ${noun} ${count(deck.index + 1)} of ${count(deck.total)} of a clean, modern, premium real-estate ${clip ? "video" : "carousel"} advertisement for ${input.placement}.`
      : `Create a clean, modern, premium real-estate social media advertisement for ${input.placement}.`,
    "",
    "IMAGES",
    scene === "site"
      ? "- The first image is an approved construction photograph of this project on site. Edit it into the ad: the unfinished structure is the hero, and it stays unfinished."
      : scene === "interior"
        ? "- The first image is the approved photograph of a space in the project. Edit it into the ad: this space is the hero, and the ad shows this same space."
        : "- The first image is the approved photograph of the property. Edit it into the ad: this building is the hero.",
  ];
  if (input.qrMode === "draw") lines.push(`- The second image is the project's ${adOf(input.ad)?.authority ?? "RERA"} QR code.`);
  if (input.font) lines.push("- The next image is a specimen of the typeface to set every word in.");
  if (input.references?.count) {
    const what = clip
      ? input.references.count === 1
        ? "image is a still from a reference video ad"
        : "images are stills from reference video ads"
      : deck
      ? input.references.count === 1
        ? "image is a page from a reference carousel"
        : "images are pages from a reference carousel"
      : input.references.count === 1
        ? "image is a reference ad"
        : "images are reference ads";
    lines.push(`- The next ${count(input.references.count)} ${what}, for composition and mood only.`);
  }
  if (deck?.cover) {
    lines.push(
      `- The next image is the first ${noun} of this same ${clip ? "video" : "carousel"}, already made, for its type and layout only. Match ` +
        "its typeface, type sizes, colours and spacing, and keep the registration block and the logo in the exact same sizes and places, " +
        `so the ${noun}s read as one set. Never take its photograph, its building or its scenery: this ${noun} shows only ` +
        "what the first image shows. DO NOT draw a logo or write a brand name: leave only the green rectangle slot in that exact upper-left spot as on the cover.",
    );
  }
  if (input.previous) lines.push("- The last image is your previous attempt.");
  if (deck) {
    const job =
      role === "cover"
        ? clip
          ? "This is the opening frame: it stops the scroll."
          : "This is the cover: it opens the set and makes a person swipe."
        : role === "point"
          ? `This ${noun} makes one point: the headline below, and nothing more.`
          : role === "photo"
            ? `This is a photo ${noun}: the photograph is the whole message, with no headline and no words of its own.`
            : `This is the closing ${noun}: the call to action is its one line, placed clearly inside the button. The button must be fully labeled with the call to action; never leave it empty or blank.`;
    lines.push("", `THIS ${noun.toUpperCase()}`, job);
  }
  if (input.fixes.length) {
    lines.push("", "FIX FROM THE PREVIOUS ATTEMPT", ...input.fixes.map((f) => `- ${f}`));
  }
  if (input.direction?.length) {
    lines.push("", "ART DIRECTION", ...input.direction.map((f) => `- ${f}`));
  }
  // A chosen template's look leads, and the house look only sets the type.
  // The house look came first and said "no bars, no badges, a restrained
  // palette", which overruled every template: a construction update and a
  // launch came back as the same ad.
  const kind = input.style?.look ? input.style : null;
  lines.push(
    "",
    "LOOK AND FEEL",
    (kind
      ? `This is a ${kind.label.toLowerCase()} ad, and it must read as one at first sight: ${kind.look} ` +
        "Use the graphic devices this kind of ad is known for (its frames, bands, ribbons, colour and motifs) boldly, " +
        "as the reference ads do; they are graphics only and carry no words of their own. The photograph stays the hero. "
      : "Clean and modern, the way a top agency's premium work looks. The photograph fills most of the canvas and does " +
        "the talking. Generous empty space. ") +
      "In the upper-left sky behind the logo, paint soft white clouds or a light sky break so the royal blue logo has high contrast without camouflage. " +
      (input.font
        ? `Small, well-spaced type, every word from the headline to the small print set in ${input.font.describe}, ` +
          "exactly as in the specimen; the headline "
        : "Small, elegant, well-spaced type in one refined typeface family; the headline ") +
      "is confident but not oversized. At most four groups of text: the headline, where it is and what it starts at, " +
      "one supporting line, and the call to action. " +
      (kind
        ? `No feature chips with words in them, no clutter. ${input.colour} is an accent beside the kind's own colours.`
        : `No big boxes, no heavy bars, no badges, no icons, no feature chips, no clutter. A restrained palette, with ${input.colour} as the accent.`),
  );
  if (input.references?.count) {
    lines.push(
      kind
        ? "Follow the reference ads' design closely: their graphic devices, colour scheme, framing, type treatment and composition. Never their words, numbers, logos, people or buildings."
        : "Take the reference ads' composition, spacing and mood; never their words, numbers, logos, people or buildings.",
    );
  }
  lines.push(...styleLines(kind ? { ...kind, look: null } : (input.style ?? null), input.carousel));
  lines.push("", ...keepProperty(scene), "", ...textAndBlocks(input, "second"));
  return lines.join("\n");
}

/** What the model must keep of the photograph: the building, the site, or the space inside. */
function keepProperty(scene: "exterior" | "interior" | "site"): string[] {
  if (scene === "site") {
    return [
      "THE SITE",
      "Keep the construction site exactly as photographed: the same unfinished structure, floors poured, scaffolding, " +
        "materials and colours, from the same viewpoint. Do not finish the building, add glass, paint, cladding, " +
        "landscaping or a skyline that is not in the photograph. You may adjust the light only.",
    ];
  }
  return scene === "interior"
    ? [
        "THE SPACE",
        "Keep it exactly as photographed: the same room, layout, furniture, fittings, materials and colours, from the " +
          "same viewpoint. Add no rooms, and no sea, lake, skyline or landmark in a window that is not in the " +
          "photograph: a view drawn in is a view promised. You may improve the light.",
      ]
    : [
        "THE BUILDING",
        "Keep it exactly as photographed: the same outline, number of floors, windows, balconies, materials and colours, " +
          "from the same viewpoint. Add no towers, and no sea, lake, river, road, skyline or landmark that is not in the " +
          "photograph: a view drawn in is a view promised. You may improve the sky, the light and the season, and frame it " +
          "with foreground greenery.",
      ];
}

/**
 * An edit of an earlier attempt: keep everything, change only what is listed.
 * The text, the registration block and the logo slot are restated in full,
 * because an edit told only "move the headline" drops the footnote as often
 * as it keeps it.
 */
function editDesignPrompt(input: Parameters<typeof fullDesignPrompt>[0]): string {
  const deck = input.carousel ?? null;
  const clip = !!deck?.video;
  const noun = clip ? "frame" : "slide";
  const what = deck
    ? `${noun} of a real-estate ${clip ? "video" : "carousel"} advertisement`
    : "real-estate social media advertisement";
  const scene = input.scene ?? "exterior";
  const lines: string[] = [
    `Edit the first image. It is a finished ${what} for ${input.placement}, and it is nearly right. Keep everything else ` +
      "exactly as it is: the layout, the photograph, the typefaces, the colours, the spacing and every piece of text. " +
      "Change only this:",
    ...(input.fixes.length ? input.fixes : ["Refine the finish, changing as little as possible."]).map((f) => `- ${f}`),
    "",
    "IMAGES",
    "- The first image is the advertisement to edit.",
    scene === "site"
      ? "- The second image is the approved construction photograph: the site in the edit must stay exactly as unfinished as it is here."
      : scene === "interior"
        ? "- The second image is the approved photograph of the space: the space in the edit must stay exactly as it is here."
        : "- The second image is the approved photograph of the property: the building in the edit must stay exactly as it is here.",
  ];
  if (input.qrMode === "draw") lines.push(`- The third image is the project's ${adOf(input.ad)?.authority ?? "RERA"} QR code.`);
  if (deck?.cover) {
    lines.push(
      `- The last image is the first ${noun} of this same ${clip ? "video" : "carousel"}, for its type and layout only. ` +
        `Never take its photograph, its building or its scenery.`,
    );
  }
  lines.push("", ...keepProperty(scene), "", ...textAndBlocks(input, "third"));
  return lines.join("\n");
}

/** Counts said in words, so no digit in an instruction ever reads as a number to set. */
const NUMBER_WORDS: Record<number, string> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
};

/**
 * What the template asks of this one post: the kind of ad it is, in words,
 * and the festival it is built around. The festival is the whole mood of the
 * design, kept to the graphics, the sky and the edges of the frame.
 */
export function styleLines(style: TemplateDirection | null, deck?: { index: number; total: number } | null): string[] {
  if (!style) return [];
  const lines: string[] = [];
  if (style.look) {
    let look = style.look;
    if (deck && deck.total > 1) {
      look = look.replace(/Progress is shown only by the graphic timeline at the foot \(circles on a line\)[^.]*\./gi, "").trim();
    }
    lines.push(
      "",
      `THIS KIND OF AD: ${style.label.toUpperCase()}`,
      look,
      `A buyer must recognise this as a ${style.label.toLowerCase()} ad in under a second. ` +
        "A clean generic property ad that could be any other kind is wrong for this template.",
    );
  }
  if (style.continuity) {
    if (deck && deck.total > 1) {
      // Say the place in words, never digits: the design prompt is checked and
      // the art director must not copy a figure into its own instructions.
      const current = NUMBER_WORDS[deck.index + 1] ?? "this";
      const total = NUMBER_WORDS[deck.total] ?? "every";
      if (/timeline|marker|progress dot|segmented|bar|pill|dots|counter/i.test(style.continuity)) {
        lines.push(
          "",
          `CAROUSEL CONTINUITY (SLIDE ${current.toUpperCase()} OF ${total.toUpperCase()})`,
          "The slide tracking continuity indicator, phone number and legal footnote are stamped by us afterwards across the bottom of every slide.",
          "Do NOT draw any timeline line, tracking line, segmented bar, pill counter, progress line, dots, arrows or milestone markers anywhere on the image, especially at the bottom or foot. Keep the entire bottom area completely clear of any tracking lines, progress markers or footer graphics: we stamp those afterwards, matching every slide.",
          "Graphics only elsewhere: no words, digits, stage names, dates or labels beyond the approved copy.",
        );
      } else {
        lines.push(
          "",
          `CAROUSEL CONTINUITY (SLIDE ${current.toUpperCase()} OF ${total.toUpperCase()})`,
          `Every slide of this carousel carries ${style.continuity}.`,
          "Leave the entire bottom foot band empty of timelines, dots, arrows and progress markers: we stamp those afterwards, matching every slide.",
          "Graphics only elsewhere: no words, digits, stage names, dates or labels beyond the approved copy.",
        );
      }
    } else {
      lines.push(
        "",
        "CARRIED ACROSS EVERY SLIDE",
        `This is one slide of a carousel. Every slide carries ${style.continuity}. ` +
          "Draw it in the same place, size and colour as on the cover, so a swipe reads as one set. It is graphics only: no words or numbers in it.",
      );
    }
  }
  if (style.festival) {
    const f = style.festival;
    lines.push(
      "",
      `FESTIVAL: ${f.label.toUpperCase()}`,
      `Build the whole design around ${f.label}: ${f.look}. It must read as a ${f.label} post at first sight. ` +
        "The festive elements live in the graphics, the sky, the border and the colour; the property stays exactly as " +
        "photographed, with nothing hung on it, wrapped round it or drawn over it.",
    );
  }
  return lines;
}

function textAndBlocks(input: Parameters<typeof fullDesignPrompt>[0], qrImage: string): string[] {
  const q = (t: string) => `"${t.replace(/"/g, "'")}"`;
  const lines: string[] = ["TEXT, spelled exactly as written, and no other words"];
  if (input.greeting) lines.push(`- A festive greeting, small and graceful, above the headline: ${q(input.greeting)}`);
  if (input.slide.role === "close") {
    const cta = input.slide.cta ?? input.slide.title;
    lines.push(
      `- Call to action: set ${q(cta)} clearly inside a styled button. Every button drawn MUST be clearly labeled with this exact text inside it; never leave a button box blank, empty, or with just an arrow.`,
    );
    if (input.slide.cta && input.slide.title && input.slide.title !== input.slide.cta) {
      lines.push(`- Headline: ${q(input.slide.title)}`);
    }
  } else {
    if (input.slide.title.trim()) lines.push(`- Headline: ${q(input.slide.title)}`);
  }
  const facts = input.slide.facts ?? null;
  if (facts?.location) {
    lines.push(
      `- The location, on its own line close to the headline, in spaced capitals, small but clearly readable: ${q(facts.location)}`,
    );
  }
  if (facts?.prices.length) {
    lines.push(
      `- The price, the second most prominent text after the headline, bold, each on its own line or as ` +
        `side-by-side blocks of equal weight, never in the small print: ${facts.prices.map(q).join(" and ")}`,
    );
  }
  if (input.slide.sub) {
    lines.push(
      facts?.prices.length
        ? `- One small supporting line, directly under the price, as part of the same group: ${q(input.slide.sub)}`
        : `- One small supporting line: ${q(input.slide.sub)}`,
    );
  }
  if (input.slide.role !== "close" && input.slide.cta) {
    lines.push(`- Call to action, as a small understated button or text link: ${q(input.slide.cta)}`);
  }
  // The phone and the website ride in the small print. Asked for as their
  // own line, the model set them larger than the registration number on
  // every live run, which is the one thing Order 46C/2025 forbids; in the
  // footnote they are small by nature and the number reads as the larger.
  const ad = adOf(input.ad);
  const strip = !!input.registrationNo && ad?.placement === "BOTTOM_STRIP";
  const contact = [input.phone, input.website].filter(Boolean) as string[];
  const foot = [...contact, input.smallPrint].filter(Boolean) as string[];
  // Carousel slides stamp contact, small print and artist's impression after
  // the drawing. Asking the model for a footnote too left faint phone lines
  // that failed CONTACT_UNREAD / CONTRAST_LOW / NO_IMPRESSION at the final gate.
  if (input.carousel && !strip) {
    lines.push(
      "- Leave the bottom edge calm and empty of phone numbers, websites, disclaimers, 'Artist's impression', timelines, tracking lines, and progress dots: " +
        "we stamp those there afterwards, matching every slide.",
    );
  } else if (foot.length) {
    lines.push(
      strip
        ? `- One line of tiny footnote type just above the registration strip, the smallest text in the ad: ${foot.map(q).join(" · ")}. Keep it sharp and high-contrast so the phone number stays readable.`
        : `- One line of tiny footnote type along the bottom edge, the smallest text in the ad: ${foot.map(q).join(" · ")}. Keep it sharp and high-contrast so the phone number stays readable.`,
    );
  }
  if (input.registrationNo && ad) {
    const regLines = registrationLines(ad, input.registrationNo, input.permitNo ?? null);
    const said = regLines.map(q).join(regLines.length > 2 ? ", " : " and ");
    const these = regLines.length === 2 ? "these two lines" : "these lines";
    if (strip) {
      // West Bengal: a strip along the foot, at least 8 per cent of the
      // area, bold, on a contrasting ground. No QR.
      lines.push(
        "",
        "REGISTRATION STRIP (required by law)",
        "Along the bottom edge, across the full width, a solid strip in a colour that contrasts clearly with the " +
          `picture, about one-eleventh of the ad's height, carrying exactly ${these} in bold, clearly readable ` +
          `type: ${said}. Nothing else in the strip.`,
      );
    } else {
      const code =
        input.qrMode === "draw"
          ? `the QR code from the ${qrImage} image, flat and straight (not rotated, not tilted, not in perspective), on a small white square with a thin white margin`
          : input.qrMode === "magenta"
            ? "a plain solid magenta square (pure #FF00FF, flat colour, nothing drawn in it) where the QR code will be placed"
            : null;
      if (input.carousel || input.stampBlock) {
        // Carousel slides and single images get the real QR and registration
        // stamped by us, so the model must leave that corner clear rather than
        // draw a faint or boxed lockup we then have to paint out.
        lines.push(
          "",
          "REGISTRATION BLOCK",
          "Leave the UPPER-RIGHT QUARTER calm and empty of words, QR codes, panels and logos: " +
            `the registration number, authority website and QR are set there by us afterwards${input.carousel ? ", matching every slide" : ""}. ` +
            "Do not draw a registration number, website, QR code, white box or magenta square in that quarter.",
        );
      } else {
        lines.push(
          "",
          "REGISTRATION BLOCK (required by law)",
          (code
            ? `In the top-right corner, clearly readable: ${code}, about ` +
              `${input.qrPercent}% of the ad's width on each side, in the corner; to its LEFT, right-aligned against it and stacked, exactly `
            : "In the top-right corner, clearly readable: right-aligned and stacked, exactly ") +
            `${these}: ${said}. The registration number must be bold and distinctly LARGER ` +
            "than the footnote line with the phone number (the law strictly requires the RERA registration number never be smaller than the contact phone number). No box, panel, card, " +
            "band or background behind the words: set them straight on the design, in a colour that stands out clearly from " +
            "what is behind them (light on a dark area, dark on a light one). Keep it all inside the UPPER-RIGHT QUARTER (the right half and the top half), on a " +
            "calm part of the design, off the building, faces and text.",
        );
      }
    }
  }
  if (input.hasLogo) {
    const isDark = !input.logoInk || luminance(input.logoInk) < 0.45;
    const colorDesc = input.logoInk
      ? (input.logoInk[2] > 110 && input.logoInk[2] > input.logoInk[0] + 20 && input.logoInk[2] > input.logoInk[1] + 20
          ? "royal blue"
          : input.logoInk[0] > 110 && input.logoInk[0] > input.logoInk[1] + 20 && input.logoInk[0] > input.logoInk[2] + 20
            ? "red"
            : input.logoInk[1] > 110 && input.logoInk[1] > input.logoInk[0] + 20 && input.logoInk[1] > input.logoInk[2] + 20
              ? "green"
              : isDark ? "dark-toned" : "light-toned")
      : "royal blue / colored";

    lines.push(
      "",
      "LOGO & SKY BACKGROUND",
      `The brand logo is set with a transparent background in its authentic ${colorDesc} brand colours (its colour is never changed, and there must be NO fixed-shape white card, box or sticker behind it). ` +
        "Where the brand logo belongs, on a calm plain part of the design (sky or a flat colour, off the building; bright daylight or pale background so dark marks stand out and never camouflage), leave " +
        "a small plain rectangle of solid pure green (#00FF00), about three times as wide as it is tall and about a fifth " +
        "of the ad's width. Prefer the upper-left sky for this slot. " +
        `SMART SKY: In the upper-left sky directly behind this logo area, paint soft white clouds or a light sky break seamlessly into the atmosphere (keeping the rest of the sky natural blue, but softly lightening the sky behind the logo) so the ${colorDesc} logo stands out with crisp contrast without camouflage. ` +
        "The logo is set there with nothing behind it and a transparent background, so draw no box, card or panel around the " +
        "rectangle (no white card, border, sticker or backing). Do not draw a logo or write a brand name: leave only the plain green rectangle.",
    );
  }
  lines.push("", "Draw no other text, numbers, prices, phone numbers, websites, logos or QR codes.");
  return lines;
}

/** WCAG relative luminance of an sRGB colour, 0 for black to 1 for white. */
export function luminance([r, g, b]: readonly number[]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * How a logo is printed with nothing behind it: in its own colours when they
 * stand out from what is under it, and otherwise as a white or a near-black
 * silhouette, whichever stands out more. A logo on a white chip read on any
 * picture, and it also read as a sticker pasted on the ad; a navy mark set
 * straight onto a dark photograph disappears. Three to one is the WCAG floor
 * for large graphics.
 */
export function markColour(ink: readonly number[], ground: readonly number[]): "as-is" | "white" | "ink" {
  if (contrast(ink, ground) >= 3) return "as-is";
  return contrast([255, 255, 255], ground) >= contrast([17, 17, 17], ground) ? "white" : "ink";
}

/**
 * The contrast the registration block's words are set for. The pixel gate
 * asks 4.5 to 1; a JPEG and a film moving under the words take some back.
 */
export const BLOCK_CONTRAST = 5.5;

/** The strongest shade put behind the block's words: past it the shade is a panel. */
const MAX_SHADE = 0.8;

/**
 * Which ink the registration block's words take, and how strong a soft shade
 * of the other tone sits behind them, so they read at `BLOCK_CONTRAST` over
 * the ground under them. White ink is judged on the brightest twentieth of
 * the ground and dark ink on the darkest, and the one needing less shade
 * wins. Usually that is none at all: a sky takes dark ink, a facade at dusk
 * white. A film moves under the words, so it takes white ink over the shade
 * white itself would need, whatever its first frame shows.
 */
export function blockShade(ground: readonly (readonly number[])[], moving: boolean): { ink: "white" | "dark"; alpha: number } {
  const needs = (px: readonly number[], toward: number, ok: (l: number) => boolean) => {
    for (let a = 0; a <= MAX_SHADE + 1e-9; a += 0.02) {
      if (ok(luminance(px.map((c) => c + (toward - c) * a)))) return Math.round(a * 100) / 100;
    }
    return MAX_SHADE;
  };
  const dark = luminance([17, 17, 17]);
  const forWhite = (px: readonly number[]) => needs(px, 0, (l) => 1.05 / (l + 0.05) >= BLOCK_CONTRAST);
  if (moving || !ground.length) return { ink: "white", alpha: forWhite([255, 255, 255]) };
  const byLight = [...ground].sort((p, q) => luminance(p) - luminance(q));
  const at = (f: number) => byLight[Math.min(byLight.length - 1, Math.floor(byLight.length * f))];
  const white = forWhite(at(0.95));
  const ink = needs(at(0.05), 255, (l) => (l + 0.05) / (dark + 0.05) >= BLOCK_CONTRAST);
  if (white !== ink) return white < ink ? { ink: "white", alpha: white } : { ink: "dark", alpha: ink };
  return luminance(at(0.5)) > 0.35 ? { ink: "dark", alpha: ink } : { ink: "white", alpha: white };
}

export const ALTERS_PROPERTY =
  /\b(add|adding|remove|removing|extra|more|fewer|taller|shorter|higher|lower|extend|reshape|change|replace|move)\b[^.]{0,40}\b(floors?|storeys?|stories|towers?|buildings?|balcon\w*|windows?|facade|wings?)\b/i;

/**
 * Whether a sentence asks for the property itself to change, in either
 * order ("add two floors", "make the tower taller", "change the facade").
 * Narrower than `ALTERS_PROPERTY` on purpose: an art director writes "move
 * the headline off the building" and "crop tighter on the tower" all day,
 * and neither asks for anything to be built.
 */
const ADDS_TO_PROPERTY =
  /\b(add|adding|remove|removing|erase|extra|more|fewer|extend|extending|reshape|redesign|replace|rebuild|recolou?r)\b[^.]{0,30}\b(floors?|storeys?|stories|towers?|buildings?|balcon\w*|windows?|facade|façade|wings?|sea|lake|river|views?|landmarks?|skyline)\b(?!\s+(?:registration|number|line|text|details|block|info))/i;
const PROPERTY_GROWS = /\b(floors?|storeys?|stories|towers?|buildings?|facade|façade|wings?)\b[^.]{0,20}\b(taller|shorter|narrower|higher-rise)\b/i;
const CHANGE_THE_PROPERTY = /\bchang\w*\b[^.]{0,20}\b(building|tower|facade|façade|floors?|windows?|balcon\w*)\b/i;

export function changesProperty(text: string): boolean {
  return ADDS_TO_PROPERTY.test(text) || PROPERTY_GROWS.test(text) || CHANGE_THE_PROPERTY.test(text);
}

/**
 * The checker's fixes that may be passed on, for an agent that edits rather
 * than stopping. A fix the guardrail would refuse (the checker's own words
 * carried a number, or asked for the tower to be taller) is left out rather
 * than ending the work: the agent is still shown what was wrong, and the
 * words that must not reach the drawing model never do.
 */
export function safeFixes(fixes: readonly string[], cleared: readonly string[]): string[] {
  return fixes.filter((f) => {
    const bare = cleared.reduce((s, t) => (t ? s.split(t).join(" ") : s), f);
    return !/[0-9०-९]/.test(bare) && !ALTERS_PROPERTY.test(bare) && !changesProperty(bare);
  });
}

/**
 * The instruction guardrail: what is about to be sent to the image model.
 *
 * Every part of the instruction that changes between calls is checked, and
 * refused rather than repaired. The words to set must be words that already
 * cleared (the card, or a talking point somebody signed); a never-say phrase
 * must not appear anywhere; and the fixes, which are the checker model's own
 * words, must carry no number and no request to change the property. A
 * checker that answered "add two floors" or "show Rs 45 lakh" would
 * otherwise pass its mistake straight to the model that draws.
 */
export function checkDesignPrompt(input: {
  prompt: string;
  slide: Slide;
  /** Everything that has cleared and may be set: the card, the talking points. */
  cleared: readonly string[];
  neverSay: readonly string[];
  fixes: readonly string[];
}): string[] {
  const issues: string[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const ok = new Set(input.cleared.map(norm));
  for (const t of slideTexts(input.slide)) {
    if (!ok.has(norm(t))) issues.push("A line to be set on the post has not cleared the copy check.");
  }
  const lower = input.prompt.toLowerCase();
  for (const phrase of input.neverSay) {
    const p = phrase.trim().toLowerCase();
    if (p.length >= 3 && lower.includes(p)) {
      issues.push(`The instruction contains a never-say phrase ("${phrase.trim()}").`);
    }
  }
  for (const f of input.fixes) {
    // Quoting cleared copy back is how a misspelling is fixed, so the copy's
    // own words are taken out before the fix is read.
    const bare = input.cleared.reduce((s, t) => (t ? s.split(t).join(" ") : s), f);
    if (/[0-9०-९]/.test(bare)) issues.push("A fix carries a number, and the model is never told a number.");
    if (ALTERS_PROPERTY.test(bare)) issues.push("A fix asks to change the property.");
  }
  if (input.prompt.length > 7000) issues.push("The instruction is too long.");
  return [...new Set(issues)];
}

/** What the checker model reports about one finished frame. */
export type DesignReview = {
  /** Every piece of text in the design, except the logo, the panel and the bottom strip. */
  texts: string[];
  /** The registration number as printed in the white panel, or "". */
  registration: string;
  /** The phone number as printed along the bottom, or "". */
  phone: string;
  /** Any text cut off at an edge, or covered by another element. */
  textCutOff: boolean;
  buildingMatches: boolean;
  buildingIssues: string;
  looksLikeAd: boolean;
  designIssues: string;
  /** The registration panel sits on the building, a person, or text. */
  panelCoversContent?: boolean;
  /** The Authority's website as printed, or "". */
  reraWebsite?: string;
  /** The QR, the number and the website all sit in the upper-right quarter. */
  reraTopRight?: boolean;
  /** The number and the website sit in a strip along the bottom edge. */
  reraAtBottom?: boolean;
  /** The number and the website are at least as large as the contact details. */
  reraTextLargeEnough?: boolean;
};

export type DesignProblem = {
  code: string;
  /** In the client's words, for the tile. */
  text: string;
  /** Whether designing again could fix it. */
  fixable: boolean;
  /** What the model is told, for a fixable one. Carries no number. */
  fix?: string;
  /** Worth another attempt, but does not stop the post passing (a missing logo slot). */
  soft?: boolean;
};

/** Letters and digits only, lower case, so line breaks and punctuation never fail a match. */
export function looseText(s: string): string {
  // The rupee sign and "Rs" are the same amount, and a designer writes
  // either; neither is a misspelling of the other.
  return s
    .replace(/₹\s*/g, "rs ")
    .replace(/rs\.\s*/gi, "rs ")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Levenshtein distance: the fewest letters added, removed or changed to turn one into the other. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Whether a line is on the frame with at most a slip of a letter: one change
 * in twenty letters, two at most, and every number exactly as cleared. A
 * headline shorter than that must be exact. Both
 * the drawing model and the reading model correct a misspelling they meet
 * ("weekened" came back "weekend" every time), so a line that is one letter
 * off is not proof the model set it wrong, and it never changes a price.
 */
export function nearLine(seen: string, want: string): boolean {
  if (seen.includes(want)) return true;
  const allowed = Math.min(2, Math.floor(want.length / 20));
  if (!allowed) return false;
  const words = seen.split(" ");
  const n = want.split(" ").length;
  for (const len of [n, n - 1, n + 1]) {
    for (let i = 0; len > 0 && i + len <= words.length; i++) {
      const piece = words.slice(i, i + len).join(" ");
      if (digitsOf(piece) === digitsOf(want) && editDistance(piece, want) <= allowed) return true;
    }
  }
  return false;
}

/** A model's sentence, cleaned for passing back to a model: no digits, no double quotes, one line. */
export function cleanFix(s: string): string {
  return s
    .replace(/[0-9०-९]+/g, "")
    .replace(/["“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/**
 * The post-generation guardrail: is this frame fit to be a post.
 *
 * The checker model READS the frame; this function DECIDES, by comparing
 * what it read with what should be there. Deciding in code rather than
 * asking a model "is it compliant" is the split the copy gate makes: a model
 * is good at reading a picture and is not to be trusted with a verdict.
 *
 * The QR, the registration number and the phone are ours, stamped after the
 * model, so a failure there is not the model's to fix and designing again
 * would only cost money. The words, the building and the look are the
 * model's.
 */
export function judgeDesign(input: {
  review: DesignReview | null;
  /** Words that must be visible, exactly. */
  expected: readonly string[];
  /** Words that may also appear (cleared copy, talking points, the brand's name). */
  allowed: readonly string[];
  registrationNo: string | null;
  /** The registering state's advertising rule. Maharashtra's when not given. */
  ad?: AdRule | null;
  /** Telangana's building permit number, when the state prints one. */
  permitNo?: string | null;
  phone: string | null;
  /** What the reference picture shows: exterior building, interior room, or site. */
  scene?: "exterior" | "interior" | "site";
  qr: { lockup: boolean; expected: string | null; read: string | null };
  /**
   * Set when the image model drew the whole ad, registration block and
   * contact line included, and only the QR was swapped for the real one.
   * What the model drew is the model's to fix.
   */
  full?: {
    qrFound: boolean;
    qrInQuadrant: boolean;
    qrBigEnough: boolean;
    /** Null when there is no logo to place. */
    logoSlot: boolean | null;
  };
}): DesignProblem[] {
  const out: DesignProblem[] = [];
  const f = input.full;
  // An exempt tower registers nothing, and its advertisement carries nothing
  // in place of the registration block: no QR, no number, no Authority
  // website. Every check of that block is a check of a registered one.
  const registered = !!input.registrationNo;
  const ad = adOf(input.ad);
  const authority = ad?.authority ?? "RERA";
  const website = ad?.website ?? RERA_WEBSITE;
  const strip = ad?.placement === "BOTTOM_STRIP";
  // A QR is on the post where the state asks for one, and where the library
  // holds one for a state that does not; a bottom strip carries none.
  const wantsQr = registered && !strip && (ad?.qr === "REQUIRED" || input.qr.lockup);
  const moveBlock = `Move the QR code, the registration number and the ${authority} website into the upper-right quarter of the ad.`;
  if (wantsQr && f && input.qr.lockup && input.qr.expected) {
    if (!f.qrFound) {
      out.push({
        code: "QR_NOT_DRAWN",
        text: "The design left out the QR code.",
        fixable: true,
        fix: "The QR code was missing. Place it in the upper-right quarter, flat and straight, on a small plain white square.",
      });
    } else {
      if (!f.qrInQuadrant) {
        out.push({
          code: "RERA_POSITION",
          text: "The QR code is not in the top-right quarter.",
          fixable: true,
          fix: moveBlock,
        });
      }
      if (!f.qrBigEnough) {
        out.push({
          code: "QR_TOO_SMALL",
          text: "The QR code is too small to scan comfortably.",
          fixable: true,
          fix: "Make the QR code larger, clearly visible, while keeping it tidy.",
        });
      }
    }
  }
  if (f && f.logoSlot === false) {
    out.push({
      code: "LOGO_SLOT",
      text: "The design left no place for the logo.",
      fixable: true,
      soft: true,
      fix: "Leave the plain solid pure green rectangle where the logo goes.",
    });
  }

  if (!registered || !wantsQr) {
    // Nothing to scan and nothing to find: an exempt tower, or a state that
    // asks for no QR with none in the library.
  } else if (!input.qr.lockup) {
    out.push({ code: "NO_LOCKUP", text: "No approved RERA lockup, so the post has no QR code.", fixable: false });
  } else if (!input.qr.expected) {
    out.push({
      code: "LOCKUP_NO_QR",
      text: `The approved RERA lockup has no QR code that scans. Upload the real ${authority} QR.`,
      fixable: false,
    });
  } else if (input.qr.read !== input.qr.expected) {
    out.push({ code: "QR_UNREADABLE", text: "The QR code on the post does not scan.", fixable: false });
  }

  const r = input.review;
  if (!r) {
    out.push({ code: "NOT_CHECKED", text: "The post could not be checked.", fixable: false });
    return out;
  }

  if (input.registrationNo) {
    const want = input.registrationNo.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const seen = r.registration.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!seen.includes(want)) {
      out.push({
        code: "REG_UNREADABLE",
        text: "The RERA number cannot be read on the post.",
        fixable: !!f,
        fix: f ? `Write the registration line exactly: '${ad?.label ?? "RERA Reg. No."} ${input.registrationNo}'.` : undefined,
      });
    }
  }
  if (input.phone) {
    const want = digitsOf(input.phone).slice(-10);
    if (!digitsOf(r.phone).endsWith(want)) {
      out.push({
        code: "PHONE_UNREADABLE",
        text: "The phone number cannot be read on the post.",
        fixable: !!f,
        fix: f ? `Write the phone number exactly: '${input.phone}'.` : undefined,
      });
    }
  }
  if (f && registered) {
    if (!looseText(r.reraWebsite ?? "").includes(looseText(website))) {
      out.push({
        code: "RERA_WEBSITE",
        text: `The ${authority} website is missing.`,
        fixable: true,
        fix: `Write the ${authority} website exactly, next to the registration number: '${website}'.`,
      });
    }
    if (strip) {
      if (r.reraAtBottom === false) {
        out.push({
          code: "RERA_POSITION",
          text: "The RERA details are not in a strip along the bottom.",
          fixable: true,
          fix:
            `Put the registration number and the ${authority} website in one solid strip along the bottom edge, ` +
            "full width, bold, in a colour that contrasts with the picture.",
        });
      }
    } else if (r.reraTopRight === false && !out.some((p) => p.code === "RERA_POSITION")) {
      out.push({
        code: "RERA_POSITION",
        text: "The RERA details are not in the top-right quarter.",
        fixable: true,
        fix: moveBlock,
      });
    }
    if (r.reraTextLargeEnough === false) {
      out.push({
        code: "RERA_TEXT_SMALL",
        text: "The RERA number is smaller than the phone number.",
        fixable: true,
        fix:
          `Set the registration number and the ${authority} website distinctly larger and bolder than the phone number ` +
          "in the footnote: make the registration number clearly larger in type size than the contact phone number.",
      });
    }
    if (ad?.permitNo && input.permitNo) {
      const want = input.permitNo.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const seenAll = r.texts.join(" ").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!seenAll.includes(want)) {
        out.push({
          code: "PERMIT_MISSING",
          text: "The building permit number is missing.",
          fixable: true,
          fix: `Write the permit line exactly, under the registration number: 'Permit No. ${input.permitNo}'.`,
        });
      }
    }
  }
  if (registered && ad?.noTermsApply && r.texts.some((t) => /\bT\s*&\s*C\b|terms\s*(?:&|and)\s*conditions/i.test(t))) {
    out.push({
      code: "TERMS_APPLY",
      text: `${authority} does not allow "T&C apply" on an advertisement.`,
      fixable: true,
      fix: "Remove every mention of terms and conditions.",
    });
  }

  const seen = looseText(r.texts.join(" "));
  const missing = input.expected.filter((t) => !seen.includes(looseText(t)));
  if (missing.length) {
    // A letter off in a long line neither fails the post nor pays for
    // another drawing: it is usually a typo in the copy that both models
    // quietly corrected. A line missing, or wrong in a number, does both.
    const slip = missing.every((t) => nearLine(seen, looseText(t)));
    out.push(
      slip
        ? { code: "TEXT_WRONG", text: "A word of the copy came out a letter different.", fixable: false, soft: true }
        : {
            code: "TEXT_WRONG",
            text: "Some of the copy is missing or misspelt.",
            fixable: true,
            fix: `Set this text exactly, letter for letter: ${missing.map((t) => `'${t}'`).join(", ")}.`,
          },
    );
  }
  // A misspelt line is one problem, not two: text that is mostly the words
  // of a line that should be there is that line, badly set, not an addition.
  const allowed = looseText([...input.expected, ...input.allowed].join(" "));
  const words = new Set(allowed.split(" "));
  const extra = r.texts
    .map(looseText)
    .filter((t) => t && !allowed.includes(t))
    .filter((t) => {
      const ws = t.split(" ");
      // A number nobody cleared is always an addition, however much of the
      // line around it is familiar: "Sea facing homes from Rs 45 lakh".
      if (ws.some((w) => /\p{N}/u.test(w) && !words.has(w))) return true;
      return ws.filter((w) => words.has(w)).length / ws.length < 0.5;
    });
  if (extra.length) {
    // Construction photos print real site words (crane marks, painted floor
    // numbers, safety boards). Treating those as invented copy burned every
    // attempt on slide 5 of a timeline carousel. Soft on a site scene: the
    // copy gate still refuses a made-up price on the card before anything is
    // drawn.
    const onSite = input.scene === "site";
    out.push({
      code: "EXTRA_TEXT",
      text: onSite
        ? "Words in the site photograph were read as extra; they do not stop this slide."
        : "The design added words nobody cleared.",
      fixable: !onSite,
      soft: onSite,
      ...(onSite
        ? {}
        : { fix: "Remove every word that was not asked for. Set only the text given, nothing else." }),
    });
  }
  if (r.textCutOff) {
    out.push({
      code: "TEXT_CUT",
      text: "Some text is cut off or covered.",
      fixable: true,
      fix: "Keep all text well inside the safe area, fully visible, clear of the corners and the bottom strip.",
    });
  }
  const isNonBuildingRef =
    (input.scene && input.scene !== "exterior") ||
    (!!r.buildingIssues &&
      /\b(?:placeholder|blank|swatch|title slide|no building|does not show (?:the|a) building|not a building)\b/i.test(
        r.buildingIssues,
      ));
  if (!r.buildingMatches && !isNonBuildingRef) {
    // Our sentence, not the checker's: its description of what changed ("two
    // extra floors") reads to a drawing model much like a request for them.
    out.push({
      code: "BUILDING_CHANGED",
      text: "The building does not match the approved photo.",
      fixable: true,
      fix:
        "The building was altered. Copy it exactly from the approved photograph: the same outline, floor count, " +
        "windows, balconies, materials and colours, from the same viewpoint.",
    });
  }
  if (!r.looksLikeAd) {
    out.push({
      code: "DESIGN_WEAK",
      text: "The design does not look like a finished ad.",
      fixable: true,
      fix: `Make it look like a polished, premium advertisement. ${cleanFix(r.designIssues)}`.trim(),
    });
  }
  if (registered && r.panelCoversContent) {
    out.push({
      code: "LOCKUP_COVERS",
      text: "The RERA panel covers part of the design.",
      fixable: true,
      fix: f
        ? "The registration block sat on something important. Put it on a calm part of the upper-right quarter, off the " +
          "building, faces and text."
        : "The white box for the registration panel has moved. Leave it empty and keep the building, people and all " +
          "text clear of it, with calm background around it.",
    });
  }
  return out;
}

/**
 * Labels an ad carries that claim nothing about the property: the words
 * around a phone number, a website and a registration block. A design that
 * writes "Call us" above the number has not invented anything, and treating
 * it as extra text would refuse every well-laid-out contact strip.
 */
export const NEUTRAL_LABELS: readonly string[] = [
  ...allRegistrationLabels(), "Permit No.", "RERA Registered", "RERA Registered Information",
  "RERA", "MahaRERA", "MahaRERA Reg. No.", "MahaRERA No.", "Reg. No.", "Reg.", "No.",
  "Call", "Call us", "Call now", "Contact", "Contact us", "More information",
  "For more information", "For enquiries", "Enquire now", "Website", "Our website", "Visit", "Visit us",
  "Scan", "Scan to verify", "Scan for details", "T&C apply", "Terms and conditions apply",
  "Slide", "Milestone", "Phase", "Step", "Progress",
  "Apex Advisory", "Mandate Partners", "Apex", "Advisory", "Mandate", "Partners",
];

/**
 * The fixes to send with the next attempt. Our own words about the copy may
 * quote it, digits included, because the copy cleared; the checker's words
 * never carry a digit, which `cleanFix()` already saw to.
 */
export function fixesFrom(problems: readonly DesignProblem[]): string[] {
  return problems.filter((p) => p.fixable && p.fix).map((p) => p.fix!);
}

/**
 * Which of two attempts to keep: fewer problems that fail a post, then fewer
 * the model caused, then fewer overall. Ties keep the earlier.
 */
export function betterDesign<T extends { problems: readonly DesignProblem[] }>(a: T | null, b: T): T {
  if (!a) return b;
  const failing = (x: T) => x.problems.filter((p) => !p.soft).length;
  if (failing(b) !== failing(a)) return failing(b) < failing(a) ? b : a;
  const fixable = (x: T) => x.problems.filter((p) => p.fixable).length;
  if (fixable(b) !== fixable(a)) return fixable(b) < fixable(a) ? b : a;
  return b.problems.length < a.problems.length ? b : a;
}

/** Whether another attempt could help: something is wrong that the model can fix. */
export function worthRedesigning(problems: readonly DesignProblem[]): boolean {
  return problems.some((p) => p.fixable);
}
