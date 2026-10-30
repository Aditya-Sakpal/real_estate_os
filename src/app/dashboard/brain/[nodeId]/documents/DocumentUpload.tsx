"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { beginDocumentUpload, finishDocumentUpload } from "@/app/actions/extract";
import { ArrowUpRight } from "@/components/icons";

type Kind = { key: string; label: string };

type Phase =
  | { at: "idle" }
  | { at: "hashing" }
  | { at: "sending"; pct: number }
  | { at: "checking" }
  | { at: "done"; ok: boolean; message: string };

const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp";

/** A picture's type as the browser says it, or read off the name when it says nothing. */
function typeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split(".").pop();
  return ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "";
}

async function hash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A PUT with progress, which fetch cannot report. */
function send(url: string, file: File, headers: Record<string, string>, onPct: (pct: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onPct(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.send(file);
  });
}

/**
 * The page's one primary action. The file goes straight to the store, never
 * through the console's own request, so a sixty-megabyte brochure uploads
 * the same as a one-page certificate; the same file twice is recognised by
 * its fingerprint before a byte is sent.
 */
export default function DocumentUpload({ nodeId, kinds }: { nodeId: string; kinds: Kind[] }) {
  const router = useRouter();
  const [kind, setKind] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  const picker = useRef<HTMLInputElement>(null);
  const busy = phase.at === "hashing" || phase.at === "sending" || phase.at === "checking";

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!kind || !file || busy) return;
    const type = typeOf(file);
    setPhase({ at: "hashing" });
    const sha256 = await hash(file).catch(() => "");
    const input = { nodeId, kind, name: file.name, type, size: file.size, sha256 };
    const begun = await beginDocumentUpload(input).catch(() => ({ state: "refused" as const, message: "Could not start the upload. Try again." }));
    if (begun.state === "refused") return setPhase({ at: "done", ok: false, message: begun.message });
    if (begun.state === "exists") {
      setPhase({ at: "done", ok: true, message: begun.message });
      return router.refresh();
    }
    setPhase({ at: "sending", pct: 0 });
    const sent = await send(begun.url, file, begun.headers, (pct) => setPhase({ at: "sending", pct }));
    if (!sent) return setPhase({ at: "done", ok: false, message: "The upload did not finish. Check the connection and try again." });
    setPhase({ at: "checking" });
    const done = await finishDocumentUpload(input).catch(() => ({ ok: false, message: "Could not file that document. Try again." }));
    setPhase({ at: "done", ok: !!done?.ok, message: done?.message ?? "" });
    if (done?.ok) {
      setFile(null);
      if (picker.current) picker.current.value = "";
      router.refresh();
    }
  }

  const label =
    phase.at === "hashing"
      ? "Preparing"
      : phase.at === "sending"
        ? `Uploading ${phase.pct}%`
        : phase.at === "checking"
          ? "Checking the file"
          : "Upload and read";

  return (
    <form className="docup" onSubmit={go} aria-busy={busy}>
      <label className="docup__field">
        <span>What it is</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} required disabled={busy} data-doc-kind="">
          <option value="" disabled>
            Choose
          </option>
          {kinds.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="docup__field docup__field--grow">
        <span>PDF or picture</span>
        <input
          ref={picker}
          type="file"
          accept={ACCEPT}
          required
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            if (phase.at === "done") setPhase({ at: "idle" });
          }}
          data-doc-file=""
        />
      </label>
      <button type="submit" className="btn btn--ink docup__go" disabled={busy || !kind || !file} data-doc-upload="">
        {label}
        {!busy && <ArrowUpRight size={13} />}
      </button>
      {phase.at === "sending" && (
        <div className="docup__bar" role="progressbar" aria-valuenow={phase.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
          <span style={{ transform: `scaleX(${phase.pct / 100})` }} />
        </div>
      )}
      {phase.at === "done" && phase.message && (
        <p className={`docup__note ${phase.ok ? "" : "docup__note--risk"}`} role={phase.ok ? "status" : "alert"} data-doc-note="">
          {phase.message}
        </p>
      )}
    </form>
  );
}
