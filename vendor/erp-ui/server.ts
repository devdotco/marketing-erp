/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
import { cookies } from 'next/headers'
import type { ErpBrand } from './brand'

/**
 * SERVER ONLY. Imports `next/headers`, so importing this from a client
 * component fails the build — which is the intended guard, not an obstacle.
 *
 * Every module needs the same two facts before it can draw its chrome: the
 * acting organisation's white-label branding, and which applications it is
 * entitled to. Both live in the shell, and both come back from one call.
 * Written here rather than copied into each module because it was already
 * copied three times and had drifted by the second.
 */

const SHELL_COOKIE = '__vibe_session'

export function erpShellUrl(): string {
  return (process.env.SHELL_URL ?? 'https://app.erp.io').replace(/\/$/, '')
}

export type ErpShellNav = {
  /** Null for an unbranded workspace — which is what `brandVars(null)` draws. */
  brand: ErpBrand | null
  /** Module keys this organisation may open. Empty means "show every live one". */
  modules: string[]
}

/**
 * The chrome facts, from the shell.
 *
 * Readable at all only because the modules were collapsed onto one origin: the
 * shell's cookie is scoped to app.erp.io, so it now arrives with a module's
 * own request. On a module's old subdomain it never did.
 *
 * Best-effort by design. A slow or unreachable shell yields no branding and no
 * entitlement, which renders as the erp.io defaults and a full rail — the way
 * the suite looked before either existed. Nobody is locked out of their work
 * because a chrome lookup timed out.
 */
export async function loadShellNav(): Promise<ErpShellNav> {
  const token = (await cookies()).get(SHELL_COOKIE)?.value
  if (!token) return { brand: null, modules: [] }

  try {
    const res = await fetch(`${erpShellUrl()}/api/shell/nav`, {
      headers: { cookie: `${SHELL_COOKIE}=${token}` },
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    })
    if (!res.ok) return { brand: null, modules: [] }

    const body = (await res.json()) as { brand?: ErpBrand | null; modules?: { key?: string }[] }
    return {
      brand: body.brand ?? null,
      modules: Array.isArray(body.modules)
        ? body.modules.flatMap(m => (m?.key ? [m.key] : []))
        : [],
    }
  } catch {
    return { brand: null, modules: [] }
  }
}
