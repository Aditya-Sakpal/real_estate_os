// The story reel worker. With --org and --job it makes that one reel (the
// studio starts it this way locally); with neither it makes whatever reels
// are due, a bounded number, and exits, so it can sit behind a cron entry.
//
//   node --experimental-strip-types --env-file=.env.local scripts/reel-run.mts [--org <id> --job <id>]

// The studio starts this worker detached, with no console of its own, so on
// Windows every FFmpeg, FFprobe and Python it starts got a console window of
// its own: a film's run left 163 Terminal tabs open on 7 October 2026. Every
// child is hidden, before anything below imports child_process.
if (process.platform === "win32") {
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const { promisify } = await import("node:util");
  const cp = createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;
  // Where each function takes its options: after an argument array when there is one.
  const hide = (args: unknown[], optAt: (a: unknown[]) => number) => {
    const at = optAt(args);
    const o = args[at];
    if (o && typeof o === "object" && !Array.isArray(o)) args[at] = { windowsHide: true, ...(o as object) };
    // An options argument passed as undefined is replaced, never pushed along:
    // pushed, it took the callback's place, and a film's first FFprobe waited
    // for ever (8 October 2026).
    else if (at < args.length && (o === undefined || o === null)) args[at] = { windowsHide: true };
    else args.splice(at, 0, { windowsHide: true });
    return args;
  };
  const afterArgs = (a: unknown[]) => (Array.isArray(a[1]) ? 2 : 1);
  const second = () => 1;
  for (const [name, at] of [["spawn", afterArgs], ["spawnSync", afterArgs], ["execFile", afterArgs], ["execFileSync", afterArgs], ["exec", second], ["execSync", second]] as const) {
    const orig = cp[name] as ((...a: unknown[]) => unknown) & { [k: symbol]: unknown };
    const wrapped = ((...a: unknown[]) => orig(...hide(a, at))) as typeof orig;
    const custom = orig[promisify.custom] as ((...a: unknown[]) => unknown) | undefined;
    if (custom) Object.defineProperty(wrapped, promisify.custom, { value: (...a: unknown[]) => custom(...hide(a, at)) });
    cp[name] = wrapped;
  }
  syncBuiltinESMExports();
}

const { runReelJob, runReels } = await import("../src/lib/reel-jobs.ts");
const { closeDb } = await import("../src/lib/db/index.ts");

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

// Stopping a reel aborts its downloads, and Node's fetch can then throw
// "ReadableStream is already closed" from inside itself, where nothing can
// catch it. It killed a worker mid-reel on 25 September 2026. That one is
// harmless and is logged; anything else still ends the process.
process.on("uncaughtException", (e: Error & { code?: string }) => {
  if (e.code === "ERR_INVALID_STATE") {
    console.error("reel: ignored a closed stream after an abort", e.message);
    return;
  }
  console.error("reel: worker crashed", e);
  process.exit(1);
});

const org = arg("org");
const job = arg("job");
const started = Date.now();
if (org && job) {
  const r = await runReelJob(org, job);
  console.log(new Date().toISOString(), "reel", job, r.ok ? "made" : r.message, `${Math.round((Date.now() - started) / 1000)}s`);
} else {
  // Which tenants exist is read here, in the worker script, on the owner's
  // connection the way the checks read it; the library never reads across
  // tenants.
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const orgs = await sql<{ id: string }[]>`SELECT id FROM orgs WHERE status <> 'SUSPENDED' ORDER BY created_at`;
  await sql.end();
  const made = await runReels({ orgIds: orgs.map((o) => o.id) });
  console.log(new Date().toISOString(), "reels made:", made);
}
await closeDb();
process.exit(0);
