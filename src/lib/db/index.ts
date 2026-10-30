import { createHash } from "node:crypto";
import postgres, { type TransactionSql, type JSONValue } from "postgres";

/**
 * Two connections, matching the two database roles.
 *
 *   controlDb   the OWNER role. Bypasses RLS. Used ONLY by the control plane:
 *               resolving an identity at sign-in and creating an org. Both
 *               happen before any tenant context exists, so they cannot be
 *               RLS-scoped. Every use of this client is a deliberate act.
 *
 *   withTenant  the APP role. RLS enforced. Opens a transaction, pins
 *               app.org_id for its duration, and hands you the scoped handle.
 *               All ordinary product traffic goes through here.
 *
 * The rule: if you are reaching for controlDb outside sign-in or org creation,
 * you are about to write a cross-tenant leak.
 */

declare global {
  // eslint-disable-next-line no-var
  var __salesdesk_control: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __salesdesk_app: ReturnType<typeof postgres> | undefined;
}

/**
 * On Vercel every warm instance holds its own pools, and the hosted database
 * allows 20 connections in all, about eight of them taken by the provider's
 * own sessions and the superuser reserve. Ten a pool filled it the first
 * morning the hosted app was used, and six an instance filled it again the
 * same hour with two instances up: every page failed with "too many clients
 * already". So a hosted instance keeps four, lets an idle one go within
 * seconds, and a transaction that could not get a connection waits and asks
 * again rather than failing the page (`beginRetrying()`). `DB_POOL_MAX`
 * overrides the size.
 */
const HOSTED = !!process.env.VERCEL;

/**
 * Whether a URL points at a connection pooler (PgBouncer in transaction
 * mode) rather than at Postgres itself. Behind one, thousands of client
 * connections share a few server ones, so the pool may be larger; but a
 * named prepared statement does not survive from one transaction to the
 * next, and a startup parameter the pooler does not know is refused.
 * Neon's pooled host carries "-pooler"; `DB_POOLED=1` says so for any other.
 */
function pooled(url: string): boolean {
  if (process.env.DB_POOLED === "1") return true;
  try {
    return new URL(url).hostname.includes("-pooler");
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function connect(url: string | undefined, label: string, hostedMax: number) {
  if (!url) throw new Error(`${label} is not set`);
  const viaPooler = pooled(url);
  // A development machine on a remote database (RDS since 3 October 2026).
  // Opening connections there is the slow part: several opened at once lose
  // their first packets and wait one to three seconds each (measured 4
  // October 2026: a query is 5 ms, four new connections together 3 s). So the
  // pool is kept open rather than let go every 20 seconds, which made every
  // page after a pause wait seconds, and a short keep-alive stops a router on
  // the way dropping a connection left idle (the ECONNRESET it was let go for).
  const remote = !HOSTED && !/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hostOf(url));
  return postgres(url, {
    max: Number(process.env.DB_POOL_MAX) || (HOSTED ? (viaPooler ? hostedMax * 2 : hostedMax) : 10),
    idle_timeout: HOSTED ? 5 : undefined,
    max_lifetime: HOSTED ? 5 * 60 : undefined,
    // Only when remote: an explicit undefined would switch postgres.js's own
    // 60-second keep-alive off everywhere else.
    ...(remote ? { keep_alive: 15 } : {}),
    // The dev server compiling a page can hold the event loop for many
    // seconds, and a connection timed out meanwhile fails the whole page.
    connect_timeout: remote ? 60 : undefined,
    prepare: !viaPooler,
    // A suspended instance runs no timers, so it cannot let its connections
    // go; the server does it for it after fifteen seconds idle. A pooler
    // holds the server connections itself, and refuses the parameter.
    connection: HOSTED && !viaPooler ? { idle_session_timeout: 15_000 } : undefined,
    onnotice: () => {},
  });
}

// Reused across hot reloads in dev so we don't exhaust the connection pool.
export const controlDb =
  globalThis.__salesdesk_control ??
  (globalThis.__salesdesk_control = connect(process.env.DATABASE_URL, "DATABASE_URL", 1));

const appDb =
  globalThis.__salesdesk_app ??
  (globalThis.__salesdesk_app = connect(
    process.env.DATABASE_APP_URL,
    "DATABASE_APP_URL",
    3,
  ));

/**
 * Errors that mean no statement of ours reached the database: every slot was
 * taken (53300), or the connection had already been closed under us, most
 * often by the server's idle timeout while this instance was suspended.
 */
const NEVER_RAN = new Set([
  "53300",
  "57P01",
  "57P05",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "ECONNRESET",
  "EPIPE",
  "CONNECT_TIMEOUT",
]);

/**
 * `appDb.begin()`, asked again when it failed before `fn` started.
 *
 * Only then: once `fn` is running it may already have written, or called
 * somebody else's API, and a second run could do either twice. Before it,
 * nothing of ours has run, so waiting a moment and asking again is safe, and
 * it turns a full database into a slower page rather than a broken one. Four
 * tries over about two seconds.
 */
async function beginRetrying<T>(
  open: (fn: (tx: TransactionSql) => Promise<T>) => Promise<unknown>,
  setup: (tx: TransactionSql) => Promise<unknown>,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let started = false;
    try {
      return (await open(async (tx) => {
        await setup(tx);
        started = true;
        return fn(tx);
      })) as T;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (started || attempt >= 4 || !code || !NEVER_RAN.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

/**
 * Close both pools.
 *
 * A long-running server never calls this. A script does: these pools are
 * module-level singletons, so importing anything that reaches the database
 * keeps Node's event loop alive after the last line has run, and a check
 * suite that has printed its results sits there forever instead of handing
 * back to the next one in `npm run check`.
 */
export async function closeDb(): Promise<void> {
  // A timeout, because end() without one waits for every connection to drain
  // on its own schedule and a pooled idle socket can keep it waiting. Five
  // seconds is far longer than any query a script has outstanding by the time
  // it gets here.
  await Promise.all([controlDb.end({ timeout: 5 }), appDb.end({ timeout: 5 })]);
  globalThis.__salesdesk_control = undefined;
  globalThis.__salesdesk_app = undefined;
}

/**
 * Run `fn` inside a transaction with RLS pinned to one tenant.
 *
 * set_config(..., true) is the parameterisable form of SET LOCAL, so the org
 * id is bound rather than interpolated, and it reverts when the transaction
 * ends -- a pooled connection can never leak tenant context to the next
 * checkout.
 */
export async function withTenant<T>(
  orgId: string,
  fn: (sql: TransactionSql) => Promise<T>,
): Promise<T> {
  return beginRetrying(
    (run) => appDb.begin((tx) => run(tx as TransactionSql)),
    (tx) => tx`SELECT set_config('app.org_id', ${orgId}, true)`,
    fn,
  );
}

/**
 * `withTenant()` for reading only, with a clock on every statement.
 *
 * Ask Jimmy builds its queries from a catalog rather than running what a
 * model wrote, so a write is impossible by construction; the transaction is
 * read-only anyway, because a second lock costs nothing. The timeout exists
 * because a question can ask for a year of calls grouped by day across every
 * tower, and one slow answer must not hold a pooled connection.
 */
export async function withTenantReadOnly<T>(
  orgId: string,
  fn: (sql: TransactionSql) => Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  return beginRetrying(
    (run) => appDb.begin("read only", (tx) => run(tx as TransactionSql)),
    (tx) => tx`SELECT set_config('app.org_id', ${orgId}, true), set_config('statement_timeout', ${String(timeoutMs)}, true)`,
    fn,
  );
}

/**
 * `withTenant()` with the person pinned too, for rows that belong to one
 * person inside a tenant (0030: a chat with Jimmy). A policy reading
 * `app_current_user()` sees nothing when this was not used, so a chat can
 * never be read by forgetting to ask whose it is.
 */
export async function withPerson<T>(
  orgId: string,
  userId: string,
  fn: (sql: TransactionSql) => Promise<T>,
): Promise<T> {
  return beginRetrying(
    (run) => appDb.begin((tx) => run(tx as TransactionSql)),
    (tx) => tx`SELECT set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`,
    fn,
  );
}

/**
 * Run `fn` as the app role with NO tenant pinned.
 *
 * Every policy fails closed here, so a query against a tenant table returns
 * nothing. It exists for the one kind of question that has no tenant yet: a
 * platform's callback that names an outside id and nothing else. Those are
 * answered by SECURITY DEFINER functions that return ids only (0023), and
 * this is the connection they are called on, so the answer is found without
 * reaching for the owner role.
 */
export async function withNoTenant<T>(fn: (sql: TransactionSql) => Promise<T>): Promise<T> {
  return beginRetrying(
    (run) => appDb.begin((tx) => run(tx as TransactionSql)),
    async () => undefined,
    fn,
  );
}

/**
 * An identifier belonging to a person never enters audit_log in the clear.
 *
 * The log is append-only for the application and expires only on its own
 * schedule, so anything written here outlives every erasure request. A hash
 * still answers the question the log exists for, which is "was this the same
 * one", without holding the value. The database refuses the obvious mistake
 * too: audit_log has a CHECK against an "@" in target_id.
 */
export function auditHash(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/** Append-only audit write. Never batched with business logic that may roll back. */
export async function audit(entry: {
  orgId: string | null;
  actorUserId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await controlDb`
    INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (
      ${entry.orgId}, ${entry.actorUserId}, ${entry.action},
      ${entry.targetType ?? null}, ${entry.targetId ?? null},
      ${controlDb.json((entry.metadata ?? {}) as JSONValue)}
    )
  `;
}
