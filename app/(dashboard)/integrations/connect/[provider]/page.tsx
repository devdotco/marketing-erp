"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, withBase } from "@/lib/base-path";
import { CONNECT_METHODS, providerFromSlug, type CredentialField } from "@/lib/integrations/catalog";
import { SETUP_GUIDES } from "@/lib/integrations/guides";
import { SetupGuide } from "@/components/integrations/SetupGuide";
import { WebhookUrl } from "@/components/integrations/WebhookUrl";
import { PayloadConnect } from "@/components/integrations/PayloadConnect";

const panel: React.CSSProperties = {
  padding: "20px 20px 24px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

export default function ConnectProviderPage() {
  const params = useParams();
  const provider = providerFromSlug((params?.provider as string) ?? "");
  const entry = provider ? CONNECT_METHODS[provider] : undefined;

  if (!provider || !entry) {
    return (
      <div className="scrollable">
        <div style={{ ...panel, padding: "24px 20px", fontSize: 13, color: "var(--text-muted)", display: "block" }}>
          Unknown provider. <Link href="/integrations" style={{ color: "var(--text)" }}>Back to integrations</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="scrollable">
      <div style={{ marginBottom: 24 }}>
        <Link
          href="/integrations"
          style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          ← Back to integrations
        </Link>
      </div>

      <div className="setup-guide-layout">
        <div className="connect-form-col" style={{ maxWidth: 520 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 6 }}>
            Connect {entry.name}
          </h1>
          {provider === "PAYLOAD" ? (
            <PayloadConnect name={entry.name} />
          ) : entry.method.kind === "key" ? (
            <>
              <KeyForm provider={provider} name={entry.name} fields={entry.method.fields} />
              {(provider === "INSTANTLY" || provider === "AIMFOX") && <WebhookUrl provider={provider} name={entry.name} />}
            </>
          ) : entry.method.kind === "google" ? (
            <Suspense fallback={null}>
              <GoogleConnect provider={provider} name={entry.name} />
            </Suspense>
          ) : entry.method.kind === "microsoft" ? (
            <Suspense fallback={null}>
              <MicrosoftConnect provider={provider} name={entry.name} />
            </Suspense>
          ) : (
            <Suspense fallback={null}>
              <MetaConnect provider={provider} name={entry.name} />
            </Suspense>
          )}
        </div>

        {SETUP_GUIDES[provider] && (
          <div className="connect-guide-col">
            <SetupGuide guide={SETUP_GUIDES[provider]!} />
          </div>
        )}
      </div>
    </div>
  );
}

function KeyForm({ provider, name, fields }: { provider: string; name: string; fields: CredentialField[] }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const complete = fields.every((f) => (values[f.key] ?? "").trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!complete) return;

    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await apiFetch("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, credentials: values }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
      }

      setStatus("success");
      setTimeout(() => router.push("/integrations"), 1200);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
        Enter your credentials to authorize marketing agents to act on your behalf.
      </p>

      <form onSubmit={handleSubmit}>
        <div style={panel}>
          {fields.map((field) => (
            <div key={field.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label htmlFor={field.key} className="input-label">
                {field.label}
              </label>
              <input
                id={field.key}
                className="input"
                type={field.secret ? "password" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                autoComplete="off"
                required
                style={{ fontFamily: field.secret ? "monospace" : undefined }}
              />
              {field.hint && <p className="input-hint" style={{ margin: 0 }}>{field.hint}</p>}
            </div>
          ))}

          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
            Credentials are encrypted with AES-256-GCM before storage and never logged.
          </p>

          {status === "error" && (
            <p style={{ fontSize: 12, color: "var(--danger, #ef4444)", margin: 0 }}>{errorMsg}</p>
          )}

          {status === "success" && (
            <p style={{ fontSize: 12, color: "var(--success, #22c55e)", margin: 0 }}>
              Connected! Redirecting…
            </p>
          )}

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={status === "loading" || status === "success" || !complete}
            >
              {status === "loading" ? "Saving…" : `Connect ${name}`}
            </button>
            <Link href="/integrations" className="btn btn-ghost">
              Cancel
            </Link>
          </div>
        </div>
      </form>
    </>
  );
}

type ResourceState =
  | { phase: "loading" }
  | { phase: "not-connected" }
  | { phase: "no-picker" }
  | { phase: "error"; error: string }
  | { phase: "ready"; noun: string; options: { value: string; label: string; detail?: string }[]; selected: string | null };

function GoogleConnect({ provider, name }: { provider: string; name: string }) {
  const router = useRouter();
  const justConnected = useSearchParams()?.get("connected") === "1";
  const [state, setState] = useState<ResourceState>({ phase: "loading" });
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/integrations/google/resource?provider=${provider}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 404) return setState({ phase: "not-connected" });
        if (!res.ok) return setState({ phase: "error", error: data.error ?? `Request failed: ${res.status}` });
        if (!data.options) return setState({ phase: "no-picker" });
        setState({ phase: "ready", noun: data.noun, options: data.options, selected: data.selected });
        setChoice(data.selected ?? data.options[0]?.value ?? "");
      })
      .catch((err) => !cancelled && setState({ phase: "error", error: String(err) }));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const startHref = withBase(`/api/integrations/google/start?provider=${provider.toLowerCase()}`);

  async function save() {
    setSaving(true);
    setSaveError("");
    const res = await apiFetch("/api/integrations/google/resource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, value: choice }),
    });
    if (res.ok) return router.push("/integrations");
    const data = await res.json().catch(() => ({}));
    setSaveError(data.error ?? `Request failed: ${res.status}`);
    setSaving(false);
  }

  if (state.phase === "loading") {
    return <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Checking connection…</p>;
  }

  if (state.phase === "not-connected") {
    return (
      <>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
          Sign in with the Google account that has access to your {name} data. You&apos;ll be asked to allow read access;
          the connection belongs to this workspace, not to your login.
        </p>
        <div style={panel}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {/* A plain anchor: this is a full-page hop to Google, not a client route. */}
            <a href={startHref} className="btn btn-primary">
              Continue with Google
            </a>
            <Link href="/integrations" className="btn btn-ghost">
              Cancel
            </Link>
          </div>
        </div>
      </>
    );
  }

  if (state.phase === "no-picker") {
    return (
      <div style={panel}>
        <p style={{ fontSize: 13, margin: 0 }}>{name} is connected.</p>
        <Link href="/integrations" className="btn btn-secondary" style={{ alignSelf: "flex-start" }}>
          Done
        </Link>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div style={panel}>
        <p style={{ fontSize: 13, color: "var(--danger)", margin: 0 }}>{state.error}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <a href={startHref} className="btn btn-primary">
            Reconnect with Google
          </a>
          <Link href="/integrations" className="btn btn-ghost">
            Back
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
        {justConnected ? "Connected to Google. " : ""}Choose the {state.noun} agents should use.
      </p>
      <div style={panel}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="resource" className="input-label">
            {state.noun[0].toUpperCase() + state.noun.slice(1)}
          </label>
          <select id="resource" className="input" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {state.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
                {o.detail ? ` — ${o.detail}` : ""}
              </option>
            ))}
          </select>
        </div>
        {saveError && <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{saveError}</p>}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn btn-primary" disabled={!choice || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
          <a href={startHref} className="btn btn-ghost">
            Use a different Google account
          </a>
        </div>
      </div>
    </>
  );
}

/**
 * Microsoft 365 has no resource-picker step — a mailbox is just "me", there's
 * nothing to choose between — so this is just the start button plus the
 * post-callback confirmation, unlike GoogleConnect's multi-phase state.
 */
function MicrosoftConnect({ provider, name }: { provider: string; name: string }) {
  const justConnected = useSearchParams()?.get("connected") === "1";
  const startHref = withBase(`/api/integrations/microsoft/start?provider=${provider.toLowerCase()}`);

  if (justConnected) {
    return (
      <div style={panel}>
        <p style={{ fontSize: 13, margin: 0 }}>Connected to {name}.</p>
        <Link href="/integrations" className="btn btn-secondary" style={{ alignSelf: "flex-start" }}>
          Done
        </Link>
      </div>
    );
  }

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
        Sign in with the Microsoft 365 / Outlook account agents should read and draft in. The connection belongs to
        this workspace, not to whoever clicks Connect.
      </p>
      <div style={panel}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* A plain anchor: this is a full-page hop to Microsoft, not a client route. */}
          <a href={startHref} className="btn btn-primary">
            Continue with Microsoft
          </a>
          <Link href="/integrations" className="btn btn-ghost">
            Cancel
          </Link>
        </div>
      </div>
    </>
  );
}

type MetaState =
  | { phase: "start" }
  | { phase: "loading" }
  | { phase: "picker"; noun: string; options: { value: string; label: string; detail?: string }[] }
  | { phase: "connected" }
  | { phase: "error"; error: string };

/**
 * Meta's picker is a subset of GoogleConnect's: it only ever runs once, right
 * after /api/integrations/meta/callback redirects here with `?picker=1`
 * because the account manages more than one Page. There is no "revisit later
 * and switch Pages" path — see lib/integrations/meta.ts for why — so unlike
 * Google there's no live status check on first load; the phase comes
 * straight from the query string.
 */
function MetaConnect({ provider, name }: { provider: string; name: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const justConnected = searchParams?.get("connected") === "1";
  const isPicker = searchParams?.get("picker") === "1";
  const [state, setState] = useState<MetaState>(
    justConnected ? { phase: "connected" } : isPicker ? { phase: "loading" } : { phase: "start" },
  );
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!isPicker) return;
    let cancelled = false;
    apiFetch(`/api/integrations/meta/resource?provider=${provider}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) return setState({ phase: "error", error: data.error ?? `Request failed: ${res.status}` });
        setState({ phase: "picker", noun: data.noun, options: data.options });
        setChoice(data.options?.[0]?.value ?? "");
      })
      .catch((err) => !cancelled && setState({ phase: "error", error: String(err) }));
    return () => {
      cancelled = true;
    };
  }, [isPicker, provider]);

  const startHref = withBase(`/api/integrations/meta/start?provider=${provider.toLowerCase()}`);

  async function save() {
    setSaving(true);
    setSaveError("");
    const res = await apiFetch("/api/integrations/meta/resource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, value: choice }),
    });
    if (res.ok) return router.push("/integrations");
    const data = await res.json().catch(() => ({}));
    setSaveError(data.error ?? `Request failed: ${res.status}`);
    setSaving(false);
  }

  if (state.phase === "connected") {
    return (
      <div style={panel}>
        <p style={{ fontSize: 13, margin: 0 }}>Connected to {name}.</p>
        <Link href="/integrations" className="btn btn-secondary" style={{ alignSelf: "flex-start" }}>
          Done
        </Link>
      </div>
    );
  }

  if (state.phase === "loading") {
    return <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading your Pages…</p>;
  }

  if (state.phase === "error") {
    return (
      <div style={panel}>
        <p style={{ fontSize: 13, color: "var(--danger)", margin: 0 }}>{state.error}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <a href={startHref} className="btn btn-primary">
            Reconnect with Facebook
          </a>
          <Link href="/integrations" className="btn btn-ghost">
            Back
          </Link>
        </div>
      </div>
    );
  }

  if (state.phase === "picker") {
    return (
      <>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
          Connected to Facebook. Choose the Page agents should post as.
        </p>
        <div style={panel}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="resource" className="input-label">
              {state.noun}
            </label>
            <select id="resource" className="input" value={choice} onChange={(e) => setChoice(e.target.value)}>
              {state.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {o.detail ? ` — ${o.detail}` : ""}
                </option>
              ))}
            </select>
          </div>
          {saveError && <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{saveError}</p>}
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn btn-primary" disabled={!choice || saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28 }}>
        Sign in with Facebook and choose the Page agents should post to. The connection belongs to this workspace,
        not to whoever clicks Connect.
      </p>
      <div style={panel}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* A plain anchor: this is a full-page hop to Facebook, not a client route. */}
          <a href={startHref} className="btn btn-primary">
            Continue with Facebook
          </a>
          <Link href="/integrations" className="btn btn-ghost">
            Cancel
          </Link>
        </div>
      </div>
    </>
  );
}
