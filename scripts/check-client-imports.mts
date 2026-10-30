// Fails when a "use client" file reaches server-only code through its imports.
// Webpack (what Vercel builds with) refuses node:crypto, postgres and the like
// in a client bundle, and reports only the first one it meets, after minutes
// of building. Turbopack, which the dev server uses, lets them through. This
// walks every client file's import graph in a second and names every path.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SERVER = new Set([
  "postgres", "fs", "path", "crypto", "child_process", "sharp", "os", "zlib",
  "net", "tls", "http", "https", "stream", "util", "worker_threads",
  "server-only", "next/headers", "drizzle-orm", "tesseract.js", "jsqr",
  "@remotion/renderer", "@remotion/bundler", "@napi-rs/canvas",
  "@node-saml/node-saml", "@techstark/opencv-js", "pdfjs-dist", "redis",
  "ioredis", "@aws-sdk/client-s3", "@aws-sdk/client-sesv2",
  "@aws-sdk/credential-providers", "@aws-sdk/s3-request-presigner",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?\sfrom\s+)?["']([^"']+)["']/g;

function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT)) {
    if (m[2]) continue; // import type
    const clause = m[3] ?? "";
    const named = clause.match(/^\s*\{([^}]*)\}\s*from\s*$/);
    if (named && named[1].split(",").every((x) => !x.trim() || x.trim().startsWith("type "))) continue;
    out.push(m[4]);
  }
  return out;
}

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
  else return null;
  const bare = base.replace(/\.(ts|js)$/, "");
  for (const c of [base, `${bare}.ts`, `${bare}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const pkg = (spec: string) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

const files = walk(join(ROOT, "src"));
const clients = files.filter((f) => /^\s*(\/\/[^\n]*\n\s*)*["']use client["']/.test(readFileSync(f, "utf8")));
const problems = new Map<string, string[]>();

for (const client of clients) {
  const seen = new Set<string>();
  const stack: [string, string[]][] = [[client, [client]]];
  while (stack.length) {
    const [f, path] = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    // A server action module crosses to the server by reference, not by bundle.
    if (f !== client && /^\s*["']use server["']/.test(readFileSync(f, "utf8"))) continue;
    for (const spec of imports(f)) {
      const r = resolve(f, spec);
      if (r) { stack.push([r, [...path, r]]); continue; }
      if (spec.startsWith("node:") || SERVER.has(pkg(spec))) {
        const key = `${f} -> ${spec}`;
        if (!problems.has(key)) problems.set(key, [...path, spec]);
      }
    }
  }
}

if (problems.size === 0) {
  console.log(`${clients.length} client files checked, none reaches server-only code`);
} else {
  for (const path of problems.values()) {
    console.log(`  FAIL  ${path.map((p) => p.replace(ROOT, "")).join("\n        > ")}\n`);
  }
  console.log(`${problems.size} client import path(s) reach server-only code`);
  process.exit(1);
}
