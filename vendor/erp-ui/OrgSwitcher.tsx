/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { Building2, ChevronDown } from 'lucide-react'

export type ErpOrg = { id: string; name: string }

/**
 * Which organisation's data is on screen.
 *
 * Presentational: the caller owns the switch, because every module persists it
 * differently (the shell POSTs to its own endpoint, accounting POSTs to a
 * `switchEndpoint` it is handed, and a module with one organisation has nothing
 * to persist at all).
 *
 * A single organisation renders as a static label, not a dead dropdown — the
 * chevron is a promise that there is somewhere else to go.
 */
export function OrgSwitcher({
  orgs, currentOrgId, onSwitch,
}: {
  orgs: ErpOrg[]
  currentOrgId: string | null
  onSwitch: (orgId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = orgs.find(o => o.id === currentOrgId) ?? orgs[0] ?? null

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const only = orgs.length <= 1

  return (
    <div className="erp-org" ref={ref}>
      <button
        type="button"
        className="erp-org-btn"
        disabled={only}
        aria-haspopup={only ? undefined : 'listbox'}
        aria-expanded={only ? undefined : open}
        onClick={() => setOpen(o => !o)}
      >
        <Building2 size={13} className="erp-org-icon" />
        <span className="erp-org-name">{current?.name ?? 'No organisation'}</span>
        {!only && <ChevronDown size={13} className="erp-org-icon" />}
      </button>

      {open && !only && (
        <div className="erp-org-menu" role="listbox">
          {orgs.map(org => (
            <button
              key={org.id}
              type="button"
              role="option"
              aria-selected={org.id === current?.id}
              className={`erp-org-item${org.id === current?.id ? ' is-active' : ''}`}
              onClick={() => { setOpen(false); if (org.id !== current?.id) onSwitch(org.id) }}
            >
              {org.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
