import { MAX_DESIGN_ATTEMPTS, slideTexts, type DesignProblem, type PostKind, type Slide } from "./compose-rules.ts";
import type { TemplateDirection } from "./template-rules.ts";

/**
 * The design agent, decided without a network: its budget, how an attempt is
 * named and reported to it, what it is told, and whether what it chose may be
 * the post.
 *
 * The agent is an art director. An image model designs the ad; the agent
 * looks at every attempt the way a person at ChatGPT does, decides what a
 * client would send back, and either asks for an edit of that attempt with
 * exactly those changes or has it designed again from the approved photograph.
 * A checker reads every attempt too, and `judgeDesign()` decides, in code,
 * what breaks a rule. The agent can add taste to that list; it can never take
 * a rule off it, because `finishGate()` refuses an attempt that failed one.
 *
 * Imports are relative because the checks load this straight from source.
 */

/**
 * Turns and dollars one post's art direction may use. The drawings themselves
 * are capped per slide by `MAX_DESIGN_ATTEMPTS`, as they always were; this is
 * the agent's own thinking, which is priced separately in `doc/pricing.md`.
 */
export function designAgentBudget(slides: number): { turns: number; usd: number } {
  const n = Math.max(1, slides);
  // The dollars are what hold the plans' and top-ups' worst-case floors
  // (doc/pricing.md): a five-slide carousel cost $0.02 of gpt-5.4-mini on its
  // first live run, so this leaves six times that without letting a stubborn
  // post eat a margin. A dearer model named in the environment meets the same
  // ceiling and stops sooner.
  return { turns: Math.min(40, 6 + n * (MAX_DESIGN_ATTEMPTS + 1)), usd: Math.round((0.04 + 0.016 * n) * 1000) / 1000 };
}

/** An attempt's name: its slide, counted from one, and which drawing of that slide it was. */
export function attemptId(slide: number, n: number): string {
  return `s${slide + 1}a${n}`;
}

export function parseAttemptId(id: string): { slide: number; n: number } | null {
  const m = /^s(\d{1,2})a(\d{1,2})$/.exec(id.trim());
  return m ? { slide: Number(m[1]) - 1, n: Number(m[2]) } : null;
}

/** The problems that stop a post: everything but a soft one (no slot for the logo, a letter off in a long line). */
export function blocking(problems: readonly DesignProblem[]): DesignProblem[] {
  return problems.filter((p) => !p.soft);
}

const roleName: Record<Slide["role"], string> = { cover: "cover", point: "point", photo: "photo", close: "close" };

/**
 * What the agent is told about one attempt. The first line is fixed in shape
 * (`s1a2 · slide 1 of 5 (cover) · FAILED · 1 drawing left`) because a person
 * reading a log reads it the same way the agent does.
 */
export function attemptReport(input: {
  id: string;
  slide: number;
  total: number;
  role: Slide["role"];
  how: "photo" | "redraw" | "edit";
  base: string | null;
  /** The approved photograph it was drawn from, counted from one. */
  photo: number;
  problems: readonly DesignProblem[];
  left: number;
}): string {
  const passed = blocking(input.problems).length === 0;
  const from =
    input.how === "edit"
      ? `an edit of ${input.base}`
      : input.how === "redraw"
        ? `drawn again from photograph ${input.photo}, shown ${input.base}`
        : `drawn from photograph ${input.photo}`;
  const lines = [
    `${input.id} · slide ${input.slide + 1} of ${input.total} (${roleName[input.role]}) · ${passed ? "PASSED" : "FAILED"} · ${input.left} ${input.left === 1 ? "drawing" : "drawings"} left for this slide`,
    `This is ${from}.`,
  ];
  if (!input.problems.length) lines.push("The checker found nothing wrong.");
  else {
    lines.push("The checker found:");
    for (const p of input.problems) {
      const kind = p.soft ? "minor, does not stop it" : p.fixable ? "the designer can fix it" : "not the drawing's to fix";
      lines.push(`- ${p.code} (${kind}): ${p.text}`);
    }
  }
  lines.push("The picture below is the finished frame, exactly as a buyer would see it.");
  return lines.join("\n");
}

/**
 * Whether a slide may be drawn from a photograph the agent picked. Any
 * approved background may fill a later slide; the cover stays an exterior
 * whenever there is one, because the building is what a buyer looks at first,
 * unless the rotation already gave it a construction photo (construction
 * update / timeline templates).
 */
export function photoAllowed(input: { slide: number; photo: number; assigned: number; categories: readonly string[] }): string | null {
  if (!Number.isInteger(input.photo) || input.photo < 0 || input.photo >= input.categories.length) {
    return `there are ${input.categories.length} approved photographs, counted from one.`;
  }
  if (input.slide === 0 && input.photo !== input.assigned) {
    const want = input.categories[input.assigned];
    if (want === "CONSTRUCTION") {
      if (input.categories[input.photo] !== "CONSTRUCTION") {
        return "the cover is drawn from a construction photograph.";
      }
    } else if (input.categories.includes("EXTERIOR_RENDER") && input.categories[input.photo] !== "EXTERIOR_RENDER") {
      return "the cover is drawn from an exterior photograph.";
    }
  }
  return null;
}

/**
 * Whether the attempts the agent chose may be the post: one per slide, in
 * order, each one belonging to its slide and failing no rule. Returns what is
 * wrong, or nothing.
 */
export function finishGate(
  chosen: readonly string[],
  attempts: ReadonlyMap<string, { slide: number; problems: readonly DesignProblem[] }>,
  slides: number,
): string[] {
  const out: string[] = [];
  if (chosen.length !== slides) out.push(`Choose exactly one attempt for each of the ${slides} ${slides === 1 ? "slide" : "slides"}, in order.`);
  chosen.forEach((id, i) => {
    const a = attempts.get(id);
    if (!a) out.push(`There is no attempt ${id}.`);
    else if (a.slide !== i) out.push(`${id} is not an attempt at slide ${i + 1}.`);
    else {
      const b = blocking(a.problems);
      if (b.length) out.push(`${id} failed the check (${b.map((p) => p.code).join(", ")}), so it cannot be published.`);
    }
  });
  return out;
}

/**
 * What the art director is, and how it works. The same for every post, except
 * that an exempt tower registers nothing: its ad carries no registration
 * block, so the agent is never told to protect one.
 */
export function designAgentInstructions(opts: {
  registered?: boolean;
  strip?: boolean;
  /** Carousel slides: we stamp the real QR and registration after the drawing. */
  carouselStamp?: boolean;
  /** A single image: we stamp the registration block (not the footnote) after the drawing. */
  blockStamp?: boolean;
} = {}): string {
  const registered = opts.registered ?? true;
  const stamp = !!opts.carouselStamp && registered && !opts.strip;
  const blockOnly = !stamp && !!opts.blockStamp && registered && !opts.strip;
  return [
    "You are the art director at a top Indian real-estate advertising agency. A designer (an image model) makes the ad;",
    "you direct it the way a person does in ChatGPT: look at what came back, decide what a client would send back, and",
    "ask for exactly that change, passing the attempt back so it is edited rather than started again. A checker also",
    "reads every attempt and lists what breaks the rules. You cannot overrule the checker, and you can hold an attempt",
    "to a higher bar than it does.",
    "",
    "HOW TO WORK",
    "1. Start each slide with design_slide, start \"photo\". You may add a line or two of art direction (mood, light,",
    "   where the headline sits), or none. For a carousel or a video, make the cover (slide 1) first; every other",
    "   slide is matched to it. Once the cover is right, ask for all the other slides in the same turn.",
    "2. Look at each attempt as the client will. It needs another drawing when the checker failed it, or when a client",
    "   would clearly send it back: text hard to read or crowded, a clumsy or cramped layout, the photograph badly",
    stamp || blockOnly
      ? "   cropped, garish colour, words or panels in the upper-right quarter, or the logo slot fighting the design."
      : registered
        ? "   cropped, garish colour, the registration block or the logo slot fighting the design."
        : "   cropped, garish colour, the logo slot fighting the design.",
    "   - Mostly right: design_slide with start \"edit\" and that attempt. List only the specific changes, as a client",
    "     would say them. The checker's own fixes are added for you.",
    "   - Wrong at the root, or the building changed: design_slide with start \"photo\" and that attempt. It is designed",
    "     again from the approved photograph, keeping the building faithful to the photo.",
    "   - The photograph does not suit the slide's line (a line about the station over a living room): design_slide",
    "     with start \"photo\", no attempt, and another approved photograph from the list. Two slides of one set never",
    "     share a photograph while another would suit.",
    stamp
      ? "   - For carousels: one logo slot top left, upper-right quarter left empty (we stamp the registration). The designer brief already advances any timeline marker; do not write marker counts or slide numbers in your changes. Send back a slide with two logos, invented badges, or milestone labels."
      : "   - For carousels: keep the header (logo slot, registration block, QR) matching the cover. The designer brief already advances any timeline marker for each slide, so do not write marker counts or slide numbers in your changes. Send back a slide with two logos or a logo fighting the design.",
    "   A problem the checker marks minor never needs a drawing: it is usually the designer quietly correcting a typo in",
    "   the approved copy, and asking it to put the typo back wastes money.",
    "3. When every slide has an attempt you would publish, call finish with one attempt per slide, in order. If no",
    "   drawing can pass, call give_up.",
    "",
    "WHAT YOU MAY WRITE (a guard refuses anything else, and nothing is drawn)",
    "- No numbers at all: no prices, sizes, floors, percentages, phone numbers or counts. Name text by its role (the",
    "  headline, the price line, the footnote) or quote one of the approved lines exactly.",
    "- Quote only the approved lines in the brief. Never ask for new text, badges, icons, offers, milestone names,",
    "  stage labels, dates nobody cleared, or other claims.",
    "- Never ask to change the building or the space: nothing added, removed, moved or reshaped, no views, water,",
    "  roads or landmarks. Light, sky, season, crop, type and layout are yours to direct.",
    ...(stamp
      ? [
          "- Leave the upper-right quarter empty of words, QR codes and panels: we stamp the real registration and QR",
          "  there afterwards. Never ask the designer to draw a registration number, website or QR. The plain green",
          "  rectangle is where the logo is set; keep it on a calm area top left.",
          "- Leave the bottom edge empty of phone, website, disclaimer, artist's impression and progress timeline: we stamp those too.",
        ]
      : blockOnly
        ? [
            "- Leave the upper-right quarter empty of words, QR codes and panels: we stamp the real registration and QR",
            "  there afterwards. Never ask the designer to draw a registration number, website or QR. The footnote is the",
            "  designer's and must stay the smallest text in the ad. The plain green rectangle is where the logo is set;",
            "  keep it on a calm area.",
          ]
      : registered && opts.strip
        ? [
            "- The registration strip (the registration number and the authority's website) runs along the bottom edge,",
            "  full width and bold. The plain green rectangle is where the logo is set; keep it on a calm area.",
          ]
        : registered
          ? [
              "- The registration block (QR code where there is one, the registration number and the authority's website)",
              "  stays in the upper-right quarter, larger than the footnote. The plain green rectangle is where the logo is",
              "  set; keep it on a calm area.",
            ]
          : [
              "- There is no registration block on this ad: never ask for a QR code, a registration number or a website.",
              "  The plain green rectangle is where the logo is set; keep it on a calm area.",
            ]),
    "",
    "Every drawing costs real money and each slide has a fixed number. Do not spend one on a point of taste a client",
    "would not notice. Keep what you write short and concrete.",
  ].join("\n");
}

const q = (t: string) => `"${t.replace(/"/g, "'")}"`;

/** The job, as the agent's first message. */
export function designAgentTask(input: {
  kind: PostKind;
  placement: string;
  w: number;
  h: number;
  slides: readonly Slide[];
  /** Every approved photograph the post may use. */
  photos: readonly { category: string; title: string | null }[];
  /** The photograph each slide starts from, by its place in `photos`. */
  assigned: readonly number[];
  templateName: string | null;
  /** The template's look in words, and the festival the post is built around. */
  style?: TemplateDirection | null;
  referenceCount: number;
  /** Whether the model sets the words; false when they are Pango's (Hindi, Marathi and the rest). */
  whole: boolean;
  /** Every line that may be quoted: the slides' words and the registration and contact lines. */
  quotable: readonly string[];
  attemptsPerSlide: number;
  /** False for an exempt tower, whose ad carries no registration block. */
  registered?: boolean;
  /** West Bengal's strip along the foot, which the designer draws. */
  strip?: boolean;
}): string {
  const registered = input.registered ?? true;
  const what =
    input.kind === "IMAGE"
      ? "one image post"
      : input.kind === "CAROUSEL"
        ? `a carousel of ${input.slides.length} slides`
        : `the ${input.slides.length} frames of a short video (each frame is later brought to life with the camera still, so the words${registered ? " and the registration block" : ""} never move)`;
  const lines = [
    `THE JOB: ${what} for ${input.placement}, ${input.w} by ${input.h} pixels.`,
    input.templateName
      ? `STYLE: the "${input.templateName}" kind of ad.${input.referenceCount ? ` The reference designs attached after the photographs show the look, for style only.` : ""}`
      : "STYLE: a clean, modern, premium agency ad.",
    ...(input.style?.look
      ? [
          `What this kind of ad looks like: ${input.style.look} ` +
            `Send back any drawing that does not read as a ${input.templateName ?? input.style.label} ad at first sight, ` +
            "the way the reference designs do: a generic clean ad that could be any kind is not finished. " +
            "Match this template's graphic devices and mood; do not settle for a house-style premium ad.",
        ]
      : []),
    ...(input.style?.festival
      ? [
          `FESTIVAL: the post is built around ${input.style.festival.label} (${input.style.festival.look}). ` +
            `Send back any drawing that does not read as a ${input.style.festival.label} post at first sight, ` +
            "and any that hangs decoration on the property or draws over it.",
        ]
      : []),
    input.whole
      ? input.kind === "CAROUSEL" && registered
        ? "The designer sets the approved copy only. We stamp the real registration, QR, phone, small print and artist's impression afterwards, so the upper-right quarter and the foot must stay empty of those."
        : registered && input.kind === "IMAGE" && !input.strip
          ? "The designer sets every word itself, the footnote included. We stamp the real registration block and QR in the upper-right quarter afterwards, so that quarter must stay empty."
        : registered
          ? "The designer sets every word itself, the registration block and the footnote included."
          : "The designer sets every word itself, the footnote included."
      : registered
        ? "The words are in a script the designer cannot draw, so it draws the picture only and leaves calm space; the words, the registration panel and the contact strip are set on top by us afterwards. Judge the picture and the space it leaves."
        : "The words are in a script the designer cannot draw, so it draws the picture only and leaves calm space; the words and the contact strip are set on top by us afterwards. Judge the picture and the space it leaves.",
    ...(input.kind === "CAROUSEL"
      ? [
          "",
          "CAROUSEL:",
          registered
            ? "- Match the cover: logo slot top left, upper-right quarter left empty for our registration stamp."
            : "- Match the cover's header: logo slot in the same place and size.",
          "- Continuity graphics (timeline markers, route lines, progress dots) are already set in each slide's designer brief. Do not mention counts, slide numbers or marker positions in your changes.",
          "- Never ask for milestone names, stage labels, dates, badges or any words outside the approved lines.",
          "- One logo only, top left. After the cover passes, design every other slide in the same turn.",
        ]
      : []),
    "",
    "SLIDES",
  ];
  input.slides.forEach((s, i) => {
    const texts = slideTexts(s);
    lines.push(
      `Slide ${i + 1} (${roleName[s.role]}), from photograph ${input.assigned[i] + 1}: ` +
        (texts.length ? texts.map(q).join(" / ") : "no words, the photograph is the message"),
    );
  });
  lines.push("", "APPROVED PHOTOGRAPHS (attached first, in this order)");
  input.photos.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.category.toLowerCase().replace(/_/g, " ")}${p.title ? `, ${q(p.title)}` : ""}`);
  });
  lines.push(
    "",
    "APPROVED LINES (the only text that may be quoted or set)",
    ...input.quotable.map((t) => `- ${q(t)}`),
    "",
    `BUDGET: ${input.attemptsPerSlide} drawings per slide.`,
  );
  return lines.join("\n");
}
