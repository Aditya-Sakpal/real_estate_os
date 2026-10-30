import { controlDb } from "@/lib/db";
import { auditWords } from "@/lib/audit-rules";
import { COST_PAISE, PARTNER_PLATFORM_PAISE, PLAN_FLOOR, PLATFORM_PAISE, WORST_FLOOR, proratedPrice } from "@/lib/billing-rules";

/**
 * What the operator console reads. This is the one place outside sign-in and
 * org creation that reads across every tenant, on purpose: Sales Desk's own
 * people looking at all their clients at once. Four rules keep it narrow.
 *
 *   - Only `requireOperator()` pages call it (admin.salesdesk.app, an
 *     allow-listed address, a signed session).
 *   - Every read runs in a READ ONLY transaction with a statement timeout, so
 *     a bug here cannot write to anybody's data. The one write, the
 *     operator's own note on a client, is `saveOperatorNote()`, into a table
 *     no tenant can reach.
 *   - It returns counts, money, and the names of companies and their staff.
 *     Never a buyer's name, number, email, a transcript or a message body.
 *   - A company marked as a test is left out of every total unless asked.
 */

type Tx = Parameters<Parameters<typeof controlDb.begin>[1]>[0];

async function readOnly<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return controlDb.begin("read only", async (tx) => {
    await tx`SET LOCAL statement_timeout = '25s'`;
    return fn(tx);
  }) as Promise<T>;
}

const n = (v: unknown) => Number(v ?? 0);
const MONTH = `date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')`;
const MONTH_DATE = `(${MONTH})::date`;
const MONTH_SINCE = `((${MONTH}) AT TIME ZONE 'Asia/Kolkata')`;
const DAY_SINCE = `((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata')`;

export function istMonth(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Kolkata" }).format(d);
}

/** Companies the operators marked as tests. */
async function testIds(tx: Tx): Promise<string[]> {
  return (await tx`SELECT org_id FROM operator_notes WHERE is_test`).map((r) => r.org_id as string);
}

/* ================================================================ catalog */

/** What each metered kind is, and whose bill it lands on. */
export const KINDS: Record<string, { label: string; vendor: string; unit: string }> = {
  CALL_MINUTE: { label: "AI call minutes", vendor: "Sarvam + Vobiz", unit: "min" },
  HANDOFF_MINUTE: { label: "Calls put through to people", vendor: "Vobiz", unit: "min" },
  IMAGE_POST: { label: "Image posts", vendor: "OpenAI", unit: "posts" },
  CAROUSEL: { label: "Carousels", vendor: "OpenAI", unit: "carousels" },
  EXTRA_SLIDE: { label: "Extra slides", vendor: "OpenAI", unit: "slides" },
  VIDEO: { label: "Videos from frames", vendor: "OpenRouter", unit: "videos" },
  FILM: { label: "Films", vendor: "OpenRouter + ElevenLabs", unit: "films" },
  FILM_VERSION: { label: "Film new versions", vendor: "OpenRouter", unit: "versions" },
  STORY_REEL: { label: "Story reels", vendor: "OpenRouter + ElevenLabs", unit: "reels" },
  QUESTION: { label: "Ask Jimmy questions", vendor: "OpenAI", unit: "questions" },
  WHATSAPP: { label: "WhatsApp messages", vendor: "Meta", unit: "paise" },
  SMS: { label: "Service SMS", vendor: "AWS", unit: "paise" },
  PHONE_NUMBER: { label: "Calling numbers", vendor: "Vobiz", unit: "months" },
};

/** Which vendor a kind's cost lands on, for the vendor split. */
export const VENDOR_OF: Record<string, string> = {
  CALL_MINUTE: "Sarvam",
  HANDOFF_MINUTE: "Vobiz",
  PHONE_NUMBER: "Vobiz",
  IMAGE_POST: "OpenAI",
  CAROUSEL: "OpenAI",
  EXTRA_SLIDE: "OpenAI",
  QUESTION: "OpenAI",
  VIDEO: "OpenRouter",
  FILM: "OpenRouter",
  FILM_VERSION: "OpenRouter",
  STORY_REEL: "OpenRouter",
  WHATSAPP: "Meta",
  SMS: "AWS",
};

/* ================================================================ clients */

export type ClientRow = {
  id: string;
  name: string;
  legalName: string | null;
  type: string;
  status: string;
  createdAt: Date;
  billingMode: string | null;
  plans: { plan: string; scope: string; pricePaise: number }[];
  planValuePaise: number;
  paidPaise: number;
  projects: number;
  towers: number;
  members: number;
  lastLogin: Date | null;
  lastActivity: Date | null;
  leadsMonth: number;
  leadsAll: number;
  bookedAll: number;
  callsMonth: number;
  connectedMonth: number;
  callMinutesMonth: number;
  visitsMonth: number;
  postsMonth: number;
  videosMonth: number;
  questionsMonth: number;
  costMonthPaise: number;
  costLastMonthPaise: number;
  costAllPaise: number;
  isTest: boolean;
  note: string | null;
};

async function clientRows(tx: Tx, only?: string): Promise<ClientRow[]> {
  const rows = await tx.unsafe(
    `
    WITH m AS (SELECT ${MONTH_DATE} AS p, ${MONTH_SINCE} AS since)
    SELECT o.id, o.display_name, o.legal_name, o.type, o.status, o.created_at,
      b.mode AS billing_mode, coalesce(op.is_test, false) AS is_test, op.note,
      coalesce((SELECT jsonb_agg(jsonb_build_object('plan', s.plan, 'scope', s.scope,
                  'pricePaise', coalesce((s.terms->>'pricePaise')::bigint, 0)))
                FROM subscriptions s
                WHERE s.org_id = o.id AND s.status = 'ACTIVE' AND s.starts_on <= current_date
                  AND (s.ends_on IS NULL OR s.ends_on > current_date)), '[]'::jsonb) AS plans,
      (SELECT coalesce(sum(total_paise), 0) FROM payments p WHERE p.org_id = o.id AND p.status = 'PAID' AND NOT p.test) AS paid,
      (SELECT count(*) FROM scope_nodes s WHERE s.org_id = o.id AND s.kind = 'PROJECT') AS projects,
      (SELECT count(*) FROM scope_nodes s WHERE s.org_id = o.id AND s.kind = 'PHASE') AS towers,
      (SELECT count(DISTINCT x.user_id) FROM memberships x WHERE x.org_id = o.id AND x.status = 'ACTIVE') AS members,
      (SELECT max(u.last_login_at) FROM memberships x JOIN users u ON u.id = x.user_id
        WHERE x.org_id = o.id AND x.status = 'ACTIVE') AS last_login,
      greatest(
        (SELECT max(l.updated_at) FROM leads l WHERE l.org_id = o.id),
        (SELECT max(c.placed_at) FROM calls c WHERE c.org_id = o.id),
        (SELECT max(r.created_at) FROM rendered_posts r WHERE r.org_id = o.id),
        (SELECT max(a.created_at) FROM ask_messages a WHERE a.org_id = o.id)
      ) AS last_activity,
      (SELECT count(*) FROM leads l WHERE l.org_id = o.id AND l.created_at >= m.since) AS leads_month,
      (SELECT count(*) FROM leads l WHERE l.org_id = o.id) AS leads_all,
      (SELECT count(*) FROM leads l WHERE l.org_id = o.id AND l.stage = 'booked') AS booked_all,
      (SELECT count(*) FROM calls c WHERE c.org_id = o.id AND c.placed_at >= m.since) AS calls_month,
      (SELECT count(*) FROM calls c WHERE c.org_id = o.id AND c.placed_at >= m.since AND c.connectivity = 'connected') AS connected_month,
      (SELECT coalesce(sum(c.duration_s), 0) / 60 FROM calls c WHERE c.org_id = o.id AND c.placed_at >= m.since) AS call_minutes,
      (SELECT count(*) FROM site_visits v WHERE v.org_id = o.id AND v.scheduled_at >= m.since) AS visits_month,
      (SELECT count(*) FROM usage_events u WHERE u.org_id = o.id AND u.period = m.p
        AND u.kind IN ('IMAGE_POST', 'CAROUSEL') AND u.billable) AS posts_month,
      (SELECT count(*) FROM usage_events u WHERE u.org_id = o.id AND u.period = m.p
        AND u.kind IN ('VIDEO', 'FILM', 'FILM_VERSION', 'STORY_REEL') AND u.billable) AS videos_month,
      (SELECT count(*) FROM usage_events u WHERE u.org_id = o.id AND u.period = m.p AND u.kind = 'QUESTION') AS questions_month,
      (SELECT coalesce(sum(cost_paise), 0) FROM usage_events u WHERE u.org_id = o.id AND u.period = m.p) AS cost_month,
      (SELECT coalesce(sum(cost_paise), 0) FROM usage_events u WHERE u.org_id = o.id
        AND u.period = (m.p - interval '1 month')::date) AS cost_last_month,
      (SELECT coalesce(sum(cost_paise), 0) FROM usage_events u WHERE u.org_id = o.id) AS cost_all
    FROM orgs o CROSS JOIN m
    LEFT JOIN billing_accounts b ON b.org_id = o.id
    LEFT JOIN operator_notes op ON op.org_id = o.id
    ${only ? "WHERE o.id = $1" : ""}
    ORDER BY o.created_at`,
    only ? [only] : [],
  );
  return rows.map((r) => {
    const plans = (r.plans as { plan: string; scope: string; pricePaise: number }[]).map((p) => ({
      ...p,
      pricePaise: Number(p.pricePaise),
    }));
    return {
      id: r.id,
      name: r.display_name,
      legalName: r.legal_name,
      type: r.type,
      status: r.status,
      createdAt: r.created_at,
      billingMode: r.billing_mode,
      plans,
      planValuePaise: plans.reduce((s, p) => s + p.pricePaise, 0),
      paidPaise: n(r.paid),
      projects: n(r.projects),
      towers: n(r.towers),
      members: n(r.members),
      lastLogin: r.last_login,
      lastActivity: r.last_activity,
      leadsMonth: n(r.leads_month),
      leadsAll: n(r.leads_all),
      bookedAll: n(r.booked_all),
      callsMonth: n(r.calls_month),
      connectedMonth: n(r.connected_month),
      callMinutesMonth: Math.round(n(r.call_minutes)),
      visitsMonth: n(r.visits_month),
      postsMonth: n(r.posts_month),
      videosMonth: n(r.videos_month),
      questionsMonth: n(r.questions_month),
      costMonthPaise: n(r.cost_month),
      costLastMonthPaise: n(r.cost_last_month),
      costAllPaise: n(r.cost_all),
      isTest: r.is_test,
      note: r.note,
    };
  });
}

export async function listClients(): Promise<ClientRow[]> {
  return readOnly((tx) => clientRows(tx));
}

/* =============================================================== series */

export type Day = { day: string; a: number; b: number };

/** Leads and calls (or any two counts) a day for the last 30 IST days. */
async function dailyActivity(tx: Tx, excl: string[], org?: string): Promise<{ leads: Day[]; calls: Day[]; cost: Day[] }> {
  const orgCond = (col: string) => (org ? `AND ${col} = $1` : `AND NOT (${col} = ANY($1::uuid[]))`);
  const params = org ? [org] : [excl];
  const rows = await tx.unsafe(
    `
    WITH g AS (
      SELECT d::date AS day FROM generate_series(
        (now() AT TIME ZONE 'Asia/Kolkata')::date - 29, (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') d
    )
    SELECT to_char(g.day, 'YYYY-MM-DD') AS day,
      (SELECT count(*) FROM leads l WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = g.day ${orgCond("l.org_id")}) AS leads,
      (SELECT count(*) FROM leads l WHERE (l.created_at AT TIME ZONE 'Asia/Kolkata')::date = g.day AND l.stage = 'booked' ${orgCond("l.org_id")}) AS booked,
      (SELECT count(*) FROM calls c WHERE (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date = g.day ${orgCond("c.org_id")}) AS calls,
      (SELECT count(*) FROM calls c WHERE (c.placed_at AT TIME ZONE 'Asia/Kolkata')::date = g.day AND c.connectivity = 'connected' ${orgCond("c.org_id")}) AS connected,
      (SELECT coalesce(sum(u.cost_paise), 0) FROM usage_events u WHERE (u.occurred_at AT TIME ZONE 'Asia/Kolkata')::date = g.day ${orgCond("u.org_id")}) AS cost
    FROM g ORDER BY g.day`,
    params,
  );
  return {
    leads: rows.map((r) => ({ day: r.day, a: n(r.leads), b: n(r.booked) })),
    calls: rows.map((r) => ({ day: r.day, a: n(r.calls), b: n(r.connected) })),
    cost: rows.map((r) => ({ day: r.day, a: n(r.cost), b: 0 })),
  };
}

export type MonthCost = { period: string; costPaise: number };

async function monthlyCost(tx: Tx, excl: string[], org?: string): Promise<MonthCost[]> {
  const rows = await tx.unsafe(
    `SELECT to_char(g.p, 'YYYY-MM') AS period, coalesce(sum(u.cost_paise), 0) AS cost
     FROM generate_series(${MONTH_DATE} - interval '5 months', ${MONTH_DATE}, interval '1 month') AS g(p)
     LEFT JOIN usage_events u ON u.period = g.p::date ${org ? "AND u.org_id = $1" : "AND NOT (u.org_id = ANY($1::uuid[]))"}
     GROUP BY g.p ORDER BY g.p`,
    org ? [org] : [excl],
  );
  return rows.map((r) => ({ period: r.period, costPaise: n(r.cost) }));
}

export type UsageRow = { kind: string; made: number; billed: number; costPaise: number; lastMonthCostPaise: number; lastMonthMade: number };

async function usageByKind(tx: Tx, excl: string[], org?: string): Promise<UsageRow[]> {
  const rows = await tx.unsafe(
    `SELECT kind,
       count(*) FILTER (WHERE period = ${MONTH_DATE}) AS made,
       coalesce(sum(qty) FILTER (WHERE billable AND period = ${MONTH_DATE}), 0) AS billed,
       coalesce(sum(cost_paise) FILTER (WHERE period = ${MONTH_DATE}), 0) AS cost,
       count(*) FILTER (WHERE period = (${MONTH_DATE} - interval '1 month')::date) AS made_last,
       coalesce(sum(cost_paise) FILTER (WHERE period = (${MONTH_DATE} - interval '1 month')::date), 0) AS cost_last
     FROM usage_events
     WHERE period >= (${MONTH_DATE} - interval '1 month')::date ${org ? "AND org_id = $1" : "AND NOT (org_id = ANY($1::uuid[]))"}
     GROUP BY kind ORDER BY cost DESC`,
    org ? [org] : [excl],
  );
  return rows.map((r) => ({
    kind: r.kind,
    made: n(r.made),
    billed: n(r.billed),
    costPaise: n(r.cost),
    lastMonthMade: n(r.made_last),
    lastMonthCostPaise: n(r.cost_last),
  }));
}

/* ============================================================== overview */

export type Health = {
  reelFailed7d: number;
  publishFailed: number;
  postRunsRefused7d: number;
  tasksFailed7d: number;
  callsRefused7d: number;
  callsSystemFailure7d: number;
  messagesFailed7d: number;
  crmDead: number;
  connectionsBroken: number;
  waNumbersRed: number;
};

async function healthCounts(tx: Tx): Promise<Health> {
  const [h] = await tx`
    SELECT
      (SELECT count(*) FROM reel_jobs WHERE state = 'FAILED' AND updated_at > now() - interval '7 days') AS reel,
      (SELECT count(*) FROM publish_targets WHERE state = 'FAILED') AS publish,
      (SELECT count(*) FROM post_runs WHERE state = 'REFUSED' AND created_at > now() - interval '7 days') AS runs,
      (SELECT count(*) FROM lead_tasks WHERE state = 'FAILED' AND created_at > now() - interval '7 days') AS tasks,
      (SELECT count(*) FROM calls WHERE status = 'REFUSED' AND placed_at > now() - interval '7 days') AS refused,
      (SELECT count(*) FROM calls WHERE system_failure AND placed_at > now() - interval '7 days') AS sysfail,
      (SELECT count(*) FROM messages WHERE status = 'FAILED' AND created_at > now() - interval '7 days') AS msgfail,
      (SELECT count(*) FROM crm_outbox WHERE status = 'DEAD') AS crm,
      (SELECT count(*) FROM connections WHERE status = 'BROKEN') AS broken,
      (SELECT count(*) FROM whatsapp_numbers WHERE active AND quality = 'RED') AS red`;
  return {
    reelFailed7d: n(h.reel),
    publishFailed: n(h.publish),
    postRunsRefused7d: n(h.runs),
    tasksFailed7d: n(h.tasks),
    callsRefused7d: n(h.refused),
    callsSystemFailure7d: n(h.sysfail),
    messagesFailed7d: n(h.msgfail),
    crmDead: n(h.crm),
    connectionsBroken: n(h.broken),
    waNumbersRed: n(h.red),
  };
}

export type Overview = {
  clients: ClientRow[];
  daily: { leads: Day[]; calls: Day[]; cost: Day[] };
  trend: MonthCost[];
  usage: UsageRow[];
  health: Health;
  today: { leads: number; calls: number; connected: number; visits: number; signIns: number };
  newClients30d: number;
  testCount: number;
};

export async function overviewData(): Promise<Overview> {
  return readOnly(async (tx) => {
    const excl = await testIds(tx);
    const [all, daily, trend, usage, health, [t]] = await Promise.all([
      clientRows(tx),
      dailyActivity(tx, excl),
      monthlyCost(tx, excl),
      usageByKind(tx, excl),
      healthCounts(tx),
      tx.unsafe(
        `SELECT
          (SELECT count(*) FROM leads WHERE created_at >= ${DAY_SINCE} AND NOT (org_id = ANY($1::uuid[]))) AS leads,
          (SELECT count(*) FROM calls WHERE placed_at >= ${DAY_SINCE} AND NOT (org_id = ANY($1::uuid[]))) AS calls,
          (SELECT count(*) FROM calls WHERE placed_at >= ${DAY_SINCE} AND connectivity = 'connected' AND NOT (org_id = ANY($1::uuid[]))) AS connected,
          (SELECT count(*) FROM site_visits WHERE scheduled_at >= ${DAY_SINCE} AND scheduled_at < ${DAY_SINCE} + interval '1 day'
             AND NOT (org_id = ANY($1::uuid[]))) AS visits,
          (SELECT count(*) FROM users WHERE last_login_at >= ${DAY_SINCE}) AS sign_ins`,
        [excl],
      ),
    ]);
    const clients = all.filter((c) => !c.isTest);
    return {
      clients,
      daily,
      trend,
      usage,
      health,
      today: { leads: n(t.leads), calls: n(t.calls), connected: n(t.connected), visits: n(t.visits), signIns: n(t.sign_ins) },
      newClients30d: clients.filter((c) => Date.now() - c.createdAt.getTime() < 30 * 86_400_000).length,
      testCount: all.length - clients.length,
    };
  });
}

/* ========================================================== one client */

export type Allowance = { unit: string; label: string; used: number; allowance: number };

export type SubRow = {
  id: string;
  plan: string;
  label: string;
  scope: string;
  projectId: string | null;
  projectName: string | null;
  startsOn: string;
  endsOn: string | null;
  pricePaise: number;
  thisMonthPaise: number;
  fixedCostPaise: number;
  meteredCostPaise: number;
  margin: number | null;
  prepaid: boolean;
  channels: number;
  numbers: number;
  agents: string[];
  questions: number;
  allowances: Allowance[];
  firm: boolean;
  ended: boolean;
};

const UNIT_LABEL: Record<string, string> = {
  MINUTE: "AI call minutes",
  IMAGE: "Image posts",
  CAROUSEL: "Carousels",
  VIDEO: "Videos",
};

async function subscriptionRows(tx: Tx, org?: string, excl: string[] = []): Promise<(SubRow & { orgId: string; orgName: string })[]> {
  const period = `${istMonth()}-01`;
  const rows = await tx.unsafe(
    `SELECT s.id, s.org_id, o.display_name AS org_name, s.plan, s.scope, s.project_id, p.name AS project_name,
            to_char(s.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on,
            s.terms, s.extra_channels, s.extra_numbers, s.payment_id,
            (SELECT coalesce(sum(u.cost_paise), 0) FROM usage_events u
              WHERE u.org_id = s.org_id AND u.period = ${MONTH_DATE} AND u.kind <> 'PHONE_NUMBER'
                AND (s.scope = 'ORG' OR u.project_id = s.project_id)
                AND u.occurred_at >= s.starts_on AND (s.ends_on IS NULL OR u.occurred_at < s.ends_on)) AS cost,
            (SELECT coalesce(jsonb_object_agg(x.unit, x.used), '{}'::jsonb) FROM (
               SELECT u.unit, sum(u.from_allowance) AS used FROM usage_events u
               WHERE u.org_id = s.org_id AND u.period = ${MONTH_DATE}
                 AND (s.scope = 'ORG' OR u.project_id = s.project_id)
                 AND u.occurred_at >= s.starts_on AND (s.ends_on IS NULL OR u.occurred_at < s.ends_on)
               GROUP BY u.unit) x) AS used
     FROM subscriptions s
     JOIN orgs o ON o.id = s.org_id
     LEFT JOIN scope_nodes p ON p.id = s.project_id
     WHERE s.status = 'ACTIVE' AND (s.ends_on IS NULL OR s.ends_on > ${MONTH_DATE})
       ${org ? "AND s.org_id = $1" : "AND NOT (s.org_id = ANY($1::uuid[]))"}
     ORDER BY o.display_name, s.starts_on`,
    [org ?? excl],
  );
  return rows.map((r) => {
    const t = (r.terms ?? {}) as {
      label?: string;
      pricePaise?: number;
      channels?: number;
      numbers?: number;
      agents?: string[];
      allowance?: Record<string, number>;
      questions?: number;
      firm?: boolean;
    };
    const price = n(t.pricePaise);
    const sub = { startsOn: r.starts_on as string, endsOn: (r.ends_on as string | null) ?? null };
    const thisMonth = proratedPrice(price, sub, period);
    const plan = r.plan as keyof typeof PLATFORM_PAISE;
    const channels = n(t.channels) + n(r.extra_channels);
    const numbers = n(t.numbers) + n(r.extra_numbers);
    const fixed = proratedPrice(
      channels * COST_PAISE.CHANNEL_MONTH + numbers * COST_PAISE.NUMBER_MONTH + (t.firm ? PARTNER_PLATFORM_PAISE : PLATFORM_PAISE)[plan],
      sub,
      period,
    );
    const metered = n(r.cost);
    const used = (r.used ?? {}) as Record<string, number>;
    return {
      id: r.id,
      orgId: r.org_id,
      orgName: r.org_name,
      plan: r.plan,
      label: t.label ?? r.plan,
      scope: r.scope,
      projectId: r.project_id,
      projectName: r.project_name,
      startsOn: sub.startsOn,
      endsOn: sub.endsOn,
      pricePaise: price,
      thisMonthPaise: thisMonth,
      fixedCostPaise: fixed,
      meteredCostPaise: metered,
      margin: thisMonth > 0 ? 1 - (fixed + metered) / thisMonth : null,
      prepaid: !!r.payment_id,
      channels,
      numbers,
      agents: t.agents ?? [],
      questions: n(t.questions),
      firm: !!t.firm,
      ended: !!sub.endsOn && sub.endsOn <= new Date().toISOString().slice(0, 10),
      allowances: Object.entries(t.allowance ?? {}).map(([unit, allowance]) => ({
        unit,
        label: UNIT_LABEL[unit] ?? unit,
        used: Math.round(n(used[unit]) * 10) / 10,
        allowance: n(allowance),
      })),
    };
  });
}

export type ClientDetail = {
  client: ClientRow;
  subs: SubRow[];
  people: { name: string | null; email: string | null; phone: boolean; role: string; place: string; lastLogin: Date | null; joined: Date | null }[];
  projects: {
    id: string;
    name: string;
    city: string | null;
    towers: number;
    plan: string | null;
    leadsMonth: number;
    leadsAll: number;
    callMinutesMonth: number;
    costMonthPaise: number;
  }[];
  usage: UsageRow[];
  trend: MonthCost[];
  daily: { leads: Day[]; calls: Day[]; cost: Day[] };
  connections: { provider: string; status: string; checkedAt: Date | null; error: string | null }[];
  numbers: { kind: "WhatsApp" | "Calling"; label: string; state: string }[];
  payments: { at: Date; purpose: string | null; plan: string | null; totalPaise: number; status: string; test: boolean }[];
  stages: { stage: string; n: number }[];
  channels: { channel: string; n: number }[];
  outcomes: { outcome: string; n: number }[];
  content: { kind: string; passed: number; failed: number }[];
  publications: { destination: string; state: string; n: number }[];
  activity: { at: Date; words: string; who: string | null }[];
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function clientDetail(id: string): Promise<ClientDetail | null> {
  if (!ID.test(id)) return null;
  return readOnly(async (tx) => {
    const [client] = await clientRows(tx, id);
    if (!client) return null;
    const [
      subs,
      people,
      projects,
      usage,
      trend,
      daily,
      connections,
      wa,
      calling,
      payments,
      stages,
      channels,
      outcomes,
      content,
      publications,
      activity,
    ] = await Promise.all([
      subscriptionRows(tx, id),
      tx`
        SELECT u.name, u.email, (u.phone IS NOT NULL) AS phone, x.role, n.name AS place, u.last_login_at, x.accepted_at
        FROM memberships x JOIN users u ON u.id = x.user_id JOIN scope_nodes n ON n.id = x.scope_node_id
        WHERE x.org_id = ${id} AND x.status = 'ACTIVE' AND u.erased_at IS NULL
        ORDER BY u.last_login_at DESC NULLS LAST`,
      tx.unsafe(
        `WITH m AS (SELECT ${MONTH_DATE} AS p, ${MONTH_SINCE} AS since)
         SELECT p.id, p.name, r.name AS city,
           (SELECT count(*) FROM scope_nodes t WHERE t.org_id = p.org_id AND t.kind = 'PHASE' AND t.path <@ p.path) AS towers,
           (SELECT s.plan FROM subscriptions s WHERE s.project_id = p.id AND s.status = 'ACTIVE'
              AND s.starts_on <= current_date AND (s.ends_on IS NULL OR s.ends_on > current_date) LIMIT 1) AS plan,
           (SELECT count(*) FROM leads l JOIN scope_nodes ln ON ln.id = l.scope_node_id
              WHERE l.org_id = p.org_id AND ln.path <@ p.path AND l.created_at >= m.since) AS leads_month,
           (SELECT count(*) FROM leads l JOIN scope_nodes ln ON ln.id = l.scope_node_id
              WHERE l.org_id = p.org_id AND ln.path <@ p.path) AS leads_all,
           (SELECT coalesce(sum(c.duration_s), 0) / 60 FROM calls c JOIN scope_nodes cn ON cn.id = c.scope_node_id
              WHERE c.org_id = p.org_id AND cn.path <@ p.path AND c.placed_at >= m.since) AS call_minutes,
           (SELECT coalesce(sum(u.cost_paise), 0) FROM usage_events u WHERE u.project_id = p.id AND u.period = m.p) AS cost
         FROM scope_nodes p CROSS JOIN m
         LEFT JOIN scope_nodes r ON r.id = p.parent_id AND r.kind = 'REGION'
         WHERE p.org_id = $1 AND p.kind = 'PROJECT'
         ORDER BY p.created_at`,
        [id],
      ),
      usageByKind(tx, [], id),
      monthlyCost(tx, [], id),
      dailyActivity(tx, [], id),
      tx`SELECT provider, status, last_checked_at, last_error_code FROM connections WHERE org_id = ${id} AND status <> 'DISCONNECTED' ORDER BY provider`,
      tx`SELECT display_phone, verified_name, quality, active FROM whatsapp_numbers WHERE org_id = ${id} AND retired_at IS NULL`,
      tx`SELECT number, city, active FROM calling_numbers WHERE org_id = ${id} AND released_at IS NULL`,
      tx`SELECT coalesce(paid_at, created_at) AS at, purpose, plan, total_paise, status, test
         FROM payments WHERE org_id = ${id} ORDER BY created_at DESC LIMIT 25`,
      tx`SELECT stage, count(*)::int AS n FROM leads WHERE org_id = ${id} AND erased_at IS NULL GROUP BY stage`,
      tx`SELECT coalesce(channel, 'OTHER') AS channel, count(*)::int AS n FROM leads WHERE org_id = ${id} GROUP BY 1 ORDER BY 2 DESC`,
      tx.unsafe(
        `SELECT coalesce(outcome, 'UNKNOWN') AS outcome, count(*)::int AS n FROM calls
         WHERE org_id = $1 AND placed_at >= ${MONTH_SINCE} GROUP BY 1 ORDER BY 2 DESC`,
        [id],
      ),
      tx`SELECT kind, count(*) FILTER (WHERE (review->>'passed') = 'true')::int AS passed,
                count(*) FILTER (WHERE (review->>'passed') = 'false')::int AS failed
         FROM rendered_posts WHERE org_id = ${id} GROUP BY kind ORDER BY kind`,
      tx`SELECT destination, state, count(*)::int AS n FROM publish_targets WHERE org_id = ${id} GROUP BY 1, 2 ORDER BY 1, 2`,
      tx`SELECT a.created_at, a.action, u.name AS who FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.org_id = ${id} ORDER BY a.created_at DESC LIMIT 25`,
    ]);
    return {
      client,
      subs,
      people: people.map((p) => ({
        name: p.name,
        email: p.email,
        phone: p.phone,
        role: p.role,
        place: p.place,
        lastLogin: p.last_login_at,
        joined: p.accepted_at,
      })),
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        city: p.city,
        towers: n(p.towers),
        plan: p.plan,
        leadsMonth: n(p.leads_month),
        leadsAll: n(p.leads_all),
        callMinutesMonth: Math.round(n(p.call_minutes)),
        costMonthPaise: n(p.cost),
      })),
      usage,
      trend,
      daily,
      connections: connections.map((c) => ({ provider: c.provider, status: c.status, checkedAt: c.last_checked_at, error: c.last_error_code })),
      numbers: [
        ...wa.map((w) => ({
          kind: "WhatsApp" as const,
          label: `${w.display_phone ?? "Number"}${w.verified_name ? ` · ${w.verified_name}` : ""}`,
          state: w.active ? (w.quality ?? "UNKNOWN") : "Not placed",
        })),
        ...calling.map((c) => ({
          kind: "Calling" as const,
          label: `${c.number}${c.city ? ` · ${c.city}` : ""}`,
          state: c.active ? "Active" : "Not placed",
        })),
      ],
      payments: payments.map((p) => ({
        at: p.at,
        purpose: p.purpose,
        plan: p.plan,
        totalPaise: n(p.total_paise),
        status: p.status,
        test: p.test,
      })),
      stages: stages.map((s) => ({ stage: s.stage, n: s.n })),
      channels: channels.map((s) => ({ channel: s.channel, n: s.n })),
      outcomes: outcomes.map((s) => ({ outcome: s.outcome, n: s.n })),
      content: content.map((s) => ({ kind: s.kind, passed: s.passed, failed: s.failed })),
      publications: publications.map((s) => ({ destination: s.destination, state: s.state, n: s.n })),
      activity: activity.map((a) => ({ at: a.created_at, words: auditWords(a.action), who: a.who })),
    };
  });
}

/* ================================================================== plans */

export type PlansData = {
  subs: (SubRow & { orgId: string; orgName: string })[];
  payments: { at: Date; orgId: string; orgName: string; purpose: string | null; plan: string | null; totalPaise: number; status: string; test: boolean }[];
  renewals: { orgName: string; period: string; status: string; totalPaise: number }[];
  noPlan: { id: string; name: string; type: string; projects: number }[];
  floors: { plan: number; worst: number };
};

export async function plansData(): Promise<PlansData> {
  return readOnly(async (tx) => {
    const excl = await testIds(tx);
    const [subs, payments, renewals, noPlan] = await Promise.all([
      subscriptionRows(tx, undefined, excl),
      tx`SELECT coalesce(p.paid_at, p.created_at) AS at, p.org_id, o.display_name, p.purpose, p.plan, p.total_paise, p.status, p.test
         FROM payments p JOIN orgs o ON o.id = p.org_id
         WHERE NOT (p.org_id = ANY(${excl}::uuid[]))
         ORDER BY p.created_at DESC LIMIT 50`,
      tx`SELECT o.display_name, to_char(r.period, 'YYYY-MM') AS period, r.status, r.total_paise
         FROM plan_renewals r JOIN orgs o ON o.id = r.org_id
         WHERE NOT (r.org_id = ANY(${excl}::uuid[]))
         ORDER BY r.period DESC LIMIT 30`,
      tx`SELECT o.id, o.display_name, o.type,
           (SELECT count(*) FROM scope_nodes s WHERE s.org_id = o.id AND s.kind = 'PROJECT')::int AS projects
         FROM orgs o
         WHERE NOT (o.id = ANY(${excl}::uuid[]))
           AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.org_id = o.id AND s.status = 'ACTIVE'
                             AND (s.ends_on IS NULL OR s.ends_on > current_date))
         ORDER BY projects DESC, o.display_name`,
    ]);
    return {
      subs,
      payments: payments.map((p) => ({
        at: p.at,
        orgId: p.org_id,
        orgName: p.display_name,
        purpose: p.purpose,
        plan: p.plan,
        totalPaise: n(p.total_paise),
        status: p.status,
        test: p.test,
      })),
      renewals: renewals.map((r) => ({
        orgName: r.display_name,
        period: r.period,
        status: r.status,
        totalPaise: n(r.total_paise),
      })),
      noPlan: noPlan.map((o) => ({ id: o.id, name: o.display_name, type: o.type, projects: o.projects })),
      floors: { plan: PLAN_FLOOR, worst: WORST_FLOOR },
    };
  });
}

/* ================================================================= usage */

export type UsageData = {
  usage: UsageRow[];
  trend: MonthCost[];
  dailyCost: Day[];
  byClient: { id: string; name: string; costPaise: number; lastMonthPaise: number; top: string | null }[];
  byProject: { orgId: string; orgName: string; name: string; costPaise: number }[];
  byVendor: { vendor: string; costPaise: number }[];
};

export async function usageData(): Promise<UsageData> {
  return readOnly(async (tx) => {
    const excl = await testIds(tx);
    const [usage, trend, daily, byClient, byProject] = await Promise.all([
      usageByKind(tx, excl),
      monthlyCost(tx, excl),
      dailyActivity(tx, excl),
      tx.unsafe(
        `SELECT o.id, o.display_name,
           coalesce(sum(u.cost_paise) FILTER (WHERE u.period = ${MONTH_DATE}), 0) AS cost,
           coalesce(sum(u.cost_paise) FILTER (WHERE u.period = (${MONTH_DATE} - interval '1 month')::date), 0) AS last,
           (SELECT u2.kind FROM usage_events u2 WHERE u2.org_id = o.id AND u2.period = ${MONTH_DATE}
              GROUP BY u2.kind ORDER BY sum(u2.cost_paise) DESC LIMIT 1) AS top
         FROM orgs o JOIN usage_events u ON u.org_id = o.id
         WHERE u.period >= (${MONTH_DATE} - interval '1 month')::date AND NOT (o.id = ANY($1::uuid[]))
         GROUP BY o.id, o.display_name ORDER BY cost DESC`,
        [excl],
      ),
      tx.unsafe(
        `SELECT o.id AS org_id, o.display_name, p.name, sum(u.cost_paise) AS cost
         FROM usage_events u JOIN scope_nodes p ON p.id = u.project_id JOIN orgs o ON o.id = u.org_id
         WHERE u.period = ${MONTH_DATE} AND NOT (u.org_id = ANY($1::uuid[]))
         GROUP BY o.id, o.display_name, p.name ORDER BY cost DESC LIMIT 12`,
        [excl],
      ),
    ]);
    const vendors = new Map<string, number>();
    for (const u of usage) vendors.set(VENDOR_OF[u.kind] ?? "Other", (vendors.get(VENDOR_OF[u.kind] ?? "Other") ?? 0) + u.costPaise);
    return {
      usage,
      trend,
      dailyCost: daily.cost,
      byClient: byClient.map((r) => ({ id: r.id, name: r.display_name, costPaise: n(r.cost), lastMonthPaise: n(r.last), top: r.top })),
      byProject: byProject.map((r) => ({ orgId: r.org_id, orgName: r.display_name, name: r.name, costPaise: n(r.cost) })),
      byVendor: [...vendors.entries()].map(([vendor, costPaise]) => ({ vendor, costPaise })).sort((a, b) => b.costPaise - a.costPaise),
    };
  });
}

/* ================================================================= calls */

export type CallsData = {
  daily: Day[];
  month: { placed: number; connected: number; minutes: number; avgConnectedS: number; handedOff: number; inbound: number; refused: number; systemFailure: number };
  lastMonth: { placed: number; connected: number; minutes: number };
  outcomes: { outcome: string; n: number }[];
  agents: { agent: string; placed: number; connected: number; minutes: number }[];
  byClient: { id: string; name: string; placed: number; connected: number; minutes: number; hot: number }[];
  temperature: { t: string; n: number }[];
  failures: { reason: string; n: number; last: Date }[];
};

export async function callsData(): Promise<CallsData> {
  return readOnly(async (tx) => {
    const excl = await testIds(tx);
    const p = [excl];
    const notTest = "NOT (org_id = ANY($1::uuid[]))";
    const [daily, [m], [lm], outcomes, agents, byClient, temperature, failures] = await Promise.all([
      dailyActivity(tx, excl),
      tx.unsafe(
        `SELECT count(*) AS placed,
           count(*) FILTER (WHERE connectivity = 'connected') AS connected,
           coalesce(sum(duration_s), 0) / 60 AS minutes,
           coalesce(avg(duration_s) FILTER (WHERE connectivity = 'connected'), 0) AS avg_s,
           count(*) FILTER (WHERE handoff_to IS NOT NULL) AS handed,
           count(*) FILTER (WHERE direction = 'IN') AS inbound,
           count(*) FILTER (WHERE status = 'REFUSED') AS refused,
           count(*) FILTER (WHERE system_failure) AS sysfail
         FROM calls WHERE placed_at >= ${MONTH_SINCE} AND ${notTest}`,
        p,
      ),
      tx.unsafe(
        `SELECT count(*) AS placed, count(*) FILTER (WHERE connectivity = 'connected') AS connected,
           coalesce(sum(duration_s), 0) / 60 AS minutes
         FROM calls WHERE placed_at >= ${MONTH_SINCE} - interval '1 month' AND placed_at < ${MONTH_SINCE} AND ${notTest}`,
        p,
      ),
      tx.unsafe(
        `SELECT coalesce(outcome, 'UNKNOWN') AS outcome, count(*)::int AS n FROM calls
         WHERE placed_at >= ${MONTH_SINCE} AND ${notTest} GROUP BY 1 ORDER BY 2 DESC`,
        p,
      ),
      tx.unsafe(
        `SELECT agent, count(*)::int AS placed, count(*) FILTER (WHERE connectivity = 'connected')::int AS connected,
           coalesce(sum(duration_s), 0) / 60 AS minutes
         FROM calls WHERE placed_at >= ${MONTH_SINCE} AND ${notTest} GROUP BY agent ORDER BY placed DESC`,
        p,
      ),
      tx.unsafe(
        `SELECT o.id, o.display_name, count(*)::int AS placed,
           count(*) FILTER (WHERE c.connectivity = 'connected')::int AS connected,
           coalesce(sum(c.duration_s), 0) / 60 AS minutes,
           count(*) FILTER (WHERE c.temperature = 'HOT' OR c.temperature = 'WARM')::int AS hot
         FROM calls c JOIN orgs o ON o.id = c.org_id
         WHERE c.placed_at >= ${MONTH_SINCE} AND NOT (c.org_id = ANY($1::uuid[]))
         GROUP BY o.id, o.display_name ORDER BY placed DESC`,
        p,
      ),
      tx.unsafe(
        `SELECT coalesce(temperature, 'NOT_READ') AS t, count(*)::int AS n FROM calls
         WHERE placed_at >= ${MONTH_SINCE} AND connectivity = 'connected' AND ${notTest} GROUP BY 1 ORDER BY 2 DESC`,
        p,
      ),
      tx.unsafe(
        `SELECT coalesce(left(failure_reason, 110), outcome, 'No reason recorded') AS reason, count(*)::int AS n, max(placed_at) AS last
         FROM calls WHERE (system_failure OR status = 'REFUSED') AND placed_at > now() - interval '30 days' AND ${notTest}
         GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        p,
      ),
    ]);
    return {
      daily: daily.calls,
      month: {
        placed: n(m.placed),
        connected: n(m.connected),
        minutes: Math.round(n(m.minutes)),
        avgConnectedS: Math.round(n(m.avg_s)),
        handedOff: n(m.handed),
        inbound: n(m.inbound),
        refused: n(m.refused),
        systemFailure: n(m.sysfail),
      },
      lastMonth: { placed: n(lm.placed), connected: n(lm.connected), minutes: Math.round(n(lm.minutes)) },
      outcomes: outcomes.map((r) => ({ outcome: r.outcome, n: r.n })),
      agents: agents.map((r) => ({ agent: r.agent, placed: r.placed, connected: r.connected, minutes: Math.round(n(r.minutes)) })),
      byClient: byClient.map((r) => ({
        id: r.id,
        name: r.display_name,
        placed: r.placed,
        connected: r.connected,
        minutes: Math.round(n(r.minutes)),
        hot: r.hot,
      })),
      temperature: temperature.map((r) => ({ t: r.t, n: r.n })),
      failures: failures.map((r) => ({ reason: r.reason, n: r.n, last: r.last })),
    };
  });
}

/* ================================================================= leads */

export type LeadsData = {
  daily: Day[];
  funnel: { key: string; label: string; n: number }[];
  monthNew: number;
  lastMonthNew: number;
  channels: { channel: string; n: number }[];
  byClient: { id: string; name: string; month: number; all: number; qualified: number; visits: number; booked: number }[];
  visits: { status: string; n: number }[];
  bookedMonth: number;
};

const REACHED: Record<string, string[]> = {
  contacted: ["contacted", "qualified", "visit_scheduled", "visit_done", "negotiation", "booked"],
  qualified: ["qualified", "visit_scheduled", "visit_done", "negotiation", "booked"],
  visited: ["visit_done", "negotiation", "booked"],
  booked: ["booked"],
};

export async function leadsData(): Promise<LeadsData> {
  return readOnly(async (tx) => {
    const excl = await testIds(tx);
    const p = [excl];
    const notTest = "NOT (org_id = ANY($1::uuid[]))";
    const [daily, [f], channels, byClient, visits, [b]] = await Promise.all([
      dailyActivity(tx, excl),
      tx.unsafe(
        `SELECT count(*) AS all_leads,
           count(*) FILTER (WHERE path_stage = ANY($2)) AS contacted,
           count(*) FILTER (WHERE path_stage = ANY($3)) AS qualified,
           count(*) FILTER (WHERE path_stage = ANY($4)) AS visited,
           count(*) FILTER (WHERE path_stage = ANY($5) OR stage = 'booked') AS booked,
           count(*) FILTER (WHERE created_at >= ${MONTH_SINCE}) AS month_new,
           count(*) FILTER (WHERE created_at >= ${MONTH_SINCE} - interval '1 month' AND created_at < ${MONTH_SINCE}) AS last_new
         FROM leads WHERE ${notTest} AND erased_at IS NULL`,
        [excl, REACHED.contacted, REACHED.qualified, REACHED.visited, REACHED.booked],
      ),
      tx.unsafe(
        `SELECT coalesce(channel, 'OTHER') AS channel, count(*)::int AS n FROM leads
         WHERE created_at >= ${MONTH_SINCE} AND ${notTest} GROUP BY 1 ORDER BY 2 DESC`,
        p,
      ),
      tx.unsafe(
        `SELECT o.id, o.display_name,
           count(*) FILTER (WHERE l.created_at >= ${MONTH_SINCE})::int AS month,
           count(*)::int AS all_leads,
           count(*) FILTER (WHERE l.path_stage = ANY($2))::int AS qualified,
           count(*) FILTER (WHERE l.path_stage = ANY($3))::int AS visits,
           count(*) FILTER (WHERE l.stage = 'booked')::int AS booked
         FROM leads l JOIN orgs o ON o.id = l.org_id
         WHERE NOT (l.org_id = ANY($1::uuid[])) AND l.erased_at IS NULL
         GROUP BY o.id, o.display_name ORDER BY month DESC, all_leads DESC`,
        [excl, REACHED.qualified, REACHED.visited],
      ),
      tx.unsafe(
        `SELECT status, count(*)::int AS n FROM site_visits WHERE scheduled_at >= ${MONTH_SINCE} AND ${notTest}
         GROUP BY 1 ORDER BY 2 DESC`,
        p,
      ),
      tx.unsafe(
        `SELECT count(*) AS n FROM outcome_events WHERE kind = 'BOOKED' AND occurred_at >= ${MONTH_SINCE} AND ${notTest}`,
        p,
      ),
    ]);
    return {
      daily: daily.leads,
      funnel: [
        { key: "all", label: "Leads", n: n(f.all_leads) },
        { key: "contacted", label: "Reached", n: n(f.contacted) },
        { key: "qualified", label: "Qualified", n: n(f.qualified) },
        { key: "visited", label: "Visited", n: n(f.visited) },
        { key: "booked", label: "Booked", n: n(f.booked) },
      ],
      monthNew: n(f.month_new),
      lastMonthNew: n(f.last_new),
      channels: channels.map((r) => ({ channel: r.channel, n: r.n })),
      byClient: byClient.map((r) => ({
        id: r.id,
        name: r.display_name,
        month: r.month,
        all: r.all_leads,
        qualified: r.qualified,
        visits: r.visits,
        booked: r.booked,
      })),
      visits: visits.map((r) => ({ status: r.status, n: r.n })),
      bookedMonth: n(b.n),
    };
  });
}

/* =============================================================== content */

export type ContentData = {
  posts: { kind: string; month: number; passed: number; failed: number; all: number }[];
  jobs: { format: string; state: string; n: number }[];
  publications: { destination: string; state: string; n: number }[];
  byClient: { id: string; name: string; images: number; carousels: number; videos: number; published: number }[];
  runs: { state: string; n: number }[];
  recentFailures: { at: Date; orgName: string; what: string; message: string | null }[];
};

export async function contentData(): Promise<ContentData> {
  return readOnly(async (tx) => {
    const excl = await testIds(tx);
    const p = [excl];
    const notTest = "NOT (org_id = ANY($1::uuid[]))";
    const [posts, jobs, publications, byClient, runs, failures] = await Promise.all([
      tx.unsafe(
        `SELECT kind,
           count(*) FILTER (WHERE created_at >= ${MONTH_SINCE})::int AS month,
           count(*) FILTER (WHERE (review->>'passed') = 'true')::int AS passed,
           count(*) FILTER (WHERE (review->>'passed') = 'false')::int AS failed,
           count(*)::int AS all_posts
         FROM rendered_posts WHERE ${notTest} GROUP BY kind ORDER BY all_posts DESC`,
        p,
      ),
      tx.unsafe(`SELECT format, state, count(*)::int AS n FROM reel_jobs WHERE ${notTest} GROUP BY 1, 2 ORDER BY 1, 3 DESC`, p),
      tx.unsafe(`SELECT destination, state, count(*)::int AS n FROM publish_targets WHERE ${notTest} GROUP BY 1, 2 ORDER BY 1, 3 DESC`, p),
      tx.unsafe(
        `SELECT o.id, o.display_name,
           count(*) FILTER (WHERE r.kind = 'IMAGE')::int AS images,
           count(*) FILTER (WHERE r.kind = 'CAROUSEL')::int AS carousels,
           count(*) FILTER (WHERE r.kind = 'VIDEO')::int AS videos,
           (SELECT count(*) FROM publish_targets t WHERE t.org_id = o.id AND t.state IN ('LIVE', 'ACTIVE'))::int AS published
         FROM rendered_posts r JOIN orgs o ON o.id = r.org_id
         WHERE NOT (r.org_id = ANY($1::uuid[]))
         GROUP BY o.id, o.display_name ORDER BY count(*) DESC`,
        p,
      ),
      tx.unsafe(`SELECT state, count(*)::int AS n FROM post_runs WHERE ${notTest} GROUP BY 1 ORDER BY 2 DESC`, p),
      tx.unsafe(
        `SELECT * FROM (
           SELECT j.updated_at AS at, o.display_name, 'Video (' || j.format || ')' AS what, j.message
           FROM reel_jobs j JOIN orgs o ON o.id = j.org_id WHERE j.state = 'FAILED' AND NOT (j.org_id = ANY($1::uuid[]))
           UNION ALL
           SELECT t.updated_at, o.display_name, 'Publish to ' || t.destination, t.error
           FROM publish_targets t JOIN orgs o ON o.id = t.org_id WHERE t.state = 'FAILED' AND NOT (t.org_id = ANY($1::uuid[]))
         ) x ORDER BY at DESC LIMIT 12`,
        p,
      ),
    ]);
    return {
      posts: posts.map((r) => ({ kind: r.kind, month: r.month, passed: r.passed, failed: r.failed, all: r.all_posts })),
      jobs: jobs.map((r) => ({ format: r.format, state: r.state, n: r.n })),
      publications: publications.map((r) => ({ destination: r.destination, state: r.state, n: r.n })),
      byClient: byClient.map((r) => ({
        id: r.id,
        name: r.display_name,
        images: r.images,
        carousels: r.carousels,
        videos: r.videos,
        published: r.published,
      })),
      runs: runs.map((r) => ({ state: r.state, n: r.n })),
      recentFailures: failures.map((r) => ({ at: r.at, orgName: r.display_name, what: r.what, message: r.message })),
    };
  });
}

/* ================================================================ health */

export type HealthData = {
  counts: Health;
  groups: { area: string; what: string; n: number; last: Date | null }[];
  connections: { orgId: string; orgName: string; provider: string; status: string; error: string | null; checkedAt: Date | null }[];
  numbers: { orgId: string; orgName: string; kind: string; label: string; state: string }[];
  queues: { name: string; due: number; oldest: Date | null }[];
};

export async function healthData(): Promise<HealthData> {
  return readOnly(async (tx) => {
    const [counts, tasks, messages, calls, reels, publish, crm, connections, wa, numbers, [q]] = await Promise.all([
      healthCounts(tx),
      tx`SELECT initcap(lower(kind)) || coalesce(' · ' || left(result, 80), '') AS what, count(*)::int AS n, max(created_at) AS last
         FROM lead_tasks WHERE state = 'FAILED' AND created_at > now() - interval '7 days'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
      tx`SELECT coalesce(left(error, 90), 'No reason recorded') AS what, count(*)::int AS n, max(created_at) AS last
         FROM messages WHERE status = 'FAILED' AND created_at > now() - interval '7 days'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
      tx`SELECT coalesce(left(failure_reason, 90), outcome, 'No reason recorded') AS what, count(*)::int AS n, max(placed_at) AS last
         FROM calls WHERE (system_failure OR status = 'REFUSED') AND placed_at > now() - interval '7 days'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
      tx`SELECT format || coalesce(' · ' || left(message, 80), '') AS what, count(*)::int AS n, max(updated_at) AS last
         FROM reel_jobs WHERE state = 'FAILED' AND updated_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
      tx`SELECT destination || coalesce(' · ' || left(error, 80), '') AS what, count(*)::int AS n, max(updated_at) AS last
         FROM publish_targets WHERE state = 'FAILED' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
      tx`SELECT op || coalesce(' · ' || left(last_error, 80), '') AS what, count(*)::int AS n, max(updated_at) AS last
         FROM crm_outbox WHERE status = 'DEAD' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
      tx`SELECT c.org_id, o.display_name, c.provider, c.status, c.last_error_code, c.last_checked_at
         FROM connections c JOIN orgs o ON o.id = c.org_id WHERE c.status <> 'DISCONNECTED' ORDER BY c.status, o.display_name`,
      tx`SELECT w.org_id, o.display_name, w.display_phone, w.verified_name, w.quality, w.active
         FROM whatsapp_numbers w JOIN orgs o ON o.id = w.org_id WHERE w.retired_at IS NULL ORDER BY o.display_name`,
      tx`SELECT c.org_id, o.display_name, c.number, c.city, c.active
         FROM calling_numbers c JOIN orgs o ON o.id = c.org_id WHERE c.released_at IS NULL ORDER BY o.display_name`,
      tx`SELECT
           (SELECT count(*) FROM lead_tasks WHERE state = 'DUE' AND due_at < now()) AS tasks_due,
           (SELECT min(due_at) FROM lead_tasks WHERE state = 'DUE' AND due_at < now()) AS tasks_oldest,
           (SELECT count(*) FROM reel_jobs WHERE state IN ('QUEUED', 'RUNNING')) AS reels,
           (SELECT min(created_at) FROM reel_jobs WHERE state IN ('QUEUED', 'RUNNING')) AS reels_oldest,
           (SELECT count(*) FROM publish_targets WHERE state = 'QUEUED') AS pubs,
           (SELECT min(created_at) FROM publish_targets WHERE state = 'QUEUED') AS pubs_oldest,
           (SELECT count(*) FROM crm_outbox WHERE status IN ('PENDING', 'WAITING')) AS crm,
           (SELECT min(created_at) FROM crm_outbox WHERE status IN ('PENDING', 'WAITING')) AS crm_oldest,
           (SELECT count(*) FROM post_runs WHERE state = 'PENDING' AND generate_at < now()) AS runs,
           (SELECT min(generate_at) FROM post_runs WHERE state = 'PENDING' AND generate_at < now()) AS runs_oldest`,
    ]);
    const g = (area: string, rows: { what: string; n: number; last: Date | null }[]) =>
      rows.map((r) => ({ area, what: readable(r.what), n: r.n, last: r.last }));
    return {
      counts,
      groups: [
        ...g("Calls", calls as never),
        ...g("WhatsApp", messages as never),
        ...g("Engine tasks", tasks as never),
        ...g("Videos", reels as never),
        ...g("Publishing", publish as never),
        ...g("CRM", crm as never),
      ],
      connections: connections.map((c) => ({
        orgId: c.org_id,
        orgName: c.display_name,
        provider: c.provider,
        status: c.status,
        error: c.last_error_code,
        checkedAt: c.last_checked_at,
      })),
      numbers: [
        ...wa.map((w) => ({
          orgId: w.org_id,
          orgName: w.display_name,
          kind: "WhatsApp",
          label: `${w.display_phone ?? ""}${w.verified_name ? ` · ${w.verified_name}` : ""}`,
          state: w.active ? (w.quality ?? "UNKNOWN") : "Not placed",
        })),
        ...numbers.map((c) => ({
          orgId: c.org_id,
          orgName: c.display_name,
          kind: "Calling",
          label: `${c.number}${c.city ? ` · ${c.city}` : ""}`,
          state: c.active ? "Active" : "Not placed",
        })),
      ],
      queues: [
        { name: "Calls and messages due now", due: n(q.tasks_due), oldest: q.tasks_oldest },
        { name: "Videos making", due: n(q.reels), oldest: q.reels_oldest },
        { name: "Posts waiting to publish", due: n(q.pubs), oldest: q.pubs_oldest },
        { name: "CRM writes waiting", due: n(q.crm), oldest: q.crm_oldest },
        { name: "Scheduled runs overdue", due: n(q.runs), oldest: q.runs_oldest },
      ],
    };
  });
}

const CODES: Record<string, string> = {
  FAILED: "Did not connect",
  REFUSED: "Refused before dialling",
  presenter: "Film",
  story: "Narrated story",
  reel: "Story reel",
  META_AD: "Meta ad",
  INSTAGRAM: "Instagram",
  FACEBOOK_PAGE: "Facebook Page",
  GOOGLE_DISPLAY_AD: "Google display ad",
  GOOGLE_DEMAND_GEN_AD: "Google Demand Gen",
};

/** A grouped failure's words: a stored code in front is said in words. */
function readable(what: string): string {
  const [head, ...rest] = what.split(" · ");
  return [CODES[head] ?? head, ...rest].join(" · ");
}

/* =============================================================== vendors */

export type Vendor = {
  name: string;
  forWhat: string;
  balance: string | null;
  /** The balance in paise, when it is money we can compare a burn rate with. */
  balancePaise: number | null;
  detail: string | null;
  state: "ok" | "low" | "unknown";
  meteredMonthPaise: number;
  burn7dPaise: number;
  daysLeft: number | null;
  spentTotal: string | null;
  keySet: boolean;
  link: string;
};

const USD = 91;
let cached: { at: number; raw: { or: unknown; vb: unknown; el: unknown } } | null = null;

async function getJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8_000), cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const inr = (paise: number) => `Rs ${Math.round(paise / 100).toLocaleString("en-IN")}`;

/** Live balances where the vendor publishes them (cached two minutes), beside our own metered spend. */
export async function vendorsData(fresh = false): Promise<Vendor[]> {
  const e = process.env;
  if (!cached || fresh || Date.now() - cached.at > 120_000) {
    const [or, vb, el] = await Promise.all([
      e.OPENROUTER_API_KEY ? getJson("https://openrouter.ai/api/v1/credits", { authorization: `Bearer ${e.OPENROUTER_API_KEY}` }) : null,
      e.VOBIZ_AUTH_ID && e.VOBIZ_AUTH_TOKEN
        ? getJson(`https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(e.VOBIZ_AUTH_ID)}/balance/`, {
            "X-Auth-ID": e.VOBIZ_AUTH_ID,
            "X-Auth-Token": e.VOBIZ_AUTH_TOKEN,
          })
        : null,
      e.ELEVENLABS_API_KEY ? getJson("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": e.ELEVENLABS_API_KEY }) : null,
    ]);
    cached = { at: Date.now(), raw: { or, vb, el } };
  }
  const { or, vb, el } = cached.raw;

  const spend = await readOnly(async (tx) => {
    const rows = await tx.unsafe(
      `SELECT kind,
         coalesce(sum(cost_paise) FILTER (WHERE period = ${MONTH_DATE}), 0) AS month,
         coalesce(sum(cost_paise) FILTER (WHERE occurred_at > now() - interval '7 days'), 0) AS week
       FROM usage_events WHERE occurred_at > now() - interval '45 days' GROUP BY kind`,
    );
    const [c] = await tx`SELECT coalesce(sum(duration_s), 0) / 60 AS minutes FROM calls WHERE placed_at > now() - interval '7 days'`;
    return { rows, callMinutes7d: n(c.minutes) };
  });
  const by = (vendor: string, key: "month" | "week") =>
    spend.rows.filter((r) => VENDOR_OF[r.kind] === vendor).reduce((s, r) => s + n(r[key]), 0);
  const days = (balancePaise: number | null, week: number) =>
    balancePaise !== null && week > 0 ? Math.floor(balancePaise / (week / 7)) : null;

  const list: Vendor[] = [];

  {
    const d = (or as { data?: { total_credits?: number; total_usage?: number } } | null)?.data;
    const left = d ? n(d.total_credits) - n(d.total_usage) : NaN;
    const ok = Number.isFinite(left);
    const bal = ok ? Math.round(left * USD * 100) : null;
    const week = by("OpenRouter", "week");
    list.push({
      name: "OpenRouter",
      forWhat: "Every video and film (Seedance, Kling)",
      balance: ok ? `$${left.toFixed(2)}` : null,
      balancePaise: bal,
      detail: ok ? `About ${inr(bal!)} left. A 30 s film costs about $16 to $23.` : "Could not read the balance.",
      state: ok ? (left < 25 ? "low" : "ok") : "unknown",
      meteredMonthPaise: by("OpenRouter", "month"),
      burn7dPaise: week,
      daysLeft: days(bal, week),
      spentTotal: d ? `$${n(d.total_usage).toFixed(2)} spent in all` : null,
      keySet: !!e.OPENROUTER_API_KEY,
      link: "https://openrouter.ai/settings/credits",
    });
  }
  {
    const b = (vb as { balances?: { available_balance?: number; low_balance_threshold?: number }[] } | null)?.balances?.[0];
    const left = Number(b?.available_balance);
    const ok = Number.isFinite(left);
    const bal = ok ? Math.round(left * 100) : null;
    // Vobiz carries every call's line (about Rs 0.45 a minute) as well as hand-offs and numbers.
    const week = by("Vobiz", "week") + Math.round(spend.callMinutes7d * 45);
    list.push({
      name: "Vobiz",
      forWhat: "Phone lines, calling numbers, calls to people",
      balance: ok ? `Rs ${left.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : null,
      balancePaise: bal,
      detail: ok ? "Renting a number takes Rs 600 to 700 from this." : "Could not read the balance.",
      state: ok ? (left < Math.max(500, n(b?.low_balance_threshold)) ? "low" : "ok") : "unknown",
      meteredMonthPaise: by("Vobiz", "month"),
      burn7dPaise: week,
      daysLeft: days(bal, week),
      spentTotal: null,
      keySet: !!(e.VOBIZ_AUTH_ID && e.VOBIZ_AUTH_TOKEN),
      link: "https://vobiz.ai",
    });
  }
  {
    const s = el as { character_count?: number; character_limit?: number; next_character_count_reset_unix?: number; tier?: string } | null;
    const used = Number(s?.character_count);
    const limit = Number(s?.character_limit);
    const ok = Number.isFinite(used) && Number.isFinite(limit) && limit > 0;
    const reset = s?.next_character_count_reset_unix
      ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(
          new Date(s.next_character_count_reset_unix * 1000),
        )
      : null;
    list.push({
      name: "ElevenLabs",
      forWhat: "Narration, voice fixes, film music",
      balance: ok ? `${(limit - used).toLocaleString("en-IN")} credits` : null,
      balancePaise: null,
      detail: ok
        ? `${Math.round((used / limit) * 100)}% of ${limit.toLocaleString("en-IN")} used on the ${s?.tier ?? ""} plan${reset ? `, resets ${reset}` : ""}.`
        : e.ELEVENLABS_API_KEY
          ? "Could not read the balance."
          : "No key on this server.",
      state: ok ? ((limit - used) / limit < 0.15 ? "low" : "ok") : "unknown",
      meteredMonthPaise: 0,
      burn7dPaise: 0,
      daysLeft: null,
      spentTotal: ok ? `${used.toLocaleString("en-IN")} credits used this cycle` : null,
      keySet: !!e.ELEVENLABS_API_KEY,
      link: "https://elevenlabs.io/app/subscription",
    });
  }
  list.push({
    name: "Sarvam",
    forWhat: "AI calls, voices, speech to text",
    balance: null,
    balancePaise: null,
    detail: "Sarvam publishes no balance API. Check credits on its dashboard.",
    state: "unknown",
    meteredMonthPaise: by("Sarvam", "month"),
    burn7dPaise: by("Sarvam", "week"),
    daysLeft: null,
    spentTotal: null,
    keySet: !!(e.SARVAM_API_KEY && e.SARVAM_AGENTS_KEY),
    link: "https://dashboard.sarvam.ai",
  });
  list.push({
    name: "OpenAI",
    forWhat: "Copy, post design, Ask Jimmy, checks",
    balance: null,
    balancePaise: null,
    detail: "Prepaid credit is not readable with our API key.",
    state: "unknown",
    meteredMonthPaise: by("OpenAI", "month"),
    burn7dPaise: by("OpenAI", "week"),
    daysLeft: null,
    spentTotal: null,
    keySet: !!e.OPENAI_API_KEY,
    link: "https://platform.openai.com/settings/organization/billing/overview",
  });
  list.push({
    name: "Meta (WhatsApp)",
    forWhat: "WhatsApp messages from each developer's number",
    balance: null,
    balancePaise: null,
    detail: "Paid by each developer's own card at Meta.",
    state: "unknown",
    meteredMonthPaise: by("Meta", "month"),
    burn7dPaise: by("Meta", "week"),
    daysLeft: null,
    spentTotal: null,
    keySet: !!e.META_APP_ID,
    link: "https://business.facebook.com/billing_hub",
  });
  list.push({
    name: "AWS",
    forWhat: "Database, files, email, SMS, worker",
    balance: null,
    balancePaise: null,
    detail: "Billed monthly to the card.",
    state: "unknown",
    meteredMonthPaise: by("AWS", "month"),
    burn7dPaise: by("AWS", "week"),
    daysLeft: null,
    spentTotal: null,
    keySet: !!e.AWS_ACCESS_KEY_ID || !!e.AWS_SES_PROFILE,
    link: "https://console.aws.amazon.com/billing/home",
  });
  list.push({
    name: "Vercel",
    forWhat: "The app at app.salesdesk.app",
    balance: null,
    balancePaise: null,
    detail: "A fixed monthly plan.",
    state: "unknown",
    meteredMonthPaise: 0,
    burn7dPaise: 0,
    daysLeft: null,
    spentTotal: null,
    keySet: true,
    link: "https://vercel.com/dashboard",
  });
  return list;
}

/* ================================================================ writes */

/** The operator's own note on a client. The one write this console makes. */
export async function saveOperatorNote(orgId: string, isTest: boolean, note: string, by: string): Promise<boolean> {
  if (!ID.test(orgId)) return false;
  const text = note.trim().slice(0, 2000) || null;
  await controlDb`
    INSERT INTO operator_notes (org_id, is_test, note, updated_by, updated_at)
    SELECT ${orgId}, ${isTest}, ${text}, ${by}, now() WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ${orgId})
    ON CONFLICT (org_id) DO UPDATE SET is_test = EXCLUDED.is_test, note = EXCLUDED.note,
      updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return true;
}

/** How many things on System health want a look, for the rail's badge. */
export async function problemCount(): Promise<number> {
  return readOnly(async (tx) => {
    const h = await healthCounts(tx);
    return [h.reelFailed7d, h.publishFailed, h.callsSystemFailure7d, h.crmDead, h.connectionsBroken, h.waNumbersRed].filter((v) => v > 0).length;
  });
}
