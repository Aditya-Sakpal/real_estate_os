/**
 * Each developer's own calling number: the pure half.
 *
 * Which number a call goes out from, whether one more may be rented, what a
 * city search asks Vobiz for, and how Vobiz's list of numbers is read. No
 * database and no network, so `check:logic` covers all of it, and the
 * screen may import it.
 *
 * The rule a call follows (`callerLine()`):
 *   1. the deepest active number of the tenant's own at or above the lead's
 *      node, the way a WhatsApp number is chosen (`numberFor()`);
 *   2. a tenant that holds a number but none covering this place is refused,
 *      never handed the shared number or anybody else's;
 *   3. a tenant with no number of its own uses the shared number only while
 *      it is not billed LIVE, which keeps today's behaviour for everybody
 *      already calling; a LIVE tenant with none is refused.
 */

import { numberFor } from "./wa-rules.ts";
import { ADD_ONS, COST_PAISE } from "./billing-rules.ts";

/** What a month of a number costs us, and what it is sold at (doc/pricing.md). */
export const NUMBER_PRICE = {
  costPaise: COST_PAISE.NUMBER_MONTH,
  pricePaise: ADD_ONS.EXTRA_NUMBER.pricePaise,
} as const;

/** A tenant with no plan may rent this many; a plan decides for the rest. */
export const MAX_NUMBERS_PER_ORG = 10;

/** How many numbers one search shows. */
export const SEARCH_LIMIT = 12;

export type OwnNumber = {
  id: string;
  number: string;
  active: boolean;
  nodePath: string | null;
  connectionId: string | null;
  released: boolean;
};

export type Line =
  | { ok: true; from: string; connectionId: string | null; numberId: string | null; shared: boolean }
  | { ok: false; code: "NO_NUMBER_HERE" | "NO_NUMBER" | "OFF"; message: string };

export const LINE_WORDS = {
  NO_NUMBER_HERE: "None of your calling numbers is used for this project. Place one in Settings, Calling numbers.",
  NO_NUMBER: "Get a calling number of your own in Settings, Calling numbers before calls go out.",
  OFF: "Calling isn't set up for your account yet.",
} as const;

/** The number a call to a lead at `nodePath` goes out from. */
export function callerLine(o: { numbers: readonly OwnNumber[]; nodePath: string; live: boolean; shared: string | null }): Line {
  const held = o.numbers.filter((n) => !n.released);
  const own = numberFor(
    held.map((n) => ({ ...n, active: n.active && !!n.nodePath })),
    o.nodePath,
  );
  if (own) return { ok: true, from: own.number, connectionId: own.connectionId, numberId: own.id, shared: false };
  if (held.length) return { ok: false, code: "NO_NUMBER_HERE", message: LINE_WORDS.NO_NUMBER_HERE };
  if (o.live) return { ok: false, code: "NO_NUMBER", message: LINE_WORDS.NO_NUMBER };
  const shared = o.shared?.trim() ?? "";
  if (!isE164(shared)) return { ok: false, code: "OFF", message: LINE_WORDS.OFF };
  return { ok: true, from: shared, connectionId: null, numberId: null, shared: true };
}

export const isE164 = (s: string): boolean => /^\+[1-9][0-9]{7,14}$/.test(s);

// ---------------------------------------------------------------------------
// How many a tenant may hold
// ---------------------------------------------------------------------------

/**
 * Numbers the organisation's live plans include: each plan's own count plus
 * the extra numbers sold on it. Null when no plan was ever sold, and then
 * only `MAX_NUMBERS_PER_ORG` applies (billing rule 2: no plan sold, no
 * change).
 */
export function numbersAllowed(billed: boolean, plans: readonly { numbers: number; extra: number }[]): number | null {
  if (!billed) return null;
  return plans.reduce((s, p) => s + Math.max(0, p.numbers) + Math.max(0, p.extra), 0);
}

/** Why one more number may not be rented, or null. Asked before Vobiz is. */
export function rentProblem(o: { held: number; allowed: number | null }): string | null {
  if (o.held >= MAX_NUMBERS_PER_ORG) return `You already have ${MAX_NUMBERS_PER_ORG} calling numbers. Release one first.`;
  if (o.allowed === null) return null;
  if (o.allowed === 0) return "Your plan has no calling numbers. Ask us to add one to a project's plan.";
  if (o.held >= o.allowed) {
    return `Your plans include ${o.allowed} calling number${o.allowed === 1 ? "" : "s"}, and you have ${o.held}. Ask us for an extra number.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/** Cities and their STD codes, without the leading 0. */
export const CITY_CODES: readonly { city: string; code: string }[] = [
  { city: "Mumbai", code: "22" },
  { city: "Thane", code: "22" },
  { city: "Navi Mumbai", code: "22" },
  { city: "Pune", code: "20" },
  { city: "Delhi", code: "11" },
  { city: "Bengaluru", code: "80" },
  { city: "Hyderabad", code: "40" },
  { city: "Chennai", code: "44" },
  { city: "Kolkata", code: "33" },
  { city: "Ahmedabad", code: "79" },
  { city: "Nagpur", code: "712" },
  { city: "Nashik", code: "253" },
  { city: "Gurugram", code: "124" },
  { city: "Noida", code: "120" },
  { city: "Jaipur", code: "141" },
  { city: "Surat", code: "261" },
  { city: "Goa", code: "832" },
  { city: "Kochi", code: "484" },
  { city: "Lucknow", code: "522" },
  { city: "Chandigarh", code: "172" },
  { city: "Indore", code: "731" },
];

/**
 * Mobile-looking numbers (+91 92...), which Vobiz rents only to a business
 * that has done its KYC. Offered once the client's own sub-account is
 * verified, sold at the price of any number though they cost us Rs 1,000 a
 * month (the client, 28 October 2026).
 */
export const MOBILE_SERIES = "92";

/** Each area code once, with every city it serves: "22" is Mumbai, Thane and Navi Mumbai. */
export const AREAS: readonly { code: string; label: string }[] = (() => {
  const by = new Map<string, string[]>();
  for (const c of CITY_CODES) by.set(c.code, [...(by.get(c.code) ?? []), c.city]);
  return [...[...by].map(([code, cities]) => ({ code, label: cities.join(", ") })), { code: MOBILE_SERIES, label: "Mobile number (92 series)" }];
})();

/** What a person typed after the area code to narrow the list: up to six digits, or nothing. */
export function readStarts(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/[^0-9]/g, "");
  return d ? d.slice(0, 6) : null;
}

const ALIASES: Record<string, string> = { bangalore: "Bengaluru", bombay: "Mumbai", gurgaon: "Gurugram", "new delhi": "Delhi", calcutta: "Kolkata", madras: "Chennai" };

export type Search = { ok: true; city: string | null; code: string; pattern: string } | { ok: false; message: string };

/** What a person typed, as a search Vobiz can answer: a city we know, or an STD code. */
export function readSearch(raw: string): Search {
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return { ok: false, message: "Type a city or an area code." };
  const digits = t.replace(/^\+?91[\s-]?/, "").replace(/^0/, "");
  if (/^[0-9]{2,4}$/.test(digits)) {
    const known = CITY_CODES.find((c) => c.code === digits);
    return { ok: true, city: known?.city ?? (digits === MOBILE_SERIES ? "Mobile" : null), code: digits, pattern: `91${digits}` };
  }
  const name = ALIASES[t.toLowerCase()] ?? t;
  const found = CITY_CODES.find((c) => c.city.toLowerCase() === name.toLowerCase());
  if (!found) return { ok: false, message: `We can't search ${t} yet. Type its area code instead, e.g. 22 for Mumbai.` };
  return { ok: true, city: found.city, code: found.code, pattern: `91${found.code}` };
}

export type Available = { number: string; city: string | null; monthlyFeePaise?: number | null };

/** A number as Vobiz writes it (no plus, or ten digits), as E.164; null when it is not one. */
export function vobizToE164(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const d = String(raw).replace(/[^0-9]/g, "");
  if (d.length === 10 && /^[1-9]/.test(d)) return `+91${d}`;
  const e = `+${d}`;
  return isE164(e) ? e : null;
}

/** E.164 as Vobiz takes it in a path: digits only. */
export const vobizDigits = (e164: string): string => e164.replace(/^\+/, "");

/** The most a number may cost us a month and still be sold at its price, in rupees. */
export const MAX_MONTHLY_FEE_RUPEES = NUMBER_PRICE.costPaise / 100;
/** A 92-series number's month, which the client chose to sell at the ordinary price. */
export const MAX_MOBILE_FEE_RUPEES = 1000;

/**
 * Vobiz's list of numbers that can be rented, read forgivingly about shape
 * and strictly about content: an entry that is not a number, cannot take
 * voice, or does not start with the searched prefix is dropped, and so is
 * one Vobiz has blocked or marked spam, one that needs an Aadhaar check (the
 * 92 series), a special number, and one dearer a month than the price list
 * pays for.
 */
export function readAvailable(body: unknown, pattern: string | null = null, limit = SEARCH_LIMIT, opts: { kyc?: boolean } = {}): Available[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const list = [b.objects, b.numbers, b.items, b.data, body].find(Array.isArray) as unknown[] | undefined;
  if (!list) return [];
  const out: Available[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const it = (item ?? {}) as Record<string, unknown>;
    const n = vobizToE164(it.number ?? it.phone_number ?? it.e164 ?? (typeof item === "string" ? item : null));
    if (!n || seen.has(n)) continue;
    if (it.voice_enabled === false) continue;
    if (it.is_blocked === true || it.is_spam === true || it.special === true) continue;
    // A number that needs a verified business (the 92 series) only for a client that is one.
    const needsKyc = it.aadhaar_verification_required === true;
    if (needsKyc && !opts.kyc) continue;
    const most = needsKyc ? MAX_MOBILE_FEE_RUPEES : MAX_MONTHLY_FEE_RUPEES;
    if (typeof it.monthly_fee === "number" && it.monthly_fee > most) continue;
    if (pattern && !vobizDigits(n).startsWith(pattern)) continue;
    const region = [it.city, it.region, it.rate_center].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    seen.add(n);
    out.push({
      number: n,
      city: region ? titleCity(region) : null,
      monthlyFeePaise: typeof it.monthly_fee === "number" ? Math.round(it.monthly_fee * 100) : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** "MUMBAI, INDIA" as "Mumbai". */
function titleCity(s: string): string {
  const first = s.split(",")[0].trim().slice(0, 80);
  return first.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a: string, c: string) => a + c.toUpperCase());
}

/** Vobiz's list of the account's own numbers holds this one, and it is active. */
export function holdsNumber(body: unknown, e164: string): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  const list = [b.items, b.objects, b.numbers, b.data].find(Array.isArray) as Record<string, unknown>[] | undefined;
  return (list ?? []).some((n) => vobizToE164(n?.e164 ?? n?.number) === e164 && (n.status === undefined || /^active$/i.test(String(n.status))));
}

// ---------------------------------------------------------------------------
// The Vobiz voice app a number answers through
// ---------------------------------------------------------------------------

/** Where Sarvam takes a Vobiz call: the answer address of the voice app our numbers are linked to. */
export const SARVAM_VOBIZ_ANSWER = "https://apps.sarvam.ai/api/app-runtime/v1/channels/vobiz";

/**
 * The voice app a new number is linked to: the one named in `VOBIZ_APP_ID`,
 * else the account's app that hands calls to Sarvam. Two such apps and no
 * name is no answer, never a guess.
 */
export function sarvamVoiceApp(body: unknown, named: string | null): string | null {
  const list = ((body ?? {}) as { objects?: unknown }).objects;
  const apps = (Array.isArray(list) ? list : []) as { app_id?: unknown; answer_url?: unknown; enabled?: unknown }[];
  if (named) return apps.some((a) => String(a.app_id) === named) ? named : null;
  const sarvam = apps.filter((a) => typeof a.answer_url === "string" && a.answer_url.replace(/\/+$/, "") === SARVAM_VOBIZ_ANSWER && a.enabled !== false);
  return sarvam.length === 1 ? String(sarvam[0].app_id) : null;
}

/** Whether Vobiz's own list shows the number linked to the app. */
export function linkedTo(body: unknown, e164: string, appId: string): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  const list = [b.items, b.objects, b.numbers, b.data].find(Array.isArray) as Record<string, unknown>[] | undefined;
  return (list ?? []).some((n) => vobizToE164(n?.e164 ?? n?.number) === e164 && String(n.application_id ?? "") === appId);
}

// ---------------------------------------------------------------------------
// A number's month, metered
// ---------------------------------------------------------------------------

export type HeldNumber = { id: string; rentedAt: string; releasedAt: string | null; costPaise: number; nodeId: string | null };

export type NumberMonth = { numberId: string; period: string; sourceId: string; costPaise: number; atIso: string; nodeId: string | null };

/** The first instant of an IST month, as an ISO string. `ym` is 2026-09. */
const monthStart = (ym: string): number => Date.parse(`${ym}-01T00:00:00+05:30`);

/** The IST month an instant falls in, as 2026-09. */
export const istMonth = (iso: string): string => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 7);

function previousMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * The months each number is owed for: this IST month and the last one, for
 * every number held for any part of it (rented before it ended, not
 * released before it began). Vobiz bills a number's month whole, so a
 * number rented on the 30th is a month. The last month is asked too, so a
 * sweep missed at the turn of the month is caught by the next; the row is
 * keyed on the number and the month, so asking twice writes once.
 */
export function numberMonthsDue(numbers: readonly HeldNumber[], nowIso: string): NumberMonth[] {
  const now = istMonth(nowIso);
  const out: NumberMonth[] = [];
  for (const ym of [previousMonth(now), now]) {
    const from = monthStart(ym);
    const to = monthStart(nextMonth(ym));
    for (const n of numbers) {
      const rented = Date.parse(n.rentedAt);
      const released = n.releasedAt ? Date.parse(n.releasedAt) : null;
      if (!(rented < to) || (released !== null && released < from)) continue;
      out.push({
        numberId: n.id,
        period: `${ym}-01`,
        sourceId: `${n.id}:${ym}`,
        costPaise: Math.max(0, Math.round(n.costPaise)),
        // Counted in its own month, never the month the sweep ran in.
        atIso: new Date(Math.max(from, rented)).toISOString(),
        nodeId: n.nodeId,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tenant's own Sarvam connection
// ---------------------------------------------------------------------------

/**
 * A Sarvam connection id as typed: empty clears it; otherwise the shape
 * the column allows, never anything longer.
 */
export function readConnectionId(raw: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const t = raw.trim();
  if (!t) return { ok: true, value: null };
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(t)) return { ok: false, message: "A Sarvam connection id is letters, digits, dots, dashes and underscores." };
  return { ok: true, value: t };
}

/** What Sarvam said about a connection id, as a refusal, or null when it may be saved. */
export function connectionProblem(found: { exists: boolean; numbers: readonly string[] | null }, number: string): string | null {
  if (!found.exists) return "Sarvam has no connection with that id in our workspace.";
  // A connection that lists its numbers must carry this one; one that lists none is taken at its word.
  if (found.numbers && found.numbers.length && !found.numbers.includes(number)) {
    return "That Sarvam connection does not carry this number. Add the number to it in Sarvam first.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The client's own Vobiz sub-account and its KYC
// ---------------------------------------------------------------------------

/**
 * How a client is set up in law, as Vobiz's KYC asks it: a company verifies
 * with its PAN and GST or CIN, a person or a proprietor with PAN and Aadhaar
 * through DigiLocker.
 */
export const BUSINESS_TYPES = [
  { key: "private_limited", label: "Private limited company" },
  { key: "llp", label: "LLP" },
  { key: "partnership", label: "Partnership firm" },
  { key: "proprietorship", label: "Proprietorship" },
  { key: "public_limited", label: "Public limited company" },
  { key: "individual", label: "Individual" },
  { key: "trust", label: "Trust" },
  { key: "society", label: "Society" },
  { key: "huf", label: "HUF" },
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number]["key"];

export const readBusinessType = (v: unknown): BusinessType | null =>
  BUSINESS_TYPES.some((b) => b.key === v) ? (v as BusinessType) : null;

export const readKycEmail = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) && t.length <= 254 ? t : null;
};

export type KycStatus = "not_started" | "pending" | "verified" | "failed";
export type KycRead = { status: KycStatus; blocked: boolean; verifications: Record<string, string> };

/**
 * Vobiz's KYC status, read forgivingly about shape: the documented
 * `overall_status` and `verifications`, or the flat `kyc_status` and
 * `<doc>_status` fields the live API answers with. Calls are blocked unless
 * Vobiz says otherwise.
 */
export function readKycStatus(body: unknown): KycRead {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = String(b.overall_status ?? b.kyc_status ?? "").toLowerCase();
  const status: KycStatus =
    raw === "verified" || raw === "completed" ? "verified" : raw === "failed" || raw === "rejected" ? "failed" : raw === "pending" || raw === "in_progress" ? "pending" : "not_started";
  const verifications: Record<string, string> = {};
  const listed = b.verifications && typeof b.verifications === "object" ? (b.verifications as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(listed)) if (typeof v === "string") verifications[k] = v;
  for (const doc of ["pan", "gst", "cin", "aadhaar"]) {
    const v = b[`${doc}_status`];
    if (typeof v === "string" && !verifications[doc]) verifications[doc] = v;
  }
  const blocked = typeof b.kyc_calls_blocked === "boolean" ? b.kyc_calls_blocked : status !== "verified";
  return { status, blocked: status === "verified" ? blocked : true, verifications };
}

/** What the client reads about its verification. */
export const KYC_WORDS: Record<KycStatus, string> = {
  not_started: "Not verified yet",
  pending: "Being checked",
  verified: "Verified",
  failed: "Not verified",
};

/** Why a number may not be got yet, from the verification, or null. */
export function kycProblem(k: { status: KycStatus; blocked: boolean } | null): string | null {
  if (!k) return "Verify your business first. It is needed once, before your first number.";
  if (k.status === "verified" && !k.blocked) return null;
  if (k.status === "failed") return "Your business could not be verified. Check the details and verify again.";
  return "Your business is still being verified. Numbers open as soon as it is done.";
}

/** A person, a proprietor or an HUF gives Aadhaar through DigiLocker; a company does not. */
export const needsAadhaar = (t: BusinessType): boolean => t === "individual" || t === "proprietorship" || t === "huf";

/** Paid lookups a client may run in a day before we stop asking Vobiz. */
export const KYC_CHECKS_PER_DAY = 8;

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, "").toUpperCase() : "");
export const readPan = (v: unknown): string | null => (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(clean(v)) ? clean(v) : null);
export const readGstin = (v: unknown): string | null => (/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(clean(v)) ? clean(v) : null);
export const readCin = (v: unknown): string | null => (/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(clean(v)) ? clean(v) : null);

/** The PAN's fourth letter says who holds it: P a person, C a company, F a firm or LLP, H an HUF, T a trust, A or B a society. */
const PAN_HOLDER: Record<BusinessType, readonly string[]> = {
  individual: ["P"],
  proprietorship: ["P"],
  huf: ["H"],
  private_limited: ["C"],
  public_limited: ["C"],
  llp: ["F"],
  partnership: ["F"],
  trust: ["T"],
  society: ["A", "B", "T"],
};

export type KycDocs = { pan: string; gstin: string | null; cin: string | null };

/**
 * What the client typed, checked before any paid lookup: the PAN in its
 * shape and of the right holder, and for a company a GSTIN (on the same PAN)
 * or a CIN.
 */
export function readKycDocs(type: BusinessType, raw: { pan?: unknown; gstin?: unknown; cin?: unknown }): { ok: true; docs: KycDocs } | { ok: false; message: string } {
  const pan = readPan(raw.pan);
  if (!pan) return { ok: false, message: "Enter the PAN as it is printed, e.g. ABCDE1234F." };
  if (!PAN_HOLDER[type].includes(pan[3])) {
    const who = needsAadhaar(type) && type !== "huf" ? "a person's" : "the business's own";
    return { ok: false, message: `That PAN does not belong to ${BUSINESS_TYPES.find((b) => b.key === type)!.label.toLowerCase()}. Enter ${who} PAN.` };
  }
  if (needsAadhaar(type)) return { ok: true, docs: { pan, gstin: null, cin: null } };
  const gstRaw = clean(raw.gstin);
  const cinRaw = clean(raw.cin);
  const gstin = gstRaw ? readGstin(gstRaw) : null;
  const cin = cinRaw ? readCin(cinRaw) : null;
  if (gstRaw && !gstin) return { ok: false, message: "Enter the GSTIN as it is printed, 15 letters and digits." };
  if (cinRaw && !cin) return { ok: false, message: "Enter the CIN as it is printed, 21 letters and digits." };
  if (gstin && gstin.slice(2, 12) !== pan) return { ok: false, message: "That GSTIN is registered on another PAN." };
  if (!gstin && !cin) return { ok: false, message: "Enter your GSTIN, or your CIN if the business has no GST." };
  return { ok: true, docs: { pan, gstin, cin } };
}

/** What Vobiz said about one document. */
export function readDocResult(body: unknown): { status: KycStatus; name: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = String(b.status ?? "").toLowerCase();
  const status: KycStatus = raw === "verified" ? "verified" : raw === "failed" || raw === "rejected" ? "failed" : raw === "pending" ? "pending" : "failed";
  const name = [b.registered_name, b.legal_name, b.name].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return { status, name: name?.trim().slice(0, 200) ?? null };
}
