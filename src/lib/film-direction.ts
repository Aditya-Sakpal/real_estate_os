import type { AskDriver, AskPart } from "./generate.ts";
import type { FilmScript } from "./film-rules.ts";
import { DIRECTION_SCHEMA, directionProblems, LENSES, MAX_PEOPLE_IN_SHOT, readDirection, type FilmDirection } from "./film-direction-rules.ts";

/**
 * The director: a story's script turned into shots a camera crew could film
 * (`film-direction-rules.ts` says why). It changes no line, no fact, no
 * picture and no order; it decides where everyone is, which way they face,
 * what each shot's one action is, the lens and the move, and the fixed
 * layout of every place, and it shows a moment the video model gets wrong
 * (a door, a screen held up to the camera) another way. Two drafts sent back
 * with what was wrong, then the last is used. `FILM_DIRECTOR_MODEL`.
 *
 * Imports are relative because the worker runs this straight from source.
 */

export const FILM_DIRECTOR_MODEL = process.env.FILM_DIRECTOR_MODEL || "gpt-5.5";
const MAX_DIRECTION_DRAFTS = 3;

const INSTRUCTIONS =
  "You are the director of photography on an Indian real-estate brand film. You get its script, shot by shot, and turn " +
  "each shot into what a camera crew films, for Seedance 2.5. You never change a line, a fact, a picture, the people or the " +
  "order of the shots. You decide:\n" +
  "- CHARACTERS: every person, labelled in capitals (THE FATHER, THE DAUGHTER), with a look a camera can hold: age, build, " +
  "face, hair, and exact clothes (colour, fabric, cut), the same words every time.\n" +
  "- LOCATION: every place the film uses, labelled (THE LIVING ROOM, THE BALCONY, THE OFFICE), with its approved picture's " +
  "number (or -1 for an ordinary place) and a fixed layout in words: where the entrance is, where the sofa, the windows and " +
  "the balcony doors are, which side the light comes from. One place is one picture: the family's balcony is never a " +
  "clubhouse. A front door opens into a hall or the living room, never a bedroom.\n" +
  "- For each shot: the frame (wide, medium, medium close-up, close-up, over-the-shoulder), one lens from " +
  `${LENSES.join("°, ")}° (diagonal field of view), ONE camera move (slow push-in, slow pull-back, handheld follow, gentle ` +
  `pan, static with slight handheld drift), the place by its label, the people in frame by label (at most ${MAX_PEOPLE_IN_SHOT}), ` +
  "the blocking (for each person: screen-left or screen-right, x %, standing or sitting, facing camera, away, or toward " +
  "whom), ONE action with when it happens, and under 'objects' anything that must face or work one way.\n" +
  "Rules, from what video models get wrong:\n" +
  "- One action per shot. 'He sets his bag down' is one action; 'he rings the bell, the door opens and she runs to him' is " +
  "three, and fails.\n" +
  "- No shot may hinge on a door or a bell, a mirror, something handed from one person to another, writing, typing or " +
  "reading. Coming home is shown already inside: he sets his bag down in the living room and the child runs across the " +
  "room to him.\n" +
  "- A screen (a laptop, a phone) always faces the person using it, and the camera sees it from behind or over their " +
  "shoulder. A drawing or photograph the viewer must see is on a wall or a desk, facing the camera, never on a screen.\n" +
  "- Screen direction holds across the cuts of one moment: who is screen-left stays screen-left.\n" +
  "- A people shot inside the home names the room's picture; a shot of the building names the building's picture.\n" +
  "- A person who walks has a clear path on the floor: the blocking says where it runs, nothing stands between them and " +
  "where they walk to (no lounger, table, chair, railing, step or water in the way), and furniture stays to one side of it. " +
  "Nobody ever passes through, over or inside anything solid. On a pool deck the path runs along the deck, never across " +
  "the loungers or the water.\n" +
  "- LIGHTING: one motivated source per place and the time of day, the same light across the film's evening.\n" +
  "- PHYSICS: how fabric, hair and light move in this film, in a sentence or two.\n" +
  "- Never write a card, caption, title, price, logo or any text on screen into any field: those are added afterwards, by " +
  "others.\n" +
  "- When a line is said over a shot, the picture never contradicts it, and never acts it out literally if that needs a " +
  "moment above (a line about ringing a bell is shown inside, with the child running to him).\n" +
  "Answer in JSON.";

/**
 * What changes for a presenter's reel (Agent on camera, directed since 10
 * October 2026 behind `AGENT_LIKE_STORY`): one person who talks to the
 * viewer, fast property shots whose camera move is the format's, and the
 * script's moves kept as written.
 */
const PRESENTER_NOTES =
  "\nTHIS FILM IS A PRESENTER'S REEL, not a family story. These rules beat the ones above where they differ:\n" +
  "- There is one person, THE PRESENTER. In a presenter shot THE PRESENTER talks straight into the lens, which is right here; the lips " +
  "move with every word. The one action is a body action while talking (a step toward camera, a turn to the building, an " +
  "open hand toward a room), never counting on fingers.\n" +
  "- A property shot has no people. Keep the camera move the script names for it exactly (a whip pan, an FPV fly-through, a " +
  "fast push): fast moves are this format, and you never slow one down. Write that move under 'camera'.\n" +
  "- A presenter shot names the picture behind the presenter as its place, and the blocking says where the presenter stands against it so the " +
  "building or room stays visible in the frame.\n" +
  "- A presenter shot on a photo of a place near the project (a station, a mall, a school, a hospital, an office park, a " +
  "road) puts THE PRESENTER there, standing or walking on its footpath, forecourt or entrance plaza in front of it, at its " +
  "scale and in its own daylight, with the place exactly as the photo shows it behind her: never in the road, on the " +
  "tracks or inside a building, never up on a ledge, a parapet, a divider or a wall (beside a road or a highway she " +
  "stands on the pavement or behind its railing), and nothing added to the place.\n" +
  "- Keep the top-right corner and the bottom tenth of the frame free of the face in every shot.\n";

/**
 * What changes for a film of the property itself (the launch film, a
 * construction update, land to home, the cinematic tour; directed since 10
 * October 2026): no story people, the template's own camera kept, and the
 * building's surroundings fixed in words so they hold from shot to shot.
 */
const PROPERTY_NOTES =
  "\nTHIS FILM SHOWS THE PROPERTY, not a family story. These rules beat the ones above where they differ:\n" +
  "- No people unless a shot of the script names them, and then only as the script says (a silhouette, a figure at a " +
  "distance), never a face. CHARACTERS may be empty, and a shot with nobody lists no people and needs no blocking.\n" +
  "- Keep the camera move the script names for each shot exactly, fast or slow; it is the format's. A film made as one " +
  "continuous take keeps one lens and never cuts; a camera the script locks off stays locked.\n" +
  "- LOCATION: each place by its approved picture, with what surrounds it fixed in words (which side the entrance is, the " +
  "order of the towers, the road, the trees, the sky), so the place is the same in every shot. Never add a view, a sea, " +
  "a landmark, a road or a building the picture does not show.\n" +
  "- The one action of a property shot is what moves in it: the light changing, water, leaves, a curtain, a lift rising.\n";

export async function directFilm(
  ask: AskDriver,
  script: FilmScript,
  pictures: readonly { category: string; title: string | null }[],
  signal?: AbortSignal,
  format: "story" | "presenter" | "property" = "story",
): Promise<{ direction: FilmDirection; problems: string[] } | null> {
  const listed = pictures.map((p, i) => `${i}: ${p.title || p.category.toLowerCase().replace(/_/g, " ")} (${p.category.toLowerCase().replace(/_/g, " ")})`);
  // A card's words never reach the director: what text appears is ours to
  // set, and a director told the card wrote it into the shot, which Seedance
  // then drew under ours (9 October 2026).
  const shots = script.scenes.map(
    (s, i) =>
      `Shot ${i + 1}, ${s.kind}, picture ${s.picture}${s.picture === -1 ? " (an ordinary place, not the project)" : ""}: ${s.shot}` +
      (s.line ? ` Line said over it: "${s.line}".` : "") +
      (s.text ? " (A card is laid over the upper third of this shot afterwards; leave that part of the frame calm.)" : ""),
  );
  let last: FilmDirection | null = null;
  let fixes: string[] = [];
  for (let draft = 0; draft < MAX_DIRECTION_DRAFTS; draft++) {
    const parts: AskPart[] = [
      {
        text:
          `THE PEOPLE, as the writer described them: ${script.presenter}\n` +
          `THE APPROVED PICTURES:\n${listed.join("\n")}\n\n` +
          `THE SCRIPT, ${script.scenes.length} shots in order:\n${shots.join("\n")}` +
          (fixes.length && last
            ? `\n\nYOUR LAST DRAFT WAS SENT BACK. Fix exactly this, keep everything else:\n${fixes.map((f) => `- ${f}`).join("\n")}\n\nTHE DRAFT:\n${JSON.stringify(last)}`
            : ""),
      },
    ];
    const answer = await ask(
      { model: FILM_DIRECTOR_MODEL, system: INSTRUCTIONS + (format === "presenter" ? PRESENTER_NOTES : format === "property" ? PROPERTY_NOTES : ""), parts, schema: DIRECTION_SCHEMA as unknown as Record<string, unknown>, name: "film_direction", effort: "medium", timeoutMs: 240_000 },
      { signal },
    );
    if (!answer.ok) {
      if (last) break;
      return null;
    }
    const d = readDirection(answer.value);
    if (!d) continue;
    last = d;
    fixes = directionProblems(d, script.scenes.length, pictures.length, script.scenes.some((s) => s.kind !== "property"));
    if (!fixes.length) return { direction: d, problems: [] };
    console.log(`film: direction draft ${draft + 1} sent back: ${fixes.join(" | ")}`);
  }
  return last ? { direction: last, problems: fixes } : null;
}
