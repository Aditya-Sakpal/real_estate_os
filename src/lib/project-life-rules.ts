/**
 * A project's life after its launch: the same registration held by two
 * companies, and a sold-out project retired. Pure and database-free,
 * covered by `check:logic`; `project-life.ts` and `rera.ts` read and write.
 *
 * Relative imports: `check:logic` loads this from source.
 */

// ---------------------------------------------------------------------------
// One project in two companies
// ---------------------------------------------------------------------------

/** Another company holding the same registration: its display name and kind, nothing else. */
export type Holder = { name: string; kind: string };

export type ElsewhereVerdict =
  | { ok: true; alsoHeldBy: Holder[] }
  | { ok: false; code: "HELD_BY_DEVELOPER"; message: string };

/**
 * Whether a registration may be recorded when other companies hold it too.
 *
 * A mandate firm or a channel partner works a developer's project through a
 * mandate or an empanelment once that developer is here, never as a second
 * copy of it. A developer is refused a number another developer holds, and
 * may record one a firm added before the developer joined; that firm is then
 * named on Today. Two firms holding one project refuse nobody.
 */
export function registrationElsewhere(myKind: string, holders: readonly Holder[]): ElsewhereVerdict {
  const developer = holders.find((h) => h.kind === "DEVELOPER");
  if (myKind === "MANDATE_FIRM" || myKind === "CHANNEL_PARTNER") {
    if (!developer) return { ok: true, alsoHeldBy: [] };
    const ask = myKind === "MANDATE_FIRM" ? "Ask them for a mandate" : "Once they empanel you, add it from Developers";
    return {
      ok: false,
      code: "HELD_BY_DEVELOPER",
      message: `${developer.name} already runs this project on Sales Desk. ${ask} to work on it.`,
    };
  }
  if (myKind === "DEVELOPER") {
    if (developer) {
      return {
        ok: false,
        code: "HELD_BY_DEVELOPER",
        message: `${developer.name} already has this registration on Sales Desk. Check the number on the certificate.`,
      };
    }
    return { ok: true, alsoHeldBy: holders.filter((h) => h.kind === "MANDATE_FIRM" || h.kind === "CHANNEL_PARTNER") };
  }
  return { ok: true, alsoHeldBy: [] };
}

export type SharedRow = { projectId: string; projectName: string; holder: string; kind: string };
export type SharedItem = { projectId: string; projectName: string; holder: string };

/** Today's items for a developer: each firm once per project it also holds. */
export function sharedProjectItems(myKind: string, rows: readonly SharedRow[]): SharedItem[] {
  if (myKind !== "DEVELOPER") return [];
  const seen = new Map<string, SharedItem>();
  for (const r of rows) {
    if (r.kind !== "MANDATE_FIRM" && r.kind !== "CHANNEL_PARTNER") continue;
    const key = `${r.projectId}|${r.holder.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { projectId: r.projectId, projectName: r.projectName, holder: r.holder });
  }
  return [...seen.values()].sort((a, b) => a.projectName.localeCompare(b.projectName) || a.holder.localeCompare(b.holder));
}

export const sharedTitle = (i: SharedItem) => `${i.holder} also has ${i.projectName} in its own console`;

// ---------------------------------------------------------------------------
// A retired project
// ---------------------------------------------------------------------------

export type ProjectStatus = "ACTIVE" | "RETIRED";

export const readProjectStatus = (raw: unknown): ProjectStatus => (raw === "RETIRED" ? "RETIRED" : "ACTIVE");

/** The first day after the IST month `nowIso` falls in: the day a retired project's plan stops. */
export function planEndsOn(nowIso: string): string {
  const d = new Date(Date.parse(nowIso) + 330 * 60_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** `31 Oct 2026`: the last day a retired project's plan covers. */
export function lastPlanDay(nowIso: string): string {
  const end = new Date(`${planEndsOn(nowIso)}T00:00:00Z`);
  const last = new Date(end.getTime() - 86_400_000);
  return last.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Which plan a project runs on today: its own, a channel partner's plan for
 * the whole firm, or none. Retiring ends only the first.
 */
export type RetirePlan = "PROJECT" | "FIRM" | "NONE";

/** What retiring stops, in the confirmation's words. */
export function retireStops(nowIso: string, plan: RetirePlan = "PROJECT"): string[] {
  const lines = [
    "Every schedule stops.",
    "Every running ad is paused.",
    "Calls and messages waiting for its buyers are called off. Booked buyers still get their visit and booking messages.",
  ];
  if (plan === "PROJECT") lines.push(`Its plan ends on ${lastPlanDay(nowIso)}.`);
  if (plan === "FIRM") lines.push("It frees a project on your firm's plan.");
  return lines;
}

/**
 * Why a project cannot be reactivated, or null. A channel partner's firm
 * plan covers so many projects; a retired one freed its slot, and taking it
 * back needs the slot to be free.
 */
export function reactivateRefusal(o: { status: ProjectStatus; firmCap: number | null; activeProjects: number }): string | null {
  if (o.status !== "RETIRED") return "This project is not retired.";
  if (o.firmCap !== null && o.activeProjects >= o.firmCap) {
    return `Your plan covers ${o.firmCap} projects, and you have ${o.activeProjects}. Retire another or move to a bigger plan first.`;
  }
  return null;
}

/** Said to anything paid asked for on a retired project. */
export const RETIRED_MESSAGE = "This project is retired. Reactivate it on its page to run anything for it.";
