// /start — The digitalmarketers.ai wedge landing page
// Users land here from the "Start free" CTA on digitalmarketers.ai
// They sign up for marketing.erp.io directly — account syncs with .erp.io ecosystem
// Immediately pushed into /onboarding after signup

import { signUp } from "@/lib/actions/auth";
import { signIn } from "@/lib/auth";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AGENTS } from "@/lib/agents";

export const metadata = { title: "Start free — marketing.erp.io" };

const ACTIVE_AGENTS = AGENTS.filter((a) => a.status === "ACTIVE");
const TOTAL_AGENTS = AGENTS.length;

export default async function StartPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      {/* Minimal nav */}
      <nav
        style={{
          height: 52,
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          display: "flex",
          alignItems: "center",
          padding: "0 28px",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
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
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em" }}>marketing.erp.io</span>
          <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 4 }}>
            — powered by the erp.io suite
          </span>
        </div>
        <Link href="/login" className="btn btn-ghost btn-sm">
          Sign in
        </Link>
      </nav>

      {/* Main content */}
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1fr 420px",
          gap: 0,
          maxWidth: 1100,
          margin: "0 auto",
          width: "100%",
          padding: "64px 32px",
          alignItems: "start",
        }}
      >
        {/* Left — pitch */}
        <div style={{ paddingRight: 64 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--success-bg)",
              color: "var(--success)",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              padding: "4px 10px",
              borderRadius: 4,
              marginBottom: 20,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--success)",
                display: "inline-block",
              }}
            />
            Free to start · No credit card
          </div>

          <h1
            style={{
              fontSize: 38,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1.15,
              marginBottom: 20,
              textWrap: "balance",
            }}
          >
            {TOTAL_AGENTS} AI marketing agents.
            <br />
            <span style={{ color: "var(--text-muted)" }}>One operator. You.</span>
          </h1>

          <p style={{ fontSize: 15, lineHeight: 1.65, maxWidth: 480, marginBottom: 36 }}>
            Content, SEO, social, paid media, link building, and analytics — coordinated by AI agents that draft everything and publish nothing without your sign-off.
          </p>

          {/* Agent suite preview */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 40 }}>
            {[
              { label: "Content & Publishing", count: 8, live: 2 },
              { label: "SEO", count: 8, live: 1 },
              { label: "Social", count: 9, live: 0 },
              { label: "Paid Media + Analytics", count: 8, live: 0 },
            ].map((suite) => (
              <div
                key={suite.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  fontSize: 13,
                }}
              >
                <span style={{ flex: 1, color: "var(--text-muted)" }}>{suite.label}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{suite.count} agents</span>
                {suite.live > 0 && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--success)",
                      background: "var(--success-bg)",
                      padding: "1px 6px",
                      borderRadius: 3,
                    }}
                  >
                    {suite.live} live
                  </span>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 24, fontSize: 12, color: "var(--text-dim)" }}>
            <span>✓ All {TOTAL_AGENTS} agents unlocked day one</span>
            <span>✓ Pay per run, not per seat</span>
            <span>✓ Official APIs only</span>
          </div>
        </div>

        {/* Right — signup form */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            padding: "32px 28px",
            position: "sticky",
            top: 32,
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Create your free account</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 24 }}>
            You'll be in your marketing dashboard in under 2 minutes.
          </p>

          {/* Google sign-up */}
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/onboarding" });
            }}
          >
            <button
              type="submit"
              className="btn btn-secondary"
              style={{ width: "100%", marginBottom: 16 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.47 2.09 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              Continue with Google
            </button>
          </form>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 16,
              color: "var(--text-dim)",
              fontSize: 12,
            }}
          >
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            or
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>

          <form action={signUp as (formData: FormData) => void} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <input type="hidden" name="referralSource" value="digitalmarketers.ai" />

            <div>
              <label className="input-label" htmlFor="name">Full name</label>
              <input
                id="name"
                name="name"
                type="text"
                required
                autoComplete="name"
                className="input"
                placeholder="Alex Johnson"
              />
            </div>

            <div>
              <label className="input-label" htmlFor="email">Work email</label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className="input"
                placeholder="alex@company.com"
              />
            </div>

            <div>
              <label className="input-label" htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="new-password"
                className="input"
                placeholder="At least 8 characters"
              />
            </div>

            <div>
              <label className="input-label" htmlFor="workspaceName">Company / workspace name</label>
              <input
                id="workspaceName"
                name="workspaceName"
                type="text"
                autoComplete="organization"
                className="input"
                placeholder="Acme Marketing"
              />
              <p className="input-hint">You can change this later.</p>
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-lg"
              style={{ width: "100%", marginTop: 4 }}
            >
              Start free →
            </button>
          </form>

          <p style={{ fontSize: 11, color: "var(--text-dim)", textAlign: "center", marginTop: 16, lineHeight: 1.5 }}>
            By creating an account you agree to the{" "}
            <a href="#" style={{ color: "var(--text-dim)" }}>Terms</a> and{" "}
            <a href="#" style={{ color: "var(--text-dim)" }}>Privacy Policy</a>.
            <br />
            Your account works across the entire erp.io suite.
          </p>

          <div style={{ marginTop: 20, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <p style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
              Already have an account?{" "}
              <Link href="/login" style={{ color: "var(--text-muted)", textDecoration: "underline" }}>
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
