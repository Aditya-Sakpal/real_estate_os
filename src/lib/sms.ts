import { createHash } from "node:crypto";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { audit, withTenant } from "./db/index.ts";
import { messageAllowed, meterQuietly } from "./billing.ts";
import { signRequest, type AwsCredentials } from "./aws-sign.ts";
import {
  MAX_SMS_PARTS,
  SMS_MAX_PRICE_USD,
  SMS_PURPOSES,
  SMS_TEMPLATES,
  fallsBack,
  fillSms,
  smsParts,
  smsPrice,
  smsTemplateState,
  type SmsBlank,
  type SmsPurpose,
  type SmsTemplateState,
} from "./sms-rules.ts";
import { VOICES, type MessagePurpose, type Voice } from "./message-rules.ts";

/**
 * SMS: the reads and writes around `sms-rules.ts`, and the one call to AWS
 * End User Messaging.
 *
 * An SMS goes only as a service message's fallback, from the developer's
 * own DLT registration (their Principal Entity id, their header, the id of
 * the template they registered), and through our AWS account. Every SMS is
 * a row in `messages` before it is a request, on the lead's one history,
 * and every one is audited with the header, the template id, the consent it
 * rests on and the registration's state, never the number.
 */

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export type SmsSend = {
  to: string;
  body: string;
  header: string;
  entityId: string;
  templateId: string;
  /** Names the tenant and the message, for AWS's own event records. */
  context: Record<string, string>;
};

export type SmsDriver = { send(input: SmsSend): Promise<{ id: string }> };

let injected: SmsDriver | null = null;

/** The checks' seam: an injected driver beats AWS. */
export function useSms(driver: SmsDriver | null): void {
  injected = driver;
}

const SMS_TIMEOUT_MS = 10_000;

/** AWS End User Messaging, `SendTextMessage`, signed by hand. */
function awsDriver(region: string): SmsDriver {
  let creds: (() => Promise<AwsCredentials>) | null = null;
  const credentials = () => {
    const profile = process.env.AWS_SMS_PROFILE?.trim();
    creds ??= profile ? fromIni({ profile }) : fromNodeProviderChain();
    return creds();
  };
  return {
    async send(input) {
      const host = `sms-voice.${region}.amazonaws.com`;
      const body = JSON.stringify({
        DestinationPhoneNumber: input.to,
        OriginationIdentity: input.header,
        MessageBody: input.body,
        MessageType: "TRANSACTIONAL",
        // The most AWS may charge for a part before it refuses to send.
        MaxPrice: SMS_MAX_PRICE_USD,
        DestinationCountryParameters: { IN_ENTITY_ID: input.entityId, IN_TEMPLATE_ID: input.templateId },
        Context: input.context,
        ...(process.env.SMS_CONFIGURATION_SET ? { ConfigurationSetName: process.env.SMS_CONFIGURATION_SET } : {}),
      });
      const headers = signRequest({
        method: "POST",
        host,
        path: "/",
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "PinpointSMSVoiceV2.SendTextMessage",
        },
        body,
        region,
        service: "sms-voice",
        credentials: await credentials(),
        now: new Date(),
      });
      const res = await fetch(`https://${host}/`, { method: "POST", headers, body, signal: AbortSignal.timeout(SMS_TIMEOUT_MS) });
      const json = (await res.json().catch(() => ({}))) as { MessageId?: string; message?: string; Message?: string; __type?: string };
      if (!res.ok || !json.MessageId) {
        throw new Error(`${json.__type ?? res.status}: ${json.message ?? json.Message ?? "no answer"}`.slice(0, 300));
      }
      return { id: json.MessageId };
    },
  };
}

/** The driver, or null when SMS is not switched on for this deployment. */
function driver(): SmsDriver | null {
  if (injected) return injected;
  const region = process.env.SMS_AWS_REGION?.trim();
  return region ? awsDriver(region) : null;
}

export const smsSwitchedOn = () => driver() !== null;

// ---------------------------------------------------------------------------
// The developer's registration
// ---------------------------------------------------------------------------

/** The words a template id pins. */
export const smsHash = (purpose: SmsPurpose, voice: Voice) =>
  createHash("sha256").update(JSON.stringify([purpose, voice, SMS_TEMPLATES[purpose].body[voice]])).digest("hex");

type SenderRow = { id: string; scope_node_id: string; node_path: string; node_name: string; dlt_entity_id: string; header: string };
type TemplateRow = { id: string; purpose: SmsPurpose; voice: Voice; dlt_template_id: string; body_sha256: string };

/** The registration that sends at `nodeId`: the deepest one at or above it. */
async function senderAt(orgId: string, nodeId: string): Promise<(SenderRow & { templates: TemplateRow[] }) | null> {
  return withTenant(orgId, async (sql) => {
    const [s] = await sql<SenderRow[]>`
      SELECT s.id, s.scope_node_id, n.path::text AS node_path, n.name AS node_name, s.dlt_entity_id, s.header
      FROM sms_senders s
      JOIN scope_nodes n ON n.id = s.scope_node_id
      JOIN scope_nodes t ON t.id = ${nodeId} AND t.org_id = ${orgId}
      WHERE s.org_id = ${orgId} AND s.status = 'ACTIVE' AND n.path @> t.path
      ORDER BY nlevel(n.path) DESC LIMIT 1`;
    if (!s) return null;
    const templates = await sql<TemplateRow[]>`
      SELECT id, purpose, voice, dlt_template_id, body_sha256 FROM sms_templates
      WHERE org_id = ${orgId} AND sender_id = ${s.id} AND status = 'ACTIVE'`;
    return { ...s, templates };
  });
}

/** The template to send in: the buyer's version, else English, and only if its words still match. */
function templateFor(templates: TemplateRow[], purpose: SmsPurpose, voice: Voice): TemplateRow | null {
  for (const v of voice === "ENGLISH" ? ["ENGLISH" as const] : [voice, "ENGLISH" as const]) {
    const row = templates.find((t) => t.purpose === purpose && t.voice === v);
    if (row && row.body_sha256 === smsHash(purpose, v)) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The fallback
// ---------------------------------------------------------------------------

export type SmsResult = { ok: true; messageId: string } | { ok: false; code: string; message: string };

/**
 * A service message WhatsApp could not carry, sent as an SMS instead, or
 * null when there is no SMS to send (not a message that falls back, SMS not
 * switched on, no registration here). The gates the WhatsApp message passed
 * (the opt-out, consent, the project's registration) stand for this too;
 * what is asked here is what an SMS adds: the words filled, the parts, the
 * credit.
 */
export async function smsFallback(o: {
  orgId: string;
  leadId: string;
  nodeId: string;
  phone: string;
  purpose: MessagePurpose;
  voice: Voice;
  values: Partial<Record<SmsBlank, string | null>>;
  why: { code?: string | null; metaError?: number | null };
  /** Why it may be sent: the basis the message gate gave. */
  basis: string | null;
  /** Whether the project's registration was asked, and what it said. */
  registration: "ADVERTISABLE" | "NOT_NAMED";
  taskId?: string | null;
  userId?: string | null;
}): Promise<SmsResult | null> {
  if (!fallsBack(o.purpose, o.why)) return null;
  const send = driver();
  if (!send) return null;
  const sender = await senderAt(o.orgId, o.nodeId);
  if (!sender) return null;
  const template = templateFor(sender.templates, o.purpose, o.voice);
  if (!template) return null;

  const filled = fillSms(o.purpose, template.voice, o.values);
  const text = filled.ok ? filled.text : SMS_TEMPLATES[o.purpose].body[template.voice];
  const { parts } = smsParts(text);
  const price = smsPrice(parts);

  const record = async (status: "QUEUED" | "REFUSED", error: string | null) =>
    withTenant(o.orgId, async (sql) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO messages (org_id, lead_id, task_id, direction, channel, purpose, template, category, language,
                              variables, body, phone, status, error, cost_paise, sent_by, sms_template_id, sms_parts)
        VALUES (${o.orgId}, ${o.leadId}, ${o.taskId ?? null}, 'OUT', 'SMS', ${o.purpose},
                ${`sms_${o.purpose.toLowerCase()}_${template.voice.toLowerCase()}`}, 'UTILITY', 'en',
                ${sql.json(o.values as Record<string, string | null>)}, ${text.slice(0, 4096)}, ${o.phone}, ${status}, ${error},
                ${status === "QUEUED" ? price.costPaise : null}, ${o.userId ?? null}, ${template.id}, ${Math.min(parts, MAX_SMS_PARTS)})
        RETURNING id`;
      return row.id;
    });

  if (!filled.ok) {
    const message = filled.blank === "pass" ? "No visit pass to send, so no SMS went." : "Something the SMS needs is missing, so no SMS went.";
    await record("REFUSED", message);
    return { ok: false, code: "SMS_MISSING", message };
  }
  if (parts > MAX_SMS_PARTS) {
    const message = "This SMS would run past three parts, so it was not sent.";
    await record("REFUSED", message);
    return { ok: false, code: "SMS_TOO_LONG", message };
  }
  const credit = await messageAllowed(o.orgId, o.nodeId, price.costPaise);
  if (!credit.ok) {
    await record("REFUSED", credit.message);
    return { ok: false, code: "NO_CREDIT", message: credit.message };
  }

  const messageId = await record("QUEUED", null);
  try {
    const { id } = await send.send({
      to: o.phone,
      body: text,
      header: sender.header,
      entityId: sender.dlt_entity_id,
      templateId: template.dlt_template_id,
      context: { org: o.orgId, message: messageId },
    });
    await withTenant(o.orgId, (sql) => sql`
      UPDATE messages SET status = 'SENT', provider_id = ${`sms:${id}`}, sent_at = now()
      WHERE org_id = ${o.orgId} AND id = ${messageId}`);
  } catch (e) {
    console.warn(`sms: send failed for message ${messageId},`, (e instanceof Error ? e.message : String(e)).slice(0, 300));
    const reason = "The SMS was not accepted. It was not sent.";
    await withTenant(o.orgId, (sql) => sql`
      UPDATE messages SET status = 'FAILED', error = ${reason}, cost_paise = NULL
      WHERE org_id = ${o.orgId} AND id = ${messageId}`);
    return { ok: false, code: "FAILED", message: reason };
  }

  // Counted when AWS accepts it: no delivery receipt is read yet.
  await meterQuietly({
    orgId: o.orgId,
    nodeId: o.nodeId,
    kind: "SMS",
    qty: price.billedPaise,
    costPaise: price.costPaise,
    billable: true,
    source: { kind: "message", id: messageId },
  });
  const [consent] = await withTenant(o.orgId, (sql) => sql<{ id: string }[]>`
    SELECT id FROM lead_consents WHERE org_id = ${o.orgId} AND phone = ${o.phone} ORDER BY captured_at DESC LIMIT 1`);
  await withTenant(o.orgId, (sql) => sql`UPDATE leads SET last_activity_at = now() WHERE org_id = ${o.orgId} AND id = ${o.leadId}`);
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId ?? null,
    action: "message.sms_sent",
    targetType: "message",
    targetId: messageId,
    metadata: {
      purpose: o.purpose,
      header: sender.header,
      dlt_template_id: template.dlt_template_id,
      consent_id: consent?.id ?? null,
      basis: o.basis,
      registration: o.registration,
      parts,
      why: o.why.metaError ? `META_${o.why.metaError}` : o.why.code ?? null,
      unit: "sms",
    },
  });
  return { ok: true, messageId };
}

// ---------------------------------------------------------------------------
// The settings screen
// ---------------------------------------------------------------------------

export type SmsTemplateView = {
  purpose: SmsPurpose;
  voice: Voice;
  label: string;
  body: string;
  templateId: string | null;
  state: SmsTemplateState;
};

export type SmsSettings = {
  switchedOn: boolean;
  sender: { id: string; nodeName: string; entityId: string; header: string } | null;
  templates: SmsTemplateView[];
};

/** The organisation's registration at its root, and each message's state. */
export async function smsSettings(orgId: string, rootId: string): Promise<SmsSettings> {
  const s = await senderAt(orgId, rootId);
  const templates: SmsTemplateView[] = [];
  for (const purpose of SMS_PURPOSES) {
    for (const voice of VOICES) {
      const row = s?.templates.find((t) => t.purpose === purpose && t.voice === voice) ?? null;
      templates.push({
        purpose,
        voice,
        label: SMS_TEMPLATES[purpose].label,
        body: SMS_TEMPLATES[purpose].body[voice],
        templateId: row?.dlt_template_id ?? null,
        state: smsTemplateState(row ? { bodySha256: row.body_sha256 } : null, smsHash(purpose, voice)),
      });
    }
  }
  return {
    switchedOn: smsSwitchedOn(),
    sender: s ? { id: s.id, nodeName: s.node_name, entityId: s.dlt_entity_id, header: s.header } : null,
    templates,
  };
}

/**
 * Save the registration and the template ids in one go. A changed entity
 * or header retires the old registration and writes a new one, so what a
 * sent message went out under stays answerable; a changed id retires the
 * old row the same way. An empty id takes the template out.
 */
export async function saveSmsSettings(o: {
  orgId: string;
  userId: string;
  nodeId: string;
  entityId: string;
  header: string;
  templates: { purpose: SmsPurpose; voice: Voice; templateId: string | null }[];
}): Promise<{ senderId: string; changed: number }> {
  const result = await withTenant(o.orgId, async (sql) => {
    const [live] = await sql<{ id: string; dlt_entity_id: string; header: string }[]>`
      SELECT id, dlt_entity_id, header FROM sms_senders
      WHERE org_id = ${o.orgId} AND scope_node_id = ${o.nodeId} AND status = 'ACTIVE' FOR UPDATE`;
    let senderId = live?.id ?? null;
    let changed = 0;
    if (!live || live.dlt_entity_id !== o.entityId || live.header !== o.header) {
      if (live) await sql`UPDATE sms_senders SET status = 'RETIRED', retired_at = now() WHERE org_id = ${o.orgId} AND id = ${live.id}`;
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO sms_senders (org_id, scope_node_id, dlt_entity_id, header, created_by)
        VALUES (${o.orgId}, ${o.nodeId}, ${o.entityId}, ${o.header}, ${o.userId}) RETURNING id`;
      // The ids registered under the old entity or header are carried over:
      // a template id belongs to the words, and the words did not change.
      if (live) {
        await sql`
          INSERT INTO sms_templates (org_id, sender_id, purpose, voice, dlt_template_id, body_sha256, created_by)
          SELECT org_id, ${row.id}, purpose, voice, dlt_template_id, body_sha256, ${o.userId}
          FROM sms_templates WHERE org_id = ${o.orgId} AND sender_id = ${live.id} AND status = 'ACTIVE'`;
      }
      senderId = row.id;
      changed += 1;
    }
    const current = await sql<{ id: string; purpose: string; voice: string; dlt_template_id: string; body_sha256: string }[]>`
      SELECT id, purpose, voice, dlt_template_id, body_sha256 FROM sms_templates
      WHERE org_id = ${o.orgId} AND sender_id = ${senderId} AND status = 'ACTIVE'`;
    for (const t of o.templates) {
      const row = current.find((c) => c.purpose === t.purpose && c.voice === t.voice);
      const hash = smsHash(t.purpose, t.voice);
      if (row && row.dlt_template_id === t.templateId && row.body_sha256 === hash) continue;
      if (!row && !t.templateId) continue;
      if (row) await sql`UPDATE sms_templates SET status = 'RETIRED' WHERE org_id = ${o.orgId} AND id = ${row.id}`;
      if (t.templateId) {
        await sql`
          INSERT INTO sms_templates (org_id, sender_id, purpose, voice, dlt_template_id, body_sha256, created_by)
          VALUES (${o.orgId}, ${senderId}, ${t.purpose}, ${t.voice}, ${t.templateId}, ${hash}, ${o.userId})`;
      }
      changed += 1;
    }
    return { senderId: senderId!, changed };
  });
  await audit({
    orgId: o.orgId,
    actorUserId: o.userId,
    action: "sms.settings_saved",
    targetType: "sms_sender",
    targetId: result.senderId,
    metadata: { header: o.header, changed: result.changed },
  });
  return result;
}

/** For the card on Connected accounts. */
export async function smsSummary(orgId: string): Promise<{ header: string | null; registered: number; total: number; switchedOn: boolean }> {
  const [root] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`);
  if (!root) return { header: null, registered: 0, total: 0, switchedOn: smsSwitchedOn() };
  const s = await smsSettings(orgId, root.id);
  return {
    header: s.sender?.header ?? null,
    registered: s.templates.filter((t) => t.state === "SENDS").length,
    total: s.templates.length,
    switchedOn: s.switchedOn,
  };
}
