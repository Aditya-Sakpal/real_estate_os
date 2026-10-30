"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { broadcastPreviewAction, createBroadcastAction, type PreviewState } from "@/app/actions/broadcast";
import { PICKABLE_STAGES, showPaise } from "@/lib/broadcast-rules";
import { stageLabel } from "@/lib/lead-rules";
import "./broadcast.css";

/**
 * WhatsApp broadcast, as one more place a post can go from the Publish
 * dialog: the post's picture and one line of its copy, to the leads of its
 * tower who agreed to hear from the developer on WhatsApp.
 *
 * Ticked, it asks the server who that would reach and shows the count, the
 * cost and who is left out and why, in words, never a number. Choosing
 * stages or one language asks again. Somebody who may approve the spend
 * sends it with the dialog's one button; anybody else saves it for approval.
 */

export type BroadcastState = { on: boolean; ready: boolean; count: number; mayApprove: boolean };
export type BroadcastHandle = { send(): Promise<{ ok: boolean; message: string }> };

const VOICE_OPTIONS = [
  { value: "", label: "Each in their own language" },
  { value: "ENGLISH", label: "English only" },
  { value: "HINGLISH", label: "Hinglish only" },
  { value: "MARATHI", label: "Marathi only" },
];
const VOICE_WORDS: Record<string, string> = { ENGLISH: "English", HINGLISH: "Hinglish", MARATHI: "Marathi" };

export const BroadcastPanel = forwardRef<
  BroadcastHandle,
  { postId: string; disabled: boolean; unavailable: string | null; onState: (s: BroadcastState) => void }
>(function BroadcastPanel({ postId, disabled, unavailable, onState }, ref) {
  const [on, setOn] = useState(false);
  const [stages, setStages] = useState<string[]>([]);
  const [voice, setVoice] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [loading, setLoading] = useState(false);
  const asked = useRef(0);
  const panel = useRef<HTMLDivElement>(null);

  // Ticked, the panel with who it reaches comes into view: it opens below the fold.
  useEffect(() => {
    if (on) panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [on, preview]);

  useEffect(() => {
    if (!on) return;
    const n = ++asked.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await broadcastPreviewAction(postId, { stages, voice: voice || null }).catch(
        () => ({ ok: false, message: "Could not count who this reaches. Try again." }) as PreviewState,
      );
      if (n !== asked.current) return;
      setPreview(r);
      setLoading(false);
    }, 200);
    return () => clearTimeout(t);
  }, [on, stages, voice, postId]);

  const ok = preview && preview.ok ? preview : null;
  const ready = on && !loading && !!ok && ok.audience > 0 && !ok.tooMany;
  useEffect(() => {
    onState({ on, ready, count: ok?.audience ?? 0, mayApprove: ok?.mayApprove ?? false });
  }, [on, ready, ok, onState]);

  useImperativeHandle(ref, () => ({
    async send() {
      const r = await createBroadcastAction(postId, { stages, voice: voice || null, approve: ok?.mayApprove ?? false }).catch(() => ({
        ok: false as const,
        message: "The broadcast could not be saved. Try again.",
      }));
      return { ok: r.ok, message: r.message };
    },
  }));

  const off = !!unavailable;
  const toggle = (s: string) => setStages((xs) => (xs.includes(s) ? xs.filter((x) => x !== s) : [...xs, s]));
  const reasons = ok?.excluded ?? [];

  return (
    <div className="bc" data-broadcast>
      <label className={`pub-dest${off ? " pub-dest--off" : ""}${on ? " pub-dest--on" : ""}`} data-destination="WHATSAPP_BROADCAST">
        <input type="checkbox" checked={on} disabled={off || disabled} onChange={(e) => setOn(e.target.checked)} />
        <span className="pub-dest__id">
          <strong>WhatsApp broadcast</strong>
          <small>{unavailable ?? "To your leads who agreed to hear from you on WhatsApp"}</small>
        </span>
      </label>

      {on && (
        <div className="pub-ad bc-panel" aria-busy={loading} ref={panel}>
          <fieldset className="bc-stages" disabled={disabled}>
            <legend className="mv-label">Leads at</legend>
            <div className="bc-chips">
              <button type="button" className={`bc-chip${stages.length === 0 ? " bc-chip--on" : ""}`} onClick={() => setStages([])} aria-pressed={stages.length === 0}>
                Any open stage
              </button>
              {PICKABLE_STAGES.map((s) => (
                <button key={s} type="button" className={`bc-chip${stages.includes(s) ? " bc-chip--on" : ""}`} onClick={() => toggle(s)} aria-pressed={stages.includes(s)}>
                  {stageLabel(s)}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="mv-field bc-lang">
            <label className="mv-label" htmlFor={`bc-${postId}-lang`}>
              Language
            </label>
            <select id={`bc-${postId}-lang`} className="select-field" value={voice} onChange={(e) => setVoice(e.target.value)} disabled={disabled}>
              {VOICE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {preview && !preview.ok && (
            <div className="mv-warn mv-warn--risk" role="alert">
              {preview.message}
            </div>
          )}

          {ok && (
            <div className={`bc-count${loading ? " bc-count--stale" : ""}`} role="status" data-audience={ok.audience}>
              <p className="bc-count__n tnum">
                {ok.audience.toLocaleString("en-IN")} {ok.audience === 1 ? "person" : "people"}
                <span>about {showPaise(ok.billedPaise)} in messages</span>
              </p>
              {ok.audience > 0 && (
                <p className="bc-count__split tnum">
                  {(["ENGLISH", "HINGLISH", "MARATHI"] as const)
                    .filter((v) => ok.byVoice[v])
                    .map((v) => `${VOICE_WORDS[v]} ${Number(ok.byVoice[v]).toLocaleString("en-IN")}`)
                    .join(" · ")}
                </p>
              )}
              {reasons.length > 0 && (
                <ul className="bc-out">
                  {reasons.slice(0, 4).map((r) => (
                    <li key={r.code} data-excluded={r.code}>
                      <span className="tnum">{r.count.toLocaleString("en-IN")}</span> {r.words}
                    </li>
                  ))}
                  {reasons.length > 4 && <li className="bc-out__more">and {reasons.length - 4} more reasons</li>}
                </ul>
              )}
              {ok.tooMany && <p className="bc-note bc-note--risk">Too many for one broadcast. Choose fewer stages.</p>}
              <p className="bc-line">&ldquo;{ok.line}&rdquo;</p>
              {!ok.mayApprove && <p className="bc-note">Somebody who manages the budget approves it before it goes.</p>}
            </div>
          )}

          {!preview && (
            <p className="bc-count bc-count--stale" role="status">
              Counting who this reaches...
            </p>
          )}
        </div>
      )}
    </div>
  );
});
