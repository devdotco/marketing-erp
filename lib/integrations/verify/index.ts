import type { KeyVerifier } from "./types";
import { VERIFIERS as SEO_CONTENT } from "./seo-content";
import { VERIFIERS as OUTBOUND } from "./outbound";
import { VERIFIERS as SEARCH_ATLAS } from "./searchatlas";
import { VERIFIERS as PAYLOAD } from "./payload";
import { VERIFIERS as CRM } from "./crm";
import { VERIFIERS as IMAGES } from "./images";
import { VERIFIERS as VOICE } from "./voice";
import { VERIFIERS as ANSWER_ENGINES } from "./answer-engines";

/** Every key verifier, by provider. Anthropic's lives in lib/ai/client.ts. */
export const KEY_VERIFIERS: Partial<Record<string, KeyVerifier>> = { ...SEO_CONTENT, ...OUTBOUND, ...SEARCH_ATLAS, ...PAYLOAD, ...CRM, ...IMAGES, ...VOICE, ...ANSWER_ENGINES };
