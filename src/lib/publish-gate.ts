import { withTenant } from "./db/index.ts";
import { canAdvertise, effectiveValidTo } from "./rera-rules.ts";
import { linkedPhases, linksOf } from "./linked.ts";

/**
 * The publish gate.
 *
 * One function that every outbound surface must pass through before anything
 * reaches a buyer or an ad platform. Section 3 bars advertising a phase
 * before it is registered, with penalties of Rs 10,000 to Rs 50,000 per
 * advertisement and, in the aggravated case, imprisonment.
 *
 * It lives here rather than inside a campaign module because it is not a
 * campaign rule. A brochure, a portal listing, a WhatsApp broadcast and a
 * Meta ad are all advertisements, and they will all call this.
 *
 * Nothing publishes yet, so today the gate's real users are the compliance
 * chip and the dashboard queue, which is the same question asked in the
 * present tense: what could not be advertised right now.
 *
 * Imports are relative because the checks load this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

export type PhaseCompliance = {
  phaseId: string;
  phaseName: string;
  projectId: string;
  projectName: string;
  path: string;
  status: string;
  /**
   * The number on the record, and null on an exemption, which registers
   * nothing. Carried out of here because whatever advertises this phase has
   * to print the number it was actually registered under.
   */
  registrationNo: string | null;
  /**
   * The state that registered it, and so the authority whose rules an
   * advertisement for it follows. Null on a phase with no registration.
   */
  stateCode: string | null;
  /** Telangana's building permit number, printed beside the registration. */
  permitNo: string | null;
  ok: boolean;
  why: string;
  /** Days until the registration or exemption runs out. Null when blocked. */
  daysLeft: number | null;
};

export type ComplianceSummary = {
  phases: PhaseCompliance[];
  blocked: PhaseCompliance[];
  /** Verified or exempt, but running out within the window. */
  lapsingSoon: PhaseCompliance[];
  /** Projects with at least one phase that cannot be advertised. */
  blockedProjects: number;
};

/** How far ahead an expiry is worth warning about. */
export const LAPSE_WARNING_DAYS = 30;

export async function complianceSummary(
  orgId: string,
  now = new Date(),
): Promise<ComplianceSummary> {
  const rows = await withTenant(orgId, async (sql) => {
    return sql<
      {
        phase_id: string;
        phase_name: string;
        project_id: string;
        project_name: string;
        path: string;
        status: string | null;
        registration_no: string | null;
        state_code: string | null;
        permit_no: string | null;
        valid_to: Date | null;
        extended_until: Date | null;
        expires_at: Date | null;
      }[]
    >`
      SELECT ph.id AS phase_id, ph.name AS phase_name,
             p.id AS project_id, p.name AS project_name,
             ph.path::text AS path,
             r.status, r.registration_no, r.state_code, r.permit_no,
             r.valid_to, r.extended_until, e.expires_at
      FROM scope_nodes ph
      JOIN scope_nodes p ON p.id = ph.parent_id AND p.kind = 'PROJECT'
      LEFT JOIN registration_records r ON r.scope_node_id = ph.id
      LEFT JOIN project_exemptions e   ON e.scope_node_id = p.id
      WHERE ph.org_id = ${orgId} AND ph.kind = 'PHASE'
      ORDER BY p.name, ph.name
    `;
  });

  const phases: PhaseCompliance[] = rows.map((r) => {
    // A phase with no record at all is BLOCKED, the same as one that failed.
    const status = r.status ?? "BLOCKED";
    const verdict = canAdvertise(
      {
        status: status as "VERIFIED" | "EXEMPT" | "BLOCKED",
        validTo: r.valid_to,
        extendedUntil: r.extended_until,
        exemptionExpiresAt: r.expires_at,
      },
      now,
    );

    const runsOut =
      status === "VERIFIED"
        ? effectiveValidTo(r.valid_to, r.extended_until)
        : status === "EXEMPT"
          ? r.expires_at
          : null;
    const daysLeft =
      // A registration development lets past its date counts no days down,
      // or every post on it would wait as "lapsing soon".
      verdict.ok && runsOut && new Date(runsOut).getTime() > now.getTime()
        ? Math.floor((new Date(runsOut).getTime() - now.getTime()) / 86_400_000)
        : null;

    return {
      phaseId: r.phase_id,
      phaseName: r.phase_name,
      projectId: r.project_id,
      projectName: r.project_name,
      path: r.path,
      status,
      // An exempt phase prints no number, even one left on an old record.
      registrationNo: status === "EXEMPT" ? null : r.registration_no,
      stateCode: status === "EXEMPT" ? null : r.state_code,
      permitNo: status === "EXEMPT" ? null : r.permit_no,
      ok: verdict.ok,
      why: verdict.why,
      daysLeft,
    };
  });

  await throughLinks(orgId, phases, now);
  const blocked = phases.filter((p) => !p.ok);

  return {
    phases,
    blocked,
    lapsingSoon: phases.filter(
      (p) => p.ok && p.daysLeft !== null && p.daysLeft <= LAPSE_WARNING_DAYS,
    ),
    blockedProjects: new Set(blocked.map((p) => p.projectId)).size,
  };
}

export type PublishVerdict =
  | { ok: true; registrationNo: string | null; stateCode: string | null; permitNo: string | null }
  | { ok: false; code: "PHASE_UNKNOWN" | "NOT_ADVERTISABLE"; message: string };

/**
 * Ask before publishing anything that names a phase.
 *
 * Fails closed on everything: an unknown phase, a phase in another tenant, a
 * missing record. There is no path through this function that returns ok
 * without a registration or an attested exemption that is currently in date.
 *
 * A yes carries the number it said yes about. Permission to advertise and
 * the identity of what was registered are two different answers, and a
 * caller that prints a registration number needs the second one.
 */
export async function canPublish(
  orgId: string,
  phaseId: string,
  now = new Date(),
): Promise<PublishVerdict> {
  const summary = await complianceSummary(orgId, now);
  const phase = summary.phases.find((p) => p.phaseId === phaseId);

  if (!phase) {
    return {
      ok: false,
      code: "PHASE_UNKNOWN",
      message: "That phase does not exist in this organisation.",
    };
  }
  if (!phase.ok) {
    return {
      ok: false,
      code: "NOT_ADVERTISABLE",
      message: `${phase.projectName} ${phase.phaseName}: ${phase.why}`,
    };
  }
  return { ok: true, registrationNo: phase.registrationNo, stateCode: phase.stateCode, permitNo: phase.permitNo };
}

/**
 * A channel partner's tower linked to a developer's (`linked.ts`) answers
 * with the developer's own verdict on its own tower: the registration, its
 * dates and its number, read in the developer's tenant. A link whose
 * empanelment is not live is BLOCKED, whatever the developer's record says,
 * so the kill switch pauses the partner's ads the day it ends.
 */
async function throughLinks(orgId: string, phases: PhaseCompliance[], now: Date): Promise<void> {
  const links = await linksOf(orgId);
  if (!links.rows.length) return;
  const live = await linkedPhases(orgId);
  const liveIds = new Set([...live.values()].flat().map((l) => l.phaseId));
  for (const r of links.rows) {
    if (r.kind !== "PHASE" || liveIds.has(r.nodeId)) continue;
    const i = phases.findIndex((p) => p.phaseId === r.nodeId);
    if (i < 0) continue;
    const developer = links.names.get(r.sourceOrgId) ?? "the developer";
    phases[i] = { ...phases[i], status: "BLOCKED", registrationNo: null, stateCode: null, permitNo: null, ok: false, daysLeft: null,
      why: `${developer} has not empanelled you for this project today.` };
  }
  for (const [source, list] of live) {
    const theirs = await complianceSummary(source, now);
    for (const l of list) {
      const i = phases.findIndex((p) => p.phaseId === l.phaseId);
      const t = theirs.phases.find((p) => p.phaseId === l.sourcePhaseId);
      if (i < 0) continue;
      phases[i] = t
        ? { ...phases[i], status: t.status, registrationNo: t.registrationNo, stateCode: t.stateCode, permitNo: t.permitNo, ok: t.ok, why: t.why, daysLeft: t.daysLeft }
        : { ...phases[i], status: "BLOCKED", ok: false, daysLeft: null, why: "The developer no longer has this tower." };
    }
  }
}
