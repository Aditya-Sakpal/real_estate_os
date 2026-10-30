import { withTenant } from "@/lib/db";
import { billingQueue } from "@/lib/billing";
import { firmQueue, mandateQueue } from "@/lib/mandates";
import { firmCommission } from "@/lib/firm-workspace";
import { partnerQueueFor } from "@/lib/partner-workspace";
import { commissionAlerts, longDay, sellsForOthers, type MandateAlert } from "@/lib/mandate-rules";
import { ssoQueue } from "@/lib/sso";
import { reportAlertsFor } from "@/lib/report-alerts";
import { portalQueue } from "@/lib/portal-leads";
import { waitingCallerQueue } from "@/lib/waiting-callers";
import { outsideQueue } from "@/lib/outside";
import { loanQueue } from "@/lib/loans";
import { departureQueue } from "@/lib/departures";
import { handoffAlertFor, pickupAlertsFor } from "@/lib/calling-health";
import { redactPhones } from "@/lib/mask-rules";
import { LAPSE_WARNING_DAYS } from "@/lib/publish-gate";
import { loadReadiness, type PhaseReadiness } from "@/lib/readiness";
import { sarvamConfig } from "@/lib/sarvam";
import { retiredProjects, sharedQueue } from "@/lib/project-state";
import { sharedTitle } from "@/lib/project-life-rules";
import { showPhone } from "@/lib/call-rules";

/**
 * The queue is derived from real state, never mocked.
 *
 * Today that state is thin -- one org, no entities, no projects -- so the
 * queue's first items are genuine setup gaps: no second admin, no legal
 * entity, no project. They are not placeholders standing in for future work;
 * they are real findings that disappear the moment the condition is met, which
 * is exactly how the RERA and approval items will behave once those tables
 * exist.
 *
 * It carries the readiness pass too, so the six gates a phase has to clear
 * before it can carry a campaign are resolved once per page and shared with
 * the screens that draw them. They are not queue items: a queue is what is
 * wrong, and the gates are the work in hand.
 *
 * Everything here reads through withTenant(), so RLS scopes it.
 */

export type Severity = "risk" | "warn" | "info";

export type QueueItem = {
  id: string;
  severity: Severity;
  title: string;
  /** Why this matters, in the product's own language. Never generic. */
  why: string;
  action: string;
  href: string;
  /** Shown as a pill. Null when the item has no deadline pressure. */
  tag?: { text: string; tone: "risk" | "warn" | "ok" | "quiet" } | null;
  /**
   * Permissions that can actually resolve this. Others see it as read-only.
   * Empty: anybody who sees it may follow it, because it only opens a screen.
   */
  resolvers: string[];
};

/**
 * Money and approvals waiting on the developer: commission invoices to
 * check on its own payouts (a mandate firm's and its own partners'), and
 * quotes drafted and not yet approved.
 */
async function approvalsQueue(orgId: string): Promise<QueueItem[]> {
  try {
    const [row] = await withTenant(orgId, (sql) => sql<{ invoices: number; mandate_invoices: number; quotes: number }[]>`
      SELECT
        (SELECT count(*)::int FROM payout_milestones ms JOIN partner_payouts p ON p.id = ms.payout_id
          WHERE ms.org_id = ${orgId} AND ms.stage = 'INVOICED' AND p.cancelled_at IS NULL AND p.payer_mandate_id IS NULL) AS invoices,
        (SELECT count(*)::int FROM payout_milestones ms JOIN partner_payouts p ON p.id = ms.payout_id
          WHERE ms.org_id = ${orgId} AND ms.stage = 'INVOICED' AND p.cancelled_at IS NULL AND p.payer_mandate_id IS NULL
            AND p.kind = 'MANDATE') AS mandate_invoices,
        (SELECT count(*)::int FROM quotes q
          WHERE q.org_id = ${orgId} AND q.state = 'DRAFT' AND q.created_at > now() - interval '7 days') AS quotes`);
    const out: QueueItem[] = [];
    if (row?.invoices) {
      out.push({
        id: "invoices-to-check",
        severity: "info",
        title: `${row.invoices} commission ${row.invoices === 1 ? "invoice" : "invoices"} to check`,
        why: row.mandate_invoices
          ? `${row.mandate_invoices} from a mandate firm. Verify each against what the booking owes, then approve it for payment.`
          : "From your channel partners. Verify each against what the booking owes, then approve it for payment.",
        action: "Open payouts",
        href: "/dashboard/partners?view=payouts",
        tag: null,
        resolvers: ["payout:approve"],
      });
    }
    if (row?.quotes) {
      out.push({
        id: "quotes-to-approve",
        severity: "info",
        title: `${row.quotes} ${row.quotes === 1 ? "quote is" : "quotes are"} waiting for approval`,
        why: "A buyer is waiting on the price. Approve it from the lead's page, then send the token link.",
        action: "Open leads",
        href: "/dashboard/leads",
        tag: null,
        resolvers: ["quote:approve"],
      });
    }
    return out;
  } catch (e) {
    console.error("queue: approvals could not be read", e);
    return [];
  }
}

/**
 * A firm that sells for others (it alone has a profile) prints its MahaRERA agent number on every ad
 * it makes, and is refused one without a current number. Said before the
 * first refusal, not after.
 */
async function agentQueue(orgId: string): Promise<QueueItem[]> {
  try {
    const [p] = await withTenant(orgId, (sql) => sql<{ no: string | null; till: Date | string | null }[]>`
      SELECT rera_agent_no AS no, rera_valid_till AS till FROM firm_profiles WHERE org_id = ${orgId}`);
    const till = p?.till ? (typeof p.till === "string" ? p.till.slice(0, 10) : p.till.toISOString().slice(0, 10)) : null;
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const left = till ? Math.round((Date.parse(`${till}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
    const item = (severity: Severity, title: string, why: string): QueueItem[] => [
      { id: "agent-rera", severity, title, why, action: "Open Your firm", href: "/dashboard/settings/firm", tag: null, resolvers: ["org:manage"] },
    ];
    // Only a firm that sells for others has a profile: a developer has none.
    if (!p) return [];
    if (!p.no) return item("risk", "Your MahaRERA agent number is not on file", "Every ad you make prints it, so no ad can be made until it is added.");
    if (!till) return item("risk", "Your agent registration has no end date", "Add the date it runs until. No ad can be made without it.");
    if (left !== null && left < 0) return item("risk", `Your agent registration ran out on ${longDay(till)}`, "Add the renewed one. No ad can be made until then.");
    if (left !== null && left <= 30) return item("warn", `Your agent registration runs out on ${longDay(till)}`, "Add the renewed one before then, or your ads stop.");
    return [];
  } catch (e) {
    console.error("queue: the agent registration could not be read", e);
    return [];
  }
}

/** A mandate firm's commission: invoices to send and invoices sent back. */
async function commissionQueue(orgId: string): Promise<MandateAlert[]> {
  // Only a mandate firm is owed commission through `mandate_payouts_for_firm()`; anybody else reads nothing.
  try {
    return commissionAlerts(await firmCommission(orgId));
  } catch (e) {
    console.error("queue: the firm's commission could not be read", e);
    return [];
  }
}

export type ProjectCard = {
  id: string;
  name: string;
  path: string;
  /** Until RegistrationRecord exists, every project is unverified by definition. */
  reraState: "VERIFIED" | "EXEMPT" | "BLOCKED" | "UNVERIFIED";
};

/**
 * A project or a tower, for the jump control in the top bar.
 *
 * It replaced a search box that could not search. Lead lookup arrives with
 * the capture flow and a box that answers nothing until then is a control
 * that does nothing. Places are what the console already holds, so that is
 * what the box finds.
 */
export type PlaceCard = {
  id: string;
  name: string;
  kind: "PROJECT" | "PHASE";
  /** The project a tower sits under, so two "Phase 1"s are told apart. */
  under: string | null;
  href: string;
};

export type ConsoleState = {
  org: {
    id: string;
    displayName: string;
    legalName: string;
    gstin: string | null;
    pan: string;
    cellId: string;
    /** Null where the founder signed up on a public provider. */
    primaryDomain: string | null;
  };
  rootPath: string;
  entityCount: number;
  projects: ProjectCard[];
  adminCount: number;
  memberCount: number;
  /** Every project and tower, for the top bar's jump control. */
  places: PlaceCard[];
  /** The six gates, per phase. Empty until a phase exists. */
  readiness: PhaseReadiness[];
  queue: QueueItem[];
  /** True when the tenant has no entities and no projects: the day-one state. */
  isFreshTenant: boolean;
};

/**
 * Why a lead needs a person, fit for a screen every member opens.
 *
 * The engine sometimes quotes the buyer ("Replied on WhatsApp: ..."). Their
 * words stay on the lead's own page, behind `lead:read`, so the quote is cut
 * here and the reason keeps its first half.
 */
export function plainReason(raw: string | null): string {
  const text = (raw ?? "").trim();
  // `Visit agreed on the call ("..."). Fix the time` keeps both halves;
  // anything else is cut at the first quote.
  const aside = text.match(/^([\s\S]*?)\s*\(\s*"[\s\S]*"\s*\)([\s\S]*)$/);
  const cut = (aside ? `${aside[1]}${aside[2]}` : text.split('"')[0])
    .replace(/[\s:(]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cut) return "Open the board to see why.";
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

export async function loadConsoleState(orgId: string): Promise<ConsoleState | null> {
  // Every page pays for this before it draws, and none of these reads needs
  // another's answer, so they go out together: pipelined on one transaction,
  // the readiness pass beside it. Beside and not inside: a
  // transaction that waits on a second connection can starve the pool.
  const [base, allReadiness, billing, mandates, sso, firmItems, partnerItems, reportItems, pickup, handoff, departed, retired, shared, portalItems, callerItems, approvals, agent, commission, outsideItems, loanItems] = await Promise.all([
    withTenant(orgId, (sql) =>
      Promise.all([
          sql<
            {
              id: string;
              display_name: string;
              legal_name: string;
              gstin: string | null;
              pan: string;
              cell_id: string;
              primary_domain: string | null;
              type: string;
            }[]
          >`
            SELECT id, display_name, legal_name, gstin, pan, cell_id, primary_domain, type
            FROM orgs WHERE id = ${orgId}
          `,
          sql<{ id: string; kind: string; name: string; path: string }[]>`
            SELECT id, kind, name, path::text AS path
            FROM scope_nodes WHERE org_id = ${orgId}
            ORDER BY path
          `,
          sql<{ admins: number; members: number }[]>`
            SELECT
              count(*) FILTER (WHERE role = 'ORG_ADMIN')::int AS admins,
              count(*)::int                                   AS members
            FROM memberships
            WHERE org_id = ${orgId} AND status = 'ACTIVE'
          `,
          // A project's state is the worst of its phases: one unregistered tower
          // is enough to make the project unsafe to advertise as a whole.
          sql<{ project_id: string; blocked: number; total: number }[]>`
            SELECT p.id AS project_id,
                   count(*) FILTER (WHERE coalesce(r.status, 'BLOCKED') = 'BLOCKED')::int AS blocked,
                   count(*)::int AS total
            FROM scope_nodes ph
            JOIN scope_nodes p ON p.id = ph.parent_id AND p.kind = 'PROJECT'
            LEFT JOIN registration_records r ON r.scope_node_id = ph.id
            WHERE ph.org_id = ${orgId} AND ph.kind = 'PHASE'
            GROUP BY p.id
          `,
          // What went out, or should have: a connection that stopped working,
          // a post that failed, one still up on a phase that is blocked, an
          // ad that would not pause, and an approved post that could not go.
          sql<
            {
              provider: string;
              status: string;
              token_expires_at: Date | null;
            }[]
          >`
            SELECT provider, status, token_expires_at FROM connections
            WHERE org_id = ${orgId} AND status <> 'DISCONNECTED'
          `,
          sql<{ failed: number; takedown: number; stuck: number; held: number }[]>`
            SELECT
              (SELECT count(*) FROM publish_targets
                WHERE org_id = ${orgId} AND state = 'FAILED')::int AS failed,
              (SELECT count(*) FROM publish_targets
                WHERE org_id = ${orgId} AND state = 'LIVE' AND blocked_at IS NOT NULL)::int AS takedown,
              (SELECT count(*) FROM publish_targets
                WHERE org_id = ${orgId} AND state = 'ACTIVE' AND error_code IS NOT NULL)::int AS stuck,
              (SELECT count(*) FROM post_creatives
                WHERE org_id = ${orgId} AND state = 'APPROVED' AND publish_note IS NOT NULL)::int AS held
          `,
          // Buyers: leads the agent handed to a person, visits missed today
          // (by the IST calendar, not the server's), and whether there is
          // anybody for the caller and WhatsApp to reach at all. The lead
          // waiting longest is the one named.
          sql<{
            needs: number;
            first_need: string | null;
            any_lead: boolean;
            no_shows: number;
            wa_on: boolean;
            wa_broken: boolean;
            wa_red: boolean;
            wa_refused: number;
            wa_paced: string | null;
          }[]>`
            SELECT
              (SELECT count(*) FROM leads
                WHERE org_id = ${orgId} AND needs_person IS NOT NULL)::int AS needs,
              (SELECT needs_person FROM leads
                WHERE org_id = ${orgId} AND needs_person IS NOT NULL
                ORDER BY last_activity_at LIMIT 1) AS first_need,
              EXISTS (SELECT 1 FROM leads WHERE org_id = ${orgId}) AS any_lead,
              (SELECT count(*) FROM site_visits
                WHERE org_id = ${orgId} AND status = 'NO_SHOW'
                  AND (scheduled_at AT TIME ZONE 'Asia/Kolkata')::date
                    = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS no_shows,
              -- The developer's own WhatsApp: a number writing somewhere, an
              -- account that stopped working, a number buyers are reporting,
              -- and messages Meta would not approve.
              EXISTS (SELECT 1 FROM whatsapp_numbers wn JOIN whatsapp_accounts wa ON wa.id = wn.account_id
                WHERE wn.org_id = ${orgId} AND wn.active AND wa.status = 'CONNECTED') AS wa_on,
              EXISTS (SELECT 1 FROM whatsapp_accounts
                WHERE org_id = ${orgId} AND status = 'BROKEN') AS wa_broken,
              EXISTS (SELECT 1 FROM whatsapp_numbers
                WHERE org_id = ${orgId} AND active AND quality = 'RED') AS wa_red,
              (SELECT count(*) FROM whatsapp_templates wt JOIN whatsapp_accounts wa ON wa.id = wt.account_id
                WHERE wt.org_id = ${orgId} AND wa.status = 'CONNECTED'
                  AND wt.status IN ('REJECTED', 'PAUSED', 'DISABLED', 'FAILED'))::int AS wa_refused,
              -- A number that reached its daily limit today, with messages still waiting on it.
              (SELECT display_phone FROM whatsapp_numbers
                WHERE org_id = ${orgId} AND retired_at IS NULL AND paced_until > now()
                  AND (paced_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
                ORDER BY paced_at DESC LIMIT 1) AS wa_paced
          `,
          // Projects with a buyer on the way and no location saved at the
          // tower or anywhere above it, so their reminders carry no pin.
          sql<{ project_id: string; project_name: string; visits: number }[]>`
            SELECT p.id AS project_id, p.name AS project_name, count(*)::int AS visits
            FROM site_visits v
            JOIN scope_nodes n ON n.id = v.scope_node_id
            JOIN scope_nodes p ON p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.path @> n.path
            WHERE v.org_id = ${orgId} AND v.status = 'CONFIRMED' AND v.scheduled_at >= now()
              AND NOT EXISTS (
                SELECT 1 FROM site_locations s
                JOIN scope_nodes sn ON sn.id = s.scope_node_id
                WHERE s.org_id = ${orgId} AND sn.path @> n.path
              )
            GROUP BY p.id, p.name
            ORDER BY min(v.scheduled_at)
          `,
          // The CRM: stopped working, leads it refused for good, and words of
          // theirs nobody matched while something waits on them.
          sql<{ provider: string; status: string; dead: number; waiting: number }[]>`
            SELECT c.provider, c.status,
                   (SELECT count(*) FROM crm_outbox o WHERE o.org_id = ${orgId} AND o.connection_id = c.id AND o.status = 'DEAD')::int AS dead,
                   ((SELECT count(*) FROM crm_outbox o WHERE o.org_id = ${orgId} AND o.connection_id = c.id AND o.status = 'WAITING')
                    + (SELECT count(*) FROM crm_events e WHERE e.org_id = ${orgId} AND e.connection_id = c.id AND e.outcome = 'WAITING'))::int AS waiting
            FROM crm_connections c WHERE c.org_id = ${orgId} AND c.status <> 'DISCONNECTED'
          `,
      ]),
    ),
    loadReadiness(orgId),
    billingQueue(orgId),
    mandateQueue(orgId),
    ssoQueue(orgId),
    firmQueue(orgId),
    partnerQueueFor(orgId),
    reportAlertsFor(orgId),
    pickupAlertsFor(orgId),
    handoffAlertFor(orgId),
    departureQueue(orgId),
    retiredProjects(orgId),
    sharedQueue(orgId),
    portalQueue(orgId),
    waitingCallerQueue(orgId),
    approvalsQueue(orgId),
    agentQueue(orgId),
    commissionQueue(orgId),
    outsideQueue(orgId),
    loanQueue(orgId),
  ]);
  // A retired project stays readable on its own page and drops out of the
  // gates, Today and the pickers.
  const readiness = allReadiness.filter((r) => !retired.has(r.projectId));
  const [[org], nodes, [counts], phaseState, connections, [published], [people], unlocated, crm] = base;
  if (!org) return null;

  const root = nodes.find((n) => n.kind === "ORG");
  const entityCount = nodes.filter((n) => n.kind === "ENTITY").length;
  const byProject = new Map(phaseState.map((r) => [r.project_id, r]));

  const allProjects = nodes.filter((n) => n.kind === "PROJECT");
  const live = (path: string) => !allProjects.some((p) => retired.has(p.id) && (path === p.path || path.startsWith(p.path + ".")));
  const projects: ProjectCard[] = allProjects
    .filter((n) => !retired.has(n.id))
    .map((n) => {
      const s = byProject.get(n.id);
      const reraState = !s || s.total === 0
        ? ("UNVERIFIED" as const)
        : s.blocked > 0
          ? ("BLOCKED" as const)
          : ("VERIFIED" as const);
      return { id: n.id, name: n.name, path: n.path, reraState };
    });

  // Projects and towers, for the jump control. A tower carries the project
  // it sits under because two projects each having a "Phase 1" is the
  // ordinary case, and a list of six identical rows is a list nobody can
  // pick from. Matched on the ltree prefix rather than on parent_id, since
  // a phase sits directly under its project and the path already says so.
  const places: PlaceCard[] = nodes
    .filter((n) => (n.kind === "PROJECT" || n.kind === "PHASE") && live(n.path))
    .map((n) => {
      const parent =
        n.kind === "PHASE"
          ? nodes.find((p) => p.kind === "PROJECT" && n.path.startsWith(p.path + "."))
          : undefined;
      return {
        id: n.id,
        name: n.name,
        kind: n.kind as "PROJECT" | "PHASE",
        under: parent?.name ?? null,
        // A tower has no page of its own: its registration, its Brain, its
        // library and its briefs are four sections. The project page is
        // where those six gates are gathered, so that is where it lands.
        href: parent
          ? `/dashboard/projects/${parent.id}#phase-${n.id}`
          : `/dashboard/projects/${n.id}`,
      };
    });

  const adminCount = counts?.admins ?? 0;
  const memberCount = counts?.members ?? 0;

  const queue: QueueItem[] = [];

  if (adminCount < 2) {
    queue.push({
      id: "second-admin",
      severity: "risk",
      title: "Only one admin on this organisation",
      why: "If this account is lost, nobody can manage the organisation. Add a second admin.",
      action: "Invite an admin",
      href: "/dashboard/team",
      tag: { text: "Blocks go-live", tone: "risk" },
      resolvers: ["member:invite"],
    });
  }

  // A mandate firm that sells only through mandates has its developers'
  // projects there, not here: "add your first developer" would send it to
  // file what it already works.
  const throughMandates = firmItems.working;
  if (entityCount === 0 && !throughMandates) {
    queue.push({
      id: "no-entity",
      severity: "warn",
      // A mandate firm files the developers it sells for here.
      title: sellsForOthers(org.type) ? "No developer yet" : "No legal entity yet",
      why:
        sellsForOthers(org.type)
          ? "Add the developer company a project you sell is registered under, named exactly as on the RERA registration."
          : "Add the company your projects are registered under, named exactly as on the RERA registration.",
      action: sellsForOthers(org.type) ? "Add a developer" : "Add an entity",
      href: "/dashboard/settings/entities",
      tag: null,
      resolvers: ["project:create"],
    });
  }

  if (allProjects.length === 0 && !throughMandates) {
    queue.push({
      id: "no-project",
      severity: "warn",
      title: "No project yet",
      why: "Leads, site visits and campaigns all belong to a project. Add one to start.",
      action: "Create a project",
      href: "/dashboard/projects",
      tag: null,
      resolvers: ["project:create"],
    });
  }

  // Anything that cannot be advertised right now, and anything about to
  // stop being advertisable. The second is the whole point of a daily
  // sweep: a registration does not fail loudly, it just stops being valid
  // one morning while a campaign is running.
  //
  // The remaining gates are NOT queue items. They were, for an afternoon,
  // and Today then carried the same tower twice: once as a row saying it
  // needed branding and once as a strip of six gates saying the same thing
  // with more in it. A queue is what is wrong; the gates are the work in
  // hand, and they have their own card.
  //
  // One read answers both, where it used to be a second `complianceSummary`
  // call beside the one the readiness pass already makes.
  const blocked = readiness.filter((p) => p.blocked);
  const lapsingSoon = readiness.filter(
    (p) => !p.blocked && p.daysLeft !== null && p.daysLeft <= LAPSE_WARNING_DAYS,
  );

  for (const p of blocked) {
    queue.push({
      id: `rera-blocked-${p.phaseId}`,
      severity: "risk",
      title: `${p.projectName} ${p.phaseName} cannot be advertised`,
      why: p.why,
      action: "Open the project",
      href: `/dashboard/projects/${p.projectId}`,
      tag: { text: "Blocks publishing", tone: "risk" },
      resolvers: ["rera:manage"],
    });
  }

  for (const p of lapsingSoon) {
    queue.push({
      id: `rera-lapsing-${p.phaseId}`,
      severity: "warn",
      title: `${p.projectName} ${p.phaseName} lapses in ${p.daysLeft} days`,
      why: "Renew it or re-attest the exemption. Campaigns on it stop when it lapses.",
      action: "Open the project",
      href: `/dashboard/projects/${p.projectId}`,
      tag: { text: `${p.daysLeft} days`, tone: "warn" },
      resolvers: ["rera:manage"],
    });
  }

  // Buyers. The caller and WhatsApp only matter once there is somebody to
  // reach, so a tenant still setting up is not told about either.
  if (people?.any_lead && !sarvamConfig().ok) {
    queue.push({
      id: "caller-off",
      severity: "risk",
      title: "New leads are not being called",
      why: "The AI caller is not switched on, so every new lead waits until somebody on the team rings them.",
      action: "Open calling settings",
      href: "/dashboard/settings/calling",
      tag: { text: "Not calling", tone: "risk" },
      resolvers: ["org:manage"],
    });
  }
  if (people?.wa_broken) {
    queue.push({
      id: "whatsapp-broken",
      severity: "risk",
      title: "WhatsApp stopped working",
      why: "Meta stopped accepting our access to your WhatsApp number, so nothing is going out from it.",
      action: "Connect WhatsApp again",
      href: "/dashboard/settings/connections/whatsapp",
      tag: { text: "Not messaging", tone: "risk" },
      resolvers: ["integration:manage"],
    });
  } else if (people?.any_lead && !people.wa_on) {
    queue.push({
      id: "whatsapp-off",
      severity: "risk",
      title: "Buyers are not getting WhatsApp messages",
      why: "No WhatsApp number is connected, so directions, visit reminders and follow-ups are not going out.",
      action: "Connect WhatsApp",
      href: "/dashboard/settings/connections/whatsapp",
      tag: { text: "Not messaging", tone: "risk" },
      resolvers: ["integration:manage"],
    });
  }
  if (people?.wa_red) {
    queue.push({
      id: "whatsapp-quality",
      severity: "warn",
      title: "Buyers are blocking or reporting your WhatsApp messages",
      why: "Meta rates your number's quality low and may limit it. Fewer promotional messages usually brings it back.",
      action: "Open WhatsApp",
      href: "/dashboard/settings/connections/whatsapp",
      tag: { text: "Quality low", tone: "warn" },
      resolvers: ["integration:manage"],
    });
  }
  if (people?.wa_refused) {
    const n = people.wa_refused;
    queue.push({
      id: "whatsapp-templates",
      severity: "warn",
      title: `Meta did not approve ${n} WhatsApp ${n === 1 ? "message" : "messages"}`,
      why: "Buyers do not get those messages until Meta approves them. The reason is beside each.",
      action: "Open WhatsApp",
      href: "/dashboard/settings/connections/whatsapp",
      tag: { text: "Not approved", tone: "warn" },
      resolvers: ["integration:manage"],
    });
  }
  if (people?.wa_paced) {
    queue.push({
      id: "whatsapp-limit",
      severity: "warn",
      title: "WhatsApp messages are waiting",
      why: `${showPhone(people.wa_paced)} reached its daily limit. Verify your business in Meta to raise it.`,
      action: "Open WhatsApp",
      href: "/dashboard/settings/connections/whatsapp",
      tag: { text: "Daily limit", tone: "warn" },
      resolvers: ["integration:manage"],
    });
  }
  if (people?.needs) {
    const n = people.needs;
    const rest = n - 1;
    // A buyer's own words can carry a number; a queue line is a summary.
    const reason = plainReason(redactPhones(people.first_need, "MASKED"));
    queue.push({
      id: "leads-need-you",
      severity: "warn",
      title: n === 1 ? "A lead needs you" : `${n} leads need you`,
      why: rest === 0 ? reason : `${reason} ${rest} more ${rest === 1 ? "lead is" : "leads are"} waiting too.`,
      action: n === 1 ? "See the lead" : "See the leads",
      href: "/dashboard/leads?needs=1",
      tag: null,
      resolvers: ["lead:update"],
    });
  }
  if (people?.no_shows) {
    const n = people.no_shows;
    queue.push({
      id: "no-shows-today",
      severity: "warn",
      title: n === 1 ? "A buyer did not turn up today" : `${n} buyers did not turn up today`,
      why:
        n === 1
          ? "If they came and nobody checked them in, check them in now. If not, a call from you can rebook them."
          : "If any came and nobody checked them in, check them in now. For the rest, a call from you can rebook them.",
      action: "Open site visits",
      href: "/dashboard/visits",
      tag: null,
      resolvers: ["visit:outcome"],
    });
  }
  for (const p of unlocated) {
    queue.push({
      id: `no-location-${p.project_id}`,
      severity: "warn",
      title: `Buyers will get no directions to ${p.project_name}`,
      why:
        p.visits === 1
          ? "A visit is booked there and no site location is saved, so the buyer's reminders carry no map pin."
          : `${p.visits} visits are booked there and no site location is saved, so the buyers' reminders carry no map pin.`,
      action: "Add the location",
      href: `/dashboard/projects/${p.project_id}`,
      tag: null,
      resolvers: ["project:create"],
    });
  }

  // A project with no phase has nothing registrable under it, so nothing
  // downstream can start. This is the same shape of finding as the others:
  // derived from state, and it disappears when the state changes.
  const phaseless = projects.filter((p) => !byProject.get(p.id));
  if (phaseless.length > 0) {
    queue.push({
      id: "no-phase",
      severity: "warn",
      title: `${phaseless[0].name} has no phase yet`,
      why: "Add a phase. Each phase is registered on its own.",
      action: "Add a phase",
      href: `/dashboard/projects/${phaseless[0].id}`,
      tag: null,
      resolvers: ["project:create"],
    });
  }

  // Connections, and what went out through them.
  const now = Date.now();
  for (const c of connections) {
    const label = c.provider === "META" ? "Meta" : "Google";
    const slug = c.provider.toLowerCase();
    const expired = c.token_expires_at && c.token_expires_at.getTime() <= now;
    const soon = c.token_expires_at && c.token_expires_at.getTime() - now <= 7 * 86_400_000;
    if (c.status === "BROKEN" || expired) {
      queue.push({
        id: `connection-broken-${slug}`,
        severity: "risk",
        title: `${label} stopped working`,
        why: `Posts and ads going to ${label} fail until somebody reconnects it.`,
        action: `Reconnect ${label}`,
        href: `/dashboard/settings/connections/${slug}`,
        tag: { text: "Stops publishing", tone: "risk" },
        resolvers: ["integration:manage"],
      });
    } else if (c.status === "PENDING") {
      queue.push({
        id: `connection-choose-${slug}`,
        severity: "warn",
        title: `Choose where ${label} posts go`,
        why: `${label} is connected, and nothing goes to it until its Pages and accounts are chosen.`,
        action: "Choose accounts",
        href: `/dashboard/settings/connections/${slug}`,
        tag: null,
        resolvers: ["integration:manage"],
      });
    } else if (soon && c.token_expires_at) {
      const days = Math.max(1, Math.ceil((c.token_expires_at.getTime() - now) / 86_400_000));
      queue.push({
        id: `connection-expiring-${slug}`,
        severity: "warn",
        title: `${label} needs reconnecting in ${days} ${days === 1 ? "day" : "days"}`,
        why: `After that, posts and ads going to ${label} stop until somebody reconnects.`,
        action: `Reconnect ${label}`,
        href: `/dashboard/settings/connections/${slug}`,
        tag: { text: `${days} ${days === 1 ? "day" : "days"}`, tone: "warn" },
        resolvers: ["integration:manage"],
      });
    }
  }
  for (const c of crm) {
    const label = c.provider === "LEADSQUARED" ? "LeadSquared" : c.provider === "SELLDO" ? "Sell.Do" : "LeadRat";
    if (c.status === "BROKEN") {
      queue.push({
        id: "crm-broken",
        severity: "risk",
        title: `${label} stopped working`,
        why: `New leads and moves are not reaching ${label}, and changes made there are not coming back.`,
        action: "Enter the keys again",
        href: "/dashboard/settings/connections/crm",
        tag: { text: "Sync stopped", tone: "risk" },
        resolvers: ["integration:manage"],
      });
    } else if (c.dead) {
      queue.push({
        id: "crm-refused",
        severity: "warn",
        title: `${label} refused ${c.dead} ${c.dead === 1 ? "lead" : "leads"}`,
        why: "They are not in your CRM. Fix what it names, then try again.",
        action: "Open CRM sync",
        href: "/dashboard/settings/connections/crm",
        tag: null,
        resolvers: ["integration:manage"],
      });
    }
    if (c.status !== "BROKEN" && c.waiting) {
      queue.push({
        id: "crm-waiting",
        severity: "warn",
        title: `${c.waiting} ${c.waiting === 1 ? "lead waits" : "leads wait"} on a ${label} match`,
        why: `A status, project or person in ${label} is not matched yet.`,
        action: "Match them",
        href: "/dashboard/settings/connections/crm?edit=1",
        tag: null,
        resolvers: ["integration:manage"],
      });
    }
  }
  if (published?.stuck) {
    queue.push({
      id: "ad-still-spending",
      severity: "risk",
      title: `${published.stuck} ${published.stuck === 1 ? "ad is" : "ads are"} still spending on a project that cannot be advertised`,
      why: "It could not be paused automatically. Pause it now.",
      action: "Open Published",
      href: "/dashboard/campaigns/live?view=needs",
      tag: { text: "Spending", tone: "risk" },
      resolvers: ["creative:approve", "campaign:publish", "campaign.budget:manage"],
    });
  }
  if (published?.takedown) {
    queue.push({
      id: "posts-to-take-down",
      severity: "risk",
      title: `${published.takedown} ${published.takedown === 1 ? "post is" : "posts are"} still up for a project that cannot be advertised`,
      why:
        published.takedown === 1
          ? "Take it down on the platform, then mark it down here."
          : "Take them down on the platform, then mark them down here.",
      action: "Open Published",
      href: "/dashboard/campaigns/live?view=needs",
      tag: null,
      resolvers: ["creative:approve", "campaign:publish", "campaign.budget:manage"],
    });
  }
  if (published && published.failed + published.held > 0) {
    const n = published.failed + published.held;
    queue.push({
      id: "posts-not-out",
      severity: "warn",
      title: `${n} ${n === 1 ? "post" : "posts"} did not go out`,
      why: "Each says why. Most need an account connected or reconnected.",
      action: "Open Published",
      href: "/dashboard/campaigns/live?view=needs",
      tag: null,
      resolvers: ["campaign:publish"],
    });
  }

  // The plan's allowance at 80% and at zero, once a plan has been sold.
  for (const a of billing) {
    const auto = a.id.startsWith("auto-");
    queue.push({
      id: a.id,
      severity: a.severity,
      title: a.title,
      why: a.why,
      action: auto ? "Open auto top-up" : "Open plan and usage",
      href: auto ? "/dashboard/settings/billing/auto" : "/dashboard/settings/billing",
      tag: { text: a.tag, tone: a.severity === "risk" ? "risk" : "warn" },
      resolvers: ["billing:manage"],
    });
  }

  // Mandate firms: one that said no, one about to end, an offer left unanswered.
  // A firm that added one of this developer's projects before the developer joined.
  for (const a of shared) {
    queue.push({
      id: `shared-${a.projectId}-${a.holder.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      severity: "info",
      title: sharedTitle(a),
      why: `${a.holder} also has this project in its own console. Offer them a mandate or empanel them to work on it together.`,
      action: "Open partners",
      href: "/dashboard/partners",
      tag: null,
      resolvers: ["mandate:manage", "partner:empanel"],
    });
  }

  for (const a of mandates) {
    queue.push({
      id: a.id,
      severity: a.severity,
      title: a.title,
      why: a.why,
      action: "Open mandate firms",
      href: "/dashboard/partners?view=mandates",
      tag: { text: a.tag, tone: a.severity === "risk" ? "risk" : a.severity === "warn" ? "warn" : "quiet" },
      resolvers: ["mandate:manage"],
    });
  }

  // A mandate firm: an offer to answer, a mandate about to end or changed,
  // commission to invoice and an invoice sent back.
  for (const a of [...firmItems.alerts, ...commission]) {
    queue.push({
      id: a.id,
      severity: a.severity,
      title: a.title,
      why: a.why,
      action: a.id.startsWith("firm-offer") ? "Answer it" : a.resolvers?.includes("partner:register") ? "See commission" : "Open Developers",
      href: "/dashboard/developers",
      tag: { text: a.tag, tone: a.severity === "risk" ? "risk" : a.severity === "warn" ? "warn" : "quiet" },
      resolvers: a.resolvers ?? [],
    });
  }
  queue.push(...agent, ...approvals, ...loanItems);

  // A channel partner: a buyer about to lapse, an empanelment ending, an invoice to send.
  for (const a of partnerItems) {
    queue.push({
      id: a.id,
      severity: a.severity,
      title: a.title,
      why: a.why,
      action: a.action,
      href: a.href,
      tag: null,
      resolvers: a.resolvers,
    });
  }

  // Leads somebody who left the team was working, that nobody else could take.
  queue.push(...departed);

  // The reports: campaigns whose qualified leads rarely book, and ads worth pausing.
  // Portal enquiries waiting for a person to say which project they are about.
  queue.push(...portalItems);
  // Callers to a number over several projects whom nobody could file.
  queue.push(...callerItems);
  // A channel partner's registrations and brokerage with developers not on Sales Desk.
  queue.push(...outsideItems);

  for (const a of reportItems) {
    queue.push({
      id: a.id,
      severity: a.severity,
      title: a.title,
      why: a.why,
      action: a.action,
      href: a.href,
      tag: { text: a.tag, tone: "warn" },
      resolvers: a.resolvers,
    });
  }

  // A calling number buyers stopped picking up: most often shown as spam.
  for (const a of pickup) {
    queue.push({
      id: a.id,
      severity: "warn",
      title: a.title,
      why: a.why,
      action: "Open calling numbers",
      href: "/dashboard/settings/calling-numbers",
      tag: { text: "Pickups down", tone: "warn" },
      resolvers: ["integration:manage"],
    });
  }

  // The AI is calling and nobody can take a buyer it hands over.
  if (handoff) {
    queue.push({
      id: handoff.id,
      severity: "warn",
      title: handoff.title,
      why: handoff.why,
      action: "Add your sales team",
      href: "/dashboard/settings/calling#team-title",
      tag: { text: "No sales team", tone: "warn" },
      resolvers: ["org:manage"],
    });
  }

  // Single sign-on: a certificate close to its end, groups nobody mapped.
  for (const a of sso) {
    queue.push({
      id: a.id,
      severity: a.severity,
      title: a.title,
      why: a.why,
      action: "Open single sign-on",
      href: "/dashboard/settings/sso",
      tag: { text: a.tag, tone: a.severity === "risk" ? "risk" : a.severity === "warn" ? "warn" : "quiet" },
      resolvers: ["org:manage"],
    });
  }

  if (memberCount === 1) {
    queue.push({
      id: "no-team",
      severity: "info",
      title: "You are the only person here",
      why: "Invite your sales, marketing and finance heads now. Site and pre-sales roles can be given once their project or tower exists.",
      action: "Invite your team",
      href: "/dashboard/team",
      tag: null,
      resolvers: ["member:invite"],
    });
  }

  return {
    org: {
      id: org.id,
      displayName: org.display_name,
      legalName: org.legal_name,
      gstin: org.gstin,
      pan: org.pan,
      cellId: org.cell_id,
      primaryDomain: org.primary_domain,
    },
    rootPath: root?.path ?? "",
    entityCount,
    projects,
    adminCount,
    memberCount,
    places,
    readiness,
    queue,
    isFreshTenant: entityCount === 0 && projects.length === 0 && !throughMandates,
  };
}
