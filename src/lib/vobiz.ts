/**
 * The one door to Vobiz's REST API, for the hand-off: find the buyer's live
 * call and redirect it to Sales Desk's ring instructions.
 *
 * The call itself is placed by Sarvam over our Vobiz connection, so we never
 * hear its Vobiz id. `findLiveCall()` finds it among the account's live calls
 * by the two numbers on it. An injected driver beats the real one, the way
 * `sarvam.ts` does for checks.
 */

import { toE164 } from "./handoff-rules.ts";
import { holdsNumber, linkedTo, readAvailable, sarvamVoiceApp, type Available } from "./calling-number-rules.ts";

export type VobizConfig = { authId: string; authToken: string };

export function vobizConfig(env: Record<string, string | undefined> = process.env): VobizConfig | null {
  const authId = env.VOBIZ_AUTH_ID?.trim();
  const authToken = env.VOBIZ_AUTH_TOKEN?.trim();
  return authId && authToken ? { authId, authToken } : null;
}

export type LiveCall = { uuid: string; from: string | null; to: string | null; status: string };

export type VobizDriver = {
  liveCalls(c: VobizConfig): Promise<LiveCall[]>;
  /** Point the buyer's leg at new instructions. Throws when Vobiz refuses. */
  transfer(c: VobizConfig, uuid: string, url: string): Promise<void>;
  /**
   * Ring a number from ours and run `answerUrl`'s instructions when it picks
   * up: the first leg of a call a person makes through our number. Throws
   * when Vobiz refuses.
   */
  makeCall(c: VobizConfig, call: OutboundCall): Promise<{ uuid: string }>;
  /**
   * Numbers that can be rented, starting with `pattern` (91 and an STD
   * code). Optional so a check that only places calls need not write it.
   */
  searchNumbers?(c: VobizConfig, q: { pattern: string; city: string | null; limit: number; kyc?: boolean }): Promise<Available[]>;
  /** Rent one number onto our account. Throws when Vobiz refuses. */
  /** How many numbers Vobiz holds starting `+<pattern>`. */
  countNumbers?(c: VobizConfig, pattern: string): Promise<number>;
  rentNumber?(c: VobizConfig, number: string): Promise<void>;
  /** Give one back. Throws when Vobiz refuses. */
  releaseNumber?(c: VobizConfig, number: string): Promise<void>;
  /**
   * Link a number to the voice app that hands its calls to Sarvam, so a
   * buyer ringing it reaches the agent. Throws when Vobiz refuses or the
   * link does not read back.
   */
  linkNumber?(c: VobizConfig, number: string): Promise<{ appId: string }>;
  /**
   * The account's most recent finished calls with the carrier's hang-up
   * cause, newest first. Optional so a check that only places calls need
   * not write it.
   */
  recentCalls?(c: VobizConfig, limit: number): Promise<CarrierCall[]>;
  /**
   * A sub-account in a client's own name, which must do its own KYC before
   * it may call. Its token is returned once.
   */
  createSubAccount?(c: VobizConfig, s: { name: string; email: string; businessType: string }): Promise<{ authId: string; authToken: string }>;
  /** Where a sub-account's KYC stands, as Vobiz answers it. */
  subAccountKyc?(c: VobizConfig, subAuthId: string): Promise<unknown>;
  /** A hosted KYC page for the sub-account, returning to `redirectUrl`. */
  kycSession?(c: VobizConfig, subAuthId: string, redirectUrl: string): Promise<{ url: string }>;
  /** Put a number of ours on a sub-account. Throws when Vobiz refuses. */
  assignToSub?(c: VobizConfig, number: string, subAuthId: string): Promise<void>;
  /**
   * One KYC document checked for a sub-account: `pan`, `gst` or `cin`. The
   * answer as Vobiz gives it; throws only when Vobiz could not be asked.
   */
  verifyDoc?(c: VobizConfig, subAuthId: string, doc: { kind: "pan"; pan: string } | { kind: "gst"; gstin: string } | { kind: "cin"; companyName: string; cin: string }): Promise<unknown>;
  /** DigiLocker's own page for the person's Aadhaar, and the request to finish later. */
  digilockerStart?(c: VobizConfig, subAuthId: string, redirectUrl: string, state: string): Promise<{ url: string; requestId: string }>;
  digilockerFinish?(c: VobizConfig, subAuthId: string, requestId: string): Promise<unknown>;
  deleteSubAccount?(c: VobizConfig, subAuthId: string): Promise<void>;
};

/** One finished call as the carrier recorded it. */
export type CarrierCall = {
  from: string | null;
  to: string | null;
  startedIso: string | null;
  cause: string | null;
  /** Who ended it, as Vobiz says it: "Caller", "Callee", "Answer XML" (our instructions), "Carrier". */
  source: string | null;
  ringSeconds: number | null;
};

export type OutboundCall = {
  /** Our number, E.164. */
  from: string;
  /** Who is rung first, E.164. */
  to: string;
  answerUrl: string;
  hangupUrl: string;
  /** Seconds; Vobiz ends the call there. */
  timeLimit: number;
};

const BASE = "https://api.vobiz.ai/api/v1/Account";
const API = "https://api.vobiz.ai/api/v1";
const headers = (c: VobizConfig) => ({ "X-Auth-ID": c.authId, "X-Auth-Token": c.authToken, "Content-Type": "application/json" });

const realDriver: VobizDriver = {
  async liveCalls(c) {
    const res = await fetch(`${BASE}/${c.authId}/Call/?status=live`, { headers: headers(c), signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Vobiz ${res.status} listing live calls`);
    const { calls = [] } = (await res.json()) as { calls?: string[] };
    const found = await Promise.all(
      calls.slice(0, 50).map(async (uuid) => {
        const r = await fetch(`${BASE}/${c.authId}/Call/${encodeURIComponent(uuid)}/?status=live`, {
          headers: headers(c),
          signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { call_uuid?: string; from?: string; to?: string; call_status?: string };
        return { uuid: j.call_uuid ?? uuid, from: toE164(j.from), to: toE164(j.to), status: j.call_status ?? "" };
      }),
    );
    return found.filter((x): x is LiveCall => x !== null);
  },

  async transfer(c, uuid, url) {
    const res = await fetch(`${BASE}/${c.authId}/Call/${encodeURIComponent(uuid)}/`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ legs: "aleg", aleg_url: url, aleg_method: "POST" }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Vobiz ${res.status} transferring the call: ${(await res.text()).slice(0, 200)}`);
  },

  // POST /Account/{auth_id}/Call/ (https://vobiz.ai/docs/call/make-call).
  // Vobiz takes numbers without the plus.
  async makeCall(c, call) {
    const res = await fetch(`${BASE}/${c.authId}/Call/`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({
        from: call.from.replace(/^\+/, ""),
        to: call.to.replace(/^\+/, ""),
        answer_url: call.answerUrl,
        answer_method: "POST",
        hangup_url: call.hangupUrl,
        hangup_method: "POST",
        time_limit: call.timeLimit,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Vobiz ${res.status} placing the call: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { request_uuid?: string };
    if (!body.request_uuid) throw new Error("Vobiz accepted the call and returned no id.");
    return { uuid: body.request_uuid };
  },

  // Vobiz's number API, read against the live API on 11 October 2026: the
  // inventory is searched by a substring of the E.164 number, a number is
  // bought out of it with its E.164 and the currency, and it is released by
  // its E.164, plus-encoded, in the path.
  async searchNumbers(c, q) {
    const params = new URLSearchParams({ country: "IN", search: `+${q.pattern}`, page: "1", per_page: "100" });
    const res = await fetch(`${BASE}/${c.authId}/inventory/numbers?${params}`, { headers: headers(c), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Vobiz ${res.status} searching numbers: ${(await res.text()).slice(0, 200)}`);
    return readAvailable(await res.json(), q.pattern, q.limit, { kyc: q.kyc });
  },

  async countNumbers(c, pattern) {
    const params = new URLSearchParams({ country: "IN", search: `+${pattern}`, page: "1", per_page: "1" });
    const res = await fetch(`${BASE}/${c.authId}/inventory/numbers?${params}`, { headers: headers(c), signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`Vobiz ${res.status} counting numbers`);
    const total = ((await res.json()) as { total?: unknown }).total;
    return typeof total === "number" && total > 0 ? total : 0;
  },

  async rentNumber(c, number) {
    const res = await fetch(`${BASE}/${c.authId}/numbers/purchase-from-inventory`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ e164: number, currency: "INR" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Vobiz ${res.status} renting the number: ${(await res.text()).slice(0, 200)}`);
    // The purchase's own answer is not documented, so the number is looked
    // for among the account's own before it counts as ours.
    const own = await fetch(`${BASE}/${c.authId}/numbers?${new URLSearchParams({ page: "1", per_page: "100" })}`, {
      headers: headers(c),
      signal: AbortSignal.timeout(10_000),
    });
    if (!own.ok) throw new Error(`Vobiz ${own.status} reading our numbers after renting`);
    if (!holdsNumber(await own.json(), number)) throw new Error("Vobiz did not confirm the number.");
  },

  async releaseNumber(c, number) {
    const res = await fetch(`${BASE}/${c.authId}/numbers/${encodeURIComponent(number)}`, {
      method: "DELETE",
      headers: headers(c),
      signal: AbortSignal.timeout(10_000),
    });
    // A number Vobiz no longer holds for us is already released.
    if (!res.ok && res.status !== 404) throw new Error(`Vobiz ${res.status} releasing the number: ${(await res.text()).slice(0, 200)}`);
  },

  // `POST numbers/<E.164>/application` is not in Vobiz's published API; it
  // was found and proven on 24 October 2026 (it answers 204), so the link is
  // read back from the account's own list before it counts.
  async linkNumber(c, number) {
    const apps = await fetch(`${BASE}/${c.authId}/Application/?limit=100`, { headers: headers(c), signal: AbortSignal.timeout(10_000) });
    if (!apps.ok) throw new Error(`Vobiz ${apps.status} listing voice apps`);
    const appId = sarvamVoiceApp(await apps.json(), process.env.VOBIZ_APP_ID?.trim() || null);
    if (!appId) throw new Error("No single Vobiz voice app hands calls to Sarvam. Set VOBIZ_APP_ID.");
    const res = await fetch(`${BASE}/${c.authId}/numbers/${encodeURIComponent(number)}/application`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ application_id: appId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Vobiz ${res.status} linking the number: ${(await res.text()).slice(0, 200)}`);
    const own = await fetch(`${BASE}/${c.authId}/numbers?${new URLSearchParams({ page: "1", per_page: "100" })}`, {
      headers: headers(c),
      signal: AbortSignal.timeout(10_000),
    });
    if (!own.ok || !linkedTo(await own.json(), number, appId)) throw new Error("Vobiz did not confirm the link.");
    return { appId };
  },

  // Sub-accounts and their KYC (docs: /docs/sub-accounts, /docs/sub-accounts/kyc).
  async createSubAccount(c, s) {
    const res = await fetch(`${API}/accounts/${c.authId}/sub-accounts/`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ name: s.name.slice(0, 100), email: s.email, kyc_mode: "customer_use", business_type: s.businessType, enabled: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Vobiz ${res.status} creating a sub-account: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { auth_credentials?: { auth_id?: unknown; auth_token?: unknown } };
    const authId = j.auth_credentials?.auth_id;
    const authToken = j.auth_credentials?.auth_token;
    if (typeof authId !== "string" || typeof authToken !== "string") throw new Error("Vobiz did not return the sub-account's credentials.");
    return { authId, authToken };
  },

  async subAccountKyc(c, subAuthId) {
    const res = await fetch(`${API}/sub-accounts/${encodeURIComponent(subAuthId)}/kyc/status`, { headers: headers(c), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Vobiz ${res.status} reading KYC`);
    return res.json();
  },

  async kycSession(c, subAuthId, redirectUrl) {
    const res = await fetch(`${API}/sub-accounts/${encodeURIComponent(subAuthId)}/kyc-sessions`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ account_auth_id: subAuthId, flow_type: "redirect", redirect_url: redirectUrl, expires_in_days: 7 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Vobiz ${res.status} starting KYC: ${(await res.text()).slice(0, 200)}`);
    const url = ((await res.json()) as { widget_url?: unknown }).widget_url;
    if (typeof url !== "string" || !/^https:\/\/kyc\.vobiz\.ai\//.test(url)) throw new Error("Vobiz did not return a KYC page.");
    return { url };
  },

  async assignToSub(c, number, subAuthId) {
    const res = await fetch(`${API}/account/${c.authId}/numbers/${encodeURIComponent(number)}/assign-subaccount`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ sub_account_id: subAuthId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Vobiz ${res.status} moving the number: ${(await res.text()).slice(0, 200)}`);
  },

  async verifyDoc(c, subAuthId, doc) {
    const path = doc.kind === "pan" ? "verify-pan" : doc.kind === "gst" ? "verify-gst" : "cin/confirm";
    const body = doc.kind === "pan" ? { pan: doc.pan } : doc.kind === "gst" ? { gstin: doc.gstin } : { company_name: doc.companyName, selected_cin: doc.cin };
    const res = await fetch(`${API}/sub-accounts/${encodeURIComponent(subAuthId)}/kyc/${path}`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    // A document Vobiz refused is an answer ("failed"); anything else is Vobiz unreachable.
    if (res.status >= 500) throw new Error(`Vobiz ${res.status} checking ${doc.kind}`);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return res.ok ? j : { ...j, status: "failed" };
  },

  async digilockerStart(c, subAuthId, redirectUrl, state) {
    const res = await fetch(`${API}/sub-accounts/${encodeURIComponent(subAuthId)}/kyc/digilocker/initiate`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ redirect_url: redirectUrl, oauth_state: state }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Vobiz ${res.status} starting DigiLocker: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { auth_url?: unknown; access_request_id?: unknown };
    if (typeof j.auth_url !== "string" || !/^https:\/\/[a-z0-9.-]*digitallocker\.gov\.in\//.test(j.auth_url) || typeof j.access_request_id !== "string") {
      throw new Error("Vobiz did not return a DigiLocker page.");
    }
    return { url: j.auth_url, requestId: j.access_request_id };
  },

  async digilockerFinish(c, subAuthId, requestId) {
    const res = await fetch(`${API}/sub-accounts/${encodeURIComponent(subAuthId)}/kyc/digilocker/verify`, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify({ access_request_id: requestId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 500) throw new Error(`Vobiz ${res.status} finishing DigiLocker`);
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return res.ok ? j : { ...j, status: "failed" };
  },

  async deleteSubAccount(c, subAuthId) {
    const res = await fetch(`${API}/accounts/${c.authId}/sub-accounts/${encodeURIComponent(subAuthId)}`, {
      method: "DELETE",
      headers: headers(c),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Vobiz ${res.status} removing a sub-account`);
  },

  // GET /Account/{auth_id}/Call/ lists finished calls, newest first, 20 a page.
  async recentCalls(c, limit) {
    const out: CarrierCall[] = [];
    for (let offset = 0; offset < limit; offset += 20) {
      const res = await fetch(`${BASE}/${c.authId}/Call/?limit=20&offset=${offset}`, { headers: headers(c), signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`Vobiz ${res.status} listing calls`);
      const j = (await res.json()) as { objects?: Record<string, unknown>[]; meta?: { next?: string | null } };
      for (const o of j.objects ?? []) {
        const at = typeof o.initiation_time === "string" ? Date.parse(o.initiation_time.replace(" ", "T")) : NaN;
        const end = typeof o.end_time === "string" ? Date.parse(o.end_time.replace(" ", "T")) : NaN;
        const answered = typeof o.answer_time === "string" && o.answer_time.trim() !== "";
        out.push({
          from: toE164(o.from_number as string | undefined),
          to: toE164(o.to_number as string | undefined),
          startedIso: Number.isNaN(at) ? null : new Date(at).toISOString(),
          cause: typeof o.hangup_cause === "string" ? o.hangup_cause : null,
          source: typeof o.hangup_source === "string" ? o.hangup_source : null,
          ringSeconds: answered || Number.isNaN(at) || Number.isNaN(end) ? null : Math.max(0, (end - at) / 1000),
        });
      }
      if (!j.meta?.next) break;
    }
    return out;
  },
};

/** The buyer's live call from our number, or null when it is already over. */
export async function findLiveCall(c: VobizConfig, buyer: string, ours: string, inbound = false): Promise<LiveCall | null> {
  const calls = await vobiz().liveCalls(c);
  // A buyer who rang us is the call's caller, not the one called.
  const match = inbound
    ? calls.filter((l) => l.from === buyer && (l.to === ours || l.to === null))
    : calls.filter((l) => l.to === buyer && (l.from === ours || l.from === null));
  return match.find((l) => l.status === "in-progress") ?? match[0] ?? null;
}

let injected: VobizDriver | null = null;

/** For checks: route every Vobiz request through `driver` until `restore()`. */
export function useVobiz(driver: VobizDriver): { restore(): void } {
  injected = driver;
  return { restore: () => void (injected = null) };
}

export const vobiz = (): VobizDriver => injected ?? realDriver;
