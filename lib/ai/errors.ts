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

export function describeRunError(err: unknown): RunError {
  const detail = err instanceof Error ? err.message : String(err);

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
