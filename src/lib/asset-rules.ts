/**
 * The Approved Asset Library, decided without a database.
 *
 * Section 08 sets the rule this exists to serve: the AI never originates the
 * property, it assembles approved assets, and every pixel of the building
 * traces to one a named human approved. So an asset that nobody approved must
 * be structurally incapable of reaching a creative.
 *
 * What lives here is the catalog, which categories hang where, how a library
 * resolves down the tree, and whether an asset is fit to be built from. Kept
 * database-free so `npm run check:logic` exercises it directly.
 *
 * Imports are relative because the checks load this straight from source,
 * outside Next, where the `@/` alias does not resolve.
 */

import type { ScopeKind } from "./roles.ts";

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export type AssetCategory =
  | "EXTERIOR_RENDER"
  | "AMENITY"
  | "LOBBY"
  | "SAMPLE_FLAT"
  | "FLOOR_PLAN"
  | "SITE_PLAN"
  | "LOCATION_MAP"
  | "NEARBY_PLACE"
  | "CONSTRUCTION"
  | "RERA_LOCKUP";

export type CategoryDef = {
  key: AssetCategory;
  label: string;
  detail: string;
  /**
   * Node kinds this category may hang from. Absent means any.
   *
   * Two are pinned to a PHASE, and neither is a convenience. A RERA lockup
   * belongs to one registration, so a tower carrying another tower's QR is
   * the misrepresentation Section 3 exists to stop. A progress photo of the
   * 18th slab is not the tower that is on its 4th, and a project-level one
   * would flow down to every phase and advertise the wrong building.
   */
  onlyAt?: ScopeKind[];
  /** A photograph by nature. The artist's impression line does not apply. */
  photographic?: boolean;
  /** Only true of the day it was taken, so the date is required. */
  dated?: boolean;
  /**
   * Depicts one configuration rather than the building, so it can be tagged
   * with which, and with which room.
   *
   * A clubhouse belongs to everyone in the tower and an elevation shows the
   * whole of it. A bedroom belongs to a 2 BHK, and an advertisement for the
   * 1 BHK carrying it is the confusion `unit_types` exists to end.
   */
  perUnit?: boolean;
};

export const ASSET_CATEGORIES: CategoryDef[] = [
  {
    key: "EXTERIOR_RENDER",
    label: "Exterior render",
    detail: "The building as it will look. Usually the lead image on a creative.",
  },
  {
    key: "AMENITY",
    label: "Amenity",
    detail: "Clubhouse, pool, gardens. Shared across towers unless a tower has its own.",
  },
  { key: "LOBBY", label: "Lobby or common area", detail: "Entrance, lift lobby, corridors." },
  {
    key: "SAMPLE_FLAT",
    label: "Sample flat",
    detail: "The show apartment, as photographed or rendered.",
    perUnit: true,
  },
  {
    key: "FLOOR_PLAN",
    label: "Floor or unit plan",
    detail: "Per tower. One tower's 3 BHK is not another's.",
    onlyAt: ["PHASE"],
    perUnit: true,
  },
  {
    key: "SITE_PLAN",
    label: "Site plan",
    detail: "The layout of the whole development. One per project.",
    onlyAt: ["PROJECT"],
  },
  {
    key: "LOCATION_MAP",
    label: "Location map",
    detail: "Where it sits, and what is around it.",
    onlyAt: ["PROJECT"],
  },
  {
    // A location film shows the places it names only from these (13 October
    // 2026): a video model's own station or mall is an invented landmark.
    key: "NEARBY_PLACE",
    label: "Nearby place",
    detail: "A real photo of a place near the project: the station, a mall, a school. Name it after the place.",
    onlyAt: ["PROJECT"],
    photographic: true,
  },
  {
    key: "CONSTRUCTION",
    label: "Construction progress",
    detail: "Dated, and only true of the day it was taken.",
    onlyAt: ["PHASE"],
    photographic: true,
    dated: true,
  },
  {
    key: "RERA_LOCKUP",
    label: "RERA QR lockup",
    detail: "The registration mark for this phase, printed on every advertisement.",
    onlyAt: ["PHASE"],
  },
];

export function isAssetCategory(raw: string | null | undefined): raw is AssetCategory {
  return ASSET_CATEGORIES.some((c) => c.key === raw);
}

export function categoryDef(key: string): CategoryDef | undefined {
  return ASSET_CATEGORIES.find((c) => c.key === key);
}

/** The categories a node of this kind may actually hold. */
export function categoriesFor(kind: ScopeKind): CategoryDef[] {
  return ASSET_CATEGORIES.filter((c) => !c.onlyAt || c.onlyAt.includes(kind));
}

/** Whether this kind of picture can name a configuration and a room. */
export function isPerUnit(category: string): boolean {
  return categoryDef(category)?.perUnit === true;
}

export function categoryFitsNode(category: string, kind: ScopeKind): boolean {
  const def = categoryDef(category);
  return !!def && (!def.onlyAt || def.onlyAt.includes(kind));
}

/** A category that never reaches a node below the one it was filed at. */
export function inherits(category: string): boolean {
  const def = categoryDef(category);
  if (!def) return false;
  return !(def.key === "RERA_LOCKUP" || def.key === "CONSTRUCTION");
}

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

/** SVG is absent for the reason it is absent everywhere here: it can carry script. */
export const ASSET_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const ASSET_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export const ASSET_TYPES = [...ASSET_IMAGE_TYPES, ...ASSET_VIDEO_TYPES] as const;

/**
 * 100 MB.
 *
 * Four times the reference cap, because these are source material rather than
 * examples: a print-resolution render is tens of megabytes and downsizing it
 * before it reaches the library is throwing away the thing the library is
 * for. The bytes go straight to the bucket rather than through a database
 * row, which is what makes the larger number affordable.
 */
export const MAX_ASSET_BYTES = 100 * 1024 * 1024;

export function isAssetType(raw: string | null | undefined): boolean {
  return ASSET_TYPES.includes((raw ?? "") as (typeof ASSET_TYPES)[number]);
}

export function isAssetVideo(raw: string | null | undefined): boolean {
  return ASSET_VIDEO_TYPES.includes((raw ?? "") as (typeof ASSET_VIDEO_TYPES)[number]);
}

export type UploadCheck =
  | { ok: true }
  | {
      ok: false;
      code:
        | "NO_FILE"
        | "MEDIA_TYPE"
        | "MEDIA_TOO_BIG"
        | "CATEGORY"
        | "WRONG_LEVEL"
        | "DATE_REQUIRED"
        | "DATE_INVALID"
        | "DATE_FUTURE";
      message: string;
    };

/** Today's date in India, as YYYY-MM-DD. The clock is passed in, so it stays pure. */
export function istDay(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** A real calendar date written YYYY-MM-DD: 2026-02-30 is not one. */
export function isCalendarDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}

/**
 * Whether this file may be filed here.
 *
 * `today` is the date in India (`istDay()`), because a progress photo dated
 * after it is a promise about the building rather than a record of it, and
 * the freshness rule would then count it as current for months longer than
 * it is.
 */
export function canUploadAsset(input: {
  category: string;
  nodeKind: ScopeKind;
  mediaType: string | null;
  mediaBytes: number;
  capturedOn: string | null;
  today: string;
}): UploadCheck {
  const def = categoryDef(input.category);
  if (!def) {
    return { ok: false, code: "CATEGORY", message: "That is not a kind of asset." };
  }
  if (def.onlyAt && !def.onlyAt.includes(input.nodeKind)) {
    return {
      ok: false,
      code: "WRONG_LEVEL",
      message:
        def.key === "RERA_LOCKUP"
          ? "A RERA lockup belongs to one registration, so it goes on the phase."
          : def.key === "CONSTRUCTION"
            ? "Progress photos go on the phase they show, or they advertise the wrong tower."
            : `${def.label} belongs on a ${def.onlyAt.join(" or ").toLowerCase()}.`,
    };
  }
  if (input.mediaBytes <= 0) {
    return { ok: false, code: "NO_FILE", message: "Choose an image or a video to upload." };
  }
  if (!isAssetType(input.mediaType)) {
    return {
      ok: false,
      code: "MEDIA_TYPE",
      message: "That file is not an image or a video. JPG, PNG, WebP, MP4, MOV and WebM work.",
    };
  }
  if (input.mediaBytes > MAX_ASSET_BYTES) {
    return { ok: false, code: "MEDIA_TOO_BIG", message: "That file is over 100 MB." };
  }
  // A construction photo with no date is a photo of an unknown day, which is
  // the one thing it must never be.
  if (def.dated && !input.capturedOn) {
    return {
      ok: false,
      code: "DATE_REQUIRED",
      message: "Say when the photo was taken. A progress shot is only true of its day.",
    };
  }
  if (input.capturedOn) {
    if (!isCalendarDate(input.capturedOn)) {
      return { ok: false, code: "DATE_INVALID", message: "That is not a real date." };
    }
    if (input.capturedOn > input.today) {
      return {
        ok: false,
        code: "DATE_FUTURE",
        message: "The date taken is after today. Use the day the photo was taken.",
      };
    }
  }
  return { ok: true };
}

/**
 * Whether files of this kind are renders.
 *
 * A category that is a photograph by nature is never a render, whatever the
 * form said: the upload screen does not even offer the choice for one, and
 * reading the missing tick as "render" filed every progress photo as a
 * render and printed "Render" under it.
 */
export function isRenderFor(category: string, saidPhotograph: boolean): boolean {
  if (categoryDef(category)?.photographic) return false;
  return !saidPhotograph;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type AssetLike = {
  id: string;
  category: string;
  sha256: string;
  isRender: boolean;
  capturedOn: string | null;
  path: string;
};

export type ApprovalLike = { assetId: string; sha256: string; byName: string | null; at: string };

export type AssetState = {
  approved: boolean;
  /** Approved once, then the file was replaced. The old approval is not it. */
  stale: boolean;
  byName: string | null;
  at: string | null;
};

/**
 * Whether this asset may be built from.
 *
 * An approval pins the content hash rather than the asset, so replacing the
 * file leaves the approval behind rather than carrying it forward. That is
 * the whole of "every pixel traces to an approval": the thing approved and
 * the thing rendered have to be the same bytes.
 */
export function assetState(
  asset: AssetLike,
  approvals: readonly ApprovalLike[],
): AssetState {
  const mine = approvals.filter((a) => a.assetId === asset.id);
  const current = mine.find((a) => a.sha256 === asset.sha256);
  if (current) {
    return { approved: true, stale: false, byName: current.byName, at: current.at };
  }
  return { approved: false, stale: mine.length > 0, byName: null, at: null };
}

/**
 * How old a progress photo may be before it stops being current.
 *
 * Advertising a six month old slab as today's progress is its own Section 12
 * problem. Ninety days is the working number and it belongs in per-state
 * config eventually, like the Section 3(2)(a) combinator.
 */
export const CONSTRUCTION_FRESH_DAYS = 90;

/**
 * Below this, a picture holds too little to be a photograph or a render: a
 * flat colour or a placeholder. Measured on the dev library (6 October 2026,
 * greyscale, 256 wide): every real exterior and room read 5.4 to 7.8, the
 * placeholders a test script left approved in Tower C 0.0 and 1.1. One of
 * those, a blue frame titled "Tower C evening render", was handed to a land
 * to home film as the finished building, and the model invented a tower and
 * a suburb for it.
 */
export const BLANK_ENTROPY = 3.5;

/** Whether a picture's greyscale entropy says it shows nothing to film or draw from. */
export function looksBlank(entropy: number | null | undefined): boolean {
  return typeof entropy === "number" && Number.isFinite(entropy) && entropy < BLANK_ENTROPY;
}

export function constructionIsStale(capturedOn: string | null, now = new Date()): boolean {
  if (!capturedOn) return true;
  const taken = new Date(`${capturedOn}T00:00:00Z`);
  if (Number.isNaN(taken.getTime())) return true;
  const days = (now.getTime() - taken.getTime()) / 86_400_000;
  return days > CONSTRUCTION_FRESH_DAYS;
}

// ---------------------------------------------------------------------------
// Resolving a library down the tree
// ---------------------------------------------------------------------------

/**
 * Every asset in force at a node: its own, plus what it inherits.
 *
 * A UNION down the chain, not an override, and that is the one place this
 * differs from how the Brain resolves facts. `mergeInherited()` picks a
 * single value per field and the deepest wins, which is right for a price.
 * A library is a collection: Tower C having its own elevation must not hide
 * the township masterplan, so both are available and depth is a preference
 * ordering rather than an exclusion.
 *
 * Categories that do not inherit are dropped unless they were filed on this
 * node itself.
 */
export function resolveLibrary<T extends AssetLike>(
  assets: readonly T[],
  nodePath: string,
): T[] {
  const depth = (p: string) => p.split(".").length;
  const here = depth(nodePath);
  return [...assets]
    .filter((a) => {
      const own = a.path === nodePath;
      if (own) return true;
      // An ancestor's asset only reaches here if its category travels.
      const isAncestor = nodePath.startsWith(`${a.path}.`);
      return isAncestor && inherits(a.category);
    })
    .sort((a, b) => {
      // Deepest first: the most specific asset is the one a generator should
      // reach for, and the shared ones sit behind it.
      const d = depth(b.path) - depth(a.path);
      if (d !== 0) return d;
      return a.category.localeCompare(b.category);
    })
    .filter((a) => depth(a.path) <= here);
}
