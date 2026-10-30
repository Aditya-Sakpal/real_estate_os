/**
 * Puts the video template library's preview clips in the file store and
 * writes `template_library/video-ads-templates/clips.json`, which names them.
 *
 * The clips are kept out of git, so a deployment has only their stills; with
 * the list committed, the picker's viewer plays each clip from the store.
 * Run it after adding or replacing a clip, then commit clips.json.
 *
 *   npm run templates:clips
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetExists, storage } from "../src/lib/storage.ts";
import { clipStoreKey } from "../src/lib/templates.ts";

const ROOT = join(process.cwd(), "template_library", "video-ads-templates");
const LIST = join(ROOT, "clips.json");

const before: Record<string, string> = JSON.parse(await readFile(LIST, "utf8").catch(() => "{}"));
const after: Record<string, string> = {};
let sent = 0;
let kept = 0;

for (const folder of (await readdir(ROOT, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
  const names = (await readdir(join(ROOT, folder))).filter((n) => /\.mp4$/i.test(n)).sort();
  for (const name of names) {
    const bytes = await readFile(join(ROOT, folder, name));
    const version = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const id = `${folder}/${name}`;
    const key = clipStoreKey(folder, name);
    if (before[id] === version && (await assetExists(key))) {
      kept++;
    } else {
      await storage().put(key, bytes, "video/mp4");
      sent++;
      console.log(`sent ${id} (${(bytes.byteLength / 1e6).toFixed(1)} MB)`);
    }
    after[id] = version;
  }
}

await writeFile(LIST, `${JSON.stringify(after, null, 2)}\n`);
console.log(`${sent} sent, ${kept} already there, ${Object.keys(after).length} in clips.json`);
