/**
 * The worker's watchdog: reading a job's log and deciding what a person must
 * be told. Pure and database-free, covered by `check:logic`.
 *
 * Each job on the worker writes "<time> start <script>" and
 * "<time> end <script> exit <code>" around every run, and the deploy writes
 * "deploying <sha>", then "live: <sha>" or a line naming the failure. A job
 * that failed, stopped running on its timer, or never finished is the thing
 * nobody notices until a lead was not called, so each one is an alert. An
 * alert is sent once an hour per job and kind at most, and a job that is
 * switched off (no log at all) is never an alert.
 */

export type JobRule = {
  /** The job's name on the worker, as its log file is named. */
  job: string;
  /** Minutes after the last start with no newer start before it is late. */
  staleMinutes: number;
  /** Minutes a run may take before it is called stuck. */
  stuckMinutes: number;
};

export const JOB_RULES: readonly JobRule[] = [
  { job: "lead-run", staleMinutes: 20, stuckMinutes: 60 },
  { job: "call-watch", staleMinutes: 15, stuckMinutes: 15 },
  { job: "crm-run", staleMinutes: 20, stuckMinutes: 60 },
  { job: "extract-run", staleMinutes: 20, stuckMinutes: 60 },
  { job: "post-run", staleMinutes: 45, stuckMinutes: 90 },
  { job: "reel-run", staleMinutes: 150, stuckMinutes: 130 },
  { job: "billing-sweep", staleMinutes: 26 * 60, stuckMinutes: 180 },
  { job: "assets-sweep", staleMinutes: 8 * 24 * 60, stuckMinutes: 180 },
  { job: "rera-sweep", staleMinutes: 26 * 60, stuckMinutes: 180 },
];

/** One alert is sent per job and kind at most this often. */
export const ALERT_COOLDOWN_MINUTES = 60;

export type Run = { startedAt: string; endedAt: string | null; exit: number | null };

const START = /^(\S+)\s+start\s/;
const END = /^(\S+)\s+end\s+\S+\s+exit\s+(\d+)/;

/** The newest run a job's log records, or null when it records none. */
export function lastRun(log: string): Run | null {
  let run: Run | null = null;
  for (const line of log.split("\n")) {
    const s = line.match(START);
    if (s && !Number.isNaN(Date.parse(s[1]))) {
      run = { startedAt: s[1], endedAt: null, exit: null };
      continue;
    }
    const e = line.match(END);
    if (e && run && run.endedAt === null) {
      run.endedAt = e[1];
      run.exit = Number(e[2]);
    }
  }
  return run;
}

export type DeployState =
  | { state: "LIVE"; sha: string }
  | { state: "FAILED"; sha: string; reason: string }
  | { state: "DEPLOYING"; sha: string }
  | null;

/** What the newest deploy recorded in the deploy log came to. */
export function lastDeploy(log: string): DeployState {
  let out: DeployState = null;
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^deploying ([0-9a-f]{7,40})$/))) out = { state: "DEPLOYING", sha: m[1] };
    else if ((m = line.match(/^live: ([0-9a-f]{7,40})$/))) out = { state: "LIVE", sha: m[1] };
    else if ((m = line.match(/^npm ci failed for ([0-9a-f]{7,40})/))) out = { state: "FAILED", sha: m[1], reason: "installing packages failed" };
    else if ((m = line.match(/^migration failed for ([0-9a-f]{7,40})/))) out = { state: "FAILED", sha: m[1], reason: "a database migration failed; the old release stays live" };
  }
  return out;
}

export type Alert = { key: string; job: string; subject: string; text: string };

const minutes = (a: string, nowIso: string) => (Date.parse(nowIso) - Date.parse(a)) / 60_000;

/**
 * What is wrong with one job now. A failed last run, a run that has gone on
 * past its limit, and a job whose timer has stopped starting it are three
 * different faults, so each has its own key and its own cooldown.
 */
export function jobAlert(rule: JobRule, run: Run | null, nowIso: string): Alert | null {
  if (!run) return null;
  const { job } = rule;
  if (run.endedAt === null) {
    const m = minutes(run.startedAt, nowIso);
    if (m > rule.stuckMinutes) {
      return {
        key: `${job}:stuck`,
        job,
        subject: `Worker: ${job} has been running for ${Math.round(m)} minutes`,
        text: `${job} started at ${run.startedAt} and has not finished. Its limit is ${rule.stuckMinutes} minutes.`,
      };
    }
    return null;
  }
  if (run.exit !== 0) {
    return {
      key: `${job}:failed`,
      job,
      subject: `Worker: ${job} failed (exit ${run.exit})`,
      text: `${job} ended at ${run.endedAt} with exit code ${run.exit}.`,
    };
  }
  const m = minutes(run.startedAt, nowIso);
  if (m > rule.staleMinutes) {
    return {
      key: `${job}:stale`,
      job,
      subject: `Worker: ${job} has not run for ${Math.round(m)} minutes`,
      text: `${job} last started at ${run.startedAt}. It should start at least every ${rule.staleMinutes} minutes, so its timer may have stopped.`,
    };
  }
  return null;
}

/** A deploy that failed is an alert once per commit. */
export function deployAlert(d: DeployState): Alert | null {
  if (!d || d.state !== "FAILED") return null;
  return {
    key: `deploy:${d.sha}`,
    job: "deploy",
    subject: `Worker: deploying ${d.sha.slice(0, 7)} failed`,
    text: `The worker could not make ${d.sha} live: ${d.reason}. The previous release keeps running, and this commit is not tried again until main moves.`,
  };
}

/** Which alerts may be sent now, given when each key was last sent. */
export function dueAlerts(alerts: Alert[], sent: Record<string, string>, nowIso: string): Alert[] {
  return alerts.filter((a) => {
    const last = sent[a.key];
    if (!last) return true;
    if (a.key.startsWith("deploy:")) return false;
    return minutes(last, nowIso) >= ALERT_COOLDOWN_MINUTES;
  });
}

/** The keys a state file keeps: anything newer than a week. */
export function pruneSent(sent: Record<string, string>, nowIso: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sent)) if (minutes(v, nowIso) < 7 * 24 * 60) out[k] = v;
  return out;
}
