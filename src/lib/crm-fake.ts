/**
 * A CRM that is not one: the same URLs, the same shapes, in memory.
 *
 * `check:crm` drives the whole sync against it with `useCrm(fake.fetch)`,
 * and `CRM_FAKE` points the dev server at one shared instance so the connect
 * screen can be walked through without anybody's account. It is never
 * reachable in production (`crmFakeOn()` refuses there).
 *
 * One store of leads, statuses, projects and users sits behind all three
 * vendors' URLs, so a test can change a record "in the CRM" and watch it
 * arrive, whichever adapter reads it. It can also lose an answer: do the
 * work and then fail to reply, which is how a retry that creates a second
 * record is caught.
 */

import { randomUUID } from "node:crypto";

export type FakeLead = {
  id: string;
  name: string;
  contactNo: string;
  countryCode: string;
  email: string | null;
  statusId: string;
  projectIds: string[];
  assignTo: string | null;
  scheduledDate: string | null;
  /** LeadRat's kind for `scheduledDate`: 2 a site visit, 1 a meeting. */
  meetingOrSiteVisit: number | null;
  bookedDate: string | null;
  agreementValue: number | null;
  bhKs: number[];
  lowerBudget: number | null;
  upperBudget: number | null;
  notes: string;
  modifiedAt: string;
  archived: boolean;
};

type Status = { id: string; label: string; parentId: string | null; rank: number };

export class FakeCrm {
  apiKey = "fake-api-key-0001";
  secretKey = "fake-secret-key-0001";
  tenant = "acme";
  statuses: Status[] = [];
  projects: { id: string; name: string }[] = [];
  users: { id: string; firstName: string; lastName: string; email: string }[] = [];
  leads = new Map<string, FakeLead>();
  webhooks: { id: string; event: string; callBackUrl: string; secretKey: string }[] = [];
  /** Every request, in order, for assertions: "METHOD /path". */
  log: string[] = [];
  private clock = Date.parse("2026-09-28T04:30:00Z");
  private lose: { method: string; path: RegExp }[] = [];

  constructor() {
    const s = (label: string, rank: number, parentId: string | null = null) => {
      const st = { id: randomUUID(), label, parentId, rank };
      this.statuses.push(st);
      return st;
    };
    const fresh = s("New", 1);
    s("Callback", 2);
    s("Qualified", 3);
    const visit = s("Site Visit Scheduled", 4);
    s("Revisit", 1, visit.id);
    s("Site Visit Done", 5);
    s("Negotiation", 6);
    s("Booked", 7);
    s("Not Interested", 8);
    s("Dropped", 9);
    this.defaultStatus = fresh.id;
    this.projects.push({ id: randomUUID(), name: "Sath Heights Tower C" }, { id: randomUUID(), name: "Other Township" });
    this.users.push({ id: randomUUID(), firstName: "Priya", lastName: "Sales", email: "priya@example.com" });
  }

  defaultStatus: string;

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  statusByLabel(label: string): Status {
    const s = this.statuses.find((x) => x.label === label);
    if (!s) throw new Error(`no status ${label}`);
    return s;
  }

  /** A lead added "in the CRM" by a person there. */
  addLead(p: Partial<FakeLead> & { name: string; contactNo: string }): FakeLead {
    const lead: FakeLead = {
      id: randomUUID(),
      countryCode: "+91",
      email: null,
      statusId: this.defaultStatus,
      projectIds: [],
      assignTo: null,
      scheduledDate: null,
      meetingOrSiteVisit: null,
      bookedDate: null,
      agreementValue: null,
      bhKs: [],
      lowerBudget: null,
      upperBudget: null,
      notes: "",
      archived: false,
      ...p,
      modifiedAt: this.now(),
    };
    this.leads.set(lead.id, lead);
    return lead;
  }

  /** A person in the CRM edits a lead. */
  edit(id: string, patch: Partial<FakeLead>): FakeLead {
    const l = this.leads.get(id)!;
    Object.assign(l, patch, { modifiedAt: this.now() });
    return l;
  }

  /** A person deletes a lead in the CRM. Every read of it finds nothing from now on. */
  remove(id: string): void {
    this.leads.delete(id);
  }

  /** The next matching request does its work and then never answers. */
  loseAnswer(method: string, path: RegExp): void {
    this.lose.push({ method, path });
  }

  private refusals: { method: string; path: RegExp; status: number }[] = [];

  /** The next matching request is refused with this status, and does nothing. */
  refuseNext(method: string, path: RegExp, status: number): void {
    this.refusals.push({ method, path, status });
  }

  /** The body LeadRat would post to a subscribed webhook. */
  hookBody(event: string, lead: FakeLead, eventId = randomUUID()): Record<string, unknown> {
    return { eventId, eventType: event, timeStamp: this.now(), payload: { id: lead.id, name: lead.name, contactNo: lead.contactNo } };
  }

  // ---------------------------------------------------------------------------

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    this.log.push(`${method} ${u.pathname}`);
    const refused = this.refusals.findIndex((r) => r.method === method && r.path.test(u.pathname));
    if (refused >= 0) {
      const r = this.refusals.splice(refused, 1)[0];
      return this.json(r.status, { succeeded: false, message: "Refused by the test.", errors: [], Status: "Error", ExceptionMessage: "Refused by the test." });
    }
    const lost = this.lose.findIndex((l) => l.method === method && l.path.test(u.pathname));
    const answer = this.route(u, method, init);
    if (lost >= 0) {
      this.lose.splice(lost, 1);
      throw new Error("connection reset");
    }
    return answer;
  };

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private route(u: URL, method: string, init: RequestInit): Response {
    if (u.host === "app.sell.do") return this.selldo(u, method, init);
    if (u.host === "connect.leadrat.com") return this.leadrat(u, method, init);
    if (/^api(-[a-z]{2}\d{1,3})?\.leadsquared\.com$/.test(u.host)) return this.leadsquared(u, method, init);
    return this.json(404, { message: "Not found" });
  }

  // --- Sell.Do --------------------------------------------------------------

  selldoKey = "abcdef0123456789abcdef01";
  /** The campaign key each lead arrived under, by lead id. */
  selldoSrds = new Map<string, string>();

  private selldo(u: URL, method: string, init: RequestInit): Response {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const key = method === "GET" ? u.searchParams.get("api_key") : body.api_key;
    if (key !== this.selldoKey) return new Response("API key is incorrect.", { status: 404 });
    if (u.pathname === "/api/leads/phone/retrieve_lead" && method === "GET") {
      const n = (u.searchParams.get("value") ?? "").replace(/^\+?91/, "");
      return this.json(200, { exists: [...this.leads.values()].some((l) => l.contactNo === n) });
    }
    if (u.pathname === "/api/leads/create.json" && method === "POST") {
      const lead = body.sell_do?.form?.lead ?? {};
      const n = String(lead.phone ?? "").replace(/^\+?91/, "");
      if (!n && !lead.email) return this.json(200, { sell_do_lead_id: "", error: ["The email and phone number are not found/valid"] });
      const had = [...this.leads.values()].find((l) => l.contactNo === n);
      const made = had ?? this.addLead({ name: lead.name ?? "Buyer", contactNo: n, email: lead.email ?? null, bhKs: body.sell_do?.form?.requirement?.bhk ?? [] });
      if (!had) this.selldoSrds.set(made.id, body.sell_do?.campaign?.srd ?? "");
      return this.json(200, {
        sell_do_lead_id: made.id,
        sell_do_lead_verified: "false",
        error: [],
        selldo_lead_details: { lead_already_exists: !!had, stage: "incoming", stage_data: { id: "incoming", value: "Incoming" } },
      });
    }
    return this.json(404, { message: "Not found" });
  }

  // --- LeadSquared ----------------------------------------------------------

  accessKey = "u$fakeaccess0001";
  lsqSecret = "fakesecret0001";
  lsqHost = "api-in21.leadsquared.com";
  lsqNotes: { leadId: string; note: string }[] = [];
  lsqHooks: { id: string; url: string; event: string; headers: { Key: string; Value: string }[] }[] = [];

  private leadsquared(u: URL, method: string, init: RequestInit): Response {
    const h = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const p = u.pathname.replace(/^\/v2\//, "");
    const err = (status: number, type: string, message: string) =>
      this.json(status, { Status: "Error", ExceptionType: type, ExceptionMessage: message });
    if (h.get("x-LSQ-AccessKey") !== this.accessKey || h.get("x-LSQ-SecretKey") !== this.lsqSecret) {
      return err(401, "MXUnAuthorizedAccessException", "Unauthorized");
    }
    if (p === "Authentication.svc/UserByAccessKey.Get") {
      return this.json(200, { Id: this.users[0].id, OrgId: "fake-org", LSQCommonServiceURLs: { api: this.lsqHost } });
    }
    if (u.host !== this.lsqHost) {
      return err(401, "MXInvalidAPIHostException", `Invalid API host provided. Please use <${this.lsqHost}> as API host instead of <${u.host}>.`);
    }
    const attrs = (list: { Attribute: string; Value: string }[]) => Object.fromEntries((list ?? []).map((a) => [a.Attribute, a.Value]));
    const stageField = {
      SchemaName: "ProspectStage", DisplayName: "Lead Stage", DataType: "Select", RenderTypeTextValue: "Dropdown",
      Options: this.statuses.filter((s) => !s.parentId).map((s) => ({ Value: s.label })),
    };
    const projectField = {
      SchemaName: "mx_Project", DisplayName: "Project", DataType: "Select", RenderTypeTextValue: "Dropdown",
      Options: this.projects.map((x) => ({ Value: x.name })),
    };
    const cityField = { SchemaName: "mx_City", DisplayName: "City", DataType: "Select", RenderTypeTextValue: "Dropdown", Options: [{ Value: "Mumbai" }] };
    const configField = {
      SchemaName: "mx_Configuration", DisplayName: "Configuration", DataType: "Select", RenderTypeTextValue: "Dropdown",
      Options: [{ Value: "1 BHK" }, { Value: "2 BHK" }, { Value: "3 BHK" }],
    };
    const budgetField = { SchemaName: "mx_Budget", DisplayName: "Budget (Rs)", DataType: "Number", RenderTypeTextValue: "Number", Options: null };
    const remarksField = { SchemaName: "mx_Remarks", DisplayName: "Remarks", DataType: "String", RenderTypeTextValue: "Textbox", Options: null };

    if (p === "LeadManagement.svc/LeadsMetaData.Get") {
      const want = u.searchParams.get("schemaName");
      const all = [stageField, projectField, cityField, configField, budgetField, remarksField];
      return this.json(200, want ? all.filter((f) => f.SchemaName === want) : all);
    }
    if (p === "UserManagement.svc/Users.Get") {
      return this.json(200, this.users.map((x) => ({ ID: x.id, FirstName: x.firstName, LastName: x.lastName, EmailAddress: x.email, StatusCode: 0 })));
    }
    if (p === "LeadManagement.svc/Leads.GetById") {
      const l = this.leads.get(u.searchParams.get("id") ?? "");
      return this.json(200, l && !l.archived ? [this.lsqView(l)] : []);
    }
    if (p === "LeadManagement.svc/RetrieveLeadByPhoneNumber") {
      const want = (u.searchParams.get("phone") ?? "").replace(/^91/, "");
      const found = [...this.leads.values()].filter((l) => !l.archived && l.contactNo === want).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      return this.json(200, found.slice(0, 1).map((l) => this.lsqView(l)));
    }
    if (p === "LeadManagement.svc/Lead.Create" && method === "POST") {
      const a = attrs(body);
      const phone = String(a.Phone ?? "").replace(/^\+91-?/, "");
      if (!phone && !a.EmailAddress) return err(400, "MXMandatoryAttributeMissingException", "Phone or email is mandatory");
      if ([...this.leads.values()].some((l) => !l.archived && l.contactNo === phone)) {
        return err(500, "MXDuplicateEntryException", "A Lead with same Phone Number already exists.");
      }
      const project = this.projects.find((x) => x.name === a.mx_Project);
      const lead = this.addLead({
        name: [a.FirstName, a.LastName].filter(Boolean).join(" "),
        contactNo: phone,
        email: a.EmailAddress ?? null,
        assignTo: a.OwnerId ?? null,
        projectIds: project ? [project.id] : [],
        ...this.lsqCustomIn(a),
      });
      return this.json(200, { Status: "Success", Message: { Id: lead.id } });
    }
    if (p === "LeadManagement.svc/Lead.Update" && method === "POST") {
      const l = this.leads.get(u.searchParams.get("leadId") ?? "");
      if (!l) return err(404, "MXInvalidLeadException", "Lead does not exist");
      const a = attrs(body);
      const stage = a.ProspectStage ? this.statuses.find((s) => s.label === a.ProspectStage) : undefined;
      if (a.ProspectStage && !stage) return err(400, "MXInvalidValueException", "Invalid stage");
      this.edit(l.id, {
        name: a.FirstName !== undefined ? [a.FirstName, a.LastName].filter(Boolean).join(" ") : l.name,
        email: a.EmailAddress ?? l.email,
        statusId: stage?.id ?? l.statusId,
        assignTo: a.OwnerId ?? l.assignTo,
        ...this.lsqCustomIn(a),
      });
      return this.json(200, { Status: "Success", Message: { AffectedRows: 1 } });
    }
    if (p === "LeadManagement.svc/CreateNote" && method === "POST") {
      if (!this.leads.has(body.RelatedProspectId)) return err(404, "MXInvalidLeadException", "Lead does not exist");
      this.lsqNotes.push({ leadId: body.RelatedProspectId, note: body.Note });
      return this.json(200, { Status: "Success", Message: { Id: randomUUID() } });
    }
    if (p === "LeadManagement.svc/Leads.RecentlyModified" && method === "POST") {
      const size = body.Paging?.PageSize ?? 100;
      const page = body.Paging?.PageIndex ?? 1;
      const list = [...this.leads.values()].filter((l) => !l.archived).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      const slice = list.slice((page - 1) * size, page * size);
      return this.json(200, {
        RecordCount: list.length,
        Leads: slice.map((l) => ({ LeadPropertyList: Object.entries(this.lsqView(l)).map(([Attribute, Value]) => ({ Attribute, Value, Fields: null })) })),
      });
    }
    if (p === "Webhook.svc/Create" && method === "POST") {
      const w = { id: randomUUID(), url: body.URL, event: body.WebhookEvent, headers: body.CustomHeaders ?? [] };
      this.lsqHooks.push(w);
      return this.json(200, { Status: "Success", Message: { Id: w.id } });
    }
    if (p === "Webhook.svc/Delete" && method === "POST") {
      this.lsqHooks = this.lsqHooks.filter((w) => w.id !== u.searchParams.get("webhookId"));
      return this.json(200, { Status: "Success", Message: { AffectedRows: 1 } });
    }
    return err(404, "MXNotFoundException", "Not found");
  }

  /** A lead as LeadSquared returns it: strings, and the project in its custom field. */
  lsqView(l: FakeLead): Record<string, string | null> {
    const st = this.statuses.find((s) => s.id === l.statusId)!;
    const base = st.parentId ? this.statuses.find((s) => s.id === st.parentId)! : st;
    const [first, ...rest] = l.name.split(" ");
    return {
      ProspectID: l.id,
      FirstName: first ?? null,
      LastName: rest.join(" ") || null,
      EmailAddress: l.email,
      Phone: `+91-${l.contactNo}`,
      Mobile: null,
      ProspectStage: base.label,
      OwnerId: l.assignTo,
      Source: "Website",
      mx_Project: this.projects.find((x) => x.id === l.projectIds[0])?.name ?? null,
      mx_Configuration: l.bhKs.length === 1 ? `${l.bhKs[0]} BHK` : null,
      mx_Budget: l.lowerBudget && l.upperBudget ? String(Math.round((l.lowerBudget + l.upperBudget) / 2)) : l.upperBudget ? String(l.upperBudget) : null,
      ModifiedOn: l.modifiedAt.replace("T", " ").replace("Z", ""),
    };
  }

  /** The configuration and budget fields, as a write to LeadSquared sets them. */
  private lsqCustomIn(a: Record<string, string>): Partial<FakeLead> {
    const out: Partial<FakeLead> = {};
    const bhk = /^(\d+(?:\.5)?) BHK$/.exec(a.mx_Configuration ?? "");
    if (bhk) out.bhKs = [Number(bhk[1])];
    if (a.mx_Budget && Number.isFinite(Number(a.mx_Budget))) {
      out.lowerBudget = Number(a.mx_Budget);
      out.upperBudget = Number(a.mx_Budget);
    }
    return out;
  }

  /** The body LeadSquared posts for an update: the lead before and after. */
  lsqHookBody(before: Record<string, string | null>, lead: FakeLead): Record<string, unknown> {
    return { Before: before, After: this.lsqView(lead) };
  }

  // --- LeadRat --------------------------------------------------------------

  private tokens = new Set<string>();

  private leadrat(u: URL, method: string, init: RequestInit): Response {
    const h = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const p = u.pathname;
    const ok = (data: unknown) => this.json(200, { succeeded: true, message: "", errors: [], data });
    const paged = (items: unknown[]) => {
      const page = Number(u.searchParams.get("PageNumber") ?? 1);
      const size = Number(u.searchParams.get("PageSize") ?? 10);
      const slice = items.slice((page - 1) * size, page * size);
      return this.json(200, { succeeded: true, message: "", errors: [], data: null, items: slice, itemsCount: slice.length, totalCount: items.length });
    };

    if (h.get("tenant") !== this.tenant) return this.json(400, { succeeded: false, message: "Invalid tenant", errors: [] });
    if (p === "/api/v1/authentication/token" && method === "POST") {
      if (body.apiKey !== this.apiKey || body.secretKey !== this.secretKey) {
        return this.json(401, { succeeded: false, message: "Invalid credentials", errors: [] });
      }
      const t = randomUUID();
      this.tokens.add(t);
      return ok({ accessToken: t, tokenType: "Bearer", expiresIn: 3600 });
    }
    const bearer = (h.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!this.tokens.has(bearer)) return this.json(401, { succeeded: false, message: "Unauthorized", errors: [] });

    if (p === "/api/v1/lead/status" && method === "GET") {
      const bases = this.statuses.filter((s) => !s.parentId);
      return paged(bases.map((b) => ({
        id: b.id, baseId: null, level: 0, status: b.label.toLowerCase(), displayName: b.label, actionName: b.label, orderRank: b.rank,
        childTypes: this.statuses.filter((c) => c.parentId === b.id).map((c) => ({
          id: c.id, baseId: b.id, level: 1, status: c.label.toLowerCase(), displayName: c.label, orderRank: c.rank, childTypes: [],
        })),
      })));
    }
    if (p === "/api/v1/project/all" && method === "GET") return paged(this.projects.map((x) => ({ id: x.id, name: x.name })));
    if (p === "/api/v1/user" && method === "GET") {
      return paged(this.users.map((x) => [{ userId: x.id, firstName: x.firstName, lastName: x.lastName, email: x.email, isActive: true }, { createdOn: this.now() }]));
    }
    if (p === "/api/v1/webhook" && method === "GET") return paged(this.webhooks);
    if (p === "/api/v1/webhook" && method === "POST") {
      const w = { id: randomUUID(), event: body.event, callBackUrl: body.callBackUrl, secretKey: body.secretKey };
      this.webhooks.push(w);
      return ok({ id: w.id, event: w.event });
    }
    const hook = /^\/api\/v1\/webhook\/([^/]+)$/.exec(p);
    if (hook && method === "DELETE") {
      this.webhooks = this.webhooks.filter((w) => w.id !== hook[1]);
      return ok(hook[1]);
    }

    if (p === "/api/v1/lead" && method === "GET") {
      let list = [...this.leads.values()].filter((l) => !l.archived);
      const q = u.searchParams.get("SearchByNameOrNumber");
      if (q) list = list.filter((l) => l.contactNo.includes(q) || l.name.toLowerCase().includes(q.toLowerCase()));
      if (u.searchParams.get("OrderCriteria") === "modifiedDate") {
        list.sort((a, b) => (u.searchParams.get("Sort") === "asc" ? 1 : -1) * a.modifiedAt.localeCompare(b.modifiedAt));
      }
      return paged(list.map((l) => this.leadratView(l, false)));
    }
    if (p === "/api/v1/lead" && method === "POST") {
      if (!body.name || !body.contactNo) return this.json(400, { succeeded: false, message: "Name and number are required", errors: [] });
      const names: string[] = body.projectsList ?? [];
      const lead = this.addLead({
        name: body.name,
        contactNo: body.contactNo,
        countryCode: body.countryCode ?? "+91",
        email: body.email ?? null,
        assignTo: body.assignTo ?? null,
        projectIds: this.projects.filter((x) => names.includes(x.name)).map((x) => x.id),
        bhKs: body.enquiry?.bhKs ?? [],
        lowerBudget: body.enquiry?.lowerBudget ?? null,
        upperBudget: body.enquiry?.upperBudget ?? null,
      });
      return ok(lead.id);
    }
    const one = /^\/api\/v1\/lead\/([^/]+)$/.exec(p);
    if (one && method === "GET") {
      const l = this.leads.get(one[1]);
      return l ? ok(this.leadratView(l, true)) : this.json(404, { succeeded: false, message: "Lead not found", errors: [] });
    }
    if (one && method === "PUT") {
      const l = this.leads.get(one[1]);
      if (!l) return this.json(404, { succeeded: false, message: "Lead not found", errors: [] });
      this.edit(l.id, {
        name: body.name ?? l.name,
        email: body.email ?? l.email,
        bhKs: body.enquiry?.bhKs ?? l.bhKs,
        lowerBudget: body.enquiry?.lowerBudget ?? l.lowerBudget,
        upperBudget: body.enquiry?.upperBudget ?? l.upperBudget,
      });
      return ok(l.id);
    }
    const status = /^\/api\/v1\/lead\/status\/([^/]+)$/.exec(p);
    if (status && method === "PUT") {
      const l = this.leads.get(status[1]);
      if (!l) return this.json(404, { succeeded: false, message: "Lead not found", errors: [] });
      if (!this.statuses.some((s) => s.id === body.leadStatusId)) return this.json(400, { succeeded: false, message: "Unknown status", errors: [] });
      this.edit(l.id, {
        statusId: body.leadStatusId,
        scheduledDate: body.scheduledDate ?? l.scheduledDate,
        meetingOrSiteVisit: body.meetingOrSiteVisit ?? l.meetingOrSiteVisit,
        bookedDate: body.bookedDate ?? l.bookedDate,
        agreementValue: body.agreementValue ?? l.agreementValue,
        projectIds: body.projectIds?.length ? body.projectIds : l.projectIds,
      });
      return ok(l.id);
    }
    const assign = /^\/api\/v1\/lead\/assign\/([^/]+)$/.exec(p);
    if (assign && method === "PUT") {
      const l = this.leads.get(assign[1]);
      if (!l) return this.json(404, { succeeded: false, message: "Lead not found", errors: [] });
      this.edit(l.id, { assignTo: body.assignToUserId });
      return ok(l.id);
    }
    const notes = /^\/api\/v1\/lead\/notes\/([^/]+)$/.exec(p);
    if (notes && method === "PUT") {
      const l = this.leads.get(notes[1]);
      if (!l) return this.json(404, { succeeded: false, message: "Lead not found", errors: [] });
      this.edit(l.id, { notes: body.notes ?? "" });
      return ok(l.id);
    }
    return this.json(404, { succeeded: false, message: "Not found", errors: [] });
  }

  private leadratView(l: FakeLead, detail: boolean): Record<string, unknown> {
    const st = this.statuses.find((s) => s.id === l.statusId)!;
    const parent = st.parentId ? this.statuses.find((s) => s.id === st.parentId)! : null;
    const statusObj = parent
      ? { id: parent.id, displayName: parent.label, childType: { id: st.id, displayName: st.label } }
      : { id: st.id, displayName: st.label, childType: null };
    const base: Record<string, unknown> = {
      id: l.id,
      name: l.name,
      contactNo: l.contactNo,
      countryCode: l.countryCode,
      email: l.email,
      assignTo: l.assignTo,
      scheduledDate: l.scheduledDate,
      meetingOrSiteVisit: l.meetingOrSiteVisit,
      isArchived: l.archived,
      status: statusObj,
      enquiry: { bhKs: l.bhKs, lowerBudget: l.lowerBudget, upperBudget: l.upperBudget, leadSource: "direct" },
    };
    if (!detail) return base;
    return {
      ...base,
      notes: l.notes,
      bookedDate: l.bookedDate,
      soldPrice: l.agreementValue === null ? null : String(l.agreementValue),
      projects: l.projectIds.map((id) => ({ id, name: this.projects.find((x) => x.id === id)?.name ?? null })),
      lastModifiedOn: l.modifiedAt,
    };
  }
}

let shared: FakeCrm | null = null;

/** The one fake the dev server answers from while `CRM_FAKE` is on. */
export function devFake(): (url: string, init: RequestInit) => Promise<Response> {
  shared ??= new FakeCrm();
  return shared.fetch;
}
