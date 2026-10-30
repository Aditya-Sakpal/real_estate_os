/**
 * RajRERA, through the API its own website calls.
 *
 * The portal is an Angular application over `reraapi.rajasthan.gov.in`, and
 * one endpoint answers both questions this seam asks:
 *
 *   POST /api/web/Home/GetProjects  {"RegistrationNo": <number>, ...}   one project
 *   POST /api/web/Home/GetProjects  {... every filter empty}            every project
 *
 * The second is the whole register in one call: 5,371 rows, 5.9 MB, about
 * 14 seconds on 28 September 2026, every year from 2017, every type
 * (plotted, group housing, commercial, mixed), and the revoked and
 * suspended ones beside the live ones, each with the authority's own status
 * word. So it is both the register and the revocation list, and one request
 * a night reads both. Asked about a number missing from it (126 serials in
 * the run are), the per-number search answers "Data not found!" too, so the
 * list is as complete as anything the authority publishes.
 *
 * The first is what the form asks: one number, about a kilobyte, about a
 * second. Fourteen seconds is too long for a person waiting.
 *
 * **The API key.** Every request needs an `X-API-KEY` header. Its value is
 * not a secret: the portal's public JavaScript sends it from every visitor's
 * browser, hard-coded in an HTTP interceptor in the main bundle
 * (`"MySuperSecretApiKey_123"` on 28 September 2026). It is still read from
 * the portal at run time rather than written here, so a key the authority
 * changes is picked up the next day instead of silently failing every check:
 * the home page names the main bundle, the bundle holds the key. Those two
 * requests go through `portalRequest()` like any other, and the key is held
 * in memory for a day. The form uses the held key and reads it again once
 * if the API refuses it; the nightly job always reads it fresh, because its
 * process is new every night anyway and a fixed count is what it reports.
 * If the key cannot be found, the answer is "could not tell".
 *
 * **Exemption certificates are in the same list** (`RAJ/RERAExempted
 * Project/2025/058`, 57 of them). An exemption is not a registration, and
 * reading one as registered would let an exempt project's certificate stand
 * in for a registration it never had, so those rows are dropped.
 *
 * **Three numbers were issued twice**, each to two projects of two
 * promoters (RAJ/P/2025/3789, 3931, 4081). Only what both rows agree on is
 * kept, so neither promoter's lawful registration is refused as "belongs to
 * another promoter".
 *
 * **Lapsed.** The site's status filter offers "Lapsed" (`ApplicationStatus`
 * 7), 1,213 rows marked LAPSED on 28 September 2026. Every one is an
 * approved project whose revised completion date has passed: the authority's
 * label on a date, not an order. A finding in `blocked` would override an
 * extension the client recorded, and the sweep already blocks a registration
 * past its date, so the filter is not read.
 *
 * **Personal data.** Each row carries the contact person's name and, for an
 * individual promoter, the name split into parts. Neither is read. The
 * promoter's name, which is on the certificate, is.
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
  type PortalRequest,
  type StateAdapter,
} from "./rera-portal.ts";
import { normaliseRegistrationNo, registrationKey } from "./rera-rules.ts";

const STATE = "RJ";
const PORTAL = "https://rera.rajasthan.gov.in/";
const PROJECTS_URL = "https://reraapi.rajasthan.gov.in/api/web/Home/GetProjects";

/**
 * The register held 5,314 registrations on 28 September 2026 and only
 * grows. A parse under this is a changed response, not a shrunken register.
 */
export const RJ_REGISTER_FLOOR = 1_000;

/** Fixture names under the dev seam. */
export const RJ_FIXTURES = {
  page: "index.html",
  bundle: "main.js",
  register: "GetProjects_all.json",
} as const;

export function rjKey(registrationNo: unknown): string {
  return registrationKey(STATE, registrationNo);
}

// ---------------------------------------------------------------------------
// Pure readers
// ---------------------------------------------------------------------------

/**
 * The main bundle the home page loads, as the page names it
 * (`<script src="main-B5UCN2LQ.js" type="module">`). The hash changes with
 * every release, which is why it is read rather than remembered.
 */
export function parseBundleName(html: string): string | null {
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.js)["'][^>]*>/gi)) {
    if (/(^|\/)main[-.][^/]*\.js$/i.test(m[1])) return m[1];
  }
  return null;
}

/**
 * The key the portal's interceptor sets:
 * `setHeaders:{"X-API-KEY":"MySuperSecretApiKey_123"}`. A key built from a
 * variable instead of a literal is not found, and that is "could not tell".
 */
export function parseApiKey(js: string): string | null {
  const m = js.match(/["']X-API-KEY["']\s*:\s*["']([^"'\\\s]{4,200})["']/i);
  return m ? m[1] : null;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function clean(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s || undefined;
}

/**
 * The authority's word for a row. Three are on the register:
 * "Application Approved" (ProjectStatus 3), "APPLICATION REVOKE" (5) and
 * "APPLICATION SUSPENDED" (6). Words first; the code only when the words say
 * nothing we recognise. Anything else is a registration that is listed, and
 * only a definite word is anything but REGISTERED.
 */
export function rjStatus(appStatus: unknown, projectStatus: unknown): AuthorityStatus {
  const s = typeof appStatus === "string" ? appStatus : "";
  if (/revok|cancel/i.test(s)) return "REVOKED";
  if (/suspend/i.test(s)) return "SUSPENDED";
  if (/withdraw/i.test(s)) return "WITHDRAWN";
  if (/laps/i.test(s)) return "LAPSED";
  if (/approv/i.test(s)) return "REGISTERED";
  if (projectStatus === 5 || projectStatus === "5") return "REVOKED";
  if (projectStatus === 6 || projectStatus === "6") return "SUSPENDED";
  return "REGISTERED";
}

/** An exemption certificate, which shares the list and is not a registration. */
function isExemption(no: string): boolean {
  return /EXEMPT/i.test(no);
}

export type RjParsed =
  | { ok: true; rows: PortalProject[]; exemptions: number }
  | { ok: false; reason: string };

/**
 * `GetProjects`, either way it is asked. A result is
 * `{"State": 1, "Message": "Data load successfully.", "Data": [...]}`; no
 * match is `{"State": 3, "Message": "Data not found!", "Data": null}`.
 * Anything else, including rows none of which carries a registration
 * number, is not an answer.
 */
export function parseRjProjects(text: string): RjParsed {
  let body: Json | null;
  try {
    body = asObject(JSON.parse(text));
  } catch {
    body = null;
  }
  if (!body || !("Data" in body)) {
    return { ok: false, reason: "RajRERA's API answered with something other than a project list." };
  }
  const data = body.Data;
  if (data == null || (Array.isArray(data) && data.length === 0)) {
    if (/not\s*found|no\s*record/i.test(String(body.Message ?? ""))) return { ok: true, rows: [], exemptions: 0 };
    return { ok: false, reason: "RajRERA's API answered with no projects and no notice saying none matched." };
  }
  if (!Array.isArray(data)) {
    return { ok: false, reason: "RajRERA's API answered with something other than a project list." };
  }

  const rows: PortalProject[] = [];
  let exemptions = 0;
  let numbered = 0;
  for (const item of data) {
    const r = asObject(item);
    const registrationNo = r ? clean(r.REGISTRATIONNO) : undefined;
    if (!r || !registrationNo) continue;
    numbered += 1;
    if (isExemption(registrationNo)) {
      exemptions += 1;
      continue;
    }
    const project: PortalProject = { registrationNo, status: rjStatus(r.AppStatus, r.ProjectStatus) };
    const projectName = clean(r.ProjectName);
    const promoterName = clean(r.PromoterName);
    // "RevisedDateOfComplation" (their spelling) is the completion date with
    // any extension the authority granted; every row carries one.
    const validTo = portalDate(clean(r.RevisedDateOfComplation));
    // APPROVEDON is when the certificate was granted; the certificate number
    // carries the same day in brackets, "RAJ/P/2025/4397 (18/11/2025)".
    const registeredOn = portalDate(clean(r.APPROVEDON)) ?? portalDate(clean(r.CertificateNo)?.match(/\(([^)]+)\)/)?.[1]);
    if (projectName) project.projectName = projectName;
    if (promoterName) project.promoterName = promoterName;
    if (validTo) project.validTo = validTo;
    if (registeredOn) project.registeredOn = registeredOn;
    if (r.Id != null && String(r.Id).trim()) project.portalRef = String(r.Id).trim();
    rows.push(project);
  }
  if (numbered === 0) {
    return { ok: false, reason: "RajRERA's API returned projects without registration numbers. Its shape has probably changed." };
  }
  return { ok: true, rows, exemptions };
}

/**
 * Two rows under one number. Only what both agree on is kept: a promoter
 * taken from the wrong row would refuse a lawful registration as "belongs
 * to another promoter", and a date from the wrong row would lapse it.
 * Registered if either is, because the number is live for one of them and
 * nothing says which the client holds.
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

export function rjByKey(rows: PortalProject[]): Map<string, PortalProject> {
  const out = new Map<string, PortalProject>();
  for (const row of rows) {
    const key = rjKey(row.registrationNo);
    const held = out.get(key);
    out.set(key, held ? mergeListed(held, row) : row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
let heldKey: { key: string; at: number } | null = null;

/** Forget the held key. For the checks. */
export function resetRjKey(): void {
  heldKey = null;
}

type KeyRead =
  | { ok: true; key: string; requests: number; fixture: boolean; held: boolean }
  | { ok: false; reason: string; requests: number };

/**
 * The API key, from the portal's own page and bundle.
 *
 * Held for a day, but only when it was read from the portal itself: a key
 * from the fixture folder or an injected transport is a test's, and must
 * never be sent to the real API by a later request in the same process.
 */
async function readKey(ctx: PortalCtx, mayUseHeld: boolean): Promise<KeyRead> {
  if (mayUseHeld && !ctx.fetchImpl && heldKey && Date.now() - heldKey.at < DAY_MS) {
    return { ok: true, key: heldKey.key, requests: 0, fixture: false, held: true };
  }

  const page = await portalRequest(STATE, { name: RJ_FIXTURES.page, url: PORTAL }, ctx);
  if (!page.ok) return { ok: false, reason: page.reason, requests: 1 };
  if (page.status !== 200) return { ok: false, reason: `RajRERA's home page answered ${page.status}.`, requests: 1 };
  const bundle = parseBundleName(page.text);
  if (!bundle) {
    return { ok: false, reason: "RajRERA's home page names no main script, so its API key could not be read.", requests: 1 };
  }

  let bundleUrl: string;
  try {
    bundleUrl = new URL(bundle, PORTAL).toString();
  } catch {
    return { ok: false, reason: "RajRERA's home page names a script that is not a URL.", requests: 1 };
  }
  const js = await portalRequest(STATE, { name: RJ_FIXTURES.bundle, url: bundleUrl }, ctx);
  if (!js.ok) return { ok: false, reason: js.reason, requests: 2 };
  if (js.status !== 200) return { ok: false, reason: `RajRERA's script answered ${js.status}.`, requests: 2 };
  const key = parseApiKey(js.text);
  if (!key) {
    return { ok: false, reason: "RajRERA's script no longer carries the API key where it did, so the API could not be asked.", requests: 2 };
  }

  const fixture = page.fixture || js.fixture;
  if (!ctx.fetchImpl && !fixture) heldKey = { key, at: Date.now() };
  return { ok: true, key, requests: 2, fixture, held: false };
}

function projectsRequest(name: string, filter: Json, key: string, timeoutMs?: number): PortalRequest {
  return {
    name,
    url: PROJECTS_URL,
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-api-key": key },
    // The body the site's own project list sends, every filter empty.
    body: JSON.stringify({
      DistrictId: 0,
      TeshilId: 0,
      ProjectName: null,
      PromoterName: null,
      RegistrationNo: null,
      ProjectType: 0,
      ApplicationStatus: 0,
      Year: 0,
      ...filter,
    }),
    timeoutMs,
  };
}

function refused(status: number): boolean {
  return status === 401 || status === 403;
}

// ---------------------------------------------------------------------------
// Asking the portal
// ---------------------------------------------------------------------------

/** One number, at the form: the key (held, or two requests), then one POST. */
export async function rjAtForm(registrationNo: string, ctx: PortalCtx = {}): Promise<FormVerdict> {
  const no = normaliseRegistrationNo(STATE, registrationNo);
  const key = rjKey(no);
  const name = fixtureName("GetProjects", `${no}.json`);

  let apiKey = await readKey(ctx, true);
  if (!apiKey.ok) return { known: false, reason: apiKey.reason };
  let res = await portalRequest(STATE, projectsRequest(name, { RegistrationNo: no }, apiKey.key), ctx);
  if (res.ok && refused(res.status) && apiKey.held) {
    // The authority changed the key since it was read. Read it again, once.
    heldKey = null;
    apiKey = await readKey(ctx, false);
    if (!apiKey.ok) return { known: false, reason: apiKey.reason };
    res = await portalRequest(STATE, projectsRequest(name, { RegistrationNo: no }, apiKey.key), ctx);
  }
  if (!res.ok) return { known: false, reason: res.reason };
  if (res.status !== 200) return { known: false, reason: `RajRERA's API answered ${res.status}.` };

  const parsed = parseRjProjects(res.text);
  if (!parsed.ok) return { known: false, reason: parsed.reason };
  const mine = parsed.rows.filter((p) => rjKey(p.registrationNo) === key);
  if (!mine.length) return { known: true, found: false };
  return { known: true, found: true, project: mine.reduce(mergeListed) };
}

/**
 * The whole register, once a night: the home page, the bundle, and one
 * POST with every filter empty. Three requests.
 */
export async function readRjRegister(ctx: PortalCtx = {}): Promise<NightlyResult> {
  const apiKey = await readKey(ctx, false);
  if (!apiKey.ok) return { ok: false, reason: apiKey.reason };

  const res = await portalRequest(STATE, projectsRequest(RJ_FIXTURES.register, {}, apiKey.key, 120_000), ctx);
  const requests = apiKey.requests + 1;
  if (!res.ok) return { ok: false, reason: res.reason };
  if (res.status !== 200) return { ok: false, reason: `RajRERA's API answered ${res.status}.` };
  const parsed = parseRjProjects(res.text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!plausible(parsed.rows.length, RJ_REGISTER_FLOOR, apiKey.fixture || res.fixture)) {
    return {
      ok: false,
      reason: `RajRERA's project list parsed to only ${parsed.rows.length} registrations. Its shape has probably changed, and trusting it would block every Rajasthan registration at once.`,
    };
  }

  const register = rjByKey(parsed.rows);
  const blocked = new Map<string, PortalProject>();
  for (const [key, project] of register) if (project.status !== "REGISTERED") blocked.set(key, project);
  return { ok: true, read: { register, blocked, requests } };
}

export const rjAdapter: StateAdapter = {
  state: STATE,
  keyOf: rjKey,
  atForm: (no, ctx) => rjAtForm(no, ctx),
  nightly: (ctx) => readRjRegister(ctx),
};
