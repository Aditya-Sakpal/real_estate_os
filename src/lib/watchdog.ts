/**
 * Reads the worker's job logs and emails what is wrong (`watchdog-rules.ts`
 * decides). Runs at the end of `lead:run` and `post:run`, so it deploys with
 * the code and needs nothing new on the machine; `npm run watchdog` runs it
 * alone. It never throws: a watchdog that can fail the job it rides on is
 * worse than none.
 *
 * The logs are `/var/log/salesdesk/<job>.log` (`WATCHDOG_LOG_DIR`). Where the
 * folder does not exist, a laptop or a Vercel function, it does nothing. Mail
 * goes to `ALERT_EMAIL`, else `MAIL_FROM`, which SES has verified, so it
 * arrives even while SES is in the sandbox.
 */
import { existsSync, openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  JOB_RULES, deployAlert, dueAlerts, jobAlert, lastDeploy, lastRun, pruneSent, type Alert,
} from "./watchdog-rules.ts";
import { redactPhones } from "./mask-rules.ts";
import { mailFrom, send } from "./mailer.ts";

const TAIL_BYTES = 96 * 1024;

function tail(path: string, bytes = TAIL_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export type WatchdogReport = { checked: number; alerts: string[]; sent: number; skipped?: string };

export async function runWatchdog(opts: {
  dir?: string;
  now?: string;
  mail?: (to: string, subject: string, text: string) => Promise<boolean>;
} = {}): Promise<WatchdogReport> {
  const dir = opts.dir ?? process.env.WATCHDOG_LOG_DIR ?? "/var/log/salesdesk";
  if (!existsSync(dir)) return { checked: 0, alerts: [], sent: 0, skipped: "no log folder" };
  const now = opts.now ?? new Date().toISOString();
  try {
    const found: { alert: Alert; log: string }[] = [];
    let checked = 0;
    for (const rule of JOB_RULES) {
      const path = join(dir, `${rule.job}.log`);
      if (!existsSync(path)) continue;
      checked++;
      const log = tail(path);
      const a = jobAlert(rule, lastRun(log), now);
      if (a) found.push({ alert: a, log });
    }
    const deployPath = join(dir, "deploy.log");
    if (existsSync(deployPath)) {
      checked++;
      const log = tail(deployPath);
      const a = deployAlert(lastDeploy(log));
      if (a) found.push({ alert: a, log });
    }

    const statePath = join(dir, ".watchdog.json");
    let sent: Record<string, string> = {};
    try { sent = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first run */ }
    const due = dueAlerts(found.map((f) => f.alert), sent, now);

    const to = process.env.ALERT_EMAIL?.trim() || mailFrom();
    const mail = opts.mail ?? (async (t: string, subject: string, text: string) =>
      (await send({ to: t, subject, text })).ok);
    let delivered = 0;
    for (const a of due) {
      if (!to) break;
      const log = found.find((f) => f.alert.key === a.key)!.log;
      const lines = redactPhones(log.split("\n").slice(-40).join("\n"), "MASKED");
      const ok = await mail(to, a.subject, `${a.text}\n\nThe last lines of its log:\n\n${lines}\n`);
      if (ok) { sent[a.key] = now; delivered++; }
    }
    try { writeFileSync(statePath, JSON.stringify(pruneSent(sent, now))); } catch { /* read-only folder */ }
    return { checked, alerts: found.map((f) => f.alert.key), sent: delivered };
  } catch (e) {
    return { checked: 0, alerts: [], sent: 0, skipped: `watchdog error: ${(e as Error).message}` };
  }
}
