/**
 * Lips that follow her voice: which presenter scenes are sent to be
 * lip-synced, and whether what comes back is kept. Pure, covered by
 * `check:logic`; `lipsync.ts` scores, asks Sync Labs and splices.
 *
 * A scene remade by the scene fix is a new take laid over her own sound: its
 * mouth was made without that voice. The Palm Grove film of 17 October 2026
 * opened that way (Veo's take, since Seedance would not remake her face) and
 * scored 1.6 on SyncNet, where every scene she was filmed saying scored 4 to
 * 6.5. Lip-synced to her voice by Sync Labs it scored 5.4. So a remade
 * scene she speaks in is always sent, and any other she speaks in is sent
 * when SyncNet finds her lips off. Code decides; nothing here asks a model.
 */

/** SyncNet's confidence at or above which the lips follow the words. */
export const LIPSYNC_MIN_CONFIDENCE = 3;
/** Frames at 25 a second the voice may lead or trail the lips by. */
export const LIPSYNC_MAX_OFFSET = 3;
/** The window SyncNet searches; an offset at its edge found no match. */
export const LIPSYNC_SHIFT = 15;
/** Seconds of film sent to Sync Labs at most, one film: priced before it is asked. */
export const MAX_LIPSYNC_SECONDS = 12;
/** Sync Labs' usage rate on the Hobbyist and Creator plans (sync.so/pricing, 18 October 2026). */
export const SYNC_USD_PER_SECOND = 0.05;
/** A span shorter than this is not worth a lip sync: SyncNet cannot score it either. */
export const MIN_LIPSYNC_SECONDS = 0.8;

export type LipSpan = { start: number; end: number };

export type LipScore =
  | { start: number; end: number; scored: true; offset: number; confidence: number; faceShare?: number }
  | { start: number; end: number; scored: false; why: string };

/** A scored span whose lips do not follow the words. */
export function lipsOff(s: LipScore | null | undefined): boolean {
  if (!s || !s.scored) return false;
  return s.confidence < LIPSYNC_MIN_CONFIDENCE || Math.abs(s.offset) > LIPSYNC_MAX_OFFSET || Math.abs(s.offset) >= LIPSYNC_SHIFT;
}

/** A scored span whose lips follow the words. */
export function lipsOn(s: LipScore | null | undefined): boolean {
  return !!s && s.scored && !lipsOff(s);
}

const overlaps = (a: LipSpan, b: LipSpan) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.25 * Math.min(a.end - a.start, b.end - b.start);

/**
 * The spans to send: every remade one, then those scored off, worst first,
 * inside `MAX_LIPSYNC_SECONDS`. A span whose face could not be read, or that
 * was not scored at all, is never sent: on 18 October 2026 a full-body shot, its face too small for SyncNet
 * before and after, was paid for and came back no better that anybody could
 * tell, and with Sync Labs' watermark on it.
 */
export function spansToSync(
  talking: readonly LipSpan[],
  remade: readonly LipSpan[],
  scores: readonly LipScore[],
  maxSeconds = MAX_LIPSYNC_SECONDS,
): { span: LipSpan; why: "remade" | "off"; before: LipScore | null }[] {
  const scoreOf = (s: LipSpan) => scores.find((x) => overlaps(x, s)) ?? null;
  const picked = talking
    .filter((s) => s.end - s.start >= MIN_LIPSYNC_SECONDS)
    .map((span) => {
      const before = scoreOf(span);
      const why = remade.some((r) => overlaps(r, span)) ? ("remade" as const) : lipsOff(before) ? ("off" as const) : null;
      return { span, why: before?.scored ? why : null, before };
    })
    .filter((x): x is { span: LipSpan; why: "remade" | "off"; before: LipScore | null } => x.why !== null)
    // A remade scene that already scores in sync needs nothing.
    .filter((x) => !(x.why === "remade" && lipsOn(x.before)))
    .sort((a, b) => (a.why === b.why ? conf(a.before) - conf(b.before) : a.why === "remade" ? -1 : 1));
  const out: typeof picked = [];
  let used = 0;
  for (const p of picked) {
    const len = p.span.end - p.span.start;
    if (used + len > maxSeconds) continue;
    used += len;
    out.push(p);
  }
  return out.sort((a, b) => a.span.start - b.span.start);
}

const conf = (s: LipScore | null) => (s && s.scored ? s.confidence : -1);

/**
 * Whether the lip-synced take replaces the scene: when it is in sync, or
 * clearly better than what was there. A take that could not be scored is
 * never kept: nothing shows it is better, and it is a redrawn face.
 */
export function keepSynced(before: LipScore | null, after: LipScore | null, _why: "remade" | "off"): boolean {
  if (lipsOn(after)) return true;
  if (after?.scored && before?.scored) return after.confidence >= before.confidence + 1 && Math.abs(after.offset) <= LIPSYNC_MAX_OFFSET;
  return false;
}

/**
 * A take that came back carrying the service's own mark: the Hobbyist plan
 * stamps "sync.so" in the corner, and on 18 October 2026 it went out on a
 * delivered film. Read off a frame of the take; such a take is never used.
 */
export function watermarked(texts: readonly string[]): boolean {
  return texts.some((t) => /sync\s*[.,]?\s*so/i.test(t));
}

/** What a run costs Sync Labs, in dollars, for spans of these lengths (billed per second, rounded up). */
export function lipSyncUsd(spans: readonly LipSpan[]): number {
  return spans.reduce((n, s) => n + Math.ceil(s.end - s.start) * SYNC_USD_PER_SECOND, 0);
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** One line for the film's notes, in the client's words. */
export function lipSyncNote(r: { span: LipSpan; kept: boolean; before: LipScore | null; after: LipScore | null; failed?: string | null }): string {
  const was = r.before?.scored ? ` (from ${r.before.confidence.toFixed(1)}` : "";
  const now = r.after?.scored ? `${was ? " to" : " (score"} ${r.after.confidence.toFixed(1)})` : was ? ")" : "";
  if (r.failed) return `Her lips at ${mmss(r.span.start)} could not be matched to her voice: ${r.failed}`;
  return r.kept
    ? `Her lips at ${mmss(r.span.start)} were matched to her voice${was}${now}.`
    : `Her lips at ${mmss(r.span.start)} were tried against her voice and the original kept${was}${now}.`;
}

/**
 * The presenter's speaking scenes as spans of the film, from the script and
 * the film's real cut times: a presenter scene with a line.
 */
export function talkingSpans(scenes: readonly { kind: string; line: string }[], shots: readonly LipSpan[]): LipSpan[] {
  return scenes.flatMap((sc, i) => (sc.kind === "presenter" && sc.line.trim() && shots[i] ? [{ start: shots[i].start, end: shots[i].end }] : []));
}

/**
 * The spans a scene fix replaced, moved by every later change in length:
 * a scene made longer pushes everything after it.
 */
export function shiftSpans(spans: readonly LipSpan[], changes: readonly { at: number; by: number }[]): LipSpan[] {
  return spans.map((s) => {
    const by = changes.filter((c) => c.at <= s.start + 1e-6).reduce((n, c) => n + c.by, 0);
    return { start: s.start + by, end: s.end + by };
  });
}
