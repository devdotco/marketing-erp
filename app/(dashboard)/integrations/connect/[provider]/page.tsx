"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";

const PROVIDER_MAP: Record<string, { name: string; enumValue: string }> = {
  apollo: { name: "Apollo.io", enumValue: "APOLLO" },
  instantly: { name: "Instantly", enumValue: "INSTANTLY" },
  aimfox: { name: "Aimfox", enumValue: "AIMFOX" },
  go_high_level: { name: "GoHighLevel", enumValue: "GO_HIGH_LEVEL" },
};

export default function ConnectProviderPage() {
  const router = useRouter();
  const params = useParams();
  const providerSlug = (params?.provider as string) ?? "";
  const providerInfo = PROVIDER_MAP[providerSlug.toLowerCase()];

  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  if (!providerInfo) {
    return (
      <div className="scrollable">
        <div
          style={{
            padding: "24px 20px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: 13,
            color: "var(--text-muted)",
          }}
        >
          Unknown provider. <Link href="/integrations" style={{ color: "var(--text)" }}>Back to integrations</Link>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;

    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerInfo.enumValue, apiKey: apiKey.trim() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
      }

      setStatus("success");
      setTimeout(() => router.push("/integrations"), 1200);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <div className="scrollable">
      <div style={{ marginBottom: 24 }}>
        <Link
          href="/integrations"
          style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          ← Back to integrations
        </Link>
      </div>

      <div style={{ maxWidth: 480 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>
          Connect {providerInfo.name}
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
          Enter your API key to authorize marketing-erp agents to act on your behalf.
        </p>

        <form onSubmit={handleSubmit}>
          <div
            style={{
              padding: "20px 20px 24px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label
                htmlFor="apiKey"
                style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", letterSpacing: "0.01em" }}
              >
                API Key
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your API key…"
                autoComplete="off"
                required
                style={{
                  padding: "9px 12px",
                  background: "var(--surface-2, var(--surface))",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  fontSize: 13,
                  color: "var(--text)",
                  outline: "none",
                  width: "100%",
                  boxSizing: "border-box",
                  fontFamily: "monospace",
                }}
              />
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
                Your key is encrypted with AES-256-GCM before storage and never logged.
              </p>
            </div>

            {status === "error" && (
              <p style={{ fontSize: 12, color: "var(--danger, #ef4444)", margin: 0 }}>{errorMsg}</p>
            )}

            {status === "success" && (
              <p style={{ fontSize: 12, color: "var(--success, #22c55e)", margin: 0 }}>
                Connected! Redirecting…
              </p>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={status === "loading" || status === "success" || !apiKey.trim()}
              >
                {status === "loading" ? "Saving…" : `Connect ${providerInfo.name}`}
              </button>
              <Link href="/integrations" className="btn btn-ghost">
                Cancel
              </Link>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
