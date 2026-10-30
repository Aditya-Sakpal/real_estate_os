import { createHmac } from "node:crypto";
import { captureKey, captureKeyValid } from "./capture-rules.ts";

/**
 * The addresses leads arrive at, and the keys that prove a form may post to
 * them. Derived from `AUTH_SECRET`, so there is nothing to store and nothing
 * to leak from a table; rotating that secret re-keys every form.
 */

function secret(): string {
  const root = process.env.AUTH_SECRET;
  if (!root) throw new Error("AUTH_SECRET is not set.");
  return createHmac("sha256", root).update("salesdesk:lead-capture").digest("hex");
}

/** Where the platforms and a buyer's browser reach us. */
export function publicBase(): string | null {
  const base = process.env.CAPTURE_BASE_URL ?? process.env.CALLS_WEBHOOK_BASE ?? process.env.CONNECT_BASE_URL ?? process.env.AUTH_URL;
  return base ? base.replace(/\/+$/, "") : null;
}

export function orgCaptureKey(orgId: string): string {
  return captureKey(secret(), orgId, null);
}

export function phaseCaptureKey(orgId: string, phaseId: string): string {
  return captureKey(secret(), orgId, phaseId);
}

export function captureKeyOk(orgId: string, phaseId: string | null, key: string): boolean {
  return captureKeyValid(secret(), orgId, phaseId, key);
}

/**
 * The endpoint a developer's website form, or a Google lead form, posts to.
 * With a tower, the address names it, so the form needs no hidden field.
 */
export function captureEndpoint(orgId: string, phaseId: string | null = null): string | null {
  const base = publicBase();
  if (!base) return null;
  return `${base}/api/leads/capture?o=${orgId}&k=${orgCaptureKey(orgId)}${phaseId ? `&phase=${phaseId}` : ""}`;
}

/**
 * Our own enquiry page for one tower: the landing page an ad uses when the
 * developer has no website of their own to send people to.
 */
export function enquiryUrl(orgId: string, phaseId: string): string | null {
  const base = publicBase();
  return base ? `${base}/enquire/${phaseId}?o=${orgId}&k=${phaseCaptureKey(orgId, phaseId)}` : null;
}
