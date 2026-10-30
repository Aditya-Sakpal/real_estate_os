/**
 * The host's voice note after a visit: how long it may run, where it is cut
 * for the transcriber, what the model may draft from it, and what the
 * buyer's objection starts next. Pure and database-free, covered by
 * `check:logic`; `visit-notes.ts` reads, writes and calls.
 *
 * Section 02's rules:
 *
 * - **Kept as it was said.** The recording is stored verbatim; its key,
 *   size and hash are never changed.
 * - **The AI drafts, the host confirms.** Nothing a model read out of a note
 *   records a visit until the host presses the button.
 * - **Grounded.** The units shown are the tower's approved unit types and
 *   nothing else; every field the model fills has to quote the words it
 *   came from, and a quote the transcript does not carry is dropped.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { spanFound } from "./qualification-rules.ts";
import type { Voice } from "./message-rules.ts";

/** Shorter than this says nothing a host could not type. */
export const NOTE_MIN_S = 45;
/** Longer than this is a second visit's worth of talk. */
export const NOTE_MAX_S = 90;
/** What a container's own length may differ from the phone's timer by. */
export const NOTE_SLACK_S = 2;
/** Under the 4.5 MB a Vercel function accepts. A 90-second phone recording is a few hundred KB. */
export const NOTE_MAX_BYTES = 4 * 1024 * 1024;
export const NOTE_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac"] as const;
/** A note and one re-record. Each is a paid transcription. */
export const MAX_NOTES_PER_VISIT = 2;
export const MAX_EXTRACT_TRIES = 2;
/** What a note counts against the project's AI minutes. */
export const NOTE_MINUTES = 0.5;
/** Sarvam's REST speech-to-text takes 30 seconds at most. */
export const CHUNK_MAX_S = 29;
/** A piece shorter than this is not worth a cut at a silence. */
const CHUNK_MIN_S = 10;

export type NoteType = (typeof NOTE_TYPES)[number];

/** A browser's own label for what it recorded, reduced to the type the store keeps. */
export function noteType(raw: string | null | undefined): NoteType | null {
  const base = (raw ?? "").split(";")[0].trim().toLowerCase();
  const alias: Record<string, NoteType> = { "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "audio/mp3": "audio/mpeg", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav" };
  const t = alias[base] ?? base;
  return (NOTE_TYPES as readonly string[]).includes(t) ? (t as NoteType) : null;
}

export const LENGTH_MESSAGE = `Keep the note between ${NOTE_MIN_S} and ${NOTE_MAX_S} seconds.`;

/** Whether a length, in milliseconds, is a note's. */
export function lengthProblem(ms: number): string | null {
  if (!Number.isFinite(ms)) return LENGTH_MESSAGE;
  const s = ms / 1000;
  return s < NOTE_MIN_S - NOTE_SLACK_S || s > NOTE_MAX_S + NOTE_SLACK_S ? LENGTH_MESSAGE : null;
}

/** Whether an upload may be stored at all. */
export function noteProblem(o: { contentType: string | null; bytes: number; durationMs: number }): string | null {
  if (!noteType(o.contentType)) return "That recording is not audio this can keep.";
  if (!(o.bytes > 0)) return "The recording is empty.";
  if (o.bytes > NOTE_MAX_BYTES) return "The recording is too large.";
  return lengthProblem(o.durationMs);
}

/**
 * Whether a note may be left on a visit now: once the buyer is checked in,
 * or before, on a visit still on for today (IST), marked as before the
 * visit. Never on another day's visit, one that moved, or one already over.
 */
export function noteWhen(o: { status: string; scheduledDay: string; today: string }): { ok: true; before: boolean } | { ok: false; message: string } {
  if (o.status === "ON_SITE") return { ok: true, before: false };
  if (o.status === "CONFIRMED" && o.scheduledDay === o.today) return { ok: true, before: true };
  if (o.status === "CONFIRMED") return { ok: false, message: "A note before the visit is left on the day of the visit." };
  return { ok: false, message: "Record a note once the buyer is checked in." };
}

// ---------------------------------------------------------------------------
// Cutting it for the transcriber
// ---------------------------------------------------------------------------

export type Silence = { start: number; end: number };

/** FFmpeg's `silencedetect` lines, read back. */
export function parseSilences(stderr: string): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  return out;
}

/**
 * Where to cut a note into pieces the transcriber takes: each piece at most
 * `CHUNK_MAX_S` long, ended in the middle of the latest silence that allows
 * it so no word is cut in half, or at the limit when there is none.
 */
export function cutPlan(silences: readonly Silence[], duration: number, max = CHUNK_MAX_S): [number, number][] {
  const pieces: [number, number][] = [];
  let from = 0;
  while (duration - from > max) {
    const mids = silences
      .map((s) => (s.start + s.end) / 2)
      .filter((m) => m > from + CHUNK_MIN_S && m <= from + max);
    // With no silence to cut in, cut short enough that the last piece is
    // not a sliver of a second.
    const to = mids.length ? Math.max(...mids) : Math.min(from + max, Math.max(from + CHUNK_MIN_S, duration - CHUNK_MIN_S));
    pieces.push([round(from), round(to)]);
    from = to;
  }
  if (duration - from > 0.05) pieces.push([round(from), round(duration)]);
  return pieces;
}

const round = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// What the model may draft
// ---------------------------------------------------------------------------

export const NOTE_OBJECTIONS = ["NONE", "PRICE", "LOAN", "LOCATION", "FAMILY", "POSSESSION", "CARPET", "LAYOUT", "OTHER"] as const;
export type NoteObjection = (typeof NOTE_OBJECTIONS)[number];

/** The board's own words for each, so a confirmed note records what a person would. */
export const OBJECTION_WORDS: Record<NoteObjection, string> = {
  NONE: "None",
  PRICE: "Price",
  LOAN: "Loan",
  LOCATION: "Location",
  FAMILY: "Family",
  POSSESSION: "Possession date",
  CARPET: "Carpet area",
  LAYOUT: "Layout",
  OTHER: "Other",
};

export const NOTE_INTERESTS = ["HOT", "WARM", "COLD"] as const;
export const INTEREST_WORDS: Record<(typeof NOTE_INTERESTS)[number], string> = { HOT: "Hot", WARM: "Warm", COLD: "Cold" };

export const NOTE_NEXT = ["PAYMENT_PLAN", "REVISIT_FAMILY", "LOAN_OFFER", "HOLD_UNIT", "CALL_WEEK", "NOTHING"] as const;
/** The visits screen's own choices, in the same order. */
export const NEXT_WORDS: Record<(typeof NOTE_NEXT)[number], string> = {
  PAYMENT_PLAN: "Send the payment plan",
  REVISIT_FAMILY: "Revisit with family",
  LOAN_OFFER: "Share the loan offer",
  HOLD_UNIT: "Hold a unit for 48 hours",
  CALL_WEEK: "Call back in a week",
  NOTHING: "Nothing planned",
};

export type NoteUnit = { id: string; label: string; carpetSqft: number };

export type NoteDraft = {
  /** Approved unit types the host said were shown. */
  units: { id: string; span: string }[];
  objection: { value: NoteObjection; span: string } | null;
  interest: { value: (typeof NOTE_INTERESTS)[number]; span: string } | null;
  next: { value: (typeof NOTE_NEXT)[number]; span: string } | null;
};

const spanned = (values: readonly string[]) => ({
  type: ["object", "null"],
  additionalProperties: false,
  required: ["value", "span"],
  properties: { value: { type: "string", enum: [...values] }, span: { type: "string" } },
});

/** The shape the model answers in. The unit ids it may name are the tower's own. */
export function noteSchema(unitIds: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["units", "objection", "interest", "next"],
    properties: {
      units: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "span"],
          properties: { id: { type: "string", enum: unitIds.length ? [...unitIds] : ["none"] }, span: { type: "string" } },
        },
      },
      objection: spanned(NOTE_OBJECTIONS),
      interest: spanned(NOTE_INTERESTS),
      next: spanned(NOTE_NEXT),
    },
  };
}

export function notePrompt(units: readonly NoteUnit[]): string {
  return [
    "A site host at an Indian real-estate project recorded a short voice note after showing a buyer around.",
    "Read the transcript and fill in what the host said. Hindi, Marathi and English are all normal here.",
    "For every field, quote the host's own words in `span`, exactly as the transcript has them. If the host did not say it, use null.",
    "`units` are the unit types the host said were shown, chosen only from this list (id: label, carpet):",
    ...units.map((u) => `- ${u.id}: ${u.label}, ${u.carpetSqft} sq ft carpet`),
    "`objection` is what held the buyer back. `interest` is how keen the host thought they were. `next` is the next step the host named.",
    "Never guess. A field the note does not answer is null.",
  ].join("\n");
}

/**
 * The model's answer, kept only where it is grounded: a unit on the list,
 * each field with a quote the transcript really carries.
 */
export function readNote(raw: unknown, o: { transcript: string; unitIds: readonly string[] }): NoteDraft {
  const r = (raw ?? {}) as Record<string, unknown>;
  const said = (span: unknown) => typeof span === "string" && span.trim().length > 0 && spanFound(span, o.transcript);
  const one = <T extends string>(v: unknown, values: readonly T[]): { value: T; span: string } | null => {
    const x = v as { value?: unknown; span?: unknown } | null;
    return x && typeof x.value === "string" && (values as readonly string[]).includes(x.value) && said(x.span)
      ? { value: x.value as T, span: String(x.span).trim().slice(0, 200) }
      : null;
  };
  const seen = new Set<string>();
  const units = (Array.isArray(r.units) ? r.units : [])
    .map((u) => u as { id?: unknown; span?: unknown })
    .filter((u) => typeof u.id === "string" && o.unitIds.includes(u.id) && said(u.span) && !seen.has(u.id) && seen.add(u.id))
    .map((u) => ({ id: u.id as string, span: String(u.span).trim().slice(0, 200) }))
    .slice(0, 6);
  return {
    units,
    objection: one(r.objection, NOTE_OBJECTIONS),
    interest: one(r.interest, NOTE_INTERESTS),
    next: one(r.next, NOTE_NEXT),
  };
}

/** The draft in the visits screen's own words, for the host to confirm or correct. */
export function draftOutcome(d: NoteDraft, units: readonly NoteUnit[]): { interest: string | null; objection: string | null; next: string | null; shown: string[] } {
  return {
    interest: d.interest ? INTEREST_WORDS[d.interest.value] : null,
    objection: d.objection ? OBJECTION_WORDS[d.objection.value] : null,
    next: d.next ? NEXT_WORDS[d.next.value] : null,
    shown: d.units.map((u) => units.find((x) => x.id === u.id)?.label).filter((x): x is string => !!x),
  };
}

// ---------------------------------------------------------------------------
// What the objection starts
// ---------------------------------------------------------------------------

export type FollowUp = "EMI" | "LENDER" | "REVISIT";

/** The objection recorded on the visit, in the board's words, and what it starts. */
export function followUpFor(objection: string | null | undefined): FollowUp | null {
  if (objection === "Price") return "EMI";
  if (objection === "Loan") return "LENDER";
  if (objection === "Family") return "REVISIT";
  return null;
}

/**
 * What a bank lends on a home, under the RBI's loan-to-value limits: 90% up
 * to Rs 30 lakh, 80% up to Rs 75 lakh, 75% above. The EMI a buyer is sent is
 * on this, never on the whole price.
 */
export function loanAmountFor(price: number): number {
  // RBI's bands are by the LOAN, not the price: 90% while the loan is up to
  // Rs 30 lakh, 80% up to Rs 75 lakh, 75% above. The largest loan any band
  // allows is the answer, so a Rs 35 lakh flat carries Rs 30 lakh, not Rs 28.
  const upTo30 = Math.min(price * 0.9, 30_00_000);
  const upTo75 = price * 0.8 > 30_00_000 ? Math.min(price * 0.8, 75_00_000) : 0;
  const above = price * 0.75 > 75_00_000 ? price * 0.75 : 0;
  return Math.floor(Math.max(upTo30, upTo75, above));
}

/** The monthly instalment on a loan, rounded to the rupee. */
export function emi(principal: number, ratePct: number, years: number): number {
  const r = ratePct / 1200;
  const n = years * 12;
  if (!(principal > 0) || !(n > 0)) return 0;
  if (r === 0) return Math.round(principal / n);
  const f = (1 + r) ** n;
  return Math.round((principal * r * f) / (f - 1));
}

export const EMI_YEARS = [15, 20, 25] as const;

export function emiPlan(price: number, ratePct: number): { loan: number; rows: { years: number; emi: number }[] } {
  const loan = loanAmountFor(price);
  return { loan, rows: EMI_YEARS.map((years) => ({ years, emi: emi(loan, ratePct, years) })) };
}

/** A rupee amount in the Indian grouping, no symbol: `66,215`. */
export const indian = (n: number) => Math.round(n).toLocaleString("en-IN");

/**
 * The loan in the words a buyer reads it in. English writes the whole
 * amount (`₹72,00,000`); Hinglish and Marathi say it the way it is said
 * aloud in either, in lakh or crore (`₹72 lakh`, `₹1.2 crore`, and
 * Marathi's `₹1.2 koti`), to two places at most and rounded down, in Roman letters like
 * every template.
 */
export function loanWords(loan: number, voice: Voice): string {
  if (voice === "ENGLISH") return `₹${indian(loan)}`;
  // Down, never up: a buyer is never told the bank lends more than it does.
  const places = (n: number) => String(Math.floor(n * 100 + 1e-9) / 100);
  if (loan >= 1_00_00_000) return `₹${places(loan / 1_00_00_000)} ${voice === "MARATHI" ? "koti" : "crore"}`;
  return `₹${places(loan / 1_00_000)} lakh`;
}

/**
 * The blanks of the EMI message, in the lead's version: the unit's label as
 * approved, the loan in that version's words, the signed rate, and the three
 * instalments in the Indian grouping. Every number comes from `emiPlan()`.
 */
export function emiFill(
  plan: { loan: number; rows: { years: number; emi: number }[] },
  unit: string,
  ratePct: number,
  voice: Voice,
): { unit: string; loan: string; rate: string; emi_15: string; emi_20: string; emi_25: string } {
  const at = (y: number) => indian(plan.rows.find((r) => r.years === y)?.emi ?? 0);
  return { unit, loan: loanWords(plan.loan, voice), rate: `${ratePct}%`, emi_15: at(15), emi_20: at(20), emi_25: at(25) };
}

// ---------------------------------------------------------------------------
// A lender, only after the buyer's yes
// ---------------------------------------------------------------------------

/** Lenders one question names, in the order Settings lists them. */
export const MAX_LENDERS_ASKED = 3;

/**
 * The lenders a buyer is asked about: the first three listed, less any
 * this buyer was already asked about (asked once, answered once).
 */
export function lendersToAsk<T extends { id: string }>(listed: readonly T[], alreadyAsked: readonly string[]): T[] {
  const asked = new Set(alreadyAsked);
  return listed.filter((l) => !asked.has(l.id)).slice(0, MAX_LENDERS_ASKED);
}

/** `HDFC Bank`, `HDFC Bank and SBI`, `HDFC Bank, SBI and ICICI Bank`: the names as the question says them. */
export function lenderNames(names: readonly string[]): string {
  const n = names.map((s) => s.trim()).filter(Boolean);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** What a quick-reply button carries back: the referral and the answer. */
export const lenderPayload = (referralId: string, yes: boolean) => `lender:${referralId}:${yes ? "yes" : "no"}`;

export function readLenderPayload(raw: string | null | undefined): { referralId: string; yes: boolean } | null {
  const m = /^lender:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(yes|no)$/i.exec((raw ?? "").trim());
  return m ? { referralId: m[1].toLowerCase(), yes: m[2].toLowerCase() === "yes" } : null;
}

/** The email a lender gets: who, which number, what they are looking at. Nothing else of the lead's. */
export function lenderMail(o: {
  lender: string;
  developer: string;
  buyer: string;
  phone: string;
  project: string;
  config: string | null;
  budget: string | null;
}): { subject: string; text: string } {
  return {
    subject: `Home-loan enquiry from ${o.developer}: ${o.buyer}`,
    text: [
      `Hello ${o.lender},`,
      "",
      `${o.buyer} visited ${o.project} and agreed on WhatsApp to be contacted about a home loan.`,
      "",
      `Name: ${o.buyer}`,
      `Mobile: ${o.phone}`,
      ...(o.config ? [`Looking at: ${o.config}`] : []),
      ...(o.budget ? [`Budget: ${o.budget}`] : []),
      "",
      "Please call them only about the loan, and do not share their number further.",
      "",
      o.developer,
    ].join("\n"),
  };
}
