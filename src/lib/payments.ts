import { hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { audit, withNoTenant, withTenant } from "./db/index.ts";
import { open, seal, vaultConfigured } from "./vault.ts";
import { paymentPurpose } from "./vault-rules.ts";
import { signPayState, readPayState, type PayState } from "./quote-rules.ts";

/**
 * The developer's own Razorpay account, connected through Razorpay's
 * partner sign-in, and the one seam every request to it goes through.
 *
 * Sales Desk never collects a token: the developer's account makes the
 * link and the money settles to them. Under the RBI's Master Direction on
 * payment aggregators (15 September 2025) an entity that collects and passes
 * on funds needs authorisation, and one that only provides the technology
 * does not. So there is no Sales Desk key here and no fallback to one.
 *
 * Built and proven against a fake (`usePayments()`); Sales Desk is not yet a
 * Razorpay technology partner, so nothing here has run against Razorpay.
 * `RAZORPAY_API_BASE` and `RAZORPAY_AUTH_BASE` are the checks' seams.
 */

export type LinkRequest = {
  amountPaise: number;
  reference: string;
  description: string;
  /** When the link stops working. */
  expireBy: string;
  customer: { name: string; contact: string };
};

export type GatewayLink = { id: string; shortUrl: string; status: string };

export type RefundRequest = { paymentId: string; amountPaise: number; receipt: string };
export type GatewayRefund = { id: string; status: string; amountPaise: number };

export type Tokens = { accessToken: string; refreshToken: string; expiresAt: string; accountId: string; mode: "test" | "live" };

export interface PaymentsDriver {
  createLink(token: string, req: LinkRequest): Promise<GatewayLink>;
  /** A link made under this reference, so a lost answer is found rather than made twice. */
  findLink(token: string, reference: string): Promise<GatewayLink | null>;
  cancelLink(token: string, id: string): Promise<void>;
  /**
   * Give a payment back, in part or whole. `receipt` names the quote and is
   * sent as the idempotency key too, so a retry cannot refund twice.
   */
  refund(token: string, req: RefundRequest): Promise<GatewayRefund>;
  /** A refund already made on this payment under this receipt, so a lost answer is found rather than made twice. */
  findRefund(token: string, paymentId: string, receipt: string): Promise<GatewayRefund | null>;
  exchange(code: string, redirectUri: string): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
}

let injected: PaymentsDriver | null = null;

/** For the checks: a gateway that never leaves the machine. */
export function usePayments(d: PaymentsDriver | null): void {
  injected = d;
}

export function payments(): PaymentsDriver {
  return injected ?? razorpay;
}

const API = () => (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/+$/, "");
const AUTH = () => (process.env.RAZORPAY_AUTH_BASE || "https://auth.razorpay.com").replace(/\/+$/, "");
const TIMEOUT_MS = 20_000;

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!res.ok) throw new Error(`Razorpay ${res.status}: ${body.error?.description ?? "refused"}`.slice(0, 300));
  return body;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

type RzpLink = { id: string; short_url: string; status: string };
type RzpRefund = { id: string; status: string; amount: number; receipt?: string | null };
type RzpToken = { access_token: string; refresh_token: string; expires_in: number; razorpay_account_id: string; token_type?: string };

const razorpay: PaymentsDriver = {
  async createLink(token, req) {
    const l = await call<RzpLink>(`${API()}/v1/payment_links`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        amount: req.amountPaise,
        currency: "INR",
        accept_partial: false,
        expire_by: Math.floor(Date.parse(req.expireBy) / 1000),
        reference_id: req.reference,
        description: req.description.slice(0, 2048),
        customer: { name: req.customer.name.slice(0, 100), contact: req.customer.contact },
        notify: { sms: false, email: false },
        reminder_enable: false,
      }),
    });
    return { id: l.id, shortUrl: l.short_url, status: l.status };
  },
  async findLink(token, reference) {
    const r = await call<{ payment_links?: RzpLink[] }>(`${API()}/v1/payment_links?reference_id=${encodeURIComponent(reference)}`, {
      method: "GET",
      headers: bearer(token),
    });
    const l = r.payment_links?.[0];
    return l ? { id: l.id, shortUrl: l.short_url, status: l.status } : null;
  },
  async cancelLink(token, id) {
    await call(`${API()}/v1/payment_links/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: bearer(token) });
  },
  async refund(token, req) {
    const r = await call<RzpRefund>(`${API()}/v1/payments/${encodeURIComponent(req.paymentId)}/refund`, {
      method: "POST",
      headers: { ...bearer(token), "x-refund-idempotency": req.receipt },
      body: JSON.stringify({ amount: req.amountPaise, speed: "normal", receipt: req.receipt }),
    });
    return { id: r.id, status: r.status, amountPaise: r.amount };
  },
  async findRefund(token, paymentId, receipt) {
    const r = await call<{ items?: RzpRefund[] }>(`${API()}/v1/payments/${encodeURIComponent(paymentId)}/refunds?count=100`, {
      method: "GET",
      headers: bearer(token),
    });
    const f = r.items?.find((x) => x.receipt === receipt);
    return f ? { id: f.id, status: f.status, amountPaise: f.amount } : null;
  },
  async exchange(code, redirectUri) {
    return tokensOf(await call<RzpToken>(`${AUTH()}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.RAZORPAY_PARTNER_CLIENT_ID,
        client_secret: process.env.RAZORPAY_PARTNER_CLIENT_SECRET,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
        mode: liveMode() ? "live" : "test",
      }),
    }));
  },
  async refresh(refreshToken) {
    return tokensOf(await call<RzpToken>(`${AUTH()}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.RAZORPAY_PARTNER_CLIENT_ID,
        client_secret: process.env.RAZORPAY_PARTNER_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    }));
  },
};

function tokensOf(t: RzpToken): Tokens {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: new Date(Date.now() + (t.expires_in || 7_776_000) * 1000).toISOString(),
    accountId: t.razorpay_account_id,
    mode: liveMode() ? "live" : "test",
  };
}

/** Live mode only on a production host, the rule the billing keys follow. */
const liveMode = () => process.env.RAZORPAY_PARTNER_MODE === "live" && (process.env.NODE_ENV === "production" || !!process.env.VERCEL);

/** Whether connecting can happen here at all. */
export function paymentsReady(): boolean {
  return !!(process.env.RAZORPAY_PARTNER_CLIENT_ID && process.env.RAZORPAY_PARTNER_CLIENT_SECRET && vaultConfigured() && process.env.AUTH_SECRET) || !!injected;
}

function stateKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(process.env.AUTH_SECRET ?? ""), Buffer.alloc(0), Buffer.from("salesdesk/payments-state"), 32));
}

export const STATE_SECONDS = 600;

/** Where Razorpay's sign-in starts, and the nonce the browser keeps. */
export function beginPayConnect(o: { orgId: string; userId: string; redirectUri: string; nowMs?: number }): { url: string; nonce: string } {
  const nonce = randomBytes(18).toString("base64url");
  const state = signPayState({ o: o.orgId, u: o.userId, n: nonce, e: Math.floor((o.nowMs ?? Date.now()) / 1000) + STATE_SECONDS }, stateKey());
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.RAZORPAY_PARTNER_CLIENT_ID ?? "",
    redirect_uri: o.redirectUri,
    scope: "read_write",
    state,
  });
  return { url: `${AUTH()}/authorize?${q}`, nonce };
}

export function readPayConnect(raw: string | null, expect: { nonce: string | null; userId: string }): PayState | null {
  return readPayState(raw, stateKey(), { ...expect, now: new Date() });
}

export type PaymentAccount = { id: string; accountId: string; mode: string; status: string; connectedAt: string };

export async function paymentAccount(orgId: string): Promise<PaymentAccount | null> {
  const [a] = await withTenant(orgId, (sql) => sql<{ id: string; account_id: string; mode: string; status: string; connected_at: Date }[]>`
    SELECT id, account_id, mode, status, connected_at FROM payment_accounts
    WHERE org_id = ${orgId} AND status <> 'DISCONNECTED' ORDER BY connected_at DESC LIMIT 1`);
  return a ? { id: a.id, accountId: a.account_id, mode: a.mode, status: a.status, connectedAt: a.connected_at.toISOString() } : null;
}

const purpose = paymentPurpose;

/** Store what Razorpay handed back for this organisation, sealed. */
export async function savePaymentAccount(o: { orgId: string; userId: string; tokens: Tokens }): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!/^acc_[A-Za-z0-9]{6,30}$/.test(o.tokens.accountId)) return { ok: false, message: "Razorpay did not say which account this is." };
  const [taken] = await withNoTenant((sql) => sql<{ org_id: string }[]>`SELECT org_id FROM payment_account_owner(${o.tokens.accountId})`);
  if (taken && taken.org_id !== o.orgId) return { ok: false, message: "That Razorpay account is connected to another organisation." };
  const id = randomUUID();
  const sealed = await seal(o.orgId, purpose(id), JSON.stringify({ a: o.tokens.accessToken, r: o.tokens.refreshToken, x: o.tokens.expiresAt }));
  if (!sealed) return { ok: false, message: "Connecting is not switched on here." };
  await withTenant(o.orgId, async (sql) => {
    await sql`UPDATE payment_accounts SET status = 'DISCONNECTED', secret = NULL, key_version = NULL, updated_at = now()
              WHERE org_id = ${o.orgId} AND status <> 'DISCONNECTED'`;
    await sql`
      INSERT INTO payment_accounts (id, org_id, account_id, mode, secret, key_version, connected_by)
      VALUES (${id}, ${o.orgId}, ${o.tokens.accountId}, ${o.tokens.mode}, ${sealed.secret}, ${sealed.keyVersion}, ${o.userId})`;
  });
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "payments.connected", targetType: "payment_account", targetId: id, metadata: { mode: o.tokens.mode } });
  return { ok: true };
}

export async function disconnectPayments(o: { orgId: string; userId: string }): Promise<boolean> {
  const r = await withTenant(o.orgId, (sql) => sql<{ id: string }[]>`
    UPDATE payment_accounts SET status = 'DISCONNECTED', secret = NULL, key_version = NULL, updated_at = now()
    WHERE org_id = ${o.orgId} AND status <> 'DISCONNECTED' RETURNING id`);
  if (r.length) await audit({ orgId: o.orgId, actorUserId: o.userId, action: "payments.disconnected", targetType: "payment_account", targetId: r[0].id });
  return r.length > 0;
}

/**
 * The account's token, refreshed when it has a day or less left. Null when
 * nothing is connected, or the token no longer opens: that account is then
 * BROKEN and the screen asks for it to be connected again.
 */
export async function paymentToken(orgId: string): Promise<{ accountRowId: string; token: string } | null> {
  const [a] = await withTenant(orgId, (sql) => sql<{ id: string; secret: Buffer | null }[]>`
    SELECT id, secret FROM payment_accounts WHERE org_id = ${orgId} AND status = 'ACTIVE' ORDER BY connected_at DESC LIMIT 1`);
  if (!a) return null;
  const raw = await open(orgId, purpose(a.id), a.secret);
  const t = raw ? (JSON.parse(raw) as { a: string; r: string; x: string }) : null;
  if (!t) return null;
  if (Date.parse(t.x) - Date.now() > 86_400_000) return { accountRowId: a.id, token: t.a };
  try {
    const fresh = await payments().refresh(t.r);
    const sealed = await seal(orgId, purpose(a.id), JSON.stringify({ a: fresh.accessToken, r: fresh.refreshToken, x: fresh.expiresAt }));
    if (!sealed) return null;
    await withTenant(orgId, (sql) => sql`UPDATE payment_accounts SET secret = ${sealed.secret}, key_version = ${sealed.keyVersion}, updated_at = now() WHERE org_id = ${orgId} AND id = ${a.id}`);
    return { accountRowId: a.id, token: fresh.accessToken };
  } catch {
    await withTenant(orgId, (sql) => sql`UPDATE payment_accounts SET status = 'BROKEN', updated_at = now() WHERE org_id = ${orgId} AND id = ${a.id}`);
    return null;
  }
}

/** The tenant a webhook's account belongs to: the one read across tenants, ids only. */
export async function ownerOfAccount(accountId: string): Promise<string | null> {
  const [r] = await withNoTenant((sql) => sql<{ org_id: string }[]>`SELECT org_id FROM payment_account_owner(${accountId})`);
  return r?.org_id ?? null;
}
