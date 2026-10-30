/**
 * A channel partner firm adding its own people by phone: the rules, with no
 * database. Covered by `check:logic`.
 *
 * Most of a broker firm's people have a phone and no work account, so the
 * firm's owner adds them by their number from the console's Team page. The
 * invite is a membership row at the firm's root (`CP_AGENT`, the role the
 * partner bot gives the people a developer lists), bound to the number, not
 * to a link: the person claims it by signing in with that phone and the
 * code sent to it. The giving rule an email invite asks (`checkGrant()`)
 * holds, measured against what the role holds on a phone.
 *
 * Relative imports: `check:logic` loads this from source.
 */

import { PHONE_ROLE_PERMISSIONS, PHONE_ORG_TYPES } from "./phone-session-rules.ts";
import { normalisePhone } from "./calling-rules.ts";

/** The role a person added by phone holds. */
export const PHONE_INVITE_ROLE = "CP_AGENT";

/** What the role is, for the giving rule: its label, where it sits and what it holds. */
export const PHONE_INVITE_SHAPE = {
  key: PHONE_INVITE_ROLE,
  label: "Agent",
  minKind: "ORG" as const,
  permissions: PHONE_ROLE_PERMISSIONS[PHONE_INVITE_ROLE],
};

/** Only a channel partner firm adds people by phone. */
export const mayInviteByPhone = (orgType: string): boolean => PHONE_ORG_TYPES.includes(orgType);

export type PhoneInvite = { ok: true; name: string; phone: string } | { ok: false; message: string };

/**
 * A name and a number as typed. The name is what the team page shows until
 * the person signs in, so it is required; the number is read the way every
 * other phone here is, and a number from outside India is taken as typed
 * with its country code.
 */
export function readPhoneInvite(raw: { name: string; phone: string }): PhoneInvite {
  const name = raw.name.replace(/\s+/g, " ").replace(/[<>{}\[\]\\|^`"]/g, "").trim().slice(0, 120);
  if (!name) return { ok: false, message: "Type the person's name." };
  if (/^[=+\-@]/.test(name)) return { ok: false, message: "A name cannot start with = + - or @." };
  const phone = normalisePhone(raw.phone);
  if (!phone) return { ok: false, message: "That number does not look right. Use 10 digits, or add the country code." };
  return { ok: true, name, phone };
}

/** Where a phone person stands, in the team page's words. */
export function phonePersonState(status: string): string {
  return status === "INVITED" ? "Not signed in yet" : status === "ACTIVE" ? "Signed in" : "Removed";
}
