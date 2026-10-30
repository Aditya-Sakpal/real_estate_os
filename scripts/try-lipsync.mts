/**
 * Try the lip pass on a film already made, without a new film:
 *
 *   npm run lipsync:try --  <film.mp4> <out.mp4> <presenter spans> [remade spans] [--fake <take.mp4>]
 *
 * Spans are "0-3.24,8.96-13". With --fake, Sync Labs is not asked: the
 * given take is handed back for every scene, so the plumbing (the voice,
 * SyncNet before and after, the splice) is proven for nothing.
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncLips, useLipSync, type LipSyncPlan } from "../src/lib/lipsync.ts";

const [film, out, talkingArg, remadeArg = "", ...rest] = process.argv.slice(2);
if (!film || !out || !talkingArg) {
  console.error("usage: try-lipsync.mts <film.mp4> <out.mp4> <presenter spans> [remade spans] [--fake <take.mp4>]");
  process.exit(2);
}
const spans = (s: string) =>
  s.split(",").filter(Boolean).map((p) => {
    const [a, b] = p.split("-").map(Number);
    return { start: a, end: b };
  });
const fake = rest[0] === "--fake" ? rest[1] : null;
if (fake) useLipSync({ sync: async () => ({ ok: true, bytes: await readFile(fake) }) });

const dir = join(dirname(out), "lips-work");
await mkdir(dir, { recursive: true });
const plan: { lipSync?: LipSyncPlan } = {};
const r = await syncLips({
  video: film,
  voiceOf: film,
  sounds: [film],
  talking: spans(talkingArg),
  remade: spans(remadeArg),
  dir,
  plan,
  save: async () => {},
});
console.log(JSON.stringify({ notes: r?.notes ?? null, spans: plan.lipSync?.spans.map((s) => ({ ...s, file: s.file ? "yes" : null })), usd: plan.lipSync?.usd }, null, 1));
if (r?.files.length) {
  await copyFile(r.files[0], out);
  console.log("written", out);
}
