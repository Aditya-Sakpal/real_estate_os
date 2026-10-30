/**
 * What goes out, where, and the record of it.
 *
 * A post reaches a platform through exactly one path: `prepare()` asks every
 * gate again, `requestPublish()` or the scheduled pass writes one
 * `publish_targets` row per destination, and `advance()` does the platform's
 * steps under a lease. Five rules.
 *
 * 1. **Every gate is asked again at the moment of publishing.** The copy is
 *    measured against today's facts with `gateCopy()`, because a price can be
 *    superseded between the card clearing and the button being pressed; the
 *    registration is asked of `canPublish()`, fresh; a HOLD never publishes.
 *    What the card was cleared against last week is not what it goes out
 *    against today.
 *
 * 2. **One post, one account, one destination: one row.** The idempotency key
 *    is unique, so a second press, a second worker and a retry all land on the
 *    same publication. A retry resumes at the first step the platform never
 *    confirmed (`ensure()` in `platform.ts`), and looks before it creates.
 *
 * 3. **An ad is created paused.** Nothing here starts spend on its own.
 *    Switching one on is `activatePublication()`, a person with the budget key
 *    pressing a button, and it asks the gate again first.
 *
 * 4. **Stopping needs nobody.** When a phase stops being advertisable,
 *    `haltBlocked()` pauses every ad spending on its registration, cancels
 *    what has not gone out, and lists what is still up for a person to take
 *    down. It runs in the worker and in the nightly sweep.
 *
 * 5. **What went out is frozen on the row.** The caption word for word, the
 *    files, the registration the gate said yes about. The post it came from
 *    can be rewritten or removed; the record of what a buyer saw cannot.
 *
 * Imports are relative so the checks and the worker can load this straight
 * from source.
 */

import { randomUUID } from "node:crypto";
import { taggedLanding } from "./capture-rules.ts";
import { captureEndpoint, enquiryUrl, orgCaptureKey } from "./capture.ts";
import { controlDb, withTenant, audit } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import { canPublish, complianceSummary } from "./publish-gate.ts";
import { haltBroadcasts } from "./broadcast-halt.ts";
import { studioGround } from "./creative.ts";
import { adFacts, adPrice, budgetFor, gateCopy, isLuxury, priceNoteFor, sellingPoints, staleFacts, storedLocal, type AdFacts, type Segment } from "./creative-rules.ts";
import { formSpec, type FormFacts } from "./lead-form-rules.ts";
import { configLabel } from "./unit-rules.ts";
import { agentStale } from "./rera-ad-rules.ts";
import { firmAgentFor } from "./firm-agent.ts";
import { readBrandFile, resolveBrand } from "./brand.ts";
import {
  NEGATIVE_KEYWORDS,
  demandGenText,
  leadFormText,
  pmaxPictureGap,
  pmaxPictures,
  pmaxText,
  privacyUrl as cleanPrivacyUrl,
  searchAdText,
  searchKeywords,
  type CampaignBundle,
} from "./google-ad-rules.ts";
import { readAsset, platformUrl } from "./storage.ts";
import {
  backoffMs,
  budgetCheck,
  AD_GOALS,
  ALWAYS_ON,
  POST_DESTINATIONS,
  SCHEDULE_AD_DESTINATIONS,
  adGoalLabel,
  canActivate,
  canPause,
  canRetry,
  captionFits,
  captionFor,
  companionPlacements,
  contentHash,
  defaultGoal,
  destinationDef,
  displayText,
  ERROR_ADVICE,
  fitFor,
  goalProblem,
  haltPlan,
  hasSquare,
  idempotencyKey,
  adAgain,
  isAd,
  isAdGoal,
  isAlwaysOn,
  isDestination,
  landingUrl,
  registrationLine,
  youtubeAllowed,
  type AdGoal,
  type TargetKind,
  MAX_PUBLISH_ATTEMPTS,
  PROCESSING_LIMIT_MS,
  PUBLISH_LEASE_MS,
  TARGET_LABEL,
  type Destination,
  type Format,
  type PlatformError,
  type TargetState,
} from "./connect-rules.ts";
import { destinationsFor, markBroken, tokenFor, checkConnection, type Resolved } from "./connect.ts";
import { createMetaAd, publishToFacebook, publishToInstagram, setMetaAdSpend } from "./meta.ts";
import {
  addPmaxPictures,
  createGoogleDemandGenAd,
  createGoogleDisplayAd,
  createGooglePmaxAd,
  createGoogleSearchAd,
  publishToBusinessProfile,
  setGoogleAdSpend,
} from "./google.ts";
import type { StepContext, StepOutcome, Steps } from "./platform.ts";
import type { PostKind } from "./compose-rules.ts";
import { usesAd, usesPost, isOutlet, type Outlet } from "./plan-rules.ts";
import { pixelRefusal, type PixelRecord } from "./pixel-rules.ts";
import { isCardAngle } from "./card-angle-rules.ts";

type Media = { key: string; type: string; width: number; height: number; bytes?: number; placement?: string; sha256?: string };

type Source = { kind: "STUDIO"; postId: string } | { kind: "SCHEDULE"; creativeId: string };

type Prepared = {
  sourceId: string;
  kind: PostKind;
  placement: string | null;
  language: string;
  headline: string;
  body: string;
  cta: string;
  media: Media[];
  copyId: string | null;
  node: { id: string; path: string; name: string; kind: string };
  phase: { id: string; registrationNo: string | null; stateCode: string | null };
  caption: string;
  city: string | null;
  businessNames: string[];
  website: string | null;
  /** The registration line every ad carries, from the number the gate said yes about. */
  registration: string | null;
  /** The developer's privacy policy, from the brand kit. */
  privacyUrl: string | null;
  /** What a Leads ad's instant form prints and asks, from today's signed facts. */
  form: FormFacts;
};

export type Refusal = { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// The gates, asked again
// ---------------------------------------------------------------------------

/**
 * The phase an advertisement for this node carries: the one underneath with
 * the most life left in its registration, which is the rule `studioGround()`
 * uses to choose the number, so the number printed and the phase the kill
 * switch watches are the same one.
 */
async function advertisingPhase(orgId: string, nodePath: string, now: Date) {
  const summary = await complianceSummary(orgId, now);
  return (
    summary.phases
      .filter((p) => p.ok && (p.path === nodePath || p.path.startsWith(`${nodePath}.`)))
      .sort((a, b) => (b.daysLeft ?? 0) - (a.daysLeft ?? 0))[0] ?? null
  );
}

async function prepare(orgId: string, source: Source, now: Date): Promise<({ ok: true } & Prepared) | Refusal> {
  type Row = {
    source_id: string;
    kind: PostKind;
    placement: string | null;
    language: string;
    segment: Segment;
    headline: string;
    body: string;
    cta: string;
    media: Media[];
    copy_id: string | null;
    review: { passed?: boolean } | null;
    pixel: PixelRecord | null;
    node_id: string;
    node_path: string;
    node_name: string;
    node_kind: string;
    formats: string[] | null;
    unit_type_ids: string[] | null;
    state: string | null;
    content_sha256: string | null;
    decided_sha256: string | null;
    hard_stop_at: Date | null;
    org_name: string;
    facts: AdFacts | null;
    local: unknown;
    agent_no: string | null;
    angle: string | null;
  };

  const id = source.kind === "STUDIO" ? source.postId : source.creativeId;
  if (!isNodeId(id)) return { ok: false, code: "UNKNOWN", message: "That post is not in this organisation." };

  const row = await withTenant(orgId, async (sql) => {
    const [r] =
      source.kind === "STUDIO"
        ? await sql<Row[]>`
            SELECT p.id AS source_id, p.kind, p.placement, p.language, p.segment, p.headline, p.body, p.cta,
                   p.media, p.copy_id, p.review, p.pixel, n.id AS node_id, n.path::text AS node_path, n.name AS node_name,
                   n.kind AS node_kind, b.formats, b.unit_type_ids, NULL AS state, NULL AS content_sha256,
                   NULL AS decided_sha256, NULL::timestamptz AS hard_stop_at, o.display_name AS org_name,
                   p.inputs -> 'facts' AS facts, p.inputs ->> 'agentNo' AS agent_no,
                   -- A Hindi card's reading: the post's own, or its card's while the words are the same.
                   coalesce(p.inputs -> 'local', (
                     SELECT k.local FROM campaign_copy k
                     WHERE k.org_id = p.org_id AND k.id = p.copy_id
                       AND k.headline = p.headline AND k.body = p.body AND k.cta = p.cta)) AS local,
                   (SELECT k.angle FROM campaign_copy k WHERE k.org_id = p.org_id AND k.id = p.copy_id) AS angle
            FROM rendered_posts p
            JOIN campaign_briefs b ON b.id = p.brief_id
            JOIN scope_nodes n ON n.id = p.scope_node_id
            JOIN orgs o ON o.id = p.org_id
            WHERE p.org_id = ${orgId} AND p.id = ${id}`
        : await sql<Row[]>`
            SELECT c.id AS source_id, c.kind, (c.media -> 0 ->> 'placement') AS placement, c.language, c.segment,
                   c.headline, c.body, c.cta, c.media, NULL::uuid AS copy_id, c.post_review AS review, c.pixel,
                   n.id AS node_id, n.path::text AS node_path, n.name AS node_name, n.kind AS node_kind,
                   b.formats, b.unit_type_ids, c.state, c.content_sha256, c.decided_sha256, c.hard_stop_at,
                   o.display_name AS org_name, c.media -> 0 -> 'facts' AS facts,
                   c.media -> 0 ->> 'agentNo' AS agent_no,
                   c.inputs -> 'local' AS local, c.inputs ->> 'angle' AS angle
            FROM post_creatives c
            JOIN post_runs r ON r.id = c.run_id
            JOIN post_schedules s ON s.id = r.schedule_id
            JOIN campaign_briefs b ON b.id = s.brief_id
            JOIN scope_nodes n ON n.id = s.scope_node_id
            JOIN orgs o ON o.id = c.org_id
            WHERE c.org_id = ${orgId} AND c.id = ${id}`;
    return r ?? null;
  });
  if (!row) return { ok: false, code: "UNKNOWN", message: "That post is not in this organisation." };
  if (!row.media?.length) return { ok: false, code: "NO_FILES", message: "This post has no files to publish." };
  if (row.review && row.review.passed === false) {
    return { ok: false, code: "DID_NOT_PASS", message: "This post did not pass its check, so it cannot go out." };
  }
  if (source.kind === "SCHEDULE") {
    if (row.state !== "APPROVED" && row.state !== "PUBLISHED") {
      return { ok: false, code: "NOT_APPROVED", message: "Nobody has approved this post." };
    }
    if (!row.decided_sha256 || row.decided_sha256 !== row.content_sha256) {
      return { ok: false, code: "CHANGED", message: "This post changed after it was approved." };
    }
    if (row.hard_stop_at && row.hard_stop_at.getTime() <= now.getTime()) {
      return { ok: false, code: "OCCASION_PASSED", message: "The occasion this was written for has passed." };
    }
  }

  // The registration first, fresh, and the number it hands back: with nothing
  // lawful to say, what the copy says is beside the point.
  const node = { id: row.node_id, path: row.node_path, name: row.node_name, kind: row.node_kind };
  const phase = await advertisingPhase(orgId, node.path, now);
  if (!phase) return { ok: false, code: "NOT_ADVERTISABLE", message: `${node.name} cannot be advertised today.` };
  const verdict = await canPublish(orgId, phase.phaseId, now);
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };

  // Then the picture: a PASS from the pixel gate, on these files, reached
  // against the registration the gate just said yes about. A post without
  // one never goes out, AUTO included.
  const pictured = pixelRefusal(row.pixel, row.media, verdict.registrationNo);
  if (pictured) return { ok: false, code: pictured.code, message: pictured.message };

  // Then the copy, against today's facts, for the size it was made in.
  const { ground } = await studioGround(orgId, node, now, row.unit_type_ids ?? []);
  const formats = row.placement ? [row.placement] : row.formats ?? [];
  const gate = gateCopy(
    { headline: row.headline, body: row.body, cta: row.cta },
    // A greeting is gated as a greeting: it leads on no selling point.
    { language: row.language, segment: row.segment, ...(isCardAngle(row.angle) ? { angle: row.angle } : {}) },
    ground,
    budgetFor(formats),
    storedLocal(row.local),
  );
  if (gate.verdict !== "PASS") {
    const why = gate.reasons[0]?.detail ?? "It no longer clears.";
    return {
      ok: false,
      code: gate.verdict === "HOLD" ? "ON_HOLD" : "BLOCKED",
      message:
        gate.verdict === "HOLD"
          ? `This copy is on hold and cannot go out. ${why}`
          : `This copy no longer clears against the approved facts. ${why}`,
    };
  }
  // The price and the location printed on the picture are checked too: the
  // words above were written with the price in them only sometimes, and the
  // picture carries it every time.
  const stale = staleFacts(row.facts, adFacts(ground));
  if (stale) return { ok: false, code: "BLOCKED", message: stale };

  // A firm's own ad is an agent's, and carries the agent registration current
  // today: none recorded refuses, and a picture printed under another number
  // is made again.
  const agent = await firmAgentFor(orgId, now.toISOString());
  if (!agent.ok) return { ok: false, code: agent.code, message: agent.message };
  const agentOff = agentStale(row.agent_no, agent.agentNo);
  if (agentOff) return { ok: false, code: "AGENT_CHANGED", message: agentOff };


  const extra = await withTenant(orgId, async (sql) => {
    const [reg] = await sql<{ state_code: string | null }[]>`
      SELECT state_code FROM registration_records WHERE org_id = ${orgId} AND scope_node_id = ${phase.phaseId}`;
    const [region] = await sql<{ name: string }[]>`
      SELECT name FROM scope_nodes
      WHERE org_id = ${orgId} AND kind = 'REGION' AND path @> ${node.path}::ltree LIMIT 1`;
    const [project] = await sql<{ name: string }[]>`
      SELECT name FROM scope_nodes
      WHERE org_id = ${orgId} AND kind = 'PROJECT' AND path @> ${node.path}::ltree LIMIT 1`;
    return { stateCode: reg?.state_code ?? null, city: region?.name ?? null, project: project?.name ?? null };
  });
  const brand = await resolveBrand(orgId, node.id);

  return {
    ok: true,
    sourceId: row.source_id,
    kind: row.kind,
    placement: row.placement,
    language: row.language,
    headline: row.headline,
    body: row.body,
    cta: row.cta,
    media: row.media,
    copyId: row.copy_id,
    node,
    phase: { id: phase.phaseId, registrationNo: verdict.registrationNo, stateCode: extra.stateCode },
    caption: captionFor({
      headline: row.headline,
      body: row.body,
      cta: row.cta,
      registrationNo: verdict.registrationNo,
      stateCode: extra.stateCode,
      permitNo: verdict.permitNo,
      facts: row.facts,
      agentNo: agent.agentNo,
      agentName: agent.seller,
    }),
    city: extra.city,
    businessNames: [row.org_name, extra.project ?? "", node.name].filter(Boolean),
    website: brand?.kit.website ?? null,
    registration: registrationLine(verdict.registrationNo, extra.stateCode, verdict.permitNo),
    privacyUrl: cleanPrivacyUrl(brand?.kit.privacyUrl),
    form: formFactsFrom(ground, { project: extra.project ?? node.name, tower: node.name, city: extra.city, stateCode: extra.stateCode, salesPhone: brand?.kit.salesPhone ?? null }),
  };
}

/** The facts a Leads ad's form prints and asks about: the ad's own price lines and place. */
function formFactsFrom(
  ground: { location?: string | null; configurations: readonly { config?: string; label: string; startingPrice: number | null }[] },
  o: { project: string; tower: string; city: string | null; stateCode: string | null; salesPhone: string | null },
): FormFacts {
  const facts = adFacts(ground);
  const priced = ground.configurations.map((c) => c.startingPrice ?? 0).filter((p) => p > 0);
  return {
    project: o.project,
    tower: o.tower,
    location: facts.location,
    city: o.city,
    prices: facts.prices,
    priceNote: facts.prices.length ? priceNoteFor(o.stateCode) : null,
    cheapest: priced.length ? Math.min(...priced) : null,
    configs: ground.configurations.filter((c) => !!c.config).map((c) => ({ key: c.config!, label: configLabel(c.config!) })),
    salesPhone: o.salesPhone,
  };
}

// ---------------------------------------------------------------------------
// What a post could be published to
// ---------------------------------------------------------------------------

export type DestinationOption = {
  destination: Destination;
  label: string;
  ad: boolean;
  ok: boolean;
  reason: string | null;
  accountName: string | null;
  dailyCap: number | null;
  /** Already published there, and how it stands. */
  existing: { id: string; state: TargetState } | null;
  /** Every ad of this post there is paused, so publishing makes a new one. */
  again?: boolean;
  /** For a Meta ad: each goal, and why one cannot be chosen. */
  goals?: { key: AdGoal; label: string; detail: string; ok: boolean; reason: string | null }[];
  defaultGoal?: AdGoal | null;
  /** The other size of the same card the ad will show beside this one. */
  companion?: string | null;
};

/** For a Google display ad: the square picture made from the same card. */
async function squareCompanion(orgId: string, copyId: string | null): Promise<Media | null> {
  if (!copyId) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ media: Media[] }[]>`
      SELECT media FROM rendered_posts
      WHERE org_id = ${orgId} AND copy_id = ${copyId} AND kind = 'IMAGE' AND placement = 'Meta feed 1:1'
        AND (review IS NULL OR (review ->> 'passed')::boolean)
        -- The square goes out beside the banner, so it passed the pixel gate too.
        AND pixel ->> 'verdict' = 'PASS'
      ORDER BY created_at DESC LIMIT 1`;
    return r?.media?.[0] ?? null;
  });
}

/**
 * The other sizes of this card an ad shows beside it: a 9:16 story beside a
 * feed post on Meta, a square beside a banner on Demand Gen. Only a size
 * that passed its own check and the pixel gate, made from the same cleared
 * card, so nothing rides along that was not cleared.
 */
async function companionsFor(orgId: string, prepared: Prepared, destination: Destination): Promise<Media[]> {
  const want = companionPlacements(destination, prepared.kind, prepared.placement);
  if (!want.length || !prepared.copyId) return [];
  const rows = await withTenant(orgId, (sql) =>
    sql<{ media: Media[]; placement: string }[]>`
      SELECT media, placement FROM rendered_posts
      WHERE org_id = ${orgId} AND copy_id = ${prepared.copyId} AND kind = ${prepared.kind}
        AND placement = ANY(${want})
        AND (review IS NULL OR (review ->> 'passed')::boolean)
        AND pixel ->> 'verdict' = 'PASS'
      ORDER BY created_at DESC`);
  for (const placement of want) {
    const hit = rows.find((r) => r.placement === placement && r.media?.length);
    if (hit) return [{ ...hit.media[0], placement }];
  }
  return [];
}

/** The developer's WhatsApp number at a node, E.164, when one is connected and sending. */
async function whatsappNumberAt(orgId: string, nodePath: string): Promise<string | null> {
  const rows = await withTenant(orgId, (sql) =>
    sql<{ display_phone: string | null; node_path: string | null; active: boolean; status: string; on_app: boolean; registered: boolean }[]>`
      SELECT n.display_phone, s.path::text AS node_path, n.active, a.status, n.on_app, n.registered
      FROM whatsapp_numbers n
      JOIN whatsapp_accounts a ON a.id = n.account_id
      LEFT JOIN scope_nodes s ON s.id = n.scope_node_id
      WHERE n.org_id = ${orgId} AND n.retired_at IS NULL AND a.status = 'CONNECTED'`);
  const covers = (p: string | null) => !!p && (nodePath === p || nodePath.startsWith(`${p}.`));
  const best = rows
    .filter((r) => r.active && covers(r.node_path) && (r.on_app || r.registered))
    .sort((a, b) => (b.node_path ?? "").split(".").length - (a.node_path ?? "").split(".").length)[0];
  const digits = (best?.display_phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? `+${digits.length === 10 ? `91${digits}` : digits}` : null;
}

/** What a Meta ad's goals can rest on at a node: its Page, a privacy link, a WhatsApp number. */
export async function metaGoalFactsAt(orgId: string, nodePath: string) {
  const [resolved, node] = await Promise.all([
    destinationsFor(orgId, nodePath),
    withTenant(orgId, async (sql) => {
      const [n] = await sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND path = ${nodePath}::ltree`;
      return n ?? null;
    }),
  ]);
  const brand = node ? await resolveBrand(orgId, node.id) : null;
  return {
    page: !!resolved.get("FACEBOOK_PAGE")?.ok,
    privacyUrl: !!cleanPrivacyUrl(brand?.kit.privacyUrl),
    whatsappNumber: !!(await whatsappNumberAt(orgId, nodePath)),
  };
}

/** What a Meta ad's goals can rest on at this node. */
async function goalFacts(orgId: string, prepared: Pick<Prepared, "node" | "privacyUrl">, pageOk: boolean) {
  return { page: pageOk, privacyUrl: !!prepared.privacyUrl, whatsappNumber: !!(await whatsappNumberAt(orgId, prepared.node.path)) };
}

/**
 * Every destination, and whether this post can go there: the account, the
 * post's shape, the caption's length, and for Google display the square
 * picture beside the banner. The screen offers only what can succeed and
 * names the reason for the rest.
 */
export async function publishOptions(
  orgId: string,
  postId: string,
  now = new Date(),
): Promise<{ ok: true; options: DestinationOption[]; website: string | null } | Refusal> {
  const prepared = await prepare(orgId, { kind: "STUDIO", postId }, now);
  if (!prepared.ok) return prepared;
  const [resolved, existing, square] = await Promise.all([
    destinationsFor(orgId, prepared.node.path),
    withTenant(orgId, (sql) =>
      sql<{ id: string; destination: Destination; state: TargetState; account_id: string }[]>`
        SELECT id, destination, state, account_id FROM publish_targets
        WHERE org_id = ${orgId} AND rendered_post_id = ${postId}
        ORDER BY created_at DESC`),
    squareCompanion(orgId, prepared.copyId),
  ]);
  const options: DestinationOption[] = [];
  for (const destination of POST_DESTINATIONS) {
    const r = resolved.get(destination);
    if (!r) continue;
    const def = destinationDef(destination);
    const fit = fitFor(destination, { kind: prepared.kind, placement: prepared.placement, media: prepared.media });
    let reason: string | null = r.ok ? null : r.reason;
    if (!reason && !fit.ok) reason = fit.reason;
    if (!reason && !captionFits(destination, prepared.caption)) reason = "The caption is longer than this platform allows.";
    if (!reason && destination === "GOOGLE_DISPLAY_AD") {
      const text = displayText({ headline: prepared.headline, body: prepared.body, businessNames: prepared.businessNames });
      if (!text.ok) reason = text.reason;
      else if (!square) reason = "Google shows a square picture beside the banner. Make a post of this card with \"Facebook and Instagram feed\" ticked.";
    }
    const companions = !reason && (destination === "META_AD" || destination === "GOOGLE_DEMAND_GEN_AD")
      ? await companionsFor(orgId, prepared, destination)
      : [];
    if (!reason && destination === "GOOGLE_DEMAND_GEN_AD") {
      reason = await demandGenProblem(orgId, prepared, [...prepared.media, ...companions], r.ok ? r.to.scopes : []);
    }
    if (!reason && def.mode === "AD" && r.ok && r.to.account.dailyCap === null) {
      reason = "Nobody has set a daily limit for this ad account yet.";
    }
    const held = existing.find((e) => e.destination === destination) ?? null;
    const here = existing.filter((e) => e.destination === destination && (!r.ok || e.account_id === r.to.account.id));
    const option: DestinationOption = {
      destination,
      label: def.label,
      ad: def.mode === "AD",
      ok: !reason,
      reason,
      accountName: r.ok ? r.to.account.name : null,
      dailyCap: r.ok ? r.to.account.dailyCap : null,
      existing: held ? { id: held.id, state: held.state } : null,
      again: adAgain(destination, here.map((e) => e.state)),
      companion: companions[0]?.placement ?? null,
    };
    if (destination === "META_AD") {
      const facts = await goalFacts(orgId, prepared, !!resolved.get("FACEBOOK_PAGE")?.ok);
      option.goals = AD_GOALS.map((g) => {
        const why = goalProblem(g.key, facts);
        return { key: g.key, label: g.label, detail: g.detail, ok: !why, reason: why };
      });
      option.defaultGoal = option.goals.some((g) => g.ok) ? defaultGoal(facts) : null;
    }
    options.push(option);
  }
  return { ok: true, options, website: prepared.website };
}

/**
 * Why a post cannot be a Demand Gen ad, or null: its words must fit, a
 * picture ad needs a square, the logo must be in the brand kit, and a video
 * goes up to YouTube, which the connection must allow.
 */
async function demandGenProblem(orgId: string, prepared: Prepared, media: readonly Media[], scopes: readonly string[]): Promise<string | null> {
  const words = demandGenText({
    headline: prepared.headline,
    body: prepared.body,
    cta: prepared.cta,
    registration: prepared.registration,
    businessNames: prepared.businessNames,
    points: [],
  });
  if (!words.ok) return words.reason;
  if (prepared.kind === "IMAGE" && !hasSquare(media)) {
    return "Demand Gen needs a square picture. Make a post of this card with \"Facebook and Instagram feed\" ticked.";
  }
  if (prepared.kind === "VIDEO" && !youtubeAllowed(scopes)) {
    return "Google was connected before YouTube uploads were asked for. Reconnect Google and allow YouTube.";
  }
  if (!(await logoFor(orgId, prepared.node.id))) return "Add your logo in Library, Branding. Google shows it beside the ad.";
  return null;
}

/**
 * The brand's mark as a square picture, for an ad that shows a logo: the
 * stacked mark first, then the horizontal one, then the single-colour one,
 * set on white in a 512 square so nothing is cropped.
 */
async function logoFor(orgId: string, nodeId: string): Promise<Buffer | null> {
  const brand = await resolveBrand(orgId, nodeId);
  const order = ["LOGO_STACKED", "LOGO_HORIZONTAL", "LOGO_MONO"];
  const file = order.map((role) => brand?.files.find((f) => f.role === role)).find(Boolean);
  if (!file) return null;
  const read = await readBrandFile(orgId, file.id);
  if (!read) return null;
  try {
    const sharp = (await import("sharp")).default;
    return await sharp(read.bytes)
      .resize(448, 448, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .extend({ top: 32, bottom: 32, left: 32, right: 32, background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Asking for a publication
// ---------------------------------------------------------------------------

export type RequestResult = { destination: Destination; ok: boolean; targetId: string | null; message: string };

type TargetInsert = {
  source: "STUDIO" | "SCHEDULE" | "BRIEF";
  prepared: Pick<Prepared, "sourceId" | "placement" | "headline" | "caption" | "node" | "phase"> & { kind: TargetKind };
  /** The brief an always-on campaign belongs to. */
  briefId?: string | null;
  adGoal?: AdGoal | null;
  /** What the publisher is handed on the row from the start, frozen with it. */
  steps?: Record<string, unknown>;
  destination: Destination;
  to: Resolved;
  media: Media[];
  dailyBudget: number | null;
  destinationUrl: string | null;
  requestedBy: string | null;
  notBefore: Date;
  /** Switch the ad on as soon as it exists: a scheduled ad, already decided. */
  switchOn?: boolean;
  /** When a scheduled ad stops by itself. */
  endsAt?: Date | null;
  /** A person's press: a post whose ads here are all paused gets a new one. */
  again?: boolean;
};

/** Write one publication, or find the one this key already names. */
async function insertTarget(orgId: string, t: TargetInsert): Promise<{ id: string; created: boolean; state: TargetState }> {
  const first = await insertVersion(orgId, t, 1);
  if (first.created || !t.again || t.source !== "STUDIO") return first;
  // Every ad this post has here, every version: a new one only when all of
  // them are paused, and numbered after them, so two presses make one.
  const held = await withTenant(orgId, (sql) => sql<{ state: TargetState }[]>`
    SELECT state FROM publish_targets
    WHERE org_id = ${orgId} AND rendered_post_id = ${t.prepared.sourceId}
      AND account_id = ${t.to.account.id} AND destination = ${t.destination}`);
  if (!adAgain(t.destination, held.map((h) => h.state))) return first;
  return insertVersion(orgId, t, held.length + 1);
}

async function insertVersion(
  orgId: string,
  t: TargetInsert,
  version: number,
): Promise<{ id: string; created: boolean; state: TargetState }> {
  const key = idempotencyKey({
    source: t.source,
    sourceId: t.prepared.sourceId,
    accountId: t.to.account.id,
    destination: t.destination,
    version,
  });
  const media = t.media.map((m) => ({
    key: m.key,
    type: m.type,
    width: m.width,
    height: m.height,
    ...(m.placement ? { placement: m.placement } : {}),
  }));
  // An ad's landing page carries our tag, so the lead it brings is tied back
  // to this publication and the budget pass can read what it bought.
  const landing = t.destinationUrl && isAd(t.destination) ? taggedLanding(t.destinationUrl, key, t.destination) : t.destinationUrl;
  const hash = contentHash({ destination: t.destination, headline: t.prepared.headline, caption: t.prepared.caption, media });
  return withTenant(orgId, async (sql) => {
    const [made] = await sql<{ id: string; state: TargetState }[]>`
      INSERT INTO publish_targets (org_id, source, rendered_post_id, post_creative_id, destination, account_id,
                                   kind, placement, headline, caption, media, content_sha256, scope_node_id,
                                   phase_id, registration_no, idempotency_key, daily_budget, destination_url,
                                   requested_by, not_before, switch_on, ends_at, brief_id, ad_goal, steps)
      VALUES (${orgId}, ${t.source}, ${t.source === "STUDIO" ? t.prepared.sourceId : null},
              ${t.source === "SCHEDULE" ? t.prepared.sourceId : null}, ${t.destination}, ${t.to.account.id},
              ${t.prepared.kind}, ${t.prepared.placement}, ${t.prepared.headline}, ${t.prepared.caption},
              ${sql.json(media as never)}, ${hash}, ${t.prepared.node.id}, ${t.prepared.phase.id},
              ${t.prepared.phase.registrationNo}, ${key}, ${t.dailyBudget}, ${landing},
              ${t.requestedBy}, ${t.notBefore}, ${t.switchOn ?? false}, ${t.endsAt ?? null},
              ${t.briefId ?? null}, ${t.destination === "META_AD" ? t.adGoal ?? "TRAFFIC" : null},
              ${sql.json((t.steps ?? {}) as never)})
      ON CONFLICT (org_id, idempotency_key) DO NOTHING
      RETURNING id, state`;
    if (made) return { id: made.id, created: true, state: made.state };
    const [held] = await sql<{ id: string; state: TargetState }[]>`
      SELECT id, state FROM publish_targets WHERE org_id = ${orgId} AND idempotency_key = ${key}`;
    return { id: held.id, created: false, state: held.state };
  });
}

/**
 * A person presses Publish on a studio post.
 *
 * Every destination is checked on its own and answers on its own, so one
 * refusal (no Instagram account for this project) does not stop the Page post
 * the same press asked for. Then each new publication is advanced straight
 * away, within a few seconds' budget, so a picture is usually live before
 * the screen comes back; a reel that Instagram is still processing is left
 * for the worker, and the screen says it is on its way.
 */
export async function requestPublish(input: {
  orgId: string;
  userId: string;
  postId: string;
  destinations: string[];
  dailyBudget?: string | null;
  destinationUrl?: string | null;
  /** What a Meta ad is for. */
  adGoal?: string | null;
  now?: Date;
  /** How long the press may spend publishing before handing the rest to the worker. */
  inlineMs?: number;
}): Promise<{ ok: true; results: RequestResult[] } | Refusal> {
  const now = input.now ?? new Date();
  const wanted = [...new Set(input.destinations)].filter(isDestination).filter((d) => !isAlwaysOn(d));
  if (!wanted.length) return { ok: false, code: "NOTHING_CHOSEN", message: "Choose where this goes." };

  const prepared = await prepare(input.orgId, { kind: "STUDIO", postId: input.postId }, now);
  if (!prepared.ok) return prepared;
  const resolved = await destinationsFor(input.orgId, prepared.node.path);

  const results: RequestResult[] = [];
  const fresh: string[] = [];
  for (const destination of wanted) {
    const def = destinationDef(destination);
    const say = (message: string, targetId: string | null = null, ok = false) =>
      results.push({ destination, ok, targetId, message });

    const r = resolved.get(destination);
    if (!r || !r.ok) {
      say(r && !r.ok ? r.reason : "That is not somewhere this can go.");
      continue;
    }
    const fit = fitFor(destination, { kind: prepared.kind, placement: prepared.placement, media: prepared.media });
    if (!fit.ok) {
      say(fit.reason);
      continue;
    }
    if (!captionFits(destination, prepared.caption)) {
      say("The caption is longer than this platform allows.");
      continue;
    }

    let media: Media[] = prepared.media;
    let dailyBudget: number | null = null;
    // A Business Profile post's button goes to the website unless told
    // otherwise; with no website it rings the number on the profile.
    let destinationUrl: string | null =
      landingUrl(input.destinationUrl) ?? (destination === "GOOGLE_BUSINESS" ? landingUrl(prepared.website) : null);
    if (def.mode === "AD") {
      const budget = budgetCheck({
        raw: input.dailyBudget,
        cap: r.to.account.dailyCap,
        currency: r.to.account.detail.currency ?? null,
      });
      if (!budget.ok) {
        say(budget.reason);
        continue;
      }
      dailyBudget = budget.rupees;
      // With no page of the developer's own, our enquiry page for the tower,
      // which captures the lead straight into the pipeline.
      destinationUrl =
        landingUrl(input.destinationUrl) ?? landingUrl(prepared.website) ?? enquiryUrl(input.orgId, prepared.phase.id);
      if (!destinationUrl) {
        say("An ad needs the page it sends people to.");
        continue;
      }
    }
    if (destination === "GOOGLE_DISPLAY_AD") {
      const text = displayText({ headline: prepared.headline, body: prepared.body, businessNames: prepared.businessNames });
      if (!text.ok) {
        say(text.reason);
        continue;
      }
      const square = await squareCompanion(input.orgId, prepared.copyId);
      if (!square) {
        say("Google shows a square picture beside the banner. Make a post of this card with \"Facebook and Instagram feed\" ticked.");
        continue;
      }
      media = [prepared.media[0], square];
    }
    let adGoal: AdGoal | null = null;
    if (destination === "META_AD") {
      const facts = await goalFacts(input.orgId, prepared, !!resolved.get("FACEBOOK_PAGE")?.ok);
      adGoal = isAdGoal(input.adGoal) ? input.adGoal : defaultGoal(facts);
      const why = goalProblem(adGoal, facts);
      if (why) {
        say(why);
        continue;
      }
      if (prepared.kind !== "CAROUSEL") media = [...prepared.media.slice(0, 1), ...(await companionsFor(input.orgId, prepared, destination))];
    }
    if (destination === "GOOGLE_DEMAND_GEN_AD") {
      if (prepared.kind === "IMAGE") media = [...prepared.media.slice(0, 1), ...(await companionsFor(input.orgId, prepared, destination))];
      const why = await demandGenProblem(input.orgId, prepared, media, r.to.scopes);
      if (why) {
        say(why);
        continue;
      }
    }

    const t = await insertTarget(input.orgId, {
      source: "STUDIO",
      prepared,
      destination,
      to: r.to,
      media,
      dailyBudget,
      destinationUrl,
      requestedBy: input.userId,
      notBefore: now,
      adGoal,
      steps:
        destination === "GOOGLE_DEMAND_GEN_AD"
          ? { registration: prepared.registration }
          : destination === "META_AD" && adGoal === "LEADS"
            ? { form: formSpec(prepared.form) }
            : undefined,
      again: true,
    });
    if (!t.created) {
      say(
        t.state === "FAILED"
          ? "This was tried before and failed. Use Try again on it."
          : `Already ${TARGET_LABEL[t.state].toLowerCase()} there.`,
        t.id,
      );
      continue;
    }
    fresh.push(t.id);
    say("Publishing.", t.id, true);
    await audit({
      orgId: input.orgId,
      actorUserId: input.userId,
      action: "publish.requested",
      targetType: "publish_target",
      targetId: t.id,
      metadata: { destination, source: "STUDIO", kind: prepared.kind, budget: dailyBudget, goal: adGoal },
    });
  }

  // Straight away, inside a budget, then the worker has the rest.
  const until = Date.now() + (input.inlineMs ?? 20_000);
  for (const id of fresh) {
    if (Date.now() >= until) break;
    const done = await advance(input.orgId, id, { now });
    const row = results.find((x) => x.targetId === id);
    if (row) {
      row.message = done.state === "FAILED" ? done.error ?? "It could not be published." : describe(done.state, isAd(row.destination));
      row.ok = done.state !== "FAILED" && done.state !== "CANCELLED";
    }
  }
  return { ok: true, results };
}

function describe(state: TargetState, ad: boolean): string {
  if (state === "LIVE") return "Live.";
  if (state === "PAUSED") return ad ? "Ad created, paused. Nothing spends until it is switched on." : "Paused.";
  if (state === "ACTIVE") return "Spending.";
  if (state === "QUEUED" || state === "WORKING") return "On its way. The platform is still processing it.";
  if (state === "CANCELLED") return "Stopped: the project cannot be advertised.";
  return TARGET_LABEL[state];
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

type TargetRow = {
  id: string;
  source: "STUDIO" | "SCHEDULE";
  rendered_post_id: string | null;
  post_creative_id: string | null;
  destination: Destination;
  account_id: string;
  kind: TargetKind;
  placement: string | null;
  headline: string;
  caption: string;
  media: Media[];
  scope_node_id: string;
  phase_id: string;
  idempotency_key: string;
  steps: Steps;
  daily_budget: number | null;
  destination_url: string | null;
  attempts: number;
  lease_id: string | null;
  state: TargetState;
  error: string | null;
  switch_on: boolean;
  ends_at: Date | null;
  requested_by: string | null;
  ad_goal: AdGoal | null;
  brief_id: string | null;
};

const RUNNERS: Record<Destination, (ctx: StepContext) => Promise<StepOutcome>> = {
  FACEBOOK_PAGE: publishToFacebook,
  INSTAGRAM: publishToInstagram,
  META_AD: createMetaAd,
  GOOGLE_DISPLAY_AD: createGoogleDisplayAd,
  GOOGLE_BUSINESS: publishToBusinessProfile,
  GOOGLE_SEARCH_AD: createGoogleSearchAd,
  GOOGLE_PMAX_AD: createGooglePmaxAd,
  GOOGLE_DEMAND_GEN_AD: createGoogleDemandGenAd,
};

/** A step the platform confirmed that a buyer can already see. After it, the post is out. */
const VISIBLE_STEP: Record<Destination, string> = {
  FACEBOOK_PAGE: "post",
  INSTAGRAM: "media",
  META_AD: "",
  GOOGLE_DISPLAY_AD: "",
  GOOGLE_BUSINESS: "post",
  GOOGLE_SEARCH_AD: "",
  GOOGLE_PMAX_AD: "",
  GOOGLE_DEMAND_GEN_AD: "",
};

export type Advanced = { state: TargetState; error: string | null };

/**
 * Take one publication one step further, under a lease.
 *
 * Claimed in the WHERE clause, so two workers resolve in the database. Every
 * confirmed step is written before the next is sent, and only by the holder
 * of the lease, so a worker that lost its lease stops writing rather than
 * racing the one that took it.
 */
export async function advance(orgId: string, targetId: string, opts: { now?: Date } = {}): Promise<Advanced> {
  const now = opts.now ?? new Date();
  const lease = randomUUID();
  const leaseUntil = new Date(Date.now() + PUBLISH_LEASE_MS);

  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<TargetRow[]>`
      UPDATE publish_targets
      SET state = 'WORKING', lease_id = ${lease}, lease_until = ${leaseUntil}, attempts = attempts + 1,
          updated_at = now()
      WHERE org_id = ${orgId} AND id = ${targetId}
        AND not_before <= ${now} AND attempts < ${MAX_PUBLISH_ATTEMPTS}
        AND (state = 'QUEUED' OR (state = 'WORKING' AND lease_until <= now()))
      RETURNING id, source, rendered_post_id, post_creative_id, destination, account_id, kind, placement,
                headline, caption, media, scope_node_id, phase_id, idempotency_key, steps, daily_budget,
                destination_url, attempts, lease_id, state, error, switch_on, ends_at, requested_by, ad_goal, brief_id`;
    return r ?? null;
  });
  if (!row) {
    const [held] = await withTenant(orgId, (sql) =>
      sql<{ state: TargetState; error: string | null }[]>`
        SELECT state, error FROM publish_targets WHERE org_id = ${orgId} AND id = ${targetId}`);
    return held ?? { state: "FAILED", error: "That publication is not here." };
  }

  const finish = async (patch: {
    state: TargetState;
    error?: PlatformError | null;
    notBefore?: Date;
    externalUrl?: string | null;
    refund?: boolean;
    publishedAt?: boolean;
  }): Promise<Advanced> => {
    const e = patch.error ?? null;
    await withTenant(orgId, (sql) => sql`
      UPDATE publish_targets
      SET state = ${patch.state}, lease_id = NULL, lease_until = NULL,
          attempts = attempts - ${patch.refund ? 1 : 0},
          not_before = ${patch.notBefore ?? now},
          error_code = ${e ? e.code : null}, error = ${e ? e.message.slice(0, 300) : null},
          external_url = COALESCE(${patch.externalUrl ?? null}, external_url),
          published_at = CASE WHEN ${!!patch.publishedAt} THEN COALESCE(published_at, now()) ELSE published_at END,
          updated_at = now()
      WHERE org_id = ${orgId} AND id = ${targetId} AND lease_id = ${lease}`);
    return { state: patch.state, error: e ? `${e.message}` : null };
  };

  // Out already: a crashed attempt that got as far as the visible step.
  const visible = VISIBLE_STEP[row.destination];
  const alreadyOut = !!visible && typeof row.steps[visible] === "string";

  const verdict = await canPublish(orgId, row.phase_id, now);
  if (!verdict.ok && !alreadyOut) {
    const result = await finish({ state: "CANCELLED", error: { code: "POLICY", retryable: false, message: verdict.message } });
    await audit({
      orgId,
      actorUserId: null,
      action: "publish.cancelled",
      targetType: "publish_target",
      targetId,
      metadata: { destination: row.destination, why: verdict.code },
    });
    return result;
  }

  const credential = await tokenFor(orgId, row.account_id);
  if (!credential.ok) return finish({ state: "FAILED", error: credential });

  const context = await withTenant(orgId, async (sql) => {
    const [account] = await sql<{
      external_id: string;
      name: string;
      detail: Record<string, unknown>;
      scope_node_id: string;
      qualified_bidding: boolean;
      qualified_dataset: string | null;
      qualified_conversion: string | null;
    }[]>`
      SELECT external_id, name, detail, scope_node_id, qualified_bidding, qualified_dataset, qualified_conversion
      FROM connection_accounts WHERE org_id = ${orgId} AND id = ${row.account_id}`;
    const [node] = await sql<{ name: string; path: string }[]>`
      SELECT name, path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${row.scope_node_id}`;
    const [region] = await sql<{ name: string }[]>`
      SELECT name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'REGION' AND path @> ${node.path}::ltree LIMIT 1`;
    const [project] = await sql<{ name: string }[]>`
      SELECT name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PROJECT' AND path @> ${node.path}::ltree LIMIT 1`;
    const [org] = await sql<{ display_name: string }[]>`SELECT display_name FROM orgs WHERE id = ${orgId}`;
    const [pin] = await sql<{ lat: string; lng: string }[]>`
      SELECT s.latitude::text AS lat, s.longitude::text AS lng FROM site_locations s
      JOIN scope_nodes n ON n.id = s.scope_node_id
      WHERE s.org_id = ${orgId} AND s.latitude IS NOT NULL AND n.path @> ${node.path}::ltree
      ORDER BY nlevel(n.path) DESC, s.created_at LIMIT 1`;
    const [source] = row.rendered_post_id
      ? await sql<{ body: string; language: string }[]>`
          SELECT body, language FROM rendered_posts WHERE org_id = ${orgId} AND id = ${row.rendered_post_id}`
      : row.post_creative_id
        ? await sql<{ body: string; language: string }[]>`
            SELECT body, language FROM post_creatives WHERE org_id = ${orgId} AND id = ${row.post_creative_id}`
        : [];
    return { account, node, region, project, org, source, pin };
  });
  if (!context.account) return finish({ state: "FAILED", error: { code: "NOT_FOUND", retryable: false, message: "The account this was going to is gone." } });

  // An ad speaks as the Page and Instagram account this node publishes to,
  // and a Leads ad files its form under that Page with the Page's own token.
  let page: StepContext["page"] = null;
  let whatsappNumber: string | null = null;
  if (row.destination === "META_AD") {
    const resolved = await destinationsFor(orgId, context.node.path);
    const fb = resolved.get("FACEBOOK_PAGE");
    const ig = resolved.get("INSTAGRAM");
    if (fb?.ok) {
      const pageToken = row.ad_goal === "LEADS" ? await tokenFor(orgId, fb.to.account.id) : null;
      page = {
        id: fb.to.account.externalId,
        instagramId: ig?.ok ? ig.to.account.externalId : null,
        token: pageToken?.ok ? pageToken.token : null,
      };
    }
    if (row.ad_goal === "WHATSAPP") whatsappNumber = await whatsappNumberAt(orgId, context.node.path);
  }
  const google = row.destination.startsWith("GOOGLE_") && isAd(row.destination);
  const brand = isAd(row.destination) ? await resolveBrand(orgId, row.scope_node_id) : null;
  const endpoint = google ? captureEndpoint(orgId) : null;
  const scopes = google
    ? await withTenant(orgId, async (sql) => {
        const [c] = await sql<{ scopes: string[] }[]>`
          SELECT c.scopes FROM connection_accounts a JOIN connections c ON c.id = a.connection_id
          WHERE a.org_id = ${orgId} AND a.id = ${row.account_id}`;
        return c?.scopes ?? [];
      })
    : [];

  const fit = fitFor(row.destination, { kind: row.kind, placement: row.placement, media: row.media });
  const format: Format = fit.ok ? fit.as : "PHOTO";

  const steps: Steps = { ...(row.steps ?? {}) };
  const ctx: StepContext = {
    orgId,
    targetId,
    key: row.idempotency_key,
    place: context.node.name,
    city: context.region?.name ?? null,
    pin: context.pin ? { lat: Number(context.pin.lat), lng: Number(context.pin.lng) } : null,
    format,
    headline: row.headline,
    body: context.source?.body ?? row.headline,
    caption: row.caption,
    language: context.source?.language ?? "English",
    media: row.media,
    bytes: (i) => (row.media[i] ? readAsset(row.media[i].key) : Promise.resolve(null)),
    publicUrl: (i) => (row.media[i] ? platformUrl(row.media[i].key, row.media[i].type) : Promise.resolve(null)),
    steps,
    save: async (patch) => {
      Object.assign(steps, patch);
      const [held] = await withTenant(orgId, (sql) =>
        sql<{ id: string }[]>`
          UPDATE publish_targets SET steps = steps || ${sql.json(patch as never)}, updated_at = now()
          WHERE org_id = ${orgId} AND id = ${targetId} AND lease_id = ${lease}
          RETURNING id`);
      if (!held) throw new Error("lease lost");
    },
    token: credential.token,
    account: { externalId: context.account.external_id, name: context.account.name, detail: context.account.detail ?? {} },
    page,
    goal: row.ad_goal,
    whatsappNumber,
    privacyUrl: cleanPrivacyUrl(brand?.kit.privacyUrl),
    leadWebhook: endpoint ? { url: endpoint, key: orgCaptureKey(orgId) } : null,
    logo: google ? () => logoFor(orgId, row.scope_node_id) : undefined,
    bundle: (steps.bundle as CampaignBundle | undefined) ?? null,
    youtube: youtubeAllowed(scopes),
    dailyBudget: row.daily_budget,
    destinationUrl: row.destination_url,
    endsAt: row.ends_at,
    optimise:
      row.destination === "META_AD" && context.account.qualified_bidding && context.account.qualified_dataset && context.account.qualified_conversion
        ? { datasetId: context.account.qualified_dataset, conversionId: context.account.qualified_conversion }
        : null,
    businessNames: [context.org?.display_name ?? "", context.project?.name ?? "", context.node.name].filter(Boolean),
    now,
  };

  let outcome: StepOutcome;
  try {
    outcome = await RUNNERS[row.destination](ctx);
  } catch (e) {
    if (String(e).includes("lease lost")) return { state: "WORKING", error: null };
    outcome = { kind: "fail", error: { code: "TRANSIENT", retryable: true, message: "Something went wrong publishing this." } };
  }

  if (outcome.kind === "done") {
    if (outcome.note) await ctx.save({ note: outcome.note });
    const result = await finish({
      state: outcome.state,
      externalUrl: outcome.externalUrl,
      publishedAt: true,
    });
    if (!verdict.ok) {
      // It went out on an earlier attempt, before the gate closed. It is up,
      // so it is flagged for a person rather than pretended away.
      await withTenant(orgId, (sql) => sql`
        UPDATE publish_targets SET blocked_at = now() WHERE org_id = ${orgId} AND id = ${targetId}`);
    }
    await audit({
      orgId,
      actorUserId: null,
      action: isAd(row.destination) ? "publish.ad_created" : "publish.live",
      targetType: "publish_target",
      targetId,
      metadata: { destination: row.destination, attempts: row.attempts },
    });

    // A scheduled ad was decided before it was made: by whoever approved it,
    // or by the schedule's mode. So it is switched on as soon as it exists,
    // asked of the gate first like any switch-on. One that will not switch on
    // stays paused, with the reason, for a person to press.
    let out: Advanced = result;
    if (outcome.state === "PAUSED" && row.switch_on && verdict.ok) {
      const on = await switchSpend(orgId, {
        destination: row.destination,
        state: "PAUSED",
        account_id: row.account_id,
        steps,
        phase_id: row.phase_id,
        scope_node_path: context.node.path,
        source: row.source,
        rendered_post_id: row.rendered_post_id,
        post_creative_id: row.post_creative_id,
        ends_at: row.ends_at,
      }, true);
      if (on.ok) {
        await withTenant(orgId, (sql) => sql`
          UPDATE publish_targets
          SET state = 'ACTIVE', activated_at = now(), activated_by = ${row.requested_by}, paused_reason = NULL,
              updated_at = now()
          WHERE org_id = ${orgId} AND id = ${targetId} AND state = 'PAUSED'`);
        await audit({
          orgId,
          actorUserId: row.requested_by,
          action: "publish.activated",
          targetType: "publish_target",
          targetId,
          metadata: { destination: row.destination, by: "schedule", budget: row.daily_budget },
        });
        out = { state: "ACTIVE", error: null };
      } else {
        await withTenant(orgId, (sql) => sql`
          UPDATE publish_targets
          SET steps = steps || ${sql.json({ note: `Created, but it could not be switched on: ${on.message}` } as never)},
              updated_at = now()
          WHERE org_id = ${orgId} AND id = ${targetId}`);
      }
    }
    if (row.post_creative_id && (out.state === "LIVE" || out.state === "ACTIVE")) {
      await withTenant(orgId, (sql) => sql`
        UPDATE post_creatives SET state = 'PUBLISHED', publish_note = NULL
        WHERE org_id = ${orgId} AND id = ${row.post_creative_id} AND state IN ('APPROVED', 'PUBLISHED')`);
    }
    return out;
  }

  if (outcome.kind === "wait") {
    const waitingSince = typeof steps.waiting_since === "string" ? new Date(steps.waiting_since) : now;
    if (!steps.waiting_since) await ctx.save({ waiting_since: now.toISOString() });
    if (now.getTime() - waitingSince.getTime() > PROCESSING_LIMIT_MS) {
      return finish({
        state: "FAILED",
        error: { code: "TRANSIENT", retryable: false, message: "The platform took too long to process this." },
      });
    }
    return finish({ state: "QUEUED", notBefore: new Date(now.getTime() + outcome.ms), refund: true });
  }

  const e = outcome.error;
  if (e.code === "TOKEN_INVALID" || e.code === "PERMISSION") await markBroken(orgId, credential.connectionId, e);
  const failure = { ...e, message: e.message || ERROR_ADVICE[e.code] };
  if (e.retryable && row.attempts < MAX_PUBLISH_ATTEMPTS) {
    return finish({ state: "QUEUED", error: failure, notBefore: new Date(now.getTime() + backoffMs(row.attempts)) });
  }
  const result = await finish({ state: "FAILED", error: failure });
  await audit({
    orgId,
    actorUserId: null,
    action: "publish.failed",
    targetType: "publish_target",
    targetId,
    metadata: { destination: row.destination, code: e.code, attempts: row.attempts },
  });
  return result;
}

// ---------------------------------------------------------------------------
// A person's controls
// ---------------------------------------------------------------------------

type ControlRow = {
  destination: Destination;
  state: TargetState;
  account_id: string;
  steps: Steps;
  phase_id: string;
  scope_node_path: string;
  source: "STUDIO" | "SCHEDULE" | "BRIEF";
  rendered_post_id: string | null;
  post_creative_id: string | null;
  ends_at: Date | null;
  brief_id?: string | null;
};

export async function loadControl(orgId: string, targetId: string): Promise<ControlRow | null> {
  if (!isNodeId(targetId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<ControlRow[]>`
      SELECT t.destination, t.state, t.account_id, t.steps, t.phase_id, n.path::text AS scope_node_path,
             t.source, t.rendered_post_id, t.post_creative_id, t.ends_at, t.brief_id
      FROM publish_targets t JOIN scope_nodes n ON n.id = t.scope_node_id
      WHERE t.org_id = ${orgId} AND t.id = ${targetId}`;
    return r ?? null;
  });
}

async function switchSpend(orgId: string, row: ControlRow, on: boolean): Promise<{ ok: true } | ({ ok: false } & PlatformError)> {
  const credential = await tokenFor(orgId, row.account_id);
  if (!credential.ok) return credential;
  if (row.destination === "META_AD") {
    const r = await setMetaAdSpend(credential.token, row.steps, on);
    if (!r.ok && (r.code === "TOKEN_INVALID" || r.code === "PERMISSION")) await markBroken(orgId, credential.connectionId, r);
    return r.ok ? { ok: true } : r;
  }
  const account = await withTenant(orgId, async (sql) => {
    const [a] = await sql<{ external_id: string; detail: Record<string, unknown> }[]>`
      SELECT external_id, detail FROM connection_accounts WHERE org_id = ${orgId} AND id = ${row.account_id}`;
    return a;
  });
  const r = await setGoogleAdSpend({
    access: credential.token,
    customerId: account.external_id,
    login: typeof account.detail.login_customer_id === "string" ? account.detail.login_customer_id : null,
    steps: row.steps,
    on,
  });
  if (!r.ok && (r.code === "TOKEN_INVALID" || r.code === "PERMISSION")) await markBroken(orgId, credential.connectionId, r);
  return r.ok ? { ok: true } : r;
}

/** Stop an ad spending. Anybody who may stop a campaign may do this; nothing is asked first. */
export async function pausePublication(input: { orgId: string; userId: string; targetId: string }): Promise<{ ok: true } | Refusal> {
  const row = await loadControl(input.orgId, input.targetId);
  if (!row) return { ok: false, code: "UNKNOWN", message: "That publication is not here." };
  if (!canPause(row.destination, row.state)) return { ok: false, code: "NOT_SPENDING", message: "This is not spending." };
  const r = await switchSpend(input.orgId, row, false);
  if (!r.ok) return { ok: false, code: r.code, message: `It could not be paused: ${r.message}` };
  await withTenant(input.orgId, (sql) => sql`
    UPDATE publish_targets
    SET state = 'PAUSED', paused_at = now(), paused_by = ${input.userId}, paused_reason = 'PERSON', updated_at = now()
    WHERE org_id = ${input.orgId} AND id = ${input.targetId}`);
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "publish.paused",
    targetType: "publish_target",
    targetId: input.targetId,
    metadata: { destination: row.destination },
  });
  return { ok: true };
}

/**
 * Pause every ad spending through one provider, before it is disconnected.
 *
 * Disconnecting takes the token away, and without it nothing here can pause
 * an ad again. An ad left running in somebody's account with no way back to
 * it from the console is the one outcome a disconnect must never produce.
 */
export async function pauseEverySpending(input: {
  orgId: string;
  userId: string;
  provider: "META" | "GOOGLE";
}): Promise<{ paused: number; failed: number }> {
  const spending = await withTenant(input.orgId, (sql) =>
    sql<{ id: string }[]>`
      SELECT t.id FROM publish_targets t
      JOIN connection_accounts a ON a.id = t.account_id
      JOIN connections c ON c.id = a.connection_id
      WHERE t.org_id = ${input.orgId} AND t.state = 'ACTIVE' AND c.provider = ${input.provider}`);
  let paused = 0;
  let failed = 0;
  for (const s of spending) {
    const r = await pausePublication({ orgId: input.orgId, userId: input.userId, targetId: s.id });
    if (r.ok) paused += 1;
    else failed += 1;
  }
  return { paused, failed };
}

/**
 * Start an ad spending. A person with the budget key, and only after the
 * registration is asked again: a paused ad on a phase that has since lapsed
 * stays paused, whoever presses the button.
 */
export async function activatePublication(input: {
  orgId: string;
  userId: string;
  targetId: string;
  now?: Date;
}): Promise<{ ok: true } | Refusal> {
  const row = await loadControl(input.orgId, input.targetId);
  if (!row) return { ok: false, code: "UNKNOWN", message: "That publication is not here." };
  if (!canActivate(row.destination, row.state)) return { ok: false, code: "NOT_PAUSED", message: "Only a paused ad can be switched on." };
  if (row.ends_at && row.ends_at.getTime() <= (input.now ?? new Date()).getTime()) {
    return { ok: false, code: "ENDED", message: "This ad has run for the days it was given." };
  }
  const verdict = await canPublish(input.orgId, row.phase_id, input.now ?? new Date());
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };
  const r = await switchSpend(input.orgId, row, true);
  if (!r.ok) return { ok: false, code: r.code, message: `It could not be switched on: ${r.message}` };
  await withTenant(input.orgId, (sql) => sql`
    UPDATE publish_targets
    SET state = 'ACTIVE', activated_at = now(), activated_by = ${input.userId}, paused_reason = NULL, updated_at = now()
    WHERE org_id = ${input.orgId} AND id = ${input.targetId}`);
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "publish.activated",
    targetType: "publish_target",
    targetId: input.targetId,
    metadata: { destination: row.destination },
  });
  return { ok: true };
}

/**
 * Try a failed publication again. The gates are asked again first, from the
 * post it came from, because a retry is a publication too. The steps already
 * confirmed are kept, so it resumes rather than starting over.
 */
export async function retryPublication(input: {
  orgId: string;
  userId: string;
  targetId: string;
  now?: Date;
}): Promise<{ ok: true; state: TargetState; error: string | null } | Refusal> {
  const now = input.now ?? new Date();
  const row = await loadControl(input.orgId, input.targetId);
  if (!row) return { ok: false, code: "UNKNOWN", message: "That publication is not here." };
  if (!canRetry(row.state)) return { ok: false, code: "NOT_FAILED", message: "Only a failed publication can be tried again." };
  if (row.source === "BRIEF") {
    // A brief's campaign is asked of the gates again from its brief.
    if (!row.brief_id) return { ok: false, code: "SOURCE_GONE", message: "The campaign this came from was removed." };
    const built = await buildBundle(input.orgId, row.brief_id, row.destination, now);
    if (!built.ok) return built;
  } else {
    const source: Source | null = row.rendered_post_id
      ? { kind: "STUDIO", postId: row.rendered_post_id }
      : row.post_creative_id
        ? { kind: "SCHEDULE", creativeId: row.post_creative_id }
        : null;
    if (!source) return { ok: false, code: "SOURCE_GONE", message: "The post this came from was removed." };
    const prepared = await prepare(input.orgId, source, now);
    if (!prepared.ok) return prepared;
  }

  await withTenant(input.orgId, (sql) => sql`
    UPDATE publish_targets
    SET state = 'QUEUED', attempts = 0, not_before = ${now}, error_code = NULL, error = NULL, updated_at = now()
    WHERE org_id = ${input.orgId} AND id = ${input.targetId} AND state = 'FAILED'`);
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "publish.retried",
    targetType: "publish_target",
    targetId: input.targetId,
    metadata: { destination: row.destination },
  });
  const done = await advance(input.orgId, input.targetId, { now });
  return { ok: true, state: done.state, error: done.error };
}

/** A person says an organic post on a blocked phase has been taken down. */
export async function markTakenDown(input: { orgId: string; userId: string; targetId: string }): Promise<{ ok: true } | Refusal> {
  if (!isNodeId(input.targetId)) return { ok: false, code: "UNKNOWN", message: "That publication is not here." };
  const [done] = await withTenant(input.orgId, (sql) =>
    sql<{ destination: Destination }[]>`
      UPDATE publish_targets
      SET state = 'CANCELLED', error_code = 'TAKEN_DOWN', error = NULL, updated_at = now()
      WHERE org_id = ${input.orgId} AND id = ${input.targetId} AND state = 'LIVE' AND blocked_at IS NOT NULL
      RETURNING destination`);
  if (!done) return { ok: false, code: "NOT_FLAGGED", message: "That post is not waiting to be taken down." };
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "publish.taken_down",
    targetType: "publish_target",
    targetId: input.targetId,
    metadata: { destination: done.destination },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

export type HaltReport = { paused: number; flagged: number; cancelled: number; unflagged: number; couldNotPause: number };

/**
 * Stop what a blocked phase is advertising.
 *
 * Asked of the current state every time, not of the transitions a sweep saw,
 * so an ad missed once (the platform was down) is paused on the next pass,
 * and running it twice changes nothing the second time.
 */
export async function haltBlocked(orgId: string, now = new Date()): Promise<HaltReport> {
  const report: HaltReport = { paused: 0, flagged: 0, cancelled: 0, unflagged: 0, couldNotPause: 0 };
  const summary = await complianceSummary(orgId, now);
  const blocked = new Set(summary.blocked.map((p) => p.phaseId));
  const open = new Set(summary.phases.filter((p) => p.ok).map((p) => p.phaseId));
  // A broadcast still sending on a blocked phase stops too.
  await haltBroadcasts(orgId, [...blocked]);

  const rows = await withTenant(orgId, (sql) =>
    sql<{ id: string; destination: Destination; state: TargetState; phase_id: string; blocked_at: Date | null }[]>`
      SELECT id, destination, state, phase_id, blocked_at FROM publish_targets
      WHERE org_id = ${orgId} AND state IN ('QUEUED', 'WORKING', 'LIVE', 'ACTIVE')`);

  // A phase that is advertisable again clears its flags.
  const clear = rows.filter((r) => r.blocked_at && open.has(r.phase_id)).map((r) => r.id);
  if (clear.length) {
    await withTenant(orgId, (sql) => sql`
      UPDATE publish_targets SET blocked_at = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ANY(${clear})`);
    report.unflagged = clear.length;
  }
  if (!blocked.size) return report;

  const plan = haltPlan(
    rows.map((r) => ({ id: r.id, destination: r.destination, state: r.state, phaseId: r.phase_id, blockedAt: r.blocked_at })),
    blocked,
  );

  for (const id of plan.pause) {
    const row = await loadControl(orgId, id);
    if (!row) continue;
    const r = await switchSpend(orgId, row, false);
    if (!r.ok) {
      // Tried again next pass. Recorded, so the screen can say it is still spending.
      report.couldNotPause += 1;
      await withTenant(orgId, (sql) => sql`
        UPDATE publish_targets SET error_code = ${r.code}, error = ${`Could not pause: ${r.message}`.slice(0, 300)}, updated_at = now()
        WHERE org_id = ${orgId} AND id = ${id}`);
      continue;
    }
    await withTenant(orgId, (sql) => sql`
      UPDATE publish_targets
      SET state = 'PAUSED', paused_at = now(), paused_by = NULL, paused_reason = 'REGISTRATION',
          error_code = NULL, error = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${id} AND state = 'ACTIVE'`);
    report.paused += 1;
    await audit({
      orgId,
      actorUserId: null,
      action: "publish.paused_by_gate",
      targetType: "publish_target",
      targetId: id,
      metadata: { destination: row.destination, phase_id: row.phase_id },
    });
  }

  if (plan.cancel.length) {
    const cancelled = await withTenant(orgId, (sql) =>
      sql<{ id: string }[]>`
        UPDATE publish_targets
        SET state = 'CANCELLED', error_code = 'NOT_ADVERTISABLE',
            error = 'The project stopped being advertisable before this went out.', updated_at = now()
        WHERE org_id = ${orgId} AND id = ANY(${plan.cancel})
          AND (state = 'QUEUED' OR (state = 'WORKING' AND lease_until <= now()))
        RETURNING id`);
    report.cancelled = cancelled.length;
  }
  if (plan.flag.length) {
    await withTenant(orgId, (sql) => sql`
      UPDATE publish_targets SET blocked_at = ${now}, updated_at = now()
      WHERE org_id = ${orgId} AND id = ANY(${plan.flag}) AND blocked_at IS NULL`);
    report.flagged = plan.flag.length;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Scheduled posts
// ---------------------------------------------------------------------------

/** How long after its publish time an approved post may still go out. Past it, it expires. */
export const PUBLISH_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * Approved scheduled posts whose time has come, handed to each destination
 * their schedule names.
 *
 * A refusal is written as a FAILED publication with its reason rather than
 * skipped, so it shows on the queue and the next pass does not ask again.
 */
export async function enqueueScheduled(orgId: string, now = new Date()): Promise<number> {
  const due = await withTenant(orgId, (sql) =>
    sql<{
      id: string;
      destinations: string[];
      decided_by: string | null;
      outlet: string;
      ad_daily_budget: number | null;
      ad_days: number;
      ad_goal: AdGoal;
    }[]>`
      SELECT c.id, s.destinations, c.decided_by, r.outlet, s.ad_daily_budget, s.ad_days, s.ad_goal
      FROM post_creatives c
      JOIN post_runs r ON r.id = c.run_id
      JOIN post_schedules s ON s.id = r.schedule_id
      WHERE c.org_id = ${orgId} AND c.state = 'APPROVED' AND s.active
        AND cardinality(s.destinations) > 0
        AND r.publish_at <= ${now} AND r.publish_at > ${new Date(now.getTime() - PUBLISH_GRACE_MS)}
        AND NOT EXISTS (SELECT 1 FROM publish_targets t WHERE t.post_creative_id = c.id)
      ORDER BY r.publish_at
      LIMIT 50`);

  let made = 0;
  for (const c of due) {
    const prepared = await prepare(orgId, { kind: "SCHEDULE", creativeId: c.id }, now);
    const node = prepared.ok ? prepared.node : null;
    const resolved = node ? await destinationsFor(orgId, node.path) : null;
    // How this run's entry said it goes out: organic, an ad, or both.
    const outlet: Outlet = isOutlet(c.outlet) ? c.outlet : "POST";
    for (const raw of c.destinations) {
      if (!isDestination(raw)) continue;
      if (isAd(raw) ? !SCHEDULE_AD_DESTINATIONS.includes(raw) || !usesAd(outlet) : !usesPost(outlet)) continue;
      const r = resolved?.get(raw);
      if (!prepared.ok || !r || !r.ok) {
        // Nowhere to put a publication without an account, so the reason is
        // written on the creative, where the queue reads it, and asked again
        // next pass: fixing the cause inside the window is enough.
        const why = !prepared.ok ? prepared.message : r && !r.ok ? r.reason : "Nowhere to publish this.";
        await withTenant(orgId, (sql) => sql`
          UPDATE post_creatives SET publish_note = ${why.slice(0, 300)}
          WHERE org_id = ${orgId} AND id = ${c.id}`);
        continue;
      }
      const fit = fitFor(raw, { kind: prepared.kind, placement: prepared.placement, media: prepared.media });
      let dailyBudget: number | null = null;
      let destinationUrl: string | null = raw === "GOOGLE_BUSINESS" ? landingUrl(prepared.website) : null;
      let endsAt: Date | null = null;
      if (isAd(raw)) {
        // The budget the schedule set, asked against the account's own limit
        // today: a limit lowered since the schedule was saved still holds.
        const budget = budgetCheck({
          raw: c.ad_daily_budget === null ? null : String(c.ad_daily_budget),
          cap: r.to.account.dailyCap,
          currency: r.to.account.detail.currency ?? null,
        });
        destinationUrl = landingUrl(prepared.website) ?? enquiryUrl(orgId, prepared.phase.id);
        if (!budget.ok || !destinationUrl) {
          const why = !budget.ok ? budget.reason : "An ad needs the page it sends people to.";
          await withTenant(orgId, (sql) => sql`
            UPDATE post_creatives SET publish_note = ${why.slice(0, 300)}
            WHERE org_id = ${orgId} AND id = ${c.id}`);
          continue;
        }
        dailyBudget = budget.rupees;
        endsAt = new Date(now.getTime() + c.ad_days * 86_400_000);
      }
      // A Meta ad goes out for the schedule's goal, asked again today: a
      // privacy link removed or a WhatsApp number disconnected since stops it.
      let adGoal: AdGoal | null = null;
      let why: string | null = null;
      if (raw === "META_AD") {
        adGoal = isAdGoal(c.ad_goal) ? c.ad_goal : "TRAFFIC";
        why = goalProblem(adGoal, await goalFacts(orgId, prepared, !!resolved?.get("FACEBOOK_PAGE")?.ok));
      }
      if (raw === "GOOGLE_DEMAND_GEN_AD") why = await demandGenProblem(orgId, prepared, prepared.media, r.to.scopes);
      if (why) {
        await withTenant(orgId, (sql) => sql`
          UPDATE post_creatives SET publish_note = ${why.slice(0, 300)}
          WHERE org_id = ${orgId} AND id = ${c.id}`);
        continue;
      }
      const t = await insertTarget(orgId, {
        source: "SCHEDULE",
        prepared,
        destination: raw,
        to: r.to,
        adGoal,
        steps:
          raw === "GOOGLE_DEMAND_GEN_AD"
            ? { registration: prepared.registration }
            : raw === "META_AD" && adGoal === "LEADS"
              ? { form: formSpec(prepared.form) }
              : undefined,
        media: prepared.media,
        dailyBudget,
        destinationUrl,
        requestedBy: c.decided_by,
        notBefore: now,
        switchOn: isAd(raw),
        endsAt,
      });
      if (t.created && !fit.ok) {
        await withTenant(orgId, (sql) => sql`
          UPDATE publish_targets SET state = 'FAILED', error_code = 'INVALID', error = ${fit.reason}
          WHERE org_id = ${orgId} AND id = ${t.id}`);
      }
      if (t.created) made += 1;
    }
  }
  return made;
}

/**
 * Stop the scheduled ads that have run their days.
 *
 * Meta is told the end time when the ad is made, so it stops delivering on
 * its own; this is the second hand on the same switch, and the one that
 * makes the screen say so. It reads current state, so an ad the platform
 * would not pause today is asked again on the next pass.
 */
export async function endDueAds(orgId: string, now = new Date()): Promise<{ ended: number; couldNotPause: number }> {
  const due = await withTenant(orgId, (sql) =>
    sql<(ControlRow & { id: string })[]>`
      SELECT t.id, t.destination, t.state, t.account_id, t.steps, t.phase_id, n.path::text AS scope_node_path,
             t.source, t.rendered_post_id, t.post_creative_id, t.ends_at
      FROM publish_targets t JOIN scope_nodes n ON n.id = t.scope_node_id
      WHERE t.org_id = ${orgId} AND t.ends_at IS NOT NULL AND t.ends_at <= ${now}
        AND (t.state = 'ACTIVE' OR (t.state = 'PAUSED' AND t.paused_reason IS DISTINCT FROM 'ENDED'))`);
  let ended = 0;
  let couldNotPause = 0;
  for (const row of due) {
    if (row.state === "ACTIVE") {
      const off = await switchSpend(orgId, row, false);
      if (!off.ok) {
        couldNotPause += 1;
        continue;
      }
    }
    await withTenant(orgId, (sql) => sql`
      UPDATE publish_targets
      SET state = 'PAUSED', paused_at = COALESCE(paused_at, now()), paused_reason = 'ENDED', updated_at = now()
      WHERE org_id = ${orgId} AND id = ${row.id}`);
    await audit({
      orgId,
      actorUserId: null,
      action: "publish.ended",
      targetType: "publish_target",
      targetId: row.id,
      metadata: { destination: row.destination },
    });
    ended += 1;
  }
  return { ended, couldNotPause };
}

// ---------------------------------------------------------------------------
// A brief's always-on campaigns: Google Search and Performance Max
// ---------------------------------------------------------------------------

type Bundled = {
  ok: true;
  bundle: CampaignBundle;
  media: Media[];
  headline: string;
  caption: string;
  node: Prepared["node"];
  phase: Prepared["phase"];
  website: string | null;
  privacyUrl: string | null;
};

/**
 * What a brief's Search or Performance Max campaign says and shows, built
 * fresh from today's facts and asked of every gate.
 *
 * The registration first, then the brief's cards, each gated again against
 * today's ground (a card cleared last week on a price since superseded does
 * not go out). Then the words Google will mix, made only from those cards
 * and signed facts (`google-ad-rules.ts`), and gated once more as a block,
 * the registration line aside, because it is the gate's own number. For
 * Performance Max, the brief's pictures that passed the pixel gate and still
 * print today's price and place.
 */
export async function buildBundle(
  orgId: string,
  briefId: string,
  destination: Destination,
  now = new Date(),
): Promise<Bundled | Refusal> {
  if (!isNodeId(briefId)) return { ok: false, code: "UNKNOWN", message: "That campaign is not in this organisation." };
  if (!isAlwaysOn(destination)) return { ok: false, code: "UNKNOWN", message: "That is not a campaign this runs." };
  const brief = await withTenant(orgId, async (sql) => {
    const [b] = await sql<{ id: string; name: string; unit_type_ids: string[] | null; node_id: string; node_path: string; node_name: string; node_kind: string; org_name: string }[]>`
      SELECT b.id, b.name, b.unit_type_ids, n.id AS node_id, n.path::text AS node_path, n.name AS node_name,
             n.kind AS node_kind, o.display_name AS org_name
      FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id JOIN orgs o ON o.id = b.org_id
      WHERE b.org_id = ${orgId} AND b.id = ${briefId}`;
    return b ?? null;
  });
  if (!brief) return { ok: false, code: "UNKNOWN", message: "That campaign is not in this organisation." };
  const node = { id: brief.node_id, path: brief.node_path, name: brief.node_name, kind: brief.node_kind };

  const phase = await advertisingPhase(orgId, node.path, now);
  if (!phase) return { ok: false, code: "NOT_ADVERTISABLE", message: `${node.name} cannot be advertised today.` };
  const verdict = await canPublish(orgId, phase.phaseId, now);
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };

  const { ground } = await studioGround(orgId, node, now, brief.unit_type_ids ?? []);
  const extra = await withTenant(orgId, async (sql) => {
    const [reg] = await sql<{ state_code: string | null }[]>`
      SELECT state_code FROM registration_records WHERE org_id = ${orgId} AND scope_node_id = ${phase.phaseId}`;
    const [region] = await sql<{ name: string }[]>`
      SELECT name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'REGION' AND path @> ${node.path}::ltree LIMIT 1`;
    const [project] = await sql<{ name: string }[]>`
      SELECT name FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PROJECT' AND path @> ${node.path}::ltree LIMIT 1`;
    const cards = await sql<{ language: string; segment: Segment; headline: string; body: string; cta: string }[]>`
      SELECT language, segment, headline, body, cta FROM campaign_copy
      WHERE org_id = ${orgId} AND brief_id = ${briefId} AND verdict = 'PASS'
      ORDER BY generated_at DESC`;
    return { stateCode: reg?.state_code ?? null, city: region?.name ?? null, project: project?.name ?? null, cards };
  });
  // Google's words are mixed, so only cards that still clear today, and only
  // in the Latin script Google's English and Hinglish buyers read.
  const cards = extra.cards.filter((c) => {
    if (/[^\u0000-ɏ₹‘-”•\s]/.test(`${c.headline}${c.body}${c.cta}`)) return false;
    return gateCopy(c, { language: c.language, segment: c.segment }, ground, budgetFor([])).verdict === "PASS";
  });
  if (!cards.length) {
    return { ok: false, code: "NO_COPY", message: "Write this campaign's copy in the studio and clear at least one card in English or Hinglish first." };
  }
  const registration = registrationLine(verdict.registrationNo, extra.stateCode, verdict.permitNo);
  const brand = await resolveBrand(orgId, node.id);
  const businessNames = [extra.project ?? "", brief.org_name, node.name].filter(Boolean);
  const luxury = isLuxury(ground.configurations);
  const priced = ground.configurations
    .filter((c): c is typeof c & { startingPrice: number } => !!c.startingPrice && c.startingPrice > 0)
    .sort((a, b) => a.startingPrice - b.startingPrice)
    .slice(0, 3);
  const input = {
    cards,
    project: extra.project,
    tower: node.name,
    location: ground.location ?? null,
    points: sellingPoints(ground.talkingPoints, { luxury }),
    prices: priced.map((c) => ({ label: c.label, price: adPrice(c.startingPrice) })),
    registration,
    businessNames,
  };

  // Every line Google may show, gated as one block against today's ground.
  const gateLines = (lines: string[]) => {
    const g = gateCopy(
      { headline: cards[0].headline, body: lines.join("\n"), cta: cards[0].cta },
      { language: cards[0].language, segment: cards[0].segment },
      ground,
      { headline: 1000, body: 100_000, headlineFrom: null, bodyFrom: null },
    );
    return g.verdict === "PASS" ? null : g.reasons[0]?.detail ?? "Its words no longer clear against the approved facts.";
  };
  const withoutReg = (lines: string[]) => lines.map((l) => (registration ? l.replace(registration, "").trim() : l)).filter(Boolean);
  const leadForm = leadFormText({ project: extra.project, tower: node.name, cards, businessNames });

  if (destination === "GOOGLE_SEARCH_AD") {
    const text = searchAdText(input);
    if (!text.ok) return { ok: false, code: "NO_COPY", message: text.reason };
    const blocked = gateLines(withoutReg([...text.headlines, ...text.descriptions, ...text.callouts]));
    if (blocked) return { ok: false, code: "BLOCKED", message: `The search ad's words do not clear: ${blocked}` };
    const keywords = searchKeywords({
      project: extra.project,
      tower: node.name,
      location: ground.location ?? null,
      city: extra.city,
      configurations: ground.configurations.map((c) => c.label),
    });
    if (!keywords.length) return { ok: false, code: "NO_KEYWORDS", message: "Sign the project's name and exact location before running a search ad." };
    const bundle: CampaignBundle = {
      search: { ...text, keywords, negatives: [...NEGATIVE_KEYWORDS] },
      leadForm,
    };
    return {
      ok: true,
      bundle,
      media: [],
      headline: text.headlines[0],
      caption: [...text.headlines, ...text.descriptions].join("\n"),
      node,
      phase: { id: phase.phaseId, registrationNo: verdict.registrationNo, stateCode: extra.stateCode },
      website: brand?.kit.website ?? null,
      privacyUrl: cleanPrivacyUrl(brand?.kit.privacyUrl),
    };
  }

  const text = pmaxText(input);
  if (!text.ok) return { ok: false, code: "NO_COPY", message: text.reason };
  const blocked = gateLines(withoutReg([...text.headlines, ...text.longHeadlines, ...text.descriptions]));
  if (blocked) return { ok: false, code: "BLOCKED", message: `Performance Max's words do not clear: ${blocked}` };
  const posts = await withTenant(orgId, (sql) =>
    sql<{ kind: PostKind; media: Media[]; pixel: PixelRecord | null; facts: AdFacts | null }[]>`
      SELECT kind, media, pixel, inputs -> 'facts' AS facts FROM rendered_posts
      WHERE org_id = ${orgId} AND brief_id = ${briefId} AND kind IN ('IMAGE', 'VIDEO')
        AND (review IS NULL OR (review ->> 'passed')::boolean)
        AND pixel ->> 'verdict' = 'PASS'
      ORDER BY created_at DESC LIMIT 80`);
  const today = adFacts(ground);
  const current = posts.filter(
    (p) => p.media?.length && !pixelRefusal(p.pixel, p.media, verdict.registrationNo) && !staleFacts(p.facts, today),
  );
  const pictures = current.filter((p) => p.kind === "IMAGE").map((p) => p.media[0]);
  const picked = pmaxPictures(pictures);
  const gap = pmaxPictureGap(picked);
  if (gap) return { ok: false, code: "NO_PICTURES", message: gap };
  const chosen = [...picked.landscape, ...picked.square, ...picked.portrait].map((i) => pictures[i]);
  const video = current.find((p) => p.kind === "VIDEO" && p.media[0]?.type === "video/mp4")?.media[0] ?? null;
  const media = [...chosen, ...(video ? [video] : [])];
  const reindexed = pmaxPictures(chosen);
  const bundle: CampaignBundle = {
    pmax: text,
    leadForm,
    images: reindexed,
    videos: video ? [media.length - 1] : [],
  };
  return {
    ok: true,
    bundle,
    media,
    headline: text.headlines[0],
    caption: [...text.headlines, ...text.longHeadlines, ...text.descriptions].join("\n"),
    node,
    phase: { id: phase.phaseId, registrationNo: verdict.registrationNo, stateCode: extra.stateCode },
    website: brand?.kit.website ?? null,
    privacyUrl: cleanPrivacyUrl(brand?.kit.privacyUrl),
  };
}

export type AlwaysOnView = {
  destination: Destination;
  label: string;
  /** Why it cannot be started, or null. */
  reason: string | null;
  accountName: string | null;
  dailyCap: number | null;
  /** The live one, when there is one. */
  current: PublicationView | null;
  /** What the campaign will say, for a person to read before starting it. */
  preview: { headlines: string[]; descriptions: string[]; keywords: string[]; pictures: number; leadForm: boolean } | null;
};

/** The brief's two always-on campaigns: whether each can start, and the one running. */
export async function alwaysOnFor(orgId: string, briefId: string, now = new Date()): Promise<AlwaysOnView[]> {
  if (!isNodeId(briefId)) return [];
  const [b] = await withTenant(orgId, (sql) =>
    sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${orgId} AND b.id = ${briefId}`);
  if (!b) return [];
  const [resolved, live] = await Promise.all([
    destinationsFor(orgId, b.path),
    listPublications(orgId, { briefIds: [briefId] }),
  ]);
  const out: AlwaysOnView[] = [];
  for (const destination of ALWAYS_ON) {
    const r = resolved.get(destination);
    const built = await buildBundle(orgId, briefId, destination, now);
    let reason: string | null = r && !r.ok ? r.reason : !r ? "Not switched on for Sales Desk yet." : null;
    if (!reason && !built.ok) reason = built.message;
    if (!reason && r?.ok && r.to.account.dailyCap === null) reason = "Nobody has set a daily limit for this Google Ads account yet.";
    const current = live.find((p) => p.destination === destination && p.state !== "CANCELLED" && p.state !== "FAILED") ?? null;
    const failed = live.find((p) => p.destination === destination && p.state === "FAILED") ?? null;
    out.push({
      destination,
      label: destinationDef(destination).label,
      reason,
      accountName: r?.ok ? r.to.account.name : null,
      dailyCap: r?.ok ? r.to.account.dailyCap : null,
      current: current ?? failed,
      preview: built.ok
        ? {
            headlines: built.bundle.search?.headlines ?? built.bundle.pmax?.headlines ?? [],
            descriptions: built.bundle.search?.descriptions ?? built.bundle.pmax?.descriptions ?? [],
            keywords: built.bundle.search?.keywords ?? [],
            pictures: built.media.length,
            leadForm: !!built.bundle.leadForm && !!built.privacyUrl,
          }
        : null,
    });
  }
  return out;
}

/** The version of a brief's campaign a fresh start makes: one past every one ended. */
async function nextVersion(orgId: string, briefId: string, destination: Destination): Promise<number> {
  const [r] = await withTenant(orgId, (sql) =>
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM publish_targets
      WHERE org_id = ${orgId} AND brief_id = ${briefId} AND destination = ${destination} AND state = 'CANCELLED'`);
  return (r?.n ?? 0) + 1;
}

/**
 * Start a brief's Search or Performance Max campaign: built and gated now,
 * created paused like every ad, and switched on by a person with the budget
 * key. One live campaign of each kind per brief; ending one lets a new one
 * start.
 */
export async function requestAlwaysOn(input: {
  orgId: string;
  userId: string;
  briefId: string;
  destination: string;
  dailyBudget: string | null;
  destinationUrl?: string | null;
  now?: Date;
  inlineMs?: number;
}): Promise<{ ok: true; targetId: string; state: TargetState; message: string } | Refusal> {
  const now = input.now ?? new Date();
  if (!isDestination(input.destination) || !isAlwaysOn(input.destination)) {
    return { ok: false, code: "UNKNOWN", message: "That is not a campaign this runs." };
  }
  const destination = input.destination;
  const built = await buildBundle(input.orgId, input.briefId, destination, now);
  if (!built.ok) return built;
  const resolved = await destinationsFor(input.orgId, built.node.path);
  const r = resolved.get(destination);
  if (!r || !r.ok) return { ok: false, code: "NO_ACCOUNT", message: r && !r.ok ? r.reason : "Connect Google Ads first." };
  const budget = budgetCheck({ raw: input.dailyBudget, cap: r.to.account.dailyCap, currency: r.to.account.detail.currency ?? null });
  if (!budget.ok) return { ok: false, code: "BUDGET", message: budget.reason };
  const destinationUrl =
    landingUrl(input.destinationUrl) ?? landingUrl(built.website) ?? enquiryUrl(input.orgId, built.phase.id);
  if (!destinationUrl) return { ok: false, code: "NO_PAGE", message: "An ad needs the page it sends people to." };

  const live = await withTenant(input.orgId, (sql) =>
    sql<{ id: string; state: TargetState }[]>`
      SELECT id, state FROM publish_targets
      WHERE org_id = ${input.orgId} AND brief_id = ${input.briefId} AND destination = ${destination}
        AND state NOT IN ('CANCELLED', 'FAILED')
      LIMIT 1`);
  if (live[0]) return { ok: false, code: "RUNNING", message: `This campaign's ${destinationDef(destination).label} is already ${TARGET_LABEL[live[0].state].toLowerCase()}.` };

  const version = await nextVersion(input.orgId, input.briefId, destination);
  const t = await insertTarget(input.orgId, {
    source: "BRIEF",
    prepared: {
      sourceId: `${input.briefId}:${version}`,
      kind: destination === "GOOGLE_SEARCH_AD" ? "TEXT" : "BUNDLE",
      placement: null,
      headline: built.headline,
      caption: built.caption,
      node: built.node,
      phase: built.phase,
    },
    briefId: input.briefId,
    destination,
    to: r.to,
    media: built.media,
    dailyBudget: budget.rupees,
    destinationUrl,
    requestedBy: input.userId,
    notBefore: now,
    steps: { bundle: built.bundle },
  });
  if (!t.created) {
    return { ok: false, code: "RUNNING", message: t.state === "FAILED" ? "This was tried before and failed. Use Try again on it." : "It is already on its way." };
  }
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "publish.requested",
    targetType: "publish_target",
    targetId: t.id,
    metadata: { destination, source: "BRIEF", budget: budget.rupees, version },
  });
  const until = Date.now() + (input.inlineMs ?? 20_000);
  let done: Advanced = { state: t.state, error: null };
  if (Date.now() < until) done = await advance(input.orgId, t.id, { now });
  return {
    ok: true,
    targetId: t.id,
    state: done.state,
    message: done.state === "FAILED" ? done.error ?? "It could not be created." : describe(done.state, true),
  };
}

/**
 * End a brief's campaign for good: stopped at Google first when it is
 * spending, then marked ended here, so a new one can be started from today's
 * facts. The record of what ran stays.
 */
export async function endAlwaysOn(input: { orgId: string; userId: string; targetId: string }): Promise<{ ok: true } | Refusal> {
  const row = await loadControl(input.orgId, input.targetId);
  if (!row || row.source !== "BRIEF") return { ok: false, code: "UNKNOWN", message: "That campaign is not here." };
  if (row.state === "ACTIVE") {
    const off = await switchSpend(input.orgId, row, false);
    if (!off.ok) return { ok: false, code: off.code, message: `It could not be stopped: ${off.message}` };
  }
  if (row.state === "WORKING") return { ok: false, code: "BUSY", message: "It is being created right now. Try again in a minute." };
  await withTenant(input.orgId, (sql) => sql`
    UPDATE publish_targets
    SET state = 'CANCELLED', error_code = 'ENDED', error = NULL, paused_at = COALESCE(paused_at, now()),
        paused_by = ${input.userId}, updated_at = now()
    WHERE org_id = ${input.orgId} AND id = ${input.targetId} AND state IN ('QUEUED', 'PAUSED', 'ACTIVE', 'FAILED')`);
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "publish.ended",
    targetType: "publish_target",
    targetId: input.targetId,
    metadata: { destination: row.destination, by: "person" },
  });
  return { ok: true };
}

/**
 * Fresh pictures for each running Performance Max campaign: posts of its
 * brief that passed since it was made are added to its asset group, up to
 * Google's caps. Its words never change; a new set of words is a new start.
 */
export async function refreshAlwaysOn(orgId: string, now = new Date()): Promise<number> {
  const running = await withTenant(orgId, (sql) =>
    sql<{ id: string; brief_id: string; account_id: string; steps: Steps; media: Media[]; phase_id: string; registration_no: string | null }[]>`
      SELECT id, brief_id, account_id, steps, media, phase_id, registration_no FROM publish_targets
      WHERE org_id = ${orgId} AND destination = 'GOOGLE_PMAX_AD' AND state IN ('PAUSED', 'ACTIVE')
        AND brief_id IS NOT NULL AND steps ? 'asset_group'`);
  let added = 0;
  for (const t of running) {
    const verdict = await canPublish(orgId, t.phase_id, now);
    if (!verdict.ok) continue;
    const have = new Set(t.media.map((m) => m.key));
    const counts = pmaxPictures(t.media);
    const fresh = await withTenant(orgId, (sql) =>
      sql<{ media: Media[]; pixel: PixelRecord | null }[]>`
        SELECT media, pixel FROM rendered_posts
        WHERE org_id = ${orgId} AND brief_id = ${t.brief_id} AND kind = 'IMAGE'
          AND (review IS NULL OR (review ->> 'passed')::boolean)
          AND pixel ->> 'verdict' = 'PASS'
        ORDER BY created_at DESC LIMIT 40`);
    const fields: Record<"square" | "landscape" | "portrait", "SQUARE_MARKETING_IMAGE" | "MARKETING_IMAGE" | "PORTRAIT_MARKETING_IMAGE"> = {
      square: "SQUARE_MARKETING_IMAGE",
      landscape: "MARKETING_IMAGE",
      portrait: "PORTRAIT_MARKETING_IMAGE",
    };
    const room = { square: 20 - counts.square.length, landscape: 20 - counts.landscape.length, portrait: 20 - counts.portrait.length };
    const toAdd: { media: Media; field: (typeof fields)[keyof typeof fields] }[] = [];
    for (const p of fresh) {
      const m = p.media?.[0];
      if (!m || have.has(m.key) || pixelRefusal(p.pixel, p.media, verdict.registrationNo)) continue;
      const shape = pmaxPictures([m]);
      const kind = shape.square.length ? "square" : shape.landscape.length ? "landscape" : shape.portrait.length ? "portrait" : null;
      if (!kind || room[kind] <= 0) continue;
      room[kind] -= 1;
      toAdd.push({ media: m, field: fields[kind] });
      if (toAdd.length >= 5) break;
    }
    if (!toAdd.length) continue;
    const credential = await tokenFor(orgId, t.account_id);
    if (!credential.ok) continue;
    const account = await withTenant(orgId, async (sql) => {
      const [a] = await sql<{ external_id: string; detail: Record<string, unknown> }[]>`
        SELECT external_id, detail FROM connection_accounts WHERE org_id = ${orgId} AND id = ${t.account_id}`;
      return a;
    });
    const pictures: { name: string; bytes: Buffer; field: (typeof fields)[keyof typeof fields] }[] = [];
    for (const a of toAdd) {
      const bytes = await readAsset(a.media.key);
      if (bytes) pictures.push({ name: `Sales Desk · ${t.id.slice(0, 8)} · ${a.media.key.split("/").pop()}`, bytes, field: a.field });
    }
    const r = await addPmaxPictures({
      access: credential.token,
      customerId: account.external_id,
      login: typeof account.detail.login_customer_id === "string" ? account.detail.login_customer_id : null,
      assetGroup: String(t.steps.asset_group),
      pictures,
    });
    if (!r.ok) {
      if (r.code === "TOKEN_INVALID" || r.code === "PERMISSION") await markBroken(orgId, credential.connectionId, r);
      continue;
    }
    const media = [...t.media, ...toAdd.slice(0, r.value).map((a) => a.media)];
    await withTenant(orgId, (sql) => sql`
      UPDATE publish_targets SET media = ${sql.json(media as never)}, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${t.id}`);
    await audit({
      orgId,
      actorUserId: null,
      action: "publish.pictures_added",
      targetType: "publish_target",
      targetId: t.id,
      metadata: { destination: "GOOGLE_PMAX_AD", added: r.value },
    });
    added += r.value;
  }
  return added;
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

export type PublishReport = {
  orgsScanned: number;
  enqueued: number;
  advanced: number;
  live: number;
  adsCreated: number;
  waiting: number;
  failed: number;
  halted: HaltReport;
  checked: number;
  /** Scheduled ads stopped because they ran their days. */
  ended: number;
  /** New pictures added to running Performance Max campaigns. */
  picturesAdded: number;
};

/** How often each connection's token is asked whether it still works. */
export const HEALTH_CHECK_MS = 24 * 60 * 60 * 1000;

/**
 * One bounded pass: stop what a blocked phase is advertising, hand due
 * scheduled posts to their destinations, advance what is waiting, and ask
 * any connection not checked in a day whether it still works.
 *
 * The kill switch runs first, so a pass that runs out of budget has already
 * done the part that stops money.
 */
export async function publishDue(opts: { now?: Date; orgIds?: string[]; max?: number } = {}): Promise<PublishReport> {
  const now = opts.now ?? new Date();
  let budget = opts.max ?? 25;
  // Enumerating tenants is a platform job's control-plane act, as in
  // `runDue()` and the sweep. Everything done per tenant runs inside it.
  const orgs = await controlDb<{ id: string }[]>`
    SELECT id FROM orgs
    WHERE status <> 'SUSPENDED'
      ${opts.orgIds ? controlDb`AND id = ANY(${opts.orgIds})` : controlDb``}
    ORDER BY created_at`;

  const report: PublishReport = {
    orgsScanned: orgs.length,
    enqueued: 0,
    advanced: 0,
    live: 0,
    adsCreated: 0,
    waiting: 0,
    failed: 0,
    halted: { paused: 0, flagged: 0, cancelled: 0, unflagged: 0, couldNotPause: 0 },
    checked: 0,
    ended: 0,
    picturesAdded: 0,
  };

  for (const org of orgs) {
    const halted = await haltBlocked(org.id, now);
    for (const k of Object.keys(halted) as (keyof HaltReport)[]) report.halted[k] += halted[k];
    const ending = await endDueAds(org.id, now);
    report.ended += ending.ended;
    report.halted.couldNotPause += ending.couldNotPause;

    report.enqueued += await enqueueScheduled(org.id, now);
    report.picturesAdded += await refreshAlwaysOn(org.id, now);

    const due = await withTenant(org.id, (sql) =>
      sql<{ id: string }[]>`
        SELECT id FROM publish_targets
        WHERE org_id = ${org.id} AND not_before <= ${now} AND attempts < ${MAX_PUBLISH_ATTEMPTS}
          AND (state = 'QUEUED' OR (state = 'WORKING' AND lease_until <= now()))
        ORDER BY not_before
        LIMIT ${Math.max(budget, 0)}`);
    for (const t of due) {
      if (budget <= 0) break;
      budget -= 1;
      const done = await advance(org.id, t.id, { now });
      report.advanced += 1;
      if (done.state === "LIVE") report.live += 1;
      else if (done.state === "PAUSED") report.adsCreated += 1;
      else if (done.state === "QUEUED" || done.state === "WORKING") report.waiting += 1;
      else if (done.state === "FAILED") report.failed += 1;
    }

    const stale = await withTenant(org.id, (sql) =>
      sql<{ provider: "META" | "GOOGLE" }[]>`
        SELECT provider FROM connections
        WHERE org_id = ${org.id} AND status IN ('CONNECTED', 'PENDING')
          AND (last_checked_at IS NULL OR last_checked_at < ${new Date(now.getTime() - HEALTH_CHECK_MS)})`);
    for (const c of stale) {
      await checkConnection({ orgId: org.id, provider: c.provider, userId: null });
      report.checked += 1;
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Reading, for the screens
// ---------------------------------------------------------------------------

export type PublicationView = {
  id: string;
  destination: Destination;
  destinationLabel: string;
  ad: boolean;
  state: TargetState;
  stateLabel: string;
  accountName: string;
  nodeName: string;
  nodePath: string;
  headline: string;
  kind: TargetKind;
  placement: string | null;
  source: "STUDIO" | "SCHEDULE" | "BRIEF";
  renderedPostId: string | null;
  postCreativeId: string | null;
  firstMedia: { key: string; type: string; width: number; height: number } | null;
  registrationNo: string | null;
  dailyBudget: number | null;
  destinationUrl: string | null;
  externalUrl: string | null;
  error: string | null;
  errorCode: string | null;
  note: string | null;
  requestedByName: string | null;
  createdAt: string;
  publishedAt: string | null;
  pausedReason: "PERSON" | "REGISTRATION" | "ENDED" | null;
  blockedAt: string | null;
  phaseId: string;
  /** When a scheduled ad stops by itself. */
  endsAt: string | null;
  /** What a Meta ad is for, in words. */
  goalLabel: string | null;
  /** The brief an always-on campaign belongs to. */
  briefId: string | null;
};

type DbPublication = {
  id: string;
  destination: Destination;
  state: TargetState;
  account_name: string;
  node_name: string;
  node_path: string;
  headline: string;
  kind: TargetKind;
  placement: string | null;
  source: "STUDIO" | "SCHEDULE" | "BRIEF";
  rendered_post_id: string | null;
  post_creative_id: string | null;
  media: { key: string; type: string; width: number; height: number }[];
  registration_no: string | null;
  daily_budget: number | null;
  destination_url: string | null;
  external_url: string | null;
  error: string | null;
  error_code: string | null;
  steps: Steps;
  requested_by_name: string | null;
  created_at: Date;
  published_at: Date | null;
  paused_reason: "PERSON" | "REGISTRATION" | "ENDED" | null;
  blocked_at: Date | null;
  phase_id: string;
  ends_at: Date | null;
  ad_goal: string | null;
  brief_id: string | null;
};

const toPublication = (r: DbPublication): PublicationView => ({
  id: r.id,
  destination: r.destination,
  destinationLabel: destinationDef(r.destination).label,
  ad: isAd(r.destination),
  state: r.state,
  stateLabel: r.error_code === "TAKEN_DOWN" ? "Taken down" : TARGET_LABEL[r.state],
  accountName: r.account_name,
  nodeName: r.node_name,
  nodePath: r.node_path,
  headline: r.headline,
  kind: r.kind,
  placement: r.placement,
  source: r.source,
  renderedPostId: r.rendered_post_id,
  postCreativeId: r.post_creative_id,
  firstMedia: r.media?.[0] ?? null,
  registrationNo: r.registration_no,
  dailyBudget: r.daily_budget,
  destinationUrl: r.destination_url,
  externalUrl: r.external_url,
  error: r.error,
  errorCode: r.error_code,
  note: typeof r.steps?.note === "string" ? r.steps.note : null,
  requestedByName: r.requested_by_name,
  createdAt: r.created_at.toISOString(),
  publishedAt: r.published_at?.toISOString() ?? null,
  pausedReason: r.paused_reason,
  blockedAt: r.blocked_at?.toISOString() ?? null,
  phaseId: r.phase_id,
  endsAt: r.ends_at?.toISOString() ?? null,
  goalLabel: adGoalLabel(r.ad_goal),
  briefId: r.brief_id,
});

export async function listPublications(
  orgId: string,
  opts: { ids?: string[]; postIds?: string[]; creativeIds?: string[]; briefIds?: string[]; limit?: number; scopes?: string[] } = {},
): Promise<PublicationView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const posts = (opts.postIds ?? []).filter(isNodeId);
  const creatives = (opts.creativeIds ?? []).filter(isNodeId);
  const briefs = (opts.briefIds ?? []).filter(isNodeId);
  const ids = (opts.ids ?? []).filter(isNodeId);
  // Asked about particular posts and given none: the answer is none, not all.
  if ((opts.ids && !ids.length) || (opts.postIds && !posts.length) || (opts.creativeIds && !creatives.length) || (opts.briefIds && !briefs.length)) return [];
  const rows = await withTenant(orgId, (sql) =>
    sql<DbPublication[]>`
      SELECT t.id, t.destination, t.state, a.name AS account_name, n.name AS node_name, n.path::text AS node_path,
             t.headline, t.kind, t.placement, t.source, t.rendered_post_id, t.post_creative_id, t.media,
             t.registration_no, t.daily_budget, t.destination_url, t.external_url, t.error, t.error_code,
             t.steps, u.name AS requested_by_name, t.created_at, t.published_at, t.paused_reason, t.blocked_at,
             t.phase_id, t.ends_at, t.ad_goal, t.brief_id
      FROM publish_targets t
      JOIN connection_accounts a ON a.id = t.account_id
      JOIN scope_nodes n ON n.id = t.scope_node_id
      LEFT JOIN users u ON u.id = t.requested_by
      WHERE t.org_id = ${orgId}
        ${ids.length ? sql`AND t.id = ANY(${ids})` : sql``}
        ${posts.length ? sql`AND t.rendered_post_id = ANY(${posts})` : sql``}
        ${creatives.length ? sql`AND t.post_creative_id = ANY(${creatives})` : sql``}
        ${briefs.length ? sql`AND t.brief_id = ANY(${briefs})` : sql``}
        ${opts.scopes ? sql`AND n.path <@ ANY(${opts.scopes}::ltree[])` : sql``}
      ORDER BY t.created_at DESC
      LIMIT ${limit}`);
  return rows.map(toPublication);
}

export type HeldScheduled = {
  id: string;
  headline: string;
  scheduleName: string;
  nodeName: string;
  nodePath: string;
  publishAt: string;
  note: string;
};

/** Approved scheduled posts that could not go out, and why. Asked again every pass until their window closes. */
export async function heldScheduled(orgId: string): Promise<HeldScheduled[]> {
  const rows = await withTenant(orgId, (sql) =>
    sql<{ id: string; headline: string; schedule_name: string; node_name: string; node_path: string; publish_at: Date; publish_note: string }[]>`
      SELECT c.id, c.headline, s.name AS schedule_name, n.name AS node_name, n.path::text AS node_path,
             r.publish_at, c.publish_note
      FROM post_creatives c
      JOIN post_runs r ON r.id = c.run_id
      JOIN post_schedules s ON s.id = r.schedule_id
      JOIN scope_nodes n ON n.id = s.scope_node_id
      WHERE c.org_id = ${orgId} AND c.state = 'APPROVED' AND c.publish_note IS NOT NULL
      ORDER BY r.publish_at DESC
      LIMIT 50`);
  return rows.map((r) => ({
    id: r.id,
    headline: r.headline,
    scheduleName: r.schedule_name,
    nodeName: r.node_name,
    nodePath: r.node_path,
    publishAt: r.publish_at.toISOString(),
    note: r.publish_note,
  }));
}

/** The node a brief advertises, for the permission check at that node. */
export async function briefNodePath(orgId: string, briefId: string): Promise<string | null> {
  if (!isNodeId(briefId)) return null;
  const [r] = await withTenant(orgId, (sql) =>
    sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${orgId} AND b.id = ${briefId}`);
  return r?.path ?? null;
}

/** The node a studio post advertises, for the permission check at that node. */
export async function postNodePath(orgId: string, postId: string): Promise<string | null> {
  if (!isNodeId(postId)) return null;
  const [r] = await withTenant(orgId, (sql) =>
    sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM rendered_posts p JOIN scope_nodes n ON n.id = p.scope_node_id
      WHERE p.org_id = ${orgId} AND p.id = ${postId}`);
  return r?.path ?? null;
}

/** One publication's first file, for the route that shows it on the Live screen. */
export async function publicationMedia(orgId: string, targetId: string): Promise<{ key: string; type: string } | null> {
  if (!isNodeId(targetId)) return null;
  const [r] = await withTenant(orgId, (sql) =>
    sql<{ media: { key: string; type: string }[] }[]>`
      SELECT media FROM publish_targets WHERE org_id = ${orgId} AND id = ${targetId}`);
  return r?.media?.[0] ?? null;
}

/**
 * The gates a studio post passes before it goes anywhere, asked for another
 * outlet: a channel partner's co-branded copy. The same `prepare()` a
 * publication asks, so a partner's copy can never clear where the post
 * itself would not: the registration fresh, the copy against today's facts,
 * and the price and place on the picture still current.
 */
export async function clearsForOutlet(
  orgId: string,
  postId: string,
  now = new Date(),
): Promise<{ ok: true; media: Media[]; nodePath: string; registrationNo: string | null } | Refusal> {
  const p = await prepare(orgId, { kind: "STUDIO", postId }, now);
  if (!p.ok) return p;
  return { ok: true, media: p.media, nodePath: p.node.path, registrationNo: p.phase.registrationNo };
}

/**
 * The publisher's own gates, for a broadcast: the same `prepare()` a
 * publication asks (the registration fresh, the pixel gate on these very
 * files, the copy against today's facts, the price and place on the
 * picture), so a broadcast can never go where the post itself could not.
 */
export async function preparePublication(
  orgId: string,
  source: { kind: "STUDIO"; postId: string } | { kind: "SCHEDULE"; creativeId: string },
  now = new Date(),
) {
  return prepare(orgId, source, now);
}
