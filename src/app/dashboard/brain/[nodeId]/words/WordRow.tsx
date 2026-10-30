"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { saveSayingAction } from "@/app/actions/pronounce";
import { useKeptSubmit, type FormResult } from "@/components/KeptForm";
import { Pause, Play } from "@/components/icons";
import type { WordState } from "@/lib/pronounce-rules";

export type WordView = {
  written: string;
  state: WordState;
  /** What the agent says for it: the spelling it is handed, when it has one. */
  said: string | null;
  /** The developer's own spelling, set at this place, which "Use the usual way" clears. */
  ownSaid: string | null;
  /** The place above this one whose spelling it takes. */
  saidAt: string | null;
  heard: string | null;
  sampled: boolean;
};

const PILL: Record<WordState, [string, string]> = {
  WRONG: ["pill--warn", "May sound wrong"],
  FAILED: ["pill--quiet", "Could not check"],
  UNCHECKED: ["pill--quiet", "Not checked yet"],
  RIGHT: ["pill--ok", "Likely right"],
};

/** One word plays at a time: starting another stops this one. */
let playing: { audio: HTMLAudioElement; stop: () => void } | null = null;

function SaveButtons({ own }: { own: boolean }) {
  const { pending, data } = useFormStatus();
  const clearing = pending && data?.get("clear");
  return (
    <>
      <button type="submit" className="btn btn--ink btn--sm" disabled={pending} data-save-word="">
        {pending && !clearing ? "Saving" : "Save"}
      </button>
      {own && (
        <button type="submit" name="clear" value="1" className="btn btn--ghost btn--sm" disabled={pending} data-clear-word="">
          {clearing ? "Saving" : "Use the usual way"}
        </button>
      )}
    </>
  );
}

export default function WordRow({ w, nodeId, mayEdit }: { w: WordView; nodeId: string; mayEdit: boolean }) {
  const router = useRouter();
  const [state, dispatch] = useActionState<FormResult, FormData>(saveSayingAction, null);
  const submit = useKeptSubmit(dispatch);
  const [editing, setEditing] = useState(false);
  const [sound, setSound] = useState<"idle" | "loading" | "playing">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const id = useId();
  const url = useRef<string | null>(null);

  useEffect(() => {
    if (state?.ok) setEditing(false);
  }, [state]);
  useEffect(() => {
    if (editing) box.current?.focus();
  }, [editing]);
  useEffect(
    () => () => {
      if (playing && url.current && playing.audio.src === url.current) playing.stop();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  // A word nobody has heard yet can be heard only by somebody who may check it.
  const canPlay = w.sampled || mayEdit;

  async function press() {
    if (sound === "playing") {
      playing?.stop();
      return;
    }
    if (sound === "loading") return;
    setProblem(null);
    playing?.stop();
    setSound("loading");
    const r = await fetch(`/dashboard/brain/${nodeId}/words/sample?w=${encodeURIComponent(w.written)}`).catch(() => null);
    if (!r?.ok) {
      setSound("idle");
      setProblem(r ? (await r.text()).slice(0, 200) || "Could not play it." : "No connection. Try again.");
      return;
    }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = URL.createObjectURL(await r.blob());
    const audio = new Audio(url.current);
    const stop = () => {
      audio.pause();
      audio.currentTime = 0;
      setSound("idle");
      if (playing?.audio === audio) playing = null;
    };
    audio.onended = stop;
    audio.onerror = () => {
      stop();
      setProblem("Could not play it.");
    };
    playing = { audio, stop };
    setSound("playing");
    await audio.play().catch(() => stop());
    // Hearing a word for the first time checked it: show what was found.
    if (!w.sampled) router.refresh();
  }

  const [tone, label] = PILL[w.state];
  return (
    <li className={`word${sound === "playing" ? " word--playing" : ""}`} data-word={w.written} data-state={w.state}>
      {canPlay ? (
        <button
          type="button"
          className="word__play"
          onClick={press}
          aria-label={sound === "playing" ? `Stop ${w.written}` : `Hear how the agent says ${w.written}`}
          aria-busy={sound === "loading"}
          data-play=""
        >
          {sound === "loading" ? <span className="word__spin" aria-hidden /> : sound === "playing" ? <Pause size={14} /> : <Play size={14} />}
        </button>
      ) : (
        <span className="word__play word__play--none" aria-hidden />
      )}

      <div className="word__body">
        <div className="word__top">
          <span className="word__name">{w.written}</span>
          <span className={`pill ${tone}`}>{label}</span>
        </div>
        {w.said && (
          <p className="word__line">
            Said as <span lang="hi" className="word__say">{w.said}</span>
            {w.saidAt && <span className="word__from"> · set for {w.saidAt}</span>}
          </p>
        )}
        {w.state === "WRONG" && w.heard && (
          <p className="word__line word__line--warn">
            Heard as <span lang="hi" className="word__say">{w.heard}</span>
          </p>
        )}
        {problem && (
          <p className="word__line word__line--risk" role="alert">
            {problem}
          </p>
        )}
        {state?.message && !editing && (
          <p className={`word__line ${state.ok ? "word__line--ok" : "word__line--risk"}`} role={state.ok ? "status" : "alert"}>
            {state.message}
          </p>
        )}

        {editing && (
          <form className="word__fix" action={dispatch} onSubmit={submit}>
            <input type="hidden" name="nodeId" value={nodeId} />
            <input type="hidden" name="written" value={w.written} />
            <label htmlFor={id}>How it is said</label>
            <div className="word__fixrow">
              <input
                ref={box}
                id={id}
                name="said"
                type="text"
                maxLength={80}
                defaultValue={w.ownSaid ?? ""}
                placeholder="e.g. वाकड or Waa-kad"
                autoComplete="off"
                aria-describedby={state && !state.ok ? `${id}-err` : undefined}
              />
              <SaveButtons own={!!w.ownSaid} />
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
            {state && !state.ok && (
              <p id={`${id}-err`} className="word__line word__line--risk" role="alert">
                {state.message}
              </p>
            )}
          </form>
        )}
      </div>

      {mayEdit && !editing && (
        <button type="button" className="btn btn--ghost btn--sm word__change" onClick={() => setEditing(true)} data-change-word="">
          {w.said ? "Change" : "Write how it's said"}
        </button>
      )}
    </li>
  );
}
