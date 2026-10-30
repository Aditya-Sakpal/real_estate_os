import { withTenant, audit } from "./db/index.ts";
import { childPath } from "./scope.ts";
import { LINKED_REFUSAL, linkedPhases, linkedTo } from "./linked.ts";
import { entitySlug } from "./entity-rules.ts";
import { validateProjectName } from "./project-rules.ts";
import {
  blanketExtension,
  evaluateExemption,
  exemptionExpiry,
  promoterMatches,
  registrationKey,
  stateRule,
  validateRegistrationNumber,
  type ReraStatus,
} from "./rera-rules.ts";
import { lookupAtForm } from "./rera-states.ts";
import { fillFromPortal, type LookupAnswer } from "./rera-lookup-rules.ts";
import { registrationElsewhere } from "./project-life-rules.ts";
import type { AuthorityStatus } from "./rera-portal.ts";

/**
 * Phases, and the registration record that hangs off each one.
 *
 * Imports are relative so `check:rera` can record a registration in its own
 * process, with each state's portal pointed at captured pages.
 *
 * Registration is per PHASE because under the explanation to Section 3 each
 * phase is a standalone registration. Exemption is per PROJECT because
 * Section 3(2)(a) measures across all phases, which is what stops a promoter
 * slicing a project into small phases to stay under the threshold.
 *
 * A registration is recorded by a named compliance officer, and the state's
 * portal is asked about the number while they wait (`rera-states.ts`). What
 * the portal says can refuse the record; what it cannot say (a state with
 * no adapter, a portal that is down) leaves it recorded and marked Attested,
 * with `last_checked_at` NULL, because nothing checked it.
 */

export type Phase = {
  id: string;
  name: string;
  path: string;
  projectId: string;
  projectName: string;
  entityLegalName: string;
  status: ReraStatus;
  registrationNo: string | null;
  stateCode: string | null;
  promoterName: string | null;
  validTo: string | null;
  /** A later date from an authority's order or a recorded extension. */
  extendedUntil: string | null;
  extensionRef: string | null;
  permitNo: string | null;
  lastCheckedAt: string | null;
  resolutionReason: string | null;
};

export type Exemption = {
  projectId: string;
  landAreaSqm: number;
  apartmentCount: number;
  stateCode: string;
  attestedAt: string;
  expiresAt: string;
  attestedByName: string | null;
};

export type Outcome =
  | { ok: true; id: string; message?: string }
  | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listPhases(orgId: string, projectId?: string): Promise<Phase[]> {
  const own = await ownPhases(orgId, projectId);
  // A channel partner's linked tower shows the developer's own record of it.
  const linked = await linkedPhases(orgId);
  for (const [source, list] of linked) {
    const theirs = new Map((await ownPhases(source)).map((p) => [p.id, p]));
    for (const l of list) {
      const i = own.findIndex((p) => p.id === l.phaseId);
      const t = theirs.get(l.sourcePhaseId);
      if (i < 0 || !t) continue;
      own[i] = {
        ...own[i],
        status: t.status,
        registrationNo: t.registrationNo,
        stateCode: t.stateCode,
        promoterName: t.promoterName,
        validTo: t.validTo,
        extendedUntil: t.extendedUntil,
        extensionRef: t.extensionRef,
        permitNo: t.permitNo,
        lastCheckedAt: t.lastCheckedAt,
        resolutionReason: t.resolutionReason,
      };
    }
  }
  return own;
}

async function ownPhases(orgId: string, projectId?: string): Promise<Phase[]> {
  return withTenant(orgId, async (sql) => {
    const rows = await sql<
      {
        id: string;
        name: string;
        path: string;
        project_id: string;
        project_name: string;
        entity_name: string;
        status: ReraStatus | null;
        registration_no: string | null;
        state_code: string | null;
        promoter_name: string | null;
        valid_to: Date | null;
        extended_until: Date | null;
        extension_ref: string | null;
        permit_no: string | null;
        last_checked_at: Date | null;
        resolution_reason: string | null;
      }[]
    >`
      SELECT ph.id, ph.name, ph.path::text AS path,
             p.id AS project_id, p.name AS project_name,
             entity.name AS entity_name,
             r.status, r.registration_no, r.state_code, r.promoter_name,
             r.valid_to, r.extended_until, r.extension_ref, r.permit_no,
             r.last_checked_at, r.resolution_reason
      FROM scope_nodes ph
      JOIN scope_nodes p      ON p.id = ph.parent_id
      JOIN scope_nodes region ON region.id = p.parent_id
      JOIN scope_nodes entity ON entity.id = region.parent_id
      LEFT JOIN registration_records r ON r.scope_node_id = ph.id
      WHERE ph.org_id = ${orgId} AND ph.kind = 'PHASE'
        ${projectId ? sql`AND p.id = ${projectId}` : sql``}
      ORDER BY p.name, ph.name
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      projectId: r.project_id,
      projectName: r.project_name,
      entityLegalName: r.entity_name,
      // A phase with no record at all is BLOCKED, same as one that failed a
      // lookup. There is no third answer for "we have not asked yet".
      status: r.status ?? "BLOCKED",
      registrationNo: r.registration_no,
      stateCode: r.state_code,
      promoterName: r.promoter_name,
      validTo: r.valid_to ? r.valid_to.toISOString() : null,
      extendedUntil: r.extended_until ? r.extended_until.toISOString() : null,
      extensionRef: r.extension_ref,
      permitNo: r.permit_no,
      lastCheckedAt: r.last_checked_at ? r.last_checked_at.toISOString() : null,
      resolutionReason: r.resolution_reason,
    }));
  });
}

export async function getExemption(
  orgId: string,
  projectId: string,
): Promise<Exemption | null> {
  return withTenant(orgId, async (sql) => {
    const [row] = await sql<
      {
        land_area_sqm: string;
        apartment_count: number;
        state_code: string;
        attested_at: Date;
        expires_at: Date;
        attested_by_name: string | null;
      }[]
    >`
      SELECT e.land_area_sqm, e.apartment_count, e.state_code,
             e.attested_at, e.expires_at, u.name AS attested_by_name
      FROM project_exemptions e
      LEFT JOIN users u ON u.id = e.attested_by
      WHERE e.org_id = ${orgId} AND e.scope_node_id = ${projectId}
    `;
    if (!row) return null;
    return {
      projectId,
      landAreaSqm: Number(row.land_area_sqm),
      apartmentCount: row.apartment_count,
      stateCode: row.state_code,
      attestedAt: row.attested_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      attestedByName: row.attested_by_name,
    };
  });
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export async function createPhase(opts: {
  orgId: string;
  actorUserId: string;
  projectId: string;
  name: string;
}): Promise<Outcome> {
  // A channel partner's linked project or tower is the developer's to say.
  const linked = await linkedTo(opts.orgId, opts.projectId);
  if (linked) return { ok: false, code: "LINKED", message: LINKED_REFUSAL(linked.developer) };
  const parsed = validateProjectName(opts.name);
  if (!parsed.ok) return parsed;
  const name = parsed.name;

  const result = await withTenant(opts.orgId, async (sql) => {
    const [project] = await sql<{ id: string; path: string; name: string }[]>`
      SELECT id, path::text AS path, name FROM scope_nodes
      WHERE org_id = ${opts.orgId} AND id = ${opts.projectId} AND kind = 'PROJECT'
      LIMIT 1
    `;
    if (!project) {
      return { ok: false as const, code: "PROJECT_UNKNOWN", message: "Pick the project this phase belongs to." };
    }

    const siblings = await sql<{ slug: string; name: string }[]>`
      SELECT slug, name FROM scope_nodes
      WHERE org_id = ${opts.orgId} AND parent_id = ${project.id}
    `;
    if (siblings.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      return {
        ok: false as const,
        code: "DUPLICATE_NAME",
        message: `${project.name} already has a phase called ${name}.`,
      };
    }

    const slug = entitySlug(name, new Set(siblings.map((s) => s.slug)));
    const path = childPath(project.path, slug);

    const [node] = await sql<{ id: string }[]>`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${opts.orgId}, ${project.id}, 'PHASE', ${name}, ${slug}, ${path}::ltree)
      RETURNING id
    `;

    // Every phase starts BLOCKED, explicitly. An absent row and a failed
    // lookup mean the same thing, and writing it down makes the state visible
    // rather than inferred.
    await sql`
      INSERT INTO registration_records (scope_node_id, org_id, status)
      VALUES (${node.id}, ${opts.orgId}, 'BLOCKED')
    `;

    return { ok: true as const, id: node.id, path, name, projectName: project.name };
  }).catch((e: { code?: string }) =>
    e?.code === "23505"
      ? { ok: false as const, code: "DUPLICATE", message: "That phase already exists." }
      : { ok: false as const, code: "WRITE_FAILED", message: "Could not create that phase." },
  );

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "scope_node.created",
      targetType: "scope_node",
      targetId: result.id,
      metadata: { kind: "PHASE", path: result.path, name: result.name, project: result.projectName },
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** The authority's word for a registration it will not stand behind. */
function refusalFor(status: AuthorityStatus, authority: string, no: string): string {
  switch (status) {
    case "LAPSED":
      return `${authority} lists ${no} as lapsed. Record it again once the authority shows the extension.`;
    case "SUSPENDED":
      return `${authority} shows ${no} as suspended, so this phase cannot be advertised on it.`;
    case "WITHDRAWN":
      return `${authority} shows ${no} as withdrawn, which means the registration has been cancelled. This phase cannot be advertised on it.`;
    default:
      return `${authority} shows ${no} as revoked, which means the registration has been cancelled. This phase cannot be advertised on it.`;
  }
}

/**
 * Read a registration back from the state's portal, to fill the form. Asks
 * nothing that recording does not ask again, and writes nothing.
 */
export async function lookupRegistration(opts: {
  orgId: string;
  phaseId: string;
  stateCode: string;
  registrationNo: string;
  fetchImpl?: typeof fetch;
}): Promise<LookupAnswer> {
  const linked = await linkedTo(opts.orgId, opts.phaseId);
  if (linked) return { ok: false, message: LINKED_REFUSAL(linked.developer) };
  const state = opts.stateCode.trim().toUpperCase();
  const rule = stateRule(state);
  if (!rule) return { ok: false, message: "Pick the state that registered it." };
  const number = validateRegistrationNumber(state, opts.registrationNo);
  if (!number.ok) return { ok: false, message: number.message };
  const [phase] = await withTenant(opts.orgId, (sql) => sql<{ entity_name: string }[]>`
    SELECT entity.name AS entity_name
    FROM scope_nodes ph
    JOIN scope_nodes p      ON p.id = ph.parent_id
    JOIN scope_nodes region ON region.id = p.parent_id
    JOIN scope_nodes entity ON entity.id = region.parent_id
    WHERE ph.org_id = ${opts.orgId} AND ph.id = ${opts.phaseId} AND ph.kind = 'PHASE'`);
  if (!phase) return { ok: false, message: "Pick the phase first." };
  const verdict = await lookupAtForm(state, number.value, { fetchImpl: opts.fetchImpl });
  return fillFromPortal({ verdict, authority: rule.authority, number: number.value, entityName: phase.entity_name, sameName: promoterMatches });
}

export async function recordRegistration(opts: {
  orgId: string;
  actorUserId: string;
  phaseId: string;
  stateCode: string;
  registrationNo: string;
  promoterName: string;
  validTo: string;
  reason: string;
  /** The day the authority registered it, from the certificate. Optional. */
  registeredOn?: string | null;
  /** Telangana's local authority building permit number. */
  permitNo?: string | null;
  /** Injected by the checks, so a test never calls a government website. */
  fetchImpl?: typeof fetch;
}): Promise<Outcome> {
  // A channel partner's linked project or tower is the developer's to say.
  const linked = await linkedTo(opts.orgId, opts.phaseId);
  if (linked) return { ok: false, code: "LINKED", message: LINKED_REFUSAL(linked.developer) };
  const state = opts.stateCode.trim().toUpperCase();
  const rule = stateRule(state);
  if (!rule) return { ok: false, code: "STATE_UNKNOWN", message: "Pick the state that registered it." };

  const number = validateRegistrationNumber(state, opts.registrationNo);
  if (!number.ok) return { ok: false, code: "NUMBER_INVALID", message: number.message };

  const validTo = new Date(opts.validTo);
  if (Number.isNaN(validTo.getTime())) {
    return { ok: false, code: "DATE_INVALID", message: "Enter the date the registration runs to." };
  }

  let typedRegisteredOn: string | null = null;
  if (opts.registeredOn && String(opts.registeredOn).trim()) {
    const d = new Date(String(opts.registeredOn));
    if (Number.isNaN(d.getTime())) {
      return { ok: false, code: "DATE_INVALID", message: "Enter the date it was registered on." };
    }
    if (d.getTime() > Date.now() || d.getTime() >= validTo.getTime()) {
      return {
        ok: false,
        code: "DATE_INVALID",
        message: "The registration date has to be in the past and before the date it runs to.",
      };
    }
    typedRegisteredOn = d.toISOString().slice(0, 10);
  }

  const permit = String(opts.permitNo ?? "").trim().replace(/\s+/g, " ").toUpperCase() || null;
  if (permit && (permit.length < 3 || permit.length > 80)) {
    return { ok: false, code: "PERMIT_INVALID", message: "Enter the building permit number as printed on the permit." };
  }

  const reason = opts.reason.trim().replace(/\s+/g, " ");
  if (reason.length < 8) {
    return {
      ok: false,
      code: "REASON_REQUIRED",
      message: "Say what you checked, in a few words.",
    };
  }

  const promoter = opts.promoterName.trim().replace(/\s+/g, " ");

  // The same registration in another company here. A firm works a project
  // the developer already runs through a mandate or an empanelment, never as
  // a copy of it. Asked before the portal, which costs a request.
  const elsewhere = await withTenant(opts.orgId, async (sql) => {
    const [org] = await sql<{ type: string }[]>`SELECT type FROM orgs WHERE id = ${opts.orgId}`;
    const holders = await sql<{ holder_name: string; holder_kind: string }[]>`
      SELECT holder_name, holder_kind FROM registration_held_elsewhere(${opts.orgId}, ${state}, ${number.value})`;
    return registrationElsewhere(org?.type ?? "DEVELOPER", holders.map((h) => ({ name: h.holder_name, kind: h.holder_kind })));
  });
  if (!elsewhere.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "rera.held_elsewhere",
      targetType: "scope_node",
      targetId: opts.phaseId,
      metadata: { code: elsewhere.code, state },
    });
    return { ok: false, code: elsewhere.code, message: elsewhere.message };
  }

  // Ask the authority about this number, now, while the person is here.
  //
  // This is what a fabricated certificate turns on. The format check only
  // proves the number is shaped like a registration; expiry is caught by
  // arithmetic; the nightly lists catch a registration taken away. None of
  // them catch a number that was simply made up, because a number that was
  // never issued is absent from a revocation list for exactly the same
  // reason a clean one is. Only asking the authority does.
  //
  // Four outcomes. Not found, and found but revoked, suspended, withdrawn or
  // lapsed, refuse, and say which, because "this was cancelled" and "this
  // never existed" are different conversations to have with a client. Found
  // and live accepts and stamps last_checked_at, because a machine genuinely
  // looked. Could not tell (a state with no adapter, a portal that is down,
  // a page we do not recognise) accepts and stamps nothing: an unreachable
  // authority must never stop a lawful registration being recorded, and an
  // empty column is what keeps the record honestly marked Attested.
  let checkedAt: Date | null = null;
  let authorityProject: string | null = null;
  let authorityPromoter: string | null = null;
  let authorityValidTo: string | null = null;
  let authorityRegisteredOn: string | null = null;
  let portalRef: string | null = null;
  let portalNote: string | null = null;

  const verdict = await lookupAtForm(state, number.value, { fetchImpl: opts.fetchImpl });
  if (verdict.known && !verdict.found) {
    return {
      ok: false,
      code: "NOT_REGISTERED",
      message: `${rule.authority} has no project under ${number.value}, registered or revoked. Check the number on the certificate, character for character.`,
    };
  }
  if (verdict.known && verdict.found && verdict.project.status !== "REGISTERED") {
    return {
      ok: false,
      code: verdict.project.status === "LAPSED" ? "REGISTRATION_LAPSED" : "REGISTRATION_REVOKED",
      message: refusalFor(verdict.project.status, rule.authority, number.value),
    };
  }
  if (verdict.known && verdict.found) {
    checkedAt = new Date();
    authorityProject = verdict.project.projectName ?? null;
    authorityPromoter = verdict.project.promoterName || null;
    authorityValidTo = verdict.project.validTo ?? null;
    authorityRegisteredOn = verdict.project.registeredOn ?? null;
    portalRef = verdict.project.portalRef ?? null;
  } else if (!verdict.known) {
    portalNote = verdict.reason;
  }

  const registeredOn = authorityRegisteredOn ?? typedRegisteredOn;

  const result = await withTenant(opts.orgId, async (sql) => {
    const [phase] = await sql<
      { id: string; name: string; entity_name: string; prev_no: string | null; prev_state: string | null; prev_at: Date | null }[]
    >`
      SELECT ph.id, ph.name, entity.name AS entity_name,
             r.registration_no AS prev_no, r.state_code AS prev_state, r.verified_at AS prev_at
      FROM scope_nodes ph
      JOIN scope_nodes p      ON p.id = ph.parent_id
      JOIN scope_nodes region ON region.id = p.parent_id
      JOIN scope_nodes entity ON entity.id = region.parent_id
      LEFT JOIN registration_records r ON r.scope_node_id = ph.id
      WHERE ph.org_id = ${opts.orgId} AND ph.id = ${opts.phaseId} AND ph.kind = 'PHASE'
    `;
    if (!phase) {
      return { ok: false as const, code: "PHASE_UNKNOWN", message: "That phase does not exist." };
    }

    // The promoter must be the entity that will be held to the filing. This
    // is the check the entity form's "registered legal name" insistence
    // exists to serve.
    //
    // Two versions of it, and they are not the same strength. What the
    // officer typed proves only that the form is internally consistent. What
    // the authority returned is the real check, and it is the one that
    // catches a genuine registration number belonging to a different
    // developer. Both run, because where the portal gives no promoter only
    // the first is available.
    if (!promoterMatches(promoter, phase.entity_name)) {
      return {
        ok: false as const,
        code: "PROMOTER_MISMATCH",
        message: `The portal shows "${promoter}" but this phase registers under "${phase.entity_name}". Fix the entity's legal name, or check you have the right registration.`,
      };
    }
    if (authorityPromoter && !promoterMatches(authorityPromoter, phase.entity_name)) {
      return {
        ok: false as const,
        code: "PROMOTER_NOT_YOURS",
        message: `${rule.authority} registered ${number.value} to "${authorityPromoter}", not "${phase.entity_name}". That registration belongs to another promoter.`,
      };
    }

    // An authority's own order may have extended every registration at
    // once. Recorded before its cut-off proves registered before it, so a
    // number already on this phase keeps the day it was first recorded.
    const same =
      phase.prev_no &&
      phase.prev_state === state &&
      registrationKey(state, phase.prev_no) === registrationKey(state, number.value);
    const ext = blanketExtension({
      stateCode: state,
      validTo,
      registeredOn,
      recordedAt: same && phase.prev_at ? phase.prev_at : new Date(),
    });

    await sql`
      INSERT INTO registration_records (scope_node_id, org_id, status, registration_no,
                                        state_code, promoter_name, valid_to,
                                        registered_on, extended_until, extension_ref,
                                        portal_ref, permit_no,
                                        verified_at, resolved_by, resolution_reason,
                                        last_checked_at, updated_at)
      VALUES (${opts.phaseId}, ${opts.orgId}, 'VERIFIED', ${number.value},
              ${state}, ${promoter}, ${validTo},
              ${registeredOn}, ${ext?.until ?? null}, ${ext?.ref ?? null},
              ${portalRef}, ${permit},
              now(), ${opts.actorUserId}, ${reason}, ${checkedAt}, now())
      ON CONFLICT (scope_node_id) DO UPDATE
        SET status = 'VERIFIED', registration_no = EXCLUDED.registration_no,
            state_code = EXCLUDED.state_code, promoter_name = EXCLUDED.promoter_name,
            valid_to = EXCLUDED.valid_to, registered_on = EXCLUDED.registered_on,
            extended_until = EXCLUDED.extended_until, extension_ref = EXCLUDED.extension_ref,
            portal_ref = EXCLUDED.portal_ref, permit_no = EXCLUDED.permit_no,
            verified_at = CASE
              WHEN registration_records.registration_no = EXCLUDED.registration_no
                AND registration_records.verified_at IS NOT NULL
              THEN registration_records.verified_at ELSE now() END,
            resolved_by = EXCLUDED.resolved_by,
            resolution_reason = EXCLUDED.resolution_reason,
            last_checked_at = EXCLUDED.last_checked_at, updated_at = now()
    `;
    return { ok: true as const, id: opts.phaseId, phaseName: phase.name, extension: ext };
  }).catch((e: { code?: string }) =>
    e?.code === "23505"
      ? {
          ok: false as const,
          code: "NUMBER_TAKEN",
          message: "That registration number is already recorded against another phase.",
        }
      : { ok: false as const, code: "WRITE_FAILED", message: "Could not record that." },
  );

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "rera.verified",
      targetType: "scope_node",
      targetId: opts.phaseId,
      metadata: {
        registration_no: number.value,
        state,
        valid_to: opts.validTo,
        registered_on: registeredOn,
        extended_until: result.extension?.until ?? null,
        extension_ref: result.extension?.ref ?? null,
        // A human said so, and the log says who and why.
        resolution: "manual",
        reason,
        // What the authority itself said at the moment of recording.
        register_checked: checkedAt !== null,
        register_project: authorityProject,
        register_promoter: authorityPromoter,
        register_valid_to: authorityValidTo,
        register_unavailable: portalNote,
      },
    });
  }
  return result.ok ? { ok: true, id: result.id } : result;
}

// ---------------------------------------------------------------------------
// Exemption
// ---------------------------------------------------------------------------

export async function attestExemption(opts: {
  orgId: string;
  actorUserId: string;
  projectId: string;
  stateCode: string;
  landAreaSqm: number;
  apartmentCount: number;
}): Promise<Outcome> {
  // A channel partner's linked project or tower is the developer's to say.
  const linked = await linkedTo(opts.orgId, opts.projectId);
  if (linked) return { ok: false, code: "LINKED", message: LINKED_REFUSAL(linked.developer) };
  if (!Number.isFinite(opts.landAreaSqm) || opts.landAreaSqm < 0) {
    return { ok: false, code: "AREA_INVALID", message: "Enter the land area in square metres." };
  }
  if (!Number.isInteger(opts.apartmentCount) || opts.apartmentCount < 0) {
    return { ok: false, code: "UNITS_INVALID", message: "Enter the number of apartments." };
  }

  const verdict = evaluateExemption({
    stateCode: opts.stateCode,
    landAreaSqm: opts.landAreaSqm,
    apartmentCount: opts.apartmentCount,
  });
  if (!verdict.exempt) {
    return { ok: false, code: "OVER_THRESHOLD", message: verdict.reason };
  }

  const attestedAt = new Date();
  const expiresAt = exemptionExpiry(attestedAt);

  const result = await withTenant(opts.orgId, async (sql) => {
    const [project] = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM scope_nodes
      WHERE org_id = ${opts.orgId} AND id = ${opts.projectId} AND kind = 'PROJECT'
    `;
    if (!project) {
      return { ok: false as const, code: "PROJECT_UNKNOWN", message: "That project does not exist." };
    }

    await sql`
      INSERT INTO project_exemptions (scope_node_id, org_id, land_area_sqm,
                                      apartment_count, state_code, attested_by,
                                      attested_at, expires_at)
      VALUES (${opts.projectId}, ${opts.orgId}, ${opts.landAreaSqm},
              ${opts.apartmentCount}, ${opts.stateCode.toUpperCase()},
              ${opts.actorUserId}, ${attestedAt}, ${expiresAt})
      ON CONFLICT (scope_node_id) DO UPDATE
        SET land_area_sqm = EXCLUDED.land_area_sqm,
            apartment_count = EXCLUDED.apartment_count,
            state_code = EXCLUDED.state_code,
            attested_by = EXCLUDED.attested_by,
            attested_at = EXCLUDED.attested_at,
            expires_at = EXCLUDED.expires_at
    `;

    // Inherited by every phase beneath it, in the same transaction. An
    // exemption that left its phases BLOCKED would be an exemption nobody
    // could act on.
    await sql`
      UPDATE registration_records r
      SET status = 'EXEMPT', updated_at = now(),
          resolved_by = ${opts.actorUserId},
          resolution_reason = ${verdict.reason}
      FROM scope_nodes ph
      WHERE ph.id = r.scope_node_id
        AND ph.org_id = ${opts.orgId}
        AND ph.parent_id = ${opts.projectId}
        AND r.status <> 'VERIFIED'
    `;

    return { ok: true as const, id: opts.projectId, projectName: project.name };
  }).catch(() => ({
    ok: false as const,
    code: "WRITE_FAILED",
    message: "Could not record that exemption.",
  }));

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "rera.exempted",
      targetType: "scope_node",
      targetId: opts.projectId,
      metadata: {
        state: opts.stateCode.toUpperCase(),
        land_area_sqm: opts.landAreaSqm,
        apartment_count: opts.apartmentCount,
        expires_at: expiresAt.toISOString(),
        reason: verdict.reason,
      },
    });
  }
  return result;
}
