import { signUp } from "@/lib/actions/auth";
import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";
import Link from "next/link";
import { signIn } from "@/lib/auth";
import { withBase } from "@/lib/base-path";

export const metadata = { title: "Create account — marketing.erp.io" };

export default async function SignupPage() {
  const session = await getServerSession();
  if (session?.user) redirect("/");

  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", padding: "40px 24px" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 36 }}>
          <div style={{ width: 26, height: 26, background: "var(--text)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "var(--bg)", fontSize: 12, fontWeight: 700 }}>M</span>
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em" }}>marketing.erp.io</span>
        </div>

        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 6 }}>Create account</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>Free to start — no credit card required.</p>

        {/* Google */}
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: withBase("/onboarding") });
          }}
        >
          <button type="submit" className="btn btn-secondary" style={{ width: "100%", marginBottom: 16 }}>
            <svg width="16" height="16" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Continue with Google
          </button>
        </form>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, color: "var(--text-dim)", fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          or
          <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
        </div>

        <form action={signUp as (formData: FormData) => void} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label className="input-label" htmlFor="name">Full name</label>
            <input id="name" name="name" type="text" required autoComplete="name" className="input" placeholder="Alex Johnson" />
          </div>
          <div>
            <label className="input-label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required autoComplete="email" className="input" placeholder="alex@company.com" />
          </div>
          <div>
            <label className="input-label" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required autoComplete="new-password" className="input" placeholder="At least 8 characters" />
          </div>
          <div>
            <label className="input-label" htmlFor="workspaceName">Company name</label>
            <input id="workspaceName" name="workspaceName" type="text" autoComplete="organization" className="input" placeholder="Acme Marketing" />
            <p className="input-hint">Optional — you can change this later.</p>
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: "100%", marginTop: 4 }}>
            Create account →
          </button>
        </form>

        <p style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", marginTop: 20 }}>
          Have an account?{" "}
          <Link href="/login" style={{ color: "var(--text-muted)", textDecoration: "underline" }}>Sign in</Link>
        </p>
      </div>
    </div>
  );
}
