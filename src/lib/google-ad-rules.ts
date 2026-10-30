/**
 * The words of a Google Search, Performance Max and Demand Gen ad.
 *
 * Nothing here is written by a model. Every line is either a card a person
 * cleared (its headline, its body, its call to action, already through the
 * copy gate) or a signed fact said plainly: the project's name, its exact
 * locality, a configuration and what it starts at, an approved selling
 * point. Google mixes the lines it is given into whatever ad it shows, so a
 * line that only made sense beside another one is never offered.
 *
 * The registration travels with the words, because a search ad has no
 * picture to carry the lockup. On Search it is the first description,
 * pinned, so it is on every ad Google shows; on Performance Max and Demand
 * Gen, which cannot pin, every description carries it.
 *
 * Pure, so `check:logic` covers all of it. Imports are relative because the
 * checks load this straight from source.
 */

/** Google's own limits. */
export const SEARCH_LIMITS = { headline: 30, description: 90, minHeadlines: 3, maxHeadlines: 15, minDescriptions: 2, maxDescriptions: 4 } as const;
export const PMAX_LIMITS = {
  headline: 30,
  longHeadline: 90,
  description: 90,
  shortDescription: 60,
  minHeadlines: 3,
  maxHeadlines: 15,
  minLongHeadlines: 1,
  maxLongHeadlines: 5,
  minDescriptions: 2,
  maxDescriptions: 5,
  businessName: 25,
} as const;
export const DEMAND_GEN_LIMITS = { headline: 40, longHeadline: 90, description: 90, maxHeadlines: 5, maxDescriptions: 5, businessName: 25 } as const;

/** A callout: a short line under a search ad, no link of its own. */
export const CALLOUT_MAX = 25;
export const MAX_CALLOUTS = 4;

/** What a starred price means, short enough to sit beside the registration. */
export const SEARCH_PRICE_NOTE = "*Base price. Taxes, charges extra.";

export type AdTextInput = {
  /** Cards that cleared the copy gate today, best first. */
  cards: { headline: string; body: string; cta: string }[];
  project: string | null;
  tower: string;
  /** The signed exact locality ("Goregaon West"). */
  location: string | null;
  /** Approved selling points, strongest first (`sellingPoints()`). */
  points: string[];
  /** Approved configurations and what each starts at, as `adPrice()` prints it. */
  prices: { label: string; price: string }[];
  /** `registrationLine()`: the number the gate said yes about and the Authority's website. Null for an exempt tower. */
  registration: string | null;
  /** The organisation's name and the project's, for Google's business name. */
  businessNames: string[];
};

const len = (s: string) => [...s].length;
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
/** A line ending in its own full stop, so two never run together. */
const sentence = (s: string) => (/[.!?*]$/.test(s) ? s : `${s}.`);

function unique(lines: readonly string[], max: number, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = tidy(raw);
    if (!line || len(line) > max) continue;
    const key = line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

/** "2 BHK QA Classic" is sold as "2 BHK". */
export function bedroomsOf(label: string): string | null {
  const m = /\b(\d+(?:\.\d)?)\s*(BHK|RK|BR|bed(?:room)?s?)\b/i.exec(label);
  if (!m) return null;
  const unit = m[2].toUpperCase().startsWith("BED") || m[2].toUpperCase() === "BR" ? "BHK" : m[2].toUpperCase();
  return `${m[1]} ${unit}`;
}

/** "₹2.19 Cr" from a price line, with its star: what a headline can carry. */
const short = (price: string) => `${price.replace(/\*$/, "")}*`;

/** The fact lines every kind of ad may draw on, longest allowed by `max`. */
function factLines(input: AdTextInput, max: number): string[] {
  const out: string[] = [];
  const project = input.project ? tidy(input.project) : null;
  const loc = input.location ? tidy(input.location) : null;
  if (project) out.push(project);
  if (project && loc) out.push(`${project}, ${loc}`, `${project} ${loc}`);
  if (project && input.tower && !project.toLowerCase().includes(input.tower.toLowerCase())) {
    out.push(`${input.tower}, ${project}`);
  }
  for (const p of input.prices) {
    const beds = bedroomsOf(p.label) ?? tidy(p.label);
    out.push(`${beds} starting ${short(p.price)}`, `${beds} from ${short(p.price)}`);
    if (loc) out.push(`${beds} in ${loc}`, `${beds} Homes in ${loc}`);
  }
  return out.filter((l) => len(l) <= max);
}

/**
 * The registration line, and the price footnote beside it when a starred
 * price may be shown. Null when it cannot be said in one description, in
 * which case no price line is offered at all: a star with no footnote is
 * the thing the footnote exists to prevent.
 */
export function registrationDescription(registration: string | null, withPriceNote: boolean, max = SEARCH_LIMITS.description): string | null {
  const reg = registration ? tidy(registration) : "";
  const note = withPriceNote ? SEARCH_PRICE_NOTE : "";
  const line = [reg, note].filter(Boolean).join(" ");
  if (!line) return null;
  return len(line) <= max ? line : null;
}

export type SearchAdText =
  | {
      ok: true;
      headlines: string[];
      descriptions: string[];
      /** Index into `descriptions` pinned to the first position. */
      pinned: number | null;
      callouts: string[];
    }
  | { ok: false; reason: string };

/**
 * A responsive search ad: up to fifteen headlines and four descriptions.
 *
 * The first description is the registration, pinned, with the price note
 * when any headline carries a starred price. When the two do not fit
 * together the prices are left out rather than the note.
 */
export function searchAdText(input: AdTextInput): SearchAdText {
  const L = SEARCH_LIMITS;
  let pinnedLine = registrationDescription(input.registration, input.prices.length > 0);
  let prices = input.prices;
  if (input.registration && !pinnedLine) {
    prices = [];
    pinnedLine = registrationDescription(input.registration, false);
  }
  const usable = { ...input, prices };
  const headlines = unique(
    [
      ...input.cards.map((c) => c.headline),
      ...factLines(usable, L.headline),
      ...input.points,
      ...input.cards.map((c) => c.cta),
    ],
    L.headline,
    L.maxHeadlines,
  );
  if (headlines.length < L.minHeadlines) {
    return { ok: false, reason: "There is not enough approved copy for a search ad. Write and clear at least three short cards, or sign the project's name and location." };
  }
  const rest = unique(
    [
      ...input.cards.map((c) => c.body),
      ...input.cards.map((c) => `${sentence(c.headline)} ${sentence(c.cta)}`),
      ...input.points.map(sentence),
      ...(input.points.length > 1 ? [`${sentence(input.points[0])} ${sentence(input.points[1])}`] : []),
    ],
    L.description,
    L.maxDescriptions - (pinnedLine ? 1 : 0),
  );
  const descriptions = pinnedLine ? [pinnedLine, ...rest] : rest;
  if (descriptions.length < L.minDescriptions) {
    return { ok: false, reason: "There is not enough approved copy for a search ad. It needs at least one cleared card body or selling point of 90 characters or fewer." };
  }
  return { ok: true, headlines, descriptions, pinned: pinnedLine ? 0 : null, callouts: callouts(input) };
}

/** Short selling points, as callouts under the ad. */
export function callouts(input: Pick<AdTextInput, "points" | "location">): string[] {
  return unique([...input.points, ...(input.location ? [input.location] : [])], CALLOUT_MAX, MAX_CALLOUTS);
}

/**
 * A description that carries the registration: the line, then the number,
 * when both fit. Where the platform cannot pin a line, this is how the
 * number reaches every ad it assembles.
 */
export function withRegistration(text: string, registration: string | null, max: number): string | null {
  const reg = registration ? tidy(registration) : "";
  if (!reg) return len(tidy(text)) <= max ? tidy(text) : null;
  const line = `${sentence(tidy(text))} ${reg}`;
  return len(line) <= max ? line : null;
}

export type PmaxText =
  | { ok: true; headlines: string[]; longHeadlines: string[]; descriptions: string[]; businessName: string }
  | { ok: false; reason: string };

/** Performance Max: headlines, long headlines, descriptions and a business name. */
export function pmaxText(input: AdTextInput): PmaxText {
  const L = PMAX_LIMITS;
  const headlines = unique(
    [...input.cards.map((c) => c.headline), ...factLines({ ...input, prices: [] }, L.headline), ...input.points, ...input.cards.map((c) => c.cta)],
    L.headline,
    L.maxHeadlines,
  );
  if (headlines.length < L.minHeadlines) {
    return { ok: false, reason: "Performance Max needs at least three short headlines. Clear more cards, or sign the project's name and location." };
  }
  const longHeadlines = unique(
    [...input.cards.map((c) => `${c.headline}. ${c.body}`), ...input.cards.map((c) => c.body), ...input.points],
    L.longHeadline,
    L.maxLongHeadlines,
  );
  if (longHeadlines.length < L.minLongHeadlines) {
    return { ok: false, reason: "Performance Max needs a long headline of 90 characters or fewer. Clear a card with a shorter body." };
  }
  // Every description carries the registration, because nothing can be pinned.
  const reg = input.registration;
  const raw = [
    ...(reg ? [tidy(reg)] : []),
    ...input.points.map((p) => withRegistration(p, reg, L.description)),
    ...input.cards.map((c) => withRegistration(c.body, reg, L.description)),
    ...input.cards.map((c) => withRegistration(c.headline, reg, L.description)),
  ].filter((d): d is string => !!d);
  const descriptions = unique(raw, L.description, L.maxDescriptions);
  if (descriptions.length < L.minDescriptions) {
    return { ok: false, reason: "Performance Max needs two descriptions that fit beside the registration number. Clear a card with a shorter body." };
  }
  if (!descriptions.some((d) => len(d) <= L.shortDescription)) {
    return { ok: false, reason: `Performance Max needs one description of ${L.shortDescription} characters or fewer.` };
  }
  const businessName = businessNameFrom(input.businessNames, L.businessName);
  if (!businessName) return { ok: false, reason: `Google needs a business name of ${L.businessName} characters or fewer.` };
  return { ok: true, headlines, longHeadlines, descriptions, businessName };
}

export type DemandGenText =
  | { ok: true; headlines: string[]; descriptions: string[]; longHeadline: string; businessName: string; callToAction: string }
  | { ok: false; reason: string };

/** A Demand Gen ad's words, from the one card it was made for. */
export function demandGenText(input: {
  headline: string;
  body: string;
  cta: string;
  registration: string | null;
  businessNames: string[];
  points: string[];
}): DemandGenText {
  const L = DEMAND_GEN_LIMITS;
  const headline = tidy(input.headline);
  if (!headline) return { ok: false, reason: "This card has no headline." };
  if (len(headline) > L.headline) {
    return { ok: false, reason: `The headline is ${len(headline)} characters and Demand Gen takes ${L.headline}. Add the Google display format to the brief and write this card again.` };
  }
  const headlines = unique([headline, ...input.points], L.headline, L.maxHeadlines);
  // The registration and the Authority's website take about 55 of the 90
  // characters, so a body of more than about 33 never fits; the headline is
  // cleared copy too and usually does.
  const descriptions = unique(
    [input.body, headline, ...input.points].map((t) => withRegistration(t, input.registration, L.description)).filter((d): d is string => !!d),
    L.description,
    L.maxDescriptions,
  );
  if (!descriptions.length) {
    return { ok: false, reason: `Neither this card's line nor its headline fits in ${L.description} characters beside the registration number. Write a shorter headline for it.` };
  }
  const longHeadline = unique([`${sentence(headline)} ${tidy(input.body)}`, headline], L.longHeadline, 1)[0];
  const businessName = businessNameFrom(input.businessNames, L.businessName);
  if (!businessName) return { ok: false, reason: `Google needs a business name of ${L.businessName} characters or fewer.` };
  return { ok: true, headlines, descriptions, longHeadline, businessName, callToAction: "LEARN_MORE" };
}

export function businessNameFrom(names: readonly string[], max: number): string | null {
  return names.map(tidy).find((n) => n && len(n) <= max) ?? null;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/** Google's limits on one keyword. */
export const KEYWORD_MAX_CHARS = 80;
export const KEYWORD_MAX_WORDS = 10;
export const MAX_KEYWORDS = 20;

/**
 * Searches that are not a buyer looking for a new home. A tower is not for
 * rent, resale, a PG or a job, and paying for those clicks is paying for
 * nobody.
 */
export const NEGATIVE_KEYWORDS = ["rent", "rental", "resale", "pg", "hostel", "jobs", "job", "career", "salary", "lease", "olx", "second hand"] as const;

/** Letters, digits and spaces only: Google refuses most symbols in a keyword. */
export function keywordText(raw: string): string | null {
  const t = raw
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!t || len(t) > KEYWORD_MAX_CHARS || t.split(" ").length > KEYWORD_MAX_WORDS) return null;
  return t;
}

/**
 * What a buyer types for this tower: its name, its name with the locality,
 * and the configurations it sells in that locality. Phrase match, so
 * "2 bhk in goregaon west" also catches "new 2 bhk in goregaon west mumbai".
 * The tower's own name is never bid on alone (Tower C is everybody's), and
 * nobody else's project is ever a keyword.
 */
export function searchKeywords(input: {
  project: string | null;
  tower: string;
  location: string | null;
  city: string | null;
  configurations: readonly string[];
}): string[] {
  const out: string[] = [];
  const p = input.project?.trim() || null;
  const loc = input.location?.trim() || null;
  const city = input.city?.trim() || null;
  if (p) out.push(p, `${p} ${loc ?? ""}`, `${p} ${city ?? ""}`, `${p} price`, `${p} floor plan`);
  if (p && input.tower && !/^(tower|wing|phase|block)\b/i.test(input.tower)) out.push(`${input.tower} ${p}`);
  const beds = [...new Set(input.configurations.map((c) => bedroomsOf(c)).filter((b): b is string => !!b))];
  for (const b of beds) {
    if (loc) out.push(`${b} in ${loc}`, `${b} flats in ${loc}`, `new ${b} in ${loc}`);
    if (city && loc) out.push(`${b} ${loc} ${city}`);
  }
  if (loc) out.push(`new projects in ${loc}`, `new launch ${loc}`, `flats in ${loc}`);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const k of out) {
    const t = keywordText(k);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
    if (kept.length >= MAX_KEYWORDS) break;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// The lead form Google shows under the ad
// ---------------------------------------------------------------------------

export const LEAD_FORM_LIMITS = { headline: 30, description: 200, businessName: 25 } as const;

export type LeadFormText = { headline: string; description: string; businessName: string } | null;

/** The lead form's own words: the project, and the first cleared body that fits. */
export function leadFormText(input: { project: string | null; tower: string; cards: { body: string }[]; businessNames: string[] }): LeadFormText {
  const headline = unique([input.project ?? "", `${input.tower}`, "Request a call back"], LEAD_FORM_LIMITS.headline, 1)[0];
  const description = unique([...input.cards.map((c) => c.body), "Leave your number and the sales team will call you."], LEAD_FORM_LIMITS.description, 1)[0];
  const businessName = businessNameFrom(input.businessNames, LEAD_FORM_LIMITS.businessName);
  if (!headline || !description || !businessName) return null;
  return { headline, description, businessName };
}

/** A privacy policy link Google and Meta will accept: https, a real host. */
export function privacyUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname.includes(".") || u.hostname === "localhost") return null;
  return u.toString();
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

/** A YouTube video id, as the upload hands it back. */
export const isYouTubeId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{11}$/.test(s);

/** The title and description an uploaded ad video carries. Unlisted: it is an ad, not a channel post. */
export function youTubeMeta(input: { headline: string; caption: string }): { title: string; description: string } {
  const title = tidy(input.headline).slice(0, 100) || "Advertisement";
  // YouTube refuses < and > in a description.
  const description = input.caption.replace(/[<>]/g, "").slice(0, 4900);
  return { title, description };
}

// ---------------------------------------------------------------------------
// What a brief's campaign is built from, frozen on its publication
// ---------------------------------------------------------------------------

/**
 * Everything a Search or Performance Max campaign says and shows, decided
 * when it is requested and kept on the row, so what Google was sent is what
 * the row says it was sent. Picture entries are indexes into the row's media.
 */
export type CampaignBundle = {
  search?: {
    headlines: string[];
    descriptions: string[];
    pinned: number | null;
    callouts: string[];
    keywords: string[];
    negatives: string[];
  };
  pmax?: { headlines: string[]; longHeadlines: string[]; descriptions: string[]; businessName: string };
  leadForm?: { headline: string; description: string; businessName: string } | null;
  images?: { square: number[]; landscape: number[]; portrait: number[] };
  videos?: number[];
};

/** Google's caps on a Performance Max asset group's pictures. */
export const PMAX_IMAGE_MAX = { square: 20, landscape: 20, portrait: 20 } as const;

/** The pictures a brief's passed posts give a Performance Max campaign, newest first. */
export function pmaxPictures<T extends { width: number; height: number; type: string }>(
  frames: readonly T[],
): { square: number[]; landscape: number[]; portrait: number[] } {
  const out = { square: [] as number[], landscape: [] as number[], portrait: [] as number[] };
  frames.forEach((f, i) => {
    if (f.type !== "image/jpeg" && f.type !== "image/png") return;
    const r = f.height ? f.width / f.height : 0;
    if (Math.abs(r - 1) <= 0.01 && out.square.length < PMAX_IMAGE_MAX.square) out.square.push(i);
    else if (Math.abs(r - 1.91) <= 0.03 && out.landscape.length < PMAX_IMAGE_MAX.landscape) out.landscape.push(i);
    else if (Math.abs(r - 0.8) <= 0.01 && out.portrait.length < PMAX_IMAGE_MAX.portrait) out.portrait.push(i);
  });
  return out;
}

/** Why a brief cannot run Performance Max yet, from the pictures it has. */
export function pmaxPictureGap(p: { square: number[]; landscape: number[] }): string | null {
  if (!p.landscape.length && !p.square.length) {
    return "Make a Google display and a Meta feed 1:1 image for this campaign first. Performance Max needs both shapes.";
  }
  if (!p.landscape.length) return "Make a Google display image for this campaign first. Performance Max needs a 1.91:1 picture.";
  if (!p.square.length) return "Make a Meta feed 1:1 image for this campaign first. Performance Max needs a square picture.";
  return null;
}
