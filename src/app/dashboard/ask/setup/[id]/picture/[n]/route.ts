import { fileReader } from "@/lib/guard";
import { setupPicture } from "@/lib/setup";

/** One picture a setup found, small, for its card. Only the setup's owner gets it. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const reader = await fileReader();
  if (!reader) return new Response("Not found", { status: 404 });
  const { id, n } = await params;
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1) return new Response("Not found", { status: 404 });
  const bytes = await setupPicture(reader.orgId, reader.userId, id, num);
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "image/webp", "cache-control": "private, no-cache", "x-content-type-options": "nosniff" },
  });
}
