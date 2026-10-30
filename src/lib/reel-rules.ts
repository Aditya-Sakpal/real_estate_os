import { toAsciiDigits } from "./creative-rules.ts";
import { PLACEMENT_SIZE, placementsFor } from "./compose-rules.ts";

/**
 * Story reels, decided without a network, a model or a file.
 *
 * A story reel is a thirty-second advertisement cut from about eight short
 * shots, carried by one narrator and one music track, the way the agency
 * reels it was modelled on are made. None of those is one generation: they
 * are montages, and the voice and the beat are what make them flow. So the
 * pieces here are the ones an editor decides: what the script may say, how
 * long each shot runs, where the beats fall, which part of a generated clip
 * is usable, and whether a reviewed reel may go out.
 *
 * Three rules come from the product, not from taste. Every number the reel
 * says or shows is one somebody signed. The building is only ever an
 * approved picture brought to life, never drawn from words: people shots
 * are people, in places that are not the project. And a reel that did not
 * pass its review is not delivered.
 *
 * Imports are relative because the checks load this straight from source.
 */

export const REEL_FPS = 30;
export const REEL_MIN_SECONDS = 22;
export const REEL_MAX_SECONDS = 30;
export const REEL_TARGET_SECONDS = 27;
/** Reviews of the finished reel, each followed by repairs, before it is given up on. */
export const MAX_REVIEW_ROUNDS = 5;
/** Attempts at one shot's clip before the reel is given up on. */
export const MAX_SHOT_TRIES = 3;
/**
 * Times the review may send one shot back. A shot flagged again after two
 * redos is a fault another clip does not fix (or a reviewer reading the
 * shot wrongly), and paying for a third is paying for the same answer.
 */
export const MAX_SHOT_REDOS = 2;
/**
 * How much of the script the finished reel must be heard saying. A clean
 * narration scored 0.93 on the first live reel, half of one 0.61 and another
 * advertisement's 0.28.
 */
export const SPOKEN_FLOOR = 0.75;
/** The end card: logo, call to action, phone, the registration. */
export const END_CARD_SECONDS = 3;
/** The most a clip is slowed to fill its shot. More reads as slow motion. */
export const MAX_STRETCH = 0.15;
/**
 * The most seconds of video one reel may ask the video model for, first
 * pass and repairs together: about nine dollars at Kling 3.0 Pro's price in
 * September 2026. A review that keeps finding fault stops at this, rather
 * than at whatever five rounds of regenerating would have cost.
 */
export const MAX_CLIP_SECONDS = 100;
/** Seconds of spare a clip is generated with, so its slow start and tail can be cut. */
export const CLIP_HEADROOM = 2;

export type ReelMood = "uplifting" | "warm" | "cinematic" | "festive";
export const REEL_MOODS: readonly ReelMood[] = ["uplifting", "warm", "cinematic", "festive"];
export type ShotKind = "people" | "property" | "card" | "presenter";

/**
 * The two films the director makes. A narrated story is a small human story
 * told by a narrator over people and property shots. An agent on camera is a
 * presenter at the property talking to the viewer, lip-synced to their own
 * recorded lines, cut with the property, and carried by large text landing
 * on the words, so it still works with the sound off.
 */
import type { ReelFormat } from "./reel-choice.ts";
export type { ReelFormat };
export const REEL_FORMATS: readonly ReelFormat[] = ["story", "presenter"];

/** How long each film may run. A presenter explains, so it runs longer. */
export function reelBounds(format: ReelFormat): { min: number; max: number } {
  return format === "presenter" ? { min: 25, max: 50 } : { min: REEL_MIN_SECONDS, max: REEL_MAX_SECONDS };
}

export type ReelShot = {
  id: string;
  kind: ShotKind;
  /** Spoken by the narrator over this shot, in Hindi as it is spoken. May be empty. */
  narration: string;
  /** On screen, in Roman Hinglish. May be empty. */
  caption: string;
  /** People: who, where, doing what. Property: the camera move. Card: empty. */
  scene: string;
  /** What happens during the shot, in real time. */
  action: string;
  /** Property: which approved picture, counted from zero. */
  picture: number | null;
  /** Card: its words, from the approved facts. */
  card: string | null;
  /** How long the writer meant it to run. The voice decides in the end. */
  seconds: number;
  /**
   * The large text that lands on the words: up to three pieces of three to
   * five words, in order. Every number in them is checked like the narration's.
   */
  supers: string[];
};

export type ReelScript = {
  title: string;
  mood: ReelMood;
  voice: "female" | "male";
  /** The people in the story, described once so every shot shows the same ones. */
  cast: string;
  shots: ReelShot[];
  /** The end card's line: the call to action, as cleared. */
  cta: string;
};

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

/** The JSON schema the writer answers in. */
export const SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "mood", "voice", "cast", "shots", "cta"],
  properties: {
    title: { type: "string" },
    mood: { type: "string", enum: [...REEL_MOODS] },
    voice: { type: "string", enum: ["female", "male"] },
    cast: { type: "string" },
    cta: { type: "string" },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "narration", "caption", "scene", "action", "picture", "card", "seconds"],
        properties: {
          kind: { type: "string", enum: ["people", "property", "card"] },
          narration: { type: "string" },
          caption: { type: "string" },
          scene: { type: "string" },
          action: { type: "string" },
          picture: { type: ["integer", "null"] },
          card: { type: ["string", "null"] },
          seconds: { type: "number" },
        },
      },
    },
  },
} as const;

/** The same, for an agent on camera: presenter shots, and the large text on every shot. */
export const PRESENTER_SCRIPT_SCHEMA = {
  ...SCRIPT_SCHEMA,
  properties: {
    ...SCRIPT_SCHEMA.properties,
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [...SCRIPT_SCHEMA.properties.shots.items.required, "supers"],
        properties: {
          ...SCRIPT_SCHEMA.properties.shots.items.properties,
          kind: { type: "string", enum: ["presenter", "property", "people", "card"] },
          supers: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

/** What the writer is told. The facts are the only thing it may claim. */
export function scriptInstruction(input: {
  project: string;
  city: string | null;
  headline: string;
  body: string;
  cta: string;
  facts: readonly string[];
  pictures: readonly { category: string; title: string | null }[];
  audience: string | null;
  fixes: readonly string[];
  /** The placement it is made in; a reel or story is vertical, YouTube is wide. */
  placement?: string;
}): { system: string; text: string } {
  const wide = !!input.placement && isWide(input.placement);
  const system = [
    wide
      ? "You are the creative director of an Indian real-estate video agency, writing a 30-second wide 16:9 story film for YouTube,"
      : "You are the creative director of an Indian real-estate video agency, writing a 30-second vertical story reel for Instagram and Facebook,",
    "in the style of the best Indian brand films: a small human story, told by one warm",
    "narrator over music, cut from about eight short shots. Hinglish, natural and emotional, never salesy or shouty.",
    "Return JSON only.",
  ].join(" ");
  const lines = [
    `PROJECT: ${input.project}${input.city ? `, ${input.city}` : ""}`,
    input.audience ? `AUDIENCE: ${input.audience}` : "",
    `THE CLEARED CARD: headline "${input.headline}"; body "${input.body}"; call to action "${input.cta}"`,
    "APPROVED FACTS (the ONLY claims you may make; any number you use must appear here exactly as written):",
    ...input.facts.map((f) => `- ${f}`),
    "APPROVED PICTURES OF THE PROPERTY (use by index for property shots):",
    ...input.pictures.map((p, i) => `- ${i}: ${p.category.toLowerCase().replace(/_/g, " ")}${p.title ? `, ${p.title}` : ""}`),
    "",
    "STRUCTURE",
    "- 7 or 8 shots, about 24 seconds of shots in all; a 3-second end card follows, and the whole film never passes 30 seconds.",
    "- Shot 1 is people: a moment of their problem or wish, never the project or its name.",
    "- The narrator speaks about them or to the viewer, never as 'I' or 'we' who bought; never say anyone bought, booked or lives here.",
    "- Say where the project is (the PROJECT line's place) once, in the narration of a property shot.",
    "- Build it on what buyers choose a home for: the location, the view, the open space, the amenities.",
    "  Never a lift, the flooring, fittings, parking or the building's services.",
    "- A price is said and captioned exactly as the facts write it (\u20b92.19 Cr), never as a full rupee figure.",
    "- Open on people and a feeling (the hook), then the turn, then the home, then why it fits their life, then the invitation.",
    "- At least three property shots, each using a different approved picture, and one or two people shots between them.",
    "- At most one card shot: a single short line of big type from the approved facts (for example the price or the key fact).",
    "",
    "EACH SHOT",
    "- narration: what the narrator says over it, in Hindi written in Devanagari, with English words (BHK, lift, sea view)",
    "  in Latin letters as Indians say them. One short sentence of at most 8 words, 2 to 3.5 seconds when spoken. Numbers",
    "  in digits, exactly as in the facts. 30 to 45 words in the whole film; one or two shots have none.",
    "- caption: the same line in Roman Hinglish for the screen, at most 7 words. Empty when there is no narration.",
    "- people shots: scene = who, where and doing what, in one sentence. They must NEVER show a building exterior, a",
    "  tower, the project, or the inside of the flat being sold: only people, in ordinary places (a cafe, a car, a",
    "  rented room, a park, a family dinner), because a home drawn from words is a home nobody built.",
    "- property shots: picture = the index; scene = one slow camera move (a gentle push-in, a slow pan, a slight rise);",
    "  nothing is added to the picture.",
    "- action: what happens during the shot in real time, one clause (for example 'she turns to him and smiles').",
    "- seconds: people 3 to 4, property 2.5 to 3.5, card 2.5, matched to the narration.",
    "- cast: describe the family once (ages, clothes, looks) so every people shot shows the same people.",
    "- cta: the cleared call to action, word for word.",
    "- Never promise anything that is not in the facts: no returns, no discounts, no possession dates, no 'best' or",
    "  'guaranteed', no rankings.",
  ];
  if (input.fixes.length) lines.push("", "FIX FROM YOUR LAST DRAFT", ...input.fixes.map((f) => `- ${f}`));
  return { system, text: lines.filter((l) => l !== "").join("\n") };
}

/**
 * What the writer of an agent on camera is told: the reference reels' shape
 * (template 17's production notes), with the same facts and the same limits
 * as a story. The presenter says the lines; the large text carries them when
 * the sound is off.
 */
export function presenterInstruction(input: Parameters<typeof scriptInstruction>[0]): { system: string; text: string } {
  const wide = !!input.placement && isWide(input.placement);
  const system = [
    `You are the creative director of an Indian real-estate video agency, writing a 35-second ${wide ? "wide 16:9 film for YouTube" : "vertical reel for Instagram and Facebook"}`,
    "in the 'agent on camera' format: a property advisor stands at the project and talks straight to the viewer, cut",
    "with shots of the property, while large text lands on the words they stress. Hinglish, confident and warm, never shouty.",
  ].join(" ");
  const lines = [
    `PROJECT: ${input.project}${input.city ? `, ${input.city}` : ""}`,
    input.audience ? `AUDIENCE: ${input.audience}` : "",
    `THE CLEARED CARD: headline "${input.headline}"; body "${input.body}"; call to action "${input.cta}"`,
    "APPROVED FACTS (the ONLY claims you may make; any number you use must appear here exactly as written):",
    ...input.facts.map((f) => `- ${f}`),
    "APPROVED PICTURES OF THE PROPERTY (use by index for presenter and property shots):",
    ...input.pictures.map((p, i) => `- ${i}: ${p.category.toLowerCase().replace(/_/g, " ")}${p.title ? `, ${p.title}` : ""}`),
    "",
    "STRUCTURE",
    "- 7 to 9 shots, about 35 seconds of shots in all; an end card is added after them.",
    "- Shot 1 is the presenter with the hook: a question or a challenge aimed at the viewer, never the project's name.",
    "- Then the presenter says where it is (the PROJECT line's place).",
    "- Then three or four specifics from the facts, one per shot, alternating presenter and property shots; a property",
    "  shot shows what its line talks about. Location, view, open space and amenities first; never a lift, flooring,",
    "  fittings, parking or the building's services.",
    "- A price, if the facts carry one, is said and set exactly as the facts write it (₹2.19 Cr).",
    "- The last shot is the presenter with the invitation.",
    "- At least three presenter shots and three property shots; at most two lifestyle shots; at most one card.",
    "",
    "EACH SHOT",
    "- narration: what the presenter says, to camera on a presenter shot and over the picture on the others. Hindi in",
    "  Devanagari, with English words (BHK, sea view, site visit) in Latin letters as Indians say them. One short",
    "  sentence, 2 to 4 seconds when spoken. Numbers in digits, exactly as in the facts. Every presenter shot speaks.",
    "- supers: the large text, one to three pieces of three to five words each, in English or Roman Hinglish, the words",
    "  the presenter stresses, in the order they are said; every number exactly as in the facts. Empty on a card.",
    "- caption: the line in Roman Hinglish for the subtitle, at most 7 words.",
    "- presenter shots: kind presenter; picture = the approved picture they stand in front of (an exterior, the lobby or",
    "  an amenity); scene = where they stand and how they are framed (waist up, facing the camera); action = the gesture",
    "  while they talk (an open hand toward the building, a nod).",
    "- property shots: picture = the index; scene = one slow camera move; nothing is added to the picture.",
    "- people shots (lifestyle, optional): ordinary places only, never a building, the project or the flat.",
    "- cast: describe the presenter once (an Indian property advisor, age, smart professional clothes, hair) so every",
    "  presenter shot is the same person; voice: female or male to match.",
    "- cta: the cleared call to action, word for word.",
    "- Never promise anything that is not in the facts: no returns, no discounts, no possession dates, no 'best' or",
    "  'guaranteed', no rankings.",
  ];
  if (input.fixes.length) lines.push("", "FIX FROM YOUR LAST DRAFT", ...input.fixes.map((f) => `- ${f}`));
  return { system, text: lines.filter((l) => l !== "").join("\n") };
}

/**
 * A writer's answer, read defensively: every field typed, every index real,
 * shot ids given in order. Problems are returned rather than thrown, because
 * the next step is telling the writer what to fix.
 */
export function parseScript(
  raw: unknown,
  pictures: number,
  format: ReelFormat = "story",
): { script: ReelScript | null; problems: string[] } {
  const problems: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const mood = REEL_MOODS.includes(o.mood as ReelMood) ? (o.mood as ReelMood) : "uplifting";
  const shotsRaw = Array.isArray(o.shots) ? (o.shots as Record<string, unknown>[]) : [];
  const shots: ReelShot[] = shotsRaw.map((s, i) => {
    const kind: ShotKind =
      s.kind === "property" || s.kind === "card" || (s.kind === "presenter" && format === "presenter") ? s.kind : "people";
    const picture = typeof s.picture === "number" && Number.isInteger(s.picture) ? s.picture : null;
    return {
      id: `s${i + 1}`,
      kind,
      narration: str(s.narration),
      caption: str(s.caption),
      scene: str(s.scene),
      action: str(s.action),
      // A presenter stands in front of an approved picture, so it names one too.
      picture: kind === "property" || kind === "presenter" ? picture : null,
      card: kind === "card" ? str(s.card) || null : null,
      seconds: Math.min(5, Math.max(2, Number(s.seconds) || 3)),
      supers: Array.isArray(s.supers) ? (s.supers as unknown[]).map(str).filter(Boolean).slice(0, 3) : [],
    };
  });
  if (shots.length < 6 || shots.length > 9) problems.push(`Write 7 or 8 shots, not ${shots.length}.`);
  if (format !== "presenter" && shots[0] && shots[0].kind !== "people") problems.push("Open on people: shot 1 is a moment of their problem or wish, never the project.");
  if (format === "presenter") {
    const presenter = shots.filter((s) => s.kind === "presenter");
    if (presenter.length < 3) problems.push("An agent on camera needs at least three presenter shots.");
    if (shots[0] && shots[0].kind !== "presenter") problems.push("Open on the presenter: the hook is said to camera.");
    if (shots.filter((s) => s.kind === "people").length > 2) problems.push("At most two lifestyle shots; the presenter and the property carry this film.");
    for (const s of presenter) {
      if (!s.narration) problems.push(`Shot ${s.id} is a presenter shot with no line: a presenter on camera always speaks.`);
      if (s.picture === null || s.picture < 0 || s.picture >= pictures) {
        problems.push(`Shot ${s.id} is a presenter shot with no approved picture behind the presenter; give it a picture index.`);
      }
    }
    for (const s of shots) {
      for (const t of s.supers) {
        if (t.split(/\s+/).filter(Boolean).length > 6) problems.push(`Shot ${s.id}'s large text "${t.slice(0, 40)}" is too long; three to five words.`);
      }
    }
    if (!shots.some((s) => s.supers.length)) problems.push("Give the shots their large text: three to five words at a time, on the words the presenter stresses.");
  }
  shots.forEach((s) => {
    if (s.kind === "property" && (s.picture === null || s.picture < 0 || s.picture >= pictures)) {
      problems.push(`Shot ${s.id} is a property shot with no approved picture; give it a picture index from the list.`);
    }
    if (s.kind === "card" && !s.card) problems.push(`Shot ${s.id} is a card with no words on it.`);
    if (s.kind === "people" && !s.scene) problems.push(`Shot ${s.id} is a people shot with no scene.`);
  });
  if (shots.filter((s) => s.kind === "property").length < Math.min(3, pictures)) {
    problems.push("Show the property: at least three property shots, each from an approved picture.");
  }
  if (!str(o.cta)) problems.push("Give the call to action.");
  if (!shots.length) return { script: null, problems };
  return {
    script: {
      title: str(o.title) || "Story reel",
      mood,
      voice: o.voice === "male" ? "male" : "female",
      cast: str(o.cast),
      shots,
      cta: str(o.cta),
    },
    problems,
  };
}

/** Every number written in a piece of text, commas and spaces inside it removed. */
export function numbersIn(text: string): string[] {
  return [...toAsciiDigits(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => m[0].replace(/,/g, "").replace(/\.$/, ""))
    .filter(Boolean);
}

/**
 * A sentence with its negated clauses taken out: "no buildings or project
 * visible" says nothing about the project, and reading it as a request to
 * show one refused every careful direction on the first live director's
 * people shots. The clause runs from the negating word to the next comma,
 * full stop or semicolon, so "no doubt, add two floors" still reads "add two
 * floors".
 */
export function withoutNegations(text: string): string {
  return text.replace(/\b(no|not|never|without|free of|avoid|avoiding|nothing of|none of|don't|do not)\b[^.,;:!?]*/gi, " ");
}

/**
 * A line as the narrator should SAY it. The script keeps a price the way the
 * facts write it (₹1.45 Cr), because that is what the gate checks and what the
 * captions show; read aloud as written, the voice said "ek BH ki starting" on
 * the first agent on camera, and the transcriber heard ₹2.19 Cr as ₹2.89 Cr.
 * So only the voice's copy is spelled out: rupee amounts in lakh and crore
 * words, BHK as its letters, a star dropped.
 */
export function forSpeech(line: string): string {
  return line
    .replace(/₹\s*(\d[\d,]*(?:\.\d+)?)\s*(?:Cr|crore)\b\*?/gi, (_, n: string) => `${n.replace(/,/g, "")} करोड़ रुपये`)
    .replace(/₹\s*(\d[\d,]*(?:\.\d+)?)\s*(?:L|Lakh|lakh|Lac)\b\*?/gi, (_, n: string) => `${n.replace(/,/g, "")} लाख रुपये`)
    .replace(/(\d)\s*BHK\b/gi, "$1 बी एच के")
    .replace(/\bBHK\b/gi, "बी एच के")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const PROPERTY_WORDS =
  /\b(tower|towers|building|buildings|facade|façade|high-?rise|apartment complex|project|sample flat|show flat|their new (?:flat|home|apartment)|the new (?:flat|home|apartment)|balcony of the|lobby of)\b/i;

/**
 * The claims gate for a script, the same bargain the copy gate makes: every
 * number anywhere in it is one the approved facts carry, no never-say phrase
 * appears, and no people shot draws the property.
 */
export function scriptProblems(script: ReelScript, cleared: readonly string[], neverSay: readonly string[]): string[] {
  const out: string[] = [];
  const allowed = new Set(cleared.flatMap(numbersIn));
  const said = (s: ReelShot) => [s.narration, s.caption, s.card ?? "", ...(s.supers ?? [])].join(" ");
  for (const s of script.shots) {
    const bad = numbersIn(said(s)).filter((n) => !allowed.has(n));
    if (bad.length) out.push(`Shot ${s.id} uses a number the approved facts do not have. Use only numbers from the facts, exactly as written.`);
    if (s.kind === "people" && PROPERTY_WORDS.test(withoutNegations(`${s.scene} ${s.action}`))) {
      out.push(`Shot ${s.id} is a people shot that shows the property. Keep people in ordinary places; the home is shown only in property shots.`);
    }
    if (s.caption.split(/\s+/).filter(Boolean).length > 7) out.push(`Shot ${s.id}'s caption is too long; keep it to seven words.`);
    if (s.narration.split(/\s+/).filter(Boolean).length > 9) out.push(`Shot ${s.id}'s narration is too long; keep it to eight words.`);
  }
  // Counted before the voice is paid for: a 30-second film holds about 45 words.
  const narrated = script.shots.reduce((a, s) => a + s.narration.split(/\s+/).filter(Boolean).length, 0);
  if (narrated > 45) out.push(`The narration is ${narrated} words; keep the whole film to 45 so it fits in 30 seconds.`);
  const text = [...script.shots.map(said), script.cta, script.title].join(" ").toLowerCase();
  for (const phrase of neverSay) {
    const p = phrase.trim().toLowerCase();
    if (p.length >= 3 && text.includes(p)) out.push(`The script says "${phrase.trim()}", which is on the never-say list.`);
  }
  if (numbersIn(script.cta).some((n) => !allowed.has(n))) out.push("The call to action uses a number the facts do not have.");
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * How long each shot runs: its narration, a breath after it, and never
 * shorter than a shot can be read. A shot with no narration keeps what the
 * writer asked for. The narration is what the audience follows, so it wins.
 */
export function shotSeconds(shots: readonly ReelShot[], spoken: readonly (number | null)[]): number[] {
  return shots.map((s, i) => {
    const voice = spoken[i];
    const floor = s.kind === "card" ? 2.5 : 2.2;
    // A presenter's shot ends soon after they stop talking: the next cut is
    // the answer to what they said, not a pause.
    const want = voice ? voice + (s.kind === "presenter" ? 0.3 : 0.45) : s.seconds;
    return Math.round(Math.min(7, Math.max(floor, want)) * 100) / 100;
  });
}

/**
 * The beats of a music track from its loudness envelope: onsets where the
 * energy rises, the tempo that best repeats them (60 to 180 beats a minute,
 * by autocorrelation), and the phase that lands on the most of them.
 * `hz` is how many envelope values a second.
 */
export function beatGrid(envelope: readonly number[], hz: number): { bpm: number; beats: number[] } {
  const n = envelope.length;
  if (n < hz * 4) return { bpm: 0, beats: [] };
  const onset = envelope.map((v, i) => (i ? Math.max(0, v - envelope[i - 1]) : 0));
  const mean = onset.reduce((a, b) => a + b, 0) / n || 1;
  const norm = onset.map((v) => v / mean);
  let bestLag = 0;
  let bestScore = -1;
  const lo = Math.round((hz * 60) / 180);
  const hi = Math.round((hz * 60) / 60);
  for (let lag = lo; lag <= hi; lag++) {
    let score = 0;
    for (let i = lag; i < n; i++) score += norm[i] * norm[i - lag];
    // A mild preference for tempos near 110, where most background tracks sit.
    const bpm = (hz * 60) / lag;
    score *= 1 - Math.min(0.3, Math.abs(bpm - 110) / 400);
    if (score > bestScore) [bestScore, bestLag] = [score, lag];
  }
  let bestPhase = 0;
  let phaseScore = -1;
  for (let p = 0; p < bestLag; p++) {
    let s = 0;
    for (let i = p; i < n; i += bestLag) s += norm[i];
    if (s > phaseScore) [phaseScore, bestPhase] = [s, p];
  }
  const beats: number[] = [];
  for (let i = bestPhase; i < n; i += bestLag) beats.push(Math.round((i / hz) * 1000) / 1000);
  return { bpm: Math.round((hz * 60) / bestLag), beats };
}

/**
 * Cut points moved onto the nearest beat, when one is within `tolerance`
 * seconds, and never so far that a shot falls under two seconds. Cuts on the
 * beat are what make a montage feel edited rather than assembled.
 */
export function snapCuts(durations: readonly number[], beats: readonly number[], tolerance = 0.3): number[] {
  if (!beats.length) return [...durations];
  const out: number[] = [];
  let at = 0;
  let snappedAt = 0;
  for (const d of durations) {
    const cut = at + d;
    const near = beats.reduce((b, x) => (Math.abs(x - cut) < Math.abs(b - cut) ? x : b), beats[0]);
    const target = Math.abs(near - cut) <= tolerance && near - snappedAt >= 2 ? near : cut;
    out.push(Math.round((target - snappedAt) * 100) / 100);
    snappedAt = target;
    at = cut;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The editor: which part of a clip to use
// ---------------------------------------------------------------------------

/**
 * The window of a generated clip a shot uses, from its motion curve (mean
 * frame-to-frame difference, `hz` values a second).
 *
 * A video model starts every clip with a moment of near stillness before the
 * action gets going, and often slows or smears at the very end; a clip cut
 * blindly from zero carries both. So the window starts where motion first
 * reaches a quarter of the clip's typical motion, stops short of the last
 * third of a second, and for a people shot is placed where the action is
 * busiest. A window a little short is filled by slowing the clip, up to
 * `MAX_STRETCH`; more than that and the clip is made again, because slow
 * motion reads as a mistake. Null means "make it again".
 */
export function chooseWindow(
  curve: readonly number[],
  hz: number,
  need: number,
  kind: ShotKind,
): { start: number; rate: number } | null {
  if (!curve.length) return null;
  const clip = curve.length / hz;
  const smooth = curve.map((_, i) => {
    const a = curve.slice(Math.max(0, i - 2), i + 3);
    return a.reduce((x, y) => x + y, 0) / a.length;
  });
  const sorted = [...smooth].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.75)] || 0;
  let first = smooth.findIndex((v) => v >= typical * 0.25);
  if (first < 0) first = 0;
  const start0 = Math.max(0.15, first / hz - 0.1);
  const end = clip - 0.35;
  const available = end - start0;
  if (available >= need) {
    if (kind !== "people") return { start: round2(start0), rate: 1 };
    // The busiest stretch of the right length: where the action happens.
    let best = start0;
    let bestSum = -1;
    for (let t = start0; t + need <= end + 1e-6; t += 1 / hz) {
      const from = Math.floor(t * hz);
      const to = Math.floor((t + need) * hz);
      const sum = smooth.slice(from, to).reduce((x, y) => x + y, 0);
      if (sum > bestSum) [bestSum, best] = [sum, t];
    }
    return { start: round2(best), rate: 1 };
  }
  if (available >= need * (1 - MAX_STRETCH)) return { start: round2(start0), rate: round2(available / need) };
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The length to ask the video model for: the shot, plus room to cut, in whole seconds from 3 to 15. */
export function clipSeconds(need: number): number {
  return Math.min(15, Math.max(3, Math.ceil(need + CLIP_HEADROOM)));
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

export type Track = { file: string; mood: string; seconds: number; title: string; artist: string };

/**
 * The track under one reel: of its mood, long enough, and not one this
 * developer's recent reels used, so no two reels in a feed share a song.
 * With nothing of the mood left, any unused track long enough; with nothing
 * unused, the least recently used one.
 */
export function pickTrack(
  tracks: readonly Track[],
  mood: ReelMood,
  seconds: number,
  recent: readonly string[],
  seed: number,
): Track | null {
  const long = tracks.filter((t) => t.seconds >= seconds);
  if (!long.length) return null;
  const fresh = long.filter((t) => !recent.includes(t.file));
  const pool = fresh.filter((t) => t.mood === mood).length
    ? fresh.filter((t) => t.mood === mood)
    : fresh.length
      ? fresh
      : [...long].sort((a, b) => recent.lastIndexOf(a.file) - recent.lastIndexOf(b.file)).slice(0, 1);
  return pool[Math.abs(seed) % pool.length];
}

/** The narration's spans, for the music to dip under: [start, end] seconds. */
export function duckSpans(voice: readonly { at: number; seconds: number }[]): [number, number][] {
  return voice.map((v) => [round2(v.at), round2(v.at + v.seconds)]);
}

// ---------------------------------------------------------------------------
// The reviewer
// ---------------------------------------------------------------------------

export type ReviewIssue = {
  /** The shot the problem is in, or null for the reel as a whole. */
  shot: string | null;
  kind: "artefact" | "building" | "text" | "pacing" | "story" | "audio" | "other";
  /** What to do about it. */
  fix: "regenerate" | "retrim" | "rewrite" | "none";
  blocker: boolean;
  note: string;
};

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues"],
  properties: {
    verdict: { type: "string", enum: ["deliver", "repair"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["shot", "kind", "fix", "blocker", "note"],
        properties: {
          shot: { type: ["string", "null"] },
          kind: { type: "string", enum: ["artefact", "building", "text", "pacing", "story", "audio", "other"] },
          fix: { type: "string", enum: ["regenerate", "retrim", "rewrite", "none"] },
          blocker: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
  },
} as const;

export type HardFindings = {
  /** Every sampled frame's QR decoded to the approved lockup. */
  qrScans: boolean;
  /** How much of the script the transcript of the finished reel carries, 0 to 1. */
  spokenMatch: number;
  seconds: number;
  /** Shots whose last frame no longer matched their approved picture. */
  buildingDrift: readonly string[];
  /** What the pixel gate failed on the render, in the client's words. */
  pixel?: readonly string[];
};

/**
 * Whether a reviewed reel may go out, and what to repair if not. Code
 * decides the rules (the QR scans, the narration is the script, the length,
 * the building); the reviewer's reading decides taste, and only a blocker
 * holds a reel back. Every repair names a shot, so a round redoes a shot,
 * not the reel.
 */
export function judgeReel(
  hard: HardFindings,
  taste: { issues: readonly ReviewIssue[] } | null,
  shotIds: readonly string[],
): { passed: boolean; problems: string[]; redo: { shot: string; fix: "regenerate" | "retrim"; note: string }[] } {
  const problems: string[] = [];
  const redo: { shot: string; fix: "regenerate" | "retrim"; note: string }[] = [];
  if (!hard.qrScans) problems.push("The RERA QR code does not scan on every shot.");
  if (hard.spokenMatch < SPOKEN_FLOOR) problems.push("The narration does not carry the approved script.");
  if (hard.seconds < REEL_MIN_SECONDS || hard.seconds > REEL_MAX_SECONDS) {
    problems.push(`The reel runs ${Math.round(hard.seconds)} seconds, outside ${REEL_MIN_SECONDS} to ${REEL_MAX_SECONDS}.`);
  }
  for (const id of hard.buildingDrift) {
    problems.push(`Shot ${id} changed the building.`);
    redo.push({ shot: id, fix: "regenerate", note: "The building changed; keep it exactly as in the approved picture." });
  }
  if (!taste) problems.push("The reel could not be reviewed.");
  for (const i of taste?.issues ?? []) {
    if (!i.blocker) continue;
    problems.push(`${i.shot ? `Shot ${i.shot}: ` : ""}${i.note}`.slice(0, 240));
    if (i.shot && shotIds.includes(i.shot) && (i.fix === "regenerate" || i.fix === "retrim")) {
      if (!redo.some((r) => r.shot === i.shot)) redo.push({ shot: i.shot, fix: i.fix, note: i.note.slice(0, 240) });
    }
  }
  return { passed: problems.length === 0, problems, redo };
}

/**
 * The repairs a round may still make: a shot already sent back
 * `MAX_SHOT_REDOS` times is not sent back again. When nothing is left the
 * reel is given up on, rather than reviewed again unchanged.
 */
export function repairsLeft<T extends { shot: string }>(redo: readonly T[], redone: ReadonlyMap<string, number>): T[] {
  return redo.filter((r) => (redone.get(r.shot) ?? 0) < MAX_SHOT_REDOS);
}

/**
 * How much of the script a transcript carries, 0 to 1: the share of the
 * script's sound that was heard, loosely.
 *
 * Compared by SOUND, not spelling. The script is Hinglish in two scripts
 * ("rent के कमरे में") and the transcriber writes what it hears in one: on the
 * first live reel it wrote रेंट for "rent" and एड्रेस for "address", and a
 * word-for-word match scored a perfect narration 0.4. So every word becomes a
 * consonant skeleton (Devanagari transliterated first, vowels and aspiration
 * dropped, near sounds folded), a skeleton counts as heard when the
 * transcript holds it or one a letter away, and each counts by its length, so
 * के and है matching by chance weigh little. Numbers are left out: the
 * narrator says "2,18,24,000" as words, and the figures are checked where
 * they are written.
 */
export function spokenMatch(script: readonly string[], transcript: string): number {
  const want = script.flatMap(soundWords).filter((w) => !/\d/.test(w.word));
  if (!want.length) return 1;
  const heard = soundWords(transcript).map((w) => w.sound);
  const heardSet = new Set(heard);
  let total = 0;
  let got = 0;
  for (const w of want) {
    const weight = Math.max(1, w.sound.length);
    total += weight;
    if (heardSet.has(w.sound) || (w.sound.length >= 3 && heard.some((h) => oneApart(w.sound, h)))) got += weight;
  }
  return Math.round((got / total) * 100) / 100;
}

const DEVANAGARI: Record<string, string> = {
  क: "k", ख: "kh", ग: "g", घ: "gh", ङ: "n", च: "ch", छ: "ch", ज: "j", झ: "jh", ञ: "n",
  ट: "t", ठ: "th", ड: "d", ढ: "dh", ण: "n", त: "t", थ: "th", द: "d", ध: "dh", न: "n",
  प: "p", फ: "ph", ब: "b", भ: "bh", म: "m", य: "y", र: "r", ल: "l", ळ: "l", व: "v",
  श: "sh", ष: "sh", स: "s", ह: "h", "ं": "n", "ँ": "n", "ः": "h",
  अ: "a", आ: "a", इ: "i", ई: "i", उ: "u", ऊ: "u", ए: "e", ऐ: "e", ओ: "o", औ: "o", ऋ: "ri",
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "े": "e", "ै": "e", "ो": "o", "ौ": "o", "ृ": "ri", "ॅ": "e", "ॉ": "o",
};
/** A consonant with a nukta is a different sound: ज़ is z, फ़ is f, ड़ is r. */
const NUKTA: Record<string, string> = { ज: "z", फ: "f", ड: "r", ढ: "rh", क: "k", ख: "kh", ग: "g" };

function transliterate(word: string): string {
  const chars = [...word.normalize("NFD")];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (chars[i + 1] === "\u093C" && NUKTA[c]) {
      out += NUKTA[c];
      i++;
    } else out += DEVANAGARI[c] ?? (/[a-z]/.test(c) ? c : "");
  }
  return out;
}

/** The consonant skeleton of a Latin word: what survives any spelling of how it sounds. */
function skeleton(latin: string): string {
  let w = latin
    .replace(/dge/g, "j")
    .replace(/ch/g, "C")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/ck/g, "k")
    .replace(/c/g, "k")
    .replace(/C/g, "c")
    .replace(/ph/g, "f")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/w/g, "v")
    .replace(/z/g, "j")
    .replace(/([kgtdbpjsc])h/g, "$1");
  w = w.replace(/(?!^)h/g, "").replace(/[aeiouy]/g, "");
  return w.replace(/(.)\1+/g, "$1");
}

function soundWords(text: string): { word: string; sound: string }[] {
  return toAsciiDigits(text)
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => [...w].length > 1)
    .map((word) => ({ word, sound: skeleton(/[\u0900-\u097F]/.test(word) ? transliterate(word) : word) }))
    .filter((w) => w.sound.length > 0 || /\d/.test(w.word));
}

/** Whether two skeletons are at most one letter apart (Levenshtein). */
function oneApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// ---------------------------------------------------------------------------
// The studio's choice
// ---------------------------------------------------------------------------

/** How the studio offers a story reel beside the three post kinds: in `reel-choice.ts`, which a client component can import. */
export { MAX_LIVE_STORIES, PRESENTER_TEMPLATE, STORY_TEMPLATE, reelFormatFor } from "./reel-choice.ts";

/** The brief's formats a story reel is made in: every video one, vertical or wide. */
export function reelPlacements(briefFormats: readonly string[]): string[] {
  return placementsFor("VIDEO", briefFormats);
}

/** Whether a placement is wider than it is tall. */
export function isWide(placement: string): boolean {
  const s = PLACEMENT_SIZE[placement];
  return !!s && s.w > s.h;
}

/**
 * How an approved picture becomes a shot's first frame: cropped when its
 * shape is near enough the placement's that a cover crop loses at most a
 * quarter of it, otherwise extended by the image model with the building
 * left as it is. A 3:2 render goes to 16:9 by a crop; the same render in a
 * 9:16 reel is extended above and below.
 */
export function frameFit(picture: { w: number; h: number }, target: { w: number; h: number }): "crop" | "extend" {
  const ratio = picture.w / picture.h / (target.w / target.h);
  return ratio >= 0.75 && ratio <= 1 / 0.75 ? "crop" : "extend";
}
