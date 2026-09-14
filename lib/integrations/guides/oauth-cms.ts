/**
 * Setup guides for the OAuth providers (Google Search Console, Google
 * Analytics 4, Google Business Profile, Google Ads, Gmail, Microsoft 365,
 * Meta) and the CMS providers (WordPress, Payload CMS, Storyblok, Webflow),
 * plus Anthropic — the one every agent needs before anything else works.
 *
 * Merged with lib/integrations/guides/keys.ts (the API-key providers, owned
 * by a different pass) in lib/integrations/guides/index.ts.
 *
 * Menu paths below are described generically where a vendor's own docs don't
 * pin the exact wording down — vendor UIs change labels without notice, and
 * this file isn't the place to chase that. Where the app's own code already
 * asserts a path (see the field hints in lib/integrations/catalog.ts), this
 * repeats that path rather than inventing a second, possibly conflicting one.
 *
 * Client-safe: no server imports.
 */
import type { SetupGuide } from "./types";

export const OAUTH_CMS_SETUP_GUIDES: Partial<Record<string, SetupGuide>> = {
  GOOGLE_SEARCH_CONSOLE: {
    provider: "GOOGLE_SEARCH_CONSOLE",
    summary:
      "Connects your Google Search Console property so agents can read index status, keyword rankings, and page performance. Nothing is written back to Search Console — this is read-only.",
    timeMinutes: 5,
    youWillNeed: [
      "A Google account with Owner or Full user access on the Search Console property (not Restricted)",
      "The property already verified in Search Console — or an owner nearby who can verify one",
    ],
    steps: [
      {
        title: "Check your access level in Search Console",
        body: "Before connecting, open search.google.com/search-console, choose the property, and go to **Settings → Users and permissions**. Find your own email and confirm it says Owner or Full user. Restricted users can view most data but agents need Full user or better.",
      },
      {
        title: "Ask an owner to add you, if needed",
        body: "If you're not listed, an existing Owner opens the same **Users and permissions** screen, clicks **Add user**, enters your Google account email, and sets your permission to Owner or Full user. Google Groups can't be added — it has to be an individual Google account.",
      },
      {
        title: "Pick the right Google account before you start",
        body: "The account you sign in with on the next screen is the one whose Search Console access we use. If you manage multiple properties across different Google accounts, make sure you're signing in with the one that actually has access to the property this workspace needs.",
      },
      {
        title: "Click Continue with Google",
        body: "On this app's Google Search Console connect page, click **Continue with Google**. You'll be sent to Google's own sign-in and consent screen — this app never sees your Google password.",
      },
      {
        title: "Approve the requested access",
        body: "Google will ask you to allow read access to Search Console. Leave the permission checkbox ticked and approve — unticking it and continuing anyway is what causes an \"access_denied\" error back here.",
      },
      {
        title: "About the \"Google hasn't verified this app\" screen",
        body: "You may see a warning that Google hasn't verified this app — that can happen while our Google verification is pending, independent of whether the connection itself works correctly. If you see it and trust erp.io, click **Advanced**, then the link to proceed. If you'd rather not, stop and contact support instead of proceeding.",
      },
      {
        title: "Choose the property, and verify one first if you don't have one",
        body: "After approving, you'll land on a picker listing every Search Console property your Google account can access. Choose a **Domain** property (covers http/https and all subdomains, e.g. \"example.com\") if you have one, otherwise a **URL-prefix** property for the exact URL you use. If nothing appears in the list, you have no verified property yet — go to Search Console, click **Add property**, and verify it via a DNS TXT record with your domain provider (works for Domain properties), an HTML tag or file upload (URL-prefix only), or through a linked Google Analytics/Google Tag Manager account — then come back and reconnect.",
      },
      {
        title: "Save",
        body: "Click **Save**. You're returned to the Integrations page, where Google Search Console should show as Connected.",
      },
    ],
    verify: [
      "The Integrations page shows Google Search Console as Connected, with the property you chose shown under \"Using\"",
      "Run Technical Audit or another SEO agent that reads Search Console data — a successful run with real numbers (not a note about simulated data) confirms the connection is live",
    ],
    troubleshooting: [
      {
        symptom: "The property I need isn't in the list",
        fix: "The list only shows properties your signed-in Google account can access. Either you signed in with the wrong Google account (use \"Use a different Google account\" on the connect page), or the property isn't verified yet, or you haven't been added as a user on it — see the first two steps above.",
      },
      {
        symptom: "\"access_denied\" after approving on Google's screen",
        fix: "This usually means the access checkbox got unticked during consent, or someone with admin control over the Google Workspace account has blocked third-party apps. Reconnect and leave every checkbox ticked; if it still fails, ask whoever administers your Google Workspace to check Admin console → Security → API controls for a block on this app.",
      },
      {
        symptom: "Connected, but agent runs still show simulated data",
        fix: "Reconnect from the Integrations page — a token can be present but stale or missing a scope from an older connection. If it still doesn't pick up live data after reconnecting, contact support.",
      },
      {
        symptom: "No refresh token / connection stops working after about an hour",
        fix: "Google only issues a refresh token on a fresh consent grant. If you'd previously connected and revoked access at myaccount.google.com/permissions without disconnecting here first, reconnecting can silently reuse the old, now-dead grant. Go to myaccount.google.com/permissions, remove erp.io's access entirely, then reconnect from scratch here.",
      },
      {
        symptom: "Signed in with the wrong Google account",
        fix: "On the connect page, use **Use a different Google account** (or **Reconnect with Google** if you're on the error screen) to redo the sign-in with the correct account.",
      },
    ],
    privacy:
      "Read-only: we request Search Console's read-only scope, so agents can read index coverage, search performance, and URL inspection data for the property you choose — nothing is published or changed in Search Console. Revoke anytime from Search Console access at myaccount.google.com/permissions, or click Disconnect on this app's Integrations page (which also asks Google to end the grant).",
    docs: [
      { label: "Search Console: Users and permissions", url: "https://support.google.com/webmasters/answer/7687615" },
      { label: "Search Console: verify a property", url: "https://support.google.com/webmasters/answer/9008080" },
      { label: "Google account permissions", url: "https://myaccount.google.com/permissions" },
    ],
  },

  GOOGLE_ANALYTICS_4: {
    provider: "GOOGLE_ANALYTICS_4",
    summary:
      "Connects a GA4 property so agents can pull session, conversion, and traffic data into reports and anomaly checks. Read-only — nothing in Analytics is changed.",
    timeMinutes: 5,
    youWillNeed: [
      "A Google account with at least Viewer access on the GA4 property",
      "A GA4 property already created (Universal Analytics is retired — this only works with GA4)",
    ],
    steps: [
      {
        title: "Confirm you're looking at a GA4 property, not old Universal Analytics",
        body: "Universal Analytics stopped processing data years ago and has no API this app can read. In Google Analytics, check the property switcher at the top — a GA4 property's settings show **Data streams**, not the old \"Views\" concept. If you only have a UA property, you'll need to create a GA4 property first (Analytics normally does this automatically going forward).",
      },
      {
        title: "Check your access level",
        body: "In Analytics, go to **Admin** (the gear icon) → under the Property column, **Property access management**. Find your email and confirm you have at least Viewer — Analyst or Editor also work, but Viewer is the minimum agents need to read data.",
      },
      {
        title: "Click Continue with Google",
        body: "On this app's Google Analytics 4 connect page, click **Continue with Google** and sign in with the account that has that Viewer access. This is a separate step from Search Console even if it's the same Google account — each Google integration here is connected on its own.",
      },
      {
        title: "Approve the requested access",
        body: "Approve the read-only Analytics permission on Google's consent screen. If you see the \"Google hasn't verified this app\" notice, that reflects our verification status, not a problem with the connection — click Advanced and proceed only if you trust erp.io.",
      },
      {
        title: "Choose the GA4 property",
        body: "The picker lists every GA4 property (not data stream — a property can have several data streams, like web and app, but you pick the property itself) your account can see, grouped by the Analytics account name. Pick the one for this workspace's site.",
      },
      {
        title: "Save",
        body: "Click **Save**. The Integrations page should now show Google Analytics 4 as Connected.",
      },
    ],
    verify: [
      "Integrations page shows Google Analytics 4 as Connected with the property name under \"Using\"",
      "Run Weekly Report, Attribution, Anomaly Watch, or CRO Experiments — a run that returns real traffic numbers (not a simulated-data note) confirms it's live",
    ],
    troubleshooting: [
      {
        symptom: "The property I need isn't in the picker",
        fix: "Either your Google account only has access to a different property, or it's a legacy Universal Analytics property with no GA4 equivalent yet. Check Admin → Property access management in Analytics for your access, and confirm the property is GA4 (it will show Data streams in its settings).",
      },
      {
        symptom: "\"access_denied\" on Google's consent screen",
        fix: "Reconnect and leave every requested permission checked. If your organization's Google Workspace restricts third-party apps, ask your admin to check Admin console → Security → API controls.",
      },
      {
        symptom: "Reports still show simulated numbers after connecting",
        fix: "Reconnect from the Integrations page. If that doesn't fix it, the account you're signed in with may only have access at a different GA4 property than the one you meant to pick — reconnect and re-check the picker.",
      },
    ],
    privacy:
      "Read-only: we request Analytics' read-only scope, so agents can read session, conversion, and traffic data for the property you choose. Nothing is written to Analytics. Revoke at myaccount.google.com/permissions, or click Disconnect on the Integrations page.",
    docs: [
      { label: "GA4 property access management", url: "https://support.google.com/analytics/answer/9305587" },
      { label: "GA4 vs. Universal Analytics", url: "https://support.google.com/analytics/answer/11583528" },
    ],
  },

  GOOGLE_BUSINESS_PROFILE: {
    provider: "GOOGLE_BUSINESS_PROFILE",
    summary:
      "Connects your Google Business Profile location so agents can draft posts and manage review replies. This is the one Google integration here that both reads and writes — Google offers no read-only option for it.",
    timeMinutes: 5,
    youWillNeed: [
      "A Google account that is an Owner or Manager on the Business Profile",
      "A verified business location — Google Business Profile has no way to grant API access to an unverified one",
    ],
    steps: [
      {
        title: "Confirm the location is verified",
        body: "Go to business.google.com, select the location, and check for any \"Verify now\" prompt. An unverified location won't appear in this app's picker at all — verify it in Google's own flow first (usually postcard, phone, or email, depending on the business type) before connecting here.",
      },
      {
        title: "Check your role",
        body: "In the Business Profile, go to **Managers** (sometimes under Settings) and confirm your account is listed as Owner or Manager — not just a Site manager, which has a narrower permission set. If you're not listed, an existing Owner adds you from that same screen.",
      },
      {
        title: "Click Continue with Google",
        body: "On this app's Google Business Profile connect page, click **Continue with Google** and sign in with the Owner/Manager account.",
      },
      {
        title: "Approve the requested access",
        body: "Google will ask for the Business Profile management permission — this is the only scope Google offers for this product, so it always covers both read and write, even if all you want is reporting. Approve it to continue.",
      },
      {
        title: "Choose the location",
        body: "The picker lists every verified location your account manages, with the account name and city shown alongside each one. Pick the location this workspace should use.",
      },
      {
        title: "Save",
        body: "Click **Save** to finish. Note: there's no way to see or answer Google's Q&A feature through this connection — Google doesn't offer an API for it, so that part of a listing still needs to be managed by hand in Google's own app.",
      },
    ],
    verify: [
      "Integrations page shows Google Business Profile as Connected, with the location under \"Using\"",
      "Run Local SEO / GBP or Review Engine — a successful run against real profile data confirms the connection",
    ],
    troubleshooting: [
      {
        symptom: "No locations show up in the picker",
        fix: "The account you signed in with either isn't an Owner/Manager on any location, or the location isn't verified yet. Check business.google.com for a pending verification, and check Managers for your role.",
      },
      {
        symptom: "\"access_denied\" or the picker fails to load",
        fix: "Reconnect and leave the permission checked on Google's consent screen. A personal Google account with no Business Profile access at all will show an empty list rather than an error — that's expected if you signed in with the wrong account.",
      },
      {
        symptom: "Posts or review replies aren't appearing",
        fix: "Reconnect from the Integrations page — Business Profile access can be revoked from the Google account side without this app finding out until the next call fails. If it still doesn't work, confirm in business.google.com that the location hasn't been suspended or merged into another listing.",
      },
    ],
    privacy:
      "Read and write: the only scope Google offers for Business Profile covers both reading your listing data and posting updates or review replies on your behalf. Revoke at myaccount.google.com/permissions, or click Disconnect on the Integrations page.",
    docs: [
      { label: "Add or remove managers", url: "https://support.google.com/business/answer/3403101" },
      { label: "Verify your Business Profile", url: "https://support.google.com/business/answer/7107242" },
    ],
  },

  GOOGLE_ADS: {
    provider: "GOOGLE_ADS",
    summary:
      "Connects a Google Ads account so paid media agents can pull campaign performance for reporting. Standard or even Read-only account access is enough — nothing here requires the ability to spend budget.",
    timeMinutes: 5,
    youWillNeed: [
      "A Google account with at least Read-only access on the Ads account (Standard access also works)",
      "If this workspace's account is on a manager (MCC) account, know which customer ID under it you need",
    ],
    steps: [
      {
        title: "Check your access level",
        body: "Sign in to ads.google.com, click the tools icon, and open **Access and security** under Setup. Confirm your email is listed with Standard or Read-only access. Email-only access (no login) isn't enough — you need account-level access tied to a Google account.",
      },
      {
        title: "Find your customer ID",
        body: "The customer ID is the number shown near the top of the Ads interface, formatted like 123-456-7890. If this account is managed through an agency or in-house manager (MCC) account, note that a manager account itself is not the same as the individual customer account agents need — you'll pick the specific customer account in the next steps.",
      },
      {
        title: "Click Continue with Google",
        body: "On this app's Google Ads connect page, click **Continue with Google** and sign in with the account that has Ads access.",
      },
      {
        title: "Approve the requested access",
        body: "Approve the Ads permission on Google's consent screen.",
      },
      {
        title: "Choose the account",
        body: "The picker lists every Ads customer ID your account can see, formatted like 123-456-7890. If you manage several accounts under one manager account, pick the specific customer account this workspace's campaigns run under — not the manager account itself.",
      },
      {
        title: "Save",
        body: "Click **Save**. If Google Ads shows as \"Not set up\" instead of offering a Connect button on the Integrations page, that's a server-side prerequisite (Google Ads needs a developer token approved for this app, separate from your own account access) — contact support rather than trying to work around it.",
      },
    ],
    verify: [
      "Integrations page shows Google Ads as Connected with the customer ID under \"Using\"",
      "Run a paid media agent that reports on campaign performance — real numbers back confirm the connection",
    ],
    troubleshooting: [
      {
        symptom: "Google Ads shows \"Not set up\" and there's no Connect button",
        fix: "This means the server-side developer token isn't configured yet, not a problem with your Google account. Contact support — reconnecting won't fix it.",
      },
      {
        symptom: "The account I need isn't in the picker",
        fix: "You're likely signed in with a Google account that has no access to it, or it sits under a different manager account than the one you expected. Check Access and security in Ads for your own account access.",
      },
      {
        symptom: "\"access_denied\" on Google's consent screen",
        fix: "Reconnect and leave every requested permission checked.",
      },
      {
        symptom: "Connected, but reports fail or come back empty",
        fix: "Confirm the account picked isn't a manager (MCC) account with no campaigns of its own — pick the underlying customer account instead. If that's already right, reconnect from the Integrations page.",
      },
    ],
    privacy:
      "Read access to campaign and performance data (the Ads scope Google offers doesn't separate read from write, but agents here only read for reporting). Revoke at myaccount.google.com/permissions, or click Disconnect on the Integrations page.",
    docs: [
      { label: "Grant access to your Google Ads account", url: "https://support.google.com/google-ads/answer/6372672" },
      { label: "About manager accounts", url: "https://support.google.com/google-ads/answer/6139186" },
    ],
  },

  GMAIL: {
    provider: "GMAIL",
    summary:
      "Connects Gmail so Outreach and Inbox Responder can read recent unread and sent mail and prepare reply/outreach drafts. Agents only ever create drafts — they never send mail on your behalf.",
    timeMinutes: 4,
    youWillNeed: [
      "The Gmail (or Google Workspace) account you want agents drafting in",
      "If it's a Google Workspace account, know whether your organization restricts third-party app access",
    ],
    steps: [
      {
        title: "Decide which mailbox agents should use",
        body: "Connect the actual mailbox you want Outreach or Inbox Responder working in — this is usually a dedicated outreach inbox rather than a personal one, since the connection belongs to the whole workspace, not just to you.",
      },
      {
        title: "Click Continue with Google",
        body: "On this app's Gmail connect page, click **Continue with Google** and sign in with that mailbox's Google account.",
      },
      {
        title: "Approve the requested access",
        body: "Google will list two permissions: reading mail, and composing/managing drafts. Agents use these to list unread mail (Inbox Responder) or sent mail (Outreach, to detect replies) and to create draft replies — they never request the send permission, so there is no way for this connection to send mail without you. Approve both to continue.",
      },
      {
        title: "About the verification notice",
        body: "You may see \"Google hasn't verified this app\" — this reflects where our Google verification stands, separate from whether the connection works. If you trust erp.io, click Advanced and proceed; otherwise stop and contact support.",
      },
      {
        title: "Finish",
        body: "There's no picker step for Gmail — a mailbox is just \"me,\" so approving is the whole flow. You'll land back on Integrations showing Gmail as Connected.",
      },
    ],
    verify: [
      "Integrations page shows Gmail as Connected",
      "Run Inbox Responder or Outreach, then check the connected mailbox's Drafts folder for what the agent produced — drafts appear there, never in Sent",
    ],
    troubleshooting: [
      {
        symptom: "\"access_denied\" after approving",
        fix: "Reconnect and leave both permissions checked — unticking either one causes this. If your Gmail is part of a Google Workspace, an admin may also be blocking third-party apps; see the next row.",
      },
      {
        symptom: "A Google Workspace admin blocks the connection",
        fix: "Some organizations restrict which third-party apps can access Workspace Gmail. Your Workspace admin needs to check the Google Admin console → **Security → API controls → App access control**, and allow or trust this app rather than blocking it.",
      },
      {
        symptom: "No refresh token / it stops working after about an hour",
        fix: "This happens if a prior connection was revoked at myaccount.google.com/permissions without disconnecting here first, and a reconnect silently reused the dead grant. Remove erp.io's access there, then reconnect from scratch on the Integrations page.",
      },
      {
        symptom: "I'm worried this could send mail on its own",
        fix: "It can't — the permission this app requests only covers reading and drafting, never sending. Every draft an agent produces waits in the Drafts folder for a person to review and send.",
      },
    ],
    privacy:
      "Read unread and sent mail, and create/manage drafts. Never sends mail. Revoke at myaccount.google.com/permissions, or click Disconnect on the Integrations page.",
    docs: [
      { label: "Third-party apps with Google Workspace access", url: "https://support.google.com/a/answer/7281227" },
      { label: "Google account permissions", url: "https://myaccount.google.com/permissions" },
    ],
  },

  MICROSOFT_365: {
    provider: "MICROSOFT_365",
    summary:
      "Connects Outlook / Microsoft 365 mail so Outreach and Inbox Responder can read your inbox and prepare drafts, the same way the Gmail connection does. Agents only create drafts — they never send.",
    timeMinutes: 4,
    youWillNeed: [
      "The Microsoft work, school, or personal Outlook.com account you want agents drafting in",
      "For a managed work/school tenant: know whether your IT admin needs to approve this app first (see below)",
    ],
    steps: [
      {
        title: "Decide which mailbox to connect",
        body: "As with Gmail, connect the actual mailbox agents should read and draft in — commonly a shared outreach mailbox rather than a personal one.",
      },
      {
        title: "Click Continue with Microsoft",
        body: "On this app's Microsoft 365 connect page, click **Continue with Microsoft** and sign in with that account. Both personal Microsoft accounts and work/school (Microsoft 365 / Entra ID) accounts work — the mailbox doesn't need to be on a managed tenant at all.",
      },
      {
        title: "Approve the requested access",
        body: "Microsoft will ask you to allow reading and writing mail (which includes creating and updating drafts) plus offline access, so the connection keeps working without you signing in again. Leave everything checked — unticking any of it is what causes reconnecting to fail with a missing-permission error.",
      },
      {
        title: "If your organization requires admin consent",
        body: "Some Microsoft 365 tenants require a tenant admin to approve new third-party apps before any user in the org can grant them access — if you see a message saying admin approval is needed, you can't get past it yourself. Send your IT admin the request; they approve it from the Microsoft Entra admin center (Enterprise applications → the pending consent request), after which you can complete the connection.",
      },
      {
        title: "Finish",
        body: "Like Gmail, there's no picker step — approving completes the connection, and you land back on Integrations showing Microsoft 365 as Connected.",
      },
    ],
    verify: [
      "Integrations page shows Microsoft 365 as Connected",
      "Run Inbox Responder or Outreach, then check the connected mailbox's Drafts folder for the agent's output",
    ],
    troubleshooting: [
      {
        symptom: "\"Need admin approval\" on Microsoft's consent screen",
        fix: "Your Microsoft 365 tenant has admin consent turned on for new apps. Ask your IT admin to approve this app in the Microsoft Entra admin center, then try connecting again.",
      },
      {
        symptom: "Connection works for about an hour, then fails",
        fix: "This means the refresh token wasn't granted — usually because offline access got unticked during consent. Reconnect from the Integrations page and leave every requested permission checked.",
      },
      {
        symptom: "\"invalid_grant\" or a message that access was revoked",
        fix: "Someone removed this app's access from the Microsoft account directly (myaccount.microsoft.com), or a password change invalidated the grant. Reconnect from the Integrations page.",
      },
      {
        symptom: "I want to fully revoke this from Microsoft's side, not just Disconnect here",
        fix: "Go to myaccount.microsoft.com, review your app permissions, and remove this app's access there. Disconnect on the Integrations page removes it from this app but — unlike Google — Microsoft gives no API this app can use to revoke the grant on its side automatically, so the two steps are separate.",
      },
    ],
    privacy:
      "Read and draft mail via Microsoft Graph (Mail.ReadWrite) — covers listing/reading messages and creating/updating drafts, never sending. Revoke via myaccount.microsoft.com (and, for a managed tenant, your IT admin can also revoke it tenant-wide), or click Disconnect on the Integrations page to remove it here.",
    docs: [
      { label: "Review app permissions (Microsoft account)", url: "https://myaccount.microsoft.com" },
      { label: "Admin consent for apps (Microsoft Entra)", url: "https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-consent-requests" },
    ],
  },

  META: {
    provider: "META",
    summary:
      "Connects a Facebook Page (and its linked Instagram account, if it has one) so Meta Poster can publish to both on your behalf.",
    timeMinutes: 6,
    youWillNeed: [
      "A Facebook account that is an admin or editor on the Page",
      "If you also want Instagram posting: the Instagram account must be a Business or Creator account already linked to that Facebook Page — a personal Instagram account can't be connected",
    ],
    steps: [
      {
        title: "Confirm your role on the Page",
        body: "In Facebook, open the Page, go to **Page settings → Page roles** (or **People with Facebook access**, depending on your Facebook version), and confirm your account is listed as admin or editor.",
      },
      {
        title: "Confirm Instagram is linked as a Business/Creator account",
        body: "If you also want Instagram posting, open the Page's settings, find **Linked accounts** (or Instagram settings), and confirm an Instagram account is connected and that it's set to Business or Creator, not Personal. A personal Instagram account has no publishing API and won't show up in the picker even if it's linked.",
      },
      {
        title: "Click Continue with Facebook",
        body: "On this app's Meta connect page, click **Continue with Facebook** and log in with the account that has admin/editor access to the Page.",
      },
      {
        title: "Approve the requested permissions",
        body: "Facebook will list permissions to see your Pages, read Page engagement, publish to the Page, and read/publish to a linked Instagram Business account. Approve all of them — declining any one will make the Page or Instagram account fail to work later even if the connection appears to succeed.",
      },
      {
        title: "Pick the Page",
        body: "If your account admins more than one Page, you'll see a picker — choose the Page this workspace should post as. If a linked Instagram Business account was found, its username is shown alongside the Page.",
      },
      {
        title: "Save",
        body: "Click **Save** to finish. Unlike the Google integrations, this connection doesn't expire on its own — Facebook Page tokens minted this way don't have a routine refresh cycle, so you generally won't need to reconnect unless you change your password, remove app access, or lose your role on the Page.",
      },
    ],
    verify: [
      "Integrations page shows Meta as Connected, with the Page name under \"Using\"",
      "Run Meta Poster — a successful post appearing on the actual Facebook Page (and Instagram, if connected) confirms it",
    ],
    troubleshooting: [
      {
        symptom: "\"the app is in development mode\" or a similar review-status error",
        fix: "Meta requires this app to complete App Review before anyone outside its own registered testers/developers can grant these permissions. If you see this, contact support rather than retrying — it isn't something reconnecting fixes.",
      },
      {
        symptom: "No Pages show up in the picker",
        fix: "The Facebook account you logged in with isn't an admin or editor on any Page. Check Page roles / People with Facebook access on the Page you expected to see.",
      },
      {
        symptom: "The Page shows up but Instagram doesn't",
        fix: "The Page's Instagram account either isn't linked, or is a Personal (not Business/Creator) Instagram account. Convert it to a Business or Creator account in the Instagram app, link it to the Page, then reconnect.",
      },
      {
        symptom: "Posting suddenly stops working after previously connecting fine",
        fix: "The Page token can stop working if the connecting person's Facebook password changed, they lost their role on the Page, or app access was removed from the Facebook side. Reconnect from the Integrations page — there's no automatic refresh for this one.",
      },
    ],
    privacy:
      "Read your Page list and engagement data, and publish posts to the Page and its linked Instagram Business account. The long-lived personal access token used during setup is never stored — only the Page-specific token the connection actually needs is kept. Revoke from Facebook's Business Integrations settings (Settings & Privacy → Settings → Business Integrations), or click Disconnect on the Integrations page (this removes it here; Meta gives no API this app can call to revoke the grant automatically, so it's worth checking Facebook's own settings too if you want it fully gone).",
    docs: [
      { label: "Facebook Page roles", url: "https://www.facebook.com/business/help/289207354498410" },
      { label: "Connect Instagram to a Facebook Page", url: "https://www.facebook.com/business/help/898752960195806" },
    ],
  },

  WORDPRESS: {
    provider: "WORDPRESS",
    summary:
      "Connects your WordPress site so Blog Writer and On-site Publisher can create draft posts directly in it, ready for you to review and publish.",
    timeMinutes: 6,
    youWillNeed: [
      "WordPress 5.6 or later, on a site served over HTTPS (Application Passwords need both)",
      "A WordPress user account with at least the Author role — Editor if agents should also touch posts written by other users",
    ],
    steps: [
      {
        title: "Confirm your site qualifies",
        body: "Application Passwords — the feature this connection uses — need WordPress 5.6+ and a site on HTTPS. Most current WordPress installs already meet both; if yours doesn't, this connection won't work until it's upgraded/moved to HTTPS.",
      },
      {
        title: "Pick (or create) the WordPress user agents will publish as",
        body: "Author is enough to publish this account's own posts. If agents should also be able to edit posts created by other users on the site, use an Editor account instead. Avoid connecting a personal Administrator account you also use for everyday login — a dedicated account makes it easy to revoke access later without affecting anyone else.",
      },
      {
        title: "Generate an Application Password",
        body: "Log in to wp-admin as that user, go to **Users → Profile** (your own profile page), scroll to **Application Passwords**, type a name for it (e.g. \"marketing-erp\"), and click **Add New Application Password**. WordPress shows the password once — copy it immediately, you can't view it again.",
      },
      {
        title: "Gather your site URL and username",
        body: "Use the site's HTTPS URL (e.g. https://example.com — no trailing path), and the WordPress **username**, not the email address the account logs in with.",
      },
      {
        title: "Fill in the connect form",
        body: "Back on this app's WordPress connect page, enter the Site URL, Username, and the Application Password exactly as WordPress showed it (the spaces in the middle are part of it — leave them in).",
      },
      {
        title: "Submit",
        body: "Click **Connect WordPress**. A success message means the credentials were accepted; you're returned to Integrations with WordPress shown as Connected.",
      },
    ],
    verify: [
      "Integrations page shows WordPress as Connected",
      "Run Blog Writer or On-site Publisher with WordPress as the CMS Target, then check wp-admin → Posts → Drafts for the new draft",
    ],
    troubleshooting: [
      {
        symptom: "Connecting fails immediately with an authentication error",
        fix: "Double-check the username (not email) and that the application password was pasted exactly as shown, including spaces. If you closed the Application Passwords screen before copying it, generate a new one — WordPress never shows the same one twice.",
      },
      {
        symptom: "A security plugin is blocking it (Wordfence, iThemes/Solid Security, All-In-One WP Security)",
        fix: "These plugins can disable the REST API or Application Passwords outright. In the plugin's settings, look for an option like \"Disable REST API,\" \"Disable Application Passwords,\" or an XML-RPC/REST API firewall rule, and allow the wp-json REST API and Application Passwords through — consult the plugin's own docs for the exact toggle, since it varies by plugin and version.",
      },
      {
        symptom: "The host or Cloudflare blocks /wp-json entirely",
        fix: "Some hosts and WAFs block the REST API path by default. Check your host's firewall rules or Cloudflare's WAF/Firewall Rules for anything blocking /wp-json/*, and allow it — Blog Writer and On-site Publisher post through that path.",
      },
      {
        symptom: "\"REST API disabled\" or a similar plugin message",
        fix: "A dedicated \"Disable REST API\" plugin (or a setting inside a broader security plugin) is turned on. Either disable that plugin/setting for this site, or add an exception for the specific wp-json/wp/v2/posts route this connection uses.",
      },
      {
        symptom: "401 error, but only on some hosts (often shared/Apache hosting)",
        fix: "Some Apache hosts run PHP as CGI, which strips the Authorization header before WordPress ever sees it — Application Passwords rely on that header. The fix is host-specific: usually adding a rule to your site's .htaccess file to pass the Authorization header through (search your host's documentation for \"Apache CGI Authorization header\" for the exact rule they recommend).",
      },
      {
        symptom: "This is a multisite network",
        fix: "Application Passwords are created per user, per site the user belongs to. Make sure the site URL you entered matches the specific subsite the connected user should publish to, not the network's root domain.",
      },
    ],
    privacy:
      "Read and create posts via the WordPress REST API, using an Application Password (not your login password) scoped to one user account. To revoke, go to **Users → Profile → Application Passwords** in wp-admin and click Revoke next to the one you created, or click Disconnect on this app's Integrations page (which only removes it here — revoke it in WordPress too if you want it fully dead). Only one WordPress site can be connected per workspace today; connecting more than one is planned but not yet available.",
    docs: [
      { label: "WordPress Application Passwords", url: "https://developer.wordpress.org/rest-api/reference/application-passwords/" },
      { label: "WordPress REST API handbook", url: "https://developer.wordpress.org/rest-api/" },
    ],
  },

  PAYLOAD: {
    provider: "PAYLOAD",
    summary:
      "Connects your Payload CMS instance so Blog Writer and On-site Publisher can create draft posts in it, and so Internal Linking can read your real published pages instead of guessing at your site structure.",
    timeMinutes: 10,
    youWillNeed: [
      "Access to your Payload admin panel, and a developer able to make a one-line config change if API keys aren't already enabled",
      "The collection names Payload uses for auth and posts (defaults: users, posts) if this instance uses different ones",
    ],
    steps: [
      {
        title: "Enable API keys on the auth collection (developer step)",
        body: "Payload's API keys are opt-in per collection. In your Payload config, the auth collection (usually Users) needs `auth: { useAPIKey: true }` — for example:\n\n```ts\nexport const Users: CollectionConfig = {\n  slug: \"users\",\n  auth: { useAPIKey: true },\n  // …\n};\n```\n\nDeploy that change before continuing — without it, there's no API Key tab to generate a key from.",
      },
      {
        title: "Create a dedicated API user",
        body: "In the Payload admin, create a new user in the auth collection specifically for this connection, rather than reusing a real person's login. This makes it easy to see what the connection can do, and to revoke it later without affecting anyone's own account.",
      },
      {
        title: "Generate the API key",
        body: "Open that user's document in the Payload admin, find the **API Key** tab, and generate a key. Copy it immediately — depending on your Payload version it may not be shown again.",
      },
      {
        title: "Gather the connection details",
        body: "You'll need: the Payload **base URL** (the origin your Payload instance is hosted at, no trailing slash or path — this is the CMS host, which is often different from your public site); the **auth collection slug** (defaults to `users`); the **posts collection slug** (defaults to `posts`); and, only if this instance uses the multi-tenant plugin, the **tenant ID** posts should be scoped to.",
      },
      {
        title: "Set the public site URL and body format",
        body: "If your site renders posts at a different origin than the Payload base URL (common — e.g. the CMS lives at payload.example.com but posts render at example.com), fill in **Public site URL** so internal links resolve correctly. For **Body format**, choose `html` if the post body field stores raw HTML — publishing works fully. Choose `lexical` only if you just want Internal Linking to read your existing pages; publishing new posts isn't supported yet for Lexical fields, since there's no automatic HTML→Lexical converter.",
      },
      {
        title: "Confirm the body field name",
        body: "The field on your posts collection that holds the article body defaults to `bodyHtml` for HTML format or `content` for Lexical — override it if your schema uses a different field name.",
      },
      {
        title: "Fill in the connect form and submit",
        body: "Enter everything above on this app's Payload CMS connect page and click **Connect**. A success message confirms the key was accepted.",
      },
    ],
    verify: [
      "Integrations page shows Payload CMS as Connected",
      "Run Internal Linking — its output should say page URLs came from your connected Payload CMS, not a fully simulated structure",
      "Run On-site Publisher with Payload as the CMS Target, then check the posts collection in the Payload admin for the new draft",
    ],
    troubleshooting: [
      {
        symptom: "\"useAPIKey\" isn't available / no API Key tab on the user",
        fix: "The auth collection's config needs `auth: { useAPIKey: true }` set and deployed — this is a developer-side change to your Payload instance, not something fixable from the connect form.",
      },
      {
        symptom: "Connection fails with a 401/403",
        fix: "Double-check the auth collection slug matches the collection the API key actually belongs to — the key is sent as `<collection-slug> API-Key <key>`, so a mismatched slug fails even with a valid key. Confirm you copied the whole key.",
      },
      {
        symptom: "Cloudflare (or another bot-fight/WAF feature) blocks the connection",
        fix: "Some Cloudflare security levels block requests that don't look like they came from a browser. If your Payload instance sits behind Cloudflare, check its Bot Fight Mode / WAF rules and allow API requests to the Payload origin, or add an exception for this app's requests.",
      },
      {
        symptom: "Internal linking still looks made up after connecting",
        fix: "Confirm the posts collection slug and (if multi-tenant) tenant ID are correct — a wrong posts collection returns nothing, and the handler silently falls back to a simulated site structure rather than failing. Check the run's output note for whether it says posts came from Payload.",
      },
      {
        symptom: "Publishing fails and mentions Lexical",
        fix: "This connection's Body format is set to Lexical, which isn't supported for automatic publishing — HTML→Lexical conversion isn't implemented. Switch Body format to `html` under this integration's settings (the field must accept raw HTML), or publish that draft manually.",
      },
      {
        symptom: "I can't find my tenant ID",
        fix: "Only relevant if this Payload instance uses the multi-tenant plugin. Check the tenants collection in the Payload admin, or ask whoever manages the instance — it's whatever tenant your posts collection scopes content to.",
      },
    ],
    privacy:
      "Reads published posts (for internal linking) and creates draft posts (never publishes live) via the API key you generate, scoped to the user you create it for. To revoke, delete or regenerate the API key on that user in the Payload admin, or click Disconnect on this app's Integrations page.",
    docs: [
      { label: "Payload: API Keys", url: "https://payloadcms.com/docs/authentication/api-keys" },
      { label: "Payload: multi-tenant plugin", url: "https://payloadcms.com/docs/plugins/multi-tenant" },
    ],
  },

  STORYBLOK: {
    provider: "STORYBLOK",
    summary:
      "Connects your Storyblok space so On-site Publisher can create draft stories in it, ready for you to review and publish from Storyblok.",
    timeMinutes: 6,
    youWillNeed: [
      "A Storyblok account with access to the space",
      "A \"blog_post\" component in that space with title, body, meta_title, and meta_description fields — or someone who can create one",
    ],
    steps: [
      {
        title: "Find your Space ID",
        body: "In the Storyblok app, open the space and check its **Settings → General** page — the Space ID is shown there as a number (e.g. 287881).",
      },
      {
        title: "Check or create the blog_post component",
        body: "On-site Publisher creates stories under a component literally named `blog_post`, with fields for title, body, meta_title, and meta_description. Open the space's **Block Library** (component schema) and confirm one exists with that exact name and those fields — if it doesn't, create it before connecting, or publishing will fail once you try to use it.",
      },
      {
        title: "Create a personal access token",
        body: "In Storyblok, open your account menu and look for **Personal access tokens** (sometimes under My Account settings — the exact label can vary by Storyblok version). Create a new token and make sure it has access to the space from the first step. Copy the token — you may not be able to view it again after leaving the screen.",
      },
      {
        title: "Note your region",
        body: "Storyblok hosts spaces regionally. Check your space's URL in the Storyblok app for a region hint (eu, us, ca, ap, or cn) — if you're not sure, leave this blank on the connect form and it defaults to eu, which is correct for most spaces created without explicitly picking a different region.",
      },
      {
        title: "Fill in the connect form and submit",
        body: "Enter the Space ID, the personal access token, and the region (or leave it blank) on this app's Storyblok connect page, then click **Connect**.",
      },
    ],
    verify: [
      "Integrations page shows Storyblok as Connected",
      "Run On-site Publisher with Storyblok as the CMS Target, then check the space's Content section in Storyblok for the new draft story",
    ],
    troubleshooting: [
      {
        symptom: "Connection fails with an authentication or permission error",
        fix: "Confirm the token has access to the exact space whose ID you entered — a personal access token in Storyblok is scoped per space, so a token from a different space (or your personal account with no access to this one) will fail.",
      },
      {
        symptom: "Publishing fails even though the connection itself succeeded",
        fix: "The space is almost certainly missing the `blog_post` component, or it's missing one of the expected fields (title, body, meta_title, meta_description). Create or fix that component in Storyblok's Block Library.",
      },
      {
        symptom: "\"region\" related errors, or nothing seems to reach the space",
        fix: "Your space may be hosted outside the EU region. Check the space's URL in Storyblok's app for the region code and set it explicitly on the connect form rather than leaving it blank.",
      },
    ],
    privacy:
      "Creates draft stories in the space your token can access — it doesn't publish them live. Revoke the token from Storyblok's **Personal access tokens** settings, or click Disconnect on this app's Integrations page.",
    docs: [
      { label: "Storyblok documentation", url: "https://www.storyblok.com/docs" },
      { label: "Storyblok Management API", url: "https://www.storyblok.com/docs/api/management" },
    ],
  },

  WEBFLOW: {
    provider: "WEBFLOW",
    summary:
      "Connects a Webflow site's CMS collection so On-site Publisher can create draft items in it, ready to review and publish from Webflow.",
    timeMinutes: 6,
    youWillNeed: [
      "Access to the Webflow site's settings, and permission to generate an API token for it",
      "The CMS collection agents should publish into, with a rich-text field named exactly \"post-body\"",
    ],
    steps: [
      {
        title: "Find your Site ID",
        body: "In Webflow, open **Site settings → General**, and look for the Site ID shown there.",
      },
      {
        title: "Set up or confirm the CMS collection",
        body: "On-site Publisher creates items with a Name, a Slug, and a rich-text field named exactly `post-body`. Open the CMS collection you want to publish into and confirm it has a field with that exact name and type — create it if it doesn't exist, or publishing will fail once you try to use it.",
      },
      {
        title: "Find the Collection ID",
        body: "In the CMS panel, open that collection's settings to find its Collection ID.",
      },
      {
        title: "Generate an API token",
        body: "In Site settings, look for **Apps & integrations → API access** (the exact location can move between Webflow versions — search Site settings for \"API\" if it's not there). Generate a site API token with `sites:read` and `cms:write` scopes — both are required, one to identify the site and the other to create CMS items. Copy the token once it's shown.",
      },
      {
        title: "Fill in the connect form and submit",
        body: "Enter the Site ID, Collection ID, and API token on this app's Webflow connect page, then click **Connect**.",
      },
    ],
    verify: [
      "Integrations page shows Webflow as Connected",
      "Run On-site Publisher with Webflow as the CMS Target, then check the CMS collection in Webflow's Designer or CMS panel for the new draft item",
    ],
    troubleshooting: [
      {
        symptom: "Connection fails with an authentication error",
        fix: "Confirm the token has both `sites:read` and `cms:write` scopes, and that it wasn't generated for a different site than the Site ID you entered.",
      },
      {
        symptom: "Publishing fails even though the connection succeeded",
        fix: "The collection is almost certainly missing the `post-body` rich-text field, or it's named or typed differently. Add a field with exactly that name and rich-text type to the collection.",
      },
      {
        symptom: "Wrong collection gets the drafts",
        fix: "Double-check the Collection ID — a site can have several CMS collections, and this connection only ever publishes into the one whose ID you entered.",
      },
    ],
    privacy:
      "Reads basic site info and creates draft CMS items in the one collection you configure — it doesn't publish the Webflow site or touch other collections. Revoke the token from Webflow's Apps & integrations → API access settings, or click Disconnect on this app's Integrations page.",
    docs: [
      { label: "Webflow Data API reference", url: "https://developers.webflow.com/data/reference" },
      { label: "Webflow API scopes", url: "https://developers.webflow.com/data/reference/scopes" },
    ],
  },

  ANTHROPIC: {
    provider: "ANTHROPIC",
    summary:
      "Connects your own Claude API key. Every agent run in this workspace is billed to it, under your own account and rate limits — without one, no agent can run at all.",
    timeMinutes: 8,
    youWillNeed: [
      "Ability to create an account at console.anthropic.com and add a payment method",
      "A few minutes for a fresh account's first credit purchase/authorization to register before the key works",
    ],
    steps: [
      {
        title: "Create a Console account",
        body: "Go to **console.anthropic.com** and sign up (or sign in, if your organization already has an account). This is a separate account from claude.ai — it's specifically for API access and billing.",
      },
      {
        title: "Add billing before generating a key",
        body: "A brand-new Console account has no balance, and API calls will fail exactly like an invalid key would until billing is set up — it isn't obvious from the error alone which problem you have. In the Console, find **Billing** (or **Plans**) and add a payment method / purchase credits before moving on.",
      },
      {
        title: "Choose the right workspace",
        body: "If your organization's Console account has multiple workspaces, make sure you're creating the key inside the workspace intended for this connection — keys and spend limits are scoped per workspace, not account-wide.",
      },
      {
        title: "Create an API key",
        body: "In the Console, go to **Settings → API Keys**, and create a new key. Give it a name that identifies this workspace/connection so it's recognizable later. Copy it immediately — the full key is only shown once.",
      },
      {
        title: "Set a spend limit",
        body: "Still in the Console, look for spend/usage limits (under Billing or the workspace's Limits settings) and set a cap appropriate for this workspace, so agent usage here can't run past what you expect.",
      },
      {
        title: "Fill in the connect form and submit",
        body: "Paste the key into this app's Anthropic connect page and click **Connect**.",
      },
    ],
    verify: [
      "Integrations page shows Anthropic as Connected",
      "Run any agent — a successful run (rather than an authentication or billing error) confirms the key and billing are both working",
    ],
    troubleshooting: [
      {
        symptom: "The key fails immediately, right after creating it",
        fix: "This is almost always billing, not the key itself — a fresh Console account with no credits/payment method fails the same way a bad key would. Check Billing in the Console and add a payment method or credits, then try again.",
      },
      {
        symptom: "It worked, then started failing later",
        fix: "Check the spend limit you set in the Console — a run that hits it will fail until the limit is raised or the next billing period starts. Also confirm the key wasn't deleted or rotated in the Console.",
      },
      {
        symptom: "Not sure which workspace's key to use",
        fix: "Ask whoever administers your organization's Console account which workspace this connection should draw from — keys and spend limits are per Console workspace, so using the wrong one can mean unexpected billing or a key that quietly doesn't work for this app.",
      },
      {
        symptom: "\"Connect\" rejects the key as invalid before any run happens",
        fix: "Double check you copied the entire key with no leading/trailing spaces — Console only shows it once, and a partial paste is a common cause here.",
      },
    ],
    privacy:
      "The key is used only to call the Claude API on this workspace's behalf when an agent runs — it isn't used for anything else. Revoke or rotate it anytime from **console.anthropic.com → Settings → API Keys**, or click Disconnect on this app's Integrations page (note: Disconnect only removes it here — revoke it in the Console too if you want the key itself dead).",
    docs: [
      { label: "Anthropic Console", url: "https://console.anthropic.com" },
      { label: "API keys", url: "https://platform.claude.com/settings/keys" },
      { label: "Get started with Claude", url: "https://platform.claude.com/docs/en/get-started" },
    ],
  },
};
