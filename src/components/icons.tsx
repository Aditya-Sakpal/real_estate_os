/**
 * Authored icon set. One family, 1.5px stroke, 24px grid, round caps and joins.
 * Deliberately hand-drawn rather than pulled from a library so the weight
 * matches the reference set exactly, and so no emoji ever stands in for an icon.
 */

type P = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const Inbox = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3.5 13h4l1.2 2.3h6.6L16.5 13h4" />
    <path d="M5.6 5.4h12.8l2.1 7.6v3.9a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V13z" />
  </svg>
);

export const Leads = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="9.2" cy="8.4" r="3.1" />
    <path d="M3.6 19.2a5.7 5.7 0 0 1 11.2 0" />
    <path d="M16.3 6.1a3 3 0 0 1 .6 5.9M17.9 14.2a5.1 5.1 0 0 1 2.6 4.4" />
  </svg>
);

export const Visit = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3.4" y="5.2" width="17.2" height="15.4" rx="2.6" />
    <path d="M3.4 9.7h17.2M8.2 3.4v3.4M15.8 3.4v3.4" />
    <path d="M9 14.6l2 2 4-4" />
  </svg>
);

export const Partners = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="6" cy="7" r="2.4" />
    <circle cx="18" cy="7" r="2.4" />
    <circle cx="12" cy="18" r="2.4" />
    <path d="M7.6 8.9 10.6 16M16.4 8.9 13.4 16M8.4 7h7.2" />
  </svg>
);

export const Campaign = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 10.2v3.6a1.6 1.6 0 0 0 1.6 1.6h2L14 19.4V4.6L7.6 8.6h-2A1.6 1.6 0 0 0 4 10.2z" />
    <path d="M17.4 9.1a4 4 0 0 1 0 5.8M19.8 6.6a7.4 7.4 0 0 1 0 10.8" />
  </svg>
);

export const Project = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 20.4V6.2a1.6 1.6 0 0 1 1.6-1.6h5.2a1.6 1.6 0 0 1 1.6 1.6v14.2" />
    <path d="M12.4 20.4V10.4h6a1.6 1.6 0 0 1 1.6 1.6v8.4M2.6 20.4h18.8" />
    <path d="M6.6 8.4h1.2M6.6 12h1.2M6.6 15.6h1.2M15.6 14h1.4M15.6 17.2h1.4" />
  </svg>
);

export const Report = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3.6 20.4h16.8" />
    <rect x="5.2" y="12.4" width="3.4" height="6" rx="1" />
    <rect x="10.4" y="7.6" width="3.4" height="10.8" rx="1" />
    <rect x="15.6" y="10" width="3.4" height="8.4" rx="1" />
  </svg>
);

export const Settings = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7.2h7M15.4 7.2h4.6M4 16.8h4.6M13 16.8h7" />
    <circle cx="13.2" cy="7.2" r="2.2" />
    <circle cx="10.8" cy="16.8" r="2.2" />
  </svg>
);

export const Search = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="10.6" cy="10.6" r="6.4" />
    <path d="m15.4 15.4 4.2 4.2" />
  </svg>
);

export const ChevronDown = ({ size = 13, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m6.5 9.5 5.5 5.4 5.5-5.4" />
  </svg>
);

export const ChevronRight = ({ size = 13, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m9.5 5.5 5.4 6.5-5.4 6.5" />
  </svg>
);

export const ArrowLeft = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M18.6 12H5.4M11.8 5.8 5.4 12l6.4 6.2" />
  </svg>
);

export const ArrowUpRight = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M7.4 16.6 16.6 7.4M9.1 7.4h7.5v7.5" />
  </svg>
);

export const Alert = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M10.7 4.2 3.3 17a1.5 1.5 0 0 0 1.3 2.3h14.8a1.5 1.5 0 0 0 1.3-2.3L13.3 4.2a1.5 1.5 0 0 0-2.6 0z" />
    <path d="M12 9.6v4M12 16.6h.01" />
  </svg>
);

export const Clock = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 7.4V12l3 1.8" />
  </svg>
);

export const Person = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="8.2" r="3.4" />
    <path d="M5.4 19.4a6.6 6.6 0 0 1 13.2 0" />
  </svg>
);

export const Team = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="8.6" cy="8" r="3.1" />
    <path d="M2.8 19.2a5.9 5.9 0 0 1 11.6 0" />
    <circle cx="17.4" cy="9.4" r="2.4" />
    <path d="M16 14.6a4.6 4.6 0 0 1 5.2 4" />
  </svg>
);

export const Check = ({ size = 13, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m5.4 12.4 4.2 4.2 8.8-9.2" />
  </svg>
);

export const Plus = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5.4v13.2M5.4 12h13.2" />
  </svg>
);

export const Shield = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.4 5 6.2v5.3c0 4.1 2.9 7.9 7 9.1 4.1-1.2 7-5 7-9.1V6.2z" />
    <path d="m9.2 11.9 2 2 3.6-3.6" />
  </svg>
);

export const Building = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="5.4" y="3.6" width="13.2" height="16.8" rx="1.8" />
    <path d="M9.2 7.6h1.4M13.4 7.6h1.4M9.2 11.4h1.4M13.4 11.4h1.4M10.6 20.4v-4h2.8v4" />
  </svg>
);

/**
 * The Sales Desk mark, traced from the logo artwork rather than embedded as a
 * raster, so it stays crisp in the 26px brand tile and costs nothing to load.
 * `size` is the height; the mark is taller than it is wide, so the width
 * follows from its own proportions. Fill is inherited, which lets it sit white
 * on the green tile and green on a light ground without a second copy.
 */
/**
 * The asset library: a stack of pictures rather than one.
 *
 * The rail used to point at `Mark`, which is the Sales Desk glyph itself, so
 * the section was wearing the product's own logo.
 */
export const Library = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M7.6 4.4h11a2 2 0 0 1 2 2v10.8" />
    <rect x="3.4" y="7.6" width="13.4" height="12.8" rx="2" />
    <circle cx="7.9" cy="12" r="1.35" />
    <path d="M3.9 18.4 7.6 14.9a1.7 1.7 0 0 1 2.3 0l4.2 4" />
  </svg>
);

export const Mark = ({ size = 15, className }: P) => (
  <svg
    width={(size * 538) / 663}
    height={size}
    viewBox="0 0 538 663"
    fill="currentColor"
    className={className}
    aria-hidden
  >
    <path
      d="M0 280L269 40L538 280V663H350V460H188V663H0Z"
      fillRule="evenodd"
    />
  </svg>
);

/** A card's own menu. Three dots, drawn as short round strokes to keep the family's weight. */
export const Dots = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} strokeWidth={2.4}>
    <path d="M6 12h.01M12 12h.01M18 12h.01" />
  </svg>
);

export const Close = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </svg>
);

/** A handset. The call log's tab, and a call wherever one is named. */
export const Phone = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M7.4 3.9h-1.8a1.8 1.8 0 0 0-1.8 2c.6 7.2 6.4 13 13.6 13.6a1.8 1.8 0 0 0 2-1.8v-1.8a1.4 1.4 0 0 0-1-1.3l-2.6-.8a1.4 1.4 0 0 0-1.4.4l-1 1.1a10.6 10.6 0 0 1-5.1-5.1l1.1-1a1.4 1.4 0 0 0 .4-1.4l-.8-2.6a1.4 1.4 0 0 0-1.3-1z" />
  </svg>
);

/** Lanes, for the pipeline board's tab. */
export const Board = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3.6" y="4.4" width="4.6" height="15.2" rx="1.4" />
    <rect x="9.7" y="4.4" width="4.6" height="10.4" rx="1.4" />
    <rect x="15.8" y="4.4" width="4.6" height="12.8" rx="1.4" />
  </svg>
);

/** Play and pause share one footprint so the button does not shift when it toggles. */
export const Play = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} fill="currentColor">
    <path d="M8.2 5.6v12.8a.8.8 0 0 0 1.2.7l10-6.4a.8.8 0 0 0 0-1.4l-10-6.4a.8.8 0 0 0-1.2.7z" />
  </svg>
);

export const Pause = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} fill="currentColor">
    <rect x="6.6" y="5.4" width="3.8" height="13.2" rx="1.1" />
    <rect x="13.6" y="5.4" width="3.8" height="13.2" rx="1.1" />
  </svg>
);

/** Four corners pulled outward: open this bigger. */
export const Expand = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M9.5 4.5h-5v5M14.5 4.5h5v5M9.5 19.5h-5v-5M14.5 19.5h5v-5" />
  </svg>
);

export const ChevronLeft = ({ size = 13, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m14.5 5.5-5.4 6.5 5.4 6.5" />
  </svg>
);

/** A speech bubble holding a spark: Ask Jimmy in the rail. */
export const Ask = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M5.2 4.6h13.6a1.8 1.8 0 0 1 1.8 1.8v8.8a1.8 1.8 0 0 1-1.8 1.8h-7.1l-4.3 3.4v-3.4H5.2a1.8 1.8 0 0 1-1.8-1.8V6.4a1.8 1.8 0 0 1 1.8-1.8z" />
    <path d="M12 7.6l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z" />
  </svg>
);

/** Send: an arrow rising from the line. */
export const ArrowUp = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 19V5.5M6.2 11.2 12 5.4l5.8 5.8" />
  </svg>
);

/** Stop: a rounded square. */
export const Stop = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" />
  </svg>
);

/** A microphone: speaking a question instead of typing it. */
export const Mic = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.8 11.2a6.2 6.2 0 0 0 12.4 0M12 17.4v3.1M9 20.5h6" />
  </svg>
);

/** A speaker: an answer read aloud. */
export const Speaker = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4.5 9.5h3l4.5-3.8v12.6l-4.5-3.8h-3z" />
    <path d="M15.6 9.2a4 4 0 0 1 0 5.6M18.1 6.8a7.4 7.4 0 0 1 0 10.4" />
  </svg>
);

export const Trash = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4.8 7h14.4M9.6 7V5.2h4.8V7M6.6 7l.8 11.3a1.8 1.8 0 0 0 1.8 1.7h5.6a1.8 1.8 0 0 0 1.8-1.7L17.4 7M10.2 10.8v5.4M13.8 10.8v5.4" />
  </svg>
);

export const Wallet = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4.6 7.4h13.8a1.6 1.6 0 0 1 1.6 1.6v8.4a1.6 1.6 0 0 1-1.6 1.6H6.2a1.6 1.6 0 0 1-1.6-1.6z" />
    <path d="M4.6 7.4 15.8 4.8a1 1 0 0 1 1.2 1v1.6" />
    <path d="M20 11.6h-3.4a1.6 1.6 0 0 0 0 3.2H20" />
  </svg>
);

export const Receipt = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M6.4 3.8h11.2v16.4l-2.2-1.4-1.8 1.4-1.6-1.4-1.6 1.4-1.8-1.4-2.2 1.4z" />
    <path d="M9.2 8.6h5.6M9.2 11.8h5.6M9.2 15h3.2" />
  </svg>
);

export const Download = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 4.6v10.2M7.8 10.8 12 15l4.2-4.2" />
    <path d="M5 16.4v1.8a1.4 1.4 0 0 0 1.4 1.4h11.2a1.4 1.4 0 0 0 1.4-1.4v-1.8" />
  </svg>
);

export const Minus = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M5.4 12h13.2" />
  </svg>
);

/** A speech bubble, for the developer's WhatsApp number and its messages. */
export const Chat = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 4.3c-4.5 0-8.1 3.1-8.1 7 0 1.7.7 3.2 1.8 4.4l-.9 3.8 4-1.7c1 .4 2.1.6 3.2.6 4.5 0 8.1-3.1 8.1-7.1s-3.6-7-8.1-7z" />
    <path d="M8.7 11.4h.01M12 11.4h.01M15.3 11.4h.01" />
  </svg>
);

/** A headset: the AI agents in the rail. */
export const Headset = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4.8 14v-2.2a7.2 7.2 0 0 1 14.4 0V14" />
    <rect x="3.6" y="13" width="3.6" height="5.4" rx="1.5" />
    <rect x="16.8" y="13" width="3.6" height="5.4" rx="1.5" />
    <path d="M18.6 18.4v.4a2.4 2.4 0 0 1-2.4 2.4h-2.6" />
  </svg>
);

/** A padlock: something the plan does not carry yet. */
export const Lock = ({ size = 13, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="5.4" y="10.6" width="13.2" height="9.4" rx="2.2" />
    <path d="M8.4 10.6V8a3.6 3.6 0 0 1 7.2 0v2.6" />
  </svg>
);

export const Pencil = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M14.8 5.6l3.6 3.6" />
    <path d="M4.6 19.4l1-4.2L16.1 4.7a1.6 1.6 0 0 1 2.3 0l.9.9a1.6 1.6 0 0 1 0 2.3L8.8 18.4z" />
  </svg>
);

export const Paperclip = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M19.2 11.6l-7.1 7.1a4.6 4.6 0 0 1-6.5-6.5l7.5-7.5a3.1 3.1 0 0 1 4.4 4.4l-7.3 7.3a1.6 1.6 0 0 1-2.3-2.3l6.6-6.6" />
  </svg>
);

export const FileDoc = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M13.6 3.4H7.2a2 2 0 0 0-2 2v13.2a2 2 0 0 0 2 2h9.6a2 2 0 0 0 2-2V8.6z" />
    <path d="M13.6 3.4v5.2h5.2M8.8 13h6.4M8.8 16.4h4.4" />
  </svg>
);

export const Picture = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.4" />
    <circle cx="9" cy="9.8" r="1.6" />
    <path d="M20.4 15.6l-4.6-4.4-8.6 8.2" />
  </svg>
);

/** Four tiles: the phone tab bar's "More", which opens every other section. */
export const Grid = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" />
  </svg>
);
