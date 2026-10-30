/**
 * One allowance line: what it is, how much of this month's is used, and a
 * segmented bar in the references' manner. A plan's single video is one wide
 * segment rather than a sliver of twenty-four, so a month with one video to
 * spend reads as exactly that.
 */
export function Meter({ label, used, allowance, words }: { label: string; used: number; allowance: number; words?: string }) {
  const share = allowance > 0 ? Math.min(1, used / allowance) : used > 0 ? 1 : 0;
  const state = allowance <= 0 || used >= allowance ? "out" : used >= allowance * 0.8 ? "warn" : "ok";
  const segments = Math.max(1, Math.min(24, Math.round(allowance) || 1));
  const filled = Math.min(segments, Math.round(share * segments));
  const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-IN");
  return (
    <div className={`meter meter--${state}`}>
      <div className="meter__top">
        <span className="meter__label">{label}</span>
        {state === "out" ? (
          <span className="pill pill--risk">Used up</span>
        ) : state === "warn" ? (
          <span className="pill pill--warn">{Math.floor(share * 100)}% used</span>
        ) : null}
      </div>
      <div
        className="meter__bar"
        role="meter"
        aria-label={`${label}: ${fmt(used)} of ${fmt(allowance)} used`}
        aria-valuemin={0}
        aria-valuemax={allowance}
        aria-valuenow={Math.min(used, allowance)}
        style={{ gridTemplateColumns: `repeat(${segments}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={i < filled ? "on" : undefined} />
        ))}
      </div>
      <p className="meter__n tnum">
        <strong>{fmt(used)}</strong> of {fmt(allowance)}
        {words ? ` ${words}` : ""}
      </p>
    </div>
  );
}
