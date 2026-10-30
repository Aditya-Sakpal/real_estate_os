import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { StoryReel } from "./StoryReel";
import type { ReelProps } from "./types";

// Length and size come from the props: the editor decides both per reel.
const metadata: CalculateMetadataFunction<ReelProps> = ({ props }) => ({
  durationInFrames: props.shots.reduce((n, s) => n + s.frames, 0) + props.end.frames,
  width: props.width,
  height: props.height,
  fps: props.fps,
});

const EMPTY: ReelProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  shots: [{ id: "s1", kind: "card", src: null, trimBefore: 0, rate: 1, frames: 90, caption: "", card: "A story reel" }],
  end: { frames: 90, cta: "Book a site visit", phone: null, website: null },
  voice: [],
  music: null,
  brand: { colour: "#1b3a86", logo: null, qr: null, registrationNo: null, reraWebsite: "maharera.maharashtra.gov.in", smallPrint: "" },
  fonts: { regular: "", bold: "" },
};

export const Root: React.FC = () => (
  <Composition
    id="StoryReel"
    component={StoryReel}
    durationInFrames={180}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={EMPTY}
    calculateMetadata={metadata}
  />
);
