/**
 * Uttar Pradesh, checked from the QR its authority issues.
 *
 * UP RERA's project search and its certificate check both sit behind an
 * image CAPTCHA, which is an access control and not ours to work around,
 * and its status lists are postbacks that will not answer a script. So a
 * number alone cannot be asked about.
 *
 * What UP RERA does publish is a QR for every project, which its press note
 * of 19 July 2024 requires on every advertisement. The QR encodes a fixed
 * link to the project's public summary page, and that page answers a plain
 * request with the registration number, the promoter, the registration date
 * and the declared completion date. The developer uploads that QR as the
 * phase's lockup, because the ad cannot be made without it. So the lockup is
 * where the check happens: when it is approved, its QR is read, the page it
 * points at is fetched, and the number and the promoter on it are compared
 * with the record. A lockup whose QR belongs to another registration is the
 * misrepresentation Section 3 exists to stop, and is refused.
 *
 * One request per approval, never nightly. Between approvals a UP
 * registration is held to its date, like every state without a bulk read.
 *
 * The link comes out of a picture a tenant uploaded, so it is not trusted:
 * only https, only UP RERA's own host, only the summary page. Anything else
 * is not fetched at all.
 */

import { createHash } from "node:crypto";
import sharp from "sharp";
import jsQR from "jsqr";
import { blanketExtension, promoterMatches, registrationKey } from "./rera-rules.ts";
import {
  fixtureName,
  htmlText,
  portalDate,
  portalRequest,
  type FormVerdict,
  type PortalCtx,
  type PortalProject,
} from "./rera-portal.ts";

const HOSTS = new Set(["up-rera.in", "www.up-rera.in"]);

/**
 * The summary link a QR carries, or null when it is not one. The link is
 * rebuilt from its parts rather than passed on, so nothing in the QR can
 * steer the request anywhere else.
 */
export function upSummaryUrl(qrText: string | null | undefined): string | null {
  const raw = String(qrText ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.port && url.port !== "443" && url.port !== "80") return null;
  if (url.pathname.replace(/\/+$/, "").toLowerCase() !== "/projectsummary") return null;
  if (!url.search || url.search.length > 600) return null;
  return `https://up-rera.in/Projectsummary${url.search}`;
}

/**
 * Read the summary page. Fields are found by the ids the page gives them
 * (`lblregno`, `Lblpromotername`, ...), not by position. Only what a
 * `PortalProject` holds is read: the page also carries the promoter's
 * mobile number and email, and neither is taken.
 */
export function parseUpSummary(html: string, portalRef?: string): PortalProject | null {
  const field = (id: string): string | null => {
    const m = html.match(new RegExp(`id="[^"]*_${id}"[^>]*>([\\s\\S]*?)<\\/(?:label|span)>`, "i"));
    const v = m ? htmlText(m[1]) : "";
    return v || null;
  };
  const registrationNo = field("lblregno");
  if (!registrationNo || !/^UPRERAPRJ\d+/i.test(registrationNo)) return null;
  return {
    registrationNo: registrationNo.toUpperCase().replace(/\s+/g, ""),
    projectName: field("lblprojectname") ?? undefined,
    promoterName: field("Lblpromotername") ?? undefined,
    status: "REGISTERED",
    registeredOn: portalDate(field("prjregdate")) ?? undefined,
    validTo: portalDate(field("Lblproposedenddt")) ?? undefined,
    portalRef,
  };
}

/** Fetch the page a UP QR points at, and read it. */
export async function checkUpQr(qrText: string | null, ctx: PortalCtx = {}): Promise<FormVerdict> {
  const url = upSummaryUrl(qrText);
  if (!url) return { known: false, reason: "The QR does not link to a UP RERA project page." };
  const ref = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const res = await portalRequest(
    "UP",
    { name: fixtureName(`summary_${ref}.html`), url, timeoutMs: 30_000 },
    ctx,
  );
  if (!res.ok) return { known: false, reason: res.reason };
  const project = parseUpSummary(res.text, url);
  // A page with no registration number on it is a page whose shape changed,
  // or an error page. Neither says the registration does not exist.
  if (!project) return { known: false, reason: "The UP RERA page did not read as a project summary." };
  return { known: true, found: true, project };
}

/** The text a QR in a picture encodes, or null. */
export async function decodeQr(bytes: Buffer): Promise<string | null> {
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 0;
  const tries = [sharp(bytes)];
  if (W && W < 600) tries.push(sharp(bytes).resize({ width: W * 3, kernel: "nearest" }));
  for (const t of tries) {
    const { data, info } = await t
      .flatten({ background: "#ffffff" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
    if (found?.data) return found.data;
  }
  return null;
}

/**
 * The check itself, run before a phase's lockup is approved.
 *
 * Three outcomes:
 *
 *   - the QR's page names another registration, or another promoter: the
 *     approval is refused, because a QR that opens somebody else's project
 *     printed beside this phase's number is the misrepresentation the lockup
 *     exists to prevent;
 *   - it names this registration and this promoter: the record is stamped
 *     as checked, and the authority's dates are kept;
 *   - it could not be read (no QR, a portal that is down, a page that did
 *     not parse): the approval goes ahead and nothing is stamped.
 *
 * A lockup on a phase in any other state, or with no verified registration,
 * is not this function's business.
 */
export async function checkUpLockup(opts: {
  orgId: string;
  phaseId: string;
  bytes: Buffer;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; checked: boolean } | { ok: false; message: string }> {
  // Loaded here so the pure half above can be tested without a database.
  const { withTenant, audit } = await import("./db/index.ts");
  const [row] = await withTenant(opts.orgId, async (sql) =>
    sql<{ state_code: string | null; registration_no: string | null; entity_name: string }[]>`
      SELECT r.state_code, r.registration_no, entity.name AS entity_name
      FROM registration_records r
      JOIN scope_nodes ph     ON ph.id = r.scope_node_id
      JOIN scope_nodes p      ON p.id = ph.parent_id
      JOIN scope_nodes region ON region.id = p.parent_id
      JOIN scope_nodes entity ON entity.id = region.parent_id
      WHERE r.org_id = ${opts.orgId} AND r.scope_node_id = ${opts.phaseId}
        AND r.status = 'VERIFIED'`,
  );
  if (!row?.registration_no || row.state_code !== "UP") return { ok: true, checked: false };

  let qrText: string | null = null;
  try {
    qrText = await decodeQr(opts.bytes);
  } catch {
    qrText = null;
  }
  const verdict = await checkUpQr(qrText, { fetchImpl: opts.fetchImpl });
  if (!verdict.known || !verdict.found) return { ok: true, checked: false };

  const p = verdict.project;
  if (registrationKey("UP", p.registrationNo) !== registrationKey("UP", row.registration_no)) {
    return {
      ok: false,
      message: `This QR opens UP RERA's page for ${p.registrationNo}, not ${row.registration_no}. Upload the QR from this tower's certificate.`,
    };
  }
  if (p.promoterName && !promoterMatches(p.promoterName, row.entity_name)) {
    return {
      ok: false,
      message: `UP RERA registered ${p.registrationNo} to "${p.promoterName}", not "${row.entity_name}".`,
    };
  }

  const ext = blanketExtension({ stateCode: "UP", validTo: p.validTo ?? null, registeredOn: p.registeredOn ?? null });
  await withTenant(opts.orgId, async (sql) => {
    await sql`
      UPDATE registration_records
      SET last_checked_at = now(), updated_at = now(),
          registered_on = COALESCE(registered_on, ${p.registeredOn ?? null}),
          portal_ref = ${p.portalRef ?? null},
          extended_until = COALESCE(extended_until, ${ext?.until ?? null}),
          extension_ref = COALESCE(extension_ref, ${ext?.ref ?? null})
      WHERE org_id = ${opts.orgId} AND scope_node_id = ${opts.phaseId}`;
  });
  await audit({
    orgId: opts.orgId,
    actorUserId: null,
    action: "rera.checked",
    targetType: "scope_node",
    targetId: opts.phaseId,
    metadata: { state: "UP", registration_no: row.registration_no, check: "qr" },
  });
  return { ok: true, checked: true };
}
