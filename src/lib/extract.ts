import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTenant, audit } from "./db/index.ts";
import { brainNode, inheritedBrain, openDraft, type BrainNode } from "./brain.ts";
import {
  asList,
  fieldByKey,
  normaliseRegistration,
  parseValue,
  withInherited,
  type FieldValues,
} from "./brain-rules.ts";
import {
  acceptRefusal,
  chunkPages,
  docKindDef,
  EXTRACT_MODEL,
  EXTRACTORS,
  extractRequest,
  extractUsd,
  fieldsToRead,
  flagsFor,
  MAX_ATTEMPTS,
  MAX_RUN_USD,
  MAX_RUNS_PER_DOCUMENT,
  MAX_PROJECT_MONTH_USD,
  VISION_PAGE_USD,
  mergeReads,
  pagesProblem,
  planProposals,
  readAnswer,
  reviewOrder,
  runRefusal,
  sameValue,
  sniffType,
  unitChecks,
  uploadProblem,
  usdToRupees,
  worstUsd,
  type Box,
  type DocKind,
  type DocLayout,
  type DocType,
  type ExtractRequest,
  type Filing,
  type Flag,
  type FoundUnit,
  type PageText,
  type Pending,
  type ReadResult,
  type UnitCheck,
} from "./extract-rules.ts";
import { classifyRefusal } from "./service-rules.ts";
import { assetKey, sha256, storage } from "./storage.ts";
import { projectOfNode } from "./storage-place.ts";
import { loadUnits } from "./unit.ts";
import { entitle } from "./billing.ts";
import { certificateDates } from "./rera-mh-search.ts";
import { MAX_FIRM_MONTH_USD } from "./billing-rules.ts";

/**
 * Reading the Project Brain out of a developer's documents: the upload, the
 * reading, what it does to the draft, and the person's decision on each
 * value. `extract-rules.ts` decides; this reads and writes.
 *
 * The file goes straight from the browser to the store (a presigned PUT on
 * S3), because a request body through a hosted function is capped far below
 * a brochure, and it is checked when it lands: its hash, its type, its page
 * count. Reading is a job, claimed under a lease, started at once in the
 * background and finished by `npm run extract:run` if the request that
 * started it died.
 */

// ---------------------------------------------------------------------------
// The model, behind a seam
// ---------------------------------------------------------------------------

export type ExtractAnswer =
  | { ok: true; value: unknown; modelVersion: string; tokensIn: number; tokensOut: number }
  | { ok: false; code: string; message: string; retry: boolean; tokensIn?: number; tokensOut?: number };

export type ExtractDriver = (req: ExtractRequest, opts?: { signal?: AbortSignal }) => Promise<ExtractAnswer>;

let injected: ExtractDriver | null = null;

/** For the checks. An injected driver beats `MODELS_DIR` and the network. */
export function useExtractDriver(d: ExtractDriver | null): void {
  injected = d;
}

/** The name a canned answer is filed under in `MODELS_DIR`. */
export function extractRequestId(req: ExtractRequest): string {
  return createHash("sha256").update(JSON.stringify(req)).digest("hex").slice(0, 16);
}

export const EXTRACT_TIMEOUT_MS = 180_000;

async function race<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `gpt-5-mini` over the chat completions API with a strict JSON schema, at
 * low reasoning and with the output capped, because output is the dear half
 * of the price. `MODELS_DIR` (a dev and test seam, never in production)
 * serves `extract_<id>.json` for a request with that hash instead.
 */
const openAiExtract: ExtractDriver = async (req) => {
  const dir = (process.env.MODELS_DIR ?? "").trim();
  if (dir) {
    const raw = await readFile(join(dir, `extract_${extractRequestId(req)}.json`), "utf8").catch(() => null);
    if (raw !== null) {
      const f = JSON.parse(raw) as { value: unknown; modelVersion?: string; tokensIn?: number; tokensOut?: number };
      return { ok: true, value: f.value, modelVersion: f.modelVersion ?? `${req.model} (fixture)`, tokensIn: f.tokensIn ?? 0, tokensOut: f.tokensOut ?? 0 };
    }
  }
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return { ok: false, code: "NO_KEY", message: "Reading documents is not switched on.", retry: false };
  const body = {
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    reasoning_effort: "low",
    max_completion_tokens: req.maxOutputTokens,
    response_format: { type: "json_schema", json_schema: { name: req.name, strict: true, schema: req.schema } },
  };
  const answer = await race(EXTRACT_TIMEOUT_MS, async (signal) => {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error(`extract: the model refused (${r.status}):`, text.replace(/\s+/g, " ").slice(0, 300));
      const c = classifyRefusal(r.status, text);
      return { ok: false as const, code: c.code, message: c.message, retry: c.code === "AI_BUSY" || c.code === "AI_UNAVAILABLE" };
    }
    return {
      ok: true as const,
      json: (await r.json()) as {
        model?: string;
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      },
    };
  }).catch(() => null);
  if (!answer) return { ok: false, code: "AI_UNAVAILABLE", message: "The reader did not answer in time.", retry: true };
  if (!answer.ok) return answer;
  const tokensIn = answer.json.usage?.prompt_tokens ?? 0;
  const tokensOut = answer.json.usage?.completion_tokens ?? 0;
  const text = answer.json.choices?.[0]?.message?.content ?? "";
  try {
    return { ok: true, value: JSON.parse(text) as unknown, modelVersion: answer.json.model ?? req.model, tokensIn, tokensOut };
  } catch {
    // Paid for all the same, so the meter still hears about it.
    return { ok: false, code: "UNPARSED", message: "The reader answered out of shape.", retry: true, tokensIn, tokensOut };
  }
};

const driver = (): ExtractDriver => injected ?? openAiExtract;

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

export type Where = { node: BrainNode };

/**
 * The store's key for a document: its own hash, under its tenant and the
 * project it is filed on (a document is filed on a project or a tower,
 * never higher).
 */
export function documentKey(orgId: string, project: string | null, sha: string): string | null {
  return assetKey({ orgId, project, kind: "doc", id: sha });
}

function uploadSecret(): string {
  const root = process.env.AUTH_SECRET;
  if (!root) throw new Error("AUTH_SECRET is not set.");
  return createHmac("sha256", root).update("salesdesk:brain-document-upload").digest("hex");
}

/**
 * A token for the local store's upload route, which exists only where there
 * is no bucket to presign against (a development machine). It names the one
 * key, the type and a ten-minute expiry, and is useless for anything else.
 */
export function uploadToken(key: string, type: string, expires: number): string {
  const body = Buffer.from(JSON.stringify({ k: key, t: type, e: expires })).toString("base64url");
  const mac = createHmac("sha256", uploadSecret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readUploadToken(token: string): { key: string; type: string } | null {
  const [body, mac] = String(token ?? "").split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", uploadSecret()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const j = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { k: string; t: string; e: number };
    if (!j.k || !j.t || !(j.e > Date.now())) return null;
    return { key: j.k, type: j.t };
  } catch {
    return null;
  }
}

export const UPLOAD_SECONDS = 600;

export type Begun =
  | { state: "upload"; url: string; headers: Record<string, string> }
  | { state: "exists"; documentId: string; message: string }
  | { state: "refused"; message: string };

/**
 * Before a byte is sent: may this file be uploaded here, and where to. The
 * same bytes already filed is answered at once and nothing is sent, because
 * the hash is the file's name.
 */
export async function beginUpload(opts: {
  orgId: string;
  node: BrainNode;
  kind: unknown;
  type: unknown;
  size: unknown;
  sha256: unknown;
  origin: string;
}): Promise<Begun> {
  const check = uploadProblem({ kind: opts.kind, type: opts.type, size: opts.size, sha256: opts.sha256, nodeKind: opts.node.kind, exempt: opts.node.exempt });
  if (!check.ok) return { state: "refused", message: check.message };
  const existing = await findBySha(opts.orgId, check.sha256);
  if (existing) {
    return {
      state: "exists",
      documentId: existing.id,
      message:
        existing.scope_node_id === opts.node.id
          ? `This file is already here, as ${existing.name}.`
          : `This file is already filed under ${existing.node_name}.`,
    };
  }
  const key = documentKey(opts.orgId, await projectOfNode(opts.orgId, opts.node.id), check.sha256);
  if (!key) return { state: "refused", message: "That file cannot be stored." };
  const store = storage();
  if (store.uploadUrl) {
    const url = await store.uploadUrl(key, UPLOAD_SECONDS, check.type).catch(() => null);
    if (!url) return { state: "refused", message: "Uploads are not available right now. Try again in a minute." };
    return { state: "upload", url, headers: { "content-type": check.type } };
  }
  const token = uploadToken(key, check.type, Date.now() + UPLOAD_SECONDS * 1000);
  return {
    state: "upload",
    url: `${opts.origin}/dashboard/brain/${opts.node.id}/documents/upload?t=${encodeURIComponent(token)}`,
    headers: { "content-type": check.type },
  };
}

async function findBySha(orgId: string, sha: string) {
  const [row] = await withTenant(orgId, (sql) => sql<{ id: string; scope_node_id: string; name: string; node_name: string }[]>`
    SELECT d.id, d.scope_node_id, d.name, n.name AS node_name
    FROM brain_documents d JOIN scope_nodes n ON n.id = d.scope_node_id
    WHERE d.org_id = ${orgId} AND d.sha256 = ${sha}
  `);
  return row ?? null;
}

export type Finished =
  | { ok: true; documentId: string; extractionId: string | null; message: string }
  | { ok: false; message: string };

/**
 * The file has landed: check it is what was promised, count its pages, file
 * it, and queue its reading. A file that fails any check is taken back out
 * of the store, so a refused upload leaves nothing behind.
 */
export async function finishUpload(opts: {
  orgId: string;
  userId: string;
  node: BrainNode;
  kind: unknown;
  name: string;
  type: unknown;
  size: unknown;
  sha256: unknown;
}): Promise<Finished> {
  const check = uploadProblem({ kind: opts.kind, type: opts.type, size: opts.size, sha256: opts.sha256, nodeKind: opts.node.kind, exempt: opts.node.exempt });
  if (!check.ok) return { ok: false, message: check.message };
  const existing = await findBySha(opts.orgId, check.sha256);
  if (existing) return { ok: true, documentId: existing.id, extractionId: null, message: "This file was already here." };

  const key = documentKey(opts.orgId, await projectOfNode(opts.orgId, opts.node.id), check.sha256)!;
  const bytes = await storage().read(key);
  const refuse = async (message: string): Promise<Finished> => {
    await storage().remove(key).catch(() => {});
    return { ok: false, message };
  };
  if (!bytes) return { ok: false, message: "The file did not arrive. Upload it again." };
  if (sha256(bytes) !== check.sha256) return refuse("The file changed on the way. Upload it again.");
  if (bytes.byteLength > check.size || bytes.byteLength <= 0) return refuse("The file changed on the way. Upload it again.");
  const sniffed = sniffType(bytes);
  if (!sniffed) return refuse("That is not a PDF or a picture this can read.");
  const { inspectDocument } = await import("./pdf-read.ts");
  const inspected = await inspectDocument(bytes, sniffed);
  if (!inspected.ok) return refuse(inspected.message);
  const tooLong = pagesProblem(check.kind, inspected.pages);
  if (tooLong) return refuse(tooLong);

  const [row] = await withTenant(opts.orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO brain_documents (org_id, scope_node_id, kind, name, sha256, storage_key, media_type, bytes, pages, uploaded_by)
    VALUES (${opts.orgId}, ${opts.node.id}, ${check.kind}, ${opts.name}, ${check.sha256}, ${key}, ${sniffed},
            ${bytes.byteLength}, ${inspected.pages}, ${opts.userId})
    ON CONFLICT (org_id, sha256) DO NOTHING
    RETURNING id
  `);
  if (!row) {
    const again = await findBySha(opts.orgId, check.sha256);
    return again ? { ok: true, documentId: again.id, extractionId: null, message: "This file was already here." } : { ok: false, message: "Could not file that document." };
  }
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.userId,
    action: "brain.document_added",
    targetType: "brain_document",
    targetId: row.id,
    metadata: { kind: check.kind, type: sniffed, pages: inspected.pages, bytes: bytes.byteLength, node: opts.node.id },
  });
  const queued = await queueExtraction({ orgId: opts.orgId, userId: opts.userId, documentId: row.id });
  return {
    ok: true,
    documentId: row.id,
    extractionId: queued.ok ? queued.extractionId : null,
    message: queued.ok ? "Uploaded." : `Uploaded. ${queued.message}`,
  };
}

/**
 * A file already in the store (attached in Ask Jimmy to set a project up),
 * filed here as a document and queued to be read: copied to its own key
 * server side, then checked and filed exactly as an upload is.
 */
export async function fileStoredDocument(opts: {
  orgId: string;
  userId: string;
  node: BrainNode;
  kind: DocKind;
  name: string;
  type: string;
  size: number;
  sha256: string;
  fromKey: string;
}): Promise<Finished> {
  const check = uploadProblem({ kind: opts.kind, type: opts.type, size: opts.size, sha256: opts.sha256, nodeKind: opts.node.kind, exempt: opts.node.exempt });
  if (!check.ok) return { ok: false, message: check.message };
  const existing = await findBySha(opts.orgId, check.sha256);
  if (existing) return { ok: true, documentId: existing.id, extractionId: null, message: "This file was already here." };
  const key = documentKey(opts.orgId, await projectOfNode(opts.orgId, opts.node.id), check.sha256);
  if (!key) return { ok: false, message: "That file cannot be stored." };
  try {
    await storage().copy(opts.fromKey, key);
  } catch {
    return { ok: false, message: "The file could not be copied. Try again." };
  }
  return finishUpload({ orgId: opts.orgId, userId: opts.userId, node: opts.node, kind: opts.kind, name: opts.name, type: opts.type, size: opts.size, sha256: opts.sha256 });
}

// ---------------------------------------------------------------------------
// Queueing a reading
// ---------------------------------------------------------------------------

export type Queued = { ok: true; extractionId: string; already: boolean } | { ok: false; message: string };

/**
 * A reading, queued. Refused before anything is spent: a document read its
 * limit of times, an organisation past its day's readings, a project with no
 * plan where plans are sold. A reading already queued or running is the one
 * returned, never a second.
 */
export async function queueExtraction(opts: { orgId: string; userId: string; documentId: string }): Promise<Queued> {
  const doc = await documentRow(opts.orgId, opts.documentId);
  if (!doc) return { ok: false, message: "That document is not here." };
  const counts = await withTenant(opts.orgId, async (sql) => {
    const [live] = await sql<{ id: string }[]>`
      SELECT id FROM brain_extractions WHERE document_id = ${doc.id} AND state IN ('QUEUED', 'RUNNING')`;
    const [c] = await sql<{ doc: number; today: number }[]>`
      SELECT
        (SELECT count(*) FROM brain_extractions WHERE document_id = ${doc.id} AND calls > 0)::int AS doc,
        (SELECT count(*) FROM brain_extractions
          WHERE org_id = ${opts.orgId}
            AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
            AND NOT (state = 'FAILED' AND error_code = 'REFUSED'))::int AS today`;
    return { live: live?.id ?? null, ...c };
  });
  if (counts.live) return { ok: true, extractionId: counts.live, already: true };
  const extractor = docKindDef(doc.kind)!.extractor;
  // A refusal is recorded as a reading that did not happen, so the document
  // says why it was not read rather than only "not read".
  const refuse = async (message: string): Promise<Queued> => {
    await withTenant(opts.orgId, (sql) => sql`
      INSERT INTO brain_extractions (org_id, document_id, scope_node_id, extractor, requested_by, model, state, error_code, error, finished_at)
      VALUES (${opts.orgId}, ${doc.id}, ${doc.scope_node_id}, ${extractor}, ${opts.userId}, ${EXTRACT_MODEL}, 'FAILED', 'REFUSED', ${message}, now())`).catch(() => {});
    return { ok: false, message };
  };
  const refusal = runRefusal({
    runsForDocument: counts.doc,
    runsToday: counts.today,
    spentThisMonthUsd: await monthSpend(opts.orgId, doc.scope_node_id),
    firmSpentThisMonthUsd: (await firmMonthSpend(opts.orgId)) ?? undefined,
  });
  if (refusal) return refuse(refusal);
  const allowed = await entitle({ orgId: opts.orgId, nodeId: doc.scope_node_id, needs: [] });
  if (!allowed.ok) return refuse(allowed.message);

  const [row] = await withTenant(opts.orgId, (sql) => sql<{ id: string }[]>`
    INSERT INTO brain_extractions (org_id, document_id, scope_node_id, extractor, requested_by, model)
    VALUES (${opts.orgId}, ${doc.id}, ${doc.scope_node_id}, ${extractor}, ${opts.userId}, ${EXTRACT_MODEL})
    ON CONFLICT (document_id) WHERE state IN ('QUEUED', 'RUNNING') DO NOTHING
    RETURNING id
  `);
  if (!row) {
    const [live] = await withTenant(opts.orgId, (sql) => sql<{ id: string }[]>`
      SELECT id FROM brain_extractions WHERE document_id = ${doc.id} AND state IN ('QUEUED', 'RUNNING')`);
    return live ? { ok: true, extractionId: live.id, already: true } : { ok: false, message: "Could not queue that reading." };
  }
  return { ok: true, extractionId: row.id, already: false };
}

/**
 * Dollars reading has spent on this node's project since the IST month
 * began, every document under it together. Null where the node sits under
 * no project (nothing is read there).
 */
/**
 * Dollars reading has spent across a channel partner's whole firm since the
 * IST month began, or null for any other kind of company, whose plans are
 * per project and capped per project.
 */
async function firmMonthSpend(orgId: string): Promise<number | null> {
  const [row] = await withTenant(orgId, (sql) => sql<{ partner: boolean; usd: string | null }[]>`
    SELECT o.type = 'CHANNEL_PARTNER' AS partner,
           (COALESCE((SELECT sum(e.cost_usd) FROM brain_extractions e
             WHERE e.org_id = o.id
               AND e.created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')), 0)
            -- A project set up from files in Ask Jimmy reads from the same budget.
            + COALESCE((SELECT sum(s.cost_usd) FROM project_setups s
             WHERE s.org_id = o.id
               AND s.created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')), 0))::text AS usd
    FROM orgs o WHERE o.id = ${orgId}`);
  return row?.partner ? Number(row.usd ?? 0) || 0 : null;
}

async function monthSpend(orgId: string, nodeId: string): Promise<number> {
  const [row] = await withTenant(orgId, (sql) => sql<{ usd: string | null }[]>`
    WITH here AS (
      SELECT COALESCE(
        (SELECT p.path FROM scope_nodes n JOIN scope_nodes p ON p.org_id = n.org_id AND p.kind = 'PROJECT' AND p.path @> n.path
          WHERE n.id = ${nodeId} ORDER BY nlevel(p.path) DESC LIMIT 1),
        (SELECT path FROM scope_nodes WHERE id = ${nodeId})) AS path
    )
    SELECT sum(e.cost_usd)::text AS usd
    FROM brain_extractions e JOIN scope_nodes n ON n.id = e.scope_node_id, here
    WHERE e.org_id = ${orgId} AND n.path <@ here.path
      AND e.created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`);
  return Number(row?.usd ?? 0) || 0;
}

type DocRow = {
  id: string;
  scope_node_id: string;
  kind: DocKind;
  name: string;
  sha256: string;
  storage_key: string;
  media_type: DocType;
  pages: number;
  layout: DocLayout | null;
  previews: Record<string, string>;
};

async function documentRow(orgId: string, documentId: string): Promise<DocRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(documentId ?? ""))) return null;
  const [row] = await withTenant(orgId, (sql) => sql<DocRow[]>`
    SELECT id, scope_node_id, kind, name, sha256, storage_key, media_type, pages, layout, previews
    FROM brain_documents WHERE org_id = ${orgId} AND id = ${documentId}
  `);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Running a reading
// ---------------------------------------------------------------------------

/** How long a claim holds before another worker may take the reading over. */
const LEASE_MINUTES = 10;
/** Pages read before what was read is saved. */
const SAVE_EVERY_PAGES = 5;

export type RunOutcome = { ok: true; found: number; dropped: number } | { ok: false; code: string; message: string };

class Refused extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Do one reading: read the pages not yet read, ask the model part by part,
 * keep what the pages prove, and write it to the draft as `planProposals()`
 * says. Claimed under a lease, so two workers never read one document at
 * once, and a reading cut short is picked up where it stopped: the pages
 * already read are kept on the document, and a call already paid for is on
 * the meter.
 */
export async function runExtraction(orgId: string, extractionId: string): Promise<RunOutcome> {
  const [claim] = await withTenant(orgId, (sql) => sql<{ id: string; document_id: string; requested_by: string | null; extractor: string; attempts: number; calls: number; tokens_in: number; tokens_out: number; cost_usd: string }[]>`
    UPDATE brain_extractions
    SET state = 'RUNNING', attempts = attempts + 1, lease_until = now() + ${`${LEASE_MINUTES} minutes`}::interval,
        started_at = COALESCE(started_at, now()), error_code = NULL, error = NULL
    WHERE org_id = ${orgId} AND id = ${extractionId}
      AND attempts < ${MAX_ATTEMPTS}
      AND (state = 'QUEUED' OR (state = 'RUNNING' AND lease_until < now()))
    RETURNING id, document_id, requested_by, extractor, attempts, calls, tokens_in, tokens_out, cost_usd
  `);
  if (!claim) return { ok: false, code: "NOT_CLAIMED", message: "That reading is not due, or another worker holds it." };

  const meter = { calls: claim.calls, tokensIn: claim.tokens_in, tokensOut: claim.tokens_out, usd: Number(claim.cost_usd) };
  const save = (patch: { stage?: string | null; pagesDone?: number; pagesRead?: number; ocrPages?: number }) =>
    withTenant(orgId, (sql) => sql`
      UPDATE brain_extractions SET
        stage = ${patch.stage === undefined ? sql`stage` : patch.stage},
        pages_done = ${patch.pagesDone ?? sql`pages_done`},
        pages_read = ${patch.pagesRead ?? sql`pages_read`},
        ocr_pages = ${patch.ocrPages ?? sql`ocr_pages`},
        calls = ${meter.calls}, tokens_in = ${meter.tokensIn}, tokens_out = ${meter.tokensOut}, cost_usd = ${meter.usd.toFixed(5)},
        lease_until = now() + ${`${LEASE_MINUTES} minutes`}::interval
      WHERE id = ${claim.id}
    `);

  try {
    const doc = await documentRow(orgId, claim.document_id);
    if (!doc) throw new Refused("GONE", "The document was removed.");
    const node = await brainNode(orgId, doc.scope_node_id);
    if (!node) throw new Refused("GONE", "The place this document was filed under was removed.");
    const kind = docKindDef(doc.kind)!;
    const ex = EXTRACTORS[kind.extractor];
    const fields = fieldsToRead(ex.key, node.kind, node.exempt);

    // What the project and the firm spent before this reading began; this
    // reading's own spend is added as it goes.
    const before = (await monthSpend(orgId, doc.scope_node_id)) - meter.usd;
    const firmSpent = await firmMonthSpend(orgId);
    const firmBefore = firmSpent === null ? null : firmSpent - meter.usd;
    const overMonth = (more: number) => {
      if (before + meter.usd + more > MAX_PROJECT_MONTH_USD) {
        throw new Refused("MONTH", "This project's documents have been read as often as a month allows. Reading opens again on the 1st.");
      }
      if (firmBefore !== null && firmBefore + meter.usd + more > MAX_FIRM_MONTH_USD) {
        throw new Refused("MONTH", "Your firm's documents have been read as often as a month allows. Reading opens again on the 1st.");
      }
    };

    // Reading the pages, and keeping what was read. A page with no text layer
    // is read by the vision model, its cost on the page and on this reading.
    const layout: DocLayout = doc.layout ?? { engine: "", pages: [] };
    const want = Array.from({ length: Math.min(doc.pages, kind.maxPages) }, (_, i) => i + 1);
    const have = new Set(layout.pages.map((p) => p.n));
    const missing = want.filter((n) => !have.has(n));
    if (missing.length) {
      await save({ stage: "READING", pagesDone: have.size });
      const bytes = await storage().read(doc.storage_key);
      if (!bytes) throw new Refused("NOT_STORED", "The file could not be read from the store.");
      const { readPages, READER_ENGINE } = await import("./pdf-read.ts");
      layout.engine = READER_ENGINE;
      // The languages the organisation's briefs are written in choose which
      // Devanagari models read a scan that English could not.
      const langRows = await withTenant(orgId, (sql) => sql<{ language: string }[]>`
        SELECT DISTINCT unnest(languages) AS language FROM campaign_briefs WHERE org_id = ${orgId}`);
      const languages = langRows.map((r) => r.language);
      let unsaved = 0;
      const persist = async () => {
        layout.pages.sort((a, b) => a.n - b.n);
        await withTenant(orgId, (sql) => sql`UPDATE brain_documents SET layout = ${sql.json(layout as never)} WHERE id = ${doc.id}`);
        await save({ pagesDone: layout.pages.length });
        unsaved = 0;
      };
      await readPages(bytes, doc.media_type, missing, async (page) => {
        layout.pages.push(page);
        if (page.usd) {
          meter.calls += 1;
          meter.usd += page.usd;
        }
        if (++unsaved >= SAVE_EVERY_PAGES) await persist();
      }, { languages, beforePaid: () => overMonth(VISION_PAGE_USD) });
      await persist();
    }
    const pages = layout.pages.filter((p) => p.n <= kind.maxPages).sort((a, b) => a.n - b.n);
    await save({
      pagesRead: pages.length,
      ocrPages: pages.filter((p) => p.source === "ocr").length,
    });

    // Asking, part by part, each refused before it is sent if it could take
    // the reading past its budget. Reading the pages is held to the month,
    // not to one reading's budget: a long scan is read once and kept.
    const parts: ReadResult[] = [];
    let modelVersion = EXTRACT_MODEL;
    const pagesUsd = pages.reduce((s, p) => s + (p.usd ?? 0), 0);
    const askedUsd = () => Math.max(0, meter.usd - pagesUsd);
    if (fields.length || ex.units) {
      await save({ stage: "ASKING" });
      for (const chunk of chunkPages(pages.filter((p) => p.segments.length))) {
        const req = extractRequest({ extractor: ex.key, docLabel: kind.label, nodeName: node.name, nodeKind: node.kind, fields, pages: chunk });
        let answer: ExtractAnswer | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (askedUsd() + worstUsd(req) > MAX_RUN_USD) {
            throw new Refused("BUDGET", "This document is too long to read in one go. Upload the pages that hold the facts.");
          }
          overMonth(worstUsd(req));
          meter.calls += 1;
          answer = await driver()(req);
          // Paid for whether or not it came back in shape.
          meter.tokensIn += answer.tokensIn ?? 0;
          meter.tokensOut += answer.tokensOut ?? 0;
          meter.usd += extractUsd(answer.tokensIn ?? 0, answer.tokensOut ?? 0);
          await save({});
          if (answer.ok || !answer.retry) break;
        }
        if (!answer || !answer.ok) {
          throw new Refused(answer?.code ?? "AI_FAILED", answer && !answer.ok && answer.code !== "UNPARSED" ? answer.message : "The document could not be read this time. Try again.");
        }
        modelVersion = answer.modelVersion;
        parts.push(readAnswer({ answer: answer.value, fields, pages: chunk, wantUnits: ex.units }));
      }
    }
    const read = mergeReads(parts);

    // Writing what the pages proved.
    await save({ stage: "WRITING" });
    const written = await writeFindings({
      orgId,
      actorUserId: claim.requested_by,
      node,
      documentId: doc.id,
      extractionId: claim.id,
      extractor: ex.key,
      modelVersion,
      fields,
      read,
    });

    await withTenant(orgId, (sql) => sql`
      UPDATE brain_extractions SET state = 'DONE', stage = NULL, lease_until = NULL, finished_at = now(),
        model_version = ${modelVersion}, found = ${read.found.length}, dropped = ${read.dropped},
        units = ${sql.json(read.units as never)}
      WHERE id = ${claim.id}
    `);
    await audit({
      orgId,
      actorUserId: claim.requested_by,
      action: "brain.document_read",
      targetType: "brain_document",
      targetId: doc.id,
      metadata: {
        kind: doc.kind,
        node: node.id,
        pages: pages.length,
        ocr_pages: pages.filter((p) => p.source === "ocr").length,
        found: read.found.length,
        dropped: read.dropped,
        units: read.units.length,
        filled: written.filled,
        calls: meter.calls,
        cost_usd: Number(meter.usd.toFixed(5)),
      },
    });
    return { ok: true, found: read.found.length, dropped: read.dropped };
  } catch (e) {
    const refused = e instanceof Refused;
    const code = refused ? e.code : "FAILED";
    const message = refused ? e.message : "The document could not be read this time. Try again.";
    if (!refused) console.error("extract: reading failed", e);
    // A refusal another try cannot fix ends it now; a crash is tried again
    // until the attempts run out.
    const final = refused || claim.attempts >= MAX_ATTEMPTS;
    await withTenant(orgId, (sql) => sql`
      UPDATE brain_extractions SET
        state = ${final ? "FAILED" : "QUEUED"}, stage = NULL, lease_until = NULL,
        finished_at = ${final ? sql`now()` : null},
        error_code = ${code}, error = ${message},
        calls = ${meter.calls}, tokens_in = ${meter.tokensIn}, tokens_out = ${meter.tokensOut}, cost_usd = ${meter.usd.toFixed(5)}
      WHERE id = ${claim.id}
    `).catch(() => {});
    return { ok: false, code, message };
  }
}

type Sql = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * Write one reading's findings: supersede this document's earlier ones, fill
 * what nobody filled, propose the rest, and record each with its page. One
 * transaction, holding the draft's row, so two documents finishing at once
 * cannot each fill the same empty field.
 */
async function writeFindings(opts: {
  orgId: string;
  actorUserId: string | null;
  node: BrainNode;
  documentId: string;
  extractionId: string;
  extractor: string;
  modelVersion: string;
  fields: readonly string[];
  read: ReadResult;
}): Promise<{ filled: number }> {
  if (!opts.fields.length) return { filled: 0 };
  const inherited = (await inheritedBrain(opts.orgId, opts.node.id))?.values ?? {};
  const planAgainst = async (sql: Sql, versionId: string | null) => {
    const values = versionId ? await draftValues(sql, versionId) : {};
    const pending = await sql<{ id: string; document_id: string; field_key: string; value: string; in_draft: boolean; state: "PROPOSED" | "MATCHED" }[]>`
      SELECT id, document_id, field_key, value, in_draft, state FROM brain_proposals
      WHERE org_id = ${opts.orgId} AND scope_node_id = ${opts.node.id} AND state IN ('PROPOSED', 'MATCHED')`;
    return planProposals({
      documentId: opts.documentId,
      found: opts.read.found,
      draft: values,
      inherited,
      fields: opts.fields,
      pending: pending.map<Pending>((p) => ({ id: p.id, documentId: p.document_id, field: p.field_key, value: p.value, inDraft: p.in_draft, state: p.state })),
    });
  };
  const current = (sql: Sql, lock: boolean) => sql<{ id: string; state: string }[]>`
    SELECT id, state FROM brain_versions
    WHERE org_id = ${opts.orgId} AND scope_node_id = ${opts.node.id} AND state IN ('DRAFT', 'PUBLISHED')
    ORDER BY (state = 'DRAFT') DESC LIMIT 1 ${lock ? sql`FOR UPDATE` : sql``}`;

  // A draft is opened only when the reading puts something in it. A
  // document that only confirms what is live leaves no empty draft behind.
  const needsDraft = await withTenant(opts.orgId, async (sql) => {
    const [cur] = await current(sql, false);
    if (cur?.state === "DRAFT") return false;
    const plan = await planAgainst(sql, cur?.id ?? null);
    return Object.keys(plan.set).length > 0;
  });
  if (needsDraft) {
    const opened = await openDraft({ orgId: opts.orgId, actorUserId: opts.actorUserId as string, nodeId: opts.node.id });
    if (!opened.ok) throw new Refused("NO_DRAFT", opened.message);
  }

  return withTenant(opts.orgId, async (sql) => {
    const [target] = await current(sql, true);
    const draft = target?.state === "DRAFT" ? target : null;
    const plan = await planAgainst(sql, target?.id ?? null);
    // Published between the look and the write: try again, from the start.
    if (!draft && Object.keys(plan.set).length) throw new Error("the draft moved while the findings were written");

    if (plan.supersede.length) {
      await sql`UPDATE brain_proposals SET state = 'SUPERSEDED'
                WHERE id = ANY(${plan.supersede}) AND state IN ('PROPOSED', 'MATCHED')`;
    }
    let filled = 0;
    for (const [field, value] of draft ? Object.entries(plan.set) : []) {
      const parsed = parseValue(field, value);
      if (!parsed.ok) continue;
      const f = plan.provenance[field];
      const scalar = fieldByKey(field)?.type !== "LIST";
      if (parsed.value !== null) filled += 1;
      await writeField(sql, {
        orgId: opts.orgId,
        versionId: draft!.id,
        field,
        value: parsed.value,
        actor: opts.actorUserId,
        source:
          scalar && f && parsed.value !== null
            ? { documentId: opts.documentId, page: f.page, bbox: f.bbox, extractor: opts.extractor, modelVersion: opts.modelVersion, confidence: f.confidence }
            : null,
      });
    }
    // A value somebody typed that the document agrees with gets its page.
    for (const [field, f] of draft ? Object.entries(plan.provenance) : []) {
      if (plan.set[field] !== undefined || fieldByKey(field)?.type === "LIST") continue;
      await sql`
        UPDATE brain_fields SET source_asset = ${opts.documentId}, source_page = ${f.page}, source_bbox = ${JSON.stringify(f.bbox)},
          extractor = ${opts.extractor}, model_version = ${opts.modelVersion}, confidence = ${f.confidence}
        WHERE brain_version_id = ${draft!.id} AND field_key = ${field} AND source_asset IS NULL`;
    }
    for (const p of plan.proposals) {
      await sql`
        INSERT INTO brain_proposals (org_id, extraction_id, document_id, scope_node_id, brain_version_id, field_key, value,
          quote, page, bbox, confidence, extractor, model_version, in_draft, state)
        VALUES (${opts.orgId}, ${opts.extractionId}, ${opts.documentId}, ${opts.node.id}, ${target?.id ?? null}, ${p.field}, ${p.value},
          ${p.quote}, ${p.page}, ${sql.json(p.bbox as never)}, ${p.confidence}, ${opts.extractor}, ${opts.modelVersion},
          ${p.inDraft}, ${p.state})`;
    }
    return { filled };
  });
}

async function draftValues(sql: Sql, versionId: string): Promise<FieldValues> {
  const rows = await sql<{ field_key: string; value: string | null }[]>`
    SELECT field_key, value FROM brain_fields WHERE brain_version_id = ${versionId}`;
  const out: FieldValues = {};
  for (const r of rows) out[r.field_key] = r.value;
  return out;
}

type Source = { documentId: string; page: number; bbox: Box; extractor: string; modelVersion: string; confidence: number | null };

/** One field of a draft, with where its value came from, or with none. */
async function writeField(sql: Sql, o: { orgId: string; versionId: string; field: string; value: string | null; actor: string | null; source: Source | null }) {
  const s = o.source;
  await sql`
    INSERT INTO brain_fields (brain_version_id, org_id, field_key, value, updated_by, updated_at,
      source_asset, source_page, source_bbox, extractor, model_version, confidence)
    VALUES (${o.versionId}, ${o.orgId}, ${o.field}, ${o.value}, ${o.actor}, now(),
      ${s?.documentId ?? null}, ${s?.page ?? null}, ${s ? JSON.stringify(s.bbox) : null},
      ${s?.extractor ?? null}, ${s?.modelVersion ?? null}, ${s?.confidence ?? null})
    ON CONFLICT (brain_version_id, field_key) DO UPDATE SET
      value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now(),
      source_asset = EXCLUDED.source_asset, source_page = EXCLUDED.source_page, source_bbox = EXCLUDED.source_bbox,
      extractor = EXCLUDED.extractor, model_version = EXCLUDED.model_version, confidence = EXCLUDED.confidence`;
}

/**
 * What is due, a bounded amount, for the worker. Queued readings, and
 * running ones whose lease ran out because the request that started them
 * died.
 */
export async function runDueExtractions(opts: { orgIds: readonly string[]; limit?: number }): Promise<number> {
  let done = 0;
  const limit = opts.limit ?? 10;
  for (const orgId of opts.orgIds) {
    if (done >= limit) break;
    const due = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
      SELECT id FROM brain_extractions
      WHERE org_id = ${orgId} AND attempts < ${MAX_ATTEMPTS}
        AND (state = 'QUEUED' OR (state = 'RUNNING' AND lease_until < now()))
      ORDER BY created_at LIMIT ${limit - done}`);
    for (const d of due) {
      await runExtraction(orgId, d.id);
      done += 1;
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// The review screen
// ---------------------------------------------------------------------------

export type ReviewItem = {
  id: string;
  documentId: string;
  documentName: string;
  documentKind: DocKind;
  field: string;
  value: string;
  quote: string;
  page: number;
  bbox: Box;
  confidence: number;
  inDraft: boolean;
  /** What the draft holds now, for a value that is not in it. */
  draftValue: string | null;
  flags: Flag[];
  /** A reason it may not be accepted as it is, or null. */
  blocked: string | null;
};

export type DocumentRow = {
  id: string;
  kind: DocKind;
  name: string;
  pages: number;
  bytes: number;
  sha256: string;
  mediaType: DocType;
  createdAt: string;
  uploadedByName: string | null;
  reading: {
    id: string;
    state: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
    stage: string | null;
    pagesDone: number;
    pagesRead: number;
    ocrPages: number;
    found: number;
    dropped: number;
    error: string | null;
    finishedAt: string | null;
  } | null;
  /** What reading it has cost us, every reading together, in rupees. */
  costRs: number;
  runsLeft: number;
  /** A value was taken from it, so it is kept. */
  kept: boolean;
  matched: number;
  units: UnitCheck[];
};

export type DocumentsView = {
  node: BrainNode;
  documents: DocumentRow[];
  review: ReviewItem[];
  /** Values the documents confirm, already in the Brain. */
  matched: number;
  draftVersion: number | null;
};

/** Everything the documents screen shows for one node, in one pass. */
export async function loadDocuments(orgId: string, nodeId: string): Promise<DocumentsView | null> {
  const node = await brainNode(orgId, nodeId);
  if (!node) return null;
  const [inherited, units] = await Promise.all([
    inheritedBrain(orgId, node.id),
    loadUnits(orgId, node.id).catch(() => null),
  ]);

  const data = await withTenant(orgId, async (sql) => {
    const docs = await sql<{ id: string; kind: DocKind; name: string; pages: number; bytes: string; sha256: string; media_type: DocType; created_at: Date; by_name: string | null }[]>`
      SELECT d.id, d.kind, d.name, d.pages, d.bytes, d.sha256, d.media_type, d.created_at, u.name AS by_name
      FROM brain_documents d LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.org_id = ${orgId} AND d.scope_node_id = ${node.id}
      ORDER BY d.created_at DESC`;
    const ids = docs.map((d) => d.id);
    const runs = ids.length
      ? await sql<{ id: string; document_id: string; state: "QUEUED" | "RUNNING" | "DONE" | "FAILED"; stage: string | null; pages_done: number; pages_read: number; ocr_pages: number; found: number; dropped: number; error: string | null; finished_at: Date | null; created_at: Date; calls: number; cost_usd: string; units: FoundUnit[] }[]>`
          SELECT id, document_id, state, stage, pages_done, pages_read, ocr_pages, found, dropped, error, finished_at, created_at, calls, cost_usd, units
          FROM brain_extractions WHERE document_id = ANY(${ids}) ORDER BY created_at DESC`
      : [];
    const proposals = await sql<{ id: string; document_id: string; field_key: string; value: string; quote: string; page: number; bbox: Box; confidence: string; in_draft: boolean; state: string }[]>`
      SELECT id, document_id, field_key, value, quote, page, bbox, confidence, in_draft, state
      FROM brain_proposals WHERE org_id = ${orgId} AND scope_node_id = ${node.id}
        AND state IN ('PROPOSED', 'MATCHED', 'ACCEPTED', 'CORRECTED')`;
    const [draft] = await sql<{ id: string; version: number }[]>`
      SELECT id, version FROM brain_versions WHERE org_id = ${orgId} AND scope_node_id = ${node.id} AND state = 'DRAFT'`;
    const [published] = await sql<{ id: string }[]>`
      SELECT id FROM brain_versions WHERE org_id = ${orgId} AND scope_node_id = ${node.id} AND state = 'PUBLISHED'`;
    const current = draft ?? published ?? null;
    const values = current ? await draftValues(sql, current.id) : {};
    const [filing] = await sql<{ registration_no: string | null; valid_to: Date | null; extended_until: Date | null }[]>`
      SELECT registration_no, valid_to, extended_until FROM registration_records WHERE scope_node_id = ${node.id}`;
    return { docs, runs, proposals, draft: draft ?? null, values, filing: filing ?? null };
  });

  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const filing: Filing = data.filing
    ? { registrationNo: data.filing.registration_no, validTo: day(data.filing.valid_to), extendedUntil: day(data.filing.extended_until) }
    : null;
  const effective = withInherited(inherited?.values ?? null, data.values);
  const names = new Map(data.docs.map((d) => [d.id, d]));
  const open = data.proposals.filter((p) => p.state === "PROPOSED" || p.state === "MATCHED");
  const others = open.map((p) => ({ id: p.id, field: p.field_key, value: p.value, documentId: p.document_id }));

  const review = reviewOrder(
    data.proposals
      .filter((p) => p.state === "PROPOSED")
      .map((p) => {
        const flags = flagsFor({
          proposal: { id: p.id, field: p.field_key, value: p.value, documentId: p.document_id },
          others,
          nodeKind: node.kind,
          exempt: node.exempt,
          filing,
          effective,
        });
        const doc = names.get(p.document_id)!;
        const def = fieldByKey(p.field_key);
        return {
          id: p.id,
          documentId: p.document_id,
          documentName: doc?.name ?? "Document",
          documentKind: doc?.kind ?? "BROCHURE",
          field: p.field_key,
          value: p.value,
          quote: p.quote,
          page: p.page,
          bbox: p.bbox,
          confidence: Number(p.confidence),
          inDraft: p.in_draft,
          draftValue: def?.type === "LIST" ? null : data.values[p.field_key] ?? null,
          flags,
          blocked: acceptRefusal(flags),
        } satisfies ReviewItem;
      }),
  );

  const unitList = (units?.units ?? []).map((u) => ({
    id: u.id,
    config: u.config,
    variant: u.variant,
    carpetAreaSqft: u.carpetAreaSqft,
    startingPrice: u.startingPrice,
    approved: (units?.approvals ?? []).some((a) => a.unitTypeId === u.id && a.sha256 === u.sha256),
    nodeName: u.nodeName,
  }));
  const basePsf = Number(effective["price.base_psf"]) || null;

  const documents: DocumentRow[] = data.docs.map((d) => {
    const runs = data.runs.filter((r) => r.document_id === d.id);
    const latest = runs[0] ?? null;
    const lastDone = runs.find((r) => r.state === "DONE") ?? null;
    const reached = runs.filter((r) => r.calls > 0).length;
    return {
      id: d.id,
      kind: d.kind,
      name: d.name,
      pages: d.pages,
      bytes: Number(d.bytes),
      sha256: d.sha256,
      mediaType: d.media_type,
      createdAt: d.created_at.toISOString(),
      uploadedByName: d.by_name,
      reading: latest
        ? {
            id: latest.id,
            state: latest.state,
            stage: latest.stage,
            pagesDone: latest.pages_done,
            pagesRead: latest.pages_read,
            ocrPages: latest.ocr_pages,
            found: latest.found,
            dropped: latest.dropped,
            error: latest.error,
            finishedAt: latest.finished_at?.toISOString() ?? null,
          }
        : null,
      costRs: usdToRupees(runs.reduce((s, r) => s + Number(r.cost_usd), 0)),
      runsLeft: Math.max(0, MAX_RUNS_PER_DOCUMENT - reached),
      kept: data.proposals.some((p) => p.document_id === d.id && (p.state === "ACCEPTED" || p.state === "CORRECTED")),
      matched: data.proposals.filter((p) => p.document_id === d.id && p.state === "MATCHED").length,
      units: lastDone ? unitChecks(lastDone.units ?? [], unitList, basePsf) : [],
    };
  });

  return {
    node,
    documents,
    review,
    matched: data.proposals.filter((p) => p.state === "MATCHED").length,
    draftVersion: data.draft?.version ?? null,
  };
}

/** For the Brain page: how many values wait for a person, and how many documents there are. */
export async function documentSummary(orgId: string, nodeId: string): Promise<{ toCheck: number; unreviewedInDraft: number; unreviewedKeys: string[]; documents: number; reading: number }> {
  const [row] = await withTenant(orgId, (sql) => sql<{ to_check: number; in_draft: number; keys: string[] | null; documents: number; reading: number }[]>`
    SELECT
      (SELECT array_agg(DISTINCT p.field_key) FROM brain_proposals p JOIN brain_versions v ON v.id = p.brain_version_id AND v.state = 'DRAFT'
        WHERE p.org_id = ${orgId} AND p.scope_node_id = ${nodeId} AND p.state = 'PROPOSED' AND p.in_draft) AS keys,
      (SELECT count(*) FROM brain_proposals WHERE org_id = ${orgId} AND scope_node_id = ${nodeId} AND state = 'PROPOSED')::int AS to_check,
      (SELECT count(*) FROM brain_proposals p JOIN brain_versions v ON v.id = p.brain_version_id AND v.state = 'DRAFT'
        WHERE p.org_id = ${orgId} AND p.scope_node_id = ${nodeId} AND p.state = 'PROPOSED' AND p.in_draft)::int AS in_draft,
      (SELECT count(*) FROM brain_documents WHERE org_id = ${orgId} AND scope_node_id = ${nodeId})::int AS documents,
      (SELECT count(*) FROM brain_extractions WHERE org_id = ${orgId} AND scope_node_id = ${nodeId} AND state IN ('QUEUED', 'RUNNING'))::int AS reading
  `).catch(() => [{ to_check: 0, in_draft: 0, keys: [] as string[], documents: 0, reading: 0 }]);
  return { toCheck: row.to_check, unreviewedInDraft: row.in_draft, unreviewedKeys: row.keys ?? [], documents: row.documents, reading: row.reading };
}

// ---------------------------------------------------------------------------
// A person's decision on one value
// ---------------------------------------------------------------------------

export type Decision = { kind: "accept" } | { kind: "correct"; value: string } | { kind: "reject" };

export type Decided = { ok: true; message: string } | { ok: false; message: string };

/** The node and state of one proposal, for the action's permission check. */
export async function proposalPlace(orgId: string, proposalId: string): Promise<{ nodeId: string; path: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(proposalId ?? ""))) return null;
  const [row] = await withTenant(orgId, (sql) => sql<{ node_id: string; path: string }[]>`
    SELECT n.id AS node_id, n.path::text AS path FROM brain_proposals p JOIN scope_nodes n ON n.id = p.scope_node_id
    WHERE p.org_id = ${orgId} AND p.id = ${proposalId}`);
  return row ? { nodeId: row.node_id, path: row.path } : null;
}

/**
 * Accept, correct or reject one value. Accepting puts it in the draft (or
 * leaves it there) with its page; correcting puts the person's value in its
 * place and keeps the page it was read from; rejecting takes an unreviewed
 * value back out. The flags are asked again first: a registration number
 * nobody filed is not accepted, whatever the screen showed.
 */
export async function decideProposal(opts: { orgId: string; userId: string; proposalId: string; decision: Decision }): Promise<Decided> {
  const [p] = await withTenant(opts.orgId, (sql) => sql<{ id: string; document_id: string; scope_node_id: string; brain_version_id: string | null; field_key: string; value: string; page: number; bbox: Box; confidence: string; extractor: string; model_version: string; in_draft: boolean; state: string }[]>`
    SELECT id, document_id, scope_node_id, brain_version_id, field_key, value, page, bbox, confidence, extractor, model_version, in_draft, state
    FROM brain_proposals WHERE org_id = ${opts.orgId} AND id = ${opts.proposalId}`);
  if (!p) return { ok: false, message: "That value is not here." };
  if (p.state !== "PROPOSED") return { ok: false, message: "That value was already decided." };
  const def = fieldByKey(p.field_key);
  if (!def) return { ok: false, message: "That value is not a fact the Brain holds." };
  const node = await brainNode(opts.orgId, p.scope_node_id);
  if (!node) return { ok: false, message: "That place was removed." };

  let written: string | null = null;
  if (opts.decision.kind === "correct") {
    const parsed = parseValue(p.field_key, opts.decision.value);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    if (!parsed.value) return { ok: false, message: "Type the correct value, or reject it." };
    if (def.type === "LIST" && asList(parsed.value).length !== 1) return { ok: false, message: "One line, please." };
    written = parsed.value;
  } else if (opts.decision.kind === "accept") {
    written = p.value;
  }

  if (written !== null && p.field_key === "rera.registration_no") {
    const flags = flagsFor({
      proposal: { id: p.id, field: p.field_key, value: written, documentId: p.document_id },
      others: [],
      nodeKind: node.kind,
      exempt: node.exempt,
      filing: await filingOf(opts.orgId, node.id),
      effective: {},
    });
    const refusal = acceptRefusal(flags);
    if (refusal) return { ok: false, message: refusal };
  }

  // The draft this goes into: the one it was read against while that is
  // still the draft, otherwise the node's draft, opened if need be.
  const opened = await openDraft({ orgId: opts.orgId, actorUserId: opts.userId, nodeId: node.id });
  if (!opened.ok) return { ok: false, message: opened.message };
  const inherited = def.type === "LIST" ? (await inheritedBrain(opts.orgId, node.id))?.values ?? {} : {};

  const result = await withTenant(opts.orgId, async (sql) => {
    const [draft] = await sql<{ id: string; state: string }[]>`SELECT id, state FROM brain_versions WHERE id = ${opened.versionId} FOR UPDATE`;
    if (!draft || draft.state !== "DRAFT") return { ok: false as const, message: "The draft changed. Look again." };
    const [still] = await sql<{ state: string }[]>`SELECT state FROM brain_proposals WHERE id = ${p.id} FOR UPDATE`;
    if (still?.state !== "PROPOSED") return { ok: false as const, message: "That value was already decided." };
    const values = await draftValues(sql, draft.id);
    const current = values[p.field_key] ?? null;
    const inThisDraft = p.in_draft && p.brain_version_id === draft.id;
    const source: Source = {
      documentId: p.document_id,
      page: p.page,
      bbox: p.bbox,
      extractor: p.extractor,
      modelVersion: p.model_version,
      confidence: opts.decision.kind === "accept" ? Number(p.confidence) : null,
    };

    if (def.type === "LIST") {
      const lines = asList(current);
      const at = lines.findIndex((l) => sameValue(p.field_key, l, p.value));
      let next = lines;
      if (opts.decision.kind === "reject") {
        if (inThisDraft && at >= 0) next = lines.filter((_, i) => i !== at);
      } else {
        const line = written!;
        const known = [...lines, ...asList(inherited[p.field_key])].some((l) => sameValue(p.field_key, l, line));
        if (at >= 0 && inThisDraft) next = lines.map((l, i) => (i === at ? line : l));
        else if (!known) next = [...lines, line];
      }
      if (next.join("\n") !== lines.join("\n")) {
        const parsed = parseValue(p.field_key, next.join("\n"));
        if (!parsed.ok) return { ok: false as const, message: parsed.message };
        await writeField(sql, { orgId: opts.orgId, versionId: draft.id, field: p.field_key, value: parsed.value, actor: opts.userId, source: null });
      }
    } else if (opts.decision.kind === "reject") {
      if (inThisDraft && sameValue(p.field_key, current, p.value)) {
        await writeField(sql, { orgId: opts.orgId, versionId: draft.id, field: p.field_key, value: null, actor: opts.userId, source: null });
      }
    } else {
      await writeField(sql, { orgId: opts.orgId, versionId: draft.id, field: p.field_key, value: written, actor: opts.userId, source });
    }

    const state = opts.decision.kind === "accept" ? "ACCEPTED" : opts.decision.kind === "correct" ? "CORRECTED" : "REJECTED";
    await sql`
      UPDATE brain_proposals SET state = ${state}, corrected_value = ${state === "CORRECTED" ? written : null},
        decided_by = ${opts.userId}, decided_at = now()
      WHERE id = ${p.id}`;
    // Another reading of the same fact, now settled by this decision, is
    // settled too: it was the same question.
    if (def.type !== "LIST" && state !== "REJECTED") {
      await sql`
        UPDATE brain_proposals SET state = 'REJECTED', decided_by = ${opts.userId}, decided_at = now()
        WHERE org_id = ${opts.orgId} AND scope_node_id = ${node.id} AND field_key = ${p.field_key}
          AND state = 'PROPOSED' AND id <> ${p.id} AND in_draft`;
    }
    return { ok: true as const, message: state === "ACCEPTED" ? "Accepted." : state === "CORRECTED" ? "Corrected." : "Rejected." };
  });

  if (result.ok) {
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.userId,
      action: "brain.value_decided",
      targetType: "scope_node",
      targetId: node.id,
      metadata: { field: p.field_key, decision: opts.decision.kind, document: p.document_id, page: p.page },
    });
  }
  return result;
}

async function filingOf(orgId: string, nodeId: string): Promise<Filing> {
  const [f] = await withTenant(orgId, (sql) => sql<{ registration_no: string | null; valid_to: Date | null; extended_until: Date | null }[]>`
    SELECT registration_no, valid_to, extended_until FROM registration_records WHERE scope_node_id = ${nodeId}`);
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  return f ? { registrationNo: f.registration_no, validTo: day(f.valid_to), extendedUntil: day(f.extended_until) } : null;
}

// ---------------------------------------------------------------------------
// The document itself
// ---------------------------------------------------------------------------

export type DocumentFile = { id: string; nodeId: string; path: string; key: string; type: DocType; name: string; sha256: string; pages: number; previews: Record<string, string> };

export async function documentFile(orgId: string, documentId: string): Promise<DocumentFile | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(documentId ?? ""))) return null;
  const [row] = await withTenant(orgId, (sql) => sql<{ id: string; scope_node_id: string; path: string; storage_key: string; media_type: DocType; name: string; sha256: string; pages: number; previews: Record<string, string> }[]>`
    SELECT d.id, d.scope_node_id, n.path::text AS path, d.storage_key, d.media_type, d.name, d.sha256, d.pages, d.previews
    FROM brain_documents d JOIN scope_nodes n ON n.id = d.scope_node_id
    WHERE d.org_id = ${orgId} AND d.id = ${documentId}`);
  return row
    ? { id: row.id, nodeId: row.scope_node_id, path: row.path, key: row.storage_key, type: row.media_type, name: row.name, sha256: row.sha256, pages: row.pages, previews: row.previews ?? {} }
    : null;
}

/**
 * One page drawn for the review screen, drawn once and kept beside the
 * document so the next look is a read rather than a render. The key is
 * recorded on the row, so the orphan sweep knows it and removing the
 * document removes it.
 */
export async function pagePreview(orgId: string, doc: DocumentFile, n: number): Promise<Buffer | null> {
  if (!Number.isInteger(n) || n < 1 || n > doc.pages) return null;
  const kept = doc.previews[String(n)];
  if (kept) {
    const bytes = await storage().read(kept);
    if (bytes) return bytes;
  }
  const source = await storage().read(doc.key);
  if (!source) return null;
  const { renderPreview } = await import("./pdf-read.ts");
  const jpg = await renderPreview(source, doc.type, n);
  if (!jpg) return null;
  const key = assetKey({ orgId, project: await projectOfNode(orgId, doc.nodeId), kind: "docpage", id: `${doc.sha256}-${n}` });
  if (key) {
    const stored = await storage().put(key, jpg, "image/jpeg").then(() => true).catch(() => false);
    if (stored) {
      await withTenant(orgId, (sql) => sql`
        UPDATE brain_documents SET previews = previews || ${sql.json({ [String(n)]: key })}
        WHERE org_id = ${orgId} AND id = ${doc.id}`).catch(() => {});
    }
  }
  return jpg;
}

/**
 * Remove a document nothing was taken from. Its unreviewed values come out
 * of the draft first, because a value with no page behind it is a value
 * nobody can check. One a value was accepted from is kept (the database
 * refuses it too).
 */
export async function removeDocument(opts: { orgId: string; userId: string; documentId: string }): Promise<Decided> {
  const doc = await documentFile(opts.orgId, opts.documentId);
  if (!doc) return { ok: false, message: "That document is not here." };
  const result = await withTenant(opts.orgId, async (sql) => {
    const [kept] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM brain_proposals WHERE document_id = ${doc.id} AND state IN ('ACCEPTED', 'CORRECTED')`;
    if (kept.n > 0) return { ok: false as const, message: "A value was taken from this document, so it is kept." };
    const [live] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM brain_extractions WHERE document_id = ${doc.id} AND state = 'RUNNING' AND lease_until > now()`;
    if (live.n > 0) return { ok: false as const, message: "This document is being read. Remove it when that finishes." };
    const unreviewed = await sql<{ field_key: string; value: string; brain_version_id: string }[]>`
      SELECT p.field_key, p.value, p.brain_version_id FROM brain_proposals p
      JOIN brain_versions v ON v.id = p.brain_version_id AND v.state = 'DRAFT'
      WHERE p.document_id = ${doc.id} AND p.state = 'PROPOSED' AND p.in_draft`;
    for (const u of unreviewed) {
      const values = await draftValues(sql, u.brain_version_id);
      const def = fieldByKey(u.field_key);
      if (def?.type === "LIST") {
        const lines = asList(values[u.field_key]).filter((l) => !sameValue(u.field_key, l, u.value));
        await writeField(sql, { orgId: opts.orgId, versionId: u.brain_version_id, field: u.field_key, value: lines.join("\n") || null, actor: opts.userId, source: null });
      } else if (sameValue(u.field_key, values[u.field_key], u.value)) {
        await writeField(sql, { orgId: opts.orgId, versionId: u.brain_version_id, field: u.field_key, value: null, actor: opts.userId, source: null });
      }
    }
    await sql`DELETE FROM brain_documents WHERE org_id = ${opts.orgId} AND id = ${doc.id}`;
    return { ok: true as const, message: "Removed." };
  }).catch((e) => {
    console.error("extract: could not remove a document", e);
    return { ok: false as const, message: "Could not remove that document." };
  });
  if (result.ok) {
    await storage().remove(doc.key).catch(() => {});
    for (const key of Object.values(doc.previews)) await storage().remove(key).catch(() => {});
    await audit({ orgId: opts.orgId, actorUserId: opts.userId, action: "brain.document_removed", targetType: "brain_document", targetId: doc.id, metadata: { node: doc.nodeId } });
  }
  return result;
}

export type { PageText };

/** Where each field of a version was read from, for the Brain page: the document's name and the page. */
export async function sourcesOf(orgId: string, versionId: string | null | undefined): Promise<Record<string, { documentId: string; name: string; page: number }>> {
  if (!versionId) return {};
  const rows = await withTenant(orgId, (sql) => sql<{ field_key: string; document_id: string; name: string; page: number }[]>`
    SELECT f.field_key, d.id AS document_id, d.name, f.source_page AS page
    FROM brain_fields f JOIN brain_documents d ON d.id::text = f.source_asset AND d.org_id = f.org_id
    WHERE f.brain_version_id = ${versionId} AND f.source_page IS NOT NULL`).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.field_key, { documentId: r.document_id, name: r.name, page: r.page }]));
}

/**
 * What the documents read about each phase's registration, for the
 * registration form to start from: the number and the completion date a
 * certificate printed, the newest reading that nobody rejected. Read only;
 * recording still asks the portal and a person.
 */
export async function registrationFromDocuments(
  orgId: string,
  phaseIds: readonly string[],
): Promise<Record<string, { number: string | null; validTo: string | null; registeredOn: string | null }>> {
  if (!phaseIds.length) return {};
  const [rows, certs] = await withTenant(orgId, (sql) =>
    Promise.all([
      sql<{ node: string; field: string; value: string }[]>`
        SELECT DISTINCT ON (scope_node_id, field_key) scope_node_id AS node, field_key AS field, coalesce(corrected_value, value) AS value
        FROM brain_proposals
        WHERE org_id = ${orgId} AND scope_node_id = ANY(${phaseIds as string[]}::uuid[])
          AND field_key IN ('rera.registration_no', 'rera.declared_completion')
          AND state NOT IN ('REJECTED', 'SUPERSEDED')
        ORDER BY scope_node_id, field_key, created_at DESC`,
      // The certificate itself prints the day it was registered ("commencing
      // from"), which no field holds; it is read off the page already read.
      sql<{ node: string; layout: DocLayout | null }[]>`
        SELECT DISTINCT ON (scope_node_id) scope_node_id AS node, layout
        FROM brain_documents
        WHERE org_id = ${orgId} AND scope_node_id = ANY(${phaseIds as string[]}::uuid[]) AND kind = 'RERA_CERTIFICATE' AND layout IS NOT NULL
        ORDER BY scope_node_id, created_at DESC`,
    ]),
  );
  const out: Record<string, { number: string | null; validTo: string | null; registeredOn: string | null }> = {};
  const of = (node: string) => (out[node] ??= { number: null, validTo: null, registeredOn: null });
  for (const r of rows) {
    const o = of(r.node);
    if (r.field === "rera.registration_no") o.number = r.value;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(r.value)) o.validTo = r.value;
  }
  for (const c of certs) {
    const text = (c.layout?.pages ?? []).map((p) => p.segments.map((s) => s.text).join(" ")).join(" ");
    const dates = certificateDates(text);
    if (!dates.registeredOn) continue;
    const o = of(c.node);
    o.registeredOn = dates.registeredOn;
    o.validTo ??= dates.validTo;
  }
  return out;
}

/**
 * Once a phase's registration is recorded, the registration number read off
 * its certificate is the filed one, so the values waiting on it are accepted
 * for the person who recorded it: they could not be accepted before ("This
 * tower has no registration on file yet") and the person has just checked
 * the number against the authority. A different number is left to decide.
 */
export async function acceptFiledNumber(orgId: string, userId: string, phaseId: string, registrationNo: string): Promise<number> {
  const filed = normaliseRegistration(registrationNo);
  if (!filed) return 0;
  const rows = await withTenant(orgId, (sql) => sql<{ id: string; value: string }[]>`
    SELECT id, value FROM brain_proposals
    WHERE org_id = ${orgId} AND scope_node_id = ${phaseId} AND field_key = 'rera.registration_no' AND state = 'PROPOSED'`);
  let accepted = 0;
  for (const r of rows) {
    if (normaliseRegistration(r.value) !== filed) continue;
    const d = await decideProposal({ orgId, userId, proposalId: r.id, decision: { kind: "accept" } });
    if (d.ok) accepted += 1;
  }
  return accepted;
}
