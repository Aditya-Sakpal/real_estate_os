/**
 * Google: consent, the accounts behind it, and publishing into them.
 *
 * Two destinations share one connection. A Business Profile post goes up at
 * once and is organic. A display ad is created in the developer's own Google
 * Ads account with its campaign PAUSED, so nothing spends until a person
 * switches it on.
 *
 * What is stored is the refresh token, sealed. An access token lasts an hour
 * and is fetched when a call needs one, kept in this process's memory until
 * just before it runs out and never written anywhere.
 *
 * Google Ads access belongs to the Google Cloud project that owns our OAuth
 * client: developer tokens were retired on 9 September 2026, and a token sent
 * in a header is now ignored and will later be refused, so none is sent. A
 * project starts at test access, which reaches Google Ads test accounts only.
 * Business Profile needs its API access granted to the same project. Neither
 * has been granted yet, so these calls are written to Google's published
 * reference and exercised by `check:connect` against a fake.
 */

import { createHash } from "node:crypto";
import { demandGenText, isYouTubeId, youTubeMeta } from "./google-ad-rules.ts";
import {
  displayText,
  type PlatformError,
  GOOGLE_ADS_SCOPE,
  GOOGLE_BUSINESS_SCOPE,
  GOOGLE_DATA_MANAGER_SCOPE,
  YOUTUBE_UPLOAD_SCOPE,
  languageTag,
  objectName,
  toMicros,
  type Choice,
} from "./connect-rules.ts";
import {
  call,
  ensure,
  failed,
  form,
  GOOGLE_ADS_VERSION,
  HOSTS,
  ok,
  query,
  refuse,
  UPLOAD_TIMEOUT_MS,
  type R,
  type StepContext,
  type StepOutcome,
} from "./platform.ts";

const env = (name: string) => (process.env[name] ?? "").trim() || null;

export function googleConfigured(): boolean {
  return !!(env("GOOGLE_CONNECT_CLIENT_ID") && env("GOOGLE_CONNECT_CLIENT_SECRET"));
}

/**
 * Business Profile is asked for only once it is switched on
 * (`GOOGLE_BUSINESS_PROFILE=on`), which is once Google has approved the
 * Business Profile API for our project. Until then asking for it gains
 * nothing and costs something: every extra sensitive scope is another line on
 * the consent screen and more reason for Google to make the person prove who
 * they are before it will hand the grant over.
 */
export function googleBusinessEnabled(): boolean {
  return googleConfigured() && (env("GOOGLE_BUSINESS_PROFILE") ?? "").toLowerCase() === "on";
}

/**
 * Sending outcomes back is asked for only once it is switched on
 * (`GOOGLE_DATA_MANAGER=on`): the Data Manager API has to be enabled for our
 * Cloud project and its scope is sensitive, so the consent screen needs
 * Google's verification first, the Business Profile rule again.
 */
export function googleDataManagerEnabled(): boolean {
  return googleConfigured() && (env("GOOGLE_DATA_MANAGER") ?? "").toLowerCase() === "on";
}

/** What a Google consent asks for, today. */
export function googleScopes(): string[] {
  return [
    GOOGLE_ADS_SCOPE,
    // A Google video ad is a YouTube video, uploaded unlisted to the
    // developer's own channel.
    YOUTUBE_UPLOAD_SCOPE,
    ...(googleBusinessEnabled() ? [GOOGLE_BUSINESS_SCOPE] : []),
    ...(googleDataManagerEnabled() ? [GOOGLE_DATA_MANAGER_SCOPE] : []),
  ];
}

/**
 * Ads needs nothing beyond the OAuth client now that access is granted to the
 * client's Cloud project. Kept as its own question because the answer used to
 * differ, and a screen asks it per destination.
 */
export function googleAdsConfigured(): boolean {
  return googleConfigured();
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Where a person is sent to consent. `access_type=offline` and
 * `prompt=consent` together are what make Google hand back a refresh token
 * every time, including to somebody who connected once before; without the
 * second a reconnect returns no refresh token at all. PKCE on top, because a
 * code intercepted on the way back is useless without the verifier this
 * server kept. `select_account` asks which Google login every time, so a
 * reconnect after the wrong login can pick another instead of reusing it.
 */
export function googleAuthUrl(input: { state: string; redirectUri: string; challenge: string }): string {
  return (
    HOSTS.googleAuth +
    query({
      client_id: env("GOOGLE_CONNECT_CLIENT_ID"),
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: googleScopes().join(" "),
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state: input.state,
      code_challenge: input.challenge,
      code_challenge_method: "S256",
    })
  );
}

export type GoogleGrant = { refreshToken: string; accessToken: string; expiresIn: number; scopes: string[] };

export async function googleExchange(input: {
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<R<GoogleGrant>> {
  const r = await call<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>(
    "GOOGLE",
    HOSTS.googleToken,
    {
      method: "POST",
      body: form({
        code: input.code,
        client_id: env("GOOGLE_CONNECT_CLIENT_ID"),
        client_secret: env("GOOGLE_CONNECT_CLIENT_SECRET"),
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
        code_verifier: input.verifier,
      }),
    },
  );
  if (!r.ok) return r;
  if (!r.json.refresh_token || !r.json.access_token) {
    return { ok: false, ...refuse("INVALID", "Google did not hand back a lasting token. Connect again.") };
  }
  const grant = {
    refreshToken: r.json.refresh_token,
    accessToken: r.json.access_token,
    expiresIn: r.json.expires_in ?? 3600,
    scopes: (r.json.scope ?? "").split(/\s+/).filter(Boolean),
  };
  remember(grant.refreshToken, grant.accessToken, grant.expiresIn);
  return ok(grant);
}

const cache = new Map<string, { token: string; until: number }>();
const cacheKey = (refresh: string) => createHash("sha256").update(refresh).digest("hex");

function remember(refresh: string, token: string, expiresIn: number) {
  cache.set(cacheKey(refresh), { token, until: Date.now() + Math.max(expiresIn - 120, 60) * 1000 });
}

/** A working access token for a stored refresh token. */
export async function googleAccess(refreshToken: string): Promise<R<string>> {
  const held = cache.get(cacheKey(refreshToken));
  if (held && held.until > Date.now()) return ok(held.token);
  const r = await call<{ access_token?: string; expires_in?: number }>("GOOGLE", HOSTS.googleToken, {
    method: "POST",
    body: form({
      client_id: env("GOOGLE_CONNECT_CLIENT_ID"),
      client_secret: env("GOOGLE_CONNECT_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) return r;
  if (!r.json.access_token) return { ok: false, ...refuse("TOKEN_INVALID", "Google did not renew the token.") };
  remember(refreshToken, r.json.access_token, r.json.expires_in ?? 3600);
  return ok(r.json.access_token);
}

export async function googleRevoke(refreshToken: string): Promise<R<true>> {
  cache.delete(cacheKey(refreshToken));
  const r = await call("GOOGLE", HOSTS.googleRevoke, { method: "POST", body: form({ token: refreshToken }) });
  return r.ok ? ok(true) : r;
}

// ---------------------------------------------------------------------------
// Google Ads
// ---------------------------------------------------------------------------

const adsUrl = (path: string) => `${HOSTS.ads}/${GOOGLE_ADS_VERSION}/${path}`;

function adsHeaders(access: string, login: string | null): Record<string, string> {
  return {
    authorization: `Bearer ${access}`,
    "content-type": "application/json",
    ...(login ? { "login-customer-id": login } : {}),
  };
}

async function adsPost<T>(
  access: string,
  login: string | null,
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<R<T>> {
  const r = await call<T>("GOOGLE", adsUrl(path), {
    method: "POST",
    headers: adsHeaders(access, login),
    body: JSON.stringify(body),
    timeoutMs,
  });
  return r.ok ? ok(r.json) : r;
}

async function search<T>(access: string, customerId: string, login: string | null, gaql: string): Promise<R<T[]>> {
  const r = await adsPost<{ results?: T[] }>(access, login, `customers/${customerId}/googleAds:search`, { query: gaql });
  return r.ok ? ok(r.value.results ?? []) : r;
}

/** A GAQL string literal. */
const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** At most this many accounts are looked into, so one agency login cannot fan out forever. */
const MAX_CUSTOMERS = 20;

type CustomerRow = {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; manager?: boolean; testAccount?: boolean };
};
type ClientRow = {
  customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; manager?: boolean; status?: string; testAccount?: boolean };
};

async function discoverAds(access: string): Promise<R<Choice[]>> {
  const listed = await call<{ resourceNames?: string[] }>("GOOGLE", adsUrl("customers:listAccessibleCustomers"), {
    method: "GET",
    headers: adsHeaders(access, null),
  });
  if (!listed.ok) return listed;
  const ids = (listed.json.resourceNames ?? [])
    .map((n) => n.split("/")[1])
    .filter((id): id is string => !!id && /^\d+$/.test(id))
    .slice(0, MAX_CUSTOMERS);

  const out: Choice[] = [];
  // The first refusal, kept so an empty list can say why it is empty: a
  // project still at test access is refused on every real account, and an
  // empty list with no reason reads as "you have no Google Ads account".
  let refused: ({ ok: false } & PlatformError) | null = null;
  for (const id of ids) {
    const me = await search<CustomerRow>(
      access,
      id,
      null,
      "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.test_account FROM customer LIMIT 1",
    );
    if (!me.ok) {
      refused ??= me;
      continue;
    }
    const c = me.value[0]?.customer;
    if (!c) continue;
    if (!c.manager) {
      out.push({
        kind: "GOOGLE_ADS_CUSTOMER",
        id,
        name: c.descriptiveName || showCustomerId(id),
        detail: { currency: c.currencyCode ?? null, login_customer_id: null, test: c.testAccount ? "yes" : null },
      });
      continue;
    }
    // An agency's manager account holds no ads; the accounts under it do.
    const clients = await search<ClientRow>(
      access,
      id,
      id,
      // A test account reads CLOSED (it has no billing) and still takes every
      // call, so status is read here and decided below rather than filtered.
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status, customer_client.test_account FROM customer_client WHERE customer_client.level <= 1 AND customer_client.manager = FALSE",
    );
    if (!clients.ok) {
      refused ??= clients;
      continue;
    }
    for (const row of clients.value) {
      const cc = row.customerClient;
      if (!cc?.id || out.some((o) => o.id === String(cc.id))) continue;
      if (cc.status !== "ENABLED" && !cc.testAccount) continue;
      out.push({
        kind: "GOOGLE_ADS_CUSTOMER",
        id: String(cc.id),
        name: cc.descriptiveName || showCustomerId(String(cc.id)),
        detail: { currency: cc.currencyCode ?? null, login_customer_id: id, manager_name: c.descriptiveName ?? null, test: cc.testAccount ? "yes" : null },
      });
    }
  }
  if (!out.length && refused) return refused;
  if (!ids.length) return { ok: false, ...refuse("NOT_FOUND", "This Google login has no Google Ads account.") };
  return ok(out);
}

/** 1234567890 as Google shows it: 123-456-7890. */
export function showCustomerId(id: string): string {
  return /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
}

// ---------------------------------------------------------------------------
// Business Profile
// ---------------------------------------------------------------------------

async function discoverBusiness(access: string): Promise<R<Choice[]>> {
  const accounts = await call<{ accounts?: { name?: string; accountName?: string }[] }>(
    "GOOGLE",
    `${HOSTS.gbpAccounts}/v1/accounts`,
    { method: "GET", headers: { authorization: `Bearer ${access}` } },
  );
  if (!accounts.ok) return accounts;
  const out: Choice[] = [];
  for (const a of (accounts.json.accounts ?? []).slice(0, MAX_CUSTOMERS)) {
    if (!a.name) continue;
    const locations = await call<{
      locations?: { name?: string; title?: string; storefrontAddress?: { locality?: string } }[];
    }>(
      "GOOGLE",
      `${HOSTS.gbpInfo}/v1/${a.name}/locations` + query({ readMask: "name,title,storefrontAddress", pageSize: 100 }),
      { method: "GET", headers: { authorization: `Bearer ${access}` } },
    );
    if (!locations.ok) continue;
    for (const l of locations.json.locations ?? []) {
      if (!l.name) continue;
      out.push({
        kind: "GOOGLE_BUSINESS_LOCATION",
        id: l.name,
        name: l.title ?? l.name,
        detail: { account: a.name, account_name: a.accountName ?? null, city: l.storefrontAddress?.locality ?? null },
      });
    }
  }
  return ok(out);
}

/**
 * Every Ads account and Business Profile location the person who consented
 * can use. One side failing does not lose the other: a developer with no
 * Business Profile still has an Ads account worth choosing, and Ads refusing
 * our project's access level says nothing about their Business Profile.
 */
export async function googleDiscover(access: string): Promise<R<{ choices: Choice[]; notes: string[] }>> {
  const notes: string[] = [];
  const [ads, business] = await Promise.all([
    googleAdsConfigured()
      ? discoverAds(access)
      : Promise.resolve({ ok: false, ...refuse("ACCESS_LEVEL", "Google Ads is not set up on this server yet.") } as R<Choice[]>),
    googleBusinessEnabled() ? discoverBusiness(access) : Promise.resolve(ok<Choice[]>([])),
  ]);
  const choices: Choice[] = [];
  if (ads.ok) choices.push(...ads.value);
  else
    notes.push(
      ads.code === "ACCESS_LEVEL"
        ? "Google Ads is not approved for Sales Desk yet, so only Google Ads test accounts can be connected."
        : `Google Ads: ${ads.message}`,
    );
  if (business.ok) choices.push(...business.value);
  else
    notes.push(
      business.code === "RATE_LIMITED" || business.code === "PERMISSION"
        ? "Business Profile is not approved for Sales Desk yet."
        : `Business Profile: ${business.message}`,
    );
  return ok({ choices, notes });
}

// ---------------------------------------------------------------------------
// A display ad, created paused
// ---------------------------------------------------------------------------

async function uploadImage(ctx: StepContext, index: number, name: string, login: string | null): Promise<R<string>> {
  const bytes = await ctx.bytes(index);
  if (!bytes) return { ok: false, ...refuse("NOT_FOUND", "A picture is gone.") };
  const r = await adsPost<{ results?: { resourceName?: string }[] }>(
    ctx.token,
    login,
    `customers/${ctx.account.externalId}/assets:mutate`,
    { operations: [{ create: { name, type: "IMAGE", imageAsset: { data: bytes.toString("base64") } } }] },
    UPLOAD_TIMEOUT_MS,
  );
  if (!r.ok) return r;
  const rn = r.value.results?.[0]?.resourceName;
  return rn ? ok(rn) : { ok: false, ...refuse("INVALID", "Google took the picture and named no asset.") };
}

async function findAsset(ctx: StepContext, name: string, login: string | null): Promise<R<string | null>> {
  const r = await search<{ asset?: { resourceName?: string } }>(
    ctx.token,
    ctx.account.externalId,
    login,
    `SELECT asset.resource_name FROM asset WHERE asset.name = ${lit(name)} LIMIT 1`,
  );
  return r.ok ? ok(r.value[0]?.asset?.resourceName ?? null) : r;
}

async function findCampaign(ctx: StepContext, name: string, login: string | null): Promise<R<string | null>> {
  const r = await search<{ campaign?: { resourceName?: string } }>(
    ctx.token,
    ctx.account.externalId,
    login,
    `SELECT campaign.resource_name FROM campaign WHERE campaign.name = ${lit(name)} AND campaign.status != 'REMOVED' LIMIT 1`,
  );
  return r.ok ? ok(r.value[0]?.campaign?.resourceName ?? null) : r;
}

/** India, when Google does not know the city. */
export const GOOGLE_INDIA = "geoTargetConstants/2356";

export async function createGoogleDisplayAd(ctx: StepContext): Promise<StepOutcome> {
  const cid = ctx.account.externalId;
  const login = typeof ctx.account.detail.login_customer_id === "string" ? ctx.account.detail.login_customer_id : null;
  if (!ctx.destinationUrl || !ctx.dailyBudget) return failed(refuse("INVALID", "An ad needs a landing page and a budget."));
  if (ctx.media.length < 2) return failed(refuse("INVALID", "A display ad needs the banner and a square picture."));
  const text = displayText({ headline: ctx.headline, body: ctx.body, businessNames: ctx.businessNames });
  if (!text.ok) return failed(refuse("INVALID", text.reason));
  const name = (part: string) => objectName({ place: ctx.place, key: ctx.key, part });

  const landscape = await ensure(ctx, "landscape_asset", () => findAsset(ctx, name("banner"), login), () =>
    uploadImage(ctx, 0, name("banner"), login),
  );
  if (!landscape.ok) return failed(landscape);
  const square = await ensure(ctx, "square_asset", () => findAsset(ctx, name("square"), login), () =>
    uploadImage(ctx, 1, name("square"), login),
  );
  if (!square.ok) return failed(square);

  if (!ctx.steps.geo) {
    let geo = GOOGLE_INDIA;
    let note: string | null = "Shown across India. Narrow the location in Google Ads before switching it on.";
    if (ctx.city) {
      const r = await adsPost<{
        geoTargetConstantSuggestions?: { geoTargetConstant?: { resourceName?: string; targetType?: string; status?: string } }[];
      }>(ctx.token, login, "geoTargetConstants:suggest", {
        locale: "en",
        countryCode: "IN",
        locationNames: { names: [ctx.city] },
      });
      const city = r.ok
        ? r.value.geoTargetConstantSuggestions?.find(
            (s) => s.geoTargetConstant?.targetType === "City" && s.geoTargetConstant?.status !== "REMOVAL_PLANNED",
          )?.geoTargetConstant?.resourceName
        : undefined;
      if (city) {
        geo = city;
        note = null;
      }
    }
    await ctx.save({ geo, geo_note: note });
  }

  // Budget, campaign, location, ad group and ad in one request that lands
  // whole or not at all. The campaign's name is unique in the account, so a
  // retry after a lost answer is refused as a duplicate and looked up rather
  // than created twice.
  const campaign = await ensure(
    ctx,
    "campaign",
    () => findCampaign(ctx, name("campaign"), login),
    async () => {
      const at = (kind: string, n: number) => `customers/${cid}/${kind}/-${n}`;
      const r = await adsPost<{ mutateOperationResponses?: { campaignResult?: { resourceName?: string } }[] }>(
        ctx.token,
        login,
        `customers/${cid}/googleAds:mutate`,
        {
          mutateOperations: [
            {
              campaignBudgetOperation: {
                create: {
                  resourceName: at("campaignBudgets", 1),
                  name: name("budget"),
                  amountMicros: toMicros(ctx.dailyBudget!),
                  deliveryMethod: "STANDARD",
                  explicitlyShared: false,
                },
              },
            },
            {
              campaignOperation: {
                create: {
                  resourceName: at("campaigns", 2),
                  name: name("campaign"),
                  status: "PAUSED",
                  advertisingChannelType: "DISPLAY",
                  campaignBudget: at("campaignBudgets", 1),
                  targetSpend: {},
                  containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
                  networkSettings: {
                    targetGoogleSearch: false,
                    targetSearchNetwork: false,
                    targetContentNetwork: true,
                    targetPartnerSearchNetwork: false,
                  },
                },
              },
            },
            {
              campaignCriterionOperation: {
                create: { campaign: at("campaigns", 2), location: { geoTargetConstant: ctx.steps.geo } },
              },
            },
            {
              adGroupOperation: {
                create: {
                  resourceName: at("adGroups", 3),
                  name: name("ad group"),
                  campaign: at("campaigns", 2),
                  status: "ENABLED",
                  type: "DISPLAY_STANDARD",
                },
              },
            },
            {
              adGroupAdOperation: {
                create: {
                  adGroup: at("adGroups", 3),
                  status: "ENABLED",
                  ad: {
                    name: name("ad"),
                    finalUrls: [ctx.destinationUrl],
                    responsiveDisplayAd: {
                      headlines: [{ text: text.headline }],
                      longHeadline: { text: text.longHeadline },
                      descriptions: [{ text: text.description }],
                      businessName: text.businessName,
                      marketingImages: [{ asset: landscape.value }],
                      squareMarketingImages: [{ asset: square.value }],
                    },
                  },
                },
              },
            },
          ],
        },
      );
      if (!r.ok) {
        if (r.code !== "DUPLICATE_NAME") return r;
        const found = await findCampaign(ctx, name("campaign"), login);
        if (!found.ok) return found;
        return found.value ? ok(found.value) : r;
      }
      const rn = r.value.mutateOperationResponses?.find((x) => x.campaignResult?.resourceName)?.campaignResult?.resourceName;
      return rn ? ok(rn) : { ok: false, ...refuse("INVALID", "Google created the ad and named no campaign.") };
    },
  );
  if (!campaign.ok) return failed(campaign);

  const campaignId = campaign.value.split("/").pop() ?? "";
  return {
    kind: "done",
    state: "PAUSED",
    externalUrl: `https://ads.google.com/aw/campaigns` + query({ campaignId, __c: cid }),
    note: typeof ctx.steps.geo_note === "string" ? ctx.steps.geo_note : undefined,
  };
}

// ---------------------------------------------------------------------------
// Search, Performance Max and Demand Gen
// ---------------------------------------------------------------------------

const loginOf = (ctx: StepContext) =>
  typeof ctx.account.detail.login_customer_id === "string" ? ctx.account.detail.login_customer_id : null;

/** The project's city, or India with a note, kept on the steps so a retry asks once. */
async function ensureGeo(ctx: StepContext, login: string | null): Promise<string> {
  if (typeof ctx.steps.geo === "string") return ctx.steps.geo;
  let geo = GOOGLE_INDIA;
  let note: string | null = "Shown across India. Narrow the location in Google Ads before switching it on.";
  if (ctx.city) {
    const r = await adsPost<{
      geoTargetConstantSuggestions?: { geoTargetConstant?: { resourceName?: string; targetType?: string; status?: string } }[];
    }>(ctx.token, login, "geoTargetConstants:suggest", { locale: "en", countryCode: "IN", locationNames: { names: [ctx.city] } });
    const city = r.ok
      ? r.value.geoTargetConstantSuggestions?.find(
          (x) => x.geoTargetConstant?.targetType === "City" && x.geoTargetConstant?.status !== "REMOVAL_PLANNED",
        )?.geoTargetConstant?.resourceName
      : undefined;
    if (city) {
      geo = city;
      note = null;
    }
  }
  await ctx.save({ geo, geo_note: note });
  return geo;
}

/** English and Hindi: what an Indian buyer's Google is set to. */
export const GOOGLE_LANGUAGES = ["languageConstants/1000", "languageConstants/1023"];

/** One picture from the publication's files, or the logo, as an image asset, found by its name on a retry. */
async function imageAsset(ctx: StepContext, step: string, name: string, login: string | null, bytes: () => Promise<Buffer | null>): Promise<R<string>> {
  return ensure(ctx, step, () => findAsset(ctx, name, login), async () => {
    const b = await bytes();
    if (!b) return { ok: false, ...refuse("NOT_FOUND", "A picture is gone.") };
    const r = await adsPost<{ results?: { resourceName?: string }[] }>(
      ctx.token,
      login,
      `customers/${ctx.account.externalId}/assets:mutate`,
      { operations: [{ create: { name, type: "IMAGE", imageAsset: { data: b.toString("base64") } } }] },
      UPLOAD_TIMEOUT_MS,
    );
    if (!r.ok) return r;
    const rn = r.value.results?.[0]?.resourceName;
    return rn ? ok(rn) : { ok: false, ...refuse("INVALID", "Google took the picture and named no asset.") };
  });
}

/**
 * A video into the developer's own YouTube channel, unlisted, then as an
 * asset Google Ads can show. A Google video ad is always a YouTube video;
 * unlisted keeps the ad off the channel's own page.
 */
async function youtubeAsset(ctx: StepContext, index: number, name: string, login: string | null): Promise<R<string>> {
  if (!ctx.youtube) {
    return { ok: false, ...refuse("PERMISSION", "Google was connected before YouTube uploads were asked for. Reconnect Google and allow YouTube.") };
  }
  const video = await ensure(ctx, `youtube_${index}`, null, async () => {
    const bytes = await ctx.bytes(index);
    if (!bytes) return { ok: false, ...refuse("NOT_FOUND", "The video file is gone.") };
    const meta = youTubeMeta({ headline: ctx.headline, caption: ctx.caption });
    const start = await call<unknown>("GOOGLE", `${HOSTS.youtubeUpload}` + query({ uploadType: "resumable", part: "snippet,status" }), {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "video/mp4",
        "x-upload-content-length": String(bytes.length),
      },
      body: JSON.stringify({
        snippet: { title: meta.title, description: meta.description, categoryId: "22" },
        status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
      }),
    });
    if (!start.ok) return start;
    const session = start.headers.get("location");
    if (!session) return { ok: false, ...refuse("INVALID", "YouTube did not open an upload.") };
    const put = await call<{ id?: string }>("GOOGLE", session, {
      method: "PUT",
      headers: { authorization: `Bearer ${ctx.token}`, "content-type": "video/mp4" },
      body: new Uint8Array(bytes),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (!put.ok) return put;
    return isYouTubeId(put.json.id) ? ok(put.json.id) : { ok: false, ...refuse("INVALID", "YouTube took the video and named no id.") };
  });
  if (!video.ok) return video;
  return ensure(ctx, `youtube_asset_${index}`, () => findAsset(ctx, name, login), async () => {
    const r = await adsPost<{ results?: { resourceName?: string }[] }>(ctx.token, login, `customers/${ctx.account.externalId}/assets:mutate`, {
      operations: [{ create: { name, type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: video.value } } }],
    });
    if (!r.ok) return r;
    const rn = r.value.results?.[0]?.resourceName;
    return rn ? ok(rn) : { ok: false, ...refuse("INVALID", "Google took the video and named no asset.") };
  });
}

/** The brand's logo as an asset, or a refusal that says where to add one. */
async function logoAsset(ctx: StepContext, name: string, login: string | null): Promise<R<string>> {
  if (!ctx.logo) return { ok: false, ...refuse("INVALID", "Add your logo in Library, Branding. Google shows it beside the ad.") };
  const logo = ctx.logo;
  const probe = typeof ctx.steps.logo_asset === "string" ? null : await logo();
  if (typeof ctx.steps.logo_asset !== "string" && !probe) {
    return { ok: false, ...refuse("INVALID", "Add your logo in Library, Branding. Google shows it beside the ad.") };
  }
  return imageAsset(ctx, "logo_asset", name, login, async () => probe ?? (await logo()));
}

type MutateOp = Record<string, unknown>;

/**
 * A lead form under the ad, posting to our capture with the organisation's
 * key, so a buyer who fills it lands on the board like any other enquiry.
 */
function leadFormOps(ctx: StepContext, at: (kind: string, n: number) => string, n: number, campaign: string): MutateOp[] {
  const lf = ctx.bundle?.leadForm;
  if (!lf || !ctx.leadWebhook || !ctx.privacyUrl || !ctx.destinationUrl) return [];
  return [
    {
      assetOperation: {
        create: {
          resourceName: at("assets", n),
          name: objectName({ place: ctx.place, key: ctx.key, part: "lead form" }),
          finalUrls: [ctx.destinationUrl],
          leadFormAsset: {
            businessName: lf.businessName,
            callToActionType: "GET_QUOTE",
            callToActionDescription: "Get a call back",
            headline: lf.headline,
            description: lf.description,
            privacyPolicyUrl: ctx.privacyUrl,
            fields: [{ inputType: "FULL_NAME" }, { inputType: "PHONE_NUMBER" }],
            deliveryMethods: [{ webhook: { advertiserWebhookUrl: ctx.leadWebhook.url, googleSecret: ctx.leadWebhook.key, payloadSchemaVersion: 3 } }],
            postSubmitHeadline: "Thank you",
            postSubmitDescription: "Our sales team will call you shortly.",
            postSubmitCallToActionType: "VISIT_SITE",
          },
        },
      },
    },
    { campaignAssetOperation: { create: { campaign, asset: at("assets", n), fieldType: "LEAD_FORM" } } },
  ];
}

/** Create the whole campaign in one request, or find the one a lost answer already made. */
async function mutateCampaign(ctx: StepContext, login: string | null, ops: MutateOp[]): Promise<R<string>> {
  const name = objectName({ place: ctx.place, key: ctx.key, part: "campaign" });
  return ensure(ctx, "campaign", () => findCampaign(ctx, name, login), async () => {
    const r = await adsPost<{ mutateOperationResponses?: { campaignResult?: { resourceName?: string } }[] }>(
      ctx.token,
      login,
      `customers/${ctx.account.externalId}/googleAds:mutate`,
      { mutateOperations: ops },
    );
    if (!r.ok) {
      if (r.code !== "DUPLICATE_NAME") return r;
      const found = await findCampaign(ctx, name, login);
      if (!found.ok) return found;
      return found.value ? ok(found.value) : r;
    }
    const rn = r.value.mutateOperationResponses?.find((x) => x.campaignResult?.resourceName)?.campaignResult?.resourceName;
    return rn ? ok(rn) : { ok: false, ...refuse("INVALID", "Google created the campaign and named nothing.") };
  });
}

function doneCampaign(ctx: StepContext, campaign: string, extra?: string | null): StepOutcome {
  const campaignId = campaign.split("/").pop() ?? "";
  const notes = [typeof ctx.steps.geo_note === "string" ? ctx.steps.geo_note : null, extra ?? null].filter(Boolean);
  return {
    kind: "done",
    state: "PAUSED",
    externalUrl: `https://ads.google.com/aw/campaigns` + query({ campaignId, __c: ctx.account.externalId }),
    note: notes.length ? notes.join(" ") : undefined,
  };
}

const budgetOp = (ctx: StepContext, at: (kind: string, n: number) => string, rupees: number): MutateOp => ({
  campaignBudgetOperation: {
    create: {
      resourceName: at("campaignBudgets", 1),
      name: objectName({ place: ctx.place, key: ctx.key, part: "budget" }),
      amountMicros: toMicros(rupees),
      deliveryMethod: "STANDARD",
      explicitlyShared: false,
    },
  },
});

/** What a lead form that could not be added says, so a person knows why there is none. */
function leadFormNote(ctx: StepContext): string | null {
  if (!ctx.bundle?.leadForm) return null;
  if (!ctx.privacyUrl) return "No lead form: add your privacy policy link in Library, Branding.";
  if (!ctx.leadWebhook) return "No lead form: this server has no public address for Google to send leads to.";
  return null;
}

/**
 * A responsive search ad, its keywords, its callouts and a lead form, in a
 * search campaign created paused. The registration is the first description,
 * pinned, so every ad Google assembles carries it.
 */
export async function createGoogleSearchAd(ctx: StepContext): Promise<StepOutcome> {
  const cid = ctx.account.externalId;
  const login = loginOf(ctx);
  const s = ctx.bundle?.search;
  if (!s) return failed(refuse("INVALID", "This search ad has no words."));
  if (!ctx.destinationUrl || !ctx.dailyBudget) return failed(refuse("INVALID", "An ad needs a landing page and a budget."));
  const geo = await ensureGeo(ctx, login);
  const name = (part: string) => objectName({ place: ctx.place, key: ctx.key, part });
  const at = (kind: string, n: number) => `customers/${cid}/${kind}/-${n}`;
  const campaign = at("campaigns", 2);

  const ops: MutateOp[] = [
    budgetOp(ctx, at, ctx.dailyBudget),
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: name("campaign"),
          status: "PAUSED",
          advertisingChannelType: "SEARCH",
          campaignBudget: at("campaignBudgets", 1),
          targetSpend: {},
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
        },
      },
    },
    { campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: geo } } } },
    ...GOOGLE_LANGUAGES.map((l) => ({ campaignCriterionOperation: { create: { campaign, language: { languageConstant: l } } } })),
    ...s.negatives.map((text) => ({
      campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text, matchType: "BROAD" } } },
    })),
    { adGroupOperation: { create: { resourceName: at("adGroups", 3), name: name("ad group"), campaign, status: "ENABLED", type: "SEARCH_STANDARD" } } },
    ...s.keywords.map((text) => ({
      adGroupCriterionOperation: { create: { adGroup: at("adGroups", 3), status: "ENABLED", keyword: { text, matchType: "PHRASE" } } },
    })),
    {
      adGroupAdOperation: {
        create: {
          adGroup: at("adGroups", 3),
          status: "ENABLED",
          ad: {
            name: name("ad"),
            finalUrls: [ctx.destinationUrl],
            responsiveSearchAd: {
              headlines: s.headlines.map((text) => ({ text })),
              descriptions: s.descriptions.map((text, i) => (i === s.pinned ? { text, pinnedField: "DESCRIPTION_1" } : { text })),
            },
          },
        },
      },
    },
    ...s.callouts.flatMap((text, i) => [
      { assetOperation: { create: { resourceName: at("assets", 10 + i), calloutAsset: { calloutText: text } } } },
      { campaignAssetOperation: { create: { campaign, asset: at("assets", 10 + i), fieldType: "CALLOUT" } } },
    ]),
    ...leadFormOps(ctx, at, 20, campaign),
  ];
  const made = await mutateCampaign(ctx, login, ops);
  if (!made.ok) return failed(made);
  return doneCampaign(ctx, made.value, leadFormNote(ctx));
}

/** Every automatic text, picture and video Google offers is switched off: nothing is shown that nobody approved. */
export const PMAX_AUTOMATION_OFF = [
  "TEXT_ASSET_AUTOMATION",
  "GENERATE_IMAGE_EXTRACTION",
  "GENERATE_IMAGE_ENHANCEMENT",
  "GENERATE_ENHANCED_YOUTUBE_VIDEOS",
  "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION",
].map((assetAutomationType) => ({ assetAutomationType, assetAutomationStatus: "OPTED_OUT" }));

/**
 * Performance Max: one asset group of the brief's cleared words, its passed
 * pictures and the logo, created paused. Every automatic asset Google would
 * otherwise write or draw is switched off, and the final URL is not expanded.
 */
export async function createGooglePmaxAd(ctx: StepContext): Promise<StepOutcome> {
  const cid = ctx.account.externalId;
  const login = loginOf(ctx);
  const b = ctx.bundle;
  if (!b?.pmax || !b.images) return failed(refuse("INVALID", "This campaign has no words or pictures."));
  if (!ctx.destinationUrl || !ctx.dailyBudget) return failed(refuse("INVALID", "An ad needs a landing page and a budget."));
  const name = (part: string) => objectName({ place: ctx.place, key: ctx.key, part });

  const pictures: { asset: string; field: string }[] = [];
  const shapes: [number[], string][] = [
    [b.images.landscape, "MARKETING_IMAGE"],
    [b.images.square, "SQUARE_MARKETING_IMAGE"],
    [b.images.portrait, "PORTRAIT_MARKETING_IMAGE"],
  ];
  for (const [list, field] of shapes) {
    for (const i of list) {
      const a = await imageAsset(ctx, `image_${i}`, name(`image ${i + 1}`), login, () => ctx.bytes(i));
      if (!a.ok) return failed(a);
      pictures.push({ asset: a.value, field });
    }
  }
  const logo = await logoAsset(ctx, name("logo"), login);
  if (!logo.ok) return failed(logo);
  const videos: string[] = [];
  let videoNote: string | null = null;
  for (const i of b.videos ?? []) {
    const v = await youtubeAsset(ctx, i, name(`video ${i + 1}`), login);
    if (!v.ok) {
      // A video is optional here, and Google's own videos are switched off,
      // so a campaign without one runs on its pictures.
      if (v.code === "PERMISSION") {
        videoNote = v.message;
        break;
      }
      return failed(v);
    }
    videos.push(v.value);
  }
  const geo = await ensureGeo(ctx, login);

  const at = (kind: string, n: number) => `customers/${cid}/${kind}/-${n}`;
  const campaign = at("campaigns", 2);
  const group = at("assetGroups", 3);
  let n = 100;
  const text = (t: string, field: string): MutateOp[] => {
    const id = at("assets", n++);
    return [
      { assetOperation: { create: { resourceName: id, textAsset: { text: t } } } },
      { assetGroupAssetOperation: { create: { assetGroup: group, asset: id, fieldType: field } } },
    ];
  };
  const p = b.pmax;
  const ops: MutateOp[] = [
    budgetOp(ctx, at, ctx.dailyBudget),
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: name("campaign"),
          status: "PAUSED",
          advertisingChannelType: "PERFORMANCE_MAX",
          campaignBudget: at("campaignBudgets", 1),
          maximizeConversions: {},
          brandGuidelinesEnabled: false,
          urlExpansionOptOut: true,
          assetAutomationSettings: PMAX_AUTOMATION_OFF,
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        },
      },
    },
    { campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: geo } } } },
    ...GOOGLE_LANGUAGES.map((l) => ({ campaignCriterionOperation: { create: { campaign, language: { languageConstant: l } } } })),
    { assetGroupOperation: { create: { resourceName: group, campaign, name: name("asset group"), finalUrls: [ctx.destinationUrl], status: "ENABLED" } } },
    ...p.headlines.flatMap((t) => text(t, "HEADLINE")),
    ...p.longHeadlines.flatMap((t) => text(t, "LONG_HEADLINE")),
    ...p.descriptions.flatMap((t) => text(t, "DESCRIPTION")),
    ...text(p.businessName, "BUSINESS_NAME"),
    ...pictures.map((x) => ({ assetGroupAssetOperation: { create: { assetGroup: group, asset: x.asset, fieldType: x.field } } })),
    { assetGroupAssetOperation: { create: { assetGroup: group, asset: logo.value, fieldType: "LOGO" } } },
    ...videos.map((v) => ({ assetGroupAssetOperation: { create: { assetGroup: group, asset: v, fieldType: "YOUTUBE_VIDEO" } } })),
    ...leadFormOps(ctx, at, 20, campaign),
  ];
  const made = await mutateCampaign(ctx, login, ops);
  if (!made.ok) return failed(made);
  // Kept so later pictures can be added to the same group.
  if (typeof ctx.steps.asset_group !== "string") {
    const found = await search<{ assetGroup?: { resourceName?: string } }>(
      ctx.token,
      cid,
      login,
      `SELECT asset_group.resource_name FROM asset_group WHERE asset_group.campaign = ${lit(made.value)} LIMIT 1`,
    );
    const rn = found.ok ? found.value[0]?.assetGroup?.resourceName : null;
    if (rn) await ctx.save({ asset_group: rn, pictures: [...b.images.square, ...b.images.landscape, ...b.images.portrait] });
  }
  return doneCampaign(ctx, made.value, [leadFormNote(ctx), videoNote].filter(Boolean).join(" ") || null);
}

/**
 * New pictures for a running Performance Max campaign: the brief's posts
 * that passed since it was made, linked into its asset group, up to Google's
 * caps. Never a word: the words were cleared once and stay as they were.
 */
export async function addPmaxPictures(input: {
  access: string;
  customerId: string;
  login: string | null;
  assetGroup: string;
  pictures: { name: string; bytes: Buffer; field: "MARKETING_IMAGE" | "SQUARE_MARKETING_IMAGE" | "PORTRAIT_MARKETING_IMAGE" }[];
}): Promise<R<number>> {
  let added = 0;
  for (const p of input.pictures) {
    const made = await adsPost<{ results?: { resourceName?: string }[] }>(
      input.access,
      input.login,
      `customers/${input.customerId}/assets:mutate`,
      { operations: [{ create: { name: p.name, type: "IMAGE", imageAsset: { data: p.bytes.toString("base64") } } }] },
      UPLOAD_TIMEOUT_MS,
    );
    if (!made.ok) return made;
    const asset = made.value.results?.[0]?.resourceName;
    if (!asset) continue;
    const linked = await adsPost(input.access, input.login, `customers/${input.customerId}/assetGroupAssets:mutate`, {
      operations: [{ create: { assetGroup: input.assetGroup, asset, fieldType: p.field } }],
    });
    if (!linked.ok) return linked;
    added += 1;
  }
  return ok(added);
}

/**
 * A Demand Gen ad from one post: a picture ad on YouTube, Discover and Gmail,
 * a carousel, or a video, which runs on YouTube only and is what a YouTube
 * ad now is. Created paused.
 */
export async function createGoogleDemandGenAd(ctx: StepContext): Promise<StepOutcome> {
  const cid = ctx.account.externalId;
  const login = loginOf(ctx);
  if (!ctx.destinationUrl || !ctx.dailyBudget) return failed(refuse("INVALID", "An ad needs a landing page and a budget."));
  const words = demandGenText({
    headline: ctx.headline,
    body: ctx.body,
    cta: "",
    registration: typeof ctx.steps.registration === "string" ? ctx.steps.registration : null,
    businessNames: ctx.businessNames,
    points: [],
  });
  if (!words.ok) return failed(refuse("INVALID", words.reason));
  const name = (part: string) => objectName({ place: ctx.place, key: ctx.key, part });
  const logo = await logoAsset(ctx, name("logo"), login);
  if (!logo.ok) return failed(logo);

  const at = (kind: string, n: number) => `customers/${cid}/${kind}/-${n}`;
  const campaign = at("campaigns", 2);
  const group = at("adGroups", 3);
  let ad: MutateOp;
  const extra: MutateOp[] = [];
  let channels: Record<string, boolean> | null = null;

  if (ctx.format === "VIDEO") {
    const video = await youtubeAsset(ctx, 0, name("video"), login);
    if (!video.ok) return failed(video);
    channels = { youtubeInFeed: true, youtubeInStream: true, youtubeShorts: true, discover: false, gmail: false, display: false };
    ad = {
      demandGenVideoResponsiveAd: {
        headlines: words.headlines.map((text) => ({ text })),
        longHeadlines: [{ text: words.longHeadline }],
        descriptions: words.descriptions.map((text) => ({ text })),
        videos: [{ asset: video.value }],
        logoImages: [{ asset: logo.value }],
        businessName: { text: words.businessName },
        callToActions: [{ text: "Learn more" }],
      },
    };
  } else if (ctx.format === "CAROUSEL") {
    const cards: string[] = [];
    for (let i = 0; i < ctx.media.length; i++) {
      const pic = await imageAsset(ctx, `image_${i}`, name(`card ${i + 1}`), login, () => ctx.bytes(i));
      if (!pic.ok) return failed(pic);
      const square = Math.abs(ctx.media[i].width / ctx.media[i].height - 1) <= 0.01;
      const card = at("assets", 30 + i);
      extra.push({
        assetOperation: {
          create: {
            resourceName: card,
            finalUrls: [ctx.destinationUrl],
            demandGenCarouselCardAsset: {
              ...(square ? { squareMarketingImageAsset: pic.value } : { marketingImageAsset: pic.value }),
              headline: words.headlines[0].slice(0, 40),
              callToActionText: "Learn more",
            },
          },
        },
      });
      cards.push(card);
    }
    ad = {
      demandGenCarouselAd: {
        businessName: words.businessName,
        logoImage: { asset: logo.value },
        headline: { text: words.headlines[0] },
        description: { text: words.descriptions[0] },
        callToActionText: "Learn more",
        carouselCards: cards.map((asset) => ({ asset })),
      },
    };
  } else {
    const square: string[] = [];
    const landscape: string[] = [];
    const portrait: string[] = [];
    for (let i = 0; i < ctx.media.length; i++) {
      const m = ctx.media[i];
      const r = m.height ? m.width / m.height : 0;
      const pic = await imageAsset(ctx, `image_${i}`, name(`image ${i + 1}`), login, () => ctx.bytes(i));
      if (!pic.ok) return failed(pic);
      if (Math.abs(r - 1) <= 0.01) square.push(pic.value);
      else if (Math.abs(r - 1.91) <= 0.03) landscape.push(pic.value);
      else if (Math.abs(r - 0.8) <= 0.01) portrait.push(pic.value);
    }
    if (!square.length) return failed(refuse("INVALID", "A Demand Gen picture ad needs a square picture. Make a post of this card with \"Facebook and Instagram feed\" ticked."));
    ad = {
      demandGenMultiAssetAd: {
        squareMarketingImages: square.map((asset) => ({ asset })),
        marketingImages: landscape.map((asset) => ({ asset })),
        portraitMarketingImages: portrait.map((asset) => ({ asset })),
        logoImages: [{ asset: logo.value }],
        headlines: words.headlines.map((text) => ({ text })),
        descriptions: words.descriptions.map((text) => ({ text })),
        businessName: words.businessName,
        callToActionText: "Learn more",
      },
    };
  }
  const geo = await ensureGeo(ctx, login);

  const ops: MutateOp[] = [
    budgetOp(ctx, at, ctx.dailyBudget),
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: name("campaign"),
          status: "PAUSED",
          advertisingChannelType: "DEMAND_GEN",
          campaignBudget: at("campaignBudgets", 1),
          targetSpend: {},
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          // A scheduled ad stops by itself on its last day.
          ...(ctx.endsAt ? { endDate: ctx.endsAt.toISOString().slice(0, 10) } : {}),
        },
      },
    },
    {
      adGroupOperation: {
        create: {
          resourceName: group,
          name: name("ad group"),
          campaign,
          status: "ENABLED",
          ...(channels ? { demandGenAdGroupSettings: { channelControls: { selectedChannels: channels } } } : {}),
        },
      },
    },
    // Demand Gen takes its place and languages on the ad group: Google refuses
    // them on the campaign (OWNED_AND_OPERATED).
    { adGroupCriterionOperation: { create: { adGroup: group, location: { geoTargetConstant: geo } } } },
    ...GOOGLE_LANGUAGES.map((l) => ({ adGroupCriterionOperation: { create: { adGroup: group, language: { languageConstant: l } } } })),
    ...extra,
    { adGroupAdOperation: { create: { adGroup: group, status: "ENABLED", ad: { name: name("ad"), finalUrls: [ctx.destinationUrl], ...ad } } } },
  ];
  const made = await mutateCampaign(ctx, login, ops);
  if (!made.ok) return failed(made);
  return doneCampaign(ctx, made.value);
}

/** Switch a display ad's spend on or off, at the campaign. */
export async function setGoogleAdSpend(input: {
  access: string;
  customerId: string;
  login: string | null;
  steps: Record<string, unknown>;
  on: boolean;
}): Promise<R<true>> {
  const campaign = typeof input.steps.campaign === "string" ? input.steps.campaign : null;
  if (!campaign) return { ok: false, ...refuse("NOT_FOUND", "This ad was never finished, so there is nothing to switch.") };
  const r = await adsPost(input.access, input.login, `customers/${input.customerId}/googleAds:mutate`, {
    mutateOperations: [
      {
        campaignOperation: {
          update: { resourceName: campaign, status: input.on ? "ENABLED" : "PAUSED" },
          updateMask: "status",
        },
      },
    ],
  });
  return r.ok ? ok(true) : r;
}

// ---------------------------------------------------------------------------
// A Business Profile post
// ---------------------------------------------------------------------------

export async function publishToBusinessProfile(ctx: StepContext): Promise<StepOutcome> {
  const account = typeof ctx.account.detail.account === "string" ? ctx.account.detail.account : null;
  if (!account) return failed(refuse("INVALID", "This Business Profile location names no account. Connect Google again."));
  const base = `${HOSTS.gbpPosts}/v4/${account}/${ctx.account.externalId}/localPosts`;
  const headers = { authorization: `Bearer ${ctx.token}`, "content-type": "application/json" };

  const post = await ensure(
    ctx,
    "post",
    async () => {
      const r = await call<{ localPosts?: { name?: string; summary?: string; createTime?: string }[] }>(
        "GOOGLE",
        base + query({ pageSize: 20 }),
        { method: "GET", headers },
      );
      if (!r.ok) return r;
      const after = new Date(String(ctx.steps.post_tried ?? ctx.now.toISOString())).getTime() - 60_000;
      const hit = (r.json.localPosts ?? []).find(
        (p) => (p.summary ?? "").trim() === ctx.caption.trim() && new Date(p.createTime ?? 0).getTime() >= after,
      );
      return ok(hit?.name ?? null);
    },
    async () => {
      const url = await ctx.publicUrl(0);
      if (!url) return { ok: false, ...refuse("NOT_FOUND", "The picture is gone.") };
      const r = await call<{ name?: string; searchUrl?: string }>("GOOGLE", base, {
        method: "POST",
        headers,
        body: JSON.stringify({
          languageCode: languageTag(ctx.language),
          summary: ctx.caption,
          topicType: "STANDARD",
          // With no landing page the button rings the number on the profile.
          callToAction: ctx.destinationUrl
            ? { actionType: "LEARN_MORE", url: ctx.destinationUrl }
            : { actionType: "CALL" },
          media: [{ mediaFormat: "PHOTO", sourceUrl: url }],
        }),
      });
      if (!r.ok) return r;
      if (r.json.searchUrl) await ctx.save({ search_url: r.json.searchUrl });
      return r.json.name ? ok(r.json.name) : { ok: false, ...refuse("INVALID", "Google took the post and named nothing.") };
    },
  );
  if (!post.ok) return failed(post);
  return {
    kind: "done",
    state: "LIVE",
    externalUrl: typeof ctx.steps.search_url === "string" ? ctx.steps.search_url : null,
  };
}

// ---------------------------------------------------------------------------
// What a display ad spent and brought, and moving its budget
// ---------------------------------------------------------------------------

export type GoogleDayStat = { day: string; spendPaise: number; impressions: number; clicks: number; leads: number };

type StatRow = {
  segments?: { date?: string };
  metrics?: { costMicros?: string | number; impressions?: string | number; clicks?: string | number; conversions?: string | number };
};

export async function googleDailyStats(input: {
  access: string;
  customerId: string;
  login: string | null;
  steps: Record<string, unknown>;
  since: string;
  until: string;
}): Promise<R<GoogleDayStat[]>> {
  const campaign = typeof input.steps.campaign === "string" ? input.steps.campaign : null;
  if (!campaign) return ok([]);
  const r = await search<StatRow>(
    input.access,
    input.customerId,
    input.login,
    `SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
     FROM campaign WHERE campaign.resource_name = ${lit(campaign)}
     AND segments.date BETWEEN ${lit(input.since)} AND ${lit(input.until)}`,
  );
  if (!r.ok) return r;
  return ok(
    r.value
      .filter((x) => typeof x.segments?.date === "string")
      .map((x) => ({
        day: x.segments!.date!,
        // Micros of a rupee to paise: divide by ten thousand.
        spendPaise: Math.round(Number(x.metrics?.costMicros ?? 0) / 10_000) || 0,
        impressions: Number(x.metrics?.impressions ?? 0) || 0,
        clicks: Number(x.metrics?.clicks ?? 0) || 0,
        leads: Math.round(Number(x.metrics?.conversions ?? 0)) || 0,
      })),
  );
}

/** A display ad's budget is the campaign's own, found through the campaign. */
export async function setGoogleBudget(input: {
  access: string;
  customerId: string;
  login: string | null;
  steps: Record<string, unknown>;
  rupees: number;
}): Promise<R<true>> {
  const campaign = typeof input.steps.campaign === "string" ? input.steps.campaign : null;
  if (!campaign) return { ok: false, ...refuse("NOT_FOUND", "This ad was never finished, so it has no budget to move.") };
  const found = await search<{ campaign?: { campaignBudget?: string } }>(
    input.access,
    input.customerId,
    input.login,
    `SELECT campaign.campaign_budget FROM campaign WHERE campaign.resource_name = ${lit(campaign)}`,
  );
  if (!found.ok) return found;
  const budget = found.value[0]?.campaign?.campaignBudget;
  if (!budget) return { ok: false, ...refuse("NOT_FOUND", "Google named no budget for this campaign.") };
  const r = await adsPost(input.access, input.login, `customers/${input.customerId}/googleAds:mutate`, {
    mutateOperations: [
      { campaignBudgetOperation: { update: { resourceName: budget, amountMicros: toMicros(input.rupees) }, updateMask: "amount_micros" } },
    ],
  });
  return r.ok ? ok(true) : r;
}

// ---------------------------------------------------------------------------
// Sending outcomes back: conversion actions, and the Data Manager API
// ---------------------------------------------------------------------------
//
// Google closed `UploadClickConversions` on 15 June 2026 to any project that
// had not uploaded between 17 December 2025 and then, which is ours. Its
// replacement is the Data Manager API's `events:ingest`, which takes the same
// gclid and hashed phone against an UPLOAD_CLICKS conversion action. It has
// no retraction, which is why a booking is held before it is sent.
// https://developers.google.com/google-ads/api/docs/deprecations
// https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events

type ActionRow = { conversionAction?: { id?: string | number; name?: string } };

/**
 * The conversion action for one outcome in one Ads account: found by its
 * name, or created. Google refuses a second action of the same name, so a
 * create whose answer was lost comes back DUPLICATE_NAME and is found.
 */
export async function ensureConversionAction(input: {
  access: string;
  customerId: string;
  login: string | null;
  name: string;
  category: string;
  primary: boolean;
  value: number;
}): Promise<R<{ id: string; created: boolean }>> {
  const find = async (): Promise<R<string | null>> => {
    const r = await search<ActionRow>(
      input.access,
      input.customerId,
      input.login,
      `SELECT conversion_action.id, conversion_action.name FROM conversion_action WHERE conversion_action.name = ${lit(input.name)}`,
    );
    if (!r.ok) return r;
    const id = r.value[0]?.conversionAction?.id;
    return ok(id === undefined || id === null ? null : String(id));
  };
  const found = await find();
  if (!found.ok) return found;
  if (found.value) return ok({ id: found.value, created: false });
  const made = await adsPost<{ results?: { resourceName?: string }[] }>(
    input.access,
    input.login,
    `customers/${input.customerId}/conversionActions:mutate`,
    {
      operations: [
        {
          create: {
            name: input.name,
            type: "UPLOAD_CLICKS",
            category: input.category,
            status: "ENABLED",
            primaryForGoal: input.primary,
            countingType: "ONE_PER_CLICK",
            valueSettings: { defaultValue: input.value, defaultCurrencyCode: "INR", alwaysUseDefaultValue: false },
          },
        },
      ],
    },
  );
  if (!made.ok) {
    if (made.code !== "DUPLICATE_NAME") return made;
    const again = await find();
    if (!again.ok) return again;
    return again.value ? ok({ id: again.value, created: false }) : { ok: false, ...refuse("NOT_FOUND", "Google said the conversion action exists and then could not find it.") };
  }
  const name = made.value.results?.[0]?.resourceName ?? "";
  const id = name.split("/").pop() ?? "";
  if (!/^\d{1,20}$/.test(id)) return { ok: false, ...refuse("INVALID", "Google created the conversion action without naming it.") };
  return ok({ id, created: true });
}

/**
 * One outcome to Google. A repeated transaction id is the same conversion
 * to Google, so a send whose answer was lost is sent again safely.
 */
export async function ingestOutcome(access: string, body: Record<string, unknown>): Promise<R<{ requestId: string | null }>> {
  const r = await call<{ requestId?: string }>("GOOGLE", `${HOSTS.dataManager}/v1/events:ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok ? ok({ requestId: r.json.requestId ?? null }) : r;
}
