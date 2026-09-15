/**
 * Old input names that still have to work after a form field was renamed.
 *
 * When a handler's reads were reconciled with lib/agent-metadata.ts (the fleet-wide
 * handler-vs-form guard in test/content.test.ts), some concepts existed under two names — one on
 * the form, one in the handler. The surviving name is the form's; the other lives on here, because
 * a saved `AgentConfig.config`, a scheduled run, or an API caller may still carry it.
 *
 * A plain `config.newKey ?? config.oldKey` does not work: resolveInputs() fills every declared
 * field with its metadata `defaultValue`, so `newKey` is never absent and the old key is never
 * consulted. This checks whether `newKey` was actually supplied (in this run's input or the saved
 * config) and only then lets its default stand.
 *
 * Old names are passed as string data rather than read as `config.oldKey`, so the guard's static
 * parser correctly sees only the declared names being read.
 */
import type { AgentConfig, AgentRun } from "@prisma/client";
import { AGENT_META } from "@/lib/agent-metadata";

type Rename = string | { from: string; map: (value: unknown) => unknown };

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/**
 * Mutates and returns `config`: for each `newKey → oldKey(s)`, when `newKey` was not supplied but
 * an old key was, the old value is coerced to the new field's declared type and stored under
 * `newKey`. A `select` field only accepts a legacy value that is one of its current options —
 * an old vocabulary that no longer exists falls through to the default instead of reaching the
 * prompt as an unknown label.
 */
export function applyRenamedInputs(
  run: AgentRun & { agentConfig: AgentConfig },
  config: Record<string, unknown>,
  renames: Record<string, Rename | Rename[]>,
): Record<string, unknown> {
  const submitted = (run.input ?? {}) as Record<string, unknown>;
  const saved = (run.agentConfig.config ?? {}) as Record<string, unknown>;
  const fields = AGENT_META[run.agentConfig.agentSlug]?.inputs ?? [];

  for (const [newKey, spec] of Object.entries(renames)) {
    if (isPresent(submitted[newKey]) || isPresent(saved[newKey])) continue;
    const field = fields.find((f) => f.key === newKey);

    for (const rename of Array.isArray(spec) ? spec : [spec]) {
      const from = typeof rename === "string" ? rename : rename.from;
      const raw = isPresent(submitted[from]) ? submitted[from] : isPresent(saved[from]) ? saved[from] : undefined;
      if (raw === undefined) continue;
      let value = typeof rename === "string" ? raw : rename.map(raw);
      if (!isPresent(value)) continue;

      if (field?.type === "number") {
        const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.-]/g, ""));
        if (!Number.isFinite(n)) continue;
        value = n;
      } else if (field?.type === "boolean") {
        value = typeof value === "boolean" ? value : String(value).trim().toLowerCase() === "true";
      } else if (field?.type === "select") {
        if (!field.options?.includes(String(value).trim())) continue;
        value = String(value).trim();
      } else if (typeof value === "string") {
        value = value.trim();
      }

      config[newKey] = value;
      break;
    }
  }
  return config;
}
