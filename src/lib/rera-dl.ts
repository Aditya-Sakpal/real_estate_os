/**
 * Delhi RERA, read in bulk, at the form and at night alike.
 *
 * rera.delhi.gov.in did not answer on 28 September 2026. The working portal
 * is on the vendor's domain, `erera.co.in/reradelhiindex` (the same software
 * serves Punjab), and it publishes the whole register as one page:
 *
 *   GET /reradelhiindex/PublicView/RegisteredProjectDetail              716 KB
 *   GET /reradelhiindex/PublicView/RegisteredProjectExtensionsDetail    142 KB
 *
 * **Why the form reads the register.** Delhi has registered 131 projects
 * since 2018. The whole register is one page, under a second, so the form
 * answers from the day's shared copy and a per-number search would buy
 * nothing. The detail page behind each row (`ProjectViewDetails`) prints the
 * promoter's directors with their personal email addresses; it is never
 * asked for.
 *
 * **Why the register is complete.** It lists every registration from
 * DLRERA2018P0001 on, every type the authority registers (residential,
 * commercial, mixed, group housing), and projects whose validity ran out
 * years ago, so a completed or lapsed project is not dropped from it. Four
 * serials were absent on 28 September 2026 (2021P0003, 2026P0003, 2026P0005
 * and 2026P0006): not issued, not yet published, or removed. Absence from it
 * is the finding "not on the authority's register", which is what it is.
 *
 * **Validity is the later of two lists.** The register's "Registration Valid
 * Upto Date" does not follow the extensions list: on 28 September 2026 it
 * showed DLRERA2018P0016 valid to 13 February 2026 while the extensions list
 * had extended it to 11 February 2028, and other rows the other way round.
 * So `validTo` is the latest date either list shows for the number.
 *
 * **Nothing is ever blocked.** Delhi publishes no revocation, lapse or
 * withdrawal list, and the register has no status column. A validity date in
 * the past is not a lapse (the register ignores extensions), so it is
 * reported and nothing is concluded from it.
 *
 * The Excel export (`ExportProjectListsPViewRecordSearchToExcel`, 21 KB)
 * carries the same rows, but it is binary and lacks the project id, so the
 * page is read instead.
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
  sharedRead,
  type FormVerdict,
  type NightlyResult,
  type PortalCtx,
  type PortalProject,
  type StateAdapter,
} from "./rera-portal.ts";
import { registrationKey } from "./rera-rules.ts";

const STATE = "DL";
const BASE = "https://erera.co.in/reradelhiindex/PublicView";

/** Each read, with the fixture file it is answered from under the dev seam. */
export const DL_SOURCES = {
  register: { name: fixtureName("RegisteredProjectDetail.html"), url: `${BASE}/RegisteredProjectDetail` },
  extensions: {
    name: fixtureName("RegisteredProjectExtensionsDetail.html"),
    url: `${BASE}/RegisteredProjectExtensionsDetail`,
  },
} as const;

/** 131 rows on 28 September 2026, and the register only grows. */
export const DL_REGISTER_FLOOR = 30;

/** 12 rows on 28 September 2026: extensions granted are history, and stay. */
export const DL_EXTENSIONS_FLOOR = 3;

const keyOf = (no: string): string => registrationKey(STATE, no);

type Cell = { text: string; raw: string };

/** Every table on the page, as rows of cells, each with its markup kept. */
function tablesOf(html: string): Cell[][][] {
  return (html.match(/<table[\s\S]*?<\/table>/gi) ?? []).map((table) =>
    (table.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []).map((row) =>
      (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map((raw) => ({ text: htmlText(raw), raw })),
    ),
  );
}

type Located = { rows: Cell[][]; head: Cell[]; col: (re: RegExp) => number };

/**
 * The first table whose header row carries every label asked for. Columns
 * are then found by label, so a column added or moved is read correctly.
 */
function findTable(html: string, labels: RegExp[]): Located | null {
  for (const rows of tablesOf(html)) {
    const head = rows.find((r) => labels.every((re) => r.some((c) => re.test(c.text))));
    if (!head) continue;
    return { rows, head, col: (re) => head.findIndex((c) => re.test(c.text)) };
  }
  return null;
}

/** The number in a row: the cell's text, or its `data-diary-no`. */
function numberIn(cell: Cell | undefined): string {
  if (!cell) return "";
  const text = cell.text.replace(/\s+/g, "");
  if (text) return text;
  return cell.raw.match(/data-diary-no="([^"]*)"/i)?.[1]?.trim() ?? "";
}

/**
 * The promoter as the register writes it, less the category it appends:
 * "Summit Promoters Private Limited (Other than Individual)". The portal's
 * placeholder for a promoter it does not know is not a name.
 */
export function dlPromoter(raw: string): string | undefined {
  const name = raw.replace(/\s*\((?:Other than Individual|Individual)\)\s*$/i, "").trim();
  if (!name || /^unknown promoter$/i.test(name)) return undefined;
  return name;
}

/** The later of two YYYY-MM-DD dates, either of which may be missing. */
function later(a: string | undefined, b: string | null | undefined): string | undefined {
  if (!b) return a;
  if (!a) return b;
  return b > a ? b : a;
}

/**
 * The register.
 *
 *   SNo | District Name | Project's Name | Promoter's Name |
 *   Registration Number | Registration Valid Upto Date | Type of Project |
 *   View Details
 *
 * The project's cell carries the portal's own id in a hidden input
 * (`hdnProjectID`), kept as `portalRef`. Null when no table on the page has
 * this header, which the caller reports as "could not tell".
 */
export function parseDlRegister(html: string): PortalProject[] | null {
  const t = findTable(html, [/^Registration Number$/i, /Promoter/i, /Valid\s*Up\s*to/i]);
  if (!t) return null;
  const iNo = t.col(/^Registration Number$/i);
  const iProject = t.col(/^Project'?s?\s*Name$/i);
  const iPromoter = t.col(/Promoter/i);
  const iValid = t.col(/Valid\s*Up\s*to/i);

  const out: PortalProject[] = [];
  for (const r of t.rows) {
    if (r === t.head || r.length <= iNo) continue;
    const registrationNo = numberIn(r[iNo]);
    if (!registrationNo) continue;
    const project = iProject >= 0 ? r[iProject] : undefined;
    const portalRef = project?.raw.match(/class="hdnProjectID"[^>]*value="(\d+)"/i)?.[1];
    out.push({
      registrationNo,
      projectName: project?.text || undefined,
      promoterName: iPromoter >= 0 ? dlPromoter(r[iPromoter]?.text ?? "") : undefined,
      status: "REGISTERED",
      validTo: (iValid >= 0 && portalDate(r[iValid]?.text)) || undefined,
      portalRef,
    });
  }
  return out;
}

export type DlExtension = {
  registrationNo: string;
  projectName?: string;
  /** The latest date the row shows, the extension or the date before it. */
  validTo?: string;
  portalRef?: string;
};

/**
 * The extensions list.
 *
 *   SNo | District Name | Project Name | Registration Number |
 *   Reg. Valid Upto | Extension of Reg. Valid Upto | View Details
 *
 * The page carries a second, hidden table of quarterly updates with the same
 * numbers; it has no extension column, so the header picks the right one.
 */
export function parseDlExtensions(html: string): DlExtension[] | null {
  const t = findTable(html, [/^Registration Number$/i, /^Extension of/i]);
  if (!t) return null;
  const iNo = t.col(/^Registration Number$/i);
  const iProject = t.col(/^Project'?s?\s*Name$/i);
  const dateCols = t.head.map((c, i) => (/Valid\s*Up\s*to/i.test(c.text) ? i : -1)).filter((i) => i >= 0);

  const out: DlExtension[] = [];
  for (const r of t.rows) {
    if (r === t.head || r.length <= iNo) continue;
    const registrationNo = numberIn(r[iNo]);
    if (!registrationNo) continue;
    let validTo: string | undefined;
    for (const i of dateCols) validTo = later(validTo, portalDate(r[i]?.text));
    const project = iProject >= 0 ? r[iProject] : undefined;
    out.push({
      registrationNo,
      projectName: project?.text || undefined,
      validTo,
      portalRef: project?.raw.match(/class="hdnProjectID"[^>]*value="(\d+)"/i)?.[1],
    });
  }
  return out;
}

/**
 * Both lists, read once. The raw read: the seam holds the day's copy. Both
 * are required: a register read without its extensions would hold dates that
 * are wrong for a day.
 */
async function readAll(ctx: PortalCtx): Promise<NightlyResult> {
  const reg = await portalRequest(STATE, DL_SOURCES.register, ctx);
  if (!reg.ok) return { ok: false, reason: reg.reason };
  if (reg.status !== 200) return { ok: false, reason: `RegisteredProjectDetail answered ${reg.status}` };
  const listed = parseDlRegister(reg.text);

  const ext = await portalRequest(STATE, DL_SOURCES.extensions, ctx);
  if (!ext.ok) return { ok: false, reason: ext.reason };
  if (ext.status !== 200) return { ok: false, reason: `RegisteredProjectExtensionsDetail answered ${ext.status}` };
  const extended = parseDlExtensions(ext.text);

  const fixture = reg.fixture || ext.fixture;
  if (!listed) return { ok: false, reason: "RegisteredProjectDetail carried no register we recognise." };
  if (!plausible(listed.length, DL_REGISTER_FLOOR, fixture)) {
    return {
      ok: false,
      reason: `RegisteredProjectDetail parsed to ${listed.length} projects. The page has probably changed shape, and believing it would block every Delhi registration it lost.`,
    };
  }
  if (!extended) return { ok: false, reason: "RegisteredProjectExtensionsDetail carried no list we recognise." };
  if (!plausible(extended.length, DL_EXTENSIONS_FLOOR, fixture)) {
    return {
      ok: false,
      reason: `RegisteredProjectExtensionsDetail parsed to ${extended.length} rows. The page has probably changed shape.`,
    };
  }

  const register = new Map<string, PortalProject>();
  for (const p of listed) register.set(keyOf(p.registrationNo), p);
  for (const e of extended) {
    const k = keyOf(e.registrationNo);
    const p = register.get(k);
    if (p) {
      register.set(k, { ...p, validTo: later(p.validTo, e.validTo) });
    } else {
      // Extended by the authority, so issued by it, even if the register
      // page has dropped the row.
      register.set(k, {
        registrationNo: e.registrationNo,
        projectName: e.projectName,
        status: "REGISTERED",
        validTo: e.validTo,
        portalRef: e.portalRef,
      });
    }
  }

  return { ok: true, read: { register, blocked: new Map(), requests: 2 } };
}

export const dlAdapter: StateAdapter = {
  state: STATE,
  keyOf,
  async atForm(no, ctx): Promise<FormVerdict> {
    const k = keyOf(no);
    if (!k) return { known: false, reason: "No registration number given." };
    const res = await sharedRead(STATE, () => readAll(ctx), ctx);
    if (!res.ok) return { known: false, reason: res.reason };
    const hit = res.read.register?.get(k);
    return hit ? { known: true, found: true, project: hit } : { known: true, found: false };
  },
  nightly: (ctx) => readAll(ctx),
};
