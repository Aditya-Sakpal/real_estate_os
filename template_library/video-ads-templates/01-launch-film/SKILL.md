# Skill: launch film, in one generation

This is what the product knows about the launch film and how it writes one in
a single Seedance 2.5 call. The code version is `LAUNCH_FILM_SKILL` in
`src/lib/video-skills.ts`; change both together.

Rewritten on 11 October 2026, after the client called the trailer-style
launch film (a tease, a reveal on a music hit, "Introducing", facts, a price)
"absolutely shit". The five Instagram reels it was read from were replaced by
three launch films from the developer whose launches reach the most people in
India.

## Why Lodha

Searched on YouTube for the launch and project films of Lodha, Godrej, Oberoi,
Prestige, Sobha, Birla Estates, DLF, M3M, Adani and Piramal. Lodha's
project films are watched far more than anyone else's, and they share one
grammar from project to project, which is what a template needs:

| Film | Views | Length |
| --- | --- | --- |
| Lodha Avalon, Mansions By The Sea (Juhu) | 25 million | 35 s |
| Lodha Belmont, Thane | 8 million | 51 s |
| Lodha Villa Cerro, Khopoli | 3.6 million | 31 s |
| Lodha Corinthia | 3.4 million | 40 s |
| Lodha Sewri, "Coming soon to Sewri" | 1.7 million | 30 s |
| Lodha Aureus | 1.6 million | 48 s |

Oberoi Realty is next (Sky City, Tower H: 3.5 million), then Sobha (Inizio:
2.9 million). Godrej, Prestige, DLF and the rest are well under a million on
their own channels.

## The three references

In this folder, at 720p, each beside its poster:

- `01-lodha-avalon-mansions-by-the-sea` (35 s, narrated, 24 cuts)
- `02-lodha-belmont-thane` (51 s, narrated, 38 cuts)
- `03-lodha-sewri-coming-soon` (30 s, music and printed lines only, 14 cuts)

Read at one frame a second, the cuts counted by scene change, the narration
transcribed by ElevenLabs Scribe, the voice's pitch measured (about 145 Hz,
a low male voice, in both narrated films).

## The grammar they share

1. **No facts.** No price, size, configuration, distance, amenity list or
   specification. The film sells how life feels there, not what the
   building has. Avalon's whole script is 27 words: "A rhythm, sensed
   before it's heard. The horizon stands uninterrupted. Everything feels
   considered. Grandeur held in perfect proportion. A life beyond the
   expected. Lodha Avalon."
2. **Short poetic lines, silence between.** Five to nine lines, three to
   seven words each, a full sentence with a full stop, said slowly by a low
   male voice close to the microphone, with two to three seconds of music
   after each. Sewri prints the same kind of line with no voice at all.
3. **Every line is printed small at the foot** while it is said (a thin sans,
   white, sentence case, centred low). The logo sits small in a corner.
4. **A cut every 1.5 to 3 seconds**, the camera always drifting: slow glides,
   push-ins, rises, a top-down over a garden. Never a whip, never an orbit.
5. **Details first, the building late.** Each film opens on something that
   is not the building (light on water, a silhouette at dusk, rolling grass,
   a bridge in mist) and spends most of its length on sensory details (water,
   fabric in a breeze, a hand on a leaf, a cocktail set down, a page turning)
   and on the amenities. The whole building appears once, if at all.
6. **People living in it, never selling it.** One woman, or one couple, the
   same through the film: swimming, reading by a window, walking a garden,
   a drink at the lounge, served by staff in black. Seen from behind, in
   profile or from a distance. Nobody looks into the lens or speaks.
7. **Warm golden hour.** Low contrast, creamy highlights, shallow depth of
   field, film grain; sunset and dusk light through the whole film.
8. **A quiet close.** The project's name, set wide in a light face on white
   or on the sky, with the locality beneath it ("JUHU SEAFACE, MUMBAI",
   "Coming soon to Sewri"). The RERA QR and number in the top right, the
   disclaimer at the foot. Nothing is asked of the viewer.

## What the product does

- A 25-second film, nine to eleven shots of two to three and a half seconds,
  in 9:16 or 16:9.
- Five or six lines, 18 to 34 words in all, each a feeling drawn from one
  approved selling point or from its shot's approved picture, never a number
  or a claim nobody signed.
- Narrated by ElevenLabs (Amit, the low male voice), each line heard back
  and kept only when every word is right.
- Every line set small at the foot by us while it is said
  (`filmSubtitle()`), so it is spelled as written and reads with the sound
  off.
- The building filmed only from its approved pictures, once, in the last
  third. People are generated, unnamed, inside the approved rooms and
  amenities, never looking at the camera.
- The close: the narrator says the name and the locality once, and the name
  card is ours, set wide in a light face (`filmCard(..., "elegant")`).
- Directed, checked, fixed scene by scene and stamped like every other film.

## What it leaves out

- Sea, beach, skyline and landmark openers the approved pictures do not show:
  a view drawn in is a view promised.
- Off-site places (Avalon's beach umbrella, Sewri's bridge): every shot is on
  an approved picture of the project.
- The white end card: our registration block and small print go over the
  film itself, as on every film.
