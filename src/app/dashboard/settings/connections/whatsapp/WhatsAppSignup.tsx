"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { finishWhatsAppSignup } from "@/app/actions/whatsapp";
import { readSignupMessage, signupOptions, type SignupHint } from "@/lib/wa-rules";
import { ArrowUpRight } from "@/components/icons";

/**
 * The button that opens Meta's own sign-in, where the developer picks their
 * WhatsApp account and number and agrees to let us send for them.
 *
 * Meta hands back a code that lives thirty seconds, so it goes to the server
 * the moment it arrives. The account and number the person picked arrive on
 * the page's message bus beside it; they travel as a hint and the server
 * connects only what the code's token can reach.
 *
 * The label changes the instant it is pressed, before Meta's script has even
 * loaded, because a pop-up that takes a second to open reads as a dead
 * button.
 */

type FBLoginResponse = { authResponse?: { code?: string } | null; status?: string };
type FBStatic = {
  init(opts: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(cb: (r: FBLoginResponse) => void, opts: Record<string, unknown>): void;
};

declare global {
  interface Window {
    FB?: FBStatic;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FBStatic> | null = null;

function loadSdk(appId: string, version: string): Promise<FBStatic> {
  if (window.FB) return Promise.resolve(window.FB);
  if (loading) return loading;
  loading = new Promise<FBStatic>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      loading = null;
      reject(new Error("sdk"));
    };
    document.body.appendChild(s);
  });
  return loading;
}

type Phase = "idle" | "opening" | "connecting";

export function WhatsAppSignup({
  appId,
  configId,
  solutionId,
  version,
  keepAppNumber,
  label,
  tone = "ink",
  unavailable,
}: {
  appId: string | null;
  configId: string | null;
  solutionId: string | null;
  version: string;
  keepAppNumber: boolean;
  label: string;
  tone?: "ink" | "light";
  /** Why connecting cannot start on this deployment, said beside a disabled button. */
  unavailable?: string | null;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const hint = useRef<SignupHint | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = readSignupMessage(e.origin, e.data);
      if (!m) return;
      if (m.kind === "finished") hint.current = m.hint;
      else setProblem("The WhatsApp sign-in was closed before it finished. Nothing was connected.");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const ready = !!appId && !!configId && !unavailable;

  const open = () => {
    if (!ready || phase !== "idle") return;
    setProblem(null);
    setPhase("opening");
    loadSdk(appId!, version)
      .then((FB) => {
        // Meta's SDK refuses an async callback, so this one is plain and
        // hands the code on without waiting for anything.
        FB.login(
          (r) => {
            const code = r?.authResponse?.code;
            if (!code) {
              setPhase("idle");
              setProblem((p) => p ?? "The WhatsApp sign-in was closed before it finished. Nothing was connected.");
              return;
            }
            setPhase("connecting");
            startTransition(async () => {
              await finishWhatsAppSignup({ code, hint: hint.current });
              setPhase("idle");
            });
          },
          signupOptions({ configId: configId!, keepAppNumber, solutionId }),
        );
      })
      .catch(() => {
        setPhase("idle");
        setProblem("Meta's sign-in did not load. Check the connection and try again.");
      });
  };

  const text = phase === "opening" ? "Opening Meta..." : phase === "connecting" ? "Connecting..." : label;

  return (
    <span className="wa-signup">
      <button
        type="button"
        className={`btn ${tone === "light" ? "btn--light btn--sm" : "btn--ink"}`}
        onClick={open}
        disabled={!ready}
        aria-busy={phase !== "idle"}
        aria-describedby={!ready && unavailable ? "wa-unavailable" : undefined}
        data-whatsapp-signup={keepAppNumber ? "app" : "new"}
      >
        {text}
        {phase === "idle" && <ArrowUpRight size={14} />}
      </button>
      {!ready && unavailable && (
        <span id="wa-unavailable" className="wa-signup__why">
          {unavailable}
        </span>
      )}
      {problem && (
        <span className="wa-signup__why wa-signup__why--risk" role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}
