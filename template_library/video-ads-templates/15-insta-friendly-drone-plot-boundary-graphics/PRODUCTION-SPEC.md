# Production spec: drone plot with boundary graphics

Read `../INSTA-PRODUCTION-NOTES.md` first.

**Target length:** 9 to 12 seconds
**Crew:** drone pilot, one person on the ground with a measuring app or the survey sheet
**Site time:** 40 minutes
**Post time:** 2 hours the first time, 30 minutes per plot after that

This is the highest-comment format in the set and the most useful one you have for land
and plot inventory, because it fixes the one thing photographs of land cannot do: show
how big it is.

---

## Part A: get the boundary right before you fly

The graphic is only worth drawing if it is accurate. An outline that does not match the
actual survey boundary is worse than no outline, because a buyer who walks the site will
notice and you lose the sale and the trust.

Before the flight:
1. Get the plot's corner coordinates from the survey document or 7/12 extract, or walk
   the corners with a GPS app and drop a pin at each.
2. Physically mark each corner on the ground: a bag of lime, a white plastic sheet
   weighted down, a painted stone, anything that will be visible from 50 m up.
   **This is the step that makes the post-production easy.** Tracking an outline to four
   visible markers takes minutes. Guessing where the boundary is takes an hour and is
   wrong.
3. Note the plot area in both sq ft and guntha or sq m, whichever your buyers use. For
   Maharashtra plot buyers, guntha is usually the number that means something.

---

## Part B: the flight

### Shot 1: the static top-down (your primary)
- Altitude: high enough that the whole plot plus 30 percent surrounding context fits the
  9:16 frame. Usually 45 to 70 m.
- Gimbal: **straight down, 90 degrees.** Not 45. A top-down plan view is what lets the
  outline read as a plan, and it is what makes the area figure believable.
- **Completely static hover, 15 seconds.** No drift, no rotation. If there is wind, shoot
  20 seconds and stabilise in post.
- Frame the plot slightly below centre, leaving the upper third clear for text.

### Shot 2: the slow rise
- Start at 15 m looking down at 60 degrees, rise to 60 m while tilting to 80 degrees.
  12 seconds, as slow as your drone will go.
- This is your opener. It gives context before the plan view gives scale.

### Shot 3: the low orbit
- 20 m, 45 degree tilt, quarter orbit around the plot, 10 seconds.
- Shows the approach road and the neighbours. Use as a closer.

### Shot 4: ground reference
- Handheld, 5 seconds: a person standing at one corner, or walking one edge of the plot.
- Optional but strong. A human figure at the corner of the top-down shot is the single
  best scale reference there is, better than any number.

**Fly legally.** Under DGCA rules, check the airspace on the Digital Sky map before the
flight. Most of Kalyan, Dombivli and Ambernath is green zone, but parts of Thane and
anything near an airfield are not. A reel is not worth a penalty.

---

## Part C: the graphics

Three elements, appearing in sequence. Build these once as a template and swap the values
per plot.

**C1. The boundary stroke.**
- Draws itself along the perimeter, starting from the corner nearest the road and moving
  clockwise. 24 frames to complete.
- 6 px stroke, high-saturation colour that does not appear in the ground: cyan, lime, or
  a warm yellow. Not white, which disappears against dry soil, and not red, which reads
  as a warning.
- Add an inner glow or a 20 percent fill of the same colour once the stroke completes.
  The fill is what makes it read as an area rather than a line.
- If you marked the corners per Part A, corner-pin track to the markers. If you did not,
  and the shot is genuinely static, you can just draw it once and it will hold.

**C2. The area stamp.**
- Lands after the stroke completes, at the centroid of the plot.
- Count up from 0 to the final figure over 18 frames, then hold. The count-up is worth
  the extra effort, it holds the eye.
- Two lines: `2,400 sq ft` over `2.2 guntha`. Give both units.

**C3. The dimension callouts.**
- Frontage and depth, along the two relevant edges: `40 ft frontage`, `60 ft depth`.
- Appear 8 frames after the area stamp, smaller, 32pt.
- Frontage is the number plot buyers care most about and almost nobody puts it on screen.

---

## Part D: the edit, beat by beat

30fps, 11 seconds.

| Time | Frames | What happens |
|---|---|---|
| 0.0 to 2.5s | 0 to 75 | Shot 2, the rise. Hook text from 0.4s. |
| 2.5 to 3.0s | 75 to 90 | Cut to Shot 1, static top-down. Hold clean, no graphics. Let the viewer see the raw land. |
| 3.0 to 3.8s | 90 to 114 | Boundary stroke draws. |
| 3.8 to 4.5s | 114 to 135 | Fill fades in at 20 percent. Area stamp counts up. |
| 4.5 to 5.5s | 135 to 165 | Dimension callouts appear. Everything holds. |
| 5.5 to 7.5s | 165 to 225 | Optional: Shot 4 cut in, person at the corner, graphics held over it. Or continue holding Shot 1. |
| 7.5 to 9.5s | 225 to 285 | Shot 3, the low orbit. Graphics drop away, one line of text: locality and approach. |
| 9.5 to 11.0s | 285 to 330 | Price and MahaRERA lockup. |

The beat at 2.5 to 3.0s matters more than it looks. Half a second of unmarked land before
the outline draws is what creates the small "oh" when the boundary appears. Skip it and
the graphic is just a graphic.

---

## Part E: text on screen

- **0.4s, upper third, 54pt:** the hook, and for this format it should be the price per
  unit area, because that is what plot buyers compute anyway.
  `Rs 3,250 per sq ft. Ambernath East.`
  Or the objection: `Looks small from the road. It is not.`
- Graphics per Part C.
- **From 7.5s, 40pt:** `8 min from Ambernath station | 15 min to Badlapur`
- Lockup from 9.5s.

---

## Part F: caption

```
2,400 sq ft. 40 ft frontage. This is what that actually looks like.

Ambernath East | 2.2 guntha | clear title, NA plot
Rs 3,250 per sq ft

MahaRERA P52100012345 | maharera.maharashtra.gov.in

Comment PLOT for the survey number and the location pin.

#ambernath #plotforsale #naplot #badlapur #mumbairealestate
```

---

## Part G: why this one generates comments, and how to use that

Viewers ask "price?" and "location?" in the comments on this format rather than DMing,
because the reel gives them enough to be interested but not enough to decide. That is
useful: comment volume is the strongest ranking signal you have.

Deliberately leave one thing out. Put the price per sq ft on screen and leave the total
out, or give the total and leave the survey number out. Do not withhold everything, which
reads as bait, and do not give everything, which ends the conversation.

Then answer every comment with the missing piece plus one question back. That is where
this format actually converts, not in the reel.
