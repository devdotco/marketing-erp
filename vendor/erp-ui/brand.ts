/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
import type { CSSProperties } from 'react'

/**
 * The white-label surface.
 *
 * Every colour and mark the chrome draws resolves through a `--erp-*` custom
 * property, so re-branding a customer's sidebar is setting four values on one
 * element rather than a fork of the components. That is why the continuity work
 * had to come first: four modules painted their sidebar with inline styles and
 * Tailwind utilities, which no amount of variable-setting can reach.
 *
 * Nothing here reads a database or an environment. A caller loads the brand for
 * the acting organisation and passes it in; this module only turns it into CSS.
 * Keeping it pure is what lets the same code run in the shell (which has the
 * row already) and in a module (which fetches it from `/api/shell/nav`).
 */
export type ErpBrand = {
  /**
   * The rail mark — one or two characters. Defaults to `E.` for erp.io.
   *
   * Deliberately text rather than an uploaded image: it is drawn at 34px inside
   * a rounded tile, and every logo a customer has actually sent us is a
   * horizontal lockup that becomes unreadable at that size. An image belongs in
   * `wordmark`, beside the module name, where there is room for it.
   */
  mark?: string
  /** Replaces "erp.io" in the sidebar lockup. The module name stays. */
  wordmark?: string
  /**
   * A logo image for the sidebar lockup, replacing the tile and wordmark.
   *
   * The sidebar has ~180px to give it, which is why an image works here and not
   * in the rail: the rail tile is 34px square, where every real customer logo
   * we have been sent becomes a smear. So a branded workspace shows the image
   * in the sidebar and the `mark` letter in the rail, and both are theirs.
   */
  logoUrl?: string
  /** Primary brand colour: active nav rows, the rail mark, avatars. */
  accent?: string
  /** Hover state for the accent. Falls back to the accent itself. */
  accentHover?: string
  /**
   * Text drawn ON the accent. Omit and it is chosen by luminance — a customer
   * picking a pale accent otherwise gets white-on-pale active rows, which is
   * the single most common way a white-label palette becomes unreadable.
   */
  accentFg?: string
  /** The module sidebar's background. */
  sidebarBg?: string
  /** The app rail's background. Defaults to a shade darker than the sidebar. */
  railBg?: string
}

export const ERP_DEFAULT_BRAND: Required<Pick<ErpBrand, 'mark'>> & ErpBrand = {
  mark: 'E.',
}

/**
 * Black or white, whichever is readable on `hex`.
 *
 * Relative luminance per WCAG, not a naive average: #FFFF00 and #0000FF have
 * nearly the same mean channel value and opposite answers.
 */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#ffffff'
  const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]
  const ch = [0, 2, 4].map(i => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  // 0.179 is the crossover where contrast against white and against black are
  // equal (both 4.5:1). Above it, black wins.
  return lum > 0.179 ? '#0a0d14' : '#ffffff'
}

/**
 * A brand as inline custom properties, for the element that wraps the chrome.
 *
 * Inline rather than a generated stylesheet because the brand is per
 * organisation and the shell renders on the server: a `<style>` block would
 * either be cached across tenants or force the layout dynamic. Unset fields are
 * omitted entirely so the stylesheet's own defaults apply — writing `undefined`
 * into a custom property clears it instead of falling through.
 */
export function brandVars(brand: ErpBrand | null | undefined): CSSProperties {
  const vars: Record<string, string> = {}
  if (!brand) return vars as CSSProperties

  if (brand.accent) {
    vars['--erp-accent'] = brand.accent
    vars['--erp-accent-hover'] = brand.accentHover ?? brand.accent
    vars['--erp-accent-fg'] = brand.accentFg ?? readableOn(brand.accent)
  }
  if (brand.sidebarBg) {
    vars['--erp-sidebar-bg'] = brand.sidebarBg
    // A customer who sets only the sidebar gets a rail that matches it rather
    // than our default near-black beside their colour.
    vars['--erp-rail-bg'] = brand.railBg ?? brand.sidebarBg
  }
  if (brand.railBg) vars['--erp-rail-bg'] = brand.railBg

  return vars as CSSProperties
}

/** The rail mark, trimmed to what actually fits in a 34px tile. */
export function brandMark(brand: ErpBrand | null | undefined): string {
  const mark = brand?.mark?.trim()
  return mark ? mark.slice(0, 2) : ERP_DEFAULT_BRAND.mark
}
