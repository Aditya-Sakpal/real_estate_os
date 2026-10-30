# Skill: construction update, in one generation

This is what the product knows about the format and how it writes one film in a
single Seedance 2.5 call. The code version is `CONSTRUCTION_UPDATE_SKILL` in
`src/lib/film-rules.ts`; change both together.

It was written on 3 October 2026 from the five reels in this folder (frame
sheets at one per second, a timed transcript of each, and the cuts counted by
scene change).

## What the reels do

| | 01 Rishabraj portfolio | 02 Rishabraj Arham | 03 Danube site visit | 04 Weston weekly | 05 Advait |
| --- | --- | --- | --- | --- | --- |
| Length | 21 s | 20 s | 55 s | 36 s | 9 s |
| Cuts | 8 | 8 | 32 | 11 | 0 (a morph) |
| Average shot | 2.4 s, exactly | 2.7 s, then 1.4 s | 1.7 s | about 3 s | one shot |
| Words spoken | 0 | 0 | about 110 | about 63, Hindi | a few, Hindi |
| Presenter | no | no | yes, the real founder | yes, a generated engineer | no |
| Voice-over | no | no | no | no | no |
| Music | yes | yes | under the voice | yes | yes |
| Text cards | project lockup and a stage caption on every shot ("5th floor slab completed") | stage captions ("SECOND SLAB IN PROGRESS"), end card with the MahaRERA QR | word captions | one end caption | none |

- **The developers' own updates (01, 02) are captions over site footage.** One
  shot per stage, a slow drone drift or a dusk handheld walk across the slab,
  and a plain line saying what that shot shows. Cuts on the beat, about every
  two and a half seconds. No voice.
- **03 is a founder's vlog**: the real chairman walks the site with his team
  and says the work is on schedule and will be delivered before time. It works
  because he is real and on the site.
- **04 is not an update**: it is a generated engineer advertising how to make
  progress videos from the week's site photos with an AI tool. The method it
  sells is ours; the film is not a buyer's.
- **05 traces a raw structure with white lines and morphs it into the finished
  render.** Nine seconds, striking, and every in-between frame is a stage of
  work that never happened.
- **Hook**: the site from the air (01), a black-and-white frame turning to
  colour under a bold caption (02), the founder (03).
- **Close**: a project or developer card, 02's with the registration QR.
- **Camera**: slow drone drifts and overhead views, handheld walks over a slab.
- **Text**: one stage caption per shot, bottom or middle, white sans.
- **Sound**: steady modern music; site noise under it in 02.
- **Grade**: documentary and true to the day (01, 02); 02 adds a
  black-and-white to colour reveal on each caption.
- **What makes it work**: proof. A buyer paying instalments wants to see that
  the building exists and is going up, so the photos must be real and dated,
  and the caption must say only what they show.

## Verdict

**MAKE WITH** at least **three approved CONSTRUCTION photos of this tower, each
with the date it was taken (`captured_on`), every one inside
`CONSTRUCTION_FRESH_DAYS` (90 days)**. A construction update is only true of the
day its photos were taken. Code checks, before paying:

- the count, the category and the tower (construction photos never travel);
- every photo used is dated and fresh, and the newest are chosen;
- the photos' month and year (one month, or "August and September 2026" when
  they span two) and each photo's title are passed to the writer as facts, so
  the date said and a stage named from a title pass the number check;
- no render, sample flat or amenity picture is offered to this format.

The founder vlog (03) and the generated engineer (04) are not made: a
generated person saying the work is on schedule is a claim nobody signed, put
in the mouth of somebody who does not exist. The morph to the finished render
(05) is not made either.

## What the product does with it

**15 seconds**, the suggested length: the developers' own updates run 20 and
21 seconds over eight or nine stages; one tower has three to five.

1. **4 to 6 shots of 2 to 3.5 seconds**, one dated construction photo each,
   newest first or in the order the work climbs. Straight cuts, never a morph,
   a dissolve between photos or a time-lapse.
2. **Each photo gets one small, slow camera move and nothing else**: a gentle
   drone drift, a slow push-in, a short rise or a pan, with only the sky
   moving. A big move forces the model to invent what the photo does not
   show, and it tends to tidy a site up: an extra floor, glass on bare
   concrete, scaffolding gone. The building check reads every shot against its
   photo.
3. **A plain narrator, 12 to 30 words, about 2.5 a second**: "Aster Heights on
   site, September 2026", then at most one short line per photo, and only the
   stage that photo's own title names ("The ground floor slab is cast"); a photo
   whose title names no stage gets no line. The possession date once, if the
   facts carry it, said as the filed date. The action at the end ("Come and
   see the site").
4. **Cards, 1 to 3, up to 3 words**: "SITE UPDATE" and the action. The date
   card (the photos' month and year) is set by us after the film, like the
   price card, and is never drawn by the model.
5. **Moves**: drift, push, rise, descend, pan, tilt, glide, drone, aerial,
   track, pull, slow. Forbidden in any shot: timelapse, time-lapse, morph,
   dissolve, transform, builds, grow, finish, complete, worker, labourer, FPV,
   whip, orbit.
6. **Forbidden**: progress no dated photo shows; a photo morphed, dissolved or
   time-lapsed into another or into a render; a render, or the finished
   building at the end; workers, machines or vehicles added or animated; a
   stage, percentage, floor count or date that is not in the facts or the
   photos' titles and dates; "on schedule", "ahead of time", "nearly done" or
   an early handover; "this week" or "today" for photos of last month; any line
   in Hindi.
7. **Our overlay goes on top**: the QR, the registration number and the
   Authority's website in the upper-right quarter, the contact line and the
   small print along the foot. These are photographs, so the small print does
   not call them an artist's impression.
