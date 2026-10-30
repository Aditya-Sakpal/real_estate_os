import { audit, withNoTenant, withTenant } from "./db/index.ts";
import { messageAllowed, meterMessage } from "./billing.ts";
import { canPublish } from "./publish-gate.ts";
import { ownHandoffNumber, policyAt } from "./calling.ts";
import { showPhone } from "./call-rules.ts";
import { showDate, showTime } from "./lead-rules.ts";
import { ist } from "./cadence-rules.ts";
import {
  PRICE_PAISE,
  TEMPLATES,
  FILL_INS,
  nextStepIn,
  versionOf,
  voiceFor,
  fill,
  gateMessage,
  isStop,
  render,
  type MessagePurpose,
} from "./message-rules.ts";
import { holdFromPayload } from "./slot-rules.ts";
import { readLenderPayload } from "./visit-note-rules.ts";
import { readLoanSharePayload } from "./loan-rules.ts";
import { readDetailsPayload } from "./details-rules.ts";
import { passLink } from "./checkin.ts";
import { readWhatsAppWebhook, uploadMedia, whatsapp } from "./whatsapp.ts";
import { WHATSAPP_OFF, senderFor } from "./wa-numbers.ts";
import { CAP_MARKETING_30D, isStopPayload, isStopPromotions } from "./broadcast-rules.ts";
import { NOT_ON_WHATSAPP, fallsBack } from "./sms-rules.ts";
import { readTier, tierPeople } from "./wa-rules.ts";
import {
  OLDEST_READ,
  THROTTLED_WORDS,
  UNKNOWN_TIER_PEOPLE,
  WINDOW_MS,
  classifyRefusal,
  metaCodeOf,
  paceSend,
  pacedWords,
  priorityOf,
  throttleRetry,
} from "./wa-pacing-rules.ts";

/**
 * WhatsApp to a buyer: the reads and writes around `message-rules.ts`.
 *
 * Every message is a row before it is a request, so the timeline shows a
 * message that was refused (and why) as plainly as one that was read. A
 * refusal costs a query; nothing is sent to Meta until every gate has said
 * yes, in the order `gateMessage()` asks them.
 *
 * The phone number never reaches `audit_log`. What is audited is the
 * purpose, the category and the unit it would be billed as.
 */

export type SendResult =
  | { ok: true; messageId: string }
  | {
      ok: false;
      code:
        | "GONE"
        | "OPTED_OUT"
        | "NOT_ADVERTISABLE"
        | "OUTSIDE_HOURS"
        | "NO_CONSENT"
        | "MARKETING_STOPPED"
        | "CAP_30D"
        | "NOT_SWITCHED_ON"
        | "NOT_APPROVED"
        | "NO_CREDIT"
        | "NO_TIMES"
        | "NO_PICTURE"
        | "PACED"
        | "THROTTLED"
        | "FAILED";
      message: string;
      /** PACED and THROTTLED: when to ask again. A THROTTLED with none is given up. */
      retryAt?: string;
      /** THROTTLED: whether this try counts against the task's attempts. */
      counted?: boolean;
    };

const NOT_APPROVED = "Meta hasn't approved this message for this project's WhatsApp number yet, so it wasn't sent.";

/**
 * A stored refusal, in the words the client should read. Rows written before
 * the wording changed named our environment variables.
 */
export function messageErrorText(error: string | null): string | null {
  if (!error) return null;
  return error.startsWith("WhatsApp is not switched on yet") || error.startsWith("WhatsApp isn't connected for your account") ? WHATSAPP_OFF : error;
}

type LeadRow = {
  id: string;
  language: string | null;
  name: string;
  phone: string;
  stage: string;
  enquired_at: Date;
  scope_node_id: string;
  node_name: string;
  parent_name: string | null;
};

type VisitRow = { id: string; scheduled_at: Date; status: string; scope_node_id: string; location_id: string | null };

/** A contact number a buyer can ring: the hand-off line, else the brand kit's sales phone. */
async function contactFor(orgId: string, nodeId: string): Promise<string | null> {
  // The organisation's own hand-off number, never the environment's default:
  // that would hand one developer's buyer a stranger's phone.
  const own = await ownHandoffNumber(orgId, nodeId);
  if (own) return own;
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ sales_phone: string | null }[]>`
      SELECT b.sales_phone FROM brand_kits b
      JOIN scope_nodes n ON n.id = b.scope_node_id
      JOIN scope_nodes t ON t.id = ${nodeId} AND t.org_id = ${orgId}
      WHERE b.org_id = ${orgId} AND n.path @> t.path AND b.sales_phone IS NOT NULL
      ORDER BY nlevel(n.path) DESC LIMIT 1`;
    return r?.sales_phone ?? null;
  });
}

/**
 * The site's link: the gallery a visit names when it is still at or above
 * the tower, else the first gallery at the deepest level recorded.
 */
export async function directionsFor(orgId: string, nodeId: string, locationId?: string | null): Promise<string | null> {
  return withTenant(orgId, async (sql) => {
    const [r] = await sql<{ maps_url: string }[]>`
      SELECT s.maps_url FROM site_locations s
      JOIN scope_nodes n ON n.id = s.scope_node_id
      JOIN scope_nodes t ON t.id = ${nodeId} AND t.org_id = ${orgId}
      WHERE s.org_id = ${orgId} AND n.path @> t.path
      ORDER BY (s.id = ${locationId ?? null}::uuid) IS TRUE DESC, nlevel(n.path) DESC, s.created_at, s.id LIMIT 1`;
    return r?.maps_url ?? null;
  });
}

const whenOf = (at: Date) => {
  const { date, time } = ist(at.toISOString());
  return `${showDate(date)}, ${showTime(time)}`;
};

/**
 * Whether a business-initiated template from this number must wait for its
 * daily limit, and until when (`wa-pacing-rules.ts` decides). Counted from
 * the rows: every template this number sent in 24 hours that was not
 * refused or failed, messages and broadcasts alike, less the ones that
 * answered a buyer who had written in the 24 hours before.
 *
 * `atLimit` is Meta having said the limit is reached: the count is taken as
 * full whatever the rows say. A wait is recorded on the number for Today.
 */
async function paceCheck(o: {
  orgId: string;
  numberId: string;
  phone: string;
  purpose: MessagePurpose;
  inServiceWindow: boolean;
  nowMs: number;
  atLimit?: boolean;
}): Promise<(SendResult & { ok: false }) | null> {
  if (o.inServiceWindow) return null;
  const priority = priorityOf(o.purpose);
  const since = new Date(o.nowMs - WINDOW_MS);
  const read = await withTenant(o.orgId, async (sql) => {
    const [n] = await sql<{ display_phone: string; daily_limit: string | null }[]>`
      SELECT display_phone, daily_limit FROM whatsapp_numbers WHERE org_id = ${o.orgId} AND id = ${o.numberId}`;
    const tier = readTier(n?.daily_limit);
    const limit = tier ? tierPeople(tier) : UNKNOWN_TIER_PEOPLE;
    if (limit === null) return { display: n?.display_phone ?? null, limit, reached: 0, already: false, oldest: [] as number[] };
    const reached = sql`
      SELECT m.phone, max(m.created_at) AS last FROM messages m
      WHERE m.org_id = ${o.orgId} AND m.number_id = ${o.numberId} AND m.direction = 'OUT' AND m.channel = 'WHATSAPP'
        AND m.template IS NOT NULL AND m.status NOT IN ('REFUSED', 'FAILED') AND m.created_at > ${since}
        AND NOT EXISTS (
          SELECT 1 FROM messages i
          WHERE i.org_id = m.org_id AND i.phone = m.phone AND i.direction = 'IN'
            AND i.created_at > m.created_at - interval '24 hours' AND i.created_at <= m.created_at)
      GROUP BY m.phone`;
    const [c] = await sql<{ n: number; already: boolean | null }[]>`
      SELECT count(*)::int AS n, bool_or(r.phone = ${o.phone}) AS already FROM (${reached}) r`;
    const count = o.atLimit ? Math.max(c?.n ?? 0, limit) : (c?.n ?? 0);
    const verdict0 = paceSend({ limit, reached: count, alreadyReached: !o.atLimit && !!c?.already, inServiceWindow: false, priority, oldest: [], now: o.nowMs });
    if (verdict0.ok) return { display: n?.display_phone ?? null, limit, reached: count, already: !o.atLimit && !!c?.already, oldest: [] as number[] };
    const rows = await sql<{ last: Date }[]>`SELECT r.last FROM (${reached}) r ORDER BY r.last LIMIT ${OLDEST_READ}`;
    return { display: n?.display_phone ?? null, limit, reached: count, already: false, oldest: rows.map((r) => r.last.getTime()) };
  });
  const verdict = paceSend({
    limit: read.limit,
    reached: read.reached,
    alreadyReached: read.already,
    inServiceWindow: false,
    priority,
    oldest: read.oldest,
    now: o.nowMs,
  });
  if (verdict.ok) return null;
  const until = new Date(verdict.untilMs);
  // Today says the number reached its limit while anything waits on it.
  await withTenant(o.orgId, (sql) => sql`
    UPDATE whatsapp_numbers SET paced_at = ${new Date(o.nowMs)},
           paced_until = CASE WHEN paced_until > ${new Date(o.nowMs)} THEN greatest(paced_until, ${until}) ELSE ${until} END
    WHERE org_id = ${o.orgId} AND id = ${o.numberId}`);
  return { ok: false, code: "PACED", message: pacedWords(read.display ? showPhone(read.display) : null), retryAt: until.toISOString() };
}

/**
 * Send one template to a lead, or record why not.
 *
 * `visitId` names the visit a visit message is about; without one the
 * lead's next confirmed visit is used.
 */
export async function sendMessage(opts: {
  orgId: string;
  leadId: string;
  purpose: MessagePurpose;
  nowIso?: string;
  taskId?: string | null;
  visitId?: string | null;
  userId?: string | null;
  nextStep?: string | null;
  /** The three times a slot offer names, each with the payload its button sends back. */
  slots?: { label: string; payload: string }[];
  /** Values the caller worked out (an EMI, a lender's name), each from signed facts. */
  extra?: Partial<Record<"unit" | "loan" | "rate" | "emi_15" | "emi_20" | "emi_25" | "lender" | "advisor" | "amount" | "link" | "flat" | "highlights" | "registration", string>>;
  /** What each quick-reply button sends back, when they are not times. */
  buttonPayloads?: string[];
  /** Meta said the buyer is not on WhatsApp: send this service message as an SMS, if there is one. */
  smsFor?: { metaError: number };
  /** The picture a template with a picture header carries, as a JPEG. */
  headerImage?: Buffer;
}): Promise<SendResult> {
  const { orgId, leadId, purpose } = opts;
  const now = opts.nowIso ?? new Date().toISOString();
  const found = await withTenant(orgId, async (sql) => {
    const [lead] = await sql<LeadRow[]>`
      SELECT l.id, l.name, l.phone, l.stage, l.enquired_at, l.scope_node_id, l.language,
             n.name AS node_name, p.name AS parent_name
      FROM leads l JOIN scope_nodes n ON n.id = l.scope_node_id
      LEFT JOIN scope_nodes p ON p.id = n.parent_id AND p.kind = 'PROJECT'
      WHERE l.org_id = ${orgId} AND l.id = ${leadId}`;
    if (!lead) return null;
    const [consents, [opt], [inbound], visits, [org]] = await Promise.all([
      sql<{ channels: string[]; captured_at: Date; expires_at: Date | null }[]>`
        SELECT channels, captured_at, expires_at FROM lead_consents WHERE org_id = ${orgId} AND phone = ${lead.phone}`,
      sql<{ n: number }[]>`SELECT count(*)::int AS n FROM call_suppressions WHERE org_id = ${orgId} AND phone = ${lead.phone}`,
      sql<{ at: Date | null }[]>`
        SELECT max(created_at) AS at FROM messages
        WHERE org_id = ${orgId} AND phone = ${lead.phone} AND direction = 'IN'`,
      sql<VisitRow[]>`
        SELECT id, scheduled_at, status, scope_node_id, location_id FROM site_visits
        WHERE org_id = ${orgId} AND lead_id = ${leadId}
        ORDER BY (id = ${opts.visitId ?? "00000000-0000-0000-0000-000000000000"}) DESC, scheduled_at DESC
        LIMIT 5`,
      sql<{ display_name: string }[]>`SELECT display_name FROM orgs WHERE id = ${orgId}`,
    ]);
    return { lead, consents, optedOut: (opt?.n ?? 0) > 0, lastInboundAt: inbound?.at ?? null, visits, developer: org?.display_name ?? "" };
  });
  if (!found) return { ok: false, code: "GONE", message: "That lead no longer exists." };
  const { lead } = found;
  // English, Hinglish or Marathi, by the language the lead speaks.
  const voice = voiceFor(lead.language);
  const template = versionOf(TEMPLATES[purpose], voice);

  const visit =
    (opts.visitId ? found.visits.find((v) => v.id === opts.visitId) : undefined) ??
    found.visits.find((v) => v.status === "CONFIRMED") ??
    found.visits[0] ??
    null;
  const nowMs = Date.parse(now);
  const liveVisit = found.visits.some(
    (v) =>
      (v.status === "CONFIRMED" || v.status === "ON_SITE") ||
      ((v.status === "VISITED" || v.status === "NO_SHOW") && nowMs - v.scheduled_at.getTime() <= 7 * 86_400_000),
  );

  const policy = await policyAt(orgId, lead.scope_node_id);
  const gate = template.namesProject ? await canPublish(orgId, lead.scope_node_id) : { ok: true as const };
  const verdict = gateMessage({
    template,
    nowIso: now,
    optedOut: found.optedOut,
    consentRequired: policy.consentRequired,
    consents: found.consents.map((c) => ({
      channels: c.channels,
      capturedAt: c.captured_at.toISOString(),
      expiresAt: c.expires_at?.toISOString() ?? null,
    })),
    enquiredAt: lead.enquired_at.toISOString(),
    lastInboundAt: found.lastInboundAt?.toISOString() ?? null,
    liveVisit,
    booked: lead.stage === "booked",
    advertisable: gate.ok,
  });

  const project = lead.parent_name ? `${lead.parent_name} ${lead.node_name}` : lead.node_name;
  const contact = template.blanks.includes("contact") ? await contactFor(orgId, lead.scope_node_id) : null;
  // The way to the gallery the visit is at, where there is a visit.
  const directions = template.blanks.includes("directions")
    ? await directionsFor(orgId, visit?.scope_node_id ?? lead.scope_node_id, visit?.location_id ?? null)
    : null;
  const values = fill(template, {
    first_name: lead.name.split(/\s+/)[0] === "Buyer" ? null : lead.name.split(/\s+/)[0],
    project,
    developer: found.developer,
    when: visit ? whenOf(visit.scheduled_at) : null,
    directions: directions ?? FILL_INS[voice].directions,
    contact: contact ? showPhone(contact) : FILL_INS[voice].contact,
    next_step: nextStepIn(opts.nextStep, voice),
    pass: template.blanks.includes("pass") && visit ? passLink(orgId, visit.id) : null,
    slot_1: opts.slots?.[0]?.label ?? null,
    slot_2: opts.slots?.[1]?.label ?? null,
    slot_3: opts.slots?.[2]?.label ?? null,
    ...opts.extra,
  });
  const body = render(template, values);
  // A template with buttons names one time per button; with fewer free
  // times than buttons there is nothing honest to send.
  const buttons = template.buttons?.length
    ? (opts.buttonPayloads ?? (opts.slots ?? []).map((x) => x.payload)).slice(0, template.buttons.length)
    : undefined;

  // The developer's own number for this tower. There is no shared one.
  let numberId: string | null = null;
  const record = async (status: "QUEUED" | "REFUSED", error: string | null) =>
    withTenant(orgId, async (sql) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO messages (org_id, lead_id, task_id, direction, channel, purpose, template, category, language,
                              variables, body, phone, status, error, cost_paise, sent_by, number_id)
        VALUES (${orgId}, ${leadId}, ${opts.taskId ?? null}, 'OUT', 'WHATSAPP', ${purpose}, ${template.name},
                ${template.category}, 'en', ${sql.json(values)}, ${body}, ${lead.phone}, ${status}, ${error},
                ${status === "QUEUED" ? PRICE_PAISE[template.category] : null}, ${opts.userId ?? null}, ${numberId})
        RETURNING id`;
      return row.id;
    });

  if (!verdict.ok) {
    await record("REFUSED", verdict.message);
    return { ok: false, code: verdict.code, message: verdict.message };
  }

  // A service message WhatsApp could not carry goes as an SMS from the
  // developer's own DLT registration, when there is one. Every gate above
  // stands for it too.
  const viaSms = async (why: { code?: string; metaError?: number }) => {
    const { smsFallback } = await import("./sms.ts");
    const contact = await contactFor(orgId, lead.scope_node_id);
    const sms = await smsFallback({
      orgId,
      leadId,
      nodeId: lead.scope_node_id,
      phone: lead.phone,
      purpose,
      voice,
      values: {
        first_name: lead.name.split(/\s+/)[0] === "Buyer" ? null : lead.name.split(/\s+/)[0],
        developer: found.developer || null,
        project,
        when: visit ? whenOf(visit.scheduled_at) : null,
        pass: visit ? passLink(orgId, visit.id) : null,
        contact: contact ? showPhone(contact) : null,
      },
      why,
      basis: verdict.basis ?? null,
      registration: template.namesProject ? "ADVERTISABLE" : "NOT_NAMED",
      taskId: opts.taskId ?? null,
      userId: opts.userId ?? null,
    });
    return sms?.ok ? ({ ok: true, messageId: sms.messageId } as const) : null;
  };
  if (opts.smsFor) {
    return (await viaSms({ metaError: opts.smsFor.metaError })) ?? { ok: false, code: "NOT_SWITCHED_ON", message: "No SMS could be sent instead." };
  }
  // A promotion also answers to the buyer's "Stop promotions" and to the
  // cap broadcasts share with the drip: four in thirty days, whatever sent
  // them. Only a promotion: a token link Meta files as marketing is not one.
  if (template.promotional) {
    const { marketingStopped, marketingSent30d } = await import("./broadcast.ts");
    if (await marketingStopped(orgId, lead.phone)) {
      const message = "This buyer stopped promotions.";
      await record("REFUSED", message);
      return { ok: false, code: "MARKETING_STOPPED", message };
    }
    if ((await marketingSent30d(orgId, lead.phone, new Date(now))) >= CAP_MARKETING_30D) {
      const message = "This buyer already had four promotional messages this month.";
      await record("REFUSED", message);
      return { ok: false, code: "CAP_30D", message };
    }
  }
  if (template.buttons?.length && (buttons?.length ?? 0) < template.buttons.length) {
    const message = "No free times to offer this week.";
    await record("REFUSED", message);
    return { ok: false, code: "NO_TIMES", message };
  }
  const sender = await senderFor(orgId, lead.scope_node_id);
  if (!sender.ok) {
    await record("REFUSED", sender.message);
    const sms = await viaSms({ code: "NOT_SWITCHED_ON" });
    if (sms) return sms;
    return { ok: false, code: "NOT_SWITCHED_ON", message: sender.message };
  }
  numberId = sender.numberId;
  // Sending a template Meta has not approved costs nothing and reaches
  // nobody, so it is refused here, where the reason can be said plainly.
  if (!sender.approved(template.name, "en")) {
    await record("REFUSED", NOT_APPROVED);
    const sms = await viaSms({ code: "NOT_APPROVED" });
    if (sms) return sms;
    return { ok: false, code: "NOT_APPROVED", message: NOT_APPROVED };
  }

  // A project on a plan pays for WhatsApp from its top-ups, at Meta's price
  // plus 15%, so the credit is asked for before Meta is.
  const credit = await messageAllowed(orgId, lead.scope_node_id, PRICE_PAISE[template.category]);
  if (!credit.ok) {
    await record("REFUSED", credit.message);
    return { ok: false, code: "NO_CREDIT", message: credit.message };
  }

  // A template that starts a conversation counts against the number's
  // daily limit. One that would go over waits for the window, and Meta is
  // not asked; an answer inside the buyer's 24 hours starts nothing.
  const inServiceWindow = found.lastInboundAt !== null && nowMs - found.lastInboundAt.getTime() < WINDOW_MS;
  const paced = await paceCheck({ orgId, numberId: sender.numberId, phone: lead.phone, purpose, inServiceWindow, nowMs });
  if (paced) return paced;

  if (template.header === "IMAGE" && !opts.headerImage) {
    const message = "There is no approved picture to send with this message.";
    await record("REFUSED", message);
    return { ok: false, code: "NO_PICTURE", message };
  }

  const messageId = await record("QUEUED", null);
  try {
    // A picture header is uploaded to Meta's store on this number and sent by id.
    const header = opts.headerImage
      ? await uploadMedia(sender.config, { bytes: opts.headerImage, mediaType: "image/jpeg", filename: "picture.jpg" })
      : null;
    const { id } = await whatsapp().sendTemplate(sender.config, {
      to: lead.phone,
      template: template.name,
      language: "en",
      params: values,
      callbackData: `${orgId}:${messageId}`,
      ...(buttons ? { buttons } : {}),
      ...(header ? { headerImage: { id: header.id } } : {}),
    });
    await withTenant(orgId, (sql) => sql`
      UPDATE messages SET status = 'SENT', provider_id = ${id}, sent_at = now()
      WHERE org_id = ${orgId} AND id = ${messageId}`);
  } catch (e) {
    // The provider's own words go to the log, not onto the lead's history.
    console.warn(`whatsapp: send failed for message ${messageId},`, (e instanceof Error ? e.message : String(e)).slice(0, 500));
    // "Not now" is not "never": Meta's throttles are tried again with
    // backoff, and its messaging limit waits like a send held back above.
    const refusal = classifyRefusal(metaCodeOf(e), e instanceof Error ? e.message : String(e));
    if (refusal === "TIER") {
      const held = await paceCheck({ orgId, numberId: sender.numberId, phone: lead.phone, purpose, inServiceWindow: false, nowMs, atLimit: true });
      const words = held?.message ?? pacedWords(null);
      await withTenant(orgId, (sql) => sql`
        UPDATE messages SET status = 'FAILED', error = ${words}, cost_paise = NULL
        WHERE org_id = ${orgId} AND id = ${messageId}`);
      return held ?? { ok: false, code: "PACED", message: words, retryAt: new Date(nowMs + WINDOW_MS).toISOString() };
    }
    if (refusal === "THROTTLED") {
      const taskId = opts.taskId ?? null;
      const prior: { created_at: Date }[] = taskId
        ? await withTenant(orgId, async (sql) => sql<{ created_at: Date }[]>`
            SELECT created_at FROM messages
            WHERE org_id = ${orgId} AND task_id = ${taskId} AND id <> ${messageId} AND error = ${THROTTLED_WORDS}`)
        : [];
      await withTenant(orgId, (sql) => sql`
        UPDATE messages SET status = 'FAILED', error = ${THROTTLED_WORDS}, cost_paise = NULL
        WHERE org_id = ${orgId} AND id = ${messageId}`);
      // Only the engine tries again; a person's own press is told and decides.
      if (!opts.taskId) return { ok: false, code: "THROTTLED", message: THROTTLED_WORDS };
      const next = throttleRetry(prior.map((p) => p.created_at.getTime()), nowMs);
      if (next.giveUp) return { ok: false, code: "THROTTLED", message: "WhatsApp kept this number busy for a day. It was not sent." };
      return { ok: false, code: "THROTTLED", message: THROTTLED_WORDS, retryAt: new Date(next.retryAtMs).toISOString(), counted: next.counted };
    }
    const reason = "WhatsApp did not accept this message. It was not sent.";
    await withTenant(orgId, (sql) => sql`
      UPDATE messages SET status = 'FAILED', error = ${reason}, cost_paise = NULL
      WHERE org_id = ${orgId} AND id = ${messageId}`);
    return { ok: false, code: "FAILED", message: reason };
  }
  await withTenant(orgId, (sql) => sql`UPDATE leads SET last_activity_at = now() WHERE org_id = ${orgId} AND id = ${leadId}`);
  await audit({
    orgId,
    actorUserId: opts.userId ?? null,
    action: "message.sent",
    targetType: "message",
    targetId: messageId,
    metadata: { purpose, basis: verdict.basis, unit: `whatsapp_${template.category.toLowerCase()}` },
  });
  return { ok: true, messageId };
}

// ---------------------------------------------------------------------------
// The webhook: receipts and replies
// ---------------------------------------------------------------------------

/**
 * Meta could not deliver a service message because the buyer is not on
 * WhatsApp: the same message, asked every gate again, goes as an SMS. Once:
 * a receipt delivered twice finds the SMS the first one sent.
 */
async function smsAfterFailure(orgId: string, messageId: string): Promise<void> {
  const [m] = await withTenant(orgId, (sql) => sql<{ lead_id: string | null; purpose: string | null; task_id: string | null; done: boolean }[]>`
    SELECT m.lead_id, m.purpose, m.task_id,
           EXISTS (SELECT 1 FROM messages s WHERE s.org_id = m.org_id AND s.lead_id = m.lead_id AND s.channel = 'SMS'
                     AND s.purpose = m.purpose AND s.created_at >= m.created_at) AS done
    FROM messages m WHERE m.org_id = ${orgId} AND m.id = ${messageId} AND m.channel = 'WHATSAPP' AND m.direction = 'OUT'`);
  if (!m?.lead_id || !m.purpose || m.done || !fallsBack(m.purpose, { metaError: NOT_ON_WHATSAPP })) return;
  await sendMessage({ orgId, leadId: m.lead_id, purpose: m.purpose as MessagePurpose, taskId: m.task_id, smsFor: { metaError: NOT_ON_WHATSAPP } });
}

/** Who connected the number a webhook names: one SECURITY DEFINER lookup, ids only. */
async function numberOwners(phoneNumberId: string): Promise<{ org_id: string; number_id: string }[]> {
  return withNoTenant((sql) => sql<{ org_id: string; number_id: string }[]>`
    SELECT org_id, number_id FROM whatsapp_number_owner(${phoneNumberId})`);
}

const ORDER = ["QUEUED", "SENT", "DELIVERED", "READ"];

/**
 * Delivery receipts move a message forward only, since Meta may deliver
 * "read" before "delivered". Replies land on the lead that was written to,
 * and a STOP is an opt-out for every lead on that number in that tenant.
 */
export async function ingestWhatsApp(body: unknown): Promise<{ statuses: number; replies: number; stops: number }> {
  const { statuses, inbound } = readWhatsAppWebhook(body);
  const out = { statuses: 0, replies: 0, stops: 0 };

  for (const s of statuses) {
    const fromCallback = /^([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(s.callbackData ?? "");
    // The callback we attached names the tenant, but it is trusted only when
    // the number the receipt came through belongs to that tenant too.
    const owners = s.phoneNumberId ? await numberOwners(s.phoneNumberId) : [];
    const orgId =
      (fromCallback && (!s.phoneNumberId || owners.some((o) => o.org_id === fromCallback[1])) ? fromCallback[1] : null) ??
      owners[0]?.org_id ??
      (s.phoneNumberId
        ? null
        : await withNoTenant(async (sql) => {
            const [r] = await sql<{ org: string | null }[]>`SELECT message_org(${s.id}) AS org`;
            return r?.org ?? null;
          }));
    if (!orgId) continue;
    const next = s.status.toUpperCase();
    const at = new Date(s.at);
    const n = await withTenant(orgId, (sql) => sql<{ id: string; status: string }[]>`
      UPDATE messages SET
        status = CASE
          WHEN ${next} = 'FAILED' THEN 'FAILED'
          WHEN array_position(${ORDER}::text[], status) < array_position(${ORDER}::text[], ${next}) THEN ${next}
          ELSE status END,
        delivered_at = CASE WHEN ${next} IN ('DELIVERED', 'READ') THEN coalesce(delivered_at, ${at}) ELSE delivered_at END,
        read_at = CASE WHEN ${next} = 'READ' THEN coalesce(read_at, ${at}) ELSE read_at END,
        error = CASE WHEN ${next} = 'FAILED' THEN ${s.error ?? "Not delivered"} ELSE error END,
        cost_paise = CASE WHEN ${next} = 'FAILED' THEN NULL ELSE cost_paise END
      WHERE org_id = ${orgId} AND direction = 'OUT'
        AND (provider_id = ${s.id} OR id::text = ${fromCallback?.[2] ?? ""})
      RETURNING id, status`);
    out.statuses += n.count;
    // Meta charges for a message it delivered, so that is when it is counted.
    for (const m of n) if (m.status === "DELIVERED" || m.status === "READ") await meterMessage(orgId, m.id);
    // A buyer who is not on WhatsApp gets a service message as an SMS instead.
    if (next === "FAILED" && s.errorCode === NOT_ON_WHATSAPP) for (const m of n) await smsAfterFailure(orgId, m.id);
  }

  for (const m of inbound) {
    // A buyer writes to one developer's number, and the number names the
    // tenant. A message to a number nobody here connected is nobody's.
    const owners = m.phoneNumberId ? await numberOwners(m.phoneNumberId) : [];
    const stop = isStop(m.text);
    // A tap on one of the times a slot offer named books it; it is not a
    // reply a person needs to read.
    const holdId = stop ? null : holdFromPayload(m.payload);
    const lenderTap = stop ? null : readLenderPayload(m.payload);
    // A yes or no to the partner hearing how the loan is going.
    const shareTap = stop ? null : readLoanSharePayload(m.payload);
    // A tap on "Send the details" asks for the pictures and the details now.
    const detailsTap = stop ? null : readDetailsPayload(m.payload);
    // "Stop promotions" on a broadcast stops advertising, not the visit reminders.
    const promoStop = !stop && (isStopPayload(m.payload) || isStopPromotions(m.text));
    for (const { org_id: orgId, number_id: numberId } of owners) {
      const landed = await withTenant(orgId, async (sql) => {
        const [lead] = await sql<{ id: string }[]>`
          SELECT id FROM leads WHERE org_id = ${orgId} AND phone = ${m.from}
          ORDER BY last_activity_at DESC LIMIT 1`;
        const [inserted] = await sql<{ id: string }[]>`
          INSERT INTO messages (org_id, lead_id, direction, channel, category, body, phone, status, provider_id, created_at,
                                number_id, wa_user_id)
          VALUES (${orgId}, ${lead?.id ?? null}, 'IN', 'WHATSAPP', 'SERVICE', ${m.text}, ${m.from}, 'RECEIVED', ${m.id}, ${new Date(m.at)},
                  ${numberId}, ${m.userId})
          ON CONFLICT (provider_id) WHERE provider_id IS NOT NULL DO NOTHING
          RETURNING id`;
        if (!inserted) return null;
        // A person at a channel partner firm talks to the bot, not to sales.
        const [agent] = await sql<{ id: string }[]>`
          SELECT id FROM partner_agents WHERE org_id = ${orgId} AND phone = ${m.from} AND status <> 'REMOVED'`;
        if (agent) return { messageId: inserted.id, lead: null, partner: true };
        if (stop) {
          await sql`
            INSERT INTO call_suppressions (org_id, phone, reason)
            VALUES (${orgId}, ${m.from}, 'WHATSAPP_STOP')
            ON CONFLICT (org_id, phone) DO NOTHING`;
          await sql`
            UPDATE lead_tasks SET state = 'CANCELLED', result = 'The buyer asked to stop', done_at = now()
            WHERE org_id = ${orgId} AND state = 'DUE'
              AND lead_id IN (SELECT id FROM leads WHERE org_id = ${orgId} AND phone = ${m.from})`;
        } else if (lead && !holdId && !lenderTap && !shareTap && !detailsTap && !promoStop) {
          const said = m.text.length > 90 ? `${m.text.slice(0, 87)}...` : m.text;
          await sql`
            UPDATE leads SET needs_person = ${`Replied on WhatsApp: "${said}"`.slice(0, 200)},
                             last_activity_at = now(), updated_at = now()
            WHERE org_id = ${orgId} AND id = ${lead.id}`;
        }
        return { messageId: inserted.id, lead: lead?.id ?? null, partner: false };
      });
      if (!landed) continue;
      if (promoStop && !landed.partner) {
        const { recordMarketingStop } = await import("./broadcast.ts");
        await recordMarketingStop({ orgId, phone: m.from, source: "BUTTON" });
        out.stops += 1;
        continue;
      }
      if (shareTap && landed.lead) {
        const { onLoanShareAnswer } = await import("./loans.ts");
        await onLoanShareAnswer({ orgId, loanId: shareTap.loanId, yes: shareTap.yes, phone: m.from });
        out.replies += 1;
        continue;
      }
      if (lenderTap && landed.lead) {
        const { onLenderAnswer } = await import("./visit-followups.ts");
        await onLenderAnswer({ orgId, referralId: lenderTap.referralId, yes: lenderTap.yes, phone: m.from });
        out.replies += 1;
        continue;
      }
      if (detailsTap && landed.lead) {
        const { sendDetails } = await import("./project-details.ts");
        // The tap names the lead it was sent to; one this number does not own is not answered.
        const own = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
          SELECT id FROM leads WHERE org_id = ${orgId} AND id = ${detailsTap} AND phone = ${m.from}`);
        const r = own.length ? await sendDetails({ orgId, leadId: detailsTap, pack: true }) : null;
        if (r && !r.ok) {
          await withTenant(orgId, (sql) => sql`
            UPDATE leads SET needs_person = ${`Asked for the project details on WhatsApp. ${r.message}`.slice(0, 200)},
                             last_activity_at = now(), updated_at = now()
            WHERE org_id = ${orgId} AND id = ${detailsTap}`);
        }
        out.replies += 1;
        continue;
      }
      if (holdId && landed.lead) {
        const { onSlotChosen } = await import("./lead-engine.ts");
        const booked = await onSlotChosen({ orgId, holdId, phone: m.from });
        if (!booked) {
          await withTenant(orgId, (sql) => sql`
            UPDATE leads SET needs_person = ${`Picked "${m.text.slice(0, 40)}", which was no longer free. Fix the visit`.slice(0, 200)},
                             last_activity_at = now(), updated_at = now()
            WHERE org_id = ${orgId} AND id = ${landed.lead}`);
        }
        out.replies += 1;
        continue;
      }
      // The partner's bot, or a buyer arriving through a partner's link.
      const inbound = { orgId, numberId, messageId: landed.messageId, providerId: m.id, from: m.from, text: m.text, at: m.at, profileName: m.profileName };
      let tapped = false;
      if (landed.partner || !stop) {
        const { partnerInbound } = await import("./partner-bot.ts");
        const who = await partnerInbound(inbound);
        if (who === "agent") continue;
        tapped = who === "tap";
      }
      // A buyer who tapped a Click-to-WhatsApp ad: the chat is the enquiry.
      // It becomes a lead event of its own, through the ordinary capture, so
      // the ownership rules decide whether it is new and the ad it names
      // decides the tower.
      if (!stop && !tapped && !landed.partner && m.referral?.sourceType === "ad" && m.referral.sourceId) {
        const { recordEvent } = await import("./leads.ts");
        const { processEvent } = await import("./lead-engine.ts");
        const ev = await recordEvent({
          orgId,
          source: "WHATSAPP",
          externalId: m.id,
          payload: { from: m.from, name: m.profileName, messageId: m.id, at: m.at, adId: m.referral.sourceId, ctwaClid: m.referral.ctwaClid },
        });
        if (ev.fresh) {
          const made = await processEvent(orgId, ev.id);
          if (made.ok) {
            await withTenant(orgId, (sql) => sql`
              UPDATE messages SET lead_id = ${made.leadId} WHERE org_id = ${orgId} AND id = ${landed.messageId} AND lead_id IS NULL`);
          }
        }
        out.replies += 1;
        continue;
      }
      if (stop) {
        out.stops += 1;
        await audit({ orgId, actorUserId: null, action: "message.opted_out", targetType: "lead", targetId: landed.lead, metadata: { channel: "whatsapp" } });
      } else {
        out.replies += 1;
        // A reply is engagement: the score is worked out again, no model asked.
        if (landed.lead) {
          const { rescoreOnReply } = await import("./qualify.ts");
          await rescoreOnReply(orgId, landed.lead).catch(() => undefined);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type MessageView = {
  id: string;
  direction: "OUT" | "IN";
  channel: "WHATSAPP" | "SMS";
  purpose: string | null;
  label: string;
  body: string;
  status: string;
  error: string | null;
  at: string;
};

export async function listLeadMessages(orgId: string, leadId: string): Promise<MessageView[]> {
  const rows = await withTenant(orgId, (sql) => sql<
    { id: string; direction: "OUT" | "IN"; channel: "WHATSAPP" | "SMS"; purpose: string | null; body: string; status: string; error: string | null; created_at: Date }[]
  >`
    SELECT id, direction, channel, purpose, body, status, error, created_at FROM messages
    WHERE org_id = ${orgId} AND lead_id = ${leadId}
    ORDER BY created_at DESC LIMIT 200`);
  return rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    channel: r.channel,
    purpose: r.purpose,
    label:
      r.direction === "IN"
        ? "Buyer replied"
        : r.purpose === "FROM_APP"
          ? "Sent from the WhatsApp app"
          : r.purpose === "BROADCAST"
            ? "Broadcast"
            : TEMPLATES[r.purpose as MessagePurpose]?.label ?? "WhatsApp",
    body: r.body,
    status: r.status,
    error: messageErrorText(r.error),
    at: r.created_at.toISOString(),
  }));
}
