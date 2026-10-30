# Skill: construction progress, in one generation

This is what the product knows about the format and how it writes one film in a
single Seedance 2.5 call. The code version is `CONSTRUCTION_PROGRESS_SKILL`;
change both together.

It was written on 3 October 2026 from the nine reels in this folder (frame
sheets at one per second, a transcript of each, and the cuts counted by scene
change).

## What the reels do

| | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Length | 43 s | 46 s | 29 s | 32 s | 30 s | 40 s | 34 s | 88 s | 24 s |
| Cuts | 68 | 68 | 22 | 36 | 16 | 11 | 10 | 11 | 44 |
| Average shot | 0.6 s | 0.7 s | 1.3 s | 0.9 s | 1.8 s | 3.3 s | 3.1 s | 7.3 s | 0.5 s |
| Words spoken | 0 | 0 | 0 | 0 (song) | 0 | about 100 | about 100, Hindi | 0 | 0 (song) |
| Presenter | no | no | no | no | no | yes, a site engineer | yes, an agency owner | no | yes, a creator with workers |
| Voice-over | no | no | no | no | no | yes | no | no | no |
| Music | cinematic beat | cinematic beat | upbeat | rap track | upbeat | under the voice | under the voice | ambient | trending song |
| Text cards | 6 | 8 | 2 | 12 | 7 | many boxes | word captions | 1 | 1 |

Counted cuts in 01, 02 and 09 include flash frames two or three frames apart,
so a real shot there runs about one second.

- **Six of the nine are the format**: a developer's own site, cut fast to music,
  nobody speaking (01, 02, 04, 05, 08, and 03, which is a finished tower and so
  not progress at all). 06 is an engineering explainer with animated diagrams,
  07 is an agency selling construction videos, 09 is a creator's selfie vlog
  with the workers. None of those three is made here.
- **The hook is the project's name over the widest view**: a drone shot of the
  site with a lockup ("SUNBEAM HEIGHTS, progress in motion", "HITECH, CRYSTAL
  CORNER"), or a "CONSTRUCTION UPDATE" card. No question, no presenter.
- **The middle is a montage of the site**: a slab being poured, rebar, block
  work, plaster, the frame with its green nets, a crane, each one to two
  seconds, cut hard on the beat, with a white flash frame or a motion-blur whip
  between some of them. Close shots and aerials alternate.
- **One short line per card, three or four words**: "BUILDING WITH PURPOSE",
  "EVERY FLOOR, A STEP CLOSER", "CIVIL AND FINISHING WORK IN PROGRESS". Bold
  sans-serif capitals, white with a shadow, centred, popping in on the beat.
  Three reels also print numbers ("57.55% CONSTRUCTION COMPLETED", "151
  FLATS", "RERA END DATE 31-12-2027", "CC DATE 20-03-2024"), and 01 labels the
  floors P1 to P5 on the building.
- **The close** is a pull back from the tower, then the developer's logo. 02,
  04 and 05 end on a rendered pool with the logo, a render tacked onto
  progress footage.
- **Camera**: drone rises, pull backs and top-down passes; on the ground, quick
  push-ins and tilts, speed ramps, punch-ins on the beat. 08 is one slow drone
  flight for 88 seconds and is the dull end of the format.
- **Grade**: punchy contrast, a little cool and desaturated, a vignette; 01
  opens in black and white. Nothing glamorised: bare concrete, nets and dust.
- **Sound**: one track, hard beats, every cut on one. No voice.
- **What makes it work**: speed and honesty at once. It looks like a trailer
  and it is plainly a real site. The one thing that carries it in the reels,
  workers caught mid-pour, is the one thing we cannot invent.

## Verdict

**MAKE WITH** at least four approved CONSTRUCTION photos of this tower, each
dated and all from the last 90 days. Code checks this before paying, and when
a skill needs exactly CONSTRUCTION it films only those fresh photos, each titled
with its month; nothing else is shown, not a render, not an amenity, not the
logo pool the reels end on.

Different from the Construction update (template 06): that one is a calm
report, five slow shots and a narrator saying what each stage is. This is the
Instagram version: no voice at all, seven to nine photos cut hard to a beat,
quick moves, and the months on screen so the film reads as progress over time.
The truth rule is the same.

## What the product does with it

**15 seconds, 6 to 9 shots of 1 to 2.5 seconds, music only.** Not the
suggested 20: every shot is a still photo given a move, nobody talks to carry
it, and 90 days of photos is usually four to eight pictures, so 20 seconds
means holding or repeating them. Fifteen keeps the reels' pace while letting
each photo read, and costs less.

1. **Open on the widest photo** (the tower or the site from the air), a quick
   punch-in on the first beat, with the project's name as the card. That card
   is set by us after the film.
2. **The photos in the order they were taken**, oldest first, so the film
   climbs honestly. One photo a shot, each a quick move on the beat. Over the
   first photo of each month, that month and year as the card ("AUGUST 2026"),
   set by us. Nothing else is said about a photo: no stage is named unless the
   card is the model's one optional "PROGRESS UPDATE".
3. **The close**, two to three seconds: the newest wide photo, a quick pull
   back to the edge of the picture, and "VISIT THE SITE", or the price card
   (ours) when the facts carry a price.

**On screen**: only the photos. Nobody is added: no presenter, no family, no
workers, no machines. A person or a crane already in a photo stays exactly as
it was caught. Only the sky, the light, dust and the safety nets move.

**Cards**: two to five, four words at most. The project's name, the months and
any price are ours (`isFactCard()`), so the model draws at most "PROGRESS
UPDATE" and "VISIT THE SITE". No percentage, flat count, floor label or date
of any filing, and never the possession date: a month on screen in this film
is the month its photos were taken.

**Moves**: punch-in, push-in, quick rise, fast drift, tilt, pan, snap, speed
ramp, pull back, a whip-pan blur or a white flash frame between two photos.
Never slow, static, orbit or FPV (each invents the side of the building the
photo does not show), and never a morph, dissolve or time-lapse: every frame
between two photos would be a stage of work that never happened.

**Forbidden**: any progress no dated photo shows (an extra floor, a slab,
glass, plaster or a facade on bare concrete, nets taken away), ending on a
render or the finished tower, animating workers pouring concrete, "on
schedule", "nearly done" or "coming soon", and calling the photos today's.
