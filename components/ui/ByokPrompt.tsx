import Link from "next/link";

/**
 * What to do when a workspace has no Anthropic key.
 *
 * Agents bill to the key that runs them, so a workspace without one cannot run
 * anything — and "Run now" failing with an error is a bad way to learn that.
 * This is shown wherever that wall can be hit: on an agent before it is run, in
 * the Run modal instead of the form, and on a run that failed for want of a key.
 */
export function ByokPrompt({
  variant = "card",
  workspaceName,
}: {
  variant?: "card" | "inline";
  workspaceName?: string;
}) {
  const steps: Array<{ title: string; detail: React.ReactNode }> = [
    {
      title: "Create a key at console.anthropic.com",
      detail: (
        <>
          Sign in, open{" "}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--text)", textDecoration: "underline" }}
          >
            API keys
          </a>
          , and create one. Give it a name you will recognise later, like
          &ldquo;{workspaceName || "marketing"}&rdquo;.
        </>
      ),
    },
    {
      title: "Put credit on that Anthropic account",
      detail: (
        <>
          A new account has no balance, and a key with no credit fails the moment an
          agent runs. Add a payment method or buy credits under{" "}
          <a
            href="https://console.anthropic.com/settings/billing"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--text)", textDecoration: "underline" }}
          >
            Billing
          </a>
          .
        </>
      ),
    },
    {
      title: "Paste it into this workspace",
      detail: (
        <>
          Copy the key once — Anthropic will not show it again — and add it under
          Integrations. We check it against the API before saving, so a wrong key is a
          form error rather than a failed run an hour later.
        </>
      ),
    },
  ];

  return (
    <div
      className={variant === "card" ? "card" : undefined}
      style={
        variant === "inline"
          ? {
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius)",
              padding: 20,
              background: "var(--surface-2)",
            }
          : undefined
      }
    >
      <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
        Connect an Anthropic API key to run agents
      </h2>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "8px 0 0", maxWidth: 620 }}>
        Every agent here runs on Claude, and it runs on <strong>your</strong> Anthropic
        account. That keeps model spend, rate limits and usage history on the account that
        asked for the work, and it means nobody else is paying for your runs or seeing them.
        Nothing can run until a key is connected, and no tokens are ever spent trying.
      </p>

      <ol
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          margin: "16px 0 0",
          paddingLeft: 20,
        }}
      >
        {steps.map((step) => (
          <li key={step.title} style={{ fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>{step.title}</span>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 0", maxWidth: 580 }}>
              {step.detail}
            </p>
          </li>
        ))}
      </ol>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 18 }}>
        <Link href="/integrations/connect/anthropic" className="btn btn-primary btn-sm">
          Connect Anthropic key
        </Link>
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noreferrer"
          className="btn btn-secondary btn-sm"
        >
          Open Anthropic console →
        </a>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "12px 0 0" }}>
        A typical long-form article costs roughly $0.60&ndash;0.70 in Claude usage. Shorter
        agents cost a fraction of a cent. You are billed by Anthropic directly, at their
        rates, with no markup from us.
      </p>
    </div>
  );
}
