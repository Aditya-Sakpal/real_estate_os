import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { heldScheduled, listPublications, type PublicationView } from "@/lib/publish";
import { inReach } from "@/lib/grant-rules";
import { complianceSummary } from "@/lib/publish-gate";
import { adFigures, campaignsElsewhere, towersToPlace, type AdFigures as Figures } from "@/lib/ad-budget";
import { Elsewhere } from "./Elsewhere";
import { showRupees, TARGET_TONE } from "@/lib/connect-rules";
import {
  activatePublicationAction,
  pausePublicationAction,
  retryPublicationAction,
  endAlwaysOnAction,
  takenDownAction,
} from "@/app/actions/publish";
import { PageHead } from "@/components/shell/PageHead";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { Alert, ArrowUpRight, Pause, Play } from "@/components/icons";
import { AdFigures, hasFigures } from "./AdFigures";
import { Broadcasts } from "./Broadcasts";
import { RetryButton } from "./RetryButton";
import { listBroadcasts } from "@/lib/broadcast";
import "./published.css";

/**
 * Everything that went out, and the controls on it.
 *
 * A work screen, so it opens on what needs a person: a post still up on a
 * phase that stopped being advertisable, one that failed, an ad that would
 * not pause, an approved scheduled post that could not go out. That list is
 * the group's dark card. Under it every publication, newest first, each with
 * the one control its state allows: Pause on a spending ad, Switch on on a
 * paused one, Try again on a failure.
 *
 * Stopping is open to anybody who may approve creative, publish or manage
 * budget, at that project. Starting spend is the budget key alone, behind a
 * confirmation that names the amount.
 *
 * An ad carries a second line: what it spent and brought, and the last time
 * its budget moved.
 */

type View = "all" | "ads" | "posts" | "needs";
const VIEWS: { key: View; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "ads", label: "Ads" },
  { key: "posts", label: "Posts" },
  { key: "needs", label: "Needs you" },
];

const STOP_KEYS = ["creative:approve", "campaign:publish", "campaign.budget:manage"];

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const needsYou = (p: PublicationView) =>
  p.state === "FAILED" || (p.state === "LIVE" && !!p.blockedAt) || (p.state === "ACTIVE" && !!p.errorCode);

export default async function PublishedPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    error?: string;
    error_s?: string;
    note?: string;
    note_s?: string;
    paused?: string;
    activated?: string;
    retried?: string;
    down?: string;
    broadcast?: string;
  }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");
  const q = await searchParams;
  const error = readFlash(q, "error");
  const note = readFlash(q, "note");
  const view: View = VIEWS.some((v) => v.key === q.view) ? (q.view as View) : "all";
  const orgId = viewer.state.org.id;

  // The ads' figures need the list, so they follow it; the other two reads
  // run alongside both.
  // Only what went out for places this person reaches.
  const reach = viewer.authz.scopesFor("campaign:read");
  const [[all, figures], held, compliance, broadcasts, elsewhere, towers] = await Promise.all([
    listPublications(orgId, { limit: 300 }).then(async (listed) => {
      const list = listed.filter((p) => inReach(p.nodePath, reach));
      return [list, await adFigures(orgId, list.filter((p) => p.ad).map((p) => p.id))] as const;
    }),
    heldScheduled(orgId).then((h) => h.filter((x) => inReach(x.nodePath, reach))),
    complianceSummary(orgId),
    listBroadcasts(orgId, viewer.authz.scopesFor("campaign:read")),
    // Spend on the ad account that nobody made here; the organisation's money.
    viewer.authz.can("report:read") || viewer.authz.can("campaign.budget:manage") ? campaignsElsewhere(orgId) : Promise.resolve([]),
    towersToPlace(orgId).then((t) => t.filter((x) => viewer.authz.canAt("campaign.budget:manage", x.path))),
  ]);
  const blockedPhases = new Set(compliance.blocked.map((p) => p.phaseId));
  const can = (key: string, path: string) => viewer.authz.canAt(key, path);

  const needs = all.filter(needsYou);
  const counts: Record<View, number> = {
    all: all.length,
    ads: all.filter((p) => p.ad).length,
    posts: all.filter((p) => !p.ad).length,
    needs: needs.length + held.length,
  };
  const shown =
    view === "ads" ? all.filter((p) => p.ad) : view === "posts" ? all.filter((p) => !p.ad) : view === "needs" ? needs : all;

  const live = all.filter((p) => p.state === "LIVE").length;
  const spending = all.filter((p) => p.state === "ACTIVE").length;
  const paused = all.filter((p) => p.state === "PAUSED").length;
  const meta = all.length
    ? [
        `${live} ${live === 1 ? "post" : "posts"} live`,
        `${spending} ${spending === 1 ? "ad" : "ads"} spending`,
        paused ? `${paused} paused` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Nothing has gone out yet.";

  const back = `/dashboard/campaigns/live${view === "all" ? "" : `?view=${view}`}`;

  return (
    <>
      <PageHead
        title={
          <>
            What went <span className="em">out</span>
          </>
        }
        meta={meta}
        back={{ label: "Campaigns", href: "/dashboard/campaigns" }}
      />

      <Flash text={error} name="error" />
      <Flash text={note} name="note" tone="info" />
      {(q.broadcast === "approved" || q.broadcast === "stopped") && (
        <div className="note note--info" role="status">
          {q.broadcast === "approved" ? "Approved. It goes out between 10 am and 9 pm." : "Stopped. Nobody waiting is sent anything."}
        </div>
      )}
      {(q.paused || q.activated || q.retried || q.down) && (
        <div className="note note--info" role="status">
          {q.paused
            ? "Paused. It has stopped spending."
            : q.activated
              ? "Switched on. It is spending."
              : q.retried
                ? "Tried again."
                : "Marked as taken down."}
        </div>
      )}

      {(needs.length > 0 || held.length > 0) && view !== "needs" && (
        <section className="pub-needs" aria-labelledby="pub-needs-title" data-needs>
          <div className="pub-needs__head">
            <h2 id="pub-needs-title">Needs you</h2>
            <span className="pub-needs__n tnum">{needs.length + held.length}</span>
          </div>
          <ul className="pub-needs__list">
            {needs.slice(0, 4).map((p) => (
              <li key={p.id} className="pub-needs__item">
                <span className="pub-needs__mark">
                  <Alert size={13} />
                </span>
                <span className="pub-needs__what">
                  <strong>{needLine(p)}</strong>
                  <small>
                    {p.headline} · {p.nodeName}
                  </small>
                </span>
                <NeedAction p={p} back={back} can={can} />
              </li>
            ))}
            {held.slice(0, Math.max(0, 4 - needs.length)).map((h) => (
              <li key={h.id} className="pub-needs__item">
                <span className="pub-needs__mark">
                  <Alert size={13} />
                </span>
                <span className="pub-needs__what">
                  <strong>Approved, not gone out: {h.note}</strong>
                  <small>
                    {h.headline} · {h.scheduleName}
                  </small>
                </span>
              </li>
            ))}
          </ul>
          {needs.length + held.length > 4 && (
            <Link href="/dashboard/campaigns/live?view=needs" className="pub-needs__more">
              All {needs.length + held.length}
              <ArrowUpRight size={12} />
            </Link>
          )}
        </section>
      )}

      {all.length === 0 && held.length === 0 && broadcasts.length === 0 ? (
        <section className="card cmp-none" aria-label="Published">
          <span className="empty__mark cmp-none__mark" aria-hidden>
            <ArrowUpRight size={17} />
          </span>
          <span className="cmp-none__text">
            <strong>Publish your first post</strong>
            <span>A checked post goes out from its campaign&apos;s studio, or on a schedule.</span>
          </span>
          <Link href="/dashboard/campaigns" className="btn btn--ink btn--sm">
            Open campaigns
            <ArrowUpRight size={13} />
          </Link>
        </section>
      ) : (
      <section className="card pub-sheet">
        <div className="ws-views" role="group" aria-label="Show">
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              href={v.key === "all" ? "/dashboard/campaigns/live" : `/dashboard/campaigns/live?view=${v.key}`}
              className={`ws-view${v.key === "needs" ? " ws-view--ink" : ""}`}
              aria-current={view === v.key ? "page" : undefined}
            >
              {v.label}
              <span className="ws-view__n tnum">{counts[v.key]}</span>
            </Link>
          ))}
        </div>

        {view === "needs" && held.length > 0 && (
          <ul className="pub-list">
            {held.map((h) => (
              <li key={h.id} className="pub-row pub-row--held">
                <span className="pub-row__thumb pub-row__thumb--none" aria-hidden="true" />
                <span className="pub-row__what">
                  <strong>{h.headline}</strong>
                  <small>
                    {h.nodeName} · {h.scheduleName}
                  </small>
                </span>
                <span className="pub-row__where">
                  <strong>Scheduled</strong>
                  <small>{when(h.publishAt)}</small>
                </span>
                <span className="pub-row__state">
                  <span className="pill pill--warn">Not gone out</span>
                  <small>{h.note}</small>
                </span>
              </li>
            ))}
          </ul>
        )}

        {shown.length === 0 && !(view === "needs" && held.length) ? (
          <div className="empty" style={{ padding: "34px 20px" }}>
            <div className="empty__mark">
              <ArrowUpRight size={18} />
            </div>
            {view === "needs"
              ? "Nothing needs you."
              : all.length === 0
                ? "Posts published from the studio, or by a schedule, appear here."
                : "Nothing of this kind has gone out."}
          </div>
        ) : (
          <ul className="pub-list" data-publications>
            {shown.map((p) => (
              <Row key={p.id} p={p} back={back} can={can} phaseBlocked={blockedPhases} figures={figures.get(p.id)} />
            ))}
          </ul>
        )}
      </section>
      )}

      {view !== "posts" && view !== "needs" && <Elsewhere list={elsewhere} towers={towers} back={back} />}
      {view !== "ads" && <Broadcasts list={broadcasts} back={back} can={can} />}
    </>
  );
}

function needLine(p: PublicationView): string {
  if (p.state === "LIVE" && p.blockedAt) return `Still up on ${p.destinationLabel}. Take it down: this project cannot be advertised.`;
  if (p.state === "ACTIVE") return `Still spending on ${p.destinationLabel}. It could not be paused.`;
  return `Did not go out to ${p.destinationLabel}: ${p.error ?? "it failed"}`;
}

function NeedAction({
  p,
  back,
  can,
}: {
  p: PublicationView;
  back: string;
  can: (key: string, path: string) => boolean;
}) {
  const stop = STOP_KEYS.some((k) => can(k, p.nodePath));
  if (p.state === "LIVE" && p.blockedAt && stop) {
    return (
      <span className="pub-needs__acts">
        {p.externalUrl && (
          <a href={p.externalUrl} target="_blank" rel="noreferrer" className="btn btn--light btn--sm">
            Open it
            <ArrowUpRight size={12} />
          </a>
        )}
        <form action={takenDownAction}>
          <input type="hidden" name="targetId" value={p.id} />
          <input type="hidden" name="back" value={back} />
          <button type="submit" className="btn btn--light btn--sm" data-taken-down={p.id}>
            It is down
          </button>
        </form>
      </span>
    );
  }
  if (p.state === "ACTIVE" && stop) {
    return (
      <form action={pausePublicationAction}>
        <input type="hidden" name="targetId" value={p.id} />
        <input type="hidden" name="back" value={back} />
        <button type="submit" className="btn btn--light btn--sm">
          Pause
        </button>
      </form>
    );
  }
  if (p.state === "FAILED" && can("campaign:publish", p.nodePath)) {
    return (
      <form action={retryPublicationAction}>
        <input type="hidden" name="targetId" value={p.id} />
        <input type="hidden" name="back" value={back} />
        <RetryButton id={p.id} tone="light" />
      </form>
    );
  }
  return null;
}

/** `12 Oct`, the day a scheduled ad stops. */
function endsOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
}

function Row({
  p,
  back,
  can,
  phaseBlocked,
  figures,
}: {
  p: PublicationView;
  back: string;
  can: (key: string, path: string) => boolean;
  phaseBlocked: Set<string>;
  figures?: Figures;
}) {
  const stop = STOP_KEYS.some((k) => can(k, p.nodePath));
  const budget = can("campaign.budget:manage", p.nodePath);
  const video = p.firstMedia?.type === "video/mp4";
  const tone = TARGET_TONE[p.state];

  let detail: string | null = null;
  if (p.state === "FAILED") detail = p.error;
  else if (p.state === "PAUSED" && p.pausedReason === "REGISTRATION") detail = "Paused when the registration stopped being valid";
  else if (p.state === "PAUSED" && p.pausedReason === "ENDED") detail = "Ran for the days it was given";
  else if (p.state === "LIVE" && p.blockedAt) detail = "This project cannot be advertised now";
  else if (p.state === "QUEUED" || p.state === "WORKING") detail = "The platform is still processing it";
  else if (p.state === "CANCELLED" && p.errorCode === "ENDED") detail = "Ended";
  else if (p.state === "CANCELLED" && p.errorCode !== "TAKEN_DOWN") detail = p.error;
  else if (p.ad && p.dailyBudget) {
    detail = `${showRupees(p.dailyBudget)} a day${p.endsAt ? `, until ${endsOn(p.endsAt)}` : ""}`;
  }
  const note = p.note && (p.state === "PAUSED" || p.state === "ACTIVE") ? p.note : null;
  const figs = hasFigures(p, figures) ? figures : null;

  return (
    <li
      className={`pub-row pub-row--${p.state.toLowerCase()}${figs ? " pub-row--figs" : ""}`}
      data-publication={p.id}
      data-state={p.state}
    >
      <span className="pub-row__thumb">
        {p.firstMedia &&
          (video ? (
            <span className="pub-row__video" aria-label="Video">
              <Play size={12} />
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/dashboard/campaigns/live/media/${p.id}?v=thumb`} alt="" loading="lazy" />
          ))}
      </span>
      <span className="pub-row__what">
        {p.ad ? (
          <Link href={`/dashboard/campaigns/live/ad/${p.id}`} className="pub-row__open" data-ad-page={p.id}>
            <strong>{p.headline}</strong>
          </Link>
        ) : (
          <strong>{p.headline}</strong>
        )}
        <small>
          {p.nodeName}
          {p.placement ? ` · ${p.placement}` : ""}
          {p.source === "SCHEDULE" ? " · scheduled" : ""}
          {p.source === "BRIEF" ? " · always on" : ""}
        </small>
      </span>
      <span className="pub-row__where">
        <strong>{p.destinationLabel}</strong>
        <small>
          {p.accountName}
          {p.goalLabel ? ` · ${p.goalLabel}` : ""}
        </small>
      </span>
      <span className="pub-row__state">
        <span className={`pill pill--${tone}`}>
          {(p.state === "ACTIVE" || p.state === "LIVE") && <span className="pill__dot" />}
          {p.stateLabel}
        </span>
        {detail && <small className={p.state === "FAILED" ? "pub-row__why--risk" : undefined}>{detail}</small>}
        {note && <small>{note}</small>}
      </span>
      <span className="pub-row__when tnum">{when(p.publishedAt ?? p.createdAt)}</span>
      <span className="pub-row__acts">
        {p.externalUrl && p.state !== "CANCELLED" && (
          <a href={p.externalUrl} target="_blank" rel="noreferrer" className="pub-row__link">
            {p.ad ? "Open in Ads" : "View"}
            <ArrowUpRight size={12} />
          </a>
        )}
        {p.state === "ACTIVE" && stop && (
          <form action={pausePublicationAction}>
            <input type="hidden" name="targetId" value={p.id} />
            <input type="hidden" name="back" value={back} />
            <button type="submit" className="btn btn--ghost btn--sm" data-pause={p.id}>
              <Pause size={12} />
              Pause
            </button>
          </form>
        )}
        {p.state === "PAUSED" && budget && p.pausedReason !== "ENDED" && !(p.pausedReason === "REGISTRATION" && phaseBlockedFor(p, phaseBlocked)) && (
          <ConfirmAction
            label={
              <>
                <Play size={12} />
                Switch on
              </>
            }
            title="Switch this ad on?"
            body={
              <p>
                It starts spending up to {p.dailyBudget ? showRupees(p.dailyBudget) : "its budget"} a day through{" "}
                {p.accountName}, {p.endsAt ? `until ${endsOn(p.endsAt)}` : "until somebody pauses it"}.
              </p>
            }
            confirmLabel={p.dailyBudget ? `Spend up to ${showRupees(p.dailyBudget)} a day` : "Switch it on"}
            action={activatePublicationAction}
            fields={{ targetId: p.id, back }}
            tone="ghost"
            testId={`activate-${p.id}`}
          />
        )}
        {p.source === "BRIEF" && stop && (p.state === "PAUSED" || p.state === "ACTIVE") && (
          <ConfirmAction
            label="End"
            title="End this campaign?"
            body={<p>It stops spending and no longer runs. A new one can be started from the campaign&apos;s schedule page.</p>}
            confirmLabel="End the campaign"
            action={endAlwaysOnAction}
            fields={{ targetId: p.id, back }}
            tone="ghost"
            testId={`end-${p.id}`}
          />
        )}
        {p.state === "FAILED" && can("campaign:publish", p.nodePath) && (
          <form action={retryPublicationAction}>
            <input type="hidden" name="targetId" value={p.id} />
            <input type="hidden" name="back" value={back} />
            <RetryButton id={p.id} tone="ghost" />
          </form>
        )}
      </span>
      {figs && <AdFigures id={p.id} figures={figs} />}
    </li>
  );
}

/** Whether the phase an ad was paused for is still blocked. Switching it on would only be refused. */
function phaseBlockedFor(p: PublicationView, blocked: Set<string>): boolean {
  return p.phaseId ? blocked.has(p.phaseId) : true;
}
