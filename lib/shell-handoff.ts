/**
 * Where a browser goes to redeem the shell's `__vibe_session` for a Marketing
 * session — the SSO fast path.
 *
 * Shared by `proxy.ts` (which runs for every path except the bare mount) and
 * `app/page.tsx` (the one path it never runs for — see
 * erp-io-bare-mount-no-middleware), so the two cannot drift on the cookie name
 * or the hand-off URL shape.
 */
export const SHELL_SESSION_COOKIE = "__vibe_session";

/**
 * `next` must be the UNMOUNTED path — the shell's callback lands on this
 * app's `/api/auth/shell`, which adds the mount back with `withBase` before
 * redirecting into NextAuth. Passing a mounted path here would double it.
 */
export function shellHandoffUrl(next: string): URL {
  const shell = (process.env.SHELL_URL ?? "https://app.erp.io").replace(/\/$/, "");
  const handoff = new URL(`${shell}/api/shell/auth/module-token`);
  handoff.searchParams.set("aud", "marketing");
  handoff.searchParams.set("next", next);
  return handoff;
}
