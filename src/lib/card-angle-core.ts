/**
 * The angle a card is written for, what the copy gate reads from it, and
 * which templates a card fits. Kept apart from `card-angle-rules.ts`, which
 * reads the copy rules itself, so the gate can import these without a cycle
 * and the studio's picker without reaching server code.
 */

export type CardAngle =
  | "GENERAL"
  | "LOCATION"
  | "AMENITY"
  | "PRICE"
  | "OFFER"
  | "VISIT"
  | "CONSTRUCTION"
  | "POSSESSION"
  | "GREETING"
  | "NRI";

/** A headline need not lead on a selling point for these: it names the project instead. */
export const NAMES_LEAD: ReadonlySet<CardAngle> = new Set<CardAngle>(["VISIT", "CONSTRUCTION", "POSSESSION"]);

const SELLS_WORDS = /\b(book|buy|call now|enquire|enquiry|offer|discount|waiver|price|starting|onwards|limited)\b/i;
const MONEY_MARK = /₹|\brs\.?\s?\d|\blakh|\bcrore|\bcr\b/i;
const PROGRESS_CLAIM = /\b(on schedule|ahead of schedule|on time|almost (ready|complete|done)|nearly (ready|complete|done)|\d+\s*%|topped out|completed?)\b/i;

/**
 * What an angle forbids the copy to say, gated on what came back. A
 * greeting that sells has stopped being a greeting, and a construction
 * update that promises a schedule has made a claim nobody signed.
 */
export function angleBreach(angle: CardAngle | undefined, text: string): string | null {
  if (angle === "GREETING" && (SELLS_WORDS.test(text) || MONEY_MARK.test(text))) {
    return "A festival greeting carries no price, offer or call to buy.";
  }
  if (angle === "CONSTRUCTION" && PROGRESS_CLAIM.test(text)) {
    return "A construction update claims no schedule or progress the approved facts do not say.";
  }
  return null;
}

/** A card as the fit rule reads it. */
export type CardFacts = {
  angle: CardAngle;
  segment: string;
  /** What a general card's headline leads on, as an angle, when it leads on one. */
  lead: CardAngle | null;
  /** Whether its call to action invites a visit. */
  invites: boolean;
};

/**
 * Templates whose angle the picture carries from the signed facts, not the
 * card: every ad prints the price lines and the location line itself
 * (`adFacts()`), and an amenity template is drawn on the amenity pictures. So
 * any card that sells fits them, as it fits a general template, once the
 * project holds the price, the connectivity or the amenity
 * (`templateGap()`). They were held to cards that led on their angle, and a
 * project's general cards showed the price template disabled although the
 * ad would print the same price either way (the client, 9 October 2026).
 */
const FACT_LED: ReadonlySet<CardAngle> = new Set<CardAngle>(["PRICE", "LOCATION", "AMENITY"]);

/** Templates that take only a card leading on their own angle, whatever `FACT_LED` says. */
const LEADS_ONLY: ReadonlySet<string> = new Set(["12-locality-guide"]);

/**
 * Whether a card may be drawn in a template of this angle.
 *
 * A template that sells the project in general takes any card but a
 * festival greeting or a construction update, which say something narrower.
 * One with an angle takes a card written for it, or a general card that
 * already leads on that angle. An NRI template takes any card written for
 * the NRI buyer; a site visit template a card whose call to action invites one.
 * An NRI card is written for a buyer, not about a topic, so it fits a topic
 * it leads on exactly as a general card does: "Near Goregaon Station" is a
 * locality guide's card whoever it was written for.
 */
export function cardFits(card: CardFacts, angle: CardAngle, template?: string | null): boolean {
  // A film ABOUT the area takes only a card about the area: a location card,
  // or a general or NRI one that leads on how the project connects. The
  // locality guide was offered on cards about the pool and the price (the
  // client, 15 October 2026).
  if (template && LEADS_ONLY.has(template)) {
    return card.angle === angle || ((card.angle === "GENERAL" || card.angle === "NRI") && card.lead === angle);
  }
  if (angle === "GENERAL" || FACT_LED.has(angle)) return card.angle !== "GREETING" && card.angle !== "CONSTRUCTION";
  if (card.angle === angle) return true;
  if (angle === "NRI") return card.segment === "NRI" && card.angle !== "GREETING" && card.angle !== "CONSTRUCTION";
  if (card.angle !== "GENERAL" && card.angle !== "NRI") return false;
  if (angle === "VISIT") return card.invites;
  return card.lead === angle;
}
