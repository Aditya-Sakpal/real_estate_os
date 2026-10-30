"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { micProblem, recorderType, VOICE_MAX_SECONDS, VOICE_MIN_SECONDS } from "@/lib/ask-voice-rules";

/**
 * The microphone in Ask Jimmy's box. Tap to start, tap to finish; the clip
 * goes to `/dashboard/ask/voice` and the words come back for the person to
 * read before sending. The recorder stops itself at thirty seconds. Nothing
 * is kept on the phone: a clip that could not be written down is gone, and
 * the person speaks again or types.
 */

export type VoiceState =
  | { kind: "idle" }
  | { kind: "recording"; started: number }
  | { kind: "hearing" };

export function useVoice(opts: { onText: (text: string) => void; onProblem: (message: string) => void }) {
  const [state, setState] = useState<VoiceState>({ kind: "idle" });
  const [seconds, setSeconds] = useState(0);
  /** Only a browser that can record gets a microphone: a control that does nothing must not exist. */
  const [supported, setSupported] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const discard = useRef(false);
  const started = useRef(0);
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        window.isSecureContext &&
        typeof MediaRecorder !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia,
    );
  }, []);

  // The clock, and the stop at thirty seconds.
  useEffect(() => {
    if (state.kind !== "recording") return;
    const t = setInterval(() => {
      const s = (Date.now() - state.started) / 1000;
      setSeconds(s);
      if (s >= VOICE_MAX_SECONDS && rec.current?.state === "recording") rec.current.stop();
    }, 200);
    return () => clearInterval(t);
  }, [state]);

  // A recorder left running when the screen goes away lets the microphone go.
  useEffect(
    () => () => {
      discard.current = true;
      if (rec.current?.state === "recording") rec.current.stop();
    },
    [],
  );

  const hear = useCallback(async (blob: Blob, secs: number) => {
    setState({ kind: "hearing" });
    try {
      const res = await fetch("/dashboard/ask/voice", {
        method: "POST",
        headers: { "content-type": blob.type || "audio/webm", "x-voice-seconds": String(Math.ceil(secs)) },
        body: blob,
      });
      const body = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
      if (body?.text) cb.current.onText(body.text);
      else cb.current.onProblem(body?.error ?? "Your question could not be written down. Try again, or type it.");
    } catch {
      cb.current.onProblem("No connection. Type your question, or try again when the signal is back.");
    } finally {
      setState({ kind: "idle" });
    }
  }, []);

  const start = useCallback(async () => {
    if (state.kind !== "idle") return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      cb.current.onProblem(micProblem((e as { name?: string })?.name));
      return;
    }
    const type = recorderType((t) => MediaRecorder.isTypeSupported(t));
    let r: MediaRecorder;
    try {
      r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      cb.current.onProblem(micProblem(undefined));
      return;
    }
    chunks.current = [];
    discard.current = false;
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      rec.current = null;
      const secs = Math.min(VOICE_MAX_SECONDS, (Date.now() - started.current) / 1000);
      if (discard.current) {
        setState({ kind: "idle" });
        return;
      }
      if (secs < VOICE_MIN_SECONDS) {
        setState({ kind: "idle" });
        cb.current.onProblem("That was too short. Tap the microphone, speak, then tap again.");
        return;
      }
      const blob = new Blob(chunks.current, { type: (r.mimeType || type || "audio/webm").split(";")[0] });
      void hear(blob, secs);
    };
    rec.current = r;
    started.current = Date.now();
    r.start(500);
    setSeconds(0);
    setState({ kind: "recording", started: started.current });
  }, [state.kind, hear]);

  /** Finish, and have it written down. */
  const finish = useCallback(() => {
    if (rec.current?.state === "recording") rec.current.stop();
  }, []);

  /** Stop, and throw the clip away. */
  const cancel = useCallback(() => {
    discard.current = true;
    if (rec.current?.state === "recording") rec.current.stop();
  }, []);

  return { state, seconds, supported, start, finish, cancel };
}
