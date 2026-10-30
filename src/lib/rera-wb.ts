/**
 * West Bengal RERA (rera.wb.gov.in), read the way the authority publishes it.
 *
 * Plain PHP pages, no login, no CAPTCHA, and slow: about four seconds a page.
 *
 * **At the form, two requests.** The certificate search takes a registration
 * number and answers with the project it belongs to:
 *
 *   POST /search_certificate.php   srchterm=<number>&search=Search Certificate
 *        -> a table of Application No. | Project Name (a link to
 *           project_details.php?procode=<id>) | District | Project Type,
 *           or "No data found!"
 *   GET  /project_details.php?procode=<id>
 *        -> the registration number, the project's status, its completion
 *           date and any extension, and the promoter
 *
 * The result table does not print the registration number, so the details
 * page is what proves the project found is the one asked about. Both eras
 * answer: a WBRERA number (`WBRERA/P/NOR/2025/002592`, from 2023) and one
 * issued under the struck-down West Bengal HIRA (`HIRA/P/HOO/2019/000635`).
 * An application number (`WBRERA/NPR-003432`) is not a registration: should
 * the search ever answer one with a project, that project's page carries a
 * different number, and the answer is "could not tell", never a match.
 *
 * A revoked number and a number never issued both read "No data found!". So
 * a miss at the form is "not found", which is true either way; which kind of
 * miss it was is the nightly read's business.
 *
 * **At night, three requests.** The authority lists every approved project
 * in one page per era, all districts at once:
 *
 *   GET /district_project.php?dcode=0         WBRERA era, 4,873 rows, 1.8 MB
 *   GET /district_project_HIRA.php?dcode=0    HIRA era, 1,285 rows
 *   GET /district_project.php?dcode=0&page=rejected   "Rejected/Revoked
 *                                                       Projects", 16 rows
 *
 * The two approved lists together are the register. On 28 September 2026
 * they held 4,872 of the 4,903 WBRERA serials issued and 1,285 of the 1,288
 * HIRA ones, buildings and plots, ongoing and completed, which is as close to
 * complete as a register gets: the few missing serials are what revocation
 * removes. They carry no promoter and no extension date, so a project read at
 * night has neither.
 *
 * **The rejected list mixes two things and names neither by number.** It is
 * keyed by application number (`WBRERA/NPR-003400`) and holds applications
 * the authority refused alongside registrations it revoked, with nothing per
 * row saying which. A refused application was never a registration, and a
 * revoked one has already left the register, so on its own the list blocks
 * nothing. A row is a finding only when its application number is still on
 * the register against a registration number: then the authority is listing
 * one project as both approved and revoked, and revoked is the later word.
 * None was on 28 September 2026.
 *
 * **Every request is `legacyTls`.** rera.wb.gov.in does not support secure
 * renegotiation (RFC 5746), which OpenSSL 3, and so Node's fetch, refuses:
 * the handshake fails with ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED
 * before a byte of the request is sent, and every answer would be "could not
 * tell". Its certificate verifies; only the renegotiation is old.
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
  type PortalProject,
  type StateAdapter,
} from "./rera-portal.ts";
import { normaliseRegistrationNo, registrationKey } from "./rera-rules.ts";

const STATE = "WB";
const BASE = "https://rera.wb.gov.in";

/** How two spellings of one West Bengal number compare. */
export function wbKey(no: string): string {
  return registrationKey(STATE, no);
}

/** A registration number, either era: `WBRERA/P/NOR/2025/002592`, `HIRA/P/HOO/2019/000635`. */
export const WB_NUMBER = /^(?:WBRERA|HIRA)\/P\/[A-Z]{2,4}\/\d{4}\/\d{3,7}$/;

/**
 * The floor each list must clear. Measured on 28 September 2026: 4,873,
 * 1,285 and 16. Roughly a fifth of each register; the rejected list is
 * short, so a handful, which still refuses an empty parse.
 */
export const WB_FLOORS = { register: 1_000, hira: 250, rejected: 3 } as const;

/** The portal's own wording for a search that matched nothing. */
const NO_MATCH = /No data found/i;

/** Comments out: the details page keeps an older layout inside one. */
function uncomment(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** Rows of `<td>` cells as raw HTML, split on each row's opening tag. */
function bodyRows(html: string): string[][] {
  return html
    .split(/<tr\b[^>]*>/i)
    .slice(1)
    .map((chunk) => [...chunk.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]));
}

/** The table whose header carries every one of these words, and its header. */
function tableWith(html: string, ...must: RegExp[]): { heads: string[]; body: string } | null {
  for (const m of uncomment(html).matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const heads = [...m[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((h) => htmlText(h[1]));
    if (must.every((re) => heads.some((h) => re.test(h)))) return { heads, body: m[0] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The form: the certificate search, then the project's page
// ---------------------------------------------------------------------------

export type WbSearchRow = {
  /** The application number, `WBRERA/NPR-003432` or `NPR-01014`. */
  projectId?: string;
  projectName?: string;
  /** The path the row links to, and the id in it. */
  path: string;
  procode: string;
};

export type WbSearch =
  | { kind: "rows"; rows: WbSearchRow[] }
  | { kind: "none" }
  | { kind: "unreadable" };

/**
 * Read the search's answer. A result is a row linking to a project page; a
 * miss is the portal's own "No data found!". A page with neither is not an
 * answer, and is never read as a miss.
 */
export function parseSearch(html: string): WbSearch {
  const table = tableWith(html, /application no/i, /project name/i);
  const rows: WbSearchRow[] = [];
  if (table) {
    const col = (re: RegExp) => table.heads.findIndex((h) => re.test(h));
    const at = { id: col(/application no/i), name: col(/project name/i) };
    for (const cells of bodyRows(table.body)) {
      const link = cells.join(" ").match(/href=["']?((?:\.\/)?project_details(?:_hira)?\.php)\?procode=(\d+)/i);
      if (!link) continue;
      const text = (i: number) => (i >= 0 && i < cells.length ? htmlText(cells[i]) : "");
      rows.push({
        projectId: text(at.id) || undefined,
        projectName: text(at.name) || undefined,
        path: link[1].replace(/^\.\//, ""),
        procode: link[2],
      });
    }
  }
  if (rows.length) return { kind: "rows", rows };
  if (NO_MATCH.test(uncomment(html))) return { kind: "none" };
  return { kind: "unreadable" };
}

export type WbDetails = {
  registrationNo: string;
  projectId?: string;
  projectName?: string;
  promoterName?: string;
  /** The construction status the page shows, "Not Started", "Ongoing". */
  projectStatus?: string;
  completion?: string;
  extension?: string;
};

/** The value after a label in the page's summary list, up to the next tag. */
function labelled(html: string, label: RegExp): string | undefined {
  const m = html.match(new RegExp(`${label.source}\\s*[:\\-]\\s*(?:<[^>]+>\\s*)*([^<]*)`, "i"));
  const v = m ? htmlText(m[1]) : "";
  return v && !/^(NA|N\/A|-)$/i.test(v) ? v : undefined;
}

/**
 * Read a project's page. The summary list at the top carries the number,
 * the status and the dates; the promoter is the name heading "Personal
 * Information" under Promoter Details, or failing that the first row of
 * the table headed "Promoter Name". Contact details, PAN and addresses on
 * the same page are never read.
 *
 * A page without a registration number is not a project page, and is null.
 */
export function parseDetails(html: string): WbDetails | null {
  const page = uncomment(html);
  // "RERA REGISTRATION NO.", never the bare "Registration No." further down,
  // which is the promoter's company registration.
  const registrationNo = labelled(page, /(?:RERA|HIRA)\s+REGISTRATION\s+NO\.?/);
  if (!registrationNo) return null;

  let promoterName: string | undefined;
  const personal = page.search(/Personal\s+Information/i);
  if (personal >= 0) {
    const span = page.slice(personal, personal + 3000).match(/<span[^>]*class=["'][^"']*text-primary[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    promoterName = span ? htmlText(span[1]) || undefined : undefined;
  }
  if (!promoterName) {
    const t = tableWith(page, /^promoter name$/i);
    if (t) {
      const at = t.heads.findIndex((h) => /^promoter name$/i.test(h));
      const first = bodyRows(t.body).find((cells) => cells.length > at);
      promoterName = first ? htmlText(first[at]) || undefined : undefined;
    }
  }

  // The project's name is the last heading before the summary list.
  const summary = page.search(/<ul[^>]*class=["']outerrera/i);
  const headings = summary >= 0 ? [...page.slice(0, summary).matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)] : [];
  const heading = headings.at(-1);
  return {
    registrationNo,
    projectId: labelled(page, /PROJECT\s+ID/),
    projectName: heading ? htmlText(heading[1]) || undefined : undefined,
    promoterName,
    projectStatus: labelled(page, /PROJECT\s+STATUS/),
    completion: portalDate(labelled(page, /PROJECT\s+COMPLETION\s+DATE/)) ?? undefined,
    extension: portalDate(labelled(page, /EXTENSION\s+COMPLETION\s+DATE/)) ?? undefined,
  };
}

/**
 * The page's status line is a construction status ("Not Started",
 * "Ongoing", "Completed"), which says nothing against the registration.
 * Only a status that names what the authority did to it is anything other
 * than REGISTERED.
 */
export function statusFrom(projectStatus: string | undefined): AuthorityStatus {
  const s = projectStatus ?? "";
  if (/revok|cancel|deregist/i.test(s)) return "REVOKED";
  if (/withdr/i.test(s)) return "WITHDRAWN";
  if (/suspend|abeyance/i.test(s)) return "SUSPENDED";
  if (/lapse/i.test(s)) return "LAPSED";
  return "REGISTERED";
}

/** The later of two YYYY-MM-DD dates. */
function later(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}

/** A search can answer with more than one project; at most this many pages are read. */
const MAX_DETAIL_PAGES = 2;

async function lookup(no: string, ctx: PortalCtx): Promise<FormVerdict> {
  const value = normaliseRegistrationNo(STATE, no);
  const key = wbKey(value);

  const res = await portalRequest(
    STATE,
    {
      name: `${fixtureName("search", value)}.html`,
      url: `${BASE}/search_certificate.php`,
      method: "POST",
      body: new URLSearchParams({ srchterm: value, search: "Search Certificate" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      legacyTls: true,
    },
    ctx,
  );
  if (!res.ok) return { known: false, reason: res.reason };
  if (res.status !== 200) return { known: false, reason: `The certificate search answered ${res.status}.` };

  const found = parseSearch(res.text);
  if (found.kind === "unreadable") {
    return {
      known: false,
      reason: "The certificate search returned a page with neither a result nor a no-match notice. Its shape has probably changed.",
    };
  }
  if (found.kind === "none") return { known: true, found: false };

  for (const row of found.rows.slice(0, MAX_DETAIL_PAGES)) {
    const page = await portalRequest(
      STATE,
      {
        name: `${fixtureName("project_details", row.procode)}.html`,
        url: `${BASE}/${row.path}?procode=${row.procode}`,
        legacyTls: true,
      },
      ctx,
    );
    if (!page.ok) return { known: false, reason: page.reason };
    if (page.status !== 200) return { known: false, reason: `The project page answered ${page.status}.` };

    const d = parseDetails(page.text);
    if (!d) {
      return { known: false, reason: "The project page carried no registration number. Its shape has probably changed." };
    }
    if (wbKey(d.registrationNo) !== key) continue;
    return {
      known: true,
      found: true,
      project: {
        registrationNo: d.registrationNo,
        projectName: d.projectName ?? row.projectName,
        promoterName: d.promoterName,
        status: statusFrom(d.projectStatus),
        validTo: later(d.completion, d.extension),
        portalRef: row.procode,
      },
    };
  }

  // The search answered, and no project it named carries this number. That
  // is a search that matched loosely, not a finding that the number is
  // unregistered.
  return {
    known: false,
    reason: "The certificate search named projects, and none of those read carries this registration number.",
  };
}

// ---------------------------------------------------------------------------
// The nightly read
// ---------------------------------------------------------------------------

export type WbRegisterRow = {
  registrationNo: string;
  /** The application number the portal lists it under. */
  projectId?: string;
  projectName?: string;
  procode?: string;
  completion?: string;
  registeredOn?: string;
};

/**
 * One approved list to rows. Columns by their header's words; the
 * registration number by its shape too, so a column moved upstream cannot
 * put a date where a number should be.
 */
export function parseWbRegister(html: string): WbRegisterRow[] {
  const table = tableWith(html, /^registration no/i, /^project id$/i);
  if (!table) return [];
  const col = (re: RegExp) => table.heads.findIndex((h) => re.test(h));
  const at = {
    no: col(/^registration no/i),
    id: col(/^project id$/i),
    name: col(/^project name$/i),
    completion: col(/completion date/i),
    registered: col(/registration date/i),
  };

  const out: WbRegisterRow[] = [];
  for (const cells of bodyRows(table.body)) {
    const text = (i: number) => (i >= 0 && i < cells.length ? htmlText(cells[i]) : "");
    const registrationNo = normaliseRegistrationNo(STATE, text(at.no));
    if (!WB_NUMBER.test(registrationNo)) continue;
    const link = cells.join(" ").match(/procode=(\d+)/i);
    out.push({
      registrationNo,
      projectId: normaliseRegistrationNo(STATE, text(at.id)) || undefined,
      projectName: text(at.name) || undefined,
      procode: link?.[1],
      completion: portalDate(text(at.completion)) ?? undefined,
      registeredOn: portalDate(text(at.registered)) ?? undefined,
    });
  }
  return out;
}

export type WbRejectedRow = {
  projectId: string;
  projectName?: string;
  /** The "Reject/Revoke Date". */
  on?: string;
};

/** The rejected and revoked list to rows, keyed by application number. */
export function parseWbRejected(html: string): WbRejectedRow[] {
  const table = tableWith(html, /^project id$/i, /reject|revoke/i);
  if (!table) return [];
  const col = (re: RegExp) => table.heads.findIndex((h) => re.test(h));
  const at = { id: col(/^project id$/i), name: col(/^project name$/i), on: col(/reject|revoke/i) };

  const out: WbRejectedRow[] = [];
  for (const cells of bodyRows(table.body)) {
    const text = (i: number) => (i >= 0 && i < cells.length ? htmlText(cells[i]) : "");
    const projectId = normaliseRegistrationNo(STATE, text(at.id));
    if (!/NPR-\d+$/.test(projectId)) continue;
    out.push({ projectId, projectName: text(at.name) || undefined, on: portalDate(text(at.on)) ?? undefined });
  }
  return out;
}

/** The three lists to the seam's read. */
export function buildWbRead(
  register: WbRegisterRow[],
  hira: WbRegisterRow[],
  rejected: WbRejectedRow[],
  requests: number,
): { register: Map<string, PortalProject>; blocked: Map<string, PortalProject>; requests: number } {
  const reg = new Map<string, PortalProject>();
  const byProjectId = new Map<string, string[]>();
  for (const r of [...register, ...hira]) {
    const key = wbKey(r.registrationNo);
    reg.set(key, {
      registrationNo: r.registrationNo,
      projectName: r.projectName,
      status: "REGISTERED",
      validTo: r.completion,
      registeredOn: r.registeredOn,
      portalRef: r.procode,
    });
    if (r.projectId) byProjectId.set(r.projectId, [...(byProjectId.get(r.projectId) ?? []), key]);
  }

  // Only a rejected or revoked row that is still on the register against a
  // registration number is a finding; see the note at the top.
  const blocked = new Map<string, PortalProject>();
  for (const x of rejected) {
    for (const key of byProjectId.get(x.projectId) ?? []) {
      const p = reg.get(key);
      if (p) blocked.set(key, { ...p, status: "REVOKED" });
    }
  }
  for (const [key, p] of blocked) reg.set(key, p);
  return { register: reg, blocked, requests };
}

const LISTS = [
  { part: "register", name: "district_project_dcode0.html", path: "/district_project.php?dcode=0" },
  { part: "hira", name: "district_project_HIRA_dcode0.html", path: "/district_project_HIRA.php?dcode=0" },
  { part: "rejected", name: "district_project_rejected.html", path: "/district_project.php?dcode=0&page=rejected" },
] as const;

export async function readWb(ctx: PortalCtx): Promise<NightlyResult> {
  const pages: Partial<Record<(typeof LISTS)[number]["part"], { text: string; fixture: boolean }>> = {};
  let requests = 0;
  for (const list of LISTS) {
    const res = await portalRequest(
      STATE,
      {
        name: list.name,
        url: `${BASE}${list.path}`,
        timeoutMs: list.part === "rejected" ? 60_000 : 120_000,
        legacyTls: true,
      },
      ctx,
    );
    requests += 1;
    if (!res.ok) return { ok: false, reason: res.reason };
    if (res.status !== 200) return { ok: false, reason: `${list.path} answered ${res.status}` };
    pages[list.part] = { text: res.text, fixture: res.fixture };
  }

  const register = parseWbRegister(pages.register!.text);
  const hira = parseWbRegister(pages.hira!.text);
  const rejected = parseWbRejected(pages.rejected!.text);
  const checks: [string, number, number, boolean, string][] = [
    [LISTS[0].path, register.length, WB_FLOORS.register, pages.register!.fixture, "block every registration at once"],
    [LISTS[1].path, hira.length, WB_FLOORS.hira, pages.hira!.fixture, "block every registration at once"],
    [LISTS[2].path, rejected.length, WB_FLOORS.rejected, pages.rejected!.fixture, "clear every revocation on it"],
  ];
  for (const [path, rows, floor, fixture, harm] of checks) {
    if (!plausible(rows, floor, fixture)) {
      return {
        ok: false,
        reason: `${path} parsed only ${rows} rows. The page shape has probably changed, and believing it would ${harm}.`,
      };
    }
  }
  return { ok: true, read: buildWbRead(register, hira, rejected, requests) };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const wbAdapter: StateAdapter = {
  state: STATE,
  keyOf: wbKey,
  atForm: (no, ctx) => lookup(no, ctx),
  nightly: (ctx) => readWb(ctx),
};
