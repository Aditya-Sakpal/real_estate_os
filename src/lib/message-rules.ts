/**
 * WhatsApp messages to a buyer: which template says what, what each costs,
 * and whether one may go to this number now. Pure and database-free,
 * covered by `check:logic`.
 *
 * Outside the 24 hours after a buyer last wrote to us, WhatsApp only carries
 * templates Meta approved in advance, so every message here is a template
 * with numbered blanks. `doc/whatsapp-templates.md` is the list to submit;
 * the names and bodies below are the source it is written from, and a
 * template that is renamed here has to be approved again under its new name.
 *
 * Two categories, priced 7.5 times apart. A utility message answers
 * something the buyer started (their enquiry, their visit, their booking)
 * and costs Rs 0.115. A marketing message is a nudge and costs Rs 0.8631, so
 * the gate below only lets one out inside calling hours and with consent.
 * The cheapest honest category is always the one chosen.
 */

import { CALLING_HOURS, ENQUIRY_DAYS, istHour } from "./calling-hours.ts";
import type { ConsentRow } from "./calling-rules.ts";

export type MessagePurpose =
  | "ACK"
  | "AFTER_CALL"
  | "MISSED_CALL"
  | "VISIT_CONFIRMED"
  | "VISIT_REMINDER_DAY"
  | "VISIT_REMINDER_SOON"
  | "NO_SHOW"
  | "NO_SHOW_FOLLOWUP"
  | "POST_VISIT"
  | "POST_VISIT_FOLLOWUP"
  | "BOOKING"
  | "REFERRAL"
  | "BOOKED_CHECKIN"
  | "NURTURE"
  | "SITE_LOCATION"
  | "PARTNER_PAYOUT"
  | "SLOT_OFFER"
  | "VISIT_REOFFER"
  | "VISIT_CANCELLED"
  | "VISIT_EMI"
  | "LENDER_ASK"
  | "LOAN_SHARE_ASK"
  | "REVISIT_OFFER"
  | "TOKEN_LINK"
  | "PROJECT_DETAILS";

export type Category = "UTILITY" | "MARKETING";

/** What Meta charges in India from 1 July 2026, in paise, rounded up. */
export const PRICE_PAISE: Record<Category, number> = { UTILITY: 12, MARKETING: 87 };

export type Blank =
  | "first_name"
  | "project"
  | "developer"
  | "when"
  | "directions"
  | "contact"
  | "next_step"
  | "booking"
  | "update"
  | "slot_1"
  | "slot_2"
  | "slot_3"
  | "pass"
  | "unit"
  | "loan"
  | "rate"
  | "emi_15"
  | "emi_20"
  | "emi_25"
  | "lender"
  | "advisor"
  | "amount"
  | "link"
  | "flat"
  | "ad_line"
  | "highlights"
  | "registration";

export type Template = {
  /** A lead-engine message, or a broadcast (`broadcast-rules.ts`). */
  purpose: MessagePurpose | "BROADCAST";
  /** The name it is approved under. */
  name: string;
  category: Category;
  /**
   * Whether the message names the tower. A phase that may not be advertised
   * gets only the ones that do not, because Section 3 bars advertising it,
   * and a WhatsApp naming a tower to a stranger is an advertisement.
   */
  namesProject: boolean;
  /** Tied to a visit the buyer booked, so an open booking is a reason to send it. */
  aboutVisit: boolean;
  /** Tied to a booking the buyer made. */
  aboutBooking: boolean;
  blanks: Blank[];
  /** English, with {{1}}, {{2}} in the order of `blanks`. */
  body: string;
  /**
   * Quick-reply buttons, fixed words approved with the body. Each send
   * attaches its own payload to each (the hour it books), so the words
   * never change and the choice still names one hour.
   */
  buttons?: readonly string[];
  /**
   * A promotion in the client's sense (a nudge, a check-in, a referral ask, a
   * broadcast), whatever category Meta filed it under. Only these answer to
   * "Stop promotions" and to the cap of four in thirty days; Meta's category
   * still decides the hours, the consent and the price.
   */
  promotional?: boolean;
  /** A picture above the body, changed with every send (a broadcast's post). */
  header?: "IMAGE";
  /** Fixed small print under the body. */
  footer?: string;
  /**
   * The English and the Marathi (in English letters) versions of the same
   * message, filed at Meta under their own names (`versionOf()`). The
   * `body` above is the Hinglish one, under the plain name.
   */
  versions: Record<"ENGLISH" | "MARATHI", { body: string; buttons?: readonly string[]; footer?: string }>;
  /** Which version this is; the catalog entry itself is Hinglish. */
  voice?: Voice;
  /** What the timeline calls it. */
  label: string;
};

export const TEMPLATES: Record<MessagePurpose, Template> = {
  ACK: {
    purpose: "ACK",
    name: "salesdesk_enquiry_received",
    category: "UTILITY",
    namesProject: false,
    aboutVisit: false,
    aboutBooking: false,
    blanks: ["first_name", "developer"],
    body: "Hi {{1}}, {{2}} ke saath enquiry karne ke liye thank you! Hamari team aapko subah 10 baje ke baad call karegi. Koi aur time better ho toh yahin reply karke bata dijiye.",
    label: "Enquiry received",
    versions: {
      ENGLISH: { body: "Hi {{1}}, thank you for your enquiry with {{2}}! Our team will call you after 10 am. If another time suits you better, just reply here." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} kade chaukashi kelyabaddal dhanyavaad! Aamchi team tumhala sakali 10 nantar call karel. Dusri vel soyichi asel tar ithech reply karun kalva." },
    },
  },
  AFTER_CALL: {
    purpose: "AFTER_CALL",
    name: "salesdesk_after_call",
    // Meta reviewed this as marketing (29 September 2026), so it is sent as one:
    // inside calling hours, with consent.
    category: "MARKETING",
    namesProject: true,
    aboutVisit: false,
    aboutBooking: false,
    blanks: ["first_name", "project", "next_step", "contact"],
    body: "Hi {{1}}, {{2}} ke baare mein baat karne ke liye thank you. {{3}} Kuch aur jaanna ho toh {{4}} par call karein ya yahin reply karein.",
    label: "After the call",
    versions: {
      ENGLISH: { body: "Hi {{1}}, thank you for talking to us about {{2}}. {{3}} For anything else, call {{4}} or reply here." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} baddal bolalyabaddal dhanyavaad. {{3}} Aankhi kahi jaanun ghyaycha asel tar {{4}} var call kara kinva ithech reply kara." },
    },
  },
  MISSED_CALL: {
    purpose: "MISSED_CALL",
    name: "salesdesk_missed_call",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: false,
    aboutBooking: false,
    blanks: ["first_name", "project"],
    body: "Hi {{1}}, humne {{2}} ki aapki enquiry ke liye call kiya tha, par baat nahi ho paayi. Aapke liye kaunsa time theek rahega? Yahin reply kar dijiye, hum tab call karenge.",
    label: "Missed call",
    versions: {
      ENGLISH: { body: "Hi {{1}}, we called about your enquiry for {{2}} but could not reach you. What time works for you? Reply here and we will call you then." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} chya tumchya chaukashi sathi aamhi call kela hota, pan bolne jhale nahi. Tumhala konti vel soyichi aahe? Ithech reply kara, aamhi tevha call karu." },
    },
  },
  VISIT_CONFIRMED: {
    purpose: "VISIT_CONFIRMED",
    name: "salesdesk_visit_confirmed",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project", "when", "directions", "pass"],
    body: "Hi {{1}}, {{2}} ka aapka site visit {{3}} ke liye confirm hai. Location: {{4}} Gate par yeh pass dikhaiye: {{5}} Time badalna ho toh yahin reply kar dijiye.",
    label: "Visit confirmed",
    versions: {
      ENGLISH: { body: "Hi {{1}}, your site visit to {{2}} is confirmed for {{3}}. Location: {{4}} Show this pass at the gate: {{5}} To change the time, just reply here." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} chi tumchi site visit {{3}} la confirm aahe. Location: {{4}} Gate var ha pass dakhva: {{5}} Vel badlaychi asel tar ithech reply kara." },
    },
  },
  VISIT_REMINDER_DAY: {
    purpose: "VISIT_REMINDER_DAY",
    name: "salesdesk_visit_tomorrow",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project", "when", "directions"],
    body: "Hi {{1}}, ek reminder: {{2}} ka aapka site visit {{3}} ko hai. Location: {{4}} Time badalna ho toh yahin reply kar dijiye.",
    label: "Visit reminder, a day before",
    versions: {
      ENGLISH: { body: "Hi {{1}}, a reminder: your site visit to {{2}} is on {{3}}. Location: {{4}} To change the time, just reply here." },
      MARATHI: { body: "Namaskar {{1}}, aathvan karun deto: {{2}} chi tumchi site visit {{3}} la aahe. Location: {{4}} Vel badlaychi asel tar ithech reply kara." },
    },
  },
  VISIT_REMINDER_SOON: {
    purpose: "VISIT_REMINDER_SOON",
    name: "salesdesk_visit_today",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project", "when", "directions"],
    body: "Hi {{1}}, aaj {{2}} par aapse milne ka intezaar hai. Time: {{3}}. Location: {{4}} Late ho rahe hon toh yahin bata dijiye.",
    label: "Visit reminder, two hours before",
    versions: {
      ENGLISH: { body: "Hi {{1}}, we look forward to seeing you at {{2}} today. Time: {{3}}. Location: {{4}} If you are running late, just let us know here." },
      MARATHI: { body: "Namaskar {{1}}, aaj {{2}} var aamhi tumchi vaat baghto aahot. Vel: {{3}}. Location: {{4}} Ushir hot asel tar ithech kalva." },
    },
  },
  NO_SHOW: {
    purpose: "NO_SHOW",
    name: "salesdesk_visit_missed",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project"],
    body: "Hi {{1}}, aaj {{2}} par aapse mulaqat nahi ho paayi. Jo din aur time aapko suit kare, yahin reply kar dijiye, hum naya visit book kar denge.",
    label: "Missed visit",
    versions: {
      ENGLISH: { body: "Hi {{1}}, we missed you at {{2}} today. Reply here with a day and time that suit you, and we will book a new visit." },
      MARATHI: { body: "Namaskar {{1}}, aaj {{2}} var tumchi bhet jhali nahi. Tumhala soyicha divas aani vel ithech reply kara, aamhi navin visit book karu." },
    },
  },
  NO_SHOW_FOLLOWUP: {
    purpose: "NO_SHOW_FOLLOWUP",
    name: "salesdesk_visit_rebook",
    // Meta reviewed this as marketing (29 September 2026), so it is sent as one:
    // inside calling hours, with consent.
    category: "MARKETING",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project"],
    body: "Hi {{1}}, kya aap abhi bhi {{2}} dekhna chahenge? Jo din suit kare yahin reply kar dijiye, hum visit arrange kar denge.",
    label: "Rebook the visit",
    versions: {
      ENGLISH: { body: "Hi {{1}}, would you still like to see {{2}}? Reply here with a day that suits you, and we will arrange the visit." },
      MARATHI: { body: "Namaskar {{1}}, tumhala ajun {{2}} baghaycha aahe ka? Soyicha divas ithech reply kara, aamhi visit arrange karu." },
    },
  },
  POST_VISIT: {
    purpose: "POST_VISIT",
    name: "salesdesk_after_visit",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project", "contact"],
    body: "Hi {{1}}, aaj {{2}} visit karne ke liye thank you. Koi bhi sawaal ho toh {{3}} par call karein ya yahin reply karein.",
    label: "Thank you for visiting",
    versions: {
      ENGLISH: { body: "Hi {{1}}, thank you for visiting {{2}} today. For any questions, call {{3}} or reply here." },
      MARATHI: { body: "Namaskar {{1}}, aaj {{2}} la bhet dilyabaddal dhanyavaad. Kahi prashna asel tar {{3}} var call kara kinva ithech reply kara." },
    },
  },
  POST_VISIT_FOLLOWUP: {
    purpose: "POST_VISIT_FOLLOWUP",
    name: "salesdesk_after_visit_followup",
    // Meta reviewed this as marketing (29 September 2026), so it is sent as one:
    // inside calling hours, with consent.
    category: "MARKETING",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project"],
    body: "Hi {{1}}, {{2}} ke visit ke baad follow up kar rahe hain. Kya aapko payment plan chahiye, ya family ke saath ek aur visit karna chahenge? Yahin reply kar dijiye, hum arrange kar denge.",
    label: "Follow-up after the visit",
    versions: {
      ENGLISH: { body: "Hi {{1}}, following up on your visit to {{2}}. Would you like the payment plan, or another visit with your family? Reply here and we will arrange it." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} chya visit nantar follow up karat aahot. Tumhala payment plan hava aahe ka, ki family barobar aankhi ek visit karaychi aahe? Ithech reply kara, aamhi arrange karu." },
    },
  },
  BOOKING: {
    purpose: "BOOKING",
    name: "salesdesk_booking_welcome",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: false,
    aboutBooking: true,
    blanks: ["first_name", "project", "contact"],
    body: "Hi {{1}}, {{2}} mein aapke naye ghar ke liye bahut bahut badhai! Aage ke steps ke liye hamari team aapse contact karegi. Kuch bhi chahiye toh {{3}} par call karein ya yahin reply karein.",
    label: "Booking welcome",
    versions: {
      ENGLISH: { body: "Hi {{1}}, congratulations on your new home at {{2}}! Our team will be in touch about the next steps. For anything you need, call {{3}} or reply here." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} madhe tumchya navin gharasathi khup khup abhinandan! Pudhchya steps sathi aamchi team tumhala contact karel. Kahihi lagla tar {{3}} var call kara kinva ithech reply kara." },
    },
  },
  REFERRAL: {
    purpose: "REFERRAL",
    name: "salesdesk_referral",
    category: "MARKETING",
    promotional: true,
    namesProject: true,
    aboutVisit: false,
    aboutBooking: true,
    blanks: ["first_name", "project"],
    body: "Hi {{1}}, {{2}} chunne ke liye thank you. Agar aapke friends ya family bhi ghar dhoondh rahe hain, toh unka naam aur number yahin reply kar dijiye, hamari team unse contact karegi.",
    label: "Referral ask",
    versions: {
      ENGLISH: { body: "Hi {{1}}, thank you for choosing {{2}}. If your friends or family are also looking for a home, reply here with their name and number and our team will get in touch." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} nivadalyabaddal dhanyavaad. Tumche mitra kinva natevaik pan ghar shodhat asatil tar tyanche nav aani number ithech reply kara, aamchi team tyanna contact karel." },
    },
  },
  BOOKED_CHECKIN: {
    purpose: "BOOKED_CHECKIN",
    name: "salesdesk_owner_checkin",
    category: "MARKETING",
    promotional: true,
    namesProject: true,
    aboutVisit: false,
    aboutBooking: true,
    blanks: ["first_name", "project"],
    body: "Hi {{1}}, {{2}} se bas haal chaal poochne ke liye message kiya. Ghar se judi kisi bhi cheez mein help chahiye toh yahin reply kar dijiye.",
    label: "Monthly check-in",
    versions: {
      ENGLISH: { body: "Hi {{1}}, just checking in from {{2}}. If you need help with anything about your home, reply here." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} kadun fakt tumchi khushali vicharaycha message. Gharasambandhi kahi madat lagli tar ithech reply kara." },
    },
  },
  NURTURE: {
    purpose: "NURTURE",
    name: "salesdesk_nurture",
    category: "MARKETING",
    promotional: true,
    namesProject: true,
    aboutVisit: false,
    aboutBooking: false,
    blanks: ["first_name", "project"],
    body: "Hi {{1}}, abhi bhi ghar dhoondh rahe hain? {{2}} mein site visit roz hote hain. Jo din suit kare yahin reply kar dijiye, hum arrange kar denge.",
    label: "Monthly nudge",
    versions: {
      ENGLISH: { body: "Hi {{1}}, still looking for a home? Site visits at {{2}} happen every day. Reply here with a day that suits you, and we will arrange it." },
      MARATHI: { body: "Namaskar {{1}}, ajun ghar shodhat aahat ka? {{2}} la site visit roj hotat. Soyicha divas ithech reply kara, aamhi arrange karu." },
    },
  },
  SITE_LOCATION: {
    purpose: "SITE_LOCATION",
    name: "salesdesk_site_location",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: false,
    aboutBooking: false,
    blanks: ["first_name", "project", "directions"],
    body: "Hi {{1}}, {{2}} tak pahunchne ka raasta yeh raha: {{3}} Raaste mein koi help chahiye toh yahin reply kar dijiye, hamari team guide karegi.",
    label: "Site location",
    versions: {
      ENGLISH: { body: "Hi {{1}}, here is the way to {{2}}: {{3}} If you need help on the way, reply here and our team will guide you." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} la pohochnyacha rasta ha aahe: {{3}} Rastyat kahi madat lagli tar ithech reply kara, aamchi team guide karel." },
    },
  },
  // To a channel partner, not a buyer: every step a payout takes, unprompted
  // (section 07). Sent by `partner-bot.ts`, never through the buyer's gate.
  PARTNER_PAYOUT: {
    purpose: "PARTNER_PAYOUT",
    name: "salesdesk_partner_payout",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: false,
    aboutBooking: true,
    blanks: ["first_name", "project", "booking", "update"],
    body: "Namaste {{1}}, {{2}} mein {{3}} ki booking ka payout update: {{4}} Poora status dekhne ke liye yahan \"payout status\" likhiye.",
    label: "Partner payout update",
    versions: {
      ENGLISH: { body: "Hello {{1}}, payout update for {{2}}, booking {{3}}: {{4}} For the full status, type \"payout status\" here." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} madhil {{3}} chya booking cha payout update: {{4}} Sampurna status baghnyasathi ithe \"payout status\" liha." },
    },
  },
  // The hour a buyer agreed on a call was full: three others, held for ten
  // minutes, one tap each (`slot-rules.ts`).
  SLOT_OFFER: {
    purpose: "SLOT_OFFER",
    name: "salesdesk_visit_slots",
    // Meta reviewed this as marketing (29 September 2026), so it is sent as one:
    // inside calling hours, with consent.
    category: "MARKETING",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project", "slot_1", "slot_2", "slot_3"],
    body: "Hi {{1}}, {{2}} ke site visit ke liye aapka chuna hua time full ho gaya hai. Yeh time khaali hain: 1) {{3}} 2) {{4}} 3) {{5}}. Neeche se ek chun lijiye, ya yahin koi aur din likh dijiye.",
    buttons: ["Book 1", "Book 2", "Book 3"],
    label: "Visit times offered",
    versions: {
      ENGLISH: { body: "Hi {{1}}, the time you chose for your site visit to {{2}} is full. These times are free: 1) {{3}} 2) {{4}} 3) {{5}}. Pick one below, or reply here with another day." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} chya site visit sathi tumhi nivadleli vel full jhali aahe. Hya vela mokalya aahet: 1) {{3}} 2) {{4}} 3) {{5}}. Khali ek nivada, kinva ithech dusra divas liha." },
    },
  },
  // A warm lead, asked again to come and see it: a nudge, so marketing,
  // only inside calling hours and only with consent.
  VISIT_REOFFER: {
    purpose: "VISIT_REOFFER",
    name: "salesdesk_visit_reoffer",
    category: "MARKETING",
    promotional: true,
    namesProject: true,
    aboutVisit: false,
    aboutBooking: false,
    blanks: ["first_name", "project", "slot_1", "slot_2", "slot_3"],
    body: "Hi {{1}}, {{2}} dekhne aana chahenge? Yeh time khaali hain: 1) {{3}} 2) {{4}} 3) {{5}}. Ek chun lijiye, ya yahin apna time likh dijiye.",
    buttons: ["Book 1", "Book 2", "Book 3"],
    label: "Visit offered again",
    versions: {
      ENGLISH: { body: "Hi {{1}}, would you like to come and see {{2}}? These times are free: 1) {{3}} 2) {{4}} 3) {{5}}. Pick one, or reply here with a time that suits you." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} baghayla yayla aavdel ka? Hya vela mokalya aahet: 1) {{3}} 2) {{4}} 3) {{5}}. Ek nivada, kinva ithech tumchi vel liha." },
    },
  },
  VISIT_CANCELLED: {
    purpose: "VISIT_CANCELLED",
    name: "salesdesk_visit_cancelled",
    category: "UTILITY",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project", "when"],
    body: "Hi {{1}}, {{2}} ka aapka site visit {{3}} ka cancel ho gaya hai. Naya time chahiye toh yahin reply kar dijiye, hum arrange kar denge.",
    label: "Visit cancelled",
    versions: {
      ENGLISH: { body: "Hi {{1}}, your site visit to {{2}} on {{3}} has been cancelled. If you would like a new time, reply here and we will arrange it." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} chi tumchi {{3}} chi site visit cancel jhali aahe. Navin vel havi asel tar ithech reply kara, aamhi arrange karu." },
    },
  },
  // After a visit where price held the buyer back: the EMI on the unit they
  // saw, from the approved price and the signed loan rate. Marketing, so
  // only inside calling hours and only with consent.
  VISIT_EMI: {
    purpose: "VISIT_EMI",
    name: "salesdesk_visit_emi",
    category: "MARKETING",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project", "unit", "loan", "rate", "emi_15", "emi_20", "emi_25"],
    body: "Hi {{1}}, {{2}} ke {{3}} ke liye andaazan EMI, {{4}} ke home loan par {{5}} saalana rate se: 15 saal ₹{{6}}, 20 saal ₹{{7}}, 25 saal ₹{{8}} har mahina. Final loan aur rate bank tay karega.",
    label: "EMI after the visit",
    versions: {
      ENGLISH: { body: "Hi {{1}}, estimated EMI at {{2}} for the {{3}}, on a home loan of {{4}} at {{5}} a year: ₹{{6}} a month over 15 years, ₹{{7}} over 20 years, ₹{{8}} over 25 years. The bank decides the final loan and rate." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} madhil {{3}} sathi andaaje EMI, {{4}} chya home loan var {{5}} varshik darane: 15 varsha ₹{{6}}, 20 varsha ₹{{7}}, 25 varsha ₹{{8}} dar mahina. Antim loan aani dar bank tharvel." },
    },
  },
  // After a visit where a loan held the buyer back. Their number goes to
  // the lender only if they tap yes; the buttons carry which question.
  LENDER_ASK: {
    purpose: "LENDER_ASK",
    name: "salesdesk_lender_ask",
    // Meta reviewed this as marketing (29 September 2026), so it is sent as one:
    // inside calling hours, with consent.
    category: "MARKETING",
    namesProject: false,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "lender"],
    body: "Hi {{1}}, home loan mein madad ke liye kya hum aapka naam aur number {{2}} ke saath share kar sakte hain? Woh aapko sirf loan ke baare mein call karenge.",
    buttons: ["Haan, share karein", "Nahi"],
    label: "Asked about a lender",
    versions: {
      ENGLISH: { body: "Hi {{1}}, to help with your home loan, may we share your name and number with {{2}}? They will call you only about the loan.", buttons: ["Yes, share", "No"] },
      MARATHI: { body: "Namaskar {{1}}, home loan sathi madat mhanun aamhi tumche nav aani number {{2}} barobar share karu shakto ka? Te tumhala fakt loan baddal call kartil.", buttons: ["Ho, share kara", "Nako"] },
    },
  },
  // A buyer a channel partner brought, whose home loan the developer follows:
  // may the partner be told how the loan is going? The stage only. Asked
  // because the buyer's loan is their own business (DPDP), and the partner
  // sees nothing until they say yes (`doc/home-loan-partners.md`).
  LOAN_SHARE_ASK: {
    purpose: "LOAN_SHARE_ASK",
    name: "salesdesk_loan_share",
    category: "UTILITY",
    namesProject: false,
    aboutVisit: true,
    aboutBooking: true,
    blanks: ["first_name", "advisor"],
    body: "Hi {{1}}, kya hum {{2}} ko aapke home loan ka status bata sakte hain? Sirf stage, bank ya amount nahi.",
    buttons: ["Haan", "Nahi"],
    label: "Asked to share the loan stage with the partner",
    versions: {
      ENGLISH: { body: "Hi {{1}}, may we tell {{2}}, who brought you to us, how your home loan is going? Only the stage, never the bank or the amount.", buttons: ["Yes", "No"] },
      MARATHI: { body: "Namaskar {{1}}, aamhi {{2}} na tumchya home loan chi sthiti saangu shakto ka? Fakt stage, bank kiva rakkam nahi.", buttons: ["Ho", "Nako"] },
    },
  },
  // After a visit where the family has to see it: three open times.
  REVISIT_OFFER: {
    purpose: "REVISIT_OFFER",
    name: "salesdesk_revisit_family",
    category: "MARKETING",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project", "slot_1", "slot_2", "slot_3"],
    body: "Hi {{1}}, family ke saath {{2}} dobara dekhne aana chahenge? Yeh time khaali hain: 1) {{3}} 2) {{4}} 3) {{5}}. Ek chun lijiye, ya yahin apna time likh dijiye.",
    buttons: ["Book 1", "Book 2", "Book 3"],
    label: "Revisit with family offered",
    versions: {
      ENGLISH: { body: "Hi {{1}}, would you like to visit {{2}} again with your family? These times are free: 1) {{3}} 2) {{4}} 3) {{5}}. Pick one, or reply here with a time that suits you." },
      MARATHI: { body: "Namaskar {{1}}, family barobar {{2}} punha baghayla yayla aavdel ka? Hya vela mokalya aahet: 1) {{3}} 2) {{4}} 3) {{5}}. Ek nivada, kinva ithech tumchi vel liha." },
    },
  },
  // An approved quote: the flat is held and the token link is out. The
  // link is the developer's own Razorpay account's.
  TOKEN_LINK: {
    purpose: "TOKEN_LINK",
    name: "salesdesk_token_link",
    // Meta reviewed this as marketing (29 September 2026), so it is sent as one:
    // inside calling hours, with consent.
    category: "MARKETING",
    namesProject: true,
    aboutVisit: true,
    aboutBooking: false,
    blanks: ["first_name", "project", "flat", "amount", "link"],
    body: "Hi {{1}}, {{2}} mein flat {{3}} aapke liye 48 ghante ke liye hold hai. Token ₹{{4}} is link se bhariye: {{5}} Koi sawaal ho toh yahin reply kijiye.",
    label: "Token link sent",
    versions: {
      ENGLISH: { body: "Hi {{1}}, at {{2}}, flat {{3}} is held for you for 48 hours. Pay the token of ₹{{4}} with this link: {{5}} If you have any questions, reply here." },
      MARATHI: { body: "Namaskar {{1}}, {{2}} madhil flat {{3}} tumchyasathi 48 taas hold kela aahe. ₹{{4}} token hya link varun bhara: {{5}} Kahi prashna asel tar ithech reply kara." },
    },
  },
  // The details the agent promised on the call: the tower's picture on top,
  // what it starts at, and one button. The tap opens the buyer's 24 hours,
  // and the pictures and the full details follow inside them
  // (`project-details.ts`), where a message may say more than a template.
  PROJECT_DETAILS: {
    purpose: "PROJECT_DETAILS",
    name: "salesdesk_project_details",
    // It names prices, so it is filed as what it is: inside calling hours, with consent.
    category: "MARKETING",
    namesProject: true,
    aboutVisit: false,
    aboutBooking: false,
    blanks: ["first_name", "project", "registration", "highlights"],
    header: "IMAGE",
    body: "Hi {{1}}, call par jaisa kaha tha, yeh rahi {{2}} ({{3}}) ki details: {{4}}. Photos, floor plans aur payment plan ke liye neeche button dabaiye.",
    buttons: ["Details bhejiye"],
    footer: "*Starting price. Taxes and charges extra.",
    label: "Project details",
    versions: {
      ENGLISH: {
        body: "Hi {{1}}, as promised on the call, here are the details of {{2}} ({{3}}): {{4}}. Tap the button below for the photos, floor plans and payment plan.",
        buttons: ["Send the details"],
      },
      MARATHI: {
        body: "Namaskar {{1}}, call var sangitlya pramane, hi aahe {{2}} ({{3}}) chi mahiti: {{4}}. Photos, floor plans aani payment plan sathi khalcha button daba.",
        buttons: ["Mahiti pathva"],
        footer: "*Suruvatichi kimmat. Kar aani itar kharch vegla.",
      },
    },
  },
};

export const PURPOSES = Object.keys(TEMPLATES) as MessagePurpose[];

// ---------------------------------------------------------------------------
// Three versions of every message
// ---------------------------------------------------------------------------

/**
 * Every message has three versions, all in English letters and all filed at
 * Meta as English (`en`) under their own names, because Meta holds one
 * template per name and language and a Hindi or Marathi label on Latin
 * letters risks a refusal: Hinglish under the plain name (the one the first
 * templates were approved under), English under `_en`, Marathi under `_mr`.
 * Never Devanagari. Decided 29 September 2026.
 */
export type Voice = "HINGLISH" | "ENGLISH" | "MARATHI";
export const VOICES: readonly Voice[] = ["HINGLISH", "ENGLISH", "MARATHI"];
export const VOICE_WORDS: Record<Voice, string> = { HINGLISH: "Hinglish", ENGLISH: "English", MARATHI: "Marathi" };
const SUFFIX: Record<Voice, string> = { HINGLISH: "", ENGLISH: "_en", MARATHI: "_mr" };

/** The version a lead gets: Hindi reads Hinglish, Marathi reads Marathi, everyone else English. */
export function voiceFor(language: string | null | undefined): Voice {
  if (language === "hi") return "HINGLISH";
  if (language === "mr") return "MARATHI";
  return "ENGLISH";
}

/** One version of a message, as it is filed and sent. */
export function versionOf(t: Template, voice: Voice): Template {
  if (voice === "HINGLISH") return { ...t, voice };
  const v = t.versions[voice];
  return {
    ...t,
    name: `${t.name}${SUFFIX[voice]}`,
    body: v.body,
    buttons: t.buttons ? (v.buttons ?? t.buttons) : undefined,
    footer: t.footer ? (v.footer ?? t.footer) : undefined,
    label: `${t.label}, ${VOICE_WORDS[voice]}`,
    voice,
  };
}

/** Every version of every message: what is submitted to Meta and tracked. */
export const CATALOG: readonly Template[] = PURPOSES.flatMap((p) => VOICES.map((v) => versionOf(TEMPLATES[p], v)));

/** The words the engine fills a blank with when it has nothing better, in each version. */
export const FILL_INS: Record<Voice, { directions: string; contact: string; firstName: string }> = {
  HINGLISH: { directions: "yahin reply karein, hum location bhej denge.", contact: "is number", firstName: "there" },
  ENGLISH: { directions: "reply here and we will send the location.", contact: "this number", firstName: "there" },
  MARATHI: { directions: "ithech reply kara, aamhi location pathvu.", contact: "ya number", firstName: "ji" },
};

/** What happens next, said after a call: the engine writes the Hinglish, and each version says it its own way. */
const NEXT_STEPS: Record<string, Record<Exclude<Voice, "HINGLISH">, string>> = {
  "Hamare sales manager aapko thodi der mein call karenge.": {
    ENGLISH: "Our sales manager will call you shortly.",
    MARATHI: "Aamche sales manager tumhala thodya velat call kartil.",
  },
  "Hum touch mein rahenge, jab bhi aap ready hon yahin reply kar dijiye.": {
    ENGLISH: "We will stay in touch; whenever you are ready, just reply here.",
    MARATHI: "Aamhi sampark theu, tumhi tayar asal tevha ithech reply kara.",
  },
  "Site visit fix karne ke liye hum ek do din mein aapko call karenge.": {
    ENGLISH: "We will call you in a day or two to fix a site visit.",
    MARATHI: "Site visit tharavnyasathi aamhi ek-don divsat tumhala call karu.",
  },
};

/** The after-call line in a lead's version; one the table does not know is sent as written. */
export function nextStepIn(text: string | null | undefined, voice: Voice): string | null {
  if (!text) return null;
  if (voice === "HINGLISH") return text;
  return NEXT_STEPS[text]?.[voice] ?? text;
}

/**
 * A blank's value, as WhatsApp will take it: no newlines or tabs, no run of
 * more than four spaces, and never empty (Meta refuses an empty parameter).
 */
export function blankValue(v: string | null | undefined, fallback = "-"): string {
  const s = (v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  return (s || fallback).slice(0, 1000);
}

/** The text the buyer reads, for the timeline. */
export function render(t: Template, values: readonly string[]): string {
  return t.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => values[Number(n) - 1] ?? "");
}

/** Fill a template's blanks in order from what the caller knows. */
export function fill(t: Template, known: Partial<Record<Blank, string | null>>): string[] {
  return t.blanks.map((b) => blankValue(known[b], b === "first_name" ? FILL_INS[t.voice ?? "HINGLISH"].firstName : "-"));
}

// ---------------------------------------------------------------------------
// Whether this number may be messaged now
// ---------------------------------------------------------------------------

/** A buyer who wrote to us opened a window in which replies are free. */
export const SESSION_HOURS = 24;

export type MessageGateInput = {
  template: Template;
  nowIso: string;
  optedOut: boolean;
  consentRequired: boolean;
  consents: readonly ConsentRow[];
  enquiredAt: string;
  /** When the buyer last wrote to us on WhatsApp. */
  lastInboundAt: string | null;
  /** A visit on the books that has not happened yet, or happened in the last 7 days. */
  liveVisit: boolean;
  /** The lead is booked. */
  booked: boolean;
  /** Whether the tower may be advertised right now. */
  advertisable: boolean;
};

export type MessageVerdict =
  | { ok: true; basis: "CONSENT" | "ENQUIRY" | "SESSION" | "VISIT" | "BOOKING" | "NOT_REQUIRED" }
  | { ok: false; code: "OPTED_OUT" | "NOT_ADVERTISABLE" | "OUTSIDE_HOURS" | "NO_CONSENT"; message: string };

const DAY_MS = 86_400_000;

/**
 * The order is the rule, the calling gate's order with WhatsApp's own
 * reasons added. An opt-out refuses whatever else is true. A tower that may
 * not be advertised gets nothing that names it. A marketing message waits
 * for calling hours; a utility one does not, because "we will call you at
 * ten" is the whole point of sending it at eleven at night. Then consent: an
 * enquiry, a visit the buyer booked, a booking, or a window the buyer opened
 * by writing to us each count as the buyer having started it.
 */
export function gateMessage(i: MessageGateInput): MessageVerdict {
  if (i.optedOut) return { ok: false, code: "OPTED_OUT", message: "This number asked not to be contacted." };
  if (i.template.namesProject && !i.advertisable) {
    return { ok: false, code: "NOT_ADVERTISABLE", message: "The tower cannot be advertised, so nothing naming it is sent." };
  }
  if (i.template.category === "MARKETING") {
    const h = istHour(i.nowIso);
    if (h < CALLING_HOURS.from || h >= CALLING_HOURS.to) {
      return { ok: false, code: "OUTSIDE_HOURS", message: "Promotional messages go out between 10 am and 9 pm." };
    }
  }
  const now = Date.parse(i.nowIso);
  const consented = i.consents.some(
    (c) =>
      c.channels.includes("whatsapp") &&
      // A consent stamped by the database a moment after this clock was read.
      Date.parse(c.capturedAt) <= now + 5 * 60_000 &&
      (c.expiresAt === null || Date.parse(c.expiresAt) > now),
  );
  // A marketing message rests on consent alone. Everything else the buyer
  // did is a reason to answer them, not a reason to advertise to them. A
  // client who switched consent off may send one inside the enquiry's seven
  // days; past them, consent for WhatsApp is needed whatever the setting.
  if (i.template.category === "MARKETING") {
    if (consented) return { ok: true, basis: "CONSENT" };
    const age = now - Date.parse(i.enquiredAt);
    if (!i.consentRequired && age >= -5 * 60_000 && age <= ENQUIRY_DAYS * DAY_MS) return { ok: true, basis: "NOT_REQUIRED" };
    return { ok: false, code: "NO_CONSENT", message: "No consent on file for promotional messages." };
  }
  if (!i.consentRequired) return { ok: true, basis: "NOT_REQUIRED" };
  if (consented) return { ok: true, basis: "CONSENT" };
  if (i.lastInboundAt && now - Date.parse(i.lastInboundAt) <= SESSION_HOURS * 3_600_000) return { ok: true, basis: "SESSION" };
  if (i.template.aboutVisit && i.liveVisit) return { ok: true, basis: "VISIT" };
  if (i.template.aboutBooking && i.booked) return { ok: true, basis: "BOOKING" };
  const age = now - Date.parse(i.enquiredAt);
  if (age >= -5 * 60_000 && age <= ENQUIRY_DAYS * DAY_MS) return { ok: true, basis: "ENQUIRY" };
  return { ok: false, code: "NO_CONSENT", message: `The enquiry is over ${ENQUIRY_DAYS} days old and there is no consent on file.` };
}

// ---------------------------------------------------------------------------
// Reading a buyer's reply
// ---------------------------------------------------------------------------

/**
 * A reply that means "stop". WhatsApp's own block is not visible to us, so
 * the words are: English, Hindi and Marathi, in either script. Anything
 * longer than a few words is a conversation, not an instruction, and is
 * left for a person.
 */
export function isStop(text: string): boolean {
  const s = text.trim().toLowerCase().replace(/[.!\s]+$/g, "");
  if (s.split(/\s+/).length > 4) return false;
  return /^(stop|unsubscribe|stop all|opt out|optout|dnd|no more|band karo|band|mat bhejo|nahi chahiye|बंद|बंद करो|बंद करा|नको|मत भेजो|नहीं चाहिए)$/.test(s);
}
