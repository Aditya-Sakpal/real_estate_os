/**
 * Checking a buyer in at the gallery: the pass their confirmation carries,
 * the scan the site team makes on their own phone, and whether it counts.
 * Pure and database-free, covered by `check:logic`; `checkin.ts` reads and
 * writes.
 *
 * Section 02's rules:
 *
 * - **Check-in is an authenticated act by the site team, never the buyer or
 *   a partner.** The buyer shows a pass; only somebody signed in, holding
 *   `visit:confirm` at the tower, can turn it into a check-in.
 * - **The pass proves nothing on its own.** It is the visit's id and an
 *   HMAC of the organisation and the visit, so a pass copied between
 *   tenants, or made up, is refused. It names nobody and carries no number.
 * - **It works in a basement.** A scan with no signal is kept on the phone
 *   with its own time and position and sent when the phone is back online;
 *   the time and the place are judged then, against when the visit was.
 * - **Within 150 m of the site.** A position further than that (less the
 *   phone's own stated accuracy) is refused. A phone with no position at
 *   all, which is usual underground, is accepted and the check-in says so.
 * - **Attribution freezes at check-in**: where the buyer came from is
 *   written once and never recomputed.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** How far from the site's pin a check-in may be made, in metres. */
export const GEOFENCE_M = 150;
/** A scan counts from this long before the visit's time... */
export const WINDOW_BEFORE_MIN = 120;
/** ...to this long after it. */
export const WINDOW_AFTER_MIN = 240;
/** A phone's clock may run this far ahead of ours before its time is doubted. */
export const CLOCK_SLACK_MIN = 5;
/** A scan kept offline longer than this is too old to be believed. */
export const OFFLINE_MAX_HOURS = 48;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pass's proof: sixteen hex characters of an HMAC of the organisation and the visit. */
export function passSig(secret: string, orgId: string, visitId: string): string {
  return createHmac("sha256", secret).update(`visit-pass:${orgId}:${visitId.toLowerCase()}`).digest("hex").slice(0, 16);
}

/** What the QR holds: a version, the visit, the proof. Short, so the code stays easy to read off a phone screen. */
export const passPayload = (visitId: string, sig: string) => `E1.${visitId.toLowerCase()}.${sig}`;

export function readPayload(raw: string | null | undefined): { visitId: string; sig: string } | null {
  const m = /^E1\.([0-9a-f-]{36})\.([0-9a-f]{16})$/i.exec((raw ?? "").trim());
  if (!m || !UUID.test(m[1])) return null;
  return { visitId: m[1].toLowerCase(), sig: m[2].toLowerCase() };
}

export function passValid(secret: string, orgId: string, visitId: string, sig: string): boolean {
  const want = Buffer.from(passSig(secret, orgId, visitId), "hex");
  const got = Buffer.from(sig, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Metres between two points on the earth. */
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export type ScanInput = {
  status: string;
  scheduledAt: string;
  /** When the phone scanned, by its own clock. */
  scannedAt: string;
  /** When the scan reached us. */
  receivedAt: string;
  position: { lat: number; lng: number; accuracy: number } | null;
  pin: { lat: number; lng: number } | null;
};

export type CheckinFlag = "NO_POSITION" | "NO_PIN" | "SENT_LATER";

export type ScanVerdict =
  | { ok: true; flags: CheckinFlag[]; distance: number | null }
  | { ok: false; code: "NOT_ON" | "ALREADY" | "WINDOW" | "CLOCK" | "FAR" | "STALE"; message: string };

/**
 * Whether a scan checks the buyer in: the visit is on (or was missed and
 * they came late), the scan's own time is inside the visit's window and not
 * in the future, and the phone was near the site when it scanned.
 */
export function judgeScan(i: ScanInput): ScanVerdict {
  if (i.status === "ON_SITE" || i.status === "VISITED") return { ok: false, code: "ALREADY", message: "Already checked in." };
  if (i.status !== "CONFIRMED" && i.status !== "NO_SHOW") return { ok: false, code: "NOT_ON", message: "This visit is not on." };
  const scanned = Date.parse(i.scannedAt);
  const received = Date.parse(i.receivedAt);
  if (!Number.isFinite(scanned) || scanned > received + CLOCK_SLACK_MIN * 60_000) {
    return { ok: false, code: "CLOCK", message: "The phone's clock is ahead. Set it right and scan again." };
  }
  if (received - scanned > OFFLINE_MAX_HOURS * 3_600_000) return { ok: false, code: "STALE", message: "This scan is too old to count." };
  const at = Date.parse(i.scheduledAt);
  if (scanned < at - WINDOW_BEFORE_MIN * 60_000 || scanned > at + WINDOW_AFTER_MIN * 60_000) {
    return { ok: false, code: "WINDOW", message: "This pass is for another time." };
  }
  const flags: CheckinFlag[] = [];
  if (received - scanned > 10 * 60_000) flags.push("SENT_LATER");
  if (!i.pin) {
    flags.push("NO_PIN");
    return { ok: true, flags, distance: null };
  }
  if (!i.position) {
    flags.push("NO_POSITION");
    return { ok: true, flags, distance: null };
  }
  const distance = metresBetween(i.position, i.pin);
  if (distance - Math.max(0, i.position.accuracy) > GEOFENCE_M) {
    return { ok: false, code: "FAR", message: `The phone was ${distance.toLocaleString("en-IN")} m from the site.` };
  }
  return { ok: true, flags, distance };
}

/** What the lead's own record says about where the buyer came from, frozen at check-in. */
export function attributionOf(l: {
  channel: string;
  source: string;
  lineage: Record<string, unknown>;
  publishTargetId: string | null;
  claim: { id: string; firm: string } | null;
}): Record<string, unknown> {
  return {
    channel: l.channel,
    source: l.source,
    lineage: l.lineage ?? {},
    publication: l.publishTargetId,
    partner: l.claim ? { registration: l.claim.id, firm: l.claim.firm } : null,
  };
}

/** A position a phone reported, or null when it is not one. */
export function readPosition(raw: { lat?: unknown; lng?: unknown; accuracy?: unknown } | null | undefined): { lat: number; lng: number; accuracy: number } | null {
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  const accuracy = Number(raw?.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(accuracy, 100_000) : 0 };
}

/** What a check-in's flags say, for the visit's row. */
export const FLAG_WORDS: Record<CheckinFlag, string> = {
  NO_POSITION: "no position",
  NO_PIN: "site has no pin",
  SENT_LATER: "sent later",
};
