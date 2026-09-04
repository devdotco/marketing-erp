"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AgentInput } from "@/lib/agent-metadata";
import { apiFetch } from "@/lib/base-path";

interface RunModalProps {
  workspaceId: string;
  agentSlug: string;
  agentName: string;
  agentConfigId?: string;
  inputs: AgentInput[];
  savedConfig: Record<string, unknown>;
}

function buildInitialValues(
  inputs: AgentInput[],
  savedConfig: Record<string, unknown>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    if (savedConfig[input.key] !== undefined) {
      values[input.key] = String(savedConfig[input.key]);
    } else if (input.defaultValue !== undefined) {
      values[input.key] = input.defaultValue;
    } else if (input.type === "boolean") {
      values[input.key] = "false";
    } else {
      values[input.key] = "";
    }
  }
  return values;
}

export function RunModal({
  workspaceId,
  agentSlug,
  agentName,
  agentConfigId,
  inputs,
  savedConfig,
}: RunModalProps) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() =>
    buildInitialValues(inputs, savedConfig),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const hasInputs = inputs.length > 0;

  function handleOpen() {
    setValues(buildInitialValues(inputs, savedConfig));
    setError(null);
    setOpen(true);
  }

  function handleClose() {
    if (!pending) setOpen(false);
  }

  function handleChange(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): string | null {
    for (const input of inputs) {
      if (input.required) {
        const val = values[input.key];
        if (val === undefined || val.trim() === "") {
          return `"${input.label}" is required.`;
        }
      }
    }
    return null;
  }

  function coerceValues(): Record<string, unknown> {
    const coerced: Record<string, unknown> = {};
    for (const input of inputs) {
      const raw = values[input.key] ?? "";
      if (input.type === "boolean") {
        coerced[input.key] = raw === "true";
      } else if (input.type === "number") {
        coerced[input.key] = raw === "" ? undefined : Number(raw);
      } else {
        coerced[input.key] = raw;
      }
    }
    return coerced;
  }

  function fireRun(input: Record<string, unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await apiFetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, agentSlug, agentConfigId, input }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to start run");
        router.push(`/runs/${data.runId}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error starting run");
      }
    });
  }

  function handleRunNow() {
    if (!hasInputs) {
      fireRun({});
      return;
    }
    handleOpen();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    fireRun(coerceValues());
  }

  const inputFieldStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: "8px 12px",
    color: "var(--text)",
    fontSize: 13,
    boxSizing: "border-box",
  };

  return (
    <>
      <button
        onClick={handleRunNow}
        disabled={pending}
        className="btn btn-primary btn-sm"
        style={{ opacity: pending ? 0.6 : 1 }}
      >
        {pending && !open ? "Starting…" : "Run now"}
      </button>

      {!hasInputs && error && (
        <p style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>{error}</p>
      )}

      {open && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 28,
              width: "100%",
              maxWidth: 520,
              maxHeight: "80vh",
              overflowY: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
                Run {agentName}
              </h2>
              <button
                onClick={handleClose}
                disabled={pending}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-dim)",
                  fontSize: 18,
                  lineHeight: 1,
                  padding: "2px 6px",
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {inputs.map((input) => (
                <div key={input.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label
                    htmlFor={`run-input-${input.key}`}
                    style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}
                  >
                    {input.label}
                    {input.required && (
                      <span style={{ color: "var(--danger)", marginLeft: 3 }}>*</span>
                    )}
                  </label>

                  {input.type === "boolean" ? (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                      <input
                        id={`run-input-${input.key}`}
                        type="checkbox"
                        checked={values[input.key] === "true"}
                        onChange={(e) => handleChange(input.key, e.target.checked ? "true" : "false")}
                        disabled={pending}
                        style={{ width: 14, height: 14 }}
                      />
                      <span style={{ color: "var(--text-muted)" }}>
                        {values[input.key] === "true" ? "Enabled" : "Disabled"}
                      </span>
                    </label>
                  ) : input.type === "select" ? (
                    <select
                      id={`run-input-${input.key}`}
                      value={values[input.key] ?? ""}
                      onChange={(e) => handleChange(input.key, e.target.value)}
                      disabled={pending}
                      style={inputFieldStyle}
                    >
                      {input.options?.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : input.type === "textarea" ? (
                    <textarea
                      id={`run-input-${input.key}`}
                      value={values[input.key] ?? ""}
                      onChange={(e) => handleChange(input.key, e.target.value)}
                      placeholder={input.placeholder}
                      disabled={pending}
                      rows={3}
                      style={{ ...inputFieldStyle, resize: "vertical" }}
                    />
                  ) : (
                    <input
                      id={`run-input-${input.key}`}
                      type={input.type === "url" ? "url" : input.type === "number" ? "number" : "text"}
                      value={values[input.key] ?? ""}
                      onChange={(e) => handleChange(input.key, e.target.value)}
                      placeholder={input.placeholder}
                      disabled={pending}
                      style={inputFieldStyle}
                    />
                  )}

                  {input.hint && (
                    <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0 }}>{input.hint}</p>
                  )}
                </div>
              ))}

              {error && (
                <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{error}</p>
              )}

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={pending}
                  className="btn btn-secondary btn-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="btn btn-primary btn-sm"
                  style={{ opacity: pending ? 0.6 : 1 }}
                >
                  {pending ? "Starting…" : "Run with these inputs"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
