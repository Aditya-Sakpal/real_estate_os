import { ALL_PERMISSIONS } from "./permissions.ts";
import { scopeCovers } from "./rbac-rules.ts";

/**
 * A person who leaves takes nothing with them: the pure half of
 * `departures.ts`.
 *
 * When somebody loses a membership (removed, moved to a role without the key,
 * deactivated by their company's identity provider), whatever they were
 * working on that they can no longer open moves to somebody who can. The
 * test is per object, at its own node: a Sales Head for Pune who was also
 * Site Team on Tower C keeps the Pune leads when the tower role ends.
 */

/** One of a person's live memberships: where, and what its role holds. */
export type HeldGrant = { path: string; permissions: readonly string[] };

/** What lets a person keep each kind of work. Any one of the keys will do. */
export const KEEPS = {
  lead: ["lead:update"],
  // A host with hours is chosen for `visit:confirm`; without, for `visit:outcome`.
  visit: ["visit:confirm", "visit:outcome"],
  firm: ["partner:empanel"],
} as const satisfies Record<string, readonly string[]>;

/** Whether any grant covering `path` holds one of `keys` (or everything). */
export function holdsAt(grants: readonly HeldGrant[], keys: readonly string[], path: string): boolean {
  return grants.some(
    (g) => scopeCovers(g.path, path) && (g.permissions.includes(ALL_PERMISSIONS) || keys.some((k) => g.permissions.includes(k))),
  );
}

/** The objects this person can no longer work on, by the grants they still hold. */
export function leftBehind<T extends { path: string }>(grants: readonly HeldGrant[], items: readonly T[], keys: readonly string[]): T[] {
  return items.filter((i) => !holdsAt(grants, keys, i.path));
}

/**
 * A firm is kept by holding the key at one of the projects it is empanelled
 * on; a new manager must hold it at every one of them, or at the
 * organisation's root when the firm has none left.
 */
export function keepsFirm(grants: readonly HeldGrant[], paths: readonly string[], root: string): boolean {
  return (paths.length ? paths : [root]).some((p) => holdsAt(grants, KEEPS.firm, p));
}

export type Candidate = {
  id: string;
  name: string;
  /** Holds the wildcard: the founding admin, used only when nobody else will do. */
  admin: boolean;
  /** What they already carry: open leads, or firms they look after. */
  load: number;
};

/**
 * Hand `n` things out, least loaded first, one at a time, so forty leads do
 * not all land on whoever had the fewest a moment ago. An admin takes work
 * only when nobody else can, the rule `ownersFor()` already follows. A null
 * means nobody: the thing is left without anybody, and Today says so.
 */
export function spread(candidates: readonly Candidate[], n: number): (string | null)[] {
  const floor = candidates.filter((c) => !c.admin);
  const pool = (floor.length ? floor : candidates).map((c) => ({ ...c }));
  const out: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    pool.sort((a, b) => a.load - b.load || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const next = pool[0];
    if (!next) {
      out.push(null);
      continue;
    }
    next.load += 1;
    out.push(next.id);
  }
  return out;
}

/** The line on a lead's history. Short enough for `lead_activity.reason`. */
export function departedLine(name: string): string {
  return `Owner changed: ${name.trim() || "a teammate"} left the team`.slice(0, 200);
}

/** Today's title for leads a departed owner left with nobody. */
export function orphanTitle(n: number, name: string): string {
  const who = name.trim() || "a teammate";
  return n === 1 ? `1 lead has no owner since ${who} left` : `${n} leads have no owner since ${who} left`;
}

export type Reassigned = {
  leads: number;
  leadsUnowned: number;
  visits: number;
  visitsUnhosted: number;
  firms: number;
  firmsUnmanaged: number;
};

export const NOTHING_MOVED: Reassigned = { leads: 0, leadsUnowned: 0, visits: 0, visitsUnhosted: 0, firms: 0, firmsUnmanaged: 0 };

export function movedAnything(r: Reassigned): boolean {
  return Object.values(r).some((n) => n > 0);
}

/** What the screen says after a change, beside the change itself. Empty when nothing moved. */
export function reassignedLine(r: Reassigned): string {
  const parts: string[] = [];
  const say = (n: number, one: string, many: string) => n && parts.push(n === 1 ? one : many.replace("#", String(n)));
  say(r.leads, "1 lead", "# leads");
  say(r.visits, "1 visit", "# visits");
  say(r.firms, "1 partner firm", "# partner firms");
  const moved = parts.length ? `${parts.join(", ")} moved to others on the team.` : "";
  const left = r.leadsUnowned + r.visitsUnhosted + r.firmsUnmanaged;
  const nobody = left ? ` ${left === 1 ? "1 has" : `${left} have`} nobody to take it yet.` : "";
  return `${moved}${nobody}`.trim();
}
