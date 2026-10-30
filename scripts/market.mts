// Sales Desk's market library: public ads from India's large developers,
// read by our team and shared, read-only, with every tenant's learning.
//
//   npm run market -- list [--city Pune]
//   npm run market -- add <picture-or-video> --developer "Lodha" --city Mumbai
//        [--project "Lodha Amara"] [--locality "Thane West"] [--platform META]
//        [--since 2026-08-01] [--carousel] [--price 7500000]
//   npm run market -- remove <id>
//
// Written on the owner's connection, because the app role holds SELECT and
// nothing else on `market_ads`: a tenant that could write it could steer
// every other tenant's creative. Each add is one paid read (about Rs 0.55
// for a picture, Rs 1.80 for a video), our own cost and nobody's plan.
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { readAd } from "../src/lib/competitor.ts";
import { fileProblem, readForm, type AdKind } from "../src/lib/competitor-rules.ts";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] ?? "" : null;
};
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

try {
  if (cmd === "list") {
    const city = flag("city");
    const rows = await sql<{ id: string; developer: string; city: string | null; kind: string; tags: Record<string, string>; flags: string[]; seen_on: Date }[]>`
      SELECT id, developer, city, kind, tags, flags, seen_on FROM market_ads
      WHERE ${city ? sql`lower(city) = lower(${city})` : sql`true`} ORDER BY seen_on DESC LIMIT 200`;
    for (const r of rows) {
      console.log(`${r.id}  ${r.seen_on.toISOString().slice(0, 10)}  ${r.developer.padEnd(20)} ${(r.city ?? "").padEnd(10)} ${r.kind.padEnd(8)} ${r.tags.angle ?? ""}${r.flags.length ? "  FLAGGED" : ""}`);
    }
    console.log(`\n${rows.length} ads`);
  } else if (cmd === "add") {
    const path = rest[0];
    if (!path) throw new Error("Name the picture or video to add.");
    const type = TYPES[extname(path).toLowerCase()];
    if (!type) throw new Error("A PNG, JPEG, WebP, MP4, MOV or WebM file.");
    const bytes = await readFile(path);
    const bad = fileProblem({ type, size: bytes.length });
    if (bad) throw new Error(bad);
    const form = readForm({
      competitor: flag("developer") ?? "",
      projectName: flag("project") ?? "",
      locality: flag("locality") ?? "",
      platform: flag("platform") ?? "META",
      runningSince: flag("since") ?? "",
      today: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    });
    if (!form.ok) throw new Error(form.message);
    const kind: AdKind = type.startsWith("video/") ? "VIDEO" : rest.includes("--carousel") ? "CAROUSEL" : "IMAGE";
    const read = await readAd({ bytes, type }, kind);
    if (!read.ok) throw new Error(read.message);
    const tags = read.reading.tags;
    const price = flag("price") ? Number(flag("price")) : tags.priceFrom ?? null;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO market_ads (developer, project_name, city, locality, price_from, platform, kind, running_since,
                              poster, poster_type, text_seen, tags, flags)
      VALUES (${form.value.competitor}, ${form.value.projectName}, ${flag("city")}, ${form.value.locality ?? tags.locality ?? null},
              ${price && price > 0 ? Math.round(price) : null}, ${form.value.platform}, ${kind}, ${form.value.runningSince},
              ${read.poster}, 'image/jpeg', ${read.reading.textSeen || null}, ${sql.json(tags as never)}, ${read.reading.flags})
      RETURNING id`;
    console.log(`added ${row.id}: ${tags.angle}, ${kind}${read.reading.flags.length ? ", FLAGGED" : ""}`);
  } else if (cmd === "remove") {
    const r = await sql`DELETE FROM market_ads WHERE id = ${rest[0] ?? ""}`;
    console.log(r.count ? "removed" : "no such ad");
  } else {
    console.log("npm run market -- list | add <file> --developer <name> --city <city> [...] | remove <id>");
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await sql.end();
}
