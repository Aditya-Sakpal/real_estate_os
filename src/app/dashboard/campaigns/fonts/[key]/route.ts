import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileReader } from "@/lib/guard";
import { fontFile, fontFor } from "@/lib/font-rules";

/**
 * One face from the post font catalog, so the picker can show each choice
 * in itself. Our own files, rather than a font service, so the console asks
 * nothing of anybody else to draw a menu.
 *
 * The catalog is ours rather than any tenant's, so the gate is being signed
 * in with `campaign:read`, the rule the template route follows. The key is
 * matched against the catalog before any path is built from it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const reader = await fileReader();
  if (!reader || !reader.authz.can("campaign:read")) {
    return new Response("Not found", { status: 404 });
  }
  const { key } = await params;
  const font = fontFor(key);
  if (!font) return new Response("Not found", { status: 404 });
  const weight = new URL(request.url).searchParams.get("w") === "bold" ? "Bold" : "Regular";
  const bytes = await readFile(join(process.cwd(), fontFile(font.key, weight))).catch(() => null);
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "font/ttf",
      "content-length": String(bytes.byteLength),
      "cache-control": "private, max-age=604800, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
