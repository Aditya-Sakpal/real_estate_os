/**
 * Meta: consent, the accounts behind it, and publishing into them.
 *
 * Three destinations share one connection. A Facebook Page post and an
 * Instagram post go up at once and are organic. An ad is created in the
 * developer's own ad account and left PAUSED: the campaign is created off,
 * so nothing spends until a person switches it on, here or in Ads Manager.
 * Stopping spend needs nobody's permission; starting it is a decision.
 *
 * Every request goes through `platform.ts`, with the token in an
 * Authorization header rather than a URL, and with `appsecret_proof`, so a
 * token copied out of this process is useless without the app secret too.
 *
 * Nothing here is proven against Meta itself. The app has not been through
 * App Review, so the calls are written to Meta's published reference and
 * exercised by `check:connect` against a fake that behaves like it.
 */

import { createHmac } from "node:crypto";
import {
  META_AGE_MIN,
  META_SCOPES,
  metaGeo,
  metaPlacements,
  objectName,
  specialAdCategory,
  toMetaMinor,
  type AdGoal,
  type Choice,
} from "./connect-rules.ts";
import { QUALIFIED_CONVERSION_NAME, metaAdGoal, metaLeadsGoal, qualifiedConversionRule } from "./attribution-rules.ts";
import { leadFormBody, readSpec } from "./lead-form-rules.ts";
import {
  call,
  ensure,
  failed,
  form,
  HOSTS,
  META_GRAPH_VERSION,
  ok,
  query,
  refuse,
  UPLOAD_TIMEOUT_MS,
  type R,
  type StepContext,
  type StepOutcome,
} from "./platform.ts";

const env = (name: string) => (process.env[name] ?? "").trim() || null;

export function metaConfigured(): boolean {
  return !!(env("META_APP_ID") && env("META_APP_SECRET"));
}

const graph = (path: string, host: string = HOSTS.graph) => `${host}/${META_GRAPH_VERSION}/${path.replace(/^\//, "")}`;

/** Proves the caller holds the app secret as well as the token. */
function proof(token: string): string | undefined {
  const secret = env("META_APP_SECRET");
  return secret ? createHmac("sha256", secret).update(token).digest("hex") : undefined;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function get<T>(token: string, path: string, params: Record<string, unknown> = {}): Promise<R<T>> {
  const r = await call<T>("META", graph(path) + query({ ...params, appsecret_proof: proof(token) } as never), {
    method: "GET",
    headers: auth(token),
  });
  return r.ok ? ok(r.json) : r;
}

async function post<T>(
  token: string,
  path: string,
  fields: Record<string, unknown> | FormData,
  opts: { host?: string; timeoutMs?: number } = {},
): Promise<R<T>> {
  let body: URLSearchParams | FormData;
  const p = proof(token);
  if (fields instanceof FormData) {
    if (p) fields.set("appsecret_proof", p);
    body = fields;
  } else {
    body = form({ ...fields, appsecret_proof: p } as never);
  }
  const r = await call<T>("META", graph(path, opts.host), {
    method: "POST",
    headers: auth(token),
    body,
    timeoutMs: opts.timeoutMs,
  });
  return r.ok ? ok(r.json) : r;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Where a person is sent to consent.
 *
 * With `META_CONFIG_ID` it is Facebook Login for Business, whose configuration
 * names the permissions and can issue a system-user token: one that belongs
 * to the business rather than the person, so publishing does not stop the
 * day the marketing head who clicked Connect leaves. Without it, the classic
 * dialog and a person's token, which lasts sixty days.
 */
export function metaAuthUrl(input: { state: string; redirectUri: string }): string {
  const config = env("META_CONFIG_ID");
  return (
    `${HOSTS.facebook}/${META_GRAPH_VERSION}/dialog/oauth` +
    query({
      client_id: env("META_APP_ID"),
      redirect_uri: input.redirectUri,
      state: input.state,
      response_type: "code",
      ...(config ? { config_id: config, override_default_response_type: true } : { scope: META_SCOPES.join(",") }),
    })
  );
}

export type MetaGrant = {
  token: string;
  /** Null when the token does not expire: a system user's, or a Page's. */
  expiresAt: Date | null;
  userId: string | null;
  scopes: string[];
  systemUser: boolean;
};

type Debug = {
  data?: {
    is_valid?: boolean;
    type?: string;
    expires_at?: number;
    scopes?: string[];
    user_id?: string;
    error?: { message?: string };
  };
};

/** What Meta says a token is: valid, whose, which permissions, until when. */
export async function metaInspect(token: string): Promise<R<MetaGrant & { valid: boolean }>> {
  const appToken = `${env("META_APP_ID")}|${env("META_APP_SECRET")}`;
  const r = await call<Debug>("META", graph("debug_token") + query({ input_token: token, access_token: appToken }), {
    method: "GET",
  });
  if (!r.ok) return r;
  const d = r.json.data ?? {};
  return ok({
    token,
    valid: d.is_valid === true,
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null,
    userId: d.user_id ?? null,
    scopes: d.scopes ?? [],
    systemUser: (d.type ?? "").toUpperCase() === "SYSTEM_USER",
  });
}

/**
 * The code Meta handed back, exchanged for a token that lasts.
 *
 * A person's short token is swapped for the sixty-day one at once; a system
 * user's already does not expire and is kept as it came.
 */
export async function metaExchange(input: { code: string; redirectUri: string }): Promise<R<MetaGrant>> {
  const first = await call<{ access_token?: string }>(
    "META",
    graph("oauth/access_token") +
      query({
        client_id: env("META_APP_ID"),
        client_secret: env("META_APP_SECRET"),
        redirect_uri: input.redirectUri,
        code: input.code,
      }),
    { method: "GET" },
  );
  if (!first.ok) return first;
  let token = first.json.access_token ?? "";
  if (!token) return { ok: false, ...refuse("INVALID", "Meta did not hand back a token.") };

  let seen = await metaInspect(token);
  if (!seen.ok) return seen;
  if (!seen.value.valid) return { ok: false, ...refuse("TOKEN_INVALID", "Meta handed back a token that does not work.") };

  if (!seen.value.systemUser && seen.value.expiresAt) {
    const long = await call<{ access_token?: string }>(
      "META",
      graph("oauth/access_token") +
        query({
          grant_type: "fb_exchange_token",
          client_id: env("META_APP_ID"),
          client_secret: env("META_APP_SECRET"),
          fb_exchange_token: token,
        }),
      { method: "GET" },
    );
    if (!long.ok) return long;
    if (long.json.access_token) {
      token = long.json.access_token;
      seen = await metaInspect(token);
      if (!seen.ok) return seen;
    }
  }
  const { valid: _valid, ...grant } = seen.value;
  return ok({ ...grant, token });
}

/** Take the permission back. What "Disconnect" means to Meta. */
export async function metaRevoke(token: string): Promise<R<true>> {
  const r = await call("META", graph("me/permissions") + query({ appsecret_proof: proof(token) }), {
    method: "DELETE",
    headers: auth(token),
  });
  return r.ok ? ok(true) : r;
}

// ---------------------------------------------------------------------------
// The accounts behind a consent
// ---------------------------------------------------------------------------

type PageRow = {
  id: string;
  name: string;
  instagram_business_account?: { id: string; username?: string };
};
type AdAccountRow = {
  id: string;
  account_id?: string;
  name?: string;
  currency?: string;
  account_status?: number;
  business?: { name?: string };
};

const AD_ACCOUNT_STATUS: Record<number, string> = {
  1: "Active",
  2: "Disabled",
  3: "Payment due",
  7: "Under review",
  8: "Pending settlement",
  9: "In grace period",
  100: "Pending closure",
  101: "Closed",
};

/** Every Page, Instagram account and ad account the person who consented can use. */
export async function metaDiscover(token: string): Promise<R<Choice[]>> {
  const [pages, ads] = await Promise.all([
    get<{ data?: PageRow[] }>(token, "me/accounts", {
      fields: "id,name,instagram_business_account{id,username}",
      limit: 100,
    }),
    get<{ data?: AdAccountRow[] }>(token, "me/adaccounts", {
      fields: "id,account_id,name,currency,account_status,business{name}",
      limit: 100,
    }),
  ]);
  if (!pages.ok) return pages;

  const choices: Choice[] = [];
  for (const p of pages.value.data ?? []) {
    const ig = p.instagram_business_account;
    choices.push({
      kind: "FACEBOOK_PAGE",
      id: p.id,
      name: p.name,
      detail: { instagram_id: ig?.id ?? null },
    });
    if (ig?.id) {
      choices.push({
        kind: "INSTAGRAM",
        id: ig.id,
        name: ig.username ? `@${ig.username}` : p.name,
        detail: { page_id: p.id, page_name: p.name },
      });
    }
  }
  // An ad account the person cannot reach is not a reason to lose the Pages
  // they can: publishing organic posts needs no ad account at all.
  if (ads.ok) {
    for (const a of ads.value.data ?? []) {
      choices.push({
        kind: "META_AD_ACCOUNT",
        id: a.id.startsWith("act_") ? a.id : `act_${a.id}`,
        name: a.name ?? a.account_id ?? a.id,
        detail: {
          currency: a.currency ?? null,
          status: AD_ACCOUNT_STATUS[a.account_status ?? 0] ?? null,
          business: a.business?.name ?? null,
        },
      });
    }
    // The datasets (pixels) each ad account can use: where outcomes are sent
    // back to. A few ad accounts at most, so one agency login cannot fan out.
    const accounts = (ads.value.data ?? []).slice(0, MAX_DATASET_ACCOUNTS);
    const lists = await Promise.all(
      accounts.map((a) =>
        get<{ data?: { id?: string; name?: string }[] }>(token, `${a.id.startsWith("act_") ? a.id : `act_${a.id}`}/adspixels`, {
          fields: "id,name",
          limit: 50,
        }),
      ),
    );
    lists.forEach((l, i) => {
      if (!l.ok) return;
      for (const d of l.value.data ?? []) {
        if (!d.id || choices.some((c) => c.kind === "META_DATASET" && c.id === d.id)) continue;
        choices.push({ kind: "META_DATASET", id: d.id, name: d.name ?? d.id, detail: { ad_account: accounts[i].name ?? accounts[i].id } });
      }
    });
  }
  return ok(choices);
}

/** Ad accounts whose datasets are listed at consent. */
const MAX_DATASET_ACCOUNTS = 10;

/** A Page's own token, fetched with the person's. One from a long-lived token does not expire. */
export async function metaPageToken(userToken: string, pageId: string): Promise<R<string>> {
  const r = await get<{ access_token?: string }>(userToken, pageId, { fields: "access_token" });
  if (!r.ok) return r;
  if (!r.value.access_token) {
    return { ok: false, ...refuse("PERMISSION", "Meta gave no token for that Page. Reconnect and allow the Page.") };
  }
  return ok(r.value.access_token);
}

// ---------------------------------------------------------------------------
// Posting to a Facebook Page
// ---------------------------------------------------------------------------

const blob = (bytes: Buffer, type: string) => new Blob([new Uint8Array(bytes)], { type });

/**
 * Look for a post a crashed attempt may already have made, by its words.
 * Only ever asked after a create was tried and not recorded.
 */
async function recentPageItem(
  ctx: StepContext,
  edge: "published_posts" | "videos",
  field: "message" | "description",
  since: string,
): Promise<R<string | null>> {
  const r = await get<{ data?: { id: string; message?: string; description?: string }[] }>(
    ctx.token,
    `${ctx.account.externalId}/${edge}`,
    { fields: `id,${field},created_time`, since: Math.floor(new Date(since).getTime() / 1000) - 60, limit: 25 },
  );
  if (!r.ok) return r;
  const hit = (r.value.data ?? []).find((p) => (p[field] ?? "").trim() === ctx.caption.trim());
  return ok(hit?.id ?? null);
}

async function permalink(token: string, id: string): Promise<string | null> {
  const r = await get<{ permalink_url?: string }>(token, id, { fields: "permalink_url" });
  if (!r.ok || !r.value.permalink_url) return null;
  const url = r.value.permalink_url;
  return url.startsWith("http") ? url : `${HOSTS.facebook}${url}`;
}

export async function publishToFacebook(ctx: StepContext): Promise<StepOutcome> {
  const page = ctx.account.externalId;
  const since = () => String(ctx.steps.post_tried ?? ctx.now.toISOString());

  if (ctx.format === "VIDEO") {
    const video = await ensure(
      ctx,
      "post",
      () => recentPageItem(ctx, "videos", "description", since()),
      async () => {
        const bytes = await ctx.bytes(0);
        if (!bytes) return { ok: false, ...refuse("NOT_FOUND", "The video file is gone.") };
        const f = new FormData();
        f.set("source", blob(bytes, "video/mp4"), "post.mp4");
        f.set("description", ctx.caption);
        f.set("title", ctx.headline.slice(0, 250));
        const r = await post<{ id?: string }>(ctx.token, `${page}/videos`, f, {
          host: HOSTS.graphVideo,
          timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        return r.ok ? ok(String(r.value.id ?? "")) : r;
      },
    );
    if (!video.ok) return failed(video);
    return { kind: "done", state: "LIVE", externalUrl: (await permalink(ctx.token, video.value)) ?? `${HOSTS.facebook}/${video.value}` };
  }

  if (ctx.format === "PHOTO") {
    const photo = await ensure(
      ctx,
      "post",
      () => recentPageItem(ctx, "published_posts", "message", since()),
      async () => {
        const bytes = await ctx.bytes(0);
        if (!bytes) return { ok: false, ...refuse("NOT_FOUND", "The picture is gone.") };
        const f = new FormData();
        f.set("source", blob(bytes, ctx.media[0].type), "post.jpg");
        f.set("message", ctx.caption);
        const r = await post<{ id?: string; post_id?: string }>(ctx.token, `${page}/photos`, f, {
          timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        return r.ok ? ok(String(r.value.post_id ?? r.value.id ?? "")) : r;
      },
    );
    if (!photo.ok) return failed(photo);
    return { kind: "done", state: "LIVE", externalUrl: (await permalink(ctx.token, photo.value)) ?? `${HOSTS.facebook}/${photo.value}` };
  }

  // An album: each picture uploaded unpublished, then one post carrying them
  // all. An unpublished photo that never gets attached is invisible, so the
  // uploads need no look-first; only the post does.
  const ids: string[] = [];
  for (let i = 0; i < ctx.media.length; i++) {
    const photo = await ensure(ctx, `photo_${i}`, null, async () => {
      const bytes = await ctx.bytes(i);
      if (!bytes) return { ok: false, ...refuse("NOT_FOUND", `Slide ${i + 1} is gone.`) };
      const f = new FormData();
      f.set("source", blob(bytes, ctx.media[i].type), `slide-${i + 1}.jpg`);
      f.set("published", "false");
      const r = await post<{ id?: string }>(ctx.token, `${page}/photos`, f, { timeoutMs: UPLOAD_TIMEOUT_MS });
      return r.ok ? ok(String(r.value.id ?? "")) : r;
    });
    if (!photo.ok) return failed(photo);
    ids.push(photo.value);
  }
  const album = await ensure(
    ctx,
    "post",
    () => recentPageItem(ctx, "published_posts", "message", since()),
    async () => {
      const r = await post<{ id?: string }>(ctx.token, `${page}/feed`, {
        message: ctx.caption,
        attached_media: ids.map((id) => ({ media_fbid: id })),
      });
      return r.ok ? ok(String(r.value.id ?? "")) : r;
    },
  );
  if (!album.ok) return failed(album);
  return { kind: "done", state: "LIVE", externalUrl: (await permalink(ctx.token, album.value)) ?? `${HOSTS.facebook}/${album.value}` };
}

// ---------------------------------------------------------------------------
// Posting to Instagram
// ---------------------------------------------------------------------------

/** How long to wait before asking again whether Instagram has finished with a file. */
const IG_POLL_MS = 15_000;

async function containerState(token: string, id: string): Promise<R<string>> {
  const r = await get<{ status_code?: string }>(token, id, { fields: "status_code" });
  return r.ok ? ok((r.value.status_code ?? "IN_PROGRESS").toUpperCase()) : r;
}

/**
 * A picture's container is usually ready in a second or two, and the worker
 * passes every ten minutes, so handing back a wait at the first IN_PROGRESS
 * put every Instagram picture a pass late. A picture is asked again, two
 * seconds apart, until `deadline`; a video is asked once, since it takes
 * minutes. The status read costs nothing.
 */
async function settledState(token: string, id: string, deadline: number | null): Promise<R<string>> {
  for (;;) {
    const s = await containerState(token, id);
    if (!s.ok || s.value !== "IN_PROGRESS" || deadline === null || Date.now() + IG_SETTLE_STEP_MS > deadline) return s;
    await new Promise((r) => setTimeout(r, IG_SETTLE_STEP_MS));
  }
}

/** How long one publish attempt waits for Instagram to finish a picture, in all. */
const IG_SETTLE_MS = 12_000;
const IG_SETTLE_STEP_MS = 2_000;

async function recentInstagram(ctx: StepContext, since: string): Promise<R<string | null>> {
  const r = await get<{ data?: { id: string; caption?: string; timestamp?: string }[] }>(
    ctx.token,
    `${ctx.account.externalId}/media`,
    { fields: "id,caption,timestamp", limit: 25 },
  );
  if (!r.ok) return r;
  const after = new Date(since).getTime() - 60_000;
  const hit = (r.value.data ?? []).find(
    (m) => (m.caption ?? "").trim() === ctx.caption.trim() && new Date(m.timestamp ?? 0).getTime() >= after,
  );
  return ok(hit?.id ?? null);
}

/**
 * Instagram fetches the file itself, from a link, and publishes in two steps:
 * a container, then the publish. The container can take minutes for a reel,
 * so a publisher that finds it still processing hands back a wait rather than
 * holding a worker, and the next pass asks again.
 */
export async function publishToInstagram(ctx: StepContext): Promise<StepOutcome> {
  const ig = ctx.account.externalId;
  const video = ctx.media.some((m) => m.type === "video/mp4");
  const deadline = video ? null : Date.now() + IG_SETTLE_MS;

  const container = async (fields: Record<string, unknown>) => {
    const r = await post<{ id?: string }>(ctx.token, `${ig}/media`, fields);
    return r.ok ? ok(String(r.value.id ?? "")) : r;
  };
  const link = async (i: number) => {
    const url = await ctx.publicUrl(i);
    return url ? ok(url) : ({ ok: false, ...refuse("NOT_FOUND", "The file is gone.") } as const);
  };

  let top: R<string>;
  if (ctx.format === "CAROUSEL") {
    const children: string[] = [];
    for (let i = 0; i < ctx.media.length; i++) {
      const child = await ensure(ctx, `child_${i}`, null, async () => {
        const url = await link(i);
        return url.ok ? container({ image_url: url.value, is_carousel_item: true }) : url;
      });
      if (!child.ok) return failed(child);
      children.push(child.value);
    }
    for (const id of children) {
      const s = await settledState(ctx.token, id, deadline);
      if (!s.ok) return failed(s);
      if (s.value === "ERROR" || s.value === "EXPIRED") {
        return failed(refuse("INVALID", "Instagram could not read one of the slides."));
      }
      if (s.value !== "FINISHED") return { kind: "wait", ms: IG_POLL_MS };
    }
    top = await ensure(ctx, "container", null, () =>
      container({ media_type: "CAROUSEL", children: children.join(","), caption: ctx.caption }),
    );
  } else if (ctx.format === "REELS" || (ctx.format === "STORIES" && ctx.media[0].type === "video/mp4")) {
    top = await ensure(ctx, "container", null, async () => {
      const url = await link(0);
      if (!url.ok) return url;
      return ctx.format === "STORIES"
        ? container({ media_type: "STORIES", video_url: url.value })
        : container({ media_type: "REELS", video_url: url.value, caption: ctx.caption, share_to_feed: true });
    });
  } else {
    top = await ensure(ctx, "container", null, async () => {
      const url = await link(0);
      if (!url.ok) return url;
      return ctx.format === "STORIES"
        ? container({ media_type: "STORIES", image_url: url.value })
        : container({ image_url: url.value, caption: ctx.caption });
    });
  }
  if (!top.ok) return failed(top);

  const state = await settledState(ctx.token, top.value, deadline);
  if (!state.ok) return failed(state);
  if (state.value === "ERROR") return failed(refuse("INVALID", "Instagram could not process this file."));
  if (state.value === "EXPIRED") {
    // A container lives a day. One that expired is made again from the start.
    await ctx.save({ container: null, container_tried: null });
    return { kind: "wait", ms: 1_000 };
  }
  if (state.value !== "FINISHED" && state.value !== "PUBLISHED") return { kind: "wait", ms: IG_POLL_MS };

  const since = () => String(ctx.steps.media_tried ?? ctx.now.toISOString());
  const media = await ensure(
    ctx,
    "media",
    // A story carries no caption, so it cannot be found by one.
    ctx.format === "STORIES" ? null : () => recentInstagram(ctx, since()),
    async () => {
      const r = await post<{ id?: string }>(ctx.token, `${ig}/media_publish`, { creation_id: top.value });
      return r.ok ? ok(String(r.value.id ?? "")) : r;
    },
  );
  if (!media.ok) return failed(media);

  const p = await get<{ permalink?: string }>(ctx.token, media.value, { fields: "permalink" });
  return { kind: "done", state: "LIVE", externalUrl: p.ok ? p.value.permalink ?? null : null };
}

// ---------------------------------------------------------------------------
// A Meta ad, created paused
// ---------------------------------------------------------------------------

/**
 * The radius around the project's city, in kilometres, when the project has
 * no pin. With a pin the ad is shown in a ring around the site instead
 * (`metaGeo()`). The housing category is declared only where Meta requires
 * it (`specialAdCategory()`): an India-only ad does not.
 */
export const META_RADIUS_KM = 25;

async function findByName(ctx: StepContext, edge: string, name: string): Promise<R<string | null>> {
  const r = await get<{ data?: { id: string; name?: string }[] }>(ctx.token, `${ctx.account.externalId}/${edge}`, {
    fields: "id,name",
    filtering: [{ field: "name", operator: "CONTAIN", value: ctx.key.slice(0, 10) }],
    limit: 25,
  });
  if (!r.ok) return r;
  return ok((r.value.data ?? []).find((x) => x.name === name)?.id ?? null);
}

const VIDEO_POLL_MS = 20_000;

/**
 * What each goal asks of Meta: the campaign's objective, the ad set's
 * optimisation and where it sends people, and the button.
 */
const GOAL_SETUP: Record<AdGoal, { objective: string; optimization: string; destination: string | null; cta: string }> = {
  LEADS: { objective: "OUTCOME_LEADS", optimization: "LEAD_GENERATION", destination: "ON_AD", cta: "SIGN_UP" },
  WHATSAPP: { objective: "OUTCOME_ENGAGEMENT", optimization: "CONVERSATIONS", destination: "WHATSAPP", cta: "WHATSAPP_MESSAGE" },
  TRAFFIC: { objective: "OUTCOME_TRAFFIC", optimization: "LINK_CLICKS", destination: "WEBSITE", cta: "LEARN_MORE" },
  AWARENESS: { objective: "OUTCOME_AWARENESS", optimization: "REACH", destination: null, cta: "LEARN_MORE" },
};

/** Where a Click-to-WhatsApp ad's link points: Meta opens the chat itself. */
export const WHATSAPP_LINK = "https://api.whatsapp.com/send";

/** The two boxes on our instant form. The second's key says "measure", which is how the reader tells them apart. */
export const FORM_CONSENT_KEY = "contact_consent";
export const FORM_MEASURE_KEY = "measure_consent";

/**
 * The instant form a Leads ad opens, on the developer's own Page: higher
 * intent with the number confirmed by a code, the price and the place on
 * its intro, and the questions frozen on the publication when it was queued
 * (`lead-form-rules.ts`); then a box for being contacted, required, and a
 * box for measurement, not required, so the buyer chooses each. Filed under
 * the Page with its own token, which `pages_manage_ads` allows.
 */
async function ensureLeadForm(ctx: StepContext, name: string, link: string): Promise<R<string>> {
  const page = ctx.page!;
  const token = page.token ?? null;
  if (!token) return { ok: false, ...refuse("PERMISSION", "Meta gave no token for the Page. Reconnect Meta and allow the Page.") };
  if (!ctx.privacyUrl) return { ok: false, ...refuse("INVALID", "A lead form needs your privacy policy link. Add it in Library, Branding.") };
  const brand = ctx.businessNames[0] ?? ctx.place;
  return ensure(
    ctx,
    "form_id",
    async () => {
      const r = await get<{ data?: { id: string; name?: string }[] }>(token, `${page.id}/leadgen_forms`, { fields: "id,name", limit: 50 });
      if (!r.ok) return r;
      return ok((r.value.data ?? []).find((f) => f.name === name)?.id ?? null);
    },
    async () => {
      const r = await post<{ id?: string }>(
        token,
        `${page.id}/leadgen_forms`,
        leadFormBody({
          name,
          spec: readSpec(ctx.steps.form),
          brand,
          place: ctx.place,
          privacyUrl: ctx.privacyUrl!,
          link,
          consentKey: FORM_CONSENT_KEY,
          measureKey: FORM_MEASURE_KEY,
        }),
      );
      return r.ok ? ok(String(r.value.id ?? "")) : r;
    },
  );
}

/** A picture into the ad account's library, by its hash. */
async function adImage(ctx: StepContext, act: string, i: number): Promise<R<string>> {
  return ensure(ctx, `image_${i}`, null, async () => {
    const bytes = await ctx.bytes(i);
    if (!bytes) return { ok: false, ...refuse("NOT_FOUND", "A picture is gone.") };
    const r = await post<{ images?: Record<string, { hash?: string }> }>(
      ctx.token,
      `${act}/adimages`,
      { bytes: bytes.toString("base64") },
      { timeoutMs: UPLOAD_TIMEOUT_MS },
    );
    if (!r.ok) return r;
    const first = Object.values(r.value.images ?? {})[0];
    return first?.hash ? ok(first.hash) : { ok: false, ...refuse("INVALID", "Meta took the picture and named no hash.") };
  });
}

/** A clip into the ad account's library, and whether Meta has finished with it. */
async function adVideo(ctx: StepContext, act: string, i: number, name: string): Promise<R<{ id: string; picture: string } | "wait">> {
  const id = await ensure(ctx, i === 0 ? "video_id" : `video_${i}`, null, async () => {
    const bytes = await ctx.bytes(i);
    if (!bytes) return { ok: false, ...refuse("NOT_FOUND", "The video file is gone.") };
    const f = new FormData();
    f.set("source", blob(bytes, "video/mp4"), "ad.mp4");
    f.set("name", name);
    const r = await post<{ id?: string }>(ctx.token, `${act}/advideos`, f, {
      host: HOSTS.graphVideo,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    return r.ok ? ok(String(r.value.id ?? "")) : r;
  });
  if (!id.ok) return id;
  const s = await get<{ status?: { video_status?: string }; picture?: string }>(ctx.token, id.value, { fields: "status,picture" });
  if (!s.ok) return s;
  const status = (s.value.status?.video_status ?? "processing").toLowerCase();
  if (status === "error") return { ok: false, ...refuse("INVALID", "Meta could not process this video.") };
  if (status !== "ready" || !s.value.picture) return ok("wait");
  return ok({ id: id.value, picture: s.value.picture });
}

/** Stories and Reels, where the 9:16 version is shown. */
const TALL_PLACEMENTS = {
  publisher_platforms: ["facebook", "instagram"],
  facebook_positions: ["story", "facebook_reels"],
  instagram_positions: ["story", "reels"],
};
const isTallFrame = (m: { width: number; height: number }) => m.height > 0 && m.width / m.height < 0.7;

export async function createMetaAd(ctx: StepContext): Promise<StepOutcome> {
  const act = ctx.account.externalId;
  if (!ctx.page) return failed(refuse("INVALID", "An ad needs a Facebook Page to speak as. Choose one in Settings."));
  if (!ctx.destinationUrl || !ctx.dailyBudget) return failed(refuse("INVALID", "An ad needs a landing page and a budget."));
  const goal: AdGoal = ctx.goal ?? "TRAFFIC";
  const setup = GOAL_SETUP[goal];
  if (goal === "WHATSAPP" && !ctx.whatsappNumber) {
    return failed(refuse("INVALID", "Connect your WhatsApp number in Settings, Connected accounts first."));
  }
  const link = goal === "WHATSAPP" ? WHATSAPP_LINK : ctx.destinationUrl;
  const name = (part: string) => objectName({ place: ctx.place, key: ctx.key, part });
  // Bidding on qualified buyers is a website conversion goal, so it applies
  // only to a website ad on an account that switched it on. It is decided
  // once, on the first attempt, so a retry after bidding was switched never
  // builds half of each.
  // A Leads ad on such an account is delivered for qualified leads instead
  // (Meta's conversion leads, `metaLeadsGoal()`).
  const bids = goal === "TRAFFIC" || goal === "LEADS";
  if (!("optimise" in ctx.steps)) await ctx.save({ optimise: bids ? ctx.optimise ?? null : null });
  const qualified = bids ? ((ctx.steps.optimise as { datasetId: string; conversionId: string } | null) ?? null) : null;
  const bid = qualified && goal === "TRAFFIC" ? metaAdGoal(qualified) : null;

  // The form first, for a Leads ad: nothing else is worth making without it.
  let formId: string | null = null;
  if (goal === "LEADS") {
    const form = await ensureLeadForm(ctx, name("form"), ctx.destinationUrl);
    if (!form.ok) return failed(form);
    formId = form.value;
  }
  const cta =
    goal === "LEADS"
      ? { type: setup.cta, value: { lead_gen_form_id: formId, link } }
      : goal === "WHATSAPP"
        ? { type: setup.cta, value: { app_destination: "WHATSAPP", link } }
        : { type: setup.cta, value: { link } };

  // The pictures, or the clips, into the ad account's own library: the card
  // itself, and its other size when the publication carries one.
  const hashes: string[] = [];
  const videos: { id: string; picture: string }[] = [];
  if (ctx.format === "VIDEO") {
    for (let i = 0; i < Math.min(ctx.media.length, 2); i++) {
      const v = await adVideo(ctx, act, i, name(i === 0 ? "video" : "video tall"));
      if (!v.ok) return failed(v);
      if (v.value === "wait") return { kind: "wait", ms: VIDEO_POLL_MS };
      videos.push(v.value);
    }
  } else {
    const count = ctx.format === "PHOTO" ? Math.min(ctx.media.length, 2) : ctx.media.length;
    for (let i = 0; i < count; i++) {
      const hash = await adImage(ctx, act, i);
      if (!hash.ok) return failed(hash);
      hashes.push(hash.value);
    }
  }

  // Where. The project's city and a radius around it, or the whole country
  // when Meta does not know the city, which the note says so a person narrows
  // it before switching the ad on.
  if (!ctx.steps.geo) {
    let geo: Record<string, unknown> = { countries: ["IN"] };
    let note: string | null = "Shown across India. Narrow the location in Ads Manager before switching it on.";
    const ring = metaGeo(ctx.pin ?? null);
    if (ring) {
      geo = ring;
      note = null;
    } else if (ctx.city) {
      const r = await get<{ data?: { key?: string; name?: string }[] }>(ctx.token, "search", {
        type: "adgeolocation",
        location_types: ["city"],
        q: ctx.city,
        country_code: "IN",
        limit: 1,
      });
      const key = r.ok ? r.value.data?.[0]?.key : undefined;
      if (key) {
        geo = { cities: [{ key, radius: META_RADIUS_KM, distance_unit: "kilometer" }] };
        note = null;
      }
    }
    await ctx.save({ geo, geo_note: note });
  }

  const campaign = await ensure(
    ctx,
    "campaign_id",
    () => findByName(ctx, "campaigns", name("campaign")),
    async () => {
      const r = await post<{ id?: string }>(ctx.token, `${act}/campaigns`, {
        name: name("campaign"),
        objective: bid?.objective ?? setup.objective,
        status: "PAUSED",
        buying_type: "AUCTION",
        // Every ad here is shown in India only.
        ...specialAdCategory(["IN"]),
        is_adset_budget_sharing_enabled: false,
      });
      return r.ok ? ok(String(r.value.id ?? "")) : r;
    },
  );
  if (!campaign.ok) return failed(campaign);

  const promoted =
    goal === "LEADS"
      ? {}
      : goal === "WHATSAPP"
        ? { promoted_object: { page_id: ctx.page.id, whatsapp_phone_number: ctx.whatsappNumber } }
        : {};
  const adset = await ensure(
    ctx,
    "adset_id",
    () => findByName(ctx, "adsets", name("ad set")),
    async () => {
      const r = await post<{ id?: string }>(ctx.token, `${act}/adsets`, {
        name: name("ad set"),
        campaign_id: campaign.value,
        daily_budget: toMetaMinor(ctx.dailyBudget!),
        ...(goal === "LEADS"
          ? metaLeadsGoal(qualified, ctx.page!.id)
          : bid
            ? bid.adset
            : { billing_event: "IMPRESSIONS", optimization_goal: setup.optimization }),
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        ...(setup.destination ? { destination_type: setup.destination } : {}),
        ...promoted,
        targeting: {
          geo_locations: ctx.steps.geo,
          age_min: META_AGE_MIN,
          ...metaPlacements(goal),
          targeting_automation: { advantage_audience: 0 },
        },
        // A scheduled ad runs for the days it was given and Meta stops it,
        // whether or not our worker is up to pause it.
        ...(ctx.endsAt ? { end_time: Math.floor(ctx.endsAt.getTime() / 1000) } : {}),
        // On under a paused campaign: the campaign is the one switch.
        status: "ACTIVE",
      });
      return r.ok ? ok(String(r.value.id ?? "")) : r;
    },
  );
  if (!adset.ok) return failed(adset);

  const speaksAs = {
    page_id: ctx.page.id,
    ...(ctx.page.instagramId ? { instagram_user_id: ctx.page.instagramId } : {}),
  };

  let creativeBody: Record<string, unknown>;
  const tallIndex = ctx.media.findIndex((m, i) => i > 0 && isTallFrame(m));
  // A Leads ad runs in the feeds only, so its tall size has nowhere to go.
  const twoSizes = goal !== "LEADS" && (ctx.format === "PHOTO" || ctx.format === "VIDEO") && ctx.media.length > 1;
  if (twoSizes) {
    // One ad, two sizes: the 9:16 one in Stories and Reels, the other
    // everywhere else, so neither is cropped or padded to fit.
    const tall = tallIndex > 0 ? tallIndex : isTallFrame(ctx.media[0]) ? 0 : 1;
    const wide = tall === 0 ? 1 : 0;
    const label = (i: number) => (i === tall ? "tall" : "wide");
    const assets =
      ctx.format === "VIDEO"
        ? { videos: videos.map((v, i) => ({ video_id: v.id, thumbnail_url: v.picture, adlabels: [{ name: label(i) }] })), ad_formats: ["SINGLE_VIDEO"] }
        : { images: hashes.map((h, i) => ({ hash: h, adlabels: [{ name: label(i) }] })), ad_formats: ["SINGLE_IMAGE"] };
    const which = ctx.format === "VIDEO" ? "video_label" : "image_label";
    creativeBody = {
      object_story_spec: speaksAs,
      asset_feed_spec: {
        ...assets,
        bodies: [{ text: ctx.caption }],
        titles: [{ text: ctx.headline }],
        link_urls: [{ website_url: link }],
        call_to_action_types: [setup.cta],
        ...(goal === "WHATSAPP" ? { call_to_actions: [cta] } : {}),
        optimization_type: "PLACEMENT",
        asset_customization_rules: [
          { customization_spec: TALL_PLACEMENTS, [which]: { name: label(tall) }, priority: 1 },
          { customization_spec: { publisher_platforms: ["facebook", "instagram"] }, [which]: { name: label(wide) }, priority: 2 },
        ],
      },
    };
  } else {
    const spec =
      ctx.format === "VIDEO"
        ? {
            ...speaksAs,
            video_data: {
              video_id: videos[0].id,
              image_url: videos[0].picture,
              message: ctx.caption,
              title: ctx.headline,
              call_to_action: cta,
            },
          }
        : ctx.format === "CAROUSEL"
          ? {
              ...speaksAs,
              link_data: {
                link,
                message: ctx.caption,
                child_attachments: hashes.map((h) => ({ link, image_hash: h, name: ctx.headline })),
                multi_share_optimized: false,
                multi_share_end_card: false,
                call_to_action: cta,
              },
            }
          : {
              ...speaksAs,
              link_data: { link, image_hash: hashes[0], message: ctx.caption, name: ctx.headline, call_to_action: cta },
            };
    creativeBody = { object_story_spec: spec };
  }

  const creative = await ensure(ctx, "creative_id", null, async () => {
    const r = await post<{ id?: string }>(ctx.token, `${act}/adcreatives`, { name: name("creative"), ...creativeBody });
    return r.ok ? ok(String(r.value.id ?? "")) : r;
  });
  if (!creative.ok) return failed(creative);

  const ad = await ensure(
    ctx,
    "ad_id",
    () => findByName(ctx, "ads", name("ad")),
    async () => {
      const r = await post<{ id?: string }>(ctx.token, `${act}/ads`, {
        name: name("ad"),
        adset_id: adset.value,
        creative: { creative_id: creative.value },
        status: "ACTIVE",
      });
      return r.ok ? ok(String(r.value.id ?? "")) : r;
    },
  );
  if (!ad.ok) return failed(ad);

  return {
    kind: "done",
    state: "PAUSED",
    externalUrl:
      `https://adsmanager.facebook.com/adsmanager/manage/campaigns` +
      query({ act: act.replace(/^act_/, ""), selected_campaign_ids: campaign.value }),
    note: typeof ctx.steps.geo_note === "string" ? ctx.steps.geo_note : undefined,
  };
}

/**
 * Switch an ad's spend on or off, at the campaign, which is the one switch
 * everything underneath it was created to obey.
 */
export async function setMetaAdSpend(token: string, steps: Record<string, unknown>, on: boolean): Promise<R<true>> {
  const campaign = typeof steps.campaign_id === "string" ? steps.campaign_id : null;
  if (!campaign) return { ok: false, ...refuse("NOT_FOUND", "This ad was never finished, so there is nothing to switch.") };
  const r = await post<{ success?: boolean }>(token, campaign, { status: on ? "ACTIVE" : "PAUSED" });
  return r.ok ? ok(true) : r;
}

// ---------------------------------------------------------------------------
// Leads from a Page's instant forms
// ---------------------------------------------------------------------------

/**
 * The answers behind one leadgen id. Meta's webhook carries ids only, so
 * the lead is read with the Page's own token, which needs `leads_retrieval`.
 */
export async function metaLead(pageToken: string, leadgenId: string): Promise<R<Record<string, unknown>>> {
  return get<Record<string, unknown>>(pageToken, leadgenId, {
    fields: "id,created_time,field_data,ad_id,adset_id,campaign_id,form_id,custom_disclaimer_responses,is_organic,platform",
  });
}

/**
 * Ask Meta to tell us when this Page's lead forms are filled. Without the
 * subscription no leadgen webhook is ever sent, whatever the app is set to.
 */
export async function metaSubscribeLeads(pageToken: string, pageId: string): Promise<R<true>> {
  const r = await post<{ success?: boolean }>(pageToken, `${pageId}/subscribed_apps`, { subscribed_fields: "leadgen" });
  return r.ok ? ok(true) : r;
}

// ---------------------------------------------------------------------------
// What an ad spent and brought, and moving its budget
// ---------------------------------------------------------------------------

export type DayStat = { day: string; spendPaise: number; impressions: number; clicks: number; leads: number };

type InsightRow = {
  date_start?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: { action_type?: string; value?: string }[];
};

/** One row per day for a campaign, in the account's currency, rupees here. */
export async function metaDailyStats(token: string, campaignId: string, since: string, until: string): Promise<R<DayStat[]>> {
  const r = await get<{ data?: InsightRow[] }>(token, `${campaignId}/insights`, {
    fields: "spend,impressions,clicks,actions",
    time_range: { since, until },
    time_increment: 1,
    level: "campaign",
  });
  if (!r.ok) return r;
  return ok(
    (r.value.data ?? [])
      .filter((d) => typeof d.date_start === "string")
      .map((d) => ({
        day: d.date_start!,
        spendPaise: Math.round(Number(d.spend ?? 0) * 100) || 0,
        impressions: Number(d.impressions ?? 0) || 0,
        clicks: Number(d.clicks ?? 0) || 0,
        leads: (d.actions ?? [])
          .filter((a) => a.action_type === "lead" || a.action_type === "onsite_conversion.lead_grouped")
          .reduce((n, a) => Math.max(n, Number(a.value ?? 0) || 0), 0),
      })),
  );
}

export type CampaignDayStat = DayStat & { campaignId: string; campaignName: string };

/**
 * One row per campaign per day for a whole ad account: every campaign,
 * made here or in Ads Manager, so no rupee the account spent goes unseen.
 * Paged by Meta's cursor, at most ten pages.
 */
export async function metaAccountDailyStats(
  token: string,
  accountId: string,
  since: string,
  until: string,
): Promise<R<CampaignDayStat[]>> {
  const out: CampaignDayStat[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await get<{ data?: (InsightRow & { campaign_id?: string; campaign_name?: string })[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      token,
      `${accountId}/insights`,
      {
        fields: "campaign_id,campaign_name,spend,impressions,clicks,actions",
        time_range: { since, until },
        time_increment: 1,
        level: "campaign",
        limit: 500,
        ...(after ? { after } : {}),
      },
    );
    if (!r.ok) return r;
    for (const d of r.value.data ?? []) {
      if (typeof d.date_start !== "string" || typeof d.campaign_id !== "string") continue;
      out.push({
        campaignId: d.campaign_id,
        campaignName: (d.campaign_name ?? "").slice(0, 400),
        day: d.date_start,
        spendPaise: Math.round(Number(d.spend ?? 0) * 100) || 0,
        impressions: Number(d.impressions ?? 0) || 0,
        clicks: Number(d.clicks ?? 0) || 0,
        leads: (d.actions ?? [])
          .filter((a) => a.action_type === "lead" || a.action_type === "onsite_conversion.lead_grouped")
          .reduce((n, a) => Math.max(n, Number(a.value ?? 0) || 0), 0),
      });
    }
    after = r.value.paging?.next ? r.value.paging?.cursors?.after : undefined;
    if (!after) break;
  }
  return ok(out);
}

/** A Page's instant forms, and the leads on one, for a webhook that never came. */
export async function metaPageForms(pageToken: string, pageId: string): Promise<R<{ id: string; name: string }[]>> {
  const r = await get<{ data?: { id: string; name?: string }[] }>(pageToken, `${pageId}/leadgen_forms`, { fields: "id,name", limit: 100 });
  return r.ok ? ok((r.value.data ?? []).map((f) => ({ id: f.id, name: f.name ?? "" }))) : r;
}

export async function metaFormLeads(pageToken: string, formId: string, sinceUnix: number): Promise<R<Record<string, unknown>[]>> {
  const out: Record<string, unknown>[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await get<{ data?: Record<string, unknown>[]; paging?: { cursors?: { after?: string }; next?: string } }>(pageToken, `${formId}/leads`, {
      fields: "id,created_time,field_data,ad_id,adset_id,campaign_id,form_id,custom_disclaimer_responses,is_organic,platform",
      filtering: [{ field: "time_created", operator: "GREATER_THAN", value: sinceUnix }],
      limit: 100,
      ...(after ? { after } : {}),
    });
    if (!r.ok) return r;
    out.push(...(r.value.data ?? []));
    after = r.value.paging?.next ? r.value.paging?.cursors?.after : undefined;
    if (!after) break;
  }
  return ok(out);
}

/** A Meta ad's budget lives on its ad set. */
export async function setMetaBudget(token: string, steps: Record<string, unknown>, rupees: number): Promise<R<true>> {
  const adset = typeof steps.adset_id === "string" ? steps.adset_id : null;
  if (!adset) return { ok: false, ...refuse("NOT_FOUND", "This ad was never finished, so it has no budget to move.") };
  const r = await post<{ success?: boolean }>(token, adset, { daily_budget: toMetaMinor(rupees) });
  return r.ok ? ok(true) : r;
}

// ---------------------------------------------------------------------------
// Sending outcomes back: the Conversions API
// ---------------------------------------------------------------------------

/**
 * One CRM outcome to a dataset. `data` is the event array as JSON text,
 * built by `metaEventJson()` so a 17-digit lead id survives exactly.
 * https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/payload-specification
 */
export async function sendMetaOutcome(token: string, datasetId: string, data: string): Promise<R<{ received: number }>> {
  const r = await post<{ events_received?: number }>(token, `${datasetId}/events`, { data });
  return r.ok ? ok({ received: Number(r.value.events_received ?? 0) }) : r;
}

/**
 * The custom conversion new ad sets optimise for once qualified bidding is
 * on: the Qualified event on the dataset the uploader sends it to. Looked
 * for by name first, so switching bidding off and on again, or a retry of
 * a lost answer, never makes a second.
 * https://developers.facebook.com/docs/marketing-api/reference/custom-conversion
 */
export async function ensureQualifiedConversion(token: string, adAccountId: string, datasetId: string): Promise<R<string>> {
  const act = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
  const listed = await get<{ data?: { id?: string; name?: string }[] }>(token, `${act}/customconversions`, { fields: "id,name", limit: 100 });
  if (!listed.ok) return listed;
  const have = (listed.value.data ?? []).find((c) => c.name === QUALIFIED_CONVERSION_NAME && c.id);
  if (have?.id) return ok(have.id);
  const made = await post<{ id?: string }>(token, `${act}/customconversions`, {
    name: QUALIFIED_CONVERSION_NAME,
    event_source_id: datasetId,
    custom_event_type: "OTHER",
    rule: qualifiedConversionRule(),
  });
  if (!made.ok) return made;
  return made.value.id ? ok(String(made.value.id)) : { ok: false, ...refuse("INVALID", "Meta made the conversion and named no id.") };
}

/**
 * Reach and frequency over a window, as one figure. Reach does not add up
 * across days, so a window's frequency cannot be built from daily rows.
 */
export async function metaWindowStats(
  token: string,
  campaignId: string,
  since: string,
  until: string,
): Promise<R<{ reach: number; impressions: number; frequency: number | null }>> {
  const r = await get<{ data?: { reach?: string; impressions?: string; frequency?: string }[] }>(token, `${campaignId}/insights`, {
    fields: "reach,impressions,frequency",
    time_range: { since, until },
    level: "campaign",
  });
  if (!r.ok) return r;
  const d = r.value.data?.[0] ?? {};
  const frequency = Number(d.frequency);
  return ok({
    reach: Number(d.reach ?? 0) || 0,
    impressions: Number(d.impressions ?? 0) || 0,
    frequency: Number.isFinite(frequency) && d.frequency !== undefined ? frequency : null,
  });
}
