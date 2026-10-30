import { guardAgentText } from "./agent-rules.ts";
import { toAsciiDigits } from "./creative-rules.ts";
import { changesProperty } from "./compose-rules.ts";
import { spokenMatch, withoutNegations } from "./reel-rules.ts";
import { TEMPLATE_SKILLS } from "./video-skills.ts";
import { affirmed, LENS_WORDS, withoutCards, withoutDoors, type FilmDirection } from "./film-direction-rules.ts";
import { ENGLISH, isDevanagari, lineRule, localSayHow, numberWordsIn, spokenFormIn, wordCount, type FilmLanguage } from "./film-language-rules.ts";
import { nearbyPlaces, placesNamedIn, samePlace } from "./locality-rules.ts";

/**
 * A film made in ONE video generation, with its own voice, music and big
 * text: the pure half. `film.ts` holds the calls and the files.
 *
 * The client's first one-call film (Seedance 2.5, 26 September 2026) was
 * rated close to perfect, where a month of stitched shots, a separate voice
 * and our own text had not been. It also made two mistakes, and the product
 * never pays for a second film to fix them: a second version is the person's
 * choice and counts as two videos. So everything here exists to make the
 * first generation right. A writer drafts the scenes; code checks the draft
 * against the signed facts, plans the time, writes every line the way it is
 * said and every card letter by letter, and describes the style in words
 * instead of sending another creator's frames (the first film copied their
 * text). After the film, code judges what came back without buying another.
 *
 * `SKILL.md` beside each template folder says, in prose, what the format is
 * and where these numbers came from.
 *
 * Imports are relative because the worker and the checks load this straight
 * from source.
 */

/** Seconds in a film. One Seedance 2.5 call makes four to thirty. */
export const FILM_SECONDS = 30;

/** What one film counts as against a plan's videos: a new version sends the first one back in, so it is processed twice. */
export const FILM_UNITS = { first: 1, revision: 2 } as const;

/** Drafts the writer gets before the job stops. Each is one model call, a few rupees. */
export const MAX_FILM_DRAFTS = 3;
/** Sarvam's writer, which writes a Hindi or Marathi film, gets more drafts: each is about a rupee. */
export const MAX_SARVAM_DRAFTS = 5;

/** Paid film requests one job may ever make. A second only when the service refused, failed or lost the first. */
export const MAX_FILM_REQUESTS = 2;

/**
 * Whether a film the service did not hand back is asked for again in the
 * same job, inside `MAX_FILM_REQUESTS`: a refusal by its filter (they are
 * not consistent: the same family story passed one day and was refused the
 * next), a failure, an outage or a lost answer. Never our balance, a missing
 * key or a stop, which another request cannot change.
 */
export function retryFilm(code: string): boolean {
  return ["AI_DECLINED", "AI_FAILED", "AI_UNAVAILABLE", "AI_BUSY", "UNREACHABLE", "CANCELED"].includes(code);
}

/**
 * Seedance refuses a reference picture wider than 2.5 to 1 or taller than 1
 * to 2.5, and refuses the whole film with it (20 October 2026: a JVLR
 * flyover photo at 2.59 was refused on every request). A picture outside is
 * cut from its middle to just inside the limit; one inside is left alone.
 */
export const FILM_REF_ASPECT = { min: 0.42, max: 2.4 } as const;

export function aspectCrop(width: number, height: number): { left: number; top: number; width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null;
  const r = width / height;
  if (r > FILM_REF_ASPECT.max) {
    const w = Math.floor(height * FILM_REF_ASPECT.max);
    return { left: Math.floor((width - w) / 2), top: 0, width: w, height };
  }
  if (r < FILM_REF_ASPECT.min) {
    const h = Math.floor(width / FILM_REF_ASPECT.min);
    return { left: 0, top: Math.floor((height - h) / 2), width, height: h };
  }
  return null;
}

/**
 * A film the checks found mistakes in is made once more, by itself, before
 * anybody sees it (the client, 2 October 2026: "if they are paying so much,
 * it is supposed to be done"). The first film goes back in as `@Video1` with
 * what was wrong, the same way a person's new version does, and the better
 * of the two is delivered. One request for it and no second: a fix the
 * service lost delivers the first film, which keeps the worst case under the
 * plans' floor (`doc/pricing.md`). `FILM_AUTO_FIX=off` switches it off.
 */
export const MAX_FIX_REQUESTS = 1;

/** Pictures a film's writer is offered, at most, and how many of them are rooms of the sample flat. */
export const FILM_PICTURES = 10;
export const FLAT_ROOMS_OFFERED = 2;
/** Which rooms of the sample flat show the home best, first first. */
const ROOM_ORDER = ["living", "hall", "bedroom", "kitchen", "balcony", "dining", "study", "bath", "toilet"];
const roomRank = (title: string | null): number => {
  const t = (title ?? "").toLowerCase();
  const i = ROOM_ORDER.findIndex((r) => t.includes(r));
  return i < 0 ? ROOM_ORDER.length : i;
};

/**
 * The pictures a film is written from, in the order they arrive (the
 * building first). Up to `FLAT_ROOMS_OFFERED` rooms of the sample flat are
 * always among them, the living room and bedroom before the bathroom: cut
 * last, they never reached the writer once a library held ten pictures of
 * the building and its amenities. `keep` (a new version's own pictures) is
 * always offered.
 */
export function filmPictures<P extends { assetId: string; category: string; title: string | null }>(
  all: readonly P[],
  keep: readonly string[] = [],
  max = FILM_PICTURES,
): P[] {
  const flats = all
    .filter((p) => p.category === "SAMPLE_FLAT")
    .map((p, i) => ({ p, i }))
    .sort((a, b) => roomRank(a.p.title) - roomRank(b.p.title) || a.i - b.i)
    .map((x) => x.p);
  const chosen = new Set<P>([
    ...all.filter((p) => keep.includes(p.assetId)),
    ...flats.slice(0, FLAT_ROOMS_OFFERED),
  ]);
  for (const p of all) {
    if (chosen.size >= max) break;
    chosen.add(p);
  }
  return all.filter((p) => chosen.has(p));
}
export const autoFixOn = (): boolean => (process.env.FILM_AUTO_FIX ?? "on").toLowerCase() !== "off";

/**
 * What the checks found that another film could put right, from the film's
 * problems and notes. Left out: what is ours rather than the model's (the QR
 * we stamp), what no check could read, and the voice fix's own report, which
 * has already said the word again.
 */
export function filmFixes(findings: readonly string[]): string[] {
  const notTheModels = [
    /^The RERA QR code does not scan/i,
    /could not be checked/i,
    /^How words were said was not checked/i,
    /^Said again in her voice/i,
  ];
  return [...new Set(findings.filter((f) => f.trim() && !notTheModels.some((re) => re.test(f))))];
}

/**
 * Which of two films to deliver: fewer problems first (each counts three),
 * then fewer fixable findings; the fixed one on a tie, since it was made to
 * be better.
 */
export function betterFilm(first: { problems: number; fixes: number }, fixed: { problems: number; fixes: number }): "first" | "fixed" {
  const score = (f: { problems: number; fixes: number }) => f.problems * 3 + f.fixes;
  return score(fixed) <= score(first) ? "fixed" : "first";
}

/** How long a person's note for a new version may be. */
export const MAX_NOTE_CHARS = 400;

// ---------------------------------------------------------------------------
// The skill: what a format is, learned from its reference reels
// ---------------------------------------------------------------------------

export type VideoSkill = {
  /** The video template it belongs to. */
  key: string;
  label: string;
  /** What the film is, in one sentence: the writer's brief and the prompt's opening both say it. */
  format: string;
  /** How long the film runs. One Seedance call makes four to thirty seconds, and a shorter film costs less. */
  seconds: number;
  scenes: { min: number; max: number };
  /** How long one shot usually runs, from the reference reels' cuts. A silent shot is planned inside it. */
  shotSeconds: { min: number; max: number };
  /** Who speaks: a presenter on camera, a narrator nobody sees, or nobody (music only). */
  speech: "presenter" | "voiceover" | "none";
  presenterScenes: { min: number; max: number };
  /** Generated people who are not the presenter (a family, a couple), never named and never a buyer giving a review. */
  peopleScenes: { min: number; max: number };
  /** Whether the presenter says the hook in the first scene and the action in the last. */
  presenterOpensAndCloses: boolean;
  /** Words spoken across the film, counted as said ("one point four five crore" is five). */
  words: { min: number; max: number };
  /** Words in one scene's line, at most. */
  lineWords: number;
  /** Big text cards, and words on one card. */
  cards: { min: number; max: number; words: number };
  /** How fast the presenter talks, for the time plan. */
  wordsPerSecond: number;
  /** The film, beat by beat, as the writer is told it. */
  beats: readonly string[];
  /** How it looks and moves. */
  look: string;
  /** How the presenter behaves on camera, or null when there is none. */
  presenter: string | null;
  /** How real the presenter (or any person) must look, said as a camera sees a real person. */
  realism: string | null;
  /** Accent and delivery of whoever speaks, or null when nobody does. */
  voice: string | null;
  /** How the big text looks and moves. */
  text: string;
  sound: string;
  /**
   * The camera moves of the format: every property shot names one of
   * `property` (matched as the start of a word, "orbit" finds "orbits"), and
   * no shot may name one of `forbidden`. A slow tour forbids what a fast
   * reel requires, so this is the skill's and never a rule of the code's.
   */
  moves: { property: readonly string[]; forbidden: readonly string[] };
  /** What the writer must never do. */
  never: readonly string[];
  /**
   * Frames from the template's own reference reels, text painted out, sent as
   * STYLE references, relative to the repository. The film that set the bar
   * had three (a presenter, an FPV move, a whip pan). None are sent for Agent
   * on camera since 1 October 2026: the film of 30 September put the FPV
   * frame's sports car and the whip frame's house into a transition, told in
   * so many words not to. What a reference shows, the model may film.
   */
  styleFrames: readonly string[];
  /**
   * Approved pictures the film cannot be made without, asked before anything
   * is paid for: a sample flat tour with no picture of the sample flat would
   * have to invent the rooms. An empty list of categories is a format that is
   * never made, and `why` is said to the person. Null: an exterior is enough.
   */
  needs: {
    categories: readonly string[];
    count: number;
    why: string;
    /** Besides those, an approved picture of the building itself (an exterior render). */
    exterior?: boolean;
    /** The pictures counted must be photographs, never renders ("ready to move in" over a render shows a building that may not stand). */
    photographs?: boolean;
    /** Approved selling points the film needs, and how many of them must say how the project connects. */
    points?: number;
    connectivity?: number;
    /**
     * A signed fact the film is about: "offer" needs an approved selling point
     * that is an offer (a payment plan, a waiver, a booking amount); "explain"
     * needs that or at least two priced configurations to explain.
     */
    facts?: "offer" | "explain";
    /** What is said when the selling points or the facts are short. */
    pointsWhy?: string;
    /**
     * Signed facts about the area the film needs: the signed nearby places
     * and the selling points that say how the project connects, counted
     * together. A locality guide with one travel time filled the rest of its
     * thirty seconds with the flat (6 October 2026).
     */
    area?: number;
    /** What is said when the area is short, naming where to add it. */
    areaWhy?: string;
    /** The project's approved location map (a LOCATION_MAP picture), and what is said without one. */
    map?: boolean;
    mapWhy?: string;
  } | null;
  /**
   * When the library holds a picture of the sample flat, at least one scene
   * is filmed inside it. A buyer is buying the home, and until 4 October 2026
   * no Agent on camera film showed one room of it: the flat came last in the
   * list, and a film writer under thirty seconds left it out every time.
   */
  inside?: boolean;
  /**
   * The film is one continuous take with no cut, its scenes moments in it:
   * both real reveals in template 14 are a single ten-second shot, and a film told
   * "cut as four shots" cut to a second place mid-reveal.
   */
  oneTake?: boolean;
  /**
   * Hook cards the format may open on whatever the approved lines say. A
   * silent film has no line of its own to take a hook from, and a dust
   * reveal left to find one put "TOWER" (the picture title) on every shot.
   */
  hooks?: readonly string[];
  /**
   * People scenes may be set in an ordinary place away from the project
   * (`ORDINARY_PLACE`), the way a story opens on a person's day before the
   * home answers it, and a people scene in an approved picture is set inside
   * it. The narrated story's.
   */
  ordinaryPlaces?: boolean;
  /**
   * The colour of a card's big word, ours and the model's alike. The
   * format's magenta by default; a building assembly is white, as its
   * reference reels are, and the model drew magenta when shown magenta.
   */
  cardAccent?: string;
  /**
   * The film builds the approved building in front of the camera: every
   * scene but the last two shows it part assembled, so the eye judges the
   * building only in those two and the sweep reads a half-built frame as
   * the project.
   */
  assembles?: boolean;
  /**
   * The film shows the approved building being BUILT, sped up, on its own
   * plot (land to home): workers, machines, scaffolding and a half-built
   * frame are the format, so the eye judges the building only in the last
   * two scenes and the sweep reads the site as the project.
   */
  builds?: boolean;
  /** At least this many scenes' lines each say a signed area fact (`needs.area`), when the area holds that many. */
  areaLines?: number;
  /**
   * The last scene is the close, and its camera makes one of these moves:
   * the locality guide's ends pulling back from the tower at golden hour, and
   * its film of 13 October 2026 ended on a tight shot of the facade.
   */
  closeMoves?: readonly string[];
  /**
   * The film may show the library's approved location map (a LOCATION_MAP
   * picture), with the project's pin and one plain route drawn on it and
   * nothing written: the locality guide's, after its reels' maps.
   */
  usesMap?: boolean;
  /**
   * Every spoken line is set small at the foot of the picture while it is
   * said, by us (`filmSubtitle()`), as the trade's launch films print theirs.
   */
  subtitles?: boolean;
  /** How the cards we set ourselves look: the reel's heavy kinetic type, or a quiet wide-set name (`filmCard()`). */
  cardStyle?: "kinetic" | "elegant";
  /**
   * Every card is ours (`ourCard()`), never the video model's: the locality
   * guide's carry place names, which the model spelt its own way ("FOR
   * EDANDS", 12 October 2026), so a place name may be on one.
   */
  ourCards?: boolean;
  /** A film that worked, shown to the writer for its energy and shape, never its facts. */
  example: string;
};

/**
 * Agent describing the property (template 17), from its four reference
 * reels (1.9 to 2.7 seconds a shot, a hook aimed at the viewer, specifics,
 * one price, one action) and from the one-call film of 26 September 2026
 * the client rated close to perfect: ten shots of two to three seconds,
 * about eighty words said quickly, six presenter shots, seven text cards.
 * The app's first film used slower numbers (seven to eleven shots, 35 to 55
 * words, a relaxed voice) and came back stretched and flat, so these are
 * that film's numbers, not the reference reels' sixty-second ones scaled down.
 */
export const AGENT_DESCRIBING_SKILL: VideoSkill = {
  key: "17-insta-friendly-agent-describing-property",
  label: "Agent on camera",
  format: "the \"agent describing the property\" format: one presenter talks to the viewer at the project, cut with fast shots of the property",
  seconds: FILM_SECONDS,
  scenes: { min: 9, max: 12 },
  shotSeconds: { min: 1.6, max: 2.6 },
  speech: "presenter",
  presenterScenes: { min: 4, max: 6 },
  peopleScenes: { min: 0, max: 0 },
  presenterOpensAndCloses: true,
  words: { min: 55, max: 80 },
  lineWords: 18,
  // Fewer than the seven the near-perfect film had: every card is a place the
  // model may misspell, and the price card is ours (`isFactCard()`).
  cards: { min: 3, max: 5, words: 5 },
  // Every card is ours since 17 October 2026: drawing "BOOK A SITE VISIT",
  // the video model added "THIS WEEKEND" from her line under it.
  ourCards: true,
  wordsPerSecond: 3,
  beats: [
    "Hook, the first three seconds: the presenter on camera, full body in one of the approved spaces she can stand in (the " +
      "pool deck, the lounge, the balcony, a room of the sample flat), never in front of a picture of the towers from afar, " +
      "arms thrown open, one line that stops " +
      "the scroll and is aimed at the viewer (\"Okay Mumbai, stop scrolling. You have NOT seen a home like this in <the locality>.\"). " +
      "Never the project's name first, and never the viewer called by a group of buyers.",
    "Where it is: one travel time or landmark from the facts, over an FPV drone shot racing up the tower.",
    "The list: four or five specifics from the facts, one to a shot, each over a picture of exactly that thing (the pool line " +
      "over the pool picture). The presenter comes back on camera between them, walking, leaning in, reacting.",
    "A reaction beat or two that sells it the way a person would (\"And from the eighteenth floor up, it's sea facing.\", \"Now look at this.\").",
    "The price, once, if the facts carry one: the presenter says it on camera, leaning into the lens, and the price is that shot's big text.",
    "The close, the last three to five seconds: the presenter, in one of the approved spaces, walks toward the lens and " +
      "points straight at it, saying the card's one action (\"So what are you waiting for? Book your site visit this weekend!\").",
    "The building itself is only ever a fast drone shot with her voice over it: she is never put in front of a picture of " +
      "the towers seen from afar. Every line is said up and clearly, never whispered, and every line says something.",
  ],
  look:
    "Hyper-realistic, like real footage shot on a phone gimbal and an FPV drone, bright natural daylight, punchy contrast, nothing ever static: the " +
    "camera always moves. Property shots are fast: FPV drone rockets up facades, dives and orbits, low fast glides over water, " +
    "whip-pan transitions with motion blur, fast push-ins through rooms, a wide lens.",
  presenter:
    "High energy and playful: constant natural hand gestures, points at the building, walks toward the camera, turns, raises " +
    "an eyebrow, laughs once.",
  // The client asked on 2 October 2026 for the presenter to look as real as
  // possible. Said as a camera sees a real person, in plain looks: the
  // near-perfect film's "natural skin texture (not model-perfect)" was the
  // cue that worked, and the film with no realism cue was called rubbish.
  realism:
    "She looks like a real person filmed on a phone, indistinguishable from real footage: real skin with visible pores, " +
    "fine lines and slight unevenness, a natural, slightly asymmetric face, real hair with loose strands that moves as she " +
    "moves, eyes that blink and catch the light, natural teeth, lips that move exactly with every word, natural hands and " +
    "fingers, clothes with real fabric folds, and the same light, time of day and shadows on her as on the place around her " +
    "(warm and low at dusk, lamp light at night), standing on its floor at its scale. No beauty " +
    "filter; never airbrushed, waxy, glossy, plastic, doll-like or CGI.",
  voice:
    "Casual, upbeat, young urban Mumbai English with a light Indian accent, like an Instagram creator talking to a friend. " +
    "Clear and quick, never robotic. Each line flows in one breath: no dramatic pause inside a line, before a reveal or " +
    "between two words.",
  // Whole cards, never word by word: told "words popping in one by one", the
  // film of 30 September 2026 captioned everything she said, and every word
  // it was not given letter by letter came out misspelt ("A HOME LIKS IN
  // GFRRGO WEST", "SYMNASIUM").
  text:
    "Big text cards, heavy rounded sans-serif in capitals, huge, stacked in two sizes, one word in hot magenta, in the upper " +
    "third. Every card is set on the film afterwards, so keep the upper third of every shot clear and draw no words at all.",
  sound:
    "Only her voice (no other voices), trendy upbeat background music under it, a whoosh on every fast transition.",
  never: [
    "Say or show a number, price or claim that is not in the approved facts.",
    "Say more than one price.",
    "Put the project's name in the first line.",
    "Write a line in Hindi or in Devanagari: the whole film is in English.",
    "Ask for a view, sea, landmark or room the approved pictures do not show.",
    "Write a slow, smooth or gentle shot: every shot moves fast.",
    "Say the same place twice in a row.",
  ],
  // The moves that made the good film, and the words that made the flat one.
  moves: {
    property: ["fpv", "drone", "whip", "fast", "quick", "rocket", "dive", "orbit", "race", "rush", "sweep", "push-in", "glide", "dolly", "fly", "flies", "zoom"],
    forbidden: ["slow", "slowly", "smooth", "smoothly", "gentle", "gently", "calm", "calmly", "static", "still", "steady"],
  },
  styleFrames: [],
  needs: null,
  inside: true,
  example: [
    "1 presenter, the podium pool deck: full-body wide shot, she stands at the edge of the pool deck and throws her arms " +
      "open. Says: \"Okay Mumbai, stop scrolling. You have NOT seen a home like this in Goregaon West.\" Text: \"YOU HAVE NOT SEEN\".",
    "2 property, the tower elevation: FPV drone rockets up the facade, heavy motion blur, whoosh. Says: \"Eight minutes from " +
      "the station.\" Text: \"8 MIN / FROM THE STATION\".",
    "3 property, the towers from the south: a fast drone sweep across both towers. Says: \"Nine towers, spread out across twelve acres.\"",
    "4 presenter, a room of the sample flat: close-up by the window, she leans into the lens, eyebrows up. Says: \"And from the eighteenth " +
      "floor up, it's sea facing.\" Text: \"SEA FACING\".",
    "5 property, the rooftop pool: the drone glides fast and low over the water, golden light. Says: \"A rooftop pool,\"",
    "6 property, the podium pool deck: whip-pan into a fast sliding dolly along the deck. Says: \"a big garden in the middle, and a three-sided open layout.\"",
    "7 property, the clubhouse lounge then the lobby: two quick cuts with fast push-ins and blur. Says: \"Clubhouse, and a lobby like this.\"",
    "8 presenter, a room of the sample flat: she walks in, spins round to the camera and sweeps her hand across the room. " +
      "Says: \"Now look at this sample flat.\"",
    "9 presenter, the entrance lobby: mid shot, she leans into the lens and raises an eyebrow. Says: \"1 BHK homes start at ₹1.45 Cr.\" " +
      "Text: \"1 BHK / ₹1.45 CR\".",
    "10 presenter, the podium pool deck: full body, she walks toward the camera and points straight at the lens, smiling. " +
      "Says: \"So what are you waiting for? Book your site visit this weekend!\" Text: \"BOOK A SITE VISIT\".",
  ].join("\n"),
};

const SKILLS: readonly VideoSkill[] = [AGENT_DESCRIBING_SKILL, ...TEMPLATE_SKILLS];

/**
 * Why a film of this format cannot be made from these approved pictures, or
 * null. Asked before anything is paid for: a sample flat tour with no picture
 * of the sample flat would have to invent the rooms, and a format that is
 * never made (a testimonial a generated person would give) is refused here.
 */
export function skillRefusal(
  skill: VideoSkill,
  pictures: readonly { category: string; isRender?: boolean }[],
  facts: { points: number; connectivity: number; offers?: number; configurations?: number; area?: number } = { points: Infinity, connectivity: Infinity },
): string | null {
  const needs = skill.needs;
  if (!needs) return null;
  if (!needs.categories.length) return needs.why;
  const counted = pictures.filter((p) => needs.categories.includes(p.category) && (!needs.photographs || p.isRender === false));
  if (counted.length < needs.count) return needs.why;
  if (needs.exterior && !counted.concat(pictures.filter((p) => !needs.photographs || p.isRender === false)).some((p) => p.category === "EXTERIOR_RENDER")) {
    return needs.why;
  }
  if ((needs.area ?? 0) > (facts.area ?? Infinity)) return needs.areaWhy ?? needs.pointsWhy ?? needs.why;
  if (needs.map && !pictures.some((p) => p.category === "LOCATION_MAP")) return needs.mapWhy ?? needs.why;
  const offers = facts.offers ?? Infinity;
  const priced = facts.configurations ?? Infinity;
  const unexplained = needs.facts === "offer" ? offers < 1 : needs.facts === "explain" ? offers < 1 && priced < 2 : false;
  const short = (needs.points ?? 0) > facts.points || (needs.connectivity ?? 0) > facts.connectivity || unexplained;
  return short ? needs.pointsWhy ?? needs.why : null;
}

/** The skill for a video template, or null for one still made the older way. */
export function skillFor(templateKey: string | null | undefined): VideoSkill | null {
  return SKILLS.find((s) => s.key === templateKey) ?? null;
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

export type FilmScene = {
  /** The presenter on camera, the property alone, or generated people (a family) in front of an approved picture. */
  kind: "presenter" | "property" | "people";
  /**
   * Which approved picture it is shot from, or stands in front of, by index;
   * `ORDINARY_PLACE` (-1) for a people scene away from the project (an
   * office, a station, a car), where the format allows one.
   */
  picture: number;
  /**
   * What is said over it, as printed (₹1.45 Cr), in the film's language: a
   * Hindi or Marathi film's lines are in Devanagari, their numbers in digits.
   * Said aloud by `spokenForm()` or `spokenFormIn()`.
   */
  line: string;
  /** The big text on screen, or "". */
  text: string;
  /** The camera and the action, in words. */
  shot: string;
  /**
   * How the line is said, in a few words ("quiet and a little tired",
   * "lifting, hopeful", "a laugh in the voice"), "" on a silent shot. The
   * first story film was told "calm and smiling" for the whole film and came
   * back flat and robotic: one tone for every line is a reading, not a story.
   */
  delivery?: string;
};

export type FilmScript = {
  title: string;
  /** The presenter, described once so every scene shows the same person. */
  presenter: string;
  voice: "female" | "male";
  scenes: FilmScene[];
};

/** A people scene shot nowhere near the project: no picture, an ordinary place. */
export const ORDINARY_PLACE = -1;

/** The JSON the writer answers in. */
export const FILM_SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "presenter", "voice", "scenes"],
  properties: {
    title: { type: "string" },
    presenter: { type: "string" },
    voice: { type: "string", enum: ["female", "male"] },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "picture", "line", "text", "shot", "delivery"],
        properties: {
          kind: { type: "string", enum: ["presenter", "property", "people"] },
          picture: { type: "integer" },
          line: { type: "string" },
          text: { type: "string" },
          shot: { type: "string" },
          delivery: { type: "string" },
        },
      },
    },
  },
} as const;

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The writer's answer as a script, or null when it is not one. */
export function parseFilmScript(raw: unknown): FilmScript | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.scenes)) return null;
  const scenes: FilmScene[] = r.scenes.flatMap((x): FilmScene[] => {
    if (!x || typeof x !== "object") return [];
    const s = x as Record<string, unknown>;
    const kind = s.kind === "presenter" || s.kind === "property" || s.kind === "people" ? s.kind : null;
    const picture = typeof s.picture === "number" && Number.isInteger(s.picture) ? s.picture : NaN;
    if (!kind) return [];
    const line = clean(s.line, 300);
    // A voice direction, never a claim: no figure reaches the video model through it.
    const delivery = line ? clean(s.delivery, 100).replace(/[0-9\u0966-\u096F]+/g, "").replace(/\s+/g, " ").trim() : "";
    return [{ kind, picture, line, text: clean(s.text, 60), shot: clean(s.shot, 400), ...(delivery ? { delivery } : {}) }];
  });
  if (!scenes.length) return null;
  return {
    title: clean(r.title, 80) || "Agent on camera",
    presenter: clean(r.presenter, 400),
    voice: r.voice === "male" ? "male" : "female",
    scenes,
  };
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A whole number in words, the Indian way above a thousand (lakh, crore). */
export function numberWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  n = Math.floor(n);
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
  if (n < 1_00_000) return `${numberWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ""}`;
  if (n < 1_00_00_000) return `${numberWords(Math.floor(n / 1_00_000))} lakh${n % 1_00_000 ? ` ${numberWords(n % 1_00_000)}` : ""}`;
  return `${numberWords(Math.floor(n / 1_00_00_000))} crore${n % 1_00_00_000 ? ` ${numberWords(n % 1_00_00_000)}` : ""}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A year as it is said: twenty thirty, not two thousand thirty. */
function yearWords(y: number): string {
  return y >= 2010 && y < 2100 ? `twenty ${numberWords(y % 100)}` : numberWords(y);
}

/** A date from the facts (2030-09-30) as an advertisement says it: September 2030. */
export function monthYear(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso.trim());
  return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

/** "1.45" as it is said: one point four five. */
function decimalWords(raw: string): string {
  const [whole, frac] = raw.replace(/,/g, "").split(".");
  const head = numberWords(Number(whole || "0"));
  return frac ? `${head} point ${[...frac].map((d) => ONES[Number(d)]).join(" ")}` : head;
}

const ORDINAL: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};

function ordinalWords(n: number): string {
  const words = numberWords(n).split(" ");
  const last = words.pop()!;
  const ord = ORDINAL[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...words, ord].join(" ");
}

/**
 * A line as it is SAID, for the video model's voice. The script keeps the
 * printed form (₹1.45 Cr), because that is what the facts write and the gate
 * reads; read as printed, a voice says "rupee one dot four five C R", and
 * "BHK" comes out as a word. So money is said in lakh and crore, BHK as its
 * letters, ordinals and every other figure in words, and a star is dropped.
 */
/**
 * The words of a line the voice cannot say as words once `spokenForm()` has
 * spelled out what it knows: a figure left over, or a short lower-case run of
 * letters with no vowel ("km", "ft", "Rs"), which a voice reads letter by
 * letter. A capitalised acronym ("BKC") is said as its letters, as people say
 * it, and is left alone.
 */
export function unsayable(line: string): string[] {
  const said = spokenForm(line);
  const out = new Set<string>();
  for (const m of said.matchAll(/[A-Za-z0-9]+/g)) {
    const w = m[0];
    if (/\d/.test(w)) out.add(w);
    else if (w.length >= 2 && w.length <= 5 && /[a-z]/.test(w) && !/[aeiouy]/i.test(w)) out.add(w);
  }
  return [...out];
}

export function spokenForm(line: string): string {
  const num = (s: string) => decimalWords(s);
  return toAsciiDigits(line)
    // A date the facts write as 2030-09-30 is said as a month and a year.
    .replace(/\b(20\d\d)-(\d\d)-\d\d\b/g, (_, y: string, m: string) => `${MONTHS[Number(m) - 1] ?? ""} ${yearWords(Number(y))}`)
    .replace(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December|in|by|till|until|from|possession:?)\s+(20\d\d)\b/gi,
      (_, w: string, y: string) => `${w} ${yearWords(Number(y))}`,
    )
    // A full stop after "Cr" ends the sentence as often as the abbreviation,
    // so it is left for the voice to pause on.
    .replace(/(?:₹|\bRs\.?|\bINR)\s*(\d[\d,]*(?:\.\d+)?)\s*(?:Cr|Crore|Crores)\b\*?/gi, (_, n: string) => `${num(n)} crore`)
    .replace(/(?:₹|\bRs\.?|\bINR)\s*(\d[\d,]*(?:\.\d+)?)\s*(?:L|Lakh|Lakhs|Lac|Lacs)\b\*?/gi, (_, n: string) => `${num(n)} lakh`)
    .replace(/(?:₹|\bRs\.?|\bINR)\s*(\d[\d,]*(?:\.\d+)?)\*?/gi, (_, n: string) => `${num(n)} rupees`)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:Cr|crore)\b\*?/gi, (_, n: string) => `${num(n)} crore`)
    // BHK as its three letters, which is how a buyer says it. Said "bedroom"
    // for a day (30 September 2026) because the voice made "B K H" of it, and
    // the client wants BHK; the prompt spells the order out and the voice fix
    // says it again in her voice when it still comes back scrambled.
    // "1.5 BHK" is one point five: read as "5 BHK" after a stray "1.", it was
    // said "one.five B H K" and heard "one five-BHK" (17 October 2026).
    .replace(/(\d+(?:\.\d+)?)\s*BHK\b/gi, (_, n: string) => `${num(n)} B H K`)
    .replace(/\bBHK\b/gi, "B H K")
    .replace(/(\d+)\s*(?:st|nd|rd|th)\b/gi, (_, n: string) => ordinalWords(Number(n)))
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:mins?|minutes?)\b\.?/gi, (_, n: string) => `${num(n)} minutes`)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:km|kms)\b\.?/gi, (_, n: string) => `${num(n)} kilometres`)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*%/g, (_, n: string) => `${num(n)} percent`)
    .replace(/\bsq\.?\s*ft\b\.?/gi, "square feet")
    .replace(/\d[\d,]*(?:\.\d+)?/g, (n) => num(n))
    // A unit after a number written as a word ("three km") is said in full
    // too: sent as "km", the voice read its letters, "k-meter", three times in
    // one film (19 October 2026).
    .replace(/\bkms?\b\.?/gi, "kilometres")
    .replace(/\bmins?\b\.?/gi, "minutes")
    .replace(/\bhrs?\b\.?/gi, "hours")
    .replace(/\b(?:mtrs?|mts)\b\.?/gi, "metres")
    .replace(/\bapprox\b\.?/gi, "about")
    .replace(/\*/g, "")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How local names are said, respelled for a voice that reads English. The
 * app's first film said Goregaon as "Gorecon". Each name used in a line is
 * respelled inside the quoted line itself (the model reads a quote very
 * literally) and listed once more under the lines; the big text keeps the
 * real spelling. A name missing here is said as the model guesses, and the
 * transcript check below still notes it.
 */
export const PRONOUNCE: Readonly<Record<string, string>> = {
  // "Go-ray-gaon" came back "Goregon" on the app's second film; the client
  // says it ends like "gao", and "gow" rhymes with "cow" for an English voice.
  Goregaon: "Go-ray-gow",
  // The same film said "one point four five lakh" for crore, twice over.
  crore: "krore",
  Andheri: "Un-dheh-ree",
  Jogeshwari: "Jo-gesh-wuh-ree",
  Malad: "Maa-laad",
  Kandivali: "Kaan-dee-vuh-lee",
  Borivali: "Bo-ree-vuh-lee",
  Dahisar: "Duh-hee-sar",
  Oshiwara: "O-shee-waa-raa",
  Lokhandwala: "Lo-khand-waa-laa",
  Bandra: "Baan-dra",
  Santacruz: "Saan-taa-krooz",
  Juhu: "Joo-hoo",
  Worli: "Wor-lee",
  Dadar: "Daa-dar",
  Wadala: "Wuh-daa-laa",
  Kurla: "Koor-laa",
  Chembur: "Chem-boor",
  Ghatkopar: "Ghaat-ko-par",
  Vikhroli: "Vik-roh-lee",
  Kanjurmarg: "Kaan-jur-maarg",
  Bhandup: "Bhaan-dup",
  Mulund: "Moo-lund",
  Powai: "Po-why",
  Hiranandani: "Hee-ra-nun-dah-nee",
  Thane: "Thaa-nay",
  Ghodbunder: "Ghod-bun-der",
  Dombivli: "Dom-biv-lee",
  Kalyan: "Kul-yaan",
  Vashi: "Vaa-shee",
  Nerul: "Neh-rool",
  Airoli: "Ai-ro-lee",
  Kharghar: "Khaar-ghar",
  Panvel: "Pun-vel",
  Bhayandar: "Bhai-yun-dar",
  Virar: "Vi-raar",
  Vasai: "Vuh-sai",
  Hinjewadi: "Hin-jay-waa-dee",
  Wakad: "Waa-kud",
  Baner: "Baa-ner",
  Kharadi: "Khuh-raa-dee",
  Hadapsar: "Huh-dup-sar",
  Pimpri: "Pim-pree",
  Chinchwad: "Chinch-waad",
};

const nameRe = (name: string) => new RegExp(`\\b${name}\\b`, "gi");

/**
 * Words the video's own voice has said wrong on live films, and what to say
 * instead. Three films in a row said "plot" as "block", "plaque" and "plac",
 * and "podium" as "paddy"; the one film that said neither word was the one
 * the client called near perfect. A line with one is sent back before
 * anything is paid for.
 */
export const VOICE_HARD_WORDS: Readonly<Record<string, string>> = {
  plot: 'say the acres instead ("nine towers on twelve acres")',
  plots: 'say the acres instead ("nine towers on twelve acres")',
  podium: 'say "a big garden in the middle" instead',
};

/**
 * Words the video model has misspelt on a big text card, and what to do
 * instead: "ACRE" came back "ACER" twice and "PODIUM" as "PODIOM". A place
 * name is refused on a card as well ("GOREGEOW STATION").
 */
export const CARD_HARD_WORDS: Readonly<Record<string, string>> = {
  acre: 'leave the acres off the big text ("9 TOWERS" alone)',
  acres: 'leave the acres off the big text ("9 TOWERS" alone)',
  podium: 'use "CENTRAL GARDEN" or leave it off',
  plot: "leave it off the big text",
};

/** Words a shot uses for a place near the project, which only that place's own photo may show. */
export const NEIGHBOURHOOD = /\b(railway station|station|platform|train|metro|highway|expressway|flyover|mall|school|college|hospital|airport|office park|business park)\b/i;

const wordsOf = (text: string) => text.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);

/** The voice's hard words a line says. */
export function hardSaid(line: string): string[] {
  return [...new Set(wordsOf(line).filter((w) => VOICE_HARD_WORDS[w]))];
}

/** The words a card shows that the model misspells, place names included. */
export function hardShown(text: string): string[] {
  const names = Object.keys(PRONOUNCE).filter((n) => n !== "crore").map((n) => n.toLowerCase());
  return [...new Set(wordsOf(text).filter((w) => CARD_HARD_WORDS[w] || names.includes(w)))];
}

/**
 * The words of the lines (four letters or more, numbers aside) a transcript
 * does not carry, one letter of slack. A word the transcriber writes
 * differently is usually a word said differently: "plaque" for "plot".
 */
export function wordsNotHeard(lines: readonly string[], transcript: string): string[] {
  const heard = wordsOf(transcript).map(unitWord);
  const near = (a: string, b: string) => a === b || (a.length > 4 && b.length > 4 && editDistance(a, b) <= 1) || b.startsWith(a) || a.startsWith(b);
  // Place names have their own note, from the pronunciation list.
  const names = new Set(Object.keys(PRONOUNCE).map((n) => n.toLowerCase()));
  const want = [...new Set(lines.flatMap((l) => wordsOf(spokenForm(l)).map(unitWord)).filter((w) => w.length >= 4 && !NUMBER_WORDS.has(w) && !names.has(w)))];
  const missing = want.filter((w) => !heard.some((h) => near(w, h)));
  // BHK is three short letters, too short for the rule above: "one, two,
  // three homes" for "one BHK homes" went through unnoticed.
  if (lines.some((l) => /\bBHK\b/i.test(l)) && !/\bbhk\b|\bb\W*h\W*k\b/i.test(transcript)) missing.push("BHK");
  return missing;
}

/**
 * A unit as one word however it is spelt or shortened: "kilometres" was
 * flagged as not heard on the locality film of 13 October 2026 because the
 * transcriber wrote "kilometers".
 */
function unitWord(w: string): string {
  if (/^(kilomet(er|re)s?|kms?)$/.test(w)) return "kilometer";
  if (/^(met(er|re)s?|mtrs?)$/.test(w)) return "meter";
  if (/^(minutes?|mins?)$/.test(w)) return "minute";
  return w;
}

const NUMBER_WORDS = new Set([...ONES, ...TENS.filter(Boolean), "point", "crore", "lakh", "hundred", "thousand", "eighteenth", "twelfth"]);

/** How a respelling is meant, where the letters alone could be read two ways. */
export const PRONOUNCE_HINT: Readonly<Record<string, string>> = {
  Goregaon: "the end rhymes with \"cow\", never \"gon\"",
  crore: "rhymes with \"more\"; it is never \"lakh\"",
};

/** The listed names a set of lines says, with how each is said. */
export function namesSaid(lines: readonly string[]): { name: string; say: string; hint: string | null }[] {
  const all = lines.join(" ");
  return Object.entries(PRONOUNCE)
    .filter(([name]) => nameRe(name).test(all))
    .map(([name, say]) => ({ name, say, hint: PRONOUNCE_HINT[name] ?? null }));
}

/** A line with every listed name respelled the way it is said. */
export function sayNames(line: string): string {
  let out = line;
  for (const [name, say] of Object.entries(PRONOUNCE)) out = out.replace(nameRe(name), say);
  return out;
}

/**
 * The listed place names a script says more than once. Each is said once in
 * the whole film: the video's voice says a local name differently every
 * film ("Gorego", "Gorahand"), every saying of one is said again in her
 * voice afterwards (`respeak-rules.ts`), and a name said once is one fix
 * where the client heard the second one as odd (2 October 2026).
 */
export function repeatedNames(lines: readonly string[]): string[] {
  const all = lines.join(" ");
  return Object.keys(PRONOUNCE)
    .filter((n) => n !== "crore")
    .filter((n) => (all.match(nameRe(n)) ?? []).length > 1);
}

/**
 * A script with each listed place name said only its first time: a later
 * "Goregaon station" is "the station". A repeat said any other way is the
 * writer's to fix (`filmProblems()`).
 */
function nameOnce(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.map((line) => {
    let out = line;
    for (const n of Object.keys(PRONOUNCE)) {
      if (n === "crore" || !nameRe(n).test(out)) continue;
      if (seen.has(n)) out = out.replace(new RegExp(`\\b${n}(?:\\s+(?:West|East))?\\s+(station)\\b`, "gi"), "the $1");
      if (nameRe(n).test(out)) seen.add(n);
    }
    return out;
  });
}

/** Words in a line as said. */
export function spokenWords(line: string): number {
  // A Hindi or Marathi line counts its words as said too (its digits in words).
  if (isDevanagari(line)) return wordCount(spokenFormIn(line, /कोटी|आहे|आणि|च्या/.test(line) ? "mr" : "hi"));
  return spokenForm(line).split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
}

// ---------------------------------------------------------------------------
// Numbers, written or said
// ---------------------------------------------------------------------------

const WORD_VALUE: Record<string, number> = Object.fromEntries([
  ...ONES.slice(2).map((w, i) => [w, i + 2] as const),
  ...TENS.slice(2).map((w, i) => [w, (i + 2) * 10] as const),
]);
const ORDINAL_VALUE: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50,
};

/**
 * Every number in a piece of text, as a value: figures (1.45, 2,18,000) and
 * words (eight, twelve, eighteenth, one point four five). "One" alone is
 * left out, because "the one place" is not a claim; "one point..." is kept.
 * Facts are written both ways ("Eight minutes from Goregaon station"), and so
 * are lines and what a transcriber hears, so both sides are read the same way.
 */
export function numberValues(text: string): string[] {
  const out: string[] = [];
  const t = toAsciiDigits(text).toLowerCase();
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.push(String(Number(m[0].replace(/,/g, ""))));
  const words = t.replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "one" && words[i + 1] === "point") {
      let j = i + 2;
      let frac = "";
      while (j < words.length && ONES.indexOf(words[j]) >= 0 && ONES.indexOf(words[j]) < 10) frac += String(ONES.indexOf(words[j++]));
      if (frac) out.push(String(Number(`1.${frac}`)));
      i = j - 1;
      continue;
    }
    if (ORDINAL_VALUE[w]) {
      out.push(String(ORDINAL_VALUE[w]));
      continue;
    }
    const v = WORD_VALUE[w];
    if (v === undefined) continue;
    const next = WORD_VALUE[words[i + 1] ?? ""];
    if (v >= 20 && v % 10 === 0 && next !== undefined && next < 10) {
      out.push(String(v + next));
      i++;
      continue;
    }
    if (words[i + 1] === "point") {
      let j = i + 2;
      let frac = "";
      while (j < words.length && ONES.indexOf(words[j]) >= 0 && ONES.indexOf(words[j]) < 10) frac += String(ONES.indexOf(words[j++]));
      out.push(String(frac ? Number(`${v}.${frac}`) : v));
      i = j - 1;
      continue;
    }
    out.push(String(v));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * A breath after a line, before the cut. Short: the film that set the bar
 * talked across its cuts, and half a second after every line is what made
 * the app's first film drag.
 */
const BREATH = 0.2;
/** A shot with nothing said: long enough to see it, short enough to keep the pace. */
const SILENT = { min: 1.6, max: 2.6 };
/** How much longer than it needs a spoken scene may run before time is spread elsewhere. */
const SPOKEN_SLACK = 0.8;

/** How long the scenes could run at most without dragging; under the film's length, the draft needs more in it. */
/** A scene as timing reads it: its line, and (when known) what happens in it and to whom. */
export type TimedScene = Pick<FilmScene, "line"> & Partial<Pick<FilmScene, "shot" | "kind">>;

/**
 * Seconds one thing a person does takes on screen, read clearly: a door
 * opened, a child lifted, a book handed over. Four of them asked of a
 * three-second shot is how the video model came to borrow and repeat
 * actions (the family story's front door, 6 October 2026).
 */
export const ACTION_SECONDS = 1.1;

/**
 * What one scene needs on screen, and the most it can fill before it drags:
 * the time its line takes at the format's pace, the time its people's
 * actions take, and for a silent shot enough to see it. Planning by words
 * alone gave a line-less shot of four actions under two seconds, and a
 * building held five seconds on a long line with nothing happening.
 */
export function shotNeed(s: TimedScene, wps: number, silent: { min: number; max: number } = SILENT): { need: number; cap: number } {
  const w = spokenWords(s.line);
  const speech = w ? w / wps + BREATH : 0;
  const acts = s.shot && (s.kind === "people" || s.kind === "presenter") ? actionsIn(s.shot) : 0;
  const action = acts * ACTION_SECONDS;
  const need = Math.max(speech, action, w ? 0 : silent.min);
  const cap = Math.max(w ? speech + SPOKEN_SLACK : silent.max, acts ? action + SPOKEN_SLACK : 0);
  return { need, cap };
}

export function timingRoom(scenes: readonly TimedScene[], wps: number, silent: { min: number; max: number } = SILENT): number {
  return scenes.reduce((a, s) => a + shotNeed(s, wps, silent).cap, 0);
}

/**
 * How long each scene runs, adding to the film's length exactly, or null when
 * the words cannot be said in it.
 *
 * Each spoken scene gets what its words need at the skill's pace plus a
 * breath, so no line is ever rushed; each silent one gets enough to see it.
 * What is left over goes first to silent shots and then to spoken ones, up
 * to a ceiling each, so no scene is stretched while another could take the
 * time. Only when every scene is at its ceiling does the rest spread evenly.
 * The prompt hands these to the video model as a plan it may adjust.
 */
export function planTiming(
  scenes: readonly TimedScene[],
  seconds: number,
  wps: number,
  silent: { min: number; max: number } = SILENT,
): number[] | null {
  if (!scenes.length) return null;
  const said = scenes.map((s) => spokenWords(s.line));
  const sized = scenes.map((s) => shotNeed(s, wps, silent));
  const need = sized.map((x) => x.need);
  const total = need.reduce((a, b) => a + b, 0);
  // A plan up to a twentieth over is pressed into the film: a shot's need is
  // an estimate, and three drafts running were refused for 0.3 s of thirty
  // (9 October 2026).
  if (total > seconds * 1.05 + 1e-6) return null;
  if (total > seconds + 1e-6) return need.map((n) => (n * seconds) / total);
  const cap = sized.map((x) => x.cap);
  const t = [...need];
  let left = seconds - total;
  for (let pass = 0; pass < 40 && left > 1e-6; pass++) {
    let open = t.map((v, i) => i).filter((i) => t[i] < cap[i] - 1e-6);
    const lifted = !open.length;
    if (lifted) open = t.map((_, i) => i);
    // Silent shots take spare time first: a drone shot a second longer reads
    // as pace, a line with a second of nothing after it reads as a pause.
    const weight = (i: number) => (said[i] ? 0.6 : 1);
    const sum = open.reduce((a, i) => a + weight(i), 0);
    let given = 0;
    for (const i of open) {
      const share = (left * weight(i)) / sum;
      const add = lifted ? share : Math.min(share, cap[i] - t[i]);
      t[i] += add;
      given += add;
    }
    left -= given;
  }
  // Tenths of a second, and the rounding given back to the longest scene.
  const rounded = t.map((v) => Math.round(v * 10) / 10);
  const drift = Math.round((seconds - rounded.reduce((a, b) => a + b, 0)) * 10) / 10;
  const longest = rounded.indexOf(Math.max(...rounded));
  rounded[longest] = Math.round((rounded[longest] + drift) * 10) / 10;
  return rounded;
}

/** Where each scene starts and ends. */
export function timeline(durations: readonly number[]): { start: number; end: number }[] {
  let at = 0;
  return durations.map((d) => {
    const start = at;
    at = Math.round((at + d) * 10) / 10;
    return { start, end: at };
  });
}

/**
 * When a card we set ourselves is on screen: in just before she starts the
 * line that says it, out just before her next line and at most a second and
 * a half past its last word, the way the model's own cards come and go. Timed
 * from what was heard where that is known, and from the plan stretched to the
 * film's length where it is not (the voice fix did not run).
 *
 * It never runs on into the next scene once its words are said (`sceneEnd`,
 * the scene's real cut): on 18 October 2026 "2 KM / VIBGYOR HIGH SCHOOL"
 * outlived the school photo and sat across her face in the close-up after it.
 */
export function cardWindow(input: {
  said: { start: number; end: number } | null;
  nextSaid: number | null;
  planned: { start: number; end: number };
  length: number;
  /** Where the card's own scene really cuts, when known. */
  sceneEnd?: number | null;
}): { start: number; end: number } {
  const r = (n: number) => Math.round(n * 100) / 100;
  if (input.said) {
    let cap = input.said.end + 1.5;
    // A card never runs on over the next scene: a ₹76 Lakh card stayed on the
    // pool deck at 0:28 because her words ran past the cut (21 October 2026).
    // Only a cut that comes before the words have properly begun is ignored.
    if (input.sceneEnd != null) {
      cap = input.sceneEnd > input.said.start + 0.5 ? Math.min(cap, input.sceneEnd) : Math.min(cap, Math.max(input.said.end + 0.2, input.sceneEnd));
    }
    const end = input.nextSaid !== null ? Math.min(cap, input.nextSaid - 0.1) : cap;
    const cut = input.sceneEnd != null && input.sceneEnd > input.said.start + 0.5;
    return { start: r(Math.max(0, input.said.start - 0.15)), end: r(Math.min(input.length, cut ? end : Math.max(end, input.said.end))) };
  }
  return { start: r(Math.max(0, input.planned.start)), end: r(Math.min(input.length, input.planned.end)) };
}

// ---------------------------------------------------------------------------
// The draft's gate
// ---------------------------------------------------------------------------

/**
 * A card we set on the film ourselves rather than let the video model draw:
 * one carrying a price or a configuration. Those must be exact, and the
 * model's were not: "1 BKH" for "1 BHK", and "₹1.45 CR" drawn with a dollar
 * sign on 30 September 2026. `filmPrompt()` keeps it from the model and
 * `cardWindow()` times it to the line that says it.
 *
 * Two more are ours for the same reason: a month and a year ("SEPTEMBER
 * 2026", the day a construction photo was taken) and the project's own name
 * (`names`), which a model spells its own way.
 */
export function ourCard(skill: Pick<VideoSkill, "ourCards">, text: string, names: readonly string[] = []): boolean {
  return !!text && (!!skill.ourCards || isFactCard(text, names));
}

export function isFactCard(text: string, names: readonly string[] = []): boolean {
  const t = toAsciiDigits(text);
  if (/₹|\brs\.?(?=\s*\d)|\d\s*(?:cr|crores?|l|lakhs?|lacs?)\b|\bbhk\b/i.test(t)) return true;
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:19|20)\d\d\b/i.test(t)) return true;
  const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return names.some((n) => squash(n).length > 2 && cardParts(text).some((part) => squash(part) === squash(n)));
}

/**
 * A draft with the big text tidied, where tidying changes no claim: a card
 * over the word limit is dropped, and past the most cards the format takes,
 * the middle ones go first, so the hook's and the close's stay. The first
 * live writer was sent back twice for a seventh card and a five-word card,
 * each a whole draft for something code could settle. Never below the
 * fewest cards; what cannot be tidied goes back to the writer.
 */
const DECADES: Record<string, string> = { "2": "twenties", "3": "thirties", "4": "forties", "5": "fifties", "6": "sixties", "7": "seventies" };

/** An age written "in his 30s" said in words, which no direction may carry as a figure. */
export function decadesInWords(text: string): string {
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const say = (n: number) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? `-${ones[n % 10]}` : ""}`);
  return String(text ?? "")
    .replace(/\b(?:early |mid |mid-|late )?([2-7])0['’]?s\b/g, (m, d: string) => m.replace(/[2-7]0['’]?s/, DECADES[d]))
    // "a 6-year-old", "age 35", "35 years old": an age, said in words.
    .replace(/\b(\d{1,2})(?=[- ]years?[- ]old\b)/g, (n) => say(Number(n)))
    .replace(/\b(aged?|age of) (\d{1,2})\b/gi, (_, w: string, n: string) => `${w} ${say(Number(n))}`);
}

export function tidyScript(script: FilmScript, skill: VideoSkill): FilmScript {
  const keep = properWords(script.scenes.map((s) => s.line));
  const once = nameOnce(script.scenes.map((s) => s.line));
  const scenes = script.scenes.map((s, i) => ({ ...s, line: flowingLine(once[i], keep), shot: decadesInWords(noCounting(s.shot)) }));
  const count = () => scenes.filter((s) => s.text).length;
  for (const s of scenes) {
    if (s.text && tokens(s.text).length > skill.cards.words && count() > skill.cards.min) s.text = "";
  }
  // A card with a word the model misspells loses that part, or the card:
  // "8 MIN / FROM GOREGAON STATION" becomes "8 MIN".
  for (const s of scenes) {
    if (skill.ourCards || !s.text || !hardShown(s.text).length) continue;
    const kept = cardParts(s.text).filter((p) => !hardShown(p).length);
    if (kept.length) s.text = kept.join(" / ");
    else if (count() > skill.cards.min) s.text = "";
  }
  const order = scenes.map((_, i) => i).filter((i) => i !== 0 && i !== scenes.length - 1);
  // Middle out: the scene furthest from both ends loses its card first.
  order.sort((a, b) => Math.min(b, scenes.length - 1 - b) - Math.min(a, scenes.length - 1 - a));
  for (const i of order) {
    if (count() <= skill.cards.max) break;
    // A price card stays: it is the one the format says to show.
    if (scenes[i].text && !isFactCard(scenes[i].text)) scenes[i].text = "";
  }
  return { ...script, presenter: decadesInWords(script.presenter), scenes };
}

/**
 * A presenter never counts on her fingers: told "she counts on her fingers"
 * over "1 BHK homes start at ₹1.45 Cr.", the film of 2 October 2026 said
 * "one, two, three homes". The gesture becomes a lean into the lens.
 */
export function noCounting(shot: string): string {
  return shot
    .replace(/\b(?:counts?|counting|ticks?|ticking|holds?|holding)\b(?:\s+\w+){0,3}?\s+(?:on|with|up)\s+(?:her|his|their)\s+fingers\b/gi, "leans into the lens")
    .replace(/\b(?:holds?|holding|raises?|raising|shows?|showing)\s+up\s+(?:\w+\s+)?fingers?\b/gi, "leans into the lens");
}

/**
 * Words written with a capital in the middle of a sentence somewhere in the
 * script ("Goregaon", "Mumbai"), which keep it when a sentence is joined on.
 */
function properWords(lines: readonly string[]): Set<string> {
  const out = new Set<string>(Object.keys(PRONOUNCE));
  for (const l of lines) {
    for (const m of l.matchAll(/(?<![.?!]\s*|^\s*)\b([A-Z][\p{L}']*)/gu)) out.add(m[1]);
  }
  return out;
}

/**
 * A line said in one breath: a sentence of one to three words after another
 * in the same line joins it with a comma. Told "And from the eighteenth floor
 * up? Sea facing.", the film of 2 October 2026 paused 1.2 s after the
 * question and 0.6 s between "sea" and "facing", performing the answer as a
 * reveal. No word changes, so nothing the gate read changes.
 */
export function flowingLine(line: string, keep: ReadonlySet<string> = new Set()): string {
  const parts = line.trim().split(/(?<=[.?!])\s+/).filter(Boolean);
  if (parts.length < 2) return line;
  const out: string[] = [parts[0]];
  for (const part of parts.slice(1)) {
    const words = part.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    if (words.length > 3) {
      out.push(part);
      continue;
    }
    const first = part.match(/^[\p{L}']+/u)?.[0] ?? "";
    const lower = first && !keep.has(first) && !(first.length > 1 && first === first.toUpperCase()) && first !== "I";
    const joined = lower ? first.toLowerCase() + part.slice(first.length) : part;
    out[out.length - 1] = `${out[out.length - 1].replace(/[.?!]+$/, "")}, ${joined}`;
  }
  return out.join(" ");
}

/** Words a card may carry whatever the facts say: "BOOK A SITE VISIT" needs its "a". */
const FUNCTION_WORDS = new Set(["a", "an", "the", "at", "to", "of", "in", "on", "and", "from", "for", "up", "your", "you", "is", "it", "this", "with", "now", "just"]);

/** One word written two ways: "min" for "minutes", "tower" for "towers". */
function sameWord(approved: string, used: string): boolean {
  if (approved === used) return true;
  const [short, long] = approved.length <= used.length ? [approved, used] : [used, approved];
  return short.length >= 3 && long.startsWith(short);
}

const tokens = (s: string) =>
  toAsciiDigits(s)
    .toLowerCase()
    .replace(/[₹*]/g, " ")
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);

/**
 * What is wrong with a draft, in words the writer can act on; empty when it
 * may be filmed. Checked before any film is paid for, so a refusal costs one
 * more draft and nothing else.
 */
export function movesNamed(shot: string, words: readonly string[]): string[] {
  const lower = shot.toLowerCase();
  return words.filter((w) => new RegExp(`(?<![a-z])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(lower));
}

/**
 * The approved pictures a presenter can stand in: rooms, the balcony, the
 * lounge, the pool deck, the lobby, each taken at eye level with a floor. Put
 * in front of a render of the towers seen from afar, she was pasted on it:
 * lit for midday against a dusk sky, no shadow, twice the towers' scale (the
 * Palm Grove film of 17 October 2026), while her balcony and kitchen scenes
 * looked real.
 */
export const STANDABLE: readonly string[] = ["SAMPLE_FLAT", "AMENITY", "LOBBY"];

/** A presenter's delivery that is not a presenter's: a whisper came back as "boss". */
const HUSHED = /\b(whisper\w*|hush\w*|murmur\w*|soft(ly)?|quiet(ly)?|breath\w*|under (her|his) breath)\b/i;

/** Words that say nothing about the project, for the check below. */
const EMPTY_WORDS = new Set(["this", "that", "these", "those", "here", "there", "look", "just", "your", "with", "from", "what", "have", "will", "into", "then", "they", "them", "like", "really", "okay", "right"]);

/**
 * What a presenter's film is sent back for, beyond the format's own rules:
 * standing in front of a far-off render when a space she can stand in is
 * approved; a whispered or hushed delivery, which the voice comes back
 * mumbling and the voice fix then says again in a normal voice; and a short
 * line in the middle that says nothing the facts or the pictures carry
 * ("This is the pause."), which only fills time.
 */
export function presenterProblems(script: FilmScript, categories: readonly string[] | undefined, said: readonly string[]): string[] {
  const out: string[] = [];
  const canStand = !!categories?.some((c) => STANDABLE.includes(c));
  const known = new Set(said.flatMap((t) => t.toLowerCase().match(/[a-z]{4,}/g) ?? []));
  script.scenes.forEach((s, i) => {
    const no = i + 1;
    if (s.kind !== "presenter") return;
    if (canStand && categories?.[s.picture] === "EXTERIOR_RENDER") {
      out.push(
        `Scene ${no} puts the presenter in front of a picture of the building from afar, where she looks pasted on. Put her in a space she can stand in (a room of the sample flat, the balcony, the lounge, the pool deck), and film the building as a drone shot with her voice over it.`,
      );
    }
    if (s.delivery && HUSHED.test(s.delivery)) {
      out.push(`Scene ${no} is said "${s.delivery}". She is a high-energy presenter: every line is said clearly and up, never whispered or soft.`);
    }
    const words = (s.line.toLowerCase().match(/[a-z]+/g) ?? []);
    const middle = i > 0 && i < script.scenes.length - 1;
    const content = words.filter((w) => w.length >= 4 && !EMPTY_WORDS.has(w));
    // "Now look at this." points at the shot, which is the reaction beat the format has.
    const pointsAtShot = words.some((w) => ["look", "see", "check", "watch"].includes(w));
    if (middle && s.line && words.length <= 5 && !/\d/.test(s.line) && !pointsAtShot && !content.some((w) => known.has(w))) {
      out.push(`Scene ${no}'s line "${s.line}" says nothing about the project. Give her a line that says something from the facts or about the picture she is in.`);
    }
  });
  return out;
}

export function filmProblems(
  script: FilmScript,
  ctx: {
    skill: VideoSkill;
    cleared: readonly string[];
    neverSay: readonly string[];
    pictures: number;
    /** The approved pictures' titles ("Rooftop pool"): what a picture shows may be named on it. */
    titles?: readonly string[];
    /** Each approved picture's category, by index. */
    categories?: readonly string[];
    /** The signed area facts (nearby places, and the selling points that say how the project connects). */
    area?: readonly string[];
    /** The film's language: Hindi and Marathi lines are in Devanagari. */
    language?: FilmLanguage;
    /** Each scene's line read back into English, for a Hindi or Marathi film. */
    reading?: readonly string[];
    /** The signed places that have their own approved photo, and which picture it is. */
    placePhotos?: readonly { place: string; picture: number }[];
  },
): string[] {
  const { skill } = ctx;
  const out: string[] = [];
  const lang = ctx.language ?? ENGLISH;
  // What is counted (words, time) is what the voice says: the lines as written.
  const counted = script;
  if (lang.code !== "en") {
    script.scenes.forEach((s, i) => {
      if (!s.line) return;
      if (!isDevanagari(s.line)) out.push(`Scene ${i + 1}'s line is not in ${lang.name}. Write it in ${lang.name}, in Devanagari script.`);
      // A Hindi or Marathi story's voice only thinks aloud: no question, no exclamation, nobody addressed.
      if (skill.key === "story" && /[?!]/.test(s.line)) out.push(`Scene ${i + 1}'s line is a question or an exclamation. The voice speaks to nobody in the film: write it as a quiet thought.`);
      const inWords = numberWordsIn(s.line, lang.code as "hi" | "mr");
      if (inWords.length) out.push(`Scene ${i + 1}'s line writes ${inWords.map((w) => `"${w}"`).join(", ")} in words. Write every number in digits (18वीं, 8 मिनट), exactly as the approved facts have it.`);
      if (ctx.reading) {
        // No number the reading does not carry, and every price in digits:
        // "the second ring" is rightly "दूसरी घंटी", but ₹1.45 करोड़ is never words.
        const reading = ctx.reading[i] ?? "";
        const want = new Set(numberValues(reading));
        const got = [...new Set(numberValues(toAsciiDigits(s.line)))];
        const extra = got.filter((v) => !want.has(v));
        const missing = pricesIn([reading]).map((p) => p.amount).filter((v) => !got.includes(v));
        if (extra.length) out.push(`Scene ${i + 1}'s line has ${extra.join(", ")}, and reads as if it did not. Say each number plainly, in digits.`);
        if (missing.length) out.push(`Scene ${i + 1}'s line must write the price ${missing.join(", ")} in digits (₹1.45 करोड़).`);
      }
    });
    // Every other check reads the lines in English, as read back by a
    // model that corrects nothing: claims, never-say, whose story it is,
    // and the length, which reads as near the same in either language.
    if (ctx.reading) script = { ...script, scenes: script.scenes.map((s, i) => (s.line ? { ...s, line: ctx.reading![i] || s.line } : s)) };
  }
  // Every line reaches the voice as words it can say: an abbreviation
  // nothing spells out is read as its letters ("km" came back "k-meter").
  if (lang.code === "en") {
    script.scenes.forEach((s, i) => {
      const bad = unsayable(s.line ?? "");
      if (bad.length) out.push(`Scene ${i + 1}'s line has ${bad.map((b) => `"${b}"`).join(", ")}, which the voice would read as letters. Write it out in full words.`);
    });
  }
  // A film about the area says the area: so many of its lines each carry a
  // signed area fact's number, and the map is talked over, never silent.
  if (skill.areaLines && ctx.area?.length) {
    const want = Math.min(skill.areaLines, ctx.area.length);
    const areaNumbers = new Set(ctx.area.flatMap(numberValues));
    const saying = script.scenes.filter((s) => s.line && numberValues(s.line).some((v) => areaNumbers.has(v))).length;
    if (saying < want) {
      out.push(
        `Most of this film is the area: say at least ${want} of the approved nearby places, one to a scene, each with its own time or distance (${ctx.area.slice(0, 5).join("; ")}). This draft says ${saying}. Give the home two scenes at most.`,
      );
    }
  }
  // A film about the area, map or none (the locality guide is an agent on camera since 15 October 2026).
  if (skill.usesMap || skill.areaLines) {
    const areaPlaces = nearbyPlaces(ctx.area ?? []);
    script.scenes.forEach((s, i) => {
      const category = ctx.categories?.[s.picture];
      if (category === "LOCATION_MAP" && !s.line) {
        out.push(`Scene ${i + 1} is the map: give it a line, her voice over it introducing what is around the project.`);
      }
      // One place to a scene, so the route to it can be shown; and a place
      // with its own approved photo is filmed on that photo: the film of 13
      // October 2026 said the mall over the living room, its photo unused.
      const named = placesNamedIn(`${s.line} ${s.text.replace(/\//g, " ")}`, areaPlaces);
      if (named.length > 1) {
        out.push(`Scene ${i + 1} says ${named.map((n) => n.place).join(" and ")}. Give each place a scene of its own.`);
      } else if (named.length === 1) {
        const photo = ctx.placePhotos?.find((p) => samePlace(p.place, named[0].place));
        // The opening and the close are hers at the project, so a place named
        // there cannot move onto its photo: the writer is told to take the
        // place out, not to move the scene (21 October 2026, three drafts
        // refused for "film this scene on that photo" on the opening).
        const pinned = !!skill.presenterOpensAndCloses && (i === 0 || i === script.scenes.length - 1);
        if (pinned) {
          out.push(
            `Scene ${i + 1} is the ${i === 0 ? "opening" : "close"}, at the project: do not name ${named[0].place} there. ` +
              `Say the locality or nothing, and give ${named[0].place} a scene of its own${photo ? ` on its photo, picture ${photo.picture}` : ""}.`,
          );
        } else if (photo && s.picture !== photo.picture) {
          out.push(`Scene ${i + 1} says ${named[0].place}, which has its own approved photo, picture ${photo.picture}. Film this scene on that photo.`);
        }
      }
      // A place near the project is shown only on its own approved photo.
      const shown = NEIGHBOURHOOD.exec(withoutNegations(s.shot));
      if (shown && category !== "NEARBY_PLACE" && category !== "LOCATION_MAP") {
        out.push(
          `Scene ${i + 1}'s shot shows "${shown[0]}", but its picture is not a photo of that place. Show a nearby place only on its own approved photo; otherwise film the map or the building while the line says it.`,
        );
      }
    });
  }
  if (skill.closeMoves?.length) {
    const last = script.scenes[script.scenes.length - 1];
    const category = last ? ctx.categories?.[last.picture] : undefined;
    const moves = new RegExp(`\\b(${skill.closeMoves.map((m) => m.replace(/[-\s]+/g, "[\\s-]?")).join("|")})\\b`, "i");
    if (!last || last.kind !== "property" || category === "LOCATION_MAP" || category === "NEARBY_PLACE" || !moves.test(withoutNegations(last.shot))) {
      out.push(
        `The last scene is the close: the approved building at golden hour or dusk, the camera pulling back slowly to show the whole tower in its setting (${skill.closeMoves.slice(0, 3).join(", ")}). Never a tight shot of the facade.`,
      );
    }
  }
  if (skill.speech === "presenter") out.push(...presenterProblems(script, ctx.categories, [...ctx.cleared, ...(ctx.titles ?? [])]));
  if (skill.ordinaryPlaces) out.push(...storyProblems(script, counted, lang.code === "en"));
  if (skill.key === "story" && lang.code === "en") {
    out.push(...englishStoryProblems(script));
    // The price is never said in the story, so it is shown: a card of a
    // configuration and its price over the close, as the facts write it.
    const priced = ctx.cleared.find((c) => /₹/.test(c) && /\bBHK\b|\bRK\b|penthouse|villa|plot/i.test(c));
    if (priced && !script.scenes.some((s) => s.text && /₹/.test(s.text))) {
      out.push(`Put the price on a card over the close (the last shot or the one before it), as the facts write it, for example "${priced.replace(/\s*starting\s*/i, " / ").replace(/\*$/, "").toUpperCase()}". The voice never says it.`);
    }
  }
  if (skill.key === "01-launch-film") out.push(...launchFilmProblems(script, ctx.categories));
  script.scenes.forEach((s, i) => {
    const acts = s.kind === "people" || s.kind === "presenter" ? actionsIn(s.shot) : 0;
    if (acts * ACTION_SECONDS > skill.shotSeconds.max + 0.3) {
      out.push(
        `Scene ${i + 1} asks for ${acts} actions in a shot of at most ${skill.shotSeconds.max} s; each needs about a second to read. ` +
          "Keep one or two and move the rest to a shot of their own.",
      );
    }
  });
  const flatPictures = (ctx.categories ?? []).flatMap((c, i) => (c === "SAMPLE_FLAT" ? [i] : []));
  if (skill.inside && flatPictures.length && !script.scenes.some((s) => flatPictures.includes(s.picture))) {
    out.push(`Show the home itself: film at least one scene inside the sample flat (picture ${flatPictures.join(" or ")}).`);
  }
  const n = script.scenes.length;
  if (n < skill.scenes.min || n > skill.scenes.max) out.push(`Write ${skill.scenes.min} to ${skill.scenes.max} scenes; there are ${n}.`);
  const presenting = script.scenes.filter((s) => s.kind === "presenter").length;
  if (presenting < skill.presenterScenes.min || presenting > skill.presenterScenes.max) {
    out.push(
      skill.presenterScenes.max === 0
        ? "This format has no presenter; make every scene a property or people scene."
        : `The presenter is on camera in ${skill.presenterScenes.min} to ${skill.presenterScenes.max} scenes; this draft has ${presenting}.`,
    );
  }
  const people = script.scenes.filter((s) => s.kind === "people").length;
  if (people < skill.peopleScenes.min || people > skill.peopleScenes.max) {
    out.push(
      skill.peopleScenes.max === 0
        ? "This format shows nobody but the presenter; make those scenes property scenes."
        : `People are in ${skill.peopleScenes.min} to ${skill.peopleScenes.max} scenes; this draft has ${people}.`,
    );
  }
  const first = script.scenes[0];
  const last = script.scenes[n - 1];
  if (skill.presenterOpensAndCloses) {
    if (!first || first.kind !== "presenter" || !first.line) out.push("The first scene is the presenter on camera saying the hook.");
    if (!last || last.kind !== "presenter" || !last.line) out.push("The last scene is the presenter on camera saying the one action.");
  }
  if (skill.presenterScenes.max > 0 && (!script.presenter || script.presenter.split(/\s+/).length < 8)) {
    out.push("Describe the presenter: age in words, look, hair, outfit.");
  }
  if (skill.speech === "none" && script.scenes.some((s) => s.line)) out.push('Nobody speaks in this format; leave every line empty ("").');

  script.scenes.forEach((s, i) => {
    const no = i + 1;
    if (s.picture === ORDINARY_PLACE) {
      if (!skill.ordinaryPlaces || s.kind !== "people") {
        out.push(`Scene ${no} names no picture; only a people scene in this format may be set in an ordinary place, and every other scene names one.`);
      }
    } else if (!Number.isInteger(s.picture) || s.picture < 0 || s.picture >= ctx.pictures) {
      out.push(`Scene ${no} names picture ${s.picture}, and the pictures are numbered 0 to ${ctx.pictures - 1}.`);
    }
    if (spokenWords(counted.scenes[i]?.line ?? s.line) > skill.lineWords) out.push(`Scene ${no}'s line is too long to say in one shot; keep it to ${skill.lineWords} words as said.`);
    // A Hindi or Marathi film's lines are checked above; its cards stay English.
    if (/[ऀ-ൿ]/.test(lang.code === "en" ? `${s.line} ${s.text}` : s.text)) {
      out.push(lang.code === "en" ? `Scene ${no} is not in English. The whole film is in English.` : `Scene ${no}'s big text is not in English capitals. Cards stay English.`);
    }
    if (!s.shot) out.push(`Scene ${no} needs its camera and action described.`);
    // The format's own moves: a fast reel refuses "slow", a slow tour refuses "whip".
    // Forbidden words are whole words ("still" is not "stillness"); required ones are word starts ("orbit" finds "orbits").
    const wrong = movesNamed(withoutNegations(s.shot), skill.moves.forbidden).filter((w) =>
      new RegExp(`(?<![a-z])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`).test(withoutNegations(s.shot).toLowerCase()),
    );
    if (wrong.length) {
      out.push(`Scene ${no}'s shot says "${wrong[0]}", which is not how this format moves; use its own moves (${skill.moves.property.slice(0, 8).join(", ")}).`);
    }
    // The map's own shot is set by us (`layMapShots()`), so it names no move.
    const ourMap = skill.usesMap && ctx.categories?.[s.picture] === "LOCATION_MAP";
    if (s.kind === "property" && s.shot && !ourMap && skill.moves.property.length && !movesNamed(s.shot, skill.moves.property).length) {
      out.push(`Scene ${no} is a property shot with no camera move this format uses; name one (${skill.moves.property.slice(0, 8).join(", ")}).`);
    }
    if (s.kind === "presenter" && s.shot && !/\b(walk|spin|turn|lean|point|count|sweep|throw|open|gestur|step|reach|lift|wave|laugh|nod)/i.test(s.shot)) {
      out.push(`Scene ${no} is a presenter shot with nothing for her body to do; give her an action (walks toward the lens, spins round, leans in, points, sweeps a hand).`);
    }
  });

  const each = counted.scenes.map((s) => spokenWords(s.line));
  const words = each.reduce((a, b) => a + b, 0);
  if (words < skill.words.min || words > skill.words.max) {
    out.push(
      `All the lines together come to ${words} words as said; write ${skill.words.min} to ${skill.words.max}, so every line is said clearly and unhurried` +
        (words > skill.words.max
          ? `: cut at least ${words - skill.words.max} words, from the longest lines (${each
              .map((n, i) => ({ n, i }))
              .sort((a, b) => b.n - a.n)
              .slice(0, 2)
              .map((x) => `scene ${x.i + 1} has ${x.n}`)
              .join(", ")}). `
          : `: add at least ${skill.words.min - words}. `) +
        `Scene by scene, as said: ${each.join(", ")}. A price counts as said (₹1.45 Cr is five words), and so does 1 BHK (four: one B H K).`,
    );
  } else if (!planTiming(counted.scenes, skill.seconds, skill.wordsPerSecond, skill.shotSeconds)) {
    // Said in numbers, so the writer can act on it: "say less" alone came
    // back three drafts running two seconds over (7 October 2026).
    const needs = counted.scenes.map((s) => shotNeed(s, skill.wordsPerSecond, skill.shotSeconds).need);
    const total = needs.reduce((a, b) => a + b, 0);
    out.push(
      `The shots need ${total.toFixed(1)} seconds as written and the film has ${skill.seconds}: cut ${(total - skill.seconds + 0.5).toFixed(1)} seconds. ` +
        `Scene by scene they need ${needs.map((n, i) => `${i + 1}: ${n.toFixed(1)}`).join(", ")} (about ${skill.wordsPerSecond} words a second of speech, and a second for each thing a person does). ` +
        "Drop a shot with no line, take an action out of a busy shot, or shorten a long line.",
    );
  } else if (timingRoom(counted.scenes, skill.wordsPerSecond, skill.shotSeconds) < skill.seconds) {
    // Too little in it: filling thirty seconds would stretch shots, which is
    // what made the app's first film drag.
    out.push(`There is too little in it to fill ${skill.seconds} seconds without dragging a shot; add a quick shot or a line.`);
  }

  // Every number is one the approved facts carry, written either way.
  const allowed = new Set(ctx.cleared.flatMap(numberValues));
  script.scenes.forEach((s, i) => {
    const bad = [...new Set(numberValues(`${s.line} ${s.text}`).filter((v) => !allowed.has(v)))];
    if (bad.length) out.push(`Scene ${i + 1} uses ${bad.join(", ")}, which the approved facts do not have. Use only their numbers.`);
  });

  // The big text: few cards, few words, and only words that were approved.
  const cards = script.scenes.map((s) => s.text).filter(Boolean);
  if (cards.length < skill.cards.min || cards.length > skill.cards.max) {
    out.push(`Put big text on ${skill.cards.min} to ${skill.cards.max} scenes; this draft has ${cards.length}.`);
  }
  const approvedWords = [...new Set([...ctx.cleared, ...(ctx.titles ?? [])].flatMap(tokens))];
  script.scenes.forEach((s, i) => {
    if (!s.text) return;
    if (skill.hooks?.some((h) => h.toUpperCase() === s.text.trim().toUpperCase())) return;
    const ws = tokens(s.text);
    if (ws.length > skill.cards.words) out.push(`Scene ${i + 1}'s big text has ${ws.length} words; keep it to ${skill.cards.words}.`);
    const known = [...approvedWords, ...tokens(s.line)];
    const stray = ws.filter((w) => !/^[\d.]+$/.test(w) && !FUNCTION_WORDS.has(w) && !known.some((k) => sameWord(k, w)));
    if (stray.length) out.push(`Scene ${i + 1}'s big text uses "${stray.join(" ")}", which no approved line or its own line says. Take its words from those.`);
  });

  // A local name is said once in the whole film.
  for (const n of repeatedNames(script.scenes.map((s) => s.line))) {
    out.push(`"${n}" is said more than once. Say it once in the whole film; after that say "the station", "here" or "this place", or leave it off a longer name ("Inorbit Mall", not "Inorbit Mall Malad").`);
  }

  // Words the video model says or spells wrong, kept out before it is paid.
  script.scenes.forEach((s, i) => {
    for (const w of hardSaid(s.line)) out.push(`Scene ${i + 1} says "${w}", which the video's voice gets wrong; ${VOICE_HARD_WORDS[w]}.`);
    if (!skill.ourCards) for (const w of hardShown(s.text)) out.push(`Scene ${i + 1}'s big text has "${w}", which the video model misspells; ${CARD_HARD_WORDS[w] ?? "keep place names off the big text"}.`);
  });

  // Never-say, anywhere in the draft.
  const all = [script.title, script.presenter, ...script.scenes.flatMap((s) => [s.line, s.text, s.shot])].join(" ").toLowerCase();
  for (const phrase of ctx.neverSay) {
    const p = phrase.trim().toLowerCase();
    if (p.length >= 3 && all.includes(p)) out.push(`"${phrase.trim()}" is on the never-say list.`);
  }

  // Directions to the camera carry no numbers and never change the property.
  // Each named, with the figure it carries: told only "a camera direction",
  // Sarvam's writer sent the same number back three drafts running (8 October 2026).
  const directions: [string, string][] = [["The people's description", script.presenter], ...script.scenes.map((s, i): [string, string] => [`Scene ${i + 1}'s shot`, s.shot])];
  for (const [who, text] of directions) {
    for (const p of guardAgentText({ texts: [text], cleared: ctx.cleared, neverSay: [], maxChars: 400 })) {
      const figures = [...new Set(toAsciiDigits(String(text ?? "")).match(/\d+(?:[.,]\d+)?/g) ?? [])];
      out.push(`${who}: ${p}${/number/.test(p) && figures.length ? ` It has ${figures.map((f) => `"${f}"`).join(", ")}.` : ""}`);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// What the writer is told
// ---------------------------------------------------------------------------

export type FilmBrief = {
  project: string;
  locality: string;
  headline: string;
  body: string;
  cta: string;
  facts: readonly string[];
  neverSay: readonly string[];
  pictures: readonly { category: string; title: string | null }[];
  wide: boolean;
  /** The film's language; English when absent. */
  language?: FilmLanguage;
};

/**
 * The place as it is said: the locality, the last part of the signed
 * location ("Near City Pond, Sebastian Road, Goregaon West" is "Goregaon
 * West"). Told only "the shortest name", the first live writer said "Near
 * City Pond".
 */
export function spokenPlace(location: string): string {
  return location.split(",").map((p) => p.trim()).filter(Boolean).pop() ?? location;
}

export function writerInstruction(skill: VideoSkill, b: FilmBrief): { system: string; text: string } {
  const talks = skill.speech !== "none";
  const presenter = skill.presenterScenes.max > 0;
  const people = skill.peopleScenes.max > 0;
  const speaker = skill.speech === "presenter" ? "She" : "The narrator";
  const flats = b.pictures.flatMap((p, i) => (p.category === "SAMPLE_FLAT" ? [i] : []));
  const shotLength = `${secs(skill.shotSeconds.min)} to ${secs(skill.shotSeconds.max)} seconds`;
  const cast = [
    presenter
      ? `${skill.presenterScenes.min} to ${skill.presenterScenes.max} of them are the presenter` +
        (skill.presenterOpensAndCloses ? ", the first and the last among them" : "")
      : "",
    people ? `${skill.peopleScenes.min} to ${skill.peopleScenes.max} show people` : "",
  ].filter(Boolean);
  return {
    system:
      `You write ${skill.seconds}-second "${skill.label}" films for Indian real-estate developers: ${skill.format}. ` +
      `A video model films your scenes in one go, with ${talks ? "its own voice and music" : "its own music and nobody speaking"}, ` +
      "so what you write is exactly what is said and shown. Every claim must come from the approved facts, word for word where " +
      "it carries a number. Return JSON only.",
    text: [
      talks
        ? `THE PROJECT: ${b.project}, at ${b.locality}. Say the place as "${spokenPlace(b.locality)}", ONCE in the whole film (after that "the station", ` +
          `"here"), and name no other place except as a distance from it. The video's voice says local names wrong, so every name is said once.`
        : `THE PROJECT: ${b.project}, at ${b.locality}. Nobody speaks in this film, and no place name goes on the big text.`,
      `THE FILM: ${b.wide ? "wide 16:9" : "vertical 9:16"}, ${skill.seconds} seconds, ${skill.scenes.min} to ${skill.scenes.max} scenes.`,
      "",
      "HOW THE FORMAT GOES:",
      ...skill.beats.map((x) => `- ${x}`),
      "",
      "APPROVED FACTS (the only claims you may make; any number must be one of theirs):",
      ...b.facts.map((f) => `- ${f}`),
      `The card: headline "${b.headline}", line "${b.body}", action "${b.cta}".`,
      b.neverSay.length ? `NEVER SAY, in any wording: ${b.neverSay.join("; ")}.` : "",
      "",
      skill.ordinaryPlaces
        ? `APPROVED PICTURES (every scene names one by index; a people scene inside the project is shot in its picture, and a people scene in an ordinary place away from the project (an office, a station, a car, a cafe) names picture ${ORDINARY_PLACE}):`
        : `APPROVED PICTURES (every scene names one by index${presenter || people ? "; a presenter or people scene is shot in front of its picture" : ""}):`,
      ...b.pictures.map((p, i) => `${i}: ${p.title || p.category.toLowerCase().replace(/_/g, " ")} (${p.category.toLowerCase().replace(/_/g, " ")})`),
      "",
      "A FILM THAT WORKED, for another brief of this kind. Match its energy, rhythm, number of shots and kind of direction; " +
        "never copy its facts, numbers or pictures, only what your own facts and pictures support:",
      skill.example,
      "",
      "RULES:",
      ...(talks && b.language && b.language.code !== "en" ? [lineRule(b.language)] : []),
      `- ${skill.scenes.min} to ${skill.scenes.max} shots of ${shotLength} each, like the example.` +
        (cast.length ? ` ${cast.join("; ")}; the rest are property shots.` : " Every shot is a property shot."),
      "- You do not have to use every picture. Use only the ones that belong to this film, and film one picture for two or three " +
        "shots rather than add a scene that does not fit: every shot follows from the one before it (the same people, the same " +
        "moment, the same thread), never a jump to another place just to show one more picture.",
      `- Time is planned from what each shot holds: ${talks ? `about ${skill.wordsPerSecond} words a second of speech, and ` : ""}about a second ` +
        `for each thing a person does. A shot of ${shotLength} shows one or two actions, never more; a shot with nothing new in it drags. ` +
        "Fill the film with shots that each carry one clear moment, rather than few shots that carry many.",
      ...(skill.inside && flats.length
        ? [
            `- Show the home itself: at least one scene is inside the sample flat (picture ${flats.join(" or ")}), ` +
              (presenter ? "the presenter walking into the room or the camera pushing through it." : "the camera pushing through the room."),
          ]
        : []),
      ...(talks
        ? [
            `- ${skill.words.min} to ${skill.words.max} words in all, counted the way they are SAID (aim for about ${Math.round((skill.words.min + skill.words.max) / 2)}), ` +
              `at most ${skill.lineWords} in one shot. ${speaker} talks across the cuts, clear and unhurried at the format's pace, like the example. ` +
              "A price counts as said: \"₹1.45 Cr\" is five words (one point four five crore) and \"1 BHK\" is four (one B H K).",
            "- Lines sound like a real person talking to a friend: short, warm, contractions, no brochure words (no \"luxurious\", " +
              "\"world-class\", \"premium lifestyle\"). Never read a fact out as it is written; say it the way you would to a friend. " +
              "Write a price exactly as the facts write it, and say it once.",
            "- Never say the street address, never \"Tower C is in\", and never the same place twice in a row.",
            "- Each line is one flowing sentence or two full ones. Never a question answered by a fragment (\"The top floors? Sea " +
              "facing.\") and never a sentence of one to three words after another: the voice performs those as a dramatic pause. " +
              "Write \"and the top floors face the sea.\"",
            "- \"delivery\": how each line is said, in a few plain words, so the voice acts the story rather than reading it: " +
              "the feeling, how loud and how high (\"quiet, a little tired, almost to himself\", \"lifting, hopeful, a smile in it\", " +
              "\"bright, a small laugh\", \"soft and sure\"). It follows the story: the lines must not all sound the same. \"\" when the shot has no line.",
            "- Keep words easy to say clearly: no tongue twisters, no abbreviations except BHK. The video's voice gets these wrong, so " +
              `never say them: ${Object.entries(VOICE_HARD_WORDS).map(([w, how]) => `"${w}" (${how})`).join(", ")}.`,
          ]
        : ['- Nobody speaks: every "line" is "". The pictures, the camera, the music and the few cards carry the film.']),
      "- The approved lines can carry a typo; write every word correctly when you use it.",
      skill.ourCards
        ? "- Every card is set on the film by us afterwards, so a place name may be on one. A card for a nearby place is exactly the card the facts give it."
        : `- The video model misspells these on big text, so never put them there: ${Object.keys(CARD_HARD_WORDS).map((w) => w.toUpperCase()).join(", ")}, ` +
          "or any place name (\"FROM THE STATION\", not \"FROM GOREGAON STATION\").",
      `- Big text ("text") on ${skill.cards.min} to ${skill.cards.max} shots, at most ${skill.cards.words} words each, every word taken ` +
        "from an approved fact, a picture's title or that shot's own line. \"\" for none. \"BIG / small\" sets two sizes, the first huge " +
        "and the second small under it (\"8 MIN / FROM THE STATION\"). Prefer short, everyday words: a video model misspells long or " +
        "unusual ones (it set \"PODIOM\" for \"PODIUM\"). A price card is the configuration and the price exactly as the facts " +
        "write them (\"1 BHK / ₹1.45 CR\"); we set that one on the film ourselves.",
      "- \"shot\": the camera and the action in plain words with no number, written the way the example writes them. Every property " +
        `shot names one of this format's camera moves (${skill.moves.property.join(", ")}).` +
        (presenter
          ? " Every presenter shot gives her body something to do (walks toward the camera, turns, leans into the lens, points, " +
            "sweeps a hand), and she never counts on her fingers: the voice counts aloud with them."
          : "") +
        (skill.moves.forbidden.length ? ` Never write ${skill.moves.forbidden.map((w) => `"${w}"`).join(", ")} in a shot: this format does not move that way.` : "") +
        " A property shot shows only what its picture shows.",
      presenter
        ? "- \"presenter\": one Indian person, their age in words, hair, outfit (a strong solid colour reads well) and accessories, so " +
          "every shot shows the same person. An ordinary, real-looking person, the way a real creator looks (not a model or a " +
          "glamour shot), with one small natural detail (a few loose strands, a mole, light stubble, laugh lines). No famous person."
        : people
          ? "- \"presenter\": the people in the people scenes, described once (how many, ages in words, looks, outfits), so every " +
            "people scene shows the same people. Ordinary, real-looking Indian people, never named, never a famous person, never " +
            "talking to the camera as a buyer and never said to have bought or to live here. Give each person what makes them " +
            "recognisable in every shot: the face (its shape and one distinctive detail: glasses, a moustache, a mole, greying " +
            "temples, a bindi), the hair, and one outfit in named colours that they wear in every shot."
          : "- \"presenter\": \"\" (nobody is on camera).",
      ...skill.never.map((x) => `- Never: ${x}`),
    ]
      .filter((x) => x !== "")
      .join("\n"),
  };
}

const secs = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// ---------------------------------------------------------------------------
// What the video model is told
// ---------------------------------------------------------------------------

/**
 * A card's words spelled letter by letter, so a model that corrects spelling
 * has nothing to correct ("1 BKH" came back once for "1 BHK"). Figures stay
 * as they are.
 */
export function spelled(card: string): string {
  return card
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/[A-Z]/.test(w) ? [...w].join("-") : w))
    .join(", ");
}

const categoryWords = (c: string) => c.toLowerCase().replace(/_/g, " ");

export type FilmPromptInput = {
  skill: VideoSkill;
  script: FilmScript;
  durations: readonly number[];
  /** Every approved picture, by the script's index. */
  pictures: readonly { category: string; title: string | null }[];
  wide: boolean;
  /** The project and where it is, as the references line names them. */
  project: string;
  locality: string;
  /** Style frames sent first (`skill.styleFrames`), and whether the text-style card follows them. */
  styleFrames: number;
  textCard: boolean;
  /** The film's language; English when absent. */
  language?: FilmLanguage;
  /**
   * The narration is recorded on its own and laid over afterwards (a Hindi or
   * Marathi story, `localVoiceover()`): the film is asked for its score and
   * real sounds, and no voice at all.
   */
  narratedLater?: boolean;
  /** A new version: the person's note, and what the checks found on the first. */
  revision?: {
    note: string;
    problems: readonly string[];
    /**
     * Made fresh from the shot list, with no earlier film sent in: what was
     * wrong was the story itself (whose voice, the order, an action that made
     * no sense), and a film sent in as @Video1 is copied, voice and all.
     */
    fresh?: boolean;
  } | null;
  /**
   * A presenter's reel directed before it is filmed (Agent on camera behind
   * `AGENT_LIKE_STORY`, 10 October 2026): every shot keeps what this prompt
   * already says and gains its framing, lens, blocking and one action, and
   * every place its fixed layout.
   */
  direction?: FilmDirection | null;
  /**
   * Her voice is recorded already and sent as @Audio1 (`voice-track.ts`, 19
   * October 2026): she says it, in its voice and at its times, and the
   * times below are where its lines fall.
   */
  voiceTrack?: boolean;
};

/** The picture indices a script uses, in the order they become the property references. */
export function picturesUsed(script: FilmScript): number[] {
  return [...new Set(script.scenes.map((s) => s.picture).filter((p) => p >= 0))];
}

/** A card's parts: "8 MIN / FROM THE STATION" is a huge part and a small one. */
export function cardParts(text: string): string[] {
  return text.split(/\s*\/\s*/).map((t) => t.trim()).filter(Boolean);
}

/**
 * The one prompt, laid out the way the prompt that made the client's
 * near-perfect film on 26 September 2026 was: the format and the look, the
 * references (style first, then the real project), the presenter, the
 * voice, the time plan, every shot with its line and its big text, the
 * sound. The app's first film was built from a rewritten layout (no style
 * references, relaxed voice, a presenter described without the realism
 * cues, a font the person had picked) and came back stiff and flat, so this
 * follows that prompt closely and adds only what it lacked: the time plan,
 * the spelling of every card, how local names are said, and the clear
 * corner for the registration badge.
 */
export function filmPrompt(p: FilmPromptInput): string {
  const { skill, script } = p;
  // A narration recorded on its own: the film itself says nothing.
  const later = !!p.narratedLater && skill.speech === "voiceover";
  const refs = picturesUsed(script);
  const lead = p.styleFrames + (p.textCard ? 1 : 0);
  const tag = (i: number) => `@Image${lead + refs.indexOf(i) + 1}`;
  const styleTags = Array.from({ length: p.styleFrames }, (_, k) => `@Image${k + 1}`);
  const textTag = p.textCard ? `@Image${p.styleFrames + 1}` : null;
  const times = timeline(p.durations);
  const male = script.voice === "male";
  const She = male ? "He" : "She";
  const her = male ? "his" : "her";
  const person = male ? "man" : "woman";
  const lines = script.scenes.map((s) => s.line).filter(Boolean);
  const lang = p.language ?? ENGLISH;
  const local = lang.code !== "en";
  // From what is said, so a unit (crore) is listed with the names. A film
  // in Hindi or Marathi says its names in their own script, which the voice
  // reads right.
  const names = local ? [] : namesSaid(lines.map(spokenForm));
  // Only the cards the model draws; a price or configuration card is ours.
  const cards = script.scenes
    .filter((s) => s.text && !ourCard(skill, s.text, [p.project]))
    .map((s) => cardParts(s.text).map((t) => `"${t.toUpperCase()}"`).join(" over "));
  const bhk = !local && lines.some((l) => /\bBHK\b/i.test(l));
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? "");
  const seconds = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  const shots = script.scenes.map((s, i) => {
    const at = `Shot ${i + 1} (${seconds(times[i].start)} to ${seconds(times[i].end)} s)`;
    const where =
      s.picture === ORDINARY_PLACE
        ? "in an ordinary place away from the project, with no building of the project in it"
        : s.kind === "presenter"
          ? STANDABLE.includes(p.pictures[s.picture]?.category ?? "")
            ? `standing inside the real place ${tag(s.picture)} shows, on its own floor, at its own scale, lit by its own light, her shadow falling the way its shadows fall`
            : p.pictures[s.picture]?.category === "NEARBY_PLACE"
              ? `standing on the footpath or forecourt right in front of the real place ${tag(s.picture)} shows, the place filling the frame behind ${male ? "him" : "her"} exactly as the photo shows it (nothing added to it), at its scale and in its own daylight, ${male ? "his" : "her"} feet and shadow on its ground, never in the road, on the tracks or inside it, and never up on a ledge, a parapet, a divider or a wall: on a road or a highway she stands on the pavement or behind its railing`
              : `on the ground in front of ${tag(s.picture)}, lit by the same light and time of day as it, ${male ? "his" : "her"} feet and shadow on its ground, the building far behind ${male ? "him" : "her"}`
          : s.kind === "people"
            ? skill.ordinaryPlaces
              ? `inside ${tag(s.picture)}, the place exactly as the reference shows it`
              : `in front of ${tag(s.picture)}`
            : `in ${tag(s.picture)}`;
    // The line is quoted as written, and how names are said is listed once
    // under the voice. Respelled inside the quote ("Go-ray-gow West"), it came
    // back as "Gorego West" and leaked into a card as "GOREGEOW STATION".
    const said = !s.line ? "" : lang.code !== "en" && isDevanagari(s.line) ? spokenFormIn(s.line, lang.code) : spokenForm(s.line);
    const how = s.delivery ? `, ${s.delivery.replace(/[.\s]+$/, "")}` : "";
    const talk = later
      ? said
        ? ` A narrator is laid over this shot afterwards, so the moment is unhurried${how}.`
        : ""
      : said
        ? s.kind === "presenter" && skill.speech === "presenter"
          ? ` ${She} says${how}: "${said}"`
          : ` Voice-over${how}: "${said}"`
        : "";
    // A still render handed over for a shot came back as that picture held
    // still for four seconds (the first story film, 0:07 to 0:10).
    // A build's camera is locked, so there it is the build that never pauses.
    const moving =
      s.kind !== "property"
        ? ""
        : skill.builds && i < script.scenes.length - 1
          ? " The build never pauses in this shot: something on the plot changes every moment while the camera stays locked."
          : " The camera keeps moving to the last frame of the shot, and something in it moves too (clouds, trees, light, water); the picture never stands still.";
    // The spelling sits beside the card: the app's first film set "PODIOM"
    // with the spelling only at the end of the prompt. A shot with no card is
    // told so, or the model captions what she says there.
    const ours = ourCard(skill, s.text, [p.project]);
    const parts = s.text && !ours ? cardParts(s.text).map((t) => t.toUpperCase()) : [];
    const text = ours
      ? " No words on screen in this shot; keep the upper third of the frame clear, a card is placed there afterwards."
      : !parts.length
        ? " No words on screen in this shot."
        : parts.length === 1
          ? ` Big text card, popping in whole: "${parts[0]}" (spelled ${spelled(parts[0])}).`
          : ` Big text card, popping in whole: "${parts[0]}" huge, "${parts[1]}" small under it (spelled ${spelled(parts[0])}; ${spelled(parts[1])}).`;
    const dir = p.direction?.shots[i];
    const directed = dir
      ? ` Framing: ${dir.frame}, ${dir.lens}° ${LENS_WORDS[dir.lens] ?? ""} lens, ${clean(dir.camera)}.` +
        (dir.people.length && clean(dir.blocking) ? ` ${clean(dir.blocking)}.` : "") +
        (clean(dir.action) ? ` ${clean(dir.action)}.` : "") +
        (clean(dir.objects) ? ` ${clean(dir.objects)}.` : "")
      : "";
    return `${at}: ${s.shot.replace(/[.\s]+$/, "")}, ${where}.${directed}${moving}${talk}${text}`;
  });
  const d = p.direction;
  const directionLines = d
    ? [
        ...(d.characters.length ? [`Exactly how ${d.characters.length > 1 ? "they look" : "the presenter looks"}, the same in every shot: ${d.characters.map((c) => `${c.label}: ${c.look}`).join(" ")}`] : []),
        ...(d.places.length
          ? [
              `Where things are: ${d.places
                .map((pl) => `${pl.label}${pl.picture >= 0 && refs.includes(pl.picture) ? ` (${tag(pl.picture)})` : ""}: ${clean(pl.layout)}.`)
                .join(" ")} Every place keeps this layout in every shot that uses it.`,
            ]
          : []),
        ...(d.lighting ? [`Light: ${d.lighting}`] : []),
        ...(d.physics ? [`Physics: ${d.physics} Every hand has exactly five fingers.`] : []),
        "",
      ]
    : [];
  function clean(t: string): string {
    return withoutDoors(withoutCards(t)).replace(/[.\s]+$/, "");
  }

  const presenting = skill.presenterScenes.max > 0;
  const people = skill.peopleScenes.max > 0;
  const talks = skill.speech !== "none" && !later;
  const Whose = skill.speech === "voiceover" ? "The narrator's" : her === "his" ? "His" : "Her";
  const sayHow =
    (names.length ? ` Say ${names.map((n) => `${n.name} as "${n.say}"${n.hint ? ` (${n.hint})` : ""}`).join(", ")}.` : "") +
    // "Its three letters" with "B, H, K" as a list, on a shot where she
    // counted on her fingers, came back "one, two, three homes" (2 October
    // 2026): the letters are said as one word, with no number near them.
    (bhk ? ' Say BHK as one word spelled out, "bee-aitch-kay", in that order, never "B K H".' : "") +
    // The app's second film said "one point four five lakh" for crore.
    (local
      ? ` Every line is in ${lang.name}, spoken exactly as written below in Devanagari, never translated into English` +
        (lang.style === "mixed" ? ", with the English words in it said the way a Mumbai buyer says them." : ".") +
        (pricesIn(lines).length ? ` ${lang.code === "hi" ? "करोड़" : "कोटी"} is never लाख, and लाख is never ${lang.code === "hi" ? "करोड़" : "कोटी"}.` : "") +
        localSayHow(lines.map((l) => (isDevanagari(l) ? spokenFormIn(l, lang.code as "hi" | "mr") : l)), lang.code as "hi" | "mr")
      : pricesIn(lines).length
      ? ` Say every amount exactly as written, the unit too: ${pricesIn(lines).map((p) => `"${spokenForm(`${p.amount} ${p.unit === "crore" ? "Cr" : "L"}`)}"`).join(", ")}; crore is never lakh, and lakh is never crore.`
      : "");
  const realism = (r: string | null) => (r ? (male ? r.replace(/\bShe\b/g, "He").replace(/\bshe\b/g, "he").replace(/\bher\b/g, "him") : r) : "");

  return [
    `A ${skill.seconds}-second ${p.wide ? "wide 16:9" : "vertical 9:16"} Instagram real-estate reel, ${skill.format}, ` +
      (skill.oneTake
        ? `filmed as one continuous take with no cuts, the ${script.scenes.length} shots below being moments in it. ${skill.look}`
        : `cut as ${script.scenes.length} shots in one continuous edit. ${skill.look}`) +
      ` ${PHOTOREAL}`,
    ...(skill.speech === "voiceover" ? [`One voice speaks in this film: ${voiceOf(male)}, from the first line to the last.`] : []),
    `Where it is: ${p.project} is in ${spokenPlace(p.locality)}, India. The project and everything around it look exactly ` +
      "as the approved pictures show them (its own roads, neighbouring buildings, trees, skyline and sky), and any other " +
      "place in the film is ordinary urban India; never a made-up suburb, an empty field or a foreign city.",
    "",
    ...(p.revision?.fresh
      ? [
          "AN EARLIER TAKE OF THIS FILM WENT WRONG. Make it fresh from the shot list below, exactly as written, and do not " +
            `repeat these mistakes: ${p.revision.problems.join(" ")}`,
          "",
        ]
      : p.revision
      ? [
          "THIS IS A NEW VERSION. @Video1 is the previous version of this film. Make it again the same way: the same " +
            (presenting ? "presenter, " : people ? "people, " : "") +
            "shots, order, lines, text and look.",
          p.revision.note ? `Change only this, as the client asked: ${p.revision.note}` : "",
          p.revision.problems.length ? `Also fix what was wrong in it: ${p.revision.problems.join(" ")}` : "",
          "",
        ].filter(Boolean)
      : []),
    "References:",
    ...(styleTags.length
      ? [
          `${list(styleTags)} ${styleTags.length > 1 ? "are" : "is"} STYLE references only, from another creator's reel. Copy their ` +
            "energy, framing, realism and camera moves. Do NOT copy any person in them (not the " +
            "face, hair or clothes), the house, the car, or anything else in them.",
        ]
      : []),
    ...(textTag
      ? [`${textTag} shows only how the big text looks. Copy its look (the typeface, the sizes, the colour); set only the words each shot gives.`]
      : []),
    `${list(refs.map(tag))} ${refs.length > 1 ? "are" : "is"} the real project, ${p.project} in ${spokenPlace(p.locality)}: ` +
      refs.map((i) => `${tag(i)} is ${(p.pictures[i]?.title || categoryWords(p.pictures[i]?.category ?? "")).replace(/\.$/, "")}`).join(", ") +
      ". Every building, pool and room must look exactly like its reference: same architecture, colours, windows, number of " +
      "floors and towers, furniture. Never add floors, towers, a sea, a landmark, a sign or anything that is not in the reference." +
      (skill.builds
        ? " It is the building finished: it is built in front of the camera, from its own empty plot in its own setting, and the " +
          "film ends on exactly this picture."
        : ""),
    "",
    ...(presenting
      ? [
          `The presenter: ${script.presenter.replace(/[.\s]+$/, "")}, a real-looking real-estate creator with natural skin texture ` +
            `(not model-perfect). The same ${person} in every presenter shot. ${skill.presenter ?? ""} ${realism(skill.realism)}`.trim(),
          "",
        ]
      : people && script.presenter
        ? [
            `The people: ${script.presenter.replace(/[.\s]+$/, "")}. The same people in every people shot, each with the same face, hair, glasses and clothes from the first shot to the last, never looking into the lens ` +
              `as if giving a review. ${/\b(child|children|daughter|son|kid|kids|boy|girl|baby)\b/i.test(script.presenter) ? PEOPLE_REALISM : PEOPLE_REALISM.replace(/ The child looks like a real child \([^)]*\)\./, "")}`,
            "",
          ]
        : []),
    ...(skill.speech === "presenter" && p.voiceTrack
      ? [
          `${Whose} voice is @Audio1, recorded already: every line below, in this order, at the times in the plan. ${She} says ` +
            `exactly what @Audio1 says, in its voice, word for word and at its timing: ${her} lips move with it, in sync, whenever ` +
            `${male ? "he" : "she"} is on camera, and it is ${her} voice-over on the other shots. No other voice, no word of ${her} own, ` +
            `no line moved to another shot, nothing said after the last line.`,
          "",
        ]
      : skill.speech === "presenter"
      ? [
          `${Whose} voice: ${skill.voice ?? ""} ${She} says only these lines, word for word, in this order, lip-synced when ` +
            `${male ? "he" : "she"} is on camera and as voice-over on the other shots.` + sayHow,
          "",
        ]
      : later
        ? [
            "Nobody speaks in this film: no voice, no voice-over, no singing, no dialogue, and nobody on screen talks or moves " +
              "their lips. A narrator is added afterwards, so the score stays soft and leaves room for a voice, and the real sounds " +
              "(a door, a child's laugh, the city) stay quiet.",
            "",
          ]
      : skill.speech === "voiceover"
        ? [
            `The narrator, a ${male ? "man" : "woman"} nobody sees, speaking in ${voiceOf(male)}: ${skill.voice ?? ""} The narrator says only these lines, word for ` +
              "word, in this order, as voice-over. Nobody on screen speaks or moves their lips to the words." + sayHow,
            "",
          ]
        : ["Nobody speaks: no voice, no narration, no dialogue, and nobody on screen talks.", ""]),
    ...directionLines,
    p.voiceTrack && skill.speech === "presenter"
      ? `Timing: the whole film is exactly ${skill.seconds} seconds, and @Audio1 sets it: each shot runs the times below, which are ` +
        "where its line falls in @Audio1. Cut from one shot to the next on those times, and keep the order."
      : `Timing: the whole film is exactly ${skill.seconds} seconds. The times below are a plan, not a rule: give each shot the time ` +
        `its ${talks ? "words and its " : ""}action need${talks ? "" : "s"}. If a shot needs a little longer, take that time from a shot that does not need it, ` +
        "so that no shot feels stretched and none feels rushed." +
        (talks ? " Never slow the speech down or speed it up to fit, never leave dead air, and keep the order." : " Keep the order."),
    "",
    ...shots,
    "",
    `Sound: ${skill.sound} ${skill.text}`,
    "",
    // Said as a rule of its own, because "no subtitles other than the big
    // kinetic words" was read as leave to caption her whole script.
    `Text on screen: ${talks ? `${Whose} words are never captioned or subtitled. ` : ""}The only words that ever appear on screen are ` +
      (cards.length ? `${cards.length === 1 ? "this one card, only in its own shot" : `these ${cards.length} cards, each only in its own shot`}: ${list(cards)}` : "none at all") +
      ". A shot without a card has no words on screen" +
      (script.scenes.some((s) => p.pictures[s.picture]?.category === "LOCATION_MAP") ? " (the approved map keeps its own printed names exactly as they are)" : "") +
      ". Set every card exactly as written and spelled, letter for letter; never " +
      "correct, change, drop or add a letter, and never add a word to one. No logos, no watermarks. Keep the top-right corner (the " +
      `top fifth of the frame, right half) and the bottom tenth of the frame clear of text${presenting || people ? " and of any face" : ""}: a ` +
      "registration badge and a footer are placed there afterwards.",
  ].join("\n");
}

/** How generated people (not the presenter) must look, said as a camera sees real people. */
/**
 * A face as a camera sees a real person, not as a model imagines a pleasant
 * one. Said in words only: Seedance refuses a reference picture that looks
 * like a real person (`InputImageSensitiveContentDetected.PrivacyInformation`),
 * which is what a picture of the family drawn first got on 5 October 2026. The first story film's family was smooth, symmetrical and doll-like
 * beside the reference films: these are the details that were missing.
 */
const FACE_REALISM =
  "Real, ordinary Indian faces, not models: slightly asymmetric features, visible skin texture and pores, fine lines around the " +
  "eyes and mouth, a little under-eye shadow, uneven skin tone, a natural shine on the nose and forehead, stray and flyaway hairs, " +
  "eyebrows with uneven hairs, real teeth, hands with knuckle creases and visible veins. The child looks like a real child (an " +
  "ordinary face, messy hair, not a doll with huge eyes). No beauty filter, never airbrushed, smooth, waxy, plastic, glossy or CGI.";

const PEOPLE_REALISM =
  "They look like real people filmed on a phone, indistinguishable from real footage. " +
  FACE_REALISM +
  " Their faces move the way real faces do: they blink, their eyes look at things and at each other, small expressions come and " +
  "go, and they breathe. Natural, unposed body language, clothes with real fabric folds and creases, the same light on them as on " +
  "the place around them, a little handheld shake and natural motion blur when they move.";

/**
 * Said in every film, after the format's own look. The first land to home
 * film came back as a clean 3D render of a tower in a made-up suburb; a
 * buyer has to believe they are looking at real footage of a real place.
 */
const PHOTOREAL =
  "Hyper-realistic and photoreal from the first frame to the last, as if filmed with a real camera: real materials and " +
  "textures, real dust, weather and haze, real daylight and shadows, natural imperfections and lens character. Never CGI, " +
  "never a clean 3D render, a video game, an architectural walkthrough or an illustration. The building has exactly the " +
  "design in its reference, filmed as if it were real.";

/** How long the picture may stand still before it reads as a frozen frame. */
export const STILL_SECONDS = 1.5;
/** Mean frame-to-frame difference (0 to 255, frames 160 wide) under which the picture is standing still. */
export const STILL_BELOW = 0.6;

/**
 * Where a film's picture stands still: runs of half-second samples whose
 * movement stays under `STILL_BELOW` for `STILL_SECONDS` or more. The first
 * story film held the tower's still render frozen from 0:07 to 0:10.
 */
export function stillStretches(samples: readonly { at: number; motion: number }[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let from: number | null = null;
  let last = 0;
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    if (s.motion < STILL_BELOW) {
      from ??= s.at;
      last = s.at + 0.5;
    } else if (from !== null) {
      if (last - from >= STILL_SECONDS) out.push({ start: from, end: last });
      from = null;
    }
  }
  if (from !== null && last - from >= STILL_SECONDS) out.push({ start: from, end: last });
  return out;
}

/** What a still stretch is called in the film's notes, and in the fix film's list. */
export function stillNote(s: { start: number; end: number }): string {
  return `The picture stands still from ${mmss(s.start)} to ${mmss(s.end)}: the camera must keep moving there, and something in the frame must move.`;
}


// ---------------------------------------------------------------------------
// Judging what came back, without buying another
// ---------------------------------------------------------------------------

/** What the eye is asked to report for each frame. */
export const FILM_EYE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["frames"],
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["frame", "texts", "building"],
        properties: {
          frame: { type: "integer" },
          texts: { type: "array", items: { type: "string" } },
          building: { type: "string", enum: ["matches", "differs", "none"] },
        },
      },
    },
  },
} as const;

export type FilmFrameSeen = { texts: string[]; building: "matches" | "differs" | "none"; /** Seconds into the model's film. */ at?: number };

/**
 * What the eye is asked of the whole film, a frame a second, transitions
 * included: anything that is not the project or its presenter. The film of
 * 30 September 2026 cut a sports car and another developer's house into a
 * whip pan between two shots, and the per-shot frames never saw it.
 */
const HIS = /\b(father|husband|man|son|boy|grandfather|dad|uncle|brother)\b/i;
const HERS = /\b(mother|wife|woman|daughter|girl|grandmother|mum|mom|aunt|sister)\b/i;

/** Whose story it is, read off the first people scene: "the father shuts his laptop" is his. */
export function storyHero(script: FilmScript): "male" | "female" | null {
  const first = script.scenes.find((s) => s.kind === "people");
  if (!first) return null;
  const him = first.shot.search(HIS);
  const her = first.shot.search(HERS);
  if (him < 0 && her < 0) return null;
  if (her < 0) return "male";
  if (him < 0) return "female";
  return him < her ? "male" : "female";
}

/**
 * What makes a narrated story confusing before it is filmed (6 October
 * 2026, the first family story): a woman's voice telling a father's story,
 * a line about "he" beside lines said as "I", the family on the sofa after
 * they had gone to bed, and a building held for five seconds on a long line.
 */
/**
 * `pronouns` false for a Hindi or Marathi film: its "वह" and "उसकी" carry
 * no gender, so read back into English they come out "his/her" and every
 * line about the daughter read as one about the father (7 October 2026).
 */
export function storyProblems(script: FilmScript, counted?: FilmScript, pronouns = true): string[] {
  const out: string[] = [];
  const hero = storyHero(script);
  if (hero && script.voice !== hero) {
    out.push(
      `This is ${hero === "male" ? "his" : "her"} story, so it is told in ${hero === "male" ? "his" : "her"} own voice: set "voice" to "${hero}", ` +
        "and say every line as the person whose story it is (\"I\", \"my\").",
    );
  }
  script.scenes.forEach((s, i) => {
    if (!s.line) return;
    const firstPerson = /\b(i|i'm|i've|i'd|me|my|we|we're|our|us)\b/i.test(s.line);
    // Only the main character's own pronouns: "she would sleep before the
    // story" is the daughter, in a father's story, and was refused as if the
    // father were talked about from outside (7 October 2026).
    const own = (hero ?? script.voice) === "female" ? /\b(she|her|hers)\b/i : /\b(he|him|his)\b/i;
    if (pronouns && !firstPerson && own.test(s.line)) {
      out.push(`Scene ${i + 1}'s line talks about the main character from outside ("${s.line}"); the voice IS that person, so say it as "I".`);
    }
    if (s.kind === "property" && spokenWords((counted ?? script).scenes[i]?.line ?? s.line) > STORY_PROPERTY_WORDS) {
      out.push(`Scene ${i + 1} shows only the building, so its line is short: ${STORY_PROPERTY_WORDS} words at most as said, and the shot keeps moving.`);
    }
  });
  script.scenes.forEach((s, i) => {
    if (s.kind === "people" && actionsIn(s.shot) > STORY_SHOT_ACTIONS) {
      out.push(
        `Scene ${i + 1} asks for too much in one shot (${actionsIn(s.shot)} actions); one or two things happen in a shot. Split it, ` +
          "and someone coming home is shown already inside: the bag set down in the living room, the child running across the room to him.",
      );
    }
  });
  // What video models get wrong every time is never in a story: the door
  // scene of every story film so far was wrong (a father opening his own
  // door after ringing, a different man at the bell), and the line "I ring
  // once" asked for a bell the picture could not show (9 October 2026).
  script.scenes.forEach((s, i) => {
    const said = isDevanagari(s.line ?? "") ? "" : s.line ?? "";
    for (const [re, what] of STORY_HARD_MOMENTS) {
      if (re.test(affirmed(`${s.shot} ${said}`))) {
        out.push(
          `Scene ${i + 1} hinges on ${what}, which video models get wrong every time; tell that moment another way, in the shot ` +
            "and in its line (coming home is shown already inside: a bag set down, a child running across the room to him).",
        );
        break;
      }
    }
  });
  // Time only moves forward: once the story leaves a room it never returns.
  const rooms = script.scenes.filter((s) => s.kind === "people" && s.picture >= 0).map((s) => s.picture);
  const visited: number[] = [];
  for (const r of rooms) {
    if (visited[visited.length - 1] === r) continue;
    if (visited.includes(r)) {
      out.push("The story goes back to a room it already left; time only moves forward, so put the scenes in that room together, in the order they happen.");
      break;
    }
    visited.push(r);
  }
  return out;
}

const STORY_MONEY = /₹|\brs\.?\s|\bcrores?\b|\blakhs?\b|\bbhk\b|\bsq\.?\s?ft\b|\bsquare (feet|foot)\b|\bcarpet\b/i;
const STORY_SALES = /\b(book|booking|buy|bought|offer|offers|hurry|limited|visit|invest|investment|launch|launching|deal)\b/i;
const STORY_SPECS = /\b(storey|storeys|lift|lifts|flooring|fittings|vastu|amenities|world-class|luxury|luxurious|premium|state[- ]of[- ]the[- ]art)\b/i;
const STORY_STOP = new Set(["this", "that", "with", "from", "here", "there", "every", "they", "them", "their", "have", "just", "into", "when", "what", "were", "will", "your", "ours", "about", "again"]);

/**
 * An English story held to how the trade's story films are written
 * (`doc/story-scripting-research.md`, seventeen films read on 9 October
 * 2026): six to nine lines with a shot or two left silent, no question and
 * no exclamation, no price, size or sales word (the price is our card), and
 * a word of the opening line brought back at the close.
 */
export function englishStoryProblems(script: FilmScript): string[] {
  const out: string[] = [];
  const spoken = script.scenes.map((s, i) => ({ line: (s.line ?? "").trim(), i })).filter((x) => x.line);
  for (const { line, i } of spoken) {
    const n = i + 1;
    if (/[?!]/.test(line)) out.push(`Scene ${n}'s line is a question or an exclamation. The voice speaks to nobody: write it as a quiet thought.`);
    if (STORY_MONEY.test(line)) out.push(`Scene ${n}'s line says a price, a size or a configuration. The story never does: the price is a card laid over the close. Say the feeling instead.`);
    if (STORY_SALES.test(line)) out.push(`Scene ${n}'s line uses a sales word ("${STORY_SALES.exec(line)![0]}"). The story sells nothing in words; say what the moment feels like.`);
    if (STORY_SPECS.test(line)) out.push(`Scene ${n}'s line uses a specification word ("${STORY_SPECS.exec(line)![0]}"). Name the feeling, never the facility.`);
  }
  if (spoken.length < 6 || spoken.length > 9) out.push(`Write six to nine spoken lines; this draft has ${spoken.length}.`);
  if (spoken.length && spoken.length === script.scenes.length) out.push("Leave one or two shots with no line at all: the music and the faces carry them.");
  if (spoken.length >= 3) {
    const content = (t: string) => new Set((t.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !STORY_STOP.has(w)));
    const first = content(spoken[0].line);
    const echoed = spoken.slice(-2).some(({ line }) => [...content(line)].some((w) => first.has(w)));
    if (first.size && !echoed) out.push("Bring a word of the first line back in one of the last two lines, so the film closes where it opened.");
  }
  return out;
}

const LAUNCH_ASKS = /\b(book|booking|visit|call|hurry|limited|offer|offers|launch|launched|launching|introducing|sold out|don'?t miss)\b/i;

/**
 * A launch film held to its grammar (rule 9, 11 October 2026): five or six
 * lines, no question or exclamation, no price, size or number before the
 * name at the close, nothing asked of the viewer, and the building only in
 * the last third. The prompt said all of it; nothing refused a draft that
 * did not.
 */
export function launchFilmProblems(script: FilmScript, categories: readonly string[] = []): string[] {
  const out: string[] = [];
  const n = script.scenes.length;
  const spoken = script.scenes.map((s, i) => ({ line: (s.line ?? "").trim(), i })).filter((x) => x.line);
  for (const { line, i } of spoken) {
    const no = i + 1;
    const last = i === spoken[spoken.length - 1].i;
    if (/[?!]/.test(line)) out.push(`Scene ${no}'s line is a question or an exclamation. Write it as a quiet statement with a full stop.`);
    if (STORY_MONEY.test(line)) out.push(`Scene ${no}'s line says a price, a size or a configuration. A launch film says none: say how the place feels.`);
    else if (!last && numberValues(line).length) out.push(`Scene ${no}'s line carries a number. A launch film says no number of any kind: say how the place feels.`);
    if (LAUNCH_ASKS.test(line)) out.push(`Scene ${no}'s line uses "${LAUNCH_ASKS.exec(line)![0]}". A launch film asks nothing of the viewer and announces nothing.`);
  }
  for (const [i, s] of script.scenes.entries()) {
    if (s.text && STORY_MONEY.test(s.text)) out.push(`Scene ${i + 1}'s big text is a price or a configuration. The only card is the project's name at the close.`);
  }
  if (spoken.length < 5 || spoken.length > 6) out.push(`Write five or six lines in the whole film; this draft has ${spoken.length}.`);
  const lastThird = Math.floor((n * 2) / 3);
  const early = script.scenes.map((s, i) => i).filter((i) => i < lastThird && categories[script.scenes[i].picture] === "EXTERIOR_RENDER");
  if (early.length) {
    out.push(`Scene${early.length > 1 ? "s" : ""} ${early.map((i) => i + 1).join(", ")} show${early.length > 1 ? "" : "s"} the building. It appears only in the last third (scene ${lastThird + 1} on): open on details and the people.`);
  }
  return out;
}

/** Moments no story shot or line may hinge on, with what each is called. */
export const STORY_HARD_MOMENTS: readonly [RegExp, string][] = [
  [/\b(door|doors|doorbell|doorway|front door|threshold|knock|knocks|knocking|bell|bells|ring once|rings once|ring the|rings the|ringing the)\b/i, "a door or a bell"],
  [/\b(mirror|mirrors|reflection)\b/i, "a mirror"],
  [/\b(hands (it|him|her|them|over)|hand (it|him|her|them) (to|over)|passes (it|him|her|them|the)|gives (him|her|them) (a|the))\b/i, "something handed from one person to another"],
  [/\b(writes|writing|typing|types a)\b/i, "writing or typing"],
];

/** Words a narrated story's building shot may carry: a longer line holds the building on screen with nothing happening. */
export const STORY_PROPERTY_WORDS = 8;

/** What a person watching the finished film would find wrong with its story, from `reviewStory()`. */
export const FILM_STORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["problems"],
  properties: {
    problems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "what", "fix", "about"],
        properties: {
          at: { type: "number" },
          what: { type: "string" },
          fix: { type: "string" },
          // What kind of fault: in the picture of one shot, a shot too slow or
          // too rushed for what it shows, or the voice (no shot fixes that).
          about: { type: "string", enum: ["picture", "slow", "rushed", "voice"] },
        },
      },
    },
  },
} as const;

/** The narrator's voice as the prompt names it, the other gender ruled out: a woman's voice once told a father's story. */
export function voiceOf(male: boolean): string {
  return male
    ? "a man's warm, low voice, a man in his thirties (never a woman's voice)"
    : "a woman's warm, clear voice, a woman in her thirties (never a man's voice)";
}

/**
 * Doing words a people shot is counted by: more than three in one shot of
 * two to four seconds and the video model drops some and borrows others
 * (the corrected family story's front door, opened from inside again).
 */
const ACTIONS = /\b(opens?|pulls?|runs?|rings?|knocks?|steps?|walks?|lifts?|picks?|puts?|drops?|sits?|stands?|climbs?|pats?|reads?|tugs?|hugs?|carries|carry|enters?|leaves?|turns?|switch(?:es)?|smooths?|swings?|hands?|kneels?|jumps?)\b/gi;

/** How many things happen in one shot, as its words say. */
export function actionsIn(shot: string): number {
  return (shot.match(ACTIONS) ?? []).length;
}

/**
 * The approved facts a template's writer is handed, chosen for what the
 * format says rather than everything the project holds: a film given every
 * selling point, every price and every date tries to say them all, and a
 * shot asked to carry too much is where the video model invents. Selling
 * points come in the order the caller gives (what has worked first, from
 * the learning), as many as the format's words carry, or its cards when
 * nobody speaks; prices only when the format says one, the two cheapest;
 * the possession date only when the format is about it; construction dates
 * and nearby places only for the formats made of them.
 */
export function filmFacts(
  skill: VideoSkill,
  have: {
    points: readonly string[];
    prices: readonly string[];
    possession?: string | null;
    construction?: readonly string[];
    nearby?: readonly string[];
  },
): string[] {
  // "No number, no price" (the launch film) is not a format that says a price:
  // matched on the bare word, the launch film was handed the two cheapest prices.
  const about = `${skill.format} ${skill.beats.join(" ")}`.toLowerCase().replace(/\b(?:no|never|without)\s+(?:a\s+)?prices?\b/g, "");
  const pointsMax = skill.speech === "none" ? Math.max(1, skill.cards.max) : Math.max(2, Math.floor(skill.words.max / 15));
  return [
    ...have.points.slice(0, pointsMax),
    ...(/\bprice/.test(about) ? have.prices.slice(0, 2) : []),
    ...(have.possession && /possession|handover|ready to move/.test(about) ? [have.possession] : []),
    ...(have.construction ?? []),
    ...(skill.areaLines ? have.nearby ?? [] : []),
  ];
}

/** At most this many actions in a story's people shot. */
export const STORY_SHOT_ACTIONS = 3;

/** At most this many story problems are passed to the fix film: the worst first, never a list it cannot act on. */
export const MAX_STORY_PROBLEMS = 6;

/** A story problem as a line the fix film and the record both read. */
export function storyNote(p: { at: number; what: string; fix: string }): string {
  const what = p.what.trim().replace(/\.$/, "");
  const fix = p.fix.trim().replace(/\.$/, "");
  return `At ${mmss(Math.max(0, p.at))}: ${what}. ${fix ? fix + "." : ""}`.trim();
}

export const FILM_SWEEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["frames"],
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["frame", "kind", "what"],
        properties: {
          frame: { type: "integer" },
          kind: { type: "string", enum: ["none", "property", "vehicle", "person", "other"] },
          what: { type: "string" },
        },
      },
    },
  },
} as const;

/** Something on screen that no approved picture shows, and when. */
export type FilmStray = { at: number; kind: "property" | "vehicle" | "person" | "other"; what: string };

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
export type FilmVerdict = { passed: boolean; problems: string[]; notes: string[] };

const squash = (s: string) => toAsciiDigits(s).toUpperCase().replace(/[^A-Z0-9.₹]/g, "");

type PriceUnit = "crore" | "lakh";

/** The prices a set of lines quotes, as an amount and a unit (₹1.45 Cr is 1.45 crore). */
/**
 * The small print of a film that shows no price, without the sentences about
 * prices: a developer's disclaimer reads "Prices valid for 30 days. T&C
 * apply." on every creative, and on the locality film of 18 October 2026,
 * which says no price, it read as a price nobody showed.
 */
export function withoutPriceTerms(text: string | null): string | null {
  if (!text) return text;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/\bpric(e|es|ed|ing)\b|₹|\brates?\b|\boffers?\b|\bcost\b|\bGST\b|\bstamp duty\b|\bregistration charges\b/i.test(s));
  return kept.join(" ").trim() || null;
}

export function pricesIn(lines: readonly string[]): { amount: string; unit: PriceUnit }[] {
  const out: { amount: string; unit: PriceUnit }[] = [];
  // Hindi and Marathi write the unit in Devanagari: ₹1.45 करोड़, ₹2.19 कोटी, ₹85 लाख.
  for (const m of toAsciiDigits(lines.join(" ")).matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:(Cr|Crore|Crores|L|Lakh|Lakhs|Lac|Lacs)\b|(करोड़|करोड|कोटी|लाख))/gi)) {
    const amount = String(Number(m[1].replace(/,/g, "")));
    const word = m[2] ?? m[3] ?? "";
    const unit: PriceUnit = /^c/i.test(word) || /^(करोड|कोटी)/.test(word) ? "crore" : "lakh";
    if (!out.some((p) => p.amount === amount && p.unit === unit)) out.push({ amount, unit });
  }
  return out;
}

/** The units a transcript says after an amount: "1.45 lakh" is ["lakh"]. Words or figures. */
export function unitsSaid(transcript: string, amount: string): PriceUnit[] {
  const t = toAsciiDigits(transcript).toLowerCase().replace(/,/g, "");
  const out: PriceUnit[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(crores?|cr\b|lakhs?|lacs?|l\b)/g)) {
    if (String(Number(m[1])) === amount) out.push(/^c/.test(m[2]) ? "crore" : "lakh");
  }
  // Said in words, "one point four five crore".
  const words = t.replace(/[^a-z0-9.\s]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const unit = /^crores?$/.test(words[i]) ? "crore" : /^(lakhs?|lacs?)$/.test(words[i]) ? "lakh" : null;
    if (!unit) continue;
    if (numberValues(words.slice(Math.max(0, i - 6), i).join(" ")).includes(amount)) out.push(unit);
  }
  return [...new Set(out)];
}

/** Edits between two strings, a swap of two neighbours counted as one slip ("BKH" for "BHK"). */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * What a finished film may be published with. A number nobody approved,
 * heard or shown, a building unlike its picture, a QR that does not scan, or
 * a building nobody could check, stop it: those are the Section 3 and 12
 * risks. A misspelt word, a word not said as written, or text nobody asked
 * for are notes for the person, who decides whether a new version is worth it.
 */
export function judgeFilm(input: {
  cards: readonly string[];
  lines: readonly string[];
  cleared: readonly string[];
  seen: readonly FilmFrameSeen[] | null;
  transcript: string | null;
  qrScans: boolean | null;
  /** From the sweep of the whole film; null when it could not be read, absent when not asked. */
  strays?: readonly FilmStray[] | null;
  /** A film nobody speaks in has no voice to check: its music is not read for numbers. */
  silent?: boolean;
  /** A film spoken in Hindi or Marathi: what was heard is read for numbers only. */
  local?: boolean;
}): FilmVerdict {
  const problems: string[] = [];
  const notes: string[] = [];
  const allowed = new Set([...input.cleared, ...input.lines].flatMap(numberValues));
  if (input.qrScans === false) problems.push("The RERA QR code does not scan.");

  // A building or place that is not the project is shown as if it were:
  // that stops it. A car or a stranger is for the person to look at.
  const first = new Map<string, FilmStray>();
  for (const s of [...(input.strays ?? [])].sort((a, b) => a.at - b.at)) {
    const key = `${s.kind}:${s.what.trim().toLowerCase().replace(/[.\s]+$/, "")}`;
    if (!first.has(key)) first.set(key, s);
  }
  for (const s of first.values()) {
    const what = s.what.trim().replace(/\.$/, "") || (s.kind === "property" ? "a building" : `a ${s.kind}`);
    if (s.kind === "property") problems.push(`The film shows ${what} at ${mmss(s.at)}, which is not the project.`);
    else notes.push(`The film shows ${what} at ${mmss(s.at)}, which is in none of the approved pictures.`);
  }
  if (input.strays === null) notes.push("The film could not be checked for anything that is not the project. Watch it before publishing.");

  if (!input.seen) {
    problems.push("The frames could not be checked, so the building and the text are unconfirmed.");
  } else {
    if (input.seen.some((f) => f.building === "differs")) problems.push("A building in the film does not look like its approved picture.");
    const want = input.cards.map(squash).filter(Boolean);
    const flagged = new Set<string>();
    const all = input.seen.flatMap((f) => f.texts);
    const read = all.map(squash);
    for (const t of all) {
      const s = squash(t);
      if (!s || flagged.has(s)) continue;
      // Read part way in on one frame and whole on the next: only the whole
      // one is judged, so one misspelt card is one note.
      if (read.some((r) => r !== s && r.includes(s))) continue;
      // A card popping in letter by letter is read part way through, and a
      // piece of a card is the card: "₹1.4" on the way to "₹1.45 CR" stopped
      // the first live film as a price nobody approved.
      // A line read whole can hold two parts of a card ("1 BHK" and "₹1.45 CR"
      // together); what is left once the parts it holds are taken out is
      // what gets judged, so a slip in one part is not hidden by the other.
      let rest = s;
      for (const w of [...want].sort((a, b) => b.length - a.length)) if (w && rest.includes(w)) rest = rest.replace(w, "");
      if (!rest || want.some((w) => w.includes(rest))) continue;
      const bad = numberValues(t).filter((v) => !allowed.has(v));
      if (bad.length) {
        problems.push(`The screen shows "${t}", a number that is not approved.`);
        flagged.add(s);
        continue;
      }
      const near = want.find((w) => editDistance(w, rest) <= Math.max(1, Math.floor(w.length / 5)));
      if (near) {
        const card = input.cards.find((c) => squash(c) === near) ?? near;
        notes.push(`The text "${t}" should read "${card.toUpperCase()}".`);
      } else if (s.length > 2) {
        notes.push(`Text on screen that was not asked for: "${t}".`);
      }
      flagged.add(s);
    }
  }

  if (input.silent) {
    // Music only: nothing was said, so nothing said can be wrong.
  } else if (input.transcript !== null) {
    // A figure is a claim. A single word like "two" is as likely the
    // transcriber hearing "to", so it is a note rather than a stop.
    // A Hindi or Marathi price is heard as "1 करोड़ 45 लाख": that is ₹1.45 Cr,
    // not a 45 nobody approved (the first full Hindi film, 8 October 2026).
    const said = input.local
      ? toAsciiDigits(input.transcript).replace(/(\d+)\s*(करोड़|करोड|कोटी)\s*(\d{1,2})\s*लाख/g, (_, a: string, u: string, b: string) => `${a}.${b.padStart(2, "0")} ${u}`)
      : input.transcript;
    const heard = [...new Set(numberValues(said).filter((v) => !allowed.has(v)))];
    const claims = heard.filter((v) => Number(v) >= 10 || !Number.isInteger(Number(v)));
    const small = heard.filter((v) => !claims.includes(v));
    if (claims.length) problems.push(`The voice says ${claims.join(", ")}, which is not an approved number.`);
    if (small.length) notes.push(`The voice may say ${small.join(", ")}, which the script does not. Listen to it before publishing.`);
    // The word checks below read English lines against an English hearing.
    if (input.local) {
      notes.push("The voice speaks Hindi or Marathi: listen to the names and the price before publishing.");
      return { passed: problems.length === 0, problems: [...new Set(problems)], notes: [...new Set(notes)] };
    }
    const off = wordsNotHeard(input.lines, input.transcript);
    if (off.length) {
      // Named, so the person listens for them: "plot" came back "plaque" and
      // "podium" came back "paddy" in a film the overall match passed.
      notes.push(`Listen for ${off.map((w) => `"${w}"`).join(", ")}: ${off.length === 1 ? "it may not be" : "they may not be"} said right.`);
    } else if (spokenMatch(input.lines.map(spokenForm), input.transcript) < 0.8) {
      notes.push("Some words may not be said as written. Listen to it before publishing.");
    }
    // A price is a number AND its unit. The app's second film said "one point
    // four five lakh" for ₹1.45 Cr, heard the same by two transcribers, and
    // the number check passed it because 1.45 is approved: a buyer hearing a
    // hundredth of the price is the Section 12 exposure, so it stops the film.
    for (const p of pricesIn(input.lines)) {
      const said = unitsSaid(input.transcript, p.amount);
      if (said.length && !said.includes(p.unit)) {
        problems.push(`The voice says ${p.amount} ${said[0]} where the approved price is ${p.amount} ${p.unit}.`);
      } else if (!said.length) {
        notes.push(`The price (${p.amount} ${p.unit}) was not heard clearly. Listen to it before publishing.`);
      }
    }
    // A local name said wrongly is written wrongly by the transcriber
    // ("Gorecon"), so a name missing from what was heard is worth a listen.
    for (const n of namesSaid(input.lines)) {
      if (!nameRe(n.name).test(input.transcript)) notes.push(`"${n.name}" may not be said right. Listen to it before publishing.`);
    }
  } else {
    notes.push("The voice could not be checked. Listen to it before publishing.");
  }
  return { passed: problems.length === 0, problems: [...new Set(problems)], notes: [...new Set(notes)] };
}

/**
 * What is wrong with a person's note for a new version, or nothing. It goes
 * to the video model, so it may not change the building, say a never-say
 * phrase, or bring in a number the facts do not carry; a time in the film
 * ("at 12 seconds") is not a claim.
 */
export function noteProblems(note: string, cleared: readonly string[], neverSay: readonly string[]): string[] {
  const out: string[] = [];
  const text = note.trim();
  if (text.length > MAX_NOTE_CHARS) out.push(`Keep the note under ${MAX_NOTE_CHARS} characters.`);
  const lower = text.toLowerCase();
  for (const phrase of neverSay) {
    const p = phrase.trim().toLowerCase();
    if (p.length >= 3 && lower.includes(p)) out.push(`"${phrase.trim()}" is on the never-say list.`);
  }
  const bare = text
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(/\b\d{1,2}(?:\.\d)?\s*(?:s|sec|secs|second|seconds)\b/gi, " ")
    .replace(/\bshot\s+\d{1,2}\b/gi, " ");
  const allowed = new Set(cleared.flatMap(numberValues));
  const bad = numberValues(bare).filter((v) => !allowed.has(v));
  if (bad.length) out.push(`The note uses ${[...new Set(bad)].join(", ")}, which the approved facts do not have.`);
  if (changesProperty(text.replace(/\b(no|not|never|without|don't|do not)\b[^.,;:!?]*/gi, " "))) {
    out.push("A new version can change the presenter, the words' delivery, the text or the camera, never the building.");
  }
  return out;
}
