/**
 * The campaign brief, decided without a database.
 *
 * A brief is the job: who this push is for, in which languages and formats,
 * and what the reader is meant to do. It is not the Project Brain. The Brain
 * carries facts that were signed and may be quoted; the brief carries the
 * instruction that decides which of those facts get quoted and to whom.
 *
 * What lives here is the catalog, the parsing, and the answer to "can this
 * brief be handed over". Kept database-free so `npm run check:logic`
 * exercises it directly.
 *
 * Imports are relative because the checks load this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

import type { ScopeKind } from "./roles.ts";

// ---------------------------------------------------------------------------
// The catalogs
// ---------------------------------------------------------------------------

export type Objective = "LEAD_FORM" | "WHATSAPP" | "SITE_VISIT" | "CP_LINK" | "AWARENESS";

/**
 * What the reader is meant to do next.
 *
 * One objective per brief, not a set. A creative that asks for a form fill
 * and a WhatsApp message and a site visit booking asks for nothing, and the
 * channel routing downstream has to resolve to a single destination anyway.
 */
export const OBJECTIVES: { key: Objective; label: string; detail: string }[] = [
  { key: "LEAD_FORM", label: "Lead form", detail: "An instant form on Meta or a landing page." },
  { key: "WHATSAPP", label: "WhatsApp message", detail: "The buyer opens a chat with the bot." },
  { key: "SITE_VISIT", label: "Site visit booking", detail: "Straight to a slot on the visit calendar." },
  { key: "CP_LINK", label: "Channel partner link", detail: "A co-branded page the partner owns." },
  { key: "AWARENESS", label: "Awareness", detail: "Reach and recall, with no form to fill." },
];

/**
 * The languages creative can be rendered in.
 *
 * Kept to the scripts the type stack has tested fallbacks for. A language
 * nobody can set is not a choice, it is a defect waiting for a launch.
 *
 * Each is written in its own script and nothing else: an image ad is all
 * English or all Hindi, never a mixture. Hinglish (Hindi in English letters)
 * was taken off on 1 October 2026 for that reason (the client); it lives on
 * in the story reels' captions, which are made apart from the cards.
 */
export const LANGUAGES = [
  "English",
  // English only for now (the client, 9 October 2026): cards, posts,
  // carousels and videos are written in English and nothing else. The other
  // languages are switched off here, not removed; put a line back to offer
  // it again.
  // "Hindi",
  // "Marathi",
  // "Gujarati",
  // "Tamil",
  // "Telugu",
  // "Kannada",
  // "Bengali",
] as const;

/**
 * A brief's languages as the catalog offers them today. A brief saved with
 * Hindi keeps it in its row; it is read past here, so nothing is written in
 * it and no card in it is offered, until the language is switched on again.
 */
export function activeLanguages(chosen: readonly string[] | null | undefined): string[] {
  return pickFrom(LANGUAGES, chosen ?? []);
}

/**
 * The placements a variant is laid out for.
 *
 * Every ratio re-measures the RERA lockup's quadrant, which is why the list
 * is a fixed set and not free text: a format nothing can measure is a format
 * nothing can clear.
 */
export const FORMATS = [
  "Meta feed 1:1",
  "Meta story 9:16",
  "Meta reel 9:16",
  "Google display",
  "YouTube 16:9",
  "Portal listing",
] as const;

/**
 * Where the message leads from.
 *
 * Suggestions, never a closed list. A developer whose whole pitch is the
 * school two lanes away has a hook nobody here thought of, and a fixed list
 * would make them pick the nearest wrong one. The screen shows these as
 * one-click chips beside a free text box, so that both are visibly true.
 */
export const HOOKS = [
  "Metro and connectivity",
  "Lifestyle and amenities",
  "Family and schools",
  "Investment and yield",
  "Affordability",
  "Launch urgency",
] as const;

/** A brief hangs off the node a campaign is actually run for. */
export const BRIEF_KINDS: ScopeKind[] = ["PROJECT", "PHASE"];

export function briefFitsNode(kind: ScopeKind): boolean {
  return BRIEF_KINDS.includes(kind);
}

// ---------------------------------------------------------------------------
// The shape of a brief
// ---------------------------------------------------------------------------

export type BriefStatus = "DRAFT" | "READY";

export type Brief = {
  name: string;
  status: BriefStatus;
  objective: Objective | null;
  audience: string | null;
  microMarkets: string[];
  languages: string[];
  formats: string[];
  /**
   * Which configurations this push is for.
   *
   * Empty means every one the node sells, which is what every brief written
   * before this existed meant. Ids rather than labels, because the price a
   * refusal is measured against belongs to one row on one tower and a label
   * is the same string in nine of them.
   */
  unitTypeIds: string[];
  cta: string | null;
  hook: string | null;
  offers: string | null;
};

/** A blank brief, so a new one and a loaded one are the same shape. */
export function emptyBrief(name = ""): Brief {
  return {
    name,
    status: "DRAFT",
    objective: null,
    audience: null,
    microMarkets: [],
    languages: [],
    formats: [],
    unitTypeIds: [],
    cta: null,
    hook: null,
    offers: null,
  };
}

// ---------------------------------------------------------------------------
// Reading what a person typed
// ---------------------------------------------------------------------------

/** Trim to a value or to nothing. An empty box is not an empty string. */
export function textOrNull(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  return v.length ? v : null;
}

/**
 * One per line, blanks dropped, order kept, duplicates collapsed.
 *
 * Order is kept because a marketer lists micro-markets in priority order and
 * sorting them alphabetically would silently rewrite that.
 */
export function asLines(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const v = line.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Keep only what the catalog knows, in catalog order.
 *
 * The form is never believed: a checkbox list posts whatever the page said it
 * held, and a renamed language arriving from a stale tab would otherwise be
 * stored as a language the renderer cannot set.
 */
export function pickFrom(allowed: readonly string[], chosen: readonly string[]): string[] {
  const want = new Set(chosen.map((c) => c.trim()));
  return allowed.filter((a) => want.has(a));
}

export function isObjective(raw: string | null | undefined): raw is Objective {
  return OBJECTIVES.some((o) => o.key === raw);
}

export function objectiveLabel(key: string | null): string | null {
  return OBJECTIVES.find((o) => o.key === key)?.label ?? null;
}

// ---------------------------------------------------------------------------
// References: the examples a brief points at
// ---------------------------------------------------------------------------

export type ReferenceKind = "WORKED" | "AVOID";

/**
 * Two lists, not one with a flag.
 *
 * A generator reads these as opposite instructions, so a reference filed
 * under the wrong one does not degrade the output, it inverts it.
 */
export const REFERENCE_KINDS: { key: ReferenceKind; label: string; add: string }[] = [
  { key: "WORKED", label: "What has worked", add: "Add something that worked" },
  { key: "AVOID", label: "What to avoid", add: "Add something to avoid" },
];

export function isReferenceKind(raw: string | null | undefined): raw is ReferenceKind {
  return REFERENCE_KINDS.some((k) => k.key === raw);
}

/**
 * What may be uploaded.
 *
 * SVG is deliberately absent. It renders as a document rather than a picture
 * and can carry script, and the route serves this inline.
 */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/**
 * Video, uploaded rather than linked.
 *
 * The link box that used to sit beside this collected the wrong thing. Asked
 * for the post that worked, a person pastes the address of the post: a Meta
 * permalink, a LinkedIn update, a YouTube watch page. Every one of those is
 * an HTML page behind a login, not media, and expecting somebody filling a
 * form to tell a page URL from a media URL is expecting them to think like
 * the code.
 */
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

export const MEDIA_TYPES = [...IMAGE_TYPES, ...VIDEO_TYPES] as const;

/**
 * 25 MB, which covers a 30 second reel at sensible quality.
 *
 * It is also a memory bound and not only a storage one: a server action
 * buffers the whole body before any rule here sees it.
 */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export function isImageType(raw: string | null | undefined): boolean {
  return IMAGE_TYPES.includes((raw ?? "") as (typeof IMAGE_TYPES)[number]);
}

export function isVideoType(raw: string | null | undefined): boolean {
  return VIDEO_TYPES.includes((raw ?? "") as (typeof VIDEO_TYPES)[number]);
}

export function isMediaType(raw: string | null | undefined): boolean {
  return isImageType(raw) || isVideoType(raw);
}

export type ReferenceInput = {
  mediaType: string | null;
  mediaBytes: number;
};

export type ReferenceCheck =
  | { ok: true }
  | { ok: false; code: "NO_FILE" | "MEDIA_TYPE" | "MEDIA_TOO_BIG"; message: string };

/**
 * May this reference be filed.
 *
 * A reference IS its media. A note on its own is a sentence in a brief, not
 * an example of anything, so the file is what this asks about first.
 *
 * Kept pure and given the type and size rather than the file, so the rule is
 * exercised by `check:logic` without a multipart request.
 */
export function canAddReference(input: ReferenceInput): ReferenceCheck {
  if (input.mediaBytes <= 0) {
    return { ok: false, code: "NO_FILE", message: "Choose an image or a video to upload." };
  }
  if (!isMediaType(input.mediaType)) {
    return {
      ok: false,
      code: "MEDIA_TYPE",
      message: "That file is not an image or a video. JPG, PNG, GIF, WebP, MP4, MOV and WebM work.",
    };
  }
  if (input.mediaBytes > MAX_MEDIA_BYTES) {
    return {
      ok: false,
      code: "MEDIA_TOO_BIG",
      message: "That file is over 25 MB. Trim the clip or export it smaller.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Is this brief finished
// ---------------------------------------------------------------------------

export type BriefField = "objective" | "audience" | "languages" | "formats" | "cta";

const REQUIRED: { key: BriefField; label: string }[] = [
  { key: "objective", label: "Objective" },
  { key: "audience", label: "Audience" },
  { key: "languages", label: "Languages" },
  { key: "formats", label: "Formats" },
  { key: "cta", label: "Call to action" },
];

/**
 * What is still missing before this brief could be handed to a generator.
 *
 * Returned as a list rather than a boolean so the screen can name the gaps
 * instead of showing a disabled button with no explanation. Micro-markets,
 * hook, competitors and offers are deliberately absent: a brief with no
 * micro-market runs against the whole city, which is a real choice.
 */
export function briefGaps(brief: Brief): { key: BriefField; label: string }[] {
  return REQUIRED.filter((f) => {
    const v = brief[f.key];
    return Array.isArray(v) ? v.length === 0 : !v;
  });
}

export type ReadyCheck =
  | { ok: true }
  | { ok: false; code: "INCOMPLETE"; message: string };

/**
 * May this brief be marked ready.
 *
 * "Ready" is a marketer saying the job is fully specified, and the only thing
 * that can contradict them is a required field nobody filled in. It does not
 * ask the RERA gate or the Brain: a brief is an instruction, and it is the
 * generated creative that has to clear Section 3, not the sentence asking for
 * it. That check belongs at the point a pixel is drawn, which is not built.
 */
export function canMarkReady(brief: Brief): ReadyCheck {
  const gaps = briefGaps(brief);
  if (gaps.length) {
    return {
      ok: false,
      code: "INCOMPLETE",
      message: `${gaps.map((g) => g.label).join(", ")} still needs filling in.`,
    };
  }
  return { ok: true };
}

/** A one-line summary for a list row. */
export function briefLine(brief: Brief): string {
  const bits: string[] = [];
  const objective = objectiveLabel(brief.objective);
  if (objective) bits.push(objective);
  const many = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  if (brief.languages.length) bits.push(many(brief.languages.length, "language"));
  if (brief.formats.length) bits.push(many(brief.formats.length, "format"));
  return bits.length ? bits.join(" · ") : "Nothing filled in yet";
}
