/**
 * Each developer's own WhatsApp number: what Meta's signup pop-up hands
 * back, what a number's state means to a person, which number speaks for a
 * tower, what a template submission looks like, and what Meta's account
 * webhooks say. Pure, database-free and client-safe, covered by
 * `check:logic`.
 *
 * Three rules live here.
 *
 * **The browser's ids are hints.** Embedded Signup posts the WABA and number
 * the person picked to the page, and a page can post anything. The server
 * connects what the exchanged token can reach (`reachableWabas()`), never
 * what the page said.
 *
 * **One number per tower, resolved upward.** The deepest active number at or
 * above a lead's node is the one that writes to them (`numberFor()`), the
 * way a Facebook Page resolves, so a group running two brands can give the
 * second brand's entity its own number.
 *
 * **Only an approved template sends.** A template is tracked per account,
 * name and language, with the hash of the text we submitted; a catalog
 * wording change makes the stored approval stale rather than carrying it
 * onto words Meta never saw (`templateState()`).
 */

import type { Blank, Category, Template } from "./message-rules.ts";

// ---------------------------------------------------------------------------
// Embedded Signup
// ---------------------------------------------------------------------------

/** The events Meta posts when a person finishes the pop-up. */
export const SIGNUP_FINISHED = [
  "FINISH",
  "FINISH_ONLY_WABA",
  "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  "FINISH_OBO_MIGRATION",
  "FINISH_GRANT_ONLY_API_ACCESS",
] as const;

export type SignupHint = {
  event: (typeof SIGNUP_FINISHED)[number];
  wabaId: string | null;
  phoneNumberId: string | null;
  businessId: string | null;
};

export type SignupMessage =
  | { kind: "finished"; hint: SignupHint }
  | { kind: "cancelled"; step: string | null; error: string | null }
  | null;

const metaId = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9]{1,40}$/.test(v) ? v : typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : null;

/**
 * One `message` event from the pop-up, read defensively: only an event whose
 * origin is Meta's and whose body says `WA_EMBEDDED_SIGNUP`. Anything else on
 * the page's message bus is somebody else's and is ignored.
 */
export function readSignupMessage(origin: string, data: unknown): SignupMessage {
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (host !== "facebook.com" && !host.endsWith(".facebook.com")) return null;
  let body: unknown = data;
  if (typeof data === "string") {
    try {
      body = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const b = (body ?? {}) as { type?: unknown; event?: unknown; data?: Record<string, unknown> };
  if (b.type !== "WA_EMBEDDED_SIGNUP" || typeof b.event !== "string") return null;
  const d = b.data ?? {};
  if ((SIGNUP_FINISHED as readonly string[]).includes(b.event)) {
    return {
      kind: "finished",
      hint: {
        event: b.event as SignupHint["event"],
        wabaId: metaId(d.waba_id),
        phoneNumberId: metaId(d.phone_number_id),
        businessId: metaId(d.business_id),
      },
    };
  }
  if (b.event === "CANCEL" || b.event === "ERROR") {
    return {
      kind: "cancelled",
      step: typeof d.current_step === "string" ? d.current_step.slice(0, 80) : null,
      error: typeof d.error_message === "string" ? d.error_message.slice(0, 200) : null,
    };
  }
  return null;
}

/**
 * What `FB.login()` is asked for. The configuration, made once in the app's
 * Facebook Login for Business settings, names the permissions; keeping the
 * WhatsApp Business app number is asked for by feature type, and a BSP's
 * solution id (when one pays Meta for our clients) rides in `setup`.
 */
export function signupOptions(input: { configId: string; keepAppNumber: boolean; solutionId?: string | null }) {
  const setup: Record<string, string> = {};
  if (input.solutionId) setup.solutionID = input.solutionId;
  const extras: Record<string, unknown> = { setup };
  if (input.keepAppNumber) extras.featureType = "whatsapp_business_app_onboarding";
  return {
    config_id: input.configId,
    response_type: "code",
    override_default_response_type: true,
    extras,
  };
}

export type GranularScope = { scope?: unknown; target_ids?: unknown };

/**
 * The WABAs a token may manage and message, from `debug_token`'s granular
 * scopes. Both permissions are needed: one submits templates, the other
 * sends. A token that names none reaches nothing we can use.
 */
export function reachableWabas(granular: readonly GranularScope[] | null | undefined): string[] {
  const ids = (name: string) =>
    new Set(
      (granular ?? [])
        .filter((g) => g?.scope === name && Array.isArray(g.target_ids))
        .flatMap((g) => (g.target_ids as unknown[]).map(metaId))
        .filter((x): x is string => !!x),
    );
  const manage = ids("whatsapp_business_management");
  const message = ids("whatsapp_business_messaging");
  return [...manage].filter((id) => message.has(id)).sort();
}

/** Meta shows a number as "+91 98765 43210"; stored as E.164, or not at all. */
export function e164(display: unknown): string | null {
  if (typeof display !== "string") return null;
  const digits = display.replace(/[^0-9]/g, "");
  return /^[1-9][0-9]{7,14}$/.test(digits) ? `+${digits}` : null;
}

// ---------------------------------------------------------------------------
// A number's state
// ---------------------------------------------------------------------------

export type Quality = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
export type Tier = "TIER_250" | "TIER_2K" | "TIER_10K" | "TIER_100K" | "TIER_UNLIMITED";

export const readQuality = (raw: unknown): Quality =>
  raw === "GREEN" || raw === "YELLOW" || raw === "RED" ? raw : "UNKNOWN";

const TIERS: Record<Tier, number | null> = {
  TIER_250: 250,
  TIER_2K: 2_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: null,
};

export const readTier = (raw: unknown): Tier | null =>
  typeof raw === "string" && raw in TIERS ? (raw as Tier) : null;

/** How many people the portfolio may start a conversation with in 24 hours. Null: no limit. */
export const tierPeople = (t: Tier): number | null => TIERS[t];

export function tierLabel(t: Tier | null): string {
  if (!t) return "Not known yet";
  const n = TIERS[t];
  return n === null ? "No daily limit" : `${n.toLocaleString("en-IN")} people a day`;
}

export const QUALITY_PILL: Record<Quality, { text: string; tone: "ok" | "warn" | "risk" | "quiet" }> = {
  GREEN: { text: "Quality high", tone: "ok" },
  YELLOW: { text: "Quality medium", tone: "warn" },
  RED: { text: "Quality low", tone: "risk" },
  UNKNOWN: { text: "Quality not rated yet", tone: "quiet" },
};

export type NumberState = {
  accountStatus: "CONNECTED" | "BROKEN" | "DISCONNECTED";
  currency: string | null;
  quality: Quality;
  registered: boolean;
  registerError: string | null;
  onApp: boolean;
  active: boolean;
};

export type NumberNeed = {
  code: "BROKEN" | "PIN" | "REGISTER" | "PLACE" | "BILLING" | "QUALITY";
  text: string;
};

/**
 * The one thing a person has to do about a number, or null. In order of
 * what stops messages first: a token that stopped working, a number that is
 * not registered (and whether only its owner's PIN can fix that), a number
 * nobody placed, billing Meta will stop delivering on, and a quality rating
 * Meta is about to act on.
 */
export function numberNeeds(s: NumberState, now = new Date()): NumberNeed | null {
  if (s.accountStatus === "BROKEN") return { code: "BROKEN", text: "WhatsApp stopped accepting our access. Connect it again." };
  if (s.accountStatus === "DISCONNECTED") return null;
  if (!s.onApp && !s.registered) {
    return wantsPin(s.registerError)
      ? { code: "PIN", text: s.registerError! }
      : { code: "REGISTER", text: s.registerError ?? "This number is not set up to send yet." };
  }
  if (!s.active) return { code: "PLACE", text: "Choose where this number is used." };
  if (s.currency && s.currency !== "INR") {
    return {
      code: "BILLING",
      text:
        now < new Date("2027-01-01T00:00:00+05:30")
          ? "Switch billing to rupees in WhatsApp Manager before 31 December 2026, or Meta stops delivering."
          : "Meta has stopped delivering: billing is not in rupees. Switch it in WhatsApp Manager.",
    };
  }
  if (s.quality === "RED") return { code: "QUALITY", text: "Buyers are blocking or reporting these messages. Meta may limit this number." };
  return null;
}

// ---------------------------------------------------------------------------
// Which number writes to a lead
// ---------------------------------------------------------------------------

export type PlacedNumber = { id: string; active: boolean; nodePath: string | null };

const within = (path: string, ancestor: string) => path === ancestor || path.startsWith(`${ancestor}.`);

/** The deepest active number at or above `nodePath`, or null. */
export function numberFor<T extends PlacedNumber>(numbers: readonly T[], nodePath: string): T | null {
  let best: T | null = null;
  for (const n of numbers) {
    if (!n.active || !n.nodePath || !within(nodePath, n.nodePath)) continue;
    if (!best || n.nodePath.split(".").length > (best.nodePath ?? "").split(".").length) best = n;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** What each blank reads as in the sample Meta's reviewer is shown. */
export const SAMPLE: Record<Blank, string> = {
  first_name: "Priya",
  project: "Sath Heights Tower C",
  developer: "Sath Group",
  when: "Sat 26 Sep, 11:00 am",
  directions: "https://maps.app.goo.gl/8pXqYyJ3uK2vTz9A7",
  contact: "+91 98765 01234",
  next_step: "Our sales manager will call you shortly.",
  booking: "C-803 (Nitin G.)",
  update: "M1 Rs 1,25,000, PAID Sat 12 Jul, UTR HDFC0000123456.",
  slot_1: "Sat 4 Oct, 11 am",
  slot_2: "Sat 4 Oct, 12 pm",
  slot_3: "Sun 5 Oct, 11 am",
  pass: "https://app.salesdesk.app/v/pass",
  unit: "2 BHK",
  loan: "₹61,04,000",
  rate: "8.5%",
  emi_15: "60,109",
  emi_20: "52,972",
  emi_25: "49,151",
  lender: "HDFC Bank",
  advisor: "Skyline Realty",
  amount: "1,00,000",
  link: "https://rzp.io/rzp/abc123",
  flat: "C-803",
  ad_line: "Sea facing 2 BHK homes, 8 min from Goregaon station.",
  highlights: "1 BHK from ₹1.45 Cr*, 2 BHK from ₹2.19 Cr*",
  registration: "MahaRERA No. P52100012345",
};

export type TemplateRequest = {
  name: string;
  language: string;
  category: Category;
  parameter_format: "positional";
  components: (
    | { type: "HEADER"; format: "IMAGE"; example: { header_handle: string[] } }
    | { type: "FOOTER"; text: string }
    | { type: "BODY"; text: string; example?: { body_text: string[][] } }
    | { type: "BUTTONS"; buttons: { type: "QUICK_REPLY"; text: string }[] }
  )[];
};

/** The body of `POST /<WABA_ID>/message_templates` for one template in one language. */
export function templateRequest(t: Template, language: string, body: string, headerHandle?: string | null): TemplateRequest {
  const samples = t.blanks.map((b) => SAMPLE[b]);
  return {
    name: t.name,
    language,
    category: t.category,
    parameter_format: "positional",
    components: [
      // A picture header is reviewed from an example uploaded to Meta first.
      ...(t.header === "IMAGE" && headerHandle ? [{ type: "HEADER" as const, format: "IMAGE" as const, example: { header_handle: [headerHandle] } }] : []),
      { type: "BODY", text: body, ...(samples.length ? { example: { body_text: [samples] } } : {}) },
      ...(t.footer ? [{ type: "FOOTER" as const, text: t.footer }] : []),
      ...(t.buttons?.length ? [{ type: "BUTTONS" as const, buttons: t.buttons.map((text) => ({ type: "QUICK_REPLY" as const, text })) }] : []),
    ],
  };
}

/** What gets hashed: the name, language, category and words Meta reviewed. */
export const templateHashInput = (t: Template, language: string, body: string) =>
  JSON.stringify([
    t.name,
    language,
    t.category,
    body,
    ...(t.buttons?.length ? [t.buttons] : []),
    // Only a template that has them hashes them, so no older hash moved.
    ...(t.header || t.footer ? [t.header ?? null, t.footer ?? null] : []),
  ]);

/**
 * Meta's reasons a body is refused before review: a body that starts or
 * ends with a blank, two blanks side by side, and blanks out of order. The
 * catalog is checked against these in `check:logic`, so a rewording that
 * breaks one is caught before it is submitted.
 */
export function bodyProblems(body: string, blanks: number): string[] {
  const out: string[] = [];
  const trimmed = body.trim();
  if (/^\{\{\d+\}\}/.test(trimmed)) out.push("starts with a blank");
  if (/\{\{\d+\}\}[.!?]?$/.test(trimmed)) out.push("ends with a blank");
  if (/\}\}\s*\{\{/.test(trimmed)) out.push("has two blanks side by side");
  const seen = [...trimmed.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const want = Array.from({ length: blanks }, (_, i) => i + 1);
  if (JSON.stringify([...new Set(seen)].sort((a, b) => a - b)) !== JSON.stringify(want)) out.push("blanks are not numbered 1 onward");
  if (body.length > 1024) out.push("longer than 1,024 characters");
  return out;
}

export type TemplateStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "PAUSED"
  | "DISABLED"
  | "IN_APPEAL"
  | "FLAGGED"
  | "REINSTATED"
  | "PENDING_DELETION"
  | "DELETED"
  | "ARCHIVED"
  | "LOCKED"
  | "LIMIT_EXCEEDED"
  | "FAILED";

const STATUSES = new Set<string>([
  "PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED", "IN_APPEAL", "FLAGGED", "REINSTATED",
  "PENDING_DELETION", "DELETED", "ARCHIVED", "LOCKED", "LIMIT_EXCEEDED", "FAILED",
]);

export const readTemplateStatus = (raw: unknown): TemplateStatus | null =>
  typeof raw === "string" && STATUSES.has(raw.toUpperCase()) ? (raw.toUpperCase() as TemplateStatus) : null;

export const readCategory = (raw: unknown): Category | "AUTHENTICATION" | null =>
  raw === "UTILITY" || raw === "MARKETING" || raw === "AUTHENTICATION" ? raw : null;

/** A reinstated template sends again; the rest of Meta's states mean it does not. */
export const sends = (s: TemplateStatus) => s === "APPROVED" || s === "REINSTATED";

export type TemplateState = "SENDS" | "WAITING" | "REFUSED" | "STALE" | "NOT_SENT";

/**
 * Where one template stands on one account. A row whose hash no longer
 * matches the catalog is stale however Meta decided it: those are not the
 * words being sent.
 */
export function templateState(row: { status: TemplateStatus; hash: string } | null, currentHash: string): TemplateState {
  if (!row) return "NOT_SENT";
  if (row.hash !== currentHash && row.status !== "FAILED") return "STALE";
  if (sends(row.status)) return "SENDS";
  if (row.status === "PENDING" || row.status === "IN_APPEAL") return "WAITING";
  if (row.status === "FAILED" || row.status === "DELETED" || row.status === "ARCHIVED" || row.status === "PENDING_DELETION") return "NOT_SENT";
  return "REFUSED";
}

export const TEMPLATE_PILL: Record<TemplateState, { text: string; tone: "ok" | "warn" | "risk" | "quiet" }> = {
  SENDS: { text: "Approved", tone: "ok" },
  WAITING: { text: "With Meta", tone: "quiet" },
  REFUSED: { text: "Not approved", tone: "risk" },
  STALE: { text: "Wording changed", tone: "warn" },
  NOT_SENT: { text: "Not sent to Meta", tone: "warn" },
};

/**
 * Whether a submission is worth making: words Meta has never seen, or new
 * words for an old approval. Never words already approved or waiting, and
 * never words Meta refused: sending them again gets the same answer, and
 * the fix is a change to the catalog.
 */
export const needsSubmitting = (s: TemplateState) => s === "NOT_SENT" || s === "STALE";

/**
 * Meta allows 100 template creations per WABA per hour; we stop short of it.
 * The catalog is three versions of each message (69 in all), so a first
 * connection submits it in one go.
 */
export const TEMPLATES_PER_HOUR = 90;

// ---------------------------------------------------------------------------
// Registering a new number
// ---------------------------------------------------------------------------

export const isPin = (raw: unknown): raw is string => typeof raw === "string" && /^[0-9]{6}$/.test(raw);

/**
 * Meta's refusal of `/register`, in the words a person can act on. The one
 * that matters is a number that already has a two-step PIN: only its owner
 * knows it, so they are asked for it.
 */
export function registerRefusal(code: number | null): { text: string; wantsPin: boolean } {
  switch (code) {
    case 133005:
      return { text: "This number already has a two-step verification PIN. Enter it to finish.", wantsPin: true };
    case 133008:
    case 133009:
      return { text: "Too many PIN attempts. Wait a few hours, then enter it again.", wantsPin: true };
    case 133015:
    case 133016:
      return { text: "Meta asked us to wait before registering this number again. It is retried tomorrow.", wantsPin: false };
    default:
      return { text: "Meta did not register this number. Try connecting it again.", wantsPin: false };
  }
}

/** Whether a stored registration refusal is the one only the number's owner can answer. */
export const wantsPin = (registerError: string | null): boolean =>
  registerError === registerRefusal(133005).text || registerError === registerRefusal(133008).text;

// ---------------------------------------------------------------------------
// Meta's account webhooks
// ---------------------------------------------------------------------------

export type WabaEvent =
  | { kind: "TEMPLATE_STATUS"; wabaId: string; templateId: string | null; name: string; language: string; status: TemplateStatus; reason: string | null }
  | { kind: "TEMPLATE_QUALITY"; wabaId: string; templateId: string | null; name: string; language: string; quality: Quality }
  | { kind: "TEMPLATE_CATEGORY"; wabaId: string; templateId: string | null; name: string; language: string; category: Category | "AUTHENTICATION" }
  | { kind: "NUMBER_CHANGED"; wabaId: string }
  | { kind: "ACCOUNT"; wabaId: string; event: string }
  | { kind: "ECHO"; wabaId: string; phoneNumberId: string; id: string; to: string; text: string; at: string }
  | { kind: "PREFERENCE"; wabaId: string; phoneNumberId: string; phone: string; stop: boolean };

/** Meta's words for a template refusal, when it gave any worth showing. */
function reasonOf(v: Record<string, unknown>): string | null {
  const info = (v.rejection_info ?? v.other_info) as { reason?: unknown; recommendation?: unknown; title?: unknown; description?: unknown } | undefined;
  const parts = [info?.reason, info?.description, info?.recommendation, v.reason]
    .filter((x): x is string => typeof x === "string" && x.trim() !== "" && x.toUpperCase() !== "NONE");
  return parts.length ? parts[0].replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()).slice(0, 300) : null;
}

const when = (ts: unknown) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
};

/**
 * Everything in a WhatsApp Business webhook that is not a message or a
 * receipt: template decisions, quality and category changes, a number's
 * limit or quality moving, the account itself, and the messages a
 * developer's team sent from the WhatsApp Business app. Chat history a
 * connected app syncs is deliberately not read: we never import a
 * developer's past conversations.
 */
export function readWabaEvents(body: unknown): WabaEvent[] {
  const out: WabaEvent[] = [];
  const b = (body ?? {}) as { object?: unknown; entry?: unknown };
  if (b.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return out;
  for (const entry of b.entry as { id?: unknown; changes?: unknown }[]) {
    const wabaId = metaId(entry?.id);
    if (!wabaId || !Array.isArray(entry.changes)) continue;
    for (const ch of entry.changes as { field?: unknown; value?: Record<string, unknown> }[]) {
      const v = ch?.value;
      if (!v || typeof ch.field !== "string") continue;
      const name = typeof v.message_template_name === "string" ? v.message_template_name : null;
      const language = typeof v.message_template_language === "string" ? v.message_template_language : null;
      const templateId = metaId(v.message_template_id);
      switch (ch.field) {
        case "message_template_status_update": {
          const status = readTemplateStatus(v.event);
          if (name && language && status) out.push({ kind: "TEMPLATE_STATUS", wabaId, templateId, name, language, status, reason: status === "APPROVED" ? null : reasonOf(v) });
          break;
        }
        case "message_template_quality_update":
          if (name && language) out.push({ kind: "TEMPLATE_QUALITY", wabaId, templateId, name, language, quality: readQuality(v.new_quality_score) });
          break;
        case "template_category_update": {
          const category = readCategory(v.new_category);
          if (name && language && category) out.push({ kind: "TEMPLATE_CATEGORY", wabaId, templateId, name, language, category });
          break;
        }
        case "phone_number_quality_update":
        case "phone_number_name_update":
        case "business_capability_update":
          out.push({ kind: "NUMBER_CHANGED", wabaId });
          break;
        case "account_update":
          if (typeof v.event === "string") out.push({ kind: "ACCOUNT", wabaId, event: v.event.toUpperCase().slice(0, 60) });
          break;
        case "user_preferences": {
          // A buyer turning marketing off (or back on) in WhatsApp itself.
          // Only the marketing category means anything here.
          const phoneNumberId = metaId((v.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id);
          if (!phoneNumberId) break;
          for (const p of Array.isArray(v.user_preferences) ? (v.user_preferences as Record<string, unknown>[]) : []) {
            const phone = e164(p.wa_id);
            if (!phone || p.category !== "marketing_messages" || (p.value !== "stop" && p.value !== "resume")) continue;
            out.push({ kind: "PREFERENCE", wabaId, phoneNumberId, phone, stop: p.value === "stop" });
          }
          break;
        }
        case "smb_message_echoes": {
          const phoneNumberId = metaId((v.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id);
          if (!phoneNumberId) break;
          for (const m of Array.isArray(v.message_echoes) ? (v.message_echoes as Record<string, unknown>[]) : []) {
            const id = typeof m.id === "string" ? m.id : null;
            const to = e164(m.to);
            if (!id || !to) continue;
            const text = (m.text as { body?: unknown } | undefined)?.body;
            out.push({
              kind: "ECHO",
              wabaId,
              phoneNumberId,
              id,
              to,
              text: typeof text === "string" ? text.slice(0, 4096) : `[${typeof m.type === "string" ? m.type : "message"}]`,
              at: when(m.timestamp),
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return out;
}

/** Account events that mean the developer took us off their account. */
export const REMOVED_EVENTS = new Set(["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED"]);
/** Account events that mean something is wrong a person should see. */
export const TROUBLE_EVENTS = new Set(["DISABLED_UPDATE", "ACCOUNT_RESTRICTION", "ACCOUNT_VIOLATION", "PRIMARY_INACTIVITY"]);
