import { thinkAgent, type AgentBrain, type AgentToolSpec } from "./generate.ts";
import { addUsage, agentCostUsd, NO_USAGE, pruneImages, type AgentItem, type AgentUsage } from "./agent-rules.ts";

/**
 * The runtime every agent in the product shares: a model is shown the job,
 * calls tools, is shown what each tool made (the picture included), and
 * decides what to do next, until it calls a tool that ends the job.
 *
 * The runtime owns what the model must not: the budget. A turn is refused
 * past `maxTurns` or `maxUsd`, a tool that throws is reported to the model
 * rather than ending the job, four turns in a row that go nowhere end it,
 * and a stop from outside ends it between two turns. Every paid call the
 * tools make is capped by the tools themselves, in code, the way
 * `MAX_DESIGN_ATTEMPTS` always was: the agent decides WHAT to try, never
 * how much may be spent trying.
 *
 * Imports are relative because the workers run this straight from source.
 */

export type AgentPicture = { bytes: Buffer; type: string; detail?: "low" | "high" };

/** What a tool hands back: words for the agent, pictures to look at, and whether the job is over. */
export type ToolOutcome = {
  text: string;
  images?: AgentPicture[];
  /** Set by a tool that ends the job (finish, deliver, give up), or by one whose failure ends it. */
  end?: { ok: boolean; code?: string; message?: string };
};

export type AgentTool = AgentToolSpec & {
  run: (args: unknown, ctx: { signal?: AbortSignal }) => Promise<ToolOutcome>;
  /**
   * Runs alone, after every other call of its turn has finished: a tool that
   * reads or ends the whole job (render, deliver, finish) must not start while
   * a clip or a drawing it depends on is still being made.
   */
  exclusive?: boolean;
};

export type AgentStep = { turn: number; tool: string; args: string; result: string };

export type AgentRun = {
  ended: "done" | "budget" | "stopped" | "failed";
  /** The ending tool's verdict, when a tool ended the job. */
  end?: { ok: boolean; code?: string; message?: string };
  usage: AgentUsage;
  usd: number;
  steps: AgentStep[];
};

/** Tools running at once in one turn: more meets the providers' rate limits on an ordinary account. */
const DEFAULT_PARALLEL = 2;

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const dataUrl = (p: AgentPicture) => `data:${p.type};base64,${p.bytes.toString("base64")}`;

export async function runAgent(opts: {
  model: string;
  effort?: "none" | "low" | "medium" | "high";
  instructions: string;
  /** The job: words and the approved material, as the first message. */
  task: { text: string; images?: AgentPicture[] }[];
  tools: AgentTool[];
  maxTurns: number;
  maxUsd: number;
  /** Tool results whose pictures stay in the conversation. */
  keepImages?: number;
  /** Tools run at once when one turn calls several. */
  parallel?: number;
  brain?: AgentBrain;
  /** Turns in a row where every tool refused, before the job is ended as stuck. */
  maxIdle?: number;
  signal?: AbortSignal;
  onStep?: (step: AgentStep) => void | Promise<void>;
}): Promise<AgentRun> {
  const brain = opts.brain ?? thinkAgent;
  const specs: AgentToolSpec[] = opts.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const input: AgentItem[] = [
    {
      role: "user",
      content: opts.task.flatMap((part) => [
        { type: "input_text", text: part.text },
        ...(part.images ?? []).map((img) => ({ type: "input_image", image_url: dataUrl(img), detail: img.detail ?? "low" })),
      ]),
    },
  ];
  let usage: AgentUsage = { ...NO_USAGE };
  const steps: AgentStep[] = [];
  const usd = () => agentCostUsd(opts.model, usage);
  let idle = 0;
  let crashedTurns = 0;
  let warned = false;

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    if (opts.signal?.aborted) return { ended: "stopped", usage, usd: usd(), steps };
    if (usd() >= opts.maxUsd) break;
    // Told once, near the end, so it finishes with what it has rather than
    // being cut off in the middle of a thought.
    if (!warned && (turn >= opts.maxTurns - 1 || usd() >= opts.maxUsd * 0.85)) {
      warned = true;
      input.push({
        role: "user",
        content: [{ type: "input_text", text: "You are almost out of budget. Finish now with the best you have, or give up." }],
      });
    }

    const answer = await brain(
      { model: opts.model, effort: opts.effort ?? "low", instructions: opts.instructions, input: pruneImages(input, opts.keepImages ?? 4), tools: specs },
      { signal: opts.signal },
    );
    if (!answer.ok) {
      if (opts.signal?.aborted || answer.code === "STOPPED") return { ended: "stopped", usage, usd: usd(), steps };
      return { ended: "failed", end: { ok: false, code: answer.code, message: answer.message }, usage, usd: usd(), steps };
    }
    usage = addUsage(usage, { ...answer.usage, turns: 1 });
    input.push(...answer.output);

    const calls = answer.output.filter((o) => o.type === "function_call") as { call_id: string; name: string; arguments: string }[];
    if (!calls.length) {
      if (++idle >= (opts.maxIdle ?? 4)) return { ended: "failed", end: { ok: false, code: "AGENT_IDLE", message: "The agent stopped working." }, usage, usd: usd(), steps };
      input.push({ role: "user", content: [{ type: "input_text", text: "Use a tool. When the work is done, call the tool that finishes it." }] });
      continue;
    }

    const runOne = async (c: (typeof calls)[number]): Promise<ToolOutcome> => {
      const tool = opts.tools.find((t) => t.name === c.name);
      if (!tool) return { text: `There is no tool called ${c.name}.` } as ToolOutcome;
      let args: unknown;
      try {
        args = JSON.parse(c.arguments || "{}");
      } catch {
        return { text: "Those arguments were not valid JSON." } as ToolOutcome;
      }
      try {
        return await tool.run(args, { signal: opts.signal });
      } catch (e) {
        console.error(`agent: the tool ${c.name} failed`, e);
        return { text: `The tool failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}. Try something else.` } as ToolOutcome;
      }
    };
    const exclusive = (c: (typeof calls)[number]) => !!opts.tools.find((t) => t.name === c.name)?.exclusive;
    const results: ToolOutcome[] = new Array(calls.length);
    const shared = calls.map((c, i) => ({ c, i })).filter(({ c }) => !exclusive(c));
    (await mapLimit(shared, opts.parallel ?? DEFAULT_PARALLEL, ({ c }) => runOne(c))).forEach((r, k) => (results[shared[k].i] = r));
    for (let i = 0; i < calls.length; i++) {
      if (!exclusive(calls[i])) continue;
      // Once one call has ended the job, the rest of the turn is not run.
      results[i] = results.some((r) => r?.end) ? { text: "Not run: the job had already ended." } : await runOne(calls[i]);
    }

    let ending: ToolOutcome["end"] | undefined;
    let progress = false;
    let crashed = false;
    calls.forEach((c, i) => {
      const r = results[i];
      input.push({
        type: "function_call_output",
        call_id: c.call_id,
        output: r.images?.length
          ? [
              { type: "input_text", text: r.text },
              ...r.images.map((img) => ({ type: "input_image", image_url: dataUrl(img), detail: img.detail ?? "high" })),
            ]
          : r.text,
      });
      const step = { turn, tool: c.name, args: c.arguments.slice(0, 600), result: r.text.slice(0, 400) };
      steps.push(step);
      console.log(`[AGENT turn ${turn}] ${c.name}(${c.arguments}) => ${r.text}`);
      void opts.onStep?.(step);
      if (r.end && !ending) ending = r.end;
      if (!/^(Refused|There is no tool|Those arguments|The tool failed)/.test(r.text)) progress = true;
      if (r.text.startsWith("The tool failed")) crashed = true;
    });
    if (ending) return { ended: "done", end: ending, usage, usd: usd(), steps };
    idle = progress ? 0 : idle + 1;
    crashedTurns = progress ? 0 : crashed ? crashedTurns + 1 : crashedTurns;
    if (idle >= (opts.maxIdle ?? 4) && crashedTurns > 0) {
      // Our code broke, not the agent's choices: say so rather than blame it.
      return { ended: "failed", end: { ok: false, code: "TOOL_FAILED", message: "Something went wrong on our side. Try again in a few minutes." }, usage, usd: usd(), steps };
    }
    if (idle >= (opts.maxIdle ?? 4)) {
      return { ended: "failed", end: { ok: false, code: "AGENT_STUCK", message: "The agent kept asking for things it may not have." }, usage, usd: usd(), steps };
    }
  }
  return { ended: "budget", usage, usd: usd(), steps };
}
