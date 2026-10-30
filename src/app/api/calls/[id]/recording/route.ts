import { fileReader } from "@/lib/guard";
import { after } from "next/server";
import { callRecording, type CallAudio } from "@/lib/calling";
import { archiveRecording, forgetMissingRecording, recordingSource } from "@/lib/recordings";
import { downloadUrl, readAsset, viewUrl } from "@/lib/storage";
import { audit } from "@/lib/db";

/** How long after a call is placed a missing recording is still on its way. */
const RECORDING_READY_MS = 30 * 60_000;

/**
 * One call's recording. From our own bucket once the worker has copied it
 * there (a redirect to a viewing link, or a download link), else fetched
 * from Sarvam and streamed through us, and copied to the bucket after.
 * `?link=1` answers the player with where to play it from.
 *
 * The recording holds a buyer's voice, so it is read inside the viewer's own
 * tenant, only by somebody who may see leads, and never cached by a browser
 * or anything between. `fileReader()` and not `getViewer()`: an audio element
 * asks several times (the file, then a window per seek), and each ask used to
 * load the whole console first.
 *
 * Ranges are answered, because a player that gets the whole file on every
 * seek re-downloads it, and Safari will not play without a 206.
 *
 * `?download=1` hands the same bytes over as a file to save, named by when
 * the call was placed, and is audited (playing is not): a saved recording
 * leaves the console for good. It is also the address an exported call log
 * links to, so a link opened by somebody without access opens nothing.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const reader = await fileReader();
  if (!reader || !reader.authz.can("lead:read")) return new Response("Not found", { status: 404 });
  const params = new URL(request.url).searchParams;
  const download = params.get("download") === "1";
  let source = await recordingSource(reader.orgId, id);
  // A row naming a file the bucket lost (two copies once raced and one
  // removed the other's) is let go of, and the recording comes from Sarvam
  // again. Asked where a person starts: the player's first ask, a download.
  if (source?.kind === "stored" && (download || params.get("link") === "1")) {
    if (await forgetMissingRecording(reader.orgId, id, source.key).catch(() => false)) {
      source = await recordingSource(reader.orgId, id);
    }
  }
  if (!source) return Response.json({ gone: true }, { status: 404, headers: { "cache-control": "no-store" } });

  if (download) {
    await audit({
      orgId: reader.orgId,
      actorUserId: reader.userId,
      action: "call.recording_downloaded",
      targetType: "call",
      targetId: id,
      metadata: { from: source.kind },
    });
  }

  // In our bucket: a link to it, for the player, a download or a play.
  let audio: CallAudio | null = null;
  if (source.kind === "stored") {
    const name = recordingName(source.placedAt, source.type);
    if (download) {
      const url = await downloadUrl(source.key, source.type, name);
      if (url) return new Response(null, { status: 302, headers: { location: url, "cache-control": "private, no-store" } });
    } else {
      const link = await viewUrl(source.key, source.type);
      if (link.ok && !link.url.startsWith("file://")) {
        if (params.get("link") === "1") {
          return Response.json({ url: link.url }, { headers: { "cache-control": `private, max-age=${link.maxAge}` } });
        }
        return new Response(null, { status: 302, headers: { location: link.url, "cache-control": `private, max-age=${link.maxAge}` } });
      }
    }
    // The local folder's links are paths no browser follows: the bytes, below.
    const bytes = await readAsset(source.key);
    if (bytes) audio = { bytes: new Uint8Array(bytes), type: source.type, placedAt: source.placedAt };
  }

  // Not copied yet: the player streams it through this route, once Sarvam
  // has said it still holds it (kept in memory for the play that follows). A
  // recording Sarvam no longer holds is said to be gone, not to try again.
  if (!audio && params.get("link") === "1") {
    const held = await callRecording(reader.orgId, id).catch(() => undefined);
    // Sarvam saves a recording a little after the call ends, so a call just
    // finished is not yet there: that is "not ready", never "gone".
    if (held === null && Date.now() - source.placedAt.getTime() < RECORDING_READY_MS) {
      return Response.json({ pending: true }, { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (held === null) return Response.json({ gone: true }, { status: 404, headers: { "cache-control": "no-store" } });
    return Response.json({ url: `/api/calls/${id}/recording` }, { headers: { "cache-control": "no-store" } });
  }
  if (!audio) {
    audio = await callRecording(reader.orgId, id).catch((e: unknown) => {
      console.error("[recording] could not fetch from Sarvam:", e instanceof Error ? e.message : e);
      return null;
    });
    if (!audio) return new Response("Not found", { status: 404 });
    // Copied to our bucket after the answer, so the next play is from there.
    // Not on Vercel, which has no FFmpeg to make the small MP3: the worker
    // copies it there within minutes of the call.
    if (!process.env.VERCEL) {
      const got = audio;
      const orgId = reader.orgId;
      after(() => archiveRecording(orgId, id, got).catch(() => {}));
    }
  }

  const total = audio.bytes.byteLength;
  const headers: Record<string, string> = {
    "content-type": audio.type,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    ...(download ? { "content-disposition": `attachment; filename="${recordingName(audio.placedAt, audio.type)}"` } : {}),
  };

  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] || match[2])) {
      let start: number;
      let end: number;
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
      } else {
        // "bytes=-500" is the last 500 bytes.
        start = Math.max(0, total - Number(match[2]));
        end = total - 1;
      }
      if (start <= end && start < total) {
        const slice = audio.bytes.subarray(start, end + 1);
        return new Response(new Uint8Array(slice), {
          status: 206,
          headers: {
            ...headers,
            "content-range": `bytes ${start}-${end}/${total}`,
            "content-length": String(slice.byteLength),
          },
        });
      }
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    }
  }

  return new Response(new Uint8Array(audio.bytes), {
    headers: { ...headers, "content-length": String(total) },
  });
}

/** `call-2026-10-06-1335.wav`: the IST minute the call was placed. */
function recordingName(placedAt: Date, type: string): string {
  const ist = new Date(placedAt.getTime() + 19_800_000).toISOString();
  const ext = /wav/i.test(type) ? "wav" : /mpeg|mp3/i.test(type) ? "mp3" : /ogg/i.test(type) ? "ogg" : /mp4|m4a|aac/i.test(type) ? "m4a" : "audio";
  return `call-${ist.slice(0, 10)}-${ist.slice(11, 13)}${ist.slice(14, 16)}.${ext}`;
}
