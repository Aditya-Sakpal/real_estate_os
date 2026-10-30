/**
 * The typefaces a person may choose for a post, decided without a file or a
 * model.
 *
 * Eight open-licence faces (OFL, like the Noto ones beside them), bundled in
 * `assets/fonts/<key>/` as Regular and Bold, each renamed "Sales Desk
 * <Label>" so no font installed on a machine can stand in for it. They cover
 * the looks Indian property ads actually use: a geometric sans for a
 * launch, a thin elegant sans or a high-contrast serif for luxury, classical
 * capitals like the Ashford Regal ad a marketing firm sent as the example.
 *
 * What the choice does depends on who sets the words. Where the image model
 * draws the whole ad, it is told the face by name and shown a specimen of it:
 * the model follows it closely, not to the glyph. Where we set the words (a
 * Hindi or Marathi post, a story reel's captions), the face itself is used.
 * The faces are Latin only; Devanagari always falls back to Noto.
 *
 * Imports are relative because the workers load this straight from source.
 */

export type FontChoice = {
  key: string;
  /** What the picker shows, in the face itself. */
  label: string;
  /** The family name inside the bundled files. */
  family: string;
  kind: "Sans" | "Serif";
  /** Two words for the picker: what the face is for. */
  mood: string;
  /** How the image model is told what to set, in words. */
  describe: string;
};

/** The value that leaves the face to the design, as before there was a choice. */
export const AUTO_FONT = "auto";

export const FONTS: readonly FontChoice[] = [
  {
    key: "montserrat",
    label: "Montserrat",
    family: "Sales Desk Montserrat",
    kind: "Sans",
    mood: "Modern launch",
    describe: "Montserrat, a geometric sans-serif with wide, round letters",
  },
  {
    key: "poppins",
    label: "Poppins",
    family: "Sales Desk Poppins",
    kind: "Sans",
    mood: "Friendly, clean",
    describe: "Poppins, a geometric sans-serif with perfectly round bowls",
  },
  {
    key: "dm-sans",
    label: "DM Sans",
    family: "Sales Desk DM Sans",
    kind: "Sans",
    mood: "Quiet, corporate",
    describe: "DM Sans, a low-contrast, quietly modern sans-serif",
  },
  {
    key: "raleway",
    label: "Raleway",
    family: "Sales Desk Raleway",
    kind: "Sans",
    mood: "Elegant, airy",
    describe: "Raleway, an elegant, slender sans-serif with a refined W and fine details",
  },
  {
    key: "playfair-display",
    label: "Playfair Display",
    family: "Sales Desk Playfair Display",
    kind: "Serif",
    mood: "Luxury",
    describe: "Playfair Display, a high-contrast transitional serif with sharp hairlines",
  },
  {
    key: "cormorant-garamond",
    label: "Cormorant Garamond",
    family: "Sales Desk Cormorant Garamond",
    kind: "Serif",
    mood: "Refined, literary",
    describe: "Cormorant Garamond, a delicate, classical Garamond-style serif",
  },
  {
    key: "dm-serif-display",
    label: "DM Serif Display",
    family: "Sales Desk DM Serif Display",
    kind: "Serif",
    mood: "Bold editorial",
    describe: "DM Serif Display, a bold, compact display serif",
  },
  {
    key: "cinzel",
    label: "Cinzel",
    family: "Sales Desk Cinzel",
    kind: "Serif",
    mood: "Classic capitals",
    describe: "Cinzel, classical Roman inscriptional capitals, all in capitals",
  },
];

/** A choice from the catalog, or null for none, "auto" or anything it does not know. */
export function fontFor(key: string | null | undefined): FontChoice | null {
  return FONTS.find((f) => f.key === key) ?? null;
}

/** The bundled file for a face and a weight, relative to the repository root. */
export function fontFile(key: string, weight: "Regular" | "Bold"): string {
  return `assets/fonts/${key}/${weight}.ttf`;
}

/**
 * The words a specimen shows the image model: the alphabet and the figures,
 * nothing it could mistake for copy to set. Words from a real ad would be
 * copied onto the next one.
 */
export const SPECIMEN_LINES = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"] as const;
