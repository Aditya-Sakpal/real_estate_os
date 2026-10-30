// Say a finished film's wrong words again in the presenter's own voice, by hand.
//
//   npm run respeak -- <film.mp4> <out.mp4> --post <rendered post id>
//   npm run respeak -- <film.mp4> <out.mp4> --lines <lines.json>
//
// The same code a new film goes through in the worker (src/lib/respeak.ts),
// for a film made before it existed or one somebody wants to hear fixed. The
// lines are the film's script, read from the post on the owner's connection
// the way the other operator scripts read across tenants, or given as a JSON
// array of strings. Prints what was said again and what was not.
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { respeakFilm } from "../src/lib/respeak.ts";
import { respeakNotes } from "../src/lib/respeak-rules.ts";

const [film, out, flag, value] = process.argv.slice(2);
if (!film || !out || !flag || !value) {
  console.error("usage: npm run respeak -- <film.mp4> <out.mp4> (--post <id> | --lines <lines.json>)");
  process.exit(2);
}

let lines: string[];
if (flag === "--post") {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const [row] = await sql<{ scenes: { line: string }[] | null }[]>`
    SELECT inputs->'film'->'script'->'scenes' AS scenes FROM rendered_posts WHERE id::text = ${value}`;
  await sql.end();
  if (!row?.scenes) {
    console.error("No film with a script by that id.");
    process.exit(1);
  }
  lines = row.scenes.map((s) => s.line);
} else {
  lines = JSON.parse(await readFile(value, "utf8")) as string[];
}
lines = lines.filter(Boolean);

const dir = await mkdtemp(join(tmpdir(), "salesdesk-respeak-"));
try {
  const r = await respeakFilm({ raw: film, dir, lines });
  if (!r.ok) {
    console.error(`Not fixed: ${r.message}`);
    if (r.report) console.log(JSON.stringify(r.report, null, 1));
    process.exit(1);
  }
  for (const n of respeakNotes(r.report)) console.log(n);
  console.log(`clone said ${r.report.chars} characters in ${r.report.takes} takes; ${Math.round(r.report.heardSeconds)} s transcribed`);
  if (r.film) {
    await copyFile(r.film, out);
    console.log(`wrote ${out}`);
  } else {
    console.log("Nothing needed fixing; no file written.");
  }
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
