# Production notes: rules that apply to every format

These are the constants. Each folder's PRODUCTION-SPEC.md assumes you have read this
once and does not repeat it.

---

## 1. Frame and safe areas

Shoot and deliver 1080 x 1920 (9:16). If your camera shoots 16:9, shoot 4K horizontal
and crop in post so you keep reframing room.

Instagram covers parts of the frame with its own UI. Nothing that must be read can sit
inside these bands at 1080 x 1920:

| Band | Pixels | What covers it |
|---|---|---|
| Top | 0 to 220 | Status bar, account row on some surfaces |
| Bottom | 1600 to 1920 | Caption, audio strip, CTA row |
| Right | 940 to 1080 | Like, comment, share, save column |

So the usable text box is roughly **x 60 to 920, y 240 to 1570**.

The single most common mistake in the reference reels you collected is a price or
phone number placed at y 1650. On a phone it sits behind the caption. Check every
export on an actual phone in the Instagram preview, not on a laptop.

---

## 2. The price and MahaRERA lockup

Build this once as a reusable Canva or After Effects template and drop it into every
format. It should be the last thing that appears, never competing with the transition
or the reveal.

**Layout, at 1080 x 1920:**

- Price block: left aligned, x 70, baseline at y 1480. Two lines maximum.
  Line 1 at 64pt semibold, line 2 at 40pt regular.
  Example: `2 BHK from Rs 78.5 L*` over `Kalyan West, 620 sq ft carpet`
- QR: 190 x 190 px at **x 700, y 1300**. Do not push it further right than x 700.
  The action column starts at x 940 and will sit on top of it.
- RERA line: directly under the QR, 26pt, `MahaRERA P52100012345` and
  `maharera.maharashtra.gov.in` on a second line at 22pt.
- Put a 60 percent black scrim or a soft gradient behind the whole lockup. Over a
  bright elevation render, white text at 26pt disappears.

**Timing:** lockup fades in over 6 frames and holds for the last 2.0 to 2.5 seconds of
the reel. Not longer. A reel that ends on a static card loses the loop.

**Never** put the lockup over a transition, a morph, or a whip pan. It reads as a
glitch and it is unreadable at that speed anyway.

---

## 3. Disclaimer language

Any AI generated or CGI elevation, interior, or landscape must be labelled. Use this
exact wording, 22pt, bottom of the usable box at y 1540:

> Artist's impression. Not to scale. Actual product may vary.

For a transformation reel where the "after" is generated, that label must be on screen
for the entire time the generated image is visible, not only on the final card.

This is not decoration. Showing a render as though it were a photograph of a completed
building is the kind of thing that turns into a RERA complaint, and the label costs you
nothing.

If the project is not yet RERA registered, do not show a number, do not show a QR, and
do not quote a price. Run the reel as a brand or locality piece instead.

---

## 4. Audio

- Trending audio beats original audio for reach on formats 17 and 14. It does not help
  formats 13, 16, 18, or 19, where the content is the draw.
- A presenter reel without a lav mic is a wasted shoot. On-site wind and traffic destroy
  phone mics. A wired collar mic is enough.
- Regional language voiceover outperforms English for plot and affordable-segment
  buyers. Two of the four strongest references in folder 13 are Marathi or Hindi. Add
  burned-in English subtitles rather than switching the VO to English.
- Keep ambient site sound under music at 15 to 20 percent. Total silence under a
  transformation reads as a stock animation.

---

## 5. Shooting conditions

- Mid-morning, roughly 09:00 to 10:30, or the last hour before sunset. Harsh noon light
  flattens an elevation and blows out sky, which also makes AI transformation plates
  much harder to match.
- Overcast is fine for interiors, bad for drone plot work because boundaries lose
  contrast against the ground.
- For any locked-off plate, use a tripod. Handheld "locked off" is not locked off, and
  a transformation cut between two slightly different camera positions is immediately
  visible.

---

## 6. Export

- H.264, MP4, 1080 x 1920, 30fps (or 24fps for format 18 only).
- Bitrate 12 to 15 Mbps. Above that Instagram re-encodes anyway and you gain nothing.
- Audio AAC 128 kbps, loudness around -14 LUFS.
- Keep every reel under 30 seconds unless the content genuinely needs longer. Formats
  13, 14, and 15 should land at 7 to 12 seconds.

---

## 7. Caption structure

Same skeleton for every format:

```
<Hook: a question, a number, or a location name>

<Spec line: config, carpet area, locality>
<Price line: starting price with an asterisk>

<Artist's impression note, if applicable>
MahaRERA P52100012345 | maharera.maharashtra.gov.in

<CTA: one action, one way to take it>

#hashtags
```

Hashtag rules: 4 to 6, not 30. Weight them local, not generic. `#kalyanwest` and
`#thaneproperty` will out-reach `#realestate` and `#dreamhome` by a wide margin for a
small account, because you are competing against far fewer posts.

CTA rules: one action. "Comment PLAN for the floor plan" farms comments and is what
the highest-engagement reference in folder 13 uses. "DM for site visit" converts better
but reaches less. Pick one per reel, do not stack both.

---

## 8. Posting

- Post the same reel to Reels and to the Facebook page. Do not cross-post with the
  Instagram watermark, export twice.
- The first 3 seconds decide the reel. If retention drops below 60 percent at 3s, the
  problem is the opening frame, not the length.
- Reuse a format, not a reel. These seven formats are templates you will run dozens of
  times with different sites. Consistency of format is what builds the account.
