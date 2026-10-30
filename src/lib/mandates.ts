import type { TransactionSql } from "postgres";
import { audit, auditHash, withTenant } from "./db/index.ts";
import { send, type Mail, type MailResult } from "./mailer.ts";
import { istDay } from "./partner-rules.ts";
import {
  earnsOn,
  earnsOnTail,
  inviteText,
  lastDay,
  mandateEnd,
  tailLine,
  tailUntil,
  mandateAlerts,
  mandatePayout,
  mandateProblems,
  mandateState,
  type MandateAlert,
  type MandateInput,
  type MandateState,
  type MandateStatus,
  firmAlerts,
  mandateMail,
  rejectWords,
  showRate,
  type MandateMail,
} from "./mandate-rules.ts";
import { rupees } from "./lead-rules.ts";
import type { PayoutEvent } from "./partner-notify.ts";

/**
 * Mandate firms: the reads and writes around `mandate-rules.ts` (0060).
 *
 * The developer's side lives here: offering a mandate, withdrawing, ending
 * and renewing it, and the commission a live one earns on each booking. The
 * firm's side is two SECURITY DEFINER functions (`mandates_for_firm()`,
 * `answer_mandate()`), called from the firm's own tenant, so the firm reads
 * and answers its own offers and touches nothing else of the developer's.
 */

type Sql = TransactionSql;

export const isId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);

const startOfIstDay = (iso: string) => new Date(`${istDay(iso)}T00:00:00+05:30`);
const endOfIstDay = (day: string) => new Date(`${day}T23:59:59.999+05:30`);

// ---------------------------------------------------------------------------
// The invite email, behind a seam
// ---------------------------------------------------------------------------

let mailer: ((m: Mail) => Promise<MailResult>) | null = null;

/** For checks: every invite goes to `driver` until `restore()`. */
export function useMandateMail(driver: (m: Mail) => Promise<MailResult>): { restore(): void } {
  mailer = driver;
  return { restore: () => void (mailer = null) };
}

const base = () => (process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
const signupLink = () => `${base()}/signin?as=mandate`;

// ---------------------------------------------------------------------------
// Telling the other side
// ---------------------------------------------------------------------------

/**
 * Email the firm's admins about one of this developer's mandates, read
 * through `mandate_firm_emails()` (0104) from the developer's tenant. Never
 * throws: what happened to the mandate happened whether or not anybody was
 * told.
 */
export async function tellFirm(orgId: string, mandateId: string, mail: MandateMail): Promise<number> {
  try {
    const to = await withTenant(orgId, (sql) => sql<{ email: string }[]>`SELECT email FROM mandate_firm_emails(${mandateId})`);
    const text = mandateMail(mail, `${base()}/dashboard/developers`);
    let sent = 0;
    for (const r of to) if ((await (mailer ?? send)({ to: r.email, subject: text.subject, text: text.body })).ok) sent++;
    return sent;
  } catch (e) {
    console.error(`mandates: could not tell the firm about mandate ${mandateId}`, e);
    return 0;
  }
}

/** Email the person who offered the mandate, from the firm's tenant (`mandate_developer_emails()`). Never throws. */
async function tellDeveloper(firmOrgId: string, mandateId: string, mail: MandateMail): Promise<number> {
  try {
    const to = await withTenant(firmOrgId, (sql) => sql<{ email: string }[]>`SELECT email FROM mandate_developer_emails(${mandateId})`);
    const text = mandateMail(mail, `${base()}/dashboard/partners?view=mandates`);
    let sent = 0;
    for (const r of to) if ((await (mailer ?? send)({ to: r.email, subject: text.subject, text: text.body })).ok) sent++;
    return sent;
  } catch (e) {
    console.error(`mandates: could not tell the developer about mandate ${mandateId}`, e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Finding a firm
// ---------------------------------------------------------------------------

/** A mandate firm that signed up itself, by its PAN. Its name and id, nothing else. */
export async function findMandateFirm(orgId: string, pan: string): Promise<{ id: string; name: string } | null> {
  const clean = pan.trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(clean)) return null;
  const [r] = await withTenant(orgId, (sql) => sql<{ id: string; display_name: string }[]>`
    SELECT id, display_name FROM mandate_firm_by_pan(${clean})`);
  return r && r.id !== orgId ? { id: r.id, name: r.display_name } : null;
}

// ---------------------------------------------------------------------------
// Offering, withdrawing, ending, renewing
// ---------------------------------------------------------------------------

export type OfferResult =
  | { ok: true; id: string; message: string }
  | { ok: false; message: string; errors?: Record<string, string> };

/**
 * Offer a mandate. A firm on Sales Desk gets it to answer at once; one that
 * is not is invited by email and gets it when it signs up with that PAN. A
 * project that already has a live or waiting mandate over the same days is
 * refused: a sole selling mandate is sole.
 */
export async function offerMandate(opts: { orgId: string; userId: string; input: MandateInput; nowIso?: string }): Promise<OfferResult> {
  const now = opts.nowIso ?? new Date().toISOString();
  const today = istDay(now);
  const i = opts.input;
  const pan = i.pan.trim().toUpperCase();
  const firm = await findMandateFirm(opts.orgId, pan);
  const errors = mandateProblems(i, { onPlatform: !!firm, today });
  if (Object.keys(errors).length) return { ok: false, message: "Check the highlighted fields.", errors };
  const validFrom = startOfIstDay(now);
  const validTo = endOfIstDay(i.validTo);

  const made = await withTenant(opts.orgId, async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`mandate:${opts.orgId}`}))`;
    const [org] = await sql<{ display_name: string }[]>`SELECT display_name FROM orgs WHERE id = ${opts.orgId}`;
    const projects = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM scope_nodes WHERE org_id = ${opts.orgId} AND kind = 'PROJECT' AND id = ANY(${i.projectIds})`;
    if (projects.length !== new Set(i.projectIds).size) return { ok: false as const, message: "One of those projects is not here.", errors: { projects: "Choose from the list." } };
    const [taken] = await sql<{ project: string; firm: string }[]>`
      SELECT p.project_name AS project, m.firm_name AS firm FROM mandates m JOIN mandate_projects p ON p.mandate_id = m.id
      WHERE m.org_id = ${opts.orgId} AND m.status IN ('INVITED', 'OFFERED', 'LIVE')
        AND p.scope_node_id = ANY(${i.projectIds}) AND m.valid_from < ${validTo} AND ${validFrom} < m.valid_to
      LIMIT 1`;
    if (taken) {
      return { ok: false as const, message: `${taken.project} already has a mandate with ${taken.firm} for these dates.`, errors: { projects: "Already under a mandate." } };
    }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mandates (org_id, firm_org_id, firm_name, firm_pan, contact_name, contact_email, rate, valid_from, valid_to, status, offered_by, tail_days)
      VALUES (${opts.orgId}, ${firm?.id ?? null}, ${firm?.name ?? i.firmName.trim().slice(0, 160)}, ${pan},
              ${firm ? null : i.contactName?.trim().slice(0, 120) ?? null}, ${firm ? null : i.contactEmail?.trim().toLowerCase() ?? null},
              ${i.rate}, ${validFrom}, ${validTo}, ${firm ? "OFFERED" : "INVITED"}, ${opts.userId}, ${i.tailDays ?? 0})
      RETURNING id`;
    for (const p of projects) {
      await sql`
        INSERT INTO mandate_projects (mandate_id, org_id, scope_node_id, project_name)
        VALUES (${row.id}, ${opts.orgId}, ${p.id}, ${p.name.slice(0, 200)})`;
    }
    return { ok: true as const, id: row.id, developer: org?.display_name ?? "A developer", projects: projects.map((p) => p.name) };
  });
  if (!made.ok) return made;

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: firm ? "mandate.offered" : "mandate.invited",
    targetType: "mandate",
    targetId: made.id,
    metadata: { projects: made.projects.length, rate: i.rate, tail: i.tailDays ?? 0, pan: auditHash(pan), ...(firm ? {} : { email: auditHash(i.contactEmail) }) },
  });

  if (firm) {
    await tellFirm(opts.orgId, made.id, {
      kind: "offered",
      developer: made.developer,
      projects: made.projects,
      rate: i.rate,
      validTo: i.validTo,
      tailDays: i.tailDays ?? 0,
    });
    return { ok: true, id: made.id, message: `Mandate sent to ${firm.name}. It goes live when they accept.` };
  }

  const text = inviteText({
    developer: made.developer,
    firm: i.firmName.trim(),
    projects: made.projects,
    rate: i.rate,
    validTo: i.validTo,
    link: signupLink(),
    tailDays: i.tailDays ?? 0,
  });
  const sent = await (mailer ?? send)({ to: i.contactEmail!.trim(), subject: text.subject, text: text.body });
  if (!sent.ok) {
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "mandate.invite_email_failed", targetType: "mandate", targetId: made.id, metadata: { code: sent.code } });
    return {
      ok: true,
      id: made.id,
      message: `Saved. The invite email did not go out, so ask ${i.contactName?.trim() || "them"} to sign up on Sales Desk as a mandate firm with that PAN.`,
    };
  }
  return { ok: true, id: made.id, message: `Invite sent to ${i.contactEmail!.trim()}. The mandate waits for them to sign up and accept.` };
}

/** Every project a mandate covers, for the permission check. */
export async function mandatePaths(orgId: string, mandateId: string): Promise<string[]> {
  if (!isId(mandateId)) return [];
  const rows = await withTenant(orgId, (sql) => sql<{ path: string }[]>`
    SELECT n.path::text AS path FROM mandate_projects p JOIN scope_nodes n ON n.id = p.scope_node_id
    WHERE p.org_id = ${orgId} AND p.mandate_id = ${mandateId}`);
  return rows.map((r) => r.path);
}

export type MandateChange = { kind: "withdraw" } | { kind: "end" } | { kind: "renew"; validTo: string };

/**
 * Withdraw an offer nobody has answered, end a live mandate, or run it
 * longer. Ending takes the firm's grants with it at once; bookings already
 * made keep the commission they earned.
 */
export async function changeMandate(opts: { orgId: string; userId: string; mandateId: string; change: MandateChange; nowIso?: string }): Promise<{ ok: boolean; message: string }> {
  const now = opts.nowIso ?? new Date().toISOString();
  const c = opts.change;
  if (!isId(opts.mandateId)) return { ok: false, message: "That mandate is not here." };
  if (c.kind === "renew" && (!/^\d{4}-\d{2}-\d{2}$/.test(c.validTo) || c.validTo <= istDay(now))) return { ok: false, message: "Pick a last day after today." };
  let tail: string | null = null;
  let told: { firm: string | null; developer: string; projects: string[]; validTo: string } | null = null;
  const out = await withTenant(opts.orgId, async (sql) => {
    const [m] = await sql<{ status: MandateStatus; valid_from: Date; valid_to: Date; tail_days: number; firm_org_id: string | null; developer: string; projects: string[] }[]>`
      SELECT m.status, m.valid_from, m.valid_to, m.tail_days, m.firm_org_id, o.display_name AS developer,
             ARRAY(SELECT p.project_name FROM mandate_projects p WHERE p.mandate_id = m.id ORDER BY p.project_name) AS projects
      FROM mandates m JOIN orgs o ON o.id = m.org_id
      WHERE m.org_id = ${opts.orgId} AND m.id = ${opts.mandateId} FOR UPDATE OF m`;
    if (!m) return "That mandate is not here.";
    told = { firm: m.firm_org_id, developer: m.developer, projects: m.projects, validTo: c.kind === "renew" ? c.validTo : lastDay(m.valid_to.toISOString()) };
    if (c.kind === "withdraw") {
      if (m.status !== "INVITED" && m.status !== "OFFERED") return "Only an offer nobody has answered can be withdrawn.";
      await sql`UPDATE mandates SET status = 'WITHDRAWN', ended_by = ${opts.userId}, ended_at = now(), updated_at = now()
                WHERE org_id = ${opts.orgId} AND id = ${opts.mandateId}`;
      return null;
    }
    if (c.kind === "end") {
      if (m.status !== "LIVE") return "Only a live mandate can be ended.";
      const [e] = await sql<{ ended_at: Date }[]>`
        UPDATE mandates SET status = 'ENDED', ended_by = ${opts.userId}, ended_at = now(), updated_at = now()
        WHERE org_id = ${opts.orgId} AND id = ${opts.mandateId}
        RETURNING ended_at`;
      const until = tailUntil({
        status: "ENDED",
        validFrom: m.valid_from.toISOString(),
        validTo: m.valid_to.toISOString(),
        endedAt: e.ended_at.toISOString(),
        tailDays: m.tail_days,
      });
      tail = until ? lastDay(new Date(Date.parse(until) - 1).toISOString()) : null;
      await sql`UPDATE grants SET status = 'ENDED', updated_at = now()
                WHERE org_id = ${opts.orgId} AND status <> 'ENDED'
                  AND id IN (SELECT grant_id FROM mandate_projects WHERE org_id = ${opts.orgId} AND mandate_id = ${opts.mandateId})`;
      // The partners the firm empanelled under it stop with it. Their buyers
      // and payouts stay; the developer or a new mandate can take them on.
      await sql`UPDATE grants SET status = 'ENDED', updated_at = now()
                WHERE org_id = ${opts.orgId} AND status <> 'ENDED' AND role = 'CHANNEL_PARTNER' AND mandate_id = ${opts.mandateId}`;
      return null;
    }
    if (m.status !== "LIVE" && m.status !== "OFFERED" && m.status !== "INVITED") return "Only a live or waiting mandate can run longer.";
    const to = endOfIstDay(c.validTo);
    if (to <= m.valid_to) return "Pick a day after the current last day.";
    // A request to run it longer is answered by running it longer.
    await sql`UPDATE mandates SET valid_to = ${to}, renewed_at = now(), extension_asked_at = NULL, extension_asked_by = NULL, updated_at = now()
              WHERE org_id = ${opts.orgId} AND id = ${opts.mandateId}`;
    await sql`UPDATE grants SET valid_to = ${to}, updated_at = now()
              WHERE org_id = ${opts.orgId} AND status = 'ACTIVE'
                AND id IN (SELECT grant_id FROM mandate_projects WHERE org_id = ${opts.orgId} AND mandate_id = ${opts.mandateId})`;
    // The firm's own partners were empanelled up to the mandate's last day at
    // most; the ones that ran to it run on with it. One set to stop earlier keeps its own day.
    await sql`UPDATE grants SET valid_to = ${to}, updated_at = now()
              WHERE org_id = ${opts.orgId} AND status = 'ACTIVE' AND role = 'CHANNEL_PARTNER'
                AND mandate_id = ${opts.mandateId} AND valid_to >= ${m.valid_to}`;
    return null;
  });
  if (out) return { ok: false, message: out };
  await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: `mandate.${c.kind === "withdraw" ? "withdrawn" : c.kind === "end" ? "ended" : "renewed"}`, targetType: "mandate", targetId: opts.mandateId });
  const t = told as { firm: string | null; developer: string; projects: string[]; validTo: string } | null;
  if (t?.firm) {
    await tellFirm(
      opts.orgId,
      opts.mandateId,
      c.kind === "withdraw"
        ? { kind: "withdrawn", developer: t.developer, projects: t.projects }
        : c.kind === "end"
          ? { kind: "ended", developer: t.developer, projects: t.projects, tailUntil: tail }
          : { kind: "renewed", developer: t.developer, projects: t.projects, validTo: t.validTo },
    );
  }
  const said = {
    withdraw: "Offer withdrawn.",
    end: tail ? `Mandate ended. ${tailLine(tail)}` : "Mandate ended. Bookings from now on owe the firm nothing.",
    renew: "Mandate runs longer.",
  };
  return { ok: true, message: said[c.kind] };
}

// ---------------------------------------------------------------------------
// The commission a booking earns
// ---------------------------------------------------------------------------

/**
 * A booking in a project under a live mandate owes the firm its commission,
 * written once with the partner's own two halves. So does a booking inside a
 * mandate's tail (`tail_days` after it ended) by a buyer who came while it
 * was live (`earnsOnTail()`). Called inside the booking's handling
 * (`onBooked()` in `partners.ts`); idempotent on the payout's unique index,
 * which also keeps a booking to one mandate payout: a live mandate is asked
 * first, then the tails, newest end first.
 */
export async function mandateOnBooked(
  sql: Sql,
  o: { orgId: string; userId: string | null; leadId: string; phone: string; nodeId: string; facts: Record<string, string>; nowIso: string },
): Promise<string | null> {
  const found = await sql<{
    id: string; firm_org_id: string; rate: string; firm_gstin: boolean | null; valid_from: Date; valid_to: Date;
    status: MandateStatus; ended_at: Date | null; tail_days: number; project_id: string;
  }[]>`
    SELECT m.id, m.firm_org_id, m.rate, m.firm_gstin, m.valid_from, m.valid_to, m.status, m.ended_at, m.tail_days,
           p.scope_node_id AS project_id
    FROM mandates m JOIN mandate_projects p ON p.mandate_id = m.id
    JOIN scope_nodes pn ON pn.id = p.scope_node_id
    WHERE m.org_id = ${o.orgId} AND m.status IN ('LIVE', 'ENDED') AND m.firm_org_id IS NOT NULL
      AND pn.path @> (SELECT path FROM scope_nodes WHERE org_id = ${o.orgId} AND id = ${o.nodeId})
    ORDER BY m.valid_from DESC`;
  const shape = (r: (typeof found)[number]) => ({
    status: r.status,
    validFrom: r.valid_from.toISOString(),
    validTo: r.valid_to.toISOString(),
    endedAt: r.ended_at?.toISOString() ?? null,
    tailDays: r.tail_days,
  });
  let m = found.find((r) => r.status === "LIVE" && earnsOn(shape(r), o.nowIso)) ?? null;
  if (!m) {
    // The tails still running, the newest end first.
    const tails = found
      .filter((r) => {
        const until = tailUntil(shape(r));
        return until && Date.parse(o.nowIso) < Date.parse(until);
      })
      .sort((a, b) => Date.parse(mandateEnd(shape(b))) - Date.parse(mandateEnd(shape(a))));
    for (const r of tails) {
      const [src] = await sql<{ enquired: Date | null; visited: Date | null; claimed: Date | null }[]>`
        SELECT (SELECT least(l.created_at, l.enquired_at) FROM leads l WHERE l.org_id = ${o.orgId} AND l.id = ${o.leadId}) AS enquired,
               (SELECT min(coalesce(v.arrived_at, v.completed_at, v.scheduled_at)) FROM site_visits v
                 WHERE v.org_id = ${o.orgId} AND v.lead_id = ${o.leadId} AND v.status IN ('ON_SITE', 'VISITED')) AS visited,
               (SELECT min(c.created_at) FROM client_registrations c JOIN grants g ON g.id = c.grant_id
                 WHERE c.org_id = ${o.orgId} AND c.verdict = 'REGISTERED' AND g.mandate_id = ${r.id}
                   AND c.scope_node_id = ${r.project_id} AND (c.lead_id = ${o.leadId} OR c.phone = ${o.phone})) AS claimed`;
      const sourcedAt = [src?.enquired, src?.visited, src?.claimed].map((d) => d?.toISOString() ?? null);
      if (earnsOnTail(shape(r), { atIso: o.nowIso, sourcedAt })) {
        m = r;
        break;
      }
    }
  }
  if (!m) return null;
  const agreement = Number(String(o.facts.agreement ?? "").replace(/\D/g, ""));
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM partner_payouts WHERE org_id = ${o.orgId} AND mandate_id = ${m.id} AND cancelled_at IS NULL`;
  const p = mandatePayout({ agreement, rate: Number(m.rate), bookingNo: n + 1, gstRegistered: !!m.firm_gstin });
  if (!p.ok) return null;
  const bookedOn = /^\d{4}-\d{2}-\d{2}$/.test(o.facts.bookedOn ?? "") ? o.facts.bookedOn : istDay(o.nowIso);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO partner_payouts (org_id, lead_id, registration_id, cp_org_id, scope_node_id, unit, agreement, booking_no, rate, pass_back,
                                 gst_registered, booked_on, created_by, kind, mandate_id)
    VALUES (${o.orgId}, ${o.leadId}, NULL, ${m.firm_org_id}, ${m.project_id}, ${o.facts.unit?.slice(0, 40) || null},
            ${agreement}, ${p.payout.bookingNo}, ${p.payout.rate}, 0, ${!!m.firm_gstin}, ${bookedOn}, ${o.userId}, 'MANDATE', ${m.id})
    ON CONFLICT (org_id, lead_id, kind) WHERE cancelled_at IS NULL DO NOTHING
    RETURNING id`;
  if (!row) return null;
  for (const key of ["M1", "M2"] as const) {
    const h = p.payout.milestones[key];
    await sql`
      INSERT INTO payout_milestones (org_id, payout_id, key, base, gst, gross, tds, net)
      VALUES (${o.orgId}, ${row.id}, ${key}, ${h.base}, ${h.gst}, ${h.gross}, ${h.tds}, ${h.net})`;
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------

export type MandateRow = {
  id: string;
  firm: string;
  pan: string;
  onPlatform: boolean;
  contactName: string | null;
  projects: { id: string; name: string }[];
  rate: number;
  validFrom: string;
  validTo: string;
  status: MandateStatus;
  state: MandateState;
  offeredOn: string;
  answeredOn: string | null;
  endedOn: string | null;
  /** Days after it ends that its buyers still owe the firm. */
  tailDays: number;
  /** The IST day a tail runs to, once the mandate has ended or run out. */
  tailUntil: string | null;
  /** The day the firm asked to run it longer, while that is unanswered. */
  extensionAskedOn: string | null;
  /** Live bookings that earned it commission, and what is due and unpaid after TDS. */
  bookings: number;
  owed: number;
};

/** Every mandate on projects inside the viewer's reach. */
export async function loadMandates(opts: { orgId: string; scopes: string[]; nowIso?: string }): Promise<MandateRow[]> {
  const now = opts.nowIso ?? new Date().toISOString();
  if (!opts.scopes.length) return [];
  return withTenant(opts.orgId, async (sql) => {
    const rows = await sql<{
      id: string; firm_name: string; firm_pan: string; firm_org_id: string | null; contact_name: string | null; rate: string;
      valid_from: Date; valid_to: Date; status: MandateStatus; created_at: Date; answered_at: Date | null; ended_at: Date | null;
      tail_days: number; extension_asked_at: Date | null; projects: { id: string; name: string; path: string }[];
    }[]>`
      SELECT m.id, m.firm_name, m.firm_pan, m.firm_org_id, m.contact_name, m.rate, m.valid_from, m.valid_to, m.status,
             m.created_at, m.answered_at, m.ended_at, m.tail_days, m.extension_asked_at,
             coalesce((SELECT json_agg(json_build_object('id', p.scope_node_id, 'name', p.project_name, 'path', n.path::text) ORDER BY p.project_name)
                       FROM mandate_projects p JOIN scope_nodes n ON n.id = p.scope_node_id WHERE p.mandate_id = m.id), '[]'::json) AS projects
      FROM mandates m WHERE m.org_id = ${opts.orgId}
      ORDER BY (m.status IN ('INVITED', 'OFFERED', 'LIVE')) DESC, m.created_at DESC`;
    const money = await sql<{ mandate_id: string; bookings: number; owed: string }[]>`
      SELECT p.mandate_id, count(DISTINCT p.id)::int AS bookings,
             coalesce(sum(ms.net) FILTER (WHERE ms.stage <> 'PAID' AND CASE ms.key WHEN 'M1' THEN p.agreement_registered_on IS NOT NULL
                                                                                ELSE p.collected_on IS NOT NULL END), 0)::text AS owed
      FROM partner_payouts p JOIN payout_milestones ms ON ms.payout_id = p.id
      WHERE p.org_id = ${opts.orgId} AND p.kind = 'MANDATE' AND p.cancelled_at IS NULL
      GROUP BY p.mandate_id`;
    const inScope = (path: string) => opts.scopes.some((s) => path === s || path.startsWith(`${s}.`));
    return rows
      .filter((r) => r.projects.some((p) => inScope(p.path)))
      .map((r) => {
        const m = money.find((x) => x.mandate_id === r.id);
        const tail = tailUntil({
          status: r.status,
          validFrom: r.valid_from.toISOString(),
          validTo: r.valid_to.toISOString(),
          endedAt: r.ended_at?.toISOString() ?? null,
          tailDays: r.tail_days,
        });
        const over = r.status === "ENDED" || (r.status === "LIVE" && r.valid_to.toISOString() <= now);
        return {
          id: r.id,
          firm: r.firm_name,
          pan: r.firm_pan,
          onPlatform: !!r.firm_org_id,
          contactName: r.contact_name,
          projects: r.projects.map((p) => ({ id: p.id, name: p.name })),
          rate: Number(r.rate),
          validFrom: r.valid_from.toISOString(),
          validTo: r.valid_to.toISOString(),
          status: r.status,
          state: mandateState({ status: r.status, validFrom: r.valid_from.toISOString(), validTo: r.valid_to.toISOString() }, now),
          offeredOn: istDay(r.created_at.toISOString()),
          answeredOn: r.answered_at ? istDay(r.answered_at.toISOString()) : null,
          endedOn: r.ended_at ? istDay(r.ended_at.toISOString()) : null,
          tailDays: r.tail_days,
          tailUntil: over && tail ? lastDay(new Date(Date.parse(tail) - 1).toISOString()) : null,
          extensionAskedOn: r.status === "LIVE" && r.extension_asked_at ? istDay(r.extension_asked_at.toISOString()) : null,
          bookings: m?.bookings ?? 0,
          owed: Number(m?.owed ?? 0),
        };
      });
  });
}

export type MandateProject = {
  id: string;
  name: string;
  /** The firm holding it now, or waiting to answer for it, if any. */
  heldBy: string | null;
};

/** The projects a viewer may offer a mandate on, and which already have one. */
export async function mandateProjects(opts: { orgId: string; scopes: string[] }): Promise<MandateProject[]> {
  if (!opts.scopes.length) return [];
  return withTenant(opts.orgId, async (sql) => {
    const rows = await sql<{ id: string; name: string; held_by: string | null }[]>`
      SELECT n.id, n.name,
             (SELECT m.firm_name FROM mandates m JOIN mandate_projects p ON p.mandate_id = m.id
              WHERE p.scope_node_id = n.id AND m.status IN ('INVITED', 'OFFERED', 'LIVE') AND m.valid_to > now()
              ORDER BY m.valid_from LIMIT 1) AS held_by
      FROM scope_nodes n
      WHERE n.org_id = ${opts.orgId} AND n.kind = 'PROJECT'
        AND n.path <@ ANY(${opts.scopes}::ltree[])
      ORDER BY n.name`;
    return rows.map((r) => ({ id: r.id, name: r.name, heldBy: r.held_by }));
  });
}

/** Today's items: a firm that declined, a mandate about to end, an offer nobody answered. */
export async function mandateQueue(orgId: string, nowIso = new Date().toISOString()): Promise<MandateAlert[]> {
  try {
    const rows = await withTenant(orgId, (sql) => sql<{
      id: string; firm_name: string; status: MandateStatus; valid_to: Date; answered_at: Date | null; created_at: Date; projects: string[];
      tail_days: number; extension_asked_at: Date | null;
    }[]>`
      SELECT m.id, m.firm_name, m.status, m.valid_to, m.answered_at, m.created_at, m.tail_days, m.extension_asked_at,
             ARRAY(SELECT p.project_name FROM mandate_projects p WHERE p.mandate_id = m.id ORDER BY p.project_name) AS projects
      FROM mandates m
      WHERE m.org_id = ${orgId} AND m.status IN ('INVITED', 'OFFERED', 'LIVE', 'DECLINED') AND m.valid_to > now() - interval '15 days'`);
    return mandateAlerts(
      rows.map((r) => ({
        id: r.id,
        firm: r.firm_name,
        projects: r.projects,
        status: r.status,
        validTo: r.valid_to.toISOString(),
        answeredOn: r.answered_at ? istDay(r.answered_at.toISOString()) : null,
        offeredOn: istDay(r.created_at.toISOString()),
        tailDays: r.tail_days,
        extensionAskedOn: r.extension_asked_at ? istDay(r.extension_asked_at.toISOString()) : null,
      })),
      istDay(nowIso),
    );
  } catch (e) {
    console.error("mandates: Today's items could not be read", e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// The firm's side
// ---------------------------------------------------------------------------

export type FirmMandate = {
  id: string;
  developer: string;
  developerOrgId: string;
  projects: string[];
  rate: number;
  validFrom: string;
  validTo: string;
  status: MandateStatus;
  state: MandateState;
  offeredOn: string;
  /** Days after it ends that its buyers still owe the firm. */
  tailDays: number;
  /** When the developer ended or withdrew it, ran it longer, and when the firm asked it to. */
  endedAt: string | null;
  renewedAt: string | null;
  extensionAskedAt: string | null;
};

/**
 * Today's items for a mandate firm: offers to answer, mandates about to end
 * or changed. Nothing for a developer. `working` says whether the firm has a
 * mandate live or waiting, so Today does not tell it to add its first
 * developer when it already sells for one through a mandate.
 */
export async function firmQueue(firmOrgId: string, nowIso = new Date().toISOString()): Promise<{ alerts: MandateAlert[]; working: boolean }> {
  try {
    const rows = await mandatesForFirm(firmOrgId, nowIso);
    return { alerts: firmAlerts(rows, nowIso), working: rows.some((r) => r.state === "live" || r.state === "offered") };
  } catch (e) {
    console.error("mandates: the firm's items could not be read", e);
    return { alerts: [], working: false };
  }
}

/** A mandate firm's own offers and mandates, from every developer. */
export async function mandatesForFirm(firmOrgId: string, nowIso = new Date().toISOString()): Promise<FirmMandate[]> {
  const rows = await withTenant(firmOrgId, (sql) => sql<{
    id: string; developer: string; projects: string[]; rate: string; valid_from: Date; valid_to: Date; status: MandateStatus; offered_at: Date;
    developer_org_id: string; tail_days: number | null; ended_at: Date | null; renewed_at: Date | null; extension_asked_at: Date | null;
  }[]>`SELECT id, developer, projects, rate, valid_from, valid_to, status, offered_at, developer_org_id, tail_days,
              ended_at, renewed_at, extension_asked_at FROM mandates_for_firm()`);
  return rows.map((r) => ({
    id: r.id,
    developer: r.developer,
    developerOrgId: r.developer_org_id,
    projects: r.projects,
    rate: Number(r.rate),
    validFrom: r.valid_from.toISOString(),
    validTo: r.valid_to.toISOString(),
    status: r.status,
    state: mandateState({ status: r.status, validFrom: r.valid_from.toISOString(), validTo: r.valid_to.toISOString() }, nowIso),
    offeredOn: istDay(r.offered_at.toISOString()),
    tailDays: r.tail_days ?? 0,
    endedAt: r.ended_at?.toISOString() ?? null,
    renewedAt: r.renewed_at?.toISOString() ?? null,
    extensionAskedAt: r.extension_asked_at?.toISOString() ?? null,
  }));
}

/** The firm accepts or declines its own offer. */
export async function answerMandate(opts: { firmOrgId: string; userId: string; mandateId: string; accept: boolean }): Promise<{ ok: boolean; message: string }> {
  if (!isId(opts.mandateId)) return { ok: false, message: "That offer is not here." };
  const [r] = await withTenant(opts.firmOrgId, (sql) => sql<{ answer: string }[]>`
    SELECT answer_mandate(${opts.mandateId}, ${opts.accept}, ${opts.userId}) AS answer`);
  const said: Record<string, { ok: boolean; message: string }> = {
    LIVE: { ok: true, message: "Accepted. The mandate is live." },
    DECLINED: { ok: true, message: "Declined." },
    NOT_YOURS: { ok: false, message: "That offer is not here." },
    ANSWERED: { ok: false, message: "This offer was already answered or withdrawn." },
    EXPIRED: { ok: false, message: "This offer ran out before it was answered." },
    TAKEN: { ok: false, message: "Another firm now holds the mandate for one of these projects." },
  };
  const out = said[r?.answer ?? "NOT_YOURS"] ?? said.NOT_YOURS;
  if (out.ok) {
    await audit({ orgId: opts.firmOrgId, actorUserId: opts.userId, action: opts.accept ? "mandate.accepted" : "mandate.declined", targetType: "mandate", targetId: opts.mandateId });
    const [m] = await withTenant(opts.firmOrgId, (sql) => sql<{ projects: string[]; valid_to: Date; firm: string }[]>`
      SELECT f.projects, f.valid_to, o.display_name AS firm FROM mandates_for_firm() f, orgs o
      WHERE f.id = ${opts.mandateId} AND o.id = ${opts.firmOrgId}`);
    if (m) {
      await tellDeveloper(
        opts.firmOrgId,
        opts.mandateId,
        opts.accept
          ? { kind: "accepted", firm: m.firm, projects: m.projects, validTo: lastDay(m.valid_to.toISOString()) }
          : { kind: "declined", firm: m.firm, projects: m.projects },
      );
    }
  }
  return out;
}

export type MandateTerms = {
  id: string;
  developer: string;
  projects: string[];
  rate: number;
  validTo: string;
  tailDays: number;
  extensionAskedAt: string | null;
};

/**
 * The live mandates a firm holds from one developer, read in the
 * developer's tenant for somebody working through them: what they earn,
 * until when, and whether the firm asked to run longer.
 */
export async function mandateTerms(devOrgId: string, firmOrgId: string): Promise<MandateTerms[]> {
  try {
    const rows = await withTenant(devOrgId, (sql) => sql<{
      id: string; developer: string; projects: string[]; rate: string; valid_to: Date; tail_days: number; extension_asked_at: Date | null;
    }[]>`
      SELECT m.id, o.display_name AS developer, m.rate, m.valid_to, m.tail_days, m.extension_asked_at,
             ARRAY(SELECT p.project_name FROM mandate_projects p WHERE p.mandate_id = m.id ORDER BY p.project_name) AS projects
      FROM mandates m JOIN orgs o ON o.id = m.org_id
      WHERE m.org_id = ${devOrgId} AND m.firm_org_id = ${firmOrgId} AND m.status = 'LIVE' AND now() < m.valid_to
      ORDER BY m.valid_to`);
    return rows.map((r) => ({
      id: r.id,
      developer: r.developer,
      projects: r.projects,
      rate: Number(r.rate),
      validTo: r.valid_to.toISOString(),
      tailDays: r.tail_days,
      extensionAskedAt: r.extension_asked_at?.toISOString() ?? null,
    }));
  } catch (e) {
    console.error("mandates: the terms could not be read", e);
    return [];
  }
}

/** The firm asks the developer to run a live mandate longer: stamped on the mandate and emailed to whoever offered it. */
export async function askExtension(opts: { firmOrgId: string; userId: string; mandateId: string }): Promise<{ ok: boolean; message: string }> {
  if (!isId(opts.mandateId)) return { ok: false, message: "That mandate is not here." };
  const [r] = await withTenant(opts.firmOrgId, (sql) => sql<{ answer: string }[]>`
    SELECT ask_mandate_extension(${opts.mandateId}, ${opts.userId}) AS answer`);
  const said: Record<string, { ok: boolean; message: string }> = {
    ASKED: { ok: true, message: "Asked. The developer is told by email and on their Today." },
    ALREADY: { ok: false, message: "You asked in the last week. The developer has it on their Today." },
    NOT_LIVE: { ok: false, message: "Only a live mandate can run longer." },
    NOT_YOURS: { ok: false, message: "That mandate is not here." },
  };
  const out = said[r?.answer ?? "NOT_YOURS"] ?? said.NOT_YOURS;
  if (r?.answer === "ASKED") {
    const [m] = await withTenant(opts.firmOrgId, (sql) => sql<{ projects: string[]; valid_to: Date; firm: string }[]>`
      SELECT f.projects, f.valid_to, o.display_name AS firm FROM mandates_for_firm() f, orgs o
      WHERE f.id = ${opts.mandateId} AND o.id = ${opts.firmOrgId}`);
    if (m) await tellDeveloper(opts.firmOrgId, opts.mandateId, { kind: "extension", firm: m.firm, projects: m.projects, validTo: lastDay(m.valid_to.toISOString()) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The firm told about its commission
// ---------------------------------------------------------------------------

/**
 * One step of a mandate firm's commission, emailed to its admins. Null when
 * the payout is not a mandate's, so the partner's own notice runs instead.
 * The firm's own filing is not news to it, and is not sent.
 */
export async function notifyMandatePayout(orgId: string, payoutId: string, event: PayoutEvent): Promise<number | null> {
  try {
    const [p] = await withTenant(orgId, (sql) => sql<{
      mandate_id: string; developer: string; project: string; unit: string | null; buyer: string | null; rate: string;
      halves: { key: "M1" | "M2"; net: number; stage: string; paid_on: string | null; utr: string | null; owed: boolean; reject_reason: string | null }[];
    }[]>`
      SELECT p.mandate_id, o.display_name AS developer, n.name AS project, p.unit, l.name AS buyer, p.rate,
             coalesce((SELECT json_agg(json_build_object('key', ms.key, 'net', ms.net, 'stage', ms.stage, 'paid_on', ms.paid_on, 'utr', ms.utr,
                                                          'owed', CASE ms.key WHEN 'M1' THEN p.agreement_registered_on IS NOT NULL ELSE p.collected_on IS NOT NULL END,
                                                          'reject_reason', (SELECT i.reject_reason FROM partner_invoices i WHERE i.milestone_id = ms.id AND i.rejected_at IS NOT NULL
                                                                            ORDER BY i.rejected_at DESC LIMIT 1)) ORDER BY ms.key)
                       FROM payout_milestones ms WHERE ms.payout_id = p.id), '[]'::json) AS halves
      FROM partner_payouts p JOIN orgs o ON o.id = p.org_id JOIN scope_nodes n ON n.id = p.scope_node_id
      LEFT JOIN leads l ON l.id = p.lead_id AND l.erased_at IS NULL
      WHERE p.org_id = ${orgId} AND p.id = ${payoutId} AND p.kind = 'MANDATE'`);
    if (!p) return null;
    const half = (k: "M1" | "M2") => p.halves.find((h) => h.key === k);
    const which = (k: "M1" | "M2") => (k === "M1" ? "The first half" : "The second half");
    let update: string | null = null;
    if (event.kind === "booked") {
      const total = p.halves.reduce((sum, h) => sum + Number(h.net), 0);
      update = `this booking earns you ${showRate(Number(p.rate))} commission, ${rupees(total)} after TDS, in two halves. Each is due once its step is reached.`;
    } else if (event.kind === "cancelled" || event.kind === "clawback") {
      update = "this booking was cancelled. A half already paid stays paid; nothing more is owed on it.";
    } else {
      const h = half(event.key);
      if (h) {
        const amount = rupees(Number(h.net));
        if (h.stage === "PAID") update = `${which(h.key)}, ${amount}, was paid${h.paid_on ? ` on ${String(h.paid_on).slice(0, 10)}` : ""}${h.utr ? `, UTR ${h.utr}` : ""}.`;
        else if (h.stage === "APPROVED") update = `${which(h.key)}, ${amount}, is approved for payment.`;
        else if (h.stage === "NONE" && h.reject_reason) update = `${which(h.key)}: your invoice was sent back. ${rejectWords(h.reject_reason)}. Send a corrected one.`;
        else if (h.stage === "NONE" && h.owed) update = `${which(h.key)}, ${amount}, is now due. Send your invoice for it.`;
      }
    }
    if (!update) return 0;
    const booking = [p.unit, p.buyer].filter(Boolean).join(", ") || "a booking";
    return tellFirm(orgId, p.mandate_id, { kind: "commission", developer: p.developer, project: p.project, booking, update });
  } catch (e) {
    console.error(`mandates: could not tell the firm about payout ${payoutId}`, e);
    return 0;
  }
}

/**
 * When a mandate firm signs up, the offers waiting for its PAN become its
 * own. Called on the control connection inside the org's creation.
 */
export async function attachInvites(tx: Sql, firmOrgId: string, pan: string): Promise<number> {
  const rows = await tx<{ id: string; org_id: string }[]>`
    UPDATE mandates SET firm_org_id = ${firmOrgId}, status = 'OFFERED', updated_at = now()
    WHERE firm_pan = ${pan} AND status = 'INVITED' AND org_id <> ${firmOrgId} AND valid_to > now()
    RETURNING id, org_id`;
  for (const r of rows) {
    await tx`
      INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (${r.org_id}, NULL, 'mandate.firm_joined', 'mandate', ${r.id}, '{}'::jsonb)`;
  }
  return rows.length;
}
