"use client";

import { useState, useTransition } from "react";

interface Props {
  workspaceId: string;
  currentName: string;
  currentSlug: string;
  currentPlan: string;
  businessName: string;
  websiteUrl: string;
  industry: string;
  brandVoice: Record<string, unknown>;
}

export function WorkspaceSettingsForm({ workspaceId, currentName, currentSlug, currentPlan, businessName, websiteUrl, industry }: Props) {
  const [name, setName] = useState(currentName);
  const [bName, setBName] = useState(businessName);
  const [url, setUrl] = useState(websiteUrl);
  const [ind, setInd] = useState(industry);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/settings/workspace", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, name, businessName: bName, websiteUrl: url, industry: ind }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        const d = await res.json();
        setError(d.error ?? "Failed to save");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <label className="input-label">Workspace name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="input" required />
      </div>
      <div>
        <label className="input-label">Slug</label>
        <input value={currentSlug} disabled className="input" style={{ opacity: 0.5 }} />
        <p className="input-hint">Contact support to change the slug.</p>
      </div>
      <div>
        <label className="input-label">Plan</label>
        <input value={currentPlan} disabled className="input" style={{ opacity: 0.5, textTransform: "capitalize" }} />
      </div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, marginTop: 4 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 14 }}>Business profile</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label className="input-label">Business name</label>
            <input value={bName} onChange={(e) => setBName(e.target.value)} className="input" placeholder="Acme Corp" />
          </div>
          <div>
            <label className="input-label">Website URL</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} className="input" placeholder="https://example.com" type="url" />
          </div>
          <div>
            <label className="input-label">Industry</label>
            <input value={ind} onChange={(e) => setInd(e.target.value)} className="input" placeholder="SaaS, E-commerce, Agency…" />
          </div>
        </div>
      </div>

      {error && <p style={{ fontSize: 12, color: "var(--danger)" }}>{error}</p>}
      {saved && <p style={{ fontSize: 12, color: "var(--success)" }}>Saved!</p>}

      <div>
        <button type="submit" disabled={pending} className="btn btn-primary btn-sm" style={{ opacity: pending ? 0.6 : 1 }}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
