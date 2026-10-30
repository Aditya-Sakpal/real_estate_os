/**
 * The pixel gate, decided without a picture: what was read off a finished
 * frame, measured against what the frame must carry.
 *
 * Every other gate in this product reads what we MEANT to put on an
 * advertisement: the copy before it is drawn, the layout before it is
 * rendered, the registration before anything is spent. This one reads what a
 * buyer will actually see, the raster, because that is where the ways it goes
 * wrong live: the image model draws "P52IOO012345", Marathi copy wraps and
 * pushes a block out of its quarter, a pale line of small print sits on a
 * pale sky, a QR is pasted into a slot too small to scan.
 *
 * `pixel.ts` reads the frame (the QR decoded at several sizes, the words by
 * OCR, glyph heights and contrast measured on the pixels) and this file
 * decides. Deciding in code rather than asking a model is the split every
 * other gate here makes: a reader reads, and is not trusted with a verdict.
 *
 * Three verdicts, as everywhere else. PASS publishes; FAIL never publishes;
 * HOLD renders and never publishes, for what a machine cannot settle (a
 * registration inside thirty days of lapsing, a frame the reader could not
 * read at all). A post without a PASS never reaches a platform: `prepare()`
 * refuses it, AUTO included.
 *
 * Imports are relative because the checks and the worker load this straight
 * from source.
 */

import { adPrice, CONFIG_PRICE_TOLERANCE, EXPIRY_HOLD_DAYS, moneyIn, toAsciiDigits, type UnitPrice } from "./creative-rules.ts";
import { configsNamedIn } from "./unit-rules.ts";
import { RERA_WEBSITE } from "./compose-rules.ts";

export type PixelVerdict = "PASS" | "FAIL" | "HOLD";
export type PxBox = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------------------
// The codes
// ---------------------------------------------------------------------------

export type PixelCode =
  | "QR_UNREADABLE"
  | "QR_TOO_SMALL"
  | "QR_WRONG"
  | "QR_NOT_AUTHORITY"
  | "LOCKUP_OUTSIDE"
  | "LOCKUP_MISPLACED"
  | "REG_MISSING"
  | "REG_MISPRINT"
  | "REG_WRONG"
  | "REG_SMALL"
  | "WEBSITE_MISSING"
  | "CONTACT_UNREAD"
  | "CONTRAST_LOW"
  | "NO_IMPRESSION"
  | "PRICE_WRONG_CONFIG"
  | "PRICE_UNKNOWN"
  | "RENDER_CHANGED"
  | "REG_LAPSING"
  | "NOT_CHECKED";

/** What each code does to a post. */
export const PIXEL_VERDICT: Record<PixelCode, Exclude<PixelVerdict, "PASS">> = {
  QR_UNREADABLE: "FAIL",
  QR_TOO_SMALL: "FAIL",
  QR_WRONG: "FAIL",
  // The approved lockup is a person's approval, and it does not point at the
  // Authority. That is a question for a person, not a refusal by a machine.
  QR_NOT_AUTHORITY: "HOLD",
  LOCKUP_OUTSIDE: "FAIL",
  LOCKUP_MISPLACED: "FAIL",
  REG_MISSING: "FAIL",
  REG_MISPRINT: "FAIL",
  REG_WRONG: "FAIL",
  REG_SMALL: "FAIL",
  WEBSITE_MISSING: "FAIL",
  CONTACT_UNREAD: "FAIL",
  CONTRAST_LOW: "FAIL",
  NO_IMPRESSION: "FAIL",
  PRICE_WRONG_CONFIG: "FAIL",
  PRICE_UNKNOWN: "FAIL",
  RENDER_CHANGED: "FAIL",
  // Section 6 allows an extension and it is not automatic.
  REG_LAPSING: "HOLD",
  NOT_CHECKED: "HOLD",
};

/**
 * In the client's words, for the tile. One line each, saying what is wrong
 * with the picture rather than which rule found it.
 */
export const PIXEL_TEXT: Record<PixelCode, string> = {
  QR_UNREADABLE: "The QR code on the picture does not scan.",
  QR_TOO_SMALL: "The QR code is too small to scan on a phone or in print.",
  QR_WRONG: "The QR code opens a different registration.",
  QR_NOT_AUTHORITY: "The approved QR code does not open the RERA authority's website. Check the lockup in the Library.",
  LOCKUP_OUTSIDE: "The QR code, RERA number and website are not all in the top-right quarter.",
  LOCKUP_MISPLACED: "The RERA number and website are not in the strip along the foot.",
  REG_MISSING: "The RERA number cannot be read on the picture.",
  REG_MISPRINT: "The RERA number has a letter where a digit belongs (I for 1, or O for 0).",
  REG_WRONG: "The RERA number on the picture is not this tower's.",
  REG_SMALL: "The RERA number is smaller than the phone number or website.",
  WEBSITE_MISSING: "The RERA authority's website cannot be read on the picture.",
  CONTACT_UNREAD: "The phone number cannot be read on the picture.",
  CONTRAST_LOW: "Some of the RERA details or small print are too faint to read against the picture.",
  NO_IMPRESSION: "\"Artist's impression\" is missing from a picture made from a render.",
  PRICE_WRONG_CONFIG: "A price on the picture belongs to a different configuration.",
  PRICE_UNKNOWN: "A price on the picture is not an approved price.",
  RENDER_CHANGED: "The approved picture was changed in the post.",
  REG_LAPSING: "The registration runs out within 30 days, so this waits for a person.",
  NOT_CHECKED: "The picture could not be checked.",
};

/**
 * What the image model is told when a failure is its own to fix. No number
 * in any of them: the model is never told a number (`checkDesignPrompt()`),
 * and the registration line it must set is quoted from the cleared lines,
 * which the guardrail strips before it looks for digits.
 */
export const PIXEL_FIX: Partial<Record<PixelCode, string>> = {
  QR_TOO_SMALL: "The QR code is too small to scan. Draw its square noticeably larger, still inside the upper-right quarter.",
  LOCKUP_OUTSIDE:
    "Keep the QR code, the registration number and the RERA website wholly inside the upper-right quarter of the ad.",
  LOCKUP_MISPLACED: "Keep the registration number and the RERA website wholly inside the strip along the foot of the ad.",
  REG_MISSING: "The registration number could not be read. Set it clearly, in a plain sans-serif, on a calm plain area.",
  REG_MISPRINT: "The registration number was set with a letter in place of a digit. Set every character exactly as given, in a plain sans-serif.",
  REG_WRONG: "The registration number was set wrongly. Set every character exactly as given.",
  REG_SMALL:
    "Set the registration number and the RERA website clearly larger than the phone number and website in the footnote.",
  WEBSITE_MISSING: "The RERA website could not be read. Set it clearly beside the registration number.",
  CONTACT_UNREAD: "The phone number in the footnote could not be read. Set it clearly, on a calm area.",
  CONTRAST_LOW:
    "The registration details or the small print are too faint. Set them in a colour that stands out strongly from what is behind them, or on a plain panel.",
  NO_IMPRESSION: "Add the words 'Artist's impression.' to the small print.",
  PRICE_WRONG_CONFIG: "A price was set beside the wrong configuration. Set the price lines exactly as given.",
  PRICE_UNKNOWN: "A price was set wrongly. Set the price lines exactly as given, and no other amount.",
};

/** Which failures another drawing can fix, when the model drew the thing that failed. */
const LOCKUP_CODES: ReadonlySet<PixelCode> = new Set<PixelCode>([
  "QR_TOO_SMALL", "LOCKUP_OUTSIDE", "LOCKUP_MISPLACED", "REG_MISSING", "REG_MISPRINT", "REG_WRONG", "REG_SMALL", "WEBSITE_MISSING",
  "CONTACT_UNREAD", "CONTRAST_LOW", "NO_IMPRESSION",
]);
const COPY_CODES: ReadonlySet<PixelCode> = new Set<PixelCode>(["PRICE_WRONG_CONFIG", "PRICE_UNKNOWN"]);

export type PixelFinding = {
  code: PixelCode;
  verdict: Exclude<PixelVerdict, "PASS">;
  text: string;
  /** For the record and the log: what was measured, never a phone number. */
  detail?: string;
};

export function finding(code: PixelCode, detail?: string): PixelFinding {
  return { code, verdict: PIXEL_VERDICT[code], text: PIXEL_TEXT[code], ...(detail ? { detail } : {}) };
}

export function verdictOf(findings: readonly { verdict: PixelVerdict }[]): PixelVerdict {
  if (findings.some((f) => f.verdict === "FAIL")) return "FAIL";
  if (findings.some((f) => f.verdict === "HOLD")) return "HOLD";
  return "PASS";
}

// ---------------------------------------------------------------------------
// The thresholds, stated
// ---------------------------------------------------------------------------

/**
 * The sizes the QR must still scan at. A feed post is seen smaller than it
 * was made: full width on a phone, three quarters of that in a feed with
 * margins, and about six tenths in a laptop's feed column, which is where a
 * buyer sits when they reach for their phone to scan a code on a screen.
 */
export const QR_SCALES = [1, 0.75, 0.6] as const;

/**
 * And printed. The same file goes into a brochure or onto a flyer at 150 or
 * 300 dots an inch, and a phone reads a print through its camera preview at
 * about twelve pixels a millimetre, held a hand's width from the page. The
 * QR is resampled to what that camera sees, softened by the print and the
 * lens (`CAPTURE_BLUR`, in the camera's pixels), and must still scan.
 */
export const PRINT_DPIS = [150, 300] as const;
export const CAPTURE_PX_PER_MM = 12;
export const CAPTURE_BLUR = 0.6;

/** The names the renditions are recorded under. */
export function qrRenditions(): string[] {
  return [...QR_SCALES.map((s) => `screen ${Math.round(s * 100)}%`), ...PRINT_DPIS.map((d) => `print ${d} dpi`)];
}

/**
 * Contrast of the registration details and the small print against what is
 * behind them, as WCAG measures it. 4.5 to 1 is WCAG's floor for text this
 * size. It is measured from the pixels, stroke core against the ground round
 * the line, so anti-aliasing never counts against a line that reads well.
 */
export const CONTRAST_FLOOR = 4.5;

/**
 * Glyph heights are measured, not assumed, and a measurement has an error.
 * The registration number passes when it is at least this fraction of the
 * largest contact detail's height: five per cent, about half a pixel on the
 * footnote of a feed post, which is the error measured on type set at the
 * same size twice.
 */
export const HEIGHT_TOLERANCE = 0.95;

/** How far outside the quarter a box may measure and still be inside it: OCR boxes are loose by a pixel or two. */
export const QUARTER_SLACK = 0.004;

/**
 * An approved picture's region, compared with what the post shows there.
 * JPEG moves every pixel a little; a redrawn picture moves them a lot.
 */
export const REGION_MEAN_DIFF = 6;
export const REGION_CLOSE_SHARE = 0.9;
export const REGION_CLOSE_LEVELS = 24;

/**
 * What an advertisement must carry for the authority it is registered with.
 * Maharashtra's today; another state's rule (`rera-ad-rules.ts`) fills the
 * same shape.
 */
export type AuthorityRule = {
  /** The website printed beside the number. */
  website: string;
  /** The hosts a project page the QR opens may be served from. */
  hosts: readonly string[];
  /** Whether a QR is required, or printed only where the authority issued one. */
  qrRequired: boolean;
  /** Where the block sits. */
  place: "TOP_RIGHT" | "BOTTOM_STRIP";
  /** Whether the number is measured against the largest contact detail. */
  sizeAgainstContact: boolean;
};

export const MAHARERA_RULE: AuthorityRule = {
  website: RERA_WEBSITE,
  hosts: ["maharera.maharashtra.gov.in", "www.maharera.maharashtra.gov.in", "maharera.mahaonline.gov.in", "maharerait.maharashtra.gov.in"],
  qrRequired: true,
  place: "TOP_RIGHT",
  sizeAgainstContact: true,
};

// ---------------------------------------------------------------------------
// What was read
// ---------------------------------------------------------------------------

/** One line of text the reader found, in the frame's own pixels. */
export type ReadLine = { text: string; box: PxBox };

/** A glyph of the registration number: its ink's box. */
export type Glyph = { w: number; h: number };

/** Something the gate looked for and found, with what the pixels measured. */
export type Measured = {
  text: string;
  box: PxBox;
  /** Cap height in pixels (for lower-case words, the ascender height scaled to it). Null when it could not be measured. */
  glyphPx: number | null;
  /** WCAG contrast of the line against its ground, or null. */
  contrast: number | null;
};

export type RasterReading = {
  w: number;
  h: number;
  qr: {
    box: PxBox | null;
    /** What it decodes to at full size, or null. */
    payload: string | null;
    /** Each rendition and whether it decoded to the same thing. */
    renditions: { name: string; ok: boolean }[];
  };
  lines: ReadLine[];
  registration: (Measured & { reads: string[]; glyphs: Glyph[] }) | null;
  website: Measured | null;
  phone: Measured | null;
  /** The developer's own website, as a contact detail. */
  contactSite: Measured | null;
  impression: Measured | null;
  /** The other small print read near the impression line, for contrast. */
  smallPrint: Measured[];
  /** Set when an approved picture's region was compared. */
  region?: { meanDiff: number; closeShare: number } | null;
  /** The reader failed outright. */
  error?: string | null;
};

/** What one frame must carry. */
export type FrameExpect = {
  registrationNo: string | null;
  /** The authority's rule for what the registration block carries and where. */
  authority: AuthorityRule;
  /** What the approved lockup's own QR decodes to, or null when there is none to compare with. */
  qrPayload: string | null;
  phone: string | null;
  /** The developer's website as printed, without the scheme. */
  website: string | null;
  /** A render was used, so "Artist's impression" must be printed. */
  render: boolean;
  /** Whether a contact detail should be on this frame (a reel shows it only on the end card). */
  contact: boolean;
  configurations: readonly UnitPrice[];
  /** Every other amount somebody signed (a booking amount), in rupees. */
  money: readonly number[];
  registrationDaysLeft: number | null;
};

// ---------------------------------------------------------------------------
// Finding things in what was read
// ---------------------------------------------------------------------------

/** Upper-case letters and digits only. */
export const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Characters a reader and a drawing model both confuse with a digit. */
const AS_DIGIT: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", "|": "1", "!": "1", S: "5", B: "8", Z: "2" };
const digitish = (s: string) => [...s.toUpperCase()].map((c) => AS_DIGIT[c] ?? c).join("").replace(/[^A-Z0-9]/g, "");

/** Levenshtein distance. */
export function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function union(boxes: readonly PxBox[]): PxBox {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
}

export type WordBox = { text: string; box: PxBox };

/**
 * Where a token is on the frame: the run of words whose letters hold it,
 * matched loosely (`fold` decides how), with its box cut down to the
 * characters that are the token when a word carries more ("No.P52100012345").
 * The raw characters are returned as read, so the caller can decide whether a
 * difference is the reader's or the picture's.
 */
export function locate(
  lines: readonly { words: WordBox[] }[],
  want: string,
  opts: { fold: (s: string) => string; maxEdits: number },
): { raw: string; box: PxBox; edits: number }[] {
  const target = opts.fold(want);
  if (!target) return [];
  const out: { raw: string; box: PxBox; edits: number }[] = [];
  for (const line of lines) {
    const ws = line.words;
    for (let i = 0; i < ws.length; i++) {
      for (let n = 1; n <= 5 && i + n <= ws.length; n++) {
        const run = ws.slice(i, i + n);
        const chars: { c: string; word: number; at: number; len: number }[] = [];
        run.forEach((w, k) => {
          const letters = [...w.text].filter((c) => opts.fold(c));
          letters.forEach((c, at) => chars.push({ c, word: k, at, len: letters.length }));
        });
        const folded = chars.map((c) => opts.fold(c.c)).join("");
        if (folded.length < target.length - opts.maxEdits) continue;
        // Every window of the target's length (and one either side), best first.
        let best: { from: number; to: number; edits: number } | null = null;
        for (const len of [target.length, target.length - 1, target.length + 1]) {
          for (let s = 0; len > 0 && s + len <= folded.length; s++) {
            const d = distance(folded.slice(s, s + len), target);
            if (d <= opts.maxEdits && (!best || d < best.edits)) best = { from: s, to: s + len, edits: d };
          }
        }
        if (!best) continue;
        const picked = chars.slice(best.from, best.to);
        const boxes = run
          .map((w, k) => {
            const mine = picked.filter((p) => p.word === k);
            if (!mine.length) return null;
            const len = mine[0].len || 1;
            const first = Math.min(...mine.map((p) => p.at));
            const last = Math.max(...mine.map((p) => p.at));
            return { x: w.box.x + (w.box.w * first) / len, y: w.box.y, w: (w.box.w * (last - first + 1)) / len, h: w.box.h };
          })
          .filter((b): b is PxBox => !!b);
        out.push({ raw: picked.map((p) => p.c).join(""), box: union(boxes), edits: best.edits });
        break;
      }
    }
  }
  return out.sort((a, b) => a.edits - b.edits);
}

/** The registration number, however the reader slipped on I and O. */
export function locateRegistration(lines: readonly { words: WordBox[] }[], registrationNo: string) {
  return locate(lines, registrationNo, { fold: digitish, maxEdits: 2 });
}

/** The phone, by its last ten digits: a reader drops the spaces and the plus. */
export function locatePhone(lines: readonly { words: WordBox[] }[], phone: string) {
  const digits = phone.replace(/\D/g, "").slice(-10);
  return digits.length < 6 ? [] : locate(lines, digits, { fold: (s) => s.replace(/\D/g, ""), maxEdits: 1 });
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A web address, allowing a slip of the reader's in every ten letters. */
export function locateSite(lines: readonly { words: WordBox[] }[], host: string) {
  const want = letters(host);
  return want ? locate(lines, want, { fold: letters, maxEdits: Math.max(1, Math.floor(want.length / 10)) }) : [];
}

/** "Artist's impression", however the apostrophe and a letter or two came out. */
export function locateImpression(lines: readonly { words: WordBox[] }[]) {
  return locate(lines, "artistsimpression", { fold: letters, maxEdits: 3 });
}

// ---------------------------------------------------------------------------
// The registration number, read exactly
// ---------------------------------------------------------------------------

/**
 * A digit a glyph of that shape is not. An O is rounder than the other
 * figures of its number and a 0 is not: across the faces bundled here and the
 * posts the image model drew, a 0 measured at most 1.25 times the width (for
 * its height) of the number's 2 to 9, and an O at least 1.28. An I is a bare
 * bar: at most 0.22 of its height wide, and a third of the other figures'
 * width, where every 1 measured wider. Cinzel's 1 is drawn as a Roman I, and
 * a reader could not tell it from one either.
 */
export const O_WIDER = 1.28;
export const I_NARROWER = 0.33;
export const I_MAX_ASPECT = 0.22;

export type RegRead = { kind: "exact" | "misprint" | "different"; at: number[] };

/**
 * Whether what was read is the registration number, character for
 * character.
 *
 * A reader confuses I with 1 and O with 0 as readily as a drawing model does,
 * so a confusion is settled by the glyph's shape when the glyphs could be
 * separated: in any sans-serif an O is rounder than the 0s beside it and an I
 * is a bar with no flag. A 0 the reader called O, shaped like the other
 * digits, is a 0. An O shaped like an O is a misprint whatever the reader
 * said. Anything else that differs is a different number.
 */
export function readRegistration(expected: string, raw: string, glyphs: readonly Glyph[] = []): RegRead {
  const want = alnum(expected);
  const seen = alnum(raw.replace(/[|!]/g, "I"));
  if (seen.length !== want.length) return { kind: "different", at: [] };
  const shaped = glyphs.length === want.length;
  const aspect = (g: Glyph) => g.w / Math.max(1, g.h);
  const refs = [...want].map((c, i) => (/[2-9]/.test(c) && shaped ? aspect(glyphs[i]) : null)).filter((v): v is number => v !== null);
  const median = refs.length ? [...refs].sort((a, b) => a - b)[Math.floor(refs.length / 2)] : null;
  const looksLetter = (i: number, digit: string): boolean | null => {
    if (!shaped || median === null) return null;
    const a = aspect(glyphs[i]);
    if (digit === "0") return a > median * O_WIDER;
    if (digit === "1") return a < Math.min(I_MAX_ASPECT, median * I_NARROWER);
    return null;
  };
  const mis: number[] = [];
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    const s = seen[i];
    if (w === s) {
      if ((w === "0" || w === "1") && looksLetter(i, w) === true) mis.push(i);
      continue;
    }
    const confusable = (w === "0" && "OQD".includes(s)) || (w === "1" && "IL".includes(s));
    if (!confusable) return { kind: "different", at: [i] };
    // The reader said a letter: the shape decides when there is one to read.
    if (looksLetter(i, w) !== false) mis.push(i);
  }
  return mis.length ? { kind: "misprint", at: mis } : { kind: "exact", at: [] };
}

/** The best of several reads of the number: any exact read wins, then a misprint, then a different number. */
export function bestRead(expected: string, reads: readonly string[], glyphs: readonly Glyph[] = []): RegRead | null {
  if (!reads.length) return null;
  const all = reads.map((r) => readRegistration(expected, r, glyphs));
  const rank = { exact: 0, misprint: 1, different: 2 } as const;
  return all.sort((a, b) => rank[a.kind] - rank[b.kind])[0];
}

// ---------------------------------------------------------------------------
// The QR
// ---------------------------------------------------------------------------

/**
 * Whether a QR's payload may be this phase's: the one the approved lockup
 * itself carries, and, when it names a registration number, this one.
 */
export function qrIsThisPhase(payload: string, approved: string | null, registrationNo: string | null): boolean {
  if (approved !== null && payload !== approved) return false;
  const named: string[] = alnum(payload).match(/P\d{11}/g) ?? [];
  if (registrationNo && named.length && !named.includes(alnum(registrationNo))) return false;
  return true;
}

/** Whether a payload opens a page on the authority's own site. */
export function isAuthorityUrl(payload: string, hosts: readonly string[]): boolean {
  try {
    const u = new URL(payload);
    return (u.protocol === "https:" || u.protocol === "http:") && hosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Wholly inside the upper-right quarter, give or take a reader's pixel. */
export function inQuarter(b: PxBox, w: number, h: number): boolean {
  const t = Math.min(w, h) * QUARTER_SLACK;
  return b.x >= w / 2 - t && b.y >= -t && b.x + b.w <= w + t && b.y + b.h <= h / 2 + t;
}

/** Where the authority's rule puts the block: the upper-right quarter, or a strip along the foot. */
export function inPlace(b: PxBox, w: number, h: number, place: AuthorityRule["place"]): boolean {
  if (place === "TOP_RIGHT") return inQuarter(b, w, h);
  const t = Math.min(w, h) * QUARTER_SLACK;
  return b.y >= h * 0.75 - t && b.y + b.h <= h + t && b.x >= -t && b.x + b.w <= w + t;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const SCALE: Record<string, number> = { cr: 1e7, crore: 1e7, crores: 1e7, lakh: 1e5, lakhs: 1e5, lac: 1e5, l: 1e5 };

/**
 * Amounts in a line the reader returned, with the ways a reader misreads the
 * rupee sign kept apart. "₹" comes back as "¥", "%", "&", "F", "Z", or as a
 * digit glued to the figure ("₹2.19 Cr" was read as "32.19 Cr" off our own
 * Noto type); and "2.19 Cr" with no sign at all is still a price in crore.
 * An alternative only ever clears a reading that then equals an approved
 * price, and the design check has already read the price line letter by
 * letter.
 */
export function amountsIn(line: string): { value: number; alternatives: number[] }[] {
  const text = toAsciiDigits(line).replace(/[¥]/g, "₹").replace(/,(?=\d{2,3}\b)/g, "")
    // A space after a decimal point between figures is the reader's, never
    // the type's: "₹2.19 Cr" came back "72. 19 Cr" off a display banner.
    .replace(/(\d)\.\s+(\d)/g, "$1.$2");
  const out: { value: number; alternatives: number[] }[] = [];
  const re = /(₹|(?<![a-z])rs\.?|inr|[%&FZz])?\s*(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lac|l)\b|(₹|(?<![a-z])rs\.?\s|inr\s)\s*(\d{4,})/gi;
  for (const m of text.matchAll(re)) {
    if (m[2]) {
      // Noise read off a busy picture is not a price. A lone "L" is lakh only
      // after a rupee sign, and a figure glued to a letter before it is part
      // of a word: a film's lobby panels came back "2 L" and "k4L", and two
      // films of 2 October 2026 were refused for prices nobody set.
      const sign = (m[1] ?? "").toLowerCase();
      const realSign = sign === "₹" || sign.startsWith("rs") || sign === "inr";
      if (m[3].toLowerCase() === "l" && !realSign) continue;
      if (!m[1] && /[a-z]/i.test(text[m.index + m[0].indexOf(m[2]) - 1] ?? "")) continue;
      const unit = SCALE[m[3].toLowerCase()] ?? 1;
      const digits = m[2];
      const value = Math.round(Number(digits) * unit);
      const alternatives: number[] = [];
      // A rupee sign read as a digit glued to the front.
      if (!m[1] && /^\d\d/.test(digits)) alternatives.push(Math.round(Number(digits.slice(1)) * unit));
      // A decimal point lost: "219 Cr" for "2.19 Cr".
      if (!digits.includes(".") && digits.length >= 2) {
        for (let k = 1; k < digits.length; k++) alternatives.push(Math.round(Number(`${digits.slice(0, k)}.${digits.slice(k)}`) * unit));
      }
      out.push({ value, alternatives });
    } else if (m[5]) {
      out.push({ value: Number(m[5]), alternatives: [] });
    }
  }
  return out;
}

/**
 * Every amount somebody signed, as rupees: the Brain's money fields, labelled
 * or bare, and any amount a talking point states, each also as an ad prints
 * it (a booking amount of 2,50,500 is set as ₹2.51 Lakh). The rule
 * `gateCopy()` measures the words by, so the picture is measured the same.
 */
export function signedAmounts(values: readonly string[]): number[] {
  const out = new Set<number>();
  for (const v of values) {
    for (const n of moneyIn(v)) if (n > 0) out.add(n);
    if (/^[\d,.]+$/.test(v.trim())) {
      const n = Number(v.replace(/[^\d.]/g, ""));
      if (Number.isFinite(n) && n > 0) out.add(n);
    }
  }
  for (const n of [...out]) for (const m of moneyIn(adPrice(n))) out.add(m);
  return [...out];
}

/**
 * Every price on the frame against the approved configurations, with the
 * configurations named on its line or on the line just above it (a design
 * that sets "2 BHK starting at" over "₹2.19 Cr*" split them in two). The
 * unit rules decide: a price beside a configuration must be that
 * configuration's, within the gate's one per cent.
 *
 * A line is read more than once (two thresholds, three regions), and the
 * reads of one line are judged together: the configurations any read names
 * are the line's, and the line is clean when any read of it quotes only
 * approved amounts. One read dropping the "1" of "1 BHK" does not clear the
 * 2 BHK's price beside it, and one read turning "₹2.19" into "32 19" does not
 * refuse a price another read saw plainly.
 */
/**
 * The lines that are not our own registration number or phone read badly.
 * A film's registration block fading in came back "¥ 00012345", the tail of
 * P52100012345 behind a yen sign, which reads as a rupee amount, and refused
 * the locality film of 13 October 2026 for a price nobody set. A line whose
 * every run of five digits or more sits inside one of those numbers is ours.
 */
export function notOurNumbers<L extends { text: string }>(lines: readonly L[], numbers: readonly (string | null)[]): L[] {
  const ours = numbers.map((n) => toAsciiDigits(n ?? "").replace(/\D/g, "")).filter((d) => d.length >= 5);
  if (!ours.length) return [...lines];
  return lines.filter((l) => {
    const runs = toAsciiDigits(l.text).replace(/[\s,.]/g, "").match(/\d{5,}/g) ?? [];
    return !runs.length || !runs.every((r) => ours.some((o) => o.includes(r)));
  });
}

export function priceProblems(
  lines: readonly ReadLine[],
  configurations: readonly UnitPrice[],
  money: readonly number[],
): PixelFinding[] {
  const priced = configurations.filter((c): c is UnitPrice & { startingPrice: number } => !!c.startingPrice && c.startingPrice > 0);
  const near = (n: number, p: number) => Math.abs(n - p) <= p * CONFIG_PRICE_TOLERANCE;
  const keys = priced.map((c) => c.config);
  const namedIn = (t: string) => configsNamedIn(toAsciiDigits(t), keys);
  const area = (b: PxBox) => Math.max(1, b.w * b.h);
  const shared = (a: PxBox, b: PxBox) => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? (w * h) / Math.min(area(a), area(b)) : 0;
  };

  // The reads of one line, grouped by where they sit.
  const priceLines = lines.filter((l) => amountsIn(l.text).length);
  const groups: ReadLine[][] = [];
  for (const l of priceLines) {
    const g = groups.find((xs) => xs.some((x) => shared(x.box, l.box) > 0.5));
    if (g) g.push(l);
    else groups.push([l]);
  }

  const out: PixelFinding[] = [];
  for (const g of groups) {
    const box = union(g.map((l) => l.box));
    let named = [...new Set(g.flatMap((l) => namedIn(l.text)))];
    if (!named.length) {
      const above = lines
        .filter((l) => !g.includes(l) && l.box.y + l.box.h <= box.y + box.h * 0.3)
        .filter((l) => box.y - (l.box.y + l.box.h) <= Math.min(...g.map((x) => x.box.h)) * 1.2)
        .filter((l) => l.box.x < box.x + box.w && l.box.x + l.box.w > box.x)
        .sort((a, b) => b.box.y - a.box.y);
      named = [...new Set(above.slice(0, 2).flatMap((l) => namedIn(l.text)))];
    }
    const mine = priced.filter((c) => named.includes(c.config));
    const fits = (n: number) =>
      money.includes(n) || (named.length ? mine.some((c) => near(n, c.startingPrice)) : priced.some((c) => near(n, c.startingPrice)));
    const clean = g.some((l) => amountsIn(l.text).every((a) => [a.value, ...a.alternatives].some(fits)));
    if (clean) continue;
    const all = g.flatMap((l) => amountsIn(l.text)).flatMap((a) => [a.value, ...a.alternatives]);
    const theirs = named.length ? priced.find((c) => !named.includes(c.config) && all.some((n) => near(n, c.startingPrice))) : undefined;
    out.push(
      theirs
        ? finding("PRICE_WRONG_CONFIG", `${mine.map((c) => c.label).join(" and ")} beside the ${theirs.label} price`)
        : finding("PRICE_UNKNOWN", named.length ? `an amount beside ${mine.map((c) => c.label).join(" and ")} that is no approved price` : "an amount that is no approved price"),
    );
  }
  return out;
}

/** Whether a region measured against what it must be has been changed, not merely re-encoded. */
export function regionChanged(r: { meanDiff: number; closeShare: number }): boolean {
  return r.meanDiff > REGION_MEAN_DIFF || r.closeShare < REGION_CLOSE_SHARE;
}

// ---------------------------------------------------------------------------
// The verdict on one frame
// ---------------------------------------------------------------------------

/**
 * Everything wrong with one frame, from what was read and what it must carry.
 * The order is the order a person would look: the QR, the number, where they
 * sit, how large, how readable, then the small print and the prices.
 */
export function judgeFrame(r: RasterReading, e: FrameExpect): PixelFinding[] {
  const out: PixelFinding[] = [];
  if (r.error) return [finding("NOT_CHECKED", r.error)];
  const registered = !!e.registrationNo;

  // Every registered tower's advertisement carries a QR that scans, whether
  // or not an approved lockup exists to paste: without one there is nothing
  // lawful to put in the quarter, and the post says so.
  if (registered) {
    if (!r.qr.payload) {
      // Where the authority requires one, or where one was issued and approved.
      if (e.authority.qrRequired || e.qrPayload) out.push(finding("QR_UNREADABLE"));
    } else {
      if (!qrIsThisPhase(r.qr.payload, e.qrPayload, e.registrationNo)) out.push(finding("QR_WRONG"));
      else if (!isAuthorityUrl(r.qr.payload, e.authority.hosts)) out.push(finding("QR_NOT_AUTHORITY"));
      const missed = r.qr.renditions.filter((x) => !x.ok).map((x) => x.name);
      if (missed.length) out.push(finding("QR_TOO_SMALL", `does not scan at ${missed.join(", ")}`));
    }
  }

  let reg: RegRead | null = null;
  if (registered) {
    reg = r.registration ? bestRead(e.registrationNo!, r.registration.reads, r.registration.glyphs) : null;
    if (!reg) out.push(finding("REG_MISSING"));
    else if (reg.kind === "misprint") out.push(finding("REG_MISPRINT"));
    else if (reg.kind === "different") out.push(finding("REG_WRONG"));
    if (!r.website) out.push(finding("WEBSITE_MISSING"));

    const block = [r.qr.box, r.registration?.box ?? null, r.website?.box ?? null].filter((b): b is PxBox => !!b);
    if (block.some((b) => !inPlace(b, r.w, r.h, e.authority.place))) {
      out.push(finding(e.authority.place === "TOP_RIGHT" ? "LOCKUP_OUTSIDE" : "LOCKUP_MISPLACED"));
    }

    // The number at least as large as the largest contact detail on the frame.
    const contacts = [r.phone, r.contactSite].filter((m): m is Measured => !!m && m.glyphPx !== null);
    const regPx = r.registration?.glyphPx ?? null;
    if (e.authority.sizeAgainstContact && regPx !== null && contacts.length) {
      const largest = Math.max(...contacts.map((c) => c.glyphPx!));
      if (regPx < largest * HEIGHT_TOLERANCE) {
        out.push(finding("REG_SMALL", `number ${regPx.toFixed(1)} px, contact ${largest.toFixed(1)} px`));
      }
    }
  }
  if (e.contact && e.phone && !r.phone) out.push(finding("CONTACT_UNREAD"));

  // Readable against what is behind it: the registration details and the small print.
  const faint = [
    registered ? r.registration : null,
    registered ? r.website : null,
    r.impression,
    ...r.smallPrint,
  ].filter((m): m is Measured => !!m && m.contrast !== null && m.contrast < CONTRAST_FLOOR);
  if (faint.length) {
    const worst = Math.min(...faint.map((m) => m.contrast!));
    out.push(finding("CONTRAST_LOW", `${worst.toFixed(1)} to 1`));
  }

  if (e.render && !r.impression) out.push(finding("NO_IMPRESSION"));

  out.push(...priceProblems(notOurNumbers(r.lines, [e.registrationNo, e.phone]), e.configurations, e.money));

  if (r.region && regionChanged(r.region)) {
    out.push(finding("RENDER_CHANGED", `mean difference ${r.region.meanDiff.toFixed(1)}`));
  }

  if (registered && e.registrationDaysLeft !== null && e.registrationDaysLeft <= EXPIRY_HOLD_DAYS) {
    out.push(finding("REG_LAPSING"));
  }
  // One of each: a price twice wrong is one problem to fix.
  return [...new Map(out.map((f) => [f.code, f])).values()];
}

/**
 * What a frame carrying everything it should reads as: the QR of the
 * approved lockup in the upper-right quarter, the number and the website
 * beside it, larger than the contact line, all readable. For the suites whose
 * image model is a fake that draws no words (`Drivers.pixel`), and for the
 * rules' own checks. Never used by anything that makes a post.
 */
export function cleanReading(e: FrameExpect, w = 1080, h = 1080): RasterReading {
  const reg = e.registrationNo;
  const m = (text: string, box: PxBox, glyphPx: number): Measured => ({ text, box, glyphPx, contrast: 12 });
  const top = e.authority.place === "TOP_RIGHT";
  const at = (x: number, y: number, bw: number, bh: number): PxBox =>
    top ? { x: w * x, y: h * y, w: w * bw, h: h * bh } : { x: w * (x - 0.5), y: h * (0.8 + y / 3), w: w * bw, h: h * bh };
  return {
    w,
    h,
    qr: reg
      ? {
          box: at(0.72, 0.05, 0.12, 0.12),
          payload: e.qrPayload ?? `https://${e.authority.hosts[0]}/projects/${reg}`,
          renditions: qrRenditions().map((name) => ({ name, ok: true })),
        }
      : { box: null, payload: null, renditions: [] },
    lines: [],
    registration: reg ? { ...m(reg, at(0.6, 0.2, 0.3, 0.02), 20), reads: [reg], glyphs: [] } : null,
    website: reg ? m(e.authority.website, at(0.6, 0.23, 0.35, 0.02), 18) : null,
    phone: e.contact && e.phone ? m(e.phone, { x: w * 0.05, y: h * 0.92, w: w * 0.2, h: h * 0.015 }, 14) : null,
    contactSite: e.contact && e.website ? m(e.website, { x: w * 0.3, y: h * 0.92, w: w * 0.2, h: h * 0.015 }, 14) : null,
    impression: e.render ? m("Artist's impression.", { x: w * 0.05, y: h * 0.95, w: w * 0.2, h: h * 0.012 }, 9) : null,
    smallPrint: [],
  };
}

// ---------------------------------------------------------------------------
// Inside the design loop
// ---------------------------------------------------------------------------

/**
 * A frame's pixel findings as the design loop's problems. What the image
 * model drew is its to fix, within the drawings it already has: the lockup
 * text when it drew the whole ad, the price lines when it set the copy. What
 * we stamped is ours, and another drawing would only cost money.
 */
export function asDesignProblems(
  findings: readonly PixelFinding[],
  drawn: { lockup: boolean; copy: boolean },
): { code: string; text: string; fixable: boolean; fix?: string }[] {
  return findings
    .filter((f) => f.code !== "REG_LAPSING")
    .map((f) => {
      const mine = (drawn.lockup && LOCKUP_CODES.has(f.code)) || (drawn.copy && COPY_CODES.has(f.code));
      const fix = mine ? PIXEL_FIX[f.code] : undefined;
      return { code: `PX_${f.code}`, text: f.text, fixable: !!fix, ...(fix ? { fix } : {}) };
    });
}

// ---------------------------------------------------------------------------
// Video: which frames are read
// ---------------------------------------------------------------------------

export type Span = { start: number; end: number };

/**
 * The moments of a video the gate reads: the first, the middle and the last
 * frame of every shot, a little inside each cut so a fade is not what is
 * read, and the end card as it settles, once everything on it has come in
 * (the phone number arrives last).
 */
export function sampleTimes(shots: readonly Span[], endCard?: Span | null): number[] {
  const out: number[] = [];
  for (const s of shots) {
    const d = Math.max(0, s.end - s.start);
    if (d <= 0) continue;
    const inset = Math.min(0.4, d * 0.15);
    out.push(s.start + inset, s.start + d / 2, s.end - inset);
  }
  if (endCard && endCard.end > endCard.start) out.push(endCard.end - Math.min(0.4, (endCard.end - endCard.start) * 0.15));
  const round = (t: number) => Math.round(t * 100) / 100;
  return [...new Set(out.map(round))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// The record kept with a post
// ---------------------------------------------------------------------------

export type PixelFileRecord = {
  sha256: string;
  /** Frames read: one for a picture, the sampled ones for a video. */
  frames: number;
  verdict: PixelVerdict;
};

export type PixelRecord = {
  verdict: PixelVerdict;
  engine: string;
  checkedAt: string;
  /** The registration the frames were checked against, or null for an exempt tower. */
  registrationNo: string | null;
  files: PixelFileRecord[];
  /** Codes and client words, with the file and, on a video, the second, where each was found. */
  findings: (PixelFinding & { file: number; at?: number })[];
};

export function pixelRecord(input: {
  engine: string;
  now: Date;
  registrationNo: string | null;
  files: { sha256: string; frames: { at?: number; findings: PixelFinding[] }[] }[];
}): PixelRecord {
  const findings: PixelRecord["findings"] = [];
  const files = input.files.map((f, file) => {
    const all = f.frames.flatMap((fr) => fr.findings.map((x) => ({ ...x, file, ...(fr.at !== undefined ? { at: fr.at } : {}) })));
    findings.push(...all);
    return { sha256: f.sha256, frames: f.frames.length, verdict: verdictOf(all) };
  });
  // A code found on six frames is one line on the tile, at its first frame.
  const first = new Map<string, (typeof findings)[number]>();
  for (const x of findings) if (!first.has(`${x.code}:${x.file}`)) first.set(`${x.code}:${x.file}`, x);
  const once = [...first.values()];
  return {
    verdict: files.length ? verdictOf(findings) : "HOLD",
    engine: input.engine,
    checkedAt: input.now.toISOString(),
    registrationNo: input.registrationNo,
    files,
    findings: once,
  };
}

/** What a tile says: each problem once, the most serious first. */
export function pixelSummary(record: PixelRecord | null | undefined): { verdict: PixelVerdict | null; lines: string[] } {
  if (!record) return { verdict: null, lines: [] };
  const order = (v: PixelVerdict) => (v === "FAIL" ? 0 : v === "HOLD" ? 1 : 2);
  const lines = [...new Set(new Map([...record.findings].sort((a, b) => order(a.verdict) - order(b.verdict)).map((f) => [f.code, f.text])).values())];
  return { verdict: record.verdict, lines };
}

// ---------------------------------------------------------------------------
// At the moment of publishing
// ---------------------------------------------------------------------------

/**
 * Why a post may not go out on its picture check, or null when it may.
 *
 * The verdict must be a PASS, reached on these files (each file's hash is
 * kept beside it in `media`, so a file replaced after the check is not the
 * file that passed), against the registration the gate says the post may be
 * advertised under today.
 */
export function pixelRefusal(
  record: PixelRecord | null | undefined,
  media: readonly { sha256?: string | null }[],
  registrationNo: string | null,
): { code: string; message: string } | null {
  if (!record) {
    return { code: "PIXEL_UNCHECKED", message: "This post was made before pictures were checked. Make it again to publish it." };
  }
  if (record.verdict !== "PASS") {
    const first = pixelSummary(record).lines[0] ?? "";
    return record.verdict === "HOLD"
      ? { code: "PIXEL_HOLD", message: `This post's picture is waiting for a person. ${first}`.trim() }
      : { code: "PIXEL_FAIL", message: `This post's picture did not pass its check. ${first}`.trim() };
  }
  if (record.files.length !== media.length || media.some((m, i) => !m.sha256 || m.sha256 !== record.files[i].sha256)) {
    return { code: "PIXEL_STALE", message: "This post's files changed after they were checked. Make it again." };
  }
  if (alnum(record.registrationNo ?? "") !== alnum(registrationNo ?? "")) {
    return {
      code: "PIXEL_OTHER_REGISTRATION",
      message: "The picture carries a different registration from the one this can be advertised under today. Make the post again.",
    };
  }
  return null;
}
