/**
 * The seam where Meta's and Google's servers are called.
 *
 * Every request to either platform goes through `call()` here, for the reason
 * every model call goes through `generate.ts` and every object through
 * `storage.ts`: the timeout lives in one place, the way a refusal is read
 * lives in one place, and a check can swap the whole network for a fake that
 * behaves like the platform without an account, a token or an App Review.
 *
 * `usePlatform()` is that swap. An injected fetch beats the real one, so a
 * suite is never quietly talking to graph.facebook.com.
 *
 * Nothing here knows a token's meaning or a tenant. It moves bytes, times
 * them, and turns a refusal into a `PlatformError` by the platform's own
 * codes rather than its words.
 */

import {
  readGoogleError,
  readMetaError,
  type PlatformError,
  type Provider,
} from "./connect-rules.ts";

export type PlatformFetch = (url: string, init: RequestInit) => Promise<Response>;

let injected: PlatformFetch | null = null;

/** For the checks. An injected fetch beats the network. */
export function usePlatform(f: PlatformFetch | null): void {
  injected = f;
}

/**
 * The versions this is written against. Both platforms retire a version on a
 * schedule (Meta roughly two years after release, Google roughly one), so
 * these are the numbers to move, and both can be moved from the environment
 * without a deploy when a sunset arrives before a release does.
 */
export const META_GRAPH_VERSION = (process.env.META_GRAPH_VERSION ?? "").trim() || "v26.0";
export const GOOGLE_ADS_VERSION = (process.env.GOOGLE_ADS_API_VERSION ?? "").trim() || "v25";

export const HOSTS = {
  graph: "https://graph.facebook.com",
  graphVideo: "https://graph-video.facebook.com",
  facebook: "https://www.facebook.com",
  googleAuth: "https://accounts.google.com/o/oauth2/v2/auth",
  googleToken: "https://oauth2.googleapis.com/token",
  googleRevoke: "https://oauth2.googleapis.com/revoke",
  ads: "https://googleads.googleapis.com",
  dataManager: "https://datamanager.googleapis.com",
  gbpAccounts: "https://mybusinessaccountmanagement.googleapis.com",
  gbpInfo: "https://mybusinessbusinessinformation.googleapis.com",
  gbpPosts: "https://mybusiness.googleapis.com",
  youtubeUpload: "https://www.googleapis.com/upload/youtube/v3/videos",
} as const;

/** One call. A platform that has not answered in a minute is not going to. */
export const CALL_TIMEOUT_MS = 60_000;
/** An upload of a video is bytes, not a question, and gets longer. */
export const UPLOAD_TIMEOUT_MS = 180_000;

export type Called<T> = ({ ok: true; json: T; status: number; headers: Headers }) | ({ ok: false } & PlatformError);

/**
 * One request, timed by a race as well as an abort, and its answer read.
 *
 * The race is the lesson `generate.ts` learned: an upload that ignored its
 * signal once held a post for an hour, and a deadline that needs the thing it
 * is timing to cooperate is not a deadline.
 */
export async function call<T = unknown>(
  provider: Provider,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Called<T>> {
  const f = injected ?? ((u: string, i: RequestInit) => fetch(u, i));
  const controller = new AbortController();
  const ms = init.timeoutMs ?? CALL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, ms);
  });

  let response: Response;
  let text: string;
  try {
    const answer = await Promise.race([
      (async () => {
        const r = await f(url, { ...init, signal: controller.signal });
        return { r, t: await r.text() };
      })(),
      deadline,
    ]);
    response = answer.r;
    text = answer.t;
  } catch {
    return {
      ok: false,
      code: "UNREACHABLE",
      retryable: true,
      message: provider === "META" ? "Meta did not answer in time." : "Google did not answer in time.",
    };
  } finally {
    clearTimeout(timer);
  }

  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: { message: text.slice(0, 200) } };
  }

  if (!response.ok) {
    const e = provider === "META" ? readMetaError(response.status, json) : readGoogleError(response.status, json);
    return { ok: false, ...e };
  }
  // Graph answers some refusals with a 200 and an error body.
  if (provider === "META" && json && typeof json === "object" && "error" in (json as object)) {
    return { ok: false, ...readMetaError(response.status, json) };
  }
  return { ok: true, json: json as T, status: response.status, headers: response.headers };
}

/** A form body, the shape Graph and Google's token endpoint both take. */
export function form(fields: Record<string, string | number | boolean | object | null | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return body;
}

// ---------------------------------------------------------------------------
// What a publisher is handed, and what it hands back
// ---------------------------------------------------------------------------

export type R<T> = { ok: true; value: T } | ({ ok: false } & PlatformError);

export const ok = <T>(value: T): R<T> => ({ ok: true, value });

/** Every id the platform has confirmed so far, by step. */
export type Steps = Record<string, unknown>;

/**
 * One publication, from the publisher's side.
 *
 * `save()` writes a step before the next is attempted, and only the worker
 * holding the lease may write, so a retry reads exactly what was confirmed.
 */
export type StepContext = {
  orgId: string;
  targetId: string;
  /** The idempotency key; its start names every object created. */
  key: string;
  /** The node advertised, for object names a person can read in Ads Manager. */
  place: string;
  /** Its city, for an ad's location. */
  city: string | null;
  /** The site's pin, the nearest at or above the node: an ad is shown in a ring around it. */
  pin?: { lat: number; lng: number } | null;
  format: import("./connect-rules.ts").Format;
  headline: string;
  body: string;
  caption: string;
  language: string;
  /** In order; a companion size of the same card carries its `placement`. */
  media: { key: string; type: string; width: number; height: number; placement?: string }[];
  bytes(index: number): Promise<Buffer | null>;
  /** A link the platform can fetch for a short while. Instagram and Business Profile fetch; they do not take uploads. */
  publicUrl(index: number): Promise<string | null>;
  steps: Steps;
  save(patch: Steps): Promise<void>;
  /** The token for this destination: a Page's own, the ad account's, or a fresh Google access token. */
  token: string;
  account: { externalId: string; name: string; detail: Record<string, unknown> };
  /** The Page and Instagram account an ad speaks as. */
  page: { id: string; instagramId: string | null; token?: string | null } | null;
  /** What a Meta ad is optimised for. */
  goal?: import("./connect-rules.ts").AdGoal | null;
  /** The developer's own WhatsApp number a Click-to-WhatsApp ad opens, E.164. */
  whatsappNumber?: string | null;
  /** The developer's privacy policy, which a lead form links to. */
  privacyUrl?: string | null;
  /** Where a Google lead form posts its leads, with its key. */
  leadWebhook?: { url: string; key: string } | null;
  /** The brand's mark made square, for an ad that shows a logo. */
  logo?: () => Promise<Buffer | null>;
  /** The words, keywords and pictures a brief's campaign was built from, frozen on the row. */
  bundle?: import("./google-ad-rules.ts").CampaignBundle | null;
  /** Whether the Google connection may upload to YouTube. */
  youtube?: boolean;
  dailyBudget: number | null;
  destinationUrl: string | null;
  /** When the ad stops by itself, for an ad a schedule made. */
  endsAt?: Date | null;
  /** A Meta ad account bidding on qualified buyers: the dataset and the conversion its ad sets optimise for. */
  optimise?: { datasetId: string; conversionId: string } | null;
  businessNames: string[];
  now: Date;
};

export type StepOutcome =
  | { kind: "done"; state: "LIVE" | "PAUSED"; externalUrl: string | null; note?: string }
  | { kind: "wait"; ms: number }
  | { kind: "fail"; error: PlatformError };

export const failed = (e: PlatformError): StepOutcome => ({ kind: "fail", error: e });

/** An error of our own, in the platform's shape, for a publisher that cannot go on. */
export const refuse = (code: PlatformError["code"], message: string, retryable = false): PlatformError => ({
  code,
  message,
  retryable,
});

/**
 * Do a step once.
 *
 * A step with a recorded id is done. A step that was attempted and never
 * recorded may have happened anyway (the answer was lost, the worker died),
 * so it is looked for first, by name or by content, and only created when
 * nothing is found. Every create is marked as tried before it is sent, which
 * is what makes the look-first possible.
 */
export async function ensure(
  ctx: Pick<StepContext, "steps" | "save" | "now">,
  name: string,
  find: (() => Promise<R<string | null>>) | null,
  create: () => Promise<R<string>>,
): Promise<R<string>> {
  const have = ctx.steps[name];
  if (typeof have === "string" && have) return ok(have);
  if (ctx.steps[`${name}_tried`] && find) {
    const found = await find();
    if (!found.ok) return found;
    if (found.value) {
      await ctx.save({ [name]: found.value });
      return ok(found.value);
    }
  }
  await ctx.save({ [`${name}_tried`]: ctx.now.toISOString() });
  const made = await create();
  if (!made.ok) return made;
  await ctx.save({ [name]: made.value });
  return made;
}

/** A query string, skipping what is not there. */
export function query(fields: Record<string, string | number | boolean | object | null | undefined>): string {
  const q = form(fields).toString();
  return q ? `?${q}` : "";
}
