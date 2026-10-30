"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "@/components/icons";

/** One sample plays at a time: pressing another stops the one before. */
let playing: { audio: HTMLAudioElement; stop: () => void } | null = null;

export function Listen({ src, label, tone = "light", text }: { src: string; label: string; tone?: "light" | "dark"; text?: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "failed">("idle");

  useEffect(() => () => {
    if (playing?.audio === audio.current) playing = null;
    audio.current?.pause();
  }, []);

  function toggle() {
    if (state === "playing") {
      audio.current?.pause();
      return;
    }
    if (!audio.current) {
      const a = new Audio(src);
      a.preload = "auto";
      a.addEventListener("playing", () => setState("playing"));
      a.addEventListener("pause", () => setState("idle"));
      a.addEventListener("ended", () => {
        a.currentTime = 0;
        setState("idle");
      });
      a.addEventListener("error", () => setState("failed"));
      audio.current = a;
    }
    const a = audio.current;
    if (playing && playing.audio !== a) playing.stop();
    playing = { audio: a, stop: () => a.pause() };
    setState("loading");
    a.play().catch(() => setState("failed"));
  }

  const on = state === "playing";
  return (
    <button
      type="button"
      className={`agt-listen agt-listen--${tone}${on ? " is-on" : ""}${text ? " agt-listen--text" : ""}`}
      onClick={toggle}
      disabled={state === "failed"}
      aria-label={on ? `Stop ${label}` : `Listen to ${label}`}
      aria-pressed={on}
      data-listen
    >
      <span className="agt-listen__icon">{on ? <Pause size={13} /> : <Play size={13} />}</span>
      {text && <span>{state === "failed" ? "Could not play" : on ? "Playing" : text}</span>}
      {on && (
        <span className="agt-listen__wave" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
    </button>
  );
}
