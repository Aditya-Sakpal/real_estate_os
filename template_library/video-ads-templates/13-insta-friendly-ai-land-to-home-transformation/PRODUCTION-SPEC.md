# Production spec: AI land-to-home transformation

Read `../INSTA-PRODUCTION-NOTES.md` first. This spec does not repeat the safe areas, lockup
geometry, disclaimer wording, or export settings.

**Target length:** 8 to 10 seconds
**Crew:** one operator, one person on camera optional, one drone pilot optional
**Site time:** 45 minutes
**Post time:** 2 to 3 hours the first time, under an hour once the template exists

---

## The one thing that makes or breaks this

The "before" and "after" must come from the **same camera position, same height, same
focal length**. Everything else is recoverable. This is not.

Every weak version of this format on Instagram is weak for the same reason: the render
was made at a different eye level than the plate, so the building looks pasted on rather
than grown out of the ground. The reference from @plot2homeindia works because the chalk
foundation lines in the plate carry through into the render, which anchors it.

---

## Part A: on-site prep, before you shoot anything

**A1. Mark the footprint.**
Lime powder or builder's chalk. Walk the actual foundation outline on the ground, not an
approximation. If the layout is already excavated or the plinth is up, even better, use
that.

Also mark the front setback line. In the final render the building's front face should
sit exactly on it.

**A2. Clear the frame.**
Remove bricks, tarpaulin, plastic, parked bikes, anything that will not exist in the
render. Anything in the plate that is absent in the render will pop at the cut and read
as a mistake.

Leave the things that *should* persist: the boundary wall, the neighbouring building,
the tree at the corner, the road. Those are what sell the transformation as real. A
plate with nothing in it transforms into something that could be anywhere.

**A3. Note your camera data.**
Write it down. You will need it again in three months for the progress reel (format 19)
and for the render brief.

```
Date / time:
Camera + lens:
Focal length (mm, full frame equivalent):
Tripod height from ground (cm):
Distance from front setback line (m):
Compass heading:
Drone: altitude (m), gimbal tilt (deg), heading (deg)
```

---

## Part B: the shot list

Shoot all four. You will only use one or two, but reshooting a site is expensive and
these take ten minutes each.

### Plate 1: the hero lockoff (this is the one you will use)
- Tripod, locked off, zero movement. 15 seconds of clean recording.
- Height 150 to 160 cm. Eye level. Not chest level, not ground level.
- Position yourself so you are looking at the **front and one side** of where the
  building will stand, roughly a 30 degree offset from dead-on. A flat front elevation
  is the single most boring way to reveal a building.
- Compose in thirds: plot and chalk lines in the lower third, the volume the building
  will occupy in the middle third, **leave the top third as sky**. The building needs
  somewhere to grow into. If you frame tight, the render has to be squat or it gets
  cropped.
- Mid-morning. Shadows should have a clear direction so the render can match them.

### Plate 2: the human anchor
- Same lockoff, do not move the tripod.
- One person, ideally in site clothes or simple formals, walks the chalk line from frame
  right to frame left holding rolled drawings or a tablet. 10 seconds.
- They must fully exit the frame. The moment they leave is your transition trigger.
- This is what @plot2homeindia does and it is why that reel got forwarded 4,100 times
  against 125 likes. A person on the land makes it a story about someone's plot, not a
  render demo.

### Plate 3: the drone hold
- 25 to 30 m altitude, gimbal at 45 degrees down, static hover, 12 seconds.
- Frame the full plot with at least 20 percent of the surroundings visible on every side.
- Use this as an alternative opener when the ground-level plate is blocked or ugly.

### Plate 4: the detail
- Handheld, 4 seconds. Close on the chalk line, or a hand pointing at the drawing, or
  the survey peg.
- You may not use it. It is your insurance for when the transition needs a beat to hide
  a mismatch.

---

## Part C: generating the after

1. Export a **still frame from Plate 1** as a PNG at full resolution. That frame, not a
   different photo, is your input.
2. Brief the image model with the plate plus your approved elevation drawing as a second
   reference. The instruction that matters: *keep the camera position, horizon line,
   lens perspective, time of day, and shadow direction identical to the input image.
   Replace only the marked plot area with the building.*
3. Check these four things on every generation, and regenerate until all four pass:
   - Horizon line sits at the same height as in the plate.
   - Shadows fall in the same direction and are the same length.
   - The boundary wall, road, trees, and neighbouring buildings are unchanged.
   - The building's front face sits on the setback line you marked.
4. Generate **two** versions at slightly different times of day if you want a second
   beat: plot to daytime building to evening building with lights on. The lights-on
   frame is the one people screenshot.

The model will want to beautify the surroundings. Fight it. A pristine render of an
unrecognisable street is the failure mode. If the neighbour's ugly green building is in
the plate, it must be in the render.

---

## Part D: the edit, beat by beat

At 30fps, 9 seconds total.

| Time | Frames | What happens | Audio |
|---|---|---|---|
| 0.0 to 1.6s | 0 to 48 | Plate 2. Person walking the chalk line. Hook text appears at 0.4s in the upper third. | Ambient site sound, full |
| 1.6 to 2.0s | 48 to 60 | Person exits frame left. Hold on the empty plot for 12 frames. This pause is the setup. | Ambient, music enters low |
| 2.0 to 3.2s | 60 to 96 | **The transformation.** See options below. | Music hits, ambient drops to 20 percent |
| 3.2 to 6.0s | 96 to 180 | Finished elevation, held. Slow push in of 3 percent over the whole 2.8s. Disclaimer label on screen from frame 96. | Music |
| 6.0 to 7.2s | 180 to 216 | Optional second beat: day to evening, lights on. Cross dissolve over 8 frames. | Music |
| 7.2 to 9.0s | 216 to 270 | Price and MahaRERA lockup fades in. Final frame holds 20 frames clean. | Music resolves |

Cut the second beat if you did not generate the evening version. Reel becomes 7.8s,
which is fine and arguably better.

**Transformation options, in order of how well they work:**

1. **Morph / cross dissolve with a slight scale push.** 36 frames. Dissolve the plate
   into the render while pushing in 2 percent across the dissolve. Cheapest, and it is
   what the highest-performing reference uses. The tiny scale move is what keeps it from
   looking like a PowerPoint fade.
2. **Build-up wipe.** The building rises from the chalk line upward over 30 frames using
   a linear wipe masked to the building's silhouette. More work, reads as construction.
3. **Dust or particle occlusion.** Covered in folder 14. Use it when the plate and render
   do not quite match and you need to hide the seam. It is a fix, not a first choice.

Do **not** use a whip pan here. The whole appeal is that the camera stays still while the
world changes.

---

## Part E: text on screen

Three text events only.

- **0.4s, upper third, 54pt:** the hook. Options that work, in order:
  - `Ye plot 8 mahine mein aisa dikhega` (regional beats English on this format)
  - `620 sq ft. Kalyan West.`
  - `What can actually be built here?`
  Do not write "Amazing transformation" or anything that describes the video. The viewer
  can see it.
- **From 2.0s, y 1540, 22pt:** `Artist's impression. Not to scale. Actual product may vary.`
  On screen for the entire time the render is visible. Non-negotiable.
- **From 7.2s:** the price and RERA lockup per the shared notes.

---

## Part F: caption

```
620 sq ft in Kalyan West. This is what stands on it.

2 BHK | 620 sq ft carpet | Kalyan West
Starting Rs 78.5 L*

Artist's impression. Not to scale.
MahaRERA P52100012345 | maharera.maharashtra.gov.in

Comment PLAN and I will send you the floor plan.

#kalyanwest #thaneproperty #2bhkflat #mumbaisuburbs
```

`Comment PLAN` is deliberate. The @brad.ziemer reference ran 2.4K comments against 2.2K
likes because the CTA farmed comments, and comment volume is the strongest single signal
Instagram reads on a reel.

---

## Part G: where this goes in your library

Maps to `video-ads-templates/02-launch-teaser` and `10-construction-update`. The Canva
video templates in those folders will give you the text animation and lockup styling;
this spec gives you the footage to put under them.

Run this format once per site. It does not repeat well on the same plot, but across ten
plots it is the most reliable reach you have.
