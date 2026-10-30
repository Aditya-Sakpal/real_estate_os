/**
 * Lead capture: reading what a Meta lead form, a Google lead form or a
 * website sent, and proving who sent it. Pure and database-free, covered by
 * `check:logic`.
 *
 * Section 02's rule for this stage is that nothing is parsed in the path that
 * answers the platform. The route proves the request, writes the raw event
 * and says 200; everything here runs after, and runs again from the stored
 * event when it was wrong the first time.
 *
 * Lineage (campaign, ad set, ad, form, gclid, utm_*) is captured here or
 * never: a lead that arrives without it cannot be tied to the money that
 * bought it, and the budget pass reads exactly that tie.
 */

import { partnerRefFrom } from "./partner-rules.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalisePhone } from "./calling-rules.ts";
import { fbcFrom } from "./attribution-rules.ts";
import type { Language } from "./call-rules.ts";
import { guessLanguage } from "./name-language-rules.ts";
import { readFormAnswers, type FormAnswers } from "./lead-form-rules.ts";

export type CaptureChannel = "META_FORM" | "GOOGLE_FORM" | "WEBSITE" | "WHATSAPP" | "PHONE" | "PORTAL";

/** What the board calls each property portal a lead came from (`portal-rules.ts`). */
export const PORTAL_LABELS: Record<string, string> = {
  "99ACRES": "99acres",
  MAGICBRICKS: "MagicBricks",
  HOUSING: "Housing.com",
  NOBROKER: "NoBroker",
  OTHER: "Property portal",
};

export type Lineage = {
  campaignId?: string;
  adsetId?: string;
  adId?: string;
  formId?: string;
  pageId?: string;
  gclid?: string;
  /** Meta's click id, `fb.1.<ms>.<fbclid>`, from the landing address or the site's `_fbc` cookie. */
  fbc?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  /** The first 12 characters of the publication's idempotency key, from our own tag. */
  ref?: string;
  /** A channel partner's ref code, from the partner's own link (`cp=`). */
  partnerRef?: string;
  /** Meta's click id for a chat a Click-to-WhatsApp ad started. */
  ctwaClid?: string;
  /** The property portal an enquiry came through (`PortalKey`). */
  portal?: string;
  /** The project as the portal wrote it, before anybody matched it to a tower. */
  portalProject?: string;
};

/** A lead as a form described it, before it meets the database. */
export type CapturedLead = {
  channel: CaptureChannel;
  externalId: string;
  name: string;
  /** E.164, or null when the form carried nothing dialable. */
  phone: string | null;
  email: string | null;
  language: Language;
  /** The words the buyer agreed to, when the form asked. */
  consent: string | null;
  /**
   * Agreement to have Meta and Google told whether this enquiry led to a
   * visit or a booking. Separate from `consent`, and never implied by it.
   */
  measurement: string | null;
  lineage: Lineage;
  /** The tower, when the form named one we issued. */
  phaseId: string | null;
  isTest: boolean;
  /** Our enquiry page's hidden field was filled, which only a bot does (ownership rule R0). */
  honeypot?: boolean;
  /** What the buyer answered on a Meta form's questions (`lead-form-rules.ts`), when it asked any. */
  form?: FormAnswers;
};

// ---------------------------------------------------------------------------
// Proving who sent it
// ---------------------------------------------------------------------------

/**
 * Meta signs every webhook body with the app secret. A body that does not
 * verify is not Meta, and nothing in it is read.
 */
export function metaSignatureValid(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const want = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const got = Buffer.from(m[1], "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The key a website form, a Google lead form or our enquiry page carries.
 *
 * An HMAC of the org (and the tower, for an enquiry page) under a key only
 * this server holds, so a form cannot post into another tenant by changing
 * one id in the address. Google calls the same value `google_key`.
 */
export function captureKey(secret: string, orgId: string, phaseId: string | null = null): string {
  return createHmac("sha256", secret)
    .update(phaseId ? `capture:${orgId}:${phaseId}` : `capture:${orgId}`)
    .digest("hex")
    .slice(0, 32);
}

export function captureKeyValid(secret: string, orgId: string, phaseId: string | null, key: string): boolean {
  if (!/^[0-9a-f]{32}$/i.test(key)) return false;
  const want = Buffer.from(captureKey(secret, orgId, phaseId), "hex");
  const got = Buffer.from(key.toLowerCase(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

// ---------------------------------------------------------------------------
// Meta: the webhook, then the lead itself
// ---------------------------------------------------------------------------

export type LeadgenPing = {
  leadgenId: string;
  pageId: string;
  formId: string | null;
  adId: string | null;
  adgroupId: string | null;
  createdTime: number | null;
};

/**
 * The leadgen changes in a Page webhook. Meta's webhook carries identifiers
 * only; the answers are fetched with a second call on the Page's token.
 */
export function leadgenPings(body: unknown): LeadgenPing[] {
  const b = (body ?? {}) as { object?: unknown; entry?: unknown };
  if (b.object !== "page" || !Array.isArray(b.entry)) return [];
  const out: LeadgenPing[] = [];
  for (const entry of b.entry as { id?: unknown; changes?: unknown }[]) {
    if (!Array.isArray(entry?.changes)) continue;
    for (const change of entry.changes as { field?: unknown; value?: Record<string, unknown> }[]) {
      if (change?.field !== "leadgen" || !change.value) continue;
      const v = change.value;
      const id = str(v.leadgen_id);
      const page = str(v.page_id) ?? str(entry.id);
      if (!id || !page || !/^\d{1,40}$/.test(id) || !/^\d{1,40}$/.test(page)) continue;
      out.push({
        leadgenId: id,
        pageId: page,
        formId: str(v.form_id),
        adId: str(v.ad_id),
        adgroupId: str(v.adgroup_id),
        createdTime: typeof v.created_time === "number" ? v.created_time : null,
      });
    }
  }
  return out;
}

const str = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
};

/** Field names forms use for the same thing, lower-cased and de-spaced. */
const NAME_KEYS = ["full_name", "fullname", "name", "your_name", "first_name"];
const LAST_KEYS = ["last_name", "surname"];
const PHONE_KEYS = ["phone_number", "phone", "mobile", "mobile_number", "contact_number", "whatsapp_number", "tel"];
const EMAIL_KEYS = ["email", "email_address", "work_email"];

/** Fields a form carries that are the buyer's details, not answers to a question. */
const KNOWN_FIELDS = new Set([...NAME_KEYS, ...LAST_KEYS, ...PHONE_KEYS, ...EMAIL_KEYS, "language", "preferred_language"]);

const keyOf = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, "_");

function pick(fields: Map<string, string>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = fields.get(k);
    if (v) return v;
  }
  return null;
}

/** A name a person would be greeted by, or a neutral one. */
export function cleanName(first: string | null, last: string | null = null): string {
  const joined = [first, last].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const safe = joined.replace(/[<>{}\[\]\\|^`"]/g, "").slice(0, 120).trim();
  return safe || "Buyer";
}

export function cleanEmail(raw: string | null): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,150}\.[a-z]{2,}$/.test(s) && s.length <= 200 ? s : null;
}

const META_CONSENT = "Agreed on the Meta lead form to be contacted about this enquiry by call and WhatsApp.";
const META_MEASUREMENT =
  "Agreed on the Meta lead form that Meta may be told, in coded form, whether this enquiry led to a visit or a booking.";

/**
 * The key a developer gives the lead form's measurement checkbox. Any other
 * ticked box is consent to be contacted; only this one is consent to
 * measure, because a box about calls says nothing about telling Meta.
 */
export const MEASUREMENT_KEY = /measure/i;

const isTicked = (r: { is_checked?: unknown }) => r?.is_checked === true || r?.is_checked === "1";

/**
 * A lead Meta returned for a leadgen id: `field_data` is a list of
 * `{ name, values[] }`, and custom disclaimer checkboxes come back ticked or
 * not. A ticked one is consent in the buyer's own click.
 */
export function readMetaLead(ping: LeadgenPing, lead: unknown): CapturedLead {
  const l = (lead ?? {}) as Record<string, unknown>;
  const fields = new Map<string, string>();
  for (const f of Array.isArray(l.field_data) ? (l.field_data as { name?: unknown; values?: unknown }[]) : []) {
    const name = str(f?.name);
    const value = Array.isArray(f?.values) ? str(f.values[0]) : null;
    if (name && value) fields.set(keyOf(name), value);
  }
  const boxes = Array.isArray(l.custom_disclaimer_responses)
    ? (l.custom_disclaimer_responses as { is_checked?: unknown; checkbox_key?: unknown }[])
    : [];
  const measures = (r: { checkbox_key?: unknown }) => MEASUREMENT_KEY.test(String(r?.checkbox_key ?? ""));
  const ticked = boxes.some((r) => isTicked(r) && !measures(r));
  const measured = boxes.some((r) => isTicked(r) && measures(r));
  const metaName = cleanName(pick(fields, NAME_KEYS), pick(fields, LAST_KEYS));
  const form = readFormAnswers(fields, KNOWN_FIELDS);
  return {
    channel: "META_FORM",
    externalId: ping.leadgenId,
    name: metaName,
    phone: normalisePhone(pick(fields, PHONE_KEYS) ?? ""),
    email: cleanEmail(pick(fields, EMAIL_KEYS)),
    language: languageOf(fields.get("language") ?? fields.get("preferred_language") ?? null, metaName),
    consent: ticked ? META_CONSENT : null,
    measurement: measured ? META_MEASUREMENT : null,
    lineage: compact({
      campaignId: str(l.campaign_id) ?? undefined,
      adsetId: str(l.adset_id) ?? ping.adgroupId ?? undefined,
      adId: str(l.ad_id) ?? ping.adId ?? undefined,
      formId: str(l.form_id) ?? ping.formId ?? undefined,
      pageId: ping.pageId,
    }),
    phaseId: null,
    // Meta's testing tool creates real leads on the real form; there is no flag.
    isTest: false,
    ...(form.answers.length ? { form } : {}),
  };
}

// ---------------------------------------------------------------------------
// Google Ads lead form webhook
// ---------------------------------------------------------------------------

/**
 * Google posts `{ lead_id, form_id, campaign_id, gcl_id, google_key,
 * is_test, user_column_data: [{ column_id, string_value }] }`. The key is
 * proved by the caller before this runs.
 */
export function isGooglePayload(body: unknown): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  return typeof b.google_key === "string" && Array.isArray(b.user_column_data);
}

export function readGoogleLead(body: unknown): CapturedLead | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = str(b.lead_id);
  if (!id) return null;
  const cols = new Map<string, string>();
  for (const c of Array.isArray(b.user_column_data) ? (b.user_column_data as Record<string, unknown>[]) : []) {
    const key = str(c?.column_id) ?? str(c?.column_name);
    const value = str(c?.string_value);
    if (key && value) cols.set(key.toUpperCase().replace(/\s+/g, "_"), value);
  }
  const googleName = cleanName(cols.get("FULL_NAME") ?? cols.get("FIRST_NAME") ?? null, cols.get("LAST_NAME") ?? null);
  return {
    channel: "GOOGLE_FORM",
    externalId: id.slice(0, 200),
    name: googleName,
    phone: normalisePhone(cols.get("PHONE_NUMBER") ?? cols.get("WORK_PHONE") ?? ""),
    email: cleanEmail(cols.get("EMAIL") ?? cols.get("WORK_EMAIL") ?? null),
    language: languageOf(null, googleName),
    // Google's form carries the advertiser's privacy policy and a submit, not
    // a consent box. The enquiry window is the basis for contacting them.
    consent: null,
    // Nor a box for measurement, so a Google form lead is never uploaded.
    measurement: null,
    lineage: compact({
      campaignId: str(b.campaign_id) ?? undefined,
      adsetId: str(b.adgroup_id) ?? undefined,
      adId: str(b.creative_id) ?? undefined,
      formId: str(b.form_id) ?? undefined,
      gclid: str(b.gcl_id) ?? undefined,
    }),
    phaseId: null,
    isTest: b.is_test === true,
  };
}

// ---------------------------------------------------------------------------
// A website form, or our own enquiry page
// ---------------------------------------------------------------------------

const WEB_CONSENT =
  "Agreed on the enquiry form to be contacted about this enquiry by call and WhatsApp.";
export const WEB_MEASUREMENT =
  "Agreed on the enquiry form that Meta and Google may be told, in coded form, whether this enquiry led to a visit or a booking.";

/**
 * Whatever a website posted, as a flat record of strings. The field names
 * are the ones a form builder produces, in any case, with or without spaces.
 * A form with no id of its own gets one from its contents and the minute it
 * arrived, so a double-submitted form is one lead.
 */
function webFields(fields: Record<string, unknown>): Map<string, string> {
  const f = new Map<string, string>();
  for (const [k, v] of Object.entries(fields)) {
    const s = str(Array.isArray(v) ? v[0] : v);
    if (s) f.set(keyOf(k), s.slice(0, 500));
  }
  return f;
}

/**
 * Why a website form cannot become a lead, in words its sender can act on,
 * or null. A lead is somebody to call, so a form without a mobile number is
 * refused at the door rather than accepted and dropped later.
 */
export function webFormProblem(fields: Record<string, unknown>): string | null {
  const f = webFields(fields);
  const raw = pick(f, PHONE_KEYS);
  if (!raw) return "A mobile number is needed.";
  if (!normalisePhone(raw)) return "That phone number does not look right. Use a 10-digit mobile number.";
  const named = f.get("phase") ?? f.get("phase_id") ?? f.get("tower_id");
  if (named && !isUuid(named)) return "The form names a tower that does not exist.";
  return null;
}

/** A short, stable fingerprint of what a form carried. Not a security hash. */
function fingerprint(f: Map<string, string>): string {
  let h = 0x811c9dc5;
  for (const [k, v] of [...f.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const ch of `${k}=${v};`) {
      h ^= ch.codePointAt(0)!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, "0");
}

/** The field our enquiry page hides from people, so only a bot fills it. */
export const HONEYPOT_FIELD = "est_hp";

export function readWebLead(fields: Record<string, unknown>, receivedIso: string): CapturedLead | null {
  const f = webFields(fields);
  const phone = normalisePhone(pick(f, PHONE_KEYS) ?? "");
  const email = cleanEmail(pick(f, EMAIL_KEYS));
  if (!phone) return null;
  const given = str(f.get("lead_id") ?? f.get("submission_id") ?? f.get("id"));
  const minute = receivedIso.slice(0, 16);
  // With no id of the form's own, the same form sent twice in a minute is one
  // event and anything different is another. Keyed on the phone and minute
  // alone, a refused submission swallowed the good one sent after it.
  const externalId = (given ?? `web:${phone}:${minute}:${fingerprint(f)}`).slice(0, 200);
  const agreed = ["consent", "agree", "agreed", "whatsapp_consent", "contact_consent"].some((k) =>
    /^(on|true|yes|1|checked)$/i.test(f.get(k) ?? ""),
  );
  const measured = ["ad_measurement", "measurement"].some((k) => /^(on|true|yes|1|checked)$/i.test(f.get(k) ?? ""));
  const phaseId = f.get("phase") ?? f.get("phase_id") ?? f.get("tower_id") ?? null;
  const webName = cleanName(pick(f, NAME_KEYS), pick(f, LAST_KEYS));
  return {
    channel: "WEBSITE",
    externalId,
    name: webName,
    phone,
    email,
    language: languageOf(f.get("language") ?? null, webName),
    consent: agreed ? WEB_CONSENT : null,
    measurement: measured ? WEB_MEASUREMENT : null,
    lineage: compact({
      gclid: f.get("gclid"),
      fbc: fbcFrom(f.get("fbclid"), f.get("fbc") ?? f.get("_fbc"), Date.parse(receivedIso)),
      utmSource: f.get("utm_source"),
      utmMedium: f.get("utm_medium"),
      utmCampaign: f.get("utm_campaign"),
      utmContent: f.get("utm_content"),
      ref: refFrom(f.get("est_ref") ?? f.get("utm_content") ?? null) ?? undefined,
      partnerRef: partnerRefFrom(f.get("cp")) ?? undefined,
    }),
    phaseId: isUuid(phaseId) ? phaseId : null,
    isTest: /^(true|1|yes)$/i.test(f.get("test") ?? ""),
    honeypot: !!f.get(HONEYPOT_FIELD),
  };
}

/**
 * The language the enquiry says, else the one the buyer's name suggests
 * (`guessLanguage()`: a Marathi surname opens the call in Marathi), else
 * Hindi. The call switches the moment the buyer answers in another.
 */
export function languageOf(raw: string | null, name: string | null = null): Language {
  const s = (raw ?? "").trim().toLowerCase();
  if (/^(en|english)/.test(s)) return "en";
  if (/^(mr|marathi|मराठी)/.test(s)) return "mr";
  if (/^(hi|hindi|हिंदी|हिन्दी)/.test(s)) return "hi";
  return guessLanguage(name) ?? "hi";
}

const compact = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;

// ---------------------------------------------------------------------------
// Tying a lead to the advertisement that bought it
// ---------------------------------------------------------------------------

/** The tag we put on every ad's landing page: `est-` and 12 hex characters. */
export function refTag(idempotencyKey: string): string {
  return `est-${idempotencyKey.slice(0, 12)}`;
}

export function refFrom(raw: string | null): string | null {
  const m = /(?:^|[^a-z0-9])est-([0-9a-f]{12})(?:$|[^0-9a-f])/i.exec(raw ?? "");
  return m ? m[1].toLowerCase() : null;
}

/**
 * A landing page address with our lineage on it. What the developer already
 * put in the query is kept; ours only fills what is missing, so an agency's
 * own utm_campaign is not overwritten.
 */
export function taggedLanding(url: string, idempotencyKey: string, destination: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const source = destination.startsWith("GOOGLE") ? "google" : "facebook";
  if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", source);
  if (!u.searchParams.has("utm_medium")) u.searchParams.set("utm_medium", "paid");
  if (!u.searchParams.has("utm_content")) u.searchParams.set("utm_content", refTag(idempotencyKey));
  else if (!refFrom(u.searchParams.get("utm_content"))) u.searchParams.set("est_ref", refTag(idempotencyKey));
  return u.toString();
}

/**
 * A buyer who tapped a partner's link and wrote to the developer's WhatsApp
 * number. The message itself is not kept here: only who wrote, when, the
 * tower the link was for and its ref code. Writing in is not consent to be
 * called, so none is recorded; the enquiry window is what allows a call.
 */
export function readWhatsAppLead(payload: unknown): CapturedLead | null {
  const p = (payload ?? {}) as {
    from?: unknown;
    name?: unknown;
    messageId?: unknown;
    phaseId?: unknown;
    partnerRef?: unknown;
    adId?: unknown;
    ctwaClid?: unknown;
  };
  const phone = typeof p.from === "string" && /^\+[1-9]\d{7,14}$/.test(p.from) ? p.from : null;
  if (!phone || typeof p.messageId !== "string" || !p.messageId) return null;
  const ref = typeof p.partnerRef === "string" ? partnerRefFrom(p.partnerRef) : null;
  return {
    channel: "WHATSAPP",
    externalId: p.messageId.slice(0, 200),
    name: cleanName(typeof p.name === "string" ? p.name : null),
    phone,
    email: null,
    language: "en",
    consent: null,
    measurement: null,
    lineage: compact({
      partnerRef: ref ?? undefined,
      // A chat a Click-to-WhatsApp ad started names the ad, and the ad's
      // publication names the tower.
      adId: typeof p.adId === "string" && /^[0-9]{1,40}$/.test(p.adId) ? p.adId : undefined,
      ctwaClid: typeof p.ctwaClid === "string" ? p.ctwaClid.slice(0, 200) : undefined,
    }),
    phaseId: isUuid(p.phaseId) ? p.phaseId : null,
    isTest: false,
  };
}

/**
 * A buyer nobody knows who rang one of the developer's own numbers. Keyed on
 * Vobiz's call id, so the answer address asked twice is one enquiry. Ringing
 * in is not consent to be called back by the AI or to hear from the
 * developer on WhatsApp, so none is recorded; the enquiry window is what
 * allows a call back.
 */
export function phoneLead(o: { from: string; callUuid: string }): CapturedLead | null {
  if (!/^\+[1-9]\d{7,14}$/.test(o.from) || !o.callUuid) return null;
  return {
    channel: "PHONE",
    externalId: `call:${o.callUuid}`.slice(0, 200),
    name: `Caller ${o.from.slice(-4)}`,
    phone: o.from,
    email: null,
    language: "en",
    consent: null,
    measurement: null,
    lineage: {},
    phaseId: null,
    isTest: false,
  };
}

/** What the board's source pill says for a lead. */
export function sourceLabel(channel: string, lineage: Lineage): string {
  if (channel === "PHONE") return "Called our number";
  if (channel === "PORTAL") return PORTAL_LABELS[lineage.portal ?? "OTHER"] ?? "Property portal";
  if (channel === "WHATSAPP") return lineage.partnerRef ? "Partner's link, WhatsApp" : lineage.adId ? "Meta ad, WhatsApp" : "WhatsApp";
  if (channel === "META_FORM") return "Meta lead form";
  if (channel === "GOOGLE_FORM") return "Google lead form";
  if (channel === "WEBSITE") {
    const s = (lineage.utmSource ?? "").toLowerCase();
    if (/facebook|instagram|meta|^fb$|^ig$/.test(s)) return "Meta ad";
    if (/google|adwords/.test(s) || lineage.gclid) return "Google ad";
    return "Website";
  }
  return "Manual";
}
