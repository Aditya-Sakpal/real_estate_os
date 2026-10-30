# Skill: locality guide, in one generation

This is what the product knows about the location film and how it writes one
in a single Seedance 2.5 call. The code version is `LOCALITY_SKILL` in
`src/lib/video-skills.ts`; change both together.

Rewritten on 12 October 2026, after the client called the presenter
explainer it replaced ("is this area worth it? let me break it down")
"pretty shit". Of the first three location films found, the client chose
the narrated one, Godrej City Panvel's, because its narrator teaches the
buyer the area; the other two references were then replaced by narrated
location films too.

## How they were found

Searched on YouTube for the location and connectivity films of Lodha,
Godrej, Oberoi, Prestige, Sobha, DLF, M3M, Piramal, Birla Estates,
Hiranandani, Kalpataru, Rustomjee, Mahindra, Brigade, Runwal, Joyville and
Tata Housing, and transcribed the first minute of each with ElevenLabs
Scribe to tell a narrated film from one of music and labels.

Godrej Properties makes a "Location AV" for almost every project, and its
are the most watched (Godrej Horizon, Wadala, 13 lakh; Godrej Riviera,
Kalyan, 3 lakh; Godrej Tropical Isle, Noida, 1.7 lakh; Godrej Skyshore,
Versova, 1 lakh). Almost all of them are music and labels with no voice.
The narrated ones are fewer:

| Film | Views | Length | Words |
| --- | --- | --- | --- |
| Green Terraces, Godrej City Panvel, Location AV | 2.64 lakh | 220 s | 417 |
| Godrej Riverine, Sector 44, Noida, Location AV | 58,000 | 212 s | 383 |
| Birla Navya, Gurugram, location film | 1,400 | 172 s | 286 |

Hiranandani Fortune City's airport film (92,000) is narrated too, but by
the founder on camera, which is a presenter; Godrej Varanya's and Runwal's
narrated films are brand films that only touch the location.

## The three references

In this folder, at 540p, each beside its poster:

- `01-godrej-city-panvel-location` (220 s, 39 cuts): the region's big
  picture ("A beacon of connectivity, innovation and opportunity"), then
  each piece of infrastructure with what it does for the buyer and a time
  label ("30 Minutes, time reduced between Panvel and South Mumbai"), over
  aerials and maps with routes drawn in; then life (schools, offices,
  hospitals, shopping); then the township and its line.
- `02-godrej-riverine-noida-location` (212 s): road, metro and both
  airports first, then a guided drive to the site past named landmarks
  ("Turn left from Mahamaya Flyover onto Noida Golf Course Road"), then
  "what is around" by kind (work, healthcare, schools, leisure) with
  picture tags and distances on a 3D map, and the close: "Noida's finest
  address, Godrej Riverine."
- `03-birla-navya-gurugram-location` (172 s): the city's story ("From an
  agricultural land to over two hundred Fortune 500 companies"), the route
  in on a 3D map ("Continue towards Sikanderpur underpass"), the metro,
  then rings "within the radius of 4 km / 5 km / 6 km" with schools,
  hospitals, offices and malls pinned, and the project's name.

## The grammar they share

1. **A narrator nobody sees teaches the buyer the area**, almost without a
   break: about two words a second over the whole film, plain sentences,
   calm and sure, the way a documentary explains a place.
2. **Big picture first**: the region or the city in one or two lines.
3. **The project pinned** on an aerial or a map.
4. **The connections, one by one** (road, rail, metro, airport), each said
   with what it does for the buyer and labelled with its time or distance,
   the route drawn on the map as it is said.
5. **Life around it by kind**: work, schools, hospitals, shopping, leisure,
   each with a distance, often as rings round the project.
6. **A close on the project's name.** No presenter, no price, no call to act.

## What the product does

**Since 18 October 2026 she walks the neighbourhood** (the client, after
the Tower C film: "she is not appearing in any of the places we are
showcasing"). She opens at the project, then is seen AT each nearby place
that has its own approved photo: on its footpath, forecourt or entrance in
front of it, the place behind her exactly as the photo shows it, pointing
back at it as she says its time from home. A place with no photo is said by
her at the project and never shown. At most one place is a push-in on its
photo with her voice over it, for pace. Then the building from the air,
and she closes back at the project. After the film is made, each place
scene is checked for whether the place is really in it (`checkPlaces()`),
and one that is missing has its approved photo laid in by us while she says
it (`layPlacePhotos()`): on the first Tower C film Seedance skipped the
station shot entirely.

**Since 15 October 2026 this is an agent on camera, with no map** (the
client, after the narrated map film: wrong routes, a voice that came and
went, too much crammed in). One high-energy presenter at the project names
each place with its exact time, cut with the place's own approved photo
where there is one; a place with no photo is said by her on camera. Cards
are ours. The narrated films below are kept as the study of the area's
grammar; the presenter's look and energy follow template 17's reels. What
follows about the map and the narrator describes the version it replaced.

- **The route to each place is shown on the map** (15 October 2026). The map
  read finds where each place sits; a scene that says one place opens on the
  whole map, moves until the project and the place fill the frame, draws the
  route from the project to the place and pulses the place. On a map scene
  that is the whole scene; on a scene filmed on the place's photo or the
  building it is the first second and a half. All of it is drawn by us.
- **One place to a scene, and a place with a photo is filmed on its photo.**
  A draft that puts two places in a scene, or says a place over anything
  but its own photo, goes back to the writer.
- **The close pulls back from the tower.** A last scene that is not a pull
  back or a rise goes back to the writer.
- **A place's name is said whole**: "Mindspace, Malad" is written "Mindspace
  Malad", and a narration take heard with a pause inside a name is not kept.
- A 30-second film, nine to eleven shots of two to four seconds, in 9:16 or
  16:9.
- A narrator nobody sees (Amit), 50 to 72 words in plain sentences of up to
  eleven words, over almost every shot, with our own composed music and
  background sound (`film-sound.ts`).
- The setting from the air on the approved exterior with the locality named
  once, then the developer's own approved location map, shown exactly as
  approved and pushed slowly toward the project. We set the map shots on
  the film ourselves (`film-map.ts`): the video model redrew the first one
  ("Goregaon slation", and times that changed between two shots).
- At least three signed nearby places, one to a beat, each said with its
  own time and what it does for the buyer ("Five minutes to the station for
  a quick ride in.") and carded by us exactly as signed ("8 MIN / GOREGAON
  STATION"). A place with an approved photo of its own (a Nearby place
  picture) is filmed on it; the rest are said over the map or the building.
- One or two shots of the home at most, then a quiet close at golden hour.
- "Travel times as per ..." in the small print, from the Brain's "How the
  travel times were measured".
- Directed, checked, fixed scene by scene and stamped like every other film.

## What it needs from the client

Checked before anything is paid for (13 October 2026, `locality-rules.ts`):

- **The location map**, the developer's own, uploaded and approved. Whatever
  it prints is a claim: its heading must be the signed locality, and every
  place it prints with a time must be a signed nearby place with that time.
  A model reads the map and code compares; a mismatch refuses the film and
  says which line to fix.
- **Three nearby places or more**, signed in the Brain, each with its time or
  distance ("Goregaon station, 8 minutes", "Inorbit Mall, 3 km by car").
- **Photos of those places** (optional, recommended): the Nearby place
  category in the project's library, each titled with its place.
- **Two pictures of the same building at least.** The building's pictures
  are grouped by building first, and pictures of another tower are left
  out of the film.
- **How the times were measured** (optional): "Google Maps, by car, 12
  October 2026".

## What it leaves out

- A place near the project with no approved photo of its own: never filmed
  or drawn. A video model's drawing of a real station is an invented
  landmark, and a line it draws to one is a route nobody checked.
- The guided drive past landmarks, and anything drawn on the map.
- Superlatives ("finest address", "best connected") and the region's
  economics (investment, SEZs, demand): only signed facts are said.
- Upcoming infrastructure, unless the developer has signed it as a fact
  worded as upcoming.
- A price, an offer or a call to act.
