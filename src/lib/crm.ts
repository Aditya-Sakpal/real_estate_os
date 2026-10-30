/**
 * The seam every request to a CRM goes through, and the adapters behind it.
 *
 * The same shape as `platform.ts`: one place where a request is timed by a
 * race, one place where a refusal is read, and one place a check swaps the
 * whole network for a fake CRM at the same URLs (`useCrm()`), so a suite is
 * never quietly talking to connect.leadrat.com.
 *
 * `CRM_FAKE` is the dev seam, never set in production: with it on, and no
 * injected fetch, every request is answered by the in-memory fake in
 * `crm-fake.ts`, so the connect screen and the sync can be walked through
 * without anybody's LeadRat account.
 *
 * Nothing here knows a tenant or a table. `crm-sync.ts` does.
 */

import {
  LEADRAT_EVENTS,
  SYNC_FIELDS,
  bhksFromConfig,
  errorFromStatus,
  istToIso,
  leadratFailure,
  leadratItems,
  leadsquaredFailure,
  leadsquaredCarried,
  leadsquaredHost,
  lsqBudgetOut,
  lsqConfigOut,
  lsqLeadFieldsFrom,
  lsqStamp,
  readLeadsquaredFieldChoices,
  readLeadratLead,
  readLeadratProjects,
  readLeadratStatuses,
  readLeadratUsers,
  readLeadsquaredDropdowns,
  readLeadsquaredLead,
  readLeadsquaredProjects,
  readLeadsquaredStages,
  readLeadsquaredUsers,
  readSelldoCreate,
  selldoFailure,
  rangeFromBudget,
  splitName,
  type CatalogItem,
  type CrmError,
  type CrmProvider,
  type LeadratCredential,
  type LeadsquaredCredential,
  type LsqFieldChoice,
  type LsqLeadFields,
  type SelldoCredential,
  type MapKind,
  type RemoteLead,
  type RemoteUnit,
  type SyncField,
  type SyncValues,
} from "./crm-rules.ts";

export type CrmFetch = (url: string, init: RequestInit) => Promise<Response>;

let injected: CrmFetch | null = null;

/** For the checks. An injected fetch beats the fake and the network. */
export function useCrm(f: CrmFetch | null): void {
  injected = f;
}

/** The dev seam. Refused where it could ever answer for a real client. */
export function crmFakeOn(): boolean {
  if (process.env.VERCEL || process.env.NODE_ENV === "production") return false;
  return /^(1|true|on)$/i.test((process.env.CRM_FAKE ?? "").trim());
}

async function fetcher(): Promise<CrmFetch> {
  if (injected) return injected;
  if (crmFakeOn()) {
    const { devFake } = await import("./crm-fake.ts");
    return devFake();
  }
  return (u, i) => fetch(u, i);
}

export const LEADRAT_BASE = "https://connect.leadrat.com";

/** A CRM that has not answered in thirty seconds is not going to. */
export const CRM_TIMEOUT_MS = 30_000;

export type R<T> = { ok: true; value: T } | ({ ok: false } & CrmError);
const ok = <T>(value: T): R<T> => ({ ok: true, value });
const fail = (e: CrmError): R<never> => ({ ok: false, ...e });

/** One request, raced against a deadline, its answer read as JSON. */
async function send(url: string, init: RequestInit): Promise<{ ok: true; status: number; json: unknown } | ({ ok: false } & CrmError)> {
  const f = await fetcher();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, CRM_TIMEOUT_MS);
  });
  try {
    const answer = await Promise.race([
      (async () => {
        const r = await f(url, { ...init, signal: controller.signal });
        return { status: r.status, text: await r.text() };
      })(),
      deadline,
    ]);
    let json: unknown = {};
    try {
      json = answer.text ? JSON.parse(answer.text) : {};
    } catch {
      json = { message: answer.text.slice(0, 200) };
    }
    return { ok: true, status: answer.status, json };
  } catch {
    return { ok: false, code: "UNREACHABLE", message: "The CRM did not answer in time.", retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// What an adapter does
// ---------------------------------------------------------------------------

/** A lead of ours, as a create needs it. */
export type PushLead = {
  name: string;
  phone: string;
  email: string | null;
  source: string;
  projectId: string | null;
  projectName: string | null;
  ownerExternalId: string | null;
  values: SyncValues;
};

/** What an update carries besides the changed values: the ids they resolve to. */
export type UpdateContext = {
  /** Their status for our stage, when the stage changed. */
  statusId: string | null;
  projectId: string | null;
  ownerExternalId: string | null;
};

export type CrmAdapter = {
  provider: CrmProvider;
  /** False when the vendor's API only takes new leads in. */
  twoWay: boolean;
  /** The fields their API carries. The rest are silent, never empty. */
  fields: readonly SyncField[];
  /** Proves the credential with one harmless read, and says where the account lives when the CRM tells us. */
  verify(): Promise<R<{ account: string | null }>>;
  catalog(kind: MapKind): Promise<R<CatalogItem[]>>;
  /** Where the CRM has no projects of its own: the dropdown fields a person may say holds one. */
  projectFields?(): Promise<R<{ schemaName: string; label: string }[]>>;
  /** Where configuration and budget live in custom fields: the fields a person may say hold them. */
  leadFieldChoices?(): Promise<R<LsqFieldChoice[]>>;
  getLead(id: string): Promise<R<{ lead: RemoteLead; raw: unknown } | null>>;
  /** Their records for this number, most recent first. */
  findByPhone(phone: string): Promise<R<RemoteLead[]>>;
  createLead(lead: PushLead): Promise<R<string>>;
  updateLead(id: string, raw: unknown, changes: Partial<SyncValues>, ctx: UpdateContext): Promise<R<void>>;
  addNote(id: string, raw: unknown, line: string): Promise<R<void>>;
  /** One page of their leads, most recently changed first. */
  recentLeads(page: number, size: number): Promise<R<{ leads: RemoteLead[]; more: boolean }>>;
  /** Registers our address for their lead events, reusing any already registered. */
  subscribe(callbackUrl: string, secret: string): Promise<R<{ event: string; id: string }[]>>;
  unsubscribe(ids: string[]): Promise<R<void>>;
  /**
   * The flats the CRM holds, with their status. Optional, and no adapter has
   * it: none of the three CRMs publishes units through its public API. An
   * adapter that can read them adds this one function, returning null when
   * the account holds none, and the CRM worker writes them as the CRM's.
   */
  listUnits?(): Promise<R<RemoteUnit[] | null>>;
};

export type Credentialed = { provider: CrmProvider; account: string | null; secret: string; settings?: Record<string, unknown> };

export function adapterFor(c: Credentialed): CrmAdapter {
  if (c.provider === "LEADSQUARED") {
    return leadsquared(
      c.account,
      JSON.parse(c.secret) as LeadsquaredCredential,
      (c.settings?.projectField as string | undefined) ?? null,
      lsqLeadFieldsFrom(c.settings),
    );
  }
  if (c.provider === "LEADRAT") return leadrat(c.account ?? "", JSON.parse(c.secret) as LeadratCredential);
  return selldo(JSON.parse(c.secret) as SelldoCredential);
}

// ---------------------------------------------------------------------------
// LeadRat
// ---------------------------------------------------------------------------
//
// The Enterprise API 1.1.2 (https://apidoc.leadrat.info/). A key and a secret
// buy a one-hour bearer token at /api/v1/authentication/token, sent with the
// client's `tenant` header, which every later request carries too.

/** Leadrat's own words for where a lead came from, for ours. */
const LEADRAT_SOURCE: Record<string, string> = {
  META_FORM: "facebook",
  GOOGLE_FORM: "googleAds",
  WEBSITE: "website",
  MANUAL: "direct",
};

/** The fields of a lead the update call takes back; everything else it would not recognise. */
const LEADRAT_UPDATABLE = [
  "name", "contactNo", "alternateContactNo", "email", "notes", "scheduledDate", "assignTo", "referralName",
  "referralContactNo", "referralEmail", "companyName", "closingManager", "sourcingManager", "designation",
  "secondaryUserId", "nationality", "landLine", "countryCode", "altCountryCode",
];

function tenDigits(phone: string): { contactNo: string; countryCode: string } {
  if (phone.startsWith("+91")) return { contactNo: phone.slice(3), countryCode: "+91" };
  const m = /^\+(\d{1,3})(\d{6,14})$/.exec(phone);
  return m ? { contactNo: m[2], countryCode: `+${m[1]}` } : { contactNo: phone.replace(/\D/g, ""), countryCode: "" };
}

function leadrat(tenant: string, cred: LeadratCredential): CrmAdapter {
  let token: { value: string; until: number } | null = null;

  async function auth(force = false): Promise<R<string>> {
    if (!force && token && token.until > Date.now()) return ok(token.value);
    const res = await send(`${LEADRAT_BASE}/api/v1/authentication/token`, {
      method: "POST",
      headers: { "content-type": "application/json", tenant },
      body: JSON.stringify({ apiKey: cred.apiKey, secretKey: cred.secretKey }),
    });
    if (!res.ok) return res;
    const refused = leadratFailure(res.status, res.json);
    if (refused) return fail(refused.code === "INVALID" ? { ...refused, code: "AUTH" } : refused);
    const d = (res.json as { data?: { accessToken?: unknown; expiresIn?: unknown } }).data ?? {};
    if (typeof d.accessToken !== "string" || !d.accessToken) {
      return fail({ code: "AUTH", message: "LeadRat gave no token for this key.", retryable: false });
    }
    const seconds = typeof d.expiresIn === "number" && d.expiresIn > 120 ? d.expiresIn : 3600;
    token = { value: d.accessToken, until: Date.now() + (seconds - 60) * 1000 };
    return ok(token.value);
  }

  async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<R<T>> {
    for (let round = 0; round < 2; round++) {
      const t = await auth(round > 0);
      if (!t.ok) return t;
      const res = await send(`${LEADRAT_BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${t.value}`, tenant, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) return res;
      // A token LeadRat stopped honouring before its hour was up: once more with a new one.
      if (res.status === 401 && round === 0) continue;
      const refused = leadratFailure(res.status, res.json);
      if (refused) return fail(refused);
      return ok(res.json as T);
    }
    return fail({ code: "AUTH", message: "LeadRat refused the token.", retryable: false });
  }

  const pageQuery = (page: number, size: number) => `PageNumber=${page}&PageSize=${size}`;

  async function allPages(path: string, read: (body: unknown) => CatalogItem[]): Promise<R<CatalogItem[]>> {
    const out: CatalogItem[] = [];
    // Twenty pages of a hundred is more statuses, projects or users than any client has.
    for (let page = 1; page <= 20; page++) {
      const r = await api(`GET`, `${path}${path.includes("?") ? "&" : "?"}${pageQuery(page, 100)}`);
      if (!r.ok) return r;
      const items = read(r.value);
      out.push(...items.map((x) => ({ ...x, rank: x.kind === "STAGE" ? x.rank : out.length + x.rank })));
      if (leadratItems(r.value).length < 100) break;
    }
    return ok(out);
  }

  return {
    provider: "LEADRAT",
    twoWay: true,
    fields: SYNC_FIELDS,

    async verify() {
      const r = await auth(true);
      return r.ok ? ok({ account: tenant }) : r;
    },

    catalog(kind) {
      if (kind === "STAGE") return allPages("/api/v1/lead/status", readLeadratStatuses);
      if (kind === "PROJECT") return allPages("/api/v1/project/all", readLeadratProjects);
      if (kind === "USER") return allPages("/api/v1/user?Status=true", readLeadratUsers);
      return Promise.resolve(ok([]));
    },

    async getLead(id) {
      const r = await api<{ data?: unknown }>("GET", `/api/v1/lead/${encodeURIComponent(id)}`);
      if (!r.ok) return r.code === "NOT_FOUND" ? ok(null) : r;
      const raw = Array.isArray(r.value.data) ? r.value.data[0] : r.value.data;
      const lead = readLeadratLead(raw);
      return ok(lead ? { lead, raw } : null);
    },

    async findByPhone(phone) {
      const { contactNo } = tenDigits(phone);
      const r = await api("GET", `/api/v1/lead?SearchByNameOrNumber=${encodeURIComponent(contactNo)}&${pageQuery(1, 20)}`);
      if (!r.ok) return r;
      const leads = leadratItems(r.value)
        .map(readLeadratLead)
        .filter((l): l is RemoteLead => !!l && l.phone === phone && !l.archived);
      return ok(leads);
    },

    async createLead(lead) {
      const { contactNo, countryCode } = tenDigits(lead.phone);
      const range = rangeFromBudget(lead.values.budget);
      const r = await api<{ data?: unknown }>("POST", "/api/v1/lead", {
        name: lead.name,
        contactNo,
        countryCode,
        email: lead.email ?? undefined,
        assignTo: lead.ownerExternalId ?? undefined,
        enquiry: {
          leadSource: LEADRAT_SOURCE[lead.source] ?? "webhook",
          subSource: "Sales Desk",
          bhKs: bhksFromConfig(lead.values.config),
          lowerBudget: range?.lower || undefined,
          upperBudget: range?.upper ?? undefined,
        },
        projectsList: lead.projectName ? [lead.projectName] : [],
      });
      if (!r.ok) return r;
      const id = typeof r.value.data === "string" ? r.value.data : null;
      return id ? ok(id) : fail({ code: "UNKNOWN", message: "LeadRat did not say which lead it made.", retryable: true });
    },

    async updateLead(id, raw, changes, ctx) {
      const current = (raw ?? {}) as Record<string, unknown>;
      const statusNow = (current.status as { id?: string; childType?: { id?: string } } | undefined) ?? {};
      const statusId = ctx.statusId ?? statusNow.childType?.id ?? statusNow.id ?? null;

      // The stage, and what a stage carries: a visit's time, a booking.
      if ("stage" in changes || "visitAt" in changes || "bookedOn" in changes || "agreement" in changes) {
        if (!statusId) return fail({ code: "INVALID", message: "No LeadRat status to set.", retryable: false });
        const visit = changes.visitAt !== undefined ? istToIso(changes.visitAt) : null;
        const agreement = changes.agreement ? Number(changes.agreement) : null;
        const r = await api("PUT", `/api/v1/lead/status/${encodeURIComponent(id)}`, {
          id,
          leadStatusId: statusId,
          projectIds: ctx.projectId ? [ctx.projectId] : [],
          ...(visit ? { scheduledDate: visit, meetingOrSiteVisit: 2, isDone: false } : { meetingOrSiteVisit: 0, isDone: false }),
          ...(changes.bookedOn ? { bookedDate: `${changes.bookedOn}T00:00:00Z` } : {}),
          ...(agreement ? { agreementValue: agreement, soldPrice: String(agreement), soldPriceCurrency: "INR" } : {}),
          isNotesUpdated: false,
        });
        if (!r.ok) return r;
      }

      if ("ownerId" in changes && ctx.ownerExternalId) {
        const r = await api("PUT", `/api/v1/lead/assign/${encodeURIComponent(id)}`, { leadId: id, assignToUserId: ctx.ownerExternalId });
        if (!r.ok) return r;
      }

      // Name, email, configuration and budget live on the lead itself, and
      // the update takes the whole lead: what they hold is sent back as it is.
      if ("name" in changes || "email" in changes || "config" in changes || "budget" in changes) {
        const body: Record<string, unknown> = { id, leadStatusId: statusId };
        for (const k of LEADRAT_UPDATABLE) if (current[k] !== undefined && current[k] !== null) body[k] = current[k];
        if (changes.name) body.name = changes.name;
        if (changes.email) body.email = changes.email;
        const enquiry = { ...((Array.isArray(current.enquiry) ? current.enquiry[0] : current.enquiry) as Record<string, unknown> | undefined) };
        if (changes.config) enquiry.bhKs = bhksFromConfig(changes.config);
        const range = changes.budget ? rangeFromBudget(changes.budget) : null;
        if (range) {
          enquiry.lowerBudget = range.lower || null;
          enquiry.upperBudget = range.upper;
        }
        body.enquiry = enquiry;
        const r = await api("PUT", `/api/v1/lead/${encodeURIComponent(id)}`, body);
        if (!r.ok) return r;
      }
      return ok(undefined);
    },

    async addNote(id, raw, line) {
      // The notes call replaces the field, so what is there is kept above the new line.
      const before = typeof (raw as { notes?: unknown })?.notes === "string" ? ((raw as { notes: string }).notes).trim() : "";
      const notes = (before ? `${before}\n${line}` : line).slice(-4000);
      const r = await api("PUT", `/api/v1/lead/notes/${encodeURIComponent(id)}`, { id, notes });
      return r.ok ? ok(undefined) : r;
    },

    async recentLeads(page, size) {
      const r = await api("GET", `/api/v1/lead?OrderCriteria=modifiedDate&Sort=desc&${pageQuery(page, size)}`);
      if (!r.ok) return r;
      const items = leadratItems(r.value);
      return ok({ leads: items.map(readLeadratLead).filter((l): l is RemoteLead => !!l), more: items.length >= size });
    },

    async subscribe(callbackUrl, secret) {
      const have = await api("GET", `/api/v1/webhook?${pageQuery(1, 100)}`);
      if (!have.ok) return have;
      const existing = leadratItems(have.value) as { id?: string; event?: string; callBackUrl?: string }[];
      const out: { event: string; id: string }[] = [];
      for (const event of LEADRAT_EVENTS) {
        const found = existing.find((w) => w.event === event && w.callBackUrl === callbackUrl && w.id);
        if (found?.id) {
          out.push({ event, id: found.id });
          continue;
        }
        const r = await api<{ data?: { id?: string } | string }>("POST", "/api/v1/webhook", { event, callBackUrl: callbackUrl, secretKey: secret });
        if (!r.ok) return r;
        const d = r.value.data;
        const wid = typeof d === "string" ? d : d?.id;
        if (wid) out.push({ event, id: wid });
      }
      return ok(out);
    },

    async unsubscribe(ids) {
      for (const id of ids) {
        const r = await api("DELETE", `/api/v1/webhook/${encodeURIComponent(id)}`);
        if (!r.ok && r.code !== "NOT_FOUND") return r;
      }
      return ok(undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// LeadSquared
// ---------------------------------------------------------------------------
//
// API v2 (https://apidocs.leadsquared.com/). The keys go in headers, never
// the query string, so they stay out of anybody's access log. Each client
// lives on one data centre's host; `UserByAccessKey.Get` answers on any host
// and names the right one, which is how `verify()` finds it.
//
// Its limit is 25 calls in 5 seconds (10 on the Pro plan), so calls are
// spaced half a second apart per adapter: a pass that would otherwise be
// refused a quarter of its writes is merely slower.

export const LEADSQUARED_DISCOVERY_HOST = "api.leadsquared.com";
const LSQ_GAP_MS = 500;

/** LeadSquared's own event codes: create, owner change, stage change, update. */
export const LEADSQUARED_EVENTS: { code: string; kind: string }[] = [
  { code: "3", kind: "lead.create" },
  { code: "4", kind: "lead.owner" },
  { code: "5", kind: "lead.stage" },
  { code: "6", kind: "lead.update" },
];

function leadsquared(host: string | null, cred: LeadsquaredCredential, projectField: string | null, leadFields: LsqLeadFields = {}): CrmAdapter {
  let last = 0;
  let known = leadsquaredHost(host);

  async function api<T = unknown>(method: string, path: string, body?: unknown, on: string | null = known): Promise<R<T>> {
    if (!on) return fail({ code: "AUTH", message: "LeadSquared has not said where this account lives.", retryable: false });
    const wait = last + LSQ_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await send(`https://${on}/v2/${path}`, {
      method,
      headers: {
        "x-LSQ-AccessKey": cred.accessKey,
        "x-LSQ-SecretKey": cred.secretKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) return res;
    const refused = leadsquaredFailure(res.status, res.json);
    if (refused) return fail(refused);
    return ok(res.json as T);
  }

  const attrs = (o: Record<string, string | null | undefined>) =>
    Object.entries(o).filter(([, v]) => v !== undefined).map(([Attribute, Value]) => ({ Attribute, Value: Value ?? "" }));

  async function one(id: string): Promise<R<{ lead: RemoteLead; raw: unknown } | null>> {
    const r = await api<unknown[]>("GET", `LeadManagement.svc/Leads.GetById?id=${encodeURIComponent(id)}`);
    if (!r.ok) return r.code === "NOT_FOUND" ? ok(null) : r;
    const raw = Array.isArray(r.value) ? r.value[0] : null;
    const lead = raw ? readLeadsquaredLead(raw, projectField, leadFields) : null;
    return ok(lead ? { lead, raw } : null);
  }

  /** Our configuration and budget in the custom fields a person chose, as they take them. */
  const customOut = (values: Partial<SyncValues>): Record<string, string> => {
    const out: Record<string, string> = {};
    if (leadFields.config && values.config) {
      const v = lsqConfigOut(values.config, leadFields.config);
      if (v !== null) out[leadFields.config.schemaName] = v;
    }
    if (leadFields.budget && values.budget) {
      const v = lsqBudgetOut(values.budget, leadFields.budget);
      if (v !== null) out[leadFields.budget.schemaName] = v;
    }
    return out;
  };

  return {
    provider: "LEADSQUARED",
    twoWay: true,
    fields: leadsquaredCarried(leadFields),

    async verify() {
      const r = await api<{ LSQCommonServiceURLs?: { api?: unknown } }>(
        "GET", "Authentication.svc/UserByAccessKey.Get", undefined, known ?? LEADSQUARED_DISCOVERY_HOST,
      );
      if (!r.ok) return r;
      const where = r.value.LSQCommonServiceURLs?.api;
      const found = leadsquaredHost(typeof where === "string" ? where : null);
      if (!found) return fail({ code: "AUTH", message: "LeadSquared did not say where this account lives.", retryable: false });
      known = found;
      return ok({ account: found });
    },

    async catalog(kind) {
      if (kind === "STAGE") {
        const r = await api("GET", "LeadManagement.svc/LeadsMetaData.Get?schemaName=ProspectStage");
        return r.ok ? ok(readLeadsquaredStages(r.value)) : r;
      }
      if (kind === "PROJECT") {
        if (!projectField) return ok([]);
        const r = await api("GET", `LeadManagement.svc/LeadsMetaData.Get?schemaName=${encodeURIComponent(projectField)}`);
        return r.ok ? ok(readLeadsquaredProjects(r.value, projectField)) : r;
      }
      if (kind === "USER") {
        const r = await api("GET", "UserManagement.svc/Users.Get");
        return r.ok ? ok(readLeadsquaredUsers(r.value)) : r;
      }
      return ok([]);
    },

    async projectFields() {
      const r = await api("GET", "LeadManagement.svc/LeadsMetaData.Get");
      return r.ok ? ok(readLeadsquaredDropdowns(r.value)) : r;
    },

    async leadFieldChoices() {
      const r = await api("GET", "LeadManagement.svc/LeadsMetaData.Get");
      return r.ok ? ok(readLeadsquaredFieldChoices(r.value, projectField)) : r;
    },

    getLead: one,

    async findByPhone(phone) {
      const digits = phone.replace(/^\+/, "");
      const r = await api<unknown[]>("GET", `LeadManagement.svc/RetrieveLeadByPhoneNumber?phone=${encodeURIComponent(digits)}`);
      if (!r.ok) return r.code === "NOT_FOUND" ? ok([]) : r;
      const leads = (Array.isArray(r.value) ? r.value : [])
        .map((x) => readLeadsquaredLead(x, projectField, leadFields))
        .filter((l): l is RemoteLead => !!l && l.phone === phone);
      return ok(leads);
    },

    async createLead(lead) {
      const { first, last: lastName } = splitName(lead.name);
      const r = await api<{ Message?: { Id?: unknown } }>("POST", "LeadManagement.svc/Lead.Create", attrs({
        FirstName: first,
        LastName: lastName || undefined,
        Phone: lead.phone,
        EmailAddress: lead.email ?? undefined,
        OwnerId: lead.ownerExternalId ?? undefined,
        ...(projectField && lead.projectId ? { [projectField]: lead.projectId } : {}),
        ...customOut(lead.values),
      }));
      if (!r.ok) return r;
      const id = typeof r.value.Message?.Id === "string" ? r.value.Message.Id : null;
      return id ? ok(id) : fail({ code: "UNKNOWN", message: "LeadSquared did not say which lead it made.", retryable: true });
    },

    async updateLead(id, _raw, changes, ctx) {
      const set: Record<string, string | null | undefined> = {};
      if (changes.name) {
        const n = splitName(changes.name);
        set.FirstName = n.first;
        set.LastName = n.last;
      }
      if (changes.email) set.EmailAddress = changes.email;
      if ("stage" in changes && ctx.statusId) set.ProspectStage = ctx.statusId;
      if ("ownerId" in changes && ctx.ownerExternalId) set.OwnerId = ctx.ownerExternalId;
      Object.assign(set, customOut(changes));
      if (!Object.keys(set).length) return ok(undefined);
      // Without postUpdatedLead, LeadSquared does not fire its own webhooks
      // for this write, so our change does not come straight back to us.
      const r = await api("POST", `LeadManagement.svc/Lead.Update?leadId=${encodeURIComponent(id)}`, attrs(set));
      return r.ok ? ok(undefined) : r;
    },

    async addNote(id, _raw, line) {
      const r = await api("POST", "LeadManagement.svc/CreateNote", { RelatedProspectId: id, Note: line });
      return r.ok ? ok(undefined) : r;
    },

    async recentLeads(page, size) {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 86_400_000);
      const columns = ["ProspectID", "FirstName", "LastName", "Phone", "Mobile", "EmailAddress", "ProspectStage", "OwnerId", "ModifiedOn"];
      if (projectField) columns.push(projectField);
      for (const f of [leadFields.config, leadFields.budget]) if (f) columns.push(f.schemaName);
      const r = await api<{ Leads?: unknown[] }>("POST", "LeadManagement.svc/Leads.RecentlyModified", {
        Parameter: { FromDate: lsqStamp(from), ToDate: lsqStamp(to) },
        Columns: { Include_CSV: columns.join(",") },
        Paging: { PageIndex: page, PageSize: size },
        Sorting: { ColumnName: "ModifiedOn", Direction: "1" },
      });
      if (!r.ok) return r;
      const items = Array.isArray(r.value.Leads) ? r.value.Leads : [];
      return ok({ leads: items.map((x) => readLeadsquaredLead(x, projectField, leadFields)).filter((l): l is RemoteLead => !!l), more: items.length >= size });
    },

    async subscribe(callbackUrl, secret) {
      const out: { event: string; id: string }[] = [];
      for (const e of LEADSQUARED_EVENTS) {
        const r = await api<{ Message?: { Id?: unknown } }>("POST", "Webhook.svc/Create", {
          Description: `Sales Desk ${e.kind}`,
          URL: `${callbackUrl}&event=${e.kind}`,
          Method: "POST",
          ContentType: "application/json",
          WebhookEvent: e.code,
          NotifyOnFailure: false,
          CustomHeaders: [{ Key: "x-salesdesk-token", Value: secret }],
        });
        if (!r.ok) return r;
        const wid = typeof r.value.Message?.Id === "string" ? r.value.Message.Id : null;
        if (wid) out.push({ event: e.kind, id: wid });
      }
      return ok(out);
    },

    async unsubscribe(ids) {
      for (const id of ids) {
        const r = await api("POST", `Webhook.svc/Delete?webhookId=${encodeURIComponent(id)}`);
        if (!r.ok && r.code !== "NOT_FOUND") return r;
      }
      return ok(undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Sell.Do
// ---------------------------------------------------------------------------
//
// Only the lead push Sell.Do documents (see the note in `crm-rules.ts`). It
// cannot read a lead back, change a stage or send an event, so it is one-way:
// a lead captured here is created there, in the campaign whose key (SRD) a
// person gave for its tower, and nothing after that. Two-way sync waits for
// the v1 specification, which Sell.Do hands over with API access.

export const SELLDO_BASE = "https://app.sell.do";

function selldo(cred: SelldoCredential | null): CrmAdapter {
  const no = <T>(): Promise<R<T>> =>
    Promise.resolve(fail({ code: "UNSUPPORTED", message: "Sell.Do shares this only with API customers.", retryable: false }));

  async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<R<T>> {
    if (!cred) return fail({ code: "AUTH", message: "No Sell.Do API key.", retryable: false });
    const res = await send(`${SELLDO_BASE}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) return res;
    const refused = selldoFailure(res.status, res.json);
    return refused ? fail(refused) : ok(res.json as T);
  }

  return {
    provider: "SELLDO",
    twoWay: false,
    fields: [],

    async verify() {
      // The one read Sell.Do has: whether a number is already a lead. A wrong
      // key is answered 404 "API key is incorrect.", which is what is read.
      const r = await api("GET", `/api/leads/phone/retrieve_lead?api_key=${encodeURIComponent(cred?.apiKey ?? "")}&value=9000000000`);
      if (!r.ok && r.code === "AUTH") return r;
      if (!r.ok && r.code === "UNREACHABLE") return r;
      return ok({ account: null });
    },

    catalog: () => Promise.resolve(ok([])),
    getLead: no,
    findByPhone: () => Promise.resolve(ok([])),

    async createLead(lead) {
      if (!lead.projectId) return fail({ code: "INVALID", message: "No Sell.Do campaign key for this tower.", retryable: false });
      const range = rangeFromBudget(lead.values.budget);
      const r = await api("POST", "/api/leads/create.json", {
        api_key: cred?.apiKey,
        sell_do: {
          campaign: { srd: lead.projectId },
          form: {
            lead: { name: lead.name, phone: lead.phone, ...(lead.email ? { email: lead.email } : {}) },
            requirement: {
              ...(bhksFromConfig(lead.values.config).length ? { bhk: bhksFromConfig(lead.values.config) } : {}),
              ...(range ? { min_budget: range.lower, ...(range.upper ? { max_budget: range.upper } : {}) } : {}),
            },
            note: { content: "Captured by Sales Desk." },
          },
        },
      });
      if (!r.ok) return r;
      const made = readSelldoCreate(r.value);
      return made ? ok(made.id) : fail({ code: "UNKNOWN", message: "Sell.Do did not say which lead it made.", retryable: true });
    },

    updateLead: no,
    addNote: no,
    recentLeads: no,
    subscribe: no,
    unsubscribe: () => Promise.resolve(ok(undefined)),
  };
}

export { errorFromStatus };
