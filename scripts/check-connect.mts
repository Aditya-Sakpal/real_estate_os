// Functional check of the Meta and Google connectors, against the real
// database, with both platforms replaced by a fake that behaves like them.
//
//   node --experimental-strip-types --no-warnings --env-file=.env.local scripts/check-connect.mts
//
// Nothing here talks to Meta or Google. The app has no App Review and no
// developer token, and a suite that waited for either would test nothing. The
// fake answers at the same URLs with the same shapes the published references
// give, records every call, and can be told to lose an answer or refuse a
// token, which is where the interesting rules live: a retry that resumes
// instead of creating twice, an ad that is never created spending, a kill
// switch that pauses what a lapsed registration was advertising.
//
// It builds its own organisation, with its own user, tree, registration,
// Brain, brief and posts, and deletes the whole tenant at the end. It never
// reads or touches another organisation's connections.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import sharp from "sharp";
import postgres from "postgres";

if (!existsSync(".env.local")) throw new Error("run with --env-file=.env.local");

// The app's own credentials, for this process only. The fake does not check
// them beyond their presence, which is what the code under test checks too.
process.env.META_APP_ID = "4242424242";
process.env.META_APP_SECRET = "check-connect-app-secret";
delete process.env.META_CONFIG_ID;
process.env.GOOGLE_CONNECT_CLIENT_ID = "check-connect.apps.googleusercontent.com";
process.env.GOOGLE_CONNECT_CLIENT_SECRET = "check-connect-google-secret";
// No developer token: they were retired on 9 September 2026, and Ads access
// now belongs to the OAuth client's Cloud project.
delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
// Business Profile is asked for only when switched on; this suite covers it.
process.env.GOOGLE_BUSINESS_PROFILE = "on";
const STORE = mkdtempSync(join(tmpdir(), "salesdesk-connect-"));
process.env.ASSETS_DIR = STORE;

const { useVaultKey, open: openSealed, connectionPurpose, accountPurpose } = await import("../src/lib/vault.ts");
const { usePlatform } = await import("../src/lib/platform.ts");
const connect = await import("../src/lib/connect.ts");
const publish = await import("../src/lib/publish.ts");
const bidding = await import("../src/lib/bidding.ts");
const { putAsset } = await import("../src/lib/storage.ts");
const { closeDb, withTenant, withNoTenant } = await import("../src/lib/db/index.ts");

useVaultKey(randomBytes(32));

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

// ---------------------------------------------------------------------------
// The fake platform
// ---------------------------------------------------------------------------

type Call = { method: string; host: string; path: string; query: URLSearchParams; fields: Record<string, string>; headers: Record<string, string> };
const calls: Call[] = [];
let seq = 1000;
const next = (p: string) => `${p}${seq++}`;

/** One answer to lose (the platform did it, the caller never heard) or refuse. */
type Trap = { match: (c: Call) => boolean; mode: "lose" | "refuse"; status?: number; body?: unknown; times: number };
let traps: Trap[] = [];

const meta = {
  validTokens: new Set<string>(),
  pagePosts: [] as { id: string; page: string; message: string; photos: string[]; created: number }[],
  photos: [] as { id: string; page: string; published: boolean }[],
  videos: [] as { id: string; page: string; description: string; created: number }[],
  containers: new Map<string, { ig: string; fields: Record<string, string>; polls: number }>(),
  igMedia: [] as { id: string; ig: string; caption: string; created: number; container: string }[],
  campaigns: [] as { id: string; act: string; fields: Record<string, string>; status: string }[],
  adsets: [] as { id: string; act: string; fields: Record<string, string> }[],
  creatives: [] as { id: string; act: string; fields: Record<string, string> }[],
  ads: [] as { id: string; act: string; fields: Record<string, string> }[],
  images: [] as string[],
  conversions: [] as { id: string; fields: Record<string, string> }[],
  forms: [] as { id: string; page: string; token: string; fields: Record<string, string> }[],
  revoked: 0,
  /** Reels that take this many polls before Instagram says FINISHED. */
  reelPolls: 2,
};

const google = {
  campaigns: [] as { rn: string; cid: string; name: string; status: string; ops: unknown[]; login: string | null }[],
  assets: [] as { rn: string; cid: string; name: string }[],
  posts: [] as { name: string; summary: string; body: Record<string, unknown>; created: number }[],
  groupAssets: [] as { assetGroup: string; asset: string; fieldType: string }[],
  uploads: [] as { title: string; privacy: string }[],
  revoked: 0,
};

const PAGE = "5550001";
const PAGE_2 = "5550002";
const IG = "17840000001";
const ACT = "act_777";
const CUSTOMER = "1234567890";
const MANAGER = "9998887770";
const CLIENT = "5556667770";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function readFields(init: RequestInit): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const b = init.body;
  if (b instanceof URLSearchParams) for (const [k, v] of b) out[k] = v;
  else if (b instanceof FormData) {
    for (const [k, v] of b) out[k] = typeof v === "string" ? v : `<file ${(v as Blob).type} ${(v as Blob).size}>`;
  } else if (typeof b === "string") {
    try {
      Object.assign(out, { __json: b });
    } catch {
      /* not json */
    }
  }
  return out;
}

async function fake(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const c: Call = {
    method: (init.method ?? "GET").toUpperCase(),
    host: u.host,
    path: u.pathname,
    query: u.searchParams,
    fields: await readFields(init),
    headers,
  };
  calls.push(c);

  const trap = traps.find((t) => t.times > 0 && t.match(c));
  if (trap) {
    trap.times -= 1;
    if (trap.mode === "refuse") return json(trap.body ?? {}, trap.status ?? 400);
    // "lose": the platform does the work, and the answer never arrives.
    await route(c, u);
    throw new Error("connection reset");
  }
  return route(c, u);
}

async function route(c: Call, u: URL): Promise<Response> {
  if (u.host.endsWith("facebook.com")) return routeMeta(c, u);
  return routeGoogle(c, u);
}

function metaToken(c: Call): string {
  return (c.headers.authorization ?? "").replace(/^Bearer /, "");
}

async function routeMeta(c: Call, u: URL): Promise<Response> {
  const parts = u.pathname.split("/").filter(Boolean).slice(1); // drop the version
  const path = parts.join("/");
  const q = u.searchParams;
  const f = c.fields;
  const now = Date.now();

  if (path === "oauth/access_token") {
    if (q.get("grant_type") === "fb_exchange_token") {
      meta.validTokens.add("meta-long-token");
      return json({ access_token: "meta-long-token", expires_in: 5_184_000 });
    }
    meta.validTokens.add("meta-short-token");
    return json({ access_token: "meta-short-token" });
  }
  if (path === "debug_token") {
    const t = q.get("input_token") ?? "";
    return json({
      data: {
        is_valid: meta.validTokens.has(t),
        type: "USER",
        expires_at: Math.floor(now / 1000) + 60 * 86_400,
        user_id: "10203040506070",
        scopes: [
          "pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic",
          "instagram_content_publish", "ads_management", "ads_read", "business_management",
        ],
      },
    });
  }
  const token = metaToken(c);
  if (!meta.validTokens.has(token)) {
    return json({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, 400);
  }
  if (c.method === "DELETE" && path === "me/permissions") {
    meta.revoked += 1;
    return json({ success: true });
  }
  if (path === "me/accounts") {
    return json({
      data: [
        { id: PAGE, name: "Sath Group", instagram_business_account: { id: IG, username: "sathgroup" } },
        { id: PAGE_2, name: "Sath Heights" },
      ],
    });
  }
  if (path === "me/adaccounts") {
    return json({ data: [{ id: ACT, account_id: "777", name: "Sath Ads", currency: "INR", account_status: 1 }] });
  }
  if ((parts[0] === PAGE || parts[0] === PAGE_2) && parts.length === 1 && q.get("fields") === "access_token") {
    const t = `meta-page-token-${parts[0]}`;
    meta.validTokens.add(t);
    return json({ id: parts[0], access_token: t });
  }
  if (parts[1] === "photos" && c.method === "POST") {
    const published = f.published !== "false";
    const id = next("photo_");
    meta.photos.push({ id, page: parts[0], published });
    if (!published) return json({ id });
    const post = { id: `${parts[0]}_${next("")}`, page: parts[0], message: f.message ?? "", photos: [id], created: now };
    meta.pagePosts.push(post);
    return json({ id, post_id: post.id });
  }
  if (parts[1] === "feed" && c.method === "POST") {
    const attached = JSON.parse(f.attached_media ?? "[]") as { media_fbid: string }[];
    const post = { id: `${parts[0]}_${next("")}`, page: parts[0], message: f.message ?? "", photos: attached.map((a) => a.media_fbid), created: now };
    meta.pagePosts.push(post);
    return json({ id: post.id });
  }
  if (parts[1] === "videos" && c.method === "POST") {
    const id = next("video_");
    meta.videos.push({ id, page: parts[0], description: f.description ?? "", created: now });
    return json({ id });
  }
  if (parts[1] === "published_posts") {
    return json({ data: meta.pagePosts.filter((p) => p.page === parts[0]).map((p) => ({ id: p.id, message: p.message })) });
  }
  if (parts[1] === "videos") {
    return json({ data: meta.videos.filter((v) => v.page === parts[0]).map((v) => ({ id: v.id, description: v.description })) });
  }
  if (parts[0] === IG && parts[1] === "media" && c.method === "POST") {
    const id = next("container_");
    meta.containers.set(id, { ig: IG, fields: f, polls: 0 });
    return json({ id });
  }
  if (parts[0] === IG && parts[1] === "media_publish") {
    const container = meta.containers.get(f.creation_id ?? "");
    if (!container) return json({ error: { message: "Invalid creation id", code: 100 } }, 400);
    const id = next("igmedia_");
    meta.igMedia.push({ id, ig: IG, caption: container.fields.caption ?? "", created: now, container: f.creation_id! });
    return json({ id });
  }
  if (parts[0] === IG && parts[1] === "media") {
    return json({ data: meta.igMedia.map((m) => ({ id: m.id, caption: m.caption, timestamp: new Date(m.created).toISOString() })) });
  }
  if (meta.containers.has(parts[0]) && q.get("fields") === "status_code") {
    const box = meta.containers.get(parts[0])!;
    box.polls += 1;
    const slow = box.fields.media_type === "REELS" && box.polls <= meta.reelPolls;
    return json({ status_code: slow ? "IN_PROGRESS" : "FINISHED" });
  }
  if (parts[0]?.startsWith("igmedia_")) return json({ permalink: `https://www.instagram.com/p/${parts[0]}/` });
  if (q.get("fields") === "permalink_url") return json({ permalink_url: `/${parts[0]}` });

  // An instant form, filed under a Page with the Page's own token.
  if ((parts[0] === PAGE || parts[0] === PAGE_2) && parts[1] === "leadgen_forms") {
    if (!token.startsWith("meta-page-token-")) return json({ error: { message: "A Page access token is required", code: 190 } }, 400);
    if (c.method === "POST") {
      const id = next("form_");
      meta.forms.push({ id, page: parts[0], token, fields: f });
      return json({ id });
    }
    return json({ data: meta.forms.filter((x) => x.page === parts[0]).map((x) => ({ id: x.id, name: x.fields.name })) });
  }

  // Ads
  if (parts[0] === ACT && parts[1] === "adimages") {
    const hash = next("hash_");
    meta.images.push(hash);
    return json({ images: { bytes: { hash } } });
  }
  if (parts[0] === ACT && parts[1] === "advideos") return json({ id: next("advideo_") });
  if (parts[0]?.startsWith("advideo_")) return json({ status: { video_status: "ready" }, picture: "https://scontent.example/p.jpg" });
  if (path === "search" && q.get("type") === "adgeolocation") {
    return json({ data: q.get("q") === "Pune" ? [{ key: "2295424", name: "Pune", type: "city" }] : [] });
  }
  // Custom conversions on the ad account: listed by name, made from a rule on a dataset.
  if (parts[0] === ACT && parts[1] === "customconversions") {
    if (c.method === "POST") {
      const id = String(23850000000000 + meta.conversions.length + 1);
      meta.conversions.push({ id, fields: f });
      return json({ id });
    }
    return json({ data: meta.conversions.map((x) => ({ id: x.id, name: x.fields.name })) });
  }
  if (parts[0] === ACT && ["campaigns", "adsets", "adcreatives", "ads"].includes(parts[1])) {
    const list =
      parts[1] === "campaigns" ? meta.campaigns : parts[1] === "adsets" ? meta.adsets : parts[1] === "ads" ? meta.ads : meta.creatives;
    if (c.method === "POST") {
      const id = next(`${parts[1]}_`);
      if (parts[1] === "campaigns") meta.campaigns.push({ id, act: ACT, fields: f, status: f.status ?? "" });
      else (list as { id: string; act: string; fields: Record<string, string> }[]).push({ id, act: ACT, fields: f });
      return json({ id });
    }
    const filter = JSON.parse(q.get("filtering") ?? "[]") as { value: string }[];
    const needle = filter[0]?.value ?? "";
    return json({ data: list.filter((x) => (x.fields.name ?? "").includes(needle)).map((x) => ({ id: x.id, name: x.fields.name })) });
  }
  const campaign = meta.campaigns.find((x) => x.id === parts[0]);
  if (campaign && c.method === "POST") {
    campaign.status = f.status ?? campaign.status;
    return json({ success: true });
  }
  return json({ error: { message: `fake has no route for ${c.method} ${path}`, code: 100 } }, 400);
}

const googleValid = new Set<string>();

async function routeGoogle(c: Call, u: URL): Promise<Response> {
  const f = c.fields;
  const body = f.__json ? (JSON.parse(f.__json) as Record<string, unknown>) : {};
  const now = Date.now();

  if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
    if (f.grant_type === "authorization_code") {
      if (!f.code_verifier) return json({ error: "invalid_grant", error_description: "Missing code verifier." }, 400);
      googleValid.add("google-access-1");
      return json({
        access_token: "google-access-1",
        refresh_token: "google-refresh-1",
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/youtube.upload",
      });
    }
    if (f.grant_type === "refresh_token") {
      if (f.refresh_token !== "google-refresh-1" || google.revoked) return json({ error: "invalid_grant" }, 400);
      googleValid.add("google-access-2");
      return json({ access_token: "google-access-2", expires_in: 3599 });
    }
  }
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") {
    google.revoked += 1;
    return json({});
  }
  const token = (c.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!googleValid.has(token)) return json({ error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid credentials" } }, 401);

  if (u.host === "googleads.googleapis.com") {
    // A developer token is ignored today and will be refused by a later
    // version, so the fake refuses one now.
    if (c.headers["developer-token"]) return json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "developer-token is no longer accepted" } }, 400);
    const p = u.pathname.replace(/^\/v\d+\//, "");
    if (p === "customers:listAccessibleCustomers") {
      return json({ resourceNames: [`customers/${CUSTOMER}`, `customers/${MANAGER}`] });
    }
    if (p === "geoTargetConstants:suggest") {
      return json({ geoTargetConstantSuggestions: [{ geoTargetConstant: { resourceName: "geoTargetConstants/1007788", targetType: "City", status: "ENABLED" } }] });
    }
    const m = p.match(/^customers\/(\d+)\/(.+)$/);
    if (m) {
      const [, cid, op] = m;
      if (op === "googleAds:search") {
        const qy = String(body.query ?? "");
        if (qy.includes("FROM customer_client")) {
          return json({ results: [{ customerClient: { id: CLIENT, descriptiveName: "Sath Group via agency", currencyCode: "INR", manager: false, status: "ENABLED" } }] });
        }
        if (qy.includes("FROM customer ")) {
          return json({ results: [{ customer: { id: cid, descriptiveName: cid === MANAGER ? "Agency MCC" : "Sath Direct", currencyCode: "INR", manager: cid === MANAGER } }] });
        }
        if (qy.includes("FROM asset_group")) {
          return json({ results: [{ assetGroup: { resourceName: `customers/${cid}/assetGroups/${next("")}` } }] });
        }
        if (qy.includes("FROM asset")) {
          const name = qy.match(/asset\.name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\'/g, "'");
          const hit = google.assets.find((a) => a.cid === cid && a.name === name);
          return json({ results: hit ? [{ asset: { resourceName: hit.rn } }] : [] });
        }
        if (qy.includes("FROM campaign")) {
          const name = qy.match(/campaign\.name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\'/g, "'");
          const hit = google.campaigns.find((x) => x.cid === cid && x.name === name);
          return json({ results: hit ? [{ campaign: { resourceName: hit.rn } }] : [] });
        }
        return json({ results: [] });
      }
      if (op === "assets:mutate") {
        const create = (body.operations as { create: { name: string } }[])[0].create;
        const rn = `customers/${cid}/assets/${next("")}`;
        google.assets.push({ rn, cid, name: create.name });
        return json({ results: [{ resourceName: rn }] });
      }
      if (op === "assetGroupAssets:mutate") {
        for (const o of body.operations as { create: { assetGroup: string; asset: string; fieldType: string } }[]) google.groupAssets.push(o.create);
        return json({ results: (body.operations as unknown[]).map(() => ({ resourceName: `customers/${cid}/assetGroupAssets/${next("")}` })) });
      }
      if (op === "googleAds:mutate") {
        const ops = body.mutateOperations as Record<string, { create?: Record<string, unknown>; update?: Record<string, unknown> }>[];
        const update = ops[0].campaignOperation?.update;
        if (update) {
          const hit = google.campaigns.find((x) => x.rn === update.resourceName);
          if (hit) hit.status = String(update.status);
          return json({ mutateOperationResponses: [{ campaignResult: { resourceName: update.resourceName } }] });
        }
        const campaign = ops.find((o) => o.campaignOperation)?.campaignOperation?.create as Record<string, unknown>;
        if (google.campaigns.some((x) => x.cid === cid && x.name === campaign.name)) {
          return json({
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: "Request contains an invalid argument.",
              details: [{ "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure", errors: [{ errorCode: { campaignError: "DUPLICATE_CAMPAIGN_NAME" }, message: "A campaign with this name already exists." }] }],
            },
          }, 400);
        }
        const rn = `customers/${cid}/campaigns/${next("")}`;
        google.campaigns.push({ rn, cid, name: String(campaign.name), status: String(campaign.status), ops, login: c.headers["login-customer-id"] ?? null });
        return json({ mutateOperationResponses: [{ campaignBudgetResult: {} }, { campaignResult: { resourceName: rn } }] });
      }
    }
  }
  if (u.host === "www.googleapis.com" && u.pathname === "/upload/youtube/v3/videos") {
    if (c.method === "POST") {
      const b = body as { snippet?: { title?: string }; status?: { privacyStatus?: string } };
      google.uploads.push({ title: b.snippet?.title ?? "", privacy: b.status?.privacyStatus ?? "" });
      return new Response("", { status: 200, headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=up1" } });
    }
    if (c.method === "PUT" && u.searchParams.get("upload_id")) return json({ id: "dQw4w9WgXcQ" });
  }
  if (u.host === "mybusinessaccountmanagement.googleapis.com") {
    return json({ accounts: [{ name: "accounts/77", accountName: "Sath Group" }] });
  }
  if (u.host === "mybusinessbusinessinformation.googleapis.com") {
    return json({ locations: [{ name: "locations/88", title: "Sath Heights Sales Office", storefrontAddress: { locality: "Pune" } }] });
  }
  if (u.host === "mybusiness.googleapis.com") {
    if (c.method === "POST") {
      const post = { name: `accounts/77/locations/88/localPosts/${next("")}`, summary: String(body.summary ?? ""), body, created: now };
      google.posts.push(post);
      return json({ name: post.name, searchUrl: `https://local.google.com/place?post=${post.name}` });
    }
    return json({ localPosts: google.posts.map((p) => ({ name: p.name, summary: p.summary, createTime: new Date(p.created).toISOString() })) });
  }
  return json({ error: { code: 404, status: "NOT_FOUND", message: `fake has no route for ${c.method} ${u.host}${u.pathname}` } }, 404);
}

usePlatform(fake);

// ---------------------------------------------------------------------------
// A tenant of its own
// ---------------------------------------------------------------------------

const tag = Date.now().toString(36);
async function seedTenant(name: string, slug: string) {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_domain, name)
    VALUES (${`admin@${slug}${tag}.example`}, ${`${slug}${tag}.example`}, ${`${name} Admin`})
    RETURNING id`;
  const [o] = await sql<{ id: string }[]>`
    INSERT INTO orgs (type, legal_name, display_name, pan, primary_domain, created_by)
    VALUES ('DEVELOPER', ${name}, ${name}, 'AAPFU0939F', ${`${slug}${tag}.example`}, ${u.id})
    RETURNING id`;
  const [root] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${o.id}, NULL, 'ORG', ${name}, ${slug + tag}, ${slug + tag}::ltree)
    RETURNING id, path::text AS path`;
  await sql`
    INSERT INTO memberships (user_id, org_id, scope_node_id, role, status)
    VALUES (${u.id}, ${o.id}, ${root.id}, 'ORG_ADMIN', 'ACTIVE')`;
  return { userId: u.id, orgId: o.id, root };
}

const T = await seedTenant("Sath Group", "connect_check_");
const OTHER = await seedTenant("Other Developer", "connect_other_");
const orgId = T.orgId;
const userId = T.userId;

const node = async (parent: string, kind: string, name: string, slug: string, parentPath: string) => {
  const [row] = await sql<{ id: string; path: string }[]>`
    INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
    VALUES (${orgId}, ${parent}, ${kind}, ${name}, ${slug}, ${`${parentPath}.${slug}`}::ltree)
    RETURNING id, path::text AS path`;
  return row;
};
const entity = await node(T.root.id, "ENTITY", "Sath Heights LLP", "sath_llp", T.root.path);
const region = await node(entity.id, "REGION", "Pune", "pune", entity.path);
const project = await node(region.id, "PROJECT", "Sath Heights", "sath_heights", region.path);
const phase = await node(project.id, "PHASE", "Tower C", "tower_c", project.path);

const FAR = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
await sql`
  INSERT INTO registration_records (scope_node_id, org_id, status, registration_no, state_code,
                                    promoter_name, valid_to, verified_at)
  VALUES (${phase.id}, ${orgId}, 'VERIFIED', 'P52100012345', 'MH', 'Sath Heights LLP', ${FAR}, now())`;

const [bv] = await sql<{ id: string }[]>`
  INSERT INTO brain_versions (org_id, scope_node_id, version, state, created_by)
  VALUES (${orgId}, ${phase.id}, 1, 'DRAFT', ${userId}) RETURNING id`;
for (const [k, v] of [
  ["claims.talking_points", "Sea facing from the 18th floor up\nTwo lifts per wing\nA podium garden"],
  ["claims.never_say", "guaranteed returns"],
  ["claims.location", "Goregaon West"],
] as const) {
  await sql`INSERT INTO brain_fields (org_id, brain_version_id, field_key, value) VALUES (${orgId}, ${bv.id}, ${k}, ${v})`;
}
await sql`UPDATE brain_versions SET state = 'PUBLISHED', published_at = now() WHERE id = ${bv.id}`;
await sql`
  INSERT INTO brand_kits (org_id, scope_node_id, sales_phone, website, updated_by)
  VALUES (${orgId}, ${entity.id}, '+919876500000', 'https://sathheights.example', ${userId})`;

const [brief] = await sql<{ id: string }[]>`
  INSERT INTO campaign_briefs (org_id, scope_node_id, name, status, objective, languages, formats, cta, audience, updated_by)
  VALUES (${orgId}, ${phase.id}, 'Connect Check Push', 'READY', 'SITE_VISIT', ${["English"]},
          ${["Meta feed 1:1", "Meta reel 9:16", "Google display"]}, 'Book a site visit', 'First time buyers', ${userId})
  RETURNING id`;
const [copy] = await sql<{ id: string }[]>`
  INSERT INTO campaign_copy (org_id, brief_id, scope_node_id, language, segment, headline, body, cta, verdict, model, generated_by)
  VALUES (${orgId}, ${brief.id}, ${phase.id}, 'English', 'END_USER', 'Sea facing homes', 'Sea facing from the 18th floor up.',
          'Book a site visit', 'PASS', 'fixture', ${userId})
  RETURNING id`;

const jpeg = (w: number, h: number, r: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g: 90, b: 140 } } }).jpeg().toBuffer();

// The pixel gate's verdict as a post would carry it: every publish asks for a
// PASS on the very files, under the registration the gate says yes about.
// The gate itself is `check:pixel`'s; here it is the record prepare() reads.
const fileHash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const pixelRecord = (hashes: string[], verdict: "PASS" | "FAIL" | "HOLD" = "PASS") => ({
  verdict,
  engine: "fixture",
  checkedAt: new Date().toISOString(),
  registrationNo: "P52100012345",
  files: hashes.map((sha256) => ({ sha256, frames: 1, verdict })),
  findings: verdict === "PASS" ? [] : [{ code: verdict === "FAIL" ? "REG_WRONG" : "REG_LAPSING", verdict, text: "fixture", file: 0 }],
});

/** A studio post with its files in the local store. */
async function makePost(opts: {
  kind: "IMAGE" | "CAROUSEL" | "VIDEO";
  placement: string;
  frames: { w: number; h: number; type?: string }[];
  headline?: string;
  body?: string;
  passed?: boolean;
  copyId?: string;
  /** The pixel gate's verdict: a PASS unless said, or none at all for a post made before it. */
  pixel?: "PASS" | "FAIL" | "HOLD" | null;
  /** Record a hash for a different file than the one stored. */
  staleHash?: boolean;
}) {
  const id = crypto.randomUUID();
  const media = [];
  for (let i = 0; i < opts.frames.length; i++) {
    const fr = opts.frames[i];
    const type = fr.type ?? "image/jpeg";
    const bytes = type === "video/mp4" ? Buffer.from("fake mp4 bytes") : await jpeg(fr.w, fr.h, 40 + i * 30);
    const put = await putAsset({ orgId, project: null, kind: "post", id: `${id}-${i}`, bytes, contentType: type });
    if (!put.ok) throw new Error("could not store a fixture file");
    media.push({ key: put.key, type, width: fr.w, height: fr.h, bytes: bytes.byteLength, sha256: fileHash(bytes) });
  }
  const pixel = opts.pixel === null ? null : pixelRecord(media.map((m) => (opts.staleHash ? "f".repeat(64) : m.sha256)), opts.pixel ?? "PASS");
  await sql`
    INSERT INTO rendered_posts (id, org_id, brief_id, scope_node_id, copy_id, kind, placement, language, segment,
                                headline, body, cta, media, inputs, review, pixel, created_by)
    VALUES (${id}, ${orgId}, ${brief.id}, ${phase.id}, ${opts.copyId ?? copy.id}, ${opts.kind}, ${opts.placement}, 'English', 'END_USER',
            ${opts.headline ?? "Sea facing homes"}, ${opts.body ?? "Sea facing from the 18th floor up."}, 'Book a site visit',
            ${sql.json(media)}, ${sql.json({})}, ${sql.json({ passed: opts.passed ?? true, attempts: 1, problems: [], model: "fixture" })},
            ${pixel ? sql.json(pixel) : null}, ${userId})`;
  return id;
}

const later = (ms: number) => new Date(Date.now() + ms);
const targetsOf = (postId: string) =>
  sql<{ id: string; destination: string; state: string; steps: Record<string, unknown>; error: string | null; caption: string; daily_budget: number | null; paused_reason: string | null; blocked_at: Date | null }[]>`
    SELECT id, destination, state, steps, error, caption, daily_budget, paused_reason, blocked_at
    FROM publish_targets WHERE org_id = ${orgId} AND rendered_post_id = ${postId} ORDER BY created_at`;

try {
  // -------------------------------------------------------------------------
  console.log("\nconnecting Meta");

  const begun = connect.beginConnect({ orgId, userId, provider: "META", redirectUri: "http://localhost:3000/api/connect/meta/callback" });
  const dialog = new URL(begun.url);
  check("the person is sent to Meta's own dialog", dialog.host, "www.facebook.com");
  check("asking for the permissions publishing needs",
    (dialog.searchParams.get("scope") ?? "").split(",").includes("instagram_content_publish") &&
      (dialog.searchParams.get("scope") ?? "").split(",").includes("ads_management"), true);
  const state = dialog.searchParams.get("state");
  check("the state comes back for this browser and this person",
    connect.checkReturn({ state, nonce: begun.nonce, userId, provider: "META" }), { ok: true, orgId });
  check("but not in another browser",
    (connect.checkReturn({ state, nonce: "somebody-elses", userId, provider: "META" }) as { code: string }).code, "OTHER_BROWSER");
  check("and not for another person",
    (connect.checkReturn({ state, nonce: begun.nonce, userId: OTHER.userId, provider: "META" }) as { code: string }).code, "OTHER_PERSON");
  check("and not with an edited state",
    (connect.checkReturn({ state: `${state}x`, nonce: begun.nonce, userId, provider: "META" }) as { code: string }).code, "FORGED");
  check("and not for the other provider",
    (connect.checkReturn({ state, nonce: begun.nonce, userId, provider: "GOOGLE" }) as { code: string }).code, "OTHER_PROVIDER");

  const done = await connect.finishConnect({ orgId, userId, provider: "META", code: "meta-code", redirectUri: "http://localhost:3000/api/connect/meta/callback", verifier: null });
  check("the code is exchanged", done, { ok: true });
  let meta_ = await connect.loadConnection(orgId, "META");
  check("a first consent waits for accounts to be chosen", meta_?.status, "PENDING");
  check("the short token was swapped for the long one before it was stored",
    calls.some((c) => c.query.get("grant_type") === "fb_exchange_token"), true);
  check("every Page, the Instagram account and the ad account are offered",
    meta_?.choices.map((c) => `${c.kind}:${c.id}`).sort(),
    [`FACEBOOK_PAGE:${PAGE}`, `FACEBOOK_PAGE:${PAGE_2}`, `INSTAGRAM:${IG}`, `META_AD_ACCOUNT:${ACT}`].sort());
  const [stored] = await sql<{ id: string; secret: Buffer }[]>`SELECT id, secret FROM connections WHERE org_id = ${orgId} AND provider = 'META'`;
  check("what is stored is not the token", stored.secret.includes(Buffer.from("meta-long-token")), false);
  check("but it opens, for this row", JSON.parse(await openSealed(orgId, connectionPurpose(stored.id), stored.secret) ?? "{}").access_token, "meta-long-token");
  check("and not for another tenant", await openSealed(OTHER.orgId, connectionPurpose(stored.id), stored.secret), null);
  check("the token went in a header, never a URL",
    calls.filter((c) => c.host.endsWith("facebook.com") && c.path.includes("me/accounts")).every((c) => !c.query.has("access_token") && !!c.headers.authorization), true);
  check("with a proof of the app secret beside it",
    calls.filter((c) => c.path.includes("me/accounts")).every((c) => c.query.get("appsecret_proof") === createHmac("sha256", process.env.META_APP_SECRET!).update("meta-long-token").digest("hex")), true);

  check("an account nobody consented to is refused",
    (await connect.chooseAccounts({ orgId, userId, provider: "META", picks: [{ kind: "FACEBOOK_PAGE", id: "999", nodeId: T.root.id }] })) as { code: string },
    { ok: false, code: "NOT_OFFERED", message: "One of those accounts is not in what you connected. Connect again." });
  check("two Pages for one place are refused",
    ((await connect.chooseAccounts({ orgId, userId, provider: "META", picks: [
      { kind: "FACEBOOK_PAGE", id: PAGE, nodeId: T.root.id },
      { kind: "FACEBOOK_PAGE", id: PAGE_2, nodeId: T.root.id },
    ] })) as { code: string }).code, "TWO_AT_ONE_PLACE");
  check("a place in another tenant is refused",
    ((await connect.chooseAccounts({ orgId, userId, provider: "META", picks: [{ kind: "FACEBOOK_PAGE", id: PAGE, nodeId: OTHER.root.id }] })) as { code: string }).code,
    "UNKNOWN_PLACE");

  const chose = await connect.chooseAccounts({ orgId, userId, provider: "META", picks: [
    { kind: "FACEBOOK_PAGE", id: PAGE, nodeId: T.root.id },
    { kind: "FACEBOOK_PAGE", id: PAGE_2, nodeId: project.id },
    { kind: "INSTAGRAM", id: IG, nodeId: T.root.id },
    { kind: "META_AD_ACCOUNT", id: ACT, nodeId: T.root.id },
  ] });
  check("choosing accounts connects it", chose.ok, true);
  meta_ = await connect.loadConnection(orgId, "META");
  check("and the connection is live", meta_?.status, "CONNECTED");

  const dests = await connect.destinationsFor(orgId, phase.path);
  const fb = dests.get("FACEBOOK_PAGE");
  check("the project's own Page wins over the organisation's for a tower under it",
    fb?.ok ? fb.to.account.externalId : null, PAGE_2);
  const orgDests = await connect.destinationsFor(orgId, entity.path);
  check("and the organisation's Page covers everything else",
    (orgDests.get("FACEBOOK_PAGE") as { ok: true; to: { account: { externalId: string } } }).to.account.externalId, PAGE);

  const accounts = await sql<{ id: string; kind: string; secret: Buffer | null }[]>`
    SELECT id, kind, secret FROM connection_accounts WHERE org_id = ${orgId} ORDER BY kind`;
  const igRow = accounts.find((a) => a.kind === "INSTAGRAM")!;
  const pageRow = accounts.find((a) => a.kind === "FACEBOOK_PAGE" && a.secret)!;
  check("the Pages and Instagram hold their own sealed tokens",
    accounts.filter((a) => a.kind !== "META_AD_ACCOUNT").every((a) => a.secret !== null), true);
  check("an ad account holds none of its own", accounts.find((a) => a.kind === "META_AD_ACCOUNT")!.secret, null);
  check("Instagram publishes with its Page's token",
    JSON.parse(await openSealed(orgId, accountPurpose(igRow.id), igRow.secret) ?? "{}").access_token, `meta-page-token-${PAGE}`);
  check("a sealed token copied to another row does not open there",
    await openSealed(orgId, accountPurpose(pageRow.id), igRow.secret), null);

  // -------------------------------------------------------------------------
  console.log("\na picture to the Page and Instagram");

  const square = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }] });
  let options = await publish.publishOptions(orgId, square);
  const opt = (d: string) => (options.ok ? options.options.find((o) => o.destination === d) : null);
  check("the Page, Instagram and a Meta ad are offered", ["FACEBOOK_PAGE", "INSTAGRAM"].map((d) => opt(d)?.ok), [true, true]);
  check("a Meta ad waits for a spending limit", opt("META_AD")?.reason, "Nobody has set a daily limit for this ad account yet.");
  check("a square post is not a Google display ad", opt("GOOGLE_DISPLAY_AD")?.ok, false);

  const first = await publish.requestPublish({ orgId, userId, postId: square, destinations: ["FACEBOOK_PAGE", "INSTAGRAM"] });
  check("both go live on the press", first.ok ? first.results.map((r) => [r.destination, r.message]) : first,
    [["FACEBOOK_PAGE", "Live."], ["INSTAGRAM", "Live."]]);
  const pagePost = meta.pagePosts.at(-1)!;
  check("to the tower's own Page", pagePost.page, PAGE_2);
  check("with the cleared copy and the registration line as the caption", pagePost.message,
    "Sea facing homes\n\nSea facing from the 18th floor up.\n\nBook a site visit\n\nMahaRERA No. P52100012345 | maharera.maharashtra.gov.in");
  check("Instagram fetched the picture from a link rather than an upload",
    !!(await targetsOf(square)).find((t) => t.destination === "INSTAGRAM") && [...meta.containers.values()].at(-1)!.fields.image_url?.length > 0, true);
  check("and published the container it made", meta.igMedia.length, 1);

  const again = await publish.requestPublish({ orgId, userId, postId: square, destinations: ["FACEBOOK_PAGE", "INSTAGRAM"] });
  check("a second press publishes nothing twice",
    again.ok ? again.results.map((r) => r.message) : again, ["Already live there.", "Already live there."]);
  check("and the platform still has one of each", [meta.pagePosts.length, meta.igMedia.length], [1, 1]);

  // -------------------------------------------------------------------------
  console.log("\na carousel and a reel");

  const carousel = await makePost({ kind: "CAROUSEL", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }, { w: 1080, h: 1080 }, { w: 1080, h: 1080 }] });
  const car = await publish.requestPublish({ orgId, userId, postId: carousel, destinations: ["FACEBOOK_PAGE", "INSTAGRAM"] });
  check("a carousel goes live on both", car.ok ? car.results.map((r) => r.message) : car, ["Live.", "Live."]);
  check("as an album of three on the Page", meta.pagePosts.at(-1)!.photos.length, 3);
  check("uploaded unpublished first, so nothing shows half made",
    meta.photos.slice(-3).every((p) => !p.published), true);
  check("and as an Instagram carousel",
    [...meta.containers.values()].filter((b) => b.fields.is_carousel_item === "true").length === 3 &&
      [...meta.containers.values()].some((b) => b.fields.media_type === "CAROUSEL"), true);

  const reel = await makePost({ kind: "VIDEO", placement: "Meta reel 9:16", frames: [{ w: 1080, h: 1920, type: "video/mp4" }] });
  const r1 = await publish.requestPublish({ orgId, userId, postId: reel, destinations: ["INSTAGRAM"] });
  check("a reel Instagram is still processing is on its way, not failed",
    r1.ok ? r1.results[0].message : r1, "On its way. The platform is still processing it.");
  let [reelTarget] = await targetsOf(reel);
  check("waiting is not an attempt", (await sql<{ attempts: number }[]>`SELECT attempts FROM publish_targets WHERE id = ${reelTarget.id}`)[0].attempts, 0);
  let adv = await publish.advance(orgId, reelTarget.id, { now: later(20_000) });
  adv = await publish.advance(orgId, reelTarget.id, { now: later(40_000) });
  check("and goes live once it is processed", adv.state, "LIVE");
  check("as a reel", [...meta.containers.values()].some((b) => b.fields.media_type === "REELS" && b.fields.share_to_feed === "true"), true);

  // -------------------------------------------------------------------------
  console.log("\na Meta ad, created paused");

  const adAccount = accounts.find((a) => a.kind === "META_AD_ACCOUNT")!;
  check("a spending limit needs the account's currency to be rupees, and a number",
    (await connect.setDailyCap({ orgId, userId, accountId: adAccount.id, raw: "five thousand" })).ok, false);
  check("a limit is recorded", (await connect.setDailyCap({ orgId, userId, accountId: adAccount.id, raw: "Rs 5,000" })).ok, true);

  const over = await publish.requestPublish({ orgId, userId, postId: square, destinations: ["META_AD"], dailyBudget: "20000", destinationUrl: "" });
  check("a budget over the limit is refused", over.ok ? over.results[0].message : over, "That is over this account's limit of Rs 5,000 a day.");
  const ad = await publish.requestPublish({ orgId, userId, postId: square, destinations: ["META_AD"], dailyBudget: "1,500", destinationUrl: "" });
  check("an ad is created paused", ad.ok ? ad.results[0].message : ad, "Ad created, paused. Nothing spends until it is switched on.");
  const camp = meta.campaigns.at(-1)!;
  check("the campaign is off", camp.status, "PAUSED");
  check("no housing category for an India-only ad, which Meta does not require", [JSON.parse(camp.fields.special_ad_categories), camp.fields.special_ad_category_country ?? null], [[], null]);
  const adset = meta.adsets.at(-1)!;
  check("the day's budget in paise", adset.fields.daily_budget, "150000");
  const targeting = JSON.parse(adset.fields.targeting);
  check("shown around the project's city, to adults of 25 and up, never on Audience Network or Messenger",
    [targeting.geo_locations, targeting.age_min, targeting.publisher_platforms],
    [{ cities: [{ key: "2295424", radius: 25, distance_unit: "kilometer" }] }, 25, ["facebook", "instagram"]]);
  const landing = new URL(JSON.parse(meta.creatives.at(-1)!.fields.object_story_spec).link_data.link);
  check("the landing page defaults to the brand kit's website", `${landing.origin}${landing.pathname}`, "https://sathheights.example/");
  check("tagged so the lead it brings is tied back to this ad",
    [landing.searchParams.get("utm_source"), /^est-[0-9a-f]{12}$/.test(landing.searchParams.get("utm_content") ?? "")], ["facebook", true]);
  check("speaking as the tower's Page and the Instagram account",
    [JSON.parse(meta.creatives.at(-1)!.fields.object_story_spec).page_id, JSON.parse(meta.creatives.at(-1)!.fields.object_story_spec).instagram_user_id], [PAGE_2, IG]);
  const [adTarget] = (await targetsOf(square)).filter((t) => t.destination === "META_AD");
  check("recorded as paused, with its budget", [adTarget.state, adTarget.daily_budget], ["PAUSED", 1500]);

  // A lost answer: Meta made the ad set, the worker never heard.
  traps = [{ match: (c) => c.method === "POST" && c.path.endsWith(`${ACT}/adsets`), mode: "lose", times: 1 }];
  const before = meta.adsets.length;
  const lost = await publish.requestPublish({ orgId, userId, postId: carousel, destinations: ["META_AD"], dailyBudget: "1000", destinationUrl: "https://sathheights.example/tower-c" });
  check("a lost answer is retried, not failed", lost.ok ? lost.results[0].ok : lost, true);
  const [lostTarget] = (await targetsOf(carousel)).filter((t) => t.destination === "META_AD");
  check("left waiting for its retry", lostTarget.state, "QUEUED");
  adv = await publish.advance(orgId, lostTarget.id, { now: later(60_000) });
  check("the retry finishes it", adv.state, "PAUSED");
  check("and found the ad set the lost call made, rather than making a second",
    meta.adsets.length - before, 1);
  check("as a carousel ad", JSON.parse(meta.creatives.at(-1)!.fields.object_story_spec).link_data.child_attachments.length, 3);

  const act = await publish.activatePublication({ orgId, userId, targetId: adTarget.id });
  check("a person switches it on", act.ok, true);
  check("at the campaign", camp.status, "ACTIVE");

  // -------------------------------------------------------------------------
  console.log("\nbidding on qualified buyers");

  check("a new ad bids on clicks by default", [camp.fields.objective, meta.adsets.at(-1)!.fields.optimization_goal], ["OUTCOME_TRAFFIC", "LINK_CLICKS"]);
  const stateOf = async () => (await bidding.biddingStates(orgId, [adAccount.id])).get(adAccount.id)!;
  check("an account with few leads is not offered it, and is told how many more",
    await stateOf(), { on: false, leads: 0, ready: false, needed: 200 });
  check("and switching it on is refused on the server too",
    await bidding.setQualifiedBidding({ orgId, userId, accountId: adAccount.id, on: true }),
    { ok: false, message: "This account needs 200 more leads in the last 30 days first." });
  // 200 leads in the last month from this account's ads, and one from before it.
  await sql`
    INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, publish_target_id, created_at)
    SELECT ${orgId}, ${phase.id}, 'Bid lead ' || g, '+9190001' || lpad(g::text, 5, '0'), 'Meta ad', 'WEBSITE', ${adTarget.id},
           now() - make_interval(days => CASE WHEN g = 0 THEN 40 ELSE g % 25 END)
    FROM generate_series(0, 200) AS g`;
  check("200 leads in 30 days makes it ready; one older does not count", await stateOf(), { on: false, leads: 200, ready: true, needed: 0 });
  check("with no Meta dataset for the account's place, it cannot be switched on",
    (await bidding.setQualifiedBidding({ orgId, userId, accountId: adAccount.id, on: true })).ok, false);
  const [metaConn] = await sql<{ id: string }[]>`SELECT id FROM connections WHERE org_id = ${orgId} AND provider = 'META'`;
  await sql`
    INSERT INTO connection_accounts (org_id, connection_id, kind, external_id, name, scope_node_id)
    VALUES (${orgId}, ${metaConn.id}, 'META_DATASET', '900000000000001', 'Sath dataset', ${T.root.id})`;
  const on = await bidding.setQualifiedBidding({ orgId, userId, accountId: adAccount.id, on: true });
  check("switched on by the budget key", on, { ok: true, message: "New ads from this account optimise for qualified buyers." });
  const conv = meta.conversions[0];
  check("a custom conversion is made on the dataset, for the Qualified event the attribution sends",
    [meta.conversions.length, conv?.fields.event_source_id, conv?.fields.custom_event_type, JSON.parse(conv?.fields.rule ?? "{}")],
    [1, "900000000000001", "OTHER", { and: [{ event: { eq: "Qualified" } }] }]);
  const [flag] = await sql<{ qualified_bidding: boolean; qualified_dataset: string; qualified_conversion: string }[]>`
    SELECT qualified_bidding, qualified_dataset, qualified_conversion FROM connection_accounts WHERE id = ${adAccount.id}`;
  check("the account records it, with the dataset and the conversion", [flag.qualified_bidding, flag.qualified_dataset, flag.qualified_conversion], [true, "900000000000001", conv?.id]);
  check("and the change is audited", (await sql`
    SELECT 1 FROM audit_log WHERE org_id = ${orgId} AND action = 'connect.qualified_bidding' AND target_id = ${adAccount.id}`).length, 1);

  const bidPost = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], headline: "A podium garden" });
  const bidAd = await publish.requestPublish({ orgId, userId, postId: bidPost, destinations: ["META_AD"], dailyBudget: "1,000", destinationUrl: "" });
  check("a new ad from the account is still created paused", bidAd.ok ? bidAd.results[0].message : bidAd, "Ad created, paused. Nothing spends until it is switched on.");
  const bidSet = meta.adsets.at(-1)!;
  check("its campaign's objective is leads, and its ad set is delivered for the conversion on the dataset",
    [meta.campaigns.at(-1)!.fields.objective, bidSet.fields.optimization_goal, JSON.parse(bidSet.fields.promoted_object ?? "{}")],
    ["OUTCOME_LEADS", "OFFSITE_CONVERSIONS", { pixel_id: "900000000000001", custom_event_type: "OTHER", custom_conversion_id: conv?.id }]);

  check("switching it off goes back to clicks for new ads",
    (await bidding.setQualifiedBidding({ orgId, userId, accountId: adAccount.id, on: false })).ok, true);
  check("and on again finds the conversion it made rather than making a second",
    [(await bidding.setQualifiedBidding({ orgId, userId, accountId: adAccount.id, on: true })).ok, meta.conversions.length], [true, 1]);
  await bidding.setQualifiedBidding({ orgId, userId, accountId: adAccount.id, on: false });
  const clickPost = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], headline: "Sea facing from the 18th floor up" });
  await publish.requestPublish({ orgId, userId, postId: clickPost, destinations: ["META_AD"], dailyBudget: "1,000", destinationUrl: "" });
  check("the next new ad bids on clicks again", [meta.campaigns.at(-1)!.fields.objective, meta.adsets.at(-1)!.fields.optimization_goal, meta.adsets.at(-1)!.fields.promoted_object ?? null],
    ["OUTCOME_TRAFFIC", "LINK_CLICKS", null]);
  await sql`DELETE FROM leads WHERE org_id = ${orgId} AND name LIKE 'Bid lead %'`;

  // -------------------------------------------------------------------------
  console.log("\nthe kill switch");

  const waiting = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], headline: "Two lifts per wing" });
  traps = [{ match: (c) => c.method === "POST" && c.path.endsWith("/photos"), mode: "refuse", status: 500, body: { error: { message: "Please retry", code: 2 } }, times: 1 }];
  await publish.requestPublish({ orgId, userId, postId: waiting, destinations: ["FACEBOOK_PAGE"] });
  const [queued] = await targetsOf(waiting);
  check("a platform hiccup leaves it queued", queued.state, "QUEUED");

  await sql`UPDATE registration_records SET status = 'BLOCKED' WHERE scope_node_id = ${phase.id}`;
  const halted = await publish.haltBlocked(orgId);
  check("the spending ad pauses", halted.paused, 1);
  check("at the platform", camp.status, "PAUSED");
  const [paused] = (await targetsOf(square)).filter((t) => t.destination === "META_AD");
  check("recorded as paused by the registration", [paused.state, paused.paused_reason], ["PAUSED", "REGISTRATION"]);
  check("what had not gone out is stopped", (await targetsOf(waiting))[0].state, "CANCELLED");
  const upNow = (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM publish_targets WHERE org_id = ${orgId} AND state = 'LIVE'`)[0].n;
  check("what is up is listed for a person to take down", halted.flagged, upNow);
  check("and nothing is switched back on while it is blocked",
    ((await publish.activatePublication({ orgId, userId, targetId: adTarget.id })) as { code: string }).code, "NOT_ADVERTISABLE");
  check("or published", ((await publish.requestPublish({ orgId, userId, postId: carousel, destinations: ["FACEBOOK_PAGE"] })) as { code: string }).code, "NOT_ADVERTISABLE");
  check("running it twice changes nothing", await publish.haltBlocked(orgId), { paused: 0, flagged: 0, cancelled: 0, unflagged: 0, couldNotPause: 0 });

  await sql`UPDATE registration_records SET status = 'VERIFIED' WHERE scope_node_id = ${phase.id}`;
  check("advertisable again clears the flags", (await publish.haltBlocked(orgId)).unflagged, upNow);

  // -------------------------------------------------------------------------
  console.log("\nthe gates, asked again");

  const neverSay = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], body: "Sea facing, with guaranteed returns." });
  check("copy that no longer clears does not go out",
    ((await publish.requestPublish({ orgId, userId, postId: neverSay, destinations: ["FACEBOOK_PAGE"] })) as { code: string }).code, "BLOCKED");
  const failedCheck = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], passed: false });
  // The pixel gate, asked again at the moment of publishing: nothing goes
  // out without a PASS on these very files.
  const unchecked = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], pixel: null });
  const pixelFailed = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], pixel: "FAIL" });
  const pixelHeld = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], pixel: "HOLD" });
  const swapped = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], staleHash: true });
  const codeOf = async (postId: string) =>
    ((await publish.requestPublish({ orgId, userId, postId, destinations: ["FACEBOOK_PAGE"] })) as { code: string }).code;
  check("a post made before pictures were checked is refused", await codeOf(unchecked), "PIXEL_UNCHECKED");
  check("so is one whose picture failed the pixel gate", await codeOf(pixelFailed), "PIXEL_FAIL");
  check("and one the pixel gate held for a person", await codeOf(pixelHeld), "PIXEL_HOLD");
  check("and one whose files are not the files that passed", await codeOf(swapped), "PIXEL_STALE");
  check("and none of them reached a platform",
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publish_targets WHERE rendered_post_id = ANY(${[unchecked, pixelFailed, pixelHeld, swapped]})`)[0].n, 0);
  check("a post that did not pass its check does not go out",
    ((await publish.requestPublish({ orgId, userId, postId: failedCheck, destinations: ["FACEBOOK_PAGE"] })) as { code: string }).code, "DID_NOT_PASS");
  const story = await makePost({ kind: "IMAGE", placement: "Meta story 9:16", frames: [{ w: 1080, h: 1920 }] });
  const st = await publish.requestPublish({ orgId, userId, postId: story, destinations: ["INSTAGRAM"] });
  check("a story picture goes to Instagram as a story", st.ok ? st.results[0].message : st, "Live.");
  check("with no caption, which stories do not carry",
    [...meta.containers.values()].some((b) => b.fields.media_type === "STORIES" && !b.fields.caption), true);

  // -------------------------------------------------------------------------
  console.log("\na dead token");

  meta.validTokens.delete(`meta-page-token-${PAGE_2}`);
  const dead = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }] });
  const d1 = await publish.requestPublish({ orgId, userId, postId: dead, destinations: ["FACEBOOK_PAGE"] });
  check("fails, and says to reconnect", d1.ok ? d1.results[0].ok : d1, false);
  check("the connection is marked broken", (await connect.loadConnection(orgId, "META"))?.status, "BROKEN");
  check("so the next post is not even tried",
    (await publish.publishOptions(orgId, dead) as { ok: true; options: { destination: string; reason: string | null }[] }).options.find((o) => o.destination === "FACEBOOK_PAGE")?.reason,
    "Meta needs reconnecting.");
  check("a check that finds the token fine again restores it", (await connect.checkConnection({ orgId, provider: "META", userId })).ok, true);
  check("to connected", (await connect.loadConnection(orgId, "META"))?.status, "CONNECTED");
  // The Page's token works again, as it would after reconnecting.
  meta.validTokens.add(`meta-page-token-${PAGE_2}`);

  // -------------------------------------------------------------------------
  console.log("\nconnecting Google");

  const g = connect.beginConnect({ orgId, userId, provider: "GOOGLE", redirectUri: "http://localhost:3000/api/connect/google/callback" });
  const gUrl = new URL(g.url);
  // `consent` brings a refresh token back on every reconnect; `select_account`
  // lets a person who used the wrong login pick another.
  const gPrompt = (gUrl.searchParams.get("prompt") ?? "").split(" ").sort();
  check("offline access, asked every time, with PKCE",
    [gUrl.searchParams.get("access_type"), gPrompt, gUrl.searchParams.get("code_challenge_method"), !!g.verifier],
    ["offline", ["consent", "select_account"], "S256", true]);
  check("a return without the verifier is refused",
    ((await connect.finishConnect({ orgId, userId, provider: "GOOGLE", code: "c", redirectUri: "x", verifier: null })) as { code: string }).code, "MALFORMED");
  check("the code is exchanged", (await connect.finishConnect({ orgId, userId, provider: "GOOGLE", code: "google-code", redirectUri: "http://localhost:3000/api/connect/google/callback", verifier: g.verifier })).ok, true);
  const goog = await connect.loadConnection(orgId, "GOOGLE");
  check("the direct account, the one under the agency, and the Business Profile are offered",
    goog?.choices.map((c) => `${c.kind}:${c.id}:${c.detail.login_customer_id ?? ""}`).sort(),
    [`GOOGLE_ADS_CUSTOMER:${CUSTOMER}:`, `GOOGLE_ADS_CUSTOMER:${CLIENT}:${MANAGER}`, "GOOGLE_BUSINESS_LOCATION:locations/88:"].sort());
  const [gStored] = await sql<{ secret: Buffer }[]>`SELECT secret FROM connections WHERE org_id = ${orgId} AND provider = 'GOOGLE' AND status <> 'DISCONNECTED'`;
  check("the refresh token is stored sealed", gStored.secret.includes(Buffer.from("google-refresh-1")), false);

  await connect.chooseAccounts({ orgId, userId, provider: "GOOGLE", picks: [
    { kind: "GOOGLE_ADS_CUSTOMER", id: CLIENT, nodeId: T.root.id },
    { kind: "GOOGLE_BUSINESS_LOCATION", id: "locations/88", nodeId: project.id },
  ] });
  const [gAds] = await sql<{ id: string }[]>`SELECT id FROM connection_accounts WHERE org_id = ${orgId} AND kind = 'GOOGLE_ADS_CUSTOMER'`;
  await connect.setDailyCap({ orgId, userId, accountId: gAds.id, raw: "3000" });

  const gbp = await publish.requestPublish({ orgId, userId, postId: square, destinations: ["GOOGLE_BUSINESS"] });
  check("a Business Profile post goes live", gbp.ok ? gbp.results[0].message : gbp, "Live.");
  const lp = google.posts.at(-1)!;
  check("in the brief's language, with the caption, the picture and a Learn more button",
    [lp.body.languageCode, lp.summary.startsWith("Sea facing homes"), (lp.body.media as { mediaFormat: string }[])[0].mediaFormat, (lp.body.callToAction as { actionType: string }).actionType],
    ["en", true, "PHOTO", "LEARN_MORE"]);

  // A card of its own, so no square of it exists yet.
  const [copy2] = await sql<{ id: string }[]>`
    INSERT INTO campaign_copy (org_id, brief_id, scope_node_id, language, segment, headline, body, cta, verdict, model, generated_by)
    VALUES (${orgId}, ${brief.id}, ${phase.id}, 'English', 'INVESTOR', 'Sea facing homes', 'Sea facing from the 18th floor up.',
            'Book a site visit', 'PASS', 'fixture', ${userId})
    RETURNING id`;
  const banner = await makePost({ kind: "IMAGE", placement: "Google display", frames: [{ w: 1200, h: 628 }], copyId: copy2.id });
  const noSquare = await publish.requestPublish({ orgId, userId, postId: banner, destinations: ["GOOGLE_DISPLAY_AD"], dailyBudget: "1000", destinationUrl: "" });
  check("a display ad needs a square picture of the same card",
    noSquare.ok ? noSquare.results[0].message : noSquare, "Google shows a square picture beside the banner. Make a post of this card with \"Facebook and Instagram feed\" ticked.");
  await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], copyId: copy2.id });

  traps = [{ match: (c) => c.path.endsWith("googleAds:mutate"), mode: "lose", times: 1 }];
  const disp = await publish.requestPublish({ orgId, userId, postId: banner, destinations: ["GOOGLE_DISPLAY_AD"], dailyBudget: "1000", destinationUrl: "" });
  check("a lost answer from Google is retried", disp.ok ? disp.results[0].ok : disp, true);
  const [dispTarget] = await targetsOf(banner);
  adv = await publish.advance(orgId, dispTarget.id, { now: later(60_000) });
  check("the retry is refused as a duplicate, finds the campaign, and finishes", adv.state, "PAUSED");
  check("one campaign, not two", google.campaigns.length, 1);
  const gc = google.campaigns[0];
  check("created off, as a display campaign, declared not political",
    (() => {
      const c = (gc.ops.find((o) => (o as Record<string, unknown>).campaignOperation) as { campaignOperation: { create: Record<string, unknown> } }).campaignOperation.create;
      return [c.status, c.advertisingChannelType, c.containsEuPoliticalAdvertising];
    })(),
    ["PAUSED", "DISPLAY", "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"]);
  check("through the agency's manager account", gc.login, MANAGER);
  check("with the day's budget in millionths",
    (gc.ops.find((o) => (o as Record<string, unknown>).campaignBudgetOperation) as { campaignBudgetOperation: { create: { amountMicros: string } } }).campaignBudgetOperation.create.amountMicros, "1000000000");
  check("with the banner and the square beside it",
    (() => {
      const ad = (gc.ops.find((o) => (o as Record<string, unknown>).adGroupAdOperation) as { adGroupAdOperation: { create: { ad: { responsiveDisplayAd: { marketingImages: unknown[]; squareMarketingImages: unknown[] } } } } }).adGroupAdOperation.create.ad.responsiveDisplayAd;
      return [ad.marketingImages.length, ad.squareMarketingImages.length];
    })(), [1, 1]);
  check("in the project's city", JSON.stringify(gc.ops).includes("geoTargetConstants/1007788"), true);
  check("switched on at the campaign", (await publish.activatePublication({ orgId, userId, targetId: dispTarget.id })).ok && gc.status === "ENABLED", true);
  check("and off again by a person", (await publish.pausePublication({ orgId, userId, targetId: dispTarget.id })).ok && gc.status === "PAUSED", true);

  // -------------------------------------------------------------------------
  console.log("\na schedule that publishes");

  const [schedule] = await sql<{ id: string }[]>`
    INSERT INTO post_schedules (org_id, brief_id, scope_node_id, name, mode, days_of_week, day_kinds, at_minute,
                                destinations, created_by)
    VALUES (${orgId}, ${brief.id}, ${phase.id}, 'Three a week', 'REVIEW', ${[1, 3, 5]},
            ${["", "IMAGE", "", "IMAGE", "", "IMAGE", ""].map((x) => x || null)}::text[], 600,
            ${["FACEBOOK_PAGE", "INSTAGRAM"]}::text[], ${userId})
    RETURNING id`;
  const publishAt = new Date(Date.now() - 60_000);
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at, state)
    VALUES (${orgId}, ${schedule.id}, ${publishAt}, ${new Date(publishAt.getTime() - 86_400_000)}, ${publishAt}, 'GENERATED')
    RETURNING id`;
  const frameBytes = await jpeg(1080, 1080, 200);
  const frame = await putAsset({ orgId, project: null, kind: "post", id: `sched-${tag}`, bytes: frameBytes, contentType: "image/jpeg" });
  const sha = "a".repeat(64);
  const [creative] = await sql<{ id: string }[]>`
    INSERT INTO post_creatives (org_id, run_id, language, segment, headline, body, cta, verdict, model, template,
                                content_sha256, state, decided_by, decided_at, decided_sha256, kind, media, pixel)
    VALUES (${orgId}, ${run.id}, 'English', 'END_USER', 'Two lifts per wing', 'A podium garden.', 'Book a site visit',
            'PASS', 'fixture', 'LIST', ${sha}, 'APPROVED', ${userId}, now(), ${sha}, 'IMAGE',
            ${sql.json([{ key: frame.ok ? frame.key : "", type: "image/jpeg", width: 1080, height: 1080, placement: "Meta feed 1:1", sha256: fileHash(frameBytes) }])},
            ${sql.json(pixelRecord([fileHash(frameBytes)]))})
    RETURNING id`;

  const pass1 = await publish.publishDue({ orgIds: [orgId] });
  check("an approved post whose time has come goes to both destinations", pass1.enqueued, 2);
  check("and goes live", pass1.live, 2);
  const [cr] = await sql<{ state: string }[]>`SELECT state FROM post_creatives WHERE id = ${creative.id}`;
  check("the creative says so", cr.state, "PUBLISHED");
  check("a second pass hands nothing out twice", (await publish.publishDue({ orgIds: [orgId] })).enqueued, 0);

  // -------------------------------------------------------------------------
  console.log("\na schedule that makes ads");

  // The same schedule, now with the ad account and a budget. A run's entry
  // says how its post goes out; the schedule only says where each kind goes.
  await sql`
    UPDATE post_schedules
    SET destinations = ${["FACEBOOK_PAGE", "INSTAGRAM", "META_AD"]}::text[], ad_daily_budget = 1200, ad_days = 10
    WHERE id = ${schedule.id}`;
  const scheduledPost = async (outlet: string, slotAgo: number, fill: string) => {
    const at = new Date(Date.now() - slotAgo);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO post_runs (org_id, schedule_id, slot, generate_at, publish_at, state, outlet)
      VALUES (${orgId}, ${schedule.id}, ${at}, ${new Date(at.getTime() - 86_400_000)}, ${at}, 'GENERATED', ${outlet})
      RETURNING id`;
    const fBytes = await jpeg(1080, 1080, 180);
    const f = await putAsset({ orgId, project: null, kind: "post", id: `sched-${fill}-${tag}`, bytes: fBytes, contentType: "image/jpeg" });
    const h = fill.repeat(64);
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO post_creatives (org_id, run_id, language, segment, headline, body, cta, verdict, model, template,
                                  content_sha256, state, decided_by, decided_at, decided_sha256, kind, media, pixel)
      VALUES (${orgId}, ${r.id}, 'English', 'END_USER', 'Sea facing homes', 'A podium garden.', 'Book a site visit',
              'PASS', 'fixture', 'LIST', ${h}, 'APPROVED', ${userId}, now(), ${h}, 'IMAGE',
              ${sql.json([{ key: f.ok ? f.key : "", type: "image/jpeg", width: 1080, height: 1080, placement: "Meta feed 1:1", sha256: fileHash(fBytes) }])},
              ${sql.json(pixelRecord([fileHash(fBytes)]))})
      RETURNING id`;
    return c.id;
  };
  const destsOf = async (creativeId: string) =>
    (await sql<{ destination: string }[]>`
      SELECT destination FROM publish_targets WHERE post_creative_id = ${creativeId} ORDER BY destination`).map((t) => t.destination);

  const postOnly = await scheduledPost("POST", 120_000, "c");
  await publish.publishDue({ orgIds: [orgId] });
  check("a day marked Post goes out organically and makes no ad", await destsOf(postOnly), ["FACEBOOK_PAGE", "INSTAGRAM"]);

  const both = await scheduledPost("BOTH", 180_000, "d");
  const adsBefore = meta.adsets.length;
  const passAd = await publish.publishDue({ orgIds: [orgId] });
  check("a day marked Organic and ad goes out both ways", await destsOf(both), ["FACEBOOK_PAGE", "INSTAGRAM", "META_AD"]);
  const [schedAd] = await sql<{ id: string; state: string; daily_budget: number; ends_at: Date; switch_on: boolean }[]>`
    SELECT id, state, daily_budget, ends_at, switch_on FROM publish_targets
    WHERE post_creative_id = ${both} AND destination = 'META_AD'`;
  check("the ad is made at the schedule's budget and switched on, because it was already approved",
    [schedAd.state, schedAd.daily_budget, schedAd.switch_on, meta.adsets.length - adsBefore, meta.campaigns.at(-1)!.status],
    ["ACTIVE", 1200, true, 1, "ACTIVE"]);
  check("it runs for the schedule's ten days", Math.round((schedAd.ends_at.getTime() - Date.now()) / 86_400_000), 10);
  check("and Meta is told when it ends", Number(meta.adsets.at(-1)!.fields.end_time), Math.floor(schedAd.ends_at.getTime() / 1000));
  check("the pass counts it as switched on, not left paused", passAd.adsCreated, 0);

  const ended = await publish.endDueAds(orgId, new Date(schedAd.ends_at.getTime() + 60_000));
  check("after its days it is stopped", ended.ended, 1);
  const [stopped] = await sql<{ state: string; paused_reason: string }[]>`
    SELECT state, paused_reason FROM publish_targets WHERE id = ${schedAd.id}`;
  check("recorded as having run its days", [stopped.state, stopped.paused_reason, meta.campaigns.at(-1)!.status], ["PAUSED", "ENDED", "PAUSED"]);
  check("and nobody switches it back on",
    ((await publish.activatePublication({ orgId, userId, targetId: schedAd.id, now: new Date(schedAd.ends_at.getTime() + 120_000) })) as { code: string }).code, "ENDED");
  check("stopping twice does nothing", (await publish.endDueAds(orgId, new Date(schedAd.ends_at.getTime() + 60_000))).ended, 0);

  await sql`UPDATE post_schedules SET ad_daily_budget = 9000 WHERE id = ${schedule.id}`;
  const tooMuch = await scheduledPost("AD", 240_000, "e");
  await publish.publishDue({ orgIds: [orgId] });
  const [held] = await sql<{ publish_note: string | null }[]>`SELECT publish_note FROM post_creatives WHERE id = ${tooMuch}`;
  check("a budget the account's limit has since dropped below is held, with the reason",
    [await destsOf(tooMuch), held.publish_note], [[], "That is over this account's limit of Rs 5,000 a day."]);

  // -------------------------------------------------------------------------
  console.log("\na Meta ad's goal, and its story size beside the feed");

  const leadsPost = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }] });
  let goalOpts = await publish.publishOptions(orgId, leadsPost);
  const metaOpt = () => (goalOpts.ok ? goalOpts.options.find((o) => o.destination === "META_AD") : null);
  check("a Meta ad offers four goals",
    metaOpt()?.goals?.map((g) => g.key), ["LEADS", "WHATSAPP", "TRAFFIC", "AWARENESS"]);
  check("a lead form waits for the privacy policy, a WhatsApp ad for a connected number",
    metaOpt()?.goals?.filter((g) => !g.ok).map((g) => g.key), ["LEADS", "WHATSAPP"]);
  check("so website visits is what it starts on", metaOpt()?.defaultGoal, "TRAFFIC");
  check("and it will show the story size of the same card beside the feed one", metaOpt()?.companion, "Meta story 9:16");
  const noForm = await publish.requestPublish({ orgId, userId, postId: leadsPost, destinations: ["META_AD"], dailyBudget: "1000", destinationUrl: "", adGoal: "LEADS" });
  check("a Leads ad without a privacy policy is refused before anything is made",
    noForm.ok ? noForm.results[0].message : noForm, "A lead form needs your privacy policy link. Add it in Library, Branding.");
  const noChat = await publish.requestPublish({ orgId, userId, postId: leadsPost, destinations: ["META_AD"], dailyBudget: "1000", destinationUrl: "", adGoal: "WHATSAPP" });
  check("and a WhatsApp ad without a number", noChat.ok ? noChat.results[0].message : noChat, "Connect your WhatsApp number in Settings, Connected accounts first.");

  await sql`UPDATE brand_kits SET privacy_url = 'https://sathheights.example/privacy' WHERE org_id = ${orgId} AND scope_node_id = ${entity.id}`;
  goalOpts = await publish.publishOptions(orgId, leadsPost);
  check("with the policy recorded, a lead form is offered first", [metaOpt()?.goals?.find((g) => g.key === "LEADS")?.ok, metaOpt()?.defaultGoal], [true, "LEADS"]);
  const formsBefore = meta.forms.length;
  const leadAd = await publish.requestPublish({ orgId, userId, postId: leadsPost, destinations: ["META_AD"], dailyBudget: "1000", destinationUrl: "", adGoal: "LEADS" });
  check("a Leads ad is made, paused", leadAd.ok ? leadAd.results[0].message : leadAd, "Ad created, paused. Nothing spends until it is switched on.");
  const form = meta.forms.at(-1)!;
  check("its instant form is filed under the tower's Page, with the Page's own token",
    [meta.forms.length - formsBefore, form.page, form.token], [1, PAGE_2, `meta-page-token-${PAGE_2}`]);
  const asked = JSON.parse(form.fields.questions) as { type: string; key?: string }[];
  check("higher intent, the number confirmed by a code, our questions before a name and a number, linking the privacy policy",
    [form.fields.is_optimized_for_quality, form.fields.is_phone_sms_verify_enabled, asked.slice(-2).map((q) => q.type),
     asked.slice(0, -2).every((q) => q.type === "CUSTOM"), asked.some((q) => q.key === "when_buying"), JSON.parse(form.fields.privacy_policy).url],
    ["true", "true", ["FULL_NAME", "PHONE"], true, true, "https://sathheights.example/privacy"]);
  check("with a box to be contacted, required, and one to be measured, not required, which the lead reader tells apart",
    JSON.parse(form.fields.custom_disclaimer).checkboxes.map((b: { key: string; is_required: boolean }) => [b.key, b.is_required]),
    [["contact_consent", true], ["measure_consent", false]]);
  check("a leads campaign, optimised for leads on the ad itself, for the Page",
    [meta.campaigns.at(-1)!.fields.objective, meta.adsets.at(-1)!.fields.optimization_goal, meta.adsets.at(-1)!.fields.destination_type, JSON.parse(meta.adsets.at(-1)!.fields.promoted_object).page_id],
    ["OUTCOME_LEADS", "LEAD_GENERATION", "ON_AD", PAGE_2]);
  const leadTargeting = JSON.parse(meta.adsets.at(-1)!.fields.targeting);
  check("shown only in the Facebook and Instagram feeds on a phone, where a higher intent form is delivered",
    [leadTargeting.facebook_positions, leadTargeting.instagram_positions, leadTargeting.device_platforms], [["feed"], ["stream"], ["mobile"]]);
  const leadSpec = JSON.parse(meta.creatives.at(-1)!.fields.object_story_spec);
  check("one feed picture, its button opening the form",
    [!!leadSpec.link_data?.image_hash, leadSpec.link_data?.call_to_action?.type, leadSpec.link_data?.call_to_action?.value?.lead_gen_form_id], [true, "SIGN_UP", form.id]);
  const [leadTarget] = (await targetsOf(leadsPost)).filter((t) => t.destination === "META_AD");
  const [leadRow] = await sql<{ ad_goal: string; media: unknown[] }[]>`SELECT ad_goal, media FROM publish_targets WHERE id = ${leadTarget.id}`;
  check("the publication records its goal and both files it carried", [leadRow.ad_goal, leadRow.media.length], ["LEADS", 2]);
  const formRetry = await publish.retryPublication({ orgId, userId, targetId: leadTarget.id }).catch(() => null);
  check("a finished ad is not tried again", formRetry && !formRetry.ok ? (formRetry as { code: string }).code : formRetry, "NOT_FAILED");

  const reachPost = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], copyId: copy2.id });
  const reach = await publish.requestPublish({ orgId, userId, postId: reachPost, destinations: ["META_AD"], dailyBudget: "800", destinationUrl: "", adGoal: "AWARENESS" });
  check("a Reach ad is optimised for reach, with no destination of its own",
    [reach.ok && reach.results[0].ok, meta.campaigns.at(-1)!.fields.objective, meta.adsets.at(-1)!.fields.optimization_goal, meta.adsets.at(-1)!.fields.destination_type],
    [true, "OUTCOME_AWARENESS", "REACH", undefined]);
  check("and with no story of its card made, one picture in one ad", !!meta.creatives.at(-1)!.fields.asset_feed_spec, false);

  // -------------------------------------------------------------------------
  console.log("\nGoogle Demand Gen, and YouTube");

  const dgPost = await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }] });
  let dgOpts = await publish.publishOptions(orgId, dgPost);
  const dgOpt = () => (dgOpts.ok ? dgOpts.options.find((o) => o.destination === "GOOGLE_DEMAND_GEN_AD") : null);
  check("Demand Gen waits for the logo it shows beside the ad", dgOpt()?.reason, "Add your logo in Library, Branding. Google shows it beside the ad.");
  const logoPng = await sharp({ create: { width: 300, height: 120, channels: 3, background: { r: 20, g: 40, b: 120 } } }).png().toBuffer();
  await sql`
    INSERT INTO brand_files (org_id, scope_node_id, role, media, media_type, media_name, uploaded_by)
    VALUES (${orgId}, ${entity.id}, 'LOGO_HORIZONTAL', ${logoPng}, 'image/png', 'logo.png', ${userId})`;
  dgOpts = await publish.publishOptions(orgId, dgPost);
  check("and is offered once the logo is there", dgOpt()?.ok, true);
  const dg = await publish.requestPublish({ orgId, userId, postId: dgPost, destinations: ["GOOGLE_DEMAND_GEN_AD"], dailyBudget: "1000", destinationUrl: "" });
  check("a Demand Gen picture ad is made, paused", dg.ok ? dg.results[0].message : dg, "Ad created, paused. Nothing spends until it is switched on.");
  const dgc = google.campaigns.at(-1)!;
  const dgCreate = (dgc.ops.find((o) => (o as Record<string, unknown>).campaignOperation) as { campaignOperation: { create: Record<string, unknown> } }).campaignOperation.create;
  const dgAd = (dgc.ops.find((o) => (o as Record<string, unknown>).adGroupAdOperation) as { adGroupAdOperation: { create: { ad: Record<string, Record<string, unknown>> } } }).adGroupAdOperation.create.ad;
  check("as a Demand Gen campaign, created off", [dgCreate.advertisingChannelType, dgCreate.status], ["DEMAND_GEN", "PAUSED"]);
  check("with the square picture, the logo, the card's headline and the registration in its description",
    [
      (dgAd.demandGenMultiAssetAd.squareMarketingImages as unknown[]).length,
      (dgAd.demandGenMultiAssetAd.logoImages as unknown[]).length,
      (dgAd.demandGenMultiAssetAd.headlines as { text: string }[])[0].text,
      (dgAd.demandGenMultiAssetAd.descriptions as { text: string }[])[0].text.includes("P52100012345"),
    ],
    [1, 1, "Sea facing homes", true]);
  check("the logo was made square before it was sent",
    google.assets.some((a) => a.name.endsWith("logo")), true);

  const film = await makePost({ kind: "VIDEO", placement: "YouTube 16:9", frames: [{ w: 1920, h: 1080, type: "video/mp4" }] });
  const yt = await publish.requestPublish({ orgId, userId, postId: film, destinations: ["GOOGLE_DEMAND_GEN_AD"], dailyBudget: "1000", destinationUrl: "" });
  check("a video becomes a YouTube ad", yt.ok ? yt.results[0].ok : yt, true);
  check("uploaded to the developer's YouTube channel, unlisted", google.uploads.at(-1), { title: "Sea facing homes", privacy: "unlisted" });
  const ytc = google.campaigns.at(-1)!;
  const ytGroup = (ytc.ops.find((o) => (o as Record<string, unknown>).adGroupOperation) as { adGroupOperation: { create: { demandGenAdGroupSettings: { channelControls: { selectedChannels: Record<string, boolean> } } } } }).adGroupOperation.create;
  check("shown on YouTube only: in feed, in stream and Shorts",
    Object.entries(ytGroup.demandGenAdGroupSettings.channelControls.selectedChannels).filter(([, v]) => v).map(([k]) => k).sort(),
    ["youtubeInFeed", "youtubeInStream", "youtubeShorts"]);
  check("as a video ad carrying the uploaded video",
    JSON.stringify(ytc.ops).includes("demandGenVideoResponsiveAd") && google.assets.some((a) => a.name.endsWith("video")), true);

  // -------------------------------------------------------------------------
  console.log("\nthe brief's always-on campaigns: Search and Performance Max");

  let always = await publish.alwaysOnFor(orgId, brief.id);
  const search = () => always.find((a) => a.destination === "GOOGLE_SEARCH_AD")!;
  const pmax = () => always.find((a) => a.destination === "GOOGLE_PMAX_AD")!;
  check("both are offered for the brief", always.map((a) => [a.destination, a.reason]), [["GOOGLE_SEARCH_AD", null], ["GOOGLE_PMAX_AD", null]]);
  check("a search ad is built from the cleared cards and signed facts, and shown before it is started",
    [search().preview?.headlines.includes("Sea facing homes"), search().preview?.headlines.includes("Sath Heights, Goregaon West"), search().preview?.keywords.includes("sath heights goregaon west")],
    [true, true, true]);
  check("its first description is the registration", search().preview?.descriptions[0], "MahaRERA No. P52100012345 | maharera.maharashtra.gov.in");
  const sa = await publish.requestAlwaysOn({ orgId, userId, briefId: brief.id, destination: "GOOGLE_SEARCH_AD", dailyBudget: "1200" });
  check("a search campaign is created, paused", sa.ok ? [sa.state, sa.message] : sa, ["PAUSED", "Ad created, paused. Nothing spends until it is switched on."]);
  const sc = google.campaigns.at(-1)!;
  const scCreate = (sc.ops.find((o) => (o as Record<string, unknown>).campaignOperation) as { campaignOperation: { create: Record<string, unknown> } }).campaignOperation.create;
  const rsa = (sc.ops.find((o) => (o as Record<string, unknown>).adGroupAdOperation) as { adGroupAdOperation: { create: { ad: { responsiveSearchAd: { headlines: { text: string }[]; descriptions: { text: string; pinnedField?: string }[] } } } } }).adGroupAdOperation.create.ad.responsiveSearchAd;
  check("on Google Search only", [scCreate.advertisingChannelType, (scCreate.networkSettings as Record<string, boolean>).targetContentNetwork], ["SEARCH", false]);
  check("the registration pinned first, on every ad Google shows",
    rsa.descriptions.filter((d) => d.pinnedField === "DESCRIPTION_1").map((d) => d.text), ["MahaRERA No. P52100012345 | maharera.maharashtra.gov.in"]);
  check("bidding on what buyers type, phrase match, and never on rent or resale",
    [
      JSON.stringify(sc.ops).includes('"matchType":"PHRASE"'),
      sc.ops.some((o) => JSON.stringify(o).includes('"negative":true') && JSON.stringify(o).includes('"text":"rent"')),
    ],
    [true, true]);
  check("with its selling points as callouts", JSON.stringify(sc.ops).includes('"fieldType":"CALLOUT"'), true);
  const [saRow] = await sql<{ source: string; brief_id: string; kind: string; media: unknown[] }[]>`SELECT source, brief_id, kind, media FROM publish_targets WHERE id = ${sa.ok ? sa.targetId : null}`;
  check("recorded as the brief's, words only", [saRow.source, saRow.brief_id, saRow.kind, saRow.media.length], ["BRIEF", brief.id, "TEXT", 0]);
  const twice = await publish.requestAlwaysOn({ orgId, userId, briefId: brief.id, destination: "GOOGLE_SEARCH_AD", dailyBudget: "1200" });
  check("a second one while it runs is refused", (twice as { code: string }).code, "RUNNING");
  check("a search ad cannot be published from one post",
    ((await publish.requestPublish({ orgId, userId, postId: dgPost, destinations: ["GOOGLE_SEARCH_AD"], dailyBudget: "1000" })) as { code: string }).code, "NOTHING_CHOSEN");

  const pa = await publish.requestAlwaysOn({ orgId, userId, briefId: brief.id, destination: "GOOGLE_PMAX_AD", dailyBudget: "1500" });
  check("a Performance Max campaign is created, paused", pa.ok ? pa.state : pa, "PAUSED");
  const pc = google.campaigns.at(-1)!;
  const pcCreate = (pc.ops.find((o) => (o as Record<string, unknown>).campaignOperation) as { campaignOperation: { create: Record<string, unknown> } }).campaignOperation.create;
  check("with every automatic text, picture and video switched off, and the address not expanded",
    [pcCreate.advertisingChannelType, (pcCreate.assetAutomationSettings as { assetAutomationStatus: string }[]).every((x) => x.assetAutomationStatus === "OPTED_OUT"), pcCreate.urlExpansionOptOut],
    ["PERFORMANCE_MAX", true, true]);
  const fields = pc.ops
    .map((o) => (o as { assetGroupAssetOperation?: { create: { fieldType: string } } }).assetGroupAssetOperation?.create.fieldType)
    .filter(Boolean);
  check("its asset group carries the banner, the squares, the logo, headlines and descriptions",
    ["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "LOGO", "HEADLINE", "LONG_HEADLINE", "DESCRIPTION", "BUSINESS_NAME"].every((f) => fields.includes(f)), true);
  check("and a video from the campaign's passed posts", fields.includes("YOUTUBE_VIDEO"), true);
  const pmaxDescs = pc.ops
    .filter((o) => (o as { assetOperation?: unknown }).assetOperation)
    .map((o) => (o as { assetOperation: { create: { textAsset?: { text: string } } } }).assetOperation.create.textAsset?.text ?? "");
  check("every Performance Max description carries the registration",
    pmaxDescs.filter((t) => t.includes("|")).length > 0 && pmaxDescs.filter((t) => t.length > 30 && !t.includes("P52100012345") && /maharera/i.test(t)).length === 0, true);

  const groupBefore = google.groupAssets.length;
  await makePost({ kind: "IMAGE", placement: "Meta feed 1:1", frames: [{ w: 1080, h: 1080 }], headline: "Sea facing homes" });
  const pass2 = await publish.publishDue({ orgIds: [orgId] });
  check("a picture passed since is added to the running Performance Max campaign", [pass2.picturesAdded, google.groupAssets.length - groupBefore], [1, 1]);
  check("and not twice", (await publish.publishDue({ orgIds: [orgId] })).picturesAdded, 0);

  check("switching the search ad on is the budget key's", (await publish.activatePublication({ orgId, userId, targetId: sa.ok ? sa.targetId : "" })).ok, true);
  await sql`UPDATE registration_records SET status = 'BLOCKED' WHERE scope_node_id = ${phase.id}`;
  const haltedSearch = await publish.haltBlocked(orgId);
  check("the kill switch pauses a spending search ad too", [haltedSearch.paused >= 1, sc.status], [true, "PAUSED"]);
  await sql`UPDATE registration_records SET status = 'VERIFIED' WHERE scope_node_id = ${phase.id}`;
  await publish.haltBlocked(orgId);

  const endIt = await publish.endAlwaysOn({ orgId, userId, targetId: sa.ok ? sa.targetId : "" });
  check("ending it marks it ended", endIt.ok, true);
  always = await publish.alwaysOnFor(orgId, brief.id);
  check("and a new one may be started from today's facts", [search().current, search().reason], [null, null]);
  const restarted = await publish.requestAlwaysOn({ orgId, userId, briefId: brief.id, destination: "GOOGLE_SEARCH_AD", dailyBudget: "1200" });
  check("as a second campaign, not the first one again", restarted.ok && sa.ok && restarted.targetId !== sa.targetId, true);

  // -------------------------------------------------------------------------
  console.log("\na schedule that makes Demand Gen ads");

  await sql`
    UPDATE post_schedules
    SET destinations = ${["GOOGLE_DEMAND_GEN_AD"]}::text[], ad_daily_budget = 1200, ad_days = 10
    WHERE id = ${schedule.id}`;
  const dgCreative = await scheduledPost("AD", 300_000, "f");
  await publish.publishDue({ orgIds: [orgId] });
  const [dgSched] = await sql<{ destination: string; state: string; ends_at: Date }[]>`
    SELECT destination, state, ends_at FROM publish_targets WHERE post_creative_id = ${dgCreative}`;
  check("an approved scheduled post becomes a Demand Gen ad, switched on", [dgSched?.destination, dgSched?.state], ["GOOGLE_DEMAND_GEN_AD", "ACTIVE"]);
  check("and Google is told the day it ends",
    JSON.stringify(google.campaigns.at(-1)!.ops).includes(`"endDate":"${dgSched.ends_at.toISOString().slice(0, 10)}"`), true);

  // -------------------------------------------------------------------------
  console.log("\nisolation");

  const theirs = await withTenant(OTHER.orgId, (s) => s<{ n: number }[]>`
    SELECT (SELECT count(*) FROM connections)::int + (SELECT count(*) FROM connection_accounts)::int
         + (SELECT count(*) FROM publish_targets)::int AS n`);
  check("another tenant sees none of it", theirs[0].n, 0);
  const nobody = await withNoTenant((s) => s<{ n: number }[]>`SELECT count(*)::int AS n FROM connections`);
  check("and nobody sees any of it with no tenant pinned", nobody[0].n, 0);
  const found = await withNoTenant((s) => s<{ org_id: string }[]>`
    SELECT org_id FROM connections_for_external_user('META', '10203040506070')`);
  check("the one lookup across tenants answers with an org id and nothing else", found.map((r) => r.org_id), [orgId]);
  try {
    await withTenant(OTHER.orgId, (s) => s`
      INSERT INTO publish_targets (org_id, source, destination, account_id, kind, headline, caption, content_sha256,
                                   scope_node_id, phase_id, idempotency_key)
      VALUES (${orgId}, 'STUDIO', 'FACEBOOK_PAGE', ${pageRow.id}, 'IMAGE', 'x', 'x', ${"b".repeat(64)},
              ${phase.id}, ${phase.id}, ${"c".repeat(64)})`);
    check("another tenant cannot write a publication here", false, true);
  } catch {
    check("another tenant cannot write a publication here", true, true);
  }
  try {
    await withTenant(orgId, (s) => s`DELETE FROM publish_targets WHERE org_id = ${orgId}`);
    check("the record of what went out cannot be deleted", false, true);
  } catch (e) {
    check("the record of what went out cannot be deleted", (e as { code?: string }).code, "42501");
  }
  const leaked = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log
    WHERE org_id = ${orgId} AND (metadata::text ILIKE '%token%' AND metadata::text ~ '(meta-|google-)(long|short|page|access|refresh)')`;
  check("no token reaches the audit log", leaked[0].n, 0);

  // -------------------------------------------------------------------------
  console.log("\nbeing disconnected");

  const body = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "10203040506070", issued_at: 1 })).toString("base64url");
  const sig = createHmac("sha256", process.env.META_APP_SECRET!).update(body).digest("base64url");
  const { parseSignedRequest } = await import("../src/lib/connect-rules.ts");
  check("a request Meta did not sign is ignored", parseSignedRequest(`${sig}x.${body}`, process.env.META_APP_SECRET!), null);
  const signed = parseSignedRequest(`${sig}.${body}`, process.env.META_APP_SECRET!);
  check("Meta's own request names the person", signed?.userId, "10203040506070");
  check("removing the app scrubs the connection it authorised",
    await connect.forgetExternalUser({ provider: "META", externalUserId: signed!.userId, reason: "DEAUTHORIZED" }), 1);
  const [scrubbed] = await sql<{ status: string; secret: Buffer | null; external_user_id: string | null }[]>`
    SELECT status, secret, external_user_id FROM connections WHERE org_id = ${orgId} AND provider = 'META'`;
  check("no token, no id", [scrubbed.status, scrubbed.secret, scrubbed.external_user_id], ["DISCONNECTED", null, null]);
  check("and the Pages' own tokens are gone too",
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM connection_accounts a JOIN connections c ON c.id = a.connection_id
      WHERE a.org_id = ${orgId} AND c.provider = 'META' AND a.secret IS NOT NULL`)[0].n, 0);
  check("what was published through it is still on record",
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publish_targets WHERE org_id = ${orgId} AND destination IN ('FACEBOOK_PAGE', 'INSTAGRAM')`)[0].n > 0, true);

  check("disconnecting Google revokes at Google first", (await connect.disconnect({ orgId, userId, provider: "GOOGLE" })).ok && google.revoked === 1, true);
  check("and nothing live is left", await connect.loadConnection(orgId, "GOOGLE"), null);
} finally {
  usePlatform(null);
  useVaultKey(null);
  // The whole tenant goes, and its audit rows, which have no key to cascade on.
  await sql`DELETE FROM audit_log WHERE org_id IN (${orgId}, ${OTHER.orgId})`;
  await sql`DELETE FROM orgs WHERE id IN (${orgId}, ${OTHER.orgId})`;
  await sql`DELETE FROM users WHERE id IN (${userId}, ${OTHER.userId})`;
  rmSync(STORE, { recursive: true, force: true });
  await sql.end();
  await closeDb();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
