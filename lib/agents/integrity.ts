/**
 * Is this output fit to put in front of a reviewer?
 *
 * Every agent's run ended the same way: whatever the handler returned went to
 * AWAITING_APPROVAL with a generic "Review required" banner. The QA audit of
 * 2026-10-21 found that this covered:
 *
 *  - three runs cut off mid-string, saved as `{ result: "<half a JSON string>" }`
 *    and rendered as an escaped blob with an Approve button above it;
 *  - a newsletter labelled `source: "simulation"` at the bottom of the JSON,
 *    with nothing in the UI to say its "news" had no source at all;
 *  - nine invented testimonials whose only tell was `sourceUrl: null`.
 *
 * So the check runs in three places: the worker (a blocking problem fails the
 * run instead of reaching review), the approve route (refuses, which also
 * covers runs saved before this existed), and the run page (shows the reviewer
 * what to check before they read a word).
 *
 * Handlers add their own agent-specific findings under REVIEW_KEY; this module
 * adds the checks that apply to every agent.
 */

export const REVIEW_KEY = "_review";

export interface ReviewFindings {
  /** Must not be approved. The worker fails the run; the approve route refuses. */
  blocking: string[];
  /** Approvable, but a person should check these first. */
  warnings: string[];
}

/** Thrown by the worker when an output has blocking findings. */
export class OutputIncompleteError extends Error {
  readonly issues: string[];
  /** The tail of what was produced, for the technical-detail fold. */
  readonly preview?: string;

  constructor(issues: string[], preview?: string) {
    super(issues.join(" "));
    this.name = "OutputIncompleteError";
    this.issues = issues;
    this.preview = preview;
  }
}

/** Keys every handler stamps on, which say nothing about whether it produced anything. */
const BOOKKEEPING = new Set(["generatedAt", "workspaceId", "source", "simulationNote", "gscNote", "_provenance", REVIEW_KEY]);

function looksLikeJson(text: string): boolean {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "");
  return t.startsWith("{") || t.startsWith("[");
}

function parses(text: string): boolean {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** Count `sourceUrl: null` anywhere in the tree — the handlers' marker for an unsourced item. */
function countNullSources(value: unknown, depth = 0): number {
  if (depth > 8 || !value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countNullSources(v, depth + 1), 0);
  // A slot the handler built as a marked placeholder is already flagged as such.
  if ((value as Record<string, unknown>)["placeholder"] === true) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (k === "sourceUrl" && (v === null || v === "")) n++;
    else n += countNullSources(v, depth + 1);
  }
  return n;
}

/**
 * When the handler's own parse failed it stored the model's text under `result`.
 * If that text is in fact valid JSON (fenced, or with prose around it), unwrap
 * it so the reviewer sees a structured object rather than an escaped string.
 */
export function normalizeOutput(output: Record<string, unknown>): Record<string, unknown> {
  const raw = output["result"];
  if (typeof raw !== "string" || !looksLikeJson(raw)) return output;
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rest = { ...output };
      delete rest["result"];
      return { ...(parsed as Record<string, unknown>), ...rest };
    }
  } catch {
    // Not valid — checkOutput reports it.
  }
  return output;
}

export function checkOutput(output: unknown): ReviewFindings {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return { blocking: ["The agent produced no output."], warnings };
  }
  const obj = output as Record<string, unknown>;

  const raw = obj["result"];
  if (typeof raw === "string") {
    if (looksLikeJson(raw) && !parses(raw)) {
      blocking.push("The output is not valid JSON: it stops partway through, which means the answer was cut off.");
    } else if (!raw.trim()) {
      blocking.push("The agent's answer was empty.");
    }
  }

  if ("content" in obj && typeof obj["content"] === "string" && !obj["content"].trim()) {
    blocking.push("The draft body is empty.");
  }

  const substantive = Object.keys(obj).filter((k) => !BOOKKEEPING.has(k));
  if (substantive.length === 0) {
    blocking.push("The agent produced no output beyond bookkeeping fields.");
  }

  if (obj["source"] === "simulation") {
    warnings.push(
      "No live data source was used for this run. Any figures, rankings or events in it are the model's own, not measured — verify them before anything goes out.",
    );
  }

  const nullSources = countNullSources(obj);
  if (nullSources > 0) {
    warnings.push(
      `${nullSources} item${nullSources === 1 ? " has" : "s have"} no source (sourceUrl is empty). Treat ${nullSources === 1 ? "it" : "them"} as unverified until you add a real one or remove ${nullSources === 1 ? "it" : "them"}.`,
    );
  }

  const own = obj[REVIEW_KEY];
  if (own && typeof own === "object") {
    const r = own as Partial<ReviewFindings>;
    if (Array.isArray(r.blocking)) blocking.push(...r.blocking.map(String));
    if (Array.isArray(r.warnings)) warnings.push(...r.warnings.map(String));
  }

  return { blocking, warnings };
}

/** Attach agent-specific findings. Merges with any already present. */
export function addReview(output: Record<string, unknown>, findings: Partial<ReviewFindings>): void {
  const existing = (output[REVIEW_KEY] as Partial<ReviewFindings> | undefined) ?? {};
  output[REVIEW_KEY] = {
    blocking: [...(existing.blocking ?? []), ...(findings.blocking ?? [])],
    warnings: [...(existing.warnings ?? []), ...(findings.warnings ?? [])],
  };
}

/** The last stretch of the raw text, for the technical-detail fold. */
export function outputPreview(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const raw = (output as Record<string, unknown>)["result"];
  const text = typeof raw === "string" ? raw : JSON.stringify(output);
  return text.length > 600 ? `…${text.slice(-600)}` : text;
}
