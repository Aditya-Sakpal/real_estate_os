/**
 * A month of invented calls to lay the call log out with.
 *
 * There is no calls table: the Sarvam agent is configured and nothing stores
 * what it does yet. So every call here is invented and the screen says so.
 * What is not invented is the shape. Each record is what Sarvam's webhook
 * carries once `outcomeOf()` has read it, the agent's lines follow the rules
 * the real qualifier runs under (it discloses first, never states a price,
 * ends the call on an opt-out), calls fall inside the 10:00 to 21:00 IST
 * window, and a missed call is retried up to three times.
 *
 * Seeded from the date, so the log is stable through a day and the table does
 * not reshuffle on every reload.
 */

import { addDays } from "./lead-rules.ts";
import { shownPhone } from "./mask-rules.ts";
import {
  outcomeOf,
  type AgentKind,
  type CallRecord,
  type Connectivity,
  type Fact,
  type Language,
  type NextStep,
  type Outcome,
  type Turn,
} from "./call-rules.ts";

/** The line the agent dials from. */
export const SAMPLE_FROM = "+912265480217";

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

function seeded(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const weighted = <T,>(xs: readonly (readonly [T, number])[]): T => {
    const total = xs.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [x, w] of xs) {
      r -= w;
      if (r <= 0) return x;
    }
    return xs[xs.length - 1][0];
  };
  return { next, int, pick, weighted };
}

type Rng = ReturnType<typeof seeded>;

// ---------------------------------------------------------------------------
// People and places
// ---------------------------------------------------------------------------

const FIRST: readonly (readonly [string, string])[] = [
  ["Rohan", "रोहन"],
  ["Sneha", "स्नेहा"],
  ["Amit", "अमित"],
  ["Priyanka", "प्रियंका"],
  ["Vikram", "विक्रम"],
  ["Neha", "नेहा"],
  ["Sagar", "सागर"],
  ["Pooja", "पूजा"],
  ["Rahul", "राहुल"],
  ["Anjali", "अंजली"],
  ["Kunal", "कुणाल"],
  ["Meera", "मीरा"],
  ["Siddharth", "सिद्धार्थ"],
  ["Ketaki", "केतकी"],
  ["Aniket", "अनिकेत"],
  ["Shruti", "श्रुती"],
  ["Nitin", "नितीन"],
  ["Swati", "स्वाती"],
  ["Harsh", "हर्ष"],
  ["Divya", "दिव्या"],
  ["Tejas", "तेजस"],
  ["Gauri", "गौरी"],
  ["Omkar", "ओंकार"],
  ["Ritu", "ऋतु"],
  ["Manish", "मनीष"],
  ["Aarti", "आरती"],
  ["Ravi", "यश"],
  ["Madhuri", "माधुरी"],
];

const LAST = [
  "Kulkarni",
  "Deshpande",
  "Joshi",
  "Patil",
  "Shinde",
  "Sharma",
  "Verma",
  "Gupta",
  "Iyer",
  "Nair",
  "Jadhav",
  "Pawar",
  "Bhosale",
  "Agarwal",
  "Mehta",
  "Kale",
  "Gokhale",
  "Chavan",
  "Singh",
  "Reddy",
];

const AREAS: readonly (readonly [string, string])[] = [
  ["Baner", "बाणेर"],
  ["Wakad", "वाकड"],
  ["Hinjewadi", "हिंजवडी"],
  ["Kothrud", "कोथरूड"],
  ["Aundh", "औंध"],
  ["Pimple Saudagar", "पिंपळे सौदागर"],
  ["Balewadi", "बालेवाडी"],
];

/** A configuration and what somebody shopping for it tends to say they can spend. */
const WANTS: readonly (readonly [string, string, string])[] = [
  ["1 BHK", "55 lakh", "55 लाख"],
  ["1 BHK", "60 lakh", "60 लाख"],
  ["2 BHK", "75 lakh", "75 लाख"],
  ["2 BHK", "85 lakh", "85 लाख"],
  ["2 BHK", "90 lakh", "90 लाख"],
  ["3 BHK", "1.2 crore", "1.2 करोड़"],
];

const DAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_HI = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
const DAY_MR = ["रविवार", "सोमवार", "मंगळवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];

const HI_HOUR = (h: number) =>
  `${h < 12 ? "सुबह" : h < 16 ? "दोपहर" : "शाम"} ${h > 12 ? h - 12 : h} बजे`;
const MR_HOUR = (h: number) =>
  `${h < 12 ? "सकाळी" : h < 16 ? "दुपारी" : "संध्याकाळी"} ${h > 12 ? h - 12 : h} वाजता`;
const hour12 = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h >= 12 ? "pm" : "am"}`;
const weekday = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const pad = (n: number) => String(n).padStart(2, "0");
const at = (date: string, minutes: number, sec = 0) =>
  `${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${pad(sec)}+05:30`;

// ---------------------------------------------------------------------------
// What was said
// ---------------------------------------------------------------------------

type Ctx = {
  first: string;
  firstDev: string;
  dev: string;
  project: string;
  config: string;
  budget: string;
  budgetDev: string;
  area: string;
  areaDev: string;
  sales: string;
  /** A slot a few days after the call. */
  visit: { iso: string; day: number; hour: number };
  /** A time the buyer asks to be called back. */
  later: { iso: string; en: string; hi: string; mr: string };
};

type Script = {
  lang: Language;
  summary: string;
  points: string[];
  facts: Fact[];
  turns: Turn[];
  secs: [number, number];
  temp: "HOT" | "WARM" | "COLD" | null;
};

const a = (en: string, indic: string | null = null): Turn => ({ role: "agent", en, indic });
const u = (en: string, indic: string | null = null): Turn => ({ role: "user", en, indic });

const HI_OPEN = (c: Ctx) =>
  a(
    `Namaste ${c.first} ji, I'm Priya, an AI assistant calling for ${c.dev}. This call may be recorded. Is this a good time to talk?`,
    `नमस्ते ${c.firstDev} जी, मैं प्रिया, ${c.dev} की तरफ़ से AI असिस्टेंट बोल रही हूँ। यह कॉल रिकॉर्ड हो सकती है। क्या अभी बात करने का सही समय है?`,
  );

const MR_OPEN = (c: Ctx) =>
  a(
    `Namaskar ${c.first}, I'm Priya, an AI assistant calling for ${c.dev}. This call may be recorded. Do you have a minute to talk?`,
    `नमस्कार ${c.firstDev}, मी प्रिया, ${c.dev} कडून AI असिस्टंट बोलत आहे. हा कॉल रेकॉर्ड होऊ शकतो. आत्ता बोलायला वेळ आहे का?`,
  );

const EN_OPEN = (c: Ctx) =>
  a(
    `Hello ${c.first}, I'm Priya, an AI assistant calling for ${c.dev}. This call may be recorded. Is this a good time to talk?`,
  );

/** The nine fields, in the order the qualifier asks them. */
const nine = (f: Partial<Record<
  "budget" | "home" | "area" | "purpose" | "timeline" | "funding" | "lives" | "decides" | "also",
  string
>>): Fact[] => [
  { label: "Budget", value: f.budget ?? null },
  { label: "Looking for", value: f.home ?? null },
  { label: "Preferred area", value: f.area ?? null },
  { label: "Buying to", value: f.purpose ?? null },
  { label: "Buying in", value: f.timeline ?? null },
  { label: "Paying by", value: f.funding ?? null },
  { label: "Lives in", value: f.lives ?? null },
  { label: "Decides with", value: f.decides ?? null },
  { label: "Also looking at", value: f.also ?? null },
];

const visitEn = (c: Ctx) => `${DAY_EN[c.visit.day]} at ${hour12(c.visit.hour)}`;

const SCRIPTS: Partial<Record<AgentKind, Partial<Record<Outcome, ((c: Ctx) => Script)[]>>>> = {
  qualifier: {
    HANDED_OFF: [
      (c) => ({
        lang: "hi",
        temp: "HOT",
        secs: [200, 290],
        summary: `${c.first} wants a ${c.config} to live in, with a budget of about Rs ${c.budget} and a pre-approved loan, buying within two months. Asked for the price and was put through to ${c.sales}.`,
        points: [
          `Budget about Rs ${c.budget}, home loan already pre-approved`,
          "Wants to buy in the next two months",
          "Spouse was on the call and decides with them",
          "Asked for the price; the agent did not quote one and offered sales",
        ],
        facts: nine({
          budget: `Rs ${c.budget}`,
          home: c.config,
          purpose: "Live in",
          timeline: "Within 3 months",
          funding: "Home loan, pre-approved",
          decides: "Spouse, on the call",
        }),
        turns: [
          HI_OPEN(c),
          u("Yes, go ahead.", "हाँ, बोलिए।"),
          a(
            `You had asked about ${c.project}. What kind of home are you looking for?`,
            `आपने ${c.project} के बारे में पूछा था। आप किस तरह का घर देख रहे हैं?`,
          ),
          u(
            `A ${c.config}, to live in ourselves. Budget is around ${c.budget}.`,
            `${c.config} चाहिए, खुद रहने के लिए। बजट करीब ${c.budgetDev} है।`,
          ),
          a("Got it. By when are you planning to buy?", "ठीक है। कब तक लेने का सोच रहे हैं?"),
          u(
            "In the next two months. The home loan is already pre-approved.",
            "अगले दो महीने में। होम लोन प्री-अप्रूव्ड है।",
          ),
          a(
            "That helps. Will you decide on your own, or with family?",
            "बढ़िया। फ़ैसला आप अकेले लेंगे या परिवार के साथ?",
          ),
          u("My wife and I. She's right here with me.", "मैं और मेरी पत्नी। वो यहीं मेरे साथ हैं।"),
          u(`What is the price of the ${c.config}?`, `${c.config} का प्राइस क्या है?`),
          a(
            "Our sales manager will give you the exact, current price. Shall I connect you to them right now?",
            "सही और ताज़ा कीमत हमारे सेल्स मैनेजर बताएँगे। क्या मैं आपको अभी उनसे जोड़ दूँ?",
          ),
          u("Yes, please.", "हाँ, जोड़ दीजिए।"),
          a(`One moment, connecting you to ${c.sales}.`, `एक पल, मैं आपको ${c.sales} से जोड़ रही हूँ।`),
          { role: "event", en: `Handed to ${c.sales}` },
        ],
      }),
    ],
    QUALIFIED: [
      (c) => ({
        lang: "hi",
        temp: "WARM",
        secs: [150, 230],
        summary: `Rents in ${c.area} and wants a ${c.config} up to Rs ${c.budget}, moving in three to four months. Wants to see the site first; booked a visit for ${visitEn(c)}.`,
        points: [
          `Currently renting in ${c.area}`,
          `${c.config}, budget up to Rs ${c.budget}`,
          "Plans to move in three to four months",
          `Site visit booked for ${visitEn(c)}`,
        ],
        facts: nine({
          budget: `Up to Rs ${c.budget}`,
          home: c.config,
          purpose: "Live in",
          timeline: "3 to 6 months",
          lives: `${c.area}, rented`,
        }),
        turns: [
          HI_OPEN(c),
          u("Yes, tell me.", "हाँ, बोलिए।"),
          a(
            `What kind of home are you looking for at ${c.project}?`,
            `आप ${c.project} में किस तरह का घर देख रहे हैं?`,
          ),
          u(
            `A ${c.config}, budget up to ${c.budget}. We rent in ${c.area} right now.`,
            `${c.config}, बजट ${c.budgetDev} तक। अभी ${c.areaDev} में किराए पर रहते हैं।`,
          ),
          a("When are you planning to move?", "कब तक शिफ़्ट होने का प्लान है?"),
          u(
            "In three or four months. I want to see the site first.",
            "तीन चार महीने में। पहले साइट देखनी है।",
          ),
          a(
            `Of course. Would a site visit on ${visitEn(c)} work?`,
            `ज़रूर। ${DAY_HI[c.visit.day]} ${HI_HOUR(c.visit.hour)} साइट विज़िट ठीक रहेगी?`,
          ),
          u("Yes, that works.", "हाँ, चलेगा।"),
          a(
            "Great. The sales team will confirm it on WhatsApp. Thank you!",
            "बढ़िया, सेल्स टीम व्हाट्सऐप पर कन्फ़र्म करेगी। धन्यवाद!",
          ),
        ],
      }),
      (c) => ({
        lang: "en",
        temp: "WARM",
        secs: [170, 260],
        summary: `Looking at a ${c.config} as an investment for rental income, self-funded, deciding with a brother. Comparing with one other project in ${c.area}. Visit booked for ${visitEn(c)}.`,
        points: [
          "Buying to rent out, not to live in",
          "Paying from savings, no loan",
          `Also looking at a project in ${c.area}`,
          `Site visit booked for ${visitEn(c)}`,
        ],
        facts: nine({
          budget: `Around Rs ${c.budget}`,
          home: c.config,
          area: c.area,
          purpose: "Investment",
          timeline: "3 to 6 months",
          funding: "Own funds",
          decides: "Brother",
          also: `Another project in ${c.area}`,
        }),
        turns: [
          EN_OPEN(c),
          u("Sure, go ahead."),
          a(`You enquired about ${c.project}. Is this a home for yourself, or an investment?`),
          u(`Investment. I want something that rents well. A ${c.config}.`),
          a("Understood. Would you be paying from savings or with a loan?"),
          u("Savings. My brother and I are buying it together."),
          a("Are you looking at any other projects at the moment?"),
          u(`One more, in ${c.area}. Nothing final.`),
          a(`Would you like to see the site? ${visitEn(c)} is open.`),
          u("That works for both of us."),
          a("Done. The sales team will confirm it on WhatsApp. Thank you, and have a good day."),
        ],
      }),
    ],
    CALLBACK: [
      (c) => ({
        lang: "en",
        temp: null,
        secs: [25, 50],
        summary: `Driving when called. Asked to be called back ${c.later.en}.`,
        points: [`Asked for a call back ${c.later.en}`],
        facts: nine({}),
        turns: [
          EN_OPEN(c),
          u(`I'm driving right now. Can you call me ${c.later.en}?`),
          a(`Of course. I'll call you back ${c.later.en}. Drive safe!`),
        ],
      }),
      (c) => ({
        lang: "mr",
        temp: null,
        secs: [30, 55],
        summary: `In a meeting. Asked to be called ${c.later.en}, and said a ${c.config} is what they are after.`,
        points: [`Asked for a call back ${c.later.en}`, `Mentioned a ${c.config}`],
        facts: nine({ home: c.config }),
        turns: [
          MR_OPEN(c),
          u(
            `I'm in a meeting. Call me ${c.later.en}. I'm looking for a ${c.config}.`,
            `मी आत्ता मीटिंगमध्ये आहे. ${c.later.mr} फोन करा. मला ${c.config} हवा आहे.`,
          ),
          a(
            `Sure, I'll call ${c.later.en}. Thank you!`,
            `नक्की, मी ${c.later.mr} फोन करते. धन्यवाद!`,
          ),
        ],
      }),
    ],
    NOT_INTERESTED: [
      (c) => ({
        lang: "mr",
        temp: "COLD",
        secs: [40, 75],
        summary: "Has already booked a flat elsewhere. Thanked and closed.",
        points: ["Already bought in another project"],
        facts: nine({ also: "Booked elsewhere" }),
        turns: [
          MR_OPEN(c),
          u("Yes, tell me.", "हो, बोला."),
          a(
            `You had asked about ${c.project}. Are you still looking for a home?`,
            `तुम्ही ${c.project} बद्दल विचारलं होतं. तुम्ही अजून घर शोधताय का?`,
          ),
          u(
            "No, we already booked a flat last month.",
            "नाही, आम्ही मागच्या महिन्यात फ्लॅट बुक केला.",
          ),
          a(
            "Congratulations! Thank you for your time.",
            "अभिनंदन! वेळ दिल्याबद्दल धन्यवाद.",
          ),
        ],
      }),
      (c) => ({
        lang: "hi",
        temp: "COLD",
        secs: [60, 110],
        summary: `Wants to stay close to ${c.area} and finds the project too far. Not taking it further.`,
        points: [`Wants to stay near ${c.area}`, "Location is the reason, not the budget"],
        facts: nine({ area: c.area, home: c.config, lives: c.area }),
        turns: [
          HI_OPEN(c),
          u("Yes.", "हाँ।"),
          a(
            `What kind of home are you looking for at ${c.project}?`,
            `आप ${c.project} में किस तरह का घर देख रहे हैं?`,
          ),
          u(
            `A ${c.config}, but I checked the location. It's too far from ${c.area} for us.`,
            `${c.config} देख रहे थे, पर लोकेशन देखी। ${c.areaDev} से हमारे लिए बहुत दूर है।`,
          ),
          a(
            "I understand. Would you like me to share the details on WhatsApp anyway?",
            "समझ गई। क्या फिर भी मैं व्हाट्सऐप पर डिटेल्स भेज दूँ?",
          ),
          u("No, that's fine. Thanks.", "नहीं, रहने दीजिए। धन्यवाद।"),
          a("Thank you for your time.", "आपके समय के लिए धन्यवाद।"),
        ],
      }),
    ],
    HUNG_UP: [
      (c) => ({
        lang: "hi",
        temp: null,
        secs: [8, 20],
        summary: "Hung up during the introduction.",
        points: [],
        facts: nine({}),
        turns: [HI_OPEN(c), u("Who? ...", "कौन? ...")],
      }),
    ],
    BROKER: [
      (c) => ({
        lang: "en",
        temp: null,
        secs: [28, 50],
        summary: "A channel partner with clients, not a buyer. Told the partner team will reach out.",
        points: ["Channel partner, says they have clients for the project"],
        facts: nine({}),
        turns: [
          EN_OPEN(c),
          u("I'm a channel partner. I have a few clients for this project."),
          a("Thank you. Our channel partner team will get in touch with you."),
        ],
      }),
    ],
    WRONG_NUMBER: [
      (c) => ({
        lang: "hi",
        temp: null,
        secs: [18, 35],
        summary: "Says they never made an enquiry. Wrong number.",
        points: ["Did not make the enquiry"],
        facts: nine({}),
        turns: [
          HI_OPEN(c),
          u(
            "You have the wrong number. I never made any enquiry.",
            "आपने गलत नंबर लगाया है। मैंने कोई enquiry नहीं की।",
          ),
          a("Sorry for the trouble. Have a good day.", "माफ़ कीजिए, असुविधा के लिए खेद है।"),
        ],
      }),
    ],
    OPTED_OUT: [
      (c) => ({
        lang: "hi",
        temp: null,
        secs: [15, 30],
        summary: "Asked not to be called again. The number is off every list.",
        points: ["Asked not to be called again"],
        facts: nine({}),
        turns: [
          HI_OPEN(c),
          u("Don't call me. Remove my number.", "मुझे कॉल मत करो। मेरा नंबर हटा दो।"),
          a(
            "Sorry for disturbing you. We will not call you again.",
            "माफ़ कीजिए, आपको परेशान किया। हम आपको दोबारा कॉल नहीं करेंगे।",
          ),
        ],
      }),
    ],
  },
  reminder: {
    VISIT_CONFIRMED: [
      (c) => ({
        lang: "mr",
        temp: null,
        secs: [40, 70],
        summary: `Confirmed the site visit for ${visitEn(c)}. Location sent on WhatsApp.`,
        points: [`Coming on ${visitEn(c)}`, "Location sent on WhatsApp"],
        facts: [
          { label: "Visit", value: visitEn(c) },
          { label: "Coming", value: "Yes" },
        ],
        turns: [
          MR_OPEN(c),
          u("Yes.", "हो."),
          a(
            `Your site visit to ${c.project} is on ${visitEn(c)}. Are you still coming?`,
            `${DAY_MR[c.visit.day]} ${MR_HOUR(c.visit.hour)} तुमची ${c.project} ची साइट व्हिजिट आहे. तुम्ही येताय ना?`,
          ),
          u("Yes, definitely.", "हो, नक्की येतो."),
          a("Great! I've sent the location on WhatsApp.", "छान! लोकेशन व्हॉट्सॲपवर पाठवलं आहे."),
        ],
      }),
      (c) => ({
        lang: "en",
        temp: null,
        secs: [35, 60],
        summary: `Confirmed for ${visitEn(c)} and asked about parking. Told there is visitor parking at the site office.`,
        points: [`Coming on ${visitEn(c)}`, "Asked about parking"],
        facts: [
          { label: "Visit", value: visitEn(c) },
          { label: "Coming", value: "Yes" },
        ],
        turns: [
          EN_OPEN(c),
          u("Sure."),
          a(`Just confirming your site visit to ${c.project} on ${visitEn(c)}. Will you make it?`),
          u("Yes. Is there parking there?"),
          a("Yes, there is visitor parking at the site office. See you then!"),
        ],
      }),
    ],
    VISIT_MOVED: [
      (c) => ({
        lang: "en",
        temp: null,
        secs: [45, 80],
        summary: `Could not make the original slot. Moved the visit to ${visitEn(c)}.`,
        points: [`Visit moved to ${visitEn(c)}`],
        facts: [
          { label: "Visit", value: visitEn(c) },
          { label: "Coming", value: "Yes, new time" },
        ],
        turns: [
          EN_OPEN(c),
          u("Yes?"),
          a(`Calling to confirm your site visit to ${c.project} tomorrow. Will you make it?`),
          u(`Something came up. Could we do ${visitEn(c)} instead?`),
          a(`Done, I've moved it to ${visitEn(c)}. You'll get the confirmation on WhatsApp.`),
        ],
      }),
    ],
    NOT_INTERESTED: [
      (c) => ({
        lang: "en",
        temp: "COLD",
        secs: [30, 55],
        summary: "Cancelled the visit. Decided not to buy this year.",
        points: ["Visit cancelled", "Not buying this year"],
        facts: [
          { label: "Visit", value: "Cancelled" },
          { label: "Coming", value: "No" },
        ],
        turns: [
          EN_OPEN(c),
          u("Hi."),
          a(`I'm calling about your site visit to ${c.project}. Is it still on?`),
          u("Please cancel it. We've decided to hold off this year."),
          a("No problem, I've cancelled it. Thank you for letting us know."),
        ],
      }),
    ],
  },
  recovery: {
    VISIT_MOVED: [
      (c) => ({
        lang: "hi",
        temp: "WARM",
        secs: [50, 90],
        summary: `Missed the visit because of work. Rebooked for ${visitEn(c)}.`,
        points: ["Missed the visit, something came up at work", `Rebooked for ${visitEn(c)}`],
        facts: [
          { label: "Missed because", value: "Work came up" },
          { label: "New visit", value: visitEn(c) },
        ],
        turns: [
          HI_OPEN(c),
          u("Yes, tell me.", "हाँ, बोलिए।"),
          a(
            `You couldn't make it to ${c.project} yesterday. Would another day work?`,
            `कल आप ${c.project} साइट पर नहीं आ पाए। क्या कोई और दिन ठीक रहेगा?`,
          ),
          u(
            `Sorry, something came up at work. ${visitEn(c)}?`,
            `माफ़ कीजिए, ऑफ़िस का काम आ गया था। ${DAY_HI[c.visit.day]} ${HI_HOUR(c.visit.hour)}?`,
          ),
          a("Done. You'll get the confirmation on WhatsApp.", "हो गया। व्हाट्सऐप पर कन्फ़र्मेशन आ जाएगा।"),
        ],
      }),
    ],
    CALLBACK: [
      (c) => ({
        lang: "hi",
        temp: null,
        secs: [20, 40],
        summary: `Missed the visit. Busy now, asked to be called ${c.later.en}.`,
        points: [`Asked for a call back ${c.later.en}`],
        facts: [
          { label: "Missed because", value: null },
          { label: "New visit", value: null },
        ],
        turns: [
          HI_OPEN(c),
          u(
            `I can't talk now. Call me ${c.later.en}.`,
            `अभी बात नहीं कर सकता। ${c.later.hi} कॉल करना।`,
          ),
          a(`Sure, I'll call ${c.later.en}.`, `ज़रूर, मैं ${c.later.hi} कॉल करूँगी।`),
        ],
      }),
    ],
    NOT_INTERESTED: [
      (c) => ({
        lang: "en",
        temp: "COLD",
        secs: [30, 60],
        summary: "Missed the visit and has lost interest. Closed politely.",
        points: ["Not rebooking"],
        facts: [
          { label: "Missed because", value: "Changed their mind" },
          { label: "New visit", value: null },
        ],
        turns: [
          EN_OPEN(c),
          u("Yes?"),
          a(`We missed you at ${c.project} yesterday. Would you like to pick another day?`),
          u("No, we're not looking any more. Thanks."),
          a("Understood. Thank you for your time."),
        ],
      }),
    ],
  },
};

/** Agent variables as Sarvam would post them, so the outcome goes through the real reader. */
function varsFor(agent: AgentKind, target: Outcome): Record<string, unknown> {
  if (target === "OPTED_OUT") return { opt_out: true };
  if (target === "HUNG_UP") return {};
  if (agent === "qualifier") return { outcome: target === "HANDED_OFF" ? "QUALIFIED" : target };
  if (target === "VISIT_CONFIRMED") return { visit_status: "CONFIRMED" };
  if (target === "VISIT_MOVED") return { visit_status: "MOVED" };
  return { outcome: target };
}

// ---------------------------------------------------------------------------
// A month of calling
// ---------------------------------------------------------------------------

const MISS: readonly (readonly [Connectivity, number])[] = [
  ["no_answer", 30],
  ["busy", 7],
  ["failed", 3],
  ["connected", 60],
];

const QUALIFIER_MIX: readonly (readonly [Outcome, number])[] = [
  ["HANDED_OFF", 12],
  ["QUALIFIED", 22],
  ["CALLBACK", 16],
  ["NOT_INTERESTED", 24],
  ["HUNG_UP", 8],
  ["BROKER", 5],
  ["WRONG_NUMBER", 7],
  ["OPTED_OUT", 4],
];

const REMINDER_MIX: readonly (readonly [Outcome, number])[] = [
  ["VISIT_CONFIRMED", 70],
  ["VISIT_MOVED", 20],
  ["NOT_INTERESTED", 10],
];

const RECOVERY_MIX: readonly (readonly [Outcome, number])[] = [
  ["VISIT_MOVED", 45],
  ["CALLBACK", 25],
  ["NOT_INTERESTED", 30],
];

const VERSION: Record<AgentKind, number> = { qualifier: 3, reminder: 1, recovery: 1, reengage: 1, post_visit: 1, goal: 1, receptionist: 1 };

/**
 * Every call from the first of the month (or seven days back, whichever is
 * earlier) up to `nowIso`. `today` is the IST date the server decided.
 */
export function sampleCalls(opts: {
  today: string;
  nowIso: string;
  places: string[];
  developer: string;
  team: readonly string[];
}): CallRecord[] {
  const { today, nowIso, places, developer, team } = opts;
  const rng = seeded(`${today}|${developer}`);
  const now = Date.parse(nowIso);
  const monthStart = `${today.slice(0, 8)}01`;
  const weekStart = addDays(today, -6);
  const first = weekStart < monthStart ? weekStart : monthStart;

  const calls: CallRecord[] = [];
  let leadSeq = 4100;
  let callSeq = 0;

  const person = (r: Rng) => {
    const [en, dev] = r.pick(FIRST);
    return { first: en, firstDev: dev, name: `${en} ${r.pick(LAST)}` };
  };
  const phone = (r: Rng) => `+91${r.pick(["9", "8", "7"])}${String(r.int(100000000, 999999999))}`;

  const ctxFor = (r: Rng, date: string, minutes: number, who: ReturnType<typeof person>, place: string): Ctx => {
    const [config, budget, budgetDev] = r.pick(WANTS);
    const [area, areaDev] = r.pick(AREAS);
    const vDate = addDays(date, r.int(1, 4));
    const vHour = r.pick([11, 12, 16, 17]);
    const laterEvening = minutes < 18 * 60;
    const laterDate = laterEvening ? date : addDays(date, 1);
    const laterMin = laterEvening ? 19 * 60 : 11 * 60;
    return {
      first: who.first,
      firstDev: who.firstDev,
      dev: developer,
      project: place.split(" · ")[0],
      config,
      budget,
      budgetDev,
      area,
      areaDev,
      sales: r.pick(team),
      visit: { iso: at(vDate, vHour * 60), day: weekday(vDate), hour: vHour },
      later: laterEvening
        ? { iso: at(laterDate, laterMin), en: "this evening at 7", hi: "आज शाम 7 बजे", mr: "आज संध्याकाळी 7 वाजता" }
        : { iso: at(laterDate, laterMin), en: "tomorrow at 11 am", hi: "कल सुबह 11 बजे", mr: "उद्या सकाळी 11 वाजता" },
    };
  };

  /** One lead, dialled until someone answers or the three tries run out. */
  const job = (agent: AgentKind, date: string, mix: readonly (readonly [Outcome, number])[]) => {
    const who = person(rng);
    const place = rng.pick(places);
    const tel = phone(rng);
    const leadId = `L-${leadSeq++}`;
    let minutes = rng.int(10 * 60, 20 * 60 + 40);
    let day = date;
    const target = rng.weighted(mix);
    const scriptFor = () => {
      const options = SCRIPTS[agent]?.[target] ?? [];
      return options.length ? rng.pick(options) : null;
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      const startedAt = at(day, minutes, rng.int(0, 59));
      if (Date.parse(startedAt) > now) return;
      const connectivity: Connectivity = attempt === 3 ? rng.weighted([["no_answer", 45], ["connected", 55]] as const) : rng.weighted(MISS);

      // When the next try would be: two hours on, or the next morning.
      const nextMin = minutes + 120 <= 20 * 60 + 40 ? minutes + 120 : 11 * 60 + rng.int(0, 90);
      const nextDay = minutes + 120 <= 20 * 60 + 40 ? day : addDays(day, 1);
      const retryAt = at(nextDay, nextMin);

      const base = {
        id: `att_${today.replace(/-/g, "")}_${String(++callSeq).padStart(4, "0")}`,
        leadId,
        leadName: who.name,
        phone: shownPhone(tel, "MASKED"),
        place,
        agent,
        agentVersion: VERSION[agent],
        from: SAMPLE_FROM,
        startedAt,
        attempt,
        maxAttempts: 3,
        recordingUrl: null,
      };

      if (connectivity !== "connected") {
        const more = attempt < 3;
        calls.push({
          ...base,
          connectivity,
          duration: null,
          language: "hi",
          outcome: outcomeOf({ agent, connectivity, vars: null, transferred: false }),
          next: more ? { kind: "retry", at: retryAt, done: Date.parse(retryAt) <= now } : { kind: "none" },
          summary: null,
          keyPoints: [],
          facts: [],
          transcript: [],
          temp: null,
        });
        if (!more) return;
        minutes = nextMin;
        day = nextDay;
        continue;
      }

      const make = scriptFor();
      if (!make) return;
      const c = ctxFor(rng, day, minutes, who, place);
      const s = make(c);
      const outcome = outcomeOf({
        agent,
        connectivity,
        vars: varsFor(agent, target),
        transferred: target === "HANDED_OFF",
      });

      let next: NextStep = { kind: "none" };
      if (outcome === "OPTED_OUT") next = { kind: "never" };
      else if (outcome === "HANDED_OFF") {
        // One in six hand-offs rings out: the sales phone was busy, so the
        // person owes the buyer a call instead.
        if (rng.next() < 0.17) {
          const owed = new Date(Date.parse(startedAt) + 20 * 60_000).toISOString();
          next = { kind: "callback", at: owed, done: Date.parse(owed) < now - 3 * 3600_000, by: c.sales };
        } else next = { kind: "sales", who: c.sales };
      } else if (outcome === "CALLBACK") {
        next = { kind: "callback", at: c.later.iso, done: Date.parse(c.later.iso) < now - 3 * 3600_000 };
      } else if (outcome === "QUALIFIED" || outcome === "VISIT_CONFIRMED" || outcome === "VISIT_MOVED") {
        next = { kind: "visit", at: c.visit.iso };
      }

      const transcript = s.turns.map((t) =>
        t.role === "event" ? t : { ...t, indic: s.lang === "en" ? null : t.indic },
      );

      calls.push({
        ...base,
        connectivity,
        duration: rng.int(s.secs[0], s.secs[1]),
        language: s.lang,
        outcome,
        next,
        summary: s.summary,
        keyPoints: s.points,
        facts: s.facts,
        transcript,
        temp: s.temp,
      });
      return;
    }
  };

  for (let date = first; date <= today; date = addDays(date, 1)) {
    const sunday = weekday(date) === 0;
    const qualifiers = sunday ? rng.int(5, 8) : rng.int(12, 17);
    for (let i = 0; i < qualifiers; i++) job("qualifier", date, QUALIFIER_MIX);
    for (let i = 0, n = rng.int(2, 4); i < n; i++) job("reminder", date, REMINDER_MIX);
    for (let i = 0, n = rng.int(1, 2); i < n; i++) job("recovery", date, RECOVERY_MIX);
  }

  return calls.sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt));
}
