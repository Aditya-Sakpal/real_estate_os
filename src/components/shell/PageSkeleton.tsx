/**
 * What stands there while a route compiles or a query runs.
 *
 * There was nothing here, so a navigation left the previous screen on display
 * with no sign anything had happened, for as long as the server took. On a
 * phone in a basement that is several seconds of a page that looks broken.
 *
 * Skeleton rather than a spinner, and the shapes are the shapes that arrive:
 * a header, then cards. A spinner says "waiting", a skeleton says "waiting,
 * and here is roughly what for", and it reserves the space so nothing jumps
 * when the real thing lands.
 *
 * Every section folder's `loading.tsx` is this one component. A boundary only
 * shows when the segment under it changes, so the dashboard's own covers a
 * move between sections and each section's covers a move inside it (the
 * board to one lead, the library to one tower). Without the second, opening
 * a lead left the board standing until the lead had loaded.
 */
export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <div className="pagehead">
        <div className="pagehead__id">
          <div className="skel skel--title" />
          <div className="skel skel--line" style={{ width: "22ch", marginTop: 10 }} />
        </div>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="skel skel--line" style={{ width: "14ch", height: 14 }} />
        <div className="skel skel--row" style={{ marginTop: 16 }} />
        <div className="skel skel--row" style={{ marginTop: 10 }} />
        <div className="skel skel--row" style={{ marginTop: 10 }} />
      </section>

      <section className="card">
        <div className="skel skel--line" style={{ width: "11ch", height: 14 }} />
        <div className="skel skel--row" style={{ marginTop: 16 }} />
        <div className="skel skel--row" style={{ marginTop: 10 }} />
      </section>
    </div>
  );
}
