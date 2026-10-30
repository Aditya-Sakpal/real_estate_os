/**
 * The two films the studio offers in its Video template list, and which one a
 * choice makes.
 *
 * Its own file because the studio's make panel is a client component, and
 * `reel-rules.ts` reaches `node:crypto` through the copy gate it imports. The
 * dev server tolerated that; a production build refuses it. `reel-rules.ts`
 * re-exports all of this, so server code reads it from either place.
 */

/** A narrated story (the director), or "presenter": ONE film from a video template's own skill. The name predates the other templates. */
export type ReelFormat = "story" | "presenter";

/** Narrated stories one campaign may have in the making at once: each is real money. */
export const MAX_LIVE_STORIES = 3;

/**
 * Agent on camera, the video template of that name. Queued as a reel job
 * with `format = 'presenter'`, and made as ONE film from the skill
 * (`film.ts`, `film-rules.ts`) since 27 September 2026, not by the director.
 */
export const PRESENTER_TEMPLATE = {
  key: "17-insta-friendly-agent-describing-property",
  label: "Agent on camera",
  detail:
    "A presenter walks the viewer through your project in one 30-second film, in casual English, with big text on the key words. Takes about 20 to 30 minutes to make.",
} as const;

/**
 * The narrated story, offered as one choice in the Video template list
 * rather than as a kind of its own: a person picking a video picks its
 * style there, and this is one style. It is never chosen automatically, since
 * it costs about thirteen times a three-frame video and takes half an hour.
 */
export const STORY_TEMPLATE = {
  key: "story",
  label: "Narrated story",
  detail: "A 30-second family story told by one warm voice, with music. Takes about 20 to 30 minutes to make.",
} as const;

/**
 * Every video template made as ONE film from its own skill (`video-skills.ts`,
 * `film-rules.ts`), with the length its reference reels set. `never` is why a
 * format is not made at all, said on its tile. A client-safe copy of the
 * skills: `check:logic` holds the two together.
 */
export const FILM_TEMPLATES: Readonly<Record<string, { seconds: number; never?: string }>> = {
  "01-launch-film": { seconds: 25 },
  // OFF construction: "06-construction-update": { seconds: 15 },
  "12-locality-guide": { seconds: 30 },
  "13-insta-friendly-ai-land-to-home-transformation": { seconds: 20 },
  "14-insta-friendly-vfx-dust-transition-reveal": { seconds: 15 },
  "15-insta-friendly-drone-plot-boundary-graphics": { seconds: 15, never: "Not made: needs real drone footage of the site" },
  [PRESENTER_TEMPLATE.key]: { seconds: 30 },
  "18-insta-friendly-cinematic-slow-tour": { seconds: 20 },
  [STORY_TEMPLATE.key]: { seconds: 30 },
  // OFF construction: "19-insta-friendly-construction-progress": { seconds: 15 },
};

/** The film a video template choice makes: a narrated story, or a film from the template's own skill. */
export function reelFormatFor(template: string | null | undefined): ReelFormat | null {
  if (template === STORY_TEMPLATE.key) return "story";
  if (template && FILM_TEMPLATES[template] && !FILM_TEMPLATES[template].never) return "presenter";
  return null;
}
