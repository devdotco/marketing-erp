/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
/**
 * The cross-module link contract.
 *
 * One question, asked of every module: *what do you hold that belongs to this
 * person?* — and its manual counterpart, *search your records*. CRM asks; the
 * modules answer. Nothing here flows the other way, which is the point: Sign
 * does not learn what a CRM contact is, PM does not learn what a deal is, and
 * the association lives in CRM alone.
 *
 * Defined in the shared package rather than in CRM because five modules
 * implement it. A contract that lives inside its only caller is a contract
 * every implementer copies slightly differently.
 *
 * THE ENDPOINT. Each module serves `GET /api/module-links` under its own mount:
 *
 *   ?email=<address>   records involving that person
 *   ?q=<query>         records matching a search, for manual attach
 *
 * Called SERVER-side with the caller's shell session cookie forwarded, exactly
 * as `/api/shell/nav` is. The module scopes the answer to the organisation that
 * cookie belongs to, so a module never has to be told which tenant is asking —
 * and cannot be lied to about it.
 *
 * MODULES ON ANOTHER ORIGIN cannot be reached that way. Portal's staff cookie
 * is host-scoped to portal.erp.io on purpose — a suite-wide cookie is what
 * once collided with the shell's and signed people out of everything — so the
 * header CRM forwards simply does not contain it. Those modules are given a
 * short-lived Ed25519 hand-off token from the shell instead. That is still a
 * proof rather than an assertion: the shell signs it, the module verifies the
 * signature and the audience, and CRM only carries it.
 */

/** One record in another module, as that module describes itself. */
export type ErpLinkedRecord = {
  /** Opaque to everyone but the owning module. */
  id: string
  title: string
  /** A second line: status, counterparty, date — whatever reads usefully. */
  subtitle?: string
  /**
   * Absolute, and the module's own to build. Only it knows its mount, its route
   * shape and which of several views is the right landing place.
   */
  url: string
  /** Free-text state — "Completed", "Awaiting signature", "In review". */
  status?: string
  /** ISO 8601. What the list is sorted by when present. */
  at?: string
}

export type ErpLinkResponse = {
  records: ErpLinkedRecord[]
  /**
   * What the module answered FROM, in its own words — "SEO.co workspace",
   * "Nead, LLC". Optional, and worth having because a module's scope is not
   * always the shell's: somebody signed into the shell as HOLDDOTCO can be
   * looking at the SEO.co workspace in the CRM, and an assistant that reports
   * the shell's org as "the workspace you are in" is confidently wrong about
   * the thing the reader can see on screen.
   */
  scope?: string
}

/**
 * Ask one module for records belonging to an email, or matching a query.
 *
 * SERVER ONLY — it forwards a session cookie. Best-effort by design: a module
 * that is slow, down or simply has nothing returns an empty list, and the tab
 * renders as "nothing here" rather than as an error. One unavailable module
 * must not take a contact page down with it.
 */
export async function fetchModuleLinks(
  moduleUrl: string,
  query: { email?: string; q?: string },
  cookieHeader: string,
  timeoutMs = 2500,
  /** For cross-origin modules: a shell hand-off token minted for that module. */
  bearer?: string,
): Promise<ErpLinkedRecord[]> {
  return (await fetchModuleLinkResponse(moduleUrl, query, cookieHeader, timeoutMs, bearer)).records
}

/** As `fetchModuleLinks`, but keeps the module's reported scope. */
export async function fetchModuleLinkResponse(
  moduleUrl: string,
  query: { email?: string; q?: string },
  cookieHeader: string,
  timeoutMs = 2500,
  bearer?: string,
): Promise<{ records: ErpLinkedRecord[]; scope?: string }> {
  const url = new URL(`${moduleUrl.replace(/\/$/, '')}/api/module-links`)
  if (query.email) url.searchParams.set('email', query.email)
  if (query.q) url.searchParams.set('q', query.q)

  try {
    const res = await fetch(url, {
      headers: bearer
        ? { cookie: cookieHeader, authorization: `Bearer ${bearer}` }
        : { cookie: cookieHeader },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      // NEVER follow a redirect. A module whose middleware guards this path
      // sends the caller to its SSO hand-off; `fetch` would follow, and the
      // answer would be a sign-in page carrying a 200. That parses as "no
      // records", so a misconfigured module is indistinguishable from an empty
      // one — which is exactly how it went unnoticed until somebody asked why
      // the picker was empty.
      redirect: 'manual',
    })
    if (!res.ok || res.status === 0) return { records: [] }

    // Same reasoning: only JSON is an answer. HTML with a 200 is a module that
    // has not exempted this path, and it is worth saying so out loud rather
    // than rendering it as emptiness.
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('application/json')) {
      console.warn(
        `[module-links] ${moduleUrl} answered ${res.status} ${type || 'with no content-type'} — ` +
          'the route is probably behind that module\'s auth redirect',
      )
      return { records: [] }
    }

    const body = (await res.json()) as Partial<ErpLinkResponse>
    if (!Array.isArray(body.records)) return { records: [] }

    // Validated rather than trusted: this crosses a service boundary, and a
    // record missing an id or a url would render as a link to nowhere.
    const records = body.records.flatMap(r => {
      const rec = r as Partial<ErpLinkedRecord>
      if (!rec?.id || !rec?.title || !rec?.url) return []
      return [{
        id: rec.id,
        title: rec.title,
        subtitle: rec.subtitle,
        url: rec.url,
        status: rec.status,
        at: rec.at,
      }]
    })
    return { records, scope: typeof body.scope === 'string' ? body.scope : undefined }
  } catch (err) {
    // Silence here is what made this hard to see: a timeout, a DNS failure and
    // an empty workspace all rendered identically as "nothing found".
    const reason = (err as Error)?.name === 'TimeoutError'
      ? `did not answer within ${timeoutMs}ms`
      : `failed: ${(err as Error)?.message ?? 'unknown error'}`
    console.warn(`[module-links] ${moduleUrl} ${reason}`)
    return { records: [] }
  }
}
