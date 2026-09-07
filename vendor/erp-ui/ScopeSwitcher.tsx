/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Globe } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type ErpScope = { id: string; name: string; hint?: string }

/**
 * The SECOND switcher: which property inside this organization.
 *
 * The suite has two levels of tenancy and they were being conflated. Level one
 * is the organization — a legal entity, the thing accounting keeps books for,
 * and there are three or four of them. Level two is a brand, domain or site
 * INSIDE one, and there are dozens; Phony's own schema says it plainly:
 * "one workspace can run a dozen brands".
 *
 * Modules that only work at level one (accounting) pass nothing here. Modules
 * that work at level two (phony's properties, marketing's brands) render this
 * directly beneath the organization, so the two questions are asked in the
 * order they nest — never merged into one list, which hides that they are
 * different kinds of thing.
 *
 * Deliberately quieter than the org switcher above it: same shape, no border,
 * so it reads as a refinement of the row above rather than a peer of it.
 */
export function ScopeSwitcher({
  scopes, currentScopeId, onSelect, icon: Icon = Globe, label = 'All',
}: {
  scopes: ErpScope[]
  currentScopeId: string | null
  onSelect: (scopeId: string) => void
  /** Defaults to a globe, which reads as "site". Pass the module's own glyph. */
  icon?: LucideIcon
  /** Shown when nothing is selected — "All sites", "All brands". */
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = scopes.find(s => s.id === currentScopeId) ?? null

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!scopes.length) return null

  return (
    <div className="erp-org erp-scope" ref={ref}>
      <button
        type="button"
        className="erp-org-btn erp-scope-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Icon size={12} className="erp-org-icon" />
        <span className="erp-org-name">{current?.name ?? label}</span>
        <ChevronDown size={12} className="erp-org-icon" />
      </button>

      {open && (
        <div className="erp-org-menu" role="listbox">
          {scopes.map(scope => (
            <button
              key={scope.id}
              type="button"
              role="option"
              aria-selected={scope.id === currentScopeId}
              className={`erp-org-item${scope.id === currentScopeId ? ' is-active' : ''}`}
              onClick={() => { setOpen(false); onSelect(scope.id) }}
            >
              {scope.name}
              {scope.hint && <span className="erp-scope-hint">{scope.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
