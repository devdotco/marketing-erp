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
