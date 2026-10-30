/**
 * A sample board to lay the lead pipeline out with.
 *
 * There is no lead table. The capture flow, the dual fire and the qualifier
 * in section 02 of the product flow doc are designed and not built, so every
 * lead here is invented and the screen says so. What is not invented is the
 * shape: each lead carries the facts its stage needs, built by the same rules
 * the move dialog enforces, so moving a sample lead behaves as a real one
 * will.
 */

import {
  addDays,
  requiredFor,
  type Facts,
  type FieldKey,
  type LeadState,
  type PathStage,
  type SideStage,
  type StageKey,
} from "./lead-rules.ts";

export type Temperature = "HOT" | "WARM" | "COLD";

export type SampleLead = LeadState & {
  id: string;
  name: string;
  temp: Temperature;
  /** Null until the qualifier has run. */
  score: number | null;
  source: string;
  /** What they asked for when they came in. Qualification may revise it. */
  config: string;
  budget: string;
  /** Index into the places the board was given. */
  place: number;
  lang: string;
  touched: string;
  cp?: { firm: string; daysLeft: number };
  /** Why a person has to act. Absent means the agent has it. */
  needsYou?: string;
  /** A hand-written next step. Cleared once somebody moves the lead. */
  note?: string;
  /** What the last move on this board was, so the card can say it. */
  lastMove?: { text: string; note?: string };
};

/** The invented sales team. Owners and visit hosts are picked from it. */
export const SAMPLE_TEAM = ["Nikhil Rao", "Asha Menon", "Karan Mehta"] as const;

export const SAMPLE_PLACES = ["Sath Heights · Tower C", "Sath Heights · Tower A", "Riverside Greens"];

type Seed = {
  id: string;
  name: string;
  stage: StageKey;
  /** For a side lane, where it left the path. */
  left?: PathStage;
  temp: Temperature;
  score: number | null;
  source: string;
  config: string;
  budget: string;
  place: number;
  lang: string;
  touched: string;
  note?: string;
  needsYou?: string;
  cp?: { firm: string; daysLeft: number };
  owner?: string;
  timeline?: string;
  /** Days from today; negative is past. */
  visitIn?: number;
  visitTime?: string;
  objection?: string;
  unit?: string;
  quote?: number;
  agreement?: number;
  token?: number;
  bookedAgo?: number;
  exit?: { reason: string; followIn?: number };
};

const CHANNEL: Record<string, string> = {
  "Meta ad": "WhatsApp",
  "Google ad": "WhatsApp",
  IVR: "Phone call",
  "Walk-in": "Walk-in",
  CP: "Phone call",
  Referral: "Phone call",
};

const TIMELINE: Record<Temperature, string> = {
  HOT: "Within 30 days",
  WARM: "1 to 3 months",
  COLD: "3 to 6 months",
};

const INTEREST: Record<Temperature, string> = { HOT: "Hot", WARM: "Warm", COLD: "Cold" };

function factsFor(s: Seed, upTo: PathStage, today: string): Facts {
  const visitDate = addDays(today, s.visitIn ?? -4);
  const all: Facts = {
    contactChannel: CHANNEL[s.source] ?? "AI voice call",
    contactedOn: addDays(today, Math.min(-1, (s.visitIn ?? 0) - 3)),
    config: s.config,
    budget: s.budget,
    timeline: s.timeline ?? TIMELINE[s.temp],
    owner: s.owner,
    visitDate,
    visitTime: s.visitTime ?? "11:00",
    visitHost: s.owner,
    interest: INTEREST[s.temp],
    objection: s.objection ?? "None",
    unit: s.unit,
    quote: s.quote?.toString(),
    bookedOn: addDays(today, -(s.bookedAgo ?? 2)),
    agreement: s.agreement?.toString(),
    token: s.token?.toString(),
  };
  const keep = requiredFor(upTo);
  const out: Facts = {};
  for (const k of keep as FieldKey[]) if (all[k]) out[k] = all[k];
  return out;
}

/** Invented people and firms. None of them is a customer. */
const SEEDS: Seed[] = [
  // --- new: captured, the first reply is on its way ------------------------
  {
    id: "L-1041", name: "Rohan Deshmukh", stage: "new", temp: "WARM", score: null,
    source: "Meta ad", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "Marathi",
    note: "WhatsApp sent, AI call in 1 min", touched: "40 s ago",
  },
  {
    id: "L-1040", name: "Sneha Kulkarni", stage: "new", temp: "WARM", score: null,
    source: "99acres", config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", place: 1, lang: "English",
    note: "Call held until 10:00", touched: "7 h ago",
  },
  {
    id: "L-1039", name: "Imran Shaikh", stage: "new", temp: "COLD", score: null,
    source: "MagicBricks", config: "2 BHK", budget: "Under Rs 60 lakh", place: 2, lang: "Hindi",
    note: "Possible duplicate of L-0977", needsYou: "Duplicate check", touched: "12 min ago",
  },
  {
    id: "L-1038", name: "Kavya Iyer", stage: "new", temp: "WARM", score: null,
    source: "Google ad", config: "2.5 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "English",
    note: "AI call ringing", touched: "just now",
  },

  // --- contacted: reached, qualification under way --------------------------
  {
    id: "L-1032", name: "Amit Joshi", stage: "contacted", temp: "WARM", score: 54,
    source: "Housing.com", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "Marathi",
    note: "Callback asked for 6:30 pm", touched: "2 h ago",
  },
  {
    id: "L-1029", name: "Pooja Nair", stage: "contacted", temp: "HOT", score: 71,
    source: "CP", config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", place: 1, lang: "English",
    note: "Tagged by two partners", needsYou: "CP tag conflict", touched: "25 min ago",
    cp: { firm: "Keystone Realty", daysLeft: 41 },
  },
  {
    id: "L-1027", name: "Harsh Vardhan", stage: "contacted", temp: "COLD", score: 32,
    source: "IVR", config: "1 BHK", budget: "Under Rs 60 lakh", place: 2, lang: "Hindi",
    note: "Second WhatsApp nudge tomorrow", touched: "1 d ago",
  },

  // --- qualified: scored, routed to a person --------------------------------
  {
    id: "L-1018", name: "Meera Patil", stage: "qualified", temp: "HOT", score: 88,
    source: "Meta ad", config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", place: 1, lang: "Marathi",
    owner: "Nikhil Rao", note: "Live transfer missed, call back now", needsYou: "Hot lead waiting",
    touched: "6 min ago",
  },
  {
    id: "L-1015", name: "Vikram Singh", stage: "qualified", temp: "WARM", score: 67,
    source: "Google ad", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "Hindi",
    owner: "Asha Menon", note: "Slot re-offer at 4:00 pm", touched: "3 h ago",
  },
  {
    id: "L-1012", name: "Ananya Rao", stage: "qualified", temp: "HOT", score: 81,
    source: "Referral", config: "2.5 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "English",
    owner: "Nikhil Rao", note: "Pick a visit slot", touched: "1 h ago",
  },
  {
    id: "L-1009", name: "Farhan Qureshi", stage: "qualified", temp: "WARM", score: 62,
    source: "CP", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 2, lang: "Hindi",
    owner: "Asha Menon", note: "Loan pre-approval pending", touched: "5 h ago",
    cp: { firm: "Pune Homes Advisory", daysLeft: 12 },
  },

  // --- visit scheduled ------------------------------------------------------
  {
    id: "L-0996", name: "Siddharth Gokhale", stage: "visit_scheduled", temp: "HOT", score: 84,
    source: "Meta ad", config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", place: 1, lang: "Marathi",
    owner: "Nikhil Rao", visitIn: 3, visitTime: "11:00", touched: "30 min ago",
  },
  {
    id: "L-0991", name: "Priya Sharma", stage: "visit_scheduled", temp: "WARM", score: 69,
    source: "99acres", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "Hindi",
    owner: "Asha Menon", visitIn: 0, visitTime: "16:30", touched: "2 h ago",
  },
  {
    id: "L-0988", name: "Rahul Bhosale", stage: "visit_scheduled", temp: "WARM", score: 64,
    source: "CP", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 2, lang: "Marathi",
    owner: "Asha Menon", visitIn: 1, visitTime: "12:00",
    note: "Slot full, three options sent", needsYou: "Slot clash", touched: "15 min ago",
    cp: { firm: "Keystone Realty", daysLeft: 58 },
  },
  {
    id: "L-0984", name: "Neha Agarwal", stage: "visit_scheduled", temp: "HOT", score: 79,
    source: "Walk-in", config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", place: 1, lang: "English",
    owner: "Karan Mehta", visitIn: 4, visitTime: "12:00", touched: "4 h ago",
  },

  // --- visit done: feedback captured, objection handling --------------------
  {
    id: "L-0962", name: "Aditi Kale", stage: "visit_done", temp: "HOT", score: 86,
    source: "Google ad", config: "2.5 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "Marathi",
    owner: "Nikhil Rao", visitIn: -1, objection: "Price",
    note: "Objection: price, payment plan sent", touched: "1 h ago",
  },
  {
    id: "L-0958", name: "Sanjay Mishra", stage: "visit_done", temp: "WARM", score: 72,
    source: "Housing.com", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 2, lang: "Hindi",
    owner: "Karan Mehta", visitIn: -3, objection: "Possession date",
    note: "Objection: possession date", touched: "1 d ago",
  },
  {
    id: "L-0951", name: "Ritu Chauhan", stage: "visit_done", temp: "HOT", score: 90,
    source: "Referral", config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", place: 1, lang: "English",
    owner: "Karan Mehta", visitIn: -2, objection: "Price",
    note: "Asked for a discount above policy", needsYou: "Discount approval", touched: "45 min ago",
  },

  // --- negotiation: quote, token, block --------------------------------------
  {
    id: "L-0930", name: "Arjun Pawar", stage: "negotiation", temp: "HOT", score: 91,
    source: "Meta ad", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "Marathi",
    owner: "Nikhil Rao", visitIn: -6, objection: "Price", unit: "C-1203", quote: 7630000,
    note: "Token link sent, unit C-1203 held", touched: "2 h ago",
  },
  {
    id: "L-0922", name: "Deepa Menon", stage: "negotiation", temp: "HOT", score: 87,
    source: "CP", config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", place: 1, lang: "English",
    owner: "Karan Mehta", visitIn: -8, unit: "A-904", quote: 12450000,
    note: "Hold on A-904 expires in 3 h", needsYou: "Hold expiring", touched: "20 min ago",
    cp: { firm: "Pune Homes Advisory", daysLeft: 27 },
  },
  {
    id: "L-0915", name: "Manoj Thakur", stage: "negotiation", temp: "WARM", score: 76,
    source: "99acres", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 2, lang: "Hindi",
    owner: "Asha Menon", visitIn: -10, objection: "Loan", unit: "R-507", quote: 6890000,
    note: "Revised quote with bank", touched: "1 d ago",
  },

  // --- booked --------------------------------------------------------------
  {
    id: "L-0874", name: "Shreya Deshpande", stage: "booked", temp: "HOT", score: 93,
    source: "Google ad", config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", place: 1, lang: "Marathi",
    owner: "Karan Mehta", visitIn: -14, unit: "A-1102", quote: 12100000,
    agreement: 11800000, token: 500000, bookedAgo: 3,
    note: "Agreement for sale due 14 Oct", touched: "3 d ago",
  },
  {
    id: "L-0861", name: "Nitin Gupta", stage: "booked", temp: "HOT", score: 89,
    source: "CP", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "Hindi",
    owner: "Nikhil Rao", visitIn: -20, unit: "C-803", quote: 8600000,
    agreement: 8540000, token: 400000, bookedAgo: 5,
    note: "Token received, referral asked", touched: "5 d ago",
    cp: { firm: "Keystone Realty", daysLeft: 0 },
  },

  // --- nurture: monthly drip, re-scored on any reply ------------------------
  {
    id: "L-0812", name: "Gaurav Shinde", stage: "nurture", left: "contacted", temp: "COLD", score: 38,
    source: "Meta ad", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "Marathi",
    exit: { reason: "Buying in 6 months or more", followIn: 8 }, touched: "12 d ago",
  },
  {
    id: "L-0799", name: "Lakshmi Reddy", stage: "nurture", left: "visit_scheduled", temp: "WARM", score: 58,
    source: "Housing.com", config: "3 BHK", budget: "Rs 90 lakh to 1.5 Cr", place: 1, lang: "English",
    owner: "Karan Mehta", visitIn: -3,
    exit: { reason: "No-show", followIn: 2 }, touched: "3 d ago",
  },

  // --- lost ----------------------------------------------------------------
  {
    id: "L-0765", name: "Suresh Yadav", stage: "lost", left: "contacted", temp: "COLD", score: 22,
    source: "MagicBricks", config: "1 BHK", budget: "Under Rs 60 lakh", place: 2, lang: "Hindi",
    exit: { reason: "Budget mismatch" }, touched: "9 d ago",
  },
  {
    id: "L-0751", name: "Tanvi Bapat", stage: "lost", left: "visit_done", temp: "WARM", score: 61,
    source: "Google ad", config: "2 BHK", budget: "Rs 60 to 90 lakh", place: 0, lang: "Marathi",
    owner: "Asha Menon", visitIn: -15, exit: { reason: "Bought elsewhere" }, touched: "2 w ago",
  },
];

/** The sample board as of `today`, a civil date in Asia/Kolkata. */
export function sampleLeads(today: string): SampleLead[] {
  return SEEDS.map((s) => {
    const pathStage = (s.left ?? s.stage) as PathStage;
    const lead: SampleLead = {
      id: s.id,
      name: s.name,
      stage: s.stage,
      pathStage,
      facts: factsFor(s, pathStage, today),
      temp: s.temp,
      score: s.score,
      source: s.source,
      config: s.config,
      budget: s.budget,
      place: s.place,
      lang: s.lang,
      touched: s.touched,
      cp: s.cp,
      needsYou: s.needsYou,
      note: s.note,
    };
    if (s.exit) {
      lead.exit = {
        kind: s.stage as SideStage,
        reason: s.exit.reason,
        followUp: s.exit.followIn !== undefined ? addDays(today, s.exit.followIn) : undefined,
      };
    }
    return lead;
  });
}
