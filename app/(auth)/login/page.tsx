import { loginWithCredentials } from "@/lib/actions/auth";
import Link from "next/link";
import { signIn } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session";
import { MagicLinkForm } from "./MagicLinkForm";

export const metadata = { title: "Sign in — marketing.erp.io" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const session = await getServerSession();
  if (session?.user) redirect("/");

  const params = await searchParams;

  return (
    <div style={{ minHeight: "100dvh", display: "flex", background: "var(--bg)" }}>
      {/* Left panel — brand */}
      <div
        style={{
          width: 420,
          flexShrink: 0,
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          padding: "48px 40px",
        }}
        className="hidden lg:flex"
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "auto" }}>
          <div
            style={{
              width: 28,
              height: 28,
              background: "var(--text)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ color: "var(--bg)", fontSize: 13, fontWeight: 700, letterSpacing: "-0.02em" }}>
              M
            </span>
          </div>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em" }}>marketing.erp.io</span>
        </div>

        <div style={{ marginBottom: "auto", paddingTop: 80 }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--success)",
              marginBottom: 16,
            }}
          >
            48 AI marketing agents
          </p>
          <h2 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.25, marginBottom: 20 }}>
            Run your marketing on autopilot.
          </h2>
          <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.65 }}>
            Content, SEO, social, paid media, and analytics — all coordinated by AI agents that wait for your approval before anything goes live.
          </p>

          <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              "Nothing publishes without your sign-off",
              "Every run receipted with transparent costs",
              "Official APIs only — your accounts stay yours",
            ].map((point) => (
              <div key={point} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13 }}>
                <span style={{ color: "var(--success)", marginTop: 1, flexShrink: 0 }}>✓</span>
                <span style={{ color: "var(--text-muted)" }}>{point}</span>
              </div>
            ))}
          </div>
        </div>

        <p style={{ fontSize: 11, color: "var(--text-dim)" }}>
          Part of the{" "}
          <a href={process.env.NEXT_PUBLIC_DASHBOARD_URL || "https://dashboard.erp.io"} style={{ color: "var(--text-muted)" }}>
            erp.io
          </a>{" "}
          suite
        </p>
      </div>

      {/* Right panel — form */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px 24px",
        }}
      >
        <div style={{ width: "100%", maxWidth: 360 }}>
          {/* Mobile logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 40 }} className="lg:hidden">
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

          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 6 }}>
            Welcome back
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
            Sign in to your workspace
          </p>

          {params.error && (
            <div
              style={{
                background: "var(--danger-bg)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius)",
                padding: "10px 14px",
                fontSize: 13,
                color: "var(--danger)",
                marginBottom: 20,
              }}
            >
              {params.error === "CredentialsSignin"
                ? "Invalid email or password."
                : "An error occurred. Please try again."}
            </div>
          )}

          {/* Google OAuth */}
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: params.callbackUrl || "/" });
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
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
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

          {/* Credentials form */}
          <form action={loginWithCredentials as (formData: FormData) => void} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <input type="hidden" name="callbackUrl" value={params.callbackUrl || "/"} />
            <div>
              <label className="input-label" htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required autoComplete="email" className="input" placeholder="you@company.com" />
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <label className="input-label" htmlFor="password" style={{ margin: 0 }}>Password</label>
                <Link href="/forgot-password" style={{ fontSize: 11, color: "var(--text-dim)", textDecoration: "underline" }}>
                  Forgot?
                </Link>
              </div>
              <input id="password" name="password" type="password" required autoComplete="current-password" className="input" placeholder="••••••••" />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: "100%", marginTop: 4 }}>
              Sign in
            </button>
          </form>

          {/* Magic link */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0 16px", color: "var(--text-dim)", fontSize: 12 }}>
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            or get a magic link
            <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          </div>

          <MagicLinkForm />

          <p style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", marginTop: 20 }}>
            No account?{" "}
            <Link href="/signup" style={{ color: "var(--text-muted)", textDecoration: "underline" }}>
              Create one free
            </Link>
          </p>

          <p style={{ fontSize: 11, color: "var(--text-dim)", textAlign: "center", marginTop: 32 }}>
            By signing in you agree to the{" "}
            <a href="#" style={{ color: "var(--text-dim)" }}>Terms</a> and{" "}
            <a href="#" style={{ color: "var(--text-dim)" }}>Privacy Policy</a>.
          </p>
        </div>
      </div>
    </div>
  );
}
