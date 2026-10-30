/**
 * A project's own share of a shared allowance: the rules, with no database.
 * `project-caps.ts` reads, writes and asks.
 *
 * A channel partner's plan is one allowance across every project it covers,
 * and a developer's plans pool from five projects, so one busy project could
 * use the month for all of them. A limit per project and unit says how much
 * of it that project may use in a month. Nothing set is no limit beyond the
 * plan's own.
 *
 * Relative imports: `check:logic` loads this from source.
 */
import type { Need } from "./billing-rules.ts";

export const CAP_UNITS = ["MINUTE", "IMAGE", "CAROUSEL", "VIDEO"] as const;
export type CapUnit = (typeof CAP_UNITS)[number];
export type Caps = Partial<Record<CapUnit, number>>;

export const CAP_WORDS: Record<CapUnit, { label: string; one: string; many: string }> = {
  MINUTE: { label: "AI call minutes", one: "AI call minute", many: "AI call minutes" },
  IMAGE: { label: "Image posts", one: "image post", many: "image posts" },
  CAROUSEL: { label: "Carousels", one: "carousel", many: "carousels" },
  VIDEO: { label: "Videos", one: "video", many: "videos" },
};

/** The limits form: a whole number for a limit, empty for none. */
export function readCaps(raw: Record<string, unknown>): { ok: true; caps: Caps } | { ok: false; errors: Partial<Record<CapUnit, string>> } {
  const caps: Caps = {};
  const errors: Partial<Record<CapUnit, string>> = {};
  for (const u of CAP_UNITS) {
    const v = String(raw[u] ?? "").replace(/,/g, "").trim();
    if (!v) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) errors[u] = "A whole number, or leave it empty for no limit.";
    else caps[u] = n;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, caps };
}

/**
 * Why a project may not spend what it is asking for, or null. Asked after
 * the plan says yes: a limit only ever narrows what the plan allows.
 */
export function capRefusal(o: { needs: readonly Need[]; caps: Caps; used: Partial<Record<string, number>>; project: string }): string | null {
  for (const n of o.needs) {
    if (n.qty <= 0 || !(CAP_UNITS as readonly string[]).includes(n.unit)) continue;
    const cap = o.caps[n.unit as CapUnit];
    if (cap === undefined) continue;
    const used = o.used[n.unit] ?? 0;
    if (used + n.qty > cap + 1e-9) {
      const w = CAP_WORDS[n.unit as CapUnit];
      return `${o.project} has used the ${cap.toLocaleString("en-IN")} ${cap === 1 ? w.one : w.many} you set for it this month. Change its limit in Settings, Plan and usage.`;
    }
  }
  return null;
}

/** "300 AI call minutes, 10 image posts" for the screen, or null when nothing is set. */
export function capsLine(caps: Caps): string | null {
  const parts = CAP_UNITS.filter((u) => caps[u] !== undefined).map((u) => {
    const n = caps[u]!;
    return `${n.toLocaleString("en-IN")} ${n === 1 ? CAP_WORDS[u].one : CAP_WORDS[u].many}`;
  });
  return parts.length ? parts.join(", ") : null;
}
