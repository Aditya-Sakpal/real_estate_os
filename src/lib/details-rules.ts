/**
 * The project's details on WhatsApp, the way an agent promises them on a
 * call: "main aapko WhatsApp par details bhej deta hoon". Pure and
 * database-free, covered by `check:logic`; `project-details.ts` sends.
 *
 * Two messages make the promise good. Outside the buyer's 24 hours only a
 * template may open the chat, so the first is `PROJECT_DETAILS`: the tower's
 * picture, what it starts at and one button. The tap opens the window, and
 * inside it the pictures and the full details follow as ordinary messages,
 * which may say more than a template ever could. A buyer who already wrote
 * to us in the last 24 hours gets the pictures and the details at once.
 *
 * Every word in them is a signed fact or an approved picture's own title,
 * and every picture an approved one: the same ground an advertisement
 * stands on, because a WhatsApp naming a tower to a buyer is one.
 */

import type { AssetCategory } from "./asset-rules.ts";
import type { Voice } from "./message-rules.ts";
import { adPrice } from "./creative-rules.ts";

// ---------------------------------------------------------------------------
// Was it promised?
// ---------------------------------------------------------------------------

const WHATSAPP = /whats\s*-?\s*app|व्हाट्स\s*एप|व्हाट्सऐप|व्हाट्सएप|व्हॉट्सअॅप|व्हॉट्सऐप|वॉट्सऐप|वॉट्सएप|वाट्सएप|वॉट्सअप/i;
const DETAILS =
  /\bdetails?\b|\bphotos?\b|\bpictures?\b|\bpics?\b|\bimages?\b|\bbrochure\b|floor\s*plans?|price\s*list|\binformation\b|\binfo\b|ja+n?ka+ri|ma+hiti|जानकारी|माहिती|माहीती|डिटेल्स?|डीटेल्स?|फोटो|ब्रोशर|फ्लोर\s*प्लान|प्राइस\s*लिस्ट/i;

/**
 * Whether the project's details were promised on WhatsApp, or asked for
 * there, on this call: one line, the agent's or the buyer's, naming WhatsApp
 * and the details together. "The location is on WhatsApp" is not it.
 */
export function promisedDetails(turns: readonly { role: string; text: string }[]): boolean {
  return turns.some((t) => WHATSAPP.test(t.text) && DETAILS.test(t.text));
}

// ---------------------------------------------------------------------------
// Which pictures
// ---------------------------------------------------------------------------

/** Pictures a buyer is sent at most: one message each, and more is a gallery nobody scrolls. */
export const MAX_DETAIL_PICTURES = 8;

/**
 * What the pictures are, in the order a buyer looks: the building, the way
 * in, a home, what comes with it, the plan of the home. A lockup, a
 * construction photo, a site plan and a map are never sent: the first is
 * the registration's, the second dates itself, and the last two need a
 * person beside them. The shares add up to `MAX_DETAIL_PICTURES`; a library
 * short of one kind lends its room to the others.
 */
const TAKES: readonly { category: AssetCategory; most: number }[] = [
  { category: "EXTERIOR_RENDER", most: 2 },
  { category: "LOBBY", most: 1 },
  { category: "SAMPLE_FLAT", most: 2 },
  { category: "AMENITY", most: 2 },
  { category: "FLOOR_PLAN", most: 1 },
];

export type DetailPicture = {
  id: string;
  category: AssetCategory;
  title: string;
  isRender: boolean;
  /** The configuration a floor plan or a room belongs to ("2 BHK"), when one was recorded. */
  unitLabel: string | null;
};

const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** A home is shown from its living room in, never from its bathroom. */
const ROOMS = [/living|drawing|hall/i, /master|bedroom/i, /kitchen|dining/i, /balcony|deck|view/i, /bath|toilet|wash/i];

function roomRank(p: DetailPicture): number {
  if (p.category !== "SAMPLE_FLAT") return 0;
  const at = ROOMS.findIndex((r) => r.test(p.title));
  return at < 0 ? 3 : at;
}

/**
 * The pictures to send, in order: each kind up to its share, the buyer's own
 * configuration's floor plan first when the call found it, then whatever
 * room is left goes to the kinds in the same order. Never more than
 * `MAX_DETAIL_PICTURES`.
 */
export function pickDetailPictures<T extends DetailPicture>(pictures: readonly T[], config?: string | null): T[] {
  const want = squash(config);
  const of = (category: AssetCategory) => {
    const all = pictures
      .filter((p) => p.category === category)
      .map((p, i) => ({ p, i }))
      .sort((x, y) => roomRank(x.p) - roomRank(y.p) || x.i - y.i)
      .map((x) => x.p);
    if (category !== "FLOOR_PLAN" || !want) return all;
    const theirs = all.filter((p) => squash(p.unitLabel) === want || squash(p.title).includes(want));
    return [...theirs, ...all.filter((p) => !theirs.includes(p))];
  };
  const chosen: T[] = [];
  for (const t of TAKES) chosen.push(...of(t.category).slice(0, t.most));
  for (const t of TAKES) {
    for (const p of of(t.category)) {
      if (chosen.length >= MAX_DETAIL_PICTURES) break;
      if (!chosen.includes(p)) chosen.push(p);
    }
  }
  // Back in the buyer's order after the second pass.
  const rank = (p: T) => TAKES.findIndex((t) => t.category === p.category);
  return chosen
    .slice(0, MAX_DETAIL_PICTURES)
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p);
}

/** A picture's caption: its approved title, and nothing a model or a rule added. */
export function captionOf(p: { title: string }): string {
  return p.title.trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// What the details say
// ---------------------------------------------------------------------------

export type DetailHome = { label: string; carpetSqft: number | null; balconySqft: number | null; price: number | null };

export type DetailsInput = {
  project: string;
  tower: string | null;
  /** The signed "Exact location, as advertised". */
  location: string | null;
  city: string | null;
  /** Approved configurations, cheapest first. */
  homes: readonly DetailHome[];
  /** Selling points, in the order an advertisement leads with them (`sellingPoints()`). */
  points: readonly string[];
  /** Signed amenities and the approved amenity pictures' titles. */
  amenities: readonly string[];
  bookingAmount: number | null;
  paymentPlan: string | null;
  /** The marketed possession date as signed, 2030-09-30. */
  possession: string | null;
  /** The state's price footnote (`priceNoteFor()`). */
  priceNote: string;
  /** The registration line the gate said yes about (`registrationLine()`), or null for an exempt tower. */
  registration: string | null;
  /** Whether any picture sent is a render, which the small print then says once. */
  renders: boolean;
};

const WORDS: Record<
  Voice,
  { homes: string; carpet: string; balcony: string; from: string; why: string; amenities: string; payment: string; booking: string; possession: string; close: string; renders: string }
> = {
  ENGLISH: {
    homes: "Homes",
    carpet: "sq ft carpet",
    balcony: "sq ft balcony",
    from: "from",
    why: "Why",
    amenities: "Amenities",
    payment: "Payment",
    booking: "Booking amount",
    possession: "Possession",
    close: "Would you like to see the sample flat? Reply with a day that suits you and we will book your site visit.",
    renders: "Pictures are artist's impressions.",
  },
  HINGLISH: {
    homes: "Homes",
    carpet: "sq ft carpet",
    balcony: "sq ft balcony",
    from: "from",
    why: "Kyun",
    amenities: "Amenities",
    payment: "Payment",
    booking: "Booking amount",
    possession: "Possession",
    close: "Sample flat dekhna chahenge? Jo din suit kare yahin reply kar dijiye, hum aapka site visit book kar denge.",
    renders: "Pictures are artist's impressions.",
  },
  MARATHI: {
    homes: "Ghare",
    carpet: "sq ft carpet",
    balcony: "sq ft balcony",
    from: "pasun",
    why: "Ka",
    amenities: "Suvidha",
    payment: "Payment",
    booking: "Booking amount",
    possession: "Possession",
    close: "Sample flat baghaycha aahe ka? Soyicha divas ithech reply kara, aamhi tumchi site visit book karu.",
    renders: "Pictures are artist's impressions.",
  },
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthOf(iso: string | null): string | null {
  const m = /^(\d{4})-(\d{2})/.exec((iso ?? "").trim());
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

/** The place as an ad names it: the exact locality, or the city when none was signed. */
function placeOf(i: DetailsInput): string | null {
  return i.location?.trim() || i.city?.trim() || null;
}

function homeLine(h: DetailHome, w: (typeof WORDS)[Voice], voice: Voice): string {
  const size = [h.carpetSqft ? `${h.carpetSqft} ${w.carpet}` : null, h.balconySqft ? `${h.balconySqft} ${w.balcony}` : null]
    .filter(Boolean)
    .join(" + ");
  const price = h.price ? adPrice(h.price) : "";
  const priced = price ? (voice === "MARATHI" ? `${price}* ${w.from}` : `${w.from} ${price}*`) : "";
  return `• ${h.label}${size ? `: ${size}` : ""}${priced ? `, ${priced}` : ""}`;
}

/** The highlights a template carries in one line: what each home starts at, or where it is. */
export function highlightLine(i: Pick<DetailsInput, "homes" | "location" | "city">, voice: Voice): string {
  const w = WORDS[voice];
  const priced = i.homes.filter((h) => h.price).slice(0, 3);
  if (priced.length) {
    return priced
      .map((h) => (voice === "MARATHI" ? `${h.label} ${adPrice(h.price!)}* ${w.from}` : `${h.label} ${w.from} ${adPrice(h.price!)}*`))
      .join(", ");
  }
  const labels = i.homes.map((h) => h.label).slice(0, 3);
  const place = i.location?.trim() || i.city?.trim() || "";
  return [labels.join(", "), place].filter(Boolean).join(" in ") || "-";
}

/**
 * The details message itself, sent after the pictures: where it is, the
 * homes with their carpet areas and starting prices, why it is worth seeing,
 * what comes with it, how it is paid, when it is ready, one question, and
 * the small print. A section with nothing signed behind it is left out.
 */
export function detailsText(i: DetailsInput, voice: Voice): string {
  const w = WORDS[voice];
  const name = i.tower ? `${i.project}, ${i.tower}` : i.project;
  const place = placeOf(i);
  const out: string[] = [`*${name}*${place ? ` | ${place}` : ""}`];

  if (i.homes.length) out.push("", `*${w.homes}*`, ...i.homes.map((h) => homeLine(h, w, voice)));
  if (i.points.length) out.push("", `*${w.why} ${i.project}*`, ...i.points.slice(0, 5).map((p) => `• ${p}`));
  const amenities = dedupe(i.amenities).slice(0, 8);
  if (amenities.length) out.push("", `*${w.amenities}*`, `• ${amenities.join(", ")}`);

  const pay = [
    i.bookingAmount ? `• ${w.booking}: ${adPrice(i.bookingAmount).replace(/ Lakh$/, " lakh")}` : null,
    i.paymentPlan?.trim() ? `• ${i.paymentPlan.trim()}` : null,
    monthOf(i.possession) ? `• ${w.possession}: ${monthOf(i.possession)}` : null,
  ].filter((x): x is string => !!x);
  if (pay.length) out.push("", `*${w.payment}*`, ...pay);

  out.push("", w.close, "");
  const small = [
    i.homes.some((h) => h.price) ? i.priceNote : null,
    i.renders ? w.renders : null,
    i.registration,
  ].filter((x): x is string => !!x);
  out.push(...small);
  return out.join("\n").trim().slice(0, 4096);
}

function dedupe(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const s = raw.trim();
    const k = squash(s);
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The button
// ---------------------------------------------------------------------------

/** What the template's button sends back: the lead it was sent to. */
export function detailsPayload(leadId: string): string {
  return `details:${leadId}`;
}

export function readDetailsPayload(raw: string | null | undefined): string | null {
  const m = /^details:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec((raw ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}
