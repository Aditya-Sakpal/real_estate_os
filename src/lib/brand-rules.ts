/**
 * The brand kit, decided without a database.
 *
 * One logo, one tagline, one phone number a buyer rings. These do not change
 * between campaigns or between towers, so they are said once on a node and
 * resolved downward, the way the Brain resolves facts.
 *
 * What lives here is the catalog, the normalising, and the answer to "is
 * there enough here for a creative to be built and checked". Kept
 * database-free so `npm run check:logic` exercises it directly.
 *
 * Imports are relative because the checks load this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

// One language catalog, and it lives where a language is chosen. This file
// only answers whether the brand's face can set one.
import { LANGUAGES } from "./campaign-rules.ts";

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

export type BrandFileRole = "LOGO_HORIZONTAL" | "LOGO_STACKED" | "LOGO_MONO" | "TYPEFACE";

/**
 * Four roles, because one logo cannot do the job.
 *
 * A horizontal lockup does not sit in a 9:16 story, and a full-colour mark
 * disappears on a photograph. The brief's formats run 1:1, 9:16, 16:9 and
 * hoarding, and the layout adapter picks by shape rather than by scaling one
 * file until it fits.
 */
export const BRAND_FILE_ROLES: {
  key: BrandFileRole;
  label: string;
  detail: string;
  font?: boolean;
}[] = [
  {
    key: "LOGO_HORIZONTAL",
    label: "Logo, horizontal",
    detail: "The wide lockup. Used across 16:9, hoardings and email.",
  },
  {
    key: "LOGO_STACKED",
    label: "Logo, stacked",
    detail: "The square or vertical mark, for 1:1 and 9:16.",
  },
  {
    key: "LOGO_MONO",
    label: "Logo, single colour",
    detail: "For placing over a photograph, where the colour mark disappears.",
  },
  {
    key: "TYPEFACE",
    label: "Brand typeface",
    detail: "The font file, if the brand uses one.",
  },
];

export function isBrandFileRole(raw: string | null | undefined): raw is BrandFileRole {
  return BRAND_FILE_ROLES.some((r) => r.key === raw);
}

/** SVG is absent for the reason it is absent everywhere here: it can carry script. */
export const LOGO_TYPES = ["image/png", "image/webp", "image/jpeg"] as const;

export const FONT_TYPES = ["font/woff2", "font/woff", "font/ttf", "font/otf"] as const;

/** Generous for a logo, enough for a font, and small enough to sit in a row. */
export const MAX_BRAND_FILE_BYTES = 5 * 1024 * 1024;

export function typesForRole(role: BrandFileRole): readonly string[] {
  return role === "TYPEFACE" ? FONT_TYPES : LOGO_TYPES;
}

/**
 * What the file picker is allowed to offer.
 *
 * A media type alone is not enough. Windows resolves a type in `accept`
 * through the registry, and fonts are usually not in it, so the dialog
 * quietly falls back to showing every file on the machine and a person
 * picking a typeface is offered their holiday photographs. The extension
 * needs no registry, so both go in: the type for the platforms that
 * understand it, the extension for the one that does not.
 *
 * This is the same gap that makes `file.type` come back empty for a `.woff2`,
 * which is what `brandFileType()` exists to close. It is presentation only:
 * `canUploadBrandFile()` remains the rule, because a picker can be bypassed.
 */
const EXTENSIONS: Record<string, string[]> = {
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/jpeg": [".jpg", ".jpeg"],
  "font/woff2": [".woff2"],
  "font/woff": [".woff"],
  "font/ttf": [".ttf"],
  "font/otf": [".otf"],
};

export function acceptForRole(role: BrandFileRole): string {
  const types = typesForRole(role);
  return [...types, ...types.flatMap((t) => EXTENSIONS[t] ?? [])].join(",");
}

/**
 * What a chosen file really is, when the browser will not say.
 *
 * Chrome reports an empty `type` for `.woff2` and `.otf` on Windows, because
 * the mapping comes from the operating system's registry and fonts are often
 * not in it. The allowlist then refused a perfectly good font with a message
 * about fonts, which is the worst kind of wrong answer.
 *
 * The extension is trusted for FONTS ONLY, and never for images. A font is
 * served to a stylesheet rather than rendered as a document, so the harm a
 * mislabelled one can do is that it fails to load. An image is served inline,
 * which is exactly the case `nosniff` and the SVG exclusion exist for, and
 * guessing there would undo both.
 */
const FONT_BY_EXTENSION: Record<string, (typeof FONT_TYPES)[number]> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

export function brandFileType(
  role: string,
  name: string | null,
  reported: string | null,
): string | null {
  if (role !== "TYPEFACE") return reported;
  if (reported && FONT_TYPES.includes(reported as (typeof FONT_TYPES)[number])) return reported;
  const ext = (name ?? "").toLowerCase().match(/[.]([a-z0-9]+)$/)?.[1];
  return (ext && FONT_BY_EXTENSION[ext]) || reported;
}

export type BrandFileCheck =
  | { ok: true }
  | { ok: false; code: "NO_FILE" | "FILE_TYPE" | "FILE_TOO_BIG"; message: string };

export function canUploadBrandFile(input: {
  role: string;
  mediaType: string | null;
  mediaBytes: number;
}): BrandFileCheck {
  if (!isBrandFileRole(input.role)) {
    return { ok: false, code: "FILE_TYPE", message: "That is not part of a brand kit." };
  }
  if (input.mediaBytes <= 0) {
    return { ok: false, code: "NO_FILE", message: "Choose a file to upload." };
  }
  const allowed = typesForRole(input.role);
  if (!allowed.includes((input.mediaType ?? "") as (typeof allowed)[number])) {
    return {
      ok: false,
      code: "FILE_TYPE",
      message:
        input.role === "TYPEFACE"
          ? "That is not a font file. WOFF2, WOFF, TTF and OTF work."
          : "That is not an image. PNG, WebP and JPG work, and PNG keeps a transparent background.",
    };
  }
  if (input.mediaBytes > MAX_BRAND_FILE_BYTES) {
    return { ok: false, code: "FILE_TOO_BIG", message: "That file is over 5 MB." };
  }
  return { ok: true };
}

/**
 * Every chosen mark that would be refused, each naming its file.
 *
 * Asked of the whole batch before any of it is written. Checking inside the
 * upload loop stored the first two logos and then refused the third, so a
 * refusal left the kit half changed and the screen could not say which half.
 */
export function brandFileProblems(
  files: readonly { role: string; name: string | null; type: string | null; bytes: number }[],
): string[] {
  return files.flatMap((f) => {
    const verdict = canUploadBrandFile({
      role: f.role,
      mediaType: brandFileType(f.role, f.name, f.type),
      mediaBytes: f.bytes,
    });
    return verdict.ok ? [] : [`${f.name || "That file"}: ${verdict.message}`];
  });
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/**
 * Which languages a brand face can actually set.
 *
 * A brief can ask for nine. A face drawn for English renders eight of them as
 * boxes, and nobody finds out until a Marathi creative is on a hoarding.
 * Recording the coverage is what lets the generator fall back deliberately
 * rather than silently.
 *
 * It is the language and not the script, for two reasons. A script is not
 * what anybody choosing it thinks in, and the two are not the clean mapping
 * they look like: Marathi needs an eyelash reph and a lla that Hindi-only
 * Devanagari faces ship without, and Hinglish is a real instruction to a
 * marketer while being the same glyphs as English. The brief asks for a
 * language, so the face answers in one.
 *
 * The catalog is the brief's own, so the two lists cannot drift apart.
 */
export const TYPEFACE_LANGUAGES = LANGUAGES;

export function pickLanguages(chosen: readonly string[]): string[] {
  const want = new Set(chosen.map((c) => c.trim()));
  return TYPEFACE_LANGUAGES.filter((l) => want.has(l));
}

/**
 * Languages the brand face cannot set.
 *
 * Answered here rather than at render time, so a brief asking for Tamil can
 * be told at the point somebody chooses it. No coverage recorded is unknown
 * rather than no, so an unrecorded face blocks nothing.
 */
export function languagesWithoutAFace(
  languages: readonly string[],
  covered: readonly string[],
): string[] {
  if (!covered.length) return [];
  const have = new Set(covered);
  return languages.filter((l) => !have.has(l));
}

// ---------------------------------------------------------------------------
// Reading what a person typed
// ---------------------------------------------------------------------------

export function textOrNull(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  return v.length ? v : null;
}

/** Six digits of hex, with or without the hash, or nothing. */
export function normaliseHex(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(v)) return null;
  return `#${v.toLowerCase()}`;
}

/**
 * An Indian mobile or landline in E.164, or nothing.
 *
 * Stored in one shape because it is printed on advertisements and dialled by
 * the call bench, and "+91 98765 43210" and "09876543210" being the same
 * number is not something either should have to work out.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  const local = digits.startsWith("91") && digits.length > 10 ? digits.slice(2) : digits;
  const trimmed = local.replace(/^0+/, "");
  if (trimmed.length !== 10) return null;
  return `+91${trimmed}`;
}

/**
 * A stored number, grouped for reading.
 *
 * E.164 is the right thing to store and the wrong thing to print. Nobody
 * reads "+919876543210" off a hoarding; the grouping is what makes it a
 * phone number to a person.
 */
export function showPhone(e164: string | null): string | null {
  if (!e164) return null;
  const m = /^[+]91(\d{5})(\d{5})$/.exec(e164);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}

/** Shown as a person wrote it, lowercased, or nothing. */
export function normaliseEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v) ? v : null;
}

/**
 * A link, or nothing.
 *
 * Only http and https survive. These end up in an href, and a `javascript:`
 * URL in an href is a script written by whoever filled in the form. Refused
 * rather than escaped, because no legitimate website needs another scheme.
 */
export function normaliseUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    // A person types "billbay.com" as often as the whole address.
    try {
      parsed = new URL(`https://${v}`);
    } catch {
      return null;
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/**
 * A social handle or a link, stored as a link.
 *
 * People paste "@billbayhomes" as readily as the full address, and a handle
 * has to become a link before it can be printed or clicked. Doing that once
 * here beats doing it in every surface that renders one.
 */
export function normaliseHandle(
  raw: string | null | undefined,
  host: string,
): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (v.includes("/") || v.includes(".")) return normaliseUrl(v);
  const handle = v.replace(/^@+/, "");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(handle)) return null;
  return `https://${host}/${handle}`;
}

/**
 * A number inside its bounds, or nothing.
 *
 * The emptiness is checked before the parse, and that is the whole reason
 * this is written out: `Number("")` is 0, not NaN, so a clear-space field
 * nobody touched was being stored as 0, which claims there is no clear space
 * rather than that nobody said. A bounds check starting at 0 cannot tell
 * those apart afterwards.
 */
export function boundedInt(raw: string | null | undefined, lo: number, hi: number): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const v = Number(text);
  if (!Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n >= lo && n <= hi ? n : null;
}

export function boundedRatio(raw: string | null | undefined, lo: number, hi: number): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const v = Number(text);
  if (!Number.isFinite(v) || v < lo || v > hi) return null;
  return Math.round(v * 100) / 100;
}

/** The smallest a logo may be drawn, in pixels. */
export const LOGO_MIN_PX_RANGE = [8, 600] as const;
/** Clear space around the logo, as a multiple of its height. */
export const CLEAR_RATIO_RANGE = [0, 4] as const;

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

/** What the branding form sends, before anything is believed. */
export type BrandInput = {
  tagline: string | null;
  colourPrimary: string | null;
  colourAccent: string | null;
  typefaceName: string | null;
  typefaceLanguages: string[];
  logoMinPx: string | null;
  logoClearRatio: string | null;
  salesPhone: string | null;
  salesEmail: string | null;
  website: string | null;
  privacyUrl?: string | null;
  officeAddress: string | null;
  instagram: string | null;
  facebook: string | null;
  youtube: string | null;
  disclaimer: string | null;
};

export type BrandKit = {
  tagline: string | null;
  colourPrimary: string | null;
  colourAccent: string | null;
  typefaceName: string | null;
  typefaceLanguages: string[];
  logoMinPx: number | null;
  logoClearRatio: number | null;
  salesPhone: string | null;
  salesEmail: string | null;
  website: string | null;
  /** The developer's privacy policy: a lead form on Meta or Google needs it. */
  privacyUrl: string | null;
  officeAddress: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  youtubeUrl: string | null;
  disclaimer: string | null;
};

export function emptyBrandKit(): BrandKit {
  return {
    tagline: null,
    colourPrimary: null,
    colourAccent: null,
    typefaceName: null,
    typefaceLanguages: [],
    logoMinPx: null,
    logoClearRatio: null,
    salesPhone: null,
    salesEmail: null,
    website: null,
    privacyUrl: null,
    officeAddress: null,
    instagramUrl: null,
    facebookUrl: null,
    youtubeUrl: null,
    disclaimer: null,
  };
}

export type BrandParse =
  | { ok: true; kit: BrandKit }
  | { ok: false; problems: string[] };

/**
 * What a person typed, normalised, or every field that could not be.
 *
 * A field left empty is cleared, which is what emptying it means. A field
 * with something in it that normalises to nothing is refused and named, and
 * then NOTHING is written: storing it as nothing would erase a working phone
 * number over a typo and still say "Saved", and a number nobody can dial
 * printed on a hoarding is worse than a refusal a person can read and fix.
 *
 * The labels are the screen's own, so the refusal names the box to look at.
 */
export function parseBrandInput(i: BrandInput): BrandParse {
  const problems: string[] = [];
  const typed = (raw: string | null | undefined) => textOrNull(raw) !== null;
  const check = <T>(raw: string | null | undefined, value: T | null, problem: () => string): T | null => {
    if (value === null && typed(raw)) problems.push(problem());
    return value;
  };
  const shown = (raw: string | null | undefined) => {
    const v = (raw ?? "").trim();
    return v.length > 24 ? `${v.slice(0, 24)}...` : v;
  };
  const [pxLo, pxHi] = LOGO_MIN_PX_RANGE;
  const [crLo, crHi] = CLEAR_RATIO_RANGE;

  const kit: BrandKit = {
    tagline: textOrNull(i.tagline),
    colourPrimary: check(i.colourPrimary, normaliseHex(i.colourPrimary),
      () => "Brand colour: use six hex digits, like #1B3A86."),
    colourAccent: check(i.colourAccent, normaliseHex(i.colourAccent),
      () => "Accent colour: use six hex digits, like #D98324."),
    typefaceName: textOrNull(i.typefaceName),
    typefaceLanguages: pickLanguages(i.typefaceLanguages),
    logoMinPx: check(i.logoMinPx, boundedInt(i.logoMinPx, pxLo, pxHi),
      () => `Smallest logo height: a number of pixels from ${pxLo} to ${pxHi}, like 48.`),
    logoClearRatio: check(i.logoClearRatio, boundedRatio(i.logoClearRatio, crLo, crHi),
      () => `Clear space: a number from ${crLo} to ${crHi}, like 0.5.`),
    salesPhone: check(i.salesPhone, normalisePhone(i.salesPhone),
      () => `Sales phone: ${shown(i.salesPhone)} is not a 10-digit Indian number.`),
    salesEmail: check(i.salesEmail, normaliseEmail(i.salesEmail),
      () => "Sales email: use a full address, like sales@yourcompany.in."),
    website: check(i.website, normaliseUrl(i.website),
      () => "Website: use a web address, like yourcompany.in."),
    privacyUrl: check(i.privacyUrl, normaliseUrl(i.privacyUrl),
      () => "Privacy policy: use a web address, like yourcompany.in/privacy."),
    officeAddress: textOrNull(i.officeAddress),
    instagramUrl: check(i.instagram, normaliseHandle(i.instagram, "www.instagram.com"),
      () => "Instagram: use the profile's web address or @handle."),
    facebookUrl: check(i.facebook, normaliseHandle(i.facebook, "www.facebook.com"),
      () => "Facebook: use the page's web address or @handle."),
    youtubeUrl: check(i.youtube, normaliseHandle(i.youtube, "www.youtube.com"),
      () => "YouTube: use the channel's web address or @handle."),
    disclaimer: textOrNull(i.disclaimer),
  };
  return problems.length ? { ok: false, problems } : { ok: true, kit };
}

/**
 * Kits from several nodes collapsed into one, deepest node winning.
 *
 * A logo set on the organisation applies to every project under it; an
 * entity that sets its own overrides it. Ordering is the caller's job,
 * because only the database knows how deep each node is.
 *
 * An empty value at a deeper node does not erase an inherited one. It is a
 * field nobody filled in, not an instruction to forget, which is the same
 * rule the Brain's `mergeInherited()` follows.
 */
export function mergeBrand(
  layers: readonly { path: string; kit: BrandKit }[],
): BrandKit {
  const depth = (p: string) => p.split(".").length;
  const merged = emptyBrandKit();
  for (const layer of [...layers].sort((a, b) => depth(a.path) - depth(b.path))) {
    for (const [k, v] of Object.entries(layer.kit)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "string" && v === "") continue;
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}

/** Files from several nodes, one per role, deepest node winning. */
export function mergeBrandFiles<T extends { path: string; role: BrandFileRole }>(
  layers: readonly T[],
): T[] {
  const depth = (p: string) => p.split(".").length;
  const byRole = new Map<BrandFileRole, T>();
  for (const f of [...layers].sort((a, b) => depth(a.path) - depth(b.path))) {
    byRole.set(f.role, f);
  }
  return BRAND_FILE_ROLES.map((r) => byRole.get(r.key)).filter((f): f is T => !!f);
}

// ---------------------------------------------------------------------------
// Is there enough here to build a creative
// ---------------------------------------------------------------------------

export type BrandGap = { key: string; label: string; why: string };

/**
 * What is missing before a compliant advertisement can be laid out.
 *
 * Contact details lead, and not for tidiness. MahaRERA requires the
 * registration lockup at a font size at least as large as the largest
 * contact detail on the creative, so the pixel gate measures one against the
 * other. With no contact detail recorded there is nothing to measure against
 * and the check cannot run at all.
 */
export function brandGaps(kit: BrandKit, files: readonly BrandFileRole[]): BrandGap[] {
  const gaps: BrandGap[] = [];

  if (!kit.salesPhone && !kit.salesEmail) {
    gaps.push({
      key: "contact",
      label: "A sales phone number or email",
      why: "The RERA lockup is sized against the largest contact detail on the creative.",
    });
  }
  if (!files.includes("LOGO_HORIZONTAL") && !files.includes("LOGO_STACKED")) {
    gaps.push({
      key: "logo",
      label: "A logo",
      why: "Nothing can be laid out without one.",
    });
  }
  if (!kit.disclaimer) {
    gaps.push({
      key: "disclaimer",
      label: "Disclaimer text",
      why: "Every creative carries one, and a render needs the artist's impression line.",
    });
  }
  return gaps;
}
