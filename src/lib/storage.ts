import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DERIVED, VIEW_WINDOW_SECONDS, derivedKey, viewWindow } from "./media-variant-rules.ts";
import { cdnConfig, cdnSignedUrl } from "./cdn.ts";

/**
 * Where uploaded files actually live.
 *
 * Everything before this stored bytes in a Postgres row. That was the honest
 * answer while there was no bucket, and it has a ceiling: reference media is
 * capped at 25 MB precisely because a row is the wrong home for a large file,
 * and the Approved Asset Library is dozens of renders per project rather than
 * a handful per campaign.
 *
 * **What is stored is the KEY, never a URL.** A URL that works in a browser
 * works for anybody holding it, forever, with no sign-in and no audit. That
 * would undo the guarantee every other table here rests on. The database
 * holds `org/<org_id>/<kind>/<id>`, the bucket is private with public access
 * blocked, and a reader who has passed the permission check is handed a
 * presigned link that expires in minutes.
 *
 * **The key carries the tenant.** Objects for one organisation share a
 * prefix, which makes per-tenant deletion, per-tenant metrics and a future
 * per-tenant bucket policy possible without moving a byte. It is also a
 * second place the tenant is written down, so a bug that resolved the wrong
 * org would have to make the same mistake twice.
 *
 * **`ASSETS_DIR` is a dev and test seam, never set in production.** It points
 * the driver at a local folder so `npm run check` is deterministic, offline
 * and free, the same arrangement `RERA_MH_SEARCH_DIR` provides for the portal
 * reads. An injected driver beats both, so a unit test is never quietly
 * served a real bucket.
 */

export type PutResult =
  | { ok: true; key: string; bytes: number; sha256: string }
  | { ok: false; code: "STORE_FAILED"; message: string };

export type GetResult =
  | { ok: true; url: string; expiresIn: number }
  | { ok: false; code: "NOT_STORED" | "SIGN_FAILED"; message: string };

export interface StorageDriver {
  readonly name: string;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /**
   * A link a browser may follow, good for `seconds` and no longer. `view`
   * signs it as of a fixed moment, so the same window gives the same link,
   * and asks the store to tell the browser to keep the file that long.
   */
  signedUrl(key: string, seconds: number, contentType?: string, view?: SignOptions): Promise<string>;
  /** Whether an object exists. Optional; a driver without it is asked by reading. */
  exists?(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /**
   * Duplicate an object without moving its bytes through this process.
   *
   * A copy between projects is otherwise a download and an upload of
   * something that never left the bucket. S3 does it server side for the
   * price of a request.
   */
  copy(fromKey: string, toKey: string): Promise<void>;
  /** For the checks, which assert on what was actually written. */
  read(key: string): Promise<Buffer | null>;
  /**
   * Every object under a prefix, for the orphan sweep (`asset-sweep.ts`).
   *
   * Optional, so a driver written for one check need not carry it. The sweep
   * refuses to run on a driver without it rather than guessing.
   */
  list?(prefix: string): Promise<StoredObject[]>;
  /** The folders one level under a prefix, as `org/<id>/`. */
  folders?(prefix: string): Promise<string[]>;
  /**
   * A link a browser may PUT one object to, good for `seconds`, with the
   * type pinned. For a file too large to pass through a hosted function's
   * request body, which is capped far below a brochure. Optional: the local
   * driver has none, and an upload there goes through a route instead.
   */
  uploadUrl?(key: string, seconds: number, contentType: string): Promise<string>;
}

export type StoredObject = { key: string; bytes: number; modified: Date };

/** How a link is signed beyond its key and life: a fixed moment, a cache life, a file name to save as. */
export type SignOptions = { signingDate?: Date; cacheSeconds?: number; attachment?: string };

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Build a key, or refuse.
 *
 * Every segment is checked rather than escaped. A key is a path, and a path
 * assembled from something a request supplied is how one tenant's prefix
 * becomes another's. None of these ever legitimately contain a slash.
 *
 * "." and ".." pass the character class, because a dot is legitimate inside a
 * segment, and they are refused separately. S3 keys are a flat namespace so
 * `org/../asset/x` is simply that key there, but the local driver joins the
 * same string into a filesystem path, and a key that climbs is a key that
 * writes wherever the process can.
 */
const CLIMBS = new Set([".", ".."]);

/** Folder names under a tenant, so never a kind. */
const FOLDERS = new Set(["project", "shared"]);

/**
 * Where an object lives: under its tenant, then under the project it
 * belongs to, or under `shared` when it belongs to the organisation or an
 * entity (a logo, a firm's own invoice) rather than to one project.
 *
 *   org/<org>/project/<project>/<kind>/<id>
 *   org/<org>/shared/<kind>/<id>
 *
 * Decided with the client on 4 October 2026, so a project's files can be
 * seen, counted and removed together. `project` is required, even when it
 * is null, so no caller forgets to say which.
 */
export function assetKey(parts: {
  orgId: string;
  project: string | null;
  kind: string;
  id: string;
}): string | null {
  const project = parts.project ?? null;
  const segs = [parts.orgId, parts.kind, parts.id, ...(project === null ? [] : [project])];
  if (!segs.every((s) => SEGMENT.test(s) && !CLIMBS.has(s))) return null;
  if (FOLDERS.has(parts.kind)) return null;
  return project === null
    ? `org/${parts.orgId}/shared/${parts.kind}/${parts.id}`
    : `org/${parts.orgId}/project/${project}/${parts.kind}/${parts.id}`;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// The local driver, for checks and for a machine with no bucket
// ---------------------------------------------------------------------------

class LocalDriver implements StorageDriver {
  readonly name = "local";
  // Written out rather than declared as a constructor parameter property:
  // that is TypeScript syntax which generates an assignment, and the checks
  // load this under `--experimental-strip-types`, which strips and never
  // generates.
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private path(key: string) {
    // The key is already validated by `assetKey`, and resolving under the
    // root is the belt to that braces: a key that climbed out of the folder
    // would write anywhere the process can.
    const full = resolve(join(this.root, key));
    if (!full.startsWith(resolve(this.root))) throw new Error("key escaped the store");
    return full;
  }

  async put(key: string, bytes: Buffer) {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }

  async signedUrl(key: string) {
    // No signing to do: the route reads through `read()` in this mode, and a
    // caller that followed this would be asking a filesystem path over HTTP.
    return `file://${this.path(key)}`;
  }

  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string) {
    return stat(this.path(key)).then(() => true, () => false);
  }

  async copy(fromKey: string, toKey: string) {
    const bytes = await readFile(this.path(fromKey));
    const file = this.path(toKey);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }

  async read(key: string) {
    return readFile(this.path(key)).catch(() => null);
  }

  async list(prefix: string) {
    // A prefix names a folder here, because every key the app writes is
    // folder/folder/file. The walk reports keys with forward slashes, the
    // way S3 spells them, whatever the platform's separator is.
    const out: StoredObject[] = [];
    const walk = async (dir: string, key: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory()) await walk(join(dir, e.name), `${key}${e.name}/`);
        else if (e.isFile()) {
          const s = await stat(join(dir, e.name));
          out.push({ key: `${key}${e.name}`, bytes: s.size, modified: s.mtime });
        }
      }
    };
    await walk(this.path(prefix), prefix.endsWith("/") ? prefix : `${prefix}/`);
    return out;
  }

  async folders(prefix: string) {
    const entries = await readdir(this.path(prefix), { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => `${prefix}${e.name}/`);
  }
}

// ---------------------------------------------------------------------------
// The S3 driver
// ---------------------------------------------------------------------------

class S3Driver implements StorageDriver {
  readonly name = "s3";
  private client: import("@aws-sdk/client-s3").S3Client | null = null;
  readonly bucket: string;
  readonly region: string;
  readonly profile: string | undefined;

  constructor(bucket: string, region: string, profile: string | undefined) {
    this.bucket = bucket;
    this.region = region;
    this.profile = profile;
  }

  /**
   * Built on first use, not at import.
   *
   * The credential chain touches the filesystem and the network, and doing
   * that while a module graph is still loading turns a missing profile into
   * an import error with no useful stack.
   */
  private async aws() {
    if (this.client) return this.client;
    const { S3Client } = await import("@aws-sdk/client-s3");
    const credentials = this.profile
      ? (await import("@aws-sdk/credential-providers")).fromIni({ profile: this.profile })
      : undefined;
    this.client = new S3Client({ region: this.region, credentials });
    return this.client;
  }

  async put(key: string, bytes: Buffer, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.aws();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        // Served inline to a signed-in viewer, so the browser must never
        // decide for itself what these bytes are.
        ContentDisposition: "inline",
      }),
    );
  }

  async signedUrl(key: string, seconds: number, contentType?: string, view?: SignOptions) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const client = await this.aws();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Pinned on the way out as well as the way in: the stored type is
        // what the allowlist approved, and a response that renamed itself
        // would be a type nobody checked.
        ResponseContentType: contentType,
        ResponseContentDisposition: view?.attachment
          ? `attachment; filename="${view.attachment.replace(/[^A-Za-z0-9._-]/g, "_")}"`
          : "inline",
        // Private: kept by this viewer's browser, never by a shared cache.
        ...(view?.cacheSeconds ? { ResponseCacheControl: `private, max-age=${view.cacheSeconds}` } : {}),
      }),
      view?.signingDate ? { expiresIn: seconds, signingDate: view.signingDate } : { expiresIn: seconds },
    );
  }

  async exists(key: string) {
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.aws();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async uploadUrl(key: string, seconds: number, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const client = await this.aws();
    return getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      // The type is signed, so the browser must send exactly it: what lands
      // is what the allowlist approved, and a read pins it again on the way
      // out (`signedUrl`).
      { expiresIn: seconds, signableHeaders: new Set(["content-type"]) },
    );
  }

  async remove(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.aws();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async copy(fromKey: string, toKey: string) {
    const { CopyObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.aws();
    await client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        // The source is bucket-qualified and must be encoded: a key holds
        // slashes, and an unencoded one names a different object.
        CopySource: encodeURI(`${this.bucket}/${fromKey}`),
        Key: toKey,
        MetadataDirective: "COPY",
      }),
    );
  }

  async read(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.aws();
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const chunks: Buffer[] = [];
      for await (const c of out.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  // Both listings follow the continuation token to the end. S3 answers a
  // thousand keys a page, and a sweep that read one page would call every
  // object past it unlisted, which is harmless, and every object on it
  // listed, which is the point: a partial read must never look like a
  // complete one, so a failed page throws rather than returning what came.
  async list(prefix: string) {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const client = await this.aws();
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        // No date reads as brand new, never as ancient: an object of unknown
        // age is inside the grace period, and so is never deleted.
        if (o.Key) out.push({ key: o.Key, bytes: o.Size ?? 0, modified: o.LastModified ?? new Date() });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async folders(prefix: string) {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const client = await this.aws();
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: "/", ContinuationToken: token }),
      );
      for (const p of page.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Choosing one
// ---------------------------------------------------------------------------

let driver: StorageDriver | null = null;

/** An injected driver beats the env, so a test is never served a real bucket. */
export function useStorage(d: StorageDriver | null): void {
  driver = d;
}

export function storage(): StorageDriver {
  if (driver) return driver;

  const local = process.env.ASSETS_DIR;
  if (local) {
    driver = new LocalDriver(local);
    return driver;
  }

  const bucket = process.env.ASSETS_BUCKET;
  if (!bucket) {
    throw new Error(
      "No file store configured. Set ASSETS_BUCKET, or ASSETS_DIR for a local one.",
    );
  }
  driver = new S3Driver(
    bucket,
    process.env.ASSETS_REGION ?? process.env.AWS_REGION ?? "ap-south-1",
    process.env.AWS_ASSETS_PROFILE ?? process.env.AWS_SES_PROFILE,
  );
  return driver;
}

/** Whether anything is configured at all, for a screen that has to say so. */
export function storageConfigured(): boolean {
  return !!(driver || process.env.ASSETS_DIR || process.env.ASSETS_BUCKET);
}

// ---------------------------------------------------------------------------
// What callers use
// ---------------------------------------------------------------------------

export async function putAsset(opts: {
  orgId: string;
  /** The project the file belongs to, or null for the organisation's own. */
  project: string | null;
  kind: string;
  id: string;
  bytes: Buffer;
  contentType: string;
}): Promise<PutResult> {
  const key = assetKey(opts);
  if (!key) {
    return { ok: false, code: "STORE_FAILED", message: "That is not a storable name." };
  }
  try {
    await storage().put(key, opts.bytes, opts.contentType);
    return { ok: true, key, bytes: opts.bytes.byteLength, sha256: sha256(opts.bytes) };
  } catch {
    return { ok: false, code: "STORE_FAILED", message: "Could not store that file." };
  }
}

/**
 * A link to one object, good for five minutes.
 *
 * Short on purpose. The permission was checked when this was issued, and a
 * link that outlives the check is a link that outlives the permission.
 */
export const SIGNED_URL_SECONDS = 300;

export async function assetUrl(key: string, contentType?: string): Promise<GetResult> {
  try {
    const url = await storage().signedUrl(key, SIGNED_URL_SECONDS, contentType);
    return { ok: true, url, expiresIn: SIGNED_URL_SECONDS };
  } catch {
    return { ok: false, code: "SIGN_FAILED", message: "Could not open that file." };
  }
}

/**
 * A link for showing a file on a console screen: the same for every request
 * in the hour (`viewWindow()`), with at least an hour left, and the browser
 * told to keep the file for what is left. A second look at a picture is then
 * read from the browser rather than downloaded again. Issued only after the
 * permission check, like every link here; the client chose the hour on 7
 * October 2026 over five minutes, for people on slow internet.
 */
export async function viewUrl(
  key: string,
  contentType?: string,
  now = new Date(),
): Promise<{ ok: true; url: string; maxAge: number } | { ok: false }> {
  const w = viewWindow(now);
  // From the nearest CloudFront edge when it is set up; never for a local store.
  const cdn = cdnConfig();
  if (cdn && storage().name === "s3") {
    try {
      return { ok: true, url: cdnSignedUrl(cdn, key, new Date(w.signingDate.getTime() + w.expiresIn * 1000)), maxAge: w.maxAge };
    } catch {
      // A key that will not sign falls back to the bucket.
    }
  }
  try {
    const url = await storage().signedUrl(key, w.expiresIn, contentType, {
      signingDate: w.signingDate,
      // Fixed, not the time left: it is signed into the link, and a value
      // that changed by the second would change the link with it.
      cacheSeconds: VIEW_WINDOW_SECONDS,
    });
    return { ok: true, url, maxAge: w.maxAge };
  } catch {
    return { ok: false };
  }
}

/**
 * A link that saves a file rather than showing it, under the name given,
 * good for five minutes like any other link a person is handed. Null for a
 * store whose links a browser cannot follow (the local folder).
 */
export async function downloadUrl(key: string, contentType: string, filename: string): Promise<string | null> {
  try {
    const url = await storage().signedUrl(key, SIGNED_URL_SECONDS, contentType, { attachment: filename });
    return url.startsWith("file://") ? null : url;
  } catch {
    return null;
  }
}

/** Whether a stored object exists: the driver's own answer, or a read. */
export async function assetExists(key: string): Promise<boolean> {
  const d = storage();
  if (d.exists) return d.exists(key).catch(() => false);
  return (await d.read(key).catch(() => null)) !== null;
}

/**
 * A link a platform fetches a post's file from, good for an hour.
 *
 * Instagram and Business Profile do not take uploads: they fetch from a URL,
 * sometimes minutes later for a video. So this is longer than a person's
 * five minutes, it is issued only by the publisher, only for a file already
 * cleared to go out, and never shown to anybody.
 */
export const PLATFORM_URL_SECONDS = 3600;

export async function platformUrl(key: string, contentType?: string): Promise<string | null> {
  try {
    return await storage().signedUrl(key, PLATFORM_URL_SECONDS, contentType);
  } catch {
    return null;
  }
}

export async function removeAsset(key: string): Promise<void> {
  await storage().remove(key).catch(() => {});
  // Its lighter copies go with it; one never made is a delete of nothing.
  await Promise.all(
    (Object.keys(DERIVED) as (keyof typeof DERIVED)[]).map((v) => storage().remove(derivedKey(key, v)).catch(() => {})),
  );
}

export type CopyResult =
  | { ok: true; key: string }
  | { ok: false; code: "COPY_FAILED"; message: string };

/** Duplicate one object under a new key, server side. */
export async function copyAsset(opts: {
  fromKey: string;
  orgId: string;
  project: string | null;
  kind: string;
  id: string;
}): Promise<CopyResult> {
  const key = assetKey(opts);
  if (!key) {
    return { ok: false, code: "COPY_FAILED", message: "That is not a storable name." };
  }
  try {
    await storage().copy(opts.fromKey, key);
    return { ok: true, key };
  } catch {
    return { ok: false, code: "COPY_FAILED", message: "Could not copy that file." };
  }
}

export async function readAsset(key: string): Promise<Buffer | null> {
  return storage().read(key);
}
