/**
 * The audit trail, read by a person: pure and database-free, covered by
 * `check:logic`.
 *
 * `audit_log` is written in the code's own words (`brain.signed`,
 * `partner.payout_paid`). A person reads "Signed Brain facts" and "Paid a
 * partner". So every action is put in an area and a sentence here: a
 * dictionary for the ones people meet, and for the rest the words the key
 * already holds, never the key itself.
 */

export type AuditArea = "team" | "projects" | "brain" | "campaigns" | "leads" | "partners" | "billing" | "accounts" | "jimmy" | "other";

export const AUDIT_AREAS: { key: AuditArea; label: string }[] = [
  { key: "team", label: "Team and access" },
  { key: "projects", label: "Projects and RERA" },
  { key: "brain", label: "Brain and library" },
  { key: "campaigns", label: "Campaigns and posts" },
  { key: "leads", label: "Leads, calls and visits" },
  { key: "partners", label: "Partners and mandates" },
  { key: "billing", label: "Billing" },
  { key: "accounts", label: "Connected accounts" },
  { key: "jimmy", label: "Ask Jimmy" },
  { key: "other", label: "Other" },
];

/** Which area each key's first word belongs to. A word not here is "other". */
const AREA_OF: Record<string, AuditArea> = {
  auth: "team", user: "team", membership: "team", member: "team", invite: "team", join_request: "team", role: "team", org: "team",
  otp: "team", field_policy: "team",
  scope_node: "projects", entity: "projects", project: "projects", rera: "projects", site: "projects", demo: "projects",
  brain: "brain", unit: "brain", asset: "brain", brand: "brain", extract: "brain", competitor: "brain", storage: "brain", inventory: "brain",
  campaign: "campaigns", creative: "campaigns", post: "campaigns", publish: "campaigns", broadcast: "campaigns", learning: "campaigns",
  attribution: "campaigns",
  lead: "leads", call: "leads", calling: "leads", visit: "leads", message: "leads", quote: "leads", lender: "leads",
  partner: "partners", mandate: "partners",
  billing: "billing", payments: "billing",
  connect: "accounts", whatsapp: "accounts", crm: "accounts", sms: "accounts", app: "accounts", portal: "accounts",
  ask: "jimmy",
};

/** The actions people meet most, in their words. */
const WORDS: Record<string, string> = {
  "auth.signin_rejected": "Sign-in refused",
  "auth.signin_partner_founder": "Signed up a channel partner on a personal account",
  "org.created": "Created the organisation",
  "org.claimed": "Claimed the firm",
  "org.switched": "Switched organisation",
  "invite.emailed": "Invited somebody",
  "invite.email_failed": "Invite saved, email not sent",
  "membership.role_changed": "Changed somebody's role",
  "membership.revoked": "Removed somebody",
  "role.updated": "Edited a role",
  "role.created": "Created a role",
  "user.phone_verified": "Confirmed a phone number",
  "otp.sent": "Sent a one-time code",
  "field_policy.changed": "Changed who sees buyer numbers",
  "scope_node.created": "Added a place",
  "scope_node.updated": "Renamed a place",
  "rera.recorded": "Recorded a RERA registration",
  "rera.lapsed": "RERA registration lapsed",
  "rera.revoked": "RERA registration revoked",
  "rera.exemption_lapsed": "RERA exemption lapsed",
  "site.location_saved": "Saved the site location",
  "brain.draft_opened": "Opened a Brain draft",
  "brain.draft_edited": "Edited a Brain draft",
  "brain.signed": "Signed Brain facts",
  "brain.published": "Published the Brain",
  "unit.added": "Added a configuration",
  "unit.revised": "Revised a configuration",
  "unit.approved": "Approved a configuration's price",
  "unit.copied": "Copied configurations",
  "asset.added": "Added to the library",
  "asset.version_added": "Replaced a library file",
  "asset.approved": "Approved a library file",
  "asset.removed": "Removed a library file",
  "asset.copied": "Copied library files",
  "brand.kit_saved": "Saved the brand kit",
  "brand.file_uploaded": "Uploaded a brand mark",
  "campaign.brief_created": "Created a brief",
  "campaign.brief_saved": "Saved a brief",
  "campaign.brief_ready": "Marked a brief ready",
  "campaign.brief_reopened": "Reopened a brief",
  "campaign.reference_added": "Added a reference",
  "campaign.reference_removed": "Removed a reference",
  "creative.copy_generated": "Wrote copy",
  "creative.copy_edited": "Edited a card",
  "creative.copy_stopped": "Stopped writing copy",
  "creative.post_made": "Made a post",
  "creative.posts_made": "Made posts",
  "creative.post_failed": "A post did not pass its checks",
  "creative.post_removed": "Removed a post",
  "creative.reel_queued": "Asked for a video",
  "creative.reel_made": "A video was made",
  "creative.reel_stopped": "Stopped a video",
  "creative.reel_retried": "Tried a video again",
  "creative.pixel_checked": "Checked a picture",
  "creative.backdrop_generated": "Drew a backdrop",
  "post.schedule_created": "Created a schedule",
  "post.schedule_saved": "Edited a schedule",
  "post.schedule_started": "Started a schedule",
  "post.schedule_stopped": "Stopped a schedule",
  "post.schedule_removed": "Removed a schedule",
  "post.run_generated": "A scheduled run made its posts",
  "post.creative_approved": "Approved a post",
  "post.creative_rejected": "Rejected a post",
  "post.occasions_set": "Chose the festivals to post for",
  "lead.created": "Added a lead",
  "lead.captured": "A lead came in",
  "lead.moved": "Moved a lead",
  "lead.phone_unmasked": "Revealed a buyer's number",
  "lead.exported": "Exported leads",
  "lead.loan_updated": "Updated a buyer's home loan",
  "lead.loan_opened": "A buyer needs a home loan",
  "lead.loan_documents": "Updated a home loan's documents",
  "lead.loan_demand": "Recorded a demand on a home loan",
  "lead.loan_demand_step": "Updated a demand on a home loan",
  "lead.loan_share_consent": "Recorded whether a partner may see a home loan",
  "lead.call_proxied": "Called a buyer through our number",
  "lead.automation_off": "Switched the agent off for a lead",
  "lead.ownership": "Decided who a lead belongs to",
  "call.placed": "The agent called a buyer",
  "call.handoff_requested": "A call was put through to sales",
  "call.handoff_unanswered": "Nobody picked up a call put through",
  "calling.settings_changed": "Changed the calling settings",
  "calling.team_added": "Added somebody to take calls",
  "visit.booked": "Booked a site visit",
  "visit.on_site": "Checked a buyer in",
  "visit.visited": "Recorded a visit",
  "visit.cancelled": "Cancelled a visit",
  "visit.host_hours_saved": "Set a host's working hours",
  "message.sent": "Sent a WhatsApp",
  "partner.empanelled": "Empanelled a partner",
  "partner.registration": "Registered a partner's buyer",
  "partner.registration_extended": "A visit extended a partner's claim",
  "partner.registrations_released": "Released lapsed partner claims",
  "partner.settings_changed": "Changed the partner settings",
  "partner.link_made": "Made a partner link",
  "partner.link_retired": "Retired a partner link",
  "partner.grant_suspend": "Put a partner on hold",
  "partner.grant_restore": "Made a partner live again",
  "partner.payout_owed": "A partner's commission became owed",
  "partner.invoice_filed": "Filed a partner's invoice",
  "partner.payout_verified": "Verified a partner's invoice",
  "partner.payout_invoice_rejected": "Rejected a partner's invoice",
  "partner.payout_approved": "Approved a partner payout",
  "partner.payout_paid": "Paid a partner",
  "partner.payout_cancelled": "Cancelled a partner's commission",
  "partner.pass_back": "Set a pass-back",
  "partner.booking_dates": "Recorded a booking's dates",
  "partner.number_unmasked": "Revealed a partner buyer's number",
  "mandate.offered": "Offered a mandate",
  "mandate.invited": "Invited a mandate firm",
  "mandate.firm_joined": "A mandate firm signed up",
  "mandate.accepted": "A mandate firm accepted",
  "mandate.declined": "A mandate firm declined",
  "mandate.withdrawn": "Withdrew a mandate offer",
  "mandate.ended": "Ended a mandate",
  "mandate.renewed": "Ran a mandate longer",
  "mandate.payout_owed": "A mandate firm's commission became owed",
  "mandate.payout_cancelled": "Cancelled a mandate firm's commission",
  "billing.plan_set": "A plan was set",
  "billing.topup_started": "Started a top-up",
  "billing.credit_granted": "Credit was added",
  "connect.consented": "Connected an account",
  "connect.accounts_chosen": "Chose the accounts to use",
  "connect.daily_cap_set": "Set an ad account's daily limit",
  "connect.qualified_bidding": "Changed what an ad account bids on",
  "connect.disconnected": "Disconnected an account",
  "portal.key_rotated": "Made a new address for portal leads",
  "portal.projects_matched": "Matched portal projects to towers",
  "portal.sheet_imported": "Imported a portal's leads",
  "portal.account_saved": "Connected a Housing.com account",
  "portal.account_removed": "Removed a Housing.com account",
  "portal.account_broken": "A Housing.com account stopped working",
  "ask.answered": "Asked Jimmy",
  "ask.chat_deleted": "Deleted a chat with Jimmy",
  "ask.action_proposed": "Jimmy proposed an action",
  "ask.action_confirmed": "Confirmed an action from Jimmy",
  "ask.action_done": "An action from Jimmy finished",
  "ask.action_failed": "An action from Jimmy failed",
  "ask.actions_switched": "Switched Jimmy's actions on or off",
};

/** The object a key is about, for the ones the dictionary does not name. */
const NOUN: Record<string, string> = {
  rera: "RERA", brain: "Brain", unit: "Configuration", asset: "Library file", brand: "Brand kit", campaign: "Brief",
  creative: "Creative", post: "Schedule", publish: "Publication", broadcast: "Broadcast", lead: "Lead", call: "Call",
  calling: "Calling", visit: "Visit", message: "WhatsApp", quote: "Quote", partner: "Partner", mandate: "Mandate",
  billing: "Billing", connect: "Connection", whatsapp: "WhatsApp number", crm: "CRM", sms: "SMS", ask: "Jimmy",
  membership: "Membership", invite: "Invite", role: "Role", org: "Organisation", scope_node: "Place", site: "Site",
  inventory: "Availability", learning: "Learning", attribution: "Attribution", competitor: "Competitor ad", lender: "Lender",
  payments: "Payments", portal: "Property portal", storage: "Storage", extract: "Document", user: "Person", otp: "Code",
};

export function auditArea(action: string): AuditArea {
  return AREA_OF[action.split(".")[0]] ?? "other";
}

/** A sentence for an action: the dictionary's, or the key's own words. */
export function auditWords(action: string): string {
  if (WORDS[action]) return WORDS[action];
  const [head, ...rest] = action.split(".");
  const verb = rest.join(" ").replace(/_/g, " ").trim();
  const noun = NOUN[head] ?? head.replace(/_/g, " ");
  const text = verb ? `${noun} ${verb}` : noun;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The prefixes that make up an area, for the filter's WHERE clause. */
export function areaPrefixes(area: AuditArea): string[] {
  return Object.entries(AREA_OF).filter(([, a]) => a === area).map(([p]) => p);
}

export const isArea = (raw: unknown): raw is AuditArea => AUDIT_AREAS.some((a) => a.key === raw);

/** The trail's filters from the address, each dropped when it does not read. */
export function readAuditFilter(p: Record<string, string | string[] | undefined>): {
  who: string | null;
  area: AuditArea | null;
  from: string | null;
  to: string | null;
  before: number | null;
} {
  const one = (k: string) => {
    const v = p[k];
    return typeof v === "string" ? v.trim() : null;
  };
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
  const who = one("who");
  const area = one("area");
  const before = Number(one("before"));
  return {
    who: who === "system" || (who && /^[0-9a-f-]{36}$/i.test(who)) ? who : null,
    area: isArea(area) ? area : null,
    from: day(one("from")),
    to: day(one("to")),
    before: Number.isSafeInteger(before) && before > 0 ? before : null,
  };
}

/** What the target of a row is called when nothing better is known. */
export function targetWords(targetType: string | null): string | null {
  if (!targetType) return null;
  const words: Record<string, string> = {
    scope_node: "a place", lead: "a lead", call: "a call", site_visit: "a visit", campaign_brief: "a brief", rendered_post: "a post",
    reel_job: "a video", post_schedule: "a schedule", post_run: "a scheduled run", post_creative: "a post", asset: "a library file",
    partner_firm: "a partner", partner_link: "a partner link", partner_payout: "a payout", payout_milestone: "a payout half",
    client_registration: "a partner's buyer", grant: "an empanelment", mandate: "a mandate", org: "the organisation",
    membership: "a membership", user: "a person", message: "a WhatsApp", ask_thread: "a chat", ask_action: "an action",
    connection: "a connection", connection_account: "an account", domain: "an invite", otp: "a code",
  };
  return words[targetType] ?? targetType.replace(/_/g, " ");
}
