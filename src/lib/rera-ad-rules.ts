/**
 * What an advertisement must carry about its registration, state by state.
 *
 * Section 11(2) puts the registration number and the Authority's website on
 * every advertisement everywhere. How is each authority's own business, and
 * they differ in ways that move pixels: Maharashtra wants the number, the
 * website and a QR in the upper-right quarter at least as large as the
 * phone; West Bengal wants them in a strip along the bottom and no QR;
 * Tamil Nadu forbids travel times and "T&C apply"; Telangana wants the local
 * authority's building permit number beside the registration.
 *
 * So these are data, read by everything that prints a registration: the
 * compositor, the reel and film overlays, the caption, the enquiry page, the
 * copy gate and the design check. Nothing that prints one may name a state.
 *
 * Pure and client-safe. `doc/rera-states.md` has the order behind each row.
 */

import { stateRule } from "./rera-rules.ts";

export type AdRule = {
  state: string;
  /** The authority's short name, as it prints ("MahaRERA"). */
  authority: string;
  /** The line the number is printed after, on the picture and in a caption. */
  label: string;
  /** The same, short, for the panel beside a QR. */
  shortLabel: string;
  /** The Authority's website, printed beside the number. */
  website: string;
  /**
   * Every host the Authority serves a project's page from, the website's
   * first. A QR on a lockup that opens anywhere else does not point at the
   * Authority.
   */
  hosts: string[];
  /**
   * REQUIRED: an ad is not made without the approved QR. WHERE_HELD: the QR
   * is printed when the library holds an approved one and the ad is made
   * without it otherwise, because the state asks for none.
   */
  qr: "REQUIRED" | "WHERE_HELD";
  /**
   * TOP_RIGHT: the number, the website and the QR in the upper-right
   * quarter. Maharashtra's quadrant, and it also satisfies every state that
   * says top right, top half or "prominently". BOTTOM_STRIP: West Bengal's
   * strip along the foot, at least 8 per cent of the area.
   */
  placement: "TOP_RIGHT" | "BOTTOM_STRIP";
  /**
   * What the registration's type is measured against. CONTACT is built in
   * everywhere (the number is always set a step above the contact line), so
   * it holds for every state; the project-name rules are recorded, and the
   * pixel gate does not measure a project's name yet.
   */
  size: "CONTACT" | "PROJECT_NAME_HALF" | "PROJECT_NAME_THIRD" | "NONE";
  /** Tamil Nadu and Goa: a distance may be given, a travel time may not. */
  noTravelTime: boolean;
  /** Tamil Nadu and Goa: no "T&C apply" or "terms and conditions apply". */
  noTermsApply: boolean;
  /** Tamil Nadu and Goa: the promoter's name and office address on the ad. */
  namePromoter: boolean;
  /** Telangana: the local authority's building permit number beside it. */
  permitNo: boolean;
  /** The order this row follows. */
  source: string;
};

type Row = Partial<AdRule> & Pick<AdRule, "website" | "source">;

const ROWS: Record<string, Row> = {
  MH: {
    website: "maharera.maharashtra.gov.in",
    hosts: ["maharera.maharashtra.gov.in", "www.maharera.maharashtra.gov.in", "maharera.mahaonline.gov.in", "maharerait.maharashtra.gov.in"],
    qr: "REQUIRED",
    size: "CONTACT",
    source: "MahaRERA Order 46C/2025 of 8 April 2025",
  },
  GJ: {
    website: "gujrera.gujarat.gov.in",
    qr: "REQUIRED",
    size: "CONTACT",
    source: "GujRERA Circular 18/2020 of 4 January 2020 and Order 108 of 19 May 2025",
  },
  KA: {
    website: "rera.karnataka.gov.in",
    size: "PROJECT_NAME_HALF",
    source: "K-RERA Circular RERA/ADM/CR-4/2019-20 of 14 November 2019",
  },
  TN: {
    website: "rera.tn.gov.in",
    qr: "REQUIRED",
    noTravelTime: true,
    noTermsApply: true,
    namePromoter: true,
    source: "TNRERA Proc. TNRERA/A3/1840/2026 of 16 June 2026, clarified 3 July 2026",
  },
  HR: {
    website: "haryanarera.gov.in",
    source: "HARERA Gurugram Direction 3 of 2021, 22 February 2021",
  },
  UP: {
    website: "up-rera.in",
    hosts: ["up-rera.in", "www.up-rera.in"],
    qr: "REQUIRED",
    source: "UP RERA press note of 19 July 2024; notifications 5257 and 8603 of 2025",
  },
  DL: {
    website: "rera.delhi.gov.in",
    source: "Delhi RERA Guidelines Revised-1/2023 of 1 June 2023, clause 15(4)",
  },
  WB: {
    website: "rera.wb.gov.in",
    placement: "BOTTOM_STRIP",
    size: "PROJECT_NAME_THIRD",
    source: "WBRERA Order 1519-RERA/L-01/2023 of 25 July 2024",
  },
  TG: {
    website: "rera.telangana.gov.in",
    hosts: ["rera.telangana.gov.in", "rerait.telangana.gov.in"],
    size: "CONTACT",
    permitNo: true,
    source: "TGRERA Section 37 public notice of 17 May 2024, reissued 15 September 2025",
  },
  RJ: {
    // Required, except on hoardings and social media (July 2025), so the ad
    // prints it where the library holds one and is not refused without it.
    website: "rera.rajasthan.gov.in",
    source: "RajRERA order of 22 May 2025, modified July 2025",
  },
  AP: {
    website: "rera.ap.gov.in",
    source: "APRERA advertisement guidelines, Annexure-I",
  },
  GA: {
    website: "rera.goa.gov.in",
    noTravelTime: true,
    noTermsApply: true,
    namePromoter: true,
    source: "Goa RERA Circular F.No.1/RERA/Circulars/2019/1032 of 7 August 2025",
  },
  KL: {
    website: "rera.kerala.gov.in",
    qr: "REQUIRED",
    source: "K-RERA/T3/2127/2023 of 19 August 2023",
  },
  MP: { website: "rera.mp.gov.in", source: "Section 11(2) of the Act" },
  PB: { website: "rera.punjab.gov.in", source: "Section 11(2) of the Act" },
};

/**
 * The rule for a state, or null for a state nothing here knows. A caller
 * with a registration and no rule has nothing lawful to print, and says so
 * rather than printing Maharashtra's.
 */
export function adRuleFor(stateCode: string | null | undefined): AdRule | null {
  if (!stateCode) return null;
  const code = stateCode.toUpperCase();
  const row = ROWS[code];
  const state = stateRule(code);
  if (!row || !state) return null;
  return {
    state: code,
    authority: state.authority,
    label: row.label ?? `${state.authority} Reg. No.`,
    shortLabel: row.shortLabel ?? `${state.authority} No.`,
    website: row.website,
    hosts: row.hosts ?? [row.website, `www.${row.website}`],
    qr: row.qr ?? "WHERE_HELD",
    placement: row.placement ?? "TOP_RIGHT",
    size: row.size ?? "NONE",
    noTravelTime: row.noTravelTime ?? false,
    noTermsApply: row.noTermsApply ?? false,
    namePromoter: row.namePromoter ?? false,
    permitNo: row.permitNo ?? false,
    source: row.source,
  };
}

/** Every state an advertisement can be made for. */
export const AD_STATES = Object.keys(ROWS);

/**
 * Every label any state prints, for the design check's list of words a
 * picture may carry that are not the copy.
 */
export function allRegistrationLabels(): string[] {
  const out = new Set<string>(["Registration No.", "Reg. No.", "RERA Reg. No.", "RERA No."]);
  for (const code of AD_STATES) {
    const r = adRuleFor(code);
    if (!r) continue;
    out.add(r.authority);
    out.add(r.label);
    out.add(r.shortLabel);
    out.add(`${r.authority} Registration No.`);
  }
  return [...out];
}

/** The line a caption or a page carries: the short label, the number, the website. */
export function adRegistrationLine(rule: AdRule, registrationNo: string, permitNo?: string | null): string {
  const permit = rule.permitNo && permitNo ? ` | Permit No. ${permitNo}` : "";
  return `${rule.shortLabel} ${registrationNo}${permit} | ${rule.website}`;
}

// ---------------------------------------------------------------------------
// What the copy may not say
// ---------------------------------------------------------------------------

/**
 * A travel time: "8 min from", "10 minutes to", "half an hour away", "2 hrs
 * drive". Tamil Nadu and Goa allow a distance and forbid this, because a
 * time depends on traffic nobody can promise.
 */
const TRAVEL_TIME =
  /\b(\d+(?:\.\d+)?|a|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|half\s+an?)\s*[- ]?\s*(min|mins|minute|minutes|hr|hrs|hour|hours)\b/i;

/** "T&C apply", "terms and conditions apply", "T & C". */
const TERMS_APPLY = /\bT\s*&\s*C\b|\bterms\s*(?:&|and)\s*conditions\b/i;

export function hasTravelTime(text: string): boolean {
  return TRAVEL_TIME.test(text);
}

export function hasTermsApply(text: string): boolean {
  return TERMS_APPLY.test(text);
}

/** A price footnote with any "T&C apply" taken out, for a state that bans it. */
export function withoutTermsApply(note: string): string {
  return note
    .replace(/\s*\bT\s*&\s*C\s+apply\.?/gi, "")
    .replace(/\s*\bterms\s*(?:&|and)\s*conditions\s+apply\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// A firm's own advertisements: its agent registration beside the project's
// ---------------------------------------------------------------------------

/**
 * A mandate firm or a channel partner advertising from its own console is a
 * real-estate agent advertising, and an agent's advertisement carries the
 * agent's own registration number beside the project's (Rule 14(2) of the
 * Maharashtra rules). A developer's ad carries none: the developer is the
 * promoter, not an agent.
 */
export const AGENT_LABEL = "Agent RERA No.";

/** The kinds of company whose own ads are an agent's. */
export const AGENT_ORG_TYPES = ["MANDATE_FIRM", "CHANNEL_PARTNER"] as const;

export function isAgentOrg(orgType: string | null | undefined): boolean {
  return (AGENT_ORG_TYPES as readonly string[]).includes(orgType ?? "");
}

/**
 * The line an agent's ad prints and its caption carries: "Agent RERA No.
 * A51800012345", led by whose ad it is ("Marketed by Skyline Realty.") when
 * the seller is named. A seller's ad often carries the developer's or the
 * project's logo from its kit, so this is where the seller itself is named.
 */
export function agentLine(agentNo: string, seller?: string | null): string {
  const line = `${AGENT_LABEL} ${agentNo.replace(/\s+/g, "").toUpperCase()}`;
  const name = (seller ?? "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return name ? `Marketed by ${name}. ${line}` : line;
}

export type AgentOnAds =
  | { ok: true; agentNo: string | null }
  | { ok: false; code: "NO_AGENT_RERA"; message: string };

const AGENT_NO = /^A\d{11}$/;

const shortDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/**
 * What a company's own ads print about it as an agent, or why none may be
 * made. A developer prints nothing and is never refused here. A firm prints
 * its recorded agent number, and only while it is current: a number with no
 * end date recorded is not known to be current, the rule a buyer's
 * registration with a developer already follows.
 */
export function agentOnAds(
  i: { orgType: string | null | undefined; reraNo: string | null | undefined; reraTill: string | null | undefined },
  today: string,
): AgentOnAds {
  if (!isAgentOrg(i.orgType)) return { ok: true, agentNo: null };
  const no = (i.reraNo ?? "").replace(/\s+/g, "").toUpperCase();
  if (!AGENT_NO.test(no)) {
    return {
      ok: false,
      code: "NO_AGENT_RERA",
      message: "Your MahaRERA agent registration is not recorded, and every ad of yours carries it. Add it in Settings, Your firm.",
    };
  }
  const till = (i.reraTill ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(till)) {
    return {
      ok: false,
      code: "NO_AGENT_RERA",
      message: "Record when your MahaRERA agent registration ends, in Settings, Your firm. Every ad of yours carries it.",
    };
  }
  if (till < today) {
    return {
      ok: false,
      code: "NO_AGENT_RERA",
      message: `Your MahaRERA agent registration lapsed on ${shortDay(till)}. Renew it and record the new date in Settings, Your firm.`,
    };
  }
  return { ok: true, agentNo: no };
}

/**
 * Whether a made ad still carries the right agent number. A developer's is
 * never stale on this account. A firm's must print the number current
 * today: one made before the number was recorded, or under a number since
 * replaced, is made again rather than published.
 */
export function agentStale(printed: string | null | undefined, current: string | null): string | null {
  if (current === null) return null;
  if ((printed ?? "").replace(/\s+/g, "").toUpperCase() === current) return null;
  return "This post does not carry your current MahaRERA agent registration. Make it again.";
}

/** The agent line as the small print carries it, ahead of the rest. */
export function withAgentLine(small: string | null, agentNo: string | null | undefined, seller?: string | null): string | null {
  if (!agentNo) return small;
  return [`${agentLine(agentNo, seller)}.`, small].filter(Boolean).join(" ");
}
