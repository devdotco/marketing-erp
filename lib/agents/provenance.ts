import { EVIDENCE_SOURCES, groundingFor, type EvidenceSource, type OutputKind } from "./grounding";

/**
 * What a run actually reached, recorded on the run itself.
 *
 * The static map in ./grounding.ts says what an agent CAN read. That is not
 * enough to label a number: the same handler produces a measured figure for a
 * workspace with Search Console connected and a model's estimate for one
 * without, and until now both came back in the same shape. The run page could
 * not tell them apart, so it rendered both as fact.
 *
 * Handlers attach this to their output under `_provenance`. It is a reserved
 * key — `lib/agents/inputs.ts` never reads it back in, and the UI strips it
 * before showing raw JSON.
 */
export const PROVENANCE_KEY = "_provenance";

export interface EvidenceRecord {
  source: EvidenceSource;
  /** What was read, in the user's terms: "sc-domain:dev.co, last 90 days". */
  detail: string;
  /** Rows, pages, captures — whatever makes the volume legible. Optional. */
  rows?: number;
}

export interface RunProvenance {
  kind: OutputKind;
  /** Live systems this run actually read. Empty means the model worked alone. */
  evidence: EvidenceRecord[];
  /**
   * Observations only: true when the headline figures came from the model
   * rather than from a source. Renders as "Estimated", never as a metric.
   */
  estimated: boolean;
  /** One line for the UI, written by the handler when it wants to be specific. */
  note?: string;
}

/**
 * Build the provenance record for a run.
 *
 * `estimated` is derived, not passed: an observation with no evidence IS an
 * estimate, and leaving that to each of 54 handlers to declare honestly is how
 * the original problem happened.
 */
export function provenance(
  agentSlug: string,
  evidence: EvidenceRecord[],
  note?: string,
): RunProvenance {
  const { kind } = groundingFor(agentSlug);
  return {
    kind,
    evidence,
    estimated: kind === "observation" && evidence.length === 0,
    ...(note ? { note } : {}),
  };
}

/** Attach provenance to an output object. Returns the same object, for chaining. */
export function withProvenance<T extends Record<string, unknown>>(
  output: T,
  agentSlug: string,
  evidence: EvidenceRecord[],
  note?: string,
): T {
  (output as Record<string, unknown>)[PROVENANCE_KEY] = provenance(agentSlug, evidence, note);
  return output;
}

/**
 * The provenance to render for a stored run.
 *
 * Runs created before this existed have no `_provenance`, and there are a lot
 * of them. Rather than show nothing, fall back to the two legacy conventions
 * the handlers already used — a `source: "live" | "simulation"` field, and the
 * `simulationNote` that `ai-search-visibility` shipped — so historic runs are
 * labelled too. An old observation with neither marker is reported as unknown,
 * not as measured: we cannot vouch for it retroactively.
 */
export function readProvenance(
  output: unknown,
  agentSlug: string,
): (RunProvenance & { legacy?: true }) | null {
  const { kind } = groundingFor(agentSlug);
  if (!output || typeof output !== "object") return null;
  const obj = output as Record<string, unknown>;

  const stored = obj[PROVENANCE_KEY];
  if (stored && typeof stored === "object") {
    const p = stored as Partial<RunProvenance>;
    return {
      kind: p.kind ?? kind,
      evidence: Array.isArray(p.evidence) ? (p.evidence as EvidenceRecord[]) : [],
      estimated: Boolean(p.estimated),
      ...(p.note ? { note: p.note } : {}),
    };
  }

  if (kind !== "observation") return null;

  const legacySource = typeof obj["source"] === "string" ? String(obj["source"]) : null;
  if (legacySource === "live") {
    return { kind, evidence: [], estimated: false, note: "Recorded before runs carried their sources; the run reported live data.", legacy: true };
  }
  if (legacySource === "simulation" || typeof obj["simulationNote"] === "string") {
    return { kind, evidence: [], estimated: true, note: "Recorded before runs carried their sources; the run reported simulated data.", legacy: true };
  }
  return { kind, evidence: [], estimated: true, note: "This run predates source recording, so its figures cannot be traced to a system.", legacy: true };
}

/** Display name for an evidence source. */
export function sourceName(source: EvidenceSource): string {
  return EVIDENCE_SOURCES[source] ?? source;
}

/** Strip the reserved key so the raw-JSON panel shows the agent's own output. */
export function withoutProvenance(output: Record<string, unknown>): Record<string, unknown> {
  if (!(PROVENANCE_KEY in output)) return output;
  const clone = { ...output };
  delete clone[PROVENANCE_KEY];
  return clone;
}
