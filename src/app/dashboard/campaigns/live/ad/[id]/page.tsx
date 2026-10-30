import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import type { FunnelVerdict } from "@/lib/funnel-rules";
import { loadAdDetail, type AdShift } from "@/lib/ad-detail";
import { standingWords } from "@/lib/ad-detail-rules";
import { showRupees, TARGET_TONE } from "@/lib/connect-rules";
import { stageLabel } from "@/lib/lead-rules";
import { activatePublicationAction, pausePublicationAction } from "@/app/actions/publish";
import { PageHead } from "@/components/shell/PageHead";
import { ConfirmAction } from "@/components/ConfirmAction";
import { Flash } from "@/components/Flash";
import { readFlash } from "@/lib/flash";
import { ArrowUpRight, Pause, Play } from "@/components/icons";
import { DayChart } from "./DayChart";
import "./ad.css";

/**
 * One ad, for the person deciding whether to keep paying for it: what it
 * spent and brought, how that sits beside the other ads on the account, its
 * days, the buyers it brought and how each call went, and every time its
 * budget moved. Pausing it or switching it on is at the top, under the same
 * keys as on Published.
 */

const STOP_KEYS = ["creative:approve", "campaign:publish", "campaign.budget:manage"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayMonth(iso: string): string {
  const [, m, d] = new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const count = (n: number) => n.toLocaleString("en-IN");
const TEMP: Record<"HOT" | "WARM" | "COLD", { label: string; tone: string }> = {
  HOT: { label: "Hot", tone: "ok" },
  WARM: { label: "Warm", tone: "blue" },
  COLD: { label: "Cold", tone: "quiet" },
};

export default async function AdPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; error_s?: string; paused?: string; activated?: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const orgId = viewer.state.org.id;

  const d = await loadAdDetail(orgId, id, {
    campaignScopes: viewer.authz.scopesFor("campaign:read"),
    leadScopes: viewer.authz.scopesFor("lead:read"),
  });
  if (!d) notFound();
  const p = d.ad;
  const error = readFlash(q, "error");
  const self = `/dashboard/campaigns/live/ad/${p.id}`;
  const stop = STOP_KEYS.some((k) => viewer.authz.canAt(k, p.nodePath));
  const budget = viewer.authz.canAt("campaign.budget:manage", p.nodePath);
  const t = d.totals;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const video = p.firstMedia?.type === "video/mp4";

  const meta = [
    p.nodeName,
    p.dailyBudget ? `${showRupees(p.dailyBudget)} a day` : null,
    p.goalLabel,
    p.publishedAt ? `since ${dayMonth(p.publishedAt)}` : null,
    p.endsAt ? `until ${dayMonth(p.endsAt)}` : null,
  ].filter(Boolean);

  const action = (
    <>
      {p.externalUrl && p.state !== "CANCELLED" && (
        <a href={p.externalUrl} target="_blank" rel="noreferrer" className="btn btn--ghost">
          Open in Ads
          <ArrowUpRight size={13} />
        </a>
      )}
      {p.state === "ACTIVE" && stop && (
        <form action={pausePublicationAction}>
          <input type="hidden" name="targetId" value={p.id} />
          <input type="hidden" name="back" value={self} />
          <button type="submit" className="btn btn--ink" data-pause={p.id}>
            <Pause size={13} />
            Pause ad
          </button>
        </form>
      )}
      {p.state === "PAUSED" && budget && p.pausedReason !== "ENDED" && (
        <ConfirmAction
          label={
            <>
              <Play size={13} />
              Switch on
            </>
          }
          title="Switch this ad on?"
          body={
            <p>
              It starts spending up to {p.dailyBudget ? showRupees(p.dailyBudget) : "its budget"} a day through {p.accountName},{" "}
              {p.endsAt ? `until ${dayMonth(p.endsAt)}` : "until somebody pauses it"}.
            </p>
          }
          confirmLabel={p.dailyBudget ? `Spend up to ${showRupees(p.dailyBudget)} a day` : "Switch it on"}
          action={activatePublicationAction}
          fields={{ targetId: p.id, back: self }}
          testId={`activate-${p.id}`}
        />
      )}
    </>
  );

  return (
    <div className="ad-page" data-ad={p.id}>
      <PageHead
        back={{ label: "Published", href: "/dashboard/campaigns/live?view=ads" }}
        title={p.headline}
        meta={
          <span className="ad-meta">
            <span className={`pill pill--${TARGET_TONE[p.state]}`}>
              {(p.state === "ACTIVE" || p.state === "LIVE") && <span className="pill__dot" />}
              {p.stateLabel}
            </span>
            <span>{meta.join(" · ")}</span>
          </span>
        }
        action={action}
      />

      <Flash text={error} name="error" />
      {(q.paused || q.activated) && (
        <div className="note note--info" role="status">
          {q.paused ? "Paused. It has stopped spending." : "Switched on. It is spending."}
        </div>
      )}

      <section className="ad-top" aria-label="How it is doing">
        <div className="ad-kpis">
          <Kpi label="Spent" value={t.spend ? showRupees(t.spend) : "None"} />
          <Kpi label="Leads" value={count(t.leads)} />
          <Kpi label="Hot or warm" value={count(d.hotOrWarm)} sub={t.leads ? `of ${count(t.leads)}` : undefined} />
          <Kpi label="Visits" value={count(d.visits)} />
          <Kpi label="Bookings" value={count(d.bookings)} />
          <Kpi label="Seen by" value={d.reach ? count(d.reach.people) : "None"} sub={d.reach ? "people" : undefined} />
          <Kpi
            label="Times seen"
            value={d.reach?.frequency != null ? d.reach.frequency.toFixed(1) : "None"}
            sub={d.reach?.frequency != null ? "per person" : undefined}
          />
          <Kpi label="Clicks" value={count(t.clicks)} />
          <Kpi label="Click rate" value={t.clickRate !== null ? `${(t.clickRate * 100).toFixed(2)}%` : "None"} />
          <Kpi label="Per 1,000 seen" value={t.costPerThousand !== null ? showRupees(t.costPerThousand) : "None"} />
        </div>

        <div className="ad-hero" data-cost-per-lead>
          <p className="ad-hero__label">Cost per lead</p>
          <p className="ad-hero__num tnum">{t.costPerLead !== null ? showRupees(t.costPerLead) : "No lead yet"}</p>
          {d.standing ? (
            <>
              <p className="ad-hero__sub">
                {standingWords(d.standing)} the other {d.standing.count === 1 ? "ad" : `${d.standing.count} ads`} on {p.accountName}
              </p>
              <div className="ad-hero__bars" aria-hidden>
                <span className="ad-hero__bar ad-hero__bar--mine" style={{ width: `${barWidth(d.standing.mine, d.standing.others)}%` }} />
                <span className="ad-hero__bar" style={{ width: `${barWidth(d.standing.others, d.standing.mine)}%` }} />
              </div>
              <p className="ad-hero__key tnum">
                <span>This ad {showRupees(d.standing.mine)}</span>
                <span>Others {showRupees(d.standing.others)}</span>
              </p>
            </>
          ) : (
            <p className="ad-hero__sub">
              {t.costPerLead === null
                ? t.spend
                  ? `${showRupees(t.spend)} spent so far`
                  : "Nothing spent yet"
                : `No other ad on ${p.accountName} has brought a lead to compare with`}
            </p>
          )}
        </div>
      </section>

      <div className="stack ad-body">
        <Funnel f={d.funnel} />
        <DayChart days={d.days} today={today} />
        <Leads d={d} />
        <div className="pair">
          <div className="card ad-this">
            <div className="ad-this__media">
              {p.firstMedia &&
                (video ? (
                  <video
                    src={`/dashboard/campaigns/live/media/${p.id}?v=preview`}
                    poster={`/dashboard/campaigns/live/media/${p.id}?v=thumb`}
                    controls muted playsInline preload="metadata" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/dashboard/campaigns/live/media/${p.id}?v=thumb`} alt="The ad as it runs" />
                ))}
            </div>
            <dl className="ad-facts">
              <div>
                <dt>Runs on</dt>
                <dd>{p.destinationLabel}</dd>
              </div>
              <div>
                <dt>Ad account</dt>
                <dd>{p.accountName}</dd>
              </div>
              {p.placement && (
                <div>
                  <dt>Size</dt>
                  <dd>{p.placement}</dd>
                </div>
              )}
              {p.registrationNo && (
                <div>
                  <dt>Registration</dt>
                  <dd className="tnum">{p.registrationNo}</dd>
                </div>
              )}
              {p.requestedByName && (
                <div>
                  <dt>Started by</dt>
                  <dd>{p.requestedByName}</dd>
                </div>
              )}
            </dl>
            {d.health && (d.health.pause || d.health.refresh) && (
              <div className="ad-flags">
                {d.health.pause && <span className="pill pill--risk">Costs twice the others per result</span>}
                {d.health.refresh === "DUE" && <span className="pill pill--warn">Time for a new creative</span>}
                {d.health.refresh === "WATCH" && <span className="pill pill--warn">Tiring</span>}
              </div>
            )}
          </div>

          <div className="card ad-moves">
            <div className="card__head">
              <h2>Budget moves</h2>
            </div>
            {d.shifts.length ? (
              <ol className="ad-moves__list">
                {d.shifts.map((s) => (
                  <Move key={s.at} s={s} />
                ))}
              </ol>
            ) : (
              <p className="ad-empty">None yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="ad-kpi">
      <span className="ad-kpi__label">{label}</span>
      <span className="ad-kpi__num tnum">{value}</span>
      {sub && <span className="ad-kpi__sub">{sub}</span>}
    </div>
  );
}

const FUNNEL_PILL = { ok: "pill--ok", warn: "pill--warn", risk: "pill--risk", wait: "pill--quiet" } as const;
const FUNNEL_WORD = { ok: "On track", warn: "Watch", risk: "Needs a change", wait: "Too early" } as const;

/** What the leads became, stage by stage, against what good campaigns reach. */
function Funnel({ f }: { f: FunnelVerdict }) {
  return (
    <section className="card ad-funnel" aria-labelledby="ad-funnel-h" data-funnel={f.tone}>
      <div className="card__head">
        <h2 id="ad-funnel-h">
          What its leads <span className="em">became</span>
        </h2>
        <span className={`pill ${FUNNEL_PILL[f.tone]}`}>{FUNNEL_WORD[f.tone]}</span>
      </div>
      <p className="ad-funnel__say">{f.headline}</p>
      <ol className="ad-funnel__stages">
        {f.stages.map((st) => (
          <li key={st.label} className={st.low ? "is-low" : undefined}>
            <span className="ad-funnel__label">{st.label}</span>
            <span className="ad-funnel__num tnum">{count(st.count)}</span>
            <span className="ad-funnel__share tnum">
              {st.share !== null ? `${Math.round(st.share * 100)}%` : "None"}
              {st.aim !== null && <small> aim {Math.round(st.aim * 100)}%</small>}
            </span>
          </li>
        ))}
      </ol>
      {f.fix && <p className="ad-funnel__fix">{f.fix}</p>}
    </section>
  );
}

/** Two bars on one scale: the dearer one is full width. */
function barWidth(n: number, other: number): number {
  const top = Math.max(n, other, 1);
  return Math.max(4, Math.round((n / top) * 100));
}

function Move({ s }: { s: AdShift }) {
  const up = s.rule === "SCALE_UP";
  return (
    <li className="ad-move">
      <span className={`ad-move__dir ad-move__dir--${s.state === "FAILED" ? "failed" : up ? "up" : "down"}`} aria-hidden>
        {up ? "+" : "−"}
      </span>
      <span className="ad-move__what tnum">
        {showRupees(s.from)} to {showRupees(s.to)} a day
        <small>{s.state === "FAILED" ? "Did not go through" : up ? "Brought buyers cheaper" : "Cost more per buyer"}</small>
      </span>
      <span className="ad-move__when tnum">{dayMonth(s.at)}</span>
    </li>
  );
}

function Leads({ d }: { d: Awaited<ReturnType<typeof loadAdDetail>> & {} }) {
  return (
    <div className="card ad-leads">
      <div className="card__head">
        <h2>
          Leads from this <span className="em">ad</span>
        </h2>
        <span className="ad-leads__n tnum">{count(d.totals.leads)}</span>
      </div>
      {d.leads.length ? (
        <div className="ws-scroll">
          <table className="ws-table ad-leads__table">
            <thead>
              <tr>
                <th scope="col">Lead</th>
                <th scope="col">Came in</th>
                <th scope="col">Stage</th>
                <th scope="col">Score</th>
                <th scope="col">Last call</th>
              </tr>
            </thead>
            <tbody>
              {d.leads.map((l) => (
                <tr key={l.id}>
                  <th scope="row">
                    <Link href={`/dashboard/leads/${l.id}`} className="ad-leads__name">
                      {l.name}
                    </Link>
                  </th>
                  <td className="tnum ad-leads__when">{when(l.createdAt)}</td>
                  <td>{stageLabel(l.stage)}</td>
                  <td>{l.temperature ? <span className={`pill pill--${TEMP[l.temperature].tone}`}>{TEMP[l.temperature].label}</span> : <span className="ad-dim">Not read</span>}</td>
                  <td>
                    {l.lastCall ? (
                      <span className="ad-leads__call">
                        <span className={`pill pill--${l.lastCall.tone}`}>{l.lastCall.label}</span>
                        <small className="tnum">{when(l.lastCall.at)}</small>
                      </span>
                    ) : (
                      <span className="ad-dim">Not called</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ad-empty">{d.totals.leads ? "None of its leads are at places you can open." : "No leads yet."}</p>
      )}
      {d.leads.length > 0 && d.leadsHidden > 0 && (
        <p className="ad-leads__more">
          {count(d.leadsHidden)} more {d.leadsHidden === 1 ? "lead is" : "leads are"} at places you cannot open.
        </p>
      )}
    </div>
  );
}
