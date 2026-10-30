/**
 * ltree label helpers.
 *
 * An ltree label is limited to letters, digits and underscores, so every
 * human-entered name has to be reduced to one before it can join a path such
 * as `godrej.gp_pune_spv.pune.trees.tower_c`. Labels are also the unit of
 * ancestor/descendant matching, so they must be stable: renaming a project
 * changes its display name, never its slug.
 */

const MAX_LABEL = 48;

export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, MAX_LABEL)
    .replace(/_$/, "");

  // ltree tolerates a leading digit, but a path segment that reads as a number
  // is a trap for anyone writing queries by hand.
  return /^[0-9]/.test(slug) ? `n${slug}` : slug || "org";
}

export function childPath(parentPath: string | null, slug: string): string {
  return parentPath ? `${parentPath}.${slug}` : slug;
}

/** Label actually accepted by ltree, used as a last-line assertion. */
export function isValidLabel(label: string): boolean {
  return /^[A-Za-z0-9_]{1,255}$/.test(label);
}
