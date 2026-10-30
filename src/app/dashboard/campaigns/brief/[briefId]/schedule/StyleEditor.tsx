"use client";

import { Expand } from "@/components/icons";
import { useMediaViewer, type ViewerItem } from "@/components/MediaViewer";
import { DEFAULT_SLIDES, MAX_SLIDES, MIN_SLIDES, type PostKind } from "@/lib/compose-rules";
import { FONTS } from "@/lib/font-rules";
import type { PostStyle } from "@/lib/plan-rules";
import { templateFits, templateSizes } from "@/lib/template-rules";
import type { TemplateOption } from "../studio/PostsPanel";

/**
 * The studio's choices for one kind of post, as a schedule keeps them:
 * languages, buyers, size, a carousel's slides, the template and the font.
 *
 * Controlled: it holds nothing of its own and posts nothing. The form keeps
 * every style and sends them as one JSON field, so a hidden tab or a closed
 * date row still saves what was chosen in it.
 */

export type StyleChoices = {
  /** The brief's languages, in its order. */
  languages: string[];
  buyers: { key: string; label: string }[];
  /** The brief's sizes for each kind. */
  sizes: Record<PostKind, string[]>;
  /** The design templates of each kind a schedule may follow. */
  templates: Record<PostKind, TemplateOption[]>;
};

// The file's version rides in the address, so a replaced design is fetched
// fresh: the same address the studio's picker uses.
const thumb = (kind: PostKind, t: TemplateOption, design: number, page = 0, w?: number) =>
  `/dashboard/campaigns/templates/${t.key}/${design}?v=${t.designs[design]?.[page] ?? ""}` +
  `${kind === "CAROUSEL" ? `&kind=carousel&page=${page}` : kind === "VIDEO" ? "&kind=video" : ""}${w ? `&w=${w}` : ""}`;

const clip = (t: TemplateOption, design: number) =>
  `/dashboard/campaigns/templates/${t.key}/${design}?kind=video&clip=1&v=${t.designs[design]?.[1] ?? ""}`;

const designsOf = (kind: PostKind, t: TemplateOption): ViewerItem[] =>
  kind === "CAROUSEL"
    ? (t.designs[0] ?? []).map((_, p) => ({
        src: thumb(kind, t, 0, p, 1600),
        thumb: thumb(kind, t, 0, p),
        kind: "image",
        alt: `${t.label}, slide ${p + 1}`,
      }))
    : kind === "VIDEO"
      ? t.designs.map((d, i) =>
          d.length > 1
            ? { src: clip(t, i), poster: thumb(kind, t, i, 0, 1600), thumb: thumb(kind, t, i), kind: "video", alt: `${t.label}, design ${i + 1}` }
            : { src: thumb(kind, t, i, 0, 1600), thumb: thumb(kind, t, i), kind: "image", alt: `${t.label}, design ${i + 1}` })
      : t.designs.map((_, i) => ({ src: thumb(kind, t, i, 0, 1600), thumb: thumb(kind, t, i), kind: "image", alt: `${t.label}, design ${i + 1}` }));

export default function StyleEditor({
  id,
  kind,
  value,
  onChange,
  choices,
}: {
  /** Unique on the page: it names this editor's radio groups. */
  id: string;
  kind: PostKind;
  value: PostStyle;
  onChange: (next: PostStyle) => void;
  choices: StyleChoices;
}) {
  const { open: view, viewer } = useMediaViewer();
  const sizes = choices.sizes[kind] ?? [];
  const library = choices.templates[kind] ?? [];
  // An empty list is every option, so a language added to the brief later is
  // written in too.
  const languages = value.languages.length ? value.languages : choices.languages;
  const buyers = value.buyers.length ? value.buyers : choices.buyers.map((b) => b.key);

  const toggle = (field: "languages" | "buyers", all: string[], current: string[], item: string, on: boolean) => {
    const next = all.filter((a) => (a === item ? on : current.includes(a)));
    if (!next.length) return;
    onChange({ ...value, [field]: next.length === all.length ? [] : next });
  };
  const size = value.size && sizes.includes(value.size) ? value.size : sizes[0] ?? null;
  const template = value.template ?? "auto";
  const font = value.font ?? "auto";

  return (
    <div className="stylepick" data-style={kind}>
      {choices.languages.length > 1 && (
        <fieldset className="stylepick__row">
          <legend>Languages</legend>
          <div className="stylepick__chips">
            {choices.languages.map((l) => {
              const on = languages.includes(l);
              return (
                <label key={l} className="sizechip">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={on && languages.length === 1}
                    onChange={(e) => toggle("languages", choices.languages, languages, l, e.target.checked)}
                    data-style-language={l}
                  />
                  <span>{l}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <fieldset className="stylepick__row">
        <legend>Buyers</legend>
        <div className="stylepick__chips">
          {choices.buyers.map((b) => {
            const on = buyers.includes(b.key);
            const all = choices.buyers.map((x) => x.key);
            return (
              <label key={b.key} className="sizechip">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={on && buyers.length === 1}
                  onChange={(e) => toggle("buyers", all, buyers, b.key, e.target.checked)}
                  data-style-buyer={b.key}
                />
                <span>{b.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {sizes.length > 1 ? (
        <fieldset className="stylepick__row">
          <legend>Size</legend>
          <div className="stylepick__chips" role="radiogroup">
            {sizes.map((p) => (
              <label key={p} className="sizechip">
                <input
                  type="radio"
                  name={`${id}-size`}
                  checked={size === p}
                  onChange={() =>
                    onChange({
                      ...value,
                      size: p === sizes[0] ? null : p,
                      // A template not drawn in the new size goes back to the AI's choice.
                      template: value.template && templateFits(value.template, kind, p) ? value.template : null,
                    })
                  }
                  data-style-size={p}
                />
                <span>{p}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : sizes.length === 1 ? (
        <div className="stylepick__row">
          <span className="stylepick__label">Size</span>
          <span className="stylepick__value">{sizes[0]}</span>
        </div>
      ) : null}

      {kind === "CAROUSEL" && (
        <label className="stylepick__row">
          <span className="stylepick__label">Slides</span>
          <select
            className="select-field stylepick__slides"
            value={value.slides ?? DEFAULT_SLIDES}
            onChange={(e) => onChange({ ...value, slides: Number(e.target.value) })}
            data-style-slides
          >
            {Array.from({ length: MAX_SLIDES - MIN_SLIDES + 1 }, (_, i) => MIN_SLIDES + i).map((n) => (
              <option key={n} value={n}>
                {n}
                {n === DEFAULT_SLIDES ? " (recommended)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {library.length > 0 && (
        <fieldset className={`stylepick__row tplpick ${kind === "IMAGE" ? "" : "tplpick--tall"}`}>
          <legend>Template</legend>
          <div className="tplpick__grid stylepick__grid" role="radiogroup" aria-label="Template">
            <label className={`tpltile tpltile--auto ${template === "auto" ? "tpltile--on" : ""}`}>
              <input
                type="radio"
                name={`${id}-template`}
                checked={template === "auto"}
                onChange={() => onChange({ ...value, template: null })}
                data-style-template="auto"
              />
              <span className="tpltile__art tpltile__art--auto" aria-hidden="true">
                <span>AI</span>
              </span>
              <strong>Let AI choose</strong>
              <small>{kind === "IMAGE" ? "Best fit, festive on a festival" : "Best fit for each post"}</small>
            </label>
            {library.map((t) => {
              // Drawn in its own shapes only: a template not made in the size
              // chosen says which size it needs.
              const off = !!size && !templateFits(t.key, kind, size);
              const needs = templateSizes(t.key, kind, sizes);
              return (
              <label
                key={t.key}
                className={`tpltile ${template === t.key ? "tpltile--on" : ""} ${off ? "tpltile--off" : ""}`}
                title={t.detail}
              >
                <input
                  type="radio"
                  name={`${id}-template`}
                  checked={template === t.key}
                  disabled={off}
                  onChange={() => onChange({ ...value, template: t.key })}
                  data-style-template={t.key}
                />
                <span className="tpltile__art">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumb(kind, t, 0)} alt="" loading="lazy" />
                  {t.hot && <span className="tpltile__hot">Hot</span>}
                  <button
                    type="button"
                    className="tpltile__zoom"
                    aria-label={`View ${t.label} designs`}
                    onClick={(e) => {
                      // Inside the label: viewing is not choosing.
                      e.preventDefault();
                      e.stopPropagation();
                      view(designsOf(kind, t), 0, `${t.label} template`);
                    }}
                  >
                    <Expand size={15} />
                  </button>
                </span>
                <strong>{t.label}</strong>
                <small>{off ? (needs.length ? `For ${needs.join(" or ")}` : "Not in this campaign's sizes") : `${t.designs.length} designs`}</small>
              </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <fieldset className="stylepick__row fontpick">
        <legend>Font</legend>
        <div className="fontpick__grid" role="radiogroup" aria-label="Font">
          <label className={`fonttile ${font === "auto" ? "fonttile--on" : ""}`}>
            <input
              type="radio"
              name={`${id}-font`}
              checked={font === "auto"}
              onChange={() => onChange({ ...value, font: null })}
              data-style-font="auto"
            />
            <span className="fonttile__sample" aria-hidden="true">
              Aa
            </span>
            <strong>Let AI choose</strong>
            <small>Matches the design</small>
          </label>
          {FONTS.map((f) => (
            <label key={f.key} className={`fonttile ${font === f.key ? "fonttile--on" : ""}`}>
              <input
                type="radio"
                name={`${id}-font`}
                checked={font === f.key}
                onChange={() => onChange({ ...value, font: f.key })}
                data-style-font={f.key}
              />
              <span className="fonttile__sample" aria-hidden="true" style={{ fontFamily: `'${f.family}', serif` }}>
                Aa
              </span>
              <strong style={{ fontFamily: `'${f.family}', sans-serif` }}>{f.label}</strong>
              <small>{f.mood}</small>
            </label>
          ))}
        </div>
      </fieldset>
      {viewer}
    </div>
  );
}

/** Each face from our own route, once on the page, so every font tile shows in itself. */
export function FontFaces() {
  return (
    <style>
      {FONTS.map(
        (f) =>
          `@font-face{font-family:'${f.family}';font-weight:400;font-display:swap;src:url(/dashboard/campaigns/fonts/${f.key}) format('truetype')}` +
          `@font-face{font-family:'${f.family}';font-weight:700;font-display:swap;src:url(/dashboard/campaigns/fonts/${f.key}?w=bold) format('truetype')}`,
      ).join("")}
    </style>
  );
}

/** "Hindi · Investor · Feed 1:1 · Montserrat", what a style changes from the default, for a row. */
export function styleLine(style: PostStyle, choices: StyleChoices, kind: PostKind): string {
  const parts: string[] = [];
  if (style.languages.length) parts.push(style.languages.join(", "));
  if (style.buyers.length) parts.push(style.buyers.map((b) => choices.buyers.find((x) => x.key === b)?.label ?? b).join(", "));
  if (style.size) parts.push(style.size);
  if (kind === "CAROUSEL" && style.slides) parts.push(`${style.slides} slides`);
  if (style.template) parts.push(choices.templates[kind]?.find((t) => t.key === style.template)?.label ?? "Template");
  if (style.font) parts.push(FONTS.find((f) => f.key === style.font)?.label ?? "Font");
  return parts.join(" · ");
}
