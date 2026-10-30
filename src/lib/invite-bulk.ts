import { withTenant, audit } from "@/lib/db";
import { createInvite } from "@/lib/invite";
import { personalAccountsAllowed } from "@/lib/work-account";
import {
  planImport,
  type CsvNode,
  type CsvRole,
  type ImportPlan,
  type PlannedRow,
} from "@/lib/csv-rules";
import { inviteMail, mailerConfigured, send } from "@/lib/mailer";

/**
 * Importing a list of people.
 *
 * Every row goes through `createInvite`, the same function a single invite
 * uses, rather than through a faster bulk INSERT. That is the whole design.
 * A second write path would be a second place for the three gates to drift
 * apart, and the one that drifts is always the one nobody looks at. Sixty
 * round trips is a cost worth paying for there being exactly one way an
 * invite is ever written.
 *
 * The plan is recomputed here from the submitted text. What the browser
 * showed was a preview; it has no authority, and a row that was READY on
 * screen can still be refused if the tenant changed underneath it.
 */

export type ImportedRow = {
  line: number;
  email: string;
  roleLabel: string | null;
  /** Where the membership landed. Null on a row that was never written. */
  scopeName: string | null;
  /** WRITTEN, SKIPPED or REFUSED. What actually happened, not what was planned. */
  outcome: "WRITTEN" | "SKIPPED" | "REFUSED";
  reason: string;
  mailed: boolean;
};

export type ImportResult = {
  /** Set when the file was unusable, in which case nothing was attempted. */
  fatal: string | null;
  rows: ImportedRow[];
  written: number;
  skipped: number;
  refused: number;
  mailed: number;
  mailFailed: number;
  /** Ties every row's audit entry to the one act that produced them. */
  batchId: string | null;
};

/** How many sends are in flight at once. Polite to SES, and to the console. */
const MAIL_CONCURRENCY = 4;

/**
 * Who is already spoken for, and where, so the plan can mark them before
 * writing. The node matters: an address on the team at the organisation is
 * not on the team at Tower C, and skipping that row would drop the grant the
 * file was written to make.
 */
type Held = { email: string; scopeId: string };

async function existingMemberships(orgId: string): Promise<{
  active: Held[];
  invited: Held[];
}> {
  return withTenant(orgId, async (sql) => {
    const rows = await sql<{ email: string; status: string; scope_node_id: string }[]>`
      SELECT u.email::text AS email, m.status, m.scope_node_id
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${orgId} AND m.status IN ('ACTIVE', 'INVITED')
        AND u.email IS NOT NULL
    `;
    const held = (status: string) =>
      rows
        .filter((r) => r.status === status)
        .map((r) => ({ email: r.email.toLowerCase(), scopeId: r.scope_node_id }));
    return { active: held("ACTIVE"), invited: held("INVITED") };
  });
}

/**
 * Build the plan against live tenant state.
 *
 * Exported so the preview and the commit are literally the same call, and so
 * a check can assert that what the screen promised is what the server does.
 */
export async function planFor(opts: {
  orgId: string;
  text: string;
  grantable: readonly CsvRole[];
  defaultRoleKey: string;
  orgPrimaryDomain: string | null;
  nodes?: readonly CsvNode[];
  defaultScopeId?: string;
  allRoles?: readonly CsvRole[];
  allNodes?: readonly CsvNode[];
}): Promise<ImportPlan> {
  const existing = await existingMemberships(opts.orgId);
  return planImport({
    text: opts.text,
    grantable: opts.grantable,
    defaultRoleKey: opts.defaultRoleKey,
    orgPrimaryDomain: opts.orgPrimaryDomain,
    personalAdmin: personalAccountsAllowed(),
    nodes: opts.nodes,
    defaultScopeId: opts.defaultScopeId,
    existingActive: existing.active,
    existingInvited: existing.invited,
    allRoles: opts.allRoles,
    allNodes: opts.allNodes,
  });
}

export async function importInvites(opts: {
  orgId: string;
  orgName: string;
  orgPrimaryDomain: string | null;
  actorUserId: string;
  actorName: string | null;
  inviterScopes: readonly string[];
  inviterHeldAt: (path: string) => ReadonlySet<string>;
  grantable: readonly CsvRole[];
  allRoles?: readonly CsvRole[];
  nodes?: readonly CsvNode[];
  allNodes?: readonly CsvNode[];
  defaultScopeId?: string;
  defaultRoleKey: string;
  signInUrl: string;
  text: string;
}): Promise<ImportResult> {
  const plan = await planFor({
    orgId: opts.orgId,
    text: opts.text,
    grantable: opts.grantable,
    defaultRoleKey: opts.defaultRoleKey,
    orgPrimaryDomain: opts.orgPrimaryDomain,
    nodes: opts.nodes,
    defaultScopeId: opts.defaultScopeId,
    allRoles: opts.allRoles,
    allNodes: opts.allNodes,
  });

  const nothing: ImportResult = {
    fatal: plan.fatal,
    rows: [],
    written: 0,
    skipped: 0,
    refused: 0,
    mailed: 0,
    mailFailed: 0,
    batchId: null,
  };
  if (plan.fatal) return nothing;

  const batchId = crypto.randomUUID();
  const rows: ImportedRow[] = [];
  const toMail: { email: string; message: string }[] = [];

  for (const row of plan.rows) {
    if (row.verdict !== "READY") {
      rows.push({
        line: row.line,
        email: row.email,
        roleLabel: row.roleLabel,
        scopeName: row.scopeName,
        outcome: row.verdict === "SKIP" ? "SKIPPED" : "REFUSED",
        reason: row.reason,
        mailed: false,
      });
      continue;
    }

    const written = await writeOne(opts, row, batchId);
    rows.push(written.row);
    if (written.mail) toMail.push(written.mail);
  }

  // Mail after every write, not between them. A slow or failing mailer must
  // not decide how much of the file got imported.
  const sent = await sendAll(toMail, opts.orgName);
  for (const r of rows) if (sent.ok.has(r.email)) r.mailed = true;

  const result: ImportResult = {
    fatal: null,
    rows,
    written: rows.filter((r) => r.outcome === "WRITTEN").length,
    skipped: rows.filter((r) => r.outcome === "SKIPPED").length,
    refused: rows.filter((r) => r.outcome === "REFUSED").length,
    mailed: sent.ok.size,
    mailFailed: sent.failed,
    batchId,
  };

  // One entry for the act itself. The per-person entries `createInvite` wrote
  // carry the same batch id, so the whole import reads back as one thing that
  // somebody did on a date, which is what a dispute will ask for.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "membership.imported",
    targetType: "batch",
    targetId: batchId,
    metadata: {
      written: result.written,
      skipped: result.skipped,
      refused: result.refused,
      mailed: result.mailed,
      mail_failed: result.mailFailed,
      rows: plan.rows.length,
    },
  });

  return result;
}

async function writeOne(
  opts: Parameters<typeof importInvites>[0],
  row: PlannedRow,
  batchId: string,
): Promise<{ row: ImportedRow; mail: { email: string; message: string } | null }> {
  const outcome = await createInvite({
    orgId: opts.orgId,
    orgName: opts.orgName,
    orgPrimaryDomain: opts.orgPrimaryDomain,
    actorUserId: opts.actorUserId,
    actorName: opts.actorName,
    inviterScopes: opts.inviterScopes,
    inviterHeldAt: opts.inviterHeldAt,
    email: row.email,
    roleKey: row.roleKey!,
    scopeNodeId: row.scopeId,
    signInUrl: opts.signInUrl,
  });

  if (!outcome.ok) {
    return {
      row: {
        line: row.line,
        email: row.email,
        roleLabel: row.roleLabel,
        scopeName: row.scopeName,
        // ALREADY_MEMBER is not a failure. Somebody joined between the preview
        // and the commit, and the file asking for what is already true is the
        // most ordinary thing in an import.
        outcome: outcome.code === "ALREADY_MEMBER" ? "SKIPPED" : "REFUSED",
        reason: outcome.message,
        mailed: false,
      },
      mail: null,
    };
  }

  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "membership.invited",
    targetType: "domain",
    targetId: row.email.slice(row.email.lastIndexOf("@") + 1),
    metadata: {
      role: row.roleKey,
      via: "import",
      batch_id: batchId,
      line: row.line,
      scope: outcome.scopePath,
    },
  });

  return {
    row: {
      line: row.line,
      email: row.email,
      roleLabel: outcome.roleLabel,
      scopeName: outcome.scopeName,
      outcome: "WRITTEN",
      reason: outcome.reinvited ? "Already invited. Role updated." : "",
      mailed: false,
    },
    mail: { email: outcome.email, message: outcome.message },
  };
}

async function sendAll(
  queue: readonly { email: string; message: string }[],
  orgName: string,
): Promise<{ ok: Set<string>; failed: number }> {
  const ok = new Set<string>();
  let failed = 0;

  if (!mailerConfigured() || queue.length === 0) {
    // Not an error. The memberships are written either way, and mail is a
    // notification about them rather than the thing itself.
    return { ok, failed: 0 };
  }

  for (let i = 0; i < queue.length; i += MAIL_CONCURRENCY) {
    const slice = queue.slice(i, i + MAIL_CONCURRENCY);
    const results = await Promise.all(
      slice.map((m) =>
        send(inviteMail({ to: m.email, orgName, body: m.message })).then(
          (r) => ({ email: m.email, r }),
          () => ({ email: m.email, r: { ok: false as const, code: "THREW", detail: "" } }),
        ),
      ),
    );
    for (const { email, r } of results) {
      if (r.ok) ok.add(email);
      else failed += 1;
    }
  }

  return { ok, failed };
}
