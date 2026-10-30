/**
 * Leads from the property portals (99acres, MagicBricks, Housing.com,
 * NoBroker and any other), for a developer with no CRM between the portal
 * and us. Pure and database-free, covered by `check:logic`.
 *
 * A portal tells the developer about an enquiry by email, one email per
 * buyer, and offers a spreadsheet export on its paid plans. Neither has a
 * published format, and they change without notice, so nothing here reads
 * a layout. It reads LABELS ("Mobile", "Contact No", "Interested in"), on a
 * line of text, in a table cell beside its value, or above it, and refuses
 * rather than guesses: an email with no Indian mobile we can read, or with
 * two, is not a lead.
 *
 * The project a portal names is its own wording ("Sath Heights, Goregaon
 * West"). It is matched to a tower only by a person, once per wording, or
 * when the wording IS the name of exactly one tower here. Never by
 * resemblance.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { normalisePhone } from "./calling-rules.ts";
import { ENQUIRY_DAYS, istDate } from "./calling-hours.ts";
import { cleanEmail, cleanName, languageOf, PORTAL_LABELS, type CapturedLead } from "./capture-rules.ts";

// ---------------------------------------------------------------------------
// The portals
// ---------------------------------------------------------------------------

export type PortalKey = "99ACRES" | "MAGICBRICKS" | "HOUSING" | "NOBROKER" | "OTHER";

export const PORTAL_KEYS: PortalKey[] = ["99ACRES", "MAGICBRICKS", "HOUSING", "NOBROKER", "OTHER"];

/** Which portal a sender's address belongs to. Makaan is Housing.com's sister site. */
const PORTAL_DOMAINS: [PortalKey, RegExp][] = [
  ["99ACRES", /(^|\.)99acres\.com$/i],
  ["MAGICBRICKS", /(^|\.)magicbricks\.com$/i],
  ["HOUSING", /(^|\.)(housing\.com|makaan\.com|proptiger\.com)$/i],
  ["NOBROKER", /(^|\.)nobroker\.(in|com)$/i],
  ["OTHER", /(^|\.)(squareyards\.com|commonfloor\.com|quikr\.com|olx\.in|sulekha\.com)$/i],
];

/** A portal named in words, for an email that came through somebody's own mailbox. */
const PORTAL_WORDS: [PortalKey, RegExp][] = [
  ["99ACRES", /\b99\s?acres\b/i],
  ["MAGICBRICKS", /\bmagic\s?bricks\b/i],
  ["HOUSING", /\bhousing\.com\b|\bmakaan\b/i],
  ["NOBROKER", /\bno\s?broker\b/i],
];

export const portalLabel = (k: PortalKey): string => PORTAL_LABELS[k] ?? "Property portal";

export const isPortalKey = (s: unknown): s is PortalKey => typeof s === "string" && (PORTAL_KEYS as string[]).includes(s);

const domainOf = (addr: string | null): string | null => {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})>?\s*$/i.exec((addr ?? "").trim());
  return m ? m[1].toLowerCase() : null;
};

/**
 * The portal an email came from: its sender's domain first, then the one
 * portal the subject and body name. Two portals named, or none, is OTHER.
 */
export function portalOf(from: string | null, subject: string, body: string): PortalKey {
  const d = domainOf(from);
  if (d) for (const [k, re] of PORTAL_DOMAINS) if (re.test(d)) return k;
  const said = PORTAL_WORDS.filter(([, re]) => re.test(subject) || re.test(body)).map(([k]) => k);
  return said.length === 1 ? said[0] : "OTHER";
}

// ---------------------------------------------------------------------------
// The keys and the address
// ---------------------------------------------------------------------------

/**
 * The key a portal email or a forwarding service proves itself with: an HMAC
 * of the organisation and its key version, in its own namespace, so it opens
 * nothing a capture key or a call's address opens. Rotating bumps the
 * version and the old key stops working at once.
 */
export function portalKey(secret: string, orgId: string, version: number): string {
  return createHmac("sha256", secret).update(`portal:${orgId}:${version}`).digest("hex").slice(0, 32);
}

export function portalKeyValid(secret: string, orgId: string, version: number, key: string, length = 32): boolean {
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "i").test(key)) return false;
  const want = Buffer.from(portalKey(secret, orgId, version).slice(0, length), "hex");
  const got = Buffer.from(key.toLowerCase(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Characters of the key carried in the email address (64 bits). */
export const MAILBOX_KEY_CHARS = 16;

/**
 * The address an organisation forwards its portal emails to:
 * `leads-<org without dashes>-<16 hex>@<domain>`, 55 characters before the
 * at sign, inside the 64 an address allows.
 */
export function portalMailbox(orgId: string, key: string, domain: string): string {
  return `leads-${orgId.replace(/-/g, "").toLowerCase()}-${key.slice(0, MAILBOX_KEY_CHARS).toLowerCase()}@${domain.toLowerCase()}`;
}

/** The organisation and key an address names, or null. The key is proved by the caller. */
export function readMailbox(address: string, domain: string | null): { orgId: string; key: string } | null {
  const m = /^\s*<?leads-([0-9a-f]{32})-([0-9a-f]{16})@([a-z0-9.-]+)>?\s*$/i.exec(address);
  if (!m) return null;
  if (domain && m[3].toLowerCase() !== domain.toLowerCase()) return null;
  const h = m[1].toLowerCase();
  return { orgId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`, key: m[2].toLowerCase() };
}

// ---------------------------------------------------------------------------
// Reading an email: MIME, HTML, quoted replies
// ---------------------------------------------------------------------------

export type PortalEmail = {
  from: string | null;
  subject: string;
  text: string | null;
  html: string | null;
};

const MAX_EMAIL_CHARS = 400_000;

function decodeBytes(bytes: Buffer, charset: string | null): string {
  const cs = (charset ?? "utf-8").toLowerCase().replace(/^"|"$/g, "");
  try {
    return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function quotedPrintable(s: string): Buffer {
  const soft = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i];
    if (c === "=" && /^[0-9a-f]{2}$/i.test(soft.slice(i + 1, i + 3))) {
      out.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(c, "utf8")) out.push(b);
    }
  }
  return Buffer.from(out);
}

/** `=?utf-8?B?...?=` and `=?utf-8?Q?...?=` in a header, decoded. */
export function decodeHeader(v: string): string {
  return v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs: string, enc: string, data: string) =>
      decodeBytes(
        enc.toLowerCase() === "b" ? Buffer.from(data, "base64") : quotedPrintable(data.replace(/_/g, " ")),
        cs,
      ),
    );
}

type Part = { headers: Map<string, string>; body: string };

function splitPart(raw: string): Part {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? "" : raw.slice(at).replace(/^\r?\n\r?\n/, "");
  const headers = new Map<string, string>();
  let last: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      headers.set(last, `${headers.get(last)} ${line.trim()}`);
      continue;
    }
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    last = m[1].toLowerCase();
    if (!headers.has(last)) headers.set(last, m[2]);
  }
  return { headers, body };
}

const param = (header: string | undefined, name: string): string | null => {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(header ?? "");
  return m ? (m[2] ?? m[1]) : null;
};

function partText(p: Part): string {
  const enc = (p.headers.get("content-transfer-encoding") ?? "").toLowerCase().trim();
  const charset = param(p.headers.get("content-type"), "charset");
  if (enc === "base64") return decodeBytes(Buffer.from(p.body.replace(/\s+/g, ""), "base64"), charset);
  if (enc === "quoted-printable") return decodeBytes(quotedPrintable(p.body), charset);
  return p.body;
}

function walk(p: Part, out: { text: string | null; html: string | null }, depth = 0): void {
  if (depth > 6) return;
  const type = (p.headers.get("content-type") ?? "text/plain").toLowerCase();
  if (/attachment/i.test(p.headers.get("content-disposition") ?? "")) return;
  if (type.startsWith("multipart/")) {
    const boundary = param(p.headers.get("content-type"), "boundary");
    if (!boundary) return;
    const pieces = p.body.split(`--${boundary}`).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith("--")) break;
      walk(splitPart(piece.replace(/^\r?\n/, "")), out, depth + 1);
    }
    return;
  }
  if (type.startsWith("message/rfc822")) {
    walk(splitPart(p.body), out, depth + 1);
    return;
  }
  if (type.startsWith("text/html") && out.html === null) out.html = partText(p);
  else if (type.startsWith("text/plain") && out.text === null) out.text = partText(p);
}

/** A raw email as SES receives it (RFC 5322 and MIME), read into its sender, subject and two bodies. */
export function parseMime(raw: string): PortalEmail {
  const top = splitPart(raw.slice(0, MAX_EMAIL_CHARS));
  const out = { text: null as string | null, html: null as string | null };
  walk(top, out);
  return {
    from: top.headers.has("from") ? decodeHeader(top.headers.get("from")!) : null,
    subject: decodeHeader(top.headers.get("subject") ?? "").trim(),
    text: out.text,
    html: out.html,
  };
}

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...", rupee: "Rs", copy: "(c)",
};

/** An HTML email as lines of text: a table row is one line, its cells split by a tab. */
export function htmlToText(html: string): string {
  return html
    .slice(0, MAX_EMAIL_CHARS)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|blockquote)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d{1,6});/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .split(/\r?\n/)
    .map((l) => l.replace(/[  ]+/g, " ").replace(/\s*\t\s*/g, "\t").replace(/^\t+|\t+$/g, "").replace(/\t{2,}/g, "\t").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/** What a forwarded email's own header block said, when somebody forwarded it by hand. */
type Forwarded = { from: string | null; subject: string | null; body: string };

/**
 * The email as the portal wrote it. A reply above it ("Please add this one")
 * and anything quoted below ("On ... wrote:", "> ...") is cut; a forward's
 * own header block names the real sender and subject.
 */
export function originalPart(text: string): Forwarded {
  let body = text.replace(/\r\n/g, "\n");
  let from: string | null = null;
  let subject: string | null = null;
  const fwd = /^[-\s]*(?:-{3,}\s*)?(?:forwarded message|original message|begin forwarded message:?)\s*-*\s*$/im.exec(body);
  if (fwd) {
    body = body.slice(fwd.index + fwd[0].length);
    const lines = body.split("\n");
    let i = 0;
    while (i < lines.length && (lines[i].trim() === "" || /^(from|date|sent|subject|to|cc)\s*:/i.test(lines[i].trim()))) {
      const m = /^(from|subject)\s*:\s*(.*)$/i.exec(lines[i].trim());
      if (m && m[1].toLowerCase() === "from") from = m[2];
      if (m && m[1].toLowerCase() === "subject") subject = m[2];
      i++;
    }
    body = lines.slice(i).join("\n");
  }
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (/^on\b.{4,200}\bwrote:?$/i.test(t)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^_{8,}$/.test(t)) break;
    if (t.startsWith(">")) continue;
    lines.push(line);
  }
  return { from, subject, body: lines.join("\n").trim() };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type Field = "name" | "phone" | "email" | "project" | "message" | "id" | "date";

/** The words portals put before each value, as `labelKey()` reads them. */
const LABELS: Record<Field, string[]> = {
  name: [
    "name", "full name", "buyer name", "buyers name", "customer name", "client name", "contact name", "lead name",
    "sender name", "user name", "enquirer name", "visitor name", "contact person", "username", "leadname",
  ],
  phone: [
    "mobile", "mobile no", "mobile number", "mob", "mob no", "phone", "phone no", "phone number", "contact no",
    "contact number", "contact", "cell", "cell no", "telephone", "tel", "whatsapp", "whatsapp no", "whatsapp number",
    "buyer mobile", "buyers mobile", "customer mobile", "customer phone", "mobile phone", "contact details",
    "lead phone", "lead mobile", "lead contact", "sender mobile", "sender phone", "user mobile", "user phone",
    "mobileno", "phoneno", "contactno", "mobilenumber", "phonenumber",
  ],
  email: [
    "email", "email id", "e mail", "e mail id", "email address", "mail id", "buyer email", "customer email",
    "lead email", "sender email", "user email", "emailid",
  ],
  // In order of trust: "Interested in" often says "2 BHK", so a label that
  // names the project or property wins over it wherever it sits.
  project: [
    "project", "project name", "property", "property name", "property title", "listing", "listing name",
    "listing title", "society", "society name", "building", "building name", "enquiry for", "enquired for",
    "response for", "lead for", "query for", "property interested", "project interested", "interested project",
    "interested in", "projectname", "lead project",
  ],
  message: [
    "message", "buyers message", "buyer message", "query", "requirement", "requirements", "comments", "comment",
    "remarks", "details", "description", "lead message", "user message", "msg",
  ],
  id: [
    "lead id", "lead no", "lead number", "enquiry id", "enquiry no", "inquiry id", "query id", "response id",
    "reference id", "reference no", "ref id", "ref no", "ticket id", "leadid", "enquiryid", "queryid",
  ],
  date: [
    "date", "enquiry date", "inquiry date", "lead date", "received on", "received", "created on", "created at",
    "date time", "date and time", "response date", "query date", "submitted on", "timestamp", "created date",
    "enquired on", "lead time", "query time",
  ],
};

export const labelKey = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(the|of|your)\b/g, " ").replace(/\s+/g, " ").trim();

const LABEL_OF = new Map<string, { field: Field; rank: number }>();
for (const [f, words] of Object.entries(LABELS) as [Field, string[]][]) {
  words.forEach((w, rank) => LABEL_OF.set(labelKey(w), { field: f, rank }));
}

export const fieldOf = (label: string): Field | null => LABEL_OF.get(labelKey(label.replace(/[:*]+\s*$/, "")))?.field ?? null;
const rankOf = (label: string): number => LABEL_OF.get(labelKey(label.replace(/[:*]+\s*$/, "")))?.rank ?? 99;

/**
 * Every labelled value in a body: `Label: value`, `Label - value`, a table
 * row `Label<tab>value`, or a label alone on its line with the value on the
 * next. The first value of each field wins.
 */
export function labelled(body: string): Map<Field, string> {
  const out = new Map<Field, string>();
  const rank = new Map<Field, number>();
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // The first value under the most trusted label of each field wins.
  const put = (label: string, v: string) => {
    const f = fieldOf(label);
    const s = v.replace(/\s+/g, " ").trim();
    if (!f || !s) return;
    const r = rankOf(label);
    if (out.has(f) && rank.get(f)! <= r) return;
    out.set(f, s.slice(0, 600));
    rank.set(f, r);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cells = line.split("\t");
    if (cells.length >= 2) {
      // A table whose first row is all labels and whose next row is values.
      const next = lines[i + 1]?.split("\t");
      if (cells.every((c) => fieldOf(c)) && next && next.length === cells.length && !next.some((c) => fieldOf(c))) {
        cells.forEach((c, k) => put(c, next[k]));
        i++;
        continue;
      }
      // A row of label and value pairs.
      for (let c = 0; c + 1 < cells.length; c++) {
        if (fieldOf(cells[c])) {
          put(cells[c], cells[c + 1]);
          c++;
        }
      }
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9 '’/().&_-]{0,40}?)\s*(?::|\s-\s|\s–\s|=)\s*(.*)$/.exec(line);
    if (m && fieldOf(m[1])) {
      if (m[2]) put(m[1], m[2]);
      else if (lines[i + 1] && !fieldOf(lines[i + 1])) put(m[1], lines[++i]);
      continue;
    }
    if (fieldOf(line) && lines[i + 1] && !fieldOf(lines[i + 1]) && !lines[i + 1].includes("\t")) put(line, lines[++i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const PHONE_RUN = /(?<![\dA-Za-z])(?:\+|00)?[\d][\d\s().-]{7,18}\d(?![\dA-Za-z])/g;

/** A number a person typed, as E.164, or null. A masked one ("98XXXXXX10") is null. */
export function phoneIn(value: string): string | null {
  const ascii = value.replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966));
  for (const m of ascii.matchAll(PHONE_RUN)) {
    const n = normalisePhone(m[0].replace(/^00/, "+"));
    if (n) return n;
  }
  return null;
}

const isIndianMobile = (e164: string) => /^\+91[6-9]\d{9}$/.test(e164);

/** A number a portal hid: digits with X or * in the middle. */
export const looksMasked = (v: string): boolean => /\d{2,}[\sX*x•]{3,}\d{1,4}/.test(v) && /[X*x•]{3,}/.test(v);

/** Every distinct Indian mobile anywhere in a body, for an email that labels none. */
export function mobilesIn(body: string): string[] {
  const ascii = body.replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966));
  const seen = new Set<string>();
  for (const m of ascii.matchAll(PHONE_RUN)) {
    const n = normalisePhone(m[0].replace(/^00/, "+"));
    if (n && isIndianMobile(n)) seen.add(n);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// The project, as the portal named it
// ---------------------------------------------------------------------------

/** The wording a mapping is keyed on: lower case, letters and digits, spaces collapsed. */
export function projectKey(text: string | null): string {
  const k = (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return k || NO_PROJECT;
}

/** The key for an enquiry that named no project at all; a person may still match it. */
export const NO_PROJECT = "(none)";

const PORTAL_TAIL = /\s*(?:[-|:,]\s*)?(?:on\s+)?(?:99\s?acres(?:\.com)?|magic\s?bricks(?:\.com)?|housing(?:\.com)?|no\s?broker(?:\.in|\.com)?|makaan(?:\.com)?)\s*$/i;

/** The project a subject line names: "New enquiry for Sath Heights - 99acres". */
export function projectFromSubject(subject: string): string | null {
  const s = subject.replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "");
  const m = /\b(?:for|on|in|regarding|about)\s+(?:your\s+)?(?:(?:project|property|listing|ad)\s*[:\-]?\s+)?(.{2,120})$/i.exec(s);
  if (!m) return null;
  const v = m[1].replace(PORTAL_TAIL, "").replace(/^["'“]|["'”]$/g, "").trim();
  return v.length >= 2 ? v : null;
}

// ---------------------------------------------------------------------------
// One lead, read
// ---------------------------------------------------------------------------

export type PortalLead = {
  portal: PortalKey;
  name: string;
  /** E.164. */
  phone: string;
  email: string | null;
  /** The project as the portal wrote it, or null when it named none. */
  projectText: string | null;
  projectKey: string;
  message: string | null;
  /** The portal's own id for the enquiry, when it printed one. */
  portalId: string | null;
  /** The event's key: the portal's id, else a fingerprint and the IST day. */
  externalId: string;
};

export type PortalRead = { ok: true; lead: PortalLead } | { ok: false; portal: PortalKey; reason: string };

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const cleanId = (v: string | undefined): string | null => {
  const m = /[A-Za-z0-9][A-Za-z0-9_/-]{2,60}/.exec(v ?? "");
  return m && /\d/.test(m[0]) ? m[0] : null;
};

const cleanText = (v: string | undefined | null, max: number): string | null => {
  const s = (v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** The name from a sentence, for an email that labels none: "Priya Nair has shown interest in ...". */
function nameFromSentence(body: string): string | null {
  const m = /^\s*(?:dear\s+\w+[,.]?\s*)?([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,3})\s+(?:has\s+(?:shown\s+interest|enquired|responded|contacted)|is\s+interested|wants\s+to|enquired)/m.exec(body);
  return m ? m[1] : null;
}

function emailIn(body: string, portalDomain: string | null): string | null {
  for (const m of body.matchAll(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,150}\.[A-Za-z]{2,}/g)) {
    const e = m[0].toLowerCase();
    if (/^(no-?reply|noreply|donotreply|do-not-reply|support|info|help|alerts?|notifications?|response|leads?)@/.test(e)) continue;
    if (portalDomain && e.endsWith(`@${portalDomain}`)) continue;
    if (PORTAL_DOMAINS.some(([, re]) => re.test(e.split("@")[1]))) continue;
    return cleanEmail(e);
  }
  return null;
}

/** The pieces common to an email and a spreadsheet row, checked and keyed. */
function finish(o: {
  portal: PortalKey;
  fields: Map<Field, string>;
  phone: string;
  fallbackName?: string | null;
  fallbackEmail?: string | null;
  fallbackProject?: string | null;
  dayIso: string;
}): PortalLead {
  const projectText = cleanText(o.fields.get("project") ?? o.fallbackProject, 160);
  const key = projectKey(projectText);
  const message = cleanText(o.fields.get("message"), 500);
  const portalId = cleanId(o.fields.get("id"));
  const externalId = portalId
    ? `${o.portal}:${portalId}`
    : `${o.portal}:fp:${fnv(`${o.phone}|${key}|${message ?? ""}`)}:${istDate(o.dayIso)}`;
  return {
    portal: o.portal,
    name: cleanName(o.fields.get("name") ?? o.fallbackName ?? null),
    phone: o.phone,
    email: cleanEmail(o.fields.get("email") ?? null) ?? o.fallbackEmail ?? null,
    projectText,
    projectKey: key,
    message,
    portalId,
    externalId: externalId.slice(0, 200),
  };
}

/** Why a labelled number is not a lead, or the number. */
function readPhone(raw: string | undefined, body: string): { phone: string } | { reason: string } {
  if (raw) {
    if (looksMasked(raw)) return { reason: "The portal hid the buyer's number in this email." };
    const n = phoneIn(raw);
    if (n) return { phone: n };
  }
  if (looksMasked(body) && mobilesIn(body).length === 0) return { reason: "The portal hid the buyer's number in this email." };
  const all = mobilesIn(body);
  if (all.length === 1) return { phone: all[0] };
  if (all.length > 1) return { reason: "The email has more than one mobile number, and none is labelled as the buyer's." };
  return { reason: "No mobile number in the email." };
}

/**
 * A portal's notification email, read into one lead or a reason it is not
 * one. `receivedIso` is when it reached us, for the fingerprint's day.
 */
export function readPortalEmail(email: PortalEmail, receivedIso: string): PortalRead {
  const plain = email.text?.trim() ? email.text : null;
  const fromHtml = email.html ? htmlToText(email.html) : null;
  // The plain part first; an HTML part when the plain one is a "view in a
  // browser" stub without a number in it.
  const candidates = [plain, fromHtml].filter((b): b is string => !!b);
  if (!candidates.length) return { ok: false, portal: portalOf(email.from, email.subject, ""), reason: "The email had no text." };
  let best: { body: Forwarded; fields: Map<Field, string> } | null = null;
  for (const c of candidates) {
    const body = originalPart(c);
    const fields = labelled(body.body);
    if (!best || (fields.has("phone") && !best.fields.has("phone")) || fields.size > best.fields.size + 1) best = { body, fields };
    if (fields.has("phone")) break;
  }
  const { body, fields } = best!;
  const from = body.from ?? email.from;
  const subject = body.subject ?? email.subject;
  const portal = portalOf(from, subject, body.body);
  const got = readPhone(fields.get("phone"), body.body);
  if ("reason" in got) return { ok: false, portal, reason: got.reason };
  const lead = finish({
    portal,
    fields,
    phone: got.phone,
    fallbackName: nameFromSentence(body.body),
    fallbackEmail: fields.has("email") ? null : emailIn(body.body, domainOf(from)),
    fallbackProject: projectFromSubject(subject),
    dayIso: receivedIso,
  });
  return { ok: true, lead };
}

/** A fingerprint for an email that is not a lead, so the same one sent twice is counted once. */
export function refusedId(portal: PortalKey, email: PortalEmail, receivedIso: string): string {
  return `${portal}:refused:${fnv(`${email.subject}|${(email.text ?? email.html ?? "").slice(0, 4000)}`)}:${istDate(receivedIso)}`;
}

// ---------------------------------------------------------------------------
// A portal's spreadsheet export
// ---------------------------------------------------------------------------

export const MAX_PORTAL_ROWS = 2_000;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The day an enquiry came in, as a portal export writes it, as YYYY-MM-DD,
 * or null. Day first, the way Indian exports are written: 03/10/2026 is the
 * third of October. An Excel serial (45934) is read too.
 */
export function enquiryDay(raw: string | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  // Epoch seconds or milliseconds, the way a portal's API writes it, as the IST day.
  if (/^\d{10}$|^\d{13}$/.test(s)) {
    const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
    return ms > Date.UTC(2015, 0, 1) && ms < Date.UTC(2100, 0, 1) ? istDate(new Date(ms).toISOString()) : null;
  }
  const ymd =(y: number, m: number, d: number) => {
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(s);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3})[a-z]*[\s,-]+(\d{2,4})\b/.exec(s);
  if (m && MONTHS.includes(m[2])) return ymd(+m[3], MONTHS.indexOf(m[2]) + 1, +m[1]);
  m = /^([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s);
  if (m && MONTHS.includes(m[1])) return ymd(+m[3], MONTHS.indexOf(m[1]) + 1, +m[2]);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial > 40_000 && serial < 60_000) return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

export type CsvRead =
  | { ok: true; leads: { line: number; lead: PortalLead }[]; refused: { line: number; reason: string }[] }
  | { ok: false; message: string };

/**
 * A portal's export, one row per enquiry. The header row is the first row
 * naming a phone column; its columns are found by the same labels an email
 * uses. A row older than the enquiry window is refused: an export of last
 * month's enquiries must not have the AI ringing people who asked weeks ago.
 * So the date column is required.
 */
export function readPortalSheet(rows: readonly (readonly string[])[], portal: PortalKey, todayIso: string): CsvRead {
  const headAt = rows.slice(0, 15).findIndex((r) => r.some((c) => fieldOf(c) === "phone"));
  if (headAt < 0) return { ok: false, message: "No column for the buyer's mobile number. Export the leads with their phone numbers." };
  const head = rows[headAt];
  const col = new Map<Field, number>();
  head.forEach((c, i) => {
    const f = fieldOf(c);
    if (f && !col.has(f)) col.set(f, i);
  });
  if (!col.has("date")) return { ok: false, message: "No column for the date of each enquiry. Export the leads with their dates." };
  const body = rows.slice(headAt + 1);
  if (body.length > MAX_PORTAL_ROWS) return { ok: false, message: `The file has over ${MAX_PORTAL_ROWS.toLocaleString("en-IN")} rows. Export a shorter period.` };
  const today = istDate(todayIso);
  const oldest = istDate(new Date(Date.parse(todayIso) - ENQUIRY_DAYS * 86_400_000).toISOString());
  const leads: { line: number; lead: PortalLead }[] = [];
  const refused: { line: number; reason: string }[] = [];
  body.forEach((r, i) => {
    const line = headAt + i + 2;
    if (r.every((c) => !c.trim())) return;
    const fields = new Map<Field, string>();
    for (const [f, at] of col) if (r[at]?.trim()) fields.set(f, r[at].trim());
    const day = enquiryDay(fields.get("date"));
    if (!day) return void refused.push({ line, reason: "The date could not be read." });
    if (day > today) return void refused.push({ line, reason: "The date is in the future." });
    if (day < oldest) return void refused.push({ line, reason: `Enquired over ${ENQUIRY_DAYS} days ago.` });
    const raw = fields.get("phone");
    if (raw && looksMasked(raw)) return void refused.push({ line, reason: "The number is hidden." });
    const phone = raw ? phoneIn(raw) : null;
    if (!phone) return void refused.push({ line, reason: "No mobile number that could be read." });
    leads.push({ line, lead: finish({ portal, fields, phone, dayIso: `${day}T06:30:00.000Z` }) });
  });
  return { ok: true, leads, refused };
}

// ---------------------------------------------------------------------------
// A portal posting its leads straight to us
// ---------------------------------------------------------------------------

/** Leads one post may carry; the rest of a bigger batch is refused, not guessed at. */
export const MAX_PUSH_LEADS = 50;

/** Wrappers a portal or its API puts a list of leads inside. */
const LIST_KEYS = ["data", "leads", "lead", "result", "results", "records", "items", "response", "payload"];

/** The records a post or an API answer carries: one object, a list, or a list inside a wrapper. */
export function pushRecords(body: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 2 || body === null || typeof body !== "object") return [];
  if (Array.isArray(body)) return body.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
  const o = body as Record<string, unknown>;
  for (const k of LIST_KEYS) {
    const v = o[k];
    // A list under a wrapper's key is the answer, even an empty one.
    if (Array.isArray(v) && (v.length === 0 || v.some((x) => x && typeof x === "object"))) return pushRecords(v, depth + 1);
    if (v && typeof v === "object") {
      const inner = pushRecords(v, depth + 1);
      if (inner.length) return inner;
    }
  }
  return [o];
}

/** A key as words: `lead_phone`, `leadPhone` and `lead-phone` all read "lead Phone". */
const keyWords = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.\-]+/g, " ").trim();

/** One record's fields as `Label: value` lines, nested objects read by their own keys. */
function recordLines(o: Record<string, unknown>, depth = 0): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      if (depth < 2) out.push(...recordLines(v as Record<string, unknown>, depth + 1));
      continue;
    }
    const s = (Array.isArray(v) ? v.filter((x) => typeof x !== "object").join(", ") : String(v)).replace(/\s+/g, " ").trim();
    if (s) out.push(`${keyWords(k).slice(0, 40)}: ${s.slice(0, 600)}`);
  }
  return out;
}

const firstOf = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const [k, v] of Object.entries(o)) {
    if ((typeof v === "string" || typeof v === "number") && keys.includes(labelKey(keyWords(k)))) {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return null;
};

export type PushRead = { leads: PortalLead[]; refused: { index: number; reason: string }[] };

/** A fingerprint for a posted record that is not a lead, so the same one posted twice is counted once. */
export function refusedRecordId(portal: PortalKey, record: unknown, receivedIso: string): string {
  return `${portal}:refused:${fnv(JSON.stringify(record ?? null).slice(0, 4000))}:${istDate(receivedIso)}`;
}

/**
 * What a portal posted, or its API answered, read into leads. Each record's
 * keys are read by the same labels an email uses (`lead_phone`, `mobileNo`,
 * `Project Name`), never by position. A record with no number, a hidden
 * one, or an enquiry older than the enquiry window is refused with why; a
 * record nothing in which reads as a field at all is not counted.
 */
export function readPortalPush(body: unknown, portal: PortalKey, receivedIso: string): PushRead {
  const records = pushRecords(body);
  const out: PushRead = { leads: [], refused: [] };
  const today = istDate(receivedIso);
  const oldest = istDate(new Date(Date.parse(receivedIso) - ENQUIRY_DAYS * 86_400_000).toISOString());
  records.forEach((rec, index) => {
    if (index >= MAX_PUSH_LEADS) {
      if (index === MAX_PUSH_LEADS) out.refused.push({ index, reason: `More than ${MAX_PUSH_LEADS} leads in one post.` });
      return;
    }
    const fields = labelled(recordLines(rec).join("\n"));
    if (!fields.size) return;
    if (!fields.has("name")) {
      const n = [firstOf(rec, ["first name", "firstname", "fname"]), firstOf(rec, ["last name", "lastname", "lname", "surname"])].filter(Boolean).join(" ");
      if (n) fields.set("name", n);
    }
    let raw = fields.get("phone");
    if (!raw) return void out.refused.push({ index, reason: "No mobile number in it." });
    if (looksMasked(raw)) return void out.refused.push({ index, reason: "The portal hid the buyer's number." });
    const isd = (firstOf(rec, ["isd", "isd code", "country code", "phone code", "dial code", "calling code"]) ?? "").replace(/\D/g, "");
    if (isd && isd !== "91" && !raw.trim().startsWith("+")) raw = `+${isd}${raw.replace(/^0+/, "")}`;
    const phone = phoneIn(raw);
    if (!phone) return void out.refused.push({ index, reason: "The number could not be read." });
    const day = enquiryDay(fields.get("date"));
    if (day && day < oldest) return void out.refused.push({ index, reason: `Enquired over ${ENQUIRY_DAYS} days ago.` });
    const dayIso = day && day <= today ? `${day}T06:30:00.000Z` : receivedIso;
    // A bare `id` is the record's own id when nothing else named one.
    if (!fields.has("id")) {
      const id = firstOf(rec, ["id", "uid", "uuid"]);
      if (id) fields.set("id", id);
    }
    out.leads.push(finish({ portal, fields, phone, dayIso }));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Housing.com's builder lead API, which we ask
// ---------------------------------------------------------------------------

/**
 * Housing.com publishes one lead API for builders: a GET with the account's
 * id, a time range in epoch seconds, the current time, and an HMAC-SHA256 of
 * that time under the account's secret key. A request more than 15 minutes
 * old is refused, so the hash is made at the moment of asking.
 */
export const HOUSING_LEADS_URL = "https://leads.housing.com/api/v0/get-builder-leads";

/** How often an account is asked. */
export const HOUSING_PULL_MINUTES = 10;

/** How far back a window reaches past the last one, so a lead filed late is still read. */
export const HOUSING_OVERLAP_MINUTES = 30;

export function housingHash(key: string, currentTime: string): string {
  return createHmac("sha256", key).update(currentTime).digest("hex");
}

/** The account id as Housing.com issues it; never anything that could reshape the request. */
export const housingIdOk = (id: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(id);

export function housingUrl(o: { id: string; key: string; fromSec: number; toSec: number; nowSec: number }): string {
  const t = String(Math.floor(o.nowSec));
  const q = new URLSearchParams({
    start_date: String(Math.floor(o.fromSec)),
    end_date: String(Math.floor(o.toSec)),
    current_time: t,
    hash: housingHash(o.key, t),
    id: o.id,
  });
  return `${HOUSING_LEADS_URL}?${q}`;
}

/**
 * The window to ask for: from the end of the last one, less the overlap,
 * to now. The first ask reaches back a day, and no ask further than the
 * enquiry window, because a lead older than that is never called.
 */
export function housingWindow(pulledUntilIso: string | null, nowIso: string): { fromSec: number; toSec: number } {
  const now = Date.parse(nowIso);
  const floor = now - ENQUIRY_DAYS * 86_400_000;
  const from = pulledUntilIso ? Date.parse(pulledUntilIso) - HOUSING_OVERLAP_MINUTES * 60_000 : now - 86_400_000;
  return { fromSec: Math.floor(Math.max(from, floor) / 1000), toSec: Math.floor(now / 1000) };
}

/** Whether an account is due to be asked again. */
export const housingDue = (lastPullIso: string | null, nowIso: string): boolean =>
  !lastPullIso || Date.parse(nowIso) - Date.parse(lastPullIso) >= HOUSING_PULL_MINUTES * 60_000 - 30_000;

export type HousingAnswer =
  | { ok: true; read: PushRead }
  | { ok: false; broken: boolean; reason: string };

/**
 * What Housing.com answered. A 401 is the id or key refused (or our clock
 * off by over 15 minutes), which another ask will not mend; anything else
 * that fails is asked again next time.
 */
export function housingAnswer(status: number, body: unknown, nowIso: string): HousingAnswer {
  if (status === 401 || status === 403) return { ok: false, broken: true, reason: "Housing.com did not accept the account id or key." };
  if (status === 422) return { ok: false, broken: false, reason: "Housing.com said the request was missing something." };
  if (status < 200 || status >= 300) return { ok: false, broken: false, reason: `Housing.com did not answer (${status}).` };
  return { ok: true, read: readPortalPush(body, "HOUSING", nowIso) };
}

// ---------------------------------------------------------------------------
// Amazon SNS: proving a message came from AWS
// ---------------------------------------------------------------------------

/**
 * The string SNS signs, as its documentation lists it: each key and its
 * value on their own lines, in this order, a key absent from the message
 * left out (only a notification's Subject may be).
 */
export function snsStringToSign(m: Record<string, unknown>): string | null {
  const keys =
    m.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : m.Type === "SubscriptionConfirmation" || m.Type === "UnsubscribeConfirmation"
        ? ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
        : null;
  if (!keys) return null;
  let out = "";
  for (const k of keys) {
    const v = m[k];
    if (v === undefined || v === null) {
      if (k === "Subject") continue;
      return null;
    }
    if (typeof v !== "string") return null;
    out += `${k}\n${v}\n`;
  }
  return out;
}

/** The certificate a signature is checked with: an AWS SNS host's own .pem, nothing else. */
export function snsCertUrlOk(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname) && u.pathname.endsWith(".pem");
  } catch {
    return false;
  }
}

/** The digest a SignatureVersion names: 1 is SHA1, 2 is SHA256. */
export const snsDigest = (version: unknown): "RSA-SHA1" | "RSA-SHA256" | null =>
  version === "1" ? "RSA-SHA1" : version === "2" ? "RSA-SHA256" : null;

// ---------------------------------------------------------------------------
// Matching the portal's project to a tower
// ---------------------------------------------------------------------------

export type PlaceNode = { id: string; kind: string; name: string; path: string };

/**
 * The tower a portal's wording names without anybody choosing: the wording
 * is exactly one tower's name, or that tower's project and name together, or
 * a project's name when the project has exactly one tower. Anything else
 * waits for a person.
 */
export function autoMatch(key: string, nodes: readonly PlaceNode[]): string | null {
  if (key === NO_PROJECT) return null;
  const phases = nodes.filter((n) => n.kind === "PHASE");
  const projects = nodes.filter((n) => n.kind === "PROJECT");
  const under = (p: PlaceNode) => phases.filter((t) => t.path.startsWith(`${p.path}.`));
  const hits = new Set<string>();
  for (const t of phases) {
    const proj = projects.find((p) => t.path.startsWith(`${p.path}.`));
    if (projectKey(t.name) === key) hits.add(t.id);
    if (proj && (projectKey(`${proj.name} ${t.name}`) === key || projectKey(`${t.name} ${proj.name}`) === key)) hits.add(t.id);
  }
  for (const p of projects) {
    if (projectKey(p.name) !== key) continue;
    const ts = under(p);
    if (ts.length === 1) hits.add(ts[0].id);
    else if (ts.length > 1) return null;
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** The enquiry as the capture path takes it, once a tower is known. */
export function capturedFrom(lead: PortalLead, phaseId: string | null): CapturedLead {
  return {
    channel: "PORTAL",
    externalId: lead.externalId,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    language: languageOf(null, lead.name),
    // A portal's enquiry form is the portal's, not ours: no consent to calls
    // or WhatsApp marketing is recorded. The enquiry window allows a call
    // inside seven days, as for a Google form.
    consent: null,
    measurement: null,
    lineage: { portal: lead.portal, ...(lead.projectText ? { portalProject: lead.projectText.slice(0, 160) } : {}) },
    phaseId,
    isTest: false,
  };
}

// ---------------------------------------------------------------------------
// What arrives at the door
// ---------------------------------------------------------------------------

export type Inbound =
  | { kind: "email"; email: PortalEmail; to: string[]; topicArn: string | null }
  | { kind: "subscribe"; topicArn: string; subscribeUrl: string }
  | { kind: "ignore" };

/**
 * An SES receipt delivered through SNS: `Message` is JSON holding `mail`
 * (with the recipients) and `content`, the raw email, base64 or as text.
 * A subscription confirmation is handed back for the route to confirm.
 */
export function readSns(body: unknown): Inbound {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.Type === "SubscriptionConfirmation" && typeof b.SubscribeURL === "string" && typeof b.TopicArn === "string") {
    return { kind: "subscribe", topicArn: b.TopicArn, subscribeUrl: b.SubscribeURL };
  }
  if (b.Type !== "Notification" || typeof b.Message !== "string") return { kind: "ignore" };
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(b.Message) as Record<string, unknown>;
  } catch {
    return { kind: "ignore" };
  }
  const mail = (msg.mail ?? {}) as { destination?: unknown };
  const receipt = (msg.receipt ?? {}) as { recipients?: unknown; action?: { encoding?: unknown }; virusVerdict?: { status?: unknown } };
  // SES scanned it; a message carrying a virus is dropped unread.
  if (receipt.virusVerdict?.status === "FAIL") return { kind: "ignore" };
  const to = [receipt.recipients, mail.destination]
    .flatMap((x) => (Array.isArray(x) ? x : []))
    .filter((x): x is string => typeof x === "string");
  if (typeof msg.content !== "string") return { kind: "ignore" };
  const raw = receipt.action?.encoding === "BASE64" ? Buffer.from(msg.content, "base64").toString("utf8") : msg.content;
  return { kind: "email", email: parseMime(raw), to, topicArn: typeof b.TopicArn === "string" ? b.TopicArn : null };
}

/** A generic JSON post from a forwarding service: `{ from, subject, text, html }`. */
export function readJsonEmail(body: unknown): PortalEmail | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
  if (typeof b.raw === "string" && b.raw.trim()) return parseMime(b.raw);
  const text = s(b.text ?? b.plain ?? b["body-plain"], MAX_EMAIL_CHARS);
  const html = s(b.html ?? b["body-html"], MAX_EMAIL_CHARS);
  if (!text && !html) return null;
  return { from: s(b.from ?? b.sender, 400), subject: s(b.subject, 400) ?? "", text, html };
}

/** The SNS address a subscription may be confirmed at: AWS's own host, nothing else. */
export function snsConfirmUrlOk(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The card's words
// ---------------------------------------------------------------------------

/** Why an event is waiting, as stored on it: the portal's wording, quoted. */
export const waitingReason = (text: string | null): string =>
  `Waiting for a project match: ${text ? `"${text.slice(0, 160)}"` : "no project named"}`.slice(0, 500);
