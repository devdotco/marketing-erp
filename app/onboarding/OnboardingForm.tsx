"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/base-path";

const STEPS = [
  { id: 1, label: "Your business", hint: "Help agents understand what you do" },
  { id: 2, label: "Your goals",    hint: "What marketing outcomes matter most" },
  { id: 3, label: "Your audience", hint: "Who you're trying to reach" },
  { id: 4, label: "First agent",   hint: "Enable one agent to get started" },
];

const FIRST_AGENTS = [
  { slug: "blog-writer",     name: "Blog Writer",     description: "Draft cited articles in your brand voice.", status: "ACTIVE" as const },
  { slug: "technical-audit", name: "Technical Audit", description: "Find every SEO issue on your site.",        status: "ACTIVE" as const },
  { slug: "podcast",         name: "Podcast",          description: "Topic to voiced audio to Transistor.",     status: "ACTIVE" as const },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [isPending, startTransition] = useTransition();

  const [form, setForm] = useState({
    businessName: "",
    websiteUrl: "",
    industry: "",
    primaryGoal: "",
    targetAudience: "",
    selectedAgent: "",
  });

  function updateForm(key: keyof typeof form, value: string | boolean) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleComplete() {
    startTransition(async () => {
      // Submit to server action — save BusinessProfile + enable first agent
      const res = await apiFetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        router.push("/");
      }
    });
  }

  const progress = ((step - 1) / (STEPS.length - 1)) * 100;

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "32px 20px 64px",
      }}
    >
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 40 }}>
        <div
          style={{
            width: 24,
            height: 24,
            background: "var(--text)",
            borderRadius: 5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span style={{ color: "var(--bg)", fontSize: 11, fontWeight: 700 }}>M</span>
        </div>
        <span style={{ fontSize: 13, fontWeight: 600 }}>marketing.erp.io</span>
      </div>

      {/* Step indicators */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          marginBottom: 48,
          width: "100%",
          maxWidth: 520,
        }}
      >
        {STEPS.map((s, i) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", flex: i < STEPS.length - 1 ? 1 : 0 }}>
            <div style={{ display: "flex", flex: "none", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div
                className={`step-dot ${step > s.id ? "done" : step === s.id ? "active" : ""}`}
                style={{ cursor: step > s.id ? "pointer" : "default" }}
                onClick={() => step > s.id && setStep(s.id)}
                title={s.label}
              >
                {step > s.id ? "✓" : s.id}
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: step === s.id ? 600 : 400,
                  color: step === s.id ? "var(--text)" : step > s.id ? "var(--success)" : "var(--text-dim)",
                  whiteSpace: "nowrap",
                }}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                style={{
                  flex: 1,
                  height: 1,
                  background: step > s.id ? "var(--success)" : "var(--border)",
                  margin: "0 8px",
                  marginBottom: 16,
                }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div
        style={{
          width: "100%",
          maxWidth: 520,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "36px 32px",
        }}
        className="fade-in"
        key={step}
      >
        {/* Step 1 — Business */}
        {step === 1 && (
          <>
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--success)", marginBottom: 12 }}>Step 1 of 4</p>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Tell us about your business</h2>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
              Agents use this to match your brand voice and target the right audience.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label className="input-label">Business name</label>
                <input
                  className="input"
                  type="text"
                  placeholder="Acme Marketing Co."
                  value={form.businessName}
                  onChange={(e) => updateForm("businessName", e.target.value)}
                />
              </div>
              <div>
                <label className="input-label">Website URL</label>
                <input
                  className="input"
                  type="url"
                  placeholder="https://yoursite.com"
                  value={form.websiteUrl}
                  onChange={(e) => updateForm("websiteUrl", e.target.value)}
                />
              </div>
              <div>
                <label className="input-label">Industry</label>
                <select
                  className="input"
                  value={form.industry}
                  onChange={(e) => updateForm("industry", e.target.value)}
                >
                  <option value="">Select industry</option>
                  {["SaaS / Software", "E-commerce", "Professional Services", "Healthcare", "Real Estate", "Finance", "Education", "Media / Publishing", "Agency", "Other"].map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>
            </div>
          </>
        )}

        {/* Step 2 — Goals */}
        {step === 2 && (
          <>
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--success)", marginBottom: 12 }}>Step 2 of 4</p>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>What's your primary marketing goal?</h2>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
              The Operator agent uses this to propose your weekly plan.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { value: "organic-traffic",  label: "Grow organic traffic",     sub: "SEO, content, and link building agents" },
                { value: "brand-awareness",  label: "Build brand awareness",    sub: "Social, content, and audio/video agents" },
                { value: "lead-generation",  label: "Generate more leads",      sub: "Paid media, lifecycle, and CRO agents" },
                { value: "customer-retention", label: "Retain and grow customers", sub: "Lifecycle, email, and review agents" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => updateForm("primaryGoal", opt.value)}
                  style={{
                    padding: "14px 16px",
                    border: `1.5px solid ${form.primaryGoal === opt.value ? "var(--success)" : "var(--border)"}`,
                    borderRadius: "var(--radius)",
                    background: form.primaryGoal === opt.value ? "var(--success-bg)" : "transparent",
                    textAlign: "left",
                    cursor: "pointer",
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{opt.label}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{opt.sub}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Step 3 — Audience */}
        {step === 3 && (
          <>
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--success)", marginBottom: 12 }}>Step 3 of 4</p>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Who are you trying to reach?</h2>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
              Agents use this to write in the voice your audience expects.
            </p>

            <div>
              <label className="input-label">Describe your ideal customer</label>
              <textarea
                className="input"
                rows={5}
                placeholder="E.g. Marketing directors at B2B SaaS companies with 50-500 employees, spending $10k+ per month on paid acquisition, who are frustrated that their content strategy isn't converting..."
                value={form.targetAudience}
                onChange={(e) => updateForm("targetAudience", e.target.value)}
                style={{ resize: "vertical", minHeight: 120 }}
              />
              <p className="input-hint">The more specific, the better. You can refine this later with the Onboarder agent.</p>
            </div>
          </>
        )}

        {/* Step 4 — First agent */}
        {step === 4 && (
          <>
            <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--success)", marginBottom: 12 }}>Step 4 of 4</p>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Enable your first agent</h2>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
              These are live now. Pick one to activate — you can enable more on the Agents page.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {FIRST_AGENTS.map((agent) => (
                <button
                  key={agent.slug}
                  onClick={() => updateForm("selectedAgent", agent.slug)}
                  style={{
                    padding: "14px 16px",
                    border: `1.5px solid ${form.selectedAgent === agent.slug ? "var(--success)" : "var(--border)"}`,
                    borderRadius: "var(--radius)",
                    background: form.selectedAgent === agent.slug ? "var(--success-bg)" : "transparent",
                    textAlign: "left",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "monospace" }}>{agent.name}</span>
                      <span className="badge badge-active">Live</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{agent.description}</div>
                  </div>
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      border: `1.5px solid ${form.selectedAgent === agent.slug ? "var(--success)" : "var(--border)"}`,
                      background: form.selectedAgent === agent.slug ? "var(--success)" : "transparent",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {form.selectedAgent === agent.slug && (
                      <span style={{ color: "white", fontSize: 10 }}>✓</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Navigation */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 32,
            paddingTop: 20,
            borderTop: "1px solid var(--border)",
          }}
        >
          {step > 1 ? (
            <button className="btn btn-ghost" onClick={() => setStep(step - 1)}>
              ← Back
            </button>
          ) : (
            <div />
          )}

          {step < STEPS.length ? (
            <button
              className="btn btn-primary"
              onClick={() => setStep(step + 1)}
              disabled={
                (step === 1 && !form.businessName) ||
                (step === 2 && !form.primaryGoal) ||
                (step === 4 && !form.selectedAgent)
              }
            >
              Continue →
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={handleComplete}
              disabled={isPending}
            >
              {isPending ? "Setting up…" : "Go to my dashboard →"}
            </button>
          )}
        </div>
      </div>

      <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 24 }}>
        You can update all of this in Settings at any time.
      </p>
    </div>
  );
}
