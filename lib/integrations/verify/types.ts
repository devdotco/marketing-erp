/**
 * A check run when a key-based integration is saved, so a bad key is a form
 * error instead of an agent that quietly falls back to simulated output.
 * Return `{ ok: false, reason }` with a sentence a customer can act on.
 * Must be cheap (one read-only call) and never mutate the remote account.
 */
export type KeyVerifier = (credentials: Record<string, string>) => Promise<{ ok: true } | { ok: false; reason: string }>;
