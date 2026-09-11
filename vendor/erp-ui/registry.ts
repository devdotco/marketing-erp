/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
/**
 * The suite, as the chrome needs to know it.
 *
 * Every module used to carry its own copy of this list inside its rail, and
 * every copy was different: accounting's named nine applications and omitted
 * sign, canvas, legal and plm; crm's still pointed at `crm.erp.io`, a host that
 * now 308s; three modules had no rail at all. Whichever module you were in, the
 * suite appeared to be a different size.
 *
 * This is deliberately the PRESENTATION half of the registry — key, label,
 * order, default URL. The shell's `lib/shell/modules.ts` keeps the half that is
 * nobody else's business: `sso`, `ssoCallbackPath`, entitlement descriptions.
 * The two are checked against each other by `scripts/sync-erp-ui.mjs --check`,
 * so a module added to one and not the other fails the check rather than
 * quietly vanishing from the rail — which is exactly how `plm` spent months
 * unreachable.
 *
 * Order is append-only. People navigate the rail by position, so a new module
 * goes at the end rather than into the group it reads best beside.
 */
export type ErpModuleKey =
  | 'finance' | 'crm' | 'pm' | 'marketing' | 'sdr' | 'messaging' | 'portal'
  | 'plm' | 'sign' | 'cfo' | 'canvas' | 'pey' | 'legal'

export type ErpModule = {
  key: ErpModuleKey
  /** What the product is called today. Several keys are historical and do not
   *  match: `finance` is Accounting, `sdr` is Phony, `messaging` is Chat. */
  label: string
  /** Fallback only. Hosts move; a caller that knows better passes its own. */
  url: string
  /** `false` means the hostname does not answer, so it gets no rail button. */
  live: boolean
}

export const ERP_MODULES: readonly ErpModule[] = [
  { key: 'finance',   label: 'Accounting',    url: 'https://app.erp.io/accounting', live: true  },
  { key: 'crm',       label: 'CRM',           url: 'https://app.erp.io/crm',        live: true  },
  { key: 'pm',        label: 'Projects',      url: 'https://app.erp.io/pm',         live: true  },
  { key: 'marketing', label: 'Marketing',     url: 'https://app.erp.io/marketing',  live: true  },
  { key: 'sdr',       label: 'Phony',         url: 'https://app.erp.io/phony',          live: true  },
  { key: 'messaging', label: 'Chat',          url: 'https://app.erp.io/chat',           live: true  },
  { key: 'portal',    label: 'Client Portal', url: 'https://portal.erp.io',         live: true  },
  { key: 'plm',       label: 'PLM',           url: 'https://app.erp.io/plm',            live: true  },
  { key: 'sign',      label: 'Sign',          url: 'https://app.erp.io/sign',           live: true  },
  { key: 'cfo',       label: 'CFO',           url: 'https://app.erp.io/cfo',        live: true  },
  { key: 'canvas',    label: 'Canvas',        url: 'https://app.erp.io/canvas',     live: true  },
  { key: 'pey',       label: 'Pey',           url: 'https://app.erp.io/pey',        live: true  },
  { key: 'legal',     label: 'Legal',         url: 'https://app.erp.io/legal',      live: true  },
]

export const ERP_MODULE_KEYS: readonly ErpModuleKey[] = ERP_MODULES.map(m => m.key)

export function erpModule(key: string): ErpModule | undefined {
  return ERP_MODULES.find(m => m.key === key)
}

/** The shell URL, which owns the session and every account-level page. */
export const SHELL_URL =
  process.env.NEXT_PUBLIC_SHELL_URL ?? 'https://app.erp.io'
