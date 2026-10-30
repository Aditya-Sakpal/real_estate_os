/**
 * MahaRERA's project search, asked about one registration number.
 *
 * This is the check that runs when somebody records a number, and it is the
 * only source that answers all three questions at once: does this number
 * exist, is it still live, and whose project is it.
 *
 * Driving it took some getting wrong. The search field is labelled "Project
 * Name / MahaRERA Registration Number" and a POST carrying the page's
 * `form_build_id` returns nothing for a number, which reads as though the
 * field were name-only. It is not. `form_build_id` names a form Drupal has
 * cached server side, and submitting it makes the rebuilt form win over the
 * posted values. Leave it out and the raw input is processed:
 *
 *   GET  /projects-search-result                 collect the session cookie
 *   POST /projects-search-result                 project_name=<number>
 *        project_type, project_state, form_id, op=Search
 *        NO form_build_id
 *
 * The priming GET is not optional either. Without the session cookie the POST
 * returns the unfiltered listing, which looks like a page of results and is
 * not an answer to anything.
 *
 * `project_type` picks which register is searched, and the pair of them is
 * what makes the verdict complete:
 *
 *   project_type=0   Registered Projects    live registrations
 *   project_type=1   Revoked Projects       cancelled ones
 *
 *   live number       0 -> one result card   1 -> Unable to find records
 *   revoked number    0 -> Unable to find    1 -> the revoked banner
 *   number never      0 -> Unable to find    1 -> Unable to find records
 *   issued
 *
 * So one request settles the good case and a second settles why a miss was a
 * miss. Compare that with reading the bulk register: 53 KB against 3.5 MB, and
 * the card carries the promoter name, which the bulk extract does not.
 *
 * It is a per-number lookup, so it belongs here at the form and NOT in the
 * nightly sweep. Ten thousand registrations checked one at a time is roughly
 * eight hours and enough load on one government server to earn a block. The
 * sweep reads the published lists in bulk instead, which is three requests
 * however many clients there are. See `rera-mh.ts` and `rera-mh-register.ts`.
 */

// The portal moved to www. in October 2026. The old host answers 301, and a
// POST that follows a 301 arrives as a GET with no body.
const BASE = "https://www.maharera.maharashtra.gov.in";
const PATH = "/projects-search-result";

/** Maharashtra, as the form's own state list numbers it. */
const MH_STATE = "27";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/** The portal's own wording for a search that matched nothing. */
const NO_MATCH = /Unable to find records|No Record/i;

/** The banner a revoked project's page carries, in English. */
const REVOKED =
  /registration of this project has been cancelled|this project is revoked/i;

export type FoundProject = {
  registrationNo: string;
  projectName: string;
  promoterName: string;
  district: string;
  pincode: string;
  detailUrl: string | null;
  /** The ids the card opens its registration certificate and its extension certificate with. */
  certId?: string | null;
  extCertId?: string | null;
};

export type SearchVerdict =
  /** The authority lists it as a live registration. */
  | { known: true; status: "REGISTERED"; project: FoundProject }
  /** Issued once, and cancelled since. */
  | { known: true; status: "REVOKED" }
  /** In neither register. No such registration was ever issued. */
  | { known: true; status: "ABSENT" }
  /** The portal could not be read. Not an answer, and must not be treated as one. */
  | { known: false; reason: string };

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
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
 * Read one result card.
 *
 *   <div class="row shadow ...">
 *     <p class="p-0"># P51700000002</p>
 *     <h4 class="title4"><strong>UNNATHI WOODS PHASE VII A</strong></h4>
 *     <p class="darkBlue bold ">UNNATHI ESTATES</p>
 *
 * The card is located by the registration number we asked about rather than by
 * position, so the page can gain a banner or a promoted listing without this
 * reading the wrong row.
 */
export function parseCard(html: string, registrationNo: string): FoundProject | null {
  const at = html.search(
    new RegExp(`#\\s*${registrationNo.replace(/[^A-Z0-9]/gi, "")}\\b`, "i"),
  );
  if (at < 0) return null;

  // Everything from the number to the end of that card.
  const card = html.slice(at, at + 4000);

  const name = card.match(/<h4[^>]*class="[^"]*title4[^"]*"[^>]*>([\s\S]*?)<\/h4>/i);
  const promoter = card.match(/<p[^>]*class="[^"]*darkBlue[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  const district = card.match(/District<\/div>\s*<p>([\s\S]*?)<\/p>/i);
  const pincode = card.match(/Pincode<\/div>\s*<p>([\s\S]*?)<\/p>/i);
  const detail = card.match(/https?:\/\/[^"']*\/public\/project\/view\/\d+/i);
  const certId = card.match(/data-qstr-flag="DocProjectCert"[^>]*data-qstr="(\d+)"|data-qstr="(\d+)"[^>]*data-qstr-flag="DocProjectCert"/i);
  const extId = card.match(/data-qstr-flag="DocProjectExtCert"[^>]*data-qstr="(\d+)"|data-qstr="(\d+)"[^>]*data-qstr-flag="DocProjectExtCert"/i);

  // A card with no project name is not a card. Better to report the page as
  // unreadable than to accept a registration against an empty name.
  if (!name) return null;

  return {
    registrationNo: registrationNo.toUpperCase(),
    projectName: decode(name[1]),
    promoterName: promoter ? decode(promoter[1]) : "",
    district: district ? decode(district[1]) : "",
    pincode: pincode ? decode(pincode[1]) : "",
    detailUrl: detail ? detail[0] : null,
    certId: certId ? certId[1] ?? certId[2] : null,
    extCertId: extId ? extId[1] ?? extId[2] : null,
  };
}

const DAY = /(\d{2})\/(\d{2})\/(\d{4})/;
/** Times a certificate is asked for before it is taken as unreadable. */
const CERT_TRIES = 6;
const iso = (m: RegExpExecArray | RegExpMatchArray | null) => (m ? `${m[3]}-${m[2]}-${m[1]}` : null);

/**
 * The dates a MahaRERA registration certificate (Form C) prints: "valid for a
 * period commencing from 03/01/2023 and ending with 31/10/2025". An extension
 * certificate's latest date is the day it now ends. A text with neither says
 * nothing, never a guess.
 */
export function certificateDates(cert: string, ext = ""): { registeredOn: string | null; validTo: string | null } {
  const t = cert.replace(/\s+/g, " ");
  const span = /commencing from (\d{2}\/\d{2}\/\d{4}) and ending with (\d{2}\/\d{2}\/\d{4})/i.exec(t);
  const from = span ? iso(DAY.exec(span[1])) : null;
  let to = span ? iso(DAY.exec(span[2])) : null;
  const e = ext.replace(/\s+/g, " ");
  if (/extend|extension/i.test(e)) {
    const dates = [...e.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)].map((m) => `${m[3]}-${m[2]}-${m[1]}`).sort();
    const last = dates[dates.length - 1] ?? null;
    if (last && (!to || last > to)) to = last;
  }
  return { registeredOn: from, validTo: to };
}

/**
 * One of a card's certificates, as the PDF it is: the portal answers the
 * search page's own request (an XHR with the search's session cookie) with
 * the PDF inside a modal, as a data address; anything else is nothing.
 */
export async function certificatePdf(id: string, kind: "DocProjectCert" | "DocProjectExtCert", fetchImpl?: typeof fetch): Promise<Buffer | null> {
  if (!/^\d{1,9}$/.test(id)) return null;
  const go = fetchImpl ?? fetch;
  try {
    // Like the search, the portal often answers an empty page, quickly, for a
    // document it holds (measured on 30 October 2026: four empty answers, then
    // the PDF), so it is asked again in a fresh session two seconds apart.
    for (let attempt = 0; attempt < CERT_TRIES; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000));
      const primed = await go(`${BASE}${PATH}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
      const jar = (primed.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
      const r = await go(`${BASE}/project-document?id=${id}&type=${kind}`, {
        headers: { "user-agent": UA, accept: "*/*", "x-requested-with": "XMLHttpRequest", referer: `${BASE}${PATH}`, ...(jar ? { cookie: jar } : {}) },
        signal: AbortSignal.timeout(45_000),
      });
      if (!r.ok) return null;
      const m = /data:application\/pdf;base64,([A-Za-z0-9+/=]+)/.exec(await r.text());
      if (!m) continue;
      const pdf = Buffer.from(m[1], "base64");
      return pdf.subarray(0, 5).toString("latin1") === "%PDF-" ? pdf : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** The dates a found registration's certificates print, read off their text layer; nothing when they cannot be read. */
export async function readCertificateDates(p: FoundProject, fetchImpl?: typeof fetch): Promise<{ registeredOn: string | null; validTo: string | null }> {
  if (!p.certId) return { registeredOn: null, validTo: null };
  const { readPages } = await import("./pdf-read.ts");
  const text = async (pdf: Buffer | null) =>
    pdf ? (await readPages(pdf, "application/pdf", [1, 2], undefined, { textOnly: true }).catch(() => [])).flatMap((pg) => pg.segments.map((s) => s.text)).join(" ") : "";
  const cert = await text(await certificatePdf(p.certId, "DocProjectCert", fetchImpl));
  const ext = p.extCertId ? await text(await certificatePdf(p.extCertId, "DocProjectExtCert", fetchImpl)) : "";
  return certificateDates(cert, ext);
}

type Tab = "REGISTERED" | "REVOKED";

/**
 * A folder of captured responses to answer from instead of the portal.
 *
 * Named `<NUMBER>_<registered|revoked>.html`. It keeps `npm run check`
 * deterministic, offline and off a government server, for the invented
 * numbers a test suite uses.
 *
 * **A number with no fixture falls through to the real portal.** That is the
 * important half. The alternative, treating a missing file as a no-match,
 * would mean any developer running the console locally has every genuine
 * registration refused, which turns a test seam into a broken product.
 */
function fixtureDir(): string | null {
  return process.env.RERA_MH_SEARCH_DIR?.trim() || null;
}

async function fromFixture(
  registrationNo: string,
  tab: Tab,
  dir: string,
): Promise<{ ok: true; html: string } | null> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const file = join(
    dir,
    `${registrationNo}_${tab === "REGISTERED" ? "registered" : "revoked"}.html`,
  );
  try {
    return { ok: true, html: await readFile(file, "utf8") };
  } catch {
    // Not a number this seam has an opinion about. Ask the authority.
    return null;
  }
}

/**
 * Whether this number's answer is a captured page, not the live portal's. A
 * canned miss is the answer a check chose; a live one may be the portal's
 * flakiness, so only the live one is asked again.
 */
export async function searchIsCanned(registrationNo: string, fetchImpl?: typeof fetch): Promise<boolean> {
  const dir = fixtureDir();
  if (fetchImpl || !dir) return false;
  return (await fromFixture(registrationNo.trim().toUpperCase(), "REGISTERED", dir)) !== null;
}

async function ask(
  registrationNo: string,
  tab: Tab,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; html: string } | { ok: false; reason: string }> {
  // A caller that supplied its own transport always wins, so a unit test
  // injecting a fetch is never quietly served a fixture instead.
  const dir = fixtureDir();
  if (!fetchImpl && dir) {
    const canned = await fromFixture(registrationNo, tab, dir);
    if (canned) return canned;
  }

  const go = fetchImpl ?? fetch;
  try {
    // The priming GET. Its only job is the session cookie: without one the
    // POST answers with the unfiltered listing rather than a search.
    const primed = await go(`${BASE}${PATH}`, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!primed.ok) return { ok: false, reason: `search page returned ${primed.status}` };

    const jar = (primed.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .join("; ");

    const body = new URLSearchParams({
      project_type: tab === "REGISTERED" ? "0" : "1",
      project_name: registrationNo,
      project_location: "",
      project_completion_date: "",
      project_state: MH_STATE,
      project_district: "",
      // form_build_id is deliberately absent. Sending it makes Drupal rebuild
      // the cached form and discard what was posted, which is why a number
      // appears not to work.
      form_id: "projects_search_page_form",
      op: "Search",
    });

    const res = await go(`${BASE}${PATH}`, {
      method: "POST",
      headers: {
        "user-agent": UA,
        "content-type": "application/x-www-form-urlencoded",
        ...(jar ? { cookie: jar } : {}),
      },
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, reason: `search returned ${res.status}` };
    return { ok: true, html: await res.text() };
  } catch (e) {
    return { ok: false, reason: `search unreachable: ${(e as Error).message}` };
  }
}

/**
 * Ask the authority about one number.
 *
 * Costs one request when the number is live, and a second only to explain a
 * miss, which is the case where the difference between "revoked" and "never
 * issued" is worth saying out loud.
 */
export async function searchRegistration(
  registrationNo: string,
  fetchImpl?: typeof fetch,
): Promise<SearchVerdict> {
  const no = registrationNo.trim().toUpperCase();

  const live = await ask(no, "REGISTERED", fetchImpl);
  if (!live.ok) return { known: false, reason: live.reason };

  const card = parseCard(live.html, no);
  if (card) return { known: true, status: "REGISTERED", project: card };

  // No card. Before calling that an answer, the page has to actually be a
  // search result: a page that says nothing we recognise is a page whose shape
  // has changed, and reading it as "this registration does not exist" would
  // block a lawful campaign on the strength of a parser bug.
  if (!NO_MATCH.test(live.html)) {
    return {
      known: false,
      reason:
        "The search returned a page with neither a result nor a no-match notice. Its shape has probably changed.",
    };
  }

  const revoked = await ask(no, "REVOKED", fetchImpl);
  if (!revoked.ok) {
    // The first half was a definite miss, so the number is certainly not a
    // live registration. Which kind of miss is unknown, and ABSENT is the
    // honest floor: both outcomes refuse, and the message says so.
    return { known: true, status: "ABSENT" };
  }
  if (REVOKED.test(revoked.html) || parseCard(revoked.html, no)) {
    return { known: true, status: "REVOKED" };
  }
  return { known: true, status: "ABSENT" };
}
