/**
 * A WhatsApp broadcast: one approved post to many of a project's own leads,
 * from the developer's own number. Pure and database-free, client-safe,
 * covered by `check:logic`.
 *
 * Five rules live here.
 *
 * **One fixed template, filed twice.** A new template per broadcast would
 * wait up to a day for review, start paced every time, and use up an
 * unverified account's 250 templates. So the message is one MARKETING
 * template per language version with the post's picture as its header and
 * three blanks (the buyer's first name, the project, one line of the post's
 * cleared copy), filed in two wordings that are rotated, so one paused
 * template never silences every broadcast (`BROADCAST_TEMPLATES`).
 *
 * **Who is left out is counted, in order.** `audience()` walks every
 * candidate through the same ordered checks and counts each exclusion under
 * its reason, so the screen can say "212 left out: 140 no consent, 50 on a
 * partner's claim..." and never show a number.
 *
 * **Caps across broadcasts and the drip.** One broadcast per person per 7
 * days, and four marketing WhatsApps per 30 days whatever sent them
 * (`capsFor()`). Decided with the client on 28 September 2026.
 *
 * **Gates cheapest first** (`BROADCAST_GATES`, `firstRefusal()`): what can
 * be answered once per batch first (the registration and the post), then
 * each person's own, the wallet last.
 *
 * **A ceiling on everything a person controls.** A broadcast reaches at most
 * `MAX_BROADCAST_RECIPIENTS`, an organisation at most `ORG_DAILY_BROADCASTS`
 * a day, and never more than the number's own daily limit at Meta.
 */

import { CALLING_HOURS, istHour } from "./calling-hours.ts";
import { passThroughPaise } from "./billing-rules.ts";
import { PRICE_PAISE, PURPOSES, TEMPLATES, VOICES, versionOf, voiceFor, type Template, type Voice } from "./message-rules.ts";
import type { StageKey } from "./lead-rules.ts";

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/** What a tap on the template's button sends back, before the broadcast's id. */
export const STOP_PAYLOAD = "STOP_PROMO";

const STOP_BUTTON = ["Stop promotions"] as const;

/**
 * Two wordings of the same message, each in three versions (Hinglish under
 * the plain name, `_en`, `_mr`), all Roman script and all filed as `en`.
 * Every body starts and ends with words, keeps its blanks apart, and puts
 * more than twenty fixed words around three blanks, which is what Meta's
 * review asks of a template whose blanks carry the message.
 */
export const BROADCAST_TEMPLATES: readonly Template[] = [
  {
    purpose: "BROADCAST",
    name: "salesdesk_broadcast_a",
    category: "MARKETING",
    namesProject: true,
    aboutVisit: false,
    aboutBooking: false,
    promotional: true,
    blanks: ["first_name", "project", "ad_line"],
    header: "IMAGE",
    body: "Hi {{1}}, {{2}} se aapke liye ek nayi khabar: {{3}} Site visit ya poori details ke liye yahin reply kijiye, hamari team aapko call karegi.",
    footer: "Promotions band karne ke liye neeche tap karein.",
    buttons: STOP_BUTTON,
    label: "Broadcast",
    versions: {
      ENGLISH: {
        body: "Hi {{1}}, here is something new from {{2}} for you: {{3}} To know more or book a site visit, just reply here and our team will call you.",
        footer: "Tap below to stop promotions.",
        buttons: STOP_BUTTON,
      },
      MARATHI: {
        body: "Namaskar {{1}}, {{2}} kadun tumchyasathi ek navin mahiti aali aahe: {{3}} Site visit kiva sampurna mahitisathi ithech reply kara, aamchi team lavkarach tumhala call karel.",
        footer: "Promotions band karnyasathi khali tap kara.",
        buttons: STOP_BUTTON,
      },
    },
  },
  {
    purpose: "BROADCAST",
    name: "salesdesk_broadcast_b",
    category: "MARKETING",
    namesProject: true,
    aboutVisit: false,
    aboutBooking: false,
    promotional: true,
    blanks: ["first_name", "project", "ad_line"],
    header: "IMAGE",
    body: "Namaste {{1}}! {{2}} ki taraf se ek update aapke liye: {{3}} Zyada jaanne ya site dekhne ke liye bas yahin reply karein, hum aapse sampark karenge.",
    footer: "Promotions nahi chahiye? Neeche tap karein.",
    buttons: STOP_BUTTON,
    label: "Broadcast",
    versions: {
      ENGLISH: {
        body: "Hello {{1}}! An update from {{2}} that you may like: {{3}} Reply here to see the site or to know more, and we will get back to you soon.",
        footer: "Not interested in promotions? Tap below.",
        buttons: STOP_BUTTON,
      },
      MARATHI: {
        body: "Namaskar {{1}}! {{2}} kadun tumchyasathi ek khas update: {{3}} Adhik mahiti kiva site pratyaksha pahnyasathi ithech reply kara, aamhi nakki lavkarach tumchyashi sampark karu.",
        footer: "Promotions nako asatil tar khali tap kara.",
        buttons: STOP_BUTTON,
      },
    },
  },
];

/** Every version of both wordings: what is submitted to Meta beside the lead engine's catalog. */
export const BROADCAST_CATALOG: readonly Template[] = BROADCAST_TEMPLATES.flatMap((t) => VOICES.map((v) => versionOf(t, v)));

/**
 * The wording a broadcast is sent in: rotated by the broadcast's id, and the
 * other one when Meta has paused or refused the first.
 */
export function wordingFor(broadcastId: string, voice: Voice, approved: (name: string) => boolean): Template | null {
  const order = parseInt(broadcastId.replace(/[^0-9a-f]/gi, "").slice(-2) || "0", 16) % 2 === 0 ? [0, 1] : [1, 0];
  for (const i of order) {
    const t = versionOf(BROADCAST_TEMPLATES[i], voice);
    if (approved(t.name)) return t;
  }
  return null;
}

/**
 * The one line of copy a broadcast carries: the post's own cleared headline
 * and the first sentence of its body, on one line, ending in a full stop so
 * the template's next sentence reads on. Only the post's own words: the
 * whole of them was cleared, so a part of them is cleared too. Null when
 * there is nothing to say.
 */
export const LINE_MAX = 200;

export function adLine(copy: { headline: string; body: string }): string | null {
  const clean = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const headline = clean(copy.headline).replace(/[.!?:;,\s]+$/, "");
  const first = clean(copy.body).split(/(?<=[.!?])\s+/)[0]?.replace(/[.!?:;,\s]+$/, "") ?? "";
  const parts = [headline, first].filter(Boolean);
  if (!parts.length) return null;
  let line = parts.join(". ");
  if (line.length > LINE_MAX - 1) line = headline.slice(0, LINE_MAX - 1).replace(/\s+\S*$/, "");
  return line ? `${line}.` : null;
}

// ---------------------------------------------------------------------------
// Who a broadcast may reach
// ---------------------------------------------------------------------------

/** One lead considered for a broadcast, read in one query. Never a number on screen. */
export type Candidate = {
  leadId: string;
  /** E.164, used only to tell two leads of one person apart and to read the country. */
  phone: string;
  language: string | null;
  stage: StageKey;
  channel: string;
  /** A STOP on WhatsApp or an opt-out on a call: stops everything. */
  optedOut: boolean;
  /** "Stop promotions" or WhatsApp's own setting: stops marketing. */
  marketingStopped: boolean;
  /** A WhatsApp consent on file here, not expired. */
  consent: boolean;
  /** A partner's live claim covers this lead. */
  partnerClaim: boolean;
  /** Broadcast messages to this number in the last 7 days. */
  broadcasts7d: number;
  /** Promotions (broadcasts and the drip's nudges) to this number in the last 30 days. */
  marketing30d: number;
  /** On the DND register with no operator-registered consent, as far as we know. */
  dnd: boolean;
  /** When the lead last did anything, to keep the newest of one person's leads. */
  activeAt: string;
};

export type Exclusion =
  | "OPTED_OUT"
  | "MARKETING_STOPPED"
  | "NO_CONSENT"
  | "PARTNER"
  | "CRM_NO_CONSENT"
  | "CLOSED"
  | "STAGE"
  | "LANGUAGE"
  | "CAP_7D"
  | "CAP_30D"
  | "DND"
  | "US_NUMBER"
  | "SAME_PERSON"
  | "OVER_CAP";

/** In the order they are asked. */
export const EXCLUSIONS: readonly Exclusion[] = [
  "SAME_PERSON",
  "OPTED_OUT",
  "MARKETING_STOPPED",
  "NO_CONSENT",
  "PARTNER",
  "CRM_NO_CONSENT",
  "CLOSED",
  "STAGE",
  "LANGUAGE",
  "CAP_7D",
  "CAP_30D",
  "DND",
  "US_NUMBER",
  "OVER_CAP",
];

/** What the screen calls each, in the client's words. */
export const EXCLUSION_WORDS: Record<Exclusion, string> = {
  OPTED_OUT: "Asked not to be contacted",
  MARKETING_STOPPED: "Stopped promotions",
  NO_CONSENT: "No WhatsApp consent",
  PARTNER: "A partner's buyer",
  CRM_NO_CONSENT: "From your CRM, no WhatsApp consent here",
  CLOSED: "Booked or lost",
  STAGE: "Not at the stages chosen",
  LANGUAGE: "Another language",
  CAP_7D: "Had a broadcast this week",
  CAP_30D: "Four promotions this month already",
  DND: "On the DND register",
  US_NUMBER: "US number (WhatsApp sends them no promotions)",
  SAME_PERSON: "Same buyer, another lead",
  OVER_CAP: "Past the schedule's limit for one post",
};

/**
 * What counts as a promotion for the cap and for "Stop promotions": the
 * catalog's promotional messages and every broadcast. Not Meta's MARKETING
 * category, which also holds a buyer's own token link and slot offer.
 */
export const PROMOTIONAL_PURPOSES: readonly string[] = [...PURPOSES.filter((p) => TEMPLATES[p].promotional), "BROADCAST"];

/** At most one broadcast a week, and four promotions in thirty days, per person. */
export const CAP_BROADCASTS_7D = 1;
export const CAP_MARKETING_30D = 4;

export function capsFor(c: { broadcasts7d: number; marketing30d: number }): "CAP_7D" | "CAP_30D" | null {
  if (c.broadcasts7d >= CAP_BROADCASTS_7D) return "CAP_7D";
  if (c.marketing30d >= CAP_MARKETING_30D) return "CAP_30D";
  return null;
}

export type AudienceFilter = {
  /** Empty: every open stage. */
  stages: readonly StageKey[];
  /** Null: every lead, each in their own version. */
  voice: Voice | null;
};

export type Audience = {
  included: { leadId: string; voice: Voice; activeAt: string }[];
  excluded: Partial<Record<Exclusion, number>>;
  byVoice: Partial<Record<Voice, number>>;
};

/**
 * Who a broadcast reaches, and who it leaves out and why. The first check a
 * lead fails is the one it is counted under, so the counts add up to the
 * candidates. One person with two leads here is reached once, on the newest.
 */
export function audience(candidates: readonly Candidate[], filter: AudienceFilter): Audience {
  const out: Audience = { included: [], excluded: {}, byVoice: {} };
  const skip = (r: Exclusion) => void (out.excluded[r] = (out.excluded[r] ?? 0) + 1);
  const stages = new Set(filter.stages);

  // One person, one message: their newest lead speaks for them, and a
  // booking on any of their leads here means no advertisement at all.
  const people = new Map<string, { newest: Candidate; booked: boolean }>();
  for (const c of candidates) {
    const p = people.get(c.phone);
    if (!p) {
      people.set(c.phone, { newest: c, booked: c.stage === "booked" });
      continue;
    }
    skip("SAME_PERSON");
    p.booked ||= c.stage === "booked";
    if (Date.parse(c.activeAt) > Date.parse(p.newest.activeAt)) p.newest = c;
  }

  for (const { newest: c, booked } of people.values()) {
    const voice = voiceFor(c.language);
    const crm = c.channel === "CRM";
    const why: Exclusion | null = c.optedOut
      ? "OPTED_OUT"
      : c.marketingStopped
        ? "MARKETING_STOPPED"
        : !c.consent && !crm
          ? "NO_CONSENT"
          : c.partnerClaim
            ? "PARTNER"
            : !c.consent && crm
              ? "CRM_NO_CONSENT"
              : booked || c.stage === "lost"
                ? "CLOSED"
                : stages.size && !stages.has(c.stage)
                  ? "STAGE"
                  : filter.voice && voice !== filter.voice
                    ? "LANGUAGE"
                    : (capsFor(c) ?? (c.dnd ? "DND" : c.phone.startsWith("+1") ? "US_NUMBER" : null));
    if (why) {
      skip(why);
      continue;
    }
    out.included.push({ leadId: c.leadId, voice, activeAt: c.activeAt });
    out.byVoice[voice] = (out.byVoice[voice] ?? 0) + 1;
  }
  return out;
}

/**
 * A schedule's broadcast reaches at most its own limit a post: the buyers
 * most recently active first, and the rest counted as left out, so the
 * counts still add up.
 */
export function withinCap(a: Audience, limit: number | null): Audience {
  if (limit === null || a.included.length <= limit) return a;
  const kept = [...a.included]
    .sort((x, y) => Date.parse(y.activeAt) - Date.parse(x.activeAt) || (x.leadId < y.leadId ? -1 : 1))
    .slice(0, Math.max(0, limit));
  const byVoice: Partial<Record<Voice, number>> = {};
  for (const k of kept) byVoice[k.voice] = (byVoice[k.voice] ?? 0) + 1;
  return {
    included: kept,
    excluded: { ...a.excluded, OVER_CAP: (a.excluded.OVER_CAP ?? 0) + a.included.length - kept.length },
    byVoice,
  };
}

/**
 * A schedule's broadcast rides in `post_schedules.destinations` beside the
 * publications, under this name, with its own limit a post: a schedule that
 * broadcasts every post decides the spend once, so it says how far.
 */
export const BROADCAST_DESTINATION = "WHATSAPP_BROADCAST";

export function broadcastCapProblem(cap: number | null): string | null {
  if (cap === null || !Number.isInteger(cap) || cap < 1) return "Say how many people each broadcast may reach.";
  if (cap > MAX_BROADCAST_RECIPIENTS) {
    return `A broadcast reaches at most ${MAX_BROADCAST_RECIPIENTS.toLocaleString("en-IN")} people.`;
  }
  return null;
}

/** The stages a person may pick: the open ones. */
export const PICKABLE_STAGES: readonly StageKey[] = [
  "new",
  "contacted",
  "qualified",
  "visit_scheduled",
  "visit_done",
  "negotiation",
  "nurture",
];

export function pickStages(raw: readonly string[]): StageKey[] {
  const want = new Set(raw);
  return PICKABLE_STAGES.filter((s) => want.has(s));
}

export function pickVoice(raw: string | null | undefined): Voice | null {
  return raw === "ENGLISH" || raw === "HINGLISH" || raw === "MARATHI" ? raw : null;
}

// ---------------------------------------------------------------------------
// Money and ceilings
// ---------------------------------------------------------------------------

/** A broadcast reaches at most this many people. */
export const MAX_BROADCAST_RECIPIENTS = 5_000;
/** An organisation's broadcasts reach at most this many people in an IST day. */
export const ORG_DAILY_BROADCASTS = 5_000;
/** Sent per worker pass. */
export const BROADCAST_BATCH = 200;
/** How long a worker holds a broadcast. */
export const BROADCAST_LEASE_MS = 5 * 60_000;
/** A media id lives 30 days at Meta; one older than this is uploaded again. */
export const MEDIA_ID_DAYS = 29;

/** What Meta charges us for the broadcast, and what the client's credit is drawn, in paise. */
export function estimate(people: number): { costPaise: number; billedPaise: number } {
  const costPaise = people * PRICE_PAISE.MARKETING;
  return { costPaise, billedPaise: people * passThroughPaise(PRICE_PAISE.MARKETING) };
}

/** Rupees as the trade writes them: Rs 1,000 and Rs 1,25,000. */
export function showPaise(paise: number): string {
  const rupees = paise / 100;
  return `Rs ${rupees.toLocaleString("en-IN", { maximumFractionDigits: rupees < 100 ? 2 : 0 })}`;
}

/**
 * How many may go this pass: the batch, the organisation's day, and the
 * number's own daily limit at Meta less what it already reached. An
 * unknown limit is read as the lowest, 250.
 */
export function batchSize(o: { tierPeople: number | null; reached24h: number; orgToday: number }): number {
  const tier = o.tierPeople === null ? Number.POSITIVE_INFINITY : o.tierPeople;
  return Math.max(0, Math.min(BROADCAST_BATCH, tier - o.reached24h, ORG_DAILY_BROADCASTS - o.orgToday));
}

// ---------------------------------------------------------------------------
// Each message, when it goes
// ---------------------------------------------------------------------------

export type Gate =
  | "NOT_ADVERTISABLE"
  | "POST"
  | "OPTED_OUT"
  | "MARKETING_STOPPED"
  | "OUTSIDE_HOURS"
  | "NO_CONSENT"
  | "CAP_7D"
  | "CAP_30D"
  | "DND"
  | "NOT_APPROVED"
  | "NO_CREDIT";

/** In the order they are asked: the batch's two first, the wallet last. */
export const BROADCAST_GATES: readonly Gate[] = [
  "NOT_ADVERTISABLE",
  "POST",
  "OPTED_OUT",
  "MARKETING_STOPPED",
  "OUTSIDE_HOURS",
  "NO_CONSENT",
  "CAP_7D",
  "CAP_30D",
  "DND",
  "NOT_APPROVED",
  "NO_CREDIT",
];

/** The first gate that says no, or null. A gate missing from `failed` passed. */
export function firstRefusal(failed: Partial<Record<Gate, boolean>>): Gate | null {
  return BROADCAST_GATES.find((g) => failed[g]) ?? null;
}

/** Marketing goes out between 10:00 and 21:00 IST only. */
export const inBroadcastHours = (nowIso: string) => {
  const h = istHour(nowIso);
  return h >= CALLING_HOURS.from && h < CALLING_HOURS.to;
};

/** The next 10:00 IST at or after `nowIso`, when a broadcast outside hours resumes. */
export function nextOpening(nowIso: string): string {
  const now = Date.parse(nowIso);
  const ist = new Date(now + 330 * 60_000);
  const opening = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), CALLING_HOURS.from) - 330 * 60_000;
  return new Date(opening > now ? opening : opening + 86_400_000).toISOString();
}

/** Where a gate that stops the whole broadcast leaves it. */
export const HALTING: Partial<Record<Gate, "REGISTRATION" | "POST">> = {
  NOT_ADVERTISABLE: "REGISTRATION",
  POST: "POST",
};

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export type BroadcastStatus = "DRAFT" | "APPROVED" | "SENDING" | "DONE" | "HALTED" | "CANCELLED";

export const canApprove = (s: BroadcastStatus) => s === "DRAFT";
export const canStop = (s: BroadcastStatus) => s === "DRAFT" || s === "APPROVED" || s === "SENDING";
export const isLive = (s: BroadcastStatus) => s === "APPROVED" || s === "SENDING";

export const STATUS_PILL: Record<BroadcastStatus, { text: string; tone: "ok" | "warn" | "risk" | "quiet" | "blue" }> = {
  DRAFT: { text: "Not approved", tone: "quiet" },
  APPROVED: { text: "Waiting to send", tone: "blue" },
  SENDING: { text: "Sending", tone: "blue" },
  DONE: { text: "Sent", tone: "ok" },
  HALTED: { text: "Stopped by a check", tone: "risk" },
  CANCELLED: { text: "Stopped", tone: "quiet" },
};

export const HALT_WORDS: Record<string, string> = {
  REGISTRATION: "The project stopped being advertisable.",
  POST: "The post no longer clears its checks.",
  QUALITY: "Meta rates the number's quality low.",
  NUMBER: "The WhatsApp number stopped working.",
  TEMPLATE: "Meta has not approved the broadcast message.",
  STOPPED: "Stopped by a person.",
};

/** Whether a quick-reply payload is a broadcast's "Stop promotions". */
export const isStopPayload = (payload: string | null | undefined) =>
  typeof payload === "string" && payload.startsWith(`${STOP_PAYLOAD}:`);

/** Words a buyer may type that mean "no more promotions", short of a full STOP. */
export function isStopPromotions(text: string): boolean {
  return /^(stop promotions?|no promotions?|unsubscribe from promos?)$/i.test(text.trim().replace(/[.!]+$/, ""));
}

// ---------------------------------------------------------------------------
// Which picture a post broadcasts
// ---------------------------------------------------------------------------

export type BroadcastPicture = { ok: true; index: number } | { ok: false; reason: string };

/**
 * A broadcast carries one picture: an image post's own, or a carousel's
 * cover. A video has no picture of its own to send, and a hoarding or a
 * display banner is a shape nobody reads on a phone.
 */
export function broadcastPicture(post: {
  kind: "IMAGE" | "CAROUSEL" | "VIDEO";
  placement: string | null;
  media: readonly { type: string; bytes?: number }[];
}): BroadcastPicture {
  if (post.kind === "VIDEO") return { ok: false, reason: "A broadcast sends a picture. Make an image of this card to send it." };
  if (post.placement === "Hoarding" || post.placement === "Google display") {
    return { ok: false, reason: "This size is made for a hoarding or a banner. Broadcast a feed or story image." };
  }
  const first = post.media[0];
  if (!first) return { ok: false, reason: "This post has no picture." };
  if (first.type !== "image/jpeg" && first.type !== "image/png") return { ok: false, reason: "WhatsApp takes a JPEG or PNG picture." };
  if ((first.bytes ?? 0) > 5 * 1024 * 1024) return { ok: false, reason: "The picture is over WhatsApp's 5 MB." };
  return { ok: true, index: 0 };
}
