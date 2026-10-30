import { limitsLifted } from "@/lib/plan-purchase-rules";
import { MAX_LIVE_STORIES } from "@/lib/reel-choice";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getViewer } from "@/lib/console";
import { openStudio, type CopyBlock } from "@/lib/creative";
import {
  adviceFor,
  forAPerson,
  hasSellingPoint,
  needsRewrite,
  hookIsApproved,
  reasonSummary,
  stalenessOf,
  segmentLabel,
  GENERATED_ROLES,
  REASON_FIX,
  type FixPlace,
  type Verdict,
} from "@/lib/creative-rules";
import { readFlash } from "@/lib/flash";
import { Flash } from "@/components/Flash";
import { ConfirmAction } from "@/components/ConfirmAction";
import { phaseReadiness } from "@/lib/readiness";
import { removeBackdropAction, applyHookAction } from "@/app/actions/studio";
import { loadBrief } from "@/lib/campaign";
import { DrawBackdrop, MakePostButton, RewriteOne, WriteCopy } from "./StudioPanel";
import { EditableCard } from "./EditableCard";
import { PostsPanel } from "./PostsPanel";
import { listTemplates } from "@/lib/templates";
import { learningFor } from "@/lib/learning";
import { templateLabel } from "@/lib/template-rules";
import { angleLabel, cardLead, invitesVisit, templateAngle, templateGap, type AngleKind } from "@/lib/card-angle-rules";
import { STORY_TEMPLATE } from "@/lib/reel-rules";
import { listPosts } from "@/lib/compose";
import { listReels } from "@/lib/reel";
import { filmGaps } from "@/lib/film";
import { listPublications } from "@/lib/publish";
import { TARGET_TONE, whereItGoes } from "@/lib/connect-rules";
import { kindDef, kindUnavailable, PLACEMENT_SIZE, placementsFor, POST_KINDS } from "@/lib/compose-rules";
import { Alert, ArrowLeft, ArrowUpRight, Clock } from "@/components/icons";

/**
 * Campaign Studio.
 *
 * One screen per brief. It shows what the copy will be measured against
 * before any is written, then a block per language and buyer with the verdict
 * that was reached on it and, where it did not clear, exactly what stopped it.
 *
 * A blocked block is shown rather than hidden. A refusal nobody can see is a
 * refusal nobody can fix, and the reason usually names something missing from
 * the Project Brain rather than something wrong with the writing.
 */
export default async function StudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ briefId: string }>;
  searchParams: Promise<{ error?: string; error_s?: string; removed?: string; hook?: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");

  const { briefId } = await params;
  const q = await searchParams;

  const view = await openStudio(viewer.state.org.id, briefId);
  if (!view) notFound();
  if (!viewer.authz.canAt("campaign:read", view.node.path)) notFound();
  const error = readFlash(q, "error");

  const mayWrite = viewer.authz.canAt("campaign:create", view.node.path);
  const g = view.ground;
  // Nothing is written without an approved selling point to write it from.
  const noPoints = !hasSellingPoint(g);
  const byLanguage = view.languages.map((language) => ({
    language,
    blocks: view.blocks.filter((b) => b.language === language),
  }));

  // Where each refusal is fixed, and whether this viewer can fix it there.
  // A place they cannot change is still named, as plain text rather than a
  // link, because knowing the push is waiting on somebody else is worth
  // having.
  const briefRow = (await loadBrief(viewer.state.org.id, briefId))?.brief ?? null;
  const hook = briefRow?.hook ?? null;

  // A verdict is only true of what it was reached against. A block written
  // before the brief or the facts changed is not measured against today's,
  // because every conclusion drawn from that comparison is about a different
  // brief. It gets one note saying so, and only the current blocks are read
  // for advice.
  const staleOf = new Map(
    view.blocks.map((b) => [
      b.id,
      briefRow
        ? stalenessOf(b, { briefUpdatedAt: briefRow.updatedAt, ground: g })
        : null,
    ]),
  );
  // Cards to bring up to date: written before the brief or the facts
  // changed, plus any the brief now asks for that have never been written
  // (a language added since). Only these, never all of them, because paying
  // to rewrite seven good cards to fix one is the thing a client notices.
  const key = (b: { language: string; segment: string; angle?: string }) => `${b.language}|${b.segment}|${b.angle ?? "GENERAL"}`;
  const written = new Set(view.blocks.map(key));
  // Also any card still refused for the model's own mistake, which is ours to
  // correct and never the client's to notice: in practice a card written
  // before the rewrite loop existed, or one the model got wrong three times.
  const outOfDate = [
    ...new Set([
      ...view.blocks.filter((b) => staleOf.get(b.id)).map(key),
      ...view.planned.filter((p) => !written.has(key(p))).map(key),
      ...view.blocks.filter((b) => b.verdict !== "PASS" && needsRewrite(b.reasons)).map(key),
    ]),
  ];
  const canWrite = mayWrite && g.advertisable && view.languages.length > 0 && !noPoints;
  const allCards = view.planned.length;
  const rewriteAll = {
    title: `Write all ${allCards} ${allCards === 1 ? "card" : "cards"} again?`,
    body: `Every card in this campaign is written again and replaces the one there now, ${allCards} in all.`,
    confirmLabel: `Write all ${allCards} again`,
  };

  // What to fix lists only what a PERSON can fix. The model's own mistakes
  // (too long, off the approved points, an amount nobody published) are
  // corrected by rewriting before anybody sees the card, so they never reach
  // this list, and a card that still carries one after its last attempt says
  // so on the card, beside its own Rewrite.
  const current = view.blocks.filter((b) => b.verdict !== "PASS" && !staleOf.get(b.id));
  const summary = reasonSummary(current.map((b) => ({ reasons: forAPerson(b.reasons) })));
  const approvedAmounts = [
    ...g.money,
    ...g.configurations
      .filter((c) => c.startingPrice !== null)
      .map((c) => `${c.label} from Rs ${c.startingPrice!.toLocaleString("en-IN")}`),
  ];
  // The hook is the one brief setting a person has to know about even when
  // every card cleared: it is not approved, so the cards led on approved
  // points instead, and that is a decision the person should see made.
  // Posts are made from cards that cleared against today's brief and facts.
  // A card written before a change has not been checked against what the
  // post would now claim.
  const clearedCards = view.blocks.filter((b) => b.verdict === "PASS" && !staleOf.get(b.id));
  const [posts, imageTemplates, carouselTemplates, videoTemplates, reels] = await Promise.all([
    listPosts(viewer.state.org.id, briefId),
    listTemplates("IMAGE"),
    listTemplates("CAROUSEL"),
    listTemplates("VIDEO"),
    listReels(viewer.state.org.id, briefId),
  ]);
  const [publications, filmNeeds, learning] = await Promise.all([
    listPublications(viewer.state.org.id, { postIds: posts.map((p) => p.id) }),
    // What each video template's film needs that the project does not hold
    // (three dated site photos, four of the sample flat), asked before the press.
    filmGaps(viewer.state.org.id, view.node, videoTemplates.map((t) => t.key)).catch(() => ({}) as Record<string, string>),
    // What "Let AI choose" learns from here, said beside it.
    learningFor(viewer.state.org.id, view.node.id).catch(() => null),
  ]);
  const mayPublish = viewer.authz.canAt("campaign:publish", view.node.path);
  // Each template knows the card it takes and whether the project can make it.
  const withAngle = (kind: AngleKind, list: typeof imageTemplates) =>
    list.map((t) => ({
      ...t,
      angle: templateAngle(kind, t.key),
      gap: templateGap(kind, t.key, view.material) ?? (kind === "VIDEO" ? filmNeeds[t.key] ?? null : null),
    }));
  const kindOptions = POST_KINDS.map((k) => ({
    key: k.key,
    label: k.label,
    detail: k.detail,
    placements: placementsFor(k.key, view.formats),
    unavailable: kindUnavailable(k.key, view.formats),
    where: Object.fromEntries(
      placementsFor(k.key, view.formats).map((p) => [p, whereItGoes(k.key, p, PLACEMENT_SIZE[p])]),
    ),
  }));

  const hookUnapproved =
    !!hook?.trim() && g.talkingPoints.length > 0 && !hookIsApproved(hook, g.talkingPoints);
  const projectId =
    view.node.kind === "PROJECT"
      ? view.node.id
      : (await phaseReadiness(viewer.state.org.id, view.node.id))?.projectId ?? null;
  const can = (perms: string[]) => perms.some((p) => viewer.authz.canAt(p, view.node.path));
  const FIX: Record<FixPlace, { label: string; href: string | null; allowed: boolean }> = {
    brain: {
      label: `Edit ${view.node.name}'s facts`,
      href: `/dashboard/brain/${view.node.id}`,
      allowed: can(["brain:edit", "brain.claims:approve", "brain.price:approve", "brain.rera:approve"]),
    },
    library: {
      label: "Open the configurations",
      href: `/dashboard/library/${view.node.id}`,
      allowed: can(["unit:manage", "brain.price:approve"]),
    },
    brief: {
      label: "Edit the brief",
      href: `/dashboard/campaigns/brief/${briefId}?edit=1`,
      allowed: mayWrite,
    },
    branding: {
      label: "Open branding",
      href: "/dashboard/library/branding",
      allowed: can(["brand:manage"]),
    },
    registration: {
      label: "Open the registration",
      href: projectId ? `/dashboard/projects/${projectId}` : null,
      allowed: can(["rera:manage"]),
    },
  };

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__id">
          <Link href={`/dashboard/campaigns/brief/${briefId}`} className="backlink" data-back>
            <ArrowLeft size={13} />
            {view.briefName}
          </Link>
          <h1 style={{ marginTop: 4 }}>
            Studio for <span className="em">{view.node.name}</span>
          </h1>
        </div>
        <div className="pagehead__acts">
          {mayWrite && (
            <Link
              href={`/dashboard/campaigns/brief/${briefId}?edit=1`}
              className="btn btn--ghost"
              data-edit-brief
            >
              Edit the brief
            </Link>
          )}
          {canWrite &&
            (view.blocks.length === 0 ? (
              <WriteCopy briefId={briefId} label="Write the copy" />
            ) : outOfDate.length > 0 ? (
              <>
                <WriteCopy
                  briefId={briefId}
                  label="Write all again"
                  tone="ghost"
                  formId="writecopy-all"
                  confirm={rewriteAll}
                />
                <WriteCopy
                  briefId={briefId}
                  label={`Update ${outOfDate.length} ${outOfDate.length === 1 ? "card" : "cards"}`}
                  only={outOfDate}
                  formId="writecopy-some"
                />
              </>
            ) : (
              <WriteCopy briefId={briefId} label="Write all again" tone="ghost" confirm={rewriteAll} />
            ))}
        </div>
      </div>

      <Flash text={error} name="error" style={{ marginBottom: 16 }} />
      {noPoints && g.advertisable && (
        <div className="note note--warn" style={{ marginBottom: 16 }} data-no-points>
          <strong>Nothing approved to write from</strong>
          Add at least one approved selling point to {view.node.name}&rsquo;s facts first.{" "}
          {FIX.brain.allowed && (
            <Link href={FIX.brain.href!} className="fixitem__link">
              Open the facts
              <ArrowUpRight size={13} />
            </Link>
          )}
        </div>
      )}
      {q.hook && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Hook changed to &ldquo;{hook}&rdquo;. The cards it affects are marked, and Update brings them up to date.
        </div>
      )}
      {q.removed && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Backdrop removed.
        </div>
      )}

      {!g.advertisable && (
        <div className="note note--risk" style={{ marginBottom: 16 }}>
          <strong>This cannot be advertised yet</strong>
          No phase here has a registration in force.
        </div>
      )}

      {!view.languages.length && (
        <div className="note note--warn" style={{ marginBottom: 16 }}>
          <strong>The brief names no languages</strong>
          Choose the languages this campaign runs in and the blocks appear here.
        </div>
      )}

      {(summary.length > 0 || hookUnapproved) && (
        <section className="card" style={{ marginBottom: 16 }} data-fixes>
          <div className="card__head">
            <h2>What to fix</h2>
          </div>
          <div className="fixlist">
            {hookUnapproved && (
              <div className="fixitem" data-fix="HOOK">
                <span className="qi__mark qi__mark--warn">
                  <Clock size={15} />
                </span>
                <div className="fixitem__body">
                  <p className="fixitem__problem">
                    Your hook &ldquo;{hook!.trim()}&rdquo; is not an approved talking point for{" "}
                    {view.node.name}, so the cards lead on approved points instead.
                  </p>
                  <p className="fixitem__change">
                    Pick an approved point as the hook, or add yours to {view.node.name}&rsquo;s
                    facts if it is true.
                  </p>
                  {mayWrite && (
                    <div className="fixitem__choices">
                      {g.talkingPoints.map((point) => (
                        <form key={point} action={applyHookAction}>
                          <input type="hidden" name="briefId" value={briefId} />
                          <input type="hidden" name="hook" value={point} />
                          <button type="submit" className="btn btn--light btn--sm" data-use-hook>
                            Use &ldquo;{point}&rdquo;
                          </button>
                        </form>
                      ))}
                    </div>
                  )}
                  {FIX.brain.allowed && (
                    <div className="fixitem__foot">
                      <Link href={FIX.brain.href!} className="fixitem__link">
                        Add it to {view.node.name}&rsquo;s facts
                        <ArrowUpRight size={13} />
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            )}
            {summary.map(({ code, count }) => {
              const place = REASON_FIX[code];
              const fix = place ? FIX[place] : null;
              const hold = current.some(
                (b) => b.verdict === "HOLD" && b.reasons.some((r) => r.code === code),
              );
              const advice = adviceFor(code, {
                node: view.node.name,
                hook,
                talkingPoints: g.talkingPoints,
                details: current.flatMap((b) =>
                  b.reasons.filter((r) => r.code === code).map((r) => r.detail),
                ),
                approvedAmounts,
              });
              return (
                <div key={code} className="fixitem" data-fix={code}>
                  <span className={`qi__mark ${hold ? "qi__mark--warn" : "qi__mark--risk"}`}>
                    {hold ? <Clock size={15} /> : <Alert size={15} />}
                  </span>
                  <div className="fixitem__body">
                    <p className="fixitem__problem">{advice.problem}</p>
                    <p className="fixitem__change">{advice.change}</p>
                    <div className="fixitem__foot">
                      <span className="pill pill--quiet">
                        {count} {count === 1 ? "card" : "cards"}
                      </span>
                      {fix &&
                        (fix.allowed && fix.href ? (
                          <Link href={fix.href} className="fixitem__link">
                            {fix.label}
                            <ArrowUpRight size={13} />
                          </Link>
                        ) : (
                          <span className="pill pill--quiet">Someone else fixes this</span>
                        ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card__head">
          <h2>What the copy is held to</h2>
        </div>
        <div className="groundrow">
          <Fact
            label="Registration"
            value={g.registrationNo ?? (g.advertisable ? "Exempt" : "None in force")}
            tone={g.advertisable ? "ok" : "risk"}
            note={
              g.registrationDaysLeft !== null
                ? `${g.registrationDaysLeft} days left`
                : undefined
            }
          />
          <Fact
            label="Approved talking points"
            value={String(g.talkingPoints.length)}
            tone={g.talkingPoints.length ? "ok" : "warn"}
            note={g.talkingPoints.length ? undefined : "Nothing to lead on"}
          />
          <Fact
            label="Never say"
            value={String(g.neverSay.length)}
            tone="quiet"
            note={g.neverSay.length ? undefined : "No list recorded"}
          />
          <Fact
            label="Possession"
            value={g.possessionDate ? showDay(g.possessionDate) : "Not approved"}
            tone={g.possessionDate ? "ok" : "warn"}
          />
          <Fact
            label="Longest headline"
            value={`${view.budget.headline} characters`}
            tone="quiet"
            note={view.formats.length ? view.formats.join(", ") : undefined}
          />
        </div>
      </section>

      {byLanguage.map(({ language, blocks }) => (
        <section className="card" style={{ marginTop: 16 }} key={language}>
          <div className="card__head">
            {/* With one language there is nothing to tell apart, so the section is just the cards. */}
            <h2>{view.languages.length > 1 ? language : "Cards"}</h2>
            {blocks.length > 0 && (
              <span className="pill pill--quiet">
                {blocks.filter((b) => b.verdict === "PASS").length} of {blocks.length} cleared
              </span>
            )}
          </div>
          {blocks.length === 0 ? (
            <p className="formfield__unset">Nothing written yet.</p>
          ) : (
            <div className="blockgrid">
              {blocks.map((block) => (
                <Block
                  key={block.id}
                  block={block}
                  stale={!!staleOf.get(block.id)}
                  rewrite={canWrite ? { briefId, spec: key(block) } : null}
                  make={canWrite && clearedCards.some((c) => c.id === block.id)}
                />
              ))}
            </div>
          )}
        </section>
      ))}

      <section className="card" style={{ marginTop: 16 }} data-posts>
        <div className="card__head">
          <h2>Posts</h2>
          {posts.length > 0 && <span className="pill pill--quiet">{posts.length}</span>}
        </div>
        {clearedCards.length === 0 && posts.length === 0 && (
          <p className="formfield__unset">Posts are made from cleared cards.</p>
        )}
        {clearedCards.length > 0 && posts.length === 0 && canWrite && (
          <p className="formfield__unset">Press Make a post on a cleared card above.</p>
        )}
        <PostsPanel
          storyCap={limitsLifted() ? 50 : MAX_LIVE_STORIES}
          learnedFrom={{ ours: learning?.ownAds ?? 0, market: learning?.marketAds ?? 0 }}
          templates={{
            IMAGE: withAngle("IMAGE", imageTemplates),
            CAROUSEL: withAngle("CAROUSEL", carouselTemplates),
            VIDEO: withAngle("VIDEO", videoTemplates),
          }}
          briefId={briefId}
          kinds={kindOptions}
          reels={reels}
          briefFormats={view.formats}
          campaign={view.briefName}
          mayMake={canWrite && clearedCards.length > 0}
          mayRemove={mayWrite}
          cards={clearedCards.map((b) => ({
            id: b.id,
            label: `${b.language} · ${b.angle === "GENERAL" ? segmentLabel(b.segment) : `For ${lowerWords(angleLabel(b.angle))} ads`}`,
            headline: b.headline,
            angle: b.angle,
            segment: b.segment,
            lead: cardLead(b, g),
            invites: invitesVisit(b.cta),
          }))}
          posts={posts.map((post) => ({
            id: post.id,
            kindLabel: kindDef(post.kind).label,
            placement: post.placement,
            language: post.language,
            segmentLabel: segmentLabel(post.segment),
            headline: post.headline,
            media: post.media.map((m) => ({ type: m.type, width: m.width, height: m.height, v: m.key.slice(-8) })),
            review: post.review ? { passed: post.review.passed, attempts: post.review.attempts } : null,
            pixel: post.pixel,
            film: post.film
              ? {
                  units: post.film.units,
                  revision: post.film.revision,
                  problems: (post.review?.problems ?? []).map((p) => p.text),
                  notes: post.review?.notes ?? [],
                }
              : null,
            template: post.template
              ? {
                  label: (post.template.key === STORY_TEMPLATE.key ? STORY_TEMPLATE.label : templateLabel(post.template.key, post.kind)) ?? post.template.key,
                  byAi: post.template.by !== "person",
                }
              : null,
            publications: publications
              .filter((p) => p.renderedPostId === post.id)
              .map((p) => ({
                id: p.id,
                destination: p.destination,
                label: p.destinationLabel,
                state: p.state,
                stateLabel: p.stateLabel,
                tone: TARGET_TONE[p.state],
                url: p.externalUrl,
              })),
          }))}
          mayPublish={mayPublish}
        />
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card__head">
          <h2>Backdrops</h2>
          {view.backdrops.length > 0 && (
            <span className="pill pill--quiet">{view.backdrops.length}</span>
          )}
        </div>
        <p className="sub" style={{ margin: "-8px 0 18px", maxWidth: "72ch" }}>
          Colour, light and texture for the copy to sit on. The building itself
          always comes from the Assets Library.
        </p>

        {mayWrite && <DrawBackdrop briefId={briefId} roles={GENERATED_ROLES} />}

        {view.backdrops.length > 0 && (
          <div className="backdrops">
            {view.backdrops.map((b) => (
              <figure className="backdrop" key={b.id}>
                <div className="backdrop__shot">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/dashboard/campaigns/brief/${briefId}/studio/backdrop/${b.id}?v=thumb`}
                    alt={b.prompt}
                  />
                </div>
                <figcaption>
                  <span className="pill pill--quiet">
                    {b.role.charAt(0) + b.role.slice(1).toLowerCase()}
                  </span>
                  <span className="backdrop__prompt">{b.prompt}</span>
                  {mayWrite && (
                    <ConfirmAction
                      label="Remove"
                      title="Remove this backdrop?"
                      body={<p>The picture is deleted from this campaign.</p>}
                      confirmLabel="Remove it"
                      action={removeBackdropAction}
                      fields={{ briefId, id: b.id }}
                      tone="risk"
                      testId={`remove-backdrop-${b.id}`}
                    />
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

    </>
  );
}

/** `30 June 2029`, from a signed `2029-06-30`. */
function showDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
}

const TONE: Record<Verdict, { pill: string; label: string }> = {
  PASS: { pill: "pill--ok", label: "Cleared" },
  HOLD: { pill: "pill--warn", label: "On hold" },
  FAIL: { pill: "pill--risk", label: "Blocked" },
};

function Block({
  block,
  stale,
  rewrite,
  make,
}: {
  block: CopyBlock;
  stale: boolean;
  rewrite: { briefId: string; spec: string } | null;
  /** A cleared card the viewer may make posts from carries the button that does it. */
  make: boolean;
}) {
  const tone = TONE[block.verdict];
  return (
    <EditableCard
      briefId={rewrite?.briefId ?? ""}
      copyId={block.id}
      seenAt={block.generatedAt}
      copy={{ headline: block.headline, body: block.body, cta: block.cta }}
      language={block.language}
      editable={!!rewrite}
      attrs={{ "data-block": `${block.language}:${block.segment}`, "data-angle": block.angle }}
      label={
        <span className="pill pill--quiet">
          {block.angle === "GENERAL" ? segmentLabel(block.segment) : `For ${lowerWords(angleLabel(block.angle))} ads`}
        </span>
      }
      tags={
        <>
          {stale && (
            <span className="pill pill--quiet" data-stale>
              Before your changes
            </span>
          )}
          <span className={`pill ${tone.pill}`} data-verdict={block.verdict}>
            {tone.label}
          </span>
        </>
      }
      reasons={
        block.reasons.length > 0 ? (
          <ul className="copyblock__why">
            {block.reasons.map((r, i) => (
              <li key={`${r.code}-${i}`}>{r.detail}</li>
            ))}
          </ul>
        ) : null
      }
      acts={
        make || rewrite ? (
          <div className="copyblock__acts">
            {make && <MakePostButton cardId={block.id} />}
            {rewrite && <RewriteOne briefId={rewrite.briefId} spec={rewrite.spec} />}
          </div>
        ) : null
      }
    />
  );
}

function Fact({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone: "ok" | "warn" | "risk" | "quiet";
}) {
  return (
    <div className={`groundfact groundfact--${tone}`}>
      <span className="groundfact__label">{label}</span>
      <strong className="groundfact__value">{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

/** "Site visit" reads "site visit" mid-sentence; "NRI" stays NRI. */
function lowerWords(s: string): string {
  return s.replace(/\b([A-Z])([a-z]+)/g, (_, a: string, b: string) => a.toLowerCase() + b);
}
