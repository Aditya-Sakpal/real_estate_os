import { getViewer } from "@/lib/console";
import { readUploadToken } from "@/lib/extract";
import { MAX_DOC_BYTES } from "@/lib/extract-rules";
import { storage } from "@/lib/storage";
import { keyParts } from "@/lib/sweep-rules";

/**
 * Where a document is PUT when there is no bucket to presign against: a
 * development machine with `ASSETS_DIR`. With a bucket the browser sends the
 * file straight to it and this route is never asked.
 *
 * The token names the one key and type it was issued for, after the
 * permission check, and lasts ten minutes. The viewer must still be signed
 * in. What lands is checked again (hash, type, pages) before anything is
 * filed, so this only ever writes bytes that are then proved or removed.
 */
export async function PUT(request: Request) {
  const viewer = await getViewer();
  if (!viewer || !viewer.authz.can("brain:edit")) return new Response("Not found", { status: 404 });
  const target = readUploadToken(new URL(request.url).searchParams.get("t") ?? "");
  if (!target || keyParts(target.key, viewer.state.org.id)?.kind !== "doc") return new Response("Not found", { status: 404 });
  if ((request.headers.get("content-type") ?? "") !== target.type) return new Response("Wrong type", { status: 415 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_DOC_BYTES) return new Response("Too large", { status: 413 });
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOC_BYTES) return new Response("Too large", { status: 413 });
  await storage().put(target.key, bytes, target.type);
  return new Response(null, { status: 200 });
}
