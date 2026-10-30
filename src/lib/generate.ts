/**
 * The seam where somebody else's model is called.
 *
 * Every outside model in the product is reached through this file, for the
 * same reason `storage.ts` is the only place an object store is touched: the
 * key lives in one place, the timeout lives in one place, and a check can
 * swap the whole driver for one that returns a fixture instead of spending
 * money on a government-adjacent deadline.
 *
 * Four jobs, and they are not equal in what they are allowed to produce.
 * Copy is written by a model and then refused by `gateCopy()` unless every
 * number in it traces to a signed fact. A backdrop is never the building. A
 * designed post starts FROM the approved photo and is read back by a second
 * model so `judgeDesign()` can refuse one whose building changed. Video
 * animates a picture that was already approved rather than inventing one.
 *
 * `MODELS_DIR` is a dev and test seam, never set in production: it makes
 * every call read a canned response from disk. An injected driver beats it,
 * so a unit test is never quietly served a fixture it did not ask for.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesignReview, DesignSize } from "./compose-rules.ts";
import type { CardReading } from "./creative-rules.ts";
import { classifyRefusal, serviceMessage } from "./service-rules.ts";

const OPENAI = "https://api.openai.com/v1";
const HIGGSFIELD = "https://api.higgsfield.ai";

/** A model call is slow. It is not allowed to be slow forever. */
export const COPY_TIMEOUT_MS = 60_000;
export const IMAGE_TIMEOUT_MS = 180_000;
export const VIDEO_POLL_MS = 5_000;
export const VIDEO_TIMEOUT_MS = 600_000;

export type Fail = { ok: false; code: string; message: string };
export type Ok<T> = { ok: true } & T;
export type Result<T> = Ok<T> | Fail;

const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

/**
 * A key is absent rather than wrong far more often than the other way round,
 * and the two need different messages: one is "nobody configured this" and
 * the other is "somebody revoked it".
 */
function keyOr(name: string): string | null {
  const v = (process.env[name] ?? "").trim();
  return v.length ? v : null;
}

async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
  /** A stop from outside, which ends the call as surely as the clock does. */
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  // The race as well as the abort: an upload that ignored its signal held a
  // designed post for an hour, and a deadline that depends on the thing it
  // is timing to cooperate is not a deadline.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, ms);
  });
  const stop = () => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}

// ---------------------------------------------------------------------------
// The fixture seam
// ---------------------------------------------------------------------------

/**
 * A canned response, named after the request that asked for it.
 *
 * The name is a hash of the request rather than a counter, so a suite that
 * reorders its checks still reads the right file and a fixture that no longer
 * matches any request is visibly dead rather than silently wrong.
 */
async function fixture<T>(kind: string, request: unknown): Promise<T | null> {
  const dir = keyOr("MODELS_DIR");
  if (!dir) return null;
  const id = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16);
  const raw = await readFile(join(dir, `${kind}_${id}.json`), "utf8").catch(() => null);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export type CopyRequest = {
  model?: string;
  system: string;
  instruction: string;
  /**
   * A card in a script of its own (Hindi, Marathi): the place and each
   * approved point are asked for too, in that script. Absent on an English
   * card, so its request, and the fixture named after it, is unchanged.
   */
  local?: true;
};

/**
 * The stop signal travels BESIDE the request, never inside it. The fixture
 * seam names a canned response after a hash of the request, and a signal
 * folded into it would change every name and quietly miss every fixture.
 */
export type CopyDriver = (
  req: CopyRequest,
  opts?: { signal?: AbortSignal },
) => Promise<Result<{ copy: Record<string, unknown> }>>;

/** Small and current. The gate is what makes the copy safe, not the model. */
export const COPY_MODEL = "gpt-5-mini";

/**
 * Ask for three fields and nothing else.
 *
 * A strict schema is not a compliance control, it is a parsing convenience:
 * it stops the model wrapping prose around the JSON. Everything that matters
 * about what the model said is decided afterwards by `gateCopy()`.
 */
export const writeCopy: CopyDriver = async (req, opts) => {
  if (opts?.signal?.aborted) return fail("STOPPED", "Stopped before it was written.");
  const canned = await fixture<Result<{ copy: Record<string, unknown> }>>("copy", req);
  if (canned) return canned;

  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No copy model is configured.");

  const fields = {
    headline: { type: "string" },
    body: { type: "string" },
    cta: { type: "string" },
  };
  const body = {
    model: req.model ?? COPY_MODEL,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.instruction },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "ad_copy",
        strict: true,
        schema: req.local
          ? {
              type: "object",
              additionalProperties: false,
              required: ["headline", "body", "cta", "place", "points"],
              properties: { ...fields, place: { type: "string" }, points: { type: "array", items: { type: "string" } } },
            }
          : { type: "object", additionalProperties: false, required: ["headline", "body", "cta"], properties: fields },
      },
    },
  };

  const response = await withTimeout(
    COPY_TIMEOUT_MS,
    (signal) =>
      fetch(`${OPENAI}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    opts?.signal,
  ).catch(() => null);

  if (!response) {
    return opts?.signal?.aborted
      ? fail("STOPPED", "Stopped before it was written.")
      : fail("UNREACHABLE", "The copy model did not answer in time.");
  }
  if (!response.ok) {
    return await refused(response, "The copy model");
  }

  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) return fail("EMPTY", "The copy model returned nothing.");

  try {
    return { ok: true, copy: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return fail("UNPARSED", "The copy model returned something that was not the agreed shape.");
  }
};

/**
 * A card in Hindi read back into English, for the gate's word checks.
 *
 * A second call, not the writer's own account of what it wrote: a writer
 * grading its own homework grades it as correct. Small (`gpt-5-mini` at low
 * reasoning, its answer capped), and asked once per attempt at a card that is
 * not in English; about 10 paise.
 */
export type ReadRequest = {
  model?: string;
  system: string;
  instruction: string;
};

export type ReadDriver = (
  req: ReadRequest,
  opts?: { signal?: AbortSignal },
) => Promise<Result<{ reading: CardReading }>>;

export const READ_MODEL = "gpt-5-mini";

export const readCopy: ReadDriver = async (req, opts) => {
  if (opts?.signal?.aborted) return fail("STOPPED", "Stopped before it was read.");
  const canned = await fixture<Result<{ reading: CardReading }>>("read", req);
  if (canned) return canned;

  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No model is configured to read the card.");

  const body = {
    model: req.model ?? READ_MODEL,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.instruction },
    ],
    reasoning_effort: "low",
    max_completion_tokens: 4000,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "card_reading",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["headline", "body", "cta", "place", "points"],
          properties: {
            headline: { type: "string" },
            body: { type: "string" },
            cta: { type: "string" },
            place: { type: "string" },
            points: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };

  const response = await withTimeout(
    COPY_TIMEOUT_MS,
    (signal) =>
      fetch(`${OPENAI}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    opts?.signal,
  ).catch(() => null);
  if (!response) {
    return opts?.signal?.aborted
      ? fail("STOPPED", "Stopped before it was read.")
      : fail("UNREACHABLE", "The reading model did not answer in time.");
  }
  if (!response.ok) return await refused(response, "The reading model");

  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (!text) return fail("EMPTY", "The reading model returned nothing.");
  try {
    const r = JSON.parse(text) as Partial<CardReading>;
    return {
      ok: true,
      reading: {
        headline: String(r.headline ?? ""),
        body: String(r.body ?? ""),
        cta: String(r.cta ?? ""),
        place: r.place ? String(r.place) : null,
        points: Array.isArray(r.points) ? r.points.map((p) => String(p ?? "")) : [],
      },
    };
  } catch {
    return fail("UNPARSED", "The reading model returned something that was not the agreed shape.");
  }
};

// ---------------------------------------------------------------------------
// Backdrops
// ---------------------------------------------------------------------------

export type ImageRequest = {
  prompt: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  quality?: "low" | "medium" | "high";
  model?: string;
};

export type ImageDriver = (req: ImageRequest) => Promise<Result<{ bytes: Buffer; type: string }>>;

export const IMAGE_MODEL = "gpt-image-1-mini";

/**
 * A backdrop, sent exactly as it was handed over.
 *
 * The exclusions are appended by `addBackdrop()` and not here. They were here,
 * which meant they were a property of this one driver: an injected driver, or
 * a second provider added later, would have sent the raw prompt and drawn a
 * tower. A rule that only holds for one implementation of a seam is not a
 * rule, and this seam exists to be swapped.
 */
export const drawBackdrop: ImageDriver = async (req) => {
  const canned = await fixture<{ base64: string; type: string }>("image", req);
  if (canned) {
    return { ok: true, bytes: Buffer.from(canned.base64, "base64"), type: canned.type };
  }

  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No image model is configured.");

  const response = await withTimeout(IMAGE_TIMEOUT_MS, (signal) =>
    fetch(`${OPENAI}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model ?? IMAGE_MODEL,
        prompt: req.prompt,
        size: req.size ?? "1024x1024",
        quality: req.quality ?? "medium",
        n: 1,
      }),
      signal,
    }),
  ).catch(() => null);

  if (!response) return fail("UNREACHABLE", "The image model did not answer in time.");
  if (!response.ok) {
    return await refused(response, "The image model");
  }

  const json = (await response.json()) as { data?: { b64_json?: string }[] };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) return fail("EMPTY", "The image model returned no picture.");
  return { ok: true, bytes: Buffer.from(b64, "base64"), type: "image/png" };
};

// ---------------------------------------------------------------------------
// Designed posts
// ---------------------------------------------------------------------------

export type DesignRequest = {
  prompt: string;
  /** The approved photograph, and on a retry the failed attempt before it. */
  images: { bytes: Buffer; type: string }[];
  /** One of the model's sizes, or WIDTHxHEIGHT in multiples of 16. */
  size: DesignSize | string;
  quality?: "low" | "medium" | "high" | "xhigh" | "max";
  model?: string;
};

export type DesignDriver = (
  req: DesignRequest,
  opts?: { signal?: AbortSignal },
) => Promise<Result<{ bytes: Buffer; type: string }>>;

/**
 * GPT Image 2.5 Sunburst, the heavier 2.5 variant, recommended where editing
 * keeps a subject unchanged; chosen over gpt-image-1-mini on 24 September
 * 2026 after the mini's posts looked plainly worse beside the same brief in
 * ChatGPT. About Rs 7 an attempt at high quality against the mini's Rs 4.
 */
export const DESIGN_MODEL = process.env.DESIGN_MODEL || "gpt-image-2.5-sunburst";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * The model that plans an image the way ChatGPT does: it reads the request
 * and the pictures, writes the image model's actual prompt, and calls the
 * image tool. Sent straight to the Images API, our rules-heavy instruction
 * reached the image model word for word, and the posts looked it.
 */
export const DESIGN_PLANNER = process.env.DESIGN_PLANNER || "gpt-5.5";

/** A planned design waits on two models, so it gets longer than one image. */
const PLANNED_TIMEOUT_MS = 300_000;

/**
 * A finished ad. By default the instruction goes straight to the Images
 * API. `DESIGN_VIA=responses` puts a planning model in front
 * (`DESIGN_PLANNER`) through the Responses API's image tool, which is how
 * ChatGPT runs the same image model; on 25 September 2026 the two came back
 * equally good once the instruction itself was rewritten, so the cheaper,
 * faster path is the default. Either way, what comes back is checked by
 * `reviewDesign()` and judged by `judgeDesign()`; nothing here is trusted.
 */
export const designAd: DesignDriver = (req, opts) =>
  (process.env.DESIGN_VIA || "images") === "responses" ? designAdPlanned(req, opts) : designAdDirect(req, opts);

export const designAdPlanned: DesignDriver = async (req, opts) => {
  const canned = await fixture<{ base64: string; type: string }>("design", {
    prompt: req.prompt,
    size: req.size,
    model: req.model ?? DESIGN_MODEL,
    images: req.images.map((i) => sha(i.bytes)),
  });
  if (canned) return { ok: true, bytes: Buffer.from(canned.base64, "base64"), type: canned.type };

  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No image model is configured.");

  const body = {
    model: DESIGN_PLANNER,
    reasoning: { effort: "low" },
    instructions:
      "You are an art director at a top real estate advertising agency. Turn the request into one image by calling " +
      "the image generation tool exactly once, editing the first attached image. Keep every quoted piece of text " +
      "exactly as written, and keep every rule in the request. Do not reply with text.",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: req.prompt },
          ...req.images.map((i) => ({
            type: "input_image",
            image_url: `data:${i.type};base64,${i.bytes.toString("base64")}`,
          })),
        ],
      },
    ],
    tools: [
      {
        type: "image_generation",
        model: req.model ?? DESIGN_MODEL,
        size: req.size,
        quality: req.quality ?? "high",
        output_format: "png",
        action: "edit",
      },
    ],
    tool_choice: { type: "image_generation" },
  };

  const call = () =>
    withTimeout(
      PLANNED_TIMEOUT_MS,
      async (signal) => {
        const r = await fetch(`${OPENAI}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!r.ok) return { ok: false as const, fail: await refused(r, "The image model") };
        return {
          ok: true as const,
          json: (await r.json()) as { output?: { type?: string; result?: string; revised_prompt?: string }[] },
        };
      },
      opts?.signal,
    ).catch((e: unknown) => ({ ok: null, timedOut: e instanceof Error && e.message === "timeout" }) as const);

  let answer = await call();
  if (answer.ok === null && !answer.timedOut && !opts?.signal?.aborted) answer = await call();
  if (answer.ok === null) {
    return answer.timedOut
      ? fail("UNREACHABLE", "The image model did not answer in time.")
      : fail("UNREACHABLE", "The image model could not be reached. Try again.");
  }
  if (!answer.ok) return answer.fail;
  const made = answer.json.output?.find((o) => o.type === "image_generation_call" && o.result);
  if (!made?.result) return fail("EMPTY", "The image model returned no picture.");
  return { ok: true, bytes: Buffer.from(made.result, "base64"), type: "image/png" };
};

/**
 * The same, straight to the Images API's edits endpoint, so the photograph
 * is what the model starts from rather than a sentence about it.
 */
export const designAdDirect: DesignDriver = async (req, opts) => {
  const canned = await fixture<{ base64: string; type: string }>("design", {
    prompt: req.prompt,
    size: req.size,
    model: req.model ?? DESIGN_MODEL,
    images: req.images.map((i) => sha(i.bytes)),
  });
  if (canned) return { ok: true, bytes: Buffer.from(canned.base64, "base64"), type: canned.type };

  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No image model is configured.");

  const form = new FormData();
  form.append("model", req.model ?? DESIGN_MODEL);
  form.append("prompt", req.prompt);
  form.append("size", req.size);
  form.append("quality", req.quality ?? "high");
  form.append("n", "1");
  req.images.forEach((img, i) => {
    const ext = img.type === "image/png" ? "png" : img.type === "image/webp" ? "webp" : "jpg";
    form.append("image[]", new Blob([new Uint8Array(img.bytes)], { type: img.type }), `image${i}.${ext}`);
  });

  // The clock covers reading the body too. A picture is megabytes, and a
  // response whose headers arrived and whose body then stalled held a post
  // (and the screen's placeholder) for an hour when only the headers were
  // timed.
  const call = () =>
    withTimeout(
      IMAGE_TIMEOUT_MS,
      async (signal) => {
        const r = await fetch(`${OPENAI}/images/edits`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: form,
          signal,
        });
        if (!r.ok) return { ok: false as const, fail: await refused(r, "The image model") };
        return { ok: true as const, json: (await r.json()) as { data?: { b64_json?: string }[] } };
      },
      opts?.signal,
    ).catch((e: unknown) => ({ ok: null, timedOut: e instanceof Error && e.message === "timeout" }) as const);

  // A dropped connection is asked once more; a timeout or a stop is not,
  // because a second wait of the same length is the same answer, later.
  let answer = await call();
  if (answer.ok === null && !answer.timedOut && !opts?.signal?.aborted) answer = await call();
  if (answer.ok === null) {
    return answer.timedOut
      ? fail("UNREACHABLE", "The image model did not answer in time.")
      : fail("UNREACHABLE", "The image model could not be reached. Try again.");
  }
  if (!answer.ok) return answer.fail;
  const b64 = answer.json.data?.[0]?.b64_json;
  if (!b64) return fail("EMPTY", "The image model returned no picture.");
  return { ok: true, bytes: Buffer.from(b64, "base64"), type: "image/png" };
};

export type ChooseRequest = { system: string; instruction: string; keys: string[]; model?: string };

export type ChooseDriver = (
  req: ChooseRequest,
  opts?: { signal?: AbortSignal },
) => Promise<Result<{ key: string }>>;

/**
 * Pick one design category for a card. The schema's enum is the shortlist,
 * and the answer is still checked against it by `templateFromAnswer()`,
 * because a schema is a parsing convenience rather than a control.
 */
export const chooseTemplateModel: ChooseDriver = async (req, opts) => {
  const canned = await fixture<Result<{ key: string }>>("template", req);
  if (canned) return canned;
  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No model is configured.");
  const body = {
    model: req.model ?? COPY_MODEL,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.instruction },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "template_choice",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["key"],
          properties: { key: { type: "string", enum: req.keys } },
        },
      },
    },
  };
  const answer = await withTimeout(
    COPY_TIMEOUT_MS,
    async (signal) => {
      const r = await fetch(`${OPENAI}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!r.ok) return { ok: false as const, fail: await refused(r, "The model") };
      return { ok: true as const, json: (await r.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } };
    },
    opts?.signal,
  ).catch(() => null);
  if (!answer) return fail("UNREACHABLE", "The model did not answer in time.");
  if (!answer.ok) return answer.fail;
  try {
    const parsed = JSON.parse(answer.json.choices?.[0]?.message?.content ?? "") as { key?: string };
    return parsed.key ? { ok: true, key: parsed.key } : fail("EMPTY", "The model chose nothing.");
  } catch {
    return fail("UNPARSED", "The model returned something that was not the agreed shape.");
  }
};

export type ReviewRequest = {
  /** The finished frame, then the approved photograph it was designed from. */
  frame: { bytes: Buffer; type: string };
  reference: { bytes: Buffer; type: string };
  model?: string;
};

export type ReviewDriver = (
  req: ReviewRequest,
  opts?: { signal?: AbortSignal },
) => Promise<Result<{ review: DesignReview }>>;

const REVIEW_SYSTEM = [
  "You check finished real-estate advertisements before they are published. Report only what you see.",
  "Image 1 is the finished advertisement. Image 2 is the approved photograph of the property it was designed from.",
  "texts: every piece of text in the design, each line exactly as written, including misspellings and small print. Do NOT include the words inside the brand logo, or the QR code itself.",
  "registration: the RERA registration number printed in the registration block (beside the QR code, or in a strip along the bottom), exactly as printed, or an empty string.",
  "phone: the phone number printed along the bottom, exactly as printed, or an empty string.",
  "text_cut_off: true if any text is cut off by an edge or partly covered by another element.",
  "building_matches: true if the building in image 1 is clearly the same property/building shown in image 2 (same architectural design, materials, and overall structure, allowing for advertisement framing, wide or split banner layouts, cropping, banners, drapery/curtains, lighting, perspective, and artistic impression). If image 2 does not depict a recognizable exterior building (e.g. it is a placeholder graphic, swatch, logo, interior room, amenity, or site photo), return true. False only if image 2 shows a specific building and an entirely different building was substituted or the structure was fundamentally changed.",
  "building_issues: what differs, in one short sentence, or an empty string.",
  "looks_like_ad: true if this looks like a polished, professional advertisement a developer would publish.",
  "design_issues: what would make it look more professional, in one short sentence, or an empty string.",
  "rera_website: the RERA authority's website address printed beside the registration number (for example maharera.maharashtra.gov.in or rera.karnataka.gov.in), exactly as printed, or an empty string.",
  "rera_top_right: true if the QR code (when there is one), the registration number and the RERA authority's website all sit in the upper-right quarter of the advertisement.",
  "rera_at_bottom: true if the registration number and the RERA authority's website sit together in a strip along the bottom edge of the advertisement.",
  "rera_text_large_enough: true if the RERA registration number is set at least as large as the contact phone number. False only if the registration number is visibly smaller in type size than the phone number.",
  "panel_covers_content: true if the white registration panel with the QR code sits on top of an important part of the design: the building, a person, a headline or other text, or the focal point. False if it sits on sky, a plain area or a calm background.",
].join("\n");

/**
 * The post-generation checker: a second model that READS the frame.
 *
 * It is asked what it sees, never whether the ad is compliant. The verdict
 * is `judgeDesign()`'s, in code, comparing what was read with what should be
 * there, for the reason the copy gate is code and not a prompt.
 */
export const reviewDesign: ReviewDriver = async (req, opts) => {
  const canned = await fixture<Result<{ review: DesignReview }>>("review", {
    frame: sha(req.frame.bytes),
    reference: sha(req.reference.bytes),
    model: req.model ?? COPY_MODEL,
  });
  if (canned) return canned;

  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No checking model is configured.");

  const url = (i: { bytes: Buffer; type: string }) => `data:${i.type};base64,${i.bytes.toString("base64")}`;
  const body = {
    model: req.model ?? COPY_MODEL,
    messages: [
      { role: "system", content: REVIEW_SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: "Image 1, the finished advertisement:" },
          { type: "image_url", image_url: { url: url(req.frame), detail: "high" } },
          { type: "text", text: "Image 2, the approved photograph:" },
          { type: "image_url", image_url: { url: url(req.reference), detail: "high" } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "ad_review",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: [
            "texts",
            "registration",
            "phone",
            "text_cut_off",
            "building_matches",
            "building_issues",
            "looks_like_ad",
            "design_issues",
            "panel_covers_content",
            "rera_website",
            "rera_top_right",
            "rera_at_bottom",
            "rera_text_large_enough",
          ],
          properties: {
            texts: { type: "array", items: { type: "string" } },
            registration: { type: "string" },
            phone: { type: "string" },
            text_cut_off: { type: "boolean" },
            building_matches: { type: "boolean" },
            building_issues: { type: "string" },
            looks_like_ad: { type: "boolean" },
            design_issues: { type: "string" },
            panel_covers_content: { type: "boolean" },
            rera_website: { type: "string" },
            rera_top_right: { type: "boolean" },
            rera_at_bottom: { type: "boolean" },
            rera_text_large_enough: { type: "boolean" },
          },
        },
      },
    },
  };

  const answer = await withTimeout(
    COPY_TIMEOUT_MS * 2,
    async (signal) => {
      const r = await fetch(`${OPENAI}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!r.ok) return { ok: false as const, fail: await refused(r, "The checking model") };
      return { ok: true as const, json: (await r.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } };
    },
    opts?.signal,
  ).catch(() => null);

  if (!answer) return fail("UNREACHABLE", "The checking model did not answer in time.");
  if (!answer.ok) return answer.fail;
  const text = answer.json.choices?.[0]?.message?.content;
  if (!text) return fail("EMPTY", "The checking model returned nothing.");
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    return {
      ok: true,
      review: {
        texts: Array.isArray(r.texts) ? r.texts.map(String) : [],
        registration: String(r.registration ?? ""),
        phone: String(r.phone ?? ""),
        textCutOff: r.text_cut_off === true,
        buildingMatches: r.building_matches === true,
        buildingIssues: String(r.building_issues ?? ""),
        looksLikeAd: r.looks_like_ad === true,
        designIssues: String(r.design_issues ?? ""),
        panelCoversContent: r.panel_covers_content === true,
        reraWebsite: String(r.rera_website ?? ""),
        reraTopRight: r.rera_top_right === true,
        reraAtBottom: r.rera_at_bottom === true,
        reraTextLargeEnough: r.rera_text_large_enough === true,
      },
    };
  } catch {
    return fail("UNPARSED", "The checking model returned something that was not the agreed shape.");
  }
};

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export type AnimateRequest = {
  /** The finished, checked frame. Motion is applied to it; nothing is drawn anew. */
  image: { bytes: Buffer; type: string };
  prompt: string;
  negativePrompt: string;
  /** Seconds. Kling 2.5 makes five or ten; Kling 3.0 any whole number from three to fifteen. */
  duration: number;
  /** How closely it keeps to the prompt, from 0 to 1. */
  cfgScale: number;
  /** The model, when not `VIDEO_MODEL`. */
  model?: string;
  /** Kling 3.0 makes its own sound unless told not to; a reel lays its own. */
  sound?: "on" | "off";
  /**
   * A line to lip-sync the person in the frame to (Wan 2.7): the presenter of
   * an agent on camera speaks their own recorded words. The clip comes back
   * with this audio in it; the reel lays the same file itself.
   */
  audio?: { bytes: Buffer; type: string };
  /** For a model that asks: 720p or 1080p. */
  resolution?: "720p" | "1080p";
};

export type AnimateDriver = (
  req: AnimateRequest,
  opts?: { signal?: AbortSignal },
) => Promise<Result<{ bytes: Buffer; type: string }>>;

/**
 * Image to video, never text to video, through OpenRouter since 5 October
 * 2026 (the client: every video through OpenRouter). `VIDEO_MODEL` overrides
 * the model.
 *
 * A video model will happily write a tower from a sentence, and that tower
 * is the one thing this product may not put on an advertisement. Starting
 * from a designed frame that already passed its check means the motion is
 * the only thing this model contributes, and the frame is checked again
 * after.
 *
 * The three-frame studio video was Kling 2.5 Turbo on Higgsfield ($0.07 a
 * second at 1080p); OpenRouter carries no 2.5, so it is Kling 3.0 Standard
 * ($0.084 a second, 720p, sound off). The story reel's clips are Kling 3.0
 * Pro ($0.112 a second here against $0.168 on Higgsfield), and the old
 * presenter branch's Wan 2.7 ($0.10 a second). `doc/pricing.md` has them.
 */
export const VIDEO_MODEL = openRouterVideoModel(process.env.VIDEO_MODEL) || "kwaivgi/kling-v3.0-std";

/**
 * A model named the Higgsfield way, as an older `.env` or a stored plan may
 * still say it, read as OpenRouter's own id. Anything else is taken as given.
 */
export function openRouterVideoModel(name: string | undefined | null): string {
  if (!name) return "";
  if (name.startsWith("kling-video/v2.5")) return "kwaivgi/kling-v3.0-std";
  if (name.startsWith("kling-video/v3.0/std")) return "kwaivgi/kling-v3.0-std";
  if (name.startsWith("kling-video/v3.0")) return "kwaivgi/kling-v3.0-pro";
  if (name.startsWith("wan/v2.7")) return "alibaba/wan-2.7";
  return name;
}

/** What each model makes, from OpenRouter's own catalogue of 5 October 2026. */
function videoLimits(model: string): { min: number; max: number; resolutions: readonly string[] } {
  if (model.startsWith("alibaba/wan-2.7")) return { min: 2, max: 10, resolutions: ["720p", "1080p"] };
  if (model.startsWith("kwaivgi/kling-v3.0")) return { min: 3, max: 15, resolutions: ["720p"] };
  return { min: 3, max: 15, resolutions: ["720p"] };
}

/** The provider that serves Kling and Wan on OpenRouter, for their passthrough fields. */
const VIDEO_PASSTHROUGH = "atlas-cloud";

/**
 * Billed from the OpenRouter balance, like the films. The frame (and a
 * presenter's line) are put in our own bucket under `film-ref/` and handed
 * over as presigned links, then removed once the clip is back or failed.
 * OpenRouter has no cancel: a stop leaves a queued clip to run.
 */
export const animateFrame: AnimateDriver = async (req, opts) => {
  const key = keyOr("OPENROUTER_API_KEY");
  if (!key) return fail("NO_KEY", "No video model is configured.");
  const auth = { authorization: `Bearer ${key}` };
  const signal = opts?.signal;
  if (signal?.aborted) return fail("STOPPED", "Stopped.");
  const model = openRouterVideoModel(req.model) || VIDEO_MODEL;
  const limits = videoLimits(model);

  const placed: string[] = [];
  const cleanUp = async () => {
    if (!placed.length) return;
    const { storage } = await import("./storage.ts");
    await Promise.all(placed.map((k) => storage().remove(k).catch(() => {})));
  };
  const { storage } = await import("./storage.ts");
  const place = async (f: { bytes: Buffer; type: string }): Promise<string | null> => {
    const ext = f.type.includes("png") ? "png" : f.type.includes("webp") ? "webp" : f.type.startsWith("audio/") ? "wav" : "jpg";
    const k = `film-ref/${createHash("sha256").update(f.bytes).digest("hex").slice(0, 32)}.${ext}`;
    try {
      await storage().put(k, f.bytes, f.type);
      placed.push(k);
      return await storage().signedUrl(k, FILM_REF_SECONDS, f.type);
    } catch {
      return null;
    }
  };
  const image = await place(req.image);
  if (!image) return (await cleanUp(), fail("UNREACHABLE", "The picture could not be handed to the video service. Try again."));
  const audio = req.audio ? await place(req.audio) : null;
  if (req.audio && !audio) return (await cleanUp(), fail("UNREACHABLE", "The voice could not be handed to the video service. Try again."));

  // The frame's own shape decides the clip's: a reel is tall, YouTube wide.
  const { default: sharp } = await import("sharp");
  const meta = await sharp(req.image.bytes).metadata().catch(() => null);
  const ratio = meta?.width && meta?.height ? meta.width / meta.height : 9 / 16;
  const aspect = ratio > 1.2 ? "16:9" : ratio < 0.83 ? "9:16" : "1:1";
  const wanted = req.resolution ?? "720p";
  const resolution = limits.resolutions.includes(wanted) ? wanted : limits.resolutions[0];
  const duration = Math.max(limits.min, Math.min(limits.max, Math.round(req.duration)));

  const started = await withTimeout(COPY_TIMEOUT_MS, (s) =>
    fetch(`${OPENROUTER}/videos`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: req.prompt,
        frame_images: [{ type: "image_url", image_url: { url: image }, frame_type: "first_frame" }],
        duration,
        resolution,
        aspect_ratio: aspect,
        // Sound is laid by us, and Kling's own sound costs half as much again.
        generate_audio: false,
        provider: {
          options: {
            [VIDEO_PASSTHROUGH]: {
              ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
              ...(model.startsWith("kwaivgi/") ? { cfg_scale: req.cfgScale } : {}),
              ...(audio ? { audio } : {}),
            },
          },
        },
      }),
      signal: s,
    }), signal,
  ).catch(() => null);
  if (!started) return (await cleanUp(), fail("UNREACHABLE", "The video service did not answer in time."));
  // A balance run dry is an account to top up, and `classifyRefusal()` says so.
  if (!started.ok) return (await cleanUp(), await refused(started, "The video service"));
  const j = (await started.json()) as { id?: string; polling_url?: string };
  if (!j.id) return (await cleanUp(), fail("AI_FAILED", serviceMessage("AI_FAILED")!));
  const statusUrl = j.polling_url ? new URL(j.polling_url, "https://openrouter.ai").toString() : `${OPENROUTER}/videos/${j.id}`;

  // Rendering takes a few minutes, so the request is a job and the answer
  // arrives later.
  const until = Date.now() + VIDEO_TIMEOUT_MS;
  while (Date.now() < until) {
    if (signal?.aborted) return (await cleanUp(), fail("STOPPED", "Stopped."));
    await new Promise((r) => setTimeout(r, VIDEO_POLL_MS));
    const poll = await withTimeout(COPY_TIMEOUT_MS, (s) => fetch(statusUrl, { headers: auth, signal: s }), signal).catch(() => null);
    if (!poll?.ok) continue;
    const state = (await poll.json().catch(() => ({}))) as { status?: string; unsigned_urls?: string[]; error?: string | null };
    if (state.status === "completed") {
      await cleanUp();
      const url = state.unsigned_urls?.[0] ?? `${OPENROUTER}/videos/${j.id}/content?index=0`;
      const got = await withTimeout(120_000, (s) => fetch(url, { headers: auth, signal: s }), signal).catch(() => null);
      if (!got?.ok) return fail("UNREACHABLE", "The finished video could not be fetched. Try again.");
      return { ok: true, bytes: Buffer.from(await got.arrayBuffer()), type: "video/mp4" };
    }
    if (state.status === "cancelled" || state.status === "expired") {
      await cleanUp();
      return fail("AI_FAILED", serviceMessage("AI_FAILED")!);
    }
    if (state.status === "failed") {
      await cleanUp();
      const why = String(state.error ?? "");
      console.error("The video service failed a clip:", why.slice(0, 400));
      const { code, message } = classifyRefusal(400, JSON.stringify({ error: { message: why } }));
      return fail(code, message);
    }
  }
  await cleanUp();
  return fail("UNREACHABLE", "The video was still rendering after ten minutes.");
};

/**
 * A file up to Higgsfield's own storage, so nothing of ours needs a public
 * link. Its presigned PUT must not carry our key.
 */
async function higgsfieldPlace(
  json: Record<string, string>,
  file: { bytes: Buffer; type: string },
  signal?: AbortSignal,
): Promise<Result<{ url: string }>> {
  const slot = await withTimeout(COPY_TIMEOUT_MS, (s) =>
    fetch(`${HIGGSFIELD}/files/generate-upload-url`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ content_type: file.type }),
      signal: s,
    }), signal,
  ).catch(() => null);
  if (!slot) return fail("UNREACHABLE", "The video service did not answer in time.");
  if (!slot.ok) return await refused(slot, "The video service");
  const upload = (await slot.json()) as { public_url?: string; upload_url?: string; upload_headers?: Record<string, string> };
  if (!upload.public_url || !upload.upload_url) return fail("AI_FAILED", "This could not be generated. Please try again.");
  // A film sent back in for a new version is tens of megabytes.
  const put = await withTimeout(file.bytes.length > 5_000_000 ? 300_000 : COPY_TIMEOUT_MS, (s) =>
    fetch(upload.upload_url!, {
      method: "PUT",
      headers: upload.upload_headers ?? { "content-type": file.type },
      body: new Uint8Array(file.bytes),
      signal: s,
    }), signal,
  ).catch(() => null);
  if (!put?.ok) return fail("UNREACHABLE", "The video service could not take the file. Try again.");
  return { ok: true, url: upload.public_url };
}

// ---------------------------------------------------------------------------
// A whole film in one generation
// ---------------------------------------------------------------------------

/**
 * Seedance 2.5 reference-to-video: the approved pictures as `@Image`
 * references, a scene-by-scene prompt, and back comes the whole film with its
 * voice, music and text. `FILM_MODEL` overrides the model.
 *
 * Made through OpenRouter since 2 October 2026 (`FILM_PROVIDER`, default
 * `openrouter`): the same model at ByteDance's own rate, $0.0107 a thousand
 * video tokens, about $6.94 (Rs 632) for thirty seconds at 720p, and
 * $0.0064 a thousand when a film is sent back in. Higgsfield charged twice
 * that ($0.4622 a second at 720p) and is kept behind `FILM_PROVIDER=
 * higgsfield`; a film already asked of it is still collected from it.
 * `doc/pricing.md` has both.
 */
export const FILM_PROVIDER = (process.env.FILM_PROVIDER || "openrouter") as "openrouter" | "higgsfield";
export const FILM_MODEL =
  process.env.FILM_MODEL || (FILM_PROVIDER === "higgsfield" ? "bytedance/seedance-2.5/reference-to-video" : "bytedance/seedance-2.5");
export const FILM_RESOLUTION = (process.env.FILM_RESOLUTION || "720p") as "480p" | "720p" | "1080p";
/** The first live film took about twenty minutes in Higgsfield's queue and render. */
export const FILM_TIMEOUT_MS = 45 * 60_000;
const FILM_POLL_MS = 15_000;

export type FilmRequest = {
  prompt: string;
  /** Approved pictures, in @Image order. */
  images: { bytes: Buffer; type: string }[];
  /** A film to make again, as @Video1. */
  videos?: { bytes: Buffer; type: string }[];
  /** Her voice, recorded already, as @Audio1: the film is made to it (`voice-track.ts`). OpenRouter only. */
  audios?: { bytes: Buffer; type: string }[];
  seconds: number;
  aspect: "9:16" | "16:9";
  resolution?: "480p" | "720p" | "1080p";
  model?: string;
  /** False for a scene made to be laid over the film's own sound. */
  audio?: boolean;
};

/** A submitted film, kept on the job so a worker that dies mid-wait asks after it rather than paying again. */
export type FilmJob = { requestId: string; statusUrl: string; cancelUrl: string | null };

export type FilmDriver = (
  req: FilmRequest,
  opts?: {
    signal?: AbortSignal;
    /** A film already asked for: wait for it rather than submitting again. */
    job?: FilmJob | null;
    /** Told once the film is asked for, before the wait, so the job can remember it. */
    onSubmitted?: (job: FilmJob) => Promise<void>;
    /** Told on every poll, so the worker can renew its lease and see a stop. */
    onWait?: (status: string) => Promise<void>;
  },
) => Promise<Result<{ bytes: Buffer; type: string; job: FilmJob }>>;

/**
 * The film, from whichever provider makes it. A film already asked of one
 * provider is collected from that provider, whatever the setting says now.
 */
export const filmScenes: FilmDriver = async (req, opts) => {
  const asked = opts?.job?.statusUrl;
  if (asked) return asked.startsWith(HIGGSFIELD) ? higgsfieldFilm(req, opts) : openRouterFilm(req, opts);
  return FILM_PROVIDER === "higgsfield" ? higgsfieldFilm(req, opts) : openRouterFilm(req, opts);
};

const OPENROUTER = "https://openrouter.ai/api/v1";

/**
 * What films asked for in this process and not yet back are expected to cost,
 * in dollars: OpenRouter bills a film when it finishes, so the balance does
 * not yet show them (8 October 2026: takes asked for in parallel finished
 * after the balance reached zero and left it $25.77 below it).
 */
let pendingFilmUsd = 0;
/** Seedance 2.5 at 720p, a second; a film sent in as a reference is billed too, about 1.6 times as much. */
export const filmUsdEstimate = (seconds: number, withVideo: boolean) => seconds * 0.231 * (withVideo ? 1.6 : 1);

/**
 * Refused before anything is asked of OpenRouter when its balance, less what
 * is already rendering here, cannot pay for this film. A balance that cannot
 * be read refuses nothing (an outage is not an empty account).
 */
async function openRouterCanPay(key: string, usd: number): Promise<boolean> {
  const r = await fetch(`${OPENROUTER}/credits`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!r?.ok) return true;
  const j = (await r.json().catch(() => null)) as { data?: { total_credits?: number; total_usage?: number } } | null;
  const left = Number(j?.data?.total_credits) - Number(j?.data?.total_usage);
  if (!Number.isFinite(left)) return true;
  return left - pendingFilmUsd >= usd;
}

/** How long the references stay readable: a film can wait in the queue before its pictures are fetched. */
const FILM_REF_SECONDS = 6 * 3600;

/**
 * Seedance 2.5 through OpenRouter (`POST /videos`, then poll). The model
 * fetches every reference from a public link, so each picture (and a film
 * sent back in) is put in our own bucket under `film-ref/` and handed over
 * as a presigned link for six hours, then removed once the film is back or
 * has failed. OpenRouter has no cancel: a stop leaves a queued film to run.
 */
const openRouterFilm: FilmDriver = async (req, opts) => {
  const key = keyOr("OPENROUTER_API_KEY");
  // A film already asked for is collected whatever the balance; a new one is
  // asked only when the balance can pay for it and what is still rendering.
  if (!key || opts?.job) return openRouterFilmOnce(req, opts);
  const estimate = filmUsdEstimate(req.seconds, !!req.videos?.length);
  if (!(await openRouterCanPay(key, estimate))) {
    return fail("OUT_OF_CREDITS", "The video service's balance cannot pay for this film. Add credits and try again.");
  }
  pendingFilmUsd += estimate;
  try {
    return await openRouterFilmOnce(req, opts);
  } finally {
    pendingFilmUsd = Math.max(0, pendingFilmUsd - estimate);
  }
};

/** A reference picture cut to the shape Seedance takes (`aspectCrop()`); any other file as it is. */
async function withinFilmAspect(f: { bytes: Buffer; type: string }): Promise<{ bytes: Buffer; type: string }> {
  if (!f.type.startsWith("image/")) return f;
  try {
    const { aspectCrop } = await import("./film-rules.ts");
    const sharp = (await import("sharp")).default;
    const meta = await sharp(f.bytes).rotate().metadata();
    const w = meta.autoOrient?.width ?? meta.width ?? 0;
    const h = meta.autoOrient?.height ?? meta.height ?? 0;
    const box = aspectCrop(w, h);
    if (!box) return f;
    return { bytes: await sharp(f.bytes).rotate().extract(box).jpeg({ quality: 92 }).toBuffer(), type: "image/jpeg" };
  } catch {
    return f;
  }
}

const openRouterFilmOnce: FilmDriver = async (req, opts) => {
  const key = keyOr("OPENROUTER_API_KEY");
  if (!key) return fail("NO_KEY", "No video model is configured.");
  const auth = { authorization: `Bearer ${key}` };
  const signal = opts?.signal;
  if (signal?.aborted) return fail("STOPPED", "Stopped.");

  const placed: string[] = [];
  const cleanUp = async () => {
    if (!placed.length) return;
    const { storage } = await import("./storage.ts");
    await Promise.all(placed.map((k) => storage().remove(k).catch(() => {})));
  };

  let job = opts?.job ?? null;
  if (!job) {
    const { storage } = await import("./storage.ts");
    const place = async (f: { bytes: Buffer; type: string }): Promise<string | null> => {
      const ext = f.type.includes("png")
        ? "png"
        : f.type.includes("webp")
          ? "webp"
          : f.type.startsWith("video/")
            ? "mp4"
            : f.type.startsWith("audio/")
              ? f.type.includes("wav") ? "wav" : "mp3"
              : "jpg";
      const k = `film-ref/${createHash("sha256").update(f.bytes).digest("hex").slice(0, 32)}.${ext}`;
      try {
        await storage().put(k, f.bytes, f.type);
        placed.push(k);
        return await storage().signedUrl(k, FILM_REF_SECONDS, f.type);
      } catch {
        return null;
      }
    };
    const refs: object[] = [];
    for (const f of req.images) {
      const url = await place(await withinFilmAspect(f));
      if (!url) return (await cleanUp(), fail("UNREACHABLE", "The pictures could not be handed to the video service. Try again."));
      refs.push({ type: "image_url", image_url: { url } });
    }
    for (const f of req.videos ?? []) {
      const url = await place(f);
      if (!url) return (await cleanUp(), fail("UNREACHABLE", "The film could not be handed to the video service. Try again."));
      refs.push({ type: "video_url", video_url: { url } });
    }
    for (const f of req.audios ?? []) {
      const url = await place(f);
      if (!url) return (await cleanUp(), fail("UNREACHABLE", "Her voice could not be handed to the video service. Try again."));
      refs.push({ type: "audio_url", audio_url: { url } });
    }
    const started = await withTimeout(COPY_TIMEOUT_MS, (s) =>
      fetch(`${OPENROUTER}/videos`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          model: req.model ?? FILM_MODEL,
          prompt: req.prompt,
          input_references: refs,
          duration: req.seconds,
          // OpenRouter's Seedance 2.5 offers 480p and 720p only.
          resolution: (req.resolution ?? FILM_RESOLUTION) === "1080p" ? "720p" : (req.resolution ?? FILM_RESOLUTION),
          aspect_ratio: req.aspect,
          generate_audio: req.audio ?? true,
          provider: { options: { byteplus: { watermark: false } } },
        }),
        signal: s,
      }), signal,
    ).catch(() => null);
    if (!started) return (await cleanUp(), fail("UNREACHABLE", "The video service did not answer in time."));
    if (!started.ok) return (await cleanUp(), await refused(started, "The video service"));
    const j = (await started.json()) as { id?: string; polling_url?: string };
    if (!j.id) return (await cleanUp(), fail("AI_FAILED", serviceMessage("AI_FAILED")!));
    const statusUrl = j.polling_url
      ? new URL(j.polling_url, "https://openrouter.ai").toString()
      : `${OPENROUTER}/videos/${j.id}`;
    job = { requestId: j.id, statusUrl, cancelUrl: null };
    await opts?.onSubmitted?.(job);
  }

  const until = Date.now() + FILM_TIMEOUT_MS;
  while (Date.now() < until) {
    if (signal?.aborted) return fail("STOPPED", "Stopped.");
    await new Promise((r) => setTimeout(r, FILM_POLL_MS));
    const poll = await withTimeout(COPY_TIMEOUT_MS, (s) => fetch(job!.statusUrl, { headers: auth, signal: s }), signal).catch(() => null);
    if (!poll?.ok) continue;
    const state = (await poll.json().catch(() => ({}))) as {
      status?: string;
      unsigned_urls?: string[];
      error?: string | null;
      usage?: { cost?: number | null };
    };
    await opts?.onWait?.(String(state.status ?? ""));
    if (state.status === "completed") {
      await cleanUp();
      const url = state.unsigned_urls?.[0] ?? `${OPENROUTER}/videos/${job.requestId}/content?index=0`;
      const got = await withTimeout(300_000, (s) => fetch(url, { headers: auth, signal: s }), signal).catch(() => null);
      if (!got?.ok) return fail("UNREACHABLE", "The finished video could not be fetched. Try again.");
      if (state.usage?.cost != null) console.log(`Film ${job.requestId} cost $${state.usage.cost}`);
      return { ok: true, bytes: Buffer.from(await got.arrayBuffer()), type: "video/mp4", job };
    }
    if (state.status === "cancelled" || state.status === "expired") {
      await cleanUp();
      return fail("CANCELED", "The video was cancelled before it was made. Try again.");
    }
    if (state.status === "failed") {
      await cleanUp();
      const why = String(state.error ?? "");
      console.error("The video service failed a film:", why.slice(0, 400));
      const { code, message } = classifyRefusal(400, JSON.stringify({ error: { message: why } }));
      return fail(code, message);
    }
  }
  return fail("UNREACHABLE", "The video was still being made after forty-five minutes.");
};

/** Seedance 2.5 on Higgsfield, the provider before OpenRouter (`FILM_PROVIDER=higgsfield`). */
const higgsfieldFilm: FilmDriver = async (req, opts) => {
  const id = keyOr("HIGGSFIELD_API_KEY");
  const secret = keyOr("HIGGSFIELD_API_SECRET");
  if (!id || !secret) return fail("NO_KEY", "No video model is configured.");
  const auth = { authorization: `Key ${id}:${secret}` };
  const json = { ...auth, "content-type": "application/json" };
  const signal = opts?.signal;
  if (signal?.aborted) return fail("STOPPED", "Stopped.");

  let job = opts?.job ?? null;
  if (!job) {
    const images: string[] = [];
    for (const f of req.images) {
      const placed = await higgsfieldPlace(json, f, signal);
      if (!placed.ok) return placed;
      images.push(placed.url);
    }
    const videos: string[] = [];
    for (const f of req.videos ?? []) {
      const placed = await higgsfieldPlace(json, f, signal);
      if (!placed.ok) return placed;
      videos.push(placed.url);
    }
    const started = await withTimeout(COPY_TIMEOUT_MS, (s) =>
      fetch(`${HIGGSFIELD}/${req.model ?? FILM_MODEL}`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          prompt: req.prompt,
          image_urls: images,
          ...(videos.length ? { video_urls: videos } : {}),
          duration: req.seconds,
          resolution: req.resolution ?? FILM_RESOLUTION,
          aspect_ratio: req.aspect,
          bitrate_mode: "high",
          generate_audio: true,
        }),
        signal: s,
      }), signal,
    ).catch(() => null);
    if (!started) return fail("UNREACHABLE", "The video service did not answer in time.");
    if (!started.ok) return await refused(started, "The video service");
    const j = (await started.json()) as { request_id?: string; status_url?: string; cancel_url?: string };
    const statusUrl = j.status_url ?? (j.request_id ? `${HIGGSFIELD}/requests/${j.request_id}/status` : null);
    if (!j.request_id || !statusUrl) return fail("AI_FAILED", serviceMessage("AI_FAILED")!);
    job = { requestId: j.request_id, statusUrl, cancelUrl: j.cancel_url ?? null };
    await opts?.onSubmitted?.(job);
  }

  const until = Date.now() + FILM_TIMEOUT_MS;
  while (Date.now() < until) {
    if (signal?.aborted) {
      // Only a queued film can be cancelled; one already rendering is paid for.
      if (job.cancelUrl) await fetch(job.cancelUrl, { method: "POST", headers: auth }).catch(() => null);
      return fail("STOPPED", "Stopped.");
    }
    await new Promise((r) => setTimeout(r, FILM_POLL_MS));
    const poll = await withTimeout(COPY_TIMEOUT_MS, (s) => fetch(job!.statusUrl, { headers: auth, signal: s }), signal).catch(() => null);
    if (!poll?.ok) continue;
    const state = (await poll.json().catch(() => ({}))) as { status?: string; video?: { url?: string }; error?: string | null };
    await opts?.onWait?.(String(state.status ?? ""));
    if (state.status === "completed") {
      if (!state.video?.url) return fail("AI_FAILED", serviceMessage("AI_FAILED")!);
      const got = await withTimeout(300_000, (s) => fetch(state.video!.url!, { signal: s }), signal).catch(() => null);
      if (!got?.ok) return fail("UNREACHABLE", "The finished video could not be fetched. Try again.");
      return { ok: true, bytes: Buffer.from(await got.arrayBuffer()), type: "video/mp4", job };
    }
    if (state.status === "nsfw") return fail("AI_DECLINED", serviceMessage("AI_DECLINED")!);
    // Cancelled while it waited in the queue (a stop from us): never made, never billed.
    if (state.status === "canceled") return fail("CANCELED", "The video was cancelled before it was made. Try again.");
    if (state.status === "failed") {
      // "Your credit balance is too low" arrives here, as a failed job, not
      // as a refusal of the request, so it is sorted the same way.
      const why = String(state.error ?? "");
      console.error("The video service failed a film:", why.slice(0, 400));
      const { code, message } = classifyRefusal(400, JSON.stringify({ error: { message: why } }));
      return fail(code, message);
    }
  }
  return fail("UNREACHABLE", "The video was still being made after forty-five minutes.");
};

// ---------------------------------------------------------------------------
// One scene of a film, when Seedance will not take it: Google Veo
// ---------------------------------------------------------------------------

/**
 * Google Veo 3.1 through the Gemini API, the fallback for a scene Seedance
 * refuses (it reads a clear face as a real person's and refuses the clip;
 * Veo takes the same face as a reference picture). Up to three reference
 * pictures, 8 seconds (Veo's only length with references), 720p, sound and
 * all, which the scene fix throws away. `VEO_MODEL` overrides the model,
 * `GEMINI_API_KEY` switches it on. About $0.40 a second (`doc/pricing.md`).
 */
export const VEO_MODEL = process.env.VEO_MODEL || "veo-3.1-generate-preview";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const VEO_POLL_MS = 10_000;
const VEO_TIMEOUT_MS = 20 * 60_000;
/**
 * Veo allows a few requests a minute, and a scene fix asks for several at
 * once: every one but the first came back 429 and was read as no credit (9
 * October 2026). So requests go one at a time, and a 429 waits and asks
 * again, at most `VEO_RATE_TRIES` times. A refused request is never billed.
 */
const VEO_RATE_TRIES = 5;
const VEO_RATE_WAIT_MS = [30_000, 60_000, 90_000, 120_000];
let veoQueue: Promise<unknown> = Promise.resolve();
function oneVeoAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = veoQueue.then(work, work);
  veoQueue = next.catch(() => {});
  return next;
}

export const veoReady = (): boolean => !!keyOr("GEMINI_API_KEY");

export type VeoRequest = {
  prompt: string;
  /** Reference pictures, at most three, each at least 300 pixels a side. */
  images: { bytes: Buffer; type: string }[];
  aspect: "9:16" | "16:9";
};
/** A submitted Veo request, kept so a worker that dies collects it rather than paying again. */
export type VeoJob = { name: string };

export type VeoDriver = (
  req: VeoRequest,
  opts?: { signal?: AbortSignal; job?: VeoJob | null; onSubmitted?: (job: VeoJob) => Promise<void> },
) => Promise<Result<{ bytes: Buffer; type: string; job: VeoJob }>>;

export const veoScene: VeoDriver = async (req, opts) => {
  const key = keyOr("GEMINI_API_KEY");
  if (!key) return fail("NO_KEY", "No video model is configured.");
  const auth = { "x-goog-api-key": key };
  const signal = opts?.signal;
  if (signal?.aborted) return fail("STOPPED", "Stopped.");
  let job = opts?.job ?? null;
  if (!job) {
    const submit = () => withTimeout(COPY_TIMEOUT_MS, (s) =>
      fetch(`${GEMINI}/models/${VEO_MODEL}:predictLongRunning`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          instances: [
            {
              prompt: req.prompt,
              referenceImages: req.images.slice(0, 3).map((i) => ({
                image: { bytesBase64Encoded: i.bytes.toString("base64"), mimeType: i.type },
                referenceType: "asset",
              })),
            },
          ],
          parameters: { aspectRatio: req.aspect, durationSeconds: 8, resolution: "720p", personGeneration: "allow_adult" },
        }),
        signal: s,
      }), signal,
    ).catch(() => null);
    const started = await oneVeoAtATime(async () => {
      for (let attempt = 1; ; attempt++) {
        const r = await submit();
        if (r?.status !== 429 || attempt >= VEO_RATE_TRIES || signal?.aborted) return r;
        const wait = VEO_RATE_WAIT_MS[Math.min(attempt - 1, VEO_RATE_WAIT_MS.length - 1)];
        console.log(`Veo: too many requests, asking again in ${wait / 1000} s`);
        await new Promise((res) => setTimeout(res, wait));
      }
    });
    if (signal?.aborted) return fail("STOPPED", "Stopped.");
    if (!started) return fail("UNREACHABLE", "The video service did not answer in time.");
    if (!started.ok) return await refused(started, "Veo");
    const op = (await started.json().catch(() => ({}))) as { name?: string };
    if (!op.name) return fail("AI_FAILED", serviceMessage("AI_FAILED")!);
    job = { name: op.name };
    await opts?.onSubmitted?.(job);
  }
  const until = Date.now() + VEO_TIMEOUT_MS;
  while (Date.now() < until) {
    if (signal?.aborted) return fail("STOPPED", "Stopped.");
    await new Promise((r) => setTimeout(r, VEO_POLL_MS));
    const poll = await withTimeout(COPY_TIMEOUT_MS, (s) => fetch(`${GEMINI}/${job!.name}`, { headers: auth, signal: s }), signal).catch(() => null);
    if (!poll?.ok) continue;
    const state = (await poll.json().catch(() => ({}))) as {
      done?: boolean;
      error?: { message?: string };
      response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; raiMediaFilteredReasons?: string[] } };
    };
    if (!state.done) continue;
    if (state.error) {
      console.error("Veo failed a scene:", String(state.error.message ?? "").slice(0, 400));
      const { code, message } = classifyRefusal(400, JSON.stringify({ error: { message: state.error.message ?? "" } }));
      return fail(code, message);
    }
    const r = state.response?.generateVideoResponse;
    const uri = r?.generatedSamples?.[0]?.video?.uri;
    if (!uri) {
      console.error("Veo returned no video:", JSON.stringify(r?.raiMediaFilteredReasons ?? []).slice(0, 400));
      return fail(r?.raiMediaFilteredReasons?.length ? "AI_DECLINED" : "AI_FAILED", serviceMessage(r?.raiMediaFilteredReasons?.length ? "AI_DECLINED" : "AI_FAILED")!);
    }
    const got = await withTimeout(300_000, (s) => fetch(uri, { headers: auth, redirect: "follow", signal: s }), signal).catch(() => null);
    if (!got?.ok) return fail("UNREACHABLE", "The finished video could not be fetched. Try again.");
    return { ok: true, bytes: Buffer.from(await got.arrayBuffer()), type: "video/mp4", job };
  }
  return fail("UNREACHABLE", "The video was still being made after twenty minutes.");
};

/**
 * A provider's refusal as a person should read it. The provider's own words
 * ("add credits at platform.openai.com") are about our account, so they go
 * to the server log and the screen gets `classifyRefusal()`'s sentence.
 */
async function refused(response: Response, who: string): Promise<Fail> {
  const body = await response.text().catch(() => "");
  const { code, message } = classifyRefusal(response.status, body);
  console.error(`${who} refused (${response.status}, ${code}):`, body.replace(/\s+/g, " ").slice(0, 400));
  return fail(code, message);
}

// ---------------------------------------------------------------------------
// Story reels: a model that answers in JSON, a voice, and an ear
// ---------------------------------------------------------------------------

/** One part of a message to a model: words, or a picture it should look at. */
export type AskPart = { text: string } | { image: { bytes: Buffer; type: string; detail?: "low" | "high" } };

export type AskRequest = {
  model: string;
  system: string;
  parts: AskPart[];
  /** The JSON schema the answer must follow, strict. */
  schema: Record<string, unknown>;
  name: string;
  timeoutMs?: number;
  /** How hard a reasoning model thinks. A small, fixed choice needs "minimal". */
  effort?: "minimal" | "low" | "medium" | "high";
};

export type AskDriver = (req: AskRequest, opts?: { signal?: AbortSignal }) => Promise<Result<{ value: unknown; usage?: { tokensIn: number; tokensOut: number } }>>;

/**
 * A model asked for an answer in a fixed JSON shape: the reel's writer, its
 * editor's eye on a clip, and its reviewer. Pictures go as data URLs.
 */
export const askJson: AskDriver = async (req, opts) => {
  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No model is configured.");
  const content = req.parts.map((p) =>
    "text" in p
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: `data:${p.image.type};base64,${p.image.bytes.toString("base64")}`, detail: p.image.detail ?? "low" } },
  );
  const body = {
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content },
    ],
    response_format: { type: "json_schema", json_schema: { name: req.name, strict: true, schema: req.schema } },
    ...(req.effort ? { reasoning_effort: req.effort } : {}),
  };
  const answer = await withTimeout(
    req.timeoutMs ?? 180_000,
    async (signal) => {
      const r = await fetch(`${OPENAI}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!r.ok) return { ok: false as const, fail: await refused(r, "The model") };
      return { ok: true as const, json: (await r.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } };
    },
    opts?.signal,
  ).catch(() => null);
  if (!answer) return fail("UNREACHABLE", "The model did not answer in time.");
  if (!answer.ok) return answer.fail;
  const text = answer.json.choices?.[0]?.message?.content ?? "";
  const usage = { tokensIn: answer.json.usage?.prompt_tokens ?? 0, tokensOut: answer.json.usage?.completion_tokens ?? 0 };
  try {
    return { ok: true, value: JSON.parse(text) as unknown, usage };
  } catch {
    return fail("UNPARSED", "The model returned something that was not the agreed shape.");
  }
};

/**
 * Sarvam's own model, for what is written in an Indian language: a Hindi or
 * Marathi film's lines are written by it, so they read the way a person in
 * Mumbai or Pune says them, and read back into English by it. It reads no
 * pictures, so a picture handed to it goes as nothing and the request has
 * to name each one in words. `SARVAM_API_KEY`; `doc/pricing.md` prices it.
 */
export const SARVAM_CHAT_MODEL = process.env.SARVAM_CHAT_MODEL || "sarvam-105b";

export const askSarvam: AskDriver = async (req, opts) => {
  const key = keyOr("SARVAM_API_KEY");
  if (!key) return fail("NO_KEY", "No model is configured.");
  const text = req.parts.flatMap((p) => ("text" in p ? [p.text] : [])).join("\n\n");
  const body = {
    model: req.model.startsWith("sarvam") ? req.model : SARVAM_CHAT_MODEL,
    // Held to the schema by its server, it ran on into thousands of blank
    // lines half way through a film's script (8 October 2026); asked for a
    // JSON object with the schema in words, it finishes. The caller checks
    // the shape as it always does.
    messages: [
      {
        role: "system",
        content: `${req.system}

Answer with ONE JSON object and nothing else. It follows this JSON schema exactly, every field present:
${JSON.stringify(req.schema)}`,
      },
      { role: "user", content: text },
    ],
    response_format: { type: "json_object" },
    // Told to think, it spent all 16,000 tokens on a film's brief and wrote
    // nothing (8 October 2026); null switches its thinking off.
    // A draft sent back is asked with its thinking on, which it needs to
    // count words; its thinking is billed as output, and capped here.
    reasoning_effort: req.effort === "low" || req.effort === "medium" || req.effort === "high" ? req.effort : null,
    max_tokens: req.effort && req.effort !== "minimal" ? 32_000 : 12_000,
  };
  const answer = await withTimeout(
    req.timeoutMs ?? 240_000,
    async (signal) => {
      const r = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: { "api-subscription-key": key, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!r.ok) return { ok: false as const, fail: await refused(r, "The model") };
      return {
        ok: true as const,
        json: (await r.json()) as { choices?: { finish_reason?: string; message?: { content?: string | null } }[]; usage?: { completion_tokens?: number } },
      };
    },
    opts?.signal,
  ).catch(() => null);
  if (!answer) return fail("UNREACHABLE", "The model did not answer in time.");
  if (!answer.ok) return answer.fail;
  const choice = answer.json.choices?.[0];
  if (!choice?.message?.content) {
    return fail("UNPARSED", `The model wrote nothing (${choice?.finish_reason ?? "no answer"}, ${answer.json.usage?.completion_tokens ?? 0} tokens).`);
  }
  const out = (choice.message.content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return { ok: true, value: JSON.parse(out) as unknown };
  } catch {
    if (process.env.SARVAM_DEBUG_DIR) await import("node:fs/promises").then((f) => f.writeFile(`${process.env.SARVAM_DEBUG_DIR}/unparsed-${Date.now()}.txt`, out)).catch(() => null);
    return fail("UNPARSED", `The model returned something that was not the agreed shape (${choice.finish_reason}, ${out.length} characters).`);
  }
};

export type SpeakDriver = (
  req: { text: string; voice: string; language: string },
  opts?: { signal?: AbortSignal },
) => Promise<Result<{ bytes: Buffer; type: string }>>;

/** The reel's narrator: Sarvam's Bulbul voices, made for Indian languages and for Hinglish. */
export const SPEAK_MODEL = process.env.SPEAK_MODEL || "bulbul:v3";

export const speak: SpeakDriver = async (req, opts) => {
  const key = keyOr("SARVAM_API_KEY");
  if (!key) return fail("NO_KEY", "No voice is configured.");
  const r = await withTimeout(
    COPY_TIMEOUT_MS,
    (signal) =>
      fetch("https://api.sarvam.ai/text-to-speech", {
        method: "POST",
        headers: { "api-subscription-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          text: req.text,
          language_code: req.language,
          speaker: req.voice,
          model: SPEAK_MODEL,
          pace: 1.0,
          speech_sample_rate: "44100",
          output_audio_codec: "wav",
        }),
        signal,
      }),
    opts?.signal,
  ).catch(() => null);
  if (!r) return fail("UNREACHABLE", "The voice did not answer in time.");
  if (!r.ok) return await refused(r, "The voice");
  const json = (await r.json().catch(() => ({}))) as { audios?: string[] };
  const audio = json.audios?.[0];
  if (!audio) return fail("EMPTY", "The voice returned nothing.");
  return { ok: true, bytes: Buffer.from(audio, "base64"), type: "audio/wav" };
};

export type HearDriver = (
  req: { audio: { bytes: Buffer; type: string }; language?: string },
  opts?: { signal?: AbortSignal },
) => Promise<Result<{ text: string }>>;

/** What a finished reel actually says, for the reviewer to hold against the script. */
export const hear: HearDriver = async (req, opts) => {
  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No transcriber is configured.");
  const form = new FormData();
  form.append("model", process.env.HEAR_MODEL || "gpt-4o-transcribe");
  if (req.language) form.append("language", req.language);
  form.append("file", new Blob([new Uint8Array(req.audio.bytes)], { type: req.audio.type }), "audio.mp3");
  const r = await withTimeout(
    120_000,
    (signal) =>
      fetch(`${OPENAI}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal }),
    opts?.signal,
  ).catch(() => null);
  if (!r) return fail("UNREACHABLE", "The transcriber did not answer in time.");
  if (!r.ok) return await refused(r, "The transcriber");
  const json = (await r.json().catch(() => ({}))) as { text?: string };
  return { ok: true, text: String(json.text ?? "") };
};

// ---------------------------------------------------------------------------
// Agents: a model that decides what to do next and does it with tools
// ---------------------------------------------------------------------------

export type AgentToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type AgentBrainRequest = {
  model: string;
  effort: "none" | "low" | "medium" | "high";
  instructions: string;
  /** The whole conversation so far, as Responses API items. */
  input: Record<string, unknown>[];
  tools: AgentToolSpec[];
};

export type AgentTurn = {
  /** What the model said and did this turn: reasoning, messages and function calls. */
  output: Record<string, unknown>[];
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number };
};

export type AgentBrain = (req: AgentBrainRequest, opts?: { signal?: AbortSignal }) => Promise<Result<AgentTurn>>;

/** One turn of an agent: long enough for a model looking at a dozen pictures, and no longer. */
export const AGENT_TIMEOUT_MS = 240_000;

/**
 * One turn of an agent, on the Responses API: the newer models take function
 * tools with reasoning only there. Nothing is stored at OpenAI (`store:
 * false`); the conversation is sent whole each turn, the reasoning carried
 * back encrypted, so a turn needs nothing but this request to be answered.
 *
 * A tool is always required: an agent ends by calling its finishing tool,
 * never by talking, so a turn that only talked is a turn the runtime nudges.
 */
export const thinkAgent: AgentBrain = async (req, opts) => {
  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No model is configured.");
  const body = {
    model: req.model,
    instructions: req.instructions,
    input: req.input,
    tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true })),
    tool_choice: "required",
    parallel_tool_calls: true,
    reasoning: { effort: req.effort },
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  const call = () =>
    withTimeout(
      AGENT_TIMEOUT_MS,
      async (signal) => {
        const r = await fetch(`${OPENAI}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        if (!r.ok) return { ok: false as const, fail: await refused(r, "The agent model") };
        return {
          ok: true as const,
          json: (await r.json()) as {
            output?: Record<string, unknown>[];
            usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
          },
        };
      },
      opts?.signal,
    ).catch((e: unknown) => ({ ok: null, timedOut: e instanceof Error && e.message === "timeout" }) as const);

  // A dropped connection is asked once more; a timeout or a stop is not.
  let answer = await call();
  if (answer.ok === null && !answer.timedOut && !opts?.signal?.aborted) answer = await call();
  if (answer.ok === null) {
    if (opts?.signal?.aborted) return fail("STOPPED", "Stopped.");
    return answer.timedOut
      ? fail("UNREACHABLE", "The agent model did not answer in time.")
      : fail("UNREACHABLE", "The agent model could not be reached. Try again.");
  }
  if (!answer.ok) return answer.fail;
  const u = answer.json.usage ?? {};
  return {
    ok: true,
    output: answer.json.output ?? [],
    usage: {
      inputTokens: u.input_tokens ?? 0,
      cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
    },
  };
};

/**
 * A picture from words alone, for what no approved photo can be: the people
 * in a story reel. Never the building, which is always an approved picture;
 * the reel's script gate refuses a people shot that describes one.
 */
export const imagineStill: DesignDriver = async (req, opts) => {
  const key = keyOr("OPENAI_API_KEY");
  if (!key) return fail("NO_KEY", "No image model is configured.");
  const answer = await withTimeout(
    IMAGE_TIMEOUT_MS,
    async (signal) => {
      const r = await fetch(`${OPENAI}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: req.model ?? DESIGN_MODEL, prompt: req.prompt, size: req.size, quality: req.quality ?? "high", n: 1 }),
        signal,
      });
      if (!r.ok) return { ok: false as const, fail: await refused(r, "The image model") };
      return { ok: true as const, json: (await r.json()) as { data?: { b64_json?: string }[] } };
    },
    opts?.signal,
  ).catch(() => null);
  if (!answer) return fail("UNREACHABLE", "The image model did not answer in time.");
  if (!answer.ok) return answer.fail;
  const b64 = answer.json.data?.[0]?.b64_json;
  if (!b64) return fail("EMPTY", "The image model returned no picture.");
  return { ok: true, bytes: Buffer.from(b64, "base64"), type: "image/png" };
};

// ---------------------------------------------------------------------------
// Sharpening a small picture read out of a brochure
// ---------------------------------------------------------------------------

/**
 * A brochure's pictures are often smaller than a library picture should be.
 * Gemini's image model redraws one larger and sharper. It is told to change
 * nothing, and the caller still compares the result with the original before
 * it is kept (`sharpenedLooksSame()` in `setup-rules.ts`), because a model
 * that redraws can redraw a building. `SHARPEN_MODEL` overrides the model,
 * `GEMINI_API_KEY` switches it on. About $0.10 a picture at 2K
 * (`doc/pricing.md`).
 */
export const SHARPEN_MODEL = process.env.SHARPEN_MODEL || "gemini-3.1-flash-image";

export const SHARPEN_PROMPT = [
  "Upscale this exact photograph to a sharp, high resolution version.",
  "Keep everything exactly as it is: the same building, the same number of floors, windows and balconies, the same rooms, furniture, people, trees, sky, colours, light and framing.",
  "Do not add, remove, move or restyle anything. Do not crop, extend or change the angle. Do not add text, logos or watermarks, and keep any text in the picture as it is.",
  "Only remove blur, noise and compression artefacts, and add fine natural detail.",
].join(" ");

export type SharpenRequest = { bytes: Buffer; type: string; aspect: string };
export type SharpenDriver = (req: SharpenRequest, opts?: { signal?: AbortSignal }) => Promise<Result<{ bytes: Buffer; type: string; tokensIn: number; tokensOut: number }>>;

export const sharpenReady = (): boolean => !!keyOr("GEMINI_API_KEY");

export const sharpenPicture: SharpenDriver = async (req, opts) => {
  const key = keyOr("GEMINI_API_KEY");
  if (!key) return fail("NO_KEY", "No image model is configured.");
  const response = await withTimeout(
    IMAGE_TIMEOUT_MS,
    (signal) =>
      fetch(`${GEMINI}/models/${SHARPEN_MODEL}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: SHARPEN_PROMPT }, { inlineData: { mimeType: req.type, data: req.bytes.toString("base64") } }] }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: req.aspect, imageSize: "2K" } },
        }),
        signal,
      }),
    opts?.signal,
  ).catch(() => null);
  if (!response) return fail("UNREACHABLE", "The image model did not answer in time.");
  if (!response.ok) return await refused(response, "Gemini image");
  const json = (await response.json().catch(() => ({}))) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) return fail("EMPTY", "The image model returned no picture.");
  return {
    ok: true,
    bytes: Buffer.from(part.inlineData.data, "base64"),
    type: part.inlineData.mimeType || "image/png",
    tokensIn: json.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: json.usageMetadata?.candidatesTokenCount ?? 0,
  };
};
