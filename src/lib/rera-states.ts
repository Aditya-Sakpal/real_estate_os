/**
 * Every state adapter, registered in one place.
 *
 * Import the seam from here rather than from `rera-portal.ts` directly, so
 * that asking a state's portal always finds its adapter registered.
 *
 * Which states have one, and why the rest do not, is in `doc/rera-states.md`:
 * Telangana and Uttar Pradesh put their search behind a CAPTCHA and Goa
 * behind an email code, which are access controls and not ours to work
 * around. Uttar Pradesh is still checked, from the project QR its authority
 * issues (`rera-up.ts`), when the lockup carrying it is approved.
 *
 * Imports are relative so the nightly job can load this straight from
 * source, outside Next.
 */

import { registerAdapter, type FormVerdict, type StateAdapter } from "./rera-portal.ts";
import { readCertificateDates, searchIsCanned, searchRegistration } from "./rera-mh-search.ts";
import { lookupRegistration as lookupInRegister } from "./rera-mh-register.ts";
import { registrationKey } from "./rera-rules.ts";
import { apAdapter } from "./rera-ap.ts";
import { dlAdapter } from "./rera-dl.ts";
import { gjAdapter } from "./rera-gj.ts";
import { hrAdapter } from "./rera-hr.ts";
import { kaAdapter } from "./rera-ka.ts";
import { rjAdapter } from "./rera-rj.ts";
import { tnAdapter } from "./rera-tn.ts";
import { wbAdapter } from "./rera-wb.ts";

/**
 * Maharashtra, through the modules that predate the seam. Its form check is
 * the project search in `rera-mh-search.ts`. Its nightly reads (the two
 * revocation lists and the register) stay in `rera-sweep.ts`'s own passes,
 * which is why it declares no `nightly` here: the sweep would otherwise read
 * MahaRERA twice.
 */
export const mhAdapter: StateAdapter = {
  state: "MH",
  keyOf: (no) => registrationKey("MH", no),
  async atForm(no, ctx): Promise<FormVerdict> {
    const v = await searchRegistration(no, ctx.fetchImpl);
    if (!v.known) {
      // The search could not be read. The register may still say the number
      // was issued, which is enough to accept it; it never refuses one.
      const reg = await lookupInRegister(no, ctx.fetchImpl);
      if (reg.known && reg.found) {
        return { known: true, found: true, project: { registrationNo: no, projectName: reg.project.projectName, status: "REGISTERED" } };
      }
      return { known: false, reason: v.reason };
    }
    if (v.status === "ABSENT" && !(await searchIsCanned(no, ctx.fetchImpl))) {
      // Since October 2026 the live search sometimes answers "No Records
      // Found" for a number it holds, so a miss is asked again, and then of
      // the register, before it refuses anybody.
      const again = await searchRegistration(no, ctx.fetchImpl);
      if (again.known && again.status === "REGISTERED") return registered(again.project);
      if (again.known && again.status === "REVOKED") {
        return { known: true, found: true, project: { registrationNo: no, status: "REVOKED" } };
      }
      const reg = await lookupInRegister(no, ctx.fetchImpl);
      if (reg.known && reg.found) {
        return { known: true, found: true, project: { registrationNo: no, projectName: reg.project.projectName, status: "REGISTERED" } };
      }
      return reg.known ? { known: true, found: false } : { known: false, reason: reg.reason };
    }
    if (v.status === "ABSENT") return { known: true, found: false };
    if (v.status === "REVOKED") {
      return { known: true, found: true, project: { registrationNo: no, status: "REVOKED" } };
    }
    // The dates come off the registration certificate the card opens (its
    // extension certificate too), so the form is not left to the person.
    const dates = (await searchIsCanned(no, ctx.fetchImpl))
      ? { registeredOn: null, validTo: null }
      : await readCertificateDates(v.project, ctx.fetchImpl).catch(() => ({ registeredOn: null, validTo: null }));
    return registered({ ...v.project, ...dates });
  },
};

function registered(p: { registrationNo: string; projectName: string; promoterName: string; registeredOn?: string | null; validTo?: string | null }): FormVerdict {
  return {
    known: true,
    found: true,
    project: {
      registrationNo: p.registrationNo,
      projectName: p.projectName,
      promoterName: p.promoterName || undefined,
      status: "REGISTERED",
      ...(p.validTo ? { validTo: p.validTo } : {}),
      ...(p.registeredOn ? { registeredOn: p.registeredOn } : {}),
    },
  };
}

for (const adapter of [mhAdapter, kaAdapter, gjAdapter, hrAdapter, dlAdapter, tnAdapter, wbAdapter, apAdapter, rjAdapter]) {
  registerAdapter(adapter);
}

export {
  adapterFor,
  hasAdapter,
  lookupAtForm,
  nightlyRead,
  nightlyStates,
  resetPortalCache,
} from "./rera-portal.ts";
