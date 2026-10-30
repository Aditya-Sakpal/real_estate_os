import { controlDb, withTenant, audit } from "./db/index.ts";
import { adapterFor, nightlyRead } from "./rera-states.ts";
import { BLANKET_EXTENSIONS, blanketExtension, promoterMatches, stateRule } from "./rera-rules.ts";
import type { AuthorityStatus, NightlyRead } from "./rera-portal.ts";
import { fetchBlocklist, type BlockedProject } from "./rera-mh.ts";
import { getRegister, type RegisteredProject } from "./rera-mh-register.ts";
import { haltBlocked } from "./publish.ts";

/**
 * The daily re-verification.
 *
 * Four jobs, and only the last two need a portal.
 *
 *   0. EXTENSION. An authority's own order that extended every registration
 *      at once (the West Asia orders of August 2026) moves no date the client
 *      typed. The pure rule in `rera-rules.ts` says which registrations it
 *      reaches, and the later date is written beside the typed one, with the
 *      order it came from. A phase this job lapsed before the order was
 *      known is put back.
 *
 *   1. LAPSE. A verified registration whose validity (extension included)
 *      has run out, and an exemption older than its 90 days, both fall back
 *      to BLOCKED. This needs no network call: the dates are already
 *      recorded. It is also the half that matters most, because a
 *      registration does not fail loudly; it simply stops being valid one
 *      morning while a campaign is running.
 *
 *   2. MAHARASHTRA. MahaRERA publishes, in bulk and in public, every project
 *      it has suspended, put in abeyance or deregistered (two pages), and
 *      its whole register (one page). A VERIFIED number on the revocation
 *      list, or absent from the register, is BLOCKED.
 *
 *   3. EVERY OTHER STATE with an adapter (`rera-states.ts`) the same way:
 *      its published lists read ONCE for all tenants, then each tenant's
 *      registrations in that state matched against them in memory. A number
 *      on the authority's revoked, cancelled, suspended, withdrawn or lapsed
 *      list is BLOCKED; one absent from a complete register is BLOCKED; one
 *      the register holds for a different promoter is BLOCKED. A state with
 *      no bulk source (Uttar Pradesh, whose QR is checked when the lockup is
 *      approved) is held to its dates.
 *
 * A state's lists are read only when some tenant in scope holds a verified
 * registration there, so no government website is asked about nothing. And
 * nothing here ever asks a portal about one registration: that is thousands
 * of requests a night, and enough load on one server to earn a block.
 *
 * A portal being unreachable NEVER blocks a phase. An unknown is not a
 * failure, and flipping a verified registration to blocked because a
 * government website was down would stop a lawful campaign for no reason.
 * Only a definite answer moves anything.
 *
 * Imports are relative so `npm run rera:sweep` can load this straight from
 * source: a scheduled job runs outside Next, where the `@/` alias does not
 * resolve.
 */

export type SweepChange = {
  orgId: string;
  phasePath: string;
  from: string;
  to: string;
  why: string;
};

export type StateRead = {
  ok: boolean;
  reason?: string;
  registerSize?: number | null;
  blockedSize?: number;
  requests?: number;
};

export type SweepReport = {
  orgsScanned: number;
  recordsScanned: number;
  /** Registrations an authority's order extended, or put back. */
  extended: SweepChange[];
  lapsed: SweepChange[];
  exemptionsLapsed: SweepChange[];
  revoked: SweepChange[];
  /** Registrations no longer in, or never in, the published register. */
  unregistered: SweepChange[];
  /** Registrations the authority's register holds for another promoter. */
  promoterMismatch: SweepChange[];
  /** Verified registrations a machine looked at tonight. */
  portalChecked: number;
  /** Verified registrations whose state's lists could not be read. */
  portalUnavailable: number;
  /** Size of MahaRERA's published revocation list, or null when unread. */
  blocklistSize: number | null;
  blocklistError: string | null;
  /** Size of MahaRERA's published register, or null when unread. */
  registerSize: number | null;
  registerError: string | null;
  /** Every other state read tonight, by code. */
  states: Record<string, StateRead>;
  /**
   * Pass 3: what the blocked phases were advertising. Ads paused, anything
   * not yet out cancelled, organic posts still up listed for a person.
   */
  halted: { paused: number; cancelled: number; flagged: number; couldNotPause: number };
};

export type SweepOptions = {
  /**
   * Injected by the checks so a test run never calls a government website.
   * Hitting a regulator's server on every `npm run check` would be both rude
   * and a source of failures that say nothing about this code.
   */
  fetchImpl?: typeof fetch;
  /**
   * Limit the sweep to these tenants.
   *
   * Two uses. A test must not reach into a real tenant's records, which it
   * otherwise would, since this job is global by nature. And at scale the
   * work is spread rather than done all at once: hash each org into a
   * day-of-week bucket and sweep a slice a night, which keeps the shape of
   * the job identical however many clients there are.
   */
  orgIds?: string[];
  /**
   * Read only these states' lists tonight. The dates are enforced for every
   * state regardless. For an operator re-checking one authority after its
   * portal was down, and for a check that must not ask MahaRERA again while
   * it tests Karnataka.
   */
  states?: string[];
};

type Row = { id: string; path: string; no: string };

/** What an authority's list says, as a reason a client reads. */
function listedAs(status: AuthorityStatus): string {
  switch (status) {
    case "LAPSED":
      return "lapsed";
    case "SUSPENDED":
      return "suspended";
    case "WITHDRAWN":
      return "withdrawn";
    default:
      return "revoked";
  }
}

export async function sweep(
  now = new Date(),
  opts: SweepOptions = {},
): Promise<SweepReport> {
  // Enumerating tenants is a control-plane act: a platform job has no single
  // org to pin. Everything it then DOES runs inside withTenant, so RLS is
  // enforced on the work even though the job is not a tenant request.
  const orgs = await controlDb<{ id: string }[]>`
    SELECT id FROM orgs
    WHERE status <> 'SUSPENDED'
      ${opts.orgIds ? controlDb`AND id = ANY(${opts.orgIds})` : controlDb``}
    ORDER BY created_at
  `;

  const report: SweepReport = {
    orgsScanned: orgs.length,
    recordsScanned: 0,
    extended: [],
    lapsed: [],
    exemptionsLapsed: [],
    revoked: [],
    unregistered: [],
    promoterMismatch: [],
    portalChecked: 0,
    portalUnavailable: 0,
    blocklistSize: null,
    blocklistError: null,
    registerSize: null,
    registerError: null,
    states: {},
    halted: { paused: 0, cancelled: 0, flagged: 0, couldNotPause: 0 },
  };

  const today = now.toISOString().slice(0, 10);
  const extensionStates = [...new Set(BLANKET_EXTENSIONS.map((e) => e.state))];

  // --- 0. extensions an authority granted to everybody ----------------------
  for (const org of orgs) {
    const changed = await withTenant(org.id, async (sql) => {
      const rows = await sql<
        {
          id: string;
          path: string;
          no: string | null;
          state: string;
          status: string;
          valid_to: Date;
          extended_until: Date | null;
          registered_on: Date | null;
          verified_at: Date | null;
          reason: string | null;
        }[]
      >`
        SELECT ph.id, ph.path::text AS path, r.registration_no AS no, r.state_code AS state,
               r.status, r.valid_to, r.extended_until, r.registered_on, r.verified_at,
               r.resolution_reason AS reason
        FROM registration_records r
        JOIN scope_nodes ph ON ph.id = r.scope_node_id
        WHERE r.org_id = ${org.id}
          AND r.state_code = ANY(${extensionStates})
          AND r.valid_to IS NOT NULL
          AND r.registration_no IS NOT NULL
          AND (r.status = 'VERIFIED'
               OR (r.status = 'BLOCKED' AND r.resolution_reason LIKE 'Registration validity expired on%'))
      `;
      const out: { id: string; path: string; no: string; until: string; ref: string; restored: boolean }[] = [];
      for (const r of rows) {
        const ext = blanketExtension({
          stateCode: r.state,
          validTo: r.valid_to,
          registeredOn: r.registered_on,
          recordedAt: r.verified_at,
        });
        if (!ext) continue;
        const held = r.extended_until ? r.extended_until.toISOString().slice(0, 10) : null;
        const lengthens = !held || ext.until > held;
        // A phase this job lapsed on its typed date comes back only when the
        // order carries it past today; otherwise it is lapsed either way.
        const restores = r.status === "BLOCKED" && ext.until >= today;
        if (!lengthens && !restores) continue;
        if (r.status === "BLOCKED" && !restores) continue;
        await sql`
          UPDATE registration_records
          SET extended_until = ${lengthens ? ext.until : held}, extension_ref = ${lengthens ? ext.ref : sql`extension_ref`},
              ${restores ? sql`status = 'VERIFIED', resolution_reason = ${`Extended to ${ext.until} by ${ext.ref}.`},` : sql``}
              updated_at = ${now}
          WHERE org_id = ${org.id} AND scope_node_id = ${r.id}
        `;
        out.push({ id: r.id, path: r.path, no: r.no ?? "", until: ext.until, ref: ext.ref, restored: restores });
      }
      return out;
    });
    for (const c of changed) {
      report.extended.push({
        orgId: org.id,
        phasePath: c.path,
        from: c.restored ? "BLOCKED" : "VERIFIED",
        to: "VERIFIED",
        why: `${c.no} extended to ${c.until} by ${c.ref}`,
      });
      await audit({
        orgId: org.id,
        actorUserId: null,
        action: "rera.extended",
        targetType: "scope_node",
        targetId: c.id,
        metadata: { registration_no: c.no, extended_until: c.until, order: c.ref, restored: c.restored, by: "sweep" },
      });
    }
  }

  // Which states hold a verified registration tonight. A state's lists are
  // read only when somebody in scope needs them.
  const held = new Set<string>();
  for (const org of orgs) {
    const states = await withTenant(org.id, async (sql) =>
      sql<{ state: string }[]>`
        SELECT DISTINCT state_code AS state FROM registration_records
        WHERE org_id = ${org.id} AND status = 'VERIFIED' AND state_code IS NOT NULL`,
    );
    for (const s of states) held.add(s.state);
  }
  if (opts.states) {
    const only = new Set(opts.states.map((s) => s.toUpperCase()));
    for (const s of [...held]) if (!only.has(s)) held.delete(s);
  }

  // Fetched ONCE for the whole sweep, not once per tenant. Two requests total,
  // however many clients there are.
  let blocklist: Map<string, BlockedProject> | null = null;
  let register: Map<string, RegisteredProject> | null = null;
  if (held.has("MH")) {
    const list = await fetchBlocklist(opts.fetchImpl);
    if (list.ok) {
      blocklist = list.entries;
      report.blocklistSize = list.entries.size;
    } else {
      // Unreadable is an unknown, not a finding. Nothing is blocked on the
      // strength of a page that would not load or would not parse.
      report.blocklistError = list.reason;
    }

    // The register, also once. Through the shared day-long cache, which costs
    // a scheduled job nothing (its process is new every night, so the cache
    // is always cold) and saves a repeated sweep in one process from pulling
    // the same 3.5 MB again.
    const reg = await getRegister(opts.fetchImpl);
    if (reg.ok) {
      register = reg.entries;
      report.registerSize = reg.entries.size;
    } else {
      report.registerError = reg.reason;
    }
  }

  // Every other state's lists, once each.
  const reads = new Map<string, NightlyRead>();
  for (const state of [...held].sort()) {
    if (state === "MH") continue;
    const adapter = adapterFor(state);
    if (!adapter?.nightly) continue;
    const r = await nightlyRead(state, { fetchImpl: opts.fetchImpl });
    if (r.ok) {
      reads.set(state, r.read);
      report.states[state] = {
        ok: true,
        registerSize: r.read.register ? r.read.register.size : null,
        blockedSize: r.read.blocked.size,
        requests: r.read.requests,
      };
    } else {
      report.states[state] = { ok: false, reason: r.reason };
    }
  }

  for (const org of orgs) {
    const work = await withTenant(org.id, async (sql) => {
      // --- 1a. registrations whose validity has run out -------------------
      const expired = await sql<{ id: string; path: string; no: string; runs_to: Date }[]>`
        UPDATE registration_records r
        SET status = 'BLOCKED', updated_at = ${now},
            resolution_reason = 'Registration validity expired on '
              || to_char(GREATEST(r.valid_to, COALESCE(r.extended_until, r.valid_to)), 'DD Mon YYYY')
        FROM scope_nodes ph
        WHERE ph.id = r.scope_node_id
          AND r.org_id = ${org.id}
          AND r.status = 'VERIFIED'
          AND r.valid_to IS NOT NULL
          AND GREATEST(r.valid_to, COALESCE(r.extended_until, r.valid_to)) < ${now}
        RETURNING ph.id, ph.path::text AS path, r.registration_no AS no,
                  GREATEST(r.valid_to, COALESCE(r.extended_until, r.valid_to)) AS runs_to
      `;

      // --- 1b. exemptions past their 90 days ------------------------------
      // The phases fall back, and the attestation row stays: it is a record
      // that someone asserted this on a date, and deleting it would erase the
      // accountability rather than end it.
      const staleExemptions = await sql<{ id: string; path: string; expires_at: Date }[]>`
        UPDATE registration_records r
        SET status = 'BLOCKED', updated_at = ${now},
            resolution_reason = 'Exemption attestation expired on ' || to_char(e.expires_at, 'DD Mon YYYY')
        FROM scope_nodes ph
        JOIN project_exemptions e ON e.scope_node_id = ph.parent_id
        WHERE ph.id = r.scope_node_id
          AND r.org_id = ${org.id}
          AND r.status = 'EXEMPT'
          AND e.expires_at < ${now}
        RETURNING ph.id, ph.path::text AS path, e.expires_at
      `;

      // --- 2a. revoked by MahaRERA ----------------------------------------
      // One query per tenant against the set, rather than one request per
      // registration against the portal.
      const revoked = blocklist
        ? await sql<Row[]>`
            UPDATE registration_records r
            SET status = 'BLOCKED', updated_at = ${now}, last_checked_at = ${now},
                resolution_reason = 'Revoked by MahaRERA. On the published '
                  || ${"suspended or deregistered"} || ' list.'
            FROM scope_nodes ph
            WHERE ph.id = r.scope_node_id
              AND r.org_id = ${org.id}
              AND r.status = 'VERIFIED'
              AND r.state_code = 'MH'
              AND r.registration_no = ANY(${[...blocklist.keys()]})
            RETURNING ph.id, ph.path::text AS path, r.registration_no AS no
          `
        : [];

      // --- 2b. never in MahaRERA's register at all ------------------------
      // Matched in memory rather than by shipping the whole register into
      // every query. A tenant holds a handful of registrations and the
      // register holds fifty thousand, so the small side travels.
      const unregistered: Row[] = [];
      if (register) {
        const mine = await sql<Row[]>`
          SELECT ph.id, ph.path::text AS path, r.registration_no AS no
          FROM registration_records r
          JOIN scope_nodes ph ON ph.id = r.scope_node_id
          WHERE r.org_id = ${org.id}
            AND r.status = 'VERIFIED'
            AND r.state_code = 'MH'
            AND r.registration_no IS NOT NULL
        `;
        for (const row of mine) {
          if (!register.has(row.no.trim().toUpperCase())) unregistered.push(row);
        }
        if (unregistered.length > 0) {
          await sql`
            UPDATE registration_records
            SET status = 'BLOCKED', updated_at = ${now}, last_checked_at = ${now},
                resolution_reason = 'Not in the MahaRERA register. No project is registered under this number.'
            WHERE org_id = ${org.id}
              AND scope_node_id = ANY(${unregistered.map((r) => r.id)})
          `;
        }
      }

      // Everything that survived the list WAS checked against the authority,
      // so it is honest to stamp it. The column means "a machine looked", and
      // one did.
      let mhChecked = 0;
      if (blocklist) {
        const stamped = await sql<{ id: string }[]>`
          UPDATE registration_records
          SET last_checked_at = ${now}
          WHERE org_id = ${org.id} AND status = 'VERIFIED' AND state_code = 'MH'
          RETURNING scope_node_id AS id
        `;
        mhChecked = stamped.length;
      }

      // --- 3. every other state's lists ----------------------------------
      const others = await sql<
        { id: string; path: string; no: string; state: string; entity: string }[]
      >`
        SELECT ph.id, ph.path::text AS path, r.registration_no AS no, r.state_code AS state,
               entity.name AS entity
        FROM registration_records r
        JOIN scope_nodes ph     ON ph.id = r.scope_node_id
        JOIN scope_nodes p      ON p.id = ph.parent_id
        JOIN scope_nodes region ON region.id = p.parent_id
        JOIN scope_nodes entity ON entity.id = region.parent_id
        WHERE r.org_id = ${org.id} AND r.status = 'VERIFIED'
          AND r.registration_no IS NOT NULL
          AND r.state_code IS NOT NULL AND r.state_code <> 'MH'
      `;

      const listed: (Row & { state: string; status: AuthorityStatus })[] = [];
      const absent: (Row & { state: string })[] = [];
      const otherPromoter: (Row & { state: string; entity: string; promoter: string })[] = [];
      const checked: string[] = [];
      let unavailable = 0;

      for (const row of others) {
        const read = reads.get(row.state);
        const adapter = adapterFor(row.state);
        if (!read || !adapter) {
          // No lists for this state, or they could not be read tonight: its
          // dates were enforced above and nothing else is said.
          if (adapter?.nightly) unavailable += 1;
          continue;
        }
        const key = adapter.keyOf(row.no);
        const hit = read.blocked.get(key);
        if (hit) {
          listed.push({ ...row, status: hit.status });
          continue;
        }
        if (read.register) {
          const entry = read.register.get(key);
          if (!entry) {
            absent.push(row);
            continue;
          }
          if (entry.promoterName && !promoterMatches(entry.promoterName, row.entity)) {
            otherPromoter.push({ ...row, promoter: entry.promoterName });
            continue;
          }
        }
        checked.push(row.id);
      }

      for (const r of listed) {
        const authority = stateRule(r.state)?.authority ?? r.state;
        await sql`
          UPDATE registration_records
          SET status = 'BLOCKED', updated_at = ${now}, last_checked_at = ${now},
              resolution_reason = ${`${authority} lists this registration as ${listedAs(r.status)}.`}
          WHERE org_id = ${org.id} AND scope_node_id = ${r.id}
        `;
      }
      for (const r of absent) {
        const authority = stateRule(r.state)?.authority ?? r.state;
        await sql`
          UPDATE registration_records
          SET status = 'BLOCKED', updated_at = ${now}, last_checked_at = ${now},
              resolution_reason = ${`Not in the ${authority} register. No project is registered under this number.`}
          WHERE org_id = ${org.id} AND scope_node_id = ${r.id}
        `;
      }
      for (const r of otherPromoter) {
        const authority = stateRule(r.state)?.authority ?? r.state;
        await sql`
          UPDATE registration_records
          SET status = 'BLOCKED', updated_at = ${now}, last_checked_at = ${now},
              resolution_reason = ${`The ${authority} register names "${r.promoter}" as the promoter, not "${r.entity}".`}
          WHERE org_id = ${org.id} AND scope_node_id = ${r.id}
        `;
      }
      if (checked.length > 0) {
        await sql`
          UPDATE registration_records SET last_checked_at = ${now}
          WHERE org_id = ${org.id} AND scope_node_id = ANY(${checked})
        `;
      }

      return {
        expired,
        staleExemptions,
        revoked,
        unregistered,
        listed,
        absent,
        otherPromoter,
        checked: checked.length + mhChecked + revoked.length + unregistered.length,
        unavailable,
        scanned: others.length,
      };
    });

    report.recordsScanned += work.scanned + work.expired.length + work.staleExemptions.length;
    report.portalChecked += work.checked + work.listed.length + work.absent.length + work.otherPromoter.length;
    report.portalUnavailable += work.unavailable;

    for (const row of work.expired) {
      report.lapsed.push({
        orgId: org.id,
        phasePath: row.path,
        from: "VERIFIED",
        to: "BLOCKED",
        why: `Registration ${row.no} expired on ${row.runs_to.toISOString().slice(0, 10)}`,
      });
      await audit({
        orgId: org.id,
        actorUserId: null,
        action: "rera.lapsed",
        targetType: "scope_node",
        targetId: row.id,
        metadata: { registration_no: row.no, valid_to: row.runs_to.toISOString(), by: "sweep" },
      });
    }

    for (const row of work.staleExemptions) {
      report.exemptionsLapsed.push({
        orgId: org.id,
        phasePath: row.path,
        from: "EXEMPT",
        to: "BLOCKED",
        why: `Exemption attestation expired on ${row.expires_at.toISOString().slice(0, 10)}`,
      });
      await audit({
        orgId: org.id,
        actorUserId: null,
        action: "rera.exemption_lapsed",
        targetType: "scope_node",
        targetId: row.id,
        metadata: { expires_at: row.expires_at.toISOString(), by: "sweep" },
      });
    }

    for (const row of work.revoked) {
      const entry = blocklist?.get(row.no);
      report.revoked.push({
        orgId: org.id,
        phasePath: row.path,
        from: "VERIFIED",
        to: "BLOCKED",
        why: `${row.no} is ${entry?.status.toLowerCase() ?? "revoked"} by MahaRERA`,
      });
      await audit({
        orgId: org.id,
        actorUserId: null,
        action: "rera.revoked",
        targetType: "scope_node",
        targetId: row.id,
        metadata: {
          registration_no: row.no,
          state: "MH",
          authority_status: entry?.status ?? null,
          authority_project: entry?.projectName ?? null,
          by: "sweep",
          check: "blocklist",
        },
      });
    }

    for (const row of work.listed) {
      const authority = stateRule(row.state)?.authority ?? row.state;
      const change = {
        orgId: org.id,
        phasePath: row.path,
        from: "VERIFIED",
        to: "BLOCKED",
        why: `${row.no} is ${listedAs(row.status)} by ${authority}`,
      };
      (row.status === "LAPSED" ? report.lapsed : report.revoked).push(change);
      await audit({
        orgId: org.id,
        actorUserId: null,
        action: row.status === "LAPSED" ? "rera.lapsed" : "rera.revoked",
        targetType: "scope_node",
        targetId: row.id,
        metadata: { registration_no: row.no, state: row.state, authority_status: row.status, by: "sweep", check: "list" },
      });
    }

    for (const row of [...work.unregistered.map((r) => ({ ...r, state: "MH" })), ...work.absent]) {
      const authority = stateRule(row.state)?.authority ?? row.state;
      report.unregistered.push({
        orgId: org.id,
        phasePath: row.path,
        from: "VERIFIED",
        to: "BLOCKED",
        why: `${row.no} is not in the ${authority} register`,
      });
      await audit({
        orgId: org.id,
        actorUserId: null,
        action: "rera.unregistered",
        targetType: "scope_node",
        targetId: row.id,
        metadata: {
          registration_no: row.no,
          state: row.state,
          register_size: row.state === "MH" ? report.registerSize : report.states[row.state]?.registerSize ?? null,
          by: "sweep",
          check: "register",
        },
      });
    }

    for (const row of work.otherPromoter) {
      const authority = stateRule(row.state)?.authority ?? row.state;
      report.promoterMismatch.push({
        orgId: org.id,
        phasePath: row.path,
        from: "VERIFIED",
        to: "BLOCKED",
        why: `${authority} registered ${row.no} to ${row.promoter}`,
      });
      await audit({
        orgId: org.id,
        actorUserId: null,
        action: "rera.promoter_mismatch",
        targetType: "scope_node",
        targetId: row.id,
        // The promoter is a company named on a public register, not a person.
        metadata: { registration_no: row.no, state: row.state, authority_promoter: row.promoter, by: "sweep", check: "register" },
      });
    }
  }

  // Pass 3. Asked of every tenant's current state rather than of the changes
  // above, so an ad the platform would not pause last night is paused
  // tonight, and a phase blocked by hand in the console is covered too.
  for (const org of orgs) {
    const h = await haltBlocked(org.id, now);
    report.halted.paused += h.paused;
    report.halted.cancelled += h.cancelled;
    report.halted.flagged += h.flagged;
    report.halted.couldNotPause += h.couldNotPause;
  }

  return report;
}
