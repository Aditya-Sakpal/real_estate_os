/**
 * What a story reel is rendered from: the editor's decisions as data. The
 * worker (`src/lib/reel-worker.ts`) writes it; the composition draws it.
 * Every length here is in frames, every source a URL the renderer can fetch.
 */
export type ReelProps = {
  width: number;
  height: number;
  fps: number;
  shots: {
    id: string;
    kind: "people" | "property" | "card" | "presenter";
    /** The trimmed clip; none for a card. */
    src: string | null;
    /** Source frames skipped before the shot starts: the model's slow start. */
    trimBefore: number;
    /** Below one fills a shot a clip is a little short for. */
    rate: number;
    frames: number;
    caption: string;
    card: string | null;
    /** How the shot comes in: a straight cut, a fade from black, a dip through black, or a white flash. */
    transition?: "cut" | "fade" | "dip" | "flash";
    /** A slow push-in over the shot, as a share of the frame (0 to 0.08). */
    push?: number;
    /** Large text landing across the shot, a piece at a time: the agent-on-camera look. */
    supers?: string[];
  }[];
  /** One colour grade over every clip. */
  grade?: "none" | "warm" | "cool" | "punchy" | "soft";
  end: { frames: number; cta: string; phone: string | null; website: string | null };
  voice: { src: string; from: number }[];
  music: { src: string; duck: [number, number][] } | null;
  brand: {
    colour: string;
    logo: string | null;
    qr: string | null;
    registrationNo: string | null;
    reraWebsite: string;
    /** The registering state's label, "MahaRERA Reg. No." when not given. */
    reraLabel?: string;
    /** Telangana's building permit number, printed beside the registration. */
    permitNo?: string | null;
    /**
     * TOP_RIGHT: the QR, number and website in the upper-right quarter.
     * BOTTOM_STRIP: West Bengal's strip along the foot, and no QR.
     */
    reraPlace?: "TOP_RIGHT" | "BOTTOM_STRIP";
    smallPrint: string;
  };
  fonts: { regular: string; bold: string };
};
