"use client";

import { useState, type ReactNode } from "react";
import type { SetupGuide as SetupGuideType } from "@/lib/integrations/guides/types";

/**
 * Renders a customer-facing setup guide: You'll-need checklist, numbered
 * steps, how-to-verify, a collapsible troubleshooting list, a privacy note,
 * and doc links. Used two ways:
 *
 *  - `<SetupGuide guide={…} />` — the full panel, shown prominently beside
 *    the connect form on app/(dashboard)/integrations/connect/[provider].
 *  - `<SetupGuideExpander guide={…} />` — a "Setup guide" link on each row of
 *    the Integrations list that expands the same panel in place, including
 *    for providers marked Soon / Not set up (the guide still explains what
 *    will be needed once the provider is live).
 *
 * Pure UI: takes a SetupGuide value, renders it. No data fetching.
 */

const panelStyle: React.CSSProperties = {
  padding: "20px 20px 24px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  display: "flex",
  flexDirection: "column",
  gap: 18,
};

/** ── Tiny inline-markdown renderer: **bold**, `code`, [label](https://…) ── */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${i}`} style={{ color: "var(--text)" }}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={`${keyPrefix}-c-${i}`} className="mono" style={{ background: "var(--surface-2)", padding: "1px 5px", borderRadius: 3 }}>
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      if (linkMatch) {
        nodes.push(
          <a
            key={`${keyPrefix}-l-${i}`}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--info)" }}
          >
            {linkMatch[1]}
          </a>,
        );
      }
    }
    lastIndex = regex.lastIndex;
    i += 1;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

type BodySegment = { type: "text"; content: string } | { type: "code"; content: string };

/** Splits a step body on ```fenced code blocks``` so they render as <pre><code>, not inline text. */
function splitCodeBlocks(body: string): BodySegment[] {
  const regex = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  const segments: BodySegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body))) {
    if (match.index > lastIndex) segments.push({ type: "text", content: body.slice(lastIndex, match.index) });
    segments.push({ type: "code", content: match[1].replace(/\n$/, "") });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < body.length) segments.push({ type: "text", content: body.slice(lastIndex) });
  return segments;
}

function renderBody(body: string, keyPrefix: string): ReactNode {
  const segments = splitCodeBlocks(body);
  return segments.map((seg, si) => {
    if (seg.type === "code") {
      return (
        <pre
          key={`${keyPrefix}-code-${si}`}
          className="mono"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: "10px 12px",
            overflowX: "auto",
            margin: "8px 0",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          <code>{seg.content}</code>
        </pre>
      );
    }
    const paragraphs = seg.content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    return paragraphs.map((para, pi) => (
      <p key={`${keyPrefix}-p-${si}-${pi}`} style={{ margin: pi === 0 && si === 0 ? 0 : "8px 0 0", color: "var(--text-muted)" }}>
        {para.split("\n").map((line, li, arr) => (
          <span key={li}>
            {renderInline(line, `${keyPrefix}-${si}-${pi}-${li}`)}
            {li < arr.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    ));
  });
}

function CheckList({ items }: { items: string[] }) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((item, i) => (
        <li key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          <span aria-hidden style={{ color: "var(--text-dim)", flexShrink: 0 }}>
            ☐
          </span>
          <span>{renderInline(item, `need-${i}`)}</span>
        </li>
      ))}
    </ul>
  );
}

export function SetupGuide({ guide, compact }: { guide: SetupGuideType; compact?: boolean }) {
  const [troubleshootingOpen, setTroubleshootingOpen] = useState(false);

  return (
    <div style={compact ? { ...panelStyle, padding: "16px 16px 18px" } : panelStyle}>
      <div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <span className="input-label" style={{ marginBottom: 0, fontSize: 12 }}>
            Setup guide
          </span>
          <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>~{guide.timeMinutes} min</span>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 0 0", lineHeight: 1.6 }}>{guide.summary}</p>
      </div>

      <div>
        <div className="input-label">You&apos;ll need</div>
        <CheckList items={guide.youWillNeed} />
      </div>

      <div className="divider" style={{ margin: 0 }} />

      <div>
        <div className="input-label">Steps</div>
        <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          {guide.steps.map((step, i) => (
            <li key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span
                className="step-dot"
                style={{ borderColor: "var(--border-strong)", color: "var(--text-muted)", flexShrink: 0 }}
              >
                {i + 1}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{step.title}</div>
                <div style={{ fontSize: 12.5 }}>{renderBody(step.body, `step-${i}`)}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="divider" style={{ margin: 0 }} />

      <div>
        <div className="input-label">How to confirm it worked</div>
        <CheckList items={guide.verify} />
      </div>

      <div className="divider" style={{ margin: 0 }} />

      <div>
        <button
          type="button"
          onClick={() => setTroubleshootingOpen((v) => !v)}
          aria-expanded={troubleshootingOpen}
          className="btn btn-ghost btn-sm"
          style={{ padding: "4px 0", justifyContent: "flex-start", gap: 6, fontWeight: 600, color: "var(--text)" }}
        >
          <span aria-hidden style={{ display: "inline-block", transition: "transform 0.15s", transform: troubleshootingOpen ? "rotate(90deg)" : "none" }}>
            ›
          </span>
          Troubleshooting ({guide.troubleshooting.length})
        </button>
        {troubleshootingOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8, paddingLeft: 4 }}>
            {guide.troubleshooting.map((entry, i) => (
              <div key={i}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{renderInline(entry.symptom, `symptom-${i}`)}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.6 }}>
                  {renderInline(entry.fix, `fix-${i}`)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="divider" style={{ margin: 0 }} />

      <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
        <strong style={{ color: "var(--text)" }}>Privacy: </strong>
        {renderInline(guide.privacy, "privacy")}
      </div>

      {guide.docs.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {guide.docs.map((doc, i) => (
            <a
              key={i}
              href={doc.url}
              target="_blank"
              rel="noopener noreferrer"
              className="badge badge-muted"
              style={{ textDecoration: "none", cursor: "pointer" }}
            >
              {doc.label} ↗
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsed-by-default "Setup guide" link for a row on the Integrations
 * list — including rows marked Soon / Not set up, where the guide still
 * explains what will be needed once the provider is available.
 */
export function SetupGuideExpander({ guide }: { guide: SetupGuideType }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontSize: 11,
          color: "var(--text-dim)",
          textDecoration: "underline",
          textUnderlineOffset: 2,
        }}
      >
        {open ? "Hide setup guide" : "Setup guide"}
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <SetupGuide guide={guide} compact />
        </div>
      )}
    </div>
  );
}
