/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
'use client'

import { createContext, useContext } from 'react'

/**
 * How the chrome closes itself on mobile.
 *
 * This exists because the slots used to be render props — `rail={({onNavigate})
 * => …}` — and a function cannot cross the server-to-client boundary. Every
 * module's layout is a server component, so passing one threw
 * "Functions cannot be passed directly to Client Components". It surfaced only
 * when a module prerendered a route: Sign and Legal built clean and would have
 * failed at request time instead, which is the worse way to find out.
 *
 * With the slots as plain elements, the drawer publishes `close` here and the
 * rail and sidebar pick it up themselves. Nothing is passed down, so nothing
 * can be passed wrongly.
 */
export const ErpChromeContext = createContext<{ close: () => void } | null>(null)

/** No provider means no drawer to close — the desktop case, and a no-op. */
export function useErpChromeClose(): () => void {
  const ctx = useContext(ErpChromeContext)
  return ctx?.close ?? (() => {})
}
