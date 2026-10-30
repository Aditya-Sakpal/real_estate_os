/**
 * What a location film is made from, decided without a database (13 October
 * 2026). The first narrated locality guide came back with a map that printed
 * times nobody signed ("Western Express Highway, 3 min" against a signed ten),
 * headed Goregaon East for a project the facts put in Goregaon West, four
 * different buildings standing in for one tower, and cards the video model
 * spelt its own way ("FOR EDANDS"). Every one of those was an input the
 * product took on trust. So the inputs are read here: a nearby place is a
 * place, a time and a way of getting there; what the map prints is held to
 * what is signed; a photograph of a nearby place is matched to its place; and
 * the building's pictures are kept to one building.
 *
 * Imports are relative because the checks load this straight from source.
 */

// ---------------------------------------------------------------------------
// A nearby place
// ---------------------------------------------------------------------------

export type NearbyKind = "TRANSIT" | "ROAD" | "WORK" | "AIRPORT" | "SCHOOL" | "HOSPITAL" | "SHOPPING" | "LEISURE" | "OTHER";
export type NearbyUnit = "min" | "km" | "m";

export type NearbyPlace = {
  /** The line as signed. */
  line: string;
  /** The place, as signed, without its time ("Goregaon station"). */
  place: string;
  kind: NearbyKind;
  value: number;
  unit: NearbyUnit;
  /** How the time was measured, when the line says ("by car"). */
  mode: "drive" | "walk" | "train" | null;
};

const KIND_WORDS: readonly [NearbyKind, RegExp][] = [
  ["AIRPORT", /\bairport\b/i],
  ["TRANSIT", /\b(station|railway|metro|local train|bus (stop|depot)|terminus)\b/i],
  ["ROAD", /\b(highway|expressway|freeway|link road|flyover|bridge|road|marg|sea link|coastal)\b/i],
  ["SCHOOL", /\b(school|college|university|academy|vidyalaya|institute)\b/i],
  ["HOSPITAL", /\b(hospital|clinic|medical|healthcare)\b/i],
  ["SHOPPING", /\b(mall|market|plaza|bazaar|hypermarket|supermarket|d-?mart)\b/i],
  ["WORK", /\b(it park|business park|tech park|office|offices|corporate|mindspace|bkc|sez|cyber|commercial|business district)\b/i],
  ["LEISURE", /\b(park|garden|beach|lake|club|cinema|multiplex|theatre|stadium|temple|church|mosque|national park)\b/i],
];

/** What kind of place a name is, from its words. */
export function nearbyKind(place: string): NearbyKind {
  for (const [kind, re] of KIND_WORDS) if (re.test(place)) return kind;
  return "OTHER";
}

/** The order a buyer uses the places in: getting about first, then work, then daily life. */
export const KIND_ORDER: readonly NearbyKind[] = ["TRANSIT", "ROAD", "WORK", "AIRPORT", "SCHOOL", "HOSPITAL", "SHOPPING", "LEISURE", "OTHER"];

const AMOUNT = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|min\.?|hours?|hrs?|hr|kilomet(?:er|re)s?|kms?|km|metres?|meters?|mtrs?|m)\b/i;
const MODE = /\b(?:by\s+(car|road|train|rail|foot|walk|metro|local)|on\s+foot|(walk(?:ing)?)|(drive|driving))\b/i;

/**
 * A signed nearby line read into a place, a time or distance and a way of
 * getting there: "Goregaon station, 8 minutes", "8 min by car to Goregaon
 * station", "Inorbit Mall Malad: 3 km". Null for a line with no time or
 * distance, which a location film cannot say.
 */
export function readNearby(raw: string): NearbyPlace | null {
  const line = String(raw ?? "").trim();
  if (!line) return null;
  const a = AMOUNT.exec(line);
  if (!a) return null;
  const value = Number(a[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const u = a[2].toLowerCase();
  const hours = /^h/.test(u);
  const unit: NearbyUnit = /^k/.test(u) ? "km" : /^(mi|h)/.test(u) ? "min" : "m";
  const modeHit = MODE.exec(line);
  const said = modeHit ? (modeHit[1] ?? modeHit[2] ?? modeHit[3] ?? "").toLowerCase() : "";
  const mode = !modeHit
    ? null
    : /foot|walk/.test(said) || /on\s+foot/i.test(modeHit[0])
      ? "walk"
      : /train|rail|metro|local/.test(said)
        ? "train"
        : "drive";
  const place = line
    .replace(a[0], " ")
    .replace(MODE, " ")
    .replace(/\b(away|approx\.?|approximately|about|around|only|just|drive|walk)\b/gi, " ")
    .replace(/^\s*(to|from)\b/i, " ")
    .replace(/\b(to|from)\s*$/i, " ")
    .replace(/\s*[,:;\-–|()]+\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(to|from)\s+/i, "")
    .trim();
  if (!place) return null;
  return { line, place, kind: nearbyKind(place), value: hours ? value * 60 : value, unit, mode };
}

/** Every signed line that reads as a place with a time or distance, in the order a buyer uses them. */
export function nearbyPlaces(lines: readonly string[]): NearbyPlace[] {
  const read = lines.map(readNearby).filter((n): n is NearbyPlace => !!n);
  return read
    .map((n, i) => ({ n, i }))
    .sort((a, b) => KIND_ORDER.indexOf(a.n.kind) - KIND_ORDER.indexOf(b.n.kind) || a.i - b.i)
    .map((x) => x.n);
}

/** The time or distance as a card says it: "8 MIN", "3 KM", "500 M". */
export function amountShown(n: Pick<NearbyPlace, "value" | "unit">): string {
  const v = Number.isInteger(n.value) ? String(n.value) : String(Math.round(n.value * 10) / 10);
  return `${v} ${n.unit === "min" ? "MIN" : n.unit === "km" ? "KM" : "M"}`;
}

/**
 * The card for a place, set by us exactly as signed: the time big and the
 * place under it ("8 MIN / GOREGAON STATION"). The place is cut to its first
 * four words, never reworded.
 */
export function nearbyCard(n: NearbyPlace): string {
  return `${amountShown(n)} / ${n.place.split(/\s+/).slice(0, 4).join(" ").toUpperCase()}`;
}

/** How a signed place is handed to the film's writer: the line, then the card to use. */
export function nearbyBrief(n: NearbyPlace): string {
  return `Nearby: ${n.line} (card: "${nearbyCard(n)}")`;
}

// ---------------------------------------------------------------------------
// The same place
// ---------------------------------------------------------------------------

/** Words that name a kind of place, not which one: "Oberoi Mall" and "Inorbit Mall" share only "mall". */
const GENERIC = new Set([
  "the", "a", "an", "of", "and", "near", "nearby", "to", "from", "at", "in", "on",
  "station", "railway", "metro", "road", "rd", "highway", "expressway", "freeway", "link", "flyover", "marg",
  "mall", "market", "school", "high", "international", "college", "hospital", "clinic", "park", "garden",
  "office", "offices", "business", "it", "tech", "centre", "center", "complex", "city", "new", "old",
  "east", "west", "north", "south", "mumbai", "pune", "airport", "international", "domestic", "terminal",
  "bus", "stop", "depot", "lake", "beach", "club", "temple",
]);

const wordsOf = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** The words that say WHICH place a name is. */
export function placeWords(name: string): string[] {
  return wordsOf(name).filter((w) => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w));
}

/** Two names for one place: a word that says which, shared, and the same kind when both say a kind. */
export function samePlace(a: string, b: string): boolean {
  const wa = placeWords(a);
  const wb = new Set(placeWords(b));
  if (!wa.some((w) => wb.has(w))) {
    // "Western Express Highway" read as "WEH": nothing to share; the kind and nothing else is not enough.
    return false;
  }
  const ka = nearbyKind(a);
  const kb = nearbyKind(b);
  return ka === "OTHER" || kb === "OTHER" || ka === kb;
}

/** The approved photo of a nearby place, by its title, or -1. */
export function photoOf(place: string, titles: readonly (string | null)[]): number {
  return titles.findIndex((t) => !!t && samePlace(place, t));
}

// ---------------------------------------------------------------------------
// What the location map prints
// ---------------------------------------------------------------------------

/** What a model read off an approved location map. */
export type MapRead = {
  /** The locality the map is headed with, or "" when it names none. */
  area: string;
  /**
   * Every place the map marks, with the time or distance printed beside it
   * (null when none is), and where on the map it is, as fractions of the
   * width and height (null when the model could not say).
   */
  labels: { place: string; value: number | null; unit: string; at?: { x: number; y: number } | null }[];
  /** Where the project's own pin or label sits, as fractions of the width and height; null when it shows none. */
  pin: { x: number; y: number } | null;
};

export const MAP_READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["area", "labels", "pin_found", "pin_x", "pin_y"],
  properties: {
    area: { type: "string" },
    labels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["place", "value", "unit", "x", "y"],
        properties: {
          place: { type: "string" },
          value: { type: ["number", "null"] },
          unit: { type: "string", enum: ["min", "km", "m", "none"] },
          x: { type: "number" },
          y: { type: "number" },
        },
      },
    },
    pin_found: { type: "boolean" },
    pin_x: { type: "number" },
    pin_y: { type: "number" },
  },
} as const;

/** A model's answer about a map, read without trusting it. */
export function readMapAnswer(value: unknown): MapRead | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { area?: unknown; labels?: unknown; pin_found?: unknown; pin_x?: unknown; pin_y?: unknown };
  const labels = Array.isArray(v.labels)
    ? v.labels.flatMap((l) => {
        const x = l as { place?: unknown; value?: unknown; unit?: unknown; x?: unknown; y?: unknown };
        const place = String(x.place ?? "").trim().slice(0, 80);
        if (!place) return [];
        const value = typeof x.value === "number" && Number.isFinite(x.value) && x.value > 0 ? x.value : null;
        const unit = ["min", "km", "m"].includes(String(x.unit)) ? String(x.unit) : "none";
        const lx = Number(x.x);
        const ly = Number(x.y);
        const at = lx >= 0 && lx <= 1 && ly >= 0 && ly <= 1 && !(lx === 0 && ly === 0) ? { x: lx, y: ly } : null;
        return [{ place, value: unit === "none" ? null : value, unit, at }];
      }).slice(0, 30)
    : [];
  const px = Number(v.pin_x);
  const py = Number(v.pin_y);
  const pin = v.pin_found === true && px >= 0 && px <= 1 && py >= 0 && py <= 1 ? { x: px, y: py } : null;
  return { area: String(v.area ?? "").trim().slice(0, 120), labels, pin };
}

const DIRECTIONS = ["east", "west", "north", "south"];

/**
 * The map's heading against the signed locality: "Goregaon East" over a
 * project signed in "Goregaon West" names another place. Only a clear clash
 * counts: the same place word with another direction.
 */
export function wrongArea(mapArea: string, location: string | null): boolean {
  if (!mapArea || !location) return false;
  const m = wordsOf(mapArea);
  const l = wordsOf(location);
  const base = l.filter((w) => !DIRECTIONS.includes(w) && w.length >= 4);
  if (!base.some((w) => m.includes(w))) return false;
  const dl = l.filter((w) => DIRECTIONS.includes(w));
  const dm = m.filter((w) => DIRECTIONS.includes(w));
  return dl.length > 0 && dm.length > 0 && !dm.some((d) => dl.includes(d));
}

/** Minutes stay minutes; a distance in metres. */
const inBase = (value: number, unit: string) => (unit === "km" ? value * 1000 : value);
const sameAmount = (a: { value: number; unit: string }, b: { value: number; unit: string }) => {
  const dist = (u: string) => u === "km" || u === "m";
  if (dist(a.unit) !== dist(b.unit)) return false;
  return Math.abs(inBase(a.value, a.unit) - inBase(b.value, b.unit)) < 1e-6;
};

const said = (value: number, unit: string) =>
  unit === "min" ? `${value} min` : unit === "km" ? `${value} km` : `${value} m`;
const signedSaid = (n: NearbyPlace) => (n.unit === "min" ? `${n.value} minutes` : n.unit === "km" ? `${n.value} km` : `${n.value} m`);

/**
 * Why the approved map cannot go in a film beside these signed facts, in the
 * person's words: a heading that names another locality, a time the facts
 * give differently, or a place with a time nobody signed. A map is printed in
 * the film exactly as approved, so what it prints is a claim like any line.
 */
export function mapProblems(read: MapRead, nearby: readonly NearbyPlace[], location: string | null): string[] {
  const out: string[] = [];
  if (wrongArea(read.area, location)) {
    out.push(`The location map is headed "${read.area}", but the project's approved location is ${location}. Upload the map for ${location}.`);
  }
  for (const l of read.labels) {
    if (l.value === null) continue;
    const match = nearby.find((n) => samePlace(n.place, l.place));
    if (!match) {
      out.push(
        `The location map prints "${l.place}, ${said(l.value, l.unit)}", which is not one of the project's signed nearby places. Add it under Nearby places and sign it, or upload a map without it.`,
      );
    } else if (!sameAmount({ value: l.value, unit: l.unit }, match)) {
      out.push(
        `The location map prints "${l.place}, ${said(l.value, l.unit)}", but the signed nearby places say ${match.place}, ${signedSaid(match)}. Correct one so they agree.`,
      );
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// One building
// ---------------------------------------------------------------------------

export const BUILDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pictures"],
  properties: {
    pictures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["picture", "looks", "building"],
        properties: {
          picture: { type: "integer" },
          looks: { type: "string" },
          building: { type: "integer" },
        },
      },
    },
  },
} as const;

/**
 * Which of the building's pictures to film, from a model's grouping of them
 * by the building each shows: the group holding the most pictures, the one
 * holding the first picture on a tie (the deepest node's, which the library
 * lists first). Every picture is kept when the answer does not cover them
 * all: a filter that cannot be read filters nothing.
 */
export function oneBuilding(count: number, value: unknown): { keep: number[]; dropped: number[]; looks: string[] } {
  const all = Array.from({ length: count }, (_, i) => i);
  const rows = (value as { pictures?: { picture?: unknown; looks?: unknown; building?: unknown }[] } | null)?.pictures;
  if (!Array.isArray(rows)) return { keep: all, dropped: [], looks: [] };
  const groupOf = new Map<number, number>();
  const looks: string[] = [];
  for (const r of rows) {
    const p = Number(r.picture);
    const g = Number(r.building);
    if (Number.isInteger(p) && p >= 0 && p < count && Number.isInteger(g) && !groupOf.has(p)) {
      groupOf.set(p, g);
      looks[p] = String(r.looks ?? "").trim().slice(0, 160);
    }
  }
  if (groupOf.size !== count) return { keep: all, dropped: [], looks: [] };
  const size = new Map<number, number>();
  for (const g of groupOf.values()) size.set(g, (size.get(g) ?? 0) + 1);
  const firstGroup = groupOf.get(0)!;
  const best = [...size.entries()].sort((a, b) => b[1] - a[1] || (a[0] === firstGroup ? -1 : b[0] === firstGroup ? 1 : 0))[0][0];
  return { keep: all.filter((i) => groupOf.get(i) === best), dropped: all.filter((i) => groupOf.get(i) !== best), looks };
}

/** What is said when too few pictures of one building are left to film. */
export function oneBuildingWhy(kept: number, need: number): string {
  return (
    `The approved pictures of the building show different buildings, and only ${kept} show${kept === 1 ? "s" : ""} this one. ` +
    `A film needs at least ${need} of the same building. In the project's library, keep the pictures of this tower and take off the others.`
  );
}

// ---------------------------------------------------------------------------
// A place said in a scene, and its route on the map
// ---------------------------------------------------------------------------

/** Words that never say which place: a sentence's own, and the city's. */
const NOT_A_KIND = new Set(["the", "a", "an", "of", "and", "near", "nearby", "to", "from", "at", "in", "on", "east", "west", "north", "south", "mumbai", "pune", "new", "old", "city"]);

/**
 * The signed places a scene says, from its line and its card. A place is said
 * when every word that says WHICH it is is there and, where its name has a
 * word saying what KIND it is, one of those too: "Goregaon West" in a line
 * is the locality, not Goregaon station.
 */
export function placesNamedIn(text: string, places: readonly NearbyPlace[]): NearbyPlace[] {
  const said = new Set(wordsOf(text));
  const whole = ` ${wordsOf(text).join(" ")} `;
  return places.filter((n) => {
    const which = placeWords(n.place);
    // A name of kind words alone ("R City Mall") is said only whole.
    if (!which.length) return whole.includes(` ${wordsOf(n.place).join(" ")} `);
    if (!which.every((w) => said.has(w))) return false;
    const kinds = wordsOf(n.place).filter((w) => GENERIC.has(w) && !NOT_A_KIND.has(w));
    return !kinds.length || kinds.some((w) => said.has(w));
  });
}

/** The one signed place a scene is about, from its line and its card; null for none or for two. */
export function placeOfScene(scene: { line: string; text: string }, places: readonly NearbyPlace[]): NearbyPlace | null {
  const named = placesNamedIn(`${scene.line} ${scene.text.replace(/\//g, " ")}`, places);
  return named.length === 1 ? named[0] : null;
}

/** Where a signed place is on the approved map, as the map read found it; null when it did not. */
export function placeOnMap(place: NearbyPlace, read: Pick<MapRead, "labels"> | null): { x: number; y: number } | null {
  return read?.labels.find((l) => l.at && samePlace(l.place, place.place))?.at ?? null;
}

/**
 * A line with every signed place's name made whole again, exactly as signed:
 * "Mindspace, Malad" and "Mindspace. Malad" are "Mindspace Malad". A full
 * stop or a comma inside a name is a pause inside it: the narrator said
 * "Mindspace. Malad" as two things (13 October 2026).
 */
export function joinPlaceNames(line: string, places: readonly NearbyPlace[]): string {
  let out = line;
  for (const n of places) {
    const words = n.place.split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`\\b${esc.join("[\\s,.;:\u2013\u2014-]+")}\\b`, "gi");
    out = out.replace(re, (hit) => (/[,.;:\u2013\u2014-]/.test(hit) ? n.place : hit));
  }
  return out;
}

/** How long the route to a place is shown at the head of a scene filmed on something else. */
export const ROUTE_PREFIX = { most: 1.6, share: 0.45, least: 0.9 };

/** The seconds at the head of a scene the route is shown for, or 0 when the scene is too short for it. */
export function routePrefixSeconds(sceneSeconds: number): number {
  const s = Math.min(ROUTE_PREFIX.most, sceneSeconds * ROUTE_PREFIX.share);
  return s >= ROUTE_PREFIX.least ? s : 0;
}

/**
 * The part of the map a route shot comes to rest on, in the canvas's own
 * pixels: the project and the place both in it with room around them, at the
 * frame's own shape, never closer than `maxZoom` and never past the canvas.
 */
export function routeView(
  a: { x: number; y: number },
  b: { x: number; y: number },
  canvas: { w: number; h: number },
  opts: { pad?: number; maxZoom?: number } = {},
): { x: number; y: number; w: number; h: number } {
  const ratio = canvas.w / canvas.h;
  const span = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const pad = Math.max((opts.pad ?? 0.55) * span, 0.12 * Math.min(canvas.w, canvas.h));
  let w = Math.abs(a.x - b.x) + 2 * pad;
  let h = Math.abs(a.y - b.y) + 2 * pad;
  if (w / h < ratio) w = h * ratio;
  else h = w / ratio;
  const least = canvas.w / (opts.maxZoom ?? 2.6);
  if (w < least) {
    w = least;
    h = w / ratio;
  }
  if (w > canvas.w || h > canvas.h) return { x: 0, y: 0, w: canvas.w, h: canvas.h };
  // Leaning toward the place: its label is printed beside it, away from the project.
  const cx = a.x + (b.x - a.x) * 0.62;
  const cy = a.y + (b.y - a.y) * 0.62;
  const x = Math.max(0, Math.min(canvas.w - w, cx - w / 2));
  const y = Math.max(0, Math.min(canvas.h - h, cy - h / 2));
  return { x, y, w, h };
}

/**
 * A draft's cards for nearby places put exactly as signed: a card naming a
 * signed place becomes that place's own card ("8 MIN / GOREGAON STATION"),
 * whatever the writer rounded or shortened. Every other card is left alone.
 */
export function withNearbyCards<S extends { text: string }>(scenes: readonly S[], places: readonly NearbyPlace[]): S[] {
  return scenes.map((s) => {
    if (!s.text) return s;
    const named = places.find((n) => s.text.split("/").some((part) => samePlace(n.place, part)));
    return named ? { ...s, text: nearbyCard(named) } : s;
  });
}

/**
 * Where an approved photo of a nearby place is laid over the film, when the
 * film never showed that place (18 October 2026: Seedance skipped the
 * Goregaon station shot and kept her on the balcony, so "8 MIN / GOREGAON
 * STATION" sat over the balcony). From just before she starts the line that
 * names it until just after its last word, never into her next line, each
 * end moved onto a real cut of the film when one is close, so the photo
 * comes in and goes out on a cut rather than in the middle of a shot.
 * Null when the line was not heard or the window would be too short to read.
 */
/** Less of a shot than this left beside a laid photo reads as a flash, not a shot. */
const SLIVER = 1.0;

export function placeWindow(
  said: { start: number; end: number } | null,
  nextSaid: number | null,
  cuts: readonly number[],
  length: number,
): { start: number; end: number } | null {
  if (!said) return null;
  const near = (t: number, lo: number, hi: number) => cuts.filter((c) => c >= lo && c <= hi).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
  let start = said.start - 0.2;
  const inCut = near(start, said.start - 0.8, said.start + 0.3);
  if (inCut !== undefined) start = inCut;
  const limit = nextSaid !== null ? nextSaid - 0.05 : length;
  let end = Math.min(limit, said.end + 0.3);
  const outCut = near(end, said.end - 0.2, Math.min(limit, said.end + 0.8));
  if (outCut !== undefined) end = outCut;
  // Never a sliver of the shot before or after: a cut under a second off is
  // taken, so the photo does not leave 0.7 s of the old shot showing (18
  // October 2026, a cut 0.97 s before the line).
  const before = cuts.filter((c) => c <= start + 1e-6).reduce((a, c) => Math.max(a, c), -1);
  if (before >= 0 && start - before < SLIVER && before >= said.start - 1.5) start = before;
  const after = cuts.filter((c) => c >= end - 1e-6).reduce((a, c) => Math.min(a, c), Infinity);
  if (after !== Infinity && after - end < SLIVER && after <= limit) end = after;
  start = Math.max(0, start);
  end = Math.min(length, end);
  if (length - end < SLIVER && nextSaid === null) end = length;
  const r = (n: number) => Math.round(n * 100) / 100;
  return end - start >= 0.8 ? { start: r(start), end: r(end) } : null;
}
