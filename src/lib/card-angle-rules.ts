import { pointAngle } from "./learning-rules.ts";
import { connectivityPoint, isLuxury, meaningfulOffer, sellingPoints, type CopySpec, type Ground, type Segment } from "./creative-rules.ts";

/**
 * What a card is written for, and which templates it may be drawn in.
 *
 * A card used to be written once per language and buyer, leading on the
 * strongest selling point, and the template was picked afterwards with
 * nothing checking the two against each other: "Sea Facing Apartments" went
 * out on an Offer template with no offer, on a Construction update with no
 * site photograph, on a Festive greeting that is not supposed to sell. So a
 * card now has an ANGLE, every template says which angle it takes and what
 * the project must hold for it, and the studio writes one card per angle the
 * project can honestly support, so every template has a card and every card
 * a template (the client, 4 October 2026).
 *
 * Pure and client-safe: the studio's picker and the server's refusal read
 * the same rules.
 */

export type { CardAngle } from "./card-angle-core.ts";
export { NAMES_LEAD, angleBreach, cardFits, type CardFacts } from "./card-angle-core.ts";
import { cardFits, type CardAngle, type CardFacts } from "./card-angle-core.ts";

/** Every angle, the general card first, with the words the screen uses. */
export const CARD_ANGLES: readonly { key: CardAngle; label: string }[] = [
  { key: "GENERAL", label: "Any ad" },
  { key: "LOCATION", label: "Location" },
  { key: "AMENITY", label: "Amenities" },
  { key: "PRICE", label: "Price" },
  { key: "OFFER", label: "Offer" },
  { key: "VISIT", label: "Site visit" },
  { key: "CONSTRUCTION", label: "Construction" },
  { key: "POSSESSION", label: "Ready to move" },
  { key: "GREETING", label: "Festive greeting" },
  { key: "NRI", label: "NRI" },
];

export function isCardAngle(raw: unknown): raw is CardAngle {
  return typeof raw === "string" && CARD_ANGLES.some((a) => a.key === raw);
}

export function angleLabel(angle: CardAngle): string {
  return CARD_ANGLES.find((a) => a.key === angle)?.label ?? angle;
}

export type AngleKind = "IMAGE" | "CAROUSEL" | "VIDEO";

type TemplateRule = CardAngle | { never: string };

/**
 * Every template in every kind, and the angle its card is written for. A
 * template not named here takes any general card, which is the safe reading
 * for a category added later: it was drawn before this rule existed.
 */
const TEMPLATE_ANGLE: Record<AngleKind, Record<string, TemplateRule>> = {
  IMAGE: {
    "01-launch-announcement": "GENERAL",
    "03-price-and-configuration": "PRICE",
    "04-offer-and-payment-plan": "OFFER",
    "05-festive-offer": "OFFER",
    "06-festive-greeting": "GREETING",
    "07-location-and-connectivity": "LOCATION",
    "08-amenities-and-lifestyle": "AMENITY",
    "09-key-highlights": "GENERAL",
    // OFF construction: "10-construction-update": "CONSTRUCTION",
    "11-ready-to-move-and-possession": "POSSESSION",
    "12-site-visit-and-events": "VISIT",
    "14-developer-trust": { never: "Needs the developer's track record, which is not in the project's facts" },
    "15-nri": "NRI",
    "16-referral": { never: "Needs a referral offer for owners, which is not in the project's facts" },
    "19-google-display-banners": "GENERAL",
  },
  CAROUSEL: {
    "01-project-tour": "GENERAL",
    "02-floor-plans": "PRICE",
    "03-location-guide": "LOCATION",
    "04-amenities": "AMENITY",
    "05-reasons-to-buy": "GENERAL",
    "06-offer-explained": "OFFER",
    // OFF construction: "07-construction-timeline": "CONSTRUCTION",
    // OFF construction: "08-site-progress-report": "CONSTRUCTION",
    "09-architecture-and-elevation": "GENERAL",
    "10-key-highlights": "GENERAL",
    "11-seamless-panorama": "GENERAL",
  },
  VIDEO: {
    "00-narrated-story": "GENERAL",
    "01-launch-film": "GENERAL",
    // OFF construction: "06-construction-update": "CONSTRUCTION",
    "12-locality-guide": "LOCATION",
    "13-insta-friendly-ai-land-to-home-transformation": "GENERAL",
    "14-insta-friendly-vfx-dust-transition-reveal": "GENERAL",
    "15-insta-friendly-drone-plot-boundary-graphics": "GENERAL",
    "17-insta-friendly-agent-describing-property": "GENERAL",
    "18-insta-friendly-cinematic-slow-tour": "GENERAL",
    // OFF construction: "19-insta-friendly-construction-progress": "CONSTRUCTION",
  },
};

/** The angle a template's card is written for; GENERAL for one this file does not know. */
export function templateAngle(kind: AngleKind, key: string | null | undefined): CardAngle {
  const rule = key ? TEMPLATE_ANGLE[kind]?.[key] : undefined;
  return typeof rule === "string" ? rule : "GENERAL";
}

/** Why a template is never made from any card, or null. */
export function templateNever(kind: AngleKind, key: string | null | undefined): string | null {
  const rule = key ? TEMPLATE_ANGLE[kind]?.[key] : undefined;
  return rule && typeof rule === "object" ? rule.never : null;
}

/** Every template the rules know, for the checks that hold the catalog to them. */
export function knownTemplates(kind: AngleKind): string[] {
  return Object.keys(TEMPLATE_ANGLE[kind]);
}

/** What a project holds that an angle needs: counted from signed facts and approved pictures. */
export type CardMaterial = {
  /** Approved selling points that say how it connects (a station, a road, minutes away). */
  connectivity: number;
  /** Approved selling points about an amenity. */
  amenities: number;
  /** Approved configurations with a price. */
  priced: number;
  /** An approved offer: a selling point that is one, or the campaign's own offer. */
  offer: string | null;
  /** Approved, dated construction photographs fresh enough to show. */
  construction: number;
  /** The signed possession date has come. */
  readyToMove: boolean;
};

export function materialFrom(input: {
  ground: Pick<Ground, "talkingPoints" | "configurations" | "possessionDate">;
  /** The brief's offers line, as typed. */
  offers: string | null;
  constructionPhotos: number;
  /** Today in IST, `YYYY-MM-DD`. */
  today: string;
}): CardMaterial {
  const points = input.ground.talkingPoints;
  const offerPoint = points.find((p) => pointAngle(p) === "OFFER") ?? null;
  return {
    connectivity: points.filter((p) => pointAngle(p) === "CONNECTIVITY").length,
    amenities: points.filter((p) => pointAngle(p) === "AMENITY").length,
    priced: input.ground.configurations.filter((c) => c.startingPrice !== null).length,
    offer: offerPoint ?? meaningfulOffer(input.offers),
    construction: input.constructionPhotos,
    readyToMove: !!input.ground.possessionDate && input.ground.possessionDate.slice(0, 10) <= input.today,
  };
}

/** Why a card of this angle cannot be written for this project, in the client's words, or null. */
export function angleGap(angle: CardAngle, m: CardMaterial): string | null {
  switch (angle) {
    case "LOCATION":
      return m.connectivity ? null : "Needs an approved fact on how the project connects (a station, a road, minutes away)";
    case "AMENITY":
      return m.amenities ? null : "Needs an approved amenity (a pool, a clubhouse, a gym) in the project's facts";
    case "PRICE":
      return m.priced ? null : "Needs an approved configuration with its price";
    case "OFFER":
      return m.offer ? null : "Needs an approved offer in the project's facts or the campaign's offers";
    case "CONSTRUCTION":
      return m.construction ? null : "Needs an approved, dated construction photo from the last 90 days";
    case "POSSESSION":
      return m.readyToMove ? null : "Needs the approved possession date to have come";
    default:
      return null;
  }
}

/** Why a template cannot be made for this project, or null. */
export function templateGap(kind: AngleKind, key: string | null | undefined, m: CardMaterial): string | null {
  return templateNever(kind, key) ?? angleGap(templateAngle(kind, key), m);
}

/** The angle cards this project can honestly support, beside the general cards. */
export function anglesToWrite(m: CardMaterial): CardAngle[] {
  // Construction cards are switched off with the construction templates; drop the CONSTRUCTION test to bring them back.
  return CARD_ANGLES.map((a) => a.key).filter((a) => a !== "GENERAL" && a !== "CONSTRUCTION" && !angleGap(a, m));
}

/**
 * The buyer an angle card is written for. One card per language per angle,
 * not per buyer: an angle is what the ad is about, and the general cards
 * already speak to each buyer. The NRI card is for the NRI buyer.
 */
export function angleSegment(angle: CardAngle, segments: readonly Segment[]): Segment {
  if (angle === "NRI") return "NRI";
  return segments.find((s) => s !== "NRI") ?? "END_USER";
}

/** The angle cards to write, one per language and supported angle. */
export function planAngleCards(input: {
  languages: readonly string[];
  segments: readonly Segment[];
  material: CardMaterial;
}): CopySpec[] {
  const angles = anglesToWrite(input.material);
  return input.languages.flatMap((language) =>
    angles.map((angle) => ({ language, segment: angleSegment(angle, input.segments), angle })),
  );
}

const VISIT_WORDS = /\b(visit|site|sample flat|show flat|come and see|walk ?through)\b/i;

export function invitesVisit(cta: string): boolean {
  return VISIT_WORDS.test(cta);
}

const LETTERS = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);

/**
 * What a general card leads on. The talking point its headline shares the
 * most words with names it (a station is LOCATION, a pool AMENITY); a
 * headline that names a configuration or an amount is PRICE. A general card
 * that leads on the station suits a location template as well as any.
 */
export function cardLead(
  card: { headline: string },
  ground: { talkingPoints: readonly string[]; configurations: readonly { label: string }[] },
): CardAngle | null {
  const said = new Set(LETTERS(card.headline));
  if (!said.size) return null;
  let best: { point: string; n: number } | null = null;
  for (const p of ground.talkingPoints) {
    const n = LETTERS(p).filter((w) => said.has(w)).length;
    if (n && (!best || n > best.n)) best = { point: p, n };
  }
  const angle = best ? pointAngle(best.point) : null;
  if (angle === "CONNECTIVITY") return "LOCATION";
  if (angle === "AMENITY") return "AMENITY";
  if (angle === "OFFER") return "OFFER";
  if (angle === "PRICE") return "PRICE";
  const configs = ground.configurations.map((c) => c.label.toLowerCase().split(/\s+/)[0]).filter(Boolean);
  if (/₹|\brs\b|\bcr\b|\blakh\b/i.test(card.headline) || configs.some((c) => said.has(c) && /\bbhk\b/i.test(card.headline))) return "PRICE";
  return null;
}

/** The templates of a kind a card fits, of those offered. */
export function templatesForCard(card: CardFacts, kind: AngleKind, keys: readonly string[]): string[] {
  return keys.filter((k) => !templateNever(kind, k) && cardFits(card, templateAngle(kind, k), k));
}

/**
 * What the writer is told about the angle, beside everything a card is
 * always told. No example with a number or a place in it: asked with one,
 * the writer copies the example.
 */
export function angleLines(
  angle: CardAngle,
  input: { ground: Pick<Ground, "talkingPoints" | "configurations">; project: string; offer: string | null },
): string[] {
  const luxury = isLuxury(input.ground.configurations);
  const points = sellingPoints(input.ground.talkingPoints, { luxury });
  const connects = connectivityPoint(points, { luxury });
  const amenity = points.find((p) => pointAngle(p) === "AMENITY") ?? null;
  const head = "THIS CARD:";
  switch (angle) {
    case "LOCATION":
      return [
        head,
        "  - It is for a location ad, about where the project is and how close things are.",
        connects
          ? `  - Headline: the connectivity this approved fact gives, in two to five words, the way a buyer says it: "${connects}".`
          : "  - Headline: the strongest approved fact about where it is, in two to five words.",
        "  - Body: one more approved fact about where it is or what is near, and nothing else.",
      ];
    case "AMENITY":
      return [
        head,
        "  - It is for an amenities ad, about the life the project offers.",
        amenity
          ? `  - Headline: the amenity from this approved fact, in two to five words: "${amenity}".`
          : "  - Headline: the strongest approved amenity, in two to five words.",
        "  - Body: one more approved amenity or lifestyle fact, and nothing else.",
      ];
    case "PRICE":
      return [
        head,
        "  - It is for a price ad. The starting prices are printed on a line of their own, so never put a price in any field.",
        "  - Headline: the home itself the way a buyer asks for it, naming one configuration listed above, with at most",
        "    one quality the approved facts give it. Two to five words.",
        "  - Body: the strongest approved selling point, as short as it can be said.",
      ];
    case "OFFER":
      return [
        head,
        "  - It is for an offer ad: the offer is the hook.",
        input.offer
          ? `  - Headline: this offer and only this, in two to five words, without adding to it: "${input.offer}".`
          : "  - Headline: the approved offer, in two to five words.",
        "  - Body: the strongest approved selling point. Call to action: claim the offer or book a site visit.",
      ];
    case "VISIT":
      return [
        head,
        `  - It invites buyers to visit the site or the sample flat of ${input.project}.`,
        `  - Headline: an invitation in two to five words that names ${input.project} or its strongest approved selling point.`,
        "  - Body: one approved selling point. Call to action: book a site visit. No day, date or time.",
      ];
    case "CONSTRUCTION":
      return [
        head,
        `  - It is a construction update: ${input.project} is being built.`,
        `  - Headline: that ${input.project} is rising, in two to five words, naming the project.`,
        "  - Never a date, a percentage, a floor or slab count, \"on schedule\", \"on time\" or \"almost ready\":",
        "    nothing about progress that the approved facts do not say.",
        "  - Body: one approved selling point. Call to action: book a site visit.",
      ];
    case "POSSESSION":
      return [
        head,
        "  - It says the homes are ready to move into: possession has begun.",
        `  - Headline: ready to move in, in two to five words, with ${input.project}'s name or its strongest approved point.`,
        "  - Body: one approved selling point. Call to action: book a site visit.",
      ];
    case "GREETING":
      return [
        head,
        "  - It is a festival greeting from the brand. The design adds the festival's own greeting, so name no festival.",
        "  - Headline: a warm wish in two to five words.",
        "  - No price, no offer, no discount and no call to buy anywhere, not even in the call to action.",
        "  - Body: one approved selling point, said gently as a warm line about home.",
        "  - Call to action: a short, warm sign-off from the brand.",
      ];
    case "NRI":
      return [
        head,
        "  - It speaks to Indians living abroad buying a home back in India. Lead with the strongest approved point.",
        "  - Call to action: the brief's, or a call with the sales team. Promise no service the facts do not name.",
      ];
    default:
      return [];
  }
}
