# Skill: land to home, in one generation

This is what the product knows about the format and how it writes one film in a
single Seedance 2.5 call. The code version is `LAND_TO_HOME_SKILL` (pasted into
`src/lib/film-rules.ts`); change both together.

Written on 3 October 2026 from the seven reels in this folder (a frame a second
for every reel, Whisper's transcript of each, and the cuts counted by scene
change), with the folder's `README.md` and `PRODUCTION-SPEC.md`.

On 5 October 2026 reels 10 (maksh), 11 (maruti) and 16 (bhagchand) were taken
out of the folder at the client's asking. The table keeps them, because the
skill was read off all seven; only the four left are shown in the studio.

## What the reels do

| | 01 brad-ziemer | 02 plot2homeindia | 04 buildscape | 10 maksh | 11 maruti | 15 river-edge | 16 bhagchand |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Length | 27 s | 60 s | 56 s | 17 s | 32 s | 32 s | 56 s |
| Cuts | 0 | 0 | 0 | 2 | 5 | 3 (one a single frame) | 0 |
| Average shot | 27 s, one shot | 60 s, one shot | 56 s, one shot | 5.7 s (14 s transformation, then the logo card) | 5.4 s | about 11 s | 56 s, one shot |
| Words spoken | 0 | 0 (a Hindi song) | 0 | 0 | about 80, Hindi | 0 | 0 (a Haryanvi song) |
| Presenter | no | no | no | no | no | no | no |
| Voice-over | no | no | no | no | yes | no | no |
| Music | yes | yes | yes | yes | yes, under the voice | yes | yes |
| Text cards | 1, at the very end ("Comment Prompt") | 0, a watermark | 0, a "Veo" watermark | 1 end card (logo, phone, site) | 0 | 1 ("1500 M²" on a glowing boundary) | 0 |

- **One camera that does not move.** Four of the seven are a single unbroken
  shot from drone height, the frame locked from the first second to the last.
  The world changes; the camera does not. That stillness is what makes the
  change readable: the same trees, the same road, the same neighbour's wall in
  every frame, and only the building is new.
- **The hook is the empty ground itself**, held for one to three seconds:
  forest, a field, a dirt plot with chalk lines and a group of men standing on
  it. No words. The viewer already knows what is coming and stays to watch it
  happen.
- **The middle is construction, sped up.** Clearing, digging, columns, brick
  walls, slabs, plaster, paint, glazing, landscaping, with workers swarming and
  trucks coming and going, and day and night cycling in the sky (01, 15). Two
  reels skip the realism: Maksh grows a glowing cyan wireframe from footprint
  lines, the floors float in as grey shells and then take their finished
  facade; Maruti cuts from a top-down empty plot straight to the finished
  elevation with workers on it.
- **The close is the finished home at golden hour or dusk, lights on**, held
  for three to ten seconds, often with a car or a family arriving (02, 16).
  That lit frame is the one people screenshot.
- **Pacing**: slow and even. Nothing is cut to the beat; the change is paced by
  the stages. The reels run 27 to 60 seconds only because they show every
  stage of construction.
- **Text**: almost none. The caption carries the specs; at most one line at the
  end or an area figure on the opening ground.
- **Sound**: a song or a slow-building track, nothing else. Only Maruti talks,
  a Hindi voice-over over the finished elevation's detail shots.
- **Colour**: bright natural daylight, crisp, gently saturated, then a warm
  golden or blue-hour end.
- **What makes it work**: one fixed viewpoint, and a believable ground under
  the building. The spec's whole craft section is about the before and after
  matching in camera height, lens and shadows.

## Verdict

**MAKE, the way the reels do it** (rewritten 6 October 2026, after watching the
four reels left in the folder again). The first verdict refused every
construction stage and grew the tower out of glowing lines; that is not this
format, and the same choice on the building assembly was judged pathetic. The
build itself is the format, so it is shown, as an artist's impression:

1. **The finished building is exactly the approved render**, held at the end,
   at golden hour. The camera sits at the render's own viewpoint, raised to a
   drone's height, and never moves until a slow push-in in the last seconds.
2. **It is never presented as a record of the site.** No date, month, year,
   "today", "now", "progress", "possession", "this plot", "our site" or "here",
   on a card or anywhere. No worker's face up close, no company name or logo on
   a vest, no signboard. Our small print carries "Artist's impression" on every
   frame.

## What the product does with it

**20 seconds, 6 to 8 moments of one locked take, 2 to 4 seconds each, nobody
speaking, 1 to 2 cards.** `LAND_TO_HOME_SKILL` in `src/lib/video-skills.ts`;
change both together. The prompt as the product sends it, for Tower C, is in
`doc/land-to-home-prompt.md`.

1. **The plot, about 2 s**: the render's own setting, the plot empty levelled
   earth, glowing lines tracing the footprint. The hook card ("FROM LAND TO
   HOME", "WATCH IT RISE"; never "plot" on a card, the model misspells it).
2. **The groundwork, about 3 s**: a small crew walks the lines, an excavator
   digs, a mixer truck comes and goes.
3. **The structure, about 4 s**: foundations, columns and slabs climb level by
   level to the building's own height and shape, scaffolding, a crane for a
   tower, brick walls, one quick night under floodlights.
4. **The skin, about 4 s**: plaster, then the building's own facade, glass and
   rails sweep up from the bottom, the scaffolding comes down.
5. **The finish, about 3 s**: the site cleared, landscaping rolls out, the light
   turns golden, the building stands exactly as approved, windows glowing.
6. **The close, about 2 s**: held at golden hour, a slow push-in, the price card
   (ours) or the action.

Sound: a slow-building track with the sped-up sounds of the site under it,
fading as it finishes, a soft hit when it stands. The checks (`builds`): the
eye judges the building only in the last two moments, and the sweep reads the
crew, the machines, the scaffolding and the half-built frame as the film's own.
