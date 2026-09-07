/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
'use client'

import { useState, type ComponentType, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight, Settings, LogOut } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { brandMark, type ErpBrand } from './brand'
import { OrgSwitcher, type ErpOrg } from './OrgSwitcher'
import { useErpChromeClose } from './chrome-context'

export type ErpNavItem = {
  label: string
  /**
   * Identifies the item when the module selects in state rather than
   * navigating. Canvas is the case this exists for: its sidebar filters a board
   * list in place, so its rows have no URL to be active against.
   */
  key?: string
  href?: string
  /**
   * Any component that renders an icon.
   *
   * Widened from `LucideIcon` because a module may have its own kit — cfo-erp-io
   * draws per-route glyphs from its `ds` package, and forcing those through a
   * Lucide-shaped type meant either casting at every call site or not using the
   * shared row at all.
   */
  icon?: ComponentType<{ size?: number; className?: string }>
  /** Unread or outstanding count. Zero and undefined both render nothing. */
  badge?: number
  /** Match this href only, never its children — for a hub above its own pages. */
  exact?: boolean
  /** Visible but inert, with a "Soon" chip. */
  soon?: boolean
  /**
   * A parent expands in place and never navigates on its own: someone aiming
   * for a child should not sit through a page load they did not want.
   */
  children?: ErpNavItem[]
}

export type ErpNavSection = {
  /** Omit for an ungrouped run of items at the top of the menu. */
  label?: string
  items: ErpNavItem[]
}

function isActive(pathname: string, item: ErpNavItem, activeKey?: string): boolean {
  // A state-driven module wins over the route: it knows which row is selected
  // and the URL does not change when the selection does.
  if (activeKey !== undefined && item.key !== undefined) return item.key === activeKey
  if (!item.href) return false
  if (item.exact || item.href === '/') return pathname === item.href
  return pathname === item.href || pathname.startsWith(item.href + '/')
}

function NavRow({ item, active, onNavigate, onSelect }: {
  item: ErpNavItem
  active: boolean
  onNavigate?: () => void
  onSelect?: (key: string) => void
}) {
  const Icon = item.icon
  const cls = `erp-nav-row${active ? ' is-active' : ''}${item.soon ? ' is-soon' : ''}`
  const body = (
    <>
      {Icon && <Icon size={15} className="erp-nav-icon" />}
      <span className="erp-nav-label">{item.label}</span>
      {item.soon && <span className="erp-nav-soon">Soon</span>}
      {!item.soon && !!item.badge && (
        <span className="erp-nav-badge">{item.badge > 99 ? '99+' : item.badge}</span>
      )}
    </>
  )

  // Selected in place rather than navigated: a real button, so it is focusable
  // and announced as the control it is.
  if (!item.soon && !item.href && item.key && onSelect) {
    return (
      <button
        type="button"
        className={cls}
        onClick={() => { onSelect(item.key!); onNavigate?.() }}
        {...(active ? { 'aria-current': 'true' as const } : {})}
      >
        {body}
      </button>
    )
  }

  // A `soon` item has nowhere to go, and a link to `#` is still focusable and
  // still announced as a link. A span is the honest element.
  if (item.soon || !item.href) return <span className={cls}>{body}</span>

  return (
    <Link
      href={item.href}
      className={cls}
      onClick={onNavigate}
      {...(active ? { 'aria-current': 'page' as const } : {})}
    >
      {body}
    </Link>
  )
}

function NavGroup({ item, pathname, activeKey, onNavigate, onSelect }: {
  item: ErpNavItem
  pathname: string
  activeKey?: string
  onNavigate?: () => void
  onSelect?: (key: string) => void
}) {
  const children = item.children ?? []
  const hasActiveChild = children.some(c => isActive(pathname, c, activeKey))
  const [manual, setManual] = useState<boolean | null>(null)
  // An open child wins over a collapsed parent: landing on a deep link with its
  // own group shut leaves you with no idea where you are.
  const open = manual ?? hasActiveChild
  const Icon = item.icon

  return (
    <li>
      <button
        type="button"
        className={`erp-nav-row${hasActiveChild ? ' is-ancestor' : ''}`}
        aria-expanded={open}
        onClick={() => setManual(!open)}
      >
        {Icon && <Icon size={15} className="erp-nav-icon" />}
        <span className="erp-nav-label">{item.label}</span>
        <ChevronRight size={13} className={`erp-nav-chev${open ? ' is-open' : ''}`} />
      </button>

      {open && (
        <div className="erp-nav-children">
          {children.map(child => (
            <NavRow
              key={child.href ?? child.label}
              item={child}
              active={isActive(pathname, child, activeKey)}
              onNavigate={onNavigate}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </li>
  )
}

/**
 * The module sidebar — where in THIS application am I.
 *
 * The second tier of a two-tier navigation, beside `AppRail`. Two levels only;
 * anything deeper belongs in the content area, where there is room for it and a
 * URL to link to it.
 *
 * The nav is data, not markup. That is what makes twelve modules consistent:
 * each one declares its sections and gets identical chrome, rather than each
 * one re-implementing rows, active states, groups and a footer — which is how
 * accounting ended up with inline styles, crm with Tailwind utilities and pm
 * with 1,231 lines of its own.
 */
export function ModuleSidebar({
  moduleLabel,
  moduleIcon: ModuleIcon,
  moduleHref = '/',
  brand,
  sections,
  activeKey,
  onSelectItem,
  orgs,
  currentOrgId,
  onSwitchOrg,
  scopeSwitcher,
  primaryAction,
  scrollExtra,
  user,
  settingsHref,
  signOutAction,
  onSignOut,
  footerExtra,
  onNavigate: onNavigateProp,
}: {
  /** The module's own name — "Accounting". Drawn in the accent colour. */
  moduleLabel: string
  /**
   * The module's glyph, for the lockup tile — normally its entry in
   * `ERP_MODULE_ICONS`, so the sidebar and the rail agree on what this
   * application looks like.
   *
   * Without it the tile falls back to the brand letter, which puts the same
   * mark twice on one row: the rail's `E.` and, 12px to its right, another
   * `E.`. The tile's job is to say WHICH application, not to repeat the brand.
   */
  moduleIcon?: LucideIcon
  moduleHref?: string
  brand?: ErpBrand | null
  sections: ErpNavSection[]
  /** Selected item key, for a module that filters in place instead of routing. */
  activeKey?: string
  onSelectItem?: (key: string) => void
  orgs?: ErpOrg[]
  currentOrgId?: string | null
  onSwitchOrg?: (orgId: string) => void
  /**
   * The second level of tenancy — which brand, domain or site inside this
   * organization. Rendered directly beneath the org switcher so the two
   * questions are asked in the order they nest. Modules that only work at the
   * organization level (accounting) pass nothing.
   */
  scopeSwitcher?: ReactNode
  /**
   * The module's single create action, rendered directly under the header.
   *
   * A slot rather than a label+href pair: sign links to /new, canvas opens a
   * dialog, pm needs the current project. Give it the `erp-primary-action`
   * class and it matches everywhere.
   */
  primaryAction?: ReactNode
  /**
   * The module's own structure, below the declared sections and inside the same
   * scroll area — canvas's folder tree, pm's project list, chat's channels.
   *
   * A slot rather than an attempt to model every tree in `ErpNavItem`: these
   * differ in what they contain, what they can be renamed to and what they do
   * on click, and the thing worth sharing is the frame and the row styling, not
   * a schema general enough to describe all three. Use `erp-nav-row` and
   * `erp-nav-section-label` inside it and it will match.
   */
  scrollExtra?: ReactNode
  user?: { name: string; email: string }
  settingsHref?: string
  /** POST target for sign-out, for modules that sign out with a form. */
  signOutAction?: string
  /** Handler for sign-out, for modules that do it with fetch. */
  onSignOut?: () => void
  footerExtra?: ReactNode
  onNavigate?: () => void
}) {
  // From context, so a server-component layout never has to pass a function.
  const closeDrawer = useErpChromeClose()
  const onNavigate = onNavigateProp ?? closeDrawer
  const pathname = usePathname()
  const initials = user
    ? (user.name || user.email).split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()
    : ''

  return (
    <aside className="erp-sidebar">
      <div className="erp-sidebar-head">
        <Link href={moduleHref} className="erp-lockup" onClick={onNavigate}>
          {brand?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt={brand.wordmark ?? 'Logo'} className="erp-lockup-logo" />
          ) : (
          <span className="erp-lockup-tile" aria-hidden="true">
            {ModuleIcon ? (
              <ModuleIcon size={17} />
            ) : (
              <span style={{ fontWeight: 800, fontStyle: 'italic', fontSize: 13, letterSpacing: '-0.02em' }}>
                {brandMark(brand)}
              </span>
            )}
          </span>
          )}
          <span className="erp-lockup-text">
            {/* With a logo the wordmark is already in the image; repeating it as
                type would be the brand twice. The module name still appears —
                it is what says which application this is. */}
            <span className="erp-lockup-name">
              {!brand?.logoUrl && <>{brand?.wordmark ?? 'erp.io'}{' '}</>}
              <span className="erp-lockup-module">{moduleLabel}</span>
            </span>
            {!brand?.logoUrl && <span className="erp-lockup-sub">ERP</span>}
          </span>
        </Link>

        {((orgs && orgs.length > 0 && onSwitchOrg) || scopeSwitcher) && (
          <div className="erp-sidebar-org">
            {orgs && orgs.length > 0 && onSwitchOrg && (
              <OrgSwitcher orgs={orgs} currentOrgId={currentOrgId ?? null} onSwitch={onSwitchOrg} />
            )}
            {scopeSwitcher}
          </div>
        )}
      </div>

      {primaryAction}

      <div className="erp-sidebar-scroll">
        {sections.map((section, i) => (
          <div key={section.label ?? `section-${i}`}>
            {section.label && <p className="erp-nav-section-label">{section.label}</p>}
            <ul className="erp-nav-list">
              {section.items.map(item =>
                item.children?.length ? (
                  <NavGroup
                    key={item.label}
                    item={item}
                    pathname={pathname}
                    activeKey={activeKey}
                    onNavigate={onNavigate}
                    onSelect={onSelectItem}
                  />
                ) : (
                  <li key={item.href ?? item.key ?? item.label}>
                    <NavRow
                      item={item}
                      active={isActive(pathname, item, activeKey)}
                      onNavigate={onNavigate}
                      onSelect={onSelectItem}
                    />
                  </li>
                ),
              )}
            </ul>
          </div>
        ))}

        {scrollExtra}
      </div>

      <div className="erp-sidebar-foot">
        {footerExtra}

        {settingsHref && (
          <Link href={settingsHref} className="erp-foot-row" onClick={onNavigate}>
            <Settings size={14} />
            <span>Settings</span>
          </Link>
        )}

        {user && (
          <div className="erp-user">
            <div className="erp-avatar" aria-hidden="true">{initials}</div>
            <div className="erp-user-text">
              <div className="erp-user-name">{user.name}</div>
              <div className="erp-user-email">{user.email}</div>
            </div>
          </div>
        )}

        {signOutAction ? (
          <form action={signOutAction} method="POST">
            <button type="submit" className="erp-foot-row">
              <LogOut size={14} />
              <span>Sign out</span>
            </button>
          </form>
        ) : onSignOut ? (
          <button type="button" className="erp-foot-row" onClick={onSignOut}>
            <LogOut size={14} />
            <span>Sign out</span>
          </button>
        ) : null}
      </div>
    </aside>
  )
}
