"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOutboundPlay, updateOutboundPlay, setOutboundPlayEnabled } from "@/lib/actions/outbound-plays";
import { ResourceSelect } from "@/components/ui/ResourceSelect";
import {
  DEFAULT_SCORING_WEIGHTS,
  FORM_D_INDUSTRY_GROUPS,
  SCORING_DIMENSIONS,
  type OutboundPlayConfig,
  type ScoringDimension,
} from "@/lib/agent-handlers/outbound-play-config";

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

// Exported for reuse by the Outbound Scout agent page's ICP panel
// (app/(dashboard)/agents/[slug]/ScoutIcpPanel.tsx) — that panel edits the same OutboundPlay.config
// shape through the same two server actions, so it needs the same "what does a brand-new/partial
// config default to" and "how does a comma/newline list field parse" logic this file already has.
// Keeping one copy here (rather than forking it) is what guarantees a play created from either
// place produces the identical shape PlaysManager's own form would.
export const EMPTY_CONFIG: OutboundPlayConfig = {
  icp: { titles: [], seniorities: [], departments: [], employeeRanges: [], industries: [], geographies: [], technologies: [], exclusions: [] },
  serviceOffer: "",
  proofPoints: [],
  scoringWeights: {},
  routingThresholds: { emailAndLinkedin: 80, emailOnly: 65, watchlist: 50 },
  autoAdvance: true,
  dailySourcingCap: 30,
  crmDealOn: "interested",
  capitalRaise: {
    enabled: false,
    lookbackDays: 30,
    minOfferingUsd: 1_000_000,
    industryGroups: [],
    states: [],
    excludePooledInvestmentFunds: true,
    requireAmountSold: false,
    onlyRecentlyIncorporated: false,
    includeAmendments: false,
    contactRelationships: ["Executive Officer"],
    contactsPerIssuer: 2,
    dailyTick: false,
  },
};

export function toConfig(raw: unknown): OutboundPlayConfig {
  const c = (raw ?? {}) as Partial<OutboundPlayConfig> & {
    icp?: Partial<OutboundPlayConfig["icp"]>;
    capitalRaise?: Partial<OutboundPlayConfig["capitalRaise"]>;
  };
  return {
    ...EMPTY_CONFIG,
    ...c,
    icp: { ...EMPTY_CONFIG.icp, ...(c.icp ?? {}) },
    routingThresholds: { ...EMPTY_CONFIG.routingThresholds, ...(c.routingThresholds ?? {}) },
    // Spread over the defaults rather than taking the stored object wholesale: plays created
    // before capital-raise sourcing existed have no `capitalRaise` key at all, and one saved by
    // an older build may be missing individual fields.
    capitalRaise: { ...EMPTY_CONFIG.capitalRaise, ...(c.capitalRaise ?? {}) },
  };
}

export function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

export const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
};

export const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: 4 };

// Display label per scoring dimension — same six, same order, the Strategist's scoring prompt and
// submit_prospect_intelligence tool schema present them in (lib/agent-handlers/outbound-strategist.ts).
const SCORING_DIMENSION_LABELS: Record<ScoringDimension, string> = {
  signal: "Signal",
  serviceFit: "Service fit",
  firmographic: "Firmographic",
  persona: "Persona",
  timing: "Timing",
  dataQuality: "Data quality",
};

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

  function updateCapitalRaise<K extends keyof OutboundPlayConfig["capitalRaise"]>(
    key: K,
    value: OutboundPlayConfig["capitalRaise"][K],
  ) {
    setConfig((c) => ({ ...c, capitalRaise: { ...c.capitalRaise, [key]: value } }));
  }

  // A blank field means "not overridden" (resolveScoringWeights falls back to
  // DEFAULT_SCORING_WEIGHTS for it — see outbound-play-config.ts), so unlike routingThresholds
  // above (which always carries a concrete number) an unset dimension is stored as `undefined`
  // rather than defaulted in here, and the input shows the default as a placeholder instead of a
  // value — so it's visually distinct from a dimension someone has deliberately set to 0.
  function updateWeight(dim: ScoringDimension, raw: string) {
    const value = raw.trim() === "" ? undefined : Number(raw);
    setConfig((c) => ({ ...c, scoringWeights: { ...c.scoringWeights, [dim]: value } }));
  }

  // The running total shown below the fields: each dimension's typed value, or
  // DEFAULT_SCORING_WEIGHTS's value for one left blank — the same merge resolveScoringWeights()
  // does at run time (outbound-play-config.ts), before that function's own normalisation step. If
  // this doesn't add up to 100, nothing is rejected — resolveScoringWeights scales every dimension
  // proportionally so the total Claude actually scores against still comes out to exactly 100 (see
  // its doc comment for why that matters for routingThresholds) — but showing the raw sum here,
  // with a note when it's off, is what lets an admin catch a typo before saving rather than
  // discovering post-hoc that their weights got silently rescaled.
  const rawWeightTotal = SCORING_DIMENSIONS.reduce(
    (sum, dim) => sum + (config.scoringWeights[dim] ?? DEFAULT_SCORING_WEIGHTS[dim]),
    0,
  );

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

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Capital raise (SEC Form D)</p>
        <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10, maxWidth: 680 }}>
          Source prospects from companies that just filed a Form D with the SEC — the filing every company makes
          within 15 days of the first sale in a private raise. They have money to spend and the filing says so on
          the public record, with a date and a dollar figure. EDGAR is free and needs no account; resolving the
          officers who signed each filing into contacts uses your Apollo.io connection.
        </p>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={config.capitalRaise.enabled}
            onChange={(e) => updateCapitalRaise("enabled", e.target.checked)}
          />
          Source from SEC Form D filings
        </label>

        {config.capitalRaise.enabled && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              <div>
                <label style={label}>Filed within (days)</label>
                <input
                  type="number"
                  min={1}
                  max={90}
                  style={fieldStyle}
                  value={config.capitalRaise.lookbackDays}
                  onChange={(e) => updateCapitalRaise("lookbackDays", Number(e.target.value))}
                />
              </div>
              <div>
                <label style={label}>Min offering (USD)</label>
                <input
                  type="number"
                  min={0}
                  step={100_000}
                  style={fieldStyle}
                  value={config.capitalRaise.minOfferingUsd}
                  onChange={(e) => updateCapitalRaise("minOfferingUsd", Number(e.target.value))}
                />
              </div>
              <div>
                <label style={label}>Max offering (USD — blank for none)</label>
                <input
                  type="number"
                  min={0}
                  step={100_000}
                  style={fieldStyle}
                  value={config.capitalRaise.maxOfferingUsd ?? ""}
                  onChange={(e) =>
                    updateCapitalRaise("maxOfferingUsd", e.target.value === "" ? undefined : Number(e.target.value))
                  }
                />
              </div>
              <div>
                <label style={label}>Contacts per company</label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  style={fieldStyle}
                  value={config.capitalRaise.contactsPerIssuer}
                  onChange={(e) => updateCapitalRaise("contactsPerIssuer", Number(e.target.value))}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              <div>
                <label style={label}>Form D industry groups (blank = all)</label>
                <select
                  multiple
                  size={6}
                  style={{ ...fieldStyle, height: "auto" }}
                  value={config.capitalRaise.industryGroups}
                  onChange={(e) =>
                    updateCapitalRaise(
                      "industryGroups",
                      [...e.target.selectedOptions].map((o) => o.value),
                    )
                  }
                >
                  {FORM_D_INDUSTRY_GROUPS.map((group) => (
                    <option key={group} value={group}>{group}</option>
                  ))}
                </select>
                <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                  The SEC&apos;s own fixed list — the filer picks exactly one. Separate from the ICP keywords above,
                  which are Apollo&apos;s free text.
                </p>
              </div>
              <div>
                <label style={label}>Issuer states (2-letter, blank = anywhere)</label>
                <input
                  style={fieldStyle}
                  value={config.capitalRaise.states.join(", ")}
                  onChange={(e) => updateCapitalRaise("states", splitList(e.target.value).map((s) => s.toUpperCase()))}
                  placeholder="CA, NY, TX"
                />
                <label style={{ ...label, marginTop: 12 }}>Signatory roles to contact</label>
                <input
                  style={fieldStyle}
                  value={config.capitalRaise.contactRelationships.join(", ")}
                  onChange={(e) => updateCapitalRaise("contactRelationships", splitList(e.target.value))}
                  placeholder="Executive Officer, Director"
                />
                <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                  A Form D names its Executive Officers, Directors and Promoters. Officers sign nearly every filing
                  and are the decision maker in most plays.
                </p>
              </div>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={config.capitalRaise.excludePooledInvestmentFunds}
                  onChange={(e) => updateCapitalRaise("excludePooledInvestmentFunds", e.target.checked)}
                />
                Exclude investment funds
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={config.capitalRaise.requireAmountSold}
                  onChange={(e) => updateCapitalRaise("requireAmountSold", e.target.checked)}
                />
                Only if money has already come in
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={config.capitalRaise.onlyRecentlyIncorporated}
                  onChange={(e) => updateCapitalRaise("onlyRecentlyIncorporated", e.target.checked)}
                />
                Only companies under 5 years old
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={config.capitalRaise.includeAmendments}
                  onChange={(e) => updateCapitalRaise("includeAmendments", e.target.checked)}
                />
                Include amended filings (D/A)
              </label>
            </div>
            <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6, maxWidth: 680 }}>
              Keep &quot;Exclude investment funds&quot; on unless you sell to funds: about half of all Form D filings
              are VC, PE and hedge funds raising their own vehicles rather than operating companies with a budget.
            </p>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                cursor: "pointer",
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px solid var(--border)",
              }}
            >
              <input
                type="checkbox"
                checked={config.capitalRaise.dailyTick}
                onChange={(e) => updateCapitalRaise("dailyTick", e.target.checked)}
              />
              Pull new filings automatically once a day
            </label>
            <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, maxWidth: 680 }}>
              Runs the Scout against this play every morning, up to the daily sourcing cap below, and surfaces the
              batch for approval like any other run. Companies already in your pipeline are skipped before any
              Apollo credit is spent.
            </p>
          </>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Scoring weights</p>
        <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>
          Per-dimension point maxima the Strategist scores against. Leave a field blank to use its default (shown as a placeholder). Doesn&apos;t need to add up to 100 exactly — it&apos;s automatically scaled to a 100-point total when scoring runs, but keeping it close to 100 makes each dimension&apos;s weight easier to reason about.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {SCORING_DIMENSIONS.map((dim) => (
            <div key={dim}>
              <label style={label}>
                {SCORING_DIMENSION_LABELS[dim]} (0–{DEFAULT_SCORING_WEIGHTS[dim]} default)
              </label>
              <input
                type="number"
                min={0}
                max={DEFAULT_SCORING_WEIGHTS[dim]}
                style={fieldStyle}
                value={config.scoringWeights[dim] ?? ""}
                placeholder={String(DEFAULT_SCORING_WEIGHTS[dim])}
                onChange={(e) => updateWeight(dim, e.target.value)}
              />
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, marginTop: 10, color: rawWeightTotal === 100 ? "var(--text-dim)" : "var(--danger, #c0392b)" }}>
          Running total: {rawWeightTotal} / 100{rawWeightTotal !== 100 ? " — will be scaled to 100 automatically" : ""}
        </p>
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={label}>CRM pipeline (app.erp.io/crm)</label>
          <ResourceSelect
            id="crmPipelineId"
            optionsUrl="/api/outbound/integrations/options?provider=CRM_ERP_IO"
            value={config.crmPipelineId ?? ""}
            onChange={(v) => setConfig((c) => ({ ...c, crmPipelineId: v || undefined }))}
            fieldStyle={fieldStyle}
            emptyLabel="Outbound (the CRM creates it on the first reply)"
          />
          <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            Leave unset to use the CRM&rsquo;s own Outbound pipeline. Another pipeline only advances deals if its
            stages are named Replied / Interested / Meeting Set, or are mapped on the play.
          </p>
        </div>
        <div>
          <label style={label}>Open a CRM deal on</label>
          <select
            style={fieldStyle}
            value={config.crmDealOn}
            onChange={(e) => setConfig((c) => ({ ...c, crmDealOn: e.target.value as "interested" | "reply" }))}
          >
            <option value="interested">Interest or a booked meeting (recommended)</option>
            <option value="reply">Any reply</option>
          </select>
          <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            Every engagement writes the contact and a timeline entry either way. A bare reply is often
            &ldquo;remove me&rdquo;, which is why it does not open a deal by default.
          </p>
        </div>
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
