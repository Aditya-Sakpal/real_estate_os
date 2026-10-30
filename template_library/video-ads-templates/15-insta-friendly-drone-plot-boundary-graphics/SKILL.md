# Skill: plot from the air, in one generation

This is what the product knows about the format and why it does not make it.
The code version is `PLOT_FROM_THE_AIR_SKILL` (pasted into
`src/lib/film-rules.ts`); its `needs` refuses the format before anything is
paid for. Change both together.

Written on 3 October 2026 from the four reels in this folder (a frame a second
for every reel, Whisper's transcript of each, and the cuts counted by scene
change), with the folder's `README.md` and `PRODUCTION-SPEC.md`. Reel 10 is a
byte-identical copy of template 13's reel 15 and was read once.

## What the reels do

| | 01 jayupfilms | 05 plot-view-media | 09 real-estate-videographer | 10 river-edge |
| --- | --- | --- | --- | --- |
| Length | 12 s | 56 s | 26 s | 32 s |
| Cuts | 0 | about 7 real (11 with flash frames) | 10 | 3 (one a single frame) |
| Average shot | 12 s, one shot | about 8 s | 2.3 s | about 11 s |
| Words spoken | 0 (a song) | about 118, English | about 70, Hindi | 0 |
| Presenter | no | no | no | no |
| Voice-over | no | yes | yes | no |
| Music | yes | yes, under the voice | yes, under the voice | yes |
| Text cards | 1 ("10.000m²") | about 10 (area, locality, "FOR SALE", road and school distances, uses, phone) | about 10 (road, distances, two areas, "Price Details", "Call") plus running captions | 1 ("1500 M²") |

- **Real drone footage of real land.** Forest on a hillside (01), a plot in a
  Bengaluru suburb (05), farmland outside Raipur (09), a scrub plot (10). The
  land is the product, and the footage is the proof that it exists.
- **The hook is the land and its size.** A slow drone drift or a top-down
  hover, then the boundary drawing itself on in a glowing yellow or cyan line,
  and the area landing in big 3D type ("10.000m²", "20000 Sqft", "1.5 Acre").
  The line traces on rather than appearing; that motion is what holds the eye.
- **The middle is where it is.** 05 and 09 draw the main road as a thick
  highlighted band, drop a pin "Property Location", draw a dashed line with
  "200 M" to the road and "500 M" to a named school, and stamp the locality.
  05 also grows AI buildings on the plot to show what could be built
  ("Office", "College", "Apartment"); 01 turns the boundary into a glowing
  house plan and grows a house with a pool.
- **The close is the number to call**, or "iski Price Details, Call" with the
  price withheld on purpose, so the comments fill with "price?".
- **Camera**: top-down at 90 degrees for the boundary, a slow rise or drift for
  context, a low orbit to close. Slow and steady throughout.
- **Text**: heavy, plenty of it, yellow on dark, distances and areas as the
  main graphic. Every number is on screen.
- **Sound**: music, and a calm narrator in 05 and 09.
- **Colour**: bright daylight, natural greens and earth, the yellow line the
  only saturated thing in frame.
- **What makes it work**: the outline is true. The spec spends its first part
  on getting the survey corners marked on the ground before the flight,
  because a boundary that does not match the land loses the sale and the
  buyer's trust.

## Verdict

**DO NOT MAKE.** Four reasons, any one of which is enough.

1. **We hold no aerial picture of any real site.** The approved library has
   renders, amenities, the lobby, sample flats and construction photos taken
   on the ground. A generated drone view of "the land" is an invented site,
   which is the one thing the product may not put on an advertisement.
2. **The boundary would be drawn by the video model, unchecked.** Nothing in
   the product holds the survey's corner points, and a model draws a line
   wherever it likes. A boundary that takes in a neighbour's land, or leaves
   out the project's own, is a false statement about what is being sold.
3. **An aerial render is no substitute.** Tracing a boundary round a
   bird's-eye render claims a land extent an artist drew, with the same
   unchecked line on top.
4. **Its numbers would be drawn by the model.** The area and every distance
   are cards the model sets, where a misspelt digit is a false claim, and
   `isFactCard()` catches a price or a configuration, not an area or a
   distance.

The format also sells plots, where the land is the purchase. The developers
this product serves sell flats in towers; a 2 BHK buyer is not buying the
twelve acres.

**What would make it possible**, as its own build rather than one Seedance
call: an approved aerial photograph of the real site (a dated top-down drone
photograph, today filed only as a CONSTRUCTION photo); the boundary drawn by
us from the survey's corner points after the film, the way the price card is
set; and the land area and every distance as signed facts, set by us. Until
then `needs` carries no category, so code refuses the template and says why.

## What the product would do with it

Kept so the format is ready the day the three things above exist.

**15 seconds, 4 to 6 scenes, 2 to 4 seconds each, a voice-over of 12 to 26
words, 1 to 3 cards.** The reel that is only the land (01) runs 12 seconds;
the ones that add roads and schools run 26 to 56 and repeat themselves.

1. **The hook.** A slow drone rise from low over the trees to high above the
   site, the narrator saying the size and the place once ("This is what twelve
   acres in Powai looks like.").
2. **The land, then the line.** Top-down, gimbal straight down, half a second
   of plain land; then the boundary traces on clockwise from the corner nearest
   the road, a soft fill behind it, and the area card (ours).
3. **One connection.** The camera tilts up and drifts toward the main road, a
   line tracing along a road that is in the picture.
4. **The price**, said once; the price card is ours.
5. **The close.** A slow rise away, the action said and on a card.

Nobody on screen. The moves: drone, top-down, hover, rise, tilt, drift, a
slow orbit; nothing fast, no FPV dives or whips. Forbidden: a site the
approved picture does not show, a boundary the developer did not survey, a
road, station or school marked that is not in the picture, buildings grown on
the land, "FOR SALE" or other plot language, and any number drawn by the
model.
