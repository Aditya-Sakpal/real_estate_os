/**
 * The DND register (TRAI's NCPR) and a call: the rules, with no database.
 *
 * A call inside `ENQUIRY_DAYS` of the buyer's own enquiry answers it, and is
 * not scrubbed. Any other call, the re-engager's or a person's a month on, is
 * promotion, and a number on the register may take it only with the buyer's
 * consent registered with the operator. Only a definite answer refuses: a
 * number nobody has checked is not a number on the register, and the
 * operator scrubs at dial time on a regulated series whatever we know.
 *
 * WhatsApp is not scrubbed. TRAI keeps app messaging out of the register;
 * a marketing message is gated on the buyer's own opt-in instead.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { ENQUIRY_DAYS } from "./calling-rules.ts";

export type DndStatus = "DND" | "CLEAR" | "CONSENT_REGISTERED";
export type DndSource = "LOOKUP" | "OPERATOR" | "PERSON";

export type DndRow = {
  status: DndStatus;
  source: DndSource;
  checkedAt: string;
  expiresAt: string | null;
};

/** A lookup's answer stands this long: a preference is enforced within a day of being set. */
export const LOOKUP_TTL_HOURS = 24;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * When an answer runs out. A lookup's does, and is asked again. What the
 * operator refused and what a person recorded stand until a newer answer
 * replaces them: nothing else would ever bring them back to mind.
 */
export function expiresFor(source: DndSource, checkedAtIso: string): string | null {
  return source === "LOOKUP" ? new Date(Date.parse(checkedAtIso) + LOOKUP_TTL_HOURS * HOUR_MS).toISOString() : null;
}

/**
 * The answer that stands for a number now: the newest, while it lasts. An
 * expired newest answer is no answer, never a cue to fall back to an older
 * one it replaced.
 */
export function standingDnd(rows: readonly DndRow[], nowIso: string): DndRow | null {
  let newest: DndRow | null = null;
  for (const r of rows) if (!newest || Date.parse(r.checkedAt) > Date.parse(newest.checkedAt)) newest = r;
  if (!newest) return null;
  if (newest.expiresAt && Date.parse(newest.expiresAt) <= Date.parse(nowIso)) return null;
  return newest;
}

/** Whether a call now answers the buyer's own enquiry. */
export function inEnquiryWindow(enquiredAtIso: string, nowIso: string): boolean {
  const age = Date.parse(nowIso) - Date.parse(enquiredAtIso);
  // A few minutes of clock difference must not make a fresh lead look like the future.
  return age >= -5 * 60_000 && age <= ENQUIRY_DAYS * DAY_MS;
}

export const DND_MESSAGE =
  `This number is on the DND register and the enquiry is over ${ENQUIRY_DAYS} days old. ` +
  "It can be called once the buyer's consent is registered with the operator.";

export type DndVerdict =
  | { ok: true; basis: "ENQUIRY" | "CLEAR" | "CONSENT_REGISTERED" | "UNKNOWN" }
  | { ok: false; code: "DND"; message: string };

/**
 * Whether the register allows this call. `UNKNOWN` is allowed and is the
 * one answer worth a lookup, when there is something to look it up with.
 */
export function dndVerdict(o: { standing: DndRow | null; enquiredAt: string; nowIso: string }): DndVerdict {
  if (inEnquiryWindow(o.enquiredAt, o.nowIso)) return { ok: true, basis: "ENQUIRY" };
  switch (o.standing?.status) {
    case "DND":
      return { ok: false, code: "DND", message: DND_MESSAGE };
    case "CONSENT_REGISTERED":
      return { ok: true, basis: "CONSENT_REGISTERED" };
    case "CLEAR":
      return { ok: true, basis: "CLEAR" };
    default:
      return { ok: true, basis: "UNKNOWN" };
  }
}

/**
 * Whether a refused call's cause names the register. Only a cause that says
 * so: a generic rejection (Vobiz's `CALL_REJECTED`, SIP 480 or 486) is what a
 * busy or switched-off phone returns too, and reading it as DND would stop
 * real buyers being called. Exotel's `CALL_REJECTED_DND` is the shape.
 */
export function dndCause(cause: string | null | undefined): boolean {
  if (!cause) return false;
  return /(^|[^a-z])(dnd|ncpr|ndnc)([^a-z]|$)|do[\s_-]*not[\s_-]*disturb|preference[\s_-]*register/i.test(cause);
}

/** What a lookup service's answer says, read defensively: anything else is no answer. */
export function readLookup(text: string): "DND" | "CLEAR" | null {
  const t = text.trim().toUpperCase();
  if (t === "DND") return "DND";
  if (t === "CLEAR") return "CLEAR";
  return null;
}

/** What the lead's history says when an answer is recorded, or nothing. */
export function dndActivity(status: DndStatus, source: DndSource): string | null {
  if (source === "PERSON") {
    return status === "DND"
      ? "Marked as on the DND register"
      : status === "CONSENT_REGISTERED"
        ? "Marked as consent registered with the operator"
        : "Marked as not on the DND register";
  }
  if (status !== "DND") return null;
  return source === "OPERATOR"
    ? "The operator refused the call: the number is on the DND register"
    : "Found on the DND register";
}

/** How the lead's page names what stands, or nothing when nothing is known. */
export function dndLabel(status: DndStatus | null): { text: string; tone: "risk" | "ok" } | null {
  if (status === "DND") return { text: "On DND", tone: "risk" };
  if (status === "CONSENT_REGISTERED") return { text: "DND consent registered", tone: "ok" };
  return null;
}
