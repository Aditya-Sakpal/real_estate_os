import { runAgent, type AgentStep, type AgentTool, type ToolOutcome } from "./agent.ts";
import type { TemplateDirection } from "./template-rules.ts";
import { argString, argStrings, guardAgentText } from "./agent-rules.ts";
import { betterDesign, MAX_DESIGN_ATTEMPTS, type PostKind, type Slide } from "./compose-rules.ts";
import {
  attemptId,
  attemptReport,
  blocking,
  designAgentBudget,
  designAgentInstructions,
  designAgentTask,
  finishGate,
  photoAllowed,
} from "./design-agent-rules.ts";
import { isServiceDown } from "./service-rules.ts";
import type { AgentBrain } from "./generate.ts";
import type { DesignedFrame, SlideDesigner } from "./compose.ts";

/**
 * The design agent: an art director that makes one post (an image, every
 * slide of a carousel, or a video's frames) by directing the image model the
 * way a person does, looking at each attempt and asking for the change a
 * client would ask for. `design-agent-rules.ts` holds what it is told and
 * what it may finish with; `compose.ts` holds the drawing, the stamping and
 * the check, one paid drawing per call.
 *
 * Imports are relative because the scheduled runner loads this straight from
 * source.
 */

/**
 * The art director's model. `gpt-5.4-mini` directed a five-slide carousel in
 * four turns for two cents on 26 September 2026, swapping in the balcony
 * photograph for the sea-view slide on its own; `gpt-5.5` did the same job in
 * six turns for twenty cents, which breaks the carousel top-up's worst-case
 * floor (`doc/pricing.md`). `DESIGN_AGENT_MODEL` overrides it, and the
 * dollars in `designAgentBudget()` still hold whatever model is named.
 */
export const DESIGN_AGENT_MODEL = process.env.DESIGN_AGENT_MODEL || "gpt-5.4-mini";
const EFFORT = (process.env.DESIGN_AGENT_EFFORT || "low") as "none" | "low" | "medium" | "high";

export type ArtDirection = {
  /** The attempt kept for each slide: the one the agent finished with, or the best one drawn. Null where nothing was drawn. */
  frames: (DesignedFrame | null)[];
  /** Drawings made, across every slide. */
  drawings: number;
  /** Set when there is no post to judge at all: a refusal, a service that is down, a slide never drawn. */
  failure: { message: string; code?: string } | null;
  agent: { model: string; turns: number; usd: number; ended: string; finished: boolean };
};

type Picture = { bytes: Buffer; type: string };

export async function artDirect(input: {
  kind: PostKind;
  placement: string;
  w: number;
  h: number;
  slides: Slide[];
  /** Whether the model sets the words. */
  whole: boolean;
  /** Every approved photograph the post may be drawn from, small, for the agent to see. */
  photos: { category: string; title: string | null; preview: Picture }[];
  /** The photograph each slide is drawn from unless the agent picks another, by its place in `photos`. */
  assigned: number[];
  /** The designer of one slide from one photograph. Asked once per pair. */
  designerFor: (slide: number, photo: number) => Promise<SlideDesigner>;
  references: Picture[];
  templateName: string | null;
  /** The template's look in words, and the festival the post is built around. */
  style?: TemplateDirection | null;
  /** Every line the agent may quote. */
  quotable: string[];
  neverSay: readonly string[];
  /** False for an exempt tower: its ad carries no registration block. */
  registered?: boolean;
  /** The state puts the registration in a strip along the bottom (West Bengal). */
  strip?: boolean;
  /** A finished frame, flattened and sized for a model to look at. */
  preview: (frame: DesignedFrame) => Promise<Picture>;
  brain?: AgentBrain;
  model?: string;
  signal?: AbortSignal;
  /** Told of every tool call, for a log or a screen. */
  onStep?: (step: AgentStep) => void;
}): Promise<ArtDirection> {
  const n = input.slides.length;
  const deck = input.kind !== "IMAGE" && n > 1;
  const attempts = new Map<string, { slide: number; photo: number; frame: DesignedFrame; problems: DesignedFrame["problems"] }>();
  const bySlide: DesignedFrame[][] = input.slides.map(() => []);
  const refusedFor: (string | null)[] = input.slides.map(() => null);
  // Drawings per slide, counted when asked for rather than when they come
  // back, so two calls for one slide in the same turn cannot both pass the cap.
  const drawn: number[] = input.slides.map(() => 0);
  const designers = new Map<string, Promise<SlideDesigner>>();
  const designer = (slide: number, photo: number) => {
    const key = `${slide}:${photo}`;
    if (!designers.has(key)) designers.set(key, input.designerFor(slide, photo));
    return designers.get(key)!;
  };
  let cover: { id: string; image: Picture; passed: boolean } | null = null;
  /** In-flight cover drawing: later slides wait on it instead of racing a refuse. */
  let coverWait: Promise<void> | null = null;
  let chosen: string[] | null = null;
  let failure: ArtDirection["failure"] = null;
  const model = input.model ?? DESIGN_AGENT_MODEL;

  const designSlide: AgentTool = {
    name: "design_slide",
    description:
      "Make one drawing of one slide, stamp it and check it. start \"photo\" designs it from an approved photograph " +
      "(give an earlier attempt to have it shown what to avoid); start \"edit\" edits an earlier attempt of the same " +
      "slide, keeping everything but the changes. Returns the checker's findings and the finished frame. Call it for " +
      "several slides in one turn to have them drawn at the same time.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["slide", "start", "attempt", "photo", "changes"],
      properties: {
        slide: { type: "integer", description: "The slide, counted from one." },
        start: { type: "string", enum: ["photo", "edit"] },
        attempt: { type: ["string", "null"], description: "An earlier attempt at this slide, such as s1a1. Required for edit." },
        photo: {
          type: ["integer", "null"],
          description: "Another approved photograph for this slide, by its number in the list, or null for the slide's own. Only with start \"photo\" and no attempt.",
        },
        changes: {
          type: "array",
          items: { type: "string" },
          description: "Art direction for a first drawing, or the specific changes for another. No numbers; quote only approved lines.",
        },
      },
    },
    async run(args): Promise<ToolOutcome> {
      const slide = Math.round(Number((args as { slide?: unknown }).slide)) - 1;
      if (!Number.isInteger(slide) || slide < 0 || slide >= n) return { text: `Refused: there are ${n} slides, counted from one.` };

      // Register the cover gate before any await so a parallel later-slide call
      // waits instead of racing a "design the cover first" refuse.
      let releaseCover: (() => void) | undefined;
      if (deck && slide === 0 && !coverWait) {
        coverWait = new Promise<void>((resolve) => {
          releaseCover = resolve;
        });
      }

      try {
        const start = argString(args, "start") === "edit" ? "edit" : "photo";
        const baseId = argString(args, "attempt");
        const rawPhoto = (args as { photo?: unknown }).photo;
        const pickedPhoto = typeof rawPhoto === "number" && Number.isInteger(rawPhoto) ? rawPhoto - 1 : null;
        const changes = argStrings(args, "changes", 8);
        if (drawn[slide] >= MAX_DESIGN_ATTEMPTS) {
          return { text: `Refused: slide ${slide + 1} has had all ${MAX_DESIGN_ATTEMPTS} of its drawings. Finish with its best attempt, or give up.` };
        }
        if (deck && input.whole && slide > 0 && !cover) {
          // A cover call in the same turn may not have set coverWait yet; wait briefly.
          for (let i = 0; i < 40 && !cover && !coverWait; i++) {
            await new Promise((r) => setTimeout(r, 25));
          }
          if (coverWait) await coverWait;
          if (!cover) {
            return { text: "Refused: design the cover (slide 1) first. Every other slide is matched to it." };
          }
        }
        const base = baseId ? attempts.get(baseId) : null;
        if (baseId && !base) return { text: `Refused: there is no attempt ${baseId}.` };
        if (base && base.slide !== slide) return { text: `Refused: ${baseId} is an attempt at slide ${base.slide + 1}, not slide ${slide + 1}.` };
        if (start === "edit" && !base) return { text: "Refused: an edit needs the attempt to edit." };
        if (pickedPhoto !== null && base && pickedPhoto !== base.photo) {
          return { text: "Refused: another photograph is a new drawing. Leave the attempt empty to use it." };
        }
        const photo = base ? base.photo : pickedPhoto ?? input.assigned[slide];
        const why = photoAllowed({ slide, photo, assigned: input.assigned[slide], categories: input.photos.map((p) => p.category) });
        if (why) return { text: `Refused: ${why}` };
        const guard = guardAgentText({ texts: changes, cleared: input.quotable, neverSay: input.neverSay, maxChars: 300 });
        if (guard.length) return { text: `Refused, and nothing was drawn: ${guard.join(" ")}` };

        const no = ++drawn[slide];
        const r = await (await designer(slide, photo)).attempt({
          base: base?.frame ?? null,
          edit: start === "edit",
          notes: changes,
          cover: deck && slide > 0 ? cover?.image ?? null : null,
          signal: input.signal,
        });
        if ("refused" in r && r.guard) drawn[slide]--;
        const left = MAX_DESIGN_ATTEMPTS - drawn[slide];
        if ("refused" in r) {
          refusedFor[slide] = r.refused;
          // What the card itself says cannot be drawn, and a service that is
          // down refuses the next drawing the same way: both end the post.
          if (r.guard) {
            failure = { message: r.refused, code: "DESIGN_REFUSED" };
            return { text: `This slide cannot be drawn: ${r.refused}`, end: { ok: false, code: "DESIGN_REFUSED", message: r.refused } };
          }
          if (isServiceDown(r.code)) {
            failure = { message: r.refused, code: r.code };
            return { text: `The designer is unavailable: ${r.refused}`, end: { ok: false, code: r.code, message: r.refused } };
          }
          return { text: `The drawing failed: ${r.refused} ${left} ${left === 1 ? "drawing" : "drawings"} left for this slide.` };
        }
        const id = attemptId(slide, no);
        attempts.set(id, { slide, photo, frame: r, problems: r.problems });
        bySlide[slide].push(r);
        const image = await input.preview(r);
        const passed = blocking(r.problems).length === 0;
        // The cover later slides are matched to: the latest one that passed, or
        // the latest at all until one does.
        if (deck && slide === 0 && (passed || !cover?.passed)) cover = { id, image, passed };
        return {
          text: attemptReport({
            id,
            slide,
            total: n,
            role: input.slides[slide].role,
            how: !base ? "photo" : start === "edit" ? "edit" : "redraw",
            base: base ? baseId : null,
            photo: photo + 1,
            problems: r.problems,
            left,
          }),
          images: [{ ...image, detail: "high" }],
        };
      } finally {
        releaseCover?.();
        if (releaseCover) coverWait = null;
      }
    },
  };

  const finish: AgentTool = {
    name: "finish",
    exclusive: true,
    description: "Publish the post: one attempt per slide, in slide order. Refused if any of them failed the check.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["attempts"],
      properties: { attempts: { type: "array", items: { type: "string" } } },
    },
    async run(args) {
      const ids = argStrings(args, "attempts", 12);
      const problems = finishGate(ids, attempts, n);
      if (problems.length) return { text: `Refused: ${problems.join(" ")}` };
      chosen = ids;
      return { text: "Done.", end: { ok: true } };
    },
  };

  const giveUp: AgentTool = {
    name: "give_up",
    exclusive: true,
    description: "Stop without a post, when no drawing can pass. Say why in one sentence.",
    parameters: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string" } } },
    async run(args) {
      const reason = argString(args, "reason").slice(0, 200) || "This post could not be designed.";
      // The run's failed end already keeps the missing-slide fallback from
      // drawing after this. A slide never drawn fails below with this
      // reason; a post whose every drawing failed a check goes back as
      // DID_NOT_PASS, saying what it failed and audited by its codes.
      return { text: "Stopped.", end: { ok: false, code: "GAVE_UP", message: reason } };
    },
  };

  const budget = designAgentBudget(n);
  const run = await runAgent({
    model,
    effort: EFFORT,
    instructions: designAgentInstructions({
      registered: input.registered,
      strip: input.strip,
      // Hindi carousels stamp the lockup after the drawing too (Pango path).
      carouselStamp: !!deck,
      blockStamp: !deck,
    }),
    task: [
      {
        text: designAgentTask({
          registered: input.registered,
          strip: input.strip,
          kind: input.kind,
          placement: input.placement,
          w: input.w,
          h: input.h,
          slides: input.slides,
          photos: input.photos,
          assigned: input.assigned,
          templateName: input.templateName,
          style: input.style ?? null,
          referenceCount: input.references.length,
          whole: input.whole,
          quotable: input.quotable,
          attemptsPerSlide: MAX_DESIGN_ATTEMPTS,
        }),
        images: [
          ...input.photos.map((p) => ({ ...p.preview, detail: "low" as const })),
          ...input.references.map((r) => ({ ...r, detail: "low" as const })),
        ],
      },
    ],
    tools: [designSlide, finish, giveUp],
    maxTurns: budget.turns,
    maxUsd: budget.usd,
    // Every slide's latest attempt stays visible, so a carousel is judged as a set.
    keepImages: Math.max(3, n + 1),
    parallel: 2,
    brain: input.brain,
    signal: input.signal,
    onStep: input.onStep,
  });

  // When the agent runs out of budget or gets stuck with a cover but later
  // slides never drawn, finish those slides once each without art direction.
  // Never after give_up or a service-down end: both mean stop now, and the
  // studio placeholder stays "making" until this function returns.
  if (
    !failure &&
    !chosen &&
    !input.signal?.aborted &&
    !(run.end && !run.end.ok) &&
    !(run.ended === "failed" && run.end && isServiceDown(run.end.code)) &&
    deck &&
    cover
  ) {
    const missing = input.slides.map((_, i) => i).filter((i) => i > 0 && !bySlide[i].length && drawn[i] < MAX_DESIGN_ATTEMPTS);
    for (const slide of missing) {
      if (input.signal?.aborted) break;
      const photo = input.assigned[slide];
      const why = photoAllowed({
        slide,
        photo,
        assigned: input.assigned[slide],
        categories: input.photos.map((p) => p.category),
      });
      if (why) {
        refusedFor[slide] = why;
        continue;
      }
      const no = ++drawn[slide];
      const r = await (await designer(slide, photo)).attempt({
        base: null,
        edit: false,
        notes: [],
        cover: cover.image,
        signal: input.signal,
      });
      if ("refused" in r) {
        if (r.guard) drawn[slide]--;
        refusedFor[slide] = r.refused;
        if (r.guard || isServiceDown(r.code)) {
          failure = { message: r.refused, code: r.guard ? "DESIGN_REFUSED" : r.code };
          break;
        }
        continue;
      }
      const id = attemptId(slide, no);
      attempts.set(id, { slide, photo, frame: r, problems: r.problems });
      bySlide[slide].push(r);
    }
  }

  // What the post is made of: the agent's choice when it finished, otherwise
  // the best attempt at each slide, which is what the loop always kept.
  const frames = input.slides.map((_, i) => {
    if (chosen) return attempts.get(chosen[i])!.frame;
    return bySlide[i].reduce<DesignedFrame | null>((best, f) => betterDesign(best, f), null);
  });
  if (!failure && run.ended === "failed" && run.end && isServiceDown(run.end.code)) {
    failure = { message: run.end.message ?? "The art director is unavailable.", code: run.end.code };
  }
  if (!failure && frames.some((f) => !f)) {
    const i = frames.findIndex((f) => !f);
    failure = input.signal?.aborted
      ? { message: "Stopped." }
      : run.ended === "failed" && run.end
        ? { message: run.end.message ?? "This post could not be designed.", code: run.end.code }
        : { message: refusedFor[i] ?? `Slide ${i + 1} was never designed.` };
  }
  return {
    frames,
    drawings: drawn.reduce((s, d) => s + d, 0),
    failure,
    agent: { model, turns: run.usage.turns, usd: run.usd, ended: run.ended, finished: !!chosen },
  };
}
