import { resolveTemplate } from "./templates.ts";
import type { ChooseDriver } from "./generate.ts";
import { filmGaps } from "./film.ts";
import { skillFor } from "./film-rules.ts";
import { cardFits, cardLead, invitesVisit, isCardAngle, templateAngle, templateGap, type CardMaterial } from "./card-angle-rules.ts";
import { autoCandidates, type TemplateContext } from "./template-rules.ts";
import { FILM_TEMPLATES, STORY_TEMPLATE } from "./reel-choice.ts";
import { learningFor } from "./learning.ts";
import { seeded } from "./learning-rules.ts";

/**
 * "Let AI choose" for a video, and a scheduled video: one Seedance film from
 * a template's own skill, since 5 October 2026 (the client: every video on
 * Seedance 2.5). It used to be three designed frames, each brought to life by
 * a Kling clip.
 *
 * Chosen the way a post's template is (`resolveTemplate()`), among the video
 * templates picked automatically, and only among those this card suits, the
 * project holds what they show, and the library can honestly film. With none
 * of them open, the cinematic slow tour, which needs only the building.
 */
export const FALLBACK_FILM = "18-insta-friendly-cinematic-slow-tour";

/** What "Let AI choose" sends for a video, so the server chooses the film. */
export const AUTO_FILM = "auto";

export async function chooseFilmTemplate(o: {
  orgId: string;
  node: { id: string; path: string; kind: string };
  card: { headline: string; body: string; cta: string; segment: string; angle?: string | null };
  ground: { talkingPoints: readonly string[]; configurations: readonly { label: string }[] };
  material: CardMaterial;
  context: Omit<TemplateContext, "headline" | "body" | "cta">;
  driver?: ChooseDriver;
  signal?: AbortSignal;
}): Promise<string | null> {
  const angle = isCardAngle(o.card.angle) ? o.card.angle : "GENERAL";
  const fits = (key: string) =>
    cardFits(
      { angle, segment: o.card.segment, lead: cardLead(o.card, o.ground), invites: invitesVisit(o.card.cta) },
      templateAngle("VIDEO", key),
      key,
    );
  const makes = (k: string) => {
    const skill = skillFor(k);
    return !!skill && !(skill.needs && !skill.needs.categories.length) && !templateGap("VIDEO", k, o.material) && fits(k);
  };
  // The ones picked automatically first; when none of them goes with this
  // card (a location card, a site visit), any film template that does.
  const preferred = autoCandidates(o.context.placement, "VIDEO").map((c) => c.key).filter(makes);
  const films = preferred.length
    ? preferred
    : Object.keys(FILM_TEMPLATES).filter((k) => k !== STORY_TEMPLATE.key && !FILM_TEMPLATES[k].never && makes(k));
  // The library asked once for every candidate, before the choice.
  const gaps = films.length ? await filmGaps(o.orgId, o.node, films) : {};
  const open = new Set(films.filter((k) => !gaps[k]));
  // Nothing goes with this card (a festive greeting): no film is made.
  if (!open.size) return makes(FALLBACK_FILM) ? FALLBACK_FILM : null;
  // What has worked here, ours and the competitor ads saved near this
  // project, steers the choice as it does for a picture.
  const learning = await learningFor(o.orgId, o.node.id).catch(() => null);
  const chosen = await resolveTemplate({
    picked: null,
    kind: "VIDEO",
    context: { ...o.context, headline: o.card.headline, body: o.card.body, cta: o.card.cta },
    allow: (k) => open.has(k),
    driver: o.driver,
    signal: o.signal,
    learned: learning
      ? { scores: learning.scores, explore: learning.settings.explore, rand: seeded(`${o.node.id}:${o.card.headline}:${new Date().toISOString().slice(0, 13)}`) }
      : undefined,
  });
  return open.has(chosen.key) ? chosen.key : [...open][0];
}
