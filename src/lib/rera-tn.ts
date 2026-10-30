/**
 * Tamil Nadu RERA (rera.tn.gov.in): a search at the form where it reaches,
 * the published lists everywhere else.
 *
 * The portal is Laravel, with no CAPTCHA and no login. Its robots.txt
 * disallows `/uploads/` and PDFs, and nothing here reads either.
 *
 * **Three kinds of registration, each published as a set of lists.** There is
 * no single register. Each kind has an index page naming its lists:
 *
 *   building        /building/list-project        (index)
 *                   /registered-building/tn       online, one year a page
 *                   /building/offline/<year>      offline, 2017 onward
 *   layout          /layout/list-project          (index)
 *                   /registered-layout/tn         online, one year a page
 *                   /layout/offline/<year>        offline, 2017 onward
 *   regularisation  /regularisation/list-project  (index)
 *                   /registered_reglayout         online, every year on one page
 *                   /regularisation/offline/<year>
 *
 * An online list shows the current year on a GET and any other year it
 * offers in its own year menu on a POST carrying the session's CSRF token.
 * The offline years are read off the index rather than assumed: on 29
 * September 2026 the layout index already listed an offline 2026 that the
 * building index did not. Andaman and Nicobar's registrations, which the
 * same authority keeps, are on a list of their own and are not read: a
 * Tamil Nadu phase is never registered there.
 *
 * **Why that union is the whole register.** Between them the lists hold
 * every kind the authority registers (buildings, layouts, regularised
 * layouts), online and offline, every year it publishes, with completed
 * projects kept (8,781 of the rows read on 28 and 29 September 2026 say
 * "Completed") and cancelled ones kept with the cancellation written into
 * the status column. The nightly read takes all of them or none: any list
 * that fails or comes back in a shape we do not know refuses the whole read,
 * because a register missing one kind would block every phase of that kind.
 * That is about thirty requests and 60 MB (a year of layouts alone is 10 MB),
 * sequential, once a night for every tenant.
 *
 * **Numbers come in two spellings, and neither is padded consistently.**
 * `TNRERA/29/BLG/0002/2026` since 2025, `TN/01/Building/001/2019` before.
 * The district is written `1` and `01`, the serial `001`, `0001` and
 * `10001`, so every comparison goes through `registrationKey()`, which drops
 * that padding. The two spellings are different registrations, never one.
 *
 * **The form.** The project search (`POST /project-details` after a GET of
 * the home page for its CSRF token, 52 KB and 188 KB, about 1.5 s each)
 * answers a building or layout number from the years its own menu offers
 * (2024 to 2026 on 29 September 2026), with promoter, dates and status. So a
 * current number costs two requests. The search asks for the number in
 * parts and it cannot be told whether the portal pads a district before
 * matching, and offline registrations of those same years may sit outside
 * it. So a hit is believed and a "No data found" is not: a miss, and every
 * number the search cannot take (a regularised layout, a five-digit serial,
 * an older year), is answered from the lists that hold that kind and year:
 * the kind's index, then its online list for that year and its offline list
 * for that year, where each exists. That is a few seconds for a building (a
 * year of them is 1.2 MB) and about twenty for a layout (10 MB), paid only
 * on a miss or an older number. Absent from every one of them is "not
 * found"; a year no list covers is "could not tell".
 *
 * **What is a revocation.** There is no revocation list. `/withdrawn-projects`
 * lists applications by file number, not registrations. A cancellation, or a
 * replacement, is written into the row's own status: "Registration Cancelled
 * Revised Registration given in Registration No. TNRERA/35/BLG/0085/2026"
 * online, "Revised Registration given in Registration No. ..." or
 * "Registration Revoked" offline. That row's number is revoked (or
 * superseded, which for an advertisement is the same); the new number is a
 * registration of its own. "Registration Cancelled for Block-III" cancels
 * part of a project and is not a revocation of the number.
 *
 * Imports are relative so the nightly job can load this straight from
 * source, outside Next.
 */

import {
  fixtureName,
  htmlText,
  plausible,
  portalDate,
  portalRequest,
  type AuthorityStatus,
  type FormVerdict,
  type NightlyResult,
  type PortalCtx,
  type PortalFailure,
  type PortalProject,
  type PortalResponse,
  type StateAdapter,
} from "./rera-portal.ts";
import { normaliseRegistrationNo, registrationKey } from "./rera-rules.ts";

const STATE = "TN";
const BASE = "https://rera.tn.gov.in";

export type TnKind = "building" | "layout" | "regularisation";

type Category = {
  index: string;
  online: string;
  offline: (year: number) => string;
  /** The offline links on the index, by their path. */
  offlinePath: RegExp;
  /** The search's own name for the kind, where the search takes it. */
  search?: { projectType: string; TN: string; TNRERA: string };
  /**
   * Rows below which this kind's lists are refused, not believed. Measured
   * on 28 and 29 September 2026 from part of each kind's lists only: 598
   * buildings from two of twelve lists, 3,550 layouts from two of thirteen,
   * 9,774 regularised layouts from two of three.
   */
  floor: number;
};

export const TN_CATEGORIES: Record<TnKind, Category> = {
  building: {
    index: `${BASE}/building/list-project`,
    online: `${BASE}/registered-building/tn`,
    offline: (y) => `${BASE}/building/offline/${y}`,
    offlinePath: /\/building\/offline\/(\d{4})\b/g,
    search: { projectType: "building", TN: "Building", TNRERA: "BLG" },
    floor: 250,
  },
  layout: {
    index: `${BASE}/layout/list-project`,
    online: `${BASE}/registered-layout/tn`,
    offline: (y) => `${BASE}/layout/offline/${y}`,
    offlinePath: /\/layout\/offline\/(\d{4})\b/g,
    search: { projectType: "layout", TN: "Layout", TNRERA: "LO" },
    floor: 1_000,
  },
  regularisation: {
    index: `${BASE}/regularisation/list-project`,
    online: `${BASE}/registered_reglayout`,
    offline: (y) => `${BASE}/regularisation/offline/${y}`,
    offlinePath: /\/regularisation\/offline\/(\d{4})\b/g,
    floor: 2_000,
  },
};

const KINDS: TnKind[] = ["building", "layout", "regularisation"];

/** Fixture names, one per request, under the dev seam. */
export const TN_FIXTURES = {
  home: fixtureName("home.html"),
  search: (spelling: string) => fixtureName("search", `${spelling}.html`),
  index: (kind: TnKind) => fixtureName(`${kind}_index.html`),
  online: (kind: TnKind) => fixtureName(`${kind}_online.html`),
  onlineYear: (kind: TnKind, year: number) => fixtureName(`${kind}_online_${year}.html`),
  offline: (kind: TnKind, year: number) => fixtureName(`${kind}_offline_${year}.html`),
};

const keyOf = (no: string): string => registrationKey(STATE, no);

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const KIND_WORDS: Record<string, TnKind> = {
  BUILDING: "building",
  BLG: "building",
  LAYOUT: "layout",
  LO: "layout",
  "REGULARISATION-LAYOUT": "regularisation",
  REGULARISATIONLAYOUT: "regularisation",
  REGLO: "regularisation",
};

export type TnNumber = {
  prefix: "TN" | "TNRERA";
  district: string;
  kind: TnKind;
  serial: string;
  year: number;
};

/** A number as the authority writes it, in either spelling. */
const NUMBER_IN_TEXT = /\b(TNRERA|TN)\s*\/\s*(\d{1,2})\s*\/\s*([A-Za-z]+(?:-[A-Za-z]+)?)\s*\/\s*(\d{1,5})\s*\/\s*(\d{4})\b/i;

export function parseTnNumber(raw: string): TnNumber | null {
  const v = normaliseRegistrationNo(STATE, raw);
  const m = v.match(/^(TNRERA|TN)\/(\d{1,2})\/([A-Z]+(?:-[A-Z]+)?)\/(\d{1,5})\/(\d{4})$/);
  if (!m) return null;
  const kind = KIND_WORDS[m[3]];
  if (!kind) return null;
  return { prefix: m[1] as "TN" | "TNRERA", district: m[2], kind, serial: m[4], year: Number(m[5]) };
}

// ---------------------------------------------------------------------------
// Reading a list
// ---------------------------------------------------------------------------

/**
 * The authority's word for where a row stands, from its status column.
 *
 * Only a whole registration cancelled, revoked, withdrawn or suspended is a
 * finding, and a registration the authority replaced with another number:
 * the offline lists blank such a row and leave only "Revised Registration
 * given in Registration No. TN/29/Building/0203/2019" (19 of 2019's 253
 * buildings), the online ones write "Registration Cancelled" before the same
 * words. The old number is superseded, so it is REVOKED here; the new number
 * is a registration of its own. The new row's "This Registration revises the
 * earlier Registration ..." is not about itself and is a registration.
 * "Registration Cancelled for Block-III" names the part it applies to, and a
 * row that says the registration was restored is not definite. Everything
 * else ("Completed", a change of bank, a revised carpet area, a progress
 * report) is a registration.
 */
export function tnStatus(raw: string): AuthorityStatus {
  const s = raw.replace(/\s+/g, " ");
  if (/\b(restor|reviv|reinstat|set aside|stayed)/i.test(s)) return "REGISTERED";
  if (/^\W*Revised\s+Registration\s+(?:is\s+)?given\s+in\s+Registration\s+No/i.test(s)) return "REVOKED";
  const m = s.match(/\bRegistration\s+(cancelled|revoked|withdrawn|suspended|lapsed)\b(?!\s+(?:for|in respect of)\b)/i);
  if (!m) return "REGISTERED";
  const word = m[1].toLowerCase();
  if (word === "withdrawn") return "WITHDRAWN";
  if (word === "suspended") return "SUSPENDED";
  if (word === "lapsed") return "LAPSED";
  return "REVOKED";
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Every date in a cell, as YYYY-MM-DD. Day first as every Indian portal
 * writes it (30.06.2027, 30/06/2027), and a bare month and year ("December
 * 2022", which is how the offline lists write most completion dates) as the
 * last day of that month.
 */
export function tnDates(text: string): string[] {
  const out: string[] = [];
  const take = (m: string): string => {
    const d = portalDate(m);
    if (d) out.push(d);
    return d ? " " : m;
  };
  // 30.06.2027, 30/06/2027, 30-06-2027, then 30 June 2027. Each is taken
  // out once read, so its month is not read a second time below.
  const rest = text
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{4}\b/g, take)
    .replace(/\b\d{1,2}[\s-]+[A-Za-z]{3,9}\.?[\s,-]+\d{4}\b/g, take);
  for (const m of rest.matchAll(/\b([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    // The word has to be a month or the start of one: "Sept", "Dec".
    const word = m[1].toLowerCase();
    const month = MONTH_NAMES.findIndex((name) => name.startsWith(word));
    const y = Number(m[2]);
    if (month < 0 || y < 2000 || y > 2100) continue;
    out.push(new Date(Date.UTC(y, month + 1, 0)).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The latest completion date a row shows: its completion column (with every
 * extension the offline lists write after the original date) and any revised
 * date or extension written into its status. A reference's "dated ..." and a
 * progress report's month are not completion dates and are taken out first.
 */
export function tnValidTo(completion: string, status: string): string | undefined {
  const dates = tnDates(completion);
  const s = status
    .replace(/\bdated\s*:?\s*\d{1,2}[./-]\d{1,2}[./-]\d{4}/gi, " ")
    .replace(/Progress of Work as on\s+[A-Za-z]+\.?,?\s+\d{4}/gi, " ");
  const at = s.search(/Revised Project Completion Date|Extension given|Valid\s*up\s*to/i);
  if (at >= 0) dates.push(...tnDates(s.slice(at)));
  return dates.length ? dates.sort().at(-1) : undefined;
}

/**
 * The promoter's name, where the cell makes it certain.
 *
 * The cell is the promoter's name and address together, and often more: a
 * signatory ("rep by its Director ..."), a land owner, a list of partners.
 * A name is read only where the cell leads with a company or an LLP, whose
 * legal form ends it: "M/s. HANSA ESTATES PRIVATE LIMITED, Door No.19, ...".
 * A firm, a person or a joint list is left without one: a numbered list
 * ("1) M/s. ..."), a second "M/s." or a person's title inside the name, or
 * two legal forms ("X Pvt Ltd & Y Pvt Ltd"). A wrong name here refuses a
 * lawful registration as somebody else's; a missing one only skips that
 * check. On 28 and 29 September 2026 this read a name for more than half of
 * the buildings and few of the layouts, most of which people own.
 */
export function tnPromoter(cell: string): string | undefined {
  const lead = cell.split(",")[0] ?? "";
  if (/^\s*(?:\d{1,2}|[ivx]{1,4}|[a-e])\s*[.)]/i.test(lead)) return undefined;
  const name = lead
    // The signatory or the owner's role, where the name runs into it.
    .split(/\s+rep(?:resented)?\.?\s+by\b|\s*\((?:owner|developer|promoter|land\s*owner|gpa)/i)[0]
    // "M/s." is a courtesy, not part of anybody's legal name.
    .replace(/^\s*(?:m\s*\/\s*s\b|messrs\b|ms\b)\.?\s*/i, "")
    .replace(/[\s.]+$/, "")
    .trim();
  if (!/\b(?:LLP|LIMITED|LTD)$/i.test(name)) return undefined;
  if (/m\s*\/\s*s\b|\b(?:thiru|tmt|selvi|mr|mrs|smt|dr)\b\.?\s|\bG\.?P\.?O?\.?A\b/i.test(name)) return undefined;
  // A person by initial and name, then the company: "K.Thirumoorthy and ...".
  if (/^(?:[A-Z]\.\s*){1,3}[A-Za-z]+\s+(?:and|&)\s/i.test(name)) return undefined;
  if ((name.match(/(?:LLP|LIMITED|LTD)\b/gi) ?? []).length > 1) return undefined;
  return name;
}

/**
 * The project's name, where the cell names it: "Project Name: K.L.HOMES<br>
 * ..." online, 'Project Name: "Nexterra" - Construction of ...' offline.
 */
export function tnProjectName(cellHtml: string): string | undefined {
  const at = cellHtml.search(/Project\s+Name\s*:/i);
  if (at < 0) return undefined;
  const rest = cellHtml.slice(at).replace(/^Project\s+Name\s*:\s*/i, "");
  const quoted = htmlText(rest).match(/^[“"]([^”"]+)[”"]/);
  if (quoted) return quoted[1].trim() || undefined;
  const line = htmlText(rest.split(/<br\s*\/?>/i)[0] ?? "");
  return line && line.length <= 120 ? line : undefined;
}

export type TnList = {
  rows: PortalProject[];
  /** The years the page's own year menu offers, where it has one. */
  years: number[];
  /**
   * Rows whose cells did not line up with the header, read for their number
   * and status alone. For the report.
   */
  irregular: number;
  /** Data rows with no registration number in them, for the report. */
  unreadable: number;
};

/**
 * One row's cells as the browser would show them. The offline lists comment
 * out the cells of a superseded row, sometimes with a comment that never
 * closes inside the row (2019's row 96), so comments are taken out row by
 * row, and an unclosed one ends the row.
 */
function cellsOf(tr: string): string[] {
  let s = tr.replace(/<!--[\s\S]*?-->/g, "");
  const open = s.indexOf("<!--");
  if (open >= 0) s = s.slice(0, open);
  return s.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) ?? [];
}

/**
 * One list page, or the search's result, which shares its table.
 *
 * The table is the one whose header names a registration number column, and
 * each column is found by its header ("Promoter", "Project Details",
 * "Completion", "Status"), because the lists and the search label and order
 * them differently. A row whose cells do not line up with the header still
 * gives its number (from that column, or else wherever a number is written
 * first) and its status, because a number missing from the register would
 * block a lawful phase. Null when no table on the page has that header: a
 * page we do not recognise, never an empty list.
 */
export function parseTnList(html: string): TnList | null {
  const menu = html.match(/<select\b[^>]*\bname="year"[^>]*>([\s\S]*?)<\/select>/i);
  const years = menu ? [...menu[1].matchAll(/<option\b[^>]*\bvalue="(\d{4})"/gi)].map((m) => Number(m[1])) : [];

  for (const table of html.match(/<table\b[\s\S]*?<\/table>/gi) ?? []) {
    const head = table.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?<th\b[\s\S]*?<\/tr>/i)?.[0];
    if (!head) continue;
    const labels = (head.match(/<th\b[^>]*>[\s\S]*?<\/th>/gi) ?? []).map(htmlText);
    const col = (re: RegExp) => labels.findIndex((l) => re.test(l));
    const iNo = col(/Registration\s+No/i);
    if (iNo < 0) continue;
    const iPromoter = col(/Promoter/i);
    const iProject = col(/Project\s+Details/i);
    const iCompletion = col(/Completion/i);
    const iStatus = col(/Status/i);

    const rows: PortalProject[] = [];
    let irregular = 0;
    let unreadable = 0;
    const body = table.slice(table.indexOf(head) + head.length);
    for (const tr of body.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = cellsOf(tr);
      if (!cells.length) continue;
      const text = cells.map(htmlText);
      const lined = cells.length === labels.length;
      const numberCell = (text[iNo] ?? "").match(NUMBER_IN_TEXT) ? text[iNo] : text.find((t) => NUMBER_IN_TEXT.test(t)) ?? "";
      const m = numberCell.match(NUMBER_IN_TEXT);
      if (!m) {
        unreadable++;
        continue;
      }
      // As the authority prints it, spaces aside; the key does the rest.
      const registrationNo = m[0].replace(/\s+/g, "");
      const after = numberCell.slice((m.index ?? 0) + m[0].length);
      const dated = after.match(/^\s*,?\s*dated\s*:?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i);
      const registeredOn = dated ? portalDate(dated[1]) ?? undefined : undefined;
      if (!lined) {
        // Read for what the register needs and no more: the rest of its
        // cells cannot be told apart.
        irregular++;
        const said = text.slice(text.indexOf(numberCell) + 1).map(tnStatus).find((s) => s !== "REGISTERED");
        rows.push({ registrationNo, status: said ?? "REGISTERED", registeredOn });
        continue;
      }
      const status = iStatus >= 0 ? text[iStatus] : "";
      const ref = tr.match(/\/public-view2\/[a-z-]+\/[a-z-]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      rows.push({
        registrationNo,
        projectName: iProject >= 0 ? tnProjectName(cells[iProject]) : undefined,
        promoterName: iPromoter >= 0 ? tnPromoter(text[iPromoter]) : undefined,
        status: tnStatus(status),
        validTo: tnValidTo(iCompletion >= 0 ? text[iCompletion] : "", status),
        registeredOn,
        portalRef: ref ? ref[1] : undefined,
      });
    }
    return { rows, years, irregular, unreadable };
  }
  return null;
}

/** The offline years an index page lists. Null when it lists none. */
export function tnOfflineYears(html: string, kind: TnKind): number[] | null {
  const re = new RegExp(TN_CATEGORIES[kind].offlinePath.source, "g");
  const years = [...new Set([...html.matchAll(re)].map((m) => Number(m[1])))].sort();
  return years.length ? years : null;
}

/** The session's CSRF token, from the form or the page's meta tag. */
export function tnToken(html: string): string | null {
  return (
    html.match(/<input\b[^>]*\bname="_token"[^>]*\bvalue="([^"]+)"/i)?.[1] ??
    html.match(/<meta\b[^>]*\bname="csrf-token"[^>]*\bcontent="([^"]+)"/i)?.[1] ??
    null
  );
}

/** A registration's year, the last part of its number. */
function yearOf(p: PortalProject): number {
  return Number(p.registrationNo.split("/").at(-1));
}

/**
 * A page asked for one year is that year's list: empty, or nearly every row
 * registered that year. A portal that ignored the year and served its
 * default fails this, rather than being read as the year asked for.
 */
export function tnListIsYear(list: TnList, year: number): boolean {
  if (!list.rows.length) return true;
  return list.rows.filter((r) => yearOf(r) === year).length / list.rows.length >= 0.9;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Session = { cookie: string; token: string };

function sessionOf(res: PortalResponse): Session | null {
  const token = tnToken(res.text);
  return token ? { cookie: res.cookies.join("; "), token } : null;
}

function post(session: Session, fields: Record<string, string>): { method: "POST"; body: URLSearchParams; headers: Record<string, string> } {
  return {
    method: "POST",
    body: new URLSearchParams({ _token: session.token, ...fields }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(session.cookie ? { cookie: session.cookie } : {}),
    },
  };
}

type Got = { ok: true; res: PortalResponse } | PortalFailure;

async function get(name: string, url: string, ctx: PortalCtx, extra: object = {}): Promise<Got> {
  const res = await portalRequest(STATE, { name, url, timeoutMs: 120_000, ...extra }, ctx);
  if (!res.ok) return res;
  if (res.status !== 200) return { ok: false, reason: `${new URL(url).pathname} answered ${res.status}` };
  return { ok: true, res };
}

type KindRead = { ok: true; rows: PortalProject[]; requests: number; fixture: boolean } | { ok: false; reason: string };

/** Every list of one kind: the index, the online years, the offline years. */
async function readKind(kind: TnKind, ctx: PortalCtx): Promise<KindRead> {
  const cat = TN_CATEGORIES[kind];
  let requests = 0;
  let fixture = false;
  const rows: PortalProject[] = [];

  const idx = await get(TN_FIXTURES.index(kind), cat.index, ctx);
  requests++;
  if (!idx.ok) return idx;
  fixture ||= idx.res.fixture;
  const offlineYears = tnOfflineYears(idx.res.text, kind);
  if (!offlineYears) return { ok: false, reason: `${kind} index lists no offline years. Its shape has probably changed.` };

  const online = await get(TN_FIXTURES.online(kind), cat.online, ctx);
  requests++;
  if (!online.ok) return online;
  fixture ||= online.res.fixture;
  const first = parseTnList(online.res.text);
  if (!first) return { ok: false, reason: `${kind} online list carried no table we recognise.` };
  rows.push(...first.rows);

  // The GET shows one year of the menu. Which one is read off its rows, so
  // the other years are asked for by POST and none twice.
  if (first.years.length) {
    const shown = first.rows.length ? first.years.find((y) => tnListIsYear(first, y)) : undefined;
    const session = sessionOf(online.res);
    if (!session && first.years.some((y) => y !== shown)) {
      return { ok: false, reason: `${kind} online list carried no CSRF token to ask for other years with.` };
    }
    for (const y of first.years) {
      if (y === shown || !session) continue;
      const res = await get(TN_FIXTURES.onlineYear(kind, y), cat.online, ctx, post(session, { year: String(y) }));
      requests++;
      if (!res.ok) return res;
      fixture ||= res.res.fixture;
      const list = parseTnList(res.res.text);
      if (!list) return { ok: false, reason: `${kind} online list for ${y} carried no table we recognise.` };
      if (!tnListIsYear(list, y)) return { ok: false, reason: `${kind} online list answered ${y} with another year's rows.` };
      rows.push(...list.rows);
    }
  }

  for (const y of offlineYears) {
    const res = await get(TN_FIXTURES.offline(kind, y), cat.offline(y), ctx);
    requests++;
    if (!res.ok) return res;
    fixture ||= res.res.fixture;
    const list = parseTnList(res.res.text);
    if (!list) return { ok: false, reason: `${kind} offline list for ${y} carried no table we recognise.` };
    rows.push(...list.rows);
  }

  if (!plausible(rows.length, cat.floor, fixture)) {
    return {
      ok: false,
      reason: `Tamil Nadu's ${kind} lists parsed to ${rows.length} registrations. A page has probably changed shape, and believing it would block every ${kind} registration it lost.`,
    };
  }
  return { ok: true, rows, requests, fixture };
}

/** Every list of every kind, read once. The raw read: the seam holds the day's copy. */
async function readAll(ctx: PortalCtx): Promise<NightlyResult> {
  const register = new Map<string, PortalProject>();
  const blocked = new Map<string, PortalProject>();
  let requests = 0;
  for (const kind of KINDS) {
    const read = await readKind(kind, ctx);
    if (!read.ok) return { ok: false, reason: read.reason };
    requests += read.requests;
    for (const p of read.rows) {
      const k = keyOf(p.registrationNo);
      const held = register.get(k);
      // A number on two lists keeps the stronger statement.
      if (!held || (held.status === "REGISTERED" && p.status !== "REGISTERED")) register.set(k, p);
      if (p.status !== "REGISTERED") blocked.set(k, p);
    }
  }
  return { ok: true, read: { register, blocked, requests } };
}

// ---------------------------------------------------------------------------
// At the form
// ---------------------------------------------------------------------------

type SearchAnswer =
  | { kind: "found"; project: PortalProject }
  /**
   * The search did not have it, or cannot take it: the lists decide.
   * `onlineYears` is the search's year menu, which is the online lists' too.
   */
  | { kind: "ask-lists"; onlineYears: number[] | null }
  | { kind: "failed"; reason: string };

/** How the search is asked for a number, and so how its fixture is named. */
export function tnSearchFields(n: TnNumber): Record<string, string> | null {
  const s = TN_CATEGORIES[n.kind].search;
  // The search's box takes four digits, so a five-digit serial is not its.
  if (!s || n.serial.length > 4) return null;
  return {
    projectType: s.projectType,
    searchBy: "applicationNo",
    state: n.prefix,
    // As the authority prints it: TNRERA numbers unpadded, TN ones as given.
    code: n.prefix === "TNRERA" ? String(Number(n.district)) : n.district,
    project_type: s[n.prefix],
    running_no: n.serial.padStart(4, "0"),
    year: String(n.year),
  };
}

function searchSpelling(f: Record<string, string>): string {
  return `${f.state}/${f.code}/${f.project_type}/${f.running_no}/${f.year}`;
}

/**
 * The project search, for a building or a layout. Its page is read even for
 * a number the search cannot take, because its year menu says which years
 * have an online list at all.
 */
async function searchOnline(n: TnNumber, want: string, ctx: PortalCtx): Promise<SearchAnswer> {
  if (!TN_CATEGORIES[n.kind].search) return { kind: "ask-lists", onlineYears: null };

  const home = await get(TN_FIXTURES.home, `${BASE}/`, ctx, { timeoutMs: 30_000 });
  if (!home.ok) return { kind: "failed", reason: home.reason };
  const session = sessionOf(home.res);
  const form = home.res.text.match(/<form\b[^>]*action="[^"]*\/project-details"[\s\S]*?<\/form>/i)?.[0];
  const menu = form?.match(/<select\b[^>]*\bname="year"[^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? "";
  const offered = [...menu.matchAll(/value="(\d{4})"/g)].map((m) => Number(m[1]));
  if (!session || !form || !offered.length) {
    return { kind: "failed", reason: "The search page carried no form we recognise." };
  }
  const fields = tnSearchFields(n);
  // Not a number or a year the search covers: its silence would mean nothing.
  if (!fields || !offered.includes(n.year)) return { kind: "ask-lists", onlineYears: offered };

  const res = await get(TN_FIXTURES.search(searchSpelling(fields)), `${BASE}/project-details`, ctx, {
    ...post(session, fields),
    timeoutMs: 30_000,
  });
  if (!res.ok) return { kind: "failed", reason: res.reason };

  const list = parseTnList(res.res.text);
  if (list) {
    const hit = list.rows.find((r) => keyOf(r.registrationNo) === want);
    return hit ? { kind: "found", project: hit } : { kind: "ask-lists", onlineYears: offered };
  }
  if (/No data found/i.test(res.res.text)) return { kind: "ask-lists", onlineYears: offered };
  return {
    kind: "failed",
    reason: "The search returned a page with neither a result nor a no-match notice. Its shape has probably changed.",
  };
}

/**
 * The lists that hold this number's kind and year: the online list for that
 * year, and the offline list where the index names one. Read in full and
 * compared by key, so the district's and the serial's padding cannot matter.
 *
 * A year before the first one the search's menu offers has no online list
 * (both online lists' menus and the search's offered 2024 to 2026 on 29
 * September 2026), so a 2019 number costs the offline list alone rather than
 * a 10 MB page of this year's layouts. Any later year is asked, and the
 * list's own menu decides.
 */
async function fromLists(n: TnNumber, want: string, onlineYears: number[] | null, ctx: PortalCtx): Promise<FormVerdict> {
  const cat = TN_CATEGORIES[n.kind];
  const idx = await get(TN_FIXTURES.index(n.kind), cat.index, ctx, { timeoutMs: 30_000 });
  if (!idx.ok) return { known: false, reason: idx.reason };
  const offlineYears = tnOfflineYears(idx.res.text, n.kind);
  const session = sessionOf(idx.res);
  if (!offlineYears || !session) return { known: false, reason: `The ${n.kind} index is not a page we recognise.` };

  const read: PortalProject[][] = [];
  if (n.kind === "regularisation") {
    // One page for every year, and no menu.
    const res = await get(TN_FIXTURES.online(n.kind), cat.online, ctx);
    if (!res.ok) return { known: false, reason: res.reason };
    const list = parseTnList(res.res.text);
    if (!list) return { known: false, reason: `The ${n.kind} online list is not a page we recognise.` };
    read.push(list.rows);
  } else if (!onlineYears || n.year >= Math.min(...onlineYears)) {
    const res = await get(TN_FIXTURES.onlineYear(n.kind, n.year), cat.online, ctx, post(session, { year: String(n.year) }));
    if (!res.ok) return { known: false, reason: res.reason };
    const list = parseTnList(res.res.text);
    if (!list) return { known: false, reason: `The ${n.kind} online list is not a page we recognise.` };
    // A year the menu does not offer has no online list; the portal then
    // shows its default year, which says nothing about this number.
    if (list.years.includes(n.year)) {
      if (!tnListIsYear(list, n.year)) {
        return { known: false, reason: `The ${n.kind} online list answered ${n.year} with another year's rows.` };
      }
      read.push(list.rows);
    }
  }
  if (offlineYears.includes(n.year)) {
    const res = await get(TN_FIXTURES.offline(n.kind, n.year), cat.offline(n.year), ctx);
    if (!res.ok) return { known: false, reason: res.reason };
    const list = parseTnList(res.res.text);
    if (!list) return { known: false, reason: `The ${n.kind} offline list for ${n.year} is not a page we recognise.` };
    read.push(list.rows);
  }
  if (!read.length) {
    return { known: false, reason: `TNRERA publishes no ${n.kind} list for ${n.year}, so nothing could be checked.` };
  }
  for (const rows of read) {
    const hit = rows.find((r) => keyOf(r.registrationNo) === want);
    if (hit) return { known: true, found: true, project: hit };
  }
  return { known: true, found: false };
}

export const tnAdapter: StateAdapter = {
  state: STATE,
  keyOf,
  async atForm(no, ctx): Promise<FormVerdict> {
    const n = parseTnNumber(no);
    if (!n) {
      return {
        known: false,
        reason: "Not shaped like a Tamil Nadu number (TNRERA/29/BLG/0002/2026 or TN/01/Building/001/2019); the portal was not asked.",
      };
    }
    const want = keyOf(no);
    const s = await searchOnline(n, want, ctx);
    if (s.kind === "found") return { known: true, found: true, project: s.project };
    // The portal did not answer: asking it three more times will not help.
    if (s.kind === "failed") return { known: false, reason: s.reason };
    return fromLists(n, want, s.onlineYears, ctx);
  },
  nightly: (ctx) => readAll(ctx),
};
