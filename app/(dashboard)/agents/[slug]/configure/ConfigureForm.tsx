"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAgentConfig } from "@/lib/actions/agents";
import type { AgentInput } from "@/lib/agent-metadata";
import Link from "next/link";

interface ConfigureFormProps {
  workspaceId: string;
  agentSlug: string;
  agentName: string;
  agentConfigId?: string;
  currentConfig: Record<string, unknown>;
  integrations: string[];
  inputs: AgentInput[];
}

export function ConfigureForm({
  workspaceId,
  agentSlug,
  agentConfigId,
  currentConfig,
  integrations,
  inputs,
}: ConfigureFormProps) {
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

  const fields: AgentInput[] = inputs.length > 0 ? inputs : [
    {
      key: "requireApproval",
      label: "Require approval before publishing",
      type: "boolean",
      defaultValue: "true",
      hint: "When enabled, runs pause for human review before any content is published.",
    },
    {
      key: "notes",
      label: "Internal notes",
      type: "textarea",
      placeholder: "Notes about this agent's configuration or usage in your workspace",
    },
  ];

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {fields.map((field) => (
          <div key={field.key}>
            {field.type === "boolean" ? (
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={
                    values[field.key] !== undefined
                      ? Boolean(values[field.key])
                      : field.defaultValue === "true"
                  }
                  onChange={(e) => handleChange(field.key, e.target.checked)}
                  style={{ width: 15, height: 15, marginTop: 2, accentColor: "var(--success)", flexShrink: 0 }}
                />
                <div>
                  <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{field.label}</span>
                  {field.hint && (
                    <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "2px 0 0", lineHeight: 1.5 }}>{field.hint}</p>
                  )}
                </div>
              </label>
            ) : field.type === "select" ? (
              <div>
                <label className="input-label" htmlFor={field.key}>
                  {field.label}
                  {field.required && <span style={{ color: "var(--danger)", marginLeft: 3 }}>*</span>}
                </label>
                <select
                  id={field.key}
                  value={String(values[field.key] ?? field.defaultValue ?? "")}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  className="input"
                >
                  <option value="">Select…</option>
                  {(field.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                {field.hint && (
                  <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{field.hint}</p>
                )}
              </div>
            ) : field.type === "textarea" ? (
              <div>
                <label className="input-label" htmlFor={field.key}>
                  {field.label}
                  {field.required && <span style={{ color: "var(--danger)", marginLeft: 3 }}>*</span>}
                </label>
                <textarea
                  id={field.key}
                  value={String(values[field.key] ?? field.defaultValue ?? "")}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className="input"
                  rows={4}
                  style={{ resize: "vertical", minHeight: 88 }}
                />
                {field.hint && (
                  <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{field.hint}</p>
                )}
              </div>
            ) : (
              <div>
                <label className="input-label" htmlFor={field.key}>
                  {field.label}
                  {field.required && <span style={{ color: "var(--danger)", marginLeft: 3 }}>*</span>}
                </label>
                <input
                  id={field.key}
                  type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
                  value={String(values[field.key] ?? field.defaultValue ?? "")}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className="input"
                  required={field.required}
                />
                {field.hint && (
                  <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{field.hint}</p>
                )}
              </div>
            )}
          </div>
        ))}
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
          <Link href="/integrations" style={{ color: "var(--success)" }}>Manage →</Link>
        </div>
      )}

      {error && <p style={{ fontSize: 12, color: "var(--danger)" }}>{error}</p>}
      {saved && <p style={{ fontSize: 12, color: "var(--success)" }}>Saved! Redirecting…</p>}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary"
          style={{ opacity: pending ? 0.6 : 1 }}
        >
          {pending ? "Saving…" : "Save configuration"}
        </button>
        <Link href={`/agents/${agentSlug}`} className="btn btn-ghost">Cancel</Link>
      </div>
    </form>
  );
}
