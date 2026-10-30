import { spokenMatch } from "./reel-rules.ts";

/**
 * How the calling agent says the words of a place: a region's own list (Pune
 * first), and a project's own words, written the way they are said.
 *
 * The agent's model keeps a proper noun in English letters ("Sath Heights",
 * "Pimple Saudagar") and the voice reads it as English: "Pimple" is the
 * English word, "Sus" a hiss, "Maan" a man, "Sath" came back "Sapt". A word
 * handed to the agent with its Devanagari spelling ("Pimple Saudagar is said
 * पिंपळे सौदागर") is written that way in its reply, and Devanagari is what the
 * voice reads right. So the words travel with every call (`say_words`), the
 * region's that the call's facts use and the project's own, because Sarvam's
 * per-agent dictionary holds one list for every tenant and changes only by
 * editing the agent.
 *
 * Pure, so the screen and `check:logic` read the same rules.
 */

export type Saying = { written: string; said: string };

/**
 * Pune and Pimpri-Chinchwad, as written on an advertisement and as said.
 * Localities, roads and landmarks a project's facts or a buyer name. The
 * spellings are the Marathi ones the city itself uses.
 */
export const PUNE: readonly Saying[] = [
  { written: "Pune", said: "पुणे" },
  { written: "Pimpri Chinchwad", said: "पिंपरी चिंचवड" },
  { written: "Pimpri-Chinchwad", said: "पिंपरी चिंचवड" },
  { written: "PCMC", said: "पी सी एम सी" },
  { written: "PMC", said: "पी एम सी" },
  { written: "PMRDA", said: "पी एम आर डी ए" },
  { written: "Pimpri", said: "पिंपरी" },
  { written: "Chinchwad", said: "चिंचवड" },
  { written: "Pimple Saudagar", said: "पिंपळे सौदागर" },
  { written: "Pimple Nilakh", said: "पिंपळे निलख" },
  { written: "Pimple Gurav", said: "पिंपळे गुरव" },
  { written: "Wakad", said: "वाकड" },
  { written: "Hinjewadi", said: "हिंजवडी" },
  { written: "Hinjawadi", said: "हिंजवडी" },
  { written: "Maan", said: "माण" },
  { written: "Marunji", said: "मारुंजी" },
  { written: "Punawale", said: "पुनावळे" },
  { written: "Tathawade", said: "ताथवडे" },
  { written: "Ravet", said: "रावेत" },
  { written: "Kiwale", said: "किवळे" },
  { written: "Mamurdi", said: "मामुर्डी" },
  { written: "Gahunje", said: "गहुंजे" },
  { written: "Akurdi", said: "आकुर्डी" },
  { written: "Nigdi", said: "निगडी" },
  { written: "Pradhikaran", said: "प्राधिकरण" },
  { written: "Moshi", said: "मोशी" },
  { written: "Chikhli", said: "चिखली" },
  { written: "Bhosari", said: "भोसरी" },
  { written: "Dighi", said: "दिघी" },
  { written: "Charholi", said: "चऱ्होली" },
  { written: "Alandi", said: "आळंदी" },
  { written: "Chakan", said: "चाकण" },
  { written: "Talegaon", said: "तळेगाव" },
  { written: "Talegaon Dabhade", said: "तळेगाव दाभाडे" },
  { written: "Dehu Road", said: "देहू रोड" },
  { written: "Dehu", said: "देहू" },
  { written: "Thergaon", said: "थेरगाव" },
  { written: "Kalewadi", said: "काळेवाडी" },
  { written: "Rahatani", said: "रहाटणी" },
  { written: "Sangvi", said: "सांगवी" },
  { written: "Sanghvi", said: "सांगवी" },
  { written: "Aundh", said: "औंध" },
  { written: "Baner", said: "बाणेर" },
  { written: "Balewadi", said: "बालेवाडी" },
  { written: "Pashan", said: "पाषाण" },
  { written: "Sus", said: "सूस" },
  { written: "Sus Road", said: "सूस रोड" },
  { written: "Bavdhan", said: "बावधन" },
  { written: "Bhugaon", said: "भूगाव" },
  { written: "Bhukum", said: "भुकूम" },
  { written: "Pirangut", said: "पिरंगुट" },
  { written: "Lavale", said: "लवळे" },
  { written: "Mulshi", said: "मुळशी" },
  { written: "Paud", said: "पौड" },
  { written: "Kothrud", said: "कोथरूड" },
  { written: "Karve Nagar", said: "कर्वेनगर" },
  { written: "Karvenagar", said: "कर्वेनगर" },
  { written: "Warje", said: "वारजे" },
  { written: "Erandwane", said: "एरंडवणे" },
  { written: "Deccan", said: "डेक्कन" },
  { written: "Deccan Gymkhana", said: "डेक्कन जिमखाना" },
  { written: "Shivajinagar", said: "शिवाजीनगर" },
  { written: "Shivaji Nagar", said: "शिवाजीनगर" },
  { written: "Model Colony", said: "मॉडेल कॉलनी" },
  { written: "Prabhat Road", said: "प्रभात रोड" },
  { written: "FC Road", said: "एफ सी रोड" },
  { written: "Fergusson College Road", said: "फर्ग्युसन कॉलेज रोड" },
  { written: "JM Road", said: "जे एम रोड" },
  { written: "Senapati Bapat Road", said: "सेनापती बापट रोड" },
  { written: "SB Road", said: "एस बी रोड" },
  { written: "Karve Road", said: "कर्वे रोड" },
  { written: "Paud Road", said: "पौड रोड" },
  { written: "Law College Road", said: "लॉ कॉलेज रोड" },
  { written: "Camp", said: "कॅम्प" },
  { written: "Koregaon Park", said: "कोरेगाव पार्क" },
  { written: "Kalyani Nagar", said: "कल्याणीनगर" },
  { written: "Viman Nagar", said: "विमाननगर" },
  { written: "Yerawada", said: "येरवडा" },
  { written: "Yerwada", said: "येरवडा" },
  { written: "Wadgaon Sheri", said: "वडगाव शेरी" },
  { written: "Chandan Nagar", said: "चंदननगर" },
  { written: "Kharadi", said: "खराडी" },
  { written: "Wagholi", said: "वाघोली" },
  { written: "Lohegaon", said: "लोहगाव" },
  { written: "Dhanori", said: "धानोरी" },
  { written: "Vishrantwadi", said: "विश्रांतवाडी" },
  { written: "Tingre Nagar", said: "टिंगरेनगर" },
  { written: "Hadapsar", said: "हडपसर" },
  { written: "Magarpatta", said: "मगरपट्टा" },
  { written: "Magarpatta City", said: "मगरपट्टा सिटी" },
  { written: "Amanora", said: "अमनोरा" },
  { written: "Mundhwa", said: "मुंढवा" },
  { written: "Keshav Nagar", said: "केशवनगर" },
  { written: "Manjri", said: "मांजरी" },
  { written: "Shewalewadi", said: "शेवाळेवाडी" },
  { written: "Phursungi", said: "फुरसुंगी" },
  { written: "Handewadi", said: "हांडेवाडी" },
  { written: "Uruli Kanchan", said: "उरुळी कांचन" },
  { written: "Loni Kalbhor", said: "लोणी काळभोर" },
  { written: "Undri", said: "उंड्री" },
  { written: "Pisoli", said: "पिसोळी" },
  { written: "Kondhwa", said: "कोंढवा" },
  { written: "NIBM", said: "एन आय बी एम" },
  { written: "NIBM Road", said: "एन आय बी एम रोड" },
  { written: "Mohammed Wadi", said: "महंमदवाडी" },
  { written: "Mohammadwadi", said: "महंमदवाडी" },
  { written: "Wanowrie", said: "वानवडी" },
  { written: "Wanwadi", said: "वानवडी" },
  { written: "Fatima Nagar", said: "फातिमानगर" },
  { written: "Salunke Vihar", said: "साळुंखे विहार" },
  { written: "Katraj", said: "कात्रज" },
  { written: "Ambegaon", said: "आंबेगाव" },
  { written: "Narhe", said: "नऱ्हे" },
  { written: "Dhayari", said: "धायरी" },
  { written: "Sinhagad Road", said: "सिंहगड रोड" },
  { written: "Sinhagad", said: "सिंहगड" },
  { written: "Vadgaon", said: "वडगाव" },
  { written: "Kirkatwadi", said: "किरकटवाडी" },
  { written: "Khadakwasla", said: "खडकवासला" },
  { written: "Bibwewadi", said: "बिबवेवाडी" },
  { written: "Swargate", said: "स्वारगेट" },
  { written: "Sahakar Nagar", said: "सहकारनगर" },
  { written: "Dhankawadi", said: "धनकवडी" },
  { written: "Khadki", said: "खडकी" },
  { written: "Bopodi", said: "बोपोडी" },
  { written: "Satara Road", said: "सातारा रोड" },
  { written: "Solapur Road", said: "सोलापूर रोड" },
  { written: "Nagar Road", said: "नगर रोड" },
  { written: "Alandi Road", said: "आळंदी रोड" },
  { written: "Mumbai Pune Expressway", said: "मुंबई पुणे एक्सप्रेसवे" },
  { written: "Mumbai-Pune Expressway", said: "मुंबई पुणे एक्सप्रेसवे" },
  { written: "Mumbai Bengaluru Highway", said: "मुंबई बेंगळुरू हायवे" },
  { written: "Pune Ring Road", said: "पुणे रिंग रोड" },
  { written: "Rajiv Gandhi Infotech Park", said: "राजीव गांधी इन्फोटेक पार्क" },
  { written: "EON IT Park", said: "इऑन आय टी पार्क" },
  { written: "Phoenix Marketcity", said: "फिनिक्स मार्केटसिटी" },
  { written: "Balewadi High Street", said: "बालेवाडी हाय स्ट्रीट" },
  { written: "Westend Mall", said: "वेस्टएंड मॉल" },
  { written: "Pune Station", said: "पुणे स्टेशन" },
  { written: "Pune Airport", said: "पुणे एअरपोर्ट" },
  { written: "Pune Metro", said: "पुणे मेट्रो" },
  { written: "Shaniwar Wada", said: "शनिवारवाडा" },
  { written: "Dagdusheth", said: "दगडूशेठ" },
  { written: "Symbiosis", said: "सिम्बायोसिस" },
  { written: "Lonavala", said: "लोणावळा" },
];

/** Mumbai and its suburbs, Thane and Navi Mumbai, as Marathi spells them. */
export const MUMBAI: readonly Saying[] = [
  { written: "Bhandup East", said: "भांडुप ईस्ट" },
  { written: "Bhandup West", said: "भांडुप वेस्ट" },
  { written: "Bhandup", said: "भांडुप" },
  { written: "Nahur", said: "नाहूर" },
  { written: "Mulund East", said: "मुलुंड ईस्ट" },
  { written: "Mulund West", said: "मुलुंड वेस्ट" },
  { written: "Mulund", said: "मुलुंड" },
  { written: "Vikhroli", said: "विक्रोळी" },
  { written: "Ghatkopar", said: "घाटकोपर" },
  { written: "Kanjurmarg", said: "कांजूरमार्ग" },
  { written: "Powai", said: "पवई" },
  { written: "Andheri", said: "अंधेरी" },
  { written: "Jogeshwari", said: "जोगेश्वरी" },
  { written: "Goregaon", said: "गोरेगाव" },
  { written: "Malad", said: "मालाड" },
  { written: "Kandivali", said: "कांदिवली" },
  { written: "Borivali", said: "बोरिवली" },
  { written: "Dahisar", said: "दहिसर" },
  { written: "Mira Road", said: "मीरा रोड" },
  { written: "Bhayandar", said: "भाईंदर" },
  { written: "Vile Parle", said: "विलेपार्ले" },
  { written: "Santacruz", said: "सांताक्रूझ" },
  { written: "Bandra", said: "बांद्रा" },
  { written: "Khar", said: "खार" },
  { written: "Dadar", said: "दादर" },
  { written: "Worli", said: "वरळी" },
  { written: "Parel", said: "परळ" },
  { written: "Lower Parel", said: "लोअर परळ" },
  { written: "Sewri", said: "शिवडी" },
  { written: "Wadala", said: "वडाळा" },
  { written: "Sion", said: "सायन" },
  { written: "Chembur", said: "चेंबूर" },
  { written: "Kurla", said: "कुर्ला" },
  { written: "Vidyavihar", said: "विद्याविहार" },
  { written: "Matunga", said: "माटुंगा" },
  { written: "Mahim", said: "माहीम" },
  { written: "Byculla", said: "भायखळा" },
  { written: "Colaba", said: "कुलाबा" },
  { written: "Thane", said: "ठाणे" },
  { written: "Ghodbunder", said: "घोडबंदर" },
  { written: "Kalyan", said: "कल्याण" },
  { written: "Dombivli", said: "डोंबिवली" },
  { written: "Vashi", said: "वाशी" },
  { written: "Kharghar", said: "खारघर" },
  { written: "Panvel", said: "पनवेल" },
  { written: "Airoli", said: "ऐरोली" },
  { written: "Nerul", said: "नेरूळ" },
  { written: "Ulwe", said: "उलवे" },
  { written: "LBS Marg", said: "एल बी एस मार्ग" },
  { written: "Eastern Express Highway", said: "ईस्टर्न एक्सप्रेस हायवे" },
  { written: "Western Express Highway", said: "वेस्टर्न एक्सप्रेस हायवे" },
  { written: "JVLR", said: "जे व्ही एल आर" },
  { written: "BKC", said: "बी के सी" },
];

/** A region: the cities its projects sit in, and its words. */
export const REGIONS: Record<string, { label: string; cities: RegExp; words: readonly Saying[] }> = {
  pune: { label: "Pune", cities: /\b(pune|poona|pimpri|chinchwad|pcmc)\b/i, words: PUNE },
  mumbai: { label: "Mumbai", cities: /\b(mumbai|bombay|thane|navi mumbai|kalyan|dombivli|mira|bhayandar|panvel)\b/i, words: MUMBAI },
};

/** The region a project's city belongs to, or null where no list is kept yet. */
export function regionFor(city: string | null | undefined): string | null {
  if (!city) return null;
  return Object.entries(REGIONS).find(([, r]) => r.cities.test(city))?.[0] ?? null;
}

/** The most `say_words` carries. Read on every turn, so it is kept short. */
export const SAY_WORDS_MAX = 900;

/**
 * Caps on checking how the agent says words, in sayings (one word said and
 * heard back is one), counted over a whole project and its towers. Refused
 * before anything is paid. 150 a month at Rs 0.50 worst is Rs 75 a project,
 * which keeps Scale's worst case, the tightest, over its 50% floor
 * (`doc/pricing.md`); 300 took it to 49.99%. A tower reuses a word its
 * project already heard in the same spelling, which costs nothing.
 */
export const SAYING_CAPS = { perCheck: 40, perProjectDay: 80, perProjectMonth: 150, writtenMax: 60, saidMax: 80 } as const;

/** The project a node belongs to: itself, or the project above a tower. */
export function projectPathOf(kind: string, path: string): string {
  return kind === "PHASE" ? path.split(".").slice(0, -1).join(".") : path;
}

const fold = (s: string) => s.toLowerCase().normalize("NFC").replace(/[\s\-–.]+/g, " ").trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` carries the word as written, as a whole word. */
export function mentions(text: string, written: string): boolean {
  const w = fold(written);
  if (!w) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w).replace(/ /g, "[\\s\\-–.]+")}($|[^\\p{L}\\p{N}])`, "iu").test(fold(text));
}

/**
 * A place name as the voice should read it: the region's own spelling when
 * the whole name is one of its words ("Bhandup East" is "भांडुप ईस्ट"), else
 * as written. For the greeting, which `say_words` never reaches: read in
 * Roman letters by a Hindi voice, "Bhandup East" came out as "Mandu Gate"
 * (29 October 2026).
 */
export function saidPlace(place: string | null | undefined, city: string | null | undefined): string {
  const p = (place ?? "").trim();
  const region = regionFor(city);
  if (!p || !region) return p;
  return REGIONS[region].words.find((s) => fold(s.written) === fold(p))?.said ?? p;
}

/**
 * The `say_words` a call carries: every one of the project's own words, then
 * the region's that the call's facts or its place name use, longest first so
 * "Pimple Saudagar" is told before "Pimpri", as "written = said" lines. A
 * word the project spells its own way wins over the region's.
 */
/**
 * Property words every call that names a configuration carries. Written as
 * "2 BHK" the voice spells it out letter by letter, slowly, and a live call
 * on 4 October 2026 was called robotic for it; written in Devanagari it is
 * said as one word, the way a sales person says it.
 */
export const PROPERTY_WORDS: readonly Saying[] = [
  { written: "1 BHK", said: "वन बीएचके" },
  { written: "2 BHK", said: "टू बीएचके" },
  { written: "3 BHK", said: "थ्री बीएचके" },
  { written: "4 BHK", said: "फोर बीएचके" },
  { written: "BHK", said: "बीएचके" },
];

/**
 * English words a property call says that the Hindi voice reads as other
 * words when they come in English letters: on 9 October 2026 Saaras heard
 * "rooftop pool" as "dost aap phool". Sent only when the facts say them.
 */
export const COMMON_WORDS: readonly Saying[] = [
  { written: "rooftop pool", said: "रूफ़टॉप पूल" },
  { written: "swimming pool", said: "स्विमिंग पूल" },
  { written: "infinity pool", said: "इन्फ़िनिटी पूल" },
  { written: "clubhouse", said: "क्लबहाउस" },
  { written: "gymnasium", said: "जिम्नेज़ियम" },
  { written: "gym", said: "जिम" },
  { written: "jogging track", said: "जॉगिंग ट्रैक" },
  { written: "podium", said: "पोडियम" },
  { written: "lobby", said: "लॉबी" },
  { written: "sample flat", said: "सैंपल फ़्लैट" },
  { written: "carpet area", said: "कार्पेट एरिया" },
  { written: "possession", said: "पज़ेशन" },
  { written: "ready to move", said: "रेडी टू मूव" },
  { written: "under construction", said: "अंडर कंस्ट्रक्शन" },
  { written: "site visit", said: "साइट विज़िट" },
  { written: "sea view", said: "सी व्यू" },
  { written: "sea facing", said: "सी फ़ेसिंग" },
];

const LETTER: Record<string, string> = {
  A: "ए", B: "बी", C: "सी", D: "डी", E: "ई", F: "एफ़", G: "जी", H: "एच", I: "आई", J: "जे", K: "के", L: "एल", M: "एम",
  N: "एन", O: "ओ", P: "पी", Q: "क्यू", R: "आर", S: "एस", T: "टी", U: "यू", V: "वी", W: "डब्ल्यू", X: "एक्स", Y: "वाई", Z: "ज़ेड",
};

/** "Tower C" and "Wing B" as said: the voice read "Tower C" as "Towers ki". */
export function towerWords(context: string): Saying[] {
  const out = new Map<string, Saying>();
  for (const m of context.matchAll(/\b(Tower|Wing|Building|Phase)\s+([A-Z])\b/g)) {
    const word = m[1] === "Tower" ? "टावर" : m[1] === "Wing" ? "विंग" : m[1] === "Building" ? "बिल्डिंग" : "फ़ेज़";
    out.set(`${m[1]} ${m[2]}`, { written: `${m[1]} ${m[2]}`, said: `${word} ${LETTER[m[2]]}` });
  }
  for (const m of context.matchAll(/\b([A-Z])\s+(Tower|Wing|Building)\b/g)) {
    const word = m[2] === "Tower" ? "टावर" : m[2] === "Wing" ? "विंग" : "बिल्डिंग";
    out.set(`${m[1]} ${m[2]}`, { written: `${m[1]} ${m[2]}`, said: `${LETTER[m[1]]} ${word}` });
  }
  return [...out.values()];
}

export function wordsToSay(o: { own: readonly Saying[]; region: string | null; context: string; max?: number }): string {
  const max = o.max ?? SAY_WORDS_MAX;
  const taken = new Set<string>();
  const lines: string[] = [];
  let size = 0;
  const add = (s: Saying) => {
    const key = fold(s.written);
    if (!key || !s.said.trim() || taken.has(key)) return;
    const line = `${s.written.trim()} = ${s.said.trim()}`;
    if (size + line.length + 1 > max) return;
    taken.add(key);
    lines.push(line);
    size += line.length + 1;
  };
  for (const s of o.own) add(s);
  if (mentions(o.context, "BHK")) PROPERTY_WORDS.forEach(add);
  towerWords(o.context).forEach(add);
  COMMON_WORDS.filter((s) => mentions(o.context, s.written)).forEach(add);
  const region = o.region ? REGIONS[o.region]?.words ?? [] : [];
  [...region].sort((a, b) => b.written.length - a.written.length).filter((s) => mentions(o.context, s.written)).forEach(add);
  return lines.join("\n");
}

/** Words that name nothing: they are never a project's own hard words. */
const PLAIN = new Set(
  (
    "project tower phase location homes home bhk rera registration booking amount payment plan possession highlights never say " +
    "rs crore lakh carpet sq ft the a an and or of to in on at by for with from near minutes minute min station road nagar " +
    "east west north south city by its it is are as this that floor floors lift lifts wing sea facing open layout garden podium " +
    "acre acres plot towers construction linked percent on possession guaranteed returns assured rental investment opportunity " +
    "price will definitely appreciate starting from per month year years day days one two three four five six seven eight nine ten " +
    "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec " +
    "monday tuesday wednesday thursday friday saturday sunday " +
    "each every other only any anything all when what which there here also just more most very our your their if but not no"
  ).split(/\s+/),
);
/**
 * Lines of a call's facts that are ours, not the project's: the home-loan
 * and price-history block and the closing rule every call carries. Their
 * banks and sentence openers ("Each", "Only", "When") are not the project's
 * words, and checking them spent sayings on every project alike.
 */
const NOT_OURS_SECTION = /^home loans and price history:$/i;
const NOT_OURS_LINE = /^only what is written above is true\b/i;
/** Words that end a place's name ("Sebastian Road", "Goregaon West") and belong to it. */
const NAME_TAIL = new Set([
  "road", "nagar", "park", "colony", "street", "chowk", "wadi", "gaon", "city", "mall", "station", "highway", "expressway",
  "east", "west", "north", "south", "pond", "lake", "hills", "heights",
]);
/** Words that only lead into a name ("Near City Pond") and are dropped from its front. */
const LEAD_IN = new Set(["near", "the", "a", "an", "from", "to", "at", "in", "on", "by", "with", "and", "of", "opposite", "behind", "off"]);

/**
 * The words in a project's facts the voice may get wrong: its names and
 * places, the runs of capitalised words, and the project's, tower's and
 * developer's own names. Every one is checked by ear before it is called
 * hard; this only says which to check.
 */
export function wordsToCheck(o: { names: readonly (string | null | undefined)[]; facts: string; max?: number }): string[] {
  const out = new Map<string, string>();
  const keep = (w: string) => {
    const t = w.replace(/^[^\p{L}]+|[^\p{L}\p{N}]+$/gu, "").trim();
    if (t.length < 3 || t.length > SAYING_CAPS.writtenMax || /\d/.test(t)) return;
    const k = fold(t);
    if (!out.has(k)) out.set(k, t);
  };
  for (const n of o.names) if (n?.trim()) keep(n.trim());
  let skipping = false;
  for (const line of o.facts.split(/\n+/)) {
    if (NOT_OURS_SECTION.test(line.trim())) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s*- /.test(line)) continue;
    skipping = false;
    if (NOT_OURS_LINE.test(line.trim())) continue;
    // A field's own label ("Location:") is not a name; punctuation ends one.
    const tokens = line.replace(/^[^:]{1,40}:\s*/, "").match(/[\p{L}\p{N}'-]+|[^\p{L}\p{N}'\s-]+/gu) ?? [];
    let run: string[] = [];
    const flush = () => {
      while (run.length && LEAD_IN.has(run[0].toLowerCase())) run.shift();
      while (run.length && PLAIN.has(run[run.length - 1].toLowerCase()) && !NAME_TAIL.has(run[run.length - 1].toLowerCase())) run.pop();
      if (run.some((w) => !PLAIN.has(w.toLowerCase()) && !NAME_TAIL.has(w.toLowerCase()))) keep(run.join(" "));
      run = [];
    };
    for (const w of tokens) {
      if (/^\p{Lu}[\p{Ll}'-]+$/u.test(w) || /^\p{Lu}{2,6}$/u.test(w)) run.push(w);
      else flush();
    }
    flush();
  }
  return [...out.values()].slice(0, o.max ?? SAYING_CAPS.perCheck);
}

/**
 * Whether what came back from saying a word sounds like what was meant:
 * compared by consonant sound across both scripts, so वाकड़ heard for वाकड is
 * the same word and सप्त heard for साथ is not.
 */
export function heardAsMeant(meant: string, heard: string): boolean {
  if (!heard.trim()) return false;
  return spokenMatch([meant], heard) >= 0.75;
}

/** The sentence a word is said in for the check and the sample: how a caller would say it. */
export function carrierLine(word: string): string {
  return `जी, हम ${word.trim()} के बारे में बात कर रहे थे।`;
}

/** The word out of what a check heard: the sentence it was said in taken off. */
export function heardWord(heard: string | null | undefined): string | null {
  if (!heard?.trim()) return null;
  const m = heard.match(/हम\s+(.+?)\s+के\s+बारे/u);
  return (m?.[1] ?? heard).replace(/^[\s,।.]+|[\s,।.]+$/gu, "").trim() || null;
}

export type WordState = "WRONG" | "FAILED" | "UNCHECKED" | "RIGHT";

/**
 * What a word's row says. A check of a spelling that has changed since is no
 * check, so it reads as not checked, and the next check takes it.
 */
export function wordState(w: { verdict: "UNCHECKED" | "RIGHT" | "WRONG" | "FAILED"; sampled: boolean }): WordState {
  if (w.verdict === "FAILED") return "FAILED";
  if (w.verdict === "UNCHECKED" || !w.sampled) return "UNCHECKED";
  return w.verdict;
}

/** Whether the next check says this word. */
export const isDue = (w: Parameters<typeof wordState>[0]) => {
  const s = wordState(w);
  return s === "UNCHECKED" || s === "FAILED";
};

/** The rows in order: the ones that may sound wrong first, the right ones last. */
export const STATE_ORDER: Record<WordState, number> = { WRONG: 0, FAILED: 1, UNCHECKED: 2, RIGHT: 3 };

/** Why a correction will not do, or null. */
export function sayingProblem(written: string, said: string): string | null {
  const w = written.trim();
  const s = said.trim();
  if (!w) return "Say which word it is.";
  // A call carries the words as "written = said" lines: a line break would start a line of its own.
  if (/[\u0000-\u001f\u007f]/.test(w) || /[\u0000-\u001f\u007f]/.test(s)) return "Write the word on one line.";
  if (w.length > SAYING_CAPS.writtenMax) return `Keep the word under ${SAYING_CAPS.writtenMax} letters.`;
  if (!s) return null;
  if (s.length > SAYING_CAPS.saidMax) return `Keep how it is said under ${SAYING_CAPS.saidMax} letters.`;
  if (/[<>{}]|https?:/i.test(s)) return "Write only how the word is said.";
  return null;
}
