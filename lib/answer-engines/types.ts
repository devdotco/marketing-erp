import type { AnswerEngine } from "@prisma/client";

/** One source an engine cited, as the engine gave it to us. */
export interface EngineCitation {
  url: string;
  title?: string;
  /** Order of appearance, 1-based. */
  position: number;
}

/** What an engine actually said. The raw material every metric derives from. */
export interface EngineAnswer {
  engine: AnswerEngine;
  /** The exact model id that answered — visibility steps when an engine ships
   *  a new model, and without this the trend has an unexplained jump in it. */
  model: string;
  text: string;
  citations: EngineCitation[];
  costUsd: number;
}

export interface AskOptions {
  /** Hard ceiling on the answer, so one capture cannot run away with a budget. */
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * How long one engine may take before the capture gives up on it.
 *
 * A capture is a fan-out over a bounded worker pool. Without a deadline, one
 * engine that accepts a connection and never answers holds a pool slot for as
 * long as the process lives, and the run neither finishes nor fails — it just
 * stops, with no error to read. Ninety seconds is generous for a grounded
 * answer and short enough that a wedged engine costs one slot for a minute and
 * a half rather than a night.
 *
 * A timed-out engine is recorded as a failure for that prompt, like any other,
 * and the day still derives from what the rest returned.
 */
export const ENGINE_TIMEOUT_MS = 90_000;

/** The caller's signal if it gave one, otherwise the standard deadline. */
export function askSignal(opts: AskOptions): AbortSignal {
  return opts.signal ?? AbortSignal.timeout(ENGINE_TIMEOUT_MS);
}

export interface AnswerEngineClient {
  engine: AnswerEngine;
  /** Display name for the UI. */
  name: string;
  ask(prompt: string, opts?: AskOptions): Promise<EngineAnswer>;
}

/**
 * An engine answered, but not in a shape we can read.
 *
 * Separate from a transport error on purpose: a 500 is worth retrying and a
 * response whose shape we do not recognise is not — it means the provider
 * changed their API and the parser needs updating, which no retry will fix.
 */
export class EngineShapeError extends Error {
  constructor(
    public engine: AnswerEngine,
    message: string,
    public sample?: unknown,
  ) {
    super(`${engine}: ${message}`);
    this.name = "EngineShapeError";
  }
}
