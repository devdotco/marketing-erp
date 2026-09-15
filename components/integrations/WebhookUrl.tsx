"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/base-path";

type State =
  | { phase: "loading" }
  | { phase: "not-connected" }
  | { phase: "error"; error: string }
  | { phase: "ready"; url: string };

/**
 * The workspace's own webhook URL for Instantly or Aimfox, to paste into the
 * vendor. Each workspace's URL carries a secret token; deliveries to any other
 * URL are refused. Rendered only for workspace admins' eyes — the API behind it
 * (/api/integrations/webhook-url) is admin-gated.
 */
export function WebhookUrl({ provider, name }: { provider: "INSTANTLY" | "AIMFOX"; name: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  function request(method: "GET" | "POST"): Promise<State> {
    return apiFetch(`/api/integrations/webhook-url?provider=${provider}`, { method })
      .then(async (res): Promise<State> => {
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) return { phase: "not-connected" };
        if (!res.ok) return { phase: "error", error: data.error ?? `Request failed: ${res.status}` };
        return { phase: "ready", url: data.url };
      })
      .catch((err): State => ({ phase: "error", error: String(err) }));
  }

  useEffect(() => {
    let cancelled = false;
    request("GET").then((next) => !cancelled && setState(next));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  async function rotate() {
    if (!confirm(`Generate a new webhook URL? The current one stops working immediately, so update it in ${name} right away.`)) return;
    setRotating(true);
    setState(await request("POST"));
    setRotating(false);
  }

  return (
    <div
      style={{
        marginTop: 20,
        padding: "16px 20px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div className="input-label">Webhook URL</div>
      {state.phase === "loading" && <p className="input-hint" style={{ margin: 0 }}>Loading…</p>}
      {state.phase === "not-connected" && (
        <p className="input-hint" style={{ margin: 0 }}>
          Connect {name} first — this workspace&apos;s webhook URL appears here once it is.
        </p>
      )}
      {state.phase === "error" && <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{state.error}</p>}
      {state.phase === "ready" && (
        <>
          <input className="input" readOnly value={state.url} onFocus={(e) => e.currentTarget.select()} style={{ fontFamily: "monospace", fontSize: 12 }} />
          <p className="input-hint" style={{ margin: 0 }}>
            Paste this into {name}&apos;s webhook settings so replies reach the Outbound Engine. It contains a secret for
            this workspace only — treat it like a password. Deliveries without it are refused.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(state.url).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={rotate} disabled={rotating}>
              {rotating ? "Rotating…" : "Rotate"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
