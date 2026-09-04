/**
 * Where this app is mounted.
 *
 * Marketing is served from `app.erp.io/marketing` rather than its own
 * subdomain, so the suite shares ONE origin — which is what lets a hand-off
 * from the shell stop being a cross-site exchange.
 *
 * Next's `basePath` rewrites `<Link>`, the router, `redirect()` and static
 * assets. It does NOT touch strings: a runtime `fetch('/api/…')` resolves
 * against the origin and lands on the SHELL, which answers 404. Anything that
 * builds a path as text goes through here.
 *
 * Kept in lockstep with `basePath` in next.config.ts by hand; Next exposes no
 * public runtime accessor for it.
 */
export const BASE_PATH = "/marketing";

/** Prefix an app-absolute path with the mount point. */
export function withBase(path: string): string {
  return path.startsWith("/") ? `${BASE_PATH}${path}` : `${BASE_PATH}/${path}`;
}

/**
 * `fetch` for this app's own API.
 *
 * A wrapper rather than `withBase()` at each call site: the paths are a mix of
 * quoted strings and template literals, and rewriting the argument of every call
 * by hand is how a stray parenthesis ships.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(withBase(path), init);
}

/**
 * A path with the mount on it, exactly once.
 *
 * For values that arrive from somewhere else — a `callbackUrl` off a query
 * string, a form field — where it is genuinely unknown whether the mount is
 * already attached. `withBase` would double it; this will not.
 */
export function ensureBase(path: string): string {
  if (!path.startsWith("/")) return withBase(path);
  if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
  return withBase(path);
}

/** The app's own absolute origin-plus-mount, for links that leave the browser. */
export function appUrl(path = "/"): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://app.erp.io/marketing").replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
