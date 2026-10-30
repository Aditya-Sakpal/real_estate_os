"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dismissReelAction, makeOnePostAction, makeReelAction, removePostAction, retryReelAction, reviseFilmAction, stopReelAction } from "@/app/actions/studio";
import {
  BEST_SLIDES,
  DEFAULT_SLIDES,
  jobsFor,
  kindDef,
  MAX_SLIDES,
  MAX_VERSIONS,
  MIN_SLIDES,
  PLACEMENT_SIZE,
  type PostKind,
} from "@/lib/compose-rules";
import { FILM_TEMPLATES, MAX_LIVE_STORIES, PRESENTER_TEMPLATE, STORY_TEMPLATE, reelFormatFor } from "@/lib/reel-choice";
import { FESTIVALS, festivalAsk, festivalIn, templateSizes } from "@/lib/template-rules";
import { cardFits, type CardAngle } from "@/lib/card-angle-core";
import { PublishDialog } from "./PublishDialog";
import { useMediaViewer, type ViewerItem } from "@/components/MediaViewer";
import { MediaThumb, withVariant } from "@/components/MediaThumb";
import { AUTO_FONT, FONTS } from "@/lib/font-rules";
import { isServiceDown } from "@/lib/service-rules";
import { Close, Expand, Play } from "@/components/icons";
import { ConfirmAction } from "@/components/ConfirmAction";

type MakeKind = PostKind;

export type KindOption = {
  key: MakeKind;
  label: string;
  detail: string;
  /** The brief's formats this kind is made in, in order. */
  placements: string[];
  /** Why it cannot be made for this brief, or null. */
  unavailable: string | null;
  /** Where a post in each of those sizes can be published; empty for a print. */
  where: Record<string, string[]>;
};

export type CardOption = {
  id: string;
  label: string;
  headline: string;
  /** What the card is written for, and what a general card leads on: which templates it suits. */
  angle: CardAngle;
  segment: string;
  lead: CardAngle | null;
  invites: boolean;
};

/** A story reel being made, as the worker last reported it. */
export type ReelView = {
  id: string;
  copyId: string;
  placement: string;
  /** A narrated story, or a film from a video template's own skill. */
  format?: "story" | "presenter";
  /** The video template a film is made from, for its label. */
  template?: string | null;
  state: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "STOPPED";
  stage: string;
  progress: number;
  message: string | null;
  postId: string | null;
  /** A new version of an earlier film. */
  revision?: boolean;
};

/**
 * A template category: each design's page versions, in order. An image design
 * is one page; a video design is its poster still, then its clip.
 */
export type TemplateOption = {
  key: string;
  label: string;
  detail: string;
  hot?: boolean;
  story?: boolean;
  designs: string[][];
  /** The card it takes, and why the project cannot make it (an offer, a dated site photo), or null. */
  angle?: CardAngle;
  gap?: string | null;
};

/** The kinds of post that have a template library: every kind. */
type TemplateKind = PostKind;

const AUTO = "auto";
// The file's version rides in the address, so a replaced design is fetched
// fresh rather than served from the browser's cache.
const thumb = (kind: TemplateKind, t: TemplateOption, design: number, page = 0, w?: number) =>
  `/dashboard/campaigns/templates/${t.key}/${design}?v=${t.designs[design]?.[page] ?? ""}` +
  `${kind === "CAROUSEL" ? `&kind=carousel&page=${page}` : kind === "VIDEO" ? "&kind=video" : ""}${w ? `&w=${w}` : ""}`;

/** A video design's preview clip. */
const clip = (t: TemplateOption, design: number) =>
  `/dashboard/campaigns/templates/${t.key}/${design}?kind=video&clip=1&v=${t.designs[design]?.[1] ?? ""}`;

/**
 * What the viewer shows for a template. An image category: its designs, one
 * after another. A carousel design: its pages, in swipe order, which is the
 * only way to see what a carousel template actually is. A video category:
 * its clips, playing.
 */
const templateItems = (kind: TemplateKind, t: TemplateOption, design = 0): ViewerItem[] =>
  kind === "CAROUSEL"
    ? (t.designs[design] ?? []).map((_, p) => ({
        src: thumb(kind, t, design, p, 1600),
        thumb: thumb(kind, t, design, p),
        kind: "image",
        alt: `${t.label}, design ${design + 1}, slide ${p + 1}`,
      }))
    : kind === "VIDEO"
      ? t.designs.map((d, i) =>
          d.length > 1
            ? {
                src: clip(t, i),
                poster: thumb(kind, t, i, 0, 1600),
                thumb: thumb(kind, t, i, 0),
                kind: "video",
                alt: `${t.label}, design ${i + 1}`,
              }
            : { src: thumb(kind, t, i, 0, 1600), thumb: thumb(kind, t, i, 0), kind: "image", alt: `${t.label}, design ${i + 1}` })
      : t.designs.map((_, i) => ({
          src: thumb(kind, t, i, 0, 1600),
          thumb: thumb(kind, t, i, 0),
          kind: "image",
          alt: `${t.label}, design ${i + 1}`,
        }));

/** What following a template means, per kind, in one sentence. */
const FOLLOWS: Record<TemplateKind, string> = {
  IMAGE: "Your post follows these designs\u2019 style, with your own photo, words and RERA details.",
  CAROUSEL: "Each version follows one of these designs, slide by slide, with your own photos, words and RERA details.",
  VIDEO:
    "Each frame of your video follows these designs\u2019 look, with your own photos, words and RERA details, then AI video brings it to life: the sky, light and leaves move while the words stay still.",
};

export type PostView = {
  id: string;
  kindLabel: string;
  placement: string;
  language: string;
  segmentLabel: string;
  headline: string;
  /** `v` changes when a file is replaced, so the browser does not keep showing the old one. */
  media: { type: string; width: number; height: number; v?: string }[];
  /** What the check found. Only posts that passed are listed, films aside; null for one made before posts were checked. */
  review: { passed: boolean; attempts: number } | null;
  /**
   * A film made in one generation. It is listed whatever its checks found,
   * because it was paid for whole: what stops it being published, and what
   * the person should look at.
   */
  film?: { units: number; revision: boolean; problems: string[]; notes: string[] } | null;
  /**
   * What the picture check read off the finished files: PASS publishes, FAIL
   * and HOLD never do, and what it found in the client's words. Null for a
   * post made before pictures were checked, which is made again to publish.
   */
  pixel: { verdict: "PASS" | "FAIL" | "HOLD"; lines: string[] } | null;
  /** The template it followed, and whether a person or the AI picked it. */
  template: { label: string; byAi: boolean } | null;
  /** Where it has been published, and how each stands. */
  publications: { id: string; destination: string; label: string; state: string; stateLabel: string; tone: string; url: string | null }[];
};

/** A post on its way. `paused`: the AI service itself said no, which is not this post's fault. */
/** A Google display or Demand Gen ad shows this square beside the banner. */
const GOOGLE_BANNER = "Google display";
const GOOGLE_SQUARE = "Meta feed 1:1";

/** Each size by where it is used, which is how a person chooses one. */
const SIZE_LABEL: Record<string, string> = {
  "Meta feed 1:1": "Facebook and Instagram feed",
  "Meta story 9:16": "Stories",
  "Google display": "Google ads",
  "Portal listing": "Property portals",
  "Meta reel 9:16": "Reels",
  "YouTube 16:9": "YouTube",
};

/** The sizes each kind of ad shows side by side. */
const AD_SIZES: Record<string, { label: string; placements: string[] }[]> = {
  IMAGE: [
    { label: "For a Meta ad", placements: ["Meta feed 1:1", "Meta story 9:16"] },
  ],
  VIDEO: [
    { label: "For a Meta ad", placements: ["YouTube 16:9", "Meta reel 9:16"] },
    { label: "For YouTube", placements: ["YouTube 16:9"] },
  ],
};

type Pending = { key: string; placement: string; label: string; failed?: string; paused?: boolean; film?: boolean };

/**
 * The event a card's own "Make a post" button sends: the maker opens for
 * that card. The cards are drawn by the page, the maker lives here, and the
 * event is the one thread between them.
 */
export const MAKE_EVENT = "studio:make";

/** A post one press makes: its card, size and version, and the template it follows. */
type Job = { copyId: string; placement: string; version: number; template: string; festival: string | null; format: "story" | "presenter" | null };

/** A job waiting its turn, with the choices it was made with. */
type QueuedJob = Job & { kind: PostKind; slides: number; font: string; key: string; label: string };

/**
 * Make posts, and see them arrive.
 *
 * Each cleared card carries its own "Make a post" button; it opens the maker
 * for that card alone: the kind, a template the card suits, where it goes,
 * and the press. The cards were listed a second time down here, and a list
 * of the same cards twice read as two different things.
 *
 * Pressing Make puts a placeholder where every post will go, at the post's
 * own shape, with a loader in it, and then makes the posts one request at a
 * time. Each placeholder is replaced the moment its post exists, so a batch
 * of videos reads as progress rather than as a frozen button, and Stop lands
 * between two posts rather than after all of them.
 */
export function PostsPanel({
  briefId,
  kinds,
  cards,
  posts,
  briefFormats,
  campaign = "",
  templates,
  reels: initialReels = [],
  mayMake,
  mayRemove,
  mayPublish = false,
  storyCap = MAX_LIVE_STORIES,
  learnedFrom = { ours: 0, market: 0 },
}: {
  briefId: string;
  /** What "Let AI choose" learns from here: our ads it has results for, and competitor ads saved near the project. */
  learnedFrom?: { ours: number; market: number };
  /** Story reels that may run at once; none in development. */
  storyCap?: number;
  kinds: KindOption[];
  /** The brief's story reels in hand or just finished. */
  reels?: ReelView[];
  /** The template library for each kind that has one. */
  templates: Record<TemplateKind, TemplateOption[]>;
  cards: CardOption[];
  posts: PostView[];
  briefFormats: string[];
  /** The campaign's name: "Diwali 2026" picks the festival for a festive template. */
  campaign?: string;
  mayMake: boolean;
  mayRemove: boolean;
  /** Whether this viewer may publish here. The dialog asks every gate again regardless. */
  mayPublish?: boolean;
}) {
  const firstOk = kinds.find((k) => !k.unavailable)?.key ?? "IMAGE";
  const [kind, setKind] = useState<MakeKind>(firstOk);
  const [sizes, setSizes] = useState<string[]>(kinds.find((k) => k.key === firstOk)?.placements ?? []);
  const [versions, setVersions] = useState(1);
  const [slides, setSlides] = useState(DEFAULT_SLIDES);
  const [template, setTemplate] = useState<string>(AUTO);
  // The face stays chosen across kinds: a brand keeps one typeface.
  const [font, setFont] = useState<string>(AUTO_FONT);
  const tplKind: TemplateKind = kind;
  // Hot categories lead; each group keeps the catalog's order.
  // The story's reference films sit on the story's own tile, not in the grid.
  const library = [...(templates[tplKind] ?? [])].filter((t) => !t.story).sort((a, b) => Number(!!b.hot) - Number(!!a.hot));
  const storyFilms = tplKind === "VIDEO" ? (templates.VIDEO ?? []).find((t) => t.story && t.designs.length) ?? null : null;
  // The narrated story and the agent on camera are Video choices a worker
  // makes over half an hour, rather than while the page waits.
  const reelFormat = kind === "VIDEO" ? reelFormatFor(template) : null;
  const story = reelFormat === "story";
  const picked = library.find((t) => t.key === template) ?? null;
  // The card a template takes: a narrated story is a general film.
  const angleOf = (key: string): CardAngle =>
    key === STORY_TEMPLATE.key ? "GENERAL" : library.find((t) => t.key === key)?.angle ?? "GENERAL";
  const fitsTemplate = (c: CardOption, key: string) => key === AUTO || cardFits(c, angleOf(key), key);
  const cardsFor = (key: string) => cards.filter((c) => fitsTemplate(c, key));
  // A template is drawn in its own shapes only: a banner is never a feed
  // post, and a square design never a banner.
  const sizesOf = (key: string) => {
    const all = kinds.find((k) => k.key === kind)?.placements ?? [];
    return library.some((t) => t.key === key) ? templateSizes(key, kind, all) : all;
  };
  const fitSizes = sizesOf(template);
  // A festive template asks which festival, starting on the one the
  // campaign's name gives ("Diwali 2026"), and makes nothing until one is chosen.
  const [festival, setFestival] = useState<string>(festivalIn(campaign)?.key ?? "");
  const askFestival = picked ? festivalAsk(picked.key, kind) : null;
  const needsFestival = askFestival === "required" && !festival;
  const { open: view, viewer } = useMediaViewer();
  // The card a post is being made from: its own "Make a post" button opens
  // the maker for it. None is open to start.
  const [card, setCard] = useState<string | null>(null);
  const cardNow = cards.find((c) => c.id === card) ?? null;
  const [pending, setPending] = useState<Pending[]>([]);
  // Where the press lands: the status bar is scrolled to and lit up, because
  // a faint line under the cards read as nothing having happened.
  const statusRef = useRef<HTMLDivElement | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const stopRef = useRef(false);
  const current = kinds.find((k) => k.key === kind);
  const templateLabel = (key: string) =>
    key === AUTO
      ? "Let AI choose"
      : key === STORY_TEMPLATE.key
        ? STORY_TEMPLATE.label
        : library.find((t) => t.key === key)?.label ?? key;

  // Reels are made by a worker for twenty minutes and more, so the page
  // asks how they are getting on rather than waiting on a request, and
  // shows the new post the moment one is done.
  const router = useRouter();
  const [reels, setReels] = useState<ReelView[]>(initialReels);
  // The poll compares against the reels as they stand, read here rather than
  // inside a state updater: React runs an updater while rendering, and a
  // router refresh from inside one is an update to another component.
  const reelsNow = useRef(reels);
  reelsNow.current = reels;
  const [hidden, setHidden] = useState<string[]>([]);
  const live = reels.some((r) => r.state === "QUEUED" || r.state === "RUNNING");
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/dashboard/campaigns/brief/${briefId}/studio/reels`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok) return;
      const next = ((await res.json()) as { reels: ReelView[] }).reels;
      const prev = reelsNow.current;
      const finished = next.some((r) => r.state === "DONE" && prev.find((p) => p.id === r.id)?.state !== "DONE");
      setReels(next);
      if (finished) router.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [live, briefId, router]);

  // What this card makes with the choices in the maker: each size the
  // template is drawn in, in as many versions as asked.
  const queueRef = useRef<QueuedJob[]>([]);
  const queuedFilms = () => queueRef.current.filter((j) => j.format).length;
  // Only so many films are made at once, so the button offers the ones that
  // will start rather than a number the server will cut.
  const storyRoom = Math.max(0, storyCap - reels.filter((r) => r.state === "QUEUED" || r.state === "RUNNING").length - queuedFilms());
  const ticked = sizes.filter((p) => current?.placements.includes(p) && fitSizes.includes(p));
  // Google ads need the square beside the banner, so choosing Google ads makes
  // both. A template drawn only as a banner leaves the square to the AI's choice.
  const googleSquare = ticked.includes(GOOGLE_BANNER) && !ticked.includes(GOOGLE_SQUARE) && !!current?.placements.includes(GOOGLE_SQUARE);
  const squareOwn = googleSquare && fitSizes.includes(GOOGLE_SQUARE);
  const made = squareOwn ? [...ticked, GOOGLE_SQUARE] : ticked;
  // A video is always a film, so "Let AI choose" and the narrated story are
  // open only when some film goes with the card in hand: a festive greeting
  // or a construction update has none of its own among the stories.
  const filmKeys = [STORY_TEMPLATE.key, ...library.filter((t) => FILM_TEMPLATES[t.key] && !FILM_TEMPLATES[t.key].never && !t.gap).map((t) => t.key)];
  const autoOff = kind === "VIDEO" && !!cardNow && !filmKeys.some((k) => fitsTemplate(cardNow, k));
  const storyOff = !cardNow || !fitsTemplate(cardNow, STORY_TEMPLATE.key);
  const asked: Job[] = cardNow && !(template === AUTO && autoOff)
    ? jobsFor({ kind, copyIds: [cardNow.id], placements: made, briefFormats, versions }).map((j) => ({
        ...j,
        template,
        festival: askFestival && festival ? festival : null,
        // Every video is a Seedance film: "Let AI choose" is one too, the server choosing which.
        format: kind === "VIDEO" ? reelFormatFor(template) ?? "presenter" : null,
      })).concat(
        googleSquare && !squareOwn
          ? jobsFor({ kind, copyIds: [cardNow.id], placements: [GOOGLE_SQUARE], briefFormats, versions }).map((j) => ({
              ...j,
              template: AUTO,
              festival: null,
              format: null,
            }))
          : [],
      )
    : [];
  const jobs = (() => {
    let room = storyRoom;
    return asked.filter((j) => !j.format || room-- > 0);
  })();
  const makeNoun =
    kind === "CAROUSEL"
      ? { one: "carousel", many: "carousels" }
      : kind === "VIDEO"
        ? { one: "video", many: "videos" }
        : { one: "image post", many: "image posts" };
  // One Google ad is two pictures, so the press counts ads, not pictures.
  const makeLabel =
    googleSquare && ticked.length === 1 && jobs.length === 2 * versions
      ? `Make ${versions === 1 ? "the Google ad" : `${versions} Google ads`} (banner and square)`
      : `Make ${jobs.length} ${jobs.length === 1 ? makeNoun.one : makeNoun.many}`;

  // The maker is a dialog per card, opened from the card's own button: the
  // kind, the template, the sizes and the press, all in one place, with the
  // press always in view at its foot.
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (card && !d.open) d.showModal();
    if (!card && d.open) d.close();
  }, [card]);
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const c = cards.find((x) => x.id === id);
      if (!c) return;
      // A template chosen for the last card may not suit this one.
      const t = fitsTemplate(c, template) ? template : AUTO;
      setTemplate(t);
      // One size ticked to start, so the press reads "Make 1"; a person ticks more.
      const fit = sizesOf(t);
      setSizes((xs) => {
        const keep = xs.filter((p) => fit.includes(p));
        return keep.length ? keep.slice(0, 1) : fit.slice(0, 1);
      });
      setCard(id);
    };
    window.addEventListener(MAKE_EVENT, open);
    return () => window.removeEventListener(MAKE_EVENT, open);
  });

  const pickKind = (k: KindOption) => {
    setKind(k.key);
    setSizes(k.placements.slice(0, 1));
    // Each kind has its own library, so a choice never carries across.
    setTemplate(AUTO);
  };
  // Choosing a template keeps the sizes it is drawn in, or ticks all of them
  // when none of the ones ticked fit.
  const pickTemplate = (key: string) => {
    setTemplate(key);
    const fit = sizesOf(key);
    setSizes((xs) => {
      const keep = xs.filter((p) => fit.includes(p));
      return keep.length ? keep : fit;
    });
  };

  // Posts are made one at a time from a queue, so a person can open the next
  // card's maker while the last card's posts are still being designed.
  const tally = useRef({ made: 0, failed: 0, films: 0, error: "" });
  const work = async () => {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    stopRef.current = false;
    setStopping(false);
    tally.current = { made: 0, failed: 0, films: 0, error: "" };
    let halted: string | null = null;
    while (queueRef.current.length && !stopRef.current) {
      const j = queueRef.current.shift()!;
      if (j.format) {
        const r = await makeReelAction({
          briefId,
          copyId: j.copyId,
          placement: j.placement,
          format: j.format,
          template: j.format === "presenter" ? j.template : null,
          font: j.font,
        }).catch(() => ({ ok: false, message: "The server stopped answering. Try it again." }));
        if (r.ok) tally.current.films += 1;
        else tally.current.error = r.message;
        const res = await fetch(`/dashboard/campaigns/brief/${briefId}/studio/reels`, { cache: "no-store" }).catch(() => null);
        if (res?.ok) setReels(((await res.json()) as { reels: ReelView[] }).reels);
        // The video's own card takes over from its placeholder; a refusal stays, saying why.
        setPending((xs) => (r.ok ? xs.filter((x) => x.key !== j.key) : xs.map((x) => (x.key === j.key ? { ...x, failed: r.message } : x))));
        continue;
      }
      const result = await makeOnePostAction({
        briefId,
        kind: j.kind,
        copyId: j.copyId,
        placement: j.placement,
        template: j.template,
        slides: j.kind === "CAROUSEL" ? j.slides : undefined,
        font: j.font,
        festival: j.festival ?? undefined,
      }).catch((): { ok: boolean; passed?: boolean; message: string; code?: string } => ({
        ok: false,
        message: "The server stopped answering before this post came back. Try it again.",
      }));
      if (result.ok) {
        tally.current.made += 1;
        setPending((xs) => xs.filter((x) => x.key !== j.key));
      } else if (isServiceDown(result.code)) {
        // The service is out (of credits, or altogether), and it will say the
        // same to every post after this one, so the queue stops here.
        halted = result.message;
        setPending((xs) => xs.map((x) => (x.key === j.key ? { ...x, failed: result.message, paused: true } : x)));
        break;
      } else {
        tally.current.failed += 1;
        tally.current.error = result.message;
        setPending((xs) => xs.map((x) => (x.key === j.key ? { ...x, failed: result.message } : x)));
      }
    }
    // Whatever never started, because Stop was pressed or the service is out, simply goes.
    const notStarted = queueRef.current.length;
    queueRef.current = [];
    setPending((xs) => xs.filter((x) => x.failed));
    const t = tally.current;
    const filmLine = t.films
      ? `${t.films} ${t.films === 1 ? "video" : "videos"} started. Each takes 20 to 40 minutes; you can leave this page.`
      : null;
    setNote({
      ok: t.failed === 0 && !halted && !t.error,
      text: [
        halted,
        stopRef.current ? "Stopped." : null,
        t.made ? `${t.made} ${t.made === 1 ? "post" : "posts"} made.` : null,
        filmLine,
        notStarted && (halted || stopRef.current) ? `${notStarted} not started.` : null,
        !halted && (t.failed || t.error) ? `Some could not be made: ${t.error}` : null,
      ]
        .filter(Boolean)
        .join(" "),
    });
    setStopping(false);
    workingRef.current = false;
    setWorking(false);
    // revalidatePath alone does not update this client's posts prop.
    if (t.made > 0) router.refresh();
  };

  // The press: this card's posts join the queue, the maker closes, and the
  // placeholders appear in the grid at once.
  const make = () => {
    if (!cardNow || !jobs.length || needsFestival) return;
    const what = kind === "CAROUSEL" ? `${current?.label ?? ""} of ${slides}` : current?.label ?? "";
    const stamp = Date.now();
    const queued: QueuedJob[] = jobs.map((j, i) => ({
      ...j,
      kind,
      slides,
      font,
      key: `${stamp}-${i}`,
      label: `${what} · ${templateLabel(j.template)} · ${j.placement} · ${cardNow.label}`,
    }));
    queueRef.current.push(...queued);
    setPending((xs) => [...xs, ...queued.map((j) => ({ key: j.key, placement: j.placement, label: j.label, film: !!j.format }))]);
    setNote(null);
    setCard(null);
    if (!workingRef.current) void work();
    requestAnimationFrame(() => statusRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  // The card to point at for a template this one does not suit: one in the
  // same language first, so an English card is never sent to a Hindi one.
  const suggest = (key: string) => {
    const fits = cardsFor(key);
    const lang = cardNow?.label.split(" · ")[0];
    return fits.find((c) => c.label.split(" · ")[0] === lang) ?? fits[0] ?? null;
  };
  const tileCopy = (t: TemplateOption) => {
    const film = kind === "VIDEO" ? FILM_TEMPLATES[t.key] ?? null : null;
    const never = film?.never ?? null;
    const gap = t.gap ?? null;
    const noCard = !gap && !never && cardsFor(t.key).length === 0;
    // Only templates the card in hand suits can be picked for it.
    const notThis = !gap && !never && !noCard && !!cardNow && !fitsTemplate(cardNow, t.key);
    const off = sizesOf(t.key).length === 0 || !!never || !!gap || noCard || notThis;
    const needs = templateSizes(t.key, kind, kindDef(kind).placements);
    const line =
      never ??
      gap ??
      (noCard
        ? "No cleared card for it yet"
        : notThis
          ? `Use the “${suggest(t.key)?.headline ?? ""}” card`
          : off
            ? `Needs the ${needs.join(" or ")} size`
            : film
              ? `${film.seconds}-second film`
              : `${t.designs.length} designs`);
    // Said on hover, in full: why this template cannot be picked for this card.
    const why = !off
      ? null
      : notThis
        ? `This template doesn’t go with this card. Use the “${suggest(t.key)?.headline ?? ""}” card for it.`
        : never ?? gap ?? (noCard ? "None of your cleared cards goes with this template yet." : `Needs the ${needs.join(" or ")} size, which this campaign does not have.`);
    return { off, line, never, gap, why };
  };

  return (
    <>
      {mayMake && (
        <dialog
          ref={dialogRef}
          className="mv tpldlg"
          aria-labelledby="maker-title"
          onClose={() => setCard(null)}
          onClick={(e) => {
            if (e.target === e.currentTarget) setCard(null);
          }}
          data-maker
        >
          <div className="mv-form">
            <div className="mv-head">
              <div>
                <h2 id="maker-title">
                  Make a <span className="em">post</span>
                </h2>
                <p className="mv-sub">
                  From “{cardNow?.headline ?? ""}” · {cardNow?.label ?? ""}
                </p>
              </div>
              <button type="button" className="btn btn--icon" onClick={() => setCard(null)} aria-label="Close">
                <Close size={14} />
              </button>
            </div>
            <div className="mv-body maker">
              <div className="maker__kinds seg" role="radiogroup" aria-label="Kind of post">
                {kinds.map((k) => (
                  <button
                    key={k.key}
                    type="button"
                    role="radio"
                    aria-checked={kind === k.key}
                    aria-pressed={kind === k.key}
                    className="seg__opt"
                    disabled={!!k.unavailable}
                    title={k.unavailable ?? k.detail}
                    onClick={() => pickKind(k)}
                    data-kind={k.key}
                  >
                    {k.label}
                  </button>
                ))}
              </div>

              {library.length > 0 && (
                <fieldset className={`tplpick ${tplKind === "IMAGE" ? "" : "tplpick--tall"}`} data-templates={tplKind}>
                  <legend className="maker__label">Template</legend>
                  <div className="tplpick__grid" role="radiogroup" aria-label="Template">
                    <label className={`tpltile tpltile--auto ${template === AUTO ? "tpltile--on" : ""} ${autoOff ? "tpltile--off" : ""}`}>
                      {autoOff && (
                        <span className="tpltile__why" role="note">
                          No video goes with this card. Use a card that sells the project.
                        </span>
                      )}
                      <input type="radio" name="template" value={AUTO} checked={template === AUTO} disabled={autoOff} onChange={() => pickTemplate(AUTO)} />
                      <span className="tpltile__art tpltile__art--auto" aria-hidden="true">
                        <span>AI</span>
                      </span>
                      <strong>Let AI choose</strong>
                      <small>{autoOff ? "No video for this card" : learnedFrom.ours || learnedFrom.market ? "Picks from what works" : "Best fit for this card"}</small>
                    </label>
                    {tplKind === "VIDEO" && (
                      <label className={`tpltile tpltile--auto ${story ? "tpltile--on" : ""} ${storyOff ? "tpltile--off" : ""}`} data-template={STORY_TEMPLATE.key}>
                        {storyOff && (
                          <span className="tpltile__why" role="note">
                            {suggest(STORY_TEMPLATE.key)
                              ? `This story doesn’t go with this card. Use the “${suggest(STORY_TEMPLATE.key)!.headline}” card for it.`
                              : "None of your cleared cards goes with this story yet."}
                          </span>
                        )}
                        <input
                          type="radio"
                          name="template"
                          value={STORY_TEMPLATE.key}
                          checked={story}
                          disabled={storyOff}
                          onChange={() => pickTemplate(STORY_TEMPLATE.key)}
                        />
                        {storyFilms ? (
                          <span className="tpltile__art">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={thumb(tplKind, storyFilms, 0)} alt="" loading="lazy" />
                            <button
                              type="button"
                              className="tpltile__zoom"
                              aria-label={`View ${STORY_TEMPLATE.label} examples`}
                              onClick={(e) => {
                                // Inside the label: viewing is not choosing.
                                e.preventDefault();
                                e.stopPropagation();
                                view(templateItems(tplKind, storyFilms), 0, `${STORY_TEMPLATE.label} examples`);
                              }}
                              data-view-template
                            >
                              <Expand size={15} />
                            </button>
                          </span>
                        ) : (
                          <span className="tpltile__art tpltile__art--auto" aria-hidden="true">
                            <span>Story</span>
                          </span>
                        )}
                        <strong>{STORY_TEMPLATE.label}</strong>
                        <small>
                          {storyOff
                            ? suggest(STORY_TEMPLATE.key)
                              ? `Use the “${suggest(STORY_TEMPLATE.key)!.headline}” card`
                              : "No cleared card for it yet"
                            : "30-second film, narrator and music"}
                        </small>
                      </label>
                    )}
                    {library.map((t) => {
                      const { off, line, never, gap, why } = tileCopy(t);
                      return (
                        <label
                          key={t.key}
                          className={`tpltile ${template === t.key ? "tpltile--on" : ""} ${off ? "tpltile--off" : ""}`}
                          title={off ? undefined : t.detail}
                          data-template={t.key}
                        >
                          {why && (
                            <span className="tpltile__why" role="note">
                              {why}
                            </span>
                          )}
                          <input
                            type="radio"
                            name="template"
                            value={t.key}
                            checked={template === t.key}
                            disabled={off}
                            onChange={() => pickTemplate(t.key)}
                          />
                          <span className="tpltile__art">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={thumb(tplKind, t, 0)} alt="" loading="lazy" />
                            {t.hot && <span className="tpltile__hot">Hot</span>}
                            <button
                              type="button"
                              className="tpltile__zoom"
                              aria-label={`View ${t.label} designs`}
                              onClick={(e) => {
                                // Inside the label: viewing is not choosing.
                                e.preventDefault();
                                e.stopPropagation();
                                view(templateItems(tplKind, t), 0, `${t.label} template`);
                              }}
                              data-view-template
                            >
                              <Expand size={15} />
                            </button>
                          </span>
                          <strong>{t.label}</strong>
                          <small>{line}</small>
                        </label>
                      );
                    })}
                  </div>
                  {template === AUTO && !autoOff && (
                    <div className="tplpick__detail" data-template-detail data-ai-choice>
                      <p>
                        <strong>Let AI choose.</strong>{" "}
                        {learnedFrom.ours || learnedFrom.market
                          ? `Picks the template for this card from ${[
                              learnedFrom.ours ? `what has brought you buyers (${learnedFrom.ours} ${learnedFrom.ours === 1 ? "ad" : "ads"})` : null,
                              learnedFrom.market ? `${learnedFrom.market} competitor ${learnedFrom.market === 1 ? "ad" : "ads"} saved for this area` : null,
                            ]
                              .filter(Boolean)
                              .join(" and ")}, and now and then tries something new.`
                          : "Picks the template that best fits this card. Once your ads bring buyers, or you save competitor ads in Library, it picks from what works."}
                      </p>
                    </div>
                  )}
                  {story && (
                    <div className="tplpick__detail" data-template-detail>
                      <p>
                        <strong>{STORY_TEMPLATE.label}.</strong> {STORY_TEMPLATE.detail}
                      </p>
                      {storyFilms && (
                        <div className="tplpick__strip" data-story-films>
                          {storyFilms.designs.map((_, i) => (
                            <button
                              key={i}
                              type="button"
                              className="mediabtn"
                              aria-label={`View ${STORY_TEMPLATE.label}, example ${i + 1}`}
                              onClick={() => view(templateItems(tplKind, storyFilms), i, `${STORY_TEMPLATE.label} examples`)}
                              data-view-design
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={thumb(tplKind, storyFilms, i)} alt={`${STORY_TEMPLATE.label}, example ${i + 1}`} loading="lazy" />
                              <span className="tplpick__play" aria-hidden="true">
                                <Play size={14} />
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {picked && (
                    <div className="tplpick__detail" data-template-detail>
                      <p>
                        <strong>{picked.label}.</strong>{" "}
                        {picked.key === PRESENTER_TEMPLATE.key
                          ? PRESENTER_TEMPLATE.detail
                          : kind === "VIDEO" && FILM_TEMPLATES[picked.key]
                            ? `${picked.detail} One ${FILM_TEMPLATES[picked.key].seconds}-second film. Takes about 20 to 30 minutes to make.`
                            : `${picked.detail} ${FOLLOWS[tplKind]}`}
                      </p>
                      {askFestival && (
                        <label className="tplpick__festival">
                          <span>Festival{askFestival === "optional" ? <small> Optional</small> : null}</span>
                          <select className="select-field" value={festival} onChange={(e) => setFestival(e.target.value)} data-festival>
                            <option value="">{askFestival === "required" ? "Choose a festival" : "None"}</option>
                            {FESTIVALS.map((f) => (
                              <option key={f.key} value={f.key}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <div className="tplpick__strip">
                        {picked.designs.map((pages, i) => (
                          <button
                            key={i}
                            type="button"
                            className="mediabtn"
                            aria-label={`View ${picked.label}, design ${i + 1}`}
                            onClick={() =>
                              tplKind === "CAROUSEL"
                                ? view(templateItems(tplKind, picked, i), 0, `${picked.label}, design ${i + 1}`)
                                : view(templateItems(tplKind, picked), i, `${picked.label} template`)
                            }
                            data-view-design
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={thumb(tplKind, picked, i)} alt={`${picked.label}, design ${i + 1}`} loading="lazy" />
                            {tplKind === "CAROUSEL" && <span className="tplpick__pages">{pages.length} slides</span>}
                            {tplKind === "VIDEO" && (
                              <span className="tplpick__play" aria-hidden="true">
                                <Play size={14} />
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </fieldset>
              )}

              <fieldset className="maker__where" data-sizes>
                <legend className="maker__label">Where it goes</legend>
                {(() => {
                  // The sizes each kind of ad shows together, so one press makes
                  // every version an ad needs.
                  const presets = (AD_SIZES[kind] ?? []).filter((x) => x.placements.every((p) => fitSizes.includes(p)));
                  if (!presets.length) return null;
                  return (
                    <span className="seg seg--sm makeposts__presets" role="group" aria-label="Sizes for an ad">
                      {presets.map((x) => {
                        const on = x.placements.length === ticked.length && x.placements.every((p) => ticked.includes(p));
                        return (
                          <button key={x.label} type="button" className="seg__opt" aria-pressed={on} onClick={() => setSizes(x.placements)} data-sizes-for={x.label}>
                            {x.label}
                          </button>
                        );
                      })}
                    </span>
                  );
                })()}
                <div className="maker__sizes">
                  {(current?.placements ?? []).map((p) => {
                    const fits = fitSizes.includes(p);
                    const to = current?.where[p] ?? [];
                    return (
                      <label
                        key={p}
                        className={`sizechip ${fits ? "" : "sizechip--off"}`}
                        title={fits ? (to.length ? `Publish to ${to.join(", ")}` : undefined) : `${picked?.label ?? "This template"} is not made in this size.`}
                        data-size={p}
                      >
                        <input
                          type="checkbox"
                          checked={fits && sizes.includes(p)}
                          disabled={!fits}
                          onChange={(e) => setSizes((xs) => (e.target.checked ? [...xs, p] : xs.filter((x) => x !== p)))}
                        />
                        <span>{SIZE_LABEL[p] ?? p}</span>
                      </label>
                    );
                  })}
                </div>
                {googleSquare && (
                  <p className="makeposts__hint" data-google-square>
                    Google ads show a banner and a square, so both are made.
                  </p>
                )}
              </fieldset>

              <div className="maker__options">
                {kind === "CAROUSEL" && (
                  <label className="makeposts__versions">
                    <span>
                      Slides{" "}
                      <small className="makeposts__hint">
                        {BEST_SLIDES.from} to {BEST_SLIDES.to} works best
                      </small>
                    </span>
                    <select value={slides} onChange={(e) => setSlides(Number(e.target.value))} className="select-field" data-slides>
                      {Array.from({ length: MAX_SLIDES - MIN_SLIDES + 1 }, (_, i) => MIN_SLIDES + i).map((n) => (
                        <option key={n} value={n}>
                          {n}
                          {n === DEFAULT_SLIDES ? " (recommended)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="makeposts__versions">
                  <span>Versions of each</span>
                  <select value={versions} onChange={(e) => setVersions(Number(e.target.value))} className="select-field" data-versions>
                    {Array.from({ length: MAX_VERSIONS }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="makeposts__versions">
                  <span>Font</span>
                  <select value={font} onChange={(e) => setFont(e.target.value)} className="select-field" data-font-select>
                    <option value={AUTO_FONT}>Let AI choose</option>
                    {FONTS.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label} · {f.mood}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div className="mv-foot">
              {asked.length > jobs.length && (
                <span className="mv-foot__note" data-story-cap>
                  {storyRoom
                    ? `${storyCap} films at a time, so only ${storyRoom} will start.`
                    : `${storyCap} films are being made. Wait for one to finish.`}
                </span>
              )}
              <button type="button" className="btn btn--ghost" onClick={() => setCard(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--ink"
                disabled={!jobs.length || needsFestival || !cardNow || !fitsTemplate(cardNow, template)}
                onClick={make}
                data-make
              >
                {needsFestival ? "Choose a festival first" : !ticked.length ? "Tick where it goes" : makeLabel}
              </button>
            </div>
          </div>
        </dialog>
      )}

      {(working || note) && (
        <div className={`makeposts__go ${working ? "makeposts__go--live" : ""}`} ref={statusRef} data-make-status>
          {working &&
            (() => {
              const live = pending.filter((x) => !x.failed);
              const films = live.filter((x) => x.film).length;
              const stills = live.length - films;
              const what = [stills ? `${stills} ${stills === 1 ? "post" : "posts"}` : "", films ? `${films} ${films === 1 ? "video" : "videos"}` : ""]
                .filter(Boolean)
                .join(" and ");
              return (
                <>
                  <span className="spinner" aria-hidden="true" />
                  <span className="makeposts__say" role="status">
                    <strong>{stopping ? "Stopping after this one" : `Making ${what || "your posts"}`}</strong>
                    <small>
                      {films
                        ? "A video takes 20 to 30 minutes. It keeps going if you leave this page; it appears below when it is ready."
                        : "Each post takes a minute or two. It appears below when it is ready. You can open another card meanwhile."}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={stopping}
                    onClick={() => {
                      stopRef.current = true;
                      setStopping(true);
                    }}
                    data-stop-posts
                  >
                    {stopping ? "Stopping" : "Stop"}
                  </button>
                </>
              );
            })()}
          {note && !working && (
            <span className={`studionote ${note.ok ? "" : "studionote--risk"}`} role="status" data-made>
              {note.text}
            </span>
          )}
        </div>
      )}

      {(pending.length > 0 || posts.length > 0 || reels.some((r) => r.state !== "DONE")) && (
        <div className="postgrid">
          {reels
            .filter((r) => r.state !== "DONE" && !hidden.includes(r.id))
            .map((r) => (
              <ReelTile
                key={r.id}
                reel={r}
                label={
                  r.format !== "presenter" || r.template === STORY_TEMPLATE.key
                    ? STORY_TEMPLATE.label
                    : (templates.VIDEO ?? []).find((t) => t.key === (r.template ?? PRESENTER_TEMPLATE.key))?.label ?? PRESENTER_TEMPLATE.label
                }
                card={cards.find((c) => c.id === r.copyId)?.label ?? ""}
                onStop={async () => {
                  // Said at once: the stop is a round trip, and a button that
                  // shows nothing for that long reads as a frozen page.
                  setReels((xs) => xs.map((x) => (x.id === r.id ? { ...x, stage: "Stopping" } : x)));
                  await stopReelAction({ briefId, jobId: r.id }).catch(() => null);
                }}
                onDismiss={() => {
                  setHidden((xs) => [...xs, r.id]);
                  // Kept on the job, so the card does not come back on the next load.
                  void dismissReelAction({ briefId, jobId: r.id }).catch(() => null);
                }}
                onRetry={async () => {
                  const res = await retryReelAction({ briefId, jobId: r.id }).catch(() => ({ ok: false }));
                  // A refusal says so, never a card that starts and falls back to where it was.
                  setReels((xs) =>
                    xs.map((x) =>
                      x.id !== r.id
                        ? x
                        : res.ok
                          ? { ...x, state: "QUEUED", stage: "Waiting to start", progress: 0, message: null }
                          : { ...x, message: "This video could not be started again. Make a new one from the card." },
                    ),
                  );
                }}
              />
            ))}
          {pending.map((p) => {
            const s = PLACEMENT_SIZE[p.placement] ?? { w: 1, h: 1 };
            return (
              <figure className="posttile posttile--pending" key={p.key} data-pending>
                <div className="posttile__media" style={{ aspectRatio: `${s.w} / ${s.h}` }}>
                  {p.failed ? (
                    <span className={`posttile__failed ${p.paused ? "posttile__failed--paused" : ""}`} role="alert">
                      {p.failed}
                    </span>
                  ) : (
                    <>
                      <span className="spinner" role="status" aria-label={p.film ? "Starting this video" : "Designing and checking this post"} />
                      <span className="posttile__wait">{p.film ? "Starting the video" : "Designing and checking"}</span>
                    </>
                  )}
                </div>
                <figcaption className="posttile__foot">
                  <span className="posttile__what">
                    <small>{p.label}</small>
                  </span>
                  {p.failed && (
                    <button
                      type="button"
                      className="reftile__remove"
                      onClick={() => setPending((xs) => xs.filter((x) => x.key !== p.key))}
                    >
                      Dismiss
                    </button>
                  )}
                </figcaption>
              </figure>
            );
          })}
          {posts.map((post) => (
            <PostTile
              key={post.id}
              post={post}
              briefId={briefId}
              mayRemove={mayRemove}
              mayPublish={mayPublish}
              onView={view}
              onRevise={
                mayMake && post.film
                  ? async (note) => {
                      const r = await reviseFilmAction({ briefId, postId: post.id, note }).catch(() => ({
                        ok: false,
                        message: "The server stopped answering. Try it again.",
                      }));
                      if (r.ok) {
                        const res = await fetch(`/dashboard/campaigns/brief/${briefId}/studio/reels`, { cache: "no-store" }).catch(() => null);
                        if (res?.ok) setReels(((await res.json()) as { reels: ReelView[] }).reels);
                      }
                      return r;
                    }
                  : null
              }
            />
          ))}
        </div>
      )}
      {viewer}
    </>
  );
}

/**
 * One made post: its first frame (or its clip), what it is, and where it
 * goes. A carousel shows its slides as a strip so the whole thing can be read
 * before it is downloaded.
 */
function PostTile({
  post,
  briefId,
  mayRemove,
  mayPublish,
  onView,
  onRevise,
}: {
  post: PostView;
  briefId: string;
  mayRemove: boolean;
  mayPublish: boolean;
  onView: (items: ViewerItem[], index: number, title: string, opts?: { downloadAll?: string | null }) => void;
  /** Ask for a new version of a film, or null where there is none to ask for. */
  onRevise?: ((note: string) => Promise<{ ok: boolean; message: string }>) | null;
}) {
  // The file's own version rides in the address: the route's answer is kept by
  // the browser for the hour, so a film whose voice was put right on 21 October
  // 2026 kept playing the old one under the same address.
  const src = (i: number) => {
    const v = post.media[i]?.v;
    return `/dashboard/campaigns/brief/${briefId}/studio/post/${post.id}/${i}${v ? `?f=${encodeURIComponent(v)}` : ""}`;
  };
  const dl = (i: number) => `${src(i)}${src(i).includes("?") ? "&" : "?"}download=1`;
  const film = post.film ?? null;
  const pixel = post.pixel;
  // A film that did not pass is shown, and never offered for publishing;
  // nor is a picture the picture check did not clear.
  const blocked = (!!film && post.review?.passed === false) || pixel?.verdict === "FAIL";
  const waiting = !blocked && pixel?.verdict === "HOLD";
  const unchecked = !blocked && !pixel;
  const publishable = !blocked && pixel?.verdict === "PASS";
  // What the picture check found, once, where the film's own findings do not already say it.
  const pixelLines = pixel && pixel.verdict !== "PASS" ? pixel.lines.filter((l) => !film?.problems.includes(l)) : [];
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<{ ok: boolean; message: string } | null>(null);
  // A set of slides downloads as one file too: nobody wants to save five.
  const zip = post.media.length > 1 ? `/dashboard/campaigns/brief/${briefId}/studio/post/${post.id}/zip` : null;
  const first = post.media[0];
  const ratio = first ? `${first.width} / ${first.height}` : "1 / 1";
  // Every post here passed its check, films aside: one that did not is never saved.
  const items: ViewerItem[] = post.media.map((m, i) => ({
    // A video plays its 720p preview here; the download is the original.
    src: m.type === "video/mp4" ? withVariant(src(i), "preview") : src(i),
    kind: m.type === "video/mp4" ? "video" : "image",
    alt: post.media.length > 1 ? `Slide ${i + 1}` : post.headline,
    download: dl(i),
  }));
  const title = `${post.kindLabel} · ${post.placement} · ${post.language}`;
  return (
    <figure
      className="posttile"
      data-post={post.kindLabel}
      data-passed={post.review ? String(post.review.passed) : "unchecked"}
      data-pixel={pixel?.verdict ?? "unchecked"}
    >
      <button
        type="button"
        className="posttile__media mediabtn"
        style={{ aspectRatio: ratio }}
        aria-label={`View ${post.kindLabel.toLowerCase()} full size`}
        onClick={() => onView(items, 0, title, { downloadAll: zip })}
        disabled={!first}
        data-view-post
      >
        {first?.type === "video/mp4" ? (
          <>
            {/* `#t=0.6`: every clip fades in from black, so frame zero is black
                and a list of them read as empty boxes. Half a second in is the
                post. It plays in the viewer, with its controls. */}
            <MediaThumb src={src(0)} video />
            <span className="mediabtn__play" aria-hidden="true">
              <Play size={22} />
            </span>
          </>
        ) : first ? (
          <MediaThumb src={src(0)} video={false} alt={post.headline} />
        ) : null}
        <span className="mediabtn__zoom" aria-hidden="true">
          <Expand size={15} />
        </span>
      </button>
      {post.media.length > 1 && (
        <div className="posttile__strip">
          {post.media.map((_, i) => (
            <button
              key={i}
              type="button"
              className="mediabtn"
              aria-label={`View slide ${i + 1}`}
              onClick={() => onView(items, i, title)}
            >
              <MediaThumb src={src(i)} video={false} alt={`Slide ${i + 1}`} />
            </button>
          ))}
        </div>
      )}
      <figcaption className="posttile__foot">
        <span className="posttile__what">
          <strong>
            {post.kindLabel}
            {post.media.length > 1 ? `, ${post.media.length} slides` : ""}
          </strong>
          <small>
            {post.placement} · {post.language} · {post.segmentLabel}
          </small>
          {post.template && (
            <small className="posttile__tpl">
              {post.template.label}
              {post.template.byAi ? ", chosen by AI" : ""}
            </small>
          )}
          {film?.revision && <small>New version, counted as {film.units} videos</small>}
          {blocked ? (
            <span className="pill pill--risk">Not cleared to publish</span>
          ) : waiting ? (
            <span className="pill pill--warn">Waiting for a person</span>
          ) : unchecked ? (
            <span className="pill pill--quiet">Made before picture checks. Make it again to publish</span>
          ) : (
            <span className="pill pill--ok">Checked</span>
          )}
          {pixelLines.length > 0 && (
            <ul className="posttile__findings" data-pixel-findings>
              {pixelLines.map((l) => (
                <li key={l} className={`posttile__finding${pixel?.verdict === "FAIL" ? " posttile__finding--risk" : ""}`}>
                  {l}
                </li>
              ))}
            </ul>
          )}
          {/* A film is handed over finished (the client, 2 October 2026): what
              its checks found was put right by a second film before it got
              here, and what is left stays on the record, not on the tile. An
              older film that never passed still says why. */}
          {film && blocked && film.problems.length > 0 && (
            <ul className="posttile__findings" data-film-findings>
              {film.problems.map((p) => (
                <li key={p} className="posttile__finding posttile__finding--risk">
                  {p}
                </li>
              ))}
            </ul>
          )}
          {post.publications.length > 0 && (
            <span className="posttile__pubs" data-publications>
              {post.publications.map((p) =>
                p.url ? (
                  <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className={`pill pill--${p.tone}`}>
                    {p.label} · {p.stateLabel}
                  </a>
                ) : (
                  <span key={p.id} className={`pill pill--${p.tone}`}>
                    {p.label} · {p.stateLabel}
                  </span>
                ),
              )}
            </span>
          )}
        </span>
        <span className="posttile__acts">
          {post.media.length === 1 ? (
            <a href={dl(0)} className="posttile__link" data-download>
              Download
            </a>
          ) : (
            <span className="posttile__slides">
              {zip && (
                <a href={zip} className="posttile__link posttile__link--all" data-download-all>
                  Download all (ZIP)
                </a>
              )}
              <span className="posttile__each">
                or one:
                {post.media.map((_, i) => (
                  <a key={i} href={dl(i)} className="posttile__link">
                    {i + 1}
                  </a>
                ))}
              </span>
            </span>
          )}
          {onRevise && !revising && (
            <button type="button" className="reftile__remove" onClick={() => setRevising(true)} data-film-revise>
              New version
            </button>
          )}
          {/* The decisions on a row of their own, the same on every tile:
              Publish on the left, Remove on the right. */}
          {((mayPublish && publishable) || mayRemove) && (
          <span className="posttile__decide">
          {mayPublish && publishable && (
            <PublishDialog
              postId={post.id}
              briefId={briefId}
              what={`${post.kindLabel} · ${post.placement} · ${post.language} · ${post.segmentLabel}`}
              thumb={src(0)}
              video={post.media[0]?.type === "video/mp4"}
              existing={post.publications.map((p) => ({ destination: p.destination, state: p.state, stateLabel: p.stateLabel }))}
            />
          )}
          {mayRemove && (
            <ConfirmAction
              label="Remove"
              title={`Remove this ${post.kindLabel.toLowerCase()}?`}
              body={
                <p>
                  It is deleted from this campaign
                  {post.publications.length ? ". Where it was already published, it stays up." : "."}
                </p>
              }
              confirmLabel="Remove it"
              action={removePostAction}
              fields={{ briefId, postId: post.id }}
              tone="risk"
              testId={`remove-post-${post.id}`}
            />
          )}
          </span>
          )}
        </span>
        {onRevise && revising && (
          <form
            className="filmrev"
            data-film-revise-form
            onSubmit={async (e) => {
              e.preventDefault();
              if (asking) return;
              setAsking(true);
              setAsked(null);
              const r = await onRevise(note);
              setAsking(false);
              setAsked(r);
              if (r.ok) {
                setRevising(false);
                setNote("");
              }
            }}
          >
            <label className="formfield filmrev__field">
              <span className="formfield__label">
                What should change? <small>Optional</small>
              </span>
              <textarea
                rows={3}
                maxLength={400}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Say the price more slowly"
                disabled={asking}
              />
            </label>
            <p className="filmrev__cost">
              Counts as 2 videos: this video is sent back in, and the new one is made from it. About 20 to 30 minutes.
            </p>
            <span className="filmrev__acts">
              <button type="submit" className="btn btn--ink" disabled={asking} data-film-revise-go>
                {asking ? "Starting" : "Make new version (2 videos)"}
              </button>
              <button type="button" className="btn btn--ghost" disabled={asking} onClick={() => setRevising(false)}>
                Cancel
              </button>
            </span>
          </form>
        )}
        {asked && (
          <span className={`studionote ${asked.ok ? "" : "studionote--risk"}`} role="status" data-film-revise-note>
            {asked.ok ? "New version started. It appears here when it is ready." : asked.message}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * A story reel in the making: its shape, the stage the worker last
 * reported, a bar for how far along it is, and Stop. One that failed says
 * why, in the client's words, and can be dismissed.
 */
function ReelTile({
  reel,
  label,
  card,
  onStop,
  onDismiss,
  onRetry,
}: {
  reel: ReelView;
  /** The film's template, as its tile in the picker names it. */
  label: string;
  card: string;
  onStop: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const s = PLACEMENT_SIZE[reel.placement] ?? { w: 9, h: 16 };
  const live = reel.state === "QUEUED" || reel.state === "RUNNING";
  return (
    <figure className="posttile posttile--pending" data-reel={reel.state}>
      <div className="posttile__media" style={{ aspectRatio: `${s.w} / ${s.h}` }}>
        {live ? (
          <>
            <span className="spinner" role="status" aria-label="Making this video" />
            <span className="posttile__wait">{reel.stage}</span>
            <span className="reelbar" aria-hidden="true">
              <span style={{ width: `${Math.max(4, reel.progress)}%` }} />
            </span>
          </>
        ) : (
          <span className="posttile__failed" role="alert">
            {reel.message ?? "This video was not made."}
          </span>
        )}
      </div>
      <figcaption className="posttile__foot">
        <span className="posttile__what">
          <small>
            {label}
            {reel.revision ? ", new version (2 videos)" : ""} · {reel.placement}
            {card ? ` · ${card}` : ""}
          </small>
        </span>
        {live ? (
          <button type="button" className="reftile__remove" onClick={onStop} disabled={reel.stage === "Stopping"} data-stop-reel>
            {reel.stage === "Stopping" ? "Stopping" : "Stop"}
          </button>
        ) : (
          <span className="posttile__acts">
            <button type="button" className="reftile__remove" onClick={onRetry} data-retry-reel>
              Try again
            </button>
            <button type="button" className="reftile__remove" onClick={onDismiss}>
              Dismiss
            </button>
          </span>
        )}
      </figcaption>
    </figure>
  );
}
