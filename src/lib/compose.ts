import { createHash, randomUUID } from "node:crypto";
import { LANGUAGES } from "./campaign-rules.ts";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import jsQR from "jsqr";
import { type JSONValue } from "postgres";
import { withTenant, audit } from "./db/index.ts";
import { isNodeId } from "./scope-rules.ts";
import { approvedAssets, assetKeys } from "./asset.ts";
import { complianceSummary } from "./publish-gate.ts";
import { resolveBrand, readBrandFile } from "./brand.ts";
import { showPhone } from "./brand-rules.ts";
import { materialFor, studioGround } from "./creative.ts";
import { angleLabel, cardFits, cardLead, invitesVisit, isCardAngle, templateAngle, templateGap, type CardFacts } from "./card-angle-rules.ts";
import { adFacts, factsBeside, isLuxury, NO_LOCATION_MESSAGE, pointsFor, priceNoteFor, sellingPoints, storedLocal, type AdFacts } from "./creative-rules.ts";
import { adRuleFor, agentLine, withAgentLine, withoutTermsApply, type AdRule } from "./rera-ad-rules.ts";
import { firmAgentFor } from "./firm-agent.ts";
import { putAsset, readAsset, removeAsset, assetUrl } from "./storage.ts";
import { projectOfNode } from "./storage-place.ts";
import {
  animateFrame,
  designAd,
  reviewDesign,
  DESIGN_MODEL,
  VIDEO_MODEL,
  type AgentBrain,
  type AnimateDriver,
  type ChooseDriver,
  type DesignDriver,
  type ReviewDriver,
} from "./generate.ts";
import { artDirect } from "./design-agent.ts";
import type { AgentStep } from "./agent.ts";
import { carouselReferences, resolveTemplate, templateReferences, type TemplateChoice } from "./templates.ts";
import {
  autoCandidates,
  currentTemplateKey,
  festivalAsk,
  festivalByKey,
  festivalIn,
  isDesignTemplate,
  templateDirection,
  templateFits,
  templateLabel,
  templatePhotos,
  type Festival,
  type TemplateDirection,
} from "./template-rules.ts";
import { entitle, meterPost, postNeeds } from "./billing.ts";
import { FONTS, fontFor, SPECIMEN_LINES, type FontChoice } from "./font-rules.ts";
import { eraseSlot, findQr, findSlot, textZones, type Rect } from "./qr-detect.ts";
import { auditPixel, checkFrame, gatePost, withHashes, type PixelReader } from "./pixel.ts";
import { learningFor } from "./learning.ts";
import { seeded } from "./learning-rules.ts";
import {
  asDesignProblems,
  MAHARERA_RULE,
  pixelRecord,
  pixelSummary,
  sampleTimes,
  signedAmounts,
  type FrameExpect,
  type PixelFinding,
  type PixelRecord,
} from "./pixel-rules.ts";
import type { UnitPrice } from "./creative-rules.ts";
import {
  backgroundsFrom,
  checkDesignPrompt,
  designPrompt,
  designSizeForPlacement,
  keptFraction,
  lockupSpots,
  blockShade,
  qrPercentFor,
  qrSideFor,
  markColour,
  motionPrompt,
  judgeMotion,
  SHOT_SECONDS,
  VIDEO_SHOTS,
  designSizeExact,
  designSizeFor,
  fullDesignPrompt,
  NEUTRAL_LABELS,
  type DesignSize,
  fixesFrom,
  judgeDesign,
  modelSetsText,
  safeFixes,
  slideTexts,
  MAX_DESIGN_ATTEMPTS,
  type Box,
  type DesignProblem,
  escapeMarkup,
  fontList,
  footLines,
  kindDef,
  layoutFor,
  picturesFor,
  placementsFor,
  sceneOf,
  slidesFor,
  slideCount,
  DEFAULT_SLIDES,
  PLACEMENT_SIZE,
  type Layout,
  type Picture,
  type PostKind,
  type Slide,
} from "./compose-rules.ts";

/**
 * The compositor: approved pictures and cleared copy into finished posts.
 *
 * Two paths. `designPost()` has the image model design the ad from the
 * approved photo, stamps the lockup, the logo and the contact line on top,
 * and checks every frame before anybody sees it (the client's choice: see
 * CLAUDE.md, "The design loop"). `composePost()` is the deterministic one it
 * replaced for the studio: the picture resized and cropped, every other layer
 * at coordinates `compose-rules.ts` computed. A video is either one's frames
 * under a slow zoom.
 *
 * Text goes through Pango, which shapes Devanagari properly (a conjunct like
 * द्र renders as one glyph, not three), and the Noto faces are bundled in
 * `assets/fonts/` because a server has no fonts worth the name.
 *
 * Imports are relative because the scheduled runner loads this straight from
 * source, outside Next, where the `@/` alias does not resolve.
 */

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

const FONT_FILES = [
  "NotoSans-Regular.ttf",
  "NotoSans-Bold.ttf",
  "NotoSansDevanagari-Regular.ttf",
  "NotoSansDevanagari-Bold.ttf",
  // The faces a person may choose for a post, `font-rules.ts`.
  ...FONTS.flatMap((f) => [`${f.key}/Regular.ttf`, `${f.key}/Bold.ttf`]),
];

let fontsReady: Promise<void> | null = null;

/**
 * Register the bundled faces with the text renderer, once per process.
 *
 * libvips adds a `fontfile` to the process's font set and keeps it, so one
 * tiny render per file is enough for every later call to find the family by
 * name. Without it, a line mixing Hindi and English took the Latin half from
 * a monospace fallback.
 */
function ensureFonts(): Promise<void> {
  fontsReady ??= (async () => {
    for (const f of FONT_FILES) {
      await sharp({
        text: { text: ".", fontfile: join(process.cwd(), "assets", "fonts", f), rgba: true },
      })
        .png()
        .toBuffer();
    }
  })();
  return fontsReady;
}

type TextImage = { buf: Buffer; w: number; h: number };

const specimens = new Map<string, Promise<{ bytes: Buffer; type: string }>>();

/**
 * A specimen of a chosen face for the image model: the alphabet, bold over
 * regular, black on white. Only letters: a line of words from a real ad
 * would turn up on the next one, and a figure is a number it might set.
 */
function specimen(font: FontChoice): Promise<{ bytes: Buffer; type: string }> {
  if (!specimens.has(font.key)) {
    specimens.set(
      font.key,
      (async () => {
        await ensureFonts();
        const bold = await textImage(SPECIMEN_LINES[0], { family: font.family, size: 64, weight: "Bold", color: "#111111", width: 1400 });
        const regular = await textImage(SPECIMEN_LINES[1], { family: font.family, size: 56, weight: "Regular", color: "#111111", width: 1400 });
        const w = Math.max(bold.w, regular.w) + 80;
        const h = bold.h + regular.h + 100;
        const bytes = await sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } })
          .composite([
            { input: bold.buf, left: 40, top: 40 },
            { input: regular.buf, left: 40, top: 60 + bold.h },
          ])
          .png()
          .toBuffer();
        return { bytes, type: "image/png" };
      })(),
    );
  }
  return specimens.get(font.key)!;
}

async function textImage(
  text: string,
  o: {
    size: number;
    weight: "Regular" | "Bold";
    color: string;
    width: number;
    align?: "left" | "centre";
    /** A chosen face, set before Noto; Noto still sets what it cannot. */
    family?: string | null;
    /** Space between letters, in points: a launch film's name is set wide. */
    spacing?: number;
  },
): Promise<TextImage> {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${o.color}"${o.spacing ? ` letter_spacing="${Math.round(o.spacing * 1024)}"` : ""}>${escapeMarkup(text)}</span>`,
      font: fontList(o.weight, o.size, o.family),
      width: Math.max(10, Math.round(o.width)),
      rgba: true,
      wrap: "word",
      dpi: 72,
      align: o.align === "centre" ? "centre" : "left",
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buf: data, w: info.width, h: info.height };
}

/**
 * A style card for a film made in one generation: the look of the format's
 * big kinetic text (heavy sans capitals, the first part huge and in hot
 * magenta, the rest white and smaller, stacked in the upper third) set in
 * the film's OWN first card over a softened picture of the project. The
 * near-perfect film was shown another creator's text and copied their words
 * onto ours; shown our own words, a copy is still an approved line.
 */
export async function textStyleCard(parts: readonly string[], backdrop: Buffer, w: number, h: number, accent?: string): Promise<Buffer> {
  const layers = await kineticLayers(parts, w, h, accent);
  const ground = await sharp(backdrop).resize(w, h, { fit: "cover" }).blur(3).modulate({ brightness: 0.75 }).toBuffer();
  return sharp(ground).composite(layers).jpeg({ quality: 88 }).toBuffer();
}

/**
 * A card we set on a film ourselves, in the look the model is shown for its
 * own (`textStyleCard()`): a transparent frame of the film's size with the
 * card in the upper third, over a soft shadow so it reads on any picture.
 * The price and the configuration go on this way, because the model drew
 * "1 BKH" and a dollar sign where they were its to draw.
 */
export async function filmCard(parts: readonly string[], w: number, h: number, accent?: string, style: "kinetic" | "elegant" = "kinetic"): Promise<Buffer> {
  return shadowed(style === "elegant" ? await elegantLayers(parts, w, h) : await kineticLayers(parts, w, h, accent), w, h);
}

/**
 * A line of the narration set small at the foot of the picture while it is
 * said, the way the trade's launch films print theirs (Lodha Avalon's "A
 * rhythm, sensed before it's heard."), so a film watched with the sound off
 * still carries it. Ours, so it is spelled as written.
 */
export async function filmSubtitle(text: string, w: number, h: number): Promise<Buffer> {
  await ensureFonts();
  const S = Math.min(w, h);
  const t = await textImage(text, { family: "Sales Desk Montserrat", size: Math.round(S * 0.034), weight: "Regular", color: "#ffffff", width: Math.round(w * 0.8), align: "centre" });
  const top = Math.round(h * 0.76 - t.h / 2);
  return shadowed([{ input: t.buf, left: Math.max(0, Math.round((w - t.w) / 2)), top }], w, h);
}

/**
 * A launch film's name card: the name in a light face set wide, and a
 * second part small beneath it, centred and quiet, the way the trade's
 * launch films close (Lodha's "LODHA / AVALON", 11 October 2026), never the
 * reel's heavy kinetic type.
 */
async function elegantLayers(parts: readonly string[], w: number, h: number): Promise<sharp.OverlayOptions[]> {
  await ensureFonts();
  const S = Math.min(w, h);
  const layers: sharp.OverlayOptions[] = [];
  let y = Math.round(h * 0.4);
  for (const [i, raw] of parts.entries()) {
    const text = raw.toUpperCase();
    let size = Math.round(S * (i === 0 ? 0.07 : 0.03));
    let t = await textImage(text, { family: "Sales Desk Montserrat", size, weight: "Regular", color: "#ffffff", width: Math.round(w * 0.9), align: "centre", spacing: size * 0.18 });
    for (let k = 0; k < 8 && t.w > w * 0.92; k++) {
      size = Math.round(size * 0.85);
      t = await textImage(text, { family: "Sales Desk Montserrat", size, weight: "Regular", color: "#ffffff", width: Math.round(w * 0.9), align: "centre", spacing: size * 0.18 });
    }
    layers.push({ input: t.buf, left: Math.max(0, Math.round((w - t.w) / 2)), top: y });
    y += t.h + Math.round(S * 0.015);
  }
  return layers;
}

/** Layers on a transparent frame of the film's size, over a soft shadow so they read on any picture. */
async function shadowed(layers: sharp.OverlayOptions[], w: number, h: number): Promise<Buffer> {
  const words = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
  const S = Math.min(w, h);
  const shadow = await sharp(words)
    .ensureAlpha()
    .extractChannel("alpha")
    .toColourspace("b-w")
    .blur(Math.max(1, S * 0.012))
    .linear(0.55, 0)
    .toBuffer();
  const dark = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .joinChannel(shadow)
    .png()
    .toBuffer();
  return sharp(dark).composite([{ input: words }]).png().toBuffer();
}

/** The format's big text, laid out: the first part huge, the rest smaller under it, from the top sixth down. */
async function kineticLayers(parts: readonly string[], w: number, h: number, accent = "#ff2d8a"): Promise<sharp.OverlayOptions[]> {
  await ensureFonts();
  const [big, ...rest] = parts.map((p) => p.toUpperCase());
  const layers: sharp.OverlayOptions[] = [];
  let y = Math.round(h * 0.16);
  const add = async (text: string, size: number, color: string) => {
    if (!text) return;
    // A word longer than the frame cannot wrap, so it is set smaller until it
    // fits: "APARTMENTS" at the huge size was wider than a 9:16 frame and the
    // launch film failed before it was filmed (11 October 2026).
    let t = await textImage(text, { family: "Sales Desk Poppins", size, weight: "Bold", color, width: Math.round(w * 0.9), align: "centre" });
    for (let k = 0; k < 8 && (t.w > w * 0.94 || t.h > h * 0.4); k++) {
      size = Math.round(size * 0.85);
      t = await textImage(text, { family: "Sales Desk Poppins", size, weight: "Bold", color, width: Math.round(w * 0.9), align: "centre" });
    }
    layers.push({ input: t.buf, left: Math.max(0, Math.round((w - t.w) / 2)), top: y });
    // A gap between the lines: set touching, "1 BHK" sat on "₹1.45 CR" and
    // the pixel gate read the price as "4 435 CR", refusing the film for a
    // price nobody wrote (10 October 2026).
    y += t.h + gap;
  };
  const S = Math.min(w, h);
  const gap = Math.round(S * 0.025);
  // Stacked in two sizes with one word in colour, the way the references set
  // it: a short first part huge and magenta whole; a longer one with its
  // longest word huge and magenta and the words around it white.
  const words = (big ?? "").split(/\s+/).filter(Boolean);
  if (words.length <= 2) {
    await add(words.join(" "), Math.round(S * 0.15), accent);
  } else {
    const key = words.reduce((a, b, i) => (b.replace(/[^A-Z]/g, "").length > words[a].replace(/[^A-Z]/g, "").length ? i : a), 0);
    await add(words.slice(0, key).join(" "), Math.round(S * 0.085), "#ffffff");
    await add(words[key] ?? "", Math.round(S * 0.17), accent);
    await add(words.slice(key + 1).join(" "), Math.round(S * 0.085), "#ffffff");
  }
  for (const r of rest) await add(r, Math.round(S * 0.07), "#ffffff");
  return layers;
}

// ---------------------------------------------------------------------------
// What a post is built from
// ---------------------------------------------------------------------------

export type Materials = {
  backgrounds: (Picture & { key: string })[];
  /**
   * Approved construction photos. Left out of `backgrounds` for ordinary
   * posts; a construction template pulls them in through `templatePhotos()`.
   */
  site: (Picture & { key: string })[];
  lockup: { assetId: string; sha256: string; key: string } | null;
  logo: { fileId: string; role: string; at: string; bytes: Buffer } | null;
  colour: string;
  phone: string | null;
  website: string | null;
  disclaimer: string | null;
  registrationNo: string | null;
  /**
   * What the registering state's authority asks an ad to carry about the
   * registration (`rera-ad-rules.ts`). Null on an exempt tower, and on a
   * registration in a state nothing here knows.
   */
  ad: AdRule | null;
  /** Telangana's building permit number, printed beside the registration. */
  permitNo: string | null;
  /** The promoter of record and the office a buyer is invited to, for Tamil Nadu and Goa. */
  promoter: string | null;
  officeAddress: string | null;
  brandName?: string | null;
  legalName?: string | null;
  tagline?: string | null;
  /**
   * A mandate firm's or a channel partner's own MahaRERA agent number,
   * printed beside the project's on every ad it makes from its own console.
   * Null for a developer.
   */
  agentNo?: string | null;
  /** Why a firm's own ad may not be made: no current agent registration recorded. */
  agentGap?: { code: string; message: string } | null;
};

/**
 * Everything approved that a post on this node may use.
 *
 * Approved only, through the reads that already withhold the rest: an asset
 * whose current bytes carry no approval never reaches a frame, and neither
 * does a brand mark the kit does not resolve to here.
 */
export async function loadMaterials(
  orgId: string,
  node: { id: string; path: string; kind: string },
): Promise<Materials> {
  const [assets, brand, { ground }, agent, [orgRow]] = await Promise.all([
    approvedAssets(orgId, node.id),
    resolveBrand(orgId, node.id),
    studioGround(orgId, node),
    firmAgentFor(orgId),
    withTenant(orgId, async (sql) =>
      sql<{ display_name: string | null; legal_name: string | null }[]>`
        SELECT display_name, legal_name FROM orgs WHERE id = ${orgId} LIMIT 1
      `,
    ),
  ]);

  // The key of the bytes an approval was given for, read by that hash so a
  // newer unapproved upload can never be the one fetched.
  const keys = assets.length ? await assetKeys(orgId, assets) : [];
  const keyOf = (id: string, sha: string) =>
    keys.find((k) => k.asset_id === id && k.sha256 === sha)?.storage_key ?? null;

  const pictures: (Picture & { key: string })[] = assets.flatMap((a) => {
    const key = keyOf(a.id, a.sha256);
    return key
      ? [{
          assetId: a.id,
          sha256: a.sha256,
          category: String(a.category),
          isRender: a.isRender,
          title: a.title,
          key,
        }]
      : [];
  });

  // A lockup is pinned to its phase and never travels up the tree, so a
  // campaign on a PROJECT finds none among its own assets. The ad prints the
  // registration of the phase underneath with the most life left
  // (`studioGround()`), so its QR is that phase's approved lockup, and no
  // other: the code a buyer scans has to be the number printed beside it.
  // An exempt tower prints no number, so it carries no QR either, even one
  // left in the library from before the exemption.
  // West Bengal puts the registration in a strip along the foot and asks for
  // no QR, so its ads carry none even when the library holds one.
  const ad = ground.registrationNo ? adRuleFor(ground.registrationState) : null;
  const lockupRow = !ground.registrationNo || ad?.placement === "BOTTOM_STRIP"
    ? null
    : (pictures.find((p) => p.category === "RERA_LOCKUP") ??
      (node.kind !== "PHASE" ? await registeredLockup(orgId, node.path, ground.registrationNo) : null));

  const files = brand?.files ?? [];
  const logoFile =
    files.find((f) => f.role === "LOGO_HORIZONTAL") ??
    files.find((f) => f.role === "LOGO_STACKED") ??
    files.find((f) => f.role === "LOGO_MONO") ??
    null;
  const logoBytes = logoFile ? await readBrandFile(orgId, logoFile.id) : null;

  return {
    backgrounds: backgroundsFrom(pictures) as (Picture & { key: string })[],
    site: pictures.filter((p) => p.category === "CONSTRUCTION") as (Picture & { key: string })[],
    lockup: lockupRow
      ? { assetId: lockupRow.assetId, sha256: lockupRow.sha256, key: lockupRow.key }
      : null,
    logo:
      logoFile && logoBytes
        ? { fileId: logoFile.id, role: logoFile.role, at: logoFile.uploadedAt, bytes: logoBytes.bytes }
        : null,
    colour: brand?.kit.colourPrimary ?? "#1b3a86",
    phone: showPhone(brand?.kit.salesPhone ?? null),
    website: brand?.kit.website ?? null,
    disclaimer: brand?.kit.disclaimer ?? null,
    registrationNo: ground.registrationNo,
    ad,
    permitNo: ad?.permitNo ? ground.permitNo ?? null : null,
    promoter: ad?.namePromoter ? await promoterOf(orgId, node.path) : null,
    officeAddress: ad?.namePromoter ? brand?.kit.officeAddress ?? null : null,
    brandName: orgRow?.display_name ?? null,
    legalName: orgRow?.legal_name ?? null,
    tagline: brand?.kit.tagline ?? null,
    agentNo: agent.ok ? agent.agentNo : null,
    agentGap: agent.ok ? null : { code: agent.code, message: agent.message },
  };
}

/**
 * The promoter of record above a node: its ENTITY's name, which is the legal
 * name the registration was filed under.
 */
async function promoterOf(orgId: string, path: string): Promise<string | null> {
  const [row] = await withTenant(orgId, async (sql) =>
    sql<{ name: string }[]>`
      SELECT name FROM scope_nodes
      WHERE org_id = ${orgId} AND kind = 'ENTITY' AND path @> ${path}::ltree
      LIMIT 1`,
  );
  return row?.name ?? null;
}

/**
 * Whether a post may be made for this registration, before anything is paid
 * for: a state that asks for a QR has an approved one in the library, and
 * Telangana's permit number is recorded. Null when it may.
 */
export function registrationGap(m: Materials): { code: string; message: string } | null {
  // A firm's own ad carries its agent registration whatever the tower's.
  if (m.agentGap) return m.agentGap;
  if (!m.registrationNo) return null;
  if (!m.ad) {
    return { code: "NO_AD_RULE", message: "This tower's registration is in a state whose advertising rules are not set up here yet." };
  }
  if (m.ad.qr === "REQUIRED" && !m.lockup) return { code: "NO_LOCKUP", message: NO_LOCKUP_MESSAGE };
  if (m.ad.permitNo && !m.permitNo) {
    return {
      code: "NO_PERMIT",
      message: `${m.ad.authority} wants the building permit number on every ad. Record it with this tower's registration.`,
    };
  }
  return null;
}

/**
 * The small print, as the registering state allows it: Tamil Nadu and Goa
 * forbid "T&C apply", so it is taken out of whatever the brand kit says.
 */
export function smallPrintFor(m: Materials, priced: boolean, small: string | null): string | null {
  const text = [priced ? priceNoteFor(m.ad?.state) : null, small].filter(Boolean).join(" ") || null;
  // A firm's own ad names it as the agent first, beside the project's registration.
  return withAgentLine(text && m.ad?.noTermsApply ? withoutTermsApply(text) || null : text, m.agentNo, m.brandName);
}

/**
 * The approved lockup of the phase registered under `registrationNo`, below
 * `path`. Spacing and case are not a mismatch, the rule `matchesFiling()`
 * follows. Null when that phase has no approved lockup.
 */
async function registeredLockup(
  orgId: string,
  path: string,
  registrationNo: string,
): Promise<(Picture & { key: string }) | null> {
  const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();
  // The gate's own reading of each tower's number, which a channel partner's
  // linked tower takes from the developer's record.
  const phases = (await complianceSummary(orgId)).phases
    .filter((p) => p.path === path || p.path.startsWith(`${path}.`))
    .map((p) => ({ id: p.phaseId, registration_no: p.registrationNo }));
  const phase = phases.find((p) => p.registration_no && norm(p.registration_no) === norm(registrationNo));
  if (!phase) return null;
  const lockup = (await approvedAssets(orgId, phase.id)).find(
    (a) => String(a.category) === "RERA_LOCKUP" && a.nodeId === phase.id,
  );
  if (!lockup) return null;
  const [row] = (await assetKeys(orgId, [lockup])).filter((k) => k.sha256 === lockup.sha256);
  return row
    ? {
        assetId: lockup.id,
        sha256: lockup.sha256,
        category: "RERA_LOCKUP",
        isRender: lockup.isRender,
        title: lockup.title,
        key: row.storage_key,
      }
    : null;
}

/** What a person is told when the approved QR a state asks for is missing. */
export const NO_LOCKUP_MESSAGE =
  "This tower has no approved RERA QR yet. Add it in the Library and approve it, then make the post.";

// ---------------------------------------------------------------------------
// One frame
// ---------------------------------------------------------------------------

/**
 * A frame in two layers: the picture, and everything on top of it.
 *
 * Two rather than one because a video zooms the picture and must not zoom the
 * words or the lockup: a lockup drifting toward the edge of a zooming frame
 * is a lockup that is sometimes cut off. An image is simply the two layers
 * flattened.
 */
export type FrameLayers = { background: Buffer; overlay: Buffer; w: number; h: number };

/** How many modules a side a QR has, read off the code itself; null when none is found. */
export async function qrModules(bytes: Buffer): Promise<number | null> {
  const { data, info } = await sharp(bytes).flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
  return found ? 17 + 4 * found.version : null;
}

/** The QR at `side` pixels, with a thin white margin of its own and nothing else behind it. */
async function qrTile(bytes: Buffer, side: number): Promise<TextImage> {
  const q = await contain(bytes, side, side);
  const m = Math.max(2, Math.round(side * 0.05));
  const buf = await sharp(q.buf)
    .flatten({ background: "#ffffff" })
    .extend({ top: m, bottom: m, left: m, right: m, background: "#ffffff" })
    .png()
    .toBuffer();
  return { buf, w: q.w + m * 2, h: q.h + m * 2 };
}

/**
 * A soft shade behind a block of words, in the tone opposite the ink, at
 * `alpha` over every part of the ground the pixel gate measures the words
 * against (half a line round each). It fades out over several lines,
 * and a block in the corner runs it off the frame's edges, so it reads as
 * the corner of the picture darkened (or lightened) rather than as a box.
 */
async function haze(box: Box, L: Layout, light: boolean, alpha: number): Promise<sharp.OverlayOptions> {
  const sigma = L.regSize * 2;
  const grow = Math.round(L.regSize * 0.7 + sigma * 2);
  let [rx0, ry0, rx1, ry1] = [box.x - grow, box.y - grow, box.x + box.w + grow, box.y + box.h + grow];
  // Into the corner when the block is in it, so the shade has no edge there.
  if (L.w - (box.x + box.w) < L.w * 0.25) rx1 = L.w + grow;
  if (box.y < L.h * 0.12) ry0 = -grow;
  const x0 = Math.max(0, Math.floor(rx0 - sigma * 3));
  const y0 = Math.max(0, Math.floor(ry0 - sigma * 3));
  const x1 = Math.min(L.w, Math.ceil(rx1 + sigma * 3));
  const y1 = Math.min(L.h, Math.ceil(ry1 + sigma * 3));
  const tone = light ? "#ffffff" : "#000000";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${x1 - x0}" height="${y1 - y0}">
    <rect x="${Math.round(rx0 - x0)}" y="${Math.round(ry0 - y0)}" width="${Math.round(rx1 - rx0)}"
      height="${Math.round(ry1 - ry0)}" rx="${grow}" fill="${tone}" fill-opacity="${alpha}"/></svg>`;
  const buf = await sharp(Buffer.from(svg)).blur(Math.max(0.5, sigma)).png().toBuffer();
  return { input: buf, left: x0, top: y0 };
}

/** Hard-hat yellow progress marker for a stamped carousel timeline. */
const TIMELINE_YELLOW = "#F5C518";

function renderSegmentedBarSvg(w: number, active: number, n: number): { svg: string; h: number } {
  const h = Math.max(20, Math.round(w * 0.026));
  const margin = Math.round(w * 0.07);
  const usable = Math.max(1, w - margin * 2);
  const gap = Math.max(4, Math.round(w * 0.008));
  const segW = Math.max(2, (usable - (n - 1) * gap) / n);
  const barH = Math.max(4, Math.round(h * 0.22));
  const barY = Math.round((h - barH) / 2);
  const segs = Array.from({ length: n }, (_, i) => {
    const sx = margin + i * (segW + gap);
    const fill = i === active ? "#FFB800" : i < active ? "rgba(255, 255, 255, 0.85)" : "rgba(255, 255, 255, 0.3)";
    return `<rect x="${sx.toFixed(1)}" y="${barY}" width="${segW.toFixed(1)}" height="${barH}" rx="${(barH / 2).toFixed(1)}" fill="${fill}"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    ${segs}
  </svg>`;
  return { svg, h };
}

function renderCounterPillSvg(w: number, active: number, n: number): { svg: string; h: number } {
  const h = Math.max(32, Math.round(w * 0.038));
  const pillW = Math.max(116, Math.round(w * 0.125));
  const pillH = Math.max(28, Math.round(h * 0.82));
  const pillX = Math.round((w - pillW) / 2);
  const pillY = Math.round((h - pillH) / 2);
  const fontSize = Math.max(12, Math.round(pillH * 0.46));
  const textY = Math.round(pillY + pillH * 0.58);
  const lineY = Math.round(pillY + pillH - 5);
  const trackPad = Math.round(pillW * 0.15);
  const trackW = pillW - trackPad * 2;
  const activeTrackW = Math.max(4, (trackW * (active + 1)) / n);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${(pillH / 2).toFixed(1)}" fill="#111111" fill-opacity="0.82" stroke="#FFFFFF" stroke-opacity="0.25" stroke-width="1.2"/>
    <text x="${pillX + pillW / 2}" y="${textY}" text-anchor="middle" font-family="'Montserrat', 'Arial', sans-serif" font-size="${fontSize}" font-weight="700" fill="#F0EDE6" letter-spacing="1.2">0${active + 1} <tspan fill="#888888" font-weight="400">/</tspan> 0${n}</text>
    <line x1="${pillX + trackPad}" y1="${lineY}" x2="${pillX + pillW - trackPad}" y2="${lineY}" stroke="rgba(255, 255, 255, 0.22)" stroke-width="1.8" stroke-linecap="round"/>
    <line x1="${pillX + trackPad}" y1="${lineY}" x2="${pillX + trackPad + activeTrackW}" y2="${lineY}" stroke="#FFB800" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
  return { svg, h };
}

function renderDotsAndArrowSvg(w: number, active: number, n: number): { svg: string; h: number } {
  const h = Math.max(30, Math.round(w * 0.038));
  const pillH = Math.max(26, Math.round(h * 0.82));
  const dotR = Math.max(3.5, Math.round(pillH * 0.14));
  const activeR = Math.round(dotR * 1.3);
  const dotGap = Math.max(12, Math.round(dotR * 3.2));
  const dotsW = (n - 1) * dotGap + activeR * 2;
  const arrowR = Math.max(8, Math.round(pillH * 0.32));
  const arrowGap = Math.max(14, Math.round(dotR * 3.5));
  const pillPadX = Math.max(16, Math.round(pillH * 0.6));
  const pillW = Math.round(dotsW + arrowGap + arrowR * 2 + pillPadX * 2);
  const pillX = Math.round((w - pillW) / 2);
  const pillY = Math.round((h - pillH) / 2);
  const cy = Math.round(pillY + pillH / 2);
  const dotsStartX = pillX + pillPadX + activeR;

  const dots = Array.from({ length: n }, (_, i) => {
    const cx = dotsStartX + i * dotGap;
    if (i === active) {
      return `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${activeR}" fill="#FFB800" stroke="#ffffff" stroke-width="1.2"/>`;
    }
    if (i < active) {
      return `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${dotR}" fill="#ffffff"/>`;
    }
    return `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${dotR}" fill="none" stroke="rgba(255, 255, 255, 0.45)" stroke-width="1.5"/>`;
  }).join("");

  const arrowCx = pillX + pillW - pillPadX - arrowR;
  const arrowCy = cy;
  const arrowBtn = `
    <circle cx="${arrowCx}" cy="${arrowCy}" r="${arrowR}" fill="rgba(255, 255, 255, 0.18)" stroke="rgba(255, 255, 255, 0.35)" stroke-width="1"/>
    <line x1="${arrowCx - 3.5}" y1="${arrowCy}" x2="${arrowCx + 3.5}" y2="${arrowCy}" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round"/>
    <polyline points="${arrowCx + 0.5},${arrowCy - 3} ${arrowCx + 3.5},${arrowCy} ${arrowCx + 0.5},${arrowCy + 3}" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  `;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${(pillH / 2).toFixed(1)}" fill="#111111" fill-opacity="0.82" stroke="#FFFFFF" stroke-opacity="0.25" stroke-width="1.2"/>
    ${dots}
    ${arrowBtn}
  </svg>`;
  return { svg, h };
}

function renderTimelineSvg(w: number, active: number, n: number): { svg: string; h: number } {
  const h = Math.max(22, Math.round(w * 0.032));
  const margin = Math.round(w * 0.07);
  const usable = Math.max(1, w - margin * 2);
  const r = Math.max(5, Math.round(h * 0.22));
  const activeR = Math.round(r * 1.45);
  const cy = Math.round(h / 2);
  const stroke = Math.max(2, Math.round(r * 0.28));
  const activeX = margin + (n === 1 ? usable / 2 : (usable * active) / (n - 1));
  const dots = Array.from({ length: n }, (_, i) => {
    const cx = margin + (n === 1 ? usable / 2 : (usable * i) / (n - 1));
    if (i === active) {
      return `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${activeR}" fill="${TIMELINE_YELLOW}" stroke="#ffffff" stroke-width="1.5"/>`;
    }
    if (i < active) {
      return `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${r}" fill="#ffffff" stroke="#ffffff" stroke-width="${stroke}"/>`;
    }
    return `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${r}" fill="rgba(0, 0, 0, 0.4)" stroke="#ffffff" stroke-width="${stroke}"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <line x1="${margin}" y1="${cy}" x2="${w - margin}" y2="${cy}" stroke="rgba(255, 255, 255, 0.45)" stroke-width="${stroke}" stroke-linecap="round"/>
    <line x1="${margin}" y1="${cy}" x2="${activeX.toFixed(1)}" y2="${cy}" stroke="${TIMELINE_YELLOW}" stroke-width="${stroke}" stroke-linecap="round"/>
    ${dots}
  </svg>`;
  return { svg, h };
}

function renderExpandedPillsSvg(w: number, active: number, n: number): { svg: string; h: number } {
  const h = Math.max(22, Math.round(w * 0.028));
  const dotH = Math.max(6, Math.round(w * 0.007));
  const activeDotW = Math.round(dotH * 3.6);
  const gap = Math.max(6, Math.round(dotH * 0.9));
  const totalDotW = (n - 1) * (dotH + gap) + activeDotW;
  const startX = Math.round((w - totalDotW) / 2);
  const dotY = Math.round((h - dotH) / 2);
  let curX = startX;
  const pills = Array.from({ length: n }, (_, i) => {
    const curW = i === active ? activeDotW : dotH;
    const fill = i === active ? "#FFB800" : i < active ? "rgba(255, 255, 255, 0.85)" : "rgba(255, 255, 255, 0.35)";
    const el = `<rect x="${curX.toFixed(1)}" y="${dotY}" width="${curW.toFixed(1)}" height="${dotH}" rx="${(dotH / 2).toFixed(1)}" fill="${fill}"/>`;
    curX += curW + gap;
    return el;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    ${pills}
  </svg>`;
  return { svg, h };
}

/**
 * Renders the slide continuity indicator stamped across the foot of a carousel.
 * Each section holds 4 template designs, and each design carries a distinct continuity indicator style:
 * - Style A: Milestone Timeline line (o — ● — o — o)
 * - Style B: Clean Minimalist Progress Dots & Next Arrow (● ● ○ ○ ○ →)
 * - Style C: Architectural Slide Counter Pill with Gold Track (02 / 05)
 * - Style D: Segmented Story Bar / Stepped Stage Capsules
 * - Style E: Modern Expanded Pill Indicators
 */
export async function renderContinuityIndicator(opts: {
  w: number;
  index: number;
  total: number;
  templateKey?: string | null;
  designIndex?: number | null;
  continuity?: string | null;
}): Promise<{ buf: Buffer; w: number; h: number }> {
  const n = Math.max(2, Math.min(10, Math.round(opts.total)));
  const active = Math.max(0, Math.min(n - 1, Math.round(opts.index)));
  const key = opts.templateKey ?? "";
  const cont = opts.continuity?.toLowerCase() ?? "";

  let renderer: (w: number, active: number, n: number) => { svg: string; h: number };

  if (opts.designIndex !== undefined && opts.designIndex !== null) {
    const variant = ((opts.designIndex % 4) + 4) % 4;
    if (key === "07-construction-timeline") {
      const styles = [renderTimelineSvg, renderDotsAndArrowSvg, renderCounterPillSvg, renderSegmentedBarSvg];
      renderer = styles[variant];
    } else if (key === "08-site-progress-report") {
      const styles = [renderSegmentedBarSvg, renderCounterPillSvg, renderDotsAndArrowSvg, renderTimelineSvg];
      renderer = styles[variant];
    } else if (key === "09-architecture-and-elevation") {
      const styles = [renderCounterPillSvg, renderDotsAndArrowSvg, renderSegmentedBarSvg, renderTimelineSvg];
      renderer = styles[variant];
    } else if (key === "10-key-highlights") {
      const styles = [renderExpandedPillsSvg, renderCounterPillSvg, renderDotsAndArrowSvg, renderSegmentedBarSvg];
      renderer = styles[variant];
    } else if (key === "05-reasons-to-buy") {
      const styles = [renderDotsAndArrowSvg, renderCounterPillSvg, renderSegmentedBarSvg, renderTimelineSvg];
      renderer = styles[variant];
    } else {
      const styles = [renderDotsAndArrowSvg, renderCounterPillSvg, renderSegmentedBarSvg, renderTimelineSvg];
      renderer = styles[variant];
    }
  } else {
    if (key === "08-site-progress-report" || /segmented|progress bar/i.test(cont)) {
      renderer = renderSegmentedBarSvg;
    } else if (key === "09-architecture-and-elevation" || /counter|pill/i.test(cont)) {
      renderer = renderCounterPillSvg;
    } else if (key === "10-key-highlights" || /expanded/i.test(cont)) {
      renderer = renderExpandedPillsSvg;
    } else if (/arrow/i.test(cont) || key === "05-reasons-to-buy" || /progress dot/i.test(cont)) {
      renderer = renderDotsAndArrowSvg;
    } else {
      renderer = renderTimelineSvg;
    }
  }

  const { svg, h } = renderer(opts.w, active, n);
  return { buf: await sharp(Buffer.from(svg)).png().toBuffer(), w: opts.w, h };
}

/** The pixels of a picture inside `box`, a few thousand at most, as RGB triples. */
async function pixelsUnder(picture: Buffer, box: Box): Promise<number[][]> {
  const meta = await sharp(picture).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const left = Math.min(W - 1, Math.max(0, Math.round(box.x)));
  const top = Math.min(H - 1, Math.max(0, Math.round(box.y)));
  const width = Math.max(1, Math.min(W - left, Math.round(box.w + Math.min(0, box.x))));
  const height = Math.max(1, Math.min(H - top, Math.round(box.h + Math.min(0, box.y))));
  const k = Math.min(1, Math.sqrt(6000 / (width * height)));
  const { data } = await sharp(picture)
    .extract({ left, top, width, height })
    .resize(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)), { kernel: "nearest" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out: number[][] = [];
  for (let i = 0; i + 2 < data.length; i += 3) out.push([data[i], data[i + 1], data[i + 2]]);
  return out;
}

async function roundedPanel(w: number, h: number, fill: string, radius: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="${fill}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function contain(bytes: Buffer, w: number, h: number): Promise<{ buf: Buffer; w: number; h: number }> {
  const { data, info } = await sharp(bytes)
    .resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buf: data, w: info.width, h: info.height };
}

// ---------------------------------------------------------------------------
// The brand mark, with nothing behind it
// ---------------------------------------------------------------------------

type Mark = { png: Buffer; ink: number[] };
const marks = new Map<string, Promise<Mark>>();

/**
 * A logo file as it is set on a post: cut to what is drawn, with its flat
 * light background taken out when it came without transparency, and the
 * colour it is drawn in.
 *
 * It was set on a white chip, sized to the whole file, and a logo saved with
 * a wide transparent margin came out small in the corner of a white sticker.
 * A developer's logo is drawn to sit on their pictures, not on a label.
 * Taking out a background is a flood from the edges, never every pixel of
 * that colour, so a white letter inside a blue shape stays white.
 */
function bareMark(bytes: Buffer): Promise<Mark> {
  const id = createHash("sha256").update(bytes).digest("hex");
  if (!marks.has(id)) {
    marks.set(
      id,
      (async () => {
        const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const W = info.width;
        const H = info.height;
        const px = W * H;
        let clear = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] < 16) clear++;
        if (clear < px * 0.02) knockOut(data, W, H);

        // Cut to the drawn part: the smallest box holding every visible pixel.
        let [x0, y0, x1, y1] = [W, H, -1, -1];
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4 + 3] > 24) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < x0) [x0, y0, x1, y1] = [0, 0, W - 1, H - 1];

        // The colour it is drawn in, weighted by how solid each pixel is.
        const sum = [0, 0, 0];
        let weight = 0;
        for (let i = 0; i < px; i++) {
          const a = data[i * 4 + 3];
          if (a < 128) continue;
          sum[0] += data[i * 4] * a;
          sum[1] += data[i * 4 + 1] * a;
          sum[2] += data[i * 4 + 2] * a;
          weight += a;
        }
        const ink = weight ? sum.map((v) => Math.round(v / weight)) : [17, 17, 17];
        const png = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
          .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 })
          .png()
          .toBuffer();
        return { png, ink };
      })(),
    );
  }
  return marks.get(id)!;
}

/**
 * The background of an opaque logo made transparent, in place: when its
 * border is one light colour (a logo exported on white), every pixel of that
 * colour connected to the border goes, with a soft edge. A border of several
 * colours, or a dark one, is the logo itself and is left alone.
 */
function knockOut(data: Buffer, W: number, H: number): void {
  const edge: number[] = [];
  for (let x = 0; x < W; x++) edge.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) edge.push(y * W, y * W + W - 1);
  const mean = [0, 1, 2].map((c) => edge.reduce((n, i) => n + data[i * 4 + c], 0) / edge.length);
  const far = (i: number) =>
    Math.max(...[0, 1, 2].map((c) => Math.abs(data[i * 4 + c] - mean[c])));
  const uniform = edge.filter((i) => far(i) > 24).length < edge.length * 0.05;
  const light = mean.every((v) => v > 200);
  if (!uniform || !light) return;
  const seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  for (const i of edge) {
    if (!seen[i] && far(i) <= 48) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const d = far(i);
    // Soft from 24 to 48 away from the background, so the edge is not jagged.
    data[i * 4 + 3] = Math.min(data[i * 4 + 3], d <= 24 ? 0 : Math.round(((d - 24) / 24) * 255));
    const x = i % W;
    const y = (i - x) / W;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!seen[j] && far(j) <= 48) {
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
  }
}

/** The mean colour of one box of a picture. */
async function colourUnder(picture: Buffer, box: Box): Promise<number[]> {
  const meta = await sharp(picture).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const left = Math.min(W - 1, Math.max(0, Math.round(box.x)));
  const top = Math.min(H - 1, Math.max(0, Math.round(box.y)));
  const width = Math.max(1, Math.min(W - left, Math.round(box.w)));
  const height = Math.max(1, Math.min(H - top, Math.round(box.h)));
  const st = await sharp(picture).extract({ left, top, width, height }).removeAlpha().stats();
  return st.channels.slice(0, 3).map((c) => c.mean);
}

/**
 * The logo, sized to fit `w` by `h` with a transparent background in its
 * authentic brand colours from the library, never recoloured to white or
 * monochrome and never placed on an artificial white chip.
 */
export async function bareLogo(bytes: Buffer, w: number, h: number, _ground?: readonly number[]): Promise<TextImage> {
  const mark = await bareMark(bytes);
  const sized = await contain(mark.png, w, h);
  return sized;
}

export async function renderFrame(input: {
  w: number;
  h: number;
  picture: Buffer;
  isRender: boolean;
  slide: Slide;
  lockup: Buffer | null;
  logo: Buffer | null;
  colour: string;
  registrationNo: string | null;
  /** The registering state's rule: its label, its website, where the block goes. Maharashtra's when not given. */
  ad?: AdRule | null;
  /** Telangana's building permit number. */
  permitNo?: string | null;
  /** Tamil Nadu and Goa: the promoter and its office, in the small print. */
  promoter?: string | null;
  officeAddress?: string | null;
  phone: string | null;
  website: string | null;
  disclaimer: string | null;
  /** Set the slide's words. False when the image model already set them. */
  copy?: boolean;
  /** The face a person chose for the copy. The registration panel and the foot stay in Noto. */
  family?: string | null;
  /** Darken the whole lower frame for the words, or only the foot for the contact line. */
  scrim?: "full" | "foot";
  /** A film moves under the overlay, so what is under the words now says nothing about later. */
  moving?: boolean;
  /** "centre" for a designed frame, whose safe area assumes a centred crop. */
  position?: "attention" | "centre";
  /** Put the contact details on a solid footer band, below the picture. */
  band?: boolean;
  /** Where the lockup goes, when not the layout's corner: a spot from `lockupSpots()`. */
  lockupAt?: { x: number; y: number };
}): Promise<FrameLayers> {
  await ensureFonts();
  const base: Layout = layoutFor(input.w, input.h);
  const L: Layout = input.lockupAt ? { ...base, lockup: { ...base.lockup, ...input.lockupAt } } : base;
  const setCopy = input.copy !== false && slideTexts(input.slide).length > 0;
  const footOnly = input.scrim === "foot";
  const band = input.band === true;
  const bandColour = shade(input.colour, 0.22);
  const ad = input.ad === undefined ? adRuleFor("MH") : input.ad;
  // West Bengal: the registration in a solid strip along the foot, at least
  // 8 per cent of the area, and everything else set above it.
  const strip = !!input.registrationNo && ad?.placement === "BOTTOM_STRIP";
  const stripH = strip ? Math.round(L.h * 0.09) : 0;
  const floor = L.h - stripH;

  // ---- the picture, cropped to the frame, with two scrims for legibility --
  // A designed frame carries its own words, so only the contact strip along
  // the foot needs darkening under it.
  const footTop = footOnly ? Math.round(L.foot.y - L.pad * 1.2) : Math.round(L.h * 0.36);
  const contentH = band ? L.bandTop - stripH : L.h;
  const scrim = `<svg xmlns="http://www.w3.org/2000/svg" width="${L.w}" height="${L.h}">
    <defs>
      <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.45"/>
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="foot" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.82"/>
      </linearGradient>
    </defs>
    ${footOnly ? "" : `<rect x="0" y="0" width="${L.w}" height="${Math.round(L.h * 0.28)}" fill="url(#top)"/>`}
    ${band && footOnly ? "" : `<rect x="0" y="${footTop}" width="${L.w}" height="${contentH - footTop}" fill="url(#foot)"/>`}
  </svg>`;
  const picture = band
    ? await sharp(input.picture)
        .resize(L.w, contentH, { fit: "cover", position: input.position ?? "attention" })
        .extend({ bottom: L.h - contentH, background: bandColour })
        .png()
        .toBuffer()
    : input.picture;
  const background = await sharp(picture)
    .resize(L.w, L.h, { fit: "cover", position: input.position ?? "attention" })
    .composite([{ input: Buffer.from(scrim) }])
    .png()
    .toBuffer();

  const layers: sharp.OverlayOptions[] = [];

  // The band is on the overlay, opaque, so a video's zoom never moves it.
  if (band) {
    layers.push({
      input: await sharp({
        create: { width: L.w, height: L.h - contentH, channels: 4, background: bandColour },
      })
        .png()
        .toBuffer(),
      left: 0,
      top: contentH,
    });
  }

  // ---- the registration block, top right ------------------------------------
  // Small, the way developers print it: the label, the number and the
  // Authority's website right-aligned beside a small QR, with no panel. The
  // white panel this replaced read as a block pasted on every post and film
  // (the client, 30 September 2026). The ink is whichever of white and
  // near-black reads on the picture there, and only where the picture does
  // not give the pixel gate's 4.5 to 1 by itself does a soft shade of the
  // other tone go behind the words, as strong as it needs to be and no more
  // (`blockShade()`). A film moves under the words, so it always takes white
  // over a shade. The QR keeps a thin white margin of its own, which a
  // scanner needs, and is as small as its own modules allow (`qrSideFor()`).
  const inPanel = !!input.registrationNo && !!ad && !strip;
  const qrSide = input.lockup && !strip ? qrSideFor(await qrModules(input.lockup), L, !!input.moving) : 0;
  const lockupImg = input.lockup && !strip ? await qrTile(input.lockup, qrSide) : null;
  const wordsArea: Box = {
    x: L.lockup.x - L.regSize,
    y: L.lockup.y - L.regSize,
    w: Math.max(1, L.lockup.w - qrSide - L.lockupPad + L.regSize),
    h: L.lockup.h + L.regSize * 2,
  };
  const behind = blockShade(await pixelsUnder(background, wordsArea), !!input.moving);
  const light = behind.ink === "dark";
  const ink = light ? "#111111" : "#ffffff";
  const colW = Math.max(L.regSize * 9, L.lockup.w);
  // The label small, the number at the registration size, which is never
  // below the contact size: the order measures the number, not the label.
  const label = inPanel
    ? await textImage(ad!.shortLabel, { size: Math.round(L.regSize * 0.7), weight: "Regular", color: ink, width: colW })
    : null;
  const reg = inPanel ? await textImage(input.registrationNo!, { size: L.regSize, weight: "Bold", color: ink, width: colW }) : null;
  // Telangana's building permit number, at the number's size: its notice
  // measures both against the contact details.
  const permit = inPanel && ad!.permitNo && input.permitNo
    ? await textImage(`Permit No. ${input.permitNo}`, { size: L.regSize, weight: "Regular", color: ink, width: colW })
    : null;
  // The Authority's website, at the number's size, which Order 46C/2025 asks
  // for in the same quarter.
  const web = inPanel ? await textImage(ad!.website, { size: L.regSize, weight: "Regular", color: ink, width: colW }) : null;
  const rows = [label, reg, permit, web].filter((r): r is TextImage => !!r);
  const rowGap = Math.round(L.regSize * 0.18);
  const textH = rows.reduce((a, r) => a + r.h, 0) + rowGap * Math.max(0, rows.length - 1);
  const textW = rows.reduce((a, r) => Math.max(a, r.w), 0);
  if (lockupImg || rows.length) {
    const right = L.lockup.x + L.lockup.w;
    const rowH = Math.max(lockupImg?.h ?? 0, textH);
    const top = L.lockup.y;
    const qrX = right - (lockupImg?.w ?? 0);
    const textRight = lockupImg ? qrX - L.lockupPad : right;
    const textTop = top + (rowH - textH) / 2;
    const words: Box = { x: textRight - textW, y: textTop, w: textW, h: textH };
    if (rows.length && behind.alpha > 0) {
      layers.push(await haze(words, L, light, behind.alpha));
    }
    if (lockupImg) layers.push({ input: lockupImg.buf, left: Math.round(qrX), top: Math.round(top + (rowH - lockupImg.h) / 2) });
    let y = textTop;
    for (const r of rows) {
      layers.push({ input: r.buf, left: Math.round(textRight - r.w), top: Math.round(y) });
      y += r.h + rowGap;
    }
  }

  // ---- West Bengal's strip, along the foot ------------------------------------
  // White, full width, the number and the website in bold, set as large as
  // the strip allows: the order measures them against the project's name.
  if (strip && ad && input.registrationNo) {
    layers.push({
      input: await sharp({ create: { width: L.w, height: stripH, channels: 4, background: "#ffffff" } }).png().toBuffer(),
      left: 0,
      top: floor,
    });
    const first = `${ad.label} ${input.registrationNo}${ad.permitNo && input.permitNo ? `  ·  Permit No. ${input.permitNo}` : ""}`;
    const size = Math.max(L.regSize, Math.round(stripH * 0.26));
    const lines = await textImage(`${first}\n${ad.website}`, { size, weight: "Bold", color: "#111111", width: L.w - L.pad * 2 });
    layers.push({ input: lines.buf, left: Math.round((L.w - lines.w) / 2), top: Math.round(floor + (stripH - lines.h) / 2) });
  }

  // ---- the logo, with nothing behind it ------------------------------------
  // A designed frame carries it in the footer bar, beside the contact line.
  // Top left, it took a corner the image model's headline wanted, and a
  // headline set under a logo is a headline cut in half. It sat on a white
  // chip, which read as a sticker; `bareLogo()` recolours it instead when its
  // own colours would not show on what is under it.
  let footTextW = L.foot.w;
  if (input.logo && band) {
    const bandH = floor - contentH;
    const markH = Math.round(Math.min(bandH * 0.46, L.logo.h * 0.7));
    const mark = await bareLogo(input.logo, markH * 4, markH, hexRgb(bandColour));
    const x = L.w - L.pad - mark.w;
    layers.push({ input: mark.buf, left: x, top: Math.round(contentH + (bandH - mark.h) / 2) });
    footTextW = Math.max(10, x - L.pad - L.foot.x);
  } else if (input.logo) {
    const mark = await bareLogo(input.logo, L.logo.w, L.logo.h, await colourUnder(background, L.logo));
    layers.push({ input: mark.buf, left: L.logo.x, top: Math.round(L.logo.y + (L.logo.h - mark.h) / 2) });
  }

  // ---- the foot: contact, then the small print ----------------------------
  const foot = footLines({
    phone: input.phone,
    website: input.website,
    disclaimer: input.disclaimer,
    isRender: input.isRender,
    ad,
    promoter: input.promoter ?? null,
    officeAddress: input.officeAddress ?? null,
  });
  const smallSize = Math.max(11, Math.round(L.contactSize * 0.62));
  const contactImg = foot.contact
    ? await textImage(foot.contact, { size: L.contactSize, weight: "Bold", color: "#ffffff", width: footTextW })
    : null;
  const smallImg = foot.small
    ? await textImage(foot.small, { size: smallSize, weight: "Regular", color: "#e8e8e8", width: footTextW })
    : null;
  let footBottom = floor - (strip ? Math.round(L.pad * 0.5) : L.pad);
  if (band) {
    // Centred in the band rather than hung from the bottom margin.
    const gapH = smallImg && contactImg ? Math.round(L.contactSize * 0.35) : 0;
    const total = (contactImg?.h ?? 0) + (smallImg?.h ?? 0) + gapH;
    footBottom = contentH + Math.round((floor - contentH + total) / 2);
  }
  if (smallImg) {
    layers.push({ input: smallImg.buf, left: L.foot.x, top: footBottom - smallImg.h });
    footBottom -= smallImg.h + Math.round(L.contactSize * 0.35);
  }
  if (contactImg) {
    layers.push({ input: contactImg.buf, left: L.foot.x, top: footBottom - contactImg.h });
    footBottom -= contactImg.h;
  }

  // ---- the copy, set from the foot upward ---------------------------------
  // Bottom-anchored, over the dark scrim, so the building stays visible in
  // the top half of the frame. A title too long for the room shrinks rather
  // than running into the lockup.
  if (!setCopy) {
    const overlay = await sharp({
      create: { width: L.w, height: L.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(layers)
      .png()
      .toBuffer();
    return { background, overlay, w: L.w, h: L.h };
  }

  if (band) footBottom = contentH;
  const room = footBottom - L.pad * 0.8 - L.text.y;
  let titleSize = L.titleSize;
  let title: TextImage | null = null;
  let sub: TextImage | null = null;
  let cta: { panel: Buffer; text: TextImage; w: number; h: number } | null = null;
  // Where it is, above the headline in capitals; what it starts at, under
  // it, bold and larger than the supporting line: the two things a buyer
  // looks for first, never left to the small print.
  const facts = input.slide.facts ?? null;
  const place = facts?.location
    ? await textImage(facts.location.toUpperCase(), {
        family: input.family,
        size: Math.round(L.subSize * 0.9),
        weight: "Bold",
        color: "#ffffff",
        width: L.text.w,
      })
    : null;
  let price: TextImage | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const scale = titleSize / L.titleSize;
    price = facts?.prices.length
      ? await textImage(facts.prices.join("\n"), {
          family: input.family,
          size: Math.round(L.subSize * 1.25 * Math.max(0.8, scale)),
          weight: "Bold",
          color: "#ffffff",
          width: L.text.w,
        })
      : null;
    title = await textImage(input.slide.title, {
      family: input.family,
      size: titleSize,
      weight: "Bold",
      color: "#ffffff",
      width: L.text.w,
    });
    sub = input.slide.sub
      ? await textImage(input.slide.sub, {
          family: input.family,
          size: Math.round(L.subSize * Math.max(0.8, scale)),
          weight: "Regular",
          color: "#f2f2f2",
          width: L.text.w,
        })
      : null;
    if (input.slide.cta) {
      const t = await textImage(input.slide.cta, {
        family: input.family,
        size: L.ctaSize,
        weight: "Bold",
        color: "#ffffff",
        width: L.text.w - L.ctaSize * 2,
      });
      const pw = t.w + L.ctaSize * 1.6;
      const ph = t.h + L.ctaSize * 0.9;
      cta = {
        panel: await roundedPanel(Math.round(pw), Math.round(ph), input.colour, Math.round(ph / 2)),
        text: t,
        w: Math.round(pw),
        h: Math.round(ph),
      };
    } else {
      cta = null;
    }
    const gap = Math.round(L.subSize * 0.6);
    const total =
      title.h + (sub ? sub.h + gap : 0) + (cta ? cta.h + gap * 1.4 : 0) + (price ? price.h + gap : 0) + (place ? place.h + gap * 0.6 : 0);
    if (total <= room) break;
    titleSize = Math.round(titleSize * 0.86);
  }

  const gap = Math.round(L.subSize * 0.6);
  let y = footBottom - Math.round(L.pad * 0.8);
  if (cta) {
    y -= cta.h;
    layers.push({ input: cta.panel, left: L.text.x, top: Math.round(y) });
    layers.push({
      input: cta.text.buf,
      left: Math.round(L.text.x + (cta.w - cta.text.w) / 2),
      top: Math.round(y + (cta.h - cta.text.h) / 2),
    });
    y -= Math.round(gap * 1.4);
  }
  if (sub) {
    y -= sub.h;
    layers.push({ input: sub.buf, left: L.text.x, top: Math.round(y) });
    y -= gap;
  }
  if (price) {
    y -= price.h;
    layers.push({ input: price.buf, left: L.text.x, top: Math.round(y) });
    y -= gap;
  }
  if (title) {
    y -= title.h;
    layers.push({ input: title.buf, left: L.text.x, top: Math.round(Math.max(L.text.y, y)) });
    y -= Math.round(gap * 0.6);
  }
  if (place) {
    y -= place.h;
    layers.push({ input: place.buf, left: L.text.x, top: Math.round(Math.max(L.text.y, y)) });
  }

  const overlay = await sharp({
    create: { width: L.w, height: L.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers)
    .png()
    .toBuffer();

  return { background, overlay, w: L.w, h: L.h };
}

/**
 * The white box the image model drew near where it was shown one, or null.
 *
 * The model redraws the layout's white boxes only roughly: a little lower, a
 * little wider. Stamping exactly over the box it was SHOWN leaves the rest of
 * the one it DREW beside the stamp, a second white edge that reads as a
 * mistake. So the window around the box is searched for rows and columns
 * that are mostly flat white, and their extent is the ghost. Anything larger
 * than two and a half boxes is not a ghost (a white sky, a white wall) and is
 * left alone.
 */
async function ghostBox(picture: Buffer, L: Layout, box: Box): Promise<Box | null> {
  const left = Math.max(0, Math.round(box.x - box.w * 0.6));
  const top = Math.max(0, Math.round(box.y - box.h * 0.8));
  const right = Math.min(L.w, Math.round(box.x + box.w * 1.6));
  const bottom = Math.min(L.bandTop, Math.round(box.y + box.h * 2.2));
  const width = right - left;
  const height = bottom - top;
  if (width < 8 || height < 8) return null;
  const { data } = await sharp(picture)
    .resize(L.w, L.bandTop, { fit: "cover", position: "centre" })
    .extract({ left, top, width, height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const white = (i: number) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return r > 236 && g > 236 && b > 236 && Math.max(r, g, b) - Math.min(r, g, b) < 18;
  };
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x++) if (white((y * width + x) * 3)) n++;
    rows.push(n);
  }
  // The longest run of mostly-white rows, then, within those rows only, the
  // longest run of mostly-white columns: the white box the model drew,
  // wherever near the one it was shown it ended up.
  const longest = (hits: boolean[]) => {
    let best: [number, number] | null = null;
    for (let i = 0; i < hits.length; i++) {
      if (!hits[i]) continue;
      let j = i;
      while (j + 1 < hits.length && hits[j + 1]) j++;
      if (!best || j - i > best[1] - best[0]) best = [i, j];
      i = j;
    }
    return best;
  };
  const ry = longest(rows.map((n) => n >= box.w * 0.4));
  if (!ry || ry[1] - ry[0] < box.h * 0.4) return null;
  const inRun = new Array(width).fill(0);
  for (let y = ry[0]; y <= ry[1]; y++) {
    for (let x = 0; x < width; x++) if (white((y * width + x) * 3)) inRun[x]++;
  }
  const rx = longest(inRun.map((n) => n >= (ry[1] - ry[0] + 1) * 0.6));
  if (!rx) return null;
  const ghost = { x: left + rx[0], y: top + ry[0], w: rx[1] - rx[0] + 1, h: ry[1] - ry[0] + 1 };
  const overlaps =
    ghost.x < box.x + box.w && ghost.x + ghost.w > box.x && ghost.y < box.y + box.h && ghost.y + ghost.h > box.y;
  // A ghost much bigger than the box is covered at the price of hiding the
  // picture under a slab of white, which is the worse of the two.
  if (!overlaps || ghost.w * ghost.h > box.w * box.h * 1.6 || ghost.w < box.w * 0.5 || ghost.h < box.h * 0.4) return null;
  return ghost;
}

/**
 * The QR alone, cut out of an approved lockup, or the lockup as it is when
 * no QR can be found in it. A lockup image usually carries its own number
 * under the code; stamped whole it prints the number twice and shrinks the
 * code to fit, and the panel already sets the number at the size the order
 * asks for.
 */
export async function qrOnly(bytes: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(bytes)
    .flatten({ background: "#ffffff" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
  if (!found) return bytes;
  const pts = [found.location.topLeftCorner, found.location.topRightCorner, found.location.bottomLeftCorner, found.location.bottomRightCorner];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const quiet = Math.round(size * 0.08);
  const left = Math.max(0, Math.floor(Math.min(...xs) - quiet));
  const top = Math.max(0, Math.floor(Math.min(...ys) - quiet));
  const width = Math.min(info.width - left, Math.ceil(size + quiet * 2));
  const height = Math.min(info.height - top, Math.ceil(size + quiet * 2));
  return sharp(bytes).extract({ left, top, width, height }).png().toBuffer();
}

/** A "#rrggbb" colour as its three channels. */
function hexRgb(hex: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [17, 17, 17];
}

/** A colour mixed toward near-black: `amount` of the colour, the rest ink. */
function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const [r, g, b] = m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [27, 58, 134];
  const ink = [11, 13, 18];
  const mix = [r, g, b].map((v, i) => Math.round(v * amount + ink[i] * (1 - amount)));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export async function flatten(frame: FrameLayers): Promise<Buffer> {
  return sharp(frame.background).composite([{ input: frame.overlay }]).jpeg({ quality: 88 }).toBuffer();
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/** Seconds each slide is on screen. */
export const SLIDE_SECONDS = 3;
const FPS = 30;

/**
 * The slides as one clip: the picture zooms slowly, the words hold still.
 *
 * FFmpeg, run as a separate process. Each slide's picture goes through a
 * gentle zoom (to 105 per cent over three seconds), its overlay is laid on
 * top unmoved, each slide fades in and out, and the slides are joined. No
 * audio: licensed music for business use is an open question in
 * `doc/post-generation.md` section 1.e, and a clip with no track is lawful
 * where a clip with the wrong one is not.
 */
export async function renderVideo(frames: FrameLayers[]): Promise<Buffer> {
  if (!frames.length) throw new Error("no frames");
  const { w, h } = frames[0];
  const dir = await mkdtemp(join(tmpdir(), "salesdesk-video-"));
  try {
    const args: string[] = ["-y", "-loglevel", "error"];
    for (let i = 0; i < frames.length; i++) {
      const bg = join(dir, `bg${i}.png`);
      const ov = join(dir, `ov${i}.png`);
      await writeFile(bg, frames[i].background);
      await writeFile(ov, frames[i].overlay);
      args.push("-i", bg, "-loop", "1", "-t", String(SLIDE_SECONDS), "-i", ov);
    }
    const n = frames.length;
    const frameCount = SLIDE_SECONDS * FPS;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const bgIn = i * 2;
      const ovIn = i * 2 + 1;
      parts.push(
        `[${bgIn}:v]scale=${w * 2}:${h * 2},zoompan=z='min(zoom+0.0006,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frameCount}:s=${w}x${h}:fps=${FPS},format=yuva420p[b${i}]`,
        `[b${i}][${ovIn}:v]overlay=0:0:shortest=1,fade=t=in:st=0:d=0.35,fade=t=out:st=${SLIDE_SECONDS - 0.35}:d=0.35,setsar=1[v${i}]`,
      );
    }
    parts.push(`${Array.from({ length: n }, (_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0,format=yuv420p[out]`);
    const out = join(dir, "out.mp4");
    args.push(
      "-filter_complex",
      parts.join(";"),
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-r",
      String(FPS),
      "-movflags",
      "+faststart",
      out,
    );
    await exec(process.env.FFMPEG_PATH || "ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run FFmpeg in a scratch folder that is removed afterwards. */
async function withFfmpeg<T>(run: (dir: string, ff: (args: string[]) => Promise<void>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "salesdesk-shot-"));
  const ff = async (args: string[]) => {
    await exec(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-loglevel", "error", ...args], { maxBuffer: 16 * 1024 * 1024 });
  };
  try {
    return await run(dir, ff);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The video model's clip as one shot of the post: cut to the frame's size,
 * `SHOT_SECONDS` long, and our overlay (the real QR, the logo, and on a laid
 * out frame the words and the lockup) laid over it unmoved.
 */
async function motionShot(clip: Buffer, overlay: Buffer, w: number, h: number): Promise<Buffer> {
  return withFfmpeg(async (dir, ff) => {
    await writeFile(join(dir, "clip.mp4"), clip);
    await writeFile(join(dir, "over.png"), overlay);
    await ff([
      "-i", join(dir, "clip.mp4"),
      "-i", join(dir, "over.png"),
      "-filter_complex",
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${FPS},setsar=1,` +
        `trim=duration=${SHOT_SECONDS},setpts=PTS-STARTPTS[b];[b][1:v]overlay=0:0,format=yuv420p[v]`,
      "-map", "[v]", "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      join(dir, "shot.mp4"),
    ]);
    return readFile(join(dir, "shot.mp4"));
  });
}

/** One frame of a shot, as a PNG, `at` seconds in. */
async function frameAt(shot: Buffer, at: number): Promise<Buffer> {
  return withFfmpeg(async (dir, ff) => {
    await writeFile(join(dir, "shot.mp4"), shot);
    await ff(["-ss", String(at), "-i", join(dir, "shot.mp4"), "-frames:v", "1", join(dir, "frame.png")]);
    return readFile(join(dir, "frame.png"));
  });
}

/** The shots joined, each fading in and out. No audio, for the reason `renderVideo()` gives. */
async function joinShots(shots: Buffer[]): Promise<Buffer> {
  return withFfmpeg(async (dir, ff) => {
    const args: string[] = [];
    for (let i = 0; i < shots.length; i++) {
      await writeFile(join(dir, `s${i}.mp4`), shots[i]);
      args.push("-i", join(dir, `s${i}.mp4`));
    }
    const fade = 0.35;
    const parts = shots.map(
      (_, i) =>
        `[${i}:v]fade=t=in:st=0:d=${fade},fade=t=out:st=${SHOT_SECONDS - fade}:d=${fade},setsar=1[v${i}]`,
    );
    parts.push(`${shots.map((_, i) => `[v${i}]`).join("")}concat=n=${shots.length}:v=1:a=0,format=yuv420p[out]`);
    await ff([
      ...args,
      "-filter_complex", parts.join(";"),
      "-map", "[out]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-r", String(FPS),
      "-movflags", "+faststart",
      join(dir, "out.mp4"),
    ]);
    return readFile(join(dir, "out.mp4"));
  });
}

type Shot = { clip: Buffer; problems: DesignProblem[]; attempts: number };

/**
 * The frame's words, frozen: the still's own pixels on every stroke of type
 * (`textZones()`), under the QR and the logo.
 *
 * Told to leave the words alone, the video model mostly did, and a line of
 * small type over moving leaves still came back as "Artist's imoression. Tne
 * orices" on the first live reel, in the line that carries the phone number
 * and the disclaimer. Only the letters are frozen, not the box round them:
 * the light changes over a clip, and a frozen box showed as a pale patch
 * around the words. In each line the letters are the smaller of the two
 * tones Otsu's threshold splits it into, grown by a pixel for their edges.
 */
export async function freezeOverlay(still: Buffer, overlay: Buffer, w: number, h: number): Promise<Buffer> {
  const zones = await textZones(still);
  if (!zones.length) return overlay;
  const rgb = await sharp(still).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const lum = (i: number) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  const ink = new Uint8Array(w * h);
  for (const z of zones) {
    const x0 = Math.max(0, z.x - 2);
    const y0 = Math.max(0, z.y - 2);
    const x1 = Math.min(w, z.x + z.w + 2);
    const y1 = Math.min(h, z.y + z.h + 2);
    const hist = new Array(256).fill(0);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[Math.round(lum(y * w + x))]++;
    const total = (x1 - x0) * (y1 - y0);
    // Otsu: the threshold that best separates the two tones.
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let [sumB, wB, best, cut] = [0, 0, -1, 128];
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB || wB === total) continue;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / (total - wB);
      const between = wB * (total - wB) * (mB - mF) ** 2;
      if (between > best) [best, cut] = [between, t];
    }
    let dark = 0;
    for (let t = 0; t <= cut; t++) dark += hist[t];
    const inkIsDark = dark <= total - dark;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (inkIsDark ? lum(i) <= cut : lum(i) > cut) ink[i] = 1;
      }
    }
  }
  const alpha = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        for (let dx = -1; dx <= 1 && !on; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w && ink[yy * w + xx]) on = 1;
        }
      }
      alpha[y * w + x] = on ? 255 : 0;
    }
  }
  const soft = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).blur(0.8).extractChannel(0).raw().toBuffer();
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = soft[i];
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).composite([{ input: overlay }]).png().toBuffer();
}

/**
 * One checked frame brought to life, and checked again.
 *
 * The frame already passed every rule a still is held to. What a clip can
 * add is drift: a letter that melted, a floor that grew, a QR that slid out
 * from under ours. So its last frame, where drift is greatest, is read back
 * against the frame's own check (`judgeMotion()`), and a clip that drifted is
 * made again with a stricter instruction, up to `MAX_DESIGN_ATTEMPTS`.
 */
async function animateShot(input: {
  shot: DesignedFrame;
  scene: "exterior" | "interior";
  reference: { bytes: Buffer; type: string };
  animate: AnimateDriver;
  drivers: Drivers;
  materials: Materials;
  lockupBytes: Buffer | null;
  expectedQr: string | null;
  /** What the pixel gate measures a frame of the clip against, and its reader. */
  expect: FrameExpect;
  reader?: PixelReader;
  signal?: AbortSignal;
}): Promise<Shot | Refused> {
  const { frame, check } = input.shot;
  const still = await flatten(frame);
  const reference = await forModel(input.reference.bytes, 1024);
  const layer = await freezeOverlay(still, frame.overlay, frame.w, frame.h);
  let best: Shot | null = null;
  for (let attempt = 1; attempt <= MAX_DESIGN_ATTEMPTS; attempt++) {
    if (input.signal?.aborted) break;
    const strict = attempt > 1;
    const { prompt, negative } = motionPrompt(input.scene, strict);
    const made = await input.animate(
      {
        image: { bytes: still, type: "image/jpeg" },
        prompt,
        negativePrompt: negative,
        duration: SHOT_SECONDS as 5,
        cfgScale: strict ? 0.8 : 0.5,
      },
      { signal: input.signal },
    );
    if (!made.ok) {
      if (!best) return { refused: made.message, code: made.code };
      break;
    }
    const clip = await motionShot(made.bytes, layer, frame.w, frame.h);
    const last = await frameAt(clip, SHOT_SECONDS - 0.25);
    const qrRead = input.lockupBytes ? await readQr(last, check.qrRegion) : null;
    const read = await readBack(input.drivers, { frame: await forModel(last, 2048), reference }, input.signal);
    const review = read.ok ? read.review : null;
    if (review && check.latinOnly) review.texts = review.texts.filter((t) => modelSetsText([t]));
    const problems = judgeMotion(
      judgeDesign({
        review,
        expected: check.expected,
        allowed: check.allowed,
        registrationNo: input.materials.registrationNo,
        ad: input.materials.ad,
        permitNo: input.materials.permitNo,
        phone: input.materials.phone,
        scene: input.scene,
        qr: { lockup: !!input.lockupBytes, expected: input.expectedQr, read: qrRead },
      }),
    );
    // What motion broke in the pixels themselves: the number, the QR, the
    // small print. The overlay is ours, so none of it is the model's to fix;
    // a clip that drifted is made again under the same cap.
    problems.push(...pixelProblems(await checkFrame(last, input.expect, { reader: input.reader }), { lockup: false, copy: false }));
    const now: Shot = { clip, problems, attempts: attempt };
    if (!best || problems.length < best.problems.length) best = now;
    best = { ...best, attempts: attempt };
    if (!problems.length) break;
  }
  return best ?? { refused: "Stopped." };
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

export type MediaItem = { key: string; type: string; width: number; height: number; bytes: number };

export type PostInputs = {
  pictures: { assetId: string; sha256: string }[];
  lockup: { assetId: string; sha256: string } | null;
  logo: { role: string; fileId: string; at: string } | null;
  registrationNo: string | null;
  /** The template category an image post was designed after, and who chose it. */
  template?: TemplateChoice | null;
  /** The location and price lines printed on the cover, checked again when it is published. */
  facts?: AdFacts | null;
  /** The face a person chose, by key, or null for the design's own. */
  font?: string | null;
  /** A firm's own agent number as printed, checked again when it is published. */
  agentNo?: string | null;
  /** The festival a festive template built the post around, by key. */
  festival?: string | null;
};

/**
 * One post in one placement: its frames, or its clip.
 *
 * Returns the bytes rather than storing them, so a scheduled run and the
 * studio store them wherever each keeps its media, and a check can look at
 * them without a bucket.
 */
export async function composePost(input: {
  kind: PostKind;
  placement: string;
  copy: { headline: string; body: string; cta: string };
  talkingPoints: readonly string[];
  materials: Materials;
  seed: number;
}): Promise<{
  files: { bytes: Buffer; type: string; w: number; h: number }[];
  inputs: PostInputs;
  /** Per file: whether a render is on it, and (for a picture) the approved picture's region as it must still be. */
  checks: { render: boolean; region: { expected: Buffer; mask: Buffer } | null }[];
  /** For a video: each slide's seconds. */
  spans: { start: number; end: number }[];
}> {
  const size = PLACEMENT_SIZE[input.placement];
  if (!size) throw new Error(`no size for ${input.placement}`);
  const m = input.materials;

  // A video is its carousel, so it is built from the same slides.
  const slideKind: PostKind = input.kind === "VIDEO" ? "CAROUSEL" : input.kind;
  const slides = slidesFor(input.copy, input.talkingPoints, slideKind);
  const pictures = picturesFor(m.backgrounds, slides.length, input.seed) as (Picture & { key: string })[];
  if (!pictures.length) throw new Error("NO_PICTURE");

  const lockupBytes = m.lockup ? await readAsset(m.lockup.key) : null;
  const cache = new Map<string, Buffer>();
  const bytesOf = async (p: Picture & { key: string }) => {
    if (!cache.has(p.key)) {
      const b = await readAsset(p.key);
      if (!b) throw new Error("PICTURE_UNREADABLE");
      cache.set(p.key, b);
    }
    return cache.get(p.key)!;
  };

  const frames: FrameLayers[] = [];
  for (let i = 0; i < slides.length; i++) {
    frames.push(
      await renderFrame({
        w: size.w,
        h: size.h,
        picture: await bytesOf(pictures[i]),
        isRender: pictures[i].isRender,
        slide: slides[i],
        lockup: lockupBytes,
        logo: m.logo?.bytes ?? null,
        colour: m.colour,
        registrationNo: m.registrationNo,
        ad: m.ad,
        permitNo: m.permitNo,
        promoter: m.promoter,
        officeAddress: m.officeAddress,
        phone: m.phone,
        website: m.website,
        disclaimer: smallPrintFor(m, false, m.disclaimer),
      }),
    );
  }

  const inputs: PostInputs = {
    pictures: [...new Map(pictures.map((p) => [p.assetId, { assetId: p.assetId, sha256: p.sha256 }])).values()],
    lockup: m.lockup ? { assetId: m.lockup.assetId, sha256: m.lockup.sha256 } : null,
    logo: m.logo ? { role: m.logo.role, fileId: m.logo.fileId, at: m.logo.at } : null,
    registrationNo: m.registrationNo,
    agentNo: m.agentNo ?? null,
  };

  if (input.kind === "VIDEO") {
    return {
      files: [{ bytes: await renderVideo(frames), type: "video/mp4", w: size.w, h: size.h }],
      inputs,
      checks: [{ render: pictures.some((p) => p.isRender), region: null }],
      spans: frames.map((_, i) => ({ start: i * SLIDE_SECONDS, end: (i + 1) * SLIDE_SECONDS })),
    };
  }
  const files = [];
  const checks = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    files.push({ bytes: await flatten(f), type: "image/jpeg", w: size.w, h: size.h });
    // The picture's region is the approved bytes resized, cropped and shaded,
    // and nothing else: wherever the overlay is clear, the finished frame
    // must still be exactly that (doc/post-generation.md section 5, rule 2).
    const alpha = await sharp(f.overlay).ensureAlpha().extractChannel(3).raw().toBuffer();
    const mask = Buffer.alloc(alpha.length);
    for (let k = 0; k < alpha.length; k++) mask[k] = alpha[k] === 0 ? 1 : 0;
    checks.push({ render: pictures[i].isRender, region: { expected: f.background, mask } });
  }
  return { files, inputs, checks, spans: [] };
}

/**
 * Store a post's files under one id, in the folder of the project the post
 * was made for, removing what was stored if any put fails.
 */
export async function storePostFiles(
  orgId: string,
  nodeId: string | null,
  postId: string,
  files: { bytes: Buffer; type: string; w: number; h: number }[],
): Promise<MediaItem[] | null> {
  const stored: MediaItem[] = [];
  const project = await projectOfNode(orgId, nodeId);
  for (let i = 0; i < files.length; i++) {
    const put = await putAsset({
      orgId,
      project,
      kind: "post",
      id: `${postId}-${i}`,
      bytes: files[i].bytes,
      contentType: files[i].type,
    });
    if (!put.ok) {
      for (const s of stored) await removeAsset(s.key);
      return null;
    }
    stored.push({ key: put.key, type: files[i].type, width: files[i].w, height: files[i].h, bytes: put.bytes });
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Designed by the image model, checked, and designed again
// ---------------------------------------------------------------------------

/**
 * Read a QR code, or null.
 *
 * jsQR on the raw pixels. A small QR in a big frame is found far more
 * reliably when it is cut out and enlarged first, so a region can be named.
 */
export async function readQr(bytes: Buffer, region?: Box): Promise<string | null> {
  const tries: sharp.Sharp[] = [];
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (region && W && H) {
    const left = Math.max(0, Math.floor(region.x));
    const top = Math.max(0, Math.floor(region.y));
    const width = Math.min(W - left, Math.ceil(region.w));
    const height = Math.min(H - top, Math.ceil(region.h));
    if (width > 8 && height > 8) {
      tries.push(sharp(bytes).extract({ left, top, width, height }).resize({ width: width * 3, kernel: "nearest" }));
    }
  }
  tries.push(sharp(bytes));
  if (W && W < 600) tries.push(sharp(bytes).resize({ width: W * 3, kernel: "nearest" }));
  for (const t of tries) {
    const { data, info } = await t.flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const found = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
    if (found?.data) return found.data;
  }
  return null;
}

/** A picture cut down for sending: long side at most `max`, JPEG. */
async function forModel(bytes: Buffer, max: number): Promise<{ bytes: Buffer; type: string }> {
  const out = await sharp(bytes)
    .resize(max, max, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { bytes: out, type: "image/jpeg" };
}

/**
 * What the image model is shown: the approved photo, cropped as the post
 * will crop it, with plain white boxes where the logo and the lockup will be
 * stamped. Told the corners in percentages, the model set its headline under
 * both of them three times in a row; shown the boxes, it designs around them.
 * The drawing is the design size, so the part the post keeps sits in the
 * middle and the rest is the photo blurred.
 */
async function layoutGuide(
  photo: Buffer,
  L: Layout,
  size: DesignSize,
  lockup: Box,
): Promise<{ bytes: Buffer; type: string }> {
  const [gw, gh] = size.split("x").map(Number);
  const kept = keptFraction(L.w, L.bandTop, size);
  const cw = Math.round(gw * kept.x);
  const chh = Math.round(gh * kept.y);
  const sx = cw / L.w;
  const sy = chh / L.bandTop;
  const box = (b: Box) =>
    roundedPanel(Math.max(8, Math.round(b.w * sx)), Math.max(8, Math.round(b.h * sy)), "#ffffff", Math.round(Math.min(b.w * sx, b.h * sy) * 0.12));
  const content = await sharp(photo)
    .resize(cw, chh, { fit: "cover", position: "centre" })
    .composite([{ input: await box(lockup), left: Math.round(lockup.x * sx), top: Math.round(lockup.y * sy) }])
    .png()
    .toBuffer();
  const back = await sharp(photo).resize(gw, gh, { fit: "cover" }).blur(24).png().toBuffer();
  const bytes = await sharp(back)
    .composite([{ input: content, left: Math.round((gw - cw) / 2), top: Math.round((gh - chh) / 2) }])
    .jpeg({ quality: 90 })
    .toBuffer();
  return { bytes, type: "image/jpeg" };
}

/**
 * How busy each spot is on a picture: lower is calmer. The picture is cropped
 * as the frame will crop it (the part above the footer band), and each spot
 * scored by its tonal spread plus its edge energy, so sky and plain wall
 * score low and a facade, a face or a line of type scores high.
 *
 * A small bias toward the earlier spots, so the corner wins a near tie: a
 * lockup that wanders for no visible reason looks like a mistake.
 */
async function spotScores(picture: Buffer, L: Layout, spots: readonly Box[]): Promise<number[]> {
  const grey = await sharp(picture)
    .resize(L.w, L.bandTop, { fit: "cover", position: "centre" })
    .greyscale()
    .png()
    .toBuffer();
  const edges = await sharp(grey)
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], scale: 1, offset: 128 })
    .png()
    .toBuffer();
  const scores: number[] = [];
  for (let i = 0; i < spots.length; i++) {
    const b = spots[i];
    const box = {
      left: Math.max(0, Math.round(b.x)),
      top: Math.max(0, Math.round(b.y)),
      width: Math.max(1, Math.min(L.w - Math.round(b.x), Math.round(b.w))),
      height: Math.max(1, Math.min(L.bandTop - Math.round(b.y), Math.round(b.h))),
    };
    const tone = await sharp(grey).extract(box).stats();
    const edge = await sharp(edges).extract(box).stats();
    scores.push((tone.channels[0].stdev + edge.channels[0].stdev * 2) * (1 + i * 0.04));
  }
  return scores;
}

/** The calmest spot not already tried. */
async function calmestSpot(picture: Buffer, L: Layout, tried: readonly Box[]): Promise<Box> {
  const all = lockupSpots(L);
  const same = (a: Box, b: Box) => a.x === b.x && a.y === b.y;
  const open = all.filter((s) => !tried.some((t) => same(s, t)));
  const pool = open.length ? open : all;
  const scores = await spotScores(picture, L, pool);
  let best = 0;
  for (let i = 1; i < pool.length; i++) if (scores[i] < scores[best]) best = i;
  return pool[best] ?? L.lockup;
}

export type Drivers = {
  design: DesignDriver;
  review: ReviewDriver;
  choose?: ChooseDriver;
  animate?: AnimateDriver;
  /** The art director's model, injected by the checks so a suite never pays for one. */
  brain?: AgentBrain;
  /**
   * The pixel gate's reader, injected by the suites whose image model is a
   * fake that draws no words. The rules that judge what it read are never
   * injected.
   */
  pixel?: PixelReader;
};

/**
 * What the pixel gate measures a post's prices and registration against,
 * beyond what the materials carry: the approved configurations, every other
 * signed amount, and how long the registration has left.
 */
export type PixelContext = {
  configurations: readonly UnitPrice[];
  money: readonly number[];
  registrationDaysLeft: number | null;
};

/** The pixel context from a studio ground: what the copy gate measured against, too. */
export function pixelContext(ground: {
  configurations: readonly UnitPrice[];
  money: readonly string[];
  talkingPoints: readonly string[];
  registrationDaysLeft: number | null;
}): PixelContext {
  return {
    configurations: ground.configurations,
    money: signedAmounts([...ground.money, ...ground.talkingPoints]),
    registrationDaysLeft: ground.registrationDaysLeft,
  };
}

/** What one frame of a post must carry, for the pixel gate. */
export function frameExpect(
  m: Materials,
  expectedQr: string | null,
  ctx: PixelContext | null,
  opts: { render: boolean; contact?: boolean },
): FrameExpect {
  return {
    registrationNo: m.registrationNo,
    // The registering authority's own rule. A registration with no known
    // rule is measured against Maharashtra's, which fails closed: its block
    // will not carry MahaRERA's website.
    authority: m.ad
      ? {
          website: m.ad.website,
          hosts: m.ad.hosts,
          qrRequired: m.ad.qr === "REQUIRED",
          place: m.ad.placement,
          sizeAgainstContact: m.ad.size === "CONTACT",
        }
      : MAHARERA_RULE,
    qrPayload: expectedQr,
    phone: m.phone,
    website: m.website?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null,
    render: opts.render,
    contact: opts.contact ?? true,
    configurations: ctx?.configurations ?? [],
    money: ctx?.money ?? [],
    registrationDaysLeft: ctx?.registrationDaysLeft ?? null,
  };
}

/**
 * A drawing's pixel failures, as problems for the design loop: what the
 * model drew is the model's to fix within the drawings it already has; a
 * HOLD is not a design's to fix, and stays with the post.
 */
function pixelProblems(findings: readonly PixelFinding[], drawn: { lockup: boolean; copy: boolean }): DesignProblem[] {
  return asDesignProblems(findings.filter((f) => f.verdict === "FAIL"), drawn);
}

/**
 * The checker's reading of a frame, asked twice before giving up. A reading
 * that failed marks the post "could not be checked", which fails it, and on
 * a live carousel one slide in five did: a dropped call is not a bad design,
 * and asking again costs a fraction of drawing again.
 */
async function readBack(
  drivers: Drivers,
  req: Parameters<ReviewDriver>[0],
  signal?: AbortSignal,
): ReturnType<ReviewDriver> {
  const first = await drivers.review(req, { signal });
  if (first.ok || signal?.aborted) return first;
  return drivers.review(req, { signal });
}

/** What the check found, stored with the post and shown on its tile. */
export type PostReview = {
  passed: boolean;
  /** Image-model calls made, across every frame. */
  attempts: number;
  problems: { code: string; text: string; soft?: boolean }[];
  model: string;
  /** A video's clips: the video model, and its calls across every shot. */
  motion?: { model: string; attempts: number };
  /** The art director that made it: its model, its turns, and what its thinking cost in dollars. */
  agent?: { model: string; turns: number; usd: number };
  /** A film's findings that do not stop it, for the person to look at. */
  notes?: string[];
};

/**
 * What a frame's check measured it against, kept so a clip made from the
 * frame can be read back against the same thing.
 */
type FrameCheck = {
  expected: string[];
  allowed: string[];
  /** Where the QR is scanned for. */
  qrRegion?: Box;
  /** Keep only Latin text the reader saw: the rest is our own Pango lines. */
  latinOnly: boolean;
};

/** One drawing of one frame, stamped and checked. `attempts` is which drawing of its slide it was. */
export type DesignedFrame = {
  frame: FrameLayers;
  problems: DesignProblem[];
  image: Buffer;
  attempts: number;
  check: FrameCheck;
  /** The approved picture it was drawn from: what the post records, and what its clip is checked against. */
  picture: Picture & { key: string };
  /** What the pixel gate found on the finished frame, HOLDs included. */
  pixel: PixelFinding[];
};
/**
 * A frame that could not be designed, and the provider's code when it was the
 * provider that said no. `guard` is the instruction guardrail refusing what
 * the card itself would have put on the frame, which no other attempt fixes.
 */
export type Refused = { refused: string; code?: string; guard?: boolean };

/** What one drawing is asked to do. */
export type AttemptPlan = {
  /** The attempt this one starts from: shown to the model, or edited. */
  base: DesignedFrame | null;
  /** Edit `base` (keep everything, change only the notes) rather than design again from the photograph. */
  edit: boolean;
  /** The art director's notes, already through `guardAgentText()`. */
  notes: readonly string[];
  /** The finished first slide of the set, for every later one to match. */
  cover: { bytes: Buffer; type: string } | null;
  signal?: AbortSignal;
};

/**
 * One slide's designer: every call is one paid drawing, stamped and checked.
 * The design agent decides what each drawing is asked for and when to stop;
 * the designer decides nothing but how a plan becomes an instruction, and
 * checks that instruction before anything is sent.
 */
export type SlideDesigner = {
  attempt(plan: AttemptPlan): Promise<DesignedFrame | Refused>;
  /** Drawings made so far. */
  made(): number;
};

/**
 * One frame on the stamped path, for words the model cannot set: the model
 * designs the picture and leaves room, and the lockup, the logo, the contact
 * strip (and here the words, in Pango) are stamped by us AFTER the model,
 * never drawn by it: a generated QR does not scan and a generated
 * registration number is a number nobody filed. The check then reads the
 * finished frame, stamps included, because that is what a buyer sees.
 */
function stampedDesigner(input: {
  w: number;
  h: number;
  placement: string;
  photo: { bytes: Buffer; type: string };
  /** The approved picture `photo` is. */
  picture: Picture & { key: string };
  isRender: boolean;
  slide: Slide;
  cleared: readonly string[];
  neverSay: readonly string[];
  materials: Materials;
  lockupBytes: Buffer | null;
  /** What is stamped in the panel: the lockup's QR alone, when one was found. */
  stampBytes?: Buffer | null;
  expectedQr: string | null;
  drivers: Drivers;
  /** Reference designs of the chosen template, and its name. Empty for none. */
  references?: { bytes: Buffer; type: string }[];
  templateName?: string | null;
  /** The template's look in words, and the festival the post is built around. */
  style?: TemplateDirection | null;
  /** The face a person chose. */
  font?: FontChoice | null;
  /** What the pixel gate measures against, and its reader when a suite injects one. */
  pixel: { ctx: PixelContext | null; reader?: PixelReader };
}): SlideDesigner {
  const m = input.materials;
  const size = designSizeForPlacement(input.w, input.h);
  // A photo slide has no words: nothing for the model to set, nor for us.
  const words = slideTexts(input.slide);
  const textByModel = words.length > 0 && modelSetsText(words);
  const L = layoutFor(input.w, input.h);
  const refs = input.references ?? [];
  let made = 0;
  // Where the lockup goes: the calmest spot in the upper-right quarter of the
  // approved photo, so the white box the model is shown sits on sky or plain
  // wall rather than on the top of the tower. A frame whose panel still
  // covered something moves it to the next calmest.
  const tried: Box[] = [];
  let spot: Box | null = null;
  let guide: { bytes: Buffer; type: string } | null = null;
  let lastPlaced: Box | null = null;

  return {
    made: () => made,
    async attempt(plan) {
      const small = await forModel(input.photo.bytes, 1024);
      if (!spot || !guide) {
        spot = await calmestSpot(input.photo.bytes, L, tried);
        guide = await layoutGuide(input.photo.bytes, L, size, spot);
      }
      const base = plan.base;
      if (base?.problems.some((p) => p.code === "LOCKUP_COVERS")) {
        tried.push(spot, lastPlaced ?? spot);
        spot = await calmestSpot(input.photo.bytes, L, tried);
        guide = await layoutGuide(input.photo.bytes, L, size, spot);
      }
      // The checker's fixes, and the art director's notes, which the agent's
      // guard (`guardAgentText()`) already read before this was asked for.
      const ours = base ? safeFixes(fixesFrom(base.problems), input.cleared) : [];
      const fixes = base ? [...ours, ...plan.notes] : [];
      const prompt = designPrompt({
        slide: input.slide,
        placement: input.placement,
        w: input.w,
        h: input.h,
        size,
        colour: m.colour,
        textByModel,
        fixes,
        lockup: spot,
        references: refs.length ? { count: refs.length, label: input.templateName ?? "real estate" } : null,
        direction: base ? [] : plan.notes,
        font: input.font ? { describe: input.font.describe } : null,
        style: input.style ?? null,
      });
      // The instruction guardrail, on what is about to be sent.
      const issues = checkDesignPrompt({ prompt, slide: input.slide, cleared: input.cleared, neverSay: input.neverSay, fixes: ours });
      if (issues.length) return { refused: issues[0], guard: true };

      const buildingChanged = base?.problems.some((p) => p.code === "BUILDING_CHANGED");
      const baseImg = base && !buildingChanged ? await forModel(base.image, 1536) : null;
      const images = baseImg ? [baseImg, guide, ...refs] : [guide, ...(buildingChanged ? [] : refs)];
      const no = ++made;
      const drawn = await input.drivers.design({ prompt, images, size }, { signal: plan.signal });
      if (!drawn.ok) return { refused: drawn.message, code: drawn.code };

      // The lockup is placed on what the model actually drew: the white box it
      // was shown is usually the calmest spot, and where the model moved
      // things, the lockup moves to where it hides least. A white box it drew
      // there anyway is painted out from the picture around it, as the logo's
      // slot is: a white panel over it put back the block the client asked to
      // be rid of (30 September 2026).
      const placed = await calmestSpot(drawn.bytes, L, []);
      const ghost = input.lockupBytes ? await ghostBox(drawn.bytes, L, placed) : null;
      const picture = ghost
        ? await eraseSlot(
            await sharp(drawn.bytes).resize(L.w, L.bandTop, { fit: "cover", position: "centre" }).png().toBuffer(),
            ghost,
            Math.max(4, Math.round(Math.min(ghost.w, ghost.h) * 0.06)),
          )
        : drawn.bytes;
      const frame = await renderFrame({
        w: input.w,
        h: input.h,
        picture,
        // A designed picture is an impression even when it started from a
        // photograph: the model redrew the light, the sky and the building.
        isRender: true,
        slide: input.slide,
        lockup: input.stampBytes ?? input.lockupBytes,
        logo: m.logo?.bytes ?? null,
        colour: m.colour,
        registrationNo: m.registrationNo,
        ad: m.ad,
        permitNo: m.permitNo,
        promoter: m.promoter,
        officeAddress: m.officeAddress,
        phone: m.phone,
        website: m.website,
        disclaimer: smallPrintFor(m, !!input.slide.facts?.prices.length, m.disclaimer),
        copy: !textByModel && words.length > 0,
        family: input.font?.family ?? null,
        scrim: textByModel || !words.length ? "foot" : "full",
        position: "centre",
        band: true,
        lockupAt: { x: placed.x, y: placed.y },
      });
      const flat = await flatten(frame);
      lastPlaced = placed;

      // The post-generation guardrail: scan the QR, have the frame read, decide.
      const qrRead = input.lockupBytes ? await readQr(flat, placed) : null;
      const read = await readBack(input.drivers, { frame: await forModel(flat, 2048), reference: small }, plan.signal);
      const review = read.ok ? read.review : null;
      if (review && !textByModel) {
        // Our own Pango lines in a script the reader transcribes loosely are
        // not the model's words; only Latin text it added is.
        review.texts = review.texts.filter((t) => modelSetsText([t]));
      }
      const check: FrameCheck = {
        expected: textByModel ? slideTexts(input.slide) : [],
        allowed: [...input.cleared, ...stampedTexts(m), ...NEUTRAL_LABELS],
        qrRegion: placed,
        latinOnly: !textByModel,
      };
      const problems = judgeDesign({
        review,
        expected: check.expected,
        allowed: check.allowed,
        registrationNo: m.registrationNo,
        ad: m.ad,
        permitNo: m.permitNo,
        phone: m.phone,
        scene: sceneOf(input.picture.category),
        qr: { lockup: !!input.lockupBytes, expected: input.expectedQr, read: qrRead },
      });
      // The lockup, contact line and small print are stamped by us on this
      // path. Leaving their vision/pixel faults in the design loop made Hindi
      // carousels give_up on "registration website unreadable" after the
      // drawings ran out, even though another drawing cannot fix our stamp.
      const stampOwned = !!(input.lockupBytes && m.registrationNo && m.ad?.placement !== "BOTTOM_STRIP");
      if (stampOwned) {
        const ours = new Set([
          "REG_UNREADABLE",
          "RERA_WEBSITE",
          "RERA_POSITION",
          "RERA_TEXT_SMALL",
          "LOCKUP_COVERS",
          "PERMIT_MISSING",
        ]);
        for (let i = problems.length - 1; i >= 0; i--) {
          if (ours.has(problems[i].code)) problems.splice(i, 1);
        }
      }
      // The pixel gate, on the finished frame. The lockup, the contact line
      // and the small print are ours on this path; the words are the
      // model's when it set them.
      const pixel = await checkFrame(flat, frameExpect(m, input.expectedQr, input.pixel.ctx, { render: true }), {
        reader: input.pixel.reader,
      });
      const px = pixelProblems(pixel, { lockup: false, copy: textByModel });
      if (stampOwned) {
        const stamped = new Set([
          "PX_QR_UNREADABLE",
          "PX_QR_TOO_SMALL",
          "PX_QR_WRONG",
          "PX_QR_NOT_AUTHORITY",
          "PX_LOCKUP_OUTSIDE",
          "PX_LOCKUP_MISPLACED",
          "PX_REG_MISSING",
          "PX_REG_MISPRINT",
          "PX_REG_WRONG",
          "PX_REG_SMALL",
          "PX_WEBSITE_MISSING",
          "PX_CONTRAST_LOW",
          "PX_CONTACT_UNREAD",
          "PX_NO_IMPRESSION",
        ]);
        problems.push(...px.filter((p) => !stamped.has(p.code)));
      } else {
        problems.push(...px);
      }
      return { frame, problems, image: drawn.bytes, attempts: no, check, picture: input.picture, pixel };
    },
  };
}

/**
 * Every line we stamp on a frame ourselves: the registration panel, the
 * contact strip and the small print. The checker reads the whole frame, so
 * these are allowed, not extra.
 */
function stampedTexts(m: Materials): string[] {
  const foot = footLines({
    phone: m.phone,
    website: m.website,
    disclaimer: m.disclaimer,
    isRender: true,
    ad: m.ad,
    promoter: m.promoter,
    officeAddress: m.officeAddress,
  });
  const reg = m.registrationNo && m.ad ? m.ad : null;
  return [
    m.registrationNo,
    reg ? `${reg.shortLabel} ${m.registrationNo}` : null,
    reg ? `${reg.label} ${m.registrationNo}` : null,
    reg && m.permitNo ? `Permit No. ${m.permitNo}` : null,
    // An exempt tower prints no registration, so the Authority's website on
    // its ad is text nobody asked for.
    reg ? reg.website : null,
    m.phone,
    foot.contact,
    foot.small,
    "Artist's impression.",
    m.disclaimer,
    smallPrintFor(m, true, null),
    m.agentNo ? agentLine(m.agentNo, m.brandName) : null,
    m.website?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null,
  ].filter((t): t is string => !!t);
}

/** Whether the design model takes any size, or only its three fixed ones. */
const EXACT_SIZES = !/^gpt-image-1/.test(DESIGN_MODEL);

/**
 * Every line the model may draw on a whole design beyond the card: the
 * registration block, the contact strip, the small print and the labels
 * around them. The design agent may quote these too.
 */
export function drawnTexts(m: Materials): string[] {
  const foot = footLines({
    phone: m.phone,
    website: m.website,
    disclaimer: m.disclaimer,
    isRender: true,
    ad: m.ad,
    promoter: m.promoter,
    officeAddress: m.officeAddress,
  });
  const host = m.website?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null;
  const reg = m.registrationNo && m.ad ? m.ad : null;
  const digitsOf = (s: string) => s.replace(/\D/g, "");
  return [
    reg ? `${reg.label} ${m.registrationNo}` : null,
    reg ? `${reg.shortLabel} ${m.registrationNo}` : null,
    reg ? reg.shortLabel : null,
    reg ? reg.label : null,
    "MahaRERA Reg. No.",
    "MahaRERA No.",
    "Reg. No.",
    "Reg.",
    "No.",
    m.registrationNo,
    reg && m.permitNo ? `Permit No. ${m.permitNo}` : null,
    reg ? reg.website : null,
    m.phone,
    ...(m.phone ? [digitsOf(m.phone), digitsOf(m.phone).slice(-10), `+91${digitsOf(m.phone).slice(-10)}`, `+91 ${digitsOf(m.phone).slice(-10)}`] : []),
    host,
    foot.contact,
    foot.small,
    "Artist's impression.",
    m.disclaimer,
    smallPrintFor(m, true, null),
    m.agentNo ? agentLine(m.agentNo, m.brandName) : null,
    ...(m.brandName ? [m.brandName] : []),
    ...(m.legalName ? [m.legalName] : []),
    ...(m.tagline ? [m.tagline] : []),
    "Apex Advisory",
    "Mandate Partners",
    "Apex Mandate Advisory LLP",
  ].filter((t): t is string => !!t);
}

/**
 * One frame designed WHOLE by the image model, the way the ChatGPT sample
 * that looked right was made: headline, registration block, contact line and
 * small print all drawn by the model, in the placement's own shape. Then the
 * QR it drew (which never scans) is found by `findQr()` and the real one is
 * pasted over it, the logo goes into the green slot it left, and the finished
 * frame is scanned and read before anybody sees it.
 *
 * The rules do not relax because the model drew the block: it must sit in
 * the upper-right quarter, the QR must be big enough to scan and must scan,
 * the number and the Authority's website must read back exactly and be at
 * least as large as the contact details. What the model drew is the model's
 * to fix. A QR that could not be found at all is asked for as a flat magenta
 * square next time, found by colour instead.
 *
 * Three kinds of drawing, and the agent chooses: a first design from the
 * photograph; a design again from the photograph, shown the attempt that
 * failed; or an EDIT of an attempt, which keeps what was right about it.
 */
function wholeDesigner(input: {
  w: number;
  h: number;
  placement: string;
  photo: { bytes: Buffer; type: string };
  /** The approved picture `photo` is. */
  picture: Picture & { key: string };
  /** What the photograph shows: the building, a space inside, or a site. */
  scene?: "exterior" | "interior" | "site";
  slide: Slide;
  cleared: readonly string[];
  neverSay: readonly string[];
  materials: Materials;
  lockupBytes: Buffer | null;
  stampBytes: Buffer | null;
  expectedQr: string | null;
  drivers: Drivers;
  references: { bytes: Buffer; type: string }[];
  templateName: string | null;
  templateKey?: string | null;
  designIndex?: number | null;
  /** The template's look in words, and the festival the post is built around. */
  style?: TemplateDirection | null;
  /** One slide of a carousel or frame of a video: which one, and of how many. */
  carousel?: { index: number; total: number; video?: boolean } | null;
  /** The face a person chose: named in the instruction, and shown as a specimen. */
  font?: FontChoice | null;
  /** What the pixel gate measures against, and its reader when a suite injects one. */
  pixel: { ctx: PixelContext | null; reader?: PixelReader };
}): SlideDesigner {
  const m = input.materials;
  const deck = input.carousel ?? null;
  const W = input.w;
  const H = input.h;
  const size = EXACT_SIZES ? designSizeExact(W, H) : designSizeFor(W, H);
  // A whole-designed frame is always an impression: the model redrew the
  // light and the building, even when the source was a construction photo.
  // Stamping and the pixel gate both follow that (same rule as stampedDesigner).
  const isRender = true;
  const foot = footLines({
    phone: m.phone,
    website: m.website,
    disclaimer: m.disclaimer,
    isRender,
    ad: m.ad,
    promoter: m.promoter,
    officeAddress: m.officeAddress,
  });
  const host = m.website?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null;
  // Small, the way developers print it, and as large as the code's own
  // modules need to scan (`qrPercentFor()`): about 9 per cent for a MahaRERA
  // project's code. The check below refuses one under six per cent.
  let qrPercent: number | null = null;
  // Two reference ads, not four: the planner reads each one, and four
  // different layouts averaged is no layout.
  const refs = input.references.slice(0, 2);
  const cleared = [...input.cleared, ...drawnTexts(m)];
  const priced = !!input.slide.facts?.prices.length;
  // A single image's registration block is ours too, set straight on the
  // picture after the drawing. Drawn by the model it came back on a white
  // card however the prompt asked (the client, 21 October 2026).
  const stampBlock = !deck && !!m.registrationNo && m.ad?.placement !== "BOTTOM_STRIP";
  let made = 0;
  // A slide that came back with the cover's building instead of its own
  // picture is never shown the cover again: the model copies what it is
  // shown, and the set matching is worth less than the right picture.
  let coverShown = true;

  return {
    made: () => made,
    async attempt(plan) {
      const small = await forModel(input.photo.bytes, 1024);
      const qrImage = input.stampBytes ? await forModel(input.stampBytes, 512) : null;
      const base = plan.base;
      const edit = plan.edit && !!base;
      // No QR to print (a state that asks for none, with none held): the
      // model is asked for none, and nothing is pasted.
      const qrMode = !input.stampBytes || stampBlock
        ? "none"
        : base?.problems.some((p) => p.code === "QR_NOT_DRAWN") || !qrImage
          ? "magenta"
          : "draw";
      const buildingChanged = base?.problems.some((p) => p.code === "BUILDING_CHANGED");
      if (buildingChanged) coverShown = false;
      const cover = coverShown ? plan.cover : null;
      const ours = base ? safeFixes(fixesFrom(base.problems), cleared) : [];
      const fixes = base ? [...ours, ...plan.notes] : [];
      qrPercent ??= qrPercentFor(input.lockupBytes ? await qrModules(input.lockupBytes) : null, W, H);
      const baseImg = base && !buildingChanged ? await forModel(base.image, 1536) : null;
      const prompt = fullDesignPrompt({
        slide: input.slide,
        placement: input.placement,
        size,
        colour: m.colour,
        fixes,
        direction: base ? [] : plan.notes,
        references: refs.length && !edit && !buildingChanged ? { count: refs.length, label: input.templateName ?? "real estate" } : null,
        registrationNo: m.registrationNo,
        ad: m.ad,
        permitNo: m.permitNo,
        phone: m.phone,
        website: host,
        smallPrint: smallPrintFor(m, priced, foot.small),
        hasLogo: !!m.logo,
        logoInk: m.logo ? (await bareMark(m.logo.bytes)).ink : null,
        qrMode,
        qrPercent,
        previous: !!baseImg && !edit,
        carousel: deck ? { index: deck.index, total: deck.total, cover: !!cover, video: deck.video } : null,
        scene: input.scene,
        edit,
        font: input.font && !edit ? { describe: input.font.describe } : null,
        style: input.style ?? null,
        // The greeting is set on the cover, or on a post of one frame.
        greeting: input.style?.festival && (!deck || deck.index === 0) ? input.style.festival.greeting : null,
        stampBlock,
      });
      const issues = checkDesignPrompt({ prompt, slide: input.slide, cleared, neverSay: input.neverSay, fixes: ours });
      if (issues.length) return { refused: issues[0], guard: true };

      const images = edit
        ? [
            await forModel(base!.image, 1536),
            input.photo,
            ...(qrMode === "draw" && qrImage ? [qrImage] : []),
            ...(cover ? [cover] : []),
          ]
        : [
            input.photo,
            ...(qrMode === "draw" && qrImage ? [qrImage] : []),
            // After the QR, where the instruction names it.
            ...(input.font ? [await specimen(input.font)] : []),
            ...(buildingChanged ? [] : refs),
            ...(cover ? [cover] : []),
            ...(baseImg ? [baseImg] : []),
          ];
      const no = ++made;
      const drawn = await input.drivers.design({ prompt, images, size }, { signal: plan.signal });
      if (!drawn.ok) return { refused: drawn.message, code: drawn.code };

      // The drawing at the placement's exact size.
      const pic = await sharp(drawn.bytes).resize(W, H, { fit: "cover", position: "centre" }).png().toBuffer();
      const layers: sharp.OverlayOptions[] = [];

      // ---- the QR: find what it drew, put the real one there -----------------
      let qrBox: Rect | null = null;
      let back = pic;
      const L = layoutFor(W, H);
      const side = input.stampBytes ? Math.max(76, qrSideFor(await qrModules(input.stampBytes), L)) : 0;
      // Carousel slides stamp the lockup themselves in one fixed place (like a
      // film), so a white panel never covers the design and the number stays
      // readable on busy construction photos. Image posts still follow the
      // model's drawn slot.
      const stampLockup = !!(deck && input.stampBytes && m.registrationNo && m.ad?.placement !== "BOTTOM_STRIP");

      if (input.stampBytes && stampLockup) {
        // Straight on the picture: no plate, no haze, no Telea wipe of the
        // stamp box (that was the grey blur). Only lift a drawn QR or magenta
        // slot. Ink follows the ground; the final gate already accepts our
        // stamp-owned pixel codes.
        const found = await findQr(pic);
        const slot = await findSlot(pic, "magenta");
        const inQuad = (box: Rect) => box.x >= W * 0.48 && box.y + box.h <= H * 0.52;
        for (const box of [found?.box, slot]) {
          if (box && inQuad(box)) back = await eraseSlot(back, box, 6);
        }

        await ensureFonts();
        const ad = m.ad ?? adRuleFor("MH");
        const tile = await qrTile(input.stampBytes, side);
        const right = L.lockup.x + L.lockup.w;
        const top = L.lockup.y;
        // Larger than the layout default: the model often sets a big phone in
        // the footnote, and REG_SMALL compares our stamp to that. Stay a clear
        // step above contact size so one stamp clears the size rule.
        const regSize = Math.max(L.regSize, Math.round(L.contactSize * 1.45));
        const colW = Math.max(regSize * 9, L.lockup.w);
        const rowGap = Math.round(regSize * 0.18);
        // Same black on every slide. Per-slide ground picking flipped some to white.
        const ink = "#111111";
        const label = ad
          ? await textImage(ad.shortLabel, { size: Math.round(regSize * 0.75), weight: "Regular", color: ink, width: colW })
          : null;
        const reg = await textImage(m.registrationNo!, { size: regSize, weight: "Bold", color: ink, width: colW });
        const permit =
          ad?.permitNo && m.permitNo
            ? await textImage(`Permit No. ${m.permitNo}`, { size: regSize, weight: "Regular", color: ink, width: colW })
            : null;
        const web = ad ? await textImage(ad.website, { size: regSize, weight: "Regular", color: ink, width: colW }) : null;
        const rows = [label, reg, permit, web].filter((r): r is TextImage => !!r);
        const textH = rows.reduce((a, r) => a + r.h, 0) + rowGap * Math.max(0, rows.length - 1);
        const textW = rows.reduce((a, r) => Math.max(a, r.w), 0);
        const rowH = Math.max(tile.h, textH);
        const qrX = right - tile.w;
        const textRight = qrX - L.lockupPad;
        const textTop = top + (rowH - textH) / 2;
        layers.push({ input: tile.buf, left: Math.round(qrX), top: Math.round(top + (rowH - tile.h) / 2) });
        let y = textTop;
        for (const r of rows) {
          layers.push({ input: r.buf, left: Math.round(textRight - r.w), top: Math.round(y) });
          y += r.h + rowGap;
        }
        qrBox = { x: Math.round(qrX), y: Math.round(top + (rowH - tile.h) / 2), w: tile.w, h: tile.h };
        // Contact must stay below registration size (REG_SMALL). Timeline + foot
        // are ours on every stamped carousel slide.
        const contactSize = Math.min(L.contactSize, Math.max(12, Math.round(regSize / 1.55)));
        const smallSize = Math.max(12, Math.round(contactSize * 0.78));
        const contactImg = foot.contact
          ? await textImage(foot.contact, { size: contactSize, weight: "Bold", color: "#ffffff", width: L.foot.w })
          : null;
        const smallImg = foot.small
          ? await textImage(foot.small, { size: smallSize, weight: "Regular", color: "#ffffff", width: L.foot.w })
          : null;
        const timeline =
          deck && !deck.video && deck.total > 1 && input.style?.continuity
            ? await renderContinuityIndicator({
                w: W,
                index: deck.index,
                total: deck.total,
                templateKey: input.templateKey,
                designIndex: input.designIndex,
                continuity: input.style.continuity,
              })
            : null;
        const gapH = smallImg && contactImg ? Math.round(contactSize * 0.35) : 0;
        const timelineGap = timeline ? Math.round(contactSize * 0.5) : 0;
        const textBlockH = (contactImg?.h ?? 0) + (smallImg?.h ?? 0) + gapH + (timeline?.h ?? 0) + timelineGap;
        const bandPad = Math.max(Math.round(L.pad * 0.75), Math.round(contactSize * 0.5));
        const bandH = Math.max(textBlockH + bandPad * 2, Math.round(H * 0.11));
        const bandY = H - bandH;
        const footSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${bandH}">
          <defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#000" stop-opacity="0"/>
            <stop offset="0.25" stop-color="#000" stop-opacity="0.75"/>
            <stop offset="0.45" stop-color="#000" stop-opacity="0.95"/>
            <stop offset="0.6" stop-color="#000" stop-opacity="1"/>
            <stop offset="1" stop-color="#000" stop-opacity="1"/>
          </linearGradient></defs>
          <rect width="${W}" height="${bandH}" fill="url(#f)"/></svg>`;
        layers.push({ input: await sharp(Buffer.from(footSvg)).png().toBuffer(), left: 0, top: bandY });
        // Timeline near the top of the foot band so the yellow marker stays clear.
        let footY = bandY + bandPad;
        if (timeline) {
          layers.push({ input: timeline.buf, left: 0, top: footY });
          footY += timeline.h + timelineGap;
        }
        if (contactImg) {
          layers.push({ input: contactImg.buf, left: L.foot.x, top: footY });
          footY += contactImg.h + gapH;
        }
        if (smallImg) {
          layers.push({ input: smallImg.buf, left: L.foot.x, top: Math.min(footY, H - bandPad - smallImg.h) });
        }
      } else if (stampBlock) {
        // A single image: the block is set as on a carousel, with no panel,
        // but its ink follows the picture (`blockShade()`), and a soft shade
        // goes behind the words only where the picture does not give the
        // contrast by itself. The footnote stays the model's.
        const found = await findQr(pic);
        const slot = await findSlot(pic, "magenta");
        for (const box of [found?.box, slot]) {
          if (box) back = await eraseSlot(back, box, 6);
        }
        await ensureFonts();
        const ad = m.ad ?? adRuleFor("MH");
        const tile = input.stampBytes ? await qrTile(input.stampBytes, side) : null;
        const right = L.lockup.x + L.lockup.w;
        const top = L.lockup.y;
        // A clear step above the model's footnote, which REG_SMALL measures.
        const regSize = Math.max(L.regSize, Math.round(L.contactSize * 1.45));
        const colW = Math.max(regSize * 9, L.lockup.w);
        const rowGap = Math.round(regSize * 0.18);
        const texts = (ink: string) =>
          Promise.all([
            ad ? textImage(ad.shortLabel, { size: Math.round(regSize * 0.75), weight: "Regular", color: ink, width: colW }) : null,
            textImage(m.registrationNo!, { size: regSize, weight: "Bold", color: ink, width: colW }),
            ad?.permitNo && m.permitNo
              ? textImage(`Permit No. ${m.permitNo}`, { size: regSize, weight: "Regular", color: ink, width: colW })
              : null,
            ad ? textImage(ad.website, { size: regSize, weight: "Regular", color: ink, width: colW }) : null,
          ]).then((rs) => rs.filter((r): r is TextImage => !!r));
        let rows = await texts("#111111");
        const textH = rows.reduce((a, r) => a + r.h, 0) + rowGap * Math.max(0, rows.length - 1);
        const textW = rows.reduce((a, r) => Math.max(a, r.w), 0);
        const rowH = Math.max(tile?.h ?? 0, textH);
        const qrX = right - (tile?.w ?? 0);
        const textRight = tile ? qrX - L.lockupPad : right;
        const textTop = top + (rowH - textH) / 2;
        const words: Box = { x: textRight - textW, y: textTop, w: textW, h: textH };
        const behind = blockShade(await pixelsUnder(back, words), false);
        const light = behind.ink === "dark";
        if (!light) rows = await texts("#ffffff");
        if (behind.alpha > 0) layers.push(await haze(words, L, light, behind.alpha));
        if (tile) {
          qrBox = { x: Math.round(qrX), y: Math.round(top + (rowH - tile.h) / 2), w: tile.w, h: tile.h };
          layers.push({ input: tile.buf, left: qrBox.x, top: qrBox.y });
        }
        let y = textTop;
        for (const r of rows) {
          layers.push({ input: r.buf, left: Math.round(textRight - r.w), top: Math.round(y) });
          y += r.h + rowGap;
        }
      } else if (input.stampBytes) {
        const margin = Math.max(8, Math.round(side * 0.12));
        const outer = side + margin * 2;
        let cx = Math.round(W - outer / 2 - W * 0.04);
        let cy = Math.round(outer / 2 + H * 0.04);
        let actualSide = side;
        const found = await findQr(pic);
        const slot = await findSlot(pic, "magenta");
        const inQuad = (box: Rect) => box.x >= W * 0.48 && box.y + box.h <= H * 0.52;
        const candidate = found?.box && inQuad(found.box) ? found.box : slot && inQuad(slot) ? slot : null;
        // A QR or square the model drew anywhere else is painted out, so the
        // ad carries one QR, ours, where the order puts it.
        for (const box of [found?.box, slot]) {
          if (box && box !== candidate) back = await eraseSlot(back, box, 6);
        }
        if (candidate) {
          const drawnSide = Math.max(candidate.w, candidate.h);
          actualSide = Math.max(drawnSide, side);
          cx = Math.min(candidate.x + candidate.w / 2 + (actualSide - drawnSide) / 2, W - outer / 2 - 2);
          cy = Math.max(outer / 2 + 2, candidate.y + candidate.h / 2);
        }
        qrBox = {
          x: Math.round(cx - actualSide / 2),
          y: Math.round(cy - actualSide / 2),
          w: actualSide,
          h: actualSide,
        };
        layers.push({
          input: await roundedPanel(outer, outer, "#ffffff", Math.round(margin * 0.8)),
          left: Math.round(cx - outer / 2),
          top: Math.round(cy - outer / 2),
        });
        layers.push({
          input: await sharp(input.stampBytes).resize(actualSide, actualSide, { fit: "fill", kernel: "nearest" }).png().toBuffer(),
          left: Math.round(cx - actualSide / 2),
          top: Math.round(cy - actualSide / 2),
        });
      }

      // ---- the logo, into the green slot it left, with nothing behind it ------
      // The slot is painted out from the design around it and the logo set on
      // what is there, in its authentic brand colours with a transparent background.
      let logoSlot: boolean | null = null;
      if (m.logo) {
        const greenSlot = await findSlot(back, "green");
        logoSlot = !!greenSlot;

        let slot: Rect;
        if (deck) {
          // Same logo place on every slide. Erase only the green slot or the
          // logo box itself: a wide upper-left wipe left a second blur patch
          // under the wordmark on construction photos.
          if (greenSlot) {
            back = await eraseSlot(back, greenSlot, 4);
          } else {
            back = await eraseSlot(
              back,
              {
                x: L.logo.x,
                y: L.logo.y,
                w: L.logo.w,
                h: L.logo.h,
              },
              4,
            );
          }
          slot = { x: L.logo.x, y: L.logo.y, w: L.logo.w, h: L.logo.h };
        } else if (greenSlot) {
          const bleed = Math.max(4, Math.round(Math.min(greenSlot.w, greenSlot.h) * 0.06));
          back = await eraseSlot(back, greenSlot, bleed);
          slot = greenSlot;
        } else {
          // If no green slot was left, inpaint any AI-drawn logo or text in the upper-left corner
          const eraseZone: Rect = {
            x: Math.round(W * 0.025),
            y: Math.round(H * 0.025),
            w: Math.round(W * 0.28),
            h: Math.round(H * 0.09),
          };
          const bleed = Math.max(4, Math.round(Math.min(L.logo.w, L.logo.h) * 0.06));
          back = await eraseSlot(back, eraseZone, bleed);
          slot = { x: L.logo.x, y: L.logo.y, w: L.logo.w, h: L.logo.h };
        }

        const mark = await bareLogo(m.logo.bytes, slot.w, slot.h * 0.9, await colourUnder(back, slot));
        layers.push({
          input: mark.buf,
          left: Math.round(slot.x + (slot.w - mark.w) / 2),
          top: Math.round(slot.y + (slot.h - mark.h) / 2),
        });
      }

      // The real QR and the logo are the overlay, not part of the picture: a
      // video lays them over the moving clip unmoved, so they stay sharp and
      // scannable whatever the video model does to the drawn ones beneath.
      const finished = await sharp(back).composite(layers).png().toBuffer();
      const frame: FrameLayers = {
        background: back,
        overlay: await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .composite(layers)
          .png()
          .toBuffer(),
        w: W,
        h: H,
      };

      // ---- the check -----------------------------------------------------------
      const pad = qrBox ? Math.round(Math.max(qrBox.w, qrBox.h) * 0.15) : 0;
      const qrRead =
        input.lockupBytes && qrBox
          ? await readQr(finished, { x: qrBox.x - pad, y: qrBox.y - pad, w: qrBox.w + pad * 2, h: qrBox.h + pad * 2 })
          : null;
      const read = await readBack(input.drivers, { frame: await forModel(finished, 2048), reference: small }, plan.signal);
      const review = read.ok ? read.review : null;
      const check: FrameCheck = {
        expected: [...slideTexts(input.slide), ...(isRender ? ["Artist's impression"] : [])],
        allowed: [...cleared, ...NEUTRAL_LABELS],
        qrRegion: qrBox ? { x: qrBox.x - pad, y: qrBox.y - pad, w: qrBox.w + pad * 2, h: qrBox.h + pad * 2 } : undefined,
        latinOnly: false,
      };
      const problems = judgeDesign({
        review,
        expected: check.expected,
        allowed: check.allowed,
        registrationNo: m.registrationNo,
        ad: m.ad,
        permitNo: m.permitNo,
        phone: m.phone,
        scene: input.scene,
        qr: { lockup: !!input.lockupBytes, expected: input.expectedQr, read: qrRead },
        full: {
          qrFound: !!qrBox,
          qrInQuadrant: !!qrBox && qrBox.x >= W * 0.48 && qrBox.y + qrBox.h <= H * 0.52,
          qrBigEnough: !!qrBox && Math.max(qrBox.w, qrBox.h) >= Math.max(60, Math.min(W, H) * 0.06),
          logoSlot,
        },
      });
      // When we stamped the lockup, registration faults are ours: the model
      // cannot redraw them, and leaving them as blockers burns every attempt
      // then give_up ("RERA copy too small and too faint"). Drop vision and
      // pixel lockup codes from the design loop. The final gatePost still
      // reads the finished files before anything is saved.
      if (stampLockup || stampBlock) {
        const ours = new Set([
          "REG_UNREADABLE",
          "RERA_WEBSITE",
          "RERA_POSITION",
          "RERA_TEXT_SMALL",
          "LOCKUP_COVERS",
          "PERMIT_MISSING",
        ]);
        for (let i = problems.length - 1; i >= 0; i--) {
          const p = problems[i];
          // On a single image our block landing on the design is the
          // design's to move: it put words or graphics in the quarter.
          if (stampBlock && p.code === "LOCKUP_COVERS") {
            problems[i] = {
              ...p,
              fix:
                "The registration block we set in the upper-right quarter sat on part of the design. Keep that quarter " +
                "calm and empty: no headline, words or graphics there.",
            };
          } else if (ours.has(p.code)) problems.splice(i, 1);
        }
      }
      const pixel = await checkFrame(
        await flatten(frame),
        frameExpect(m, input.expectedQr, input.pixel.ctx, { render: isRender }),
        { reader: input.pixel.reader },
      );
      const px = pixelProblems(pixel, { lockup: !stampLockup, copy: true });
      if (stampBlock) {
        // The block is ours and another drawing cannot fix it; the footnote
        // is still the model's, so a number set smaller than its phone is
        // the footnote's to shrink.
        const stamped = new Set([
          "PX_QR_UNREADABLE",
          "PX_QR_TOO_SMALL",
          "PX_QR_WRONG",
          "PX_QR_NOT_AUTHORITY",
          "PX_LOCKUP_OUTSIDE",
          "PX_LOCKUP_MISPLACED",
          "PX_REG_MISSING",
          "PX_REG_MISPRINT",
          "PX_REG_WRONG",
          "PX_WEBSITE_MISSING",
        ]);
        for (const p of px) {
          if (stamped.has(p.code)) continue;
          problems.push(
            p.code === "PX_REG_SMALL"
              ? { ...p, fixable: true, fix: "Set the phone number and website in the footnote smaller: they must be the smallest text in the ad." }
              : p,
          );
        }
      } else if (stampLockup) {
        // Stamp + foot scrim own these. Leaving them in problems as unfixable
        // made the agent give_up after three cover drawings on RERA size/faint.
        const stamped = new Set([
          "PX_QR_UNREADABLE",
          "PX_QR_TOO_SMALL",
          "PX_QR_WRONG",
          "PX_QR_NOT_AUTHORITY",
          "PX_LOCKUP_OUTSIDE",
          "PX_LOCKUP_MISPLACED",
          "PX_REG_MISSING",
          "PX_REG_MISPRINT",
          "PX_REG_WRONG",
          "PX_REG_SMALL",
          "PX_WEBSITE_MISSING",
          "PX_CONTRAST_LOW",
          "PX_CONTACT_UNREAD",
          "PX_NO_IMPRESSION",
        ]);
        problems.push(...px.filter((p) => !stamped.has(p.code)));
      } else {
        problems.push(...px);
      }
      return { frame, problems, image: drawn.bytes, attempts: no, check, picture: input.picture, pixel };
    },
  };
}

/**
 * A post designed by the image model, then a clip for a video. Frames run two
 * at a time; more than that meets the provider's rate limit on an ordinary
 * account.
 *
 * An image, and every slide of a carousel, in a Latin-script language is
 * designed whole (`wholeDesigner()`); the rest go through `stampedDesigner()`.
 * Which drawing is asked for next, and when a slide is done, is the art
 * director's (`artDirect()`): it makes the cover first, matches every later
 * slide to it (slides designed apart come back as five different ads), looks
 * at each attempt and edits or redraws it, within `MAX_DESIGN_ATTEMPTS` a slide.
 */
export async function designPost(input: {
  kind: PostKind;
  placement: string;
  copy: { headline: string; body: string; cta: string };
  talkingPoints: readonly string[];
  neverSay: readonly string[];
  materials: Materials;
  seed: number;
  drivers?: Partial<Drivers>;
  /** The template category the post follows: its designs, or a video's poster stills, as style. */
  template?: TemplateChoice | null;
  /** The festival a festive template builds the post around. */
  festival?: Festival | null;
  /** How many slides a carousel has. Without one, a cover, up to three points and a close. */
  slides?: number;
  /** Where the project is and what it starts at, printed on the cover. */
  facts?: AdFacts | null;
  /** A twenty crore project leads on the road, everything else on the station. */
  luxury?: boolean;
  /** A face from `font-rules.ts`, or nothing for the design's own. */
  font?: string | null;
  /** What the pixel gate measures prices and the registration's life against. */
  pixel?: PixelContext | null;
  signal?: AbortSignal;
  /** Told of every step the art director takes. */
  onAgentStep?: (step: AgentStep) => void;
}): Promise<
  | {
      ok: true;
      files: { bytes: Buffer; type: string; w: number; h: number }[];
      inputs: PostInputs;
      review: PostReview;
      /** The pixel gate's verdict on the files, or null when there are none (a video whose frames failed). */
      pixel: PixelRecord | null;
    }
  | { ok: false; message: string; code?: string }
> {
  const size = PLACEMENT_SIZE[input.placement];
  if (!size) return { ok: false, message: `${input.placement} is not a size posts are made in.` };
  // A festival greeting wishes and does not sell: no price line on it, and
  // so no price footnote. The location line stays.
  if (input.facts?.prices.length && input.template && templateAngle(input.kind, input.template.key) === "GREETING") {
    input = { ...input, facts: { ...input.facts, prices: [] } };
  }
  const m = input.materials;
  const drivers: Drivers = {
    design: input.drivers?.design ?? designAd,
    review: input.drivers?.review ?? reviewDesign,
  };

  const template = input.template ?? null;
  const templateKind = input.kind;
  const prefer = template ? templatePhotos(template.key, templateKind) : null;
  const isConstruction =
    !!prefer?.includes("CONSTRUCTION") ||
    template?.key === "07-construction-timeline" ||
    template?.key === "08-site-progress-report" ||
    template?.key === "10-construction-update" ||
    input.talkingPoints.some((p) =>
      /\b(slab|rcc|construction|foundation|structural|earthquake|seismic|plinth|piling)\b/i.test(p),
    );

  const rankedPoints = sellingPoints(input.talkingPoints, {
    luxury: !!input.luxury,
    construction: isConstruction,
  });

  // If ranked points are fewer than the carousel needs, fill remaining slots from approved talking points
  const points = [...rankedPoints];
  const needed = (input.kind === "CAROUSEL" ? input.slides ?? DEFAULT_SLIDES : DEFAULT_SLIDES) - 2;
  for (const raw of input.talkingPoints) {
    if (points.length >= needed) break;
    const t = raw.trim();
    if (t && !points.includes(t)) {
      points.push(t);
    }
  }

  const slideKind: PostKind = input.kind === "VIDEO" ? "CAROUSEL" : input.kind;
  const slides = slidesFor(
    input.copy,
    points,
    slideKind,
    input.kind === "CAROUSEL" ? input.slides : input.kind === "VIDEO" ? VIDEO_SHOTS : undefined,
    factsBeside(input.facts, input.copy),
  );
  // Resolve the template's picture pool before picking: a construction
  // update must open on a site photo, not a finished exterior render.
  const pool = prefer?.length
    ? (backgroundsFrom([...m.site, ...m.backgrounds], prefer) as (Picture & { key: string })[])
    : (m.backgrounds.length ? m.backgrounds : m.site);
  const pictures = picturesFor(pool, slides.length, input.seed, prefer) as (Picture & { key: string })[];
  if (!pictures.length) return { ok: false, message: "There is no approved picture to design from." };

  const lockupBytes = m.lockup ? await readAsset(m.lockup.key) : null;
  const expectedQr = lockupBytes ? await readQr(lockupBytes) : null;
  const stampBytes = lockupBytes && expectedQr ? await qrOnly(lockupBytes) : lockupBytes;
  const templateName = template ? templateLabel(template.key, templateKind) : null;
  const cleared = [
    input.copy.headline,
    input.copy.body,
    input.copy.cta,
    ...input.talkingPoints,
    ...slides.flatMap(slideTexts),
    ...(templateName ? [templateName] : []),
    "Construction Timeline",
    "Construction",
    "Timeline",
    "Milestone",
    "Progress Update",
    "Site Update",
    ...(input.facts?.location ? [input.facts.location] : []),
    ...(input.facts?.prices ?? []),
    // Carousel slide and milestone numbers
    ...Array.from({ length: 10 }, (_, i) => [
      String(i + 1),
      `0${i + 1}`,
      `Slide ${i + 1}`,
      `Slide ${i + 1} of ${slides.length}`,
      `${i + 1} of ${slides.length}`,
      `Milestone ${i + 1}`,
      `Step ${i + 1}`,
      `Phase ${i + 1}`,
      `Progress ${i + 1}`,
    ]).flat(),
    // Brand details
    ...(m.brandName ? [m.brandName] : []),
    ...(m.legalName ? [m.legalName] : []),
    ...(m.tagline ? [m.tagline] : []),
    "Apex Advisory",
    "Mandate Partners",
    "Apex Mandate Advisory LLP",
  ].filter(Boolean);
  // Designed whole unless a slide's words are in a script the model cannot
  // shape; then every slide is laid out, so a carousel stays one set.
  const whole = slides.every((s) => modelSetsText(slideTexts(s)));

  // An image follows its category's designs; a carousel follows ONE design
  // of its category page for page, the design rotating with the version; a
  // video's frames follow its category's poster stills, and the motion is ours.
  const references =
    template && input.kind !== "CAROUSEL" ? await templateReferences(template.key, input.kind) : [];
  const deckRefs =
    template && input.kind === "CAROUSEL" ? await carouselReferences(template.key, input.seed, slides.length) : null;
  const refsFor = (i: number) => (deckRefs ? (deckRefs.pages[i] ? [deckRefs.pages[i]!] : []) : references);
  // The category's look in words, and the festival, which a design set
  // whole may greet in small type: the greeting is then a cleared line.
  const style = template ? templateDirection(template.key, templateKind, input.festival ?? null) : null;
  if (style?.festival && whole) cleared.push(style.festival.greeting);

  // Every approved background the art director may draw from: the ones the
  // rotation gave these slides first, then the rest of this template's pool,
  // up to a dozen.
  const candidates = [...new Map([...pictures, ...pool].map((p) => [p.assetId, p as Picture & { key: string }])).values()].slice(
    0,
    Math.max(12, new Set(pictures.map((p) => p.assetId)).size),
  );
  const assigned = pictures.map((p) => candidates.findIndex((c) => c.assetId === p.assetId));
  const photos: { bytes: Buffer; type: string }[] = [];
  for (const p of candidates) {
    const b = await readAsset(p.key);
    if (!b) return { ok: false, message: "An approved picture could not be read." };
    photos.push(await forModel(b, 1536));
  }

  const deck = input.kind !== "IMAGE" && slides.length > 1;
  const pixel = { ctx: input.pixel ?? null, reader: input.drivers?.pixel };
  const designerFor = async (i: number, photo: number): Promise<SlideDesigner> => {
    const picture = candidates[photo];
    return whole
      ? wholeDesigner({
          w: size.w,
          h: size.h,
          placement: input.placement,
          photo: photos[photo],
          picture,
          scene: sceneOf(picture.category),
          slide: slides[i],
          cleared,
          neverSay: input.neverSay,
          materials: m,
          lockupBytes,
          stampBytes,
          expectedQr,
          drivers,
          references: refsFor(i),
          templateName,
          templateKey: template?.key ?? null,
          designIndex: input.template?.design ?? deckRefs?.design ?? (input.seed % 4),
          style,
          carousel: deck ? { index: i, total: slides.length, video: input.kind === "VIDEO" } : null,
          font: fontFor(input.font),
          pixel,
        })
      : stampedDesigner({
          w: size.w,
          h: size.h,
          placement: input.placement,
          photo: photos[photo],
          picture,
          isRender: picture.isRender,
          slide: slides[i],
          cleared,
          neverSay: input.neverSay,
          materials: m,
          lockupBytes,
          stampBytes,
          expectedQr,
          drivers,
          references: refsFor(i),
          templateName,
          style,
          font: fontFor(input.font),
          pixel,
        });
  };

  // The art director draws, looks, and asks again, slide by slide, until
  // every slide is one it would publish or the drawings run out.
  const art = await artDirect({
    kind: input.kind,
    placement: input.placement,
    w: size.w,
    h: size.h,
    slides,
    whole,
    photos: await Promise.all(
      candidates.map(async (p, i) => ({ category: p.category, title: p.title, preview: await forModel(photos[i].bytes, 512) })),
    ),
    assigned,
    designerFor,
    references: deckRefs ? deckRefs.pages.filter((x): x is { bytes: Buffer; type: string } => !!x).slice(0, 4) : references.slice(0, 2),
    templateName,
    style,
    quotable: [
      ...new Set([
        ...slides.flatMap(slideTexts),
        ...(whole ? drawnTexts(m) : []),
        ...(whole && style?.festival ? [style.festival.greeting] : []),
      ]),
    ],
    neverSay: input.neverSay,
    registered: !!m.registrationNo,
    strip: !!m.registrationNo && m.ad?.placement === "BOTTOM_STRIP",
    preview: async (f) => forModel(await flatten(f.frame), 1024),
    brain: input.drivers?.brain,
    signal: input.signal,
    onStep: input.onAgentStep,
  });
  if (art.failure) return { ok: false, message: art.failure.message, code: art.failure.code };
  const done = art.frames as DesignedFrame[];

  // One list for the post. On a carousel a problem names its slide, once.
  const problems = new Map<string, { code: string; text: string; soft?: boolean }>();
  let blocking = 0;
  done.forEach((d, i) => {
    for (const p of d.problems) {
      const where = done.length > 1 && p.fixable ? ` (slide ${i + 1})` : "";
      const key = p.fixable ? `${p.code}${where}` : p.code;
      if (!problems.has(key)) problems.set(key, { code: p.code, text: `${p.text}${where}`, soft: p.soft });
      if (!p.soft) blocking++;
    }
  });
  const review: PostReview = {
    // A soft problem (no slot for the logo) is shown, and does not fail the post.
    passed: blocking === 0,
    attempts: art.drawings,
    problems: [...problems.values()],
    model: DESIGN_MODEL,
    agent: { model: art.agent.model, turns: art.agent.turns, usd: art.agent.usd },
  };

  const inputs: PostInputs = {
    // The pictures the kept frames were drawn from, which is what every pixel
    // traces to, whatever the rotation offered first.
    pictures: [...new Map(done.map((d) => [d.picture.assetId, { assetId: d.picture.assetId, sha256: d.picture.sha256 }])).values()],
    lockup: m.lockup ? { assetId: m.lockup.assetId, sha256: m.lockup.sha256 } : null,
    logo: m.logo ? { role: m.logo.role, fileId: m.logo.fileId, at: m.logo.at } : null,
    registrationNo: m.registrationNo,
    agentNo: m.agentNo ?? null,
    template:
      template && deckRefs?.pages.some(Boolean)
        ? { ...template, design: deckRefs.design }
        : template && references.length
          ? template
          : null,
    facts: input.facts ?? null,
    font: fontFor(input.font)?.key ?? null,
    festival: style?.festival?.key ?? null,
  };

  const frames = done.map((d) => d.frame);
  if (input.kind === "VIDEO") {
    // Frames that did not pass are never brought to life: the clip would be
    // paid for and thrown away.
    if (!review.passed) return { ok: true, files: [], inputs, review, pixel: null };
    const shots = await Promise.all(
      done.map((d) =>
        animateShot({
          shot: d,
          scene: sceneOf(d.picture.category) === "interior" ? "interior" : "exterior",
          reference: photos[candidates.findIndex((c) => c.assetId === d.picture.assetId)] ?? photos[0],
          animate: input.drivers?.animate ?? animateFrame,
          drivers,
          materials: m,
          lockupBytes,
          expectedQr,
          expect: frameExpect(m, expectedQr, pixel.ctx, { render: true }),
          reader: pixel.reader,
          signal: input.signal,
        }),
      ),
    );
    const refusedShot = shots.find((r): r is Refused => "refused" in r);
    if (refusedShot) return { ok: false, message: refusedShot.refused, code: refusedShot.code };
    const made = shots as Shot[];
    const drift = made.flatMap((s, i) => s.problems.map((p) => ({ code: p.code, text: `${p.text} (frame ${i + 1})` })));
    const motionReview: PostReview = {
      ...review,
      passed: drift.length === 0,
      problems: [...review.problems, ...drift],
      motion: { model: VIDEO_MODEL, attempts: made.reduce((n, s) => n + s.attempts, 0) },
    };
    if (drift.length) return { ok: true, files: [], inputs, review: motionReview, pixel: null };
    const files = [{ bytes: await joinShots(made.map((s) => s.clip)), type: "video/mp4", w: size.w, h: size.h }];
    // The finished video, read at the first, middle and last of every shot.
    const record = await gatePost({
      files,
      expect: () => frameExpect(m, expectedQr, pixel.ctx, { render: true }),
      times: () => sampleTimes(made.map((_, i) => ({ start: i * SHOT_SECONDS, end: (i + 1) * SHOT_SECONDS }))),
      registrationNo: m.registrationNo,
      reader: pixel.reader,
    });
    return { ok: true, files, inputs, review: motionReview, pixel: record };
  }
  const files = [];
  for (const f of frames) files.push({ bytes: await flatten(f), type: "image/jpeg", w: size.w, h: size.h });
  // Designed frames are impressions. Carousel stamps own lockup + foot: the
  // design loop already ignores stamp-owned pixel codes (another drawing cannot
  // fix them). Apply the same rule at the final gate so we stop failing a
  // post for the stamp we just laid down.
  let record = await gatePost({
    files,
    expect: () => frameExpect(m, expectedQr, pixel.ctx, { render: true }),
    registrationNo: m.registrationNo,
    reader: pixel.reader,
  });
  // Latin carousels stamp in wholeDesigner; Hindi ones stamp in renderFrame.
  // Either way the lockup is ours, so stamp-owned pixel codes must not fail
  // the finished set (that was burning Hindi construction carousels).
  if (deck && stampBytes && m.registrationNo && m.ad?.placement !== "BOTTOM_STRIP") {
    record = acceptCarouselStamp(record);
  }
  return { ok: true, files, inputs, review, pixel: record };
}

/** Pixel codes our carousel stamp owns. Dropping them at the final gate matches the design loop. */
const CAROUSEL_STAMP_PIXEL = new Set([
  "QR_UNREADABLE",
  "QR_TOO_SMALL",
  "QR_WRONG",
  "QR_NOT_AUTHORITY",
  "LOCKUP_OUTSIDE",
  "LOCKUP_MISPLACED",
  "REG_MISSING",
  "REG_MISPRINT",
  "REG_WRONG",
  "REG_SMALL",
  "WEBSITE_MISSING",
  "CONTRAST_LOW",
  "CONTACT_UNREAD",
  "NO_IMPRESSION",
]);

function acceptCarouselStamp(record: PixelRecord): PixelRecord {
  const kept = record.findings.filter((f) => !CAROUSEL_STAMP_PIXEL.has(f.code));
  if (kept.length === record.findings.length) return record;
  const byFile = new Map<number, PixelFinding[]>();
  for (const f of kept) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  return pixelRecord({
    engine: record.engine,
    now: new Date(record.checkedAt),
    registrationNo: record.registrationNo,
    files: record.files.map((file, i) => ({
      sha256: file.sha256,
      frames: [{ findings: byFile.get(i) ?? [] }],
    })),
  });
}

// ---------------------------------------------------------------------------
// The studio's posts
// ---------------------------------------------------------------------------

export type RenderedPost = {
  id: string;
  kind: PostKind;
  placement: string;
  language: string;
  segment: string;
  headline: string;
  media: MediaItem[];
  /** What the check found. Null for a post laid out without the image model. */
  review: PostReview | null;
  /** The template category it followed, and who chose it. */
  template: TemplateChoice | null;
  /** "story" for a story reel; null for a post made from a template. */
  format: string | null;
  /** A film made in one generation: what it counts as, and whether it is a new version of another. */
  film: { units: number; revision: boolean } | null;
  /**
   * The pixel gate's verdict on the files, and what it found, in the
   * client's words. Null for a post made before the gate, which never
   * publishes until it is made again.
   */
  pixel: { verdict: "PASS" | "FAIL" | "HOLD"; lines: string[] } | null;
  createdAt: string;
};

export async function listPosts(orgId: string, briefId: string): Promise<RenderedPost[]> {
  if (!isNodeId(briefId)) return [];
  const rows = await withTenant(orgId, async (sql) =>
    sql<
      {
        id: string;
        kind: PostKind;
        placement: string;
        language: string;
        segment: string;
        headline: string;
        media: MediaItem[];
        review: PostReview | null;
        template: TemplateChoice | null;
        format: string | null;
        film_units: number | null;
        revision_of: string | null;
        pixel: PixelRecord | null;
        created_at: Date;
      }[]
    >`
      SELECT id, kind, placement, language, segment, headline, media, review, pixel,
             inputs->'template' AS template, inputs->>'format' AS format,
             (inputs->'film'->>'units')::int AS film_units, inputs->'film'->>'revisionOf' AS revision_of, created_at
      FROM rendered_posts WHERE org_id = ${orgId} AND brief_id = ${briefId}
        -- A post that did not pass is never shown. None is saved any more;
        -- this keeps the ones saved before that rule out of sight. A film is
        -- the exception: it was paid for whole, so it is shown with what its
        -- checks found and never published until it passes.
        AND (review IS NULL OR (review->>'passed')::boolean OR inputs ? 'film')
      ORDER BY created_at DESC, placement
      LIMIT 60`,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    placement: r.placement,
    language: r.language,
    segment: r.segment,
    headline: r.headline,
    media: r.media ?? [],
    review: r.review ?? null,
    template: r.template ?? null,
    format: r.format ?? null,
    film: r.film_units !== null ? { units: r.film_units, revision: !!r.revision_of } : null,
    pixel: r.pixel ? { verdict: r.pixel.verdict, lines: pixelSummary(r.pixel).lines } : null,
    createdAt: r.created_at.toISOString(),
  }));
}

export type MakeOutcome =
  | { ok: true; made: number; skipped: string[] }
  | { ok: false; code: string; message: string };

/**
 * Make posts of one kind from the cleared cards.
 *
 * Cleared only. A card on hold or blocked has not been cleared to say what it
 * says, and laying it over a picture does not change that; it only makes it
 * look finished. `copyIds` narrows the cards; empty means every cleared one.
 *
 * Posts are made one after another rather than all at once: the compositor
 * is CPU-bound and a video is seconds of FFmpeg, so running twenty in
 * parallel makes each slower and the machine unusable for everybody else.
 */
export async function makePosts(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  kind: PostKind;
  copyIds?: readonly string[];
  /** The pixel gate's reader, for a suite. */
  reader?: PixelReader;
}): Promise<MakeOutcome> {
  if (!isNodeId(opts.briefId)) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That campaign is not in this organisation." };
  }
  const head = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<{ formats: string[]; node_id: string; path: string; kind: string }[]>`
      SELECT b.formats, n.id AS node_id, n.path::text AS path, n.kind
      FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${opts.orgId} AND b.id = ${opts.briefId}`;
    return row ?? null;
  });
  if (!head) {
    return { ok: false, code: "BRIEF_UNKNOWN", message: "That campaign is not in this organisation." };
  }

  const placements = placementsFor(opts.kind, head.formats ?? []);
  if (!placements.length) {
    return {
      ok: false,
      code: "NO_PLACEMENT",
      message: `None of this brief's formats takes a ${kindDef(opts.kind).label.toLowerCase()}.`,
    };
  }

  const wanted = (opts.copyIds ?? []).filter(isNodeId);
  const cards = await withTenant(opts.orgId, async (sql) =>
    sql<{ id: string; language: string; segment: string; headline: string; body: string; cta: string }[]>`
      SELECT id, language, segment, headline, body, cta FROM campaign_copy
      WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId} AND verdict = 'PASS'
        AND language IN (SELECT unnest(cb.languages) FROM campaign_briefs cb WHERE cb.id = campaign_copy.brief_id)
        AND language = ANY(${[...LANGUAGES]}::text[])
        ${wanted.length ? sql`AND id = ANY(${wanted})` : sql``}
      ORDER BY language, segment`,
  );
  if (!cards.length) {
    return { ok: false, code: "NOTHING_CLEARED", message: "No cleared card to make a post from yet." };
  }

  const node = { id: head.node_id, path: head.path, kind: head.kind };
  // The RERA gate first, fresh. A post is an advertisement, and a phase that
  // stopped being advertisable since its copy cleared has nothing lawful to
  // be put on a picture.
  const { ground } = await studioGround(opts.orgId, node);
  if (!ground.advertisable) {
    return {
      ok: false,
      code: "NOT_ADVERTISABLE",
      message: "This cannot be advertised today, so no post can be made.",
    };
  }
  const materials = await loadMaterials(opts.orgId, node);
  if (!materials.backgrounds.length) {
    return {
      ok: false,
      code: "NO_PICTURE",
      message: "There is no approved exterior, amenity or room picture to put the copy on.",
    };
  }
  // Rotation starts after the posts already made, so the next batch opens on
  // different pictures from the last one.
  const [{ n: already }] = await withTenant(opts.orgId, async (sql) =>
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rendered_posts
      WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId}`,
  );

  const lockupBytes = materials.lockup ? await readAsset(materials.lockup.key) : null;
  const expectedQr = lockupBytes ? await readQr(lockupBytes) : null;
  const ctx = pixelContext(ground);

  let made = 0;
  const skipped: string[] = [];
  let seed = already;
  for (const card of cards) {
    for (const placement of placements) {
      seed += 1;
      const postId = randomUUID();
      try {
        const { files, inputs, checks, spans } = await composePost({
          kind: opts.kind,
          placement,
          copy: card,
          talkingPoints: ground.talkingPoints,
          materials,
          seed,
        });
        // The pixel gate, on the files as they will be stored. A FAIL is not
        // saved; the compositor placed everything, so another try would
        // place it the same way.
        const pixel = await gatePost({
          files,
          expect: (i) => frameExpect(materials, expectedQr, ctx, { render: checks[i]?.render ?? true }),
          times: () => sampleTimes(spans),
          region: (i) => checks[i]?.region ?? null,
          registrationNo: materials.registrationNo,
          reader: opts.reader,
        });
        if (pixel.verdict === "FAIL") {
          console.warn(`compose: ${opts.kind} ${placement} failed the pixel gate,`, pixel.findings.map((f) => f.code).join(", "));
          skipped.push(`${card.language} ${placement}`);
          continue;
        }
        const stored = await storePostFiles(opts.orgId, node.id, postId, files);
        if (!stored) {
          skipped.push(`${card.language} ${placement}`);
          continue;
        }
        const media = withHashes(stored, pixel);
        await withTenant(opts.orgId, async (sql) => {
          await sql`
            INSERT INTO rendered_posts (id, org_id, brief_id, scope_node_id, copy_id, kind,
                                        placement, language, segment, headline, body, cta,
                                        media, inputs, pixel, created_by)
            VALUES (${postId}, ${opts.orgId}, ${opts.briefId}, ${node.id}, ${card.id},
                    ${opts.kind}, ${placement}, ${card.language}, ${card.segment},
                    ${card.headline}, ${card.body}, ${card.cta},
                    ${sql.json(media as unknown as JSONValue)},
                    ${sql.json(inputs as unknown as JSONValue)},
                    ${sql.json(pixel as unknown as JSONValue)}, ${opts.actorUserId})`;
        });
        await auditPixel({ orgId: opts.orgId, actorUserId: opts.actorUserId, targetType: "rendered_post", targetId: postId, record: pixel });
        made += 1;
      } catch (e) {
        // The reason, never the words: a render that failed for memory or a
        // missing file was otherwise invisible.
        console.warn(`compose: ${opts.kind} ${placement} not made,`, (e instanceof Error ? e.message : String(e)).slice(-400));
        skipped.push(`${card.language} ${placement}`);
      }
    }
  }

  // Counts only. The words are the developer's and stay out of the log.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "creative.posts_made",
    targetType: "campaign_brief",
    targetId: opts.briefId,
    metadata: { kind: opts.kind, made, skipped: skipped.length, placements: placements.length },
  });

  if (!made) {
    return { ok: false, code: "NOTHING_MADE", message: "No post could be made. Try again in a moment." };
  }
  return { ok: true, made, skipped };
}

/** One stored file of one post, for the route that serves it. */
/**
 * Every file of one made post, in order, with what it is: the slides of a
 * carousel for the one download that hands over the whole set. Read through
 * `withTenant()`, so another organisation's post resolves to nothing.
 */
export async function postFiles(
  orgId: string,
  postId: string,
): Promise<{ kind: PostKind; placement: string | null; files: { bytes: Buffer; type: string }[] } | null> {
  if (!isNodeId(postId)) return null;
  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ kind: PostKind; placement: string | null; media: MediaItem[] }[]>`
      SELECT kind, placement, media FROM rendered_posts WHERE org_id = ${orgId} AND id = ${postId}`;
    return r ?? null;
  });
  if (!row?.media?.length) return null;
  const files: { bytes: Buffer; type: string }[] = [];
  for (const m of row.media) {
    const bytes = await readAsset(m.key);
    if (!bytes) return null;
    files.push({ bytes, type: m.type });
  }
  return { kind: row.kind, placement: row.placement, files };
}

export async function postMedia(
  orgId: string,
  postId: string,
  index: number,
): Promise<{ url: string; key: string; type: string } | null> {
  if (!isNodeId(postId) || !Number.isInteger(index) || index < 0) return null;
  const row = await withTenant(orgId, async (sql) => {
    const [r] = await sql<{ media: MediaItem[] }[]>`
      SELECT media FROM rendered_posts WHERE org_id = ${orgId} AND id = ${postId}`;
    return r ?? null;
  });
  const item = row?.media?.[index];
  if (!item) return null;
  const link = await assetUrl(item.key, item.type);
  if (!link.ok) return null;
  return { url: link.url, key: item.key, type: item.type };
}

export async function removePost(opts: {
  orgId: string;
  actorUserId: string;
  postId: string;
}): Promise<{ ok: boolean }> {
  if (!isNodeId(opts.postId)) return { ok: false };
  const media = await withTenant(opts.orgId, async (sql) => {
    const [r] = await sql<{ media: MediaItem[]; raw: string | null; original: string | null }[]>`
      DELETE FROM rendered_posts WHERE org_id = ${opts.orgId} AND id = ${opts.postId}
      RETURNING media, inputs->'film'->>'raw' AS raw, inputs->'film'->>'original' AS original`;
    if (!r) return null;
    // A post that went out shares its files with the publication's frozen
    // record, which outlives the post by design. Those files stay; the
    // publication is now the row that points at them.
    const keys = (r.media ?? []).map((m) => m.key);
    const kept = keys.length
      ? await sql<{ k: string }[]>`
          SELECT DISTINCT m->>'key' AS k
          FROM publish_targets, jsonb_array_elements(CASE WHEN jsonb_typeof(media) = 'array' THEN media ELSE '[]'::jsonb END) m
          WHERE org_id = ${opts.orgId} AND m->>'key' = ANY(${keys})`
      : [];
    const keep = new Set(kept.map((x) => x.k));
    return { items: (r.media ?? []).filter((m) => !keep.has(m.key)), raw: r.raw, original: r.original };
  });
  if (!media) return { ok: false };
  // Row first, bytes second: the other order can leave a row pointing at
  // bytes that are gone, which reads as a broken post forever. A film's own
  // unstamped copy, kept for a new version, goes with it.
  for (const m of media.items) await removeAsset(m.key);
  if (media.raw) await removeAsset(media.raw);
  if (media.original) await removeAsset(media.original);
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "creative.post_removed",
    targetType: "rendered_post",
    targetId: opts.postId,
    metadata: {},
  });
  return { ok: true };
}

/**
 * Make one post: one card, in one size, as the next version.
 *
 * The screen calls this once per post rather than asking for twenty at once,
 * so each placeholder can be replaced the moment its post exists and a Stop
 * can land between two of them. Every rule `makePosts()` applies is applied
 * here on every call, fresh: the RERA gate, the card still being cleared,
 * and the size being one this kind is made for and the brief asked for.
 *
 * The version is not stored and not needed: pictures rotate on the number of
 * posts the brief already has, so the next call is the next version.
 */
export async function makeOnePost(opts: {
  orgId: string;
  actorUserId: string;
  briefId: string;
  kind: PostKind;
  copyId: string;
  placement: string;
  /** A template category key, or "auto" / nothing to have one chosen. */
  template?: string | null;
  /** How many slides a carousel has, from `MIN_SLIDES` to `MAX_SLIDES`. */
  slides?: number;
  /** A face from `font-rules.ts`; anything else is the design's own. */
  font?: string | null;
  /** The festival a festive template is built around, by key. */
  festival?: string | null;
  drivers?: Partial<Drivers>;
  signal?: AbortSignal;
}): Promise<{ ok: true; postId: string; passed: boolean } | { ok: false; code: string; message: string }> {
  if (!isNodeId(opts.briefId) || !isNodeId(opts.copyId)) {
    return { ok: false, code: "UNKNOWN", message: "That card is not in this campaign." };
  }
  // Every video is one Seedance film since 5 October 2026 (the client), made
  // by the worker (`enqueueReel()`); the three frames brought to life by Kling
  // clips are no longer made. Refused before anything is paid for.
  if (opts.kind === "VIDEO") {
    return { ok: false, code: "FILM_TEMPLATE", message: "A video is made as one film. Reload the page and make it again." };
  }
  const head = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<
      {
        formats: string[];
        node_id: string;
        path: string;
        kind: string;
        name: string | null;
        objective: string | null;
        hook: string | null;
        offers: string | null;
        unit_type_ids: string[] | null;
      }[]
    >`
      SELECT b.formats, n.id AS node_id, n.path::text AS path, n.kind, b.name, b.objective, b.hook, b.offers, b.unit_type_ids
      FROM campaign_briefs b JOIN scope_nodes n ON n.id = b.scope_node_id
      WHERE b.org_id = ${opts.orgId} AND b.id = ${opts.briefId}`;
    return row ?? null;
  });
  if (!head) return { ok: false, code: "BRIEF_UNKNOWN", message: "That campaign is not in this organisation." };
  if (!placementsFor(opts.kind, head.formats ?? []).includes(opts.placement)) {
    return { ok: false, code: "NO_PLACEMENT", message: `${opts.placement} is not a size this post is made in.` };
  }
  // A template is drawn in its own shapes only: a banner is never asked of
  // a feed post, nor a square design as a banner. Refused before anything
  // is paid for.
  if (opts.template && isDesignTemplate(currentTemplateKey(opts.template), opts.kind) && !templateFits(opts.template, opts.kind, opts.placement)) {
    return {
      ok: false,
      code: "TEMPLATE_SIZE",
      message: `The ${templateLabel(opts.template, opts.kind)} template is not made for ${opts.placement}.`,
    };
  }
  // A festival named that nobody knows is refused rather than quietly dropped,
  // and a festive template picked with no festival, chosen or in the
  // campaign's name, is asked for one before anything is paid.
  if (opts.festival && !festivalByKey(opts.festival)) {
    return { ok: false, code: "FESTIVAL_UNKNOWN", message: "Choose a festival from the list." };
  }
  if (
    opts.template &&
    festivalAsk(opts.template, opts.kind) === "required" &&
    !opts.festival &&
    !festivalIn([head.name, head.hook, head.offers].filter(Boolean).join(" "))
  ) {
    return { ok: false, code: "NO_FESTIVAL", message: `Choose the festival for the ${templateLabel(opts.template, opts.kind)} template.` };
  }

  // The stored verdict may predate a stricter gate: measure the cards again
  // first (a stricter answer is saved), so a card cleared under the old rules
  // is not drawn and paid for.
  const { regateBrief } = await import("./creative.ts");
  await regateBrief(opts.orgId, opts.briefId);
  const card = await withTenant(opts.orgId, async (sql) => {
    const [row] = await sql<
      { id: string; language: string; segment: string; angle: string | null; headline: string; body: string; cta: string; local: unknown }[]
    >`
      SELECT id, language, segment, angle, headline, body, cta, local FROM campaign_copy
      WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId} AND id = ${opts.copyId}
        AND verdict = 'PASS'
        AND language IN (SELECT unnest(cb.languages) FROM campaign_briefs cb WHERE cb.id = campaign_copy.brief_id)
        AND language = ANY(${[...LANGUAGES]}::text[])`;
    return row ?? null;
  });
  if (!card) return { ok: false, code: "NOT_CLEARED", message: "That card is no longer cleared." };

  const node = { id: head.node_id, path: head.path, kind: head.kind };
  // The configurations the brief is for, so the price printed is theirs.
  const { ground } = await studioGround(opts.orgId, node, new Date(), head.unit_type_ids ?? []);
  if (!ground.advertisable) {
    return { ok: false, code: "NOT_ADVERTISABLE", message: "This cannot be advertised today, so no post can be made." };
  }
  // Refused before a model is paid: every ad names the exact locality.
  if (!ground.location) return { ok: false, code: "NO_LOCATION", message: NO_LOCATION_MESSAGE };
  const materials = await loadMaterials(opts.orgId, node);
  if (!materials.backgrounds.length && !materials.site.length) {
    return { ok: false, code: "NO_PICTURE", message: "There is no approved exterior, amenity, room or construction picture to use." };
  }
  // Refused before a drawing is paid for: without the approved QR a state
  // asks for, or Telangana's permit number, no post can pass its check,
  // however many times it is drawn. Only where there is a registration: an
  // exempt tower's ad carries no registration block at all.
  const gap = registrationGap(materials);
  if (gap) return { ok: false, ...gap };
  // The card and the template have to suit each other, and the project has
  // to hold what the template shows (an offer, a dated site photo, a price).
  // A person's pick is refused with the reason; "Let AI choose" chooses only
  // among the templates that fit. Both before anything is paid for.
  const material = await materialFor(opts.orgId, node.id, ground, head.offers);
  const facts: CardFacts = {
    angle: isCardAngle(card.angle) ? card.angle : "GENERAL",
    segment: card.segment,
    lead: cardLead(card, ground),
    invites: invitesVisit(card.cta),
  };
  const fitsHere = (key: string) => !templateGap(opts.kind, key, material) && cardFits(facts, templateAngle(opts.kind, key), key);
  const pickedKey = opts.template && opts.template !== "auto" ? currentTemplateKey(opts.template) : null;
  if (pickedKey && isDesignTemplate(pickedKey, opts.kind)) {
    const label = templateLabel(pickedKey, opts.kind);
    const lacks = templateGap(opts.kind, pickedKey, material);
    if (lacks) return { ok: false, code: "TEMPLATE_NEEDS", message: `The ${label} template: ${lacks}.` };
    if (!cardFits(facts, templateAngle(opts.kind, pickedKey), pickedKey)) {
      return {
        ok: false,
        code: "TEMPLATE_CARD",
        message: `This card is written for ${angleLabel(facts.angle).toLowerCase()} ads. Pick a card written for the ${label} template.`,
      };
    }
  } else if (!autoCandidates(opts.placement, opts.kind).some((c) => fitsHere(c.key))) {
    return { ok: false, code: "TEMPLATE_CARD", message: `No ${opts.kind.toLowerCase()} template suits this card. Pick another card or kind of post.` };
  }
  // The plan's allowance, then the top-ups, and only then the template
  // chooser and the designer, both of which are paid for.
  const entitled = await entitle({
    orgId: opts.orgId,
    nodeId: node.id,
    needs: postNeeds(opts.kind, opts.kind === "CAROUSEL" && opts.slides !== undefined ? slideCount(opts.slides) : null),
  });
  if (!entitled.ok) return { ok: false, code: entitled.code, message: entitled.message };

  const [{ n: seed }] = await withTenant(opts.orgId, async (sql) =>
    sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rendered_posts
      WHERE org_id = ${opts.orgId} AND brief_id = ${opts.briefId}`,
  );

  // The template: the one picked, or one chosen for this card.
  const template = await resolveTemplate({
    picked: opts.template,
    kind: opts.kind,
    context: {
      headline: card.headline,
      body: card.body,
      cta: card.cta,
      objective: head.objective,
      hook: head.hook,
      offers: head.offers,
      campaign: head.name,
      placement: opts.placement,
    },
    driver: opts.drivers?.choose,
    signal: opts.signal,
    allow: fitsHere,
    // What has worked here, ours and the market's, steers "Let AI choose".
    learned: await learningFor(opts.orgId, node.id)
      .then((l) => ({ scores: l.scores, explore: l.settings.explore, rand: seeded(`${opts.briefId}:${seed}:${opts.kind}`) }))
      .catch(() => undefined),
  });

  // A construction template needs a site photo; without one it would design
  // a finished exterior and look like every other post.
  const needPhotos = templatePhotos(template.key, opts.kind);
  if (needPhotos?.includes("CONSTRUCTION") && !materials.site.length) {
    return {
      ok: false,
      code: "NO_CONSTRUCTION",
      message: `A ${templateLabel(template.key, opts.kind) ?? "construction"} post needs at least one approved construction photo of this tower.`,
    };
  }
  if (!needPhotos?.length && !materials.backgrounds.length && !materials.site.length) {
    return { ok: false, code: "NO_PICTURE", message: "There is no approved exterior, amenity or room picture to use." };
  }

  // A festive template is built around one festival: the one chosen, else
  // the one the campaign's own words name ("Diwali 2026").
  const ask = festivalAsk(template.key, opts.kind);
  const festival = ask
    ? festivalByKey(opts.festival) ?? festivalIn([head.name, head.hook, head.offers].filter(Boolean).join(" "))
    : null;

  // A Hindi card's ad is all Hindi: its place, its prices and its points
  // are printed in Hindi, the prices built from the approved ones.
  const local = storedLocal(card.local);
  const luxury = isLuxury(ground.configurations);
  const postId = randomUUID();
  let designed;
  try {
    designed = await designPost({
      kind: opts.kind,
      placement: opts.placement,
      copy: { headline: card.headline, body: card.body, cta: card.cta },
      talkingPoints: local ? pointsFor(ground.talkingPoints, local, ground, card.language, { luxury }) : ground.talkingPoints,
      neverSay: ground.neverSay,
      materials,
      seed: seed + 1,
      drivers: opts.drivers,
      template,
      festival,
      slides: opts.slides,
      facts: adFacts(ground, local ? { language: card.language, place: local.place } : null),
      luxury,
      font: opts.font ?? null,
      pixel: pixelContext(ground),
      signal: opts.signal,
    });
  } catch (err) {
    // Said on the screen in a sentence and in the server log in full: a
    // failure that left no trace anywhere is not a failure anybody can fix.
    console.error("makeOnePost: the post could not be made", err);
    return { ok: false, code: "RENDER_FAILED", message: "This post could not be made." };
  }
  if (!designed.ok) return { ok: false, code: designed.code ?? "DESIGN_REFUSED", message: designed.message };
  // The card's reading rides with the post, so publishing gates its words.
  const inputs = local ? { ...designed.inputs, local } : designed.inputs;
  const { files } = designed;
  const pixel = designed.pixel;
  // A pixel FAIL on the finished files is a post that did not pass, like any
  // other check: the drawings already had their chance to fix it. A HOLD is
  // saved and shown, and never publishes.
  const review: PostReview =
    pixel?.verdict === "FAIL"
      ? {
          ...designed.review,
          passed: false,
          problems: [
            ...designed.review.problems,
            ...pixel.findings
              .filter((f) => f.verdict === "FAIL" && !designed.review.problems.some((p) => p.code === `PX_${f.code}`))
              .map((f) => ({ code: `PX_${f.code}`, text: f.text })),
          ],
        }
      : designed.review;

  // A post that failed a check after every attempt is not saved and never
  // shown. It was shown marked "Did not pass", which put a post that must
  // not be used one click from a download. Codes only in the log: a
  // problem's text can quote the copy.
  if (!review.passed || !pixel) {
    // Never charged; what the attempts cost us is still recorded.
    await meterPost({ orgId: opts.orgId, nodeId: node.id, postId, kind: opts.kind, frames: files.length, passed: false, attempts: review.attempts, agentUsd: review.agent?.usd, clips: review.motion?.attempts });
    await audit({
      orgId: opts.orgId,
      actorUserId: opts.actorUserId,
      action: "creative.post_failed",
      targetType: "campaign_brief",
      targetId: opts.briefId,
      metadata: {
        kind: opts.kind,
        placement: opts.placement,
        model: review.model,
        attempts: review.attempts,
        problems: review.problems.map((p) => p.code),
      },
    });
    const why = review.problems.filter((p) => p.code !== "LOGO_SLOT" && !p.soft).map((p) => p.text);
    return {
      ok: false,
      code: "DID_NOT_PASS",
      message: `Not saved: after ${review.attempts} ${review.attempts === 1 ? "drawing" : "drawings"} it still failed a check. ${why.join(" ")} Try again.`.replace(/\s+/g, " "),
    };
  }
  const stored = await storePostFiles(opts.orgId, node.id, postId, files);
  if (!stored) return { ok: false, code: "STORE_FAILED", message: "This post could not be saved." };
  // Each file's hash rides beside it, so publishing can tell the file that
  // passed from any other.
  const media = withHashes(stored, pixel);

  await withTenant(opts.orgId, async (sql) => {
    await sql`
      INSERT INTO rendered_posts (id, org_id, brief_id, scope_node_id, copy_id, kind, placement,
                                  language, segment, headline, body, cta, media, inputs, review,
                                  pixel, created_by)
      VALUES (${postId}, ${opts.orgId}, ${opts.briefId}, ${node.id}, ${card.id}, ${opts.kind},
              ${opts.placement}, ${card.language}, ${card.segment}, ${card.headline}, ${card.body},
              ${card.cta}, ${sql.json(media as unknown as JSONValue)},
              ${sql.json(inputs as unknown as JSONValue)},
              ${sql.json(review as unknown as JSONValue)},
              ${sql.json(pixel as unknown as JSONValue)}, ${opts.actorUserId})`;
  });
  await auditPixel({ orgId: opts.orgId, actorUserId: opts.actorUserId, targetType: "rendered_post", targetId: postId, record: pixel });
  // Codes only: a problem's text can quote the copy.
  await audit({
    orgId: opts.orgId,
    actorUserId: opts.actorUserId,
    action: "creative.post_made",
    targetType: "rendered_post",
    targetId: postId,
    metadata: {
      kind: opts.kind,
      placement: opts.placement,
      frames: files.length,
      model: review.model,
      attempts: review.attempts,
      passed: review.passed,
      problems: review.problems.map((p) => p.code),
    },
  });
  await meterPost({ orgId: opts.orgId, nodeId: node.id, postId, kind: opts.kind, frames: files.length, passed: true, attempts: review.attempts, agentUsd: review.agent?.usd, clips: review.motion?.attempts });
  return { ok: true, postId, passed: review.passed && pixel.verdict === "PASS" };
}
