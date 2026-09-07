/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
import {
  MessageSquare, CheckSquare, Users, DollarSign, Handshake, Boxes, Radar,
  FileSignature, TrendingUp, Megaphone, Share2, PenTool, CreditCard, Scale,
  type LucideIcon,
} from 'lucide-react'
import type { ErpModuleKey } from './registry'

/**
 * Module key → icon, for every surface in the suite that draws a module.
 *
 * A *total* Record on purpose: adding a module to `ERP_MODULES` without an icon
 * fails the build here, which is how you find out. The alternative — an
 * optional lookup with a fallback glyph — renders a plausible-looking gap that
 * nobody reports.
 *
 * These match the shell's own `components/shell/module-icons.ts` so the same
 * application is the same glyph wherever it is drawn. Each module's rail used
 * to pick its own: accounting drew CRM as a building, the shell drew it as a
 * handshake.
 */
export const ERP_MODULE_ICONS: Record<ErpModuleKey, LucideIcon> = {
  finance: DollarSign,
  crm: Handshake,
  pm: CheckSquare,
  marketing: Megaphone,
  sdr: Radar,
  messaging: MessageSquare,
  portal: Users,
  plm: Boxes,
  sign: FileSignature,
  cfo: TrendingUp,
  social: Share2,
  canvas: PenTool,
  pey: CreditCard,
  legal: Scale,
}
