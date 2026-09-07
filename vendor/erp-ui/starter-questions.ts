/* GENERATED — DO NOT EDIT.
 * Synced from app-erp-io/packages/erp-ui by scripts/sync-erp-ui.mjs.
 * Edit the source there and re-run the script; edits here are reverted and
 * fail `sync-erp-ui.mjs --check`.
 */
import type { ErpModuleKey } from './registry'

/**
 * What to ask, per module.
 *
 * STATIC, not generated. Generating openers would mean an API call before the
 * person has asked anything — paying to guess at a question they are about to
 * type. These also do a second job: they say what the assistant can actually
 * answer, which is the fastest way to stop someone asking it to do something it
 * cannot.
 *
 * Keep them answerable from records. "What did we sign with Acme" is a lookup;
 * "how is the business doing" is not, and offering it teaches the wrong thing.
 */
export const STARTER_QUESTIONS: Partial<Record<ErpModuleKey | 'home', string[]>> = {
  home: [
    'What needs my attention today?',
    'What has changed this week?',
  ],
  sign: [
    'Which documents are still awaiting signature?',
    'What did we sign most recently?',
  ],
  crm: [
    'Which contacts have open agreements?',
    'What happened with this account recently?',
  ],
  pm: [
    'What is overdue across my projects?',
    'What did my team finish this week?',
  ],
  finance: [
    'What is unreconciled right now?',
    'Which invoices are overdue?',
  ],
  legal: [
    'Which matters are waiting on me?',
  ],
  messaging: [
    'What did I miss in my channels?',
  ],
}

export function startersFor(moduleKey: string | undefined): string[] {
  return STARTER_QUESTIONS[(moduleKey ?? 'home') as ErpModuleKey | 'home'] ?? STARTER_QUESTIONS.home ?? []
}
