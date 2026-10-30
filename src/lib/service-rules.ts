/**
 * What a person is told when an AI provider says no, decided without a
 * network.
 *
 * The providers' own words are written for whoever holds the account: "You
 * have no credits remaining. Add credits at platform.openai.com/settings/
 * organization/billing". The account is ours, not the developer's, so that
 * sentence tells a marketing head to fix a bill they cannot see. It was
 * printed on the screen as it came. Each refusal is now sorted into what it
 * means for the person, and the provider's words go to the server log.
 *
 * Imports are relative because the checks load this straight from source.
 */

export type ServiceCode = "OUT_OF_CREDITS" | "AI_UNAVAILABLE" | "AI_BUSY" | "AI_DECLINED" | "AI_FAILED";

/**
 * The refusals that will refuse the next request the same way. A batch stops
 * at the first of these rather than asking again for every post in it.
 */
export const SERVICE_DOWN: readonly string[] = ["OUT_OF_CREDITS", "AI_UNAVAILABLE", "AI_BUSY", "NO_KEY"];

export function isServiceDown(code: string | null | undefined): boolean {
  return !!code && SERVICE_DOWN.includes(code);
}

const SAY: Record<ServiceCode, string> = {
  OUT_OF_CREDITS: "AI generation is paused because our usage limit has been reached. Please try again later.",
  AI_UNAVAILABLE: "AI generation is unavailable right now. Please try again in a few minutes.",
  AI_BUSY: "AI generation is busy right now. Please try again in a minute.",
  AI_DECLINED: "The AI declined to make this one. Try a different picture or template.",
  AI_FAILED: "This could not be generated. Please try again.",
};

/** The sentence a person is shown for a code, or null for a code that is not a service's. */
export function serviceMessage(code: string): string | null {
  return (SAY as Record<string, string>)[code] ?? null;
}

/**
 * A provider's refusal, sorted. `status` is the HTTP status and `body` the
 * response text; both OpenAI and Higgsfield put a code and a message in it.
 */
export function classifyRefusal(status: number, body: string): { code: ServiceCode; message: string } {
  let code = "";
  let text = "";
  try {
    const j = JSON.parse(body) as { error?: { code?: unknown; type?: unknown; message?: unknown }; detail?: unknown; code?: unknown };
    code = String(j.error?.code ?? j.error?.type ?? j.code ?? "");
    text = String(j.error?.message ?? (typeof j.detail === "string" ? j.detail : "") ?? "");
  } catch {
    text = body;
  }
  const all = `${code} ${text}`.toLowerCase();
  const pick = (c: ServiceCode) => ({ code: c, message: SAY[c] });

  // Out of money first: OpenAI answers 429 for an empty balance as well as
  // for going too fast, and only the words tell them apart.
  if (/insufficient_quota|billing|credits?|quota|not_enough_credits|payment|limit exceeded/.test(all)) return pick("OUT_OF_CREDITS");
  if (status === 401 || status === 403) return pick("AI_UNAVAILABLE");
  if (status === 429) return pick("AI_BUSY");
  if (status >= 500) return pick("AI_UNAVAILABLE");
  if (/moderation|safety|content_policy|policy_violation|sensitivecontent|sensitive (information|content)/.test(all)) return pick("AI_DECLINED");
  return pick("AI_FAILED");
}
