/**
 * SETUP_GUIDES: every provider's customer-facing setup guide, keyed by the
 * same CONNECT_METHODS provider key (lib/integrations/catalog.ts).
 *
 * Merges the OAuth/CMS guides (oauth-cms.ts) with the API-key guides
 * (keys.ts) — the two are owned and edited separately, on purpose, so this
 * file is the only place that needs to know both exist.
 *
 * Client-safe: no server imports.
 */
import type { SetupGuide } from "./types";
import { OAUTH_CMS_SETUP_GUIDES } from "./oauth-cms";
import { KEY_SETUP_GUIDES } from "./keys";

export const SETUP_GUIDES: Partial<Record<string, SetupGuide>> = {
  ...OAUTH_CMS_SETUP_GUIDES,
  ...KEY_SETUP_GUIDES,
};

export type { SetupGuide, SetupGuideStep, SetupGuideTroubleshootingEntry, SetupGuideDocLink } from "./types";
