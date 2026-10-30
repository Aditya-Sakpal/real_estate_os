// Relative, for the reason `publish-gate.ts` states: the checks load this
// straight from source, outside Next, where the @/ alias does not resolve.
import { withTenant } from "./db/index.ts";
import { complianceSummary } from "./publish-gate.ts";
import { linkedPhases } from "./linked.ts";
import { readinessFor, type GateFacts, type Readiness } from "./readiness-rules.ts";

/**
 * The six gates, answered for every phase in the tenant, in one pass.
 *
 * Set-based on purpose. The obvious way to write this is to call
 * `resolveBrand()`, `approvedUnits()` and `approvedAssets()` per phase, which
 * is four round trips a tower and about forty on the screen this feeds. Those
 * functions exist for a page that is already looking at one node; this one
 * answers the whole organisation, so it asks the whole organisation.
 *
 * Every read goes through `withTenant()`, so RLS scopes all of it.
 */

export type PhaseReadiness = {
  phaseId: string;
  phaseName: string;
  projectId: string;
  projectName: string;
  path: string;
  /** Null on an exemption, which registers nothing. */
  registrationNo: string | null;
  /** Days until the registration or exemption runs out. Null when blocked. */
  daysLeft: number | null;
  /** Why the RERA gate refuses, when it does. Empty otherwise. */
  why: string;
} & Readiness;

type FactRow = {
  phase_id: string;
  brain_published: number | null;
  brain_draft: number | null;
  brain_inherited: boolean;
  brand_phone: string | null;
  brand_email: string | null;
  brand_disclaimer: string | null;
  brand_logo: boolean;
  approved_units: number;
  approved_assets: number;
  ready_briefs: number;
};

/**
 * Brand resolution walks upward and the deepest node wins, which is the rule
 * `brand-rules.ts` states and the rule this has to match. A field set at the
 * organisation and overridden at an entity resolves per field, so each of the
 * three is picked separately rather than taking one winning row wholesale.
 */
export async function loadReadiness(orgId: string): Promise<PhaseReadiness[]> {
  // Side by side rather than one then the other: every console page waits on
  // this, and the facts query costs next to nothing on a tenant with no phase.
  const [compliance, rows] = await Promise.all([
    complianceSummary(orgId),
    factRows(orgId),
  ]);
  if (compliance.phases.length === 0) return [];

  const byPhase = new Map(rows.map((r) => [r.phase_id, r]));
  // A channel partner's linked tower is facts-signed, priced and pictured
  // when the developer's own tower is; its brand and briefs are its own.
  const linked = await linkedPhases(orgId);
  for (const [source, list] of linked) {
    const theirs = new Map((await factRows(source)).map((r) => [r.phase_id, r]));
    for (const l of list) {
      const mine = byPhase.get(l.phaseId);
      const t = theirs.get(l.sourcePhaseId);
      if (!mine || !t) continue;
      byPhase.set(l.phaseId, {
        ...mine,
        brain_published: t.brain_published,
        brain_draft: null,
        brain_inherited: t.brain_inherited,
        approved_units: t.approved_units,
        approved_assets: t.approved_assets + mine.approved_assets,
      });
    }
  }

  return compliance.phases.map((p) => {
    const r = byPhase.get(p.phaseId);
    const facts: GateFacts = {
      advertisable: p.ok,
      brainPublished: r?.brain_published ?? null,
      brainDraft: r?.brain_draft ?? null,
      exempt: p.status === "EXEMPT",
      brainInherited: r?.brain_inherited ?? false,
      brandGaps: brandGapCount(r),
      approvedUnits: r?.approved_units ?? 0,
      approvedAssets: r?.approved_assets ?? 0,
      readyBriefs: r?.ready_briefs ?? 0,
    };
    return {
      phaseId: p.phaseId,
      phaseName: p.phaseName,
      projectId: p.projectId,
      projectName: p.projectName,
      path: p.path,
      registrationNo: p.registrationNo,
      daysLeft: p.daysLeft,
      why: p.ok ? "" : p.why,
      ...readinessFor(facts, { projectId: p.projectId, phaseId: p.phaseId }),
    };
  });
}

/**
 * The same three gaps `brandGaps()` names, counted from the resolved columns.
 *
 * Counted rather than listed because this screen says how much is missing and
 * the branding screen says what. Two screens answering the same question in
 * two words is the version people trust.
 */
function brandGapCount(r: FactRow | undefined): number {
  if (!r) return 3;
  let gaps = 0;
  if (!r.brand_phone && !r.brand_email) gaps += 1;
  if (!r.brand_logo) gaps += 1;
  if (!r.brand_disclaimer) gaps += 1;
  return gaps;
}

/** One phase, for a screen already looking at one. */
export async function phaseReadiness(
  orgId: string,
  phaseId: string,
): Promise<PhaseReadiness | null> {
  const all = await loadReadiness(orgId);
  return all.find((p) => p.phaseId === phaseId) ?? null;
}

/** The gates' facts for every phase of one tenant, in one statement. */
async function factRows(orgId: string): Promise<FactRow[]> {
  return withTenant(orgId, async (sql) => {
        return sql<FactRow[]>`
          WITH phase AS (
            SELECT n.id, n.path, n.parent_id
            FROM scope_nodes n
            WHERE n.org_id = ${orgId} AND n.kind = 'PHASE'
          )
          SELECT
            p.id AS phase_id,

            (SELECT max(bv.version) FROM brain_versions bv
              WHERE bv.org_id = ${orgId} AND bv.scope_node_id = p.id
                AND bv.state = 'PUBLISHED')                       AS brain_published,
            (SELECT max(bv.version) FROM brain_versions bv
              WHERE bv.org_id = ${orgId} AND bv.scope_node_id = p.id
                AND bv.state = 'DRAFT')                           AS brain_draft,
            -- A live Brain strictly above the phase. Counts only for an exempt
            -- phase, which has no RERA facts of its own to sign.
            EXISTS (SELECT 1 FROM brain_versions bv
                      JOIN scope_nodes a ON a.id = bv.scope_node_id
                     WHERE bv.org_id = ${orgId} AND bv.state = 'PUBLISHED'
                       AND a.path @> p.path AND a.id <> p.id)     AS brain_inherited,

            -- Deepest ancestor that set the field, the field itself rather than
            -- the row, so an entity overriding only the phone number does not
            -- drop the disclaimer set at the organisation.
            (SELECT k.sales_phone FROM brand_kits k
               JOIN scope_nodes a ON a.id = k.scope_node_id
              WHERE k.org_id = ${orgId} AND a.path @> p.path
                AND k.sales_phone IS NOT NULL
              ORDER BY nlevel(a.path) DESC LIMIT 1)               AS brand_phone,
            (SELECT k.sales_email FROM brand_kits k
               JOIN scope_nodes a ON a.id = k.scope_node_id
              WHERE k.org_id = ${orgId} AND a.path @> p.path
                AND k.sales_email IS NOT NULL
              ORDER BY nlevel(a.path) DESC LIMIT 1)               AS brand_email,
            (SELECT k.disclaimer FROM brand_kits k
               JOIN scope_nodes a ON a.id = k.scope_node_id
              WHERE k.org_id = ${orgId} AND a.path @> p.path
                AND k.disclaimer IS NOT NULL
              ORDER BY nlevel(a.path) DESC LIMIT 1)               AS brand_disclaimer,
            EXISTS (SELECT 1 FROM brand_files f
                      JOIN scope_nodes a ON a.id = f.scope_node_id
                     WHERE f.org_id = ${orgId} AND a.path @> p.path
                       AND f.role IN ('LOGO_HORIZONTAL', 'LOGO_STACKED'))
                                                                  AS brand_logo,

            -- A configuration is pinned to a phase, so no ancestor walk here.
            -- Approved means the CURRENT numbers carry an approval, which is the
            -- rule approvedUnits() enforces and the reason the hash is joined.
            (SELECT count(*)::int FROM unit_types t
              WHERE t.org_id = ${orgId} AND t.scope_node_id = p.id
                AND EXISTS (
                  SELECT 1 FROM unit_type_approvals ap
                    JOIN unit_type_versions uv
                      ON uv.unit_type_id = ap.unit_type_id AND uv.sha256 = ap.sha256
                   WHERE ap.unit_type_id = t.id
                     AND uv.version = (SELECT max(v2.version) FROM unit_type_versions v2
                                        WHERE v2.unit_type_id = t.id)))
                                                                  AS approved_units,

            -- Assets DO walk upward: a township masterplan filed on the project
            -- is material a tower's creative may be built from.
            (SELECT count(*)::int FROM assets s
               JOIN scope_nodes a ON a.id = s.scope_node_id
              WHERE s.org_id = ${orgId} AND a.path @> p.path
                AND EXISTS (
                  SELECT 1 FROM asset_approvals ap
                    JOIN asset_versions av
                      ON av.asset_id = ap.asset_id AND av.sha256 = ap.sha256
                   WHERE ap.asset_id = s.id
                     AND av.version = (SELECT max(v2.version) FROM asset_versions v2
                                        WHERE v2.asset_id = s.id)))
                                                                  AS approved_assets,

            -- A brief hangs off a PROJECT or a PHASE, so a project brief counts
            -- for every tower under it. Anything higher carries no brief at all.
            (SELECT count(*)::int FROM campaign_briefs b
              WHERE b.org_id = ${orgId} AND b.status = 'READY'
                AND b.scope_node_id IN (p.id, p.parent_id))       AS ready_briefs

          FROM phase p
        `;
  });
}
