/** Rupees from paise, whole: "Rs 1,25,000". */
export function rs(paise: number): string {
  const r = Math.round(paise / 100);
  return `${r < 0 ? "-" : ""}Rs ${Math.abs(r).toLocaleString("en-IN")}`;
}

export function num(n: number): string {
  return n.toLocaleString("en-IN");
}

const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const MONTH = new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "Asia/Kolkata" });

export function day(d: Date | null | undefined): string {
  return d ? DAY.format(d) : "Never";
}

/** "3 h ago", "2 days ago", "Never". */
export function ago(d: Date | null | undefined, now = Date.now()): string {
  if (!d) return "Never";
  const m = Math.round((now - d.getTime()) / 60_000);
  if (m < 2) return "Just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 45) return `${days} days ago`;
  return DAY.format(d);
}

export function monthShort(period: string): string {
  return MONTH.format(new Date(`${period}-15T00:00:00Z`));
}

export const KIND_WORDS: Record<string, string> = {
  DEVELOPER: "Developer",
  MANDATE_FIRM: "Mandate firm",
  CHANNEL_PARTNER: "Channel partner",
};

export const PLAN_WORDS: Record<string, string> = { LAUNCH: "Launch", GROWTH: "Growth", SCALE: "Scale" };

/** "Rs 1.2 lakh", "Rs 3.4 Cr", "Rs 850": rupees from paise, short. */
export function rsShort(paise: number): string {
  const r = paise / 100;
  if (Math.abs(r) >= 1e7) return `Rs ${(r / 1e7).toFixed(2).replace(/\.?0+$/, "")} Cr`;
  if (Math.abs(r) >= 1e5) return `Rs ${(r / 1e5).toFixed(1).replace(/\.0$/, "")} lakh`;
  return `Rs ${Math.round(r).toLocaleString("en-IN")}`;
}

export function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "None";
}

/** "1 lead", "2 leads". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

const SENTENCE = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export const OUTCOME_WORDS: Record<string, string> = {
  NO_ANSWER: "No answer",
  BUSY: "Line busy",
  DECLINED: "Declined",
  SCREENED: "Call screener answered",
  NO_REPLY: "Picked up, no reply",
  NOT_IN_SERVICE: "Number not in service",
  SWITCHED_OFF: "Switched off",
  QUALIFIED: "Hot or warm",
  NOT_INTERESTED: "Not interested",
  COLD: "Cold",
  FAILED: "Did not connect",
  CALLBACK: "Asked for a call back",
  HANDED_OFF: "Put through to a person",
  WRONG_NUMBER: "Wrong number",
  BAD_LINE: "Bad line",
  HUNG_UP: "Hung up",
  VOICEMAIL: "Voicemail",
  OPTED_OUT: "Opted out",
  UNKNOWN: "Not reported",
};

export const AGENT_WORDS: Record<string, string> = {
  qualifier: "Qualifier",
  goal: "Call with a goal",
  reengage: "Re-engager",
  post_visit: "Post-visit",
  recovery: "No-show recovery",
  reminder: "Visit confirmer",
  receptionist: "Receptionist (inbound)",
  confirmer: "Visit confirmer",
};

export const CHANNEL_WORDS: Record<string, string> = {
  META_FORM: "Meta lead form",
  GOOGLE_FORM: "Google lead form",
  WEBSITE: "Website",
  MANUAL: "Added by hand",
  CRM: "From their CRM",
  WHATSAPP: "WhatsApp",
  PHONE: "Called in",
  PORTAL: "Property portal",
  PARTNER: "Channel partner",
  OTHER: "Other",
};

export const STAGE_WORDS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  visit_scheduled: "Visit scheduled",
  visit_done: "Visit done",
  negotiation: "Negotiation",
  booked: "Booked",
  nurture: "Nurture",
  lost: "Lost",
};

export const DEST_WORDS: Record<string, string> = {
  FACEBOOK_PAGE: "Facebook Page",
  INSTAGRAM: "Instagram",
  META_AD: "Meta ad",
  GOOGLE_DISPLAY_AD: "Google display ad",
  GOOGLE_DEMAND_GEN_AD: "Google Demand Gen",
  GOOGLE_SEARCH: "Google Search",
  GOOGLE_PMAX: "Performance Max",
  BUSINESS_PROFILE: "Business Profile",
};

export const VISIT_WORDS: Record<string, string> = {
  CONFIRMED: "Confirmed",
  VISITED: "Visited",
  NO_SHOW: "No-show",
  LAPSED: "Lapsed",
  MOVED: "Moved",
  CANCELLED: "Cancelled",
  ON_SITE: "On site now",
  REQUESTED: "Waiting for a time",
  BLOCKED: "Stopped",
};

export const POST_KIND_WORDS: Record<string, string> = { IMAGE: "Image posts", CAROUSEL: "Carousels", VIDEO: "Videos and films" };

export function words(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "None";
  return map[key] ?? SENTENCE(key);
}

/** A role key as a person reads it: "SALES_HEAD" is "Sales head". */
export function roleWords(role: string): string {
  return SENTENCE(role.replace(/^C_/, ""));
}
