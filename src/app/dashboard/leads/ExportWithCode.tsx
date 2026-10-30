"use client";

import { useState, useTransition } from "react";
import { sendStepUpAction } from "@/app/actions/mask";

/**
 * Export, for somebody signed in by phone: a code to their own WhatsApp
 * first, for this one download, and then the file.
 */
export function ExportWithCode() {
  const [asking, setAsking] = useState<{ challengeId: string; message: string } | null>(null);
  const [code, setCode] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const ask = () =>
    start(async () => {
      setSaid(null);
      const r = await sendStepUpAction("lead:export", "");
      if (r.ok) setAsking({ challengeId: r.challengeId, message: r.message });
      else setSaid(r.message);
    });

  const download = () =>
    start(async () => {
      if (!asking) return;
      const body = new FormData();
      body.set("challengeId", asking.challengeId);
      body.set("code", code);
      const res = await fetch("/dashboard/leads/export", { method: "POST", body });
      if (!res.ok) {
        setSaid(await res.text());
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "leads.csv";
      a.click();
      URL.revokeObjectURL(url);
      setAsking(null);
      setCode("");
    });

  if (!asking) {
    return (
      <span className="stepup">
        <button type="button" className="btn btn--ghost" disabled={pending} onClick={ask}>
          {pending ? "Sending code" : "Export"}
        </button>
        {said && (
          <span className="sub" role="status">
            {said}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="stepup" role="group" aria-label="Code for this export">
      <span className="sub" role="status">
        {said ?? asking.message}
      </span>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        className="formfield__input tnum stepup__code"
        placeholder="123456"
        aria-label="Six-digit code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button type="button" className="btn btn--ink" disabled={pending || code.replace(/\s/g, "").length !== 6} onClick={download}>
        {pending ? "Checking" : "Download leads"}
      </button>
    </span>
  );
}
