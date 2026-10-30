/**
 * The template library, decided without a file system or a model.
 *
 * A template is a CATEGORY of ad (a launch, a price card, a festive offer),
 * and each category holds four reference designs: an image post's in
 * `template_library/image-ads-templates/<key>/`, one file each, and a
 * carousel's in `template_library/carousel-ads-templates/<key>/`, one folder
 * of pages each, and a video's in `template_library/video-ads-templates/<key>/`,
 * a preview clip and its poster still each. The references are shown to the
 * image model as style:
 * layout, type, colour, graphic devices. Never as content: their words,
 * numbers, logos, people and buildings are not ours, and the post check
 * refuses any of them that turn up.
 *
 * Choosing one is optional. With none chosen, a model picks the category
 * that fits the card, from a shortlist that leaves out the ones whose
 * purpose needs material this product does not hold (a developer's track
 * record, a referral scheme). `ruleTemplate()` is the fallback when
 * that call fails, so a post never waits on it.
 *
 * Imports are relative because the checks load this straight from source.
 */

export type TemplateCategory = {
  key: string;
  label: string;
  /** What it is, in the client's words. One line. */
  detail: string;
  /** Picked automatically only when true. */
  auto: boolean;
  /** Placements this category is drawn for, when it is not a general one. */
  only?: readonly string[];
  /** A format doing well on Instagram now: the picker marks it Hot and lists it first. */
  hot?: boolean;
  /**
   * Reference films for the narrated story, which is made by the reel worker
   * rather than after a template. Shown on the story's own tile, never in the
   * grid, and never a template a frame is designed after.
   */
  story?: boolean;
  /**
   * The look this category is drawn in, in words, sent to the image model
   * beside its reference designs. The references show a layout; this says
   * what the ad is for, so two categories with similar pictures still come
   * back as two kinds of ad. No number and no claim: it is ours, not a fact.
   */
  look?: string;
  /**
   * Approved asset categories this kind of ad is built from, when it is not
   * the ordinary pool (exterior, amenity, lobby, sample flat). A construction
   * update needs site photos; without them the post is refused before a model
   * is paid. Empty or omitted means the ordinary pool.
   */
  photos?: readonly string[];
  /**
   * A carousel's thread: the one graphic element every slide repeats in the
   * same place, so a swipe reads as one set. Carousel categories only, and
   * never a digit: a drawn number nobody cleared is extra text to the check.
   */
  continuity?: string;
  /** A festive category asks which festival, and the post is built around it. */
  festival?: "required" | "optional";
};

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  { key: "01-launch-announcement", label: "Launch announcement", detail: "The building unveiled under red silk, with the name and the starting price.", auto: true, look: "A grand unveiling. Rich red silk drapery swept back at both sides of the frame like a curtain just drawn open, a gold ribbon or gold trim, dramatic evening light and a glow behind the building, deep red with gold. The silk frames the building and never covers it." },
  { key: "03-price-and-configuration", label: "Price and configuration", detail: "A price tied to a configuration, front and centre.", auto: true, look: "A price sheet you can screenshot: the configuration and its starting price set together in one bold solid panel or price tag in the brand colour, large and high-contrast, the photograph beside or above it. Crisp, confident, nothing else competing with the price." },
  { key: "04-offer-and-payment-plan", label: "Offer and payment plan", detail: "A payment plan, a booking offer or a waiver as the hook.", auto: true, look: "The offer is the hero: one bold ribbon, banner or rounded panel across the photograph in a warm, urgent colour (deep orange, red or gold) holding the call to action, with a thin highlight edge. Warm and urgent, never shouty." },
  { key: "05-festive-offer", label: "Festive offer", detail: "A festival look carrying an offer.", auto: true, festival: "required", look: "A festive ad carrying the offer: festive colour and ornament around the edges of the frame, the offer in a celebratory panel, the building calm at the centre." },
  { key: "06-festive-greeting", label: "Festive greeting", detail: "A festival wish with the brand. No offer.", auto: true, festival: "required", look: "A festival greeting from the brand: warm, gracious and decorative, the festival's motifs framing the photograph, the brand signing off small. It wishes; it does not sell." },
  { key: "07-location-and-connectivity", label: "Location and connectivity", detail: "Distances to the station, highway, schools and offices.", auto: true, look: "Location-led: a bold map-pin graphic beside the locality line and a dotted route line curving across a margin of the frame, a cool blue and white palette, the locality set prominent. Graphics only, never a drawn map with places on it." },
  { key: "08-amenities-and-lifestyle", label: "Amenities and lifestyle", detail: "Clubhouse, pool, gym and gardens, with a lifestyle mood.", auto: true, look: "Lifestyle-led: airy and aspirational, soft warm natural light, the headline in an elegant serif, a slim arched or rounded frame around the photograph, cream and soft green tones. The space is the hero and the words sit light on it." },
  { key: "09-key-highlights", label: "Key highlights", detail: "Three to five selling points as icons or bullets.", auto: true, look: "A structured fact sheet: the photograph on one side and the words on a clean solid side panel, set as a short list with thin dividers or small line icons between items, crisp navy or charcoal on white. Tidy and informative." },
  // OFF construction: { key: "10-construction-update", label: "Construction update", detail: "Progress on site, dated.", auto: true, photos: ["CONSTRUCTION"], look: "A site-progress report, not a lifestyle launch: the photograph is a real construction photo of this tower under construction (scaffold, bare concrete, unfinished floors), never a finished glossy render. Black and hard-hat yellow palette, a band of yellow and black hazard stripes along one edge, bold condensed industrial type, a flat hard-hat or crane icon in the margin (graphics only, never drawn on the building). Honest and documentary, concrete grey behind the type. If it could pass for a launch or amenities ad, it is wrong." },
  { key: "11-ready-to-move-and-possession", label: "Ready to move", detail: "Ready to move, possession started.", auto: true, look: "Ready to move in: bright warm daylight, a welcoming home-key motif drawn as a flat graphic, soft white and warm wood tones, a rounded panel for the words. The feeling of keys handed over and life starting." },
  { key: "12-site-visit-and-events", label: "Site visit and events", detail: "Sample flat open, weekend site visits, launch events.", auto: true, look: "An invitation: an elegant invitation-card frame with a fine gold or brand-colour border around the photograph, the call to visit as the hero in refined serif type, warm light. Personal and welcoming, like a printed invite." },
  { key: "14-developer-trust", label: "Developer trust", detail: "Years, projects delivered, families housed.", auto: false, look: "Corporate and assured: deep navy or charcoal with gold, a strong stable symmetric composition, a thin gold frame or rule, a premium institutional seal-like feel." },
  { key: "15-nri", label: "NRI", detail: "Aimed at buyers living abroad.", auto: true, look: "For buyers abroad: a calm blue and gold palette, an elegant globe or flight-path line drawn as a thin graphic in the margin, an aspirational coming-home mood, refined serif type." },
  { key: "16-referral", label: "Referral", detail: "Owners refer a friend.", auto: false, look: "Friendly and rewarding: bright, warm and simple, rounded shapes, a gift-ribbon or handshake motif drawn as a flat graphic, people-first." },
  { key: "19-google-display-banners", label: "Display banner", detail: "A wide 1.91:1 banner for Google display.", auto: true, only: ["Google display"], look: "A wide web banner: the photograph on one side, the headline and price stacked on a solid colour panel on the other, a clear rounded button, readable at a small size." },
];

/**
 * A carousel's categories. Its designs are sets of pages, and a carousel is
 * made after ONE of them, page for page, so its slides read as one set.
 *
 * Floor plans are never picked automatically: a slide never sits on a plan.
 * Testimonials, track record and buyer tips were taken out on 3 October 2026
 * at the client's asking.
 */
export const CAROUSEL_TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  { key: "01-project-tour", label: "Project tour", detail: "The building, then its spaces, a picture a slide.", auto: true, look: "A guided tour of one home: the cover is the building at its best, then each slide steps inside to one space, a big photograph filling most of the slide with a short caption in elegant type. Premium and calm, the same frame and type on every slide, so the set reads like turning the pages of one brochure.", continuity: "a thin rule framing the photograph with the caption set in the same corner on every slide, and a small arrow at the foot pointing to the next slide" },
  { key: "02-floor-plans", label: "Floor plans", detail: "One configuration a slide.", auto: false, look: "A listing card a slide: one configuration per slide, the photograph on top, a tidy panel below holding the configuration and its approved line, crisp lines and plenty of white space. Clean and technical, like a price sheet a buyer can screenshot.", continuity: "the same rounded information panel in the same place on every slide, in one accent colour, so only its contents change as you swipe" },
  { key: "03-location-guide", label: "Location guide", detail: "What is nearby, one place a slide.", auto: true, look: "A guide to the neighbourhood: one reason or place a slide, bold headline type over the photograph or a strong colour field, the feeling of moving through the area. Never a drawn map with places on it.", continuity: "a map pin and a dotted route line that runs along the same edge of every slide and continues off the right edge, so the route seems to lead into the next slide" },
  { key: "04-amenities", label: "Amenities", detail: "Clubhouse, pool, gym and gardens, one a slide.", auto: true, look: "One amenity a slide: airy lifestyle photography of the space, a short headline in confident display type, warm and aspirational. The space is the hero; the words stay light on it.", continuity: "one accent colour band holding the headline, set in the same place and the same size on every slide, with a small arrow inviting the next swipe" },
  { key: "05-reasons-to-buy", label: "Reasons to buy", detail: "One selling point a slide.", auto: true, look: "One reason a slide: a single bold statement set large on its photograph, minimal and confident, lots of space around the words. Each slide makes one point and stops.", continuity: "a short underline bar beneath every headline and a row of small progress dots at the foot, with one more dot filled on each slide" },
  { key: "06-offer-explained", label: "Offer explained", detail: "An offer or payment plan, step by step.", auto: true, look: "The offer step by step: each slide one step in a clear, confident panel, warm and reassuring, a photograph or soft colour field behind. It should feel like being walked through it by someone helpful.", continuity: "a step badge shape (a circle) in the same corner of every slide and the same panel style, linked by a thin line that runs from slide to slide" },
  // OFF construction: { key: "07-construction-timeline", label: "Construction timeline", detail: "Milestones on site, in order.", auto: true, photos: ["CONSTRUCTION"], look: "A construction timeline, not a lifestyle carousel: every slide sits on a real site photograph of this tower under construction, industrial-modern type, concrete grey or black with a hard-hat yellow accent. Progress is shown by the site progress in the photograph, never by invented milestone names, stage labels, dates or badges. Factual and site-real, never staged, never a finished-building render. If a slide could pass for an amenities or tour ad, it is wrong.", continuity: "a timeline line with a marker running across the foot of every slide, entering from the left edge and leaving off the right, with the marker further along on each slide" },
  // OFF construction: { key: "08-site-progress-report", label: "Site progress report", detail: "Detailed engineering and stage-by-stage construction milestones.", auto: true, photos: ["CONSTRUCTION"], look: "An engineering site progress report: bold technical typography, structural precision, concrete grey and steel blue with high-visibility accents, real construction photography of this tower. Honest, documentary, and technical.", continuity: "a segmented progress bar across the foot showing the active slide segment" },
  { key: "09-architecture-and-elevation", label: "Architecture and elevation", detail: "Tower facade, design language, and structural elevations.", auto: true, look: "An architectural monograph: minimalist framing, generous negative space, refined typography, soft stone and dark bronze tones. Elegant elevation views.", continuity: "a minimalist slide counter pill with a slim architectural progress line" },
  { key: "10-key-highlights", label: "Feature showcase", detail: "Curated tower highlights, specs, and advantages one by one.", auto: true, look: "A modern executive carousel: dark mode or editorial white, bold numbered highlights, clean dividers, one compelling point per slide.", continuity: "a row of modern expanded progress pills at the foot" },
  { key: "11-seamless-panorama", label: "Photo feature", detail: "Big photographs, very few words.", auto: true, look: "Big photographs and very few words: a just-listed feel, full-bleed pictures, one short line at most per slide, bold and editorial.", continuity: "one graphic shape (a bold colour band or curve) that crosses the edge between slides, cut off at the right edge of one slide and continuing at the left edge of the next, so the set reads as one long picture when swiped" },
];

/**
 * A video's categories. A video here is its slides under a slow zoom, so a
 * template sets the look of each frame (its poster still is what the image
 * model is shown), never the motion or the footage.
 *
 * The drone category is never picked automatically: it needs footage this
 * product does not hold. Motion poster, walkthrough, testimonial, offer reel,
 * presenter explainer, brand film and the site walk with a price were taken
 * out on 3 October 2026 at the client's asking; drone and route, the sample
 * flat tour and possession and handover on 8 October 2026.
 * Each category's designs are real reels, mostly 9:16, with their sound.
 */
export const VIDEO_TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  { key: "00-narrated-story", label: "Narrated story", detail: "Story-led property films with a voice over and music.", auto: false, story: true },
  { key: "01-launch-film", label: "Launch film", detail: "A quiet luxury film: the life the home gives, five or six spoken lines, the building near the end, the name at the close. No price.", auto: true, look: "A quiet luxury launch film: warm golden-hour light, slow drifting camera, details and one person living in the spaces, small subtitles, a quiet wide-set name." },
  // OFF construction: { key: "06-construction-update", label: "Construction update", detail: "Progress on site, dated.", auto: true, photos: ["CONSTRUCTION"], look: "Progress on site: honest, documentary, concrete grey with a hard-hat yellow accent, real construction photos of this tower unfinished, never a glossy finished render." },
  { key: "12-locality-guide", label: "Locality guide", detail: "An agent on camera on what is nearby, each place with its time.", auto: true, look: "A high-energy presenter at the project, fast cuts to the real places nearby, each time big on screen." },
  // Instagram formats doing well now, each folder a set of real reels. Only the
  // slow tour and construction progress are picked automatically: the rest
  // need a plot, drone footage, an agent or an effect this product does not
  // make.
  { key: "13-insta-friendly-ai-land-to-home-transformation", label: "Plot to home", detail: "The whole build, sped up in one shot, from the empty plot to the finished home.", auto: false, hot: true, look: "Before and after: an open, aspirational feel, bold type that announces the change." },
  { key: "14-insta-friendly-vfx-dust-transition-reveal", label: "Building assembly", detail: "The building assembles itself, piece by piece, on its own ground.", auto: false, hot: true, look: "A dramatic reveal: high contrast, cinematic light, bold title type." },
  { key: "15-insta-friendly-drone-plot-boundary-graphics", label: "Plot from the air", detail: "A drone view with the plot's boundary drawn on.", auto: false, hot: true, look: "Seen from above: wide sky, clean boundary-line graphics, minimal type." },
  { key: "17-insta-friendly-agent-describing-property", label: "Agent on camera", detail: "An agent talks through the home to camera.", auto: false, hot: true, look: "A creator's walk-through: lively, native to Instagram, big punchy cards." },
  { key: "18-insta-friendly-cinematic-slow-tour", label: "Cinematic tour", detail: "The home room by room, cut to the beat, each room named.", auto: true, hot: true, look: "Cinematic and warm: a filmic grade, golden light, bold room names on the beat." },
  // OFF construction: { key: "19-insta-friendly-construction-progress", label: "Construction progress", detail: "Site progress cut fast to music.", auto: true, hot: true, look: "Fast and energetic: site progress, bold type, a factual, dated feel." },
];

/** The kinds of post that have a template library. */
export type TemplateKind = "IMAGE" | "CAROUSEL" | "VIDEO";

export function templateCatalog(kind: TemplateKind = "IMAGE"): readonly TemplateCategory[] {
  return kind === "CAROUSEL"
    ? CAROUSEL_TEMPLATE_CATEGORIES
    : kind === "VIDEO"
      ? VIDEO_TEMPLATE_CATEGORIES
      : TEMPLATE_CATEGORIES;
}

/**
 * Which page of a carousel design a slide follows: the cover opens on its
 * first page, the close on its last, and the slides between take the middle
 * pages in turn, starting again when a carousel is longer than the design.
 */
export function pageForSlide(position: number, total: number, pages: number): number {
  if (pages <= 1 || position <= 0) return 0;
  if (position >= total - 1) return pages - 1;
  return 1 + ((position - 1) % Math.max(1, pages - 2));
}

/** The value a person picks to leave the choice to us. */
export const AUTO_TEMPLATE = "auto";

/** How many reference designs of a category are shown to the image model. */
export const TEMPLATE_REFERENCES = 4;

/**
 * Keys a category was once filed under. The launch teaser was folded into the
 * launch announcement on 2 October 2026: posts and styles made before keep
 * the old key, and it reads as the category it became.
 */
const RENAMED: Record<string, string> = { "02-launch-teaser": "01-launch-announcement" };

/** A key as the catalog knows it today. */
export function currentTemplateKey(raw: string | null | undefined): string | null {
  return raw ? RENAMED[raw] ?? raw : null;
}

/**
 * The sizes one category is drawn for, out of the ones given, in their order.
 *
 * A category with shapes of its own (a display banner) is drawn
 * only in those. Every other one is drawn in what is left: its designs are
 * squares, 4:5s and stories, and a banner laid out after them
 * is a squashed feed post. A key not in the catalog fits nothing.
 */
export function templateSizes(key: string | null | undefined, kind: TemplateKind, placements: readonly string[]): string[] {
  const all = templateCatalog(kind);
  const cat = all.find((c) => c.key === currentTemplateKey(key));
  if (!cat) return [];
  if (cat.only) return placements.filter((p) => cat.only!.includes(p));
  const owned = new Set(all.flatMap((c) => c.only ?? []));
  return placements.filter((p) => !owned.has(p));
}

/**
 * The festivals a festive post can be built around: what it is called, the
 * one greeting the post may set (in English letters, because only a design
 * the image model sets whole carries it), and its look in words.
 *
 * Every look keeps the festival in the graphics, the sky and the edges of
 * the frame. Nothing is hung on the building or drawn over it, and no
 * skyline, landmark or water is added: a view drawn in is a view promised.
 */
export type Festival = { key: string; label: string; greeting: string; look: string };

export const FESTIVALS: readonly Festival[] = [
  { key: "diwali", label: "Diwali", greeting: "Happy Diwali", look: "glowing diyas and warm golden lamplight, marigold garlands, a rangoli pattern, deep maroon and gold, soft sparkles in the evening sky" },
  { key: "dhanteras", label: "Dhanteras", greeting: "Happy Dhanteras", look: "a brass kalash and diyas, gold accents and soft golden light, a rangoli border, rich maroon and gold" },
  { key: "gudi-padwa", label: "Gudi Padwa", greeting: "Happy Gudi Padwa", look: "a gudi raised with bright silk and a neem-and-sugar garland, a mango-leaf toran across the top, a rangoli border, saffron and green" },
  { key: "akshaya-tritiya", label: "Akshaya Tritiya", greeting: "Happy Akshaya Tritiya", look: "a kalash and lotus motifs, soft auspicious gold, cream and saffron, an elegant traditional border" },
  { key: "ganesh-chaturthi", label: "Ganesh Chaturthi", greeting: "Ganpati Bappa Morya", look: "a graceful silhouette of Lord Ganesha as a graphic, modak and marigold, hibiscus red and saffron, a warm devotional glow" },
  { key: "navratri", label: "Navratri", greeting: "Happy Navratri", look: "dandiya sticks and garba swirls, bandhani and mirror-work patterns, vibrant festive colours" },
  { key: "dussehra", label: "Dussehra", greeting: "Happy Dussehra", look: "marigold garlands, a bow-and-arrow motif, saffron and red, a triumphant golden light" },
  { key: "durga-puja", label: "Durga Puja", greeting: "Happy Durga Puja", look: "the red-and-white border of a festive saree, dhak drums and a conch as graphics, shiuli flowers, red and gold" },
  { key: "makar-sankranti", label: "Makar Sankranti", greeting: "Happy Makar Sankranti", look: "colourful kites in a clear sky, til-gul sweets, a bright sun motif, cheerful yellow and blue" },
  { key: "pongal", label: "Pongal", greeting: "Happy Pongal", look: "a clay pot overflowing with pongal, sugarcane, a kolam pattern, a bright sun motif, turmeric yellow and green" },
  { key: "onam", label: "Onam", greeting: "Happy Onam", look: "a pookalam flower carpet as a border, banana leaves, kasavu cream with a gold border" },
  { key: "ugadi", label: "Ugadi", greeting: "Happy Ugadi", look: "a mango-leaf toran across the top, neem flowers, a rangoli border, fresh green and saffron" },
  { key: "holi", label: "Holi", greeting: "Happy Holi", look: "bright clouds of colour powder in pink, yellow, green and blue, playful splashes around the frame" },
  { key: "raksha-bandhan", label: "Raksha Bandhan", greeting: "Happy Raksha Bandhan", look: "a decorated rakhi thread and a puja thali with diyas as graphics, soft pastel pink and gold, a gentle festive glow" },
  { key: "janmashtami", label: "Janmashtami", greeting: "Happy Janmashtami", look: "a peacock feather and a flute as graphics, a matki pot with marigolds, deep blue and gold, a soft midnight glow" },
  { key: "guru-nanak-jayanti", label: "Guru Nanak Jayanti", greeting: "Happy Gurpurab", look: "rows of glowing diyas and soft lamplight, a simple ornamental border, warm saffron and gold, a serene devotional mood" },
  { key: "eid", label: "Eid", greeting: "Eid Mubarak", look: "a crescent moon and hanging lanterns, arabesque patterns, soft teal and gold" },
  { key: "christmas", label: "Christmas", greeting: "Merry Christmas", look: "fairy lights and a decorated tree as graphics, red and green with gold, a soft warm glow" },
  { key: "new-year", label: "New Year", greeting: "Happy New Year", look: "golden fireworks and confetti in the sky, midnight blue and gold, a celebratory sparkle" },
  { key: "independence-day", label: "Independence Day", greeting: "Happy Independence Day", look: "flowing ribbons in saffron, white and green with an Ashoka-chakra blue accent, a proud, bright mood" },
  { key: "republic-day", label: "Republic Day", greeting: "Happy Republic Day", look: "flowing ribbons in saffron, white and green with an Ashoka-chakra blue accent, a dignified, bright mood" },
];

export function festivalByKey(key: string | null | undefined): Festival | null {
  return FESTIVALS.find((f) => f.key === key) ?? null;
}

/** The festival a campaign's own words name ("Diwali 2026"), or null. */
export function festivalIn(text: string | null | undefined): Festival | null {
  const t = ` ${(text ?? "").toLowerCase().replace(/[^a-z]+/g, " ")} `;
  return FESTIVALS.find((f) => t.includes(` ${f.label.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `)) ?? null;
}

/** Whether a category asks which festival: "required", "optional", or null. */
export function festivalAsk(key: string | null | undefined, kind: TemplateKind): "required" | "optional" | null {
  const k = currentTemplateKey(key);
  return templateCatalog(kind).find((c) => c.key === k)?.festival ?? null;
}

/**
 * What the image model is told about the post's kind beyond its pictures:
 * the category's look, and the festival it is built around. A festival
 * rides only on a category that asks for one.
 */
export type TemplateDirection = { label: string; look: string | null; continuity?: string | null; festival: Festival | null };

export function templateDirection(
  key: string | null | undefined,
  kind: TemplateKind,
  festival: Festival | null,
): TemplateDirection | null {
  const k = currentTemplateKey(key);
  const cat = templateCatalog(kind).find((c) => c.key === k);
  if (!cat) return null;
  return { label: cat.label, look: cat.look ?? null, continuity: cat.continuity ?? null, festival: cat.festival ? festival : null };
}

/**
 * Which approved picture categories this template builds from. Null means the
 * ordinary pool (exterior, amenity, lobby, sample flat). Construction update
 * and construction timeline return `CONSTRUCTION`.
 */
export function templatePhotos(key: string | null | undefined, kind: TemplateKind): readonly string[] | null {
  const k = currentTemplateKey(key);
  const photos = templateCatalog(kind).find((c) => c.key === k)?.photos;
  return photos?.length ? photos : null;
}

/** Whether a category is drawn for one size. */
export function templateFits(key: string | null | undefined, kind: TemplateKind, placement: string): boolean {
  return templateSizes(key, kind, [placement]).length > 0;
}

export function isTemplateKey(raw: string | null | undefined, kind: TemplateKind = "IMAGE"): boolean {
  return templateCatalog(kind).some((c) => c.key === raw);
}

/** A key a post may be designed after: in the catalog, and not the story's reference films. */
export function isDesignTemplate(raw: string | null | undefined, kind: TemplateKind = "IMAGE"): boolean {
  return templateCatalog(kind).some((c) => c.key === raw && !c.story);
}

export function templateLabel(key: string | null | undefined, kind: TemplateKind = "IMAGE"): string | null {
  const k = currentTemplateKey(key);
  return templateCatalog(kind).find((c) => c.key === k)?.label ?? null;
}

/**
 * The categories a model may pick from for one placement.
 *
 * A placement with a category of its own (a display banner) gets
 * that category and nothing else, because a banner laid out as a square
 * feed post is unusable. Every other placement gets the general categories
 * marked `auto`.
 */
export function autoCandidates(placement: string, kind: TemplateKind = "IMAGE"): TemplateCategory[] {
  const all = templateCatalog(kind);
  const own = all.filter((c) => c.auto && c.only?.includes(placement));
  if (own.length) return own;
  return all.filter((c) => c.auto && !c.only);
}

export type TemplateContext = {
  headline: string;
  body: string;
  cta: string;
  objective: string | null;
  hook: string | null;
  offers: string | null;
  placement: string;
  /** The campaign's name: "Diwali 2026" says festive when the card does not. */
  campaign?: string | null;
};

const has = (text: string, re: RegExp) => re.test(text);

const FESTIVE = /\b(diwali|dhanteras|navratri|dussehra|gudi padwa|akshaya tritiya|ugadi|onam|pongal|ganesh|festive|festival|holi|eid|christmas)\b/;
const OFFER = /\b(offer|discount|waiver|waived|subvention|no pre-?emi|payment plan|20:80|10:90|cashback|free|floor rise|stamp duty|no gst|zero brokerage)\b/;

/**
 * A campaign named for a festival gets the festive look, decided here and not
 * by the model. Asked to choose for "Diwali 2026", the chooser read a card
 * saying "Book a site visit this weekend" and picked site visits twice
 * running, so a Diwali post came out looking like any other week's.
 * An image takes the festive offer when the brief carries an offer and the
 * greeting when it does not. A video has no festive category, so it is chosen
 * as any other. Null otherwise, and for a placement with a category of its
 * own (a display banner).
 */
export function festiveTemplate(c: TemplateContext, kind: TemplateKind = "IMAGE"): string | null {
  if (!FESTIVE.test((c.campaign ?? "").toLowerCase())) return null;
  const all = autoCandidates(c.placement, kind);
  if (all.length === 1 && all[0].only) return null;
  const offer = OFFER.test([c.offers ?? "", c.hook ?? "", c.headline, c.body].join(" ").toLowerCase());
  const key = kind === "IMAGE" ? (offer ? "05-festive-offer" : "06-festive-greeting") : null;
  return key && all.some((x) => x.key === key) ? key : null;
}

/**
 * The fallback choice, by rule, when the model cannot be asked.
 *
 * Reads the card and the brief for the words that name a category. Order
 * matters: a festive line with an offer in it is a festive offer, not an
 * offer; a price with a configuration is a price card. With nothing
 * recognisable it is key highlights, the category that fits any card.
 */
export function ruleTemplate(c: TemplateContext, kind: TemplateKind = "IMAGE"): string {
  const own = autoCandidates(c.placement, kind);
  if (own.length === 1) return own[0].key;
  const t = [c.headline, c.body, c.cta, c.hook ?? "", c.offers ?? "", c.objective ?? "", c.campaign ?? ""].join(" ").toLowerCase();
  const festive = has(t, FESTIVE);
  const offer = has(t, OFFER);
  if (kind === "CAROUSEL") {
    // A carousel is a cover, a slide per signed point and a close, which is
    // the reasons-to-buy shape; the rest are chosen by what the card is about.
    if (offer) return "06-offer-explained";
    // OFF construction: if (has(t, /\b(report|stage|engineering|inspection|quality)\b/) && has(t, /\b(slab|construction|progress|site update|site)\b/)) return "08-site-progress-report";
    // OFF construction: if (has(t, /\b(slab|construction|progress|site update)\b/)) return "07-construction-timeline";
    if (has(t, /\b(architecture|elevation|facade|façade|structural|design language|tower design)\b/)) return "09-architecture-and-elevation";
    if (has(t, /\b(metro|station|highway|airport|minutes from|min from|connectivity|km from|nearby)\b/)) return "03-location-guide";
    if (has(t, /\b(pool|clubhouse|club house|gym|garden|amenit|lifestyle|podium)\b/)) return "04-amenities";
    if (has(t, /\b(tour|walkthrough|take a look|inside)\b/)) return "01-project-tour";
    if (has(t, /\b(feature|highlight|spec|specifications?|advantage|why choose)\b/)) return "10-key-highlights";
    return "05-reasons-to-buy";
  }
  if (kind === "VIDEO") {
    // A video is three frames brought to life: a slow cinematic tour unless
    // the card is plainly about something else.
    // OFF construction: if (has(t, /\b(slab|construction|progress|site update)\b/)) return "06-construction-update";
    if (has(t, /\b(metro|station|highway|airport|minutes from|min from|connectivity|km from|nearby)\b/)) return "12-locality-guide";
    if (has(t, /\b(launch|launching|now open|new launch)\b/)) return "01-launch-film";
    return "18-insta-friendly-cinematic-slow-tour";
  }
  if (festive) return offer ? "05-festive-offer" : "06-festive-greeting";
  if (offer) return "04-offer-and-payment-plan";
  if (has(t, /\b(ready to move|possession|oc received|occupation certificate)\b/)) return "11-ready-to-move-and-possession";
  // OFF construction: if (has(t, /\b(slab|construction|progress|site update)\b/)) return "10-construction-update";
  if (has(t, /\b(site visit|sample flat|open house|launch event|expo|visit us)\b/)) return "12-site-visit-and-events";
  if (has(t, /\b(nri|abroad|overseas|dubai|gulf)\b/)) return "15-nri";
  if (has(t, /\brs\b|₹|\blakh\b|\bcrore\b|\bcr\b/) && has(t, /bhk\b|\brk\b/)) return "03-price-and-configuration";
  if (has(t, /\b(metro|station|highway|airport|minutes from|min from|connectivity|km from)\b/)) return "07-location-and-connectivity";
  if (has(t, /\b(pool|clubhouse|club house|gym|garden|amenit|lifestyle|podium)\b/)) return "08-amenities-and-lifestyle";
  if (has(t, /\b(launch|launching|now open|new launch|coming soon|something new)\b/)) return "01-launch-announcement";
  return "09-key-highlights";
}

/** The instruction for the model that picks a category. */
export function templateChooserPrompt(
  c: TemplateContext,
  kind: TemplateKind = "IMAGE",
  /** Only the categories this card fits and the project can make (`card-angle-rules.ts`). */
  allow?: (key: string) => boolean,
): { system: string; instruction: string; keys: string[] } {
  const options = autoCandidates(c.placement, kind).filter((o) => !allow || allow(o.key));
  const system =
    `You choose the design category for one Indian residential real estate ${kind === "CAROUSEL" ? "carousel " : kind === "VIDEO" ? "video " : ""}advertisement. ` +
    "Pick the category whose purpose best fits what the ad says. Answer with one key from the list.";
  const instruction = [
    `Placement: ${c.placement}`,
    `Headline: ${c.headline}`,
    `Body: ${c.body}`,
    `Call to action: ${c.cta}`,
    c.objective ? `Campaign objective: ${c.objective}` : null,
    c.campaign ? `Campaign: ${c.campaign}` : null,
    c.hook ? `Campaign hook: ${c.hook}` : null,
    c.offers ? `Offers in this campaign: ${c.offers}` : null,
    "",
    "Categories:",
    ...options.map((o) => `- ${o.key}: ${o.label}. ${o.detail}`),
  ]
    .filter((l) => l !== null)
    .join("\n");
  return { system, instruction, keys: options.map((o) => o.key) };
}

/** A model's answer, kept only when it names a category it was offered. */
export function templateFromAnswer(answer: string | null | undefined, offered: readonly string[]): string | null {
  const a = (answer ?? "").trim();
  return offered.includes(a) ? a : null;
}
