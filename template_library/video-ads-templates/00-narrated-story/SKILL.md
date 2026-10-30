# Skill: narrated story, made by the director agent

This is what the product knows about the Narrated story and how the director
makes one. Unlike the Seedance templates, it is not one generation: the
director agent (`reel-worker.ts`, `reel-agent-rules.ts`) writes a script in
`SCRIPT_SCHEMA`, has the narration spoken by Sarvam Bulbul, films each shot
as its own clip (people from words, the building from an approved picture),
cuts them on the beat and renders the reel with Remotion. The script's rules
are `scriptInstruction()`, `parseScript()` and `scriptProblems()` in
`src/lib/reel-rules.ts`; change them and this file together.

Written on 3 October 2026 from the reels then in this folder, and rewritten on
4 October 2026 when the client kept the Godrej film and replaced the other
four with two Piramal Aranya films (their "Stories" intro card cut off) and a
Man Company film. Read from frame sheets at one every three seconds and the
cuts counted by scene change.

## What the reels do

| | 01 Godrej Ascend | 02 Piramal, the Ahuja family | 03 Piramal, Kabir and Sanaya | 04 The Man Company |
| --- | --- | --- | --- | --- |
| Length | 49 s (35 s of story, then 11 s of cards) | 118 s (the last 15 s the end card) | 140 s (the last 15 s the end card) | 52 s (the last 6 s the logo) |
| Cuts | about 12 in the story | about 40 | about 40 | about 20 |
| Average shot | about 3 s | about 2.5 s | about 3 s | about 2.5 s |
| Who speaks | two children, dialogue | the father, a voice-over in the first person | the couple, to camera and over the pictures | the couple, dialogue |
| Music | light, under the talk | soft score, swelling at the reunion | soft score under the talk | warm, romantic score |
| Text on screen | none in the story; 4 white end cards | a title card ("This is the Ahuja family's story"), English subtitles | the same title card, English subtitles | a hashtag line at the close, the logo |

What each one is:

- **01 Godrej Ascend.** A boy afraid of a new school asks his sister what if he
  gets lost. She answers with the project's connectivity: two minutes from a
  supermarket, six from a mall, nine from a school. The building is never
  shown. The facts are the payoff of the child's worry, then white cards name
  the configuration, the place, the project and a hashtag, with the
  registration in the small print.
- **02 The Ahuja family.** A father ends a long day at work ("I love my job,
  but after a hectic day I look forward to going back to my family"), drives
  home, walks through the lobby and the flat looking for his little daughter,
  who is hiding; she jumps out ("Papa"), he carries her on his back, and the
  family ends silhouetted on the balcony at dusk. "Write your own story" and
  the logos close it. The home is the setting of one ordinary, warm moment,
  never described.
- **03 Kabir and Sanaya.** A young couple, four months in their home, talk to
  the viewer: she paints the view of the greens below, they met across the
  road at the zoo and the museum, his office is twenty minutes away, the
  amenities (a pool, a library) are below them, the front desk solves
  everything. Every selling point is a line in their own story, and the
  building shows as views, rooms and a slow rise up the tower.
- **04 The Man Company.** A Valentine's Day film: a woman comes home to a
  surprise her partner has set up, cake, candles and a note; the product
  (a fragrance) appears for two seconds inside the evening, then the hashtag
  and the logo. Not property, kept for how a small domestic moment carries a
  brand without any selling line.

What makes the format work:

- **One person, one small moment, one home that holds it.** Every reel opens
  on a feeling, never on the building: fear of a new school, a tired father,
  a couple at home, a surprise for a partner. The home is the answer or the
  setting, not the subject.
- **The facts are said inside the story.** Godrej never lists amenities; the
  sister uses the minutes to the supermarket to calm her brother. Kabir and
  Sanaya say the office is twenty minutes away because it gives them their
  evenings. A selling point lands harder as a line a person needs than as a
  claim.
- **Setup, turn, payoff, then the brand.** About a third of the time on the
  setup, a turn (the drive home, the hiding child), the payoff (the hug, the
  laugh, the balcony at dusk), and only then the name, the place and the
  action.
- **People carry the film; the building is brief.** In 01 the building never
  appears; in 02 and 03 it is views, rooms and one slow rise. When the property
  is shown it is a slow, steady move, never a fast one.
- **One voice, one track, no silence.** Dialogue, a voice-over or a score runs
  from the first frame to the last; cuts come on the music.
- **Subtitles carry it with the sound off.** 02 and 03 subtitle every line,
  short and plain. Text inside the story is a line of the story, not a feature
  list.
- **Grade.** Warm and soft throughout: golden lamps, window light, shallow
  depth, a dusk sky. Nothing punchy or neon.
- **Pace.** The long films (02, 03) earn their two minutes with dialogue and a
  real family; a 30-second story needs short lines and shots of three seconds
  or so, as 01 has.

## Verdict

**MAKE WITH** at least three approved pictures the film may show
(EXTERIOR_RENDER, AMENITY, LOBBY or SAMPLE_FLAT), one of them an
EXTERIOR_RENDER, plus a signed exact location and at least one approved
selling point. `parseScript()` already asks for three property shots when
three pictures exist; with fewer the story has nothing true to resolve on.

What the references do that we must not:

- **A first-person story (02, 03) is not ours to tell.** A generated family
  saying "we finally bought our home" in this project is a fabricated
  testimonial. The narrator speaks about them, or to the viewer, and never
  says anybody bought, booked or lives in the project.
- **The family inside the flat (02, 03) is a home drawn from words.** People
  are filmed in ordinary places (a rented room, a car, a cafe, a park, a school
  gate), never in the project; the project is only ever an approved picture.
- **Characters talking on camera (01, 03, 04)** would need lip-sync on generated
  people. The narrator carries every word; people act without speaking.
- **A developer's legacy line ("Building legacy since 1987")** only when a
  signed fact carries it.

## What the product does with it

**Length: 27 to 28 seconds, never over 30**, end card included. A story needs
its setup, turn and payoff, so it is the longest of the short formats, but
every reference that runs past thirty seconds does it with slow shots or
dialogue we cannot make. About 24 seconds of shots and the 3-second end card.

**Seven or eight shots**, about three seconds each: people shots 3 to 4
seconds, property shots 2.5 to 3.5, a card 2.5. Three or four people shots,
three property shots, at most one card.

**The beats**, for eight shots:

1. **Hook, people.** A small moment of the problem, in an ordinary place: a
   father on a crowded local train, a child's school bag by a cramped rented
   room, a couple checking the rent message. The narrator says it in one line.
2. **The turn, people.** The wish or the decision: the same people looking
   out of a window, a mother tying a child's shoes, a quiet promise.
3. **The answer, property.** The exterior, a slow rise or push-in. The line
   names the project's place once.
4. **A reason, property.** The view or an amenity, with the selling point as
   a line in the story ("the station eight minutes away, so evenings are
   theirs again").
5. **What it means, people.** The same people, reacting in an ordinary
   place: the child laughing, the grandparents at ease.
6. **A second reason, property.** The lobby, an amenity or the sample flat,
   a slow pan or glide.
7. **The price, card** (optional): one line exactly as the facts write it
   ("2 BHK ₹2.19 Cr*"), set by us.
8. **Payoff and invitation, people.** The feeling resolved (a hug, a smile, a
   hand on a shoulder) with the invitation said gently. The 3-second end card
   follows: logo, the cleared call to action, the phone and the registration.

**Who is on screen.** One cast described once (ages, clothes, looks), so the
same family is in every people shot; never named as buyers, never in the
project, never facing a building. No presenter.

**What is said.** Hindi in Devanagari, spoken by one warm narrator (Bulbul),
with English property words in Latin letters. 30 to 45 words across the film,
at most eight a line, one or two shots silent. The place named once; a price
only as the facts write it. Third person or to the viewer, never "I" or "we"
as a buyer.

**Cards and captions.** A Roman Hinglish caption on each narrated shot, at
most seven words, the line itself. At most one card, and only a fact.

**Moves.** People shots: real-time action, handheld or a slow track, natural
light. Property shots: one slow move (a gentle push-in, a slow pan, a slight
rise, a glide); nothing added to the picture. Cuts on the beat; one fade or
dip for the turn or the ending at most.

**Look and sound.** A warm, soft grade, the same on every shot; a warm or
uplifting track under the voice, dipping when the narrator speaks; never
silence.

**Never:**

- a person in the flat, on its balcony or in front of the tower;
- a buyer's first-person story, a family said to live there, or a review;
- the project's name or the building in the first shot;
- a fact listed like a brochure, or the lift, flooring, fittings or parking;
- a number the facts do not carry, a possession date as a promise, a discount
  or "only a few left";
- a line over eight words, or more than forty-five words in all;
- a fast move, a whip or an FPV dive on the building;
- a festival, a religion or a community unless the brief chose one.
