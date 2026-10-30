/**
 * GujRERA, through the JSON its own website is built on.
 *
 * The portal is an Angular application over an open API: no key, no
 * CAPTCHA, no session. So the form asks about one number the way the site's
 * search box does, and the nightly job reads, whole, the list the site's
 * "Project Registered" page renders.
 *
 * **A GujRERA number is not stable. Its serial is.** The authority issues a
 * NEW number when a project is altered or extended, and the old one stops
 * appearing anywhere:
 *
 *   PR/GJ/AHMEDABAD/AHMEDABAD CITY/AUDA/MAA12147/170823          as issued
 *   PR/GJ/AHMEDABAD/AHMADABAD CITY/AUDA/MAA00142/EX1/290918     after an extension
 *
 * 2,898 of the 17,591 numbers on the register on 28 September 2026 carried an
 * EX, and 1,806 an A1M, A1R, A1C or A1P. A client who recorded the number on
 * last year's certificate holds a number the register no longer prints, for
 * a project that is perfectly live. The serial (`MAA00142`) is the same
 * project under every number it has had, and it was unique across all
 * 17,591 rows, so `registrationKey()` compares on it and nothing here needs
 * the district.
 *
 * At the form, three requests, about three seconds with the spacing:
 *
 *   POST /project_reg/public/global-search  {"query": <serial>}   which project, its id
 *   GET  /project_reg/public/alldatabyprojectid/<id>            promoter, approval date
 *   GET  /project_reg/public/getproject-details/<id>            completion date, status,
 *                                                               the revocation order
 *
 * The search is asked for the SERIAL, not the number. It matches text, so an
 * older number (one issued before an extension) matches nothing, while the
 * serial finds the project whatever it is called now. It also ignores
 * `dataSize` and returns every match, so a loose query is thousands of rows:
 * a number with no serial in it is not sent at all.
 *
 * At night, one request: `/dashboard/get-district-wise-projectlist/0/0/all/all/all`,
 * 3.8 MB gzipped, 19 MB of JSON, about 3.5 seconds. It is every project the
 * authority registered since 2017, under its current number: residential,
 * mixed, commercial and plotted, new, ongoing and completed. So it is the
 * register, and absence from it means never issued or taken off. It is NOT a
 * lapse list: 10,468 of its rows are past their end date, which proves
 * nothing, because an extension applied for and not yet granted looks
 * exactly the same.
 *
 * **There is no revocation list.** Nothing GujRERA publishes lists revoked
 * projects in bulk, so `blocked` is empty at night unless a register row
 * ever carries a status that says so (none did). At the form,
 * `getproject-details` carries `projectRevokeDocId`, the id of the
 * revocation order's document, and a project with one set reads as revoked.
 * No revoked project was found to confirm the field against, so only a
 * value that is plainly an id counts.
 *
 * **Personal data.** Register rows carry promoters' emails, mobile numbers,
 * PAN, Aadhaar and addresses; the project pages carry engineers' and
 * architects'. The parsers read named fields and nothing else, so none of it
 * leaves this file.
 *
 * **TLS.** GujRERA's server does not support secure renegotiation (RFC 5746),
 * and Node's OpenSSL 3 refuses such a server by default
 * (`ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED`). A request made with
 * `SSL_OP_LEGACY_SERVER_CONNECT` for this host alone succeeds, so every
 * request here asks `portalRequest()` for `legacyTls`, and nothing else in
 * the product relaxes it.
 *
 * Imports are relative so the nightly job can load this straight from
 * source, outside Next.
 */

import {
  fixtureName,
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

const STATE = "GJ";
const BASE = "https://gujrera.gujarat.gov.in";
const SEARCH_URL = `${BASE}/project_reg/public/global-search`;
const ALLDATA_URL = `${BASE}/project_reg/public/alldatabyprojectid/`;
const DETAILS_URL = `${BASE}/project_reg/public/getproject-details/`;
const REGISTER_URL = `${BASE}/dashboard/get-district-wise-projectlist/0/0/all/all/all`;

/**
 * The register held 17,591 projects on 28 September 2026 and only grows. A
 * parse under this is a changed response, not a shrunken register, and
 * believing it would block every Gujarat registration at once.
 */
export const GJ_REGISTER_FLOOR = 3_000;

/** The file the nightly read is answered from under the dev seam. */
export const GJ_REGISTER_FIXTURE = "projectlist_all.json";

export function gjKey(registrationNo: unknown): string {
  return registrationKey(STATE, registrationNo);
}

/**
 * The project serial inside a number, or null.
 *
 * Two shapes are on the register. 17,219 numbers carry `MAA12147` (a letter
 * for the project type, AA, five digits); 372 issued from 2022 through the
 * municipal corporations carry `MN94AA09994` (a letter, N, a counter, AA,
 * five digits). Both are unique across the register. The letters in front
 * matter: `RAA10091` and `MN191AA10091` are different projects.
 */
export function gjSerial(registrationNo: unknown): string | null {
  const parts = normaliseRegistrationNo(STATE, registrationNo).split("/");
  return parts.find((part) => /^[A-Z]{1,3}\d{0,4}AA\d{4,}$/.test(part)) ?? null;
}

// ---------------------------------------------------------------------------
// Pure readers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function readJson(text: string): Json | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The API writes its status as 200 in one endpoint and "200" in another. */
function succeeded(body: Json): boolean {
  return String(body.status ?? "") === "200";
}

function clean(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s || undefined;
}

function latest(...dates: (string | null | undefined)[]): string | undefined {
  const known = dates.filter((d): d is string => !!d).sort();
  return known.length ? known[known.length - 1] : undefined;
}

/**
 * The authority's own word, where it says one. The register's statuses are
 * New, Ongoing and Completed, all of them registrations; anything else is
 * read by its words and only a definite one is anything but REGISTERED.
 */
export function gjStatus(words: unknown, revokeDoc?: unknown): AuthorityStatus {
  if (revocationOrder(revokeDoc)) return "REVOKED";
  const s = typeof words === "string" ? words : "";
  if (/revok|cancel/i.test(s)) return "REVOKED";
  if (/suspend/i.test(s)) return "SUSPENDED";
  if (/withdraw/i.test(s)) return "WITHDRAWN";
  if (/laps/i.test(s)) return "LAPSED";
  return "REGISTERED";
}

/**
 * Is a revocation order attached? Only when the field is plainly an id: a
 * positive number, or the long random string the portal uses for document
 * UIDs. A zero, an empty string or a stray "null" is not an order.
 */
function revocationOrder(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (typeof v === "string") return /^[A-Za-z0-9]{6,}$/.test(v.trim()) && !/^0+$/.test(v.trim());
  return false;
}

export type GjSearchRow = {
  regNo: string;
  entityId: string;
  projectName?: string;
  /** "12/04/2023 - 30/04/2030": start and completion. */
  period?: string;
};

export type GjParsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * The global search. A result is `{status: 200, data: [...]}`; no match is
 * the same with `data: []`, which is exactly what the site's own search box
 * reads as "No Records Found". Anything else is not an answer.
 *
 * The search covers promoters, agents, architects and the rest as well, so
 * only PROJECT rows are kept, and of each only the number, the id, the name
 * and the dates. Emails and phone numbers in the other rows are never read.
 */
export function parseGjSearch(text: string): GjParsed<GjSearchRow[]> {
  const body = readJson(text);
  if (!body || !succeeded(body) || !Array.isArray(body.data)) {
    return { ok: false, reason: "GujRERA's search answered with something other than a result list." };
  }
  const rows: GjSearchRow[] = [];
  for (const item of body.data) {
    const r = asObject(item);
    if (!r || String(r.entityType ?? "").toUpperCase() !== "PROJECT") continue;
    const regNo = clean(r.regNo);
    const id = r.entityId;
    if (!regNo || (typeof id !== "number" && typeof id !== "string") || String(id).trim() === "") continue;
    rows.push({ regNo, entityId: String(id).trim(), projectName: clean(r.entityName), period: clean(r.pdate) });
  }
  return { ok: true, value: rows };
}

export type GjAllData = {
  projRegNo?: string;
  promoterName?: string;
  projectName?: string;
  approvedOn?: string;
};

/**
 * `alldatabyprojectid`: the certificate's own facts. The same object carries
 * the promoter's email and mobile number, which are not read.
 */
export function parseGjAllData(text: string): GjParsed<GjAllData> {
  const body = readJson(text);
  const data = body && succeeded(body) ? asObject(body.data) : null;
  if (!data) return { ok: false, reason: "GujRERA's project record answered with something other than a project." };
  return {
    ok: true,
    value: {
      projRegNo: clean(data.projRegNo),
      promoterName: clean(data.promoterName),
      projectName: clean(data.projectName),
      approvedOn: portalDate(clean(data.approvedDate)) ?? undefined,
    },
  };
}

export type GjDetails = { validTo?: string; status: AuthorityStatus };

/**
 * `getproject-details`: completion date, status and the revocation order.
 * The completion date here is the current one: an extended project reads
 * its extended date, the same as the register's end date.
 *
 * The object also lists the project's engineers, architects and agents with
 * their emails and addresses; only `projectDetail` is read.
 */
export function parseGjDetails(text: string): GjParsed<GjDetails> {
  const body = readJson(text);
  const detail = body && succeeded(body) ? asObject(asObject(body.data)?.projectDetail) : null;
  if (!detail) return { ok: false, reason: "GujRERA's project details answered with something other than a project." };
  return {
    ok: true,
    value: {
      validTo: latest(portalDate(clean(detail.completionDate)), portalDate(clean(detail.completionDateStr))),
      status: gjStatus(detail.projectStatus, detail.projectRevokeDocId ?? detail.projectRevokeDocUId),
    },
  };
}

/**
 * The register. `{status: "200", data: [...]}` with one row per project
 * under its current number, or null when the response is not that shape.
 *
 * Each row carries the promoter's email, mobile number, PAN, Aadhaar and
 * address; only the number, the names, the dates and the id are read.
 */
export function parseGjRegister(text: string): PortalProject[] | null {
  const body = readJson(text);
  if (!body || !Array.isArray(body.data)) return null;
  const out: PortalProject[] = [];
  for (const item of body.data) {
    const r = asObject(item);
    const registrationNo = r ? clean(r.regNo) : undefined;
    if (!r || !registrationNo) continue;
    const project: PortalProject = {
      registrationNo,
      status: gjStatus(r.project_status),
    };
    const projectName = clean(r.projectName);
    const promoterName = clean(r.promoterName);
    // endDate is the current completion date ("31-December-2019"); extDate
    // is the latest extension's ("2019-01-31 00:00:00.0"). They agree for
    // most extended projects, and where they do not the later one stands.
    const validTo = latest(portalDate(clean(r.endDate)), portalDate(clean(r.extDate)));
    const registeredOn = portalDate(clean(r.approvedOn));
    if (projectName) project.projectName = projectName;
    if (promoterName) project.promoterName = promoterName;
    if (validTo) project.validTo = validTo;
    if (registeredOn) project.registeredOn = registeredOn;
    if (r.projectRegId != null && String(r.projectRegId).trim()) project.portalRef = String(r.projectRegId).trim();
    out.push(project);
  }
  return out;
}

/**
 * Two rows under one key. None on the register did, but if the authority
 * ever lists one serial twice, only what both rows agree on is kept: a
 * promoter taken from the wrong row would refuse a lawful registration as
 * "belongs to another promoter". Registered if either is.
 */
export function mergeListed(a: PortalProject, b: PortalProject): PortalProject {
  const agreed = (x?: string, y?: string) => (x && y && x.toUpperCase() === y.toUpperCase() ? x : undefined);
  const merged: PortalProject = {
    registrationNo: a.registrationNo,
    status: a.status === "REGISTERED" || b.status === "REGISTERED" ? "REGISTERED" : a.status,
  };
  const projectName = agreed(a.projectName, b.projectName);
  const promoterName = agreed(a.promoterName, b.promoterName);
  const validTo = agreed(a.validTo, b.validTo);
  const registeredOn = agreed(a.registeredOn, b.registeredOn);
  const portalRef = agreed(a.portalRef, b.portalRef);
  if (projectName) merged.projectName = projectName;
  if (promoterName) merged.promoterName = promoterName;
  if (validTo) merged.validTo = validTo;
  if (registeredOn) merged.registeredOn = registeredOn;
  if (portalRef) merged.portalRef = portalRef;
  return merged;
}

export function gjByKey(rows: PortalProject[]): Map<string, PortalProject> {
  const out = new Map<string, PortalProject>();
  for (const row of rows) {
    const key = gjKey(row.registrationNo);
    const held = out.get(key);
    out.set(key, held ? mergeListed(held, row) : row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Asking the portal
// ---------------------------------------------------------------------------

async function getJson(name: string, url: string, ctx: PortalCtx) {
  return portalRequest(STATE, { name, url, headers: { accept: "application/json" }, legacyTls: true }, ctx);
}

/** One number, at the form. */
export async function gjAtForm(registrationNo: string, ctx: PortalCtx = {}): Promise<FormVerdict> {
  const no = normaliseRegistrationNo(STATE, registrationNo);
  const key = gjKey(no);
  const serial = gjSerial(no);
  if (!serial) {
    return {
      known: false,
      reason: "That does not read as a GujRERA number: it carries no project serial such as MAA12147, so the portal was not asked.",
    };
  }

  const search = await portalRequest(
    STATE,
    {
      name: fixtureName("global-search", `${serial}.json`),
      url: SEARCH_URL,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: serial, startWith: 0, dataSize: 25 }),
      legacyTls: true,
    },
    ctx,
  );
  if (!search.ok) return { known: false, reason: search.reason };
  if (search.status !== 200) return { known: false, reason: `GujRERA's search answered ${search.status}.` };
  const found = parseGjSearch(search.text);
  if (!found.ok) return { known: false, reason: found.reason };

  const row = found.value.find((r) => gjKey(r.regNo) === key);
  if (!row) {
    // The serial is on the register under a number that does not compare
    // equal to ours. That happens only where the key is the whole number
    // (a serial `registrationKey()` does not recognise) and the project has
    // since been altered or extended. Saying "not found" would refuse a
    // live project, so say what the authority calls it now.
    const renamed = found.value.find((r) => gjSerial(r.regNo) === serial);
    if (renamed) {
      return { known: false, reason: `GujRERA lists this project as ${renamed.regNo} now. Record that number.` };
    }
    return { known: true, found: false };
  }

  const all = await getJson(fixtureName("alldatabyprojectid", `${row.entityId}.json`), `${ALLDATA_URL}${encodeURIComponent(row.entityId)}`, ctx);
  if (!all.ok) return { known: false, reason: all.reason };
  if (all.status !== 200) return { known: false, reason: `GujRERA's project record answered ${all.status}.` };
  const record = parseGjAllData(all.text);
  if (!record.ok) return { known: false, reason: record.reason };
  if (record.value.projRegNo && gjKey(record.value.projRegNo) !== key) {
    return { known: false, reason: "GujRERA's search and its project record disagree about this number." };
  }

  const det = await getJson(fixtureName("getproject-details", `${row.entityId}.json`), `${DETAILS_URL}${encodeURIComponent(row.entityId)}`, ctx);
  if (!det.ok) return { known: false, reason: det.reason };
  if (det.status !== 200) return { known: false, reason: `GujRERA's project details answered ${det.status}.` };
  const details = parseGjDetails(det.text);
  if (!details.ok) return { known: false, reason: details.reason };

  const project: PortalProject = { registrationNo: row.regNo, status: details.value.status, portalRef: row.entityId };
  const projectName = record.value.projectName ?? row.projectName;
  const periodEnd = row.period?.split(/\s+-\s+/)[1];
  const validTo = latest(details.value.validTo, portalDate(periodEnd));
  if (projectName) project.projectName = projectName;
  if (record.value.promoterName) project.promoterName = record.value.promoterName;
  if (validTo) project.validTo = validTo;
  if (record.value.approvedOn) project.registeredOn = record.value.approvedOn;
  return { known: true, found: true, project };
}

/** The whole register, once a night. One request. */
export async function readGjRegister(ctx: PortalCtx = {}): Promise<NightlyResult> {
  const res = await portalRequest(
    STATE,
    { name: GJ_REGISTER_FIXTURE, url: REGISTER_URL, headers: { accept: "application/json" }, timeoutMs: 120_000, legacyTls: true },
    ctx,
  );
  if (!res.ok) return { ok: false, reason: res.reason };
  if (res.status !== 200) return { ok: false, reason: `GujRERA's project list answered ${res.status}.` };
  const rows = parseGjRegister(res.text);
  if (!rows) return { ok: false, reason: "GujRERA's project list is not the shape it was. Nothing was read from it." };
  if (!plausible(rows.length, GJ_REGISTER_FLOOR, res.fixture)) {
    return {
      ok: false,
      reason: `GujRERA's project list parsed to only ${rows.length} projects. Its shape has probably changed, and trusting it would block every Gujarat registration at once.`,
    };
  }
  const register = gjByKey(rows);
  const blocked = new Map<string, PortalProject>();
  for (const [key, project] of register) if (project.status !== "REGISTERED") blocked.set(key, project);
  return { ok: true, read: { register, blocked, requests: 1 } };
}

export const gjAdapter: StateAdapter = {
  state: STATE,
  keyOf: gjKey,
  atForm: (no, ctx) => gjAtForm(no, ctx),
  nightly: (ctx) => readGjRegister(ctx),
};
