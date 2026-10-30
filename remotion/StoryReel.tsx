import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Audio } from "@remotion/media";
import type { ReelProps } from "./types";

/**
 * A story reel: the editor's shots cut back to back, a caption on each, the
 * narrator and the music under them, the logo and the MahaRERA block on
 * every frame, and an end card.
 *
 * The registration block is on every frame because every frame of an
 * advertisement is the advertisement; on the end card, where the phone
 * number appears, the number and the website are set at the phone's size,
 * which Order 46C/2025 requires, in the upper-right quarter it names.
 */

const FAMILY = "ReelSans";

const useFonts = (fonts: ReelProps["fonts"]) => {
  const [handle] = useState(() => delayRender("fonts"));
  useEffect(() => {
    const faces = [
      new FontFace(FAMILY, `url(${fonts.regular})`, { weight: "400" }),
      new FontFace(FAMILY, `url(${fonts.bold})`, { weight: "700" }),
    ];
    Promise.all(
      faces.map((f) =>
        f
          .load()
          .then((loaded) => document.fonts.add(loaded))
          .catch(() => undefined),
      ),
    ).finally(() => continueRender(handle));
  }, [fonts.regular, fonts.bold, handle]);
};

const clampOpts = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const StoryReel: React.FC<ReelProps> = (props) => {
  useFonts(props.fonts);
  const { width, height, durationInFrames } = useVideoConfig();
  // Sized by the short side, so a wide YouTube film sets its type at the
  // same size a reel does rather than half again as large.
  const u = Math.min(width, height) / 1080;
  const starts: number[] = [];
  props.shots.reduce((at, s) => {
    starts.push(at);
    return at + s.frames;
  }, 0);
  const endFrom = props.shots.reduce((n, s) => n + s.frames, 0);

  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0d12", fontFamily: `${FAMILY}, sans-serif` }}>
      {props.shots.map((s, i) => (
        <Sequence key={s.id} from={starts[i]} durationInFrames={s.frames} name={`Shot ${s.id}`}>
          {s.kind === "card" ? <Card shot={s} colour={props.brand.colour} u={u} /> : <Clip shot={s} grade={props.grade ?? "none"} />}
          {s.supers?.length ? <Supers pieces={s.supers} frames={s.frames} u={u} /> : null}
          <Caption text={s.caption} frames={s.frames} u={u} />
          <Transition kind={s.transition ?? "cut"} />
        </Sequence>
      ))}
      <Sequence from={endFrom} durationInFrames={props.end.frames} name="End card">
        <EndCard {...props} u={u} />
      </Sequence>

      <Sequence from={0} durationInFrames={endFrom} name="Brand and registration">
        <TopScrim u={u} />
        {props.brand.registrationNo && props.brand.reraPlace !== "BOTTOM_STRIP" ? <CornerShade u={u} /> : null}
        <FootShade u={u} />
        <Logo src={props.brand.logo} u={u} />
        <Registration brand={props.brand} u={u} size={20} qr={REEL_QR} />
        <SmallPrint text={props.brand.smallPrint} u={u} lift={stripLift(props.brand, u)} />
      </Sequence>

      {props.voice.map((v, i) => (
        <Audio key={`v${i}`} src={v.src} from={v.from} volume={1} />
      ))}
      {props.music && (
        <Audio
          src={props.music.src}
          volume={(f) => musicVolume(f, props.music!.duck, durationInFrames)}
        />
      )}
    </AbsoluteFill>
  );
};

/** The music: under the narrator, back up between lines, faded in and out. */
function musicVolume(f: number, duck: [number, number][], total: number): number {
  const ramp = 8;
  let dip = 0;
  for (const [a, b] of duck) {
    const inside = interpolate(f, [a - ramp, a, b, b + ramp], [0, 1, 1, 0], clampOpts);
    dip = Math.max(dip, inside);
  }
  const level = interpolate(dip, [0, 1], [0.8, 0.2]);
  const fadeIn = interpolate(f, [0, 15], [0, 1], clampOpts);
  const fadeOut = interpolate(f, [total - 45, total - 1], [1, 0], clampOpts);
  return level * fadeIn * fadeOut;
}

/** The editor's grade, one for the whole reel, as a filter on every clip. */
const GRADES: Record<NonNullable<ReelProps["grade"]>, string> = {
  none: "none",
  warm: "sepia(0.12) saturate(1.1) brightness(1.02)",
  cool: "saturate(0.95) hue-rotate(-6deg) brightness(1.02)",
  punchy: "contrast(1.1) saturate(1.18)",
  soft: "contrast(0.94) saturate(0.92) brightness(1.04)",
};

const Clip: React.FC<{ shot: ReelProps["shots"][number]; grade: NonNullable<ReelProps["grade"]> }> = ({ shot, grade }) => {
  const frame = useCurrentFrame();
  // A slow push-in over the whole shot gives a clip that barely moves a
  // camera, and never moves the captions or the registration block above it.
  const push = Math.min(0.08, Math.max(0, shot.push ?? 0));
  const scale = interpolate(frame, [0, Math.max(1, shot.frames)], [1, 1 + push], clampOpts);
  return (
    <AbsoluteFill style={{ filter: GRADES[grade] ?? "none" }}>
      {/* OffthreadVideo: frames are pulled by the renderer's own decoder, not
          seeked in the page. A browser-side video stalled a full reel at frame
          291 on the first live render, waiting on a seek past its timeout. */}
      <OffthreadVideo
        src={shot.src!}
        trimBefore={shot.trimBefore}
        playbackRate={shot.rate}
        muted
        style={{ width: "100%", height: "100%", objectFit: "cover", scale: String(scale) }}
      />
      {/* A soft grade at the foot so the caption reads on any picture. */}
      <AbsoluteFill
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.0) 38%)" }}
      />
    </AbsoluteFill>
  );
};

/**
 * How a shot comes in. A cut is nothing at all, and is what most shots
 * should be: a montage cut on the beat. A fade rises from black, a dip
 * passes through black quickly, a flash is a white frame that burns off.
 */
const Transition: React.FC<{ kind: NonNullable<ReelProps["shots"][number]["transition"]> }> = ({ kind }) => {
  const frame = useCurrentFrame();
  if (kind === "cut") return null;
  const [colour, from, frames] = kind === "flash" ? ["#ffffff", 0.85, 6] : kind === "fade" ? ["#000000", 1, 14] : ["#000000", 1, 7];
  const opacity = interpolate(frame, [0, frames as number], [from as number, 0], clampOpts);
  return opacity > 0 ? <AbsoluteFill style={{ backgroundColor: colour as string, opacity }} /> : null;
};

const Card: React.FC<{ shot: ReelProps["shots"][number]; colour: string; u: number }> = ({ shot, colour, u }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 90% at 50% 40%, ${colour} 0%, #0b0d12 100%)`,
        justifyContent: "center",
        alignItems: "center",
        padding: 90 * u,
      }}
    >
      <div
        style={{
          width: 90 * u,
          height: 4 * u,
          backgroundColor: "rgba(255,255,255,0.8)",
          marginBottom: 40 * u,
          scale: interpolate(frame, [4, 22], [0, 1], { ...clampOpts, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
        }}
      />
      <div
        style={{
          color: "#ffffff",
          fontWeight: 700,
          fontSize: 78 * u,
          lineHeight: 1.12,
          textAlign: "center",
          letterSpacing: -0.5 * u,
          opacity: interpolate(frame, [0, 14], [0, 1], clampOpts),
          translate: interpolate(frame, [0, 18], [`0px ${30 * u}px`, "0px 0px"], {
            ...clampOpts,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        {shot.card}
      </div>
    </AbsoluteFill>
  );
};

/**
 * The agent-on-camera look: large text landing a word at a time, three to
 * five words a piece, the pieces sharing the shot in turn. On a muted scroll
 * this is the whole film, so it is set big, in the upper-middle band clear of
 * the registration block, with one word picked out: the one carrying a
 * number, else the longest.
 */
const Supers: React.FC<{ pieces: string[]; frames: number; u: number }> = ({ pieces, frames, u }) => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const span = frames / pieces.length;
  const i = Math.min(pieces.length - 1, Math.floor(frame / span));
  const local = frame - i * span;
  const words = pieces[i].split(/\s+/).filter(Boolean);
  const stress = words.findIndex((w) => /\d/.test(w)) >= 0
    ? words.findIndex((w) => /\d/.test(w))
    : words.reduce((best, w, k) => (w.length > words[best].length ? k : best), 0);
  const fadeOut = interpolate(local, [span - 5, span], [1, 0], clampOpts);
  return (
    <AbsoluteFill style={{ alignItems: "center", paddingTop: height * 0.27 }}>
      <div
        style={{
          maxWidth: "86%",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          columnGap: 22 * u,
          rowGap: 4 * u,
          opacity: fadeOut,
        }}
      >
        {words.map((w, k) => {
          const at = k * 4;
          const pop = interpolate(local, [at, at + 7], [0, 1], { ...clampOpts, easing: Easing.bezier(0.16, 1, 0.3, 1) });
          return (
            <span
              key={`${i}-${k}`}
              style={{
                color: k === stress ? "#FFD166" : "#ffffff",
                fontWeight: 700,
                fontSize: (words.length <= 3 ? 104 : 86) * u,
                lineHeight: 1.02,
                letterSpacing: -1 * u,
                textShadow: `0 ${3 * u}px ${18 * u}px rgba(0,0,0,0.65)`,
                opacity: pop,
                scale: String(0.7 + pop * 0.3),
                display: "inline-block",
              }}
            >
              {w}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const Caption: React.FC<{ text: string; frames: number; u: number }> = ({ text, frames, u }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  if (!text) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: height * 0.155 }}>
      <div
        style={{
          maxWidth: Math.min(width - 180 * u, 1300 * u),
          color: "#ffffff",
          fontWeight: 700,
          fontSize: 54 * u,
          lineHeight: 1.18,
          textAlign: "center",
          textShadow: `0 ${2 * u}px ${14 * u}px rgba(0,0,0,0.6)`,
          opacity: interpolate(frame, [0, 8, frames - 6, frames], [0, 1, 1, 0], clampOpts),
          translate: interpolate(frame, [0, 10], [`0px ${18 * u}px`, "0px 0px"], {
            ...clampOpts,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

const TopScrim: React.FC<{ u: number }> = ({ u }) => {
  const { height } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        height: Math.max(height * 0.22, 360 * u),
        background: "linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 100%)",
      }}
    />
  );
};

/**
 * The top-right corner of the picture darkened, softly, under the
 * registration block: the film moves under white words, and a bright sky
 * there read at under 3 to 1 where the pixel gate asks 4.5. A gradient from
 * the corner rather than a panel, which read as a block pasted on (the
 * client, 30 September 2026). With the top scrim it holds about 0.6 over
 * every part of the block's words.
 */
const CornerShade: React.FC<{ u: number }> = ({ u }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(${900 * u}px ${330 * u}px at 100% 0%, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.5) 70%, rgba(0,0,0,0) 100%)`,
    }}
  />
);

/** The foot darkened the same way, under the small print only: the captions above it stay on the picture. */
const FootShade: React.FC<{ u: number }> = ({ u }) => (
  <AbsoluteFill
    style={{
      top: "auto",
      height: 200 * u,
      background: "linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.64) 55%, rgba(0,0,0,0) 100%)",
    }}
  />
);

/**
 * The QR's side on a 1080 frame, before its white margin: small, the way
 * developers print it, and as small as a MahaRERA project's 33-module code
 * still scans after the video is encoded, at the sizes the pixel gate reads
 * (`QR_PX_PER_MODULE_MOVING` in compose-rules.ts, the film's own rule).
 */
const REEL_QR = 103;

const Logo: React.FC<{ src: string | null; u: number }> = ({ src, u }) =>
  src ? (
    <Img
      src={src}
      style={{ position: "absolute", left: 56 * u, top: 64 * u, height: 64 * u, width: "auto", objectFit: "contain" }}
    />
  ) : null;

/** How far the small print sits above a registration strip, where the state asks for one. */
function stripLift(brand: ReelProps["brand"], u: number): number {
  return brand.registrationNo && brand.reraPlace === "BOTTOM_STRIP" ? STRIP_H * u : 0;
}

/** West Bengal's strip, as a share of a 1080 frame's short side: about 9 per cent of a 9:16 reel. */
const STRIP_H = 170;

/**
 * The QR, the number and the Authority's website, in the upper-right quarter,
 * as developers print it: a small QR in the corner and, to its left, the
 * label, the number and the website right-aligned and stacked, straight on
 * the picture (`CornerShade` keeps them readable); or, where the state asks
 * for it (West Bengal), a solid strip along the foot carrying the number and
 * the website in bold, and no QR.
 */
const Registration: React.FC<{ brand: ReelProps["brand"]; u: number; size: number; qr: number }> = ({
  brand,
  u,
  size,
  qr,
}) => {
  if (!brand.registrationNo) return null;
  const label = brand.reraLabel ?? "MahaRERA Reg. No.";
  if (brand.reraPlace === "BOTTOM_STRIP") {
    return (
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: STRIP_H * u,
          backgroundColor: brand.colour,
          color: "#ffffff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
          fontSize: Math.max(size, 30) * u,
          lineHeight: 1.3,
          textAlign: "center",
        }}
      >
        <div>
          {label} {brand.registrationNo}
          {brand.permitNo ? ` · Permit No. ${brand.permitNo}` : ""}
        </div>
        <div>{brand.reraWebsite}</div>
      </div>
    );
  }
  return (
    <div
      style={{
        position: "absolute",
        right: 48 * u,
        top: 56 * u,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 14 * u,
      }}
    >
      <div
        style={{
          color: "#ffffff",
          fontSize: size * u,
          fontWeight: 400,
          textAlign: "right",
          lineHeight: 1.22,
          whiteSpace: "nowrap",
        }}
      >
        {/* The label small, the number bold at the registration size, which is never below the contact size. */}
        <div style={{ fontSize: size * 0.72 * u, opacity: 0.92 }}>{label}</div>
        <div style={{ fontWeight: 700 }}>{brand.registrationNo}</div>
        {brand.permitNo ? <div>Permit No. {brand.permitNo}</div> : null}
        <div>{brand.reraWebsite}</div>
      </div>
      {brand.qr && (
        <div style={{ backgroundColor: "#ffffff", padding: Math.max(3, qr * 0.05) * u }}>
          <Img src={brand.qr} style={{ width: qr * u, height: qr * u, display: "block" }} />
        </div>
      )}
    </div>
  );
};

const SmallPrint: React.FC<{ text: string; u: number; lift?: number }> = ({ text, u, lift = 0 }) =>
  text ? (
    <div
      style={{
        position: "absolute",
        left: 48 * u,
        right: 48 * u,
        bottom: 40 * u + lift,
        color: "#ffffff",
        fontSize: 19 * u,
        textAlign: "center",
      }}
    >
      {/* Straight on the picture: `FootShade` darkens the foot under it, and the end card is dark. */}
      <span style={{ lineHeight: 1.6 }}>{text}</span>
    </div>
  ) : null;

const EndCard: React.FC<ReelProps & { u: number }> = (props) => {
  const { u } = props;
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // Small, so the registration block, a step above it, stays small too.
  const contact = 24;
  const appear = (delay: number) => ({
    opacity: interpolate(frame, [delay, delay + 12], [0, 1], clampOpts),
    translate: interpolate(frame, [delay, delay + 16], [`0px ${20 * u}px`, "0px 0px"], {
      ...clampOpts,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    }),
  });
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(110% 80% at 50% 45%, ${props.brand.colour} 0%, #0b0d12 100%)`,
        opacity: interpolate(frame, [0, 10], [0, 1], clampOpts),
      }}
    >
      {/* The contact details are set at `contact`, and the registration a step above it: equal
          sizes measure a hair either side of each other in the pixel gate, and never smaller is the rule. */}
      <Registration brand={props.brand} u={u} size={contact + 2} qr={REEL_QR} />
      {/* Tall: the block above the logo leaves the middle low. Wide: it sits beside it. */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", gap: 34 * u, paddingTop: width > height ? 0 : 260 * u }}>
        {props.brand.logo && (
          <Img src={props.brand.logo} style={{ height: 120 * u, width: "auto", objectFit: "contain", ...appear(4) }} />
        )}
        <div
          style={{
            color: "#ffffff",
            fontSize: 64 * u,
            fontWeight: 700,
            textAlign: "center",
            maxWidth: 900 * u,
            lineHeight: 1.12,
            ...appear(10),
          }}
        >
          {props.end.cta}
        </div>
        <div style={{ color: "#ffffff", fontSize: contact * u, fontWeight: 700, textAlign: "center", ...appear(18) }}>
          {[props.end.phone, props.end.website].filter(Boolean).join("   ·   ")}
        </div>
      </AbsoluteFill>
      <SmallPrint text={props.brand.smallPrint} u={u} lift={stripLift(props.brand, u)} />
    </AbsoluteFill>
  );
};
