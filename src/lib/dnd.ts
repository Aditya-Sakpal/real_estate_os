import type { TransactionSql } from "postgres";
import { audit, withTenant } from "./db/index.ts";
import {
  dndActivity,
  dndVerdict,
  expiresFor,
  readLookup,
  standingDnd,
  type DndRow,
  type DndSource,
  type DndStatus,
  type DndVerdict,
} from "./dnd-rules.ts";

/**
 * The DND register, as the call gate asks it: what we know about a number,
 * and a lookup when we know nothing and have something to look it up with.
 *
 * No official single-number lookup exists (TRAI and Vobiz publish none), and
 * the third-party ones publish neither a price nor how fresh their lists are,
 * so none is wired in. The seam is here for when one is chosen: `useDnd()`
 * for the checks, `DND_FIXTURE_DIR` for a development machine. Until then
 * the gate reads what the operator refused and what a person recorded.
 */

export type DndDriver = {
  /** The register's answer for one number, or null when it could not say. */
  lookup(phone: string, signal: AbortSignal): Promise<"DND" | "CLEAR" | null>;
};

let injected: DndDriver | null = null;

/** Swap the lookup for the checks. Beats the fixture folder. */
export function useDnd(d: DndDriver | null): void {
  injected = d;
}

/**
 * A folder of files named `<digits>` (the number without its plus) holding
 * DND or CLEAR. A development and test seam, ignored in production and on
 * Vercel. A number with no file is no answer, never a clean one.
 */
function fixtureDriver(): DndDriver | null {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) return null;
  const dir = process.env.DND_FIXTURE_DIR?.trim();
  if (!dir) return null;
  return {
    async lookup(phone) {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      try {
        return readLookup(await readFile(join(dir, phone.replace(/\D/g, "")), "utf8"));
      } catch {
        return null;
      }
    },
  };
}

function driver(): DndDriver | null {
  return injected ?? fixtureDriver();
}

/** How long a lookup may take before the call goes ahead without it. */
export const LOOKUP_TIMEOUT_MS = 5_000;

const toRow = (r: { status: DndStatus; source: DndSource; checked_at: Date; expires_at: Date | null }): DndRow => ({
  status: r.status,
  source: r.source,
  checkedAt: r.checked_at.toISOString(),
  expiresAt: r.expires_at?.toISOString() ?? null,
});

/** The answer that stands for a number now, or null. */
export async function standingFor(orgId: string, phone: string, nowIso: string, sqlIn?: TransactionSql): Promise<DndRow | null> {
  const read = (sql: TransactionSql) => sql<{ status: DndStatus; source: DndSource; checked_at: Date; expires_at: Date | null }[]>`
    SELECT status, source, checked_at, expires_at FROM dnd_checks
    WHERE org_id = ${orgId} AND phone = ${phone} AND checked_at <= ${new Date(nowIso)}
    ORDER BY checked_at DESC LIMIT 1`;
  const rows = sqlIn ? await read(sqlIn) : await withTenant(orgId, read);
  return standingDnd(rows.map(toRow), nowIso);
}

/**
 * Write one answer, with a line on the lead's history where it says
 * something a person should see. Audited with the status and the source;
 * the number never.
 */
export async function recordDnd(o: {
  orgId: string;
  phone: string;
  status: DndStatus;
  source: DndSource;
  leadId: string | null;
  callId?: string | null;
  userId?: string | null;
  nowIso?: string;
  sql?: TransactionSql;
}): Promise<void> {
  const at = o.nowIso ?? new Date().toISOString();
  const expires = expiresFor(o.source, at);
  const note = dndActivity(o.status, o.source);
  const write = async (sql: TransactionSql) => {
    await sql`
      INSERT INTO dnd_checks (org_id, phone, status, source, lead_id, call_id, recorded_by, checked_at, expires_at)
      VALUES (${o.orgId}, ${o.phone}, ${o.status}, ${o.source}, ${o.leadId}, ${o.callId ?? null},
              ${o.source === "PERSON" ? o.userId ?? null : null}, ${new Date(at)}, ${expires ? new Date(expires) : null})`;
    if (note && o.leadId) {
      await sql`
        INSERT INTO lead_activity (org_id, lead_id, kind, reason, actor_user_id)
        VALUES (${o.orgId}, ${o.leadId}, 'NOTE', ${note}, ${o.source === "PERSON" ? o.userId ?? null : null})`;
    }
  };
  if (o.sql) await write(o.sql);
  else await withTenant(o.orgId, write);
  if (note) {
    await audit({
      orgId: o.orgId,
      actorUserId: o.source === "PERSON" ? o.userId ?? null : null,
      action: "lead.dnd_recorded",
      targetType: o.leadId ? "lead" : null,
      targetId: o.leadId,
      metadata: { status: o.status, source: o.source, ...(o.callId ? { call: o.callId } : {}) },
    });
  }
}

/**
 * Whether the register allows a call to this number now. Asked after every
 * gate that costs nothing, so a lookup is never spent on a call something
 * else would have refused. A lookup that fails or runs out of time is no
 * answer, and the call goes ahead: the operator scrubs at dial time anyway.
 */
export async function dndGate(o: {
  orgId: string;
  phone: string;
  leadId: string;
  enquiredAt: string;
  nowIso: string;
}): Promise<DndVerdict> {
  const standing = await standingFor(o.orgId, o.phone, o.nowIso);
  const verdict = dndVerdict({ standing, enquiredAt: o.enquiredAt, nowIso: o.nowIso });
  if (!verdict.ok || verdict.basis !== "UNKNOWN") return verdict;
  const d = driver();
  if (!d) return verdict;

  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answer = await Promise.race([
    d.lookup(o.phone, ctl.signal).catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort();
        resolve(null);
      }, LOOKUP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!answer) return verdict;

  await recordDnd({ orgId: o.orgId, phone: o.phone, status: answer, source: "LOOKUP", leadId: o.leadId, nowIso: o.nowIso });
  return dndVerdict({
    standing: { status: answer, source: "LOOKUP", checkedAt: o.nowIso, expiresAt: expiresFor("LOOKUP", o.nowIso) },
    enquiredAt: o.enquiredAt,
    nowIso: o.nowIso,
  });
}
