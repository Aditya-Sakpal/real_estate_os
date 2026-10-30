"use client";

import { useActionState, useState } from "react";
import type { PostState } from "@/app/actions/post";
import { useKeptSubmit } from "@/components/KeptForm";
import { DEFAULT_SLIDES, type PostKind } from "@/lib/compose-rules";
import {
  defaultStyles,
  styleOf,
  usesAd,
  AD_DAYS_DEFAULT,
  AD_DAYS_MAX,
  AD_DAYS_MIN,
  OUTLETS,
  REPEATS,
  type DatedPost,
  type Outlet,
  type PostStyle,
  type Repeat,
  type StyleSet,
} from "@/lib/plan-rules";
import DatePlan from "./DatePlan";
import StyleEditor, { FontFaces, styleLine, type StyleChoices } from "./StyleEditor";

/**
 * The cadence form.
 *
 * A client component because the plan answers as it is built: the calendar,
 * the ad settings that appear once something is an ad, and the warning that
 * appears the moment "Send automatically" is chosen. A refusal lands beside
 * the fields rather than as a redirect that clears them.
 *
 * Two ways to repeat share one form. Both halves stay mounted and only the
 * chosen one shows, so switching back and forth loses nothing typed.
 *
 * "Send automatically" and the Organic / Ad choice are rendered only for
 * somebody who could do those things by hand, with somewhere to send them.
 * Anybody else sees a plan with neither, not a disabled control.
 */
export default function ScheduleForm({
  id,
  briefId,
  action,
  dayNames,
  defaultLead,
  autoAvailable,
  kinds,
  destinations = null,
  ads = null,
  broadcast = false,
  initial = null,
  sellingPoints = 0,
  festivals = null,
  styleChoices,
}: {
  id: string;
  briefId: string;
  action: (previous: PostState, formData: FormData) => Promise<PostState>;
  dayNames: string[];
  defaultLead: number;
  autoAvailable: boolean;
  /** Image, carousel, video, and why one cannot be made for this brief. */
  kinds: { key: string; label: string; unavailable: string | null }[];
  /** Where approved posts can go, or null when this viewer may not publish. */
  destinations?: { key: string; label: string; account: string | null; reason: string | null }[] | null;
  /**
   * Where a schedule's ads may run (Meta, Google Demand Gen) and what a Meta
   * ad may be for, when this viewer may run ads from a schedule.
   */
  ads?: {
    places: { key: string; label: string; account: string | null; cap: number | null; reason: string | null }[];
    goals: { key: string; label: string; detail: string; ok: boolean; reason: string | null }[];
    defaultGoal: string;
  } | null;
  /** Whether this viewer may broadcast each post on the project's WhatsApp number. */
  broadcast?: boolean;
  /** The schedule being changed, or null for a new one. */
  initial?: ScheduleInitial | null;
  /** How many approved selling points the brief's project or tower has. */
  sellingPoints?: number;
  /** Festivals this developer marked on Occasions; null hides the line. */
  festivals?: number | null;
  /** What a post's style may be on this brief: the studio's choices. */
  styleChoices: StyleChoices;
}) {
  const [state, submit, pending] = useActionState(action, null);
  // A refusal keeps what was typed: React would otherwise reset the form.
  const keep = useKeptSubmit(submit);
  const wasAuto = initial?.mode === "AUTO";
  // Only with somewhere connected to send to: AUTO with no destination is
  // refused on save, so offering it would be a choice that cannot be made.
  // A schedule already sending automatically keeps the choice, so it can be
  // turned off.
  const offerAuto =
    autoAvailable && (wasAuto || !!ads || broadcast || !!destinations?.some((d) => d.account));
  const [broadcasting, setBroadcasting] = useState(initial?.broadcast ?? false);
  const [mode, setMode] = useState<"REVIEW" | "AUTO">(wasAuto ? "AUTO" : "REVIEW");
  const auto = offerAuto && mode === "AUTO";
  const leadOptions = withValue(LEAD_OPTIONS, initial?.leadMinutes, (m) =>
    m % 60 ? `${m} minutes` : `${m / 60} hours`);
  const runOptions = withValue(RUN_OPTIONS, initial?.maxRunsPerDay, String);

  // A starting week that shows the three kinds side by side, using only kinds
  // this brief can make: a default the brief cannot honour would be a choice
  // made for the person that the run then quietly changes. A carousel is a
  // slide per selling point, so it is offered only with three to fill it.
  const can = (k: string) => kinds.some((x) => x.key === k && !x.unavailable);
  const starter: (string | null)[] = [
    null,
    can("IMAGE") ? "IMAGE" : null,
    null,
    can("CAROUSEL") && sellingPoints >= 3 ? "CAROUSEL" : can("IMAGE") ? "IMAGE" : null,
    null,
    can("VIDEO") ? "VIDEO" : can("IMAGE") ? "IMAGE" : null,
    null,
  ];
  const [repeat, setRepeat] = useState<Repeat>(initial?.repeat ?? "WEEKLY");
  const [week, setWeek] = useState<string[]>(() =>
    Array.from({ length: 7 }, (_, d) => (initial ? initial.dayKinds[d] : starter[d]) ?? ""),
  );
  const [outlets, setOutlets] = useState<Outlet[]>(() =>
    Array.from({ length: 7 }, (_, d) => (ads ? (initial?.dayOutlets[d] ?? "POST") : "POST")),
  );
  const [dated, setDated] = useState<DatedPost[]>(() => {
    // Dates already gone by are dropped from the plan when it is opened; the
    // runs they made keep their own record.
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    return (initial?.dated ?? []).filter((d) => d.on >= today);
  });

  const usable = kinds.filter((k) => !k.unavailable).map((k) => ({ key: k.key as PostKind, label: k.label }));
  const planOutlets: Outlet[] =
    repeat === "DATES" ? dated.map((d) => d.outlet) : week.flatMap((k, d) => (k ? [outlets[d]] : []));
  const hasAd = !!ads && planOutlets.some(usesAd);
  // Where the ads run: what the schedule had, or Meta when it has an account.
  const [adPlaces, setAdPlaces] = useState<string[]>(() => {
    const had = (initial?.destinations ?? []).filter((d) => ads?.places.some((p) => p.key === d));
    if (had.length) return had;
    const first = ads?.places.find((p) => p.account);
    return first ? [first.key] : [];
  });
  const [adGoal, setAdGoal] = useState<string>(() => {
    const had = initial?.adGoal;
    return had && ads?.goals.some((g) => g.key === had && g.ok) ? had : ads?.defaultGoal ?? "TRAFFIC";
  });
  const adCap = (() => {
    const caps = (ads?.places ?? []).filter((p) => adPlaces.includes(p.key) && p.cap !== null).map((p) => p.cap!);
    return caps.length ? Math.min(...caps) : null;
  })();

  // One style per kind, set once for every date or day of that kind; a new
  // schedule's carousel starts at the studio's recommended length.
  const [styles, setStyles] = useState<StyleSet>(() => {
    if (initial) return initial.styles;
    const fresh = defaultStyles();
    fresh.CAROUSEL.slides = DEFAULT_SLIDES;
    return fresh;
  });
  const [dayStyles, setDayStyles] = useState<(PostStyle | null)[]>(
    () => initial?.dayStyles ?? Array.from({ length: 7 }, () => null),
  );
  const planKinds = [
    ...new Set<PostKind>(
      repeat === "DATES" ? dated.map((d) => d.kind) : (week.filter(Boolean) as PostKind[]),
    ),
  ];
  const styleKinds = usable.filter((k) => planKinds.includes(k.key));
  const [styleTab, setStyleTab] = useState<PostKind | null>(null);
  const tab = styleKinds.find((k) => k.key === styleTab)?.key ?? styleKinds[0]?.key ?? null;
  // The weekday whose own style is open under the week, if any.
  const [openDay, setOpenDay] = useState<number | null>(null);
  const kindLabel = (k: PostKind) => usable.find((x) => x.key === k)?.label.toLowerCase() ?? "post";
  // "Use for every image day": this becomes the kind's style, and every day
  // and date of the kind takes it.
  const useForAll = (kind: PostKind, style: PostStyle) => {
    setStyles((s) => ({ ...s, [kind]: style }));
    setDayStyles((xs) => xs.map((x, d) => (week[d] === kind ? null : x)));
    setDated((ds) => ds.map((x) => (x.kind === kind ? { ...x, style: null } : x)));
  };

  return (
    <form action={submit} onSubmit={keep} id={id} className="card">
      <div className="card__head">
        <h2>{initial ? `Edit ${initial.name}` : "A new schedule"}</h2>
      </div>
      <input type="hidden" name="briefId" value={briefId} />
      {initial && <input type="hidden" name="scheduleId" value={initial.id} />}
      <input type="hidden" name="repeat" value={repeat} />
      <input type="hidden" name="dated" value={JSON.stringify(dated)} />
      <input type="hidden" name="styles" value={JSON.stringify(styles)} />
      <input type="hidden" name="dayStyles" value={JSON.stringify(dayStyles)} />
      {!offerAuto && <input type="hidden" name="mode" value="REVIEW" />}
      <FontFaces />

      {state && !state.ok && (
        <div className="note note--risk" style={{ marginBottom: 16 }} role="alert">
          {state.message}
        </div>
      )}
      {state?.ok && (
        <div className="note note--info" style={{ marginBottom: 16 }} role="status">
          {state.message}
        </div>
      )}

      <div className="formfield" style={{ marginBottom: 18 }}>
        <span className="formfield__label">
          Name
          <span className="formfield__req"> required</span>
        </span>
        <input
          type="text"
          name="name"
          maxLength={80}
          required
          defaultValue={initial?.name ?? ""}
          placeholder="Tower C, twice a week"
          className="formfield__input"
        />
      </div>

      <div className="formfield" style={{ marginBottom: 18 }}>
        <span className="formfield__label" id={`${id}-repeat`}>
          How it repeats
        </span>
        <div>
          <div className="seg" role="radiogroup" aria-labelledby={`${id}-repeat`}>
            {REPEATS.map((r) => (
              <button
                key={r.key}
                type="button"
                role="radio"
                className="seg__opt"
                aria-checked={repeat === r.key}
                aria-pressed={repeat === r.key}
                onClick={() => setRepeat(r.key)}
                data-repeat={r.key}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* A week plan rather than a set of days: which days, and what goes
          out on each. A day left Off is a day nothing is written. */}
      <div className="formfield" style={{ marginBottom: 18 }} hidden={repeat !== "WEEKLY"}>
        <span className="formfield__label">
          What goes out each day
          <span className="formfield__req"> required</span>
        </span>
        <div className="weekplan">
          {dayNames.map((label, i) => (
            <div key={label} className="weekplan__day">
              <span aria-hidden>{label}</span>
              <select
                name={`kind_${i}`}
                value={week[i]}
                onChange={(e) => {
                  setWeek((w) => w.map((k, d) => (d === i ? e.target.value : k)));
                  // A style belongs to a kind: a day that changes kind takes the new kind's.
                  setDayStyles((xs) => xs.map((x, d) => (d === i ? null : x)));
                  if (!e.target.value && openDay === i) setOpenDay(null);
                }}
                className="select-field"
                aria-label={`${label}: what goes out`}
                data-day={i}
              >
                <option value="">Off</option>
                {kinds.map((k) => (
                  <option key={k.key} value={k.key} disabled={!!k.unavailable}>
                    {k.label}
                    {k.unavailable ? " (not in this brief)" : ""}
                  </option>
                ))}
              </select>
              {ads ? (
                <select
                  name={`outlet_${i}`}
                  value={outlets[i]}
                  onChange={(e) =>
                    setOutlets((o) => o.map((x, d) => (d === i ? (e.target.value as Outlet) : x)))
                  }
                  className="select-field weekplan__outlet"
                  aria-label={`${label}: how it goes out`}
                  disabled={!week[i]}
                  data-outlet={i}
                >
                  {OUTLETS.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input type="hidden" name={`outlet_${i}`} value="POST" />
              )}
              <button
                type="button"
                className={`stylebtn${dayStyles[i] ? " stylebtn--own" : ""}`}
                aria-expanded={openDay === i}
                disabled={!week[i]}
                onClick={() => setOpenDay((d) => (d === i ? null : i))}
                data-day-style={i}
              >
                {dayStyles[i] ? "Own style" : "Style"}
              </button>
            </div>
          ))}
        </div>
        {openDay !== null && week[openDay] && (
          <OwnStyle
            id={`${id}-day-${openDay}`}
            title={`${dayNames[openDay]}'s style`}
            kind={week[openDay] as PostKind}
            kindLabel={kindLabel(week[openDay] as PostKind)}
            own={dayStyles[openDay]}
            fallback={styles[week[openDay] as PostKind]}
            choices={styleChoices}
            onChange={(next) => setDayStyles((xs) => xs.map((x, d) => (d === openDay ? next : x)))}
            onUseForAll={(style) => useForAll(week[openDay] as PostKind, style)}
            onClose={() => setOpenDay(null)}
          />
        )}
      </div>

      <div className="formfield" style={{ marginBottom: 18 }} hidden={repeat !== "DATES"}>
        <span className="formfield__label">
          Dates
          <span className="formfield__req"> required</span>
        </span>
        <DatePlan
          id={`${id}-dates`}
          value={dated}
          onChange={setDated}
          saved={initial?.dated}
          kinds={usable}
          adsAvailable={!!ads}
          renderStyle={(d, close) => (
            <OwnStyle
              id={`${id}-date-${d.on}-${d.at}`}
              kind={d.kind}
              kindLabel={kindLabel(d.kind)}
              own={d.style ?? null}
              fallback={styles[d.kind]}
              choices={styleChoices}
              onChange={(next) =>
                setDated((ds) => ds.map((x) => (x.on === d.on && x.at === d.at ? { ...x, style: next } : x)))
              }
              onUseForAll={(style) => useForAll(d.kind, style)}
              onClose={close}
            />
          )}
        />
      </div>

      {/* The look of every post of each kind, set once; a day or a date with
          its own style keeps that instead. */}
      {tab && (
        <div className="formfield" style={{ marginBottom: 18 }} data-styles>
          <span className="formfield__label" id={`${id}-styles`}>
            Post style
          </span>
          <div className="stylebox">
            {styleKinds.length > 1 && (
              <div className="seg" role="tablist" aria-labelledby={`${id}-styles`}>
                {styleKinds.map((k) => (
                  <button
                    key={k.key}
                    type="button"
                    role="tab"
                    className="seg__opt"
                    aria-selected={tab === k.key}
                    aria-pressed={tab === k.key}
                    onClick={() => setStyleTab(k.key)}
                    data-style-tab={k.key}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            )}
            <p className="stylebox__for">
              Every {kindLabel(tab)} {repeat === "DATES" ? "date" : "day"}
              {ownCount(tab, repeat, week, dayStyles, dated)
                ? `, except ${ownCount(tab, repeat, week, dayStyles, dated)} with ${
                    ownCount(tab, repeat, week, dayStyles, dated) === 1 ? "its" : "their"
                  } own`
                : ""}
            </p>
            <StyleEditor
              key={tab}
              id={`${id}-style-${tab}`}
              kind={tab}
              value={styles[tab]}
              onChange={(next) => setStyles((s) => ({ ...s, [tab]: next }))}
              choices={styleChoices}
            />
            {tab === "IMAGE" && festivals !== null && !styles.IMAGE?.template && (
              <p className="stylebox__for" data-festival-note>
                {festivals
                  ? `On a festival you marked, the image is a festival post. ${festivals} ${festivals === 1 ? "festival" : "festivals"} marked. `
                  : "No festivals marked, so no festival posts. "}
                <a href="/dashboard/campaigns/occasions">{festivals ? "Change" : "Choose festivals"}</a>
              </p>
            )}
          </div>
        </div>
      )}

      {/* A calendar sets its own time per date; a week plan has one. */}
      <div className="formfield" style={{ marginBottom: 18 }} hidden={repeat !== "WEEKLY"}>
        <span className="formfield__label">
          Time it goes out
          <span className="formfield__req"> required</span>
        </span>
        <input
          type="time"
          name="at"
          defaultValue={initial ? clock(initial.atMinute) : "10:00"}
          required={repeat === "WEEKLY"}
          className="formfield__input"
          style={{ maxWidth: 160 }}
        />
      </div>

      <div className="formfield" style={{ marginBottom: 18 }}>
        <span className="formfield__label">Written this far ahead</span>
        <select
          name="leadMinutes"
          defaultValue={String(initial?.leadMinutes ?? defaultLead)}
          className="select-field"
        >
          {leadOptions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="formfield" style={{ marginBottom: 18 }} hidden={repeat !== "WEEKLY"}>
        <span className="formfield__label">Most posts a day</span>
        <select
          name="maxRunsPerDay"
          defaultValue={String(initial?.maxRunsPerDay ?? 1)}
          className="select-field"
        >
          {runOptions.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="formfield" style={{ marginBottom: 18 }} hidden={repeat !== "WEEKLY"}>
        <span className="formfield__label">Run between</span>
        <span className="schedule__window">
          <input
            type="date"
            name="startsOn"
            aria-label="From"
            defaultValue={initial?.startsOn ?? ""}
            className="formfield__input"
          />
          <span>and</span>
          <input
            type="date"
            name="endsOn"
            aria-label="Until"
            defaultValue={initial?.endsOn ?? ""}
            className="formfield__input"
          />
        </span>
      </div>

      {destinations && (
        <div className="formfield" style={{ marginBottom: 18 }}>
          <input type="hidden" name="destinationsShown" value="1" />
          <span className="formfield__label" id={`${id}-dests`}>
            {auto ? "Where posts go" : "Where approved posts go"}
          </span>
          <div>
          <div className="checkset checkset--stack" role="group" aria-labelledby={`${id}-dests`}>
            {destinations.map((d) => (
              <label key={d.key} className={`checkset__item${d.account ? "" : " checkset__item--off"}`}>
                <input
                  type="checkbox"
                  name="destination"
                  value={d.key}
                  disabled={!d.account}
                  defaultChecked={initial?.destinations.includes(d.key) ?? false}
                  data-destination={d.key}
                />
                {/* A disabled box posts nothing, so a destination this
                    schedule already had and whose account has since gone
                    is kept rather than quietly dropped by an unrelated save. */}
                {!d.account && initial?.destinations.includes(d.key) && (
                  <input type="hidden" name="destination" value={d.key} />
                )}
                <span>
                  <strong>{d.label}</strong>
                  <small>{d.account ?? d.reason}</small>
                </span>
              </label>
            ))}
            {broadcast && (
              <label className="checkset__item">
                <input
                  type="checkbox"
                  name="destination"
                  value="WHATSAPP_BROADCAST"
                  checked={broadcasting}
                  onChange={(e) => setBroadcasting(e.target.checked)}
                  data-destination="WHATSAPP_BROADCAST"
                />
                <span>
                  <strong>WhatsApp broadcast</strong>
                  <small>To your leads who agreed to hear from you on WhatsApp</small>
                </span>
              </label>
            )}
          </div>
          {broadcast && (
            <label className="adplan__field" hidden={!broadcasting} style={{ marginTop: 10 }} data-broadcast-cap>
              <span>Each broadcast reaches up to</span>
              <span className="adplan__unit adplan__unit--after">
                <input
                  type="text"
                  name="broadcastCap"
                  inputMode="numeric"
                  defaultValue={initial?.broadcastCap ? String(initial.broadcastCap) : ""}
                  placeholder="500"
                  className="formfield__input"
                  style={{ maxWidth: 160 }}
                  required={broadcasting}
                />
                <span aria-hidden>people</span>
              </span>
            </label>
          )}
          </div>
        </div>
      )}

      {/* Mounted whenever ads are possible so the typed budget survives a
          change of mind; shown only while something in the plan is an ad. */}
      {ads && (
        <div className="formfield" style={{ marginBottom: 18 }} hidden={!hasAd} data-ads>
          <span className="formfield__label" id={`${id}-adplaces`}>Ads run on</span>
          <div>
          <input type="hidden" name="adPlacesShown" value="1" />
          <div className="checkset checkset--wide" role="group" aria-labelledby={`${id}-adplaces`} style={{ marginBottom: 12 }}>
            {ads.places.map((p) => (
              <label key={p.key} className={`checkset__item${p.account ? "" : " checkset__item--off"}`} data-ad-place={p.key}>
                <input
                  type="checkbox"
                  name="adPlace"
                  value={p.key}
                  disabled={!p.account}
                  checked={adPlaces.includes(p.key)}
                  onChange={(e) => setAdPlaces((xs) => (e.target.checked ? [...xs, p.key] : xs.filter((x) => x !== p.key)))}
                />
                <span>
                  <strong>{p.label}</strong>
                  <small>{p.account ?? p.reason}</small>
                </span>
              </label>
            ))}
          </div>
          {adPlaces.includes("META_AD") && (
            <div style={{ marginBottom: 12 }} data-ad-goals>
              <span className="adplan__sublabel" id={`${id}-adgoal`}>Meta ads are for</span>
              <div className="checkset checkset--wide" role="radiogroup" aria-labelledby={`${id}-adgoal`}>
                {ads.goals.map((g) => (
                  <label key={g.key} className={`checkset__item${g.ok ? "" : " checkset__item--off"}`} data-goal={g.key}>
                    <input
                      type="radio"
                      name="adGoal"
                      value={g.key}
                      disabled={!g.ok}
                      checked={adGoal === g.key}
                      onChange={() => setAdGoal(g.key)}
                    />
                    <span>
                      <strong>{g.label}</strong>
                      <small>{g.ok ? g.detail : g.reason}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="adplan">
            <label className="adplan__field">
              <span>Budget a day</span>
              <span className="adplan__unit">
                <span aria-hidden>Rs</span>
                <input
                  type="text"
                  name="adDailyBudget"
                  inputMode="numeric"
                  defaultValue={initial?.adDailyBudget ? String(initial.adDailyBudget) : ""}
                  placeholder={adCap ? `Up to ${adCap.toLocaleString("en-IN")}` : "1,000"}
                  className="formfield__input"
                  required={hasAd}
                />
              </span>
            </label>
            <label className="adplan__field">
              <span>Each ad runs for</span>
              <span className="adplan__unit adplan__unit--after">
                <input
                  type="number"
                  name="adDays"
                  min={AD_DAYS_MIN}
                  max={AD_DAYS_MAX}
                  step={1}
                  defaultValue={initial?.adDays ?? AD_DAYS_DEFAULT}
                  className="formfield__input"
                  required={hasAd}
                />
                <span aria-hidden>days</span>
              </span>
            </label>
          </div>
          </div>
        </div>
      )}

      {offerAuto && (
        <div className="formfield" style={{ marginBottom: 18 }}>
          <span className="formfield__label" id={`${id}-mode`}>
            Before a post goes out
          </span>
          <div className="checkset" role="radiogroup" aria-labelledby={`${id}-mode`}>
            <label className="checkset__item">
              <input
                type="radio"
                name="mode"
                value="REVIEW"
                checked={mode === "REVIEW"}
                onChange={() => setMode("REVIEW")}
              />
              <span>
                <strong>Review first</strong>
                <small>Every post waits for somebody to approve it.</small>
              </span>
            </label>
            <label className="checkset__item">
              <input
                type="radio"
                name="mode"
                value="AUTO"
                checked={mode === "AUTO"}
                onChange={() => setMode("AUTO")}
                data-mode-auto
              />
              <span>
                <strong>Send automatically</strong>
                <small>Posts that pass every check go out on their own.</small>
              </span>
            </label>
          </div>
        </div>
      )}

      {auto ? (
        <div className="note note--warn" role="alert" data-auto-warning>
          <strong>
            {hasAd
              ? "Posts and ads will go out without anyone approving them"
              : "Posts will go out without anyone approving them"}
          </strong>
          AI can make mistakes. Turn this on only if you are happy with the posts this campaign
          has made so far.{hasAd ? " Ads start spending as soon as they are made." : ""} Every
          picture is read for its RERA details, QR code and prices before it goes out, and a post
          whose words or picture the checks are unsure about still waits for approval.
          {!wasAuto && (
            <label className="checkset__item" style={{ marginTop: 10 }}>
              <input type="checkbox" name="autoConfirmed" value="1" required />
              <span>I understand. Send posts automatically.</span>
            </label>
          )}
        </div>
      ) : (
        <p className="sub" style={{ margin: "0 0 4px" }}>
          {destinations || hasAd
            ? `Every post waits in the queue for somebody to approve it, then goes out at its time.${
                hasAd ? " An ad starts spending once it is approved." : ""
              }`
            : "Every post waits in the queue for somebody to approve it."}
        </p>
      )}

      {pending && (
        <p className="sub" style={{ margin: "8px 0 0" }} role="status">
          Saving.
        </p>
      )}
    </form>
  );
}

export type ScheduleInitial = {
  id: string;
  name: string;
  mode: "REVIEW" | "AUTO";
  repeat: Repeat;
  /** Sunday first, a kind or null for a day off. */
  dayKinds: (string | null)[];
  /** How each weekday's post goes out, Sunday first. */
  dayOutlets: Outlet[];
  dated: DatedPost[];
  atMinute: number;
  leadMinutes: number;
  maxRunsPerDay: number;
  startsOn: string | null;
  endsOn: string | null;
  destinations: string[];
  adDailyBudget: number | null;
  adDays: number;
  adGoal: string;
  broadcast: boolean;
  broadcastCap: number | null;
  /** The schedule's own style for each kind. */
  styles: StyleSet;
  /** A weekday's own style, Sunday first. */
  dayStyles: (PostStyle | null)[];
};

/** How many days or dates of a kind carry a style of their own. */
function ownCount(
  kind: PostKind,
  repeat: Repeat,
  week: string[],
  dayStyles: (PostStyle | null)[],
  dated: DatedPost[],
): number {
  return repeat === "DATES"
    ? dated.filter((d) => d.kind === kind && d.style).length
    : week.filter((k, d) => k === kind && dayStyles[d]).length;
}

/**
 * One day's or one date's style, open under its row. It starts as the
 * schedule's style for its kind; the first change makes it its own. "Use the
 * <kind> style" puts it back, and "Use for every <kind>" makes it the
 * schedule's, for every day or date of that kind.
 */
function OwnStyle({
  id,
  title,
  kind,
  kindLabel,
  own,
  fallback,
  choices,
  onChange,
  onUseForAll,
  onClose,
}: {
  id: string;
  title?: string;
  kind: PostKind;
  kindLabel: string;
  own: PostStyle | null;
  fallback: PostStyle;
  choices: StyleChoices;
  onChange: (next: PostStyle | null) => void;
  onUseForAll: (style: PostStyle) => void;
  onClose: () => void;
}) {
  const style = styleOf({ kind, style: own }, { [kind]: fallback });
  const line = own ? styleLine(own, choices, kind) : "";
  return (
    <div className="ownstyle" data-own-style>
      <div className="ownstyle__head">
        <div>
          {title && <strong>{title}</strong>}
          <small>
            {own ? `Its own style${line ? `: ${line}` : ""}` : `Same as every ${kindLabel}. Change anything to give it its own.`}
          </small>
        </div>
        <div className="ownstyle__acts">
          {own && (
            <>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(null)} data-style-reset>
                Use the {kindLabel} style
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onUseForAll(own)} data-style-all>
                Use for every {kindLabel}
              </button>
            </>
          )}
          <button type="button" className="btn btn--ink btn--sm" onClick={onClose} data-style-done>
            Done
          </button>
        </div>
      </div>
      <StyleEditor id={id} kind={kind} value={style} onChange={onChange} choices={choices} />
    </div>
  );
}

const LEAD_OPTIONS: [string, string][] = [
  ["60", "1 hour"],
  ["240", "4 hours"],
  ["720", "12 hours"],
  ["1440", "A day"],
  ["2880", "Two days"],
];

const RUN_OPTIONS: [string, string][] = [
  ["1", "1"],
  ["2", "2"],
  ["3", "3"],
];

/**
 * The list, plus the saved value when it is not one of them. A select with
 * no option for the stored value shows the first option instead, and the
 * next save would write that without anybody choosing it.
 */
function withValue(
  options: [string, string][],
  value: number | undefined,
  label: (n: number) => string,
): [string, string][] {
  if (value === undefined || options.some(([v]) => v === String(value))) return options;
  return [...options, [String(value), label(value)] as [string, string]].sort(
    (a, b) => Number(a[0]) - Number(b[0]),
  );
}

/** Minutes from midnight as the `HH:MM` a time input takes. */
function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
