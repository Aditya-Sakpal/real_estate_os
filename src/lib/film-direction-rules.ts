/**
 * A story's script turned into what the video model is asked for, the way
 * Seedance 2.5 is prompted by the people who get it right (Higgsfield's
 * "Seedance 2.5 Prompting Guide", read on 9 October 2026): one block of
 * labelled sections in a fixed order, GLOBAL STYLE, SCENE, CHARACTERS,
 * LOCATION, FIRST FRAME AND BLOCKING, the shots with their timing and "Hard
 * cut", OPTICS, CAMERA, PHYSICS, LIGHTING, AUDIO, then the locks. "Skip a
 * section and the output tends to fail in a specific, predictable way", and
 * our films did: no blocking (a father opening his own front door), no
 * location layout (a front door onto a bedroom), no orientation (a laptop
 * facing away from its user), places that drifted between cuts.
 *
 * The writer (Sarvam for Hindi and Marathi) writes the story and its lines; a
 * director (`film-direction.ts`) turns each shot into a shot a camera crew
 * could film: who is where, facing which way, one action, one lens, one move,
 * in a place whose layout is fixed. Code builds the prompt from that.
 *
 * Pure, client-safe and covered by `check:logic`.
 */

export type DirectionCharacter = { label: string; look: string };
export type DirectionPlace = { label: string; picture: number; layout: string };
export type DirectionShot = {
  /** wide, medium, medium close-up, close-up, over-the-shoulder... */
  frame: string;
  /** Diagonal field of view, one of `LENSES`. */
  lens: number;
  /** One camera move. */
  camera: string;
  /** The place, by its label. */
  place: string;
  /** Who is in frame, by label, at most two. */
  people: string[];
  /** Where each one is and faces as the shot starts (screen side, x %, facing). */
  blocking: string;
  /** The one thing that happens, with when. */
  action: string;
  /** Anything in it that must face or work one way: a screen toward its user. */
  objects: string;
};
export type FilmDirection = {
  logline: string;
  characters: DirectionCharacter[];
  places: DirectionPlace[];
  lighting: string;
  physics: string;
  shots: DirectionShot[];
};

/** The four lenses the guide names, as diagonal field of view. */
export const LENSES = [84, 47, 29, 18] as const;
export const LENS_WORDS: Readonly<Record<number, string>> = {
  84: "wide",
  47: "standard normal",
  29: "short telephoto",
  18: "telephoto",
};

/** People on screen at once at most: "more faces in a shot, more drift". */
export const MAX_PEOPLE_IN_SHOT = 2;

export const DIRECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["logline", "characters", "places", "lighting", "physics", "shots"],
  properties: {
    logline: { type: "string" },
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "look"],
        properties: { label: { type: "string" }, look: { type: "string" } },
      },
    },
    places: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "picture", "layout"],
        properties: { label: { type: "string" }, picture: { type: "integer" }, layout: { type: "string" } },
      },
    },
    lighting: { type: "string" },
    physics: { type: "string" },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["frame", "lens", "camera", "place", "people", "blocking", "action", "objects"],
        properties: {
          frame: { type: "string" },
          lens: { type: "integer", enum: [...LENSES] },
          camera: { type: "string" },
          place: { type: "string" },
          people: { type: "array", items: { type: "string" } },
          blocking: { type: "string" },
          action: { type: "string" },
          objects: { type: "string" },
        },
      },
    },
  },
} as const;

const str = (v: unknown, n = 600) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, n) : "");

/** The director's answer, read; null when it is not the shape. */
export function readDirection(v: unknown): FilmDirection | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.shots) || !Array.isArray(o.characters) || !Array.isArray(o.places)) return null;
  const characters = (o.characters as Record<string, unknown>[]).map((c) => ({ label: str(c.label, 40).toUpperCase(), look: str(c.look, 700) })).filter((c) => c.label && c.look);
  const places = (o.places as Record<string, unknown>[])
    .map((p) => ({ label: str(p.label, 60).toUpperCase(), picture: Number.isInteger(p.picture) ? Number(p.picture) : -1, layout: str(p.layout, 700) }))
    .filter((p) => p.label && p.layout);
  const shots = (o.shots as Record<string, unknown>[]).map((s) => ({
    frame: str(s.frame, 60),
    lens: LENSES.includes(Number(s.lens) as (typeof LENSES)[number]) ? Number(s.lens) : 47,
    camera: str(s.camera, 160),
    place: str(s.place, 60).toUpperCase(),
    people: Array.isArray(s.people) ? (s.people as unknown[]).map((x) => str(x, 40).toUpperCase()).filter(Boolean) : [],
    blocking: str(s.blocking, 500),
    action: str(s.action, 400),
    objects: str(s.objects, 300),
  }));
  return { logline: str(o.logline, 300), characters, places, lighting: str(o.lighting, 600), physics: str(o.physics, 600), shots };
}

/**
 * A text's sentences that say something happens: one carrying "no", "not",
 * "never" or "without" says what must not, and is not read as asking for it.
 * The first English director wrote "no door, bell, threshold, or entrance
 * action is shown" and was refused three times for a door (9 October 2026).
 */
export function affirmed(text: string): string {
  return text
    .split(/(?<=[.!?;])\s+/)
    .filter((s) => !/\b(no|not|never|without|nor|none)\b|n't\b/i.test(s))
    .join(" ");
}

/** A director's words with every sentence about a door or a bell taken out, said or denied: the word alone draws one. */
export function withoutDoors(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/\b(door|doors|doorway|doorbell|bell|threshold|entrance action)\b/i.test(s))
    .join(" ")
    .trim();
}

/** Things a video model gets wrong every time, which no shot may hinge on. */
const HARD_MOMENTS: readonly [RegExp, string][] = [
  [/\b(door|doorbell|bell|knock(s|ing)?|doorway|threshold)\b/i, "a door or a bell"],
  [/\b(mirror|reflection)\b/i, "a mirror"],
  [/\b(hands? (it|him|her|them) (to|over)|passes (it|the)|gives (him|her|them))\b/i, "something handed from one person to another"],
  [/\b(writes?|writing|reads? (a|the) (book|letter|note)|typing)\b/i, "writing, typing or reading"],
];

/**
 * What is wrong with a direction, in words the director acts on: a shot for
 * every scene, one place and its layout for every shot, at most two people,
 * one action, a fixed lens, nothing that hinges on a moment the model always
 * gets wrong, and a screen always said to face its user.
 */
export function directionProblems(d: FilmDirection, scenes: number, picturesKnown: number, withPeople = true): string[] {
  const out: string[] = [];
  if (d.shots.length !== scenes) out.push(`Write exactly ${scenes} shots, one for each scene of the script, in its order.`);
  // A film of the property alone has nobody to describe (10 October 2026).
  if (!d.characters.length && withPeople) out.push("Describe every person in the film under CHARACTERS, each with a label like THE FATHER.");
  const people = new Set(d.characters.map((c) => c.label));
  const places = new Set(d.places.map((p) => p.label));
  for (const p of d.places) {
    if (p.picture >= picturesKnown) out.push(`${p.label} names picture ${p.picture}, which does not exist.`);
  }
  d.shots.forEach((s, i) => {
    const n = i + 1;
    if (!places.has(s.place)) out.push(`Shot ${n}'s place "${s.place}" is not one of the LOCATION labels; use one exactly.`);
    if (s.people.length > MAX_PEOPLE_IN_SHOT) out.push(`Shot ${n} shows ${s.people.length} people; show at most ${MAX_PEOPLE_IN_SHOT}.`);
    for (const p of s.people) if (!people.has(p)) out.push(`Shot ${n} names ${p}, who is not under CHARACTERS.`);
    if (s.people.length && !s.blocking) out.push(`Shot ${n} needs its blocking: where each person stands or sits, screen side, x %, and which way they face.`);
    if (!s.action) out.push(`Shot ${n} needs its one action.`);
    const actions = s.action.split(/[,;]|\bthen\b|\band then\b|\bwhile\b|\bas he\b|\bas she\b/i).filter((x) => /\b[a-z]+s\b/i.test(x)).length;
    if (actions > 2) out.push(`Shot ${n} asks for more than one action ("${s.action.slice(0, 80)}"); keep one.`);
    const all = `${s.blocking} ${s.action} ${s.objects}`;
    for (const [re, what] of HARD_MOMENTS) if (re.test(affirmed(all))) out.push(`Shot ${n} hinges on ${what}, which video models get wrong; show the moment another way.`);
    // "screen-left" and "screen center" are places in the frame, not a device.
    // "screen-left" is a place in the frame and "on screen" is where words go,
    // not a device: asked to say which way "the screen" faced after writing
    // "no words on screen", a director put a television into a sofa shot
    // (11 October 2026).
    if (/\b(laptop|phone|tablet|monitor|tv|television)\b|(?<!\b(on|off)[- ])\bscreens?\b(?![- ]?(left|right|cent(er|re)|side|edge|middle|-))/i.test(all) && !/\bfac(e|es|ing)\b/i.test(s.objects)) {
      out.push(`Shot ${n} has a screen: say under "objects" which way it faces (toward the person using it) and what the camera sees of it.`);
    }
  });
  return [...new Set(out)];
}

const sec = (n: number) => (Number.isInteger(n) ? `${n}.0` : n.toFixed(1));

/**
 * A director's words with every sentence about a card, a caption or text on
 * screen taken out: what text appears is ours to say, once. The first
 * directed story's director wrote "Graphic card overlay: 2 BHK / ₹2.19 CR"
 * into a shot, Seedance drew its own price bar, and ours went on top of it
 * (9 October 2026).
 */
export function withoutCards(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/\b(cards?|overlays?|captions?|graphics?|subtitles?|titles?|logos?|prices?|lettering|on[- ]screen text|text on screen|text overlay|super(imposed)?)\b/i.test(s))
    .join(" ")
    .trim();
}

/**
 * The prompt, section by section, as the guide orders them. `refTag` names
 * an approved picture by the `@ImageN` it was handed over as; `lines` are
 * what is said in each scene as it is to be said (a guide track when the
 * narration is laid over afterwards); `cards` the model's own cards.
 */
export function buildStoryPrompt(input: {
  direction: FilmDirection;
  seconds: number;
  wide: boolean;
  times: readonly { start: number; end: number }[];
  refTag: (picture: number) => string | null;
  lines: readonly { text: string; delivery: string }[];
  cards: readonly (string | null)[];
  /** A card we set over the film afterwards: the shot keeps its upper third clear. */
  ourCard: readonly boolean[];
  voice: { male: boolean; language: string };
  project: string;
  locality: string;
}): string {
  const d = input.direction;
  const shape = input.wide ? "Horizontal 16:9" : "Vertical 9:16";
  const shots = d.shots.map((s, i) => {
    const t = input.times[i] ?? { start: 0, end: input.seconds };
    const line = input.lines[i];
    const card = input.cards[i];
    const blocking = withoutDoors(withoutCards(s.blocking));
    const action = withoutDoors(withoutCards(s.action));
    const objects = withoutDoors(withoutCards(s.objects));
    return [
      `Shot ${i + 1} (${sec(t.start)}s to ${sec(t.end)}s), ${s.frame}, ${s.lens}° ${LENS_WORDS[s.lens] ?? ""} lens, ${s.camera}. ${s.place}.`,
      s.people.length ? `${blocking}` : "No people in this shot.",
      `${action}`,
      objects ? `${objects}` : "",
      line?.text ? `Voice-over, ${line.delivery || "warm and unhurried"}: "${line.text}"` : "No words are spoken in this shot.",
      card ? `On screen, popping in whole in the upper third: "${card}".` : input.ourCard[i] ? "The upper third of the frame stays clear for a card added later." : "",
      "Hard cut.",
    ]
      .filter(Boolean)
      .join(" ");
  });
  const first = d.shots[0];
  const placeLines = d.places.map((p) => {
    const tag = p.picture >= 0 ? input.refTag(p.picture) : null;
    return `${p.label}${tag ? ` (${tag}, the real place, exactly as the reference shows it: same architecture, furniture, colours and windows)` : " (an ordinary place, not the project)"}: ${p.layout}`;
  });
  return [
    `GLOBAL STYLE: ${shape} photoreal live-action Indian family brand film, ${input.seconds} seconds total, 24fps, ${d.shots.length} shots joined by hard cuts, shot on an ARRI Alexa Mini LF with Cooke S4 prime lenses, warm natural grade with soft filmic contrast, real unretouched skin with visible pores. Real footage of real people, never CGI, never an architectural render come to life. No subtitles, no logos, no watermarks, no readable text anywhere except the cards named below.`,
    "",
    `SCENE: ${d.logline} The home is ${input.project} in ${input.locality}.`,
    "",
    `CHARACTERS: ${d.characters.map((c) => `${c.label}: ${c.look}`).join(" ")} Only these ${d.characters.length} people exist in the film, apart from passers-by in public places who never interact with them. Each person's face, hair, build and clothes are identical in every shot, zero drift. Each is a wholly original, invented face.`,
    "",
    `LOCATION: ${placeLines.join(" ")} Every place keeps its layout in every shot that uses it: doors, sofas, windows and the balcony stay where they are said to be.`,
    "",
    `FIRST FRAME AND BLOCKING: ${first ? `${first.place}. ${first.people.length ? withoutCards(first.blocking) : "No people in frame."} ${withoutCards(first.objects)}`.trim() : ""}`,
    "",
    "SHOTS:",
    ...shots,
    "",
    `OPTICS: ${d.shots.map((s, i) => `Shot ${i + 1}, ${s.lens}°`).join("; ")}. Deep focus on wide shots, shallow focus with soft background on close shots.`,
    "",
    `CAMERA: ${d.shots.map((s, i) => `Shot ${i + 1}, ${s.camera}`).join("; ")}. The camera always moves a little, never a frozen frame.`,
    "",
    `PHYSICS: ${d.physics} Real weight and inertia, clothes and hair move with real fabric and air, every hand has exactly five fingers, objects keep the orientation they are given.`,
    "",
    `LIGHTING: ${d.lighting}`,
    "",
    `AUDIO: One ${input.voice.male ? "man's warm, low" : "woman's warm, soft"} voice-over in ${input.voice.language}, saying only the lines quoted in the shots, word for word, in order; nobody on screen speaks or moves their lips to it. A soft piano and strings score low under the voice, quiet real sounds of each place. No lyrics, no other speech.`,
    "",
    "LOCKS: Screen direction holds: a person on one side of the frame stays on that side across the cuts of one moment. Time only moves forward and a place once left is never returned to unless the shot says so. A screen always faces the person using it. Nobody looks into the lens.",
  ].join("\n");
}
