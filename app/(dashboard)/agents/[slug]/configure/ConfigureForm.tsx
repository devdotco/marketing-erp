"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAgentConfig } from "@/lib/actions/agents";

interface ConfigureFormProps {
  workspaceId: string;
  agentSlug: string;
  agentName: string;
  agentConfigId?: string;
  currentConfig: Record<string, unknown>;
  integrations: string[];
}

const AGENT_FIELDS: Record<string, { key: string; label: string; placeholder?: string; type?: string }[]> = {
  "blog-writer": [
    { key: "wordCount", label: "Target word count", placeholder: "1500", type: "number" },
    { key: "tone", label: "Tone of voice", placeholder: "Professional, conversational" },
    { key: "targetKeyword", label: "Default target keyword", placeholder: "optional" },
    { key: "wpCategoryId", label: "WordPress category ID", placeholder: "1" },
    { key: "requireApproval", label: "Require approval before publish", type: "checkbox" },
  ],
  "on-site-publisher": [
    { key: "wpUrl", label: "WordPress URL", placeholder: "https://yoursite.com" },
    { key: "wpUsername", label: "WordPress username" },
    { key: "publishStatus", label: "Publish status", placeholder: "draft" },
    { key: "requireApproval", label: "Require approval before publish", type: "checkbox" },
  ],
  "technical-audit": [
    { key: "crawlDepth", label: "Crawl depth", placeholder: "3", type: "number" },
    { key: "includeScreenshots", label: "Include screenshots", type: "checkbox" },
    { key: "gscProperty", label: "Google Search Console property", placeholder: "sc-domain:example.com" },
  ],
  "podcast": [
    { key: "voiceId", label: "Cartesia voice ID", placeholder: "sonic" },
    { key: "episodeLength", label: "Target episode length (minutes)", placeholder: "15", type: "number" },
    { key: "requireApproval", label: "Require approval before publish", type: "checkbox" },
  ],
};

const DEFAULT_FIELDS = [
  { key: "requireApproval", label: "Require approval before publish", type: "checkbox" },
  { key: "notes", label: "Notes", placeholder: "Internal notes about this agent configuration" },
];

export function ConfigureForm({ workspaceId, agentSlug, agentConfigId, currentConfig, integrations }: ConfigureFormProps) {
  const fields = AGENT_FIELDS[agentSlug] ?? DEFAULT_FIELDS;
  const [values, setValues] = useState<Record<string, unknown>>(currentConfig);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleChange(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        await saveAgentConfig(workspaceId, agentSlug, values);
        setSaved(true);
        setTimeout(() => router.push(`/agents/${agentSlug}`), 800);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {fields.map((field) =>
          field.type === "checkbox" ? (
            <label key={field.key} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={Boolean(values[field.key])}
                onChange={(e) => handleChange(field.key, e.target.checked)}
                style={{ width: 15, height: 15, accentColor: "var(--success)" }}
              />
              <span style={{ fontSize: 13, color: "var(--text)" }}>{field.label}</span>
            </label>
          ) : (
            <div key={field.key}>
              <label className="input-label" htmlFor={field.key}>{field.label}</label>
              <input
                id={field.key}
                type={field.type ?? "text"}
                value={String(values[field.key] ?? "")}
                onChange={(e) => handleChange(field.key, e.target.value)}
                placeholder={field.placeholder}
                className="input"
              />
            </div>
          )
        )}
      </div>

      {integrations.length > 0 && (
        <div
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "14px 16px",
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          <strong style={{ fontSize: 12, color: "var(--text)" }}>Required integrations:</strong>{" "}
          {integrations.join(", ")}.{" "}
          <a href="/integrations" style={{ color: "var(--success)" }}>Manage →</a>
        </div>
      )}

      {error && (
        <p style={{ fontSize: 12, color: "var(--danger)" }}>{error}</p>
      )}

      {saved && (
        <p style={{ fontSize: 12, color: "var(--success)" }}>Saved! Redirecting…</p>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary"
          style={{ opacity: pending ? 0.6 : 1 }}
        >
          {pending ? "Saving…" : "Save configuration"}
        </button>
        <a href={`/agents/${agentSlug}`} className="btn btn-ghost">Cancel</a>
      </div>
    </form>
  );
}
