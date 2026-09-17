"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createOutboundPlay, updateOutboundPlay } from "@/lib/actions/outbound-plays";
import { toConfig, splitList, fieldStyle, label } from "@/app/(dashboard)/outbound/PlaysManager";
import type { OutboundPlayConfig } from "@/lib/agent-handlers/outbound-play-config";

/**
 * The ICP panel on the Outbound Scout agent page — lib/agent-handlers/outbound-scout.ts refuses to
 * run without an enabled play (correctly: it has no fallback audience to source against), but until
 * this panel existed the only place to see or set "who Scout searches Apollo for" was the play
 * editor buried in Outbound Engine → Plays (app/(dashboard)/outbound/PlaysManager.tsx). A
 * salesperson landing on /agents/outbound-scout saw a Run button and no explanation of what decides
 * its results. This panel surfaces the ICP (and the two other fields every agent downstream of
 * Scout reads — serviceOffer, proofPoints — plus dailySourcingCap, since that's Scout's own knob)
 * right where the Run button lives, and creates a first play in place when the workspace has none —
 * the case this exists for (Digital.Marketing has zero plays as of 2026-09-17).
 *
 * Deliberately NOT here: campaign selection (Instantly/Aimfox), CRM pipeline mapping, scoring
 * weights, routing thresholds. Those are one-shot admin setup, not something a salesperson tunes
 * per run, and duplicating their inputs here would just be a second place they can drift out of
 * sync with what PlaysManager shows — this panel links to /outbound for all of that instead.
 *
 * Saving goes through the exact same lib/actions/outbound-plays.ts server actions PlaysManager
 * uses (createOutboundPlay / updateOutboundPlay), so the WORKSPACE_ADMIN gate and
 * OutboundPlayConfigSchema validation are the one copy that exists anywhere — this file has no
 * save path of its own.
 */

type ScoutPlayRow = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  config: unknown;
};

interface ScoutIcpPanelProps {
  workspaceId: string;
  plays: ScoutPlayRow[];
  isAdmin: boolean;
}

// Same slugify a fresh play needs a slug at all: OutboundPlay.slug is what outbound-scout.ts's
// playSlug input, the RunModal's play_select dropdown, and the URL-safe identifier in
// app/api/outbound/plays/options/route.ts all key off. This panel doesn't ask for one (the "name +
// ICP fields" the ask calls for) — it derives one from the name and lets createOutboundPlay's own
// collision check force a retry with a numeric suffix in the rare case two plays would land on the
// same slug.
function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length >= 2 ? base : "play";
}

function summaryLine(items: string[], emptyText: string): string {
  return items.length > 0 ? items.join(", ") : emptyText;
}

function IcpForm({
  workspaceId,
  play,
  onDone,
  onCancel,
}: {
  workspaceId: string;
  play?: ScoutPlayRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(play?.name ?? "");
  const [config, setConfig] = useState<OutboundPlayConfig>(toConfig(play?.config));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function updateIcp<K extends keyof OutboundPlayConfig["icp"]>(key: K, value: OutboundPlayConfig["icp"][K]) {
    setConfig((c) => ({ ...c, icp: { ...c.icp, [key]: value } }));
  }

  // Retries createOutboundPlay with a numbered suffix if the derived slug collides — the panel
  // never shows a slug field (see slugify's comment above), so the person filling this in has no
  // way to fix a collision themselves; a couple of silent retries covers the realistic case
  // (two plays both named e.g. "Default"), and only surfaces the server's own error if that's
  // somehow still not enough.
  async function createWithSlug(baseSlug: string, attempt: number): Promise<void> {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    try {
      await createOutboundPlay(workspaceId, { slug, name, enabled: true, config });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (attempt < 3 && message.includes("already exists")) {
        return createWithSlug(baseSlug, attempt + 1);
      }
      throw err;
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        if (play) {
          await updateOutboundPlay(workspaceId, play.id, { slug: play.slug, name, enabled: play.enabled, config });
        } else {
          await createWithSlug(slugify(name), 0);
        }
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save the play");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <label style={label}>Play name</label>
        <input style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SaaS Engineering Capacity" required />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <div>
          <label style={label}>Titles (comma-separated)</label>
          <input style={fieldStyle} value={config.icp.titles.join(", ")} onChange={(e) => updateIcp("titles", splitList(e.target.value))} placeholder="VP Engineering, CTO" />
        </div>
        <div>
          <label style={label}>Seniorities</label>
          <input style={fieldStyle} value={config.icp.seniorities.join(", ")} onChange={(e) => updateIcp("seniorities", splitList(e.target.value))} placeholder="vp, director, c_suite" />
        </div>
        <div>
          <label style={label}>Employee ranges (min,max pairs)</label>
          <input style={fieldStyle} value={config.icp.employeeRanges.join(", ")} onChange={(e) => updateIcp("employeeRanges", splitList(e.target.value))} placeholder="51,500" />
        </div>
        <div>
          <label style={label}>Geographies</label>
          <input style={fieldStyle} value={config.icp.geographies.join(", ")} onChange={(e) => updateIcp("geographies", splitList(e.target.value))} placeholder="United States, Canada" />
        </div>
        <div>
          <label style={label}>Industries / keywords</label>
          <input style={fieldStyle} value={config.icp.industries.join(", ")} onChange={(e) => updateIcp("industries", splitList(e.target.value))} placeholder="B2B SaaS, fintech" />
        </div>
        <div>
          <label style={label}>Exclusions (company name/domain)</label>
          <input style={fieldStyle} value={config.icp.exclusions.join(", ")} onChange={(e) => updateIcp("exclusions", splitList(e.target.value))} placeholder="competitor.com" />
        </div>
      </div>

      <div>
        <label style={label}>Service offer</label>
        <textarea
          style={{ ...fieldStyle, minHeight: 56, resize: "vertical" }}
          value={config.serviceOffer}
          onChange={(e) => setConfig((c) => ({ ...c, serviceOffer: e.target.value }))}
          placeholder="What this play is selling — grounds every downstream agent's messaging."
        />
      </div>

      <div>
        <label style={label}>Proof points (one per line)</label>
        <textarea
          style={{ ...fieldStyle, minHeight: 50, resize: "vertical" }}
          value={config.proofPoints.join("\n")}
          onChange={(e) => setConfig((c) => ({ ...c, proofPoints: splitList(e.target.value) }))}
        />
      </div>

      <div style={{ maxWidth: 220 }}>
        <label style={label}>Daily sourcing cap</label>
        <input
          type="number"
          min={1}
          max={500}
          style={fieldStyle}
          value={config.dailySourcingCap}
          onChange={(e) => setConfig((c) => ({ ...c, dailySourcingCap: Number(e.target.value) }))}
        />
      </div>

      {error && <p style={{ fontSize: 12, color: "var(--danger)" }}>{error}</p>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
          {pending ? "Saving…" : play ? "Save ICP" : "Create play"}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function IcpSummary({ config }: { config: OutboundPlayConfig }) {
  const rows: Array<[string, string]> = [
    ["Titles", summaryLine(config.icp.titles, "Not set")],
    ["Seniorities", summaryLine(config.icp.seniorities, "Not set")],
    ["Employee ranges", summaryLine(config.icp.employeeRanges, "Not set")],
    ["Geographies", summaryLine(config.icp.geographies, "Not set")],
    ["Industries", summaryLine(config.icp.industries, "Not set")],
    ["Exclusions", summaryLine(config.icp.exclusions, "None")],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", gap: 10, fontSize: 12 }}>
          <span style={{ minWidth: 110, flexShrink: 0, color: "var(--text-dim)" }}>{k}</span>
          <span style={{ color: "var(--text-muted)" }}>{v}</span>
        </div>
      ))}
      <div style={{ display: "flex", gap: 10, fontSize: 12, marginTop: 4, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <span style={{ minWidth: 110, flexShrink: 0, color: "var(--text-dim)" }}>Service offer</span>
        <span style={{ color: "var(--text-muted)" }}>{config.serviceOffer || "Not set"}</span>
      </div>
      <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
        <span style={{ minWidth: 110, flexShrink: 0, color: "var(--text-dim)" }}>Proof points</span>
        <span style={{ color: "var(--text-muted)" }}>
          {config.proofPoints.length > 0 ? `${config.proofPoints.length} saved` : "None"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, fontSize: 12 }}>
        <span style={{ minWidth: 110, flexShrink: 0, color: "var(--text-dim)" }}>Daily sourcing cap</span>
        <span style={{ color: "var(--text-muted)" }}>{config.dailySourcingCap} prospects/run</span>
      </div>
    </div>
  );
}

function PlayCard({
  workspaceId,
  play,
  isAdmin,
  onSaved,
}: {
  workspaceId: string;
  play: ScoutPlayRow;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const config = toConfig(play.config);

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{play.name}</span>
          <span style={{ fontSize: 10, fontFamily: "monospace", color: "var(--text-dim)", background: "var(--surface-2)", border: "1px solid var(--border)", padding: "2px 6px", borderRadius: 4 }}>
            {play.slug}
          </span>
          {!play.enabled && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Paused</span>}
        </div>
        {isAdmin && !editing && (
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            Edit ICP
          </button>
        )}
      </div>

      {editing ? (
        <IcpForm
          workspaceId={workspaceId}
          play={play}
          onDone={() => {
            setEditing(false);
            onSaved();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <IcpSummary config={config} />
          {!isAdmin && (
            <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 10, fontStyle: "italic" }}>
              Only a workspace admin can change this. Ask one to update it here, or on the{" "}
              <Link href="/outbound" style={{ color: "var(--text-dim)" }}>
                Outbound Engine
              </Link>{" "}
              page.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function ScoutIcpPanel({ workspaceId, plays, isAdmin }: ScoutIcpPanelProps) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  function refresh() {
    setCreating(false);
    router.refresh();
  }

  return (
    <div className="card">
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>Who Scout targets</h2>
          <Link href="/outbound" style={{ fontSize: 12, color: "var(--text-dim)", textDecoration: "none" }}>
            Full play editor →
          </Link>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginTop: 6 }}>
          This ICP is what Scout searches Apollo.io with, and the offer/proof points every downstream agent
          writes from. Once a prospect qualifies, Email Outbound sends to this play&rsquo;s Instantly
          campaign — set the campaign, CRM pipeline, scoring weights, and routing thresholds on the{" "}
          <Link href="/outbound" style={{ color: "var(--text-muted)" }}>
            Outbound Engine
          </Link>{" "}
          page.
        </p>
      </div>

      {plays.length === 0 ? (
        creating || isAdmin ? (
          creating ? (
            <IcpForm workspaceId={workspaceId} onDone={refresh} onCancel={() => setCreating(false)} />
          ) : (
            <div style={{ textAlign: "center", padding: "20px 12px", border: "1px dashed var(--border-strong)", borderRadius: 8 }}>
              <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>No outbound play yet</p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>
                Scout has no ICP to search Apollo with. Create a play here to give it one.
              </p>
              <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                + Create a play
              </button>
            </div>
          )
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
            No outbound play exists yet, so Scout has nothing to run against. Ask a workspace admin to
            create one here or on the Outbound Engine page.
          </p>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {plays.map((play) => (
            <PlayCard key={play.id} workspaceId={workspaceId} play={play} isAdmin={isAdmin} onSaved={refresh} />
          ))}
          {isAdmin &&
            (creating ? (
              <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
                <IcpForm workspaceId={workspaceId} onDone={refresh} onCancel={() => setCreating(false)} />
              </div>
            ) : (
              <button className="btn btn-secondary btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setCreating(true)}>
                + New play
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
