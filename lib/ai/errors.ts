import Anthropic from "@anthropic-ai/sdk";

/**
 * A failure a person can act on.
 *
 * Agent runs used to store the SDK's raw message verbatim, so the Output panel
 * showed a nested, escaped JSON blob:
 *   {"error": "404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\", …
 * Nobody but whoever wrote the integration could read that. Every failure now
 * becomes one of these instead, with the raw payload kept under `detail` for
 * debugging.
 */
export type RunError = {
  /** Stable machine code, e.g. "model_not_found". */
  code: string;
  /** One line, plain English, safe to show anyone. */
  message: string;
  /** What to do about it. */
  hint: string;
  /** Whose problem it is — decides whether a retry could ever help. */
  retryable: boolean;
  /** Raw provider text, for engineers. */
  detail?: string;
};

/**
 * A failure caused by what the run was asked to do, not by the agent or the
 * provider. Without this, a blank brief falls through to the generic case and
 * tells the person "this is a fault in the agent itself, not in anything you
 * entered" — which is the opposite of true and sends them to the wrong place.
 */
export class AgentInputError extends Error {
  readonly code: string;
  readonly hint: string;

  constructor(message: string, hint: string, code = "invalid_input") {
    super(message);
    this.name = "AgentInputError";
    this.code = code;
    this.hint = hint;
  }
}

export function describeRunError(err: unknown): RunError {
  if (err instanceof AgentInputError) {
    return {
      code: err.code,
      message: err.message,
      hint: err.hint,
      retryable: false,
    };
  }

  const detail = err instanceof Error ? err.message : String(err);

  // Checked before any SDK error class, because this one arrives as several of
  // them. A workspace whose Anthropic balance runs out gets a 400
  // invalid_request_error from a normal call — which fell through to
  // "bad_request" and told the customer to check the agent's configuration —
  // and an unclassified APIError from a streamed call, which became
  // "api_error_unknown" and told them nothing at all. Both happened in
  // production on the same tenant within twenty minutes, and neither message
  // contained the word "credit".
  //
  // Matching on the message text is unpleasant but it is the only signal:
  // there is no distinct status or error type for a spent balance.
  if (/credit balance is too low|insufficient[ _-]?credit|billing|purchase credits/i.test(detail)) {
    return {
      code: "insufficient_credit",
      message: "Your Anthropic account has run out of credit, so the agent could not run.",
      hint:
        "Add credit at console.anthropic.com under Plans & Billing, then run this again. " +
        "Agents are billed to your own Anthropic key, so this is your account's balance rather than anything owed to us. " +
        "Nothing was spent and no work was lost.",
      retryable: false,
      detail,
    };
  }

  if (err instanceof Anthropic.NotFoundError) {
    return {
      code: "model_not_found",
      message: "This agent is pointed at a Claude model that no longer exists.",
      hint: "The model id in the agent handler is stale. Model ids live in lib/ai/models.ts — run `npm run check:models` to see which one is wrong. No tokens were spent.",
      retryable: false,
      detail,
    };
  }

  if (err instanceof Anthropic.AuthenticationError) {
    return {
      code: "auth_failed",
      message: "The workspace could not authenticate with Anthropic.",
      hint: "ANTHROPIC_API_KEY is missing, expired, or revoked. An administrator needs to update it.",
      retryable: false,
      detail,
    };
  }

  if (err instanceof Anthropic.PermissionDeniedError) {
    return {
      code: "permission_denied",
      message: "The Anthropic API key is not allowed to use this model.",
      hint: "Check the key's workspace permissions in the Anthropic Console.",
      retryable: false,
      detail,
    };
  }

  if (err instanceof Anthropic.RateLimitError) {
    return {
      code: "rate_limited",
      message: "Anthropic rate-limited this workspace.",
      hint: "The run will be retried automatically. If it keeps happening, reduce how many agents run at once.",
      retryable: true,
      detail,
    };
  }

  if (err instanceof Anthropic.BadRequestError) {
    return {
      code: "bad_request",
      message: "Anthropic rejected the request this agent built.",
      hint: "Usually an input that is too long, or a configuration value the agent cannot use. Check the agent's configuration, then the detail below.",
      retryable: false,
      detail,
    };
  }

  if (err instanceof Anthropic.APIConnectionError) {
    return {
      code: "connection_failed",
      message: "Could not reach Anthropic.",
      hint: "A network or upstream problem. The run will be retried automatically.",
      retryable: true,
      detail,
    };
  }

  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return {
      code: `api_error_${status || "unknown"}`,
      message: "Anthropic returned an error while this agent was running.",
      hint: status >= 500
        ? "This is an upstream fault. The run will be retried automatically."
        : "Check the detail below, then the agent's configuration.",
      retryable: status >= 500 || status === 408 || status === 409,
      detail,
    };
  }

  return {
    code: "handler_error",
    message: "The agent failed while running.",
    hint: "This is a fault in the agent itself, not in anything you entered. The detail below has the specifics.",
    retryable: false,
    detail,
  };
}
