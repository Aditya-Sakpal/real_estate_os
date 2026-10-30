import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { approvedUpcoming, reviewQueue, type ApprovedRow, type CreativeRow } from "@/lib/post";
import { segmentLabel } from "@/lib/creative-rules";
import { templateDef } from "@/lib/post-rules";
import { kindDef } from "@/lib/compose-rules";
import { destinationDef, isDestination, showRupees } from "@/lib/connect-rules";
import { usesAd } from "@/lib/plan-rules";
import { approveCreativeAction, rejectCreativeAction } from "@/app/actions/post";
import { Alert, ArrowUpRight, Check, Clock, Inbox } from "@/components/icons";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { QueueMedia } from "./QueueMedia";
import "../live/published.css";
import "./queue.css";

/**
 * Everything a scheduled run wrote that is waiting on a person.
 *
 * This is the screen that makes REVIEW mode real. Nothing a schedule produces
 * reaches a buyer without somebody opening this and pressing a button. A
 * post whose picture the pixel gate did not clear shows why here, and it
 * never goes out, approved or not.
 *
 * Blocked posts are here too, and they are not actionable. A refusal nobody
 * can see is a refusal nobody can fix, and the reason nearly always names
 * something missing from the Brain rather than something wrong with the
 * writing. They sit at the bottom, and the button on them is not an approve
 * button, because a control that cannot do its job must not look like one.
 */

/** How the publish time reads to somebody deciding whether they are late. */
function whenIst(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function hoursLeft(iso: string, now: number): number {
  return Math.round((new Date(iso).getTime() - now) / 3_600_000);
}

/** "Due now", "40 min" or "6h": under an hour, an hour rounded is a lie. */
function dueIn(iso: string, now: number): string {
  const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (minutes <= 0) return "Due now";
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)}h`;
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; error_s?: string; approved?: string; rejected?: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");

  const q = await searchParams;
  const error = readFlash(q, "error");
  const mayDecide = viewer.authz.can("creative:approve");
  const scopes = viewer.authz.scopesFor("campaign:read");
  const [queue, upcoming] = await Promise.all([
    reviewQueue(viewer.state.org.id, { scopes }),
    approvedUpcoming(viewer.state.org.id, { scopes }),
  ]);
  const now = Date.now();

  const waiting = queue.filter((c) => c.verdict !== "FAIL");
  const blocked = queue.filter((c) => c.verdict === "FAIL");

  return (
    <>
      <PageHead
        title={
          <>
            Waiting on <span className="em">you</span>
          </>
        }
        meta={
          queue.length === 0
            ? "Nothing scheduled is waiting for a decision."
            : `${waiting.length} to decide${blocked.length ? `, ${blocked.length} blocked by the checks` : ""}.`
        }
        back={{ label: "Campaigns", href: "/dashboard/campaigns" }}
      />

      <Flash text={error} name="error" style={{ marginBottom: 16 }} />
      {q.approved && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Approved.
        </div>
      )}
      {q.rejected && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Sent back.
        </div>
      )}

      {queue.length === 0 && upcoming.length === 0 ? (
        <section className="card cmp-none" aria-label="Waiting on you">
          <span className="empty__mark cmp-none__mark" aria-hidden>
            <Inbox size={17} />
          </span>
          <span className="cmp-none__text">
            <strong>Scheduled posts wait here before they go out</strong>
            <span>Set a schedule on a campaign to start one.</span>
          </span>
          <Link href="/dashboard/campaigns" className="btn btn--ink btn--sm">
            Open campaigns
            <ArrowUpRight size={13} />
          </Link>
        </section>
      ) : (
        <>
          {waiting.length > 0 && (
            <section className="card">
              <div className="card__head">
                <h2>To decide</h2>
                <span className="pill pill--quiet">{waiting.length}</span>
              </div>
              <div className="postqueue">
                {waiting.map((c) => (
                  <Post key={c.id} creative={c} now={now} mayDecide={mayDecide} />
                ))}
              </div>
            </section>
          )}

          {blocked.length > 0 && (
            <section className="card" style={{ marginTop: 16 }}>
              <div className="card__head">
                <h2>Blocked by the checks</h2>
                <span className="pill pill--risk">{blocked.length}</span>
              </div>
              <div className="postqueue">
                {blocked.map((c) => (
                  <Post key={c.id} creative={c} now={now} mayDecide={false} />
                ))}
              </div>
            </section>
          )}

          {upcoming.length > 0 && (
            <section className="card" style={{ marginTop: waiting.length || blocked.length ? 16 : 0 }}>
              <div className="card__head">
                <h2>Approved, going out</h2>
                <span className="pill pill--quiet">{upcoming.length}</span>
              </div>
              <ul className="cq-upcoming">
                {upcoming.map((u) => (
                  <Upcoming key={u.id} row={u} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}

function Post({
  creative,
  now,
  mayDecide,
}: {
  creative: CreativeRow;
  now: number;
  mayDecide: boolean;
}) {
  const left = hoursLeft(creative.publishAt, now);
  const template = templateDef(creative.template)?.label ?? creative.template;
  const tone =
    creative.verdict === "FAIL" ? "risk" : creative.verdict === "HOLD" ? "warn" : "ok";
  // Approving an ad starts spend, so the button and a tag say so.
  const ad = usesAd(creative.outlet);
  const approveLabel =
    creative.outlet === "AD" ? "Approve and start ad" : creative.outlet === "BOTH" ? "Approve, post and start ad" : "Approve";

  return (
    <article className="postcard">
      <header className="postcard__head">
        <span className="postcard__who">
          <strong>{creative.nodeName}</strong>
          <small>
            {kindDef(creative.kind).label}
            {creative.media[0]?.placement ? ` for ${creative.media[0].placement}` : ""} ·{" "}
            {creative.language} · {segmentLabel(creative.segment)} · {template}
            {creative.occasionName ? ` · ${creative.occasionName}` : ""}
          </small>
        </span>
        <span className="postcard__tags">
          <span className={`pill pill--${tone}`}>
            <span className="pill__dot" />
            {creative.verdict === "PASS"
              ? "Cleared"
              : creative.verdict === "HOLD"
                ? "Needs a read"
                : "Blocked"}
          </span>
          <span className={`pill ${left <= 4 ? "pill--warn" : "pill--quiet"}`}>
            <Clock size={11} />
            {dueIn(creative.publishAt, now)}
          </span>
          {ad && (
            <span className="pill pill--blue" data-ad>
              {creative.outlet === "BOTH" ? "Organic and ad" : "Ad"}
              {creative.adDailyBudget ? ` · ${showRupees(creative.adDailyBudget)} a day` : ""} ·{" "}
              {creative.adDays} days
            </span>
          )}
        </span>
      </header>

      {/* The post a person is approving, not only its words. A carousel
          shows every slide, because approving a cover is not approving the
          four slides behind it, so its strip keeps the whole width; a single
          picture sits beside the words it carries. */}
      <div className={`cq-post${creative.media.length === 1 ? " cq-post--beside" : ""}`}>
      {creative.media.length > 0 && (
        <QueueMedia creativeId={creative.id} headline={creative.headline} media={creative.media} />
      )}
      <div className="cq-post__words">
      {creative.postReview && !creative.postReview.passed && (
        <ul className="posttile__problems" data-problems>
          <li>
            <strong>No picture passed every check, so none is shown.</strong>
          </li>
          {/* One line per problem: the same fault on several slides or
              attempts reads once. */}
          {[...new Set(creative.postReview.problems.map((p) => p.text))].map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      {creative.media.length > 0 && creative.pixel && creative.pixel.verdict !== "PASS" && (
        <ul className="posttile__problems" data-pixel-problems>
          <li>
            <strong>
              {creative.pixel.verdict === "HOLD"
                ? "This picture cannot go out until a person sorts this out."
                : "This picture did not pass its check and cannot go out."}
            </strong>
          </li>
          {creative.pixel.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}

      <div className="postcard__copy">
        <p className="postcard__headline">{creative.headline}</p>
        <p className="postcard__body">{creative.body}</p>
        <p className="postcard__cta">{creative.cta}</p>
      </div>

      {creative.reasons.length > 0 && (
        <ul className={`postcard__why postcard__why--${tone}`}>
          {creative.reasons.map((r, i) => (
            <li key={`${r.code}-${i}`}>
              {creative.verdict === "FAIL" ? <Alert size={12} /> : <Clock size={12} />}
              {r.detail}
            </li>
          ))}
        </ul>
      )}
      </div>
      </div>

      <footer className="postcard__foot">
        <span className="postcard__meta">
          Goes out {whenIst(creative.publishAt)} IST
          {creative.hardStopAt ? ` · not after ${whenIst(creative.hardStopAt)}` : ""}
          {creative.inputCount > 0
            ? ` · built from ${creative.inputCount} approved ${creative.inputCount === 1 ? "thing" : "things"}`
            : ""}
        </span>

        {mayDecide ? (
          <span className="postcard__acts">
            {/* The note is typed, so a refusal is said here and keeps it. */}
            <KeptForm action={rejectCreativeAction} className="postcard__send" style={{ flexWrap: "wrap" }} messageAt="bottom">
              <input type="hidden" name="creativeId" value={creative.id} />
              <input
                type="text"
                name="note"
                maxLength={200}
                placeholder="What to change. Optional."
                aria-label="What to change"
              />
              <button type="submit" className="btn btn--ghost btn--sm" data-reject>
                Send back
              </button>
            </KeptForm>
            <form action={approveCreativeAction}>
              <input type="hidden" name="creativeId" value={creative.id} />
              <button type="submit" className="btn btn--ink btn--sm" data-approve>
                {approveLabel}
                <Check size={13} />
              </button>
            </form>
          </span>
        ) : creative.verdict === "FAIL" ? (
          <Link href="/dashboard/campaigns" className="postcard__fix">
            Fix what it names
          </Link>
        ) : (
          <span className="pill pill--quiet">View only</span>
        )}
      </footer>
    </article>
  );
}

function Upcoming({ row }: { row: ApprovedRow }) {
  const where = row.destinations
    .filter(isDestination)
    .filter((d) => (row.outlet === "BOTH" ? true : (destinationDef(d).mode === "AD") === (row.outlet === "AD")))
    .map((d) => destinationDef(d).label);
  return (
    <li className="cq-upcoming__row">
      <span className="cq-upcoming__what">
        <strong>{row.headline}</strong>
        <small>
          {row.nodeName} · {kindDef(row.kind).label}
        </small>
      </span>
      <span className="cq-upcoming__when">
        {whenIst(row.publishAt)} IST · {where.length ? where.join(", ") : "Not posted anywhere: download it from the campaign"}
      </span>
      {row.publishNote && (
        <span className="cq-upcoming__note">
          <Alert size={12} />
          {row.publishNote}
        </span>
      )}
    </li>
  );
}
