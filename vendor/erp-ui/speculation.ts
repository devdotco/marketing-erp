/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
/**
 * Speculation Rules for the app rail: warm the module you are about to click.
 *
 * Measured cost of a module switch is dominated by round trips to the origin
 * (0.4-0.8s each through Cloudflare), not by rendering (25-55ms). Prerendering
 * on hover moves that whole wait to before the click, so the click activates a
 * finished page.
 *
 * WHAT IS EVER SPECULATED. A whitelist, not a blacklist: the exact entry path of
 * a module that the rail links to DIRECTLY, on this origin. Everything else is
 * unreachable by construction, which matters because several URLs in this app
 * must never be fetched speculatively:
 *
 *   /api/shell/auth/module-token  mints a single-use credential and, via the
 *                                 callback it redirects to, creates a session
 *   /sign-out                     ends the session
 *   /notifications                marks things read
 *
 * A module that has no fast path still gets a rail href pointing at the mint;
 * `speculatableHrefs` drops it (the `/api/` check) rather than relying on a
 * pattern to miss it. The shell's mint route also refuses any request carrying
 * `Sec-Purpose: prefetch|prerender`, so a module that bounces a session-less
 * speculation to the hand-off cannot spend a token either.
 *
 * DOCUMENT rules (`where`) rather than a URL list: they apply to every link on
 * the page that matches, so the shell's home cards and top-nav dropdown benefit
 * as well as the rail, and browsers that predate document rules ignore the
 * whole script instead of reading an unknown `eagerness` as "immediately" and
 * prerendering every module on page load.
 *
 * `moderate` = after a 200ms hover on desktop, or on pointerdown if sooner.
 * It is a hint; Chrome may decline for memory, Data Saver or user settings.
 * Safari and Firefox do not implement speculation rules and ignore the script.
 */

export type SpeculationRules = {
  prerender: Array<{
    where: { href_matches: string[] }
    eagerness: 'moderate'
  }>
}

/**
 * The rail hrefs that are safe to speculate: absolute-or-relative URLs on
 * `origin`, whose path is not under /api/, with no query or fragment (an entry
 * link that carries `next=` is a hand-off in disguise).
 *
 * Returns the distinct pathnames, minus the module the viewer is already in.
 */
export function speculatableHrefs(
  hrefs: readonly string[],
  origin: string,
  activePath?: string,
): string[] {
  const out = new Set<string>()
  for (const href of hrefs) {
    let url: URL
    try { url = new URL(href, origin) } catch { continue }
    if (url.origin !== origin) continue
    if (url.search || url.hash) continue
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (path === '/' || path === '/api' || path.startsWith('/api/')) continue
    if (activePath && path === activePath) continue
    // URLPattern syntax: these characters would be read as pattern operators.
    if (/[*?+(){}:\\]/.test(path)) continue
    out.add(path)
  }
  return [...out]
}

/** The rules object for a set of safe paths, or null if there is nothing to warm. */
export function speculationRulesFor(paths: readonly string[]): SpeculationRules | null {
  if (paths.length === 0) return null
  return {
    prerender: [{
      // `/crm` and `/crm/` both: a trailing slash is a different pathname to URLPattern.
      where: { href_matches: paths.flatMap(p => [p, `${p}/`]) },
      eagerness: 'moderate',
    }],
  }
}
