import { getViewer } from "@/lib/console";
import { readUploadToken } from "@/lib/extract";
import { SETUP_ZIP_BYTES } from "@/lib/setup-file-rules";
import { maySetUp } from "@/lib/setup";
import { storage } from "@/lib/storage";
import { keyParts } from "@/lib/sweep-rules";

/**
 * Where a file attached in Ask Jimmy is PUT when there is no bucket to
 * presign against: a development machine with `ASSETS_DIR`. With a bucket
 * the browser sends it straight there and this route is never asked.
 *
 * The token names the one key and type it was issued for, and lasts ten
 * minutes. What lands is checked again (its hash, its type, its pages)
 * before anything reads it.
 */
export async function PUT(request: Request) {
  const viewer = await getViewer();
  if (!viewer || viewer.via || !maySetUp(viewer.authz)) return new Response("Not found", { status: 404 });
  const target = readUploadToken(new URL(request.url).searchParams.get("t") ?? "");
  if (!target || keyParts(target.key, viewer.state.org.id)?.kind !== "askfile") return new Response("Not found", { status: 404 });
  if ((request.headers.get("content-type") ?? "") !== target.type) return new Response("Wrong type", { status: 415 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > SETUP_ZIP_BYTES) return new Response("Too large", { status: 413 });
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > SETUP_ZIP_BYTES) return new Response("Too large", { status: 413 });
  await storage().put(target.key, bytes, target.type);
  return new Response(null, { status: 200 });
}
