import { changesProperty, looseText, NEUTRAL_LABELS } from "./compose-rules.ts";
import { toAsciiDigits } from "./creative-rules.ts";
import { withoutNegations } from "./reel-rules.ts";

/**
 * The agents, decided without a network: what a turn costs, which pictures a
 * conversation still carries, and what an agent may write to a model that
 * draws or films.
 *
 * An agent is a model that works the way a person at ChatGPT does: it asks
 * for a picture or a clip, looks at what came back, decides what a client
 * would send back, and asks again with exactly that change. What it is never
 * trusted with is the same list the copy gate keeps. It may not put a number
 * in front of a model that draws (a price drawn from an instruction is a
 * price nobody signed), it may not quote a line that did not clear, and it
 * may not ask for the building to change. Those are refused here, in code,
 * before anything is paid for, and the agent is told why.
 *
 * Imports are relative because the checks load this straight from source.
 */

/** Dollars a million tokens: fresh input, input served from the cache, output (reasoning included). */
export type TokenPrice = { input: number; cached: number; output: number };

/** OpenAI's prices, checked on 26 September 2026. */
export const AGENT_PRICES: Readonly<Record<string, TokenPrice>> = {
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2 },
};

/** A dollar, card forex included, as `doc/pricing.md` counts it. */
export const USD_TO_RS = 91;

export type AgentUsage = { inputTokens: number; cachedTokens: number; outputTokens: number; turns: number };

export const NO_USAGE: AgentUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 };

export function addUsage(a: AgentUsage, b: Partial<AgentUsage>): AgentUsage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    cachedTokens: a.cachedTokens + (b.cachedTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    turns: a.turns + (b.turns ?? 0),
  };
}

/**
 * What a conversation has cost, in dollars. `inputTokens` counts every input
 * token, cached ones included, as the API reports it. A model this table
 * does not know is priced as the dearest one it does, so a budget is never
 * under-counted by a model somebody named in an environment variable.
 */
export function agentCostUsd(model: string, u: AgentUsage): number {
  const known = AGENT_PRICES[model] ?? AGENT_PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  const p = known ?? Object.values(AGENT_PRICES).reduce((a, b) => (b.output > a.output ? b : a));
  const cached = Math.min(u.cachedTokens, u.inputTokens);
  const usd = ((u.inputTokens - cached) * p.input + cached * p.cached + u.outputTokens * p.output) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// What the conversation still carries
// ---------------------------------------------------------------------------

/** One item of a Responses API conversation, as sent and received. */
export type AgentItem = Record<string, unknown>;

const isImagePart = (p: unknown) => !!p && typeof p === "object" && (p as { type?: string }).type === "input_image";

/**
 * The conversation with the pictures of all but the latest `keep` tool
 * results taken out, each replaced by a line saying so.
 *
 * Every turn sends the whole conversation again, and a picture is about eight
 * hundred tokens. An agent on its thirtieth clip does not need to see the
 * first one's contact sheet again: it has what it wrote about it. The task's
 * own pictures, in the first message, always stay, because they are the
 * approved material everything else is measured against.
 */
export function pruneImages(items: readonly AgentItem[], keep: number): AgentItem[] {
  const withPictures = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.type === "function_call_output" && Array.isArray(it.output) && (it.output as unknown[]).some(isImagePart))
    .map(({ i }) => i);
  const drop = new Set(withPictures.slice(0, Math.max(0, withPictures.length - Math.max(0, keep))));
  if (!drop.size) return [...items];
  return items.map((it, i) =>
    drop.has(i)
      ? {
          ...it,
          output: (it.output as unknown[]).map((p) =>
            isImagePart(p) ? { type: "input_text", text: "[This picture is no longer shown.]" } : p,
          ),
        }
      : it,
  );
}

// ---------------------------------------------------------------------------
// What an agent may write to a model that draws or films
// ---------------------------------------------------------------------------

/** Quoted pieces of an instruction: in double quotes, curly quotes, or single quotes standing apart from a word. */
export function quotedIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/["“”]([^"“”]{2,}?)["“”]/g)) out.push(m[1].trim());
  for (const m of text.matchAll(/(?:^|[\s(:,])['‘]([^'‘’]{2,}?)['’](?=[\s).,;:!?]|$)/g)) out.push(m[1].trim());
  return out.filter(Boolean);
}

/**
 * The problems with what an agent wants to say to a drawing or filming model,
 * in words the agent can act on. Empty means it may be sent.
 *
 * - No number, in any script. Approved lines may be quoted exactly, and are
 *   taken out before the rest is read, because quoting the headline back is
 *   how a misspelling is fixed.
 * - Nothing quoted that did not clear: a quoted line is a line to set.
 * - No never-say phrase.
 * - Nothing that changes the property: a floor drawn from an instruction is a
 *   floor nobody built.
 * - `people`: a people shot in a story reel describes no building at all.
 */
export function guardAgentText(input: {
  texts: readonly string[];
  /** Every line that cleared and may be set or quoted exactly. */
  cleared: readonly string[];
  neverSay: readonly string[];
  maxChars?: number;
  /** Words that describe the property, refused where only people may be shown. */
  noProperty?: RegExp | null;
}): string[] {
  const problems: string[] = [];
  const max = input.maxChars ?? 400;
  const clearedLoose = [...input.cleared, ...NEUTRAL_LABELS].map(looseText).filter(Boolean);
  // Longest first, so a line is taken out whole before a shorter one inside it.
  const strip = [...input.cleared].filter((c) => c && c.trim().length >= 2).sort((a, b) => b.length - a.length);
  for (const raw of input.texts) {
    const text = String(raw ?? "");
    if (text.length > max) problems.push(`Keep each instruction under ${max} characters.`);
    let bare = text;
    for (const c of strip) bare = bare.split(c).join(" ");
    if (/\d/.test(toAsciiDigits(bare))) {
      problems.push(
        "An instruction may not carry a number, not even a size, a floor, a price or a percentage. Say it in words, " +
          "or quote an approved line exactly.",
      );
    }
    for (const q of quotedIn(text)) {
      const lq = looseText(q);
      if (lq && !clearedLoose.some((c) => c === lq || c.includes(lq))) {
        problems.push(`Only approved lines may be quoted, and "${q.slice(0, 60)}" is not one. Refer to text by its role instead.`);
      }
    }
    const lower = text.toLowerCase();
    for (const phrase of input.neverSay) {
      const p = phrase.trim().toLowerCase();
      if (p.length >= 3 && lower.includes(p)) problems.push(`"${phrase.trim()}" is on the never-say list.`);
    }
    const said = withoutNegations(bare);
    if (changesProperty(said)) {
      problems.push("An instruction may never change the building or the space: nothing added, removed, moved or reshaped.");
    }
    if (input.noProperty && input.noProperty.test(said)) {
      problems.push(
        "A people shot may not show the building, the project or the flat being sold. Describe the people and the ordinary place they are in; saying what must not be seen is fine.",
      );
    }
  }
  return [...new Set(problems)];
}

/**
 * Tool arguments read defensively: a strict schema makes the shape likely,
 * not certain, and a tool that throws on a missing field is a turn wasted.
 */
export function argString(args: unknown, key: string): string {
  const v = (args as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v.trim() : "";
}

export function argNumber(args: unknown, key: string): number | null {
  const v = (args as Record<string, unknown> | null)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function argStrings(args: unknown, key: string, max = 12): string[] {
  const v = (args as Record<string, unknown> | null)?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean).slice(0, max) : [];
}
