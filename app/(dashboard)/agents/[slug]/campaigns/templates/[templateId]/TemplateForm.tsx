"use client";

import { useActionState, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteEmailTemplate, saveEmailTemplate, type ActionResult } from "@/lib/actions/email-campaigns";
import { parseTemplate, swapUnsubscribeLinks } from "@/lib/email-campaigns/template";

const field: React.CSSProperties = {
  width: "100%",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 12px",
  color: "var(--text)",
  fontSize: 13,
  boxSizing: "border-box",
};

export function TemplateForm({ id, name, html: initialHtml }: { id: string; name: string; html: string }) {
  const [html, setHtml] = useState(initialHtml);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(saveEmailTemplate, null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const router = useRouter();
  const parsed = useMemo(() => parseTemplate(html), [html]);
  const savedId = state?.ok ? state.id : id;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 20 }}>
      <form action={action} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <input type="hidden" name="id" value={savedId ?? ""} />
        <div className="card">
          <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>Name</label>
          <input name="name" defaultValue={name} style={field} required />

          <label style={{ fontSize: 12, fontWeight: 600, display: "block", margin: "14px 0 4px" }}>Master HTML</label>
          <textarea
            name="html"
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            rows={22}
            spellCheck={false}
            style={{ ...field, fontFamily: "monospace", fontSize: 11, resize: "vertical" }}
          />
          <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.6 }}>
            Wrap each piece the agent may rewrite: <code>{"<!--edit:headline text-->…<!--/edit:headline-->"}</code>. Kinds:{" "}
            <code>text</code> (plain), <code>rich</code> (bold, italic, links), <code>paragraphs</code> (a run of{" "}
            <code>{"<p>"}</code>). Keys with a dot share a group: <code>stats.1.value</code> is in <code>stats</code>. For{" "}
            <code>{"<title>"}</code>, put the markers around the whole element. Handlebars must stay outside markers. Unsubscribe
            links left as <code>href=&quot;#&quot;</code> are swapped for SendGrid&rsquo;s tags on every send.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn btn-primary btn-sm" disabled={pending || parsed.errors.length > 0}>{pending ? "Saving…" : "Save template"}</button>
          {savedId && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={async () => {
                const r = await deleteEmailTemplate(savedId);
                if (r.ok) router.push("/agents/email-marketing/campaigns");
                else setDeleteError(r.error);
              }}
            >
              Delete
            </button>
          )}
          {state && !state.ok && <span style={{ fontSize: 12, color: "var(--danger)" }}>{state.error}</span>}
          {state?.ok && <span style={{ fontSize: 12, color: "var(--success)" }}>{state.message}</span>}
          {deleteError && <span style={{ fontSize: 12, color: "var(--danger)" }}>{deleteError}</span>}
        </div>
      </form>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="card">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Editable sections</h2>
          {parsed.errors.map((e) => (
            <p key={e} style={{ fontSize: 12, color: "var(--danger)", marginBottom: 6 }}>{e}</p>
          ))}
          {parsed.sections.map((s) => (
            <div key={s.key} style={{ fontSize: 12, padding: "6px 0", borderTop: "1px solid var(--border)" }}>
              <code>{s.key}</code> <span style={{ color: "var(--text-dim)" }}>{s.kind}{s.occurrences > 1 ? ` ×${s.occurrences}` : ""}</span>
              <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{Array.isArray(s.original) ? s.original.join(" ¶ ") : s.original}</div>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {/* sandbox with no allow-* flags: no scripts, no navigation, no same-origin access */}
          <iframe title="Template preview" sandbox="" srcDoc={swapUnsubscribeLinks(html)} style={{ width: "100%", height: 720, border: 0, background: "#fff" }} />
        </div>
      </div>
    </div>
  );
}
