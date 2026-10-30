// Lets a script import library code the way the app's bundler resolves it:
// "next/headers" by bare name (Node needs next/headers.js), and the "@/..."
// alias for src/. Used by scripts that call a sign-up function directly:
//   node --import ./scripts/lib/next-resolve.mjs ...
import { register } from "node:module";

// Use .href, not pathname + pathToFileURL: on Windows pathname is "/C:/...",
// and pathToFileURL turns that into "file:///C:/C:/...".
const SRC = new URL("../../src/", import.meta.url).href;
register("data:text/javascript," + encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SRC = ${JSON.stringify(SRC)};
export async function resolve(spec, ctx, next) {
  if (/^next\\/[a-z-]+$/.test(spec)) return next(spec + ".js", ctx);
  if (spec.startsWith("@/")) {
    const base = SRC + spec.slice(2);
    for (const c of [base, base + ".ts", base + ".tsx", base + "/index.ts"]) {
      if (existsSync(fileURLToPath(c)) && !c.endsWith("/") ) {
        try { return await next(c, ctx); } catch {}
      }
    }
  }
  return next(spec, ctx);
}`));
