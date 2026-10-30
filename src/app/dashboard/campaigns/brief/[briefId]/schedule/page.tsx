import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getViewer } from "@/lib/console";
import { loadBrief } from "@/lib/campaign";
import { briefGaps } from "@/lib/campaign-rules";
import { listRuns, listSchedulesForBrief, optIns, styleOptionsFor, type RunRow, type ScheduleRow } from "@/lib/post";
import { listTemplates } from "@/lib/templates";
import { SEGMENTS } from "@/lib/creative-rules";
import type { StyleChoices } from "./StyleEditor";
import {
  refusalMessage,
  runLabel,
  runTone,
  showMinute,
  AUTO_AVAILABLE,
  DAY_NAMES,
  REVIEW_LEAD_MINUTES,
} from "@/lib/post-rules";
import {
  createScheduleAction,
  removeScheduleAction,
  saveScheduleAction,
  startScheduleAction,
  stopScheduleAction,
} from "@/app/actions/post";
import { Alert, Check, Clock, Plus } from "@/components/icons";
import { PageHead } from "@/components/shell/PageHead";
import ScheduleForm from "./ScheduleForm";
import { kindUnavailable, showWeek, POST_KINDS } from "@/lib/compose-rules";
import { destinationsFor } from "@/lib/connect";
import {
  AD_GOALS,
  SCHEDULE_AD_DESTINATIONS,
  SCHEDULE_DESTINATIONS,
  adGoalLabel,
  defaultGoal,
  destinationDef,
  goalProblem,
  isAd,
  showRupees,
} from "@/lib/connect-rules";
import { alwaysOnFor, metaGoalFactsAt } from "@/lib/publish";
import { resolveBrand } from "@/lib/brand";
import { AlwaysOnPanel } from "./AlwaysOnPanel";
import { outletsInUse, showDate, usesAd } from "@/lib/plan-rules";
import { resolveBrain } from "@/lib/brain";
import { asList } from "@/lib/brain-rules";
import { sellingPoints } from "@/lib/creative-rules";
import { readFlash } from "@/lib/flash";
import { Flash } from "@/components/Flash";
import { ConfirmAction } from "@/components/ConfirmAction";
import { numberAt } from "@/lib/broadcast";

/**
 * When this campaign writes itself.
 *
 * A brief says what a push is FOR. This says how often it happens, and it is
 * the only screen in the product that commits the org to spending money
 * without somebody pressing a button each time, so two things are said
 * plainly and neither is buried.
 *
 * Every post waits for a person unless the schedule sends automatically,
 * which only somebody who could approve and publish the posts may choose,
 * behind a warning they have to tick. A schedule that does says so on its row.
 * So does one that makes ads, which only somebody holding the budget key may
 * set up, against the project's own Meta ad account.
 *
 * And a schedule that is running can be stopped from here by anybody who can
 * approve a post, which is a wider set of people than those who can write
 * one.
 */

const FORM = "scheduleform";

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

export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ briefId: string }>;
  searchParams: Promise<{
    add?: string;
    edit?: string;
    saved?: string;
    created?: string;
    error?: string;
    error_s?: string;
    note?: string;
    note_s?: string;
    stopped?: string;
    started?: string;
    removed?: string;
  }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("campaign:read")) redirect("/dashboard");

  const { briefId } = await params;
  const q = await searchParams;
  const orgId = viewer.state.org.id;

  const view = await loadBrief(orgId, briefId);
  if (!view) notFound();
  const { node, brief } = view;
  if (!viewer.authz.canAt("campaign:read", node.path)) notFound();
  const error = readFlash(q, "error");
  const note = readFlash(q, "note");

  const mayWrite = viewer.authz.canAt("campaign:create", node.path);
  const mayStop = viewer.authz.canAt("creative:approve", node.path);
  const mayPublish = viewer.authz.canAt("campaign:publish", node.path);
  const mayBudget = viewer.authz.canAt("campaign.budget:manage", node.path);
  const [schedules, resolved, whatsapp, alwaysOn, brand, goalFacts] = await Promise.all([
    listSchedulesForBrief(orgId, brief.id),
    mayPublish ? destinationsFor(orgId, node.path) : Promise.resolve(null),
    mayPublish && mayBudget ? numberAt(orgId, node.id) : Promise.resolve(false),
    alwaysOnFor(orgId, brief.id),
    resolveBrand(orgId, node.id),
    mayPublish && mayBudget ? metaGoalFactsAt(orgId, node.path) : Promise.resolve(null),
  ]);
  // A broadcast of every approved post decides the spend once, on the
  // schedule, so it is offered to somebody holding both keys, with a number.
  const broadcast = mayPublish && mayBudget && whatsapp;
  // Where approved posts can go, for the form. Only offered to somebody who
  // may publish: choosing where posts go is a publishing decision.
  const destinations = resolved
    ? SCHEDULE_DESTINATIONS.map((d) => {
        const r = resolved.get(d);
        return {
          key: d,
          label: destinationDef(d).label,
          account: r?.ok ? r.to.account.name : null,
          reason: r && !r.ok ? r.reason : null,
        };
      })
    : null;
  // Ads from a schedule go to the project's Meta ad account, its Google Ads
  // account for Demand Gen, or both, so the choice is offered only with one
  // connected and to somebody who may set its budget.
  const places = SCHEDULE_AD_DESTINATIONS.map((d) => {
    const r = resolved?.get(d);
    return {
      key: d,
      label: destinationDef(d).label,
      account: r?.ok ? r.to.account.name : null,
      cap: r?.ok ? r.to.account.dailyCap : null,
      reason: r && !r.ok ? r.reason : null,
    };
  });
  const ads =
    mayBudget && places.some((p) => p.account)
      ? {
          places,
          goals: AD_GOALS.map((g) => {
            const why = goalFacts ? goalProblem(g.key, goalFacts) : "Not available.";
            return { key: g.key, label: g.label, detail: g.detail, ok: !why, reason: why };
          }),
          defaultGoal: goalFacts ? defaultGoal(goalFacts) : "TRAFFIC",
        }
      : null;
  // This campaign's own runs: the organisation's latest twelve left a busy
  // campaign's history to whatever the other campaigns had not filled.
  const mine = schedules.length ? await listRuns(orgId, { briefId, limit: 12 }) : [];

  // A schedule on an unfinished brief would fire and refuse, every time, and
  // the refusal would name the brief. Saying so before the form is the same
  // rule the studio follows: the cheap refusal comes first.
  const gaps = briefGaps(brief);
  const notReady = brief.status !== "READY" || gaps.length > 0;
  // Sending automatically approves and publishes on the person's behalf, so
  // only somebody holding both keys here may choose it, or change a
  // schedule that already does.
  const mayAuto = AUTO_AVAILABLE && mayStop && mayPublish;
  // The same for a schedule that makes ads: changing it is a budget decision.
  const mayChange = (s: ScheduleRow) =>
    mayWrite && (s.mode !== "AUTO" || mayAuto) && (!makesAds(s) || !!ads) && (!s.broadcast || broadcast);
  const editing = q.edit ? schedules.find((s) => s.id === q.edit && mayChange(s)) ?? null : null;
  const adding = !editing && q.add === "1" && mayWrite && !notReady;
  const formOpen = adding || !!editing;
  // The starting week offers a carousel only with three selling points to fill it.
  const [points, styleChoices, festivals] = formOpen
    ? await Promise.all([
        resolveBrain(orgId, node.id).then((b) => sellingPoints(asList(b?.values["claims.talking_points"])).length),
        choicesFor(brief),
        // How many festivals this developer marked: on those days an image
        // the AI designs is a festival post.
        optIns(orgId).then((keys) => keys.length),
      ])
    : [0, null, 0];

  return (
    <>
      <PageHead
        title={
          <>
            When this <span className="em">runs</span>
          </>
        }
        meta={`${brief.name} · ${node.name}`}
        back={{ label: brief.name, href: `/dashboard/campaigns/brief/${brief.id}` }}
        action={
          formOpen ? (
            <>
              <Link
                href={`/dashboard/campaigns/brief/${brief.id}/schedule`}
                className="btn btn--ghost"
              >
                Cancel
              </Link>
              <button type="submit" form={FORM} className="btn btn--ink" data-save>
                {editing ? "Save changes" : "Save the schedule"}
                <Check size={14} />
              </button>
            </>
          ) : mayWrite && !notReady ? (
            <Link
              href={`/dashboard/campaigns/brief/${brief.id}/schedule?add=1`}
              className="btn btn--ink"
              data-add
            >
              Add a schedule
              <Plus size={14} />
            </Link>
          ) : null
        }
      />

      <Flash text={error} name="error" style={{ marginBottom: 16 }} />
      <Flash text={note} name="note" tone="info" style={{ marginBottom: 16 }} />
      {q.created && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Schedule saved.
        </div>
      )}
      {q.stopped && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Stopped. Nothing further will be written.
        </div>
      )}
      {q.started && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Running again.
        </div>
      )}
      {q.removed && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Schedule removed.
        </div>
      )}
      {q.saved && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          Changes saved. They apply from the next post that has not been written yet.
        </div>
      )}

      {notReady && (
        <div className="note note--warn" style={{ marginBottom: 16 }}>
          <strong>Mark the brief ready first</strong>
          {gaps.length
            ? `Still to fill in: ${gaps.map((g) => g.label).join(", ")}.`
            : "This brief is still a draft."}
        </div>
      )}

      {formOpen && (
        <ScheduleForm
          key={editing?.id ?? "new"}
          id={FORM}
          briefId={brief.id}
          action={editing ? saveScheduleAction : createScheduleAction}
          dayNames={DAY_NAMES}
          defaultLead={REVIEW_LEAD_MINUTES}
          autoAvailable={mayAuto}
          ads={ads}
          broadcast={broadcast}
          kinds={POST_KINDS.map((k) => ({
            key: k.key,
            label: k.label,
            unavailable: kindUnavailable(k.key, brief.formats),
          }))}
          destinations={destinations}
          sellingPoints={points}
          styleChoices={styleChoices!}
          festivals={festivals}
          initial={
            editing
              ? {
                  id: editing.id,
                  name: editing.name,
                  mode: editing.mode,
                  repeat: editing.repeat,
                  dayKinds: editing.dayKinds,
                  dayOutlets: editing.dayOutlets,
                  dated: editing.dated,
                  adDailyBudget: editing.adDailyBudget,
                  adDays: editing.adDays,
                  adGoal: editing.adGoal,
                  atMinute: editing.atMinute,
                  leadMinutes: editing.leadMinutes,
                  maxRunsPerDay: editing.maxRunsPerDay,
                  startsOn: editing.startsOn,
                  endsOn: editing.endsOn,
                  destinations: editing.destinations,
                  broadcast: editing.broadcast,
                  broadcastCap: editing.broadcastCap,
                  styles: editing.styles,
                  dayStyles: editing.dayStyles,
                }
              : null
          }
        />
      )}

      <section className="card" style={{ marginTop: formOpen ? 16 : 0 }}>
        <div className="card__head">
          <h2>Schedules</h2>
          <span className="pill pill--quiet">{schedules.length}</span>
        </div>

        {schedules.length === 0 ? (
          <div className="empty" style={{ padding: "26px 20px" }}>
            <div className="empty__mark">
              <Clock size={19} />
            </div>
            Nothing runs on its own yet.
          </div>
        ) : (
          <div className="schedules">
            {schedules.map((s) => (
              <Row
                key={s.id}
                schedule={s}
                briefId={brief.id}
                mayStop={mayStop}
                mayWrite={mayWrite}
                mayEdit={mayChange(s) && editing?.id !== s.id}
              />
            ))}
          </div>
        )}
      </section>

      {!notReady && (
        <AlwaysOnPanel
          briefId={brief.id}
          items={alwaysOn}
          mayStart={mayPublish}
          mayStop={mayStop || mayPublish || mayBudget}
          website={brand?.kit.website ?? null}
        />
      )}

      {mine.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card__head">
            <h2>What has run</h2>
            <Link href="/dashboard/campaigns/queue" className="btn btn--ghost btn--sm">
              Open the queue
            </Link>
          </div>
          <div className="runs">
            {mine.map((r) => (
              <RunLine key={r.id} run={r} named={schedules.length > 1} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * What a post's style may be on this brief: its languages, every buyer, its
 * sizes, the design templates a schedule may follow (the studio's, less the
 * two films a worker makes apart) and, in the editor, every font.
 */
async function choicesFor(brief: { languages: string[] | null; formats: string[] | null }): Promise<StyleChoices> {
  const options = styleOptionsFor(brief);
  const [image, carousel, video] = await Promise.all([
    listTemplates("IMAGE"),
    listTemplates("CAROUSEL"),
    listTemplates("VIDEO"),
  ]);
  const allowed = (kind: "IMAGE" | "CAROUSEL" | "VIDEO", list: typeof image) =>
    list
      .filter((t) => options.templates[kind].includes(t.key))
      .sort((a, b) => Number(!!b.hot) - Number(!!a.hot));
  return {
    languages: [...options.languages],
    buyers: SEGMENTS.map((x) => ({ key: x.key, label: x.label })),
    sizes: { IMAGE: [...options.sizes.IMAGE], CAROUSEL: [...options.sizes.CAROUSEL], VIDEO: [...options.sizes.VIDEO] },
    templates: { IMAGE: allowed("IMAGE", image), CAROUSEL: allowed("CAROUSEL", carousel), VIDEO: allowed("VIDEO", video) },
  };
}

function Row({
  schedule,
  briefId,
  mayStop,
  mayWrite,
  mayEdit,
}: {
  schedule: ScheduleRow;
  briefId: string;
  mayStop: boolean;
  mayWrite: boolean;
  mayEdit: boolean;
}) {
  return (
    <div className={`schedule ${schedule.active ? "" : "schedule--off"}`}>
      <div className="schedule__id">
        <strong>{schedule.name}</strong>
        <small>
          {schedule.repeat === "DATES"
            ? datesLine(schedule)
            : `${showWeek(schedule.dayKinds)} at ${showMinute(schedule.atMinute)} IST`}{" "}
          · written {Math.round(schedule.leadMinutes / 60)}h ahead
        </small>
      </div>

      <div className="schedule__state">
        {schedule.active && schedule.nextSlot ? (
          <>
            <span className="pill pill--ok">
              <span className="pill__dot" />
              Running
            </span>
            <span className="pill pill--quiet">Next {whenIst(schedule.nextSlot)}</span>
          </>
        ) : schedule.active ? (
          // Nothing left to run: the end date or the last picked date has gone by.
          <span className="pill pill--quiet" data-finished>
            Finished
          </span>
        ) : (
          <span className="pill pill--quiet">
            Stopped
            {schedule.stoppedByName ? ` by ${schedule.stoppedByName}` : ""}
          </span>
        )}
        {schedule.awaiting > 0 && (
          <Link href="/dashboard/campaigns/queue" className="pill pill--warn">
            {schedule.awaiting} waiting
          </Link>
        )}
        {AUTO_AVAILABLE && schedule.mode === "AUTO" && (
          <span className="pill pill--warn" data-auto>
            Sends automatically
          </span>
        )}
        {(schedule.destinations.length > 0 || !schedule.broadcast) && (
          <span className="pill pill--quiet" data-destinations>
            {schedule.destinations.length
              ? `Goes to ${schedule.destinations.filter((d) => !isAd(d) || makesAds(schedule)).map((d) => destinationDef(d).label).join(", ")}`
              : "Downloaded, not posted"}
          </span>
        )}
        {schedule.broadcast && schedule.broadcastCap && (
          <span className="pill pill--blue" data-broadcast>
            WhatsApp broadcast, up to {schedule.broadcastCap.toLocaleString("en-IN")} people a post
          </span>
        )}
        {makesAds(schedule) && schedule.adDailyBudget && (
          <span className="pill pill--blue" data-ads>
            Ads {showRupees(schedule.adDailyBudget)} a day, {schedule.adDays} days each
          </span>
        )}
        {makesAds(schedule) && schedule.destinations.includes("META_AD") && (
          <span className="pill pill--quiet" data-goal>
            Meta ads for {adGoalLabel(schedule.adGoal)?.toLowerCase()}
          </span>
        )}
      </div>

      {!schedule.active && schedule.stoppedReason && (
        <p className="schedule__why">{schedule.stoppedReason}</p>
      )}

      <div className="schedule__acts">
        {mayEdit && (
          <Link
            href={`/dashboard/campaigns/brief/${briefId}/schedule?edit=${schedule.id}`}
            className="btn btn--ghost btn--sm"
            data-edit
          >
            Edit
          </Link>
        )}
        {mayStop &&
          (schedule.active ? (
            <form action={stopScheduleAction} className="schedule__stop">
              <input type="hidden" name="briefId" value={briefId} />
              <input type="hidden" name="scheduleId" value={schedule.id} />
              <input
                type="text"
                name="reason"
                maxLength={200}
                placeholder="Why it is stopping"
                aria-label="Why it is stopping"
              />
              <button type="submit" className="btn btn--ghost btn--sm" data-stop>
                Stop it
              </button>
            </form>
          ) : (
            <form action={startScheduleAction}>
              <input type="hidden" name="briefId" value={briefId} />
              <input type="hidden" name="scheduleId" value={schedule.id} />
              <button type="submit" className="btn btn--ghost btn--sm" data-start>
                Start it again
              </button>
            </form>
          ))}

        {/* Removing is offered only once it is stopped. A running schedule
            deleted outright takes its runs and the record of what they wrote
            with it, and somebody reaching for Remove usually means Stop. */}
        {mayWrite && !schedule.active && (
          <ConfirmAction
            label="Remove"
            title={`Remove ${schedule.name}?`}
            body={
              <p>
                The schedule and the record of what it wrote are deleted. Posts already published stay where
                they are.
              </p>
            }
            confirmLabel="Remove the schedule"
            action={removeScheduleAction}
            fields={{ briefId, scheduleId: schedule.id }}
            tone="risk"
            testId={`remove-${schedule.id}`}
          />
        )}
      </div>
    </div>
  );
}

/** Whether anything in this schedule's plan is an ad. */
function makesAds(s: ScheduleRow): boolean {
  return outletsInUse({ repeat: s.repeat, dayKinds: s.dayKinds, dayOutlets: s.dayOutlets, dated: s.dated }).some(usesAd);
}

/** "3 dates, next Sat 4 Oct", or when the last one went. */
function datesLine(s: ScheduleRow): string {
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const ahead = s.dated.filter((d) => d.on >= today);
  if (!ahead.length) return s.dated.length ? "Every picked date has gone by" : "No dates picked";
  return `${ahead.length} ${ahead.length === 1 ? "date" : "dates"}, next ${showDate(ahead[0].on)}`;
}

function RunLine({ run, named }: { run: RunRow; named: boolean }) {
  const tone = runTone(run.state);
  const refusal = run.refusalDetail ?? refusalMessage(run.refusalCode);
  return (
    <div className="runline">
      <span className="runline__when">
        {whenIst(run.slot)}
        {named && <small className="runline__name">{run.scheduleName}</small>}
      </span>
      <span className={`pill pill--${tone}`}>
        {tone === "risk" && <Alert size={11} />}
        {runLabel(run)}
      </span>
      {run.occasionName && <span className="pill pill--quiet">{run.occasionName}</span>}
      {refusal && <span className="runline__why">{refusal}</span>}
      {run.awaiting > 0 && (
        <Link href="/dashboard/campaigns/queue" className="runline__go">
          {run.awaiting} to decide
        </Link>
      )}
    </div>
  );
}
