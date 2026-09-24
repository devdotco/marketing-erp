"use client";

/**
 * The last boundary. Replaces the root layout, so it owns <html> and <body>.
 *
 * Without it a failure above every route boundary showed nothing at all: the
 * tree came down and the tab was left rendering whatever had already painted,
 * indistinguishable from the app having frozen. A visible error and a working
 * button is the floor.
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
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#0b0d10",
          color: "#e6e8eb",
          font: "15px/1.55 system-ui, -apple-system, Segoe UI, sans-serif",
        }}
      >
        <div style={{ maxWidth: 440 }}>
          <h1 style={{ fontSize: 19, fontWeight: 700, margin: "0 0 8px" }}>
            Marketing hit an error
          </h1>
          <p style={{ margin: "0 0 18px", color: "#9aa4b2" }}>
            Nothing you were working on was lost. Reloading usually clears it.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => reset()}
              style={{ padding: "9px 16px", borderRadius: 7, border: "none", background: "#2563eb", color: "#fff", fontSize: 14, cursor: "pointer" }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{ padding: "9px 16px", borderRadius: 7, border: "1px solid #2c333d", background: "transparent", color: "#e6e8eb", fontSize: 14, cursor: "pointer" }}
            >
              Reload the page
            </button>
          </div>
          {/* The digest is the only handle on the server-side log for this
              error, so it has to be readable rather than devtools-only. */}
          {error.digest && (
            <p style={{ margin: "18px 0 0", fontSize: 12, color: "#6b7480" }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
