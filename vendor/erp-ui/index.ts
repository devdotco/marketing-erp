/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
/**
 * erp.io shared suite chrome.
 *
 * VENDORED — do not edit a copy of this directory. The source of truth is
 * `app-erp-io/packages/erp-ui`; every other repo holds a synced copy and
 * `node scripts/sync-erp-ui.mjs --check` fails on a local edit. Change it
 * there, sync, and deploy the modules you changed.
 */
export { AppShell } from './AppShell'
export { AgentDock } from './AgentDock'
export { startersFor, STARTER_QUESTIONS } from './starter-questions'
export { useErpChromeClose } from './chrome-context'
export { AppRail, buildRailItems, type ErpRailItem } from './AppRail'
export { ModuleSidebar, type ErpNavItem, type ErpNavSection } from './ModuleSidebar'
export { OrgSwitcher, type ErpOrg } from './OrgSwitcher'
export { ScopeSwitcher, type ErpScope } from './ScopeSwitcher'
export {
  brandVars, brandMark, readableOn, ERP_DEFAULT_BRAND, type ErpBrand,
} from './brand'
export {
  ERP_MODULES, ERP_MODULE_KEYS, erpModule, SHELL_URL,
  type ErpModule, type ErpModuleKey,
} from './registry'
export { ERP_MODULE_ICONS } from './icons'
export {
  fetchModuleLinks,
  type ErpLinkedRecord,
  type ErpLinkResponse,
} from './module-links'
