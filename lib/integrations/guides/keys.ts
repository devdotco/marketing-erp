/**
 * Setup guides for the API-key providers (Apollo, Instantly, Aimfox,
 * GoHighLevel, Cartesia, Transistor, Ahrefs, Semrush, SearchAtlas, Mailchimp,
 * erp.io CRM, Klaviyo). Owned separately from oauth-cms.ts so the two can be
 * filled in concurrently — merged in lib/integrations/guides/index.ts.
 *
 * Every field here is written to match exactly what the connect form in
 * lib/integrations/catalog.ts asks for and what the verifier in
 * lib/integrations/verify/* checks — see those files before changing a
 * field name, a troubleshooting message, or a privacy claim here.
 *
 * Client-safe: no server imports.
 */
import type { SetupGuide } from "./types";

export const KEY_SETUP_GUIDES: Partial<Record<string, SetupGuide>> = {
  AHREFS: {
    provider: "AHREFS",
    summary:
      "Connecting Ahrefs lets Topic Planner, Keyword Research, Rank Tracker, Competitor Watch, Prospector, and Backlink Monitor pull your site's real keyword rankings and backlink data instead of asking Claude to estimate it.",
    timeMinutes: 5,
    youWillNeed: [
      "An Ahrefs account with the Owner or Admin role — only owners and admins can generate API keys",
      "A paid Ahrefs plan that includes API access — as of 2026 API access is included from the Lite plan up; the Starter plan and any free trial do not include it. Check your plan on Ahrefs' own pricing page if you're not sure which one you're on.",
    ],
    steps: [
      {
        title: "Sign in to Ahrefs",
        body: "Go to **app.ahrefs.com** and sign in as an account Owner or Admin.",
      },
      {
        title: "Open API keys",
        body: "Go to **Account settings → API keys**. If you don't see this option, your plan doesn't include API access — check your subscription first.",
      },
      {
        title: "Generate a key",
        body: "Click **Generate**, give the key a name like \"marketing-erp\", and copy the key it shows you. Ahrefs only shows the full key once — if you lose it, generate a new one.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Back in marketing-erp, go to **Settings → Integrations → Ahrefs → Connect**, paste the key into **API key**, and click **Connect**.",
      },
    ],
    verify: [
      "The connect form calls Ahrefs' free usage-limits endpoint — it costs nothing and doesn't touch your API units.",
      "A green \"Connected\" badge appears next to Ahrefs in Settings → Integrations as soon as the key checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"Ahrefs rejected that API key — check it was copied whole and hasn't expired (keys expire after 1 year).\"",
        fix: "Re-copy the key from Account settings → API keys in Ahrefs — a partial paste is the most common cause. Ahrefs keys expire automatically after a year; generate a new one if this one is old.",
      },
      {
        symptom: "You don't see \"API keys\" anywhere in Ahrefs' Account settings",
        fix: "Your Ahrefs plan doesn't include API access, or your account role isn't Owner/Admin. Ask whoever manages the Ahrefs subscription to upgrade the plan or grant you Admin.",
      },
      {
        symptom: "\"Ahrefs returned 429\" or a rate-limit-shaped error",
        fix: "Your workspace's monthly API units ran out — check usage under Account settings → API keys. Units reset on your billing date; SEO agents fall back to AI-estimated data until then.",
      },
    ],
    privacy: "Read-only. marketing-erp only pulls organic keyword and backlink data from your Ahrefs account — it never writes, deletes, or changes anything in Ahrefs. Each live agent run spends a small number of your Ahrefs API units (the same balance your plan already gives you); the connect check itself is free and costs zero units. Disconnect any time from Settings → Integrations → Ahrefs → Disconnect, or revoke the key directly in Ahrefs under Account settings → API keys — either one stops access immediately.",
    docs: [
      { label: "Ahrefs: API keys creation and management", url: "https://docs.ahrefs.com/en/api/docs/api-keys-creation-and-management" },
      { label: "Ahrefs: subscription-info / limits-and-usage (the free check we use)", url: "https://docs.ahrefs.com/en/api/reference/subscription-info/get-limits-and-usage" },
    ],
  },

  SEMRUSH: {
    provider: "SEMRUSH",
    summary:
      "Connecting Semrush lets Topic Planner, Keyword Research, Rank Tracker, Competitor Watch, Prospector, and Backlink Monitor pull your site's real keyword and backlink data instead of asking Claude to estimate it.",
    timeMinutes: 5,
    youWillNeed: [
      "A Semrush account with a Business subscription — Semrush's Standard API is only available to SEO Toolkit users on the Business plan.",
      "A separate API Units package. Upgrading to Business does not include any units — units are sold as their own add-on and your balance starts at zero until you buy a package.",
    ],
    steps: [
      {
        title: "Buy an API Units package (if you haven't)",
        body: "In Semrush, go to **Subscription info → API Units** and buy a units package if your balance is 0. Agents can't pull any data with an empty balance, even with a valid key.",
      },
      {
        title: "Open your API keys",
        body: "Click your profile icon → **My Profile → API Keys** (or the API Units tab on the Subscription Info page).",
      },
      {
        title: "Create a key",
        body: "Click **+ Create API key**, name it, and copy the value shown. Semrush only shows the full key once.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → Semrush → Connect**, paste it into **API key**, and click **Connect**.",
      },
    ],
    verify: [
      "The connect form calls Semrush's free \"count API units\" endpoint — it costs 0 units and just confirms the key is valid.",
      "A green \"Connected\" badge appears next to Semrush in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"Semrush rejected that key: ERROR ...\"",
        fix: "Re-copy the key from My Profile → API Keys — check for a stray space or a partial paste. If the key was deleted or regenerated in Semrush, generate a fresh one.",
      },
      {
        symptom: "\"Semrush returned an unexpected response\"",
        fix: "This usually means the response wasn't a plain number — try reconnecting; if it persists, check Semrush's own status page.",
      },
      {
        symptom: "The key connects fine here, but SEO agents still show simulated data",
        fix: "Your Semrush API Units balance is likely at 0. Every real lookup spends units from a balance you buy separately from your subscription — check it under Subscription info → API Units and top up.",
      },
    ],
    privacy: "Read-only. marketing-erp only pulls keyword and domain data from Semrush — it never writes or changes anything in your Semrush account. Every live lookup spends Semrush API units from the balance you purchased (the connect check itself costs 0 units). Disconnect any time from Settings → Integrations → Semrush → Disconnect, or delete the key in Semrush under My Profile → API Keys.",
    docs: [
      { label: "Semrush: API access", url: "https://developer.semrush.com/api/v4/get-started/api-access/" },
      { label: "Semrush: API unit balance", url: "https://developer.semrush.com/api/v4/get-started/api-units-balance/" },
    ],
  },

  SEARCH_ATLAS: {
    provider: "SEARCH_ATLAS",
    summary:
      "Connecting SearchAtlas gives Rank Tracker a third source of real ranking data (alongside Ahrefs and Semrush), and gives Topic Planner, Keyword Research, and Competitor Watch access to SearchAtlas's Topical Authority Map and Keyword Gap Analysis tools instead of Claude-estimated topic and gap data.",
    timeMinutes: 5,
    youWillNeed: [
      "A SearchAtlas account on a plan with API access and a working AI/data credit balance — Topical Authority Map and Keyword Gap Analysis both spend SearchAtlas's own credits every time they run, separate from your Ahrefs/Semrush usage.",
    ],
    steps: [
      {
        title: "Sign in to SearchAtlas",
        body: "Go to **dashboard.searchatlas.com** and sign in.",
      },
      {
        title: "Open API Settings",
        body: "Go to **Settings → API Settings** (dashboard.searchatlas.com/settings?active_section=api).",
      },
      {
        title: "Copy your API key",
        body: "Copy the key shown there — SearchAtlas issues one key per account rather than one you generate per app.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → SearchAtlas → Connect**, paste it into **API key**, and click **Connect**.",
      },
    ],
    verify: [
      "The connect form calls SearchAtlas's own AI-credit balance endpoint — a status check, not a data pull, so it doesn't spend any credits.",
      "A green \"Connected\" badge appears next to SearchAtlas in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"SearchAtlas rejected that API key\"",
        fix: "Re-copy the key from Dashboard → Settings → API Settings — check it was copied in full and hasn't been rotated since.",
      },
      {
        symptom: "\"SearchAtlas returned 4xx/5xx: ...\"",
        fix: "Try reconnecting. If it keeps happening, check SearchAtlas's status page — this endpoint federates across several SearchAtlas subdomains that can have independent outages.",
      },
      {
        symptom: "Topic Planner or Keyword Research runs work, but a run reports SearchAtlas failed mid-way",
        fix: "Topical Authority Map and Keyword Gap Analysis run asynchronously on SearchAtlas's side and can time out under load — this is usually transient; try the run again. If it's your credit balance instead, check it under SearchAtlas's billing/credits page and top up.",
      },
    ],
    privacy: "The connect check itself is read-only and free. Live runs are not: Topical Authority Map and Keyword Gap Analysis both consume SearchAtlas's own AI/data credits every time they run — check your plan's credit balance before turning on a heavy run cadence. marketing-erp never writes anything back into your SearchAtlas account. Disconnect any time from Settings → Integrations → SearchAtlas → Disconnect, or rotate the key in SearchAtlas under Settings → API Settings.",
    docs: [{ label: "SearchAtlas API documentation", url: "https://docs.searchatlas.com/" }],
  },

  APOLLO: {
    provider: "APOLLO",
    summary:
      "Connecting Apollo.io lets Lead Enrichment fill in company and role details for inbound leads, lets Outbound Scout search Apollo's database for new prospects, lets the Outbound Strategist enrich each prospect's company and role before scoring, and lets Email Marketing stage and send outbound sequences through Apollo as one of its delivery channels.",
    timeMinutes: 8,
    youWillNeed: [
      "An Apollo.io account on the Professional plan or higher — prospect search and API access are gated to Professional and above.",
      "A Master API Key, not a scoped key. Outbound Scout's prospect search and Email Marketing's \"add contacts to a sequence\" call both 403 without one, even though a regular key looks fine right up until that exact call.",
      "For Email Marketing's Apollo channel specifically: every recipient must already exist as a saved Contact in Apollo, and you'll need the Apollo-connected mailbox's Sender Account ID (Settings → Mailboxes in Apollo).",
    ],
    steps: [
      {
        title: "Open Apollo's API settings",
        body: "In Apollo, go to **Settings → Integrations**, then click **Connect** next to **Apollo API**.",
      },
      {
        title: "Create a master key",
        body: "Click **API Keys → Create new key**, give it a name and description, then turn on **Set as master key** — this is what grants access to every endpoint, including the ones Outbound Scout and Email Marketing need.",
      },
      {
        title: "Copy the key",
        body: "Copy the generated key immediately — treat it like a password, since a master key can take any action your Apollo account allows.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → Apollo.io → Connect**, paste it into **API key**, and click **Connect**.",
      },
    ],
    verify: [
      "The connect form calls Apollo's free auth/health endpoint — it confirms the key authenticates, but it can't confirm the key has Master Key or search access (Apollo doesn't offer a free way to check that).",
      "A green \"Connected\" badge means the key is valid. If it's not actually a master key, you'll only find out the first time Outbound Scout searches or Email Marketing enrolls contacts — see troubleshooting.",
    ],
    troubleshooting: [
      {
        symptom: "\"Apollo rejected that key. Check it was copied whole and has not been revoked.\" (at connect time)",
        fix: "Re-copy the key from Settings → Integrations → API Keys in Apollo — a partial paste is the most common cause.",
      },
      {
        symptom: "Connects fine, but Outbound Scout's prospect search fails with a 403",
        fix: "The key isn't a master key, or your Apollo plan is below Professional — both gate this endpoint. Recreate the key with \"Set as master key\" turned on, and confirm your plan in Apollo's billing settings.",
      },
      {
        symptom: "Connects fine, but Email Marketing's Apollo channel fails to enroll contacts",
        fix: "\"Adding contacts to a sequence requires a Master API Key\" — same fix as above. Also confirm every address in Audience or List ID is already saved as a Contact in Apollo (Apollo → Contacts) and that Sender Account ID matches a real Apollo-connected mailbox.",
      },
      {
        symptom: "\"None of the configured email(s) matched a saved Contact in Apollo\"",
        fix: "Add those people as Contacts in Apollo first (Apollo → Contacts), then approve the run again.",
      },
    ],
    privacy: "Both read and write, and it can spend Apollo credits and send real messages. Lead Enrichment and Outbound Scout read Apollo's people/company data — Outbound Scout's \"reveal an email\" step spends an Apollo credit per new contact, the same as clicking \"unlock\" in Apollo's own UI. The Outbound Strategist also reads Apollo's organization enrichment, person enrichment, and job-postings data to ground each prospect's score and Intelligence Object — capped at that run's \"Max Apollo Lookups\" setting and reusing recently-fetched data before spending another credit — but it never requests a personal email or phone reveal, so it never adds to Outbound Scout's per-contact reveal spend. Email Marketing's Apollo channel creates a sequence with sending switched off and no contacts enrolled while the run is in progress — nothing sends yet. Only when you approve the run does it add the named Contacts to that sequence and start it sending from the mailbox you specified; that step cannot be undone from marketing-erp once it happens; pause or edit the sequence directly in Apollo if you need to stop it. Disconnect any time from Settings → Integrations → Apollo.io → Disconnect, or revoke the key in Apollo under Settings → Integrations → API Keys.",
    docs: [
      { label: "Apollo: Create API keys", url: "https://docs.apollo.io/docs/create-api-key" },
      { label: "Apollo: Authentication", url: "https://docs.apollo.io/reference/authentication" },
      { label: "Apollo: Organization Enrichment", url: "https://docs.apollo.io/reference/organization-enrichment" },
      { label: "Apollo: Organization Job Postings", url: "https://docs.apollo.io/reference/organization-jobs-postings" },
    ],
  },

  INSTANTLY: {
    provider: "INSTANTLY",
    summary:
      "Connecting Instantly lets Email Outbound (the Outbound Engine's cold-email agent), Email Marketing's Instantly channel, and Prospector's optional outreach step create and send cold email campaigns through your Instantly account.",
    timeMinutes: 5,
    youWillNeed: [
      "An Instantly account on the Growth plan or higher — API v2 access is gated to Growth and above.",
      "A v2 API key specifically. v1 keys exist in older Instantly accounts but every endpoint this integration calls rejects them outright.",
      "An existing Lead List in Instantly (Leads → Lists) for Email Marketing's Instantly channel — it moves that list's leads into the campaign it creates.",
      "At least one connected sending mailbox in Instantly (Settings → Email Accounts) if you turn on Prospector's Outreach via Instantly — the addresses you list in its Sending Accounts field are checked against these.",
    ],
    steps: [
      {
        title: "Sign in to Instantly",
        body: "Go to **app.instantly.ai** and sign in.",
      },
      {
        title: "Open the API page",
        body: "Go to **Settings → Integrations → API** (app.instantly.ai/app/settings/integrations).",
      },
      {
        title: "Generate a v2 key",
        body: "Create a new key here. Make sure it's a v2 key — this page is where v2 keys are issued; older v1 keys generated elsewhere in Instantly will not work.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → Instantly → Connect**, paste it into **API key**, and click **Connect**.",
      },
      {
        title: "Add the webhook (for reply tracking)",
        body: "Copy the **Webhook URL** shown under the connect form — it is unique to this workspace and contains a secret. In Instantly, add a webhook (Settings → Integrations → Webhooks) with that URL as the target. Deliveries to any other URL are refused, so replace any older marketing-erp webhook URL with this one.",
      },
    ],
    verify: [
      "The connect form calls Instantly's campaigns-list endpoint with a limit of 1 — free, and works even with zero campaigns in the account.",
      "A green \"Connected\" badge appears next to Instantly in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"Instantly rejected that key. It must be a v2 key from Settings → Integrations → API Keys ... and v2 access needs Instantly's Growth plan or higher.\"",
        fix: "Regenerate the key from Settings → Integrations → API in Instantly, and confirm the account is on Growth or above — a Hypergrowth-only feature like webhooks is not required here, just Growth-level API access.",
      },
      {
        symptom: "\"Instantly is selected as the Email Platform, but no Audience or List ID was given.\"",
        fix: "Set Audience or List ID to an existing Lead List's ID from Instantly (Leads → Lists) before running Email Marketing.",
      },
      {
        symptom: "A staged campaign never sends, even after approval",
        fix: "Check the campaign directly in Instantly — approval moves the configured list's leads in and activates the campaign, but Instantly's own sending schedule and sender-account setup still apply.",
      },
      {
        symptom: "Prospector: \"Outreach via Instantly is turned on, but Instantly isn't connected for this workspace.\"",
        fix: "Connect Instantly under Settings → Integrations before running Prospector with Outreach via Instantly on, or turn that toggle off to get the prospect list without staging a campaign.",
      },
      {
        symptom: "Prospector: \"None of the configured Sending Accounts ... are connected mailboxes in this workspace's Instantly account.\"",
        fix: "The addresses in Prospector's Sending Accounts field must already be connected mailboxes in Instantly (Settings → Email Accounts) — add or fix the address there, or correct the typo, then run Prospector again.",
      },
      {
        symptom: "Prospector: \"None of this run's prospects had a real, well-formed, non-generic email address to stage in Instantly.\"",
        fix: "Prospector never stages role addresses like info@ or noreply@ — check the run's skipped list for why each prospect was excluded, and widen Target Topics or lower the quality bar to surface prospects with named contacts.",
      },
    ],
    privacy: "Both read and write, and it can send real cold email once you approve a run. Email Marketing's Instantly channel creates a campaign in Instantly's Draft status with no leads attached while staging — nothing sends while a run is awaiting approval; approving it moves the named Lead List's real leads in and activates it. Email Outbound targets an existing campaign you already run continuously — the one chosen for each outbound play on the Outbound Engine page — rather than creating one, so its staging step makes no write to Instantly at all — it only looks up the campaign (read-only, only needed if the play stored a name instead of the id the dropdown gives you) and computes the personalised lead payload for every prospect in the batch. Only once a workspace admin approves the run does it call Instantly's lead-add API to enrol each staged prospect, with skip_if_in_campaign set so a duplicate or retried approval can't enrol any of them a second time. Prospector's Outreach via Instantly step works like Email Marketing's channel but adds its own prospects directly: while the run is staging, it creates the campaign in Draft and adds every prospect with a real, non-generic email address — Instantly never sends from a Draft campaign, so this step alone sends nothing; approving activates the already-populated campaign. Whichever path, approving is what starts sending on Instantly's own schedule, and it cannot be undone from marketing-erp — pause the campaign directly in Instantly if you need to stop it. Rejecting Email Outbound makes no call to Instantly at all — nothing was ever written. Rejecting a Prospector run also makes no call to Instantly, so its staged campaign is left untouched, in Draft, in your Instantly account — it can still be launched by hand from inside Instantly, or deleted there, if you don't want to keep it. Disconnect any time from Settings → Integrations → Instantly → Disconnect, or revoke the key in Instantly under Settings → Integrations → API.",
    docs: [
      { label: "Instantly API v2 docs", url: "https://developer.instantly.ai/" },
      { label: "Instantly Help Center: API V2", url: "https://help.instantly.ai/en/articles/10432807-api-v2" },
    ],
  },

  AIMFOX: {
    provider: "AIMFOX",
    summary:
      "Connecting Aimfox lets the Outbound Engine's LinkedIn Outbound agent, and the Social suite's LinkedIn Engager agent, add prospects to a live Aimfox campaign and send direct messages — connection requests and follow-up messages go out from your connected LinkedIn seat.",
    timeMinutes: 5,
    youWillNeed: [
      "An Aimfox account with a LinkedIn account already connected as a seat.",
      "An API key with \"All\" permission — a Read-only key can look up campaigns but cannot add a lead to one, which is what this agent needs to do.",
      "A campaign already created in Aimfox for LinkedIn Outbound (and, if you use LinkedIn Engager's connection-request queue, a second campaign for it) to target — see troubleshooting if none is found.",
    ],
    steps: [
      {
        title: "Sign in to Aimfox",
        body: "Go to Aimfox and sign in to the workspace with your connected LinkedIn seat.",
      },
      {
        title: "Open Integrations",
        body: "Go to **Workspace Settings → Integrations (API keys)**.",
      },
      {
        title: "Create an \"All\"-permission key",
        body: "Click **Create API Key**, name it, and choose **All** permission (not Read-only) — LinkedIn Outbound needs to write leads into a campaign, not just read from Aimfox.",
      },
      {
        title: "Copy the key",
        body: "Copy it now — Aimfox only shows the full key once, on this screen.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → Aimfox → Connect**, paste it into **API key**, and click **Connect**.",
      },
      {
        title: "Add the webhook (for reply tracking)",
        body: "Copy the **Webhook URL** shown under the connect form — it is unique to this workspace and contains a secret. In Aimfox, add a webhook (Workspace Settings → Integrations → Webhooks) with that URL. Deliveries to any other URL are refused, so replace any older marketing-erp webhook URL with this one.",
      },
    ],
    verify: [
      "The connect form calls Aimfox's accounts-list endpoint — free, read-only, and works even with a Read-only-permission key (so a successful connect here does not by itself confirm the key can add leads).",
      "A green \"Connected\" badge appears next to Aimfox in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"Aimfox rejected that key. Check it was copied whole and has not been revoked.\"",
        fix: "Re-copy the key from Workspace Settings → Integrations — Aimfox only shows it once, so if it was never saved, generate a new one.",
      },
      {
        symptom: "The key connects, but LinkedIn Outbound fails to add a prospect with a 401/403",
        fix: "The key has Read-only permission. Recreate it with \"All\" permission in Workspace Settings → Integrations.",
      },
      {
        symptom: "\"No Aimfox campaign named ... exists in this workspace's Aimfox account.\"",
        fix: "Create a campaign in Aimfox with the name the error message gives (or rename an existing one to include your play's name), then run the agent again.",
      },
    ],
    privacy: "Both read and write, and it can send real connection requests and messages once you approve a run — same model as Email Marketing's channels. LinkedIn Outbound looks up the target campaign by name (read-only) and writes the connection note and follow-up messages while staging, but never calls Aimfox's add-to-campaign-audience endpoint itself: that only happens once a workspace admin approves the run. Approving is what adds the profile to the live Aimfox campaign, which then sends the connection request and follow-ups from your connected LinkedIn seat on its own schedule — this cannot be undone from marketing-erp; pause the campaign directly in Aimfox if you need to stop it. Rejecting the run makes no call to Aimfox at all. Aimfox does not document whether adding the same profile to a campaign twice is itself a no-op, so the only guard against a duplicate add is marketing-erp's own record of which runs have already been approved — don't approve the same run more than once. LinkedIn Engager uses the same key for its own connection-request and message queue: it only ever sends a connection note (via the same add-to-campaign-audience call) or a direct message, and only for the specific targets a workspace admin approved — it never reads, likes, or comments on a post, because Aimfox's API has no endpoint for any of those; a drafted comment stays a manual, paste-it-yourself action no matter what. Disconnect any time from Settings → Integrations → Aimfox → Disconnect, or revoke the key in Aimfox under Workspace Settings → Integrations.",
    docs: [{ label: "Aimfox: API integration", url: "https://help.aimfox.com/en/articles/10162205-aimfox-api-integration" }],
  },

  GO_HIGH_LEVEL: {
    provider: "GO_HIGH_LEVEL",
    summary:
      "Connecting GoHighLevel lets the Outbound Engine's Revenue agent create and update real contacts and sales opportunities in your GHL sub-account whenever an outbound prospect replies, shows interest, or books a meeting.",
    timeMinutes: 8,
    youWillNeed: [
      "Admin access to the specific GoHighLevel sub-account (\"Location\") you want prospects and deals to land in.",
      "A sales pipeline already set up in that sub-account, ideally named \"Outbound\", with stages this agent can match by name (e.g. Lead, Qualified Lead, Meeting Set).",
      "The sub-account's Location ID (Settings → Business Profile, or the /location/ segment of its URL).",
    ],
    steps: [
      {
        title: "Open Private Integrations",
        body: "In the GHL sub-account you want to connect, go to **Settings → Private Integrations**.",
      },
      {
        title: "Create a new integration",
        body: "Click **Create New Integration**, name it (e.g. \"marketing-erp\"), and grant it Contacts and Opportunities read/write scopes — the minimum this agent needs to create contacts and move opportunities through your pipeline.",
      },
      {
        title: "Copy the token",
        body: "Save it, then copy the generated token immediately — GHL only shows it once.",
      },
      {
        title: "Find the Location ID",
        body: "Go to **Settings → Business Profile** in the same sub-account and copy the Location ID (or read it from the sub-account's URL, after /location/).",
      },
      {
        title: "Paste both into marketing-erp",
        body: "Go to **Settings → Integrations → GoHighLevel → Connect**, paste the token into **Private integration token** and the ID into **Location ID**, then click **Connect**.",
      },
    ],
    verify: [
      "The connect form calls GET /locations/{locationId} — free and read-only — which confirms both that the token authenticates AND that it's authorised for this specific sub-account, not just some other one in the same agency.",
      "A green \"Connected\" badge appears next to GoHighLevel in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"GoHighLevel rejected that token, or the token isn't authorised for this location ID.\"",
        fix: "Both the token and Location ID come from the same sub-account — Settings → Private Integrations and Settings → Business Profile. A token created in one sub-account will not work with a different sub-account's Location ID.",
      },
      {
        symptom: "\"GoHighLevel couldn't find a location with that ID.\"",
        fix: "Re-check Settings → Business Profile in the sub-account — the ID may have been mistyped, or copied from the wrong sub-account.",
      },
      {
        symptom: "\"This GoHighLevel sub-account has no sales pipeline set up.\"",
        fix: "Create a pipeline in GoHighLevel (name it \"Outbound\" so this agent finds it automatically) with at least a Lead, Qualified Lead, and Meeting Set stage.",
      },
    ],
    privacy: "Both read and write. It never sends email, text, or any outbound message itself — it only writes CRM records — but it can write real Contacts and Opportunities once you approve a run, same model as Email Marketing's channels. The Revenue agent is triggered automatically whenever an outbound prospect engages (an Instantly or Aimfox reply webhook — nobody clicked \"run\"), which is exactly why the write is gated: it resolves the pipeline/stage by name (read-only) and stages the exact Contact and Opportunity fields it would write, then pauses as Awaiting Approval. Only once a workspace admin approves does it upsert the Contact (safe to repeat — GHL dedupes by email) and, for interest/meeting events, create an Opportunity in the connected sub-account's pipeline — but only if this prospect doesn't already have one; opportunity creation is not idempotent on GHL's side, so an existing id is reused rather than creating a second Opportunity. Rejecting the run makes no call to GoHighLevel at all. Disconnect any time from Settings → Integrations → GoHighLevel → Disconnect, or delete the Private Integration in GHL under Settings → Private Integrations (do this and the token stops working immediately, even if marketing-erp still shows it as connected until you disconnect there too).",
    docs: [{ label: "GoHighLevel: Private Integration Tokens", url: "https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken/" }],
  },

  MAILCHIMP: {
    provider: "MAILCHIMP",
    summary:
      "Connecting Mailchimp lets Newsletter and Email Marketing ground their copy in your account's real past campaign performance, and create ready-to-review campaign drafts directly in Mailchimp.",
    timeMinutes: 4,
    youWillNeed: [
      "A Mailchimp account with permission to view and create campaigns (any standard Mailchimp plan supports API keys).",
    ],
    steps: [
      {
        title: "Open your profile",
        body: "In Mailchimp, click your profile icon (bottom left) and choose **Profile**.",
      },
      {
        title: "Open API keys",
        body: "Click the **Extras** drop-down, then choose **API keys**.",
      },
      {
        title: "Create a key",
        body: "Under \"Your API Keys\", click **Create A Key**, and give it a descriptive name like \"marketing-erp\".",
      },
      {
        title: "Copy it",
        body: "Click **Copy Key to Clipboard** — Mailchimp only shows the full key once.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → Mailchimp → Connect**, paste it into **API key**, and click **Connect**. The data-center suffix on the end of your key (like -us21) is read automatically — you don't need to enter it separately.",
      },
    ],
    verify: [
      "The connect form pings Mailchimp's own /3.0/ping endpoint — free and read-only.",
      "A green \"Connected\" badge appears next to Mailchimp in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"That doesn't look like a Mailchimp key — it should end in a data center like -us21\"",
        fix: "Re-copy the key from Mailchimp's Extras → API keys page — it must include the -usXX (or similar) suffix at the end; a truncated paste loses it.",
      },
      {
        symptom: "\"Mailchimp rejected that API key — check it was copied whole and hasn't been regenerated.\"",
        fix: "If someone regenerated or deleted the key in Mailchimp, generate a fresh one and reconnect — the old one stops working the moment it's replaced.",
      },
      {
        symptom: "Newsletter or Email Marketing runs, but the campaign draft has no audience",
        fix: "This is expected — the agent creates the draft, but you still choose the sending audience in Mailchimp yourself before you send it.",
      },
    ],
    privacy: "Both read and write, but never send. marketing-erp reads your recent sent campaigns and audience lists to ground copy in what has actually worked for you before, and creates new campaigns as Mailchimp drafts — it never clicks Send. A Mailchimp API key grants full account access (Mailchimp doesn't support narrower, scoped keys), so treat it like a password. Disconnect any time from Settings → Integrations → Mailchimp → Disconnect, or delete the key directly in Mailchimp under Profile → Extras → API keys.",
    docs: [{ label: "Mailchimp: About API Keys", url: "https://mailchimp.com/help/about-api-keys/" }],
  },

  KLAVIYO: {
    provider: "KLAVIYO",
    summary:
      "Connecting Klaviyo lets Newsletter and Email Marketing ground their copy in your account's real past campaign performance, and create ready-to-review campaign drafts directly in Klaviyo.",
    timeMinutes: 5,
    youWillNeed: [
      "A Klaviyo account with permission to manage API keys and view/create campaigns.",
      "A private API key scoped (at minimum) with Campaigns read/write access.",
    ],
    steps: [
      {
        title: "Open Settings",
        body: "In Klaviyo, click your organization name (bottom left), then go to **Settings**.",
      },
      {
        title: "Open API keys",
        body: "Click **API keys**, then **Create Private API Key**.",
      },
      {
        title: "Scope the key",
        body: "Name the key, choose **Custom** access, and set **Campaigns** to Full (read/write) — that's the minimum this integration needs. You can grant Full access instead if it's simpler for your workspace.",
      },
      {
        title: "Copy it",
        body: "Copy the key now — Klaviyo will not show it again, and you cannot edit a key's scopes after creation (you'd need to delete it and make a new one).",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → Klaviyo → Connect**, paste it into **API key**, and click **Connect**.",
      },
    ],
    verify: [
      "The connect form calls Klaviyo's /api/accounts/ endpoint — free and read-only.",
      "A green \"Connected\" badge appears next to Klaviyo in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"Klaviyo rejected that private API key — check it was copied whole and has Campaigns read/write access.\"",
        fix: "Re-copy the key from Settings → API keys in Klaviyo. If it was created with Read-only or a Custom scope that excludes Campaigns, delete it and create a new one with Campaigns set to Full.",
      },
      {
        symptom: "Connects fine, but a Newsletter/Email Marketing run fails to create a draft",
        fix: "The key's Campaigns scope is likely Read-only rather than Full — Klaviyo scopes can't be edited after creation, so create a replacement key with Full Campaigns access and reconnect.",
      },
      {
        symptom: "A created campaign draft has no recipients in Klaviyo",
        fix: "Expected if no audience/segment ID was configured — assign a list or segment to the draft yourself in Klaviyo before sending.",
      },
    ],
    privacy: "Both read and write, but never send. marketing-erp reads your recent email campaign performance to ground copy in what has worked before, and creates new campaigns in Klaviyo with sending strategy set to static and no send triggered — it never sends on your behalf. Disconnect any time from Settings → Integrations → Klaviyo → Disconnect, or delete the key directly in Klaviyo under Settings → API keys.",
    docs: [
      { label: "Klaviyo: Create or clone a private API key", url: "https://help.klaviyo.com/hc/en-us/articles/7423954176283" },
      { label: "Klaviyo: Authenticate API requests", url: "https://developers.klaviyo.com/en/docs/authenticate_" },
    ],
  },

  CARTESIA: {
    provider: "CARTESIA",
    summary:
      "Connecting Cartesia lets the Podcast agent turn its written script into real, downloadable voiced audio instead of leaving you with text only.",
    timeMinutes: 4,
    youWillNeed: [
      "A Cartesia account. Cartesia's free tier is enough to test this, but text-to-speech is billed per character generated — check your plan's monthly credit allowance before turning on a regular podcast cadence.",
      "Optionally, a specific voice ID from your Cartesia dashboard if you don't want to use Cartesia's public demo voice (the default when no voice is set).",
    ],
    steps: [
      {
        title: "Sign in to Cartesia",
        body: "Go to **play.cartesia.ai** and sign in.",
      },
      {
        title: "Open API Keys",
        body: "Go to the **API Keys** page (play.cartesia.ai/keys) and click **New**.",
      },
      {
        title: "Name and create the key",
        body: "Give it a name and click **Create** — Cartesia shows the key once in a dialog.",
      },
      {
        title: "Copy it",
        body: "Copy the key from that dialog before closing it.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → Cartesia → Connect**, paste it into **API key**, and click **Connect**.",
      },
    ],
    verify: [
      "The connect form calls Cartesia's voices list endpoint (limit 1) — free and read-only.",
      "A green \"Connected\" badge appears next to Cartesia in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"Cartesia rejected that API key — check it was copied whole and hasn't been revoked.\"",
        fix: "Re-copy the key from play.cartesia.ai/keys — Cartesia only shows it once, so generate a new one if it was lost.",
      },
      {
        symptom: "Connects fine, but a Podcast run's audio generation fails",
        fix: "Check ttsError in the run's output. The most common cause is an exhausted credit balance — check usage on your Cartesia dashboard — or a Voice ID that doesn't exist in your account.",
      },
      {
        symptom: "Audio generates, but doesn't sound like the voice you expected",
        fix: "The Voice ID field in the Podcast agent's settings is a Cartesia voice UUID from your own dashboard, not a model name — copy it from a voice's page in Cartesia. Leaving it blank uses Cartesia's public demo voice.",
      },
    ],
    privacy: "Read-only against your account settings, but every live Podcast run sends your script's text to Cartesia and generates real audio, which spends Cartesia credits from your plan's balance. marketing-erp never publishes or shares that audio anywhere on its own — it's attached to the run's output (and, if Transistor is also connected, uploaded there as a draft episode — see the Transistor guide). Disconnect any time from Settings → Integrations → Cartesia → Disconnect, or revoke the key in Cartesia under API Keys.",
    docs: [{ label: "Cartesia: TTS bytes API reference", url: "https://docs.cartesia.ai/api-reference/tts/bytes" }],
  },

  TRANSISTOR: {
    provider: "TRANSISTOR",
    summary:
      "Connecting Transistor lets the Podcast agent upload its generated audio and create a draft episode in your show, ready for you to review and publish yourself.",
    timeMinutes: 4,
    youWillNeed: [
      "A Transistor account on a paid plan — any paid Transistor plan includes API access; the free trial may not.",
      "At least one show already created in Transistor for episodes to be created under.",
    ],
    steps: [
      {
        title: "Sign in to Transistor",
        body: "Go to **dashboard.transistor.fm** and sign in.",
      },
      {
        title: "Open your account page",
        body: "Click your profile icon → **Your Account** (dashboard.transistor.fm/account).",
      },
      {
        title: "Copy your API key",
        body: "Find it under **API Access** on that page and copy it.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → Transistor → Connect**, paste it into **API key**, and click **Connect**.",
      },
    ],
    verify: [
      "The connect form lists your shows (limit 1) — free and read-only — and also confirms your account has at least one show, since episodes need somewhere to go.",
      "A green \"Connected\" badge appears next to Transistor in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"Transistor rejected that API key — check Account → API Key and that it was copied whole.\"",
        fix: "Re-copy the key from your Account page in Transistor — check for extra whitespace from the copy.",
      },
      {
        symptom: "\"That key works, but this Transistor account has no shows yet\"",
        fix: "Create a show in Transistor first (it's the container episodes get created under), then reconnect.",
      },
      {
        symptom: "Connects fine, but a Podcast run doesn't attach audio to the episode",
        fix: "Episodes are created even if Cartesia isn't connected or audio generation failed — check transistorError and ttsError in the run's output; the episode itself is still created as a draft either way.",
      },
    ],
    privacy: "Both read and write, but every episode Transistor creates through this integration is created as a draft — regardless of what's requested, it is never published or made public automatically. You review and hit publish yourself, inside Transistor. Disconnect any time from Settings → Integrations → Transistor → Disconnect, or revoke the key in Transistor under Account → API Access.",
    docs: [
      { label: "Transistor API reference", url: "https://developers.transistor.fm/" },
      { label: "Transistor: Does Transistor have an API?", url: "https://support.transistor.fm/en/article/does-transistor-have-an-api-1b24sjo/" },
    ],
  },

  CRM_ERP_IO: {
    provider: "CRM_ERP_IO",
    summary:
      "The erp.io CRM is linked automatically: every Marketing workspace tied to an erp.io organization is paired with that organization's CRM workspace, with the same name, members and roles. Email Marketing can stage and send sequences through its contacts and segments — nothing to paste.",
    timeMinutes: 1,
    youWillNeed: [
      "To have opened Marketing from app.erp.io, which ties this workspace to your erp.io organization.",
      "At least one Contact Segment in the CRM (Contacts → Segments) for the audience you want a campaign to reach.",
    ],
    steps: [
      {
        title: "Check the link",
        body: "Under **Settings → Integrations**, the erp.io CRM row reads **Linked to <your CRM workspace>**. If it says Not linked, the reason is shown beside it.",
      },
      {
        title: "Note a Segment ID",
        body: "Find the Contact Segment you want to send to under Contacts → Segments in the CRM and copy its ID into the Email Marketing agent's Audience or List ID field.",
      },
      {
        title: "Run and approve",
        body: "Choose **erp.io CRM** as the Email Platform. The run stages a DRAFT sequence; nothing sends until a workspace admin approves the run.",
      },
    ],
    verify: [
      "The Integrations row calls the CRM's free, read-only /api/marketing-erp/ping with this server's signed service assertion and shows the CRM workspace it resolved to.",
    ],
    troubleshooting: [
      {
        symptom: "\"Not linked: this workspace is not tied to an erp.io organization\"",
        fix: "The workspace was created here rather than through app.erp.io. Ask a platform admin to link it to your organization; until then a super admin can connect a per-tenant API key as a fallback.",
      },
      {
        symptom: "\"This organization's CRM workspace hasn't been created yet\"",
        fix: "The CRM workspace is created automatically when Marketing or CRM is switched on for the organization. It appears within minutes; nobody needs to create it by hand.",
      },
      {
        symptom: "\"The CRM didn't accept this server's signature\"",
        fix: "A deployment problem, not something to fix in the workspace: MARKETING_SERVICE_PUBLIC_KEY on the CRM must be the public half of MARKETING_SERVICE_PRIVATE_KEY here.",
      },
      {
        symptom: "\"erp.io CRM is selected as the Email Platform, but no Segment ID was given.\"",
        fix: "Copy a Contact Segment's ID from Contacts → Segments in the CRM into the agent's Audience or List ID field before running it.",
      },
      {
        symptom: "A staged sequence never activates after approval",
        fix: "Check the run's error detail — a 422 from the CRM means it refused activation (e.g. an invalid segment); check the segment still exists and try approving again.",
      },
    ],
    privacy: "Both read and write, and it can send real email — but only after you approve a run. Email Marketing's CRM channel creates a DRAFT Sequence in your organization's CRM workspace with no one enrolled while the run is in progress — nothing sends yet. Approving the run flips it to ACTIVE and enrolls everyone in the Contact Segment you chose, which starts real sends on the CRM's own schedule; pause or edit the sequence directly in the CRM if you need to stop it. Every call is signed for your organization, and the CRM resolves the workspace from that signature alone, so it can only ever act within your own organization's CRM workspace.",
    docs: [{ label: "erp.io CRM", url: "https://app.erp.io/crm" }],
  },

  OPENAI_IMAGES: {
    provider: "OPENAI_IMAGES",
    summary:
      "Connecting OpenAI Images lets the Blog Writer generate real hero and inline images for an article — a hand-drawn prompt for each image slot, rendered to an actual file and stored on the run — instead of leaving you an image brief to go commission yourself.",
    timeMinutes: 3,
    youWillNeed: [
      "An OpenAI platform account (platform.openai.com) with billing set up — image generation is billed per image on your OpenAI account, separately from any ChatGPT subscription.",
    ],
    steps: [
      {
        title: "Open your API keys",
        body: "Sign in at **platform.openai.com** and go to **API keys** (in the left sidebar, or platform.openai.com/api-keys directly).",
      },
      {
        title: "Create a key",
        body: "Click **Create new secret key**, give it a name like \"marketing-erp\", and copy the value shown. OpenAI only shows the full key once — if you lose it, create a new one.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → OpenAI Images → Connect**, paste the key into **API key**, and click **Connect**.",
      },
    ],
    verify: [
      "The connect form calls OpenAI's free models-list endpoint — it confirms the key is valid and generates no image, so it costs nothing.",
      "A green \"Connected\" badge appears next to OpenAI Images in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"OpenAI rejected that API key — check it was copied whole and hasn't been revoked.\"",
        fix: "Re-copy the key from platform.openai.com/api-keys — a partial paste is the most common cause. If the key was deleted or your organization rotated it, create a fresh one.",
      },
      {
        symptom: "The key connects fine, but a Blog Writer run reports every image as skipped",
        fix: "Check the run's output for the per-image skip reason — the most common cause is an OpenAI account with no payment method on file; image generation fails even with a valid key until billing is set up under Settings → Billing on platform.openai.com.",
      },
    ],
    privacy: "Write-only in the sense that matters here: marketing-erp only ever calls OpenAI's image generation endpoint with a text prompt built from the article's topic, your brand/editorial style, and this run's visuals request — it never reads anything else from your OpenAI account. Every image a Blog Writer run actually generates is billed to your own OpenAI account, capped by the run's image limit. Disconnect any time from Settings → Integrations → OpenAI Images → Disconnect, or revoke the key directly on platform.openai.com — either stops access immediately.",
    docs: [
      { label: "OpenAI: Image generation guide", url: "https://platform.openai.com/docs/guides/image-generation" },
      { label: "OpenAI: Images API reference", url: "https://platform.openai.com/docs/api-reference/images" },
    ],
  },

  GOOGLE_IMAGES: {
    provider: "GOOGLE_IMAGES",
    summary:
      "Connecting Google Images (Gemini) lets the Blog Writer generate real hero and inline images for an article using Google's Gemini image model, as an alternative to OpenAI Images.",
    timeMinutes: 3,
    youWillNeed: [
      "A Google account with access to Google AI Studio — no separate Google Cloud project or billing account is required to get a first key, though heavy use may ask you to attach billing.",
    ],
    steps: [
      {
        title: "Open Google AI Studio",
        body: "Go to **aistudio.google.com/apikey** and sign in with the Google account you want billed for image generation.",
      },
      {
        title: "Create an API key",
        body: "Click **Create API key**, choose a project (or let Google create one for you), and copy the key shown.",
      },
      {
        title: "Paste it into marketing-erp",
        body: "Go to **Settings → Integrations → Google Images (Gemini) → Connect**, paste the key into **API key**, and click **Connect**.",
      },
    ],
    verify: [
      "The connect form calls Gemini's free models-list endpoint — it confirms the key is valid and generates no image, so it costs nothing.",
      "A green \"Connected\" badge appears next to Google Images in Settings → Integrations once it checks out.",
    ],
    troubleshooting: [
      {
        symptom: "\"Google rejected that API key — check it was copied whole from Google AI Studio and hasn't been revoked.\"",
        fix: "Re-copy the key from aistudio.google.com/apikey. If the key was deleted, create a new one — Google AI Studio keys can be revoked without warning if flagged for unusual use.",
      },
      {
        symptom: "The key connects fine, but a Blog Writer run reports every image as skipped",
        fix: "Check the run's output for the per-image skip reason. Gemini's free tier has a request-per-minute limit well below what a run with several images can hit back to back — the run reports the error rather than retrying silently; try again, or reduce this run's image count.",
      },
    ],
    privacy: "Write-only in the sense that matters here: marketing-erp only ever calls Gemini's image generation endpoint with a text prompt built from the article's topic, your brand/editorial style, and this run's visuals request — it never reads anything else from your Google account. Every image a Blog Writer run actually generates is billed to your own Google account, capped by the run's image limit. Disconnect any time from Settings → Integrations → Google Images → Disconnect, or revoke the key directly in Google AI Studio — either stops access immediately.",
    docs: [
      { label: "Google: Gemini API image generation", url: "https://ai.google.dev/gemini-api/docs/image-generation" },
      { label: "Google AI Studio: API keys", url: "https://ai.google.dev/gemini-api/docs/api-key" },
    ],
  },
};
