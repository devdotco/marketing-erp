"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/base-path";

export interface PromptRow {
  id: string;
  text: string;
  topic: string | null;
  source: string;
  active: boolean;
  captures: number;
}

interface Suggestion {
  text: string;
  topic: string;
  basis?: string;
  source: string;
}

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: "Added by you",
  SUGGESTED: "Proposed",
  SEARCH_CONSOLE: "From your search demand",
};

/**
 * The prompt list — the denominator of every figure on the visibility
 * dashboard.
 *
 * Suggestions are reviewed before they are stored, never written straight in.
 * Adding twenty prompts silently would move the workspace's headline number
 * for a reason nobody chose, and the first thing anyone would ask is why
 * visibility dropped.
 */
export function PromptManager({
  workspaceId,
  prompts,
}: {
  workspaceId: string;
  prompts: PromptRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"add" | "suggest" | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [groundedNote, setGroundedNote] = useState<string | null>(null);

  const active = prompts.filter((p) => p.active);
  const paused = prompts.filter((p) => !p.active);

  async function addFromDraft() {
    const lines = draft
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    setBusy("add");
    setError(null);
    try {
      const res = await apiFetch("/api/visibility/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, prompts: lines.map((text) => ({ text })) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add those prompts.");
      setDraft("");
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function propose() {
    setBusy("suggest");
    setError(null);
    setSuggestions(null);
    try {
      const res = await apiFetch("/api/visibility/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, count: 20 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.hint ? `${body.error} ${body.hint}` : body.error);
      setSuggestions(body.suggestions ?? []);
      setChosen(new Set((body.suggestions ?? []).map((_: unknown, i: number) => i)));
      setGroundedNote(
        body.groundedInSearchConsole
          ? "Proposed from your own highest-impression non-branded Search Console queries — questions this audience already asks."
          : "Proposed from your business profile. Connect Search Console for prompts grounded in demand you already have.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function acceptChosen() {
    if (!suggestions) return;
    const picked = suggestions.filter((_, i) => chosen.has(i));
    if (picked.length === 0) return;

    setBusy("add");
    try {
      const res = await apiFetch("/api/visibility/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, prompts: picked }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add those prompts.");
      setSuggestions(null);
      setGroundedNote(null);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function setActive(id: string, next: boolean) {
    await apiFetch("/api/visibility/prompts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, id, active: next }),
    });
    startTransition(() => router.refresh());
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && (
        <div style={{ background: "var(--danger-bg)", border: "1px solid var(--danger)", borderRadius: "var(--radius)", padding: "12px 16px" }}>
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>{error}</p>
        </div>
      )}

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Add prompts</h2>
        <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12, lineHeight: 1.6 }}>
          One question per line, written the way someone talks to an assistant. Leave your own brand name out — a
          prompt that names you is answered with your name and measures nothing.
        </p>
        <textarea
          id="prompt-draft"
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          placeholder={"What's the best CRM for a small manufacturing business?\nHow do I automate client reporting?"}
          style={{ width: "100%", fontSize: 13, lineHeight: 1.6, resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn btn-primary btn-sm" onClick={addFromDraft} disabled={busy !== null || !draft.trim()}>
            {busy === "add" ? "Adding…" : "Add prompts"}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={propose} disabled={busy !== null}>
            {busy === "suggest" ? "Reading your search demand…" : "Propose prompts for me"}
          </button>
        </div>
      </div>

      {suggestions && (
        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {suggestions.length} proposed — pick the ones worth tracking
          </h2>
          {groundedNote && (
            <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12, lineHeight: 1.6 }}>{groundedNote}</p>
          )}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {suggestions.map((s, i) => (
              <li key={`${s.text}-${i}`}>
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                  <input
                    id={`suggestion-${i}`}
                    type="checkbox"
                    checked={chosen.has(i)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setChosen(next);
                    }}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 13, color: "var(--text)", display: "block", lineHeight: 1.5 }}>{s.text}</span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      {s.topic}
                      {s.basis ? ` · from "${s.basis}"` : ""}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary btn-sm" onClick={acceptChosen} disabled={busy !== null || chosen.size === 0}>
              Track {chosen.size} {chosen.size === 1 ? "prompt" : "prompts"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSuggestions(null)} disabled={busy !== null}>
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          Tracked ({active.length})
        </h2>
        {active.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>
            Nothing is being tracked, so nothing can be measured.
          </p>
        ) : (
          <PromptTable rows={active} onToggle={setActive} pending={pending} actionLabel="Pause" nextActive={false} />
        )}
      </div>

      {paused.length > 0 && (
        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Paused ({paused.length})</h2>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14, lineHeight: 1.6 }}>
            No longer asked. Their past captures stay in the history — that is why a prompt is paused rather than
            deleted.
          </p>
          <PromptTable rows={paused} onToggle={setActive} pending={pending} actionLabel="Resume" nextActive />
        </div>
      )}
    </div>
  );
}

function PromptTable({
  rows,
  onToggle,
  pending,
  actionLabel,
  nextActive,
}: {
  rows: PromptRow[];
  onToggle: (id: string, next: boolean) => void;
  pending: boolean;
  actionLabel: string;
  nextActive: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Prompt</th>
            <th style={{ width: 170 }}>Source</th>
            <th style={{ width: 90 }}>Captures</th>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>
                <span style={{ fontSize: 13 }}>{p.text}</span>
                {p.topic && (
                  <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)" }}>{p.topic}</span>
                )}
              </td>
              <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{SOURCE_LABEL[p.source] ?? p.source}</td>
              <td style={{ fontVariantNumeric: "tabular-nums" }}>{p.captures}</td>
              <td>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => onToggle(p.id, nextActive)}
                  disabled={pending}
                >
                  {actionLabel}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
