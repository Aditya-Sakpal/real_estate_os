/**
 * The seam every state RERA portal answers through.
 *
 * No authority publishes an API. Each publishes pages, and the design is the
 * one Maharashtra's adapter proved: **a per-number lookup at the form, and
 * bulk reads in the nightly job.** Asking one portal about every
 * registration every night is thousands of requests to one government
 * server, enough to earn a block; reading what the authority already
 * publishes whole is a fixed handful however many clients there are.
 *
 * An adapter per state lives in `rera-<state>.ts` and is registered in
 * `rera-states.ts`. This file holds what they share:
 *
 *   - the verdicts, which have three answers and never two: found, not
 *     found, and could not tell. "Not found" and "the portal was down" are
 *     different facts, and collapsing them is how a government website
 *     having a bad evening turns into a blocked campaign;
 *   - `portalRequest()`, the only way an adapter reaches a portal: an honest
 *     user agent, a timeout, requests to one host spaced out, and the dev
 *     seam;
 *   - the day's copy of each bulk read, shared by the form and the sweep.
 *
 * **The dev seam.** `RERA_<STATE>_FIXTURES` names a folder of captured
 * responses, one file per request, named by the adapter. It keeps the checks
 * deterministic, offline and off a government server. Two rules make it safe:
 * a request with no file falls through to the real portal (a missing file
 * treated as "not found" would refuse every real registration on a
 * developer's machine), and an injected `fetchImpl` beats the folder, so a
 * test that supplies its own transport is never quietly served a file. A
 * file named `<name>.down` answers as an unreachable portal. Never set in
 * production. The checks set it in their own process, not in `.env.local`,
 * because a folder holding a four-row register would block every real
 * registration the dev server's own sweep read.
 *
 * Imports are relative so the nightly job can load this straight from
 * source, outside Next, where the `@/` alias does not resolve.
 */

// ---------------------------------------------------------------------------
// What an authority says about a project
// ---------------------------------------------------------------------------

/**
 * The authority's own word for where a registration stands. Only a definite
 * statement is anything other than REGISTERED: a status column saying
 * "Ongoing" is not a lapse, and a date in the past on a list that ignores
 * extensions is not either.
 */
export type AuthorityStatus = "REGISTERED" | "LAPSED" | "REVOKED" | "SUSPENDED" | "WITHDRAWN";

export type PortalProject = {
  /** As the authority prints it. */
  registrationNo: string;
  projectName?: string;
  /** Absent when the source does not carry one; never guessed. */
  promoterName?: string;
  status: AuthorityStatus;
  /** YYYY-MM-DD: the latest completion date the source shows. */
  validTo?: string;
  /** YYYY-MM-DD: when the authority registered it. */
  registeredOn?: string;
  /** The authority's own id for the project, where it has one. */
  portalRef?: string;
};

/** What the form is told about one number. */
export type FormVerdict =
  | { known: true; found: true; project: PortalProject }
  | { known: true; found: false }
  | { known: false; reason: string };

/** What the nightly job read, once, for every tenant. */
export type NightlyRead = {
  /**
   * Every project the authority lists, keyed by `keyOf()`. Only when the
   * source is the whole register, because absence from it is the finding
   * "never issued, or removed". Null when the state publishes no register.
   */
  register: Map<string, PortalProject> | null;
  /**
   * Projects the authority says are revoked, lapsed, suspended or
   * withdrawn, keyed the same way. Definite findings only.
   */
  blocked: Map<string, PortalProject>;
  /** Requests it took, for the report. */
  requests: number;
};

export type NightlyResult = { ok: true; read: NightlyRead } | { ok: false; reason: string };

export type PortalCtx = {
  /**
   * Injected by the checks. Beats the fixture folder, so a test that brings
   * its own transport is never quietly served a file instead.
   */
  fetchImpl?: typeof fetch;
};

export type StateAdapter = {
  /** "KA" */
  state: string;
  /** How two spellings of one number compare. */
  keyOf(registrationNo: string): string;
  /** At the form, while a person waits. Asked about one number. */
  atForm(registrationNo: string, ctx: PortalCtx): Promise<FormVerdict>;
  /**
   * The nightly read: a fixed number of requests for every tenant together,
   * never one per registration. Absent for a state that publishes nothing
   * that can be read in bulk; its registrations are then checked by date.
   */
  nightly?(ctx: PortalCtx): Promise<NightlyResult>;
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const ADAPTERS = new Map<string, StateAdapter>();

export function registerAdapter(adapter: StateAdapter): void {
  ADAPTERS.set(adapter.state.toUpperCase(), adapter);
}

export function adapterFor(stateCode: string | null | undefined): StateAdapter | null {
  return stateCode ? ADAPTERS.get(stateCode.toUpperCase()) ?? null : null;
}

export function hasAdapter(stateCode: string | null): boolean {
  return !!adapterFor(stateCode);
}

/** States with a nightly bulk read. */
export function nightlyStates(): string[] {
  return [...ADAPTERS.values()].filter((a) => !!a.nightly).map((a) => a.state);
}

/**
 * Ask the state's portal about one number, at the form.
 *
 * A state with no adapter, or an adapter that throws, is "could not tell":
 * the record is kept as attested and nothing claims a machine looked.
 */
export async function lookupAtForm(
  stateCode: string | null,
  registrationNo: string | null,
  ctx: PortalCtx = {},
): Promise<FormVerdict> {
  if (!stateCode || !registrationNo) return { known: false, reason: "No registration number recorded." };
  const adapter = adapterFor(stateCode);
  if (!adapter) return { known: false, reason: `No portal adapter for ${stateCode.toUpperCase()}.` };
  try {
    return await adapter.atForm(registrationNo, ctx);
  } catch (e) {
    // A portal being down is not a compliance failure. It is an unknown, and
    // an unknown must not refuse a lawful registration.
    return { known: false, reason: `Portal lookup failed: ${(e as Error).message}`.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Reaching a portal
// ---------------------------------------------------------------------------

/**
 * The user agent every adapter sends. Honest, with a way to reach us, so a
 * portal's operator who sees our traffic knows whose it is.
 */
export const PORTAL_UA = "Sales Desk compliance check (+https://salesdesk.app)";

/** Requests to one host are at least this far apart. */
export const PORTAL_SPACING_MS = 800;

const lastAt = new Map<string, Promise<void>>();

/**
 * Wait for this host's turn. Requests to one portal go one at a time and
 * never closer than `PORTAL_SPACING_MS`, whoever asks: two forms submitted at
 * once and the nightly job share the queue.
 */
async function pace(host: string): Promise<void> {
  const prev = lastAt.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  lastAt.set(host, prev.then(() => mine));
  await prev;
  setTimeout(release, PORTAL_SPACING_MS);
}

export type PortalRequest = {
  /**
   * The fixture file this request is answered from under the dev seam. The
   * adapter names it: `register.html`, `search_<number>.html`.
   */
  name: string;
  url: string;
  method?: "GET" | "POST";
  body?: string | URLSearchParams;
  headers?: Record<string, string>;
  /** Default 30 s; a bulk read of several megabytes wants longer. */
  timeoutMs?: number;
  /** Stop at a redirect rather than follow it (a session bounced to a login). */
  manualRedirect?: boolean;
  /**
   * The host still negotiates TLS the old way (GujRERA does), which Node's
   * fetch refuses outright. Only for a host that needs it: the request goes
   * through `node:https` with legacy renegotiation allowed, and nothing else
   * about it changes.
   */
  legacyTls?: boolean;
};

export type PortalResponse = {
  ok: true;
  status: number;
  text: string;
  /** Set-Cookie values, for an adapter that primes a session. */
  cookies: string[];
  location: string | null;
  /** Answered from the fixture folder, not the portal. */
  fixture: boolean;
};

export type PortalFailure = { ok: false; reason: string };

/** A fixture name, safe as a file name. */
export function fixtureName(...parts: string[]): string {
  return parts
    .join("_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

function fixtureDir(state: string): string | null {
  return process.env[`RERA_${state.toUpperCase()}_FIXTURES`]?.trim() || null;
}

async function fromFixture(
  dir: string,
  name: string,
): Promise<PortalResponse | PortalFailure | null> {
  const { readFile, access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const safe = fixtureName(name);
  try {
    await access(join(dir, `${safe}.down`));
    return { ok: false, reason: `${safe}: the portal did not answer (fixture)` };
  } catch {
    // Not marked down.
  }
  try {
    const text = await readFile(join(dir, safe), "utf8");
    return { ok: true, status: 200, text, cookies: [], location: null, fixture: true };
  } catch {
    // Not a request this folder has an opinion about. Ask the authority.
    return null;
  }
}

/**
 * The only way an adapter reaches a portal.
 *
 * Never throws: a network error, a timeout and a 5xx are all "could not
 * tell", returned as a reason, and the adapter decides nothing on them. A
 * 4xx other than a missing page is returned as an answer, because a portal
 * refusing a request is something the adapter has to read.
 */
export async function portalRequest(
  state: string,
  req: PortalRequest,
  ctx: PortalCtx = {},
): Promise<PortalResponse | PortalFailure> {
  const dir = fixtureDir(state);
  if (!ctx.fetchImpl && dir) {
    const canned = await fromFixture(dir, req.name);
    if (canned) return canned;
  }

  const go = ctx.fetchImpl ?? fetch;
  let host = "";
  try {
    host = new URL(req.url).host;
  } catch {
    return { ok: false, reason: `not a URL: ${req.url}` };
  }
  // An injected transport is a test, and a test has no host to be polite to.
  if (!ctx.fetchImpl) await pace(host);

  if (req.legacyTls && !ctx.fetchImpl) return legacyRequest(req, host);

  try {
    const res = await go(req.url, {
      method: req.method ?? "GET",
      headers: { "user-agent": PORTAL_UA, "accept-encoding": "gzip, deflate", ...(req.headers ?? {}) },
      body: req.body,
      redirect: req.manualRedirect ? "manual" : "follow",
      signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
    });
    if (res.status >= 500) return { ok: false, reason: `${host} answered ${res.status}` };
    const text = await res.text();
    return {
      ok: true,
      status: res.status,
      text,
      cookies: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]),
      location: res.headers.get("location"),
      fixture: false,
    };
  } catch (e) {
    return { ok: false, reason: `${host} unreachable: ${(e as Error).message}`.slice(0, 200) };
  }
}

/** One request over `node:https`, for a host whose TLS Node's fetch refuses. */
async function legacyRequest(req: PortalRequest, host: string): Promise<PortalResponse | PortalFailure> {
  const https = await import("node:https");
  const { constants } = await import("node:crypto");
  const zlib = await import("node:zlib");
  const body = req.body === undefined ? undefined : String(req.body);
  return new Promise((resolve) => {
    const r = https.request(
      req.url,
      {
        method: req.method ?? "GET",
        headers: {
          "user-agent": PORTAL_UA,
          "accept-encoding": "gzip, deflate",
          ...(body !== undefined ? { "content-length": Buffer.byteLength(body).toString() } : {}),
          ...(req.headers ?? {}),
        },
        secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
        timeout: req.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 500) return resolve({ ok: false, reason: `${host} answered ${status}` });
          let raw: Buffer = Buffer.concat(chunks);
          try {
            const enc = String(res.headers["content-encoding"] ?? "");
            if (enc.includes("gzip")) raw = zlib.gunzipSync(raw);
            else if (enc.includes("deflate")) raw = zlib.inflateSync(raw);
          } catch (e) {
            return resolve({ ok: false, reason: `${host} sent a body that would not decode: ${(e as Error).message}` });
          }
          const set = res.headers["set-cookie"] ?? [];
          resolve({
            ok: true,
            status,
            text: raw.toString("utf8"),
            cookies: set.map((c) => c.split(";")[0]),
            location: typeof res.headers.location === "string" ? res.headers.location : null,
            fixture: false,
          });
        });
        res.on("error", (e) => resolve({ ok: false, reason: `${host} unreachable: ${e.message}`.slice(0, 200) }));
      },
    );
    r.on("timeout", () => r.destroy(new Error("timed out")));
    r.on("error", (e) => resolve({ ok: false, reason: `${host} unreachable: ${e.message}`.slice(0, 200) }));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

/**
 * The floor a bulk read must clear before it is believed. A register that
 * parses to a handful of rows is a changed page, not a shrunken register,
 * and trusting it would block every real registration at once (or, for a
 * revocation list, clear every real revocation). A fixture is ours and
 * cannot change shape, so it carries a token floor of one.
 */
export function plausible(rows: number, floor: number, fixture: boolean): boolean {
  return rows >= (fixture ? 1 : floor);
}

// ---------------------------------------------------------------------------
// The day's copy of each bulk read
// ---------------------------------------------------------------------------

/**
 * One copy a day per state, shared by the form and the sweep. The sweep's
 * process is new every night, so its cache is always cold and it always
 * reads fresh; the form reuses the copy while it is under a day old, so a
 * state whose form check reads the register costs a person nothing after
 * the first number of the day. A copy is only ever kept when it was read in
 * full and passed its floor.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; read: NightlyRead }>();

/**
 * A bulk read through the day's copy. An adapter whose form check answers
 * from its register calls this with the same reader its `nightly` uses, so
 * the form and the sweep share one copy and one set of requests.
 */
export async function sharedRead(
  state: string,
  reader: () => Promise<NightlyResult>,
  ctx: PortalCtx = {},
  now = Date.now(),
): Promise<NightlyResult> {
  // An injected transport is a test asking a particular question; it never
  // reads or writes the shared copy.
  const key = state.toUpperCase();
  const held = ctx.fetchImpl ? null : cache.get(key);
  if (held && now - held.at < DAY_MS) return { ok: true, read: held.read };
  let result: NightlyResult;
  try {
    result = await reader();
  } catch (e) {
    result = { ok: false, reason: `${key} bulk read failed: ${(e as Error).message}`.slice(0, 200) };
  }
  if (result.ok && !ctx.fetchImpl) cache.set(key, { at: now, read: result.read });
  return result;
}

export async function nightlyRead(
  stateCode: string,
  ctx: PortalCtx = {},
  now = Date.now(),
): Promise<NightlyResult> {
  const adapter = adapterFor(stateCode);
  const nightly = adapter?.nightly;
  if (!adapter || !nightly) return { ok: false, reason: `${stateCode} publishes nothing to read in bulk.` };
  return sharedRead(adapter.state, () => nightly(ctx), ctx, now);
}

/** Drop every held copy. For the checks, which must not inherit a real read. */
export function resetPortalCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Small readers the adapters share
// ---------------------------------------------------------------------------

/** HTML to text: tags out, entities decoded, whitespace collapsed. */
export function htmlText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every row of every table, as cell text. */
export function tableRows(html: string): string[][] {
  const out: string[][] = [];
  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(htmlText);
    if (cells.length) out.push(cells);
  }
  return out;
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * A date as a portal writes it, to YYYY-MM-DD, or null. Day first, because
 * every Indian portal writes it that way: 31/12/2030, 31-12-2030,
 * 31.12.2030, 31-Dec-2030, 31 December 2030, and ISO 2030-12-31.
 */
export function portalDate(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return valid(+iso[1], +iso[2], +iso[3]);
  const num = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (num) return valid(+num[3], +num[2], +num[1]);
  const named = s.match(/\b(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})\b/);
  if (named) {
    const m = MONTHS[named[2].slice(0, named[2].toUpperCase().startsWith("SEPT") ? 4 : 3).toUpperCase()];
    if (m) return valid(+named[3], m, +named[1]);
  }
  return null;
}

function valid(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}
