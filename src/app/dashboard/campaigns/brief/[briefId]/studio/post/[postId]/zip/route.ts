import { fileReader } from "@/lib/guard";
import { campaignPath } from "@/lib/campaign-reach";
import { postFiles } from "@/lib/compose";
import { zipStored } from "@/lib/zip";

/**
 * Every slide of one made post in one ZIP: how a person takes a carousel to
 * wherever they publish it, instead of saving five files one by one.
 *
 * The gate the single-file route has: signed in, with `campaign:read`, and
 * the row read through `withTenant()`, so another organisation's post
 * resolves to nothing. A 404 for all three.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ postId: string }> }) {
  const viewer = await fileReader();
  if (!viewer || !viewer.authz.can("campaign:read")) {
    return new Response("Not found", { status: 404 });
  }
  const { postId } = await params;
  // Held where the campaign sits, not merely somewhere.
  const reach = await campaignPath(viewer.orgId, "post", postId);
  if (!reach || !viewer.authz.canAt("campaign:read", reach)) return new Response("Not found", { status: 404 });
  const post = await postFiles(viewer.orgId, postId);
  if (!post) return new Response("Not found", { status: 404 });

  const noun = post.kind === "CAROUSEL" ? "slide" : post.kind === "VIDEO" ? "clip" : "image";
  const pad = String(post.files.length).length;
  const zip = zipStored(
    post.files.map((f, i) => ({
      name: `${noun}-${String(i + 1).padStart(Math.max(2, pad), "0")}.${f.type === "video/mp4" ? "mp4" : "jpg"}`,
      bytes: f.bytes,
    })),
  );
  const kind = post.kind.toLowerCase();
  return new Response(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-length": String(zip.byteLength),
      "content-disposition": `attachment; filename="${kind}-${postId.slice(0, 8)}.zip"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
