import type { LoanStage } from "./loan-rules.ts";
import { cache } from "react";
import { withTenant } from "./db/index.ts";
import { enquiryUrl } from "./capture.ts";
import { maskPhone } from "./mask-rules.ts";
import { numberAt } from "./partner-notify.ts";
import { tapText, waMeLink } from "./partner-bot-rules.ts";
import { bookPartnerVisit } from "./lead-engine.ts";
import { deskFirmIn, fileInvoice, isId, makeLink, registerBuyer } from "./partners.ts";
import { canPublish } from "./publish-gate.ts";
import { readAsset } from "./storage.ts";
import { longDay } from "./mandate-rules.ts";
import { rupees, showTime } from "./lead-rules.ts";
import { firmInvoiceRefusal, partnerToday, type PartnerItem } from "./partner-workspace-rules.ts";
import {
  DEFAULT_TERMS,
  REFUSE_OF,
  isRejectReason,
  STAGE_OF,
  VIA_OF,
  bookingsCounted,
  grantLive,
  grantStatus,
  isLadderPeriod,
  istDay,
  parseSteps,
  type Booking,
  type FirmProject,
  type GrantState,
  type Invoice,
  type MilestoneKey,
  type Registration,
  type Step,
  type Verdict,
} from "./partner-rules.ts";

/**
 * A channel partner's developers, read and written: the part of its console
 * that lives in other companies' tenants.
 *
 * A partner firm's rows live in each developer's tenant: the claims it made,
 * the payouts it is owed, its links and the people on each developer's
 * WhatsApp list. The developers are found from the firm's own tenant
 * (`partner_developers_for_firm()`, ids and names only), and each is then
 * read in its own tenant filtered to this firm, which is what the partner
 * bot does for every message. Nothing another partner holds is read, and no
 * whole buyer number leaves this file.
 *
 * Every write asks, before anything else, that the developer still has the
 * firm on its desk, then calls the same function the bot and the desk call,
 * so every rule behind a claim, a visit or a link is asked once, in one
 * place.
 */

const dayOf = (d: Date | string | null): string | null =>
  d === null ? null : typeof d === "string" ? d.slice(0, 10) : istDay(d.toISOString());

// ---------------------------------------------------------------------------
// What the workspace draws
// ---------------------------------------------------------------------------

export type PartnerLink = { id: string; code: string; url: string | null; whatsapp: boolean; enquiries: number; claims: number };

export type PartnerTower = { id: string; name: string; link: PartnerLink | null; /** The RERA gate says it may be advertised today. */ advertisable: boolean };

export type PartnerPostRow = { id: string; towerId: string; tower: string; kind: "IMAGE" | "CAROUSEL"; placement: string; headline: string; frames: number };

export type PartnerProject = {
  id: string;
  name: string;
  status: FirmProject["status"];
  validTo: string;
  steps: Step[];
  registrationDays: number;
  booked: number;
  towers: PartnerTower[];
  posts: PartnerPostRow[];
};

export type PartnerBuyer = Registration & {
  devOrgId: string;
  developer: string;
  projectId: string;
  /** Registered, and still running. */
  live: boolean;
  /** The next visit booked for this buyer, when there is one. */
  visit: { id: string; day: string; time: string; tower: string } | null;
  /** Where the buyer's home loan stands with the developer, the stage alone. */
  loanStage: LoanStage | null;
};

export type PartnerBooking = Booking & { devOrgId: string; developer: string };

export type PartnerPerson = { id: string; devOrgId: string; developer: string; name: string; phone: string; principal: boolean; proved: boolean };

export type PartnerDeveloper = {
  orgId: string;
  name: string;
  /** The firm's row on this developer's desk. */
  firmId: string;
  /** The developer's person who looks after the firm. */
  rm: string | null;
  /** The mandate firm whose desk the partner is on, when it is not the developer's own. */
  through: string | null;
  /** The agent registration this developer holds for the firm, which a registration is checked against. */
  agentOnFile: { reraNo: string | null; reraTill: string | null };
  projects: PartnerProject[];
};

export type PartnerWork = {
  developers: PartnerDeveloper[];
  buyers: PartnerBuyer[];
  bookings: PartnerBooking[];
  people: PartnerPerson[];
  visits: { id: string; buyer: string; tower: string; project: string; day: string; time: string }[];
};

const timeOf = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16);

/** Everything the firm has with one developer, read in that developer's tenant. */
async function oneDeveloper(dev: { org_id: string; developer: string }, cpOrgId: string, nowIso: string) {
  const orgId = dev.org_id;
  return withTenant(orgId, async (sql) => {
    // One row per desk the firm sits on here (0092): the developer's own first, then the oldest.
    const rows = await sql<{ id: string; rm: string | null; through: string | null; rera_agent_no: string | null; rera_valid_till: Date | string | null }[]>`
      SELECT f.id, f.rera_agent_no, f.rera_valid_till, coalesce(u.name, split_part(u.email::text, '@', 1)) AS rm,
             (SELECT m.firm_name FROM mandates m WHERE m.id = f.mandate_id) AS through
      FROM partner_firms f LEFT JOIN users u ON u.id = f.rm_id
      WHERE f.org_id = ${orgId} AND f.cp_org_id = ${cpOrgId}
      ORDER BY (f.mandate_id IS NULL) DESC, f.created_at`;
    if (!rows.length) return null;
    const firmIds = rows.map((r) => r.id);
    // "Through" a mandate firm only when no project is on the developer's own desk.
    const firm = { ...rows[0], through: rows.some((r) => !r.through) ? null : [...new Set(rows.map((r) => r.through))].join(", ") };

    // A project ended more than ninety days ago is history, not work.
    const grants = await sql<{
      project_id: string; name: string; path: string; status: GrantState["status"]; valid_from: Date; valid_to: Date;
      steps: unknown; registration_days: number | null; ladder_period: string | null;
    }[]>`
      SELECT DISTINCT ON (g.scope_node_id) g.scope_node_id AS project_id, n.name, n.path::text AS path, g.status, g.valid_from, g.valid_to,
             t.steps, t.registration_days, t.ladder_period
      FROM grants g JOIN scope_nodes n ON n.id = g.scope_node_id
      LEFT JOIN commission_terms t ON t.id = g.commission_terms_ref
      WHERE g.org_id = ${orgId} AND g.grantee_org_id = ${cpOrgId} AND g.role = 'CHANNEL_PARTNER'
        AND (g.status <> 'ENDED' OR g.valid_to > now() - interval '90 days')
      ORDER BY g.scope_node_id, (g.status <> 'ENDED') DESC, g.valid_to DESC`;
    const live = grants.filter((g) => grantLive({ status: g.status, validFrom: g.valid_from.toISOString(), validTo: g.valid_to.toISOString() }, nowIso));
    const livePaths = live.map((g) => g.path);

    const [towers, links, posts, booked, regs, pays, agents, visits] = await Promise.all([
      livePaths.length
        ? sql<{ id: string; name: string; path: string; project_id: string }[]>`
            SELECT t.id, t.name, t.path::text AS path, p.id AS project_id
            FROM scope_nodes t JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
            WHERE t.org_id = ${orgId} AND t.kind = 'PHASE' AND t.path <@ ANY(${livePaths}::ltree[])
            ORDER BY t.name`
        : Promise.resolve([]),
      sql<{ id: string; code: string; scope_node_id: string; tower_path: string; project: string; enquiries: number; claims: number }[]>`
        SELECT DISTINCT ON (l.scope_node_id) l.id, l.code, l.scope_node_id, t.path::text AS tower_path, p.name AS project,
               (SELECT count(*)::int FROM client_registrations r WHERE r.org_id = l.org_id AND r.ref_code = l.code) AS enquiries,
               (SELECT count(*)::int FROM client_registrations r WHERE r.org_id = l.org_id AND r.ref_code = l.code AND r.verdict = 'REGISTERED') AS claims
        FROM partner_links l JOIN scope_nodes t ON t.id = l.scope_node_id
        JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
        WHERE l.org_id = ${orgId} AND l.firm_id = ANY(${firmIds}::uuid[]) AND l.retired_at IS NULL
        ORDER BY l.scope_node_id, l.created_at DESC`,
      livePaths.length
        ? sql<{ id: string; tower_id: string; tower: string; kind: "IMAGE" | "CAROUSEL"; placement: string; headline: string; frames: number }[]>`
            SELECT r.id, t.id AS tower_id, t.name AS tower, r.kind, r.placement, r.headline, jsonb_array_length(r.media)::int AS frames
            FROM rendered_posts r JOIN scope_nodes t ON t.id = r.scope_node_id AND t.kind = 'PHASE'
            WHERE r.org_id = ${orgId} AND r.kind IN ('IMAGE', 'CAROUSEL')
              AND (r.review IS NULL OR (r.review ->> 'passed')::boolean)
              -- Only what the pixel gate passed: anything else is refused at download.
              AND r.pixel ->> 'verdict' = 'PASS'
              AND jsonb_array_length(r.media) > 0
              AND t.path <@ ANY(${livePaths}::ltree[])
            ORDER BY r.created_at DESC LIMIT 24`
        : Promise.resolve([]),
      sql<{ scope_node_id: string; days: string[] }[]>`
        SELECT scope_node_id, array_agg(to_char(booked_on, 'YYYY-MM-DD')) AS days FROM partner_payouts
        WHERE org_id = ${orgId} AND cp_org_id = ${cpOrgId} AND kind = 'PARTNER' AND cancelled_at IS NULL
        GROUP BY scope_node_id`,
      sql<{
        id: string; phone: string; buyer_name: string | null; lead_name: string | null; agent_name: string | null; via: keyof typeof VIA_OF;
        verdict: Verdict; valid_until: Date | null; status: string; created_at: Date; project: string; scope_node_id: string;
        visited: Date | null; booked: Date | string | null; loan_stage: LoanStage | null;
      }[]>`
        SELECT r.id, r.phone, r.buyer_name, r.agent_name, r.via, r.verdict, r.valid_until, r.status, r.created_at,
               n.name AS project, r.scope_node_id,
               (SELECT l.name FROM leads l WHERE l.org_id = r.org_id AND l.id = r.lead_id) AS lead_name,
               (SELECT min(coalesce(v.arrived_at, v.completed_at)) FROM site_visits v
                 WHERE v.org_id = r.org_id AND v.lead_id = r.lead_id AND v.status IN ('ON_SITE', 'VISITED')) AS visited,
               (SELECT p.booked_on FROM partner_payouts p WHERE p.org_id = r.org_id AND p.registration_id = r.id AND p.cancelled_at IS NULL LIMIT 1) AS booked,
               -- Only the stage, and only on the firm's own claim, as partnerLoanLine() says it.
               -- and only when the developer switched it on and the buyer said yes (partnerMaySee()).
               CASE WHEN r.verdict = 'REGISTERED' AND r.lead_id IS NOT NULL
                         AND coalesce((SELECT ps.share_loan_stage FROM partner_settings ps WHERE ps.org_id = r.org_id), false)
                    THEN (SELECT o.stage FROM lead_loans o WHERE o.org_id = r.org_id AND o.lead_id = r.lead_id AND o.partner_share = 'YES') END AS loan_stage
        FROM client_registrations r JOIN scope_nodes n ON n.id = r.scope_node_id
        -- A repeat of a claim the firm already holds is logged, and is not a row of its own here.
        WHERE r.org_id = ${orgId} AND r.cp_org_id = ${cpOrgId} AND r.verdict <> 'ALREADY'
        ORDER BY r.created_at DESC LIMIT 500`,
      sql<{
        id: string; unit: string | null; agreement: string; booking_no: number; rate: string; pass_back: string; gst_registered: boolean;
        booked_on: Date | string; agreement_registered_on: Date | string | null; collected_on: Date | string | null; cancelled_at: Date | null;
        buyer: string; project: string;
      }[]>`
        SELECT p.id, p.unit, p.agreement, p.booking_no, p.rate, p.pass_back, p.gst_registered, p.booked_on,
               p.agreement_registered_on, p.collected_on, p.cancelled_at, l.name AS buyer, n.name AS project
        FROM partner_payouts p JOIN scope_nodes n ON n.id = p.scope_node_id JOIN leads l ON l.id = p.lead_id
        WHERE p.org_id = ${orgId} AND p.cp_org_id = ${cpOrgId} AND p.kind = 'PARTNER'
        ORDER BY p.booked_on DESC`,
      sql<{ id: string; name: string; phone: string; is_principal: boolean; status: "WAITING" | "ACTIVE" }[]>`
        SELECT id, name, phone, is_principal, status FROM partner_agents
        WHERE org_id = ${orgId} AND firm_id = ANY(${firmIds}::uuid[]) AND status <> 'REMOVED'
        ORDER BY is_principal DESC, created_at`,
      sql<{ id: string; registration_id: string; scheduled_at: Date; tower: string; project: string; buyer: string }[]>`
        SELECT DISTINCT ON (r.id) v.id, r.id AS registration_id, v.scheduled_at, t.name AS tower, p.name AS project,
               coalesce(l.name, r.buyer_name, 'Buyer') AS buyer
        FROM client_registrations r
        JOIN site_visits v ON v.org_id = r.org_id AND v.lead_id = r.lead_id
        JOIN scope_nodes t ON t.id = v.scope_node_id
        JOIN scope_nodes p ON p.id = r.scope_node_id
        LEFT JOIN leads l ON l.id = r.lead_id
        WHERE r.org_id = ${orgId} AND r.cp_org_id = ${cpOrgId} AND r.verdict = 'REGISTERED'
          AND v.status IN ('CONFIRMED', 'REQUESTED') AND v.scheduled_at > now() - interval '2 hours'
        ORDER BY r.id, v.scheduled_at`,
    ]);

    const payIds = pays.map((p) => p.id);
    const [miles, invoices, sentBack] = payIds.length
      ? await Promise.all([
          sql<{ id: string; payout_id: string; key: MilestoneKey; base: string; gst: string; gross: string; tds: string; net: string; stage: keyof typeof STAGE_OF; paid_on: Date | string | null; utr: string | null }[]>`
            SELECT id, payout_id, key, base, gst, gross, tds, net, stage, paid_on, utr FROM payout_milestones
            WHERE org_id = ${orgId} AND payout_id = ANY(${payIds})`,
          sql<{ milestone_id: string; id: string; invoice_no: string; invoice_date: Date | string; amount: string; attested_at: Date | null }[]>`
            SELECT DISTINCT ON (i.milestone_id) i.milestone_id, i.id, i.invoice_no, i.invoice_date, i.amount, i.attested_at
            FROM partner_invoices i JOIN payout_milestones m ON m.id = i.milestone_id
            WHERE i.org_id = ${orgId} AND m.payout_id = ANY(${payIds}) AND i.rejected_at IS NULL
            ORDER BY i.milestone_id, i.created_at DESC`,
          // The last invoice sent back on each half, so the partner reads why.
          sql<{ milestone_id: string; invoice_no: string; reject_reason: string | null }[]>`
            SELECT DISTINCT ON (i.milestone_id) i.milestone_id, i.invoice_no, i.reject_reason
            FROM partner_invoices i JOIN payout_milestones m ON m.id = i.milestone_id
            WHERE i.org_id = ${orgId} AND m.payout_id = ANY(${payIds}) AND i.rejected_at IS NOT NULL
            ORDER BY i.milestone_id, i.rejected_at DESC`,
        ])
      : [[], [], []];

    // Which number a buyer tapping each link writes to, asked once a tower.
    const numbers = new Map<string, string | null>();
    for (const l of links) {
      if (!numbers.has(l.tower_path)) numbers.set(l.tower_path, (await numberAt(sql, orgId, l.tower_path))?.phone ?? null);
    }

    // What cancelled bookings took back from the firm here, and which later halves it came off.
    const [debits, uses] = payIds.length
      ? await Promise.all([
          sql<{ payout_id: string; amount: string; used: string }[]>`
            SELECT a.payout_id, a.amount,
                   coalesce((SELECT sum(u.amount) FROM partner_adjustment_uses u
                     JOIN payout_milestones ms ON ms.id = u.milestone_id JOIN partner_payouts p ON p.id = ms.payout_id
                     WHERE u.adjustment_id = a.id AND (ms.stage = 'PAID' OR p.cancelled_at IS NULL)), 0) AS used
            FROM partner_adjustments a WHERE a.org_id = ${orgId} AND a.cp_org_id = ${cpOrgId} AND a.payout_id = ANY(${payIds})`,
          sql<{ milestone_id: string; amount: string; against: string | null }[]>`
            SELECT u.milestone_id, u.amount, coalesce(p.unit, 'a cancelled booking') AS against
            FROM partner_adjustment_uses u JOIN partner_adjustments a ON a.id = u.adjustment_id JOIN partner_payouts p ON p.id = a.payout_id
            WHERE u.org_id = ${orgId} AND a.cp_org_id = ${cpOrgId}`,
        ])
      : [[], []];

    return { firm, grants, towers, links, posts, booked, regs, pays, miles, invoices, sentBack, agents, visits, numbers, debits, uses };
  });
}

/** Everything the workspace draws, for one request. */
export const partnerWork = cache(async (cpOrgId: string, nowIso: string = new Date().toISOString()): Promise<PartnerWork> => {
  const today = istDay(nowIso);
  const devs = await withTenant(cpOrgId, (sql) => sql<{ org_id: string; developer: string }[]>`
    SELECT org_id, developer FROM partner_developers_for_firm()`);
  const read = await Promise.all(devs.map(async (d) => ({ d, r: await oneDeveloper(d, cpOrgId, nowIso) })));
  // A link or a post is only worth offering on a tower the RERA gate clears today.
  const clear = new Map<string, boolean>();
  await Promise.all(
    read.flatMap(({ d, r }) =>
      (r?.towers ?? []).map(async (t) => clear.set(t.id, (await canPublish(d.org_id, t.id, new Date(nowIso))).ok)),
    ),
  );

  const out: PartnerWork = { developers: [], buyers: [], bookings: [], people: [], visits: [] };
  for (const { d, r } of read) {
    if (!r) continue;
    const bookedBy = new Map(r.booked.map((b) => [b.scope_node_id, b.days]));
    out.developers.push({
      orgId: d.org_id,
      name: d.developer,
      firmId: r.firm.id,
      rm: r.firm.rm,
      through: r.firm.through,
      agentOnFile: { reraNo: r.firm.rera_agent_no, reraTill: r.firm.rera_valid_till ? (typeof r.firm.rera_valid_till === "string" ? r.firm.rera_valid_till.slice(0, 10) : r.firm.rera_valid_till.toISOString().slice(0, 10)) : null },
      projects: r.grants.map((g) => {
        const status = grantStatus({ status: g.status, validFrom: g.valid_from.toISOString(), validTo: g.valid_to.toISOString() }, nowIso);
        const towers = r.towers.filter((t) => t.project_id === g.project_id);
        return {
          id: g.project_id,
          name: g.name,
          status,
          validTo: istDay(g.valid_to.toISOString()),
          steps: parseSteps(g.steps) ?? DEFAULT_TERMS.steps,
          registrationDays: g.registration_days ?? DEFAULT_TERMS.registrationDays,
          // Counted over the project's ladder period, as the developer's desk counts it.
          booked: bookingsCounted(bookedBy.get(g.project_id) ?? [], isLadderPeriod(g.ladder_period) ? g.ladder_period : "ALL", today),
          towers: towers.map((t) => {
            const l = r.links.find((x) => x.scope_node_id === t.id);
            const number = l ? r.numbers.get(l.tower_path) ?? null : null;
            const base = enquiryUrl(d.org_id, t.id);
            return {
              id: t.id,
              name: t.name,
              advertisable: clear.get(t.id) ?? false,
              link: l
                ? {
                    id: l.id,
                    code: l.code,
                    url: number ? waMeLink(number, tapText(l.project, l.code)) : base ? `${base}&cp=${l.code}` : null,
                    whatsapp: !!number,
                    enquiries: l.enquiries,
                    claims: l.claims,
                  }
                : null,
            };
          }),
          posts: r.posts
            .filter((p) => towers.some((t) => t.id === p.tower_id) && clear.get(p.tower_id))
            .map((p) => ({ id: p.id, towerId: p.tower_id, tower: p.tower, kind: p.kind, placement: p.placement, headline: p.headline, frames: p.frames })),
        };
      }),
    });

    const nextVisit = new Map(r.visits.map((v) => [v.registration_id, v]));
    for (const x of r.regs) {
      const reason = REFUSE_OF[x.verdict];
      const until = x.valid_until ? istDay(x.valid_until.toISOString()) : undefined;
      const v = nextVisit.get(x.id);
      out.buyers.push({
        id: x.id,
        devOrgId: d.org_id,
        developer: d.developer,
        projectId: x.scope_node_id,
        buyer: x.lead_name ?? x.buyer_name ?? "Buyer",
        // Masked here, on the server: the whole number never reaches the page.
        phone: x.phone ? maskPhone(x.phone) : "",
        firm: "",
        agent: x.agent_name ?? "",
        project: x.project,
        registeredOn: istDay(x.created_at.toISOString()),
        validUntil: x.verdict === "REGISTERED" ? (x.status === "RELEASED" && until && until > today ? today : until) : undefined,
        via: VIA_OF[x.via],
        visitedOn: x.visited ? istDay(x.visited.toISOString()) : null,
        bookedOn: dayOf(x.booked),
        // The firm holding a buyer is never named to another firm; only until when.
        refused: reason ? { reason, heldUntil: x.verdict === "BLOCKED" ? until : undefined } : null,
        live: x.verdict === "REGISTERED" && x.status === "ACTIVE" && !!x.valid_until && x.valid_until.toISOString() > nowIso,
        visit: v ? { id: v.id, day: istDay(v.scheduled_at.toISOString()), time: timeOf(v.scheduled_at), tower: v.tower } : null,
        loanStage: x.loan_stage ?? null,
      });
    }

    for (const v of r.visits) {
      out.visits.push({ id: v.id, buyer: v.buyer, tower: v.tower, project: v.project, day: istDay(v.scheduled_at.toISOString()), time: timeOf(v.scheduled_at) });
    }

    for (const p of r.pays) {
      const ms = r.miles.filter((m) => m.payout_id === p.id);
      const progress = {} as Booking["progress"];
      const frozen = {} as Record<MilestoneKey, Invoice>;
      for (const key of ["M1", "M2"] as const) {
        const m = ms.find((x) => x.key === key);
        const inv = m ? r.invoices.find((i) => i.milestone_id === m.id) : undefined;
        const back = m && !inv && m.stage === "NONE" ? r.sentBack.find((i) => i.milestone_id === m.id) : undefined;
        progress[key] = {
          sentBack: back ? { no: back.invoice_no, reason: isRejectReason(back.reject_reason) ? back.reject_reason : null } : null,
          stage: m ? STAGE_OF[m.stage] : "none",
          paidOn: dayOf(m?.paid_on ?? null) ?? undefined,
          utr: m?.utr ?? undefined,
          invoice: inv
            ? { id: inv.id, no: inv.invoice_no, date: dayOf(inv.invoice_date)!, amount: Number(inv.amount), attestedOn: inv.attested_at ? istDay(inv.attested_at.toISOString()) : null }
            : null,
        };
        if (m) frozen[key] = { base: Number(m.base), gst: Number(m.gst), gross: Number(m.gross), tds: Number(m.tds), net: Number(m.net) };
      }
      out.bookings.push({
        id: p.id,
        devOrgId: d.org_id,
        developer: d.developer,
        unit: p.unit ?? "Unit",
        buyer: p.buyer,
        place: p.project,
        firm: "",
        agent: "",
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
        adjusted: Object.fromEntries(
          (["M1", "M2"] as const).flatMap((key) => {
            const m = ms.find((x) => x.key === key);
            const used = m ? r.uses.filter((u) => u.milestone_id === m.id) : [];
            return used.length ? [[key, used.map((u) => ({ amount: Number(u.amount), against: u.against ?? "a cancelled booking" }))]] : [];
          }),
        ),
        clawback: (() => {
          const debit = r.debits.find((x) => x.payout_id === p.id);
          return debit ? { amount: -Number(debit.amount), outstanding: Math.max(0, -Number(debit.amount) - Number(debit.used)) } : null;
        })(),
      });
    }

    for (const a of r.agents) {
      out.people.push({ id: a.id, devOrgId: d.org_id, developer: d.developer, name: a.name, phone: maskPhone(a.phone), principal: a.is_principal, proved: a.status === "ACTIVE" });
    }
  }
  out.visits.sort((a, b) => `${a.day} ${a.time}`.localeCompare(`${b.day} ${b.time}`));
  return out;
});

// ---------------------------------------------------------------------------
// Writes: each asks that the developer still has the firm, then the one function
// ---------------------------------------------------------------------------

/**
 * The firm's row on a developer's desk, or null when the developer does not
 * have it. A firm may sit on two desks of one developer, one per project
 * (0092), so a write about a project or a tower (`nodeId`) takes the row of
 * the desk that has the firm there.
 */
async function firmOn(devOrgId: string, cpOrgId: string, nodeId?: string): Promise<{ id: string } | null> {
  if (!isId(devOrgId)) return null;
  const devs = await withTenant(cpOrgId, (sql) => sql<{ org_id: string }[]>`SELECT org_id FROM partner_developers_for_firm()`);
  if (!devs.some((d) => d.org_id === devOrgId)) return null;
  return withTenant(devOrgId, async (sql) => {
    if (nodeId && isId(nodeId)) {
      const id = await deskFirmIn(sql, devOrgId, cpOrgId, nodeId);
      if (id) return { id };
    }
    const [f] = await sql<{ id: string }[]>`
      SELECT id FROM partner_firms WHERE org_id = ${devOrgId} AND cp_org_id = ${cpOrgId}
      ORDER BY (mandate_id IS NULL) DESC, created_at LIMIT 1`;
    return f ?? null;
  });
}

export type WorkspaceResult = { ok: boolean; message: string; tone?: "ok" | "info" | "risk" };

/** A buyer registered by the firm itself, and the verdict in its own words. */
export async function registerForFirm(opts: {
  cpOrgId: string;
  /** Null when the firm's own setting registered it, not a person. */
  userId: string | null;
  agentName: string | null;
  devOrgId: string;
  projectId: string;
  phone: string;
  buyerName: string | null;
  nowIso?: string;
}): Promise<WorkspaceResult> {
  const firm = await firmOn(opts.devOrgId, opts.cpOrgId, opts.projectId);
  if (!firm || !isId(opts.projectId)) return { ok: false, message: "Choose a project you are empanelled on." };
  // Only a project this developer has granted the firm; any other is not the firm's to try.
  const [granted] = await withTenant(opts.devOrgId, (sql) => sql<{ one: number }[]>`
    SELECT 1 AS one FROM grants WHERE org_id = ${opts.devOrgId} AND grantee_org_id = ${opts.cpOrgId}
      AND scope_node_id = ${opts.projectId} AND role = 'CHANNEL_PARTNER' LIMIT 1`);
  if (!granted) return { ok: false, message: "Choose a project you are empanelled on." };
  const out = await registerBuyer({
    orgId: opts.devOrgId,
    userId: opts.userId,
    firmId: firm.id,
    projectId: opts.projectId,
    phone: opts.phone,
    buyerName: opts.buyerName,
    agentName: opts.agentName,
    via: "WORKSPACE",
    nowIso: opts.nowIso,
  });
  if (!out.ok) return { ok: false, message: out.message };
  const good = out.verdict === "REGISTERED" || out.verdict === "ALREADY";
  return { ok: good, message: out.message, tone: out.verdict === "REGISTERED" ? "ok" : good ? "info" : "risk" };
}

/** A visit for one of the firm's own live buyers, at a tower of that buyer's project. */
export async function bookForFirm(opts: {
  cpOrgId: string;
  userId: string;
  devOrgId: string;
  registrationId: string;
  towerId: string;
  date: string;
  time: string;
  nowIso?: string;
}): Promise<WorkspaceResult> {
  const firm = await firmOn(opts.devOrgId, opts.cpOrgId);
  if (!firm || !isId(opts.registrationId) || !isId(opts.towerId)) return { ok: false, message: "That buyer is not yours to book." };
  const [claim] = await withTenant(opts.devOrgId, (sql) => sql<{ live: boolean }[]>`
    SELECT (r.verdict = 'REGISTERED' AND r.status = 'ACTIVE' AND r.valid_until > now()) AS live
    FROM client_registrations r
    JOIN scope_nodes p ON p.id = r.scope_node_id
    JOIN scope_nodes t ON t.org_id = r.org_id AND t.id = ${opts.towerId} AND t.kind = 'PHASE' AND t.path <@ p.path
    WHERE r.org_id = ${opts.devOrgId} AND r.id = ${opts.registrationId} AND r.cp_org_id = ${opts.cpOrgId}`);
  if (!claim) return { ok: false, message: "That buyer is not yours to book." };
  if (!claim.live) return { ok: false, message: "This registration has run out. Register the buyer again first." };
  const out = await bookPartnerVisit({
    orgId: opts.devOrgId,
    userId: opts.userId,
    registrationId: opts.registrationId,
    phaseId: opts.towerId,
    date: opts.date,
    time: opts.time,
    nowIso: opts.nowIso,
  });
  return { ok: out.ok, message: out.message, tone: out.ok ? "ok" : "risk" };
}

/** The firm's link for a tower: the live one, or a new one when it has none. */
export async function linkForFirm(opts: { cpOrgId: string; userId: string; devOrgId: string; towerId: string; nowIso?: string }): Promise<
  { ok: true; id: string; code: string } | { ok: false; message: string }
> {
  const firm = await firmOn(opts.devOrgId, opts.cpOrgId, opts.towerId);
  if (!firm || !isId(opts.towerId)) return { ok: false, message: "That tower is not one you sell." };
  const [have] = await withTenant(opts.devOrgId, (sql) => sql<{ id: string; code: string }[]>`
    SELECT id, code FROM partner_links
    WHERE org_id = ${opts.devOrgId} AND firm_id = ${firm.id} AND scope_node_id = ${opts.towerId} AND retired_at IS NULL
    ORDER BY created_at DESC LIMIT 1`);
  if (have) return { ok: true, id: have.id, code: have.code };
  return makeLink({ orgId: opts.devOrgId, userId: opts.userId, firmId: firm.id, phaseId: opts.towerId, agentName: null, nowIso: opts.nowIso });
}

/** The tower an approved post sits on, when the firm may take a copy of it. */
export async function postTower(opts: { cpOrgId: string; devOrgId: string; postId: string }): Promise<string | null> {
  const firm = await firmOn(opts.devOrgId, opts.cpOrgId);
  if (!firm || !isId(opts.postId)) return null;
  const [row] = await withTenant(opts.devOrgId, (sql) => sql<{ tower_id: string }[]>`
    SELECT t.id AS tower_id FROM rendered_posts r
    JOIN scope_nodes t ON t.id = r.scope_node_id AND t.kind = 'PHASE'
    JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
    JOIN grants g ON g.org_id = r.org_id AND g.grantee_org_id = ${opts.cpOrgId} AND g.scope_node_id = p.id
      AND g.role = 'CHANNEL_PARTNER' AND g.status = 'ACTIVE' AND g.valid_from <= now() AND g.valid_to > now()
    WHERE r.org_id = ${opts.devOrgId} AND r.id = ${opts.postId} AND r.kind IN ('IMAGE', 'CAROUSEL')
    LIMIT 1`);
  return row?.tower_id ?? null;
}

/** What needs the firm today, for the console's queue. Nothing for a company no developer empanelled. */
export async function partnerQueueFor(cpOrgId: string, nowIso: string = new Date().toISOString()): Promise<PartnerItem[]> {
  try {
    const [w, [p]] = await Promise.all([
      partnerWork(cpOrgId, nowIso),
      withTenant(cpOrgId, (sql) => sql<{ rera_agent_no: string | null; rera_valid_till: Date | null }[]>`
        SELECT rera_agent_no, rera_valid_till FROM firm_profiles WHERE org_id = ${cpOrgId}`),
    ]);
    if (!w.developers.length) return [];
    return partnerToday(
      {
        agent: { reraNo: p?.rera_agent_no ?? null, reraTill: p?.rera_valid_till ? p.rera_valid_till.toISOString().slice(0, 10) : null },
        onFile: w.developers
          .filter((d) => d.projects.some((x) => x.status === "live"))
          .map((d) => ({ developer: d.name, rm: d.rm, reraNo: d.agentOnFile.reraNo, reraTill: d.agentOnFile.reraTill })),
        projects: w.developers.flatMap((d) => d.projects.map((x) => ({ developer: d.name, project: x.name, status: x.status, validTo: x.validTo }))),
        buyers: w.buyers,
        visits: w.visits.map((x) => ({ ...x, time: showTime(x.time) })),
        bookings: w.bookings,
        // The queue is the company's, so an invoice to send says which and never how much.
        amounts: false,
      },
      istDay(nowIso),
      longDay,
      rupees,
    );
  } catch (e) {
    console.error("partner: the firm's items could not be read", e);
    return [];
  }
}

export type PartnerMember = { id: string; name: string; contact: string; how: "web" | "whatsapp"; role: string };

const MEMBER_ROLE: Record<string, string> = { ORG_ADMIN: "Admin", CP_OWNER: "Principal", CP_AGENT: "Agent" };

/** The firm's own people: who signs in here, and who has proved their number on WhatsApp. */
export async function partnerMembers(cpOrgId: string): Promise<PartnerMember[]> {
  const rows = await withTenant(cpOrgId, (sql) => sql<{ id: string; name: string | null; email: string | null; phone: string | null; role: string }[]>`
    SELECT DISTINCT ON (u.id) u.id, u.name, u.email::text AS email, u.phone, m.role
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${cpOrgId} AND m.status = 'ACTIVE' AND u.erased_at IS NULL
    ORDER BY u.id, (m.role = 'ORG_ADMIN') DESC`);
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name ?? (r.email ? r.email.split("@")[0] : "On WhatsApp"),
      contact: r.email ?? (r.phone ? maskPhone(r.phone) : ""),
      how: (r.email ? "web" : "whatsapp") as PartnerMember["how"],
      role: MEMBER_ROLE[r.role] ?? "Member",
    }))
    .sort((a, b) => (a.role === "Admin" ? -1 : b.role === "Admin" ? 1 : a.name.localeCompare(b.name)));
}

/** A small picture of an approved post, for the partner to choose from. The band goes on at download. */
export async function postPreview(opts: { cpOrgId: string; devOrgId: string; postId: string; index: number }): Promise<Buffer | null> {
  if (!Number.isInteger(opts.index) || opts.index < 0) return null;
  const tower = await postTower(opts);
  if (!tower) return null;
  const [row] = await withTenant(opts.devOrgId, (sql) => sql<{ media: { key: string; type: string }[] }[]>`
    SELECT media FROM rendered_posts WHERE org_id = ${opts.devOrgId} AND id = ${opts.postId}`);
  const item = row?.media?.[opts.index];
  if (!item || !["image/jpeg", "image/png"].includes(item.type)) return null;
  const bytes = await readAsset(item.key);
  if (!bytes) return null;
  const { default: sharp } = await import("sharp");
  return sharp(bytes).resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
}

export type LeadRegistration = { id: string; developer: string; project: string; state: "registered" | "booked" | "ran_out" | "refused"; until: string | null };

/**
 * Where one of the partner's own leads stands with each developer: every
 * registration of that number the firm made, newest first. Read in each
 * developer's tenant, filtered to this firm and this number.
 */
export async function registrationsForPhone(cpOrgId: string, phone: string): Promise<LeadRegistration[]> {
  const devs = await withTenant(cpOrgId, (sql) => sql<{ org_id: string; developer: string }[]>`
    SELECT org_id, developer FROM partner_developers_for_firm()`);
  const rows = await Promise.all(
    devs.map((d) =>
      withTenant(d.org_id, (sql) => sql<{ id: string; project: string; verdict: string; status: string; valid_until: Date | null }[]>`
        SELECT r.id, n.name AS project, r.verdict, r.status, r.valid_until
        FROM client_registrations r JOIN scope_nodes n ON n.id = r.scope_node_id
        WHERE r.org_id = ${d.org_id} AND r.cp_org_id = ${cpOrgId} AND r.phone = ${phone} AND r.verdict <> 'ALREADY'
        ORDER BY r.created_at DESC LIMIT 20`).then((rs) =>
        rs.map((r) => ({
          id: r.id,
          developer: d.developer,
          project: r.project,
          state: (r.verdict !== "REGISTERED"
            ? "refused"
            : r.status === "BOOKED"
              ? "booked"
              : r.status === "ACTIVE" && r.valid_until && r.valid_until.getTime() > Date.now()
                ? "registered"
                : "ran_out") as LeadRegistration["state"],
          until: r.valid_until ? istDay(r.valid_until.toISOString()) : null,
        })),
      ),
    ),
  );
  return rows.flat();
}

/** A lead of the partner's own, registered with a developer by its own number and name. */
export async function registerLeadForFirm(opts: {
  cpOrgId: string;
  userId: string;
  agentName: string | null;
  leadId: string;
  devOrgId: string;
  projectId: string;
  /** Whether the person may read a lead at this place: the lead's page asks the same. */
  mayRead: (path: string) => boolean;
}): Promise<WorkspaceResult> {
  if (!isId(opts.leadId)) return { ok: false, message: "That lead is not here." };
  const [lead] = await withTenant(opts.cpOrgId, (sql) => sql<{ phone: string; name: string | null; path: string }[]>`
    SELECT l.phone, l.name, n.path::text AS path FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
    WHERE l.org_id = ${opts.cpOrgId} AND l.id = ${opts.leadId}`);
  if (!lead || !opts.mayRead(lead.path)) return { ok: false, message: "That lead is not here." };
  return registerForFirm({
    cpOrgId: opts.cpOrgId,
    userId: opts.userId,
    agentName: opts.agentName,
    devOrgId: opts.devOrgId,
    projectId: opts.projectId,
    phone: lead.phone,
    buyerName: lead.name,
  });
}

// ---------------------------------------------------------------------------
// The firm's own projects, linked to the developers' projects it sells
// ---------------------------------------------------------------------------

/** Which of the firm's own projects feeds which developer project. Read in the firm's tenant. */
export async function ownProjectLinks(cpOrgId: string): Promise<{ ownProjectId: string; devOrgId: string; devProjectId: string }[]> {
  const rows = await withTenant(cpOrgId, (sql) => sql<{ scope_node_id: string; dev_org_id: string; dev_project_id: string }[]>`
    SELECT scope_node_id, dev_org_id, dev_project_id FROM partner_project_links WHERE org_id = ${cpOrgId}`);
  return rows.map((r) => ({ ownProjectId: r.scope_node_id, devOrgId: r.dev_org_id, devProjectId: r.dev_project_id }));
}

/**
 * The firm says which of its own projects is a developer's project: its
 * leads there are that developer's buyers. `ownProjectId` null takes the
 * link off. Asked first that the developer still has the firm and granted
 * it that project; the link is a pointer the firm's own functions read
 * through, never a grant.
 */
export async function linkOwnProject(opts: {
  cpOrgId: string;
  userId: string;
  devOrgId: string;
  devProjectId: string;
  ownProjectId: string | null;
}): Promise<WorkspaceResult> {
  if (!isId(opts.devProjectId) || (opts.ownProjectId !== null && !isId(opts.ownProjectId))) return { ok: false, message: "Choose a project." };
  const firm = await firmOn(opts.devOrgId, opts.cpOrgId);
  if (!firm) return { ok: false, message: "That developer does not have your firm." };
  const [granted] = await withTenant(opts.devOrgId, (sql) => sql<{ one: number }[]>`
    SELECT 1 AS one FROM grants WHERE org_id = ${opts.devOrgId} AND grantee_org_id = ${opts.cpOrgId}
      AND scope_node_id = ${opts.devProjectId} AND role = 'CHANNEL_PARTNER' LIMIT 1`);
  if (!granted) return { ok: false, message: "Choose a project you are empanelled on." };
  const out = await withTenant(opts.cpOrgId, async (sql) => {
    await sql`DELETE FROM partner_project_links WHERE org_id = ${opts.cpOrgId} AND dev_org_id = ${opts.devOrgId} AND dev_project_id = ${opts.devProjectId}`;
    if (!opts.ownProjectId) return true;
    const [own] = await sql<{ id: string }[]>`
      SELECT id FROM scope_nodes WHERE org_id = ${opts.cpOrgId} AND id = ${opts.ownProjectId} AND kind = 'PROJECT'`;
    if (!own) return false;
    await sql`
      INSERT INTO partner_project_links (org_id, scope_node_id, dev_org_id, dev_project_id, updated_by)
      VALUES (${opts.cpOrgId}, ${own.id}, ${opts.devOrgId}, ${opts.devProjectId}, ${opts.userId})
      ON CONFLICT (org_id, scope_node_id) DO UPDATE SET dev_org_id = EXCLUDED.dev_org_id, dev_project_id = EXCLUDED.dev_project_id,
        updated_by = EXCLUDED.updated_by, updated_at = now()`;
    return true;
  });
  if (!out) return { ok: false, message: "Choose one of your own projects." };
  return { ok: true, message: opts.ownProjectId ? "Linked." : "Link taken off.", tone: "ok" };
}

/**
 * A lead the firm captured, registered with the developer whose project its
 * own project is linked to, when the firm switched that on. Runs after the
 * capture has committed, writes what happened on the lead's history, and
 * never throws: a refusal is a line on the lead, not a failed capture.
 */
export async function autoRegisterCaptured(cpOrgId: string, leadId: string, nowIso?: string): Promise<void> {
  try {
    const found = await withTenant(cpOrgId, async (sql) => {
      const [s] = await sql<{ auto_register: boolean }[]>`SELECT auto_register FROM partner_settings WHERE org_id = ${cpOrgId}`;
      if (!s?.auto_register) return null;
      const [row] = await sql<{ phone: string; name: string | null; dev_org_id: string; dev_project_id: string }[]>`
        SELECT l.phone, l.name, k.dev_org_id, k.dev_project_id
        FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
        JOIN scope_nodes p ON p.org_id = l.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
        JOIN partner_project_links k ON k.org_id = l.org_id AND k.scope_node_id = p.id
        WHERE l.org_id = ${cpOrgId} AND l.id = ${leadId}
        LIMIT 1`;
      return row ?? null;
    });
    if (!found) return;
    const out = await registerForFirm({
      cpOrgId,
      userId: null,
      agentName: null,
      devOrgId: found.dev_org_id,
      projectId: found.dev_project_id,
      phone: found.phone,
      buyerName: found.name,
      nowIso,
    });
    const line = `${out.ok ? "Registered with the developer" : "Not registered with the developer"}: ${out.message}`.slice(0, 200);
    await withTenant(cpOrgId, (sql) => sql`
      INSERT INTO lead_activity (org_id, lead_id, kind, reason, detail)
      VALUES (${cpOrgId}, ${leadId}, 'NOTE', ${line}, ${sql.json({ auto_register: out.ok ? "REGISTERED" : "REFUSED" } as never)})`);
  } catch (e) {
    console.error(`partners: could not register lead ${leadId} with the developer`, e);
  }
}

// ---------------------------------------------------------------------------
// A firm's own invoice, filed with a developer
// ---------------------------------------------------------------------------

/** The developers a mandate firm holds a mandate from, read in its own tenant. */
async function mandateDevelopers(firmOrgId: string): Promise<string[]> {
  const rows = await withTenant(firmOrgId, (sql) => sql<{ developer_org_id: string | null }[]>`
    SELECT DISTINCT developer_org_id FROM mandates_for_firm()`);
  return rows.map((r) => r.developer_org_id).filter((id): id is string => !!id);
}

/**
 * A channel partner's invoice for its brokerage, or a mandate firm's for its
 * commission, filed from its own console. It lands in the developer's tenant
 * through the desk's own `fileInvoice()`: the same file store, the same
 * state machine, the developer's verification unchanged. Asked first that
 * the developer still has the firm (on a desk, or through a mandate), then
 * that the half is the firm's own, owed and with nothing on file.
 */
export async function fileInvoiceForFirm(opts: {
  firmOrgId: string;
  userId: string;
  kind: "PARTNER" | "MANDATE";
  /** The developer, for a partner; a mandate firm's is found from its mandates. */
  devOrgId?: string | null;
  payoutId: string;
  key: "M1" | "M2";
  invoiceNo: string;
  invoiceDate: string;
  amount: number;
  bytes: Buffer;
  mediaType: string;
  today: string;
}): Promise<WorkspaceResult> {
  const notYours: WorkspaceResult = { ok: false, message: "That booking is not yours to invoice.", tone: "risk" };
  if (!isId(opts.payoutId) || (opts.key !== "M1" && opts.key !== "M2")) return notYours;
  let devs: string[];
  if (opts.kind === "PARTNER") {
    if (!opts.devOrgId || !(await firmOn(opts.devOrgId, opts.firmOrgId))) return notYours;
    devs = [opts.devOrgId];
  } else {
    const held = await mandateDevelopers(opts.firmOrgId);
    devs = opts.devOrgId ? held.filter((d) => d === opts.devOrgId) : held;
  }
  for (const devOrgId of devs) {
    const [h] = await withTenant(devOrgId, (sql) => sql<{ id: string; kind: string; cp_org_id: string; stage: string; owed: boolean; cancelled: boolean }[]>`
      SELECT m.id, p.kind, p.cp_org_id, m.stage, p.cancelled_at IS NOT NULL AS cancelled,
             CASE WHEN m.key = 'M1' THEN p.agreement_registered_on IS NOT NULL ELSE p.collected_on IS NOT NULL END AS owed
      FROM partner_payouts p JOIN payout_milestones m ON m.payout_id = p.id AND m.key = ${opts.key}
      WHERE p.org_id = ${devOrgId} AND p.id = ${opts.payoutId}`);
    if (!h) continue;
    const refusal = firmInvoiceRefusal(
      { kind: h.kind, firmOrgId: h.cp_org_id, stage: h.stage, owed: h.owed, cancelled: h.cancelled },
      { kind: opts.kind, firmOrgId: opts.firmOrgId },
    );
    if (refusal) return { ok: false, message: refusal, tone: "risk" };
    const out = await fileInvoice({
      orgId: devOrgId,
      userId: opts.userId,
      milestoneId: h.id,
      invoiceNo: opts.invoiceNo,
      invoiceDate: opts.invoiceDate,
      amount: opts.amount,
      bytes: opts.bytes,
      mediaType: opts.mediaType,
      today: opts.today,
      byFirm: true,
    });
    return {
      ok: out.ok,
      message: out.ok ? out.message.replace(/^Invoice filed\./, "Invoice sent to the developer.") : out.message,
      tone: out.ok ? "ok" : "risk",
    };
  }
  return notYours;
}
