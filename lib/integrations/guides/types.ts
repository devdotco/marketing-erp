/**
 * Shared shape for the customer-facing "soup to nuts" setup guide behind
 * every integration's Connect page and the Integrations list.
 *
 * Client-safe: no server imports. Both lib/integrations/guides/oauth-cms.ts
 * (Google/Microsoft/Meta OAuth + the CMS providers) and
 * lib/integrations/guides/keys.ts (the API-key providers) implement this
 * same type so they can merge into one SETUP_GUIDES table in
 * lib/integrations/guides/index.ts.
 */

/** One numbered step. Plain text — `**bold**` and `[label](https://…)` links are rendered by SetupGuide.tsx. */
export type SetupGuideStep = {
  title: string;
  body: string;
  /** Not used yet — reserved so a future screenshot doesn't require a type change. */
  image?: never;
};

export type SetupGuideTroubleshootingEntry = {
  symptom: string;
  fix: string;
};

export type SetupGuideDocLink = {
  label: string;
  /** Must be https. */
  url: string;
};

export type SetupGuide = {
  /** The CONNECT_METHODS key, e.g. "GOOGLE_SEARCH_CONSOLE". */
  provider: string;
  /** 1–2 sentences: what connecting does and what agents gain. No pricing figures. */
  summary: string;
  /** Rough end-to-end time for a first-time, non-technical marketer. */
  timeMinutes: number;
  /** Accounts, plan tier, role/permission needed before starting — shown as a checklist. */
  youWillNeed: string[];
  /** At least 3 for the content test to pass. */
  steps: SetupGuideStep[];
  /** How to confirm the connection actually worked, inside this app. */
  verify: string[];
  /** At least 2 for the content test to pass. */
  troubleshooting: SetupGuideTroubleshootingEntry[];
  /** What we access (read vs write), and how to revoke — at the vendor and via Disconnect here. */
  privacy: string;
  /** At least 1, and every url must be https. */
  docs: SetupGuideDocLink[];
};
