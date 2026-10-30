"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Pause, Play } from "@/components/icons";
import { durationLabel } from "@/lib/call-rules";

const RATES = [1, 1.5, 2];

/** How many times a recording is asked for before the player gives up. */
const TRIES = 3;

/**
 * Where to play a recording from, asked for until there is an answer. A
 * recording in our bucket is played straight from its link, which the
 * browser keeps; one not copied there yet is fetched through our route as a
 * blob. An audio element pointed at an address gives up on the first failed
 * request and never says why, so both are asked for here, with retries.
 */
async function fetchRecording(url: string, signal: AbortSignal): Promise<{ src: string; blob: boolean } | "gone" | "pending" | null> {
  for (let i = 0; i < TRIES; i++) {
    try {
      const where = await fetch(`${url}${url.includes("?") ? "&" : "?"}link=1`, { signal, cache: "no-store" });
      // Not saved yet (a call just ended), or no longer anywhere: asking
      // again now changes nothing.
      if (where.status === 404) {
        const why = (await where.json().catch(() => ({}))) as { pending?: boolean };
        return why.pending ? "pending" : "gone";
      }
      if (where.ok) {
        const { url: from } = (await where.json()) as { url?: string };
        if (from && /^https:\/\//.test(from)) return { src: from, blob: false };
        const res = await fetch(from || url, { signal, cache: "no-store" });
        if (res.ok) {
          const b = await res.blob();
          if (b.size) return { src: URL.createObjectURL(b), blob: true };
        }
      }
    } catch (e) {
      if (signal.aborted) throw e;
    }
    if (i < TRIES - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
  return null;
}

/**
 * One call's recording, drawn as the call log draws it: the black play
 * circle, a plain track with a real range input over it so the keyboard can
 * seek, the time, and the speed. A plain track, not a waveform: Sarvam sends
 * the recording and no peaks. Nothing loads until somebody presses play, and
 * from that press the button turns to a spinner until the sound starts, so a
 * slow first load reads as loading rather than as a dead button.
 */
export function Recording({
  url,
  duration,
  className = "",
}: {
  url: string | null;
  duration: number;
  className?: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const blobUrl = useRef<string | null>(null);
  const loadedSrc = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [gone, setGone] = useState(false);
  const [pending, setPending] = useState(false);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  const off = !url || gone;
  const played = duration ? Math.min(1, time / duration) : 0;

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  // Leaving the panel stops a download still running and frees the bytes.
  useEffect(
    () => () => {
      request.current?.abort();
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    },
    [],
  );

  const start = (a: HTMLAudioElement) => {
    a.playbackRate = rate;
    // play() rejects when it is interrupted (paused again, or the panel
    // closed). That is not an error.
    a.play().catch((e: unknown) => {
      setLoading(false);
      if (!(e instanceof DOMException && e.name === "AbortError")) setFailed(true);
    });
  };

  const toggle = async () => {
    const a = audio.current;
    if (!a || !url) return;
    if (!a.paused) {
      a.pause();
      return;
    }
    if (loading) {
      // A second press while the file is still arriving cancels it.
      request.current?.abort();
      setLoading(false);
      return;
    }
    setFailed(false);
    setPending(false);
    if (loadedSrc.current) {
      start(a);
      return;
    }
    setLoading(true);
    const ctl = new AbortController();
    request.current = ctl;
    let got: Awaited<ReturnType<typeof fetchRecording>> = null;
    try {
      got = await fetchRecording(url, ctl.signal);
    } catch {
      return; // cancelled, or the panel closed
    } finally {
      if (request.current === ctl) request.current = null;
    }
    if (got === "pending") {
      setLoading(false);
      setPending(true);
      return;
    }
    if (got === "gone") {
      setLoading(false);
      setGone(true);
      return;
    }
    if (!got) {
      setLoading(false);
      setFailed(true);
      return;
    }
    if (got.blob) blobUrl.current = got.src;
    loadedSrc.current = got.src;
    a.src = got.src;
    a.currentTime = time;
    start(a);
  };

  const label = loading ? "Loading recording" : playing ? "Pause recording" : "Play recording";

  return (
    <>
      <div className={`ch-rec ${className}${off ? " is-off" : ""}`}>
        <button
          type="button"
          className="ch-rec__play"
          disabled={off}
          aria-label={label}
          aria-busy={loading}
          onClick={() => void toggle()}
        >
          {loading ? <span className="ch-rec__spin" aria-hidden /> : playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <div className="ch-rec__track">
          <span className="ch-rec__bar" aria-hidden>
            <span style={{ width: `${played * 100}%` }} />
          </span>
          <input
            type="range"
            className="ch-rec__seek"
            min={0}
            max={Math.max(1, Math.round(duration))}
            step={1}
            value={Math.round(time)}
            disabled={off}
            aria-label="Position in the recording"
            aria-valuetext={`${durationLabel(time)} of ${durationLabel(duration)}`}
            onChange={(e) => {
              const t = Number(e.target.value);
              setTime(t);
              if (audio.current) audio.current.currentTime = t;
            }}
          />
        </div>
        <span className="ch-rec__time tnum">
          {durationLabel(time)} / {durationLabel(duration)}
        </span>
        <button
          type="button"
          className="ch-rec__rate tnum"
          disabled={off}
          aria-label={`Playback speed, ${rate} times`}
          onClick={() => setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length])}
        >
          {rate}x
        </button>
        {url && !gone && (
          <a
            className="ch-rec__dl"
            href={`${url}?download=1`}
            download
            aria-label="Download recording"
            title="Download recording"
          >
            <Download size={15} />
          </a>
        )}
        {url && !gone && (
          <audio
            ref={audio}
            preload="none"
            onPlaying={() => {
              setLoading(false);
              setPlaying(true);
            }}
            onWaiting={() => setLoading(true)}
            onPause={() => {
              setLoading(false);
              setPlaying(false);
            }}
            onEnded={() => setPlaying(false)}
            onError={() => {
              if (!loadedSrc.current) return;
              // A link that stopped holding is asked for again on the next press.
              loadedSrc.current = null;
              setLoading(false);
              setPlaying(false);
              setFailed(true);
            }}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          />
        )}
      </div>
      {gone && <p className="ch-rec__none">This call's recording is no longer available.</p>}
      {pending && <p className="ch-rec__none">The recording is still being saved. Press play again in a minute.</p>}
      {failed && !gone && (
        <p className="ch-rec__none" role="alert">
          The recording could not be loaded. Try again.
        </p>
      )}
    </>
  );
}
