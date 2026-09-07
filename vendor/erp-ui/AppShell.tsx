/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
'use client'

import { useState, useMemo, type ReactNode } from 'react'
import { Menu, X } from 'lucide-react'
import { brandVars, brandMark, type ErpBrand } from './brand'
import { ErpChromeContext } from './chrome-context'

/**
 * The suite frame: rail, sidebar, content — and one mobile drawer holding the
 * first two.
 *
 * Render props rather than props-for-everything because the two slots differ
 * per module in ways a prop list would have to anticipate: the shell wants its
 * notification dropdown in the rail, chat wants a channel tree where accounting
 * wants sections. What must NOT differ is the frame itself, and that is what
 * this owns — the widths, the breakpoint, the drawer, and where the brand's
 * custom properties are applied.
 *
 * `brandVars` is set here, on the outermost element, so it reaches the rail,
 * the sidebar and any popover portalled beneath. Setting it lower — on the
 * sidebar alone — leaves the rail painted in our colours and the sidebar in
 * theirs, which is worse than not branding it at all.
 */
export function AppShell({
  brand,
  moduleLabel,
  rail,
  sidebar,
  children,
}: {
  brand?: ErpBrand | null
  /** Shown beside the mark in the mobile bar, where the sidebar is hidden. */
  moduleLabel: string
  /**
   * Plain elements, NOT render props. A module's layout is a server component
   * and a function cannot be handed to a client component from one; the rail
   * and sidebar read `close` from context instead.
   */
  rail: ReactNode
  sidebar: ReactNode
  children: ReactNode
}) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const ctx = useMemo(() => ({ close: () => setDrawerOpen(false) }), [])
  const close = ctx.close

  return (
    <ErpChromeContext.Provider value={ctx}>
    <div className="erp-shell" style={brandVars(brand)}>
      <div className="erp-chrome">
        {rail}
        {sidebar}
      </div>

      <div className="erp-main">
        <div className="erp-mobile-bar">
          <button
            type="button"
            className="erp-mobile-toggle"
            onClick={() => setDrawerOpen(o => !o)}
            aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={drawerOpen}
          >
            {/* Always the hamburger: the drawer covers this bar when it is
                open, so a close icon here would never be seen. */}
            <Menu size={20} />
          </button>
          <span className="erp-lockup">
            <span className="erp-lockup-tile" aria-hidden="true">
              <span style={{ fontWeight: 800, fontStyle: 'italic', fontSize: 13 }}>
                {brandMark(brand)}
              </span>
            </span>
            <span className="erp-lockup-text">
              <span className="erp-lockup-name">
                {brand?.wordmark ?? 'erp.io'}{' '}
                <span className="erp-lockup-module">{moduleLabel}</span>
              </span>
            </span>
          </span>
        </div>

        {children}
      </div>

      {drawerOpen && (
        <div className="erp-drawer">
          {/* Both slots again, not a third variant of the menu: the CSS hides
              them from the page at this width and un-hides them in here, so the
              drawer cannot drift from what the desktop shows. */}
          {/* The same elements again. React re-renders the description; it is
              not a second copy of the menu that can drift from the first. */}
          {rail}
          {sidebar}
          <div className="erp-drawer-scrim" onClick={close}>
            <button
              type="button"
              onClick={close}
              aria-label="Close menu"
              style={{
                position: 'absolute', top: 12, right: 12, background: 'none',
                border: 'none', color: '#fff', cursor: 'pointer', padding: 6,
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
    </ErpChromeContext.Provider>
  )
}
