/**
 * Karnataka RERA (rera.karnataka.gov.in), read in bulk, at the form and at
 * night alike.
 *
 * The portal is server-rendered Java with no CAPTCHA, no login and no
 * robots.txt, and it publishes two lists that between them answer every
 * question the form and the sweep ask:
 *
 *   GET /viewAllProjects            6.4 MB   every registration number issued
 *   GET /viewAllWithdrawnProjects   210 KB   the withdrawn and revoked ones
 *
 * **Why the form reads the register rather than searching.** There is a
 * per-number search (`POST /projectViewDetails` with `regNo`), and it does
 * carry dates the register does not: approved on, the proposed completion
 * date and each extension. But the search is served by the same page as the
 * register, and every reply carries the whole 6.4 MB autocomplete script
 * above its one result row, 5 to 12 seconds a time (both lists together took
 * 3 seconds on 29 September 2026). So one search costs what the whole
 * register costs. Reading the register through the day's shared copy
 * answers the first number of the day for the price of one search, and every
 * later number (the second tower, the next client, the sweep that night) for
 * nothing. The dates are not needed for the verdict, and asking for them
 * would double the wait for a person at the form, so they are not asked for.
 * Karnataka's status column stays "APPROVED" after a registration lapses
 * anyway, so the only dates it could give are ones the client records too.
 *
 * **Why the register is complete.** The search page's autocomplete embeds
 * every application with the number it was registered under: buildings and
 * plotted layouts, ongoing and completed (all 3,533 of the "applied for
 * completion" list are in it), third-party transfers (`TOR/PRM/...`, which
 * sit beside the original `PRM/...` number, both listed), and the withdrawn
 * and revoked ones (every numbered row of that list is in it). On 28
 * September 2026 it held 8,982 registration numbers; taking out the 39
 * transfers and the 62 withdrawn or revoked ones leaves 8,881, against 8,880
 * on the portal's own "Approved" tab. Absence from it is therefore the
 * finding "never issued".
 *
 * **Why presence is not enough.** A withdrawn or revoked number stays in the
 * register, so the withdrawn list is read beside it and its status wins. That
 * list is the authority's own statement (107 rows, 6 revoked and 101
 * withdrawn, on 28 September 2026); rows withdrawn before a number was ever
 * issued carry none and are skipped.
 *
 * The register carries no project id, only the application's acknowledgement
 * number, so `portalRef` is left empty rather than filled with something
 * that is not the authority's project id.
 *
 * Imports are relative so the nightly job can load this straight from
 * source, outside Next.
 */

import {
  fixtureName,
  htmlText,
  plausible,
  portalRequest,
  sharedRead,
  type AuthorityStatus,
  type FormVerdict,
  type NightlyResult,
  type PortalCtx,
  type PortalProject,
  type StateAdapter,
} from "./rera-portal.ts";
import { registrationKey } from "./rera-rules.ts";

const STATE = "KA";
const BASE = "https://rera.karnataka.gov.in";

/** Each read, with the fixture file it is answered from under the dev seam. */
export const KA_SOURCES = {
  register: { name: fixtureName("viewAllProjects.html"), url: `${BASE}/viewAllProjects` },
  withdrawn: { name: fixtureName("viewAllWithdrawnProjects.html"), url: `${BASE}/viewAllWithdrawnProjects` },
} as const;

/**
 * 8,982 numbers on 28 September 2026, and the register only grows. A parse
 * that returns fewer than this is a changed page, and believing it would
 * block every Karnataka registration it lost.
 */
export const KA_REGISTER_FLOOR = 2_000;

/**
 * 107 rows on 28 September 2026. Rows are counted only when their status is
 * one we recognise, so a page whose wording changed is refused rather than
 * read as a list with nothing withdrawn, which would clear every revocation.
 */
export const KA_WITHDRAWN_FLOOR = 20;

const keyOf = (no: string): string => registrationKey(STATE, no);

/** A value out of a single-quoted JavaScript string: escapes, then entities. */
function jsValue(raw: string | undefined): string {
  return htmlText(String(raw ?? "").replace(/\\(.)/g, "$1"));
}

/**
 * The register, out of the search page's autocomplete script.
 *
 *   var localObj = { appNo : 'ACK/KA/RERA/1251/308/PR/160926/010597' };
 *   ...
 *     applicationNameList  .push('ACK/KA/RERA/1251/308/PR/160926/010597');
 *     applicationNameList2 .push('PRM/KA/RERA/1251/308/PR/250926/008969');
 *     applicationNameList3 .push('SPLENDID EVORA');
 *     applicationNameList4 .push('SPLENDID PROPERTIES');
 *
 * One block per application. The four lists feed the four search boxes
 * (application number, registration number, project, promoter), which is
 * what names them, so each block is read by list name and not by the order
 * of its lines. An application never registered pushes an empty number, or
 * (twice on 28 September 2026) its own application number, and is skipped.
 * The page writes an apostrophe as `&#039;` and an ampersand as `&amp;`
 * inside the script, so the values are decoded as HTML too.
 */
export function parseKaRegister(html: string): PortalProject[] {
  const out: PortalProject[] = [];
  for (const block of html.split(/var\s+localObj\s*=/).slice(1)) {
    const lists = new Map<string, string>();
    for (const m of block.matchAll(/\b(applicationNameList\d*)\s*\.push\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) {
      if (!lists.has(m[1])) lists.set(m[1], m[2]);
    }
    const registrationNo = jsValue(lists.get("applicationNameList2"));
    if (!registrationNo) continue;
    // Two applications carry their acknowledgement number in the
    // registration slot. The portal's own search calls one of them rejected:
    // an application number is not a registration.
    if (registrationNo === jsValue(lists.get("applicationNameList"))) continue;
    const projectName = jsValue(lists.get("applicationNameList3"));
    const promoterName = jsValue(lists.get("applicationNameList4"));
    out.push({
      registrationNo,
      projectName: projectName || undefined,
      promoterName: promoterName || undefined,
      status: "REGISTERED",
    });
  }
  return out;
}

/**
 * The authority's word for a withdrawn-list row. Null for anything else: a
 * word we do not recognise is not a finding, and it is not counted either.
 */
export function kaStatus(raw: string): AuthorityStatus | null {
  const s = raw.toUpperCase();
  if (/REVOK|CANCEL/.test(s)) return "REVOKED";
  if (/WITHDR/.test(s)) return "WITHDRAWN";
  if (/SUSPEN|ABEYANCE/.test(s)) return "SUSPENDED";
  return null;
}

/** Rows of one table, each cell as text. */
function rowsOf(table: string): string[][] {
  const out: string[][] = [];
  for (const row of table.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    out.push((row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(htmlText));
  }
  return out;
}

export type KaWithdrawnList = {
  /** Rows with a status we recognise, numbered or not: what the floor counts. */
  rows: number;
  /** The rows that carry a registration number, which are the findings. */
  projects: PortalProject[];
};

/**
 * The withdrawn and revoked list.
 *
 *   S.No | ACKNOWLEDGEMENT NO | REGISTRATION NO | PROMOTER | PROJECT |
 *   DISTRICT | TALUK | STATUS | APPLIED ON | WITHDRAWN/ REVOKED ON |
 *   REASON FOR WITHDRAWN/REVOKED | ORDER
 *
 * The table is found by its header (a registration number column and a
 * status column) and each column by its label. Null when no table on the
 * page has that header: the caller reports that as "could not tell", never
 * as an empty list.
 */
export function parseKaWithdrawn(html: string): KaWithdrawnList | null {
  for (const table of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows = rowsOf(table);
    const head = rows.find(
      (r) => r.some((c) => /^REGISTRATION\s*NO\.?$/i.test(c)) && r.some((c) => /^STATUS$/i.test(c)),
    );
    if (!head) continue;
    const col = (re: RegExp) => head.findIndex((c) => re.test(c));
    const iNo = col(/^REGISTRATION\s*NO\.?$/i);
    const iStatus = col(/^STATUS$/i);
    const iPromoter = col(/^PROMOTER/i);
    const iProject = col(/^PROJECT(\s*NAME)?$/i);

    let counted = 0;
    const projects: PortalProject[] = [];
    for (const r of rows) {
      if (r === head || r.length <= Math.max(iNo, iStatus)) continue;
      const status = kaStatus(r[iStatus] ?? "");
      if (!status) continue;
      counted++;
      const registrationNo = (r[iNo] ?? "").trim();
      if (!registrationNo) continue;
      projects.push({
        registrationNo,
        projectName: (iProject >= 0 && r[iProject]) || undefined,
        promoterName: (iPromoter >= 0 && r[iPromoter]) || undefined,
        status,
      });
    }
    return { rows: counted, projects };
  }
  return null;
}

/**
 * Both lists, read once. The raw read: the seam holds the day's copy.
 */
async function readAll(ctx: PortalCtx): Promise<NightlyResult> {
  const reg = await portalRequest(STATE, { ...KA_SOURCES.register, timeoutMs: 60_000 }, ctx);
  if (!reg.ok) return { ok: false, reason: reg.reason };
  if (reg.status !== 200) return { ok: false, reason: `viewAllProjects answered ${reg.status}` };
  const listed = parseKaRegister(reg.text);

  const wd = await portalRequest(STATE, KA_SOURCES.withdrawn, ctx);
  if (!wd.ok) return { ok: false, reason: wd.reason };
  if (wd.status !== 200) return { ok: false, reason: `viewAllWithdrawnProjects answered ${wd.status}` };
  const withdrawn = parseKaWithdrawn(wd.text);

  const fixture = reg.fixture || wd.fixture;
  if (!plausible(listed.length, KA_REGISTER_FLOOR, fixture)) {
    return {
      ok: false,
      reason: `viewAllProjects parsed to ${listed.length} registrations. The page has probably changed shape, and believing it would block every Karnataka registration it lost.`,
    };
  }
  if (!withdrawn) {
    return { ok: false, reason: "viewAllWithdrawnProjects carried no table we recognise." };
  }
  if (!plausible(withdrawn.rows, KA_WITHDRAWN_FLOOR, fixture)) {
    return {
      ok: false,
      reason: `viewAllWithdrawnProjects parsed to ${withdrawn.rows} rows. Believing it would clear every withdrawal and revocation.`,
    };
  }

  const blocked = new Map<string, PortalProject>();
  for (const p of withdrawn.projects) blocked.set(keyOf(p.registrationNo), p);

  // A withdrawn number stays in the register, so the list's status wins
  // there too, and the two maps never disagree about one number.
  const register = new Map<string, PortalProject>();
  for (const p of listed) {
    const k = keyOf(p.registrationNo);
    const b = blocked.get(k);
    register.set(k, b ? { ...p, status: b.status } : p);
  }
  // The authority issued a number it has since withdrawn, whether or not
  // the register still shows it.
  for (const [k, b] of blocked) if (!register.has(k)) register.set(k, b);

  return { ok: true, read: { register, blocked, requests: 2 } };
}

export const kaAdapter: StateAdapter = {
  state: STATE,
  keyOf,
  async atForm(no, ctx): Promise<FormVerdict> {
    const k = keyOf(no);
    if (!k) return { known: false, reason: "No registration number given." };
    const res = await sharedRead(STATE, () => readAll(ctx), ctx);
    if (!res.ok) return { known: false, reason: res.reason };
    const hit = res.read.register?.get(k) ?? res.read.blocked.get(k);
    return hit ? { known: true, found: true, project: hit } : { known: true, found: false };
  },
  nightly: (ctx) => readAll(ctx),
};
