import type { AgentConfig, AgentRun } from "@prisma/client";
import { AGENT_META, type AgentInput } from "@/lib/agent-metadata";

/**
 * The answers a run should actually use.
 *
 * There are two places a value can come from and handlers used to read only one
 * of them. `AgentConfig.config` is the saved default, written by
 * /agents/<slug>/configure. `AgentRun.input` is what the person typed into the
 * Run modal just now. The modal posts to `input`; 54 of the 60 handlers read
 * `agentConfig.config` — so for any workspace that never visited the configure
 * page (all of them: the page shows "No configuration yet") every field typed
 * at run time was silently discarded and the agent ran on its own defaults.
 *
 * Precedence, lowest to highest: the metadata defaultValue, the saved config,
 * then this run's input. Values are coerced to the type the field declares, so a
 * "1500" out of a form field and a 1500 out of a JSON config behave the same.
 */
export function resolveInputs(
  run: AgentRun & { agentConfig: AgentConfig },
): Record<string, unknown> {
  const saved = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const submitted = (run.input ?? {}) as Record<string, unknown>;
  const fields = AGENT_META[run.agentConfig.agentSlug]?.inputs ?? [];

  const resolved: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = pick(submitted, saved, field);
    if (raw !== undefined) resolved[field.key] = coerce(raw, field);
  }

  // Keys the metadata does not declare still pass through — handlers set by
  // another agent (a Blog Writer run queued by Topic Planner, say) hand over
  // fields that were never form inputs.
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in resolved)) resolved[key] = value;
  }
  for (const [key, value] of Object.entries(submitted)) {
    if (!(key in resolved) || resolved[key] === undefined) resolved[key] = value;
  }

  return resolved;
}

function pick(
  submitted: Record<string, unknown>,
  saved: Record<string, unknown>,
  field: AgentInput,
): unknown {
  if (isPresent(submitted[field.key])) return submitted[field.key];
  if (isPresent(saved[field.key])) return saved[field.key];
  return field.defaultValue;
}

/** An untouched form field arrives as "", which must not beat a saved default. */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

function coerce(raw: unknown, field: AgentInput): unknown {
  switch (field.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      return String(raw).trim().toLowerCase() === "true";
    default:
      return typeof raw === "string" ? raw.trim() : raw;
  }
}

/**
 * Required fields that arrived empty. The Run modal validates these client-side;
 * a run created by the API, a schedule, or another agent bypasses that, and a
 * blank brief is the difference between an article and 1500 generic words.
 */
export function missingRequiredInputs(
  agentSlug: string,
  inputs: Record<string, unknown>,
): string[] {
  const fields = AGENT_META[agentSlug]?.inputs ?? [];
  return fields
    .filter((field) => field.required && !isPresent(inputs[field.key]))
    .map((field) => field.label);
}

/** String helper so handlers stop repeating `String(config.x ?? "")`. */
export function str(inputs: Record<string, unknown>, key: string, fallback = ""): string {
  const value = inputs[key];
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text === "" ? fallback : text;
}

/** Number helper with a floor/ceiling, for word counts and limits. */
export function num(
  inputs: Record<string, unknown>,
  key: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const value = Number(inputs[key]);
  const n = Number.isFinite(value) ? value : fallback;
  return Math.min(opts.max ?? Infinity, Math.max(opts.min ?? -Infinity, n));
}

/** Boolean helper. Absent means the fallback, not false. */
export function bool(inputs: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = inputs[key];
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).trim().toLowerCase() === "true";
}

/** Split a textarea of one-per-line values into a trimmed, deduped list. */
export function lines(inputs: Record<string, unknown>, key: string, max = 20): string[] {
  return [
    ...new Set(
      str(inputs, key)
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].slice(0, max);
}
