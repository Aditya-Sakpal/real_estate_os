/**
 * Filling a registration from its number.
 *
 * A compliance officer used to type five fields off a certificate the
 * authority already publishes: the promoter, the date it runs to, the day it
 * was registered and what they checked. Where the state's portal can be read
 * at the form, typing the number is enough: the rest is read back from the
 * authority and put in the boxes, still editable, and recording it asks the
 * portal again exactly as before. Nothing here records anything.
 *
 * Pure, so `check:logic` covers it.
 */

import type { FormVerdict } from "./rera-portal.ts";

export type RegistrationFill = {
  projectName: string | null;
  promoterName: string | null;
  validTo: string | null;
  registeredOn: string | null;
  /** What goes in "What you checked". */
  reason: string;
  /** The authority's promoter is not this phase's entity. */
  otherPromoter: boolean;
};

export type LookupAnswer =
  | { ok: true; fill: RegistrationFill }
  | { ok: false; message: string; unknown?: boolean };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What the form is given for one verdict. A number the authority does not
 * hold, or holds as cancelled, is said plainly and fills nothing; a portal
 * that could not be read says so and leaves the boxes to the person.
 */
export function fillFromPortal(o: {
  verdict: FormVerdict;
  authority: string;
  number: string;
  /** The phase's entity, the promoter of record. */
  entityName: string;
  /** Compares two promoter names the way recording does. */
  sameName: (a: string, b: string) => boolean;
}): LookupAnswer {
  const v = o.verdict;
  if (!v.known) return { ok: false, message: `${o.authority}'s website did not answer just now. Try again in a minute, or type the dates from the certificate.`, unknown: true };
  if (!v.found) return { ok: false, message: `${o.authority} has no project under ${o.number}. Check the number on the certificate.` };
  const p = v.project;
  if (p.status !== "REGISTERED") {
    const word = p.status === "LAPSED" ? "lapsed" : p.status === "SUSPENDED" ? "suspended" : p.status === "WITHDRAWN" ? "withdrawn" : "revoked";
    return { ok: false, message: `${o.authority} shows ${o.number} as ${word}. It cannot be recorded.` };
  }
  const promoter = p.promoterName?.trim() || null;
  return {
    ok: true,
    fill: {
      projectName: p.projectName?.trim() || null,
      promoterName: promoter,
      validTo: p.validTo && DAY.test(p.validTo) ? p.validTo : null,
      registeredOn: p.registeredOn && DAY.test(p.registeredOn) ? p.registeredOn : null,
      reason: `Read on the ${o.authority} portal, status registered`,
      otherPromoter: !!promoter && !o.sameName(promoter, o.entityName),
    },
  };
}
