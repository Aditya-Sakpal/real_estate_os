/**
 * Who sees a buyer's number, and how much of it: the rules, with no database.
 *
 * A field policy answers FULL, MASKED or HIDDEN for one person looking at one
 * lead, from the roles they hold over that lead's tower and how far the lead
 * has come (`path_stage`, so a lead that reached Qualified and then went to
 * Nurture is judged as Qualified). The answer is applied on the server, so a
 * masked number never reaches a browser: what leaves is `98XXXXXX21`, and the
 * whole number goes out only to somebody allowed to see it, one lead at a
 * time, with a row in the audit log.
 *
 * Masking is a read-path rule, not encryption. The engine still dials, dedupes
 * and messages on the whole number; only what is shown to a person changes.
 *
 * Copy on write, like roles: a tenant that never opens the settings gets the
 * shipped answer, which is masked for everyone who reads leads or visits and
 * hidden for everybody else. A row exists only where a tenant changed it.
 *
 * Relative imports, like every `*-rules.ts`: `check:logic` loads this from
 * source.
 */

import { scopeCovers, type Authz } from "./rbac-rules.ts";
import { ALL_PERMISSIONS } from "./permissions.ts";
import { PATH, type PathStage } from "./lead-rules.ts";

export type Visibility = "FULL" | "MASKED" | "HIDDEN";

/** Least open first, so a higher index is more open. */
export const VISIBILITIES: Visibility[] = ["HIDDEN", "MASKED", "FULL"];

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  FULL: "Full number",
  MASKED: "Masked",
  HIDDEN: "Hidden",
};

export type MaskedField = "phone" | "email";
export const MASKED_FIELDS: MaskedField[] = ["phone", "email"];

export type PolicyRow = { role: string; field: MaskedField; stage: PathStage; visibility: Visibility };

/** How many numbers one person may reveal in an IST day. */
export const REVEALS_PER_DAY = 100;

const open = (v: Visibility) => VISIBILITIES.indexOf(v);

export function isVisibility(v: unknown): v is Visibility {
  return typeof v === "string" && (VISIBILITIES as string[]).includes(v);
}

/**
 * The answer for a role nobody has set: masked for anybody who works leads
 * or visits, hidden for everybody else. The founding role is masked too.
 * Seeing a whole number is always either a tenant's decision (FULL) or one
 * person's audited click (a reveal), never a default.
 */
export function shippedVisibility(permissions: Iterable<string>): Visibility {
  const held = new Set(permissions);
  return held.has(ALL_PERMISSIONS) || held.has("lead:read") || held.has("visit:read") ? "MASKED" : "HIDDEN";
}

/**
 * What one person sees of one field on one lead. Every grant covering the
 * lead's node answers for its role, and the most open answer wins, the way
 * holding a permission anywhere over the node is holding it there.
 */
export function visibilityAt(opts: {
  grants: readonly { role: string; scopePath: string; permissions: Iterable<string> }[];
  path: string;
  stage: PathStage;
  field: MaskedField;
  rows: readonly PolicyRow[];
}): Visibility {
  let best: Visibility = "HIDDEN";
  for (const g of opts.grants) {
    if (!scopeCovers(g.scopePath, opts.path)) continue;
    const set = opts.rows.find((r) => r.role === g.role && r.field === opts.field && r.stage === opts.stage);
    const v = set?.visibility ?? shippedVisibility(g.permissions);
    if (open(v) > open(best)) best = v;
  }
  return best;
}

// ---------------------------------------------------------------------------
// What is shown
// ---------------------------------------------------------------------------

/** The national number: ten digits for India, the last ten for anywhere else. */
function national(digits: string): string {
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.slice(-10);
}

/** `98XXXXXX21`: enough to tell two buyers apart, not enough to dial. */
export function maskPhone(e164: string): string {
  const n = national(e164.replace(/\D/g, ""));
  if (n.length < 6) return "XXXX";
  return `${n.slice(0, 2)}${"X".repeat(n.length - 4)}${n.slice(-2)}`;
}

/** `+91 98765 43210`, the way a number is read aloud. */
export function spacedPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (e164.startsWith("+91") && digits.length === 12) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return e164;
}

/** `pXXX@gmail.com`: the first letter and the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "XXXX";
  return `${email.slice(0, 1)}XXX${email.slice(at)}`;
}

/**
 * A field as it may leave the server. `text` is all a browser ever gets; a
 * masked one carries whether this person may ask for the rest.
 */
export type Shown = { text: string; state: Visibility; canReveal: boolean };

export function shownPhone(e164: string | null, vis: Visibility, canReveal = false): Shown {
  if (!e164 || vis === "HIDDEN") return { text: "", state: "HIDDEN", canReveal: false };
  if (vis === "FULL") return { text: spacedPhone(e164), state: "FULL", canReveal: false };
  return { text: maskPhone(e164), state: "MASKED", canReveal };
}

export function shownEmail(email: string | null, vis: Visibility, canReveal = false): Shown {
  if (!email || vis === "HIDDEN") return { text: "", state: "HIDDEN", canReveal: false };
  if (vis === "FULL") return { text: email, state: "FULL", canReveal: false };
  return { text: maskEmail(email), state: "MASKED", canReveal };
}

// A run that could be a phone number: digits (ASCII or Devanagari), with the
// spaces, dashes and plus a person or a transcriber puts in one.
const DIGIT = "0-9\\u0966-\\u096F";
const PHONE_RUN = new RegExp(`\\+?[${DIGIT}][${DIGIT} -]{8,16}[${DIGIT}]`, "g");

/**
 * Numbers inside words somebody else wrote: a transcript, the agent's
 * summary, a buyer's WhatsApp reply. Column masking cannot see into them,
 * so any run of ten to thirteen digits is masked the same way (or dropped,
 * for somebody the number is hidden from). A viewer with the full number
 * sees the text as written.
 */
export function redactPhones(text: string, vis: Visibility): string;
export function redactPhones(text: string | null, vis: Visibility): string | null;
export function redactPhones(text: string | null, vis: Visibility): string | null {
  if (text === null || vis === "FULL") return text;
  return text.replace(PHONE_RUN, (run) => {
    const digits = run.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966)).replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) return run;
    return vis === "HIDDEN" ? "[number]" : maskPhone(digits);
  });
}

// ---------------------------------------------------------------------------
// The settings form: "masked until Qualified, then the full number"
// ---------------------------------------------------------------------------

/**
 * One role's policy as a person sets it: one answer until a stage, another
 * from it on. Almost every real policy is that shape ("closing managers see
 * the number once a visit is booked"), and nine columns of selects per role
 * would ask for a decision nobody has.
 */
export type Threshold = { before: Visibility; from: PathStage | null; after: Visibility };

/** The rows a threshold stands for, one per stage of the path. */
export function thresholdRows(role: string, field: MaskedField, t: Threshold): PolicyRow[] {
  const cut = t.from ? PATH.indexOf(t.from) : PATH.length;
  return PATH.map((stage, i) => ({ role, field, stage, visibility: i < cut ? t.before : t.after }));
}

/**
 * The threshold a role's rows describe, for drawing the form. No rows is the
 * shipped answer at every stage. Rows written by the form are always this
 * shape; anything else reads as its first stage's answer throughout, which
 * is the least surprising thing to show, and saving writes it back whole.
 */
export function thresholdOf(rows: readonly PolicyRow[], role: string, field: MaskedField, shipped: Visibility): Threshold {
  const at = (s: PathStage) => rows.find((r) => r.role === role && r.field === field && r.stage === s)?.visibility ?? shipped;
  const before = at(PATH[0]);
  const change = PATH.findIndex((s) => at(s) !== before);
  if (change < 0) return { before, from: null, after: before };
  return { before, from: PATH[change], after: at(PATH[change]) };
}

/** Read one role's three fields from the settings form. Null when they do not add up. */
export function readThreshold(raw: { before?: unknown; from?: unknown; after?: unknown }): Threshold | null {
  if (!isVisibility(raw.before)) return null;
  const from = typeof raw.from === "string" && (PATH as string[]).includes(raw.from) ? (raw.from as PathStage) : null;
  if (!from) return { before: raw.before, from: null, after: raw.before };
  if (!isVisibility(raw.after)) return null;
  // "Hidden until Qualified, then masked" is fine; the first stage has no before.
  if (from === PATH[0]) return { before: raw.after, from: null, after: raw.after };
  return { before: raw.before, from, after: raw.after };
}

// ---------------------------------------------------------------------------
// The lens: one viewer's answer, ready to show numbers through
// ---------------------------------------------------------------------------

/** Where a lead sits and how far it has come: all a lens needs to answer. */
export type LeadAt = { path: string; stage: PathStage };

export type Lens = {
  vis: (at: LeadAt, field?: MaskedField) => Visibility;
  phone: (e164: string | null, at: LeadAt) => Shown;
  email: (email: string | null, at: LeadAt) => Shown;
  /** Words somebody else wrote about the lead, with any number in them masked to match. */
  text: (text: string | null, at: LeadAt) => string | null;
};

/**
 * One viewer, one tenant's policy. Every page that shows a buyer's contact
 * details builds one of these for the request and passes every number
 * through it before anything reaches a client component.
 */
export function lensOf(authz: Pick<Authz, "grants" | "canAt" | "stepUpAt">, rows: readonly PolicyRow[]): Lens {
  const vis = (at: LeadAt, field: MaskedField = "phone") =>
    visibilityAt({ grants: authz.grants, path: at.path, stage: at.stage, field, rows });
  // A phone session reveals behind a fresh code, so the offer is shown where a code would open it.
  const reveal = (at: LeadAt) => authz.canAt("lead.phone:unmask", at.path) || Boolean(authz.stepUpAt?.("lead.phone:unmask", at.path));
  return {
    vis,
    phone: (e164, at) => {
      const v = vis(at, "phone");
      return shownPhone(e164, v, v === "MASKED" && reveal(at));
    },
    email: (email, at) => {
      const v = vis(at, "email");
      return shownEmail(email, v, v === "MASKED" && reveal(at));
    },
    text: (text, at) => redactPhones(text, vis(at, "phone")),
  };
}
