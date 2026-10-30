/**
 * The language a film speaks: the card's own (the client, 7 October 2026).
 * A Hindi card makes a Hindi film and a Marathi card a Marathi one. The
 * narrated story speaks pure Hindi or pure Marathi; every other format speaks
 * the way buyers in Mumbai and Pune talk, Hinglish or Marathi mixed with
 * everyday English. English, and any language not yet built, stays English.
 *
 * The writer writes each line once, in the film's language, in Devanagari,
 * its numbers in digits; the shots and everything else stay English. A
 * reading of the lines back into English (`readLinesBack()` in `film.ts`)
 * is what the English checks read (claims, never-say, whose story it is).
 * The digits are put into words here, by code, so the voice never guesses
 * at "₹1.45 करोड़".
 *
 * Pure, client-safe and covered by `check:logic`.
 */

export type FilmLanguage = {
  code: "en" | "hi" | "mr";
  /** How the lines are spoken. */
  style: "english" | "pure" | "mixed";
  /** The language as the prompt and the writer name it. */
  name: string;
};

export const ENGLISH: FilmLanguage = { code: "en", style: "english", name: "English" };

/** The film's language from its card's language and its template. */
export function filmLanguage(cardLanguage: string | null | undefined, skillKey: string): FilmLanguage {
  const story = skillKey === "story";
  const l = String(cardLanguage ?? "").trim().toLowerCase();
  if (l === "hindi" || l === "hi") {
    return story ? { code: "hi", style: "pure", name: "Hindi" } : { code: "hi", style: "mixed", name: "Hinglish" };
  }
  if (l === "marathi" || l === "mr") {
    return story ? { code: "mr", style: "pure", name: "Marathi" } : { code: "mr", style: "mixed", name: "Marathi mixed with everyday English" };
  }
  return ENGLISH;
}

/** How the writer is told to write the lines: in the film's language, and only in it. */
export function lineRule(lang: FilmLanguage): string {
  if (lang.code === "en") return "";
  const tongue = lang.code === "hi" ? "Hindi" : "Marathi";
  const how =
    lang.style === "pure"
      ? `pure, warm, everyday spoken ${tongue}, as a family in ${lang.code === "hi" ? "Mumbai" : "Pune"} would tell it; no English ` +
        "words except BHK and the names of places and the project"
      : `casual ${lang.name}: the ${tongue} a young buyer in ${lang.code === "hi" ? "Mumbai" : "Pune"} speaks, with the everyday ` +
        "English words people really use (flat, BHK, station, sea-facing, amenities, site visit, booking) and a little slang, " +
        "never stiff or bookish";
  return (
    `- LANGUAGE: every line is spoken in ${lang.name}. Write each "line" in ${how}, in Devanagari script (English words ` +
    "spelled in Devanagari too, the way they are said: फ्लैट, स्टेशन, सी-फेसिंग). Every number in a line is written in digits " +
    "(₹1.45 करोड़, 18वीं, 8 मिनट, 1 बीएचके), never in words: code says them. Everything else you write (the shots, the people, " +
    "the delivery, the title) stays in English, and the big text cards stay in English capitals. Count the words of a line " +
    "as the voice will say them, the way you count English. " +
    `Never write ${Object.keys(LOCAL_SWAPS).join(", ")}: write ${Object.values(LOCAL_SWAPS).join(", ")} instead, which the voice says right.`
  );
}

/** The voice's own direction, in the film's language. */
export function voiceIn(voice: string | null, lang: FilmLanguage): string | null {
  if (!voice || lang.code === "en") return voice;
  const language =
    lang.style === "pure" ? `natural spoken ${lang.name}` : `casual ${lang.name}, like a young Mumbai or Pune creator talking to a friend`;
  return voice.replace(/\b(?:clear |neutral )?(?:Indian |urban Mumbai )?English\b(?: with a light (?:Indian )?accent)?/g, language);
}

/** The writer's rules that say "English only", made right for the film's language: the cards stay English. */
export function neverIn(never: readonly string[], lang: FilmLanguage): string[] {
  if (lang.code === "en") return [...never];
  return never.map((n) =>
    /^Write a line in Hindi or in Devanagari/.test(n)
      ? "Write a big text card in Hindi or in Devanagari: every card is in English capitals."
      : n,
  );
}

// ---------------------------------------------------------------------------
// Numbers said in Hindi and Marathi
// ---------------------------------------------------------------------------

const HI = (
  "शून्य एक दो तीन चार पांच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस " +
  "चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस " +
  "इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन " +
  "सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर " +
  "पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे " +
  "इक्यानबे बानबे तिरानबे चौरानबे पंचानबे छियानबे सत्तानबे अट्ठानबे निन्यानबे"
).split(" ");

const MR = (
  "शून्य एक दोन तीन चार पाच सहा सात आठ नऊ दहा अकरा बारा तेरा चौदा पंधरा सोळा सतरा अठरा एकोणीस वीस एकवीस बावीस तेवीस " +
  "चोवीस पंचवीस सव्वीस सत्तावीस अठ्ठावीस एकोणतीस तीस एकतीस बत्तीस तेहेतीस चौतीस पस्तीस छत्तीस सदतीस अडतीस एकोणचाळीस " +
  "चाळीस एक्केचाळीस बेचाळीस त्रेचाळीस चव्वेचाळीस पंचेचाळीस सेहेचाळीस सत्तेचाळीस अठ्ठेचाळीस एकोणपन्नास पन्नास एक्कावन्न " +
  "बावन्न त्रेपन्न चोपन्न पंचावन्न छप्पन्न सत्तावन्न अठ्ठावन्न एकोणसाठ साठ एकसष्ठ बासष्ठ त्रेसष्ठ चौसष्ठ पासष्ठ सहासष्ठ " +
  "सदुसष्ठ अडुसष्ठ एकोणसत्तर सत्तर एकाहत्तर बाहत्तर त्र्याहत्तर चौऱ्याहत्तर पंच्याहत्तर शहात्तर सत्त्याहत्तर अठ्ठ्याहत्तर " +
  "एकोणऐंशी ऐंशी एक्क्याऐंशी ब्याऐंशी त्र्याऐंशी चौऱ्याऐंशी पंच्याऐंशी शहाऐंशी सत्त्याऐंशी अठ्ठ्याऐंशी एकोणनव्वद नव्वद " +
  "एक्क्याण्णव ब्याण्णव त्र्याण्णव चौऱ्याण्णव पंच्याण्णव शहाण्णव सत्त्याण्णव अठ्ठ्याण्णव नव्व्याण्णव"
).split(" ");

const UNIT = {
  hi: { hundred: "सौ", thousand: "हज़ार", lakh: "लाख", crore: "करोड़", point: "पॉइंट", rupees: "रुपये", minutes: "मिनट", km: "किलोमीटर", percent: "प्रतिशत", sqft: "स्क्वेयर फ़ीट", bhk: "बीएचके" },
  mr: { hundred: "शे", thousand: "हजार", lakh: "लाख", crore: "कोटी", point: "पॉइंट", rupees: "रुपये", minutes: "मिनिटे", km: "किलोमीटर", percent: "टक्के", sqft: "स्क्वेअर फूट", bhk: "बीएचके" },
} as const;

/** A whole number in Hindi or Marathi words, the Indian way (हज़ार, लाख, करोड़). */
export function numberIn(n: number, code: "hi" | "mr"): string {
  const w = code === "hi" ? HI : MR;
  const u = UNIT[code];
  if (!Number.isFinite(n) || n < 0) return String(n);
  n = Math.floor(n);
  if (n < 100) return w[n];
  const parts: string[] = [];
  const take = (size: number, unit: string) => {
    const k = Math.floor(n / size);
    if (k) {
      parts.push(`${numberIn(k, code)} ${unit}`);
      n -= k * size;
    }
  };
  take(10_000_000, u.crore);
  take(100_000, u.lakh);
  take(1000, u.thousand);
  if (n >= 100) {
    const k = Math.floor(n / 100);
    // Marathi joins the hundred to its count: "दोनशे".
    parts.push(code === "mr" ? `${w[k]}${u.hundred}` : `${w[k]} ${u.hundred}`);
    n -= k * 100;
  }
  if (n) parts.push(w[n]);
  return parts.join(" ");
}

const fold = (s: string) => s.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)));

/** A money amount in a unit, said: "1.45 करोड़" is "एक करोड़ पैंतालीस लाख". */
function moneyIn(amount: string, unit: "crore" | "lakh", code: "hi" | "mr"): string {
  const u = UNIT[code];
  const [whole, frac = ""] = amount.replace(/,/g, "").split(".");
  const w = Number(whole) || 0;
  if (unit === "crore" && frac) {
    // The fraction of a crore is lakhs: .45 is 45 lakh, .5 is 50 lakh.
    const lakhs = Math.round(Number(`0.${frac}`) * 100);
    return [w ? `${numberIn(w, code)} ${u.crore}` : "", lakhs ? `${numberIn(lakhs, code)} ${u.lakh}` : ""].filter(Boolean).join(" ");
  }
  if (frac) return `${numberIn(w, code)} ${u.point} ${frac.split("").map((d) => numberIn(Number(d), code)).join(" ")} ${unit === "crore" ? u.crore : u.lakh}`;
  return `${numberIn(w, code)} ${unit === "crore" ? u.crore : u.lakh}`;
}

/**
 * A line in Hindi or Marathi as it is SAID: every figure in words, money in
 * crore and lakh, BHK as its letters, a star dropped. The writer writes
 * digits so the gate can read them; the voice is handed words.
 */
export function spokenFormIn(line: string, code: "hi" | "mr"): string {
  const u = UNIT[code];
  const num = (s: string) => {
    const [whole, frac] = s.replace(/,/g, "").split(".");
    return frac ? `${numberIn(Number(whole), code)} ${u.point} ${frac.split("").map((d) => numberIn(Number(d), code)).join(" ")}` : numberIn(Number(whole), code);
  };
  return fold(line)
    .replace(/(?:₹|\bRs\.?)\s*(\d[\d,]*(?:\.\d+)?)\s*(?:करोड़|करोड|कोटी|Cr|crore)\*?/gi, (_, n: string) => moneyIn(n, "crore", code))
    .replace(/(?:₹|\bRs\.?)\s*(\d[\d,]*(?:\.\d+)?)\s*(?:लाख|L|lakh)\*?/gi, (_, n: string) => moneyIn(n, "lakh", code))
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*(?:करोड़|करोड|कोटी)\*?/g, (_, n: string) => moneyIn(n, "crore", code))
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*लाख\*?/g, (_, n: string) => moneyIn(n, "lakh", code))
    .replace(/(?:₹|\bRs\.?)\s*(\d[\d,]*(?:\.\d+)?)\*?/gi, (_, n: string) => `${num(n)} ${u.rupees}`)
    .replace(/(\d+)\s*(?:BHK|बीएचके)/gi, (_, n: string) => `${num(n)} ${u.bhk}`)
    .replace(/\bBHK\b/gi, u.bhk)
    .replace(/(\d+)\s*%/g, (_, n: string) => `${num(n)} ${u.percent}`)
    .replace(/(\d[\d,]*(?:\.\d+)?)/g, (n) => num(n))
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words in a line of any script. */
export function wordCount(line: string): number {
  return line.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** True when a line is written in Devanagari for the most part. */
export function isDevanagari(line: string): boolean {
  const deva = (line.match(/[ऀ-ॿ]/g) ?? []).length;
  const latin = (line.match(/[A-Za-z]/g) ?? []).length;
  return deva > 0 && deva >= latin * 2;
}

// ---------------------------------------------------------------------------
// How the video's voice is told to say a Hindi or Marathi line
// ---------------------------------------------------------------------------

/**
 * Words the video's voice says wrong, with how they are said. The first Hindi
 * film (7 October 2026) said गोरेगांव as "घोरेगम", करोड़ as "कराह", देर as
 * "धियर" and चेहरा as "छेरा": it reads Devanagari the way an English speaker
 * would, breathing on a द, त, च or ग that is plain. A name or a unit is
 * listed under the voice once, with its sound in English letters; the line
 * itself stays as written.
 */
export const LOCAL_SAY: Readonly<Record<string, string>> = {
  "गोरेगांव": "Go-ray-gaanv, a plain G, never Gh",
  "गोरेगाव": "Go-ray-gaav, a plain G, never Gh",
  "करोड़": "ka-rodh, one word, never karaah",
  "करोड": "ka-rodh, one word, never karaah",
  "कोटी": "ko-tee",
  "लाख": "laakh",
  "बीएचके": "B-H-K, its three letters as one word",
  "देर": "dayr, a plain d",
  "चेहरा": "chay-hraa, a plain ch",
  "उतर": "u-tar, a soft t",
  "दो": "do, a soft d",
  "वक़्त": "wakt",
  "स्टेशन": "station",
};

/**
 * Words the writer may not use, with what is written instead: the video's
 * voice heard a known English word in them. समय came back "smile".
 */
export const LOCAL_SWAPS: Readonly<Record<string, string>> = {
  "समय": "वक़्त",
};

/** A line with the words the voice mistakes swapped for ones it says right. */
export function localTidy(line: string): string {
  let out = line;
  for (const [from, to] of Object.entries(LOCAL_SWAPS)) out = out.replace(new RegExp(`(^|[\\s,।!?])${from}(?=[\\s,।!?]|$)`, "g"), `$1${to}`);
  return out;
}

/**
 * The voice's pronunciation, for a film in Hindi or Marathi: a native speaker
 * of the language, plain consonants kept plain, and every listed word in the
 * lines with its sound.
 */
export function localSayHow(lines: readonly string[], code: "hi" | "mr"): string {
  const said = lines.join(" ");
  const words = Object.entries(LOCAL_SAY).filter(([w]) => said.includes(w));
  const tongue = code === "hi" ? "Hindi" : "Marathi";
  return (
    ` The voice is a native ${tongue} speaker from ${code === "hi" ? "Mumbai" : "Pune"}, and says every word with ${tongue} sounds: ` +
    "द, त, च and ग are plain, with no breath after them, and ध, थ, छ and घ are breathy only where they are written; " +
    "an English word is said the way an Indian says it." +
    (words.length ? ` How to say: ${words.map(([w, h]) => `${w} (${h})`).join("; ")}.` : "")
  );
}

const ORDINAL_WORDS: Record<"hi" | "mr", string[]> = {
  hi: ["तीसरा", "तीसरी", "तीसरे", "चौथा", "चौथी", "चौथे", "छठा", "छठी", "छठे"],
  mr: ["तिसरा", "तिसरी", "तिसरे", "चौथा", "चौथी", "चौथे", "सहावा", "सहावी", "सहावे"],
};

/**
 * Numbers a Hindi or Marathi line writes in words, which it may not: every
 * number is written in digits, so the gate can read it. Sarvam's writer
 * wrote "आठवीं मंज़िल" (eighth floor) for the signed eighteenth (8 October
 * 2026), and in words the gate read nothing. "एक" and "दो" are left (a, give).
 */
export function numberWordsIn(line: string, code: "hi" | "mr"): string[] {
  const table = code === "hi" ? HI : MR;
  const cardinal = new Set(table.slice(3).map((w) => w.replace(/ँ/g, "ं")));
  const words = line.replace(/ँ/g, "ं").replace(/[^\p{L}\p{M}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return words.filter((w) => {
    if (cardinal.has(w) || ORDINAL_WORDS[code].includes(w)) return true;
    const stem = w.replace(/(?:वाँ|वां|वीं|वें|वा|वी|वे)$/, "");
    return stem !== w && (cardinal.has(stem) || cardinal.has(stem.replace(/ह$/, "")) || table.includes(stem));
  });
}

/**
 * A card a Hindi or Marathi writer set in Devanagari, in the English capitals
 * every card is set in, when it is only a configuration and a price: "1
 * बीएचके / ₹1.45 करोड़" is "1 BHK / ₹1.45 CR". Anything else stays as written,
 * for the check to send back.
 */
export function localCard(text: string): string {
  const t = String(text ?? "")
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
    .replace(/बीएचके|बी\s?एच\s?के/g, "BHK")
    .replace(/करोड़|करोड|कोटी/g, "CR")
    .replace(/लाख/g, "L")
    .replace(/\s*(?:से|पासून)\s*(?:शुरू)?\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return /[ऀ-ॿ]/.test(t) ? text : t;
}
