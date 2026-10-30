/**
 * The Project Brain, decided without a database.
 *
 * The Brain is one object that the first reply, the voice qualifier, the CP
 * bot, the quote generator and the egress validator all read from. They must
 * not each hold their own copy of the price, because the copy that drifts is
 * the one that reaches a buyer, and under Section 12 a buyer who paid on a
 * misleading advertisement withdraws with refund, interest and compensation.
 * That unwound booking is the exposure, not the Rs 10,000 to Rs 50,000 fine.
 *
 * What lives here is everything that needs no tenant: the field catalog, how
 * a value is parsed and shown, what a group hashes to, which signatures a
 * change invalidates, and whether a draft may go live. `brain.ts` does the
 * reading and writing.
 *
 * Kept database-free so `npm run check:logic` exercises it directly. It is
 * server-side only, because the hash uses `node:crypto`; nothing in the
 * console imports it into the browser.
 */

import { createHash } from "node:crypto";
import type { ScopeKind } from "./roles.ts";

// ---------------------------------------------------------------------------
// The field catalog
// ---------------------------------------------------------------------------

/**
 * Three groups, because the three signatures are three different jobs: what a
 * unit costs, what the authority actually registered, and what may be claimed
 * about the building. One approver for all three is the arrangement the split
 * exists to prevent.
 */
export type FieldGroup = "PRICE" | "RERA" | "CLAIMS";

export const FIELD_GROUPS: {
  key: FieldGroup;
  label: string;
  /**
   * The label as it reads mid-sentence. Written out rather than derived,
   * because lowercasing "RERA facts" gives "rera facts".
   */
  inline: string;
  /** The permission that signs it. Code checks a permission, never a role. */
  approves: string;
  /**
   * Node kinds this group belongs to. Absent means every kind.
   *
   * RERA is the reason this exists: registration attaches to a PHASE, because
   * each phase is a standalone registration under the explanation to Section
   * 3. A project carrying a registration number would be a project claiming
   * something it cannot hold, and asking somebody to type one to get past a
   * required field is asking them to invent it.
   */
  onlyAt?: ScopeKind[];
  detail: string;
}[] = [
  {
    key: "PRICE",
    label: "Price and payment",
    inline: "the price",
    approves: "brain.price:approve",
    detail: "What a unit costs and how it is paid for. Every quote is built from these.",
  },
  {
    key: "RERA",
    label: "RERA facts",
    inline: "the RERA facts",
    approves: "brain.rera:approve",
    onlyAt: ["PHASE"],
    detail:
      "The registration number, the QR and the declared completion date. These are printed on every advertisement.",
  },
  {
    key: "CLAIMS",
    label: "Claims and never-say",
    inline: "the claims",
    approves: "brain.claims:approve",
    detail: "What may be said about the building, and what may never be said.",
  },
];

export type FieldType = "TEXT" | "MONEY" | "DATE" | "LIST" | "PERCENT";

export type FieldDef = {
  key: string;
  group: FieldGroup;
  label: string;
  type: FieldType;
  /**
   * Reference only. NOT rendered beside the field: a console is not the place
   * to explain why a rule exists, and a paragraph under every input is how a
   * form stops being read at all.
   */
  detail: string;
  /** A version cannot be published while a required field is empty. */
  required?: boolean;
  placeholder?: string;
  /**
   * Added to the catalog after Brains were signed. While empty it adds
   * nothing to its group's hash, so adding the field did not void every
   * signature that already stood; once filled it counts like any other.
   */
  addedLater?: boolean;
};

/**
 * The slow facts: versioned and signed. Unit-level inventory is fast and
 * diff-synced, and deliberately not here, because a price list that needs
 * three signatures to change is a price list nobody updates.
 */
export const BRAIN_FIELDS: FieldDef[] = [
  // --- price ---------------------------------------------------------------
  {
    key: "price.base_psf",
    group: "PRICE",
    label: "Base price per sq ft",
    type: "MONEY",
    detail: "The headline rate a quote starts from, before floor rise and charges.",
    required: true,
    placeholder: "e.g. 12000",
  },
  {
    key: "price.booking_amount",
    group: "PRICE",
    label: "Booking amount",
    type: "MONEY",
    detail: "What a buyer pays to block a unit.",
    placeholder: "e.g. 100000",
  },
  {
    key: "price.payment_plan",
    group: "PRICE",
    label: "Payment plan",
    type: "TEXT",
    detail: "The milestone schedule, as it is quoted. 10:80:10, construction linked, and so on.",
    placeholder: "e.g. 10 percent on booking, the rest construction linked",
  },
  {
    key: "price.loan_rate",
    group: "PRICE",
    label: "Indicative home-loan rate",
    type: "PERCENT",
    detail: "The yearly rate a buyer's EMI is worked out at after a visit. Signed like a price, because an EMI is one.",
    placeholder: "e.g. 8.5",
    addedLater: true,
  },
  {
    // The calling agent names these when a buyer asks about a loan
    // (10 October 2026). A bank the project is approved with is a claim the
    // developer makes, so it is signed with the price.
    key: "price.loan_banks",
    group: "PRICE",
    label: "Home-loan tie-ups",
    type: "LIST",
    detail: "One per line: a bank the project is approved with, and any offer it gives buyers here.",
    placeholder: "e.g. HDFC Bank, processing fee waived\nState Bank of India",
    addedLater: true,
  },

  // --- RERA ----------------------------------------------------------------
  {
    key: "rera.registration_no",
    group: "RERA",
    label: "Registration number",
    type: "TEXT",
    detail:
      "As it must appear on the advertisement, no smaller than the largest font used for contact details.",
    required: true,
    placeholder: "e.g. P52100000000",
  },
  {
    key: "rera.qr_url",
    group: "RERA",
    label: "QR target",
    type: "TEXT",
    detail: "The authority page the printed QR code resolves to.",
    placeholder: "e.g. https://maharera.maharashtra.gov.in/...",
  },
  {
    key: "rera.declared_completion",
    group: "RERA",
    label: "Declared completion date",
    type: "DATE",
    detail:
      "The completion date on the filing. Marketing may not promise possession before it.",
    required: true,
    placeholder: "e.g. 31-12-2028",
  },

  // --- claims --------------------------------------------------------------
  // Examples are clearly examples ("e.g.") and clearly invented. A placeholder
  // that reads like a real locality or a real price was taken for a value
  // already set, on a tower that in fact had nothing.
  {
    key: "claims.possession_date",
    group: "CLAIMS",
    label: "Possession date, as marketed",
    type: "DATE",
    detail:
      "The date sales and creative may state. Checked against the declared completion date before anything publishes.",
    placeholder: "e.g. 30-06-2029",
  },
  {
    key: "claims.location",
    group: "CLAIMS",
    label: "Exact location, as advertised",
    type: "TEXT",
    detail:
      "The exact locality the ads print, never the city alone. No ad is made until it is signed.",
    placeholder: "e.g. Riverside East",
    addedLater: true,
  },
  {
    key: "claims.talking_points",
    group: "CLAIMS",
    label: "Talking points",
    type: "LIST",
    detail: "One per line. What the bot and the calling bench may lead with.",
    placeholder: "e.g. Ten minutes from the station\nA garden in the middle",
  },
  {
    key: "claims.amenities",
    group: "CLAIMS",
    label: "Amenities",
    type: "LIST",
    detail: "One per line: what the project has for residents. A calling agent confirms an amenity only when it is here.",
    placeholder: "e.g. Gym\nSwimming pool\nClubhouse",
    addedLater: true,
  },
  {
    // What a locality guide is made of (6 October 2026): its first film had
    // one travel time to say, and filled the rest with the flat.
    key: "claims.nearby",
    group: "CLAIMS",
    label: "Nearby places",
    type: "LIST",
    detail: "One per line: a place near the project and how far it is, as an ad may say it.",
    placeholder: "e.g. Riverside station, 6 minutes\nCity Mall, 10 minutes by car\nGreenfield School, 1 km",
    addedLater: true,
  },
  {
    // A location film prints how its times were found in the small print,
    // as the trade's do ("Travel times as per Google Maps").
    key: "claims.nearby_measured",
    group: "CLAIMS",
    label: "How the travel times were measured",
    type: "TEXT",
    detail: "Printed in a location film's small print.",
    placeholder: "e.g. Google Maps, by car, 12 October 2026",
    addedLater: true,
  },
  {
    key: "claims.never_say",
    group: "CLAIMS",
    label: "Never say",
    type: "LIST",
    detail:
      "One per line. Compiled into egress rules and checked on every outbound message, not pasted into a prompt.",
    placeholder: "e.g. guaranteed returns\nassured rental",
  },
];

export const FIELD_KEYS: ReadonlySet<string> = new Set(BRAIN_FIELDS.map((f) => f.key));

export function fieldByKey(key: string): FieldDef | undefined {
  return BRAIN_FIELDS.find((f) => f.key === key);
}

export function fieldsIn(group: FieldGroup): FieldDef[] {
  return BRAIN_FIELDS.filter((f) => f.group === group);
}

/**
 * The groups that belong to a node of this kind.
 *
 * An exempt phase registers nothing, so it has no RERA facts: no number, no
 * QR and no filed completion date. Asking for them anyway made an exempt tower
 * impossible to publish, because the two required RERA fields could only be
 * filled by inventing a registration, and an invented one is refused at
 * publish. It inherits the project's price and claims like any tower.
 */
export function groupsFor(kind: ScopeKind, exempt = false) {
  return FIELD_GROUPS.filter(
    (g) => (!g.onlyAt || g.onlyAt.includes(kind)) && !(exempt && g.key === "RERA"),
  );
}

/** The fields that belong to a node of this kind. */
export function fieldsFor(kind: ScopeKind, exempt = false): FieldDef[] {
  const groups = new Set(groupsFor(kind, exempt).map((g) => g.key));
  return BRAIN_FIELDS.filter((f) => groups.has(f.group));
}

/** The groups that apply, when the kind may be unknown (the pure checks allow it). */
function applicableGroups(kind: ScopeKind | undefined, exempt = false) {
  return kind ? groupsFor(kind, exempt) : FIELD_GROUPS.filter((g) => !(exempt && g.key === "RERA"));
}

export function groupDef(key: FieldGroup) {
  return FIELD_GROUPS.find((g) => g.key === key)!;
}

/** The permission that signs a group. */
export function approverPermission(group: FieldGroup): string {
  return groupDef(group).approves;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type FieldValues = Record<string, string | null>;

export type ValueResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * Parse one typed value into the canonical text that gets stored.
 *
 * Everything lands in a `text` column, because a fact catalog that grows a
 * column per field is a migration per field. The type lives in the catalog
 * and the parsing lives here, which keeps both testable without Postgres.
 */
export function parseValue(key: string, raw: unknown): ValueResult {
  const def = fieldByKey(key);
  if (!def) return { ok: false, message: `${key} is not a field of the Brain.` };

  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, value: null };

  switch (def.type) {
    case "MONEY": {
      // Indian formatting goes in and comes back out: 1,25,00,000 is a number.
      const digits = text.replace(/[\s,]/g, "").replace(/^(?:Rs\.?|₹)/i, "");
      if (!/^\d+(\.\d{1,2})?$/.test(digits)) {
        return { ok: false, message: `${def.label} should be an amount in rupees.` };
      }
      const n = Number(digits);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, message: `${def.label} should be an amount in rupees.` };
      }
      // Stored without separators so two spellings of the same number hash
      // the same and do not read as a change that needs re-signing.
      return { ok: true, value: String(Math.round(n * 100) / 100) };
    }
    case "PERCENT": {
      const n = Number(text.replace(/\s|%/g, ""));
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(text.replace(/\s|%/g, "")) || !(n > 0 && n <= 30)) {
        return { ok: false, message: `${def.label} should be a rate a year, like 8.5.` };
      }
      return { ok: true, value: String(n) };
    }
    case "DATE": {
      // India writes the day first: 31-12-2029, 31/12/2029, 31.12.2029. Read
      // that too, so a date typed the usual way is not refused.
      const dayFirst = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
      if (dayFirst) {
        const iso = `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}`;
        return parseValue(key, iso);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return { ok: false, message: `${def.label} should be a date, like 31-12-2028.` };
      }
      const d = new Date(`${text}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) {
        return { ok: false, message: `${text} is not a real date.` };
      }
      return { ok: true, value: text };
    }
    case "LIST": {
      const items = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (items.length === 0) return { ok: true, value: null };
      if (items.length > 60) {
        return { ok: false, message: `${def.label} is longer than anyone will read.` };
      }
      return { ok: true, value: items.join("\n") };
    }
    default: {
      if (text.length > 2000) {
        return { ok: false, message: `${def.label} is too long.` };
      }
      return { ok: true, value: text };
    }
  }
}

/** A stored value back as a list. Empty rather than `[""]` for an empty field. */
export function asList(value: string | null | undefined): string[] {
  return (value ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Rs 1,25,00,000. Indian grouping, never the western one. */
export function formatMoney(value: string | null | undefined): string {
  if (!value) return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const whole = Math.floor(n);
  const s = String(whole);
  // Last three digits, then pairs, which is what makes it lakhs and crores.
  const head = s.slice(0, -3);
  const tail = s.slice(-3);
  const grouped = head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail : tail;
  return `Rs ${grouped}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * 30 June 2029. A stored date is ISO so it sorts and compares; a person reads
 * it the way the rest of the console writes a date. Anything that is not a
 * date comes back as it was.
 */
export function showDate(value: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((value ?? "").trim());
  if (!m || !MONTHS[Number(m[2]) - 1]) return value ?? "";
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** A stored value as a person reads it: rupees grouped, dates written out. */
export function showValue(def: FieldDef, value: string | null | undefined): string {
  if (!value) return "";
  if (def.type === "MONEY") return formatMoney(value);
  if (def.type === "DATE") return showDate(value);
  if (def.type === "PERCENT") return `${value}% a year`;
  return value;
}

// ---------------------------------------------------------------------------
// Hashing a group, so a signature can go stale
// ---------------------------------------------------------------------------

/**
 * A stable rendering of one group's values.
 *
 * Canonical on purpose: keys in catalog order, an absent field and an empty
 * one written the same way, lengths prefixed so two fields cannot be made to
 * look like one. Two sets of values that mean the same thing must hash the
 * same, or a signature would expire every time somebody retyped a number.
 */
export function canonicalGroup(group: FieldGroup, values: FieldValues): string {
  return fieldsIn(group)
    .flatMap((f) => {
      const v = values[f.key];
      const text = v === null || v === undefined ? "" : v;
      if (f.addedLater && !text) return [];
      return [`${f.key}:${text.length}:${text}`];
    })
    .join("\n");
}

export function groupHash(group: FieldGroup, values: FieldValues): string {
  return createHash("sha256").update(canonicalGroup(group, values)).digest("hex");
}

// ---------------------------------------------------------------------------
// Which signatures still stand
// ---------------------------------------------------------------------------

export type Signature = {
  group: FieldGroup;
  groupHash: string;
  signedBy: string;
  signedByName: string | null;
  signedAt: string;
};

export type GroupState = {
  group: FieldGroup;
  label: string;
  /** Hash of what is in the draft right now. */
  hash: string;
  /** Signed, and signed against exactly these values. */
  signed: boolean;
  /** Signed, but against different values: somebody edited it afterwards. */
  stale: boolean;
  /** No change from the live version, so the existing sign-off carries over. */
  unchanged: boolean;
  signature: Signature | null;
  /** Whether this group must be signed before the draft may be published. */
  required: boolean;
};

/**
 * The state of every group in a draft.
 *
 * `published` is the values of the live version, and it is what makes
 * "signatures follow the diff" real: a group identical to the live one needs
 * no new signature, because nobody is being asked to attest to anything new.
 * A group that changed needs one, and a group that was signed and then edited
 * needs another.
 */
export function groupStates(opts: {
  draft: FieldValues;
  published?: FieldValues | null;
  signatures: readonly Signature[];
  /** Which groups apply. A project has no RERA facts to sign. */
  nodeKind?: ScopeKind;
  /** An exempt phase has none either. */
  exempt?: boolean;
}): GroupState[] {
  const published = opts.published ?? null;
  const groups = applicableGroups(opts.nodeKind, opts.exempt);

  return groups.map((g) => {
    const hash = groupHash(g.key, opts.draft);
    const forGroup = opts.signatures.filter((s) => s.group === g.key);
    // The signature that counts is the one attesting to what is there NOW,
    // not the most recent one. Edit a signed group and put it back, and the
    // original signature applies again: that person did sign these values.
    const signature = forGroup.find((s) => s.groupHash === hash) ?? null;
    const signed = signature !== null;
    const stale = signature === null && forGroup.length > 0;
    const unchanged = published !== null && groupHash(g.key, published) === hash;

    return {
      group: g.key,
      label: g.label,
      hash,
      signed,
      stale,
      unchanged,
      signature,
      // The first version needs every group signed, because nothing has been
      // attested before. After that, only what changed.
      required: !unchanged && !signed,
    };
  });
}

// ---------------------------------------------------------------------------
// May this group be signed at all
// ---------------------------------------------------------------------------

export type SignCheck =
  | { ok: true }
  | { ok: false; code: "REQUIRED_EMPTY"; message: string };

/**
 * Refuse to take a signature over an empty required field.
 *
 * This is a net under the screen rather than a rule about it. The console let
 * somebody type a price, click sign, and have the signature taken against the
 * last SAVED values, which on a fresh draft were none: three groups signed,
 * nothing recorded, and a signature indistinguishable from a real one. The
 * form was fixed, but a rule that only holds while the markup is arranged a
 * particular way is not a rule.
 *
 * A group with no required fields may be signed empty, and that is deliberate:
 * signing off "there are no special claims" is a real statement.
 *
 * `inherited` is what the nodes above already publish. A tower that takes the
 * project's price has a price: the field is empty on the tower because the
 * answer is the project's, which was signed there. Asking the tower to type
 * it again is how two copies of one price come to disagree.
 */
export function canSignGroup(
  group: FieldGroup,
  values: FieldValues,
  inherited?: FieldValues | null,
): SignCheck {
  const missing = fieldsIn(group).filter(
    (f) => f.required && !values[f.key] && !inherited?.[f.key],
  );
  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    code: "REQUIRED_EMPTY",
    message: `${missing.map((f) => f.label).join(", ")} ${
      missing.length === 1 ? "is" : "are"
    } still empty, so there is nothing to sign.`,
  };
}

// ---------------------------------------------------------------------------
// May this draft go live
// ---------------------------------------------------------------------------

export type PublishRefusal =
  | "NOTHING_TO_PUBLISH"
  | "FIELD_REQUIRED"
  | "UNSIGNED"
  | "POSSESSION_BEFORE_COMPLETION"
  | "REGISTRATION_MISMATCH"
  | "REGISTRATION_UNFILED";

export type PublishCheck =
  | { ok: true; changed: FieldGroup[] }
  | { ok: false; code: PublishRefusal; message: string };

/**
 * Everything that can be decided about publishing without asking the tenant.
 *
 * What is NOT here is the phase being advertisable, which needs the
 * registration record and therefore a database. `publishBrain` asks
 * `canPublish()` for that, and this function for the rest.
 */
export function canPublishDraft(opts: {
  draft: FieldValues;
  published?: FieldValues | null;
  signatures: readonly Signature[];
  /** Which groups apply. A project is not asked for a registration number. */
  nodeKind?: ScopeKind;
  /** An exempt phase is not asked for one either. */
  exempt?: boolean;
  /**
   * What the nodes above publish, merged. A required field the project
   * already answers is answered, and a marketed possession date the tower
   * inherits is still measured against the tower's own filing.
   */
  inherited?: FieldValues | null;
}): PublishCheck {
  const states = groupStates(opts);
  const changed = states.filter((s) => !s.unchanged).map((s) => s.group);
  const groups = new Set(applicableGroups(opts.nodeKind, opts.exempt).map((g) => g.key));
  const applicable = BRAIN_FIELDS.filter((f) => groups.has(f.group));
  const effective = withInherited(opts.inherited, opts.draft);

  if (changed.length === 0) {
    return {
      ok: false,
      code: "NOTHING_TO_PUBLISH",
      message: "This draft is identical to the live version.",
    };
  }

  // A required field cannot be signed away by leaving it blank. One the
  // project already answers is answered.
  const missing = applicable.filter((f) => f.required && !effective[f.key]);
  if (missing.length) {
    return {
      ok: false,
      code: "FIELD_REQUIRED",
      message: `${missing.map((f) => f.label).join(", ")} must be filled in before this can go live.`,
    };
  }

  const unsigned = states.filter((s) => s.required);
  if (unsigned.length) {
    const stale = unsigned.filter((s) => s.stale);
    return {
      ok: false,
      code: "UNSIGNED",
      message: stale.length
        ? `${stale.map((s) => s.label).join(", ")} changed after being signed, so it needs signing again.`
        : `${unsigned.map((s) => s.label).join(", ")} still needs signing.`,
    };
  }

  const possession = possessionBeforeCompletion(effective, opts);
  if (!possession.ok) return possession;

  return { ok: true, changed };
}

/**
 * The values a node's advertisements actually carry: its own, over what the
 * nodes above publish. The same merge `resolveBrain()` does, for one node's
 * draft against its ancestors.
 */
export function withInherited(
  inherited: FieldValues | null | undefined,
  own: FieldValues,
): FieldValues {
  if (!inherited) return own;
  return mergeInherited([
    { path: "above", values: inherited },
    { path: "above.here", values: own },
  ]);
}

export type PossessionCheck =
  | { ok: true }
  | { ok: false; code: "POSSESSION_BEFORE_COMPLETION"; message: string };

/**
 * The cross-group rule, and the reason marketing possession is a CLAIM rather
 * than a RERA fact: it is the brand approver's promise measured against the
 * compliance officer's filing.
 *
 * `values` is the node's own draft over what it inherits (`withInherited()`),
 * because an advertisement for a tower prints the project's possession date
 * when the tower sets none. Measuring only the tower's own draft let exactly
 * that date through.
 *
 * Only where there is a filing: a project, or an exempt tower, states a
 * marketed possession date and holds nothing to measure it against.
 */
export function possessionBeforeCompletion(
  values: FieldValues,
  opts: { nodeKind?: ScopeKind; exempt?: boolean } = {},
): PossessionCheck {
  const filed = applicableGroups(opts.nodeKind, opts.exempt).some((g) => g.key === "RERA");
  const promised = values["claims.possession_date"];
  const declared = filed ? values["rera.declared_completion"] : null;
  if (promised && declared && promised < declared) {
    return {
      ok: false,
      code: "POSSESSION_BEFORE_COMPLETION",
      message: `Possession as marketed (${showDate(promised)}) is before the completion date on the registration (${showDate(declared)}).`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Does the Brain name the registration the phase actually holds
// ---------------------------------------------------------------------------

/**
 * A registration number as it is held, rather than as it was typed.
 *
 * Spacing and case are how the same number is written by two people, and
 * neither is part of the number.
 */
export function normaliseRegistration(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

export type FilingCheck =
  | { ok: true }
  | { ok: false; code: PublishRefusal; message: string };

/**
 * The registration number on the advertisement is the one on the filing.
 *
 * The publish gate answers whether a phase may be advertised at all. It does
 * not answer whether the Brain names the filing that permission came from,
 * and those are different questions: a phase registered as P52100012345 can
 * be perfectly advertisable while its Brain prints P52100099999 on every
 * hoarding, quote and portal listing. That number is what a buyer checks the
 * project against, so a wrong one is a misrepresentation on otherwise lawful
 * advertising, and no signature catches it because the person signing has no
 * way to see the record from the form.
 *
 * Kept out of `canPublishDraft` because the filing comes from the tenant,
 * and passed in rather than read here so this stays database-free.
 */
export function matchesFiling(opts: {
  draft: FieldValues;
  /** The number on the phase's record. Null where it holds none. */
  filed: string | null;
  /** Which groups apply. A project states no registration, so nothing to check. */
  nodeKind?: ScopeKind;
  /** Nor does an exempt phase: it prints no number at all. */
  exempt?: boolean;
}): FilingCheck {
  const applies = applicableGroups(opts.nodeKind, opts.exempt).some((g) => g.key === "RERA");
  if (!applies) return { ok: true };

  const typed = (opts.draft["rera.registration_no"] ?? "").trim();
  // Emptiness belongs to the required-field rule. Answering it twice would
  // report a mismatch for a field nobody filled in.
  if (!typed) return { ok: true };

  const filed = normaliseRegistration(opts.filed);
  if (!filed) {
    return {
      ok: false,
      code: "REGISTRATION_UNFILED",
      message: `This phase has no registration number on file, so it cannot state ${typed}.`,
    };
  }

  if (normaliseRegistration(typed) !== filed) {
    return {
      ok: false,
      code: "REGISTRATION_MISMATCH",
      message: `This phase is registered as ${opts.filed}, not ${typed}. Every advertisement carries this number, so correct it.`,
    };
  }

  return { ok: true };
}

/**
 * Facts from several nodes collapsed into one answer, deepest node winning.
 *
 * A price on the project applies to every tower under it; a tower that sets
 * its own overrides it. Ordering is the caller's job, because only the
 * database knows how deep each node is.
 */
export function mergeInherited(
  layers: readonly { path: string; values: FieldValues }[],
): FieldValues {
  const depth = (p: string) => p.split(".").length;
  const merged: FieldValues = {};
  for (const layer of [...layers].sort((a, b) => depth(a.path) - depth(b.path))) {
    for (const [k, v] of Object.entries(layer.values)) {
      // An empty value at a deeper node does not erase an inherited one. It
      // is a field nobody filled in, not an instruction to forget.
      if (v === null || v === undefined || v === "") continue;
      // A list ADDS down the tree. The project's "Eight minutes from Goregaon
      // station" is true of every tower, and a tower listing its own sea view
      // used to hide it, so the first live ad never said where the project
      // was. The never-say list is the sharper half: a tower with one phrase
      // of its own used to drop every phrase the project had banned.
      if (fieldByKey(k)?.type === "LIST" && merged[k]) {
        const seen = new Set(asList(merged[k]).map((x) => x.toLowerCase()));
        const extra = asList(v).filter((x) => !seen.has(x.toLowerCase()));
        if (extra.length) merged[k] = [merged[k], ...extra].join("\n");
        continue;
      }
      merged[k] = v;
    }
  }
  return merged;
}

/** What a node takes from the nodes above it, and from which one. */
export type InheritedBrain = {
  /** Merged, exactly as `mergeInherited()` would answer for these layers. */
  values: FieldValues;
  /** For a field of one value: the name of the node it came from. */
  from: Record<string, string>;
  /** For a list: every line, in order, with the node that added it. */
  lines: Record<string, { text: string; from: string }[]>;
};

/**
 * The published facts of a node's ancestors, said with where each came from.
 *
 * A tower's own Brain showed only the tower's own values, so a price the
 * project set read "Not set" and the editor offered a catalog example in its
 * place, which looked like a value somebody had typed. The screen needs the
 * inherited answer and its source; the merge is the one every consumer uses,
 * so what the screen says is inherited is what an advertisement prints.
 */
export function inheritedFrom(
  layers: readonly { path: string; name: string; values: FieldValues }[],
): InheritedBrain {
  const depth = (p: string) => p.split(".").length;
  const sorted = [...layers].sort((a, b) => depth(a.path) - depth(b.path));
  const from: Record<string, string> = {};
  const lines: Record<string, { text: string; from: string }[]> = {};
  for (const layer of sorted) {
    for (const [k, v] of Object.entries(layer.values)) {
      const def = fieldByKey(k);
      if (!def || v === null || v === undefined || v === "") continue;
      if (def.type === "LIST") {
        const have = lines[k] ?? [];
        const seen = new Set(have.map((l) => l.text.toLowerCase()));
        for (const text of asList(v)) {
          if (seen.has(text.toLowerCase())) continue;
          seen.add(text.toLowerCase());
          have.push({ text, from: layer.name });
        }
        lines[k] = have;
      } else {
        from[k] = layer.name;
      }
    }
  }
  return { values: mergeInherited(sorted), from, lines };
}
