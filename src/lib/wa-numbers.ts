import { createHash, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { audit, withNoTenant, withTenant } from "./db/index.ts";
import { open, seal, vaultConfigured } from "./vault.ts";
import { whatsappPurpose, pinPurpose } from "./vault-rules.ts";
import { isNodeId } from "./scope-rules.ts";
import { servablePlaces } from "./connect.ts";
import type { PlatformError } from "./connect-rules.ts";
import type { Template } from "./message-rules.ts";
import { SUBMITTED } from "./wa-catalog.ts";
import {
  REMOVED_EVENTS,
  TEMPLATES_PER_HOUR,
  TROUBLE_EVENTS,
  isPin,
  needsSubmitting,
  numberFor,
  numberNeeds,
  readCategory,
  readQuality,
  readTemplateStatus,
  readTier,
  readWabaEvents,
  reachableWabas,
  registerRefusal,
  templateHashInput,
  templateRequest,
  templateState,
  type NumberNeed,
  type Quality,
  type SignupHint,
  type TemplateState,
  type TemplateStatus,
  type Tier,
} from "./wa-rules.ts";
import {
  signupConfig,
  waAccount,
  waCreateTemplate,
  waEditTemplate,
  waUploadHandle,
  waExchange,
  waInspect,
  waNumber,
  waNumbers,
  waRegister,
  waSubscribe,
  waSync,
  waTemplates,
  waUnsubscribe,
  type WaNumber,
  type WhatsAppConfig,
} from "./whatsapp.ts";

/**
 * Each developer's own WhatsApp number: connecting it, keeping it working,
 * submitting the templates to it, and finding which one writes to a lead.
 * The pure half is `wa-rules.ts`; Meta's API is `whatsapp.ts`.
 *
 * The token belongs to the developer's WABA and is sealed per tenant, bound
 * to its account row (`whatsappPurpose()`). It never reaches a screen, a log
 * line or `audit_log`.
 */

export type Outcome = { ok: true; message: string } | { ok: false; code: string; message: string };

export { whatsappPurpose, pinPurpose } from "./vault-rules.ts";

/** Whether this deployment can connect a number at all: the app, the signup configuration, the vault. */
export function whatsappReadyToConnect(): boolean {
  return !!signupConfig() && vaultConfigured();
}

const refusal = (e: PlatformError, fallback: string): Outcome => ({
  ok: false,
  code: e.code,
  message: e.code === "UNREACHABLE" ? "Meta did not answer. Try again in a minute." : fallback,
});

/** The words each catalog template is submitted in. Slice 2 adds Hindi and Marathi. */
export function catalogBodies(t: Template): { language: string; body: string }[] {
  return [{ language: "en", body: t.body }];
}

/** The hash an approval is pinned to: these words, this name, this language, this category. */
export const catalogHash = (t: Template, language: string, body: string) =>
  createHash("sha256").update(templateHashInput(t, language, body)).digest("hex");
const hashOf = catalogHash;

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/**
 * Finish Embedded Signup: the code for a token, then only what that token
 * can reach. The page's ids are a hint for which number to put to work
 * first and are never believed on their own.
 */
export async function connectWhatsApp(input: {
  orgId: string;
  userId: string;
  code: string;
  hint: SignupHint | null;
}): Promise<Outcome> {
  if (!whatsappReadyToConnect()) {
    return { ok: false, code: "NOT_SET_UP", message: "Connecting WhatsApp is not switched on for Sales Desk yet." };
  }
  if (!/^[A-Za-z0-9_\-.#]{10,2000}$/.test(input.code)) {
    return { ok: false, code: "BAD_CODE", message: "Meta's sign-in did not finish. Try again." };
  }
  const exchanged = await waExchange(input.code);
  if (!exchanged.ok) return refusal(exchanged, "Meta's sign-in expired before it finished. Try again.");
  return connectToken({ orgId: input.orgId, userId: input.userId, token: exchanged.value, hint: input.hint, submit: true });
}

/**
 * Connect whatever a token can reach. The signup's own path, and the dev
 * seed's (`npm run seed:whatsapp`), which passes `submit: false`: seeding
 * reads the number and Meta's templates, and never registers, syncs or
 * creates anything on the account.
 */
export async function connectToken(input: {
  orgId: string;
  userId: string;
  token: string;
  hint: SignupHint | null;
  submit: boolean;
}): Promise<Outcome> {
  const token = input.token;
  const grant = await waInspect(token);
  if (!grant.ok) return refusal(grant, "Meta would not say what this sign-in allows. Try again.");
  if (!grant.value.valid) return { ok: false, code: "TOKEN_INVALID", message: "Meta handed back access that does not work. Try again." };

  const wabas = reachableWabas(grant.value.granular);
  if (!wabas.length) {
    return { ok: false, code: "NOTHING_SHARED", message: "No WhatsApp account was shared with Sales Desk. Connect again and pick one." };
  }

  const places = await servablePlaces(input.orgId);
  const root = places.find((p) => p.kind === "ORG");
  let connected = 0;
  let numbers = 0;
  let lastProblem: Outcome | null = null;

  for (const wabaId of wabas) {
    const [account, list] = await Promise.all([waAccount(token, wabaId), waNumbers(token, wabaId)]);
    if (!account.ok) {
      lastProblem = refusal(account, "Meta would not describe the WhatsApp account. Try again.");
      continue;
    }
    if (!list.ok) {
      lastProblem = refusal(list, "Meta would not list the numbers on the WhatsApp account. Try again.");
      continue;
    }
    const sub = await waSubscribe(token, wabaId);
    if (!sub.ok) {
      // Without the subscription no reply or receipt ever reaches us, so a
      // number connected without it is a number that looks fine and is deaf.
      lastProblem = refusal(sub, "Meta would not send us this account's messages. Try again.");
      continue;
    }
    const saved = await saveAccount({
      orgId: input.orgId,
      userId: input.userId,
      wabaId,
      token,
      expiresAt: grant.value.expiresAt,
      account: account.value,
      numbers: list.value,
      rootId: root?.id ?? null,
      prefer: input.hint?.wabaId === wabaId ? input.hint.phoneNumberId : null,
    });
    if (!saved.ok) {
      lastProblem = saved;
      continue;
    }
    connected += 1;
    numbers += list.value.length;
    if (input.submit) await finishNumbers(input.orgId, saved.accountId, token);
    if (input.submit) await submitTemplates({ orgId: input.orgId, userId: input.userId, accountId: saved.accountId });
    else await refreshTemplates(input.orgId, saved.accountId, wabaId, token);
  }

  if (!connected) return lastProblem ?? { ok: false, code: "FAILED", message: "WhatsApp did not connect. Try again." };
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "whatsapp.connected",
    targetType: "org",
    targetId: input.orgId,
    metadata: { accounts: connected, numbers, event: input.hint?.event ?? null },
  });
  return { ok: true, message: numbers === 1 ? "WhatsApp is connected." : `WhatsApp is connected: ${numbers} numbers.` };
}

async function saveAccount(input: {
  orgId: string;
  userId: string;
  wabaId: string;
  token: string;
  expiresAt: Date | null;
  account: { name: string; currency: string | null; businessId: string | null };
  numbers: WaNumber[];
  rootId: string | null;
  prefer: string | null;
}): Promise<{ ok: true; accountId: string } | { ok: false; code: string; message: string }> {
  try {
    return await withTenant(input.orgId, async (sql) => {
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM whatsapp_accounts
        WHERE org_id = ${input.orgId} AND waba_id = ${input.wabaId} AND status <> 'DISCONNECTED'`;
      const accountId = existing?.id ?? randomUUID();
      const sealed = await seal(input.orgId, whatsappPurpose(accountId), input.token, sql);
      if (!sealed) throw new Error("vault");
      if (existing) {
        await sql`
          UPDATE whatsapp_accounts SET
            secret = ${sealed.secret}, key_version = ${sealed.keyVersion}, token_expires_at = ${input.expiresAt},
            status = 'CONNECTED', name = ${input.account.name}, currency = ${input.account.currency},
            business_id = ${input.account.businessId}, connected_by = ${input.userId}, connected_at = now(),
            last_checked_at = now(), last_error_code = NULL, last_error = NULL, updated_at = now()
          WHERE org_id = ${input.orgId} AND id = ${accountId}`;
      } else {
        await sql`
          INSERT INTO whatsapp_accounts (id, org_id, waba_id, business_id, name, currency, status, secret, key_version,
                                         token_expires_at, connected_by, last_checked_at)
          VALUES (${accountId}, ${input.orgId}, ${input.wabaId}, ${input.account.businessId}, ${input.account.name},
                  ${input.account.currency}, 'CONNECTED', ${sealed.secret}, ${sealed.keyVersion}, ${input.expiresAt},
                  ${input.userId}, now())`;
      }

      // The first number a tenant connects goes to work for the whole
      // organisation at once; later ones wait for a person to place them,
      // because two numbers at one place is two answers.
      const [{ n: placed }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM whatsapp_numbers WHERE org_id = ${input.orgId} AND active`;
      const ordered = [...input.numbers].sort((a, b) => Number(b.phoneNumberId === input.prefer) - Number(a.phoneNumberId === input.prefer));
      let free = placed === 0 && !!input.rootId;
      for (const n of ordered) {
        const [row] = await sql<{ id: string }[]>`
          SELECT id FROM whatsapp_numbers
          WHERE org_id = ${input.orgId} AND account_id = ${accountId} AND phone_number_id = ${n.phoneNumberId} AND retired_at IS NULL`;
        const fields = {
          display: n.displayPhone,
          name: n.verifiedName,
          nameStatus: n.nameStatus,
          quality: readQuality(n.quality),
          limit: readTier(n.limit),
        };
        if (row) {
          await sql`
            UPDATE whatsapp_numbers SET display_phone = ${fields.display}, verified_name = ${fields.name},
              name_status = ${fields.nameStatus}, quality = ${fields.quality}, daily_limit = ${fields.limit},
              on_app = ${n.onApp}, registered = registered OR ${n.registered}, checked_at = now(), updated_at = now()
            WHERE org_id = ${input.orgId} AND id = ${row.id}`;
          continue;
        }
        const place = free ? input.rootId : null;
        free = false;
        await sql`
          INSERT INTO whatsapp_numbers (org_id, account_id, phone_number_id, display_phone, verified_name, name_status,
                                        quality, daily_limit, on_app, registered, scope_node_id, active, checked_at)
          VALUES (${input.orgId}, ${accountId}, ${n.phoneNumberId}, ${fields.display}, ${fields.name}, ${fields.nameStatus},
                  ${fields.quality}, ${fields.limit}, ${n.onApp}, ${n.registered}, ${place}, ${place !== null}, now())`;
      }
      return { ok: true as const, accountId };
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return { ok: false, code: "ELSEWHERE", message: "This WhatsApp account or number is already connected to another organisation on Sales Desk." };
    }
    if ((e as Error).message === "vault") return { ok: false, code: "NOT_SET_UP", message: "Connecting WhatsApp is not switched on for Sales Desk yet." };
    throw e;
  }
}

/**
 * What each number needs after connecting. A number kept in the WhatsApp
 * Business app asks Meta to sync (within 24 hours, or Meta takes it off
 * again); a new number is registered with a PIN we choose and keep sealed.
 */
async function finishNumbers(orgId: string, accountId: string, token: string): Promise<void> {
  const rows = await withTenant(orgId, (sql) => sql<
    { id: string; phone_number_id: string; on_app: boolean; registered: boolean; synced_at: Date | null; pin_secret: Buffer | null }[]
  >`
    SELECT id, phone_number_id, on_app, registered, synced_at, pin_secret FROM whatsapp_numbers
    WHERE org_id = ${orgId} AND account_id = ${accountId} AND retired_at IS NULL`);
  for (const n of rows) {
    if (n.on_app) {
      if (n.synced_at) continue;
      const contacts = await waSync(token, n.phone_number_id, "smb_app_state_sync");
      const history = contacts.ok ? await waSync(token, n.phone_number_id, "history") : contacts;
      await withTenant(orgId, (sql) => sql`
        UPDATE whatsapp_numbers SET synced_at = ${history.ok ? new Date() : null},
          register_error = ${history.ok ? null : "Meta did not start the sync this number needs. It is tried again within the hour."},
          updated_at = now()
        WHERE org_id = ${orgId} AND id = ${n.id}`);
      continue;
    }
    if (n.registered) continue;
    const pin = (n.pin_secret && await open(orgId, pinPurpose(n.id), n.pin_secret)) || String(randomInt(0, 1_000_000)).padStart(6, "0");
    await registerNumber(orgId, n.id, n.phone_number_id, token, pin);
  }
}

async function registerNumber(orgId: string, numberId: string, phoneNumberId: string, token: string, pin: string): Promise<Outcome> {
  const r = await waRegister(token, phoneNumberId, pin);
  const sealed = await seal(orgId, pinPurpose(numberId), pin);
  if (r.ok) {
    await withTenant(orgId, (sql) => sql`
      UPDATE whatsapp_numbers SET registered = true, register_error = NULL,
        pin_secret = ${sealed?.secret ?? null}, pin_key_version = ${sealed?.keyVersion ?? null}, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${numberId}`);
    return { ok: true, message: "The number is set up." };
  }
  const why = registerRefusal(r.platformCode ?? null);
  await withTenant(orgId, (sql) => sql`
    UPDATE whatsapp_numbers SET register_error = ${why.text}, updated_at = now()
    WHERE org_id = ${orgId} AND id = ${numberId}`);
  return { ok: false, code: why.wantsPin ? "WANTS_PIN" : r.code, message: why.text };
}

/** The developer's own two-step PIN, for a number that already had one. */
export async function enterPin(input: { orgId: string; userId: string; numberId: string; pin: string }): Promise<Outcome> {
  if (!isPin(input.pin)) return { ok: false, code: "BAD_PIN", message: "The PIN is six digits." };
  const row = await numberWithToken(input.orgId, input.numberId);
  if (!row) return { ok: false, code: "GONE", message: "That number is no longer connected." };
  if (row.on_app || row.registered) return { ok: true, message: "The number is already set up." };
  const r = await registerNumber(input.orgId, row.id, row.phone_number_id, row.token, input.pin);
  if (r.ok) {
    await audit({ orgId: input.orgId, actorUserId: input.userId, action: "whatsapp.number_registered", targetType: "whatsapp_number", targetId: row.id, metadata: {} });
  }
  return r;
}

async function numberWithToken(orgId: string, numberId: string) {
  if (!isNodeId(numberId)) return null;
  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<
      { id: string; account_id: string; phone_number_id: string; on_app: boolean; registered: boolean; secret: Buffer | null }[]
    >`
      SELECT n.id, n.account_id, n.phone_number_id, n.on_app, n.registered, a.secret
      FROM whatsapp_numbers n JOIN whatsapp_accounts a ON a.id = n.account_id
      WHERE n.org_id = ${orgId} AND n.id = ${numberId} AND n.retired_at IS NULL AND a.status = 'CONNECTED'`;
    return r ?? null;
  });
  if (!row) return null;
  const token = await open(orgId, whatsappPurpose(row.account_id), row.secret);
  return token ? { ...row, token } : null;
}

// ---------------------------------------------------------------------------
// Where a number is used
// ---------------------------------------------------------------------------

/**
 * Put a number to work at a place, or take it off (`nodeId` null). The
 * place is read back inside this tenant, and a place that already has a
 * number is refused rather than silently handed over.
 */
export async function placeNumber(input: { orgId: string; userId: string; numberId: string; nodeId: string | null }): Promise<Outcome> {
  if (!isNodeId(input.numberId)) return { ok: false, code: "GONE", message: "That number is no longer connected." };
  let nodeId: string | null = null;
  if (input.nodeId) {
    if (!isNodeId(input.nodeId)) return { ok: false, code: "UNKNOWN_PLACE", message: "Choose where this number is used." };
    const places = await servablePlaces(input.orgId);
    const place = places.find((p) => p.id === input.nodeId);
    if (!place) return { ok: false, code: "UNKNOWN_PLACE", message: "Choose where this number is used." };
    nodeId = place.id;
  }
  const out = await withTenant(input.orgId, async (sql) => {
    const [n] = await sql<{ id: string; on_app: boolean; registered: boolean }[]>`
      SELECT id, on_app, registered FROM whatsapp_numbers
      WHERE org_id = ${input.orgId} AND id = ${input.numberId} AND retired_at IS NULL`;
    if (!n) return { ok: false as const, code: "GONE", message: "That number is no longer connected." };
    if (nodeId) {
      const [clash] = await sql<{ id: string }[]>`
        SELECT id FROM whatsapp_numbers
        WHERE org_id = ${input.orgId} AND active AND scope_node_id = ${nodeId} AND id <> ${input.numberId}`;
      if (clash) return { ok: false as const, code: "TWO_AT_ONE_PLACE", message: "Another number already writes for that place. Move it first." };
    }
    await sql`
      UPDATE whatsapp_numbers SET scope_node_id = ${nodeId}, active = ${nodeId !== null}, updated_at = now()
      WHERE org_id = ${input.orgId} AND id = ${input.numberId}`;
    return { ok: true as const, message: nodeId ? "Saved. This number now writes to buyers there." : "This number is no longer used." };
  });
  if (out.ok) {
    await audit({ orgId: input.orgId, actorUserId: input.userId, action: "whatsapp.number_placed", targetType: "whatsapp_number", targetId: input.numberId, metadata: { nodeId } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Send the catalog to Meta for one account: every template in every
 * language the catalog carries whose words Meta has not already approved or
 * is not already reviewing. Capped per hour below Meta's own limit, so a
 * person pressing again cannot trip it.
 */
export async function submitTemplates(input: { orgId: string; userId: string | null; accountId: string }): Promise<Outcome & { sent?: number }> {
  const acct = await withTenant(input.orgId, async (sql) => {
    const [a] = await sql<{ id: string; waba_id: string; secret: Buffer | null }[]>`
      SELECT id, waba_id, secret FROM whatsapp_accounts
      WHERE org_id = ${input.orgId} AND id = ${input.accountId} AND status = 'CONNECTED'`;
    if (!a) return null;
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM whatsapp_templates
      WHERE org_id = ${input.orgId} AND account_id = ${a.id} AND submitted_at > now() - interval '1 hour'`;
    return { ...a, recent: n };
  });
  if (!acct) return { ok: false, code: "GONE", message: "That WhatsApp account is not connected." };
  const token = await open(input.orgId, whatsappPurpose(acct.id), acct.secret);
  if (!token) return { ok: false, code: "TOKEN_INVALID", message: "WhatsApp stopped accepting our access. Connect it again." };

  // What Meta already holds, including templates approved before we were connected.
  await refreshTemplates(input.orgId, acct.id, acct.waba_id, token);
  const known = await withTenant(input.orgId, (sql) => sql<
    { name: string; language: string; status: TemplateStatus; body_sha256: string; meta_template_id: string | null }[]
  >`
    SELECT name, language, status, body_sha256, meta_template_id FROM whatsapp_templates
    WHERE org_id = ${input.orgId} AND account_id = ${acct.id}`);
  const byKey = new Map(known.map((r) => [`${r.name}|${r.language}`, r]));

  let budget = Math.max(0, TEMPLATES_PER_HOUR - acct.recent);
  let sent = 0;
  let refused = 0;
  // A template with a picture header is reviewed from an example picture,
  // uploaded once for the whole submission.
  let headerHandle: string | null | undefined;
  const exampleHandle = async () => {
    if (headerHandle === undefined) {
      const bytes = await readFile(join(process.cwd(), "assets", "whatsapp", "broadcast-example.jpg")).catch(() => null);
      const h = bytes ? await waUploadHandle(token, { bytes, mediaType: "image/jpeg", filename: "broadcast-example.jpg" }) : null;
      headerHandle = h?.ok ? h.value : null;
    }
    return headerHandle;
  };
  for (const t of SUBMITTED) {
    for (const { language, body } of catalogBodies(t)) {
      const hash = hashOf(t, language, body);
      const row = byKey.get(`${t.name}|${language}`);
      if (!needsSubmitting(templateState(row ? { status: row.status, hash: row.body_sha256 } : null, hash))) continue;
      if (budget <= 0) break;
      budget -= 1;
      const request = templateRequest(t, language, body, t.header === "IMAGE" ? await exampleHandle() : null);
      // Meta holds one template per name and language: new words for one it
      // already has are an edit, and a second create would be refused.
      const r = row?.meta_template_id
        ? await waEditTemplate(token, row.meta_template_id, { components: request.components }).then((e) =>
            e.ok ? { ok: true as const, value: { id: row.meta_template_id, status: "PENDING", category: null } } : e,
          )
        : await waCreateTemplate(token, acct.waba_id, request);
      const status: TemplateStatus = r.ok ? (readTemplateStatus(r.value.status) ?? "PENDING") : "FAILED";
      const category = r.ok ? readCategory(r.value.category) : null;
      const reason = r.ok ? null : r.message.slice(0, 300);
      if (r.ok) sent += 1;
      else refused += 1;
      await withTenant(input.orgId, (sql) => sql`
        INSERT INTO whatsapp_templates (org_id, account_id, name, language, category_asked, category, status, meta_template_id,
                                        body_sha256, reason, submitted_by, submitted_at, decided_at)
        VALUES (${input.orgId}, ${acct.id}, ${t.name}, ${language}, ${t.category}, ${category}, ${status},
                ${r.ok ? r.value.id : null}, ${hash}, ${reason}, ${input.userId}, now(),
                ${status === "PENDING" ? null : new Date()})
        ON CONFLICT (account_id, name, language) DO UPDATE SET
          category_asked = EXCLUDED.category_asked, category = coalesce(EXCLUDED.category, whatsapp_templates.category),
          status = EXCLUDED.status, meta_template_id = coalesce(EXCLUDED.meta_template_id, whatsapp_templates.meta_template_id),
          body_sha256 = EXCLUDED.body_sha256, reason = EXCLUDED.reason, submitted_by = EXCLUDED.submitted_by,
          submitted_at = now(), decided_at = EXCLUDED.decided_at, updated_at = now()`);
    }
  }
  if (sent || refused) {
    await audit({ orgId: input.orgId, actorUserId: input.userId, action: "whatsapp.templates_submitted", targetType: "whatsapp_account", targetId: acct.id, metadata: { sent, refused } });
  }
  if (!sent && !refused) return { ok: true, message: "Every message is already with Meta.", sent };
  if (refused && !sent) return { ok: false, code: "REFUSED", message: "Meta refused the messages. The reason is beside each." };
  return { ok: true, message: `${sent} ${sent === 1 ? "message" : "messages"} sent to Meta for approval.`, sent };
}

/**
 * Read every template Meta holds on the account and record the ones in our
 * catalog. A template somebody approved in WhatsApp Manager before we were
 * connected counts only if its words are ours: the hash recorded is of the
 * words Meta holds, so a template of the same name saying something else
 * reads as "wording changed" and is sent again rather than trusted.
 */
async function refreshTemplates(orgId: string, accountId: string, wabaId: string, token: string): Promise<void> {
  const r = await waTemplates(token, wabaId);
  if (!r.ok) return;
  const catalog = new Map<string, { t: Template; hash: string }>();
  for (const t of SUBMITTED) {
    for (const { language, body } of catalogBodies(t)) catalog.set(`${t.name}|${language}`, { t, hash: hashOf(t, language, body) });
  }
  await withTenant(orgId, async (sql) => {
    for (const m of r.value) {
      const c = catalog.get(`${m.name}|${m.language}`);
      const status = readTemplateStatus(m.status);
      if (!c || !status) continue;
      const held = m.body === null ? null : hashOf(c.t, m.language, m.body);
      await sql`
        INSERT INTO whatsapp_templates (org_id, account_id, name, language, category_asked, category, status,
                                        meta_template_id, body_sha256, reason, quality, decided_at)
        VALUES (${orgId}, ${accountId}, ${m.name}, ${m.language}, ${c.t.category}, ${readCategory(m.category)}, ${status},
                ${m.id && /^[0-9]{1,40}$/.test(m.id) ? m.id : null}, ${held ?? "0".repeat(64)}, ${m.reason?.slice(0, 300) ?? null},
                ${m.quality ? readQuality(m.quality) : null}, ${status === "PENDING" ? null : new Date()})
        ON CONFLICT (account_id, name, language) DO UPDATE SET
          status = EXCLUDED.status, category = coalesce(EXCLUDED.category, whatsapp_templates.category),
          meta_template_id = coalesce(EXCLUDED.meta_template_id, whatsapp_templates.meta_template_id),
          body_sha256 = EXCLUDED.body_sha256, reason = EXCLUDED.reason,
          quality = coalesce(EXCLUDED.quality, whatsapp_templates.quality),
          decided_at = CASE WHEN EXCLUDED.status <> whatsapp_templates.status THEN now() ELSE whatsapp_templates.decided_at END,
          updated_at = now()`;
    }
  });
}

// ---------------------------------------------------------------------------
// Which number writes to a lead
// ---------------------------------------------------------------------------

export type Sender =
  | { ok: true; numberId: string; accountId: string; config: WhatsAppConfig; approved: (name: string, language: string) => boolean }
  | { ok: false; code: "NOT_CONNECTED" | "BROKEN"; message: string };

export const WHATSAPP_OFF = "WhatsApp isn't connected for this project yet, so this message wasn't sent.";

/**
 * The number that writes to buyers at `nodeId`, its token, and which of
 * the catalog's templates it may send. Refused, with the reason a person
 * reads on the lead, when there is none or it stopped working.
 */
export async function senderFor(orgId: string, nodeId: string): Promise<Sender> {
  const found = await withTenant(orgId, async (sql) => {
    const [target] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND id = ${nodeId}`;
    if (!target) return null;
    const numbers = await sql<
      { id: string; account_id: string; phone_number_id: string; node_path: string | null; active: boolean; status: string; secret: Buffer | null; on_app: boolean; registered: boolean }[]
    >`
      SELECT n.id, n.account_id, n.phone_number_id, s.path::text AS node_path, n.active, a.status, a.secret, n.on_app, n.registered
      FROM whatsapp_numbers n
      JOIN whatsapp_accounts a ON a.id = n.account_id
      LEFT JOIN scope_nodes s ON s.id = n.scope_node_id
      WHERE n.org_id = ${orgId} AND n.retired_at IS NULL AND a.status <> 'DISCONNECTED'`;
    return { path: target.path, numbers };
  });
  if (!found) return { ok: false, code: "NOT_CONNECTED", message: WHATSAPP_OFF };
  const pick = numberFor(found.numbers.map((n) => ({ ...n, nodePath: n.node_path })), found.path);
  if (!pick) return { ok: false, code: "NOT_CONNECTED", message: WHATSAPP_OFF };
  if (pick.status === "BROKEN") return { ok: false, code: "BROKEN", message: "WhatsApp stopped accepting our access for this number, so this message wasn't sent." };
  if (!pick.on_app && !pick.registered) return { ok: false, code: "BROKEN", message: "This project's WhatsApp number isn't set up to send yet, so this message wasn't sent." };
  const token = await open(orgId, whatsappPurpose(pick.account_id), pick.secret);
  if (!token) return { ok: false, code: "BROKEN", message: "WhatsApp stopped accepting our access for this number, so this message wasn't sent." };

  const rows = await withTenant(orgId, (sql) => sql<{ name: string; language: string; status: TemplateStatus; body_sha256: string }[]>`
    SELECT name, language, status, body_sha256 FROM whatsapp_templates WHERE org_id = ${orgId} AND account_id = ${pick.account_id}`);
  const byKey = new Map(rows.map((r) => [`${r.name}|${r.language}`, r]));
  const current = new Map<string, string>();
  for (const t of SUBMITTED) {
    for (const { language, body } of catalogBodies(t)) current.set(`${t.name}|${language}`, hashOf(t, language, body));
  }
  return {
    ok: true,
    numberId: pick.id,
    accountId: pick.account_id,
    config: { token, phoneNumberId: pick.phone_number_id },
    approved: (name, language) => {
      const row = byKey.get(`${name}|${language}`);
      const hash = current.get(`${name}|${language}`);
      return !!row && !!hash && templateState({ status: row.status, hash: row.body_sha256 }, hash) === "SENDS";
    },
  };
}

/** Whether any number writes to buyers anywhere in this organisation. */
export async function whatsappConnected(orgId: string): Promise<boolean> {
  const [r] = await withTenant(orgId, (sql) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM whatsapp_numbers n JOIN whatsapp_accounts a ON a.id = n.account_id
    WHERE n.org_id = ${orgId} AND n.active AND a.status = 'CONNECTED'`);
  return (r?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Keeping it working
// ---------------------------------------------------------------------------

/** How often a connected account is read back, beside its webhooks. */
export const WHATSAPP_CHECK_MS = 24 * 60 * 60 * 1000;

/**
 * Read each connected account back from Meta: whether the token works, each
 * number's quality and limit, and every template's state. A dead token is
 * BROKEN; Meta not answering changes nothing, the rule the RERA sweep
 * follows for a portal that is down. A number kept in the app whose sync
 * did not start is asked again.
 */
export async function checkWhatsApp(orgId: string, opts: { force?: boolean; now?: Date } = {}): Promise<{ checked: number; broken: number }> {
  const now = opts.now ?? new Date();
  const accounts = await withTenant(orgId, (sql) => sql<{ id: string; waba_id: string; secret: Buffer | null; last_checked_at: Date | null }[]>`
    SELECT id, waba_id, secret, last_checked_at FROM whatsapp_accounts WHERE org_id = ${orgId} AND status = 'CONNECTED'`);
  const out = { checked: 0, broken: 0 };
  for (const a of accounts) {
    if (!opts.force && a.last_checked_at && now.getTime() - a.last_checked_at.getTime() < WHATSAPP_CHECK_MS) continue;
    const token = await open(orgId, whatsappPurpose(a.id), a.secret);
    const grant = token ? await waInspect(token) : null;
    if (grant && !grant.ok) {
      await withTenant(orgId, (sql) => sql`UPDATE whatsapp_accounts SET last_error = ${grant.message.slice(0, 300)}, updated_at = now() WHERE org_id = ${orgId} AND id = ${a.id}`);
      continue;
    }
    if (!token || !grant?.ok || !grant.value.valid || !reachableWabas(grant.value.granular).includes(a.waba_id)) {
      await markBroken(orgId, a.id, "TOKEN_INVALID", "WhatsApp stopped accepting our access.");
      out.broken += 1;
      continue;
    }
    await refreshAccount(orgId, a.id, a.waba_id, token);
    await refreshTemplates(orgId, a.id, a.waba_id, token);
    await finishNumbers(orgId, a.id, token);
    await withTenant(orgId, (sql) => sql`
      UPDATE whatsapp_accounts SET last_checked_at = now(), last_error = NULL, last_error_code = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${a.id}`);
    out.checked += 1;
  }
  return out;
}

async function refreshAccount(orgId: string, accountId: string, wabaId: string, token: string): Promise<void> {
  const [account, list] = await Promise.all([waAccount(token, wabaId), waNumbers(token, wabaId)]);
  await withTenant(orgId, async (sql) => {
    if (account.ok) {
      await sql`UPDATE whatsapp_accounts SET name = ${account.value.name}, currency = ${account.value.currency}, updated_at = now()
                WHERE org_id = ${orgId} AND id = ${accountId}`;
    }
    if (!list.ok) return;
    for (const n of list.value) {
      const updated = await sql`
        UPDATE whatsapp_numbers SET display_phone = ${n.displayPhone}, verified_name = ${n.verifiedName},
          name_status = ${n.nameStatus}, quality = ${readQuality(n.quality)}, daily_limit = ${readTier(n.limit)},
          on_app = ${n.onApp}, registered = registered OR ${n.registered}, checked_at = now(), updated_at = now()
        WHERE org_id = ${orgId} AND account_id = ${accountId} AND phone_number_id = ${n.phoneNumberId} AND retired_at IS NULL`;
      if (!updated.count) {
        await sql`
          INSERT INTO whatsapp_numbers (org_id, account_id, phone_number_id, display_phone, verified_name, name_status,
                                        quality, daily_limit, on_app, registered, checked_at)
          VALUES (${orgId}, ${accountId}, ${n.phoneNumberId}, ${n.displayPhone}, ${n.verifiedName}, ${n.nameStatus},
                  ${readQuality(n.quality)}, ${readTier(n.limit)}, ${n.onApp}, ${n.registered}, now())
          ON CONFLICT DO NOTHING`;
      }
    }
  });
}

async function markBroken(orgId: string, accountId: string, code: string, message: string): Promise<void> {
  await withTenant(orgId, (sql) => sql`
    UPDATE whatsapp_accounts SET status = 'BROKEN', last_error_code = ${code}, last_error = ${message.slice(0, 300)},
      last_checked_at = now(), updated_at = now()
    WHERE org_id = ${orgId} AND id = ${accountId} AND status = 'CONNECTED'`);
}

/** Scrub an account: no token, no PIN, its numbers retired. Rows stay, because messages name them. */
async function scrubAccount(orgId: string, accountId: string, code: string | null): Promise<void> {
  await withTenant(orgId, async (sql) => {
    await sql`
      UPDATE whatsapp_numbers SET active = false, retired_at = coalesce(retired_at, now()),
        pin_secret = NULL, pin_key_version = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND account_id = ${accountId}`;
    await sql`
      UPDATE whatsapp_accounts SET status = 'DISCONNECTED', secret = NULL, key_version = NULL,
        last_error_code = ${code}, last_error = NULL, updated_at = now()
      WHERE org_id = ${orgId} AND id = ${accountId}`;
  });
}

/** Stop using an account: our subscription off at Meta (best effort), then the scrub, which is not. */
export async function disconnectWhatsApp(input: { orgId: string; userId: string; accountId: string }): Promise<Outcome> {
  if (!isNodeId(input.accountId)) return { ok: true, message: "Already disconnected." };
  const a = await withTenant(input.orgId, async (sql) => {
    const [r] = await sql<{ id: string; waba_id: string; secret: Buffer | null }[]>`
      SELECT id, waba_id, secret FROM whatsapp_accounts WHERE org_id = ${input.orgId} AND id = ${input.accountId} AND status <> 'DISCONNECTED'`;
    return r ?? null;
  });
  if (!a) return { ok: true, message: "Already disconnected." };
  const token = await open(input.orgId, whatsappPurpose(a.id), a.secret);
  const off = token ? await waUnsubscribe(token, a.waba_id) : null;
  await scrubAccount(input.orgId, a.id, null);
  await audit({
    orgId: input.orgId,
    actorUserId: input.userId,
    action: "whatsapp.disconnected",
    targetType: "whatsapp_account",
    targetId: a.id,
    metadata: { unsubscribed: !!off?.ok },
  });
  return { ok: true, message: "WhatsApp is disconnected. Nothing more is sent from it." };
}

// ---------------------------------------------------------------------------
// Meta's account webhooks
// ---------------------------------------------------------------------------

/**
 * Template decisions, quality, a number's state and the account's own
 * events, routed to the tenant by the WABA through the one lookup that
 * returns ids only. A developer removing us scrubs the token at once.
 * Messages the developer's team sent from the WhatsApp Business app land
 * on the lead they were written to, so the timeline has the whole
 * conversation.
 */
export async function ingestWabaEvents(body: unknown): Promise<{ events: number }> {
  const events = readWabaEvents(body);
  let handled = 0;
  const owners = new Map<string, { org_id: string; account_id: string }[]>();
  const ownersOf = async (wabaId: string) => {
    if (!owners.has(wabaId)) {
      owners.set(wabaId, await withNoTenant((sql) => sql<{ org_id: string; account_id: string }[]>`
        SELECT org_id, account_id FROM whatsapp_waba_owner(${wabaId})`));
    }
    return owners.get(wabaId)!;
  };
  const refreshed = new Set<string>();

  for (const e of events) {
    for (const o of await ownersOf(e.wabaId)) {
      handled += 1;
      switch (e.kind) {
        case "TEMPLATE_STATUS":
          await withTenant(o.org_id, (sql) => sql`
            UPDATE whatsapp_templates SET status = ${e.status}, reason = ${e.reason},
              meta_template_id = coalesce(meta_template_id, ${e.templateId}), decided_at = now(), updated_at = now()
            WHERE org_id = ${o.org_id} AND account_id = ${o.account_id} AND name = ${e.name} AND language = ${e.language}`);
          break;
        case "TEMPLATE_QUALITY":
          await withTenant(o.org_id, (sql) => sql`
            UPDATE whatsapp_templates SET quality = ${e.quality}, updated_at = now()
            WHERE org_id = ${o.org_id} AND account_id = ${o.account_id} AND name = ${e.name} AND language = ${e.language}`);
          break;
        case "TEMPLATE_CATEGORY":
          await withTenant(o.org_id, (sql) => sql`
            UPDATE whatsapp_templates SET category = ${e.category}, updated_at = now()
            WHERE org_id = ${o.org_id} AND account_id = ${o.account_id} AND name = ${e.name} AND language = ${e.language}`);
          break;
        case "NUMBER_CHANGED": {
          if (refreshed.has(o.account_id)) break;
          refreshed.add(o.account_id);
          const [a] = await withTenant(o.org_id, (sql) => sql<{ secret: Buffer | null }[]>`
            SELECT secret FROM whatsapp_accounts WHERE org_id = ${o.org_id} AND id = ${o.account_id} AND status = 'CONNECTED'`);
          const token = a ? await open(o.org_id, whatsappPurpose(o.account_id), a.secret) : null;
          if (token) await refreshAccount(o.org_id, o.account_id, e.wabaId, token);
          break;
        }
        case "ACCOUNT":
          if (REMOVED_EVENTS.has(e.event)) {
            await scrubAccount(o.org_id, o.account_id, e.event);
            await audit({ orgId: o.org_id, actorUserId: null, action: "whatsapp.removed_by_developer", targetType: "whatsapp_account", targetId: o.account_id, metadata: { event: e.event } });
          } else if (TROUBLE_EVENTS.has(e.event)) {
            await withTenant(o.org_id, (sql) => sql`
              UPDATE whatsapp_accounts SET last_error_code = ${e.event}, updated_at = now()
              WHERE org_id = ${o.org_id} AND id = ${o.account_id}`);
          }
          break;
        case "PREFERENCE": {
          const { recordMarketingStop } = await import("./broadcast.ts");
          await recordMarketingStop({ orgId: o.org_id, phone: e.phone, source: "META_PREFERENCE", resumed: !e.stop });
          break;
        }
        case "ECHO":
          await withTenant(o.org_id, async (sql) => {
            const [num] = await sql<{ id: string }[]>`
              SELECT id FROM whatsapp_numbers WHERE org_id = ${o.org_id} AND phone_number_id = ${e.phoneNumberId} AND retired_at IS NULL`;
            const [lead] = await sql<{ id: string }[]>`
              SELECT id FROM leads WHERE org_id = ${o.org_id} AND phone = ${e.to} ORDER BY last_activity_at DESC LIMIT 1`;
            // Only a conversation with somebody who is a lead here. The rest
            // of the developer's WhatsApp is theirs, not ours to keep.
            if (!lead) return;
            await sql`
              INSERT INTO messages (org_id, lead_id, direction, channel, purpose, category, body, phone, status, provider_id,
                                    number_id, created_at, sent_at)
              VALUES (${o.org_id}, ${lead.id}, 'OUT', 'WHATSAPP', 'FROM_APP', 'SERVICE', ${e.text}, ${e.to}, 'SENT', ${e.id},
                      ${num?.id ?? null}, ${new Date(e.at)}, ${new Date(e.at)})
              ON CONFLICT (provider_id) WHERE provider_id IS NOT NULL DO NOTHING`;
          });
          break;
      }
    }
  }
  return { events: handled };
}

// ---------------------------------------------------------------------------
// Reading, for the screen
// ---------------------------------------------------------------------------

export type TemplateRowView = { name: string; label: string; language: string; category: string; state: TemplateState; reason: string | null };

export type NumberView = {
  id: string;
  display: string;
  name: string;
  quality: Quality;
  limit: Tier | null;
  onApp: boolean;
  active: boolean;
  place: { id: string; name: string } | null;
  needs: NumberNeed | null;
};

export type AccountView = {
  id: string;
  name: string;
  status: "CONNECTED" | "BROKEN";
  currency: string | null;
  lastError: string | null;
  connectedAt: string;
  lastCheckedAt: string | null;
  numbers: NumberView[];
  templates: TemplateRowView[];
};

export async function listWhatsApp(orgId: string): Promise<AccountView[]> {
  const { accounts, numbers, templates } = await withTenant(orgId, async (sql) => {
    const [accounts, numbers, templates] = await Promise.all([
      sql<{ id: string; name: string; status: "CONNECTED" | "BROKEN"; currency: string | null; last_error: string | null; connected_at: Date; last_checked_at: Date | null }[]>`
        SELECT id, name, status, currency, last_error, connected_at, last_checked_at FROM whatsapp_accounts
        WHERE org_id = ${orgId} AND status <> 'DISCONNECTED' ORDER BY connected_at`,
      sql<{ id: string; account_id: string; display_phone: string; verified_name: string; quality: Quality; daily_limit: Tier | null;
            on_app: boolean; registered: boolean; register_error: string | null; active: boolean; scope_node_id: string | null; node_name: string | null }[]>`
        SELECT n.id, n.account_id, n.display_phone, n.verified_name, n.quality, n.daily_limit, n.on_app, n.registered,
               n.register_error, n.active, n.scope_node_id, s.name AS node_name
        FROM whatsapp_numbers n LEFT JOIN scope_nodes s ON s.id = n.scope_node_id
        WHERE n.org_id = ${orgId} AND n.retired_at IS NULL ORDER BY n.created_at`,
      sql<{ account_id: string; name: string; language: string; status: TemplateStatus; body_sha256: string; reason: string | null; category: string | null }[]>`
        SELECT account_id, name, language, status, body_sha256, reason, category FROM whatsapp_templates WHERE org_id = ${orgId}`,
    ]);
    return { accounts, numbers, templates };
  });

  return accounts.map((a) => {
    const rows = templates.filter((t) => t.account_id === a.id);
    const views: TemplateRowView[] = [];
    for (const t of SUBMITTED) {
      for (const { language, body } of catalogBodies(t)) {
        const row = rows.find((r) => r.name === t.name && r.language === language) ?? null;
        const state = templateState(row ? { status: row.status, hash: row.body_sha256 } : null, hashOf(t, language, body));
        views.push({
          name: t.name,
          label: t.label,
          language,
          category: row?.category ?? t.category,
          state,
          reason: state === "REFUSED" || row?.status === "FAILED" ? row?.reason ?? null : null,
        });
      }
    }
    return {
      id: a.id,
      name: a.name,
      status: a.status,
      currency: a.currency,
      lastError: a.last_error,
      connectedAt: a.connected_at.toISOString(),
      lastCheckedAt: a.last_checked_at?.toISOString() ?? null,
      templates: views,
      numbers: numbers
        .filter((n) => n.account_id === a.id)
        .map((n) => ({
          id: n.id,
          display: n.display_phone,
          name: n.verified_name,
          quality: n.quality,
          limit: n.daily_limit,
          onApp: n.on_app,
          active: n.active,
          place: n.scope_node_id && n.node_name ? { id: n.scope_node_id, name: n.node_name } : null,
          needs: numberNeeds({
            accountStatus: a.status,
            currency: a.currency,
            quality: n.quality,
            registered: n.registered,
            registerError: n.register_error,
            onApp: n.on_app,
            active: n.active,
          }),
        })),
    };
  });
}

/** What the connections page's card needs, in one read. */
export async function whatsappSummary(orgId: string): Promise<{ accounts: number; numbers: { display: string; place: string | null }[]; needs: string | null; broken: boolean }> {
  const accounts = await listWhatsApp(orgId);
  const numbers = accounts.flatMap((a) => a.numbers.map((n) => ({ display: n.display, place: n.place?.name ?? null, needs: n.needs?.text ?? null })));
  const broken = accounts.some((a) => a.status === "BROKEN");
  const refused = accounts.some((a) => a.templates.some((t) => t.state === "REFUSED"));
  const needs = broken
    ? "WhatsApp stopped accepting our access. Connect it again."
    : numbers.find((n) => n.needs)?.needs ?? (refused ? "Meta did not approve some messages." : null);
  return { accounts: accounts.length, numbers: numbers.map(({ display, place }) => ({ display, place })), needs, broken };
}

