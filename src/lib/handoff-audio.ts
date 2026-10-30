/**
 * The hand-off recordings committed in `public/calls/`, named
 * `<busy|connect>-<lang>-<voice>.wav`. Written by
 * `scripts/make-handoff-audio.mts`; never edit by hand, or a line is played
 * that is not there.
 */
export const RECORDED: readonly string[] = [
  "busy-en-shubh.wav",
  "busy-hi-shubh.wav",
  "busy-mr-shubh.wav",
];
