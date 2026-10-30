/**
 * Telling Meta and Google what became of the leads they sold us. Pure and
 * database-free, covered by `check:logic`.
 *
 * Section 09 of the product flow doc. Both platforms bid on whatever the
 * advertiser says converted, and a developer can only say "a form was
 * filled". A qualified buyer, a site visit and a booking happen offline,
 * days to months later, and this is what turns each into an outcome a
 * platform can read.
 *
 * Six rules, all from the vendors' own documentation as it stood on 28
 * September 2026 (the links are in CLAUDE.md, "Attribution"):
 *
 * 1. **The outcome's id is the platforms' key.** A ULID is Meta's
 *    `event_id` and Google's `transactionId`, so a send that lands twice is
 *    one conversion. Google treats a repeated transaction id as an update;
 *    Meta documents its 48-hour dedupe only against the pixel, so a Meta
 *    send is repeated only inside those 48 hours.
 * 2. **Neither platform takes a conversion back.** Meta has no retraction,
 *    and Google's Data Manager API (the only upload a new project is
 *    allowed since 15 June 2026) has none either. So a booking waits out a
 *    hold before it is sent, and one cancelled inside it is never sent.
 * 3. **Meta refuses anything more than 7 days old, and the whole batch
 *    with it.** Nothing older than six days is sent. A held booking is sent
 *    to Meta as "booking confirmed", dated the day the hold ended, which is
 *    the only truthful time Meta will take. Google takes the real booking
 *    time, within 90 days of the click.
 * 4. **Nothing is sent without consent to measure.** Consent to a call is
 *    not consent to have a platform told whether you booked. The client
 *    chose this on 28 September 2026.
 * 5. **Each platform hashes a phone its own way.** Meta: digits with the
 *    country code and no plus. Google: E.164 with the plus. Then SHA-256,
 *    hex. The hash is made at the moment of sending and stored nowhere.
 * 6. **A lead goes back to the platform that bought it.** A Meta lead form
 *    or an fbclid is Meta's; a gclid or a Google lead form is Google's. A
 *    lead neither platform can match is not sent to either.
 */

import { createHash } from "node:crypto";
import type { Lineage } from "./capture-rules.ts";
import type { PathStage, StageKey } from "./lead-rules.ts";

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type OutcomeKind = "QUALIFIED" | "VISIT_DONE" | "BOOKED" | "AGREEMENT" | "REGISTERED" | "CANCELLED";

export const OUTCOME_KINDS: OutcomeKind[] = ["QUALIFIED", "VISIT_DONE", "BOOKED", "AGREEMENT", "REGISTERED", "CANCELLED"];

export const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  QUALIFIED: "Qualified",
  VISIT_DONE: "Site visit done",
  BOOKED: "Booked",
  AGREEMENT: "Agreement signed",
  REGISTERED: "Registered",
  CANCELLED: "Booking cancelled",
};

/** The outcomes a platform is ever told. A cancellation is ours alone. */
export const SENT_KINDS: OutcomeKind[] = ["QUALIFIED", "VISIT_DONE", "BOOKED", "AGREEMENT", "REGISTERED"];

export type Values = { qualified: number; visit: number; booking: number; holdDays: number };

/** Fixed rupees, never the agreement value: the ratios are the message. */
export const DEFAULT_VALUES: Values = { qualified: 2_000, visit: 10_000, booking: 1_00_000, holdDays: 30 };

export const MAX_HOLD_DAYS = 60;

export function valueOf(kind: OutcomeKind, v: Values): number {
  if (kind === "QUALIFIED") return v.qualified;
  if (kind === "VISIT_DONE") return v.visit;
  if (kind === "CANCELLED") return 0;
  return v.booking;
}

/** What a settings form sent, as values, or why not. */
export function readValues(input: { qualified: string; visit: string; booking: string; holdDays: string }): Values | { error: string } {
  const n = (s: string) => Number(String(s ?? "").replace(/[^\d]/g, "") || "NaN");
  const v = { qualified: n(input.qualified), visit: n(input.visit), booking: n(input.booking), holdDays: n(input.holdDays) };
  if (![v.qualified, v.visit, v.booking].every((x) => Number.isInteger(x) && x >= 0 && x <= 1_00_00_000)) {
    return { error: "Enter each value in whole rupees, up to Rs 1 Cr." };
  }
  if (!Number.isInteger(v.holdDays) || v.holdDays < 0 || v.holdDays > MAX_HOLD_DAYS) {
    return { error: `The wait can be 0 to ${MAX_HOLD_DAYS} days.` };
  }
  return v;
}

// ---------------------------------------------------------------------------
// The id both platforms dedupe on
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of time, then 80 random bits, Crockford base32. */
export function ulid(nowMs: number, random: Uint8Array): string {
  if (random.length < 10) throw new Error("A ULID needs ten random bytes.");
  let t = Math.floor(nowMs);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(random[i]);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}

export const isUlid = (s: unknown): s is string => typeof s === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);

// ---------------------------------------------------------------------------
// Which outcomes a move makes
// ---------------------------------------------------------------------------

const PATH_ORDER: PathStage[] = ["new", "contacted", "qualified", "visit_scheduled", "visit_done", "negotiation", "booked"];
const at = (s: PathStage) => PATH_ORDER.indexOf(s);

export type Recorded = { id: string; kind: OutcomeKind; bookingId: string | null };

/** The booking that stands: the newest one nothing cancelled. */
export function liveBooking(events: readonly Recorded[]): string | null {
  const cancelled = new Set(events.filter((e) => e.kind === "CANCELLED").map((e) => e.bookingId));
  const booked = events.filter((e) => e.kind === "BOOKED" && !cancelled.has(e.id));
  return booked.length ? booked[booked.length - 1].id : null;
}

export type Planned = { kind: OutcomeKind; bookingId: string | null };

/**
 * The outcomes one move makes, in the order they happened.
 *
 * Read off where the lead ENDS UP on the path, so a card moved straight to
 * Booked is also qualified and visited (the rules made it carry both), and a
 * card moved back and forward again is qualified once. Leaving Booked is a
 * cancellation of the booking that stood.
 */
export function outcomesForMove(
  move: { from: StageKey; to: StageKey; toPath: PathStage; cancelsBooking: boolean },
  events: readonly Recorded[],
): Planned[] {
  const out: Planned[] = [];
  const has = (k: OutcomeKind) => events.some((e) => e.kind === k);
  let standing = liveBooking(events);
  if (move.cancelsBooking && standing) {
    out.push({ kind: "CANCELLED", bookingId: standing });
    standing = null;
  }
  if (at(move.toPath) >= at("qualified") && !has("QUALIFIED")) out.push({ kind: "QUALIFIED", bookingId: null });
  if (at(move.toPath) >= at("visit_done") && !has("VISIT_DONE")) out.push({ kind: "VISIT_DONE", bookingId: null });
  if (move.to === "booked" && move.from !== "booked" && !standing) out.push({ kind: "BOOKED", bookingId: null });
  return out;
}

// ---------------------------------------------------------------------------
// When it happened
// ---------------------------------------------------------------------------

const istDay = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);

/**
 * The time of an outcome. A day somebody typed that is before today is
 * that day at noon in India; today, or no day at all, is now. Never before
 * the lead existed, because Meta discards an outcome older than its lead,
 * and never in the future.
 */
export function occurredAt(day: string | null | undefined, nowIso: string, leadCreatedIso: string): string {
  const now = Date.parse(nowIso);
  let t = now;
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day < istDay(now)) t = Date.parse(`${day}T12:00:00+05:30`);
  const created = Date.parse(leadCreatedIso);
  if (Number.isFinite(created)) t = Math.max(t, created);
  return new Date(Math.min(t, now)).toISOString();
}

/** The day a move's facts name for an outcome, if any. */
export function dayFor(kind: OutcomeKind, facts: { visitDate?: string; bookedOn?: string }): string | null {
  if (kind === "VISIT_DONE") return facts.visitDate ?? null;
  if (kind === "BOOKED") return facts.bookedOn ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Agreement and registration, recorded on a booked lead
// ---------------------------------------------------------------------------

export type Milestone = "AGREEMENT" | "REGISTERED";

/** Which milestone a booked lead can record next, if any. */
export function nextMilestone(events: readonly Recorded[]): { kind: Milestone; bookingId: string } | null {
  const booking = liveBooking(events);
  if (!booking) return null;
  const on = (k: OutcomeKind) => events.some((e) => e.kind === k && e.bookingId === booking);
  if (!on("AGREEMENT")) return { kind: "AGREEMENT", bookingId: booking };
  if (!on("REGISTERED")) return { kind: "REGISTERED", bookingId: booking };
  return null;
}

/** Why a milestone cannot be recorded on this day, or null. */
export function milestoneProblem(
  kind: Milestone,
  day: string,
  ctx: { events: readonly Recorded[]; today: string; bookedOn: string | null; agreementOn: string | null },
): string | null {
  const next = nextMilestone(ctx.events);
  if (!next) return liveBooking(ctx.events) ? "Both are already recorded." : "Only a booked lead has an agreement.";
  if (next.kind !== kind) return kind === "REGISTERED" ? "Record the agreement first." : "The agreement is already recorded.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Pick a date";
  if (day > ctx.today) return "Can't be in the future";
  if (ctx.bookedOn && day < ctx.bookedOn) return "Can't be before the booking";
  if (kind === "REGISTERED" && ctx.agreementOn && day < ctx.agreementOn) return "Can't be before the agreement";
  return null;
}

// ---------------------------------------------------------------------------
// What an outcome carries: the lead's origin, never its identity
// ---------------------------------------------------------------------------

export type OutcomeLineage = {
  channel: string;
  /** Meta's id for a lead-form lead, 15 to 17 digits. */
  leadgenId?: string;
  gclid?: string;
  fbc?: string;
  campaignId?: string;
  adsetId?: string;
  adId?: string;
  utmSource?: string;
  utmCampaign?: string;
  utmContent?: string;
  ref?: string;
};

export function lineageSnapshot(lead: { channel: string; externalId: string | null; lineage: Lineage | null }): OutcomeLineage {
  const l = lead.lineage ?? {};
  const out: OutcomeLineage = { channel: lead.channel };
  if (lead.channel === "META_FORM" && lead.externalId && /^\d{10,20}$/.test(lead.externalId)) out.leadgenId = lead.externalId;
  const copy = ["gclid", "fbc", "campaignId", "adsetId", "adId", "utmSource", "utmCampaign", "utmContent", "ref"] as const;
  for (const k of copy) {
    const v = l[k];
    if (typeof v === "string" && v) out[k] = v.slice(0, 500);
  }
  return out;
}

const FBCLID = /^[A-Za-z0-9_-]{10,500}$/;
const FBC = /^fb\.[0-9]\.\d{10,13}\.[A-Za-z0-9_-]{10,500}$/;

/**
 * Meta's click id as its API wants it: `fb.1.<ms>.<fbclid>`. A site that
 * already has the `_fbc` cookie may send it whole; otherwise it is built
 * from the fbclid on the landing address and the moment it arrived.
 */
export function fbcFrom(fbclid: string | null | undefined, fbc: string | null | undefined, atMs: number): string | undefined {
  const given = (fbc ?? "").trim();
  if (FBC.test(given)) return given;
  const id = (fbclid ?? "").trim();
  if (FBCLID.test(id)) return `fb.1.${Math.floor(atMs)}.${id}`;
  return undefined;
}

export type Platform = "META" | "GOOGLE";

const META_SOURCE = /facebook|instagram|meta|^fb$|^ig$/i;
const GOOGLE_SOURCE = /google|adwords/i;

/** The platforms that bought this lead and can match it. */
export function platformsFor(l: OutcomeLineage): Platform[] {
  const out: Platform[] = [];
  if (l.channel === "META_FORM" || l.fbc || META_SOURCE.test(l.utmSource ?? "")) out.push("META");
  if (l.channel === "GOOGLE_FORM" || l.gclid || GOOGLE_SOURCE.test(l.utmSource ?? "")) out.push("GOOGLE");
  return out;
}

/** Whether the platform has anything to match the outcome to its ad by. */
export function matchable(p: Platform, l: OutcomeLineage): boolean {
  // Google asks for the gclid when there is no Google tag on the site, and
  // there is not; Meta matches a lead-form lead by its id and a website lead
  // by its click, with the hashed phone beside either.
  return p === "META" ? Boolean(l.leadgenId || l.fbc) : Boolean(l.gclid);
}

// ---------------------------------------------------------------------------
// Hashing, each platform its own way
// ---------------------------------------------------------------------------

const E164 = /^\+[1-9]\d{7,14}$/;

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Meta: digits only, country code first, no plus, no leading zero. */
export function metaPhone(e164: string): string | null {
  if (!E164.test(e164)) return null;
  return e164.slice(1).replace(/^0+/, "");
}

/** Google: E.164, plus sign included. */
export function googlePhone(e164: string): string | null {
  return E164.test(e164) ? e164 : null;
}

export const metaPhoneHash = (e164: string) => {
  const p = metaPhone(e164);
  return p ? sha256Hex(p) : null;
};

export const googlePhoneHash = (e164: string) => {
  const p = googlePhone(e164);
  return p ? sha256Hex(p) : null;
};

// ---------------------------------------------------------------------------
// Whether, when and how an outcome is sent
// ---------------------------------------------------------------------------

export type UploadState = "WAITING" | "QUEUED" | "SENDING" | "SENT" | "NOT_SENT" | "FAILED";

export type Reason =
  | "NO_CONSENT"
  | "OPTED_OUT"
  | "NOT_MATCHABLE"
  | "NOT_CONNECTED"
  | "NEEDS_RECONNECT"
  | "NOT_SWITCHED_ON"
  | "ACTION_NEW"
  | "HELD"
  | "CANCELLED"
  | "TOO_OLD"
  | "REFUSED"
  | "NO_ANSWER";

/** Meta refuses an event_time more than 7 days old; a day of margin. */
export const META_MAX_AGE_DAYS = 6;
/** Google keeps a click for 90 days; the enquiry comes after the click, so two days of margin. */
export const GOOGLE_CLICK_DAYS = 88;
/** Meta's pixel-and-server dedupe window, the only one it documents. */
export const META_RESEND_HOURS = 48;
export const MAX_UPLOAD_ATTEMPTS = 5;
/** One pass of the worker, per organisation. */
export const MAX_UPLOADS_PER_PASS = 200;

const DAY = 86_400_000;

export type PlanInput = {
  platform: Platform;
  kind: OutcomeKind;
  occurredAt: string;
  leadCreatedAt: string;
  lineage: OutcomeLineage;
  consented: boolean;
  optedOut: boolean;
  /** A Meta dataset or a Google Ads account resolved for the lead's tower. */
  connected: boolean;
  /** The booking this outcome belongs to has been cancelled. */
  cancelled: boolean;
  holdDays: number;
  nowIso: string;
  /** When it was decided it may go, once decided. The hold is not recomputed from a setting changed since. */
  notBefore?: string;
};

export type Plan = { state: "QUEUED" | "WAITING" | "NOT_SENT"; reason: Reason | null; notBefore: string };

/** When a booking may go: once it has stood for the hold. */
export const releaseAt = (kind: OutcomeKind, occurredIso: string, holdDays: number) =>
  kind === "BOOKED" ? new Date(Date.parse(occurredIso) + holdDays * DAY).toISOString() : occurredIso;

/**
 * Decide an upload. Asked when the outcome is written and again when the
 * worker picks it up, because consent, an opt-out, a cancellation and a
 * connection can all change in between, and the clock always does.
 *
 * The order is the order of finality: what can never be sent first, then
 * what is waiting on time, then what is waiting on setup.
 */
export function planUpload(p: PlanInput): Plan {
  const now = Date.parse(p.nowIso);
  const notBefore = p.notBefore ?? releaseAt(p.kind, p.occurredAt, p.holdDays);
  const never = (reason: Reason): Plan => ({ state: "NOT_SENT", reason, notBefore });
  if (!SENT_KINDS.includes(p.kind)) return never("CANCELLED");
  if (p.optedOut) return never("OPTED_OUT");
  if (!p.consented) return never("NO_CONSENT");
  if (!matchable(p.platform, p.lineage)) return never("NOT_MATCHABLE");
  if (p.cancelled) return never("CANCELLED");
  if (tooOld(p.platform, p.kind, p.occurredAt, notBefore, p.leadCreatedAt, Math.max(now, Date.parse(notBefore)))) return never("TOO_OLD");
  if (Date.parse(notBefore) > now) return { state: "WAITING", reason: "HELD", notBefore };
  if (!p.connected) return { state: "WAITING", reason: "NOT_CONNECTED", notBefore };
  return { state: "QUEUED", reason: null, notBefore };
}

/**
 * The time an outcome is sent with. Meta's held booking is the booking
 * that held, dated when the hold ended; everything else is when it happened.
 */
export function eventTime(platform: Platform, kind: OutcomeKind, occurredIso: string, notBeforeIso: string): string {
  return platform === "META" && kind === "BOOKED" ? notBeforeIso : occurredIso;
}

/** Past what each platform will take, at the moment it would be sent. */
export function tooOld(platform: Platform, kind: OutcomeKind, occurredIso: string, notBeforeIso: string, leadCreatedIso: string, sendMs: number): boolean {
  if (platform === "META") {
    const t = Date.parse(kind === "BOOKED" ? notBeforeIso : occurredIso);
    return sendMs - t > META_MAX_AGE_DAYS * DAY;
  }
  return sendMs - Date.parse(leadCreatedIso) > GOOGLE_CLICK_DAYS * DAY;
}

/**
 * A send whose answer never came back. Google treats a repeated transaction
 * id as the same conversion, so it is sent again. Meta documents its
 * dedupe only for 48 hours, so it is sent again inside that and not after.
 */
export function resendLost(platform: Platform, triedIso: string, nowIso: string): boolean {
  if (platform === "GOOGLE") return true;
  return Date.parse(nowIso) - Date.parse(triedIso) < META_RESEND_HOURS * 3_600_000;
}

/** The wait before trying again: 15 minutes, doubling, at most a day. */
export function retryDelayMs(attempts: number): number {
  return Math.min(DAY, 15 * 60_000 * 2 ** Math.max(0, attempts - 1));
}

// ---------------------------------------------------------------------------
// The requests
// ---------------------------------------------------------------------------

const META_EVENT: Record<Exclude<OutcomeKind, "CANCELLED">, string> = {
  QUALIFIED: "Qualified",
  VISIT_DONE: "SiteVisitDone",
  BOOKED: "BookingConfirmed",
  AGREEMENT: "AgreementSigned",
  REGISTERED: "Registered",
};

export const metaEventName = (k: OutcomeKind) => (k === "CANCELLED" ? null : META_EVENT[k]);

/** The name Meta shows as where these outcomes came from. */
export const LEAD_EVENT_SOURCE = "Sales Desk";

/**
 * One Conversions API event, as the `data` field's JSON text.
 *
 * Built as text rather than handed to `JSON.stringify` because a leadgen id
 * is up to 17 digits, past what a JavaScript number holds exactly, and Meta
 * rejects an event whose lead id is wrong.
 */
export function metaEventJson(e: {
  id: string;
  kind: OutcomeKind;
  eventTimeIso: string;
  value: number;
  lineage: OutcomeLineage;
  phoneHash: string | null;
}): string | null {
  const name = metaEventName(e.kind);
  if (!name) return null;
  const user: Record<string, unknown> = {};
  if (e.phoneHash) user.ph = [e.phoneHash];
  if (e.lineage.fbc) user.fbc = e.lineage.fbc;
  const lead = e.lineage.leadgenId && /^\d{10,20}$/.test(e.lineage.leadgenId) ? e.lineage.leadgenId : null;
  if (lead) user.lead_id = "__LEAD_ID__";
  const event = {
    event_name: name,
    event_time: Math.floor(Date.parse(e.eventTimeIso) / 1000),
    event_id: e.id,
    action_source: "system_generated",
    user_data: user,
    custom_data: { event_source: "crm", lead_event_source: LEAD_EVENT_SOURCE, value: e.value, currency: "INR" },
  };
  const text = JSON.stringify([event]);
  return lead ? text.replace('"__LEAD_ID__"', lead) : text;
}

/** ISO 8601 with India's offset, the form Data Manager's examples use. */
export function istTimestamp(iso: string): string {
  const ist = new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 19);
  return `${ist}+05:30`;
}

/** One Data Manager `events:ingest` request for one outcome. */
export function googleIngestBody(e: {
  id: string;
  eventTimeIso: string;
  value: number;
  gclid: string;
  phoneHash: string | null;
  customerId: string;
  loginCustomerId: string | null;
  actionId: string;
}): Record<string, unknown> {
  return {
    destinations: [
      {
        operatingAccount: { accountType: "GOOGLE_ADS", accountId: e.customerId },
        ...(e.loginCustomerId ? { loginAccount: { accountType: "GOOGLE_ADS", accountId: e.loginCustomerId } } : {}),
        productDestinationId: e.actionId,
      },
    ],
    encoding: "HEX",
    // The buyer agreed to measurement and to nothing more.
    consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_DENIED" },
    events: [
      {
        adIdentifiers: { gclid: e.gclid },
        eventTimestamp: istTimestamp(e.eventTimeIso),
        transactionId: e.id,
        eventSource: "OTHER",
        conversionValue: e.value,
        currency: "INR",
        ...(e.phoneHash ? { userData: { userIdentifiers: [{ phoneNumber: e.phoneHash }] } } : {}),
      },
    ],
  };
}

/** The Google conversion actions we create, one per outcome. */
export const GOOGLE_ACTIONS: Record<Exclude<OutcomeKind, "CANCELLED">, { name: string; category: string; primary: boolean }> = {
  // Qualified is the bid event: the only outcome with the volume to learn on.
  QUALIFIED: { name: "Sales Desk: Qualified lead", category: "QUALIFIED_LEAD", primary: true },
  VISIT_DONE: { name: "Sales Desk: Site visit done", category: "BOOK_APPOINTMENT", primary: false },
  BOOKED: { name: "Sales Desk: Booking confirmed", category: "CONVERTED_LEAD", primary: false },
  AGREEMENT: { name: "Sales Desk: Agreement signed", category: "CONVERTED_LEAD", primary: false },
  REGISTERED: { name: "Sales Desk: Registered", category: "CONVERTED_LEAD", primary: false },
};

// ---------------------------------------------------------------------------
// What a person reads
// ---------------------------------------------------------------------------

const PLATFORM_WORD: Record<Platform, string> = { META: "Meta", GOOGLE: "Google" };

const NOT_SENT_WORDS: Record<Reason, string> = {
  NO_CONSENT: "not sent: the buyer did not agree to ad measurement",
  OPTED_OUT: "not sent: the buyer opted out",
  NOT_MATCHABLE: "not sent: no click or lead id to match it to an ad",
  NOT_CONNECTED: "waiting for the account to be chosen in Settings",
  NEEDS_RECONNECT: "waiting: the connection needs reconnecting in Settings",
  NOT_SWITCHED_ON: "waiting: not switched on for Sales Desk yet",
  ACTION_NEW: "sending shortly",
  HELD: "sends once the booking has stood",
  CANCELLED: "not sent: the booking was cancelled",
  TOO_OLD: "not sent: too late for the platform to accept",
  REFUSED: "refused by the platform",
  NO_ANSWER: "sent, answer not confirmed",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "27 Oct", on the IST calendar, the way the rest of the console writes a day. */
const showDay = (iso: string) => {
  const d = new Date(Date.parse(iso) + 330 * 60_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

// ---------------------------------------------------------------------------
// Bidding on qualified buyers
// ---------------------------------------------------------------------------

/**
 * An ad account may optimise its new ad sets for the Qualified outcome once
 * it has brought this many leads over the last `QUALIFIED_BID_DAYS`: below
 * that, too few buyers are qualified for Meta to learn from, and the ad set
 * would sit in learning spending on nobody.
 */
export const QUALIFIED_BID_LEADS = 200;
export const QUALIFIED_BID_DAYS = 30;

export function qualifiedBidding(leads: number): { ready: boolean; needed: number } {
  const n = Math.max(0, Math.floor(leads));
  return { ready: n >= QUALIFIED_BID_LEADS, needed: Math.max(0, QUALIFIED_BID_LEADS - n) };
}

/** The custom conversion made on the dataset, found again by this name. */
export const QUALIFIED_CONVERSION_NAME = "Sales Desk Qualified buyer";

/**
 * Meta's custom conversion rule for the event the uploader sends as
 * Qualified (`metaEventName("QUALIFIED")`), so the ad set optimises for
 * exactly what the attribution reports and nothing typed twice.
 */
export function qualifiedConversionRule(): string {
  return JSON.stringify({ and: [{ event: { eq: metaEventName("QUALIFIED") } }] });
}

/**
 * The campaign objective and the ad set's goal for a new Meta ad. Clicks by
 * default; with qualified bidding on, leads as the objective and the custom
 * conversion on the dataset as what the ad set is delivered for.
 */
export function metaAdGoal(optimise: { datasetId: string; conversionId: string } | null): {
  objective: string;
  adset: Record<string, unknown>;
} {
  if (!optimise) return { objective: "OUTCOME_TRAFFIC", adset: { billing_event: "IMPRESSIONS", optimization_goal: "LINK_CLICKS" } };
  return {
    objective: "OUTCOME_LEADS",
    adset: {
      billing_event: "IMPRESSIONS",
      optimization_goal: "OFFSITE_CONVERSIONS",
      promoted_object: { pixel_id: optimise.datasetId, custom_event_type: "OTHER", custom_conversion_id: optimise.conversionId },
    },
  };
}

/**
 * A Leads ad's goal on an account bidding on qualified buyers: Meta's
 * conversion leads, which delivers the form to people like those whose
 * leads became Qualified in the stages the uploader sends, not to whoever
 * submits most cheaply. Meta reports about a fifth less per qualified lead.
 * Without it, the leads themselves.
 */
export function metaLeadsGoal(optimise: { datasetId: string } | null, pageId: string): Record<string, unknown> {
  return optimise
    ? { billing_event: "IMPRESSIONS", optimization_goal: "QUALITY_LEAD", promoted_object: { page_id: pageId, pixel_id: optimise.datasetId } }
    : { billing_event: "IMPRESSIONS", optimization_goal: "LEAD_GENERATION", promoted_object: { page_id: pageId } };
}

/** One line per upload: "Meta: sent 12 Sep", "Google: sends 20 Oct". */
export function uploadLine(u: { platform: Platform; state: UploadState; reason: Reason | null; notBefore: string; sentAt: string | null }): { text: string; tone: "ok" | "wait" | "off" | "bad" } {
  const who = PLATFORM_WORD[u.platform];
  if (u.state === "SENT") return { text: `${who}: sent ${u.sentAt ? showDay(u.sentAt) : ""}`.trim(), tone: "ok" };
  if (u.state === "QUEUED" || u.state === "SENDING") return { text: `${who}: sending`, tone: "wait" };
  if (u.state === "WAITING" && u.reason === "HELD") return { text: `${who}: sends ${showDay(u.notBefore)} if it stands`, tone: "wait" };
  if (u.state === "WAITING") return { text: `${who}: ${NOT_SENT_WORDS[u.reason ?? "NOT_CONNECTED"]}`, tone: "wait" };
  if (u.state === "FAILED") return { text: `${who}: ${NOT_SENT_WORDS[u.reason ?? "REFUSED"]}`, tone: "bad" };
  return { text: `${who}: ${NOT_SENT_WORDS[u.reason ?? "NO_CONSENT"]}`, tone: "off" };
}
