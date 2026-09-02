"use client";

import { useState } from "react";
import { createWorkspace } from "@/lib/actions/workspace";

export default function NewWorkspacePage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    const result = await createWorkspace(formData);
    if (result?.error) {
      setError(result.error);
      setPending(false);
    }
    // On success, createWorkspace redirects — no further action needed
  }

  return (
    <div className="scrollable">
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>New workspace</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Create a separate workspace to manage a different brand or client.
        </p>
      </div>

      <div style={{ maxWidth: 480 }}>
        <div className="card">
          <form action={handleSubmit}>
            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label" htmlFor="name">Workspace name</label>
              <input
                id="name"
                name="name"
                type="text"
                className="form-input"
                placeholder="e.g. Acme Corp"
                required
                minLength={2}
                maxLength={64}
                autoFocus
              />
            </div>

            {error && (
              <p style={{ fontSize: 12, color: "var(--danger)", marginBottom: 16 }}>{error}</p>
            )}

            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: "100%" }}
              disabled={pending}
            >
              {pending ? "Creating…" : "Create workspace"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
