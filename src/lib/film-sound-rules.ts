/**
 * A narrated film's sound, made for it (the client, 11 October 2026).
 *
 * A narrated film used to keep the video model's own score with its voice
 * taken out by Demucs. The model ducks its music under its own narrator, and
 * Demucs takes the voice band with the voice, so the score was nearly silent
 * wherever the model spoke; our narrator never lands exactly there, and the
 * film went quiet between lines (a launch film fell to -54 dB at 3 to 4.5 s).
 * So the score is composed for each film (ElevenLabs Music, its sections cut
 * to the film's own cuts) and every scene gets its own background sound
 * (ElevenLabs Sound Effects), and the video model's sound is not used.
 *
 * The pure half: the brief per template, which place a scene sounds like,
 * the sections, the mix's numbers and envelopes. `film-sound.ts` asks and mixes.
 */

export const SOUND = {
  musicModel: "music_v1",
  sfxModel: "eleven_text_to_sound_v2",
  /** One cue a film, asked again once when it failed or faded early. */
  maxScoreRequests: 2,
  /** Background sounds a film: one per place, and two asked again. */
  maxPlaces: 6,
  maxAmbienceRequests: 8,
  /** ElevenLabs refuses a section under three seconds. */
  minSectionMs: 3000,
  /** A cue runs on past the film, so it never ends inside it; we fade it ourselves. */
  outroMs: 3000,
  voiceLufs: -16,
  /** The finished film's loudness, about what the narrated films had. */
  filmLufs: -16.5,
  musicLufs: -23,
  /** The music under the narrator, and the background sound. */
  musicDuckDb: -5,
  ambienceDuckDb: -3,
  crossfade: 0.5,
  fadeIn: 0.15,
  fadeOut: 1.6,
  /** A near-silent clip is never lifted further than this to reach its level. */
  maxAmbienceGainDb: 18,
  /** The cue's last seconds this far under its own middle is a cue that ended early. */
  fadedEarlyDb: 12,
} as const;

// ---------------------------------------------------------------------------
// The music, per template
// ---------------------------------------------------------------------------

export type MusicBrief = {
  /** Instrument palettes; one is chosen per film so two films of a template differ. */
  palettes: readonly string[];
  global: readonly string[];
  avoid: readonly string[];
  open: readonly string[];
  middle: readonly string[];
  /** From the reveal (the building) or the last third, to the end. */
  close: readonly string[];
};

const NEVER_IN_MUSIC = ["vocals", "choir", "singing", "humming", "spoken words", "epic trailer", "risers", "big hits", "abrupt ending"];

export const MUSIC_BRIEF: Readonly<Record<string, MusicBrief>> = {
  // Lodha's grammar: slow, intimate, a swell at the building, held to the end.
  "01-launch-film": {
    palettes: ["solo felt piano with warm soft strings", "soft piano with a solo cello", "gentle piano with ambient pads and harp"],
    global: ["luxury real estate film score", "slow 68 bpm", "elegant", "calm", "intimate", "golden hour", "cinematic minimalism", "instrumental"],
    avoid: [...NEVER_IN_MUSIC, "drums", "percussion", "beat", "electronic", "synth lead", "fast", "upbeat pop"],
    open: ["sparse", "soft sustained notes", "lots of space", "gentle"],
    middle: ["the melody continues", "warm low strings enter softly", "tender"],
    close: ["warm swell", "full and glowing", "sustained, held to the end of the section"],
  },
  // A family's small story: warm, a little wistful, lifting at the turn.
  story: {
    palettes: ["soft acoustic guitar and piano", "warm piano with gentle strings", "light acoustic guitar with soft strings and glockenspiel"],
    global: ["warm intimate film score", "80 bpm", "tender", "hopeful", "family warmth", "heartfelt", "instrumental"],
    avoid: [...NEVER_IN_MUSIC, "heavy drums", "electronic", "dark", "sad", "fast"],
    open: ["gentle", "a little wistful", "simple melody"],
    middle: ["warmth grows", "strings join softly"],
    close: ["hopeful lift", "warm and resolving", "sustained, held to the end of the section"],
  },
  // A location film: light, modern, optimistic, a soft pulse under the times.
  "12-locality-guide": {
    palettes: ["light piano with a soft electronic pulse and warm pads", "plucked strings with a gentle pulse and soft pads", "clean guitar with light percussion and airy pads"],
    global: ["modern real estate location film score", "95 bpm", "optimistic", "clear", "premium", "steady forward motion", "instrumental"],
    avoid: [...NEVER_IN_MUSIC, "aggressive drums", "dark", "sad", "dubstep", "heavy bass drops"],
    open: ["airy", "a soft pulse begins", "open and bright"],
    middle: ["the pulse steadies", "a little fuller", "light percussion"],
    close: ["warm resolve", "golden", "sustained, held to the end of the section"],
  },
  // Progress on site: steady, confident, moving forward.
  "06-construction-update": {
    palettes: ["soft pulsing piano with light strings", "steady muted guitar with warm pads", "piano ostinato with gentle cello"],
    global: ["modern documentary score", "100 bpm", "steady", "confident", "forward moving", "optimistic", "instrumental"],
    avoid: [...NEVER_IN_MUSIC, "aggressive drums", "dark", "sad", "dubstep"],
    open: ["a steady pulse begins", "light"],
    middle: ["builds gently", "a little fuller"],
    close: ["confident resolve", "warm", "sustained, held to the end of the section"],
  },
};

/** Any other narrated template sounds like the launch film's calmer cousin. */
export const DEFAULT_BRIEF: MusicBrief = {
  palettes: ["soft piano with warm strings", "gentle acoustic guitar with soft pads"],
  global: ["warm real estate film score", "75 bpm", "calm", "hopeful", "instrumental"],
  avoid: [...NEVER_IN_MUSIC, "drums", "electronic", "fast"],
  open: ["gentle", "sparse"],
  middle: ["warmer", "fuller"],
  close: ["warm resolve", "sustained, held to the end of the section"],
};

export function briefFor(template: string | null | undefined): MusicBrief {
  return (template && MUSIC_BRIEF[template]) || DEFAULT_BRIEF;
}

/** A number from text, the same every time: which palette a film gets. */
export function soundSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Which place a scene sounds like
// ---------------------------------------------------------------------------

export type SoundPlace = "POOL" | "GARDEN" | "ROOM" | "BEDROOM" | "KITCHEN" | "LOUNGE" | "GYM" | "LOBBY" | "TOWER" | "STREET" | "SITE";

const AMBIENCE: Readonly<Record<SoundPlace, { sound: string; lufs: number }>> = {
  POOL: { sound: "a calm swimming pool: gentle water lapping softly against tiles throughout, a light breeze, a few faint distant birds", lufs: -34 },
  GARDEN: { sound: "a landscaped garden: leaves moving in a light breeze and soft birdsong throughout", lufs: -36 },
  ROOM: { sound: "a quiet bright apartment living room by an open window: a soft constant breeze through sheer curtains and faint distant birdsong throughout", lufs: -39 },
  BEDROOM: { sound: "a calm bedroom: soft room tone with a faint steady distant city air outside the window", lufs: -43 },
  KITCHEN: { sound: "a quiet home kitchen: soft room tone, a faint fridge hum, light breeze from a window", lufs: -41 },
  LOUNGE: { sound: "a quiet luxury residents' lounge: soft air conditioning hush and calm room tone throughout", lufs: -41 },
  GYM: { sound: "a quiet residents' gym: soft air conditioning hum and calm room tone throughout", lufs: -42 },
  LOBBY: { sound: "a high-ceilinged residential lobby: soft echoing room tone and a faint air conditioning hush throughout", lufs: -40 },
  TOWER: { sound: "a city heard from a high-rise garden: gentle steady wind, distant soft traffic hum and a few birds", lufs: -36 },
  STREET: { sound: "a quiet residential street in an Indian city: distant soft traffic hum and a few birds throughout", lufs: -37 },
  SITE: { sound: "a construction site heard from a distance: a soft steady machinery hum, an occasional distant metal clank, wind", lufs: -36 },
};

const PLACE_WORDS: readonly [SoundPlace, RegExp][] = [
  ["POOL", /\bpool|swim|deck\b|water\b/i],
  ["GYM", /\bgym|fitness|treadmill|workout/i],
  ["BEDROOM", /\bbed(room)?\b|bedside|pillow|linen/i],
  ["KITCHEN", /\bkitchen|cooking|counter ?top|stove/i],
  ["LOBBY", /\blobby|entrance hall|reception|corridor|lift\b/i],
  ["LOUNGE", /\blounge|clubhouse|club house|caf[eé]|library|banquet|games room|multipurpose/i],
  ["GARDEN", /\bgarden|lawn|park\b|landscap|jogging|tree|terrace garden|play ?area|courtyard/i],
  ["SITE", /\bconstruction|slab|crane|scaffold|site work|concrete|excavat/i],
  ["ROOM", /\bliving|room\b|sofa|window|balcony|dining|home office|study|curtain|apartment|flat\b/i],
  ["TOWER", /\btower|building|facade|façade|exterior|skyline|rooftop|elevation|aerial|drone/i],
  ["STREET", /\bstreet|road|market|office|metro|station|traffic|auto ?rickshaw|bus\b/i],
];

export type SoundScene = {
  kind: string;
  shot: string;
  /** The approved picture the scene was made from, when it was one. */
  picture?: { category: string; title: string | null } | null;
  /** Planned start and end, in seconds. */
  start: number;
  end: number;
};

/**
 * The place a scene sounds like: a building or site picture is that, then the
 * picture's title, then the shot's words, then the picture's kind. A scene
 * nothing places plays the music alone.
 */
export function placeOf(sc: SoundScene): SoundPlace | null {
  const cat = sc.picture?.category ?? "";
  if (cat === "LOCATION_MAP" || cat === "SITE_PLAN" || cat === "FLOOR_PLAN") return null;
  if (cat === "EXTERIOR_RENDER") return "TOWER";
  if (cat === "CONSTRUCTION") return "SITE";
  for (const text of [sc.picture?.title ?? "", sc.shot]) {
    for (const [place, re] of PLACE_WORDS) if (re.test(text)) return place;
  }
  // A photo of a place near the project (a station, a mall) sounds like the city.
  if (cat === "NEARBY_PLACE") return "STREET";
  if (cat === "LOBBY") return "LOBBY";
  if (cat === "SAMPLE_FLAT") return "ROOM";
  if (cat === "AMENITY") return "LOUNGE";
  return null;
}

export function timeOf(shot: string): "morning" | "daytime" | "evening" | "night" {
  if (/\bnight|moonlit|after dark/i.test(shot)) return "night";
  if (/\bevening|dusk|sunset|twilight|golden hour|deepening sky/i.test(shot)) return "evening";
  if (/\bmorning|sunrise|dawn|early light/i.test(shot)) return "morning";
  return "daytime";
}

/** What Sound Effects is asked for one place: nothing of ours, only the place and the hour. */
export function ambiencePrompt(place: SoundPlace, time: ReturnType<typeof timeOf>): string {
  return `Continuous steady ambience of ${AMBIENCE[place].sound}, in the ${time}. No voices, no talking, no music, no footsteps, no single loud events.`;
}

export const ambienceLufs = (place: SoundPlace): number => AMBIENCE[place].lufs;

/** One stretch of the film between two cuts, with the sound it gets. */
export type SoundStretch = { start: number; end: number; place: SoundPlace | null; time: ReturnType<typeof timeOf>; scene: number };

/**
 * Each stretch of the film as it came back, matched to the script's scene
 * that overlaps it most once the plan is scaled to the film's real length,
 * then joined to its neighbour when both sound the same.
 */
export function stretchesFor(cuts: readonly { start: number; end: number }[], scenes: readonly SoundScene[], length: number): SoundStretch[] {
  if (!cuts.length || !scenes.length) return [];
  const planned = Math.max(...scenes.map((s) => s.end), 0.001);
  const k = length / planned;
  const raw = cuts.map((c) => {
    let best = 0;
    let most = -1;
    scenes.forEach((s, i) => {
      const overlap = Math.min(c.end, s.end * k) - Math.max(c.start, s.start * k);
      if (overlap > most) [most, best] = [overlap, i];
    });
    const sc = scenes[best];
    return { start: c.start, end: c.end, place: placeOf(sc), time: timeOf(sc.shot), scene: best };
  });
  const joined: SoundStretch[] = [];
  for (const s of raw) {
    const last = joined[joined.length - 1];
    if (last && last.place === s.place && last.time === s.time) last.end = s.end;
    else joined.push({ ...s });
  }
  return joined;
}

/** The distinct sounds to ask for, at most `SOUND.maxPlaces`, longest first; the rest play none. */
export function placesToAsk(stretches: readonly SoundStretch[]): { place: SoundPlace; time: ReturnType<typeof timeOf>; seconds: number }[] {
  const by = new Map<string, { place: SoundPlace; time: ReturnType<typeof timeOf>; seconds: number }>();
  for (const s of stretches) {
    if (!s.place) continue;
    const key = `${s.place}:${s.time}`;
    const len = s.end - s.start;
    const had = by.get(key);
    if (had) had.seconds = Math.max(had.seconds, len);
    else by.set(key, { place: s.place, time: s.time, seconds: len });
  }
  return [...by.values()].sort((a, b) => b.seconds - a.seconds).slice(0, SOUND.maxPlaces);
}

/** How long a background sound is asked for: its longest stretch and the crossfades, within what the service makes. */
export const ambienceSeconds = (longest: number): number => Math.min(30, Math.max(4, Math.ceil(longest + SOUND.crossfade + 0.5)));

// ---------------------------------------------------------------------------
// The cue's sections, cut to the film
// ---------------------------------------------------------------------------

export type CueSection = { section_name: string; positive_local_styles: string[]; negative_local_styles: string[]; duration_ms: number; lines: string[] };
export type CuePlan = { positive_global_styles: string[]; negative_global_styles: string[]; sections: CueSection[] };

/**
 * Where the close begins: the first building shot in the film's last 45 per
 * cent (the launch film's reveal), else the last third, on a cut.
 */
export function closeAt(stretches: readonly SoundStretch[], length: number): number {
  const reveal = stretches.find((s) => s.start >= length * 0.55 && s.place === "TOWER");
  if (reveal) return reveal.start;
  const third = length * (2 / 3);
  const edges = stretches.map((s) => s.start).filter((t) => t > 0);
  return edges.length ? edges.reduce((a, b) => (Math.abs(b - third) < Math.abs(a - third) ? b : a)) : third;
}

/** Three sections (open, middle, close) on the film's cuts, each at least three seconds, and a short outro past the end. */
export function cuePlan(brief: MusicBrief, stretches: readonly SoundStretch[], length: number, seed: number): CuePlan {
  const palette = brief.palettes[seed % brief.palettes.length];
  const close = closeAt(stretches, length);
  const third = length / 3;
  const edges = stretches.map((s) => s.start).filter((t) => t > 0 && t < close);
  const middle = edges.length ? edges.reduce((a, b) => (Math.abs(b - third) < Math.abs(a - third) ? b : a)) : Math.min(third, close / 2);
  const min = SOUND.minSectionMs / 1000;
  // Every section at least three seconds: the close is pulled earlier first,
  // and a middle with no room is folded into the opening.
  let closeStart = Math.min(close, length - min);
  let middleStart = middle;
  if (closeStart - middleStart < min) middleStart = closeStart;
  if (middleStart < min) middleStart = 0;
  if (closeStart < min) closeStart = 0;
  const bounds = [0, middleStart, closeStart, length];
  const roles: { name: string; styles: readonly string[] }[] = [
    { name: "Opening", styles: brief.open },
    { name: "Middle", styles: brief.middle },
    { name: "Close", styles: brief.close },
  ];
  const sections: CueSection[] = roles
    .map((r, i) => ({
      section_name: r.name,
      positive_local_styles: [...r.styles],
      negative_local_styles: i === 2 ? ["fade out", "silence", "ending"] : ["loud"],
      duration_ms: Math.round((bounds[i + 1] - bounds[i]) * 1000),
      lines: [] as string[],
    }))
    .filter((x) => x.duration_ms > 0);
  sections.push({
    section_name: "Outro",
    positive_local_styles: ["the home chord rings out", "slow natural decay"],
    negative_local_styles: ["new melody", "drums"],
    duration_ms: SOUND.outroMs,
    lines: [],
  });
  return {
    positive_global_styles: [palette, ...brief.global],
    negative_global_styles: [...brief.avoid],
    sections,
  };
}

/** A cue that dies before the film does: its last seconds in the film far under its own middle. */
export function fadedEarly(profileDb: readonly number[], step: number, length: number): boolean {
  const inFilm = profileDb.slice(0, Math.floor(length / step));
  if (inFilm.length < 8) return false;
  const sorted = [...inFilm].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  const tail = inFilm.slice(-Math.max(2, Math.round(3 / step)));
  return Math.max(...tail) < middle - SOUND.fadedEarlyDb;
}

// ---------------------------------------------------------------------------
// The mix
// ---------------------------------------------------------------------------

/** An ffmpeg volume expression: 1 outside the spans, `inside` within them, eased in and out over `ramp`. */
export function duckVolume(spans: readonly ({ start: number; end: number } | null)[], insideDb: number, pre: number, post: number, ramp: number): string {
  const live = spans.filter((s): s is { start: number; end: number } => !!s);
  if (!live.length) return "1";
  const inside = Math.pow(10, insideDb / 20);
  const w = live
    .map((s) => {
      const a = (s.start - pre - ramp).toFixed(3);
      const b = (s.end + post + ramp).toFixed(3);
      return `clip(min((t-${a})/${ramp},(${b}-t)/${ramp}),0,1)`;
    })
    .reduce((x, y) => `max(${x},${y})`);
  return `1-${(1 - inside).toFixed(4)}*${w}`;
}

/** A stretch's background sound in place: where it starts, how long, and its fades across the cuts. */
export function ambienceWindow(s: { start: number; end: number }, length: number): { at: number; seconds: number; fadeIn: number; fadeOut: number } {
  const half = SOUND.crossfade / 2;
  const at = Math.max(0, s.start - (s.start > 0 ? half : 0));
  const end = Math.min(length, s.end + (s.end < length ? half : 0));
  return { at, seconds: Math.max(0.1, end - at), fadeIn: s.start > 0 ? SOUND.crossfade : 0.05, fadeOut: s.end < length ? SOUND.crossfade : Math.min(SOUND.fadeOut, end - at) };
}
