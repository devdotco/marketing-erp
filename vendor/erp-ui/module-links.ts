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

export type ErpLinkResponse = { records: ErpLinkedRecord[] }

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
): Promise<ErpLinkedRecord[]> {
  const url = new URL(`${moduleUrl.replace(/\/$/, '')}/api/module-links`)
  if (query.email) url.searchParams.set('email', query.email)
  if (query.q) url.searchParams.set('q', query.q)

  try {
    const res = await fetch(url, {
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    if (!res.ok) return []

    const body = (await res.json()) as Partial<ErpLinkResponse>
    if (!Array.isArray(body.records)) return []

    // Validated rather than trusted: this crosses a service boundary, and a
    // record missing an id or a url would render as a link to nowhere.
    return body.records.flatMap(r => {
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
  } catch {
    return []
  }
}
