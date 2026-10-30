import { festivalByKey, festivalIn, type Festival } from "./template-rules.ts";
import { angleGap, type CardMaterial } from "./card-angle-rules.ts";
import type { CardAngle } from "./card-angle-core.ts";
import type { Occasion } from "./post-rules.ts";

/**
 * A scheduled post on a festival day is a festival post.
 *
 * The client, 8 October 2026: when a schedule leaves the template to "Let AI
 * choose" and the post goes out on a festival the developer observes, it
 * greets that festival. Nothing here infers which festivals a developer
 * observes: the occasion has already been through `pickOccasion()`, which
 * takes only a verified date the organisation ticked on Occasions.
 *
 * Pure, so `check:logic` covers it.
 */

/** The festive templates a festival day draws, by the occasion's kind. */
export const FESTIVE_GREETING_TEMPLATE = "06-festive-greeting";
export const FESTIVE_OFFER_TEMPLATE = "05-festive-offer";

/**
 * The festival an occasion is. Its key first ("ganesh_chaturthi" is
 * "ganesh-chaturthi"), then its name. Reading the occasion's name and the
 * campaign's name together found whichever festival came first in the
 * catalog: Navratri inside a campaign called "Diwali 2026" read as Diwali.
 */
export function festivalOf(o: Pick<Occasion, "key" | "name"> | null | undefined): Festival | null {
  if (!o) return null;
  return festivalByKey(o.key.replace(/_/g, "-")) ?? festivalIn(o.name);
}

export type FestivalDay = {
  festival: Festival;
  /** The design template the post is drawn in. */
  template: string;
  /** What the cards are written for: a greeting, or an offer on a buying day. */
  angle: CardAngle;
};

/**
 * Whether this slot's post is a festival post, and how.
 *
 * Only an image (the festive designs are images), only when the style leaves
 * the template to the AI (a template a person picked is kept), only on the
 * festival's own day in IST, and only for an occasion the catalog can draw.
 * A buying occasion carries the offer when the project holds an approved one;
 * otherwise, and on every greeting occasion, it greets and sells nothing.
 */
export function festivalDay(input: {
  occasion: Occasion | null;
  /** The slot's publish date, `YYYY-MM-DD` in IST. */
  publishDate: string;
  kind: string;
  /** The style's own template; null is "Let AI choose". */
  styleTemplate: string | null;
  material: CardMaterial;
}): FestivalDay | null {
  const o = input.occasion;
  if (!o || !o.verified || o.onDate !== input.publishDate) return null;
  if (input.kind !== "IMAGE" || input.styleTemplate) return null;
  const festival = festivalOf(o);
  if (!festival) return null;
  const offer = o.kind === "BUYING" && !angleGap("OFFER", input.material);
  return offer
    ? { festival, template: FESTIVE_OFFER_TEMPLATE, angle: "OFFER" }
    : { festival, template: FESTIVE_GREETING_TEMPLATE, angle: "GREETING" };
}
