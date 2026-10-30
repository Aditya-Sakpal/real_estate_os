// Fill `assets/music/` with public-domain (CC0) background tracks for story
// reels, and write `assets/music/tracks.json` describing each one.
//
//   node scripts/fetch-music.mjs [per-mood]
//
// No music API key is configured, so the library is a folder. Only tracks
// Chosic marks Creative Commons CC0 are kept: free for commercial use, no
// credit line, which an advertisement has no room for. The site sits behind
// Cloudflare, which refuses Node's own fetch, so pages come through curl.
// Tracks are fetched one at a time with a pause, the way a person would.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "assets/music";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const curl = (url, referer) =>
  execFileSync("curl", ["-s", "-L", "-A", UA, ...(referer ? ["-e", referer] : []), url], { maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PER = Number(process.argv[2] ?? 4);

// Our moods, and the Chosic tags that feed each.
const MOODS = {
  uplifting: ["uplifting", "motivational", "hopeful", "positive", "advertising", "corporate"],
  warm: ["emotional", "sentimental", "romantic", "piano", "dreamy", "calm"],
  cinematic: ["cinematic", "epic", "documentary"],
  festive: ["celebration", "happy", "indian"],
};
// Nothing that sets the wrong mood under a home advertisement.
const AVOID_TAGS = ["horror", "dark", "sad", "scary", "suspense", "halloween", "angry", "funny", "cartoon", "meme",
  "children", "christmas", "birthday", "sleep", "lullaby", "comedy", "police-siren", "mystery"];
const AVOID_WORDS = /kill|dead|death|blood|war|dark|horror|ghost|zombie|murder|sad|cry|funeral|agent/i;

const manifestPath = join(OUT, "tracks.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
const seen = new Set(manifest.map((t) => t.id));

for (const [mood, tags] of Object.entries(MOODS)) {
  let got = manifest.filter((t) => t.mood === mood).length;
  for (const tag of tags) {
    if (got >= PER) break;
    const list = curl(`https://www.chosic.com/free-music/${tag}/?attribution=no`).toString("utf8");
    const ids = [...new Set([...list.matchAll(/download-audio\/(\d+)\//g)].map((m) => m[1]))];
    for (const id of ids) {
      if (got >= PER) break;
      if (seen.has(id)) continue;
      seen.add(id);
      await sleep(900);
      const page = curl(`https://www.chosic.com/download-audio/${id}/`).toString("utf8");
      const name = /<h1 class="download-track-name">([^<]*) by <a[^>]*>([^<]*)<\/a>/.exec(page);
      const file = /<button class="download" data-url="([^"]+\.mp3)" data-track-id="(\d+)"/.exec(page);
      const cc0 = /licenseLinkImg[\s\S]{0,200}publicdomain\/zero\/1\.0/.test(page);
      const main = page.slice(page.indexOf("main-track"), page.indexOf("track-download-wrap"));
      const trackTags = [...main.matchAll(/free-music\/([a-z-]+)\//g)].map((m) => m[1]);
      if (!name || !file || file[2] !== id || !cc0) continue;
      if (AVOID_WORDS.test(name[1]) || trackTags.some((t) => AVOID_TAGS.includes(t))) continue;
      const bytes = curl(file[1], `https://www.chosic.com/download-audio/${id}/`);
      if (bytes.length < 400_000 || bytes.length > 12_000_000) continue;
      const slug = `${name[1]}-${name[2]}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      mkdirSync(join(OUT, mood), { recursive: true });
      const rel = `${mood}/${slug}.mp3`;
      writeFileSync(join(OUT, rel), bytes);
      const seconds = Number(
        execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(OUT, rel)]).toString().trim(),
      );
      if (!(seconds >= 40 && seconds <= 360)) continue;
      manifest.push({
        id,
        mood,
        file: rel,
        title: name[1].trim(),
        artist: name[2].trim(),
        tags: [...new Set(trackTags)],
        seconds: Math.round(seconds),
        license: "CC0 1.0 (public domain, no attribution required)",
        source: `https://www.chosic.com/download-audio/${id}/`,
      });
      got++;
      console.log("kept", rel, Math.round(seconds), "s", trackTags.join(","));
    }
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("tracks:", manifest.length);
