/**
 * The orphan sweep's decisions. Pure and database-free, covered by
 * `check:logic`; `asset-sweep.ts` reads the bucket and the rows and acts.
 *
 * An orphan is an object in the file store that no row points at. The
 * ordinary paths leave none (`removeAssetRow()` takes the object with the
 * row, `addAsset()` takes it back when the row fails), but a raw DELETE, a
 * cascade from a removed tower, or a process that died between the upload
 * and the insert all leave bytes nobody can see and nobody will delete.
 *
 * Deleting is the dangerous half, so every rule here leans towards keeping:
 *
 * 1. **Young objects are never orphans.** An upload lands before its row, so
 *    an object minutes old with no row is usually a row about to be written.
 * 2. **A kind nobody reads is never swept.** Every key is
 *    `org/<org>/<kind>/<id>`, and each column below says which kinds it
 *    holds. An object of a kind no column claims is a feature this file has
 *    not been told about, and its rows are somewhere the sweep does not look.
 * 3. **Too many orphans is a broken read, not a finding.** The RERA sweep's
 *    floor, applied to files: a reader that missed a table would make every
 *    object in it look orphaned, so a tenant where too large a share looks
 *    that way is refused whole.
 * 4. **The store belongs to one database.** Rows in one database cannot
 *    vouch for objects another database wrote, so the store names the
 *    database that may sweep it, and anything else is refused.
 */

import { baseOfDerived } from "./media-variant-rules.ts";

/** An object younger than this is never deleted. */
export const SWEEP_GRACE_HOURS = 24;

/** A tenant is refused when more than this share of its objects is orphaned... */
export const SWEEP_MAX_SHARE = 0.2;
/** ...and there are at least this many, below which the share says nothing. */
export const SWEEP_SHARE_FLOOR = 10;

/** Where the store names the database that owns it. Outside `org/`, so never swept. */
export const OWNER_KEY = "sweep-owner.json";

/**
 * Every column that holds a storage key.
 *
 * A key in a JSON column is found anywhere in the document, so a new field
 * inside `media` or `inputs` is covered without touching this list. A new
 * TABLE is not, which is why `check:sweep` scans every text and JSON column
 * in the database and fails when a key turns up in one that is not here.
 */
export type KeyColumn = { table: string; column: string; json: boolean; kinds: readonly string[] };

export const KEY_COLUMNS: readonly KeyColumn[] = [
  { table: "asset_versions", column: "storage_key", json: false, kinds: ["asset"] },
  { table: "generated_media", column: "storage_key", json: false, kinds: ["backdrop"] },
  { table: "rendered_posts", column: "media", json: true, kinds: ["post"] },
  // A film's own unstamped copy, kept for a new version (`inputs.film.raw`).
  { table: "rendered_posts", column: "inputs", json: true, kinds: ["post"] },
  { table: "post_creatives", column: "media", json: true, kinds: ["post"] },
  { table: "post_creatives", column: "storage_key", json: false, kinds: ["post"] },
  // What went out, frozen. It shares the keys of the post it came from.
  { table: "publish_targets", column: "media", json: true, kinds: ["post"] },
  { table: "partner_invoices", column: "storage_key", json: false, kinds: ["invoice"] },
  // A host's voice note after a visit, kept as it was said.
  { table: "visit_notes", column: "storage_key", json: false, kinds: ["visitnote"] },
  // A Brain document, content-addressed, and the pages drawn for its review.
  { table: "brain_documents", column: "storage_key", json: false, kinds: ["doc"] },
  { table: "brain_documents", column: "previews", json: true, kinds: ["docpage"] },
  // A broadcast's picture: a copy of the key of the post it came from.
  { table: "broadcasts", column: "media_key", json: false, kinds: ["post"] },
  // A call's recording, copied from Sarvam (0097).
  { table: "calls", column: "recording_key", json: false, kinds: ["recording"] },
  // A file attached in Ask Jimmy, and the pictures a setup found in its files (0114).
  { table: "ask_files", column: "storage_key", json: false, kinds: ["askfile"] },
  { table: "project_setups", column: "pictures", json: true, kinds: ["setuppic"] },
];

export const SWEPT_KINDS: ReadonlySet<string> = new Set(KEY_COLUMNS.flatMap((c) => c.kinds));

export type Listed = { key: string; bytes: number; modified: Date };

/** The prefix one tenant's objects live under. */
export function tenantPrefix(orgId: string): string {
  return `org/${orgId}/`;
}

/**
 * The kind segment of a tenant's key, or null for anything not shaped like
 * one. Three shapes: `project/<project>/<kind>/<id>`, `shared/<kind>/<id>`,
 * and the flat `<kind>/<id>` every key had before 4 October 2026.
 */
export function kindOf(key: string, orgId: string): string | null {
  return keyParts(key, orgId)?.kind ?? null;
}

export type KeyParts = { project: string | null; kind: string; id: string; flat: boolean };

export function keyParts(key: string, orgId: string): KeyParts | null {
  const prefix = tenantPrefix(orgId);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length).split("/");
  if (rest[0] === "project") {
    return rest.length >= 4 && rest[1] && rest[2] && rest.slice(3).join("/")
      ? { project: rest[1], kind: rest[2], id: rest.slice(3).join("/"), flat: false }
      : null;
  }
  if (rest[0] === "shared") {
    return rest.length >= 3 && rest[1] && rest.slice(2).join("/") ? { project: null, kind: rest[1], id: rest.slice(2).join("/"), flat: false } : null;
  }
  return rest.length >= 2 && rest[0] && rest.slice(1).join("/") ? { project: null, kind: rest[0], id: rest.slice(1).join("/"), flat: true } : null;
}

export type Sorted = {
  /** Unreferenced, old enough, of a kind the sweep reads: may be deleted. */
  orphans: Listed[];
  /** Unreferenced but inside the grace period. */
  young: number;
  /** Unreferenced objects of a kind no column claims, by kind. Never deleted. */
  unknown: Record<string, number>;
  referencedObjects: number;
  bytes: number;
};

export function sortObjects(input: {
  orgId: string;
  objects: readonly Listed[];
  referenced: ReadonlySet<string>;
  now: Date;
  graceHours?: number;
}): Sorted {
  const cutoff = input.now.getTime() - (input.graceHours ?? SWEEP_GRACE_HOURS) * 3_600_000;
  const out: Sorted = { orphans: [], young: 0, unknown: {}, referencedObjects: 0, bytes: 0 };
  for (const o of input.objects) {
    out.bytes += o.bytes;
    // A lighter copy of a file (a tile's small picture, a video's still or
    // preview) lives exactly as long as the file it was made from.
    const base = baseOfDerived(o.key);
    if (input.referenced.has(o.key) || (base !== null && input.referenced.has(base))) {
      out.referencedObjects++;
      continue;
    }
    const kind = kindOf(o.key, input.orgId);
    if (!kind || !SWEPT_KINDS.has(kind)) {
      const k = kind ?? "(unshaped)";
      out.unknown[k] = (out.unknown[k] ?? 0) + 1;
      continue;
    }
    // An unreadable date is young, never ancient.
    const t = o.modified.getTime();
    if (!Number.isFinite(t) || t > cutoff) {
      out.young++;
      continue;
    }
    out.orphans.push(o);
  }
  return out;
}

export type Refusal = "NOTHING_REFERENCED" | "TOO_MANY";

/**
 * Whether a tenant's result looks like a broken read rather than a finding.
 *
 * Objects with no reference at all is what a reader that saw no rows
 * produces (RLS fails closed, so an unpinned tenant reads as empty), and a
 * large share orphaned is what a reader that missed a table produces.
 */
export function refusalFor(input: { objects: number; referencedKeys: number; orphans: number }): Refusal | null {
  if (input.orphans === 0) return null;
  if (input.referencedKeys === 0) return "NOTHING_REFERENCED";
  if (input.orphans >= SWEEP_SHARE_FLOOR && input.orphans / Math.max(1, input.objects) > SWEEP_MAX_SHARE) {
    return "TOO_MANY";
  }
  return null;
}

export function refusalWords(r: Refusal): string {
  return r === "NOTHING_REFERENCED"
    ? "no row points at any of its files, which is what a failed read looks like"
    : `more than ${Math.round(SWEEP_MAX_SHARE * 100)} per cent of its files look orphaned, which is what a missed table looks like`;
}

// ---------------------------------------------------------------------------
// Which database owns the store
// ---------------------------------------------------------------------------

/**
 * A database's identity: the cluster's system identifier and the database
 * name. The identifier is written by initdb and is not carried by a dump, so
 * a copy restored elsewhere is a different database, which is exactly the
 * case this exists for: production was restored from the development
 * database, and both held the same org ids in one bucket.
 */
export function databaseId(systemIdentifier: string, database: string): string {
  return `pg:${systemIdentifier}/${database}`;
}

export function ownerMarker(id: string, at: Date): string {
  return JSON.stringify({ database: id, claimedAt: at.toISOString() });
}

export type OwnerProblem = "UNCLAIMED" | "UNREADABLE" | "OTHER_DATABASE";

export function readOwner(text: string | null): { database: string } | "UNCLAIMED" | "UNREADABLE" {
  if (text === null) return "UNCLAIMED";
  try {
    const v = JSON.parse(text) as { database?: unknown };
    return typeof v.database === "string" && v.database.startsWith("pg:") ? { database: v.database } : "UNREADABLE";
  } catch {
    return "UNREADABLE";
  }
}

export function ownerProblem(text: string | null, id: string): OwnerProblem | null {
  const owner = readOwner(text);
  if (typeof owner === "string") return owner;
  return owner.database === id ? null : "OTHER_DATABASE";
}

export function ownerWords(p: OwnerProblem): string {
  switch (p) {
    case "UNCLAIMED":
      return "This file store names no database. Run `npm run assets:sweep -- --claim` against the database that owns it.";
    case "UNREADABLE":
      return `The store's ${OWNER_KEY} cannot be read. Nothing was swept.`;
    case "OTHER_DATABASE":
      return "This file store belongs to another database. Rows here cannot vouch for its files, so nothing was swept.";
  }
}
