"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AskMessage, ThreadSummary } from "@/lib/ask";
import type { AskTable } from "@/lib/ask-rules";
import type { ActionView, NextAction } from "@/lib/ask-actions-rules";
import { PageHead } from "@/components/shell/PageHead";
import { ConfirmAction } from "@/components/ConfirmAction";
import { ArrowUp, ArrowUpRight, Check, Close, FileDoc, Mic, Paperclip, Picture, Plus, Speaker, Stop, Trash } from "@/components/icons";
import { clock, joinSpoken, VOICE_MAX_SECONDS } from "@/lib/ask-voice-rules";
import { useVoice } from "./useVoice";
import { QuestionPager, startingPicks } from "./QuestionPager";
import { FileChips, SetupCard } from "./SetupCard";
import { SETUP_FILE_TYPES, SETUP_MAX_FILES, fileProblem } from "@/lib/setup-file-rules";
import { rememberChat } from "@/lib/ask-last-chat";
import { deleteChatAction } from "@/app/actions/ask";

type Thread = { id: string; title: string; messages: AskMessage[] };

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const IST = "Asia/Kolkata";

/**
 * When a chat was last used, on the IST calendar. Read in the machine's own
 * time zone the server and the browser disagreed, and the page failed to
 * hydrate for anybody not in India.
 */
function when(iso: string): string {
  const d = new Date(iso);
  const dayOf = (x: Date) => Date.parse(x.toLocaleDateString("en-CA", { timeZone: IST }));
  const diff = Math.round((dayOf(new Date()) - dayOf(d)) / 86_400_000);
  if (diff === 0) return d.toLocaleTimeString("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short" });
}

// ---------------------------------------------------------------------------
// An answer's words: paragraphs, a short list, bold. Nothing else is read as markup.
// ---------------------------------------------------------------------------

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

function Words({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    blocks.push(
      <ul key={`l${blocks.length}`}>
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (/^[-*•]\s+/.test(t)) {
      list.push(t.replace(/^[-*•]\s+/, ""));
      continue;
    }
    flush();
    if (t) blocks.push(<p key={`p${blocks.length}`}>{inline(t)}</p>);
  }
  flush();
  return <div className="ask-a__words">{blocks}</div>;
}

// ---------------------------------------------------------------------------
// A result: the table the numbers came from, with a chart when one reads better
// ---------------------------------------------------------------------------

/** Rows shown before "Show all": a short table is shown whole. */
const SHOWN = 10;
const WHOLE = 15;

function Columns({ t }: { t: AskTable }) {
  const values = t.chart!.values;
  const max = Math.max(...values, 0);
  // Over time the latest column is the one lit: it is the one still moving.
  const lit = values.length - 1;
  const every = Math.ceil(values.length / 8);
  // Every nth column is named, and the lit one always; a name that would sit
  // against the lit one's is left out rather than printed over it.
  const label = (i: number) =>
    i === lit || (i % every === 0 && lit - i >= Math.max(2, every))
      ? t.rows[i].cells[0].replace(/^Week of /, "").replace(/^[A-Z][a-z]{2} (?=\d)/, "")
      : "";
  return (
    <div className="ask-cols" role="img" aria-label={`${t.columns[t.chart!.column].label} by ${t.columns[0].label.toLowerCase()}, as a column chart`}>
      {values.map((v, i) => (
        <div key={i} className={`ask-cols__col${i === lit ? " is-lit" : ""}`}>
          {i === lit && <span className="ask-cols__val">{t.rows[i].cells[t.chart!.column]}</span>}
          <span className="ask-cols__bar" style={{ height: `${max > 0 ? Math.max(3, (v / max) * 100) : 3}%` }} />
          <span className="ask-cols__label">{label(i)}</span>
        </div>
      ))}
    </div>
  );
}

function ResultTable({ t }: { t: AskTable }) {
  const [all, setAll] = useState(false);
  const bars = t.chart?.kind === "bars" ? t.chart : null;
  const max = bars ? Math.max(...bars.values, 0) : 0;
  // Every row equal to the largest is lit: lighting only the first of a tie
  // would draw a difference the numbers do not have.
  const isTop = (i: number) => !!bars && max > 0 && bars.values[i] === max;
  const folds = t.rows.length > WHOLE;
  const rows = all || !folds ? t.rows : t.rows.slice(0, SHOWN);
  return (
    <figure className={`ask-t${t.columns.length + (bars ? 1 : 0) > 2 ? " ask-t--wide" : ""}`}>
      <figcaption className="ask-t__head">
        <span className="ask-t__title">{t.title}</span>
        {t.period && <span className="pill pill--quiet">{cap(t.period)}</span>}
      </figcaption>
      {t.chart?.kind === "columns" && <Columns t={t} />}
      {/* Lays itself out on a narrow column (ask.css), so the phone card layout leaves it alone. */}
      <table className="ask-t__table" data-keep="">
        <thead>
          <tr>
            {t.columns.map((c, i) => (
              <Fragment key={i}>
                <th scope="col" className={c.numeric ? "is-num" : undefined}>
                  {c.label}
                </th>
                {bars && i === 0 && <th scope="col" className="ask-t__barcol" aria-hidden />}
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.cells.map((c, ci) => (
                <Fragment key={ci}>
                  <td className={t.columns[ci].numeric ? "is-num" : undefined} data-label={t.columns[ci].label}>
                    {ci === 0 && r.href ? (
                      <Link href={r.href} className="ask-t__link">
                        {c}
                      </Link>
                    ) : (
                      c
                    )}
                  </td>
                  {bars && ci === 0 && (
                    <td className="ask-t__barcol" aria-hidden>
                      <span className="ask-bar">
                        <span
                          className={`ask-bar__fill${isTop(ri) ? " is-lit" : ""}`}
                          style={{ width: `${max > 0 ? Math.max(2, (bars.values[ri] / max) * 100) : 0}%` }}
                        />
                      </span>
                    </td>
                  )}
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
        {t.total && (
          <tfoot>
            <tr>
              {t.total.map((c, i) => (
                <Fragment key={i}>
                  <td className={t.columns[i]?.numeric ? "is-num" : undefined} data-label={t.columns[i]?.label}>
                    {c}
                  </td>
                  {bars && i === 0 && <td className="ask-t__barcol" aria-hidden />}
                </Fragment>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {(folds || t.more > 0) && (
        <div className="ask-t__foot">
          {folds && (
            <button type="button" className="ask-t__more" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${t.rows.length} rows`}
            </button>
          )}
          {t.more > 0 && <span className="ask-t__rest">{t.more} more not shown. Ask for a narrower list to see them.</span>}
        </div>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// An action card: the question it needs answered, then what will happen, then what did
// ---------------------------------------------------------------------------

const STATE_PILL: Record<ActionView["state"], { text: string; tone: string }> = {
  ASKING: { text: "Needs your answer", tone: "blue" },
  PROPOSED: { text: "Waiting for you", tone: "blue" },
  RUNNING: { text: "Working", tone: "blue" },
  DONE: { text: "Done", tone: "ok" },
  FAILED: { text: "Did not happen", tone: "warn" },
  CANCELLED: { text: "Cancelled", tone: "quiet" },
  EXPIRED: { text: "Expired", tone: "quiet" },
};

async function actionCall(body: Record<string, unknown>): Promise<{ ok: boolean; view?: ActionView; message?: string; messages?: AskMessage[] }> {
  try {
    const res = await fetch("/dashboard/ask/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; view?: ActionView; message?: string; messages?: AskMessage[] };
  } catch {
    return { ok: false, message: "Couldn't reach Jimmy. Check your connection and try again." };
  }
}

function ActionCard({
  initial,
  threadId,
  latest,
  onMessages,
}: {
  initial: ActionView;
  threadId: string | null;
  latest: boolean;
  onMessages: (ms: AskMessage[]) => void;
}) {
  const [view, setView] = useState(initial);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [others, setOthers] = useState<Record<string, string | null>>({});
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);

  // A running action is read again until it lands: seconds for a post, many minutes for a reel.
  useEffect(() => {
    if (view.state !== "RUNNING") return;
    const every = view.result?.jobId ? 5000 : 2500;
    const t = setInterval(async () => {
      const r = await actionCall({ op: "status", id: view.id });
      if (r.ok && r.view) setView(r.view);
    }, every);
    return () => clearInterval(t);
  }, [view.state, view.id, view.result?.jobId]);

  // A new question clears the last one's picks, and picks its default: the
  // obvious answer (the tower the buyer enquired about), still theirs to change.
  useEffect(() => {
    setPicks(startingPicks(view.questions));
    setOthers({});
  }, [view.questions.map((q) => q.input + q.title).join("|")]);

  const send = async (body: Record<string, unknown>) => {
    setWorking(true);
    setProblem(null);
    const r = await actionCall({ ...body, id: view.id });
    setWorking(false);
    if (r.ok && r.view) setView(r.view);
    else setProblem(r.message ?? "That did not work. Try again.");
  };

  const submit = () =>
    send({
      op: "answer",
      answers: view.questions.map((q) => ({
        input: q.input,
        values: others[q.input] !== null && others[q.input] !== undefined ? [] : picks[q.input] ?? [],
        other: others[q.input] ?? null,
      })),
    });

  const liveAsk = view.state === "ASKING" && latest;

  const next = async (n: NextAction) => {
    if (!threadId) return;
    setWorking(true);
    const r = await actionCall({ op: "next", threadId, kind: n.kind, label: n.label, inputs: n.inputs });
    setWorking(false);
    if (r.ok && r.messages) onMessages(r.messages);
    else setProblem(r.message ?? "That did not work. Try again.");
  };

  const pill = STATE_PILL[view.state];
  const r = view.result;
  return (
    <div className={`ask-act ask-act--${view.state.toLowerCase()}`} ref={card} aria-busy={view.state === "RUNNING"}>
      <div className="ask-act__head">
        <p className="ask-act__title">{view.heading}</p>
        <span className={`pill pill--${pill.tone}`}>
          {view.state !== "CANCELLED" && view.state !== "EXPIRED" && <span className="pill__dot" />}
          {pill.text}
        </span>
      </div>
      {view.state === "ASKING" && view.answered.length > 0 && (
        <p className="ask-act__recap">
          {view.answered.map((a) => (
            <span key={a.title} className="ask-act__pair">
              <span className="ask-act__k">{a.title}</span>
              <span className="ask-act__v">{a.value}</span>
            </span>
          ))}
        </p>
      )}

      {view.state === "ASKING" && (
        <QuestionPager
          questions={view.questions}
          picks={picks}
          others={others}
          live={liveAsk}
          working={working}
          submitLabel="Continue"
          onPick={(input, values) => setPicks((p) => ({ ...p, [input]: values }))}
          onOther={(input, text) => setOthers((o) => ({ ...o, [input]: text }))}
          onSubmit={submit}
          onCancel={latest ? () => send({ op: "cancel" }) : undefined}
        />
      )}

      {view.state === "PROPOSED" && view.preview && (
        <>
          <ul className="ask-act__lines">
            {view.preview.lines.filter(Boolean).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          {view.preview.cost && <p className="ask-act__cost">{view.preview.cost}</p>}
          <div className="ask-act__acts">
            <button type="button" className="btn btn--ink btn--sm" disabled={working} onClick={() => send({ op: "confirm" })}>
              {working ? "Starting…" : view.preview.confirm}
              {!working && <ArrowUpRight size={13} />}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={working} onClick={() => send({ op: "cancel" })}>
              Cancel
            </button>
          </div>
        </>
      )}

      {view.state === "RUNNING" && (
        <>
          <p className="ask-act__working">
            <span className="ask-steps__dot" aria-hidden />
            {r?.stage ?? view.working}
          </p>
          {typeof r?.progress === "number" && (
            <span className="ask-act__bar" role="progressbar" aria-valuenow={r.progress} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ transform: `scaleX(${Math.max(3, r.progress) / 100})` }} />
            </span>
          )}
          <p className="ask-act__hint">You can leave this chat. It carries on and lands here.</p>
        </>
      )}

      {(view.state === "DONE" || view.state === "FAILED" || view.state === "CANCELLED" || view.state === "EXPIRED") && r && (
        <>
          <p className={view.state === "FAILED" ? "ask-act__said ask-act__said--warn" : "ask-act__said"}>{r.message}</p>
          {r.image && view.state === "DONE" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="ask-act__img" src={r.image} alt="The post that was made" loading="lazy" />
          )}
          {((r.links?.length ?? 0) > 0 || (r.next?.length ?? 0) > 0) && (
            <div className="ask-a__next">
              {(r.next ?? []).map((n, i) => (
                <button
                  key={n.kind + n.label}
                  type="button"
                  className={i === 0 ? "btn btn--ink btn--sm" : "ask-chip"}
                  disabled={working || !threadId}
                  onClick={() => next(n)}
                >
                  {n.label}
                  {i === 0 && <ArrowUpRight size={13} />}
                </button>
              ))}
              {(r.links ?? []).map((l) => (
                <Link key={l.href} href={l.href} className="ask-go">
                  {l.label}
                  <ArrowUpRight size={12} />
                </Link>
              ))}
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

/** A question back, with options. Pressing one asks it; Other lets the person write their own. */
function Clarify({ c, busy, latest, onAsk }: { c: { question: string; options: string[] }; busy: boolean; latest: boolean; onAsk: (q: string) => void }) {
  const [typing, setTyping] = useState<string | null>(null);
  return (
    <div className="ask-clarify">
      <div className="ask-opts" role="group" aria-label={c.question}>
        {c.options.map((o) => (
          <button key={o} type="button" className="ask-opt" disabled={busy || !latest} onClick={() => onAsk(o)}>
            <span className="ask-opt__label">{o}</span>
          </button>
        ))}
        <button type="button" className={`ask-opt${typing !== null ? " is-on" : ""}`} disabled={busy || !latest} onClick={() => setTyping(typing === null ? "" : null)}>
          <span className="ask-opt__label">Other</span>
        </button>
      </div>
      {typing !== null && latest && (
        <form
          className="ask-clarify__other"
          onSubmit={(e) => {
            e.preventDefault();
            if (typing.trim()) onAsk(typing.trim());
          }}
        >
          <input className="ask-q-block__input" autoFocus value={typing} placeholder="Type your answer" onChange={(e) => setTyping(e.target.value)} maxLength={300} />
          <button type="submit" className="btn btn--ink btn--sm" disabled={!typing.trim() || busy}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One answer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// An answer read aloud
// ---------------------------------------------------------------------------

/** One answer plays at a time, whichever answer's speaker was pressed last. */
let playing: { audio: HTMLAudioElement; url: string; stop: () => void } | null = null;

function ReadAloud({ messageId }: { messageId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const mine = useRef<(() => void) | null>(null);

  useEffect(() => () => mine.current?.(), []);

  const stop = () => {
    mine.current?.();
    setState("idle");
  };

  const read = async () => {
    playing?.stop();
    setError(null);
    setState("loading");
    try {
      const r = await fetch("/dashboard/ask/listen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("json")) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "That answer could not be read aloud. Try again.");
        setState("idle");
        return;
      }
      const url = URL.createObjectURL(await r.blob());
      const audio = new Audio(url);
      const end = () => {
        audio.pause();
        URL.revokeObjectURL(url);
        if (playing?.audio === audio) playing = null;
        mine.current = null;
        setState("idle");
      };
      mine.current = end;
      playing = { audio, url, stop: end };
      audio.addEventListener("ended", end, { once: true });
      await audio.play();
      setState("playing");
    } catch {
      setError("That answer could not be read aloud. Try again.");
      setState("idle");
    }
  };

  return (
    <div className="ask-a__listen">
      {state === "playing" ? (
        <button type="button" className="ask-listen ask-listen--on" onClick={stop} aria-label="Stop reading">
          <Stop size={12} />
        </button>
      ) : (
        <button
          type="button"
          className="ask-listen"
          onClick={read}
          disabled={state === "loading"}
          aria-label={state === "loading" ? "Getting the answer read" : "Read aloud"}
          title="Read aloud"
        >
          <Speaker size={15} />
        </button>
      )}
      {error && (
        <span className="ask-listen__error" role="status">
          {error}
        </span>
      )}
    </div>
  );
}

function Answer({
  m,
  busy,
  latest,
  threadId,
  onAsk,
  onMessages,
}: {
  m: AskMessage;
  busy: boolean;
  latest: boolean;
  threadId: string | null;
  onAsk: (q: string) => void;
  onMessages: (ms: AskMessage[]) => void;
}) {
  const tone = m.outcome === "REFUSED" || m.outcome === "LIMIT" || m.outcome === "FAILED" ? "warn" : m.outcome === "STOPPED" ? "quiet" : null;
  return (
    <article className="ask-a" aria-label="Jimmy's answer">
      <div className="ask-a__main">
        {m.setup ? (
          <SetupCard initial={m.setup} latest={latest} />
        ) : m.action ? (
          <ActionCard initial={m.action} threadId={threadId} latest={latest} onMessages={onMessages} />
        ) : tone ? (
          <div className={`ask-a__said ask-a__said--${tone}`}>{m.body}</div>
        ) : (
          <Words text={m.body} />
        )}
        {!m.action && !m.setup && !tone && m.body.trim() && <ReadAloud messageId={m.id} />}
        {m.blocks.clarify && <Clarify c={m.blocks.clarify} busy={busy} latest={latest} onAsk={onAsk} />}
        {m.blocks.notes.map((n, i) => (
          <p key={i} className="ask-a__note">
            {n}
          </p>
        ))}
        {m.blocks.tables.map((t) => (
          <ResultTable key={t.id} t={t} />
        ))}
        {(m.blocks.links.length > 0 || m.blocks.followUps.length > 0) && (
          <div className="ask-a__next">
            {m.blocks.links.map((l) => (
              <Link key={l.href} href={l.href} className="ask-go">
                Open {l.label}
                <ArrowUpRight size={12} />
              </Link>
            ))}
            {m.blocks.followUps.map((f) => (
              <button key={f} type="button" className="ask-chip" disabled={busy} onClick={() => onAsk(f)}>
                {f}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Questions in flight
// ---------------------------------------------------------------------------
//
// A question outlives the screen that asked it. Switching to another chat or
// starting a new one leaves it running, and its answer lands in its own chat;
// only Stop stops it. So a request lives here, beside the screen rather than
// inside it, and whichever screen is showing its chat reads it.

type Done = { question: AskMessage; answer: AskMessage; thread: ThreadSummary; left: number };

type Flight = {
  key: string;
  /** The files the question carried, by name, for its bubble while it runs. */
  files: { id: string; name: string; type: string }[];
  /** Null until the first line of a new chat's answer names its chat. */
  threadId: string | null;
  title: string | null;
  question: string;
  steps: string[];
  stopping: boolean;
  /** Stop was pressed before the chat had an id; sent the moment it has one. */
  stopQueued: boolean;
  done: Done | null;
  error: string | null;
};

const flights = new Map<string, Flight>();
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Re-renders the caller whenever any question in flight moves. */
function useFlights(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

const running = (f: Flight) => !f.done && !f.error;

function sendStop(threadId: string) {
  void fetch("/dashboard/ask/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId }),
  }).catch(() => undefined);
}

function stopFlight(f: Flight) {
  if (f.stopping || !running(f)) return;
  f.stopping = true;
  if (f.threadId) sendStop(f.threadId);
  else f.stopQueued = true;
  changed();
}

function launch(question: string, threadId: string | null, files: { id: string; name: string; type: string }[] = []): Flight {
  const f: Flight = {
    key: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    files,
    threadId,
    title: null,
    question,
    steps: [],
    stopping: false,
    stopQueued: false,
    done: null,
    error: null,
  };
  flights.set(f.key, f);
  changed();
  void (async () => {
    try {
      const res = await fetch("/dashboard/ask/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, threadId, files: files.map((x) => x.id) }),
      });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as
            | { type: "thread"; thread: ThreadSummary & { created: boolean } }
            | { type: "step"; text: string }
            | ({ type: "done" } & Done)
            | { type: "error"; message: string };
          if (msg.type === "thread") {
            f.threadId = msg.thread.id;
            f.title = msg.thread.title;
            if (f.stopQueued) sendStop(msg.thread.id);
          } else if (msg.type === "step") {
            if (f.steps[f.steps.length - 1] !== msg.text) f.steps = [...f.steps, msg.text];
          } else if (msg.type === "done") {
            f.done = { question: msg.question, answer: msg.answer, thread: msg.thread, left: msg.left };
          } else if (msg.type === "error") {
            f.error = msg.message;
          }
          changed();
        }
      }
      if (running(f)) throw new Error("cut short");
    } catch (e) {
      if (running(f)) {
        console.error(e);
        f.error = "Couldn't reach Jimmy. Check your connection and try again.";
        changed();
      }
    }
  })();
  return f;
}

// ---------------------------------------------------------------------------
// Files attached to the next question
// ---------------------------------------------------------------------------

/** A file attached to the next question, from the moment it is chosen. */
type Att = {
  key: string;
  name: string;
  size: number;
  type: string;
  state: "hashing" | "uploading" | "ready" | "failed";
  progress: number;
  id: string | null;
  message: string | null;
  /** A zip's PDFs and pictures, counted when it lands; opened when it is sent. */
  inside?: number | null;
};

async function filesCall(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const res = await fetch("/dashboard/ask/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, message: "Couldn't reach Jimmy. Check your connection and try again." };
  }
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Some browsers give no type for a file; its name says it. */
function typeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return ({ pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", zip: "application/zip" } as Record<string, string>)[ext] ?? "";
}

function putWithProgress(url: string, headers: Record<string, string>, file: File, onProgress: (p: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.onabort = () => resolve(false);
    xhr.send(file);
  });
}

/** Checked here, sent straight to the store, then read back by the server. A zip stays one file until it is sent. */
async function uploadOne(file: File, set: (patch: Partial<Att>) => void): Promise<void> {
  const type = typeOf(file);
  const local = fileProblem({ name: file.name, type, size: file.size, sha256: "0".repeat(64) });
  if (!local.ok) return set({ state: "failed", message: local.message });
  let sha: string;
  try {
    sha = await sha256Hex(file);
  } catch {
    return set({ state: "failed", message: `${file.name} could not be opened.` });
  }
  set({ state: "uploading", type });
  const begun = await filesCall({ op: "begin", name: file.name, type, size: file.size, sha256: sha });
  if (!begun.ok) return set({ state: "failed", message: String(begun.message ?? "That file could not be attached.") });
  const id = String(begun.id);
  set({ id });
  const upload = begun.upload as { url: string; headers: Record<string, string> } | null;
  if (upload) {
    const sent = await putWithProgress(upload.url, upload.headers, file, (progress) => set({ progress }));
    if (!sent) return set({ state: "failed", message: `${file.name} did not upload. Attach it again.` });
  }
  set({ progress: 100 });
  const done = await filesCall({ op: "finish", id });
  if (!done.ok) return set({ state: "failed", message: String(done.message ?? "That file could not be read.") });
  const landed = done.file as { type?: string; pages?: number | null } | undefined;
  set({ state: "ready", type: landed?.type ?? type, inside: landed?.type === "application/zip" ? landed.pages ?? null : null });
}

// ---------------------------------------------------------------------------
// The chat list, drawn once and placed twice: a column on a desk, a fold on a phone
// ---------------------------------------------------------------------------

const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** One attached file, from the moment it is chosen. */
function AttChip({ a, detach }: { a: Att; detach: (a: Att) => void }) {
  const zip = a.type === "application/zip" || /\.zip$/i.test(a.name);
  return (
    <li className={`ask-att is-${a.state}`} title={a.message ?? a.name}>
      <span className="ask-att__icon" aria-hidden>
        {a.type.startsWith("image/") ? <Picture size={14} /> : <FileDoc size={14} />}
      </span>
      <span className="ask-att__text">
        <span className="ask-att__name">{a.name}</span>
        <span className="ask-att__state">
          {a.state === "failed"
            ? a.message
            : a.state === "ready"
              ? zip && a.inside
                ? `${a.inside} ${a.inside === 1 ? "file" : "files"} · ${sizeText(a.size)}`
                : sizeText(a.size)
              : a.state === "hashing"
                ? "Opening"
                : a.progress >= 100
                  ? "Checking"
                  : `Uploading ${a.progress}%`}
        </span>
      </span>
      {a.state === "uploading" && <span className="ask-att__bar" style={{ transform: `scaleX(${Math.max(4, a.progress) / 100})` }} aria-hidden />}
      <button type="button" className="ask-att__x" onClick={() => detach(a)} aria-label={`Remove ${a.name}`}>
        <Close size={12} />
      </button>
    </li>
  );
}

/**
 * The files waiting to be sent. Past a handful, the pictures fold into one
 * chip that says how many and how far along they are; a press shows them
 * all. Documents, zips and anything that failed always show on their own.
 */
function AttChips({ atts, detach }: { atts: Att[]; detach: (a: Att) => void }) {
  const [open, setOpen] = useState(false);
  if (!atts.length) return null;
  const foldable = atts.filter((a) => a.type.startsWith("image/") && a.state !== "failed");
  const fold = !open && atts.length > 4 && foldable.length > 2;
  const shown = fold ? atts.filter((a) => !foldable.includes(a)) : atts;
  const busy = foldable.filter((a) => a.state !== "ready").length;
  const bytes = foldable.reduce((n, a) => n + a.size, 0);
  return (
    <ul className="ask-atts" aria-label="Attached files">
      {shown.map((a) => (
        <AttChip key={a.key} a={a} detach={detach} />
      ))}
      {fold && (
        <li className={`ask-att${busy ? " is-uploading" : " is-ready"}`}>
          <span className="ask-att__icon" aria-hidden>
            <Picture size={14} />
          </span>
          <button type="button" className="ask-att__text ask-att__open" onClick={() => setOpen(true)} aria-expanded={false}>
            <span className="ask-att__name">{foldable.length} pictures</span>
            <span className="ask-att__state">{busy ? `Uploading, ${foldable.length - busy} of ${foldable.length} done` : `${sizeText(bytes)} · Show all`}</span>
          </button>
          <button type="button" className="ask-att__x" onClick={() => foldable.forEach(detach)} aria-label={`Remove all ${foldable.length} pictures`}>
            <Close size={12} />
          </button>
        </li>
      )}
      {open && atts.length > 4 && (
        <li>
          <button type="button" className="ask-att ask-att__less" onClick={() => setOpen(false)}>
            Show less
          </button>
        </li>
      )}
    </ul>
  );
}

// Every pasted screenshot arrives as "image.png", so give each its own name.
function pastedName(file: File, i: number): File {
  const ext = file.name.split(".").pop() ?? "png";
  const at = new Date().toTimeString().slice(0, 8).replace(/:/g, ".");
  return new File([file], `Pasted picture ${at}${i ? `-${i + 1}` : ""}.${ext}`, { type: file.type });
}

/**
 * A chat's saved messages. A question still running when the chat was opened
 * was saved before it was answered; the running question shows it, so the
 * saved copy waits.
 */
function savedMessages(thread: Thread | null): AskMessage[] {
  const ms = thread?.messages ?? [];
  const id = thread?.id;
  const f = id ? [...flights.values()].find((x) => x.threadId === id && running(x)) : undefined;
  const last = ms[ms.length - 1];
  return f && last?.role === "PERSON" && last.body === f.question ? ms.slice(0, -1) : ms;
}

function ChatList({ threads, current, working }: { threads: ThreadSummary[]; current: string | null; working: ReadonlySet<string> }) {
  if (!threads.length) return <p className="ask-list__empty">Your chats appear here for 30 days.</p>;
  return (
    <ul className="ask-list__items">
      {threads.map((t) => (
        <li key={t.id}>
          <Link href={`/dashboard/ask?t=${t.id}`} className="ask-list__item" aria-current={t.id === current ? "page" : undefined}>
            <span className="ask-list__title">{t.title}</span>
            {working.has(t.id) ? (
              <span className="ask-list__when is-working">Answering</span>
            ) : (
              <span className="ask-list__when">{when(t.updatedAt)}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function AskJimmy(props: {
  firstName: string | null;
  threads: ThreadSummary[];
  thread: Thread | null;
  starters: string[];
  left: number;
  /** Actions are switched on and this person may do at least one. */
  canAct: boolean;
  /** This person may set a project up, or add to one, from files. */
  canAttach?: boolean;
  /** The longest question or note, in characters. */
  maxChars: number;
}) {
  const tick = useFlights();
  const [threads, setThreads] = useState(props.threads);
  const [threadId, setThreadId] = useState<string | null>(props.thread?.id ?? null);
  const [title, setTitle] = useState<string | null>(props.thread?.title ?? null);
  const [messages, setMessages] = useState<AskMessage[]>(() => savedMessages(props.thread));
  /** A question asked here before its chat had an id. */
  const [ownKey, setOwnKey] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; question: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [left, setLeft] = useState(props.left);
  const [atts, setAtts] = useState<Att[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [said, setSaid] = useState("");

  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // The chat on screen is the one Ask Jimmy reopens, for this browser session;
  // its address says so too, so a reload stays on it.
  useEffect(() => {
    rememberChat(threadId);
    if (threadId && new URLSearchParams(window.location.search).get("t") !== threadId) {
      window.history.replaceState(null, "", `/dashboard/ask?t=${threadId}`);
    }
  }, [threadId]);
  // A chat picked from the list after "New chat" comes back under the same key
  // the page first rendered it with, so React keeps this screen and its empty
  // state. Take the chat in when the address names it and the screen shows
  // another.
  useEffect(() => {
    const t = props.thread;
    if (!t || t.id === threadId) return;
    if (new URLSearchParams(window.location.search).get("t") !== t.id) return;
    setOwnKey(null);
    setThreadId(t.id);
    setTitle(t.title);
    setMessages(savedMessages(t));
    setError(null);
    // Only a chat the server hands over opens it; this screen's own changes are its own.
  }, [props.thread]); // eslint-disable-line react-hooks/exhaustive-deps
  const [heardProblem, setHeardProblem] = useState<string | null>(null);
  const voice = useVoice({
    onText: (text) => {
      setHeardProblem(null);
      setDraft((d) => joinSpoken(d, text));
      setSaid("Your question is in the box. Check it, then send.");
      requestAnimationFrame(() => {
        const el = field.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
    onProblem: (message) => {
      setHeardProblem(message);
      setSaid(message);
    },
  });
  const speaking = voice.state.kind !== "idle";

  const current =
    (ownKey ? flights.get(ownKey) : undefined) ??
    (threadId ? [...flights.values()].find((f) => f.threadId === threadId) : undefined);
  const pending = current && running(current) ? current : null;

  // A question for this chat moved: adopt a new chat's id, or take its answer in.
  useEffect(() => {
    const f = current;
    if (!f) return;
    if (f.threadId && ownKey === f.key && f.threadId !== threadId) {
      const id = f.threadId;
      setThreadId(id);
      setTitle(f.title);
      setThreads((ts) => (ts.some((t) => t.id === id) ? ts : [{ id, title: f.title ?? f.question, updatedAt: new Date().toISOString() }, ...ts]));
      window.history.replaceState(null, "", `/dashboard/ask?t=${id}`);
    }
    if (f.done) {
      const d = f.done;
      setMessages((ms) =>
        ms.some((m) => m.id === d.answer.id) ? ms : [...ms.filter((m) => m.id !== d.question.id), d.question, d.answer],
      );
      setLeft(d.left);
      setThreads((ts) => [{ ...d.thread, updatedAt: d.answer.createdAt }, ...ts.filter((t) => t.id !== d.thread.id)]);
      setSaid(d.answer.outcome === "STOPPED" ? "Stopped." : "Jimmy answered.");
      flights.delete(f.key);
      setOwnKey(null);
      changed();
    } else if (f.error) {
      setError({ message: f.error, question: f.question });
      setDraft(f.question);
      setSaid(f.error);
      flights.delete(f.key);
      setOwnKey(null);
      changed();
    }
  }, [tick, current, ownKey, threadId]);

  // While Jimmy works, follow the steps down. Once it answers, bring the
  // question to the top, so a long answer is read from its first line rather
  // than landed on at the foot of its table.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    if (pending) {
      el.scrollTo({ top: el.scrollHeight, behavior });
      return;
    }
    const asked = el.querySelectorAll<HTMLElement>(".ask-thread > .ask-q");
    const last = asked[asked.length - 1];
    el.scrollTo({ top: last ? last.offsetTop - 16 : el.scrollHeight, behavior });
  }, [messages.length, pending?.key, pending?.steps.length]);

  // The field grows with what is typed, up to a few lines.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [draft]);

  const ready = atts.filter((a) => a.state === "ready" && a.id);
  const uploading = atts.some((a) => a.state === "hashing" || a.state === "uploading");
  const ask = (raw: string) => {
    const question = raw.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if ((!question && !ready.length) || pending || uploading) return;
    setError(null);
    setDraft("");
    const files = ready.map((a) => ({ id: a.id!, name: a.name, type: a.type }));
    setAtts((all) => all.filter((a) => a.state === "failed"));
    setSaid(files.length ? "Jimmy is opening your files." : "Jimmy is looking.");
    const f = launch(question, threadId, files);
    if (!threadId) setOwnKey(f.key);
    field.current?.focus();
  };

  const update = (key: string, patch: Partial<Att>) => setAtts((all) => all.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const attach = (list: FileList | File[]) => {
    const files = [...list];
    if (!files.length) return;
    const room = SETUP_MAX_FILES - atts.filter((a) => a.state !== "failed").length;
    const take = files.slice(0, Math.max(0, room));
    if (files.length > take.length) setSaid(`Attach up to ${SETUP_MAX_FILES} files at once.`);
    for (const file of take) {
      const key = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const att: Att = { key, name: file.name, size: file.size, type: file.type, state: "hashing", progress: 0, id: null, message: null };
      setAtts((all) => [...all, att]);
      void uploadOne(file, (patch) => update(key, patch));
    }
  };
  const detach = (a: Att) => {
    setAtts((all) => all.filter((x) => x.key !== a.key));
    if (a.id) void filesCall({ op: "remove", id: a.id });
  };

  // A new chat leaves any question still running in the old one to finish there.
  const fresh = () => {
    setOwnKey(null);
    setThreadId(null);
    setTitle(null);
    setMessages([]);
    setError(null);
    setDraft("");
    window.history.replaceState(null, "", "/dashboard/ask");
    field.current?.focus();
  };

  // Chats started here that the list has not heard of yet, and which are still answering.
  const all = [...flights.values()];
  const listed = [
    ...all
      .filter((f) => f.threadId && f.title && !threads.some((t) => t.id === f.threadId))
      .map((f) => ({ id: f.threadId!, title: f.title!, updatedAt: new Date().toISOString() })),
    ...threads,
  ];
  const working = new Set(all.filter((f) => f.threadId && running(f)).map((f) => f.threadId!));

  const lastAnswerId = [...messages].reverse().find((m) => m.role === "JIMMY")?.id ?? null;
  const talking = messages.length > 0 || !!pending;
  const busy = !!pending;
  const out = left <= 0;

  return (
    <>
      <PageHead
        title={
          <>
            Ask <span className="em">Jimmy</span>
          </>
        }
        meta={
          props.canAct
            ? "Answers from your live data, and does what your role allows once you confirm. Your chats are private and kept for 30 days."
            : "Answers from your live data, only what you have access to. Your chats are private and kept for 30 days."
        }
        action={
          talking ? (
            <button type="button" className="btn btn--ink" onClick={fresh}>
              <Plus size={15} />
              New chat
            </button>
          ) : null
        }
      />

      <div className="ask">
        <aside className="card ask-list" aria-label="Your chats">
          <h2 className="ask-list__head">Chats</h2>
          <ChatList threads={listed} current={threadId} working={working} />
        </aside>

        <section className="card ask-talk" aria-label="Conversation with Jimmy">
          {(threadId || listed.length > 0) && (
            <header className="ask-talk__head">
              {listed.length > 0 && (
                <details className="ask-past">
                  <summary className="btn btn--ghost btn--sm">Chats</summary>
                  <div className="ask-past__menu">
                    <ChatList threads={listed} current={threadId} working={working} />
                  </div>
                </details>
              )}
              <h2 className="ask-talk__title">{title ?? (pending ? pending.question : "New chat")}</h2>
              {threadId && !busy && (
                <ConfirmAction
                  label={
                    <>
                      <Trash size={14} />
                      Delete
                    </>
                  }
                  title="Delete this chat?"
                  body="It is removed for good. Nobody else could see it."
                  confirmLabel="Delete chat"
                  action={deleteChatAction}
                  fields={{ threadId }}
                  tone="risk"
                  size="sm"
                  testId="ask-delete"
                />
              )}
            </header>
          )}

          <div className="ask-scroll" ref={scroller}>
            {!talking ? (
              <div className="ask-empty">
                <h2 className="ask-empty__title">
                  What do you want to <span className="em">know</span>
                  {props.firstName ? `, ${props.firstName}` : ""}?
                </h2>
                <p className="ask-empty__sub">
                  {props.starters.length
                    ? props.canAct
                      ? "Ask in plain words, in English or Hinglish, or ask Jimmy to do something for you."
                      : "Ask in plain words, in English or Hinglish."
                    : "You don't have access to any data yet. Ask your admin to give you a role."}
                </p>
                {props.canAttach && !out && (
                  <button type="button" className="ask-setup-start" onClick={() => picker.current?.click()}>
                    <span className="ask-setup-start__icon" aria-hidden>
                      <Paperclip size={16} />
                    </span>
                    <span className="ask-setup-start__text">
                      <span className="ask-setup-start__title">Set up a project from its brochure</span>
                      <span className="ask-setup-start__sub">Attach brochures, price lists, floor plans or pictures. Jimmy asks only what it cannot find.</span>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                )}
                {props.starters.length > 0 && (
                  <div className="ask-empty__starters">
                    {props.starters.map((s) => (
                      <button key={s} type="button" className="ask-chip ask-chip--lg" disabled={out} onClick={() => ask(s)}>
                        {s}
                        <ArrowUpRight size={13} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="ask-thread">
                {messages.map((m) =>
                  m.role === "PERSON" ? (
                    m.blocks.files?.length ? (
                      <div key={m.id} className="ask-q-wrap">
                        <p className="ask-q">{m.body}</p>
                        <FileChips files={m.blocks.files} />
                      </div>
                    ) : (
                      <p key={m.id} className="ask-q">
                        {m.body}
                      </p>
                    )
                  ) : (
                    <Answer
                      key={m.id}
                      m={m}
                      busy={busy}
                      latest={m.id === lastAnswerId && !pending}
                      threadId={threadId}
                      onAsk={ask}
                      onMessages={(ms) => setMessages((all) => [...all, ...ms.filter((x) => !all.some((y) => y.id === x.id))])}
                    />
                  ),
                )}
                {pending && (
                  <>
                    <div className="ask-q-wrap">
                      {pending.question.trim() && <p className="ask-q">{pending.question}</p>}
                      <FileChips files={pending.files} />
                    </div>
                    <article className="ask-a" aria-busy="true" aria-label="Jimmy is working">
                      <div className="ask-a__main">
                        <ol className="ask-steps">
                          {[...(pending.steps.length ? pending.steps : ["Reading the question"]), ...(pending.stopping ? ["Stopping"] : [])].map(
                            (s, i, steps) => (
                              <li key={s} className={i === steps.length - 1 ? "is-now" : "is-done"}>
                                {i === steps.length - 1 ? <span className="ask-steps__dot" aria-hidden /> : <Check size={12} />}
                                {s}
                              </li>
                            ),
                          )}
                        </ol>
                      </div>
                    </article>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="ask-foot">
            {error && (
              <div className="ask-error" role="alert">
                <span>{error.message}</span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => ask(error.question)}>
                  Try again
                </button>
              </div>
            )}
            {heardProblem && !speaking && (
              <div className="ask-error" role="alert">
                <span>{heardProblem}</span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setHeardProblem(null)}>
                  Dismiss
                </button>
              </div>
            )}
            {props.canAttach && (
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                accept={[...SETUP_FILE_TYPES, "application/zip", "application/x-zip-compressed", ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".zip"].join(",")}
                onChange={(e) => {
                  if (e.target.files) attach(e.target.files);
                  e.target.value = "";
                }}
              />
            )}
            {atts.length > 0 && (
              <AttChips atts={atts} detach={detach} />
            )}
            <form
              className={`ask-compose${voice.state.kind === "recording" ? " is-voice" : ""}${dragging ? " is-drop" : ""}`}
              onSubmit={(e) => {
                e.preventDefault();
                if (!speaking) ask(draft);
              }}
              onDragOver={(e) => {
                if (!props.canAttach || out || !e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                if (!props.canAttach || out) return;
                e.preventDefault();
                setDragging(false);
                attach(e.dataTransfer.files);
              }}
            >
              {props.canAttach && !speaking && (
                <button
                  type="button"
                  className="ask-send ask-send--quiet ask-attach"
                  disabled={out}
                  onClick={() => picker.current?.click()}
                  aria-label="Attach brochures, pictures or a zip of them"
                  title="Attach brochures, pictures or a zip of them"
                >
                  <Paperclip size={17} />
                </button>
              )}
              <label htmlFor="ask-field" className="sr-only">
                Your question
              </label>
              <textarea
                id="ask-field"
                ref={field}
                rows={1}
                value={draft}
                maxLength={props.maxChars}
                disabled={out}
                hidden={speaking}
                placeholder={
                  out
                    ? "No questions left today. Ask again tomorrow."
                    : ready.length
                      ? "Add a note, or just send"
                      : props.canAct
                        ? "Ask Jimmy, or ask it to do something…"
                        : "Ask Jimmy about your data…"
                }
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => {
                  // A screenshot pasted from the clipboard attaches like a picked file.
                  if (!props.canAttach || out) return;
                  const files = [...e.clipboardData.files];
                  if (!files.length) return;
                  if (!e.clipboardData.getData("text/plain")) e.preventDefault();
                  attach(files.map((f, i) => (/^image\.\w+$/i.test(f.name) ? pastedName(f, i) : f)));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    ask(draft);
                  }
                }}
              />
              {voice.state.kind === "recording" && (
                <div className="ask-voice" role="status" onKeyDown={(e) => e.key === "Escape" && voice.cancel()}>
                  <span className="ask-voice__dot" aria-hidden />
                  <span className="ask-voice__time tnum">
                    {clock(voice.seconds)} <span>/ {clock(VOICE_MAX_SECONDS)}</span>
                  </span>
                  <span className="ask-voice__hint">Listening. Tap the tick when you finish.</span>
                </div>
              )}
              {voice.state.kind === "hearing" && (
                <div className="ask-voice" role="status">
                  <span className="ask-steps__dot" aria-hidden />
                  <span className="ask-voice__hint">Writing down your question</span>
                </div>
              )}
              {voice.state.kind === "recording" ? (
                <>
                  <button type="button" className="ask-send ask-send--quiet" onClick={voice.cancel} aria-label="Discard the recording">
                    <Close size={15} />
                  </button>
                  <button type="button" className="ask-send ask-send--rec" onClick={voice.finish} aria-label="Finish speaking" autoFocus>
                    <Check size={17} />
                  </button>
                </>
              ) : voice.state.kind === "hearing" ? (
                <button type="button" className="ask-send" disabled aria-label="Writing down your question">
                  <Mic size={17} />
                </button>
              ) : (
                <>
                  {voice.supported && !out && (
                    <button
                      type="button"
                      className="ask-send ask-send--quiet"
                      onClick={() => {
                        setHeardProblem(null);
                        void voice.start();
                      }}
                      aria-label="Speak your question"
                      title="Speak your question"
                    >
                      <Mic size={17} />
                    </button>
                  )}
                  {busy ? (
                    <button
                      type="button"
                      className="ask-send ask-send--stop"
                      onClick={() => pending && stopFlight(pending)}
                      disabled={pending?.stopping}
                      aria-label="Stop"
                    >
                      <Stop size={14} />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="ask-send"
                      disabled={(!draft.trim() && !ready.length) || uploading || out}
                      aria-label={uploading ? "Waiting for your files to upload" : "Send"}
                    >
                      <ArrowUp size={17} />
                    </button>
                  )}
                </>
              )}
            </form>
            {left <= 10 && !out && <p className="ask-left">{left === 1 ? "1 question left today." : `${left} questions left today.`}</p>}
          </div>
          <p className="sr-only" aria-live="polite">
            {said}
          </p>
        </section>
      </div>
    </>
  );
}
