/**
 * Deleting a project or a tower: the pure half.
 *
 * Delete is for a project or tower made by mistake or never used. Anything
 * that reached a buyer, a partner or an invoice is kept, by the database
 * (its foreign keys refuse) and here first, so the screen can say why and
 * offer Retire instead. Everything else the node holds (its Brain, pictures,
 * briefs, posts not published, flat types, settings) goes with it.
 */

export type DeleteKind = "PROJECT" | "PHASE";

/** What under a node keeps it from being deleted, counted. */
export type DeleteBlockers = {
  leads: number;
  calls: number;
  visits: number;
  quotes: number;
  published: number;
  broadcasts: number;
  plans: number;
  numbers: number;
  partners: number;
  mandates: number;
  outside: number;
};

export const NO_BLOCKERS: DeleteBlockers = {
  leads: 0,
  calls: 0,
  visits: 0,
  quotes: 0,
  published: 0,
  broadcasts: 0,
  plans: 0,
  numbers: 0,
  partners: 0,
  mandates: 0,
  outside: 0,
};

const WORDS: Record<keyof DeleteBlockers, [string, string]> = {
  leads: ["lead", "leads"],
  calls: ["call", "calls"],
  visits: ["site visit", "site visits"],
  quotes: ["quote", "quotes"],
  published: ["published post or ad", "published posts or ads"],
  broadcasts: ["WhatsApp broadcast", "WhatsApp broadcasts"],
  plans: ["plan", "plans"],
  numbers: ["calling or WhatsApp number", "calling or WhatsApp numbers"],
  partners: ["channel partner empanelment", "channel partner empanelments"],
  mandates: ["mandate", "mandates"],
  outside: ["partner registration or booking", "partner registrations or bookings"],
};

/** "3 leads, 5 calls and a plan", or null when nothing keeps it. */
export function blockerWords(b: DeleteBlockers): string | null {
  const parts = (Object.keys(WORDS) as (keyof DeleteBlockers)[])
    .filter((k) => b[k] > 0)
    .map((k) => (b[k] === 1 ? `1 ${WORDS[k][0]}` : `${b[k].toLocaleString("en-IN")} ${WORDS[k][1]}`));
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Why this node cannot be deleted, in the screen's words, or null when it can. */
export function deleteRefusal(kind: DeleteKind, b: DeleteBlockers): string | null {
  const what = blockerWords(b);
  if (!what) return null;
  return kind === "PROJECT"
    ? `It has ${what}. Those stay on record, so retire it instead.`
    : `This phase has ${what}. Those stay on record.`;
}

/** A foreign key the database refused on, named in words. */
export function refusedTable(table: string | undefined): string {
  const words: Record<string, string> = {
    leads: "leads",
    calls: "calls",
    site_visits: "site visits",
    quotes: "quotes",
    unit_blocks: "flats held for a buyer",
    visit_notes: "visit notes",
    outcome_events: "lead outcomes",
    proxy_calls: "calls",
    grants: "a partner's access",
    mandate_projects: "a mandate",
    partner_links: "partner links",
    partner_payouts: "partner payouts",
    client_registrations: "partner registrations",
    broadcasts: "WhatsApp broadcasts",
    subscriptions: "a plan",
    calling_numbers: "a calling number",
    whatsapp_numbers: "a WhatsApp number",
  };
  return words[table ?? ""] ?? "records that are kept";
}
