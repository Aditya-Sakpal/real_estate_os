/**
 * What stands between a tower and a lawful advertisement.
 *
 * The console is organised by system concept: projects here, the Brain there,
 * the library somewhere else, campaigns last. A marketing head does not think
 * in those terms. They think "can Tower C go out this week", and answering it
 * meant opening five sections in an order nobody wrote down.
 *
 * This is that order, written down. Six gates per phase, each one derived
 * from state that already exists, each one carrying the place that clears it
 * and the permission that may. Nothing here reads a database: `readiness.ts`
 * gathers the facts, this decides what they mean, and `check:logic` covers it
 * the way `brain-rules.ts` and `campaign-rules.ts` are covered.
 *
 * The order is the order a real push is assembled in. Registration first,
 * because a phase nobody may advertise has nothing lawful to say. Then the
 * facts, because everything after quotes them. Then identity, price and
 * pictures, which are what a creative is assembled out of. The brief last,
 * because it is the instruction and not the material.
 */

export type GateKey =
  | "registered"
  | "facts"
  | "brand"
  | "price"
  | "picture"
  | "brief";

/**
 * `blocked` is not a worse `todo`. It means this gate refuses publishing
 * outright rather than leaving the work unfinished, and only registration
 * does that: the rest are gaps, and a gap is filled by whoever holds the key.
 */
export type GateState = "done" | "blocked" | "todo";

export type GateFacts = {
  /** The RERA gate's answer for this phase. */
  advertisable: boolean;
  /** Live Brain version at the phase, or null. Inherited does not count for a
   *  registered phase: the RERA group only exists at a phase, so it needs its
   *  own. */
  brainPublished: number | null;
  brainDraft: number | null;
  /** An exempt phase registers nothing, so it has no RERA facts of its own
   *  to sign and may advertise on what the project publishes. */
  exempt?: boolean;
  /** A node above the phase (the project, usually) has a live Brain. */
  brainInherited?: boolean;
  /** Missing brand fields resolving at the phase. */
  brandGaps: number;
  /** Configurations whose current numbers carry an approval. */
  approvedUnits: number;
  /** Assets whose current bytes carry an approval, resolved at the phase. */
  approvedAssets: number;
  /** Briefs marked ready on the phase or the project above it. */
  readyBriefs: number;
};

export type GateIds = { projectId: string; phaseId: string };

export type Gate = {
  key: GateKey;
  /** 1 to 6, so a person can say "stuck at three". */
  n: number;
  /** What the gate is. Two words, so six of them fit on one row. */
  label: string;
  state: GateState;
  /** The current state in the person's own words. Never a reason, never a
   *  rule: a screen says what is so, not why the rule exists. */
  detail: string;
  /** What pressing it does, written as the thing that will happen. */
  action: string;
  href: string;
  /** Any one of these clears it. Somebody holding none sees it read-only. */
  anyOf: string[];
};

export const GATE_COUNT = 6;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The six gates for one phase, in order, with their current state.
 *
 * Every gate is answered independently. An unregistered phase still reports
 * that its price is approved, because the work is real and losing it off the
 * screen would mean doing it twice.
 */
export function gatesFor(facts: GateFacts, ids: GateIds): Gate[] {
  const project = `/dashboard/projects/${ids.projectId}`;
  // An exempt tower with nothing of its own speaks with the project's facts,
  // which is what every advertisement for it resolves to.
  const inheritsFacts = !facts.brainPublished && !!facts.exempt && !!facts.brainInherited;
  const factsDone = !!facts.brainPublished || inheritsFacts;

  return [
    {
      key: "registered",
      n: 1,
      label: "Registered",
      state: facts.advertisable ? "done" : "blocked",
      detail: facts.advertisable ? "Clear to advertise" : "Cannot be advertised",
      action: facts.advertisable ? "Open the project" : "Record the registration",
      // Not advertisable opens the project's registration form on this tower.
      href: facts.advertisable ? project : `${project}?register=${ids.phaseId}#register`,
      anyOf: ["rera:manage"],
    },
    {
      key: "facts",
      n: 2,
      label: "Facts signed",
      state: factsDone ? "done" : "todo",
      detail: facts.brainPublished
        ? `Version ${facts.brainPublished} live`
        : inheritsFacts
          ? "Uses the project's facts"
          : facts.brainDraft
            ? `Draft ${facts.brainDraft}, not published`
            : "Nothing published",
      action: factsDone
        ? "Open the Brain"
        : facts.brainDraft
          ? "Finish the draft"
          : "Start the Brain",
      href: `/dashboard/brain/${ids.phaseId}`,
      anyOf: ["brain:edit", "brain.price:approve", "brain.rera:approve", "brain.claims:approve"],
    },
    {
      key: "brand",
      n: 3,
      label: "Branded",
      state: facts.brandGaps === 0 ? "done" : "todo",
      detail:
        facts.brandGaps === 0
          ? "Logo and contact details set"
          : `${plural(facts.brandGaps, "thing", "things")} missing`,
      action: facts.brandGaps === 0 ? "Open branding" : "Add the branding",
      href: "/dashboard/library/branding",
      anyOf: ["brand:manage"],
    },
    {
      key: "price",
      n: 4,
      label: "Priced",
      state: facts.approvedUnits > 0 ? "done" : "todo",
      detail:
        facts.approvedUnits > 0
          ? `${plural(facts.approvedUnits, "configuration", "configurations")} approved`
          : "No approved configuration",
      action: facts.approvedUnits > 0 ? "Open the library" : "Add a configuration",
      href: `/dashboard/library/${ids.phaseId}`,
      anyOf: ["unit:manage", "brain.price:approve"],
    },
    {
      key: "picture",
      n: 5,
      label: "Pictured",
      state: facts.approvedAssets > 0 ? "done" : "todo",
      detail:
        facts.approvedAssets > 0
          ? `${plural(facts.approvedAssets, "asset", "assets")} approved`
          : "No approved asset",
      action: facts.approvedAssets > 0 ? "Open the library" : "Add an asset",
      href: `/dashboard/library/${ids.phaseId}`,
      anyOf: ["asset:manage", "asset:approve"],
    },
    {
      key: "brief",
      n: 6,
      label: "Briefed",
      state: facts.readyBriefs > 0 ? "done" : "todo",
      detail:
        facts.readyBriefs > 0
          ? `${plural(facts.readyBriefs, "brief", "briefs")} ready`
          : "No brief ready",
      action: facts.readyBriefs > 0 ? "Open campaigns" : "Write a brief",
      href: `/dashboard/campaigns/${ids.phaseId}`,
      anyOf: ["campaign:manage"],
    },
  ];
}

export type Readiness = {
  gates: Gate[];
  done: number;
  total: number;
  /** The first gate not done, which is the one thing to do next. Null when
   *  every gate is clear. */
  next: Gate | null;
  /** True only when all six are done. "Advertisable" and "ready to advertise"
   *  are different questions and this is the second one. */
  ready: boolean;
  /** True when the RERA gate refuses. Kept separate because it is the only
   *  state that makes the remaining work unusable rather than unfinished. */
  blocked: boolean;
};

export function readinessOf(gates: readonly Gate[]): Readiness {
  const done = gates.filter((g) => g.state === "done").length;
  return {
    gates: [...gates],
    done,
    total: gates.length,
    next: gates.find((g) => g.state !== "done") ?? null,
    ready: done === gates.length,
    blocked: gates.some((g) => g.state === "blocked"),
  };
}

export function readinessFor(facts: GateFacts, ids: GateIds): Readiness {
  return readinessOf(gatesFor(facts, ids));
}

/**
 * Can this viewer clear this gate themselves.
 *
 * A gate they cannot clear is still shown, because knowing the push is stuck
 * on a price is worth having even when somebody else signs it. It reads as
 * state rather than as an offer.
 */
export function canClear(gate: Gate, can: (perm: string) => boolean): boolean {
  return gate.anyOf.some(can);
}

/**
 * One line for a rail badge or a queue row.
 *
 * Deliberately not a percentage. "4 of 6" names a countable thing somebody
 * can act on; "67 per cent" is a number with no next step in it.
 */
export function readinessLabel(r: Readiness): string {
  if (r.ready) return "Ready to advertise";
  if (r.blocked) return "Blocked";
  return `${r.done} of ${r.total}`;
}
