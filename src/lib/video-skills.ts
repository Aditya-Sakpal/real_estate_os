/**
 * Every video template's own skill, from its reference reels: what the film
 * is, how long, how many shots, who is on screen, what is said, the cards,
 * how the camera moves, and what the format must never do. One Seedance call
 * makes each film from its skill (`film.ts`); Agent on camera's skill lives
 * in `film-rules.ts` beside the code that grew up around it.
 *
 * Written on 3 October 2026 from every reference reel in each template
 * folder (a frame a second, the cuts, a timed transcript). Each folder's
 * `SKILL.md` says, in prose, what the reels do and why the numbers are what
 * they are; change both together. `FILM_TEMPLATES` in `reel-choice.ts` is the
 * client's copy of each length, and `check:logic` holds the two together.
 *
 * Imports are relative and type-only, because the worker and the checks load
 * this straight from source and `film-rules.ts` imports it back.
 */

import type { VideoSkill } from "./film-rules.ts";

/**
 * Launch film (template 01), rebuilt on 11 October 2026 from Lodha's own
 * launch films, the most watched in Indian real estate (Lodha Avalon, 25
 * million views; Lodha Belmont, 8 million; Lodha Sewri, "Coming soon to
 * Sewri"), after the client called the trailer-style film it replaced
 * "absolutely shit". The three share one grammar: no facts and no price,
 * a mood the home gives rather than what it has; a cut every two to three
 * seconds, warm golden-hour light, the camera always drifting; sensory
 * details first (light on water, fabric in a breeze, a hand on a leaf), then
 * a person or a couple living in the approved spaces, seen from behind or in
 * profile, never to camera; five or six short lines in a low, unhurried
 * male voice, each printed small at the foot as it is said, silence between;
 * the building once, near the end, at its best light; and a quiet close on
 * the name. `SKILL.md` in the template's folder holds the study.
 */
export const LAUNCH_FILM_SKILL: VideoSkill = {
  key: "01-launch-film",
  label: "Launch film",
  format:
    "a luxury launch film in the way Lodha launches its projects: a mood film of the life the home gives, sensory details and " +
    "one or two people living in its approved spaces, five or six short poetic lines in a low narrator's voice, the building " +
    "once in its best light, and a quiet close on the name",
  seconds: 25,
  scenes: { min: 9, max: 11 },
  shotSeconds: { min: 2, max: 3.5 },
  speech: "voiceover",
  presenterScenes: { min: 0, max: 0 },
  peopleScenes: { min: 2, max: 4 },
  presenterOpensAndCloses: false,
  words: { min: 18, max: 34 },
  lineWords: 8,
  // The name at the close, set on the film by us in a quiet wide face.
  cards: { min: 1, max: 1, words: 3 },
  wordsPerSecond: 1.9,
  beats: [
    "Open on a detail, never the building: light moving on the water of the approved pool, a curtain lifting in the approved " +
      "room, leaves in the approved garden, held close, golden light. The first line comes over the second or third shot, never " +
      "the first: the film breathes before it speaks.",
    "The lines: five or six in the whole film, each three to seven words, a full sentence with a full stop, said slowly with " +
      "silence after it. A line is a feeling a buyer would have in that place, drawn from one approved selling point or from " +
      "what its shot's approved picture shows, never a fact read out: \"The horizon stands uninterrupted.\" for a sea view, " +
      "\"Everything feels considered.\" over the lobby, \"Mornings arrive slowly here.\" over the garden. No number, no price, " +
      "no size, no distance, no amenity named like a list.",
    "The people: one person or one couple, the same in every shot, living in the approved spaces: swimming a slow length of " +
      "the pool, reading by the window of the living room, walking the garden path, a quiet drink at the lounge. Seen from " +
      "behind, in profile or from a distance, never looking into the lens, never posing. A member of staff serving them is " +
      "allowed. Never named, never a buyer giving a review.",
    "Between the people, more details: water, light across stone, fabric, a glass set down, a page turning, each one second " +
      "or two, so the film never holds one view.",
    "The building, once, in the last third: the approved exterior at golden hour or dusk, a slow rise or pull back, the whole " +
      "tower in its setting, exactly as its picture shows it.",
    "The close, the last two to three seconds: the narrator says the project's name and its locality once (\"Aurum Heights. " +
      "Malad West.\") over the calmest exterior or sky shot, and that shot's card is the project's name, set on the film by us. " +
      "Nothing is asked of the viewer: no booking, no visit, no call.",
  ],
  look:
    "A luxury brand film, photoreal, shot like a perfume advertisement: warm golden-hour light and soft dusk, low contrast with " +
    "creamy highlights and gentle film grain, shallow depth of field on the details, natural fabrics and stone, every frame calm " +
    "and uncluttered. The camera never stops: slow glides, gentle push-ins, drifts and rises, a cut every two to three seconds. " +
    "People move unhurried, at normal speed, and the light and the water always move.",
  presenter: null,
  realism: null,
  voice:
    "A low, warm male narrator in clear Indian English, close to the microphone, unhurried and almost a whisper, each line one " +
    "soft phrase with silence after it. Never a trailer voice, never excited.",
  text:
    "No words on screen from the film itself: the lines are printed small at the foot by us while they are said, and the name " +
    "card at the close is ours.",
  sound:
    "A soft, slow score of piano and strings, sparse and warm, with the real quiet sounds of each place under it (water, " +
    "leaves, a glass, a breeze); the narrator alone over it, no other voices, no hits, no whooshes.",
  moves: {
    property: ["glide", "drift", "push", "pull", "rise", "crane", "dolly", "tilt", "track", "slide", "ease", "descend", "float", "reveal"],
    forbidden: ["whip", "fpv", "crash", "orbit", "360", "static", "handheld", "shaky", "timelapse", "spin"],
  },
  never: [
    "Say or show a price, a size, a distance, a number of any kind, a configuration, an amenity list or a specification.",
    "Say or show a launch date, an event, a celebrity, a booking count, \"launched\", \"grand launch\", \"introducing\", " +
      "\"sold out\", \"limited\" or an offer.",
    "Ask the viewer to do anything: no \"book\", \"visit\", \"call\" or \"don't miss\".",
    "Show a person looking into the lens, posing, smiling at the camera, or named; or more than one couple in the film.",
    "Show a sea, a skyline, a landmark or a view the approved pictures do not show, or say a line that promises one.",
    "Show the whole building more than once, or anywhere but in the last third.",
    "Ask for a night, dusk or lights-on version of a picture made by day; grade only.",
    "Orbit or circle the building: its far sides are in no approved picture.",
    "Say the project's name or the locality anywhere but the last line, or put a place name on any card.",
    "Write a line longer than seven words, a question or an exclamation.",
    "Write a line in Hindi or in Devanagari: the whole film is in English.",
  ],
  styleFrames: [],
  needs: null,
  subtitles: true,
  cardStyle: "elegant",
  cardAccent: "#ffffff",
  example: [
    "1 property, the rooftop pool: a close glide over the water at golden hour, light rippling across the tiles, no one in it.",
    "2 property, the entrance lobby: a slow push along the stone wall as a band of evening light slides across it. Says: " +
      "\"Some places are made to be felt.\" (low, slow, almost a whisper)",
    "3 people, the rooftop pool: a woman swims a slow length toward the edge, seen from behind, the water folding around her.",
    "4 property, the sample flat living room: a drift past a sheer curtain lifting in the breeze toward the window. Says: " +
      "\"Mornings arrive slowly here.\" (soft, unhurried)",
    "5 people, the sample flat living room: the same woman reads by the window in profile, turning a page, warm light on her face.",
    "6 property, the clubhouse lounge: a close glide past a glass set down on marble, the room soft behind it. Says: " +
      "\"Everything feels considered.\" (quiet, sure)",
    "7 people, the clubhouse lounge: a couple sits at a low table by the window, seen from across the room, a staff member " +
      "setting down two cups.",
    "8 property, the garden: a slow rise through leaves moving in the breeze, sunlight breaking through. Says: \"Time feels " +
      "like your own.\" (soft, warm)",
    "9 property, the tower elevation: a slow rise up the whole tower at golden hour, windows catching the light.",
    "10 property, the tower from the entrance garden: a slow pull back as dusk settles, the sky calm. Says: \"Aurum Heights. " +
      "Malad West.\" (low, final) Text: \"AURUM HEIGHTS\".",
  ].join("\n"),
};

/**
 * Construction update (template 06), from its five reference reels: the
 * developers' own updates are one shot per stage, cut on the beat every two
 * and a half seconds, each with a plain line saying what it shows; the others
 * are a real founder's vlog, a generated engineer selling an AI tool, and a
 * structure morphed into its render, none of which we make. A construction
 * update is only true of the day its photos were taken, so every shot is one
 * dated CONSTRUCTION photo, moved gently and changed in nothing.
 */
export const CONSTRUCTION_UPDATE_SKILL: VideoSkill = {
  key: "06-construction-update",
  label: "Construction update",
  format:
    "a construction update: the tower's latest dated site photos, each brought gently to life with a slow camera move and " +
    "nothing else changed, while a narrator says when they were taken and what they show",
  seconds: 15,
  scenes: { min: 4, max: 6 },
  shotSeconds: { min: 2, max: 3.5 },
  speech: "voiceover",
  presenterScenes: { min: 0, max: 0 },
  peopleScenes: { min: 0, max: 0 },
  presenterOpensAndCloses: false,
  words: { min: 12, max: 30 },
  lineWords: 9,
  cards: { min: 1, max: 3, words: 3 },
  wordsPerSecond: 2.5,
  beats: [
    "Open on the widest site photo, the tower or the site from the air: a slow drone drift, and the narrator says the " +
      "project and the month and year the photos were taken, exactly as the brief gives them (\"Aster Heights on site, " +
      "September 2026.\"). The card is \"SITE UPDATE\"; the date card is set by us.",
    "What the photos show: two to four shots, one dated construction photo each, in the order the work climbs or newest " +
      "first. Over each, at most one short line, and only the stage that photo's own title names (\"The ground floor slab is " +
      "cast.\"). A photo whose title names no stage gets no line.",
    "If the facts carry a possession date, the narrator says it once, as the filed date (\"Possession is June 2029.\"), never " +
      "as early, on time or on schedule.",
    "The close, the last two to three seconds: the widest photo again, a slow drone pull back to the edge of the photo, and " +
      "the narrator says the card's one action (\"Come and see the site.\").",
  ],
  look:
    "Real site photographs, kept true: the light, the weather, the bare concrete, the scaffolding, the nets and the cranes " +
    "exactly as photographed. Each photo gets one small, slow camera move (a gentle drone drift, a slow push-in, a short rise " +
    "or a pan) with soft parallax, and nothing in the picture moves except the sky. Straight cuts on the beat every two to " +
    "three seconds. A neutral documentary grade: no golden glow added, no sky replaced, nothing cleaned up.",
  presenter: null,
  realism: null,
  voice:
    "A plain, steady narrator in neutral Indian English, like a site engineer reporting to buyers: factual, warm, unhurried, " +
    "never salesy. Each line flows in one breath.",
  text:
    "One to three small cards: clean bold sans-serif capitals, white on a soft dark band, centred in the upper third and " +
    "clear of the top-right corner, each popping in whole. The first is \"SITE UPDATE\". The photos' date is a card we set " +
    "after the film, never drawn by the video model.",
  sound:
    "Steady modern instrumental music with a light pulse, a soft thud on each cut, faint distant site sound low under the " +
    "narrator. No other voices.",
  moves: {
    property: ["drift", "push", "rise", "descend", "pan", "tilt", "glide", "drone", "aerial", "track", "pull", "slow"],
    forbidden: [
      "timelapse",
      "time-lapse",
      "morph",
      "dissolve",
      "transform",
      "builds",
      "grow",
      "finish",
      "complete",
      "worker",
      "labourer",
      "fpv",
      "whip",
      "orbit",
    ],
  },
  never: [
    "Show any progress that no dated construction photo shows: no extra floor, no slab, glass, paint, plaster or facade on " +
      "bare concrete, no scaffolding or net taken away, no finished tower. Each shot is one photo exactly as it was taken.",
    "Morph, dissolve or time-lapse one photo into another or into a render: every in-between frame is a stage of work that " +
      "never happened.",
    "Use a render or any picture that is not a dated construction photo of this tower, or end on the finished building.",
    "Add or animate workers, machines, cranes or vehicles: activity the photo did not catch is activity the film invents.",
    "Say a stage of work the photo's own title does not name, or a percentage, a floor count or a date that is not in the " +
      "facts or the photos' titles and dates.",
    "Say the work is on schedule, ahead of time, fast or nearly done, or promise an early handover: possession is said only " +
      "as the signed date.",
    "Call the photos \"this week\", \"today\" or \"just now\": they are of the month they were taken.",
    "Put a date, a number or a place name on a card.",
    "Write a line in Hindi or in Devanagari: the whole film is in English.",
  ],
  styleFrames: [],
  // The format's own cards, said in its beats: no approved line carries
  // "update", so the gate refused the hook it told the writer to use.
  hooks: ["SITE UPDATE", "VISIT THE SITE"],
  needs: {
    categories: ["CONSTRUCTION"],
    count: 3,
    why:
      "A construction update needs at least three approved construction photos of this tower, each with the date it was " +
      "taken and all from the last 90 days, so the progress shown is real and current.",
  },
  example: [
    "1 property, Tower B and the site from the air (construction photo): a slow drone drift toward the tower, clouds moving " +
      "softly behind it. Says: \"Aster Heights on site, September 2026.\". Text: \"SITE UPDATE\".",
    "2 property, the ground floor slab (construction photo, titled ground floor slab cast): a slow push-in across the slab. Says: \"The " +
      "ground floor slab is cast.\". Text: \"\".",
    "3 property, Tower B from the east (construction photo): a short slow rise up the bare concrete frame. Says: \"Possession " +
      "is June 2029.\". Text: \"\".",
    "4 property, the lower floors (construction photo, titled block work on the lower floors): a gentle pan along the walls. " +
      "Says: \"Block work is under way.\". Text: \"\".",
    "5 property, Tower B and the site from the air (construction photo): a slow drone pull back to the edge of the photo. " +
      "Says: \"Come and see the site.\". Text: \"VISIT THE SITE\".",
  ].join("\n"),
};

/**
 * Locality guide (template 12), rebuilt on 12 October 2026 from the narrated
 * location films of India's big developers, after the client called the
 * presenter explainer it replaced "pretty shit" and chose the narrated one
 * of the first three found: Godrej City Panvel's Location AV (2.6 lakh
 * views), Godrej Riverine's, Noida (58,000), and Birla Navya's, Gurugram.
 * Most developers' location films are music and labels; these three are
 * told by a narrator who teaches the buyer the area, and that is what the
 * client wants. They share one grammar: the place's big picture in a line;
 * the project pinned; the connections one by one (road, rail, metro,
 * airport), each said with what it does for the buyer and labelled with its
 * time; then life around it by kind (work, schools, hospitals, shopping,
 * leisure); and a close on the project's name. No presenter, no price, no
 * call to act.
 *
 * What this film does with it: a narrator nobody sees who talks over almost
 * every shot, our music and sound (`film-sound.ts`), the developer's own
 * approved location map shown exactly as approved and pushed slowly toward
 * the project by us (`usesMap`, `film-map.ts`), every signed nearby place
 * said with its own time and carded by us exactly as signed (`ourCards`),
 * each place shown on its own approved photo when the library holds one
 * (a Nearby place picture) and otherwise over the map or the building, and
 * a quiet close. A place with no photo of its own is never filmed: a video
 * model's station or mall is an invented landmark. Inputs made right on 13
 * October 2026, after the first film's map printed times nobody signed, its
 * tower changed from shot to shot and its cards came back misspelt
 * (`locality-rules.ts`). `SKILL.md` in the template's folder holds the study.
 *
 * Since 15 October 2026 it is an agent on camera instead (the client, after
 * the narrated map film came back with the routes wrong, a voice that came
 * and went, and too much crammed in: "we don't need a map"): one high-energy
 * presenter at the project names each place with its time, cut with the
 * places' own photos, the way the Agent on camera format sells a flat. No map.
 */
export const LOCALITY_SKILL: VideoSkill = {
  key: "12-locality-guide",
  label: "Locality guide",
  // Since 18 October 2026 (the client: "she is not appearing in any of the
  // places we are showcasing"), she takes the buyer there: standing at each
  // nearby place on its own approved photo, then home.
  format:
    "an \"agent on camera\" neighbourhood walk: one high-energy presenter opens at the project, then is seen AT each nearby " +
    "place on its own approved photo (outside the station, at the mall's entrance, at the school gate) saying its exact time " +
    "from home, then the building from the air, and she ends back at the project pointing at the lens",
  seconds: 30,
  scenes: { min: 8, max: 11 },
  shotSeconds: { min: 1.8, max: 3.4 },
  speech: "presenter",
  presenterScenes: { min: 5, max: 9 },
  peopleScenes: { min: 0, max: 0 },
  presenterOpensAndCloses: true,
  words: { min: 55, max: 78 },
  lineWords: 16,
  // Every card is ours, so a place name may be on one: "8 MIN / GOREGAON STATION".
  cards: { min: 3, max: 5, words: 6 },
  ourCards: true,
  wordsPerSecond: 2.8,
  // Most of the film is the area: at least three places, each with its own time.
  areaLines: 3,
  beats: [
    "Hook, the first three seconds: the presenter on camera, full body, in one of the approved spaces she can stand in (the " +
      "pool deck, the lounge, the balcony, a room of the sample flat), never in front of a picture of the towers from afar, " +
      "high energy, arms thrown open or pointing off toward the city, one line aimed at the viewer about WHERE this is " +
      "(\"Okay Mumbai, what if everything was five minutes from your door?\"). It may say the locality, never a nearby place: " +
      "every nearby place has a scene of its own later. Never the project's name first. No card.",
    "The connections, most of the film, one place to a scene, in the order the facts list them, at least three: each said " +
      "in one short punchy line with its exact time or distance from home and what it does for the buyer (\"Goregaon station? " +
      "Eight minutes from home.\"), the place named in full exactly as the facts write it, and carded exactly as the facts give " +
      "its card. A place with its own approved photo is a PRESENTER scene on that photo: she is there, standing or walking on " +
      "its footpath, forecourt or entrance plaza in front of it, the place behind her exactly as the photo shows it, thumb or " +
      "hand back over her shoulder at it as she says it (\"she stands on the footpath outside the station entrance, walks " +
      "toward the camera and points back at it\"). A place with none is said by her at the project, in one of the approved " +
      "spaces, pointing off to the side (write only \"points off to the side\" in the shot, never the place), and is never shown.",
    "For pace, at most one place may instead be a fast push-in on its photo with her voice over it and nobody in it. Every " +
      "other cut is her, place to place, as if she walked the neighbourhood: \"Eight minutes and I'm here. Now the highway.\"",
    "One beat of the home: the approved building from the air or one amenity, fast (\"And after all that, you come home " +
      "to this.\"). No card.",
    "The close, the last three seconds: the presenter, in one of the approved spaces, walks toward the lens and points " +
      "straight at it, saying the card's one action (\"Book your site visit this weekend!\").",
    "The building itself is only ever a fast drone shot with her voice over it, never a picture she stands in front of. " +
      "Every line is said up and clearly, never whispered.",
  ],
  look:
    "Hyper-realistic, like real footage shot on a phone gimbal and an FPV drone, bright natural daylight, punchy contrast, " +
    "nothing ever static: the camera always moves. Place and property shots are fast: fast push-ins, whip-pans with motion " +
    "blur, FPV drone rockets up the facade, a wide lens. A cut every two to three seconds.",
  presenter:
    "Very high energy and playful, like a top Instagram real-estate creator: big natural hand gestures, points off toward " +
    "each place as she names it, walks toward the camera, turns, raises an eyebrow, laughs once.",
  realism:
    "She looks like a real person filmed on a phone, indistinguishable from real footage: real skin with visible pores, " +
    "fine lines and slight unevenness, a natural, slightly asymmetric face, real hair with loose strands that moves as she " +
    "moves, eyes that blink and catch the light, natural teeth, lips that move exactly with every word, natural hands and " +
    "fingers, clothes with real fabric folds, and the same light, time of day and shadows on her as on the place around her " +
    "(warm and low at dusk, lamp light at night), standing on its floor at its scale. No beauty " +
    "filter; never airbrushed, waxy, glossy, plastic, doll-like or CGI.",
  voice:
    "Casual, upbeat, young urban Mumbai English with a light Indian accent, like an Instagram creator talking to a friend. " +
    "Clear and quick, never robotic, every time and distance said clearly. Each line flows in one breath: no pause inside a " +
    "line or inside a place's name.",
  text:
    "Big text cards, heavy rounded sans-serif in capitals, the time huge and the place under it, in the upper third. Each " +
    "card is set on the film afterwards, so keep the upper third of every shot clear and draw no words.",
  sound: "Only her voice (no other voices), trendy upbeat background music under it, a whoosh on every fast transition.",
  moves: {
    property: ["fpv", "drone", "whip", "fast", "quick", "rocket", "dive", "race", "rush", "sweep", "push-in", "glide", "dolly", "fly", "flies", "zoom"],
    forbidden: ["slow", "slowly", "smooth", "smoothly", "gentle", "gently", "calm", "calmly", "static", "still", "steady", "map"],
  },
  never: [
    "Show a station, train, metro, highway, road, mall, school, hospital or any other place near the project except on its " +
      "own approved photo: a place with no photo is said by the presenter at the project, never drawn.",
    "Put the presenter at a place that has no approved photo, inside a building, on the tracks, in the road, or anywhere " +
      "but at the project and on the nearby places' own photos.",
    "Add anything to a photo of a nearby place but the presenter: no other people in focus, no signs, no buildings it does " +
      "not show.",
    "Say or show a travel time, distance or place that is not in the approved facts, or round one up or down.",
    "Name more than six places in the whole film, the locality included, or say any place twice: after the first time it is " +
      "\"the station\", \"the highway\".",
    "Show a map.",
    "Say \"best\", \"finest\", \"most\", \"premier\" or any other superlative about the area or the project.",
    "Say a price, rents, appreciation, returns or investment, or compare the area with another one.",
    "Put the project's name in the first line.",
    "Write a line in Hindi or in Devanagari: the whole film is in English.",
  ],
  styleFrames: [],
  needs: {
    area: 3,
    areaWhy:
      "A locality guide needs at least three places near the project, each with how far it is (\"Goregaon station, 8 " +
      "minutes\"). Add them to the project's facts under \"Nearby places\" and sign them.",
    categories: ["EXTERIOR_RENDER"],
    count: 1,
    why: "A locality guide needs an approved picture of the building for its drone shot. Approve an exterior picture of it in the project's library.",
  },
  example: [
    "1 presenter, the rooftop pool deck: full-body wide shot, she stands on the open deck beside the water and throws her arms " +
      "open, then points off toward the city. Says: \"Okay Mumbai, let me show you what's around your new home.\"",
    "2 presenter, the photo titled Chembur station: mid shot, she stands on the footpath outside the station entrance, walks " +
      "toward the camera and points back at it over her shoulder. Says: \"Chembur station? Five minutes from home.\" Text: " +
      "\"5 MIN / CHEMBUR STATION\".",
    "3 presenter, the photo titled Eastern Freeway: full body on the footpath beside the road, the traffic behind her, she " +
      "turns from it to the lens. Says: \"The freeway, ten minutes, and you're in town.\" Text: \"10 MIN / EASTERN FREEWAY\".",
    "4 property, the photo titled R City Mall: a quick whip into a fast push along the front. Says: \"Weekends sorted, R City " +
      "Mall in ten minutes.\" Text: \"10 MIN / R CITY MALL\".",
    "5 presenter, the photo titled Ryan International School: mid shot at the school gate on the pavement, she leans into the " +
      "lens, eyebrows up. Says: \"Kids? Ryan International School is two kilometres away.\" Text: \"2 KM / RYAN INTERNATIONAL " +
      "SCHOOL\".",
    "6 presenter, the sample flat living room: mid shot, she walks fast toward the camera on the open floor, pointing off to " +
      "the side. Says: \"Office in BKC? Fifteen minutes.\" Text: \"15 MIN / BKC\".",
    "7 property, the tower elevation: FPV drone rockets up the facade, heavy motion blur. Says: \"And after all that, you come " +
      "home to this.\"",
    "8 presenter, the rooftop pool deck: full body, she walks along the open deck toward the camera and points straight at " +
      "the lens. Says: \"So what are you waiting for? Book your site visit this weekend!\"",
  ].join("\n"),
};

/**
 * Land to home (template 13), from its four reference reels (6 October 2026,
 * a frame every second or so of each): ONE locked-off drone view that never
 * moves, the empty plot first, then the whole build sped up in front of it
 * (survey lines, digging, foundations, columns, slabs, brick walls,
 * scaffolding, plaster, paint, glass, landscaping) with a small crew
 * swarming and the sky racing through day and night, ending on the finished
 * home at golden hour. The first version of this skill refused every
 * construction stage and grew the tower from glowing lines instead; the
 * client judged that approach on the building assembly "pathetic", because
 * the build IS the format. So the build is shown, as an artist's impression:
 * no date, no "today", no site words, and the last frame is the approved
 * picture exactly.
 */
export const LAND_TO_HOME_SKILL: VideoSkill = {
  key: "13-insta-friendly-ai-land-to-home-transformation",
  label: "Land to home",
  format:
    "a land-to-home timelapse: one locked-off drone view of the approved picture's own setting, the empty plot first, then " +
    "the whole build sped up in front of the camera (lines, digging, foundations, columns, slabs, walls, scaffolding, " +
    "plaster, facade, glass, landscaping) until it stands exactly as in the approved picture at golden hour; music and site " +
    "sounds only",
  seconds: 20,
  scenes: { min: 6, max: 8 },
  shotSeconds: { min: 2, max: 4 },
  speech: "none",
  presenterScenes: { min: 0, max: 0 },
  peopleScenes: { min: 0, max: 0 },
  presenterOpensAndCloses: false,
  words: { min: 0, max: 0 },
  lineWords: 0,
  cards: { min: 1, max: 2, words: 4 },
  wordsPerSecond: 2.5,
  oneTake: true,
  builds: true,
  hooks: ["FROM LAND TO HOME", "LAND TO HOME", "WATCH IT RISE", "WAIT FOR IT"],
  cardAccent: "#ffffff",
  beats: [
    "Every scene is a moment of ONE continuous take from a drone hovering high above the plot, at the approved exterior " +
      "picture's own viewpoint, looking down at it at an angle. The camera is locked: it never pans, tilts, cuts or shakes " +
      "until a slow push-in in the last seconds. Only the building and the ground change, and the sky races (clouds " +
      "streaming, the sun arcing, shadows sweeping across the ground).",
    "The plot, about two seconds: the first frame is the approved picture itself with the building not yet there: the " +
      "same neighbouring buildings, roads, trees, skyline and horizon exactly where the picture has them, and where the " +
      "building stands an empty, levelled plot of earth with a few shrubs, thin glowing white lines tracing the " +
      "building's footprint on it. The hook card here and only here (\"FROM LAND TO HOME\", \"WATCH IT RISE\").",
    "The groundwork, about three seconds, sped up: a small crew in hi-vis vests and hard hats walks the lines, an excavator " +
      "digs the footprint, foundations and the first column bars appear, a mixer truck and a tipper come and go. No words on " +
      "screen.",
    "The structure, about four seconds: columns and floor slabs climb level by level in exactly the building's own shape and " +
      "to its full height, scaffolding wraps it, a tower crane swings for a tall building, brick infill walls fill the " +
      "frame, and one quick night passes under site floodlights. No words on screen.",
    "The skin, about four seconds: grey plaster, then the building's own facade colours, glass and balcony rails sweep up " +
      "from the ground floor to the top, the scaffolding comes down, the crew thins out. No words on screen.",
    "The finish, about three seconds: the site is cleared, the landscaping and paving roll out around the foot, the light " +
      "turns golden, and the building stands exactly as in the approved picture, its windows glowing warm. A soft deep hit " +
      "on the beat. No words on screen.",
    "The close, about two seconds: the finished building held at golden hour exactly as approved, the camera finally " +
      "easing into a slow push-in. The price card if the facts carry one, otherwise the action (\"BOOK A SITE VISIT\").",
  ],
  look:
    "A hyper-realistic aerial timelapse from a hovering drone, like real footage sped up hundreds of times: crisp, bright " +
    "natural daylight, gently saturated, real dust, real materials, real shadows; tiny figures of workers and machines " +
    "moving fast like a timelapse, never a close-up of anybody. The surroundings are the approved picture's own and stay " +
    "identical from the first frame to the last; only the plot changes. It ends warm, at golden hour, on the approved " +
    "picture itself.",
  presenter: null,
  realism: null,
  voice: null,
  text:
    "Clean white sans-serif in capitals, bold, with a soft shadow, in the upper third of the frame. Each card fades in " +
    "whole, all its words at once, only in its own shot; nothing is written over the build.",
  sound:
    "A slow-building cinematic track (warm strings and a steady pulse) that rises with the building, and under it the " +
    "sped-up sounds of the site (an excavator, a concrete mixer, hammering, a crane's whine, birds at dawn) fading away as it " +
    "finishes, then a soft deep hit when it stands. Nobody speaks.",
  moves: {
    property: ["locked", "lock-off", "hold", "hover", "hovering", "push-in", "creep", "rise", "rises", "rising", "climb", "climbs", "grow", "sweep"],
    forbidden: ["whip", "fpv", "orbit", "spin", "dive", "zoom", "handheld", "shake", "swoop", "pan", "cut to"],
  },
  never: [
    "Say or show a date, a month, a year, \"today\", \"now\", \"progress\", \"possession\", \"this plot\", \"our site\" or " +
      "\"here\": this is an artist's impression of how the home comes together, never a record of the site.",
    "End on anything but the approved picture exactly: the same shape, height, number of floors and colours, never an extra " +
      "floor, balcony, pool, sea, landmark, car or person it does not show.",
    "Change the surroundings between the first frame and the last: the same trees, roads, neighbours and horizon throughout.",
    "Move or cut the camera during the build: it is locked until the last seconds' slow push-in.",
    "Show a worker's face up close, a company name or logo on a vest, a signboard, a banner or any writing on the site.",
    "Build it in another shape, or taller or wider than the building in the approved picture.",
    "Put a place name, a number or a claim on a card that is not in the approved facts, or more than one price.",
    "Write anything in Hindi or in Devanagari.",
  ],
  styleFrames: [],
  needs: null,
  example: [
    "1 property, the tower elevation: locked-off drone hover high above the plot at the picture's own viewpoint; the first " +
      "frame is the picture itself with the tower not yet there, its own neighbouring buildings, roads, trees and horizon, the " +
      "plot empty levelled earth with a few shrubs, thin glowing white lines tracing the footprint, clouds streaming. Text: \"FROM LAND TO HOME\".",
    "2 property, the tower elevation: the same locked frame, sped up: a small crew in hi-vis vests walks the lines, an " +
      "excavator digs the footprint, a mixer truck comes and goes, shadows sweeping across the ground.",
    "3 property, the tower elevation: still locked: foundations and column bars rise, the first floor slab is poured, " +
      "scaffolding climbs, the sun arcing overhead.",
    "4 property, the tower elevation: still locked: columns and slabs climb level by level to the tower's full height in " +
      "its own shape, a tower crane swinging, brick walls filling in, one quick night under site floodlights.",
    "5 property, the tower elevation: still locked: grey plaster, then the tower's own facade colours, glass and balcony " +
      "rails sweep up from the ground floor to the top, the scaffolding comes down.",
    "6 property, the tower elevation: still locked: the site is cleared, landscaping and paving roll out around the foot, " +
      "the light turns golden and the tower stands exactly as approved, windows glowing warm.",
    "7 property, the tower elevation: hold on the finished tower at golden hour, the camera easing into a slow push-in. " +
      "Text: \"2 BHK / ₹1.45 CR\".",
  ].join("\n"),
};

/**
 * Building assembly (template 14, the folder still named for the dust
 * reveal it was found under), from its three reference reels. Each builds
 * the building in front of the camera: Ozora's house goes up on its own plot
 * from a bare frame to the finished house; Real Estate Media House's drone
 * flies through footings, rebar, a steel frame and stacking floors to the
 * finished block; umutcancelikls' floors drop from the sky and stack. Dust is
 * only what flies while the pieces lock. So: one place, one camera, one
 * light, the approved building assembling piece by piece on its own ground
 * and ending exactly as its approved picture. The ground before is the
 * approved picture's own setting with the building's spot bare. A film of
 * 5 October 2026 that showed only a dust cloud and the finished tower inside
 * it was "absolutely pathetic" to the client.
 */
export const DUST_REVEAL_SKILL: VideoSkill = {
  key: "14-insta-friendly-vfx-dust-transition-reveal",
  label: "Building assembly",
  format:
    "a building assembly: on its own bare ground, in the setting of the approved exterior picture, the building assembles " +
    "itself piece by piece (footings and columns rising, a frame locking together, floor slabs stacking, facade panels and " +
    "glass snapping on) until it stands exactly as in its approved picture; music only",
  seconds: 15,
  scenes: { min: 4, max: 5 },
  shotSeconds: { min: 2, max: 4 },
  speech: "none",
  presenterScenes: { min: 0, max: 0 },
  peopleScenes: { min: 0, max: 0 },
  presenterOpensAndCloses: false,
  words: { min: 0, max: 0 },
  lineWords: 0,
  cards: { min: 1, max: 2, words: 4 },
  wordsPerSecond: 2.5,
  beats: [
    "Every scene is a moment of ONE continuous take on the approved exterior picture: the same view, the same light from " +
      "the first frame to the last. No cut, no second place, no other picture. The building assembles in front of the " +
      "camera; the camera never leaves it.",
    "The ground, about two seconds: the setting of the approved exterior picture from the same spot, the ground where the " +
      "building stands bare earth, the building not there yet; the camera low, drifting slowly toward the spot. The hook " +
      "card here and only here: \"WATCH IT RISE\", \"WAIT FOR IT\" or \"WATCH THIS\".",
    "The frame, about four seconds: the ground cracks open and footings and columns rise out of the earth, beams swing in " +
      "and lock onto them, and the frame climbs level by level to the building's full height, in the building's own shape, " +
      "small bursts of dust and sparks where pieces lock. No words on screen.",
    "The skin, about three and a half seconds: floor slabs slide in and stack, then facade panels, windows and balcony glass " +
      "fly in and snap onto the frame level by level from the bottom to the top, the camera rising slowly with them. No words " +
      "on screen.",
    "The finish, about three seconds: the last panels lock, the landscaping rolls out around the foot, the dust settles, and " +
      "the building stands exactly as in the approved picture, the camera easing into a slow push-in. A soft deep hit on the " +
      "beat. No words on screen.",
    "The close, about two and a half seconds: the same view held, the push-in still creeping. The price card if the facts " +
      "carry one, otherwise the action (\"BOOK A SITE VISIT\"). With four scenes, the finish and the close are one.",
  ],
  look:
    "Hyper-realistic, like real footage from a stabilised camera or a slow FPV drone, bright natural daylight, one " +
    "continuous take with no cuts. A clean visual effect, not a building site: the pieces move by themselves, fast and " +
    "precise, each landing with a small puff of dust or a spark, and every piece is part of the approved building in its " +
    "own shape and colours. The finished building is crisp and clean against a clear sky, exactly the approved picture.",
  presenter: null,
  realism: null,
  voice: null,
  text:
    "Bold pure white sans-serif in capitals with a soft dark shadow, never pink, red or any colour, in the upper third of " +
    "the frame. A card pops in whole, all its words at once, stays only in its own shot and is gone before the next shot " +
    "begins. Nothing is written while the building assembles.",
  sound:
    "Trendy upbeat background music building with the assembly, no voice at all. Mechanical clunks and whooshes as pieces " +
    "fly in and lock, a soft deep hit when the building completes, the music lifting.",
  moves: {
    property: ["rise", "rising", "climb", "drift", "creep", "push-in", "hold", "glide", "fpv", "drone", "fly", "flies", "assemble", "stack", "lock", "snap"],
    forbidden: ["static", "whip", "orbit", "spin", "zoom", "morph", "timelapse", "time-lapse", "pan"],
  },
  never: [
    "Cut, change the camera position, or move to another place or another picture: the whole film is one take on the " +
      "approved exterior picture.",
    "Show workers, cranes, scaffolding, excavators or a building site: the pieces assemble themselves.",
    "Let the frame or the facade take any shape but the approved building's: the same footprint, the same number of floors " +
      "and towers, the same facade, never one floor more.",
    "Let the finished building be anything but the approved picture exactly: never an extra floor, a sea, a landmark or a " +
      "view it does not show.",
    "Show an amenity, a room or the sample flat: the film is the building assembling, once.",
    "Show a face, or anybody at all.",
    "Write \"before\", \"after\", \"what we got\" or \"what we made\".",
    "Write a line for anybody to say: nobody speaks in this format.",
    "Put a place name, the project's name or a number on a card the model draws; a price card is ours.",
    "Write a card in Hindi or in Devanagari: the whole film is in English.",
  ],
  styleFrames: [],
  needs: null,
  oneTake: true,
  assembles: true,
  cardAccent: "#ffffff",
  hooks: ["WATCH IT RISE", "WAIT FOR IT", "WATCH THIS"],
  example: [
    "1 property, the tower elevation: the same view as the picture with the tower's ground bare earth and the tower not " +
      "there yet, the camera low, drifting slowly toward the spot. Text: \"WATCH IT RISE\".",
    "2 property, the tower elevation: the ground cracks open, footings and columns rise out of the earth, beams swing in and " +
      "lock, and the frame climbs level by level to the tower's full height in its own shape, dust and sparks where pieces " +
      "lock, the camera holding steady.",
    "3 property, the tower elevation: floor slabs slide in and stack, then facade panels, windows and balcony glass fly in and " +
      "snap onto the frame from the bottom to the top, the camera rising slowly with them.",
    "4 property, the tower elevation: the last panels lock, the landscaping rolls out around the foot, the dust settles and " +
      "the tower stands exactly as in the approved picture, a slow push-in, a soft deep hit on the beat.",
    "5 property, the tower elevation: the same view held, the slow push-in creeping. Text: \"2 BHK / ₹1.45 CR\".",
  ].join("\n"),
};

/**
 * Plot from the air (template 15), from its four reference reels: real drone
 * footage of real land, the surveyed boundary tracing itself on, the area
 * stamped, the roads around it marked. Not made: we hold no aerial picture of
 * any real site, nothing in the product holds the survey's corner points, and
 * a boundary the video model draws is an unchecked claim about land. `needs`
 * carries no category so code refuses it before anything is paid for; the
 * rest is kept for the day an approved aerial photograph, a boundary we draw
 * from the survey and a signed land area exist.
 */
export const PLOT_FROM_THE_AIR_SKILL: VideoSkill = {
  key: "15-insta-friendly-drone-plot-boundary-graphics",
  label: "Plot from the air",
  format:
    "a plot from the air: a drone view of the real site with its surveyed boundary tracing on, the land area stamped, and the " +
    "road it connects to marked",
  seconds: 15,
  scenes: { min: 4, max: 6 },
  shotSeconds: { min: 2, max: 4 },
  speech: "voiceover",
  presenterScenes: { min: 0, max: 0 },
  peopleScenes: { min: 0, max: 0 },
  presenterOpensAndCloses: false,
  words: { min: 12, max: 26 },
  lineWords: 12,
  cards: { min: 1, max: 3, words: 4 },
  wordsPerSecond: 2.5,
  beats: [
    "The hook, three to four seconds: a slow drone rise from low over the trees to high above the site, the land coming into " +
      "view, and the narrator saying its size and the locality once (\"This is what twelve acres in <the locality> looks like.\").",
    "The land, then the line: top-down, the gimbal straight down, half a second of plain land, then a glowing yellow line traces " +
      "the boundary clockwise from the corner nearest the road, with a soft fill behind it. The area is that shot's card, set by us.",
    "One connection: the camera tilts up and drifts toward the main road, a glowing line tracing along a road that is in the " +
      "picture. Nothing marked that the picture does not show.",
    "The price, once, if the facts carry one: the narrator says it, and the price is that shot's big text.",
    "The close, the last two to three seconds: a slow rise away from the site, one action said and on a card.",
  ],
  look:
    "Real drone footage on a clear morning: bright natural daylight, natural greens and earth, gentle contrast, steady and slow. " +
    "Top-down at ninety degrees for the boundary, a slow rise or drift for context, a low slow orbit to close. The glowing " +
    "yellow line is the only saturated thing in frame and draws itself on rather than appearing.",
  presenter: null,
  realism: null,
  voice:
    "A calm, assured narrator in clear Indian English, unhurried, like a property consultant pointing at a map. Each line in " +
    "one breath, no dramatic pause.",
  text:
    "Heavy white sans-serif in capitals with a soft dark shadow, in the upper third of the frame, clear of the boundary. Each " +
    "card pops in whole, all its words at once, in its own shot only.",
  sound:
    "Light, confident background music under the narrator's voice, a soft rising shimmer as the boundary draws, no other voices.",
  moves: {
    property: ["drone", "top-down", "overhead", "hover", "rise", "rising", "descend", "tilt", "orbit", "glide", "drift", "trace"],
    forbidden: ["whip", "fpv", "spin", "dive", "shake", "handheld", "zoom", "rush"],
  },
  never: [
    "Show a site from the air that the approved picture does not show: no generated aerial of the land.",
    "Draw a boundary that is not the surveyed one, or one that takes in a neighbour's land or leaves out the project's own.",
    "Put the land area, a distance or any other number on a card the model draws: every number on screen is set by us.",
    "Mark a road, station, school or landmark on the aerial that is not in the picture, or a distance the facts do not carry.",
    "Grow buildings on the land, or show what else could be built there.",
    "Write \"FOR SALE\", \"plot\", \"investment\" or \"returns\": the developer sells homes, not land.",
    "Say or show a number, price or claim that is not in the approved facts, or more than one price.",
    "Put a place name on a card, or say the locality more than once.",
    "Write a line in Hindi or in Devanagari: the whole film is in English.",
  ],
  styleFrames: [],
  needs: {
    categories: [],
    count: 1,
    why:
      "We can't make this one yet. It needs real drone footage of your site and its surveyed boundary, and we have neither: a " +
      "boundary drawn on a picture we made could show land that isn't yours.",
  },
  example: [
    "1 property, the site from the air: the drone rises slowly from low over the trees to high above the site, the land coming " +
      "into view. Says: \"This is what twelve acres in Powai looks like.\" Text: \"SEE THE SIZE\".",
    "2 property, the site from the air: top-down hover, the gimbal straight down, the land plain for a moment, then a glowing " +
      "yellow line traces the boundary clockwise from the corner nearest the road, a soft fill behind it. Text: \"12 ACRES\".",
    "3 property, the site from the air: the drone tilts up and drifts toward the main road, a glowing line tracing along the " +
      "road at the edge of the picture.",
    "4 property, the site from the air: a slow low orbit around the edge of the site. Says: \"2 BHK homes from ₹1.45 Cr.\" " +
      "Text: \"2 BHK / ₹1.45 CR\".",
    "5 property, the site from the air: the drone keeps rising slowly away from the site. Says: \"Book your site visit.\"",
  ].join("\n"),
};

/**
 * Cinematic tour (template 18), from the three reels the folder holds since
 * 5 October 2026 (about forty frames of each, and their cuts): 01 opens high
 * above the tower with a hook card, swipes room to room on the beat with each
 * room's name popping in, and ends on the tower at dusk; 03 glides through a
 * finished flat a cut every second and a half, detail by detail; 07 is a
 * luxury rooftop's mood, a woman's silhouette at sunset, the city lit at
 * night. The first version of this skill was read off reel 02 (one slow push,
 * one line, no labels), which the client took out of the folder, so it now
 * follows the three that are left. Rooms come only from approved pictures and
 * are joined by a cut or a swipe on the beat, never by a walk through a
 * doorway, so no layout and no view is invented.
 */
export const SLOW_TOUR_SKILL: VideoSkill = {
  key: "18-insta-friendly-cinematic-slow-tour",
  label: "Cinematic tour",
  format:
    "a cinematic home tour cut to the beat: a hook high above the building, then the approved rooms one after another, each " +
    "a smooth gimbal glide with its name popping in, a close detail, one quiet lifestyle moment at golden hour, and the building " +
    "at dusk to close; music only",
  seconds: 20,
  scenes: { min: 8, max: 10 },
  shotSeconds: { min: 1.5, max: 3 },
  speech: "none",
  presenterScenes: { min: 0, max: 0 },
  peopleScenes: { min: 0, max: 1 },
  presenterOpensAndCloses: false,
  words: { min: 0, max: 0 },
  lineWords: 0,
  cards: { min: 3, max: 8, words: 3 },
  wordsPerSecond: 2.5,
  hooks: ["STEP INSIDE", "TAKE A LOOK INSIDE", "COME ON IN", "WAIT FOR IT"],
  cardAccent: "#ffffff",
  beats: [
    "The hook, about three seconds: high above the approved exterior in soft daylight, a slow rise or drift past its upper " +
      "floors, clouds moving. The hook card here (\"STEP INSIDE\").",
    "The rooms, about two seconds each, four to six of them: every approved room picture its own shot (the living room, the " +
      "bedroom, the kitchen, the balcony, the lobby, an amenity), a smooth gimbal glide or slow push-in through it at waist " +
      "height, every lamp on and warm. The room's name pops in big as its card (\"LIVING ROOM\", \"BEDROOM\"), taken from the " +
      "picture's own title. Each room is joined to the next by a cut or a quick swipe on the beat in the same direction, never " +
      "by walking through a doorway.",
    "The detail, about one and a half seconds: close and slow on something one picture plainly shows (a lamp and a cushion, " +
      "the stone of a counter, light across a wall), shallow focus. No card.",
    "The moment, about two and a half seconds, when the library has a balcony, terrace or amenity: one person seen from " +
      "behind or in silhouette at its railing at golden hour, the sun low behind them, the breeze in their clothes, a slow " +
      "glide. Never a face, never posed as a buyer. No card.",
    "The close, about three seconds: the approved exterior at dusk, its windows glowing warm, a slow pull back. A card is " +
      "placed there afterwards (the project's name), so its upper third stays clear.",
  ],
  look:
    "Cinematic and warm, like a 24 fps gimbal film of a premium home: every lamp on in a warm tone, golden window light, " +
    "shadows soft rather than black, highlights warm, rich but natural colour, shallow depth of field and natural motion " +
    "blur. Every shot is one smooth, unbroken move; the rhythm comes from the cuts, a new room on every beat. Rooms are clean, " +
    "styled and still: no clutter, no ceiling fan turning, no people but the one moment.",
  presenter: null,
  realism: null,
  voice: null,
  text:
    "Each room's name in bold white sans-serif capitals with a soft shadow, large, in the middle third of the frame, popping " +
    "in whole on the beat and gone before the next room. The hook card the same way. Nothing else is written on the film.",
  sound:
    "One warm, modern instrumental track with a clear beat that each cut lands on, building gently to the dusk close, a soft " +
    "whoosh on each swipe; no voice. It ends on the last frame rather than fading.",
  moves: {
    property: [
      "glide", "gimbal", "push-in", "push", "dolly", "slide", "drift", "track", "rise", "rising", "crane", "pull", "pull back",
      "tilt", "pan", "swipe", "creep",
    ],
    forbidden: ["fpv", "orbit", "spin", "dive", "rocket", "zoom", "snap", "shaky", "handheld", "crash", "morph", "timelapse", "time-lapse", "glitch", "static"],
  },
  never: [
    "Walk from one room into another, or push through a doorway into a room the pictures do not show: how rooms connect is the " +
      "floor plan, and a layout the film invents is a layout promised. Rooms are joined by a cut or a swipe on the beat.",
    "Show a view through a window or from the balcony that the picture does not show: no sea, skyline, city lights or " +
      "greenery added. Every window stays exactly as its picture has it.",
    "Show a room, a fitting, a material or a detail the pictures do not show, or say the furniture and decor come with the home.",
    "Label a room with a name its picture's title does not give it, or put a price, a number or a place name on a card the " +
      "model draws.",
    "Show crew, a camera, a drone, a laptop, a model posing, or a \"behind the scenes\" or \"POV\" caption.",
    "Show a face, a family posing as owners, or anybody presented as a buyer or a resident: at most one figure, from behind or " +
      "in silhouette, in one shot.",
    "Write a line for anybody to say: nobody speaks in this format.",
    "Write a card in Hindi or in Devanagari: the whole film is in English.",
  ],
  styleFrames: [],
  needs: {
    categories: ["SAMPLE_FLAT", "LOBBY", "AMENITY"],
    count: 3,
    exterior: true,
    why:
      "A cinematic tour moves through the home, so it needs at least three approved pictures of the sample flat, the lobby or " +
      "an amenity, and one approved picture of the building, so no room is invented.",
  },
  example: [
    "1 property, the tower elevation: high above the tower in soft daylight, a slow rise past its top floors, clouds drifting. " +
      "Text: \"STEP INSIDE\".",
    "2 property, the sample flat living room: a smooth gimbal glide across the room at waist height, every lamp on and warm, a " +
      "swipe on the beat to the next room. Text: \"LIVING ROOM\".",
    "3 property, the sample flat bedroom: a slow push-in toward the bed and the window, soft golden light across the sheets. " +
      "Text: \"BEDROOM\".",
    "4 property, the sample flat kitchen: a low dolly along the counter, the light catching the stone. Text: \"KITCHEN\".",
    "5 property, the sample flat living room: close on a lamp and a cushion the picture shows, shallow focus, a slow drift.",
    "6 property, the balcony: a smooth glide out along the railing, golden hour. Text: \"BALCONY\".",
    "7 people, the balcony: a woman seen from behind at the railing, silhouetted against the low sun, her dupatta lifting in " +
      "the breeze, a slow glide.",
    "8 property, the rooftop pool: a slow glide low over the water, golden light on the deck. Text: \"ROOFTOP POOL\".",
    "9 property, the tower elevation: the tower at dusk, its windows glowing warm, a slow pull back. Text: \"SATH HEIGHTS\".",
  ].join("\n"),
};

/**
 * Construction progress (template 19), from its nine reference reels: six are
 * a developer's own site cut fast to music (about a second a shot, hard cuts
 * on the beat, short bold cards, nobody speaking); the others are an
 * engineer's explainer, an agency's pitch and a creator's vlog with the
 * workers, none of which we make. The Instagram cousin of the Construction
 * update (template 06): no narrator, more photos, quicker moves, the months
 * on screen. The truth rule is 06's: every shot is one fresh, dated
 * CONSTRUCTION photo, moved and changed in nothing, and the month, the name
 * and any price are cards we set after the film.
 */
export const CONSTRUCTION_PROGRESS_SKILL: VideoSkill = {
  key: "19-insta-friendly-construction-progress",
  label: "Construction progress",
  format:
    "a construction progress reel: the tower's latest dated site photos, oldest first, each given one quick camera move and " +
    "cut hard to a beat, with the months on screen and no voice, and nothing in any photo changed",
  seconds: 15,
  scenes: { min: 6, max: 9 },
  shotSeconds: { min: 1, max: 2.5 },
  speech: "none",
  presenterScenes: { min: 0, max: 0 },
  peopleScenes: { min: 0, max: 0 },
  presenterOpensAndCloses: false,
  words: { min: 0, max: 0 },
  lineWords: 0,
  // The project's name, each month and any price are ours (`isFactCard()`):
  // the model draws at most "PROGRESS UPDATE" and "VISIT THE SITE".
  cards: { min: 2, max: 5, words: 4 },
  wordsPerSecond: 2.5,
  beats: [
    "The hook, about two seconds: the widest photo, the tower or the site from the air, a quick punch-in on the first beat. " +
      "The card is the project's name exactly as the facts give it; we set it after the film.",
    "The progress, four to seven shots of one to two seconds: the photos in the order they were taken, oldest first, one " +
      "photo a shot, each with one quick move landing on the beat (a fast push-in across a slab, a quick tilt up the columns, " +
      "a snap push-in on the frame, a fast drift along the nets). Over the first photo of each month, that month and year as " +
      "the card (\"AUGUST 2026\"), set by us; the other shots carry no card. A photo may be used twice only with a different " +
      "move and never back to back.",
    "At most once in the middle, and only when a card is left: \"PROGRESS UPDATE\". Never a card naming a stage of work.",
    "The close, the last two to three seconds: the newest wide photo, a quick drone pull back to the edge of the photo on the " +
      "last beat. The card is \"VISIT THE SITE\", or the price card when the facts carry a price.",
  ],
  look:
    "Real site photographs, kept true: the bare concrete, the rebar, the scaffolding, the green safety nets, the cranes, the " +
    "weather and the light exactly as photographed. Each photo gets one quick move with soft parallax (a punch-in, a fast " +
    "push-in, a short rise, a quick tilt or pan, a speed ramp that starts fast and settles, a drone pull back). Hard cuts on " +
    "the beat every one to two seconds, the odd white flash frame or whip-pan blur between two photos, never a blend. Only " +
    "the sky, the light, dust and the nets move; anybody or anything already in a photo stays exactly as it was caught. A " +
    "punchy contrast grade, a little cool and desaturated, a soft vignette: no sky replaced, no golden glow or dusk added, " +
    "nothing cleaned up.",
  presenter: null,
  realism: null,
  voice: null,
  text:
    "Two to five cards: bold condensed sans-serif capitals, white with a soft shadow, centred in the middle third of the " +
    "frame and clear of the top-right corner and the foot, each popping in whole on a beat in its own shot. The project's " +
    "name, the months and any price are cards we set after the film; the video model draws at most \"PROGRESS UPDATE\" and " +
    "\"VISIT THE SITE\", and no other words anywhere.",
  sound:
    "One punchy modern instrumental with a hard drum beat, every cut landing on a beat, a whoosh on a whip-pan, a riser into " +
    "the close and a hit on the last card. No voice, no lyrics, no other sound.",
  moves: {
    property: ["punch", "push", "rise", "drift", "tilt", "pan", "snap", "ramp", "whip", "flash", "pull", "drone", "quick", "fast"],
    forbidden: [
      "slow",
      "static",
      "orbit",
      "fpv",
      "morph",
      "dissolve",
      "timelapse",
      "time-lapse",
      "transform",
      "grow",
      "builds",
      "finish",
      "complete",
      "worker",
      "labourer",
      "night",
      "sunset",
    ],
  },
  never: [
    "Show any progress that no dated construction photo shows: no extra floor, no slab, glass, paint, plaster or facade on " +
      "bare concrete, no scaffolding or net taken away. Each shot is one photo exactly as it was taken.",
    "Morph, dissolve, blend or time-lapse one photo into another or into a render: every in-between frame is a stage of work " +
      "that never happened. A whip-pan blur or a flash frame is the only thing between two photos.",
    "Use a render, an amenity, the logo or any picture that is not a dated construction photo of this tower, or end on the " +
      "finished building: the reels end on a rendered pool, and we never do.",
    "Animate workers pouring concrete, laying blocks or plastering, or add workers, machines, cranes or vehicles: the reels' " +
      "best shots are real people caught working, and a video model can only invent them.",
    "Orbit or fly through a photo: the other side of the building is not in the picture.",
    "Put a percentage, a flat or shop count, floor labels, a RERA or commencement date, or the possession date on a card: a " +
      "month on screen in this film is only ever the month its photos were taken.",
    "Write a card saying the work is on schedule, nearly done, coming soon or in its final stage, or name a stage of work.",
    "Order the photos by anything but the date they were taken, or call them today's.",
    "Draw the project's name as a sign on the building or floating over it: the name is a card we set.",
    "Write a line for anybody to say: nobody speaks in this format.",
    "Write a card in Hindi or in Devanagari: the whole film is in English.",
  ],
  styleFrames: [],
  hooks: ["PROGRESS UPDATE", "VISIT THE SITE"],
  needs: {
    categories: ["CONSTRUCTION"],
    count: 4,
    why:
      "A construction progress reel needs at least four approved construction photos of this tower, each with the date it was " +
      "taken and all from the last 90 days, so every month on screen is real.",
  },
  example: [
    "1 property, Tower A and the site from the air (construction photo, July 2026): a quick punch-in toward the tower on the " +
      "first beat, clouds drifting behind it. Text: \"CORAL CREST\".",
    "2 property, the raft foundation (construction photo, July 2026): a fast push-in across the rebar, landing on the beat. " +
      "Text: \"JULY 2026\".",
    "3 property, the podium columns (construction photo, July 2026): a quick tilt up the columns, a hard cut on the beat. " +
      "Text: \"\".",
    "4 property, Tower A from the east (construction photo, August 2026): a snap push-in on the concrete frame, the green nets " +
      "stirring in the wind. Text: \"AUGUST 2026\".",
    "5 property, the third floor slab (construction photo, August 2026): a whip-pan blur lands on the slab, then a fast drift " +
      "along its edge. Text: \"\".",
    "6 property, Tower A from the street (construction photo, September 2026): a quick rise up the bare frame, a white flash " +
      "on the beat. Text: \"SEPTEMBER 2026\".",
    "7 property, the block work on the lower floors (construction photo, September 2026): a speed ramp pan along the walls, " +
      "fast then settling. Text: \"\".",
    "8 property, Tower A and the site from the air (construction photo, September 2026): a quick drone pull back to the edge " +
      "of the photo on the last beat. Text: \"VISIT THE SITE\".",
  ].join("\n"),
};

/**
 * Narrated story (`STORY_TEMPLATE`), from the four reference films in
 * `00-narrated-story/` (Godrej Ascend, the two Piramal Aranya films and The
 * Man Company), watched again on 5 October 2026. Each opens on an ordinary
 * moment of a family's day and a small problem, turns, lets the home answer
 * it, and ends on a small joy: Godrej's boy afraid of a new school answered
 * with "two minutes from D-Mart", Piramal's father coming home to find his
 * daughter hiding. One voice carries it, warm and unhurried.
 *
 * It was the director's stitched reel until 5 October 2026 (Kling clips, a
 * Sarvam voice read line by line, no story structure), and the client called
 * the result the worst output the product had made. It is now ONE Seedance
 * film like every other video: the voice made with the picture, the people
 * in ordinary places and inside the approved rooms, the home only ever an
 * approved picture.
 */
const NARRATED_STORY_BASE: VideoSkill = {
  key: "story",
  label: "Narrated story",
  format:
    "a short family story told by one warm voice: an ordinary moment and a small problem in a person's day, the turn, the " +
    "home answering it with its approved facts, and a small joy at the end",
  seconds: 30,
  scenes: { min: 8, max: 10 },
  shotSeconds: { min: 2, max: 4.5 },
  speech: "voiceover",
  presenterScenes: { min: 0, max: 0 },
  peopleScenes: { min: 3, max: 8 },
  presenterOpensAndCloses: false,
  words: { min: 38, max: 62 },
  lineWords: 14,
  // The price card is ours; the action may be the second.
  cards: { min: 1, max: 2, words: 4 },
  wordsPerSecond: 2.5,
  beats: [
    "Pick the story from the strongest approved fact, and let it carry the whole film: a station or a road close by is a " +
      "parent home before bedtime; a school close by is a child's first day; more room is a child with a room of their own; " +
      "a view or greens is a couple who grew up with open space; an amenity is a weekend no longer spent driving elsewhere. " +
      "One person (or one family) and one small problem. Never a list of facts. The voice IS that person, in the first " +
      "person (\"I\", \"my\"): a father's story in his own male voice, a mother's in hers, never a narrator talking about " +
      "\"him\" or \"her\".",
    "One or two things happen in a shot, never more: a shot of two to four seconds that asks for four actions loses some. " +
      "Coming home is two shots: him outside the front door in the corridor, ringing; then the door opened from inside by " +
      "the child or partner, and him stepping in.",
    "One evening, told in order: every shot picks up exactly where the last one left off, and time only moves forward. " +
      "Once the story leaves a room it never goes back to it (the bedtime story is the end of the evening, never before the " +
      "sofa). Every shot says where each person is and which way they move, so nothing happens backwards: coming home, he is " +
      "OUTSIDE the front door in the corridor and rings or knocks, and the child or partner opens it from inside; he never " +
      "opens a door from inside to come in.",
    "The setup, about eight seconds, two or three people shots: the person in an ordinary place away from the project (an " +
      "office at dusk, a crowded station, a car in traffic, a small rented flat), a small, true-to-life moment that shows the " +
      "problem. The voice opens on the feeling, never on the building (\"I love my work. But evenings are my favourite part.\").",
    "The turn, about three seconds and a short line of eight words at most: the exterior picture, a sweeping rise that keeps moving to the last frame (clouds drifting, trees swaying in front, lights coming on), the music lifting. The voice answers the problem with " +
      "the strongest fact, said as something the person needs (\"Eight minutes from the station, and I'm home.\").",
    "The answer, about ten seconds, three or four shots in the one or two places of the home the story needs (usually the " +
      "sample flat and its balcony; the lobby, a pool or another amenity only when the story is about that place), the same " +
      "people carrying on the same evening, one fact a shot said as a line of their life. One room may carry two or three " +
      "shots: a picture that does not belong to this story is left out, however good it is.",
    "The payoff, about five seconds: the small joy that solves the problem, in the sample flat or on its balcony (the child " +
      "lifted onto a shoulder, the family together at dusk), and the price said once, if the facts carry one.",
    "The close, about three seconds: the exterior, wide and calm, the music resolving, one short line that sums the feeling " +
      "(\"Come home a little sooner.\"). An end card is placed over it afterwards.",
  ],
  look:
    "Real footage of real people, like an observational Indian brand film: natural light from what is in the place (table " +
    "lamps, a window, golden hour, dusk), a soft warm grade that is the same on every shot, real skin and real faces, never the " +
    "polished look of an advert. People shots are handheld, close and intimate, with real motion and real moments; the building " +
    "and the rooms are always moving, the camera never stops and the frame is never a still picture.",
  presenter: null,
  realism: null,
  voice:
    "One warm Indian voice in clear Indian English: the main character's own voice, speaking as a voice-over in the first " +
    "person. An actor's performance, not a reading: the voice lives the story, so its pitch, loudness and pace change with every " +
    "line, the way each shot below says. Quiet and close in the small problem, lifting and brighter at the turn, warm with a " +
    "smile and a small laugh at the joy, soft and sure at the close. Real breaths between thoughts, words leaned on where they " +
    "matter, never one tone for the whole film, never flat, never an announcer, never read like a list.",
  text:
    "No words on screen except the cards given: clean white sans-serif in capitals with a soft shadow, in the upper third, " +
    "popping in whole and gone before the next shot.",
  sound:
    "A soft, warm piano and strings score from the first frame to the last, low under the voice, lifting at the turn and again " +
    "at the payoff, resolving on the last shot. Small real sounds under the people (a station's hum, a door, a child's laugh). " +
    "Never silence.",
  moves: {
    property: ["glide", "rise", "push-in", "push", "drift", "pull", "crane", "follow", "track", "ease", "dolly"],
    forbidden: ["whip", "orbit", "spin", "zoom", "timelapse", "time-lapse", "static"],
  },
  never: [
    "Open on the building, or read the facts out as a list: the story comes first and every fact is a line of the person's life.",
    "Put a place in the film only because it is in the library. A lobby, a rooftop, a pool or a clubhouse appears only when " +
      "the story needs that place at that moment; a shot that jumps to another place or another time of day to show one more " +
      "picture breaks the story. Leaving pictures out is right.",
    "Say or show that anybody bought, booked or lives here, a testimonial, a review, or a named buyer.",
    "Show an ordinary place as the project, or show another tower or housing project at all; the home is only ever an approved " +
      "picture, the rooms exactly as approved.",
    "Name the people on a card, or let anybody look into the lens or move their lips to the voice.",
    "Say the street address, or more than one price, or a place name twice.",
    "Tell the story about \"him\" or \"her\": the voice is the main character's own, and a man's story is never told in a " +
      "woman's voice.",
    "Hold the building on screen for more than about three seconds, or with nothing happening.",
    "Write a line in Hindi or in Devanagari: the whole film is in English.",
  ],
  styleFrames: [],
  needs: null,
  inside: true,
  ordinaryPlaces: true,
  // The skill's text is "clean white"; a pink style card made the model set
  // the first film's card pink, and the checks then called it a stray.
  cardAccent: "#ffffff",
  example: [
    "1 people, an ordinary place (picture -1): dusk in a glass office, city lights coming on behind him, the father shuts his " +
      "laptop and smiles at a crayon drawing of three stick figures pinned by his screen, a slow handheld push-in. Says, quiet and a " +
      "little tired, almost to himself: \"I love my work. But evenings are my favourite part.\"",
    "2 people, an ordinary place (picture -1): evening, he walks briskly out of a busy suburban railway station with the crowd, " +
      "glancing at his watch and smiling, the camera following. Says, lifting, hopeful, a smile coming into it: \"Eight minutes from " +
      "Goregaon station, and I'm home.\"",
    "3 property, the tower elevation: a sweeping rise up the facade in the evening light, leaves swaying in the foreground, " +
      "clouds drifting, warm windows coming on one by one, the camera moving to the last frame, the music lifting.",
    "4 people, the sample flat living room: he steps in and puts his bag down, looks around playing along, a small giggle from " +
      "behind the curtain, a slow push-in. Says, playful, dropping to a whisper: \"Somebody here is hiding from me.\"",
    "5 people, the sample flat living room: he pulls the curtain back, his daughter squeals and he swings her onto his " +
      "shoulders, both laughing, the mother smiling from the sofa, handheld and close.",
    "6 people, the balcony: the same dusk, the girl still on his shoulders as they step out to the railing, the sea glowing " +
      "below, a slow glide out from the room behind them. Says, warm and bright: \"Sea facing, from the eighteenth floor up.\"",
    "7 people, the balcony: the three of them at the railing as silhouettes against a warm sky, a slow push-in from inside " +
      "the room. Says, easy and clear: \"1 BHK homes from ₹1.45 Cr.\" Text: \"1 BHK / ₹1.45 CR\".",
    "8 property, the tower elevation: wide at dusk, lights coming on across the facade, a steady pull back that keeps moving to " +
      "the last frame, the music resolving. Says, soft and sure: \"Come home a little sooner.\"",
  ].join("\n"),
};

/**
 * The narrated story in English (9 October 2026), from seventeen story films
 * by Lodha, Godrej, Mahindra Lifespaces, Prestige, Kalpataru, Hiranandani and
 * Piramal, transcribed word for word and cut by cut
 * (`doc/story-scripting-research.md`). The client found the first directed
 * English story weak: a plot about a father ringing a bell, a narrator
 * describing what was on screen, the price said aloud. None of the real films
 * does any of that. Each is one feeling carried by one ordinary moment, told
 * in six to nine short lines (35 to 50 words, about 1.6 a second), the words
 * naming the value while the picture shows the instance ("the gift of health"
 * over a tennis court), the project named once at the end, and no price in
 * the story: it is on the end card.
 */
function englishStory(skill: VideoSkill): VideoSkill {
  return {
    ...skill,
    format:
      "a short English film about one feeling, carried by one ordinary moment of a family's day, told by one warm voice in six " +
      "to nine short lines, the home answering the feeling in its approved places, and the opening line coming back at the close",
    scenes: { min: 8, max: 11 },
    words: { min: 35, max: 50 },
    lineWords: 9,
    wordsPerSecond: 1.9,
    beats: [
      "One feeling a viewer already has, shown through one ordinary moment, never a plot: coming home before the bedtime " +
        "story, a slow Sunday, a child's first ride, a grandparent's evening walk, a quiet cup of tea on the balcony. Pick it " +
        "from the strongest approved fact (a station close by is evenings at home; a view is the light every evening; greens are " +
        "room to grow up slowly). The real films call it \"not life-changing events but everyday things that are magical\".",
      "Thirty seconds in five beats. The moment (0 to 6 s): the main character in an ordinary place away from the project, " +
        "one or two lines naming the want or the worry. The turn (6 to 9 s): the exterior, one line that points to the home. " +
        "The home answers (9 to 21 s): three or four shots in the approved places, one line each that names the feeling, never " +
        "the facility. The payoff (21 to 26 s): the want met, a quiet beat, the line that names the feeling and brings back a " +
        "word of the opening line. The close (26 to 30 s): the exterior wide and calm, the project's name said once with its " +
        "locality; the price card goes over this shot.",
      "How the lines are written: six to nine lines, four to eight words each, 35 to 50 words in all, in the main character's " +
        "own voice (\"I\", \"my\", or \"we\" for the family), present tense or simple past, never a running commentary. One or " +
        "two shots carry no line at all: the music and the faces carry them. No question and no exclamation: a wondering is " +
        "written as a quiet statement (\"I kept wondering what could say it\"). \"You\" only in the last two lines, if at all.",
      "The words never describe the picture. They name the value while the picture shows the instance: \"a walk with nowhere " +
        "to be\" over the garden, \"his laugh, before I see him\" over the pool, \"a little quiet, for me\" over the balcony. " +
        "Never \"I open the door\", \"we sit on the sofa\", \"the tower rises\": the camera already shows it.",
      "No price, size, configuration or sales words in the story: no rupees, crore, lakh, BHK, square feet, book, buy, offer, " +
        "visit, invest, luxury, premium, amenities. The price is a card laid over the close by us. At most one approved fact " +
        "said in human terms (\"eight minutes from the station\"), and the project's name once, in the last two lines.",
      "A line or a word comes back: the last line echoes the first (\"All day, I count the hours to evening.\" ... \"I don't " +
        "count the hours any more.\"), or one line shape repeats over the middle shots like a refrain.",
      // Every story film so far got a door wrong, and the line "I ring once" asked for a bell the picture could not show (9 October 2026).
      "Video models get some moments wrong every time, so the story never needs them, in a shot or in a line: a door opened or " +
        "rung at, a screen or a phone showing a picture, a mirror, something handed from one person to another, writing or " +
        "reading. Coming home is shown already inside: a bag set down, a child running across the room to him. One person does " +
        "one thing in a shot. An object close-up (a cup of tea, a ribbon, a small hand in a big one) and a silhouette at the " +
        "window are what these films lean on, and a video model makes them well.",
      "One place is one picture: every shot in the flat's living room names the living room picture, the balcony always the " +
        "same picture, and an amenity appears only when the story goes there. A view the pictures do not show (the sea, a " +
        "skyline) is said over the people at the window or on the balcony, the view behind them soft and out of focus.",
    ],
    voice:
      "One warm Indian voice-over artist in clear Indian English, the story's main character, speaking slowly and softly close " +
      "to the microphone, the way a brand film is narrated: real pauses between lines, every word clear, the feeling in the " +
      "voice, never an announcer, never fast.",
    never: [
      ...skill.never.filter((n) => !/hiding/i.test(n)),
      "Write a question, an exclamation, a conversation, or a line spoken to somebody in the film.",
      "Write a line that describes what the shot shows, or narrates an action as it happens.",
      "Say a price, a size, a configuration, a specification or a sales word in a line: the price is on the card.",
      "Write a game, a surprise, a joke, hiding, searching or a gag: a video model cannot act it, and it breaks the scene.",
      "Write a line longer than nine words, or more than one fact in a line.",
      "Reuse the example's lines or its refrain: write this project's own feeling, in your own words, from its own strongest fact.",
    ],
    example: [
      "1 people, an ordinary place (picture -1): dusk in a glass office, the father at his desk, his closed laptop facing him, " +
        "his eyes on a crayon drawing of three stick figures pinned on the wall beside him, a slow handheld push-in. Says, quiet, " +
        "a little tired: \"All day, I count the hours to evening.\"",
      "2 people, an ordinary place (picture -1): he walks with the evening crowd along a busy suburban station platform, the " +
        "camera following. Says, lifting: \"Eight minutes from the station,\"",
      "3 property, the tower elevation: a sweeping rise up the facade at dusk, leaves swaying in front, windows lighting up one " +
        "by one. Says, softly, letting go: \"and the day lets go of me.\"",
      "4 people, the sample flat living room: he is just home, setting his bag down by the sofa, and his daughter runs across " +
        "the room into his arms, handheld and close.",
      "5 people, the sample flat living room: close on her small hand holding his big one, the mother smiling soft behind them. " +
        "Says, warm: \"Here, evenings belong to us again.\"",
      "6 people, the balcony: the three of them at the railing as dusk falls, the view behind them soft, glowing and out of " +
        "focus, a slow push-in from the room. Says, warm, a little wonder in it: \"The sea, every evening, from up here.\"",
      "7 people, the sample flat bedroom: she has fallen asleep against his shoulder on the bed, the lamp warm beside them, a " +
        "slow push-in. Says, softly, smiling: \"I don't count the hours any more.\"",
      "8 property, the tower elevation: wide at dusk, lights coming on across the facade, a steady pull back that keeps moving " +
        "to the last frame, the music resolving. Says, soft and sure: \"Sath Heights. Goregaon West.\" Text: \"1 BHK / ₹1.45 CR\".",
    ].join("\n"),
  };
}

/** The narrated story as made in English: the trade's own way of telling one (`englishStory()`). */
export const NARRATED_STORY_SKILL: VideoSkill = englishStory(NARRATED_STORY_BASE);

/** Every template's skill but Agent on camera's, in the order of the template folders. */
export const TEMPLATE_SKILLS: readonly VideoSkill[] = [
  NARRATED_STORY_SKILL,
  LAUNCH_FILM_SKILL,


  CONSTRUCTION_UPDATE_SKILL,




  LOCALITY_SKILL,
  LAND_TO_HOME_SKILL,
  DUST_REVEAL_SKILL,
  PLOT_FROM_THE_AIR_SKILL,
  SLOW_TOUR_SKILL,
  CONSTRUCTION_PROGRESS_SKILL,
];

/**
 * The narrated story in Hindi or Marathi (8 October 2026), written from twelve
 * Hindi and Marathi real-estate films (Mahindra Lifespaces' "Har Kone Me
 * Karigari", Housing.com's "Yeh Ghar Meri Jaan Hai", L&T Realty's Diwali
 * film, Adiraj Properties' Ganpati film, Kolte-Patil Stargaze, Apla Ghar,
 * Paranjape Athashri, Lodha, Godrej and others; `doc/story-research.md`).
 * None of them tells a plot in dialogue. One voice says a few short lines,
 * like verse, with a breath between their halves, over a montage of small
 * moments, a line coming back at the close; 0.9 to 1.5 words a second where
 * the English story says 2.5. The English story's example (a game of
 * hide-and-seek, "somebody here is hiding from me") was copied into the first
 * Hindi film as "आ गई मेरी छोटी परी", which no video model can act.
 */
export function storyIn(skill: VideoSkill, lang: { code: "en" | "hi" | "mr"; name: string }): VideoSkill {
  if (skill.key !== "story" || lang.code === "en") return skill;
  const hi = lang.code === "hi";
  const tongue = hi ? "Hindi" : "Marathi";
  return {
    ...skill,
    format:
      `a short ${tongue} film about one feeling, told by one warm voice in a few short lines like verse over a montage of ` +
      "small, real moments of a family's evening, the home answering the feeling with its approved facts, and the opening " +
      "line coming back at the close",
    // Fewer shots than the English story: each line is said slowly, with a breath.
    scenes: { min: 7, max: 9 },
    words: { min: 22, max: 40 },
    lineWords: 8,
    wordsPerSecond: 1.6,
    beats: [
      `How ${tongue} property films are told: one voice, a few short lines, never a conversation. A line is three to seven ` +
        "words, often split across two shots with a breath between its halves (\"दिन भर की भाग-दौड़...\" then \"...और मन में " +
        "बस एक घर।\"). Say less: three or four of the shots carry no line at all, and the music and the faces carry them.",
      "One feeling, not a plot: coming home in time, a festival in the new home, a child's room of their own, the evening " +
        "light. The film is a montage of that feeling, each shot ONE simple moment a real camera could catch without acting " +
        "(a hand on a door, a hug, a smile, a lamp lit, a child running in, a family at the window). Never a game, a surprise, " +
        "a joke, a trick, hiding, searching or anything that needs actors to perform it.",
      // Every film so far got a door wrong (a father opening his own front door
      // after ringing, a door opening onto a bedroom) and the first full Hindi
      // film's laptop faced away from him (8 October 2026).
      // The first full Hindi film's family silhouette went from the flat's balcony to the clubhouse: its scene named the clubhouse picture.
      "One place is one picture: every shot in the flat's living room names the living room picture, every shot on its balcony " +
        "the same picture, and an amenity (a clubhouse, a pool) appears only when the story goes there, never as the family's " +
        "own balcony or room.",
      "Video models get some moments wrong every time, so the story never needs them: a door being opened or rung at, a " +
        "screen or a phone showing a picture, a mirror, an object handed from one person to another, writing or reading. " +
        "Coming home is shown already inside the home (a bag set down, a child running across the room to him), never at " +
        "the door. A drawing or a photograph is on a wall or a desk, never on a screen.",
      "The voice never speaks to anybody in the film: no names, no calling out, no \"अरे\", no \"आ गई\", no question to a " +
        "child, no exclamation. It is the main character thinking aloud, in the first person or about the home, softly.",
      "The opening line names the feeling over the ordinary moment away from the project (an office at dusk, a crowded " +
        "station); the home answers it with the strongest approved fact said as part of the feeling (\"स्टेशन से बस 8 मिनट दूर,\" " +
        "then \"जहाँ कोई इंतज़ार करता है।\"); one more fact at most, and the price said once, plainly, in digits.",
      "The close brings the opening's words back as the last line (\"घर, जो इंतज़ार करता है।\"), over the exterior, wide and calm.",
      // The second Hindi test film said "हर शाम समंदर साथ" over a city: no approved picture shows the sea, so the model drew a city.
      "A view the approved pictures do not show (the sea, a skyline) is said over the people at the window or on the balcony " +
        "as dusk falls, the view behind them soft, glowing and out of focus, never as a shot of the view itself.",
      "Every line is the voice's own sentence in natural spoken " + tongue + (hi ? ", the warm Hindi of a Hindi film, never " +
        "stiff or translated from English" : ", the warm Marathi of a Marathi film, never stiff or translated from English") +
        ". Write it the way it is said, not as a sentence about the home: \"हर शाम समंदर साथ\", never \"इस घर से समुद्र " +
        "दिखाई देता है\".",
    ],
    voice:
      `One warm ${tongue} voice-over artist, a man or a woman as the story's main character is, speaking slowly and softly ` +
      "close to the microphone, the way a brand film is narrated: real pauses between the halves of a line, every word clear, " +
      "the feeling in the voice, never an announcer, never fast.",
    never: [
      ...NARRATED_STORY_BASE.never.filter((n) => !/hiding|Hindi or in Devanagari/i.test(n)),
      "Write a conversation, a line spoken to somebody in the film, a name called out, a question or an exclamation.",
      "Write a game, a surprise, a joke, hiding, searching or a gag: a video model cannot act it, and it breaks the scene.",
      "Write a line longer than eight words, or more than one fact in a line.",
      // Two Sarvam drafts in a row came back as the example word for word (8 October 2026).
      "Reuse the example's lines or its refrain: write this project's own feeling, in your own words, from its own strongest fact.",
    ],
    example: (hi
      ? [
          "1 people, an ordinary place (picture -1): dusk in a glass office, the father closes his laptop and smiles at a crayon " +
            "drawing of three stick figures pinned on the wall beside his desk, a slow handheld push-in. Says, tired, softly: \"दिन भर की भाग-दौड़...\"",
          "2 people, an ordinary place (picture -1): he walks out of a busy suburban station with the evening crowd, the camera " +
            "following. Says, warm: \"...और मन में बस एक घर।\"",
          "3 property, the tower elevation: a sweeping rise up the facade at dusk, leaves swaying in front, windows lighting up. " +
            "Says, hopeful: \"स्टेशन से बस 8 मिनट दूर,\"",
          "4 people, the sample flat living room: he is just home, setting his bag down by the sofa, and his daughter runs " +
            "to him across the room. Says, softly, smiling: \"जहाँ कोई इंतज़ार करता है।\"",
          "5 people, the sample flat living room: he lifts her into a hug, the mother smiling behind, handheld and close.",
          "6 people, the balcony: the three of them at the railing as the sun goes down, the view behind them soft and out of focus, a slow push-in from the room. " +
            "Says, warm: \"18वीं मंज़िल से, हर शाम समंदर साथ।\"",
          "7 people, the balcony: the family as silhouettes against the sky. Says, calm: \"1 बीएचके, ₹1.45 करोड़ से।\" Text: " +
            "\"1 BHK / ₹1.45 CR\".",
          "8 property, the tower elevation: wide at dusk, lights coming on across the facade, a steady pull back. Says, " +
            "softly: \"घर, जो इंतज़ार करता है।\"",
        ]
      : [
          "1 people, an ordinary place (picture -1): dusk in a glass office, the father closes his laptop and smiles at a crayon " +
            "drawing of three stick figures pinned on the wall beside his desk, a slow handheld push-in. Says, tired, softly: \"दिवसभराची धावपळ...\"",
          "2 people, an ordinary place (picture -1): he walks out of a busy suburban station with the evening crowd, the camera " +
            "following. Says, warm: \"...आणि मनात फक्त एक घर.\"",
          "3 property, the tower elevation: a sweeping rise up the facade at dusk, leaves swaying in front, windows lighting up. " +
            "Says, hopeful: \"स्टेशनपासून फक्त 8 मिनिटांवर,\"",
          "4 people, the sample flat living room: he is just home, setting his bag down by the sofa, and his daughter runs " +
            "to him across the room. Says, softly, smiling: \"जिथे कुणीतरी वाट पाहतं.\"",
          "5 people, the sample flat living room: he lifts her into a hug, the mother smiling behind, handheld and close.",
          "6 people, the balcony: the three of them at the railing as the sun goes down, the view behind them soft and out of focus, a slow push-in from the room. " +
            "Says, warm: \"18व्या मजल्यावरून, रोज संध्याकाळी समुद्र सोबत.\"",
          "7 people, the balcony: the family as silhouettes against the sky. Says, calm: \"1 बीएचके, ₹1.45 कोटी पासून.\" Text: " +
            "\"1 BHK / ₹1.45 CR\".",
          "8 property, the tower elevation: wide at dusk, lights coming on across the facade, a steady pull back. Says, " +
            "softly: \"घर, जिथे कुणीतरी वाट पाहतं.\"",
        ]
    ).join("\n"),
  };
}
