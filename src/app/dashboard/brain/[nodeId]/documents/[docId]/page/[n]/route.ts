import sharp from "sharp";
import { fileReader } from "@/lib/guard";
import { documentFile, pagePreview } from "@/lib/extract";

/**
 * One page of a Brain document as a picture, for the review screen.
 *
 * With `box=x,y,w,h` (fractions of the page) it is the part of the page
 * around that box, with the box drawn on it: the thumbnail beside a value is
 * the words it was read from, large enough to read. Without, the whole page.
 * Guarded like every file route: signed in, `brain:read` at the document's
 * own node, and the row read inside the tenant; a 404 for all three.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ nodeId: string; docId: string; n: string }> },
) {
  const viewer = await fileReader();
  if (!viewer) return new Response("Not found", { status: 404 });
  const { nodeId, docId, n } = await params;
  const doc = await documentFile(viewer.orgId, docId);
  if (!doc || doc.nodeId !== nodeId || !viewer.authz.canAt("brain:read", doc.path)) {
    return new Response("Not found", { status: 404 });
  }
  const page = await pagePreview(viewer.orgId, doc, Number(n));
  if (!page) return new Response("Not found", { status: 404 });

  let out: Buffer = page;
  const box = (new URL(request.url).searchParams.get("box") ?? "").split(",").map(Number);
  if (box.length === 4 && box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    out = await crop(page, { x: box[0], y: box[1], w: box[2], h: box[3] }).catch(() => page);
  }
  return new Response(new Uint8Array(out), {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(out.byteLength),
      // Tenant data: never a shared cache. The page's bytes never change
      // (the document is content-addressed), so a viewer may keep it.
      "cache-control": "private, max-age=3600",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The part of the page around a box, with the box drawn round in the console's blue. */
async function crop(jpg: Buffer, b: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const meta = await sharp(jpg).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const bx = b.x * W;
  const by = b.y * H;
  const bw = Math.max(4, b.w * W);
  const bh = Math.max(4, b.h * H);
  // The shape of the thumbnail it fills (5:3), tight enough to read the
  // words, wide enough to see the row they sit in.
  const cw = Math.round(Math.min(W, Math.max(bw * 1.3, W * 0.4)));
  const ch = Math.round(Math.min(H, Math.max(bh * 2.5, cw * 0.6)));
  const left = Math.round(Math.min(Math.max(0, bx + bw / 2 - cw / 2), W - cw));
  const top = Math.round(Math.min(Math.max(0, by + bh / 2 - ch / 2), H - ch));
  const pad = Math.max(4, Math.round(bh * 0.25));
  const rx = Math.max(0, bx - left - pad);
  const ry = Math.max(0, by - top - pad);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}">
    <rect x="${rx}" y="${ry}" width="${bw + pad * 2}" height="${bh + pad * 2}" rx="${Math.min(10, pad * 2)}"
      fill="rgba(43,92,230,0.10)" stroke="#2b5ce6" stroke-width="${Math.max(2, Math.round(cw / 320))}"/>
  </svg>`;
  return sharp(jpg)
    .extract({ left, top, width: cw, height: ch })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .resize({ width: Math.min(cw, 900), withoutEnlargement: true })
    .jpeg({ quality: 84 })
    .toBuffer();
}
