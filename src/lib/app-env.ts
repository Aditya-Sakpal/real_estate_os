/**
 * Which rules this process runs under: one variable, `ENVIRONMENT`.
 *
 *   ENVIRONMENT=development   every limit that exists to protect a paying
 *                             client or a buyer is lifted, so the product can
 *                             be worked on freely
 *   ENVIRONMENT=production    every limit holds
 *
 * Unset, it is production on Vercel or in a production build, and
 * development otherwise, which is what each of these checks read before it
 * was one variable. Decided with the client on 4 October 2026: changing one
 * line in `.env.local` must be the whole of switching.
 *
 * What development lifts:
 *   - a plan before a project, and a channel partner's project cap
 *   - plans, allowances and top-ups: nothing is refused for billing
 *   - calling hours, for every call
 *   - the calling minute allowance in Settings, Calling
 *   - Ask Jimmy's daily and monthly question, voice and read-aloud limits,
 *     and the things a person may ask Jimmy to make in a day
 *   - a schedule's daily cap, and the story reels that may run at once
 *   - the work-account bar: a personal Google account signs in, founds any
 *     kind of company and may hold the admin role
 *   (the dev seams, sign-in door, fixtures, fake CRM, dev KMS key and
 *   Razorpay test keys, stay on NODE_ENV and VERCEL: they say where the code runs)
 *
 * What it never lifts: an opt-out, consent rules the client switched on,
 * the RERA gate, the copy, design and pixel gates, and every cap on a loop
 * that pays per attempt. Those protect the buyer and our money whatever the
 * environment. The checks run under production (`scripts/checks.env`), so a
 * suite still proves every limit.
 */

export type AppEnv = "development" | "production";

export function appEnv(env: Record<string, string | undefined> = process.env): AppEnv {
  const v = (env.ENVIRONMENT ?? "").trim().toLowerCase();
  if (v === "development" || v === "dev") return "development";
  if (v === "production" || v === "prod") return "production";
  return env.NODE_ENV === "production" || env.VERCEL ? "production" : "development";
}

/** Limits are lifted here. */
export const isDevelopment = (env: Record<string, string | undefined> = process.env): boolean => appEnv(env) === "development";

/** Limits hold here. */
export const isProduction = (env: Record<string, string | undefined> = process.env): boolean => appEnv(env) === "production";
