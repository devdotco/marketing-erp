/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
'use client'

import { Home, Bell, LogOut } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ERP_MODULES, SHELL_URL, type ErpModuleKey } from './registry'
import { ERP_MODULE_ICONS } from './icons'
import { brandMark, type ErpBrand } from './brand'
import { useErpChromeClose } from './chrome-context'

export type ErpRailItem = {
  key: string
  label: string
  href: string
  icon: LucideIcon
  badge?: number
}

/**
 * Build the rail from the registry.
 *
 * `enabled` is the acting organisation's entitlement list. Unentitled modules
 * are ABSENT rather than disabled — a greyed icon advertises a paywall on every
 * screen to someone who already decided not to buy it.
 *
 * `undefined` — or an EMPTY list — shows every live module. The empty case
 * matters and is deliberate: modules used to fall back to "just me" when the
 * entitlement lookup failed or a session predated the claim, on the reasoning
 * that a rail must not promise doors it cannot open. In practice that reasoning
 * is backwards. A failed lookup is not evidence of a small subscription, and
 * collapsing to one icon makes the suite look broken to the customer most
 * likely to own all of it. A door that bounces off the shell's token endpoint
 * is a smaller failure than a rail that has silently lost eleven applications.
 *
 * The only thing that should ever shrink this rail is a real entitlement
 * answer.
 *
 * `urls` overrides the registry's defaults per key, for the deployments that
 * point at different hosts (the same build serves app.vb.co and app.erp.io).
 */
export function buildRailItems(opts: {
  enabled?: readonly string[]
  urls?: Partial<Record<ErpModuleKey, string>>
  badges?: Record<string, number>
  /** Send SSO modules through the shell's token mint instead of straight in. */
  handoff?: (key: ErpModuleKey, url: string) => string
} = {}): ErpRailItem[] {
  const { enabled, urls, badges, handoff } = opts
  return ERP_MODULES
    .filter(m => m.live)
    .filter(m => (enabled?.length ? enabled.includes(m.key) : true))
    .map(m => {
      const url = urls?.[m.key] ?? m.url
      return {
        key: m.key,
        label: m.label,
        href: handoff ? handoff(m.key, url) : url,
        icon: ERP_MODULE_ICONS[m.key],
        badge: badges?.[m.key],
      }
    })
}

function RailButton({
  href, label, active, badge, children, onNavigate,
}: {
  href: string
  label: string
  active?: boolean
  badge?: number
  children: React.ReactNode
  onNavigate?: () => void
}) {
  return (
    <a
      href={href}
      className={`erp-rail-btn${active ? ' is-active' : ''}`}
      aria-label={label}
      onClick={onNavigate}
      {...(active ? { 'aria-current': 'page' as const } : {})}
    >
      {children}
      {badge ? <span className="erp-rail-badge">{badge > 99 ? '99+' : badge}</span> : null}
      {/* Not `title`: a native tooltip takes ~1s to appear, which is longer than
          it takes to give up and click the wrong icon. Hidden from assistive
          tech because `aria-label` above already names the link. */}
      <span className="erp-rail-tip" aria-hidden="true">{label}</span>
    </a>
  )
}

/**
 * The app rail — one button per application in the suite.
 *
 * Identical in every module, which is the entire point: this answers "which of
 * N applications am I in", and the answer has to be in the same place, in the
 * same order, with the same glyphs, or it answers nothing. It is the cheaper of
 * the two navigation signals and the one nothing else on screen provides, so it
 * survives at every breakpoint.
 *
 * Sign-out points at the shell rather than the local module. The shell owns the
 * session; a module signing itself out left the suite session standing, so the
 * next click signed you straight back in.
 */
export function AppRail({
  items,
  activeKey,
  brand,
  notificationCount,
  onNavigate: onNavigateProp,
  homeHref = `${SHELL_URL}/home`,
  notificationsHref = `${SHELL_URL}/notifications`,
  signOutHref = `${SHELL_URL}/sign-out`,
}: {
  items: ErpRailItem[]
  /** The module this rail is rendering inside, or 'home' for the shell. */
  activeKey?: string
  brand?: ErpBrand | null
  notificationCount?: number
  onNavigate?: () => void
  homeHref?: string
  notificationsHref?: string
  signOutHref?: string
}) {
  // From context, so a server-component layout never has to pass a function.
  const closeDrawer = useErpChromeClose()
  const onNavigate = onNavigateProp ?? closeDrawer

  return (
    <nav className="erp-rail" aria-label="Applications">
      <a href={homeHref} className="erp-rail-mark" aria-label="erp.io home" onClick={onNavigate}>
        {brandMark(brand)}
      </a>

      <div className="erp-rail-sep" />

      <RailButton
        href={homeHref}
        label="Home"
        active={activeKey === 'home'}
        onNavigate={onNavigate}
      >
        <Home size={17} />
      </RailButton>

      {items.map(({ key, label, href, icon: Icon, badge }) => (
        <RailButton
          key={key}
          // The active module keeps its real href rather than becoming '#':
          // clicking the app you are already in should return you to its home,
          // not append a fragment to the URL you were on.
          href={href}
          label={label}
          active={key === activeKey}
          badge={badge}
          onNavigate={onNavigate}
        >
          <Icon size={17} />
        </RailButton>
      ))}

      <div className="erp-rail-spacer" />
      <div className="erp-rail-sep" />

      <RailButton href={notificationsHref} label="Notifications" badge={notificationCount} onNavigate={onNavigate}>
        <Bell size={17} />
      </RailButton>
      <RailButton href={signOutHref} label="Sign out of erp.io" onNavigate={onNavigate}>
        <LogOut size={17} />
      </RailButton>
    </nav>
  )
}
