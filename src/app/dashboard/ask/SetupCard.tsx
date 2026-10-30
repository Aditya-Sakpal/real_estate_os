"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { SetupView } from "@/lib/setup-rules";
import { ArrowUpRight, Check, FileDoc, Picture } from "@/components/icons";
import { QuestionPager, startingPicks, type Others, type Picks } from "./QuestionPager";

/**
 * A project being set up from the files a message carried.
 *
 * Reading: what it is reading, with a bar. Asking: the questions only the
 * person can answer, one at a time. Ready: what pressing the button makes,
 * the pictures it found (a tap takes one off), and one button that says
 * what it does. Then what was made, and where to approve it.
 */

const STATE_PILL: Record<SetupView["state"], { text: string; tone: string }> = {
  READING: { text: "Reading", tone: "blue" },
  ASKING: { text: "Needs your answer", tone: "blue" },
  READY: { text: "Waiting for you", tone: "blue" },
  CREATING: { text: "Setting up", tone: "blue" },
  DONE: { text: "Done", tone: "ok" },
  FAILED: { text: "Did not happen", tone: "warn" },
  CANCELLED: { text: "Cancelled", tone: "quiet" },
  EXPIRED: { text: "Expired", tone: "quiet" },
};

async function call(body: Record<string, unknown>): Promise<{ ok: boolean; view?: SetupView; message?: string }> {
  try {
    const res = await fetch("/dashboard/ask/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { ok: boolean; view?: SetupView; message?: string };
  } catch {
    return { ok: false, message: "Couldn't reach Jimmy. Check your connection and try again." };
  }
}

/** How many files a message shows by name before the rest fold away. */
const CHIPS_SHOWN = 3;

/**
 * The files a message carried. Pictures beyond a couple fold into one chip
 * ("24 pictures"), and documents past three into "+N more"; a press opens
 * the whole list.
 */
export function FileChips({ files }: { files: { id: string; name: string; type: string }[] }) {
  const [open, setOpen] = useState(false);
  if (!files.length) return null;
  const pictures = files.filter((f) => f.type.startsWith("image/"));
  const others = files.filter((f) => !f.type.startsWith("image/"));
  const foldPictures = pictures.length > 2;
  const shown = open ? files : [...others.slice(0, CHIPS_SHOWN), ...(foldPictures ? [] : pictures)];
  const moreOthers = open ? 0 : Math.max(0, others.length - CHIPS_SHOWN);
  return (
    <ul className="ask-files" aria-label="Files">
      {shown.map((f) => (
        <li key={f.id} className="ask-file">
          {f.type.startsWith("image/") ? <Picture size={13} /> : <FileDoc size={13} />}
          <span className="ask-file__name">{f.name}</span>
        </li>
      ))}
      {!open && foldPictures && (
        <li>
          <button type="button" className="ask-file ask-file--more" onClick={() => setOpen(true)} aria-expanded={false}>
            <Picture size={13} />
            <span className="ask-file__name">{pictures.length} pictures</span>
          </button>
        </li>
      )}
      {moreOthers > 0 && (
        <li>
          <button type="button" className="ask-file ask-file--more" onClick={() => setOpen(true)} aria-expanded={false}>
            +{moreOthers} more
          </button>
        </li>
      )}
      {open && (foldPictures || others.length > CHIPS_SHOWN) && (
        <li>
          <button type="button" className="ask-file ask-file--more" onClick={() => setOpen(false)} aria-expanded>
            Show less
          </button>
        </li>
      )}
    </ul>
  );
}

export function SetupCard({ initial, latest }: { initial: SetupView; latest: boolean }) {
  const [view, setView] = useState(initial);
  const [picks, setPicks] = useState<Picks>({});
  const [others, setOthers] = useState<Others>({});
  const [skip, setSkip] = useState<number[]>(() => initial.pictures.filter((p) => p.skipped).map((p) => p.n));
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Reading and making are read again until they land.
  useEffect(() => {
    if (view.state !== "READING" && view.state !== "CREATING") return;
    const t = setInterval(async () => {
      const r = await call({ op: "status", id: view.id });
      if (r.ok && r.view) setView(r.view);
    }, 2500);
    return () => clearInterval(t);
  }, [view.state, view.id]);

  useEffect(() => {
    setPicks(startingPicks(view.questions));
    setOthers({});
  }, [view.questions.map((q) => q.input + q.title).join("|")]);

  useEffect(() => {
    if (view.state === "READY") setSkip(view.pictures.filter((p) => p.skipped).map((p) => p.n));
  }, [view.state, view.pictures.map((p) => p.n).join(",")]);

  const send = async (body: Record<string, unknown>) => {
    setWorking(true);
    setProblem(null);
    const r = await call({ ...body, id: view.id });
    setWorking(false);
    if (r.ok && r.view) setView(r.view);
    else setProblem(r.message ?? "That did not work. Try again.");
  };

  const pill = STATE_PILL[view.state];
  const live = latest;
  const kept = view.pictures.length - skip.length;
  return (
    <div className={`ask-act ask-setup ask-act--${view.state.toLowerCase()}`} aria-busy={view.state === "READING" || view.state === "CREATING"}>
      <div className="ask-act__head">
        <p className="ask-act__title">{view.heading}</p>
        <span className={`pill pill--${pill.tone}`}>
          {view.state !== "CANCELLED" && view.state !== "EXPIRED" && <span className="pill__dot" />}
          {pill.text}
        </span>
      </div>
      <FileChips files={view.files} />

      {(view.state === "READING" || view.state === "CREATING") && (
        <>
          {view.steps.length ? (
            <ol className="ask-feed" aria-live="polite">
              {view.steps.map((s) => (
                <li key={s.k} className={`ask-feed__item is-${s.s}`}>
                  <span className="ask-feed__mark" aria-hidden>
                    {s.s === "doing" ? <span className="ask-steps__dot" /> : s.s === "done" ? "✓" : "!"}
                  </span>
                  <span>{s.t}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="ask-act__working">
              <span className="ask-steps__dot" aria-hidden />
              {view.stage}
            </p>
          )}
          <span className="ask-act__bar" role="progressbar" aria-valuenow={view.progress ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ transform: `scaleX(${Math.max(3, view.progress ?? 3) / 100})` }} />
          </span>
          <p className="ask-act__hint">You can leave this chat. It carries on and lands here.</p>
        </>
      )}

      {view.state === "ASKING" && (
        <>
          {view.answered.length > 0 && (
            <p className="ask-act__recap">
              {view.answered.map((a) => (
                <span key={a.title} className="ask-act__pair">
                  <span className="ask-act__k">{a.title}</span>
                  <span className="ask-act__v">{a.value}</span>
                </span>
              ))}
            </p>
          )}
          <QuestionPager
            questions={view.questions}
            picks={picks}
            others={others}
            live={live}
            working={working}
            submitLabel="Continue"
            onPick={(input, values) => setPicks((p) => ({ ...p, [input]: values }))}
            onOther={(input, text) => setOthers((o) => ({ ...o, [input]: text }))}
            onSubmit={() =>
              send({
                op: "answer",
                answers: view.questions.map((q) => ({
                  input: q.input,
                  values: others[q.input] !== null && others[q.input] !== undefined ? [] : picks[q.input] ?? [],
                  other: others[q.input] ?? null,
                })),
              })
            }
            onCancel={live ? () => send({ op: "cancel" }) : undefined}
          />
        </>
      )}

      {view.state === "READY" && view.preview && (
        <>
          {live && (
            <div className="ask-act__acts ask-setup__top">
              <button type="button" className="btn btn--ink btn--sm" disabled={working} onClick={() => send({ op: "confirm", skip })}>
                {working ? "Starting…" : view.preview.confirm}
                {!working && <ArrowUpRight size={13} />}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={working} onClick={() => send({ op: "edit" })}>
                Change details
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={working} onClick={() => send({ op: "cancel" })}>
                Cancel
              </button>
            </div>
          )}
          <ul className="ask-act__lines">
            {view.preview.lines.filter(Boolean).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {view.pictures.length > 0 && (
            <div className="ask-setup__pics">
              <p className="ask-setup__pics-head">
                {kept === view.pictures.length ? `${kept} pictures` : `${kept} of ${view.pictures.length} pictures`}
                {live && <span>Tap a picture to leave it out.</span>}
              </p>
              <ul className="ask-setup__grid">
                {view.pictures.map((p) => {
                  const off = skip.includes(p.n);
                  return (
                    <li key={p.n}>
                      <button
                        type="button"
                        className={`ask-setup__pic${off ? " is-off" : ""}`}
                        aria-pressed={!off}
                        disabled={!live || working}
                        onClick={() => setSkip((s) => (off ? s.filter((x) => x !== p.n) : [...s, p.n]))}
                        title={off ? `${p.title}: left out` : p.title}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/dashboard/ask/setup/${view.id}/picture/${p.n}`} alt={p.title} loading="lazy" />
                        <span className="ask-setup__pic-label">
                          <span>{p.label}</span>
                          <span className="ask-setup__pic-title">{p.title}</span>
                        </span>
                        <span className="ask-setup__tick" aria-hidden>
                          {!off && <Check size={11} />}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {view.preview.cost && <p className="ask-act__cost">{view.preview.cost}</p>}
        </>
      )}

      {view.result && (
        <>
          <p className={view.state === "FAILED" ? "ask-act__said ask-act__said--warn" : "ask-act__said"}>{view.result.message}</p>
          {view.result.lines.length > 0 && (
            <ul className="ask-act__lines">
              {view.result.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          {view.result.links.length > 0 && (
            <div className="ask-a__next">
              {view.result.links.map((l, i) =>
                l.done ? (
                  <span key={l.href} className={i === 0 ? "btn btn--ghost btn--sm" : "ask-go"} aria-disabled="true">
                    <Check size={12} />
                    {l.done}
                  </span>
                ) : (
                  <Link key={l.href} href={l.href} className={i === 0 ? "btn btn--ink btn--sm" : "ask-go"}>
                    {l.label}
                    <ArrowUpRight size={12} />
                  </Link>
                ),
              )}
            </div>
          )}
        </>
      )}
      {problem && (
        <p className="ask-act__problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
