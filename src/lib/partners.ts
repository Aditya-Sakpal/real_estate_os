import { randomInt, randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { audit, auditHash, controlDb, withTenant } from "./db/index.ts";
import { panMatchesGstin, validateGstin, validatePan } from "./gstin.ts";
import { slugify } from "./scope.ts";
import { normalisePhone } from "./calling-rules.ts";
import { putAsset } from "./storage.ts";
import { projectOfNode } from "./storage-place.ts";
import { canPublish } from "./publish-gate.ts";
import { enquiryUrl } from "./capture.ts";
import { REVEALS_PER_DAY, maskPhone, spacedPhone } from "./mask-rules.ts";
import { notifyPayout, numberAt } from "./partner-notify.ts";
import { secondHalfDue } from "./loan-rules.ts";
import { tapText, waMeLink } from "./partner-bot-rules.ts";
import { mandateOnBooked } from "./mandates.ts";
import { onAnotherDesk, type Desk as WorkDesk } from "./grant-rules.ts";
import {
  DEFAULT_TERMS,
  DIRECT_LOOKBACK_DAYS,
  REFUSE_OF,
  STAGE_OF,
  VIA_OF,
  cleanUtr,
  extendedUntil,
  grantLive,
  grantStatus,
  istDay,
  nextStep,
  parseSteps,
  payoutFor,
  rateFor,
  refCode,
  registrationVerdict,
  termsProblem,
  firmProblem,
  applyDebits,
  bookingsCounted,
  clawbackFor,
  crossProjectAction,
  crossProjectNote,
  isCrossProject,
  isLadderPeriod,
  ladderWindow,
  manualLinkRefusal,
  LINK_LAPSED_DAYS,
  takesDirectLead,
  type CrossProject,
  type DirectWins,
  type LadderPeriod,
  type MatchedBy,
  type Booking,
  type Firm,
  type FirmInput,
  type GrantState,
  type Invoice,
  type MilestoneKey,
  type Registration,
  type Terms,
  type Verdict,
  type RejectReason,
} from "./partner-rules.ts";

/**
 * Channel partners: the reads and writes around `partner-rules.ts` (0037).
 *
 * Three rules hold everything here together.
 *
 * 1. **Nothing crosses a tenant.** A firm's org row is found or created on
 *    the control connection, because that is org creation and nothing else
 *    is. Everything a tenant knows about the firm is that tenant's own row.
 * 2. **A registration is decided inside one transaction, under a lock on the
 *    buyer's number.** Two firms registering the same buyer at the same
 *    moment resolve in the database, not in whichever request read first.
 * 3. **Money is written once, when it is owed.** A booking by a registered
 *    buyer writes its payout with the rate its place on the ladder earned,
 *    and the milestones move forward only.
 */

const DAY_MS = 86_400_000;

export const isId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);

type Sql = TransactionSql;

// ---------------------------------------------------------------------------
// Terms and settings
// ---------------------------------------------------------------------------

type TermsRow = {
  id: string;
  steps: unknown;
  pass_back_max: string;
  registration_days: number;
  visit_extends_days: number;
  ladder_period?: string | null;
  second_half?: string | null;
};

function termsOf(row: TermsRow | undefined | null): Terms {
  if (!row) return DEFAULT_TERMS;
  return {
    steps: parseSteps(row.steps) ?? DEFAULT_TERMS.steps,
    passBackMax: Number(row.pass_back_max),
    registrationDays: row.registration_days,
    visitExtendsDays: row.visit_extends_days,
    ladderPeriod: isLadderPeriod(row.ladder_period) ? row.ladder_period : "ALL",
    secondHalf: row.second_half === "COLLECTED_OR_BANK" ? "COLLECTED_OR_BANK" : "COLLECTED",
  };
}

/**
 * A project's terms row, written with the defaults the first time it is
 * needed. Terms are per desk: the developer's own for its partners, and a
 * mandate firm's for the partners it pays (`mandateId`).
 */
async function ensureTerms(sql: Sql, orgId: string, projectId: string, userId: string | null, mandateId: string | null = null): Promise<{ id: string; terms: Terms }> {
  const [row] = await sql<TermsRow[]>`
    SELECT id, steps, pass_back_max, registration_days, visit_extends_days, ladder_period, second_half
    FROM commission_terms WHERE org_id = ${orgId} AND scope_node_id = ${projectId} AND mandate_id IS NOT DISTINCT FROM ${mandateId}`;
  if (row) return { id: row.id, terms: termsOf(row) };
  const [made] = await sql<{ id: string }[]>`
    INSERT INTO commission_terms (org_id, scope_node_id, mandate_id, steps, pass_back_max, registration_days, visit_extends_days, updated_by)
    VALUES (${orgId}, ${projectId}, ${mandateId}, ${sql.json(DEFAULT_TERMS.steps as never)}, ${DEFAULT_TERMS.passBackMax},
            ${DEFAULT_TERMS.registrationDays}, ${DEFAULT_TERMS.visitExtendsDays}, ${userId})
    ON CONFLICT (org_id, scope_node_id, coalesce(mandate_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET updated_at = commission_terms.updated_at
    RETURNING id`;
  return { id: made.id, terms: DEFAULT_TERMS };
}

/** The desk a row of the partner desk belongs to: NULL is the developer's own, else the mandate paying for it. */
export async function deskOf(
  orgId: string,
  kind: "firm" | "grant" | "payout" | "milestone" | "registration" | "link" | "agent",
  id: string,
): Promise<{ mandateId: string | null } | null> {
  if (!isId(id)) return null;
  const rows = await withTenant(orgId, (sql) => {
    switch (kind) {
      case "firm":
        return sql<{ m: string | null }[]>`SELECT mandate_id AS m FROM partner_firms WHERE org_id = ${orgId} AND id = ${id}`;
      case "grant":
        return sql<{ m: string | null }[]>`SELECT mandate_id AS m FROM grants WHERE org_id = ${orgId} AND id = ${id} AND role = 'CHANNEL_PARTNER'`;
      // The developer pays a mandate firm; a partner is paid by whoever empanelled it.
      case "payout":
        return sql<{ m: string | null }[]>`
          SELECT CASE WHEN kind = 'MANDATE' THEN NULL ELSE payer_mandate_id END AS m FROM partner_payouts WHERE org_id = ${orgId} AND id = ${id}`;
      case "milestone":
        return sql<{ m: string | null }[]>`
          SELECT CASE WHEN p.kind = 'MANDATE' THEN NULL ELSE p.payer_mandate_id END AS m
          FROM payout_milestones ms JOIN partner_payouts p ON p.id = ms.payout_id WHERE ms.org_id = ${orgId} AND ms.id = ${id}`;
      // A claim belongs to the desk whose grant it was made under; a refusal
      // made with no grant, to the firm's first desk here.
      case "registration":
        return sql<{ m: string | null }[]>`
          SELECT CASE WHEN r.grant_id IS NOT NULL THEN (SELECT g.mandate_id FROM grants g WHERE g.id = r.grant_id)
                      ELSE (SELECT f.mandate_id FROM partner_firms f WHERE f.org_id = r.org_id AND f.cp_org_id = r.cp_org_id
                            ORDER BY f.created_at LIMIT 1) END AS m
          FROM client_registrations r WHERE r.org_id = ${orgId} AND r.id = ${id}`;
      case "link":
        return sql<{ m: string | null }[]>`
          SELECT f.mandate_id AS m FROM partner_links l JOIN partner_firms f ON f.id = l.firm_id WHERE l.org_id = ${orgId} AND l.id = ${id}`;
      case "agent":
        return sql<{ m: string | null }[]>`
          SELECT f.mandate_id AS m FROM partner_agents a JOIN partner_firms f ON f.id = a.firm_id WHERE a.org_id = ${orgId} AND a.id = ${id}`;
    }
  });
  return rows[0] ? { mandateId: rows[0].m } : null;
}

/**
 * The mandate a desk works a set of projects under. The developer's own desk
 * is none; a mandate firm's is the one live mandate whose projects hold them
 * all, or nothing when there is no such mandate.
 */
export async function mandateFor(
  orgId: string,
  desk: WorkDesk,
  projectIds: string[],
  /** The mandate a firm already sits under, when adding projects to it. */
  within?: string | null,
): Promise<{ ok: true; mandateId: string | null; lastDay: string | null } | { ok: false; message: string }> {
  if (desk.kind === "OWN") return { ok: true, mandateId: null, lastDay: null };
  if (!desk.mandateIds.length) return { ok: false, message: "Your firm holds no live mandate here." };
  if (within && !desk.mandateIds.includes(within)) return { ok: false, message: "That firm is not on your desk." };
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; valid_to: Date; projects: string[] }[]>`
    SELECT m.id, m.valid_to, array_agg(p.scope_node_id::text) AS projects
    FROM mandates m JOIN mandate_projects p ON p.mandate_id = m.id
    WHERE m.org_id = ${orgId} AND m.id = ANY(${desk.mandateIds}::uuid[]) AND m.status = 'LIVE'
    GROUP BY m.id, m.valid_to`);
  const fit = rows.find((r) => (!within || r.id === within) && projectIds.every((id) => r.projects.includes(id)));
  if (!fit) return { ok: false, message: within ? "Choose projects from the mandate this firm sells under." : "Choose projects from one of your mandates." };
  return { ok: true, mandateId: fit.id, lastDay: istDay(new Date(fit.valid_to.getTime() - 1).toISOString()) };
}

/**
 * A partner may sit on two desks of one developer: the developer's own for
 * some projects and a mandate firm's for others, one desk per project at a
 * time (0092). This is the firm's row on the desk that has it at `nodeId`
 * (a project or a tower): a live grant first, then any grant there, then the
 * developer's own desk, then the oldest row. Null when the developer has no
 * row for the partner at all.
 */
export async function deskFirmIn(sql: Sql, orgId: string, cpOrgId: string, nodeId: string): Promise<string | null> {
  if (!isId(nodeId)) return null;
  const [f] = await sql<{ id: string }[]>`
    SELECT f.id FROM partner_firms f
    LEFT JOIN LATERAL (
      SELECT g.status, g.valid_to FROM grants g JOIN scope_nodes gn ON gn.id = g.scope_node_id
      WHERE g.org_id = f.org_id AND g.grantee_org_id = f.cp_org_id AND g.role = 'CHANNEL_PARTNER'
        AND g.mandate_id IS NOT DISTINCT FROM f.mandate_id
        AND gn.path @> (SELECT n.path FROM scope_nodes n WHERE n.org_id = ${orgId} AND n.id = ${nodeId})
      ORDER BY (g.status <> 'ENDED') DESC, g.valid_to DESC LIMIT 1
    ) g ON true
    WHERE f.org_id = ${orgId} AND f.cp_org_id = ${cpOrgId}
    ORDER BY (g.status = 'ACTIVE' AND g.valid_to > now()) DESC NULLS LAST, (g.status <> 'ENDED') DESC NULLS LAST,
             g.valid_to DESC NULLS LAST, (f.mandate_id IS NULL) DESC, f.created_at
    LIMIT 1`;
  return f?.id ?? null;
}

/** `deskFirmIn()` for a caller holding a firm row, not a transaction: the same partner's row for this place. */
export async function deskFirm(orgId: string, firmId: string, nodeId: string): Promise<string> {
  if (!isId(firmId)) return firmId;
  return withTenant(orgId, async (sql) => {
    const [f] = await sql<{ cp_org_id: string }[]>`SELECT cp_org_id FROM partner_firms WHERE org_id = ${orgId} AND id = ${firmId}`;
    return (f && (await deskFirmIn(sql, orgId, f.cp_org_id, nodeId))) || firmId;
  });
}

export type PartnerSettings = {
  dialPolicy: "AFTER_VISIT" | "LOGGED";
  dailyRegistrations: number;
  /** A buyer registered on one project and booked on another. */
  crossProject: CrossProject;
  /** A booking cancelled after a half was paid takes that money back from the firm's next payouts. */
  clawback: boolean;
  /** What makes a direct buyer the developer's. */
  directWins: DirectWins;
  /** A channel partner's own: its captured leads are registered with the developer by themselves. */
  autoRegister: boolean;
  /** A partner sees its buyer's home loan stage, once the buyer said yes. Off by default. */
  shareLoanStage: boolean;
};

/** What a save may carry: the first two always, the developer's rules when the form had them. */
export type PartnerSettingsInput = Pick<PartnerSettings, "dialPolicy" | "dailyRegistrations"> &
  Partial<Pick<PartnerSettings, "crossProject" | "clawback" | "directWins" | "shareLoanStage">>;

const DEFAULT_SETTINGS: PartnerSettings = {
  dialPolicy: "AFTER_VISIT",
  dailyRegistrations: 50,
  crossProject: "OFF",
  clawback: true,
  directWins: "ENQUIRY",
  autoRegister: false,
  shareLoanStage: false,
};

async function settingsIn(sql: Sql, orgId: string): Promise<PartnerSettings> {
  const [s] = await sql<{
    dial_policy: "AFTER_VISIT" | "LOGGED"; daily_registrations: number; cross_project_claims: string; clawback: boolean;
    direct_wins: string; auto_register: boolean; share_loan_stage: boolean;
  }[]>`
    SELECT dial_policy, daily_registrations, cross_project_claims, clawback, direct_wins, auto_register, share_loan_stage
    FROM partner_settings WHERE org_id = ${orgId}`;
  return s
    ? {
        dialPolicy: s.dial_policy,
        dailyRegistrations: s.daily_registrations,
        crossProject: isCrossProject(s.cross_project_claims) ? s.cross_project_claims : "OFF",
        clawback: s.clawback,
        directWins: s.direct_wins === "VISIT" ? "VISIT" : "ENQUIRY",
        autoRegister: s.auto_register,
        shareLoanStage: s.share_loan_stage,
      }
    : DEFAULT_SETTINGS;
}

export async function saveSettings(opts: { orgId: string; userId: string; settings: PartnerSettingsInput }): Promise<{ ok: boolean; message: string }> {
  const s = opts.settings;
  if (!["AFTER_VISIT", "LOGGED"].includes(s.dialPolicy)) return { ok: false, message: "Choose when your team may call a partner's buyer." };
  if (!Number.isInteger(s.dailyRegistrations) || s.dailyRegistrations < 1 || s.dailyRegistrations > 1000) {
    return { ok: false, message: "A firm may register 1 to 1,000 buyers a day." };
  }
  if (s.crossProject !== undefined && !isCrossProject(s.crossProject)) return { ok: false, message: "Choose what a booking on another project does." };
  if (s.directWins !== undefined && s.directWins !== "ENQUIRY" && s.directWins !== "VISIT") return { ok: false, message: "Choose when a direct buyer is yours." };
  const cross = s.crossProject ?? null;
  const claw = s.clawback ?? null;
  const direct = s.directWins ?? null;
  const share = s.shareLoanStage ?? null;
  await withTenant(opts.orgId, (sql) => sql`
    INSERT INTO partner_settings (org_id, dial_policy, daily_registrations, cross_project_claims, clawback, direct_wins, share_loan_stage, updated_by)
    VALUES (${opts.orgId}, ${s.dialPolicy}, ${s.dailyRegistrations}, coalesce(${cross}::text, 'OFF'), coalesce(${claw}::boolean, true),
            coalesce(${direct}::text, 'ENQUIRY'), coalesce(${share}::boolean, false), ${opts.userId})
    ON CONFLICT (org_id) DO UPDATE SET dial_policy = EXCLUDED.dial_policy,
      daily_registrations = EXCLUDED.daily_registrations,
      cross_project_claims = coalesce(${cross}::text, partner_settings.cross_project_claims),
      clawback = coalesce(${claw}::boolean, partner_settings.clawback),
      direct_wins = coalesce(${direct}::text, partner_settings.direct_wins),
      share_loan_stage = coalesce(${share}::boolean, partner_settings.share_loan_stage),
      updated_by = EXCLUDED.updated_by, updated_at = now()`);
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "partner.settings_changed",
    targetType: "org",
    targetId: opts.orgId,
    metadata: {
      dial: s.dialPolicy,
      daily: s.dailyRegistrations,
      ...(cross ? { cross } : {}),
      ...(claw !== null ? { clawback: claw } : {}),
      ...(direct ? { direct } : {}),
    },
  });
  return { ok: true, message: "Saved." };
}

/** A channel partner's own setting, read in its own tenant. */
export async function partnerAutoRegister(orgId: string): Promise<boolean> {
  return withTenant(orgId, async (sql) => (await settingsIn(sql, orgId)).autoRegister);
}

/** A channel partner switching on, or off, registering its own captured leads with the developer. */
export async function saveAutoRegister(opts: { orgId: string; userId: string; on: boolean }): Promise<{ ok: boolean; message: string }> {
  await withTenant(opts.orgId, (sql) => sql`
    INSERT INTO partner_settings (org_id, auto_register, updated_by) VALUES (${opts.orgId}, ${opts.on}, ${opts.userId})
    ON CONFLICT (org_id) DO UPDATE SET auto_register = EXCLUDED.auto_register, updated_by = EXCLUDED.updated_by, updated_at = now()`);
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.auto_register_changed", targetType: "org", targetId: opts.orgId, metadata: { on: opts.on } });
  return { ok: true, message: opts.on ? "New leads are registered with the developer as they come in." : "Saved. Register new leads yourself." };
}

export async function saveTerms(opts: { orgId: string; userId: string; projectId: string; terms: Terms; mandateId?: string | null }): Promise<{ ok: boolean; message: string }> {
  const problem = termsProblem(opts.terms);
  if (problem) return { ok: false, message: problem };
  const t = opts.terms;
  const done = await withTenant(opts.orgId, async (sql) => {
    const [p] = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.projectId} AND kind = 'PROJECT'`;
    if (!p) return false;
    // A form that did not carry the period keeps the one stored.
    const period: LadderPeriod | null = t.ladderPeriod ?? null;
    const half: string | null = t.secondHalf ?? null;
    await sql`
      INSERT INTO commission_terms (org_id, scope_node_id, mandate_id, steps, pass_back_max, registration_days, visit_extends_days, ladder_period, second_half, updated_by)
      VALUES (${opts.orgId}, ${p.id}, ${opts.mandateId ?? null}, ${sql.json(t.steps as never)}, ${t.passBackMax}, ${t.registrationDays}, ${t.visitExtendsDays},
              coalesce(${period}::text, 'ALL'), coalesce(${half}::text, 'COLLECTED'), ${opts.userId})
      ON CONFLICT (org_id, scope_node_id, coalesce(mandate_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET steps = EXCLUDED.steps, pass_back_max = EXCLUDED.pass_back_max,
        registration_days = EXCLUDED.registration_days, visit_extends_days = EXCLUDED.visit_extends_days,
        ladder_period = coalesce(${period}::text, commission_terms.ladder_period),
        second_half = coalesce(${half}::text, commission_terms.second_half),
        updated_by = EXCLUDED.updated_by, updated_at = now()`;
    return true;
  });
  if (!done) return { ok: false, message: "That project is not here." };
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "partner.terms_changed",
    targetType: "scope_node",
    targetId: opts.projectId,
    metadata: { steps: t.steps.length, days: t.registrationDays, visit: t.visitExtendsDays, ...(t.ladderPeriod ? { period: t.ladderPeriod } : {}) },
  });
  return { ok: true, message: "Terms saved. They apply to bookings from now on." };
}

// ---------------------------------------------------------------------------
// Empanelment
// ---------------------------------------------------------------------------

/** The end of an IST day, as an instant: a grant "to 31 March" runs through it. */
export function endOfIstDay(day: string): string {
  return new Date(Date.parse(`${day}T23:59:59.999+05:30`)).toISOString();
}

/** A grant runs from the start of the IST day it was made, not the second. */
const startOfIstDay = (iso: string) => new Date(`${istDay(iso)}T00:00:00+05:30`);

/**
 * The firm's org, found by PAN or created. Org creation is the one thing the
 * control connection is for, and a lock on the PAN makes two tenants
 * empanelling the same firm at once find one org, not make two.
 *
 * The org is created unverified and carries no GSTIN: a developer typing a
 * partner's details has proved nothing about who the partner is, and a
 * GSTIN on the org row is unique across the platform, so a typo would stop
 * the real company signing up. Signup dedupe ignores an unverified partner.
 */
async function partnerOrg(opts: { pan: string; name: string; legalName: string; userId: string }): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  return controlDb.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`cp-org:${opts.pan}`}))`;
    const found = await tx<{ id: string; type: string }[]>`
      SELECT id, type FROM orgs WHERE pan = ${opts.pan} ORDER BY (type = 'CHANNEL_PARTNER') DESC, created_at LIMIT 1`;
    if (found[0]?.type === "CHANNEL_PARTNER") return { ok: true as const, id: found[0].id };
    if (found[0]) return { ok: false as const, message: "That PAN belongs to an organisation here that is not a channel partner." };
    let slug = slugify(opts.name) || "partner";
    for (let n = 0; n < 50; n++) {
      const candidate = n === 0 ? `cp_${slug}` : `cp_${slug}_${n + 1}`;
      const [clash] = await tx`SELECT 1 FROM scope_nodes WHERE path = ${candidate}::ltree`;
      if (!clash) {
        slug = candidate;
        break;
      }
    }
    const [org] = await tx<{ id: string }[]>`
      INSERT INTO orgs (type, legal_name, display_name, gstin, pan, status, created_by)
      VALUES ('CHANNEL_PARTNER', ${opts.legalName}, ${opts.name}, NULL, ${opts.pan}, 'PENDING_VERIFICATION', ${opts.userId})
      RETURNING id`;
    // The root a partner's own people will hold memberships at, once they can sign in.
    await tx`
      INSERT INTO scope_nodes (org_id, parent_id, kind, name, slug, path)
      VALUES (${org.id}, NULL, 'ORG', ${opts.name}, ${slug}, ${slug}::ltree)`;
    return { ok: true as const, id: org.id };
  });
}

export type EmpanelResult = { ok: true; firmId: string; message: string } | { ok: false; message: string; errors?: Record<string, string> };

/** Read a firm's details off a form, normalised, or say what is wrong. */
export function readFirm(raw: Record<string, string>): { ok: true; firm: FirmInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const pan = validatePan(raw.pan ?? "");
  let gstin: string | null = null;
  if (raw.gstin?.trim()) {
    const g = validateGstin(raw.gstin);
    if (!g.ok) errors.gstin = g.error;
    else {
      gstin = g.gstin;
      if (pan.ok && !panMatchesGstin(pan.pan, g.gstin)) errors.gstin = "This GSTIN carries a different PAN.";
    }
  }
  if (!pan.ok) errors.pan = pan.error;
  const phone = raw.principalPhone?.trim() ? normalisePhone(raw.principalPhone) : null;
  if (raw.principalPhone?.trim() && !phone) errors.principalPhone = "Use 10 digits, or add the country code.";
  const firm: FirmInput = {
    name: (raw.name ?? "").trim().replace(/\s+/g, " "),
    legalName: (raw.legalName ?? raw.name ?? "").trim().replace(/\s+/g, " "),
    pan: pan.ok ? pan.pan : "",
    gstin,
    reraNo: raw.reraNo?.trim() ? raw.reraNo.trim().toUpperCase() : null,
    reraTill: raw.reraTill?.trim() || null,
    competencyTill: raw.competencyTill?.trim() || null,
    principalName: raw.principalName?.trim() || null,
    principalPhone: phone,
    area: raw.area?.trim() || null,
  };
  Object.assign(errors, firmProblem(firm), errors);
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, firm };
}

const listOf = (names: string[]) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Before a desk grants a partner projects: the ones it sells through another
 * desk right now (refused, by name, `onAnotherDesk()`), and, when there are
 * none, the other desks' grants there that ran out but were never ended,
 * closed so the new grant has the place to itself. The database refuses an
 * overlap regardless (`grants_one_desk`, 0092).
 */
async function clearOtherDesks(sql: Sql, orgId: string, cpOrgId: string, projectIds: string[], mandateId: string | null, nowIso: string): Promise<string[]> {
  const rows = await sql<{ project_id: string; project: string; mandate_id: string | null; status: "ACTIVE" | "SUSPENDED" | "ENDED"; valid_to: Date }[]>`
    SELECT g.scope_node_id AS project_id, n.name AS project, g.mandate_id, g.status, g.valid_to
    FROM grants g JOIN scope_nodes n ON n.id = g.scope_node_id
    WHERE g.org_id = ${orgId} AND g.grantee_org_id = ${cpOrgId} AND g.role = 'CHANNEL_PARTNER' AND g.status <> 'ENDED'
      AND g.scope_node_id = ANY(${projectIds}::uuid[])`;
  const clash = onAnotherDesk(
    rows.map((r) => ({ projectId: r.project_id, project: r.project, mandateId: r.mandate_id, status: r.status, validTo: r.valid_to.toISOString() })),
    { projectIds, mandateId, nowIso },
  );
  if (clash.length) return clash;
  await sql`
    UPDATE grants SET status = 'ENDED', suspended_reason = NULL, updated_at = now()
    WHERE org_id = ${orgId} AND grantee_org_id = ${cpOrgId} AND role = 'CHANNEL_PARTNER' AND status <> 'ENDED'
      AND scope_node_id = ANY(${projectIds}::uuid[]) AND mandate_id IS DISTINCT FROM ${mandateId} AND valid_to <= now()`;
  return [];
}

/**
 * A firm on this tenant's desk, and a grant on each project chosen. The
 * projects are read back inside the tenant; an id that is not one of its
 * projects is refused, whatever the form said.
 */
export async function empanelFirm(opts: {
  orgId: string;
  userId: string;
  firm: FirmInput;
  rmId: string | null;
  projectIds: string[];
  validTo: string;
  nowIso?: string;
  /** The mandate a mandate firm empanels under; none for the developer's own desk. */
  mandateId?: string | null;
  /** Who may look after the firm, when they are not the developer's members (a mandate firm's people). */
  rmChoices?: string[];
}): Promise<EmpanelResult> {
  const now = opts.nowIso ?? new Date().toISOString();
  const f = opts.firm;
  const mandateId = opts.mandateId ?? null;
  if (!opts.projectIds.length) return { ok: false, message: "Choose at least one project.", errors: { projects: "Choose at least one project." } };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.validTo) || endOfIstDay(opts.validTo) <= now) {
    return { ok: false, message: "The empanelment has to end after today.", errors: { validTo: "Pick a date after today." } };
  }
  // A partner sits on one row per desk here (0092): the developer's own, or
  // a mandate firm's. A row on this desk already means adding projects to it.
  const already = await withTenant(opts.orgId, (sql) => sql<{ id: string; name: string; mandate_id: string | null }[]>`
    SELECT id, name, mandate_id FROM partner_firms WHERE org_id = ${opts.orgId} AND pan = ${f.pan}`);
  const mine = already.find((r) => r.mandate_id === mandateId);
  if (mine) {
    return { ok: false, message: `${mine.name} is already on your desk. Add the project from the firm.`, errors: { pan: "Already on your desk." } };
  }

  const cp = await partnerOrg({ pan: f.pan, name: f.name, legalName: f.legalName, userId: opts.userId });
  if (!cp.ok) return { ok: false, message: cp.message, errors: { pan: cp.message } };
  if (cp.id === opts.orgId) return { ok: false, message: "That is your own PAN." };

  const made = await withTenant(opts.orgId, async (sql) => {
    const projects = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.orgId} AND kind = 'PROJECT' AND id = ANY(${opts.projectIds})`;
    if (projects.length !== new Set(opts.projectIds).size) return null;
    // One desk per project at a time: a project the partner sells through
    // another desk is refused, by name; the others' lapsed grants are closed.
    const clash = await clearOtherDesks(sql, opts.orgId, cp.id, projects.map((p) => p.id), mandateId, now);
    if (clash.length) return { clash };
    const rm = opts.rmId && isId(opts.rmId)
      ? opts.rmChoices
        ? opts.rmChoices.includes(opts.rmId) ? opts.rmId : null
        : (await sql<{ user_id: string }[]>`
            SELECT user_id FROM memberships WHERE org_id = ${opts.orgId} AND user_id = ${opts.rmId} AND status = 'ACTIVE' LIMIT 1`)[0]?.user_id ?? null
      : null;
    const [firm] = await sql<{ id: string }[]>`
          INSERT INTO partner_firms (org_id, cp_org_id, name, legal_name, pan, gstin, rera_agent_no, rera_valid_till, competency_till,
                                     principal_name, principal_phone, area, rm_id, created_by, mandate_id)
          VALUES (${opts.orgId}, ${cp.id}, ${f.name}, ${f.legalName}, ${f.pan}, ${f.gstin}, ${f.reraNo}, ${f.reraTill}, ${f.competencyTill},
                  ${f.principalName}, ${f.principalPhone}, ${f.area}, ${rm}, ${opts.userId}, ${mandateId})
          RETURNING id`;
    for (const p of projects) {
      const t = await ensureTerms(sql, opts.orgId, p.id, opts.userId, mandateId);
      await sql`
        INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_from, valid_to, commission_terms_ref, created_by, mandate_id)
        VALUES (${opts.orgId}, ${cp.id}, ${p.id}, 'CHANNEL_PARTNER', ${startOfIstDay(now)}, ${new Date(endOfIstDay(opts.validTo))}, ${t.id}, ${opts.userId}, ${mandateId})`;
    }
    await ensurePrincipal(sql, opts.orgId, firm.id, opts.userId);
    return { firmId: firm.id, projects: projects.length };
  });
  if (!made) return { ok: false, message: "One of those projects is not here.", errors: { projects: "Choose from the list." } };
  if ("clash" in made && made.clash) {
    const message = `${f.name} already sells ${listOf(made.clash)} for this developer through another desk.`;
    return { ok: false, message, errors: { projects: message } };
  }
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.empanelled", targetType: "partner_firm", targetId: made.firmId, metadata: { projects: made.projects } });
  return { ok: true, firmId: made.firmId, message: `${f.name} empanelled on ${made.projects} ${made.projects === 1 ? "project" : "projects"}.` };
}

/** More projects for a firm already on the desk. */
export async function grantProjects(opts: { orgId: string; userId: string; firmId: string; projectIds: string[]; validTo: string; nowIso?: string }): Promise<{ ok: boolean; message: string }> {
  const now = opts.nowIso ?? new Date().toISOString();
  if (!opts.projectIds.length) return { ok: false, message: "Choose at least one project." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.validTo) || endOfIstDay(opts.validTo) <= now) return { ok: false, message: "The empanelment has to end after today." };
  const out = await withTenant(opts.orgId, async (sql) => {
    const [firm] = await sql<{ cp_org_id: string; name: string; mandate_id: string | null }[]>`
      SELECT cp_org_id, name, mandate_id FROM partner_firms WHERE org_id = ${opts.orgId} AND id = ${opts.firmId}`;
    if (!firm) return { ok: false, message: "That firm is not on your desk." };
    const projects = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.orgId} AND kind = 'PROJECT' AND id = ANY(${opts.projectIds})`;
    if (projects.length !== new Set(opts.projectIds).size) return { ok: false, message: "One of those projects is not here." };
    const clash = await clearOtherDesks(sql, opts.orgId, firm.cp_org_id, projects.map((p) => p.id), firm.mandate_id, now);
    if (clash.length) return { ok: false, message: `${firm.name} already sells ${listOf(clash)} for this developer through another desk.` };
    let added = 0;
    for (const p of projects) {
      const t = await ensureTerms(sql, opts.orgId, p.id, opts.userId, firm.mandate_id);
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO grants (org_id, grantee_org_id, scope_node_id, role, valid_from, valid_to, commission_terms_ref, created_by, mandate_id)
        VALUES (${opts.orgId}, ${firm.cp_org_id}, ${p.id}, 'CHANNEL_PARTNER', ${startOfIstDay(now)}, ${new Date(endOfIstDay(opts.validTo))}, ${t.id}, ${opts.userId}, ${firm.mandate_id})
        ON CONFLICT (org_id, grantee_org_id, scope_node_id) WHERE status <> 'ENDED' DO NOTHING
        RETURNING id`;
      if (row) added++;
    }
    return { ok: true, message: added ? `${firm.name} added to ${added} ${added === 1 ? "project" : "projects"}.` : `${firm.name} is already on those projects.` };
  });
  if (out.ok) await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.granted", targetType: "partner_firm", targetId: opts.firmId, metadata: { projects: opts.projectIds.length } });
  return out;
}

export type GrantAction = { kind: "suspend"; reason: string } | { kind: "restore" } | { kind: "end" } | { kind: "renew"; validTo: string };

/**
 * Suspension is one UPDATE and takes effect at the next query, because
 * nothing reads a grant from anywhere but the row.
 */
export async function changeGrant(opts: { orgId: string; userId: string; grantId: string; action: GrantAction; nowIso?: string }): Promise<{ ok: boolean; message: string }> {
  const now = opts.nowIso ?? new Date().toISOString();
  const a = opts.action;
  if (a.kind === "suspend" && !a.reason.trim()) return { ok: false, message: "Say why, in a few words." };
  if (a.kind === "renew" && (!/^\d{4}-\d{2}-\d{2}$/.test(a.validTo) || endOfIstDay(a.validTo) <= now)) {
    return { ok: false, message: "Renew to a date after today." };
  }
  const n = await withTenant(opts.orgId, async (sql) => {
    if (a.kind === "suspend") {
      return (await sql`UPDATE grants SET status = 'SUSPENDED', suspended_reason = ${a.reason.trim().slice(0, 200)}, updated_at = now()
                        WHERE org_id = ${opts.orgId} AND id = ${opts.grantId} AND status = 'ACTIVE'`).count;
    }
    if (a.kind === "restore") {
      return (await sql`UPDATE grants SET status = 'ACTIVE', suspended_reason = NULL, updated_at = now()
                        WHERE org_id = ${opts.orgId} AND id = ${opts.grantId} AND status = 'SUSPENDED'`).count;
    }
    if (a.kind === "end") {
      return (await sql`UPDATE grants SET status = 'ENDED', suspended_reason = NULL, updated_at = now()
                        WHERE org_id = ${opts.orgId} AND id = ${opts.grantId} AND status <> 'ENDED'`).count;
    }
    return (await sql`UPDATE grants SET valid_to = ${new Date(endOfIstDay(a.validTo))}, updated_at = now()
                      WHERE org_id = ${opts.orgId} AND id = ${opts.grantId} AND status = 'ACTIVE'`).count;
  });
  if (!n) return { ok: false, message: "That empanelment has changed since you opened it. Reload and try again." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: `partner.grant_${a.kind}`, targetType: "grant", targetId: opts.grantId });
  const said = { suspend: "On hold. No new buyers can be registered.", restore: "Live again.", end: "Ended.", renew: "Renewed." };
  return { ok: true, message: said[a.kind] };
}

/** Correct a firm's details. PAN and the org it points at never change. */
export async function updateFirm(opts: { orgId: string; userId: string; firmId: string; firm: FirmInput; rmId: string | null; rmChoices?: string[] }): Promise<{ ok: boolean; message: string }> {
  const f = opts.firm;
  const n = await withTenant(opts.orgId, async (sql) => {
    const rm = opts.rmId && isId(opts.rmId)
      ? opts.rmChoices
        ? opts.rmChoices.includes(opts.rmId) ? opts.rmId : null
        : (await sql<{ user_id: string }[]>`
            SELECT user_id FROM memberships WHERE org_id = ${opts.orgId} AND user_id = ${opts.rmId} AND status = 'ACTIVE' LIMIT 1`)[0]?.user_id ?? null
      : null;
    const n = (await sql`
      UPDATE partner_firms SET name = ${f.name}, legal_name = ${f.legalName}, gstin = ${f.gstin}, rera_agent_no = ${f.reraNo},
        rera_valid_till = ${f.reraTill}, competency_till = ${f.competencyTill}, principal_name = ${f.principalName},
        principal_phone = ${f.principalPhone}, area = ${f.area}, rm_id = ${rm}, updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.firmId} AND pan = ${f.pan}`).count;
    if (n) await ensurePrincipal(sql, opts.orgId, opts.firmId, opts.userId);
    return n;
  });
  if (!n) return { ok: false, message: "That firm is not on your desk, or its PAN was changed." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.firm_updated", targetType: "partner_firm", targetId: opts.firmId });
  return { ok: true, message: "Saved." };
}

// ---------------------------------------------------------------------------
// The people at a firm who use this developer's WhatsApp
// ---------------------------------------------------------------------------

/**
 * The firm's principal is the first person on its list. A number already
 * speaking for a firm here is left where it is.
 */
async function ensurePrincipal(sql: Sql, orgId: string, firmId: string, userId: string | null): Promise<void> {
  const [f] = await sql<{ cp_org_id: string; principal_name: string | null; principal_phone: string | null }[]>`
    SELECT cp_org_id, principal_name, principal_phone FROM partner_firms WHERE org_id = ${orgId} AND id = ${firmId}`;
  if (!f?.principal_phone) return;
  await sql`
    INSERT INTO partner_agents (org_id, firm_id, cp_org_id, name, phone, is_principal, added_by)
    VALUES (${orgId}, ${firmId}, ${f.cp_org_id}, ${f.principal_name ?? "Principal"}, ${f.principal_phone}, true, ${userId})
    ON CONFLICT (org_id, phone) WHERE status <> 'REMOVED' DO NOTHING`;
}

/**
 * Somebody at the firm who may use this developer's WhatsApp for it. They
 * prove the number themselves, with a code, the first time they write.
 */
export async function addAgent(opts: { orgId: string; userId: string; firmId: string; name: string; phone: string }): Promise<{ ok: boolean; message: string }> {
  const name = opts.name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) return { ok: false, message: "Enter their name." };
  const phone = normalisePhone(opts.phone);
  if (!phone) return { ok: false, message: "Use 10 digits, or add the country code." };
  if (!isId(opts.firmId)) return { ok: false, message: "That firm is not on your desk." };
  const out = await withTenant(opts.orgId, async (sql) => {
    const [firm] = await sql<{ cp_org_id: string; name: string }[]>`
      SELECT cp_org_id, name FROM partner_firms WHERE org_id = ${opts.orgId} AND id = ${opts.firmId}`;
    if (!firm) return { ok: false as const, message: "That firm is not on your desk." };
    const [on] = await sql<{ firm_id: string }[]>`
      SELECT firm_id FROM partner_agents WHERE org_id = ${opts.orgId} AND phone = ${phone} AND status <> 'REMOVED'`;
    if (on) return { ok: false as const, message: on.firm_id === opts.firmId ? "Already on the list." : "That number already speaks for another firm here." };
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO partner_agents (org_id, firm_id, cp_org_id, name, phone, added_by)
      VALUES (${opts.orgId}, ${opts.firmId}, ${firm.cp_org_id}, ${name}, ${phone}, ${opts.userId})
      RETURNING id`;
    return { ok: true as const, id: row.id };
  });
  if (!out.ok) return out;
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.agent_added", targetType: "partner_agent", targetId: out.id, metadata: { phone: auditHash(phone) } });
  return { ok: true, message: `${name} added. They message your WhatsApp number to start.` };
}

/**
 * Off this developer's list: the bot no longer knows them. Their place in
 * their own firm is the firm's, and is not touched.
 */
export async function removeAgent(opts: { orgId: string; userId: string; agentId: string }): Promise<{ ok: boolean; message: string }> {
  if (!isId(opts.agentId)) return { ok: false, message: "That person is not on the list." };
  const n = await withTenant(opts.orgId, async (sql) => {
    const done = await sql`
      UPDATE partner_agents SET status = 'REMOVED', removed_at = now(), removed_by = ${opts.userId}, updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.agentId} AND status <> 'REMOVED'`;
    await sql`UPDATE partner_bot_pending SET done_at = now(), action = '{}'::jsonb WHERE org_id = ${opts.orgId} AND agent_id = ${opts.agentId} AND done_at IS NULL`;
    return done.count;
  });
  if (!n) return { ok: false, message: "That person is not on the list." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.agent_removed", targetType: "partner_agent", targetId: opts.agentId });
  return { ok: true, message: "Removed. The bot no longer answers them." };
}

/** The firm a person on the list works for. */
export async function agentFirm(orgId: string, agentId: string): Promise<string | null> {
  if (!isId(agentId)) return null;
  const [r] = await withTenant(orgId, (sql) => sql<{ firm_id: string }[]>`
    SELECT firm_id FROM partner_agents WHERE org_id = ${orgId} AND id = ${agentId}`);
  return r?.firm_id ?? null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export type RegisterResult = {
  ok: true;
  id: string;
  verdict: Verdict;
  message: string;
  validUntil: string | null;
} | { ok: false; message: string };

/**
 * Release every claim on this tenant whose day has passed, and hand its lead
 * back. Lapsed claims already read as lapsed wherever they are shown; this
 * is what frees the buyer for somebody else and tells the lead's owner.
 */
export async function releaseLapsed(sql: Sql, orgId: string, where?: { phone: string; projectId: string }): Promise<number> {
  const released = await sql<{ id: string; lead_id: string | null; firm: string | null }[]>`
    UPDATE client_registrations r SET status = 'RELEASED', released_at = now()
    WHERE r.org_id = ${orgId} AND r.verdict = 'REGISTERED' AND r.status = 'ACTIVE' AND r.valid_until <= now()
      ${where ? sql`AND r.phone = ${where.phone} AND r.scope_node_id = ${where.projectId}` : sql``}
    RETURNING r.id, r.lead_id,
      (SELECT f.name FROM partner_firms f WHERE f.org_id = r.org_id AND f.cp_org_id = r.cp_org_id
         ORDER BY (f.mandate_id IS NOT DISTINCT FROM (SELECT g.mandate_id FROM grants g WHERE g.id = r.grant_id)) DESC, f.created_at LIMIT 1) AS firm`;
  for (const r of released) {
    if (!r.lead_id) continue;
    await sql`
      UPDATE leads SET needs_person = ${`Partner registration lapsed${r.firm ? ` (${r.firm})` : ""}: the buyer is direct now`.slice(0, 200)},
             updated_at = now()
      WHERE org_id = ${orgId} AND id = ${r.lead_id} AND stage NOT IN ('booked', 'lost')`;
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
      VALUES (${orgId}, ${r.lead_id}, 'ASSIGNED', 'Partner registration lapsed', ${sql.json({ registration: r.id } as never)})`;
  }
  return released.length;
}

/** The sweep: release lapsed claims for one tenant. Called by the lead worker. */
export async function sweepRegistrations(orgId: string): Promise<number> {
  const n = await withTenant(orgId, (sql) => releaseLapsed(sql, orgId));
  if (n) await audit({ orgId, actorUserId: null, action: "partner.registrations_released", targetType: "org", targetId: orgId, metadata: { count: n } });
  return n;
}

/**
 * One attempt at a claim, decided and logged. `sql` is passed when the
 * caller already holds a transaction (a buyer tapping a partner's link
 * becomes a lead and a claim in one).
 */
export async function registerBuyer(opts: {
  orgId: string;
  userId: string | null;
  firmId: string;
  projectId: string;
  phone: string;
  buyerName?: string | null;
  agentName?: string | null;
  /** The person on the firm's list, when the bot made the claim. */
  agentId?: string | null;
  via: "CONSOLE" | "LINK" | "WHATSAPP" | "WORKSPACE";
  refCode?: string | null;
  /** The lead this claim is made with, when it is made in the same breath. */
  leadId?: string | null;
  nowIso?: string;
  sql?: Sql;
}): Promise<RegisterResult> {
  const now = opts.nowIso ?? new Date().toISOString();
  const phone = normalisePhone(opts.phone);
  if (!phone) return { ok: false, message: "That number does not look right. Use 10 digits, or add the country code." };
  if (!isId(opts.firmId) || !isId(opts.projectId)) return { ok: false, message: "Choose a firm and a project." };

  const run = async (sql: Sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`cp-reg:${opts.orgId}:${phone}`}))`;
    const [firm] = await sql<{ cp_org_id: string; name: string; rera_agent_no: string | null; rera_valid_till: Date | string | null; mandate_id: string | null }[]>`
      SELECT cp_org_id, name, rera_agent_no, rera_valid_till, mandate_id FROM partner_firms WHERE org_id = ${opts.orgId} AND id = ${opts.firmId}`;
    if (!firm) return { ok: false as const, message: "That firm is not on your desk." };
    const [project] = await sql<{ id: string; name: string; path: string }[]>`
      SELECT id, name, path::text AS path FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.projectId} AND kind = 'PROJECT'`;
    if (!project) return { ok: false as const, message: "That project is not here." };

    await releaseLapsed(sql, opts.orgId, { phone, projectId: project.id });

    const [grant] = await sql<{ id: string; status: GrantState["status"]; valid_from: Date; valid_to: Date }[]>`
      SELECT id, status, valid_from, valid_to FROM grants
      WHERE org_id = ${opts.orgId} AND grantee_org_id = ${firm.cp_org_id} AND scope_node_id = ${project.id}
        -- Only this firm row's desk: a partner on two desks registers on each through its own row (0092).
        AND mandate_id IS NOT DISTINCT FROM ${firm.mandate_id}
      ORDER BY (status <> 'ENDED') DESC, valid_to DESC LIMIT 1`;
    const { terms } = await ensureTerms(sql, opts.orgId, project.id, opts.userId, firm.mandate_id);
    const settings = await settingsIn(sql, opts.orgId);
    const dayStart = new Date(`${istDay(now)}T00:00:00+05:30`);
    const [{ n: attempts }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM client_registrations
      WHERE org_id = ${opts.orgId} AND cp_org_id = ${firm.cp_org_id} AND created_at >= ${dayStart}`;
    const [claim] = await sql<{ cp_org_id: string; valid_until: Date; status: string }[]>`
      SELECT cp_org_id, valid_until, status FROM client_registrations
      WHERE org_id = ${opts.orgId} AND phone = ${phone} AND scope_node_id = ${project.id}
        AND verdict = 'REGISTERED' AND status IN ('ACTIVE', 'BOOKED')
      LIMIT 1`;
    // Every open direct enquiry of this number here, with whether a site visit was recorded on it.
    const directs = await sql<{ id: string; scope_node_id: string; enquired_at: Date; visited: boolean }[]>`
      SELECT l.id, l.scope_node_id, l.enquired_at,
             EXISTS (SELECT 1 FROM site_visits v WHERE v.org_id = l.org_id AND v.lead_id = l.id AND v.status IN ('ON_SITE', 'VISITED')) AS visited
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${opts.orgId} AND l.phone = ${phone} AND l.stage <> 'lost'
        AND n.path <@ ${project.path}::ltree
        AND l.enquired_at > ${new Date(Date.parse(now) - DIRECT_LOOKBACK_DAYS * DAY_MS)}
        ${opts.leadId ? sql`AND l.id <> ${opts.leadId}` : sql``}
      ORDER BY l.enquired_at LIMIT 20`;
    const direct = directs[0];
    const directVisited = directs.some((d) => d.visited);
    const tillDay = firm.rera_valid_till
      ? typeof firm.rera_valid_till === "string" ? firm.rera_valid_till.slice(0, 10) : istDay(firm.rera_valid_till.toISOString())
      : null;
    // A booked buyer is held for as long as the booking stands.
    const holding = claim
      ? { cpOrgId: claim.cp_org_id, validUntil: claim.status === "BOOKED" ? new Date(Date.parse(now) + 3650 * DAY_MS).toISOString() : claim.valid_until.toISOString() }
      : null;
    const v = registrationVerdict({
      nowIso: now,
      firmOrgId: firm.cp_org_id,
      project: project.name,
      phone,
      grant: grant ? { status: grant.status, validFrom: grant.valid_from.toISOString(), validTo: grant.valid_to.toISOString() } : null,
      agent: { reraNo: firm.rera_agent_no, reraTill: tillDay },
      attemptsToday: attempts,
      dailyCap: settings.dailyRegistrations,
      claim: holding,
      directSince: direct ? direct.enquired_at.toISOString() : null,
      directWins: settings.directWins,
      directVisited,
      registrationDays: terms.registrationDays,
    });
    const message = claim?.status === "BOOKED" && v.verdict === "BLOCKED" ? v.message.replace(/ until .*$/, ".") : v.message;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO client_registrations (org_id, cp_org_id, grant_id, scope_node_id, phone, buyer_name, agent_name, agent_id, lead_id, via, ref_code,
                                        verdict, valid_until, created_by, created_at)
      VALUES (${opts.orgId}, ${firm.cp_org_id}, ${grant?.id ?? null}, ${project.id}, ${phone},
              ${opts.buyerName?.trim().slice(0, 120) || null}, ${opts.agentName?.trim().slice(0, 120) || null}, ${opts.agentId ?? null},
              ${v.verdict === "REGISTERED" ? opts.leadId ?? null : null}, ${opts.via}, ${opts.refCode ?? null},
              ${v.verdict}, ${v.verdict === "BLOCKED" && claim?.status === "BOOKED" ? null : v.validUntil ? new Date(v.validUntil) : null},
              ${opts.userId}, ${new Date(now)})
      RETURNING id`;
    // Under "a direct buyer is ours once they visit", a registration made
    // before the visit wins, and the direct leads are now the partner's.
    if (direct && takesDirectLead(v.verdict, direct.enquired_at.toISOString(), settings.directWins, directVisited)) {
      for (const d of directs) await tagCaptured(sql, opts.orgId, d.id, phone, d.scope_node_id);
    }
    return { ok: true as const, id: row.id, verdict: v.verdict, message, validUntil: v.validUntil };
  };

  const out = opts.sql ? await run(opts.sql) : await withTenant(opts.orgId, run);
  if (out.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.userId,
      action: "partner.registration",
      targetType: "client_registration",
      targetId: out.id,
      metadata: { verdict: out.verdict, via: opts.via },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ownership at capture, the call gate, visits and bookings
// ---------------------------------------------------------------------------

type LiveClaim = { id: string; cpOrgId: string; firm: string; rmId: string | null; validUntil: string; projectId: string };

/** The claim in force on this number at a project containing this node, if any. */
export async function liveClaim(sql: Sql, orgId: string, phone: string, nodeId: string): Promise<LiveClaim | null> {
  const [c] = await sql<{ id: string; cp_org_id: string; name: string; rm_id: string | null; valid_until: Date; scope_node_id: string }[]>`
    SELECT r.id, r.cp_org_id, f.name, f.rm_id, r.valid_until, r.scope_node_id
    FROM client_registrations r
    JOIN scope_nodes p ON p.id = r.scope_node_id
    -- The firm's row on the desk the claim was made under (0092).
    JOIN grants cg ON cg.id = r.grant_id
    JOIN partner_firms f ON f.org_id = r.org_id AND f.cp_org_id = r.cp_org_id AND f.mandate_id IS NOT DISTINCT FROM cg.mandate_id
    WHERE r.org_id = ${orgId} AND r.phone = ${phone} AND r.verdict = 'REGISTERED'
      AND r.status = 'ACTIVE' AND r.valid_until > now()
      AND p.path @> (SELECT path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId})
    LIMIT 1`;
  return c ? { id: c.id, cpOrgId: c.cp_org_id, firm: c.name, rmId: c.rm_id, validUntil: c.valid_until.toISOString(), projectId: c.scope_node_id } : null;
}

/**
 * Ownership rule R2, at capture: a lead whose number a partner holds at this
 * project belongs to that partner's claim, and goes to the person who looks
 * after the firm. Runs inside the capture's own transaction. Returns the
 * rule that fired, for the audit row.
 */
export async function tagCaptured(sql: Sql, orgId: string, leadId: string, phone: string, nodeId: string): Promise<{ rule: "R2"; registrationId: string } | null> {
  const claim = await liveClaim(sql, orgId, phone, nodeId);
  if (!claim) return null;
  const linked = await sql`
    UPDATE client_registrations SET lead_id = ${leadId}
    WHERE org_id = ${orgId} AND id = ${claim.id} AND (lead_id IS NULL OR lead_id = ${leadId})`;
  const owner = claim.rmId
    ? (await sql<{ user_id: string }[]>`
        SELECT user_id FROM memberships WHERE org_id = ${orgId} AND user_id = ${claim.rmId} AND status = 'ACTIVE' LIMIT 1`)[0]?.user_id ?? null
    : null;
  await sql`
    UPDATE leads SET owner_id = coalesce(${owner}, owner_id),
           needs_person = ${`Partner's buyer: ${claim.firm}`.slice(0, 200)}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${leadId}`;
  if (linked.count) {
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
      VALUES (${orgId}, ${leadId}, 'ASSIGNED', ${`Registered by ${claim.firm}`.slice(0, 200)},
              ${sql.json({ registration: claim.id, rule: "R2" } as never)})`;
  }
  return { rule: "R2", registrationId: claim.id };
}

/**
 * Whether a person or the agent may call this lead now. A partner's buyer
 * waits for the site visit unless the tenant chose to allow and log calls.
 */
export async function partnerHold(orgId: string, leadId: string): Promise<{ held: false; logged: boolean } | { held: true; message: string }> {
  return withTenant(orgId, async (sql) => {
    const [lead] = await sql<{ phone: string; scope_node_id: string; visited: boolean }[]>`
      SELECT l.phone, l.scope_node_id,
             EXISTS (SELECT 1 FROM site_visits v WHERE v.org_id = l.org_id AND v.lead_id = l.id AND v.status IN ('ON_SITE', 'VISITED')) AS visited
      FROM leads l WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    if (!lead) return { held: false as const, logged: false };
    const claim = await liveClaim(sql, orgId, lead.phone, lead.scope_node_id);
    if (!claim) return { held: false as const, logged: false };
    const s = await settingsIn(sql, orgId);
    if (s.dialPolicy === "LOGGED" || lead.visited) return { held: false as const, logged: true };
    return {
      held: true as const,
      message: `${claim.firm} registered this buyer. Calls wait until the site visit.`,
    };
  });
}

/**
 * A visit the site team recorded carries a live claim forward. Called when a
 * visit becomes ON_SITE or VISITED. A claim that lapsed before the visit is
 * not revived: the partner's window had closed.
 */
export async function creditVisit(orgId: string, visitId: string): Promise<boolean> {
  const done = await withTenant(orgId, async (sql) => {
    const [v] = await sql<{ lead_id: string; phone: string; scope_node_id: string; at: Date }[]>`
      SELECT v.lead_id, l.phone, v.scope_node_id, coalesce(v.arrived_at, v.completed_at, now()) AS at
      FROM site_visits v JOIN leads l ON l.id = v.lead_id
      WHERE v.org_id = ${orgId} AND v.id = ${visitId}`;
    if (!v) return null;
    const claim = await liveClaim(sql, orgId, v.phone, v.scope_node_id);
    if (!claim) return null;
    const [t] = await sql<TermsRow[]>`
      SELECT t.id, t.steps, t.pass_back_max, t.registration_days, t.visit_extends_days FROM commission_terms t
      WHERE t.org_id = ${orgId} AND t.scope_node_id = ${claim.projectId}
        AND t.mandate_id IS NOT DISTINCT FROM (SELECT g.mandate_id FROM client_registrations r JOIN grants g ON g.id = r.grant_id
                                               WHERE r.org_id = ${orgId} AND r.id = ${claim.id})`;
    const until = extendedUntil(claim.validUntil, v.at.toISOString(), termsOf(t).visitExtendsDays);
    await sql`
      UPDATE client_registrations SET valid_until = ${new Date(until)}, extended_at = now(), extended_by_visit = ${visitId},
             lead_id = coalesce(lead_id, ${v.lead_id})
      WHERE org_id = ${orgId} AND id = ${claim.id}`;
    return claim.id;
  });
  if (done) await audit({ orgId, actorUserId: null, action: "partner.registration_extended", targetType: "client_registration", targetId: done, metadata: { visit: visitId } });
  return !!done;
}

/** The other numbers recorded on a lead: a co-applicant's, an alternate. */
export async function otherNumbersOf(sql: Sql, orgId: string, leadId: string): Promise<string[]> {
  const rows = await sql<{ phone: string }[]>`
    SELECT phone FROM lead_phones WHERE org_id = ${orgId} AND lead_id = ${leadId} AND removed_at IS NULL ORDER BY created_at`;
  return rows.map((r) => r.phone);
}

/** The project a node sits in (or is). */
async function projectAt(sql: Sql, orgId: string, nodeId: string): Promise<{ id: string; name: string; path: string } | null> {
  const [p] = await sql<{ id: string; name: string; path: string }[]>`
    SELECT p.id, p.name, p.path::text AS path FROM scope_nodes p
    WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT'
      AND p.path @> (SELECT n.path FROM scope_nodes n WHERE n.org_id = ${orgId} AND n.id = ${nodeId})
    LIMIT 1`;
  return p ?? null;
}

/**
 * A live claim on any of these numbers at a project of this tenant that
 * does not hold the booked node: the buyer registered on one project and
 * booked on another.
 */
async function claimElsewhere(sql: Sql, orgId: string, phones: string[], nodeId: string): Promise<(LiveClaim & { project: string }) | null> {
  const [c] = await sql<{ id: string; cp_org_id: string; name: string; rm_id: string | null; valid_until: Date; scope_node_id: string; project: string }[]>`
    SELECT r.id, r.cp_org_id, f.name, f.rm_id, r.valid_until, r.scope_node_id, p.name AS project
    FROM client_registrations r
    JOIN scope_nodes p ON p.id = r.scope_node_id
    JOIN grants cg ON cg.id = r.grant_id
    JOIN partner_firms f ON f.org_id = r.org_id AND f.cp_org_id = r.cp_org_id AND f.mandate_id IS NOT DISTINCT FROM cg.mandate_id
    WHERE r.org_id = ${orgId} AND r.phone = ANY(${phones}::text[]) AND r.verdict = 'REGISTERED'
      AND r.status = 'ACTIVE' AND r.valid_until > now()
      AND NOT p.path @> (SELECT path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId})
    ORDER BY r.created_at LIMIT 1`;
  return c
    ? { id: c.id, cpOrgId: c.cp_org_id, firm: c.name, rmId: c.rm_id, validUntil: c.valid_until.toISOString(), projectId: c.scope_node_id, project: c.project }
    : null;
}

/** Whether the firm is empanelled on this project today. */
async function empanelledOn(sql: Sql, orgId: string, cpOrgId: string, projectId: string): Promise<boolean> {
  const [g] = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM grants WHERE org_id = ${orgId} AND grantee_org_id = ${cpOrgId} AND scope_node_id = ${projectId}
      AND role = 'CHANNEL_PARTNER' AND status = 'ACTIVE' AND valid_from <= now() AND valid_to > now() LIMIT 1`;
  return !!g;
}

/**
 * The one path a partner's payout is written by, whatever found its claim:
 * the buyer's number, another number on the lead, a claim on another
 * project, or a person on the desk. The booked project's terms, its ladder
 * counted over its period, the firm's desk deciding who pays.
 */
async function writePartnerPayout(sql: Sql, opts: {
  orgId: string;
  userId: string | null;
  leadId: string;
  lead: { facts: Record<string, string> };
  claimId: string;
  cpOrgId: string;
  /** The project the buyer booked on: its ladder and terms. */
  projectId: string;
  matchedBy: MatchedBy;
  reason?: string | null;
  nowIso: string;
}): Promise<{ ok: true; payoutId: string } | { ok: false; message: string }> {
  const agreement = Number(String(opts.lead.facts.agreement ?? "").replace(/\D/g, ""));
  // The firm's desk decides who pays it and on whose ladder: the developer's
  // own, or the mandate firm that empanelled it.
  // A partner on two desks of this developer is paid by the desk that has it on the booked project.
  const firmId = await deskFirmIn(sql, opts.orgId, opts.cpOrgId, opts.projectId);
  const [firm] = firmId
    ? await sql<{ gstin: string | null; mandate_id: string | null }[]>`
        SELECT gstin, mandate_id FROM partner_firms WHERE org_id = ${opts.orgId} AND id = ${firmId}`
    : [];
  const payer = firm?.mandate_id ?? null;
  const { terms } = await ensureTerms(sql, opts.orgId, opts.projectId, opts.userId, payer);
  const bookedOn = /^\d{4}-\d{2}-\d{2}$/.test(opts.lead.facts.bookedOn ?? "") ? opts.lead.facts.bookedOn : istDay(opts.nowIso);
  // Only the bookings in the ladder's period count: every one, this quarter's or this year's.
  const w = ladderWindow(terms.ladderPeriod, bookedOn);
  const [{ n: booked }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM partner_payouts
    WHERE org_id = ${opts.orgId} AND kind = 'PARTNER' AND cp_org_id = ${opts.cpOrgId} AND scope_node_id = ${opts.projectId} AND cancelled_at IS NULL
      AND payer_mandate_id IS NOT DISTINCT FROM ${payer}
      ${w ? sql`AND booked_on >= ${w.from}::date AND booked_on < ${w.to}::date` : sql``}`;
  const p = payoutFor({ agreement, steps: terms.steps, booked, passBack: 0, passBackMax: terms.passBackMax, gstRegistered: !!firm?.gstin });
  if (!p.ok) return { ok: false, message: p.message };
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO partner_payouts (org_id, lead_id, registration_id, cp_org_id, scope_node_id, unit, agreement, booking_no, rate, pass_back,
                                 gst_registered, booked_on, created_by, payer_mandate_id, matched_by, link_reason)
    VALUES (${opts.orgId}, ${opts.leadId}, ${opts.claimId}, ${opts.cpOrgId}, ${opts.projectId}, ${opts.lead.facts.unit?.slice(0, 40) || null},
            ${agreement}, ${p.payout.bookingNo}, ${p.payout.rate}, ${p.payout.passBack}, ${!!firm?.gstin}, ${bookedOn}, ${opts.userId}, ${payer},
            ${opts.matchedBy}, ${opts.reason ?? null})
    ON CONFLICT (org_id, lead_id, kind) WHERE cancelled_at IS NULL DO NOTHING
    RETURNING id`;
  if (!row) return { ok: false, message: "This booking already pays a partner." };
  for (const key of ["M1", "M2"] as const) {
    const m = p.payout.milestones[key];
    await sql`
      INSERT INTO payout_milestones (org_id, payout_id, key, base, gst, gross, tds, net)
      VALUES (${opts.orgId}, ${row.id}, ${key}, ${m.base}, ${m.gst}, ${m.gross}, ${m.tds}, ${m.net})`;
  }
  // A claim that already lapsed (linked by hand) stays as it ended.
  await sql`UPDATE client_registrations SET status = 'BOOKED', lead_id = coalesce(lead_id, ${opts.leadId})
            WHERE org_id = ${opts.orgId} AND id = ${opts.claimId} AND status = 'ACTIVE'`;
  return { ok: true, payoutId: row.id };
}

/**
 * A lead booked. If a partner held the buyer then, the booking writes what
 * the partner is owed: its place on this project's ladder, the rate, and the
 * two halves with their invoice arithmetic. Idempotent: a second call finds
 * the payout already written.
 *
 * A claim is looked for on the buyer's own number, then on every other
 * number recorded on the lead (a co-applicant, an alternate). With none at
 * the booked project, a live claim on another project of this developer is
 * flagged for the desk or paid on the booked project's terms, as the
 * developer chose (`cross_project_claims`).
 */
export async function onBooked(opts: { orgId: string; userId: string | null; leadId: string; nowIso?: string }): Promise<{ payoutId: string } | null> {
  let mandatePayout: string | null = null;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const out = await withTenant(opts.orgId, async (sql) => {
    const [lead] = await sql<{ phone: string; scope_node_id: string; facts: Record<string, string> }[]>`
      SELECT phone, scope_node_id, facts FROM leads WHERE org_id = ${opts.orgId} AND id = ${opts.leadId} AND stage = 'booked'`;
    if (!lead) return null;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`cp-reg:${opts.orgId}:${lead.phone}`}))`;
    // A mandate firm earns on every booking in its projects while its
    // mandate is live, whoever brought the buyer.
    mandatePayout = await mandateOnBooked(sql, {
      orgId: opts.orgId,
      userId: opts.userId,
      leadId: opts.leadId,
      phone: lead.phone,
      nodeId: lead.scope_node_id,
      facts: lead.facts,
      nowIso,
    });
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM partner_payouts WHERE org_id = ${opts.orgId} AND lead_id = ${opts.leadId} AND kind = 'PARTNER' AND cancelled_at IS NULL`;
    if (existing) return { payoutId: existing.id, fresh: false as const };
    const project = await projectAt(sql, opts.orgId, lead.scope_node_id);
    if (!project) return null;

    const others = await otherNumbersOf(sql, opts.orgId, opts.leadId);
    let matched: MatchedBy = "PHONE";
    let claim: LiveClaim | null = await liveClaim(sql, opts.orgId, lead.phone, lead.scope_node_id);
    for (const phone of others) {
      if (claim) break;
      claim = await liveClaim(sql, opts.orgId, phone, lead.scope_node_id);
      if (claim) matched = "OTHER_NUMBER";
    }
    if (!claim) {
      const away = await claimElsewhere(sql, opts.orgId, [lead.phone, ...others], lead.scope_node_id);
      if (!away) return null;
      const settings = await settingsIn(sql, opts.orgId);
      const act = crossProjectAction(settings.crossProject, await empanelledOn(sql, opts.orgId, away.cpOrgId, project.id));
      if (act === "NONE") return null;
      if (act === "FLAG") {
        const note = crossProjectNote(away.firm, away.project);
        await sql`UPDATE leads SET needs_person = ${note}, updated_at = now() WHERE org_id = ${opts.orgId} AND id = ${opts.leadId}`;
        await sql`
          INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
          VALUES (${opts.orgId}, ${opts.leadId}, 'ASSIGNED', ${note}, ${sql.json({ registration: away.id, rule: "OTHER_PROJECT" } as never)})`;
        return { flagged: away.id };
      }
      claim = away;
      matched = "OTHER_PROJECT";
    }
    const made = await writePartnerPayout(sql, {
      orgId: opts.orgId,
      userId: opts.userId,
      leadId: opts.leadId,
      lead,
      claimId: claim.id,
      cpOrgId: claim.cpOrgId,
      projectId: project.id,
      matchedBy: matched,
      nowIso,
    });
    return made.ok ? { payoutId: made.payoutId, fresh: true as const, matched } : null;
  });
  if (mandatePayout) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "mandate.payout_owed", targetType: "partner_payout", targetId: mandatePayout });
    await notifyPayout(opts.orgId, mandatePayout, { kind: "booked" });
  }
  if (out && "flagged" in out) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.claim_elsewhere", targetType: "client_registration", targetId: out.flagged, metadata: { lead: opts.leadId } });
    return null;
  }
  if (out?.fresh) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.userId,
      action: "partner.payout_owed",
      targetType: "partner_payout",
      targetId: out.payoutId,
      metadata: out.matched === "PHONE" ? undefined : { matched: out.matched },
    });
    await notifyPayout(opts.orgId, out.payoutId, { kind: "booked" });
  }
  return out ? { payoutId: out.payoutId } : null;
}

/** Where a registration sits, for the permission check on linking it by hand. */
export async function registrationPath(orgId: string, registrationId: string): Promise<string | null> {
  if (!isId(registrationId)) return null;
  const [r] = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
    SELECT n.path::text AS path FROM client_registrations r JOIN scope_nodes n ON n.id = r.scope_node_id
    WHERE r.org_id = ${orgId} AND r.id = ${registrationId}`);
  return r?.path ?? null;
}

/**
 * The desk links a firm's claim to a booking no claim matched: the buyer
 * registered under a spouse's number, or the number was typed wrong. A live
 * claim or one lapsed in the last thirty days, a reason, and the payout is
 * written by the same path a matched booking takes, on the booked project's
 * terms. Refused when the booking already pays a partner.
 */
export async function linkClaimByHand(opts: { orgId: string; userId: string; registrationId: string; leadId: string; reason: string; nowIso?: string }): Promise<{ ok: boolean; message: string }> {
  if (!isId(opts.registrationId) || !isId(opts.leadId)) return { ok: false, message: "Choose a registration and a booking." };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const reason = opts.reason.trim().replace(/\s+/g, " ");
  const out = await withTenant(opts.orgId, async (sql) => {
    const [lead] = await sql<{ phone: string; scope_node_id: string; facts: Record<string, string>; stage: string }[]>`
      SELECT phone, scope_node_id, facts, stage FROM leads WHERE org_id = ${opts.orgId} AND id = ${opts.leadId}`;
    if (!lead) return { ok: false as const, message: "That booking is not here." };
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`cp-reg:${opts.orgId}:${lead.phone}`}))`;
    const [claim] = await sql<{ verdict: Verdict; status: string; valid_until: Date | null; cp_org_id: string; phone: string; firm: string | null }[]>`
      SELECT r.verdict, r.status, r.valid_until, r.cp_org_id, r.phone,
             (SELECT f.name FROM partner_firms f WHERE f.org_id = r.org_id AND f.cp_org_id = r.cp_org_id
               ORDER BY (f.mandate_id IS NOT DISTINCT FROM (SELECT g.mandate_id FROM grants g WHERE g.id = r.grant_id)) DESC, f.created_at
               LIMIT 1) AS firm
      FROM client_registrations r WHERE r.org_id = ${opts.orgId} AND r.id = ${opts.registrationId}`;
    const [paying] = await sql<{ id: string }[]>`
      SELECT id FROM partner_payouts WHERE org_id = ${opts.orgId} AND lead_id = ${opts.leadId} AND kind = 'PARTNER' AND cancelled_at IS NULL`;
    const refusal = manualLinkRefusal({
      claim: claim ? { verdict: claim.verdict, status: claim.status, validUntil: claim.valid_until?.toISOString() ?? null } : null,
      leadBooked: lead.stage === "booked",
      hasPartnerPayout: !!paying,
      reason,
      nowIso,
    });
    if (refusal) return { ok: false as const, message: refusal };
    const project = await projectAt(sql, opts.orgId, lead.scope_node_id);
    if (!project) return { ok: false as const, message: "That booking is not in a project." };
    const made = await writePartnerPayout(sql, {
      orgId: opts.orgId,
      userId: opts.userId,
      leadId: opts.leadId,
      lead,
      claimId: opts.registrationId,
      cpOrgId: claim!.cp_org_id,
      projectId: project.id,
      matchedBy: "BY_HAND",
      reason,
      nowIso,
    });
    if (!made.ok) return made;
    const line = `Linked by hand to ${claim!.firm ?? "a partner"}'s registration`.slice(0, 200);
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id, detail)
      VALUES (${opts.orgId}, ${opts.leadId}, 'ASSIGNED', ${line}, ${opts.userId},
              ${sql.json({ registration: opts.registrationId, rule: "BY_HAND" } as never)})`;
    return { ok: true as const, payoutId: made.payoutId, hashes: { claim: auditHash(claim!.phone), lead: auditHash(lead.phone) } };
  });
  if (!out.ok) return out;
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "partner.claim_linked",
    targetType: "partner_payout",
    targetId: out.payoutId,
    // Numbers only as hashes; the reason is the person's own words and stays on the payout row.
    metadata: { registration: opts.registrationId, claim_phone: out.hashes.claim, lead_phone: out.hashes.lead },
  });
  await notifyPayout(opts.orgId, out.payoutId, { kind: "booked" });
  return { ok: true, message: "Linked. The firm's commission on this booking is owed." };
}

/**
 * Set a firm's outstanding clawbacks against its approved, unpaid halves on
 * the same desk: oldest debit first, oldest approval first, never taking a
 * half below zero (`applyDebits()`). A half then pays its net less what was
 * set against it. Under a lock on the firm, so two approvals at once cannot
 * both spend one debit. Returns what it set off.
 */
export async function settleDebits(sql: Sql, orgId: string, cpOrgId: string, payer: string | null): Promise<{ debitId: string; halfId: string; amount: number }[]> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`cp-debit:${orgId}:${cpOrgId}`}))`;
  const debits = await sql<{ id: string; outstanding: string }[]>`
    SELECT a.id, (-a.amount) - coalesce((
             SELECT sum(u.amount) FROM partner_adjustment_uses u
             JOIN payout_milestones ms ON ms.id = u.milestone_id JOIN partner_payouts p ON p.id = ms.payout_id
             WHERE u.adjustment_id = a.id AND (ms.stage = 'PAID' OR p.cancelled_at IS NULL)), 0) AS outstanding
    FROM partner_adjustments a
    WHERE a.org_id = ${orgId} AND a.cp_org_id = ${cpOrgId} AND a.payer_mandate_id IS NOT DISTINCT FROM ${payer}
    ORDER BY a.created_at, a.id`;
  const open = debits.map((d) => ({ id: d.id, outstanding: Number(d.outstanding) })).filter((d) => d.outstanding > 0);
  if (!open.length) return [];
  const halves = await sql<{ id: string; room: string }[]>`
    SELECT ms.id, ms.net - coalesce((SELECT sum(u.amount) FROM partner_adjustment_uses u WHERE u.milestone_id = ms.id), 0) AS room
    FROM payout_milestones ms JOIN partner_payouts p ON p.id = ms.payout_id
    WHERE p.org_id = ${orgId} AND p.cp_org_id = ${cpOrgId} AND p.kind = 'PARTNER' AND p.cancelled_at IS NULL
      AND p.payer_mandate_id IS NOT DISTINCT FROM ${payer} AND ms.stage = 'APPROVED'
    ORDER BY ms.approved_at, ms.id`;
  const uses = applyDebits(open, halves.map((h) => ({ id: h.id, room: Number(h.room) })));
  const done: { debitId: string; halfId: string; amount: number }[] = [];
  for (const u of uses) {
    const n = await sql`
      INSERT INTO partner_adjustment_uses (org_id, adjustment_id, milestone_id, amount)
      VALUES (${orgId}, ${u.debitId}, ${u.halfId}, ${u.amount})
      ON CONFLICT (adjustment_id, milestone_id) DO NOTHING`;
    if (n.count) done.push(u);
  }
  return done;
}

/**
 * A booking undone. Its payout is cancelled and the partner's claim goes
 * back to what it was: live if its day has not come, lapsed if it has. A
 * half already paid stays paid on its own row; with clawback on (the
 * default), what was actually sent on it is written as a debit against the
 * same firm's next payouts on this desk.
 */
export async function onUnbooked(opts: { orgId: string; userId: string | null; leadId: string }): Promise<boolean> {
  const res = await withTenant(opts.orgId, async (sql) => {
    const settings = await settingsIn(sql, opts.orgId);
    const rows = await sql<{ id: string; kind: "PARTNER" | "MANDATE"; registration_id: string | null; cp_org_id: string; payer_mandate_id: string | null }[]>`
      UPDATE partner_payouts SET cancelled_at = now(), updated_at = now()
      WHERE org_id = ${opts.orgId} AND lead_id = ${opts.leadId} AND cancelled_at IS NULL
      RETURNING id, kind, registration_id, cp_org_id, payer_mandate_id`;
    const debits: { payoutId: string; debitId: string; amount: number }[] = [];
    for (const p of rows) {
      if (p.registration_id) {
        await sql`UPDATE client_registrations SET status = 'ACTIVE'
                  WHERE org_id = ${opts.orgId} AND id = ${p.registration_id} AND status = 'BOOKED'`;
      }
      if (p.kind !== "PARTNER") continue;
      if (settings.clawback) {
        const paid = await sql<{ net: string; adjusted: string }[]>`
          SELECT ms.net, coalesce((SELECT sum(u.amount) FROM partner_adjustment_uses u WHERE u.milestone_id = ms.id), 0) AS adjusted
          FROM payout_milestones ms WHERE ms.org_id = ${opts.orgId} AND ms.payout_id = ${p.id} AND ms.stage = 'PAID'`;
        const amount = clawbackFor(paid.map((h) => ({ net: Number(h.net), adjusted: Number(h.adjusted) })));
        if (amount > 0) {
          const [d] = await sql<{ id: string }[]>`
            INSERT INTO partner_adjustments (org_id, cp_org_id, payer_mandate_id, kind, payout_id, amount, created_by)
            VALUES (${opts.orgId}, ${p.cp_org_id}, ${p.payer_mandate_id}, 'CLAWBACK', ${p.id}, ${-amount}, ${opts.userId})
            ON CONFLICT (payout_id, kind) DO NOTHING
            RETURNING id`;
          if (d) debits.push({ payoutId: p.id, debitId: d.id, amount });
        }
      }
      // A debit set against this booking's own unpaid half is free again; set it against the next.
      await settleDebits(sql, opts.orgId, p.cp_org_id, p.payer_mandate_id);
    }
    return { rows, debits };
  });
  for (const p of res.rows) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.userId,
      action: p.kind === "MANDATE" ? "mandate.payout_cancelled" : "partner.payout_cancelled",
      targetType: "partner_payout",
      targetId: p.id,
    });
    if (p.kind !== "PARTNER") {
      await notifyPayout(opts.orgId, p.id, { kind: "cancelled" });
      continue;
    }
    const debit = res.debits.find((d) => d.payoutId === p.id);
    if (debit) {
      await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.clawback", targetType: "partner_adjustment", targetId: debit.debitId, metadata: { amount: debit.amount } });
      await notifyPayout(opts.orgId, p.id, { kind: "clawback", amount: debit.amount });
    } else {
      await notifyPayout(opts.orgId, p.id, { kind: "cancelled" });
    }
  }
  return res.rows.some((p) => p.kind === "PARTNER");
}

/**
 * The lead a partner's claim is worked through, made when the relationship
 * manager books the buyer's visit and nothing has enquired yet. The claim
 * names a project; the lead names the tower the visit is for.
 */
export async function leadForClaim(opts: { orgId: string; userId: string; registrationId: string; phaseId: string }): Promise<{ ok: true; leadId: string } | { ok: false; message: string }> {
  return withTenant(opts.orgId, async (sql) => {
    const [r] = await sql<{ id: string; phone: string; buyer_name: string | null; lead_id: string | null; scope_node_id: string; cp_org_id: string; live: boolean; path: string }[]>`
      SELECT r.id, r.phone, r.buyer_name, r.lead_id, r.scope_node_id, r.cp_org_id, p.path::text AS path,
             (r.verdict = 'REGISTERED' AND r.status = 'ACTIVE' AND r.valid_until > now()) AS live
      FROM client_registrations r JOIN scope_nodes p ON p.id = r.scope_node_id
      WHERE r.org_id = ${opts.orgId} AND r.id = ${opts.registrationId}`;
    if (!r || !r.live) return { ok: false as const, message: "This registration is not live." };
    if (r.lead_id) {
      const [l] = await sql<{ id: string }[]>`SELECT id FROM leads WHERE org_id = ${opts.orgId} AND id = ${r.lead_id} AND stage <> 'lost'`;
      if (l) return { ok: true as const, leadId: l.id };
    }
    const [phase] = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.orgId} AND id = ${opts.phaseId} AND kind = 'PHASE' AND path <@ ${r.path}::ltree`;
    if (!phase) return { ok: false as const, message: "Choose a tower in this project." };
    const [firm] = await sql<{ name: string; rm_id: string | null }[]>`
      SELECT f.name, f.rm_id FROM partner_firms f WHERE f.org_id = ${opts.orgId} AND f.cp_org_id = ${r.cp_org_id}
      ORDER BY (f.mandate_id IS NOT DISTINCT FROM (SELECT g.mandate_id FROM client_registrations c JOIN grants g ON g.id = c.grant_id
                                                   WHERE c.org_id = ${opts.orgId} AND c.id = ${r.id})) DESC, f.created_at
      LIMIT 1`;
    // Somebody at the partner firm books too (on WhatsApp, or from its
    // workspace); a lead is only ever owned by the developer's own people.
    const [member] = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM memberships WHERE org_id = ${opts.orgId} AND user_id = ${opts.userId} AND status = 'ACTIVE' LIMIT 1`;
    const [lead] = await sql<{ id: string }[]>`
      INSERT INTO leads (org_id, scope_node_id, name, phone, source, channel, created_by, owner_id, needs_person)
      VALUES (${opts.orgId}, ${phase.id}, ${r.buyer_name ?? "Partner's buyer"}, ${r.phone}, 'Channel partner', 'MANUAL', ${opts.userId},
              ${firm?.rm_id ?? (member ? opts.userId : null)}, ${`Partner's buyer: ${firm?.name ?? "a partner"}`.slice(0, 200)})
      RETURNING id`;
    await sql`UPDATE client_registrations SET lead_id = ${lead.id} WHERE org_id = ${opts.orgId} AND id = ${r.id}`;
    await sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id, detail)
      VALUES (${opts.orgId}, ${lead.id}, 'CAPTURED', ${`Registered by ${firm?.name ?? "a partner"}`.slice(0, 200)}, ${opts.userId},
              ${sql.json({ registration: r.id, rule: "R2" } as never)})`;
    return { ok: true as const, leadId: lead.id };
  });
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

type MilestoneRow = { id: string; payout_id: string; key: MilestoneKey; stage: keyof typeof STAGE_OF; gross: string | number; path: string; node_id: string; owed: boolean; cancelled: boolean };

async function milestone(sql: Sql, orgId: string, id: string): Promise<MilestoneRow | null> {
  const [m] = await sql<MilestoneRow[]>`
    SELECT m.id, m.payout_id, m.key, m.stage, m.gross, n.path::text AS path, p.scope_node_id AS node_id, p.cancelled_at IS NOT NULL AS cancelled,
           CASE WHEN m.key = 'M1' THEN p.agreement_registered_on IS NOT NULL ELSE p.collected_on IS NOT NULL END AS owed
    FROM payout_milestones m JOIN partner_payouts p ON p.id = m.payout_id JOIN scope_nodes n ON n.id = p.scope_node_id
    WHERE m.org_id = ${orgId} AND m.id = ${id}`;
  return m ?? null;
}

/** Where a payout or a milestone sits, for the permission check. */
export async function payoutPath(orgId: string, kind: "payout" | "milestone", id: string): Promise<string | null> {
  if (!isId(id)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = kind === "payout"
      ? await sql<{ path: string }[]>`
          SELECT n.path::text AS path FROM partner_payouts p JOIN scope_nodes n ON n.id = p.scope_node_id WHERE p.org_id = ${orgId} AND p.id = ${id}`
      : await sql<{ path: string }[]>`
          SELECT n.path::text AS path FROM payout_milestones m JOIN partner_payouts p ON p.id = m.payout_id
          JOIN scope_nodes n ON n.id = p.scope_node_id WHERE m.org_id = ${orgId} AND m.id = ${id}`;
    return r?.path ?? null;
  });
}

/** The two dates that make the halves owed. Entered by hand until the CRM sync exists. */
export async function recordBookingDates(opts: { orgId: string; userId: string; payoutId: string; agreementRegisteredOn: string | null; collectedOn: string | null; today: string }): Promise<{ ok: boolean; message: string }> {
  const day = (d: string | null) => (d === null || /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "bad");
  const a = day(opts.agreementRegisteredOn);
  const c = day(opts.collectedOn);
  if (a === "bad" || c === "bad") return { ok: false, message: "Use a date." };
  if ((a && a > opts.today) || (c && c > opts.today)) return { ok: false, message: "A date cannot be in the future." };
  const owedNow: MilestoneKey[] = [];
  const out = await withTenant(opts.orgId, async (sql) => {
    const [p] = await sql<{ booked_on: Date | string; cancelled: boolean; had_m1: boolean; had_m2: boolean }[]>`
      SELECT booked_on, cancelled_at IS NOT NULL AS cancelled,
             agreement_registered_on IS NOT NULL AS had_m1, collected_on IS NOT NULL AS had_m2
      FROM partner_payouts WHERE org_id = ${opts.orgId} AND id = ${opts.payoutId}`;
    if (!p) return "That booking is not here.";
    if (p.cancelled) return "This booking was cancelled.";
    const booked = typeof p.booked_on === "string" ? p.booked_on.slice(0, 10) : p.booked_on.toISOString().slice(0, 10);
    if ((a && a < booked) || (c && c < booked)) return "A date cannot be before the booking.";
    // A half already invoiced keeps the date it was owed from.
    const locked = await sql<{ key: string }[]>`
      SELECT key FROM payout_milestones WHERE org_id = ${opts.orgId} AND payout_id = ${opts.payoutId} AND stage <> 'NONE'`;
    const lockedKeys = new Set(locked.map((l) => l.key));
    await sql`
      UPDATE partner_payouts SET
        agreement_registered_on = ${lockedKeys.has("M1") ? sql`agreement_registered_on` : sql`${a}`},
        collected_on = ${lockedKeys.has("M2") ? sql`collected_on` : sql`${c}`},
        updated_at = now()
      WHERE org_id = ${opts.orgId} AND id = ${opts.payoutId}`;
    if (!p.had_m1 && a && !lockedKeys.has("M1")) owedNow.push("M1");
    if (!p.had_m2 && c && !lockedKeys.has("M2")) owedNow.push("M2");
    return null;
  });
  if (out) return { ok: false, message: out };
  for (const key of owedNow) await notifyPayout(opts.orgId, opts.payoutId, { kind: "half", key });
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.booking_dates", targetType: "partner_payout", targetId: opts.payoutId, metadata: { agreement: !!a, collected: !!c } });
  return { ok: true, message: "Saved." };
}

/** Correct the pass-back while nothing has been invoiced. Both halves are worked out again. */
export async function setPassBack(opts: { orgId: string; userId: string; payoutId: string; passBack: number }): Promise<{ ok: boolean; message: string }> {
  const out = await withTenant(opts.orgId, async (sql) => {
    const [p] = await sql<{ agreement: string; rate: string; gst_registered: boolean; scope_node_id: string; cancelled: boolean; kind: string }[]>`
      SELECT agreement, rate, gst_registered, scope_node_id, cancelled_at IS NOT NULL AS cancelled, kind
      FROM partner_payouts WHERE org_id = ${opts.orgId} AND id = ${opts.payoutId}`;
    if (!p || p.cancelled) return "That booking is not open.";
    if (p.kind !== "PARTNER") return "A mandate firm's commission has no pass-back.";
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payout_milestones WHERE org_id = ${opts.orgId} AND payout_id = ${opts.payoutId} AND stage <> 'NONE'`;
    if (n) return "A half is already invoiced, so the amounts are fixed.";
    const [t] = await sql<TermsRow[]>`
      SELECT id, steps, pass_back_max, registration_days, visit_extends_days FROM commission_terms
      WHERE org_id = ${opts.orgId} AND scope_node_id = ${p.scope_node_id}`;
    const terms = termsOf(t);
    const rate = Number(p.rate);
    const made = payoutFor({ agreement: Number(p.agreement), steps: [{ from: 1, rate }], booked: 0, passBack: opts.passBack, passBackMax: terms.passBackMax, gstRegistered: p.gst_registered });
    if (!made.ok) return made.message;
    await sql`UPDATE partner_payouts SET pass_back = ${made.payout.passBack}, updated_at = now() WHERE org_id = ${opts.orgId} AND id = ${opts.payoutId}`;
    for (const key of ["M1", "M2"] as const) {
      const m: Invoice = made.payout.milestones[key];
      await sql`
        UPDATE payout_milestones SET base = ${m.base}, gst = ${m.gst}, gross = ${m.gross}, tds = ${m.tds}, net = ${m.net}
        WHERE org_id = ${opts.orgId} AND payout_id = ${opts.payoutId} AND key = ${key} AND stage = 'NONE'`;
    }
    return null;
  });
  if (out) return { ok: false, message: out };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.pass_back", targetType: "partner_payout", targetId: opts.payoutId });
  return { ok: true, message: "Pass-back saved. Both halves are worked out again." };
}

export const INVOICE_MAX_BYTES = 10 * 1024 * 1024;
export const INVOICE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

/** The firm's invoice for a half that is owed, kept in the file store by key. */
export async function fileInvoice(opts: {
  orgId: string;
  userId: string;
  milestoneId: string;
  invoiceNo: string;
  invoiceDate: string;
  amount: number;
  bytes: Buffer;
  mediaType: string;
  today: string;
  /**
   * The firm filing its own invoice from its own console: that is the firm's
   * confirmation too, so no WhatsApp code is asked for it afterwards.
   */
  byFirm?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const no = opts.invoiceNo.trim();
  if (!no || no.length > 40) return { ok: false, message: "Enter the invoice number." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.invoiceDate) || opts.invoiceDate > opts.today) return { ok: false, message: "Enter the invoice date." };
  if (!(opts.amount > 0) || !Number.isInteger(opts.amount)) return { ok: false, message: "Enter the invoice total in rupees." };
  if (!(INVOICE_TYPES as readonly string[]).includes(opts.mediaType)) return { ok: false, message: "Attach a PDF, JPEG or PNG." };
  if (!opts.bytes.byteLength || opts.bytes.byteLength > INVOICE_MAX_BYTES) return { ok: false, message: "Attach a file under 10 MB." };

  const m = await withTenant(opts.orgId, (sql) => milestone(sql, opts.orgId, opts.milestoneId));
  if (!m) return { ok: false, message: "That payout is not here." };
  if (m.cancelled) return { ok: false, message: "This booking was cancelled." };
  if (!m.owed) return { ok: false, message: "This half is not owed yet." };
  if (m.stage !== "NONE") return { ok: false, message: "An invoice is already on file for this half." };

  const id = randomUUID();
  const put = await putAsset({ orgId: opts.orgId, project: await projectOfNode(opts.orgId, m.node_id), kind: "invoice", id, bytes: opts.bytes, contentType: opts.mediaType });
  if (!put.ok) return { ok: false, message: put.message };
  const done = await withTenant(opts.orgId, async (sql) => {
    const moved = await sql`
      UPDATE payout_milestones SET stage = 'INVOICED' WHERE org_id = ${opts.orgId} AND id = ${opts.milestoneId} AND stage = 'NONE'`;
    if (!moved.count) return false;
    const [p] = await sql<{ cp_org_id: string }[]>`SELECT cp_org_id FROM partner_payouts WHERE org_id = ${opts.orgId} AND id = ${m.payout_id}`;
    await sql`
      INSERT INTO partner_invoices (id, org_id, milestone_id, cp_org_id, invoice_no, invoice_date, amount, storage_key, media_type, bytes, uploaded_by,
                                    attested_at, attested_by)
      VALUES (${id}, ${opts.orgId}, ${opts.milestoneId}, ${p.cp_org_id}, ${no}, ${opts.invoiceDate}, ${opts.amount}, ${put.key},
              ${opts.mediaType}, ${opts.bytes.byteLength}, ${opts.userId},
              ${opts.byFirm ? new Date() : null}, ${opts.byFirm ? opts.userId : null})`;
    return true;
  });
  if (!done) return { ok: false, message: "Somebody filed an invoice for this half a moment ago." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.invoice_filed", targetType: "payout_milestone", targetId: opts.milestoneId, metadata: { bytes: opts.bytes.byteLength, type: opts.mediaType, via: opts.byFirm ? "firm" : "desk" } });
  await notifyPayout(opts.orgId, m.payout_id, { kind: "half", key: m.key });
  const expected = Number(m.gross);
  return {
    ok: true,
    message: opts.amount === expected ? "Invoice filed." : `Invoice filed. It says Rs ${opts.amount.toLocaleString("en-IN")}; Rs ${expected.toLocaleString("en-IN")} is owed.`,
  };
}

export type MilestoneMove = { kind: "verify" } | { kind: "reject"; reason?: RejectReason } | { kind: "approve" } | { kind: "pay"; utr: string; paidOn: string };

/**
 * One step along a half. Each step is asked of the row as it stands, so a
 * second press, or two people at once, moves it once.
 */
export async function moveMilestone(opts: { orgId: string; userId: string; milestoneId: string; move: MilestoneMove; today: string }): Promise<{ ok: boolean; message: string }> {
  const mv = opts.move;
  let utr: string | null = null;
  if (mv.kind === "pay") {
    utr = cleanUtr(mv.utr);
    if (!utr) return { ok: false, message: "Enter the UTR from the bank, letters and digits." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(mv.paidOn) || mv.paidOn > opts.today) return { ok: false, message: "Enter the day it was paid." };
  }
  let moved: MilestoneRow | null = null;
  let adjusted = 0;
  const out = await withTenant(opts.orgId, async (sql) => {
    const m = await milestone(sql, opts.orgId, opts.milestoneId);
    if (!m) return "That payout is not here.";
    moved = m;
    if (m.cancelled && mv.kind !== "reject") return "This booking was cancelled.";
    const [inv] = await sql<{ id: string; amount: string }[]>`
      SELECT id, amount FROM partner_invoices
      WHERE org_id = ${opts.orgId} AND milestone_id = ${opts.milestoneId} AND rejected_at IS NULL
      ORDER BY created_at DESC LIMIT 1`;
    if (mv.kind === "verify") {
      if (!inv) return "There is no invoice on file.";
      if (Number(inv.amount) !== Number(m.gross)) return `The invoice says Rs ${Number(inv.amount).toLocaleString("en-IN")}, and Rs ${Number(m.gross).toLocaleString("en-IN")} is owed. Reject it and ask for a corrected one.`;
      // A firm with somebody on WhatsApp confirms its own invoice first.
      const [w] = await sql<{ waiting: boolean }[]>`
        SELECT i.attested_at IS NULL AND EXISTS (
                 SELECT 1 FROM partner_agents a WHERE a.org_id = i.org_id AND a.cp_org_id = i.cp_org_id AND a.status = 'ACTIVE') AS waiting
        FROM partner_invoices i WHERE i.org_id = ${opts.orgId} AND i.id = ${inv.id}`;
      if (w?.waiting) return "The firm hasn't confirmed this invoice on WhatsApp yet.";
      const n = await sql`UPDATE payout_milestones SET stage = 'VERIFIED', verified_by = ${opts.userId}, verified_at = now()
                          WHERE org_id = ${opts.orgId} AND id = ${opts.milestoneId} AND stage = 'INVOICED'`;
      return n.count ? null : "This has moved since you opened it.";
    }
    if (mv.kind === "reject") {
      const n = await sql`UPDATE payout_milestones SET stage = 'NONE' WHERE org_id = ${opts.orgId} AND id = ${opts.milestoneId} AND stage = 'INVOICED'`;
      if (!n.count) return "Only an invoice waiting to be checked can be rejected.";
      // Why, in a fixed code the firm reads in its own words (0104).
      if (inv) {
        await sql`UPDATE partner_invoices SET rejected_at = now(), rejected_by = ${opts.userId}, reject_reason = ${mv.reason ?? "OTHER"}
                  WHERE org_id = ${opts.orgId} AND id = ${inv.id}`;
      }
      return null;
    }
    if (mv.kind === "approve") {
      const n = await sql`UPDATE payout_milestones SET stage = 'APPROVED', approved_by = ${opts.userId}, approved_at = now()
                          WHERE org_id = ${opts.orgId} AND id = ${opts.milestoneId} AND stage = 'VERIFIED'`;
      if (!n.count) return "This has moved since you opened it.";
      // Money a cancelled booking owes back comes off this half before it is paid.
      const [p] = await sql<{ cp_org_id: string; payer_mandate_id: string | null; kind: string }[]>`
        SELECT cp_org_id, payer_mandate_id, kind FROM partner_payouts WHERE org_id = ${opts.orgId} AND id = ${m.payout_id}`;
      if (p?.kind === "PARTNER") {
        const set = await settleDebits(sql, opts.orgId, p.cp_org_id, p.payer_mandate_id);
        adjusted = set.filter((u) => u.halfId === opts.milestoneId).reduce((sum, u) => sum + u.amount, 0);
      }
      return null;
    }
    const n = await sql`UPDATE payout_milestones SET stage = 'PAID', paid_by = ${opts.userId}, paid_at = now(), paid_on = ${mv.paidOn}, utr = ${utr}
                        WHERE org_id = ${opts.orgId} AND id = ${opts.milestoneId} AND stage = 'APPROVED'`;
    return n.count ? null : "Only an approved payout can be marked paid.";
  });
  if (out) return { ok: false, message: out };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: `partner.payout_${mv.kind === "pay" ? "paid" : mv.kind === "verify" ? "verified" : mv.kind === "reject" ? "invoice_rejected" : "approved"}`, targetType: "payout_milestone", targetId: opts.milestoneId, ...(adjusted ? { metadata: { adjusted } } : {}) });
  const done = moved as MilestoneRow | null;
  if (done) await notifyPayout(opts.orgId, done.payout_id, adjusted ? { kind: "adjusted", key: done.key, amount: adjusted } : { kind: "half", key: done.key });
  if (adjusted && mv.kind === "approve") {
    return { ok: true, message: `Approved. Rs ${adjusted.toLocaleString("en-IN")} comes off it against a cancelled booking.` };
  }
  const said = { verify: "Invoice verified.", reject: "Invoice rejected.", approve: "Approved.", pay: "Marked paid." };
  return { ok: true, message: said[mv.kind] };
}

/** An invoice's key and type, once the reader has passed the permission check at its node. */
export async function invoiceFile(orgId: string, invoiceId: string): Promise<{ key: string; type: string; path: string } | null> {
  if (!isId(invoiceId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ storage_key: string; media_type: string; path: string }[]>`
      SELECT i.storage_key, i.media_type, n.path::text AS path
      FROM partner_invoices i JOIN payout_milestones m ON m.id = i.milestone_id
      JOIN partner_payouts p ON p.id = m.payout_id JOIN scope_nodes n ON n.id = p.scope_node_id
      WHERE i.org_id = ${orgId} AND i.id = ${invoiceId}`;
    return r ? { key: r.storage_key, type: r.media_type, path: r.path } : null;
  });
}

// ---------------------------------------------------------------------------
// A partner's link, and the lead and claim a tap on it makes
// ---------------------------------------------------------------------------

/** How many times a fresh code is drawn before giving up on a clash. */
const CODE_TRIES = 6;

/**
 * A link for one firm to one tower's enquiry page, carrying a ref code. Made
 * only while the firm may register buyers there and the tower may be
 * advertised: a co-branded post is an advertisement.
 */
export async function makeLink(opts: {
  orgId: string;
  userId: string;
  firmId: string;
  phaseId: string;
  agentName: string | null;
  nowIso?: string;
}): Promise<{ ok: true; id: string; code: string } | { ok: false; message: string }> {
  const now = opts.nowIso ?? new Date().toISOString();
  if (!isId(opts.firmId) || !isId(opts.phaseId)) return { ok: false, message: "Choose a firm and a tower." };
  const agent = opts.agentName?.trim().slice(0, 120) || null;
  const gate = await canPublish(opts.orgId, opts.phaseId, new Date(now));
  if (!gate.ok) return { ok: false, message: gate.message };
  const made = await withTenant(opts.orgId, async (sql) => {
    const [firm] = await sql<{ cp_org_id: string; name: string; rera_agent_no: string | null; rera_valid_till: Date | string | null; mandate_id: string | null }[]>`
      SELECT cp_org_id, name, rera_agent_no, rera_valid_till, mandate_id FROM partner_firms WHERE org_id = ${opts.orgId} AND id = ${opts.firmId}`;
    if (!firm) return { ok: false as const, message: "That firm is not on your desk." };
    const till = firm.rera_valid_till ? (typeof firm.rera_valid_till === "string" ? firm.rera_valid_till.slice(0, 10) : istDay(firm.rera_valid_till.toISOString())) : null;
    if (!firm.rera_agent_no || !till || till < istDay(now)) {
      return { ok: false as const, message: `${firm.name} needs a current MahaRERA agent registration on file first.` };
    }
    const [place] = await sql<{ project_id: string; project: string }[]>`
      SELECT p.id AS project_id, p.name AS project FROM scope_nodes t
      JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
      WHERE t.org_id = ${opts.orgId} AND t.id = ${opts.phaseId} AND t.kind = 'PHASE'`;
    if (!place) return { ok: false as const, message: "That tower is not here." };
    const [grant] = await sql<{ status: GrantState["status"]; valid_from: Date; valid_to: Date }[]>`
      SELECT status, valid_from, valid_to FROM grants
      WHERE org_id = ${opts.orgId} AND grantee_org_id = ${firm.cp_org_id} AND scope_node_id = ${place.project_id} AND status <> 'ENDED'
        AND mandate_id IS NOT DISTINCT FROM ${firm.mandate_id}
      LIMIT 1`;
    if (!grant || !grantLive({ status: grant.status, validFrom: grant.valid_from.toISOString(), validTo: grant.valid_to.toISOString() }, now)) {
      return { ok: false as const, message: `${firm.name} is not empanelled on ${place.project} right now.` };
    }
    for (let i = 0; i < CODE_TRIES; i++) {
      const code = refCode(place.project, firm.name, randomInt(0, 10000));
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO partner_links (org_id, firm_id, cp_org_id, scope_node_id, code, agent_name, created_by)
        VALUES (${opts.orgId}, ${opts.firmId}, ${firm.cp_org_id}, ${opts.phaseId}, ${code}, ${agent}, ${opts.userId})
        ON CONFLICT (org_id, code) DO NOTHING
        RETURNING id`;
      if (row) return { ok: true as const, id: row.id, code };
    }
    return { ok: false as const, message: "Could not find a free code. Try again." };
  });
  if (made.ok) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.link_made", targetType: "partner_link", targetId: made.id });
  }
  return made;
}

/** A retired link still lands a buyer on the page; it just claims nobody for the firm. */
export async function retireLink(opts: { orgId: string; userId: string; linkId: string }): Promise<{ ok: boolean; message: string }> {
  if (!isId(opts.linkId)) return { ok: false, message: "That link is not here." };
  const n = await withTenant(opts.orgId, (sql) => sql`
    UPDATE partner_links SET retired_at = now() WHERE org_id = ${opts.orgId} AND id = ${opts.linkId} AND retired_at IS NULL`);
  if (!n.count) return { ok: false, message: "That link is already retired." };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "partner.link_retired", targetType: "partner_link", targetId: opts.linkId });
  return { ok: true, message: "Retired. New enquiries through it are the developer's own." };
}

/** Where a link sits, for the permission check. */
export async function linkPath(orgId: string, linkId: string): Promise<string | null> {
  if (!isId(linkId)) return null;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ path: string }[]>`
      SELECT n.path::text AS path FROM partner_links l JOIN scope_nodes n ON n.id = l.scope_node_id
      WHERE l.org_id = ${orgId} AND l.id = ${linkId}`;
    return r?.path ?? null;
  });
}

/**
 * A buyer who came through a partner's link: the claim is decided inside the
 * capture's own transaction, so the lead and the claim land together or not
 * at all. The verdict is the ordinary one, so a link cannot claim a buyer
 * somebody already holds, or one who came direct first.
 */
export async function registerFromLink(
  sql: Sql,
  orgId: string,
  o: { code: string; phone: string; buyerName: string | null; leadId: string | null; nodeId: string },
): Promise<RegisterResult | null> {
  const [link] = await sql<{ firm_id: string; agent_name: string | null; project_id: string }[]>`
    SELECT l.firm_id, l.agent_name, p.id AS project_id
    FROM partner_links l
    JOIN scope_nodes t ON t.id = l.scope_node_id
    JOIN scope_nodes p ON p.org_id = l.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
    WHERE l.org_id = ${orgId} AND l.code = ${o.code} AND l.retired_at IS NULL
      AND p.path @> (SELECT path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${o.nodeId})`;
  if (!link) return null;
  return registerBuyer({
    orgId,
    userId: null,
    firmId: link.firm_id,
    projectId: link.project_id,
    phone: o.phone,
    buyerName: o.buyerName,
    agentName: link.agent_name,
    via: "LINK",
    refCode: o.code,
    leadId: o.leadId,
    sql,
  });
}

// ---------------------------------------------------------------------------
// A partner's buyer's number, on the desk
// ---------------------------------------------------------------------------

/**
 * The whole number behind one registration, to somebody allowed it, with a
 * row saying so. The desk shows every number masked; this is the one way
 * past the mask, and it counts against the same daily allowance as a lead's.
 */
export async function revealRegistration(opts: {
  orgId: string;
  userId: string;
  registrationId: string;
  mayAt: (path: string) => boolean;
  now?: Date;
}): Promise<{ ok: true; phone: string } | { ok: false; message: string }> {
  const missing = { ok: false as const, message: "That registration is not there any more." };
  if (!isId(opts.registrationId)) return missing;
  const now = opts.now ?? new Date();
  const dayStart = new Date(Math.floor((now.getTime() + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000);
  const found = await withTenant(opts.orgId, async (sql) => {
    const [r] = await sql<{ phone: string | null; path: string }[]>`
      SELECT r.phone, n.path::text AS path FROM client_registrations r JOIN scope_nodes n ON n.id = r.scope_node_id
      WHERE r.org_id = ${opts.orgId} AND r.id = ${opts.registrationId}`;
    // An erased buyer's registration keeps no number to show.
    if (!r || !r.phone) return null;
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE org_id = ${opts.orgId} AND actor_user_id = ${opts.userId}
        AND action IN ('lead.phone_unmasked', 'partner.number_unmasked') AND created_at >= ${dayStart}`;
    return { phone: r.phone, path: r.path, today: n };
  });
  if (!found) return missing;
  if (!opts.mayAt(found.path)) return { ok: false, message: "Your role cannot see whole numbers here." };
  if (found.today >= REVEALS_PER_DAY) return { ok: false, message: `You have seen ${REVEALS_PER_DAY} numbers today. More from midnight.` };
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "partner.number_unmasked",
    targetType: "client_registration",
    targetId: opts.registrationId,
    metadata: { phone: auditHash(found.phone), by: "desk" },
  });
  return { ok: true, phone: spacedPhone(found.phone) };
}

/**
 * The desk a registration `r` belongs to, as SQL: the desk of the grant it
 * was made under, or for a refusal made with no grant, the firm's first desk
 * here. A partner may sit on two desks of one developer (0092).
 */
const REG_DESK = `(CASE WHEN r.grant_id IS NOT NULL THEN (SELECT dg.mandate_id FROM grants dg WHERE dg.id = r.grant_id)
  ELSE (SELECT df.mandate_id FROM partner_firms df WHERE df.org_id = r.org_id AND df.cp_org_id = r.cp_org_id ORDER BY df.created_at LIMIT 1) END)`;

/** Registrations of one whole number, inside the viewer's reach: the desk's search, done here. */
export async function findRegistrations(orgId: string, raw: string, scopes: string[], desk: WorkDesk = { kind: "OWN" }): Promise<string[]> {
  const phone = normalisePhone(raw);
  if (!phone || !scopes.length) return [];
  const rows = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    SELECT r.id FROM client_registrations r JOIN scope_nodes n ON n.id = r.scope_node_id
    WHERE r.org_id = ${orgId} AND r.phone = ${phone} AND n.path <@ ANY(${scopes}::ltree[])
      AND EXISTS (SELECT 1 FROM partner_firms f WHERE f.org_id = r.org_id AND f.cp_org_id = r.cp_org_id)
      AND ${desk.kind === "OWN" ? sql`${sql.unsafe(REG_DESK)} IS NULL` : sql`${sql.unsafe(REG_DESK)} = ANY(${desk.mandateIds}::uuid[])`} LIMIT 50`);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------

export type ProjectOption = {
  id: string;
  name: string;
  path: string;
  terms: Terms;
  termsSet: boolean;
  phases: { id: string; name: string }[];
  /** On a mandate firm's desk, the mandate's last day: nothing it empanels runs past it. */
  until?: string;
};

export type FirmOption = {
  id: string;
  name: string;
  pan: string;
  gstin: string | null;
  legalName: string;
  reraNo: string | null;
  reraTill: string | null;
  competencyTill: string | null;
  principalName: string | null;
  principalPhone: string | null;
  area: string | null;
  rmId: string | null;
  grants: { id: string; projectId: string; project: string; status: GrantState["status"]; validTo: string; reason: string | null; live: boolean }[];
};

export type PartnerLink = {
  id: string;
  firmId: string;
  code: string;
  phaseId: string;
  tower: string;
  projectId: string;
  agent: string | null;
  url: string | null;
  /** The link opens WhatsApp to the developer's number, not the enquiry page. */
  whatsapp: boolean;
  enquiries: number;
  claims: number;
  retired: boolean;
};

/** A post a partner may carry: passed, a picture, and made for this project. */
export type PartnerPost = { id: string; projectId: string; kind: "IMAGE" | "CAROUSEL"; placement: string; headline: string; frames: number };

/** Somebody at a firm who may use this developer's WhatsApp for it. */
export type PartnerAgent = {
  id: string;
  firmId: string;
  name: string;
  /** Their own business number, as they gave it. Not a buyer's. */
  phone: string;
  principal: boolean;
  status: "WAITING" | "ACTIVE";
  since: string | null;
  muted: boolean;
};

export type Desk = {
  real: boolean;
  agents: PartnerAgent[];
  links: PartnerLink[];
  posts: PartnerPost[];
  firms: Firm[];
  registrations: (Registration & { projectId?: string; live?: boolean; leadId?: string | null; canReveal?: boolean; linkable?: boolean })[];
  bookings: Booking[];
  projects: ProjectOption[];
  firmOptions: FirmOption[];
  settings: PartnerSettings;
  people: { id: string; name: string }[];
  /** Booked leads no partner is paid on, which a person may link a registration to by hand. */
  unclaimedBookings?: { id: string; label: string }[];
};

const dayOf = (d: Date | string | null): string | null =>
  d === null ? null : typeof d === "string" ? d.slice(0, 10) : istDay(d.toISOString());

/**
 * Everything the partner desk draws, filtered by where the viewer holds each
 * key. `partnerScopes` filters firms and registrations, `payoutScopes`
 * bookings; an empty list is none.
 */
export async function loadDesk(opts: {
  orgId: string;
  partnerScopes: string[];
  payoutScopes: string[];
  /** Where the viewer may see a whole number, one at a time. */
  unmaskScopes?: string[];
  nowIso?: string;
  /** Whose desk: the developer's own partners, or a mandate firm's. Nothing of one shows on the other. */
  desk?: WorkDesk;
  /** Who may look after a firm, when that is not the developer's members (a mandate firm's people). */
  people?: { id: string; name: string }[];
}): Promise<Desk> {
  const now = opts.nowIso ?? new Date().toISOString();
  const today = istDay(now);
  const scopes = [...new Set([...opts.partnerScopes, ...opts.payoutScopes])];
  const desk: WorkDesk = opts.desk ?? { kind: "OWN" };
  const mandateIds = desk.kind === "MANDATE" ? desk.mandateIds : [];
  return withTenant(opts.orgId, async (sql) => {
    const inScope = (list: string[]) => (list.length ? sql`n.path <@ ANY(${list}::ltree[])` : sql`false`);
    const onDesk = (col: string) =>
      desk.kind === "OWN" ? sql`${sql.unsafe(col)} IS NULL` : sql`${sql.unsafe(col)} = ANY(${mandateIds}::uuid[])`;
    const firmOnDesk = (alias: string, cpCol: string) => sql`EXISTS (SELECT 1 FROM partner_firms df
      WHERE df.org_id = ${sql.unsafe(alias)}.org_id AND df.cp_org_id = ${sql.unsafe(cpCol)} AND ${onDesk("df.mandate_id")})`;
    const projects = await sql<(TermsRow & { pid: string; name: string; path: string; tid: string | null; until: string | null })[]>`
      SELECT n.id AS pid, n.name, n.path::text AS path, t.id AS tid, t.id, t.steps, t.pass_back_max, t.registration_days, t.visit_extends_days, t.ladder_period, t.second_half,
             ${desk.kind === "MANDATE"
               ? sql`(SELECT to_char((max(m.valid_to) - interval '1 second') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')
                      FROM mandates m JOIN mandate_projects mp ON mp.mandate_id = m.id
                      WHERE m.id = ANY(${mandateIds}::uuid[]) AND mp.scope_node_id = n.id)`
               : sql`NULL::text`} AS until
      FROM scope_nodes n LEFT JOIN commission_terms t ON t.org_id = n.org_id AND t.scope_node_id = n.id AND ${onDesk("t.mandate_id")}
      WHERE n.org_id = ${opts.orgId} AND n.kind = 'PROJECT' AND ${inScope(scopes)}
        ${desk.kind === "MANDATE" ? sql`AND n.id IN (SELECT mp.scope_node_id FROM mandate_projects mp WHERE mp.mandate_id = ANY(${mandateIds}::uuid[]))` : sql``}
      ORDER BY n.name`;
    const phases = await sql<{ id: string; name: string; path: string }[]>`
      SELECT n.id, n.name, n.path::text AS path FROM scope_nodes n
      WHERE n.org_id = ${opts.orgId} AND n.kind = 'PHASE' AND ${inScope(scopes)} ORDER BY n.name`;
    const firms = await sql<{
      id: string; cp_org_id: string; name: string; legal_name: string; pan: string; gstin: string | null; rera_agent_no: string | null;
      rera_valid_till: Date | string | null; competency_till: Date | string | null; principal_name: string | null; principal_phone: string | null;
      area: string | null; rm_id: string | null; rm_name: string | null; created_at: Date; mandate_id: string | null;
    }[]>`
      SELECT f.*, coalesce(u.name, split_part(u.email::text, '@', 1)) AS rm_name
      FROM partner_firms f LEFT JOIN users u ON u.id = f.rm_id
      WHERE f.org_id = ${opts.orgId} AND ${onDesk("f.mandate_id")} ORDER BY f.name`;
    const grants = await sql<{ id: string; grantee_org_id: string; scope_node_id: string; status: GrantState["status"]; valid_from: Date; valid_to: Date; suspended_reason: string | null; project: string; path: string; mandate_id: string | null }[]>`
      SELECT g.id, g.grantee_org_id, g.scope_node_id, g.status, g.valid_from, g.valid_to, g.suspended_reason, n.name AS project, n.path::text AS path, g.mandate_id
      FROM grants g JOIN scope_nodes n ON n.id = g.scope_node_id
      WHERE g.org_id = ${opts.orgId} AND g.role = 'CHANNEL_PARTNER' AND ${onDesk("g.mandate_id")} ORDER BY g.created_at`;
    const regs = opts.partnerScopes.length
      ? await sql<{
          id: string; cp_org_id: string; phone: string; buyer_name: string | null; agent_name: string | null; lead_id: string | null; via: "CONSOLE" | "LINK" | "WHATSAPP" | "WORKSPACE";
          verdict: Verdict; valid_until: Date | null; status: string; created_at: Date; project: string; scope_node_id: string;
          visited: Date | null; booked: Date | string | null; lead_name: string | null; path: string; desk: string | null;
        }[]>`
          SELECT ${sql.unsafe(REG_DESK)} AS desk, r.id, r.cp_org_id, r.phone, r.buyer_name, r.agent_name, r.lead_id, r.via, r.verdict, r.valid_until, r.status, r.created_at,
                 n.name AS project, r.scope_node_id, n.path::text AS path,
                 (SELECT min(coalesce(v.arrived_at, v.completed_at)) FROM site_visits v
                   WHERE v.org_id = r.org_id AND v.lead_id = r.lead_id AND v.status IN ('ON_SITE', 'VISITED')) AS visited,
                 (SELECT p.booked_on FROM partner_payouts p WHERE p.org_id = r.org_id AND p.registration_id = r.id AND p.cancelled_at IS NULL LIMIT 1) AS booked,
                 (SELECT l.name FROM leads l WHERE l.org_id = r.org_id AND l.id = r.lead_id) AS lead_name
          FROM client_registrations r JOIN scope_nodes n ON n.id = r.scope_node_id
          -- A repeat of a claim the firm already holds is logged, and is not a row of its own here.
          -- A claim shows on the desk it was made under, not on every desk the firm sits on (0092).
          WHERE r.org_id = ${opts.orgId} AND r.verdict <> 'ALREADY' AND ${inScope(opts.partnerScopes)} AND ${firmOnDesk("r", "r.cp_org_id")}
            AND ${onDesk(REG_DESK)}
          ORDER BY r.created_at DESC LIMIT 3000`
      : [];
    const pays = opts.payoutScopes.length
      ? await sql<{
          id: string; lead_id: string; cp_org_id: string; scope_node_id: string; unit: string | null; agreement: string; booking_no: number; rate: string; pass_back: string;
          gst_registered: boolean; booked_on: Date | string; agreement_registered_on: Date | string | null; collected_on: Date | string | null;
          cancelled_at: Date | null; buyer: string; place: string; agent: string | null; kind: "PARTNER" | "MANDATE"; mandate_firm: string | null;
          matched_by: MatchedBy | null; payer_mandate_id: string | null;
        }[]>`
          SELECT p.*, l.name AS buyer,
                 (SELECT m.firm_name FROM mandates m WHERE m.id = p.mandate_id) AS mandate_firm,
                 concat_ws(' · ', n.name, ph.name) AS place,
                 (SELECT r.agent_name FROM client_registrations r WHERE r.id = p.registration_id) AS agent
          FROM partner_payouts p JOIN scope_nodes n ON n.id = p.scope_node_id
          JOIN leads l ON l.id = p.lead_id LEFT JOIN scope_nodes ph ON ph.id = l.scope_node_id AND ph.kind = 'PHASE'
          WHERE p.org_id = ${opts.orgId} AND ${inScope(opts.payoutScopes)}
            -- The developer pays its own partners and its mandate firms; a mandate firm pays the partners it empanelled.
            AND ${desk.kind === "OWN"
              ? sql`(p.kind = 'MANDATE' OR p.payer_mandate_id IS NULL)`
              : sql`(p.kind = 'PARTNER' AND p.payer_mandate_id = ANY(${mandateIds}::uuid[]))`}
          ORDER BY p.booked_on DESC`
      : [];
    const payIds = pays.map((p) => p.id);
    const miles = payIds.length
      ? await sql<{ id: string; payout_id: string; key: MilestoneKey; base: string; gst: string; gross: string; tds: string; net: string; stage: keyof typeof STAGE_OF; paid_on: Date | string | null; utr: string | null }[]>`
          SELECT id, payout_id, key, base, gst, gross, tds, net, stage, paid_on, utr FROM payout_milestones
          WHERE org_id = ${opts.orgId} AND payout_id = ANY(${payIds})`
      : [];
    const invoices = miles.length
      ? await sql<{ id: string; milestone_id: string; invoice_no: string; invoice_date: Date | string; amount: string; attested_at: Date | null }[]>`
          SELECT DISTINCT ON (milestone_id) id, milestone_id, invoice_no, invoice_date, amount, attested_at FROM partner_invoices
          WHERE org_id = ${opts.orgId} AND milestone_id = ANY(${miles.map((m) => m.id)}) AND rejected_at IS NULL
          ORDER BY milestone_id, created_at DESC`
      : [];
    // What cancelled bookings took back, and what of it came off which half.
    const debitRows = payIds.length
      ? await sql<{ id: string; payout_id: string; amount: string; used: string }[]>`
          SELECT a.id, a.payout_id, a.amount,
                 coalesce((SELECT sum(u.amount) FROM partner_adjustment_uses u
                   JOIN payout_milestones ms ON ms.id = u.milestone_id JOIN partner_payouts p ON p.id = ms.payout_id
                   WHERE u.adjustment_id = a.id AND (ms.stage = 'PAID' OR p.cancelled_at IS NULL)), 0) AS used
          FROM partner_adjustments a WHERE a.org_id = ${opts.orgId} AND a.payout_id = ANY(${payIds})`
      : [];
    const useRows = miles.length
      ? await sql<{ milestone_id: string; amount: string; against: string | null }[]>`
          SELECT u.milestone_id, u.amount, coalesce(p.unit, l.name) AS against
          FROM partner_adjustment_uses u JOIN partner_adjustments a ON a.id = u.adjustment_id
          JOIN partner_payouts p ON p.id = a.payout_id JOIN leads l ON l.id = p.lead_id
          WHERE u.org_id = ${opts.orgId} AND u.milestone_id = ANY(${miles.map((m) => m.id)})`
      : [];
    // Booked leads no partner is paid on: what a registration may be linked to by hand.
    const unclaimed = opts.payoutScopes.length && opts.partnerScopes.length
      ? await sql<{ id: string; name: string; unit: string | null; place: string }[]>`
          SELECT l.id, l.name, l.facts ->> 'unit' AS unit, n.name AS place
          FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
          WHERE l.org_id = ${opts.orgId} AND l.stage = 'booked' AND ${inScope(opts.payoutScopes)}
            AND l.updated_at > now() - interval '180 days'
            AND NOT EXISTS (SELECT 1 FROM partner_payouts p WHERE p.org_id = l.org_id AND p.lead_id = l.id AND p.kind = 'PARTNER' AND p.cancelled_at IS NULL)
          ORDER BY l.updated_at DESC LIMIT 200`
      : [];
    const settings = await settingsIn(sql, opts.orgId);
    const linkRows = opts.partnerScopes.length
      ? await sql<{ id: string; firm_id: string; code: string; scope_node_id: string; tower: string; tower_path: string; project_id: string; project: string; agent_name: string | null; retired_at: Date | null; enquiries: number; claims: number }[]>`
          SELECT l.id, l.firm_id, l.code, l.scope_node_id, n.name AS tower, n.path::text AS tower_path, p.id AS project_id, p.name AS project,
                 l.agent_name, l.retired_at,
                 (SELECT count(*)::int FROM client_registrations r WHERE r.org_id = l.org_id AND r.ref_code = l.code) AS enquiries,
                 (SELECT count(*)::int FROM client_registrations r WHERE r.org_id = l.org_id AND r.ref_code = l.code AND r.verdict = 'REGISTERED') AS claims
          FROM partner_links l JOIN scope_nodes n ON n.id = l.scope_node_id
          JOIN scope_nodes p ON p.org_id = l.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
          WHERE l.org_id = ${opts.orgId} AND ${inScope(opts.partnerScopes)}
            AND EXISTS (SELECT 1 FROM partner_firms df WHERE df.id = l.firm_id AND ${onDesk("df.mandate_id")})
          ORDER BY l.created_at DESC`
      : [];
    const postRows = opts.partnerScopes.length
      ? await sql<{ id: string; project_id: string; kind: "IMAGE" | "CAROUSEL"; placement: string; headline: string; frames: number }[]>`
          SELECT r.id, p.id AS project_id, r.kind, r.placement, r.headline, jsonb_array_length(r.media)::int AS frames
          FROM rendered_posts r JOIN scope_nodes n ON n.id = r.scope_node_id
          JOIN scope_nodes p ON p.org_id = r.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
          WHERE r.org_id = ${opts.orgId} AND r.kind IN ('IMAGE', 'CAROUSEL')
            AND (r.review IS NULL OR (r.review ->> 'passed')::boolean)
            AND jsonb_array_length(r.media) > 0
            AND ${inScope(opts.partnerScopes)}
          ORDER BY r.created_at DESC LIMIT 60`
      : [];
    const agentRows = await sql<{
      id: string; firm_id: string; name: string; phone: string; is_principal: boolean; status: "WAITING" | "ACTIVE"; bound_at: Date | null; muted_at: Date | null;
    }[]>`
      SELECT id, firm_id, name, phone, is_principal, status, bound_at, muted_at FROM partner_agents
      WHERE org_id = ${opts.orgId} AND status <> 'REMOVED' ORDER BY is_principal DESC, created_at`;
    // Which number a buyer tapping each link would write to.
    const linkNumbers = new Map<string, string | null>();
    for (const l of linkRows) {
      if (!linkNumbers.has(l.tower_path)) linkNumbers.set(l.tower_path, (await numberAt(sql, opts.orgId, l.tower_path))?.phone ?? null);
    }
    const people = opts.people ?? await sql<{ id: string; name: string }[]>`
      SELECT DISTINCT u.id, coalesce(u.name, split_part(u.email::text, '@', 1)) AS name
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${opts.orgId} AND m.status = 'ACTIVE' AND u.erased_at IS NULL ORDER BY 2`;

    // A partner may have a row per desk; on a mandate firm's desk, one per mandate. Match the row of the desk asked for, else any.
    const firmFor = (cpOrgId: string, deskId?: string | null) =>
      firms.find((f) => f.cp_org_id === cpOrgId && (deskId === undefined || f.mandate_id === deskId)) ?? firms.find((f) => f.cp_org_id === cpOrgId);
    const termsByProject = new Map(projects.map((p) => [p.pid, termsOf(p.tid ? p : null)]));
    const scopeHas = (path: string, list: string[]) => list.some((s) => path === s || path.startsWith(`${s}.`));

    // --- bookings ------------------------------------------------------------
    const bookings: Booking[] = pays.map((p) => {
      const f = p.kind === "PARTNER" ? firmFor(p.cp_org_id, p.payer_mandate_id) : undefined;
      const ms = miles.filter((m) => m.payout_id === p.id);
      const progress = {} as Booking["progress"];
      const frozen = {} as Record<MilestoneKey, Invoice>;
      for (const key of ["M1", "M2"] as const) {
        const m = ms.find((x) => x.key === key);
        const inv = m ? invoices.find((i) => i.milestone_id === m.id) : undefined;
        progress[key] = {
          stage: m ? STAGE_OF[m.stage] : "none",
          id: m?.id,
          paidOn: dayOf(m?.paid_on ?? null) ?? undefined,
          utr: m?.utr ?? undefined,
          invoice: inv
            ? { id: inv.id, no: inv.invoice_no, date: dayOf(inv.invoice_date)!, amount: Number(inv.amount), attestedOn: inv.attested_at ? istDay(inv.attested_at.toISOString()) : null }
            : null,
        };
        if (m) frozen[key] = { base: Number(m.base), gst: Number(m.gst), gross: Number(m.gross), tds: Number(m.tds), net: Number(m.net) };
      }
      return {
        id: p.id,
        firmId: f?.id,
        unit: p.unit ?? "Unit",
        buyer: p.buyer,
        place: p.place,
        firm: p.kind === "MANDATE" ? p.mandate_firm ?? "Mandate firm" : f?.name ?? "A partner",
        mandate: p.kind === "MANDATE",
        agent: p.agent ?? "",
        gstRegistered: p.gst_registered,
        agreement: Number(p.agreement),
        rate: Number(p.rate),
        passBack: Number(p.pass_back),
        bookingNo: p.booking_no,
        bookedOn: dayOf(p.booked_on)!,
        registeredOn: dayOf(p.agreement_registered_on),
        collected: null,
        crossedOn: dayOf(p.collected_on),
        cancelled: !!p.cancelled_at,
        progress,
        frozen: ms.length === 2 ? frozen : undefined,
        firmOnWhatsApp: agentRows.some((a) => a.firm_id === f?.id && a.status === "ACTIVE"),
        matchedBy: p.matched_by && p.matched_by !== "PHONE" ? p.matched_by : undefined,
        adjusted: Object.fromEntries(
          (["M1", "M2"] as const).flatMap((key) => {
            const m = ms.find((x) => x.key === key);
            const uses = m ? useRows.filter((u) => u.milestone_id === m.id) : [];
            return uses.length ? [[key, uses.map((u) => ({ amount: Number(u.amount), against: u.against ?? "a cancelled booking" }))]] : [];
          }),
        ),
        clawback: (() => {
          const d = debitRows.find((x) => x.payout_id === p.id);
          return d ? { amount: -Number(d.amount), outstanding: Math.max(0, -Number(d.amount) - Number(d.used)) } : null;
        })(),
      } as Booking;
    });

    // --- registrations -------------------------------------------------------
    const claims = regs.filter((r) => r.verdict === "REGISTERED");
    const registrations: Desk["registrations"] = regs.map((r) => {
      const f = firmFor(r.cp_org_id, r.desk);
      let refused: Registration["refused"] = null;
      const reason = REFUSE_OF[r.verdict];
      if (reason) {
        const holder = r.verdict === "BLOCKED"
          ? claims.find((c) => c.phone === r.phone && c.scope_node_id === r.scope_node_id && c.cp_org_id !== r.cp_org_id && c.created_at <= r.created_at)
          : undefined;
        refused = {
          reason,
          holderFirm: holder ? firmFor(holder.cp_org_id, holder.desk)?.name : undefined,
          heldUntil: r.valid_until ? istDay(r.valid_until.toISOString()) : undefined,
        };
      }
      const until = r.valid_until ? istDay(r.valid_until.toISOString()) : undefined;
      return {
        id: r.id,
        firmId: f?.id,
        buyer: r.lead_name ?? r.buyer_name ?? "Buyer",
        // Masked here, on the server: the whole number never reaches the page.
        phone: r.phone ? maskPhone(r.phone) : "",
        canReveal: scopeHas(r.path, opts.unmaskScopes ?? []),
        firm: f?.name ?? "A partner",
        agent: r.agent_name ?? "",
        project: r.project,
        projectId: r.scope_node_id,
        registeredOn: istDay(r.created_at.toISOString()),
        validUntil: r.verdict === "REGISTERED" ? (r.status === "RELEASED" && until && until > today ? today : until) : undefined,
        via: VIA_OF[r.via],
        visitedOn: r.visited ? istDay(r.visited.toISOString()) : null,
        bookedOn: dayOf(r.booked),
        refused,
        live: r.verdict === "REGISTERED" && r.status === "ACTIVE" && !!r.valid_until && r.valid_until.toISOString() > now,
        leadId: r.lead_id,
        // Live, or lapsed inside the window a person may still link it to a booking by hand.
        linkable: r.verdict === "REGISTERED" && (r.status === "ACTIVE" || r.status === "RELEASED") && !!r.valid_until
          && r.valid_until.getTime() > Date.parse(now) - LINK_LAPSED_DAYS * DAY_MS,
      };
    });

    // --- firms ---------------------------------------------------------------
    // A row's grants are its own desk's: a partner with two rows on a mandate firm's desk (two mandates) shows each with its own.
    const firmGrants = (f: { cp_org_id: string; mandate_id: string | null }) =>
      grants.filter((g) => g.grantee_org_id === f.cp_org_id && g.mandate_id === f.mandate_id);
    const visibleFirm = (f: { cp_org_id: string; mandate_id: string | null }) => {
      const gs = firmGrants(f);
      return gs.length === 0 ? opts.partnerScopes.length > 0 : gs.some((g) => scopeHas(g.path, scopes));
    };
    const yearAgo = new Date(Date.parse(now) - 365 * DAY_MS).toISOString().slice(0, 10);
    const outFirms: Firm[] = firms.filter((f) => visibleFirm(f)).map((f) => {
      const mine = bookings.filter((b) => b.firmId === f.id && !b.cancelled);
      const projectsOf = firmGrants(f)
        .filter((g) => g.status !== "ENDED" || !firmGrants(f).some((o) => o.scope_node_id === g.scope_node_id && o.status !== "ENDED"))
        .map((g) => {
          const terms = termsByProject.get(g.scope_node_id) ?? DEFAULT_TERMS;
          // Counted over the project's ladder period: every booking, this quarter's or this year's.
          const booked = bookingsCounted(
            pays
              .filter((p) => p.cp_org_id === f.cp_org_id && p.kind === "PARTNER" && p.payer_mandate_id === f.mandate_id && !p.cancelled_at && p.scope_node_id === g.scope_node_id)
              .map((p) => dayOf(p.booked_on)!),
            terms.ladderPeriod,
            today,
          );
          const st = grantStatus({ status: g.status, validFrom: g.valid_from.toISOString(), validTo: g.valid_to.toISOString() }, now);
          return {
            name: g.project,
            grantId: g.id,
            status: st,
            validTo: istDay(g.valid_to.toISOString()),
            booked,
            rate: rateFor(terms.steps, booked + 1),
            next: nextStep(terms.steps, booked),
          };
        });
      const agents = new Set([
        ...agentRows.filter((a) => a.firm_id === f.id).map((a) => a.name.toLowerCase()),
        ...regs.filter((r) => r.cp_org_id === f.cp_org_id && r.agent_name).map((r) => r.agent_name!.toLowerCase()),
      ]);
      return {
        id: f.id,
        name: f.name,
        area: f.area,
        principal: f.principal_name,
        phone: f.principal_phone,
        rm: f.rm_name,
        rera: f.rera_agent_no,
        reraTill: dayOf(f.rera_valid_till),
        competencyTill: dayOf(f.competency_till),
        pan: f.pan,
        gstin: f.gstin,
        agents: agents.size,
        projects: projectsOf,
        joinedOn: istDay(f.created_at.toISOString()),
        bookingsYear: mine.filter((b) => b.bookedOn > yearAgo).length,
      };
    });

    const firmOptions: FirmOption[] = firms.filter((f) => visibleFirm(f)).map((f) => ({
      id: f.id,
      name: f.name,
      pan: f.pan,
      gstin: f.gstin,
      legalName: f.legal_name,
      reraNo: f.rera_agent_no,
      reraTill: dayOf(f.rera_valid_till),
      competencyTill: dayOf(f.competency_till),
      principalName: f.principal_name,
      principalPhone: f.principal_phone,
      area: f.area,
      rmId: f.rm_id,
      grants: firmGrants(f).map((g) => ({
        id: g.id,
        projectId: g.scope_node_id,
        project: g.project,
        status: g.status,
        validTo: istDay(g.valid_to.toISOString()),
        reason: g.suspended_reason,
        live: grantLive({ status: g.status, validFrom: g.valid_from.toISOString(), validTo: g.valid_to.toISOString() }, now),
      })),
    }));

    const visibleIds = new Set(outFirms.map((f) => f.id));
    return {
      // A mandate firm's payouts are real before any partner is empanelled.
      real: firms.length > 0 || pays.length > 0,
      agents: agentRows
        .filter((a) => visibleIds.has(a.firm_id))
        .map((a) => ({
          id: a.id,
          firmId: a.firm_id,
          name: a.name,
          phone: spacedPhone(a.phone),
          principal: a.is_principal,
          status: a.status,
          since: a.bound_at ? istDay(a.bound_at.toISOString()) : null,
          muted: !!a.muted_at,
        })),
      links: linkRows.map((l) => {
        const base = enquiryUrl(opts.orgId, l.scope_node_id);
        const number = linkNumbers.get(l.tower_path) ?? null;
        return {
          id: l.id,
          firmId: l.firm_id,
          code: l.code,
          phaseId: l.scope_node_id,
          tower: l.tower,
          projectId: l.project_id,
          agent: l.agent_name,
          url: number ? waMeLink(number, tapText(l.project, l.code)) : base ? `${base}&cp=${l.code}` : null,
          whatsapp: !!number,
          enquiries: l.enquiries,
          claims: l.claims,
          retired: !!l.retired_at,
        };
      }),
      posts: postRows.map((r) => ({ id: r.id, projectId: r.project_id, kind: r.kind, placement: r.placement, headline: r.headline, frames: r.frames })),
      firms: outFirms,
      registrations,
      bookings,
      projects: projects.map((p) => ({
        id: p.pid,
        name: p.name,
        path: p.path,
        terms: termsOf(p.tid ? p : null),
        termsSet: !!p.tid,
        phases: phases.filter((ph) => ph.path.startsWith(`${p.path}.`)).map((ph) => ({ id: ph.id, name: ph.name })),
        ...(p.until ? { until: p.until } : {}),
      })),
      firmOptions,
      settings,
      people,
      unclaimedBookings: unclaimed.map((l) => ({ id: l.id, label: [l.unit, l.name, l.place].filter(Boolean).join(" · ") })),
    };
  });
}

/**
 * The bank paid on a buyer's loan. Where the project's terms let a
 * partner's second half fall due on the bank's first payment, a booking of
 * this buyer whose share collected is not yet recorded is owed from that
 * day (`secondHalfDue()`), and the firm is told, as a date typed on the desk
 * would. A half already invoiced keeps the date it had.
 */
export async function bankPaidForLead(o: { orgId: string; leadId: string; on: string }): Promise<number> {
  const owed: string[] = [];
  await withTenant(o.orgId, async (sql) => {
    const pays = await sql<{ id: string; booked_on: string; second_half: string | null; locked: boolean }[]>`
      SELECT p.id, p.booked_on::text,
             (SELECT t.second_half FROM commission_terms t
               WHERE t.org_id = p.org_id AND t.scope_node_id = p.scope_node_id AND t.mandate_id IS NOT DISTINCT FROM p.payer_mandate_id) AS second_half,
             EXISTS (SELECT 1 FROM payout_milestones m WHERE m.payout_id = p.id AND m.key = 'M2' AND m.stage <> 'NONE') AS locked
      FROM partner_payouts p
      WHERE p.org_id = ${o.orgId} AND p.lead_id = ${o.leadId} AND p.kind = 'PARTNER' AND p.cancelled_at IS NULL AND p.collected_on IS NULL
      FOR UPDATE OF p`;
    for (const p of pays) {
      if (p.locked || o.on < p.booked_on.slice(0, 10)) continue;
      const due = secondHalfDue({ rule: p.second_half === "COLLECTED_OR_BANK" ? "COLLECTED_OR_BANK" : "COLLECTED", collectedOn: null, firstBankPaidOn: o.on });
      if (!due) continue;
      await sql`UPDATE partner_payouts SET collected_on = ${due}, updated_at = now() WHERE org_id = ${o.orgId} AND id = ${p.id} AND collected_on IS NULL`;
      owed.push(p.id);
    }
  });
  for (const id of owed) {
    await notifyPayout(o.orgId, id, { kind: "half", key: "M2" });
    await audit({ orgId: o.orgId, actorUserId: null, action: "partner.booking_dates", targetType: "partner_payout", targetId: id, metadata: { collected: true, via: "bank_payment" } });
  }
  return owed.length;
}
