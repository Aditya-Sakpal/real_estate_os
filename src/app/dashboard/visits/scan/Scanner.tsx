"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "@/components/shell/PageHead";
import { Alert, Check, Clock } from "@/components/icons";
import type { TodayPass } from "@/lib/checkin";

/**
 * The gate scanner. Every scan is written to this phone's own queue first
 * and then sent, so a scan made in a basement is never lost: it waits, with
 * the time and position it was made at, until the signal is back. The server
 * judges each one when it arrives; the phone only reads the code.
 */

type Pos = { lat: number; lng: number; accuracy: number };
type Queued = { id: string; owner: string; payload: string; scannedAt: string; position: Pos | null };
type Answer = { id: string; ok: boolean; code?: string; message?: string; buyer?: string; at?: string; flags?: string[] };

type Result =
  | { kind: "in"; buyer: string; time: string; flags: string[] }
  | { kind: "saved"; buyer: string | null; time: string | null }
  | { kind: "no"; message: string };

type Camera = "starting" | "on" | "denied" | "none";

const PASS = /^E1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{16}$/i;
const FLAG_WORDS: Record<string, string> = { NO_POSITION: "No position", NO_PIN: "Site has no pin", SENT_LATER: "Sent later" };
const BATCH = 20;
/** A position older than this is not the one the scan was made at. */
const FIX_MAX_AGE_MS = 120_000;

// --- this phone's queue ---------------------------------------------------

const DB_NAME = "salesdesk-scan";
const STORE = "queue";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Kept in memory when the browser gives this page no storage (a private window). */
const memory = new Map<string, Queued>();

async function keep(scan: Queued): Promise<boolean> {
  const db = await openDb();
  if (!db) {
    memory.set(scan.id, scan);
    return false;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(scan);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => {
      memory.set(scan.id, scan);
      resolve(false);
    };
  });
}

async function waiting(owner: string): Promise<Queued[]> {
  const db = await openDb();
  const kept = db
    ? await new Promise<Queued[]>((resolve) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result as Queued[]);
        req.onerror = () => resolve([]);
      })
    : [];
  return [...kept, ...memory.values()].filter((s) => s.owner === owner).sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
}

async function forget(ids: string[]): Promise<void> {
  for (const id of ids) memory.delete(id);
  const db = await openDb();
  if (!db || !ids.length) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const id of ids) tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function timeWord(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).toLowerCase();
}

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h >= 12 ? "pm" : "am"}`;
}

// --- the screen -----------------------------------------------------------

export function Scanner({ owner, today }: { owner: string; today: TodayPass[] }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const reading = useRef(true);
  const fix = useRef<(Pos & { t: number }) | null>(null);
  const sending = useRef(false);

  const [camera, setCamera] = useState<Camera>("starting");
  const [result, setResult] = useState<Result | null>(null);
  const [queued, setQueued] = useState(0);
  const [online, setOnline] = useState(true);
  const [status, setStatus] = useState<Record<string, string>>(() => Object.fromEntries(today.map((p) => [p.visitId, p.status])));
  const [later, setLater] = useState<{ id: string; line: string; ok: boolean }[]>([]);

  const byVisit = useCallback((payload: string) => {
    const m = PASS.exec(payload.trim());
    return m ? (today.find((p) => p.visitId === m[1].toLowerCase()) ?? null) : null;
  }, [today]);

  /** Sends what is waiting, oldest first; anything the server did not answer stays. */
  const send = useCallback(async (): Promise<Answer[]> => {
    if (sending.current) return [];
    sending.current = true;
    try {
      const scans = await waiting(owner);
      setQueued(scans.length);
      if (!scans.length) return [];
      const res = await fetch("/dashboard/visits/scan/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scans: scans.slice(0, BATCH).map(({ owner: _o, ...s }) => s) }),
      });
      if (!res.ok) return [];
      const { results } = (await res.json()) as { results: Answer[] };
      await forget(results.map((r) => r.id));
      setQueued((await waiting(owner)).length);
      setStatus((s) => {
        const next = { ...s };
        for (const r of results) {
          const scan = scans.find((q) => q.id === r.id);
          const m = scan ? PASS.exec(scan.payload) : null;
          if (r.ok && m) next[m[1].toLowerCase()] = "ON_SITE";
        }
        return next;
      });
      return results;
    } catch {
      return [];
    } finally {
      sending.current = false;
    }
  }, [owner]);

  /** A code read off the camera: kept on the phone, then sent. */
  const onCode = useCallback(async (payload: string) => {
    reading.current = false;
    const known = byVisit(payload);
    if (!PASS.test(payload.trim())) {
      setResult({ kind: "no", message: "This is not a visit pass." });
      return;
    }
    const f = fix.current && Date.now() - fix.current.t < FIX_MAX_AGE_MS ? { lat: fix.current.lat, lng: fix.current.lng, accuracy: fix.current.accuracy } : null;
    const scan: Queued = { id: newId(), owner, payload: payload.trim(), scannedAt: new Date().toISOString(), position: f };
    await keep(scan);
    const answers = await send();
    const mine = answers.find((a) => a.id === scan.id);
    if (!mine) {
      setResult({ kind: "saved", buyer: known?.buyer ?? null, time: known ? clock(known.time) : null });
      return;
    }
    // Answers for scans made earlier, offline, are shown beside this one.
    const earlier = answers.filter((a) => a.id !== scan.id);
    if (earlier.length) {
      setLater((l) => [...earlier.map((a) => ({ id: a.id, ok: a.ok, line: a.ok ? `${a.buyer} checked in` : (a.message ?? "Not checked in") })), ...l].slice(0, 8));
    }
    if (mine.ok) {
      navigator.vibrate?.(40);
      setResult({ kind: "in", buyer: mine.buyer ?? "", time: mine.at ? timeWord(mine.at) : "", flags: mine.flags ?? [] });
    } else {
      setResult({ kind: "no", message: mine.message ?? "Not checked in." });
    }
  }, [byVisit, owner, send]);

  // The camera, and the read loop over its frames.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    type Detector = { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> };
    let detector: Detector | null = null;
    let jsQR: ((d: Uint8ClampedArray, w: number, h: number, o?: object) => { data: string } | null) | null = null;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera("none");
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        const v = video.current!;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        setCamera("on");
      } catch (e) {
        setCamera((e as Error)?.name === "NotAllowedError" ? "denied" : "none");
        return;
      }
      const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      if (BD) detector = new BD({ formats: ["qr_code"] });
      else jsQR = (await import("jsqr")).default as never;
      loop();
    }

    async function loop() {
      if (stopped) return;
      const v = video.current;
      if (reading.current && v && v.readyState >= 2) {
        try {
          let code: string | null = null;
          if (detector) {
            code = (await detector.detect(v))[0]?.rawValue ?? null;
          } else if (jsQR && canvas.current) {
            const w = 480;
            const h = Math.round((v.videoHeight / v.videoWidth) * w) || 360;
            const c = canvas.current;
            c.width = w;
            c.height = h;
            const g = c.getContext("2d", { willReadFrequently: true });
            if (g) {
              g.drawImage(v, 0, 0, w, h);
              code = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data ?? null;
            }
          }
          if (code && reading.current) await onCode(code);
        } catch {
          /* a frame that could not be read is the next frame's problem */
        }
      }
      timer = setTimeout(loop, 160);
    }

    start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, [onCode]);

  // Where the phone is, kept fresh, so a scan carries the position it was made at.
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => (fix.current = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, t: Date.now() }),
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Anything left from before is sent as soon as there is a signal.
  useEffect(() => {
    setOnline(navigator.onLine);
    const flushLater = async () => {
      const answers = await send();
      if (answers.length) setLater((l) => [...answers.map((a) => ({ id: a.id, ok: a.ok, line: a.ok ? `${a.buyer} checked in` : (a.message ?? "Not checked in") })), ...l].slice(0, 8));
    };
    const up = () => {
      setOnline(true);
      flushLater();
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    flushLater();
    const every = setInterval(flushLater, 30_000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      clearInterval(every);
    };
  }, [send]);

  // The page itself opens with no signal once it has been opened with one.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/dashboard/visits/scan/sw.js", { scope: "/dashboard/visits/scan" }).catch(() => undefined);
  }, []);

  const next = () => {
    setResult(null);
    reading.current = true;
  };

  const expected = today.filter((p) => status[p.visitId] !== "ON_SITE");
  const inside = today.length - expected.length;

  return (
    <div className="sc">
      <PageHead
        back={{ label: "Site visits", href: "/dashboard/visits" }}
        title={
          <>
            Scan a <span className="em">pass</span>
          </>
        }
        meta={
          <>
            {!online && (
              <span className="pill pill--warn" style={{ marginRight: 8 }}>
                <span className="pill__dot" />
                No signal
              </span>
            )}
            {queued > 0
              ? `${queued} ${queued === 1 ? "scan" : "scans"} waiting to send`
              : today.length
                ? `${inside} of ${today.length} in today`
                : "No visits today at your sites"}
          </>
        }
      />

      <div className="sc-body">
      <section className="sc-cam" aria-label="Camera">
        <video ref={video} className="sc-cam__video" playsInline muted aria-hidden />
        <canvas ref={canvas} hidden />
        {camera === "on" && !result && <span className="sc-cam__frame" aria-hidden />}
        {camera === "starting" && <p className="sc-cam__say">Opening the camera</p>}
        {camera === "denied" && <p className="sc-cam__say">Allow the camera for this site in your browser settings, then reload.</p>}
        {camera === "none" && <p className="sc-cam__say">This phone has no camera the browser can use. Check the buyer in from Site visits.</p>}

        {result && (
          <div className={`sc-out sc-out--${result.kind}`} role="status" aria-live="assertive">
            <span className="sc-out__mark" aria-hidden>
              {result.kind === "in" ? <Check size={26} /> : result.kind === "saved" ? <Clock size={24} /> : <Alert size={24} />}
            </span>
            {result.kind === "in" && (
              <>
                <p className="sc-out__head">Checked in</p>
                <p className="sc-out__who">
                  {result.buyer}
                  {result.time && <span> · {result.time}</span>}
                </p>
                {result.flags.length > 0 && (
                  <p className="sc-out__flags">
                    {result.flags.map((f) => (
                      <span key={f} className="pill pill--quiet">
                        {FLAG_WORDS[f] ?? f}
                      </span>
                    ))}
                  </p>
                )}
              </>
            )}
            {result.kind === "saved" && (
              <>
                <p className="sc-out__head">Saved on this phone</p>
                <p className="sc-out__who">
                  {result.buyer ? `${result.buyer}${result.time ? ` · ${result.time}` : ""}` : "Sends when the signal is back"}
                </p>
                {result.buyer && <p className="sc-out__note">Sends when the signal is back</p>}
              </>
            )}
            {result.kind === "no" && (
              <>
                <p className="sc-out__head">Not checked in</p>
                <p className="sc-out__who">{result.message}</p>
              </>
            )}
            <button type="button" className="btn btn--light sc-out__next" onClick={next} autoFocus>
              Scan next
            </button>
          </div>
        )}
      </section>

      {(later.length > 0 || today.length > 0) && (
      <div className="sc-side">
      {later.length > 0 && (
        <section className="card sc-later" aria-label="Sent from this phone">
          <h2 className="sc-h">Sent from this phone</h2>
          <ul>
            {later.map((l) => (
              <li key={l.id} className={l.ok ? "is-ok" : "is-no"}>
                {l.ok ? <Check size={14} /> : <Alert size={14} />}
                {l.line}
              </li>
            ))}
          </ul>
        </section>
      )}

      {today.length > 0 && (
        <section className="card sc-today" aria-label="Today">
          <h2 className="sc-h">Today</h2>
          <ul>
            {today.map((p) => {
              const s = status[p.visitId];
              return (
                <li key={p.visitId}>
                  <span className="sc-today__time tnum">{clock(p.time)}</span>
                  <span className="sc-today__who">
                    {p.buyer}
                    <span>{p.place}</span>
                  </span>
                  {s === "ON_SITE" ? (
                    <span className="pill pill--ok">In</span>
                  ) : s === "NO_SHOW" ? (
                    <span className="pill pill--warn">Missed</span>
                  ) : (
                    <span className="pill pill--quiet">Expected</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      </div>
      )}
      </div>
    </div>
  );
}
