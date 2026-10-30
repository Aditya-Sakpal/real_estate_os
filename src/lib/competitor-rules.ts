/**
 * Reading a competitor's ad into the ingredients our own are scored by.
 * Pure and database-free, covered by `check:logic`.
 *
 * Four rules.
 *
 * 1. **A person saves it; nothing is collected by machine.** There is no
 *    API for Indian commercial ads on Meta or Google (their libraries'
 *    APIs cover political ads outside the EU), and Meta's terms forbid
 *    collecting from its products by machine, which would put every Meta
 *    connection of ours at risk. So an ad arrives because somebody saw it.
 * 2. **A model reads it; code decides what it means.** The reader answers
 *    in a fixed schema whose every value is one of our vocabulary's, and
 *    `readingOf()` refuses anything outside it rather than guessing.
 * 3. **A claim we may not make keeps the ad out of the scores.** "Assured
 *    returns" in a competitor's ad is their exposure, not a pattern to
 *    follow. The reader names such claims and a fixed test catches the
 *    common ones in the words it read.
 * 4. **Reads are capped per project per month, before the model is paid**
 *    (`COMPETITOR_CAPS`), pictures and videos apart, because a video costs
 *    about three times a picture.
 */

import {
  AD_LANGUAGES,
  ANGLES,
  FORMATS,
  HOOKS,
  PICTURES,
  templateValue,
  type Ingredients,
} from "./learning-rules.ts";

export const PLATFORMS = ["META", "GOOGLE", "YOUTUBE", "PORTAL", "PRINT", "OTHER"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  META: "Facebook or Instagram",
  GOOGLE: "Google",
  YOUTUBE: "YouTube",
  PORTAL: "Property portal",
  PRINT: "Print or hoarding",
  OTHER: "Somewhere else",
};

export type AdKind = (typeof FORMATS)[number];

/** Per project, per month in India. A read that failed was still paid for, so it counts. */
export const COMPETITOR_CAPS = { pictures: 60, videos: 20 } as const;

/** What one read costs us, estimated, in dollars: `gpt-5-mini` on a picture; three frames and the sound for a video. */
export const READ_COST_USD = { picture: 0.006, video: 0.02 } as const;

export const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

/** Why a file cannot be read as a competitor's ad, or null. */
export function fileProblem(file: { type: string; size: number }): string | null {
  if ((PICTURE_TYPES as readonly string[]).includes(file.type)) {
    return file.size > MAX_PICTURE_BYTES ? "A picture can be up to 5 MB." : null;
  }
  if ((VIDEO_TYPES as readonly string[]).includes(file.type)) {
    return file.size > MAX_VIDEO_BYTES ? "A video can be up to 25 MB." : null;
  }
  return "Choose a PNG, JPEG or WebP picture, or an MP4, MOV or WebM video.";
}

/** Whether another read of this kind fits this month. */
export function capProblem(kind: "picture" | "video", used: number): string | null {
  const cap = kind === "video" ? COMPETITOR_CAPS.videos : COMPETITOR_CAPS.pictures;
  if (used < cap) return null;
  return kind === "video"
    ? `This project has read ${cap} competitor videos this month, the most a month allows.`
    : `This project has read ${cap} competitor pictures this month, the most a month allows.`;
}

/** Claims no ad of ours may make. Found in a competitor's words, they keep the ad out of the scores. */
const RISKY =
  /\b(assured|guaranteed?|fixed)\s+(returns?|rental|income|appreciation)|\brental (guarantee|assurance)\b|\bdouble your (money|investment)\b|\bbest investment\b|\b100% (safe|secure|returns?)\b|\bno risk\b/i;

export function riskyClaims(text: string | null | undefined): string[] {
  const m = (text ?? "").match(RISKY);
  return m ? [m[0].toLowerCase()] : [];
}

/** The reader's instruction. It describes; it is never asked whether an ad is good. */
export function readerInstruction(designs: readonly { key: string; label: string }[]): string {
  return [
    "You read one real estate advertisement from India and describe it in a fixed vocabulary.",
    "Report only what is visible or audible. Never guess a price or a place you cannot see or hear.",
    "text_seen: every word printed on the ad, and for a video what is said, in the original language, one line per group.",
    "angle: what the ad leads with. CONNECTIVITY (where it is, travel times, metro, roads), VIEW, SPACE (acres, open space, greenery),",
    "AMENITY (clubhouse, pool, gym), PRICE, OFFER (a scheme, waiver, discount or payment plan), TRUST (the developer's record), OTHER.",
    "hook: the kind of first line: QUESTION, NUMBER, BENEFIT, OFFER, EMOTION or STATEMENT.",
    "picture: what the main picture shows: EXTERIOR, AMENITY, INTERIOR, VIEW, CONSTRUCTION, MAP, PEOPLE, GRAPHIC or OTHER.",
    "language: the ad's main language: en, hi, mr, hinglish (Hindi in Latin letters), gu, ta, te, kn or other.",
    "price_shown: true when a price is printed or said. price_from_rupees: the lowest price named, in rupees, or null.",
    "festive: true when the ad is built around a festival.",
    `design: the closest of these design styles, or null: ${designs.map((d) => `${d.key} (${d.label})`).join("; ")}.`,
    "locality: the locality the ad names, or null.",
    "risky_claims: any promise of returns, rental income, appreciation or safety of money, word for word; otherwise an empty list.",
  ].join("\n");
}

/** The reader's answer, strict. */
export function readerSchema(designKeys: readonly string[]): Record<string, unknown> {
  const nullableEnum = (values: readonly string[]) => ({ type: ["string", "null"], enum: [...values, null] });
  return {
    type: "object",
    additionalProperties: false,
    required: ["text_seen", "angle", "hook", "picture", "language", "price_shown", "price_from_rupees", "festive", "design", "locality", "risky_claims"],
    properties: {
      text_seen: { type: "string" },
      angle: { type: "string", enum: [...ANGLES] },
      hook: { type: "string", enum: [...HOOKS] },
      picture: { type: "string", enum: [...PICTURES] },
      language: { type: "string", enum: [...AD_LANGUAGES] },
      price_shown: { type: "boolean" },
      price_from_rupees: { type: ["number", "null"] },
      festive: { type: "boolean" },
      design: nullableEnum(designKeys),
      locality: { type: ["string", "null"] },
      risky_claims: { type: "array", items: { type: "string" } },
    },
  };
}

export type Reading = {
  textSeen: string;
  tags: Ingredients & { locality?: string | null; priceFrom?: number | null };
  flags: string[];
};

const oneOf = <T extends string>(values: readonly T[], v: unknown): T | null =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : null;

/**
 * The reader's answer as ingredients, or null when it is not the agreed
 * shape. A value outside the vocabulary is refused, never mapped to the
 * nearest one.
 */
export function readingOf(answer: unknown, kind: AdKind, designKeys: readonly string[]): Reading | null {
  const a = (answer ?? {}) as Record<string, unknown>;
  const angle = oneOf(ANGLES, a.angle);
  const hook = oneOf(HOOKS, a.hook);
  const picture = oneOf(PICTURES, a.picture);
  const language = oneOf(AD_LANGUAGES, a.language);
  if (!angle || !hook || !picture || !language || typeof a.price_shown !== "boolean" || typeof a.festive !== "boolean") return null;
  const design = oneOf(designKeys, a.design);
  const text = typeof a.text_seen === "string" ? a.text_seen.trim().slice(0, 4000) : "";
  const price = typeof a.price_from_rupees === "number" && Number.isFinite(a.price_from_rupees) && a.price_from_rupees > 0
    ? Math.round(a.price_from_rupees)
    : null;
  const claims = Array.isArray(a.risky_claims) ? a.risky_claims.filter((c): c is string => typeof c === "string" && !!c.trim()) : [];
  const flags = [...new Set([...claims.map((c) => c.trim().toLowerCase().slice(0, 80)), ...riskyClaims(text)])].slice(0, 5);
  return {
    textSeen: text,
    tags: {
      angle,
      hook,
      picture,
      language,
      format: kind,
      price: a.price_shown ? "SHOWN" : "NOT_SHOWN",
      occasion: a.festive ? "FESTIVE" : "NONE",
      template: templateValue(kind, design),
      locality: typeof a.locality === "string" && a.locality.trim() ? a.locality.trim().slice(0, 120) : null,
      priceFrom: price,
    },
    flags,
  };
}

/** Where in a video the reader looks: the start, the middle and near the end. */
export function frameTimes(seconds: number | null): number[] {
  const d = seconds && seconds > 0 ? seconds : 15;
  return [Math.min(1, d / 4), d / 2, Math.max(0, d - 1)];
}

/** What a person typed about the ad, cleaned, or why it will not do. */
export function readForm(input: {
  competitor: string;
  projectName: string;
  locality: string;
  platform: string;
  runningSince: string;
  today: string;
}): { ok: true; value: { competitor: string; projectName: string | null; locality: string | null; platform: Platform; runningSince: string | null } } | { ok: false; message: string } {
  const competitor = input.competitor.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!competitor) return { ok: false, message: "Name the developer whose ad this is." };
  if (/^[=+\-@]/.test(competitor)) return { ok: false, message: "Name the developer whose ad this is." };
  const platform = oneOf(PLATFORMS, input.platform);
  if (!platform) return { ok: false, message: "Choose where you saw it." };
  const since = input.runningSince.trim();
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return { ok: false, message: "Pick the date it started running." };
  if (since && since > input.today) return { ok: false, message: "The date it started running can't be in the future." };
  const clean = (s: string) => s.trim().replace(/\s+/g, " ").replace(/^[=+\-@]+/, "").slice(0, 120) || null;
  return { ok: true, value: { competitor, projectName: clean(input.projectName), locality: clean(input.locality), platform, runningSince: since || null } };
}
