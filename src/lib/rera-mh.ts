/**
 * MahaRERA, read the way the authority publishes it.
 *
 * The obvious design is a per-project lookup: ask the portal about each
 * registration, once a night. At a thousand clients that is roughly ten
 * thousand requests, eight hours single threaded, and enough load on one
 * government server to get the IP blocked. It also runs into the CAPTCHA on
 * the interactive search.
 *
 * None of that is necessary, because MahaRERA already publishes the answer in
 * bulk. Two plain HTML pages, no login and no CAPTCHA, list every project the
 * authority has suspended, put in abeyance or deregistered:
 *
 *   /list-projects-suspended-abeyance-deregistered
 *   /list_of_projects_deregistered
 *
 * So the nightly job fetches two pages, not ten thousand, and checks every
 * tenant's registrations against the set with one query each. It scales to a
 * million registrations without changing shape, and it reads only what the
 * regulator deliberately put in public.
 *
 * What this catches is revocation under Section 7. Expiry is already handled
 * by date arithmetic that needs no network at all. What it does NOT catch is
 * a registration number that never existed, or one belonging to someone else;
 * that needs a per-project lookup at the moment it is recorded, which is a
 * different job with a different cost.
 */

// The portal moved to www. in October 2026. The old host answers 301, and a
// POST that follows a 301 arrives as a GET with no body.
const BASE = "https://www.maharera.maharashtra.gov.in";

const LISTS = [
  { path: "/list-projects-suspended-abeyance-deregistered", status: "SUSPENDED" as const },
  { path: "/list_of_projects_deregistered", status: "DEREGISTERED" as const },
];

/**
 * A page that suddenly parses to almost nothing is a broken parser, not an
 * empty register. Treating it as empty would silently unblock every project
 * the authority has actually revoked, which is the one failure that must
 * never happen quietly.
 */
const MIN_PLAUSIBLE_ROWS = 20;

export type BlockedProject = {
  registrationNo: string;
  projectName: string;
  promoterName: string;
  status: "SUSPENDED" | "DEREGISTERED";
};

export type BlocklistResult =
  | { ok: true; entries: Map<string, BlockedProject>; sources: number }
  | { ok: false; reason: string };

const REG_NO = /^P[0-9]{11}$/;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Both pages share one table shape:
 *   Sr No | Project Name | Promoter Name | Registration No | Authority | Order
 */
export function parseList(html: string, status: BlockedProject["status"]): BlockedProject[] {
  const out: BlockedProject[] = [];

  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? []).map(stripTags);
    if (cells.length < 4) continue;

    // Find the registration number by shape rather than by column index, so a
    // column inserted upstream does not silently shift everything.
    const idx = cells.findIndex((c) => REG_NO.test(c));
    if (idx < 2) continue;

    out.push({
      registrationNo: cells[idx],
      projectName: cells[idx - 2] ?? "",
      promoterName: cells[idx - 1] ?? "",
      status,
    });
  }
  return out;
}

export async function fetchBlocklist(
  fetchImpl: typeof fetch = fetch,
): Promise<BlocklistResult> {
  const entries = new Map<string, BlockedProject>();
  let sources = 0;

  for (const list of LISTS) {
    let html: string;
    try {
      const res = await fetchImpl(`${BASE}${list.path}`, {
        headers: { "user-agent": "Sales Desk compliance check (+https://salesdesk.app)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return { ok: false, reason: `${list.path} returned ${res.status}` };
      }
      html = await res.text();
    } catch (e) {
      // The portal being down is an unknown, not a finding. The caller must
      // change nothing.
      return { ok: false, reason: `${list.path} unreachable: ${(e as Error).message}` };
    }

    const rows = parseList(html, list.status);
    if (rows.length < MIN_PLAUSIBLE_ROWS) {
      return {
        ok: false,
        reason: `${list.path} parsed only ${rows.length} rows. The page shape has probably changed, and an empty register would wrongly clear every revoked project.`,
      };
    }

    // A project on both lists is deregistered, the stronger finding, and the
    // deregistered list is fetched second so it wins.
    for (const row of rows) entries.set(row.registrationNo, row);
    sources += 1;
  }

  return { ok: true, entries, sources };
}
