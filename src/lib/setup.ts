/**
 * Setting a project up from its documents, in Ask Jimmy: the files, the
 * reading, the questions, and the making.
 *
 * `setup-rules.ts` decides; this reads, writes and calls the model. Four
 * rules, beside the six there.
 *
 *   1. A setup is a job, never a request. Reading a brochure is a minute or
 *      more of OCR and pictures, so the route answers at once and the work
 *      runs after it (`after()`), under a lease; `npm run extract:run` picks
 *      up a setup a dying process left, where it stopped.
 *   2. Everything is made through the screens' own functions:
 *      `createEntity()`, `createProject()`, `createPhase()`, `addUnitType()`,
 *      `addAsset()`, `tagAsset()`, `saveBrandKit()` and the Brain's own
 *      document filing. Their checks are this setup's checks.
 *   3. The keys held are snapshotted when the person last pressed something
 *      (`permit`), so a worker resuming the job holds no more than they did.
 *   4. Every step the making takes is written down as it lands
 *      (`result.made`), so a second run makes nothing twice.
 */

import sharp from "sharp";
import { audit, withPerson, withTenant } from "./db/index.ts";
import { askJson, designAdDirect, sharpenPicture, sharpenReady, type AskDriver, type DesignDriver, type SharpenDriver } from "./generate.ts";
import { assetKey, sha256, storage } from "./storage.ts";
import { limitsLifted } from "./plan-purchase-rules.ts";
import { gateRefusal, type ProjectGate } from "./plan-purchase-rules.ts";
import { scopeCovers } from "./rbac-rules.ts";
import { MAX_FIRM_MONTH_USD } from "./billing-rules.ts";
import { sniffType, VISION_PAGE_USD, type DocKind } from "./extract-rules.ts";
import { applyAnswer, answerProblem, recap, type Answer, type Draft, type Question } from "./ask-actions-rules.ts";
import {
  FILE_TTL_HOURS,
  FILES_PER_DAY,
  FOUND_SCHEMA,
  FOUND_SYSTEM,
  LIBRARY_LONG_SIDE,
  NO_PERMIT,
  SEEN_SCHEMA,
  SEEN_SYSTEM,
  SETUP_KEEP_DAYS,
  SETUP_LEASE_MINUTES,
  SETUP_MAX_ATTEMPTS,
  SETUP_MAX_FILES,
  SETUP_MAX_PAGES,
  SETUP_PDF_BYTES,
  SETUP_SAID_CHARS,
  SETUP_ZIP_MAX_ENTRIES,
  SETUP_ZIP_TOTAL_BYTES,
  ZIP_TYPE,
  SETUP_MAX_QUESTIONS,
  SETUP_MAX_USD,
  SETUP_MODEL,
  SETUP_MONTH_USD,
  SETUP_PER_DAY,
  SETUP_PICTURE_BATCH,
  SETUP_PICTURE_CALL_USD,
  SETUP_TEXT_CALL_USD,
  SETUP_TTL_DAYS,
  SHARPEN_CALL_USD,
  SHARPEN_MAX,
  POLISH_CALL_USD,
  POLISH_CHECK_SCHEMA,
  POLISH_ATTEMPTS,
  ADDED_CHECK_SCHEMA,
  ADDED_CHECK_SYSTEM,
  reallyAdded,
  SETUP_STEPS_SHOWN,
  setupProjectId,
  standingResult,
  type Standing,
  stepKey,
  type SetupStep,
  POLISH_AT_ONCE,
  BOARD_ALIGNED,
  BOARD_REACH,
  boardRect,
  featherAlpha,
  matchOffset,
  type Board,
  polishCheckSystem,
  POLISH_CHECK_USD,
  POLISH_MAX,
  polishPrompt,
  polishRank,
  polishSize,
  polishVerdict,
  wantsPolish,
  bigEnough,
  reraLine,
  sharpenUsd,
  sharpenedLooksSame,
  wantsSharpen,
  callUsd,
  fileProblem,
  keepPictures,
  logoCandidates,
  logoSized,
  makesSomething,
  pictureTiles,
  planSetup,
  plain,
  previewOf,
  readRegions,
  readerText,
  regionKept,
  regionRect,
  snapRect,
  padFor,
  mainPiece,
  dropSlivers,
  gridCell,
  SETUP_MAX_REGIONS,
  verifyFound,
  withoutSkipped,
  type CtxEntity,
  type CtxProject,
  type PageWords,
  type Permit,
  type Picture,
  type Plan,
  type Proposal,
  type Region,
  type SetupContext,
  type SetupFile,
  type SetupFileType,
  type SetupState,
  type SetupView,
} from "./setup-rules.ts";

// ---------------------------------------------------------------------------
// The model, injectable
// ---------------------------------------------------------------------------

let injected: AskDriver | null = null;

/** For the checks: a model that answers from a script. */
export function useSetupModel(d: AskDriver | null): void {
  injected = d;
}

let injectedSharpener: SharpenDriver | null = null;
/** The checks' seam: a sharpener that answers without Gemini, or null to put the real one back. */
export function useSharpener(d: SharpenDriver | null): void {
  injectedSharpener = d;
}
const sharpener = (): SharpenDriver | null => injectedSharpener ?? (sharpenReady() ? sharpenPicture : null);

let injectedPolisher: DesignDriver | null = null;
/** The checks' seam: a polisher that answers without OpenAI, or null to put the real one back. */
export function usePolisher(d: DesignDriver | null): void {
  injectedPolisher = d;
}
const polisher = (): DesignDriver | null => injectedPolisher ?? (process.env.OPENAI_API_KEY ? designAdDirect : null);

const ask = (): AskDriver => injected ?? askJson;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Who may do what: the keys, snapshotted as paths
// ---------------------------------------------------------------------------

/** The keys a setup needs, and where each is held. */
export const SETUP_KEYS = ["project:create", "unit:manage", "asset:manage", "brain:edit", "brand:manage"] as const;

export type Snapshot = {
  scopes: Record<string, string[]>;
  /** Why a new project cannot be made here, or null. */
  createRefusal: string | null;
  orgType: string;
};

type AuthzLike = { can: (p: string) => boolean; scopesFor: (p: string) => string[] };

/** Whether any part of a setup is open to this person. */
export function maySetUp(authz: AuthzLike): boolean {
  return SETUP_KEYS.slice(0, 4).some((k) => authz.can(k));
}

/** The keys as paths, and the plan's word on a new project, as they stand now. */
export async function snapshot(orgId: string, authz: AuthzLike, orgType: string): Promise<Snapshot> {
  const scopes: Record<string, string[]> = {};
  for (const k of SETUP_KEYS) scopes[k] = authz.scopesFor(k);
  let createRefusal: string | null = null;
  if (!authz.can("project:create")) createRefusal = "You can't add new projects here.";
  else {
    const { gateFor } = await import("./plan-purchase.ts");
    const gate: ProjectGate = await gateFor(orgId, orgType).catch(() => ({ kind: "FREE" }) as ProjectGate);
    const refused = gateRefusal(gate);
    if (refused) {
      createRefusal =
        gate.kind === "BUY_WITH_PROJECT"
          ? "A new project here comes with a plan. Add it on Projects with its plan, then attach these files to it."
          : refused;
    }
  }
  return { scopes, createRefusal, orgType };
}

const holds = (snap: Snapshot, key: string, path: string) => (snap.scopes[key] ?? []).some((s) => scopeCovers(s, path));

function permitAt(snap: Snapshot, path: string): Permit {
  return {
    towers: holds(snap, "project:create", path),
    units: holds(snap, "unit:manage", path),
    pictures: holds(snap, "asset:manage", path),
    documents: holds(snap, "brain:edit", path),
    brand: holds(snap, "brand:manage", path),
  };
}

const anyPermit = (p: Permit) => p.towers || p.units || p.pictures || p.documents;

/** What the person has and may do: the org's entities and projects, and the keys at each. */
async function loadContext(orgId: string, snap: Snapshot): Promise<SetupContext> {
  const { root, entities, projects } = await withTenant(orgId, async (sql) => {
    const [root] = await sql<{ path: string }[]>`SELECT path::text AS path FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`;
    const entities = await sql<{ id: string; name: string; path: string; pan: string | null }[]>`
      SELECT n.id, n.name, n.path::text AS path, d.pan
      FROM scope_nodes n LEFT JOIN entity_details d ON d.scope_node_id = n.id
      WHERE n.org_id = ${orgId} AND n.kind = 'ENTITY' ORDER BY n.created_at`;
    const projects = await sql<{ id: string; name: string; path: string; city: string; entity_id: string; entity_name: string; linked: boolean }[]>`
      SELECT p.id, p.name, p.path::text AS path, r.name AS city, e.id AS entity_id, e.name AS entity_name,
             EXISTS (SELECT 1 FROM linked_nodes l WHERE l.scope_node_id = p.id) AS linked
      FROM scope_nodes p
      JOIN scope_nodes r ON r.id = p.parent_id
      JOIN scope_nodes e ON e.id = r.parent_id
      WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT'
      ORDER BY p.created_at DESC`;
    const towers = await sql<{ id: string; name: string; parent_id: string }[]>`
      SELECT id, name, parent_id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'PHASE' ORDER BY created_at`;
    return {
      root: root?.path ?? "",
      entities,
      projects: projects.map((p) => ({ ...p, towers: towers.filter((t) => t.parent_id === p.id).map((t) => ({ id: t.id, name: t.name })) })),
    };
  });
  const ctxEntities: CtxEntity[] = entities.map((e) => ({ id: e.id, name: e.name, pan: e.pan ?? "", path: e.path }));
  const ctxProjects: CtxProject[] = projects.map((p) => ({ id: p.id, name: p.name, city: p.city, entityId: p.entity_id, entityName: p.entity_name, path: p.path, towers: p.towers }));
  const permitIn: Record<string, Permit> = {};
  for (const p of projects) {
    // A project linked from a developer is the developer's to change.
    if (p.linked) continue;
    const permit = permitAt(snap, p.path);
    if (anyPermit(permit)) permitIn[p.id] = permit;
  }
  const permitUnder: Record<string, Permit> = { "": root ? permitAt(snap, root) : NO_PERMIT };
  for (const e of ctxEntities) permitUnder[e.id] = permitAt(snap, e.path);
  return {
    orgType: snap.orgType,
    entities: ctxEntities,
    projects: ctxProjects,
    canCreate: !snap.createRefusal,
    createRefusal: snap.createRefusal,
    permitUnder,
    permitIn,
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const UPLOAD_SECONDS = 600;
const fileKey = (orgId: string, sha: string) => assetKey({ orgId, project: null, kind: "askfile", id: sha });
const pictureKey = (orgId: string, setupId: string, n: number) => assetKey({ orgId, project: null, kind: "setuppic", id: `${setupId}_${n}` });

export type Begun = { ok: true; id: string; upload: { url: string; headers: Record<string, string> } | null } | { ok: false; message: string };

/** Before a byte is sent: may this file be attached, and where to put it. */
export async function beginFile(o: { orgId: string; userId: string; name: unknown; type: unknown; size: unknown; sha256: unknown; origin: string }): Promise<Begun> {
  const check = fileProblem({ name: o.name, type: o.type, size: o.size, sha256: o.sha256 });
  if (!check.ok) return check;
  const key = fileKey(o.orgId, check.sha256);
  if (!key) return { ok: false, message: "That file cannot be stored." };
  const today = await withPerson(o.orgId, o.userId, (sql) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ask_files
    WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`);
  if (!limitsLifted() && (today[0]?.n ?? 0) >= FILES_PER_DAY) return { ok: false, message: `You have attached ${FILES_PER_DAY} files today. Attach more tomorrow.` };
  const store = storage();
  // The same bytes already in the store need not be sent again.
  const there = store.exists ? await store.exists(key).catch(() => false) : false;
  const [row] = await withPerson(o.orgId, o.userId, (sql) => sql<{ id: string }[]>`
    INSERT INTO ask_files (org_id, user_id, name, media_type, bytes, sha256, storage_key)
    VALUES (${o.orgId}, ${o.userId}, ${check.name}, ${check.type}, ${check.size}, ${check.sha256}, ${key})
    RETURNING id`);
  if (there) return { ok: true, id: row.id, upload: null };
  if (store.uploadUrl) {
    const url = await store.uploadUrl(key, UPLOAD_SECONDS, check.type).catch(() => null);
    if (!url) return { ok: false, message: "Uploads are not available right now. Try again in a minute." };
    return { ok: true, id: row.id, upload: { url, headers: { "content-type": check.type } } };
  }
  const { uploadToken } = await import("./extract.ts");
  const token = uploadToken(key, check.type, Date.now() + UPLOAD_SECONDS * 1000);
  return { ok: true, id: row.id, upload: { url: `${o.origin}/dashboard/ask/files/upload?t=${encodeURIComponent(token)}`, headers: { "content-type": check.type } } };
}

/** A zip waiting to be sent is one file; `pages` is how many PDFs and pictures it holds. */
export type Finished = { ok: true; file: Omit<SetupFile, "type"> & { type: SetupFileType | typeof ZIP_TYPE } } | { ok: false; message: string };

/**
 * The file has landed: check it is what was promised, and count its pages.
 * A zip is only looked into here (its directory, nothing inflated); it is
 * opened into its files when the message is sent (`openZip()`).
 */
export async function finishFile(o: { orgId: string; userId: string; id: string }): Promise<Finished> {
  if (!UUID.test(o.id)) return { ok: false, message: "That file is gone." };
  const [row] = await withPerson(o.orgId, o.userId, (sql) => sql<{ id: string; name: string; media_type: SetupFileType | typeof ZIP_TYPE; bytes: string; sha256: string; storage_key: string; state: string; pages: number | null; problem: string | null }[]>`
    SELECT id, name, media_type, bytes::text, sha256, storage_key, state, pages, problem FROM ask_files WHERE id = ${o.id}`);
  if (!row) return { ok: false, message: "That file is gone." };
  if (row.state === "READY") return { ok: true, file: { id: row.id, name: row.name, type: row.media_type, pages: row.pages } };
  if (row.state === "REFUSED") return { ok: false, message: row.problem ?? "That file could not be read." };
  const refuse = async (message: string): Promise<Finished> => {
    await withPerson(o.orgId, o.userId, (sql) => sql`UPDATE ask_files SET state = 'REFUSED', problem = ${message}, updated_at = now() WHERE id = ${o.id}`);
    return { ok: false, message };
  };
  const bytes = await storage().read(row.storage_key).catch(() => null);
  if (!bytes) return { ok: false, message: `${row.name} did not arrive. Attach it again.` };
  if (sha256(bytes) !== row.sha256 || bytes.byteLength !== Number(row.bytes)) return refuse(`${row.name} changed on the way. Attach it again.`);
  if (row.media_type === ZIP_TYPE) {
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return refuse(`${row.name} is not a zip this can open.`);
    const { zipListing } = await import("./unzip.ts");
    const listed = zipListing(bytes);
    if (!listed.ok) return refuse(`${row.name} ${listed.message}`);
    if (!listed.readable) return refuse(`${row.name} holds no PDF or picture (JPEG, PNG or WebP).`);
    await withPerson(o.orgId, o.userId, (sql) => sql`UPDATE ask_files SET state = 'READY', pages = ${listed.readable}, updated_at = now() WHERE id = ${o.id}`);
    return { ok: true, file: { id: row.id, name: row.name, type: ZIP_TYPE, pages: listed.readable } };
  }
  const sniffed = sniffType(bytes);
  if (!sniffed || sniffed !== row.media_type) return refuse(`${row.name} is not a PDF or a picture this can read.`);
  const { inspectDocument } = await import("./pdf-read.ts");
  const inspected = await inspectDocument(bytes, sniffed);
  if (!inspected.ok) return refuse(`${row.name}: ${inspected.message}`);
  await withPerson(o.orgId, o.userId, (sql) => sql`UPDATE ask_files SET state = 'READY', pages = ${inspected.pages}, updated_at = now() WHERE id = ${o.id}`);
  return { ok: true, file: { id: row.id, name: row.name, type: row.media_type, pages: inspected.pages } };
}

/**
 * A zip, opened when its message is sent: every PDF and picture inside it
 * becomes a file of its own, checked as one attached alone would be, and the
 * zip's own row goes. What could not be used (another kind of file, one too
 * large, past the count) is said in one line, never silently dropped.
 */
async function openZip(o: { orgId: string; userId: string }, zip: { id: string; name: string; storage_key: string }): Promise<{ ok: true; ids: string[]; note: string | null } | { ok: false; message: string }> {
  const bytes = await storage().read(zip.storage_key).catch(() => null);
  if (!bytes) return { ok: false, message: `${zip.name} is no longer here. Attach it again.` };
  const { unzip } = await import("./unzip.ts");
  const opened = unzip(bytes, { maxEntries: SETUP_ZIP_MAX_ENTRIES * 3, maxEntryBytes: SETUP_PDF_BYTES, maxTotalBytes: SETUP_ZIP_TOTAL_BYTES });
  if (!opened.ok) return { ok: false, message: `${zip.name} ${opened.message}` };
  const { inspectDocument } = await import("./pdf-read.ts");
  const ids: string[] = [];
  let left = opened.skipped;
  const seen = new Set<string>();
  for (const e of opened.entries) {
    const type = sniffType(e.bytes);
    const check = type ? fileProblem({ name: e.name, type, size: e.bytes.length, sha256: sha256(e.bytes) }) : null;
    if (!type || !check?.ok || ids.length >= SETUP_ZIP_MAX_ENTRIES || seen.has(check.sha256)) {
      left += 1;
      continue;
    }
    seen.add(check.sha256);
    const inspected = await inspectDocument(e.bytes, type).catch(() => null);
    const key = fileKey(o.orgId, check.sha256);
    if (!inspected?.ok || !key) {
      left += 1;
      continue;
    }
    const there = storage().exists ? await storage().exists!(key).catch(() => false) : false;
    if (!there) await storage().put(key, e.bytes, type);
    const [made] = await withPerson(o.orgId, o.userId, (sql) => sql<{ id: string }[]>`
      INSERT INTO ask_files (org_id, user_id, name, media_type, bytes, sha256, storage_key, state, pages)
      VALUES (${o.orgId}, ${o.userId}, ${check.name}, ${type}, ${e.bytes.length}, ${check.sha256}, ${key}, 'READY', ${inspected.pages})
      RETURNING id`);
    ids.push(made.id);
  }
  if (!ids.length) return { ok: false, message: `${zip.name} holds no PDF or picture (JPEG, PNG or WebP) this can read.` };
  // The zip's own row goes; its bytes are swept with any other file no row names.
  await withPerson(o.orgId, o.userId, (sql) => sql`DELETE FROM ask_files WHERE id = ${zip.id} AND setup_id IS NULL`);
  const note = left ? `${left === 1 ? "1 file" : `${left} files`} in ${zip.name} could not be used: a setup reads PDFs and JPEG, PNG or WebP pictures, ${SETUP_ZIP_MAX_ENTRIES} from a zip at most.` : null;
  return { ok: true, ids, note };
}

/** A file taken off before it was sent. One a setup was read from stays. */
export async function removeFile(o: { orgId: string; userId: string; id: string }): Promise<boolean> {
  if (!UUID.test(o.id)) return false;
  const gone = await withPerson(o.orgId, o.userId, (sql) => sql`DELETE FROM ask_files WHERE id = ${o.id} AND setup_id IS NULL RETURNING id`);
  return gone.length > 0;
}

/** The files a message carried, for the chat to show beside it. */
export async function filesNamed(orgId: string, userId: string, ids: readonly string[]): Promise<{ id: string; name: string; type: string }[]> {
  const clean = ids.filter((x) => UUID.test(x)).slice(0, SETUP_MAX_FILES);
  if (!clean.length) return [];
  return withPerson(orgId, userId, (sql) => sql<{ id: string; name: string; type: string }[]>`
    SELECT id, name, media_type AS type FROM ask_files WHERE id = ANY(${clean}::uuid[]) ORDER BY created_at`);
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  thread_id: string;
  state: SetupState;
  said: string;
  reading: Reading;
  pictures: Picture[];
  proposal: Proposal | null;
  inputs: Draft;
  questions: Question[];
  plan: Plan | null;
  permit: (Snapshot & { skip?: number[] }) | null;
  result: SetupResult | null;
  stage: string | null;
  progress: number | null;
  activity: SetupStep[];
  attempts: number;
  cost_usd: string;
  calls: number;
  updated_at: Date;
  created_at: Date;
};

type Reading = {
  files?: Record<string, { pages: string[]; done: boolean; total: number }>;
  read?: number;
  looked?: number[];
  /** What reading pages without a text layer cost: held to the month, not to the setup's own budget. */
  pagesUsd?: number;
};

type Made = {
  entityId?: string;
  projectId?: string;
  towers?: Record<string, string>;
  units?: Record<string, string>;
  pictures?: Record<string, string>;
  documents?: Record<string, { documentId: string; extractionId: string | null }>;
  contact?: boolean;
  /** The logo, once it was set or found already set. */
  logo?: "SET" | "HAD" | "MISSING";
  /** Pictures sharpened, by number. */
  sharpened?: number[];
  /** Pictures cleaned, by number, with what was taken out of each (setups before polishing). */
  cleaned?: { n: number; removed: string[] }[];
  /** Damage or a fitting seen on a picture and left as it is (setups before polishing). */
  leftFlaws?: string[];
  /** Photographs polished for ads, by number. */
  polished?: number[];
  /** Photographs that went in as they came, and why. */
  notPolished?: { n: number; title: string; why: string }[];
  /** What the person typed beside the files, filed as the developer's notes: its document, or why not. */
  note?: string;
  problems?: string[];
};
type SetupResult = { message: string; lines: string[]; links: { label: string; href: string }[]; made?: Made };

const COLS = "id, thread_id, state, said, reading, pictures, proposal, inputs, questions, plan, permit, result, stage, progress, activity, attempts, cost_usd::text, calls, updated_at, created_at";

async function load(orgId: string, userId: string, id: string): Promise<Row | null> {
  if (!UUID.test(id)) return null;
  const [row] = await withPerson(orgId, userId, (sql) => sql<Row[]>`SELECT ${sql.unsafe(COLS)} FROM project_setups WHERE id = ${id}`);
  return row ?? null;
}

type Patch = Partial<Pick<Row, "state" | "reading" | "pictures" | "proposal" | "inputs" | "questions" | "plan" | "permit" | "result" | "stage" | "progress">> & {
  addUsd?: number;
  addCalls?: number;
  lease?: "keep" | "drop";
  error?: string | null;
  /** A line for the card: replaces the line with its key, or is added last. A stage says one by itself. */
  say?: SetupStep;
  /** Start the card's lines afresh (a new reading, or the confirm press). */
  freshSteps?: boolean;
};

async function save(orgId: string, userId: string, id: string, p: Patch, guard?: SetupState): Promise<Row | null> {
  // A new stage is a line of its own, and the step before it is done.
  const say: SetupStep | null = p.say ?? (p.stage ? { k: stepKey(p.stage), t: p.stage, s: "doing" } : null);
  const step = !!say && say.s === "doing" && !say.k.startsWith("pic:");
  const item = say ? JSON.stringify(say) : null;
  const [row] = await withPerson(orgId, userId, (sql) => sql<Row[]>`
    UPDATE project_setups SET
      state = coalesce(${p.state ?? null}, state),
      reading = ${p.reading ? sql.json(p.reading as never) : sql`reading`},
      pictures = ${p.pictures ? sql.json(p.pictures as never) : sql`pictures`},
      proposal = ${p.proposal !== undefined ? (p.proposal ? sql.json(p.proposal as never) : null) : sql`proposal`},
      inputs = ${p.inputs ? sql.json(p.inputs as never) : sql`inputs`},
      questions = ${p.questions ? sql.json(p.questions as never) : sql`questions`},
      plan = ${p.plan !== undefined ? (p.plan ? sql.json(p.plan as never) : null) : sql`plan`},
      permit = ${p.permit !== undefined ? (p.permit ? sql.json(p.permit as never) : null) : sql`permit`},
      result = ${p.result !== undefined ? (p.result ? sql.json(p.result as never) : null) : sql`result`},
      stage = ${p.stage !== undefined ? p.stage : sql`stage`},
      progress = ${p.progress !== undefined ? p.progress : sql`progress`},
      activity = ${
        item
          ? sql`(
              WITH cur AS (
                SELECT CASE WHEN ${step} THEN (
                  SELECT coalesce(jsonb_agg(CASE WHEN e->>'s' = 'doing' AND e->>'k' NOT LIKE 'pic:%' AND e->>'k' <> ${say!.k} THEN e || '{"s":"done"}'::jsonb ELSE e END ORDER BY i), '[]'::jsonb)
                  FROM jsonb_array_elements(${p.freshSteps ? sql`'[]'::jsonb` : sql`activity`}) WITH ORDINALITY t(e, i)
                ) ELSE ${p.freshSteps ? sql`'[]'::jsonb` : sql`activity`} END AS a
              )
              SELECT CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(cur.a) x WHERE x->>'k' = ${say!.k})
                THEN (SELECT jsonb_agg(CASE WHEN e->>'k' = ${say!.k} THEN ${sql.json(say as never)} ELSE e END ORDER BY i) FROM jsonb_array_elements(cur.a) WITH ORDINALITY t(e, i))
                ELSE cur.a || jsonb_build_array(${sql.json(say as never)}) END
              FROM cur
            )`
          : p.freshSteps
            ? sql`'[]'::jsonb`
            : sql`activity`
      },
      cost_usd = cost_usd + ${p.addUsd ?? 0},
      calls = calls + ${p.addCalls ?? 0},
      error = ${p.error !== undefined ? p.error : sql`error`},
      lease_until = ${p.lease === "drop" ? null : p.lease === "keep" ? sql`now() + ${`${SETUP_LEASE_MINUTES} minutes`}::interval` : sql`lease_until`},
      confirmed_at = CASE WHEN ${p.state ?? null} = 'CREATING' THEN now() ELSE confirmed_at END,
      finished_at = CASE WHEN ${p.state ?? null} IN ('DONE', 'FAILED', 'CANCELLED', 'EXPIRED') THEN now() ELSE finished_at END,
      updated_at = now()
    WHERE id = ${id} AND ${guard ? sql`state = ${guard}` : sql`true`}
    RETURNING ${sql.unsafe(COLS)}`);
  return row ?? null;
}

async function setupFiles(orgId: string, userId: string, setupId: string): Promise<(SetupFile & { key: string; sha256: string; bytes: number })[]> {
  const rows = await withPerson(orgId, userId, (sql) => sql<{ id: string; name: string; media_type: SetupFileType; pages: number | null; storage_key: string; sha256: string; bytes: string }[]>`
    SELECT id, name, media_type, pages, storage_key, sha256, bytes::text FROM ask_files WHERE setup_id = ${setupId} AND state = 'READY' ORDER BY created_at`);
  return rows.map((r) => ({ id: r.id, name: r.name, type: r.media_type, pages: r.pages, key: r.storage_key, sha256: r.sha256, bytes: Number(r.bytes) }));
}

/** Dollars this organisation's setups spent this IST month, and its document reading too for a channel partner. */
async function monthSpend(orgId: string): Promise<{ usd: number; cap: number }> {
  const [row] = await withTenant(orgId, (sql) => sql<{ partner: boolean; setups: string | null; reading: string | null }[]>`
    SELECT o.type = 'CHANNEL_PARTNER' AS partner,
           (SELECT sum(s.cost_usd) FROM project_setups s WHERE s.org_id = o.id
             AND s.created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'))::text AS setups,
           (SELECT sum(e.cost_usd) FROM brain_extractions e WHERE e.org_id = o.id
             AND e.created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'))::text AS reading
    FROM orgs o WHERE o.id = ${orgId}`);
  const setups = Number(row?.setups ?? 0) || 0;
  // A channel partner's setups draw on the firm's one document budget.
  return row?.partner ? { usd: setups + (Number(row.reading ?? 0) || 0), cap: MAX_FIRM_MONTH_USD } : { usd: setups, cap: SETUP_MONTH_USD };
}

export type Started = { ok: true; id: string; added: boolean; note?: string } | { ok: false; message: string };

/**
 * A setup, from the files a message carried. Files sent to a chat whose setup
 * is still open join it, and it is read again with them; any other way, a
 * new setup is started. Refused before anything is read: someone working
 * through a mandate, a file that is not theirs or not ready, too many files,
 * the day's setups, the month's dollars.
 */
export async function startSetup(o: {
  orgId: string;
  userId: string;
  threadId: string;
  said: string;
  fileIds: readonly string[];
  authz: AuthzLike;
  orgType: string;
  via?: { firmOrgId: string } | null;
}): Promise<Started> {
  if (o.via) return { ok: false, message: "Set projects up from your own console. Here you work the developer's projects as they are." };
  if (!maySetUp(o.authz)) return { ok: false, message: "You can't add projects, towers, pictures or documents here. Ask your admin if you need to." };
  const [settings] = await withTenant(o.orgId, (sql) => sql<{ actions_on: boolean }[]>`SELECT actions_on FROM ask_settings WHERE org_id = ${o.orgId}`);
  if (settings && !settings.actions_on) return { ok: false, message: "Jimmy is not allowed to take actions here. An admin can switch this on in Settings." };
  let ids = [...new Set(o.fileIds.filter((x) => UUID.test(x)))];
  if (!ids.length) return { ok: false, message: "Attach a file first." };
  if (ids.length > SETUP_MAX_FILES) return { ok: false, message: `Attach up to ${SETUP_MAX_FILES} files at once.` };
  const files = await withPerson(o.orgId, o.userId, (sql) => sql<{ id: string; state: string; setup_id: string | null; name: string; problem: string | null; media_type: string; storage_key: string }[]>`
    SELECT id, state, setup_id, name, problem, media_type, storage_key FROM ask_files WHERE id = ANY(${ids}::uuid[])`);
  if (files.length !== ids.length) return { ok: false, message: "A file is no longer attached. Attach it again." };
  const bad = files.find((f) => f.state !== "READY" || f.setup_id);
  if (bad) return { ok: false, message: bad.state === "REFUSED" ? bad.problem ?? `${bad.name} could not be read.` : bad.setup_id ? `${bad.name} was already sent.` : `${bad.name} is still uploading.` };
  // A zip is opened now that it is sent, into a file per PDF and picture.
  const notes: string[] = [];
  for (const z of files.filter((f) => f.media_type === ZIP_TYPE)) {
    const opened = await openZip(o, z);
    if (!opened.ok) return opened;
    ids = [...ids.filter((x) => x !== z.id), ...opened.ids];
    if (opened.note) notes.push(opened.note);
  }
  if (ids.length > SETUP_MAX_FILES) return { ok: false, message: `A setup reads up to ${SETUP_MAX_FILES} files, and these hold ${ids.length}. Send fewer at a time.` };
  const note = notes.join(" ") || undefined;

  const snap = await snapshot(o.orgId, o.authz, o.orgType);
  const open = await withPerson(o.orgId, o.userId, (sql) => sql<{ id: string; files: number }[]>`
    SELECT s.id, (SELECT count(*)::int FROM ask_files f WHERE f.setup_id = s.id) AS files
    FROM project_setups s WHERE s.thread_id = ${o.threadId} AND s.state IN ('READING', 'ASKING', 'READY')
    ORDER BY s.created_at DESC LIMIT 1`);
  if (open[0]) {
    if (open[0].files + ids.length > SETUP_MAX_FILES) return { ok: false, message: `A setup reads up to ${SETUP_MAX_FILES} files. Start a new chat for the rest.` };
    await withPerson(o.orgId, o.userId, async (sql) => {
      await sql`UPDATE ask_files SET setup_id = ${open[0].id}, updated_at = now() WHERE id = ANY(${ids}::uuid[]) AND setup_id IS NULL`;
      await sql`
        UPDATE project_setups SET state = 'READING', proposal = NULL, plan = NULL, questions = '[]'::jsonb,
               said = left(trim(said || E'\n' || ${o.said}), ${SETUP_SAID_CHARS}), permit = ${sql.json(snap as never)},
               attempts = 0, lease_until = NULL, stage = 'Reading the new files', progress = 5, updated_at = now(),
               activity = '[{"k": "reading the new files", "t": "Reading the new files", "s": "doing"}]'::jsonb
        WHERE id = ${open[0].id}`;
    });
    await audit({ orgId: o.orgId, actorUserId: o.userId, action: "setup.files_added", targetType: "project_setup", targetId: open[0].id, metadata: { files: ids.length } });
    return { ok: true, id: open[0].id, added: true, note };
  }

  if (!limitsLifted()) {
    const [today] = await withPerson(o.orgId, o.userId, (sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_setups
      WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`);
    if ((today?.n ?? 0) >= SETUP_PER_DAY) return { ok: false, message: `You have set up ${SETUP_PER_DAY} projects from files today. Do more tomorrow.` };
  }
  const month = await monthSpend(o.orgId);
  if (month.usd + SETUP_TEXT_CALL_USD > month.cap) return { ok: false, message: "This month's reading of documents is used up. It opens again on the 1st." };

  const [row] = await withPerson(o.orgId, o.userId, async (sql) => {
    const made = await sql<{ id: string }[]>`
      INSERT INTO project_setups (org_id, user_id, thread_id, said, permit, stage, progress)
      VALUES (${o.orgId}, ${o.userId}, ${o.threadId}, ${o.said.slice(0, SETUP_SAID_CHARS)}, ${sql.json(snap as never)}, 'Reading your files', 2)
      RETURNING id`;
    await sql`UPDATE ask_files SET setup_id = ${made[0].id}, updated_at = now() WHERE id = ANY(${ids}::uuid[]) AND setup_id IS NULL`;
    return made;
  });
  await audit({ orgId: o.orgId, actorUserId: o.userId, action: "setup.started", targetType: "project_setup", targetId: row.id, metadata: { files: ids.length } });
  return { ok: true, id: row.id, added: false, note };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A picture with nothing in it: a flat colour, a blank frame. */
export async function isBlank(jpeg: Buffer, floor = 3.5): Promise<boolean> {
  const s = await sharp(jpeg).greyscale().resize(256, 256, { fit: "inside" }).stats().catch(() => null);
  return !s || s.entropy < floor;
}

type Candidate = Omit<Picture, "n" | "key"> & { jpeg: Buffer | null; key?: string; n?: number };

/**
 * Read a setup's files: the words on every page, every picture worth a look,
 * what the model sees in each picture, and what the words say about the
 * project. Claimed under a lease; what is done is saved as it goes, so a
 * second run carries on where the first stopped.
 */
export async function readSetup(orgId: string, userId: string, id: string): Promise<void> {
  const [claim] = await withPerson(orgId, userId, (sql) => sql<Row[]>`
    UPDATE project_setups SET attempts = attempts + 1, lease_until = now() + ${`${SETUP_LEASE_MINUTES} minutes`}::interval, updated_at = now()
    WHERE id = ${id} AND state = 'READING' AND attempts < ${SETUP_MAX_ATTEMPTS} AND (lease_until IS NULL OR lease_until < now())
    RETURNING ${sql.unsafe(COLS)}`);
  if (!claim) return;
  try {
    await readClaimed(orgId, userId, claim);
  } catch (e) {
    console.error("setup: reading failed", e);
    const last = claim.attempts >= SETUP_MAX_ATTEMPTS;
    await save(orgId, userId, id, last
      ? { state: "FAILED", result: { message: "Those files could not be read. Try attaching them again, or one at a time.", lines: [], links: [] }, lease: "drop", error: String((e as Error)?.message ?? e).slice(0, 300) }
      : { lease: "drop", error: String((e as Error)?.message ?? e).slice(0, 300) }, "READING");
  }
}

async function readClaimed(orgId: string, userId: string, row: Row): Promise<void> {
  const id = row.id;
  const files = await setupFiles(orgId, userId, id);
  if (!files.length) {
    await save(orgId, userId, id, { state: "FAILED", result: { message: "There are no files to read.", lines: [], links: [] }, lease: "drop" }, "READING");
    return;
  }
  const { readPages, readPictures, pictureHash } = await import("./pdf-read.ts");
  const reading: Reading = { files: { ...(row.reading?.files ?? {}) }, read: row.reading?.read ?? 0, looked: row.reading?.looked ?? [], pagesUsd: row.reading?.pagesUsd ?? 0 };
  let pictures: Picture[] = [...(row.pictures ?? [])];
  let usd = Number(row.cost_usd) || 0;
  // A page with no text layer is read by the vision model, refused before
  // it is sent once the month is spent.
  const monthAtStart = await monthSpend(orgId);
  const spentAtStart = usd;
  const pageAffordable = () => {
    if (monthAtStart.usd + (usd - spentAtStart) + VISION_PAGE_USD > monthAtStart.cap) throw new Error("the month's reading is spent");
  };
  const progress = (stage: string, pct: number) => save(orgId, userId, id, { stage, progress: Math.max(1, Math.min(99, Math.round(pct))), lease: "keep" });

  // 1. The words and the pictures, file by file.
  for (const [i, f] of files.entries()) {
    const had = reading.files![f.id];
    if (had?.done) continue;
    await progress(`Reading ${f.name}`, 5 + (i / files.length) * 45);
    const bytes = await storage().read(f.key);
    if (!bytes) throw new Error(`file ${f.id} missing from the store`);
    const budget = Math.max(0, SETUP_MAX_PAGES - (reading.read ?? 0));
    const total = f.type === "application/pdf" ? Math.min(f.pages ?? 1, budget) : 1;
    const text: string[] = had?.pages ?? [];
    const found: (Candidate & { edge?: boolean })[] = [];
    if (total > 0) {
      const pages = Array.from({ length: total }, (_, k) => k + 1);
      const todo = pages.filter((n) => text[n - 1] === undefined);
      let since = 0;
      await readPages(bytes, f.type, todo, async (p) => {
        text[p.n - 1] = p.segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").slice(0, 6000);
        if (p.usd) {
          usd += p.usd;
          reading.pagesUsd = (reading.pagesUsd ?? 0) + p.usd;
          await save(orgId, userId, id, { addUsd: p.usd, addCalls: 1 });
        }
        since += 1;
        if (since >= 5) {
          since = 0;
          reading.files![f.id] = { pages: text, done: false, total };
          await save(orgId, userId, id, { reading, lease: "keep", stage: `Reading ${f.name}, page ${p.n} of ${total}` });
        }
      }, { beforePaid: pageAffordable });
      if (f.type === "application/pdf") {
        const chars = (n: number) => (text[n - 1] ?? "").length;
        for (const p of await readPictures(bytes, pages, { textChars: chars, minSide: 60 })) {
          found.push({ file: f.id, page: p.page, width: p.width, height: p.height, hash: "", source: p.source, near: (text[p.page - 1] ?? "").slice(0, 500), jpeg: p.jpeg, edge: p.page <= 2 || p.page >= total - 1 });
        }
      } else {
        const jpeg = await sharp(bytes).rotate().flatten({ background: "#ffffff" }).resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
        found.push({ file: f.id, page: 1, width: jpeg.info.width, height: jpeg.info.height, hash: "", source: "upload", near: (text[0] ?? "").slice(0, 500), jpeg: jpeg.data });
      }
    }
    // Keep the pictures worth a look, across every file read so far.
    const fresh: Candidate[] = [];
    // A logo is small and sits on the cover or the back page, so it is kept
    // apart from the pictures, which a small mark would never pass for.
    const small: Candidate[] = [];
    for (const c of found) {
      if (!c.jpeg) continue;
      const { edge, ...rest } = c;
      if (bigEnough(c.width, c.height)) {
        if (await isBlank(c.jpeg)) continue;
        fresh.push({ ...rest, hash: await pictureHash(c.jpeg) });
      } else if (edge && logoSized(c.width, c.height) && !(await isBlank(c.jpeg, 1.5))) {
        small.push({ ...rest, hash: await pictureHash(c.jpeg) });
      }
    }
    const pool: Candidate[] = [...pictures.map((p) => ({ ...p, jpeg: null })), ...fresh];
    const kept = [...keepPictures(pool), ...logoCandidates(small, [...pictures, ...fresh])];
    let next = pictures.reduce((m, p) => Math.max(m, p.n), 0) + 1;
    const out: Picture[] = [];
    for (const c of kept) {
      if (c.key && c.n) {
        out.push(c as Picture);
        continue;
      }
      const n = next++;
      const key = pictureKey(orgId, id, n);
      if (!key || !c.jpeg) continue;
      await storage().put(key, c.jpeg, "image/jpeg");
      const { jpeg: _drop, ...rest } = c;
      out.push({ ...rest, n, key } as Picture);
    }
    pictures = out;
    reading.files![f.id] = { pages: text, done: true, total };
    reading.read = (reading.read ?? 0) + total;
    const got = out.filter((p) => p.file === f.id).length;
    await save(orgId, userId, id, { reading, pictures, lease: "keep", say: { k: `read:${f.id}`, t: `Read ${f.name}${f.type === "application/pdf" ? `: ${total} ${total === 1 ? "page" : "pages"}` : ""}${got ? `, ${got} ${got === 1 ? "picture" : "pictures"} worth a look` : ""}`, s: "done" } });
  }

  // 2. What the words say about the project. Asked first: it matters most.
  const pagesRead: PageWords[] = [];
  for (const f of files) (reading.files![f.id]?.pages ?? []).forEach((t, k) => t && pagesRead.push({ file: f.id, page: k + 1, text: t }));
  const month = await monthSpend(orgId);
  // The month as read now, plus what this run spends after it.
  const usdAtMonth = usd;
  const affordable = (est: number) => usd - (reading.pagesUsd ?? 0) + est <= SETUP_MAX_USD && month.usd + (usd - usdAtMonth) + est <= month.cap;
  let proposal = row.proposal;
  if (!proposal) {
    if (!affordable(SETUP_TEXT_CALL_USD)) {
      await save(orgId, userId, id, { state: "FAILED", result: { message: "This month's reading of documents is used up. It opens again on the 1st.", lines: [], links: [] }, lease: "drop" }, "READING");
      return;
    }
    await progress("Working out the project", 55);
    const text = pagesRead.length || row.said.trim() ? readerText(files, pagesRead, row.said) : "";
    if (text) {
      const answer = await ask()({ model: SETUP_MODEL, name: "project_from_files", system: FOUND_SYSTEM, effort: "low", schema: FOUND_SCHEMA as unknown as Record<string, unknown>, parts: [{ text }], timeoutMs: 180_000 });
      const cost = answer.ok && answer.usage ? callUsd(answer.usage.tokensIn, answer.usage.tokensOut) : SETUP_TEXT_CALL_USD;
      usd += cost;
      await save(orgId, userId, id, { addUsd: cost, addCalls: 1, lease: "keep" });
      if (!answer.ok) {
        if (answer.code === "NO_KEY") {
          await save(orgId, userId, id, { state: "FAILED", result: { message: "Reading files is not switched on here.", lines: [], links: [] }, lease: "drop" }, "READING");
          return;
        }
        throw new Error(`the reader refused: ${answer.code}`);
      }
      // What the person typed beside the files counts as printed: it is their own word, and a person still checks it.
      const typed: PageWords[] = row.said.trim() ? [{ file: "said", page: 0, text: row.said }] : [];
      proposal = verifyFound(answer.value, [...pagesRead, ...typed], files.map((f) => f.id));
    } else {
      proposal = { projects: [], kinds: Object.fromEntries(files.map((f) => [f.id, null])), askedProject: "", askedTower: "", dropped: 0 };
    }
    const named = proposal.projects[0];
    await save(orgId, userId, id, {
      proposal,
      lease: "keep",
      say: named
        ? { k: "project", t: `Found ${named.name}${named.locality || named.city ? `, ${[named.locality, named.city].filter(Boolean).join(", ")}` : ""}${named.towers.length ? `, ${named.towers.length} ${named.towers.length === 1 ? "tower" : "towers"}` : ""}${named.configs.length ? `, ${[...new Set(named.configs.map((c) => c.config.replace("BHK", " BHK")))].join(", ")}` : ""}`, s: "done" }
        : { k: "project", t: "The files do not name the project; I will ask", s: "note" },
    });
  }

  // 3. What is on each picture, a few at a time. A brochure page is usually
  // one image holding several pictures, headings and text: each picture on
  // it is cut out on its own, and the page itself is kept out of the library.
  const unseen = pictures.filter((p) => p.seen === undefined);
  let cutSoFar = pictures.filter((p) => p.from).length;
  let nextN = pictures.reduce((m, p) => Math.max(m, p.n), 0) + 1;
  for (let b = 0; b < unseen.length; b += SETUP_PICTURE_BATCH) {
    const batch = unseen.slice(b, b + SETUP_PICTURE_BATCH);
    if (!affordable(SETUP_PICTURE_CALL_USD)) {
      for (const p of batch) p.seen = null;
      continue;
    }
    await progress(`Looking at the pictures, ${Math.min(b + batch.length, unseen.length)} of ${unseen.length}`, 65 + (b / Math.max(1, unseen.length)) * 30);
    const parts: ({ text: string } | { image: { bytes: Buffer; type: string; detail: "low" | "high" } })[] = [];
    const sources = new Map<number, Buffer>();
    for (const p of batch) {
      const bytes = await storage().read(p.key);
      if (!bytes) continue;
      sources.set(p.n, bytes);
      parts.push({ text: `Image ${p.n} (page ${p.page}). Words on its page: ${p.near.slice(0, 400) || "none"}` });
      parts.push({ image: { bytes: await gridView(bytes), type: "image/jpeg", detail: "high" } });
    }
    if (!parts.length) continue;
    const answer = await ask()({ model: SETUP_MODEL, name: "pictures", system: SEEN_SYSTEM, effort: "low", schema: SEEN_SCHEMA as unknown as Record<string, unknown>, parts, timeoutMs: 180_000 });
    const cost = answer.ok && answer.usage ? callUsd(answer.usage.tokensIn, answer.usage.tokensOut) : SETUP_PICTURE_CALL_USD;
    usd += cost;
    const named = answer.ok ? readRegions(answer.value, batch.map((p) => p.n)) : new Map<number, Region[]>();
    const cuts: Picture[] = [];
    for (const p of batch) {
      const regions = named.get(p.n);
      const bytes = sources.get(p.n);
      if (!regions || !bytes) {
        p.seen = null;
        continue;
      }
      // Even a page that is one picture is cut: its heading, labels and margin go.
      const kept = regions.filter((r) => r.use !== "SKIP");
      const ink = kept.length ? await pageGreys(bytes) : undefined;
      p.seen = { use: "SKIP", title: kept[0]?.title ?? "Page", photo: false, room: "", config: "", carpet: 0, tower: "", crop: null, why: kept.length ? `Cut into ${kept.length}` : regions[0]?.why || "No picture on it" };
      for (const r of kept) {
        if (cutSoFar >= SETUP_MAX_REGIONS) break;
        const cut = await cutRegion(bytes, r, ink).catch(() => null);
        if (!cut) continue;
        const fits = r.use === "LOGO" ? logoSized(cut.width, cut.height) : regionKept(cut.width, cut.height);
        if (!fits || (await isBlank(cut.jpeg, r.use === "LOGO" ? 1.5 : 3.5))) continue;
        const n = nextN++;
        const key = pictureKey(orgId, id, n);
        if (!key) continue;
        await storage().put(key, cut.jpeg, "image/jpeg");
        const { box: _b, ...seen } = r;
        cuts.push({ n, key, file: p.file, page: p.page, width: cut.width, height: cut.height, hash: await pictureHash(cut.jpeg), source: p.source, near: p.near, seen: { ...seen, crop: null }, from: p.n });
        cutSoFar += 1;
      }
    }
    pictures = [...pictures, ...cuts];
    await save(orgId, userId, id, { pictures, addUsd: cost, addCalls: 1, lease: "keep", ...(cutSoFar ? { say: { k: "cuts", t: `Cut ${cutSoFar} ${cutSoFar === 1 ? "picture" : "pictures"} out of the brochure pages`, s: "done" as const } } : {}) });
  }

  // 4. Every photograph it will file, polished now, so the card shows it as it will be filed.
  await polishSetupPictures(orgId, userId, id, pictures, (stage) => save(orgId, userId, id, { stage, progress: 96, lease: "keep" }));

  // 5. What it needs from the person, or what it will make.
  await save(orgId, userId, id, { pictures, stage: null, progress: null }, "READING");
  const fresh = await load(orgId, userId, id);
  if (fresh) await decide(orgId, userId, fresh, { from: "READING" });
}

/** Ask, refuse, or show the plan, from the answers so far. */
async function decide(orgId: string, userId: string, row: Row, o: { from: SetupState; review?: boolean }): Promise<Row> {
  const snap = row.permit;
  if (!snap || !row.proposal) return row;
  const ctx = await loadContext(orgId, snap);
  const files = await setupFiles(orgId, userId, row.id);
  const d: Draft = { filled: { ...(row.inputs?.filled ?? {}) }, hints: { ...(row.inputs?.hints ?? {}) } };
  const step = planSetup({ proposal: row.proposal, pictures: row.pictures ?? [], files, ctx, d, skip: snap.skip ?? [], review: o.review });
  if ("ask" in step) {
    return (await save(orgId, userId, row.id, { state: "ASKING", inputs: d, questions: step.ask.slice(0, SETUP_MAX_QUESTIONS), plan: null, lease: "drop" }, o.from)) ?? row;
  }
  if ("refuse" in step) {
    return (await save(orgId, userId, row.id, { state: "FAILED", inputs: d, questions: [], result: { message: step.refuse, lines: [], links: [] }, lease: "drop" }, o.from)) ?? row;
  }
  if (!makesSomething(step.ready)) {
    const why = step.ready.notes.length ? ` ${step.ready.notes.join(" ")}` : "";
    return (await save(orgId, userId, row.id, { state: "FAILED", inputs: d, questions: [], result: { message: `There is nothing new in these files to add.${why}`, lines: [], links: [] }, lease: "drop" }, o.from)) ?? row;
  }
  return (await save(orgId, userId, row.id, { state: "READY", inputs: d, questions: [], plan: step.ready, lease: "drop" }, o.from)) ?? row;
}

// ---------------------------------------------------------------------------
// The card's buttons
// ---------------------------------------------------------------------------

export type SetupCtx = { orgId: string; userId: string; authz: AuthzLike; orgType: string; via?: { firmOrgId: string } | null };

export type Acted = { ok: true; view: SetupView; later?: () => Promise<void> } | { ok: false; message: string };

const expired = (row: Row) =>
  (row.state === "ASKING" || row.state === "READY") && Date.now() - new Date(row.updated_at).getTime() > SETUP_TTL_DAYS * 86_400_000;

async function fresh(c: SetupCtx, id: string): Promise<Row | null> {
  const row = await load(c.orgId, c.userId, id);
  if (row && expired(row)) return (await save(c.orgId, c.userId, id, { state: "EXPIRED", result: { message: "This expired. Attach the files again to set the project up.", lines: [], links: [] } }, row.state)) ?? row;
  return row;
}

/** The person answered the questions on the card. */
export async function answerSetup(c: SetupCtx, id: string, answers: Answer[]): Promise<Acted> {
  const row = await fresh(c, id);
  if (!row) return { ok: false, message: "That card is gone." };
  if (row.state !== "ASKING") return { ok: true, view: await viewOf(c.orgId, c.userId, row) };
  let d: Draft = { filled: { ...(row.inputs?.filled ?? {}) }, hints: { ...(row.inputs?.hints ?? {}) } };
  for (const q of row.questions ?? []) {
    const a = answers.find((x) => x.input === q.input);
    if (!a) return { ok: false, message: `Answer "${q.title}" first.` };
    const problem = answerProblem(q, { input: a.input, values: (a.values ?? []).map(String).slice(0, 20), other: a.other ?? null });
    if (problem) return { ok: false, message: problem };
    d = applyAnswer(d, q, a);
  }
  const snap = await snapshot(c.orgId, c.authz, c.orgType);
  const saved = await save(c.orgId, c.userId, id, { inputs: d, permit: { ...snap, skip: row.permit?.skip ?? [] } }, "ASKING");
  if (!saved) return { ok: true, view: await viewOf(c.orgId, c.userId, (await load(c.orgId, c.userId, id)) ?? row) };
  const next = await decide(c.orgId, c.userId, saved, { from: "ASKING" });
  return { ok: true, view: await viewOf(c.orgId, c.userId, next) };
}

/** "Change details": every answer opened again, each already picked. */
export async function editSetup(c: SetupCtx, id: string): Promise<Acted> {
  const row = await fresh(c, id);
  if (!row) return { ok: false, message: "That card is gone." };
  if (row.state !== "READY") return { ok: true, view: await viewOf(c.orgId, c.userId, row) };
  const next = await decide(c.orgId, c.userId, row, { from: "READY", review: true });
  return { ok: true, view: await viewOf(c.orgId, c.userId, next) };
}

export async function cancelSetup(c: SetupCtx, id: string): Promise<Acted> {
  const row = await load(c.orgId, c.userId, id);
  if (!row) return { ok: false, message: "That card is gone." };
  if (!["READING", "ASKING", "READY"].includes(row.state)) return { ok: true, view: await viewOf(c.orgId, c.userId, row) };
  const next = (await save(c.orgId, c.userId, id, { state: "CANCELLED", result: { message: "Cancelled. Nothing was set up.", lines: [], links: [] }, lease: "drop" }, row.state)) ?? row;
  await audit({ orgId: c.orgId, actorUserId: c.userId, action: "setup.cancelled", targetType: "project_setup", targetId: id, metadata: {} });
  return { ok: true, view: await viewOf(c.orgId, c.userId, next) };
}

/**
 * The person pressed "Set up". Everything is worked out again from the
 * answers, with the keys as they stand now; the pictures they took off are
 * left out; then one guarded UPDATE moves it to CREATING, and the making
 * runs after the answer.
 */
export async function confirmSetup(c: SetupCtx, id: string, skip: readonly number[]): Promise<Acted> {
  const row = await fresh(c, id);
  if (!row) return { ok: false, message: "That card is gone." };
  if (row.state !== "READY") return { ok: true, view: await viewOf(c.orgId, c.userId, row) };
  if (c.via) return { ok: false, message: "Set projects up from your own console." };
  const snap = await snapshot(c.orgId, c.authz, c.orgType);
  const skipped = [...new Set(skip.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  const ctx = await loadContext(c.orgId, snap);
  const files = await setupFiles(c.orgId, c.userId, id);
  const d: Draft = { filled: { ...(row.inputs?.filled ?? {}) }, hints: { ...(row.inputs?.hints ?? {}) } };
  const step = planSetup({ proposal: row.proposal!, pictures: row.pictures ?? [], files, ctx, d, skip: skipped });
  if (!("ready" in step)) {
    const message = "refuse" in step ? step.refuse : "Something changed since this card was made. Answer the new question.";
    if ("ask" in step) {
      const asked = (await save(c.orgId, c.userId, id, { state: "ASKING", questions: step.ask, plan: null, permit: { ...snap, skip: skipped } }, "READY")) ?? row;
      return { ok: true, view: await viewOf(c.orgId, c.userId, asked) };
    }
    const failed = (await save(c.orgId, c.userId, id, { state: "FAILED", result: { message, lines: [], links: [] } }, "READY")) ?? row;
    return { ok: true, view: await viewOf(c.orgId, c.userId, failed) };
  }
  const plan = withoutSkipped(step.ready, skipped);
  const running = await save(c.orgId, c.userId, id, { state: "CREATING", plan, permit: { ...snap, skip: skipped }, stage: "Setting it up", progress: 2, freshSteps: true, result: { message: "", lines: [], links: [], made: {} } }, "READY");
  if (!running) return { ok: true, view: await viewOf(c.orgId, c.userId, (await load(c.orgId, c.userId, id)) ?? row) };
  await audit({
    orgId: c.orgId,
    actorUserId: c.userId,
    action: "setup.confirmed",
    targetType: "project_setup",
    targetId: id,
    metadata: { target: plan.target.kind, towers: plan.towers.filter((t) => !t.id).length, units: plan.units.length, pictures: plan.pictures.length, documents: plan.documents.length },
  });
  return { ok: true, view: await viewOf(c.orgId, c.userId, running), later: () => makeSetup(c.orgId, c.userId, id) };
}

export async function setupStatus(c: SetupCtx, id: string): Promise<Acted> {
  const row = await fresh(c, id);
  if (!row) return { ok: false, message: "That card is gone." };
  return { ok: true, view: await viewOf(c.orgId, c.userId, row) };
}

// ---------------------------------------------------------------------------
// Making it
// ---------------------------------------------------------------------------

/** A picture as the library keeps it: upright, and at least `LIBRARY_LONG_SIDE` on its long side. */
/** A picture as 32 by 32 greys from 0 to 1, for telling whether a sharpened copy is still it. */
async function greys(bytes: Buffer): Promise<number[]> {
  const raw = await sharp(bytes).rotate().greyscale().resize(32, 32, { fit: "fill" }).raw().toBuffer().catch(() => null);
  return raw ? [...raw].map((v) => v / 255) : [];
}

/**
 * The original's own name boards laid back over a redrawn picture: each
 * board is found where the drawing put it (`matchOffset()`, within
 * `BOARD_REACH`), and laid there with its edges faded in. A board the
 * drawing moved or changed past recognising (`BOARD_ALIGNED`) is counted as
 * missed. Code on our machine; costs nothing.
 */
export async function restoreBoards(view: Buffer, drawn: Buffer, boards: readonly Board[]): Promise<{ bytes: Buffer; missed: number }> {
  if (!boards.length) return { bytes: drawn, missed: 0 };
  const dm = await sharp(drawn).metadata();
  const W = dm.width ?? 0;
  const H = dm.height ?? 0;
  if (!W || !H) return { bytes: drawn, missed: boards.length };
  const orig = await sharp(view).rotate().resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const draw = await sharp(drawn).removeAlpha().raw().toBuffer();
  const grey = (rgb: Buffer) => {
    const g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    return g;
  };
  const og = grey(orig);
  const dg = grey(draw);
  const reach = Math.round(BOARD_REACH * Math.max(W, H));
  const over: { input: Buffer; raw: { width: number; height: number; channels: 4 }; left: number; top: number }[] = [];
  let missed = 0;
  for (const b of boards) {
    const r = boardRect(b, W, H);
    if (!r) continue;
    const patch = new Float32Array(r.width * r.height);
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) patch[y * r.width + x] = og[(r.top + y) * W + r.left + x];
    const m = matchOffset({ d: patch, w: r.width, h: r.height }, { d: dg, w: W, h: H }, { x: r.left, y: r.top }, reach);
    if (m.score < BOARD_ALIGNED) {
      missed += 1;
      continue;
    }
    const alpha = featherAlpha(r.width, r.height, Math.round(Math.min(r.width, r.height) / 10));
    const rgba = Buffer.alloc(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++)
      for (let x = 0; x < r.width; x++) {
        const s = ((r.top + y) * W + r.left + x) * 3;
        const t = (y * r.width + x) * 4;
        rgba[t] = orig[s];
        rgba[t + 1] = orig[s + 1];
        rgba[t + 2] = orig[s + 2];
        rgba[t + 3] = alpha[y * r.width + x];
      }
    over.push({ input: rgba, raw: { width: r.width, height: r.height, channels: 4 }, left: m.x, top: m.y });
  }
  return { bytes: over.length ? await sharp(drawn).composite(over).png().toBuffer() : drawn, missed };
}

/**
 * One picture polished for ads and checked: drawn by the design model, kept
 * only when the checker finds the same place with nothing added, its name
 * boards laid back from the original. Each paid call is asked of `afford`
 * first and recorded with `spend` as it is made.
 */
async function polishOne(o: {
  drive: DesignDriver;
  bytes: Buffer;
  w: number;
  h: number;
  flaws: readonly string[];
  render: boolean;
  afford: (usd: number) => boolean;
  spend: (usd: number) => Promise<void>;
}): Promise<{ bytes: Buffer } | { why: string }> {
  const view = await lookView(o.bytes);
  let fixWords = false;
  let avoid: string[] = [];
  let keep: string[] = [];
  let why = "it came back changed";
  // Any attempt that fails is drawn again, told what it got wrong, up to POLISH_ATTEMPTS.
  for (let attempt = 0; attempt < POLISH_ATTEMPTS; attempt++) {
    if (!o.afford(POLISH_CALL_USD + POLISH_CHECK_USD)) return { why: attempt ? why : "this month's limit for setting up from files was reached" };
    const drawn = await o.drive({ prompt: polishPrompt(o.flaws, { render: o.render, fixWords, avoid, keep }), images: [{ bytes: view, type: "image/jpeg" }], size: polishSize(o.w, o.h), quality: "high" }).catch(() => null);
    await o.spend(POLISH_CALL_USD);
    if (!drawn?.ok) {
      why = "the image model did not answer";
      continue;
    }
    const meta = await sharp(drawn.bytes).metadata().catch(() => null);
    if (!meta?.width || !meta.height || Math.abs(meta.width / meta.height / (o.w / o.h) - 1) > 0.03) {
      why = "it came back in another shape";
      continue;
    }
    const look = await ask()({
      model: SETUP_MODEL,
      name: "polish_check",
      system: polishCheckSystem(o.render),
      effort: "low",
      schema: POLISH_CHECK_SCHEMA as unknown as Record<string, unknown>,
      parts: [
        { text: "BEFORE" },
        { image: { bytes: view, type: "image/jpeg", detail: "high" } },
        { text: "AFTER" },
        { image: { bytes: await lookView(drawn.bytes), type: "image/jpeg", detail: "high" } },
      ],
      timeoutMs: 120_000,
    });
    await o.spend(look.ok && look.usage ? callUsd(look.usage.tokensIn, look.usage.tokensOut) : POLISH_CHECK_USD);
    let v = look.ok ? polishVerdict(look.value) : { keep: false, why: "it could not be checked", boards: [] as Board[], added: [] as string[], different: [] as string[] };
    // Refused only for things added: each is looked at again, and what BEFORE already shows is not counted.
    if (!v.keep && v.added.length && !v.different.length && o.afford(POLISH_CHECK_USD)) {
      const again = await ask()({
        model: SETUP_MODEL,
        name: "polish_added_check",
        system: ADDED_CHECK_SYSTEM,
        effort: "medium",
        schema: ADDED_CHECK_SCHEMA as unknown as Record<string, unknown>,
        parts: [
          { text: `Said to be in AFTER and not in BEFORE:\n${v.added.map((x) => `- ${x}`).join("\n")}` },
          { text: "BEFORE" },
          { image: { bytes: view, type: "image/jpeg", detail: "high" } },
          { text: "AFTER" },
          { image: { bytes: await lookView(drawn.bytes), type: "image/jpeg", detail: "high" } },
        ],
        timeoutMs: 120_000,
      });
      await o.spend(again.ok && again.usage ? callUsd(again.usage.tokensIn, again.usage.tokensOut) : POLISH_CHECK_USD);
      const left = again.ok ? reallyAdded(v.added, again.value) : v.added;
      if (!left.length) v = { ...v, keep: true, why: null, added: [] };
      else v = { ...v, added: left, why: `it came back with things the place does not have (${left.join(", ")})` };
    }
    if (!v.keep) {
      why = v.why ?? why;
      avoid = [...new Set([...avoid, ...v.added])].slice(0, 8);
      keep = [...new Set([...keep, ...v.different])].slice(0, 8);
      continue;
    }
    // The original's name boards go back over the drawing's: an image model rewrites small print.
    const laid = await restoreBoards(view, drawn.bytes, v.boards).catch(() => ({ bytes: drawn.bytes, missed: v.boards.length }));
    if (!laid.missed) return { bytes: laid.bytes };
    why = "a name board on it came back moved or changed";
    fixWords = true;
  }
  return { why };
}

/** Where a picture's polished copy is kept, beside it. */
const polishedKey = (orgId: string, setupId: string, n: number) => assetKey({ orgId, project: null, kind: "setuppic", id: `${setupId}_${n}_polished` });

/**
 * Every photograph a setup will file, polished as soon as the pictures are
 * read (the client, 30 October 2026: the card showed the dirty photographs
 * and the polishing only happened after the press, out of sight). The card
 * then shows each as it will be filed. Four at once, each recorded on the
 * picture as it lands, so a second run carries on.
 */
async function polishSetupPictures(orgId: string, userId: string, id: string, pictures: Picture[], progress: (stage: string) => Promise<unknown>, hold = true): Promise<void> {
  const drive = polisher();
  if (!drive) return;
  const eligible = pictures
    .filter((p) => {
      const s = p.seen;
      if (!s || s.use === "SKIP" || p.polished) return false;
      if (p.from ? !regionKept(p.width, p.height) : !bigEnough(p.width, p.height)) return false;
      return !!wantsPolish({ category: s.use, isRender: !s.photo, flaws: s.flaws });
    })
    .sort((a, b) => polishRank(a.seen!.use) - polishRank(b.seen!.use))
    .slice(0, Math.max(0, POLISH_MAX - pictures.filter((p) => p.polished).length));
  if (!eligible.length) return;
  const month = await monthSpend(orgId);
  let spent = 0;
  let done = 0;
  await progress(`Polishing the pictures, 0 of ${eligible.length}`);
  const queue = [...eligible];
  await Promise.all(
    Array.from({ length: Math.min(POLISH_AT_ONCE, queue.length) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const bytes = await storage().read(p.key).catch(() => null);
        const key = polishedKey(orgId, id, p.n);
        const title = slugTitle(p.seen!.title || "A picture");
        if (bytes && key) {
          await save(orgId, userId, id, { say: { k: `pic:${p.n}`, t: `Polishing ${title}`, s: "doing" } });
          const r = await polishOne({
            drive,
            bytes,
            w: p.width,
            h: p.height,
            flaws: p.seen!.flaws ?? [],
            render: !p.seen!.photo,
            afford: (usd) => month.usd + spent + usd <= month.cap,
            spend: async (usd) => {
              spent += usd;
              await save(orgId, userId, id, { addUsd: usd, addCalls: 1 });
            },
          }).catch(() => ({ why: "it could not be polished" }));
          if ("bytes" in r) {
            await storage().put(key, await sharp(r.bytes).jpeg({ quality: 92 }).toBuffer(), "image/jpeg");
            p.polished = { key };
          } else p.polished = { why: r.why };
        }
        done += 1;
        const said: SetupStep = p.polished && "key" in p.polished ? { k: `pic:${p.n}`, t: `Polished ${title}`, s: "done" } : { k: `pic:${p.n}`, t: `${title}: kept as it came, ${p.polished && "why" in p.polished ? p.polished.why : "it could not be read"}`, s: "note" };
        // Only the run that holds the setup renews its lease; an operator's pass must not lock the confirm press out.
        await save(orgId, userId, id, { pictures, ...(hold ? { lease: "keep" as const } : {}), say: said });
        await progress(`Polishing the pictures, ${done} of ${eligible.length}`);
      }
    }),
  );
}

/**
 * The operator's way to polish one library picture again: its first version
 * (the photograph as it came) is polished with the full retry, and a picture
 * that passes is filed as its next version, unapproved.
 */
export async function repolishAsset(orgId: string, userId: string, assetId: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const drive = polisher();
  if (!drive) return { ok: false, why: "no image model is configured" };
  const [row] = await withTenant(orgId, (sql) => sql<{ title: string; category: string; is_render: boolean; storage_key: string }[]>`
    SELECT a.title, a.category, a.is_render, v.storage_key FROM assets a
    JOIN asset_versions v ON v.asset_id = a.id AND v.version = 1
    WHERE a.id = ${assetId} AND a.org_id = ${orgId}`);
  if (!row) return { ok: false, why: "that picture is not here" };
  const bytes = await storage().read(row.storage_key).catch(() => null);
  const meta = bytes ? await sharp(bytes).metadata().catch(() => null) : null;
  if (!bytes || !meta?.width || !meta.height) return { ok: false, why: "the picture could not be read" };
  const month = await monthSpend(orgId);
  let spent = 0;
  const r = await polishOne({
    drive,
    bytes,
    w: meta.width,
    h: meta.height,
    flaws: [],
    render: row.is_render,
    afford: (usd) => month.usd + spent + usd <= month.cap,
    spend: async (usd) => {
      spent += usd;
    },
  });
  if ("why" in r) return { ok: false, why: r.why };
  const { replaceAsset } = await import("./asset.ts");
  const v = await replaceAsset({ orgId, actorUserId: userId, assetId, media: { bytes: await libraryPicture(r.bytes), type: "image/jpeg", name: `${plain(row.title).replace(/\s+/g, "-") || "picture"}.jpg` } });
  return v.ok ? { ok: true } : { ok: false, why: v.message };
}

/** The operator's way to polish a setup read before polishing ran at reading time. */
export async function polishSetupNow(orgId: string, userId: string, id: string): Promise<number> {
  const row = await load(orgId, userId, id);
  if (!row?.pictures) return 0;
  await polishSetupPictures(orgId, userId, id, row.pictures, async () => null, false);
  return row.pictures.filter((p) => p.polished && "key" in p.polished).length;
}

/**
 * The operator's second try at a finished setup's photographs that went in
 * as they came: each is polished again and, when it passes, filed as the
 * next version of the library picture made from it. Returns how many were.
 */
export async function repolishLeftovers(orgId: string, userId: string, id: string): Promise<number> {
  const row = await load(orgId, userId, id);
  const made = row?.result?.made;
  const drive = polisher();
  if (!row || row.state !== "DONE" || !made?.notPolished?.length || !drive) return 0;
  const byN = new Map((row.pictures ?? []).map((p) => [p.n, p]));
  const month = await monthSpend(orgId);
  let spent = 0;
  const { replaceAsset } = await import("./asset.ts");
  const left: NonNullable<Made["notPolished"]> = [];
  const polished = [...(made.polished ?? [])];
  for (const x of made.notPolished) {
    const src = byN.get(x.n);
    const bytes = src ? await storage().read(src.key).catch(() => null) : null;
    const assets = Object.entries(made.pictures ?? {}).filter(([k]) => k.split("|")[0] === String(x.n)).map(([, a]) => a);
    if (!src?.seen || !bytes || !assets.length) {
      left.push(x);
      continue;
    }
    const r = await polishOne({
      drive,
      bytes,
      w: src.width,
      h: src.height,
      flaws: src.seen.flaws ?? [],
      render: !src.seen.photo,
      afford: (usd) => month.usd + spent + usd <= month.cap,
      spend: async (usd) => {
        spent += usd;
        await save(orgId, userId, id, { addUsd: usd, addCalls: 1 });
      },
    }).catch(() => ({ why: "it could not be polished" }));
    if ("why" in r) {
      left.push({ ...x, why: r.why });
      continue;
    }
    const jpeg = await libraryPicture(r.bytes);
    for (const assetId of assets) await replaceAsset({ orgId, actorUserId: userId, assetId, media: { bytes: jpeg, type: "image/jpeg", name: `${plain(x.title).replace(/\s+/g, "-") || "picture"}.jpg` } });
    polished.push(x.n);
  }
  await save(orgId, userId, id, { result: { ...row.result!, made: { ...made, polished, notPolished: left } } });
  return polished.length - (made.polished?.length ?? 0);
}

/**
 * What a person typed beside the files, as a PDF, filed on the project as
 * "Notes from the developer" and queued to be read into the facts. The words
 * are theirs, so they are set as typed, a line each.
 */
async function fileDeveloperNote(orgId: string, userId: string, projectId: string, said: string): Promise<{ ok: true; documentId: string; extractionId: string | null } | { ok: false; message: string }> {
  const { A4, pdfDocument, winAnsi, wrap } = await import("./pdf.ts");
  const { brainNode } = await import("./brain.ts");
  const { fileStoredDocument } = await import("./extract.ts");
  const node = await brainNode(orgId, projectId);
  if (!node) return { ok: false, message: "the project's facts could not be opened" };
  const margin = 56;
  const size = 11;
  const lead = 16;
  const lines = said.replace(/\r\n?/g, "\n").split("\n").flatMap((l) => (l.trim() ? wrap(winAnsi(l), size, A4.w - 2 * margin) : [""]));
  const pages: { t: "text"; x: number; y: number; text: string; size: number; bold?: boolean }[][] = [];
  let page: { t: "text"; x: number; y: number; text: string; size: number; bold?: boolean }[] = [{ t: "text", x: margin, y: A4.h - margin, text: "Notes from the developer", size: 14, bold: true }];
  let y = A4.h - margin - 30;
  for (const line of lines) {
    if (y < margin) {
      pages.push(page);
      page = [];
      y = A4.h - margin;
    }
    if (line) page.push({ t: "text", x: margin, y, text: line, size });
    y -= lead;
  }
  pages.push(page);
  const pdf = pdfDocument(pages, { title: "Notes from the developer" });
  const sha = sha256(pdf);
  const key = fileKey(orgId, sha);
  if (!key) return { ok: false, message: "the notes could not be stored" };
  await storage().put(key, pdf, "application/pdf");
  const r = await fileStoredDocument({ orgId, userId, node, kind: "DEVELOPER_NOTE", name: "Notes from the developer.pdf", type: "application/pdf", size: pdf.length, sha256: sha, fromKey: key });
  return r.ok ? { ok: true, documentId: r.documentId, extractionId: r.extractionId } : { ok: false, message: r.message };
}

/** A brochure's logo as a brand mark: the plain margin trimmed, a PNG, small enough to keep. */
type BrandFill = {
  tagline: string | null;
  colourPrimary: string | null;
  colourAccent: string | null;
  salesPhone: string | null;
  salesEmail: string | null;
  website: string | null;
  officeAddress: string | null;
  disclaimer: string | null;
};

/**
 * Fill the empty boxes of one node's own brand kit, and nothing a person set:
 * the kit is written whole, so it is read first and kept as it is.
 */
export async function fillBrandKit(orgId: string, userId: string, nodeId: string, fill: Partial<BrandFill>): Promise<{ ok: true; filled: number } | { ok: false; message: string }> {
  const { loadBrand, saveBrandKit } = await import("./brand.ts");
  const view = await loadBrand(orgId, nodeId);
  if (!view) return { ok: false, message: "That place was removed." };
  const k = view.own;
  const pick = (have: string | number | null | undefined, want: string | null | undefined) => (have !== null && have !== undefined && have !== "" ? null : want || null);
  const add = {
    tagline: pick(k.tagline, fill.tagline),
    colourPrimary: pick(k.colourPrimary, fill.colourPrimary),
    colourAccent: pick(k.colourAccent, fill.colourAccent),
    salesPhone: pick(k.salesPhone, fill.salesPhone),
    salesEmail: pick(k.salesEmail, fill.salesEmail),
    website: pick(k.website, fill.website),
    officeAddress: pick(k.officeAddress, fill.officeAddress),
    disclaimer: pick(k.disclaimer, fill.disclaimer),
  };
  const filled = Object.values(add).filter(Boolean).length;
  if (!filled) return { ok: true, filled: 0 };
  const str = (v: number | null) => (v === null ? null : String(v));
  const r = await saveBrandKit({
    orgId,
    actorUserId: userId,
    nodeId,
    input: {
      tagline: add.tagline ?? k.tagline,
      colourPrimary: add.colourPrimary ?? k.colourPrimary,
      colourAccent: add.colourAccent ?? k.colourAccent,
      typefaceName: k.typefaceName,
      typefaceLanguages: k.typefaceLanguages,
      logoMinPx: str(k.logoMinPx),
      logoClearRatio: str(k.logoClearRatio),
      salesPhone: add.salesPhone ?? k.salesPhone,
      salesEmail: add.salesEmail ?? k.salesEmail,
      website: add.website ?? k.website,
      privacyUrl: k.privacyUrl,
      officeAddress: add.officeAddress ?? k.officeAddress,
      instagram: k.instagramUrl,
      facebook: k.facebookUrl,
      youtube: k.youtubeUrl,
      disclaimer: add.disclaimer ?? k.disclaimer,
    },
  });
  return r.ok ? { ok: true, filled } : { ok: false, message: r.message };
}

/**
 * A logo from the files set on a node: its background taken out, as the
 * role it was read as, the white single-colour mark beside it, and a stacked
 * logo's side-by-side layout where the node has none of its own.
 */
export async function setLogoFiles(
  orgId: string,
  userId: string,
  nodeId: string,
  bytes: Buffer,
  role: string,
): Promise<{ ok: boolean; message: string; colours: { primary: string | null; accent: string | null } }> {
  const { cutOutLogo, whiteLogo, horizontalLogo, logoColours } = await import("./logo-cut.ts");
  const { putBrandFile } = await import("./brand.ts");
  const cut = await cutOutLogo(bytes);
  const colours = await logoColours(cut.png).catch(() => ({ primary: null, accent: null }));
  const put = (r: string, png: Buffer, name: string) => putBrandFile({ orgId, actorUserId: userId, nodeId, role: r, media: { bytes: png, type: "image/png", name } });
  const main = await put(role, cut.png, "logo.png");
  if (!main.ok) return { ok: false, message: main.message, colours };
  const [had] = await withTenant(orgId, (sql) => sql<{ roles: string[] }[]>`
    SELECT coalesce(array_agg(role), '{}') AS roles FROM brand_files WHERE org_id = ${orgId} AND scope_node_id = ${nodeId}`);
  const roles = new Set(had?.roles ?? []);
  if (!roles.has("LOGO_MONO")) await put("LOGO_MONO", await whiteLogo(cut.png), "logo-white.png").catch(() => null);
  if (role === "LOGO_STACKED") {
    const side = await horizontalLogo(cut.png).catch(() => null);
    if (side) await put("LOGO_HORIZONTAL", side, "logo-horizontal.png").catch(() => null);
  }
  return { ok: true, message: "", colours };
}

export async function libraryPicture(bytes: Buffer): Promise<Buffer> {
  const meta = await sharp(bytes).metadata();
  const long = Math.max(meta.width ?? 0, meta.height ?? 0);
  const img = sharp(bytes).rotate();
  if (long > 0 && long < LIBRARY_LONG_SIDE) {
    const scale = LIBRARY_LONG_SIDE / long;
    return img.resize({ width: Math.round((meta.width ?? 1) * scale), kernel: "lanczos3" }).jpeg({ quality: 92 }).toBuffer();
  }
  return img.jpeg({ quality: 92 }).toBuffer();
}

const slugTitle = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120);

/** The long side a page is shown to the reader at: enough for it to place a box. */
const VIEW_LONG_SIDE = 1536;

/**
 * A page as the reader sees it, with faint grid lines every tenth and their
 * numbers in the margin, so the boxes it gives are measured, not guessed.
 */
export async function gridView(bytes: Buffer): Promise<Buffer> {
  const base = sharp(bytes).rotate().resize({ width: VIEW_LONG_SIDE, height: VIEW_LONG_SIDE, fit: "inside", withoutEnlargement: true });
  const { data, info } = await base.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const lines: string[] = [];
  for (let k = 1; k < 10; k += 1) {
    const x = Math.round((k / 10) * w);
    const y = Math.round((k / 10) * h);
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#ff00ff" stroke-opacity="0.45" stroke-width="1"/>`);
    lines.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#ff00ff" stroke-opacity="0.45" stroke-width="1"/>`);
    lines.push(`<text x="${x + 2}" y="12" font-family="sans-serif" font-size="12" fill="#ff00ff">${k * 100}</text>`);
    lines.push(`<text x="2" y="${y - 2}" font-family="sans-serif" font-size="12" fill="#ff00ff">${k * 100}</text>`);
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${lines.join("")}</svg>`);
  return sharp(data).composite([{ input: svg }]).jpeg({ quality: 85 }).toBuffer();
}

/**
 * One picture sent to the image model to be drawn larger and sharper. A
 * picture in a shape the model does not draw goes with plain bands to its
 * nearest shape, and the bands are cut off what comes back. Null when the
 * model never answered (nothing paid); else what it cost, and the new bytes
 * only when code finds them still the same picture.
 */
export async function sharpenOnce(drive: SharpenDriver, bytes: Buffer, w: number, h: number, aspect: string): Promise<{ usd: number; bytes: Buffer | null } | null> {
  const pad = padFor(w, h, aspect);
  const sent = pad.x || pad.y
    ? await sharp(bytes).extend({ left: pad.x, right: pad.x, top: pad.y, bottom: pad.y, background: "#808080" }).jpeg({ quality: 92 }).toBuffer()
    : bytes;
  const r = await drive({ bytes: sent, type: "image/jpeg", aspect }).catch(() => null);
  if (!r || !r.ok) return null;
  const usd = sharpenUsd(r.tokensIn, r.tokensOut) || SHARPEN_CALL_USD;
  const meta = await sharp(r.bytes).metadata().catch(() => null);
  if (!meta?.width || !meta.height) return { usd, bytes: null };
  let back = r.bytes;
  if (pad.x || pad.y) {
    const sx = meta.width / (w + 2 * pad.x);
    const sy = meta.height / (h + 2 * pad.y);
    const left = Math.round(pad.x * sx);
    const top = Math.round(pad.y * sy);
    const rect = { left, top, width: Math.min(Math.round(w * sx), meta.width - left), height: Math.min(Math.round(h * sy), meta.height - top) };
    const cut = await sharp(r.bytes).extract(rect).png().toBuffer().catch(() => null);
    if (!cut) return { usd, bytes: null };
    back = cut;
  }
  const bm = await sharp(back).metadata().catch(() => null);
  if (!bm?.width || !bm.height) return { usd, bytes: null };
  const same = sharpenedLooksSame({ before: await greys(bytes), after: await greys(back), beforeRatio: w / h, afterRatio: bm.width / bm.height });
  return { usd, bytes: same ? back : null };
}

/** A picture as a checker looks at it: upright, its long side 1,536 at most. */
async function lookView(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).rotate().resize({ width: VIEW_LONG_SIDE, height: VIEW_LONG_SIDE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
}

/** Drawings are cut to their ink, never snapped: a plan's edge is a wall, not a gutter. */
const LINE_WORK = new Set(["FLOOR_PLAN", "SITE_PLAN"]);

/** A page in greys, for finding the edges of what is on it. */
export type PageGreys = { grey: Buffer; width: number; height: number };

export async function pageGreys(bytes: Buffer): Promise<PageGreys> {
  const { data, info } = await sharp(bytes).rotate().greyscale().raw().toBuffer({ resolveWithObject: true });
  return { grey: data, width: info.width, height: info.height };
}

/**
 * One picture cut out of a page. A photograph, a render or a map is the
 * cell of the page's gutters the reader's box means (or, with no gutters,
 * the box with each edge put on the picture's real edge), then cut a hair
 * inside it. A drawing (a plan, a 3D plan, a logo), and any picture the
 * reader boxed as most of its page, is the largest piece of ink in the box,
 * a little widened, so its heading, labels, compass and area table stay
 * behind.
 */
export async function cutRegion(bytes: Buffer, r: Region, page?: PageGreys): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
  const p = page ?? (await pageGreys(bytes));
  const W = p.width;
  const H = p.height;
  let rect = regionRect(r.box, W, H);
  if (!rect) return null;
  if (r.use === "LOGO") {
    // A logo's mark and its name are separate pieces of ink, and the reader's
    // box often clips a letter: the box is widened, and cut to the pieces of
    // ink it touches that lie wholly inside the widened box (a building or a
    // page's line art beside the logo runs out of it and is left behind).
    const grow = Math.round(0.08 * Math.max(W, H));
    const left = Math.max(0, rect.left - grow);
    const top = Math.max(0, rect.top - grow);
    const wide = { left, top, width: Math.min(W, rect.left + rect.width + grow) - left, height: Math.min(H, rect.top + rect.height + grow) - top };
    rect = logoBox(p.grey, W, wide, rect) ?? rect;
  } else if (LINE_WORK.has(r.use) || r.box.w * r.box.h >= 600_000) {
    // A box over most of the page is a page with one picture and its heading: cut to the picture.
    // A drawing's box is read generously: the reader often cuts a wall off.
    const grow = Math.round(0.03 * Math.max(W, H));
    const left = Math.max(0, rect.left - grow);
    const top = Math.max(0, rect.top - grow);
    const wide = { left, top, width: Math.min(W, rect.left + rect.width + grow) - left, height: Math.min(H, rect.top + rect.height + grow) - top };
    const piece = mainPiece(p.grey, W, H, wide, Math.max(4, Math.round(0.008 * Math.max(W, H))));
    if (piece) {
      const pad = Math.round(0.01 * Math.max(piece.width, piece.height));
      const l = Math.max(0, piece.left - pad);
      const t = Math.max(0, piece.top - pad);
      rect = { left: l, top: t, width: Math.min(W, piece.left + piece.width + pad) - l, height: Math.min(H, piece.top + piece.height + pad) - t };
    }
  } else {
    rect = gridCell(p.grey, W, H, rect, Math.max(2, Math.round(0.002 * Math.max(W, H)))) ?? snapRect(p.grey, W, H, rect, Math.round(0.06 * Math.max(W, H)));
    rect = dropSlivers(p.grey, W, rect, Math.max(2, Math.round(0.002 * Math.max(W, H))));
    const inset = Math.max(2, Math.round(Math.min(rect.width, rect.height) * 0.004));
    rect = { left: rect.left + inset, top: rect.top + inset, width: rect.width - 2 * inset, height: rect.height - 2 * inset };
  }
  if (rect.width < 16 || rect.height < 16) return null;
  const out = await sharp(bytes).rotate().extract(rect).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  return { jpeg: out.data, width: out.info.width, height: out.info.height };
}

/**
 * A logo's own ink: in the widened box, everything that stands off the page's
 * ground (the box's border, as its middle grey; ink is 45 greys away), joined
 * where pieces lie close (letters into words, a mark to its name), keeping
 * the pieces that touch the reader's box and lie wholly inside the widened
 * one. Padded a little; null when nothing is left.
 */
function logoBox(grey: Uint8Array | Buffer, W: number, wide: { left: number; top: number; width: number; height: number }, box: { left: number; top: number; width: number; height: number }): { left: number; top: number; width: number; height: number } | null {
  const k = 2;
  const w = Math.floor(wide.width / k);
  const h = Math.floor(wide.height / k);
  if (w < 4 || h < 4) return null;
  const at = (x: number, y: number) => grey[(wide.top + y * k) * W + wide.left + x * k];
  const edge: number[] = [];
  for (let x = 0; x < w; x++) edge.push(at(x, 0), at(x, h - 1));
  for (let y = 0; y < h; y++) edge.push(at(0, y), at(w - 1, y));
  edge.sort((a, b) => a - b);
  const ground = edge[Math.floor(edge.length / 2)] ?? 255;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.abs(at(x, y) - ground) > 45) ink[y * w + x] = 1;
  // Pieces within a few pixels of each other are one piece.
  const reach = Math.max(2, Math.round(Math.max(w, h) * 0.012));
  const joined = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (ink[y * w + x])
        for (let dy = -reach; dy <= reach; dy++)
          for (let dx = -reach; dx <= reach; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) joined[yy * w + xx] = 1;
          }
  const seen = new Uint8Array(w * h);
  const bx0 = (box.left - wide.left) / k;
  const by0 = (box.top - wide.top) / k;
  const bx1 = bx0 + box.width / k;
  const by1 = by0 + box.height / k;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let start = 0; start < w * h; start++) {
    if (!joined[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let px0 = Infinity;
    let py0 = Infinity;
    let px1 = -1;
    let py1 = -1;
    let inked = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      if (ink[i]) {
        inked += 1;
        if (x < px0) px0 = x;
        if (x > px1) px1 = x;
        if (y < py0) py0 = y;
        if (y > py1) py1 = y;
      }
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || seen[j] || !joined[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (inked < 12 || px1 < 0) continue;
    const touchesEdge = px0 <= reach || py0 <= reach || px1 >= w - 1 - reach || py1 >= h - 1 - reach;
    const touchesBox = px1 >= bx0 && px0 <= bx1 && py1 >= by0 && py0 <= by1;
    if (touchesEdge || !touchesBox) continue;
    x0 = Math.min(x0, px0);
    y0 = Math.min(y0, py0);
    x1 = Math.max(x1, px1);
    y1 = Math.max(y1, py1);
  }
  if (x1 < 0) return null;
  const pad = Math.round(0.04 * Math.max(x1 - x0, y1 - y0) * k);
  const left = Math.max(wide.left, wide.left + x0 * k - pad);
  const top = Math.max(wide.top, wide.top + y0 * k - pad);
  return { left, top, width: Math.min(wide.left + wide.width, wide.left + (x1 + 1) * k + pad) - left, height: Math.min(wide.top + wide.height, wide.top + (y1 + 1) * k + pad) - top };
}

/**
 * Make what the plan says, step by step, each through the screen's own
 * function and only where the snapshot of the person's keys holds it. Every
 * step is written down as it lands, so a second run skips it.
 */
export async function makeSetup(orgId: string, userId: string, id: string): Promise<void> {
  const [claim] = await withPerson(orgId, userId, (sql) => sql<Row[]>`
    UPDATE project_setups SET attempts = attempts + 1, lease_until = now() + ${`${SETUP_LEASE_MINUTES} minutes`}::interval, updated_at = now()
    WHERE id = ${id} AND state = 'CREATING' AND attempts < ${SETUP_MAX_ATTEMPTS * 2} AND (lease_until IS NULL OR lease_until < now())
    RETURNING ${sql.unsafe(COLS)}`);
  if (!claim || !claim.plan || !claim.permit) return;
  try {
    await makeClaimed(orgId, userId, claim);
  } catch (e) {
    console.error("setup: making failed", e);
    const made = claim.result?.made ?? {};
    await save(orgId, userId, id, {
      state: "FAILED",
      result: { message: made.projectId ? "Part of it was set up, then something went wrong. Open the project to see what is there." : "It could not be set up. Try again.", lines: [], links: made.projectId ? [{ label: "Open the project", href: `/dashboard/projects/${made.projectId}` }] : [], made },
      lease: "drop",
      error: String((e as Error)?.message ?? e).slice(0, 300),
    }, "CREATING");
  }
}

async function makeClaimed(orgId: string, userId: string, row: Row): Promise<void> {
  const plan = row.plan!;
  const snap = row.permit!;
  const made: Made = { towers: {}, units: {}, pictures: {}, documents: {}, problems: [], ...(row.result?.made ?? {}) };
  made.towers ??= {};
  made.units ??= {};
  made.pictures ??= {};
  made.documents ??= {};
  made.problems ??= [];
  const keep = (stage: string, pct: number) => save(orgId, userId, row.id, { result: { message: "", lines: [], links: [], made }, stage, progress: Math.round(pct), lease: "keep" });
  const fail = async (message: string) => {
    await save(orgId, userId, row.id, { state: "FAILED", result: { message, lines: [], links: [], made }, lease: "drop" }, "CREATING");
  };

  // The entity and the project.
  let projectId = plan.target.kind === "existing" ? plan.target.projectId : made.projectId ?? null;
  if (plan.target.kind === "new" && !projectId) {
    if (snap.createRefusal) return fail(snap.createRefusal);
    let entityId = plan.target.entity.id ?? made.entityId ?? null;
    if (!entityId) {
      const { createEntity } = await import("./entity.ts");
      const r = await createEntity({ orgId, actorUserId: userId, legalName: plan.target.entity.name, pan: plan.target.entity.pan, registrationNo: "", registeredAddress: "" });
      if (r.ok) entityId = r.id;
      else {
        const [same] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
          SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ENTITY' AND lower(name) = lower(${plan.target.kind === "new" ? plan.target.entity.name : ""}) LIMIT 1`);
        if (!same) return fail(r.message);
        entityId = same.id;
      }
      made.entityId = entityId;
      await keep("Adding the project", 10);
    }
    const { createProject } = await import("./project.ts");
    const r = await createProject({ orgId, actorUserId: userId, entityId: entityId!, city: plan.target.city, name: plan.target.name });
    if (r.ok) projectId = r.id;
    else {
      const [same] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
        SELECT p.id FROM scope_nodes p JOIN scope_nodes r ON r.id = p.parent_id
        WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND lower(p.name) = lower(${plan.target.kind === "new" ? plan.target.name : ""}) AND r.parent_id = ${entityId}
        LIMIT 1`);
      if (!same) return fail(r.message);
      projectId = same.id;
    }
    made.projectId = projectId!;
    await keep("Adding the towers", 15);
  }
  if (!projectId) return fail("The project is gone.");
  const [project] = await withTenant(orgId, (sql) => sql<{ path: string; name: string }[]>`SELECT path::text AS path, name FROM scope_nodes WHERE org_id = ${orgId} AND id = ${projectId} AND kind = 'PROJECT'`);
  if (!project) return fail("The project is gone.");
  const permit = permitAt(snap, project.path);

  // The towers.
  const towerId = (name: string) => made.towers![name] ?? plan.towers.find((t) => t.name === name)?.id ?? null;
  for (const t of plan.towers) {
    if (t.id) {
      made.towers![t.name] = t.id;
      continue;
    }
    if (made.towers![t.name]) continue;
    if (!permit.towers) continue;
    const { createPhase } = await import("./rera.ts");
    const r = await createPhase({ orgId, actorUserId: userId, projectId, name: t.name });
    if (r.ok) {
      made.towers![t.name] = r.id;
      await save(orgId, userId, row.id, { say: { k: `tower:${t.name}`, t: `Added ${t.name}`, s: "done" } });
    }
    else {
      const [same] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
        SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND parent_id = ${projectId} AND kind = 'PHASE' AND lower(name) = lower(${t.name}) LIMIT 1`);
      if (same) made.towers![t.name] = same.id;
      else made.problems!.push(`${t.name} was not added: ${r.message}`);
    }
  }
  await keep("Adding the flat types", 25);

  // The flat types, unapproved.
  if (permit.units) {
    const { addUnitType } = await import("./unit.ts");
    for (const u of plan.units) {
      const k = `${u.tower}|${u.config}|${u.variant ?? ""}`;
      if (made.units![k]) continue;
      const at = towerId(u.tower);
      if (!at) continue;
      const [have] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
        SELECT id FROM unit_types WHERE org_id = ${orgId} AND scope_node_id = ${at} AND config = ${u.config} AND variant IS NOT DISTINCT FROM ${u.variant}`);
      if (have) {
        made.units![k] = have.id;
        continue;
      }
      const r = await addUnitType({ orgId, actorUserId: userId, nodeId: at, config: u.config, variant: u.variant, carpetAreaSqft: u.carpet, balconyAreaSqft: null, startingPrice: u.price });
      if (r.ok) {
        made.units![k] = r.unitTypeId;
        await save(orgId, userId, row.id, { say: { k: `unit:${k}`, t: `Added the ${u.config.replace("BHK", " BHK")} flat type${u.carpet ? `, ${u.carpet} sq ft` : ""}`, s: "done" } });
      }
      else made.problems!.push(`A ${u.config.replace("BHK", " BHK")} was not added: ${r.message}`);
    }
  }
  await keep("Adding the pictures", 35);

  // The pictures, unapproved.
  if (permit.pictures && plan.pictures.length) {
    const { addAsset } = await import("./asset.ts");
    const { tagAsset } = await import("./unit.ts");
    const byN = new Map((row.pictures ?? []).map((p) => [p.n, p]));
    // Each photograph of a space is polished for ads (the client, 29 October
    // 2026): wires, mess, stains and haze taken out, light and sky made
    // pleasant, anything broken put right, nothing added the place lacks. A
    // look at before and after keeps it only when it is the same place with
    // nothing added; the photograph as it came stays as its first version.
    // A small render is sharpened instead, on its own count. Both are priced
    // before they are asked and counted against the setup's month.
    type Edit = { kind: "polish"; flaws: string[]; render: boolean } | { kind: "sharpen"; aspect: string };
    const edits = new Map<number, Edit>();
    const polish = polisher();
    const drive = sharpener();
    const unique = [...new Map(plan.pictures.map((p) => [p.n, p])).values()].map((p) => ({ p, src: byN.get(p.n) })).filter((x) => x.src);
    const done = new Set([...(made.sharpened ?? []), ...(made.polished ?? []), ...(made.notPolished ?? []).map((x) => x.n), ...(made.cleaned ?? []).map((x) => x.n)]);
    if (polish) {
      const polishUsed = (made.polished?.length ?? 0) + (made.notPolished?.length ?? 0);
      unique
        .map((x) => ({ ...x, how: wantsPolish({ ...x.p, flaws: x.src!.seen?.flaws }) }))
        .filter((x) => x.how && !done.has(x.p.n))
        .sort((a, b) => polishRank(a.p.category) - polishRank(b.p.category))
        .slice(0, Math.max(0, POLISH_MAX - polishUsed))
        .forEach((x) => edits.set(x.p.n, { kind: "polish", flaws: x.src!.seen?.flaws ?? [], render: x.how === "render" }));
    }
    if (drive) {
      unique
        .filter((x) => !edits.has(x.p.n) && !done.has(x.p.n))
        .map((x) => ({ n: x.p.n, aspect: wantsSharpen({ category: x.p.category, width: x.src!.width, height: x.src!.height }), long: Math.max(x.src!.width, x.src!.height) }))
        .filter((x): x is { n: number; aspect: string; long: number } => !!x.aspect)
        .sort((a, b) => a.long - b.long)
        .slice(0, Math.max(0, SHARPEN_MAX - (made.sharpened?.length ?? 0)))
        .forEach((x) => edits.set(x.n, { kind: "sharpen", aspect: x.aspect }));
    }
    const editedBytes = new Map<number, { bytes: Buffer; replaced: boolean }>();
    let spent = 0;
    const month = edits.size ? await monthSpend(orgId) : { usd: 0, cap: 0 };
    const notPolished = (n: number, why: string) => {
      const title = slugTitle(byN.get(n)?.seen?.title ?? "A photograph");
      made.notPolished = [...(made.notPolished ?? []), { n, title, why }];
    };
    const editOne = async (n: number, bytes: Buffer, w: number, h: number): Promise<{ bytes: Buffer; replaced: boolean }> => {
      const e = edits.get(n);
      if (!e) return { bytes, replaced: false };
      const had = editedBytes.get(n);
      if (had) return had;
      const asOriginal = { bytes, replaced: false };
      editedBytes.set(n, asOriginal);
      if (e.kind === "sharpen") {
        if (!drive || month.usd + spent + SHARPEN_CALL_USD > month.cap) return asOriginal;
        const r = await sharpenOnce(drive, bytes, w, h, e.aspect);
        if (!r) return asOriginal;
        spent += r.usd;
        await save(orgId, userId, row.id, { addUsd: r.usd, addCalls: 1 });
        if (!r.bytes) return asOriginal;
        made.sharpened = [...(made.sharpened ?? []), n];
        const out = { bytes: r.bytes, replaced: false };
        editedBytes.set(n, out);
        return out;
      }
      // Polished when it was read, so the card showed what is filed now.
      const early = byN.get(n)?.polished;
      if (early && "key" in early) {
        const done = await storage().read(early.key).catch(() => null);
        if (done) {
          made.polished = [...(made.polished ?? []), n];
          const out = { bytes: done, replaced: true };
          editedBytes.set(n, out);
          return out;
        }
      }
      if (early && "why" in early) {
        notPolished(n, early.why);
        return asOriginal;
      }
      if (!polish) return asOriginal;
      const r = await polishOne({
        drive: polish,
        bytes,
        w,
        h,
        flaws: e.flaws,
        render: e.render,
        afford: (usd) => month.usd + spent + usd <= month.cap,
        spend: async (usd) => {
          spent += usd;
          await save(orgId, userId, row.id, { addUsd: usd, addCalls: 1 });
        },
      });
      if ("why" in r) {
        notPolished(n, r.why);
        return asOriginal;
      }
      made.polished = [...(made.polished ?? []), n];
      const out = { bytes: r.bytes, replaced: true };
      editedBytes.set(n, out);
      return out;
    };
    // Polishings are drawn a few at a time before anything is filed: one
    // after another, thirty would take twenty minutes.
    // Each one finished renews the lease: thirty take minutes, and a lease
    // left to run out hands the setup to the worker while this still runs.
    const queue = [...edits.entries()].filter(([, e]) => e.kind === "polish").map(([n]) => n);
    const total = queue.length;
    let polishedSoFar = 0;
    if (total) await keep(`Polishing the pictures, 0 of ${total}`, 30);
    await Promise.all(
      Array.from({ length: Math.min(POLISH_AT_ONCE, queue.length) }, async () => {
        for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
          const src = byN.get(n);
          const bytes = src ? await storage().read(src.key).catch(() => null) : null;
          if (src && bytes) await editOne(n, bytes, src.width, src.height).catch(() => null);
          polishedSoFar += 1;
          await keep(`Polishing the pictures, ${polishedSoFar} of ${total}`, 30 + (polishedSoFar / total) * 10);
        }
      }),
    );
    await keep("Adding the pictures", 40);
    let filed = 0;
    for (const p of plan.pictures) {
      const k = `${p.n}|${p.at}`;
      filed += 1;
      if (made.pictures![k]) continue;
      const at = p.at === "project" ? projectId : towerId(p.at);
      const src = byN.get(p.n);
      if (!at || !src) continue;
      const title = slugTitle(p.title);
      const [have] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
        SELECT id FROM assets WHERE org_id = ${orgId} AND scope_node_id = ${at} AND title = ${title} AND category = ${p.category} LIMIT 1`);
      if (have) {
        made.pictures![k] = have.id;
        continue;
      }
      const bytes = await storage().read(src.key);
      if (!bytes) {
        made.problems!.push(`${title} could not be added: the picture was lost.`);
        continue;
      }
      const edited = await editOne(p.n, bytes, src.width, src.height);
      const fileAs = `${plain(title).replace(/\s+/g, "-") || "picture"}.jpg`;
      // A polished photograph is filed as it came first, then polished as the next version: the approver sees both.
      const r = await addAsset({ orgId, actorUserId: userId, nodeId: at, category: p.category, title, isRender: p.isRender, capturedOn: null, media: { bytes: await libraryPicture(edited.replaced ? bytes : edited.bytes), type: "image/jpeg", name: fileAs } });
      if (!r.ok) {
        made.problems!.push(`${title} was not added: ${r.message}`);
        continue;
      }
      if (edited.replaced) {
        const { replaceAsset } = await import("./asset.ts");
        const v2 = await replaceAsset({ orgId, actorUserId: userId, assetId: r.assetId, media: { bytes: await libraryPicture(edited.bytes), type: "image/jpeg", name: fileAs } });
        if (!v2.ok) made.problems!.push(`${title} was added as it came; its polished copy was not: ${v2.message}`);
      }
      made.pictures![k] = r.assetId;
      const unitId = p.unit ? made.units![`${p.at}|${p.unit.config}|${plan.units.find((u) => u.tower === p.at && u.config === p.unit!.config && u.carpet === p.unit!.carpet)?.variant ?? ""}`] : null;
      if (unitId || p.room) await tagAsset({ orgId, actorUserId: userId, assetId: r.assetId, unitTypeId: unitId ?? null, room: p.room }).catch(() => null);
      if (filed % 4 === 0) await keep(`Adding the pictures, ${filed} of ${plan.pictures.length}`, 35 + (filed / plan.pictures.length) * 40);
    }
  }
  await keep("Adding the sales contact", 78);

  // The logo, only where the project has none of its own. Branding has no
  // approval of its own: the card showed it, and it was not taken off. Its
  // background is taken out, and the single-colour mark (white) and the
  // side-by-side layout are made from it (`logo-cut.ts`).
  let colours: { primary: string | null; accent: string | null } = { primary: null, accent: null };
  if (plan.logo && permit.brand && !made.logo) {
    const role = plan.logo.role;
    const [own] = await withTenant(orgId, (sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM brand_files WHERE org_id = ${orgId} AND scope_node_id = ${projectId} AND role IN ('LOGO_HORIZONTAL', 'LOGO_STACKED')`);
    const src = (row.pictures ?? []).find((x) => x.n === plan.logo!.n);
    const bytes = !own?.n && src ? await storage().read(src.key).catch(() => null) : null;
    if (own?.n) made.logo = "HAD";
    else if (bytes) {
      const set = await setLogoFiles(orgId, userId, projectId, bytes, role);
      colours = set.colours;
      if (set.ok) made.logo = "SET";
      else made.problems!.push(`The logo was not set: ${set.message}`);
    } else made.problems!.push("The logo was not set: the picture was lost.");
  } else if (!plan.logo && permit.brand && !made.logo) {
    // No logo in the files: say so only when the project has none to use either.
    const { resolveBrand } = await import("./brand.ts");
    const resolved = await resolveBrand(orgId, projectId).catch(() => null);
    const has = resolved?.files.some((f) => f.role === "LOGO_HORIZONTAL" || f.role === "LOGO_STACKED");
    made.logo = has ? "HAD" : "MISSING";
  }
  // The brand kit: the contact, the tagline, the sales office, the
  // disclaimer and the logo's colours, filled in only where nothing is set.
  // The project gets all of it; the developer's own kit (the organisation's)
  // gets what is the developer's, everything but the project's tagline.
  if ((plan.contact || colours.primary) && permit.brand && !made.contact) {
    const c = plan.contact;
    const fill: Partial<BrandFill> = {
      salesPhone: c?.phone || null,
      salesEmail: c?.email || null,
      website: c?.website ? `https://${c.website}` : null,
      officeAddress: c?.office || null,
      disclaimer: c?.disclaimer || null,
      colourPrimary: colours.primary,
      colourAccent: colours.accent,
    };
    const project = await fillBrandKit(orgId, userId, projectId, { ...fill, tagline: c?.tagline || null });
    if (!project.ok) made.problems!.push(`The branding was not saved: ${project.message}`);
    const [root] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`);
    if (root) await fillBrandKit(orgId, userId, root.id, fill).catch(() => null);
    made.contact = true;
  }
  await keep("Filing the documents", 85);

  // The documents, filed and queued to be read into the facts.
  const extractions: string[] = [];
  if (permit.documents && plan.documents.length) {
    const { brainNode } = await import("./brain.ts");
    const { fileStoredDocument } = await import("./extract.ts");
    const files = await setupFiles(orgId, userId, row.id);
    for (const doc of plan.documents) {
      if (made.documents![doc.file]) continue;
      const f = files.find((x) => x.id === doc.file);
      const at = doc.at === "project" ? projectId : towerId(doc.at);
      if (!f || !at) continue;
      const node = await brainNode(orgId, at);
      if (!node) continue;
      const r = await fileStoredDocument({ orgId, userId, node, kind: doc.kind as DocKind, name: f.name, type: f.type, size: f.bytes, sha256: f.sha256, fromKey: f.key });
      if (!r.ok) {
        made.problems!.push(`${f.name} was not filed: ${r.message}`);
        continue;
      }
      made.documents![doc.file] = { documentId: r.documentId, extractionId: r.extractionId };
      await save(orgId, userId, row.id, { say: { k: `doc:${doc.file}`, t: `Reading ${f.name} into the project's facts`, s: "done" } });
      if (r.extractionId) extractions.push(r.extractionId);
    }
  }

  // What the person typed beside the files is the developer's own word on the
  // price, the payment plan, possession and what never to say. It is filed as
  // a document of its own and read into the facts like the brochure, each
  // value waiting for a person to check it.
  if (permit.documents && row.said.trim().length >= 40 && !made.note) {
    const r = await fileDeveloperNote(orgId, userId, projectId, row.said).catch((e) => ({ ok: false as const, message: String((e as Error)?.message ?? e) }));
    made.note = r.ok ? r.documentId : "FAILED";
    if (r.ok) {
      if (r.extractionId) extractions.push(r.extractionId);
      await save(orgId, userId, row.id, { say: { k: "doc:note", t: "Reading your notes into the project's facts", s: "done" } });
    } else made.problems!.push(`Your notes were not read into the facts: ${r.message}`);
    await keep("Filing the documents", 90);
  }

  // Done: what was made, in the person's words, and where to see it.
  const result = resultOf(plan, made, projectId, project.name);
  await save(orgId, userId, row.id, { state: "DONE", result, stage: null, progress: null, lease: "drop" }, "CREATING");
  await audit({
    orgId,
    actorUserId: userId,
    action: "setup.done",
    targetType: "scope_node",
    targetId: projectId,
    metadata: { towers: Object.keys(made.towers ?? {}).length, units: Object.keys(made.units ?? {}).length, pictures: Object.keys(made.pictures ?? {}).length, documents: Object.keys(made.documents ?? {}).length, problems: made.problems?.length ?? 0 },
  });

  // The documents are read after the card has landed; the worker finishes any this does not.
  if (extractions.length) {
    const { runExtraction } = await import("./extract.ts");
    for (const x of extractions) await runExtraction(orgId, x).catch((e) => console.error("setup: a reading failed", e));
  }
}

function resultOf(plan: Plan, made: Made, projectId: string, projectName: string): SetupResult {
  const lines: string[] = [];
  const towers = plan.towers.filter((t) => !t.id && made.towers?.[t.name]);
  if (towers.length) lines.push(`${towers.length === 1 ? "Tower" : "Towers"} added: ${towers.map((t) => t.name).join(", ")}.`);
  const units = Object.keys(made.units ?? {}).length;
  if (units) lines.push(`${units} flat ${units === 1 ? "type" : "types"}, waiting for the price to be approved.`);
  const pics = new Set(Object.keys(made.pictures ?? {}).map((k) => k.split("|")[0])).size;
  if (pics) lines.push(`${pics} ${pics === 1 ? "picture" : "pictures"} in the library, waiting for approval.`);
  const docs = Object.keys(made.documents ?? {}).length;
  if (docs) lines.push(`${docs === 1 ? "1 document is" : `${docs} documents are`} being read into the facts. Check each value before it is signed.`);
  const sharpened = made.sharpened?.length ?? 0;
  if (sharpened) lines.push(`${sharpened === 1 ? "1 small picture was" : `${sharpened} small pictures were`} sharpened.`);
  const cleaned = made.cleaned ?? [];
  if (cleaned.length) {
    const what = [...new Set(cleaned.flatMap((c) => c.removed))].slice(0, 4).join("; ");
    lines.push(`${cleaned.length === 1 ? "1 picture was" : `${cleaned.length} pictures were`} cleaned up (${what}). The picture as it came is kept as its first version.`);
  }
  if (made.leftFlaws?.length) lines.push(`Left as they are, since fixing them would show the place better than it is: ${made.leftFlaws.slice(0, 4).join("; ")}. Retake or replace these pictures if they matter.`);
  const polished = made.polished?.length ?? 0;
  if (polished) lines.push(`${polished === 1 ? "1 photograph was" : `${polished} photographs were`} polished for ads: wires, mess and haze taken out, the light and sky made brighter. The photograph as it came is kept as its first version.`);
  const rough = made.notPolished ?? [];
  if (rough.length) lines.push(`${rough.length === 1 ? "1 photograph went" : `${rough.length} photographs went`} in as ${rough.length === 1 ? "it" : "they"} came: ${rough.slice(0, 4).map((x) => `${x.title}, ${x.why}`).join("; ")}${rough.length > 4 ? `; and ${rough.length - 4} more` : ""}.`);
  if (made.logo === "SET") lines.push(`The logo from the files is set on ${projectName} with its background taken out, beside a white single-colour version. Change them in Library, Branding.`);
  if (made.logo === "HAD" && plan.logo) lines.push(`${projectName} already has a logo, so the one in the files was not used.`);
  if (made.logo === "MISSING") lines.push("No logo was found in the files. Add it in Library, Branding.");
  const unregistered = plan.towers.filter((t) => !t.id && made.towers?.[t.name]);
  if (unregistered.length) lines.push(reraLine(unregistered));
  lines.push(...plan.notes);
  lines.push(...(made.problems ?? []).slice(0, 6));
  const links: SetupResult["links"] = [{ label: "Review and approve", href: `/dashboard/projects/${projectId}/review` }, { label: "Open the project", href: `/dashboard/projects/${projectId}` }];
  const firstReg = unregistered[0] ? made.towers?.[unregistered[0].name] : null;
  if (firstReg) links.push({ label: "Fill in the RERA registration", href: `/dashboard/projects/${projectId}?register=${firstReg}#register` });
  if (docs) links.push({ label: "Check the facts read", href: `/dashboard/brain/${projectId}/documents` });
  return { message: plan.target.kind === "new" ? `${projectName} is set up. Nothing is used on an ad until it is approved.` : `Added to ${projectName}. Nothing is used on an ad until it is approved.`, lines, links, made };
}

// ---------------------------------------------------------------------------
// What the card shows
// ---------------------------------------------------------------------------

const TITLES: Record<string, string> = {
  which: "Project",
  target: "Project",
  entity: "Registered by",
  promoter: "Promoter",
  pan: "PAN",
  name: "Name",
  city: "City",
  towers: "Towers",
  towers1: "Towers",
  shared: "Homes in",
};

async function viewOf(orgId: string, userId: string, row: Row): Promise<SetupView> {
  const [files, standing] = await Promise.all([
    withPerson(orgId, userId, (sql) => sql<{ id: string; name: string; type: string }[]>`
      SELECT id, name, media_type AS type FROM ask_files WHERE setup_id = ${row.id} ORDER BY created_at`),
    standings(orgId, [row]),
  ]);
  return toView(row, files, standing);
}

/**
 * For each finished setup, whether the project it made is still there and
 * how much of it waits on a person (values read, pictures, flat types and
 * facts to sign), so its card never opens a removed project or offers a
 * review with nothing in it.
 */
async function standings(orgId: string, rows: readonly Row[]): Promise<Map<string, Standing>> {
  const projectOf = (r: Row) => (r.state === "DONE" && r.result ? setupProjectId(r.result.links ?? []) : null);
  const ids = [...new Set(rows.map(projectOf).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const got = await withTenant(orgId, (sql) => sql<{ id: string; waiting: string }[]>`
    SELECT p.id, (
        (SELECT count(*) FROM brain_proposals bp JOIN scope_nodes n ON n.id = bp.scope_node_id
           WHERE bp.org_id = ${orgId} AND bp.state = 'PROPOSED' AND n.path <@ p.path)
      + (SELECT count(*) FROM assets a JOIN scope_nodes n ON n.id = a.scope_node_id
           JOIN LATERAL (SELECT sha256 FROM asset_versions WHERE asset_id = a.id ORDER BY version DESC LIMIT 1) v ON true
           WHERE a.org_id = ${orgId} AND n.path <@ p.path
             AND NOT EXISTS (SELECT 1 FROM asset_approvals ap WHERE ap.asset_id = a.id AND ap.sha256 = v.sha256))
      + (SELECT count(*) FROM unit_types t JOIN scope_nodes n ON n.id = t.scope_node_id
           JOIN LATERAL (SELECT sha256 FROM unit_type_versions WHERE unit_type_id = t.id ORDER BY version DESC LIMIT 1) v ON true
           WHERE t.org_id = ${orgId} AND n.path <@ p.path
             AND NOT EXISTS (SELECT 1 FROM unit_type_approvals ap WHERE ap.unit_type_id = t.id AND ap.sha256 = v.sha256))
      + (SELECT count(*) FROM brain_versions b JOIN scope_nodes n ON n.id = b.scope_node_id
           WHERE b.org_id = ${orgId} AND b.state = 'DRAFT' AND n.path <@ p.path)
    )::text AS waiting
    FROM scope_nodes p
    WHERE p.org_id = ${orgId} AND p.kind = 'PROJECT' AND p.id = ANY(${ids}::uuid[])`).catch((e) => {
    console.error("setup: could not read what became of a project", e);
    return null;
  });
  if (!got) return new Map();
  const by = new Map(got.map((g) => [g.id, Number(g.waiting) || 0]));
  const out = new Map<string, Standing>();
  for (const r of rows) {
    const pid = projectOf(r);
    if (pid) out.set(r.id, by.has(pid) ? { gone: false, waiting: by.get(pid)! } : { gone: true, waiting: 0 });
  }
  return out;
}

function toView(row: Row, files: { id: string; name: string; type: string }[], standing?: Map<string, Standing>): SetupView {
  const plan = row.plan;
  const heading =
    row.state === "READY" || row.state === "CREATING" || row.state === "DONE"
      ? plan
        ? plan.target.kind === "new"
          ? `Set up ${plan.target.name}`
          : `Add to ${plan.target.name}`
        : "Set up a project"
      : row.proposal?.projects[0]?.name
        ? `Set up ${row.proposal.projects[0].name}`
        : "Set up a project from your files";
  const d = row.inputs?.filled ? row.inputs : { filled: {}, hints: {} };
  return {
    id: row.id,
    state: row.state,
    heading,
    files,
    stage: row.state === "READING" || row.state === "CREATING" ? row.stage ?? (row.state === "READING" ? "Reading your files" : "Setting it up") : null,
    progress: row.state === "READING" || row.state === "CREATING" ? row.progress ?? null : null,
    steps: row.state === "READING" || row.state === "CREATING" ? (row.activity ?? []).slice(-SETUP_STEPS_SHOWN) : [],
    questions: row.state === "ASKING" ? row.questions ?? [] : [],
    answered: row.state === "ASKING" ? recap(d, TITLES) : [],
    preview: row.state === "READY" && plan ? previewOf(plan) : null,
    pictures: row.state === "READY" ? pictureTiles(plan, row.permit?.skip ?? []) : [],
    result:
      row.result && ["DONE", "FAILED", "CANCELLED", "EXPIRED"].includes(row.state)
        ? standingResult({ message: row.result.message, lines: row.result.lines ?? [], links: row.result.links ?? [] }, standing?.get(row.id) ?? null)
        : null,
  };
}

export async function setupView(orgId: string, userId: string, id: string): Promise<SetupView | null> {
  const row = await load(orgId, userId, id);
  return row ? viewOf(orgId, userId, row) : null;
}

/** Every setup in a chat, by id, for the page that draws the chat. */
export async function setupViews(orgId: string, userId: string, threadId: string): Promise<Map<string, SetupView>> {
  if (!UUID.test(threadId)) return new Map();
  const rows = await withPerson(orgId, userId, (sql) => sql<Row[]>`SELECT ${sql.unsafe(COLS)} FROM project_setups WHERE thread_id = ${threadId} ORDER BY created_at`);
  if (!rows.length) return new Map();
  const [files, standing] = await Promise.all([
    withPerson(orgId, userId, (sql) => sql<{ id: string; name: string; type: string; setup_id: string }[]>`
      SELECT id, name, media_type AS type, setup_id FROM ask_files WHERE setup_id = ANY(${rows.map((r) => r.id)}::uuid[]) ORDER BY created_at`),
    standings(orgId, rows),
  ]);
  return new Map(
    rows.map((r) => {
      const row = expired(r) ? { ...r, state: "EXPIRED" as SetupState, result: { message: "This expired. Attach the files again to set the project up.", lines: [], links: [] } } : r;
      return [r.id, toView(row, files.filter((f) => f.setup_id === r.id), standing)];
    }),
  );
}

/** One picture of a setup, small, for the card's tile. Only its owner's. */
export async function setupPicture(orgId: string, userId: string, id: string, n: number): Promise<Buffer | null> {
  const row = await load(orgId, userId, id);
  const p = row?.pictures?.find((x) => x.n === n);
  if (!p) return null;
  const bytes = await storage().read(p.polished && "key" in p.polished ? p.polished.key : p.key).catch(() => null);
  if (!bytes) return null;
  return sharp(bytes).resize({ width: 360, height: 360, fit: "inside" }).webp({ quality: 72 }).toBuffer();
}

// ---------------------------------------------------------------------------
// The worker's part
// ---------------------------------------------------------------------------

/**
 * Setups a process left part way: read or make each one due. The script
 * lists them on the owner's connection, the way the other workers list
 * tenants (a setup is a person's row, and the worker is nobody); every read
 * and write here is that person's own.
 */
export async function runDueSetups(due: readonly { id: string; org_id: string; user_id: string; state: string }[]): Promise<number> {
  for (const s of due) {
    if (s.state === "READING") await readSetup(s.org_id, s.user_id, s.id);
    else if (s.state === "CREATING") await makeSetup(s.org_id, s.user_id, s.id);
  }
  return due.length;
}

