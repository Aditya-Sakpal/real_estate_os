/**
 * Andhra Pradesh RERA (rera.ap.gov.in): a search at the form, the whole
 * register at night.
 *
 * The portal is ASP.NET WebForms with no CAPTCHA and no login, and its
 * robots.txt allows everything. Two pages answer every question:
 *
 *   GET  /RERA/Views/Reports/ApprovedProjectSearch.aspx     115 KB, 0.6 s
 *   POST the same, with the keyword and the page's own state  118 KB, 0.3 s
 *   GET  /RERA/Views/Reports/ApprovedProjects.aspx          32.5 MB, 16 s
 *
 * **Why the form searches rather than reading the register.** The register
 * is 32.5 MB (14.6 MB of it ViewState) and takes about sixteen seconds,
 * which is too long for a person waiting on a form. The search answers one
 * number in two small requests, and its result carries what the register
 * does not: the promoter's name, and the application number, which is the
 * authority's own id for the project. It carries no completion date, so the
 * form's verdict has none; the sweep's register read has it.
 *
 * The search is a keyword search (project name, registration id, promoter,
 * place), so the result row is found by the registration number we asked
 * about, never by position. A search that matched nothing says so in words
 * ("No Data found on your entered text") and echoes the keyword back in the
 * box; both are required before "not found" is believed. A page with neither
 * a result table nor that notice is "could not tell".
 *
 * **Why the register is complete.** "Approved Projects" lists every
 * registration the authority has issued: residential, commercial and mixed
 * buildings and plotted layouts ("Layout for Plots", 1,889 of 7,131 on 28
 * September 2026), approved from 2018 to the day before. Its Status column is
 * a category ("New Project", "Under Development"), not where a registration
 * stands: projects approved in 2018 with completion dates in 2019 still read
 * "Under Development". Every number on it matches `P` and eleven digits.
 *
 * **No revocation list.** The authority publishes none. Five serials below
 * the highest one issued are missing from the register, which suggests a
 * revoked registration is dropped from it silently. So `blocked` stays empty,
 * and absence from the register is the finding.
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

const STATE = "AP";
const BASE = "https://rera.ap.gov.in/RERA/Views/Reports";

/** Each read, with the fixture file it is answered from under the dev seam. */
export const AP_SOURCES = {
  searchForm: { name: fixtureName("search_form.html"), url: `${BASE}/ApprovedProjectSearch.aspx` },
  search: (no: string) => ({ name: fixtureName("search", `${no}.html`), url: `${BASE}/ApprovedProjectSearch.aspx` }),
  register: { name: fixtureName("approved_projects.html"), url: `${BASE}/ApprovedProjects.aspx` },
} as const;

/**
 * 7,131 registrations on 28 September 2026, and the register only grows. A
 * parse that returns fewer is a changed page, and believing it would block
 * every Andhra Pradesh registration it lost.
 */
export const AP_REGISTER_FLOOR = 1_500;

/** Every number on the register on 28 September 2026 has this shape. */
const AP_NO = /^P[0-9]{11}$/;

/** The grid both pages render, by the id ASP.NET gives it. */
const GRID_ID = "ContentPlaceHolder1_gvApprovedProject";

/** The search's own words for a keyword that matched nothing. */
const NO_MATCH = /No\s+Data\s+found\s+on\s+your\s+entered\s+text/i;

const keyOf = (no: string): string => registrationKey(STATE, no);

/**
 * The authority's word for a row. The register's Status column is a
 * category and the search's reads "APRERA Registered", so everything is a
 * registration unless it says otherwise in words we recognise.
 */
export function apStatus(raw: string): AuthorityStatus {
  const s = raw.toUpperCase();
  if (/REVOK|CANCEL/.test(s)) return "REVOKED";
  if (/WITHDR/.test(s)) return "WITHDRAWN";
  if (/SUSPEN|ABEYANCE/.test(s)) return "SUSPENDED";
  if (/LAPSE/.test(s)) return "LAPSED";
  return "REGISTERED";
}

/**
 * The grid's rows, each as its fields by name.
 *
 * Every cell holds a span (or, for the register's project name, a link)
 * whose id names the field and the row:
 *
 *   <span id="ContentPlaceHolder1_gvApprovedProject_lblRegistrationNo_0">P03280080001</span>
 *   <a ... id="ContentPlaceHolder1_gvApprovedProject_lnkProjectName_0" ...>PANORAMA HILLS</a>
 *
 * So a row is read by field name ("RegistrationNo", "ProjectName",
 * "ExpCompDate"), never by column position: the two pages order and label
 * their columns differently, and either can gain one. Only the grid's own
 * table is read, which on the register skips 15 MB of ViewState.
 */
export function apGridRows(html: string): Record<string, string>[] | null {
  const at = html.indexOf(`id="${GRID_ID}"`);
  if (at < 0) return null;
  const end = html.indexOf("</table>", at);
  const grid = html.slice(at, end < 0 ? undefined : end);
  const rows = new Map<number, Record<string, string>>();
  const field = new RegExp(`<(span|a)\\b[^>]*\\bid="${GRID_ID}_(?:lbl|lnk)([A-Za-z]+)_(\\d+)"[^>]*>([\\s\\S]*?)</\\1>`, "g");
  for (const m of grid.matchAll(field)) {
    const i = Number(m[3]);
    const row = rows.get(i) ?? {};
    row[m[2]] = htmlText(m[4]);
    rows.set(i, row);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}

function projectOf(row: Record<string, string>): PortalProject | null {
  const registrationNo = normaliseRegistrationNo(STATE, row.RegistrationNo ?? "");
  if (!AP_NO.test(registrationNo)) return null;
  return {
    registrationNo,
    projectName: row.ProjectName || undefined,
    // The search carries it; the register does not, and nothing is guessed.
    promoterName: row.Promoter || undefined,
    status: apStatus(row.PrStatus ?? row.ProjectStatus ?? ""),
    validTo: portalDate(row.ExpCompDate) ?? undefined,
    registeredOn: portalDate(row.ApprovalDate) ?? undefined,
    // The application number is the authority's id for the project. Only
    // the search shows it.
    portalRef: row.RegistrationID || undefined,
  };
}

export type ApRegister = {
  projects: PortalProject[];
  /** Grid rows whose number is not the register's shape, for the report. */
  skipped: number;
};

/**
 * The register page. Null when it carries no grid at all, which is a changed
 * page and never an empty register.
 */
export function parseApRegister(html: string): ApRegister | null {
  const rows = apGridRows(html);
  if (!rows) return null;
  const projects: PortalProject[] = [];
  let skipped = 0;
  for (const row of rows) {
    const p = projectOf(row);
    if (p) projects.push(p);
    else skipped++;
  }
  return { projects, skipped };
}

export type ApSearch =
  | { kind: "found"; project: PortalProject }
  | { kind: "absent" }
  | { kind: "unrecognised" };

/**
 * One search result, for one number.
 *
 * Found: a result row carries the number. Absent: the result grid is there
 * without it, or the no-match notice is there and the box still holds the
 * number we asked about (so the page is an answer to our question, not the
 * empty search form served back). Anything else is a page we do not know.
 */
export function parseApSearch(html: string, registrationNo: string): ApSearch {
  const want = keyOf(registrationNo);
  const rows = apGridRows(html);
  if (rows) {
    for (const row of rows) {
      const p = projectOf(row);
      if (p && keyOf(p.registrationNo) === want) return { kind: "found", project: p };
    }
    if (rows.length > 0) return { kind: "absent" };
  }
  const box = html.match(/<input\b[^>]*\bid="ContentPlaceHolder1_txtName"[^>]*>/i)?.[0] ?? "";
  const echoed = keyOf(box.match(/\bvalue="([^"]*)"/i)?.[1] ?? "") === want;
  if (NO_MATCH.test(html) && echoed) return { kind: "absent" };
  return { kind: "unrecognised" };
}

function attr(s: string): string {
  return s
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/gi, "&");
}

/**
 * What the search form posts back: every hidden field of the page's own form
 * (the ViewState and event validation above all, without which ASP.NET
 * ignores the post), then the keyword and the Search button. The login box
 * in the same form is left out, so nothing but a search is ever submitted.
 * Null when the form or its ViewState is not there.
 */
export function apSearchBody(formHtml: string, registrationNo: string): URLSearchParams | null {
  const start = formHtml.search(/<form\b[^>]*action="[^"]*ApprovedProjectSearch\.aspx"/i);
  if (start < 0) return null;
  const end = formHtml.indexOf("</form>", start);
  const form = formHtml.slice(start, end < 0 ? undefined : end);
  const body = new URLSearchParams();
  for (const m of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\btype="hidden"/i.test(tag)) continue;
    const name = tag.match(/\bname="([^"]*)"/i)?.[1];
    // The grid's own per-row fields belong to a result, not to the form.
    if (!name || name.includes("gvApprovedProject")) continue;
    body.set(attr(name), attr(tag.match(/\bvalue="([^"]*)"/i)?.[1] ?? ""));
  }
  if (!body.get("__VIEWSTATE")) return null;
  body.set("ctl00$ContentPlaceHolder1$txtName", registrationNo);
  body.set("ctl00$ContentPlaceHolder1$btnSubmit", "Search");
  return body;
}

async function search(no: string, ctx: PortalCtx): Promise<FormVerdict> {
  const form = await portalRequest(STATE, AP_SOURCES.searchForm, ctx);
  if (!form.ok) return { known: false, reason: form.reason };
  if (form.status !== 200) return { known: false, reason: `the search page answered ${form.status}` };
  const body = apSearchBody(form.text, no);
  if (!body) return { known: false, reason: "The search page carried no form we recognise." };

  const res = await portalRequest(
    STATE,
    {
      ...AP_SOURCES.search(no),
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(form.cookies.length ? { cookie: form.cookies.join("; ") } : {}),
      },
    },
    ctx,
  );
  if (!res.ok) return { known: false, reason: res.reason };
  if (res.status !== 200) return { known: false, reason: `the search answered ${res.status}` };

  const found = parseApSearch(res.text, no);
  if (found.kind === "found") return { known: true, found: true, project: found.project };
  if (found.kind === "absent") return { known: true, found: false };
  return {
    known: false,
    reason: "The search returned a page with neither a result nor a no-match notice. Its shape has probably changed.",
  };
}

/** The register, read once. The raw read: the seam holds the day's copy. */
async function readAll(ctx: PortalCtx): Promise<NightlyResult> {
  // 32.5 MB, about sixteen seconds on 28 September 2026.
  const res = await portalRequest(STATE, { ...AP_SOURCES.register, timeoutMs: 180_000 }, ctx);
  if (!res.ok) return { ok: false, reason: res.reason };
  if (res.status !== 200) return { ok: false, reason: `ApprovedProjects answered ${res.status}` };
  const parsed = parseApRegister(res.text);
  if (!parsed) return { ok: false, reason: "ApprovedProjects carried no project grid we recognise." };
  if (!plausible(parsed.projects.length, AP_REGISTER_FLOOR, res.fixture)) {
    return {
      ok: false,
      reason: `ApprovedProjects parsed to ${parsed.projects.length} registrations. The page has probably changed shape, and believing it would block every Andhra Pradesh registration it lost.`,
    };
  }

  const register = new Map<string, PortalProject>();
  const blocked = new Map<string, PortalProject>();
  for (const p of parsed.projects) {
    const k = keyOf(p.registrationNo);
    register.set(k, p);
    // The register has never said anything but a category here. Should it
    // ever say revoked in words, that is the authority's own statement.
    if (p.status !== "REGISTERED") blocked.set(k, p);
  }
  return { ok: true, read: { register, blocked, requests: 1 } };
}

export const apAdapter: StateAdapter = {
  state: STATE,
  keyOf,
  async atForm(no, ctx): Promise<FormVerdict> {
    const n = normaliseRegistrationNo(STATE, no);
    if (!AP_NO.test(n)) {
      return { known: false, reason: "Andhra Pradesh numbers are P and eleven digits; the portal was not asked." };
    }
    return search(n, ctx);
  },
  nightly: (ctx) => readAll(ctx),
};
