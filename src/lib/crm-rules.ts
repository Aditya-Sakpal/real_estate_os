import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalisePhone } from "./calling-rules.ts";
import { BUDGETS, CONFIGS, isPath, type Facts, type StageKey } from "./lead-rules.ts";

/**
 * The CRM beside us, as rules: what a connection needs, what their words
 * mean here, who wins when both sides changed the same thing, and how to
 * read LeadRat's answers.
 *
 * Pure, so `check:logic` covers it. `crm.ts` is the seam and the adapters,
 * `crm-sync.ts` reads and writes.
 *
 * Four rules.
 *
 * 1. **Who owns a field decides a conflict** (28 September 2026). The CRM
 *    owns what people type there: the stage, the owner, the name, the email
 *    and the booking. We own what we observed: the configuration and budget
 *    a call found out, and the visit the agent booked. A field changed on
 *    only one side since the two last agreed goes the other way, whoever
 *    owns it; ownership only settles the case where both changed it.
 * 2. **An empty value is not an instruction.** A field one side left blank
 *    never erases the other side's value, the rule the Brain's inheritance
 *    follows. The phone number is never synced at all after the first
 *    match: it is what both sides dedupe on.
 * 3. **Nothing unmapped is guessed.** A status, a project or a user of theirs
 *    that nobody mapped makes the event wait, and a write that needs one
 *    waits too. A sub-status nobody mapped uses its parent's mapping, which
 *    the screen shows as such; a status with neither waits.
 * 4. **Every write is bounded.** Five attempts with backoff, then DEAD for a
 *    person to see. A refusal another attempt cannot fix is DEAD at once.
 */

// ---------------------------------------------------------------------------
// The CRMs
// ---------------------------------------------------------------------------

export type CrmProvider = "LEADSQUARED" | "SELLDO" | "LEADRAT";

export type CrmCatalogEntry = {
  key: CrmProvider;
  label: string;
  /** False when only a one-way lead push is possible without the vendor's API contract. */
  twoWay: boolean;
};

export const CRM_PROVIDERS: CrmCatalogEntry[] = [
  { key: "LEADSQUARED", label: "LeadSquared", twoWay: true },
  { key: "SELLDO", label: "Sell.Do", twoWay: false },
  { key: "LEADRAT", label: "LeadRat", twoWay: true },
];

export const isCrmProvider = (raw: unknown): raw is CrmProvider =>
  raw === "LEADSQUARED" || raw === "SELLDO" || raw === "LEADRAT";
export const crmLabel = (p: CrmProvider) => CRM_PROVIDERS.find((c) => c.key === p)!.label;
export const crmSlug = (p: CrmProvider) => p.toLowerCase();
export function crmFromSlug(slug: string | null | undefined): CrmProvider | null {
  const up = (slug ?? "").toUpperCase();
  return isCrmProvider(up) ? up : null;
}

// ---------------------------------------------------------------------------
// The credential, as typed on the connect form
// ---------------------------------------------------------------------------

export type LeadratCredential = { apiKey: string; secretKey: string };
export type SelldoCredential = { apiKey: string };

export type LeadsquaredCredential = { accessKey: string; secretKey: string };

export type ReadCredential =
  | { ok: true; account: string | null; secret: string; settings?: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

/**
 * LeadSquared serves each client from one data centre's host. Only its own
 * hosts are ever called with a client's keys, so a host read back from its
 * answer is checked against this before it is stored.
 */
export function leadsquaredHost(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^api(-[a-z]{2}\d{1,3})?\.leadsquared\.com$/.test(s) ? s : null;
}

/**
 * LeadRat names a client by the subdomain they sign in at (`acme` in
 * acme.leadrat.com), sent as the `tenant` header. People paste the whole
 * address as often as the name, so both are read.
 */
export function leadratTenant(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const name = s.endsWith(".leadrat.com") ? s.slice(0, -".leadrat.com".length) : s;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? name : null;
}

/** An API key or secret: LeadSquared's access keys start "u$". Nothing with a space or a quote. */
const KEY_SHAPE = /^[A-Za-z0-9._~+/=$-]{8,512}$/;

export function readCredential(provider: CrmProvider, fields: Record<string, string>): ReadCredential {
  const errors: Record<string, string> = {};
  if (provider === "LEADSQUARED") {
    const accessKey = (fields.accessKey ?? "").trim();
    const secretKey = (fields.secretKey ?? "").trim();
    if (!KEY_SHAPE.test(accessKey)) errors.accessKey = "Paste the access key from LeadSquared.";
    if (!KEY_SHAPE.test(secretKey)) errors.secretKey = "Paste the secret key from LeadSquared.";
    if (Object.keys(errors).length) return { ok: false, errors };
    // The host is read from LeadSquared itself when the keys are proved.
    return { ok: true, account: null, secret: JSON.stringify({ accessKey, secretKey } satisfies LeadsquaredCredential) };
  }
  if (provider === "LEADRAT") {
    const tenant = leadratTenant(fields.tenant ?? "");
    const apiKey = (fields.apiKey ?? "").trim();
    const secretKey = (fields.secretKey ?? "").trim();
    if (!tenant) errors.tenant = "Enter the name you sign in at, like acme in acme.leadrat.com.";
    if (!KEY_SHAPE.test(apiKey)) errors.apiKey = "Paste the API key from LeadRat.";
    if (!KEY_SHAPE.test(secretKey)) errors.secretKey = "Paste the secret key from LeadRat.";
    if (Object.keys(errors).length) return { ok: false, errors };
    return { ok: true, account: tenant, secret: JSON.stringify({ apiKey, secretKey } satisfies LeadratCredential) };
  }
  const apiKey = (fields.apiKey ?? "").trim();
  if (!/^[A-Za-z0-9]{16,64}$/.test(apiKey)) return { ok: false, errors: { apiKey: "Paste the API key from Sell.Do's API integration." } };
  return { ok: true, account: null, secret: JSON.stringify({ apiKey } satisfies SelldoCredential) };
}

// ---------------------------------------------------------------------------
// The webhook address proves itself
// ---------------------------------------------------------------------------

/**
 * Neither CRM documents how it signs a delivery, so the address carries its
 * own proof, the way a Sarvam call's does: an HMAC of the org and the
 * connection under a key only this server holds. It is also what we give
 * LeadRat as the subscription's `secretKey`.
 */
export function crmHookToken(secret: string, orgId: string, connectionId: string): string {
  return createHmac("sha256", secret).update(`crm-hook:${orgId}:${connectionId}`).digest("hex");
}

export function crmHookTokenValid(secret: string, orgId: string, connectionId: string, token: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(token)) return false;
  const want = Buffer.from(crmHookToken(secret, orgId, connectionId), "hex");
  const got = Buffer.from(token.toLowerCase(), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---------------------------------------------------------------------------
// Their words for things
// ---------------------------------------------------------------------------

export type MapKind = "STAGE" | "PROJECT" | "TOWER" | "USER";

/** One of their statuses, projects, blocks or users, as the catalog lists it. */
export type CatalogItem = {
  kind: MapKind;
  externalId: string;
  label: string;
  parentId: string | null;
  parentLabel: string | null;
  rank: number;
};

export type Mapping = CatalogItem & {
  stage: StageKey | null;
  nodeId: string | null;
  userId: string | null;
  ignored: boolean;
  pushAs: boolean;
};

export const isMapped = (m: Pick<Mapping, "stage" | "nodeId" | "userId" | "ignored">) =>
  m.ignored || m.stage !== null || m.nodeId !== null || m.userId !== null;

export type Resolved<T> =
  | { ok: true; value: T }
  | { ok: false; waiting: "STAGE" | "PROJECT" | "USER"; externalId: string }
  | { ok: false; ignored: true; externalId: string };

/**
 * One of their statuses as one of our stages. A sub-status nobody mapped
 * uses its parent's mapping; with neither mapped, the event waits.
 */
export function stageFor(maps: readonly Mapping[], statusId: string, parentId: string | null): Resolved<StageKey> {
  const own = maps.find((m) => m.kind === "STAGE" && m.externalId === statusId);
  if (own?.stage) return { ok: true, value: own.stage };
  const parent = parentId ?? own?.parentId ?? null;
  const up = parent ? maps.find((m) => m.kind === "STAGE" && m.externalId === parent) : undefined;
  if (up?.stage) return { ok: true, value: up.stage };
  return { ok: false, waiting: "STAGE", externalId: statusId };
}

/** The status of theirs we set when a lead moves to `stage` here. */
export function pushStageFor(maps: readonly Mapping[], stage: StageKey): string | null {
  return maps.find((m) => m.kind === "STAGE" && m.pushAs && m.stage === stage)?.externalId ?? null;
}

/**
 * The tower one of their leads is about. A lead may name several projects;
 * the first one mapped to a tower decides. A lead naming only projects a
 * person marked as not ours is ignored; one naming a project nobody mapped
 * waits, because the next person to map it may say it is ours.
 */
export function towerFor(maps: readonly Mapping[], projectIds: readonly string[]): Resolved<string> | { ok: false; none: true } {
  if (!projectIds.length) return { ok: false, none: true };
  for (const id of projectIds) {
    const m = maps.find((x) => x.kind === "PROJECT" && x.externalId === id);
    if (m?.nodeId) return { ok: true, value: m.nodeId };
  }
  const waiting = projectIds.find((id) => {
    const m = maps.find((x) => x.kind === "PROJECT" && x.externalId === id);
    return !m || !isMapped(m);
  });
  if (waiting) return { ok: false, waiting: "PROJECT", externalId: waiting };
  return { ok: false, ignored: true, externalId: projectIds[0] };
}

/** Their project for our tower, when a person mapped one. */
export function projectForTower(maps: readonly Mapping[], nodeId: string): Mapping | null {
  return maps.find((m) => m.kind === "PROJECT" && m.nodeId === nodeId) ?? null;
}

export function userFor(maps: readonly Mapping[], externalId: string | null): Resolved<string | null> {
  if (!externalId) return { ok: true, value: null };
  const m = maps.find((x) => x.kind === "USER" && x.externalId === externalId);
  if (m?.userId) return { ok: true, value: m.userId };
  if (m?.ignored) return { ok: true, value: null };
  return { ok: false, waiting: "USER", externalId };
}

export function externalUserFor(maps: readonly Mapping[], userId: string | null): string | null {
  if (!userId) return null;
  return maps.find((m) => m.kind === "USER" && m.userId === userId)?.externalId ?? null;
}

/** What is still waiting on a person, by kind. A sub-status whose parent is mapped is not. */
export function waitingCounts(maps: readonly Mapping[]): Record<MapKind, number> {
  const out: Record<MapKind, number> = { STAGE: 0, PROJECT: 0, TOWER: 0, USER: 0 };
  for (const m of maps) {
    if (isMapped(m)) continue;
    if (m.kind === "STAGE" && m.parentId) {
      const parent = maps.find((p) => p.kind === "STAGE" && p.externalId === m.parentId);
      if (parent && isMapped(parent)) continue;
    }
    out[m.kind]++;
  }
  return out;
}

/** Our stages with no status of theirs to set. A write moving a lead there waits. */
export function stagesWithoutPush(maps: readonly Mapping[], stages: readonly StageKey[]): StageKey[] {
  return stages.filter((s) => !pushStageFor(maps, s));
}

// ---------------------------------------------------------------------------
// What is synced, in our words
// ---------------------------------------------------------------------------

/**
 * One lead as both sides can describe it. Every value a string or null, so
 * the base stored on `crm_links` compares by equality.
 */
export type SyncValues = {
  name: string | null;
  email: string | null;
  stage: StageKey | null;
  /** For a side lane: why. Their status label when it came from them. */
  exitReason: string | null;
  /** Our user id. */
  ownerId: string | null;
  config: string | null;
  budget: string | null;
  /** The booked visit, "YYYY-MM-DDTHH:MM" in IST. */
  visitAt: string | null;
  bookedOn: string | null;
  agreement: string | null;
};

export type SyncField = keyof SyncValues;

export const SYNC_FIELDS: SyncField[] = [
  "name", "email", "stage", "exitReason", "ownerId", "config", "budget", "visitAt", "bookedOn", "agreement",
];

export const OWNER: Record<SyncField, "CRM" | "US"> = {
  name: "CRM",
  email: "CRM",
  stage: "CRM",
  exitReason: "CRM",
  ownerId: "CRM",
  config: "US",
  budget: "US",
  visitAt: "US",
  bookedOn: "CRM",
  agreement: "CRM",
};

export const emptyValues = (): SyncValues => ({
  name: null, email: null, stage: null, exitReason: null, ownerId: null,
  config: null, budget: null, visitAt: null, bookedOn: null, agreement: null,
});

const norm = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  return s ? s : null;
};
const same = (a: string | null | undefined, b: string | null | undefined) =>
  (norm(a) ?? "").toLowerCase() === (norm(b) ?? "").toLowerCase();

export type Merged = {
  /** Write these to our lead. */
  toLocal: Partial<SyncValues>;
  /** Write these to their record. */
  toRemote: Partial<SyncValues>;
  /** What both sides hold once both writes land: the next base. */
  agreed: SyncValues;
  /** Fields both sides changed, settled by `OWNER`. */
  conflicts: SyncField[];
};

/**
 * The three-way merge. `remote` values the CRM could not tell us (an
 * unmapped status, a field its API does not carry) are `undefined` and
 * leave that field alone in both directions.
 */
export function mergeLead(
  base: Partial<SyncValues>,
  local: SyncValues,
  remote: Partial<SyncValues>,
  /** Who owns a field for this lead, where it differs from `OWNER`: a visit a person typed in the CRM is the CRM's. */
  owners: Partial<Record<SyncField, "CRM" | "US">> = {},
): Merged {
  const toLocal: Partial<SyncValues> = {};
  const toRemote: Partial<SyncValues> = {};
  const agreed = { ...emptyValues(), ...base } as SyncValues;
  const conflicts: SyncField[] = [];
  const set = (target: Partial<SyncValues>, f: SyncField, v: string | null) => {
    (target as Record<SyncField, string | null>)[f] = v;
    (agreed as Record<SyncField, string | null>)[f] = v;
  };

  for (const f of SYNC_FIELDS) {
    const l = norm(local[f]);
    if (!(f in remote) || remote[f] === undefined) {
      // Their side is silent on this field: only ours is known.
      if (!same(l, base[f]) && l !== null) set(toRemote, f, l);
      continue;
    }
    const r = norm(remote[f]);
    if (same(l, r)) {
      (agreed as Record<SyncField, string | null>)[f] = l ?? r;
      continue;
    }
    // An empty value is a field nobody filled in, never an instruction to forget.
    if (l === null) { set(toLocal, f, r); continue; }
    if (r === null) { set(toRemote, f, l); continue; }
    const b = norm(base[f]);
    const localChanged = !same(l, b);
    const remoteChanged = !same(r, b);
    if (localChanged && !remoteChanged) set(toRemote, f, l);
    else if (remoteChanged && !localChanged) set(toLocal, f, r);
    else {
      conflicts.push(f);
      if ((owners[f] ?? OWNER[f]) === "CRM") set(toLocal, f, r);
      else set(toRemote, f, l);
    }
  }
  // A side lane's reason travels with the stage it belongs to, never alone.
  const stage = (toLocal.stage ?? agreed.stage) as StageKey | null;
  if (stage && isPath(stage)) {
    if ("exitReason" in toLocal) toLocal.exitReason = null;
    agreed.exitReason = null;
  }
  return { toLocal, toRemote, agreed, conflicts };
}

export const nothingToDo = (m: Merged) => !Object.keys(m.toLocal).length && !Object.keys(m.toRemote).length;

/** The values a lead of ours holds, in sync terms. */
export function localValues(lead: {
  name: string;
  email: string | null;
  stage: StageKey;
  exit_reason: string | null;
  owner_id: string | null;
  facts: Facts;
}): SyncValues {
  const f = lead.facts ?? {};
  return {
    name: norm(lead.name),
    email: norm(lead.email),
    stage: lead.stage,
    exitReason: isPath(lead.stage) ? null : norm(lead.exit_reason),
    ownerId: lead.owner_id,
    config: norm(f.config),
    budget: norm(f.budget),
    visitAt: f.visitDate && f.visitTime ? `${f.visitDate}T${f.visitTime}` : null,
    bookedOn: norm(f.bookedOn),
    agreement: norm(f.agreement),
  };
}

// ---------------------------------------------------------------------------
// Configuration and budget, between their numbers and our words
// ---------------------------------------------------------------------------

/** "2 BHK" from [2], "2.5 BHK" from [2.5]. A list naming several is not one answer. */
export function configFromBhks(bhks: readonly number[] | null | undefined): string | null {
  const list = (bhks ?? []).filter((n) => Number.isFinite(n) && n > 0);
  if (list.length !== 1) return null;
  const label = `${list[0]} BHK`;
  return (CONFIGS as readonly string[]).includes(label) ? label : null;
}

export function bhksFromConfig(config: string | null): number[] {
  const m = /^(\d+(?:\.5)?) BHK$/.exec(config ?? "");
  return m ? [Number(m[1])] : [];
}

const LAKH = 1_00_000;
const CRORE = 1_00_00_000;
/** Our bands as rupee ranges, the upper end open for the last. */
export const BUDGET_RANGES: Record<(typeof BUDGETS)[number], [number, number | null]> = {
  "Under Rs 60 lakh": [0, 60 * LAKH],
  "Rs 60 to 90 lakh": [60 * LAKH, 90 * LAKH],
  "Rs 90 lakh to 1.5 Cr": [90 * LAKH, 1.5 * CRORE],
  "Above Rs 1.5 Cr": [1.5 * CRORE, null],
};

/**
 * Their range as one of our bands: the band holding the middle of it, or
 * the upper figure when that is all there is. Nothing when neither is set.
 */
export function budgetFromRange(lower: number | null | undefined, upper: number | null | undefined): string | null {
  const lo = lower && lower > 0 ? lower : null;
  const hi = upper && upper > 0 ? upper : null;
  const point = lo && hi ? (lo + hi) / 2 : hi ?? lo;
  if (!point) return null;
  for (const [band, [from, to]] of Object.entries(BUDGET_RANGES)) {
    if (point >= from && (to === null || point < to)) return band;
  }
  return null;
}

export function rangeFromBudget(budget: string | null): { lower: number; upper: number | null } | null {
  const r = budget ? BUDGET_RANGES[budget as keyof typeof BUDGET_RANGES] : undefined;
  return r ? { lower: r[0], upper: r[1] } : null;
}

// ---------------------------------------------------------------------------
// Time: their instants, our IST wall clock
// ---------------------------------------------------------------------------

const IST_MS = 5.5 * 60 * 60 * 1000;

/** An instant as "YYYY-MM-DDTHH:MM" in IST, snapped down to the minute. */
export function istMinute(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + IST_MS).toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:MM" in IST back to an instant, as ISO in UTC. */
export function istToIso(local: string | null): string | null {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)$/.exec(local ?? "");
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:00Z`) - IST_MS;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export const dateOnly = (iso: string | null | undefined): string | null => {
  const m = istMinute(iso);
  return m ? m.slice(0, 10) : null;
};

// ---------------------------------------------------------------------------
// One of their leads, whatever CRM it came from
// ---------------------------------------------------------------------------

export type RemoteLead = {
  externalId: string;
  /** E.164, or null when their record holds nothing dialable. */
  phone: string | null;
  name: string | null;
  email: string | null;
  statusId: string | null;
  statusParentId: string | null;
  statusLabel: string | null;
  projectIds: string[];
  assignTo: string | null;
  scheduledAt: string | null;
  bookedOn: string | null;
  agreement: string | null;
  config: string | null;
  budget: string | null;
  source: string | null;
  archived: boolean;
  updatedAt: string | null;
  /**
   * The flat their record names once it is booked. No reader fills it yet:
   * neither LeadRat's nor LeadSquared's lead, as read here, carries one.
   * An adapter that reads a real field sets it, and `bookedFlat()` does the rest.
   */
  unitNo?: string | null;
};

/**
 * The flat to mark BOOKED when their lead reaches Booked here, in the
 * tower's own writing ("C-803"); null when the lead is not booked or names
 * no flat that reads as one.
 */
export function bookedFlat(stageAfter: string | null | undefined, unitNo: string | null | undefined): string | null {
  if (stageAfter !== "booked") return null;
  const s = (unitNo ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return /^[A-Z0-9][A-Z0-9 /-]{0,39}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Flats a CRM publishes
// ---------------------------------------------------------------------------

/**
 * One flat as a CRM's API gives it. No adapter reads one yet: none of the
 * three CRMs publishes units through its public API. An adapter that gains
 * `listUnits()` returns these, and the sync writes them as the CRM's.
 */
export type RemoteUnit = {
  externalId: string;
  /** Their block's id (a TOWER mapping), when they have blocks. */
  towerId: string | null;
  /** Their project's id (a PROJECT mapping, which names one of our towers). */
  projectId: string | null;
  wing: string | null;
  unitNo: string;
  floor: number | null;
  /** The catalog key ("2BHK"), as `readConfig()` reads their words. */
  config: string | null;
  carpetSqft: number | null;
  facing: string | null;
  status: "AVAILABLE" | "BLOCKED" | "BOOKED";
};

/** Which of our towers a flat of theirs is in: their block's mapping first, then their project's. */
export function unitTower(maps: readonly Mapping[], u: Pick<RemoteUnit, "towerId" | "projectId">): string | null {
  const block = u.towerId ? maps.find((m) => m.kind === "TOWER" && m.externalId === u.towerId) : undefined;
  if (block?.nodeId) return block.nodeId;
  const project = u.projectId ? maps.find((m) => m.kind === "PROJECT" && m.externalId === u.projectId) : undefined;
  return project?.nodeId ?? null;
}

/** Their flats by our tower. A flat on no mapped tower is counted and left alone, never guessed. */
export function groupUnits(maps: readonly Mapping[], units: readonly RemoteUnit[]): { byTower: Map<string, RemoteUnit[]>; unplaced: number } {
  const byTower = new Map<string, RemoteUnit[]>();
  let unplaced = 0;
  for (const u of units) {
    const t = unitTower(maps, u);
    if (!t) {
      unplaced++;
      continue;
    }
    byTower.set(t, [...(byTower.get(t) ?? []), u]);
  }
  return { byTower, unplaced };
}

/**
 * Their lead in our words, after the mappings. A value the mappings cannot
 * settle leaves the field undefined; the caller decides whether that waits.
 */
export function remoteValues(
  r: RemoteLead,
  maps: readonly Mapping[],
  carried: readonly SyncField[] = SYNC_FIELDS,
): { values: Partial<SyncValues>; stage: Resolved<StageKey> | null; owner: Resolved<string | null> } {
  const stage = r.statusId ? stageFor(maps, r.statusId, r.statusParentId) : null;
  const owner = userFor(maps, r.assignTo);
  const all: Partial<SyncValues> = {
    name: norm(r.name),
    email: norm(r.email),
    config: r.config,
    budget: r.budget,
    bookedOn: r.bookedOn,
    agreement: r.agreement,
  };
  if (stage?.ok) {
    all.stage = stage.value;
    all.exitReason = isPath(stage.value) ? null : norm(r.statusLabel)?.slice(0, 120) ?? "Other";
    // Their scheduled date means a visit only while they call it one.
    all.visitAt = stage.value === "visit_scheduled" ? istMinute(r.scheduledAt) : undefined;
  }
  if (owner.ok) all.ownerId = owner.value;
  // A field their API does not carry is silent, never empty: an empty value
  // would read as "they cleared it" and be pushed back on every pass.
  const values: Partial<SyncValues> = {};
  for (const f of carried) if (all[f] !== undefined) (values as Record<SyncField, string | null>)[f] = all[f] as string | null;
  return { values, stage, owner };
}

/** What a poll compares, so an unchanged record is recognised without a second read. */
export function remoteHash(r: RemoteLead): string {
  const shape = [r.externalId, r.phone, r.name, r.email, r.statusId, r.assignTo, r.scheduledAt, r.config, r.budget, r.archived];
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

export const MAX_OUTBOX_ATTEMPTS = 5;
/** After the first, second, ... failure. The fifth is the last. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
/** How long a claimed row is ours before another worker may take it. */
export const OUTBOX_LEASE_MS = 2 * 60_000;
/** Rows one pass sends per connection. Neither CRM publishes its limit. */
export const OUTBOX_BATCH = 40;

export type CrmError = { code: CrmErrorCode; message: string; retryable: boolean };
export type CrmErrorCode =
  | "UNREACHABLE"
  | "AUTH"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "INVALID"
  | "SERVER"
  | "UNSUPPORTED"
  | "UNKNOWN";

/** Where a failed row goes next. */
export function afterFailure(e: CrmError, attempts: number, now: Date): { status: "PENDING" | "DEAD"; notBefore: Date } {
  if (!e.retryable || attempts >= MAX_OUTBOX_ATTEMPTS) return { status: "DEAD", notBefore: now };
  const wait = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0];
  return { status: "PENDING", notBefore: new Date(now.getTime() + wait) };
}

/** A refusal read the same way whoever sent it. */
export function errorFromStatus(status: number, message: string): CrmError {
  const m = message.slice(0, 300) || `The CRM answered ${status}.`;
  if (status === 401 || status === 403) return { code: "AUTH", message: m, retryable: false };
  if (status === 404) return { code: "NOT_FOUND", message: m, retryable: false };
  if (status === 429) return { code: "RATE_LIMITED", message: m, retryable: true };
  if (status === 400 || status === 409 || status === 422) return { code: "INVALID", message: m, retryable: false };
  if (status >= 500) return { code: "SERVER", message: m, retryable: true };
  return { code: "UNKNOWN", message: m, retryable: true };
}

// ---------------------------------------------------------------------------
// Readiness: crm.read and crm.write, per tower
// ---------------------------------------------------------------------------

export type CrmCapability = { state: "ready" | "todo" | "off"; reason: string };

/**
 * Two capabilities, never gates: a tower sells perfectly well with no CRM
 * connected. Reading needs a live connection and the tower mapped to one of
 * their projects. Writing needs that and every one of our stages given a
 * status of theirs to set, or some move would have nowhere to go.
 */
export function crmCapabilities(f: {
  connected: boolean;
  broken: boolean;
  towerMapped: boolean;
  stagesWithoutPush: number;
}): { read: CrmCapability; write: CrmCapability } {
  if (!f.connected) {
    const off = { state: "off" as const, reason: f.broken ? "The CRM connection stopped working." : "No CRM connected." };
    return { read: off, write: off };
  }
  const read: CrmCapability = f.towerMapped
    ? { state: "ready", reason: "Leads come in from the CRM." }
    : { state: "todo", reason: "Match this tower to a project in the CRM." };
  const write: CrmCapability = !f.towerMapped
    ? read
    : f.stagesWithoutPush
      ? { state: "todo", reason: `Choose a CRM status for ${f.stagesWithoutPush} stage${f.stagesWithoutPush === 1 ? "" : "s"}.` }
      : { state: "ready", reason: "Leads and moves go to the CRM." };
  return { read, write };
}

// ---------------------------------------------------------------------------
// A call, as one line on their record
// ---------------------------------------------------------------------------

const CONNECTIVITY: Record<string, string> = {
  connected: "answered",
  no_answer: "not answered",
  busy: "busy",
  failed: "did not connect",
};

/**
 * What a call found, in one line a sales person reads in their CRM. Never
 * the transcript: it names people and it belongs here, behind our access
 * rules, rather than in a second system with its own.
 */
export function callNote(c: {
  placedAt: string;
  connectivity: string | null;
  durationS: number | null;
  outcome: string | null;
  facts: Facts;
}): string {
  const when = istMinute(c.placedAt)?.replace("T", " ") ?? "";
  const how = c.connectivity ? CONNECTIVITY[c.connectivity] ?? c.connectivity : "no result";
  const mins = c.durationS && c.durationS >= 30 ? `, ${Math.round(c.durationS / 60)} min` : "";
  const heard = [c.facts.config, c.facts.budget, c.facts.timeline ? `buying ${c.facts.timeline.toLowerCase()}` : null]
    .filter(Boolean)
    .join("; ");
  const outcome = c.outcome ? ` ${c.outcome.replace(/_/g, " ").toLowerCase()}.` : "";
  return `Sales Desk AI call ${when} IST: ${how}${mins}.${outcome}${heard && c.connectivity === "connected" ? ` ${heard}.` : ""}`
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// LeadRat: reading its answers
// ---------------------------------------------------------------------------
//
// Written against the Enterprise API 1.1.2, https://apidoc.leadrat.info/
// (OpenAPI 1.1.2, server https://connect.leadrat.com). Every answer is
// `{ succeeded, message, errors, data }`; a paged one adds `items`,
// `itemsCount` and `totalCount` beside them.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** A refusal LeadRat reported inside a 200, or the words of a real one. */
export function leadratFailure(status: number, body: unknown): CrmError | null {
  const b = obj(body);
  const words = [str(b.message), ...(Array.isArray(b.errors) ? b.errors.map(str) : [])].filter(Boolean).join(" ");
  if (status >= 200 && status < 300) {
    return b.succeeded === false ? { code: "INVALID", message: (words || "LeadRat refused it.").slice(0, 300), retryable: false } : null;
  }
  return errorFromStatus(status, words);
}

/** The items of a paged answer. */
export function leadratItems(body: unknown): unknown[] {
  const b = obj(body);
  if (Array.isArray(b.items)) return b.items;
  const d = obj(b.data);
  return Array.isArray(d.items) ? d.items : Array.isArray(b.data) ? (b.data as unknown[]) : [];
}

/** Their phone, E.164. LeadRat keeps the country code apart from the number. */
export function leadratPhone(contactNo: unknown, countryCode: unknown): string | null {
  const n = str(contactNo);
  if (!n) return null;
  if (n.startsWith("+")) return normalisePhone(n);
  const cc = (str(countryCode) ?? "").replace(/\D/g, "");
  return normalisePhone(cc && cc !== "91" ? `+${cc}${n.replace(/\D/g, "")}` : n);
}

/**
 * A lead's status is its base status with the sub-status chosen under it as
 * `childType`. The most specific one is the one mapped; its parent is the
 * fallback.
 */
function leadratStatus(v: unknown): { id: string | null; parentId: string | null; label: string | null } {
  const s = obj(v);
  const child = obj(s.childType);
  const childId = str(child.id);
  if (childId) return { id: childId, parentId: str(s.id), label: str(child.displayName) ?? str(child.status) };
  return { id: str(s.id), parentId: str(s.baseId), label: str(s.displayName) ?? str(s.status) ?? str(s.name) };
}

/**
 * LeadRat's `meetingOrSiteVisit` on a status update: 2 is a site visit, 1 a
 * meeting, 0 neither. A record that does not carry it is read as a visit,
 * the way 0041 always read it; one that says meeting is not.
 */
export function leadratIsSiteVisit(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n)) return n === 2;
  return /site\s*visit/i.test(String(v));
}

/** One lead, from `GET /api/v1/lead/{id}` or an item of `GET /api/v1/lead`. */
export function readLeadratLead(v: unknown): RemoteLead | null {
  const l = obj(v);
  const id = str(l.id);
  if (!id) return null;
  const status = leadratStatus(l.status);
  const enquiry = obj(Array.isArray(l.enquiry) ? l.enquiry[0] : l.enquiry);
  const projects = Array.isArray(l.projects) ? l.projects.map((p) => str(obj(p).id)).filter((x): x is string => !!x) : [];
  const booked = str(l.bookedDate);
  const price = num(l.agreementValue) ?? num(l.soldPrice);
  return {
    externalId: id,
    phone: leadratPhone(l.contactNo, l.countryCode),
    name: str(l.name),
    email: str(l.email)?.toLowerCase() ?? null,
    statusId: status.id,
    statusParentId: status.parentId,
    statusLabel: status.label,
    projectIds: projects,
    assignTo: str(l.assignTo) ?? str(obj(l.assignedUser).id),
    // A scheduled date is a site visit unless the record says it is a meeting.
    scheduledAt: leadratIsSiteVisit(l.meetingOrSiteVisit) ? str(l.scheduledDate) : null,
    bookedOn: booked ? dateOnly(booked) : null,
    agreement: price && price > 0 ? String(Math.round(price)) : null,
    config: configFromBhks(Array.isArray(enquiry.bhKs) ? (enquiry.bhKs as unknown[]).map(num).filter((n): n is number => n !== null) : null),
    budget: budgetFromRange(num(enquiry.lowerBudget), num(enquiry.upperBudget)),
    source: str(enquiry.leadSource) ?? str(enquiry.subSource),
    archived: l.isArchived === true,
    updatedAt: str(l.lastModifiedOn),
  };
}

/** `GET /api/v1/lead/status`: base statuses, each with its `childTypes`. */
export function readLeadratStatuses(body: unknown): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const b of leadratItems(body)) {
    const base = obj(b);
    const id = str(base.id);
    if (!id) continue;
    const label = str(base.displayName) ?? str(base.status) ?? "Status";
    const rank = (num(base.orderRank) ?? 0) * 100;
    out.push({ kind: "STAGE", externalId: id, label, parentId: null, parentLabel: null, rank });
    for (const c of Array.isArray(base.childTypes) ? base.childTypes : []) {
      const child = obj(c);
      const cid = str(child.id);
      if (!cid) continue;
      out.push({
        kind: "STAGE",
        externalId: cid,
        label: str(child.displayName) ?? str(child.status) ?? "Sub-status",
        parentId: id,
        parentLabel: label,
        rank: rank + (num(child.orderRank) ?? 0) + 1,
      });
    }
  }
  return out;
}

/** `GET /api/v1/project/all`. */
export function readLeadratProjects(body: unknown): CatalogItem[] {
  const out: CatalogItem[] = [];
  leadratItems(body).forEach((p, i) => {
    const o = obj(p);
    const id = str(o.id);
    if (id) out.push({ kind: "PROJECT", externalId: id, label: str(o.name) ?? "Project", parentId: null, parentLabel: null, rank: i });
  });
  return out;
}

/**
 * `GET /api/v1/user`. The documented item is two halves side by side (the
 * user, then who made and changed it), so either shape is read.
 */
export function readLeadratUsers(body: unknown): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const raw of leadratItems(body)) {
    const u = Array.isArray(raw) ? Object.assign({}, ...raw.map(obj)) : obj(raw);
    const id = str(u.userId) ?? str(u.id);
    if (!id || u.isActive === false) continue;
    const label = [str(u.firstName), str(u.lastName)].filter(Boolean).join(" ") || str(u.userName) || "User";
    out.push({ kind: "USER", externalId: id, label, parentId: null, parentLabel: null, rank: out.length });
  }
  return out;
}

/**
 * The lead events we subscribe to. `lead.deleted` is never believed on its
 * own: the record is read, and only one that is really gone closes ours as
 * "Removed in CRM". We never delete a lead.
 */
export const LEADRAT_EVENTS = ["lead.created", "lead.update", "lead.assign", "lead.status_update", "lead.deleted"] as const;

/** A webhook delivery: `{ eventId, eventType, timeStamp, payload }`. */
export function readLeadratHook(body: unknown): { eventId: string; eventType: string; leadId: string | null } | null {
  const b = obj(body);
  const eventId = str(b.eventId);
  const eventType = str(b.eventType);
  if (!eventId || !eventType) return null;
  const p = obj(b.payload);
  return { eventId: eventId.slice(0, 200), eventType: eventType.slice(0, 60), leadId: str(p.id) ?? str(p.leadId) };
}

// ---------------------------------------------------------------------------
// LeadSquared: reading its answers
// ---------------------------------------------------------------------------
//
// Written against API v2 (https://apidocs.leadsquared.com/). Values come back
// as strings, flags as "0" and "1", phones as "+91-9988776655", and times as
// UTC "YYYY-MM-DD HH:MM:SS.SSS". A refusal is
// `{ Status: "Error", ExceptionType, ExceptionMessage }`.

/** The fields LeadSquared carries as its own. Configuration, budget, visits and bookings live in custom fields that differ per client. */
export const LEADSQUARED_FIELDS: SyncField[] = ["name", "email", "stage", "exitReason", "ownerId"];

export function leadsquaredFailure(status: number, body: unknown): CrmError | null {
  const b = obj(Array.isArray(body) ? {} : body);
  const words = [str(b.ExceptionMessage), str(b.Message)].filter(Boolean).join(" ");
  if (status >= 200 && status < 300) {
    return str(b.Status) === "Error" ? { code: "INVALID", message: (words || "LeadSquared refused it.").slice(0, 300), retryable: false } : null;
  }
  return errorFromStatus(status, words);
}

/** "2026-09-28 04:30:00.000" (UTC) to ISO. */
export function lsqTime(v: unknown): string | null {
  const s = str(v);
  const m = s ? /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/.exec(s) : null;
  return m ? `${m[1]}T${m[2]}.000Z` : null;
}

/** A Date as the "YYYY-MM-DD HH:MM:SS" (UTC) LeadSquared takes. */
export const lsqStamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** A lead's attributes, from a flat object or a `LeadPropertyList`. */
export function lsqFlat(v: unknown): Obj {
  const o = obj(v);
  if (Array.isArray(o.LeadPropertyList)) {
    const flat: Obj = {};
    for (const p of o.LeadPropertyList) {
      const a = obj(p);
      const k = str(a.Attribute);
      if (k) flat[k] = a.Value;
    }
    return flat;
  }
  return o;
}

export function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] } : { first: parts[0] ?? "", last: "" };
}

/**
 * One lead. `projectField` is the field a person said holds the project;
 * with none chosen yet the lead names no project, and an event on it waits
 * the way any unplaced lead does.
 */
export function readLeadsquaredLead(v: unknown, projectField: string | null, leadFields: LsqLeadFields = {}): RemoteLead | null {
  const l = lsqFlat(v);
  const id = str(l.ProspectID) ?? str(l.ProspectId);
  if (!id) return null;
  const project = projectField ? str(l[projectField]) : null;
  const configRaw = leadFields.config ? str(l[leadFields.config.schemaName]) : null;
  const budgetRaw = leadFields.budget ? str(l[leadFields.budget.schemaName]) : null;
  return {
    externalId: id,
    phone: normalisePhone(str(l.Phone) ?? str(l.Mobile) ?? ""),
    name: [str(l.FirstName), str(l.LastName)].filter(Boolean).join(" ") || null,
    email: str(l.EmailAddress)?.toLowerCase() ?? null,
    statusId: str(l.ProspectStage),
    statusParentId: null,
    statusLabel: str(l.ProspectStage),
    projectIds: project ? [project] : [],
    assignTo: str(l.OwnerId),
    scheduledAt: null,
    bookedOn: null,
    agreement: null,
    config: configFromText(configRaw),
    budget: budgetFromText(budgetRaw),
    source: str(l.Source),
    archived: false,
    updatedAt: lsqTime(l.ModifiedOn ?? l.LeadLastModifiedOn),
  };
}

type LsqField = { SchemaName?: unknown; DisplayName?: unknown; DataType?: unknown; RenderTypeTextValue?: unknown; Options?: unknown };

const lsqFields = (body: unknown): LsqField[] => (Array.isArray(body) ? (body as LsqField[]) : []);

/** `LeadsMetaData.Get?schemaName=ProspectStage`: the stages are the field's options. */
export function readLeadsquaredStages(body: unknown): CatalogItem[] {
  const field = lsqFields(body).find((f) => str(f.SchemaName) === "ProspectStage");
  const options = Array.isArray(field?.Options) ? field!.Options : [];
  return options
    .map((o) => str(obj(o).Value))
    .filter((v): v is string => !!v)
    .map((v, i) => ({ kind: "STAGE" as const, externalId: v, label: v, parentId: null, parentLabel: null, rank: i }));
}

/** The dropdown fields a person may say holds the project. */
export function readLeadsquaredDropdowns(body: unknown): { schemaName: string; label: string }[] {
  return lsqFields(body)
    .filter((f) => str(f.DataType) === "Select" && str(f.SchemaName) !== "ProspectStage" && Array.isArray(f.Options))
    .map((f) => ({ schemaName: str(f.SchemaName)!, label: str(f.DisplayName) ?? str(f.SchemaName)! }))
    .filter((f) => !!f.schemaName);
}

/** The options of the chosen project field, as projects. */
export function readLeadsquaredProjects(body: unknown, projectField: string): CatalogItem[] {
  const field = lsqFields(body).find((f) => str(f.SchemaName) === projectField);
  const options = Array.isArray(field?.Options) ? field!.Options : [];
  return options
    .map((o) => str(obj(o).Value))
    .filter((v): v is string => !!v)
    .map((v, i) => ({ kind: "PROJECT" as const, externalId: v, label: v, parentId: null, parentLabel: null, rank: i }));
}

/** `Users.Get`: `StatusCode` 0 is active. */
export function readLeadsquaredUsers(body: unknown): CatalogItem[] {
  return (Array.isArray(body) ? body : [])
    .map(obj)
    .filter((u) => str(u.ID) && String(u.StatusCode ?? "0") === "0")
    .map((u, i) => ({
      kind: "USER" as const,
      externalId: str(u.ID)!,
      label: [str(u.FirstName), str(u.LastName)].filter(Boolean).join(" ") || str(u.EmailAddress) || "User",
      parentId: null,
      parentLabel: null,
      rank: i,
    }));
}

/**
 * A webhook delivery. Create posts the lead flat; update, stage and owner
 * changes post `{ Before, After }`. LeadSquared gives no delivery id, so the
 * key is the lead, the kind and the state it reached: a retried delivery
 * carries the same `After`, and lands on the same row.
 */
export function readLeadsquaredHook(body: unknown, eventType: string | null): { eventId: string; eventType: string; leadId: string | null } | null {
  const b = obj(Array.isArray(body) ? body[0] : body);
  const after = b.After ? obj(b.After) : b;
  const leadId = str(after.ProspectID) ?? str(after.ProspectId);
  if (!leadId) return null;
  const kind = (eventType ?? (b.After ? "lead.update" : "lead.create")).slice(0, 60);
  const state = createHash("sha256").update(JSON.stringify(after)).digest("hex").slice(0, 24);
  return { eventId: `${leadId}:${kind}:${state}`.slice(0, 200), eventType: kind, leadId };
}

// ---------------------------------------------------------------------------
// Sell.Do: the lead push it documents
// ---------------------------------------------------------------------------
//
// Sell.Do's v1 API (OAuth, reads, stage changes, webhooks) is shared only
// with API customers (https://www.sell.do/developers). What it has published
// is the lead push: `POST https://app.sell.do/api/leads/create.json` with the
// integration's `api_key` in the body, a campaign's `srd` naming where the
// lead came from, and the lead under `sell_do.form.lead`. Its answer names
// the lead, and says `lead_already_exists` rather than refusing a number it
// already holds, so a retry is safe by Sell.Do's own design.
// (Archived help article 6000067074, and captured responses.)

/** A campaign's input channel key, the 24 hex digits Sell.Do shows in its console. */
export function selldoSrd(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  return /^[0-9a-f]{24}$/.test(s) ? s : null;
}

export function selldoFailure(status: number, body: unknown): CrmError | null {
  const b = obj(body);
  const text = typeof body === "string" ? body : str(b.message) ?? "";
  if (status === 404 && /api key/i.test(text)) return { code: "AUTH", message: "Sell.Do did not accept this API key.", retryable: false };
  if (status < 200 || status >= 300) return errorFromStatus(status, text);
  const errors = Array.isArray(b.error) ? b.error.map(str).filter(Boolean) : [];
  if (errors.length && !str(b.sell_do_lead_id)) return { code: "INVALID", message: errors.join(" ").slice(0, 300), retryable: false };
  return null;
}

/** The create answer: `{ sell_do_lead_id, error, selldo_lead_details: { lead_already_exists, stage_data } }`. */
export function readSelldoCreate(body: unknown): { id: string; existed: boolean; stage: string | null } | null {
  const b = obj(body);
  const id = str(b.sell_do_lead_id);
  if (!id) return null;
  const d = obj(b.selldo_lead_details);
  return { id, existed: d.lead_already_exists === true, stage: str(obj(d.stage_data).value) ?? str(d.stage) };
}

// ---------------------------------------------------------------------------
// LeadSquared: the custom fields that hold configuration and budget
// ---------------------------------------------------------------------------
//
// LeadSquared carries neither as its own field; every client keeps them in a
// custom field of its own naming. A person chooses which, from the fields
// `LeadsMetaData.Get` lists, the way the project field is chosen. We own both
// (`OWNER`), so a value a call found out goes across, and theirs fills ours
// where ours is empty or where only they changed it.

export type LsqFieldKind = "select" | "number" | "text";

/** One field a person may say holds configuration or budget. */
export type LsqFieldChoice = { schemaName: string; label: string; kind: LsqFieldKind; options: string[] };

/** What a connection stores, per synced value. */
export type LsqLeadFields = { config?: LsqFieldChoice; budget?: LsqFieldChoice };

const LSQ_OWN = new Set(["ProspectStage", "FirstName", "LastName", "EmailAddress", "Phone", "Mobile", "OwnerId", "ProspectID", "Source"]);

/**
 * The fields a person may pick from: dropdowns, numbers and text, never
 * LeadSquared's own (stage, name, phone) and never the project field.
 */
export function readLeadsquaredFieldChoices(body: unknown, projectField: string | null): LsqFieldChoice[] {
  const out: LsqFieldChoice[] = [];
  for (const f of lsqFields(body)) {
    const schemaName = str(f.SchemaName);
    if (!schemaName || LSQ_OWN.has(schemaName) || schemaName === projectField) continue;
    const type = (str(f.DataType) ?? "").toLowerCase();
    const kind: LsqFieldKind | null =
      type === "select" ? "select" : ["number", "decimal", "integer"].includes(type) ? "number" : ["string", "text"].includes(type) ? "text" : null;
    if (!kind) continue;
    const options = kind === "select" && Array.isArray(f.Options) ? f.Options.map((o) => str(obj(o).Value)).filter((x): x is string => !!x) : [];
    out.push({ schemaName, label: str(f.DisplayName) ?? schemaName, kind, options: options.slice(0, 100) });
  }
  return out;
}

/** The fields a LeadSquared connection carries, given the custom ones chosen. */
export function leadsquaredCarried(leadFields: LsqLeadFields): SyncField[] {
  return [...LEADSQUARED_FIELDS, ...(leadFields.config ? ["config" as const] : []), ...(leadFields.budget ? ["budget" as const] : [])];
}

/** The chosen fields back out of a connection's settings, trusting nothing about their shape. */
export function lsqLeadFieldsFrom(settings: Record<string, unknown> | null | undefined): LsqLeadFields {
  const raw = obj(obj(settings).leadFields);
  const one = (v: unknown): LsqFieldChoice | undefined => {
    const o = obj(v);
    const schemaName = str(o.schemaName);
    const kind = o.kind === "select" || o.kind === "number" || o.kind === "text" ? (o.kind as LsqFieldKind) : null;
    if (!schemaName || !kind) return undefined;
    const options = Array.isArray(o.options) ? o.options.map(str).filter((x): x is string => !!x) : [];
    return { schemaName, label: str(o.label) ?? schemaName, kind, options };
  };
  const out: LsqLeadFields = {};
  const c = one(raw.config);
  const b = one(raw.budget);
  if (c) out.config = c;
  if (b) out.budget = b;
  return out;
}

/** "2 BHK", "2BHK", "2 bhk flat", "2.5 BHK", "2" or "Villa" as one of our configurations. */
export function configFromText(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const named = (CONFIGS as readonly string[]).find((c) => c.toLowerCase() === s.toLowerCase());
  if (named) return named;
  const bare = /^(\d+(?:\.5)?)$/.exec(s);
  const worded = /^(\d+(?:\.5)?)\s*-?\s*(?:bhk|bed(?:room)?s?)\b/i.exec(s);
  const m = bare ?? worded;
  return m ? configFromBhks([Number(m[1])]) : null;
}

const LAKH_RS = 1_00_000;
const CRORE_RS = 1_00_00_000;

/**
 * A budget as they typed it, as one of our bands: a band's own label, a
 * range ("60-90 lakh", "Rs 60 to 90 Lakhs"), one amount ("1.2 Cr",
 * "75,00,000") or a bound ("Under 60 lakh", "Above 1.5 Cr"). A figure with
 * no unit under a lakh is not rupees and is not read.
 */
export function budgetFromText(raw: string | null | undefined): string | null {
  const s0 = (raw ?? "").trim();
  if (!s0) return null;
  const band = (BUDGETS as readonly string[]).find((b) => b.toLowerCase() === s0.toLowerCase());
  if (band) return band;
  const s = s0.toLowerCase().replace(/₹|\brs\.?|\binr\b/g, " ").replace(/(\d),(?=\d)/g, "$1");
  const found: { n: number; unit: string | null }[] = [];
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|l)?(?![a-z])/g)) found.push({ n: Number(m[1]), unit: m[2] ?? null });
  if (!found.length || found.length > 2) return null;
  // "60-90 lakh": the first takes the second's unit.
  if (found.length === 2 && !found[0].unit && found[1].unit) found[0].unit = found[1].unit;
  const rupees = found.map(({ n, unit }) => (unit && /^cr/.test(unit) ? n * CRORE_RS : unit ? n * LAKH_RS : n >= LAKH_RS ? n : null));
  if (rupees.some((r) => r === null || !Number.isFinite(r) || r <= 0)) return null;
  const [a, b] = rupees as number[];
  if (found.length === 2) return budgetFromRange(Math.min(a, b), Math.max(a, b));
  if (/\b(under|below|upto|up to|less than|max)\b/.test(s)) return budgetFromRange(null, a - 1);
  return budgetFromRange(a, a);
}

/** What to write in their field for our configuration. Null when the field has no option that says it. */
export function lsqConfigOut(config: string | null, field: LsqFieldChoice): string | null {
  if (!config) return null;
  if (field.kind === "select") return field.options.find((o) => configFromText(o) === config) ?? null;
  if (field.kind === "number") {
    const n = bhksFromConfig(config)[0];
    return n === undefined ? null : String(n);
  }
  return config;
}

/**
 * What to write in their field for our budget band: the option that reads as
 * the same band, a rupee figure inside it (the middle, or the floor of the
 * open band) for a number, the band's own words for text.
 */
export function lsqBudgetOut(budget: string | null, field: LsqFieldChoice): string | null {
  const r = rangeFromBudget(budget);
  if (!budget || !r) return null;
  if (field.kind === "select") return field.options.find((o) => budgetFromText(o) === budget) ?? null;
  if (field.kind === "number") return String(r.upper === null ? r.lower : Math.round((r.lower + r.upper) / 2));
  return budget;
}

// ---------------------------------------------------------------------------
// A visit booked in the CRM
// ---------------------------------------------------------------------------
//
// LeadRat carries one site visit on the lead: `scheduledDate` under a status
// a person mapped to Visit scheduled. So the CRM's id for the visit is the
// lead's own, and its time is what moves. Ownership is 0041's rule applied to
// a visit: the CRM owns one a person typed there, we own one the agent (or
// anybody here) booked, and ownership only settles a conflict.

/** The CRM's id for the site visit on one of its leads. */
export const crmVisitKey = (remoteLeadId: string) => `${remoteLeadId}:site-visit`.slice(0, 200);

/** Stages a CRM move to which calls the visit off, as a move back on the board does. */
const VISIT_OFF: StageKey[] = ["new", "contacted", "qualified", "nurture", "lost"];

export type LiveVisit = { visitId: string; at: string; fromCrm: boolean } | null;

export type CrmVisitPlan = { kind: "none"; why: string } | { kind: "book"; at: string } | { kind: "cancel" };

/**
 * What a sync pass does to our visit, from what the merge decided. `toLocal`
 * is the visit time the CRM won (a new visit there, or theirs moved); a stage
 * the CRM moved back calls the visit off. A time already gone is never
 * booked: yesterday's visit typed into the CRM is a record, not a booking.
 * The same time twice is nothing, so a replay books nothing.
 */
export function crmVisitPlan(o: {
  toLocalVisitAt: string | null | undefined;
  stageBefore: StageKey;
  stageAfter: StageKey;
  /** The time the two sides agree on after the merge, for a stage moved to Visit scheduled on a time we already held. */
  agreedVisitAt: string | null;
  live: LiveVisit;
  nowIso: string;
}): CrmVisitPlan {
  const movedBack =
    o.stageAfter !== o.stageBefore && VISIT_OFF.includes(o.stageAfter) && (o.stageBefore === "visit_scheduled" || o.stageBefore === "visit_done");
  if (movedBack) return o.live ? { kind: "cancel" } : { kind: "none", why: "No visit to call off." };
  const target =
    o.toLocalVisitAt ?? (o.stageAfter === "visit_scheduled" && o.stageBefore !== "visit_scheduled" && !o.live ? o.agreedVisitAt : null);
  if (!target) return { kind: "none", why: "No visit time from the CRM." };
  const iso = istToIso(target);
  if (!iso) return { kind: "none", why: "The visit time could not be read." };
  if (Date.parse(iso) <= Date.parse(o.nowIso)) return { kind: "none", why: "That time has passed." };
  if (o.live && o.live.at === target) return { kind: "none", why: "Already booked for that time." };
  return { kind: "book", at: target };
}

/** Who owns the visit for this lead: the CRM when the visit in force came from it. */
export const visitOwners = (live: LiveVisit): Partial<Record<SyncField, "CRM" | "US">> => (live?.fromCrm ? { visitAt: "CRM" } : {});

// ---------------------------------------------------------------------------
// A record deleted or merged in the CRM
// ---------------------------------------------------------------------------

export type Gone = { kind: "live" } | { kind: "deleted" } | { kind: "merged"; into: string };

/**
 * What became of a record we linked. A read answered with another record is
 * a merge into that one; a read that finds nothing, or an archived record, is
 * gone, unless the CRM holds the same buyer under another record in the same
 * project, which is the record the merge kept. `others` is what a lookup by
 * phone found.
 */
export function goneFrom(o: { askedId: string; got: RemoteLead | null; others: readonly RemoteLead[]; projectId: string | null }): Gone {
  if (o.got && !o.got.archived) return o.got.externalId === o.askedId ? { kind: "live" } : { kind: "merged", into: o.got.externalId };
  const survivor = o.others.find(
    (r) => r.externalId !== o.askedId && !r.archived && (!o.projectId || !r.projectIds.length || r.projectIds.includes(o.projectId)),
  );
  return survivor ? { kind: "merged", into: survivor.externalId } : { kind: "deleted" };
}

/** What our lead reads when its CRM record is gone. */
export const REMOVED_REASON = "Removed in CRM";

/**
 * Closing a lead whose CRM record went. Automation never moves a lead out of
 * Booked, so a booked one is flagged for a person instead; anything else is
 * Lost as "Removed in CRM". Either way the agent is switched off.
 */
export function removedMove(stage: StageKey): { to: StageKey; reason: string | null; flag: string | null } {
  if (stage === "booked") return { to: "booked", reason: null, flag: "Removed in the CRM while booked. Check the booking there." };
  return { to: "lost", reason: REMOVED_REASON, flag: null };
}
