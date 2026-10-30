"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowUpRight, Close, Headset, Phone, Speaker } from "@/components/icons";
import {
  POLL_IDLE_MS,
  POLL_LIVE_MS,
  elapsed,
  ringsHere,
  type DeskCall,
  type DeskRing,
} from "@/lib/call-desk-rules";

type Feed = { rings: DeskRing[]; onTeam: boolean };

const TEMP = {
  HOT: { label: "Hot", tone: "pill--risk" },
  WARM: { label: "Warm", tone: "pill--warn" },
  COLD: { label: "Cold", tone: "pill--blue" },
} as const;

/** `4:32 pm` or `Thu 29 Oct, 4:32 pm`, in IST. */
function when(iso: string, withDay = false): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
  if (!withDay) return time;
  const day = d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${time}`;
}

/**
 * The ring: India's double ring, made in the page, so nothing is downloaded
 * and it plays the instant a buyer arrives. A browser lets a page make sound
 * only after a press, which is what "Turn on ringing" is.
 */
class Ringer {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<boolean> {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    this.ctx ??= new AC();
    await this.ctx.resume().catch(() => undefined);
    return this.ctx.state === "running";
  }

  private burst(at: number, length: number) {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.22, at + 0.02);
    gain.gain.setValueAtTime(0.22, at + length - 0.03);
    gain.gain.linearRampToValueAtTime(0, at + length);
    gain.connect(ctx.destination);
    for (const f of [400, 450]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(gain);
      o.start(at);
      o.stop(at + length);
    }
  }

  /** One short tone: ringing is on and the speaker works. */
  chirp() {
    if (this.ctx?.state === "running") this.burst(this.ctx.currentTime + 0.02, 0.18);
  }

  ring(on: boolean) {
    if (!on) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer || this.ctx?.state !== "running") return;
    const twice = () => {
      const t = this.ctx!.currentTime + 0.02;
      this.burst(t, 0.4);
      this.burst(t + 0.6, 0.4);
    };
    twice();
    this.timer = setInterval(twice, 3000);
  }

  stop() {
    this.ring(false);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

/**
 * A ticker in a worker. A tab left in the background has its own timers slowed
 * to once a minute by the browser; a worker's are not, and a desk that looks
 * once a minute misses the buyer.
 */
function startTicker(ms: () => number, tick: () => void): () => void {
  if (typeof Worker === "undefined") {
    let t: ReturnType<typeof setTimeout>;
    const loop = () => { tick(); t = setTimeout(loop, ms()); };
    t = setTimeout(loop, ms());
    return () => clearTimeout(t);
  }
  const src = "let t;onmessage=(e)=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data)}";
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const w = new Worker(url);
  let current = ms();
  w.postMessage(current);
  w.onmessage = () => {
    tick();
    const next = ms();
    if (next !== current) { current = next; w.postMessage(next); }
  };
  return () => { w.terminate(); URL.revokeObjectURL(url); };
}

export function CallDesk({ initial }: { initial: Feed }) {
  const [feed, setFeed] = useState<Feed>(initial);
  const [armed, setArmed] = useState(false);
  const [soundless, setSoundless] = useState(false);
  const [silenced, setSilenced] = useState<Set<string>>(() => new Set());
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ringer = useRef<Ringer | null>(null);
  const seen = useRef<Set<string>>(new Set(initial.rings.map((r) => r.id)));
  const live = feed.rings.some((r) => r.state === "RINGING" || r.state === "CONNECTED");
  const liveRef = useRef(live);
  liveRef.current = live;

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/dashboard/desk/feed", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setFeed((await res.json()) as Feed);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => startTicker(() => (liveRef.current ? POLL_LIVE_MS : POLL_IDLE_MS), () => void poll()), [poll]);

  // The clocks on the cards.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const ringingHere = feed.rings.filter((r) => ringsHere(r, feed.onTeam) && !silenced.has(r.id));
  const shouldRing = armed && ringingHere.length > 0;

  useEffect(() => ringer.current?.ring(shouldRing), [shouldRing]);

  // A buyer new to the desk: a notification for a person on another tab.
  useEffect(() => {
    for (const r of feed.rings) {
      if (seen.current.has(r.id)) continue;
      seen.current.add(r.id);
      if (!ringsHere(r, feed.onTeam) || !armed) continue;
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        const n = new Notification(`${r.buyer.name} is being put through`, {
          body: [r.buyer.wants.join(", "), r.buyer.place].filter(Boolean).join(" · "),
          tag: r.id,
          requireInteraction: true,
        });
        n.onclick = () => { window.focus(); n.close(); };
      }
    }
  }, [feed, armed]);

  // The tab's title says it too, so a tab among many is found.
  useEffect(() => {
    const base = "Call desk";
    if (!ringingHere.length) { document.title = base; return; }
    const first = ringingHere[0].buyer.name;
    let on = true;
    document.title = `Ringing: ${first}`;
    const t = setInterval(() => { on = !on; document.title = on ? `Ringing: ${first}` : base; }, 1000);
    return () => { clearInterval(t); document.title = base; };
  }, [ringingHere.map((r) => r.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // The screen stays on while ringing is on.
  useEffect(() => {
    if (!armed) return;
    const nav = navigator as Navigator & { wakeLock?: { request: (k: "screen") => Promise<{ release: () => Promise<void> }> } };
    let lock: { release: () => Promise<void> } | null = null;
    const take = () => { if (document.visibilityState === "visible") nav.wakeLock?.request("screen").then((l) => { lock = l; }).catch(() => undefined); };
    take();
    document.addEventListener("visibilitychange", take);
    return () => { document.removeEventListener("visibilitychange", take); void lock?.release().catch(() => undefined); };
  }, [armed]);

  useEffect(() => () => ringer.current?.stop(), []);

  async function turnOn() {
    ringer.current ??= new Ringer();
    const ok = await ringer.current.start();
    setSoundless(!ok);
    setArmed(true);
    ringer.current.chirp();
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  }

  function turnOff() {
    ringer.current?.ring(false);
    setArmed(false);
  }

  const silence = (id: string) => setSilenced((s) => new Set(s).add(id));

  const onLine = feed.rings.filter((r) => r.state === "RINGING" || r.state === "CONNECTED");
  const recent = feed.rings.filter((r) => r.state === "ENDED" || r.state === "MISSED");

  return (
    <div className="desk">
      <PageHead
        title={<>Call <span className="em">desk</span></>}
        meta={feed.onTeam ? "Rings when a buyer is put through to your phone" : "Rings when a buyer is put through to your team"}
        action={
          armed ? (
            <div className="desk-armed">
              <span className="pill pill--ok"><span className="pill__dot" />Ringing on</span>
              <button type="button" className="btn btn--light btn--sm" onClick={turnOff}>Turn off</button>
            </div>
          ) : (
            <button type="button" className="btn btn--ink" onClick={turnOn}>
              <Speaker size={15} /> Turn on ringing
            </button>
          )
        }
      />

      {offline && <p className="desk-offline" role="status">Not connected. Trying again.</p>}
      {armed && soundless && <p className="desk-offline" role="status">This browser blocked the sound. The screen still shows each buyer.</p>}

      {onLine.length > 0 ? (
        onLine.map((r) => (
          <LiveRing
            key={r.id}
            ring={r}
            now={now}
            ringing={armed && ringsHere(r, feed.onTeam) && !silenced.has(r.id)}
            onSilence={() => silence(r.id)}
          />
        ))
      ) : (
        <section className="card desk-quiet" aria-live="polite">
          <span className={`desk-quiet__mark${armed ? " desk-quiet__mark--on" : ""}`}><Headset size={22} /></span>
          <div>
            <h2>Nobody on the line</h2>
            <p className="sub">{armed ? "Keep this tab open. It rings for the next buyer." : "Turn on ringing to hear the next buyer arrive."}</p>
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="card desk-recent">
          <div className="card__head"><h2>Last 30 minutes</h2></div>
          <ul>
            {recent.map((r) => (
              <li key={r.id}>
                <span className="desk-recent__time">{when(r.at)}</span>
                <span className="desk-recent__who">
                  <strong>{r.buyer.name}</strong>
                  <span>{r.buyer.place}</span>
                </span>
                {r.state === "MISSED" ? (
                  <span className="pill pill--risk">Nobody picked up</span>
                ) : (
                  <span className="pill pill--quiet">{r.takenBy ? `Taken by ${r.takenBy}` : "Taken"}</span>
                )}
                <Link href={`/dashboard/leads/${r.buyer.leadId}`} className="btn btn--light btn--sm">
                  Open lead <ArrowUpRight size={13} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function LiveRing({ ring, now, ringing, onSilence }: { ring: DeskRing; now: number; ringing: boolean; onSilence: () => void }) {
  const b = ring.buyer;
  const talking = ring.state === "CONNECTED";
  const status = talking
    ? `On the call${ring.takenBy ? ` with ${ring.takenBy}` : ""}`
    : ring.mine ? "Ringing your phone" : "Ringing the team";
  const temp = b.temperature ? TEMP[b.temperature] : null;

  return (
    <article className={`desk-live${talking ? " desk-live--talking" : ""}`} aria-live="assertive">
      <header className={`desk-hero${!talking ? " desk-hero--ringing" : ""}`}>
        <div className="desk-hero__top">
          <span className="desk-hero__status">
            <Phone size={14} /> {status}
          </span>
          <span className="desk-hero__reason">{ring.reason}</span>
          <span className="desk-hero__clock" aria-label="Time on the line">{elapsed(ring.at, now)}</span>
        </div>

        <div className="desk-hero__who">
          <h2>{b.name}</h2>
          {temp && <span className={`pill ${temp.tone}`}>{temp.label}</span>}
          <span className="desk-hero__stage">{b.stage}</span>
        </div>
        <p className="desk-hero__line">
          {[b.place, b.language, b.phone].filter(Boolean).join(" · ")}
        </p>

        {b.wants.length > 0 && (
          <ul className="desk-hero__wants">
            {b.wants.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}

        <div className="desk-hero__acts">
          <Link href={`/dashboard/leads/${b.leadId}`} className="btn btn--light" target="_blank">
            Open lead <ArrowUpRight size={14} />
          </Link>
          {ringing && (
            <button type="button" className="btn desk-hero__silence" onClick={onSilence}>
              <Close size={14} /> Silence
            </button>
          )}
        </div>
      </header>

      <div className="desk-grid">
        <section className="card desk-call">
          <div className="card__head">
            <h2>On this call</h2>
            {b.thisCall && <span className="sub">{b.thisCall.agent} · {when(b.thisCall.at)}</span>}
          </div>
          <ThisCall call={b.thisCall} transfer={ring.kind === "TRANSFER"} />
        </section>

        <section className="card desk-heard">
          <div className="card__head"><h2>What they told us</h2></div>
          {b.heard.length === 0 && b.form.length === 0 && !(b.thisCall?.facts.length) ? (
            <p className="sub">Nothing yet.</p>
          ) : (
            <dl className="desk-facts">
              {b.heard.map((h) => (
                <div key={h.label}>
                  <dt>{h.label}</dt>
                  <dd>
                    {h.value}
                    {h.quote && <q>{h.quote}</q>}
                  </dd>
                </div>
              ))}
              {b.heard.length === 0 && b.thisCall?.facts.map((f) => (
                <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>
              ))}
              {b.form.map((f) => (
                <div key={f.question}>
                  <dt>{f.question}</dt>
                  <dd>{f.answer} <span className="desk-facts__tag">On the form</span></dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section className="card desk-before">
          <div className="card__head"><h2>Before today</h2></div>
          <dl className="desk-facts">
            <div><dt>Enquired</dt><dd>{when(b.enquiredAt, true)} · {b.source}</dd></div>
            {b.owner && <div><dt>Owner</dt><dd>{b.owner}</dd></div>}
            {b.visit && (
              <div><dt>Site visit</dt><dd>{when(b.visit.at, true)}{b.visit.host ? ` · ${b.visit.host}` : ""}</dd></div>
            )}
            <div>
              <dt>Earlier calls</dt>
              <dd>
                {b.earlier.count === 0 ? "None" : b.earlier.count === 1 ? "1 call" : `${b.earlier.count} calls`}
                {b.earlier.last?.summary && (
                  <span className="desk-facts__note">Last, {when(b.earlier.last.at, true)}: {b.earlier.last.summary}</span>
                )}
              </dd>
            </div>
            {b.needsPerson && <div><dt>Flagged</dt><dd>{b.needsPerson}</dd></div>}
          </dl>
        </section>
      </div>
    </article>
  );
}

function ThisCall({ call, transfer }: { call: DeskCall | null; transfer: boolean }) {
  if (!call || (!call.summary && call.lastTurns.length === 0)) {
    return transfer ? (
      <p className="desk-wait"><span className="desk-wait__dot" aria-hidden /> The AI&apos;s notes on this call arrive a few seconds after it is put through.</p>
    ) : (
      <p className="sub">No AI call in the last half hour.</p>
    );
  }
  return (
    <>
      {call.goal && <p className="desk-call__goal">Sent to: {call.goal}</p>}
      {call.summary ? <p className="desk-call__summary">{call.summary}</p> : (
        <p className="desk-wait"><span className="desk-wait__dot" aria-hidden /> The summary is on its way.</p>
      )}
      {call.lastTurns.length > 0 && (
        <ol className="desk-turns" aria-label="The last things said" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
          {call.lastTurns.map((t, i) => (
            <li key={i} className={`desk-turn desk-turn--${t.who}`}>
              <span>{t.who === "ai" ? "AI" : "Buyer"}</span>
              <p>{t.text}</p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
