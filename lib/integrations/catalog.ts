/**
 * How each integration is connected — the one table the Integrations list, the
 * connect page and the connect API all read.
 *
 * It exists because those three drifted: the list offered "Connect" on every
 * provider while the connect page knew five of them, so Search Console,
 * WordPress, Cartesia and the rest all landed on "Unknown provider". A provider
 * with no entry here now gets no Connect button, rather than a dead end.
 *
 * Field names are the exact keys the agent handlers decrypt — change one here
 * and the handler that reads it silently goes back to simulated data.
 *
 * Client-safe: no server imports.
 */

export type CredentialField = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  hint?: string;
  /** Defaults to true. Set false for a field normaliseKeyCredentials defaults on its own (e.g. Storyblok region). */
  required?: boolean;
};

export type ConnectMethod =
  | { kind: "key"; fields: CredentialField[] }
  | { kind: "google"; scopes: string[] }
  | { kind: "microsoft"; scopes: string[] }
  | { kind: "meta"; scopes: string[] };

const apiKey = (hint?: string): CredentialField[] => [
  { key: "apiKey", label: "API key", placeholder: "Paste your API key…", secret: true, hint },
];

export const CONNECT_METHODS: Partial<Record<string, { name: string; method: ConnectMethod }>> = {
  ANTHROPIC: { name: "Anthropic", method: { kind: "key", fields: apiKey() } },
  APOLLO: {
    name: "Apollo.io",
    method: {
      kind: "key",
      fields: apiKey(
        "Settings → Integrations → API in Apollo. Prospect search (Outbound Scout) needs the key to have the Master API Key permission, and requires Apollo's Professional plan or higher — a regular key without it will fail at search time even though it verifies here.",
      ),
    },
  },
  INSTANTLY: {
    name: "Instantly",
    method: {
      kind: "key",
      fields: apiKey(
        "Settings → Integrations → API Keys in Instantly — generate a v2 key; v1 keys are rejected by the endpoints this integration calls. Requires Instantly's Growth plan or higher.",
      ),
    },
  },
  AIMFOX: {
    name: "Aimfox",
    method: {
      kind: "key",
      fields: apiKey(
        "Integrations → API in Aimfox. Use a key with \"All\" permission, not Read-only — Outbound LinkedIn needs to add leads to a campaign.",
      ),
    },
  },
  CARTESIA: { name: "Cartesia", method: { kind: "key", fields: apiKey() } },
  TRANSISTOR: { name: "Transistor", method: { kind: "key", fields: apiKey() } },
  GOOGLE_TTS: {
    name: "Google Text-to-Speech (Gemini)",
    method: {
      kind: "key",
      fields: apiKey(
        "A Gemini API key from Google AI Studio (aistudio.google.com/apikey) — not a Google Cloud service account. The Podcast agent uses it only to voice episode scripts, as an alternative to Cartesia. The same key you use for Google Images works here too.",
      ),
    },
  },
  AHREFS: { name: "Ahrefs", method: { kind: "key", fields: apiKey() } },
  SEMRUSH: { name: "Semrush", method: { kind: "key", fields: apiKey() } },
  SEARCH_ATLAS: {
    name: "SearchAtlas",
    method: {
      kind: "key",
      fields: apiKey(
        "Dashboard → Settings → API Settings in SearchAtlas (dashboard.searchatlas.com/settings?active_section=api). Topic ideas (Topical Authority Map) and content-gap analysis (Keyword Gap Analysis) both consume SearchAtlas's own AI/data credits per run — check your plan's credit balance before running these on a large cadence.",
      ),
    },
  },
  MAILCHIMP: {
    name: "Mailchimp",
    method: {
      kind: "key",
      fields: apiKey("The data-center suffix on the key (e.g. -us21) is read automatically."),
    },
  },
  CRM_ERP_IO: {
    name: "erp.io CRM",
    method: {
      kind: "key",
      fields: [
        {
          key: "crmUrl",
          label: "CRM URL",
          placeholder: "https://app.erp.io/crm",
          hint: "The erp.io CRM instance this workspace's campaigns enroll into. Leave blank to use https://app.erp.io/crm — the CRM moved there from crm.erp.io, which now redirects.",
          required: false,
        },
        {
          key: "apiKey",
          label: "API key",
          placeholder: "Paste the marketing API key…",
          secret: true,
          hint: "Super-admin fallback only, for a workspace with no erp.io organization. Workspaces tied to an organization link automatically and need no key. Create a per-tenant key in the CRM with `npm run marketing:create-key`.",
        },
      ],
    },
  },
  KLAVIYO: {
    name: "Klaviyo",
    method: {
      kind: "key",
      fields: apiKey("Settings → API Keys → Create Private API Key, with Campaigns read/write access."),
    },
  },
  CLOUDFLARE_LOGPUSH: {
    name: "Cloudflare Logpush",
    method: {
      kind: "key",
      fields: [
        {
          key: "hosts",
          label: "Site hostnames",
          placeholder: "example.com, blog.example.com",
          hint: "The hostnames this workspace owns, comma separated. Log lines for any other host are ignored, so one Cloudflare account pushing a whole zone cannot attribute another site's traffic here. Leave blank to accept every host in the job.",
        },
      ],
    },
  },
  OPENAI: {
    name: "OpenAI",
    method: {
      kind: "key",
      fields: apiKey(
        "platform.openai.com/api-keys. Used to capture what GPT says about you for AI Search Visibility. It is the model behind ChatGPT, not the ChatGPT app itself — the app adds its own prompt and memory on top, so treat this as a close proxy rather than the consumer product.",
      ),
    },
  },
  GOOGLE_GEMINI: {
    name: "Google Gemini",
    method: {
      kind: "key",
      fields: apiKey(
        "aistudio.google.com/apikey. Used to capture what Gemini says about you, grounded with Google Search — the same grounding behind AI Overviews.",
      ),
    },
  },
  PERPLEXITY: {
    name: "Perplexity",
    method: {
      kind: "key",
      fields: apiKey(
        "perplexity.ai/settings/api. Used to capture what Perplexity says about you. It is a search product first, so its answers carry the most complete citations of any engine we measure.",
      ),
    },
  },
  OPENAI_IMAGES: {
    name: "OpenAI Images",
    method: {
      kind: "key",
      fields: apiKey(
        "platform.openai.com/api-keys. Blog Writer uses this only to generate the AI images it asks for — it never touches any other OpenAI product.",
      ),
    },
  },
  GOOGLE_IMAGES: {
    name: "Google Images (Gemini)",
    method: {
      kind: "key",
      fields: apiKey(
        "An API key from Google AI Studio (aistudio.google.com/apikey) — not a Google Cloud service account. Blog Writer uses this only to generate the AI images it asks for.",
      ),
    },
  },
  WORDPRESS: {
    name: "WordPress",
    method: {
      kind: "key",
      fields: [
        { key: "siteUrl", label: "Site URL", placeholder: "https://example.com" },
        { key: "username", label: "Username", placeholder: "WordPress username" },
        {
          key: "applicationPassword",
          label: "Application password",
          placeholder: "xxxx xxxx xxxx xxxx xxxx xxxx",
          secret: true,
          hint: "Users → Profile → Application Passwords in wp-admin. Not your login password.",
        },
      ],
    },
  },
  STORYBLOK: {
    name: "Storyblok",
    method: {
      kind: "key",
      fields: [
        { key: "spaceId", label: "Space ID", placeholder: "e.g. 287881", hint: "Settings → General in your Storyblok space." },
        {
          key: "managementToken",
          label: "Personal access token",
          placeholder: "Paste your personal access token…",
          secret: true,
          hint: "My account → Personal access tokens. Needs access to the space above. On-site Publisher creates stories under a \"blog_post\" component — create one with title/body/meta_title/meta_description fields if it doesn't exist yet.",
        },
        {
          key: "region",
          label: "Region",
          placeholder: "eu (default), us, ca, ap, or cn",
          hint: "Which regional API your space was created in — check the space URL in the Storyblok app. Leave blank for EU.",
          required: false,
        },
      ],
    },
  },
  WEBFLOW: {
    name: "Webflow",
    method: {
      kind: "key",
      fields: [
        { key: "siteId", label: "Site ID", placeholder: "e.g. 63f6b52...", hint: "Site settings → General → Site ID." },
        {
          key: "collectionId",
          label: "Collection ID",
          placeholder: "e.g. 63f6b52...",
          hint: "The CMS collection On-site Publisher creates items in — needs Name, Slug, and a rich-text \"post-body\" field.",
        },
        {
          key: "apiToken",
          label: "API token",
          placeholder: "Paste your site API token…",
          secret: true,
          hint: "Site settings → Apps & integrations → API access. Needs sites:read and cms:write.",
        },
      ],
    },
  },
  PAYLOAD: {
    name: "Payload CMS",
    method: {
      kind: "key",
      fields: [
        {
          key: "baseUrl",
          label: "Payload base URL",
          placeholder: "https://payload.example.com",
          hint: "The origin your Payload instance is hosted at — no trailing slash or path.",
        },
        {
          key: "apiKey",
          label: "API key",
          placeholder: "Paste your API key…",
          secret: true,
          hint: "On the API user's edit form in Payload, tick Enable API Key and copy the key (the \"API\" tab on a user's page is a JSON viewer, not the key). Requires useAPIKey enabled on the Auth collection.",
        },
        {
          key: "authCollection",
          label: "Auth collection slug",
          placeholder: "users",
          hint: "The auth-enabled collection the API key belongs to — sent as `<slug> API-Key <key>` in the Authorization header. Defaults to users.",
          required: false,
        },
        {
          key: "postsCollection",
          label: "Posts collection slug",
          placeholder: "posts",
          hint: "The collection this integration reads and publishes to. Defaults to posts.",
          required: false,
        },
        {
          key: "tenantId",
          label: "Tenant ID",
          placeholder: "e.g. 2",
          hint: "Only needed if this Payload instance uses the multi-tenant plugin and posts are scoped per tenant. Leave blank for a single-tenant site.",
          required: false,
        },
        {
          key: "siteUrl",
          label: "Public site URL",
          placeholder: "https://example.com",
          hint: "Where the posts actually live, if different from the Payload base URL above. Used to build absolute links for internal linking. Defaults to the Payload base URL.",
          required: false,
        },
        {
          key: "bodyFormat",
          label: "Body format",
          placeholder: "html or lexical",
          hint: "html — a raw HTML string field; publishing is fully supported. lexical — Payload's rich text editor format; publishing is not yet supported, but internal linking still works. Defaults to html.",
          required: false,
        },
        {
          key: "bodyField",
          label: "Body field name",
          placeholder: "bodyHtml",
          hint: "The field on the posts collection holding the article body. Defaults to bodyHtml for HTML body format, content for Lexical.",
          required: false,
        },
        {
          key: "mediaCollection",
          label: "Media collection slug",
          placeholder: "media",
          hint: "The upload-enabled collection Blog Writer uploads AI-generated images to. Defaults to media.",
          required: false,
        },
      ],
    },
  },
  GOOGLE_SEARCH_CONSOLE: {
    name: "Google Search Console",
    method: { kind: "google", scopes: ["https://www.googleapis.com/auth/webmasters.readonly"] },
  },
  GOOGLE_ANALYTICS_4: {
    name: "Google Analytics 4",
    method: { kind: "google", scopes: ["https://www.googleapis.com/auth/analytics.readonly"] },
  },
  GOOGLE_BUSINESS_PROFILE: {
    name: "Google Business Profile",
    // business.manage is the only scope Google offers for GBP — it covers both
    // reading and writing (posts, review replies), there is no readonly split.
    method: { kind: "google", scopes: ["https://www.googleapis.com/auth/business.manage"] },
  },
  GOOGLE_ADS: {
    name: "Google Ads",
    method: { kind: "google", scopes: ["https://www.googleapis.com/auth/adwords"] },
  },
  GMAIL: {
    name: "Gmail",
    // gmail.readonly + gmail.compose — not gmail.modify or mail.google.com — is
    // the least-privilege pair that still does what Inbox Responder / Outreach
    // need (list+read unread mail, create reply drafts) and never sends.
    // gmail.metadata is narrower still but Google documents that it does NOT
    // support the `q=` search param the handlers filter with (is:unread,
    // in:sent), so it was rejected. Every scope capable of drafts.create is a
    // Google RESTRICTED scope — see lib/integrations/google.ts for what that
    // means for production use.
    method: {
      kind: "google",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
    },
  },
  MICROSOFT_365: {
    name: "Microsoft 365",
    // Mail.ReadWrite covers list/read AND draft create/update — a superset of
    // Mail.Read — with no send capability. Delegated, no admin consent needed.
    method: {
      kind: "microsoft",
      scopes: ["offline_access", "https://graph.microsoft.com/Mail.ReadWrite"],
    },
  },
  META: {
    name: "Meta",
    // pages_show_list + pages_read_engagement let the connect flow enumerate
    // and pick a Page; pages_manage_posts publishes to its feed; the
    // instagram_* pair does the same for a linked Instagram Business account.
    // All five need Meta App Review (Advanced Access) before anyone outside
    // the app's own admins/testers/developers can grant them.
    method: {
      kind: "meta",
      scopes: [
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_posts",
        "instagram_basic",
        "instagram_content_publish",
      ],
    },
  },
};

/** URL slug ↔ enum. The list page links with the lowercased enum value. */
export function providerFromSlug(slug: string): string | null {
  const provider = slug.toUpperCase();
  return CONNECT_METHODS[provider] ? provider : null;
}

/**
 * Normalise what a key form submitted into the shape the handlers decrypt.
 * Returns an error string for anything missing, so the form can say which.
 */
export function normaliseKeyCredentials(
  provider: string,
  input: Record<string, unknown>,
): { ok: true; credentials: Record<string, string> } | { ok: false; error: string } {
  const entry = CONNECT_METHODS[provider];
  if (!entry || entry.method.kind !== "key") return { ok: false, error: "Unsupported provider" };

  const credentials: Record<string, string> = {};
  for (const field of entry.method.fields) {
    const value = typeof input[field.key] === "string" ? (input[field.key] as string).trim() : "";
    if (!value && field.required !== false) return { ok: false, error: `${field.label} is required` };
    credentials[field.key] = value;
  }

  if (provider === "WORDPRESS") {
    let url: URL;
    try {
      url = new URL(credentials.siteUrl);
    } catch {
      return { ok: false, error: "Site URL must be a full URL, like https://example.com" };
    }
    if (url.protocol !== "https:") return { ok: false, error: "Site URL must use https" };
    credentials.siteUrl = url.origin + url.pathname.replace(/\/+$/, "");
  }

  if (provider === "MAILCHIMP") {
    // Mailchimp keys end in their data center ("…-us21"); the API host needs it.
    const server = credentials.apiKey.split("-").pop() ?? "";
    if (!/^[a-z]+\d+$/.test(server)) {
      return { ok: false, error: "That doesn't look like a Mailchimp key — it should end in a data center like -us21" };
    }
    credentials.server = server;
  }

  if (provider === "CRM_ERP_IO") {
    if (credentials.crmUrl) {
      let url: URL;
      try {
        url = new URL(credentials.crmUrl);
      } catch {
        return { ok: false, error: "CRM URL must be a full URL, like https://app.erp.io/crm" };
      }
      if (url.protocol !== "https:") return { ok: false, error: "CRM URL must use https" };
      credentials.crmUrl = url.origin + url.pathname.replace(/\/+$/, "");
    } else {
      credentials.crmUrl = "https://app.erp.io/crm";
    }
  }

  if (provider === "STORYBLOK") {
    const region = credentials.region.toLowerCase() || "eu";
    if (!STORYBLOK_REGIONS.has(region)) {
      return { ok: false, error: "Region must be one of eu, us, ca, ap, cn — or left blank for eu" };
    }
    credentials.region = region;
  }

  if (provider === "PAYLOAD") {
    let base: URL;
    try {
      base = new URL(credentials.baseUrl);
    } catch {
      return { ok: false, error: "Payload base URL must be a full URL, like https://payload.example.com" };
    }
    if (base.protocol !== "https:") return { ok: false, error: "Payload base URL must use https" };
    credentials.baseUrl = base.origin;

    credentials.authCollection = (credentials.authCollection || "users").toLowerCase();
    credentials.postsCollection = (credentials.postsCollection || "posts").toLowerCase();

    const bodyFormat = (credentials.bodyFormat || "html").toLowerCase();
    if (bodyFormat !== "html" && bodyFormat !== "lexical") {
      return { ok: false, error: "Body format must be html or lexical" };
    }
    credentials.bodyFormat = bodyFormat;
    credentials.bodyField = credentials.bodyField || (bodyFormat === "lexical" ? "content" : "bodyHtml");
    credentials.mediaCollection = (credentials.mediaCollection || "media").toLowerCase();

    if (credentials.siteUrl) {
      try {
        credentials.siteUrl = new URL(credentials.siteUrl).origin + new URL(credentials.siteUrl).pathname.replace(/\/+$/, "");
      } catch {
        return { ok: false, error: "Public site URL must be a full URL, like https://example.com" };
      }
    } else {
      credentials.siteUrl = credentials.baseUrl;
    }
  }

  return { ok: true, credentials };
}

/** Storyblok's Management API is hosted per-region; the space's region never changes after creation. */
export const STORYBLOK_REGIONS = new Set(["eu", "us", "ca", "ap", "cn"]);

export function storyblokManagementBase(region: string): string {
  switch (region) {
    case "us": return "https://api-us.storyblok.com/v1";
    case "ca": return "https://api-ca.storyblok.com/v1";
    case "ap": return "https://api-ap.storyblok.com/v1";
    case "cn": return "https://app.storyblokchina.cn/v1";
    default: return "https://mapi.storyblok.com/v1";
  }
}
