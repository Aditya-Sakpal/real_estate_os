# Skill: cinematic slow tour, in one generation

This is what the product knows about the format and how it writes one film in a
single Seedance 2.5 call. The code version is `SLOW_TOUR_SKILL` (pasted into
`src/lib/film-rules.ts`); change both together.

Written on 3 October 2026 from the six reels in this folder (a frame a second
for every reel, Whisper's transcript of each, and the cuts counted by scene
change), with the folder's `README.md` and `PRODUCTION-SPEC.md`.

On 5 October 2026 reels 02, 06 and 08 were taken out of the folder at the
client’s asking. What follows was read off every reel the folder held then;
only the ones left are shown in the studio.

## What the reels do

| | 01 shotbybrendan | 02 brendan-dsouza | 03 flashoot | 06 payperjump | 07 rakesh-shirke | 08 marketincrew |
| --- | --- | --- | --- | --- | --- | --- |
| Length | 20 s | 12 s | 39 s | 25 s | 15 s | 19 s |
| Cuts | 4 hard, about 9 shots counting swipe transitions | 1 (day to dusk and back) | 25 | 20, many inside split-screen collages | 20 | 42 with flash frames |
| Average shot | about 2 s | 4 to 6 s, one slow push | 1.5 s | about 1.2 s | 0.75 s | about 0.5 s |
| Words spoken | 0 (a hummed track) | 0 (a song) | 0 | 0 (a song) | 0 | 0 (a song) |
| Presenter | no | no | no | no | no | no |
| Voice-over | no | no | no | no | no | no |
| Music | yes | yes | yes | yes | yes | yes |
| Text cards | 9 (a "move your thumb to the beat" hook, seven room labels, an end logo) | 1 line held throughout ("I can't believe this is Mumbai...") | 0, a watermark | 1 title ("Behind the scene") | 1 title ("Let's go behind the scenes") | 1 caption ("POV: 10 property drone shoot...") plus three place names |

- **Three kinds of reel share the folder.** Only 02 is the slow tour the folder
  is named for: one slow push past a man standing at a window, ending on the
  view, one line of text, a song. 01 and 03 are interior tours of finished
  flats, but cut fast: 01 swipes room to room on the beat with a label on
  each room, 03 is an interior designer's handover reel ending on the owners'
  family group. 06, 07 and 08 are videographers' behind-the-scenes reels (the
  drone, the crew, a model in a gown, a laptop retouching) and teach nothing
  about touring a home.
- **So the format comes from 02 and the spec**: seven to nine shots of three to
  four seconds, each one uninterrupted move with no change of direction, cut
  on the move so separate shots read as one walk.
- **The hook is the move itself.** 02 opens already moving toward the window;
  there is no headline. 01's "move your thumb" device belongs to a beat-swipe
  edit, not to this one.
- **Middle**: the living space with something passing close to the lens for
  depth, one shot about light rather than a room, a close detail (a handle, a
  tap, a counter edge), the bedroom toward its window.
- **Close**: a near-still hold where the one line of text sits.
- **Camera**: gimbal at walking height, slow push-ins, lateral slides, dolly
  along a counter. No whips, speed ramps or snap zooms; the spec says those
  undo everything the format buys.
- **Pacing**: slower than feels right. 02 holds one move for its whole length.
- **Text**: one line, thin, widely spaced, small, in the upper third, held.
- **Sound**: one piece of music with a slow build and no percussion hits, no
  voice, ending on the last frame rather than fading.
- **Colour and grade**: golden or warm window light, shadows lifted soft,
  highlights pulled down and warm, greens desaturated, a 24 fps film feel with
  natural motion blur.
- **What makes it work**: restraint. No price, no hard sell; it wins on saves
  because a premium buyer decides on feel first and asks the price after.

## Verdict

**Rewritten 6 October 2026.** The first verdict was read off reel 02 (one slow
push, one line, no room names). The client took 02, 06 and 08 out of the
folder, and the three left (01, 03, 07) cut room to room on the beat, name
each room, linger on details and close on the building at dusk. The format is
now theirs:

**MAKE WITH** at least three approved interior pictures (SAMPLE_FLAT, LOBBY or
AMENITY) and one approved exterior render, checked before paying.

Still refused: walking from one room into another (that shows the floor plan;
rooms are joined by a cut or a swipe on the beat), a view through a window the
picture does not show, a room name its picture's title does not give, a face
or a family posed as owners, crew or "behind the scenes" captions, and a price.

## What the product does with it

**20 seconds, 8 to 10 shots of 1.5 to 3 seconds, nobody speaks, 3 to 8
cards.** `SLOW_TOUR_SKILL` in `src/lib/video-skills.ts`, labelled
"Cinematic tour"; change both together. The prompt as the product sends it,
for Tower C, is in `doc/cinematic-tour-prompt.md`.

1. **The hook, about 3 s**: high above the approved exterior, a slow rise,
   clouds moving, "STEP INSIDE".
2. **The rooms, about 2 s each, four to six**: a smooth gimbal glide or slow
   push-in through each approved room, every lamp on, its name popping in big
   (taken from the picture's title), a cut or swipe on the beat to the next.
3. **The detail, about 1.5 s**: close and slow on something a picture shows.
4. **The moment, about 2.5 s**: one person from behind or in silhouette at a
   balcony or amenity railing at golden hour. Never a face.
5. **The close, about 3 s**: the exterior at dusk, windows glowing, a slow
   pull back; the project's name is our card, set afterwards.

Sound: one warm, modern track with a clear beat each cut lands on, a soft
whoosh on each swipe, no voice.
