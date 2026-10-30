/**
 * The pure half of the Meta and Google connectors.
 *
 * Which accounts exist, which post goes where, what a caption says, how money
 * is written for each platform, how a refusal from somebody else's server is
 * read, and how the OAuth round trip proves it came back to the person who
 * started it. No database and no network, so `check:logic` covers all of it.
 *
 * `connect.ts` holds the connections, `meta.ts` and `google.ts` speak to the
 * platforms, and `publish.ts` decides what goes out and records it.
 *
 * Imports are relative because the checks load this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PostKind } from "./compose-rules.ts";
import { priceNoteFor } from "./creative-rules.ts";
import { adRegistrationLine, adRuleFor, agentLine } from "./rera-ad-rules.ts";

// ---------------------------------------------------------------------------
// Providers, accounts and destinations
// ---------------------------------------------------------------------------

export type Provider = "META" | "GOOGLE";

export const PROVIDERS: { key: Provider; label: string; detail: string }[] = [
  {
    key: "META",
    label: "Meta",
    detail: "Facebook Page, Instagram and the Meta ad account.",
  },
  {
    key: "GOOGLE",
    label: "Google",
    detail: "Google Ads and the Google Business Profile.",
  },
];

export function isProvider(raw: string | null | undefined): raw is Provider {
  return raw === "META" || raw === "GOOGLE";
}

/** The URL segment for a provider, and back. */
export const providerSlug = (p: Provider) => p.toLowerCase();
export function providerFromSlug(slug: string | null | undefined): Provider | null {
  const up = (slug ?? "").toUpperCase();
  return isProvider(up) ? up : null;
}

export type AccountKind =
  | "FACEBOOK_PAGE"
  | "INSTAGRAM"
  | "META_AD_ACCOUNT"
  | "META_DATASET"
  | "GOOGLE_ADS_CUSTOMER"
  | "GOOGLE_BUSINESS_LOCATION";

export const ACCOUNT_KINDS: { key: AccountKind; provider: Provider; label: string }[] = [
  { key: "FACEBOOK_PAGE", provider: "META", label: "Facebook Page" },
  { key: "INSTAGRAM", provider: "META", label: "Instagram account" },
  { key: "META_AD_ACCOUNT", provider: "META", label: "Meta ad account" },
  // Where outcomes (a qualified buyer, a visit, a booking) are sent back to.
  { key: "META_DATASET", provider: "META", label: "Meta dataset" },
  { key: "GOOGLE_ADS_CUSTOMER", provider: "GOOGLE", label: "Google Ads account" },
  { key: "GOOGLE_BUSINESS_LOCATION", provider: "GOOGLE", label: "Business Profile" },
];

export function isAccountKind(raw: string | null | undefined): raw is AccountKind {
  return ACCOUNT_KINDS.some((k) => k.key === raw);
}

export const accountKindLabel = (k: string) =>
  ACCOUNT_KINDS.find((a) => a.key === k)?.label ?? k;

/**
 * One account a person may pick after consenting. Names and ids only: a
 * Page's own token is fetched when it is chosen, never parked in a list.
 */
export type Choice = {
  kind: AccountKind;
  id: string;
  name: string;
  detail: Record<string, string | null>;
};

export function isChoice(raw: unknown): raw is Choice {
  const c = raw as Choice;
  return !!c && isAccountKind(c.kind) && typeof c.id === "string" && typeof c.name === "string";
}

export type Destination =
  | "FACEBOOK_PAGE"
  | "INSTAGRAM"
  | "META_AD"
  | "GOOGLE_DISPLAY_AD"
  | "GOOGLE_BUSINESS"
  | "GOOGLE_SEARCH_AD"
  | "GOOGLE_PMAX_AD"
  | "GOOGLE_DEMAND_GEN_AD";

export type DestinationDef = {
  key: Destination;
  provider: Provider;
  account: AccountKind;
  /** An organic post goes up at once; an ad is created paused. */
  mode: "ORGANIC" | "AD";
  label: string;
};

export const DESTINATIONS: DestinationDef[] = [
  { key: "FACEBOOK_PAGE", provider: "META", account: "FACEBOOK_PAGE", mode: "ORGANIC", label: "Facebook Page" },
  { key: "INSTAGRAM", provider: "META", account: "INSTAGRAM", mode: "ORGANIC", label: "Instagram" },
  { key: "META_AD", provider: "META", account: "META_AD_ACCOUNT", mode: "AD", label: "Meta ad" },
  { key: "GOOGLE_DISPLAY_AD", provider: "GOOGLE", account: "GOOGLE_ADS_CUSTOMER", mode: "AD", label: "Google display ad" },
  { key: "GOOGLE_BUSINESS", provider: "GOOGLE", account: "GOOGLE_BUSINESS_LOCATION", mode: "ORGANIC", label: "Business Profile" },
  // Demand Gen shows a post on YouTube, Discover and Gmail; a video post runs
  // on YouTube only, which is where a YouTube ad now lives.
  { key: "GOOGLE_DEMAND_GEN_AD", provider: "GOOGLE", account: "GOOGLE_ADS_CUSTOMER", mode: "AD", label: "Google Demand Gen ad" },
  // These two are campaigns, not posts: one per brief, built from its cleared
  // copy and passed pictures, running until somebody stops it.
  { key: "GOOGLE_SEARCH_AD", provider: "GOOGLE", account: "GOOGLE_ADS_CUSTOMER", mode: "AD", label: "Google Search ad" },
  { key: "GOOGLE_PMAX_AD", provider: "GOOGLE", account: "GOOGLE_ADS_CUSTOMER", mode: "AD", label: "Google Performance Max" },
];

/**
 * Campaigns that belong to a brief rather than to a post. Search answers
 * what buyers type and Performance Max spreads one bundle across every Google
 * surface; neither changes three times a week, so neither sits on a calendar.
 */
export const ALWAYS_ON: Destination[] = ["GOOGLE_SEARCH_AD", "GOOGLE_PMAX_AD"];
export const isAlwaysOn = (d: Destination) => ALWAYS_ON.includes(d);

/** Where a single post can be published: everything but the brief's campaigns. */
export const POST_DESTINATIONS: Destination[] = [
  "FACEBOOK_PAGE",
  "INSTAGRAM",
  "META_AD",
  "GOOGLE_DISPLAY_AD",
  "GOOGLE_DEMAND_GEN_AD",
  "GOOGLE_BUSINESS",
];

// ---------------------------------------------------------------------------
// What a Meta ad is for
// ---------------------------------------------------------------------------

export type AdGoal = "LEADS" | "WHATSAPP" | "TRAFFIC" | "AWARENESS";

export const AD_GOALS: { key: AdGoal; label: string; detail: string }[] = [
  { key: "LEADS", label: "Lead form", detail: "Buyers leave their number without leaving Facebook or Instagram" },
  { key: "WHATSAPP", label: "WhatsApp chats", detail: "The button opens a chat with your WhatsApp number" },
  { key: "TRAFFIC", label: "Website visits", detail: "Clicks to your project page" },
  { key: "AWARENESS", label: "Reach", detail: "Seen by as many people nearby as possible" },
];

export const isAdGoal = (raw: unknown): raw is AdGoal => AD_GOALS.some((g) => g.key === raw);
export const adGoalLabel = (g: string | null | undefined) => AD_GOALS.find((x) => x.key === g)?.label ?? null;

/**
 * Why a goal cannot be chosen for this project, or null. A lead form needs
 * the Page it is filed under and the developer's privacy policy; a WhatsApp
 * ad needs the developer's own connected number.
 */
export function goalProblem(
  goal: AdGoal,
  has: { page: boolean; privacyUrl: boolean; whatsappNumber: boolean },
): string | null {
  if (!has.page) return "A Meta ad needs a Facebook Page to speak as. Choose one in Settings, Connected accounts.";
  if (goal === "LEADS" && !has.privacyUrl) return "A lead form needs your privacy policy link. Add it in Library, Branding.";
  if (goal === "WHATSAPP" && !has.whatsappNumber) return "Connect your WhatsApp number in Settings, Connected accounts first.";
  return null;
}

/** The goal offered first: a lead form when it can be made, else website visits. */
export function defaultGoal(has: { page: boolean; privacyUrl: boolean; whatsappNumber: boolean }): AdGoal {
  return goalProblem("LEADS", has) ? "TRAFFIC" : "LEADS";
}

export function isDestination(raw: string | null | undefined): raw is Destination {
  return DESTINATIONS.some((d) => d.key === raw);
}

export function destinationDef(d: Destination): DestinationDef {
  return DESTINATIONS.find((x) => x.key === d)!;
}

export const isAd = (d: Destination) => destinationDef(d).mode === "AD";

/**
 * Where a schedule may send its approved posts organically. These are the
 * boxes on the schedule form.
 */
export const SCHEDULE_DESTINATIONS: Destination[] = ["FACEBOOK_PAGE", "INSTAGRAM", "GOOGLE_BUSINESS"];

/**
 * Where a schedule may run its ads: Meta, and Google Demand Gen, which takes
 * the one square picture, carousel or video a run makes. A Google display ad
 * is made from a banner and a square of the same card, which a run does not
 * make, and Search and Performance Max run from the brief, not a calendar.
 * The spend was decided on the schedule, by somebody holding the budget key,
 * with a daily budget and a length in front of them.
 */
export const SCHEDULE_AD_DESTINATIONS: Destination[] = ["META_AD", "GOOGLE_DEMAND_GEN_AD"];

export function pickScheduleDestinations(raw: readonly string[]): Destination[] {
  const wanted = new Set(raw);
  return [...SCHEDULE_DESTINATIONS, ...SCHEDULE_AD_DESTINATIONS].filter((d) => wanted.has(d));
}

// ---------------------------------------------------------------------------
// What each provider is asked for
// ---------------------------------------------------------------------------

/**
 * Meta's permissions, each for one job. `ads_management` is the one App
 * Review scrutinises; the Page and Instagram pairs publish organic posts.
 */
export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "ads_management",
  "ads_read",
  "business_management",
  // Lead forms: read the answers, and subscribe the Page so Meta sends them.
  "leads_retrieval",
  "pages_manage_metadata",
  "pages_manage_ads",
] as const;

/** What each destination cannot work without. */
export const META_NEEDS: Record<"FACEBOOK_PAGE" | "INSTAGRAM" | "META_AD", readonly string[]> = {
  FACEBOOK_PAGE: ["pages_show_list", "pages_manage_posts"],
  INSTAGRAM: ["instagram_basic", "instagram_content_publish"],
  META_AD: ["ads_management"],
};

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const GOOGLE_ADS_SCOPE_URL = "https://www.googleapis.com/auth/adwords";
export const GOOGLE_BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";
/** Sending outcomes to Google Ads. The old offline upload is closed to projects that never used it. */
export const GOOGLE_DATA_MANAGER_SCOPE = "https://www.googleapis.com/auth/datamanager";

/** Uploading a video to the developer's own YouTube channel, unlisted, so Demand Gen can show it. */
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/adwords",
  "https://www.googleapis.com/auth/business.manage",
] as const;

export const GOOGLE_NEEDS: Record<
  "GOOGLE_DISPLAY_AD" | "GOOGLE_BUSINESS" | "GOOGLE_SEARCH_AD" | "GOOGLE_PMAX_AD" | "GOOGLE_DEMAND_GEN_AD",
  readonly string[]
> = {
  GOOGLE_DISPLAY_AD: [GOOGLE_ADS_SCOPE_URL],
  GOOGLE_BUSINESS: ["https://www.googleapis.com/auth/business.manage"],
  GOOGLE_SEARCH_AD: [GOOGLE_ADS_SCOPE_URL],
  GOOGLE_PMAX_AD: [GOOGLE_ADS_SCOPE_URL],
  GOOGLE_DEMAND_GEN_AD: [GOOGLE_ADS_SCOPE_URL],
};

/** A video ad on Google is a YouTube video, so it needs the upload permission too. */
export function youtubeAllowed(granted: readonly string[]): boolean {
  return granted.includes(YOUTUBE_UPLOAD_SCOPE);
}

export function missingScopes(granted: readonly string[], wanted: readonly string[]): string[] {
  const have = new Set(granted);
  return wanted.filter((s) => !have.has(s));
}

/** Whether a connection's granted scopes cover one destination. */
export function scopesCover(destination: Destination, granted: readonly string[]): boolean {
  const needs =
    destination in META_NEEDS
      ? META_NEEDS[destination as keyof typeof META_NEEDS]
      : GOOGLE_NEEDS[destination as keyof typeof GOOGLE_NEEDS];
  return missingScopes(granted, needs ?? []).length === 0;
}

// ---------------------------------------------------------------------------
// Which post fits which destination
// ---------------------------------------------------------------------------

export type Frame = { type: string; width: number; height: number; bytes?: number };

/** What a publication carries: a post, a search ad's words, or Performance Max's bundle. */
export type TargetKind = PostKind | "TEXT" | "BUNDLE";

export type PostShape = { kind: TargetKind; placement: string | null; media: readonly Frame[] };

/** How a post is sent, once it fits. */
export type Format = "PHOTO" | "ALBUM" | "VIDEO" | "FEED" | "STORIES" | "REELS" | "CAROUSEL" | "DISPLAY" | "SEARCH" | "PMAX";

export type Fit = { ok: true; as: Format } | { ok: false; reason: string };

const ratio = (f: Frame) => (f.height ? f.width / f.height : 0);

/**
 * Whether one post can go to one destination, and as what.
 *
 * Decided here rather than discovered as a platform refusal after the person
 * pressed Publish, because the screen offers only what can succeed and says
 * why the rest cannot. The numbers are the platforms' own: Instagram's feed
 * takes 4:5 to 1.91:1 and JPEG only, a carousel is two to ten, a hoarding is
 * not a digital format at all, and a Google display ad is its own banner.
 */
export function fitFor(destination: Destination, post: PostShape): Fit {
  // The brief's campaigns are built from the brief, never from one post.
  if (isAlwaysOn(destination)) {
    if (destination === "GOOGLE_SEARCH_AD" && post.kind === "TEXT") return { ok: true, as: "SEARCH" };
    if (destination === "GOOGLE_PMAX_AD" && post.kind === "BUNDLE") return { ok: true, as: "PMAX" };
    return { ok: false, reason: "This runs from the campaign's schedule page, not from one post." };
  }
  if (post.kind === "TEXT" || post.kind === "BUNDLE") return { ok: false, reason: "This is not a post." };
  const frames = post.media;
  if (!frames.length) return { ok: false, reason: "This post has no files." };
  if (post.placement === "Hoarding") {
    return { ok: false, reason: "A hoarding is printed, not posted." };
  }
  const first = frames[0];
  const isVideo = first.type === "video/mp4";

  switch (destination) {
    case "FACEBOOK_PAGE":
      if (post.kind === "VIDEO") return isVideo ? { ok: true, as: "VIDEO" } : { ok: false, reason: "This video has no clip." };
      if (post.kind === "CAROUSEL") return { ok: true, as: "ALBUM" };
      return { ok: true, as: "PHOTO" };

    case "INSTAGRAM": {
      if (post.kind === "VIDEO") {
        if (!isVideo) return { ok: false, reason: "This video has no clip." };
        return { ok: true, as: post.placement === "Meta story 9:16" ? "STORIES" : "REELS" };
      }
      if (frames.some((f) => f.type !== "image/jpeg")) {
        return { ok: false, reason: "Instagram takes JPEG pictures only." };
      }
      if (post.kind === "CAROUSEL") {
        if (frames.length < 2 || frames.length > 10) {
          return { ok: false, reason: "An Instagram carousel is 2 to 10 slides." };
        }
        return { ok: true, as: "CAROUSEL" };
      }
      if (post.placement === "Meta story 9:16") return { ok: true, as: "STORIES" };
      const r = ratio(first);
      if (r < 0.8 - 0.005 || r > 1.91 + 0.005) {
        return { ok: false, reason: "Instagram's feed takes pictures from 4:5 to 1.91:1." };
      }
      return { ok: true, as: "FEED" };
    }

    case "META_AD":
      if (post.kind === "VIDEO") return isVideo ? { ok: true, as: "VIDEO" } : { ok: false, reason: "This video has no clip." };
      if (post.kind === "CAROUSEL") {
        if (frames.length < 2 || frames.length > 10) {
          return { ok: false, reason: "A carousel ad is 2 to 10 cards." };
        }
        return { ok: true, as: "CAROUSEL" };
      }
      return { ok: true, as: "PHOTO" };

    case "GOOGLE_DEMAND_GEN_AD": {
      if (post.kind === "VIDEO") return isVideo ? { ok: true, as: "VIDEO" } : { ok: false, reason: "This video has no clip." };
      if (frames.some((f) => f.type !== "image/jpeg" && f.type !== "image/png")) {
        return { ok: false, reason: "Demand Gen takes JPEG and PNG pictures." };
      }
      const shape = (f: Frame) => {
        const r = ratio(f);
        return Math.abs(r - 1) <= 0.01 ? "square" : Math.abs(r - 1.91) <= 0.03 ? "landscape" : Math.abs(r - 0.8) <= 0.01 ? "portrait" : null;
      };
      if (post.kind === "CAROUSEL") {
        if (frames.length < 2 || frames.length > 10) return { ok: false, reason: "A Demand Gen carousel is 2 to 10 cards." };
        if (frames.some((f) => shape(f) !== "square" && shape(f) !== "landscape")) {
          return { ok: false, reason: "Demand Gen carousel cards are square or 1.91:1." };
        }
        return { ok: true, as: "CAROUSEL" };
      }
      if (!shape(first)) return { ok: false, reason: "Demand Gen takes square, 1.91:1 or 4:5 pictures. Use the Meta feed 1:1 or Google display size." };
      return { ok: true, as: "PHOTO" };
    }

    case "GOOGLE_SEARCH_AD":
    case "GOOGLE_PMAX_AD":
      return { ok: false, reason: "This runs from the campaign's schedule page, not from one post." };

    case "GOOGLE_DISPLAY_AD":
      if (post.kind !== "IMAGE" || post.placement !== "Google display") {
        return { ok: false, reason: "Google display ads are made from the Google display banner." };
      }
      return { ok: true, as: "DISPLAY" };

    case "GOOGLE_BUSINESS":
      if (post.kind !== "IMAGE") {
        return { ok: false, reason: "A Business Profile post is one picture." };
      }
      if (post.placement === "Meta story 9:16") {
        return { ok: false, reason: "A tall story does not fit a Business Profile post." };
      }
      if (first.width < 400 || first.height < 300) {
        return { ok: false, reason: "Business Profile needs a picture at least 400 by 300." };
      }
      if ((first.bytes ?? 0) > 5 * 1024 * 1024) {
        return { ok: false, reason: "Business Profile takes pictures up to 5 MB." };
      }
      return { ok: true, as: "PHOTO" };
  }
}

/** What a post made in one size can be published as, by `fitFor()`'s answer. */
const FIT_LABEL: Partial<Record<Destination, Partial<Record<Format, string>>>> = {
  INSTAGRAM: { STORIES: "Instagram story", REELS: "Instagram reel", FEED: "Instagram", CAROUSEL: "Instagram" },
};

/**
 * Where a post of one kind and size can be published, in the dialog's order,
 * asked of `fitFor()` with a post of that shape, so the studio says before
 * anything is made what the Publish dialog will offer. Empty for a hoarding,
 * which is printed. Connections are not asked: this is the shape alone.
 */
export function whereItGoes(kind: PostKind, placement: string, size: { w: number; h: number }): string[] {
  const frame: Frame = { type: kind === "VIDEO" ? "video/mp4" : "image/jpeg", width: size.w, height: size.h, bytes: 1_000_000 };
  const post: PostShape = { kind, placement, media: kind === "CAROUSEL" ? Array(5).fill(frame) : [frame] };
  return DESTINATIONS.flatMap((d) => {
    const fit = fitFor(d.key, post);
    return fit.ok ? [FIT_LABEL[d.key]?.[fit.as] ?? d.label] : [];
  });
}

/**
 * The other sizes of the same card an ad shows beside the one being
 * published, in the order they are looked for.
 *
 * A Meta ad shows the feed version in feeds and the 9:16 version in Stories
 * and Reels, so neither is cropped or padded. A Demand Gen picture ad needs
 * a square, and shows a 1.91:1 one where it has it.
 */
export function companionPlacements(destination: Destination, kind: TargetKind, placement: string | null): string[] {
  if (destination === "META_AD") {
    if (kind === "IMAGE") return placement === "Meta story 9:16" ? ["Meta feed 1:1"] : placement === "Meta feed 1:1" ? ["Meta story 9:16"] : [];
    if (kind === "VIDEO") return placement === "YouTube 16:9" ? ["Meta reel 9:16", "Meta story 9:16"] : ["YouTube 16:9"];
  }
  if (destination === "GOOGLE_DEMAND_GEN_AD" && kind === "IMAGE") {
    return placement === "Google display" ? ["Meta feed 1:1"] : placement === "Meta feed 1:1" ? ["Google display"] : [];
  }
  return [];
}

/** Whether a Demand Gen picture ad has the square it cannot run without. */
export function hasSquare(frames: readonly Frame[]): boolean {
  return frames.some((f) => Math.abs(ratio(f) - 1) <= 0.01);
}

/** Tall: a 9:16 story or reel. */
export const isTall = (f: Frame) => ratio(f) < 0.7;

// ---------------------------------------------------------------------------
// The caption
// ---------------------------------------------------------------------------

/** Each platform's own ceiling on the text beside a post. */
export const CAPTION_LIMIT: Record<Destination, number> = {
  FACEBOOK_PAGE: 63_206,
  INSTAGRAM: 2_200,
  META_AD: 2_000,
  GOOGLE_DISPLAY_AD: 90,
  GOOGLE_BUSINESS: 1_500,
  // Google's ads carry no caption; their words are checked field by field.
  GOOGLE_SEARCH_AD: Number.MAX_SAFE_INTEGER,
  GOOGLE_PMAX_AD: Number.MAX_SAFE_INTEGER,
  // A YouTube description, where a Demand Gen video's caption goes.
  GOOGLE_DEMAND_GEN_AD: 5_000,
};

/**
 * The line Section 11(2) asks for on every advertisement: the registration
 * number and where the Authority publishes it.
 *
 * The picture already carries the lockup. The caption carries the number too,
 * because a caption read on its own (a Business Profile post, an ad's primary
 * text in a feed that crops the picture) is an advertisement on its own, and
 * the number is the one the gate returned, never one typed here.
 */
export function registrationLine(
  registrationNo: string | null,
  stateCode: string | null,
  permitNo: string | null = null,
): string | null {
  const no = (registrationNo ?? "").trim();
  if (!no) return null;
  // The registering state's own label and website (`rera-ad-rules.ts`), and
  // Telangana's permit number where it asks for one. A state nothing here
  // knows still carries the number.
  const rule = adRuleFor(stateCode);
  return rule ? adRegistrationLine(rule, no, permitNo) : `RERA No. ${no}`;
}

/**
 * Headline, body and call to action as cleared, then the registration line.
 *
 * Never shortened to fit. Cutting cleared copy changes what it says, and a
 * sentence the gate never saw is a sentence nobody cleared, so a caption
 * over a platform's limit is refused by `captionFits()` instead.
 */
export function captionFor(input: {
  headline: string;
  body: string;
  cta: string;
  registrationNo: string | null;
  stateCode: string | null;
  /** Telangana's building permit number. */
  permitNo?: string | null;
  /** The location and price lines the picture printed, said again under the copy. */
  facts?: { location: string | null; prices: string[] } | null;
  /** A firm's own MahaRERA agent number, carried beside the project's registration. */
  agentNo?: string | null;
  /** The seller the ad is marketed by, named beside its agent number. */
  agentName?: string | null;
}): string {
  const said = [input.facts?.location ?? null, ...(input.facts?.prices ?? [])].filter((s): s is string => !!s?.trim());
  const parts = [input.headline, input.body, said.join("\n"), input.cta].map((s) => s.trim()).filter(Boolean);
  const line = registrationLine(input.registrationNo, input.stateCode, input.permitNo ?? null);
  if (line) parts.push(line);
  if (input.agentNo) parts.push(agentLine(input.agentNo, input.agentName));
  // A starred price carries its footnote wherever it is printed.
  if (input.facts?.prices.length) parts.push(priceNoteFor(input.stateCode));
  return parts.join("\n\n");
}

/** A brief's language as the tag Business Profile wants. Hinglish is written in Latin script. */
export function languageTag(language: string): string {
  const tags: Record<string, string> = {
    English: "en",
    Hinglish: "en",
    Hindi: "hi",
    Marathi: "mr",
    Gujarati: "gu",
    Tamil: "ta",
    Telugu: "te",
    Kannada: "kn",
    Bengali: "bn",
  };
  return tags[language] ?? "en";
}

export function captionFits(destination: Destination, caption: string): boolean {
  // Google's ads carry no caption; their text is checked field by field.
  if (destination === "GOOGLE_DISPLAY_AD" || destination === "GOOGLE_SEARCH_AD" || destination === "GOOGLE_PMAX_AD") return true;
  return [...caption].length <= CAPTION_LIMIT[destination];
}

// ---------------------------------------------------------------------------
// Google display ad text
// ---------------------------------------------------------------------------

/** Google's own limits for a responsive display ad. */
export const GOOGLE_TEXT = { headline: 30, longHeadline: 90, description: 90, businessName: 25 } as const;

export type DisplayText =
  | { ok: true; headline: string; longHeadline: string; description: string; businessName: string }
  | { ok: false; reason: string };

/**
 * The cleared copy, fitted to Google's fields without changing a word.
 *
 * A brief that names the Google display format already writes to 30 and 90,
 * so for those cards this is a formality. A card written for a looser format
 * is refused rather than cut: which half of a sentence to keep is not a
 * decision code gets to make about a claim somebody cleared.
 */
export function displayText(input: {
  headline: string;
  body: string;
  businessNames: readonly string[];
}): DisplayText {
  const len = (s: string) => [...s].length;
  const headline = input.headline.trim();
  const description = input.body.trim();
  if (!headline || !description) return { ok: false, reason: "This card has no headline or no body." };
  if (len(headline) > GOOGLE_TEXT.headline) {
    return {
      ok: false,
      reason: `The headline is ${len(headline)} characters and Google display takes ${GOOGLE_TEXT.headline}. Add the Google display format to the brief and write this card again.`,
    };
  }
  if (len(description) > GOOGLE_TEXT.description) {
    return {
      ok: false,
      reason: `The body is ${len(description)} characters and Google display takes ${GOOGLE_TEXT.description}. Add the Google display format to the brief and write this card again.`,
    };
  }
  const businessName = input.businessNames.map((n) => n.trim()).find((n) => n && len(n) <= GOOGLE_TEXT.businessName);
  if (!businessName) {
    return { ok: false, reason: `Google needs a business name of ${GOOGLE_TEXT.businessName} characters or fewer.` };
  }
  return { ok: true, headline, longHeadline: headline, description, businessName };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** The least a day's budget may be, in rupees. Below it Meta refuses the ad set. */
export const MIN_DAILY_BUDGET = 100;

/**
 * Rupees from what a person typed: "1500", "1,500", "Rs 1,500", "₹1500".
 * Whole rupees only; a budget in paise is a typing mistake, not a budget.
 */
export function parseRupees(raw: string | null | undefined): number | null {
  const s = (raw ?? "").trim().replace(/^(rs\.?|inr|₹)\s*/i, "").replace(/,/g, "").replace(/\/-$/, "");
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type BudgetCheck = { ok: true; rupees: number } | { ok: false; reason: string };

/**
 * A day's budget against the account's own limit.
 *
 * No limit recorded is a refusal, not an unlimited account. Money moves on the
 * developer's own card, so the authority to move it is a number somebody
 * holding the budget key wrote down, never an absence.
 */
export function budgetCheck(input: {
  raw: string | null | undefined;
  cap: number | null;
  currency: string | null;
}): BudgetCheck {
  if (input.currency && input.currency.toUpperCase() !== "INR") {
    return { ok: false, reason: `This ad account bills in ${input.currency.toUpperCase()}. Budgets here are set in rupees.` };
  }
  if (input.cap === null) {
    return { ok: false, reason: "Nobody has set a daily limit for this ad account yet." };
  }
  const rupees = parseRupees(input.raw);
  if (rupees === null) return { ok: false, reason: "Enter the budget as whole rupees a day." };
  if (rupees < MIN_DAILY_BUDGET) return { ok: false, reason: `A day's budget starts at ${showRupees(MIN_DAILY_BUDGET)}.` };
  if (rupees > input.cap) {
    return { ok: false, reason: `That is over this account's limit of ${showRupees(input.cap)} a day.` };
  }
  return { ok: true, rupees };
}

/** Meta writes INR in paise. */
export const toMetaMinor = (rupees: number) => String(Math.round(rupees * 100));
/** Google writes every currency in millionths. */
export const toMicros = (rupees: number) => String(Math.round(rupees) * 1_000_000);

/** Indian grouping: 1,25,000. */
export function showRupees(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-IN")}`;
}

// ---------------------------------------------------------------------------
// Where an ad sends people
// ---------------------------------------------------------------------------

/**
 * A landing page, or nothing.
 *
 * Google requires a final URL and a WhatsApp link does not serve as one, and
 * an ad pointing at a page nobody can reach is spend with nowhere to go. So:
 * http or https, a real host, not this machine.
 */
export function landingUrl(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (host === "wa.me" || host.endsWith("whatsapp.com")) return null;
  if (url.username || url.password) return null;
  return url.toString();
}

// ---------------------------------------------------------------------------
// Idempotency and naming
// ---------------------------------------------------------------------------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * One post, one account, one destination: one publication.
 *
 * The key is what makes a second press, a second worker and a retry after a
 * crash all land on the same row. It carries no time, so it cannot drift.
 * An ad made again from the same post (`adAgain()`) is its next version; the
 * first keeps the key it always had.
 */
export function idempotencyKey(input: {
  source: "STUDIO" | "SCHEDULE" | "BRIEF";
  sourceId: string;
  accountId: string;
  destination: Destination;
  version?: number;
}): string {
  const v = input.version && input.version > 1 ? `:v${input.version}` : "";
  return sha(`${input.source}:${input.sourceId}:${input.accountId}:${input.destination}${v}`);
}

/**
 * Whether a studio post may be made into a new ad beside the ones it already
 * has on this account: only when every one of them is paused or stopped. A
 * paused ad's goal is fixed at the platform, so a post advertised for the
 * wrong goal is advertised again rather than edited. One spending, on its
 * way or failed (which has Try again) holds the post where it is.
 */
export function adAgain(destination: Destination, states: readonly string[]): boolean {
  return isAd(destination) && states.length > 0 && states.every((s) => s === "PAUSED" || s === "CANCELLED");
}

/** The hash of what went out: the words and the files, for this destination. */
export function contentHash(input: {
  destination: Destination;
  headline: string;
  caption: string;
  media: readonly { key: string; type: string }[];
}): string {
  return sha(
    JSON.stringify([input.destination, input.headline, input.caption, input.media.map((m) => [m.key, m.type])]),
  );
}

/**
 * The name every object a publication creates carries.
 *
 * It includes the start of the idempotency key, which is what lets a retry
 * find the campaign a crashed attempt created before it recorded the id:
 * Google refuses a second campaign of the same name, and Meta can be searched
 * by it. Readable too, so a person in Ads Manager knows where it came from.
 */
export function objectName(input: { place: string; key: string; part?: string }): string {
  const place = input.place.replace(/\s+/g, " ").trim().slice(0, 80);
  return [`Sales Desk`, place, input.key.slice(0, 10), input.part].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// The OAuth round trip
// ---------------------------------------------------------------------------

export type StatePayload = {
  /** provider */
  p: Provider;
  /** org */
  o: string;
  /** user */
  u: string;
  /** nonce, also in a cookie on the browser that started it */
  n: string;
  /** expiry, seconds since the epoch */
  e: number;
};

/** Long enough to find a password; short enough that a stolen one is stale. */
export const STATE_SECONDS = 600;

const b64u = (b: Buffer) => b.toString("base64url");

/**
 * The `state` a provider carries back to us, signed.
 *
 * It says who started this, for which organisation, and until when, and the
 * signature means none of that can be edited on the way back. The nonce is
 * also in a cookie on the browser that pressed Connect, so a link started by
 * somebody else and finished by you does not attach their accounts to your
 * organisation, or yours to theirs.
 */
export function signState(payload: StatePayload, key: Buffer): string {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const mac = b64u(createHmac("sha256", key).update(body).digest());
  return `${body}.${mac}`;
}

export type StateCheck =
  | { ok: true; payload: StatePayload }
  | { ok: false; code: "MALFORMED" | "FORGED" | "EXPIRED" | "OTHER_BROWSER" | "OTHER_PERSON" };

export function readState(
  raw: string | null | undefined,
  key: Buffer,
  expect: { nonce: string | null | undefined; userId: string; now: Date },
): StateCheck {
  const [body, mac, extra] = (raw ?? "").split(".");
  if (!body || !mac || extra !== undefined) return { ok: false, code: "MALFORMED" };
  const want = createHmac("sha256", key).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, code: "FORGED" };
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, code: "MALFORMED" };
  }
  if (!isProvider(payload.p) || !payload.o || !payload.u || !payload.n || !Number.isFinite(payload.e)) {
    return { ok: false, code: "MALFORMED" };
  }
  if (payload.e * 1000 < expect.now.getTime()) return { ok: false, code: "EXPIRED" };
  const nonce = Buffer.from(expect.nonce ?? "");
  const theirs = Buffer.from(payload.n);
  if (nonce.length !== theirs.length || !timingSafeEqual(nonce, theirs)) {
    return { ok: false, code: "OTHER_BROWSER" };
  }
  if (payload.u !== expect.userId) return { ok: false, code: "OTHER_PERSON" };
  return { ok: true, payload };
}

/** PKCE: the challenge Google is shown for a verifier we keep. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Meta's `signed_request`: `signature.payload`, both base64url, the signature
 * an HMAC-SHA256 of the payload string under the app secret.
 *
 * Meta sends one when somebody removes the app or asks for their data to be
 * deleted. Anything that does not verify is ignored, because an unsigned
 * "delete this person's connection" is a way to break a tenant's publishing
 * from outside.
 */
export function parseSignedRequest(
  raw: string | null | undefined,
  appSecret: string,
): { userId: string; issuedAt: number | null } | null {
  const [sig, body, extra] = (raw ?? "").split(".");
  if (!sig || !body || extra !== undefined || !appSecret) return null;
  const want = createHmac("sha256", appSecret).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      algorithm?: string;
      user_id?: string;
      issued_at?: number;
    };
    if ((data.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") return null;
    const userId = String(data.user_id ?? "");
    if (!/^\d{1,40}$/.test(userId)) return null;
    return { userId, issuedAt: typeof data.issued_at === "number" ? data.issued_at : null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection health
// ---------------------------------------------------------------------------

export type ConnectionStatus = "PENDING" | "CONNECTED" | "BROKEN" | "DISCONNECTED";

export type Health = "ok" | "choose" | "expiring" | "expired" | "broken" | "off";

/** Warn this far ahead of a token running out. */
export const EXPIRY_WARNING_DAYS = 7;

export function healthOf(input: {
  status: ConnectionStatus;
  tokenExpiresAt: Date | null;
  now: Date;
}): Health {
  if (input.status === "DISCONNECTED") return "off";
  if (input.status === "BROKEN") return "broken";
  if (input.tokenExpiresAt && input.tokenExpiresAt.getTime() <= input.now.getTime()) return "expired";
  if (input.status === "PENDING") return "choose";
  if (
    input.tokenExpiresAt &&
    input.tokenExpiresAt.getTime() - input.now.getTime() <= EXPIRY_WARNING_DAYS * 86_400_000
  ) {
    return "expiring";
  }
  return "ok";
}

/** How a connection's state reads on screen, and its tone. */
export const HEALTH_PILL: Record<Health, { text: string; tone: "ok" | "warn" | "risk" | "quiet" }> = {
  ok: { text: "Connected", tone: "ok" },
  choose: { text: "Choose accounts", tone: "warn" },
  expiring: { text: "Reconnect soon", tone: "warn" },
  expired: { text: "Needs reconnecting", tone: "risk" },
  broken: { text: "Needs reconnecting", tone: "risk" },
  off: { text: "Not connected", tone: "quiet" },
};

// ---------------------------------------------------------------------------
// Which account serves a node
// ---------------------------------------------------------------------------

export type PlacedAccount = { id: string; kind: AccountKind; nodePath: string; active: boolean };

/**
 * The deepest active account of each kind at or above a node, the way the
 * brand kit resolves. A Page set on the organisation covers every tower; a
 * second brand's entity pointing at its own Page overrides it underneath.
 */
export function accountsFor<T extends PlacedAccount>(accounts: readonly T[], nodePath: string): Map<AccountKind, T> {
  const covers = (p: string) => nodePath === p || nodePath.startsWith(`${p}.`);
  const out = new Map<AccountKind, T>();
  for (const a of accounts) {
    if (!a.active || !covers(a.nodePath)) continue;
    const held = out.get(a.kind);
    if (!held || a.nodePath.split(".").length > held.nodePath.split(".").length) out.set(a.kind, a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

export type TargetState = "QUEUED" | "WORKING" | "LIVE" | "PAUSED" | "ACTIVE" | "FAILED" | "CANCELLED";

export const TARGET_LABEL: Record<TargetState, string> = {
  QUEUED: "Waiting",
  WORKING: "Publishing",
  LIVE: "Live",
  PAUSED: "Paused",
  ACTIVE: "Spending",
  FAILED: "Failed",
  CANCELLED: "Stopped",
};

/** The pill a publication's state wears. Spending is blue: live money, not a problem. */
export const TARGET_TONE: Record<TargetState, "ok" | "warn" | "risk" | "quiet" | "blue"> = {
  QUEUED: "quiet",
  WORKING: "quiet",
  LIVE: "ok",
  PAUSED: "quiet",
  ACTIVE: "blue",
  FAILED: "risk",
  CANCELLED: "quiet",
};

/** Attempts before a publication is left FAILED rather than retried. */
export const MAX_PUBLISH_ATTEMPTS = 5;

/** How long a worker holds one publication. Longer than any single call. */
export const PUBLISH_LEASE_MS = 5 * 60_000;

/** How long a platform may take to process a video before it counts as stuck. */
export const PROCESSING_LIMIT_MS = 45 * 60_000;

/** Wait before retry n, doubling from half a minute and never past half an hour. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), 30 * 60_000);
}

/** Only an ad that is spending can be paused; only a paused one switched on. */
export const canPause = (d: Destination, s: TargetState) => isAd(d) && s === "ACTIVE";
export const canActivate = (d: Destination, s: TargetState) => isAd(d) && s === "PAUSED";
export const canRetry = (s: TargetState) => s === "FAILED";

export type HaltPlan = { pause: string[]; flag: string[]; cancel: string[] };

/**
 * What a blocked phase does to what was published under it.
 *
 * Every ad spending on it pauses: stopping spend needs nobody's permission.
 * Anything not yet out is cancelled, because the gate has closed. An organic
 * post already up is flagged for a person to take down, since neither
 * platform offers a reliable way to hide one. An ad a person already paused
 * is left alone, and cannot be switched back on while the phase is blocked,
 * because switching on asks the gate again.
 */
export function haltPlan(
  targets: readonly { id: string; destination: Destination; state: TargetState; phaseId: string; blockedAt: Date | null }[],
  blockedPhases: ReadonlySet<string>,
): HaltPlan {
  const plan: HaltPlan = { pause: [], flag: [], cancel: [] };
  for (const t of targets) {
    if (!blockedPhases.has(t.phaseId)) continue;
    if (t.state === "ACTIVE" && isAd(t.destination)) plan.pause.push(t.id);
    else if (t.state === "QUEUED" || t.state === "WORKING") plan.cancel.push(t.id);
    else if (t.state === "LIVE" && !t.blockedAt) plan.flag.push(t.id);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Reading a refusal from somebody else's server
// ---------------------------------------------------------------------------

export type PlatformErrorCode =
  | "TOKEN_INVALID"
  | "PERMISSION"
  | "ACCESS_LEVEL"
  | "RATE_LIMITED"
  | "TRANSIENT"
  | "INVALID"
  | "POLICY"
  | "DUPLICATE_NAME"
  | "NOT_FOUND"
  | "UNREACHABLE";

export type PlatformError = {
  code: PlatformErrorCode;
  retryable: boolean;
  message: string;
  /** The platform's own number for the refusal, when a caller has to tell two apart. */
  platformCode?: number;
};

const oneLine = (s: string, max = 200) => s.replace(/\s+/g, " ").trim().slice(0, max);

const RETRYABLE: ReadonlySet<PlatformErrorCode> = new Set(["RATE_LIMITED", "TRANSIENT", "UNREACHABLE"]);

const make = (code: PlatformErrorCode, message: string): PlatformError => ({
  code,
  retryable: RETRYABLE.has(code),
  message: oneLine(message),
});

/**
 * A Graph API error, by its code rather than its words.
 *
 * 190 is a dead token and means a person has to reconnect; 10 and the 200s
 * are a permission nobody granted; 4, 17, 32 and 613 are rate limits and
 * worth waiting out; 368 is Meta blocking the account for policy. The words
 * are shown, one line and capped, because they are often the only useful
 * part ("the image is too small"), and Meta's `error_user_msg` is written
 * for a person where `message` is written for a developer.
 */
export function readMetaError(status: number, body: unknown): PlatformError {
  const e = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const code = Number(e.code ?? 0);
  const words = String(e.error_user_msg ?? e.message ?? `Meta refused (${status}).`);
  const read = (): PlatformError => {
    if (code === 190 || code === 102 || status === 401) return make("TOKEN_INVALID", words);
    if (code === 10 || (code >= 200 && code <= 299)) return make("PERMISSION", words);
    if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014)) return make("RATE_LIMITED", words);
    if (code === 368) return make("POLICY", words);
    if (code === 803 || (code === 100 && Number(e.error_subcode ?? 0) === 33)) return make("NOT_FOUND", words);
    if (code === 1 || code === 2 || e.is_transient === true || status >= 500) return make("TRANSIENT", words);
    return make("INVALID", words);
  };
  return code ? { ...read(), platformCode: code } : read();
}

/**
 * A Google error, from the REST envelope and the Ads failure inside it.
 *
 * `invalid_grant` from the token endpoint is a revoked or expired refresh
 * token, which is a reconnect. A Cloud project still at test access refuses
 * every real account, which is ours to fix, not the developer's, and says so.
 */
export function readGoogleError(status: number, body: unknown): PlatformError {
  const b = (body ?? {}) as {
    error?: string | { code?: number; message?: string; status?: string; details?: unknown[] };
    error_description?: string;
  };
  if (typeof b.error === "string") {
    const words = b.error_description ?? b.error;
    if (b.error === "invalid_grant" || b.error === "unauthorized_client") return make("TOKEN_INVALID", words);
    return make(status >= 500 ? "TRANSIENT" : "INVALID", words);
  }
  const e = b.error ?? {};
  const details = JSON.stringify(e.details ?? []);
  const adsMessage = (() => {
    const m = details.match(/"message":"([^"]+)"/);
    return m ? m[1] : null;
  })();
  const words = adsMessage ?? e.message ?? `Google refused (${status}).`;
  if (/DUPLICATE_CAMPAIGN_NAME|DUPLICATE_NAME/.test(details)) return make("DUPLICATE_NAME", words);
  // Access is granted to our Cloud project; before 9 September 2026 it was a
  // developer token, and both refusals mean the same thing to a developer.
  if (/CLOUD_PROJECT_NOT_APPROVED|DEVELOPER_TOKEN_(NOT_APPROVED|PROHIBITED|INVALID)/.test(details)) {
    return make("ACCESS_LEVEL", words);
  }
  if (status === 401 || e.status === "UNAUTHENTICATED") return make("TOKEN_INVALID", words);
  if (status === 429 || e.status === "RESOURCE_EXHAUSTED") return make("RATE_LIMITED", words);
  if (status === 404 || e.status === "NOT_FOUND") return make("NOT_FOUND", words);
  if (status === 403 || e.status === "PERMISSION_DENIED") return make("PERMISSION", words);
  if (/POLICY_FINDING|POLICY_VIOLATION/.test(details)) return make("POLICY", words);
  if (status >= 500 || e.status === "UNAVAILABLE" || e.status === "INTERNAL") return make("TRANSIENT", words);
  return make("INVALID", words);
}

/** What a person reads when a publication fails, by code. */
export const ERROR_ADVICE: Record<PlatformErrorCode, string> = {
  TOKEN_INVALID: "The connection stopped working. Reconnect it in Settings.",
  PERMISSION: "The connected account is missing a permission this needs. Reconnect and allow everything asked for.",
  ACCESS_LEVEL: "Google Ads is not yet approved for this product. Nothing on your side needs changing.",
  RATE_LIMITED: "The platform asked us to slow down. It will be tried again.",
  TRANSIENT: "The platform had a problem. It will be tried again.",
  INVALID: "The platform refused it.",
  POLICY: "The platform refused it under its advertising policies.",
  DUPLICATE_NAME: "It already exists on the platform.",
  NOT_FOUND: "The platform no longer has it.",
  UNREACHABLE: "The platform did not answer. It will be tried again.",
};

// ---------------------------------------------------------------------------
// Who a Meta ad is shown to, and where (`doc/lead-quality.md`)
// ---------------------------------------------------------------------------

/**
 * Where a Meta ad is shown. Never Audience Network or Messenger: taps in
 * other apps' banners are where "I never enquired" comes from. A Leads ad
 * opens a higher intent form, which Meta delivers only in the Facebook and
 * Instagram feeds on a phone, so it asks for exactly those.
 */
export function metaPlacements(goal: AdGoal): Record<string, string[]> {
  if (goal === "LEADS") {
    return {
      publisher_platforms: ["facebook", "instagram"],
      facebook_positions: ["feed"],
      instagram_positions: ["stream"],
      device_platforms: ["mobile"],
    };
  }
  return {
    publisher_platforms: ["facebook", "instagram"],
    facebook_positions: ["feed", "story", "facebook_reels"],
    instagram_positions: ["stream", "story", "reels", "explore"],
  };
}

/**
 * Countries where Meta requires a housing ad to declare the housing
 * category: the United States, Canada and the European countries its help
 * lists. India is not among them, and declaring it there costs a buyer's
 * age, a 15-mile floor on the radius and every lookalike for nothing.
 */
const HOUSING_COUNTRIES = new Set([
  "US", "CA", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "CH",
]);

/** The special ad category for an ad shown in these countries: housing where Meta requires it, else none. */
export function specialAdCategory(countries: readonly string[]): { special_ad_categories: string[]; special_ad_category_country?: string[] } {
  const listed = [...new Set(countries.map((c) => c.toUpperCase()))].filter((c) => HOUSING_COUNTRIES.has(c));
  return listed.length ? { special_ad_categories: ["HOUSING"], special_ad_category_country: listed } : { special_ad_categories: [] };
}

/**
 * The radius around the project's own pin. Mumbai's buyers buy where they
 * live: 91 per cent of Western Suburbs buyers and 94 per cent of Central
 * Suburbs buyers registered in their own micro-market (Knight Frank, May
 * 2023), so a ring around the site reaches them and a city reaches Thane.
 */
export const META_LOCAL_RADIUS_KM = 10;

/** The youngest a buyer the ads are shown to: nobody under it buys a flat on an ad. */
export const META_AGE_MIN = 25;

/** The location an ad is shown in: a ring around the pin when the project has one. */
export function metaGeo(pin: { lat: number; lng: number } | null): Record<string, unknown> | null {
  if (!pin || !Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) return null;
  return {
    custom_locations: [{ latitude: pin.lat, longitude: pin.lng, radius: META_LOCAL_RADIUS_KM, distance_unit: "kilometer" }],
  };
}
