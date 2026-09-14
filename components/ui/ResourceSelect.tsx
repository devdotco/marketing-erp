"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/base-path";

export type ResourceOption = { value: string; label: string; detail?: string };

/**
 * The contract every options source this component can render must answer
 * with — a GET at `optionsUrl`. Provider-agnostic on purpose: Google
 * properties (app/api/integrations/google/resource/options) are the first
 * source, but a `cms_site` source (connected WordPress/Payload sites) can
 * hand back the same shape from its own endpoint and reuse this component
 * unchanged rather than growing a second renderer.
 */
type ResourceOptionsResponse =
  | { connected: false; connectUrl: string; providerLabel?: string }
  | { connected: true; error: string; providerLabel?: string }
  | { connected: true; noun?: string | null; options: ResourceOption[] | null; selected: string | null; providerLabel?: string };

type FetchState =
  | { phase: "loading" }
  | { phase: "fetch-error"; message: string; providerLabel?: string }
  | { phase: "not-connected"; connectUrl: string; providerLabel?: string }
  | { phase: "list-error"; message: string; providerLabel?: string }
  | { phase: "no-options"; providerLabel?: string }
  | { phase: "ready"; options: ResourceOption[]; providerLabel?: string };

interface ResourceSelectProps {
  id: string;
  /** GET endpoint answering the ResourceOptionsResponse contract above. */
  optionsUrl: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Style hooks shared with the plain <select>/<input> fields around it — pass whichever this form uses. */
  fieldStyle?: React.CSSProperties;
  className?: string;
}

/**
 * One renderer for every "pick a value this workspace's connected account can
 * reach" field: fetches optionsUrl, and renders the loading / not-connected /
 * listing-failed / ready state accordingly. Preselects the value the
 * connected integration already has chosen — but only when the caller hasn't
 * already got a value (a saved config, or a person's own prior pick in this
 * same form session always wins).
 */
export function ResourceSelect({ id, optionsUrl, value, onChange, disabled, fieldStyle, className }: ResourceSelectProps) {
  const [state, setState] = useState<FetchState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    apiFetch(optionsUrl)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setState({ phase: "fetch-error", message: (data as { error?: string }).error ?? `Request failed: ${res.status}` });
          return;
        }
        const data = (await res.json()) as ResourceOptionsResponse;
        if (!data.connected) {
          setState({ phase: "not-connected", connectUrl: data.connectUrl, providerLabel: data.providerLabel });
          return;
        }
        if ("error" in data) {
          setState({ phase: "list-error", message: data.error, providerLabel: data.providerLabel });
          return;
        }
        if (!data.options) {
          setState({ phase: "no-options", providerLabel: data.providerLabel });
          return;
        }
        setState({ phase: "ready", options: data.options, providerLabel: data.providerLabel });
        // Preselect the integration's own chosen value — but never clobber a
        // value already sitting in the field (a saved default, or whatever
        // was already typed/picked before this fetch resolved).
        if (!value && data.selected) onChange(data.selected);
      })
      .catch((err) => {
        if (!cancelled) setState({ phase: "fetch-error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch only when the source itself changes, not on every keystroke —
    // `value`/`onChange` are read inside the closure above instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsUrl]);

  const disabledSelectStyle: React.CSSProperties = { ...fieldStyle, opacity: 0.6, cursor: "not-allowed" };

  if (state.phase === "loading") {
    return (
      <select id={id} disabled className={className} style={disabledSelectStyle}>
        <option>Loading…</option>
      </select>
    );
  }

  if (state.phase === "not-connected") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <select id={id} disabled className={className} style={disabledSelectStyle}>
          <option>Not connected</option>
        </select>
        <Link href={state.connectUrl} style={{ fontSize: 12, color: "var(--success)" }}>
          Connect {state.providerLabel ?? "the integration"} →
        </Link>
      </div>
    );
  }

  if (state.phase === "fetch-error" || state.phase === "list-error") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <select id={id} disabled className={className} style={disabledSelectStyle}>
          <option>Using the connected default</option>
        </select>
        <p style={{ fontSize: 11, color: "var(--danger)", margin: 0 }}>
          Couldn&apos;t load {state.providerLabel ? `${state.providerLabel} ` : ""}options: {state.message}. The run will
          fall back to whatever is already selected on the integration.
        </p>
      </div>
    );
  }

  if (state.phase === "no-options") {
    return (
      <select id={id} disabled className={className} style={disabledSelectStyle}>
        <option>Nothing to choose for this integration</option>
      </select>
    );
  }

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className}
      style={fieldStyle}
    >
      <option value="">Use the connected default</option>
      {state.options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
          {opt.detail ? ` — ${opt.detail}` : ""}
        </option>
      ))}
    </select>
  );
}
