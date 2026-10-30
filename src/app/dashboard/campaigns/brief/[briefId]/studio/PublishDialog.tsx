"use client";

import { MediaThumb } from "@/components/MediaThumb";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { publishOptionsAction, publishPostAction } from "@/app/actions/publish";
import type { DestinationOption } from "@/lib/publish";
import type { RequestResult } from "@/lib/publish";
import { ArrowUpRight, Check, Close } from "@/components/icons";
import { BroadcastPanel, type BroadcastHandle, type BroadcastState } from "./BroadcastPanel";

/**
 * Publish one post: where it goes, and, for an ad, what it may spend.
 *
 * A dialog rather than an inline panel, because this is the one press in the
 * studio that puts something in front of the public or creates spend, and it
 * deserves the whole of somebody's attention. What it can go to is asked of
 * the server when it opens, not computed for every post on the page: each
 * answer runs every gate again.
 *
 * Every destination is shown, and the ones this post cannot go to say why in
 * a line, rather than being left out: "no Instagram account for this
 * project" is the thing somebody needs to know to fix it. The button says
 * exactly what will happen, and afterwards each destination says what did.
 */

type Existing = { destination: string; state: string; stateLabel: string };

const showRupees = (n: number) => `Rs ${Math.round(n).toLocaleString("en-IN")}`;

function joinWords(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function PublishDialog({
  postId,
  briefId,
  what,
  thumb,
  video,
  existing,
}: {
  postId: string;
  briefId: string;
  /** "Image · Meta feed 1:1 · English" */
  what: string;
  thumb: string;
  video: boolean;
  existing: Existing[];
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DestinationOption[] | null>(null);
  const [website, setWebsite] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [budget, setBudget] = useState("");
  const [goal, setGoal] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [results, setResults] = useState<RequestResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bcResult, setBcResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [bc, setBc] = useState<BroadcastState>({ on: false, ready: false, count: 0, mayApprove: false });
  const bcRef = useRef<BroadcastHandle>(null);
  const onBcState = useCallback((s: BroadcastState) => setBc(s), []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const start = async () => {
    setOpen(true);
    setResults(null);
    setBcResult(null);
    setError(null);
    setOptions(null);
    setLoadError(null);
    const r = await publishOptionsAction(postId).catch(() => ({ ok: false as const, message: "Could not load where this can go." }));
    if (!r.ok) {
      setLoadError(r.message);
      return;
    }
    setOptions(r.options);
    setGoal(r.options.find((o) => o.destination === "META_AD")?.defaultGoal ?? null);
    setWebsite(r.website ?? "");
    setUrl(r.website ?? "");
    // Nothing is ticked for the person. Where a post goes is their call.
    setChosen([]);
  };

  const finished = !!results || !!bcResult;
  const close = () => {
    setOpen(false);
    if (finished) router.refresh();
  };

  const picked = useMemo(() => (options ?? []).filter((o) => chosen.includes(o.destination)), [options, chosen]);
  const ads = picked.filter((o) => o.ad);
  const organic = picked.filter((o) => !o.ad);
  const cap = ads.length ? Math.min(...ads.map((o) => o.dailyCap ?? Infinity)) : null;
  const meta = picked.find((o) => o.destination === "META_AD") ?? null;
  const goals = meta?.goals ?? [];
  const goalOk = !meta || goals.some((g) => g.key === goal && g.ok);

  const people = `${bc.count.toLocaleString("en-IN")} ${bc.count === 1 ? "person" : "people"}`;
  const sendsBroadcast = bc.on && bc.ready;
  const ready = (picked.length > 0 || sendsBroadcast) && !(bc.on && !bc.ready) && goalOk;
  const label = (() => {
    const broadcast = sendsBroadcast
      ? bc.mayApprove
        ? `send to ${people} on WhatsApp`
        : `save a WhatsApp broadcast for approval`
      : "";
    if (!picked.length && !broadcast) return "Choose where it goes";
    const posts = organic.length
      ? organic.length <= 2
        ? `Post to ${joinWords(organic.map((o) => o.label))}`
        : `Post to ${organic.length} places`
      : "";
    const made = ads.length
      ? ads.length === 1
        ? `create a paused ${ads[0].label}`
        : `create ${ads.length} paused ads`
      : "";
    const both = [posts, made, broadcast].filter(Boolean).join(" and ");
    return both.charAt(0).toUpperCase() + both.slice(1);
  })();

  const submit = async () => {
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    const published = picked.length
      ? publishPostAction({
          postId,
          briefId,
          destinations: chosen,
          dailyBudget: budget,
          destinationUrl: url,
          adGoal: meta ? goal : null,
        }).catch(() => ({ ok: false, message: "It could not be published. Try again.", results: [] as RequestResult[] }))
      : null;
    const broadcast = sendsBroadcast && bcRef.current ? bcRef.current.send() : null;
    const [r, b] = await Promise.all([published, broadcast]);
    setPending(false);
    if (r && !r.results.length && !b) {
      setError(r.message);
      return;
    }
    setResults(r?.results.length ? r.results : r ? [] : null);
    if (r && !r.results.length) setError(r.message);
    setBcResult(b);
  };

  const labelOf = (d: string) => options?.find((o) => o.destination === d)?.label ?? d;

  return (
    <>
      <button type="button" className="btn btn--ghost btn--sm posttile__publish" onClick={start} data-publish={postId}>
        Publish
        <ArrowUpRight size={12} />
      </button>
      <dialog
        ref={ref}
        className="mv pub"
        aria-labelledby={`pub-${postId}-title`}
        onClose={() => {
          setOpen(false);
          if (finished) router.refresh();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !pending) close();
        }}
      >
        <div className="mv-form">
          <div className="mv-head">
            <div className="pub__id">
              <span className="pub__thumb">
                <MediaThumb src={thumb} video={video} />
              </span>
              <div>
                <h2 id={`pub-${postId}-title`}>
                  Publish this <span className="em">post</span>
                </h2>
                <p className="mv-sub">{what}</p>
              </div>
            </div>
            <button type="button" className="btn btn--icon" onClick={close} aria-label="Close" disabled={pending}>
              <Close size={14} />
            </button>
          </div>

          <div className="mv-body">
            {loadError && (
              <div className="mv-warn mv-warn--risk" role="alert">
                {loadError}
              </div>
            )}

            {!options && !loadError && (
              <ul className="pub-dests" aria-busy="true" aria-label="Loading where this can go">
                {[0, 1, 2, 3, 4].map((i) => (
                  <li key={i} className="pub-dest pub-dest--loading">
                    <span className="skel skel--box" />
                    <span className="skel skel--line" />
                  </li>
                ))}
              </ul>
            )}

            {options && !finished && (
              <>
                <fieldset className="pub-dests" disabled={pending}>
                  <legend className="mv-label">Where it goes</legend>
                  {options.map((o) => {
                    const done =
                      o.existing && o.existing.state !== "FAILED" && o.existing.state !== "CANCELLED" && !o.again;
                    const held = existing.find((e) => e.destination === o.destination);
                    const off = !o.ok || !!done;
                    return (
                      <label
                        key={o.destination}
                        className={`pub-dest${off ? " pub-dest--off" : ""}${chosen.includes(o.destination) ? " pub-dest--on" : ""}`}
                        data-destination={o.destination}
                        data-available={String(!off)}
                      >
                        <input
                          type="checkbox"
                          checked={chosen.includes(o.destination)}
                          disabled={off}
                          onChange={(e) =>
                            setChosen((xs) =>
                              e.target.checked ? [...xs, o.destination] : xs.filter((x) => x !== o.destination),
                            )
                          }
                        />
                        <span className="pub-dest__id">
                          <strong>
                            {o.label}
                            {o.ad && <span className="pub-dest__tag">Ad</span>}
                          </strong>
                          <small>
                            {done
                              ? `Already ${held?.stateLabel.toLowerCase() ?? "there"}`
                              : o.ok && o.again
                                ? `${o.accountName} · a new ad. The paused one stays paused`
                                : o.ok
                                ? o.companion
                                  ? `${o.accountName} · with its ${o.companion} version`
                                  : o.accountName
                                : o.reason}
                          </small>
                        </span>
                        {done && held && <span className="pill pill--ok">{held.stateLabel}</span>}
                      </label>
                    );
                  })}
                </fieldset>

                {ads.length > 0 && (
                  <div className="pub-ad">
                    {meta && goals.length > 0 && (
                      <fieldset className="pub-goal" data-goals>
                        <legend className="mv-label">What the Meta ad is for</legend>
                        <div className="checkset checkset--wide">
                          {goals.map((g) => (
                            <label
                              key={g.key}
                              className={`checkset__item${g.ok ? "" : " checkset__item--off"}`}
                              data-goal={g.key}
                              data-available={String(g.ok)}
                            >
                              <input
                                type="radio"
                                name={`pub-${postId}-goal`}
                                value={g.key}
                                checked={goal === g.key}
                                disabled={!g.ok}
                                onChange={() => setGoal(g.key)}
                              />
                              <span>
                                <strong>{g.label}</strong>
                                <small>{g.ok ? g.detail : g.reason}</small>
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}
                    <div className="mv-grid">
                      <div className="mv-field">
                        <label className="mv-label" htmlFor={`pub-${postId}-budget`}>
                          Daily budget
                        </label>
                        <span className="mv-money">
                          <span aria-hidden="true">Rs</span>
                          <input
                            id={`pub-${postId}-budget`}
                            className="mv-input"
                            inputMode="numeric"
                            placeholder="1,500"
                            value={budget}
                            onChange={(e) => setBudget(e.target.value)}
                            aria-describedby={`pub-${postId}-cap`}
                            data-budget
                          />
                        </span>
                        {cap !== null && Number.isFinite(cap) && (
                          <p className="mv-hint" id={`pub-${postId}-cap`}>
                            Up to {showRupees(cap)} a day
                          </p>
                        )}
                      </div>
                      <div className="mv-field">
                        <label className="mv-label" htmlFor={`pub-${postId}-url`}>
                          Landing page
                        </label>
                        <input
                          id={`pub-${postId}-url`}
                          className="mv-input"
                          type="url"
                          inputMode="url"
                          placeholder={website || "https://yourproject.com"}
                          value={url}
                          onChange={(e) => setUrl(e.target.value)}
                          data-landing
                        />
                      </div>
                    </div>
                    <p className="pub-ad__note">
                      Created paused. Nothing spends until somebody switches it on.
                    </p>
                  </div>
                )}

                <BroadcastPanel
                  ref={bcRef}
                  postId={postId}
                  disabled={pending}
                  unavailable={video ? "A broadcast carries a picture. Videos are not sent." : null}
                  onState={onBcState}
                />

                {error && (
                  <div className="mv-warn mv-warn--risk" role="alert">
                    {error}
                  </div>
                )}
              </>
            )}

            {finished && error && (
              <div className="mv-warn mv-warn--risk" role="alert">
                {error}
              </div>
            )}

            {finished && (
              <ul className="pub-results" role="status" data-results>
                {(results ?? []).map((r) => (
                  <li key={r.destination} className={`pub-result pub-result--${r.ok ? "ok" : "risk"}`} data-result={r.destination}>
                    <span className="pub-result__mark">{r.ok ? <Check size={13} /> : <Close size={13} />}</span>
                    <span className="pub-result__id">
                      <strong>{labelOf(r.destination)}</strong>
                      <small>{r.message}</small>
                    </span>
                  </li>
                ))}
                {bcResult && (
                  <li className={`pub-result pub-result--${bcResult.ok ? "ok" : "risk"}`} data-result="WHATSAPP_BROADCAST">
                    <span className="pub-result__mark">{bcResult.ok ? <Check size={13} /> : <Close size={13} />}</span>
                    <span className="pub-result__id">
                      <strong>WhatsApp broadcast</strong>
                      <small>{bcResult.message}</small>
                    </span>
                  </li>
                )}
              </ul>
            )}
          </div>

          <div className="mv-foot">
            {pending && (
              <span className="pub__status" role="status">
                Publishing. This can take a minute.
              </span>
            )}
            {finished ? (
              <>
                <a href="/dashboard/campaigns/live" className="btn btn--ghost">
                  Open Published
                </a>
                <button type="button" className="btn btn--ink" onClick={close} data-done>
                  Done
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn--ghost" onClick={close} disabled={pending}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--ink"
                  onClick={submit}
                  disabled={!ready || pending}
                  data-publish-go
                >
                  {pending ? "Publishing" : label}
                  {!pending && ready && <ArrowUpRight size={14} />}
                </button>
              </>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
