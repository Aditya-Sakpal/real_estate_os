"use client";

import Link from "next/link";
import { startTransition, useEffect } from "react";
import { unstable_isUnrecognizedActionError, useRouter } from "next/navigation";
import { Alert } from "@/components/icons";

/**
 * What a person sees when a page throws.
 *
 * Without this the whole console is replaced by Next's own screen, which
 * means the rail goes too and the only way out is the browser's back button.
 * Here the shell survives, so the rest of the console is still reachable.
 *
 * The message the error carries is not printed. A database error names
 * tables, columns and sometimes values, and this is a screen a client is
 * looking at. The digest is printed because it is the one thing that lets
 * somebody match this to a server log, and it names nothing.
 *
 * A page opened before a new release went live posts its buttons to actions
 * the new release does not know, and nothing is done. That is said as what
 * it is, and the way on is a full reload (21 October 2026: a project deleted
 * from such a page came back on "Try again", because it was never deleted).
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const stale = unstable_isUnrecognizedActionError(error);
  useEffect(() => {
    console.error(error);
  }, [error]);

  const again = () => {
    if (stale) {
      window.location.reload();
      return;
    }
    startTransition(() => {
      router.refresh();
      reset();
    });
  };

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__id">
          <h1>
            {stale ? (
              <>
                Sales Desk was just <span className="em">updated</span>
              </>
            ) : (
              <>
                That screen did not <span className="em">load</span>
              </>
            )}
          </h1>
          <p className="sub" style={{ marginTop: 6 }}>Nothing was changed.</p>
        </div>
      </div>

      <section className="card">
        <div className="empty" style={{ padding: "30px 20px" }}>
          <div className="empty__mark empty__mark--risk">
            <Alert size={20} />
          </div>
          <p style={{ maxWidth: "52ch", margin: "0 auto 16px", color: "var(--ink-soft)" }}>
            {stale
              ? "Reload the page, then do that again."
              : "Try it again. If it keeps failing, the rest of the console still works and the reference below identifies this in the logs."}
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn--ink" onClick={again}>
              {stale ? "Reload" : "Try again"}
            </button>
            <Link href="/dashboard" className="btn btn--light">
              Back to Today
            </Link>
          </div>
          {error.digest && (
            <p className="sub" style={{ marginTop: 14 }}>
              Reference <code>{error.digest}</code>
            </p>
          )}
        </div>
      </section>
    </>
  );
}
