import { normalisePhone } from "./calling-rules.ts";
import { isAgentNo } from "./mandate-rules.ts";

/**
 * A firm's own record, changed from its workspace: pure, covered by
 * `check:logic`. Apart from `mandate-rules.ts` because reading a phone
 * number pulls in the server's crypto, and that file is also drawn in the
 * browser.
 */

export type ProfileInput = { reraNo: string; reraTill: string; city: string; phone: string };

/** The firm's record, checked: every problem at once, in the form's own words. */
export function readProfile(raw: ProfileInput, today: string): { ok: true; values: { reraNo: string; reraTill: string | null; city: string | null; phone: string | null } } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const reraNo = raw.reraNo.trim().toUpperCase();
  if (!isAgentNo(reraNo)) errors.reraNo = "Enter the MahaRERA agent number, A and 11 digits.";
  const reraTill = raw.reraTill.trim() || null;
  if (reraTill && (!/^\d{4}-\d{2}-\d{2}$/.test(reraTill) || reraTill < today)) errors.reraTill = "That registration has lapsed.";
  const city = raw.city.trim().replace(/\s+/g, " ").slice(0, 80) || null;
  const phone = raw.phone.trim() ? normalisePhone(raw.phone) : null;
  if (raw.phone.trim() && !phone) errors.phone = "Use 10 digits, or add the country code.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, values: { reraNo, reraTill, city, phone } };
}
