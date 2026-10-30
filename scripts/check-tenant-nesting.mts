// Fails when a tenant transaction waits on a second one.
//
// `withTenant()` holds a pooled connection for its whole callback. A callback
// that calls something which opens its own transaction (directly or further
// down) waits for a second connection while holding the first; a few requests
// doing it at once take every slot, each waits on the others, and the server
// stops answering every page until it is restarted. On 4 October 2026
// `loadUnits()` reading the Brain inside its transaction did exactly that.
//
// This follows each function's own imports, so a name is matched to the
// function it really is. A call handing on its transaction (`sql` or `tx` as
// an argument, or `{ sql }`) stays on the same connection and is allowed.
import ts from "typescript";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, normalize } from "node:path";
const BASE = new Set(["withTenant", "withTenantReadOnly", "withPerson", "withNoTenant"]);
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(normalize(resolve(p))); } };
walk(join(ROOT, "src"));
const src = new Map<string, ts.SourceFile>();
for (const f of files) src.set(f, ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true));
const res = (from: string, spec: string) => {
  let p = spec.startsWith("@/") ? resolve(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!p) return null;
  for (const c of [p, p + ".ts", p + ".tsx", join(p, "index.ts")]) if (existsSync(c) && statSync(c).isFile()) return normalize(c);
  return null;
};
// per file: local fn name -> body ; imported name -> [file, original]
const local = new Map<string, Map<string, ts.Node>>();
const imports = new Map<string, Map<string, [string, string]>>();
for (const [f, sf] of src) {
  const L = new Map<string, ts.Node>(); const I = new Map<string, [string, string]>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const target = res(f, st.moduleSpecifier.text); const nb = st.importClause?.namedBindings;
      if (target && nb && ts.isNamedImports(nb)) for (const e of nb.elements) I.set(e.name.text, [target, (e.propertyName ?? e.name).text]);
    }
  }
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) L.set(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      let i: ts.Node = n.initializer;
      if (ts.isCallExpression(i) && i.arguments[0] && (ts.isArrowFunction(i.arguments[0]) || ts.isFunctionExpression(i.arguments[0]))) i = i.arguments[0];
      if (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) L.set(n.name.text, i.body);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf); local.set(f, L); imports.set(f, I);
}
const calls = (n: ts.Node) => { const o: ts.CallExpression[] = []; const v = (x: ts.Node) => { if (ts.isCallExpression(x)) o.push(x); ts.forEachChild(x, v); }; v(n); return o; };
const passesSql = (c: ts.CallExpression) => c.arguments.some((a) => (ts.isIdentifier(a) && /^(sql|tx)$/.test(a.text)) || (ts.isObjectLiteralExpression(a) && a.properties.some((p) => p.name && ts.isIdentifier(p.name) && /^(sql|tx)$/.test(p.name.text))));
const key = (f: string, n: string) => f + "#" + n;
const target = (f: string, name: string): string | null => {
  if (BASE.has(name)) return "BASE";
  if (local.get(f)!.has(name)) return key(f, name);
  const im = imports.get(f)!.get(name); return im ? key(im[0], im[1]) : null;
};
const opener = new Set<string>();
const isOpen = (f: string, c: ts.CallExpression) => {
  if (!ts.isIdentifier(c.expression) || passesSql(c)) return false;
  const t = target(f, c.expression.text); return t === "BASE" || (t !== null && opener.has(t));
};
for (let ch = true; ch;) { ch = false; for (const [f, L] of local) for (const [n, b] of L) { const k = key(f, n); if (!opener.has(k) && calls(b).some((c) => isOpen(f, c))) { opener.add(k); ch = true; } } }
const found: string[] = [];
for (const [f, sf] of src) for (const c of calls(sf)) {
  if (!ts.isIdentifier(c.expression) || !BASE.has(c.expression.text)) continue;
  for (const a of c.arguments) if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) for (const ic of calls(a)) if (isOpen(f, ic)) {
    found.push(`${f.replace(normalize(ROOT), "")}:${sf.getLineAndCharacterOfPosition(ic.getStart()).line + 1}  ${(ic.expression as ts.Identifier).text}() inside ${c.expression.text}`);
  }
}
if (found.length) {
  console.error(`A tenant transaction waits on a second one (${found.length}). Read it beside the transaction, or pass its sql on:`);
  for (const l of found) console.error(`  ${l}`);
  process.exit(1);
}
console.log(`check:tenant-nesting: ${src.size} files, no transaction waits on another.`);
