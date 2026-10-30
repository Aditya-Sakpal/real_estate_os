/**
 * Ask Jimmy about the console itself: where a screen is, how to do
 * something on it, what a button means.
 *
 * "How do I connect my Meta ads account?" is not a question about the
 * organisation's data, so the data map could not answer it, and Jimmy said
 * it could not work it out. This is the console as a person meets it:
 * every screen, where it sits, what is on it, and the tasks done there with
 * the buttons' own words. Jimmy answers from it and from nothing else, and
 * each screen it names comes back as a link the person can press.
 *
 * Three rules.
 *
 *   1. Only what this person can open. A screen's keys are the page's own
 *      check (`anyOf`, the same keys `nav.ts` and the page ask), so a
 *      screen they cannot open is named as one they need access for, and
 *      its buttons are never described to them.
 *   2. The words on a button are the screen's own. A label Jimmy quotes has
 *      to be in the map (`quotedOutsideMap()`); one that is not is sent
 *      back, because "press Link account" on a screen whose button says
 *      "Connect" is a person searching for a button that does not exist.
 *   3. The map is kept with the screens. A screen added or renamed changes
 *      this file in the same change; `check:logic` holds every static path
 *      to a page that exists and every rail item to an entry here.
 *
 * A screen that belongs to one record (a lead, a tower, a campaign's
 * studio) carries its address as a pattern and the kind of record that
 * fills it (`page`). Asked for "the studio for the Tower C campaign",
 * Jimmy looks the record up (`find_page`, among the records this person
 * can open) and links that record's own page, never the section above it.
 *
 * Pure: no database, no network. Client-safe.
 */

/** The kinds of record a screen's page belongs to. */
export type RecordKind = "lead" | "project" | "place" | "brief" | "provider";

export type Screen = {
  key: string;
  /** As the person sees it: the page heading, or the tab's name. */
  title: string;
  /** Where it is, as a person would say it: "Settings, Connected accounts". */
  where: string;
  /** A path a link can open. Absent for a screen that belongs to one record (a lead, a tower). */
  href?: string;
  /** Any one of these opens it. Empty means every member. */
  anyOf: string[];
  /** What is on it, in a sentence or two. */
  about: string;
  /** How things are done there, with the buttons' own words in quotes. */
  tasks: string[];
  /**
   * A page per record: its address with `{id}` for the record's id, and what
   * its link says after "Open", with `{name}` for the record.
   */
  page?: { record: RecordKind; path: string; label: string };
  /** The kinds of company that have this screen at all. Absent means every kind. */
  kinds?: string[];
};

export type ScreenAccess = { can: (perm: string) => boolean };

export const SCREENS: Screen[] = [
  // --- The work -----------------------------------------------------------------
  {
    key: "today",
    title: "Today",
    where: "Today, first in the menu",
    href: "/dashboard",
    anyOf: [],
    about:
      "What needs you right now, each item with its button, then what is left before each tower can be advertised: Registered, Facts signed, Branded, Priced, Pictured, Briefed. A new organisation also sees its setup steps.",
    tasks: [
      "Press an item's button to fix it (for example \"See the lead\", \"Open the project\", \"Connect WhatsApp\").",
      "A tower's next step is a button such as \"Record the registration\", \"Add a configuration\" or \"Write a brief\".",
      "Setup steps for a new organisation: \"Invite admin\", \"Add entity\", \"New project\".",
    ],
  },
  {
    key: "leads",
    title: "Leads",
    where: "Leads, in the menu (the Pipeline tab)",
    href: "/dashboard/leads",
    anyOf: ["lead:read"],
    about:
      "The lead pipeline as a board: New, Contacted, Qualified, Visit scheduled, Visit done, Negotiation, Booked, and the side columns Nurture and Lost. Each card shows the buyer, how hot they are, where they came from and the next step.",
    tasks: [
      "Move a lead: drag its card to another column, or use the card's menu (\"Move ahead\", \"Move back\", \"Take off the path\"). A box asks for what the move needs, for example \"Schedule the visit\" or \"Record the booking\".",
      "Find a lead: type a name in the search box, or use the chips \"Needs you\", \"Hot\", \"Warm\", \"Cold\" and the tower picker.",
      "Open a lead's page: press its name.",
      "Download the leads: \"Export\" (needs the export permission).",
      "Tabs at the top: \"Pipeline\", \"Calls\", \"Availability\".",
    ],
  },
  {
    key: "lead",
    title: "A lead's page",
    page: { record: "lead", path: "/dashboard/leads/{id}", label: "{name}" },
    where: "Leads, then press a lead's name",
    anyOf: ["lead:read"],
    about:
      "One buyer: their details, what the calls found out, milestones, a quote, their home loan, what happens next and the whole history of calls, WhatsApps and visits.",
    tasks: [
      "Have the AI call now: \"Call now\". To give the call a purpose (a site visit on Saturday, say): \"Call with a goal\".",
      "Call them yourself without showing your number: \"Call from my phone\" (first time, confirm your own number with a code).",
      "Send the site's location: \"Send site location on WhatsApp\".",
      "See the whole number: \"Show number\" (needs the permission, and is recorded).",
      "Stop the automatic calls and messages: \"Pause AI calls and messages\".",
      "Draft a quote: \"Draft a quote\" (from Visit done onward), then \"Approve quote\", then \"Block\" the flat and send the token link.",
      "Follow the buyer's home loan: \"Open loan file\" or \"Start a loan file\" on the Home loan card.",
    ],
  },
  {
    key: "calls",
    title: "Call history",
    where: "Leads, then the Calls tab",
    href: "/dashboard/leads/calls",
    anyOf: ["lead:read"],
    about:
      "Every call the AI agent made, with how many picked up, qualified and were handed to sales. Press a call for its summary, recording and transcript.",
    tasks: [
      "Add a lead and have the AI call them now: \"Call a lead\", fill in the name, phone and tower, then \"Call now\".",
      "Filter: \"Today\", \"7 days\", \"This month\", and \"Picked up\", \"Qualified\", \"Handed to sales\" and more.",
    ],
  },
  {
    key: "availability",
    title: "Flat availability",
    where: "Leads, then the Availability tab",
    href: "/dashboard/leads/availability",
    anyOf: ["inventory:read"],
    about: "For one tower, which flats are available, blocked or booked, by configuration, floor and size.",
    tasks: [
      "Pick the tower with its chip; filter \"Available\", \"Blocked\", \"Booked\".",
      "Upload your availability sheet: \"Import\" or \"Update availability\" (an Excel or CSV sheet; \"An example sheet\" shows the format).",
    ],
  },
  {
    key: "loans",
    title: "Home loans",
    where: "Home loans in the menu",
    href: "/dashboard/loans",
    anyOf: ["loan:update"],
    about:
      "Every buyer's home loan: what needs you first (a rejection on a booking, a bank late on a demand, a sanction about to lapse), then each loan with its bank, what the bank has paid, the documents and the next step. Each opens its loan file.",
    tasks: [
      "Filter: \"Before sanction\", \"Sanctioned\", \"Disbursing\", \"Fully disbursed\", \"Closed\".",
      "On a loan file: \"Update loan\" for the stage, bank, sanction, rate and agreement value; tick documents and \"Save documents\"; \"Record a demand\" off the developer's demand letter, then \"Update\" on it for \"Sent to the bank\", \"Bank paid\" or \"Buyer paid their share\".",
    ],
  },
  {
    key: "loan_banks",
    title: "Bank tie-ups",
    where: "Home loans, then the Banks tab",
    href: "/dashboard/loans/banks",
    anyOf: ["loan:update", "loan:manage"],
    about:
      "The banks your buyers are introduced to: who to call there, where a buyer who says yes is sent, the rate and fee they offer, until when, and the projects each has approved. The WhatsApp question to buyers, what the AI agent says about home loans, and every loan file use this list.",
    tasks: [
      "Add a bank: \"Add a bank\", fill in the bank, where buyers are sent, the offer and the projects it approved, then \"Add bank\".",
      "Change one: \"Edit\" on its card, then \"Save bank\". Take one off: \"Remove\".",
    ],
  },
  {
    key: "loan_reports",
    title: "Home loan reports",
    where: "Home loans, then the Reports tab",
    href: "/dashboard/loans/reports",
    anyOf: ["loan:update"],
    about:
      "Loans by stage and by bank, the buyers' and the banks' money demanded against what came in, banks' payments waiting and for how long, and why banks said no.",
    tasks: [],
  },
  {
    key: "portal-import",
    title: "Portal leads",
    where: "Leads, then \"Import portal leads\"",
    href: "/dashboard/leads/portals",
    anyOf: ["lead:create"],
    about: "Add enquiries from a property portal's lead export (Excel or CSV, with dates and mobile numbers).",
    tasks: ["Choose the portal and the file, then \"Import\". Enquiries older than 7 days are skipped."],
  },
  {
    key: "call-lists",
    title: "Call lists",
    where: "Leads, the Calls tab, then \"Call from a list\"",
    href: "/dashboard/leads/calls/lists",
    anyOf: ["lead:call"],
    about:
      "A sheet of people for the AI agent to ring. The columns are read whatever they are called, and each person's remarks decide what their call does, when it goes, or why they are skipped. Calls go a few at a time, and anybody not answering is tried again.",
    tasks: [
      "Upload one: choose the tower and the Excel or CSV file, then \"Read the list\".",
      "Check the plan, change \"What most calls do\" if needed, tick that everyone agreed to be contacted, then \"Call N people\".",
      "While it runs: \"Pause\", \"Carry on calling\" or \"Stop list\".",
    ],
  },
  {
    key: "desk",
    title: "Call desk",
    where: "Call desk, in the menu",
    href: "/dashboard/desk",
    anyOf: ["lead:read"],
    about:
      "A screen to keep open while working. It rings the moment a buyer is put through to the sales team (the AI handing over a call, a hot buyer, or a buyer ringing your number) and shows who they are, what they want, what the AI heard on the call and their earlier calls, before the phone is picked up.",
    tasks: [
      "Press \"Turn on ringing\" once and keep the tab open; allow notifications to be told on another tab.",
      "\"Silence\" stops the ring for that buyer, and \"Open lead\" opens their page.",
    ],
  },
  {
    key: "waiting-callers",
    title: "Callers to file",
    where: "Today, \"callers to your number not filed under a project\"",
    href: "/dashboard/leads/callers",
    anyOf: ["lead:create"],
    about:
      "People who rang a calling number that covers several projects, where nobody could tell which project they called about. Each shows when they rang, whether the AI or the team answered, and what they asked.",
    tasks: ["Choose the project under \"Which project\", then \"File as a lead\".", "\"Not a buyer\" removes the caller and makes no lead."],
  },
  {
    key: "visits",
    title: "Site visits",
    where: "Site visits, in the menu",
    href: "/dashboard/visits",
    anyOf: ["visit:read"],
    about:
      "The week's site visits, one day at a time: who is coming, who is on site, visited and no-shows, with the next arrival. Each visit shows the host, reminders sent and how it went.",
    tasks: [
      "Check a buyer in: \"Check in\" on the visit, or scan their pass with \"Scan a pass\".",
      "Record how it went: \"Record how it went\", then \"Save the visit\". \"Record a voice note\" fills the form from what you say.",
      "Change a visit: \"Move\", \"Cancel visit\", or \"Pick a host\". Mark one missed: \"Mark as no-show\".",
      "Filter: \"Needs you\", \"Upcoming\", \"On site\", \"Visited\", \"No-shows\", and by project or host.",
    ],
  },
  {
    key: "scan",
    title: "Scan a pass",
    where: "Site visits, then \"Scan a pass\"",
    href: "/dashboard/visits/scan",
    anyOf: ["visit:confirm"],
    about: "The phone's camera reads a buyer's visit pass and checks them in, even with no signal (it sends when the signal is back).",
    tasks: ["Point the camera at the pass; \"Scan next\" for the next buyer."],
  },
  {
    key: "partners",
    title: "Partners",
    where: "Partners, in the menu",
    href: "/dashboard/partners",
    anyOf: ["partner:read", "payout:read", "mandate:manage"],
    kinds: ["DEVELOPER"],
    about:
      "Your channel partners and mandate firms: the firms, the buyers they registered, what they are owed, disputes, and registrations lapsing this week. Tabs: \"Channel partners\", \"Buyers registered\", \"Payouts\", \"Mandate firms\".",
    tasks: [
      "Add a partner firm: \"Empanel a channel partner\" (needs the empanel permission).",
      "Register a buyer for a partner: \"Register a buyer\", then \"Register\".",
      "Set the commission ladder: \"Commission terms\".",
      "Pay a partner: in \"Payouts\", \"File invoice\", then \"Invoice matches\", \"Approve\", and \"Mark paid\" with the bank's UTR (each needs its own permission).",
      "Give a firm a link that registers its buyers: open the firm, then \"Make a link\" and \"Copy link\".",
      "Appoint a mandate firm: on \"Mandate firms\", \"Appoint a mandate firm\", then \"Send the offer\".",
    ],
  },
  {
    // A mandate firm's own desk has no Mandate firms tab: it is one.
    key: "partners_firm",
    title: "Partners",
    where: "Partners, in the menu",
    href: "/dashboard/partners",
    anyOf: ["partner:read", "payout:read"],
    kinds: ["MANDATE_FIRM"],
    about:
      "Your own channel partners: the firms, the buyers they registered, what you owe them, and registrations lapsing this week. Tabs: \"Channel partners\", \"Buyers registered\", \"Payouts\".",
    tasks: [
      "Add a partner firm: \"Empanel a channel partner\" (needs the empanel permission).",
      "Register a buyer for a partner: \"Register a buyer\", then \"Register\".",
      "Set the commission ladder: \"Commission terms\".",
      "Pay a partner: in \"Payouts\", \"File invoice\", then \"Invoice matches\", \"Approve\", and \"Mark paid\" with the bank's UTR (each needs its own permission).",
      "Give a firm a link that registers its buyers: open the firm, then \"Make a link\" and \"Copy link\".",
    ],
  },
  {
    key: "partner_buyers",
    title: "Buyers registered",
    where: "Partners, then the Buyers registered tab",
    href: "/dashboard/partners?view=buyers",
    anyOf: ["partner:read"],
    kinds: ["DEVELOPER", "MANDATE_FIRM"],
    about: "Every buyer a partner registered, with whether the claim is live, lapsing, visited, booked or refused.",
    tasks: ["Filter with \"Live\", \"Lapsing\", \"Visited\", \"Booked\", \"Refused\", \"Lapsed\". Book their visit: \"Book the visit\"."],
  },
  {
    key: "partner_payouts",
    title: "Payouts",
    where: "Partners, then the Payouts tab",
    href: "/dashboard/partners?view=payouts",
    anyOf: ["payout:read"],
    kinds: ["DEVELOPER", "MANDATE_FIRM"],
    about: "What each partner is owed on each booking, in two halves, and where each stands: held, invoice awaited, to verify, to approve, to pay, paid.",
    tasks: ["Filter with \"Late\", \"To pay\", \"To approve\", \"Invoices to verify\". \"File invoice\", \"Invoice matches\", \"Approve\", \"Mark paid\" move a payout along."],
  },
  {
    key: "projects",
    title: "Projects",
    where: "Projects, in the menu",
    href: "/dashboard/projects",
    anyOf: ["project:read", "rera:read"],
    about: "Every project with its city and company, and how close each is to its first campaign.",
    tasks: [
      "Add a project: \"New project\", fill in \"Add a project\" (name, city, company), then \"Create project\".",
      "Press a project to see its towers, RERA registrations and facts.",
    ],
  },
  {
    key: "project-review",
    title: "Review and approve",
    page: { record: "project", path: "/dashboard/projects/{id}/review", label: "{name}: review and approve" },
    where: "Projects, then the project, then \"Review and approve\"",
    anyOf: ["brain:read", "asset:approve", "brain.price:approve"],
    about:
      "Everything on one project and its towers waiting for a yes: values read from documents, pictures, flat types, and facts to sign.",
    tasks: [
      "Accept every value read from documents: \"Accept all\".",
      "Approve every picture waiting: \"Approve all\" under Pictures to approve.",
      "Approve every flat type waiting: \"Approve all\" under Flat types to approve.",
      "Sign the facts: \"Open to sign\" beside the tower.",
    ],
  },
  {
    key: "project",
    title: "A project's page",
    page: { record: "project", path: "/dashboard/projects/{id}", label: "{name}" },
    where: "Projects, then press the project",
    anyOf: ["project:read", "rera:read"],
    about:
      "One project: what is left before a campaign for each tower, the project facts (the Brain), its phases or towers with their RERA status, the site location, and visits per hour.",
    tasks: [
      "Add a tower or phase: \"Add phase\".",
      "Record a tower's RERA registration: under \"Record a registration\", type the number and press \"Fill from number\" to read the rest from the state's portal, then \"Record as verified\". A small building may be exempt: \"Attest exemption\".",
      "Approve everything waiting on the project and its towers in one place: \"Review and approve\".",
      "Open the project facts: \"Open\" on the Project Brain card, or \"Set it up\".",
      "Set the site's pin for directions: \"Add location\", then \"Save location\".",
      "How many visits an hour the site can host: \"Change\" under Visits per hour, then \"Save\".",
      "Give a host their working hours for each day: \"Set a host's hours\" under Visits per hour, choose the host, then \"Save hours\". Once any host has hours, an hour takes one visit for each host on the floor.",
    ],
  },
  {
    key: "brain",
    title: "Project facts (the Brain)",
    page: { record: "place", path: "/dashboard/brain/{id}", label: "the facts for {name}" },
    where: "Projects, the project, then \"Open\" on the Project Brain card (or a tower's Brain)",
    anyOf: ["brain:read"],
    about:
      "The approved facts every quote, reply and ad is built from: price and payment, RERA facts, and claims and never-say. Each section is signed by its own approver before it can be published.",
    tasks: [
      "Change facts: \"Edit\" (or \"Continue draft\"), then \"Save draft\".",
      "Sign a section you approve: \"Sign the price\", \"Sign the RERA facts\" or \"Sign the claims\"; once all are signed, \"Publish version\".",
      "Read facts from your documents: \"Documents\", then upload and check what was read.",
      "Hear how the calling agent says the project's names and places: \"Pronunciation\".",
    ],
  },
  {
    key: "brain_documents",
    title: "Read from documents",
    page: { record: "place", path: "/dashboard/brain/{id}/documents", label: "the documents for {name}" },
    where: "A project's facts (the Brain), then \"Documents\"",
    anyOf: ["brain:read"],
    about: "Upload the RERA certificate, price list, brochure and similar; each value read from them waits to be checked beside the page it came from.",
    tasks: [
      "Upload: choose what it is, pick the PDF or picture, then \"Upload and read\".",
      "Check each value: \"Accept\", \"Reject\" or \"Correct\".",
    ],
  },
  {
    key: "brain_words",
    title: "How the agent says it",
    page: { record: "place", path: "/dashboard/brain/{id}/words", label: "how calls say the words of {name}" },
    where: "A project's facts (the Brain), then \"Pronunciation\"",
    anyOf: ["brain:read"],
    about:
      "The names and places the calling agent says on calls about a project or tower. Each can be heard in the call voice, is marked \"Likely right\" or \"May sound wrong\", and can be written the way it is really said, which every call then uses.",
    tasks: [
      "Hear a word: the play button beside it.",
      "Check every word not checked yet: \"Check 12 words\" at the top (the number is how many are left).",
      "Fix one: \"Change\", write how it is said (in Devanagari, like वाकड, or spelt out, like Waa-kad), then \"Save\". \"Use the usual way\" undoes it.",
      "Add a word the list missed: under \"Add a word\", then \"Add word\".",
    ],
  },
  {
    key: "reports",
    title: "Reports",
    where: "Reports, in the menu",
    href: "/dashboard/reports",
    anyOf: ["report:read"],
    about:
      "What a booking costs: ad spend traced to leads, visits and bookings, cost by source, where bookings came from, bookings by the week the lead arrived, and closing rates.",
    tasks: [
      "Choose the project and the period (\"4 weeks\", \"13 weeks\", or the financial year).",
      "\"Where the money went\" cuts spend by \"Campaign\", \"Creative\", \"City\", \"Project\" or \"Tower\".",
    ],
  },
  {
    key: "team",
    title: "Team",
    where: "Team, at the foot of the menu",
    href: "/dashboard/team",
    anyOf: ["member:read"],
    about: "Who is in the organisation, their roles and where they hold them, join requests and pending invites.",
    tasks: [
      "Invite someone: \"Invite someone\", fill in their work email, role and place, then \"Send invite\".",
      "Invite many: \"Add several at once\", then \"Invite\".",
      "Change a person's role: \"Change role\". Remove them: \"Remove\".",
      "Approve a join request: \"Approve\".",
      "Hand over the admin role: \"Hand over admin\" (only the current admin).",
    ],
  },
  // --- Library ----------------------------------------------------------------
  {
    key: "library",
    title: "Library",
    where: "Library, in the menu",
    href: "/dashboard/library",
    anyOf: ["asset:read", "brand:read", "unit:read"],
    about:
      "Everything an ad is made from: the branding, competitor ads, and every project and tower with its approved pictures, plans and the flats it sells.",
    tasks: [
      "Open the \"Branding\" card for logos, colours, typeface and contact details.",
      "Open \"Competitor ads\" to save and see what competitors run.",
      "Press a project or tower to see and upload its pictures, plans and configurations.",
    ],
  },
  {
    key: "library_place",
    title: "A project's or tower's library",
    page: { record: "place", path: "/dashboard/library/{id}", label: "the library for {name}" },
    where: "Library, then press the project or tower",
    anyOf: ["asset:read", "unit:read"],
    about:
      "The approved pictures and plans an ad for this project or tower may use (exterior renders, amenities, floor plans, site plans, construction progress, the RERA QR lockup), and on a tower, the flats it sells with area and starting price.",
    tasks: [
      "Upload pictures: \"Add to the library\", choose the files, then \"Upload\".",
      "Approve a picture so ads may use it: \"Approve\" on it (needs the asset approval permission).",
      "Record a flat type on a tower: \"Record configuration\", then \"Approve\" its price (needs the price approval permission). \"Change the numbers\" saves a new version.",
      "Copy pictures or configurations to another tower: \"Copy to another place\" or \"Copy configurations to another tower\". Copies arrive unapproved.",
      "A picture only goes into an ad once it is approved.",
    ],
  },
  {
    key: "branding",
    title: "Branding",
    where: "Library, then \"Branding\" in the list on the left",
    href: "/dashboard/library/branding",
    anyOf: ["brand:read"],
    about:
      "The brand kit every ad carries: logos (marks), colours, typeface, contact details and disclaimer. Set once for the company; a project or tower can override it.",
    tasks: [
      "Press \"Edit branding\", change what you need, then \"Save branding\".",
      "A lead form on Meta or Google needs \"Privacy policy\": your privacy policy's web address.",
      "Add a logo: in \"Marks\", \"Choose a file\" (or \"Replace this mark\"), then \"Save branding\".",
      "The row of place names at the top switches between the company, a project and a tower.",
      "\"Still needed before a creative can be built\" lists what is missing.",
    ],
  },
  {
    key: "market",
    title: "Competitor ads",
    where: "Library, then \"Competitor ads\" in the list on the left",
    href: "/dashboard/library/market",
    anyOf: ["campaign:read"],
    about:
      "Competitor ads your team saved, plus Sales Desk's library for your cities, each tagged by what it leads with. They shape which designs and selling points future posts use.",
    tasks: [
      "Save an ad you saw: \"Add an ad\", upload the picture or video, then \"Save and read\".",
      "Tabs: \"Saved by your team\" and \"Sales Desk's library\".",
      "Set how much competitor ads count: change the number, then \"Save\".",
    ],
  },

  // --- Campaigns --------------------------------------------------------------
  {
    key: "campaigns",
    title: "Campaigns",
    where: "Campaigns, in the menu",
    href: "/dashboard/campaigns",
    anyOf: ["campaign:read"],
    about:
      "What still blocks the first ad for each project and tower (a RERA registration in date, published project facts, a campaign brief), and every project and tower's campaigns.",
    tasks: [
      "\"Needs you\" lists what to fix, each with its button (\"Open the Brain\", \"Write the brief\", \"Open the registration\").",
      "Press a project or tower name to see its campaigns and start one.",
      "The list on the left opens \"Waiting on you\", \"Published\", \"Occasions\" and each project's campaigns. \"N waiting to go out\" at the top shows when posts wait for review.",
    ],
  },
  {
    key: "campaign_place",
    title: "A project's or tower's campaigns",
    page: { record: "place", path: "/dashboard/campaigns/{id}", label: "campaigns for {name}" },
    where: "Campaigns, then press the project or tower",
    anyOf: ["campaign:read"],
    about: "Every campaign brief for one project or tower, and where a new campaign is started.",
    tasks: [
      "Start a campaign: type its name under \"Start a campaign for ...\", then \"Start the brief\". On a project it runs for every tower; on a tower, for that tower.",
      "A project's page lists its towers, each opening that tower's campaigns; a tower's page shows the project's campaigns that also run for it.",
      "Open an existing one: \"Open the brief\".",
    ],
  },
  {
    key: "brief",
    title: "A campaign brief",
    page: { record: "brief", path: "/dashboard/campaigns/brief/{id}", label: "the brief for {name}" },
    where: "Campaigns, the project or tower, then \"Open the brief\"",
    anyOf: ["campaign:read"],
    about:
      "What one campaign is for: objective, audience, micro-markets, call to action, languages, formats, configurations, hook, offers, and example posts that worked or to avoid.",
    tasks: [
      "Fill it in: \"Edit the brief\", then \"Save the brief\".",
      "When it is complete: \"Mark it ready\". Then \"Open the studio\" to write copy and make posts, or \"Set a schedule\" to post on a plan.",
      "Add example posts: \"Add something that worked\" or \"Add something to avoid\" (uploads, not links).",
    ],
  },
  {
    key: "studio",
    title: "Studio",
    page: { record: "brief", path: "/dashboard/campaigns/brief/{id}/studio", label: "the studio for {name}" },
    where: "A ready campaign brief, then \"Open the studio\"",
    anyOf: ["campaign:read"],
    about:
      "Where ad copy is written and checked against the approved project facts, and turned into image posts, carousels and videos that can be downloaded or published.",
    tasks: [
      "Write copy: \"Write the copy\". Each card shows \"Cleared\", \"On hold\" or \"Blocked\"; \"Rewrite\" writes one again.",
      "Edit a card yourself: the pencil beside its verdict opens its lines; \"Save\" keeps your words when they still clear, and says why when they do not.",
      "Make posts: choose Image, Carousel or Video, a template and sizes, then \"Make N image posts\" (or carousels, videos).",
      "Publish a post: \"Publish\" on it, tick \"Where it goes\" (Facebook, Instagram, a Meta ad, a Google display ad, a Google Demand Gen ad, Google Business), then the confirm button. Ads are created paused.",
      "A Meta ad asks \"What the Meta ad is for\": \"Lead form\", \"WhatsApp chats\", \"Website visits\" or \"Reach\". It shows the story size beside the feed one when both were made.",
      "Make every size an ad needs in one press: under \"Where it goes\", \"For a Meta ad\" or \"For YouTube\"; ticking \"Google ads\" makes the banner and the square together.",
      "\"What to fix\" says what stops copy or posts, with a button for whoever can fix it.",
      "Download a post with \"Download\", or a carousel with \"Download all (ZIP)\".",
    ],
  },
  {
    key: "schedule",
    title: "Schedules",
    page: { record: "brief", path: "/dashboard/campaigns/brief/{id}/schedule", label: "schedules for {name}" },
    where: "A ready campaign brief, then \"Set a schedule\"",
    anyOf: ["campaign:read"],
    about:
      "Plans that make posts for the campaign by themselves, on set days or picked dates, as organic posts, ads or both, going out after review or automatically.",
    tasks: [
      "\"Add a schedule\": name it, choose \"Every week\" or \"On chosen dates\", set what goes out each day, the time, where it goes, then \"Save the schedule\".",
      "Choose \"Review first\" so a person approves each post, or \"Send automatically\".",
      "\"Stop it\" pauses a schedule; \"Start it again\" restarts it; \"Edit\" changes it.",
      "A schedule's ads run on \"Meta ad\", \"Google Demand Gen ad\" or both, and a Meta ad's goal is chosen under \"Meta ads are for\".",
      "\"Always on\" runs the campaign on Google Search and Performance Max: enter \"Budget a day\", then \"Create a paused Google Search ad\" or \"Create a paused Google Performance Max\". Switch it on from Published; \"End it\" stops it for good.",
    ],
  },
  {
    key: "queue",
    title: "Waiting on you",
    where: "Campaigns, then \"Waiting on you\" in the list on the left",
    href: "/dashboard/campaigns/queue",
    anyOf: ["campaign:read"],
    about: "Posts written by schedules, waiting for a person before they go out, and posts the checks blocked.",
    tasks: [
      "Approve a post: \"Approve\" (or \"Approve and start ad\" for an ad).",
      "Send one back with a note: \"Send back\".",
      "A blocked post shows \"Fix what it names\".",
    ],
  },
  {
    key: "live",
    title: "Published",
    where: "Campaigns, then \"Published\" in the list on the left",
    href: "/dashboard/campaigns/live",
    anyOf: ["campaign:read"],
    about:
      "Every post and ad that went out, where, its state, and for ads their spend and results; plus WhatsApp broadcasts, and anything that needs a person.",
    tasks: [
      "Tabs: \"Everything\", \"Ads\", \"Posts\", \"Needs you\".",
      "One ad's own page (spend, leads and clicks day by day, cost per lead beside the other ads, its leads and how each call went, its budget moves): press the ad's headline.",
      "Switch an ad's spend on: \"Switch on\" (needs the budget permission). Stop it: \"Pause\".",
      "A post that failed: \"Try again\".",
    ],
  },
  {
    key: "occasions",
    title: "Occasions",
    where: "Campaigns, then \"Occasions\" in the list on the left",
    href: "/dashboard/campaigns/occasions",
    anyOf: ["campaign:read"],
    about: "The festivals your company observes, so scheduled posts mention only those. Nothing is ticked by default.",
    tasks: ["Tick the occasions you observe, then \"Save changes\" at the top."],
  },

  // --- Ask Jimmy ---------------------------------------------------------------
  {
    key: "ask",
    title: "Ask Jimmy",
    where: "Ask Jimmy, second in the menu",
    href: "/dashboard/ask",
    anyOf: [],
    about:
      "This chat. It answers questions about your own data and how to use the console, in English or Hinglish, and with your confirmation can call a lead, make or approve a post and more. Chats are private and kept for 30 days.",
    tasks: [
      "Speak a question instead of typing: the microphone beside send (\"Speak your question\"), then the tick. Check the words, then send.",
      "Set up a project, or add towers, flat types and pictures to one, from its brochure, price list, floor plans or pictures: the paperclip (\"Attach brochures, documents or pictures\"), then send. Jimmy reads them, asks what it could not find, and makes it all on one press, waiting for approval.",
      "Start over: \"New chat\". Remove one: \"Delete\".",
      "Whether Jimmy may take actions is set in Settings, on the Ask Jimmy card.",
    ],
  },
  {
    key: "agents",
    title: "AI agents",
    where: "AI agents, third in the menu",
    href: "/dashboard/agents",
    anyOf: [],
    about:
      "The six AI agents: the Lead Qualifier, Visit Confirmer, Re-engager, Post-visit Follow-up, Inbound Receptionist and CP Desk. Each shows when it acts, what it does and the voice it speaks in, and whether the project's plan includes it. Agents a plan does not include are shown locked, with the plan that unlocks them. Below, the four voices; Advait is recommended. A project's plan opens Advait and Priya on Launch, Shubh from Growth and Ritu on Scale; a locked voice is shown but cannot be played.",
    tasks: [
      "Change an agent's voice: pick a voice in the dropdown on the agent (for people who manage the organisation). It saves at once.",
      "Hear an agent: press play beside its voice to hear its line in that voice.",
      "See another project's agents: press the project's chip at the top.",
      "Compare plans: the Plans card lists which agents each plan carries.",
    ],
  },

  // --- Team and Settings -----------------------------------------------------------
  {
    key: "settings",
    title: "Settings",
    where: "Settings, at the foot of the menu",
    href: "/dashboard/settings",
    anyOf: [
      "org:read",
      "org:manage",
      "role:read",
      "role:manage",
      "integration:manage",
      "project:read",
      "project:create",
      "campaign:publish",
      "campaign.budget:manage",
      "billing:read",
      "audit:read",
    ],
    about:
      "The organisation's details, what needs finishing, and at a glance the roles, the calling team, the connected accounts and Ask Jimmy. The list on the left opens every setting your role allows: Legal entities, Plan and usage, Audit trail, Roles and permissions, Single sign-on, Buyer phone numbers, Calling and sales team, Calling numbers, Lead rules, Connected accounts and Token payments.",
    tasks: [
      "Let Jimmy take actions or answer only: \"Ask Jimmy\" under At a glance, \"Switch on\" or \"Switch off\".",
    ],
  },
  {
    key: "connections",
    title: "Connected accounts",
    where: "Settings, then Connected accounts",
    href: "/dashboard/settings/connections",
    anyOf: ["integration:manage", "campaign:publish", "campaign.budget:manage"],
    about:
      "Where posts and ads go: your Meta (Facebook Page, Instagram, Meta ad account) and Google (Google Ads, Business Profile) accounts, plus cards for your CRM, WhatsApp and Service SMS, and what each lead outcome is worth to the ads.",
    tasks: [
      "Connect Meta (Facebook Page, Instagram and Meta ad account): press \"Connect Meta\", sign in to Facebook and allow access. You come back to the Meta accounts page: tick the Pages, Instagram accounts and ad accounts posts should go to, choose where each is used, then \"Save accounts\". Then set a daily limit on each ad account and press \"Save limit\"; no ad is created without one.",
      "Connect Google (Google Ads and Business Profile): \"Connect Google\", sign in, then choose the accounts the same way.",
      "Already connected: \"Open\" on the card, then \"Change accounts\", \"Reconnect\" or \"Disconnect\" at the top.",
      "Connect a CRM: \"Connect a CRM\" on the CRM card. Connect WhatsApp: \"Connect WhatsApp\". SMS: \"Add DLT details\".",
      "Connecting needs the integrations permission; setting daily limits needs the budget permission.",
    ],
  },
  {
    key: "connection_account",
    title: "Meta accounts or Google accounts",
    page: { record: "provider", path: "/dashboard/settings/connections/{id}", label: "{name} accounts" },
    where: "Settings, Connected accounts, then \"Open\" on the Meta or Google card",
    anyOf: ["integration:manage", "campaign:publish", "campaign.budget:manage"],
    about:
      "The accounts a Meta or Google connection reaches, which ones posts go to and where each is used, each ad account's daily limit, and the connection itself.",
    tasks: [
      "Change which accounts posts go to: \"Change accounts\", tick them, then \"Save accounts\".",
      "Set an ad account's daily limit: type the rupees under \"Daily limits\", then \"Save limit\".",
      "Let budget move to the ads bringing buyers: the switch \"Move budget to the ads that bring buyers\".",
      "Make a Meta ad account's new ads look for qualified buyers rather than clicks: \"Optimise for qualified buyers\" under \"Bid on qualified buyers\", once the account has brought 200 leads in 30 days.",
      "\"Check it now\" tests the connection; \"Reconnect\" signs in again; \"Disconnect\" at the top removes it (spending ads are paused first).",
    ],
  },
  {
    key: "whatsapp",
    title: "WhatsApp numbers",
    where: "Settings, Connected accounts, then the WhatsApp card",
    href: "/dashboard/settings/connections/whatsapp",
    anyOf: ["integration:manage"],
    about: "Your own WhatsApp Business number that messages go to buyers from, its quality and sending limit, and the message templates Meta has approved.",
    tasks: [
      "Connect: choose \"Keep your current number\" or \"Use a new number\", then \"Connect WhatsApp\" and finish Meta's sign-in window.",
      "Another number: \"Add a number\". Send the message templates to Meta for approval: \"Send N messages to Meta\".",
    ],
  },
  {
    key: "crm",
    title: "CRM",
    where: "Settings, Connected accounts, then the CRM card",
    href: "/dashboard/settings/connections/crm",
    anyOf: ["integration:manage"],
    about: "Your CRM (LeadSquared, Sell.Do or LeadRat) kept in step with leads here, and how its projects, people and statuses match ours.",
    tasks: [
      "Connect: pick the CRM, paste its keys, then \"Connect\" (the button names the CRM).",
      "Match its projects and statuses: \"Change matches\", then \"Save matches\". \"Sync now\" syncs at once.",
    ],
  },
  {
    key: "sms",
    title: "Service SMS",
    where: "Settings, Connected accounts, then the Service SMS card",
    href: "/dashboard/settings/connections/sms",
    anyOf: ["integration:manage"],
    about: "Your DLT registration and each SMS template id, for buyers WhatsApp cannot reach.",
    tasks: ["\"Change\", fill in the entity id, header and template ids, then \"Save\"."],
  },
  {
    key: "portals",
    title: "Property portals",
    where: "Settings, Connected accounts, then the Property portals card",
    href: "/dashboard/settings/connections/portals",
    anyOf: ["integration:manage"],
    about:
      "The email address 99acres, MagicBricks, Housing.com and NoBroker lead emails are forwarded to, the link each portal can send leads to, the Housing.com account whose leads are read every ten minutes, which tower each portal's project name means, and how many leads each portal sent in the last 30 days.",
    tasks: [
      "Copy the address under \"Forward portal emails to\" into each portal account's lead email forwarding.",
      "Under \"Links portals send leads to\", \"Copy\" a portal's link and send it to your account manager at that portal.",
      "\"Connect Housing.com\", type the account ID and secret key, then \"Save and check\". \"Change key\" or \"Remove\" later.",
      "Match a project a portal named to a tower: \"Change matches\", choose the tower, then \"Save matches\". Leads waiting on it go to the board.",
      "\"Make a new address\" stops the old address and every portal link at once.",
    ],
  },
  {
    key: "calling",
    title: "Calling rules",
    where: "Settings, then Calling and sales team",
    href: "/dashboard/settings/calling",
    anyOf: ["org:manage"],
    about:
      "How the AI calls buyers (consent, the recording and AI notice, the hand-off number), whether new leads are called and messaged automatically, the monthly minutes and calls at once, the sales team who take hand-offs, and each tower's lead form address.",
    tasks: [
      "Change the call rules: \"Change rules\", then \"Save rules\".",
      "Switch automatic calling on or off, or change the limits: \"Change\" under Automation, then \"Save automation\".",
      "Add a sales person who takes calls: name and phone, then \"Add to team\". \"On duty\" or \"Off duty\" switches them.",
      "Meta lead forms arrive once Meta is connected: \"Connect Meta\" or \"Choose a Page\" there.",
    ],
  },
  {
    key: "lead_rules",
    title: "Lead rules",
    where: "Settings, then Lead rules",
    href: "/dashboard/settings/leads",
    anyOf: ["org:manage"],
    about: "What makes a lead hot, warm or cold, how a returning buyer is treated, areas and rival projects, and who takes buyers calling from abroad. Bank tie-ups are under Home loans, Banks.",
    tasks: ["Each section: \"Change\", then \"Save\"."],
  },
  {
    key: "phone_numbers",
    title: "Buyer phone numbers",
    where: "Settings, then Buyer phone numbers",
    href: "/dashboard/settings/phone-numbers",
    anyOf: ["org:read"],
    about: "What each role sees of a buyer's phone number and email (full, masked or hidden) and from which lead stage that changes.",
    tasks: ["\"Change\" on a role, choose what it sees, then \"Save\" for that role."],
  },
  {
    key: "calling_numbers",
    title: "Calling numbers",
    where: "Settings, then Calling numbers",
    href: "/dashboard/settings/calling-numbers",
    anyOf: ["integration:manage"],
    about: "Your own phone numbers: the number buyers see when the AI or a sales person calls them, and where each is used.",
    tasks: [
      "\"Get a number\", search a city or area code, pick one, choose where it is used, then \"Get this number\".",
      "\"Move\" on a number, choose the place, then \"Save\". \"Release\" gives a number back.",
    ],
  },
  {
    key: "payments",
    title: "Token payments",
    where: "Settings, then Token payments",
    href: "/dashboard/settings/payments",
    anyOf: ["integration:manage"],
    about: "Your own Razorpay account that buyers pay their booking token into.",
    tasks: ["\"Connect Razorpay\" and sign in to Razorpay. \"Disconnect\" removes it."],
  },
  {
    key: "billing",
    title: "Plan and usage",
    where: "Settings, then Plan and usage",
    href: "/dashboard/settings/billing",
    anyOf: ["billing:read"],
    about:
      "Each project's plan and this month's AI call minutes, image posts, carousels and videos used, top-up balances, Ask Jimmy questions, and billing details.",
    tasks: [
      "Buy more: \"Top up\", choose the packs, then \"Pay\" (needs the billing permission).",
      "Change billing details: \"Edit\", then \"Save details\".",
      "Pay this month's plan when it waits for you: \"Pay\" on the month's card.",
      "A channel partner moves its plan up or down on Projects: \"Move to a bigger plan\" or \"Move to a smaller plan\" (a smaller plan starts on the first of next month).",
      "Tabs: \"Plan and usage\", \"Top up\", \"Auto top-up\", \"Invoices\".",
    ],
  },
  {
    key: "top_up",
    title: "Top up",
    where: "Settings, Plan and usage, then \"Top up\"",
    href: "/dashboard/settings/billing/top-up",
    anyOf: ["billing:manage"],
    about: "Buy more AI call minutes, posts and videos, or WhatsApp credit.",
    tasks: ["Choose a minutes pack and quantities, then \"Pay\" (the button shows the total with GST)."],
  },
  {
    key: "auto_top_up",
    title: "Auto top-up",
    where: "Settings, Plan and usage, then \"Auto top-up\"",
    href: "/dashboard/settings/billing/auto",
    anyOf: ["billing:read"],
    about: "Buying a top-up by itself when minutes, posts, videos or WhatsApp credit run low, up to a monthly limit, and the top-ups it has bought.",
    tasks: [
      "Switch it on or change it: \"Change\", choose what to buy, when and the monthly limit, then \"Save auto top-up\" (needs the billing permission).",
      "A top-up waiting for you: \"Pay\" on the dark card, or \"Cancel\".",
    ],
  },
  {
    key: "invoices",
    title: "Invoices",
    where: "Settings, Plan and usage, then \"Invoices\"",
    href: "/dashboard/settings/billing/invoices",
    anyOf: ["billing:read"],
    about: "Every GST invoice and credit note, each downloadable.",
    tasks: ["\"PDF\" on a row downloads it."],
  },
  {
    key: "roles",
    title: "Roles and permissions",
    where: "Settings, then Roles and permissions",
    href: "/dashboard/settings/roles",
    anyOf: ["role:read"],
    about: "The roles we ship and roles you wrote, each with the permissions it holds.",
    tasks: [
      "Make a role: \"New role\", tick its permissions, then \"Create role\".",
      "Change one: tick or untick, then \"Save changes\". \"Reset to what we ship\" undoes your changes.",
    ],
  },
  {
    key: "developers",
    title: "Developers",
    where: "Developers, in the menu",
    href: "/dashboard/developers",
    anyOf: [],
    kinds: ["MANDATE_FIRM"],
    about:
      "Every developer you sell for: the ones you added, whose projects you work here, and the ones on Sales Desk who gave you a mandate, whose projects you open in their console. Offers to answer, your mandates, and what each booking has earned you.",
    tasks: [
      "Add a developer: \"Add a developer\", fill it in, then \"Add developer\".",
      "Answer an offer: \"Accept\" or \"Decline\" (your firm's admin).",
      "Work a developer's projects in their own console: \"Open projects\".",
      "See what a booking earned and where each half stands: the Commission table.",
      "Send your commission invoice for a half that is owed: \"Send invoice\" on that half, fill in the number, date and total, attach the PDF, then \"Send invoice\".",
    ],
  },
  {
    key: "cp_developers",
    title: "Developers",
    where: "Developers, in the menu",
    href: "/dashboard/developers",
    anyOf: [],
    kinds: ["CHANNEL_PARTNER"],
    about:
      "Every developer that empanelled you (or a mandate firm did, for them) and the ones you added yourself: where each empanelment stands and until when, what your next booking there earns, your link for each tower, the developer's approved posts with your name on them, and who is on that developer's WhatsApp for you. Tabs: \"Projects and links\", \"Registered buyers\", \"Brokerage\".",
    tasks: [
      "Get your link for a tower: \"Make my link\", then \"Copy link\".",
      "Take a post with your name and ref code on it: \"Download\" (a carousel has one per slide).",
      "Run your own ads and AI calls on a project you are empanelled on: \"Add to my projects\". Its facts, prices, pictures and registration come from the developer and only the developer can change them; then \"Open in your projects\".",
      "Add a developer whose projects you sell yourself: \"Add a developer\".",
    ],
  },
  {
    key: "cp_buyers",
    title: "Registered buyers",
    where: "Developers, then Registered buyers",
    href: "/dashboard/developers/buyers",
    anyOf: ["partner:register", "partner:read"],
    kinds: ["CHANNEL_PARTNER"],
    about:
      "Every buyer you registered with a developer: the project, whether the registration is live and until when, the visit booked, and why one was refused. Numbers are masked.",
    tasks: [
      "Register a buyer with a developer: \"Register a buyer\", choose the project, then \"Register buyer\".",
      "Register one of your own leads: on the lead's page, choose the project, then \"Register with developer\".",
      "Keep a buyer who is about to run out: \"Book a visit\", then \"Book the visit\".",
      "Register a buyer with a developer not on Sales Desk: first add where it takes registrations (Developers, the developer's \"Set up registrations\"), then \"Register a buyer\" and \"Register and email developer\". The developer is emailed from here and you are copied.",
      "Record what such a developer answered, or that the buyer booked: \"Confirmed\", \"Refused\" or \"Booked\" on the buyer's row under \"With developers not on Sales Desk\".",
    ],
  },
  {
    key: "cp_brokerage",
    title: "Brokerage",
    where: "Developers, then Brokerage",
    href: "/dashboard/developers/payouts",
    anyOf: ["payout:read"],
    kinds: ["CHANNEL_PARTNER"],
    about:
      "What each booking owes you from the developer, in two halves: not due yet and why, send your invoice (with the gross amount), with the developer, being approved, or paid with the bank's reference.",
    tasks: [
      "Know what to invoice: a half marked \"Send your invoice\" names the gross amount and who to send it to.",
      "Send your invoice to the developer: \"Send invoice\" on that half, fill in the number, date and total, attach the PDF, then \"Send invoice\".",
      "For a developer not on Sales Desk: \"Record a booking\", then \"Make invoice\" makes your own GST invoice (numbered BRK/...), downloadable as a PDF; \"Record payment\" when the developer pays.",
    ],
  },
  {
    key: "firm",
    title: "Your firm",
    where: "Settings, then Your firm",
    href: "/dashboard/settings/firm",
    anyOf: ["org:read", "org:manage"],
    kinds: ["MANDATE_FIRM", "CHANNEL_PARTNER"],
    about: "Your firm's MahaRERA agent number and until when it is valid, your city and phone number.",
    tasks: ["Change them: \"Edit\", then \"Save\"."],
  },
  {
    key: "entities",
    title: "Legal entities",
    where: "Settings, then Legal entities",
    href: "/dashboard/settings/entities",
    anyOf: ["project:read", "project:create"],
    kinds: ["DEVELOPER"],
    about: "The companies (SPVs) your projects are registered under for RERA, with PAN and CIN or LLPIN.",
    tasks: ["Add one: \"Add an entity\", fill it in, then \"Create entity\". Change one: \"Edit\", then \"Save entity\"."],
  },
  {
    key: "entities_firm",
    title: "Developers' legal details",
    where: "Settings, then Developers' legal details",
    href: "/dashboard/settings/entities",
    anyOf: ["project:read", "project:create"],
    kinds: ["MANDATE_FIRM", "CHANNEL_PARTNER"],
    about: "Each developer company you sell for, named exactly as on its RERA registration, with its PAN and CIN or LLPIN.",
    tasks: ["Add one: \"Add a developer\", fill it in, then \"Add developer\". Change one: \"Edit\", then \"Save developer\"."],
  },
  {
    key: "audit",
    title: "Audit trail",
    where: "Settings, then Audit trail",
    href: "/dashboard/settings/audit",
    anyOf: ["audit:read"],
    about: "Who did what and when across the company, newest first. Read only.",
    tasks: ["Filter by Who, Area and dates, then \"Show\"."],
  },
  {
    key: "sso",
    title: "Single sign-on",
    where: "Settings, then Single sign-on",
    href: "/dashboard/settings/sso",
    anyOf: ["org:manage"],
    about: "Signing in through your company's identity provider, the domains it covers, and adding and removing people automatically.",
    tasks: ["Set up the provider, then \"Test sign-in\". \"Require single sign-on\" makes it the only way in."],
  },
];

export function screenByKey(key: string): Screen | undefined {
  return SCREENS.find((s) => s.key === key);
}

/** The screens this person can open, and the ones they cannot. */
/** The screens a developer's console does not offer a firm working through a mandate: its rail (`console.ts`) and Jimmy alike. */
export const NOT_THROUGH_MANDATE_SCREENS: readonly string[] = ["team", "settings", "reports"];

export function screensFor(
  access: ScreenAccess,
  orgType = "DEVELOPER",
  viaMandate = false,
): { open: Screen[]; closed: Screen[] } {
  const open: Screen[] = [];
  const closed: Screen[] = [];
  // A screen another kind of company has is neither open nor closed here:
  // telling a developer it needs access to Developers would send them looking.
  // Nor is one the console leaves out for a firm working through a mandate.
  for (const s of SCREENS) {
    if (s.kinds && !s.kinds.includes(orgType)) continue;
    if (viaMandate && NOT_THROUGH_MANDATE_SCREENS.includes(s.key)) continue;
    (s.anyOf.length === 0 || s.anyOf.some((p) => access.can(p)) ? open : closed).push(s);
  }
  return { open, closed };
}

/** The map as Jimmy reads it: every open screen whole, the closed ones by name. */
const PAGE_OF: Record<RecordKind, string> = {
  lead: "lead",
  project: "project",
  place: "project or tower",
  brief: "campaign (its brief)",
  provider: "connection (Meta or Google)",
};

export function helpCatalog(split: { open: readonly Screen[]; closed: readonly Screen[] }): string {
  const blocks = split.open.map((s) =>
    [
      `### ${s.key}: ${s.title} (${s.where})`,
      s.about,
      ...(s.page ? [`Direct page for one ${PAGE_OF[s.page.record]}: use find_page.`] : []),
      ...s.tasks.map((t) => `- ${t}`),
    ].join("\n"),
  );
  if (split.closed.length) {
    blocks.push(
      `### Screens this person cannot open\n${split.closed.map((s) => `- ${s.title} (${s.where})`).join("\n")}`,
    );
  }
  return blocks.join("\n\n");
}

/** One line a screen: for the analyst, who says which screen does what Jimmy cannot. */
export function screenIndex(open: readonly Screen[]): string {
  return open.map((s) => `- ${s.title} (${s.where}): ${s.about.split(". ")[0].replace(/\.$/, "")}`).join("\n");
}

export function helpInstructions(input: { orgName: string; personName: string | null; catalog: string }): string {
  return [
    `You are Jimmy, the assistant inside Sales Desk, the sales and marketing console ${input.personName ?? "this person"} at ${input.orgName} is using right now. They asked how to use the console itself: where something is, or how to do something in it. Answer from the map below and from nothing else. Call answer_help once.`,
    "",
    "How to answer:",
    "- One to four short sentences, or a short numbered list of steps when there are several. Simple words, in the language the person used; Hinglish if they wrote Hinglish.",
    "- Say where to go first (\"Open Settings, then Connected accounts\"), then what to press.",
    "- Put a button's words in double quotes exactly as the map writes them. Never invent a button, a tab, a menu or a step the map does not have. If the map does not say how, say which screen to open and that the rest is on that screen.",
    "- In screens, name the key of every screen you tell them to open (up to three). Each becomes a link they can press.",
    "- When they want one particular record's page (a lead, a project, a tower's library or facts, a campaign's brief, studio or schedule, the Meta accounts page), call find_page with that screen's key and the words they used for the record. It lists that record's pages with ids; put the id of the page they asked for in pages (the studio when they said studio). Then answer in one short sentence (\"Here is the studio for Diwali 2026 at Tower C.\") and do not describe how to get there: the link is the answer.",
    "- If find_page finds several, link up to three of them, or ask which one they mean. If it finds none, say what does exist, from what it lists.",
    "- A screen under \"Screens this person cannot open\" is one they need access for: say so, say to ask their admin, and never describe how to use it.",
    "- If the console has no screen for what they want, say so plainly. Never promise something that is not built.",
    "- Up to three follow_ups: short next questions about using the console.",
    "- Never use a dash as punctuation.",
    "",
    "## The console",
    "",
    input.catalog,
  ].join("\n");
}

export const HELP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "screens", "pages", "follow_ups"],
  properties: {
    text: { type: "string", description: "The answer: where to go and what to press." },
    screens: { type: "array", items: { type: "string" }, description: "Keys of the screens to link, up to three." },
    pages: { type: "array", items: { type: "string" }, description: "Page ids find_page gave, to link one record's own page." },
    follow_ups: { type: "array", items: { type: "string" }, description: "Up to three short next questions." },
  },
};

// ---------------------------------------------------------------------------
// One record's page: which record the person meant
// ---------------------------------------------------------------------------

/** A record a page can open, as the lookup found it. */
export type PageRecord = { id: string; label: string; path?: string | null; note?: string | null };

/** Words that name nothing: "a direct link to the studio for my campaign". */
const NOISE = new Set([
  "the", "a", "an", "of", "for", "in", "on", "at", "to", "my", "our", "me", "please", "direct", "link", "page",
  "open", "provide", "give", "show", "ka", "ki", "ke", "ko", "wala", "wali", "wale", "se",
]);

export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w && !NOISE.has(w));
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** One word of the question against one of a record's: equal, one letter off in a word of four or more, or its start. */
function near(q: string, w: string): boolean {
  if (q === w) return true;
  if (q.length >= 4 && w.length >= 4 && distance(q, w) <= 1) return true;
  return q.length >= 3 && w.startsWith(q);
}

/** How much of what the person said a record's label carries, 0 to 1. "seth heights tower c" is Sath Heights · Tower C. */
export function matchScore(said: string, label: string): number {
  const q = wordsOf(said);
  if (!q.length) return 0;
  const l = wordsOf(label);
  return q.filter((t) => l.some((w) => near(t, w))).length / q.length;
}

/**
 * The records a person meant: those that carry the most of what they said,
 * and at least half of it. One is the page; several are a choice, never a
 * guess; none is a list of what does exist.
 */
export function bestRecords<T extends PageRecord>(said: string, records: readonly T[]): T[] {
  if (!wordsOf(said).length) return records.length === 1 ? [...records] : [];
  const scored = records.map((r) => ({ r, s: matchScore(said, r.label) }));
  const top = Math.max(0, ...scored.map((x) => x.s));
  if (top < 0.5) return [];
  return scored.filter((x) => x.s >= top - 1e-9).map((x) => x.r);
}

/** A record's page address. */
export function pageHref(screen: Screen, id: string): string | null {
  return screen.page ? screen.page.path.replace("{id}", encodeURIComponent(id)) : null;
}

/** What a record's page link says after "Open": "the studio for Diwali 2026, Sath Heights · Tower C". */
export function pageLabel(screen: Screen, record: PageRecord): string {
  return (screen.page?.label ?? "{name}").replace("{name}", record.label);
}

/**
 * The other pages the same record opens, among the screens this person can
 * open: a campaign's brief, studio and schedules; a tower's library,
 * campaigns, facts and documents. Asked for the studio, a model that looked
 * the campaign up on the brief screen still has the studio to link.
 */
export function siblingPages(screen: Screen, open: readonly Screen[]): Screen[] {
  const kind = screen.page?.record;
  if (!kind) return [];
  return [screen, ...open.filter((s) => s !== screen && s.page?.record === kind)];
}

export const FIND_PAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["screen", "said"],
  properties: {
    screen: { type: "string", description: "The key of a screen that has a page per record." },
    said: { type: "string", description: "How the person named the record: a lead's name, a project or tower, a campaign and its tower." },
  },
};

/**
 * A question asking for a link or a page, whatever the router made of it.
 * "A direct link for the studio of the Tower C campaign" names a campaign and
 * a tower, and the router sent it to the data path, which answered that the
 * campaign had no posts. Asking for a link is asking where to go.
 */
export function wantsLink(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(link|links|url|hyperlink|take me (to|there)|navigate to|kholo|khol do|le chalo)\b/.test(q) ||
    /\b(page|screen) (for|of)\b/.test(q) ||
    /\bopen (the |my |a |an )?[\w' ]{0,40}\b(page|screen|studio|brief|schedule|library|brain)\b/.test(q)
  );
}

/** The screens an answer may link: open ones, by key, with a path. */
export function helpLinks(keys: readonly string[], open: readonly Screen[]): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  for (const k of keys) {
    const s = open.find((x) => x.key === k);
    if (!s?.href || out.some((l) => l.href === s.href)) continue;
    out.push({ label: s.title, href: s.href });
  }
  return out.slice(0, 3);
}

/**
 * Anything an answer puts in double quotes that no screen it may describe
 * carries: a button, a tab or a heading nobody will find.
 */
export function quotedOutsideMap(text: string, screens: readonly Screen[]): string[] {
  const words = screens
    .flatMap((s) => [s.title, s.where, s.about, ...s.tasks])
    .join("\n")
    .toLowerCase();
  const quoted = [...text.matchAll(/["“]([^"”]{2,80})["”]/g)].map((m) => m[1].trim());
  return [...new Set(quoted)].filter((q) => !words.includes(q.toLowerCase()));
}

/** Screens an answer names by title, for its links when it gave no keys. */
export function screensNamedIn(text: string, open: readonly Screen[]): string[] {
  const named = (title: string) => new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  return open.filter((s) => s.href && named(s.title)).map((s) => s.key);
}
