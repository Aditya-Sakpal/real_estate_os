/**
 * Haryana RERA, read the way its two authorities publish it.
 *
 * One portal, haryanarera.gov.in, serves two authorities, and every list on
 * it comes twice: a path ending `/1` is Panchkula (every district but one),
 * `/2` is Gurugram. Each authority publishes three lists, as plain HTML with
 * no login and no CAPTCHA:
 *
 *   /admincontrol/registered_projects/{1,2}   the register, about 1,100 each
 *   /admincontrol/lapsed_projects/{1,2}       lapsed registrations
 *   /admincontrol/cancelled_projects/{1,2}    "Defaulter/Cancelled/Suspended/
 *                                              Abeyance Projects"
 *
 * Six requests, about 6 MB, answer every tenant's Haryana registrations at
 * once. The per-number search sits behind a CAPTCHA, which is an access
 * control and not ours to work around, so the form answers from the same six
 * lists through the day's shared copy: the first number of the day costs the
 * six requests and every later one costs nothing.
 *
 * **Two identifiers per project, and either finds it.** A registration
 * certificate (`GGM/940/672/2025/43 DATED 01.05.2025` in Gurugram,
 * `HRERA-PKL-AMB-812-2025` in Panchkula, and `232 OF 2017` at either for the
 * interim numbers of 2017 and 2018) and a Project ID (`RERA-GRG-1817-2024`). An
 * advertisement prints the certificate, so that is what a client records,
 * but the Project ID is what the portal's own search keys on, so a client
 * may well record that instead. The register carries both, and both are
 * keys here.
 *
 * **Status is written into the certificate cell as text.** "Lapsed Project",
 * "(REGISTRATION SUSPENDED)", "(IN ABEYANCE)", "(SUPERSEDED BY ...)" and
 * "(SUPERSEDES ...)" sit beside the number, and a "project completed" image
 * sits inside an HTML comment, which is stripped before anything is read
 * because a comment is not something the authority is saying.
 *
 * **The "Registration Up-to" column is not a lapse.** It misses extensions
 * granted by corrigendum (257 Gurugram rows were past their date with no
 * lapse flag on 28 September 2026). It is reported as `validTo`, because it
 * is the latest date the source shows, and nothing here decides anything on
 * it. Only the authority's own words ("Lapsed Project", or the lapsed list)
 * make a registration LAPSED.
 *
 * **A superseded certificate is not the live registration.** When the
 * authority reissues a certificate (a revision, two projects merged), the old
 * number is marked "SUPERSEDED BY" the new one. Advertising the old number is
 * advertising a number that is no longer on the filing, so it is reported as
 * REVOKED: the closest word the seam has for "the authority took this number
 * back". The new number is the live one, and where it has no row of its own
 * it takes the old row's project.
 *
 * **One number could name two projects.** Both authorities printed the
 * interim numbers of 2017 and 2018 in one bare form, `232 OF 2017`, with
 * nothing saying whose. On 28 September 2026 no such number appeared at both
 * authorities, so the series looks shared, but nothing on the portal says
 * it is. A key that names two projects is ambiguous: it counts as present in
 * the register, it is blocked only when every project it names is, and the
 * form says it cannot tell which was meant and asks for the Project ID.
 *
 * The portal's terms of use ask for permission, by email, before material on
 * it is reproduced. Asking is being handled outside the code.
 *
 * Imports are relative so the nightly job can load this straight from
 * source, outside Next.
 */

import {
  htmlText,
  plausible,
  portalDate,
  portalRequest,
  sharedRead,
  type AuthorityStatus,
  type FormVerdict,
  type NightlyRead,
  type NightlyResult,
  type PortalCtx,
  type PortalProject,
  type StateAdapter,
} from "./rera-portal.ts";
import { registrationKey } from "./rera-rules.ts";

const STATE = "HR";
const BASE = "https://haryanarera.gov.in";

export type HrAuthority = "1" | "2";
export type HrList = "registered" | "lapsed" | "cancelled";

/** What each path number means, and the prefix its Project IDs carry. */
export const HR_AUTHORITIES: Record<HrAuthority, { name: string; idPrefix: string }> = {
  "1": { name: "Panchkula", idPrefix: "RERA-PKL" },
  "2": { name: "Gurugram", idPrefix: "RERA-GRG" },
};

/**
 * The floor each list must clear, per authority. Measured on 28 September
 * 2026: registered 1,103 and 1,079, lapsed 312 and 224, cancelled 23 and 5.
 * Roughly a fifth of each, and a token one for Gurugram's cancelled list,
 * which is five rows long: an empty parse of it is still refused.
 */
export const HR_FLOORS: Record<HrList, Record<HrAuthority, number>> = {
  registered: { "1": 200, "2": 200 },
  lapsed: { "1": 60, "2": 40 },
  cancelled: { "1": 3, "2": 1 },
};

const LISTS: HrList[] = ["registered", "lapsed", "cancelled"];

/** How two spellings of one Haryana number compare. */
export function hrKey(no: string): string {
  return registrationKey(STATE, no);
}

// ---------------------------------------------------------------------------
// Reading one list
// ---------------------------------------------------------------------------

/** What the certificate cell says, beside the number itself. */
export type HrCertificate = {
  /** The number as printed, without its date or any note. */
  number: string;
  /** YYYY-MM-DD from "DATED ...", when it reads as a date. */
  dated?: string;
  lapsed: boolean;
  /** "(REGISTRATION SUSPENDED)" or "(IN ABEYANCE)". */
  suspended: boolean;
  /** The certificate that replaced this one. */
  supersededBy?: string;
  /** The certificate this one replaced. */
  supersedes?: string;
};

export type HrRow = {
  authority: HrAuthority;
  list: HrList;
  certificate: HrCertificate;
  /** RERA-GRG-741-2020, or null where the portal prints NA or a bare "-541-2019". */
  projectId: string | null;
  /** The id in /view_project/searchprojectDetail/{id}. */
  detailId?: string;
  projectName?: string;
  promoterName?: string;
  /** "Registration Up-to" on the register, "Approval To" on the lapsed list. */
  validTo?: string;
  /** "Approval From" on the lapsed list. */
  approvedFrom?: string;
};

/** A certificate number's token, closing an unbalanced bracket the note opened. */
function token(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let t = raw.trim().replace(/[,;:]+$/, "");
  while (t.endsWith(")") && (t.match(/\)/g) ?? []).length > (t.match(/\(/g) ?? []).length) {
    t = t.slice(0, -1);
  }
  t = t.replace(/[\s,;:.-]+$/, "");
  return t || undefined;
}

/**
 * Read a certificate cell's text.
 *
 *   GGM/486/218/2021/54 DATED 21.09.2021 Lapsed Project
 *   GGM/602/334/2022/77 DATED 17.08.2022 (SUPERSEDED BY GGM/790/522/2024/17 DATED 01.03.2024)
 *   RC NO. GGM/938/670/2025/41 DATED 01.05.2025 IS HEREBY SUPERSEDED BY RC NO. GM/938/670/2025/41/SS(1)/1 DATED 10.08.2026
 *   HRERA-PKL-AMB-36-2018 , DATED 09-08-2018
 *   160(A) OF 2017 DATED 21.11.2017
 *
 * The number is everything before the first of: its date, a bracketed note,
 * "IS HEREBY", or "Lapsed Project". A bracket that is part of the number
 * ("08(A)", "SS(1)") is not a note, which is why a note is recognised by
 * the word that opens it and not by the bracket.
 */
export function readCertificate(text: string): HrCertificate {
  const t = text.replace(/\s+/g, " ").trim();
  const lapsed = /\bLAPSED\s+PROJECT\b/i.test(t);
  const suspended = /REGISTRATION\s+SUSPENDED|\bIN\s+ABEYANCE\b/i.test(t);
  // A number is one token, or the interim "N OF YYYY" form.
  const NUM = String.raw`(?:RC\s*NO\.?\s*)?(\d+(?:\([A-Z]\))?\s+O[F]F?\s+\d{4}|\S+)`;
  const by = t.match(new RegExp(String.raw`SUPERSEDED\s+BY\s+${NUM}`, "i"));
  const sup = t.match(new RegExp(String.raw`\bSUPERSEDES\s+${NUM}`, "i"));

  let head = t.replace(/^RC\s*NO\.?\s*/i, "");
  const cut = head.search(
    /[\s,]*\bDATED\b|\(\s*(?:SUPERSEDE|REGISTRATION|IN\s+ABEYANCE)|\bIS\s+HEREBY\b|\bLAPSED\s+PROJECT\b|\bSUPERSEDE/i,
  );
  if (cut >= 0) head = head.slice(0, cut);
  head = head.replace(/[\s,;:.-]+$/, "").trim();

  const dated = t.match(/\bDATED\b[\s:.-]*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i);
  return {
    number: head,
    dated: portalDate(dated?.[1]) ?? undefined,
    lapsed,
    suspended,
    supersededBy: token(by?.[1]),
    supersedes: token(sup?.[1]),
  };
}

/**
 * A Project ID as the portal prints it. The cancelled lists print it without
 * its prefix ("-541-2019"); that is the authority's own id with the prefix
 * lost, and the page it came from says which prefix it lost.
 */
export function readProjectId(text: string, authority: HrAuthority): string | null {
  const t = text.replace(/\s+/g, "").toUpperCase();
  if (/^RERA-(GRG|PKL)-\d+-\d{4}$/.test(t)) return t;
  const bare = t.match(/^-(\d+-\d{4})$/);
  if (bare) return `${HR_AUTHORITIES[authority].idPrefix}-${bare[1]}`;
  return null;
}

/** Comments out, so hidden markup is never read as the authority's word. */
function uncomment(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** Every `<td>` of every row, as raw HTML, split on the row's opening tag. */
function bodyRows(tableHtml: string): string[][] {
  // Split on the opening tag rather than matching <tr>...</tr>: the cancelled
  // lists never close their header row, and a paired match would swallow the
  // first project into the header.
  return tableHtml
    .split(/<tr\b[^>]*>/i)
    .slice(1)
    .map((chunk) => [...chunk.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]));
}

/**
 * The table that is a list of projects: the one whose header names both a
 * certificate and a Project ID. The page carries other tables (a corrigendum
 * dialog headed "Registration Certificate Number" alone), and position on
 * the page is not something to rely on.
 */
function projectTable(html: string): { heads: string[]; body: string } | null {
  for (const m of uncomment(html).matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const t = m[0];
    const heads = [...t.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((h) => htmlText(h[1]));
    if (
      heads.some((h) => /registration certificate number/i.test(h)) &&
      heads.some((h) => /^project id$/i.test(h))
    ) {
      return { heads, body: t };
    }
  }
  return null;
}

/**
 * One list page to rows. Columns are found by their header's words, never by
 * position, and a page without the table is an empty list, which the floor
 * then refuses rather than believing.
 */
export function parseHrList(html: string, list: HrList, authority: HrAuthority): HrRow[] {
  const table = projectTable(html);
  if (!table) return [];
  const col = (re: RegExp) => table.heads.findIndex((h) => re.test(h));
  const at = {
    cert: col(/registration certificate number/i),
    id: col(/^project id$/i),
    name: col(/^project name$/i),
    promoter: col(/^(builder|promoter)/i),
    upTo: col(/registration up-?\s*to/i),
    from: col(/approval from/i),
    to: col(/approval to/i),
  };
  const need = Math.max(at.cert, at.id);

  const out: HrRow[] = [];
  for (const cells of bodyRows(table.body)) {
    if (cells.length <= need) continue;
    const cell = (i: number) => (i >= 0 && i < cells.length ? htmlText(cells[i]) : "");
    const certificate = readCertificate(cell(at.cert));
    // A number has digits in it. A cell without any is a header, a spacer,
    // or a row nobody filled in, and none of those is a registration.
    if (!/\d/.test(certificate.number) || certificate.number.length < 4) continue;

    const detail = cells.join(" ").match(/searchprojectDetail\/(\d+)/i);
    out.push({
      authority,
      list,
      certificate,
      projectId: readProjectId(cell(at.id), authority),
      detailId: detail?.[1],
      projectName: cell(at.name) || undefined,
      promoterName: cell(at.promoter) || undefined,
      validTo: portalDate(cell(at.upTo >= 0 ? at.upTo : at.to)) ?? undefined,
      approvedFrom: portalDate(cell(at.from)) ?? undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// From rows to the register
// ---------------------------------------------------------------------------

/** An interim number however it is spelt, once spaces are gone: 232OF2017, 232/2017, 114OFF2017, 1530F2017. */
const INTERIM = /^(\d+?)(\([A-Z]\))?(?:OFF?|0F|\/),?(\d{4})$/;

/**
 * Every spelling a number answers to, so the client's spelling finds the
 * portal's. The certificates of 2017 read "232 OF 2017", and the lists print
 * the same kind of number as "232/2017", "09 OF 2018", "114 OFF 2017" and
 * "153 0F 2017". One number, several spellings, and the client typed one of
 * them. Keys only ever widen what a number matches within its own spellings;
 * two different numbers never share one.
 */
export function hrAliases(number: string): string[] {
  const keys = new Set<string>([hrKey(number), hrCanonical(number)]);
  const interim = hrKey(number).match(INTERIM);
  if (interim) {
    const [, n, suffix = "", year] = interim;
    for (const serial of new Set([n, String(Number(n))])) {
      keys.add(hrKey(`${serial}${suffix} OF ${year}`));
      keys.add(hrKey(`${serial}${suffix}/${year}`));
    }
  }
  return [...keys];
}

/**
 * One spelling per number, for telling whether two spellings are one
 * certificate: the interim form as "232OF2017" without leading zeros,
 * Panchkula's dropped R put back, and a mistaken bracket taken out.
 */
export function hrCanonical(number: string): string {
  let v = hrKey(number);
  const interim = v.match(INTERIM);
  if (interim) return `${Number(interim[1])}${interim[2] ?? ""}OF${interim[3]}`;
  v = v.replace(/^HERA-PKL-/, "HRERA-PKL-");
  // "HRERA-PKL-(PKL-16-2018)": the district and serial bracketed by mistake.
  const bracketed = v.match(/^(H?RERA-PKL-)\((.+)\)$/);
  return bracketed ? `${bracketed[1]}${bracketed[2]}` : v;
}

/** The authority's strongest word wins: a number both lapsed and cancelled is cancelled. */
const RANK: Record<AuthorityStatus, number> = {
  REGISTERED: 0,
  LAPSED: 1,
  SUSPENDED: 2,
  WITHDRAWN: 3,
  REVOKED: 4,
};

function stronger(a: AuthorityStatus, b: AuthorityStatus): AuthorityStatus {
  return RANK[b] > RANK[a] ? b : a;
}

/** One certificate at one authority, with everything the lists say about it. */
type Identity = {
  id: string;
  keys: Set<string>;
  project: PortalProject;
};

/** What this adapter's read carries beyond the seam's: keys naming two projects. */
export type HrRead = NightlyRead & { ambiguous: Set<string> };

/**
 * Six lists to one read.
 *
 * Each certificate at each authority is one identity. The register gives it
 * its project and the status its cell spells out; the lapsed and cancelled
 * lists add theirs, and the strongest word wins. Then every key an identity
 * answers to (its number, the other spellings of an interim number, its
 * Project ID) points at it, and a key pointing at two identities is
 * ambiguous.
 */
export function buildHrRead(rows: HrRow[], requests: number): HrRead {
  const ids = new Map<string, Identity>();

  const identity = (authority: HrAuthority, number: string): Identity => {
    const id = `${authority}:${hrCanonical(number)}`;
    let held = ids.get(id);
    if (!held) {
      held = { id, keys: new Set<string>(), project: { registrationNo: number, status: "REGISTERED" } };
      ids.set(id, held);
    }
    // Every spelling the lists use for it answers, not only the first one read.
    for (const k of hrAliases(number)) held.keys.add(k);
    return held;
  };

  // Every certificate that has a row of its own at its authority. A number
  // named only inside another row's note is then known to have none.
  const hasRow = new Set(rows.map((r) => `${r.authority}:${hrCanonical(r.certificate.number)}`));

  // Project IDs, claimed after the rows are read. A row whose certificate
  // was replaced by one with a row of its own claims its Project ID only as
  // a fallback: when the reissued row carries the same ID, the ID means the
  // live certificate, not the one it replaced.
  const claims = new Map<string, { live: Set<Identity>; replaced: Set<Identity> }>();
  const claim = (projectId: string, who: Identity, replaced: boolean) => {
    const k = hrKey(projectId);
    const c = claims.get(k) ?? { live: new Set<Identity>(), replaced: new Set<Identity>() };
    (replaced ? c.replaced : c.live).add(who);
    claims.set(k, c);
  };

  const fill = (who: Identity, r: HrRow, status: AuthorityStatus, fromNote = false) => {
    const p = who.project;
    p.status = stronger(p.status, status);
    // A note about a number with a row of its own changes only its status:
    // the row is the authority's word on everything else about it.
    if (fromNote && hasRow.has(who.id)) return;
    p.projectName ??= r.projectName;
    p.promoterName ??= r.promoterName;
    p.portalRef ??= r.detailId;
    p.registeredOn ??= r.certificate.dated ?? r.approvedFrom;
    // The register's date first; the lapsed list's only where it has none.
    if (r.list === "registered" && r.validTo) p.validTo = r.validTo;
    else p.validTo ??= r.validTo;
  };

  // What the register itself says about each certificate at its authority,
  // for reading the cancelled list against.
  const inRegister = new Map<string, HrCertificate>();
  for (const r of rows) {
    if (r.list === "registered") inRegister.set(`${r.authority}:${hrCanonical(r.certificate.number)}`, r.certificate);
  }

  /** What a row says about its own number. */
  const ownStatus = (r: HrRow): AuthorityStatus => {
    const c = r.certificate;
    let status: AuthorityStatus = "REGISTERED";
    if (r.list === "lapsed" || c.lapsed) status = "LAPSED";
    if (c.suspended) status = stronger(status, "SUSPENDED");
    if (c.supersededBy) status = stronger(status, "REVOKED");
    if (r.list === "cancelled") {
      // The cancelled list is headed "Defaulter/Cancelled/Suspended/Abeyance"
      // and says nothing per row about which. Gone from the register is
      // cancellation, which is what the register does to a cancelled
      // project. Still there as suspended or in abeyance is that. Still
      // there with no note is a defaulter, or a register that has not caught
      // up, and neither is a definite finding.
      const held = inRegister.get(`${r.authority}:${hrCanonical(c.number)}`);
      if (!held) status = stronger(status, "REVOKED");
      else if (held.suspended) status = stronger(status, "SUSPENDED");
    }
    return status;
  };

  // First every row's own number, the register first, so a project's name
  // and dates come from the register and never from a note elsewhere.
  const ordered = [...rows].sort((a, b) => LISTS.indexOf(a.list) - LISTS.indexOf(b.list));
  for (const r of ordered) fill(identity(r.authority, r.certificate.number), r, ownStatus(r));

  // Then what the notes say about other numbers, and whose Project ID is whose.
  for (const r of ordered) {
    const c = r.certificate;
    const own = identity(r.authority, c.number);
    const noted = { ...r, certificate: { ...c, dated: undefined } };

    // The project lives on under the certificate that replaced this one.
    // When that certificate has no row of its own (reissued, and named only
    // in this cell), it takes this row's project, and its Project ID.
    const next = c.supersededBy;
    if (next && !hasRow.has(`${r.authority}:${hrCanonical(next)}`)) {
      const current = identity(r.authority, next);
      fill(current, noted, ownStatus({ ...r, certificate: { ...c, supersededBy: undefined } }), true);
      if (r.projectId) claim(r.projectId, current, false);
    } else if (r.projectId) {
      claim(r.projectId, own, !!next);
    }

    // The certificate this one replaced is no longer the registration,
    // whether or not it still has a row of its own saying so. Without one
    // it borrows this row's project, but not this row's dates.
    const prev = c.supersedes;
    if (prev) fill(identity(r.authority, prev), { ...noted, validTo: undefined, approvedFrom: undefined }, "REVOKED", true);
  }

  for (const [k, c] of claims) {
    for (const who of c.live.size ? c.live : c.replaced) who.keys.add(k);
  }

  // Keys to identities.
  const byKey = new Map<string, Identity[]>();
  for (const who of ids.values()) {
    for (const k of who.keys) {
      const list = byKey.get(k) ?? [];
      list.push(who);
      byKey.set(k, list);
    }
  }

  const register = new Map<string, PortalProject>();
  const blocked = new Map<string, PortalProject>();
  const ambiguous = new Set<string>();
  for (const [k, whos] of byKey) {
    if (whos.length === 1) {
      const p = whos[0].project;
      register.set(k, p);
      if (p.status !== "REGISTERED") blocked.set(k, p);
      continue;
    }
    ambiguous.add(k);
    // Two projects under one number. Present either way; blocked only when
    // every project it could mean is, because an unknown must not block.
    const all = whos.map((w) => w.project);
    const same = <K extends keyof PortalProject>(f: K) =>
      all.every((p) => p[f] === all[0][f]) ? all[0][f] : undefined;
    const statuses = all.map((p) => p.status);
    const status: AuthorityStatus = statuses.includes("REGISTERED")
      ? "REGISTERED"
      : statuses.reduce<AuthorityStatus>((a, b) => (RANK[a] <= RANK[b] ? a : b), statuses[0]);
    const merged: PortalProject = {
      registrationNo: all[0].registrationNo,
      status,
      projectName: same("projectName"),
      promoterName: same("promoterName"),
    };
    register.set(k, merged);
    if (status !== "REGISTERED") blocked.set(k, merged);
  }

  return { register, blocked, requests, ambiguous };
}

// ---------------------------------------------------------------------------
// Reaching the portal
// ---------------------------------------------------------------------------

function listPath(list: HrList, authority: HrAuthority): string {
  return `/admincontrol/${list}_projects/${authority}`;
}

/** The six lists, read in full, or the first reason one could not be believed. */
export async function readHr(ctx: PortalCtx): Promise<NightlyResult> {
  const rows: HrRow[] = [];
  let requests = 0;
  for (const authority of ["2", "1"] as HrAuthority[]) {
    for (const list of LISTS) {
      const path = listPath(list, authority);
      const res = await portalRequest(
        STATE,
        {
          name: `${list}_projects_${authority}.html`,
          url: `${BASE}${path}`,
          // The registers are 2.5 MB each from a slow server.
          timeoutMs: list === "registered" ? 120_000 : 60_000,
        },
        ctx,
      );
      requests += 1;
      if (!res.ok) return { ok: false, reason: res.reason };
      if (res.status !== 200) return { ok: false, reason: `${path} answered ${res.status}` };

      const parsed = parseHrList(res.text, list, authority);
      if (!plausible(parsed.length, HR_FLOORS[list][authority], res.fixture)) {
        return {
          ok: false,
          reason:
            `${path} (${HR_AUTHORITIES[authority].name}) parsed only ${parsed.length} rows. ` +
            "The page shape has probably changed, and believing it would " +
            (list === "registered" ? "block every registration at once." : "clear every finding on it."),
        };
      }
      rows.push(...parsed);
    }
  }
  return { ok: true, read: buildHrRead(rows, requests) };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const hrAdapter: StateAdapter = {
  state: STATE,
  keyOf: hrKey,

  async atForm(no, ctx): Promise<FormVerdict> {
    const res = await sharedRead(STATE, () => readHr(ctx), ctx);
    if (!res.ok) return { known: false, reason: res.reason };

    const key = hrKey(no);
    const ambiguous = (res.read as Partial<HrRead>).ambiguous;
    if (ambiguous?.has(key)) {
      const isProjectId = /^RERA-(GRG|PKL)-/.test(key);
      return {
        known: false,
        reason:
          `Haryana RERA lists ${no.trim()} against more than one project. ` +
          (isProjectId
            ? "Record the registration certificate number instead."
            : "Record the project's Project ID (RERA-GRG-... or RERA-PKL-...) instead."),
      };
    }
    const hit = res.read.blocked.get(key) ?? res.read.register?.get(key);
    return hit ? { known: true, found: true, project: hit } : { known: true, found: false };
  },

  nightly: (ctx) => readHr(ctx),
};
