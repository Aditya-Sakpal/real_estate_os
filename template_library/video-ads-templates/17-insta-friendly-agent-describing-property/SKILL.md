# Skill: agent describing the property, in one generation

This is what the product knows about the format and how it writes one film in a
single Seedance 2.5 call. The code version is `AGENT_DESCRIBING_SKILL` in
`src/lib/film-rules.ts`; change both together.

It was written on 27 September 2026 from the four reels in this folder
(frame sheets at one per second, a word-timed transcript of each, and the cuts
counted by scene change), and from the first one-call film we made, which the
client rated close to perfect but for two mistakes.

## What the four reels do

| | 01 | 02 | 03 | 04 |
| --- | --- | --- | --- | --- |
| Length | 69 s | 61 s | 57 s | 67 s |
| Cuts | 35 | 23 | 29 | 24 |
| Average shot | 1.9 s | 2.5 s | 1.9 s | 2.7 s |
| Words spoken | 101 | 50 | 80 | 97 |
| Pace while talking | 2.5 to 3.4 words a second | about 2 | 3 to 4 | about 2.3 |

- **The talking comes in bursts.** Between 40 and 60 per cent of each reel is
  speech; the rest is property shots over music. A 30-second version carries 40
  to 60 words, not 80. Our first one-call film ran 78 words and the model
  slurred "podium garden" into "paddy and garden".
- **The hook is aimed at the viewer**, in the first 3 to 4 seconds, presenter on
  camera: a challenge ("If your man can't afford this home..."), a negative claim
  ("You have not seen townhomes like this"), a congratulation or an "if you love
  X". Never the project's name first.
- **Then where it is**, in one line, over a fast drone reveal.
- **Then three or four specifics**, one per beat, each with a shot of exactly
  that thing.
- **One price or offer**, said by the presenter, shown as text at the same moment.
- **A close with one action** (comment, call, book), presenter on camera.
- **The presenter** appears in four to six places: the entrance, a room, a sofa,
  a doorway, the street. Full body or knee-up, centred, the property on both
  sides of her. Her hands never stop: open arms on the hook, pointing, counting,
  a sweep across a room. She walks toward the lens at least once. One close-up at
  most.
- **The property shots move fast**: FPV drone dives and orbits, gimbal pushes
  through rooms, whip transitions with motion blur, a wide lens, warm and bright.
  Nothing is static and no shot lasts more than about 3 seconds.
- **The home itself, at least once.** When the library holds a picture of the
  sample flat, one scene is inside it: she walks into the room, or the camera
  pushes through it. A buyer is buying the flat, and until 4 October 2026 no
  film showed one room of it. The writer is offered the flat's two best rooms
  (living room and bedroom before the bathroom) among its ten pictures
  (`filmPictures()`), and a draft with no scene inside is sent back.
- **Two kinds of text.** Big words, three to five to a card, stacked in two sizes
  with one word coloured, on the hook and the key claims; and small one-word
  captions following the speech. We keep the big cards and drop the running
  captions: every extra word a video model draws is one more chance of a typo,
  and a typo means paying for the film again.
- **Sound**: upbeat music under the voice, whooshes on the transitions, never
  silence.

## What the product does with it

**Revised the same day, after the app's first film.** The app's own prompt
had been rewritten from the one that made the near-perfect film, and its film
came back stiff, slow and flat: 8 shots of up to five seconds, 40 words, a
relaxed voice, a presenter without realism cues, no style references, and a
serif font the person had picked. The numbers and wording below are now the
near-perfect film's: 9 to 12 shots of two to three seconds, 4 to 6 of them the
presenter, 55 to 80 words said quickly, 4 to 8 cards of up to five words
("BIG / small" for two sizes), every property shot a named fast move and every
presenter shot a body action. The writer is shown that film's script as its
worked example. The three frames in `style/` (a presenter walking toward the
lens, an FPV move, a whip pan, captions painted out) go first as style
references, then a card of the film's own first words in the big-text style,
then the project. How to say a local name is listed once under the voice
(`PRONOUNCE`), never respelled inside the line, and words the voice or the
text keeps getting wrong ("plot", "podium", a place name on a card) are kept
out of the script altogether.

**Revised again on 1 October 2026, after the film of 30 September.** That film
cut the FPV style frame's sports car and the whip frame's house into a
transition, captioned everything the presenter said word by word ("A HOME LIKS
IN GFRRGO WEST", "SYMNASIUM"), and drew the price as "$1.45 CR". So no style
frames are sent any more (the moves are described in words); a film carries 3
to 5 cards, each popping in whole, every shot without one is told it has no
words, and her speech is never captioned; the price and configuration card
("1 BHK / ₹1.45 CR") is kept from the model and set on the film by us while she
says it; BHK is said as its three letters, in order; and the whole film is
looked at a frame a second for anything that is not the project.

**Revised on 2 October 2026, after the first film made through OpenRouter.**
Its line "And from the eighteenth floor up? Sea facing." came back with a
1.2 second pause after the question and 0.6 seconds between "sea" and
"facing": a question answered by a fragment is performed as a reveal. So every
line flows in one breath: the voice is told so, the writer never answers a
question with a fragment or writes a sentence of one to three words after
another, and code joins one that slips through with a comma
(`flowingLine()`). A pause still found inside a line is a note with its time.

The same day, the local name is said **once** in the whole film ("in
Goregaon West", then "eight minutes from the station"). The voice says a
local name differently every film ("Gorego", "Gorahand"), and every saying of
one is said again in her voice afterwards, so one saying is one fix.

Also on 2 October 2026 the client asked for the presenter to look as real as
possible. The look is "hyper-realistic, like real footage", the writer
describes an ordinary real-looking person with one small natural detail, and
the prompt says how a camera sees a real person (`skill.realism`): visible
pores and fine lines, a slightly asymmetric face, loose hair, blinking eyes,
lips moving with every word, natural hands, real fabric, the scene's own light
on her, and no beauty filter.

The same evening the price shot ("1 BHK homes start at ₹1.45 Cr.", with her
counting on her fingers as the worked example had it) came back "one, two,
three homes". She no longer counts on her fingers anywhere (the beat, the
example and the writer's list of actions; code swaps it for a lean into the
lens), and BHK is said as one word, "bee-aitch-kay".

1. **A writer drafts the scenes** from the signed facts, the cleared card and the
   approved pictures: 7 to 11 scenes, 3 to 5 of them the presenter, 35 to 55
   spoken words, 3 to 6 big text cards of up to four words (the first numbers,
   superseded above). Code checks the draft
   before anything is paid for (`filmProblems()`): every number is a signed one,
   no never-say phrase, every word on a card comes from an approved line or the
   scene's own line, every scene names an approved picture, and the words fit the
   time. A draft that fails is sent back with the reasons, up to three times.
   Words are counted as said: "₹1.45 Cr" is five, "1 BHK" four, and the writer
   is told so, with each scene's count when it is over. Dry runs on Tower C
   taught three more things: the writer is given the locality to say ("Goregaon
   West", the last part of the signed location; told only "the shortest name",
   it said "Near City Pond"), told to fix a typo it finds in the approved copy
   ("weekened"), and a date is given as a month and a year. Code drops a card
   that is too long or one card too many itself (`tidyScript()`), the middle
   ones first, rather than paying for another draft. The first live film
   through the product (27 September 2026) set "CENTRAL PODIOM GARDEN", with
   the spelling given only at the end of the prompt; each card is now spelled
   beside it in its shot, and the writer is told to keep cards to short,
   everyday words.
2. **Code plans the time** (`planTiming()`): each scene gets what its words need
   at 2.5 words a second plus a breath, silent shots get about two seconds, and
   what is left is spread so nothing is stretched. The prompt gives these times
   as a plan and tells the model to move a second or two from a shot that does
   not need it to one that does, never to rush the speech.
3. **Code writes the prompt** (`filmPrompt()`), laid out like the near-perfect
   film's. The style frames go first with their captions painted out (the
   first film copied "If your man can't afford" off a frame that had its
   caption), then the big-text card in our own words, then the approved
   pictures, one per `@Image`. Every line is written the way it is said ("one
   point four five crore", "one B H K"), a local name is said the way the list
   under the voice says ("Go-ray-gow"), and every card is spelled out letter
   by letter beside it.
4. **One call.** Seedance 2.5 reference-to-video, 30 seconds, 720p, with its own
   voice and music. Nothing is made twice by the product: a second version is the
   person's choice and counts as two videos, because the first film is sent back
   in as the starting point.
5. **Our overlay goes on top**: the QR, the registration number and the
   Authority's website in the upper-right quarter, the contact line and the small
   print along the foot. The prompt keeps that corner and the foot clear.
6. **Checks, which never buy a second film**: the QR scans, the voice is heard
   back and held against the script, and frames are read for the text on them and
   the building. A wrong number heard or shown, or a building unlike its picture,
   stops the film from being published; anything else is a note for the person to
   look at.
