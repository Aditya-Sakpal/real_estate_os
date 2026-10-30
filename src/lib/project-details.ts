/**
 * Sends the project's details on WhatsApp: what the agent promised on the
 * call. `details-rules.ts` is the pure half (was it promised, which pictures,
 * what the details say); this reads the signed facts and the approved
 * pictures and sends.
 *
 * Outside the buyer's 24 hours, the `PROJECT_DETAILS` template opens the
 * chat with the tower's picture and one button. Inside them (the button was
 * tapped, or the buyer had written to us already), the pictures go one by
 * one with their approved titles, then the details. Every gate an
 * advertisement asks is asked first: the opt-out and the RERA gate. Nothing
 * here calls a paid model; a session message costs nothing at Meta.
 */

import sharp from "sharp";
import { audit, withTenant } from "./db/index.ts";
import { approvedAssets, assetKeys } from "./asset.ts";
import { looksBlank } from "./asset-rules.ts";
import { resolveBrain } from "./brain.ts";
import { asList } from "./brain-rules.ts";
import { approvedUnits } from "./unit.ts";
import { priceFor } from "./unit-rules.ts";
import { canPublish } from "./publish-gate.ts";
import { adRuleFor } from "./rera-ad-rules.ts";
import { registrationLine } from "./connect-rules.ts";
import { isLuxury, priceNoteFor, sellingPoints } from "./creative-rules.ts";
import { readAsset } from "./storage.ts";
import { senderFor } from "./wa-numbers.ts";
import { whatsapp } from "./whatsapp.ts";
import { voiceFor, type Voice } from "./message-rules.ts";
import { WINDOW_MS } from "./wa-pacing-rules.ts";
import { sendMessage, type SendResult } from "./messaging.ts";
import {
  captionOf,
  detailsPayload,
  detailsText,
  highlightLine,
  pickDetailPictures,
  type DetailHome,
  type DetailPicture,
  type DetailsInput,
} from "./details-rules.ts";

/** A tap twice, or a call twice in an afternoon, sends the pictures once. */
const PACK_AGAIN_AFTER_MS = 6 * 3600_000;

type Lead = {
  id: string;
  name: string;
  phone: string | null;
  language: string | null;
  scope_node_id: string;
  facts: Record<string, unknown> | null;
  erased_at: Date | null;
};

type Material = {
  input: Omit<DetailsInput, "registration" | "renders">;
  pictures: (DetailPicture & { key: string })[];
};

/** The tower's signed facts and approved pictures, as the details say them. */
async function materialFor(orgId: string, nodeId: string): Promise<Material | null> {
  const [node] = await withTenant(orgId, (sql) => sql<
    { kind: string; name: string; parent_name: string | null; grand_name: string | null }[]
  >`
    SELECT n.kind, n.name, p.name AS parent_name, g.name AS grand_name
    FROM scope_nodes n
    LEFT JOIN scope_nodes p ON p.id = n.parent_id
    LEFT JOIN scope_nodes g ON g.id = p.parent_id
    WHERE n.org_id = ${orgId} AND n.id = ${nodeId}`);
  if (!node || node.kind !== "PHASE") return null;
  const [brain, units, assets] = await Promise.all([
    resolveBrain(orgId, nodeId),
    approvedUnits(orgId, nodeId),
    approvedAssets(orgId, nodeId),
  ]);
  const v = brain?.values ?? {};
  const money = (raw: string | null | undefined) => {
    const n = Number(String(raw ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const homes: DetailHome[] = units.units
    .map((u) => ({ label: u.label, carpetSqft: u.carpetAreaSqft, balconySqft: u.balconyAreaSqft, price: priceFor(u, units.basePsf) }))
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const rows = await assetKeys(orgId, assets);
  const keyOf = new Map(rows.map((r) => [`${r.asset_id}:${r.version}`, r.storage_key]));
  const pictures = assets
    .map((a) => ({
      id: a.id,
      category: a.category,
      title: (a.title ?? "").trim(),
      isRender: a.isRender,
      unitLabel: a.unitLabel ?? null,
      key: keyOf.get(`${a.id}:${a.version}`) ?? "",
    }))
    .filter((p) => p.key && p.title);
  return {
    input: {
      project: node.parent_name ?? node.name,
      tower: node.parent_name ? node.name : null,
      location: v["claims.location"] ?? null,
      city: node.grand_name,
      homes,
      points: sellingPoints(asList(v["claims.talking_points"]), { luxury: isLuxury(homes.map((h) => ({ startingPrice: h.price }))) }),
      amenities: [...asList(v["claims.amenities"]), ...pictures.filter((p) => p.category === "AMENITY").map((p) => p.title)],
      bookingAmount: money(v["price.booking_amount"]),
      paymentPlan: v["price.payment_plan"] ?? null,
      possession: v["claims.possession_date"] ?? null,
      priceNote: "",
    },
    pictures,
  };
}

/**
 * A picture as WhatsApp takes it: a JPEG no wider or taller than 1600, or
 * null when a photograph or render shows nothing. A floor plan is line work
 * on white and measures as blank, so it is never measured.
 */
async function jpegOf(p: { key: string; category: string }): Promise<Buffer | null> {
  const raw = await readAsset(p.key).catch(() => null);
  if (!raw) return null;
  if (p.category !== "FLOOR_PLAN") {
    const stats = await sharp(raw).greyscale().resize(256, 256, { fit: "inside" }).stats().catch(() => null);
    if (looksBlank(stats?.entropy)) return null;
  }
  return sharp(raw)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 82 })
    .toBuffer()
    .catch(() => null);
}

/**
 * Send the project's details to a lead: the template with its picture when
 * the buyer's 24 hours are closed, the pictures and the details when open.
 * `pack` asks for the second whatever the window says, for the button's tap,
 * which opened it.
 */
export async function sendDetails(opts: {
  orgId: string;
  leadId: string;
  nowIso?: string;
  taskId?: string | null;
  userId?: string | null;
  pack?: boolean;
}): Promise<SendResult> {
  const { orgId, leadId } = opts;
  const now = opts.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const found = await withTenant(orgId, async (sql) => {
    const [lead] = await sql<Lead[]>`
      SELECT id, name, phone, language, scope_node_id, facts, erased_at FROM leads WHERE org_id = ${orgId} AND id = ${leadId}`;
    if (!lead?.phone) return null;
    const [[inbound], [opt], [recent]] = await Promise.all([
      sql<{ at: Date | null }[]>`
        SELECT max(created_at) AS at FROM messages WHERE org_id = ${orgId} AND phone = ${lead.phone} AND direction = 'IN'`,
      sql<{ n: number }[]>`SELECT count(*)::int AS n FROM call_suppressions WHERE org_id = ${orgId} AND phone = ${lead.phone}`,
      sql<{ at: Date | null }[]>`
        SELECT max(created_at) AS at FROM messages
        WHERE org_id = ${orgId} AND lead_id = ${leadId} AND purpose = 'PROJECT_DETAILS' AND category = 'SERVICE'
          AND direction = 'OUT' AND status NOT IN ('REFUSED', 'FAILED')`,
    ]);
    return { lead, lastInbound: inbound?.at ?? null, optedOut: (opt?.n ?? 0) > 0, lastPack: recent?.at ?? null };
  });
  if (!found || found.lead.erased_at) return { ok: false, code: "GONE", message: "That lead no longer exists." };
  const { lead } = found;
  const voice: Voice = voiceFor(lead.language);
  const open = found.lastInbound !== null && nowMs - found.lastInbound.getTime() < WINDOW_MS;

  // The closed window: the template, through every gate sendMessage asks.
  if (!open && !opts.pack) {
    const [material, gate] = await Promise.all([materialFor(orgId, lead.scope_node_id), canPublish(orgId, lead.scope_node_id)]);
    const chosen = material ? pickDetailPictures(material.pictures, String(lead.facts?.config ?? "")) : [];
    let header: Buffer | null = null;
    for (const p of chosen) if ((header = await jpegOf(p))) break;
    const rule = gate.ok ? adRuleFor(gate.stateCode) : null;
    const registration = gate.ok && gate.registrationNo
      ? `${rule?.shortLabel ?? "RERA No."} ${gate.registrationNo}`
      : material?.input.location ?? material?.input.city ?? null;
    return sendMessage({
      orgId,
      leadId,
      purpose: "PROJECT_DETAILS",
      nowIso: now,
      taskId: opts.taskId ?? null,
      userId: opts.userId ?? null,
      headerImage: header ?? undefined,
      extra: {
        highlights: material ? highlightLine(material.input, voice) : "-",
        ...(registration ? { registration } : {}),
      },
      buttonPayloads: [detailsPayload(leadId)],
    });
  }

  // The open window: the pictures and the details, each a message of its own.
  if (found.optedOut) return { ok: false, code: "OPTED_OUT", message: "This buyer asked not to be messaged." };
  if (found.lastPack && nowMs - found.lastPack.getTime() < PACK_AGAIN_AFTER_MS) {
    return { ok: true, messageId: "" };
  }
  const gate = await canPublish(orgId, lead.scope_node_id);
  if (!gate.ok) return { ok: false, code: "NOT_ADVERTISABLE", message: "This tower may not be advertised now, so its details were not sent." };
  const material = await materialFor(orgId, lead.scope_node_id);
  if (!material) return { ok: false, code: "GONE", message: "This lead is not filed under a tower, so there are no details to send." };
  const sender = await senderFor(orgId, lead.scope_node_id);
  if (!sender.ok) return { ok: false, code: "NOT_SWITCHED_ON", message: sender.message };
  const d = whatsapp();
  if (!d.sendMedia || !d.sendText) return { ok: false, code: "NOT_SWITCHED_ON", message: "This WhatsApp connection cannot send pictures." };

  const record = (body: string) =>
    withTenant(orgId, async (sql) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO messages (org_id, lead_id, task_id, direction, channel, purpose, category, language, body, phone, status,
                              sent_by, number_id)
        VALUES (${orgId}, ${leadId}, ${opts.taskId ?? null}, 'OUT', 'WHATSAPP', 'PROJECT_DETAILS', 'SERVICE', 'en',
                ${body.slice(0, 4096)}, ${lead.phone}, 'QUEUED', ${opts.userId ?? null}, ${sender.numberId})
        RETURNING id`;
      return row.id;
    });
  const settle = (id: string, providerId: string | null, error: string | null) =>
    withTenant(orgId, (sql) => sql`
      UPDATE messages SET status = ${providerId ? "SENT" : "FAILED"}, provider_id = ${providerId}, error = ${error},
             sent_at = ${providerId ? new Date() : null}
      WHERE org_id = ${orgId} AND id = ${id}`);

  let sent = 0;
  let renders = false;
  for (const p of pickDetailPictures(material.pictures, String(lead.facts?.config ?? ""))) {
    const bytes = await jpegOf(p);
    if (!bytes) continue;
    const caption = captionOf(p);
    const id = await record(`[Picture] ${caption}`);
    try {
      const r = await d.sendMedia(sender.config, { to: lead.phone!, kind: "image", bytes, mediaType: "image/jpeg", filename: "picture.jpg", caption, callbackData: `${orgId}:${id}` });
      await settle(id, r.id, null);
      sent += 1;
      if (p.isRender) renders = true;
    } catch (e) {
      console.warn("details: a picture was not sent,", (e instanceof Error ? e.message : String(e)).slice(0, 300));
      await settle(id, null, "WhatsApp did not accept this picture.");
    }
  }

  const text = detailsText(
    {
      ...material.input,
      priceNote: priceNoteFor(gate.stateCode),
      registration: registrationLine(gate.registrationNo, gate.stateCode, gate.permitNo),
      renders,
    },
    voice,
  );
  const id = await record(text);
  try {
    const r = await d.sendText(sender.config, { to: lead.phone!, body: text, callbackData: `${orgId}:${id}` });
    await settle(id, r.id, null);
  } catch (e) {
    console.warn("details: the details were not sent,", (e instanceof Error ? e.message : String(e)).slice(0, 300));
    await settle(id, null, "WhatsApp did not accept this message.");
    return { ok: false, code: "FAILED", message: "WhatsApp did not accept the details. They were not sent." };
  }
  await audit({ orgId, actorUserId: opts.userId ?? null, action: "message.details_sent", targetType: "lead", targetId: leadId, metadata: { pictures: sent, renders } });
  return { ok: true, messageId: id };
}
