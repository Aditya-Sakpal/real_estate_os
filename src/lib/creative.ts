import { randomUUID } from "node:crypto";
import { activeLanguages } from "./campaign-rules.ts";
import { type JSONValue } from "postgres";
import { withTenant, audit } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import { resolveBrain } from "./brain.ts";
import { loadBrand } from "./brand.ts";
import { languagesWithoutAFace } from "./brand-rules.ts";
import { approvedUnits } from "./unit.ts";
import { fromSqft, priceFor } from "./unit-rules.ts";
import { complianceSummary } from "./publish-gate.ts";
import { putAsset, removeAsset, assetUrl, sha256 } from "./storage.ts";
import { projectOfNode } from "./storage-place.ts";
import { isServiceDown } from "./service-rules.ts";
import { monthYear } from "./film-rules.ts";
import { adRuleFor, hasTravelTime } from "./rera-ad-rules.ts";
import { knows, orderByLearning, type Blended } from "./learning-rules.ts";
import { learningFor } from "./learning.ts";
import { approvedAssets } from "./asset.ts";
import { constructionIsStale, istDay } from "./asset-rules.ts";
import { angleLines, isCardAngle, materialFrom, planAngleCards, type CardAngle, type CardMaterial } from "./card-angle-rules.ts";
import {
  betterAttempt,
  connectivityPoint,
  feedbackFor,
  hasSellingPoint,
  leadLine,
  meaningfulOffer,
  needsRewrite,
  MAX_WRITE_ATTEMPTS,
  NO_POINTS_MESSAGE,
  storedGround,
  adPrice,
  moneyIn,
  sellingPoints,
  isLuxury,
  withoutFactLines,
  budgetFor,
  backdropPrompt,
  canGenerate,
  gateCopy,
  groundFrom,
  planCopy,
  segmentLabel,
  type Budget,
  MAX_COPY_BLOCKS,
  type Copy,
  type CopySpec,
  type Ground,
  type Reason,
  type Segment,
  type Verdict,
  hookIsApproved,
  storedLocal,
  writesLatin,
  type LocalLines,
} from "./creative-rules.ts";
import {
  drawBackdrop,
  writeCopy,
  readCopy,
  COPY_MODEL,
  IMAGE_MODEL,
  type ImageDriver,
  type CopyDriver,
  type ReadDriver,
} from "./generate.ts";

/**
 * Campaign Studio: reads, writes, and the one call to somebody else's model.
 *
 * The order in `generateBlocks()` is the whole design and it is the order
 * Section 08 gives. Resolve the registration first, because a phase nobody
 * may advertise is not worth writing copy for. Resolve the Brain second,
 * because the facts are what the copy is allowed to contain. Write third.
 * Gate fourth, against the facts and never against the prompt.
 *
 * A prompt asking a model to behave is not a control. `gateCopy()` is the
 * control, and it runs on what came back whether the model cooperated or not.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type CopyBlock = {
  id: string;
  language: string;
  segment: Segment;
  segmentLabel: string;
  /** What the card is written for: any ad, or one kind of template. */
  angle: CardAngle;
  headline: string;
  body: string;
  cta: string;
  verdict: Verdict;
  reasons: Reason[];
  model: string;
  generatedAt: string;
  generatedByName: string | null;
  /** What the verdict was reached against, so a screen can tell a stale block. */
  ground: Ground | null;
  /** A card in Hindi or another script of its own: its place, its points and its reading. */
  local: LocalLines | null;
};

export type Backdrop = {
  id: string;
  role: string;
  prompt: string;
  model: string;
  mediaType: string;
  mediaBytes: number;
  createdAt: string;
};

export type StudioView = {
  briefId: string;
  briefName: string;
  node: { id: string; name: string; path: string; kind: string };
  languages: string[];
  formats: string[];
  /** What the gate will measure against, so the screen can say what is missing. */
  ground: Ground;
  brainSources: { versionId: string; path: string; version: number }[];
  budget: Budget;
  planned: CopySpec[];
  blocks: CopyBlock[];
  backdrops: Backdrop[];
  /** What the project holds that each kind of template needs. */
  material: CardMaterial;
};

export type StudioOutcome =
  | {
      ok: true;
      written: number;
      passed: number;
      held: number;
      failed: number;
      /** Somebody pressed stop. What was written before it stays. */
      stopped: boolean;
    }
  | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// Stopping a run
// ---------------------------------------------------------------------------

/**
 * Longer than a run can take, so a live row older than this belongs to a
 * server that died mid-run. Thirty six blocks, four at a time, sixty seconds
 * each, is nine minutes; fifteen leaves room.
 */
export const STALE_RUN_MINUTES = 30;

/** How often a run looks to see whether somebody pressed stop. */
export const STOP_POLL_MS = 1_500;

type RunStart = { ok: true; runId: string } | { ok: false };

/**
 * Claim the brief for one run.
 *
 * The partial unique index is the lock: a second run on the same brief
 * conflicts rather than paying for the same blocks twice and overwriting the
 * first run's copy in whatever order the model answered. A live row older
 * than `STALE_RUN_MINUTES` is closed first, because a server that died
 * mid-run never closes its own.
 */
async function startCopyRun(orgId: string, briefId: string, userId: string): Promise<RunStart> {
  return withTenant(orgId, async (sql) => {
    await sql`
      UPDATE copy_runs SET finished_at = now()
      WHERE org_id = ${orgId} AND brief_id = ${briefId} AND finished_at IS NULL
        AND started_at < now() - make_interval(mins => ${STALE_RUN_MINUTES})`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO copy_runs (org_id, brief_id, started_by)
      VALUES (${orgId}, ${briefId}, ${userId})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    return row ? { ok: true as const, runId: row.id } : { ok: false as const };
  });
}

async function finishCopyRun(orgId: string, runId: string, written: number): Promise<void> {
  await withTenant(orgId, async (sql) => {
    await sql`
      UPDATE copy_runs SET finished_at = now(), written = ${written}
      WHERE org_id = ${orgId} AND id = ${runId}`;
  });
}

async function runStopped(orgId: string, runId: string): Promise<boolean> {
  return withTenant(orgId, async (sql) => {
    const [row] = await sql<{ cancelled_at: Date | null }[]>`
      SELECT cancelled_at FROM copy_runs WHERE org_id = ${orgId} AND id = ${runId}`;
    return !!row?.cancelled_at;
  });
}

/**
 * Ask the live run on a brief to stop.
 *
 * It sets a flag rather than killing anything, because the run may be on
 * another instance. The run reads it within `STOP_POLL_MS`, aborts the calls
 * in flight, and writes nothing further. Blocks already written stay: each
 * one was gated on its own, and throwing away finished work is not what
 * "stop" means.
 */
export async function stopCopyRun(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
}): Promise<{ ok: boolean }> {
  if (!isNodeId(opts.briefId)) return { ok: false };
  const stopped = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      UPDATE copy_runs SET cancelled_at = now(), cancelled_by = ${opts.actorUserId}
      WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId}
        AND finished_at IS NULL AND cancelled_at IS NULL
      RETURNING id`;
    return row ?? null;
  });
  return { ok: !!stopped };
}

/**
 * Everything a verdict is reached against, gathered from where it is signed.
 *
 * A brief can hang off a PROJECT or a PHASE, and only a phase carries a
 * registration. For a project the gate uses the phase underneath it with the
 * most life left in its registration, because an advertisement carries one
 * number and that number has to belong to something currently advertisable.
 * A project with no advertisable phase is not advertisable, which is the
 * fail-closed reading and the only one Section 3 supports.
 */
export async function studioGround(
  orgId: string,
  node: { id: string; path: string; kind: string },
  now = new Date(),
  /**
   * The configurations this push is for. Empty means every one the node
   * sells, which is what every brief written before this column existed
   * meant. Ids that do not resolve to an APPROVED configuration at or below
   * this node simply drop out, which is the same treatment a node id
   * arriving from a form gets: read it back in this tenant, believe what
   * comes back, and nothing else.
   */
  unitTypeIds: readonly string[] = [],
): Promise<{
  ground: Ground;
  brainSources: { versionId: string; path: string; version: number }[];
}> {
  const summary = await complianceSummary(orgId, now);
  const under = summary.phases.filter(
    (p) => p.path === node.path || p.path.startsWith(`${node.path}.`),
  );
  const best = under
    .filter((p) => p.ok)
    .sort((a, b) => (b.daysLeft ?? 0) - (a.daysLeft ?? 0))[0];

  const brain = await resolveBrain(orgId, node.id);
  const brand = await loadBrand(orgId, node.id);
  const covered = brand?.resolved.typefaceLanguages ?? [];

  // Approved configurations only, and the price is worked out here rather
  // than stored: `starting_price` overrides when somebody set one, and the
  // signed rate per sq ft computes it when nobody did. Both halves are
  // separately approved, so neither is a number a model or a marketer typed.
  const [{ units, basePsf }, above] = await Promise.all([
    approvedUnits(orgId, node.id),
    // The city is the REGION the project sits under: a developer names a city
    // when creating a project, so it is always there when nothing is signed.
    // The project's and the tower's names come from the same read.
    withTenant(orgId, async (sql) =>
      sql<{ kind: string; name: string }[]>`
        SELECT kind, name FROM scope_nodes
        WHERE org_id = ${orgId} AND kind IN ('REGION', 'PROJECT', 'PHASE')
          AND path @> ${node.path}::ltree`,
    ),
  ]);
  const city = above.find((n) => n.kind === "REGION")?.name ?? null;
  const names = above.filter((n) => n.kind !== "REGION").map((n) => n.name);
  const wanted = new Set(unitTypeIds);
  const configurations = (wanted.size ? units.filter((u) => wanted.has(u.id)) : units).map((u) => ({
    config: u.config,
    label: u.label,
    startingPrice: priceFor(u, basePsf),
    areaSqft: u.carpetAreaSqft ?? null,
    plotArea: u.plotAreaSqft ? fromSqft(u.plotAreaSqft, u.areaUnit) : null,
  }));

  return {
    ground: groundFrom({
      values: brain?.values ?? {},
      configurations,
      advertisable: !!best,
      registrationNo: best?.registrationNo ?? null,
      registrationState: best?.stateCode ?? null,
      permitNo: best?.permitNo ?? null,
      registrationDaysLeft: best?.daysLeft ?? null,
      // No coverage recorded is unknown rather than no, so an unrecorded face
      // holds nothing. That rule lives in `languagesWithoutAFace()`.
      facelessLanguages: languagesWithoutAFace([], covered),
      city,
      names,
    }),
    brainSources: brain?.sources ?? [],
  };
}

export async function openStudio(orgId: string, briefId: string): Promise<StudioView | null> {
  if (!isNodeId(briefId)) return null;

  const head = await withTenant(orgId, async (sql) => {
    const [row] = await sql<
      {
        id: string;
        name: string;
        languages: string[];
        formats: string[];
        unit_type_ids: string[];
        offers: string | null;
        node_id: string;
        node_name: string;
        path: string;
        kind: string;
      }[]
    >`
      SELECT b.id, b.name, b.languages, b.formats, b.unit_type_ids, b.offers,
             n.id AS node_id, n.name AS node_name, n.path::text AS path, n.kind
      FROM campaign_briefs b
      JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${orgId} AND b.id = ${briefId}
      LIMIT 1
    `;
    return row ?? null;
  });
  if (!head) return null;
  // Only the languages switched on: a card in another is neither listed nor written.
  head.languages = activeLanguages(head.languages);

  const node = { id: head.node_id, name: head.node_name, path: head.path, kind: head.kind };
  const { ground, brainSources } = await studioGround(
    orgId,
    node,
    new Date(),
    head.unit_type_ids ?? [],
  );

  // The brief's own languages, measured against the face that has to set them.
  const faceless = languagesWithoutAFace(
    head.languages,
    (await loadBrand(orgId, node.id))?.resolved.typefaceLanguages ?? [],
  );
  ground.facelessLanguages = faceless;

  const [stored, backdrops, material] = await Promise.all([
    listBlocks(orgId, briefId),
    listBackdrops(orgId, briefId),
    materialFor(orgId, node.id, ground, head.offers),
  ]);
  const general = planCopy({ languages: head.languages });
  const budget = budgetFor(head.formats);
  // Only the languages the brief asks for now: a card written in one it has
  // since dropped (Hinglish, before 1 October 2026) is kept as a record and
  // never offered again.
  const current = stored.filter((b) => head.languages.includes(b.language));
  const blocks = await regateStored(orgId, briefId, current, budget, ground);

  return {
    briefId: head.id,
    briefName: head.name,
    node,
    languages: head.languages,
    formats: head.formats,
    ground,
    brainSources,
    budget,
    // One card per language and buyer, and one per language for every kind
    // of template the project can support, so every template has a card.
    planned: [...general, ...planAngleCards({ languages: head.languages, segments: general.map((p) => p.segment), material })],
    blocks,
    backdrops,
    material,
  };
}

/**
 * What the project holds that each kind of template needs: the signed facts
 * the ground already carries, the campaign's offer, and how many approved,
 * dated construction photos are fresh enough for a construction update.
 */
export async function materialFor(
  orgId: string,
  nodeId: string,
  ground: Pick<Ground, "talkingPoints" | "configurations" | "possessionDate">,
  offers: string | null,
  now = new Date(),
): Promise<CardMaterial> {
  const site = await approvedAssets(orgId, nodeId)
    .then((a) => a.filter((x) => x.category === "CONSTRUCTION" && !constructionIsStale(x.capturedOn, now)).length)
    .catch(() => 0);
  return materialFrom({ ground, offers, constructionPhotos: site, today: istDay(now) });
}

const RANK: Record<Verdict, number> = { PASS: 0, HOLD: 1, FAIL: 2 };

/**
 * A brief's cards as today's gate sees them, saved where it is stricter.
 * For anything that takes a stored PASS at its word (making a post, an
 * action Jimmy offers) without opening the studio first.
 */
export async function regateBrief(orgId: string, briefId: string): Promise<CopyBlock[]> {
  return (await openStudio(orgId, briefId))?.blocks ?? [];
}

/**
 * Stored cards measured again by today's gate, on the facts each was written
 * against.
 *
 * A verdict is stored with its card, and the gate has since learned to check
 * things it did not: a card saying "8 min from the station" on a tower with
 * no such fact was stored as cleared, because only money, rates and years
 * were measured then. Read back, each card is gated again on its own stored
 * ground, and one the gate would now hold or refuse is saved that way, so
 * nothing downstream (a post, a publish, Ask Jimmy) can take it for cleared.
 *
 * Only ever tighter, and only on the card's own ground. Facts that moved
 * since are the staleness note's business, and loosening on a read would let
 * a card clear without anybody writing it again.
 */
async function regateStored(
  orgId: string,
  briefId: string,
  blocks: CopyBlock[],
  budget: Budget,
  /** Today's ground, for the two things a card stored before them lacks. */
  current: Ground,
): Promise<CopyBlock[]> {
  const worse: { block: CopyBlock; verdict: Verdict; reasons: Reason[] }[] = [];
  const out = blocks.map((b) => {
    // Held by the retired typeface rule alone (1 October 2026): measured
    // again on its own ground, and what today's gate says stands, looser
    // included, because the only thing that changed is a rule taken away.
    const retired = b.reasons.some((r) => r.code === "NO_FACE_FOR_LANGUAGE");
    if (!b.ground || (b.verdict === "FAIL" && !retired)) return b;
    // A card stored before the ground carried names and carpet areas is
    // given today's: they only widen which numbers count as signed, and a
    // card is not refused for a number the gate could not see then.
    const area = new Map(current.configurations.map((c) => [c.config, c.areaSqft ?? null]));
    const kept = storedGround(b.ground);
    const ground: Ground = {
      ...kept,
      names: kept.names ?? current.names,
      configurations: kept.configurations.map((c) => ({ ...c, areaSqft: c.areaSqft ?? area.get(c.config) ?? null })),
    };
    const now = gateCopy(
      { headline: b.headline, body: b.body, cta: b.cta },
      { language: b.language, segment: b.segment, angle: b.angle },
      ground,
      budget,
      b.local,
    );
    if (!retired && RANK[now.verdict] <= RANK[b.verdict]) return b;
    worse.push({ block: b, verdict: now.verdict, reasons: now.reasons });
    return { ...b, verdict: now.verdict, reasons: now.reasons };
  });
  if (worse.length) {
    await withTenant(orgId, async (sql) => {
      for (const w of worse) {
        // Guarded by what was read, so a rewrite landing meanwhile is never overwritten.
        await sql`
          UPDATE campaign_copy
          SET verdict = ${w.verdict}, reasons = ${sql.json(w.reasons as unknown as JSONValue)}
          WHERE org_id = ${orgId} AND brief_id = ${briefId} AND id = ${w.block.id}
            AND verdict = ${w.block.verdict}
            AND date_trunc('milliseconds', generated_at) = ${new Date(w.block.generatedAt)}`;
      }
    }).catch(() => {
      // The screen still shows the stricter verdict; the next read saves it.
    });
  }
  return out;
}

export async function listBlocks(orgId: string, briefId: string): Promise<CopyBlock[]> {
  if (!isNodeId(briefId)) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<
      {
        id: string;
        language: string;
        segment: Segment;
        angle: string | null;
        headline: string;
        body: string;
        cta: string;
        verdict: Verdict;
        reasons: Reason[];
        model: string;
        generated_at: Date;
        generated_by_name: string | null;
        ground: Ground | null;
        local: unknown;
      }[]
    >`
      SELECT c.id, c.language, c.segment, c.angle, c.headline, c.body, c.cta,
             c.verdict, c.reasons, c.model, c.generated_at, c.ground, c.local,
             u.name AS generated_by_name
      FROM campaign_copy c
      LEFT JOIN users u ON u.id = c.generated_by
      WHERE c.org_id = ${orgId} AND c.brief_id = ${briefId}
      ORDER BY c.language, c.angle = 'GENERAL' DESC, c.segment, c.angle
    `;
  });
  return rows.map((r) => ({
    id: r.id,
    language: r.language,
    segment: r.segment,
    segmentLabel: segmentLabel(r.segment),
    angle: isCardAngle(r.angle) ? r.angle : "GENERAL",
    headline: r.headline,
    body: r.body,
    cta: r.cta,
    verdict: r.verdict,
    reasons: r.reasons ?? [],
    model: r.model,
    generatedAt: r.generated_at.toISOString(),
    generatedByName: r.generated_by_name,
    // The column defaults to `{}`: a card stored without its ground has no
    // ground to be measured against, not an empty one to be refused on.
    ground: r.ground && Object.keys(r.ground).length ? r.ground : null,
    local: storedLocal(r.local),
  }));
}

// ---------------------------------------------------------------------------
// Writing copy
// ---------------------------------------------------------------------------

/** How many blocks are written at once. Small enough not to earn a 429. */
export const BLOCK_CONCURRENCY = 4;

/**
 * What the model is told, which is not what the model is trusted on.
 *
 * Only published facts go in. The never-say list goes in as an instruction
 * and is checked afterwards regardless, because a list of banned phrases in a
 * prompt is a request and `gateCopy()` is the refusal.
 */
export function instructionFor(input: {
  spec: CopySpec;
  ground: Ground;
  budget: Budget;
  brief: { objective: string | null; audience: string | null; cta: string | null; hook: string | null; offers: string | null };
  project: string;
  /** What was wrong with the last attempt at this block, when there was one. */
  feedback?: string | null;
  /** What has worked here, ours and the market's. It orders the approved points; it adds none. */
  learned?: readonly Blended[];
}): {
  system: string;
  instruction: string;
  /** A card in a script of its own: the place and the points are asked for too. */
  local?: true;
  /** The approved points it was asked to say in that script, in the order asked. */
  points?: string[];
} {
  const system = [
    "You write advertising copy for Indian real estate developers, to the standard of the country's best:",
    "Godrej, Lodha, Rustomjee, Oberoi, Piramal.",
    "Use only the approved facts you are given. Never state a price, a percentage,",
    "a rate of return or a possession year that is not in those facts.",
    "Never promise returns, rental income or appreciation.",
    "The audience line says who will read the ad, not where the project is.",
    "Never say or suggest the project is in a place named in the audience.",
    "Write for the language and buyer named, in that language's own script and nothing else:",
    "an English ad is all English, a Hindi ad all Hindi in Devanagari. Never mix the two, and never write Hinglish.",
    "Return only the fields asked for.",
  ].join(" ");
  // The talking points an ad is built on, strongest first, spec sheet left out.
  const luxury = isLuxury(input.ground.configurations);
  // With something learnt about what an ad should lead with, the approved
  // point whose angle has worked best goes first and the writer is told to
  // lead with it: still only ever an approved point.
  const learnt = !!input.learned && knows(input.learned, "angle");
  const ranked = sellingPoints(input.ground.talkingPoints, { luxury });
  const points = learnt ? orderByLearning(ranked, input.learned!) : ranked;
  const loc = input.ground.location;
  const own = !writesLatin(input.spec.language);
  // A card written for one kind of template is told what that kind says,
  // and a greeting is never handed the campaign's offer or its call to buy.
  const angle: CardAngle = input.spec.angle ?? "GENERAL";
  const offer = meaningfulOffer(input.brief.offers);
  const angled = angleLines(angle, { ground: input.ground, project: input.project, offer: angle === "OFFER" ? offer ?? points.find((p) => /offer|waiver|discount|scheme/i.test(p)) ?? null : offer });
  const greeting = angle === "GREETING";
  // A card in its own script also gives the place and the points in it, for
  // the ad's location line and a carousel's slides. Asked once, in this order.
  const localPoints = own ? points.slice(0, LOCAL_POINTS) : [];
  // The body says how it connects only when an approved fact says so. Asked
  // for it anyway, with an example, the writer copied the example. Where the
  // registering state forbids a travel time, a fact that is one is not
  // offered as the body line.
  const ad = adRuleFor(input.ground.registrationState);
  const connectsRaw = connectivityPoint(points, { luxury });
  const connects = connectsRaw && ad?.noTravelTime && hasTravelTime(connectsRaw) ? null : connectsRaw;

  const lines = [
    `Project: ${input.project}`,
    `Language: ${input.spec.language}`,
    `Buyer: ${segmentLabel(input.spec.segment)}`,
    input.brief.audience ? `Audience: ${input.brief.audience}` : null,
    angled.length
      ? "Lead the headline the way THIS CARD says below."
      : learnt && points.length && !hookIsApproved(input.brief.hook, points) ? `Lead with: ${points[0]}` : leadLine(input.brief.hook, points),
    offer && !greeting ? `Offer: ${offer}` : null,
    input.brief.cta && !greeting ? `Call to action: ${input.brief.cta}` : null,
    ...(angled.length ? ["", ...angled] : []),
    "",
    loc
      ? `Location: ${loc}. The project is in ${loc} and nowhere else: never name the city, and never name another ` +
        "place as where it is, and never mention a place or a distance the approved facts do not. " +
        (own
          ? `Write ${loc} in ${input.spec.language} letters, spelt the way it is usually spelt, and the same way every time.`
          : `Write ${loc} exactly as it is written here, in these letters.`)
      : null,
    "",
    "Approved facts, strongest first, and nothing outside them may be stated:",
    ...points.map((p) => `  - ${p}`),
    // As an ad says it (June 2029), never as the record stores it (2029-06-30).
    input.ground.possessionDate ? `  - Possession: ${monthYear(input.ground.possessionDate)}` : null,
    ...input.ground.money.map((m) => `  - ${inAdFormat(m)}`),
    // A bare number in a list of facts gets printed as a bare number.
    "",
    // Labelled per configuration, because the model otherwise has one price
    // and several products and will pair them however the sentence scans.
    // The gate refuses the wrong pairing either way; saying it here is what
    // stops most of them being generated at all.
    ...(input.ground.configurations.length
      ? [
          "Configurations, each with the price that belongs to it, written the way it must be printed:",
          ...input.ground.configurations.map(
            (c) =>
              `  - ${c.label}: ${
                c.startingPrice === null
                  ? "no approved price, so do not quote one"
                  : `starting ${adPrice(c.startingPrice)}*`
              }`,
          ),
          "Quote a configuration only with its own price. Where several are named together,",
          "the price stated must belong to one of those named.",
          "",
        ]
      : []),
    input.ground.neverSay.length
      ? `Never say any of these, in any wording: ${input.ground.neverSay.join(", ")}`
      : null,
    "",
    "How the best Indian property ads are written, and so how you write:",
    "  - Headline: the one selling point, in two to five words, the way a buyer says it: 'Sea Facing",
    "    Apartments', 'Lake View Homes'. Take it from the strongest fact you can use, the first listed unless the",
    "    lead line says otherwise. Never the whole fact as a sentence ('Sea facing from the 18th floor up'), and",
    "    never the building's plan or layout.",
    "  - Lead with what buyers choose a home for: where it is and how close things are, the view, the open",
    "    space and acres, the amenities. Never the building's services or the spec sheet: lifts, flooring,",
    "    fittings, parking, power backup, water supply, structure.",
    "  - The ad prints the location and the starting prices on lines of their own. Do not put them in any of",
    "    the three fields, including the call to action, in any script: printed twice they look like a mistake.",
    "    If a price must be said anywhere, it is written exactly as given above, never as a full rupee figure:",
    "    \u20b92.19 Cr*, never Rs 2,18,24,000.",
    "  - No number of your own: every number you write (minutes, acres, floors, towers, a date) must be in the",
    "    approved facts above.",
    connects
      ? `  - Body: one short line saying how it connects, from this approved fact and only this: "${connects}". ` +
        "In the fewest words, the way a buyer says it."
      : "  - Body: one short line with the next strongest approved fact, as short as it can be said.",
    "    Nothing else in the body: no second fact, no layout, no podium, no list. Less is what reads as premium.",
    "  - One adjective at most for a home (spacious, premium). No superlatives nobody can prove: best, finest,",
    "    first, only, most, number one.",
    ad?.noTravelTime
      ? `  - ${ad.authority} does not allow a travel time on an ad. Never write minutes or hours to anywhere; a ` +
        "distance may be said only where an approved fact gives one."
      : null,
    ad?.noTermsApply ? `  - ${ad.authority} does not allow "T&C apply" or any mention of terms and conditions.` : null,
    "",
    `Headline: at most ${input.budget.headline} characters.`,
    `Body: at most ${input.budget.body} characters.`,
    ...(own ? scriptRules(input.spec.language, loc ?? null, localPoints) : []),
  ].filter((l): l is string => l !== null);

  if (input.feedback) lines.push("", input.feedback);

  return own
    ? { system, instruction: lines.join("\n"), local: true, points: localPoints }
    : { system, instruction: lines.join("\n") };
}

/** How many approved points a card in its own script says in it: a carousel's longest run of point slides. */
const LOCAL_POINTS = 8;

/** Hindi's and Marathi's words for what an ad prints, so every card says them alike. */
const SCRIPT_WORDS: Record<string, string> = {
  Hindi: "BHK as बीएचके, a crore as करोड़, a lakh as लाख",
  Marathi: "BHK as बीएचके, a crore as कोटी, a lakh as लाख",
};

/**
 * What a card in a script of its own is told beyond the copy: every word in
 * that script, numbers in digits, and the place and points in it too.
 */
function scriptRules(language: string, loc: string | null, points: readonly string[]): string[] {
  return [
    "",
    `Every word in ${language}, in its own script: the project's name, the place, the call to action, all of it.`,
    "No English word and no English letter anywhere, not even BHK, Cr or a brand name.",
    `Numbers in digits (0 to 9), the rupee as \u20b9${SCRIPT_WORDS[language] ? `, ${SCRIPT_WORDS[language]}` : ""}.`,
    loc
      ? `place: ${loc}, written in ${language} as above. Wherever the copy names it, spell it exactly as in place.`
      : "place: leave it empty.",
    points.length
      ? `points: each of these approved facts in ${language}, in this order, as short as it is, with exactly its numbers:`
      : "points: leave it empty.",
    ...points.map((p, i) => `  ${i + 1}. ${p}`),
  ];
}

/**
 * What the reader is told: put a card back into English exactly as it is
 * written, for the gate to read. It corrects nothing, because a correction
 * would hide the very thing the gate is looking for.
 */
export function readingInstruction(input: {
  language: string;
  copy: Copy;
  place: string | null;
  points: readonly string[];
}): { system: string; instruction: string } {
  const system = [
    "You translate Indian real estate advertising copy into plain English, word for word, for a compliance check.",
    "Translate exactly what is written: add nothing, drop nothing, correct nothing, and soften nothing.",
    "Keep every number exactly as written, in digits, with its unit.",
    "Write a place name in English letters the way the original spells it: its usual English spelling when it is",
    "spelt the usual way, and letter for letter when it is not.",
  ].join(" ");
  const instruction = [
    `Language: ${input.language}`,
    `Headline: ${input.copy.headline}`,
    `Body: ${input.copy.body}`,
    `Call to action: ${input.copy.cta}`,
    `Place: ${input.place ?? ""}`,
    "Points:",
    ...input.points.map((p, i) => `  ${i + 1}. ${p}`),
    "",
    "Return the headline, body, call to action, place and every point, in the same order, in English.",
  ].join("\n");
  return { system, instruction };
}

/** A labelled amount ("Booking amount: Rs 5,00,000") as an ad prints it: "Booking amount: \u20b95 Lakh". */
function inAdFormat(labelled: string): string {
  const n = moneyIn(labelled)[0];
  return n && n >= 1e5 ? labelled.replace(/(?:Rs\.?|\u20b9)\s*[\d,]+(?:\.\d+)?/, adPrice(n)) : labelled;
}

/**
 * Write one block, check it, and write it again while the model is at fault.
 *
 * The client used to be shown every refusal and asked to press "write it
 * again" until the model got it right, which is asking them to do our job.
 * So the loop happens here: an attempt the gate refuses for something the
 * model wrote is sent back with the gate's own words about what was wrong,
 * up to `MAX_WRITE_ATTEMPTS` times, and the best attempt is what anybody
 * sees. A refusal a rewrite cannot clear (a typeface that cannot set the
 * language, a registration about to lapse) stops the loop at once, because a
 * second attempt would cost money and change nothing.
 *
 * A call that fails outright counts as an attempt too. A model that answers
 * nothing three times running is not going to answer on the fourth, and the
 * attempt budget is also the spending budget.
 *
 * Used by the studio and by scheduled runs, so the two cannot drift.
 */
export type CheckedBlock = {
  copy: Copy;
  verdict: Verdict;
  reasons: Reason[];
  attempts: number;
  /** A card in a script of its own: its place, its points and how it read. */
  local: LocalLines | null;
};

export async function writeChecked(opts: {
  spec: CopySpec;
  ground: Ground;
  budget: Budget;
  build: (feedback: string | null) => { system: string; instruction: string; local?: true; points?: string[] };
  write: CopyDriver;
  /** Reads a card in a script of its own back into English. Injected in checks. */
  read?: ReadDriver;
  signal?: AbortSignal;
  /** Told of each call the model refused; a refusal from a service that is down ends the attempts. */
  onRefused?: (failure: { code: string; message: string }) => void;
}): Promise<CheckedBlock | null> {
  let best: CheckedBlock | null = null;
  let last: CheckedBlock | null = null;
  let tried = 0;

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) break;
    tried = attempt;
    const feedback = last ? feedbackFor(last.copy, last.reasons) : null;
    const asked = opts.build(feedback);
    const result = await opts.write(
      asked.local
        ? { system: asked.system, instruction: asked.instruction, local: true }
        : { system: asked.system, instruction: asked.instruction },
      { signal: opts.signal },
    );
    if (opts.signal?.aborted) break;
    if (!result.ok) {
      opts.onRefused?.({ code: result.code, message: result.message });
      // Out of credits or down: the next attempt is refused the same way.
      if (isServiceDown(result.code)) break;
      continue;
    }

    // A card in a script of its own also gave the place and the points in it.
    const place = asked.local ? String(result.copy.place ?? "").trim() || null : null;
    const said = asked.local && Array.isArray(result.copy.points) ? result.copy.points : [];
    // Lines that only repeat the location or a price go before the gate: the
    // ad prints those on lines of their own.
    const copy: Copy = withoutFactLines(
      {
        headline: String(result.copy.headline ?? "").trim(),
        body: String(result.copy.body ?? "").trim(),
        cta: String(result.copy.cta ?? "").trim(),
      },
      opts.ground,
      place,
    );
    let local: LocalLines | null = null;
    if (asked.local) {
      const points = (asked.points ?? []).map((source, i) => ({ source, text: String(said[i] ?? "").trim() }));
      local = { place, points, reading: null };
      // Read back by a second model, for the gate's word checks. Without a
      // reading the card is held for a person, and another attempt is not
      // paid for to find out whether the reader answers the next time.
      const read = await (opts.read ?? readCopy)(
        readingInstruction({ language: opts.spec.language, copy, place, points: points.map((p) => p.text) }),
        { signal: opts.signal },
      );
      if (opts.signal?.aborted) break;
      if (read.ok) local.reading = read.reading;
      else opts.onRefused?.({ code: read.code, message: read.message });
    }
    const { verdict, reasons } = gateCopy(copy, opts.spec, opts.ground, opts.budget, local);
    last = { copy, verdict, reasons, attempts: attempt, local };
    best = betterAttempt(best, last);
    if (!needsRewrite(reasons)) break;
  }

  return best ? { ...best, attempts: tried } : null;
}

/**
 * Write every block the brief asks for, gate each one, store the verdict.
 *
 * Nothing is written to the database until the gate has run on it, and a
 * block that fails is stored with its verdict rather than dropped. A refusal
 * nobody can see is a refusal nobody can fix, and the reasons are what tell a
 * marketer that the Brain is missing a talking point rather than that the
 * model is bad at Marathi.
 */
export async function generateBlocks(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  /** Injected in checks, so a suite never spends money or waits on a model. */
  driver?: CopyDriver;
  /** The reader for a card in a script of its own, injected the same way. */
  reader?: ReadDriver;
  /**
   * Only these blocks. Empty or absent means every block the brief asks for.
   * A person rewriting one card, or the cards the brief changed underneath,
   * should not pay to rewrite the seven that were fine.
   */
  only?: readonly CopySpec[];
}): Promise<StudioOutcome> {
  const view = await openStudio(opts.orgId, opts.briefId);
  if (!view) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That campaign is not in this organisation." };
  }
  if (!view.languages.length) {
    return { ok: false, code: "NO_LANGUAGES", message: "The brief names no languages yet." };
  }
  if (!view.ground.advertisable) {
    return { ok: false, code: "NOT_ADVERTISABLE", message: "This phase can't be advertised yet." };
  }
  // Refused before the writer is paid: with nothing approved to lead on it
  // invents something ("Near Schools", "8 min from the station").
  if (!hasSellingPoint(view.ground)) {
    return { ok: false, code: "NO_POINTS", message: NO_POINTS_MESSAGE };
  }
  if (view.planned.length > MAX_COPY_BLOCKS) {
    return { ok: false, code: "TOO_MANY", message: "That is more blocks than the catalog allows." };
  }

  const brief = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<
      { objective: string | null; audience: string | null; cta: string | null; hook: string | null; offers: string | null }[]
    >`
      SELECT objective, audience, cta, hook, offers
      FROM campaign_briefs WHERE org_id = ${opts.orgId} AND id = ${opts.briefId}
    `;
    return row ?? null;
  });
  if (!brief) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That campaign is not in this organisation." };
  }

  const write = opts.driver ?? writeCopy;
  const tally = { written: 0, passed: 0, held: 0, failed: 0 };
  // The AI service out of credits, or down, ends the run: every block after
  // the first would be refused the same way, and the person is told why
  // rather than shown "nothing usable".
  const down: { hit: { code: string; message: string } | null } = { hit: null };

  const claim = await startCopyRun(opts.orgId, opts.briefId, opts.actorUserId);
  if (!claim.ok) {
    return {
      ok: false,
      code: "ALREADY_WRITING",
      message: "This brief is already being written. Wait for it to finish, or stop it.",
    };
  }

  // The stop is a row, so it is read rather than received. Once seen, the
  // controller aborts the calls in flight and no worker starts another block.
  const controller = new AbortController();
  const poll = setInterval(() => {
    runStopped(opts.orgId, claim.runId)
      .then((yes) => {
        if (yes) controller.abort();
      })
      .catch(() => {});
  }, STOP_POLL_MS);

  // A few at a time, not one at a time and not all at once. Twelve blocks
  // written in sequence is two minutes of somebody watching a button, and
  // twelve at once is a rate limit. The window is small enough that a
  // provider throttling us slows the run rather than failing it.
  // Only the blocks asked for, and only ones the brief still asks for: a
  // stale tab naming a language the brief has since dropped writes nothing.
  const keyOf = (o: CopySpec) => `${o.language}|${o.segment}|${o.angle ?? "GENERAL"}`;
  const wanted = new Set((opts.only ?? []).map(keyOf));
  // What has worked here orders what the writer leads with; nothing learnt, nothing changes.
  const learned = await learningFor(opts.orgId, view.node.id).then((l) => l.scores).catch((): Blended[] => []);
  const queue = wanted.size
    ? view.planned.filter((p) => wanted.has(keyOf(p)))
    : [...view.planned];
  const run = async () => {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
    if (controller.signal.aborted) return;
    const checked = await writeChecked({
      spec,
      ground: view.ground,
      budget: view.budget,
      build: (feedback) =>
        instructionFor({
          spec,
          ground: view.ground,
          budget: view.budget,
          brief,
          project: view.node.name,
          feedback,
          learned,
        }),
      write,
      read: opts.reader,
      signal: controller.signal,
      onRefused: (f) => {
        if (isServiceDown(f.code) && !down.hit) {
          down.hit = f;
          controller.abort();
        }
      },
    });
    // A block that came back after the stop is not written. Somebody said
    // stop, and a block landing afterwards would read as the stop not
    // working. One that never came back at all is not a reason to discard
    // the blocks that did; the old copy stays and is marked as such.
    if (controller.signal.aborted || !checked) {
      if (controller.signal.aborted) return;
      continue;
    }
    const { copy, verdict, reasons } = checked;

    await withTenant(opts.orgId, async (sql) => {
      await sql`
        INSERT INTO campaign_copy (org_id, brief_id, scope_node_id, language, segment, angle,
                                   headline, body, cta, verdict, reasons, ground,
                                   brain_sources, model, generated_by, local)
        VALUES (${opts.orgId}, ${opts.briefId}, ${view.node.id}, ${spec.language},
                ${spec.segment}, ${spec.angle ?? "GENERAL"}, ${copy.headline}, ${copy.body}, ${copy.cta},
                ${verdict}, ${sql.json(reasons as unknown as JSONValue)},
                ${sql.json(view.ground as unknown as JSONValue)},
                ${sql.json(view.brainSources as unknown as JSONValue)},
                ${COPY_MODEL}, ${opts.actorUserId},
                ${sql.json((checked.local ?? {}) as unknown as JSONValue)})
        ON CONFLICT (brief_id, language, segment, angle) DO UPDATE SET
          headline = EXCLUDED.headline, body = EXCLUDED.body, cta = EXCLUDED.cta,
          verdict = EXCLUDED.verdict, reasons = EXCLUDED.reasons, local = EXCLUDED.local,
          ground = EXCLUDED.ground, brain_sources = EXCLUDED.brain_sources,
          model = EXCLUDED.model, generated_by = EXCLUDED.generated_by,
          generated_at = now()
      `;
    });

    tally.written += 1;
    if (verdict === "PASS") tally.passed += 1;
    else if (verdict === "HOLD") tally.held += 1;
    else tally.failed += 1;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(BLOCK_CONCURRENCY, queue.length) }, run));
  } finally {
    clearInterval(poll);
    await finishCopyRun(opts.orgId, claim.runId, tally.written).catch(() => {});
  }

  // One last look, so a stop pressed in the final second is still reported
  // as a stop rather than as a run that finished on its own.
  const stopped =
    !down.hit && (controller.signal.aborted || (await runStopped(opts.orgId, claim.runId).catch(() => false)));

  if (!tally.written) {
    if (down.hit) return { ok: false, code: down.hit.code, message: down.hit.message };
    return stopped
      ? { ok: false, code: "STOPPED", message: "Stopped. Nothing was rewritten." }
      : { ok: false, code: "NOTHING_WRITTEN", message: "The copy model returned nothing usable." };
  }

  // The copy itself never enters the audit row. It can name a person or a
  // competitor, and `audit_log` is the table that holds no free text somebody
  // typed. Counts and the verdict split are what a reviewer needs.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "creative.copy_generated",
    targetType: "campaign_brief",
    targetId: opts.briefId,
    metadata: { ...tally, model: COPY_MODEL, stopped },
  });

  if (down.hit) {
    const n = tally.written;
    return { ok: false, code: down.hit.code, message: `${down.hit.message} ${n} ${n === 1 ? "block was" : "blocks were"} written first.` };
  }
  return { ok: true, ...tally, stopped };
}

// ---------------------------------------------------------------------------
// A person's own words on a card
// ---------------------------------------------------------------------------

/** The longest a line a person types may be; the gate's budget is the real limit. */
export const MAX_EDIT_CHARS = 300;

export type EditOutcome =
  | { ok: true; verdict: Verdict }
  | { ok: false; code: string; message: string; reasons?: Reason[] };

/**
 * A card rewritten by a person, gated like anything a model wrote.
 *
 * The words are the person's and are never changed here; the gate decides
 * whether they may stand. They are saved only when today's gate rates them no
 * worse than the card was, so an edit can never turn a cleared card into one
 * that cannot go out. A refusal hands back the gate's own reasons. A card in
 * a script of its own is read back into English once a save (`readCopy()`),
 * because the gate's word checks read the reading.
 */
export async function editBlock(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  copyId: string;
  copy: Copy;
  /** The card as the person opened it, so a rewrite landing meanwhile is never overwritten. */
  seenAt: string;
  /** The reader for a card in a script of its own, injected in checks. */
  reader?: ReadDriver;
}): Promise<EditOutcome> {
  const copy: Copy = {
    headline: opts.copy.headline.replace(/\s+/g, " ").trim(),
    body: opts.copy.body.replace(/\s+/g, " ").trim(),
    cta: opts.copy.cta.replace(/\s+/g, " ").trim(),
  };
  if (!copy.headline) return { ok: false, code: "EMPTY", message: "Write a headline." };
  if ([copy.headline, copy.body, copy.cta].some((l) => l.length > MAX_EDIT_CHARS)) {
    return { ok: false, code: "TOO_LONG", message: `Keep each line under ${MAX_EDIT_CHARS} characters.` };
  }

  const view = await openStudio(opts.orgId, opts.briefId);
  if (!view) return { ok: false, code: "BRIEF_UNKNOWN", message: "That campaign is not in this organisation." };
  if (!view.ground.advertisable) {
    return { ok: false, code: "NOT_ADVERTISABLE", message: "This phase can't be advertised yet." };
  }
  const block = view.blocks.find((b) => b.id === opts.copyId);
  if (!block) return { ok: false, code: "CARD_UNKNOWN", message: "That card is not in this campaign." };
  if (block.generatedAt !== opts.seenAt) {
    return { ok: false, code: "CHANGED", message: "This card changed while you were editing. Reload to see it." };
  }

  const spec: CopySpec = { language: block.language, segment: block.segment, angle: block.angle };
  let local: LocalLines | null = null;
  if (!writesLatin(block.language)) {
    const place = block.local?.place ?? null;
    const points = block.local?.points ?? [];
    local = { place, points, reading: null };
    const read = await (opts.reader ?? readCopy)(
      readingInstruction({ language: block.language, copy, place, points: points.map((p) => p.text) }),
      {},
    );
    if (read.ok) local.reading = read.reading;
  }

  const { verdict, reasons } = gateCopy(copy, spec, view.ground, view.budget, local);
  if (RANK[verdict] > RANK[block.verdict]) {
    return {
      ok: false,
      code: "GATE",
      message: verdict === "FAIL" ? "These words can't go on an ad." : "These words would put the card on hold.",
      reasons,
    };
  }

  const saved = await withTenant(opts.orgId, async (sql) => {
    const rows = await sql`
      UPDATE campaign_copy
      SET headline = ${copy.headline}, body = ${copy.body}, cta = ${copy.cta},
          verdict = ${verdict}, reasons = ${sql.json(reasons as unknown as JSONValue)},
          local = ${sql.json((local ?? {}) as unknown as JSONValue)},
          ground = ${sql.json(view.ground as unknown as JSONValue)},
          brain_sources = ${sql.json(view.brainSources as unknown as JSONValue)},
          model = 'person', generated_by = ${opts.actorUserId}, generated_at = now()
      WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId} AND id = ${opts.copyId}
        AND date_trunc('milliseconds', generated_at) = ${new Date(opts.seenAt)}
      RETURNING id`;
    return rows.length > 0;
  });
  if (!saved) return { ok: false, code: "CHANGED", message: "This card changed while you were editing. Reload to see it." };

  // Never the words: `audit_log` holds no free text somebody typed.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "creative.copy_edited",
    targetType: "campaign_brief",
    targetId: opts.briefId,
    metadata: { copy: opts.copyId, language: block.language, angle: block.angle, verdict },
  });
  return { ok: true, verdict };
}

// ---------------------------------------------------------------------------
// Backdrops
// ---------------------------------------------------------------------------

export async function listBackdrops(orgId: string, briefId: string): Promise<Backdrop[]> {
  if (!isNodeId(briefId)) return [];
  const rows = await withTenant(orgId, async (sql) => {
    return sql<
      {
        id: string;
        role: string;
        prompt: string;
        model: string;
        media_type: string;
        media_bytes: string;
        created_at: Date;
      }[]
    >`
      SELECT id, role, prompt, model, media_type, media_bytes, created_at
      FROM generated_media
      WHERE org_id = ${orgId} AND brief_id = ${briefId}
      ORDER BY created_at DESC
    `;
  });
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    prompt: r.prompt,
    model: r.model,
    mediaType: r.media_type,
    mediaBytes: Number(r.media_bytes),
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Draw a backdrop and keep it.
 *
 * The object goes in first and the row second, so a row can never name bytes
 * that are not there. If the row fails to land the object is taken back out,
 * which is the same order `addAsset()` uses and for the same reason.
 */
export async function addBackdrop(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  role: string;
  prompt: string;
  driver?: ImageDriver;
}): Promise<{ ok: true; id: string } | { ok: false; code: string; message: string }> {
  const verdict = canGenerate({ role: opts.role, prompt: opts.prompt });
  if (!verdict.ok) return { ok: false, code: verdict.code, message: verdict.message };

  const view = await openStudio(opts.orgId, opts.briefId);
  if (!view) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That campaign is not in this organisation." };
  }

  // The exclusions are added here, where every driver gets them. An image
  // model handed "warm evening light over a city" draws buildings, because
  // that is what the words mean to it, and a drawn building on an
  // advertisement is a misrepresentation under Section 3 before it is
  // anything else.
  const draw = opts.driver ?? drawBackdrop;
  const drawn = await draw({ prompt: backdropPrompt(verdict.prompt) });
  if (!drawn.ok) return { ok: false, code: drawn.code, message: drawn.message };

  const id = randomUUID();
  const put = await putAsset({
    orgId: opts.orgId,
    project: await projectOfNode(opts.orgId, view.node.id),
    kind: "backdrop",
    id,
    bytes: drawn.bytes,
    contentType: drawn.type,
  });
  if (!put.ok) return { ok: false, code: put.code, message: put.message };
  const key = put.key;

  const stored = await withTenant(opts.orgId, async (sql) => {
    await sql`
      INSERT INTO generated_media (id, org_id, scope_node_id, brief_id, role, prompt,
                                   model, storage_key, media_type, media_bytes,
                                   sha256, created_by)
      VALUES (${id}, ${opts.orgId}, ${view.node.id}, ${opts.briefId}, ${opts.role},
              ${opts.prompt.trim()}, ${IMAGE_MODEL}, ${key}, ${drawn.type},
              ${drawn.bytes.byteLength}, ${sha256(drawn.bytes)}, ${opts.actorUserId})
    `;
    return true;
  }).catch(() => false);

  if (!stored) {
    await removeAsset(key).catch(() => {});
    return { ok: false, code: "WRITE_FAILED", message: "Could not store that picture." };
  }

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "creative.backdrop_generated",
    targetType: "campaign_brief",
    targetId: opts.briefId,
    metadata: { role: opts.role, model: IMAGE_MODEL, bytes: drawn.bytes.byteLength },
  });

  return { ok: true, id };
}

/**
 * A link good for five minutes, the same bargain every stored object gets.
 *
 * The key comes back with it, because the local driver in `ASSETS_DIR` mode
 * has no signing to do and hands back a `file://` path a browser will not
 * follow. The route serves the bytes itself in that case, so the screens work
 * identically on a machine with no bucket.
 */
export async function backdropLink(
  orgId: string,
  id: string,
): Promise<{ url: string; type: string; key: string } | null> {
  if (!isNodeId(id)) return null;
  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ storage_key: string; media_type: string }[]>`
      SELECT storage_key, media_type FROM generated_media
      WHERE org_id = ${orgId} AND id = ${id}
    `;
    return r ?? null;
  });
  if (!row) return null;
  const link = await assetUrl(row.storage_key, row.media_type);
  if (!link.ok) return null;
  return { url: link.url, type: row.media_type, key: row.storage_key };
}

export async function removeBackdrop(opts: {
  orgId: string;
  actorUserId: string;
  id: string;
}): Promise<{ ok: boolean; message?: string }> {
  if (!isNodeId(opts.id)) return { ok: false, message: "That is not a picture in this organisation." };
  const key = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ storage_key: string }[]>`
      DELETE FROM generated_media
      WHERE org_id = ${opts.orgId} AND id = ${opts.id}
      RETURNING storage_key
    `;
    return row?.storage_key ?? null;
  });
  if (!key) return { ok: false, message: "That is not a picture in this organisation." };

  // The row goes first and the object second. The other order can leave a row
  // pointing at bytes that are gone, which reads as a broken picture forever;
  // this order can only leave bytes nobody references, which a sweep collects.
  await removeAsset(key).catch(() => {});
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "creative.backdrop_removed",
    targetType: "generated_media",
    targetId: opts.id,
    metadata: {},
  });
  return { ok: true };
}
