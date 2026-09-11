"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/base-path";
import {
  EDITORIAL_PRESETS,
  getPreset,
  resolveProfile,
  type EditorialProfile,
} from "@/lib/content/editorial";

interface Props {
  workspaceId: string;
  savedPreset: string;
  savedOverrides: Record<string, unknown>;
}

/** The fields worth exposing. The rest of the profile is preset-controlled. */
const LIST_FIELDS: Array<{ key: keyof EditorialProfile; label: string; hint: string }> = [
  { key: "bannedWords", label: "Banned words", hint: "One per line. Checked in the title and headings as well as the body." },
  { key: "bannedPhrases", label: "Banned phrases", hint: "One per line. Stock phrasing you never want to see." },
  { key: "bannedHeadings", label: "Banned headings", hint: "One per line, lowercase. Section headings that may not be used." },
  { key: "rationedWords", label: "Rationed words", hint: "One per line. Allowed at most once per piece, and never in a title." },
  { key: "bannedSourceDomains", label: "Never link these domains", hint: "One per line. Excluded from search results and checked again on the finished piece." },
  { key: "voiceRules", label: "Voice rules", hint: "One per line. Added to the writer's instructions verbatim, so write them as directions." },
];

const NUMBER_FIELDS: Array<{ key: keyof EditorialProfile; label: string; hint: string; min: number; max: number }> = [
  { key: "minSections", label: "Minimum sections", hint: "Fewer than this is a defect.", min: 1, max: 12 },
  { key: "maxSections", label: "Maximum sections", hint: "More than this is a warning.", min: 2, max: 20 },
  { key: "maxParagraphSentences", label: "Maximum sentences per paragraph", hint: "A longer paragraph is sent back to be split.", min: 2, max: 12 },
  { key: "maxAnchorWords", label: "Maximum words in a link anchor", hint: "A longer anchor is a defect, except where you specified the anchor yourself.", min: 1, max: 10 },
];

const TOGGLES: Array<{ key: keyof EditorialProfile; label: string; hint: string }> = [
  { key: "allowEmDash", label: "Allow em-dashes", hint: "Off makes every em-dash a defect." },
  { key: "useContractions", label: "Use contractions", hint: "Off asks for a more formal register." },
  { key: "requireIntro", label: "Require an intro", hint: "On, opening straight into a subheading is a defect." },
  { key: "requireHeadingVariety", label: "Require heading variety", hint: "On, headings that all share one grammatical shape are a defect." },
  { key: "requireCitations", label: "Require citations", hint: "On, any stated fact needs a link to a page that states it." },
  { key: "banNegationFlip", label: "Ban the negation flip", hint: 'Catches "The cleaning worked. The equipment didn\'t."' },
  { key: "banInventedPrecision", label: "Ban invented precision", hint: 'Catches made-up clock times and "on a Tuesday afternoon".' },
];

export function EditorialForm({ workspaceId, savedPreset, savedOverrides }: Props) {
  const [preset, setPreset] = useState(savedPreset);
  const [profile, setProfile] = useState<EditorialProfile>(() =>
    resolveProfile(savedPreset, savedOverrides),
  );
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const base = useMemo(() => getPreset(preset), [preset]);
  const changed = useMemo(
    () =>
      (Object.keys(base) as Array<keyof EditorialProfile>).filter(
        (field) =>
          field !== "key" &&
          field !== "name" &&
          field !== "description" &&
          JSON.stringify(profile[field]) !== JSON.stringify(base[field]),
      ),
    [base, profile],
  );

  function choosePreset(key: string) {
    setPreset(key);
    // Switching preset replaces the whole rule set rather than layering on the
    // old one, which is what someone picking a different voice means by it.
    setProfile(getPreset(key));
    setStatus(null);
  }

  function set<K extends keyof EditorialProfile>(field: K, value: EditorialProfile[K]) {
    setProfile((current) => ({ ...current, [field]: value }));
    setStatus(null);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await apiFetch("/api/settings/editorial", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, preset, overrides: profile }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not save");
        setStatus(
          data.customisedFields.length === 0
            ? `Saved. Using "${base.name}" unchanged.`
            : `Saved. ${data.customisedFields.length} field(s) customised on top of "${base.name}".`,
        );
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save");
      }
    });
  }

  const fieldStyle: React.CSSProperties = {
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
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Starting point</h2>
        <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
          Every preset is a starting point, not a cage. Change anything below and only your
          changes are stored, so the rest keeps improving as the preset does.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {EDITORIAL_PRESETS.map((option) => (
            <label
              key={option.key}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                padding: 12,
                border: `1px solid ${preset === option.key ? "var(--text)" : "var(--border)"}`,
                borderRadius: "var(--radius)",
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="preset"
                checked={preset === option.key}
                onChange={() => choosePreset(option.key)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ fontSize: 13, fontWeight: 600, display: "block" }}>{option.name}</span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>How it should read</h2>
        <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
          Voice summary
        </label>
        <textarea
          value={profile.voiceSummary}
          onChange={(e) => set("voiceSummary", e.target.value)}
          rows={3}
          style={{ ...fieldStyle, resize: "vertical" }}
        />
        <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "4px 0 0" }}>
          Goes into the writer&rsquo;s instructions word for word. Describe how the writing should
          sound, not what it should be about.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
              Language
            </label>
            <input
              value={profile.language}
              onChange={(e) => set("language", e.target.value)}
              style={fieldStyle}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
              Default point of view
            </label>
            <select
              value={profile.defaultPointOfView}
              onChange={(e) => set("defaultPointOfView", e.target.value)}
              style={fieldStyle}
            >
              <option>Third person (no I, we, our)</option>
              <option>First person plural (we, our)</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Prohibitions</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {LIST_FIELDS.map((field) => (
            <div key={field.key}>
              <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
                {field.label}
              </label>
              <textarea
                value={(profile[field.key] as string[]).join("\n")}
                onChange={(e) =>
                  set(
                    field.key,
                    e.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean) as never,
                  )
                }
                rows={3}
                style={{ ...fieldStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              />
              <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "4px 0 0" }}>{field.hint}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Limits</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {NUMBER_FIELDS.map((field) => (
            <div key={field.key}>
              <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
                {field.label}
              </label>
              <input
                type="number"
                min={field.min}
                max={field.max}
                value={profile[field.key] as number}
                onChange={(e) => set(field.key, Number(e.target.value) as never)}
                style={fieldStyle}
              />
              <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "4px 0 0" }}>{field.hint}</p>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
          {TOGGLES.map((toggle) => (
            <label key={toggle.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={profile[toggle.key] as boolean}
                onChange={(e) => set(toggle.key, e.target.checked as never)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ fontSize: 13, display: "block" }}>{toggle.label}</span>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{toggle.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          position: "sticky",
          bottom: 0,
          background: "var(--bg)",
          padding: "12px 0",
        }}
      >
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
          {changed.length === 0
            ? `Using "${base.name}" unchanged.`
            : `${changed.length} field(s) customised: ${changed.slice(0, 4).join(", ")}${changed.length > 4 ? "…" : ""}`}
          {status && <span style={{ color: "var(--success)", marginLeft: 8 }}>{status}</span>}
          {error && <span style={{ color: "var(--danger)", marginLeft: 8 }}>{error}</span>}
        </p>
        <button onClick={save} disabled={pending} className="btn btn-primary btn-sm">
          {pending ? "Saving…" : "Save editorial profile"}
        </button>
      </div>
    </div>
  );
}
