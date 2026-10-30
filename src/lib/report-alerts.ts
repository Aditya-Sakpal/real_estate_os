import { withTenant } from "./db/index.ts";
import { adFigures } from "./ad-budget.ts";
import { realReport } from "./lead-report.ts";
import { quarterCheck, reportAlerts, type ReportAlert } from "./report-rules.ts";

/**
 * Today's two items from the reports: the quarterly check that campaigns'
 * qualified leads go on to book (`quarterCheck()`, the Reports screen's own
 * reading), and the pause the ad-health rule proposes (`adHealth()`, the
 * Published screen's own reading). Read with the functions those screens
 * use, so Today never disagrees with the screen it links to.
 *
 * Both read a lot for a page every member opens, so a tenant's answer is
 * kept for ten minutes in this process. The figures behind them move once
 * a day (the ad figures) or once a quarter.
 */

const TTL_MS = 10 * 60_000;
const kept = new Map<string, { at: number; items: ReportAlert[] }>();

/** The items, read now. The checks call this; Today calls the kept copy. */
export async function readReportAlerts(orgId: string, now = new Date()): Promise<ReportAlert[]> {
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const [report, ads] = await Promise.all([
    realReport(orgId, today),
    withTenant(orgId, (sql) => sql<{ id: string; state: string }[]>`
      SELECT id, state FROM publish_targets
      WHERE org_id = ${orgId} AND destination = 'META_AD' AND state IN ('ACTIVE', 'PAUSED')`),
  ]);
  const q = report ? quarterCheck(report.rows, today) : null;
  const rarely = q ? q.lines.filter((l) => l.verdict === "RARELY_BOOKS").length : 0;
  // Every ad of the account counts as a peer; only one still spending is worth pausing.
  const figures = ads.length ? await adFigures(orgId, ads.map((a) => a.id), now) : new Map();
  const pauses = ads.filter((a) => a.state === "ACTIVE" && figures.get(a.id)?.health.pause).length;
  return reportAlerts({ rarely, quarterLabel: q?.quarter.label ?? "", pauses });
}

/** Today's copy: read at most once every ten minutes per tenant, and never fatal. */
export async function reportAlertsFor(orgId: string): Promise<ReportAlert[]> {
  const hit = kept.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;
  const items = await readReportAlerts(orgId).catch(() => hit?.items ?? []);
  kept.set(orgId, { at: Date.now(), items });
  return items;
}

/** For the checks: forget what was kept. */
export function forgetReportAlerts(): void {
  kept.clear();
}
