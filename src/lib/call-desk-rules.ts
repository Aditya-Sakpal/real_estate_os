/**
 * The call desk: a screen a sales person keeps open, which rings the moment a
 * buyer is put through to the team and shows who they are and what the AI
 * already heard, before the phone is picked up.
 *
 * Pure and client-safe: the screen and the feed both read it, and
 * `check:logic` covers it.
 */

/** How the buyer reached the team. */
export type RingKind = "TRANSFER" | "HOT" | "INBOUND";

/** Where the ring stands, the same words for all three kinds. */
export type RingState = "RINGING" | "CONNECTED" | "ENDED" | "MISSED";

/** Why the buyer is being put through, in a person's words. */
export function ringReason(kind: RingKind, handoffReason: string | null): string {
  if (kind === "HOT") return "Hot buyer, put straight through";
  if (kind === "INBOUND") return "Called your number";
  return handoffReason === "LONG_CALL" ? "Talking to the AI for over 5 minutes" : "Asked the AI for the sales team";
}

/** A hand-off on an AI call, read into the desk's states. FAILED never rang anybody. */
export function transferState(handoffState: string | null): RingState | null {
  switch (handoffState) {
    case "REQUESTED":
    case "RINGING":
      return "RINGING";
    case "CONNECTED":
      return "CONNECTED";
    case "ENDED":
      return "ENDED";
    case "NO_ANSWER":
      return "MISSED";
    default:
      return null;
  }
}

/** A hot buyer's bridge: the sales person is rung first, and a bridge that never reached them was missed. */
export function bridgeState(status: string): RingState {
  if (status === "RINGING") return "RINGING";
  if (status === "CONNECTED") return "CONNECTED";
  return status === "ENDED" ? "ENDED" : "MISSED";
}

/** A buyer ringing the developer's own number. A refused call rang nobody. */
export function inboundState(status: string): RingState | null {
  if (status === "RINGING" || status === "CONNECTED" || status === "ENDED" || status === "MISSED") return status;
  return null;
}

/**
 * Whether the desk rings for this buyer. A person on the sales team hears
 * only the rings on their own phone; anybody else (a manager watching the
 * floor) hears every one they may see.
 */
export function ringsHere(r: { state: RingState; mine: boolean }, onTeam: boolean): boolean {
  return r.state === "RINGING" && (r.mine || !onTeam);
}

/** `0:07`, `2:14`, `1:02:09`: how long a ring or a conversation has run. */
export function elapsed(fromIso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** How long an ended ring stays on the desk, under Recent. */
export const RECENT_MINUTES = 30;

/** How often the screen asks: quickly while a buyer is on the line, less often when the desk is quiet. */
export const POLL_LIVE_MS = 2_000;
export const POLL_IDLE_MS = 3_000;

/** One line of what was said, as the desk shows it. */
export type DeskTurn = { who: "ai" | "buyer"; text: string };

/** A ring on the desk, with everything the person needs before they pick up. */
export type DeskRing = {
  /** `t:<call>`, `b:<bridge>` or `i:<inbound call>`: stable across polls. */
  id: string;
  kind: RingKind;
  state: RingState;
  reason: string;
  /** When the ring began, and when the conversation ended. */
  at: string;
  endedAt: string | null;
  /** True when this person's own phone is among those rung, or took the buyer. */
  mine: boolean;
  /** The person who took the buyer, by name when they are on the sales team. */
  takenBy: string | null;
  buyer: DeskBuyer;
};

export type DeskBuyer = {
  leadId: string;
  name: string;
  /** As this viewer's policy shows it. */
  phone: string;
  place: string;
  language: string;
  stage: string;
  temperature: "HOT" | "WARM" | "COLD" | null;
  /** Where they came from, and when. */
  source: string;
  enquiredAt: string;
  owner: string | null;
  /** The headline facts: configuration, budget, timeline, when known. */
  wants: string[];
  /** What the calls heard, each with the buyer's words. */
  heard: { label: string; value: string; quote: string | null }[];
  form: { question: string; answer: string }[];
  /** The AI call this ring came from, or the latest within half an hour. */
  thisCall: DeskCall | null;
  /** Calls before it: how many, and the last one's gist. */
  earlier: { count: number; last: DeskCall | null };
  /** A site visit still to come. */
  visit: { at: string; host: string | null } | null;
  /** What somebody was asked to do about this lead. */
  needsPerson: string | null;
};

export type DeskCall = {
  at: string;
  agent: string;
  summary: string | null;
  goal: string | null;
  facts: { label: string; value: string }[];
  /** The last lines of the conversation, newest last. */
  lastTurns: DeskTurn[];
  durationS: number | null;
};

/** The last few things said, buyer and AI, newest last. Events are left out. */
export function lastTurns(turns: { role: string; en: string }[], max = 8): DeskTurn[] {
  return turns
    .filter((t) => (t.role === "agent" || t.role === "user") && t.en.trim())
    .slice(-max)
    .map((t) => ({ who: t.role === "agent" ? "ai" : "buyer", text: t.en.trim() }));
}

/** Live rings first, the ones on this person's phone before others, newest first within each. */
export function deskOrder(a: DeskRing, b: DeskRing): number {
  const live = (r: DeskRing) => (r.state === "RINGING" ? 0 : r.state === "CONNECTED" ? 1 : 2);
  return live(a) - live(b) || Number(b.mine) - Number(a.mine) || Date.parse(b.at) - Date.parse(a.at);
}
