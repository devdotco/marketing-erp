import Link from "next/link";
export default function VerifyRequestPage() {
  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", padding: "40px 24px" }}>
      <div style={{ width: "100%", maxWidth: 360, textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 20 }}>✉️</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 10 }}>Check your email</h1>
        <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.65 }}>
          A sign-in link has been sent. Click it to sign in — it expires in 24 hours.
        </p>
        <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 24 }}>
          Didn&apos;t get it? Check spam, or{" "}
          <Link href="/login" style={{ color: "var(--text-muted)", textDecoration: "underline" }}>try again</Link>.
        </p>
      </div>
    </div>
  );
}
