import Link from "next/link";
import { Search } from "@/components/icons";

/**
 * A project, tower or brief that is not there.
 *
 * Several pages call `notFound()` for a record in another tenant, which is
 * correct: a cross-tenant id has to be indistinguishable from one that does
 * not exist, or the 404 itself tells somebody the record is real. So this
 * screen never says whose it might be, and it offers the way back rather
 * than an explanation.
 */
export default function ConsoleNotFound() {
  return (
    <>
      <div className="pagehead">
        <div className="pagehead__id">
          <h1>
            Nothing here to <span className="em">open</span>
          </h1>
          <p className="sub" style={{ marginTop: 6 }}>It was removed, or the address is wrong.</p>
        </div>
      </div>

      <section className="card">
        <div className="empty" style={{ padding: "30px 20px" }}>
          <div className="empty__mark">
            <Search size={20} />
          </div>
          <p style={{ maxWidth: "50ch", margin: "0 auto 16px", color: "var(--ink-soft)" }}>
            Use the jump box at the top to find a project or a tower by name.
          </p>
          <Link href="/dashboard" className="btn btn--ink">
            Back to Today
          </Link>
        </div>
      </section>
    </>
  );
}
