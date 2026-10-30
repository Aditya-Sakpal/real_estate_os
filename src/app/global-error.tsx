"use client";

/**
 * The last resort: the root layout itself threw, so there is no shell, no
 * rail, and no fonts loaded. It replaces <html> entirely, which is why this
 * one carries its own inline styles rather than reaching for globals.css.
 *
 * It says nothing about what went wrong for the same reason the console's
 * error screen does not: this is a page a client can be looking at.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "#eeeff2",
          color: "#14161b",
          fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', sans-serif",
          padding: 24,
        }}
      >
        <main style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 22, margin: 0, letterSpacing: "-0.02em" }}>
            Sales Desk did not start
          </h1>
          <p style={{ color: "#646872", fontSize: 14, lineHeight: 1.55, margin: "10px 0 18px" }}>
            Reload the page. Nothing was changed.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              background: "#17181d",
              color: "#f3f4f6",
              border: 0,
              borderRadius: 999,
              padding: "10px 18px",
              fontSize: 13.5,
              fontWeight: 560,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ color: "#868c97", fontSize: 12, marginTop: 16 }}>
              Reference {error.digest}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
