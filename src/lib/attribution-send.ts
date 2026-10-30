import { randomUUID } from "node:crypto";
import { audit, withTenant } from "./db/index.ts";
import { listConnections, markBroken, tokenFor, type AccountView, type ConnectionView } from "./connect.ts";
import { accountsFor, GOOGLE_DATA_MANAGER_SCOPE, type PlatformError } from "./connect-rules.ts";
import { metaConfigured, sendMetaOutcome } from "./meta.ts";
import { ensureConversionAction, googleDataManagerEnabled, ingestOutcome } from "./google.ts";
import {
  GOOGLE_ACTIONS,
  MAX_UPLOAD_ATTEMPTS,
  MAX_UPLOADS_PER_PASS,
  eventTime,
  googleIngestBody,
  googlePhoneHash,
  metaEventJson,
  metaPhoneHash,
  planUpload,
  resendLost,
  retryDelayMs,
  valueOf,
  type OutcomeKind,
  type OutcomeLineage,
  type Platform,
  type Reason,
  type Values,
} from "./attribution-rules.ts";
import { valuesFor } from "./attribution.ts";
import type { R } from "./platform.ts";

/**
 * The uploader: sending outcomes to Meta and Google from the lead worker.
 *
 * Each upload is claimed under a lease, decided again with everything as it
 * stands now (consent, an opt-out, a cancellation, the account, the clock),
 * marked as tried BEFORE the request goes out, and marked sent only when the
 * platform said so. A send whose answer was lost is therefore visible on the
 * next pass as tried and not sent, and is sent again with the same id:
 * always to Google, which treats a repeated transaction id as the same
 * conversion, and to Meta only inside the 48 hours it documents a dedupe for.
 *
 * It never asks the RERA gate. A phase that stopped being advertisable halts
 * the publisher, not this: telling a platform what already-spent money became
 * is reporting, not advertising.
 */

/** A worker that dies holds its uploads this long. */
const LEASE_MS = 5 * 60_000;
/** An upload waiting on setup is looked at again after this. */
const SETUP_WAIT_MS = 60 * 60_000;
/** A new Google conversion action refuses uploads for its first hours. */
const NEW_ACTION_WAIT_MS = 6 * 60 * 60_000;

type Claimed = {
  id: string;
  platform: Platform;
  attempts: number;
  tried_at: Date | null;
  not_before: Date;
  event_id: string;
  kind: OutcomeKind;
  occurred_at: Date;
  value: number;
  lineage: OutcomeLineage;
  booking_id: string | null;
  publish_target_id: string | null;
  node_path: string;
  target_account: string | null;
  phone: string;
  lead_created: Date;
  cancelled: boolean;
  consented: boolean;
  opted_out: boolean;
};

type Update = {
  state: "WAITING" | "QUEUED" | "SENT" | "NOT_SENT" | "FAILED";
  reason?: Reason | null;
  notBefore?: Date;
  error?: string | null;
  accountId?: string | null;
};

async function claim(orgId: string, now: Date, max: number): Promise<Claimed[]> {
  const lease = randomUUID();
  return withTenant(orgId, async (sql) => {
    const ids = await sql<{ id: string }[]>`
      UPDATE outcome_uploads SET state = 'SENDING', lease_id = ${lease}, lease_until = ${new Date(now.getTime() + LEASE_MS)}, updated_at = now()
      WHERE id IN (
        SELECT id FROM outcome_uploads
        WHERE org_id = ${orgId}
          AND ((state IN ('QUEUED', 'WAITING') AND not_before <= ${now}) OR (state = 'SENDING' AND lease_until < ${now}))
        ORDER BY not_before LIMIT ${max}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    if (!ids.length) return [];
    return sql<Claimed[]>`
      SELECT u.id, u.platform, u.attempts, u.tried_at, u.not_before,
             e.id AS event_id, e.kind, e.occurred_at, e.value, e.lineage, e.booking_id, e.publish_target_id,
             n.path::text AS node_path, t.account_id AS target_account,
             l.phone, l.created_at AS lead_created,
             EXISTS (SELECT 1 FROM outcome_events c WHERE c.org_id = e.org_id AND c.kind = 'CANCELLED'
                       AND c.booking_id = CASE WHEN e.kind = 'BOOKED' THEN e.id ELSE e.booking_id END) AS cancelled,
             EXISTS (SELECT 1 FROM lead_consents k WHERE k.org_id = e.org_id AND k.phone = l.phone
                       AND 'ad_measurement' = ANY(k.channels) AND (k.expires_at IS NULL OR k.expires_at > now())) AS consented,
             EXISTS (SELECT 1 FROM call_suppressions s WHERE s.org_id = e.org_id AND s.phone = l.phone) AS opted_out
      FROM outcome_uploads u
      JOIN outcome_events e ON e.id = u.event_id
      JOIN leads l ON l.id = e.lead_id
      JOIN scope_nodes n ON n.id = e.scope_node_id
      LEFT JOIN publish_targets t ON t.id = e.publish_target_id
      WHERE u.org_id = ${orgId} AND u.lease_id = ${lease}`;
  });
}

async function settle(orgId: string, id: string, u: Update): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    UPDATE outcome_uploads SET
      state = ${u.state},
      reason = ${u.reason ?? null},
      not_before = coalesce(${u.notBefore ?? null}, not_before),
      error = ${u.error === undefined ? sql`error` : u.error?.slice(0, 300) ?? null},
      account_id = ${u.accountId === undefined ? sql`account_id` : u.accountId},
      sent_at = ${u.state === "SENT" ? new Date() : null},
      lease_id = NULL, lease_until = NULL, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${id}`);
}

type Destination =
  | { ok: true; account: AccountView; connection: ConnectionView }
  | { ok: false; reason: "NOT_CONNECTED" | "NEEDS_RECONNECT" | "NOT_SWITCHED_ON" };

/**
 * Where an outcome goes. Meta: the dataset at or above the lead's tower.
 * Google: the Ads account the ad ran in when we published it, otherwise the
 * one at or above the tower.
 */
function destination(platform: Platform, c: Claimed, connections: ConnectionView[]): Destination {
  if (platform === "META" && !metaConfigured()) return { ok: false, reason: "NOT_SWITCHED_ON" };
  if (platform === "GOOGLE" && !googleDataManagerEnabled()) return { ok: false, reason: "NOT_SWITCHED_ON" };
  const all = connections
    .filter((x) => x.provider === platform)
    .flatMap((x) => x.accounts.map((a) => ({ ...a, connection: x })));
  const kind = platform === "META" ? "META_DATASET" : "GOOGLE_ADS_CUSTOMER";
  const pinned = platform === "GOOGLE" && c.target_account ? all.find((a) => a.id === c.target_account && a.kind === kind && a.active) : undefined;
  const a = pinned ?? accountsFor(all, c.node_path).get(kind);
  if (!a) return { ok: false, reason: "NOT_CONNECTED" };
  if (a.connection.status !== "CONNECTED") return { ok: false, reason: "NEEDS_RECONNECT" };
  if (platform === "GOOGLE" && !a.connection.scopes.includes(GOOGLE_DATA_MANAGER_SCOPE)) return { ok: false, reason: "NEEDS_RECONNECT" };
  const { connection, ...account } = a;
  return { ok: true, account, connection };
}

type SentKind = Exclude<OutcomeKind, "CANCELLED">;

/**
 * The Google conversion action for this outcome, and when it may first be
 * used. All five are made together the first time an account needs any, so
 * an account waits out a new action's first hours once rather than once per
 * outcome.
 */
async function actionFor(
  orgId: string,
  access: string,
  account: AccountView,
  kind: SentKind,
  values: Values,
): Promise<R<{ id: string; usableAt: Date }>> {
  const read = () =>
    withTenant(orgId, (sql) => sql<{ kind: SentKind; external_id: string; created_at: Date }[]>`
      SELECT kind, external_id, created_at FROM conversion_actions WHERE org_id = ${orgId} AND account_id = ${account.id}`);
  let have = await read();
  if (!have.some((a) => a.kind === kind)) {
    for (const k of Object.keys(GOOGLE_ACTIONS) as SentKind[]) {
      if (have.some((a) => a.kind === k)) continue;
      const def = GOOGLE_ACTIONS[k];
      const r = await ensureConversionAction({
        access,
        customerId: account.externalId,
        login: account.detail.login_customer_id ?? null,
        name: def.name,
        category: def.category,
        primary: def.primary,
        value: valueOf(k, values),
      });
      if (!r.ok) return r;
      // One found rather than made is as old as Google says; ours is new.
      const createdAt = r.value.created ? new Date() : new Date(0);
      await withTenant(orgId, (sql) => sql`
        INSERT INTO conversion_actions (org_id, account_id, kind, external_id, created_at)
        VALUES (${orgId}, ${account.id}, ${k}, ${r.value.id}, ${createdAt})
        ON CONFLICT (account_id, kind) DO NOTHING`);
    }
    have = await read();
  }
  const a = have.find((x) => x.kind === kind);
  if (!a) return { ok: false, code: "NOT_FOUND", retryable: true, message: "The conversion action could not be made." };
  return { ok: true, value: { id: a.external_id, usableAt: new Date(a.created_at.getTime() + NEW_ACTION_WAIT_MS) } };
}

/** A platform's refusal, as what happens to the upload next. */
function afterRefusal(e: PlatformError, attempts: number, now: Date): Update {
  if (e.code === "TOKEN_INVALID" || e.code === "PERMISSION" || e.code === "ACCESS_LEVEL") {
    return { state: "WAITING", reason: "NEEDS_RECONNECT", notBefore: new Date(now.getTime() + SETUP_WAIT_MS), error: e.message };
  }
  if (e.retryable && attempts < MAX_UPLOAD_ATTEMPTS) {
    return { state: "QUEUED", reason: null, notBefore: new Date(now.getTime() + retryDelayMs(attempts)), error: e.message };
  }
  return { state: "FAILED", reason: "REFUSED", error: e.message };
}

export type SendReport = { sent: number; waiting: number; notSent: number; failed: number };

/**
 * One bounded pass for one organisation. Safe to run twice at once: an
 * upload is claimed before it is looked at.
 */
export async function sendOutcomes(orgId: string, opts: { nowIso?: string; max?: number } = {}): Promise<SendReport> {
  const now = new Date(opts.nowIso ?? Date.now());
  const out: SendReport = { sent: 0, waiting: 0, notSent: 0, failed: 0 };
  const claimed = await claim(orgId, now, Math.min(opts.max ?? MAX_UPLOADS_PER_PASS, MAX_UPLOADS_PER_PASS));
  if (!claimed.length) return out;
  const [connections, values] = await Promise.all([
    listConnections(orgId, now),
    withTenant(orgId, (sql) => valuesFor(sql, orgId)),
  ]);

  const count = (u: Update) => {
    if (u.state === "SENT") out.sent += 1;
    else if (u.state === "NOT_SENT") out.notSent += 1;
    else if (u.state === "FAILED") out.failed += 1;
    else out.waiting += 1;
  };

  for (const c of claimed) {
    const u = await one(orgId, c, connections, values, now).catch(
      (e): Update => ({ state: "QUEUED", reason: null, notBefore: new Date(now.getTime() + retryDelayMs(c.attempts)), error: e instanceof Error ? e.message : String(e) }),
    );
    await settle(orgId, c.id, u);
    count(u);
  }
  if (out.sent || out.failed) {
    await audit({ orgId, actorUserId: null, action: "attribution.uploaded", targetType: "org", targetId: orgId, metadata: { ...out } });
  }
  return out;
}

async function one(orgId: string, c: Claimed, connections: ConnectionView[], values: Values, now: Date): Promise<Update> {
  const where = destination(c.platform, c, connections);
  const plan = planUpload({
    platform: c.platform,
    kind: c.kind,
    occurredAt: c.occurred_at.toISOString(),
    leadCreatedAt: c.lead_created.toISOString(),
    lineage: c.lineage,
    consented: c.consented,
    optedOut: c.opted_out,
    connected: where.ok,
    cancelled: c.cancelled,
    holdDays: values.holdDays,
    nowIso: now.toISOString(),
    notBefore: c.not_before.toISOString(),
  });
  if (plan.state === "NOT_SENT") return { state: "NOT_SENT", reason: plan.reason };
  if (plan.state === "WAITING") {
    if (plan.reason === "HELD") return { state: "WAITING", reason: "HELD" };
    return { state: "WAITING", reason: where.ok ? plan.reason : where.reason, notBefore: new Date(now.getTime() + SETUP_WAIT_MS) };
  }
  if (!where.ok) return { state: "WAITING", reason: where.reason, notBefore: new Date(now.getTime() + SETUP_WAIT_MS) };

  // A send whose answer never came back.
  if (c.tried_at && !resendLost(c.platform, c.tried_at.toISOString(), now.toISOString())) {
    return { state: "FAILED", reason: "NO_ANSWER", error: "Sent, and the platform never confirmed it." };
  }
  if (c.attempts >= MAX_UPLOAD_ATTEMPTS) return { state: "FAILED", reason: "REFUSED", error: "Refused five times." };

  const cred = await tokenFor(orgId, where.account.id);
  if (!cred.ok) {
    if (cred.code === "TOKEN_INVALID") await markBroken(orgId, where.connection.id, cred);
    return afterRefusal(cred, c.attempts, now);
  }

  const kind = c.kind as Exclude<OutcomeKind, "CANCELLED">;
  let actionId: string | null = null;
  if (c.platform === "GOOGLE") {
    const action = await actionFor(orgId, cred.token, where.account, kind, values);
    if (!action.ok) return afterRefusal(action, c.attempts, now);
    if (action.value.usableAt > now) {
      return { state: "WAITING", reason: "ACTION_NEW", notBefore: action.value.usableAt, accountId: where.account.id };
    }
    actionId = action.value.id;
  }

  // Tried, written down before the request leaves, so a lost answer is
  // known to be a lost answer on the next pass.
  await withTenant(orgId, (sql) => sql`
    UPDATE outcome_uploads SET tried_at = coalesce(tried_at, now()), attempts = attempts + 1, account_id = ${where.account.id}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${c.id}`);

  const at = eventTime(c.platform, c.kind, c.occurred_at.toISOString(), c.not_before.toISOString());
  const sent =
    c.platform === "META"
      ? await sendMetaOutcome(
          cred.token,
          where.account.externalId,
          metaEventJson({ id: c.event_id, kind: c.kind, eventTimeIso: at, value: c.value, lineage: c.lineage, phoneHash: metaPhoneHash(c.phone) })!,
        )
      : await ingestOutcome(
          cred.token,
          googleIngestBody({
            id: c.event_id,
            eventTimeIso: at,
            value: c.value,
            gclid: c.lineage.gclid!,
            phoneHash: googlePhoneHash(c.phone),
            customerId: where.account.externalId,
            loginCustomerId: where.account.detail.login_customer_id ?? null,
            actionId: actionId!,
          }),
        );
  if (!sent.ok) {
    if (sent.code === "TOKEN_INVALID") await markBroken(orgId, where.connection.id, sent);
    return afterRefusal(sent, c.attempts + 1, now);
  }
  return { state: "SENT", reason: null, error: null, accountId: where.account.id };
}
