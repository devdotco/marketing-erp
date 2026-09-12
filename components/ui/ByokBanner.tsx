import Link from "next/link";

/**
 * A persistent, dismissable-by-fixing notice that this workspace cannot run
 * anything yet. Shown on every dashboard page until a key is connected, because
 * the wall is otherwise only discovered by pressing Run now on some agent.
 */
export function ByokBanner() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        padding: "12px 16px",
        marginBottom: 20,
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius)",
        background: "var(--surface-2)",
      }}
    >
      <div style={{ minWidth: 260, flex: 1 }}>
        <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
          Agents are paused until you connect an Anthropic API key
        </p>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 0" }}>
          Runs are billed to your own Anthropic account, so nothing can start without a key.
          It takes about two minutes, and no tokens are spent before it is set up.
        </p>
      </div>
      <Link href="/integrations/connect/anthropic" className="btn btn-primary btn-sm">
        Set up in 2 minutes
      </Link>
    </div>
  );
}
