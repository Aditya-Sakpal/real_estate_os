import { audit, withTenant } from "./db/index.ts";
import { readAsset } from "./storage.ts";
import { clearsForOutlet } from "./publish.ts";
import { stampPartner } from "./cobrand.ts";
import { grantLive, istDay, type GrantState } from "./partner-rules.ts";
import { isId } from "./partners.ts";
import { compareRegion, sha256 } from "./pixel.ts";
import { regionChanged } from "./pixel-rules.ts";

/**
 * A partner's co-branded copy of an approved post, made when it is asked for
 * and never stored: the post's bytes, the partner's band beneath them.
 *
 * Every gate is asked at the moment of asking, in the order a publication
 * asks them: the link is live, the firm may still register buyers on the
 * project and holds a current agent registration, the post belongs to that
 * project, and then `clearsForOutlet()`, which is the publisher's own
 * `prepare()` (the RERA gate fresh, the copy against today's facts, the price
 * and place on the picture current), which also asks for the picture's own
 * pixel PASS on these very files. The band adds nothing the pixel gate read:
 * the approved picture above it is compared with the file that passed, pixel
 * for pixel, and a copy whose picture changed is never handed over.
 */
export async function partnerPost(opts: {
  orgId: string;
  userId: string;
  linkId: string;
  postId: string;
  index: number;
  nowIso?: string;
}): Promise<{ ok: true; bytes: Buffer; name: string } | { ok: false; message: string }> {
  const now = opts.nowIso ?? new Date().toISOString();
  if (!isId(opts.linkId) || !isId(opts.postId) || !Number.isInteger(opts.index) || opts.index < 0) {
    return { ok: false, message: "That post is not here." };
  }
  const link = await withTenant(opts.orgId, async (sql) => {
    const [l] = await sql<{
      code: string;
      retired: boolean;
      firm: string;
      rera_agent_no: string | null;
      rera_valid_till: Date | string | null;
      project_path: string;
      status: GrantState["status"] | null;
      valid_from: Date | null;
      valid_to: Date | null;
    }[]>`
      SELECT l.code, l.retired_at IS NOT NULL AS retired, f.name AS firm, f.rera_agent_no, f.rera_valid_till,
             p.path::text AS project_path, g.status, g.valid_from, g.valid_to
      FROM partner_links l
      JOIN partner_firms f ON f.id = l.firm_id
      JOIN scope_nodes t ON t.id = l.scope_node_id
      JOIN scope_nodes p ON p.org_id = l.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
      LEFT JOIN grants g ON g.org_id = l.org_id AND g.grantee_org_id = l.cp_org_id AND g.scope_node_id = p.id AND g.status <> 'ENDED'
      WHERE l.org_id = ${opts.orgId} AND l.id = ${opts.linkId}`;
    return l ?? null;
  });
  if (!link) return { ok: false, message: "That link is not here." };
  if (link.retired) return { ok: false, message: "This link is retired." };
  const grant = link.status && link.valid_from && link.valid_to
    ? { status: link.status, validFrom: link.valid_from.toISOString(), validTo: link.valid_to.toISOString() }
    : null;
  if (!grantLive(grant, now)) return { ok: false, message: `${link.firm} is not empanelled on this project right now.` };
  const till = link.rera_valid_till
    ? typeof link.rera_valid_till === "string" ? link.rera_valid_till.slice(0, 10) : istDay(link.rera_valid_till.toISOString())
    : null;
  if (!link.rera_agent_no || !till || till < istDay(now)) {
    return { ok: false, message: `${link.firm} has no current MahaRERA agent registration on file.` };
  }

  const cleared = await clearsForOutlet(opts.orgId, opts.postId, new Date(now));
  if (!cleared.ok) return { ok: false, message: cleared.message };
  if (cleared.nodePath !== link.project_path && !cleared.nodePath.startsWith(`${link.project_path}.`)) {
    return { ok: false, message: "That post is for another project." };
  }
  const item = cleared.media[opts.index];
  if (!item || !["image/jpeg", "image/png"].includes(item.type)) return { ok: false, message: "That post has no picture there." };
  const bytes = await readAsset(item.key);
  if (!bytes) return { ok: false, message: "That picture could not be read." };
  // The bytes read are the bytes that passed.
  if (!item.sha256 || sha256(bytes) !== item.sha256) return { ok: false, message: "That picture changed after it was checked." };
  const stamped = await stampPartner(bytes, { firm: link.firm, agentNo: link.rera_agent_no, code: link.code });
  // And the band added below it left the approved picture as it was.
  if (regionChanged(await compareRegion(stamped, bytes, null))) {
    return { ok: false, message: "The co-branded copy did not keep the approved picture intact." };
  }
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "partner.post_cobranded",
    targetType: "rendered_post",
    targetId: opts.postId,
    metadata: { link: opts.linkId, frame: opts.index },
  });
  return { ok: true, bytes: stamped, name: `${link.code}-${String(opts.index + 1).padStart(2, "0")}.jpg` };
}
