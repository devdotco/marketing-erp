/**
 * Run-error classification. No network, no database.
 * Run with `npm run test:errors`.
 *
 * The fixtures are byte-for-byte what production stored on two failed runs, on
 * the same tenant, twenty minutes apart. Both were a spent Anthropic balance.
 * One was reported as "Anthropic rejected the request this agent built —
 * usually an input that is too long, or a configuration value the agent cannot
 * use. Check the agent's configuration"; the other as "Anthropic returned an
 * error while this agent was running". Neither contained the word "credit", and
 * the first actively sent the customer to look at the wrong thing.
 *
 * A wrong diagnosis is worse than a vague one, so these stay as tests.
 */
import Anthropic from "@anthropic-ai/sdk";
import { describeRunError, AgentInputError } from "@/lib/ai/errors";

let failures = 0;
const check = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!cond) failures += 1;
};

const CREDIT_MESSAGE =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

// Run cmubrhnc… (Topic Planner) — a plain call, so the SDK threw BadRequestError.
{
  const err = new Anthropic.BadRequestError(
    400,
    { type: "error", error: { type: "invalid_request_error", message: CREDIT_MESSAGE } },
    `400 {"type":"error","error":{"type":"invalid_request_error","message":"${CREDIT_MESSAGE}"}}`,
    new Headers(),
  );
  const d = describeRunError(err);
  check("a 400 for a spent balance is not reported as a bad request", d.code === "insufficient_credit", d.code);
  check("and the message says credit", /credit/i.test(d.message), d.message);
  check("and it is not retryable — a retry cannot add money", d.retryable === false, d.retryable);
  check("and the hint points at billing, not at the agent config", /Plans & Billing/i.test(d.hint), d.hint);
}

// Run cmubr0exa… (Blog Writer) — a streamed call, which surfaced as a bare
// Error carrying the provider's JSON, and classified as api_error_unknown.
{
  const err = new Error(
    `{"type":"error","error":{"details":null,"type":"invalid_request_error","message":"${CREDIT_MESSAGE}"},"request_id":"req_011CfHHT84g1NouR1Dm7qDgb"}`,
  );
  const d = describeRunError(err);
  check("the streamed shape classifies the same way", d.code === "insufficient_credit", d.code);
}

// The branch must not swallow genuine bad requests — that would trade one
// wrong diagnosis for another.
{
  const err = new Anthropic.BadRequestError(
    400,
    { error: { message: "max_tokens: 200000 > 64000, which is the maximum" } },
    "400 max_tokens too large",
    new Headers(),
  );
  check("a real bad request is still a bad request", describeRunError(err).code === "bad_request", describeRunError(err).code);
}

{
  const err = new Anthropic.AuthenticationError(401, { error: { message: "invalid x-api-key" } }, "401", new Headers());
  check("a bad key is still an auth failure", describeRunError(err).code === "auth_failed", describeRunError(err).code);
}

{
  const err = new Anthropic.NotFoundError(404, { error: { message: "model not found" } }, "404", new Headers());
  check("a stale model id is still model_not_found", describeRunError(err).code === "model_not_found", describeRunError(err).code);
}

// An agent's own refusal is passed through untouched, including its code.
{
  const err = new AgentInputError("Payload is selected as the CMS Target, but it isn't connected.", "Connect it.", "cms_not_connected");
  const d = describeRunError(err);
  check("an agent's own refusal keeps its code", d.code === "cms_not_connected", d.code);
  check("and is never retried", d.retryable === false, d.retryable);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
