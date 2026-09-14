"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOutboundPlay, updateOutboundPlay, setOutboundPlayEnabled } from "@/lib/actions/outbound-plays";
import { ResourceSelect } from "@/components/ui/ResourceSelect";
import type { OutboundPlayConfig } from "@/lib/agent-handlers/outbound-play-config";

type PlayRow = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  config: unknown;
  prospectCount: number;
};

interface PlaysManagerProps {
  workspaceId: string;
  plays: PlayRow[];
  isAdmin: boolean;
}

const EMPTY_CONFIG: OutboundPlayConfig = {
  icp: { titles: [], seniorities: [], departments: [], employeeRanges: [], industries: [], geographies: [], technologies: [], exclusions: [] },
  serviceOffer: "",
  proofPoints: [],
  scoringWeights: {},
  routingThresholds: { emailAndLinkedin: 80, emailOnly: 65, watchlist: 50 },
  autoAdvance: true,
  dailySourcingCap: 30,
};

function toConfig(raw: unknown): OutboundPlayConfig {
  const c = (raw ?? {}) as Partial<OutboundPlayConfig> & { icp?: Partial<OutboundPlayConfig["icp"]> };
  return {
    ...EMPTY_CONFIG,
    ...c,
    icp: { ...EMPTY_CONFIG.icp, ...(c.icp ?? {}) },
    routingThresholds: { ...EMPTY_CONFIG.routingThresholds, ...(c.routingThresholds ?? {}) },
  };
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
};

const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 4 };

function PlayForm({
  workspaceId,
  play,
  onDone,
  onCancel,
}: {
  workspaceId: string;
  play?: PlayRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [slug, setSlug] = useState(play?.slug ?? "");
  const [name, setName] = useState(play?.name ?? "");
  const [enabled, setEnabled] = useState(play?.enabled ?? true);
  const [config, setConfig] = useState<OutboundPlayConfig>(toConfig(play?.config));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function updateIcp<K extends keyof OutboundPlayConfig["icp"]>(key: K, value: OutboundPlayConfig["icp"][K]) {
    setConfig((c) => ({ ...c, icp: { ...c.icp, [key]: value } }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const input = { slug, name, enabled, config };
        if (play) {
          await updateOutboundPlay(workspaceId, play.id, input);
        } else {
          await createOutboundPlay(workspaceId, input);
        }
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save play");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={label}>Name</label>
          <input style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SaaS Engineering Capacity" required />
        </div>
        <div>
          <label style={label}>Slug</label>
          <input style={fieldStyle} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e.g. saas-engineering" required />
        </div>
      </div>

      <div>
        <label style={label}>Service offer</label>
        <textarea style={{ ...fieldStyle, minHeight: 60, resize: "vertical" }} value={config.serviceOffer} onChange={(e) => setConfig((c) => ({ ...c, serviceOffer: e.target.value }))} placeholder="What this play is selling — grounds every downstream agent's messaging." />
      </div>

      <div>
        <label style={label}>Proof points (one per line)</label>
        <textarea style={{ ...fieldStyle, minHeight: 50, resize: "vertical" }} value={config.proofPoints.join("\n")} onChange={(e) => setConfig((c) => ({ ...c, proofPoints: splitList(e.target.value) }))} />
      </div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>ICP (Apollo.io filters)</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
          <div>
            <label style={label}>Departments (reference only — not yet sent to Apollo)</label>
            <input style={fieldStyle} value={config.icp.departments.join(", ")} onChange={(e) => updateIcp("departments", splitList(e.target.value))} />
          </div>
          <div>
            <label style={label}>Technologies (reference only — not yet sent to Apollo)</label>
            <input style={fieldStyle} value={config.icp.technologies.join(", ")} onChange={(e) => updateIcp("technologies", splitList(e.target.value))} />
          </div>
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <div>
          <label style={label}>Route to Email+LinkedIn at</label>
          <input type="number" style={fieldStyle} value={config.routingThresholds.emailAndLinkedin} onChange={(e) => setConfig((c) => ({ ...c, routingThresholds: { ...c.routingThresholds, emailAndLinkedin: Number(e.target.value) } }))} />
        </div>
        <div>
          <label style={label}>Route to Email at</label>
          <input type="number" style={fieldStyle} value={config.routingThresholds.emailOnly} onChange={(e) => setConfig((c) => ({ ...c, routingThresholds: { ...c.routingThresholds, emailOnly: Number(e.target.value) } }))} />
        </div>
        <div>
          <label style={label}>Watchlist at</label>
          <input type="number" style={fieldStyle} value={config.routingThresholds.watchlist} onChange={(e) => setConfig((c) => ({ ...c, routingThresholds: { ...c.routingThresholds, watchlist: Number(e.target.value) } }))} />
        </div>
        <div>
          <label style={label}>Daily sourcing cap</label>
          <input type="number" style={fieldStyle} value={config.dailySourcingCap} onChange={(e) => setConfig((c) => ({ ...c, dailySourcingCap: Number(e.target.value) }))} />
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={label}>Instantly campaign</label>
          <ResourceSelect id="instantlyCampaignId" optionsUrl="/api/outbound/integrations/options?provider=INSTANTLY" value={config.instantlyCampaignId ?? ""} onChange={(v) => setConfig((c) => ({ ...c, instantlyCampaignId: v || undefined }))} fieldStyle={fieldStyle} />
          <input
            style={{ ...fieldStyle, marginTop: 6 }}
            value={config.instantlyCampaignName ?? ""}
            onChange={(e) => setConfig((c) => ({ ...c, instantlyCampaignName: e.target.value || undefined }))}
            placeholder="Or type the campaign name (used until Instantly is connected)"
          />
        </div>
        <div>
          <label style={label}>Aimfox campaign</label>
          <ResourceSelect id="aimfoxCampaignId" optionsUrl="/api/outbound/integrations/options?provider=AIMFOX" value={config.aimfoxCampaignId ?? ""} onChange={(v) => setConfig((c) => ({ ...c, aimfoxCampaignId: v || undefined }))} fieldStyle={fieldStyle} />
          <input
            style={{ ...fieldStyle, marginTop: 6 }}
            value={config.aimfoxCampaignName ?? ""}
            onChange={(e) => setConfig((c) => ({ ...c, aimfoxCampaignName: e.target.value || undefined }))}
            placeholder="Or type the campaign name (used until Aimfox is connected)"
          />
        </div>
      </div>

      <div>
        <label style={label}>GoHighLevel pipeline id (optional — falls back to a pipeline named "Outbound")</label>
        <input style={fieldStyle} value={config.ghlPipelineId ?? ""} onChange={(e) => setConfig((c) => ({ ...c, ghlPipelineId: e.target.value || undefined }))} placeholder="e.g. qWRoUZ6kNRf4Mx3RRtgs" />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={config.autoAdvance} onChange={(e) => setConfig((c) => ({ ...c, autoAdvance: e.target.checked }))} />
          Auto-advance (Scout → Strategist → Email/LinkedIn Outbound run automatically)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>

      {error && <p style={{ fontSize: 12, color: "var(--danger)" }}>{error}</p>}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
          {pending ? "Saving…" : play ? "Save changes" : "Create play"}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function PlaysManager({ workspaceId, plays, isAdmin }: PlaysManagerProps) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [, startTransition] = useTransition();

  function refresh() {
    setEditingId(null);
    setCreating(false);
    router.refresh();
  }

  function toggleEnabled(play: PlayRow) {
    startTransition(async () => {
      try {
        await setOutboundPlayEnabled(workspaceId, play.id, !play.enabled);
        router.refresh();
      } catch {
        // best-effort — the row simply won't flip; no toast system here to surface a failure with.
      }
    });
  }

  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>
          Plays
        </h2>
        {isAdmin && !creating && (
          <button className="btn btn-secondary btn-sm" onClick={() => setCreating(true)}>
            + New play
          </button>
        )}
      </div>

      {creating && <PlayForm workspaceId={workspaceId} onDone={refresh} onCancel={() => setCreating(false)} />}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {plays.map((play) =>
          editingId === play.id ? (
            <PlayForm key={play.id} workspaceId={workspaceId} play={play} onDone={refresh} onCancel={() => setEditingId(null)} />
          ) : (
            <div
              key={play.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 14px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{play.name}</span>
                <span style={{ fontSize: 10, fontFamily: "monospace", color: "var(--text-dim)", background: "var(--surface-2)", border: "1px solid var(--border)", padding: "2px 6px", borderRadius: 4 }}>
                  {play.slug}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{play.prospectCount} prospects</span>
                {!play.enabled && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Paused</span>}
              </div>
              {isAdmin && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(play.id)}>Edit</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => toggleEnabled(play)}>
                    {play.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
              )}
            </div>
          ),
        )}
        {plays.length === 0 && !creating && (
          <p style={{ fontSize: 12, color: "var(--text-dim)" }}>
            No outbound plays yet. {isAdmin ? "Create one above to start sourcing." : "Ask a workspace admin to create one."}
          </p>
        )}
      </div>
    </div>
  );
}
