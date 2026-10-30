/**
 * Reading a list of people out of a spreadsheet.
 *
 * Sixty field staff are not invited one at a time, and the file they arrive in
 * was made by a person in Excel, not by an exporter. So this is deliberately
 * forgiving about shape and deliberately strict about outcome: it will find
 * the columns whatever they are called, and it will refuse a row rather than
 * guess what was meant.
 *
 * Every row ends in one of three states and there is no fourth. READY will be
 * written, SKIP is already true (they are on the team), ERROR is refused with
 * a reason naming the line. Nothing is partially imported without the person
 * running it having seen exactly that breakdown first.
 *
 * Database-free on purpose, so `npm run check:logic` exercises it directly and
 * so the console can show the same verdict as it types, from the same code
 * that will decide it on the server. The browser's copy is a convenience; the
 * server re-runs this and is the authority.
 */

import { checkAddress, looksLikeEmail, normaliseEmail } from "./invite-rules.ts";
import {
  depthRefusal,
  kindWord,
  nodesNamed,
  roleFitsScope,
  type ScopeNode,
} from "./scope-rules.ts";
import { FOUNDING_ROLE, type ScopeKind } from "./roles.ts";

/**
 * One batch, one sitting. A file larger than this is a migration rather than
 * an invite list, and it should not arrive through a text box that holds the
 * whole thing in a form field.
 */
export const MAX_ROWS = 500;

export type CsvRole = {
  key: string;
  label: string;
  minKind: ScopeKind;
  /**
   * Where this inviter may give the role, from `reachFor`: deep enough, and
   * where they hold everything it does. Absent means depth is the only rule.
   */
  at?: readonly string[];
};

/** The nodes a row may name, which are the ones the inviter can reach. */
export type CsvNode = ScopeNode;

export type RowVerdict = "READY" | "SKIP" | "ERROR";

export type PlannedRow = {
  /** 1-based line in the file as pasted, so an error can be pointed at. */
  line: number;
  email: string;
  name: string | null;
  roleKey: string | null;
  roleLabel: string | null;
  /** Where this membership will land. Null on a row that never got that far. */
  scopeId: string | null;
  scopeName: string | null;
  verdict: RowVerdict;
  /** Why it is SKIP or ERROR. Empty for READY. */
  reason: string;
  /** Shown for a READY row that is worth a second look. */
  warning: string | null;
};

export type ImportPlan = {
  rows: PlannedRow[];
  ready: number;
  skipped: number;
  errored: number;
  /** Set when the file itself is unusable, in which case `rows` is empty. */
  fatal: string | null;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * A small CSV reader: quoted fields, doubled quotes inside them, commas and
 * newlines within quotes, CRLF, and a BOM.
 *
 * Not a general parser, and it does not need to be. It reads what Excel's
 * "CSV UTF-8" writes and what a person pastes out of a mail client, which is
 * the whole input set.
 */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (c === "," || c === ";" || c === "\t") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // Swallow the second half of a CRLF rather than emitting a blank row.
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  row.push(field);
  rows.push(row);

  // A trailing newline is not a person.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const EMAIL_HEADERS = ["email", "email address", "e-mail", "mail", "email id"];
const ROLE_HEADERS = ["role", "role key", "designation", "title", "access"];
const NAME_HEADERS = ["name", "full name", "person"];
// A sales head writing this file thinks in towers and cities, not in "scope
// nodes", so the words they would actually type are all accepted.
const SCOPE_HEADERS = [
  "scope",
  "node",
  "where",
  "path",
  "scope path",
  "project",
  "phase",
  "tower",
  "site",
];

function headerIndex(cells: string[], names: readonly string[]): number {
  return cells.findIndex((c) => names.includes(c.trim().toLowerCase()));
}

/**
 * Work out which column is which.
 *
 * A header row is detected rather than required, because half the files that
 * arrive are three columns with no header and half are exports with eight
 * columns in an order nobody chose. If there is no header, the column holding
 * something shaped like an email address is the email column.
 */
export function readColumns(rows: string[][]): {
  header: boolean;
  email: number;
  role: number;
  name: number;
  scope: number;
} {
  const first = rows[0] ?? [];
  const e = headerIndex(first, EMAIL_HEADERS);

  if (e >= 0) {
    return {
      header: true,
      email: e,
      role: headerIndex(first, ROLE_HEADERS),
      name: headerIndex(first, NAME_HEADERS),
      scope: headerIndex(first, SCOPE_HEADERS),
    };
  }

  // No header. Find the email by shape, and take a neighbouring column as the
  // role only if something in it names a role, which the caller decides. A
  // file with no header names no place either: guessing which of two unlabelled
  // columns is the tower would put people on the wrong one.
  const byShape = first.findIndex((c) => looksLikeEmail(c.trim()));
  return {
    header: false,
    email: byShape >= 0 ? byShape : 0,
    role: -1,
    name: -1,
    scope: -1,
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Match a role by key or by the label a person would type into a cell. */
export function matchRole(raw: string, roles: readonly CsvRole[]): CsvRole | null {
  const v = raw.trim();
  if (!v) return null;
  const upper = v.toUpperCase().replace(/[\s-]+/g, "_");
  const lower = v.toLowerCase().replace(/\s+/g, " ");
  return (
    roles.find((r) => r.key.toUpperCase() === upper) ??
    roles.find((r) => r.label.toLowerCase() === lower) ??
    null
  );
}

/** A cell a spreadsheet would read as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** The node directly above this one, when it is in the list. */
export function parentOf(node: CsvNode, pool: readonly CsvNode[]): CsvNode | null {
  const cut = node.path.lastIndexOf(".");
  if (cut < 0) return null;
  const up = node.path.slice(0, cut);
  return pool.find((n) => n.path === up) ?? null;
}

/**
 * Every node a cell could mean, with the names above it allowed in front.
 *
 * `nodesNamed` reads one name. Told that "Phase 1" names two towers, a person
 * writes "Trees / Phase 1" or "Trees, Phase 1", so a cell may carry the names
 * above the node too, outermost first, split on a slash, a comma or a ">".
 * Each earlier name has to be an ancestor of whatever the last one names, in
 * that order. Still every match and never a guess: two projects called Trees,
 * each with a Phase 1, is two answers.
 *
 * `pool` is where ancestors are looked up, because an inviter who may only
 * reach one project can still name the project it sits in.
 */
export function placesNamed(
  raw: string,
  nodes: readonly CsvNode[],
  pool: readonly CsvNode[] = nodes,
): CsvNode[] {
  const whole = nodesNamed(raw, nodes);
  if (whole.length) return whole;

  const parts = raw
    .split(/[/,>]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return [];

  const above = parts.slice(0, -1);
  const everyone = [...pool, ...nodes.filter((n) => !pool.some((p) => p.id === n.id))];

  return nodesNamed(parts[parts.length - 1], nodes).filter((n) => {
    // Its ancestors, the root first.
    const chain = everyone
      .filter((a) => n.path.startsWith(`${a.path}.`))
      .sort((a, b) => a.path.length - b.path.length);
    let from = 0;
    for (const name of above) {
      const i = chain.findIndex((a, at) => at >= from && nodesNamed(name, [a]).length === 1);
      if (i < 0) return false;
      from = i + 1;
    }
    return true;
  });
}

/**
 * How to write a node in a cell so it names that node and nothing else: its
 * name, or its parent's name in front when the name alone is shared.
 */
export function placeCell(node: CsvNode, nodes: readonly CsvNode[], pool: readonly CsvNode[] = nodes): string {
  if (placesNamed(node.name, nodes, pool).length === 1) return node.name;
  const parent = parentOf(node, pool);
  if (parent) {
    const both = `${parent.name} / ${node.name}`;
    if (placesNamed(both, nodes, pool).length === 1) return both;
  }
  return node.path;
}

/**
 * Turn a pasted file into a decision per row.
 *
 * `grantable` is what this inviter may actually hand out, already filtered by
 * the caller (`reachFor`) for whether they hold everything each role does
 * somewhere deep enough to carry it. `nodes` is where they may land somebody, already filtered for
 * containment. So a role or a place the file names but the inviter cannot
 * reach is simply not found here. `existingActive` and `existingInvited` come
 * from the tenant.
 *
 * Role and place are decided together, because neither is valid on its own:
 * Site Team is fine on a phase and meaningless on a region, and the row names
 * both.
 */
export function planImport(opts: {
  text: string;
  grantable: readonly CsvRole[];
  defaultRoleKey: string;
  orgPrimaryDomain: string | null;
  /** A personal mailbox may be made an admin (development only). */
  personalAdmin?: boolean;
  /** The nodes this inviter may grant at. Empty means the root only. */
  nodes?: readonly CsvNode[];
  /** The node a row with no place of its own lands at. */
  defaultScopeId?: string;
  /**
   * Who already holds a live membership, and WHERE.
   *
   * The place is half the answer now. Somebody on the team at the
   * organisation may still be given Site Team on Tower C, so an address alone
   * would skip the row that was the whole point of the file.
   */
  existingActive?: readonly { email: string; scopeId: string }[];
  /** Same, for invites not yet claimed. Re-inviting changes their role. */
  existingInvited?: readonly { email: string; scopeId: string }[];
  /**
   * Every role this tenant has, including ones not grantable here.
   *
   * Only used to tell two refusals apart. A file naming a role that does not
   * exist is a typo; a file naming Pre-sales Manager when there is no region
   * in reach is somebody who read the role list. The second deserves a better
   * sentence than "no such role".
   */
  allRoles?: readonly CsvRole[];
  /** Every node in the tenant, for the same reason `allRoles` exists. */
  allNodes?: readonly CsvNode[];
}): ImportPlan {
  const at = (e: string, scopeId: string) => `${e.toLowerCase()} @ ${scopeId}`;
  const active = new Set((opts.existingActive ?? []).map((m) => at(m.email, m.scopeId)));
  const invited = new Set((opts.existingInvited ?? []).map((m) => at(m.email, m.scopeId)));

  const empty: ImportPlan = { rows: [], ready: 0, skipped: 0, errored: 0, fatal: null };

  if (!opts.text.trim()) {
    return { ...empty, fatal: "Nothing to read. Paste the list or choose a file." };
  }

  const grid = parseDelimited(opts.text);
  if (grid.length === 0) {
    return { ...empty, fatal: "Nothing to read. Paste the list or choose a file." };
  }

  const cols = readColumns(grid);
  const body = cols.header ? grid.slice(1) : grid;

  if (body.length === 0) {
    return {
      ...empty,
      fatal: "That file has a header row and nothing under it.",
    };
  }
  if (body.length > MAX_ROWS) {
    return {
      ...empty,
      fatal: `${body.length} rows is more than one batch should carry. Split it into files of ${MAX_ROWS} or fewer.`,
    };
  }

  const nodes = opts.nodes ?? [];
  const allNodes = opts.allNodes ?? nodes;
  const fallback = opts.grantable.find((r) => r.key === opts.defaultRoleKey) ?? null;
  const fallbackNode =
    nodes.find((n) => n.id === opts.defaultScopeId) ??
    // A file with no scope column and no picker behind it is the old shape,
    // and the root is what it has always meant.
    nodes.find((n) => n.kind === "ORG") ??
    null;
  const seen = new Map<string, number>();
  const rows: PlannedRow[] = [];

  body.forEach((cells, i) => {
    // Line as the person sees it in their editor, header included.
    const line = i + 1 + (cols.header ? 1 : 0);
    const rawEmail = (cells[cols.email] ?? "").trim();
    // A name is shown on this screen and nowhere else, but one starting with
    // a formula character is a spreadsheet trick rather than a name, so it is
    // dropped rather than carried.
    const cellName = cols.name >= 0 ? (cells[cols.name] ?? "").trim() : "";
    const rawName = FORMULA_START.test(cellName) ? "" : cellName;
    const rawRole = cols.role >= 0 ? (cells[cols.role] ?? "").trim() : "";
    const rawScope = cols.scope >= 0 ? (cells[cols.scope] ?? "").trim() : "";

    const base = {
      line,
      email: rawEmail,
      name: rawName || null,
      roleKey: null as string | null,
      roleLabel: null as string | null,
      scopeId: null as string | null,
      scopeName: null as string | null,
      warning: null as string | null,
    };

    if (!rawEmail) {
      rows.push({ ...base, verdict: "ERROR", reason: "No email address in this row." });
      return;
    }
    if (!looksLikeEmail(rawEmail)) {
      rows.push({
        ...base,
        verdict: "ERROR",
        reason: `"${rawEmail}" is not an email address.`,
      });
      return;
    }

    const email = normaliseEmail(rawEmail);

    // A file listing the same person twice is a person copying rows, not two
    // people. The first wins, and the second says where the first was.
    const earlier = seen.get(email);
    if (earlier !== undefined) {
      rows.push({
        ...base,
        email,
        verdict: "ERROR",
        reason: `Already in this file on line ${earlier}.`,
      });
      return;
    }
    seen.set(email, line);

    // --- where ------------------------------------------------------------
    // Resolved before the role, because whether a role fits depends on it.
    let node: CsvNode | null = fallbackNode;
    if (rawScope) {
      const hits = placesNamed(rawScope, nodes, allNodes);
      if (hits.length > 1) {
        const parent = parentOf(hits[0], allNodes);
        rows.push({
          ...base,
          email,
          verdict: "ERROR",
          // Two towers called "Phase 1" is the ordinary case, not a mistake,
          // so this asks for the project too rather than refusing the name.
          reason: parent
            ? `"${rawScope}" names ${hits.length} places here. Name the ${kindWord(parent.kind)} too, like ${parent.name} / ${hits[0].name}.`
            : `"${rawScope}" names ${hits.length} places here.`,
        });
        return;
      }
      if (hits.length === 0) {
        const elsewhere = placesNamed(rawScope, allNodes, allNodes);
        rows.push({
          ...base,
          email,
          verdict: "ERROR",
          reason: elsewhere.length
            ? `${elsewhere[0].name} is outside your part of the organisation.`
            : `"${rawScope}" is not a place in this organisation.`,
        });
        return;
      }
      node = hits[0];
    }

    if (!node) {
      rows.push({
        ...base,
        email,
        verdict: "ERROR",
        reason: "No place named, and no default chosen.",
      });
      return;
    }

    const withPlace = { ...base, email, scopeId: node.id, scopeName: node.name };

    // --- what -------------------------------------------------------------
    const role = rawRole ? matchRole(rawRole, opts.grantable) : fallback;
    if (!role) {
      const elsewhere = rawRole ? matchRole(rawRole, opts.allRoles ?? []) : null;
      rows.push({
        ...withPlace,
        verdict: "ERROR",
        reason: !rawRole
          ? "No role named, and no default chosen."
          : elsewhere?.key === FOUNDING_ROLE
            ? "Only an org admin can make someone else an org admin."
            : elsewhere && nodes.some((n) => roleFitsScope(elsewhere, n.kind))
              ? `${elsewhere.label} includes access you do not have.`
              : elsewhere
                ? `${elsewhere.label} is a ${kindWord(elsewhere.minKind)}-level role, and you have no ${kindWord(elsewhere.minKind)} to grant it at.`
                : `"${rawRole}" is not a role in this organisation.`,
      });
      return;
    }

    const withRole = { ...withPlace, roleKey: role.key, roleLabel: role.label };

    // The depth rule, the same one `checkGrant` enforces on the server. A
    // role and a place that each exist can still be the wrong pair.
    if (!roleFitsScope(role, node.kind)) {
      rows.push({ ...withRole, verdict: "ERROR", reason: depthRefusal(role, node) });
      return;
    }

    // The subset rule, which `checkGrant` asks again per row on the server:
    // you give a role only where you hold everything it does.
    if (role.at && !role.at.includes(node.id)) {
      rows.push({
        ...withRole,
        verdict: "ERROR",
        reason: `${role.label}${node.kind === "ORG" ? "" : ` on ${node.name}`} includes access you do not have.`,
      });
      return;
    }

    if (active.has(at(email, node.id))) {
      rows.push({
        ...withRole,
        verdict: "SKIP",
        reason:
          node.kind === "ORG"
            ? "Already on the team."
            : `Already on the team at ${node.name}.`,
      });
      return;
    }

    // The address gate, the same one a single invite passes through. A
    // personal mailbox is allowed with a warning; the founding role is not.
    const gate = checkAddress({
      email,
      orgPrimaryDomain: opts.orgPrimaryDomain,
      role: { key: role.key },
      personalAdmin: opts.personalAdmin,
    });
    if (!gate.ok) {
      rows.push({ ...withRole, verdict: "ERROR", reason: gate.message });
      return;
    }

    rows.push({
      ...withRole,
      verdict: "READY",
      reason: invited.has(at(email, node.id))
        ? "Already invited. This changes their role."
        : "",
      warning: gate.warning,
    });
  });

  return {
    rows,
    ready: rows.filter((r) => r.verdict === "READY").length,
    skipped: rows.filter((r) => r.verdict === "SKIP").length,
    errored: rows.filter((r) => r.verdict === "ERROR").length,
    fatal: null,
  };
}

/**
 * A file to hand somebody who asks what the format is.
 *
 * Built from the roles this tenant actually has rather than from a fixed list,
 * because a tenant that renamed a role should see its own names in the
 * example it is told to copy.
 */
export function exampleCsv(
  grantable: readonly CsvRole[],
  nodes: readonly CsvNode[] = [],
): string {
  // Never the founding role. An example is copied far more often than it is
  // read, and this one would hand out three administrators.
  const ordinary = grantable.filter((r) => r.key !== FOUNDING_ROLE);
  const pool = ordinary.length > 0 ? ordinary : grantable;
  const pick = (i: number) => pool[Math.min(i, pool.length - 1)]?.label ?? "";

  /** A name holding a separator has to survive being read back. */
  const cell = (value: string): string =>
    /[",;\t\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  // Each role shown beside a place it actually fits, from this tenant's own
  // tree. An example that refuses itself teaches the wrong format.
  const placeFor = (role: CsvRole): string => {
    const fits = nodes.filter((n) => roleFitsScope(role, n.kind));
    // The deepest one, because that is the column's whole reason for being.
    const deepest = fits[fits.length - 1];
    if (!deepest || deepest.kind === "ORG") return "";
    // A tenant with two towers called "Phase 1" would otherwise be handed an
    // example that its own rules refuse as ambiguous.
    return cell(placeCell(deepest, nodes));
  };

  const deeper = nodes.some((n) => n.kind !== "ORG");
  const line = (email: string, name: string, i: number) => {
    const role = pool[Math.min(i, pool.length - 1)];
    return deeper && role
      ? `${email},${name},${pick(i)},${placeFor(role)}`
      : `${email},${name},${pick(i)}`;
  };

  return [
    deeper ? "email,name,role,scope" : "email,name,role",
    line("priya@company.com", "Priya Nair", 0),
    line("rahul@company.com", "Rahul Mehta", 1),
    line("site.head@company.com", "", 2),
  ].join("\n");
}

export { FOUNDING_ROLE };
