/**
 * A call a person makes through our number: the rules, with no database.
 *
 * Vobiz rings the person's own phone from our number; when they pick up,
 * it dials the buyer with our number as the caller id, so the buyer sees
 * ours and the person never needs the buyer's. That is what lets a masked
 * number stay masked while the call still happens.
 *
 * Priced like a hand-off minute (two Vobiz legs, Rs 0.90 a minute) and
 * counted the same way against the project's allowance, a quarter of an AI
 * minute each. Capped at `PROXY_TIME_LIMIT_S` by Vobiz itself.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The longest one call may run, enforced by Vobiz on both legs. */
export const PROXY_TIME_LIMIT_S = 1800;
/** How long the buyer's phone rings before the call gives up. */
export const PROXY_RING_S = 30;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What Vobiz runs once the person has picked up: ring the buyer, as us. */
export function proxyDialXml(o: { buyer: string; callerId: string; eventsUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${esc(o.callerId)}" timeout="${PROXY_RING_S}" timeLimit="${PROXY_TIME_LIMIT_S}" callbackUrl="${esc(o.eventsUrl)}" callbackMethod="POST">
    <Number>${esc(o.buyer)}</Number>
  </Dial>
</Response>`;
}

/**
 * The proof a callback address carries. Its own namespace, so a token for
 * one of these calls opens nothing on an AI call's webhook, or the reverse.
 */
export function proxyToken(secret: string, orgId: string, proxyCallId: string): string {
  return createHmac("sha256", secret).update(`proxy:${orgId}:${proxyCallId}`).digest("hex");
}

export function proxyTokenValid(secret: string, orgId: string, proxyCallId: string, token: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(token)) return false;
  const want = Buffer.from(proxyToken(secret, orgId, proxyCallId), "hex");
  const got = Buffer.from(token, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Whole minutes Vobiz billed, and what they count as against the allowance. */
export function proxyMinutes(billS: number, weight: number): { minutes: number; counted: number } {
  const minutes = billS > 0 ? Math.ceil(billS / 60) : 0;
  return { minutes, counted: minutes * weight };
}

// ---------------------------------------------------------------------------
// A hot buyer, put straight through (lead engine gaps, slice 4)
// ---------------------------------------------------------------------------

/** Seconds the sales person has to press 1 after the summary. */
export const BRIDGE_ACCEPT_S = 10;
/** How long their phone rings before the bridge gives up. */
export const BRIDGE_RING_S = 25;

/**
 * The summary the sales person hears before they take the buyer: who, what
 * they want, and the one key to press. English, because Vobiz's own voice
 * speaks English and the sales team works in it; the buyer never hears it.
 */
export function whisperText(o: { name: string; config: string | null; budget: string | null; tower: string }): string {
  const first = o.name.split(/\s+/)[0] || "A buyer";
  const wants = [o.config, o.budget ? `budget ${o.budget.replace(/^Rs /, "rupees ")}` : null].filter(Boolean).join(", ");
  return `Sales Desk. A hot buyer is waiting: ${first}${wants ? `, ${wants}` : ""}, for ${o.tower}. Press 1 to talk to them now.`;
}

/** What Vobiz plays the sales person: the summary, a key to press, and a goodbye if none is. */
export function bridgeAnswerXml(o: { whisper: string; acceptUrl: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather inputType="dtmf" numDigits="1" executionTimeout="${BRIDGE_ACCEPT_S}" action="${esc(o.acceptUrl)}" method="POST">
    <Speak voice="WOMAN" language="en-GB">${esc(o.whisper)}</Speak>
  </Gather>
  <Speak voice="WOMAN" language="en-GB">No key was pressed. Please call the buyer back from the lead's page.</Speak>
  <Hangup/>
</Response>`;
}

/** Only the key the summary named takes the buyer. */
export const bridgeAccepted = (params: Record<string, string>) => (params.Digits ?? params.digits ?? "").trim() === "1";
