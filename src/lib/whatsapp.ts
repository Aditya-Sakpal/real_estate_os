/**
 * The one door to WhatsApp: Meta's Cloud API, on each developer's own
 * account.
 *
 * Every request goes through `call()` in `platform.ts`, so a check swaps the
 * network for a fake that answers at the same URLs, and a message send can
 * additionally be caught by `useWhatsApp()`, the way `sarvam.ts` is the seam
 * for calls. An injected driver beats the real one.
 *
 * There is no shared number. A token and a phone number id come from the
 * developer's own connected account (`wa-numbers.ts`), never from the
 * environment: sending in a client's name from somebody else's account is
 * the thing Meta bans businesses for.
 *
 * Nothing here has run against Meta with a client's account yet.
 */

import { createHmac } from "node:crypto";
import { META_GRAPH_VERSION, HOSTS, call, query, refuse, ok, type R } from "./platform.ts";
import { e164, type GranularScope } from "./wa-rules.ts";

export type WhatsAppConfig = {
  token: string;
  phoneNumberId: string;
};

export type TemplateSend = {
  /** E.164. */
  to: string;
  template: string;
  /** WhatsApp's language code for the approved template: `en`, `hi` or `mr`. */
  language: string;
  params: string[];
  /** Comes back on every delivery receipt for this message. */
  callbackData: string;
  /** One payload per quick-reply button, in the template's order: what a tap sends back. */
  buttons?: string[];
  /** A picture header (a broadcast's post), by the id Meta gave it when it was uploaded. */
  headerImage?: { id: string };
};

/** A reply inside the 24 hours after the person last wrote: free, and free-form. */
export type TextSend = { to: string; body: string; callbackData: string };

/** A picture or a file, inside the same window. The bytes are uploaded to Meta first. */
export type MediaSend = {
  to: string;
  kind: "image" | "document";
  bytes: Buffer;
  mediaType: string;
  filename?: string;
  caption?: string;
  callbackData: string;
};

export type WhatsAppDriver = {
  sendTemplate(config: WhatsAppConfig, msg: TemplateSend): Promise<{ id: string }>;
  sendText?(config: WhatsAppConfig, msg: TextSend): Promise<{ id: string }>;
  sendMedia?(config: WhatsAppConfig, msg: MediaSend): Promise<{ id: string }>;
  /** A picture uploaded to Meta's store on this number, for a template's header. The id lives 30 days. */
  uploadMedia?(config: WhatsAppConfig, file: { bytes: Buffer; mediaType: string; filename: string }): Promise<{ id: string }>;
};

const env = (name: string) => (process.env[name] ?? "").trim() || null;
const graph = (path: string) => `${HOSTS.graph}/${META_GRAPH_VERSION}/${path.replace(/^\//, "")}`;

/** Proves the caller holds the app secret as well as the token. */
function proof(token: string): string | undefined {
  const secret = env("META_APP_SECRET");
  return secret ? createHmac("sha256", secret).update(token).digest("hex") : undefined;
}

async function get<T>(token: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<R<T>> {
  const r = await call<T>("META", graph(path) + query({ ...params, appsecret_proof: proof(token) }), {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  return r.ok ? ok(r.json) : r;
}

async function send<T>(token: string, method: "POST" | "DELETE", path: string, body?: unknown): Promise<R<T>> {
  const r = await call<T>("META", graph(path) + query({ appsecret_proof: proof(token) }), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return r.ok ? ok(r.json) : r;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const realDriver: WhatsAppDriver = {
  async sendTemplate(c, m) {
    const r = await send<{ messages?: { id?: string }[] }>(c.token, "POST", `${c.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: m.to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: m.template,
        language: { code: m.language },
        components: [
          ...(m.headerImage ? [{ type: "header", parameters: [{ type: "image", image: { id: m.headerImage.id } }] }] : []),
          ...(m.params.length ? [{ type: "body", parameters: m.params.map((text) => ({ type: "text", text })) }] : []),
          ...(m.buttons ?? []).map((payload, i) => ({
            type: "button",
            sub_type: "quick_reply",
            index: String(i),
            parameters: [{ type: "payload", payload }],
          })),
        ],
      },
      biz_opaque_callback_data: m.callbackData,
    });
    if (!r.ok) throw new Error(`WhatsApp refused: ${r.message}${r.platformCode ? ` (${r.platformCode})` : ""}`);
    const id = r.value.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp accepted the message and returned no id.");
    return { id };
  },
  async sendText(c, m) {
    const r = await send<{ messages?: { id?: string }[] }>(c.token, "POST", `${c.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: m.to.replace(/^\+/, ""),
      type: "text",
      text: { body: m.body.slice(0, 4096), preview_url: /https?:\/\//.test(m.body) },
      biz_opaque_callback_data: m.callbackData,
    });
    if (!r.ok) throw new Error(`WhatsApp refused: ${r.message}${r.platformCode ? ` (${r.platformCode})` : ""}`);
    const id = r.value.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp accepted the message and returned no id.");
    return { id };
  },
  async sendMedia(c, m) {
    // Uploaded to Meta's own store, so nothing of ours needs a public link.
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", m.mediaType);
    form.append("file", new Blob([new Uint8Array(m.bytes)], { type: m.mediaType }), m.filename ?? (m.kind === "image" ? "image.jpg" : "file"));
    const up = await call<{ id?: string }>("META", graph(`${c.phoneNumberId}/media`) + query({ appsecret_proof: proof(c.token) }), {
      method: "POST",
      headers: { authorization: `Bearer ${c.token}` },
      body: form,
      timeoutMs: 60_000,
    });
    if (!up.ok) throw new Error(`WhatsApp refused the file: ${up.message}`);
    const mediaId = up.json.id;
    if (!mediaId) throw new Error("WhatsApp took the file and returned no id.");
    const payload =
      m.kind === "image"
        ? { image: { id: mediaId, ...(m.caption ? { caption: m.caption.slice(0, 1024) } : {}) } }
        : { document: { id: mediaId, filename: m.filename ?? "file", ...(m.caption ? { caption: m.caption.slice(0, 1024) } : {}) } };
    const r = await send<{ messages?: { id?: string }[] }>(c.token, "POST", `${c.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: m.to.replace(/^\+/, ""),
      type: m.kind,
      ...payload,
      biz_opaque_callback_data: m.callbackData,
    });
    if (!r.ok) throw new Error(`WhatsApp refused: ${r.message}${r.platformCode ? ` (${r.platformCode})` : ""}`);
    const id = r.value.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp accepted the message and returned no id.");
    return { id };
  },
};

let injected: WhatsAppDriver | null = null;

/** For checks: route every WhatsApp send through `driver` until `restore()`. */
export function useWhatsApp(driver: WhatsAppDriver): { restore(): void } {
  injected = driver;
  return { restore: () => void (injected = null) };
}

export const whatsapp = (): WhatsAppDriver => injected ?? realDriver;

/**
 * A picture into Meta's store on the number that sends it, for a template's
 * header: uploaded once per broadcast and sent by id. An injected driver that
 * takes uploads beats the network, the way it does for sends.
 */
export async function uploadMedia(c: WhatsAppConfig, file: { bytes: Buffer; mediaType: string; filename: string }): Promise<{ id: string }> {
  const d = whatsapp();
  if (d.uploadMedia) return d.uploadMedia(c, file);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", file.mediaType);
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), file.filename);
  const up = await call<{ id?: string }>("META", graph(`${c.phoneNumberId}/media`) + query({ appsecret_proof: proof(c.token) }), {
    method: "POST",
    headers: { authorization: `Bearer ${c.token}` },
    body: form,
    timeoutMs: 60_000,
  });
  if (!up.ok) throw new Error(`WhatsApp refused the picture: ${up.message}`);
  if (!up.json.id) throw new Error("WhatsApp took the picture and returned no id.");
  return { id: up.json.id };
}

/**
 * The example picture a template with a picture header is reviewed with,
 * uploaded through Meta's resumable upload (the handle is not a media id):
 * a session on our app, then the bytes.
 */
export async function waUploadHandle(token: string, file: { bytes: Buffer; mediaType: string; filename: string }): Promise<R<string>> {
  const appId = env("META_APP_ID");
  if (!appId) return { ok: false, ...refuse("INVALID", "The Meta app is not set up.") };
  const session = await call<{ id?: string }>(
    "META",
    graph(`${appId}/uploads`) + query({ file_name: file.filename, file_length: file.bytes.length, file_type: file.mediaType, access_token: token }),
    { method: "POST" },
  );
  if (!session.ok) return session;
  if (!session.json.id) return { ok: false, ...refuse("INVALID", "Meta did not open an upload.") };
  const done = await call<{ h?: string }>("META", graph(session.json.id), {
    method: "POST",
    headers: { authorization: `OAuth ${token}`, file_offset: "0" },
    body: new Uint8Array(file.bytes),
    timeoutMs: 60_000,
  });
  if (!done.ok) return done;
  return done.json.h ? ok(done.json.h) : { ok: false, ...refuse("INVALID", "Meta took the example picture and returned no handle.") };
}

// ---------------------------------------------------------------------------
// Connecting a developer's account (Embedded Signup, as a Tech Provider)
// ---------------------------------------------------------------------------

/** What connecting needs from us: the app, and the signup configuration made in Meta's dashboard. */
export function signupConfig(): { appId: string; configId: string; solutionId: string | null; version: string } | null {
  const appId = env("META_APP_ID");
  const configId = env("META_WA_CONFIG_ID");
  if (!appId || !configId || !env("META_APP_SECRET")) return null;
  return { appId, configId, solutionId: env("META_WA_SOLUTION_ID"), version: META_GRAPH_VERSION };
}

/**
 * The code from the pop-up, swapped for the developer's business integration
 * system user token. The code lives thirty seconds, so this runs the moment
 * the page hands it over. No redirect address: the pop-up used the SDK.
 */
export async function waExchange(code: string): Promise<R<string>> {
  const r = await call<{ access_token?: string }>(
    "META",
    graph("oauth/access_token") + query({ client_id: env("META_APP_ID"), client_secret: env("META_APP_SECRET"), code }),
    { method: "GET" },
  );
  if (!r.ok) return r;
  return r.json.access_token ? ok(r.json.access_token) : { ok: false, ...refuse("INVALID", "Meta did not hand back a token.") };
}

export type WaGrant = { valid: boolean; expiresAt: Date | null; granular: GranularScope[] };

/** What Meta says the token can reach. */
export async function waInspect(token: string): Promise<R<WaGrant>> {
  const appToken = `${env("META_APP_ID")}|${env("META_APP_SECRET")}`;
  const r = await call<{ data?: { is_valid?: boolean; expires_at?: number; granular_scopes?: GranularScope[] } }>(
    "META",
    graph("debug_token") + query({ input_token: token, access_token: appToken }),
    { method: "GET" },
  );
  if (!r.ok) return r;
  const d = r.json.data ?? {};
  return ok({
    valid: d.is_valid === true,
    // Meta writes 0 for a token that never expires.
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000) : null,
    granular: Array.isArray(d.granular_scopes) ? d.granular_scopes : [],
  });
}

export type WaAccount = { id: string; name: string; currency: string | null; businessId: string | null };

export async function waAccount(token: string, wabaId: string): Promise<R<WaAccount>> {
  const r = await get<{ id?: string; name?: string; currency?: string; owner_business_info?: { id?: string } }>(
    token,
    wabaId,
    { fields: "id,name,currency,owner_business_info" },
  );
  if (!r.ok) return r;
  return ok({
    id: wabaId,
    name: String(r.value.name ?? "").slice(0, 200),
    currency: typeof r.value.currency === "string" && /^[A-Z]{3}$/.test(r.value.currency) ? r.value.currency : null,
    businessId: typeof r.value.owner_business_info?.id === "string" ? r.value.owner_business_info.id : null,
  });
}

export type WaNumber = {
  phoneNumberId: string;
  displayPhone: string;
  verifiedName: string;
  nameStatus: string | null;
  quality: unknown;
  limit: unknown;
  /** Also live in the WhatsApp Business app. */
  onApp: boolean;
  /** Already registered on the Cloud API. */
  registered: boolean;
};

const NUMBER_FIELDS = [
  "id",
  "display_phone_number",
  "verified_name",
  "name_status",
  "quality_rating",
  "platform_type",
  "status",
  "is_on_biz_app",
  "whatsapp_business_manager_messaging_limit",
].join(",");

type RawNumber = {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  name_status?: string;
  quality_rating?: string;
  platform_type?: string;
  status?: string;
  is_on_biz_app?: boolean;
  whatsapp_business_manager_messaging_limit?: string;
};

function readNumber(n: RawNumber): WaNumber | null {
  const phone = e164(n.display_phone_number);
  if (!n.id || !/^[0-9]{1,40}$/.test(n.id) || !phone) return null;
  return {
    phoneNumberId: n.id,
    displayPhone: phone,
    verifiedName: String(n.verified_name ?? "").slice(0, 200),
    nameStatus: typeof n.name_status === "string" ? n.name_status.slice(0, 40) : null,
    quality: n.quality_rating,
    limit: n.whatsapp_business_manager_messaging_limit,
    onApp: n.is_on_biz_app === true,
    registered: n.platform_type === "CLOUD_API" && (n.status === "CONNECTED" || n.status === undefined),
  };
}

/** Every number on a WABA. */
export async function waNumbers(token: string, wabaId: string): Promise<R<WaNumber[]>> {
  const r = await get<{ data?: RawNumber[] }>(token, `${wabaId}/phone_numbers`, { fields: NUMBER_FIELDS, limit: 50 });
  if (!r.ok) return r;
  return ok((r.value.data ?? []).map(readNumber).filter((n): n is WaNumber => !!n));
}

/** Our app, subscribed to the WABA's webhooks. Without it nothing a buyer writes reaches us. */
export async function waSubscribe(token: string, wabaId: string): Promise<R<true>> {
  const r = await send<{ success?: boolean }>(token, "POST", `${wabaId}/subscribed_apps`);
  if (!r.ok) return r;
  return r.value.success === false ? { ok: false, ...refuse("INVALID", "Meta did not subscribe us to this account.") } : ok(true);
}

export async function waUnsubscribe(token: string, wabaId: string): Promise<R<true>> {
  const r = await send<{ success?: boolean }>(token, "DELETE", `${wabaId}/subscribed_apps`);
  return r.ok ? ok(true) : r;
}

/**
 * A new number, registered on the Cloud API with a two-step PIN. Never for
 * a number that stays in the WhatsApp Business app: that one is registered
 * already, and Meta does not allow it.
 */
export async function waRegister(token: string, phoneNumberId: string, pin: string): Promise<R<true>> {
  const r = await send<{ success?: boolean }>(token, "POST", `${phoneNumberId}/register`, { messaging_product: "whatsapp", pin });
  return r.ok ? ok(true) : r;
}

/**
 * A number kept in the WhatsApp Business app has to ask Meta to sync within
 * 24 hours of connecting or it is taken off again. Contacts first, then
 * history, which Meta requires to be asked for; the chats it sends back are
 * not read (see `readWabaEvents()`).
 */
export async function waSync(token: string, phoneNumberId: string, kind: "smb_app_state_sync" | "history"): Promise<R<true>> {
  const r = await send<{ success?: boolean }>(token, "POST", `${phoneNumberId}/smb_app_data`, {
    messaging_product: "whatsapp",
    sync_type: kind,
  });
  return r.ok ? ok(true) : r;
}

export async function waCreateTemplate(
  token: string,
  wabaId: string,
  body: unknown,
): Promise<R<{ id: string | null; status: string | null; category: string | null }>> {
  const r = await send<{ id?: string; status?: string; category?: string }>(token, "POST", `${wabaId}/message_templates`, body);
  if (!r.ok) return r;
  return ok({ id: r.value.id ?? null, status: r.value.status ?? null, category: r.value.category ?? null });
}

export type WaTemplate = {
  id: string | null;
  name: string;
  language: string;
  status: string;
  category: string | null;
  quality: string | null;
  reason: string | null;
  /** The body text Meta holds, so an approval is trusted only for the words it was given. */
  body: string | null;
};

/**
 * New words for a template Meta already holds under this name and language.
 * Meta reviews an edit again, and allows a handful a month.
 */
export async function waEditTemplate(token: string, templateId: string, body: { components: unknown }): Promise<R<true>> {
  const r = await send<{ success?: boolean }>(token, "POST", templateId, body);
  if (!r.ok) return r;
  return r.value.success === false ? { ok: false, ...refuse("INVALID", "Meta did not take the new wording.") } : ok(true);
}

/** Every template on a WABA, following pages up to a ceiling. */
export async function waTemplates(token: string, wabaId: string): Promise<R<WaTemplate[]>> {
  const out: WaTemplate[] = [];
  let after: string | undefined;
  // 6,000 is the most a verified WABA may hold; 30 pages of 200 is past it.
  for (let page = 0; page < 30; page++) {
    const r = await get<{
      data?: {
        id?: string;
        name?: string;
        language?: string;
        status?: string;
        category?: string;
        quality_score?: { score?: string };
        rejected_reason?: string;
        components?: { type?: string; text?: string }[];
      }[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(token, `${wabaId}/message_templates`, {
      fields: "id,name,language,status,category,quality_score,rejected_reason,components",
      limit: 200,
      after,
    });
    if (!r.ok) return r;
    for (const t of r.value.data ?? []) {
      if (typeof t.name !== "string" || typeof t.language !== "string" || typeof t.status !== "string") continue;
      out.push({
        id: typeof t.id === "string" ? t.id : null,
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category ?? null,
        quality: t.quality_score?.score ?? null,
        reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
        body: (t.components ?? []).find((c) => c?.type === "BODY")?.text ?? null,
      });
    }
    after = r.value.paging?.next ? r.value.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return ok(out);
}

/** One number's current state. */
export async function waNumber(token: string, phoneNumberId: string): Promise<R<WaNumber>> {
  const r = await get<RawNumber>(token, phoneNumberId, { fields: NUMBER_FIELDS });
  if (!r.ok) return r;
  const n = readNumber(r.value);
  return n ? ok(n) : { ok: false, ...refuse("INVALID", "Meta described this number in a way we could not read.") };
}

// ---------------------------------------------------------------------------
// The webhook: delivery receipts and replies
// ---------------------------------------------------------------------------

export type WaStatus = {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: string;
  callbackData: string | null;
  error: string | null;
  /** Meta's error code, when a message failed. */
  errorCode: number | null;
  /** The developer's number it went from, and the WABA. */
  phoneNumberId: string | null;
  wabaId: string | null;
};

export type WaInbound = {
  id: string;
  /** E.164. */
  from: string;
  at: string;
  text: string;
  /** The message of ours it answered, when the buyer swiped to reply. */
  replyTo: string | null;
  /** The developer's number it was written to, and the WABA. */
  phoneNumberId: string | null;
  wabaId: string | null;
  /** Meta's business-scoped id for the buyer, when it sent one. */
  userId: string | null;
  /** The name on the sender's WhatsApp profile, when Meta sent one. */
  profileName: string | null;
  /** What a tapped quick-reply button carried, as our send attached it. */
  payload?: string | null;
  /**
   * The ad a buyer tapped to start this chat: a Click-to-WhatsApp ad's id and
   * Meta's click id. Present only on the first message of such a chat.
   */
  referral?: { sourceType: string; sourceId: string | null; ctwaClid: string | null } | null;
};

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/** Receipts and replies in a WhatsApp Business webhook, read defensively. */
export function readWhatsAppWebhook(body: unknown): { statuses: WaStatus[]; inbound: WaInbound[] } {
  const out = { statuses: [] as WaStatus[], inbound: [] as WaInbound[] };
  const b = (body ?? {}) as { object?: unknown; entry?: unknown };
  if (b.object !== "whatsapp_business_account" || !Array.isArray(b.entry)) return out;
  const when = (ts: unknown) => {
    const n = Number(ts);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
  };
  for (const entry of b.entry as { id?: unknown; changes?: unknown }[]) {
    if (!Array.isArray(entry?.changes)) continue;
    const wabaId = typeof entry.id === "string" && /^[0-9]{1,40}$/.test(entry.id) ? entry.id : null;
    for (const ch of entry.changes as { field?: unknown; value?: Record<string, unknown> }[]) {
      if (ch?.field !== "messages" || !ch.value) continue;
      const meta = ch.value.metadata as { phone_number_id?: unknown } | undefined;
      const phoneNumberId = typeof meta?.phone_number_id === "string" && /^[0-9]{1,40}$/.test(meta.phone_number_id) ? meta.phone_number_id : null;
      for (const s of Array.isArray(ch.value.statuses) ? (ch.value.statuses as Record<string, unknown>[]) : []) {
        const id = typeof s.id === "string" ? s.id : null;
        const status = typeof s.status === "string" && STATUSES.has(s.status) ? (s.status as WaStatus["status"]) : null;
        if (!id || !status) continue;
        const err = Array.isArray(s.errors) ? (s.errors[0] as { title?: string; message?: string; code?: number } | undefined) : undefined;
        out.statuses.push({
          id,
          status,
          at: when(s.timestamp),
          callbackData: typeof s.biz_opaque_callback_data === "string" ? s.biz_opaque_callback_data : null,
          error: err ? `${err.title ?? err.message ?? "Failed"}${err.code ? ` (${err.code})` : ""}`.slice(0, 300) : null,
          errorCode: typeof err?.code === "number" ? err.code : null,
          phoneNumberId,
          wabaId,
        });
      }
      const contacts = Array.isArray(ch.value.contacts)
        ? (ch.value.contacts as { wa_id?: unknown; user_id?: unknown; profile?: { name?: unknown } }[])
        : [];
      for (const m of Array.isArray(ch.value.messages) ? (ch.value.messages as Record<string, unknown>[]) : []) {
        const id = typeof m.id === "string" ? m.id : null;
        const from = typeof m.from === "string" && /^\d{8,15}$/.test(m.from) ? `+${m.from}` : null;
        if (!id || !from) continue;
        const text =
          (m.text as { body?: string } | undefined)?.body ??
          (m.button as { text?: string } | undefined)?.text ??
          (m.interactive as { button_reply?: { title?: string }; list_reply?: { title?: string } } | undefined)?.button_reply?.title ??
          (m.interactive as { list_reply?: { title?: string } } | undefined)?.list_reply?.title ??
          `[${typeof m.type === "string" ? m.type : "message"}]`;
        const userId =
          (typeof m.from_user_id === "string" ? m.from_user_id : null) ??
          (contacts.find((c) => c.wa_id === m.from)?.user_id as string | undefined) ??
          null;
        out.inbound.push({
          id,
          from,
          at: when(m.timestamp),
          text: String(text).slice(0, 4096),
          replyTo: typeof (m.context as { id?: unknown } | undefined)?.id === "string" ? (m.context as { id: string }).id : null,
          phoneNumberId,
          wabaId,
          userId: typeof userId === "string" ? userId.slice(0, 100) : null,
          profileName: (() => {
            const n = contacts.find((c) => c.wa_id === m.from)?.profile?.name;
            return typeof n === "string" && n.trim() ? n.trim().slice(0, 120) : null;
          })(),
          payload: (() => {
            const p =
              (m.button as { payload?: unknown } | undefined)?.payload ??
              (m.interactive as { button_reply?: { id?: unknown } } | undefined)?.button_reply?.id;
            return typeof p === "string" && p.length <= 200 ? p : null;
          })(),
          referral: (() => {
            const r = m.referral as { source_type?: unknown; source_id?: unknown; ctwa_clid?: unknown } | undefined;
            if (!r || typeof r.source_type !== "string") return null;
            const id = typeof r.source_id === "string" && /^[0-9]{1,40}$/.test(r.source_id) ? r.source_id : null;
            const clid = typeof r.ctwa_clid === "string" && r.ctwa_clid.length <= 200 ? r.ctwa_clid : null;
            return { sourceType: r.source_type.slice(0, 20), sourceId: id, ctwaClid: clid };
          })(),
        });
      }
    }
  }
  return out;
}
