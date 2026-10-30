/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
'use client'

import { useState, useRef, useEffect } from 'react'
import { MessageSquare, X, CornerDownLeft, Loader2, Plus } from 'lucide-react'
import { SHELL_URL } from './registry'
import { startersFor } from './starter-questions'

type Source = { module: string; title: string; url: string }
type Turn = { role: 'you' | 'assistant'; text: string; sources?: Source[] }

/**
 * The suite assistant, bottom right of every module.
 *
 * The widget ships in the shared package; the API lives ONLY in the shell. That
 * split is deliberate: keys, spend caps and the corpus fan-out are handled in
 * one place rather than eleven, so there is one implementation to audit and one
 * place a key could leak from — instead of eleven.
 *
 * It posts to the shell across the shared origin with credentials, which is
 * what lets the shell read the caller's session and, through it, ask each
 * module what that person can see.
 */
export function AgentDock({ moduleKey }: { moduleKey?: string }) {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Brigham when the org has it (the shell then answers through Brigham), otherwise the suite assistant.
  const [name, setName] = useState('Assistant')
  // Brigham keeps the thread: follow-ups continue the same Brigham conversation.
  const [conversationId, setConversationId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const starters = startersFor(moduleKey)

  useEffect(() => {
    if (!open) return
    let live = true
    fetch(`${SHELL_URL}/api/shell/agent/ask`, { credentials: 'include', cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { assistant?: string } | null) => { if (live && d?.assistant) setName(d.assistant) })
      .catch(() => {})
    return () => { live = false }
  }, [open])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns, busy])

  async function ask(question: string) {
    const q = question.trim()
    if (!q || busy) return
    setDraft('')
    setError(null)
    setTurns(t => [...t, { role: 'you', text: q }])
    setBusy(true)

    try {
      const res = await fetch(`${SHELL_URL}/api/shell/agent/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The shell needs the caller's cookies to answer as them.
        credentials: 'include',
        body: JSON.stringify({ question: q, module: moduleKey, conversationId }),
      })
      const data = (await res.json()) as { answer?: string; sources?: Source[]; error?: string; assistant?: string; conversationId?: string }
      if (data.assistant) setName(data.assistant)
      if (data.conversationId) setConversationId(data.conversationId)

      if (!res.ok || !data.answer) {
        // A budget refusal is the one error worth reading in full — it tells
        // an admin exactly what to do next.
        setError(data.error ?? 'The assistant could not answer that just now.')
        return
      }
      setTurns(t => [...t, { role: 'assistant', text: data.answer!, sources: data.sources }])
    } catch {
      setError('Could not reach the assistant.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button className="erp-dock-fab" onClick={() => setOpen(true)} aria-label={`Ask ${name}`}>
        <MessageSquare size={18} />
      </button>
    )
  }

  return (
    <div className="erp-dock" role="dialog" aria-label={name}>
      <div className="erp-dock-head">
        <span className="erp-dock-title">{name}</span>
        {turns.length > 0 && (
          <button className="erp-dock-close" onClick={() => { setTurns([]); setConversationId(null); setError(null) }} aria-label="New conversation" title="New conversation" style={{ marginLeft: 'auto' }}>
            <Plus size={15} />
          </button>
        )}
        <button className="erp-dock-close" onClick={() => setOpen(false)} aria-label={`Close ${name}`}>
          <X size={15} />
        </button>
      </div>

      <div className="erp-dock-body" ref={scrollRef}>
        {turns.length === 0 && (
          <>
            <p className="erp-dock-hint">
              {name === 'Brigham'
                ? 'Ask Brigham anything, or tell him what to do: your pipeline, email, calendar, tasks, standing orders. He sees only what you can see.'
                : 'Ask about what you can see across the suite. Answers come from your own records — nothing you do not already have access to.'}
            </p>
            {starters.map(s => (
              <button key={s} className="erp-dock-starter" onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </>
        )}

        {turns.map((t, i) => (
          <div key={i} className={`erp-dock-turn is-${t.role}`}>
            <div className="erp-dock-text">{t.role === 'assistant' ? <Rich text={t.text} /> : t.text}</div>
            {t.sources && t.sources.length > 0 && (
              <div className="erp-dock-sources">
                {/* Shown so an answer can be checked rather than trusted. */}
                {t.sources.map(s => (
                  <a key={s.url} href={s.url} className="erp-dock-source">
                    {s.module}: {s.title}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}

        {busy && (
          <div className="erp-dock-turn is-assistant">
            <Loader2 size={14} className="erp-dock-spin" />
          </div>
        )}
        {error && <p className="erp-dock-error">{error}</p>}
      </div>

      <form
        className="erp-dock-form"
        onSubmit={e => {
          e.preventDefault()
          void ask(draft)
        }}
      >
        <input
          className="erp-dock-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder={name === 'Brigham' ? 'Ask Brigham…' : 'Ask about your records…'}
          disabled={busy}
          aria-label="Your question"
        />
        <button className="erp-dock-send" type="submit" disabled={busy || !draft.trim()} aria-label="Send">
          <CornerDownLeft size={15} />
        </button>
      </form>
    </div>
  )
}

/**
 * Just enough Markdown for chat answers: **bold**, `code`, and line breaks
 * (lists and tables stay as their plain-text lines). Built from React
 * elements, never innerHTML, so answer text cannot inject markup.
 */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <span key={i} style={{ display: 'block', minHeight: line ? undefined : '0.6em' }}>
          {line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, j) =>
            part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={j}>{part.slice(2, -2)}</strong>
              : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={j}>{part.slice(1, -1)}</code>
                : part,
          )}
        </span>
      ))}
    </>
  )
}
