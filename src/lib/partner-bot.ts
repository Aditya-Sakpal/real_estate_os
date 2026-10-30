import type { TransactionSql } from "postgres";
import { audit, auditHash, controlDb, withTenant } from "./db/index.ts";
import { startChallenge, verifyChallenge } from "./otp.ts";
import { phoneHash } from "./otp-rules.ts";
import { askJson, type AskDriver } from "./generate.ts";
import { normalisePhone } from "./calling-rules.ts";
import { isStop, type Voice } from "./message-rules.ts";
import { redactPhones, spacedPhone } from "./mask-rules.ts";
import { parseVisitTime } from "./cadence-rules.ts";
import { canPublish } from "./publish-gate.ts";
import { approvedUnits } from "./unit.ts";
import { bedCountsIn, configDef, priceFor } from "./unit-rules.ts";
import { istDay } from "./partner-rules.ts";
import { deskFirm, makeLink, registerBuyer } from "./partners.ts";
import { partnerPost } from "./partner-posts.ts";
import { bookPartnerVisit, processEvent } from "./lead-engine.ts";
import { recordEvent } from "./leads.ts";
import { whatsapp, type WhatsAppConfig } from "./whatsapp.ts";
import { configFor, deliver, firmPayouts, numberAt } from "./partner-notify.ts";
import * as B from "./partner-bot-rules.ts";

/**
 * The partner's WhatsApp bot, on the developer's own number (section 07).
 *
 * A message to a developer's number arrives through `ingestWhatsApp()`,
 * which stores it and asks this file whether it is ours: a person on a
 * firm's list, or a buyer whose message carries a partner's ref code.
 *
 * Five rules.
 *
 * 1. **The number is proved once, then it is the credential.** The first
 *    message from somebody on the list gets a code from Sales Desk's own
 *    number; the code sent back here makes them a user known by that phone,
 *    with a membership in their own firm's org. It is weak, so the bot does
 *    only the in-session things: stock, registering, visits, the firm's own
 *    payouts and creative.
 * 2. **Three things ask for a fresh code, each time, for that one thing**:
 *    confirming an invoice, seeing a buyer's whole number, and an export.
 *    Four never happen here at all (a bank account, anybody's access, a
 *    price, approving a payout), and the bot says so.
 * 3. **The grant is read on every message, never remembered.** A firm whose
 *    empanelment lapsed at midnight is refused at 09:10.
 * 4. **The model picks an action; code does everything else.** The model
 *    never sees a phone number (they are swapped for `#1` first) and never
 *    writes a word the partner reads. Obvious messages never reach it.
 * 5. **Everything is a row.** The message in (its numbers masked), each
 *    reply, each turn with what reading it cost, and every write's own audit
 *    row. A reply that shows a whole number is stored without it.
 */

type Sql = TransactionSql;

export type Inbound = {
  orgId: string;
  /** The developer's number it was written to. */
  numberId: string;
  /** Our `messages` row for it, already stored. */
  messageId: string;
  /** Meta's id for it: a lead event's key when it becomes one. */
  providerId: string;
  from: string;
  text: string;
  at: string;
  profileName: string | null;
};

// ---------------------------------------------------------------------------
// The model, behind a seam
// ---------------------------------------------------------------------------

let model: AskDriver | null = null;

/** For checks: every message the bot cannot read on its own goes to `driver`. */
export function usePartnerModel(driver: AskDriver): { restore(): void } {
  model = driver;
  return { restore: () => void (model = null) };
}

// ---------------------------------------------------------------------------
// Who wrote
// ---------------------------------------------------------------------------

type Agent = {
  id: string;
  firm_id: string;
  cp_org_id: string;
  name: string;
  phone: string;
  is_principal: boolean;
  status: "WAITING" | "ACTIVE";
  user_id: string | null;
  muted_at: Date | null;
  /** The language this person reads the bot in: `hi`, `en` or `mr`. */
  language: string;
  firm: string;
  rm: string | null;
};

type Pending = {
  id: string;
  kind: "BIND" | "STEP_UP" | "CONFIRM" | "CHOOSE";
  action: Record<string, unknown>;
  challenge_id: string | null;
  expires_at: Date;
};

type Ctx = {
  m: Inbound;
  agent: Agent;
  now: Date;
  developer: string;
  config: WhatsAppConfig | null;
  /** The version every reply is written in, from the person's own choice. */
  voice: Voice;
};

/**
 * A message the developer's number received: the bot's, a partner's link
 * tapped, or neither. Never throws into the webhook.
 */
export async function partnerInbound(m: Inbound, opts: { now?: Date } = {}): Promise<"agent" | "tap" | null> {
  try {
    const now = opts.now ?? new Date();
    const agent = await agentByPhone(m.orgId, m.from);
    if (agent) {
      await handleAgent(m, agent, now);
      return "agent";
    }
    const code = B.refCodeIn(m.text);
    if (code && (await handleTap(m, code))) return "tap";
    return null;
  } catch (e) {
    console.error("partner bot: could not handle a message", e);
    return null;
  }
}

async function agentByPhone(orgId: string, phone: string): Promise<Agent | null> {
  const [a] = await withTenant(orgId, (sql) => sql<Agent[]>`
    SELECT a.id, a.firm_id, a.cp_org_id, a.name, a.phone, a.is_principal, a.status, a.user_id, a.muted_at, a.language,
           f.name AS firm, coalesce(u.name, split_part(u.email::text, '@', 1)) AS rm
    FROM partner_agents a
    JOIN partner_firms f ON f.id = a.firm_id
    LEFT JOIN users u ON u.id = f.rm_id
    WHERE a.org_id = ${orgId} AND a.phone = ${phone} AND a.status <> 'REMOVED'`);
  return a ?? null;
}

// ---------------------------------------------------------------------------
// Replying
// ---------------------------------------------------------------------------

/** One reply, stored first. `stored` replaces the body in the row when the reply shows a whole number. */
async function reply(ctx: Ctx, body: string, stored?: string): Promise<void> {
  const [row] = await withTenant(ctx.m.orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO messages (org_id, direction, purpose, category, language, body, phone, status, number_id, partner_agent_id)
    VALUES (${ctx.m.orgId}, 'OUT', 'PARTNER_BOT', 'SERVICE', 'en', ${(stored ?? body).slice(0, 4096)}, ${ctx.agent.phone},
            ${ctx.config ? "QUEUED" : "FAILED"}, ${ctx.m.numberId}, ${ctx.agent.id})
    RETURNING id`);
  const config = ctx.config;
  if (!config) {
    await withTenant(ctx.m.orgId, (sql) => sql`
      UPDATE messages SET error = 'This WhatsApp number stopped working, so the reply was not sent.' WHERE org_id = ${ctx.m.orgId} AND id = ${row.id}`);
    return;
  }
  await deliver(ctx.m.orgId, row.id, () => {
    const d = whatsapp();
    if (!d.sendText) throw new Error("This WhatsApp connection cannot send a plain reply.");
    return d.sendText(config, { to: ctx.agent.phone, body, callbackData: `${ctx.m.orgId}:${row.id}` });
  });
}

async function sendFile(ctx: Ctx, f: { kind: "image" | "document"; bytes: Buffer; mediaType: string; filename: string; caption?: string; stored: string }): Promise<boolean> {
  const config = ctx.config;
  if (!config) return false;
  const [row] = await withTenant(ctx.m.orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO messages (org_id, direction, purpose, category, language, body, phone, status, number_id, partner_agent_id)
    VALUES (${ctx.m.orgId}, 'OUT', 'PARTNER_BOT', 'SERVICE', 'en', ${f.stored.slice(0, 4096)}, ${ctx.agent.phone}, 'QUEUED', ${ctx.m.numberId}, ${ctx.agent.id})
    RETURNING id`);
  return deliver(ctx.m.orgId, row.id, () => {
    const d = whatsapp();
    if (!d.sendMedia) throw new Error("This WhatsApp connection cannot send a file.");
    return d.sendMedia(config, {
      to: ctx.agent.phone,
      kind: f.kind,
      bytes: f.bytes,
      mediaType: f.mediaType,
      filename: f.filename,
      caption: f.caption,
      callbackData: `${ctx.m.orgId}:${row.id}`,
    });
  });
}

async function turn(ctx: Ctx, action: string, outcome: "DONE" | "ASKED" | "REFUSED" | "UNCLEAR" | "CAPPED", usd: number | null = null): Promise<void> {
  await withTenant(ctx.m.orgId, (sql) => sql`
    INSERT INTO partner_bot_turns (org_id, agent_id, firm_id, message_id, action, outcome, model, usd, created_at)
    VALUES (${ctx.m.orgId}, ${ctx.agent.id}, ${ctx.agent.firm_id}, ${ctx.m.messageId}, ${action}, ${outcome},
            ${usd === null ? null : B.BOT_MODEL}, ${usd}, ${ctx.now})`);
}

// ---------------------------------------------------------------------------
// What the bot is waiting on
// ---------------------------------------------------------------------------

async function openPending(orgId: string, agentId: string): Promise<Pending | null> {
  const [p] = await withTenant(orgId, (sql) => sql<Pending[]>`
    SELECT id, kind, action, challenge_id, expires_at FROM partner_bot_pending
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND done_at IS NULL`);
  return p ?? null;
}

async function closePending(orgId: string, id: string): Promise<void> {
  // A closed row keeps what it was for, and never a buyer's number.
  await withTenant(orgId, (sql) => sql`
    UPDATE partner_bot_pending SET done_at = now(), action = action - 'phone' WHERE org_id = ${orgId} AND id = ${id} AND done_at IS NULL`);
}

async function setPending(ctx: Ctx, p: { kind: Pending["kind"]; action: Record<string, unknown>; challengeId?: string; seconds: number }): Promise<void> {
  await withTenant(ctx.m.orgId, async (sql) => {
    await sql`
      UPDATE partner_bot_pending SET done_at = now(), action = action - 'phone'
      WHERE org_id = ${ctx.m.orgId} AND agent_id = ${ctx.agent.id} AND done_at IS NULL`;
    await sql`
      INSERT INTO partner_bot_pending (org_id, agent_id, kind, action, challenge_id, expires_at, created_at)
      VALUES (${ctx.m.orgId}, ${ctx.agent.id}, ${p.kind}, ${sql.json(p.action as never)}, ${p.challengeId ?? null},
              ${new Date(ctx.now.getTime() + p.seconds * 1000)}, ${ctx.now})`;
  });
}

// ---------------------------------------------------------------------------
// A person on a firm's list
// ---------------------------------------------------------------------------

const dayStart = (now: Date) => new Date(`${istDay(now.toISOString())}T00:00:00+05:30`);

async function handleAgent(m: Inbound, agent: Agent, now: Date): Promise<void> {
  const [org] = await withTenant(m.orgId, (sql) => sql<{ display_name: string }[]>`SELECT display_name FROM orgs WHERE id = ${m.orgId}`);
  const ctx: Ctx = {
    m,
    agent,
    now,
    developer: org?.display_name ?? "Developer",
    config: await configFor(m.orgId, m.numberId),
    voice: B.partnerVoice(agent.language),
  };

  // What the partner wrote is kept with its numbers masked.
  await withTenant(m.orgId, (sql) => sql`
    UPDATE messages SET partner_agent_id = ${agent.id}, body = ${redactPhones(m.text, "MASKED")}
    WHERE org_id = ${m.orgId} AND id = ${m.messageId}`);

  if (isStop(m.text)) {
    await withTenant(m.orgId, (sql) => sql`UPDATE partner_agents SET muted_at = now(), updated_at = now() WHERE org_id = ${m.orgId} AND id = ${agent.id}`);
    await reply(ctx, B.say(ctx.voice, "muted"));
    return turn(ctx, "stop", "DONE");
  }
  if (B.isStart(m.text) && agent.muted_at) {
    await withTenant(m.orgId, (sql) => sql`UPDATE partner_agents SET muted_at = NULL, updated_at = now() WHERE org_id = ${m.orgId} AND id = ${agent.id}`);
    await reply(ctx, B.say(ctx.voice, "unmuted"));
    return turn(ctx, "start", "DONE");
  }

  // The day's allowance, counted before anything costs money.
  const [c] = await withTenant(m.orgId, (sql) => sql<{ mine: number; firm: number; told: number }[]>`
    SELECT
      (SELECT count(*)::int FROM partner_bot_turns WHERE org_id = ${m.orgId} AND agent_id = ${agent.id} AND created_at >= ${dayStart(now)}) AS mine,
      (SELECT count(*)::int FROM partner_bot_turns WHERE org_id = ${m.orgId} AND firm_id = ${agent.firm_id} AND created_at >= ${dayStart(now)}) AS firm,
      (SELECT count(*)::int FROM partner_bot_turns WHERE org_id = ${m.orgId} AND agent_id = ${agent.id} AND outcome = 'CAPPED'
         AND created_at >= ${dayStart(now)}) AS told`);
  if (c.mine >= B.TURNS_PER_AGENT_DAY || c.firm >= B.TURNS_PER_FIRM_DAY) {
    if (!c.told) await reply(ctx, B.say(ctx.voice, "capped"));
    return turn(ctx, "capped", "CAPPED");
  }

  // The language this person reads the bot in: theirs to choose, at any
  // point, and it costs nothing, so it is read before anything else.
  const language = B.languageIn(m.text);
  if (language) return setLanguage(ctx, language);
  if (B.isLanguageAsk(m.text)) return askLanguage(ctx);

  const pending = await openPending(m.orgId, agent.id);
  const code = B.codeIn(m.text);

  if (agent.status === "WAITING") return bind(ctx, pending, code);

  // The grant, read now.
  const projects = await liveProjects(m.orgId, agent.cp_org_id);
  if (!projects.length) {
    if (pending) await closePending(m.orgId, pending.id);
    await reply(ctx, B.noGrantLine(ctx.developer, agent.rm, ctx.voice));
    return turn(ctx, "no_grant", "REFUSED");
  }

  if (pending) {
    const live = pending.expires_at.getTime() > now.getTime();
    if (live && pending.kind === "STEP_UP" && code) return finishStepUp(ctx, pending, code, projects);
    if (live && pending.kind === "CONFIRM" && B.isYes(m.text)) return finishConfirm(ctx, pending, projects);
    if (live && pending.kind === "CHOOSE") {
      const options = (pending.action.options as string[] | undefined) ?? [];
      const pick = B.pickIn(m.text, options.length);
      if (pick) return finishChoose(ctx, pending, options[pick - 1], projects);
    }
    if (live && B.isNo(m.text)) {
      await closePending(m.orgId, pending.id);
      await reply(ctx, B.say(ctx.voice, "cancelled"));
      return turn(ctx, "cancel", "DONE");
    }
    if (!live && pending.kind === "CONFIRM" && B.isYes(m.text)) {
      await closePending(m.orgId, pending.id);
      await reply(ctx, B.heldTooLong(ctx.voice));
      return turn(ctx, "book_visit", "REFUSED");
    }
  }

  const hidden = B.hidePhones(m.text);
  let intent = B.quickIntent(hidden.text, hidden.numbers);
  let usd: number | null = null;
  if (!intent && !code) {
    // The organisation's ceiling on messages the model reads, counted first.
    const [{ reads }] = await withTenant(m.orgId, (sql) => sql<{ reads: number }[]>`
      SELECT count(*)::int AS reads FROM partner_bot_turns
      WHERE org_id = ${m.orgId} AND model IS NOT NULL AND created_at >= ${dayStart(now)}`);
    if (reads >= B.MODEL_READS_PER_ORG_DAY) {
      await reply(ctx, B.say(ctx.voice, "reads_capped"));
      return turn(ctx, "unclear", "CAPPED");
    }
    const r = await (model ?? askJson)({
      model: B.BOT_MODEL,
      system: B.botInstructions(),
      parts: [{ text: hidden.text.slice(0, 600) }],
      schema: B.INTENT_SCHEMA,
      name: "partner_action",
      timeoutMs: 20_000,
      effort: "minimal",
    });
    usd = B.turnUsd(hidden.text.length);
    intent = r.ok ? B.readIntent(r.value) : { action: "unclear", ...B.EMPTY };
  }
  intent ??= { action: "unclear", ...B.EMPTY };
  return dispatch(ctx, intent, hidden.numbers, projects, usd);
}

/** The person chose a language: every reply from now on, and every payout update, is in it. */
async function setLanguage(ctx: Ctx, language: B.PartnerLanguage): Promise<void> {
  await withTenant(ctx.m.orgId, (sql) => sql`
    UPDATE partner_agents SET language = ${language}, updated_at = now() WHERE org_id = ${ctx.m.orgId} AND id = ${ctx.agent.id}`);
  ctx.agent.language = language;
  ctx.voice = B.partnerVoice(language);
  await reply(ctx, B.say(ctx.voice, "language_set"));
  return turn(ctx, "language", "DONE");
}

/**
 * "language" on its own: the three to pick from. A person who has proved
 * their number picks by number; one still waiting on their code is waiting
 * on that, so they are shown the names to write instead and the code stays
 * what the bot is waiting for.
 */
async function askLanguage(ctx: Ctx): Promise<void> {
  const names = B.PARTNER_LANGUAGES.map((l) => B.LANGUAGE_NAMES[l]);
  if (ctx.agent.status !== "ACTIVE") {
    await reply(ctx, [B.say(ctx.voice, "which_language"), ...names.map((n) => `• ${n}`), B.say(ctx.voice, "type_one")].join("\n"));
    return turn(ctx, "language", "ASKED");
  }
  await setPending(ctx, { kind: "CHOOSE", action: { for: "language", options: [...B.PARTNER_LANGUAGES] }, seconds: B.CHOOSE_MINUTES * 60 });
  await reply(ctx, B.chooseText(B.say(ctx.voice, "which_language"), names, ctx.voice));
  return turn(ctx, "language", "ASKED");
}

/** Somebody on the list who has not proved their number yet. */
async function bind(ctx: Ctx, pending: Pending | null, code: string | null): Promise<void> {
  const { m, agent } = ctx;
  const waiting = pending?.kind === "BIND" && pending.expires_at.getTime() > ctx.now.getTime();
  if (waiting && !code) {
    // A code is on its way; another would only trip the limit on codes.
    await reply(ctx, B.say(ctx.voice, "code_pending"));
    return turn(ctx, "bind", "ASKED");
  }
  if (waiting && code) {
    const v = await verifyChallenge({ challengeId: pending!.challenge_id!, phone: agent.phone, code, purpose: "SIGN_IN", now: ctx.now });
    if (!v.ok) {
      await reply(ctx, B.say(ctx.voice, "code_wrong"));
      return turn(ctx, "bind", "REFUSED");
    }
    await closePending(m.orgId, pending!.id);
    const userId = await bindAgent(m.orgId, agent);
    await audit({ orgId: m.orgId, actorUserId: userId, action: "partner.agent_bound", targetType: "partner_agent", targetId: agent.id, metadata: { phone: phoneHash(agent.phone) } });
    await reply(ctx, B.boundLine(agent.name, ctx.voice));
    return turn(ctx, "bind", "DONE");
  }
  const started = await startChallenge({ purpose: "SIGN_IN", phone: agent.phone, orgId: m.orgId, now: ctx.now });
  if (!started.ok) {
    await reply(ctx, started.message);
    return turn(ctx, "bind", "REFUSED");
  }
  await setPending(ctx, { kind: "BIND", action: { action: "bind" }, challengeId: started.challengeId, seconds: 300 });
  await reply(ctx, B.bindAsk(agent.name, ctx.developer, ctx.voice));
  return turn(ctx, "bind", "ASKED");
}

/**
 * The number is proved: a user known by that phone, and a membership in the
 * firm's own org. Sign-in, so the control connection; the developer's own
 * row moves inside its tenant.
 */
async function bindAgent(orgId: string, agent: Agent): Promise<string> {
  const [u] = await controlDb<{ id: string }[]>`
    INSERT INTO users (phone, phone_verified_at, name) VALUES (${agent.phone}, now(), ${agent.name})
    ON CONFLICT (phone) DO UPDATE SET phone_verified_at = coalesce(users.phone_verified_at, now())
    RETURNING id`;
  const [root] = await controlDb<{ id: string }[]>`
    SELECT id FROM scope_nodes WHERE org_id = ${agent.cp_org_id} AND kind = 'ORG' ORDER BY created_at LIMIT 1`;
  if (root) {
    await controlDb`
      INSERT INTO memberships (user_id, org_id, scope_node_id, role, status, accepted_at)
      VALUES (${u.id}, ${agent.cp_org_id}, ${root.id}, ${agent.is_principal ? "CP_OWNER" : "CP_AGENT"}, 'ACTIVE', now())
      ON CONFLICT (user_id, scope_node_id, role) WHERE status <> 'REVOKED' DO NOTHING`;
  }
  await withTenant(orgId, (sql) => sql`
    UPDATE partner_agents SET status = 'ACTIVE', user_id = ${u.id}, bound_at = now(), updated_at = now()
    WHERE org_id = ${orgId} AND id = ${agent.id} AND status = 'WAITING'`);
  agent.user_id = u.id;
  agent.status = "ACTIVE";
  return u.id;
}

// ---------------------------------------------------------------------------
// The firm's projects, read on every message
// ---------------------------------------------------------------------------

type Project = { id: string; name: string; path: string };

async function liveProjects(orgId: string, cpOrgId: string): Promise<Project[]> {
  return withTenant(orgId, (sql) => sql<Project[]>`
    SELECT n.id, n.name, n.path::text AS path FROM grants g JOIN scope_nodes n ON n.id = g.scope_node_id
    WHERE g.org_id = ${orgId} AND g.grantee_org_id = ${cpOrgId} AND g.status = 'ACTIVE'
      AND g.valid_from <= now() AND g.valid_to > now()
    ORDER BY n.name`);
}

type Tower = { id: string; name: string; path: string; projectId: string; project: string };

async function towersOf(sql: Sql, orgId: string, projects: Project[]): Promise<Tower[]> {
  return sql<Tower[]>`
    SELECT t.id, t.name, t.path::text AS path, p.id AS "projectId", p.name AS project
    FROM scope_nodes t JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
    WHERE t.org_id = ${orgId} AND t.kind = 'PHASE' AND p.id = ANY(${projects.map((p) => p.id)})
    ORDER BY p.name, t.name`;
}

type Claim = { id: string; phone: string; buyer: string; project: string; projectId: string; validUntil: Date; visited: boolean };

/** The firm's live claims here: the only buyers it may book a visit for. */
async function liveClaims(orgId: string, cpOrgId: string): Promise<Claim[]> {
  return withTenant(orgId, (sql) => sql<Claim[]>`
    SELECT r.id, r.phone, coalesce(l.name, r.buyer_name, 'Buyer') AS buyer, n.name AS project, r.scope_node_id AS "projectId",
           r.valid_until AS "validUntil",
           EXISTS (SELECT 1 FROM site_visits v WHERE v.org_id = r.org_id AND v.lead_id = r.lead_id AND v.status IN ('ON_SITE', 'VISITED')) AS visited
    FROM client_registrations r JOIN scope_nodes n ON n.id = r.scope_node_id
    LEFT JOIN leads l ON l.id = r.lead_id
    WHERE r.org_id = ${orgId} AND r.cp_org_id = ${cpOrgId} AND r.verdict = 'REGISTERED' AND r.status = 'ACTIVE' AND r.valid_until > now()
    ORDER BY r.valid_until`);
}

/** Claims matching what the partner wrote: a number, or part of a name. */
function claimsFor(claims: Claim[], buyer: string | null, numbers: readonly string[]): Claim[] {
  const phone = B.phoneBack(buyer, numbers);
  const e164 = phone ? normalisePhone(phone) : null;
  if (e164) return claims.filter((c) => c.phone === e164);
  if (buyer && !/^#\d+$/.test(buyer)) {
    const q = buyer.toLowerCase();
    return claims.filter((c) => c.buyer.toLowerCase().includes(q));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Doing what was asked
// ---------------------------------------------------------------------------

async function dispatch(ctx: Ctx, intent: B.Intent, numbers: string[], projects: Project[], usd: number | null): Promise<void> {
  switch (intent.action) {
    case "help":
      await reply(ctx, B.helpText(ctx.developer, ctx.voice));
      return turn(ctx, "help", "DONE", usd);
    case "unclear":
      await reply(ctx, B.say(ctx.voice, "unclear"));
      return turn(ctx, "unclear", "UNCLEAR", usd);
    case "not_here":
      await reply(ctx, B.notHereLine(intent.what, ctx.agent.rm, ctx.voice));
      return turn(ctx, "not_here", "REFUSED", usd);
    case "register":
      return register(ctx, intent, numbers, projects, usd);
    case "my_buyers":
      return myBuyers(ctx, usd);
    case "book_visit":
      return bookVisit(ctx, intent, numbers, projects, usd);
    case "payout_status":
      return payoutStatus(ctx, usd);
    case "inventory":
      return inventory(ctx, intent, projects, usd);
    case "creative":
      return creative(ctx, intent, projects, usd);
    case "attest_invoice":
      return attest(ctx, usd);
    case "unmask":
      return unmask(ctx, intent, numbers, usd);
    case "export":
      return stepUp(ctx, { action: "registrations:export", target: null }, B.say(ctx.voice, "what_export"), usd);
  }
}

async function register(ctx: Ctx, intent: B.Intent, numbers: string[], projects: Project[], usd: number | null, projectId?: string): Promise<void> {
  const raw = B.phoneBack(intent.buyer, numbers);
  const phone = raw ? normalisePhone(raw) : null;
  if (!phone) {
    await reply(ctx, B.say(ctx.voice, "ask_number"));
    return turn(ctx, "register", "ASKED", usd);
  }
  const named = projects.filter((p) => B.names(intent.project, p.name) || B.names(intent.tower, p.name));
  const project = projectId ? projects.find((p) => p.id === projectId) : projects.length === 1 ? projects[0] : named.length === 1 ? named[0] : null;
  if (!project) {
    await setPending(ctx, {
      kind: "CHOOSE",
      action: { for: "register", options: projects.map((p) => p.id), phone, name: intent.name },
      seconds: B.CHOOSE_MINUTES * 60,
    });
    await reply(ctx, B.chooseText(B.say(ctx.voice, "which_project"), projects.map((p) => p.name), ctx.voice));
    return turn(ctx, "register", "ASKED", usd);
  }
  const out = await registerBuyer({
    orgId: ctx.m.orgId,
    userId: ctx.agent.user_id,
    // The firm's row on the desk that has it on this project: it may sit on two (0092).
    firmId: await deskFirm(ctx.m.orgId, ctx.agent.firm_id, project.id),
    projectId: project.id,
    phone,
    buyerName: intent.name,
    agentName: ctx.agent.name,
    agentId: ctx.agent.id,
    via: "WHATSAPP",
    nowIso: ctx.now.toISOString(),
  });
  if (!out.ok) {
    await reply(ctx, out.message);
    return turn(ctx, "register", "REFUSED", usd);
  }
  await reply(
    ctx,
    B.verdictLine({ verdict: out.verdict, phone, project: project.name, validUntil: out.validUntil, today: istDay(ctx.now.toISOString()), voice: ctx.voice }),
  );
  return turn(ctx, "register", out.verdict === "REGISTERED" || out.verdict === "ALREADY" ? "DONE" : "REFUSED", usd);
}

async function myBuyers(ctx: Ctx, usd: number | null): Promise<void> {
  const claims = await liveClaims(ctx.m.orgId, ctx.agent.cp_org_id);
  const shown = claims.slice(0, 10);
  await reply(
    ctx,
    B.claimsText(
      shown.map((c) => ({ buyer: c.buyer, phone: c.phone, project: c.project, validUntil: c.validUntil.toISOString(), visited: c.visited })),
      istDay(ctx.now.toISOString()),
      claims.length - shown.length,
      ctx.voice,
    ),
  );
  return turn(ctx, "my_buyers", "DONE", usd);
}

async function bookVisit(
  ctx: Ctx,
  intent: B.Intent,
  numbers: string[],
  projects: Project[],
  usd: number | null,
  chosen?: { claimId?: string; towerId?: string },
): Promise<void> {
  const claims = await liveClaims(ctx.m.orgId, ctx.agent.cp_org_id);
  const matched = chosen?.claimId ? claims.filter((c) => c.id === chosen.claimId) : claimsFor(claims, intent.buyer, numbers);
  if (!matched.length) {
    await reply(ctx, B.say(ctx.voice, "not_yours"));
    return turn(ctx, "book_visit", "REFUSED", usd);
  }
  if (matched.length > 1) {
    await setPending(ctx, {
      kind: "CHOOSE",
      action: { for: "book_buyer", options: matched.map((c) => c.id), when: intent.when, tower: intent.tower },
      seconds: B.CHOOSE_MINUTES * 60,
    });
    await reply(ctx, B.chooseText(B.say(ctx.voice, "which_buyer"), matched.map((c) => `${c.buyer} (${c.project})`), ctx.voice));
    return turn(ctx, "book_visit", "ASKED", usd);
  }
  const claim = matched[0];
  const when = parseVisitTime(intent.when ?? "", ctx.now.toISOString());
  if (!when) {
    await reply(ctx, B.say(ctx.voice, "when"));
    return turn(ctx, "book_visit", "ASKED", usd);
  }
  const towers = (await withTenant(ctx.m.orgId, (sql) => towersOf(sql, ctx.m.orgId, projects))).filter((t) => t.projectId === claim.projectId);
  const named = towers.filter((t) => B.names(intent.tower, t.name));
  const tower = chosen?.towerId ? towers.find((t) => t.id === chosen.towerId) : towers.length === 1 ? towers[0] : named.length === 1 ? named[0] : null;
  if (!tower) {
    if (!towers.length) {
      await reply(ctx, B.say(ctx.voice, "no_tower_in_project", { project: claim.project }));
      return turn(ctx, "book_visit", "REFUSED", usd);
    }
    await setPending(ctx, {
      kind: "CHOOSE",
      action: { for: "book_tower", options: towers.map((t) => t.id), claim: claim.id, when: intent.when },
      seconds: B.CHOOSE_MINUTES * 60,
    });
    await reply(ctx, B.chooseText(B.say(ctx.voice, "which_tower"), towers.map((t) => t.name), ctx.voice));
    return turn(ctx, "book_visit", "ASKED", usd);
  }
  // The slot is held while the partner says yes, and no longer.
  await setPending(ctx, {
    kind: "CONFIRM",
    action: { for: "book", claim: claim.id, tower: tower.id, date: when.date, slot: when.slot },
    seconds: B.HOLD_SECONDS,
  });
  await reply(ctx, B.holdLine({ buyer: claim.buyer, phone: claim.phone, tower: tower.name, date: when.date, time: when.slot }, ctx.voice));
  return turn(ctx, "book_visit", "ASKED", usd);
}

async function finishConfirm(ctx: Ctx, pending: Pending, projects: Project[]): Promise<void> {
  await closePending(ctx.m.orgId, pending.id);
  const a = pending.action as { for?: string; claim?: string; tower?: string; date?: string; slot?: string };
  if (a.for !== "book" || !a.claim || !a.tower || !a.date || !a.slot || !ctx.agent.user_id) {
    await reply(ctx, B.say(ctx.voice, "unclear"));
    return turn(ctx, "confirm", "UNCLEAR");
  }
  // Still this firm's, still live, still a tower of a project it is empanelled on.
  const claims = await liveClaims(ctx.m.orgId, ctx.agent.cp_org_id);
  const towers = await withTenant(ctx.m.orgId, (sql) => towersOf(sql, ctx.m.orgId, projects));
  const tower = towers.find((t) => t.id === a.tower);
  if (!claims.some((c) => c.id === a.claim) || !tower) {
    await reply(ctx, B.say(ctx.voice, "not_yours"));
    return turn(ctx, "book_visit", "REFUSED");
  }
  const out = await bookPartnerVisit({
    orgId: ctx.m.orgId,
    userId: ctx.agent.user_id,
    registrationId: a.claim,
    phaseId: a.tower,
    date: a.date,
    time: a.slot,
    nowIso: ctx.now.toISOString(),
  });
  if (!out.ok) {
    await reply(ctx, out.message);
    return turn(ctx, "book_visit", "REFUSED");
  }
  const maps = await withTenant(ctx.m.orgId, async (sql) => {
    const [r] = await sql<{ maps_url: string }[]>`
      SELECT s.maps_url FROM site_locations s JOIN scope_nodes n ON n.id = s.scope_node_id
      WHERE s.org_id = ${ctx.m.orgId} AND n.path @> ${tower.path}::ltree
      ORDER BY nlevel(n.path) DESC LIMIT 1`;
    return r?.maps_url ?? null;
  });
  await reply(ctx, B.bookedLine({ tower: tower.name, date: a.date, time: a.slot, maps }, ctx.voice));
  return turn(ctx, "book_visit", "DONE");
}

async function payoutStatus(ctx: Ctx, usd: number | null): Promise<void> {
  const rows = await withTenant(ctx.m.orgId, (sql) => firmPayouts(sql, ctx.m.orgId, ctx.agent.cp_org_id));
  const shown = rows.slice(0, B.PAYOUTS_LISTED);
  await reply(ctx, B.payoutText(shown, rows.length - shown.length, ctx.voice));
  return turn(ctx, "payout_status", "DONE", usd);
}

/** Up to three configurations, from approved unit types on a tower that may be advertised. */
async function inventory(ctx: Ctx, intent: B.Intent, projects: Project[], usd: number | null, towerId?: string): Promise<void> {
  const towers = await withTenant(ctx.m.orgId, (sql) => towersOf(sql, ctx.m.orgId, projects));
  const named = towers.filter((t) => B.names(intent.tower, t.name));
  const tower = towerId ? towers.find((t) => t.id === towerId) : named.length === 1 ? named[0] : towers.length === 1 ? towers[0] : null;
  if (!tower) {
    if (!towers.length) {
      await reply(ctx, B.say(ctx.voice, "no_tower"));
      return turn(ctx, "inventory", "REFUSED", usd);
    }
    await setPending(ctx, {
      kind: "CHOOSE",
      action: { for: "inventory", options: towers.map((t) => t.id), config: intent.config },
      seconds: B.CHOOSE_MINUTES * 60,
    });
    await reply(ctx, B.chooseText(B.say(ctx.voice, "which_tower"), towers.map((t) => `${t.project} · ${t.name}`), ctx.voice));
    return turn(ctx, "inventory", "ASKED", usd);
  }
  const gate = await canPublish(ctx.m.orgId, tower.id, ctx.now);
  if (!gate.ok) {
    await reply(ctx, B.say(ctx.voice, "not_advertisable", { tower: tower.name }));
    return turn(ctx, "inventory", "REFUSED", usd);
  }
  const { units, basePsf } = await approvedUnits(ctx.m.orgId, tower.id);
  const beds = intent.config ? bedCountsIn(intent.config) : [];
  const fits = units.filter((u) => u.nodeId === tower.id && (!beds.length || beds.includes(configDef(u.config)?.beds ?? -1)));
  const shown = fits.slice(0, 3);
  const newest = shown.reduce<{ version: number; on: string } | null>(
    (best, u) => (!best || u.createdAt > best.on ? { version: u.version, on: u.createdAt.slice(0, 10) } : best),
    null,
  );
  await reply(
    ctx,
    B.inventoryText(
      tower.name,
      shown.map((u) => ({ label: u.label, carpetSqft: u.carpetAreaSqft, price: priceFor(u, basePsf) })),
      newest,
      ctx.voice,
    ),
  );
  return turn(ctx, "inventory", "DONE", usd);
}

/** Co-branded posts, each with the firm's ref code and a link that opens WhatsApp to this developer. */
async function creative(ctx: Ctx, intent: B.Intent, projects: Project[], usd: number | null): Promise<void> {
  const { orgId } = ctx.m;
  const [{ n: sends }] = await withTenant(orgId, (sql) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM partner_bot_turns
    WHERE org_id = ${orgId} AND agent_id = ${ctx.agent.id} AND action = 'creative' AND outcome = 'DONE' AND created_at >= ${dayStart(ctx.now)}`);
  if (sends >= B.CREATIVE_SENDS_PER_DAY) {
    await reply(ctx, B.say(ctx.voice, "creatives_today"));
    return turn(ctx, "creative", "REFUSED", usd);
  }
  if (!ctx.agent.user_id) return turn(ctx, "creative", "REFUSED", usd);
  const posts = await withTenant(orgId, (sql) => sql<{ id: string; tower_id: string; tower: string; tower_path: string; project: string }[]>`
    SELECT r.id, t.id AS tower_id, t.name AS tower, t.path::text AS tower_path, p.name AS project
    FROM rendered_posts r
    JOIN scope_nodes t ON t.id = r.scope_node_id AND t.kind = 'PHASE'
    JOIN scope_nodes p ON p.org_id = t.org_id AND p.kind = 'PROJECT' AND p.path @> t.path
    WHERE r.org_id = ${orgId} AND r.kind IN ('IMAGE', 'CAROUSEL')
      AND (r.review IS NULL OR (r.review ->> 'passed')::boolean)
      AND jsonb_array_length(r.media) > 0
      AND p.id = ANY(${projects.map((x) => x.id)})
      ${intent.occasion ? sql`AND r.headline ILIKE ${`%${intent.occasion.replace(/[%_]/g, "")}%`}` : sql``}
    ORDER BY r.created_at DESC
    LIMIT 30`);
  const towersNamed = intent.tower ? posts.filter((p) => B.names(intent.tower, p.tower)) : posts;
  const pick = (towersNamed.length ? towersNamed : posts).slice(0, B.CREATIVES_PER_SEND);
  if (!pick.length) {
    await reply(ctx, B.say(ctx.voice, "no_creative"));
    return turn(ctx, "creative", "REFUSED", usd);
  }
  await reply(ctx, B.creativeIntro(pick.length, ctx.voice));
  let sent = 0;
  for (const post of pick) {
    const link = await linkFor(ctx, post.tower_id);
    if (!link) continue;
    const made = await partnerPost({ orgId, userId: ctx.agent.user_id, linkId: link.id, postId: post.id, index: 0, nowIso: ctx.now.toISOString() });
    if (!made.ok) continue;
    const number = await withTenant(orgId, (sql) => numberAt(sql, orgId, post.tower_path));
    const url = number ? B.waMeLink(number.phone, B.tapText(post.project, link.code)) : null;
    const caption = url ? B.creativeCaption(link.code, url, ctx.voice) : `Ref ${link.code}`;
    if (await sendFile(ctx, { kind: "image", bytes: made.bytes, mediaType: "image/jpeg", filename: made.name, caption, stored: `[Co-branded creative] ${caption}` })) sent += 1;
  }
  if (!sent) {
    await reply(ctx, B.say(ctx.voice, "no_creative"));
    return turn(ctx, "creative", "REFUSED", usd);
  }
  return turn(ctx, "creative", "DONE", usd);
}

/** This person's live link for a tower, made the first time it is needed. */
async function linkFor(ctx: Ctx, towerId: string): Promise<{ id: string; code: string } | null> {
  // The firm's row on the desk that has it at this tower: it may sit on two (0092).
  const firmId = await deskFirm(ctx.m.orgId, ctx.agent.firm_id, towerId);
  const [l] = await withTenant(ctx.m.orgId, (sql) => sql<{ id: string; code: string }[]>`
    SELECT id, code FROM partner_links
    WHERE org_id = ${ctx.m.orgId} AND firm_id = ${firmId} AND scope_node_id = ${towerId} AND retired_at IS NULL
      AND agent_name = ${ctx.agent.name}
    ORDER BY created_at DESC LIMIT 1`);
  if (l) return l;
  const made = await makeLink({
    orgId: ctx.m.orgId,
    userId: ctx.agent.user_id!,
    firmId,
    phaseId: towerId,
    agentName: ctx.agent.name,
    nowIso: ctx.now.toISOString(),
  });
  return made.ok ? { id: made.id, code: made.code } : null;
}

// ---------------------------------------------------------------------------
// The three things that ask for a fresh code
// ---------------------------------------------------------------------------

type StepUpAction = { action: "invoice:attest" | "number:unmask" | "registrations:export"; target: string | null };

async function stepUp(ctx: Ctx, a: StepUpAction, what: string, usd: number | null): Promise<void> {
  const started = await startChallenge({
    purpose: "STEP_UP",
    phone: ctx.agent.phone,
    userId: ctx.agent.user_id,
    orgId: ctx.m.orgId,
    action: a.action,
    targetId: a.target,
    now: ctx.now,
  });
  if (!started.ok) {
    await reply(ctx, started.message);
    return turn(ctx, a.action.split(":")[1] ?? "step_up", "REFUSED", usd);
  }
  await setPending(ctx, { kind: "STEP_UP", action: a, challengeId: started.challengeId, seconds: 300 });
  await reply(ctx, B.stepUpAsk(what, ctx.voice));
  return turn(ctx, "step_up", "ASKED", usd);
}

async function attest(ctx: Ctx, usd: number | null, invoiceId?: string): Promise<void> {
  const invoices = await withTenant(ctx.m.orgId, (sql) => sql<B.InvoiceChoice[]>`
    SELECT i.id, i.invoice_no AS no, i.amount::float8 AS amount, coalesce(p.unit, 'Unit') AS unit, m.key
    FROM partner_invoices i JOIN payout_milestones m ON m.id = i.milestone_id JOIN partner_payouts p ON p.id = m.payout_id
    WHERE i.org_id = ${ctx.m.orgId} AND i.cp_org_id = ${ctx.agent.cp_org_id}
      AND i.rejected_at IS NULL AND i.attested_at IS NULL AND m.stage = 'INVOICED'
    ORDER BY i.created_at LIMIT 9`);
  const chosen = invoiceId ? invoices.filter((i) => i.id === invoiceId) : invoices;
  if (!chosen.length) {
    await reply(ctx, B.say(ctx.voice, "nothing_to_attest"));
    return turn(ctx, "attest_invoice", "REFUSED", usd);
  }
  if (chosen.length > 1) {
    await setPending(ctx, { kind: "CHOOSE", action: { for: "attest", options: chosen.map((i) => i.id) }, seconds: B.CHOOSE_MINUTES * 60 });
    await reply(ctx, B.chooseText(B.say(ctx.voice, "which_invoice"), chosen.map(B.invoiceLabel), ctx.voice));
    return turn(ctx, "attest_invoice", "ASKED", usd);
  }
  return stepUp(ctx, { action: "invoice:attest", target: chosen[0].id }, B.say(ctx.voice, "what_attest", { label: B.invoiceLabel(chosen[0]) }), usd);
}

async function unmask(ctx: Ctx, intent: B.Intent, numbers: string[], usd: number | null): Promise<void> {
  const claims = claimsFor(await liveClaims(ctx.m.orgId, ctx.agent.cp_org_id), intent.buyer, numbers);
  if (!claims.length) {
    await reply(ctx, B.say(ctx.voice, "not_yours"));
    return turn(ctx, "unmask", "REFUSED", usd);
  }
  if (claims.length > 1) {
    await setPending(ctx, { kind: "CHOOSE", action: { for: "unmask", options: claims.map((c) => c.id) }, seconds: B.CHOOSE_MINUTES * 60 });
    await reply(ctx, B.chooseText(B.say(ctx.voice, "which_buyer"), claims.map((c) => `${c.buyer} (${c.project})`), ctx.voice));
    return turn(ctx, "unmask", "ASKED", usd);
  }
  return stepUp(ctx, { action: "number:unmask", target: claims[0].id }, B.say(ctx.voice, "what_unmask", { buyer: claims[0].buyer }), usd);
}

async function finishStepUp(ctx: Ctx, pending: Pending, code: string, projects: Project[]): Promise<void> {
  const a = pending.action as StepUpAction;
  const v = await verifyChallenge({
    challengeId: pending.challenge_id!,
    phone: ctx.agent.phone,
    code,
    purpose: "STEP_UP",
    userId: ctx.agent.user_id,
    action: a.action,
    targetId: a.target,
    now: ctx.now,
  });
  if (!v.ok) {
    await reply(ctx, B.say(ctx.voice, "code_wrong"));
    return turn(ctx, "step_up", "REFUSED");
  }
  await closePending(ctx.m.orgId, pending.id);
  const { orgId } = ctx.m;

  if (a.action === "invoice:attest" && a.target) {
    const [inv] = await withTenant(orgId, (sql) => sql<B.InvoiceChoice[]>`
      UPDATE partner_invoices i SET attested_at = now(), attested_by = ${ctx.agent.user_id}
      FROM payout_milestones m, partner_payouts p
      WHERE i.org_id = ${orgId} AND i.id = ${a.target} AND i.cp_org_id = ${ctx.agent.cp_org_id}
        AND i.attested_at IS NULL AND i.rejected_at IS NULL
        AND m.id = i.milestone_id AND p.id = m.payout_id
      RETURNING i.id, i.invoice_no AS no, i.amount::float8 AS amount, coalesce(p.unit, 'Unit') AS unit, m.key`);
    if (!inv) {
      await reply(ctx, B.say(ctx.voice, "nothing_to_attest"));
      return turn(ctx, "attest_invoice", "REFUSED");
    }
    await audit({ orgId, actorUserId: ctx.agent.user_id, action: "partner.invoice_attested", targetType: "partner_invoice", targetId: inv.id, metadata: { via: "whatsapp" } });
    await reply(ctx, B.attestedLine(inv, ctx.voice));
    return turn(ctx, "attest_invoice", "DONE");
  }

  if (a.action === "number:unmask" && a.target) {
    const claim = (await liveClaims(orgId, ctx.agent.cp_org_id)).find((c) => c.id === a.target);
    if (!claim) {
      await reply(ctx, B.say(ctx.voice, "not_yours"));
      return turn(ctx, "unmask", "REFUSED");
    }
    await audit({
      orgId,
      actorUserId: ctx.agent.user_id,
      action: "partner.number_unmasked",
      targetType: "client_registration",
      targetId: claim.id,
      metadata: { phone: auditHash(claim.phone), by: "whatsapp" },
    });
    await reply(ctx, `${claim.buyer}: ${spacedPhone(claim.phone)}`, B.say(ctx.voice, "unmasked_stored", { buyer: claim.buyer }));
    return turn(ctx, "unmask", "DONE");
  }

  if (a.action === "registrations:export") {
    const rows = await withTenant(orgId, (sql) => sql<{ buyer: string; phone: string; project: string; verdict: string; valid_until: Date | null; via: string; created_at: Date }[]>`
      SELECT coalesce(l.name, r.buyer_name, '') AS buyer, r.phone, n.name AS project, r.verdict, r.valid_until, r.via, r.created_at
      FROM client_registrations r JOIN scope_nodes n ON n.id = r.scope_node_id LEFT JOIN leads l ON l.id = r.lead_id
      WHERE r.org_id = ${orgId} AND r.cp_org_id = ${ctx.agent.cp_org_id} AND r.verdict IN ('REGISTERED', 'ALREADY', 'BLOCKED', 'DIRECT_FIRST')
        AND n.id = ANY(${projects.map((p) => p.id)})
      ORDER BY r.created_at DESC LIMIT 5000`);
    const csv = B.csvOf(
      ["Buyer", "Number", "Project", "Result", "Valid till", "Registered on"],
      rows.map((r) => [
        r.buyer,
        r.phone,
        r.project,
        r.verdict,
        r.verdict === "REGISTERED" && r.valid_until ? istDay(r.valid_until.toISOString()) : "",
        istDay(r.created_at.toISOString()),
      ]),
    );
    await audit({ orgId, actorUserId: ctx.agent.user_id, action: "partner.registrations_exported", targetType: "partner_agent", targetId: ctx.agent.id, metadata: { rows: rows.length } });
    const ok = await sendFile(ctx, {
      kind: "document",
      bytes: Buffer.from(csv, "utf8"),
      mediaType: "text/csv",
      filename: `registrations-${istDay(ctx.now.toISOString())}.csv`,
      stored: `[Export of ${rows.length} registrations]`,
    });
    if (!ok) await reply(ctx, B.say(ctx.voice, "file_failed"));
    return turn(ctx, "export", ok ? "DONE" : "REFUSED");
  }
  await reply(ctx, B.say(ctx.voice, "unclear"));
  return turn(ctx, "step_up", "UNCLEAR");
}

async function finishChoose(ctx: Ctx, pending: Pending, option: string, projects: Project[]): Promise<void> {
  await closePending(ctx.m.orgId, pending.id);
  const a = pending.action as { for?: string; phone?: string; name?: string | null; when?: string | null; tower?: string | null; claim?: string; config?: string | null };
  const intent = (action: B.Action, rest: Partial<B.Intent>): B.Intent => ({ action, ...B.EMPTY, ...rest });
  switch (a.for) {
    case "register":
      return register(ctx, intent("register", { buyer: "#1", name: a.name ?? null }), a.phone ? [a.phone] : [], projects, null, option);
    case "book_buyer":
      return bookVisit(ctx, intent("book_visit", { when: a.when ?? null, tower: a.tower ?? null }), [], projects, null, { claimId: option });
    case "book_tower":
      return bookVisit(ctx, intent("book_visit", { when: a.when ?? null }), [], projects, null, { claimId: a.claim, towerId: option });
    case "inventory":
      return inventory(ctx, intent("inventory", { config: a.config ?? null }), projects, null, option);
    case "attest":
      return attest(ctx, null, option);
    case "language":
      if ((B.PARTNER_LANGUAGES as readonly string[]).includes(option)) return setLanguage(ctx, option as B.PartnerLanguage);
      break;
    case "unmask": {
      const claim = (await liveClaims(ctx.m.orgId, ctx.agent.cp_org_id)).find((c) => c.id === option);
      if (!claim) {
        await reply(ctx, B.say(ctx.voice, "not_yours"));
        return turn(ctx, "unmask", "REFUSED");
      }
      return stepUp(ctx, { action: "number:unmask", target: claim.id }, B.say(ctx.voice, "what_unmask", { buyer: claim.buyer }), null);
    }
  }
  await reply(ctx, B.say(ctx.voice, "unclear"));
  return turn(ctx, "choose", "UNCLEAR");
}

// ---------------------------------------------------------------------------
// A buyer who tapped a partner's link
// ---------------------------------------------------------------------------

/**
 * The buyer's first message carries the ref code the link wrote in. It
 * becomes a lead event of its own, and the capture makes the lead and the
 * partner's claim in one transaction, through the ordinary verdict. A
 * retired link still makes the lead; it claims nobody.
 */
async function handleTap(m: Inbound, code: string): Promise<boolean> {
  const [link] = await withTenant(m.orgId, (sql) => sql<{ scope_node_id: string }[]>`
    SELECT scope_node_id FROM partner_links WHERE org_id = ${m.orgId} AND code = ${code}`);
  if (!link) return false;
  const ev = await recordEvent({
    orgId: m.orgId,
    source: "WHATSAPP",
    externalId: m.providerId,
    payload: { from: m.from, name: m.profileName, messageId: m.providerId, at: m.at, phaseId: link.scope_node_id, partnerRef: code },
  });
  if (!ev.fresh) return true;
  const out = await processEvent(m.orgId, ev.id);
  if (out.ok) {
    await withTenant(m.orgId, (sql) => sql`
      UPDATE messages SET lead_id = ${out.leadId} WHERE org_id = ${m.orgId} AND id = ${m.messageId} AND lead_id IS NULL`);
  }
  return true;
}
