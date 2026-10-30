import { audit, auditHash, withNoTenant, withTenant } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import { vobiz, vobizConfig } from "./vobiz.ts";
import { mailFrom, send } from "./mailer.ts";
import { sarvam, sarvamConfig } from "./sarvam.ts";
import { meterQuietly } from "./billing.ts";
import { webhookBase, webhookSecret } from "./calling.ts";
import { inboundAddress } from "./inbound-call-rules.ts";
import { kycView, verifiedSub, type KycView } from "./calling-kyc.ts";
import {
  NUMBER_PRICE,
  connectionProblem,
  numberMonthsDue,
  readConnectionId,
  SEARCH_LIMIT,
  callerLine,
  isE164,
  numbersAllowed,
  readSearch,
  readStarts,
  AREAS,
  MOBILE_SERIES,
  kycProblem,
  rentProblem,
  type Available,
  type Line,
  type OwnNumber,
} from "./calling-number-rules.ts";

/**
 * Each developer's own calling number: the reads and writes around
 * `calling-number-rules.ts`.
 *
 * A number is rented on Sales Desk's Vobiz account and belongs to one
 * tenant (`calling_numbers`, 0072). Every outbound call (an AI call, a
 * hand-off, a call through our number, the hot-buyer bridge) takes its
 * caller id from `callerLineFor()`. Every read and write is `withTenant()`;
 * the one question with no tenant, "whose number did this call ring", is
 * `callingNumberOwner()` on the SECURITY DEFINER lookup, ids only.
 */

/** The shared number an AI call from a tenant with none of its own uses. */
export const sharedAiNumber = (): string | null => process.env.SARVAM_FROM_NUMBER?.trim() || null;

/** The shared number a call through our number uses for a tenant with none. */
export const sharedProxyNumber = (): string | null =>
  (process.env.PROXY_FROM_NUMBER ?? process.env.SARVAM_FROM_NUMBER ?? "").trim() || null;

type Row = {
  id: string;
  number: string;
  active: boolean;
  node_path: string | null;
  sarvam_connection_id: string | null;
  released: boolean;
};

/**
 * The number a call to a lead at `nodeId` goes out from: the tenant's own,
 * the shared one while it holds none and is not billed LIVE, or a refusal.
 */
export async function callerLineFor(orgId: string, nodeId: string, shared: string | null): Promise<Line> {
  const found = await withTenant(orgId, async (sql) => {
    const [node] = await sql<{ path: string }[]>`
      SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId}`;
    const rows = await sql<Row[]>`
      SELECT c.id, c.number, c.active, n.path::text AS node_path, c.sarvam_connection_id,
             c.released_at IS NOT NULL AS released
      FROM calling_numbers c LEFT JOIN scope_nodes n ON n.id = c.scope_node_id
      WHERE c.org_id = ${orgId} AND c.released_at IS NULL`;
    const [acct] = await sql<{ mode: string }[]>`SELECT mode FROM billing_accounts WHERE org_id = ${orgId}`;
    return { path: node?.path ?? null, rows, live: acct?.mode === "LIVE" };
  });
  if (!found.path) return { ok: false, code: "OFF", message: "That place no longer exists." };
  const numbers: OwnNumber[] = found.rows.map((r) => ({
    id: r.id,
    number: r.number,
    active: r.active,
    nodePath: r.node_path,
    connectionId: r.sarvam_connection_id,
    released: r.released,
  }));
  return callerLine({ numbers, nodePath: found.path, live: found.live, shared });
}

/** The tenant a number belongs to, for a call that names only the number. Ids only. */
export async function callingNumberOwner(number: string): Promise<{ orgId: string; numberId: string } | null> {
  if (!isE164(number)) return null;
  const [r] = await withNoTenant((sql) => sql<{ org_id: string; number_id: string }[]>`
    SELECT org_id, number_id FROM calling_number_owner(${number})`);
  return r ? { orgId: r.org_id, numberId: r.number_id } : null;
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export type NumberView = {
  id: string;
  number: string;
  city: string | null;
  place: { id: string; name: string; kind: string } | null;
  rentedAt: string;
  /** The tenant's own Sarvam connection, when one is recorded. */
  connectionId: string | null;
  /** The answer address to paste into Vobiz for calls to this number; null while calls are not set up. */
  inbound: string | null;
};

export type Place = { id: string; kind: string; name: string };

export type NumbersPage = {
  numbers: NumberView[];
  places: Place[];
  /** Numbers the plans include, or null when no plan was ever sold. */
  allowed: number | null;
  /** Why one more cannot be rented, or null. */
  problem: string | null;
  /** The client's own KYC, null before it was started. */
  kyc: KycView | null;
  /** Why no number may be got yet because of the KYC, or null. */
  kycProblem: string | null;
  /** Whether renting through Vobiz is switched on at all. */
  canRent: boolean;
  /** Calls use the shared number today (no number of its own, not LIVE). */
  onShared: boolean;
};

export async function numbersPage(orgId: string, opts: { refreshKyc?: boolean } = {}): Promise<NumbersPage> {
  const kycRead = kycView(orgId, { refresh: opts.refreshKyc });
  const got = await withTenant(orgId, async (sql) => {
    const [rows, places, plans, acct] = await Promise.all([
      sql<{ id: string; number: string; city: string | null; rented_at: Date; node_id: string | null; node_name: string | null; node_kind: string | null; sarvam_connection_id: string | null }[]>`
        SELECT c.id, c.number, c.city, c.rented_at, n.id AS node_id, n.name AS node_name, n.kind AS node_kind, c.sarvam_connection_id
        FROM calling_numbers c LEFT JOIN scope_nodes n ON n.id = c.scope_node_id AND c.active
        WHERE c.org_id = ${orgId} AND c.released_at IS NULL
        ORDER BY c.rented_at`,
      placesIn(sql, orgId),
      plansToday(sql, orgId),
      sql<{ mode: string }[]>`SELECT mode FROM billing_accounts WHERE org_id = ${orgId}`,
    ]);
    return { rows, places, plans, mode: acct[0]?.mode ?? null };
  });
  const allowed = numbersAllowed(got.mode !== null, got.plans);
  const kyc = await kycRead;
  const base = webhookBase();
  const secret = base && process.env.AUTH_SECRET ? webhookSecret() : null;
  return {
    numbers: got.rows.map((r) => ({
      id: r.id,
      number: r.number,
      city: r.city,
      place: r.node_id ? { id: r.node_id, name: r.node_name ?? "", kind: r.node_kind ?? "" } : null,
      rentedAt: r.rented_at.toISOString(),
      connectionId: r.sarvam_connection_id,
      inbound: base && secret ? inboundAddress(base, secret, r.number) : null,
    })),
    places: got.places,
    allowed,
    problem: rentProblem({ held: got.rows.length, allowed }),
    kyc,
    kycProblem: kyc ? kyc.problem : kycProblem(null),
    canRent: vobizConfig() !== null,
    onShared: got.rows.length === 0 && got.mode !== "LIVE" && !!sharedAiNumber(),
  };
}

type Sql = Parameters<Parameters<typeof withTenant>[1]>[0];

/** Where a number may be used: the organisation, an entity or a project. */
function placesIn(sql: Sql, orgId: string) {
  return sql<Place[]>`
    SELECT id, kind, name FROM scope_nodes
    WHERE org_id = ${orgId} AND kind IN ('ORG', 'ENTITY', 'PROJECT')
    ORDER BY path`;
}

/** Each plan live today: its own count of numbers and the extra ones sold on it. */
function plansToday(sql: Sql, orgId: string) {
  return sql<{ numbers: number; extra: number }[]>`
    SELECT coalesce((s.terms->>'numbers')::int, 0) AS numbers, s.extra_numbers AS extra
    FROM subscriptions s
    WHERE s.org_id = ${orgId}
      AND s.starts_on <= (now() AT TIME ZONE 'Asia/Kolkata')::date
      AND (s.ends_on IS NULL OR s.ends_on > (now() AT TIME ZONE 'Asia/Kolkata')::date)`;
}

// ---------------------------------------------------------------------------
// Searching and renting
// ---------------------------------------------------------------------------

export type SearchResult = { ok: true; city: string | null; code: string; numbers: Available[] } | { ok: false; message: string };

export type Area = { code: string; label: string; free: number };

let areaCache: { at: number; areas: Area[] } | null = null;
const AREA_CACHE_MS = 30 * 60_000;

/**
 * The areas Vobiz has numbers in right now, each with how many, for the
 * search's list: one small read per area code, in parallel, kept half an
 * hour. Null when Vobiz cannot be asked, and the page falls back to a box.
 */
export async function numberAreas(): Promise<Area[] | null> {
  if (areaCache && Date.now() - areaCache.at < AREA_CACHE_MS) return areaCache.areas;
  const cfg = vobizConfig();
  const driver = vobiz();
  if (!cfg || !driver.countNumbers) return null;
  // Four at a time: Vobiz answers one in a fifth of a second, and times out
  // when asked for all of them at once.
  const counted: Area[] = [];
  let failed = 0;
  for (let i = 0; i < AREAS.length; i += 4) {
    const batch = await Promise.allSettled(AREAS.slice(i, i + 4).map(async (a) => ({ ...a, free: await driver.countNumbers!(cfg, `91${a.code}`) })));
    for (const r of batch) {
      if (r.status === "fulfilled") counted.push(r.value);
      else failed += 1;
    }
  }
  if (failed === AREAS.length) {
    console.warn("calling numbers: no area could be counted");
    return null;
  }
  const areas = counted.filter((a) => a.free > 0).sort((x, y) => y.free - x.free);
  // An area that could not be counted is asked again sooner.
  areaCache = { at: failed ? Date.now() - AREA_CACHE_MS + 5 * 60_000 : Date.now(), areas };
  return areas;
}

/** Numbers Vobiz has for a city or an area code, narrowed by the digits that follow it. Nothing is rented. */
export async function searchNumbers(query: string, startsRaw?: string | null, opts: { kyc?: boolean } = {}): Promise<SearchResult> {
  const read = readSearch(query);
  if (!read.ok) return read;
  if (read.code === MOBILE_SERIES && !opts.kyc) return { ok: false, message: "Verify your business to get a 92-series number." };
  const starts = readStarts(startsRaw);
  const q = starts ? { ...read, pattern: `${read.pattern}${starts}` } : read;
  const cfg = vobizConfig();
  const driver = vobiz();
  if (!cfg || !driver.searchNumbers) return { ok: false, message: "Getting a number isn't switched on yet." };
  try {
    const numbers = await driver.searchNumbers(cfg, { pattern: q.pattern, city: q.city, limit: SEARCH_LIMIT, kyc: opts.kyc });
    return { ok: true, city: q.city, code: q.code, numbers: numbers.slice(0, SEARCH_LIMIT) };
  } catch (e) {
    console.warn(`calling numbers: search failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, message: "We couldn't reach our phone provider. Try again in a minute." };
  }
}

export type Outcome = { ok: true; message: string; numberId?: string } | { ok: false; code: string; message: string };

/**
 * Rent one number and, when a place is given, put it to work there. Every
 * refusal is decided before Vobiz is asked, because a rented number is a
 * month's rent whether it is used or not.
 */
export async function rentCallingNumber(input: {
  orgId: string;
  userId: string;
  number: string;
  city: string | null;
  nodeId: string | null;
}): Promise<Outcome> {
  const { orgId, userId } = input;
  const number = input.number.trim();
  if (!isE164(number) || !number.startsWith("+91")) return { ok: false, code: "INVALID", message: "Choose a number from the list." };
  const city = input.city?.trim().slice(0, 80) || null;

  const cfg = vobizConfig();
  const driver = vobiz();
  if (!cfg || !driver.rentNumber) return { ok: false, code: "OFF", message: "Getting a number isn't switched on yet." };

  const before = await withTenant(orgId, async (sql) => {
    const [places, plans, acct, held] = await Promise.all([
      placesIn(sql, orgId),
      plansToday(sql, orgId),
      sql<{ mode: string }[]>`SELECT mode FROM billing_accounts WHERE org_id = ${orgId}`,
      sql<{ n: number }[]>`SELECT count(*)::int AS n FROM calling_numbers WHERE org_id = ${orgId} AND released_at IS NULL`,
    ]);
    let clash = false;
    if (input.nodeId) {
      const [c] = await sql<{ id: string }[]>`
        SELECT id FROM calling_numbers WHERE org_id = ${orgId} AND active AND scope_node_id = ${input.nodeId}`;
      clash = !!c;
    }
    return { places, plans, billed: acct.length > 0, held: held[0]?.n ?? 0, clash };
  });

  let nodeId: string | null = null;
  if (input.nodeId) {
    if (!isNodeId(input.nodeId) || !before.places.some((p) => p.id === input.nodeId)) {
      return { ok: false, code: "UNKNOWN_PLACE", message: "Choose where this number is used." };
    }
    if (before.clash) return { ok: false, code: "TWO_AT_ONE_PLACE", message: "Another number already calls for that place. Move it first." };
    nodeId = input.nodeId;
  }
  const problem = rentProblem({ held: before.held, allowed: numbersAllowed(before.billed, before.plans) });
  if (problem) return { ok: false, code: "LIMIT", message: problem };
  // Every number sits on the client's own verified sub-account.
  const sub = await verifiedSub(orgId);
  if (!sub) return { ok: false, code: "KYC", message: kycProblem((await kycView(orgId)) ?? null) ?? "Verify your business first." };
  if (!driver.assignToSub) return { ok: false, code: "OFF", message: "Getting a number isn't switched on yet." };
  if (await callingNumberOwner(number)) return { ok: false, code: "TAKEN", message: "That number was just taken. Choose another." };
  // A 92-series number costs us Rs 1,000 a month; it is sold at the same price as any number.
  const costPaise = number.startsWith(`+91${MOBILE_SERIES}`) ? 1000_00 : NUMBER_PRICE.costPaise;

  try {
    await driver.rentNumber(cfg, number);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`calling numbers: rent failed: ${why}`);
    // Our own account at Vobiz could not pay: another number fails the same way.
    if (/balance/i.test(why)) return { ok: false, code: "PROVIDER_BALANCE", message: "We couldn't get a number right now. Try again later." };
    return { ok: false, code: "REFUSED", message: "Our phone provider did not give us that number. Choose another." };
  }
  // Onto the client's sub-account at once; a number that will not move is given back.
  try {
    await driver.assignToSub(cfg, number, sub);
  } catch (e) {
    console.warn(`calling numbers: move to sub-account failed: ${e instanceof Error ? e.message : String(e)}`);
    await driver.releaseNumber?.(cfg, number).catch(() => {});
    return { ok: false, code: "REFUSED", message: "We couldn't set up that number for you. Choose another." };
  }

  let id: string;
  try {
    const [row] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
      INSERT INTO calling_numbers (org_id, number, city, scope_node_id, active, monthly_cost_paise, monthly_price_paise, rented_by, sub_auth_id)
      VALUES (${orgId}, ${number}, ${city}, ${nodeId}, ${nodeId !== null}, ${costPaise}, ${NUMBER_PRICE.pricePaise}, ${userId}, ${sub})
      RETURNING id`);
    id = row.id;
  } catch (e) {
    // The row did not land, so the rental would be rent nobody uses: give it back.
    await driver.releaseNumber?.(cfg, number).catch(() => {});
    const taken = (e as { code?: string }).code === "23505";
    return { ok: false, code: taken ? "TAKEN" : "FAILED", message: taken ? "That number was just taken. Choose another." : "The number could not be saved. Try again." };
  }

  // The number is a business line, but it is kept out of the log like any other.
  await audit({
    orgId,
    actorUserId: userId,
    action: "calling.number_rented",
    targetType: "calling_number",
    targetId: id,
    metadata: {
      number: auditHash(number),
      nodeId,
      unit: "phone_number",
      cost_paise: costPaise,
      price_paise: NUMBER_PRICE.pricePaise,
      sub_account: sub,
    },
  });

  // Linked to the voice app that hands calls to Sarvam, in the same press, so
  // a buyer ringing the number reaches the agent. Twice at most; a link that
  // will not take keeps the number (it is paid for) and says so.
  let linked = !driver.linkNumber;
  for (let attempt = 0; attempt < 2 && !linked; attempt++) {
    linked = await driver.linkNumber!(cfg, number).then(() => true, (e: unknown) => {
      console.warn(`calling numbers: link failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    });
  }
  await audit({
    orgId,
    actorUserId: userId,
    action: linked ? "calling.number_linked" : "calling.number_link_failed",
    targetType: "calling_number",
    targetId: id,
    metadata: { number: auditHash(number) },
  });
  // Sarvam takes no number from our key yet, so we are told to add it to the
  // connection by hand (and to link it at Vobiz when that did not take).
  // Never fails the rental.
  const to = process.env.ALERT_EMAIL?.trim() || mailFrom();
  if (to) {
    const sc = sarvamConfig();
    const steps = [
      // The number sits on the client's own Vobiz sub-account, so it is dialled
      // through the client's own Sarvam connection, never ours.
      `0. Sarvam: if this client has no connection yet, add one: Telephony, Bring your own telephony, Vobiz, with sub-account ${sub}. Its token: npm run vobiz:sub -- --org ${orgId}. Then put the connection's id on the number in Settings, Calling numbers.`,
      `1. Sarvam: Deploy, Phone Numbers, the client's connection (sub-account ${sub}): onboard ${number}.`,
      // Without an inbound deployment Sarvam answers a buyer ringing this
      // number and hangs up at once (Harbour View's first number, 24 October 2026).
      `2. Sarvam: Deploy, Inbound: a deployment of the receptionist (${sc.ok && sc.config.receptionistApp ? `${sc.config.receptionistApp.id} v${sc.config.receptionistApp.version}` : "Sales Desk-receptionist"}) on ${number}, with the same call-end webhook as the other receptionist deployments.`,
      linked ? null : `3. Vobiz: Voice Applications, sarvam-prod: attach ${number} (the automatic link did not take).`,
    ].filter(Boolean);
    await send({ to, subject: `New calling number to connect: ${number}`, text: `A client rented ${number}. Until it is connected, its calls fail.\n\n${steps.join("\n")}\n` }).catch(() => null);
  }
  const ready = "We are connecting it for calls now.";
  return { ok: true, numberId: id, message: nodeId ? `Done. ${ready}` : `Done. Choose where it is used. ${ready}` };
}

/** Put a number to work at a place, or take it off (`nodeId` null). */
export async function placeCallingNumber(input: { orgId: string; userId: string; numberId: string; nodeId: string | null }): Promise<Outcome> {
  const { orgId } = input;
  if (!isNodeId(input.numberId)) return { ok: false, code: "GONE", message: "That number is no longer yours." };
  if (input.nodeId !== null && !isNodeId(input.nodeId)) return { ok: false, code: "UNKNOWN_PLACE", message: "Choose where this number is used." };
  const out = await withTenant(orgId, async (sql): Promise<Outcome> => {
    const [n] = await sql<{ id: string }[]>`
      SELECT id FROM calling_numbers WHERE org_id = ${orgId} AND id = ${input.numberId} AND released_at IS NULL`;
    if (!n) return { ok: false, code: "GONE", message: "That number is no longer yours." };
    if (input.nodeId) {
      const places = await placesIn(sql, orgId);
      if (!places.some((p) => p.id === input.nodeId)) return { ok: false, code: "UNKNOWN_PLACE", message: "Choose where this number is used." };
      const [clash] = await sql<{ id: string }[]>`
        SELECT id FROM calling_numbers
        WHERE org_id = ${orgId} AND active AND scope_node_id = ${input.nodeId} AND id <> ${input.numberId}`;
      if (clash) return { ok: false, code: "TWO_AT_ONE_PLACE", message: "Another number already calls for that place. Move it first." };
    }
    await sql`
      UPDATE calling_numbers SET scope_node_id = ${input.nodeId}, active = ${input.nodeId !== null}, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${input.numberId}`;
    return { ok: true, message: input.nodeId ? "Saved. Calls there now go out from this number." : "This number is no longer used." };
  });
  if (out.ok) {
    await audit({ orgId, actorUserId: input.userId, action: "calling.number_placed", targetType: "calling_number", targetId: input.numberId, metadata: { nodeId: input.nodeId } });
  }
  return out;
}

/**
 * Give a number back to Vobiz. Vobiz first: a row marked released while
 * Vobiz still bills it would be rent nobody sees. The row stays, because
 * calls name the number they went from.
 */
export async function releaseCallingNumber(input: { orgId: string; userId: string; numberId: string }): Promise<Outcome> {
  const { orgId } = input;
  if (!isNodeId(input.numberId)) return { ok: false, code: "GONE", message: "That number is no longer yours." };
  const [row] = await withTenant(orgId, (sql) => sql<{ number: string }[]>`
    SELECT number FROM calling_numbers WHERE org_id = ${orgId} AND id = ${input.numberId} AND released_at IS NULL`);
  if (!row) return { ok: false, code: "GONE", message: "That number is no longer yours." };
  const cfg = vobizConfig();
  const driver = vobiz();
  if (!cfg || !driver.releaseNumber) return { ok: false, code: "OFF", message: "Releasing a number isn't switched on yet." };
  try {
    await driver.releaseNumber(cfg, row.number);
  } catch (e) {
    console.warn(`calling numbers: release failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, code: "REFUSED", message: "Our phone provider did not take the number back. Try again in a minute." };
  }
  await withTenant(orgId, (sql) => sql`
    UPDATE calling_numbers
    SET active = false, scope_node_id = NULL, released_at = now(), released_by = ${input.userId}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${input.numberId} AND released_at IS NULL`);
  await audit({ orgId, actorUserId: input.userId, action: "calling.number_released", targetType: "calling_number", targetId: input.numberId, metadata: { number: auditHash(row.number) } });
  return { ok: true, message: "Released. Calls no longer go out from it." };
}

// ---------------------------------------------------------------------------
// The tenant's own Sarvam connection
// ---------------------------------------------------------------------------

/**
 * Record which of our Sarvam workspace's connections dials from this
 * number, or clear it. When Sarvam is configured the id is asked of Sarvam
 * first, and one it does not know, or that does not carry this number, is
 * refused; an answer that never came refuses too, because a wrong id would
 * make every call from the number fail.
 */
export async function linkSarvamConnection(input: { orgId: string; userId: string; numberId: string; raw: string }): Promise<Outcome> {
  const { orgId } = input;
  if (!isNodeId(input.numberId)) return { ok: false, code: "GONE", message: "That number is no longer yours." };
  const read = readConnectionId(input.raw);
  if (!read.ok) return { ok: false, code: "INVALID", message: read.message };
  const [row] = await withTenant(orgId, (sql) => sql<{ number: string; sarvam_connection_id: string | null }[]>`
    SELECT number, sarvam_connection_id FROM calling_numbers WHERE org_id = ${orgId} AND id = ${input.numberId} AND released_at IS NULL`);
  if (!row) return { ok: false, code: "GONE", message: "That number is no longer yours." };
  if (row.sarvam_connection_id === read.value) return { ok: true, message: "Nothing changed." };

  if (read.value) {
    const cfg = sarvamConfig();
    const driver = sarvam();
    if (cfg.ok && driver.getConnection) {
      let found: { exists: boolean; numbers: string[] | null };
      try {
        found = await driver.getConnection(cfg.config, read.value);
      } catch (e) {
        console.warn(`calling numbers: Sarvam connection check failed: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false, code: "UNREACHABLE", message: "We couldn't reach Sarvam to check that connection. Try again in a minute." };
      }
      const problem = connectionProblem(found, row.number);
      if (problem) return { ok: false, code: "UNKNOWN_CONNECTION", message: problem };
    }
  }

  await withTenant(orgId, (sql) => sql`
    UPDATE calling_numbers SET sarvam_connection_id = ${read.value}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${input.numberId} AND released_at IS NULL`);
  await audit({
    orgId,
    actorUserId: input.userId,
    action: "calling.number_connection",
    targetType: "calling_number",
    targetId: input.numberId,
    // The id names a Sarvam object of ours, never a person, so it is kept whole.
    metadata: { connection: read.value, cleared: read.value === null },
  });
  return { ok: true, message: read.value ? "Saved. Calls from this number now dial through that connection." : "Cleared. Calls from this number dial through ours." };
}

// ---------------------------------------------------------------------------
// A number's month, metered
// ---------------------------------------------------------------------------

/**
 * One PHONE_NUMBER usage row per number per IST month it was held, at the
 * cost frozen on the number. Idempotent on the number and the month, so the
 * billing sweep runs it every pass; this month and the last are asked, so a
 * sweep missed at the turn of a month is caught by the next. Returns how
 * many months were asked.
 */
export async function meterCallingNumbers(orgId: string, nowIso = new Date().toISOString()): Promise<number> {
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; rented_at: Date; released_at: Date | null; monthly_cost_paise: number; scope_node_id: string | null }[]>`
    SELECT id, rented_at, released_at, monthly_cost_paise, scope_node_id FROM calling_numbers
    WHERE org_id = ${orgId} AND (released_at IS NULL OR released_at > ${nowIso}::timestamptz - interval '62 days')`);
  const due = numberMonthsDue(
    rows.map((r) => ({ id: r.id, rentedAt: r.rented_at.toISOString(), releasedAt: r.released_at?.toISOString() ?? null, costPaise: r.monthly_cost_paise, nodeId: r.scope_node_id })),
    nowIso,
  );
  for (const m of due) {
    await meterQuietly({
      orgId,
      nodeId: m.nodeId,
      kind: "PHONE_NUMBER",
      qty: 1,
      costPaise: m.costPaise,
      billable: true,
      source: { kind: "calling_number", id: m.sourceId },
      atIso: m.atIso,
    });
  }
  return due.length;
}
