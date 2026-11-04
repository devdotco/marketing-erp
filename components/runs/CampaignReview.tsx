"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/base-path";

/**
 * The review screen for an Email Marketing campaign-type run: the briefing the
 * old Gmail draft carried (send and load day, three subjects with a pick,
 * preheader, audience, what changed, sources, flags), the code checks, and the
 * finished email in a sandboxed preview.
 */
export function CampaignReview({ runId, output, editable }: { runId: string; output: Record<string, unknown>; editable: boolean }) {
  const subjects = Array.isArray(output.subjects) ? (output.subjects as string[]) : [];
  const recommended = Number(output.recommendedSubject ?? 0);
  const [chosen, setChosen] = useState(String(output.chosenSubject ?? subjects[recommended] ?? ""));
  const [custom, setCustom] = useState(subjects.includes(chosen) ? "" : chosen);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const list = (key: string) => (Array.isArray(output[key]) ? (output[key] as unknown[]) : []);
  const audience = list("audience") as { name: string; contacts: number; kind: string }[];
  const checks = list("checks") as { name: string; passed: boolean; detail?: string }[];
  const flags = list("flags") as string[];
  const single = output.singleSend as { id?: string; status?: string; error?: string } | undefined;
  const scheduled = output.scheduled as { at: string; subject: string } | undefined;

  function pick(subject: string) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await apiFetch(`/api/runs/${runId}/email-subject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setError(d.error ?? "Couldn't save the subject");
      else {
        setChosen(d.chosenSubject);
        setSaved(true);
        router.refresh();
      }
    });
  }

  const row: React.CSSProperties = { fontSize: 13, lineHeight: 1.6, marginBottom: 6 };
  const head: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "14px 0 6px" };

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            {output.test === true ? "[TEST] " : ""}
            {String(output.campaignName ?? "Campaign")} briefing
          </h2>
          {scheduled ? (
            <span className="badge badge-approved">Scheduled</span>
          ) : (
            <span className="badge badge-awaiting">{single?.id ? "Draft in SendGrid" : "No SendGrid draft yet"}</span>
          )}
        </div>
        <div style={row}>
          <strong>Sends</strong> {String(output.sendAtLabel ?? "")} · review by {String(output.loadDay ?? "")}
        </div>
        <div style={row}>
          <strong>Audience</strong>{" "}
          {audience.length ? audience.map((a) => `${a.name}${a.contacts >= 0 ? ` (${a.contacts.toLocaleString()})` : ""}`).join(", ") : "not set"}
        </div>
        <div style={row}>
          <strong>Preheader</strong> {String(output.preheader ?? "")}
        </div>

        <div style={head}>Subject</div>
        {subjects.map((s, i) => (
          <label key={s} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, padding: "3px 0" }}>
            <input type="radio" name="subject" checked={chosen === s} disabled={!editable || pending} onChange={() => pick(s)} />
            {s}
            {i === recommended && <span className="badge badge-muted">recommended</span>}
          </label>
        ))}
        {editable && (
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Or write your own"
              style={{ flex: 1, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", color: "var(--text)", fontSize: 13 }}
            />
            <button className="btn btn-secondary btn-sm" disabled={pending || !custom.trim()} onClick={() => pick(custom)}>
              Use this
            </button>
          </div>
        )}
        {error && <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{error}</p>}
        {saved && <p style={{ fontSize: 12, color: "var(--success)", marginTop: 6 }}>Sends as &ldquo;{chosen}&rdquo;.</p>}

        {list("whatChanged").length > 0 && (
          <>
            <div style={head}>What changed</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(list("whatChanged") as string[]).map((w) => <li key={w} style={row}>{w}</li>)}
            </ul>
          </>
        )}

        <div style={head}>Sources</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {(list("sourcesRead") as { url: string; ok: boolean; error?: string }[]).map((s) => (
            <li key={s.url} style={row}>
              <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a> {s.ok ? "" : <span style={{ color: "var(--warning)" }}>not read: {s.error}</span>}
            </li>
          ))}
          {list("sourcesRead").length === 0 && <li style={row}>None configured</li>}
        </ul>

        {flags.length > 0 && (
          <>
            <div style={head}>Flags</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {flags.map((f) => <li key={f} style={{ ...row, color: "var(--warning)" }}>{f}</li>)}
            </ul>
          </>
        )}

        <div style={head}>Checks</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {checks.map((c) => (
            <span key={c.name} className={`badge ${c.passed ? "badge-completed" : "badge-failed"}`} title={c.detail}>
              {c.passed ? "✓" : "✗"} {c.name}
            </span>
          ))}
        </div>
        {single?.error && <p style={{ fontSize: 12, color: "var(--warning)", marginTop: 10 }}>SendGrid draft: {single.error}</p>}
        {scheduled && (
          <p style={{ fontSize: 12, color: "var(--success)", marginTop: 10 }}>
            Scheduled in SendGrid as &ldquo;{scheduled.subject}&rdquo; for {String(output.sendAtLabel ?? "")}.
          </p>
        )}
        {output.test === true && !scheduled && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>Test run: approving it will not schedule anything.</p>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {/* sandbox with no allow-* flags: the email's links and any markup stay inert */}
        <iframe title="Email preview" sandbox="" srcDoc={String(output.html ?? "")} style={{ width: "100%", height: 900, border: 0, background: "#fff" }} />
      </div>
    </>
  );
}
