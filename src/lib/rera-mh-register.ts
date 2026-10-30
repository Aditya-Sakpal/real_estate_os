/**
 * The MahaRERA register itself, in bulk.
 *
 * The revocation lists in `rera-mh.ts` answer "has this been taken away".
 * They cannot answer "was this ever real", which is the question a fabricated
 * certificate turns on: a number that was never issued is absent from the
 * revocation list for exactly the same reason a clean number is.
 *
 * The interactive search cannot answer it either. Its field is labelled
 * "Project Name / MahaRERA Registration Number", but a number returns nothing
 * there, with or without the P, spaced, lower-cased or with the state filter
 * cleared. Only a name matches. The project detail pages that would confirm a
 * number sit behind a CAPTCHA, which is an access control and is not ours to
 * work around.
 *
 * The GIS map page is the way in, and it is the authority's own publication.
 * It renders every registered project as a marker, and to do that it embeds
 * the whole register in the page as JSON:
 *
 *   /map-projects-search-result
 *     <div id="mapLocationData" class="displayNone">[ ...52,522 projects... ]</div>
 *
 * Each record carries the certificate number, the project name as registered,
 * and where it is. So existence costs one request for every client we have,
 * the same shape as the revocation check: 3.5 MB gzipped, about 7 seconds,
 * once per sweep.
 *
 * What this proves and what it does not. Present means the authority issued
 * that number and the project name it issued it against is the one returned
 * here, so a number typed against the wrong project is caught. Absent means
 * the number is not in the register at all. It still does not prove the
 * promoter is the client, because the register's public extract carries no
 * promoter name; the entity name check remains an internal-consistency check.
 */

// The portal moved to www. in October 2026. The old host answers 301, and a
// POST that follows a 301 arrives as a GET with no body.
const BASE = "https://www.maharera.maharashtra.gov.in";
const PATH = "/map-projects-search-result";

/**
 * Where the register is read from.
 *
 * Overridable so the functional checks can point at
 * `db/fixtures/maharera-register.html` and exercise the real fetch, parse and
 * lookup path without pulling 3.5 MB off a government server every run. It is
 * a test seam, not a feature: leave it unset everywhere else.
 */
function source(): string {
  return process.env.RERA_MH_REGISTER_URL?.trim() || `${BASE}${PATH}`;
}

/**
 * The register held 52,522 projects when this was written and only grows. A
 * parse that returns far fewer is a changed page, not a shrunken register,
 * and treating it as the truth would block every real project at once. That
 * is the mirror of the revocation list's floor and matters more, because here
 * a wrong answer blocks lawful advertising rather than permitting unlawful.
 */
export const MIN_PLAUSIBLE_RECORDS = 10_000;

export type RegisteredProject = {
  certificateNo: string;
  projectName: string;
  district: string;
  taluka: string;
  pincode: string;
};

export type RegisterResult =
  | { ok: true; entries: Map<string, RegisteredProject>; size: number }
  | { ok: false; reason: string };

/** Raw shape of one record in the embedded array. All fields arrive as strings. */
type RawRecord = {
  projectName?: string;
  CertificateNo?: string;
  project_District?: string;
  project_Taluka?: string;
  pincode?: string;
};

function unescapeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull the embedded array out of the page.
 *
 * The div is found by id and the array by its brackets, so the surrounding
 * markup can change freely. A record missing a certificate number is skipped
 * rather than stored under an empty key.
 */
export function parseRegister(html: string): RegisteredProject[] {
  const div = html.match(
    /<div[^>]*id=["']mapLocationData["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  if (!div) return [];

  const body = div[1].trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let raw: RawRecord[];
  try {
    raw = JSON.parse(body.slice(start, end + 1)) as RawRecord[];
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const out: RegisteredProject[] = [];
  for (const r of raw) {
    const certificateNo = (r.CertificateNo ?? "").trim().toUpperCase();
    if (!certificateNo) continue;
    out.push({
      certificateNo,
      projectName: unescapeEntities(r.projectName ?? ""),
      district: unescapeEntities(r.project_District ?? ""),
      taluka: unescapeEntities(r.project_Taluka ?? ""),
      pincode: (r.pincode ?? "").trim(),
    });
  }
  return out;
}

export async function fetchRegister(
  fetchImpl?: typeof fetch,
): Promise<RegisterResult> {
  const url = source();

  // A fixture on disk. Node's fetch does not do file: URLs, and a check
  // should not have to stand up a web server to read three records.
  //
  // A caller that supplied its own transport always wins, so a unit test
  // injecting a fetch is never quietly served the fixture instead.
  if (!fetchImpl && url.startsWith("file:")) {
    try {
      const { readFile } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      return finish(await readFile(fileURLToPath(url), "utf8"), url);
    } catch (e) {
      return { ok: false, reason: `${url} unreadable: ${(e as Error).message}` };
    }
  }

  let html: string;
  try {
    const res = await (fetchImpl ?? fetch)(url, {
      headers: {
        "user-agent": "Sales Desk compliance check (+https://salesdesk.app)",
        "accept-encoding": "gzip, deflate",
      },
      // The page is 21 MB uncompressed, so this is a slower fetch than the
      // revocation lists and needs its own budget.
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { ok: false, reason: `${PATH} returned ${res.status}` };
    html = await res.text();
  } catch (e) {
    // Unreachable is an unknown. The caller must change nothing on its
    // account, in either direction.
    return { ok: false, reason: `${PATH} unreachable: ${(e as Error).message}` };
  }

  return finish(html, url);
}

function finish(html: string, url: string): RegisterResult {
  const records = parseRegister(html);

  // The floor guards against the AUTHORITY's page changing shape under us. A
  // fixture is ours and cannot, so an overridden source carries a token floor
  // instead: enough to catch a file that did not parse, not enough to demand
  // fifty thousand rows of test data.
  const floor = url.startsWith(BASE) ? MIN_PLAUSIBLE_RECORDS : 1;
  if (records.length < floor) {
    return {
      ok: false,
      reason: `${url} parsed only ${records.length} projects. The page shape has probably changed, and trusting that would block every registration at once.`,
    };
  }

  const entries = new Map<string, RegisteredProject>();
  for (const r of records) entries.set(r.certificateNo, r);
  return { ok: true, entries, size: entries.size };
}

/**
 * The register in memory, refreshed at most once a day.
 *
 * Two callers want it and they want it very differently. The sweep reads it
 * once a night and would happily fetch every time. The record-a-registration
 * form asks about a single number while a person waits, and cannot spend
 * seven seconds and 3.5 MB on that. Holding one copy serves both, and the
 * cached copy is never used to block: it decides only whether to accept.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
let cached: { at: number; entries: Map<string, RegisteredProject> } | null = null;

export async function getRegister(
  fetchImpl?: typeof fetch,
  now = Date.now(),
): Promise<RegisterResult> {
  if (cached && now - cached.at < TTL_MS) {
    return { ok: true, entries: cached.entries, size: cached.entries.size };
  }
  const fresh = await fetchRegister(fetchImpl);
  if (fresh.ok) cached = { at: now, entries: fresh.entries };
  return fresh;
}

/** Drop the cached copy. For the checks, which must not inherit a real fetch. */
export function resetRegisterCache(): void {
  cached = null;
}

export type ExistenceVerdict =
  | { known: true; found: true; project: RegisteredProject }
  | { known: true; found: false }
  | { known: false; reason: string };

/**
 * Is this number in the register?
 *
 * Three answers, never two. "Not found" and "could not tell" are different
 * facts and collapsing them is how a government website having a bad evening
 * turns into a blocked campaign.
 */
export async function lookupRegistration(
  registrationNo: string,
  fetchImpl?: typeof fetch,
): Promise<ExistenceVerdict> {
  const reg = await getRegister(fetchImpl);
  if (!reg.ok) return { known: false, reason: reg.reason };

  const hit = reg.entries.get(registrationNo.trim().toUpperCase());
  return hit ? { known: true, found: true, project: hit } : { known: true, found: false };
}
