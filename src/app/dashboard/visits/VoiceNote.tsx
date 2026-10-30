"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { visitNoteAction } from "@/app/actions/leads";
import type { NoteView } from "@/lib/visit-notes";
import { Alert, Clock, Stop } from "@/components/icons";

/**
 * The host's voice note, recorded on their phone after a visit. It runs 45
 * to 90 seconds, is kept on the phone if there is no signal and sent when
 * there is, and comes back as a draft the host confirms. Nothing here
 * records the visit: the draft only fills in the form.
 */

const MIN_S = 45;
const MAX_S = 90;
const POLL_MS = 4000;
const POLL_FOR_MS = 4 * 60_000;
const TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];

type Phase =
  | { kind: "idle" }
  | { kind: "recording"; started: number }
  | { kind: "sending" }
  | { kind: "kept" }
  | { kind: "reading" }
  | { kind: "failed"; message: string };

// --- this phone's queue of notes that did not go ----------------------------

type Kept = { id: string; visitId: string; blob: Blob; durationMs: number };

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("salesdesk-notes", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("queue", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function keep(k: Kept): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").put(k);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

async function keptFor(visitId: string): Promise<Kept[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const req = db.transaction("queue", "readonly").objectStore("queue").getAll();
    req.onsuccess = () => resolve((req.result as Kept[]).filter((k) => k.visitId === visitId));
    req.onerror = () => resolve([]);
  });
}

async function drop(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Send one recording. Null when there was no signal: it stays on the phone. */
async function upload(visitId: string, blob: Blob, durationMs: number): Promise<{ ok: boolean; message?: string } | null> {
  const form = new FormData();
  form.append("visitId", visitId);
  form.append("durationMs", String(Math.round(durationMs)));
  form.append("note", blob, "note");
  try {
    const res = await fetch("/dashboard/visits/notes", { method: "POST", body: form });
    if (res.status >= 500) return null;
    return (await res.json().catch(() => ({ ok: false, message: "The note was not accepted." }))) as { ok: boolean; message?: string };
  } catch {
    return null;
  }
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function VoiceNote({
  visitId,
  held,
  onDraft,
  label,
}: {
  visitId: string;
  held: boolean;
  onDraft: (note: NoteView) => void;
  /** What the button says; a note before the visit says so. */
  label?: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [now, setNow] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const cancelled = useRef(false);

  /** Wait for the note to be read, then hand the draft up. */
  const follow = useCallback(async () => {
    setPhase({ kind: "reading" });
    const until = Date.now() + POLL_FOR_MS;
    while (Date.now() < until) {
      const n = await visitNoteAction({ visitId }).catch(() => null);
      if (n?.state === "DRAFTED") {
        setPhase({ kind: "idle" });
        onDraft(n);
        return;
      }
      if (n && (n.state === "FAILED" || n.state === "REFUSED")) {
        setPhase({ kind: "failed", message: n.reason ?? "The note could not be read. Record how it went by hand." });
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    setPhase({ kind: "failed", message: "The note is taking long to read. Check back in a few minutes." });
  }, [visitId, onDraft]);

  const send = useCallback(async (blob: Blob, durationMs: number, keptId?: string) => {
    setPhase({ kind: "sending" });
    const r = await upload(visitId, blob, durationMs);
    if (r === null) {
      if (!keptId) await keep({ id: `${visitId}:${Date.now()}`, visitId, blob, durationMs });
      setPhase({ kind: "kept" });
      return;
    }
    if (keptId) await drop(keptId);
    if (!r.ok) {
      setPhase({ kind: "failed", message: r.message ?? "The note was not accepted." });
      return;
    }
    await follow();
  }, [visitId, follow]);

  // A note kept on this phone goes as soon as there is a signal.
  useEffect(() => {
    let live = true;
    const flush = async () => {
      const kept = await keptFor(visitId);
      if (live && kept[0]) await send(kept[0].blob, kept[0].durationMs, kept[0].id);
    };
    flush();
    window.addEventListener("online", flush);
    return () => {
      live = false;
      window.removeEventListener("online", flush);
    };
  }, [visitId, send]);

  useEffect(() => {
    if (phase.kind !== "recording") return;
    const t = setInterval(() => {
      const s = (Date.now() - phase.started) / 1000;
      setNow(s);
      if (s >= MAX_S) rec.current?.stop();
    }, 250);
    return () => clearInterval(t);
  }, [phase]);

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase({ kind: "failed", message: "Allow the microphone for this site in your browser settings." });
      return;
    }
    const mimeType = TYPES.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks.current = [];
    cancelled.current = false;
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const ms = Date.now() - started.current;
      if (cancelled.current) {
        setPhase({ kind: "idle" });
        return;
      }
      const blob = new Blob(chunks.current, { type: (r.mimeType || "audio/webm").split(";")[0] });
      send(blob, Math.min(ms, MAX_S * 1000));
    };
    rec.current = r;
    started.current = Date.now();
    r.start(1000);
    setNow(0);
    setPhase({ kind: "recording", started: started.current });
  };

  if (phase.kind === "recording") {
    const left = Math.max(0, Math.ceil(MIN_S - now));
    return (
      <div className="sv-voice is-live" role="group" aria-label="Voice note">
        <span className="sv-voice__dot" aria-hidden />
        <span className="sv-voice__time tnum" aria-live="off">
          {clock(now)} <span>/ {clock(MAX_S)}</span>
        </span>
        <span className="sv-voice__hint">{left > 0 ? `${left} s more` : "Stop when done"}</span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            cancelled.current = true;
            rec.current?.stop();
          }}
        >
          Discard
        </button>
        <button type="button" className="btn btn--ink" disabled={left > 0} onClick={() => rec.current?.stop()}>
          <Stop size={12} />
          Stop and send
        </button>
      </div>
    );
  }

  if (phase.kind === "sending" || phase.kind === "reading") {
    return (
      <p className="sv-voice sv-voice--wait" role="status">
        <Clock size={14} />
        {phase.kind === "sending" ? "Sending the note" : "Reading the note. The form fills in by itself."}
      </p>
    );
  }

  return (
    <div className="sv-voice">
      {phase.kind === "kept" && (
        <p className="sv-voice__say" role="status">
          <Clock size={14} />
          Saved on this phone. It sends when the signal is back.
        </p>
      )}
      {phase.kind === "failed" && (
        <p className="sv-voice__say is-bad" role="alert">
          <Alert size={14} />
          {phase.message}
        </p>
      )}
      {phase.kind !== "kept" && (
        <button type="button" className="btn btn--ghost" disabled={held} onClick={start}>
          <span className="sv-voice__mic" aria-hidden />
          {label ?? "Record a voice note"}
        </button>
      )}
    </div>
  );
}
