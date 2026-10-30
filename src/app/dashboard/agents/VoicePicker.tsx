"use client";

import { useState, useTransition } from "react";
import { setAgentVoiceAction } from "@/app/actions/agents";
import { ChevronDown } from "@/components/icons";
import { Listen } from "./Listen";

export type VoiceOption = {
  key: string;
  name: string;
  /** The voice we steer people to; its option reads "Advait (Recommended)". */
  recommended?: boolean;
  /** Why it cannot be picked here ("Scale"), or null when it can. */
  locked: string | null;
  sample: string | null;
};

/**
 * An agent's voice: a choice of the voices the plan opens (the others shown
 * and disabled, with the plan that opens them), and play beside it for the
 * one chosen. Saved the moment it changes; a refusal puts the old one back.
 */
export function VoicePicker({
  projectId,
  job,
  agent,
  options,
  value,
  canEdit,
  tone = "light",
}: {
  projectId: string | null;
  job: string;
  agent: string;
  options: VoiceOption[];
  value: string;
  canEdit: boolean;
  tone?: "light" | "dark";
}) {
  const [voice, setVoice] = useState(value);
  const [note, setNote] = useState<{ kind: "saved" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const chosen = options.find((o) => o.key === voice) ?? options[0];

  function pick(next: string) {
    if (!projectId || next === voice) return;
    const before = voice;
    setVoice(next);
    setNote(null);
    start(async () => {
      const r = await setAgentVoiceAction({ projectId, job, voice: next });
      if (r.ok) setNote({ kind: "saved", text: "Saved" });
      else {
        setVoice(before);
        setNote({ kind: "error", text: r.message });
      }
    });
  }

  const editable = canEdit && !!projectId && options.some((o) => o.key !== voice && !o.locked);
  return (
    <div className={`agt-pick agt-pick--${tone}`} data-voice-picker={job}>
      <div className="agt-pick__row">
        {editable ? (
          <label className="agt-pick__select">
            <span className="sr-only">Voice for the {agent}</span>
            <select value={voice} autoComplete="off" onChange={(e) => pick(e.target.value)} disabled={pending} data-voice-select>
              {options.map((o) => {
                const name = o.recommended ? `${o.name} (Recommended)` : o.name;
                return (
                  <option key={o.key} value={o.key} disabled={!!o.locked}>
                    {o.locked ? `${name} · ${o.locked}` : name}
                  </option>
                );
              })}
            </select>
            <ChevronDown size={12} />
          </label>
        ) : (
          <span className="agt-pick__fixed">{chosen?.recommended ? `${chosen.name} (Recommended)` : chosen?.name}</span>
        )}
        {chosen?.sample && <Listen key={chosen.sample} src={chosen.sample} label={`the ${agent} in ${chosen.name}'s voice`} tone={tone} />}
      </div>
      {(pending || note) && (
        <span className={`agt-pick__note${note?.kind === "error" ? " is-error" : ""}`} role="status">
          {pending ? "Saving" : note?.text}
        </span>
      )}
    </div>
  );
}
